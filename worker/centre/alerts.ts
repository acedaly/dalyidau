// Alerts (docs/INTELLIGENCE_CENTRE.md#notifications): deterministic, from detected changes that
// concern someone's own watch areas. In the portal always (Today and the Centre); by email only
// when the owner's switch is on, a provider is configured and the person opted in for that watch.
//
// Never a promise of delivery and never a substitute for official warnings: every email says so.
// Idempotent (one alert per person per change, by a unique key), rate-limited per person, quiet
// hours respected for email, and acknowledged in the portal.
import type { D1Database } from "@cloudflare/workers-types";
import { wallClock } from "../../src/shared/calendar/time";
import { sourceById } from "../../src/shared/centre/sources";
import type { CentreAlert, ChangeKind, WatchArea } from "../../src/shared/centre/types";
import type { PortalUser } from "../../src/shared/portal/types";
import { type EmailProvider, ProviderError, emailProvider, htmlForText } from "../comms/providers";
import type { Env } from "../env";
import { can, userForEmail } from "../portal/auth";
import { newId, nowIso, parseJson } from "../portal/db";
import { isEnabled } from "../portal/flags";
import { HttpError } from "../portal/http";
import type { Geometry } from "./geo";
import { RECORD_COLUMNS, type RecordRow, loadPreferences, toRecord } from "./store";
import { type MatchContext, matchContextFor, matchWatch, toWatch } from "./watch";

/** Changes worth an alert. "No longer in the feed" never is: it doesn't mean resolved. */
const ALERT_KINDS = new Set<ChangeKind>(["new", "escalated", "reappeared", "geometry_changed", "rating_changed", "ban_declared", "measurement_change"]);
const SOURCE_ALERT_KINDS = new Set<ChangeKind>(["source_failed", "source_stale"]);
/** Sources whose failure matters enough to tell people who watch areas. */
const CRITICAL_SOURCES = new Set(["rfs-incidents", "rfs-fire-danger", "bom-warnings", "rfs-incident-alerts"]);
export const MAX_ALERTS_PER_HOUR = 30;
const MAX_EMAIL_ATTEMPTS = 3;
const DISCLAIMER =
    "This is a private summary of public information, not an official warning service, and delivery isn't guaranteed. For official warnings use Hazards Near Me NSW, Fires Near Me, the Bureau of Meteorology and emergency broadcasters. In an emergency call Triple Zero (000).";

const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
export function inQuietHours(now: Date, timeZone: string, start: string | null, end: string | null): boolean {
    if (!start || !end) return false;
    const local = minutes(wallClock(now, timeZone).time);
    const [s, e] = [minutes(start), minutes(end)];
    return s <= e ? local >= s && local < e : local >= s || local < e;
}

interface ChangeWithRecord {
    id: string;
    record_id: string | null;
    source_id: string;
    kind: ChangeKind;
    summary: string;
    severity_rank: number;
}

/** Creates alerts for a set of changes (ids), for every person whose watch areas they concern. */
export async function alertsForChanges(env: Env, changeIds: string[], options: { now?: Date } = {}) {
    const db = env.DB;
    const now = options.now ?? new Date();
    if (!changeIds.length) return 0;
    const changes: ChangeWithRecord[] = [];
    for (let i = 0; i < changeIds.length; i += 90) {
        const part = changeIds.slice(i, i + 90);
        changes.push(
            ...(
                await db
                    .prepare(`SELECT id, record_id, source_id, kind, summary, severity_rank FROM ic_changes WHERE id IN (${part.map(() => "?").join(",")})`)
                    .bind(...part)
                    .all<ChangeWithRecord>()
            ).results,
        );
    }
    const relevant = changes.filter((c) => ALERT_KINDS.has(c.kind) || (SOURCE_ALERT_KINDS.has(c.kind) && CRITICAL_SOURCES.has(c.source_id)));
    if (!relevant.length) return 0;
    const watches = (
        await db
            .prepare("SELECT * FROM ic_watch_areas WHERE enabled = 1 AND (notify_in_app = 1 OR notify_email = 1) AND (expires_at IS NULL OR expires_at > ?)")
            .bind(now.toISOString())
            .all()
    ).results.map((r) => ({ email: String((r as { email: string }).email).toLowerCase(), watch: toWatch(r as unknown as Parameters<typeof toWatch>[0]) }));
    if (!watches.length) return 0;
    const recordIds = [...new Set(relevant.map((c) => c.record_id).filter((x): x is string => !!x))];
    const records = new Map<string, { record: ReturnType<typeof toRecord>; geometry: Geometry | null }>();
    for (let i = 0; i < recordIds.length; i += 90) {
        const part = recordIds.slice(i, i + 90);
        const rows = await db
            .prepare(`SELECT ${RECORD_COLUMNS}, geometry FROM ic_records WHERE id IN (${part.map(() => "?").join(",")})`)
            .bind(...part)
            .all<RecordRow & { geometry: string | null }>();
        for (const row of rows.results)
            records.set(row.id, { record: toRecord(row), geometry: row.geometry ? parseJson<Geometry | null>(row.geometry, null) : null });
    }
    const contexts = new Map<string, MatchContext>();
    const people = new Map<string, { allowed: boolean; emailAlerts: boolean }>();
    let created = 0;
    for (const change of relevant) {
        const notified = new Set<string>();
        for (const { email, watch } of watches) {
            if (notified.has(email)) continue;
            let reason: string | null;
            let url = "/portal/intelligence-centre/sources";
            let title = change.summary;
            if (!change.record_id) {
                reason = "A source your watch areas rely on";
            } else {
                const found = records.get(change.record_id);
                if (!found) continue;
                if (change.severity_rank < watch.minLevel) continue;
                // Road changes alert for closures and major hazards only.
                if (
                    found.record.category === "transport" &&
                    change.kind === "new" &&
                    found.record.attributes.closure !== "yes" &&
                    found.record.attributes.major !== "yes"
                )
                    continue;
                if (!contexts.has(watch.id)) contexts.set(watch.id, await matchContextFor(db, watch));
                reason = matchWatch(watch, found.record, found.geometry, contexts.get(watch.id));
                url = `/portal/intelligence-centre/records/${found.record.id}`;
                title = `${watch.name}: ${change.summary}`;
            }
            if (!reason) continue;
            if (!people.has(email)) {
                const auth = await userForEmail(env, email);
                const prefs = await loadPreferences(db, email);
                people.set(email, { allowed: auth.ok && can(auth.user, "centre.use"), emailAlerts: prefs.preferences.email.alerts });
            }
            const person = people.get(email)!;
            // Someone who lost access gets nothing.
            if (!person.allowed) continue;
            notified.add(email);
            if (await rateLimited(db, email, now)) continue;
            const result = await db
                .prepare(
                    `INSERT OR IGNORE INTO ic_alerts (id, email, watch_id, record_id, change_id, kind, title, detail, url, level_rank, created_at, email_status)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                )
                .bind(
                    newId("ica"),
                    email,
                    watch.id,
                    change.record_id,
                    change.id,
                    change.kind,
                    title.slice(0, 300),
                    reason.slice(0, 500),
                    url,
                    change.severity_rank,
                    nowIso(),
                    watch.notifyEmail && person.emailAlerts ? "pending" : null,
                )
                .run();
            created += result.meta.changes;
        }
    }
    return created;
}

/** Over the hourly limit: one summary alert takes the place of the rest. */
async function rateLimited(db: D1Database, email: string, now: Date): Promise<boolean> {
    const hour = now.toISOString().slice(0, 13);
    const count = await db
        .prepare("SELECT COUNT(*) AS n FROM ic_alerts WHERE email = ? AND created_at >= ?")
        .bind(email, `${hour}:00:00`)
        .first<{ n: number }>();
    if ((count?.n ?? 0) < MAX_ALERTS_PER_HOUR) return false;
    await db
        .prepare(
            `INSERT OR IGNORE INTO ic_alerts (id, email, change_id, kind, title, detail, url, level_rank, created_at)
             VALUES (?, ?, ?, 'digest', ?, ?, '/portal/intelligence-centre/history', 0, ?)`,
        )
        .bind(
            newId("ica"),
            email,
            `rate:${hour}`,
            "More changes in your watch areas",
            `Over ${MAX_ALERTS_PER_HOUR} alerts this hour; the rest are in History.`,
            nowIso(),
        )
        .run();
    return true;
}

// --- Reading and acknowledging -------------------------------------------------------------------

interface AlertRow {
    id: string;
    watch_id: string | null;
    watch_name: string | null;
    record_id: string | null;
    kind: CentreAlert["kind"];
    title: string;
    detail: string | null;
    url: string;
    level_rank: number;
    created_at: string;
    acknowledged_at: string | null;
    email_status: string | null;
}

const toAlert = (r: AlertRow): CentreAlert => ({
    id: r.id,
    watchId: r.watch_id,
    watchName: r.watch_name,
    recordId: r.record_id,
    kind: r.kind,
    title: r.title,
    detail: r.detail,
    url: r.url,
    levelRank: r.level_rank,
    createdAt: r.created_at,
    acknowledgedAt: r.acknowledged_at,
    emailStatus: r.email_status,
});

export async function listAlerts(db: D1Database, email: string, options: { unacknowledged?: boolean; limit?: number } = {}): Promise<CentreAlert[]> {
    const rows = await db
        .prepare(
            `SELECT a.id, a.watch_id, w.name AS watch_name, a.record_id, a.kind, a.title, a.detail, a.url, a.level_rank, a.created_at, a.acknowledged_at, a.email_status
             FROM ic_alerts a LEFT JOIN ic_watch_areas w ON w.id = a.watch_id AND w.email = a.email
             WHERE a.email = ? ${options.unacknowledged ? "AND a.acknowledged_at IS NULL" : ""} ORDER BY a.created_at DESC LIMIT ?`,
        )
        .bind(email, options.limit ?? 50)
        .all<AlertRow>();
    return rows.results.map(toAlert);
}

export const unacknowledgedCount = async (db: D1Database, email: string) =>
    (await db.prepare("SELECT COUNT(*) AS n FROM ic_alerts WHERE email = ? AND acknowledged_at IS NULL").bind(email).first<{ n: number }>())?.n ?? 0;

export async function acknowledgeAlerts(db: D1Database, user: PortalUser, ids: string[] | "all") {
    const now = nowIso();
    if (ids === "all") {
        await db.prepare("UPDATE ic_alerts SET acknowledged_at = ? WHERE email = ? AND acknowledged_at IS NULL").bind(now, user.email).run();
        return;
    }
    if (!ids.length || ids.length > 200 || ids.some((id) => !/^ica_[a-z0-9]{14}$/.test(id))) throw new HttpError(422, "validation", "Choose up to 200 alerts");
    await db
        .prepare(`UPDATE ic_alerts SET acknowledged_at = ? WHERE email = ? AND acknowledged_at IS NULL AND id IN (${ids.map(() => "?").join(",")})`)
        .bind(now, user.email, ...ids)
        .run();
}

// --- Email (opt-in, behind the owner's switch) ----------------------------------------------------

function alertEmail(alert: { title: string; detail: string | null; url: string }, site: string) {
    const text = [
        alert.title,
        alert.detail ? `Why you're seeing this: ${alert.detail}` : "",
        `Open the Intelligence Centre (you'll be asked to sign in):\n${site.replace(/\/+$/, "")}${alert.url}`,
        DISCLAIMER,
        "You receive this because you turned on email alerts for this watch area. Turn them off in Intelligence Centre → Watch areas.",
    ]
        .filter(Boolean)
        .join("\n\n");
    return { subject: `Intelligence Centre: ${alert.title}`.slice(0, 200), text, html: htmlForText(text) };
}

async function sendDigests(env: Env, provider: EmailProvider, now: Date) {
    const rows = await env.DB.prepare("SELECT email, value FROM ic_preferences").all<{ email: string; value: string }>();
    for (const row of rows.results) {
        const prefs = parseJson<{ email?: { digest?: boolean; digestHour?: number }; timeZone?: string }>(row.value, {});
        if (!prefs.email?.digest) continue;
        const zone = prefs.timeZone || "Australia/Sydney";
        const local = wallClock(now, zone);
        if (Number(local.time.slice(0, 2)) !== (prefs.email.digestHour ?? 7)) continue;
        const key = `digest:${local.date}`;
        const auth = await userForEmail(env, row.email);
        if (!auth.ok || !can(auth.user, "centre.use")) continue;
        const recent = await listAlerts(env.DB, row.email, { limit: 15 });
        const day = recent.filter((a) => a.kind !== "digest" && Date.parse(a.createdAt) > now.getTime() - 86_400_000);
        const inserted = await env.DB.prepare(
            "INSERT OR IGNORE INTO ic_alerts (id, email, change_id, kind, title, detail, url, level_rank, created_at, acknowledged_at, email_status) VALUES (?, ?, ?, 'digest', ?, ?, '/portal/intelligence-centre', 0, ?, ?, 'sending')",
        )
            .bind(
                newId("ica"),
                row.email,
                key,
                `Daily summary: ${day.length} ${day.length === 1 ? "alert" : "alerts"} in the last 24 hours`,
                null,
                nowIso(),
                nowIso(),
            )
            .run();
        if (!inserted.meta.changes) continue;
        const text = [
            `Daily summary for ${local.date}: ${day.length} ${day.length === 1 ? "alert" : "alerts"} in your watch areas in the last 24 hours.`,
            ...day.map((a) => `• ${a.title}`),
            `Open the Intelligence Centre:\n${env.SITE_URL.replace(/\/+$/, "")}/portal/intelligence-centre`,
            DISCLAIMER,
        ].join("\n\n");
        try {
            await provider.send({
                to: row.email,
                toName: "",
                subject: "Intelligence Centre daily summary",
                text,
                html: htmlForText(text),
                reference: `centre-digest:${key}`,
            });
            await env.DB.prepare("UPDATE ic_alerts SET email_status = 'sent', emailed_at = ? WHERE email = ? AND change_id = ?")
                .bind(nowIso(), row.email, key)
                .run();
        } catch {
            await env.DB.prepare("UPDATE ic_alerts SET email_status = 'failed' WHERE email = ? AND change_id = ?").bind(row.email, key).run();
        }
    }
}

export async function deliverAlertEmails(env: Env, options: { now?: Date; provider?: EmailProvider | null; limit?: number } = {}) {
    const now = options.now ?? new Date();
    if (!(await isEnabled(env.DB, "intelligence_centre.alerts.email"))) return 0;
    const provider = options.provider !== undefined ? options.provider : emailProvider(env);
    if (!provider) return 0;
    const due = await env.DB.prepare(
        `SELECT a.id, a.email, a.title, a.detail, a.url, a.email_attempts, a.created_at, w.quiet_start, w.quiet_end, w.notify_email
         FROM ic_alerts a LEFT JOIN ic_watch_areas w ON w.id = a.watch_id WHERE a.email_status = 'pending' ORDER BY a.created_at LIMIT ?`,
    )
        .bind(options.limit ?? 20)
        .all<{
            id: string;
            email: string;
            title: string;
            detail: string | null;
            url: string;
            email_attempts: number;
            created_at: string;
            quiet_start: string | null;
            quiet_end: string | null;
            notify_email: number | null;
        }>();
    let sent = 0;
    for (const a of due.results) {
        const prefs = (await loadPreferences(env.DB, a.email)).preferences;
        const quiet = inQuietHours(now, prefs.timeZone, a.quiet_start ?? prefs.quietHours?.start ?? null, a.quiet_end ?? prefs.quietHours?.end ?? null);
        const old = now.getTime() - Date.parse(a.created_at) > 12 * 3_600_000;
        // Quiet hours hold an email until they end; one that's waited over 12 hours is no longer useful.
        if (quiet && !old) continue;
        const claimed = await env.DB.prepare("UPDATE ic_alerts SET email_status = 'sending' WHERE id = ? AND email_status = 'pending'").bind(a.id).run();
        if (!claimed.meta.changes) continue;
        const finish = (status: string) =>
            env.DB.prepare(
                "UPDATE ic_alerts SET email_status = ?, email_attempts = email_attempts + ?, emailed_at = CASE WHEN ? = 'sent' THEN ? ELSE emailed_at END WHERE id = ?",
            )
                .bind(status, status === "skipped" ? 0 : 1, status, nowIso(), a.id)
                .run();
        const auth = await userForEmail(env, a.email);
        if (old || !auth.ok || !can(auth.user, "centre.use") || !prefs.email.alerts || a.notify_email === 0) {
            await finish("skipped");
            continue;
        }
        try {
            await provider.send({ to: a.email, toName: "", ...alertEmail(a, env.SITE_URL), reference: `centre-alert:${a.id}` });
            await finish("sent");
            sent++;
        } catch (error) {
            const retryable = !(error instanceof ProviderError) || error.retryable;
            console.error(JSON.stringify({ event: "centre_alert_email_failed", alertId: a.id, retryable }));
            await finish(retryable && a.email_attempts + 1 < MAX_EMAIL_ATTEMPTS ? "pending" : "failed");
        }
    }
    await sendDigests(env, provider, now);
    return sent;
}

export const watchesFor = (watches: WatchArea[]) => watches.filter((w) => w.enabled);
export const sourceLabel = (id: string) => sourceById(id)?.dataset ?? id;
