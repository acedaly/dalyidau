// Calendar notifications: event reminders, upcoming leave, upcoming school holidays and failing
// subscriptions. Run by the existing cron trigger (every 15 minutes).
//
// Generation is idempotent: every notification has a unique key (person, kind, record, occurrence),
// so overlapping runs never create the same one twice, and an occurrence is reminded at most once
// per reminder. Each notification shows in the portal (Calendar's notifications list). It is also
// emailed only when the portal's "Calendar reminder emails" switch is on, an email provider is
// configured and the person turned on email in Calendar → Settings. Emails never include a private
// or sensitive event's title, and include other titles only when the person asked for them;
// otherwise they say "An event in your calendar" and when, with a link that needs the portal sign-in.
//
// Before anything is created or sent, access is checked as it is now: the person must still be a
// member of the event's calendar and able to open Calendar.
import type { D1Database } from "@cloudflare/workers-types";
import { NSW_SCHOOL_PERIODS, appliesTo } from "../../src/shared/calendar/nsw";
import { addDays, dayLabel, localDate, timeLabel, wallClock, zonedInstant } from "../../src/shared/calendar/time";
import type { CalendarNotification } from "../../src/shared/calendar/types";
import { type EmailProvider, ProviderError, emailProvider, htmlForText } from "../comms/providers";
import type { Env } from "../env";
import { newId, nowIso } from "../portal/db";
import { isEnabled } from "../portal/flags";
import { HttpError } from "../portal/http";
import { canUseCalendar, preferences } from "./access";
import { EVENT_COLUMNS, type EventRow } from "./events";
import { type OverrideRow, expand } from "./expand";

const LOOKAHEAD_MINUTES = 20;
/** A reminder this late (the cron didn't run, the Worker was down) is not shown as new. */
const STALE_MINUTES = 6 * 60;
const MAX_EMAIL_ATTEMPTS = 4;

export async function listNotifications(db: D1Database, email: string, limit = 30): Promise<CalendarNotification[]> {
    const rows = await db
        .prepare(
            "SELECT id, kind, title, detail, url, fire_at FROM calendar_notifications WHERE email = ? AND dismissed_at IS NULL AND fire_at <= ? ORDER BY fire_at DESC LIMIT ?",
        )
        .bind(email, nowIso(), limit)
        .all<{ id: string; kind: CalendarNotification["kind"]; title: string; detail: string | null; url: string | null; fire_at: string }>();
    return rows.results.map((r) => ({ id: r.id, kind: r.kind, title: r.title, detail: r.detail, url: r.url, fireAt: r.fire_at }));
}

export async function dismissNotification(db: D1Database, email: string, id: string | "all") {
    const result =
        id === "all"
            ? await db
                  .prepare("UPDATE calendar_notifications SET dismissed_at = ? WHERE email = ? AND dismissed_at IS NULL AND fire_at <= ?")
                  .bind(nowIso(), email, nowIso())
                  .run()
            : await db
                  .prepare("UPDATE calendar_notifications SET dismissed_at = ? WHERE id = ? AND email = ? AND dismissed_at IS NULL")
                  .bind(nowIso(), id, email)
                  .run();
    if (id !== "all" && !result.meta.changes) throw new HttpError(404, "not_found", "Not found");
}

const insertNotification = (
    db: D1Database,
    n: {
        email: string;
        kind: CalendarNotification["kind"];
        refId: string;
        key: string;
        fireAt: string;
        title: string;
        detail: string | null;
        url: string | null;
        emailWanted: boolean;
    },
) =>
    db
        .prepare(
            `INSERT INTO calendar_notifications (id, email, kind, ref_id, occurrence_key, fire_at, title, detail, url, email_status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        )
        .bind(
            newId("cnt"),
            n.email,
            n.kind,
            n.refId,
            n.key,
            n.fireAt,
            n.title.slice(0, 300),
            n.detail?.slice(0, 300) ?? null,
            n.url,
            n.emailWanted ? "pending" : "skipped",
            nowIso(),
        );

/** Creates the event reminders falling due in the next few minutes. */
async function generateEventReminders(env: Env, now: Date) {
    const db = env.DB;
    const horizonEnd = new Date(now.getTime() + LOOKAHEAD_MINUTES * 60_000);
    const earliest = new Date(now.getTime() - STALE_MINUTES * 60_000);
    // Events with any reminder whose occurrences could fall within the longest lead (four weeks).
    const reminders = await db
        .prepare(
            `SELECT r.email, r.minutes_before, ${EVENT_COLUMNS}, m.role FROM calendar_reminders r JOIN calendar_events e ON e.id = r.event_id
             JOIN calendar_members m ON m.calendar_id = e.calendar_id AND m.email = r.email
             WHERE e.status <> 'cancelled' AND e.start_at < ? AND e.series_end_at > ? AND m.role <> 'freebusy' LIMIT 500`,
        )
        .bind(new Date(horizonEnd.getTime() + 40320 * 60_000).toISOString(), earliest.toISOString())
        .all<EventRow & { email: string; minutes_before: number; role: string }>();
    const allowed = new Map<string, boolean>();
    const prefsCache = new Map<string, Awaited<ReturnType<typeof preferences>>>();
    const statements = [];
    for (const r of reminders.results) {
        if (!allowed.has(r.email)) allowed.set(r.email, await canUseCalendar(env, db, r.email));
        if (!allowed.get(r.email)) continue;
        if (r.visibility !== "default" && r.created_by !== r.email) continue;
        const lead = r.minutes_before * 60_000;
        const window = { start: new Date(earliest.getTime() + lead).toISOString(), end: new Date(horizonEnd.getTime() + lead).toISOString() };
        const overrides = await db
            .prepare("SELECT event_id, occurrence_key, cancelled, fields, start_at, end_at FROM calendar_event_overrides WHERE event_id = ?")
            .bind(r.id)
            .all<OverrideRow>();
        const prefs = prefsCache.get(r.email) ?? (await preferences(db, r.email));
        prefsCache.set(r.email, prefs);
        for (const occ of expand(r, overrides.results, window, 20).occurrences) {
            const fireAt = new Date(Date.parse(occ.startAt) - lead);
            if (fireAt > horizonEnd || fireAt < earliest) continue;
            const wall = wallClock(occ.startAt, prefs.timeZone);
            const when = occ.allDay ? dayLabel(occ.startDate) : `${dayLabel(wall.date)}, ${timeLabel(wall.time)}`;
            const hidden = r.visibility !== "default";
            statements.push(
                insertNotification(db, {
                    email: r.email,
                    kind: "event",
                    refId: r.id,
                    key: `${occ.key}:${r.minutes_before}`,
                    fireAt: fireAt.toISOString(),
                    title: hidden ? "Private event" : (occ.fields?.title ?? r.title),
                    detail: when,
                    url: `/portal/calendar?date=${occ.startDate}&event=${r.id}`,
                    emailWanted: prefs.reminderEmail,
                }),
            );
        }
    }
    for (let i = 0; i < statements.length; i += 50) await db.batch(statements.slice(i, i + 50));
    return statements.length;
}

/** Leave starting in a week, and school holidays starting in a fortnight, once each per person. */
async function generatePlanningNotices(env: Env, now: Date) {
    const db = env.DB;
    const statements = [];
    const people = await db.prepare("SELECT email FROM calendar_preferences UNION SELECT email FROM leave_profiles").all<{ email: string }>();
    for (const { email } of people.results) {
        if (!(await canUseCalendar(env, db, email))) continue;
        const prefs = await preferences(db, email);
        const today = localDate(now, prefs.timeZone);
        // At 8 am on the day, in the person's own zone.
        const morning = (date: string) => zonedInstant(date, "08:00", prefs.timeZone);
        if (prefs.notify.leave) {
            const soon = await db
                .prepare(
                    `SELECT b.id, b.start_date, b.end_date, t.name FROM leave_bookings b JOIN leave_types t ON t.id = b.leave_type_id
                     WHERE b.email = ? AND b.scenario_id IS NULL AND b.status IN ('requested', 'approved') AND b.start_date BETWEEN ? AND ?`,
                )
                .bind(email, today, addDays(today, 7))
                .all<{ id: string; start_date: string; end_date: string; name: string }>();
            for (const b of soon.results) {
                const fireAt = morning(addDays(b.start_date, -7) < today ? today : addDays(b.start_date, -7));
                if (fireAt > now.toISOString()) continue;
                statements.push(
                    insertNotification(db, {
                        email,
                        kind: "leave",
                        refId: b.id,
                        key: b.start_date,
                        fireAt,
                        title: `${b.name} starts ${dayLabel(b.start_date)}`,
                        detail: b.start_date === b.end_date ? null : `Until ${dayLabel(b.end_date)}`,
                        url: "/portal/calendar/leave",
                        emailWanted: prefs.reminderEmail,
                    }),
                );
            }
        }
        if (prefs.notify.school && prefs.schoolDivision !== "none") {
            const division = prefs.schoolDivision;
            for (const period of NSW_SCHOOL_PERIODS) {
                if (period.kind !== "holidays" || !appliesTo(period, division)) continue;
                if (period.start < today || period.start > addDays(today, 14)) continue;
                const fireAt = morning(addDays(period.start, -14) < today ? today : addDays(period.start, -14));
                if (fireAt > now.toISOString()) continue;
                statements.push(
                    insertNotification(db, {
                        email,
                        kind: "school",
                        refId: period.id,
                        key: period.start,
                        fireAt,
                        title: `${period.name} start ${dayLabel(period.start)}`,
                        detail: `Until ${dayLabel(period.end)}${period.provisional ? " (provisional dates)" : ""}`,
                        url: `/portal/calendar/leave/planner?school=${period.id}`,
                        emailWanted: prefs.reminderEmail,
                    }),
                );
            }
        }
    }
    for (let i = 0; i < statements.length; i += 50) await db.batch(statements.slice(i, i + 50));
    return statements.length;
}

/** The email for one notification. Never more than what's already in its in-app title. */
function notificationEmail(n: { kind: string; title: string; detail: string | null; url: string | null }, includeTitle: boolean, site: string) {
    const link = `${site.replace(/\/+$/, "")}${n.url ?? "/portal/calendar"}`;
    const headline =
        n.kind === "event" ? (includeTitle && n.title !== "Private event" ? `Reminder: ${n.title}` : "Reminder: an event in your calendar") : n.title;
    const text = [
        headline,
        n.detail ?? "",
        `Open Daly Calendar (you'll be asked to sign in):\n${link}`,
        "You're receiving this because you turned on email notifications in Daly Calendar. To stop them, turn them off in Calendar → Settings.",
    ]
        .filter(Boolean)
        .join("\n\n");
    return { subject: headline.slice(0, 200), text, html: htmlForText(text) };
}

async function deliverEmails(env: Env, provider: EmailProvider, now: Date, limit: number) {
    const db = env.DB;
    const due = await db
        .prepare(
            "SELECT id, email, kind, title, detail, url, fire_at, email_attempts FROM calendar_notifications WHERE email_status = 'pending' AND fire_at <= ? ORDER BY fire_at LIMIT ?",
        )
        .bind(now.toISOString(), limit)
        .all<{ id: string; email: string; kind: string; title: string; detail: string | null; url: string | null; fire_at: string; email_attempts: number }>();
    let sent = 0;
    for (const n of due.results) {
        const claimed = await db
            .prepare("UPDATE calendar_notifications SET email_status = 'sending' WHERE id = ? AND email_status = 'pending'")
            .bind(n.id)
            .run();
        if (!claimed.meta.changes) continue;
        const finish = (status: "sent" | "skipped" | "failed" | "pending") =>
            db
                .prepare(
                    "UPDATE calendar_notifications SET email_status = ?, email_attempts = email_attempts + ?, emailed_at = CASE WHEN ? = 'sent' THEN ? ELSE emailed_at END WHERE id = ?",
                )
                .bind(status, status === "skipped" ? 0 : 1, status, nowIso(), n.id)
                .run();
        const prefs = await preferences(db, n.email);
        if (!prefs.reminderEmail || !(await canUseCalendar(env, db, n.email)) || Date.parse(n.fire_at) < now.getTime() - STALE_MINUTES * 60_000) {
            await finish("skipped");
            continue;
        }
        try {
            await provider.send({
                to: n.email,
                toName: "",
                ...notificationEmail(n, prefs.emailDetails, env.SITE_URL),
                reference: `calendar-notification:${n.id}`,
            });
            await finish("sent");
            sent++;
        } catch (error) {
            const retryable = !(error instanceof ProviderError) || error.retryable;
            console.error(JSON.stringify({ event: "calendar_notification_failed", notificationId: n.id, retryable }));
            await finish(retryable && n.email_attempts + 1 < MAX_EMAIL_ATTEMPTS ? "pending" : "failed");
        }
    }
    return sent;
}

/** The cron step. Safe to run from every cron invocation, and from two at once. */
export async function processCalendarNotifications(env: Env, options: { now?: Date; provider?: EmailProvider | null; emailLimit?: number } = {}) {
    const now = options.now ?? new Date();
    const reminders = await generateEventReminders(env, now);
    const notices = await generatePlanningNotices(env, now);
    let emailed = 0;
    const provider = options.provider !== undefined ? options.provider : emailProvider(env);
    if (provider && (await isEnabled(env.DB, "calendar.reminders.email"))) emailed = await deliverEmails(env, provider, now, options.emailLimit ?? 20);
    // Old notifications are kept a while for the list, then removed.
    await env.DB.prepare("DELETE FROM calendar_notifications WHERE fire_at < ?")
        .bind(new Date(now.getTime() - 60 * 86_400_000).toISOString())
        .run();
    if (reminders || notices || emailed) console.log(JSON.stringify({ event: "calendar_notifications", reminders, notices, emailed }));
    return { reminders, notices, emailed };
}
