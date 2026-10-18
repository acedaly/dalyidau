// Two independent people through the full MCP path (gateway → PortalMcpEntrypoint → D1), each with
// their own Access assertion: private records stay private, shared ones are shared exactly as far as
// the membership goes, and nothing about one person leaks into the other's answers. Both are portal
// owners, so an owner role is shown not to open someone else's private data. Every identity and
// record is fictional.
import { beforeEach, describe, expect, it } from "vitest";
import { OWNER, SECOND_OWNER, apiCall, resetPortal } from "../portal-helpers";
import { guardOutbound, session } from "./helpers";

const A = OWNER;
const B = SECOND_OWNER;
const K = "/api/portal/knowledge";
const T = "/api/portal/tasks";

beforeEach(async () => {
    await resetPortal();
    guardOutbound();
});

type Task = { id: string; title: string; version: number; status: string };
type Obj = { id: string; title: string; version: number };

/** Words only A's private records contain. They must never appear in anything B receives. */
const SECRET = ["Zanzibar", "pineapple-lantern"];
const leaks = (value: unknown) => SECRET.filter((word) => JSON.stringify(value).includes(word));

async function privateRecordsOfA() {
    const a = await session(A);
    const task = (await a.ok<{ task: Task }>("tasks_create", { title: "Book Zanzibar flights", description: "pineapple-lantern" })).task;
    const note = (await a.ok<{ object: Obj }>("knowledge_create_object", { title: "Zanzibar plans", text: "The pineapple-lantern idea." })).object;
    return { a, task, note };
}

async function sharedProject(role: "editor" | "viewer") {
    const project = await apiCall<{ project: { id: string } }>("POST", `${T}/projects`, { name: "Household", kind: "shared" }, { email: A });
    expect(project.status, project.text).toBe(201);
    const added = await apiCall("POST", `${T}/projects/${project.json.project.id}/members`, { email: B, role }, { email: A });
    expect(added.status, added.text).toBe(201);
    return project.json.project.id;
}

async function sharedSpace(role: "editor" | "viewer") {
    const space = await apiCall<{ space: { id: string } }>("POST", `${K}/spaces`, { name: "Household notes" }, { email: A });
    expect(space.status, space.text).toBe(201);
    const added = await apiCall("POST", `${K}/spaces/${space.json.space.id}/members`, { email: B, role }, { email: A });
    expect(added.status, added.text).toBe(201);
    return space.json.space.id;
}

describe("private records", () => {
    it("B can't read A's private task or note by id, list, search or briefing", async () => {
        const { task, note } = await privateRecordsOfA();
        const b = await session(B);

        for (const [tool, args] of [
            ["tasks_get", { taskId: task.id }],
            ["knowledge_get_object", { objectId: note.id }],
            ["knowledge_get_related", { objectId: note.id }],
        ] as const) {
            const answer = await b.tool(tool, args);
            expect(answer.isError, tool).toBe(true);
            expect(answer.data.error?.code, tool).toBe("not_found");
            expect(leaks(answer), tool).toEqual([]);
        }

        for (const [tool, args] of [
            ["tasks_list", { status: "all" }],
            ["tasks_today", {}],
            ["tasks_upcoming", { days: 31 }],
            ["tasks_overdue", {}],
            ["tasks_search", { query: "Zanzibar" }],
            ["tasks_list_projects", {}],
            ["knowledge_search", { query: "Zanzibar" }],
            ["knowledge_search", { query: "pineapple" }],
            ["knowledge_list_objects", {}],
            ["knowledge_list_spaces", {}],
            ["chief_of_staff_daily_context", {}],
            ["chief_of_staff_weekly_context", {}],
        ] as const) {
            const answer = await b.ok(tool, args);
            expect(leaks(answer), tool).toEqual([]);
        }
    });

    it("A still sees their own records through the same tools", async () => {
        const { a, task, note } = await privateRecordsOfA();
        expect((await a.ok<{ task: Task }>("tasks_get", { taskId: task.id })).task.title).toBe("Book Zanzibar flights");
        expect((await a.ok<{ results: Obj[] }>("knowledge_search", { query: "pineapple" })).results.map((r) => r.id)).toContain(note.id);
        expect(JSON.stringify(await a.ok("chief_of_staff_daily_context"))).toContain("Zanzibar");
    });

    it("B can't change, complete, comment on or link A's private records", async () => {
        const { a, task, note } = await privateRecordsOfA();
        const b = await session(B);
        for (const [tool, args] of [
            ["tasks_update", { taskId: task.id, version: task.version, title: "Hijacked" }],
            ["tasks_reschedule", { taskId: task.id, dueDate: "2030-01-01" }],
            ["tasks_complete", { taskId: task.id }],
            ["tasks_reopen", { taskId: task.id }],
            ["tasks_add_comment", { taskId: task.id, body: "Hijacked" }],
            ["knowledge_update_object", { objectId: note.id, version: note.version, title: "Hijacked" }],
            ["knowledge_append_to_object", { objectId: note.id, text: "Hijacked" }],
        ] as const) {
            const answer = await b.tool(tool, args);
            expect(answer.isError, tool).toBe(true);
            expect(answer.data.error?.code, tool).toBe("not_found");
        }
        // B can't link A's private note to B's own task either: reading the object is required.
        const own = (await b.ok<{ task: Task }>("tasks_create", { title: "Mine" })).task;
        const link = await b.tool("tasks_link_knowledge", { taskId: own.id, objectId: note.id });
        expect(link.isError).toBe(true);

        const after = await a.ok<{ task: Task; comments: unknown[] }>("tasks_get", { taskId: task.id });
        expect(after.task.title).toBe("Book Zanzibar flights");
        expect(after.task.status).toBe("open");
        expect(after.comments).toHaveLength(0);
        expect((await a.ok<{ object: Obj & { content: string } }>("knowledge_get_object", { objectId: note.id })).object.content).not.toContain("Hijacked");
    });

    it("identity comes only from the assertion: arguments can't name someone else", async () => {
        const b = await session(B);
        for (const extra of [{ email: A }, { user: A }, { owner: A }, { actor: A }]) {
            const answer = await b.tool("tasks_create", { title: "As A", ...extra });
            expect(answer.isError || !!answer.rpcError).toBe(true);
        }
        const a = await session(A);
        expect(JSON.stringify(await a.ok("tasks_search", { query: "As A" }))).not.toContain("As A");
    });

    it("the same requestId from two people creates two separate records and replays neither across them", async () => {
        const a = await session(A);
        const b = await session(B);
        const first = (await a.ok<{ task: Task }>("tasks_create", { title: "Zanzibar visa", requestId: "shared-request-0001" })).task;
        const second = await b.ok<{ task: Task; replayed?: boolean }>("tasks_create", { title: "B's own task", requestId: "shared-request-0001" });
        expect(second.task.id).not.toBe(first.id);
        expect(second.task.title).toBe("B's own task");
        expect(leaks(second)).toEqual([]);
        // A's retry still replays A's own record.
        const retry = await a.ok<{ task: Task; replayed?: boolean }>("tasks_create", { title: "Zanzibar visa", requestId: "shared-request-0001" });
        expect(retry.task.id).toBe(first.id);
    });
});

describe("shared records", () => {
    it("a shared project's tasks are visible and editable by an editor, and private tasks beside them stay private", async () => {
        const projectId = await sharedProject("editor");
        const { a } = await privateRecordsOfA();
        const shared = (await a.ok<{ task: Task }>("tasks_create", { title: "Clean gutters", projectId })).task;

        const b = await session(B);
        expect((await b.ok<{ task: Task }>("tasks_get", { taskId: shared.id })).task.title).toBe("Clean gutters");
        expect((await b.ok<{ tasks: Task[] }>("tasks_list", { projectIds: [projectId] })).tasks.map((t) => t.id)).toEqual([shared.id]);
        await b.ok("tasks_add_comment", { taskId: shared.id, body: "On it" });
        await b.ok("tasks_complete", { taskId: shared.id });
        expect((await a.ok<{ task: Task }>("tasks_get", { taskId: shared.id })).task.status).toBe("completed");
        expect(leaks(await b.ok("tasks_list", { status: "all" }))).toEqual([]);
    });

    it("a viewer can read a shared task but not change it", async () => {
        const projectId = await sharedProject("viewer");
        const a = await session(A);
        const shared = (await a.ok<{ task: Task }>("tasks_create", { title: "Pay rates", projectId })).task;
        const b = await session(B);
        expect((await b.ok<{ task: Task }>("tasks_get", { taskId: shared.id })).task.title).toBe("Pay rates");
        for (const [tool, args] of [
            ["tasks_complete", { taskId: shared.id }],
            ["tasks_update", { taskId: shared.id, version: shared.version, title: "Changed" }],
            ["tasks_add_comment", { taskId: shared.id, body: "x" }],
            ["tasks_create", { title: "Into a viewer project", projectId }],
        ] as const) {
            const answer = await b.tool(tool, args);
            expect(answer.isError, tool).toBe(true);
            expect(["forbidden", "not_found", "validation"], tool).toContain(answer.data.error?.code);
        }
        expect((await a.ok<{ task: Task }>("tasks_get", { taskId: shared.id })).task.status).toBe("open");
    });

    it("a shared Knowledge space is readable and appendable by an editor; A's personal space isn't", async () => {
        const spaceId = await sharedSpace("editor");
        const { a, note } = await privateRecordsOfA();
        const shared = (await a.ok<{ object: Obj }>("knowledge_create_object", { spaceId, title: "Bin day", text: "Tuesday night." })).object;

        const b = await session(B);
        expect((await b.ok<{ object: Obj }>("knowledge_get_object", { objectId: shared.id })).object.title).toBe("Bin day");
        expect((await b.ok<{ results: Obj[] }>("knowledge_search", { query: "Tuesday" })).results.map((r) => r.id)).toEqual([shared.id]);
        await b.ok("knowledge_append_to_object", { objectId: shared.id, text: "Recycling too." });
        const spaces = (await b.ok<{ spaces: { id: string; kind: string }[] }>("knowledge_list_spaces")).spaces;
        expect(spaces.map((s) => s.id)).toContain(spaceId);
        expect((await b.tool("knowledge_get_object", { objectId: note.id })).data.error?.code).toBe("not_found");
        // B can't write into A's personal space by naming it.
        const personalOfA = (await a.ok<{ spaces: { id: string; kind: string }[] }>("knowledge_list_spaces")).spaces.find((s) => s.kind === "personal")!;
        const intrusion = await b.tool("knowledge_create_object", { spaceId: personalOfA.id, title: "Intrusion" });
        expect(intrusion.isError).toBe(true);
        expect(intrusion.data.error?.code).toBe("not_found");
    });

    it("a private note linked to a shared task shows to B only as unavailable, with no title", async () => {
        const projectId = await sharedProject("editor");
        const { a, note } = await privateRecordsOfA();
        const shared = (await a.ok<{ task: Task }>("tasks_create", { title: "Plan trip", projectId, knowledgeObjectIds: [note.id] })).task;
        const b = await session(B);
        const seen = await b.ok<{ knowledge: { available: boolean }[] }>("tasks_get", { taskId: shared.id });
        expect(seen.knowledge).toEqual([{ available: false }]);
        expect(leaks(seen)).toEqual([]);
        expect(JSON.stringify(seen)).not.toContain(note.id);
    });

    it("removing B from a shared project or space cuts off access on the very next call", async () => {
        const projectId = await sharedProject("editor");
        const spaceId = await sharedSpace("editor");
        const a = await session(A);
        const task = (await a.ok<{ task: Task }>("tasks_create", { title: "Shared chore", projectId })).task;
        const obj = (await a.ok<{ object: Obj }>("knowledge_create_object", { spaceId, title: "Shared note" })).object;
        const b = await session(B);
        await b.ok("tasks_get", { taskId: task.id });
        await b.ok("knowledge_get_object", { objectId: obj.id });

        expect((await apiCall("DELETE", `${T}/projects/${projectId}/members/${encodeURIComponent(B)}`, undefined, { email: A })).status).toBe(200);
        expect((await apiCall("DELETE", `${K}/spaces/${spaceId}/members/${encodeURIComponent(B)}`, undefined, { email: A })).status).toBeLessThan(300);

        expect((await b.tool("tasks_get", { taskId: task.id })).data.error?.code).toBe("not_found");
        expect((await b.tool("knowledge_get_object", { objectId: obj.id })).data.error?.code).toBe("not_found");
        expect(JSON.stringify(await b.ok("tasks_list", { status: "all" }))).not.toContain("Shared chore");
    });
});

describe("people without access", () => {
    it("a verified Access identity with no portal role gets no data from any tool", async () => {
        await privateRecordsOfA();
        const stranger = await session("stranger@example.com");
        // The gateway lists the tools (Access admitted them); the portal refuses every call.
        for (const tool of ["tasks_today", "knowledge_list_spaces", "chief_of_staff_daily_context"]) {
            const answer = await stranger.tool(tool);
            expect(answer.isError, tool).toBe(true);
            expect(answer.data.error?.code, tool).toBe("forbidden");
            expect(leaks(answer)).toEqual([]);
        }
    });

    it("an Access service token (no email) can't use the portal", async () => {
        const service = await session(null);
        const answer = await service.tool("tasks_today");
        expect(answer.isError).toBe(true);
        expect(answer.data.error?.code).toBe("unauthenticated");
    });
});
