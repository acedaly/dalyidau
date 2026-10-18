// Daly Tasks projects through the MCP gateway's portal entrypoint (worker/mcp/projects.ts): finding,
// creating, editing, archiving and restoring projects with the portal's own rules. Who may do what,
// private projects, spoofed owners, duplicates, retries, versions, what archiving keeps and what the
// audit trail leaves out. Every identity and record is fictional.
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../worker/env";
import { type PortalMcpResponse, handleMcpCall } from "../worker/mcp/entrypoint";
import { matchProject, normaliseName } from "../worker/mcp/projects";
import { K, addPortalUser, create as createObject, doc, personal } from "./knowledge-helpers";
import { OWNER, SECOND_OWNER, accessToken, apiCall, db, portalEnv, resetPortal } from "./portal-helpers";
import { ADMIN, WEDDING_EDITOR, activityRows, call, createProject, createTask, sharedProject } from "./tasks-helpers";

const MCP_AUD = "aud-mcp-gateway-0123456789abcdef";
const A = OWNER;
const B = SECOND_OWNER; // the other portal owner: an owner role must still not open A's private projects

beforeEach(resetPortal);

const mcpEnv = (overrides: Partial<Env> = {}) => portalEnv({ MCP_ACCESS_AUD: MCP_AUD, ...overrides });

async function mcp<T = Record<string, unknown>>(tool: string, input: unknown = {}, email = A) {
    const assertion = await accessToken({ email, aud: [MCP_AUD] });
    return (await handleMcpCall(await mcpEnv(), { assertion, tool, input })) as PortalMcpResponse & { data: T };
}

async function ok<T = Record<string, unknown>>(tool: string, input: unknown = {}, email = A): Promise<T> {
    const response = await mcp<T>(tool, input, email);
    expect(response.ok, JSON.stringify(response)).toBe(true);
    return (response as { data: T }).data;
}

async function refused(tool: string, input: unknown, email: string, code: string) {
    const response = await mcp(tool, input, email);
    expect(response.ok, JSON.stringify(response)).toBe(false);
    if (!response.ok) expect(response.error.code, JSON.stringify(response.error)).toBe(code);
    return response;
}

type ProjectOut = {
    id: string;
    name: string;
    kind: "personal" | "shared";
    isInbox: boolean;
    status: string;
    role: string;
    version: number;
    memberCount: number;
    counts: { open: number; completed: number; overdue: number };
    url: string;
    description?: string;
    match?: string;
};
type Created = {
    project: ProjectOut;
    sections: { id: string; name: string }[];
    knowledge: { available: boolean; objectId?: string; title?: string }[];
    created?: boolean;
    replayed?: boolean;
    knowledgeNotLinked?: string[];
};

const createViaMcp = (input: Record<string, unknown>, email = A) => ok<Created>("tasks_create_project", input, email);
const count = async (sql: string, ...binds: unknown[]) =>
    (await db()
        .prepare(sql)
        .bind(...binds)
        .first<{ n: number }>())!.n;
const ledger = async () => (await db().prepare("SELECT * FROM mcp_writes ORDER BY created_at, id").all<Record<string, string | null>>()).results;

describe("creating a project", () => {
    it("creates a personal project owned by the caller alone, with its sections, dates and link", async () => {
        const made = await createViaMcp({
            name: "Hilux maintenance",
            description: "Servicing, tyres and rego",
            startDate: "2026-11-01",
            targetDate: "2026-12-15",
            sections: ["Servicing", "Tyres"],
            requestId: "req-hilux-create-1",
        });
        expect(made.created).toBe(true);
        expect(made.project).toMatchObject({ name: "Hilux maintenance", kind: "personal", isInbox: false, status: "active", role: "owner", version: 1 });
        expect(made.project.memberCount).toBe(1);
        expect(made.project.url).toBe(`https://daly.id.au/portal/tasks/p/${made.project.id}`);
        expect(made.sections.map((s) => s.name)).toEqual(["Servicing", "Tyres"]);
        const members = await db().prepare("SELECT email, role FROM task_project_members WHERE project_id = ?").bind(made.project.id).all();
        expect(members.results).toEqual([{ email: A, role: "owner" }]);
        const row = await db().prepare("SELECT created_by, start_date, target_date, is_inbox FROM task_projects WHERE id = ?").bind(made.project.id).first();
        expect(row).toEqual({ created_by: A, start_date: "2026-11-01", target_date: "2026-12-15", is_inbox: 0 });
    });

    it("creates a shared project without adding anyone to it", async () => {
        const made = await createViaMcp({ name: "Household admin", kind: "shared" });
        expect(made.project.kind).toBe("shared");
        expect(made.project.memberCount).toBe(1);
        // B, the other portal owner, still can't see it until A adds them in the portal.
        await refused("tasks_project_summary", { projectId: made.project.id }, B, "not_found");
        expect((await ok<{ projects: ProjectOut[] }>("tasks_search_projects", { query: "Household admin" }, B)).projects).toHaveLength(0);
    });

    it("lets anyone the portal lets into Tasks create one, and nobody else", async () => {
        await addPortalUser(ADMIN, "admin");
        expect((await createViaMcp({ name: "Admin's own project", kind: "shared" }, ADMIN)).project.role).toBe("owner");
        await addPortalUser(WEDDING_EDITOR, "editor");
        for (const email of [WEDDING_EDITOR, "stranger@example.com"]) {
            await refused("tasks_create_project", { name: "Not allowed" }, email, "forbidden");
            await refused("tasks_search_projects", { query: "Admin" }, email, "forbidden");
        }
        expect(await count("SELECT COUNT(*) AS n FROM task_projects WHERE name = 'Not allowed'")).toBe(0);
    });

    it("never takes an owner from the arguments", async () => {
        for (const spoof of [{ email: B }, { owner: B }, { createdBy: B }, { ownerEmail: B }, { members: [B] }]) {
            const response = await refused("tasks_create_project", { name: "Spoofed", ...spoof }, A, "validation");
            expect(JSON.stringify(response)).not.toContain(B);
        }
        expect(await count("SELECT COUNT(*) AS n FROM task_projects WHERE name = 'Spoofed'")).toBe(0);
        // Created as whoever the token proves, even when the name says otherwise.
        const made = await createViaMcp({ name: `${B}'s project` });
        const row = await db().prepare("SELECT created_by FROM task_projects WHERE id = ?").bind(made.project.id).first<{ created_by: string }>();
        expect(row?.created_by).toBe(A);
        expect(await count("SELECT COUNT(*) AS n FROM task_project_members WHERE project_id = ? AND email = ?", made.project.id, B)).toBe(0);
    });

    it("applies the portal's validation: names, dates, sections", async () => {
        await refused("tasks_create_project", { name: "  " }, A, "validation");
        await refused("tasks_create_project", { name: "x".repeat(121) }, A, "validation");
        await refused("tasks_create_project", { name: "Backwards", startDate: "2026-12-01", targetDate: "2026-11-01" }, A, "validation");
        await refused("tasks_create_project", { name: "Not a date", startDate: "2026-02-30" }, A, "validation");
        await refused("tasks_create_project", { name: "Too many", sections: Array.from({ length: 21 }, (_, i) => `S${i}`) }, A, "validation");
        expect(await count("SELECT COUNT(*) AS n FROM task_projects WHERE is_inbox = 0")).toBe(0);
    });

    it("never makes a second Inbox or anything else called Inbox", async () => {
        await ok("tasks_list_projects");
        for (const name of ["Inbox", "inbox", " INBOX! "]) await refused("tasks_create_project", { name }, A, "validation");
        expect(await count("SELECT COUNT(*) AS n FROM task_projects WHERE lower(name) = 'inbox'")).toBe(1);
        const inbox = (await ok<{ projects: ProjectOut[] }>("tasks_list_projects")).projects.find((p) => p.isInbox)!;
        await refused("tasks_update_project", { projectId: inbox.id, version: inbox.version, name: "Renamed inbox" }, A, "validation");
        await refused("tasks_archive_project", { projectId: inbox.id, version: inbox.version }, A, "validation");
        const project = await createViaMcp({ name: "Errands" });
        await refused("tasks_update_project", { projectId: project.project.id, version: 1, name: "Inbox" }, A, "validation");
    });
});

describe("finding projects before creating one", () => {
    it("matches names whatever their case, spacing or punctuation, and ranks exact first", async () => {
        const hilux = await createViaMcp({ name: "Hilux maintenance" });
        await createViaMcp({ name: "Car", description: "Everything about the Hilux and the Corolla" });
        await createViaMcp({ name: "Garden" });
        const found = await ok<{ exactMatch: boolean; projects: ProjectOut[] }>("tasks_search_projects", { query: "HILUX  maintenance!" });
        expect(found.exactMatch).toBe(true);
        expect(found.projects.map((p) => [p.name, p.match])).toEqual([
            ["Hilux maintenance", "exact"],
            ["Car", "description"],
        ]);
        expect(found.projects[0]).toMatchObject({ id: hilux.project.id, kind: "personal", role: "owner", status: "active", version: 1 });
        expect(found.projects[0].url).toContain(`/portal/tasks/p/${hilux.project.id}`);
        const loose = await ok<{ exactMatch: boolean; projects: ProjectOut[] }>("tasks_search_projects", { query: "hilux" });
        expect(loose.exactMatch).toBe(false);
        expect(loose.projects[0]).toMatchObject({ name: "Hilux maintenance", match: "similar" });
    });

    it("unit: normalises and matches names", () => {
        expect(normaliseName("  Hilux—Maintenance!! ")).toBe("hilux maintenance");
        const p = (name: string, description = "") => ({ name, description, isInbox: false });
        expect(matchProject("hilux maintenance", p("Hilux Maintenance"))).toBe("exact");
        expect(matchProject("Hilux", p("Hilux maintenance"))).toBe("similar");
        expect(matchProject("Hilux service", p("Hilux maintenance"))).toBe("similar");
        expect(matchProject("the project", p("Garden project"))).toBeNull();
        expect(matchProject("car", p("Scar tissue physio"))).toBeNull();
        expect(matchProject("tyres", p("Car", "New tyres soon"))).toBe("description");
    });

    it("refuses an identically named project, listing the match, unless the person confirms a separate one", async () => {
        const first = await createViaMcp({ name: "Hilux maintenance" });
        const duplicate = await refused("tasks_create_project", { name: "hilux  MAINTENANCE" }, A, "duplicate");
        if (!duplicate.ok) {
            const matches = duplicate.error.details?.matches as ProjectOut[];
            expect(matches.map((m) => [m.id, m.name, m.status, m.kind, m.match])).toEqual([
                [first.project.id, "Hilux maintenance", "active", "personal", "exact"],
            ]);
            expect(matches[0].url).toContain(first.project.id);
        }
        expect(await count("SELECT COUNT(*) AS n FROM task_projects WHERE is_inbox = 0")).toBe(1);
        // A similar but different name is not a duplicate.
        await createViaMcp({ name: "Hilux maintenance 2027" });
        // An explicit, confirmed override.
        const second = await createViaMcp({ name: "Hilux maintenance", allowDuplicateName: true });
        expect(second.project.id).not.toBe(first.project.id);
    });

    it("counts an archived project as an existing one", async () => {
        const old = await createViaMcp({ name: "Tax return" });
        await ok("tasks_archive_project", { projectId: old.project.id, version: 1 });
        const duplicate = await refused("tasks_create_project", { name: "Tax return" }, A, "duplicate");
        if (!duplicate.ok) expect((duplicate.error.details?.matches as ProjectOut[])[0]).toMatchObject({ id: old.project.id, status: "archived" });
        // The default list hides archived projects; search can leave them out too.
        expect((await ok<{ projects: ProjectOut[] }>("tasks_list_projects")).projects.map((p) => p.id)).not.toContain(old.project.id);
        expect((await ok<{ projects: ProjectOut[] }>("tasks_search_projects", { query: "Tax return", includeArchived: false })).projects).toHaveLength(0);
    });

    it("only ever looks at the caller's own projects", async () => {
        const mine = await createViaMcp({ name: "Surprise party planning" });
        // B neither sees A's private project nor is blocked by its name.
        expect((await ok<{ projects: ProjectOut[] }>("tasks_search_projects", { query: "Surprise party" }, B)).projects).toHaveLength(0);
        const theirs = await createViaMcp({ name: "Surprise party planning" }, B);
        expect(theirs.project.id).not.toBe(mine.project.id);
        // A shared project is found by its members.
        const household = await sharedProject("editor", "Household chores");
        const found = await ok<{ projects: ProjectOut[] }>("tasks_search_projects", { query: "chores" }, B);
        expect(found.projects.map((p) => [p.id, p.kind, p.role])).toEqual([[household.id, "shared", "editor"]]);
    });
});

describe("retrying a create", () => {
    it("returns the first project for a repeated request id, and never makes two", async () => {
        const first = await createViaMcp({ name: "Hilux maintenance", sections: ["Servicing"], requestId: "req-hilux-create-1" });
        const again = await createViaMcp({ name: "Hilux maintenance", sections: ["Servicing"], requestId: "req-hilux-create-1" });
        expect(again.project.id).toBe(first.project.id);
        expect(again.replayed).toBe(true);
        expect(again.sections.map((s) => s.name)).toEqual(["Servicing"]);
        expect(await count("SELECT COUNT(*) AS n FROM task_projects WHERE name = 'Hilux maintenance'")).toBe(1);
        expect(await count("SELECT COUNT(*) AS n FROM task_sections WHERE project_id = ?", first.project.id)).toBe(1);
        // One ledger row, naming the project by id only.
        const rows = await ledger();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ email: A, tool: "tasks_create_project", status: "done", entity_type: "task_project", entity_id: first.project.id });
        // A request id belongs to one action.
        await refused("tasks_archive_project", { projectId: first.project.id, version: 1, requestId: "req-hilux-create-1" }, A, "request_id_reused");
    });

    it("still returns the first project when the ledger lost track of the request part-way", async () => {
        const first = await createViaMcp({ name: "Hilux maintenance", requestId: "req-hilux-create-2" });
        // As if the request died after the project was written but before the ledger was settled.
        await db().prepare("UPDATE mcp_writes SET status = 'pending', entity_type = NULL, entity_id = NULL, created_at = '2026-01-01T00:00:00.000Z'").run();
        const again = await createViaMcp({ name: "Hilux maintenance", requestId: "req-hilux-create-2" });
        expect(again).toMatchObject({ created: false, replayed: true });
        expect(again.project.id).toBe(first.project.id);
        expect(await count("SELECT COUNT(*) AS n FROM task_projects WHERE name = 'Hilux maintenance'")).toBe(1);
    });

    it("finishes the Knowledge links of a create that died after making the project", async () => {
        const note = await createObject((await personal(A)).id, { title: "Hilux logbook", content: doc("Service history") });
        const input = { name: "Hilux maintenance", knowledgeObjectIds: [note.object.id], requestId: "req-hilux-create-3" };
        const first = await createViaMcp(input);
        // As if the request died after the project was written, before its link and the ledger.
        await db().prepare("DELETE FROM task_project_knowledge_links").run();
        await db().prepare("UPDATE mcp_writes SET status = 'pending', entity_type = NULL, entity_id = NULL, created_at = '2026-01-01T00:00:00.000Z'").run();
        const again = await createViaMcp(input);
        expect(again.project.id).toBe(first.project.id);
        expect(again.knowledge).toEqual([expect.objectContaining({ available: true, objectId: note.object.id })]);
        expect(await count("SELECT COUNT(*) AS n FROM task_project_knowledge_links WHERE project_id = ?", first.project.id)).toBe(1);
    });

    it("keeps request ids per person", async () => {
        const mine = await createViaMcp({ name: "Mine", requestId: "req-shared-id-01" });
        const theirs = await createViaMcp({ name: "Theirs", requestId: "req-shared-id-01" }, B);
        expect(theirs.project.id).not.toBe(mine.project.id);
        expect(theirs.created).toBe(true);
    });

    it("the portal API's own create is retry-safe with the same client id", async () => {
        const first = await createProject({ name: "From the browser", clientId: "browser-draft-0001" });
        const again = await createProject({ name: "From the browser", clientId: "browser-draft-0001" });
        expect(again.id).toBe(first.id);
        expect(await count("SELECT COUNT(*) AS n FROM task_projects WHERE name = 'From the browser'")).toBe(1);
    });
});

describe("editing a project", () => {
    it("changes details with the current version and refuses a stale one, saying which is current", async () => {
        const { project } = await createViaMcp({ name: "Hilux maintenance" });
        const edited = await ok<Created & { changed: string[] }>("tasks_update_project", {
            projectId: project.id,
            version: 1,
            description: "Logbook service due",
            targetDate: "2026-12-01",
            reviewFrequency: "monthly",
        });
        expect(edited.project.version).toBe(2);
        expect(edited.project.description).toBe("Logbook service due");
        expect(edited.changed.sort()).toEqual(["description", "reviewFrequency", "targetDate"]);
        const stale = await refused("tasks_update_project", { projectId: project.id, version: 1, name: "Overwritten" }, A, "conflict");
        if (!stale.ok) expect((stale.error.details?.current as { version: number }).version).toBe(2);
        expect((await ok<{ projects: ProjectOut[] }>("tasks_search_projects", { query: "Hilux" })).projects[0].name).toBe("Hilux maintenance");
        // null clears a date; an empty edit is refused.
        expect((await ok<Created>("tasks_update_project", { projectId: project.id, version: 2, targetDate: null })).project.version).toBe(3);
        await refused("tasks_update_project", { projectId: project.id, version: 3 }, A, "validation");
    });

    it("follows the portal's roles: editors change details, only owners change status, viewers nothing", async () => {
        const project = await sharedProject("editor", "Renovation");
        const renamed = await ok<Created>("tasks_update_project", { projectId: project.id, version: project.version, name: "Kitchen renovation" }, B);
        expect(renamed.project.name).toBe("Kitchen renovation");
        await refused("tasks_update_project", { projectId: project.id, version: renamed.project.version, status: "on_hold" }, B, "forbidden");
        await refused("tasks_archive_project", { projectId: project.id, version: renamed.project.version }, B, "forbidden");
        await call("PATCH", `/projects/${project.id}/members/${encodeURIComponent(B)}`, { role: "viewer" });
        await refused("tasks_update_project", { projectId: project.id, version: renamed.project.version, description: "x" }, B, "forbidden");
        const done = await ok<Created>("tasks_update_project", { projectId: project.id, version: renamed.project.version, status: "completed" }, A);
        expect(done.project.status).toBe("completed");
    });

    it("never reaches someone else's private project", async () => {
        const { project } = await createViaMcp({ name: "A's private plans" });
        await refused("tasks_update_project", { projectId: project.id, version: 1, name: "Hijacked" }, B, "not_found");
        await refused("tasks_archive_project", { projectId: project.id, version: 1 }, B, "not_found");
        await refused("tasks_unarchive_project", { projectId: project.id, version: 1 }, B, "not_found");
        const row = await db().prepare("SELECT name, status, version FROM task_projects WHERE id = ?").bind(project.id).first();
        expect(row).toEqual({ name: "A's private plans", status: "active", version: 1 });
    });
});

describe("archiving and restoring", () => {
    it("archives without losing tasks, sections, comments or Knowledge links, and restores them all", async () => {
        const space = await personal(A);
        const note = await createObject(space.id, { title: "Hilux logbook", content: doc("Last service at 80,000 km") });
        const made = await createViaMcp({ name: "Hilux maintenance", sections: ["Servicing"], knowledgeObjectIds: [note.object.id] });
        expect(made.knowledge).toEqual([{ available: true, objectId: note.object.id, title: "Hilux logbook", spaceName: expect.any(String) }]);
        const projectId = made.project.id;
        const oil = await ok<{ task: { id: string } }>("tasks_create", { title: "Book the oil change", projectId, sectionId: made.sections[0].id });
        const tyres = await ok<{ task: { id: string } }>("tasks_create", { title: "Rotate the tyres", projectId });
        await ok("tasks_complete", { taskId: tyres.task.id });
        await ok("tasks_link_knowledge", { taskId: oil.task.id, objectId: note.object.id });
        await ok("tasks_add_comment", { taskId: oil.task.id, body: "Ring the dealer" });
        const snapshot = async () => ({
            tasks: (await db().prepare("SELECT id, title, status, section_id FROM task_items WHERE project_id = ? ORDER BY id").bind(projectId).all()).results,
            sections: await count("SELECT COUNT(*) AS n FROM task_sections WHERE project_id = ?", projectId),
            comments: await count("SELECT COUNT(*) AS n FROM task_comments c JOIN task_items t ON t.id = c.task_id WHERE t.project_id = ?", projectId),
            taskLinks: await count("SELECT COUNT(*) AS n FROM task_knowledge_links l JOIN task_items t ON t.id = l.task_id WHERE t.project_id = ?", projectId),
            projectLinks: await count("SELECT COUNT(*) AS n FROM task_project_knowledge_links WHERE project_id = ?", projectId),
        });
        const before = await snapshot();
        expect(before).toMatchObject({ sections: 1, comments: 1, taskLinks: 1, projectLinks: 1 });

        const archived = await ok<Created & { archived: boolean; note: string }>("tasks_archive_project", {
            projectId,
            version: 1,
            requestId: "req-archive-hilux",
        });
        expect(archived.project.status).toBe("archived");
        expect(archived.note).toMatch(/not deleted/);
        expect(archived.project.counts).toEqual({ open: 1, completed: 1, overdue: 0 });
        expect(await snapshot()).toEqual(before);
        // Read-only while archived, as in the portal, but still readable.
        expect((await ok<{ task: { title: string } }>("tasks_get", { taskId: oil.task.id })).task.title).toBe("Book the oil change");
        await refused("tasks_create", { title: "New work", projectId }, A, "validation");
        await refused("tasks_update_project", { projectId, version: archived.project.version, description: "x" }, A, "validation");
        await refused("tasks_update_project", { projectId, version: archived.project.version, status: "active" }, A, "validation");
        // Retried and repeated archives change nothing more.
        expect((await ok<Created>("tasks_archive_project", { projectId, version: 1, requestId: "req-archive-hilux" })).replayed).toBe(true);
        expect(await ok("tasks_archive_project", { projectId, version: archived.project.version })).toMatchObject({ alreadyArchived: true });
        expect(await count("SELECT version AS n FROM task_projects WHERE id = ?", projectId)).toBe(archived.project.version);

        // A stale restore is refused; the current one brings everything back.
        await refused("tasks_unarchive_project", { projectId, version: 1 }, A, "conflict");
        const restored = await ok<Created & { restored: boolean }>("tasks_unarchive_project", { projectId, version: archived.project.version });
        expect(restored.project.status).toBe("active");
        expect(restored.knowledge).toHaveLength(1);
        expect(await snapshot()).toEqual(before);
        expect((await ok<{ task: { id: string } }>("tasks_create", { title: "New work", projectId })).task.id).toBeTruthy();
        expect(await ok("tasks_unarchive_project", { projectId, version: restored.project.version })).toMatchObject({ alreadyRestored: true });
    });

    it("restores to another status when asked", async () => {
        const { project } = await createViaMcp({ name: "Side project" });
        const archived = await ok<Created>("tasks_archive_project", { projectId: project.id, version: 1 });
        const restored = await ok<Created>("tasks_unarchive_project", { projectId: project.id, version: archived.project.version, status: "on_hold" });
        expect(restored.project.status).toBe("on_hold");
        await refused("tasks_unarchive_project", { projectId: project.id, version: restored.project.version, status: "archived" }, A, "validation");
    });

    it("leaves a shared project's members in place across archive and restore", async () => {
        const project = await sharedProject("editor", "Household");
        const archived = await ok<Created>("tasks_archive_project", { projectId: project.id, version: project.version });
        // B still sees it, archived and read-only.
        expect((await ok<{ project: ProjectOut }>("tasks_project_summary", { projectId: project.id }, B)).project.status).toBe("archived");
        await ok("tasks_unarchive_project", { projectId: project.id, version: archived.project.version });
        expect(await count("SELECT COUNT(*) AS n FROM task_project_members WHERE project_id = ?", project.id)).toBe(2);
    });
});

describe("Knowledge links on a new project", () => {
    it("links only objects the caller can read, and creates nothing when one isn't", async () => {
        const theirs = await createObject((await personal(B)).id, { title: "B's private note", content: doc("Only for B") }, B);
        const response = await refused("tasks_create_project", { name: "Nosy", knowledgeObjectIds: [theirs.object.id] }, A, "not_found");
        expect(JSON.stringify(response)).not.toContain("B's private note");
        expect(await count("SELECT COUNT(*) AS n FROM task_projects WHERE name = 'Nosy'")).toBe(0);

        const mine = await createObject((await personal(A)).id, { title: "Old plan", content: doc("Superseded") });
        const trashed = await apiCall("POST", `${K}/objects/${mine.object.id}/status/trash`, {});
        expect(trashed.status, trashed.text).toBe(200);
        await refused("tasks_create_project", { name: "With trash", knowledgeObjectIds: [mine.object.id] }, A, "not_found");
        expect(await count("SELECT COUNT(*) AS n FROM task_projects WHERE name = 'With trash'")).toBe(0);
        expect(await count("SELECT COUNT(*) AS n FROM task_project_knowledge_links")).toBe(0);
    });

    it("shows a member only the references they can read themselves", async () => {
        const secret = await createObject((await personal(A)).id, { title: "Budget worries", content: doc("Only for A") });
        const made = await createViaMcp({ name: "Renovation", kind: "shared", knowledgeObjectIds: [secret.object.id] });
        await call("POST", `/projects/${made.project.id}/members`, { email: B, role: "editor" });
        const summary = await ok("tasks_project_summary", { projectId: made.project.id }, B);
        expect(JSON.stringify(summary)).not.toContain("Budget worries");
        const search = await ok("tasks_search_projects", { query: "Renovation" }, B);
        expect(JSON.stringify(search)).not.toContain("Budget worries");
    });
});

describe("the audit trail", () => {
    it("records every project write by id and person, never the name, description or sections", async () => {
        const made = await createViaMcp({
            name: "Secret surprise party",
            description: "Hide this from everyone",
            sections: ["Hidden venue"],
            requestId: "req-audit-create-1",
        });
        const projectId = made.project.id;
        await ok("tasks_update_project", { projectId, version: 1, name: "Secret birthday dinner", description: "Still hidden" });
        await ok("tasks_archive_project", { projectId, version: 2 });
        await ok("tasks_unarchive_project", { projectId, version: 3 });
        await refused("tasks_update_project", { projectId, version: 1, name: "Secret stale edit" }, A, "conflict");

        const rows = await ledger();
        expect(rows.map((r) => [r.tool, r.status, r.entity_type, r.entity_id ?? r.error_code])).toEqual([
            ["tasks_create_project", "done", "task_project", projectId],
            ["tasks_update_project", "done", "task_project", projectId],
            ["tasks_archive_project", "done", "task_project", projectId],
            ["tasks_unarchive_project", "done", "task_project", projectId],
            ["tasks_update_project", "failed", null, "conflict"],
        ]);
        const history = (await activityRows()).filter((r) => r.project_id === projectId);
        expect(history.map((r) => r.action)).toEqual(["project.create", "project.update", "project.status", "project.status"]);
        expect(history.every((r) => r.actor === A)).toBe(true);
        const stored = JSON.stringify([rows, history]);
        for (const secret of ["Secret", "surprise", "Hide this", "Still hidden", "Hidden venue", "birthday"]) expect(stored).not.toContain(secret);
        // The portal-wide audit log, readable by every portal editor, is never used for Tasks.
        expect(await count("SELECT COUNT(*) AS n FROM audit_log WHERE summary LIKE '%Secret%' OR changes LIKE '%Secret%'")).toBe(0);
    });
});

describe("tasks in a new project", () => {
    it("adds tasks to the project and its sections with the existing task tools, once each", async () => {
        const made = await createViaMcp({ name: "Hilux maintenance", sections: ["Servicing"] });
        const input = { title: "Book the logbook service", projectId: made.project.id, sectionId: made.sections[0].id, requestId: "req-hilux-task-01" };
        const first = await ok<{ task: { id: string; projectName: string } }>("tasks_create", input);
        const again = await ok<{ task: { id: string } }>("tasks_create", input);
        expect(again.task.id).toBe(first.task.id);
        expect(first.task.projectName).toBe("Hilux maintenance");
        const summary = await ok<{ project: ProjectOut; openTasks: { count: number } }>("tasks_project_summary", { projectId: made.project.id });
        expect(summary.openTasks.count).toBe(1);
        expect(summary.project.version).toBe(1);
        // Inbox stays a valid destination: no project needed.
        expect((await ok<{ task: { projectName: string } }>("tasks_create", { title: "Buy wiper blades" })).task.projectName).toBe("Inbox");
        expect(await createTask({ title: "Unrelated", projectId: made.project.id })).toBeTruthy();
    });
});
