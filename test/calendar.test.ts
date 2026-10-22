// Daly Calendar and the Leave Planner through the Worker: privacy between people and household
// sharing, repeating events, the retired links to Tasks and Knowledge, external subscriptions, outbound feeds,
// leave, MCP tools, notifications, backup and the database's own guarantees. Every identity, event
// and calendar is invented; no real network is touched (fetch and DNS are stand-ins).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localDate } from "../src/shared/calendar/time";
import type { CalendarInfo, EventDetail, EventOccurrence, LeaveData, SubscriptionInfo } from "../src/shared/calendar/types";
import { processCalendarNotifications } from "../worker/calendar/notify";
import { processDueSubscriptions } from "../worker/calendar/subscriptions";
import type { Env } from "../worker/env";
import { type PortalMcpResponse, handleMcpCall } from "../worker/mcp/entrypoint";
import { OWNER, SECOND_OWNER, accessToken, apiCall, db, portalEnv, call as rawCall, resetPortal } from "./portal-helpers";

const A = OWNER;
const B = SECOND_OWNER;
const EDITOR = "wedding-editor@example.com";
const C = "/api/portal/calendar";
const MCP_AUD = "aud-mcp-gateway-0123456789abcdef";

const cal = <R = unknown>(method: string, path: string, body?: unknown, email = A) => apiCall<R>(method, `${C}${path}`, body, { email });
const ok = async <R = unknown>(method: string, path: string, body?: unknown, email = A) => {
    const r = await cal<R>(method, path, body, email);
    expect(r.status, `${method} ${path}: ${r.text}`).toBeLessThan(300);
    return r.json;
};
const calendars = async (email = A) => (await ok<{ calendars: CalendarInfo[] }>("GET", "/calendars", undefined, email)).calendars;
const defaultCalendar = async (email = A) => (await calendars(email)).find((c) => c.isDefault)!;
const event = async (body: Record<string, unknown>, email = A) => (await ok<{ event: EventDetail }>("POST", "/events", body, email)).event;
const window = async (from: string, to: string, email = A) =>
    (await ok<{ occurrences: EventOccurrence[] }>("GET", `/events?from=${from}&to=${to}&overlays=0`, undefined, email)).occurrences;
const shared = async (name = "Household") => {
    const { calendar } = await ok<{ calendar: CalendarInfo }>("POST", "/calendars", { name, kind: "shared", purpose: "family" });
    return calendar;
};
const mcpEnv = (overrides: Partial<Env> = {}) => portalEnv({ MCP_ACCESS_AUD: MCP_AUD, ...overrides });
const mcp = async <T = Record<string, unknown>>(tool: string, input: unknown = {}, email = A) =>
    (await handleMcpCall(await mcpEnv(), { assertion: await accessToken({ email, aud: [MCP_AUD] }), tool, input })) as PortalMcpResponse & { data: T };

beforeEach(resetPortal);
afterEach(() => vi.restoreAllMocks());

describe("migration 0022", () => {
    it("refuses in the database what the Worker must never do", async () => {
        const mine = await defaultCalendar();
        const now = new Date().toISOString();
        // Someone other than the owner, beyond free/busy, on a personal calendar.
        await expect(
            db()
                .prepare("INSERT INTO calendar_members (calendar_id, email, role, added_by, created_at, updated_at) VALUES (?, ?, 'viewer', 'x', ?, ?)")
                .bind(mine.id, B, now, now)
                .run(),
        ).rejects.toThrow(/free\/busy only/);
        await db()
            .prepare("INSERT INTO calendar_members (calendar_id, email, role, added_by, created_at, updated_at) VALUES (?, ?, 'freebusy', 'x', ?, ?)")
            .bind(mine.id, B, now, now)
            .run();
        await expect(db().prepare("UPDATE calendar_members SET role = 'editor' WHERE calendar_id = ? AND email = ?").bind(mine.id, B).run()).rejects.toThrow(
            /free\/busy only/,
        );
        // A second default calendar, an event ending before it starts.
        await expect(
            db()
                .prepare(
                    "INSERT INTO calendars (id, name, kind, owner_email, is_default, created_by, created_at, updated_by, updated_at) VALUES ('cal_x', 'X', 'personal', ?, 1, 'x', ?, 'x', ?)",
                )
                .bind(A, now, now)
                .run(),
        ).rejects.toThrow(/UNIQUE/);
        await expect(
            db()
                .prepare(
                    `INSERT INTO calendar_events (id, calendar_id, uid, title, all_day, start_date, end_date, time_zone, start_at, end_at, series_end_at, created_by, created_at, updated_by, updated_at)
                     VALUES ('cev_x', ?, 'u', 'T', 1, '2026-10-02', '2026-10-01', 'UTC', '2026-10-02', '2026-10-01', '2026-10-01', 'x', ?, 'x', ?)`,
                )
                .bind(mine.id, now, now)
                .run(),
        ).rejects.toThrow(/CHECK/);
        // The rebuilt MCP ledger accepts the calendar outcomes and still has its retry index.
        await db()
            .prepare(
                "INSERT INTO mcp_writes (id, email, tool, request_key, status, entity_type, entity_id, created_at) VALUES ('mcw_1', ?, 'calendar_create_event', 'req-12345678', 'done', 'calendar_event', 'cev_1', ?)",
            )
            .bind(A, now)
            .run();
        await expect(
            db()
                .prepare("INSERT INTO mcp_writes (id, email, tool, request_key, status, created_at) VALUES ('mcw_2', ?, 't', 'req-12345678', 'pending', ?)")
                .bind(A, now)
                .run(),
        ).rejects.toThrow(/UNIQUE/);
    });
});

describe("access to Calendar", () => {
    it("is for owners and admins; wedding editors can't open it", async () => {
        await apiCall("POST", "/api/portal/users", { email: EDITOR, role: "editor" });
        expect((await cal("GET", "/calendars", undefined, EDITOR)).status).toBe(403);
        expect((await apiCall("GET", "/portal/calendar", undefined, { email: EDITOR })).status).toBe(403);
        expect((await cal("GET", "/calendars")).status).toBe(200);
        // The launcher offers it to an owner, with the compact cards.
        const home = await rawCall("/portal", { token: await accessToken({ email: A }) });
        expect(await home.text()).toContain('"calendar"');
    });

    it("gives each person exactly one default calendar, even on simultaneous first visits", async () => {
        await Promise.all([cal("GET", "/calendars"), cal("GET", "/calendars"), cal("GET", "/shell")]);
        expect((await db().prepare("SELECT COUNT(*) AS n FROM calendars WHERE owner_email = ? AND is_default = 1").bind(A).first<{ n: number }>())!.n).toBe(1);
    });

    it("refuses cross-site writes", async () => {
        const response = await rawCall(`${C}/events`, {
            method: "POST",
            token: await accessToken({ email: A }),
            headers: { Origin: "https://evil.example", "Content-Type": "application/json" },
            body: JSON.stringify({ title: "Injected", allDay: true, startDate: "2026-10-20", endDate: "2026-10-20" }),
        });
        expect(response.status).toBe(403);
    });
});

describe("privacy and household sharing", () => {
    it("keeps a personal calendar private, even from the other portal owner", async () => {
        const e = await event({ title: "Dentist", allDay: false, startDate: "2026-10-20", startTime: "09:00", endDate: "2026-10-20", endTime: "10:00" });
        expect((await window("2026-10-19", "2026-10-25", B)).length).toBe(0);
        expect((await cal("GET", `/events/${e.id}`, undefined, B)).status).toBe(404);
        expect((await cal("PATCH", `/events/${e.id}`, { version: e.version, title: "Hacked" }, B)).status).toBe(404);
        expect((await cal("GET", `/calendars/${e.calendarId}/members`, undefined, B)).status).toBe(404);
        // Free/busy sharing shows only that the time is busy.
        await ok("POST", `/calendars/${e.calendarId}/members`, { email: B, role: "freebusy" });
        const seen = await window("2026-10-19", "2026-10-25", B);
        expect(seen).toEqual([expect.objectContaining({ title: "Busy", busyOnly: true, location: null, readOnly: true })]);
        expect((await cal("GET", `/events/${e.id}`, undefined, B)).status).toBe(404);
        // A personal calendar can't be given a viewer.
        expect((await cal("POST", `/calendars/${e.calendarId}/members`, { email: B, role: "viewer" })).status).toBe(422);
    });

    it("shares a household calendar by role, and keeps private and sensitive events to their creator", async () => {
        const home = await shared();
        await ok("POST", `/calendars/${home.id}/members`, { email: B, role: "editor" });
        await event({
            calendarId: home.id,
            title: "School concert",
            allDay: false,
            startDate: "2026-10-22",
            startTime: "18:00",
            endDate: "2026-10-22",
            endTime: "19:30",
            location: "School hall",
        });
        const secret = await event({
            calendarId: home.id,
            title: "Surprise party planning",
            visibility: "private",
            allDay: true,
            startDate: "2026-10-23",
            endDate: "2026-10-23",
        });
        await event({
            calendarId: home.id,
            title: "Custody handover",
            category: "care",
            visibility: "sensitive",
            people: { who: ["Sam"], responsible: A },
            allDay: false,
            startDate: "2026-10-24",
            startTime: "10:00",
            endDate: "2026-10-24",
            endTime: "10:30",
        });
        const theirs = await window("2026-10-19", "2026-10-25", B);
        expect(theirs.map((o) => [o.title, o.busyOnly])).toEqual([
            ["Busy", true],
            ["School concert", false],
            ["Busy", true],
        ]);
        expect(theirs.find((o) => o.title === "School concert")).toMatchObject({ location: "School hall", readOnly: false });
        expect((await cal("GET", `/events/${secret.id}`, undefined, B)).status).toBe(404);
        // B can add to the shared calendar as an editor; demoted to viewer, B can't.
        await event({ calendarId: home.id, title: "Swimming", allDay: true, startDate: "2026-10-21", endDate: "2026-10-21" }, B);
        await ok("POST", `/calendars/${home.id}/members`, { email: B, role: "viewer" });
        expect(
            (await cal("POST", "/events", { calendarId: home.id, title: "Nope", allDay: true, startDate: "2026-10-21", endDate: "2026-10-21" }, B)).status,
        ).toBe(403);
        // Search never finds someone else's private events.
        expect((await ok<{ occurrences: EventOccurrence[] }>("GET", "/events/search?q=surprise", undefined, B)).occurrences).toEqual([]);
        expect((await ok<{ occurrences: EventOccurrence[] }>("GET", "/events/search?q=surprise")).occurrences).toHaveLength(1);
        // Removing B takes effect at once.
        await ok("DELETE", `/calendars/${home.id}/members/${encodeURIComponent(B)}`);
        expect(await window("2026-10-19", "2026-10-25", B)).toEqual([]);
    });

    it("lets each person hide a calendar and choose its colour for themselves only", async () => {
        const home = await shared();
        await ok("POST", `/calendars/${home.id}/members`, { email: B, role: "viewer" });
        await event({ calendarId: home.id, title: "Footy", allDay: true, startDate: "2026-10-24", endDate: "2026-10-24" });
        await ok("PATCH", `/calendars/${home.id}/me`, { hidden: true, color: "pink" }, B);
        expect(await window("2026-10-19", "2026-10-25", B)).toEqual([]);
        const forA = await window("2026-10-19", "2026-10-25");
        expect(forA).toHaveLength(1);
        expect(forA[0].color).toBe((await calendars()).find((c) => c.id === home.id)!.color);
        expect(forA[0].color).not.toBe("pink");
    });
});

describe("repeating events", () => {
    const weekly = {
        title: "Swimming",
        allDay: false,
        startDate: "2026-10-05",
        startTime: "17:00",
        endDate: "2026-10-05",
        endTime: "18:00",
        repeat: { freq: "weekly" },
    };

    it("changes one occurrence, this and the following ones, or the whole series", async () => {
        const e = await event(weekly);
        expect(e.repeatLabel).toBe("Every week on Monday");
        // One occurrence moves to Tuesday.
        const moved = await ok<{ event: EventDetail }>("PATCH", `/events/${e.id}`, {
            version: e.version,
            scope: "occurrence",
            occurrenceKey: "2026-10-12T17:00",
            startDate: "2026-10-13",
            endDate: "2026-10-13",
        });
        let week = await window("2026-10-12", "2026-10-18");
        expect(week.map((o) => [o.startDate, o.startTime, o.overridden])).toEqual([["2026-10-13", "17:00", true]]);
        // From 26 October it's at 4 pm: the series is split there.
        const split = await ok<{ event: EventDetail }>("PATCH", `/events/${e.id}`, {
            version: moved.event.version,
            scope: "following",
            occurrenceKey: "2026-10-26T17:00",
            startTime: "16:00",
            endTime: "17:00",
        });
        expect(split.event.id).not.toBe(e.id);
        week = await window("2026-10-19", "2026-11-01");
        expect(week.map((o) => [o.startDate, o.startTime])).toEqual([
            ["2026-10-19", "17:00"],
            ["2026-10-26", "16:00"],
        ]);
        // An occurrence that isn't in the series is refused.
        expect(
            (
                await cal("PATCH", `/events/${split.event.id}`, {
                    version: split.event.version,
                    scope: "occurrence",
                    occurrenceKey: "2026-10-27T16:00",
                    title: "x",
                })
            ).status,
        ).toBe(422);
        // Remove one occurrence, then restore it.
        await ok("DELETE", `/events/${split.event.id}?scope=occurrence&key=2026-11-02T16:00`);
        expect((await window("2026-11-02", "2026-11-02")).length).toBe(0);
        await ok("POST", `/events/${split.event.id}/restore`, { key: "2026-11-02T16:00" });
        expect((await window("2026-11-02", "2026-11-02")).length).toBe(1);
        // The whole of the first series.
        const original = (await ok<{ event: EventDetail }>("GET", `/events/${e.id}`)).event;
        await ok("PATCH", `/events/${e.id}`, { version: original.version, title: "Swim squad" });
        expect((await window("2026-10-05", "2026-10-05"))[0].title).toBe("Swim squad");
    });

    it("refuses an edit based on an old version", async () => {
        const e = await event(weekly);
        await ok("PATCH", `/events/${e.id}`, { version: e.version, title: "First" });
        const stale = await cal<{ error: string; current: EventDetail }>("PATCH", `/events/${e.id}`, { version: e.version, title: "Second" });
        expect(stale.status).toBe(409);
        expect(stale.json.current.title).toBe("First");
    });

    it("shows timed events in the viewer's own time zone", async () => {
        await event({ ...weekly, repeat: null, timeZone: "Australia/Perth", startTime: "09:00", endTime: "10:00" });
        const [o] = await window("2026-10-05", "2026-10-05");
        // 9 am in Perth (+8) is noon in Sydney (+11 after 4 October).
        expect(o).toMatchObject({ startTime: "12:00", endTime: "13:00", eventTimeZone: "Australia/Perth" });
    });

    it("validates times and keeps a retried create to one event", async () => {
        expect((await cal("POST", "/events", { ...weekly, endTime: "16:00" })).status).toBe(422);
        expect((await cal("POST", "/events", { ...weekly, url: "javascript:alert(1)" })).status).toBe(422);
        const first = await cal<{ event: EventDetail; replayed: boolean }>("POST", "/events", { ...weekly, clientId: "retry-12345678" });
        const second = await cal<{ event: EventDetail; replayed: boolean }>("POST", "/events", { ...weekly, clientId: "retry-12345678" });
        expect(second.json.replayed).toBe(true);
        expect(second.json.event.id).toBe(first.json.event.id);
    });
});

describe("Tasks and Knowledge (retired)", () => {
    it("shows no task overlays or event links, and refuses the retired task and link routes", async () => {
        const e = await event({
            title: "Parent-teacher night",
            allDay: false,
            startDate: "2026-10-22",
            startTime: "18:00",
            endDate: "2026-10-22",
            endTime: "19:00",
        });
        const overlays = (await ok<{ overlays: Record<string, unknown> }>("GET", "/overlays?from=2026-10-19&to=2026-10-31")).overlays;
        expect(overlays).not.toHaveProperty("tasks");
        expect((await ok<{ event: EventDetail }>("GET", `/events/${e.id}`)).event).not.toHaveProperty("links");
        for (const [method, path] of [
            ["POST", `/events/${e.id}/task`],
            ["POST", `/events/${e.id}/links`],
            ["DELETE", `/events/${e.id}/links/cel_aaaaaaaaaaaaaa`],
        ] as const) {
            const r = await cal<{ error: string }>(method, path, method === "DELETE" ? undefined : { kind: "task", targetId: "tsk_aaaaaaaaaaaaaa" });
            expect(r.status, `${method} ${path}`).toBe(410);
            expect(r.json.error).toBe("retired");
        }
        // Preferences saved with the retired task overlay still load, and save without it.
        const prefs = (await ok<{ preferences: Record<string, unknown> & { overlays: Record<string, boolean> } }>("GET", "/preferences")).preferences;
        expect(prefs.overlays).not.toHaveProperty("tasks");
        expect((await cal("PUT", "/preferences", { preferences: { ...prefs, overlays: { ...prefs.overlays, tasks: true } } })).status).toBeLessThan(300);
        expect((await ok<{ preferences: { overlays: Record<string, boolean> } }>("GET", "/preferences")).preferences.overlays).not.toHaveProperty("tasks");
    });
});

// --- Subscriptions -------------------------------------------------------------------------------

const FEED = "https://calendar.example.com/school/term.ics";
const feed = (...events: string[]) =>
    ["BEGIN:VCALENDAR", "VERSION:2.0", "X-WR-CALNAME:Riverside Public School", "X-WR-TIMEZONE:Australia/Sydney", ...events, "END:VCALENDAR"].join("\r\n");
const vevent = (uid: string, date: string, summary: string, extra: string[] = []) =>
    ["BEGIN:VEVENT", `UID:${uid}`, `DTSTART;VALUE=DATE:${date.replaceAll("-", "")}`, `SUMMARY:${summary}`, ...extra, "END:VEVENT"].join("\r\n");

/** fetch for DNS over HTTPS and one feed address, answering from `serve`. */
function stubNetwork(serve: (request: Request) => Response | Promise<Response>, dns: (host: string) => string[] = () => ["93.184.216.34"]) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input as RequestInfo, init);
        const url = new URL(request.url);
        if (url.hostname === "cloudflare-dns.com") {
            const host = url.searchParams.get("name")!;
            const type = url.searchParams.get("type");
            const answers = dns(host).filter((ip) => (type === "A") === !ip.includes(":"));
            return Response.json({ Status: 0, Answer: answers.map((data) => ({ type: type === "A" ? 1 : 28, data })) });
        }
        return serve(request);
    });
}

describe("external subscriptions", () => {
    it("adds a feed, keeps events in step by UID, honours cancellations, and never shows the address", async () => {
        let body = feed(
            vevent("sdd-1", "2026-10-12", "School development day"),
            vevent("fete-1", "2026-11-14", "School fete"),
            vevent("exc-1", "2026-11-20", "Excursion"),
        );
        let etag = '"v1"';
        const network = stubNetwork((r) =>
            r.headers.get("If-None-Match") === etag
                ? new Response(null, { status: 304 })
                : new Response(body, { headers: { "Content-Type": "text/calendar", ETag: etag } }),
        );
        const { subscription } = await ok<{ subscription: SubscriptionInfo }>("POST", "/subscriptions", {
            url: FEED.replace("https://", "webcal://"),
            kind: "shared",
        });
        expect(subscription).toMatchObject({
            name: "Riverside Public School",
            eventCount: 3,
            lastStatus: "ok",
            urlDisplay: "calendar.example.com/…",
            canManage: true,
        });
        expect(JSON.stringify(await ok("GET", "/subscriptions"))).not.toContain("term.ics");
        expect((await db().prepare("SELECT url_secret FROM calendar_subscriptions").first<{ url_secret: string }>())!.url_secret).toBe(`plain:${FEED}`);
        const fete = (await window("2026-11-14", "2026-11-14"))[0];
        expect(fete).toMatchObject({ title: "School fete", readOnly: true, source: "subscription" });
        // Read-only.
        expect((await cal("PATCH", `/events/${fete.eventId}`, { version: 1, title: "x" })).status).toBe(422);
        // The same address again is refused as a duplicate.
        expect((await cal("POST", "/subscriptions", { url: FEED })).status).toBe(409);

        // Unchanged: a 304, nothing rewritten.
        await db().prepare("UPDATE calendar_subscriptions SET next_refresh_at = '2000-01-01T00:00:00.000Z'").run();
        await processDueSubscriptions(await portalEnv());
        expect((await ok<{ subscriptions: SubscriptionInfo[] }>("GET", "/subscriptions")).subscriptions[0].lastStatus).toBe("not_modified");

        // Changed: the fete moves (same UID, same id), the excursion is cancelled, a new event arrives.
        body = feed(
            vevent("sdd-1", "2026-10-12", "School development day"),
            vevent("fete-1", "2026-11-21", "School fete (new date)"),
            vevent("exc-1", "2026-11-20", "Excursion", ["STATUS:CANCELLED"]),
            vevent("disco-1", "2026-12-04", "Disco"),
        );
        etag = '"v2"';
        await db().prepare("UPDATE calendar_subscriptions SET next_refresh_at = '2000-01-01T00:00:00.000Z'").run();
        await processDueSubscriptions(await portalEnv());
        const after = await window("2026-11-01", "2026-12-31");
        expect(after.map((o) => [o.title, o.startDate])).toEqual([
            ["School fete (new date)", "2026-11-21"],
            ["Disco", "2026-12-04"],
        ]);
        expect(after[0].eventId).toBe(fete.eventId);
        expect(network.mock.calls.every(([input]) => !String(input instanceof Request ? input.url : input).startsWith("http:"))).toBe(true);
    });

    it("refuses addresses that can't work before saving anything, and private networks after DNS", async () => {
        stubNetwork(() => new Response("<html>Sign in</html>", { headers: { "Content-Type": "text/html" } }));
        expect((await cal("POST", "/subscriptions", { url: FEED })).json).toMatchObject({ error: "not_calendar" });
        expect((await cal("POST", "/subscriptions", { url: "http://calendar.example.com/x.ics" })).json).toMatchObject({ error: "insecure" });
        expect((await cal("POST", "/subscriptions", { url: "https://10.0.0.1/x.ics" })).json).toMatchObject({ error: "private_address" });
        vi.restoreAllMocks();
        stubNetwork(
            () => new Response(feed()),
            () => ["192.168.1.20"],
        );
        expect((await cal("POST", "/subscriptions", { url: FEED })).json).toMatchObject({ error: "private_address" });
        expect((await db().prepare("SELECT COUNT(*) AS n FROM calendar_subscriptions").first<{ n: number }>())!.n).toBe(0);
    });

    it("backs off after failures, notifies the owner after three, and keeps events when a feed suddenly comes back empty", async () => {
        let mode: "ok" | "fail" | "empty" = "ok";
        stubNetwork(() =>
            mode === "fail"
                ? new Response("", { status: 503 })
                : new Response(mode === "empty" ? feed() : feed(vevent("a", "2026-11-02", "Assembly")), { headers: { "Content-Type": "text/calendar" } }),
        );
        const { subscription } = await ok<{ subscription: SubscriptionInfo }>("POST", "/subscriptions", { url: FEED });
        mode = "fail";
        for (let i = 0; i < 3; i++) {
            await db().prepare("UPDATE calendar_subscriptions SET next_refresh_at = '2000-01-01T00:00:00.000Z', lease_until = NULL").run();
            await processDueSubscriptions(await portalEnv());
        }
        const failing = (await ok<{ subscriptions: SubscriptionInfo[] }>("GET", "/subscriptions")).subscriptions[0];
        expect(failing).toMatchObject({ consecutiveFailures: 3, lastErrorCode: "http_503", eventCount: 1 });
        expect(Date.parse(failing.nextRefreshAt) - Date.now()).toBeGreaterThan(50 * 60_000);
        expect((await ok<{ failingSubscriptions: number }>("GET", "/shell")).failingSubscriptions).toBe(1);
        const notes = await db().prepare("SELECT kind, title FROM calendar_notifications WHERE email = ?").bind(A).all<{ kind: string; title: string }>();
        expect(notes.results).toEqual([{ kind: "subscription", title: `A calendar subscription is failing: ${subscription.name}` }]);
        // Empty once: kept. Empty twice: believed.
        mode = "empty";
        await db().prepare("UPDATE calendar_subscriptions SET next_refresh_at = '2000-01-01T00:00:00.000Z', lease_until = NULL").run();
        await processDueSubscriptions(await portalEnv());
        expect((await window("2026-11-02", "2026-11-02")).length).toBe(1);
        await db().prepare("UPDATE calendar_subscriptions SET next_refresh_at = '2000-01-01T00:00:00.000Z', lease_until = NULL").run();
        await processDueSubscriptions(await portalEnv());
        expect((await window("2026-11-02", "2026-11-02")).length).toBe(0);
        // A manual refresh straight after is refused (once a minute).
        expect((await cal("POST", `/subscriptions/${subscription.id}/refresh`, {})).status).toBe(429);
    });

    it("encrypts addresses when the key is configured", async () => {
        stubNetwork(() => new Response(feed(vevent("a", "2026-11-02", "Assembly"))));
        const env = await portalEnv({ CALENDAR_ENCRYPTION_KEY: "test-calendar-key-that-is-at-least-32-characters" });
        const r = await apiCall<{ subscription: SubscriptionInfo }>("POST", `${C}/subscriptions`, { url: FEED }, { env });
        expect(r.status, r.text).toBe(201);
        const stored = (await db().prepare("SELECT url_secret FROM calendar_subscriptions").first<{ url_secret: string }>())!.url_secret;
        expect(stored.startsWith("v1:")).toBe(true);
        expect(stored).not.toContain("example.com");
    });
});

// --- Outbound feeds ------------------------------------------------------------------------------

describe("private ICS feeds", () => {
    const token = (address: string) => /\/calendar\/feed\/([^.]+)\.ics$/.exec(address)![1];
    const getFeed = (t: string) => rawCall(`/calendar/feed/${t}.ics`, { token: null });

    it("answers 404 until switched on, then publishes only what the owner can see, with private details withheld", async () => {
        const mine = await defaultCalendar();
        await event({ calendarId: mine.id, title: "Team offsite", allDay: true, startDate: "2026-11-05", endDate: "2026-11-06", location: "Blue Mountains" });
        await event({
            calendarId: mine.id,
            title: "Therapy",
            visibility: "sensitive",
            allDay: false,
            startDate: "2026-11-03",
            startTime: "15:00",
            endDate: "2026-11-03",
            endTime: "16:00",
        });
        const created = await ok<{ address: string; feed: { id: string } }>("POST", "/feeds", {
            name: "Work calendar",
            scope: { calendarIds: [mine.id], leave: false, detail: "full" },
        });
        expect(created.address).toMatch(/^https:\/\/daly\.id\.au\/calendar\/feed\/[A-Za-z0-9_-]{43}\.ics$/);
        const t = token(created.address);
        expect((await getFeed(t)).status).toBe(404);
        await apiCall("PUT", "/api/portal/flags/calendar.feeds", { enabled: true });
        const response = await getFeed(t);
        expect(response.status).toBe(200);
        expect(response.headers.get("Content-Type")).toContain("text/calendar");
        expect(response.headers.get("X-Robots-Tag")).toContain("noindex");
        const text = await response.text();
        expect(text).toContain("SUMMARY:Team offsite");
        expect(text).toContain("LOCATION:Blue Mountains");
        expect(text).not.toContain("Therapy");
        expect(text).toMatch(/SUMMARY:Busy[\s\S]*CLASS:PRIVATE/);
        // Only a hash of the token is stored.
        expect(JSON.stringify(await db().prepare("SELECT * FROM calendar_feeds").all())).not.toContain(t);
        // Rotate: the old address stops, the new one works. Revoke: gone.
        const rotated = await ok<{ address: string }>("POST", `/feeds/${created.feed.id}/rotate`, {});
        expect((await getFeed(t)).status).toBe(404);
        expect((await getFeed(token(rotated.address))).status).toBe(200);
        await ok("DELETE", `/feeds/${created.feed.id}`);
        expect((await getFeed(token(rotated.address))).status).toBe(404);
        expect((await getFeed("x".repeat(43))).status).toBe(404);
    });

    it("leaves out calendars the owner has since lost, and can publish busy times only", async () => {
        await apiCall("PUT", "/api/portal/flags/calendar.feeds", { enabled: true });
        const theirs = await shared("B's family");
        await ok("POST", `/calendars/${theirs.id}/members`, { email: B, role: "owner" });
        await event({ calendarId: theirs.id, title: "Grandma visiting", allDay: true, startDate: "2026-11-10", endDate: "2026-11-10" });
        const { address } = await ok<{ address: string }>(
            "POST",
            "/feeds",
            { name: "Shared", scope: { calendarIds: [theirs.id], leave: false, detail: "busy" } },
            B,
        );
        const text = await (await getFeed(token(address))).text();
        expect(text).toContain("SUMMARY:Busy");
        expect(text).not.toContain("Grandma");
        await ok("DELETE", `/calendars/${theirs.id}/members/${encodeURIComponent(B)}`);
        expect(await (await getFeed(token(address))).text()).not.toContain("BEGIN:VEVENT");
        // Subscribed calendars can't be republished.
        stubNetwork(() => new Response(feed(vevent("a", "2026-11-02", "Assembly"))));
        const { subscription } = await ok<{ subscription: SubscriptionInfo }>("POST", "/subscriptions", { url: FEED });
        expect((await cal("POST", "/feeds", { name: "x", scope: { calendarIds: [subscription.calendarId], leave: false, detail: "full" } })).status).toBe(422);
    });
});

// --- Leave ---------------------------------------------------------------------------------------

describe("leave", () => {
    const setup = async (email = A) =>
        (
            await ok<{ leave: LeaveData }>(
                "POST",
                "/leave/setup",
                { pattern: { kind: "weekly", hours: [7.6, 7.6, 7.6, 7.6, 7.6, 0, 0] }, balanceDate: "2026-09-30", annualHours: 120, personalHours: 60 },
                email,
            )
        ).leave;

    it("is the person's own, works in hours, and never reaches anyone else", async () => {
        const leave = await setup();
        const annual = leave.types.find((t) => t.kind === "annual")!;
        const { booking } = await ok<{ booking: { id: string; version: number } }>("POST", "/leave/bookings", {
            leaveTypeId: annual.id,
            startDate: "2026-10-05",
            endDate: "2026-10-09",
            status: "approved",
        });
        const forecast = await ok<{ balances: { type: { id: string }; asOf: { deductions: { hours: number }[]; closing: number } }[] }>(
            "GET",
            "/leave/forecast?date=2026-10-31&mode=confirmed",
        );
        const a = forecast.balances.find((b) => b.type.id === annual.id)!;
        // Labour Day (5 Oct) isn't deducted.
        expect(a.asOf.deductions.map((d) => d.hours)).toEqual([30.4]);
        expect((await ok<{ leave: LeaveData }>("GET", "/leave", undefined, B)).leave.types).toEqual([]);
        expect((await cal("PATCH", `/leave/bookings/${booking.id}`, { version: booking.version, status: "taken" }, B)).status).toBe(404);
        expect((await cal("POST", "/leave/bookings", { leaveTypeId: annual.id, startDate: "2026-10-05", endDate: "2026-10-05" }, B)).status).toBe(422);
    });

    it("shares dates (never balances) only with the people chosen, for planning time off together", async () => {
        await setup();
        const theirs = await setup(B);
        await ok(
            "POST",
            "/leave/bookings",
            { leaveTypeId: theirs.types[0].id, startDate: "2026-12-21", endDate: "2026-12-24", status: "approved", note: "Private note" },
            B,
        );
        expect((await ok<{ leave: LeaveData }>("GET", "/leave")).leave.sharedWithMe).toEqual([]);
        await ok("POST", "/leave/shares", { email: A }, B);
        const shared = (await ok<{ leave: LeaveData }>("GET", "/leave")).leave.sharedWithMe;
        expect(shared[0].bookings).toEqual([expect.objectContaining({ startDate: "2026-12-21", status: "approved" })]);
        expect(JSON.stringify(shared)).not.toMatch(/Private note|balanceHours|120/);
        const plan = await ok<{ answer: { available: boolean; breaks: unknown[] } }>("POST", "/leave/plan", {
            question: "joint",
            with: B,
            budgetHours: 38,
            from: "2026-12-14",
            to: "2027-01-10",
        });
        expect(plan.answer.available).toBe(true);
        expect(plan.answer.breaks.length).toBeGreaterThan(0);
    });

    it("answers planning questions deterministically", async () => {
        await setup();
        const july = await ok<{ answer: { leaveHours: number; withWeekendsAround: { daysOff: number } } }>("POST", "/leave/plan", {
            question: "cover_period",
            start: "2026-07-06",
            end: "2026-07-17",
        });
        expect(july.answer.leaveHours).toBe(76);
        expect(july.answer.withWeekendsAround.daysOff).toBe(16);
        const longest = await ok<{ answer: { best: { leaveHours: number; daysOff: number } } }>("POST", "/leave/plan", {
            question: "longest_break",
            budgetHours: 35,
            from: "2026-11-01",
            to: "2026-11-30",
        });
        expect(longest.answer.best.leaveHours).toBeLessThanOrEqual(35);
        // 35 hours is four 7.6-hour days: with a weekend, six days off (November 2026 has no public holidays).
        expect(longest.answer.best.daysOff).toBe(6);
    });

    it("exports CSV, Excel and PDF, each as a private download", async () => {
        const leave = await setup();
        await ok("POST", "/leave/bookings", {
            leaveTypeId: leave.types[0].id,
            startDate: "2026-12-21",
            endDate: "2026-12-24",
            status: "approved",
            title: '=HYPERLINK("x")',
        });
        const csv = await rawCall(`${C}/leave/export.csv`, { token: await accessToken({ email: A }) });
        const text = await csv.text();
        expect(csv.headers.get("Cache-Control")).toBe("private, no-store");
        expect(text).toContain("'=HYPERLINK");
        const xlsx = await rawCall(`${C}/leave/export.xlsx?year=2026`, { token: await accessToken({ email: A }) });
        const bytes = new Uint8Array(await xlsx.arrayBuffer());
        expect([bytes[0], bytes[1]]).toEqual([0x50, 0x4b]);
        const pdf = await rawCall(`${C}/leave/export.pdf?year=2026`, { token: await accessToken({ email: A }) });
        expect(new TextDecoder().decode((await pdf.arrayBuffer()).slice(0, 5))).toBe("%PDF-");
    });
});

// --- MCP -----------------------------------------------------------------------------------------

describe("MCP Calendar and Leave tools", () => {
    it("reads agendas without exposing sensitive or other people's private details", async () => {
        const home = await shared();
        await ok("POST", `/calendars/${home.id}/members`, { email: B, role: "viewer" });
        const today = localDate(new Date(), "Australia/Sydney");
        await event({
            calendarId: home.id,
            title: "Custody handover",
            category: "care",
            visibility: "sensitive",
            allDay: true,
            startDate: today,
            endDate: today,
        });
        await event({ calendarId: home.id, title: "Bins out", allDay: true, startDate: today, endDate: today });
        const mine = await mcp<{ days: { events: { title: string; detailsWithheld: boolean }[] }[] }>("calendar_get_agenda", { days: 1 });
        expect(mine.ok).toBe(true);
        expect(mine.data.days[0].events.map((e) => e.title).sort()).toEqual(["Bins out", "Private event"]);
        const theirs = await mcp<{ days: { events: { title: string }[] }[] }>("calendar_get_agenda", { days: 1 }, B);
        expect(theirs.data.days[0].events.map((e) => e.title).sort()).toEqual(["Bins out", "Busy"]);
    });

    it("creates leave proposals but never approves, and replays a retried write", async () => {
        const leave = (
            await ok<{ leave: LeaveData }>("POST", "/leave/setup", {
                pattern: { kind: "weekly", hours: [7.6, 7.6, 7.6, 7.6, 7.6, 0, 0] },
                balanceDate: "2026-09-30",
                annualHours: 120,
                personalHours: null,
            })
        ).leave;
        const annual = leave.types[0];
        const refused = await mcp("leave_create_proposal", {
            leaveTypeId: annual.id,
            startDate: "2027-01-04",
            endDate: "2027-01-08",
            status: "approved",
            requestId: "leave-12345678",
        });
        expect(refused.ok).toBe(false);
        const created = await mcp<{ booking: { id: string; status: string; version: number }; projectedBalanceAfter: { hours: number } }>(
            "leave_create_proposal",
            {
                leaveTypeId: annual.id,
                startDate: "2027-01-04",
                endDate: "2027-01-08",
                requestId: "leave-23456789",
            },
        );
        expect(created.ok, JSON.stringify(created)).toBe(true);
        expect(created.data.booking.status).toBe("proposed");
        const again = await mcp<{ booking: { id: string } }>("leave_create_proposal", {
            leaveTypeId: annual.id,
            startDate: "2027-01-04",
            endDate: "2027-01-08",
            requestId: "leave-23456789",
        });
        expect(JSON.stringify(again)).toContain(created.data.booking.id);
        expect((await db().prepare("SELECT COUNT(*) AS n FROM leave_bookings").first<{ n: number }>())!.n).toBe(1);
        // Once the person marks it approved in the portal, MCP can't change it.
        await ok("PATCH", `/leave/bookings/${created.data.booking.id}`, { version: created.data.booking.version, status: "approved" });
        const locked = await mcp("leave_update_proposal", {
            bookingId: created.data.booking.id,
            version: created.data.booking.version + 1,
            title: "Changed",
            requestId: "leave-34567890",
        });
        expect(locked.ok).toBe(false);
        // The ledger records ids only.
        const ledger = await db().prepare("SELECT tool, entity_type, entity_id FROM mcp_writes WHERE status = 'done'").all();
        expect(ledger.results).toEqual([{ tool: "leave_create_proposal", entity_type: "leave_booking", entity_id: created.data.booking.id }]);
        const balances = await mcp<{ balances: { name: string; atDate: { hours: number } }[] }>("leave_get_balances", { asOf: "2027-01-31" });
        expect(balances.data.balances[0].name).toBe("Annual leave");
    });

    it("never returns a subscription address, and creates events only where the caller can", async () => {
        stubNetwork(() => new Response(feed(vevent("a", "2026-11-02", "Assembly"))));
        const sub = await mcp("calendar_create_subscription", { url: FEED, requestId: "subs-12345678" });
        expect(sub.ok, JSON.stringify(sub)).toBe(true);
        expect(JSON.stringify(sub)).not.toContain("term.ics");
        expect(JSON.stringify(await mcp("calendar_list_subscriptions", {}))).not.toContain("term.ics");
        const mine = await defaultCalendar();
        expect(
            (await mcp("calendar_create_event", { calendarId: mine.id, title: "x", startDate: "2026-11-02", allDay: true, requestId: "evnt-12345678" }, B)).ok,
        ).toBe(false);
        const created = await mcp<{ event: { id: string; calendarId: string } }>("calendar_create_event", {
            title: "Dentist",
            startDate: "2026-11-03",
            startTime: "09:00",
            endTime: "09:30",
            requestId: "evnt-23456789",
        });
        expect(created.ok, JSON.stringify(created)).toBe(true);
        expect(created.data.event.calendarId).toBe(mine.id);
    });
});

// --- Notifications and backup --------------------------------------------------------------------

describe("notifications", () => {
    it("creates each reminder once however often the cron runs, hiding private titles", async () => {
        const soon = new Date(Date.now() + 10 * 60_000);
        const wall = new Intl.DateTimeFormat("en-CA", {
            timeZone: "Australia/Sydney",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            hourCycle: "h23",
        }).formatToParts(soon);
        const get = (t: string) => wall.find((p) => p.type === t)!.value;
        const date = `${get("year")}-${get("month")}-${get("day")}`;
        const time = `${get("hour")}:${get("minute")}`;
        const end = new Date(soon.getTime() + 30 * 60_000);
        const endWall = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(end);
        const endDate = localDate(end, "Australia/Sydney");
        await event({ title: "Call the bank", allDay: false, startDate: date, startTime: time, endDate, endTime: endWall, reminders: [10] });
        await event({ title: "Secret", visibility: "private", allDay: false, startDate: date, startTime: time, endDate, endTime: endWall, reminders: [10] });
        const env = await portalEnv();
        await processCalendarNotifications(env, { provider: null });
        await processCalendarNotifications(env, { provider: null });
        const rows = await db()
            .prepare("SELECT title FROM calendar_notifications WHERE email = ? AND kind = 'event' ORDER BY title")
            .bind(A)
            .all<{ title: string }>();
        expect(rows.results.map((r) => r.title)).toEqual(["Call the bank", "Private event"]);
    });
});

describe("backup and restore", () => {
    it("round-trips calendars, events and leave, without any subscription or feed address", async () => {
        await event({
            title: "Anniversary dinner",
            category: "anniversary",
            allDay: true,
            startDate: "2026-11-20",
            endDate: "2026-11-20",
            repeat: { freq: "yearly" },
        });
        await ok("POST", "/leave/setup", {
            pattern: { kind: "weekly", hours: [7.6, 7.6, 7.6, 7.6, 7.6, 0, 0] },
            balanceDate: "2026-09-30",
            annualHours: 120,
            personalHours: null,
        });
        const response = await rawCall(`${C}/backup`, { token: await accessToken({ email: A }) });
        const backup = (await response.json()) as { format: string; events: unknown[]; leave: { types: unknown[] } };
        expect(backup.format).toBe("daly-calendar-backup");
        const preview = await ok<{ result: { dryRun: boolean; events: number } }>("POST", "/restore", { backup, dryRun: true }, B);
        expect(preview.result).toMatchObject({ dryRun: true, events: 1 });
        await ok("POST", "/restore", { backup, dryRun: false }, B);
        const restored = await window("2027-11-20", "2027-11-20", B);
        expect(restored.map((o) => o.title)).toEqual(["Anniversary dinner"]);
        expect((await ok<{ leave: LeaveData }>("GET", "/leave", undefined, B)).leave.types.map((t) => t.balanceHours)).toEqual([120]);
    });
});
