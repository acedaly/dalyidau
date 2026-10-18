// The DalyHub → Daly Portal migration (docs/DALYHUB_MIGRATION.md): the planner's mapping, then
// preview, apply, idempotency, bounded runs and revert through the real API and services. Every
// record is fictional; no DalyHub database or service is involved.
import { beforeEach, describe, expect, it } from "vitest";
import { type DalyHubSource, PLAN_FORMAT, planDalyHubMigration } from "../src/shared/migration/dalyhub";
import type { Env } from "../worker/env";
import { APPLY_LIMIT } from "../worker/migration/dalyhub";
import { OWNER, SECOND_OWNER, apiCall, db, portalEnv, resetPortal } from "./portal-helpers";

const M = "/api/portal/migrations/dalyhub";
const on = () => portalEnv({ DALYHUB_MIGRATION: "on" });

beforeEach(resetPortal);

const entity = (id: string, type: string, title: string, extra: Partial<DalyHubSource["entities"][number]> = {}) => ({
    id,
    workspace_id: "ws1",
    type,
    title,
    created_at: `2026-01-01T00:00:${id.length.toString().padStart(2, "0")}Z`,
    updated_at: "2026-01-01T00:00:00Z",
    deleted_at: null,
    ...extra,
});
const task = (entity_id: string, extra: Partial<DalyHubSource["tasks"][number]> = {}) => ({
    entity_id,
    status: "todo",
    priority: null,
    due_date: null,
    scheduled_date: null,
    commitment_state: "active",
    delegate_to: null,
    delegated_on: null,
    follow_up_on: null,
    delegate_note: null,
    description: null,
    waiting_since: null,
    waiting_note: null,
    ...extra,
});
const link = (source_entity_id: string, target_entity_id: string, type: string) => ({ source_entity_id, target_entity_id, type, deleted_at: null });

/** A small fictional DalyHub workspace covering each mapping. */
function source(): DalyHubSource {
    return {
        entities: [
            entity("a1", "area", "Home"),
            entity("p1", "project", "Renovate kitchen"),
            entity("p2", "project", "Old archived project"),
            entity("g1", "goal", "Finish the house"),
            entity("t1", "task", "Get quotes"),
            entity("t2", "task", "Call plumber"),
            entity("t3", "task", "Done already"),
            entity("t4", "task", "Water plants"),
            entity("t5", "task", "Maybe learn piano"),
            entity("t6", "task", "Cancelled thing"),
            entity("t7", "task", "Deleted thing", { deleted_at: "2026-02-01" }),
            entity("n1", "note", "Kitchen ideas"),
            entity("d1", "decision", "Use timber benchtop"),
            entity("m1", "meeting", "Builder walkthrough"),
            entity("pe1", "person", "Fictional Person"),
        ],
        links: [
            link("p1", "a1", "project.belongs_to_area"),
            link("p1", "g1", "project.advances_goal"),
            link("t1", "p1", "task.belongs_to_project"),
            link("t2", "p1", "task.belongs_to_project"),
            link("t4", "a1", "task.belongs_to_area"),
            link("n1", "p1", "link.related"),
        ],
        spine: [
            { entity_id: "t3", kind: "task", completed_at: "2026-02-01" },
            { entity_id: "p1", kind: "project", completed_at: null },
        ],
        tasks: [
            task("t1", { priority: "p1", scheduled_date: "2026-10-25", due_date: "2026-11-01", description: "Three quotes" }),
            task("t2", { delegate_to: "Plumber Co", delegated_on: "2026-10-01", follow_up_on: "2026-10-20" }),
            task("t3"),
            task("t4", { due_date: "2026-10-19" }),
            task("t5", { commitment_state: "someday" }),
            task("t6", { status: "cancelled" }),
            task("t7"),
        ],
        projects: [
            { entity_id: "p1", status: "active", archived_at: null },
            { entity_id: "p2", status: "active", archived_at: "2026-03-01" },
        ],
        goals: [{ entity_id: "g1", target_date: "2027-06-30", definition_of_done: "Every room finished" }],
        areas: [{ entity_id: "a1", archived_at: null }],
        notes: [{ entity_id: "n1", content: "# Ideas\n\n- **Island** bench <script>alert(1)</script>", archived_at: null }],
        decisions: [{ entity_id: "d1", status: "decided", rationale: "Warmer look", decision_date: "2026-09-01", review_date: null, related_entity_id: "p1" }],
        meetings: [
            {
                entity_id: "m1",
                starts_at: "2026-09-15T09:00:00",
                timezone: "Australia/Sydney",
                location: "On site",
                status: "completed",
                agenda_markdown: "Walk through",
                notes_markdown: "Needs new wiring",
                archived_at: null,
            },
        ],
        checklist: [
            { id: "c1", task_id: "t1", title: "Ask three builders", position: 0, completed: 0 },
            { id: "c2", task_id: "t1", title: "Already asked one", position: 1, completed: 1 },
        ],
        recurring: ["t4"],
        tags: [{ entity_id: "n1", tag_key: "kitchen" }],
        tableCounts: { person_details: 1, diary_entry_details: 3, finance_transaction_details: 12 },
    };
}

const plan = (options = {}) => planDalyHubMigration(source(), { now: "2026-10-18T00:00:00Z", ...options });

describe("planning (no database)", () => {
    it("maps DalyHub's work and notes onto Tasks and Knowledge", () => {
        const p = plan();
        expect(p.format).toBe(PLAN_FORMAT);
        expect(p.projects.map((x) => x.name)).toEqual(["Renovate kitchen"]);
        expect(p.projects[0].description).toContain("Area: Home");
        expect(p.goals).toEqual([
            {
                sourceId: "g1",
                title: "Finish the house",
                description: "Definition of done: Every room finished",
                targetDate: "2027-06-30",
                projectSourceIds: ["p1"],
            },
        ]);

        const byId = new Map(p.tasks.map((t) => [t.sourceId, t]));
        expect([...byId.keys()].sort()).toEqual(["checklist:c1", "t1", "t2", "t4", "t5"]);
        expect(byId.get("t1")).toMatchObject({
            projectSourceId: "p1",
            priority: 1,
            dueDate: "2026-10-25",
            deadline: "2026-11-01",
            labels: ["dalyhub", "Home"],
        });
        expect(byId.get("t2")).toMatchObject({ dueDate: "2026-10-20", labels: ["dalyhub", "waiting", "Home"] });
        expect(byId.get("t2")!.description).toBe("Waiting on Plumber Co since 2026-10-01; follow up 2026-10-20.");
        expect(byId.get("t4")).toMatchObject({ projectSourceId: null, dueDate: "2026-10-19", labels: ["dalyhub", "was-repeating", "Home"] });
        expect(byId.get("t5")!.labels).toContain("someday");
        expect(byId.get("checklist:c1")).toMatchObject({ parentSourceId: "t1", projectSourceId: "p1" });

        const objects = new Map(p.knowledge.map((k) => [k.sourceId, k]));
        expect(objects.get("a1")?.type).toBe("area");
        expect(objects.get("n1")).toMatchObject({ type: "page", projectSourceId: "p1", tags: ["dalyhub", "kitchen"] });
        expect(objects.get("d1")).toMatchObject({ type: "decision", properties: { status: "decided", decided_on: "2026-09-01" }, projectSourceId: "p1" });
        expect(objects.get("m1")).toMatchObject({ type: "meeting", properties: { date: "2026-09-15" } });
    });

    it("leaves behind people, diary, finance, completed, cancelled, deleted and archived records, and says so", () => {
        const p = plan();
        const left = Object.fromEntries(p.skipped.map((s) => [`${s.category}: ${s.reason}`, s.count]));
        expect(left).toMatchObject({
            "task: Completed in DalyHub.": 1,
            "task: Cancelled in DalyHub.": 1,
            "task: Deleted in DalyHub.": 1,
            "checklist item: Ticked off in DalyHub.": 1,
        });
        expect(p.skipped.find((s) => s.category === "project")?.reason).toContain("Archived");
        expect(p.skipped.find((s) => s.category === "person_details")?.count).toBe(1);
        expect(p.skipped.find((s) => s.category === "diary_entry_details")?.count).toBe(3);
        expect(p.skipped.find((s) => s.category === "finance_transaction_details")?.count).toBe(12);
        expect(JSON.stringify(p.knowledge)).not.toContain("Fictional Person");
    });

    it("brings completed and archived records only when asked", () => {
        const p = plan({ includeCompleted: true, includeArchived: true });
        expect(p.tasks.map((t) => t.sourceId)).toContain("t3");
        expect(p.projects.map((x) => x.sourceId)).toContain("p2");
        expect(p.tasks.map((t) => t.sourceId)).toContain("checklist:c2");
    });
});

/** Previews then applies a plan as `email`, calling again until the run is done. */
async function migrate(p = plan(), email = OWNER, env?: Env) {
    const e = env ?? (await on());
    const preview = await apiCall<{ fingerprint: string; counts: Record<string, number> }>("POST", `${M}/preview`, { plan: p }, { email, env: e });
    expect(preview.status, preview.text).toBe(200);
    let runId: string | undefined;
    let calls = 0;
    for (;;) {
        const applied = await apiCall<{ runId: string; done: boolean; created: number; remaining: number }>(
            "POST",
            `${M}/apply`,
            { plan: p, fingerprint: preview.json.fingerprint, ...(runId ? { runId } : {}) },
            { email, env: e },
        );
        expect(applied.status, applied.text).toBe(200);
        runId = applied.json.runId;
        calls += 1;
        if (applied.json.done) return { runId, calls, preview: preview.json };
    }
}

const count = async (table: string, where = "1 = 1", ...binds: unknown[]) =>
    (await db()
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)
        .bind(...binds)
        .first<{ n: number }>())!.n;

const TABLES = ["task_projects", "task_items", "task_goals", "knowledge_objects", "dalyhub_import_items", "dalyhub_import_runs"];
const snapshot = async () => Object.fromEntries(await Promise.all(TABLES.map(async (t) => [t, await count(t)])));

describe("access", () => {
    it("doesn't exist unless DALYHUB_MIGRATION is on", async () => {
        for (const env of [await portalEnv(), await portalEnv({ DALYHUB_MIGRATION: "off" })]) {
            expect((await apiCall("POST", `${M}/preview`, { plan: plan() }, { env })).status).toBe(404);
            expect((await apiCall("GET", `${M}/runs`, undefined, { env })).status).toBe(404);
        }
    });

    it("is for portal owners only", async () => {
        const env = await on();
        await apiCall("POST", "/api/portal/users", { email: "admin@example.com", role: "admin" }, { env });
        const refused = await apiCall("POST", `${M}/preview`, { plan: plan() }, { email: "admin@example.com", env });
        expect(refused.status).toBe(403);
        expect((await apiCall("POST", `${M}/preview`, { plan: plan() }, { email: "nobody@example.com", env })).status).toBe(403);
    });
});

describe("preview", () => {
    it("writes nothing and says what would happen", async () => {
        await apiCall("GET", "/api/portal/tasks/projects", undefined, { env: await on() }); // the Inbox exists either way
        const before = await snapshot();
        const preview = await apiCall<{ counts: { create: number }; creates: Record<string, number>; skipped: unknown[] }>(
            "POST",
            `${M}/preview`,
            { plan: plan() },
            { env: await on() },
        );
        expect(preview.status, preview.text).toBe(200);
        expect(preview.json.creates).toEqual({ projects: 1, goals: 1, tasks: 4, subtasks: 1, knowledge: 4 });
        expect(preview.json.counts.create).toBe(1 + 1 + 4 + 5 + 2); // + two project links (note, decision)
        expect(await snapshot()).toEqual(before);
    });

    it("refuses a malformed or inconsistent plan", async () => {
        const env = await on();
        const bad = [
            { ...plan(), format: "something-else" },
            { ...plan(), owner: SECOND_OWNER },
            { ...plan(), tasks: [{ ...plan().tasks[0], projectSourceId: "no-such-project" }] },
            { ...plan(), tasks: [...plan().tasks].reverse() }, // a subtask before its parent
            { ...plan(), tasks: [{ ...plan().tasks[0], email: SECOND_OWNER }] },
        ];
        for (const p of bad) expect((await apiCall("POST", `${M}/preview`, { plan: p }, { env })).status).toBe(422);
    });
});

describe("apply", () => {
    it("needs the fingerprint of the previewed plan", async () => {
        const env = await on();
        const response = await apiCall("POST", `${M}/apply`, { plan: plan(), fingerprint: "0".repeat(64) }, { env });
        expect(response.status).toBe(409);
        expect(await count("task_items", "title = 'Get quotes'")).toBe(0);
    });

    it("creates the owner's own personal records through the services, safely", async () => {
        await migrate();
        expect(await count("task_projects", "name = 'Renovate kitchen' AND kind = 'personal' AND created_by = ?", OWNER)).toBe(1);
        const quotes = await db()
            .prepare("SELECT id, priority, due_date, deadline, project_id FROM task_items WHERE title = 'Get quotes'")
            .first<Record<string, unknown>>();
        expect(quotes).toMatchObject({ priority: 1, due_date: "2026-10-25", deadline: "2026-11-01" });
        expect(await count("task_items", "parent_id = ? AND title = 'Ask three builders'", quotes!.id)).toBe(1);
        expect(await count("task_goals", "title = 'Finish the house'")).toBe(1);
        expect(await count("task_goal_links")).toBe(1);
        expect(await count("task_project_knowledge_links")).toBe(2);

        // Markup in DalyHub notes is stored as literal text, never as HTML.
        const note = await db().prepare("SELECT content_json AS content FROM knowledge_objects WHERE title = 'Kitchen ideas'").first<{ content: string }>();
        expect(note!.content).toContain("<script>alert(1)</script>");
        expect(JSON.parse(note!.content).content.every((b: { type: string }) => b.type === "paragraph")).toBe(true);

        // The other owner gets none of it.
        const theirs = await apiCall<{ projects: { name: string }[] }>("GET", "/api/portal/tasks/projects", undefined, {
            email: SECOND_OWNER,
            env: await on(),
        });
        expect(theirs.json.projects.map((p) => p.name)).not.toContain("Renovate kitchen");
        const search = await apiCall<{ results: unknown[] }>("GET", "/api/portal/knowledge/search?q=Kitchen", undefined, {
            email: SECOND_OWNER,
            env: await on(),
        });
        expect(JSON.stringify(search.json)).not.toContain("Kitchen ideas");

        // Provenance holds ids only.
        const items = await db().prepare("SELECT * FROM dalyhub_import_items").all<Record<string, unknown>>();
        expect(JSON.stringify(items.results)).not.toMatch(/Kitchen|quotes|plumber/i);
        expect((await db().prepare("SELECT action, summary FROM audit_log WHERE action LIKE 'dalyhub_migration.%'").all()).results).toHaveLength(1);
    });

    it("running the same plan again creates nothing twice", async () => {
        await migrate();
        const before = await snapshot();
        const again = await migrate();
        expect(again.preview.counts).toMatchObject({ create: 0, alreadyImported: 13 });
        const { dalyhub_import_runs: _runs, ...after } = await snapshot();
        const { dalyhub_import_runs: _before, ...expected } = before;
        expect(after).toEqual(expected);
    });

    it("works in bounded batches and resumes with the run id", async () => {
        const big = plan();
        big.tasks = Array.from({ length: APPLY_LIMIT * 2 + 5 }, (_, i) => ({ ...big.tasks[1], sourceId: `bulk-${i}`, title: `Bulk ${i}` }));
        const { calls } = await migrate(big);
        expect(calls).toBeGreaterThanOrEqual(3);
        expect(await count("task_items", "title LIKE 'Bulk %'")).toBe(APPLY_LIMIT * 2 + 5);
    });
});

describe("revert", () => {
    it("previews with dryRun and changes nothing", async () => {
        const { runId } = await migrate();
        const before = await snapshot();
        const dry = await apiCall<{ removed: number; kept: unknown[] }>("POST", `${M}/runs/${runId}/revert`, { dryRun: true }, { env: await on() });
        expect(dry.status, dry.text).toBe(200);
        expect(dry.json.removed).toBe(13);
        expect(await snapshot()).toEqual(before);
    });

    it("removes exactly what was imported and is untouched, keeps anything edited, and Knowledge goes to the Trash", async () => {
        const env = await on();
        const { runId } = await migrate();
        // The owner keeps working after the import:
        const plumber = await db().prepare("SELECT id, version FROM task_items WHERE title = 'Call plumber'").first<{ id: string; version: number }>();
        expect(
            (await apiCall("PATCH", `/api/portal/tasks/tasks/${plumber!.id}`, { version: plumber!.version, title: "Call plumber (rebooked)" }, { env })).status,
        ).toBe(200);
        const project = await db().prepare("SELECT id FROM task_projects WHERE name = 'Renovate kitchen'").first<{ id: string }>();
        expect((await apiCall("POST", "/api/portal/tasks/tasks", { title: "My own new task", projectId: project!.id }, { env })).status).toBe(201);
        const quotes = await db().prepare("SELECT id FROM task_items WHERE title = 'Get quotes'").first<{ id: string }>();

        const reverted = await apiCall<{ removed: number; kept: { kind: string; reason: string }[] }>(
            "POST",
            `${M}/runs/${runId}/revert`,
            { dryRun: false },
            { env },
        );
        expect(reverted.status, reverted.text).toBe(200);
        expect(reverted.json.kept.map((k) => k.kind).sort()).toEqual(["project", "task"]);

        expect(await count("task_items", "title = 'Call plumber (rebooked)'")).toBe(1); // edited: kept
        expect(await count("task_items", "title = 'My own new task'")).toBe(1); // never imported: untouched
        expect(await count("task_projects", "id = ?", project!.id)).toBe(1); // holds those: kept
        expect(await count("task_items", "id = ?", quotes!.id)).toBe(0); // untouched import: removed
        expect(await count("task_items", "title = 'Ask three builders'")).toBe(0);
        expect(await count("task_goals")).toBe(0);
        expect(await count("knowledge_objects", "title = 'Kitchen ideas' AND status = 'trashed'")).toBe(1); // restorable
        expect((await db().prepare("SELECT action FROM audit_log WHERE action = 'dalyhub_migration.revert'").all()).results).toHaveLength(1);

        // Previewing the plan again: what was removed stays removed unless the owner starts over.
        const again = await apiCall<{ counts: { removedSinceImport: number } }>("POST", `${M}/preview`, { plan: plan() }, { env });
        expect(again.json.counts.removedSinceImport).toBeGreaterThan(0);
    });

    it("can't touch another owner's run", async () => {
        const { runId } = await migrate();
        const response = await apiCall("POST", `${M}/runs/${runId}/revert`, { dryRun: false }, { email: SECOND_OWNER, env: await on() });
        expect(response.status).toBe(404);
        expect(await count("task_items", "title = 'Get quotes'")).toBe(1);
    });
});
