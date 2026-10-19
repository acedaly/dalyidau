// Today (/portal/today, migration 0024, docs/DAILY_PLANNER.md#today) through the Worker: the
// dashboard's parts and permissions, privacy of shared and sensitive events, capacity with
// overlapping commitments, preferences (breaks, focus periods, calendars left out of availability),
// Plan My Day (nothing until approved; accept, reject and adjust; retries), multiple sessions, the
// morning and evening records, the Chief of Staff briefing's grounding, MCP and the pages.
// Every person, task and event is invented.
import { createElement } from "react";
import { renderToString } from "react-dom/server.edge";
import { beforeEach, describe, expect, it } from "vitest";
import { PortalApp } from "../src/portal/portal-app";
import { addDays, localDate } from "../src/shared/calendar/time";
import type { CalendarInfo, EventDetail } from "../src/shared/calendar/types";
import type { PlannerConflict, TimeBlockInfo } from "../src/shared/planner/types";
import type { PortalPageData } from "../src/shared/portal/types";
import type { DailyReview, PlanProposal, TodayDashboard, TodayPreferences } from "../src/shared/today/types";
import { type PortalMcpResponse, handleMcpCall } from "../worker/mcp/entrypoint";
import { OWNER, SECOND_OWNER, accessToken, apiCall, db, portalEnv, call as rawCall, resetPortal } from "./portal-helpers";
import { createTask, sharedProject } from "./tasks-helpers";

const A = OWNER;
const B = SECOND_OWNER;
const EDITOR = "wedding-editor@example.com";
const SYD = "Australia/Sydney";
const C = "/api/portal/calendar";
const P = `${C}/planner`;
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
const blockCount = async () => (await db().prepare("SELECT COUNT(*) AS n FROM task_time_blocks WHERE status = 'scheduled'").first<{ n: number }>())!.n;
const everyDay = (email = A) =>
    ok(
        "PUT",
        `${P}/preferences`,
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
const block = (body: Record<string, unknown>, email = A) => ok<{ block: TimeBlockInfo; conflicts: PlannerConflict[] }>("POST", `${P}/blocks`, body, email);
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
/** A real wedding editor (a portal user without Calendar or Tasks), so refusals are about permissions, not sign-in. */
const addEditor = async () => expect((await apiCall("POST", "/api/portal/users", { email: EDITOR, role: "editor" })).status).toBeLessThan(300);

beforeEach(resetPortal);

describe("access", () => {
    it("needs Calendar and Tasks: wedding editors are refused, and the page says so", async () => {
        await addEditor();
        expect((await req("GET", T, undefined, EDITOR)).status).toBe(403);
        expect((await req("GET", `${T}/preferences`, undefined, EDITOR)).status).toBe(403);
        expect((await req("POST", `${T}/plan`, {}, EDITOR)).status).toBe(403);
        const page = await rawCall("/portal/today", { token: await accessToken({ email: EDITOR }) });
        expect(page.status).toBe(403);
        expect(renderPage(await page.text()).data.route).toBe("forbidden");
        expect((await req("GET", T)).status).toBe(200);
        // Bad parts and far-off dates are refused, not guessed.
        expect((await req("GET", `${T}?parts=everything`)).status).toBe(400);
        expect((await req("GET", `${T}?date=${addDays(today(), 800)}`)).status).toBe(400);
    });
});

describe("the dashboard", () => {
    it("brings tasks, events, sessions and capacity together, counting overlaps once", async () => {
        await everyDay();
        const date = soon();
        const cal = await defaultCalendar();
        await event(timed(cal.id, "Planning meeting", date, "10:00", "11:00"));
        await event(timed(cal.id, "Supplier call", date, "10:30", "11:30"));
        const due = await createTask({ title: "Submit insurance claim", dueDate: date, priority: 1 });
        const undated = await createTask({ title: "Sort the garage", priority: 2 });
        const inboxTask = await createTask({ title: "Read the strata minutes" });
        await block({ taskId: due.id, startDate: date, startTime: "11:00", durationMinutes: 60 });

        const d = await dash(date);
        expect(d.capacity).toMatchObject({ availableMinutes: 480, appointmentMinutes: 90, taskMinutes: 30, committedMinutes: 120, freeMinutes: 360 });
        // The meetings overlap 10:30–11:00 and the session overlaps the call 11:00–11:30: one overbooked period.
        expect(d.capacity!.overbooked.map((o) => [o.startTime, o.endTime])).toEqual([["10:30", "11:30"]]);
        const kinds = d.timeline!.items.map((i) => `${i.startTime} ${i.kind}${i.movable ? "*" : ""}`);
        expect(kinds).toEqual(expect.arrayContaining(["10:00 event", "10:30 event", "11:00 block*"]));
        expect(d.lists!.buckets.inbox).toEqual(expect.arrayContaining([inboxTask.id]));
        expect(d.lists!.buckets.priority).toEqual(expect.arrayContaining([undated.id]));
        expect(d.lists!.buckets.unscheduled).not.toContain(due.id);
        expect(d.preferences!.sections).toHaveLength(7);
        expect(d.greeting).toMatch(/^Good (morning|afternoon|evening)$/);
    });

    it("loads only the parts asked for", async () => {
        const d = await dash(soon(), "notifications");
        expect(d.notifications).toEqual([]);
        expect(d.lists).toBeUndefined();
        expect(d.briefing).toBeUndefined();
        const plan = await dash(soon(), "plan");
        expect(plan.lists && plan.capacity && plan.timeline).toBeTruthy();
        expect(plan.deadlines).toBeUndefined();
    });

    it("keeps others' private events in shared calendars as Busy, and never shows another person's sessions", async () => {
        await everyDay();
        await everyDay(B);
        const date = soon();
        const { calendar: household } = await ok<{ calendar: CalendarInfo }>("POST", `${C}/calendars`, {
            name: "Household",
            kind: "shared",
            purpose: "family",
        });
        await ok("POST", `${C}/calendars/${household.id}/members`, { email: B, role: "editor" });
        await event(timed(household.id, "B's specialist", date, "13:00", "14:00", { visibility: "private" }), B);
        await event(timed(household.id, "School pick-up", date, "15:00", "15:30"), B);
        const project = await sharedProject("editor");
        const t = await createTask({ title: "Shared chore", projectId: project.id, dueDate: date });
        await block({ taskId: t.id, startDate: date, startTime: "09:00", durationMinutes: 60 }, B);

        const d = await dash(date, "plan,commitments,briefing");
        const text = JSON.stringify(d);
        expect(text).not.toContain("B's specialist");
        expect(d.timeline!.items.find((i) => i.startTime === "13:00")).toMatchObject({ title: "Busy", shared: true, fixed: true });
        expect(d.commitments!.shared.map((c) => c.title)).toEqual(expect.arrayContaining(["Busy", "School pick-up"]));
        // B's session is B's alone.
        expect(d.blocks).toEqual([]);
        expect(d.timeline!.items.some((i) => i.kind === "block")).toBe(false);
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
        // The Calendar's own Daily Planner agrees.
        expect((await ok<{ plan: { capacity: { eventMinutes: number } } }>("GET", `${P}/day?date=${date}`)).plan.capacity.eventMinutes).toBe(0);
        // Another person's private calendar can't be named.
        const bCal = await defaultCalendar(B);
        const current = await ok<{ preferences: TodayPreferences; version: number }>("GET", `${T}/preferences`);
        const refused = await req("PUT", `${T}/preferences`, {
            preferences: { ...current.preferences, excludedCalendarIds: [bCal.id] },
            version: current.version,
        });
        expect(refused.status).toBe(422);
    });
});

describe("preferences", () => {
    it("are per person, versioned, validated, and apply breaks to Today and the planner alike", async () => {
        await everyDay();
        const date = soon();
        const saved = await savePrefs({ breaks: [{ label: "Lunch", days: ALL_WEEK, start: "12:00", end: "13:00" }], sections: ["timeline", "capacity"] });
        expect(saved.version).toBe(1);
        expect((await ok<{ preferences: TodayPreferences }>("GET", `${T}/preferences`, undefined, B)).preferences.breaks).toEqual([]);
        const stale = await req("PUT", `${T}/preferences`, { preferences: saved.preferences, version: 0 });
        expect(stale.status).toBe(409);
        expect(
            (await req("PUT", `${T}/preferences`, { preferences: { ...saved.preferences, breaks: [{ days: [1], start: "14:00", end: "13:00" }] }, version: 1 }))
                .status,
        ).toBe(422);

        const d = await dash(date, "plan");
        expect(d.capacity).toMatchObject({ availableMinutes: 420, breakMinutes: 60 });
        expect(d.timeline!.items.find((i) => i.kind === "break")).toMatchObject({ title: "Lunch", startTime: "12:00" });
        // Suggestions skip the break; a session placed in it is warned about.
        const t = await createTask({ title: "Long report", dueDate: date });
        await ok("PUT", `${P}/estimates/${t.id}`, { minutes: 240 });
        const s = (await ok<{ plan: { suggestions: { startTime: string; endTime: string }[] } }>("POST", `${P}/suggest`, { from: date, taskIds: [t.id] })).plan
            .suggestions;
        expect(s.every((x) => x.endTime <= "12:00" || x.startTime >= "13:00")).toBe(true);
        const inBreak = await block({ taskId: t.id, startDate: date, startTime: "12:15", durationMinutes: 30 });
        expect(inBreak.conflicts.map((c) => c.kind)).toContain("break");
        // History holds ids only.
        const activity = await db().prepare("SELECT action, entity_id FROM calendar_activity WHERE action = 'today.preferences'").all();
        expect(activity.results).toHaveLength(1);
        expect(JSON.stringify(activity.results)).not.toContain("Lunch");
    });
});

describe("Plan My Day", () => {
    it("proposes without writing; only approved sessions are created, adjusted where changed, and a retry never doubles them", async () => {
        await everyDay();
        const date = soon();
        await savePrefs({ focusPeriods: [{ label: "Deep work", days: ALL_WEEK, start: "14:00", end: "16:00" }] });
        const cal = await defaultCalendar();
        await event(timed(cal.id, "Fixed meeting", date, "09:00", "10:00"));
        const a = await createTask({ title: "Quarterly report", dueDate: date, priority: 1 });
        const b = await createTask({ title: "Book flights", dueDate: date, priority: 2 });
        const c = await createTask({ title: "Renew rego", dueDate: date, priority: 3 });
        const before = await db().prepare("SELECT id, due_date, priority, version FROM task_items ORDER BY id").all();

        const { proposal } = await ok<{ proposal: PlanProposal }>("POST", `${T}/plan`, { date });
        expect(await blockCount()).toBe(0);
        expect(proposal.suggestions.map((s) => s.taskId)).toEqual(expect.arrayContaining([a.id, b.id, c.id]));
        // Focus period first, never over the fixed meeting.
        expect(proposal.suggestions.find((s) => s.taskId === a.id)).toMatchObject({ startTime: "14:00", inFocus: true });
        expect(proposal.suggestions.every((s) => s.startTime >= "10:00")).toBe(true);
        // Same inputs, same proposal.
        expect((await ok<{ proposal: PlanProposal }>("POST", `${T}/plan`, { date })).proposal.suggestions).toEqual(proposal.suggestions);

        // Accept A as proposed, adjust B, reject C.
        const sa = proposal.suggestions.find((s) => s.taskId === a.id)!;
        const items = [
            { taskId: a.id, startDate: date, startTime: sa.startTime, durationMinutes: sa.durationMinutes, clientId: "apply-test-0001" },
            { taskId: b.id, startDate: date, startTime: "11:30", durationMinutes: 45, clientId: "apply-test-0002" },
        ];
        const applied = await ok<{ created: { block: TimeBlockInfo }[]; failed: unknown[] }>("POST", `${T}/plan/apply`, { date, items });
        expect(applied.created.map((x) => [x.block.taskId, x.block.startTime, x.block.durationMinutes, x.block.source])).toEqual([
            [a.id, sa.startTime, sa.durationMinutes, "suggestion"],
            [b.id, "11:30", 45, "suggestion"],
        ]);
        expect(await blockCount()).toBe(2);
        await ok("POST", `${T}/plan/apply`, { date, items });
        expect(await blockCount()).toBe(2);
        // Tasks stays the source of truth: nothing about the tasks changed.
        expect((await db().prepare("SELECT id, due_date, priority, version FROM task_items ORDER BY id").all()).results).toEqual(before.results);
        const d = await dash(date, "plan");
        expect(d.lists!.buckets.unscheduled).toContain(c.id);
        expect(d.lists!.buckets.unscheduled).not.toContain(a.id);
    });

    it("plans several sessions for one task, reports what can't be created, and refuses past days and bad requests", async () => {
        await everyDay();
        const date = soon();
        const t = await createTask({ title: "Write the thesis chapter", dueDate: date });
        const theirs = await createTask({ title: "Not yours" }, B);
        const r = await ok<{ created: { block: TimeBlockInfo }[]; failed: { taskId: string; code: string }[] }>("POST", `${T}/plan/apply`, {
            date,
            items: [
                { taskId: t.id, startDate: date, startTime: "09:00", durationMinutes: 90, clientId: "multi-session-01" },
                { taskId: t.id, startDate: date, startTime: "13:00", durationMinutes: 90, clientId: "multi-session-02" },
                { taskId: theirs.id, startDate: date, startTime: "15:00", durationMinutes: 30, clientId: "multi-session-03" },
            ],
        });
        expect(r.created).toHaveLength(2);
        expect(r.failed).toEqual([expect.objectContaining({ taskId: theirs.id, code: "not_found" })]);
        const lists = (await dash(date, "plan")).lists!;
        expect(lists.tasks.find((x) => x.id === t.id)).toMatchObject({ scheduledMinutes: 180, upcomingSessions: 2 });
        expect((await req("POST", `${T}/plan`, { date: addDays(today(), -1) })).status).toBe(422);
        expect(
            (await req("POST", `${T}/plan/apply`, { date, items: [{ taskId: t.id, startDate: date, startTime: "09:00", durationMinutes: 30 }] })).status,
        ).toBe(422);
        expect((await req("POST", `${T}/plan/apply`, { date, items: [] })).status).toBe(422);
    });
});

describe("morning and evening", () => {
    it("records the top three by id, checked through Tasks, with versions", async () => {
        const date = today();
        const t1 = await createTask({ title: "Call the bank", dueDate: date });
        const hidden = await createTask({ title: "B's private task" }, B);
        const first = await ok<{ review: DailyReview }>("PUT", `${T}/reviews/${date}/morning`, {
            priorities: [t1.id],
            summary: { planned: 2, capacityConfirmed: true },
            version: 0,
        });
        expect(first.review).toMatchObject({ kind: "morning", priorities: [t1.id], version: 1, summary: { planned: 2, capacityConfirmed: true } });
        expect((await req("PUT", `${T}/reviews/${date}/morning`, { priorities: [t1.id], version: 0 })).status).toBe(409);
        expect((await req("PUT", `${T}/reviews/${date}/morning`, { priorities: [hidden.id], version: 1 })).status).toBe(404);
        expect(
            (
                await req("PUT", `${T}/reviews/${date}/morning`, {
                    priorities: ["tsk_aaaaaaaaaaaaaa", "tsk_bbbbbbbbbbbbbb", "tsk_cccccccccccccc", "tsk_dddddddddddddd"],
                    version: 1,
                })
            ).status,
        ).toBe(422);
        expect((await req("PUT", `${T}/reviews/${date}/afternoon`, { version: 0 })).status).toBe(404);
        // Private to the person.
        expect((await ok<{ reviews: { morning: DailyReview | null } }>("GET", `${T}/reviews/${date}`, undefined, B)).reviews.morning).toBeNull();
        // The briefing's priorities follow the person's choice.
        const d = await dash(date, "briefing,reviews");
        expect(d.briefing!.priorities.map((p) => p.id)).toEqual([t1.id]);
        expect(d.reviews!.morning?.priorities).toEqual([t1.id]);
    });

    it("finds yesterday's unfinished sessions, and moves nothing until the person decides", async () => {
        await everyDay();
        const date = today();
        const yesterday = addDays(date, -1);
        const open = await createTask({ title: "Finish the budget", dueDate: date });
        const done = await createTask({ title: "Post the letter", dueDate: yesterday });
        const left = await block({ taskId: open.id, startDate: yesterday, startTime: "09:00", durationMinutes: 60 });
        await block({ taskId: done.id, startDate: yesterday, startTime: "11:00", durationMinutes: 30 });
        await ok("POST", `/api/portal/tasks/tasks/${done.id}/complete`, { occurrence: null });
        const brief = (await dash(date, "briefing")).briefing!;
        expect(brief.unfinishedYesterday.map((r) => r.id)).toEqual([open.id]);
        expect(brief.nextActions.find((a) => a.id === "yesterday")?.refs.map((r) => r.id)).toEqual([open.id]);
        // Viewing it changed nothing.
        expect(await db().prepare("SELECT start_date, status, version FROM task_time_blocks WHERE id = ?").bind(left.block.id).first()).toEqual({
            start_date: yesterday,
            status: "scheduled",
            version: 1,
        });
        // The evening review's choices go through the planner: reschedule, or return the task to the list.
        const moved = await ok<{ block: TimeBlockInfo }>("PATCH", `${P}/blocks/${left.block.id}`, { version: 1, startDate: soon(1), startTime: "10:00" });
        expect(moved.block).toMatchObject({ startDate: soon(1), startTime: "10:00" });
        await ok("PATCH", `${P}/blocks/${left.block.id}`, { version: moved.block.version, status: "cancelled" });
        expect((await dash(date, "plan")).lists!.buckets.unscheduled).toContain(open.id);
        const evening = await ok<{ review: DailyReview }>("PUT", `${T}/reviews/${date}/evening`, {
            summary: { rescheduled: 1, returned: 1, followUps: 0 },
            note: "Good progress on the budget.",
            version: 0,
        });
        expect(evening.review.note).toBe("Good progress on the budget.");
        // History holds ids only, never the note.
        const rows = JSON.stringify((await db().prepare("SELECT * FROM calendar_activity WHERE action LIKE 'today.%'").all()).results);
        expect(rows).toContain("today.evening");
        expect(rows).not.toContain("budget");
    });
});

describe("Chief of Staff briefing", () => {
    it("only ever names the person's own records, each with a link, and recommends from fixed rules", async () => {
        await everyDay();
        const date = today();
        const cal = await defaultCalendar();
        await event(timed(cal.id, "Kids' swimming", soon(1), "16:00", "17:00"));
        const overdue = await createTask({ title: "Overdue tax return", dueDate: addDays(date, -3), priority: 1 });
        const deadline = await createTask({ title: "Grant application", deadline: soon(5) });
        await createTask({ title: "Somebody else's secret" }, B);
        const brief = (await dash(date, "briefing")).briefing!;
        const refs = [
            ...brief.commitments,
            ...brief.priorities,
            ...brief.overdue,
            ...brief.conflicts,
            ...brief.projectDeadlines,
            ...brief.family,
            ...brief.unfinishedYesterday,
            ...brief.nextActions.flatMap((a) => a.refs),
        ];
        const tasks = new Map(
            (await db().prepare("SELECT id, title FROM task_items").all<{ id: string; title: string }>()).results.map((r) => [r.id, r.title]),
        );
        for (const r of refs) {
            expect(r.url).toMatch(/^\/portal\//);
            if (r.kind === "task") expect(tasks.get(r.id), r.id).toBe(r.title);
        }
        expect(brief.overdue.map((r) => r.id)).toEqual([overdue.id]);
        expect(brief.projectDeadlines.map((r) => r.id)).toContain(deadline.id);
        expect(JSON.stringify(brief)).not.toContain("Somebody else's secret");
        expect(brief.nextActions.find((a) => a.id === "overdue")?.refs.map((r) => r.id)).toEqual([overdue.id]);
        expect(brief.notChecked).toContain("email");
        // Facts only: no model was asked.
        expect((await db().prepare("SELECT COUNT(*) AS n FROM ai_usage").first<{ n: number }>())!.n).toBe(0);
    });
});

describe("MCP", () => {
    it("serves six read-only Today tools that write nothing, and refuses people without Calendar and Tasks", async () => {
        await everyDay();
        const date = soon();
        const cal = await defaultCalendar();
        await event(timed(cal.id, "Child's specialist", date, "10:00", "11:00", { visibility: "sensitive" }));
        const t = await createTask({ title: "Prepare the agenda", dueDate: date, priority: 1 });
        await block({ taskId: t.id, startDate: date, startTime: "10:30", durationMinutes: 60 });

        const summary = await mcp<{ timeline: { title: string; kind: string }[]; url: string }>("today_get_summary", { date });
        expect(summary.ok).toBe(true);
        expect(summary.data.url).toContain(`/portal/today?date=${date}`);
        // Sensitive events stay "Private event" for assistants, though the person sees their own on the page.
        expect(summary.data.timeline.map((i) => i.title)).toContain("Private event");
        expect(JSON.stringify(summary.data)).not.toContain("Child's specialist");
        expect((await dash(date, "plan")).timeline!.items.map((i) => i.title)).toContain("Child's specialist");

        const capacity = await mcp<{ appointmentMinutes: number; taskMinutes: number; overbooked: unknown[] }>("today_get_capacity", { date });
        expect(capacity.data).toMatchObject({ appointmentMinutes: 60, taskMinutes: 30 });
        expect(capacity.data.overbooked).toHaveLength(1);
        const conflicts = await mcp<{ conflicts: { kind: string; session: { blockId: string } }[] }>("today_get_conflicts", { date });
        expect(conflicts.data.conflicts.map((c) => c.kind)).toContain("event");
        const other = await createTask({ title: "Unplanned errand" });
        const unscheduled = await mcp<{ tasks: { id: string }[] }>("today_list_unscheduled");
        expect(unscheduled.data.tasks.map((x) => x.id)).toContain(other.id);
        const proposal = await mcp<{ proposed: unknown[]; note: string }>("today_propose_plan", { date });
        expect(proposal.data.note).toMatch(/planner_schedule_task/);
        const brief = await mcp<{ recommendedNextActions: unknown[]; notChecked: string[] }>("today_get_briefing", { date });
        expect(brief.data.notChecked).toContain("email");

        expect(await blockCount()).toBe(1);
        expect((await db().prepare("SELECT COUNT(*) AS n FROM mcp_writes").first<{ n: number }>())!.n).toBe(0);
        await addEditor();
        const refused = await mcp("today_get_summary", {}, EDITOR);
        expect(refused.ok).toBe(false);
        // No identity is taken from arguments.
        expect((await mcp("today_get_summary", { date, email: B })).ok).toBe(false);
    });
});

describe("pages and navigation", () => {
    it("renders Today, adds it to the navigation and the launcher, and keeps the applications", async () => {
        await createTask({ title: "Water the plants", dueDate: today() });
        const token = await accessToken();
        const response = await rawCall("/portal/today", { token });
        expect(response.status).toBe(200);
        const page = renderPage(await response.text());
        expect(page.data.route).toBe("today");
        expect(page.html).toMatch(/Good (morning|afternoon|evening)/);
        expect(page.html).toContain("Water the plants");
        expect(page.html).toContain("Chief of Staff briefing");
        expect(page.html).toContain('href="/portal/today"');
        expect(page.html).toContain("All Applications");
        // A malformed date opens today.
        expect(renderPage(await (await rawCall("/portal/today?date=nope", { token })).text()).data.route).toBe("today");
        const home = renderPage(await (await rawCall("/portal", { token })).text());
        expect(home.html).toContain('data-portal-link="today"');
        for (const app of ["calendar", "tasks", "knowledge", "intelligence"]) expect(home.html).toContain(`data-application="${app}"`);
        // A wedding editor gets neither.
        await addEditor();
        const editor = renderPage(await (await rawCall("/portal", { token: await accessToken({ email: EDITOR }) })).text());
        expect(editor.html).not.toContain('href="/portal/today"');
        expect(editor.html).not.toContain('data-portal-link="today"');
        // The Calendar's own planner keeps its five lists (no Inbox tab there).
        const planner = renderPage(await (await rawCall(`/portal/calendar/planner?date=${today()}`, { token })).text());
        expect(planner.html.match(/role="tab"/g)).toHaveLength(5);
    });
});
