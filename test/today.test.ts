// Today (/portal/today, migration 0024, docs/DAILY_PLANNER.md#today) through the Worker, after Daly
// Tasks was retired: access through Calendar alone, the dashboard's parts, privacy of shared and
// sensitive events, capacity with overlapping commitments, preferences (breaks, calendars left out
// of availability, documents saved before the retirement), planning hours, the Chief of Staff
// briefing's grounding, the retired Today routes, MCP and the pages. Every person and event is invented.
import { createElement } from "react";
import { renderToString } from "react-dom/server.edge";
import { beforeEach, describe, expect, it } from "vitest";
import { PortalApp } from "../src/portal/portal-app";
import { addDays, localDate } from "../src/shared/calendar/time";
import type { CalendarInfo, EventDetail } from "../src/shared/calendar/types";
import type { PortalPageData } from "../src/shared/portal/types";
import type { PlanningHours } from "../src/shared/today/availability";
import type { TodayDashboard, TodayPreferences } from "../src/shared/today/types";
import { type PortalMcpResponse, handleMcpCall } from "../worker/mcp/entrypoint";
import { OWNER, SECOND_OWNER, accessToken, apiCall, db, portalEnv, call as rawCall, resetPortal } from "./portal-helpers";

const A = OWNER;
const B = SECOND_OWNER;
const EDITOR = "wedding-editor@example.com";
const SYD = "Australia/Sydney";
const C = "/api/portal/calendar";
const T = "/api/portal/today";
const MCP_AUD = "aud-mcp-gateway-0123456789abcdef";

type Dash = Partial<TodayDashboard> & Pick<TodayDashboard, "date" | "today">;
const req = <R = unknown>(method: string, path: string, body?: unknown, email = A) => apiCall<R>(method, path, body, { email });
const ok = async <R = unknown>(method: string, path: string, body?: unknown, email = A) => {
    const r = await req<R>(method, path, body, email);
    expect(r.status, `${method} ${path}: ${r.text}`).toBeLessThan(300);
    return r.json;
};
const today = () => localDate(new Date(), SYD);
/** A week ahead: in the future, so "now" never cuts into the day, and the same weekday as today. */
const soon = (days = 7) => addDays(today(), days);
const dash = async (date: string, parts?: string, email = A) =>
    (await ok<{ today: Dash }>("GET", `${T}?date=${date}${parts ? `&parts=${parts}` : ""}`, undefined, email)).today;
const everyDay = (email = A) =>
    ok(
        "PUT",
        `${T}/hours`,
        { preferences: { workingHours: Array.from({ length: 7 }, () => ({ start: "09:00", end: "17:00" })), bufferMinutes: 0 }, version: 0 },
        email,
    );
const defaultCalendar = async (email = A) =>
    (await ok<{ calendars: CalendarInfo[] }>("GET", `${C}/calendars`, undefined, email)).calendars.find((c) => c.isDefault)!;
const event = async (body: Record<string, unknown>, email = A) => (await ok<{ event: EventDetail }>("POST", `${C}/events`, body, email)).event;
const timed = (calendarId: string, title: string, date: string, startTime: string, endTime: string, extra: Record<string, unknown> = {}) => ({
    calendarId,
    title,
    allDay: false,
    startDate: date,
    endDate: date,
    startTime,
    endTime,
    ...extra,
});
const savePrefs = async (change: Partial<TodayPreferences>, email = A) => {
    const current = await ok<{ preferences: TodayPreferences; version: number }>("GET", `${T}/preferences`, undefined, email);
    return ok<{ preferences: TodayPreferences; version: number }>(
        "PUT",
        `${T}/preferences`,
        { preferences: { ...current.preferences, ...change }, version: current.version },
        email,
    );
};
const mcp = async <D = Record<string, unknown>>(tool: string, input: unknown = {}, email = A) =>
    (await handleMcpCall(await portalEnv({ MCP_ACCESS_AUD: MCP_AUD }), {
        assertion: await accessToken({ email, aud: [MCP_AUD] }),
        tool,
        input,
    })) as PortalMcpResponse & { data: D };
const renderPage = (html: string) => {
    const json = /<script type="application\/json" id="page-data">([\s\S]*?)<\/script>/.exec(html)?.[1];
    const payload = JSON.parse(json!) as { data: PortalPageData; path: string };
    return { data: payload.data, html: renderToString(createElement(PortalApp, { data: payload.data, path: payload.path })) };
};
const ALL_WEEK = [1, 2, 3, 4, 5, 6, 7];
/** A real wedding editor (a portal user without Calendar), so refusals are about permissions, not sign-in. */
const addEditor = async () => expect((await apiCall("POST", "/api/portal/users", { email: EDITOR, role: "editor" })).status).toBeLessThan(300);

beforeEach(resetPortal);

describe("access", () => {
    it("needs Calendar: wedding editors are refused, and the page says so", async () => {
        await addEditor();
        expect((await req("GET", T, undefined, EDITOR)).status).toBe(403);
        expect((await req("GET", `${T}/preferences`, undefined, EDITOR)).status).toBe(403);
        expect((await req("PUT", `${T}/hours`, {}, EDITOR)).status).toBe(403);
        const page = await rawCall("/portal/today", { token: await accessToken({ email: EDITOR }) });
        expect(page.status).toBe(403);
        expect(renderPage(await page.text()).data.route).toBe("forbidden");
        expect((await req("GET", T)).status).toBe(200);
        // Bad parts and far-off dates are refused, not guessed; retired parts are bad parts.
        for (const parts of ["everything", "deadlines", "completed", "reviews"]) expect((await req("GET", `${T}?parts=${parts}`)).status).toBe(400);
        expect((await req("GET", `${T}?date=${addDays(today(), 800)}`)).status).toBe(400);
    });

    it("answers 410 for Plan My Day and the morning and evening reviews, and for the Daily Planner", async () => {
        for (const [method, path] of [
            ["POST", `${T}/plan`],
            ["POST", `${T}/plan/apply`],
            ["GET", `${T}/reviews/${today()}`],
            ["PUT", `${T}/reviews/${today()}/morning`],
            ["GET", `${C}/planner/day`],
            ["POST", `${C}/planner/blocks`],
            ["PUT", `${C}/planner/preferences`],
        ] as const) {
            const r = await req<{ error: string }>(method, path, method === "GET" ? undefined : {});
            expect(r.status, `${method} ${path}`).toBe(410);
            expect(r.json.error).toBe("retired");
        }
        const page = await rawCall("/portal/calendar/planner", { token: await accessToken() });
        expect(page.status).toBe(410);
    });
});

describe("the dashboard", () => {
    it("brings events, leave and capacity together, counting overlaps once", async () => {
        await everyDay();
        const date = soon();
        const cal = await defaultCalendar();
        await event(timed(cal.id, "Planning meeting", date, "10:00", "11:00"));
        await event(timed(cal.id, "Supplier call", date, "10:30", "11:30"));
        const d = await dash(date);
        expect(d.capacity).toMatchObject({ availableMinutes: 480, appointmentMinutes: 90, freeMinutes: 390 });
        expect(d.capacity!.overbooked.map((o) => [o.startTime, o.endTime])).toEqual([["10:30", "11:00"]]);
        const items = d.timeline!.items.map((i) => `${i.startTime} ${i.kind}${i.conflict ? "!" : ""}`);
        expect(items).toEqual(expect.arrayContaining(["10:00 event!", "10:30 event!"]));
        expect(d.preferences!.sections).toEqual(["briefing", "capacity", "timeline", "commitments", "notifications"]);
        expect(d.greeting).toMatch(/^Good (morning|afternoon|evening)$/);
        expect(d).not.toHaveProperty("lists");
        expect(d).not.toHaveProperty("deadlines");
    });

    it("loads only the parts asked for", async () => {
        const d = await dash(soon(), "notifications");
        expect(d.notifications).toEqual([]);
        expect(d.capacity).toBeUndefined();
        expect(d.briefing).toBeUndefined();
        const plan = await dash(soon(), "plan");
        expect(plan.capacity && plan.timeline).toBeTruthy();
        expect(plan.commitments).toBeUndefined();
    });

    it("keeps others' private events in shared calendars as Busy", async () => {
        await everyDay();
        const date = soon();
        const { calendar: household } = await ok<{ calendar: CalendarInfo }>("POST", `${C}/calendars`, {
            name: "Household",
            kind: "shared",
            purpose: "family",
        });
        await ok("POST", `${C}/calendars/${household.id}/members`, { email: B, role: "editor" });
        await event(timed(household.id, "B's specialist", date, "13:00", "14:00", { visibility: "private" }), B);
        await event(timed(household.id, "School pick-up", date, "15:00", "15:30"), B);
        const d = await dash(date, "plan,commitments,briefing");
        expect(JSON.stringify(d)).not.toContain("B's specialist");
        expect(d.timeline!.items.find((i) => i.startTime === "13:00")).toMatchObject({ title: "Busy", shared: true, readOnly: true });
        expect(d.commitments!.shared.map((c) => c.title)).toEqual(expect.arrayContaining(["Busy", "School pick-up"]));
    });

    it("lets the person leave a calendar out of availability, and only their own calendars", async () => {
        await everyDay();
        const date = soon();
        const { calendar: roster } = await ok<{ calendar: CalendarInfo }>("POST", `${C}/calendars`, {
            name: "Partner's roster",
            kind: "shared",
            purpose: "family",
        });
        await event(timed(roster.id, "Night shift", date, "09:00", "17:00"));
        expect((await dash(date, "plan")).capacity!.freeMinutes).toBe(0);
        await savePrefs({ excludedCalendarIds: [roster.id] });
        const d = await dash(date, "plan");
        expect(d.capacity!.freeMinutes).toBe(480);
        expect(d.timeline!.items.find((i) => i.title === "Night shift")).toMatchObject({ busy: false, detail: expect.stringContaining("Doesn't count") });
        const bCal = await defaultCalendar(B);
        const current = await ok<{ preferences: TodayPreferences; version: number }>("GET", `${T}/preferences`);
        const refused = await req("PUT", `${T}/preferences`, {
            preferences: { ...current.preferences, excludedCalendarIds: [bCal.id] },
            version: current.version,
        });
        expect(refused.status).toBe(422);
    });
});

describe("preferences and planning hours", () => {
    it("are per person, versioned and validated, and breaks come out of capacity", async () => {
        await everyDay();
        const date = soon();
        const saved = await savePrefs({ breaks: [{ label: "Lunch", days: ALL_WEEK, start: "12:00", end: "13:00" }], sections: ["timeline", "capacity"] });
        expect(saved.version).toBe(1);
        expect((await ok<{ preferences: TodayPreferences }>("GET", `${T}/preferences`, undefined, B)).preferences.breaks).toEqual([]);
        expect((await req("PUT", `${T}/preferences`, { preferences: saved.preferences, version: 0 })).status).toBe(409);
        const bad = await req("PUT", `${T}/preferences`, {
            preferences: { ...saved.preferences, breaks: [{ days: [1], start: "14:00", end: "13:00" }] },
            version: 1,
        });
        expect(bad.status).toBe(422);
        const d = await dash(date, "plan");
        expect(d.capacity).toMatchObject({ availableMinutes: 420, breakMinutes: 60 });
        expect(d.timeline!.items.find((i) => i.kind === "break")).toMatchObject({ title: "Lunch", startTime: "12:00" });
        const activity = await db().prepare("SELECT action FROM calendar_activity WHERE action = 'today.preferences'").all();
        expect(activity.results).toHaveLength(1);
        expect(JSON.stringify(activity.results)).not.toContain("Lunch");
    });

    it("reads preferences and planning hours saved before Daly Tasks was retired, and saves them without the retired fields", async () => {
        const week = Array.from({ length: 7 }, () => ({ start: "08:00", end: "12:00" }));
        await db().batch([
            db()
                .prepare("INSERT INTO today_preferences (email, value, version, updated_at) VALUES (?, ?, 3, ?)")
                .bind(
                    A,
                    JSON.stringify({
                        sections: ["attention", "timeline", "deadlines"],
                        startView: "morning",
                        showCompleted: false,
                        focusPeriods: [{ label: "Deep work", days: [1], start: "09:00", end: "11:00" }],
                        breaks: [{ label: "Coffee", days: ALL_WEEK, start: "10:00", end: "10:30" }],
                    }),
                    new Date().toISOString(),
                ),
            db()
                .prepare("INSERT INTO planner_preferences (email, value, version, updated_at) VALUES (?, ?, 2, ?)")
                .bind(
                    A,
                    JSON.stringify({ workingHours: week, bufferMinutes: 5, minBlockMinutes: 30, dailyFocusMinutes: 200, defaultEstimateMinutes: 45 }),
                    new Date().toISOString(),
                ),
        ]);
        const d = await dash(soon(), "plan");
        expect(d.preferences).toMatchObject({ sections: ["timeline"], startView: "dashboard", breaks: [{ label: "Coffee" }] });
        expect(d.capacity).toMatchObject({ availableMinutes: 210, breakMinutes: 30 });
        await savePrefs({ timelineView: "grid" });
        const stored = JSON.parse((await db().prepare("SELECT value FROM today_preferences WHERE email = ?").bind(A).first<{ value: string }>())!.value);
        expect(stored).not.toHaveProperty("focusPeriods");
        expect(stored).not.toHaveProperty("showCompleted");
        const hours = await ok<{ preferences: PlanningHours; version: number }>("GET", `${T}/hours`);
        expect(hours).toEqual({ preferences: { workingHours: week, bufferMinutes: 5, planOnDaysOff: false }, version: 2 });
        const saved = await ok<{ version: number }>("PUT", `${T}/hours`, { preferences: { ...hours.preferences, bufferMinutes: 15 }, version: 2 });
        expect(saved.version).toBe(3);
        expect((await req("PUT", `${T}/hours`, { preferences: hours.preferences, version: 2 })).status).toBe(409);
    });
});

describe("Chief of Staff briefing", () => {
    it("only ever names the person's own records, each with a link, and recommends from fixed rules", async () => {
        await everyDay();
        const date = soon();
        const cal = await defaultCalendar();
        await event(timed(cal.id, "Kids' swimming", date, "16:00", "17:00"));
        await event(timed(cal.id, "Swim club meeting", date, "16:30", "17:30"));
        await event(timed(await defaultCalendar(B).then((c) => c.id), "Somebody else's secret", date, "09:00", "10:00"), B);
        const brief = (await dash(date, "briefing")).briefing!;
        const refs = [...brief.commitments, ...brief.conflicts, ...brief.family, ...brief.nextActions.flatMap((a) => a.refs)];
        for (const r of refs) expect(r.url).toMatch(/^\/portal\//);
        expect(brief.commitments.map((r) => r.title)).toEqual(["Kids' swimming", "Swim club meeting"]);
        expect(brief.conflicts).toHaveLength(1);
        expect(brief.nextActions.map((a) => a.id)).toContain("conflicts");
        expect(JSON.stringify(brief)).not.toContain("Somebody else's secret");
        expect(brief.notChecked).toContain("email");
        expect(brief).not.toHaveProperty("priorities");
        expect((await db().prepare("SELECT COUNT(*) AS n FROM ai_usage").first<{ n: number }>())!.n).toBe(0);
    });
});

describe("MCP", () => {
    it("serves three read-only Today tools that write nothing, refuses the retired ones, and people without Calendar", async () => {
        await everyDay();
        const date = soon();
        const cal = await defaultCalendar();
        await event(timed(cal.id, "Child's specialist", date, "10:00", "11:00", { visibility: "sensitive" }));
        await event(timed(cal.id, "Budget review", date, "10:30", "11:30"));
        const summary = await mcp<{ timeline: { title: string; kind: string }[]; url: string }>("today_get_summary", { date });
        expect(summary.ok).toBe(true);
        expect(summary.data.url).toContain(`/portal/today?date=${date}`);
        expect(summary.data.timeline.map((i) => i.title)).toContain("Private event");
        expect(JSON.stringify(summary.data)).not.toContain("Child's specialist");
        expect((await dash(date, "plan")).timeline!.items.map((i) => i.title)).toContain("Child's specialist");
        const capacity = await mcp<{ appointmentMinutes: number; overbooked: unknown[] }>("today_get_capacity", { date });
        expect(capacity.data.appointmentMinutes).toBe(90);
        expect(capacity.data.overbooked).toHaveLength(1);
        const brief = await mcp<{ recommendedNextActions: unknown[]; notChecked: string[] }>("today_get_briefing", { date });
        expect(brief.data.notChecked).toContain("email");
        for (const tool of ["today_list_unscheduled", "today_propose_plan", "today_get_conflicts", "planner_get_day", "planner_schedule_task"]) {
            const r = await mcp(tool, { date });
            expect(r.ok, tool).toBe(false);
            if (!r.ok) expect(r.error.code).toBe("retired");
        }
        expect((await db().prepare("SELECT COUNT(*) AS n FROM mcp_writes").first<{ n: number }>())!.n).toBe(0);
        await addEditor();
        expect((await mcp("today_get_summary", {}, EDITOR)).ok).toBe(false);
        expect((await mcp("today_get_summary", { date, email: B })).ok).toBe(false);
    });
});

describe("pages and navigation", () => {
    it("renders Today, adds it to the navigation and the launcher, and keeps the applications", async () => {
        const cal = await defaultCalendar();
        await event(timed(cal.id, "Water the plants", today(), "23:00", "23:30"));
        const token = await accessToken();
        const response = await rawCall("/portal/today", { token });
        expect(response.status).toBe(200);
        const page = renderPage(await response.text());
        expect(page.data.route).toBe("today");
        expect(page.html).toMatch(/Good (morning|afternoon|evening)/);
        expect(page.html).toContain("Water the plants");
        expect(page.html).toContain("Chief of Staff briefing");
        expect(page.html).toContain("Add appointment");
        expect(page.html).not.toMatch(/Plan my day|Morning planning|Evening review|Hide tasks/);
        expect(page.html).toContain('href="/portal/today"');
        expect(renderPage(await (await rawCall("/portal/today?date=nope", { token })).text()).data.route).toBe("today");
        const home = renderPage(await (await rawCall("/portal", { token })).text());
        expect(home.html).toContain('data-portal-link="today"');
        for (const app of ["calendar", "intelligence"]) expect(home.html).toContain(`data-application="${app}"`);
        for (const app of ["tasks", "knowledge"]) expect(home.html).not.toContain(`data-application="${app}"`);
        await addEditor();
        const editor = renderPage(await (await rawCall("/portal", { token: await accessToken({ email: EDITOR }) })).text());
        expect(editor.html).not.toContain('href="/portal/today"');
        expect(editor.html).not.toContain('data-portal-link="today"');
    });
});
