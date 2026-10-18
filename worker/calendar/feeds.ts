// Private ICS feeds people subscribe to from Apple Calendar, Outlook or Google Calendar.
//
// Calendar apps can't sign in through Cloudflare Access, so a feed is reached by an address with a
// 256-bit random token in it (/calendar/feed/<token>.ics, outside /portal). Only the token's
// SHA-256 is stored. Revoking ends it at once; rotating issues a new address and ends the old one.
// The whole feed is off unless the portal's "Calendar subscription addresses" switch is on.
//
// Every request re-checks the owner as they are now: still able to open Calendar, still a member of
// each calendar in the feed (a calendar they've since lost is silently left out), and only their
// own leave and their own tasks. Details are published only where they'd see them in the portal,
// and never for private or sensitive events or free/busy calendars: those are always "Busy". A feed
// set to "busy only" publishes nothing but busy times. Subscribed (external) calendars are never
// republished.
import type { D1Database } from "@cloudflare/workers-types";
import { z } from "zod";
import { DEFAULT_TIME_ZONE, addDays, localDate } from "../../src/shared/calendar/time";
import { type CalendarFeedInfo, type FeedScope, LIMITS, feedScope } from "../../src/shared/calendar/types";
import type { PortalUser } from "../../src/shared/portal/types";
import type { Env } from "../env";
import { userForEmail } from "../portal/auth";
import { newId, nowIso, parseJson } from "../portal/db";
import { isEnabled } from "../portal/flags";
import { HttpError } from "../portal/http";
import { listDeadlines, listUpcoming } from "../tasks/views";
import { activity, canUseCalendar, preferences, requireCalendar } from "./access";
import { EVENT_COLUMNS, type EventRow } from "./events";
import type { OverrideFields, OverrideRow } from "./expand";
import { type SerialEvent, serializeCalendar } from "./ics";
import { loadLeave } from "./leave";

const b64url = (bytes: Uint8Array) =>
    btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");

async function hashToken(token: string) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`daly-calendar-feed-token:${token}`));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const newToken = () => b64url(crypto.getRandomValues(new Uint8Array(32)));

interface FeedRow {
    id: string;
    owner_email: string;
    name: string;
    token_hint: string;
    scope: string;
    created_at: string;
    rotated_at: string | null;
    revoked_at: string | null;
    last_accessed_at: string | null;
}

const toInfo = (r: FeedRow): CalendarFeedInfo => ({
    id: r.id,
    name: r.name,
    scope: parseJson<FeedScope>(r.scope, { calendarIds: [], leave: false, tasks: "none", detail: "busy" }),
    tokenHint: r.token_hint,
    createdAt: r.created_at,
    rotatedAt: r.rotated_at,
    revokedAt: r.revoked_at,
    lastAccessedAt: r.last_accessed_at,
});

export async function listFeeds(db: D1Database, user: PortalUser): Promise<CalendarFeedInfo[]> {
    const rows = await db
        .prepare(
            "SELECT id, owner_email, name, token_hint, scope, created_at, rotated_at, revoked_at, last_accessed_at FROM calendar_feeds WHERE owner_email = ? ORDER BY revoked_at IS NOT NULL, created_at DESC",
        )
        .bind(user.email)
        .all<FeedRow>();
    return rows.results.map(toInfo);
}

const feedInput = z.object({ name: z.string().trim().min(1).max(100), scope: feedScope }).strict();

async function checkScope(db: D1Database, user: PortalUser, scope: FeedScope) {
    for (const id of scope.calendarIds) {
        const cal = await requireCalendar(db, user, id, "freebusy");
        if (cal.source === "subscription") throw new HttpError(422, "subscription", "Subscribed calendars can't be republished in a feed");
    }
    if (!scope.calendarIds.length && !scope.leave && scope.tasks === "none")
        throw new HttpError(422, "empty", "Choose at least one calendar, leave or tasks to publish");
}

/** Creates a feed. The address is returned once, now; afterwards only its last characters are shown. */
export async function createFeed(db: D1Database, user: PortalUser, input: unknown, site: string) {
    const body = feedInput.parse(input);
    await checkScope(db, user, body.scope);
    const count = await db
        .prepare("SELECT COUNT(*) AS n FROM calendar_feeds WHERE owner_email = ? AND revoked_at IS NULL")
        .bind(user.email)
        .first<{ n: number }>();
    if ((count?.n ?? 0) >= LIMITS.feedsPerPerson) throw new HttpError(422, "limit", `You can have up to ${LIMITS.feedsPerPerson} active feeds`);
    const token = newToken();
    const id = newId("cfd");
    const now = nowIso();
    await db.batch([
        db
            .prepare("INSERT INTO calendar_feeds (id, owner_email, name, token_hash, token_hint, scope, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
            .bind(id, user.email, body.name, await hashToken(token), token.slice(-4), JSON.stringify(body.scope), now),
        activity(db, { actor: user.email, action: "feed.create", entityType: "feed", entityId: id }),
    ]);
    return { feed: (await listFeeds(db, user)).find((f) => f.id === id)!, address: feedAddress(site, token) };
}

export const feedAddress = (site: string, token: string) => `${site}/calendar/feed/${token}.ics`;

export async function updateFeed(db: D1Database, user: PortalUser, id: string, input: unknown) {
    const body = feedInput.partial().strict().parse(input);
    if (body.scope) await checkScope(db, user, body.scope);
    const sets: string[] = [];
    const binds: unknown[] = [];
    if (body.name) (sets.push("name = ?"), binds.push(body.name));
    if (body.scope) (sets.push("scope = ?"), binds.push(JSON.stringify(body.scope)));
    if (!sets.length) return (await listFeeds(db, user)).find((f) => f.id === id);
    const [result] = await db.batch([
        db.prepare(`UPDATE calendar_feeds SET ${sets.join(", ")} WHERE id = ? AND owner_email = ? AND revoked_at IS NULL`).bind(...binds, id, user.email),
        activity(db, { actor: user.email, action: "feed.update", entityType: "feed", entityId: id }),
    ]);
    if (!result.meta.changes) throw new HttpError(404, "not_found", "Not found");
    return (await listFeeds(db, user)).find((f) => f.id === id)!;
}

/** A new address for the same feed; the old one stops working immediately. */
export async function rotateFeed(db: D1Database, user: PortalUser, id: string, site: string) {
    const token = newToken();
    const [result] = await db.batch([
        db
            .prepare("UPDATE calendar_feeds SET token_hash = ?, token_hint = ?, rotated_at = ? WHERE id = ? AND owner_email = ? AND revoked_at IS NULL")
            .bind(await hashToken(token), token.slice(-4), nowIso(), id, user.email),
        activity(db, { actor: user.email, action: "feed.rotate", entityType: "feed", entityId: id }),
    ]);
    if (!result.meta.changes) throw new HttpError(404, "not_found", "Not found");
    return { feed: (await listFeeds(db, user)).find((f) => f.id === id)!, address: feedAddress(site, token) };
}

export async function revokeFeed(db: D1Database, user: PortalUser, id: string) {
    const [result] = await db.batch([
        db.prepare("UPDATE calendar_feeds SET revoked_at = ? WHERE id = ? AND owner_email = ? AND revoked_at IS NULL").bind(nowIso(), id, user.email),
        activity(db, { actor: user.email, action: "feed.revoke", entityType: "feed", entityId: id }),
    ]);
    if (!result.meta.changes) throw new HttpError(404, "not_found", "Not found");
    return listFeeds(db, user);
}

// --- Serving -------------------------------------------------------------------------------------

const FEED_HEADERS = {
    "Content-Type": "text/calendar; charset=utf-8",
    "Cache-Control": "private, max-age=300",
    "X-Robots-Tag": "noindex, nofollow",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
};

const notFoundResponse = () => new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" } });

/** GET /calendar/feed/<token>.ics */
export async function serveFeed(env: Env, token: string): Promise<Response> {
    // The same answer for "switched off", "no such feed" and "revoked": nothing to probe.
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return notFoundResponse();
    if (!(await isEnabled(env.DB, "calendar.feeds"))) return notFoundResponse();
    const db = env.DB;
    const row = await db
        .prepare("SELECT id, owner_email, name, scope, last_accessed_at FROM calendar_feeds WHERE token_hash = ? AND revoked_at IS NULL")
        .bind(await hashToken(token))
        .first<{ id: string; owner_email: string; name: string; scope: string; last_accessed_at: string | null }>();
    if (!row) return notFoundResponse();
    if (!(await canUseCalendar(env, db, row.owner_email))) return notFoundResponse();
    const auth = await userForEmail(env, row.owner_email);
    if (!auth.ok || !auth.user.permissions.includes("calendar.use")) return notFoundResponse();
    const scope = feedScope.safeParse(parseJson(row.scope, null));
    if (!scope.success) return notFoundResponse();
    const body = await buildFeed(db, auth.user, row.name, scope.data, new URL(env.SITE_URL).origin);
    // Recording access at most every 15 minutes keeps a busy feed from writing on every poll.
    if (!row.last_accessed_at || Date.parse(row.last_accessed_at) < Date.now() - 15 * 60_000)
        await db.prepare("UPDATE calendar_feeds SET last_accessed_at = ?, access_count = access_count + 1 WHERE id = ?").bind(nowIso(), row.id).run();
    return new Response(body, { headers: FEED_HEADERS });
}

/** The feed's events as the owner may see them now. Everything outside their access is left out. */
export async function buildFeed(db: D1Database, user: PortalUser, name: string, scope: FeedScope, site: string): Promise<string> {
    const prefs = await preferences(db, user.email);
    const today = localDate(new Date(), prefs.timeZone || DEFAULT_TIME_ZONE);
    const since = new Date(Date.now() - 400 * 86_400_000).toISOString();
    const events: SerialEvent[] = [];
    const busyOnly = scope.detail === "busy";

    if (scope.calendarIds.length) {
        const rows = await db
            .prepare(
                `SELECT ${EVENT_COLUMNS}, m.role FROM calendar_events e JOIN calendar_members m ON m.calendar_id = e.calendar_id AND m.email = ? JOIN calendars c ON c.id = e.calendar_id
                 WHERE c.source = 'local' AND e.calendar_id IN (SELECT value FROM json_each(?)) AND e.series_end_at > ? AND e.status <> 'cancelled' LIMIT 3000`,
            )
            .bind(user.email, JSON.stringify(scope.calendarIds), since)
            .all<EventRow & { role: string }>();
        const overrides = new Map<string, OverrideRow[]>();
        const ids = rows.results.filter((r) => r.rrule).map((r) => r.id);
        for (let i = 0; i < ids.length; i += 90) {
            const found = await db
                .prepare(
                    "SELECT event_id, occurrence_key, cancelled, fields, start_at, end_at FROM calendar_event_overrides WHERE event_id IN (SELECT value FROM json_each(?))",
                )
                .bind(JSON.stringify(ids.slice(i, i + 90)))
                .all<OverrideRow>();
            for (const o of found.results) overrides.set(o.event_id, [...(overrides.get(o.event_id) ?? []), o]);
        }
        for (const r of rows.results) {
            const hidden = busyOnly || r.role === "freebusy" || r.visibility !== "default";
            events.push({
                uid: r.uid,
                title: hidden ? "Busy" : r.title,
                description: hidden ? null : r.description,
                location: hidden ? null : r.location,
                url: hidden ? null : r.url,
                allDay: !!r.all_day,
                startDate: r.start_date,
                startTime: r.start_time,
                endDate: r.end_date,
                endTime: r.end_time,
                timeZone: r.time_zone,
                rrule: r.rrule,
                exdates: parseJson<string[]>(r.exdates, []),
                rdates: parseJson<string[]>(r.rdates, []),
                status: r.status,
                showAs: r.show_as,
                private: hidden,
                updatedAt: r.updated_at,
                overrides: (overrides.get(r.id) ?? []).map((o) => {
                    const f = parseJson<OverrideFields>(o.fields, {});
                    const allDay = f.allDay ?? !!r.all_day;
                    return {
                        key: o.occurrence_key,
                        cancelled: !!o.cancelled || f.status === "cancelled",
                        title: hidden ? "Busy" : (f.title ?? r.title),
                        description: hidden ? null : f.description !== undefined ? f.description : r.description,
                        location: hidden ? null : f.location !== undefined ? f.location : r.location,
                        allDay,
                        startDate: f.startDate ?? o.occurrence_key.slice(0, 10),
                        startTime: allDay ? null : (f.startTime ?? (o.occurrence_key.slice(11) || r.start_time)),
                        endDate: f.endDate ?? f.startDate ?? o.occurrence_key.slice(0, 10),
                        endTime: allDay ? null : (f.endTime ?? r.end_time),
                    };
                }),
            });
        }
    }

    if (scope.leave) {
        const leave = await loadLeave(db, user);
        const types = new Map(leave.types.map((t) => [t.id, t]));
        for (const b of leave.bookings) {
            if (b.scenarioId || !(b.status === "approved" || b.status === "taken" || b.status === "requested")) continue;
            if (b.endDate < addDays(today, -400)) continue;
            const type = types.get(b.leaveTypeId);
            const label = busyOnly ? "Away" : `${type?.name ?? "Leave"}${b.status === "requested" ? " (requested)" : ""}`;
            events.push({
                uid: `${b.id}@leave.daly.id.au`,
                title: label,
                description: null,
                location: null,
                url: null,
                allDay: true,
                startDate: b.startDate,
                startTime: null,
                endDate: b.endDate,
                endTime: null,
                timeZone: prefs.timeZone,
                rrule: null,
                exdates: [],
                status: b.status === "requested" ? "tentative" : "confirmed",
                showAs: "busy",
                private: busyOnly,
                updatedAt: b.updatedAt,
            });
        }
    }

    if (scope.tasks !== "none" && user.permissions.includes("tasks.use")) {
        const horizon = addDays(today, 365);
        const tasks =
            scope.tasks === "deadlines" ? await listDeadlines(db, user.email, today, horizon) : await listUpcoming(db, user.email, today, horizon, today);
        const seen = new Set<string>();
        for (const t of tasks) {
            const date = scope.tasks === "deadlines" ? t.deadline : t.dueDate;
            if (!date) continue;
            const uid = `${t.id}-${date}@tasks.daly.id.au`;
            if (seen.has(uid)) continue;
            seen.add(uid);
            const timed = scope.tasks === "dated" && !!t.dueTime;
            events.push({
                uid,
                title: busyOnly ? "Task due" : `${scope.tasks === "deadlines" ? "Deadline" : "Task"}: ${t.title}`,
                description: null,
                location: null,
                url: busyOnly ? null : `${site}/portal/tasks/t/${t.id}`,
                allDay: !timed,
                startDate: date,
                startTime: timed ? t.dueTime : null,
                endDate: date,
                endTime: timed ? t.dueTime : null,
                timeZone: prefs.timeZone,
                rrule: null,
                exdates: [],
                status: "confirmed",
                showAs: "free",
                private: busyOnly,
                updatedAt: nowIso(),
            });
        }
    }

    return serializeCalendar({ name, description: "Daly Calendar (private feed)", events, refreshHours: 1 });
}
