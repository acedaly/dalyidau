// The Daily Planner and time blocks through the Worker (migration 0023, docs/DAILY_PLANNER.md):
// the database's own guarantees, Tasks staying the source of truth, permissions and privacy,
// repeating tasks, daylight saving, conflicts with shared and subscribed calendars, suggestions that
// never write, completion through Tasks, private feeds, MCP and Chief of Staff, and the pages.
// Every person, task and event is invented.
import { createElement } from "react";
import { renderToString } from "react-dom/server.edge";
import { beforeEach, describe, expect, it } from "vitest";
import { PortalApp } from "../src/portal/portal-app";
import { addDays, localDate } from "../src/shared/calendar/time";
import type { CalendarInfo, EventDetail } from "../src/shared/calendar/types";
import type { DayPlan, PlanResult, PlannerConflict, PlannerData, PlannerTaskLists, TimeBlockInfo } from "../src/shared/planner/types";
import type { PortalPageData } from "../src/shared/portal/types";
import type { TaskSummary } from "../src/shared/tasks/types";
import { type PortalMcpResponse, handleMcpCall } from "../worker/mcp/entrypoint";
import { OWNER, SECOND_OWNER, accessToken, apiCall, db, portalEnv, call as rawCall, resetPortal } from "./portal-helpers";
import { createTask, sharedProject, call as tasks } from "./tasks-helpers";

const A = OWNER;
const B = SECOND_OWNER;
const EDITOR = "wedding-editor@example.com";
const SYD = "Australia/Sydney";
const C = "/api/portal/calendar";
const P = `${C}/planner`;
const MCP_AUD = "aud-mcp-gateway-0123456789abcdef";

const req = <R = unknown>(method: string, path: string, body?: unknown, email = A) => apiCall<R>(method, path, body, { email });
const ok = async <R = unknown>(method: string, path: string, body?: unknown, email = A) => {
    const r = await req<R>(method, path, body, email);
    expect(r.status, `${method} ${path}: ${r.text}`).toBeLessThan(300);
    return r.json;
};
type Created = { block: TimeBlockInfo; conflicts: PlannerConflict[] };
const block = (body: Record<string, unknown>, email = A) => ok<Created>("POST", `${P}/blocks`, body, email);
const today = () => localDate(new Date(), SYD);
/** A date a week ahead: in the future, inside feeds' window, and the same weekday as today. */
const soon = (days = 7) => addDays(today(), days);
const blockCount = async () => (await db().prepare("SELECT COUNT(*) AS n FROM task_time_blocks").first<{ n: number }>())!.n;
const taskRow = async (id: string) => db().prepare("SELECT due_date, due_time, status, version FROM task_items WHERE id = ?").bind(id).first();
/** Plan every day 9 to 5, so tests don't depend on what weekday they run on. */
const everyDay = (email = A) =>
    ok("PUT", `${P}/preferences`, { preferences: { workingHours: Array.from({ length: 7 }, () => ({ start: "09:00", end: "17:00" })) }, version: 0 }, email);
const defaultCalendar = async (email = A) =>
    (await ok<{ calendars: CalendarInfo[] }>("GET", `${C}/calendars`, undefined, email)).calendars.find((c) => c.isDefault)!;
const event = async (body: Record<string, unknown>, email = A) => (await ok<{ event: EventDetail }>("POST", `${C}/events`, body, email)).event;
const mcp = async <T = Record<string, unknown>>(tool: string, input: unknown = {}, email = A) =>
    (await handleMcpCall(await portalEnv({ MCP_ACCESS_AUD: MCP_AUD }), {
        assertion: await accessToken({ email, aud: [MCP_AUD] }),
        tool,
        input,
    })) as PortalMcpResponse & { data: T };
const renderPage = (html: string) => {
    const json = /<script type="application\/json" id="page-data">([\s\S]*?)<\/script>/.exec(html)?.[1];
    const payload = JSON.parse(json!) as { data: PortalPageData; path: string };
    return { data: payload.data, html: renderToString(createElement(PortalApp, { data: payload.data, path: payload.path })) };
};

beforeEach(resetPortal);

describe("migration 0023", () => {
    it("refuses blocks for people who can't work on the task, and keeps blocks with their task and person", async () => {
        const project = await sharedProject("viewer");
        const t = await createTask({ title: "Paint the fence", projectId: project.id });
        const now = new Date().toISOString();
        const insert = (owner: string, id = "ttb_aaaaaaaaaaaaaa") =>
            db()
                .prepare(
                    `INSERT INTO task_time_blocks (id, task_id, owner_email, start_date, start_time, duration_minutes, time_zone, start_at, end_at, created_at, updated_at)
                     VALUES (?, ?, ?, '2026-11-02', '09:00', 60, ?, '2026-11-01T22:00:00.000Z', '2026-11-01T23:00:00.000Z', ?, ?)`,
                )
                .bind(id, t.id, owner, SYD, now, now)
                .run();
        // B is only a viewer; C isn't a member at all.
        await expect(insert(B)).rejects.toThrow(/task you can work on/);
        await expect(insert("someone@example.com")).rejects.toThrow(/task you can work on/);
        await insert(A);
        await expect(db().prepare("UPDATE task_time_blocks SET owner_email = ? WHERE id = 'ttb_aaaaaaaaaaaaaa'").bind(B).run()).rejects.toThrow(/stays with/);
        await expect(
            db()
                .prepare(
                    `INSERT INTO task_time_blocks (id, task_id, owner_email, start_date, start_time, duration_minutes, time_zone, start_at, end_at, created_at, updated_at)
                     VALUES ('ttb_bbbbbbbbbbbbbb', ?, ?, '2026-11-02', '09:00', 60, ?, '2026-11-01T22:00:00.000Z', '2026-11-01T21:00:00.000Z', ?, ?)`,
                )
                .bind(t.id, A, SYD, now, now)
                .run(),
        ).rejects.toThrow(/CHECK/);
        // The widened ledger accepts a time block outcome.
        await db()
            .prepare(
                "INSERT INTO mcp_writes (id, email, tool, status, entity_type, entity_id, created_at) VALUES ('mcw_x', ?, 'planner_schedule_task', 'done', 'task_time_block', 'ttb_aaaaaaaaaaaaaa', ?)",
            )
            .bind(A, now)
            .run();
    });

    it("removes blocks and estimates with the task, when someone leaves the project, and when the task moves away", async () => {
        const project = await sharedProject("editor");
        const t1 = await createTask({ title: "Clean gutters", projectId: project.id });
        const t2 = await createTask({ title: "Fix tap", projectId: project.id });
        await block({ taskId: t1.id, startDate: soon(), startTime: "09:00", durationMinutes: 60 });
        await block({ taskId: t2.id, startDate: soon(), startTime: "10:00", durationMinutes: 60 }, B);
        await ok("PUT", `${P}/estimates/${t1.id}`, { minutes: 90 });
        expect(await blockCount()).toBe(2);

        // Deleting a task through Tasks removes its blocks and estimate: no orphans.
        await ok("DELETE", `/api/portal/tasks/tasks/${t1.id}`);
        expect(await blockCount()).toBe(1);
        expect((await db().prepare("SELECT COUNT(*) AS n FROM task_estimates").first<{ n: number }>())!.n).toBe(0);

        // Moving the task to A's own Inbox removes B's block for it.
        const inbox = (await tasks<{ projects: { id: string; isInbox: boolean }[] }>("GET", "/projects")).json.projects.find((p) => p.isInbox)!;
        await ok("POST", `/api/portal/tasks/tasks/${t2.id}/move`, { projectId: inbox.id, sectionId: null });
        expect(await blockCount()).toBe(0);

        // Leaving a project removes your blocks for its tasks.
        const t3 = await createTask({ title: "Mow lawn", projectId: project.id });
        await block({ taskId: t3.id, startDate: soon(), startTime: "11:00", durationMinutes: 30 }, B);
        await ok("DELETE", `/api/portal/tasks/projects/${project.id}/members/${encodeURIComponent(B)}`);
        expect(await blockCount()).toBe(0);
    });
});

describe("time blocks", () => {
    it("block time for a task without changing the task, with several sessions, moves, resizes and cancels", async () => {
        const t = await createTask({ title: "Write the report", dueDate: soon(3), dueTime: "17:00", priority: 2 });
        const before = await taskRow(t.id);
        const first = await block({ taskId: t.id, startDate: soon(1), startTime: "09:00", durationMinutes: 90 });
        const second = await block({ taskId: t.id, startDate: soon(2), startTime: "14:00", durationMinutes: 60 });
        expect(first.block).toMatchObject({
            taskId: t.id,
            title: "Write the report",
            startTime: "09:00",
            endTime: "10:30",
            durationMinutes: 90,
            status: "scheduled",
            version: 1,
        });
        expect(second.block.id).not.toBe(first.block.id);

        const moved = await ok<Created>("PATCH", `${P}/blocks/${first.block.id}`, { version: 1, startTime: "13:15" });
        expect(moved.block).toMatchObject({ startTime: "13:15", endTime: "14:45", version: 2 });
        const resized = await ok<Created>("PATCH", `${P}/blocks/${first.block.id}`, { version: 2, durationMinutes: 45 });
        expect(resized.block).toMatchObject({ startTime: "13:15", endTime: "14:00", durationMinutes: 45 });
        // A stale version gets the block as it is now.
        const stale = await req<{ current: TimeBlockInfo }>("PATCH", `${P}/blocks/${first.block.id}`, { version: 1, durationMinutes: 30 });
        expect(stale.status).toBe(409);
        expect(stale.json.current.version).toBe(3);
        const cancelled = await ok<Created>("PATCH", `${P}/blocks/${second.block.id}`, { version: 1, status: "cancelled" });
        expect(cancelled.block.status).toBe("cancelled");
        expect(cancelled.conflicts).toEqual([]);
        expect((await req("PATCH", `${P}/blocks/${second.block.id}`, { version: 2, startTime: "10:00" })).status).toBe(422);

        // The task is exactly as it was: Tasks is the source of truth.
        expect(await taskRow(t.id)).toEqual(before);
        const lists = (await ok<{ lists: PlannerTaskLists }>("GET", `${P}/tasks`)).lists;
        expect(lists.tasks.find((x) => x.id === t.id)).toMatchObject({ scheduledMinutes: 45, upcomingSessions: 1 });
        expect(lists.buckets.unscheduled).not.toContain(t.id);
        // History holds ids, never the title.
        const history = await db().prepare("SELECT * FROM calendar_activity WHERE entity_type = 'time_block'").all();
        expect(history.results.length).toBe(5);
        expect(JSON.stringify(history.results)).not.toContain("report");
    });

    it("retries safely with a client id, and refuses completed tasks and impossible lengths", async () => {
        const t = await createTask({ title: "Book dentist" });
        const one = await block({ taskId: t.id, startDate: soon(), startTime: "09:00", durationMinutes: 30, clientId: "retry-me-1234" });
        const again = await block({ taskId: t.id, startDate: soon(), startTime: "09:00", durationMinutes: 30, clientId: "retry-me-1234" });
        expect(again.block.id).toBe(one.block.id);
        expect(await blockCount()).toBe(1);
        for (const durationMinutes of [0, 7, 725])
            expect((await req("POST", `${P}/blocks`, { taskId: t.id, startDate: soon(), startTime: "09:00", durationMinutes })).status).toBe(422);
        await ok("POST", `/api/portal/tasks/tasks/${t.id}/complete`, { occurrence: null });
        expect((await req("POST", `${P}/blocks`, { taskId: t.id, startDate: soon(), startTime: "11:00", durationMinutes: 30 })).status).toBe(422);
    });

    it("refuses a time that daylight saving skips, and keeps real lengths across both changes", async () => {
        const t = await createTask({ title: "Night shift prep" });
        // 4 October 2026, 2:30 am doesn't exist in Sydney.
        const gap = await req<{ message: string }>("POST", `${P}/blocks`, { taskId: t.id, startDate: "2026-10-04", startTime: "02:30", durationMinutes: 60 });
        expect(gap.status).toBe(422);
        expect(gap.json.message).toMatch(/clocks go forward/);
        // 1:30 am for two hours on 4 October ends at 4:30 am local (an hour was skipped); on 5 April it ends at 2:30 am (repeated).
        const spring = await block({ taskId: t.id, startDate: "2026-10-04", startTime: "01:30", durationMinutes: 120 });
        expect(spring.block).toMatchObject({ start: "2026-10-03T15:30:00.000Z", end: "2026-10-03T17:30:00.000Z", endTime: "04:30" });
        const autumn = await block({ taskId: t.id, startDate: "2026-04-05", startTime: "01:30", durationMinutes: 120 });
        expect(autumn.block).toMatchObject({ start: "2026-04-04T14:30:00.000Z", end: "2026-04-04T16:30:00.000Z", endTime: "02:30" });
    });

    it("plans each occurrence of a repeating task, and completing it in Tasks moves the task on, not the block", async () => {
        const date = soon(1);
        const t = await createTask({ title: "Water plants", dueDate: date, recurrence: { freq: "daily", interval: 1, basis: "scheduled" } });
        const { block: b } = await block({ taskId: t.id, startDate: date, startTime: "08:00", durationMinutes: 15 });
        expect(b).toMatchObject({ recurring: true, occurrenceDate: date, earlierOccurrence: false });
        // Completing from Calendar uses Tasks' own API and rules.
        const done = await ok<{ task: TaskSummary; nextDate: string }>("POST", `/api/portal/tasks/tasks/${t.id}/complete`, { occurrence: date });
        expect(done.nextDate).toBe(addDays(date, 1));
        const after = (await ok<{ block: TimeBlockInfo }>("GET", `${P}/blocks/${b.id}`)).block;
        expect(after).toMatchObject({ startDate: date, startTime: "08:00", earlierOccurrence: true, taskDueDate: addDays(date, 1) });
        // The next occurrence has nothing planned yet.
        const lists = (await ok<{ lists: PlannerTaskLists }>("GET", `${P}/tasks`)).lists;
        expect(lists.tasks.find((x) => x.id === t.id)?.scheduledMinutes).toBe(0);
    });
});

describe("permissions and privacy", () => {
    it("keeps blocks private, checks every task through Tasks, and needs both Calendar and Tasks", async () => {
        const mine = await createTask({ title: "Private errand" });
        const { block: b } = await block({ taskId: mine.id, startDate: soon(), startTime: "09:00", durationMinutes: 30 });
        // Someone else: their own task list never has it, and they can't read, move, estimate or check it.
        expect((await req("GET", `${P}/blocks/${b.id}`, undefined, B)).status).toBe(404);
        expect((await req("PATCH", `${P}/blocks/${b.id}`, { version: 1, status: "cancelled" }, B)).status).toBe(404);
        expect((await req("POST", `${P}/blocks`, { taskId: mine.id, startDate: soon(), startTime: "10:00", durationMinutes: 30 }, B)).status).toBe(404);
        expect((await req("PUT", `${P}/estimates/${mine.id}`, { minutes: 30 }, B)).status).toBe(404);
        expect((await req("POST", `${P}/check`, { taskId: mine.id, startDate: soon(), startTime: "10:00", durationMinutes: 30 }, B)).status).toBe(404);
        expect((await req("POST", `${P}/suggest`, { taskIds: [mine.id] }, B)).status).toBe(404);
        const theirDay = (await ok<{ plan: DayPlan }>("GET", `${P}/day?date=${soon()}`, undefined, B)).plan;
        expect(theirDay.blocks).toEqual([]);

        // A viewer of a shared project can't plan its tasks or estimate them.
        const project = await sharedProject("viewer");
        const shared = await createTask({ title: "Shared job", projectId: project.id });
        expect((await req("POST", `${P}/blocks`, { taskId: shared.id, startDate: soon(), startTime: "10:00", durationMinutes: 30 }, B)).status).toBe(403);
        expect((await req("PUT", `${P}/estimates/${shared.id}`, { minutes: 30 }, B)).status).toBe(403);

        // Wedding editors can open neither Calendar nor Tasks.
        await apiCall("POST", "/api/portal/users", { email: EDITOR, role: "editor" });
        for (const [method, path] of [
            ["GET", `${P}/day`],
            ["GET", `${P}/tasks`],
            ["POST", `${P}/suggest`],
            ["POST", `${P}/blocks`],
        ])
            expect((await req(method, path, method === "GET" ? undefined : {}, EDITOR)).status, path).toBe(403);
        expect((await rawCall("/portal/calendar/planner", { token: await accessToken({ email: EDITOR }) })).status).toBe(403);
    });
});

describe("the day's plan, conflicts and suggestions", () => {
    it("warns about overlaps with your events, shared commitments and subscribed calendars, showing others' private events as Busy", async () => {
        await everyDay();
        const date = soon();
        const mine = await defaultCalendar();
        await event({ calendarId: mine.id, title: "Dentist", allDay: false, startDate: date, startTime: "10:00", endDate: date, endTime: "11:00" });
        const { calendar: household } = await ok<{ calendar: CalendarInfo }>("POST", `${C}/calendars`, {
            name: "Household",
            kind: "shared",
            purpose: "family",
        });
        await ok("POST", `${C}/calendars/${household.id}/members`, { email: B, role: "editor" });
        await event(
            {
                calendarId: household.id,
                title: "B's appointment",
                visibility: "private",
                allDay: false,
                startDate: date,
                startTime: "12:00",
                endDate: date,
                endTime: "13:00",
            },
            B,
        );
        // A subscribed (external) calendar's event, as a refresh would store it.
        const now = new Date().toISOString();
        await db().batch([
            db()
                .prepare(
                    "INSERT INTO calendars (id, name, kind, purpose, source, owner_email, created_by, created_at, updated_by, updated_at) VALUES ('cal_subscribed0001', 'School', 'personal', 'subscription', 'subscription', ?, ?, ?, ?, ?)",
                )
                .bind(A, A, now, A, now),
            db()
                .prepare(
                    "INSERT INTO calendar_members (calendar_id, email, role, added_by, created_at, updated_at) VALUES ('cal_subscribed0001', ?, 'owner', ?, ?, ?)",
                )
                .bind(A, A, now, now),
            db()
                .prepare(
                    `INSERT INTO calendar_events (id, calendar_id, source, uid, title, all_day, start_date, start_time, end_date, end_time, time_zone, start_at, end_at, series_end_at, created_by, created_at, updated_by, updated_at)
                     VALUES ('cev_subscribed0001', 'cal_subscribed0001', 'subscription', 'x@school', 'Assembly', 0, ?, '14:00', ?, '15:00', ?, ?, ?, ?, ?, ?, ?, ?)`,
                )
                .bind(date, date, SYD, `${date}T03:00:00.000Z`, `${date}T04:00:00.000Z`, `${date}T04:00:00.000Z`, A, now, A, now),
        ]);
        const t = await createTask({ title: "Big focus task", dueDate: date });
        const long = await block({ taskId: t.id, startDate: date, startTime: "10:30", durationMinutes: 240 });
        const kinds = long.conflicts.map((c) => c.with?.title ?? c.kind);
        expect(kinds).toEqual(expect.arrayContaining(["Dentist", "Busy", "Assembly"]));
        expect(long.conflicts.find((c) => c.with?.title === "Busy")?.with?.shared).toBe(true);
        expect(long.conflicts.find((c) => c.with?.title === "Assembly")?.message).toMatch(/subscribed calendar/);
        expect(JSON.stringify(long.conflicts)).not.toContain("B's appointment");
        // The proposed-time check says the same, and the day's plan lists it.
        const checked = (
            await ok<{ conflicts: PlannerConflict[] }>("POST", `${P}/check`, { taskId: t.id, startDate: date, startTime: "10:15", durationMinutes: 30 })
        ).conflicts;
        expect(checked.map((c) => c.with?.title)).toContain("Dentist");
        const plan = (await ok<{ plan: DayPlan }>("GET", `${P}/day?date=${date}`)).plan;
        expect(plan.conflicts.length).toBe(long.conflicts.length);
        expect(plan.capacity).toMatchObject({ workingMinutes: 480, blockMinutes: 240 });
        expect(plan.capacity.eventMinutes).toBe(180);
    });

    it("suggests sessions deterministically in free time, creates nothing, and accepted suggestions become blocks", async () => {
        await everyDay();
        const date = soon();
        const mine = await defaultCalendar();
        await event({ calendarId: mine.id, title: "Standup", allDay: false, startDate: date, startTime: "09:00", endDate: date, endTime: "09:30" });
        const urgent = await createTask({ title: "Urgent", dueDate: date, priority: 1 });
        const later = await createTask({ title: "Later", dueDate: addDays(date, 1), priority: 3 });
        await ok("PUT", `${P}/estimates/${urgent.id}`, { minutes: 150 });
        await ok("PUT", `${P}/estimates/${later.id}`, { minutes: 30 });
        const ask = { from: date, days: 1, taskIds: [later.id, urgent.id] };
        const first = (await ok<{ plan: PlanResult }>("POST", `${P}/suggest`, ask)).plan;
        const second = (await ok<{ plan: PlanResult }>("POST", `${P}/suggest`, ask)).plan;
        expect(second).toEqual(first);
        expect(await blockCount()).toBe(0);
        // Urgent first: 9:30 + 10-minute buffer → 9:45 (quarter hour), split 120 + 30; then Later.
        expect(first.suggestions.map((s) => [s.title, s.startTime, s.endTime])).toEqual([
            ["Urgent", "09:45", "11:45"],
            ["Urgent", "12:00", "12:30"],
            ["Later", "12:45", "13:15"],
        ]);
        // Accept one as it is and one modified.
        const [a, b] = first.suggestions;
        await block({ taskId: a.taskId, startDate: a.startDate, startTime: a.startTime, durationMinutes: a.durationMinutes, source: "suggestion" });
        await block({ taskId: b.taskId, startDate: b.startDate, startTime: "15:00", durationMinutes: 45, source: "suggestion" });
        const again = (await ok<{ plan: PlanResult }>("POST", `${P}/suggest`, ask)).plan;
        expect(again.suggestions.map((s) => s.title)).toEqual(["Later"]);
    });

    it("leaves leave days and public holidays out of suggestions", async () => {
        // Labour Day 2027 (Monday 4 October) has no planning hours with the default Monday–Friday week.
        const t = await createTask({ title: "Quarterly review", dueDate: "2027-10-08" });
        const plan = (await ok<{ plan: DayPlan }>("GET", `${P}/day?date=2027-10-04`)).plan;
        expect(plan.capacity).toMatchObject({ status: "off", offReason: "Labour Day", workingMinutes: 0 });
        const suggested = (await ok<{ plan: PlanResult }>("POST", `${P}/suggest`, { from: "2027-10-04", days: 1, taskIds: [t.id] })).plan;
        expect(suggested.suggestions).toEqual([]);
        expect(suggested.unplaced[0].taskId).toBe(t.id);
    });
});

describe("private feeds", () => {
    it("publishes your blocks only when chosen, as Busy or Focus time, never the task's title", async () => {
        await apiCall("PUT", "/api/portal/flags/calendar.feeds", { enabled: true });
        const t = await createTask({ title: "Secret surprise party planning" });
        await block({ taskId: t.id, startDate: soon(), startTime: "09:00", durationMinutes: 60 });
        const feed = async (timeBlocks?: string) => {
            const created = await ok<{ address: string }>("POST", `${C}/feeds`, {
                name: "Work",
                scope: { calendarIds: [], leave: true, tasks: "none", detail: "full" },
                ...(timeBlocks ? { timeBlocks } : {}),
            });
            const token = /\/calendar\/feed\/([^.]+)\.ics$/.exec(created.address)![1];
            return (await rawCall(`/calendar/feed/${token}.ics`, { token: null })).text();
        };
        expect(await feed()).not.toContain("planner.daly.id.au");
        const focus = await feed("focus");
        expect(focus).toMatch(/SUMMARY:Focus time[\s\S]*CLASS:PRIVATE/);
        expect(focus).toContain("@planner.daly.id.au");
        const busy = await feed("busy");
        expect(busy).toContain("SUMMARY:Busy");
        for (const text of [focus, busy]) expect(text).not.toContain("Secret surprise");
        // An option that publishes only time blocks is allowed; nothing at all isn't.
        expect(
            (await req("POST", `${C}/feeds`, { name: "Blocks", scope: { calendarIds: [], leave: false, tasks: "none", detail: "busy" }, timeBlocks: "focus" }))
                .status,
        ).toBe(201);
        expect((await req("POST", `${C}/feeds`, { name: "Empty", scope: { calendarIds: [], leave: false, tasks: "none", detail: "busy" } })).status).toBe(422);
    });
});

describe("MCP and Chief of Staff", () => {
    it("reads the day, suggests without writing, schedules through the ledger and replays a retry", async () => {
        await everyDay();
        const t = await createTask({ title: "Draft newsletter", dueDate: soon() });
        const day = await mcp<{ capacity: unknown; dueNotPlanned: { id: string }[] }>("planner_get_day", { date: soon() });
        expect(day.ok).toBe(true);
        expect(day.data.capacity).toBeTruthy();
        const suggested = await mcp<{ suggestions: { taskId: string; date: string; start: string; minutes: number }[] }>("planner_suggest_slots", {
            from: soon(),
            taskIds: [t.id],
        });
        expect(suggested.data.suggestions[0].taskId).toBe(t.id);
        expect(await blockCount()).toBe(0);
        const s = suggested.data.suggestions[0];
        const input = { taskId: t.id, startDate: s.date, startTime: s.start, durationMinutes: s.minutes, requestId: "mcp-plan-0001" };
        const created = await mcp<{ block: { id: string; version: number } }>("planner_schedule_task", input);
        expect(created.ok).toBe(true);
        const replay = await mcp<{ replayed: boolean; block: { id: string } }>("planner_schedule_task", input);
        expect(replay.data).toMatchObject({ replayed: true, block: { id: created.data.block.id } });
        expect(await blockCount()).toBe(1);
        const ledger = await db().prepare("SELECT tool, entity_type, entity_id FROM mcp_writes WHERE tool = 'planner_schedule_task'").first();
        expect(ledger).toEqual({ tool: "planner_schedule_task", entity_type: "task_time_block", entity_id: created.data.block.id });
        const cancelled = await mcp<{ block: { status: string } }>("planner_update_block", {
            blockId: created.data.block.id,
            version: 1,
            cancel: true,
            requestId: "mcp-plan-0002",
        });
        expect(cancelled.data.block.status).toBe("cancelled");
        expect((await db().prepare("SELECT source FROM task_time_blocks").first<{ source: string }>())!.source).toBe("mcp");
        // Someone else's task through MCP: not found. No identity argument is accepted.
        const other = await mcp("planner_schedule_task", { taskId: t.id, startDate: soon(), startTime: "09:00", durationMinutes: 30 }, B);
        expect(other.ok).toBe(false);
        // Chief of Staff carries the plan for people with Calendar and Tasks.
        const chief = await mcp<{ planner: { scheduled: unknown[]; note: string } }>("chief_of_staff_daily_context");
        expect(chief.data.planner.note).toMatch(/not scheduled/);
    });
});

describe("pages", () => {
    it("renders the Daily Planner and adds the Tasks panel to day and week views only", async () => {
        const t = await createTask({ title: "Plan me", dueDate: today() });
        const token = await accessToken();
        const planner = await rawCall(`/portal/calendar/planner?date=${today()}`, { token });
        expect(planner.status).toBe(200);
        const page = renderPage(await planner.text());
        expect(page.data.route).toBe("calendar-planner");
        expect(page.html).toContain("Daily planner");
        expect(page.html).toContain("Plan me");
        for (const view of ["day", "week"]) {
            const r = renderPage(await (await rawCall(`/portal/calendar?view=${view}&date=${today()}`, { token })).text());
            const planner = (r.data as { planner: PlannerData | null }).planner;
            expect(
                planner?.lists.tasks.some((x) => x.id === t.id),
                view,
            ).toBe(true);
            expect(r.html).toContain("Tasks to plan");
        }
        const month = renderPage(await (await rawCall(`/portal/calendar?view=month&date=${today()}`, { token })).text());
        expect((month.data as { planner: unknown }).planner).toBeNull();
    });
});
