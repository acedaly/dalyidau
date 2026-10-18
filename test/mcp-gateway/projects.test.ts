// Project management through the full MCP path (gateway → PortalMcpEntrypoint → D1), the way the
// Chief of Staff would do it: search, reuse or create once, add tasks, link Knowledge, return the
// link; then edit, archive and restore. A second person sees none of it. Every identity and record
// is fictional.
import { beforeEach, describe, expect, it } from "vitest";
import { PORTAL_WRITE_TOOLS } from "../../mcp/src/portal-tools";
import { OWNER, SECOND_OWNER, resetPortal } from "../portal-helpers";
import { gatewayEnv, guardOutbound, outbound, portalBinding, rateLimit, session } from "./helpers";

const A = OWNER;
const B = SECOND_OWNER;

beforeEach(async () => {
    await resetPortal();
    guardOutbound();
});

type Project = { id: string; name: string; kind: string; status: string; version: number; url: string; match?: string };
type Created = { project: Project; sections: { id: string; name: string }[]; knowledge: { available: boolean; objectId?: string }[]; replayed?: boolean };

describe("projects through the MCP gateway", () => {
    it("runs the Chief of Staff workflow: search, create once, add tasks, link Knowledge, return the link", async () => {
        const a = await session(A);
        const note = (await a.ok<{ object: { id: string } }>("knowledge_create_object", { title: "Hilux logbook", text: "Last service at 80,000 km." })).object;

        // 1. Search: nothing suitable yet.
        const before = await a.ok<{ exactMatch: boolean; projects: Project[] }>("tasks_search_projects", { query: "Hilux maintenance" });
        expect(before).toMatchObject({ exactMatch: false, projects: [] });

        // 2–4. Create (after the person agreed), with a request id; a retry returns the same project.
        const create = { name: "Hilux maintenance", sections: ["Servicing", "Tyres"], knowledgeObjectIds: [note.id], requestId: "cos-hilux-project-1" };
        const made = await a.ok<Created>("tasks_create_project", create);
        const retried = await a.ok<Created>("tasks_create_project", create);
        expect(retried.project.id).toBe(made.project.id);
        expect(retried.replayed).toBe(true);
        expect(made.knowledge).toEqual([expect.objectContaining({ available: true, objectId: note.id })]);

        // 5. Tasks, each once, in the new project's sections.
        const servicing = made.sections.find((s) => s.name === "Servicing")!;
        for (const [title, key] of [
            ["Book the logbook service", "cos-hilux-task-01"],
            ["Replace the wiper blades", "cos-hilux-task-02"],
        ]) {
            const input = { title, projectId: made.project.id, sectionId: servicing.id, requestId: key };
            const first = await a.ok<{ task: { id: string } }>("tasks_create", input);
            expect((await a.ok<{ task: { id: string } }>("tasks_create", input)).task.id).toBe(first.task.id);
        }

        // 6. Link the Knowledge record to a task too.
        const tasks = await a.ok<{ tasks: { id: string; title: string }[] }>("tasks_list", { projectIds: [made.project.id] });
        expect(tasks.tasks.map((t) => t.title).sort()).toEqual(["Book the logbook service", "Replace the wiper blades"]);
        await a.ok("tasks_link_knowledge", { taskId: tasks.tasks[0].id, objectId: note.id, requestId: "cos-hilux-link-01" });

        // 7. The direct link, and a second create of the same name is refused as a duplicate.
        expect(made.project.url).toBe(`https://daly.id.au/portal/tasks/p/${made.project.id}`);
        const duplicate = await a.tool("tasks_create_project", { name: "hilux maintenance" });
        expect(duplicate.isError).toBe(true);
        expect(duplicate.data.error?.code).toBe("duplicate");
        expect(JSON.stringify(duplicate.data)).toContain(made.project.id);
        const after = await a.ok<{ exactMatch: boolean; projects: Project[] }>("tasks_search_projects", { query: "Hilux maintenance" });
        expect(after.projects.map((p) => [p.id, p.match])).toEqual([[made.project.id, "exact"]]);

        // Nothing outside the portal was contacted beyond the Access key set.
        expect(outbound.every((url) => url.endsWith("/cdn-cgi/access/certs"))).toBe(true);
    });

    it("edits, archives and restores with versions, and keeps every task", async () => {
        const a = await session(A);
        const { project } = await a.ok<Created>("tasks_create_project", { name: "Garden" });
        await a.ok("tasks_create", { title: "Prune the roses", projectId: project.id });
        const edited = await a.ok<Created>("tasks_update_project", { projectId: project.id, version: project.version, targetDate: "2026-12-01" });
        const stale = await a.tool("tasks_update_project", { projectId: project.id, version: project.version, name: "Old" });
        expect(stale.data.error?.code).toBe("conflict");

        const archived = await a.ok<Created>("tasks_archive_project", { projectId: project.id, version: edited.project.version });
        expect(archived.project.status).toBe("archived");
        const restored = await a.ok<Created>("tasks_unarchive_project", { projectId: project.id, version: archived.project.version });
        expect(restored.project.status).toBe("active");
        const summary = await a.ok<{ openTasks: { count: number } }>("tasks_project_summary", { projectId: project.id });
        expect(summary.openTasks.count).toBe(1);
    });

    it("keeps one person's projects invisible and untouchable to another", async () => {
        const a = await session(A);
        const { project } = await a.ok<Created>("tasks_create_project", { name: "Zanzibar honeymoon" });
        const b = await session(B);
        const searched = await b.ok("tasks_search_projects", { query: "Zanzibar" });
        expect(JSON.stringify(searched)).not.toContain("Zanzibar honeymoon");
        for (const [name, args] of [
            ["tasks_update_project", { projectId: project.id, version: 1, name: "Mine now" }],
            ["tasks_archive_project", { projectId: project.id, version: 1 }],
            ["tasks_unarchive_project", { projectId: project.id, version: 1 }],
        ] as const) {
            const answer = await b.tool(name, args);
            expect(answer.data.error?.code, name).toBe("not_found");
        }
        // The gateway's own schema refuses an owner field before it reaches the portal.
        const spoof = await b.tool("tasks_create_project", { name: "Spoof", owner: A });
        expect(spoof.rpcError ?? spoof.isError).toBeTruthy();
    });

    it("counts project writes against the write rate limit, and never searches", async () => {
        expect(PORTAL_WRITE_TOOLS.has("tasks_search_projects" as never)).toBe(false);
        const MCP_WRITES = rateLimit(1);
        const binding = portalBinding();
        const s = await session(A, { env: gatewayEnv({ MCP_WRITES, PORTAL: binding }) });
        await s.ok("tasks_create_project", { name: "First" });
        const limited = await s.tool("tasks_create_project", { name: "Second" });
        expect(limited.data.error?.code).toBe("rate_limited");
        await s.ok("tasks_search_projects", { query: "First" });
        expect(binding.calls.filter((c) => c === "tasks_create_project")).toHaveLength(1);
    });
});
