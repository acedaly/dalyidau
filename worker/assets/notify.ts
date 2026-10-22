// Reminders and the Home & Assets cron step.
//
// For each person who can open Home & Assets, the cron works out what's due from the records they
// can see (their own, and, if they asked for household reminders, what's shared with them) and
// records one reminder per date and offset. The unique key on asset_notifications means a reminder
// is never made, shown or emailed twice, however often or concurrently the cron runs. Rows hold ids
// and dates only: what a reminder says is worked out when it's shown, from the record as that
// person may see it then, and one whose record no longer needs attention simply isn't shown.
//
// Email is off unless the owner switches on "Home & Assets reminder emails", an email provider is
// configured on the Worker, and the person turned email on for that kind of reminder. Emails say
// "You have a Home & Assets reminder" unless the person chose to include details.
//
// The same step purges assets deleted more than 30 days ago. Every part is bounded per run and contained: one failure never stops the rest.
import type { D1Database } from "@cloudflare/workers-types";
import { type AssetNotificationView, type AttentionItem, REMINDER_KINDS, type ReminderKind } from "../../src/shared/assets/types";
import { addDays } from "../../src/shared/calendar/time";
import type { PortalUser } from "../../src/shared/portal/types";
import { type EmailProvider, ProviderError, emailProvider, htmlForText } from "../comms/providers";
import type { Env } from "../env";
import { userForEmail } from "../portal/auth";
import { newId, nowIso } from "../portal/db";
import { isEnabled } from "../portal/flags";
import { HttpError } from "../portal/http";
import { assetPeople } from "./access";
import { type Snapshot, attention, snapshot } from "./dashboard";
import { purgeDeletedAssets } from "./files";

const REMINDER_OF: Record<AttentionItem["kind"], ReminderKind> = {
    maintenance: "maintenance",
    repair: "maintenance",
    registration: "registration",
    insurance: "insurance",
    warranty: "warranty",
    inspection: "inspection",
    lease: "lease",
    roadside: "roadside",
};

/** Reminders look up to a year ahead. */
const LOOKAHEAD_DAYS = 366;
/** On a first run (or after a pause) reminders older than this aren't back-filled. */
const BACKFILL_DAYS = 7;
const MAX_PEOPLE = 25;
const MAX_EMAIL_ATTEMPTS = 3;

const itemKey = (reminder: string, refId: string, dueOn: string) => `${reminder}:${refId}:${dueOn}`;

/** Whether this item is the person's to be reminded about: their own, or shared and they asked. */
function concerns(s: Snapshot, item: AttentionItem): boolean {
    if (s.ctx.prefs.householdReminders) return true;
    if (item.assetId) return s.assets.find((a) => a.id === item.assetId)?.mine ?? false;
    if (item.kind === "insurance") return s.policies.find((p) => p.id === item.refId)?.mine ?? false;
    const location = s.locations.find((l) => l.id === item.refId || item.url.endsWith(l.id));
    return location?.mine ?? false;
}

/** The offsets (days before) for an item: its schedule's own, else the person's setting for that kind. */
function offsetsFor(s: Snapshot, item: AttentionItem): number[] {
    const reminder = REMINDER_OF[item.kind];
    const setting = s.ctx.prefs.reminders[reminder];
    const scheduleId = item.key.startsWith("schedule:") ? item.refId : s.open.find((m) => m.id === item.refId)?.scheduleId;
    const own = scheduleId ? s.schedules.find((sc) => sc.id === scheduleId)?.reminderDays : undefined;
    return [...new Set(own ?? setting.days)];
}

/** Records due reminders for one person. Returns how many new ones. */
export async function generateFor(db: D1Database, s: Snapshot, emailAllowed: boolean): Promise<number> {
    const { today, prefs } = s.ctx;
    const email = s.ctx.user.email;
    const statements = [];
    for (const item of attention(s, LOOKAHEAD_DAYS)) {
        if (!item.date || !concerns(s, item)) continue;
        const reminder = REMINDER_OF[item.kind];
        const setting = prefs.reminders[reminder];
        if (!setting.inApp && !setting.email) continue;
        // Before the date, at each chosen offset; and once the day after, if it's still outstanding.
        const offsets = [...offsetsFor(s, item), ...(item.date < today ? [-1] : [])];
        for (const offset of offsets) {
            const fireOn = addDays(item.date, -offset);
            if (fireOn > today || fireOn < addDays(today, -BACKFILL_DAYS)) continue;
            statements.push(
                db
                    .prepare(
                        `INSERT INTO asset_notifications (id, email, reminder, ref_id, due_on, offset_days, fire_on, created_at, dismissed_at, email_status)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
                    )
                    .bind(
                        newId("anf"),
                        email,
                        reminder,
                        item.refId,
                        item.date,
                        offset,
                        fireOn,
                        nowIso(),
                        // Email-only reminders are kept (for the ledger) but not shown in the portal.
                        setting.inApp ? null : nowIso(),
                        emailAllowed && setting.email ? "pending" : "none",
                    ),
            );
        }
    }
    if (!statements.length) return 0;
    let created = 0;
    for (let i = 0; i < statements.length; i += 50) for (const r of await db.batch(statements.slice(i, i + 50))) created += r.meta.changes ?? 0;
    return created;
}

/** The person's reminders that are due and not dismissed, as they read now. */
export async function listNotifications(_env: Env, db: D1Database, user: PortalUser, given?: Snapshot): Promise<AssetNotificationView[]> {
    const s = given ?? (await snapshot(db, user));
    const rows = await db
        .prepare(
            "SELECT id, reminder, ref_id, due_on, fire_on FROM asset_notifications WHERE email = ? AND dismissed_at IS NULL AND fire_on <= ? AND due_on >= ? ORDER BY fire_on DESC LIMIT 100",
        )
        .bind(user.email, s.ctx.today, addDays(s.ctx.today, -90))
        .all<{ id: string; reminder: ReminderKind; ref_id: string; due_on: string; fire_on: string }>();
    const items = new Map(attention(s, LOOKAHEAD_DAYS).map((i) => [itemKey(REMINDER_OF[i.kind], i.refId, i.date ?? ""), i]));
    const seen = new Set<string>();
    const out: AssetNotificationView[] = [];
    for (const r of rows.results) {
        const item = items.get(itemKey(r.reminder, r.ref_id, r.due_on));
        const key = itemKey(r.reminder, r.ref_id, r.due_on);
        // Gone (completed, renewed, no longer visible) or already listed under another offset.
        if (!item || seen.has(key)) continue;
        seen.add(key);
        out.push({
            id: r.id,
            reminder: r.reminder,
            dueOn: r.due_on,
            fireOn: r.fire_on,
            sentence: item.sentence,
            url: item.url,
        });
    }
    return out;
}

export async function dismissNotification(db: D1Database, user: PortalUser, id: string) {
    const result = await db
        .prepare(
            id === "all"
                ? "UPDATE asset_notifications SET dismissed_at = ? WHERE email = ? AND dismissed_at IS NULL"
                : "UPDATE asset_notifications SET dismissed_at = ? WHERE email = ? AND id = ? AND dismissed_at IS NULL",
        )
        .bind(nowIso(), user.email, ...(id === "all" ? [] : [id]))
        .run();
    if (id !== "all" && !result.meta.changes) throw new HttpError(404, "not_found", "Not found");
}

// --- Email ---------------------------------------------------------------------------------------

function reminderEmail(sentence: string | null, url: string, site: string) {
    const link = `${site.replace(/\/+$/, "")}${url}`;
    const headline = sentence ?? "You have a Home & Assets reminder";
    const text = [
        headline,
        `Open Home & Assets (you'll be asked to sign in):\n${link}`,
        "You're receiving this because you turned on email reminders in Home & Assets → Settings. To stop them, turn them off there.",
    ].join("\n\n");
    return { subject: headline.slice(0, 200), text, html: htmlForText(text) };
}

async function deliverFor(env: Env, provider: EmailProvider, s: Snapshot, limit: number): Promise<number> {
    const db = env.DB;
    const email = s.ctx.user.email;
    const due = await db
        .prepare(
            "SELECT id, reminder, ref_id, due_on, email_attempts FROM asset_notifications WHERE email = ? AND email_status = 'pending' AND fire_on <= ? ORDER BY fire_on LIMIT ?",
        )
        .bind(email, s.ctx.today, limit)
        .all<{ id: string; reminder: ReminderKind; ref_id: string; due_on: string; email_attempts: number }>();
    if (!due.results.length) return 0;
    const items = new Map(attention(s, LOOKAHEAD_DAYS).map((i) => [itemKey(REMINDER_OF[i.kind], i.refId, i.date ?? ""), i]));
    let sent = 0;
    for (const n of due.results) {
        const claimed = await db.prepare("UPDATE asset_notifications SET email_status = 'sending' WHERE id = ? AND email_status = 'pending'").bind(n.id).run();
        if (!claimed.meta.changes) continue;
        const finish = (status: "sent" | "skipped" | "failed" | "pending") =>
            db
                .prepare(
                    "UPDATE asset_notifications SET email_status = ?, email_attempts = email_attempts + ?, emailed_at = CASE WHEN ? = 'sent' THEN ? ELSE emailed_at END WHERE id = ?",
                )
                .bind(status, status === "skipped" ? 0 : 1, status, nowIso(), n.id)
                .run();
        const item = items.get(itemKey(n.reminder, n.ref_id, n.due_on));
        if (!item || !s.ctx.prefs.reminders[n.reminder].email) {
            await finish("skipped");
            continue;
        }
        try {
            await provider.send({
                to: email,
                toName: "",
                ...reminderEmail(s.ctx.prefs.emailDetails ? item.sentence : null, item.url, env.SITE_URL),
                reference: `asset-reminder:${n.id}`,
            });
            await finish("sent");
            sent++;
        } catch (error) {
            const retryable = !(error instanceof ProviderError) || error.retryable;
            console.error(JSON.stringify({ event: "asset_reminder_email_failed", notificationId: n.id, retryable }));
            await finish(retryable && n.email_attempts + 1 < MAX_EMAIL_ATTEMPTS ? "pending" : "failed");
        }
    }
    return sent;
}

// --- The cron step -------------------------------------------------------------------------------

export async function processAssetReminders(env: Env, options: { provider?: EmailProvider | null; scheduledTime?: number } = {}) {
    // Dates move a day at a time: once an hour (the first quarter-hour run) is plenty.
    if (options.scheduledTime !== undefined && new Date(options.scheduledTime).getUTCMinutes() >= 15) return null;
    const db = env.DB;
    const emailOn = await isEnabled(db, "assets.reminders.email");
    const provider = options.provider !== undefined ? options.provider : emailProvider(env);
    let created = 0;
    let emailed = 0;
    let today = new Date().toISOString().slice(0, 10);
    for (const person of (await assetPeople(env, db)).slice(0, MAX_PEOPLE)) {
        try {
            const auth = await userForEmail(env, person.email);
            if (!auth.ok || !auth.user.permissions.includes("assets.use")) continue;
            const s = await snapshot(db, auth.user);
            today = s.ctx.today;
            created += await generateFor(db, s, emailOn && !!provider);
            if (emailOn && provider) emailed += await deliverFor(env, provider, s, 10);
        } catch (error) {
            console.error(JSON.stringify({ event: "asset_reminders_error", message: (error as Error).message }));
        }
    }
    const purged = await purgeDeletedAssets(db, env.MEDIA).catch((error) => {
        console.error(JSON.stringify({ event: "asset_purge_error", message: (error as Error).message }));
        return { files: 0, assets: 0 };
    });
    await db.prepare("DELETE FROM asset_notifications WHERE fire_on < ?").bind(addDays(today, -180)).run();
    if (created || emailed || purged.files || purged.assets)
        console.log(JSON.stringify({ event: "asset_reminders", created, emailed, purgedFiles: purged.files, purgedAssets: purged.assets }));
    return { created, emailed, purged };
}

export const REMINDER_KEYS = REMINDER_KINDS;
