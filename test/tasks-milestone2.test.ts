// Daly Tasks, Milestone 2, through the real API and database: capture from anywhere (idempotent,
// with Knowledge links), occurrence and series changes, exceptions, bulk shifting, planning views,
// preferences, templates, Todoist import and background reminders. Every identity is fictional.
import { createElement } from "react";
import { renderToString } from "react-dom/server.edge";
import { beforeEach, describe, expect, it } from "vitest";
import errandsCsv from "../fixtures/todoist/Errands.csv?raw";
import householdCsv from "../fixtures/todoist/Household [1000000001].csv?raw";
import { PortalApp } from "../src/portal/portal-app";
import { localDate } from "../src/shared/knowledge/dates";
import { addDays, weekStart } from "../src/shared/tasks/dates";
import type { TaskTemplate } from "../src/shared/tasks/templates";
import type { TaskDetail, TaskPreferences, TaskSummary, TasksShell } from "../src/shared/tasks/types";
import type { EmailProvider, OutgoingEmail } from "../worker/comms/providers";
import { ProviderError } from "../worker/comms/providers";
import { processTaskReminders } from "../worker/tasks/notify";
import { create as createKnowledge, personal as knowledgeSpace } from "./knowledge-helpers";
import { apiCall, db, portalEnv, resetPortal } from "./portal-helpers";
import { A, B, call, createProject, createTask, detail, list, sharedProject } from "./tasks-helpers";

beforeEach(resetPortal);

const today = () => localDate(new Date(), "Australia/Sydney");
const count = async (sql: string, ...binds: unknown[]) =>
    (await db()
        .prepare(sql)
        .bind(...binds)
        .first<{ n: number }>())!.n;
const update = (id: string, version: number, fields: Record<string, unknown>, email = A) =>
    call<{ task: TaskSummary }>("PATCH", `/tasks/${id}`, { version, ...fields }, email);

describe("capture from anywhere", () => {
    it("returns the same task when a request is repeated, and never makes a copy", async () => {
        const body = { title: "Renew registration", clientId: "qa-test-0000000001", dueDate: addDays(today(), 3) };
        const first = await call<{ task: TaskSummary; replayed: boolean }>("POST", "/tasks", body);
        expect(first.status).toBe(201);
        const again = await call<{ task: TaskSummary; replayed: boolean }>("POST", "/tasks", body);
        expect(again.status).toBe(200);
        expect(again.json).toEqual({ task: expect.objectContaining({ id: first.json.task.id }), replayed: true });
        // Even at the same moment.
        const both = await Promise.all(
            [1, 2].map(() => call<{ task: TaskSummary }>("POST", "/tasks", { title: "Book dentist", clientId: "qa-test-0000000002" })),
        );
        expect(new Set(both.map((r) => r.json.task.id)).size).toBe(1);
        expect(await count("SELECT COUNT(*) AS n FROM task_items WHERE title IN ('Renew registration', 'Book dentist')")).toBe(2);
        // Another person's identical client id is theirs alone.
        const theirs = await call<{ task: TaskSummary }>("POST", "/tasks", body, B);
        expect(theirs.status).toBe(201);
        expect(theirs.json.task.id).not.toBe(first.json.task.id);
        expect((await call("POST", "/tasks", { title: "x", clientId: "bad id!" })).status).toBe(422);
    });

    it("links a Knowledge page only if the person can read it, in the same write", async () => {
        const note = await createKnowledge((await knowledgeSpace(A)).id, { title: "Car service notes" });
        const made = await call<{ task: TaskSummary }>("POST", "/tasks", { title: "Book the service", knowledge: [note.object.id] });
        expect(made.status).toBe(201);
        expect((await detail(made.json.task.id)).knowledge).toEqual([expect.objectContaining({ available: true, title: "Car service notes" })]);
        // B can't read A's note: nothing is created, and the answer doesn't say whether it exists.
        const refused = await call("POST", "/tasks", { title: "Sneaky", knowledge: [note.object.id] }, B);
        expect(refused.status).toBe(404);
        expect((await call("POST", "/tasks", { title: "Sneaky", knowledge: ["kob_00000000000000"] }, B)).status).toBe(404);
        expect(await count("SELECT COUNT(*) AS n FROM task_items WHERE title = 'Sneaky'")).toBe(0);
    });

    it("gives Quick Add elsewhere in the portal only the caller's own projects and labels", async () => {
        await createProject({ name: "A's finances" });
        await createProject({ name: "B's garden" }, B);
        const shell = (await call<{ shell: TasksShell }>("GET", "/shell")).json.shell;
        expect(shell.projects.map((p) => p.name).sort()).toEqual(["A's finances", "Inbox"]);
        await apiCall("POST", "/api/portal/users", { email: "wedding-editor@example.com", role: "editor" });
        expect((await call("GET", "/shell", undefined, "wedding-editor@example.com")).status).toBe(403);
        expect((await call("POST", "/tasks", { title: "No access" }, "wedding-editor@example.com")).status).toBe(403);
    });

    it("adds the person's default reminder to new dated tasks", async () => {
        await call("PATCH", "/preferences", { defaultReminderMinutes: 30 });
        const dated = await createTask({ title: "Dated", dueDate: addDays(today(), 2), dueTime: "10:00" });
        const undated = await createTask({ title: "Undated" });
        expect((await detail(dated.id)).reminders).toEqual([expect.objectContaining({ kind: "relative", offsetMinutes: 30, deliveryStatus: "pending" })]);
        expect((await detail(undated.id)).reminders).toEqual([]);
    });
});

describe("repeating tasks: occurrences and the series", () => {
    it("moves only this occurrence by default, or the whole series when asked", async () => {
        const monday = addDays(weekStart(today()), 7);
        const task = await createTask({ title: "Team sync", dueDate: monday, recurrence: { freq: "weekly" } });
        // Just this one: Wednesday, and the series stays on Mondays.
        const moved = (await update(task.id, task.version, { dueDate: addDays(monday, 2) })).json.task;
        expect(moved.recurrence?.weekdays).toEqual([1]);
        const done = (await call<{ nextDate: string }>("POST", `/tasks/${task.id}/complete`, { occurrence: moved.dueDate })).json;
        expect(done.nextDate).toBe(addDays(monday, 7));
        // The series: from next Monday it's Tuesdays.
        const current = (await detail(task.id)).task;
        const shifted = (await update(task.id, current.version, { dueDate: addDays(monday, 8), scope: "series" })).json.task;
        expect(shifted.recurrence?.weekdays).toEqual([2]);
        expect(shifted.recurrence?.anchor).toBe(addDays(monday, 8));
        const history = (await detail(task.id)).activity.map((a) => a.changes);
        expect(history).toContainEqual(expect.objectContaining({ series: true }));
    });

    it("skips or moves a later occurrence, and completion follows the exceptions without duplicates", async () => {
        const start = addDays(weekStart(today()), 7);
        const task = await createTask({ title: "Water plants", dueDate: start, recurrence: { freq: "weekly" } });
        const skip = await call("POST", `/tasks/${task.id}/occurrences`, { action: "skip", date: addDays(start, 7) });
        expect(skip.status).toBe(200);
        const move = await call("POST", `/tasks/${task.id}/occurrences`, { action: "move", date: addDays(start, 14), to: addDays(start, 16) });
        expect(move.status).toBe(200);
        // Upcoming shows the moved one where it now falls, with the date it stands for.
        const months = await Promise.all([start, addDays(start, 16)].map((d) => call<{ tasks: TaskSummary[] }>("GET", `/lists/upcoming?mode=month&from=${d}`)));
        const upcoming = [
            ...new Map(
                months
                    .flatMap((m) => m.json.tasks)
                    .filter((t) => t.id === task.id)
                    .map((t) => [t.dueDate, t]),
            ).values(),
        ];
        expect(upcoming.map((t) => t.dueDate)).not.toContain(addDays(start, 7));
        expect(upcoming.find((t) => t.dueDate === addDays(start, 16))).toEqual(expect.objectContaining({ projected: true, seriesDate: addDays(start, 14) }));
        // Completing twice (a double tap) moves once, past the skipped week, onto the moved day.
        const [one, two] = await Promise.all(
            [1, 2].map(() => call<{ nextDate: string | null; alreadyDone: boolean }>("POST", `/tasks/${task.id}/complete`, { occurrence: start })),
        );
        expect([one.json.alreadyDone, two.json.alreadyDone].sort()).toEqual([false, true]);
        expect((await detail(task.id)).task.dueDate).toBe(addDays(start, 16));
        const next = await call<{ nextDate: string }>("POST", `/tasks/${task.id}/complete`, { occurrence: addDays(start, 16) });
        expect(next.json.nextDate).toBe(addDays(start, 21));
        expect(await count("SELECT COUNT(*) AS n FROM task_items WHERE title = 'Water plants'")).toBe(1);
        // Only later occurrences on a schedule; nothing for one-off tasks; editors only.
        expect((await call("POST", `/tasks/${task.id}/occurrences`, { action: "skip", date: start })).status).toBe(422);
        const once = await createTask({ title: "Once", dueDate: start });
        expect((await call("POST", `/tasks/${once.id}/occurrences`, { action: "skip", date: addDays(start, 7) })).status).toBe(422);
        expect((await call("POST", `/tasks/${task.id}/occurrences`, { action: "skip", date: addDays(start, 28) }, B)).status).toBe(404);
        // Changing the rule clears the exceptions it was made for.
        const current = (await detail(task.id)).task;
        await update(task.id, current.version, { recurrence: { freq: "daily" } });
        expect(await count("SELECT COUNT(*) AS n FROM task_recurrence_exceptions WHERE task_id = ?", task.id)).toBe(0);
    });

    it("ends a limited series after its last occurrence", async () => {
        const start = addDays(today(), 1);
        const task = await createTask({ title: "Physio exercises", dueDate: start, recurrence: { freq: "daily", count: 2 } });
        expect((await call<{ nextDate: string }>("POST", `/tasks/${task.id}/complete`, { occurrence: start })).json.nextDate).toBe(addDays(start, 1));
        const last = await call<{ nextDate: string | null; task: TaskSummary }>("POST", `/tasks/${task.id}/complete`, { occurrence: addDays(start, 1) });
        expect(last.json.nextDate).toBeNull();
        expect(last.json.task.status).toBe("completed");
    });

    it("refuses to change a shared repeating task for a viewer, and a stale version for anyone", async () => {
        const project = await sharedProject("viewer");
        const task = await createTask({ title: "Shared chore", projectId: project.id, dueDate: addDays(today(), 1), recurrence: { freq: "weekly" } });
        expect((await update(task.id, task.version, { dueDate: addDays(today(), 2), scope: "series" }, B)).status).toBe(403);
        await update(task.id, task.version, { priority: 2 });
        expect((await update(task.id, task.version, { dueDate: addDays(today(), 2), scope: "series" })).status).toBe(409);
    });
});

describe("planning", () => {
    it("moves several tasks by a number of days, leaving deadlines and undated tasks alone", async () => {
        const d = addDays(today(), 2);
        const a = await createTask({ title: "One", dueDate: d, deadline: addDays(d, 10) });
        const b = await createTask({ title: "Two" });
        const shared = await createTask({ title: "Theirs" }, B);
        expect((await call("POST", "/tasks/bulk", { action: "shift", ids: [a.id, b.id], days: 3 })).status).toBe(200);
        expect((await detail(a.id)).task).toEqual(expect.objectContaining({ dueDate: addDays(d, 3), deadline: addDays(d, 10) }));
        expect((await detail(b.id)).task.dueDate).toBeNull();
        // Someone else's task in the selection: nothing changes.
        expect((await call("POST", "/tasks/bulk", { action: "shift", ids: [a.id, shared.id], days: 1 })).status).toBe(404);
        expect((await detail(a.id)).task.dueDate).toBe(addDays(d, 3));
        expect((await call("POST", "/tasks/bulk", { action: "shift", ids: [a.id], days: 0 })).status).toBe(422);
    });

    it("shows a week from Monday and a whole month, with deadlines' own dates kept separate", async () => {
        const monday = weekStart(today());
        await createTask({ title: "Due this Sunday", dueDate: addDays(monday, 6) });
        await createTask({ title: "Due next week", dueDate: addDays(monday, 8) });
        const week = (await call<{ from: string; days: number; tasks: TaskSummary[] }>("GET", "/lists/upcoming?mode=week")).json;
        expect(week.from).toBe(monday);
        expect(week.days).toBe(7);
        expect(week.tasks.map((t) => t.title)).toEqual(["Due this Sunday"]);
        const month = (await call<{ from: string; days: number }>("GET", `/lists/upcoming?mode=month&from=${addDays(today(), 40)}`)).json;
        expect(month.from.endsWith("-01")).toBe(true);
        // Never before the current week or month.
        expect((await call<{ from: string }>("GET", "/lists/upcoming?mode=week&from=2020-01-01")).json.from).toBe(monday);
    });

    it("counts what was completed today, by the caller only", async () => {
        const mine = await createTask({ title: "Mine", dueDate: today() });
        await createTask({ title: "Still to do", dueDate: today() });
        await call("POST", `/tasks/${mine.id}/complete`, { occurrence: today() });
        const project = await sharedProject("editor");
        const theirs = await createTask({ title: "Shared", projectId: project.id, dueDate: today() });
        await call("POST", `/tasks/${theirs.id}/complete`, { occurrence: today() }, B);
        const result = (await call<{ tasks: TaskSummary[]; progress: { done: number } }>("GET", "/lists/today")).json;
        expect(result.progress).toEqual({ done: 1 });
        expect(result.tasks.map((t) => t.title)).toEqual(["Still to do"]);
    });

    it("handles thousands of tasks within the lists' bounds", async () => {
        const inbox = (await call<{ projects: { id: string; isInbox: boolean }[] }>("GET", "/projects")).json.projects.find((p) => p.isInbox)!;
        const now = new Date().toISOString();
        const statements = Array.from({ length: 3000 }, (_, i) =>
            db()
                .prepare(
                    "INSERT INTO task_items (id, project_id, depth, title, priority, due_date, position, created_by, updated_by, created_at, updated_at) VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)",
                )
                .bind(`tsk_bulk${String(i).padStart(10, "0")}`, inbox.id, `Bulk ${i}`, (i % 4) + 1, addDays(today(), (i % 60) - 10), i, A, A, now, now),
        );
        for (let i = 0; i < statements.length; i += 500) await db().batch(statements.slice(i, i + 500));
        const started = Date.now();
        expect((await list("today")).length).toBeLessThanOrEqual(500);
        const mine = (await call<{ tasks: TaskSummary[]; hasMore: boolean }>("GET", "/filter?assignee=mine&limit=100")).json;
        expect(mine.tasks).toHaveLength(100);
        expect(mine.hasMore).toBe(true);
        const nextPage = (await call<{ tasks: TaskSummary[] }>("GET", "/filter?assignee=mine&limit=100&offset=100")).json.tasks;
        expect(new Set([...mine.tasks, ...nextPage].map((t) => t.id)).size).toBe(200);
        const month = (await call<{ tasks: TaskSummary[] }>("GET", "/lists/upcoming?mode=month")).json.tasks;
        expect(month.length).toBeLessThanOrEqual(1000);
        expect(Date.now() - started).toBeLessThan(15_000);
    });
});

describe("My Tasks and preferences", () => {
    it("filters by assignee, project and section, and sorts in project order", async () => {
        const project = await sharedProject("editor");
        const section = (await call<{ section: { id: string } }>("POST", `/projects/${project.id}/sections`, { name: "Kitchen" })).json.section;
        await createTask({ title: "For A", projectId: project.id, assignee: A });
        await createTask({ title: "For B", projectId: project.id, assignee: B });
        const inSection = await createTask({ title: "Unassigned in Kitchen", projectId: project.id, sectionId: section.id });
        await createTask({ title: "Personal" });
        const titles = async (query: string, email = A) =>
            (await call<{ tasks: TaskSummary[] }>("GET", `/filter?${query}`, undefined, email)).json.tasks.map((t) => t.title).sort();
        expect(await titles("assignee=mine")).toEqual(["For A", "Personal", "Unassigned in Kitchen"]);
        expect(await titles("assignee=others")).toEqual(["For B"]);
        expect(await titles(`projects=${project.id}&sections=${section.id}`)).toEqual(["Unassigned in Kitchen"]);
        expect(await titles("assignee=mine", B)).toEqual(["For B", "Unassigned in Kitchen"]);
        expect((await call<{ tasks: TaskSummary[] }>("GET", "/filter?sort=manual")).json.tasks.length).toBe(4);
        expect(inSection.sectionId).toBe(section.id);
    });

    it("are each person's own, validated, and choose the first page", async () => {
        expect((await call("PUT", "/preferences/views/upcoming", { mode: "month" })).status).toBe(200);
        expect((await call("PUT", "/preferences/views/mine", { sort: "priority", priorities: [1, 2] })).status).toBe(200);
        expect((await call("PUT", "/preferences/views/mine", { sort: "sideways" })).status).toBe(422);
        expect((await call("PUT", "/preferences/views/secret", {})).status).toBe(404);
        expect((await call<{ views: object }>("GET", "/preferences/views")).json.views).toEqual({
            upcoming: { mode: "month" },
            mine: { sort: "priority", priorities: [1, 2] },
        });
        expect((await call<{ views: object }>("GET", "/preferences/views", undefined, B)).json.views).toEqual({});
        const prefs = (
            await call<{ preferences: TaskPreferences }>("PATCH", "/preferences", { landingPage: "upcoming", quietStart: "22:00", quietEnd: "07:00" })
        ).json.preferences;
        expect(prefs).toEqual(
            expect.objectContaining({ landingPage: "upcoming", quietStart: "22:00", quietEnd: "07:00", reminderEmail: false, remindersEnabled: true }),
        );
        expect((await call("PATCH", "/preferences", { quietStart: "22:00", quietEnd: null })).status).toBe(422);
        const page = await apiCall("GET", "/portal/tasks");
        expect(page.status).toBe(200);
        expect(page.text).toContain('"route":"tasks-upcoming"');
        expect(page.text).toContain('"mode":"month"');
    });
});

describe("templates", () => {
    const template = (body: Record<string, unknown>, email = A) => call<{ template: TaskTemplate }>("POST", "/templates", body, email);

    it("create independent tasks with their whole checklist", async () => {
        const made = await template({
            name: "Holiday packing",
            title: "Pack for the coast",
            priority: 2,
            labels: ["travel"],
            dueOffsetDays: 3,
            dueTime: "08:00",
            subtasks: [{ title: "Clothes", children: [{ title: "Swimmers" }, { title: "Hats" }] }, { title: "Chargers" }],
        });
        expect(made.status).toBe(201);
        const used = await call<{ task: TaskSummary }>("POST", `/templates/${made.json.template.id}/use`, {});
        expect(used.status).toBe(201);
        const task = await detail(used.json.task.id);
        expect(task.task).toEqual(
            expect.objectContaining({ title: "Pack for the coast", priority: 2, dueDate: addDays(today(), 3), dueTime: "08:00", labels: ["travel"] }),
        );
        expect(task.subtasks.map((s) => s.title)).toEqual(["Clothes", "Chargers"]);
        const clothes = await detail(task.subtasks[0].id);
        expect(clothes.subtasks.map((s) => s.title)).toEqual(["Swimmers", "Hats"]);
        // Independent: editing the template doesn't touch the task, and using it twice makes two.
        // An edit replaces the whole template.
        const { id: _id, archived: _a, canEdit: _c, owner: _o, version, updatedAt: _u, ...fields } = made.json.template;
        await call("PATCH", `/templates/${made.json.template.id}`, { version, template: { ...fields, title: "Renamed" } });
        expect((await detail(used.json.task.id)).task.title).toBe("Pack for the coast");
        await call("POST", `/templates/${made.json.template.id}/use`, {});
        expect(await count("SELECT COUNT(*) AS n FROM task_items WHERE title = 'Swimmers'")).toBe(2);
        // Duplicate, archive, delete.
        const copy = (await call<{ template: TaskTemplate }>("POST", `/templates/${made.json.template.id}/duplicate`, {})).json.template;
        expect(copy.name).toBe("Holiday packing (copy)");
        await call("PATCH", `/templates/${copy.id}`, { version: copy.version, archived: true });
        expect((await call<{ templates: TaskTemplate[] }>("GET", "/templates")).json.templates.map((t) => t.id)).toEqual([made.json.template.id]);
        expect((await call<{ templates: TaskTemplate[] }>("GET", "/templates?archived=1")).json.templates.map((t) => t.id)).toEqual([copy.id]);
        expect((await call("DELETE", `/templates/${copy.id}`)).status).toBe(200);
    });

    it("stay private unless shared through a shared project, and use only projects the user can edit", async () => {
        const mine = (await template({ name: "Monthly finances", title: "Review accounts" })).json.template;
        for (const [method, path] of [
            ["GET", `/templates/${mine.id}`],
            ["POST", `/templates/${mine.id}/use`],
            ["POST", `/templates/${mine.id}/duplicate`],
            ["DELETE", `/templates/${mine.id}`],
        ] as const)
            expect((await call(method, path, method === "GET" || method === "DELETE" ? undefined : {}, B)).status, path).toBe(404);
        expect((await call<{ templates: TaskTemplate[] }>("GET", "/templates", undefined, B)).json.templates).toEqual([]);

        const project = await sharedProject("viewer");
        const shared = (await template({ name: "Bins", title: "Bins out", sharedProjectId: project.id })).json.template;
        const seen = (await call<{ templates: TaskTemplate[] }>("GET", "/templates", undefined, B)).json.templates;
        expect(seen).toEqual([expect.objectContaining({ id: shared.id, canEdit: false })]);
        expect((await call("PATCH", `/templates/${shared.id}`, { version: shared.version, archived: true }, B)).status).toBe(403);
        // A viewer can't put tasks in the shared project; it lands in their Inbox only if they choose nothing.
        expect((await call("POST", `/templates/${shared.id}/use`, { projectId: project.id }, B)).status).toBe(403);
        const own = await createProject({ name: "A only" });
        expect((await call("POST", `/templates/${shared.id}/use`, { projectId: own.id }, B)).status).toBe(404);
        // Removing B from the project removes the template too.
        await call("DELETE", `/projects/${project.id}/members/${B}`);
        expect((await call(`GET`, `/templates/${shared.id}`, undefined, B)).status).toBe(404);
        // Only shared projects share templates.
        expect((await template({ name: "x", title: "x", sharedProjectId: own.id })).status).toBe(422);
    });

    it("can be made from an existing task", async () => {
        const parent = await createTask({ title: "Service the car", priority: 3, labels: ["car"] });
        await createTask({ title: "Check tyres", parentId: parent.id });
        const made = await call<{ template: TaskTemplate }>("POST", `/tasks/${parent.id}/template`, { name: "Car service" });
        expect(made.status).toBe(201);
        expect(made.json.template).toEqual(
            expect.objectContaining({ title: "Service the car", priority: 3, labels: ["car"], subtasks: [{ title: "Check tyres" }] }),
        );
        expect((await call("POST", `/tasks/${parent.id}/template`, { name: "Stolen" }, B)).status).toBe(404);
    });
});

describe("Todoist import", () => {
    const files = [
        { name: "Household [1000000001].csv", text: householdCsv },
        { name: "Errands.csv", text: errandsCsv },
    ];
    type Preview = {
        fingerprint: string;
        importedBefore: string | null;
        projects: {
            key: string;
            name: string;
            destination: { kind: string; projectId?: string };
            sameName: { id: string } | null;
            counts: Record<string, number>;
            unsupported: Record<string, number>;
            warnings: string[];
            sample: { title: string; status: string; depth: number; due: string | null }[];
        }[];
    };
    type Run = { batchId: string; done: boolean; summary: Record<string, number> };
    const preview = (body: Record<string, unknown>, email = A) => call<Preview>("POST", "/import/todoist/preview", body, email);
    const run = async (body: Record<string, unknown>, email = A) => {
        let result = await call<Run>("POST", "/import/todoist/run", body, email);
        while (result.status === 200 && !result.json.done)
            result = await call<Run>("POST", "/import/todoist/run", { ...body, batchId: result.json.batchId }, email);
        return result;
    };

    it("previews without writing anything, then imports projects, sections, subtasks, labels, comments and repeats", async () => {
        const before = await count("SELECT COUNT(*) AS n FROM task_items");
        const p = (await preview({ files })).json;
        expect(await count("SELECT COUNT(*) AS n FROM task_items")).toBe(before);
        const household = p.projects.find((x) => x.name === "Household")!;
        expect(household.destination).toEqual({ kind: "new" });
        expect(household.counts.new).toBe(6);
        expect(household.unsupported).toEqual(expect.objectContaining({ AUTHOR: 6, DURATION: 1, TIMEZONE: 6 }));
        expect(household.warnings.some((w) => w.includes("sometime soon"))).toBe(true);

        const result = await run({ files });
        expect(result.status).toBe(200);
        expect(result.json.summary).toEqual(expect.objectContaining({ projectsCreated: 2, sectionsCreated: 1, tasksCreated: 8, comments: 1 }));
        const project = await db().prepare("SELECT id, kind FROM task_projects WHERE name = 'Household'").first<{ id: string; kind: string }>();
        // Never shared by an import.
        expect(project!.kind).toBe("personal");
        const rows = (
            await db()
                .prepare("SELECT title, depth, priority, due_date, deadline, recurrence_json, section_id FROM task_items WHERE project_id = ? ORDER BY title")
                .bind(project!.id)
                .all<{
                    title: string;
                    depth: number;
                    priority: number;
                    due_date: string | null;
                    deadline: string | null;
                    recurrence_json: string | null;
                    section_id: string | null;
                }>()
        ).results;
        expect(rows.find((r) => r.title === "Pay water bill")).toEqual(
            expect.objectContaining({ priority: 1, due_date: "2027-03-03", deadline: "2027-03-10" }),
        );
        expect(rows.find((r) => r.title === "Check the meter reading")!.depth).toBe(1);
        expect(JSON.parse(rows.find((r) => r.title === "Take bins out")!.recurrence_json!)).toEqual(expect.objectContaining({ freq: "weekly", weekdays: [2] }));
        expect(rows.find((r) => r.title === "Buy secateurs")!.section_id).toBe(rows.find((r) => r.title === "Prune the roses")!.section_id);
        expect(rows.find((r) => r.title === "Book the gutter clean")!.due_date).toBeNull();
        const water = await db().prepare("SELECT id FROM task_items WHERE title = 'Pay water bill'").first<{ id: string }>();
        expect((await detail(water!.id)).task.labels).toEqual(["bills"]);
        expect((await detail(water!.id)).comments.map((c) => c.body)).toEqual(["Paid late last time - set a reminder"]);
    });

    it("finds everything again on a second import of the same file", async () => {
        await run({ files });
        const counted = await count("SELECT COUNT(*) AS n FROM task_items");
        const again = (await preview({ files })).json;
        expect(again.importedBefore).not.toBeNull();
        expect(again.projects.every((p) => p.destination.kind === "existing")).toBe(true);
        expect(again.projects.flatMap((p) => p.sample.map((s) => s.status)).every((s) => s === "unchanged")).toBe(true);
        const second = await run({ files });
        expect(second.json.summary).toEqual(expect.objectContaining({ projectsCreated: 0, tasksCreated: 0, unchanged: 8 }));
        expect(await count("SELECT COUNT(*) AS n FROM task_items")).toBe(counted);
        expect(await count("SELECT COUNT(*) AS n FROM task_projects WHERE name = 'Household'")).toBe(1);
    });

    it("updates only what wasn't edited here since, and never brings back what was deleted", async () => {
        await run({ files });
        const changed = files.map((f) => ({
            ...f,
            text: f.text.replace("Account details are in the folder", "Account number changed").replace("Post the parcel,,2", "Post the parcel,,1"),
        }));
        // Edited in Daly Tasks since the import: a conflict, kept as it is here.
        const parcel = (await db().prepare("SELECT id, version FROM task_items WHERE title = 'Post the parcel'").first<{ id: string; version: number }>())!;
        await update(parcel.id, parcel.version, { description: "My own note" });
        // Deleted here since: stays deleted.
        const bins = (await db().prepare("SELECT id FROM task_items WHERE title = 'Take bins out'").first<{ id: string }>())!;
        await call("DELETE", `/tasks/${bins.id}`);
        const p = (await preview({ files: changed, options: { changed: "update" } })).json;
        const statuses = Object.fromEntries(p.projects.flatMap((x) => x.sample.map((s) => [s.title, s.status])));
        expect(statuses).toEqual(expect.objectContaining({ "Pay water bill": "update", "Post the parcel": "conflict", "Take bins out": "deleted" }));
        // Keeping (the default) changes nothing.
        await run({ files: changed });
        expect((await db().prepare("SELECT description FROM task_items WHERE title = 'Pay water bill'").first<{ description: string }>())!.description).toBe(
            "Account details are in the folder",
        );
        const updated = await run({ files: changed, options: { changed: "update" } });
        expect(updated.json.summary.tasksUpdated).toBe(1);
        expect((await db().prepare("SELECT description FROM task_items WHERE title = 'Pay water bill'").first<{ description: string }>())!.description).toBe(
            "Account number changed",
        );
        expect(await db().prepare("SELECT description, priority FROM task_items WHERE id = ?").bind(parcel.id).first()).toEqual({
            description: "My own note",
            priority: 2,
        });
        expect(await count("SELECT COUNT(*) AS n FROM task_items WHERE title = 'Take bins out'")).toBe(0);
    });

    it("links possible duplicates in a mapped project instead of copying them", async () => {
        const errands = await createProject({ name: "Errands" });
        await createTask({ title: "Post the parcel", projectId: errands.id });
        const p = (await preview({ files: [files[1]] })).json;
        expect(p.projects[0].sameName).toEqual(expect.objectContaining({ id: errands.id }));
        const key = p.projects[0].key;
        const mapped = (await preview({ files: [files[1]], options: { destinations: { [key]: errands.id } } })).json;
        expect(mapped.projects[0].counts).toEqual(expect.objectContaining({ duplicate: 1, new: 1 }));
        await run({ files: [files[1]], options: { destinations: { [key]: errands.id } } });
        expect(await count("SELECT COUNT(*) AS n FROM task_items WHERE title = 'Post the parcel'")).toBe(1);
        expect(await count("SELECT COUNT(*) AS n FROM task_items WHERE project_id = ?", errands.id)).toBe(2);
        // Or import anyway, when asked.
        const fresh = await createProject({ name: "Elsewhere" });
        await createTask({ title: "Pick up dry cleaning", projectId: fresh.id });
        await run({ files: [{ name: "Elsewhere.csv", text: errandsCsv }], options: { duplicates: "import", destinations: {} } });
    });

    it("refuses malformed, oversized and wrong files, and other people's projects", async () => {
        expect((await preview({ files: [{ name: "notes.txt", text: "hello" }] })).status).toBe(422);
        expect((await preview({ files: [{ name: "contacts.csv", text: "name,email\nPat,pat@example.com" }] })).status).toBe(422);
        expect((await preview({ files: [{ name: "broken.csv", text: 'TYPE,CONTENT\ntask,"never closed' }] })).status).toBe(422);
        expect((await preview({ files: [] })).status).toBe(422);
        const big = await call("POST", "/import/todoist/preview", { files: [{ name: "big.csv", text: "x".repeat(8_100_000) }] });
        expect([413, 422]).toContain(big.status);
        const theirs = await createProject({ name: "B's project" }, B);
        const key = (await preview({ files: [files[1]] })).json.projects[0].key;
        expect((await preview({ files: [files[1]], options: { destinations: { [key]: theirs.id } } })).status).toBe(404);
        expect((await run({ files: [files[1]], options: { destinations: { [key]: theirs.id } } })).status).toBe(404);
        expect(await count("SELECT COUNT(*) AS n FROM task_items WHERE project_id = ?", theirs.id)).toBe(0);
        // B's import never sees or reuses A's.
        await run({ files });
        const forB = (await preview({ files }, B)).json;
        expect(forB.importedBefore).toBeNull();
        expect(forB.projects.every((p) => p.destination.kind === "new")).toBe(true);
        const batch = (await run({ files })).json.batchId;
        expect((await call("POST", "/import/todoist/run", { files, batchId: batch }, B)).status).toBe(404);
    });

    it("recovers from an interrupted import without duplicating anything", async () => {
        const big = `TYPE,CONTENT,PRIORITY,INDENT\n${Array.from({ length: 600 }, (_, i) => `task,Item ${i},4,1`).join("\n")}`;
        const body = { files: [{ name: "Big list.csv", text: big }] };
        const first = await call<Run>("POST", "/import/todoist/run", body);
        expect(first.json.done).toBe(false);
        expect(await count("SELECT COUNT(*) AS n FROM task_items WHERE title LIKE 'Item %'")).toBe(250);
        // The browser gave up; later the same file is imported again from scratch.
        const again = await run(body);
        expect(again.json.done).toBe(true);
        expect(await count("SELECT COUNT(*) AS n FROM task_items WHERE title LIKE 'Item %'")).toBe(600);
        expect(await count("SELECT COUNT(DISTINCT title) AS n FROM task_items WHERE title LIKE 'Item %'")).toBe(600);
        // A different file can't continue someone's batch.
        expect((await call("POST", "/import/todoist/run", { files, batchId: first.json.batchId })).status).toBe(422);
    });
});

describe("background reminders", () => {
    const sent: OutgoingEmail[] = [];
    const mock = (behaviour: "ok" | "retry" | "fatal" = "ok"): EmailProvider => ({
        channel: "email",
        name: "mock",
        supportsAttachments: false,
        async send(message) {
            if (behaviour === "retry") throw new ProviderError("Mock", "temporarily unavailable", true);
            if (behaviour === "fatal") throw new ProviderError("Mock", "rejected", false);
            sent.push(message);
            return { providerId: `mock_${sent.length}` };
        },
    });
    const enable = async () => {
        await apiCall("PUT", "/api/portal/flags/tasks.reminders.email", { enabled: true });
        await call("PATCH", "/preferences", { reminderEmail: true });
    };
    /** A reminder due a minute ago on a new task, for A. */
    const dueReminder = async (fields: Record<string, unknown> = {}, email = A) => {
        const task = await createTask({ title: "Renew passport", dueDate: today(), priority: 1, ...fields }, email);
        await call("POST", `/tasks/${task.id}/reminders`, { kind: "absolute", date: today(), time: "09:00" }, email);
        await db()
            .prepare("UPDATE task_reminders SET remind_at = ?, next_attempt_at = ? WHERE task_id = ?")
            .bind(new Date(Date.now() - 60_000).toISOString(), new Date(Date.now() - 60_000).toISOString(), task.id)
            .run();
        return task;
    };
    const status = async (taskId: string) =>
        db()
            .prepare("SELECT delivery_status, attempts, last_error FROM task_reminders WHERE task_id = ?")
            .bind(taskId)
            .first<{ delivery_status: string; attempts: number; last_error: string | null }>();
    beforeEach(() => void (sent.length = 0));

    it("does nothing while the switch is off or no provider is configured", async () => {
        const task = await dueReminder();
        await call("PATCH", "/preferences", { reminderEmail: true });
        expect(await processTaskReminders(await portalEnv(), { provider: mock() })).toEqual(expect.objectContaining({ skipped: "delivery_off" }));
        await apiCall("PUT", "/api/portal/flags/tasks.reminders.email", { enabled: true });
        expect(await processTaskReminders(await portalEnv(), { provider: null })).toEqual(expect.objectContaining({ skipped: "delivery_off" }));
        // The real provider factory in tests: EMAIL_DELIVERY is off, so nothing is ever sent.
        expect(await processTaskReminders(await portalEnv())).toEqual(expect.objectContaining({ skipped: "delivery_off" }));
        expect((await status(task.id))!.delivery_status).toBe("pending");
    });

    it("emails a due reminder once, even with two runs at the same time", async () => {
        await enable();
        const task = await dueReminder();
        const env = await portalEnv();
        const [one, two] = await Promise.all([processTaskReminders(env, { provider: mock() }), processTaskReminders(env, { provider: mock() })]);
        expect(one.sent + two.sent).toBe(1);
        expect(sent).toHaveLength(1);
        expect(sent[0]).toEqual(expect.objectContaining({ to: A, subject: "Reminder: Renew passport" }));
        expect(sent[0].text).toContain(`/portal/tasks/t/${task.id}`);
        expect((await status(task.id))!.delivery_status).toBe("sent");
        expect((await processTaskReminders(env, { provider: mock() })).sent).toBe(0);
        // In the app, the reminder is still shown until dismissed.
        expect((await detail(task.id)).reminders[0].deliveryStatus).toBe("sent");
    });

    it("retries with backoff, then gives up; a rejected message isn't retried", async () => {
        await enable();
        const task = await dueReminder();
        const env = await portalEnv();
        let now = Date.now();
        for (let i = 0; i < 4; i++) {
            expect((await processTaskReminders(env, { provider: mock("retry"), now: new Date(now) })).retried).toBe(1);
            // Not again until the backoff has passed.
            expect((await processTaskReminders(env, { provider: mock("retry"), now: new Date(now + 60_000) })).retried).toBe(0);
            now += [5, 15, 60, 240][i] * 60_000 + 1000;
        }
        // The fifth attempt fails for good.
        expect((await processTaskReminders(env, { provider: mock("retry"), now: new Date(now) })).failed).toBe(1);
        const rejected = await dueReminder({ title: "Rejected" });
        expect((await processTaskReminders(env, { provider: mock("fatal") })).failed).toBe(1);
        expect((await status(rejected.id))!).toEqual(expect.objectContaining({ delivery_status: "failed", attempts: 1, last_error: "Mock: rejected" }));
        expect((await status(task.id))!.attempts).toBeGreaterThanOrEqual(4);
    });

    it("checks access and wishes at send time: removed members, completed tasks and turned-off emails get nothing", async () => {
        await enable();
        await call("PATCH", "/preferences", { reminderEmail: true }, B);
        const project = await sharedProject("editor");
        const shared = await dueReminder({ projectId: project.id, title: "Shared secret" }, B);
        await call("DELETE", `/projects/${project.id}/members/${B}`);
        // B's reminder went with their membership (Milestone 1 rule), so there's nothing to send.
        const done = await dueReminder({ title: "Already done" });
        await call("POST", `/tasks/${done.id}/complete`, { occurrence: today() });
        const env = await portalEnv();
        await processTaskReminders(env, { provider: mock() });
        expect(sent.map((m) => m.subject)).toEqual([]);
        expect((await status(done.id))!.delivery_status).toBe("cancelled");
        expect(await status(shared.id)).toBeNull();
        // Turned off: pending ones are cancelled; turned on again, future ones come back.
        const later = await dueReminder({ title: "Later" });
        await db()
            .prepare("UPDATE task_reminders SET remind_at = ?, next_attempt_at = ? WHERE task_id = ?")
            .bind(addDays(today(), 3) + "T00:00:00.000Z", addDays(today(), 3) + "T00:00:00.000Z", later.id)
            .run();
        await call("PATCH", "/preferences", { reminderEmail: false });
        expect((await status(later.id))!.delivery_status).toBe("cancelled");
        await call("PATCH", "/preferences", { reminderEmail: true });
        expect((await status(later.id))!.delivery_status).toBe("pending");
        // Dismissed in the app: no email.
        const dismissed = await dueReminder({ title: "Dismissed" });
        const reminderId = (await detail(dismissed.id)).reminders[0].id;
        await call("POST", `/reminders/${reminderId}/dismiss`, {});
        await processTaskReminders(env, { provider: mock() });
        expect(sent.map((m) => m.subject)).toEqual([]);
    });

    it("waits out quiet hours and expires reminders that are hours late", async () => {
        await enable();
        await call("PATCH", "/preferences", { quietStart: "00:00", quietEnd: "23:59" });
        const task = await dueReminder();
        const env = await portalEnv();
        expect((await processTaskReminders(env, { provider: mock() })).deferred).toBe(1);
        expect((await status(task.id))!.delivery_status).toBe("pending");
        await call("PATCH", "/preferences", { quietStart: null, quietEnd: null });
        await db()
            .prepare("UPDATE task_reminders SET remind_at = ?, next_attempt_at = ? WHERE task_id = ?")
            .bind(new Date(Date.now() - 7 * 3_600_000).toISOString(), new Date(Date.now() - 60_000).toISOString(), task.id)
            .run();
        expect((await processTaskReminders(env, { provider: mock() })).expired).toBe(1);
        expect(sent).toHaveLength(0);
    });

    it("never puts a linked Knowledge title, description or comments in the email", async () => {
        await enable();
        const note = await createKnowledge((await knowledgeSpace(A)).id, { title: "Private medical notes" });
        const task = await dueReminder({ description: "Very private description", knowledge: [note.object.id] });
        await call("POST", `/tasks/${task.id}/comments`, { body: "Private comment" });
        await processTaskReminders(await portalEnv(), { provider: mock() });
        expect(sent).toHaveLength(1);
        const all = `${sent[0].subject}\n${sent[0].text}\n${sent[0].html}`;
        for (const secret of ["Private medical notes", "Very private description", "Private comment", note.object.id]) expect(all).not.toContain(secret);
    });

    it("moves a relative reminder's delivery when its task moves", async () => {
        const task = await createTask({ title: "Dentist", dueDate: addDays(today(), 2), dueTime: "10:00" });
        await call("POST", `/tasks/${task.id}/reminders`, { kind: "relative", offsetMinutes: 60 });
        await db().prepare("UPDATE task_reminders SET delivery_status = 'sent' WHERE task_id = ?").bind(task.id).run();
        const current = (await detail(task.id)).task as TaskDetail["task"];
        await update(task.id, current.version, { dueDate: addDays(today(), 4) });
        const row = await db()
            .prepare("SELECT delivery_status, next_attempt_at, remind_at FROM task_reminders WHERE task_id = ?")
            .bind(task.id)
            .first<{ delivery_status: string; next_attempt_at: string; remind_at: string }>();
        expect(row!.delivery_status).toBe("pending");
        expect(row!.next_attempt_at).toBe(row!.remind_at);
    });
});

describe("portal-wide Quick Add", () => {
    it("is offered on other portal pages only to people who can use Tasks", async () => {
        const render = (html: string) => {
            const json = /<script type="application\/json" id="page-data">([\s\S]*?)<\/script>/.exec(html)?.[1];
            const payload = JSON.parse(json!);
            return renderToString(createElement(PortalApp, { data: payload.data, path: payload.path }));
        };
        const owner = render((await apiCall("GET", "/portal")).text);
        expect(owner).toContain('aria-label="Add task"');
        await apiCall("POST", "/api/portal/users", { email: "wedding-editor@example.com", role: "editor" });
        // A wedding editor can open the planner but not Tasks: no button, no shortcut, and the API refuses.
        const editor = await apiCall("GET", "/portal/wedding/guests", undefined, { email: "wedding-editor@example.com" });
        expect(editor.status).toBe(200);
        expect(render(editor.text)).not.toContain('aria-label="Add task"');
        expect(render(editor.text)).not.toContain("Add task");
    });
});
