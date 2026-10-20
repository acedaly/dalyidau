// The MCP gateway's portal entrypoint (worker/mcp), through the real Tasks and Knowledge services and
// the local database: who may call it, what each person can see and change, retry safety, recurring
// tasks, Knowledge documents and the Chief of Staff context. Every identity and record is fictional.
import { createExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { localDate } from "../src/shared/knowledge/dates";
import { addDays } from "../src/shared/tasks/dates";
import type { Env } from "../worker/env";
import worker, { PortalMcpEntrypoint } from "../worker/index";
import { PORTAL_MCP_TOOLS, type PortalMcpResponse, handleMcpCall } from "../worker/mcp/entrypoint";
import { addPortalUser, create as createObject, doc, paragraph, personal, sharedSpace, text } from "./knowledge-helpers";
import { AUD, OWNER, SECOND_OWNER, accessToken, apiCall, db, portalEnv, resetPortal } from "./portal-helpers";
import { ADMIN, WEDDING_EDITOR, call, createProject, createTask, sharedProject } from "./tasks-helpers";

const MCP_AUD = "aud-mcp-gateway-0123456789abcdef";
const A = OWNER;
const B = SECOND_OWNER; // the other portal owner: an owner role must still not open A's private records

beforeEach(resetPortal);

const mcpEnv = (overrides: Partial<Env> = {}) => portalEnv({ MCP_ACCESS_AUD: MCP_AUD, ...overrides });
const today = () => localDate(new Date(), "Australia/Sydney");

/** Calls a tool as `email`, with a freshly signed token for the MCP Access application. */
async function mcp<T = Record<string, unknown>>(tool: string, input: unknown = {}, email = A, options: { env?: Env; assertion?: string } = {}) {
    const assertion = options.assertion ?? (await accessToken({ email, aud: [MCP_AUD] }));
    const response = await handleMcpCall(options.env ?? (await mcpEnv()), { assertion, tool, input });
    return response as PortalMcpResponse & { data: T };
}

async function ok<T = Record<string, unknown>>(tool: string, input: unknown = {}, email = A): Promise<T> {
    const response = await mcp<T>(tool, input, email);
    expect(response.ok, JSON.stringify(response)).toBe(true);
    return (response as { data: T }).data;
}

async function refused(tool: string, input: unknown, email: string, code: string) {
    const response = await mcp(tool, input, email);
    expect(response.ok, JSON.stringify(response)).toBe(false);
    if (!response.ok) expect(response.error.code).toBe(code);
    return response;
}

const ledger = async () => (await db().prepare("SELECT * FROM mcp_writes ORDER BY created_at, id").all<Record<string, string | null>>()).results;

type TaskOut = { id: string; title: string; dueDate: string | null; status: string; version: number; projectName: string | null };

describe("who may call the portal through the MCP gateway", () => {
    it("refuses a missing, forged, expired or wrong-audience token before touching any data", async () => {
        const forged = await accessToken({ email: A, aud: [MCP_AUD], key: "other" });
        const expired = await accessToken({ email: A, aud: [MCP_AUD], expiresIn: -3600 });
        // A token for the portal's own Access application is not a token for the MCP application.
        const portalToken = await accessToken({ email: A, aud: [AUD] });
        const noEmail = await accessToken({ email: null, aud: [MCP_AUD] });
        for (const assertion of ["", "not-a-jwt", forged, expired, portalToken, noEmail]) {
            const response = await mcp("tasks_today", {}, A, { assertion });
            expect(response.ok).toBe(false);
            if (!response.ok) expect(response.error.code).toBe("unauthenticated");
        }
        expect(await ledger()).toHaveLength(0);
    });

    it("fails closed when the MCP audience isn't configured", async () => {
        const response = await mcp("tasks_today", {}, A, { env: await portalEnv() });
        expect(response.ok).toBe(false);
        if (!response.ok) expect(response.error.code).toBe("unauthenticated");
    });

    it("refuses the local development identity outside local development", async () => {
        const response = await mcp("tasks_today", {}, A, { assertion: "development", env: await mcpEnv({ ACCESS_DEV_EMAIL: A }) });
        expect(response.ok).toBe(false);
    });

    it("refuses a verified person with no portal role, or an inactive one", async () => {
        await refused("tasks_today", {}, "stranger@example.com", "forbidden");
        await addPortalUser(ADMIN, "admin");
        expect((await mcp("tasks_today", {}, ADMIN)).ok).toBe(true);
        await db().prepare("UPDATE portal_users SET active = 0 WHERE email = ?").bind(ADMIN).run();
        await refused("tasks_today", {}, ADMIN, "forbidden");
    });

    it("needs the application's permission: a wedding editor can't use Tasks or Knowledge", async () => {
        await addPortalUser(WEDDING_EDITOR, "editor");
        await refused("tasks_today", {}, WEDDING_EDITOR, "forbidden");
        await refused("knowledge_search", { query: "x" }, WEDDING_EDITOR, "forbidden");
        await refused("chief_of_staff_daily_context", {}, WEDDING_EDITOR, "forbidden");
    });

    it("never takes identity from the arguments", async () => {
        const response = await refused("tasks_create", { title: "Pretend to be B", email: B }, A, "validation");
        expect(JSON.stringify(response)).not.toContain(B);
        const task = (await ok<{ task: TaskOut }>("tasks_create", { title: "Mine" }, A)).task;
        const row = await db().prepare("SELECT created_by FROM task_items WHERE id = ?").bind(task.id).first<{ created_by: string }>();
        expect(row?.created_by).toBe(A);
    });

    it("refuses unknown tools and oversized or malformed arguments", async () => {
        await refused("run_sql", { sql: "SELECT 1" }, A, "unknown_tool");
        await refused("tasks_search", { query: "x".repeat(70_000) }, A, "too_large");
        await refused("tasks_upcoming", { days: 400 }, A, "validation");
        const bad = await refused("tasks_create", { title: "Dated", dueDate: "next tuesday" }, A, "validation");
        if (!bad.ok) expect(bad.error.details?.issues).toBeDefined();
    });

    it("is exported as the Worker's named entrypoint, and works through it", async () => {
        expect(typeof PortalMcpEntrypoint).toBe("function");
        expect(typeof worker.fetch).toBe("function");
        const entrypoint = new PortalMcpEntrypoint(createExecutionContext(), await mcpEnv());
        const response = await entrypoint.invoke({ assertion: await accessToken({ email: A, aud: [MCP_AUD] }), tool: "tasks_today", input: {} });
        expect(response.ok).toBe(true);
    });

    it("serves exactly these 101 tools (the gateway side is compared directly in mcp-contract.test.ts)", () => {
        // The gateway side (mcp/src/portal-tools.ts) is compared with this field by field in mcp-contract.test.ts.
        expect(PORTAL_MCP_TOOLS.map((t) => t.name).sort()).toEqual(
            [
                "knowledge_list_spaces",
                "knowledge_list_types",
                "knowledge_search",
                "knowledge_get_object",
                "knowledge_list_objects",
                "knowledge_get_related",
                "knowledge_get_daily_note",
                "knowledge_create_object",
                "knowledge_update_object",
                "knowledge_append_to_object",
                "knowledge_create_daily_note",
                "tasks_list",
                "tasks_get",
                "tasks_today",
                "tasks_upcoming",
                "tasks_overdue",
                "tasks_search",
                "tasks_list_projects",
                "tasks_project_summary",
                "tasks_list_goals",
                "tasks_get_goal",
                "tasks_list_routines",
                "tasks_create",
                "tasks_update",
                "tasks_reschedule",
                "tasks_complete",
                "tasks_reopen",
                "tasks_add_comment",
                "tasks_link_knowledge",
                "tasks_search_projects",
                "tasks_create_project",
                "tasks_update_project",
                "tasks_archive_project",
                "tasks_unarchive_project",
                "chief_of_staff_daily_context",
                "chief_of_staff_weekly_context",
                "knowledge_semantic_search",
                "knowledge_find_related",
                "intelligence_get_daily_briefing",
                "intelligence_get_weekly_review",
                "intelligence_list_suggestions",
                "intelligence_get_processing_status",
                "meetings_get_transcript",
                "intelligence_capture_text",
                "intelligence_request_analysis",
                "intelligence_approve_suggestion",
                "calendar_list_calendars",
                "calendar_list_events",
                "calendar_search_events",
                "calendar_get_agenda",
                "calendar_find_conflicts",
                "calendar_list_subscriptions",
                "calendar_school_holidays",
                "leave_get_balances",
                "leave_list_bookings",
                "leave_forecast",
                "leave_find_opportunities",
                "calendar_create_event",
                "calendar_update_event",
                "calendar_create_subscription",
                "calendar_refresh_subscription",
                "leave_create_proposal",
                "leave_update_proposal",
                "planner_get_day",
                "planner_suggest_slots",
                "planner_schedule_task",
                "planner_update_block",
                "today_get_summary",
                "today_get_capacity",
                "today_list_unscheduled",
                "today_propose_plan",
                "today_get_conflicts",
                "today_get_briefing",
                "centre_list_sources",
                "centre_get_source_health",
                "centre_get_situation",
                "centre_search_incidents",
                "centre_get_record",
                "centre_search_warnings",
                "centre_get_fire_danger",
                "centre_get_observations",
                "centre_list_road_disruptions",
                "centre_list_watch_areas",
                "centre_list_changes",
                "centre_get_watch_briefing",
                "assets_search",
                "assets_list",
                "assets_get",
                "assets_maintenance_history",
                "assets_upcoming_maintenance",
                "assets_insurance_renewals",
                "assets_warranty_expiries",
                "assets_list_documents",
                "assets_summary",
                "assets_get_attention",
                "assets_create",
                "assets_update",
                "assets_create_maintenance",
                "assets_complete_maintenance",
                "assets_link_knowledge",
                "assets_create_task",
            ].sort(),
        );
        const writes = PORTAL_MCP_TOOLS.filter((t) => t.write).map((t) => t.name);
        expect(
            writes.every((n) =>
                /_(create|update|append|reschedule|schedule|complete|reopen|add_comment|link_knowledge|archive|unarchive|capture_text|request_analysis|approve_suggestion|refresh)/.test(
                    n,
                ),
            ),
        ).toBe(true);
        expect(writes).toHaveLength(32);
    });

    it("publishes no destructive, bulk, sharing or administrative tool", () => {
        const names = PORTAL_MCP_TOOLS.map((t) => t.name);
        expect(new Set(names).size).toBe(names.length);
        for (const name of names) expect(name).not.toMatch(/delete|destroy|purge|trash|bulk|sql|export|member|share|admin|secret|import/);
    });
});

describe("personal and shared Tasks", () => {
    it("keeps one person's private tasks invisible to the other, owner role or not", async () => {
        const task = (await ok<{ task: TaskOut }>("tasks_create", { title: "Book the dentist privately", dueDate: today() }, A)).task;
        await refused("tasks_get", { taskId: task.id }, B, "not_found");
        await refused("tasks_update", { taskId: task.id, version: 1, title: "Changed" }, B, "not_found");
        await refused("tasks_complete", { taskId: task.id }, B, "not_found");
        await refused("tasks_add_comment", { taskId: task.id, body: "Hi" }, B, "not_found");
        const searched = await ok<{ tasks: TaskOut[] }>("tasks_search", { query: "dentist" }, B);
        expect(searched.tasks).toHaveLength(0);
        const daily = await ok("chief_of_staff_daily_context", {}, B);
        expect(JSON.stringify(daily)).not.toContain("dentist");
        // A's own view has it.
        expect((await ok<{ tasks: TaskOut[] }>("tasks_today", {}, A)).tasks.map((t) => t.id)).toContain(task.id);
    });

    it("shares a project only with its members, honours viewer roles and removal at once", async () => {
        const project = await sharedProject("viewer", "Household chores");
        const task = await createTask({ title: "Clean the gutters", projectId: project.id });
        expect((await ok<{ task: TaskOut }>("tasks_get", { taskId: task.id }, B)).task.title).toBe("Clean the gutters");
        await refused("tasks_complete", { taskId: task.id }, B, "forbidden");
        await refused("tasks_create", { title: "Sneaky", projectId: project.id }, B, "forbidden");

        await call("PATCH", `/projects/${project.id}/members/${encodeURIComponent(B)}`, { role: "editor" });
        expect((await ok<{ task: TaskOut }>("tasks_complete", { taskId: task.id }, B)).task.status).toBe("completed");

        const removed = await call("DELETE", `/projects/${project.id}/members/${encodeURIComponent(B)}`);
        expect(removed.status, removed.text).toBe(200);
        await refused("tasks_get", { taskId: task.id }, B, "not_found");
        await refused("tasks_project_summary", { projectId: project.id }, B, "not_found");
        expect((await ok<{ projects: { id: string }[] }>("tasks_list_projects", {}, B)).projects.map((p) => p.id)).not.toContain(project.id);
    });

    it("never creates a task in someone else's private project", async () => {
        const project = await createProject({ name: "A's private plans" });
        await refused("tasks_create", { title: "Intrude", projectId: project.id }, B, "not_found");
        expect((await db().prepare("SELECT COUNT(*) AS n FROM task_items WHERE project_id = ?").bind(project.id).first<{ n: number }>())?.n).toBe(0);
    });

    it("doesn't leak a private Knowledge title through a shared task's reference", async () => {
        const project = await sharedProject("editor", "Renovation");
        const space = await personal(A);
        const secret = await createObject(space.id, { title: "Private budget worries", content: doc("Only for A") });
        const task = await createTask({ title: "Get quotes", projectId: project.id, knowledge: [secret.object.id] });
        const seen = await ok<{ knowledge: { available: boolean; title?: string }[] }>("tasks_get", { taskId: task.id }, B);
        expect(seen.knowledge).toEqual([{ available: false }]);
        expect(JSON.stringify(seen)).not.toContain("Private budget worries");
        // Nor can B link a task to it: Knowledge's own check answers "not found".
        await refused("tasks_link_knowledge", { taskId: task.id, objectId: secret.object.id }, B, "not_found");
        const summary = await ok("tasks_project_summary", { projectId: project.id }, B);
        expect(JSON.stringify(summary)).not.toContain("Private budget worries");
    });
});

describe("Tasks tools", () => {
    it("creates in the caller's Inbox by default, and a retried request id never makes a second task", async () => {
        const first = await ok<{ task: TaskOut; replayed: boolean }>("tasks_create", { title: "Renew rego", requestId: "req-renew-rego-1" });
        expect(first.task.projectName).toBe("Inbox");
        const again = await ok<{ task: TaskOut; replayed: boolean }>("tasks_create", { title: "Renew rego", requestId: "req-renew-rego-1" });
        expect(again.task.id).toBe(first.task.id);
        expect(again.replayed).toBe(true);
        expect((await db().prepare("SELECT COUNT(*) AS n FROM task_items WHERE title = 'Renew rego'").first<{ n: number }>())?.n).toBe(1);
        // A request id belongs to one action.
        await refused("tasks_reopen", { taskId: first.task.id, requestId: "req-renew-rego-1" }, A, "request_id_reused");
        // The same id from another person is theirs, not A's.
        const other = await ok<{ task: TaskOut }>("tasks_create", { title: "B's rego", requestId: "req-renew-rego-1" }, B);
        expect(other.task.id).not.toBe(first.task.id);
    });

    it("refuses a stale update and says which version is current", async () => {
        const { task } = await ok<{ task: TaskOut }>("tasks_create", { title: "Draft the speech" });
        await ok("tasks_update", { taskId: task.id, version: task.version, priority: 1 });
        const stale = await refused("tasks_update", { taskId: task.id, version: task.version, title: "Overwritten" }, A, "conflict");
        if (!stale.ok) expect((stale.error.details?.current as { version: number }).version).toBe(task.version + 1);
        expect((await ok<{ task: TaskOut & { priority: number } }>("tasks_get", { taskId: task.id })).task.title).toBe("Draft the speech");
    });

    it("completes a recurring task's occurrence exactly once, then reopens it", async () => {
        const due = today();
        const { task } = await ok<{ task: TaskOut }>("tasks_create", { title: "Put the bins out", dueDate: due, recurrence: { freq: "weekly" } });
        const done = await ok<{ task: TaskOut; nextDate: string; alreadyDone: boolean }>("tasks_complete", { taskId: task.id, occurrence: due });
        expect(done.nextDate).toBe(addDays(due, 7));
        expect(done.task.status).toBe("open");
        // The same click again (a retry without a request id) doesn't advance it a second time.
        const repeat = await ok<{ task: TaskOut; alreadyDone: boolean }>("tasks_complete", { taskId: task.id, occurrence: due });
        expect(repeat.alreadyDone).toBe(true);
        expect(repeat.task.dueDate).toBe(addDays(due, 7));
        const reopened = await ok<{ task: TaskOut }>("tasks_reopen", { taskId: task.id });
        expect(reopened.task.dueDate).toBe(due);
    });

    it("asks before completing a task with open subtasks", async () => {
        const { task } = await ok<{ task: TaskOut }>("tasks_create", { title: "Plan the trip" });
        await ok("tasks_create", { title: "Book flights", parentId: task.id });
        const asked = await refused("tasks_complete", { taskId: task.id }, A, "open_subtasks");
        if (!asked.ok) expect(asked.error.details?.count).toBe(1);
        expect((await ok<{ task: TaskOut }>("tasks_complete", { taskId: task.id, includeSubtasks: true })).task.status).toBe("completed");
    });

    it("reschedules only the dates, and comments and links within both permission systems", async () => {
        const { task } = await ok<{ task: TaskOut }>("tasks_create", { title: "Call the plumber", dueDate: today() });
        const moved = await ok<{ task: TaskOut }>("tasks_reschedule", { taskId: task.id, dueDate: addDays(today(), 3) });
        expect(moved.task.dueDate).toBe(addDays(today(), 3));
        expect(moved.task.title).toBe("Call the plumber");
        const commented = await ok<{ comment: { id: string } }>("tasks_add_comment", { taskId: task.id, body: "They prefer mornings" });
        expect(commented.comment.id).toBeTruthy();
        const note = await createObject((await personal(A)).id, { title: "Plumber quotes" });
        expect((await ok<{ linked: boolean }>("tasks_link_knowledge", { taskId: task.id, objectId: note.object.id })).linked).toBe(true);
        const detail = await ok<{ knowledge: { available: boolean; title: string }[]; comments: { body: string }[] }>("tasks_get", { taskId: task.id });
        expect(detail.knowledge[0]).toMatchObject({ available: true, title: "Plumber quotes" });
        expect(detail.comments.map((c) => c.body)).toEqual(["They prefer mornings"]);
    });

    it("puts today, overdue and upcoming on the right days in the person's own time zone", async () => {
        await call("PATCH", "/preferences", { timeZone: "Pacific/Auckland" });
        const local = localDate(new Date(), "Pacific/Auckland");
        await ok("tasks_create", { title: "Due today", dueDate: local });
        await ok("tasks_create", { title: "Was due yesterday", dueDate: addDays(local, -1) });
        await ok("tasks_create", { title: "Due in three days", dueDate: addDays(local, 3) });
        const todayList = await ok<{ today: string; tasks: TaskOut[] }>("tasks_today");
        expect(todayList.today).toBe(local);
        expect(todayList.tasks.map((t) => t.title).sort()).toEqual(["Due today", "Was due yesterday"]);
        expect((await ok<{ tasks: TaskOut[] }>("tasks_overdue")).tasks.map((t) => t.title)).toEqual(["Was due yesterday"]);
        const upcoming = await ok<{ tasks: TaskOut[] }>("tasks_upcoming", { days: 7 });
        expect(upcoming.tasks.map((t) => t.title)).toEqual(["Due today", "Due in three days"]);
        const filtered = await ok<{ tasks: TaskOut[]; hasMore: boolean }>("tasks_list", { due: "overdue" });
        expect(filtered.tasks.map((t) => t.title)).toEqual(["Was due yesterday"]);
    });

    it("summarises a project with its overdue work and health", async () => {
        const project = await createProject({ name: "Garden" });
        await createTask({ title: "Prune roses", projectId: project.id, dueDate: addDays(today(), -2) });
        await createTask({ title: "Order mulch", projectId: project.id, dueDate: addDays(today(), 2) });
        const summary = await ok<{ project: { name: string }; overdue: { count: number }; upcoming14Days: { count: number }; health: { status: string } }>(
            "tasks_project_summary",
            { projectId: project.id },
        );
        expect(summary.project.name).toBe("Garden");
        expect(summary.overdue.count).toBe(1);
        expect(summary.upcoming14Days.count).toBe(1);
        expect(summary.health.status).not.toBe("on_track");
    });
});

describe("Knowledge tools", () => {
    it("keeps private spaces private and enforces shared-space roles and removal", async () => {
        const mine = await personal(A);
        const secret = await createObject(mine.id, { title: "Hydrangea pruning secrets", content: doc("cut in late winter") });
        await refused("knowledge_get_object", { objectId: secret.object.id }, B, "not_found");
        await refused("knowledge_append_to_object", { objectId: secret.object.id, text: "Hi" }, B, "not_found");
        await refused("knowledge_get_related", { objectId: secret.object.id }, B, "not_found");
        await refused("knowledge_list_objects", { spaceId: mine.id }, B, "not_found");
        expect((await ok<{ results: unknown[] }>("knowledge_search", { query: "hydrangea" }, B)).results).toHaveLength(0);
        expect((await ok<{ results: unknown[] }>("knowledge_search", { query: "hydrangea" }, A)).results).toHaveLength(1);

        const shared = await sharedSpace("viewer", "Household notes");
        const note = await createObject(shared.id, { title: "Bin collection days" });
        expect((await ok<{ object: { title: string } }>("knowledge_get_object", { objectId: note.object.id }, ADMIN)).object.title).toBe("Bin collection days");
        await refused("knowledge_append_to_object", { objectId: note.object.id, text: "Tuesday" }, ADMIN, "forbidden");
        await refused("knowledge_create_object", { spaceId: shared.id, title: "New" }, ADMIN, "forbidden");
        const removed = await apiCall("DELETE", `/api/portal/knowledge/spaces/${shared.id}/members/${encodeURIComponent(ADMIN)}`);
        expect(removed.status, removed.text).toBe(200);
        await refused("knowledge_get_object", { objectId: note.object.id }, ADMIN, "not_found");
    });

    it("creates plain-text objects safely, searches them and never duplicates a retried create", async () => {
        const created = await ok<{ object: { id: string; content: string; type: string; version: number } }>("knowledge_create_object", {
            title: "Ideas for the shed",
            type: "page",
            text: "Pegboard wall\n<script>alert(1)</script> **not bold**",
            tags: ["shed"],
            requestId: "req-shed-ideas-01",
        });
        expect(created.object.type).toBe("Page");
        // Markup in the text stays text: escaped in Markdown, never HTML.
        expect(created.object.content).toContain("\\<script\\>");
        expect(created.object.content).toContain("\\*\\*not bold\\*\\*");
        const stored = await db().prepare("SELECT content_json FROM knowledge_objects WHERE id = ?").bind(created.object.id).first<{ content_json: string }>();
        expect(stored?.content_json).not.toMatch(/"type":"(html|script)/);
        const again = await ok<{ object: { id: string }; replayed: boolean }>("knowledge_create_object", {
            title: "Ideas for the shed",
            requestId: "req-shed-ideas-01",
        });
        expect(again.object.id).toBe(created.object.id);
        expect(again.replayed).toBe(true);
        expect((await db().prepare("SELECT COUNT(*) AS n FROM knowledge_objects WHERE title = 'Ideas for the shed'").first<{ n: number }>())?.n).toBe(1);
        const found = await ok<{ results: { id: string; bodyMatch: string }[] }>("knowledge_search", { query: "pegboard" });
        expect(found.results.map((r) => r.id)).toEqual([created.object.id]);
        expect(found.results[0].bodyMatch).toContain("«");
        await refused("knowledge_create_object", { title: "Typo type", type: "no-such-type" }, A, "validation");
    });

    it("updates with version checks and appends without losing rich content", async () => {
        const space = await personal(A);
        const rich = await createObject(space.id, { title: "Packing list", content: doc(paragraph(text("Passports", [{ type: "bold" }]))) });
        const appended = await ok<{ object: { content: string; version: number } }>("knowledge_append_to_object", {
            objectId: rich.object.id,
            text: "Chargers",
        });
        expect(appended.object.content).toContain("**Passports**");
        expect(appended.object.content).toContain("Chargers");
        await refused("knowledge_update_object", { objectId: rich.object.id, version: rich.object.version, title: "Stale" }, A, "conflict");
        const renamed = await ok<{ object: { title: string; content: string } }>("knowledge_update_object", {
            objectId: rich.object.id,
            version: appended.object.version,
            title: "Packing list (Bali)",
            tags: ["travel"],
        });
        expect(renamed.object.title).toBe("Packing list (Bali)");
        expect(renamed.object.content).toContain("**Passports**");
        // The body can't be replaced through MCP at all.
        await refused("knowledge_update_object", { objectId: rich.object.id, version: 3, content: { type: "doc", content: [] } }, A, "validation");
        await refused("knowledge_append_to_object", { objectId: rich.object.id, text: "Late", version: 1 }, A, "conflict");
    });

    it("reports a missing daily note as missing, then creates exactly one", async () => {
        const date = "2026-10-18";
        const before = await ok<{ exists: boolean }>("knowledge_get_daily_note", { date });
        expect(before.exists).toBe(false);
        const first = await ok<{ object: { id: string } }>("knowledge_create_daily_note", { date, text: "Picked up the suit" });
        const second = await ok<{ object: { id: string; content: string } }>("knowledge_create_daily_note", { date, text: "Booked the car" });
        expect(second.object.id).toBe(first.object.id);
        const after = await ok<{ exists: boolean; object: { content: string } }>("knowledge_get_daily_note", { date });
        expect(after.exists).toBe(true);
        expect(after.object.content).toContain("Picked up the suit");
        expect(after.object.content).toContain("Booked the car");
    });

    it("shows links and backlinks among objects the caller can read", async () => {
        const space = await personal(A);
        const target = await createObject(space.id, { title: "Venue contacts" });
        const source = await createObject(space.id, {
            title: "Wedding logistics",
            content: { type: "doc", content: [paragraph({ type: "objectLink", attrs: { id: target.object.id, label: "Venue contacts" } })] },
        });
        const related = await ok<{ backlinks: { objectId: string }[] }>("knowledge_get_related", { objectId: target.object.id });
        expect(related.backlinks.map((l) => l.objectId)).toEqual([source.object.id]);
    });
});

describe("Chief of Staff context", () => {
    it("reports the person's own recorded facts with counts, sources and nothing invented", async () => {
        await ok("tasks_create", { title: "Pay the electricity bill", dueDate: today(), priority: 1 });
        await ok("tasks_create", { title: "Return library books", dueDate: addDays(today(), -3) });
        await ok("knowledge_create_daily_note", { text: "Feeling on top of things" });
        const context = await ok<{
            checked: { tasks: boolean; knowledge: boolean; calendar: boolean };
            notChecked: string[];
            calendar: { events: { count: number }; failingSubscriptions: unknown[] };
            tasks: {
                today: string;
                dueToday: { count: number; tasks: TaskOut[] };
                overdue: { count: number };
                highPriority: { count: number };
                household: unknown;
            };
            knowledge: { dailyNote: { exists: boolean; content: string } };
        }>("chief_of_staff_daily_context");
        // Calendar is read now (Milestone 6), and Home & Assets (Milestone 10); email and unsubscribed external calendars still never are.
        expect(context.checked).toEqual({ tasks: true, knowledge: true, calendar: true, homeAssets: true });
        expect(context.notChecked).toContain("email");
        expect(context.notChecked).not.toContain("calendar");
        expect(context.calendar.events.count).toBe(0);
        expect(context.calendar.failingSubscriptions).toEqual([]);
        expect(context.tasks.today).toBe(today());
        expect(context.tasks.dueToday.count).toBe(1);
        expect(context.tasks.dueToday.tasks[0].title).toBe("Pay the electricity bill");
        expect(context.tasks.overdue.count).toBe(1);
        expect(context.tasks.highPriority.count).toBe(1);
        expect(context.tasks.household).toBeNull();
        expect(context.knowledge.dailyNote.exists).toBe(true);
        expect(context.knowledge.dailyNote.content).toContain("Feeling on top of things");
        // B sees none of it.
        const theirs = await ok<{ tasks: { dueToday: { count: number } }; knowledge: { dailyNote: { exists: boolean } } }>(
            "chief_of_staff_daily_context",
            {},
            B,
        );
        expect(theirs.tasks.dueToday.count).toBe(0);
        expect(theirs.knowledge.dailyNote.exists).toBe(false);
        expect(JSON.stringify(theirs)).not.toMatch(/electricity|library|top of things/);
    });

    it("includes shared household work only for members, and the week's completions", async () => {
        const project = await sharedProject("editor", "House");
        await createTask({ title: "Service the heater", projectId: project.id, dueDate: today() });
        const { task } = await ok<{ task: TaskOut }>("tasks_create", { title: "Mow the lawn", dueDate: today() });
        await ok("tasks_complete", { taskId: task.id });
        const daily = await ok<{ tasks: { household: { sharedProjects: number; needsAttention: { count: number } } } }>("chief_of_staff_daily_context", {}, B);
        expect(daily.tasks.household.sharedProjects).toBe(1);
        expect(daily.tasks.household.needsAttention.count).toBe(1);
        const weekly = await ok<{ tasks: { completed: { tasks: TaskOut[] }; period: { from: string; to: string } } }>("chief_of_staff_weekly_context");
        expect(weekly.tasks.period.to).toBe(today());
        expect(weekly.tasks.completed.tasks.map((t) => t.title)).toContain("Mow the lawn");
        const theirs = await ok<{ tasks: { completed: { tasks: TaskOut[] } } }>("chief_of_staff_weekly_context", {}, B);
        expect(theirs.tasks.completed.tasks.map((t) => t.title)).not.toContain("Mow the lawn");
    });

    it("leaves out a module the person can't use rather than reporting it empty", async () => {
        await addPortalUser(ADMIN, "admin");
        await db().prepare("UPDATE portal_users SET role = 'editor' WHERE email = ?").bind(ADMIN).run();
        await refused("chief_of_staff_daily_context", {}, ADMIN, "forbidden");
    });
});

describe("the MCP write ledger", () => {
    it("records every write by person, tool and record, without titles or text, and frees a failed request id", async () => {
        const { task } = await ok<{ task: TaskOut }>("tasks_create", { title: "Secret surprise party", requestId: "req-party-0001" });
        await ok("tasks_add_comment", { taskId: task.id, body: "Don't tell anyone" });
        await ok("knowledge_create_object", { title: "Party guest list" });
        const rows = await ledger();
        expect(rows.map((r) => [r.email, r.tool, r.status, r.entity_type])).toEqual([
            [A, "tasks_create", "done", "task"],
            [A, "tasks_add_comment", "done", "task"],
            [A, "knowledge_create_object", "done", "knowledge_object"],
        ]);
        expect(JSON.stringify(rows)).not.toMatch(/Secret|surprise|tell anyone|guest list/);

        await refused("tasks_create", { title: "Bad", dueDate: "2026-02-30", requestId: "req-bad-date-01" }, A, "validation");
        const failedRow = (await ledger()).find((r) => r.status === "failed");
        expect(failedRow?.request_key ?? null).toBeNull();
        // Nothing was written, so the corrected retry with the same id goes ahead.
        await ok("tasks_create", { title: "Good", dueDate: "2026-02-28", requestId: "req-bad-date-01" });
        // Reads aren't writes.
        await ok("tasks_today");
        expect((await ledger()).filter((r) => r.tool === "tasks_today")).toHaveLength(0);
    });
});
