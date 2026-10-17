// Daly Tasks: privacy between people, shared projects, the task engine, subtasks, repeats,
// views, filters, comments, Knowledge references, history and export. Every identity is fictional.
import { beforeEach, describe, expect, it } from "vitest";
import { localDate } from "../src/shared/knowledge/dates";
import type { KnowledgeSpace } from "../src/shared/knowledge/types";
import { addDays } from "../src/shared/tasks/dates";
import type { CompletedEntry, KnowledgeReference, TaskActivityEntry, TaskMember, TaskSummary } from "../src/shared/tasks/types";
import type { TasksExport } from "../worker/tasks/export";
import { create as createKnowledge, personal as knowledgeSpace } from "./knowledge-helpers";
import { apiCall, db, resetPortal } from "./portal-helpers";
import { A, ADMIN, B, WEDDING_EDITOR, activityRows, call, createProject, createTask, detail, inbox, list, projects, sharedProject } from "./tasks-helpers";

beforeEach(resetPortal);

const today = () => localDate(new Date(), "Australia/Sydney");
const count = async (sql: string, ...binds: unknown[]) =>
    (await db()
        .prepare(sql)
        .bind(...binds)
        .first<{ n: number }>())!.n;

describe("migration 0015", () => {
    it("refuses in the database what the Worker must never do", async () => {
        const mine = await createProject({ name: "Finances" });
        const theirs = await createProject({ name: "Garden" }, B);
        const now = new Date().toISOString();
        // A second member in a personal project.
        await expect(
            db()
                .prepare("INSERT INTO task_project_members (project_id, email, role, added_by, created_at, updated_at) VALUES (?, ?, 'editor', 'x', ?, ?)")
                .bind(mine.id, B, now, now)
                .run(),
        ).rejects.toThrow(/exactly one member/);
        // A task whose section or parent is in someone else's project.
        const section = (await call<{ section: { id: string } }>("POST", `/projects/${theirs.id}/sections`, { name: "Beds" }, B)).json.section;
        const task = await createTask({ title: "Pay rates", projectId: mine.id });
        await expect(db().prepare("UPDATE task_items SET section_id = ? WHERE id = ?").bind(section.id, task.id).run()).rejects.toThrow(/FOREIGN KEY/);
        const other = await createTask({ title: "Prune roses", projectId: theirs.id }, B);
        await expect(db().prepare("UPDATE task_items SET parent_id = ?, depth = 1 WHERE id = ?").bind(other.id, task.id).run()).rejects.toThrow(/FOREIGN KEY/);
        // An assignee who isn't a member.
        await expect(db().prepare("UPDATE task_items SET assignee_email = ? WHERE id = ?").bind(B, task.id).run()).rejects.toThrow(/FOREIGN KEY/);
        // Too deep, a task its own parent, an Inbox made shared.
        await expect(db().prepare("UPDATE task_items SET depth = 4 WHERE id = ?").bind(task.id).run()).rejects.toThrow(/CHECK/);
        await expect(db().prepare("UPDATE task_items SET parent_id = id, depth = 1 WHERE id = ?").bind(task.id).run()).rejects.toThrow();
        const box = await inbox();
        await expect(db().prepare("UPDATE task_projects SET kind = 'shared' WHERE id = ?").bind(box.id).run()).rejects.toThrow(/Inbox stays personal/);
        // A section with tasks can't be deleted out from under them.
        const own = (await call<{ section: { id: string } }>("POST", `/projects/${mine.id}/sections`, { name: "Bills" })).json.section;
        await call("POST", `/tasks/${task.id}/move`, { sectionId: own.id });
        await expect(db().prepare("DELETE FROM task_sections WHERE id = ?").bind(own.id).run()).rejects.toThrow(/FOREIGN KEY/);
    });
});

describe("access to Tasks", () => {
    it("is for portal owners and admins; wedding editors can't open it", async () => {
        await apiCall("POST", "/api/portal/users", { email: WEDDING_EDITOR, role: "editor" });
        await apiCall("POST", "/api/portal/users", { email: ADMIN, role: "admin" });
        expect((await call("GET", "/projects", undefined, WEDDING_EDITOR)).status).toBe(403);
        expect((await call("GET", "/projects", undefined, ADMIN)).status).toBe(200);
        const page = await apiCall("GET", "/portal/tasks", undefined, { email: WEDDING_EDITOR });
        expect(page.status).toBe(403);
    });

    it("gives everyone exactly one Inbox, even on simultaneous first visits", async () => {
        await Promise.all([call("GET", "/projects"), call("GET", "/projects"), call("GET", "/lists/inbox")]);
        expect(await count("SELECT COUNT(*) AS n FROM task_projects WHERE is_inbox = 1 AND inbox_owner = ?", A)).toBe(1);
        expect(await count("SELECT COUNT(*) AS n FROM task_project_members m JOIN task_projects p ON p.id = m.project_id WHERE p.is_inbox = 1")).toBe(1);
    });

    it("refuses cross-site writes", async () => {
        const { call: raw, accessToken } = await import("./portal-helpers");
        const response = await raw("/api/portal/tasks/tasks", {
            method: "POST",
            token: await accessToken({ email: A }),
            headers: { Origin: "https://evil.example", "Content-Type": "application/json" },
            body: JSON.stringify({ title: "Injected" }),
        });
        expect(response.status).toBe(403);
        const form = await raw("/api/portal/tasks/tasks", {
            method: "POST",
            token: await accessToken({ email: A }),
            headers: { Origin: "https://daly.id.au", "Content-Type": "application/x-www-form-urlencoded" },
            body: "title=Injected",
        });
        expect(form.status).toBe(415);
        expect(await count("SELECT COUNT(*) AS n FROM task_items WHERE title = 'Injected'")).toBe(0);
    });
});

describe("private tasks", () => {
    it("are invisible to the other portal owner by every route", async () => {
        const secret = await createTask({ title: "Surprise gift for B", description: "Bracelet from the markets", dueDate: today(), labels: ["secret"] });
        const project = await createProject({ name: "Private finances" });
        await createTask({ title: "Salary negotiation", projectId: project.id });

        for (const [method, path, body] of [
            ["GET", `/tasks/${secret.id}`],
            ["PATCH", `/tasks/${secret.id}`, { version: secret.version, title: "Hijacked" }],
            ["POST", `/tasks/${secret.id}/complete`, {}],
            ["POST", `/tasks/${secret.id}/reopen`, {}],
            ["POST", `/tasks/${secret.id}/move`, { projectId: (await inbox(B)).id }],
            ["POST", `/tasks/${secret.id}/duplicate`, {}],
            ["DELETE", `/tasks/${secret.id}`],
            ["GET", `/tasks/${secret.id}/comments`],
            ["POST", `/tasks/${secret.id}/comments`, { body: "hi" }],
            ["POST", `/tasks/${secret.id}/reminders`, { kind: "absolute", date: today(), time: "09:00" }],
            ["GET", `/projects/${project.id}`],
            ["PATCH", `/projects/${project.id}`, { version: 1, name: "Mine now" }],
            ["GET", `/projects/${project.id}/members`],
            ["POST", `/projects/${project.id}/sections`, { name: "Sneaky" }],
            ["GET", `/activity?project=${project.id}`],
        ] as [string, string, unknown?][]) {
            const result = await call(method, path, body, B);
            expect(result.status, `${method} ${path}`).toBe(404);
            expect(result.text).not.toContain("Surprise");
        }
        // Creating a task in A's project, or as a subtask of A's task.
        expect((await call("POST", "/tasks", { title: "x", projectId: project.id }, B)).status).toBe(404);
        expect((await call("POST", "/tasks", { title: "x", parentId: secret.id }, B)).status).toBe(404);
        // Bulk changes that include A's task change nothing at all.
        const mine = await createTask({ title: "B's own" }, B);
        expect((await call("POST", "/tasks/bulk", { action: "delete", ids: [mine.id, secret.id] }, B)).status).toBe(404);
        expect(await count("SELECT COUNT(*) AS n FROM task_items WHERE id IN (?, ?)", mine.id, secret.id)).toBe(2);

        // Nor in any list, search, filter, label count, activity or export.
        for (const view of ["inbox", "today", "upcoming", "overdue", "completed"])
            expect((await call("GET", `/lists/${view}`, undefined, B)).text).not.toContain("Surprise");
        const everywhere = [
            await call("GET", "/search?q=surprise", undefined, B),
            await call("GET", "/search?q=bracelet", undefined, B),
            await call("GET", "/filter?labels=secret&status=all", undefined, B),
            await call("GET", "/labels", undefined, B),
            await call("GET", "/activity", undefined, B),
            await call("GET", "/projects", undefined, B),
            await call("GET", "/export", undefined, B),
            await call("GET", "/export?format=csv", undefined, B),
            await call("GET", "/reminders/due", undefined, B),
        ];
        for (const result of everywhere) {
            expect(result.status).toBe(200);
            expect(result.text).not.toMatch(/Surprise|Bracelet|Private finances|Salary|secret/);
        }
        // The pages too: the task link is a 404 page, not a forbidden one that confirms it exists.
        expect((await apiCall("GET", `/portal/tasks/t/${secret.id}`, undefined, { email: B })).status).toBe(404);
        expect((await apiCall("GET", `/portal/tasks/p/${project.id}`, undefined, { email: B })).status).toBe(404);
        // Unknown ids answer the same way as other people's.
        expect((await call("GET", "/tasks/tsk_00000000000000", undefined, B)).status).toBe(404);
    });

    it("keeps titles and descriptions out of the history", async () => {
        const task = await createTask({ title: "Book counselling session", description: "Private" });
        await call("PATCH", `/tasks/${task.id}`, { version: task.version, title: "Book doctor", priority: 1 });
        await call("POST", `/tasks/${task.id}/comments`, { body: "Called, waiting to hear back" });
        const rows = await activityRows();
        expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(["task.create", "task.update", "comment.add"]));
        expect(JSON.stringify(rows)).not.toMatch(/counselling|doctor|Private|Called/);
        expect(JSON.parse(rows.find((r) => r.action === "task.update")!.changes!)).toEqual({ title: true, priority: 1 });
        // And Tasks never writes to the portal-wide audit log.
        expect(await count("SELECT COUNT(*) AS n FROM audit_log WHERE entity_type LIKE 'task%' OR action LIKE 'task%'")).toBe(0);
    });
});

describe("the task engine", () => {
    it("captures to the Inbox with sensible defaults and validates everything", async () => {
        const task = await createTask({ title: "  Renew   passport\n", labels: ["@Admin", "admin", " errands "] });
        expect(task).toMatchObject({
            title: "Renew passport",
            priority: 4,
            dueDate: null,
            projectId: (await inbox()).id,
            labels: ["Admin", "errands"],
            status: "open",
        });
        for (const [body, message] of [
            [{ title: "" }, /title/i],
            [{ title: "x", dueDate: "2026-02-30" }, /real date/],
            [{ title: "x", dueTime: "09:00" }, /date for that time/],
            [{ title: "x", dueDate: "2026-11-01", dueTime: "25:00" }, /time/],
            [{ title: "x", priority: 0 }, /./],
            [{ title: "x", description: "y".repeat(10_001) }, /description/],
            [{ title: "x", labels: Array.from({ length: 21 }, (_, i) => `l${i}`) }, /labels/],
            [{ title: "x", recurrence: { freq: "hourly" } }, /./],
            [{ title: "x", projectId: "'; DROP TABLE task_items; --" }, /valid id/],
            [{ title: "x", owner: B }, /./],
        ] as [Record<string, unknown>, RegExp][]) {
            const result = await call("POST", "/tasks", body);
            expect(result.status, JSON.stringify(body)).toBe(422);
            expect(result.text).toMatch(message);
        }
        // Text is stored as text; nothing is interpreted as markup anywhere on the way.
        const xss = await createTask({ title: '<img src=x onerror="alert(1)">', description: "<script>alert(1)</script>" });
        expect((await detail(xss.id)).task.description).toBe("<script>alert(1)</script>");
    });

    it("edits with versions and never silently overwrites a newer change", async () => {
        const task = await createTask({ title: "Call the plumber" });
        const first = await call<{ task: TaskSummary }>("PATCH", `/tasks/${task.id}`, {
            version: task.version,
            priority: 2,
            dueDate: "2026-11-02",
            deadline: "2026-11-05",
        });
        expect(first.status).toBe(200);
        expect(first.json.task).toMatchObject({ priority: 2, dueDate: "2026-11-02", deadline: "2026-11-05", version: task.version + 1 });
        const stale = await call<{ current: TaskSummary }>("PATCH", `/tasks/${task.id}`, { version: task.version, title: "Old tab" });
        expect(stale.status).toBe(409);
        expect(stale.json.current).toMatchObject({ title: "Call the plumber", priority: 2 });
        // Concurrent edits from the same version: exactly one wins.
        const results = await Promise.all([1, 3].map((priority) => call("PATCH", `/tasks/${task.id}`, { version: first.json.task.version, priority })));
        expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
        // A deadline and a due date are independent.
        const cleared = await call<{ task: TaskSummary }>("PATCH", `/tasks/${task.id}`, { version: first.json.task.version + 1, dueDate: null });
        expect(cleared.json.task).toMatchObject({ dueDate: null, dueTime: null, deadline: "2026-11-05" });
    });

    it("duplicates with subtasks and labels, and deletes with everything attached", async () => {
        const parent = await createTask({ title: "Prepare for holiday", labels: ["travel"] });
        const child = await createTask({ title: "Book accommodation", parentId: parent.id });
        await createTask({ title: "Compare prices", parentId: child.id });
        const copy = (await call<{ task: TaskSummary }>("POST", `/tasks/${parent.id}/duplicate`)).json.task;
        expect(copy).toMatchObject({ title: "Prepare for holiday", labels: ["travel"], subtasks: { open: 1, total: 1 } });
        const copyDetail = await detail(copy.id);
        expect(copyDetail.subtasks[0]).toMatchObject({ title: "Book accommodation", depth: 1, subtasks: { total: 1 } });
        expect(copyDetail.subtasks[0].id).not.toBe(child.id);
        await call("POST", `/tasks/${parent.id}/comments`, { body: "Note" });
        expect((await call("DELETE", `/tasks/${parent.id}`)).status).toBe(200);
        expect(await count("SELECT COUNT(*) AS n FROM task_items WHERE title IN ('Prepare for holiday', 'Book accommodation', 'Compare prices')")).toBe(3); // the copy
        expect(await count("SELECT COUNT(*) AS n FROM task_comments")).toBe(0);
        expect((await activityRows()).some((r) => r.action === "task.delete" && r.task_id === parent.id)).toBe(true);
    });

    it("completes and reopens, keeping the history, and treats a repeat click as done", async () => {
        const task = await createTask({ title: "Lodge tax return", dueDate: today() });
        const done = await call<{ task: TaskSummary; alreadyDone: boolean }>("POST", `/tasks/${task.id}/complete`, { occurrence: today() });
        expect(done.json).toMatchObject({ alreadyDone: false, task: { status: "completed" } });
        expect(done.json.task.completedAt).toBeTruthy();
        const again = await call<{ alreadyDone: boolean }>("POST", `/tasks/${task.id}/complete`, { occurrence: today() });
        expect(again.json.alreadyDone).toBe(true);
        expect(await count("SELECT COUNT(*) AS n FROM task_completions WHERE task_id = ?", task.id)).toBe(1);
        const completed = (await call<{ entries: CompletedEntry[] }>("GET", "/lists/completed")).json.entries;
        expect(completed.map((e) => e.task.id)).toEqual([task.id]);
        const reopened = await call<{ task: TaskSummary }>("POST", `/tasks/${task.id}/reopen`);
        expect(reopened.json.task).toMatchObject({ status: "open", completedAt: null });
        expect(await count("SELECT COUNT(*) AS n FROM task_completions WHERE task_id = ? AND undone_at IS NOT NULL", task.id)).toBe(1);
        expect((await call<{ entries: CompletedEntry[] }>("GET", "/lists/completed")).json.entries).toEqual([]);
    });

    it("applies bulk changes atomically to tasks the caller can edit", async () => {
        const a = await createTask({ title: "One" });
        const b = await createTask({ title: "Two" });
        const project = await createProject({ name: "Garden" });
        expect((await call("POST", "/tasks/bulk", { action: "priority", ids: [a.id, b.id], priority: 1 })).status).toBe(200);
        expect((await call("POST", "/tasks/bulk", { action: "due", ids: [a.id, b.id], dueDate: today() })).status).toBe(200);
        expect((await call("POST", "/tasks/bulk", { action: "label", ids: [a.id, b.id], label: "@weekend" })).status).toBe(200);
        expect((await call("POST", "/tasks/bulk", { action: "move", ids: [a.id, b.id], projectId: project.id })).status).toBe(200);
        const moved = (await call<{ tasks: TaskSummary[] }>("GET", `/projects/${project.id}`)).json.tasks;
        expect(moved.map((t) => [t.title, t.priority, t.dueDate, t.labels])).toEqual([
            ["One", 1, today(), ["weekend"]],
            ["Two", 1, today(), ["weekend"]],
        ]);
        expect((await call("POST", "/tasks/bulk", { action: "complete", ids: [a.id, b.id] })).status).toBe(200);
        expect(await count("SELECT COUNT(*) AS n FROM task_items WHERE status = 'completed'")).toBe(2);
        expect((await call("POST", "/tasks/bulk", { action: "complete", ids: Array.from({ length: 101 }, () => a.id) })).status).toBe(422);
    });
});

describe("subtasks", () => {
    it("nest to a limit, refuse cycles and move with their parent", async () => {
        const root = await createTask({ title: "Renovate bathroom" });
        const l1 = await createTask({ title: "Choose tiles", parentId: root.id });
        const l2 = await createTask({ title: "Visit showroom", parentId: l1.id });
        const l3 = await createTask({ title: "Measure floor", parentId: l2.id });
        expect([l1.depth, l2.depth, l3.depth]).toEqual([1, 2, 3]);
        expect((await call("POST", "/tasks", { title: "Too deep", parentId: l3.id })).status).toBe(422);
        // Under its own descendant: refused.
        const cycle = await call("POST", `/tasks/${root.id}/move`, { parentId: l2.id });
        expect(cycle.status).toBe(422);
        expect(cycle.text).toMatch(/own subtasks/);
        // A move that would make the tree too deep: refused.
        const other = await createTask({ title: "Other" });
        expect((await call("POST", `/tasks/${other.id}/move`, { parentId: l3.id })).status).toBe(422);
        const otherChild = await createTask({ title: "Other child", parentId: other.id });
        expect((await call("POST", `/tasks/${l1.id}/move`, { parentId: otherChild.id })).status).toBe(422);
        // Promote a subtask to the top level.
        const promoted = (await call<{ task: TaskSummary }>("POST", `/tasks/${l2.id}/move`, { parentId: null })).json.task;
        expect(promoted).toMatchObject({ parentId: null, depth: 0 });
        expect((await detail(l3.id)).task.depth).toBe(1);
        // Moving a parent to another project takes its subtasks along, into the right section.
        const project = await createProject({ name: "House", sections: ["Bathroom"] });
        const section = (await call<{ sections: { id: string }[] }>("GET", `/projects/${project.id}`)).json.sections[0];
        await call("POST", `/tasks/${l2.id}/move`, { projectId: project.id, sectionId: section.id });
        const moved = (await call<{ tasks: TaskSummary[] }>("GET", `/projects/${project.id}`)).json.tasks;
        expect(moved.map((t) => [t.title, t.depth, t.sectionId])).toEqual([
            ["Visit showroom", 0, section.id],
            ["Measure floor", 1, section.id],
        ]);
    });

    it("never completes open subtasks silently", async () => {
        const parent = await createTask({ title: "Pack for camping" });
        const tent = await createTask({ title: "Tent", parentId: parent.id });
        const stove = await createTask({ title: "Stove", parentId: parent.id });
        await call("POST", `/tasks/${tent.id}/complete`, {});
        const refused = await call<{ error: string; count: number }>("POST", `/tasks/${parent.id}/complete`, {});
        expect(refused.status).toBe(409);
        expect(refused.json).toMatchObject({ error: "open_subtasks", count: 1 });
        expect((await detail(stove.id)).task.status).toBe("open");
        const done = await call("POST", `/tasks/${parent.id}/complete`, { includeSubtasks: true });
        expect(done.status).toBe(200);
        expect((await detail(stove.id)).task.status).toBe("completed");
        // Subtasks complete and reopen on their own.
        await call("POST", `/tasks/${tent.id}/reopen`);
        expect((await detail(tent.id)).task.status).toBe("open");
        expect((await detail(parent.id)).task.status).toBe("completed");
    });
});

describe("projects and sections", () => {
    it("organise tasks, report progress and never lose tasks when a section goes", async () => {
        const project = await createProject({
            name: "Wedding Planning",
            color: "pink",
            sections: ["Venue", "Catering", "Transport"],
            targetDate: "2027-10-23",
        });
        const loaded = await call<{ sections: { id: string; name: string }[] }>("GET", `/projects/${project.id}`);
        const [venue, catering, transport] = loaded.json.sections;
        expect(loaded.json.sections.map((s) => s.name)).toEqual(["Venue", "Catering", "Transport"]);
        await call("POST", `/sections/${transport.id}/position`, { afterId: null });
        await call("PATCH", `/sections/${catering.id}`, { name: "Food" });
        const order = (await call<{ sections: { name: string }[] }>("GET", `/projects/${project.id}`)).json.sections.map((s) => s.name);
        expect(order).toEqual(["Transport", "Venue", "Food"]);

        const a = await createTask({ title: "Confirm venue", projectId: project.id, sectionId: venue.id });
        const b = await createTask({ title: "Taste menu", projectId: project.id, sectionId: catering.id });
        await createTask({ title: "Book buses", projectId: project.id, sectionId: transport.id });
        // Reorder within a section, then complete one.
        const c = await createTask({ title: "Sign contract", projectId: project.id, sectionId: venue.id });
        await call("POST", `/tasks/${c.id}/move`, { beforeId: a.id });
        const venueTasks = (await call<{ tasks: TaskSummary[] }>("GET", `/projects/${project.id}`)).json.tasks.filter((t) => t.sectionId === venue.id);
        expect(venueTasks.map((t) => t.title)).toEqual(["Sign contract", "Confirm venue"]);
        await call("POST", `/tasks/${a.id}/complete`, {});
        const progress = (await call<{ project: { counts: { open: number; completed: number } } }>("GET", `/projects/${project.id}`)).json.project.counts;
        expect(progress).toMatchObject({ open: 3, completed: 1 });

        // Deleting a section moves its tasks; they're never deleted.
        expect((await call("POST", `/sections/${catering.id}/delete`, { moveTo: venue.id })).status).toBe(200);
        expect((await detail(b.id)).task.sectionId).toBe(venue.id);
        expect((await call("POST", `/sections/${venue.id}/delete`, {})).status).toBe(200);
        expect((await detail(b.id)).task.sectionId).toBeNull();
        expect(await count("SELECT COUNT(*) AS n FROM task_items WHERE project_id = ?", project.id)).toBe(4);
    });

    it("keep the Inbox fixed, archive read-only and delete only with confirmation", async () => {
        const box = await inbox();
        expect((await call("PATCH", `/projects/${box.id}`, { version: box.version, name: "Mine" })).status).toBe(422);
        expect((await call("POST", `/projects/${box.id}/delete`, { confirm: "DELETE" })).status).toBe(422);
        expect((await call("POST", `/projects/${box.id}/kind`, { kind: "shared" })).status).toBe(422);
        const project = await createProject({ name: "Old house" });
        const task = await createTask({ title: "Return keys", projectId: project.id });
        await call("PATCH", `/projects/${project.id}`, { version: project.version, status: "archived" });
        expect((await call("PATCH", `/tasks/${task.id}`, { version: task.version, title: "x" })).status).toBe(422);
        expect((await call("POST", "/tasks", { title: "x", projectId: project.id })).status).toBe(422);
        expect((await call("POST", `/projects/${project.id}/delete`, {})).status).toBe(422);
        expect((await call("POST", `/projects/${project.id}/delete`, { confirm: "DELETE" })).status).toBe(200);
        expect(await count("SELECT COUNT(*) AS n FROM task_items WHERE id = ?", task.id)).toBe(0);
    });
});

describe("shared projects", () => {
    it("let both people see, assign and edit, and nothing else of each other's", async () => {
        const project = await sharedProject("editor");
        const bins = await createTask({ title: "Take bins out", projectId: project.id, dueDate: today() });
        expect(await list("today", B)).toEqual([expect.objectContaining({ id: bins.id })]);
        // Assigned to A: it leaves B's Today, stays in the project, and never enters anyone's Inbox.
        await call("PATCH", `/tasks/${bins.id}`, { version: bins.version, assignee: A }, B);
        expect(await list("today", B)).toEqual([]);
        expect((await list("today", A)).map((t) => t.id)).toEqual([bins.id]);
        expect(await list("inbox", A)).toEqual([]);
        // Only members who can edit can be assigned.
        const stranger = await call("PATCH", `/tasks/${bins.id}`, { version: bins.version + 1, assignee: "stranger@example.com" });
        expect(stranger.status).toBe(422);
        expect((await call("POST", "/tasks", { title: "x", assignee: B })).status).toBe(422); // personal Inbox
        // B's personal tasks stay B's.
        const hers = await createTask({ title: "B's dentist" }, B);
        expect((await call("GET", `/tasks/${hers.id}`)).status).toBe(404);
    });

    it("limits viewers to reading and removes access immediately", async () => {
        const project = await sharedProject("viewer");
        const task = await createTask({ title: "Paint the fence", projectId: project.id, dueDate: today() });
        expect((await call("GET", `/tasks/${task.id}`, undefined, B)).status).toBe(200);
        expect((await call("PATCH", `/tasks/${task.id}`, { version: task.version, title: "x" }, B)).status).toBe(403);
        expect((await call("POST", `/tasks/${task.id}/complete`, {}, B)).status).toBe(403);
        expect((await call("POST", `/tasks/${task.id}/comments`, { body: "x" }, B)).status).toBe(403);
        expect((await call("PATCH", `/tasks/${task.id}`, { version: task.version, assignee: B })).status).toBe(422);
        // A viewer may still remind themselves.
        expect((await call("POST", `/tasks/${task.id}/reminders`, { kind: "absolute", date: today(), time: "08:00" }, B)).status).toBe(201);
        // Viewers don't get shared tasks in their Today.
        expect(await list("today", B)).toEqual([]);

        // Promote, assign, then remove: the assignment and reminders go, and so does every way in.
        await call("PATCH", `/projects/${project.id}/members/${encodeURIComponent(B)}`, { role: "editor" });
        const assigned = (await call<{ task: TaskSummary }>("PATCH", `/tasks/${task.id}`, { version: task.version, assignee: B })).json.task;
        expect(assigned.assignee).toBe(B);
        expect((await call("DELETE", `/projects/${project.id}/members/${encodeURIComponent(B)}`)).status).toBe(200);
        expect((await call("GET", `/tasks/${task.id}`, undefined, B)).status).toBe(404);
        expect((await call("GET", `/projects/${project.id}`, undefined, B)).status).toBe(404);
        expect((await detail(task.id)).task.assignee).toBeNull();
        expect(await count("SELECT COUNT(*) AS n FROM task_reminders WHERE owner_email = ?", B)).toBe(0);
        expect(JSON.stringify(await call("GET", "/search?q=fence", undefined, B))).not.toContain("Paint");
    });

    it("always keeps an owner and only adds people who can open Tasks", async () => {
        const project = await sharedProject("editor");
        expect((await call("POST", `/projects/${project.id}/members`, { email: "nobody@example.com", role: "editor" })).status).toBe(422);
        await apiCall("POST", "/api/portal/users", { email: WEDDING_EDITOR, role: "editor" });
        expect((await call("POST", `/projects/${project.id}/members`, { email: WEDDING_EDITOR, role: "viewer" })).status).toBe(422);
        expect((await call("PATCH", `/projects/${project.id}/members/${encodeURIComponent(A)}`, { role: "editor" })).status).toBe(422);
        expect((await call("DELETE", `/projects/${project.id}/members/${encodeURIComponent(A)}`)).status).toBe(422);
        // Editors can't manage members; anyone can leave.
        expect((await call("POST", `/projects/${project.id}/members`, { email: ADMIN, role: "viewer" }, B)).status).toBe(403);
        expect((await call("DELETE", `/projects/${project.id}/members/${encodeURIComponent(B)}`, undefined, B)).status).toBe(200);
        const members = (await call<{ members: TaskMember[] }>("GET", `/projects/${project.id}/members`)).json.members;
        expect(members.map((m) => m.email)).toEqual([A]);
        // Only then can it become personal again.
        expect((await call("POST", `/projects/${project.id}/kind`, { kind: "personal" })).status).toBe(200);
        expect((await call("POST", `/projects/${project.id}/members`, { email: B, role: "editor" })).status).toBe(422);
    });
});

describe("dates and views", () => {
    it("puts tasks in Today, Upcoming and Overdue by their calendar date", async () => {
        const t = today();
        const overdue = await createTask({ title: "Overdue bill", dueDate: addDays(t, -2) });
        const due = await createTask({ title: "Due today", dueDate: t, dueTime: "17:30" });
        const deadline = await createTask({ title: "Deadline today", deadline: t });
        const later = await createTask({ title: "Next week", dueDate: addDays(t, 6) });
        const undated = await createTask({ title: "Someday", priority: 1 });
        expect((await list("today")).map((x) => x.id)).toEqual([overdue.id, due.id, deadline.id]);
        expect((await list("overdue")).map((x) => x.id)).toEqual([overdue.id]);
        expect((await list("upcoming")).map((x) => x.id)).toEqual([due.id, later.id]);
        // Undated urgent tasks join Today only if the person asks.
        await call("PATCH", "/preferences", { todayPriority: 1 });
        expect((await list("today")).map((x) => x.id)).toContain(undated.id);
        // Rescheduling moves it out of Today straight away.
        await call("PATCH", `/tasks/${due.id}`, { version: due.version, dueDate: addDays(t, 1) });
        expect((await list("today")).map((x) => x.id)).not.toContain(due.id);
        // A date-only task stays on its date in any time zone.
        await call("PATCH", "/preferences", { timeZone: "Pacific/Honolulu" });
        expect((await detail(later.id)).task.dueDate).toBe(addDays(t, 6));
        expect((await call("PATCH", "/preferences", { timeZone: "Mars/Olympus" })).status).toBe(422);
    });

    it("projects repeats into Upcoming without storing them", async () => {
        const t = today();
        await createTask({ title: "Water plants", dueDate: t, recurrence: { freq: "daily", interval: 3 } });
        const upcoming = await list("upcoming", A, "?days=10");
        expect(upcoming.filter((x) => x.title === "Water plants").map((x) => [x.dueDate, !!x.projected])).toEqual([
            [t, false],
            [addDays(t, 3), true],
            [addDays(t, 6), true],
            [addDays(t, 9), true],
        ]);
        expect(await count("SELECT COUNT(*) AS n FROM task_items")).toBe(1);
    });
});

describe("repeating tasks", () => {
    it("advance once per occurrence, keep history and can be undone", async () => {
        const t = today();
        const task = await createTask({ title: "Take bins out", dueDate: t, recurrence: { freq: "weekly" } });
        expect(task.recurrence).toMatchObject({ freq: "weekly", anchor: t });
        const done = await call<{ task: TaskSummary; nextDate: string }>("POST", `/tasks/${task.id}/complete`, { occurrence: t });
        expect(done.json).toMatchObject({ nextDate: addDays(t, 7), task: { status: "open", dueDate: addDays(t, 7) } });
        // The same click again, or two people at once, records nothing more.
        const again = await call<{ alreadyDone: boolean }>("POST", `/tasks/${task.id}/complete`, { occurrence: t });
        expect(again.json.alreadyDone).toBe(true);
        const racing = await Promise.all(
            [1, 2, 3].map(() => call<{ alreadyDone: boolean }>("POST", `/tasks/${task.id}/complete`, { occurrence: addDays(t, 7) })),
        );
        expect(racing.every((r) => r.status === 200)).toBe(true);
        expect(racing.filter((r) => !r.json.alreadyDone)).toHaveLength(1);
        expect(await count("SELECT COUNT(*) AS n FROM task_completions WHERE task_id = ?", task.id)).toBe(2);
        expect((await detail(task.id)).task.dueDate).toBe(addDays(t, 14));
        // Undo the latest completion: back to the occurrence it was.
        const undone = await call<{ task: TaskSummary }>("POST", `/tasks/${task.id}/reopen`);
        expect(undone.json.task.dueDate).toBe(addDays(t, 7));
        // Skip one: recorded as skipped.
        await call("POST", `/tasks/${task.id}/skip`, { occurrence: addDays(t, 7) });
        const history = (await detail(task.id)).completions;
        expect(history.map((c) => [c.kind, c.occurrenceDate, !!c.undoneAt])).toEqual([
            ["skipped", addDays(t, 7), false],
            ["completed", addDays(t, 7), true],
            ["completed", t, false],
        ]);
        // Stopping the repeat keeps the task; clearing the date of a repeating one is refused.
        const current = (await detail(task.id)).task;
        expect((await call("PATCH", `/tasks/${task.id}`, { version: current.version, dueDate: null })).status).toBe(422);
        const stopped = await call<{ task: TaskSummary }>("PATCH", `/tasks/${task.id}`, { version: current.version, recurrence: null });
        expect(stopped.json.task.recurrence).toBeNull();
    });

    it("start on their first occurrence, move deadlines along and reset checklists", async () => {
        const task = await createTask({ title: "Weekly clean", recurrence: { freq: "weekly", weekdays: [6] } });
        expect(task.dueDate! >= today()).toBe(true);
        const saturday = new Date(`${task.dueDate}T00:00:00Z`).getUTCDay();
        expect(saturday).toBe(6);
        await call("PATCH", `/tasks/${task.id}`, { version: task.version, deadline: addDays(task.dueDate!, 1) });
        const step = await createTask({ title: "Vacuum", parentId: task.id });
        await call("POST", `/tasks/${step.id}/complete`, {});
        const done = await call<{ task: TaskSummary }>("POST", `/tasks/${task.id}/complete`, { occurrence: task.dueDate });
        expect(done.json.task).toMatchObject({ dueDate: addDays(task.dueDate!, 7), deadline: addDays(task.dueDate!, 8) });
        expect((await detail(step.id)).task.status).toBe("open");
    });

    it("ends at the end date", async () => {
        const t = today();
        const task = await createTask({ title: "Course homework", dueDate: t, recurrence: { freq: "weekly", until: addDays(t, 3) } });
        const done = await call<{ task: TaskSummary; nextDate: string | null }>("POST", `/tasks/${task.id}/complete`, { occurrence: t });
        expect(done.json).toMatchObject({ nextDate: null, task: { status: "completed" } });
    });
});

describe("labels, filters and search", () => {
    it("filter across personal and shared tasks the caller can see, by validated definitions only", async () => {
        const project = await sharedProject("editor");
        await createTask({ title: "Buy milk", labels: ["errands"], priority: 2 });
        await createTask({ title: "Buy paint", labels: ["errands", "house"], projectId: project.id });
        await createTask({ title: "B's errand", labels: ["errands"] }, B);
        const any = (await call<{ tasks: TaskSummary[] }>("GET", "/filter?labels=errands")).json.tasks.map((t) => t.title);
        expect(any.sort()).toEqual(["Buy milk", "Buy paint"]);
        const both = (await call<{ tasks: TaskSummary[] }>("GET", "/filter?labels=errands,house&labelMode=all")).json.tasks.map((t) => t.title);
        expect(both).toEqual(["Buy paint"]);
        expect((await call<{ tasks: TaskSummary[] }>("GET", "/filter?priorities=2")).json.tasks.map((t) => t.title)).toEqual(["Buy milk"]);
        expect((await call<{ tasks: TaskSummary[] }>("GET", "/filter?scope=shared")).json.tasks.map((t) => t.title)).toEqual(["Buy paint"]);

        const saved = await call<{ view: { id: string; version: number } }>("POST", "/filters", { name: "Errands", definition: { labels: ["errands"] } });
        expect(saved.status).toBe(201);
        expect((await call("POST", "/filters", { name: "Bad", definition: { sql: "1=1" } })).status).toBe(422);
        expect((await call("POST", "/filters", { name: "Bad", definition: { due: "DROP TABLE" } })).status).toBe(422);
        expect((await call("GET", `/filters/${saved.json.view.id}`, undefined, B)).status).toBe(404);
        const results = (await call<{ tasks: TaskSummary[] }>("GET", `/filters/${saved.json.view.id}`)).json.tasks;
        expect(results).toHaveLength(2);
        // Rename and delete labels: only tasks the person can edit change.
        const labels = (await call<{ labels: { id: string; name: string; openCount: number }[] }>("GET", "/labels")).json.labels;
        const errands = labels.find((l) => l.name === "errands")!;
        expect(errands.openCount).toBe(2);
        await call("PATCH", `/labels/${errands.id}`, { name: "Shopping" });
        expect((await call<{ tasks: TaskSummary[] }>("GET", "/filter?labels=Shopping")).json.tasks).toHaveLength(2);
        expect((await call<{ tasks: TaskSummary[] }>("GET", "/filter?labels=errands", undefined, B)).json.tasks.map((t) => t.title)).toEqual(["B's errand"]);
    });

    it("searches safely", async () => {
        await createTask({ title: "Pay 100% of invoice_7", description: "Electricity" });
        await createTask({ title: "Pay 1000 to savings" });
        const hits = async (q: string) => (await call<{ tasks: TaskSummary[] }>("GET", `/search?q=${encodeURIComponent(q)}`)).json.tasks.map((t) => t.title);
        expect(await hits("100%")).toEqual(["Pay 100% of invoice_7"]);
        expect(await hits("invoice_")).toEqual(["Pay 100% of invoice_7"]);
        expect(await hits("pay electricity")).toEqual(["Pay 100% of invoice_7"]);
        expect(await hits("' OR 1=1 --")).toEqual([]);
        expect(await hits("")).toEqual([]);
    });
});

describe("comments", () => {
    it("are plain text for members, edited by their authors only", async () => {
        const project = await sharedProject("editor");
        const task = await createTask({ title: "Plan picnic", projectId: project.id });
        const added = await call<{ comments: { id: string; body: string; author: string }[] }>("POST", `/tasks/${task.id}/comments`, {
            body: "  <b>Bring</b> rugs\n\n",
        });
        expect(added.json.comments[0]).toMatchObject({ body: "<b>Bring</b> rugs", author: A });
        const commentId = added.json.comments[0].id;
        expect((await call("PATCH", `/comments/${commentId}`, { body: "Edited by B" }, B)).status).toBe(403);
        expect((await call("DELETE", `/comments/${commentId}`, undefined, B)).status).toBe(403);
        expect((await call("POST", `/tasks/${task.id}/comments`, { body: "x".repeat(5001) })).status).toBe(422);
        const b = await call<{ comments: { id: string }[] }>("POST", `/tasks/${task.id}/comments`, { body: "I'll bring the esky" }, B);
        // A project owner can remove anyone's comment.
        expect((await call("DELETE", `/comments/${b.json.comments[1].id}`)).status).toBe(200);
        expect((await detail(task.id)).comments.map((c) => c.body)).toEqual(["<b>Bring</b> rugs"]);
    });
});

describe("Knowledge references", () => {
    const linkTo = (taskId: string, objectId: string, email = A) =>
        call<{ knowledge: KnowledgeReference[] }>("POST", `/tasks/${taskId}/knowledge`, { objectId }, email);

    it("show only what each person can read in Knowledge", async () => {
        const mySpace = await knowledgeSpace(A);
        const note = await createKnowledge(mySpace.id, { title: "Accommodation shortlist" });
        const project = await sharedProject("editor");
        const task = await createTask({ title: "Confirm accommodation", projectId: project.id });
        const linked = await linkTo(task.id, note.object.id);
        expect(linked.status).toBe(201);
        expect(linked.json.knowledge).toEqual([expect.objectContaining({ available: true, title: "Accommodation shortlist", objectId: note.object.id })]);
        // B sees the task but not A's private note: a neutral placeholder, no title, no id.
        const seen = (await detail(task.id, B)).knowledge;
        expect(seen).toEqual([{ linkId: linked.json.knowledge[0].linkId, available: false }]);
        expect(JSON.stringify(await detail(task.id, B))).not.toContain("Accommodation shortlist");
        expect(JSON.stringify(await detail(task.id, B))).not.toContain(note.object.id);
        // B can't link A's note, or probe for it, from Tasks.
        const theirs = await createTask({ title: "B's task" }, B);
        expect((await linkTo(theirs.id, note.object.id, B)).status).toBe(404);
        expect((await linkTo(theirs.id, "kob_00000000000000", B)).status).toBe(404);
        expect((await call("GET", `/knowledge/${note.object.id}`, undefined, B)).status).toBe(404);
        // B's export doesn't carry the object id either.
        const exported = (await call<TasksExport>("GET", "/export", undefined, B)).json;
        expect(exported.tasks.find((x) => x.id === task.id)!.knowledgeObjectIds).toEqual([]);
        // Reverse lookup for A.
        expect((await call<{ tasks: TaskSummary[] }>("GET", `/knowledge/${note.object.id}`)).json.tasks.map((x) => x.id)).toEqual([task.id]);
    });

    it("follow Knowledge membership as it changes", async () => {
        const created = await apiCall<{ space: KnowledgeSpace }>("POST", "/api/portal/knowledge/spaces", { name: "Household notes" });
        const space = created.json.space;
        await apiCall("POST", `/api/portal/knowledge/spaces/${space.id}/members`, { email: B, role: "viewer" });
        const note = await createKnowledge(space.id, { title: "Bin collection days" });
        const project = await sharedProject("editor");
        const task = await createTask({ title: "Put bins out", projectId: project.id });
        await linkTo(task.id, note.object.id);
        expect((await detail(task.id, B)).knowledge[0]).toMatchObject({ available: true, title: "Bin collection days" });
        // Knowledge access removed: the title disappears on the next read.
        await apiCall("DELETE", `/api/portal/knowledge/spaces/${space.id}/members/${encodeURIComponent(B)}`);
        expect((await detail(task.id, B)).knowledge[0]).toEqual({ linkId: expect.any(String), available: false });
        // Trashed: unavailable for everyone. Deleted permanently: the reference goes with it.
        await apiCall("POST", `/api/portal/knowledge/objects/${note.object.id}/status/trash`, {});
        expect((await detail(task.id)).knowledge[0].available).toBe(false);
        await apiCall("POST", `/api/portal/knowledge/objects/${note.object.id}/delete`, { confirm: "DELETE" });
        expect((await detail(task.id)).knowledge).toEqual([]);
        // Unlinking works even without access to the object.
        const other = await createKnowledge((await knowledgeSpace(A)).id, { title: "Mine" });
        const link = (await linkTo(task.id, other.object.id)).json.knowledge[0];
        expect((await call("DELETE", `/tasks/${task.id}/knowledge/${link.linkId}`, undefined, B)).status).toBe(200);
        expect((await detail(task.id)).knowledge).toEqual([]);
        // The history says a reference was added, not which.
        expect(JSON.stringify(await activityRows())).not.toMatch(/kob_|Bin collection/);
    });
});

describe("reminders", () => {
    it("are per person, in their time zone, and follow the task", async () => {
        const task = await createTask({ title: "Ring the vet", dueDate: "2026-12-01", dueTime: "09:00" });
        const absolute = await call<{ reminders: { remindAt: string }[] }>("POST", `/tasks/${task.id}/reminders`, {
            kind: "absolute",
            date: "2026-07-01",
            time: "08:15",
        });
        expect(absolute.json.reminders[0].remindAt).toBe("2026-06-30T22:15:00.000Z");
        const relative = await call<{ reminders: { kind: string; remindAt: string }[] }>("POST", `/tasks/${task.id}/reminders`, {
            kind: "relative",
            offsetMinutes: 30,
        });
        expect(relative.json.reminders.find((r) => r.kind === "relative")!.remindAt).toBe("2026-11-30T21:30:00.000Z");
        await call("PATCH", `/tasks/${task.id}`, { version: task.version, dueDate: "2026-12-02" });
        expect((await detail(task.id)).reminders.find((r) => r.kind === "relative")!.remindAt).toBe("2026-12-01T21:30:00.000Z");
        // Due reminders come back for their owner only.
        const due = (await call<{ reminders: { taskId: string }[] }>("GET", "/reminders/due")).json.reminders;
        expect(due.map((r) => r.taskId)).toEqual([task.id]);
        // Completing a one-off task dismisses its reminders.
        await call("POST", `/tasks/${task.id}/complete`, {});
        expect((await call<{ reminders: unknown[] }>("GET", "/reminders/due")).json.reminders).toEqual([]);
    });
});

describe("history", () => {
    it("is readable by the project's current members only, with titles only where they can still see the task", async () => {
        const project = await sharedProject("editor");
        const task = await createTask({ title: "Shared errand", projectId: project.id });
        const entries = (await call<{ entries: TaskActivityEntry[] }>("GET", `/activity?project=${project.id}`, undefined, B)).json.entries;
        expect(entries.find((e) => e.action === "task.create")).toMatchObject({ taskTitle: "Shared errand", actor: A });
        // A moves it into A's personal project: B's view of the history keeps the entry, not the title.
        await call("POST", `/tasks/${task.id}/move`, { projectId: (await inbox()).id });
        const after = (await call<{ entries: TaskActivityEntry[] }>("GET", `/activity?project=${project.id}`, undefined, B)).json.entries;
        expect(after.map((e) => e.action)).toContain("task.move_out");
        expect(JSON.stringify(after)).not.toContain("Shared errand");
    });
});

describe("export", () => {
    it("is versioned, complete and limited to the caller's projects", async () => {
        const project = await createProject({ name: "Holiday", sections: ["Bookings"] });
        const section = (await call<{ sections: { id: string }[] }>("GET", `/projects/${project.id}`)).json.sections[0];
        const parent = await createTask({ title: "Plan trip", projectId: project.id, sectionId: section.id, labels: ["travel"], deadline: "2027-01-10" });
        const child = await createTask({ title: '=HYPERLINK("http://evil")', parentId: parent.id });
        const repeat = await createTask({ title: "Check passport", dueDate: today(), recurrence: { freq: "monthly", monthDay: -1 } });
        await call("POST", `/tasks/${repeat.id}/complete`, { occurrence: repeat.dueDate });
        await call("POST", `/tasks/${parent.id}/comments`, { body: "Look at ferries" });
        await createTask({ title: "B's own" }, B);

        const json = await call<TasksExport>("GET", "/export");
        expect(json.headers.get("Content-Disposition")).toMatch(/attachment; filename="daly-tasks-\d{4}-\d{2}-\d{2}\.json"/);
        expect(json.headers.get("Cache-Control")).toBe("private, no-store");
        const data = json.json;
        expect(data).toMatchObject({ format: "daly.tasks", version: 1, exportedBy: A });
        expect(data.projects.map((p) => p.name).sort()).toEqual(["Holiday", "Inbox"]);
        expect(data.projects.find((p) => p.name === "Holiday")!.sections).toEqual([expect.objectContaining({ id: section.id, name: "Bookings" })]);
        const ids = new Set(data.tasks.map((t) => t.id));
        // Every relationship points at something in the export.
        for (const t of data.tasks) {
            expect(data.projects.some((p) => p.id === t.projectId)).toBe(true);
            if (t.parentId) expect(ids.has(t.parentId)).toBe(true);
            if (t.sectionId) expect(data.projects.some((p) => p.sections.some((s) => s.id === t.sectionId))).toBe(true);
        }
        expect(data.tasks.find((t) => t.id === child.id)!.parentId).toBe(parent.id);
        expect(data.tasks.find((t) => t.id === parent.id)).toMatchObject({
            labels: ["travel"],
            deadline: "2027-01-10",
            comments: [expect.objectContaining({ body: "Look at ferries" })],
        });
        expect(data.tasks.find((t) => t.id === repeat.id)!.rrule).toContain("BYMONTHDAY=-1");
        expect(data.completions).toEqual([expect.objectContaining({ taskId: repeat.id, kind: "completed" })]);
        expect(data.labels).toEqual([{ name: "travel", color: "gray" }]);
        expect(JSON.stringify(data)).not.toContain("B's own");

        const csv = await call("GET", "/export?format=csv");
        expect(csv.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
        expect(csv.text).toContain("'=HYPERLINK");
        expect(csv.text.split("\r\n")[0]).toContain("Task ID,Title,Description,Project");
        expect(csv.text.split("\r\n").filter(Boolean)).toHaveLength(1 + data.tasks.length);
        // Personal-only export leaves shared projects out.
        await sharedProject("editor", "Shared stuff");
        const personalOnly = (await call<TasksExport>("GET", "/export?scope=personal")).json;
        expect(personalOnly.projects.some((p) => p.kind === "shared")).toBe(false);
    });
});

describe("pages", () => {
    it("load for every Tasks route and 404 for anything not the caller's", async () => {
        const project = await createProject({ name: "Pages" });
        const task = await createTask({ title: "Page task", projectId: project.id });
        for (const path of [
            "/portal/tasks",
            "/portal/tasks/inbox",
            "/portal/tasks/today",
            "/portal/tasks/upcoming",
            "/portal/tasks/overdue",
            "/portal/tasks/completed",
            "/portal/tasks/projects",
            "/portal/tasks/projects?kind=shared",
            `/portal/tasks/p/${project.id}`,
            `/portal/tasks/p/${project.id}?view=board`,
            `/portal/tasks/p/${project.id}?view=overview`,
            `/portal/tasks/t/${task.id}`,
            "/portal/tasks/labels",
            "/portal/tasks/filters?due=overdue",
            "/portal/tasks/search?q=page",
            "/portal/tasks/activity",
            "/portal/tasks/settings",
        ]) {
            expect((await apiCall("GET", path)).status, path).toBe(200);
        }
        expect((await apiCall("GET", "/portal/tasks/p/tpj_00000000000000")).status).toBe(404);
        // Tasks never appear on the public site or the wedding site.
        for (const path of ["/", "/wedding", "/posts"]) expect((await apiCall("GET", path)).text).not.toContain("Page task");
    });
});
