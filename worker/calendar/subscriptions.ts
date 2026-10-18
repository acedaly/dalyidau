// External calendar subscriptions: an ICS/webcal address whose events appear, read-only, in a
// calendar of their own, refreshed in the background (every six hours by default).
//
// Each refresh is one conditional GET (ETag / Last-Modified), so an unchanged feed costs a 304.
// Events are matched on their iCalendar UID, so an event keeps its id (and anyone's links and
// reminders on it) when the feed changes its time or title. A content hash skips rewriting events
// that didn't change. Events gone from the feed, and cancelled ones, are removed; RECURRENCE-ID
// instances become single-occurrence changes. A feed that suddenly returns nothing is not believed
// the first time: the events are kept until a second refresh agrees.
//
// Failures back off (15 min, 30 min, 1 h … up to the refresh interval, never more than a day) and
// never stop the schedule. After three in a row the owner gets a notification. The address is never
// logged, returned to the browser or written to the activity history.
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { z } from "zod";
import { CALENDAR_COLORS, type CalendarColor, LIMITS, type SubscriptionInfo } from "../../src/shared/calendar/types";
import type { PortalUser } from "../../src/shared/portal/types";
import type { Env } from "../env";
import { newId, nowIso } from "../portal/db";
import { HttpError } from "../portal/http";
import { activity, preferences, requireCalendar } from "./access";
import { seriesEndAt } from "./expand";
import { instants } from "./expand";
import { IcsError, type ParsedEvent, parseIcs } from "./ics";
import { FeedError, type Resolver, fetchFeed, maskUrl, normaliseFeedUrl, providerOf } from "./safe-fetch";
import { isSealed, openUrl, sealUrl, urlFingerprint } from "./secret";

interface SubscriptionRow {
    id: string;
    calendar_id: string;
    owner_email: string;
    url_secret: string;
    url_display: string;
    provider: SubscriptionInfo["provider"];
    enabled: number;
    refresh_minutes: number;
    etag: string | null;
    last_modified: string | null;
    next_refresh_at: string;
    last_attempt_at: string | null;
    last_success_at: string | null;
    last_status: SubscriptionInfo["lastStatus"];
    last_error_code: string | null;
    last_error: string | null;
    consecutive_failures: number;
    failing_since: string | null;
    event_count: number;
    version: number;
}

const COLUMNS = `s.id, s.calendar_id, s.owner_email, s.url_secret, s.url_display, s.provider, s.enabled, s.refresh_minutes, s.etag, s.last_modified,
    s.next_refresh_at, s.last_attempt_at, s.last_success_at, s.last_status, s.last_error_code, s.last_error, s.consecutive_failures, s.failing_since,
    s.event_count, s.version`;

/** Hosts a feed may never point at: this portal's own. */
export const ownHosts = (env: Env) => {
    const hosts = new Set<string>();
    for (const value of [env.SITE_URL, env.WEDDING_URL]) {
        try {
            if (value) hosts.add(new URL(value).hostname.replace(/^www\./, ""));
        } catch {
            // ignore
        }
    }
    hosts.add("daly.id.au");
    return [...hosts];
};

export async function listSubscriptions(db: D1Database, user: PortalUser): Promise<SubscriptionInfo[]> {
    const rows = await db
        .prepare(
            `SELECT ${COLUMNS}, c.name, c.kind, coalesce(m.color, c.color) AS color, m.hidden
             FROM calendar_subscriptions s JOIN calendars c ON c.id = s.calendar_id JOIN calendar_members m ON m.calendar_id = c.id AND m.email = ?
             ORDER BY c.name COLLATE NOCASE`,
        )
        .bind(user.email)
        .all<SubscriptionRow & { name: string; kind: "personal" | "shared"; color: string; hidden: number }>();
    return rows.results.map((r) => ({
        id: r.id,
        calendarId: r.calendar_id,
        name: r.name,
        color: ((CALENDAR_COLORS as readonly string[]).includes(r.color) ? r.color : "gray") as CalendarColor,
        kind: r.kind,
        urlDisplay: r.url_display,
        provider: r.provider,
        enabled: !!r.enabled,
        hidden: !!r.hidden,
        refreshMinutes: r.refresh_minutes,
        lastAttemptAt: r.last_attempt_at,
        lastSuccessAt: r.last_success_at,
        lastStatus: r.last_status,
        lastErrorCode: r.last_error_code,
        lastError: r.last_error,
        consecutiveFailures: r.consecutive_failures,
        nextRefreshAt: r.next_refresh_at,
        eventCount: r.event_count,
        canManage: r.owner_email === user.email,
        version: r.version,
    }));
}

async function requireOwnSubscription(db: D1Database, user: PortalUser, id: string): Promise<SubscriptionRow> {
    const row = await db
        .prepare(`SELECT ${COLUMNS} FROM calendar_subscriptions s JOIN calendar_members m ON m.calendar_id = s.calendar_id AND m.email = ? WHERE s.id = ?`)
        .bind(user.email, id)
        .first<SubscriptionRow>();
    if (!row) throw new HttpError(404, "not_found", "Not found");
    if (row.owner_email !== user.email) throw new HttpError(403, "forbidden", "Only the person who added a subscription can change it");
    return row;
}

const feedError = (error: FeedError | IcsError) => new HttpError(422, error.code, error.message);

const createInput = z
    .object({
        url: z.string().trim().min(8).max(2000),
        name: z.string().trim().min(1).max(100).optional(),
        color: z.enum(CALENDAR_COLORS).default("gray"),
        kind: z.enum(["personal", "shared"]).default("personal"),
        refreshMinutes: z.number().int().min(60).max(10080).default(360),
        clientId: z
            .string()
            .regex(/^[A-Za-z0-9_-]{8,64}$/)
            .optional(),
    })
    .strict();

export interface SyncDeps {
    resolve?: Resolver;
}

/**
 * Adds a subscription. The address is checked and fetched first: an address that can't work
 * (refused, not a calendar, private network) is refused with the reason and nothing is saved. One
 * that's only temporarily unreachable is saved and retried in the background.
 */
export async function createSubscription(env: Env, db: D1Database, user: PortalUser, input: unknown, deps: SyncDeps = {}, via: "portal" | "mcp" = "portal") {
    const body = createInput.parse(input);
    if (body.clientId) {
        const earlier = await db
            .prepare("SELECT id FROM calendar_subscriptions WHERE owner_email = ? AND client_id = ?")
            .bind(user.email, body.clientId)
            .first<{ id: string }>();
        if (earlier) return { subscription: (await listSubscriptions(db, user)).find((s) => s.id === earlier.id)!, replayed: true };
    }
    let url: URL;
    try {
        url = normaliseFeedUrl(body.url, ownHosts(env));
    } catch (error) {
        if (error instanceof FeedError) throw feedError(error);
        throw error;
    }
    const fingerprint = await urlFingerprint(url.toString());
    const duplicate = await db
        .prepare("SELECT id FROM calendar_subscriptions WHERE owner_email = ? AND url_hash = ?")
        .bind(user.email, fingerprint)
        .first<{ id: string }>();
    if (duplicate) throw new HttpError(409, "duplicate", "You're already subscribed to that calendar.");
    const count = await db.prepare("SELECT COUNT(*) AS n FROM calendar_subscriptions WHERE owner_email = ?").bind(user.email).first<{ n: number }>();
    if ((count?.n ?? 0) >= LIMITS.subscriptionsPerPerson)
        throw new HttpError(422, "limit", `You can have up to ${LIMITS.subscriptionsPerPerson} subscriptions`);

    // Try it before saving anything.
    let first: Awaited<ReturnType<typeof fetchFeed>> | null = null;
    let parsedName: string | null = null;
    let pendingError: FeedError | null = null;
    try {
        first = await fetchFeed(url, { ownHosts: ownHosts(env), resolve: deps.resolve });
        if (first.text) parsedName = parseIcs(first.text, { fallbackZone: "Australia/Sydney", maxEvents: 1 }).name;
    } catch (error) {
        if (error instanceof IcsError) throw feedError(error);
        if (!(error instanceof FeedError)) throw error;
        if (!error.retryable) throw feedError(error);
        pendingError = error;
    }

    const prefs = await preferences(db, user.email);
    const calendarId = newId("cal");
    const id = newId("csb");
    const now = nowIso();
    const name = body.name ?? parsedName ?? url.hostname;
    await db.batch([
        db
            .prepare(
                `INSERT INTO calendars (id, name, color, kind, purpose, source, time_zone, owner_email, created_by, created_at, updated_by, updated_at)
                 VALUES (?, ?, ?, ?, 'subscription', 'subscription', ?, ?, ?, ?, ?, ?)`,
            )
            .bind(calendarId, name.slice(0, 100), body.color, body.kind, prefs.timeZone, user.email, user.email, now, user.email, now),
        db
            .prepare("INSERT INTO calendar_members (calendar_id, email, role, position, added_by, created_at, updated_at) VALUES (?, ?, 'owner', 200, ?, ?, ?)")
            .bind(calendarId, user.email, user.email, now, now),
        db
            .prepare(
                `INSERT INTO calendar_subscriptions (id, calendar_id, owner_email, url_secret, url_hash, url_display, provider, refresh_minutes, next_refresh_at, client_id, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
                id,
                calendarId,
                user.email,
                await sealUrl(env, url.toString()),
                fingerprint,
                maskUrl(url),
                providerOf(url),
                body.refreshMinutes,
                now,
                body.clientId ?? null,
                now,
                now,
            ),
        activity(db, { actor: user.email, action: "subscription.create", entityType: "subscription", entityId: id, calendarId, via }),
    ]);
    if (first) await applyFetch(env, db, id, first, deps);
    else if (pendingError) await recordFailure(db, id, pendingError);
    return { subscription: (await listSubscriptions(db, user)).find((s) => s.id === id)!, replayed: false };
}

const updateInput = z
    .object({
        version: z.number().int().min(1),
        name: z.string().trim().min(1).max(100).optional(),
        color: z.enum(CALENDAR_COLORS).optional(),
        kind: z.enum(["personal", "shared"]).optional(),
        enabled: z.boolean().optional(),
        refreshMinutes: z.number().int().min(60).max(10080).optional(),
    })
    .strict();

export async function updateSubscription(db: D1Database, user: PortalUser, id: string, input: unknown) {
    const sub = await requireOwnSubscription(db, user, id);
    const body = updateInput.parse(input);
    const now = nowIso();
    const statements: D1PreparedStatement[] = [];
    const calendarSets: string[] = [];
    const calendarBinds: unknown[] = [];
    if (body.name !== undefined) (calendarSets.push("name = ?"), calendarBinds.push(body.name));
    if (body.color !== undefined) (calendarSets.push("color = ?"), calendarBinds.push(body.color));
    if (body.kind !== undefined) (calendarSets.push("kind = ?"), calendarBinds.push(body.kind));
    if (calendarSets.length)
        statements.push(
            db
                .prepare(`UPDATE calendars SET ${calendarSets.join(", ")}, updated_by = ?, updated_at = ? WHERE id = ?`)
                .bind(...calendarBinds, user.email, now, sub.calendar_id),
        );
    const sets: string[] = [];
    const binds: unknown[] = [];
    if (body.enabled !== undefined) {
        sets.push("enabled = ?");
        binds.push(body.enabled ? 1 : 0);
        // Turning it back on refreshes straight away.
        if (body.enabled && !sub.enabled) (sets.push("next_refresh_at = ?"), binds.push(now));
    }
    if (body.refreshMinutes !== undefined) (sets.push("refresh_minutes = ?"), binds.push(body.refreshMinutes));
    const [first] = await db
        .batch([
            db
                .prepare(`UPDATE calendar_subscriptions SET ${[...sets, "version = version + 1", "updated_at = ?"].join(", ")} WHERE id = ? AND version = ?`)
                .bind(...binds, now, id, body.version),
            ...statements,
            activity(db, { actor: user.email, action: "subscription.update", entityType: "subscription", entityId: id, calendarId: sub.calendar_id }),
        ])
        .catch((error: Error) => {
            if (/personal/.test(error.message))
                throw new HttpError(422, "members", "Remove the people it's shared with (or make them free/busy) before making it personal");
            throw error;
        });
    if (!first.meta.changes) throw new HttpError(409, "conflict", "This subscription changed since you opened it. Reload and try again.");
    return (await listSubscriptions(db, user)).find((s) => s.id === id)!;
}

/** Removing a subscription deletes its calendar and the copies of its events, never the feed itself. */
export async function deleteSubscription(db: D1Database, user: PortalUser, id: string) {
    const sub = await requireOwnSubscription(db, user, id);
    await requireCalendar(db, user, sub.calendar_id, "owner");
    await db.batch([
        db.prepare("DELETE FROM calendars WHERE id = ?").bind(sub.calendar_id),
        activity(db, { actor: user.email, action: "subscription.delete", entityType: "subscription", entityId: id }),
    ]);
}

/** A refresh asked for by the owner (the portal's button, or MCP). At most once a minute. */
export async function requestRefresh(env: Env, db: D1Database, user: PortalUser, id: string, deps: SyncDeps = {}, via: "portal" | "mcp" = "portal") {
    const sub = await requireOwnSubscription(db, user, id);
    if (sub.last_attempt_at && Date.parse(sub.last_attempt_at) > Date.now() - 60_000)
        throw new HttpError(429, "too_soon", "That calendar was refreshed less than a minute ago. Try again shortly.");
    await activity(db, { actor: user.email, action: "subscription.refresh", entityType: "subscription", entityId: id, calendarId: sub.calendar_id, via }).run();
    await refreshSubscription(env, db, id, { force: false, deps });
    return (await listSubscriptions(db, user)).find((s) => s.id === id)!;
}

// --- Refreshing ----------------------------------------------------------------------------------

const backoffMinutes = (failures: number, interval: number) => Math.min(15 * 2 ** Math.max(0, failures - 1), interval, 24 * 60);

async function recordFailure(db: D1Database, id: string, error: FeedError | IcsError | Error) {
    const now = nowIso();
    const code = error instanceof FeedError || error instanceof IcsError ? error.code : "server_error";
    const message =
        error instanceof FeedError || error instanceof IcsError ? error.message : "Something went wrong reading this calendar. It will be tried again.";
    const row = await db
        .prepare("SELECT owner_email, consecutive_failures, refresh_minutes, failing_since FROM calendar_subscriptions WHERE id = ?")
        .bind(id)
        .first<{
            owner_email: string;
            consecutive_failures: number;
            refresh_minutes: number;
            failing_since: string | null;
        }>();
    if (!row) return;
    const failures = row.consecutive_failures + 1;
    const since = row.failing_since ?? now;
    const next = new Date(Date.now() + backoffMinutes(failures, row.refresh_minutes) * 60_000).toISOString();
    const statements = [
        db
            .prepare(
                `UPDATE calendar_subscriptions SET last_attempt_at = ?, last_status = 'error', last_error_code = ?, last_error = ?, consecutive_failures = ?,
                    failing_since = ?, next_refresh_at = ?, lease_until = NULL WHERE id = ?`,
            )
            .bind(now, code.slice(0, 40), message.slice(0, 300), failures, since, next, id),
    ];
    if (failures === 3 && (await preferences(db, row.owner_email)).notify.subscriptions) {
        const name = await db
            .prepare("SELECT c.name FROM calendars c JOIN calendar_subscriptions s ON s.calendar_id = c.id WHERE s.id = ?")
            .bind(id)
            .first<{ name: string }>();
        statements.push(
            db
                .prepare(
                    `INSERT INTO calendar_notifications (id, email, kind, ref_id, occurrence_key, fire_at, title, detail, url, email_status, created_at)
                     VALUES (?, ?, 'subscription', ?, ?, ?, ?, ?, '/portal/calendar/subscriptions', 'pending', ?) ON CONFLICT DO NOTHING`,
                )
                .bind(
                    newId("cnt"),
                    row.owner_email,
                    id,
                    since.slice(0, 16),
                    now,
                    `A calendar subscription is failing: ${name?.name ?? "subscription"}`.slice(0, 300),
                    message.slice(0, 300),
                    now,
                ),
        );
    }
    await db.batch(statements);
}

async function sha256(text: string) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Writes a parsed feed into the subscription's calendar. Returns the number of events now held. */
async function syncEvents(
    db: D1Database,
    sub: { id: string; calendar_id: string; owner_email: string; last_error_code: string | null },
    events: ParsedEvent[],
) {
    const existing = await db
        .prepare("SELECT id, uid, content_hash FROM calendar_events WHERE calendar_id = ?")
        .bind(sub.calendar_id)
        .all<{ id: string; uid: string; content_hash: string | null }>();
    const byUid = new Map(existing.results.map((r) => [r.uid, r]));
    const statements: D1PreparedStatement[] = [];
    const now = nowIso();
    const keep = new Set<string>();
    for (const e of events) {
        keep.add(e.uid);
        const hash = await sha256(JSON.stringify(e));
        const current = byUid.get(e.uid);
        if (current?.content_hash === hash) continue;
        const times = {
            all_day: e.allDay ? 1 : 0,
            start_date: e.startDate,
            start_time: e.startTime,
            end_date: e.endDate,
            end_time: e.endTime,
            time_zone: e.timeZone,
            rrule: e.rrule,
            rdates: e.rdates.length ? JSON.stringify(e.rdates) : null,
            exdates: e.exdates.length ? JSON.stringify(e.exdates) : null,
        };
        const { startAt, endAt } = instants(e.allDay, e.startDate, e.startTime, e.endDate, e.endTime, e.timeZone);
        const id = current?.id ?? newId("cev");
        const values = [
            e.title,
            e.description,
            e.location,
            e.url,
            times.all_day,
            times.start_date,
            times.start_time,
            times.end_date,
            times.end_time,
            times.time_zone,
            startAt,
            endAt,
            times.rrule,
            times.rdates,
            times.exdates,
            seriesEndAt(times),
            e.visibility,
            e.showAs,
            e.status,
            hash,
        ];
        if (current) {
            statements.push(
                db
                    .prepare(
                        `UPDATE calendar_events SET title = ?, description = ?, location = ?, url = ?, all_day = ?, start_date = ?, start_time = ?, end_date = ?, end_time = ?,
                            time_zone = ?, start_at = ?, end_at = ?, rrule = ?, rdates = ?, exdates = ?, series_end_at = ?, visibility = ?, show_as = ?, status = ?, content_hash = ?,
                            version = version + 1, updated_by = 'subscription', updated_at = ? WHERE id = ?`,
                    )
                    .bind(...values, now, id),
                db.prepare("DELETE FROM calendar_event_overrides WHERE event_id = ?").bind(id),
            );
        } else {
            statements.push(
                db
                    .prepare(
                        `INSERT INTO calendar_events (id, calendar_id, source, uid, title, description, location, url, all_day, start_date, start_time, end_date, end_time,
                            time_zone, start_at, end_at, rrule, rdates, exdates, series_end_at, visibility, show_as, status, content_hash, created_by, created_at, updated_by, updated_at)
                         VALUES (?, ?, 'subscription', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'subscription', ?)
                         ON CONFLICT (calendar_id, uid) DO NOTHING`,
                    )
                    .bind(id, sub.calendar_id, e.uid, ...values, sub.owner_email, now, now),
            );
        }
        for (const o of e.overrides) {
            const fields = o.fields;
            let start: string | null = null;
            let end: string | null = null;
            if (fields.startDate) {
                const allDay = fields.allDay ?? e.allDay;
                const span = instants(
                    allDay,
                    fields.startDate,
                    allDay ? null : (fields.startTime ?? e.startTime),
                    fields.endDate ?? fields.startDate,
                    allDay ? null : (fields.endTime ?? e.endTime),
                    e.timeZone,
                );
                [start, end] = [span.startAt, span.endAt];
            }
            statements.push(
                db
                    .prepare(
                        `INSERT INTO calendar_event_overrides (event_id, occurrence_key, cancelled, fields, start_at, end_at, updated_by, updated_at)
                         SELECT id, ?, ?, ?, ?, ?, 'subscription', ? FROM calendar_events WHERE calendar_id = ? AND uid = ?
                         ON CONFLICT (event_id, occurrence_key) DO UPDATE SET cancelled = excluded.cancelled, fields = excluded.fields, start_at = excluded.start_at,
                            end_at = excluded.end_at, updated_at = excluded.updated_at`,
                    )
                    .bind(o.key, o.cancelled ? 1 : 0, JSON.stringify(fields), start, end, now, sub.calendar_id, e.uid),
            );
        }
    }
    const gone = existing.results.filter((r) => !keep.has(r.uid));
    // A feed that suddenly has nothing at all is believed only when a second refresh agrees.
    if (!events.length && existing.results.length && sub.last_error_code !== "empty_feed") return { count: existing.results.length, emptyHeld: true };
    for (const r of gone) statements.push(db.prepare("DELETE FROM calendar_events WHERE id = ?").bind(r.id));
    for (let i = 0; i < statements.length; i += 50) await db.batch(statements.slice(i, i + 50));
    return { count: events.length, emptyHeld: false };
}

async function applyFetch(env: Env, db: D1Database, id: string, result: Awaited<ReturnType<typeof fetchFeed>>, deps: SyncDeps = {}) {
    void deps;
    const sub = await db
        .prepare(
            `SELECT s.id, s.calendar_id, s.owner_email, s.url_secret, s.refresh_minutes, s.last_error_code, c.time_zone FROM calendar_subscriptions s
             JOIN calendars c ON c.id = s.calendar_id WHERE s.id = ?`,
        )
        .bind(id)
        .first<{
            id: string;
            calendar_id: string;
            owner_email: string;
            url_secret: string;
            refresh_minutes: number;
            last_error_code: string | null;
            time_zone: string;
        }>();
    if (!sub) return;
    const now = nowIso();
    const next = new Date(Date.now() + sub.refresh_minutes * 60_000).toISOString();
    if (result.status === "not_modified") {
        await db
            .prepare(
                `UPDATE calendar_subscriptions SET last_attempt_at = ?, last_success_at = ?, last_status = 'not_modified', last_error_code = NULL, last_error = NULL,
                    consecutive_failures = 0, failing_since = NULL, next_refresh_at = ?, lease_until = NULL WHERE id = ?`,
            )
            .bind(now, now, next, id)
            .run();
        return;
    }
    let parsed;
    try {
        parsed = parseIcs(result.text ?? "", { fallbackZone: sub.time_zone });
    } catch (error) {
        await recordFailure(db, id, error as Error);
        return;
    }
    const { count, emptyHeld } = await syncEvents(db, sub, parsed.events);
    // An address stored before encryption was configured is sealed now.
    const reseal = !isSealed(sub.url_secret) && env.CALENDAR_ENCRYPTION_KEY ? await openUrl(env, sub.url_secret) : null;
    await db
        .prepare(
            `UPDATE calendar_subscriptions SET last_attempt_at = ?, last_success_at = ?, last_status = ?, last_error_code = ?, last_error = ?,
                consecutive_failures = 0, failing_since = NULL, next_refresh_at = ?, lease_until = NULL, etag = ?, last_modified = ?, event_count = ?, last_bytes = ?
                ${reseal ? ", url_secret = ?" : ""} WHERE id = ?`,
        )
        .bind(
            now,
            now,
            emptyHeld ? "error" : "ok",
            emptyHeld ? "empty_feed" : null,
            emptyHeld ? "The calendar came back empty, so its events were kept for now. If it's still empty next time, they'll be removed." : null,
            next,
            emptyHeld ? null : result.etag,
            emptyHeld ? null : result.lastModified,
            count,
            result.bytes,
            ...(reseal ? [await sealUrl(env, reseal)] : []),
            id,
        )
        .run();
}

/** Refreshes one subscription, if no other run holds it. */
export async function refreshSubscription(env: Env, db: D1Database, id: string, options: { force?: boolean; deps?: SyncDeps } = {}) {
    const now = nowIso();
    const lease = new Date(Date.now() + 2 * 60_000).toISOString();
    const claimed = await db
        .prepare("UPDATE calendar_subscriptions SET lease_until = ? WHERE id = ? AND (lease_until IS NULL OR lease_until < ?)")
        .bind(lease, id, now)
        .run();
    if (!claimed.meta.changes) return "busy" as const;
    const sub = await db
        .prepare("SELECT url_secret, etag, last_modified FROM calendar_subscriptions WHERE id = ?")
        .bind(id)
        .first<{ url_secret: string; etag: string | null; last_modified: string | null }>();
    if (!sub) return "gone" as const;
    try {
        const address = await openUrl(env, sub.url_secret);
        if (!address)
            throw new FeedError(
                "key_unavailable",
                "This subscription's address is encrypted with a key that's no longer configured. Remove it and add it again.",
                false,
            );
        const url = normaliseFeedUrl(address, ownHosts(env));
        const result = await fetchFeed(url, {
            etag: options.force ? null : sub.etag,
            lastModified: options.force ? null : sub.last_modified,
            ownHosts: ownHosts(env),
            resolve: options.deps?.resolve,
        });
        await applyFetch(env, db, id, result, options.deps);
        return "done" as const;
    } catch (error) {
        if (!(error instanceof FeedError || error instanceof IcsError))
            console.error(JSON.stringify({ event: "calendar_subscription_error", subscription: id, error: (error as Error)?.name }));
        await recordFailure(db, id, error as Error);
        return "failed" as const;
    }
}

/** The cron step: refresh the subscriptions that are due, oldest first, a few per run. */
export async function processDueSubscriptions(env: Env, options: { limit?: number; deps?: SyncDeps } = {}) {
    const due = await env.DB.prepare(
        "SELECT id FROM calendar_subscriptions WHERE enabled = 1 AND next_refresh_at <= ? AND (lease_until IS NULL OR lease_until < ?) ORDER BY next_refresh_at LIMIT ?",
    )
        .bind(nowIso(), nowIso(), options.limit ?? 4)
        .all<{ id: string }>();
    let refreshed = 0;
    for (const { id } of due.results) {
        if ((await refreshSubscription(env, env.DB, id, { deps: options.deps })) === "done") refreshed++;
    }
    return { due: due.results.length, refreshed };
}
