// Daly Tasks, Milestone 3, through the real API and database: dashboards, Tasks ↔ Knowledge in
// both directions, project health and reviews, goals, routines, workload, timelines and reports,
// with the privacy boundaries between people checked at every step. Every identity is fictional.
import { beforeEach, describe, expect, it } from "vitest";
import { localDate } from "../src/shared/knowledge/dates";
import { addDays, weekStart, zonedInstant } from "../src/shared/tasks/dates";
import {
    type GoalDetail,
    HEALTH_RULES,
    type HouseholdDashboard,
    type PersonalDashboard,
    type ProjectHealth,
    type ProjectMetrics,
    type ProjectReview,
    type ReviewWorkspace,
    type TaskGoal,
    type TaskRoutine,
    type TasksReport,
    type Workload,
    calculateHealth,
    goalAttention,
    manualPercent,
    nextInTurn,
    reviewSchedule,
    workloadWarnings,
} from "../src/shared/tasks/productivity";
import type { ProjectTimeline } from "../src/shared/tasks/productivity";
import type { TaskProject, TaskSummary } from "../src/shared/tasks/types";
import { create as createKnowledge, personal as knowledgeSpace } from "./knowledge-helpers";
import { accessToken, apiCall, db, call as raw, resetPortal } from "./portal-helpers";
import { A, ADMIN, B, call, createProject, createTask, detail, inbox, list, sharedProject } from "./tasks-helpers";

beforeEach(resetPortal);

const today = () => localDate(new Date(), "Australia/Sydney");
const get = <T>(path: string, email = A) => call<T>("GET", path, undefined, email);
const count = async (sql: string, ...binds: unknown[]) =>
    (await db()
        .prepare(sql)
        .bind(...binds)
        .first<{ n: number }>())!.n;
const personalDashboard = async (email = A) => (await get<{ personal: PersonalDashboard }>("/dashboard?tab=personal", email)).json.personal;
const household = async (email = A, filter = "all") => {
    const result = await get<{ household: HouseholdDashboard }>(`/dashboard?tab=household&filter=${filter}`, email);
    expect(result.status, result.text).toBe(200);
    return result.json.household;
};
const weekly = (weekdays: number[] = [3]) => ({ freq: "weekly", interval: 1, weekdays });
const complete = (id: string, occurrence: string | null, email = A) =>
    call<{ task: TaskSummary; nextDate: string | null }>("POST", `/tasks/${id}/complete`, { occurrence }, email);

// --- Pure rules ----------------------------------------------------------------------------------

const metrics = (overrides: Partial<ProjectMetrics> = {}): ProjectMetrics => ({
    open: 4,
    completed: 4,
    overdue: 0,
    dueSoon: 0,
    unassigned: null,
    undated: 0,
    upcomingMilestones: 0,
    completedRecently: 0,
    lastActivityAt: new Date().toISOString(),
    startDate: null,
    targetDate: null,
    review: { frequency: "none", lastReviewedOn: null, nextDue: null, due: false },
    ...overrides,
});

describe("health, review, goal and workload rules", () => {
    const day = "2026-11-02";

    it("calls a project on track only with a reason, and never just because it's small", () => {
        expect(calculateHealth(metrics(), day)).toEqual({ status: "on_track", reasons: [expect.objectContaining({ level: "info" })] });
        // No open tasks: needs next steps, not "healthy".
        const empty = calculateHealth(metrics({ open: 0, completed: 0 }), day);
        expect(empty.status).toBe("needs_attention");
        expect(empty.reasons[0].text).toMatch(/No open tasks/);
        expect(calculateHealth(metrics({ open: 0, completed: 12 }), day).status).toBe("needs_attention");
    });

    it("applies the documented thresholds", () => {
        expect(calculateHealth(metrics({ overdue: 1 }), day).status).toBe("needs_attention");
        expect(calculateHealth(metrics({ overdue: HEALTH_RULES.riskOverdue, open: 40 }), day).status).toBe("at_risk");
        // More than a third of open tasks overdue (with at least two).
        expect(calculateHealth(metrics({ open: 5, overdue: 2 }), day).status).toBe("at_risk");
        expect(calculateHealth(metrics({ open: 7, overdue: 2 }), day).status).toBe("needs_attention");
        // Target passed with work open.
        expect(calculateHealth(metrics({ targetDate: "2026-11-01" }), day).status).toBe("at_risk");
        // Target in 10 days, a quarter done.
        expect(calculateHealth(metrics({ open: 6, completed: 2, targetDate: "2026-11-12" }), day).status).toBe("at_risk");
        // Target in 20 days, 60% done: attention; 80% done: on track.
        expect(calculateHealth(metrics({ open: 4, completed: 6, targetDate: "2026-11-22" }), day).status).toBe("needs_attention");
        expect(calculateHealth(metrics({ open: 2, completed: 8, targetDate: "2026-11-22" }), day).status).toBe("on_track");
        // Quiet for more than 30 days.
        expect(calculateHealth(metrics({ lastActivityAt: "2026-09-01T00:00:00.000Z" }), day).status).toBe("needs_attention");
        // A review that's due.
        expect(calculateHealth(metrics({ review: reviewSchedule("weekly", "2026-10-20", "2026-01-01", day) }), day).status).toBe("needs_attention");
    });

    it("schedules reviews from the last one, or from the project's creation", () => {
        expect(reviewSchedule("none", null, "2026-10-01", day)).toEqual({ frequency: "none", lastReviewedOn: null, nextDue: null, due: false });
        expect(reviewSchedule("weekly", "2026-10-30", "2026-01-01", day)).toMatchObject({ nextDue: "2026-11-06", due: false });
        expect(reviewSchedule("fortnightly", null, "2026-10-19", day)).toMatchObject({ nextDue: "2026-11-02", due: true });
        expect(reviewSchedule("monthly", "2026-01-31", "2026-01-01", day)).toMatchObject({ nextDue: "2026-02-28", due: true });
    });

    it("measures manual goals between start and target, in either direction", () => {
        expect(manualPercent(0, 2500, 10000)).toBe(25);
        expect(manualPercent(90, 85, 80)).toBe(50); // weight loss: 90 → 80
        expect(manualPercent(0, 12000, 10000)).toBe(100);
        expect(manualPercent(0, -5, 10)).toBe(0);
        expect(manualPercent(5, 5, null)).toBeNull();
        expect(goalAttention({ status: "in_progress", targetDate: "2026-10-30", percent: 50 }, day)).toMatch(/passed/);
        expect(goalAttention({ status: "in_progress", targetDate: "2026-11-10", percent: 50 }, day)).toMatch(/in 8 days/);
        expect(goalAttention({ status: "in_progress", targetDate: "2026-11-10", percent: 100 }, day)).toBeNull();
        expect(goalAttention({ status: "achieved", targetDate: "2026-10-30", percent: 100 }, day)).toBeNull();
        expect(goalAttention({ status: "not_started", targetDate: "2026-11-25", percent: null }, day)).toMatch(/Not started/);
    });

    it("takes turns in order, wrapping round", () => {
        expect(nextInTurn(["a@x", "b@x", "c@x"], "a@x")).toBe("b@x");
        expect(nextInTurn(["a@x", "b@x", "c@x"], "c@x")).toBe("a@x");
        expect(nextInTurn(["a@x", "b@x"], null)).toBe("a@x");
        expect(nextInTurn(["a@x", "b@x"], "someone@x")).toBe("a@x");
        expect(nextInTurn([], "a@x")).toBeNull();
    });

    it("warns about workload with fixed thresholds, never an effort estimate", () => {
        const tasks = [1, 1, 2, 4].map((priority) => ({ dueDate: day, priority: priority as 1 }));
        const warnings = workloadWarnings(tasks, 3, [{ id: "tpj_x", name: "Kitchen", targetDate: "2026-11-10", open: 6 }], day);
        expect(warnings.map((w) => w.kind)).toEqual(["overdue", "priority_day", "project_deadline"]);
        expect(workloadWarnings(tasks.slice(0, 2), 2, [{ id: "tpj_x", name: "Kitchen", targetDate: "2026-11-10", open: 4 }], day)).toEqual([]);
        const busy = Array.from({ length: 8 }, () => ({ dueDate: day, priority: 4 as const }));
        expect(workloadWarnings(busy, 0, [], day)).toEqual([expect.objectContaining({ kind: "busy_day" })]);
    });
});

// --- Dashboard -----------------------------------------------------------------------------------

describe("personal dashboard", () => {
    it("counts exactly what the lists show, grouped by date", async () => {
        const t = today();
        await createTask({ title: "Overdue bill", dueDate: addDays(t, -2) });
        await createTask({ title: "Today call", dueDate: t, priority: 1 });
        await createTask({ title: "Thursday shop", dueDate: addDays(t, 3) });
        await createTask({ title: "Next month", dueDate: addDays(t, 20) });
        await createTask({ title: "Unsorted idea" });
        const done = await createTask({ title: "Done already", dueDate: t });
        expect((await complete(done.id, t)).status).toBe(200);
        const d = await personalDashboard();
        expect(d.overdue).toMatchObject({ count: 1, tasks: [expect.objectContaining({ title: "Overdue bill" })] });
        expect(d.dueToday.tasks.map((x) => x.title)).toEqual(["Today call"]);
        expect(d.next7.tasks.map((x) => x.title)).toEqual(["Thursday shop"]);
        expect(d.inbox.tasks.map((x) => x.title)).toEqual(["Unsorted idea"]);
        expect(d.highPriority.tasks.map((x) => x.title)).toEqual(["Today call"]);
        expect(d.completedRecently).toMatchObject({ count: 1, tasks: [expect.objectContaining({ title: "Done already", status: "completed" })] });
        // The same numbers as Today and Overdue.
        expect((await list("overdue")).length).toBe(d.overdue.count);
    });

    it("never counts someone else's private work, whatever their role", async () => {
        await createTask({ title: "B's secret", dueDate: today() }, B);
        await createProject({ name: "B's private project" }, B);
        const d = await personalDashboard(A);
        expect(JSON.stringify(d)).not.toContain("secret");
        expect(JSON.stringify(d)).not.toContain("B's private project");
        expect(d.dueToday.count).toBe(0);
    });

    it("shows active personal projects with their health, and goals needing attention", async () => {
        const project = await createProject({ name: "Garden", targetDate: addDays(today(), 5) });
        await createTask({ title: "Dig", projectId: project.id });
        const goal = await call("POST", "/goals", {
            title: "Read 12 books",
            progressMode: "manual",
            unit: "books",
            targetValue: 12,
            targetDate: addDays(today(), 3),
        });
        expect(goal.status, goal.text).toBe(201);
        const d = await personalDashboard();
        expect(d.projects).toEqual([expect.objectContaining({ name: "Garden", open: 1, health: expect.objectContaining({ status: "at_risk" }) })]);
        expect(d.goals).toEqual([expect.objectContaining({ title: "Read 12 books", attention: expect.stringMatching(/Target in 3 days/) })]);
    });

    it("remembers each person's dashboard choices, validated", async () => {
        expect((await call("PUT", "/preferences/dashboard", { tab: "household", hidden: ["goals"], household: "mine" })).status).toBe(200);
        const r = await get<{ tab: string; preferences: unknown; household: HouseholdDashboard }>("/dashboard");
        expect(r.json).toMatchObject({ tab: "household", preferences: { hidden: ["goals"] }, household: { filter: "mine" } });
        expect((await get<{ tab: string }>("/dashboard", B)).json.tab).toBe("personal");
        expect((await call("PUT", "/preferences/dashboard", { hidden: ["sql"] })).status).toBe(422);
        expect((await call("PUT", "/preferences/dashboard", { tab: "x" })).status).toBe(422);
    });
});

describe("household dashboard", () => {
    it("shows shared work to both members, filtered by assignee, and nothing private", async () => {
        const project = await sharedProject("editor");
        const t = today();
        await createTask({ title: "Mow lawn", projectId: project.id, dueDate: t, assignee: A });
        await createTask({ title: "Pay rates", projectId: project.id, dueDate: addDays(t, -1), assignee: B });
        await createTask({ title: "Fix gate", projectId: project.id, dueDate: addDays(t, 4) });
        await createTask({ title: "Insurance renewal", projectId: project.id, deadline: addDays(t, 30) });
        await createTask({ title: "A private dentist", dueDate: t });
        await createTask({ title: "B private gift idea", dueDate: t }, B);

        for (const email of [A, B]) {
            const h = await household(email);
            expect(h.projectCount).toBe(1);
            expect(h.attention.tasks.map((x) => x.title).sort()).toEqual(["Mow lawn", "Pay rates"]);
            expect(h.upcoming.tasks.map((x) => x.title)).toEqual(["Fix gate"]);
            expect(h.commitments.tasks.map((x) => x.title)).toEqual(["Insurance renewal"]);
            const text = JSON.stringify(h);
            expect(text).not.toContain("private");
        }
        expect((await household(A, "mine")).attention.tasks.map((x) => x.title)).toEqual(["Mow lawn"]);
        expect((await household(B, "mine")).attention.tasks.map((x) => x.title)).toEqual(["Pay rates"]);
        expect((await household(A, "others")).attention.tasks.map((x) => x.title)).toEqual(["Pay rates"]);
        expect((await household(A, "unassigned")).upcoming.tasks.map((x) => x.title)).toEqual(["Fix gate"]);
        const people = (await household(A)).byAssignee;
        expect(people).toEqual([
            expect.objectContaining({ email: A, open: 1, overdue: 0 }),
            expect.objectContaining({ email: B, open: 1, overdue: 1 }),
            expect.objectContaining({ email: null, open: 2 }),
        ]);
    });

    it("drops a shared project from the dashboard the moment someone is removed", async () => {
        const project = await sharedProject("editor");
        await createTask({ title: "Shared chore", projectId: project.id, dueDate: today() });
        expect((await household(B)).attention.count).toBe(1);
        expect((await call("DELETE", `/projects/${project.id}/members/${B}`)).status).toBe(200);
        const after = await household(B);
        expect(after).toMatchObject({ projectCount: 0, attention: { count: 0 }, byAssignee: [] });
        expect(JSON.stringify(after)).not.toContain("Shared chore");
    });

    it("lists shared completions by whoever did them", async () => {
        const project = await sharedProject("editor");
        const task = await createTask({ title: "Clean gutters", projectId: project.id });
        expect((await complete(task.id, null, B)).status).toBe(200);
        expect((await household(A)).completedRecently.tasks).toEqual([expect.objectContaining({ title: "Clean gutters", completedBy: B })]);
    });
});

// --- Knowledge -----------------------------------------------------------------------------------

describe("Tasks and Knowledge, both directions", () => {
    it("shows a Knowledge object's related tasks and projects, only those the reader can see", async () => {
        const space = await knowledgeSpace(A);
        const note = await createKnowledge(space.id, { title: "Wedding planning" });
        const id = note.object.id;
        const shared = await sharedProject("editor", "Wedding");
        await createTask({ title: "Confirm catering", projectId: shared.id, knowledge: [id] });
        await createTask({ title: "A's private reminder", knowledge: [id] });
        expect((await call("POST", `/projects/${shared.id}/knowledge`, { objectId: id })).status).toBe(201);

        const mine = await get<{ tasks: TaskSummary[]; projects: { name: string }[] }>(`/knowledge/${id}`);
        expect(mine.json.tasks.map((t) => t.title).sort()).toEqual(["A's private reminder", "Confirm catering"]);
        expect(mine.json.projects.map((p) => p.name)).toEqual(["Wedding"]);

        // B shares the project but can't read A's private note: the object's tasks are a 404 for them,
        // and the project shows the reference without saying what it is.
        expect((await get(`/knowledge/${id}`, B)).status).toBe(404);
        const refs = await get<{ knowledge: unknown[] }>(`/projects/${shared.id}/knowledge`, B);
        expect(refs.json.knowledge).toEqual([{ linkId: expect.any(String), available: false }]);
        expect(JSON.stringify(refs.json)).not.toContain("Wedding planning");
        // And B can't link it either.
        expect((await call("POST", `/projects/${shared.id}/knowledge`, { objectId: id }, B)).status).toBe(404);
    });

    it("hides private tasks from someone who can read the object", async () => {
        const created = await apiCall<{ space: { id: string } }>("POST", "/api/portal/knowledge/spaces", { name: "Family" });
        expect((await apiCall("POST", `/api/portal/knowledge/spaces/${created.json.space.id}/members`, { email: B, role: "editor" })).status).toBe(201);
        const note = await createKnowledge(created.json.space.id, { title: "Car" });
        await createTask({ title: "A's private service booking", knowledge: [note.object.id] });
        const related = await get<{ tasks: TaskSummary[]; projects: unknown[] }>(`/knowledge/${note.object.id}`, B);
        expect(related.status).toBe(200);
        expect(related.json).toEqual({ tasks: [], projects: [], taskProjects: [] });

        // Revoking B's Knowledge membership takes the object away from them in Tasks at once.
        const shared = await sharedProject("editor", "Cars");
        await createTask({ title: "Rotate tyres", projectId: shared.id, knowledge: [note.object.id] }, B);
        expect((await get<{ tasks: TaskSummary[] }>(`/knowledge/${note.object.id}`, B)).json.tasks.map((t) => t.title)).toEqual(["Rotate tyres"]);
        expect((await apiCall("DELETE", `/api/portal/knowledge/spaces/${created.json.space.id}/members/${B}`)).status).toBe(200);
        expect((await get(`/knowledge/${note.object.id}`, B)).status).toBe(404);
        const task = (await list("today", B)).length;
        expect(task).toBe(0);
        const shown = (await get<{ tasks: TaskSummary[] }>(`/projects/${shared.id}`, B)).json.tasks.find((t) => t.title === "Rotate tyres")!;
        expect((await detail(shown.id, B)).knowledge).toEqual([{ linkId: expect.any(String), available: false }]);
    });

    it("creates a linked task from a Knowledge page in one write, and refuses unreadable objects", async () => {
        const note = await createKnowledge((await knowledgeSpace(A)).id, { title: "Holiday" });
        const project = await createProject({ name: "Trips" });
        const made = await call<{ task: TaskSummary }>("POST", "/tasks", { title: "Book flights", projectId: project.id, knowledge: [note.object.id] });
        expect(made.status).toBe(201);
        expect((await get<{ tasks: TaskSummary[] }>(`/knowledge/${note.object.id}`)).json.tasks.map((t) => t.id)).toEqual([made.json.task.id]);
        // No note text is copied into the task.
        expect((await detail(made.json.task.id)).task.description).toBe("");
    });

    it("treats a trashed object as unrelated", async () => {
        const note = await createKnowledge((await knowledgeSpace(A)).id, { title: "Old plan" });
        const project = await createProject({ name: "Plan" });
        await createTask({ title: "Linked", knowledge: [note.object.id] });
        await call("POST", `/projects/${project.id}/knowledge`, { objectId: note.object.id });
        await db().prepare("UPDATE knowledge_objects SET status = 'trashed' WHERE id = ?").bind(note.object.id).run();
        expect((await get(`/knowledge/${note.object.id}`)).json).toEqual({ tasks: [], projects: [], taskProjects: [] });
        expect((await call("POST", `/projects/${project.id}/knowledge`, { objectId: note.object.id })).status).toBe(404);
    });
});

// --- Project health and reviews ------------------------------------------------------------------

describe("project health", () => {
    it("measures a project as its member sees it, with a manual override that records who set it", async () => {
        const project = await sharedProject("editor", "Renovation");
        await createTask({ title: "Overdue quote", projectId: project.id, dueDate: addDays(today(), -3) });
        await createTask({ title: "Paint", projectId: project.id });
        const h = await get<{ health: ProjectHealth; metrics: ProjectMetrics }>(`/projects/${project.id}/health`, B);
        expect(h.json.metrics).toMatchObject({ open: 2, overdue: 1, unassigned: 2, undated: 1 });
        // One of two open tasks overdue: attention (at risk needs two or more, or five).
        expect(h.json.health.status).toBe("needs_attention");
        const set = await call<{ health: ProjectHealth }>(
            "PATCH",
            `/projects/${project.id}/health`,
            { version: (await get<{ project: TaskProject }>(`/projects/${project.id}`, B)).json.project.version, status: "on_track", note: "Quote is in hand" },
            B,
        );
        expect(set.status, set.text).toBe(200);
        expect(set.json.health).toMatchObject({
            status: "on_track",
            calculated: "needs_attention",
            override: { status: "on_track", by: B, note: "Quote is in hand" },
        });
        // Stale version: nothing changes.
        expect((await call("PATCH", `/projects/${project.id}/health`, { version: 1, status: "at_risk" })).status).toBe(409);
        // Cleared: back to the calculated status. History records the status, not the note.
        const fresh = (await get<{ project: TaskProject }>(`/projects/${project.id}`)).json.project;
        expect(
            (await call<{ health: ProjectHealth }>("PATCH", `/projects/${project.id}/health`, { version: fresh.version, status: null })).json.health,
        ).toMatchObject({ status: "needs_attention", override: null });
        const logged = await db().prepare("SELECT changes FROM task_activity WHERE action = 'project.health'").all<{ changes: string }>();
        expect(logged.results.map((r) => r.changes).join()).not.toContain("Quote");
        // Strangers and viewers.
        expect((await get(`/projects/${project.id}/health`, ADMIN)).status).toBe(403);
    });

    it("is a 404 for anyone who isn't a member", async () => {
        const project = await createProject({ name: "Private finances" });
        expect((await get(`/projects/${project.id}/health`, B)).status).toBe(404);
        expect((await call("PATCH", `/projects/${project.id}/health`, { version: 1, status: "at_risk" }, B)).status).toBe(404);
        expect((await call("POST", `/projects/${project.id}/reviews`, {}, B)).status).toBe(404);
        expect((await get(`/projects/${project.id}/timeline`, B)).status).toBe(404);
    });
});

describe("project reviews", () => {
    it("runs a review: since last time, overdue, upcoming, unresolved, note, next actions, completion", async () => {
        const project = await sharedProject("editor", "Holiday planning");
        const t = today();
        const booked = await createTask({ title: "Book accommodation", projectId: project.id });
        await complete(booked.id, null);
        await createTask({ title: "Passports", projectId: project.id, dueDate: addDays(t, -1), assignee: B });
        await createTask({ title: "Flights deadline", projectId: project.id, deadline: addDays(t, 10), assignee: A });
        await createTask({ title: "Decide itinerary", projectId: project.id });

        const started = await call<ReviewWorkspace>("POST", `/projects/${project.id}/reviews`, {});
        expect(started.status, started.text).toBe(201);
        const ws = started.json;
        expect(ws.review).toMatchObject({ status: "draft", periodStart: null, startedBy: A });
        expect(ws.completedSince.map((x) => x.title)).toEqual(["Book accommodation"]);
        expect(ws.overdue.map((x) => x.title)).toEqual(["Passports"]);
        expect(ws.upcoming.map((x) => x.title)).toEqual(["Flights deadline"]);
        expect(ws.unresolved.map((x) => x.title)).toEqual(["Decide itinerary"]);

        // B starting at the same time joins the same draft.
        const again = await call<ReviewWorkspace>("POST", `/projects/${project.id}/reviews`, {}, B);
        expect(again.json.review.id).toBe(ws.review.id);
        expect(await count("SELECT COUNT(*) AS n FROM task_project_reviews WHERE project_id = ?", project.id)).toBe(1);

        // Edits carry a version: the second of two edits from the same version is refused.
        const edited = await call<{ review: ProjectReview }>("PATCH", `/reviews/${ws.review.id}`, {
            version: 1,
            note: "Good progress",
            health: "needs_attention",
        });
        expect(edited.status).toBe(200);
        expect((await call("PATCH", `/reviews/${ws.review.id}`, { version: 1, note: "Overwrite" }, B)).status).toBe(409);
        expect((await get<ReviewWorkspace>(`/reviews/${ws.review.id}`)).json.review.note).toBe("Good progress");

        // Next actions are tasks in this project, created one by one.
        const action = await call<{ review: ProjectReview }>("POST", `/reviews/${ws.review.id}/actions`, {
            title: "Renew passports",
            dueDate: addDays(t, 2),
            assignee: B,
        });
        expect(action.status, action.text).toBe(201);
        expect(action.json.review.actions).toEqual([expect.objectContaining({ title: "Renew passports", projectId: project.id, assignee: B })]);
        // Only into the reviewed project.
        expect((await call("POST", `/reviews/${ws.review.id}/actions`, { title: "Elsewhere", projectId: (await inbox()).id })).status).toBe(422);
        expect(await count("SELECT COUNT(*) AS n FROM task_items WHERE title = 'Elsewhere'")).toBe(0);

        const done = await call<{ review: ProjectReview }>("POST", `/reviews/${ws.review.id}/complete`, { version: edited.json.review.version });
        expect(done.status, done.text).toBe(200);
        expect(done.json.review).toMatchObject({
            status: "completed",
            completedBy: A,
            health: "needs_attention",
            snapshot: { open: 4, overdue: 1, completedSince: 1 },
        });
        // A second click changes nothing.
        expect((await call<{ review: ProjectReview }>("POST", `/reviews/${ws.review.id}/complete`, { version: 1 })).json.review.completedAt).toBe(
            done.json.review.completedAt,
        );
        expect((await call("PATCH", `/reviews/${ws.review.id}`, { version: 99, note: "late" })).status).toBe(422);

        // The next review covers only what's happened since.
        const next = await call<ReviewWorkspace>("POST", `/projects/${project.id}/reviews`, {}, B);
        expect(next.json.review.id).not.toBe(ws.review.id);
        expect(next.json.review.periodStart).toBe(done.json.review.completedAt);
        expect(next.json.completedSince).toEqual([]);
        expect((await call("POST", `/reviews/${next.json.review.id}/discard`, {}, B)).status).toBe(200);
        // The action created in the discarded review's predecessor stays; history lists the completed review.
        const history = await get<{ reviews: ProjectReview[] }>(`/projects/${project.id}/reviews`, B);
        expect(history.json.reviews.map((r) => r.id)).toEqual([ws.review.id]);
        expect(await count("SELECT COUNT(*) AS n FROM task_items WHERE title = 'Renew passports'")).toBe(1);
    });

    it("lets viewers read reviews but not write them, and strangers see nothing", async () => {
        const project = await sharedProject("viewer", "Budget");
        const ws = (await call<ReviewWorkspace>("POST", `/projects/${project.id}/reviews`, {})).json;
        expect((await get(`/reviews/${ws.review.id}`, B)).status).toBe(200);
        expect((await call("POST", `/projects/${project.id}/reviews`, {}, B)).status).toBe(403);
        expect((await call("PATCH", `/reviews/${ws.review.id}`, { version: 1, note: "x" }, B)).status).toBe(403);
        expect((await call("POST", `/reviews/${ws.review.id}/actions`, { title: "x" }, B)).status).toBe(403);
        await apiCall("POST", "/api/portal/users", { email: ADMIN, role: "admin" });
        expect((await get(`/reviews/${ws.review.id}`, ADMIN)).status).toBe(404);
        expect((await get(`/projects/${project.id}/reviews`, ADMIN)).status).toBe(404);
    });

    it("makes the next review due one period after the last, and flags it", async () => {
        const project = await createProject({ name: "Weekly admin" });
        expect((await call("PATCH", `/projects/${project.id}`, { version: project.version, reviewFrequency: "weekly" })).status).toBe(200);
        await db()
            .prepare("UPDATE task_projects SET created_at = ? WHERE id = ?")
            .bind(new Date(Date.now() - 10 * 86_400_000).toISOString(), project.id)
            .run();
        await createTask({ title: "File receipts", projectId: project.id });
        let h = (await get<{ metrics: ProjectMetrics }>(`/projects/${project.id}/health`)).json.metrics.review;
        expect(h).toMatchObject({ frequency: "weekly", lastReviewedOn: null, due: true });
        expect((await personalDashboard()).reviewsDue.map((r) => r.name)).toEqual(["Weekly admin"]);
        const ws = (await call<ReviewWorkspace>("POST", `/projects/${project.id}/reviews`, {})).json;
        await call("POST", `/reviews/${ws.review.id}/complete`, { version: ws.review.version });
        h = (await get<{ metrics: ProjectMetrics }>(`/projects/${project.id}/health`)).json.metrics.review;
        expect(h).toMatchObject({ lastReviewedOn: today(), nextDue: addDays(today(), 7), due: false });
        expect((await personalDashboard()).reviewsDue).toEqual([]);
    });
});

// --- Goals ---------------------------------------------------------------------------------------

const createGoal = async (body: Record<string, unknown>, email = A) => {
    const result = await call<GoalDetail>("POST", "/goals", body, email);
    expect(result.status, result.text).toBe(201);
    return result.json;
};

describe("goals", () => {
    it("keeps personal goals private to their owner, whatever their portal role", async () => {
        const goal = await createGoal({ title: "Run a half marathon" });
        for (const [method, path, body] of [
            ["GET", `/goals/${goal.goal.id}`, undefined],
            ["PATCH", `/goals/${goal.goal.id}`, { version: 1, title: "x" }],
            ["POST", `/goals/${goal.goal.id}/progress`, { version: 1, value: 1 }],
            ["POST", `/goals/${goal.goal.id}/links`, { projectId: "tpj_00000000000000" }],
            ["POST", `/goals/${goal.goal.id}/milestones`, { title: "x" }],
            ["POST", `/goals/${goal.goal.id}/members`, { email: B, role: "editor" }],
            ["POST", `/goals/${goal.goal.id}/delete`, { confirm: "DELETE" }],
        ] as const)
            expect((await call(method, path, body, B)).status, path).toBe(404);
        expect((await get<{ goals: TaskGoal[] }>("/goals", B)).json.goals).toEqual([]);
        // A personal goal can't gain a second member, even bypassing the Worker.
        await expect(
            db()
                .prepare("INSERT INTO task_goal_members (goal_id, email, role, added_by, created_at) VALUES (?, ?, 'editor', 'x', 'x')")
                .bind(goal.goal.id, B)
                .run(),
        ).rejects.toThrow(/exactly one member/);
    });

    it("derives progress from linked projects and tasks, counting each task once", async () => {
        const project = await createProject({ name: "Kitchen" });
        const tasks = await Promise.all(["Tiles", "Benchtop", "Sink"].map((title) => createTask({ title, projectId: project.id })));
        const outside = await createTask({ title: "Choose paint" });
        const goal = await createGoal({ title: "New kitchen", projectIds: [project.id], status: "in_progress" });
        expect(goal.goal.progress).toMatchObject({ mode: "tasks", total: 3, done: 0, percent: 0 });
        expect((await call("POST", `/goals/${goal.goal.id}/links`, { taskId: outside.id })).status).toBe(201);
        // Linking a task that's already in a linked project doesn't count it twice.
        await call("POST", `/goals/${goal.goal.id}/links`, { taskId: tasks[0].id });
        await complete(tasks[0].id, null);
        const d = (await get<GoalDetail>(`/goals/${goal.goal.id}`)).json;
        expect(d.goal.progress).toMatchObject({ total: 4, done: 1, percent: 25 });
        expect(d.projects).toEqual([expect.objectContaining({ name: "Kitchen", open: 2, completed: 1 })]);
        expect(d.tasks.map((t) => t.title).sort()).toEqual(["Choose paint", "Tiles"]);
        // Duplicate links are ignored.
        await call("POST", `/goals/${goal.goal.id}/links`, { projectId: project.id });
        expect(await count("SELECT COUNT(*) AS n FROM task_goal_links WHERE goal_id = ? AND project_id IS NOT NULL", goal.goal.id)).toBe(1);
    });

    it("tracks a manual goal's value, history, milestones and status", async () => {
        const goal = await createGoal({ title: "Emergency fund", progressMode: "manual", unit: "$", startValue: 0, targetValue: 10000 });
        expect(goal.goal).toMatchObject({ status: "not_started", progress: { percent: 0, unit: "$" } });
        expect((await call("POST", "/goals", { title: "Bad", progressMode: "manual", startValue: 5, targetValue: 5 })).status).toBe(422);
        expect((await call("POST", "/goals", { title: "Bad", progressMode: "manual" })).status).toBe(422);
        const updated = await call<GoalDetail>("POST", `/goals/${goal.goal.id}/progress`, { version: 1, value: 2500, note: "Tax refund" });
        expect(updated.json.goal).toMatchObject({ status: "in_progress", progress: { current: 2500, percent: 25 } });
        // Concurrent updates from the same version: one wins.
        expect((await call("POST", `/goals/${goal.goal.id}/progress`, { version: 1, value: 9000 })).status).toBe(409);
        await call("POST", `/goals/${goal.goal.id}/milestones`, { title: "First $5,000", targetDate: addDays(today(), 60) });
        let d = (await get<GoalDetail>(`/goals/${goal.goal.id}`)).json;
        expect(d.goal.milestones).toMatchObject({ total: 1, done: 0, next: { title: "First $5,000" } });
        expect((await call("PATCH", `/goal-milestones/${d.milestones[0].id}`, { done: true })).status).toBe(200);
        expect((await call("PATCH", `/goal-milestones/${d.milestones[0].id}`, { done: true }, B)).status).toBe(404);
        const achieved = await call<GoalDetail>("PATCH", `/goals/${goal.goal.id}`, { version: d.goal.version, status: "achieved", note: "Done early" });
        expect(achieved.json.goal).toMatchObject({ status: "achieved", achievedAt: expect.any(String), progress: { percent: 100 } });
        d = achieved.json;
        expect(d.history.map((e) => e.kind)).toEqual(["status", "milestone", "value", "created"]);
        expect(d.history[2]).toMatchObject({ value: 2500, note: "Tax refund", by: A });
        // A task-mode goal can't take a manual value.
        const tasky = await createGoal({ title: "Tasky" });
        expect((await call("POST", `/goals/${tasky.goal.id}/progress`, { version: 1, value: 3 })).status).toBe(422);
    });

    it("archives and deletes only for owners, and keeps archived goals out of the list", async () => {
        const goal = await createGoal({ title: "Learn Spanish" });
        expect((await call("POST", `/goals/${goal.goal.id}/archive`, { archived: true })).status).toBe(200);
        expect((await get<{ goals: TaskGoal[] }>("/goals")).json.goals).toEqual([]);
        expect((await get<{ goals: TaskGoal[] }>("/goals?archived=1")).json.goals.map((g) => g.title)).toEqual(["Learn Spanish"]);
        expect((await call("PATCH", `/goals/${goal.goal.id}`, { version: 2, title: "x" })).status).toBe(422);
        expect((await call("POST", `/goals/${goal.goal.id}/delete`, { confirm: "nope" })).status).toBe(422);
        expect((await call("POST", `/goals/${goal.goal.id}/delete`, { confirm: "DELETE" })).status).toBe(200);
        expect(await count("SELECT COUNT(*) AS n FROM task_goal_progress WHERE goal_id = ?", goal.goal.id)).toBe(0);
    });

    it("shares a goal only with the people added to it, never through a linked project", async () => {
        const project = await sharedProject("editor", "Wedding");
        const goal = await createGoal({ title: "Plan the wedding", kind: "shared", projectIds: [project.id] });
        // B is in the project, not the goal.
        expect((await get(`/goals/${goal.goal.id}`, B)).status).toBe(404);
        expect((await call("POST", `/goals/${goal.goal.id}/members`, { email: B, role: "editor" })).status).toBe(201);
        expect((await get<GoalDetail>(`/goals/${goal.goal.id}`, B)).json.projects.map((p) => p.name)).toEqual(["Wedding"]);
        // B can update it, can't manage members, and can leave.
        const version = (await get<GoalDetail>(`/goals/${goal.goal.id}`, B)).json.goal.version;
        expect((await call("PATCH", `/goals/${goal.goal.id}`, { version, status: "in_progress" }, B)).status).toBe(200);
        expect((await call("POST", `/goals/${goal.goal.id}/members`, { email: ADMIN, role: "viewer" }, B)).status).toBe(403);
        expect((await call("DELETE", `/goals/${goal.goal.id}/members/${B}`, undefined, B)).status).toBe(200);
        expect((await get(`/goals/${goal.goal.id}`, B)).status).toBe(404);
        // The last owner can't be removed.
        expect((await call("PATCH", `/goals/${goal.goal.id}/members/${A}`, { role: "editor" })).status).toBe(422);
    });

    it("never lets a shared goal draw on personal projects or tasks", async () => {
        const personal = await createProject({ name: "My diary" });
        const task = await createTask({ title: "Private thought" });
        expect((await call("POST", "/goals", { title: "Shared", kind: "shared", projectIds: [personal.id] })).status).toBe(422);
        const goal = await createGoal({ title: "Household", kind: "shared" });
        expect((await call("POST", `/goals/${goal.goal.id}/links`, { projectId: personal.id })).status).toBe(422);
        expect((await call("POST", `/goals/${goal.goal.id}/links`, { taskId: task.id })).status).toBe(422);
        // Even past the Worker.
        await expect(
            db()
                .prepare("INSERT INTO task_goal_links (id, goal_id, project_id, added_by, added_at) VALUES ('tgk_x', ?, ?, 'x', 'x')")
                .bind(goal.goal.id, personal.id)
                .run(),
        ).rejects.toThrow(/shared goal/);
        // A personal goal with personal links can't be shared until they're removed.
        const mine = await createGoal({ title: "Mine", projectIds: [personal.id] });
        expect((await call("POST", `/goals/${mine.goal.id}/kind`, { kind: "shared" })).status).toBe(422);
        // A shared project made personal again leaves every shared goal.
        const project = await sharedProject("editor", "Was shared");
        await call("POST", `/goals/${goal.goal.id}/links`, { projectId: project.id });
        await call("DELETE", `/projects/${project.id}/members/${B}`);
        expect((await call("POST", `/projects/${project.id}/kind`, { kind: "personal" })).status).toBe(200);
        expect(await count("SELECT COUNT(*) AS n FROM task_goal_links WHERE goal_id = ?", goal.goal.id)).toBe(0);
    });

    it("counts progress per reader: projects a member can't see add nothing for them", async () => {
        await apiCall("POST", "/api/portal/users", { email: ADMIN, role: "admin" });
        // A and ADMIN share "Finance"; A and B share the goal. B isn't in Finance.
        const finance = await createProject({ name: "Finance", kind: "shared" });
        await call("POST", `/projects/${finance.id}/members`, { email: ADMIN, role: "editor" });
        const done = await createTask({ title: "Budget spreadsheet", projectId: finance.id });
        await complete(done.id, null);
        const goal = await createGoal({ title: "Get on top of money", kind: "shared", projectIds: [finance.id] });
        await call("POST", `/goals/${goal.goal.id}/members`, { email: B, role: "viewer" });
        expect((await get<GoalDetail>(`/goals/${goal.goal.id}`)).json.goal.progress).toMatchObject({ total: 1, done: 1 });
        const theirs = (await get<GoalDetail>(`/goals/${goal.goal.id}`, B)).json;
        expect(theirs.goal.progress).toMatchObject({ total: 0, done: 0, percent: null });
        expect(theirs.projects).toEqual([]);
        expect(JSON.stringify(theirs)).not.toContain("Finance");
        expect(JSON.stringify(theirs)).not.toContain("Budget spreadsheet");
    });

    it("links Knowledge only when readable, and shows it only to readers", async () => {
        const note = await createKnowledge((await knowledgeSpace(A)).id, { title: "Savings plan" });
        const goal = await createGoal({ title: "Save", kind: "shared" });
        await call("POST", `/goals/${goal.goal.id}/members`, { email: B, role: "editor" });
        expect((await call("POST", `/goals/${goal.goal.id}/links`, { objectId: note.object.id }, B)).status).toBe(404);
        expect((await call("POST", `/goals/${goal.goal.id}/links`, { objectId: note.object.id })).status).toBe(201);
        expect((await get<GoalDetail>(`/goals/${goal.goal.id}`)).json.knowledge).toEqual([expect.objectContaining({ title: "Savings plan" })]);
        const forB = (await get<GoalDetail>(`/goals/${goal.goal.id}`, B)).json;
        expect(forB.knowledge).toEqual([]);
        expect(JSON.stringify(forB)).not.toContain("Savings plan");
        // Link history never names what was linked.
        const history = await db().prepare("SELECT note FROM task_goal_progress WHERE kind = 'link'").all<{ note: string }>();
        expect(history.results).toEqual([{ note: "" }]);
    });
});

// --- Routines ------------------------------------------------------------------------------------

const createRoutine = async (body: Record<string, unknown>, email = A) => {
    const result = await call<{ routine: TaskRoutine }>("POST", "/routines", body, email);
    expect(result.status, result.text).toBe(201);
    return result.json.routine;
};

describe("routines", () => {
    it("is a repeating task with a checklist: completing it moves the schedule and records who did it", async () => {
        const routine = await createRoutine({
            title: "Check smoke alarms",
            recurrence: { freq: "monthly", interval: 6, monthDay: 1 },
            checklist: ["Test button", "Replace battery"],
        });
        expect(routine).toMatchObject({ rotation: "none", paused: false, project: { isInbox: true }, task: { subtasks: { total: 2, open: 2 } } });
        expect(routine.task.recurrence).toMatchObject({ freq: "monthly", interval: 6 });
        const first = routine.task.dueDate!;
        // Completing the task (from anywhere) is completing the routine; subtasks are a checklist.
        const result = await call<{ nextDate: string }>("POST", `/tasks/${routine.task.id}/complete`, { occurrence: first, includeSubtasks: true });
        expect(result.status, result.text).toBe(200);
        const after = (await get<{ routine: TaskRoutine }>(`/routines/${routine.id}`)).json.routine;
        expect(after.task.dueDate).toBe(result.json.nextDate);
        expect(after.task.subtasks.open).toBe(2);
        expect(after.recent).toEqual([expect.objectContaining({ kind: "completed", occurrenceDate: first, by: A })]);
        const history = await get<{ entries: { kind: string }[] }>(`/routines/${routine.id}/history`);
        expect(history.json.entries).toHaveLength(1);
        // No routine state of its own to drift: the completion lives in task_completions only.
        expect(await count("SELECT COUNT(*) AS n FROM task_completions WHERE task_id = ?", routine.task.id)).toBe(1);
    });

    it("needs a repeat, and is one routine per task", async () => {
        expect((await call("POST", "/routines", { title: "No schedule" })).status).toBe(422);
        const task = await createTask({ title: "One-off" });
        expect((await call("POST", "/routines", { taskId: task.id })).status).toBe(422);
        const repeating = await createTask({ title: "Water plants", recurrence: weekly([6]) });
        await createRoutine({ taskId: repeating.id });
        expect((await call("POST", "/routines", { taskId: repeating.id })).status).toBe(409);
        // A retried create (same request id) returns the routine it made.
        const body = { title: "Bins", recurrence: weekly([3]), clientId: "qa-routine-00000001" };
        const one = await createRoutine(body);
        const two = await call<{ routine: TaskRoutine }>("POST", "/routines", body);
        expect(two.json.routine.id).toBe(one.id);
        expect(await count("SELECT COUNT(*) AS n FROM task_routines")).toBe(2);
    });

    it("takes turns: completing passes it on, skipping doesn't, undo gives it back", async () => {
        const project = await sharedProject("editor", "Home");
        const routine = await createRoutine({
            title: "Put the bins out",
            projectId: project.id,
            recurrence: weekly([3]),
            rotation: "turns",
            participants: [A, B],
        });
        expect(routine).toMatchObject({
            responsible: A,
            nextUp: B,
            participants: [expect.objectContaining({ email: A }), expect.objectContaining({ email: B })],
        });
        const week1 = routine.task.dueDate!;
        // B can complete A's turn; the turn still passes to the next person after A.
        expect((await complete(routine.task.id, week1, B)).status).toBe(200);
        let now = (await get<{ routine: TaskRoutine }>(`/routines/${routine.id}`)).json.routine;
        expect(now).toMatchObject({ responsible: B, nextUp: A });
        const week2 = now.task.dueDate!;
        // Skipping keeps it with B.
        expect((await call("POST", `/tasks/${routine.task.id}/skip`, { occurrence: week2 }, B)).status).toBe(200);
        now = (await get<{ routine: TaskRoutine }>(`/routines/${routine.id}`)).json.routine;
        expect(now.responsible).toBe(B);
        expect((await complete(routine.task.id, now.task.dueDate, B)).status).toBe(200);
        expect((await get<{ routine: TaskRoutine }>(`/routines/${routine.id}`)).json.routine.responsible).toBe(A);
        // Undo the completion: the date goes back and so does the turn.
        expect((await call("POST", `/tasks/${routine.task.id}/reopen`, {}, B)).status).toBe(200);
        expect((await get<{ routine: TaskRoutine }>(`/routines/${routine.id}`)).json.routine.responsible).toBe(B);
        // Both see who's responsible.
        expect((await get<{ routines: TaskRoutine[] }>("/routines", B)).json.routines.map((r) => r.responsible)).toEqual([B]);
    });

    it("only rotates between people who can be assigned, and drops anyone who leaves", async () => {
        const viewerProject = await sharedProject("viewer", "Watch only");
        expect(
            (await call("POST", "/routines", { title: "x", projectId: viewerProject.id, recurrence: weekly(), rotation: "turns", participants: [A, B] }))
                .status,
        ).toBe(422);
        expect((await call("POST", "/routines", { title: "x", recurrence: weekly(), rotation: "turns", participants: [A, B] })).status).toBe(422);
        expect(
            (await call("POST", "/routines", { title: "x", projectId: viewerProject.id, recurrence: weekly(), rotation: "turns", participants: [A] })).status,
        ).toBe(422);
        const project = await sharedProject("editor", "Chores");
        const routine = await createRoutine({ title: "Vacuum", projectId: project.id, recurrence: weekly([6]), rotation: "turns", participants: [B, A] });
        expect(routine.responsible).toBe(B);
        await call("DELETE", `/projects/${project.id}/members/${B}`);
        const after = (await get<{ routine: TaskRoutine }>(`/routines/${routine.id}`)).json.routine;
        expect(after.participants.map((p) => p.email)).toEqual([A]);
        expect(after.responsible).toBeNull();
        expect((await get(`/routines/${routine.id}`, B)).status).toBe(404);
        // Completing with one participant left assigns them; nobody who left is ever assigned again.
        await complete(routine.task.id, routine.task.dueDate);
        expect((await get<{ routine: TaskRoutine }>(`/routines/${routine.id}`)).json.routine.responsible).toBe(A);
    });

    it("pauses out of the date views and resumes on the next date without inventing completions", async () => {
        const routine = await createRoutine({ title: "Water garden", recurrence: { freq: "daily", interval: 2 }, dueDate: addDays(today(), -4) });
        await db().prepare("UPDATE task_items SET due_date = ? WHERE id = ?").bind(addDays(today(), -4), routine.task.id).run();
        expect((await list("overdue")).map((t) => t.title)).toEqual(["Water garden"]);
        const paused = await call<{ routine: TaskRoutine }>("POST", `/routines/${routine.id}/pause`, { paused: true, version: 1 });
        expect(paused.json.routine.paused).toBe(true);
        expect(await list("overdue")).toEqual([]);
        expect((await personalDashboard()).overdue.count).toBe(0);
        // Still in its project, and still editable there.
        expect((await list("inbox")).map((t) => t.title)).toEqual(["Water garden"]);
        expect((await call("POST", `/routines/${routine.id}/pause`, { paused: false, version: 1 })).status).toBe(409);
        const resumed = await call<{ routine: TaskRoutine }>("POST", `/routines/${routine.id}/pause`, { paused: false, version: 2 });
        expect(resumed.json.routine.paused).toBe(false);
        expect(resumed.json.routine.task.dueDate! >= today()).toBe(true);
        expect(await count("SELECT COUNT(*) AS n FROM task_completions WHERE task_id = ?", routine.task.id)).toBe(0);
    });

    it("keeps private routines private and lets viewers see but not change shared ones", async () => {
        await createRoutine({ title: "A's private routine", recurrence: weekly() });
        expect((await get<{ routines: TaskRoutine[] }>("/routines", B)).json.routines).toEqual([]);
        const project = await sharedProject("viewer", "Shared");
        const shared = await createRoutine({ title: "Shared routine", projectId: project.id, recurrence: weekly() });
        const seen = (await get<{ routines: TaskRoutine[] }>("/routines", B)).json.routines;
        expect(seen).toEqual([expect.objectContaining({ canEdit: false, task: expect.objectContaining({ title: "Shared routine" }) })]);
        expect((await call("POST", `/routines/${shared.id}/pause`, { paused: true, version: 1 }, B)).status).toBe(403);
        expect((await call("PATCH", `/routines/${shared.id}`, { version: 1, rotation: "none" }, B)).status).toBe(403);
        expect((await call("DELETE", `/routines/${shared.id}`, undefined, B)).status).toBe(403);
        // Stopping a routine keeps the task and its history.
        expect((await call("DELETE", `/routines/${shared.id}`)).status).toBe(200);
        expect(await count("SELECT COUNT(*) AS n FROM task_items WHERE id = ?", shared.task.id)).toBe(1);
        // Deleting the task removes the routine.
        await call("DELETE", `/tasks/${(await createRoutine({ title: "Temp", recurrence: weekly() })).task.id}`);
        expect(await count("SELECT COUNT(*) AS n FROM task_routines")).toBe(1);
    });
});

// --- Workload and timeline -----------------------------------------------------------------------

describe("workload", () => {
    it("groups the next weeks from a Monday, projects repeats, and counts what has no date", async () => {
        const t = today();
        const monday = weekStart(t);
        await createTask({ title: "This week", dueDate: addDays(monday, 6), priority: 1 });
        await createTask({ title: "Next week", dueDate: addDays(monday, 7) });
        await createTask({ title: "Too far", dueDate: addDays(monday, 14) });
        await createTask({ title: "Overdue", dueDate: addDays(t, -1) });
        await createTask({ title: "Someday" });
        await createTask({ title: "Weekly sport", dueDate: t, recurrence: weekly([1]) });
        const w = (await get<{ workload: Workload }>("/workload?weeks=2")).json.workload;
        expect(w).toMatchObject({ from: monday, to: addDays(monday, 13), weeks: 2 });
        const titles = w.tasks.map((x) => x.title);
        expect(titles).toContain("This week");
        expect(titles).toContain("Next week");
        expect(titles).not.toContain("Too far");
        expect(w.tasks.filter((x) => x.title === "Weekly sport").length).toBeGreaterThanOrEqual(1);
        expect(w.tasks.filter((x) => x.projected).every((x) => x.dueDate! > t)).toBe(true);
        expect(w.overdue.tasks.map((x) => x.title)).toEqual(["Overdue"]);
        expect(w.undated.tasks.map((x) => x.title)).toEqual(["Someday"]);
        expect(w.summary.nextWeek).toBeGreaterThanOrEqual(1);
        // Never before a Monday, at most four weeks, whatever is asked.
        const odd = (await get<{ workload: Workload }>(`/workload?weeks=40&from=${addDays(monday, 3)}`)).json.workload;
        expect(odd).toMatchObject({ from: monday, weeks: 4, to: addDays(monday, 27) });
        expect((await get<{ workload: Workload }>("/workload?from=garbage")).json.workload.from).toBe(monday);
    });

    it("shows shared workload by person without any personal tasks", async () => {
        const project = await sharedProject("editor", "Home");
        await createTask({ title: "Shared mow", projectId: project.id, dueDate: today(), assignee: B });
        await createTask({ title: "A's private errand", dueDate: today() });
        const w = (await get<{ workload: Workload }>("/workload?scope=shared")).json.workload;
        expect(w.tasks.map((x) => x.title)).toEqual(["Shared mow"]);
        expect(w.people.map((p) => p.email).sort()).toEqual([A, B].sort());
        expect(JSON.stringify(w)).not.toContain("private");
        const forB = (await get<{ workload: Workload }>("/workload?scope=shared", B)).json.workload;
        expect(forB.tasks.map((x) => x.title)).toEqual(["Shared mow"]);
    });

    it("keeps working across Sydney's daylight-saving change", async () => {
        // The first Sunday of October 2026 is the 4th: the week of 28 Sep–4 Oct has a 23-hour day.
        await call("PATCH", "/preferences", { timeZone: "Australia/Sydney" });
        const w = (await get<{ workload: Workload }>("/workload?from=2026-10-01&weeks=1")).json.workload;
        expect(w).toMatchObject({ from: "2026-09-28", to: "2026-10-04" });
    });
});

describe("project timeline", () => {
    it("orders start, milestones, deadlines, due tasks, repeats and reviews, bounded", async () => {
        const t = today();
        const project = await createProject({ name: "Move house", startDate: t, targetDate: addDays(t, 40) });
        await createTask({ title: "Sign lease", projectId: project.id, dueDate: addDays(t, 5), isMilestone: true });
        await createTask({ title: "Book truck", projectId: project.id, dueDate: addDays(t, 10), deadline: addDays(t, 12) });
        await createTask({ title: "Pack a box", projectId: project.id, dueDate: addDays(t, 1), recurrence: { freq: "daily", interval: 1 } });
        await createTask({ title: "Undated", projectId: project.id });
        const tl = (await get<{ timeline: ProjectTimeline }>(`/projects/${project.id}/timeline`)).json.timeline;
        const kinds = tl.items.map((i) => `${i.kind}:${i.label}`);
        expect(kinds[0]).toBe("start:Project starts");
        expect(kinds.at(-1)).toBe("target:Target date");
        expect(kinds).toContain("milestone:Sign lease");
        expect(kinds).toContain("deadline:Book truck");
        expect(kinds).not.toContain("due:Undated");
        // A daily repeat: the current occurrence and at most four later ones.
        expect(tl.items.filter((i) => i.label === "Pack a box")).toHaveLength(5);
        expect([...tl.items].map((i) => i.date)).toEqual([...tl.items].map((i) => i.date).sort());
    });
});

// --- Reports -------------------------------------------------------------------------------------

describe("reports", () => {
    const insertCompletion = (taskId: string, at: string, occurrence: string | null, by = A, kind = "completed") =>
        db()
            .prepare("INSERT INTO task_completions (task_id, kind, occurrence_date, next_date, at, by) VALUES (?, ?, ?, NULL, ?, ?)")
            .bind(taskId, kind, occurrence, at, by)
            .run();

    it("counts recorded completions by week, on time or late, never projected repeats", async () => {
        const t = today();
        const tz = "Australia/Sydney";
        const project = await createProject({ name: "Admin" });
        const task = await createTask({ title: "Invoices", projectId: project.id });
        const repeat = await createTask({ title: "Weekly review", dueDate: addDays(t, 1), recurrence: weekly([1, 2, 3, 4, 5, 6, 7]) });
        // Two weeks ago: one on time; last week: one late (done two days after its date) and one skip; an undone one never counts.
        await insertCompletion(task.id, zonedInstant(addDays(t, -14), "10:00", tz), addDays(t, -14));
        await insertCompletion(task.id, zonedInstant(addDays(t, -7), "10:00", tz), addDays(t, -9));
        await insertCompletion(repeat.id, zonedInstant(addDays(t, -7), "11:00", tz), addDays(t, -7), A, "skipped");
        await insertCompletion(repeat.id, zonedInstant(addDays(t, -6), "11:00", tz), addDays(t, -6));
        await db().prepare("UPDATE task_completions SET undone_at = 'x' WHERE id = (SELECT MAX(id) FROM task_completions)").run();
        // B's completion of their own task never appears in A's report.
        const theirs = await createTask({ title: "B's thing" }, B);
        await insertCompletion(theirs.id, zonedInstant(addDays(t, -2), "10:00", tz), null, B);

        const r = (await get<{ report: TasksReport }>("/reports?range=4w")).json.report;
        expect(r).toMatchObject({ scope: "personal", grouping: "week", from: addDays(t, -27), to: t, truncated: false });
        expect(r.totals).toMatchObject({ completed: 2, late: 1, skipped: 1 });
        expect(r.buckets.reduce((n, b) => n + b.completed, 0)).toBe(2);
        expect(r.buckets[0].start).toBe(weekStart(addDays(t, -27)));
        expect(r.buckets.every((b, i, all) => i === 0 || b.start === addDays(all[i - 1].start, 7))).toBe(true);
        expect(r.byProject).toEqual([expect.objectContaining({ name: "Admin", completed: 2 })]);
        expect(r.recurring).toEqual([expect.objectContaining({ title: "Weekly review", completed: 0, skipped: 1 })]);
        expect(r.openByPriority[4]).toBe(2);
        expect(JSON.stringify(r)).not.toContain("B's thing");
        // Longer ranges go by month.
        expect((await get<{ report: TasksReport }>("/reports?range=12m")).json.report.grouping).toBe("month");
        // Unknown ranges fall back to the default.
        expect((await get<{ report: TasksReport }>("/reports?range=forever")).json.report.range).toBe("12w");
    });

    it("reports shared work to members only, with nothing from personal projects", async () => {
        const project = await sharedProject("editor", "House");
        const shared = await createTask({ title: "Shared fix", projectId: project.id, assignee: B });
        await createTask({ title: "Open shared", projectId: project.id });
        await complete(shared.id, null, B);
        const mine = await createTask({ title: "A personal win" });
        await complete(mine.id, null);
        const r = (await get<{ report: TasksReport }>("/reports?scope=shared&range=4w")).json.report;
        expect(r.totals.completed).toBe(1);
        expect(r.byProject.map((p) => p.name)).toEqual(["House"]);
        expect(r.assigned).toEqual([expect.objectContaining({ email: null, open: 1 })]);
        expect(JSON.stringify(r)).not.toContain("personal win");
        expect((await get<{ report: TasksReport }>("/reports?scope=shared&range=4w", B)).json.report.totals.completed).toBe(1);
        await apiCall("POST", "/api/portal/users", { email: ADMIN, role: "admin" });
        expect((await get<{ report: TasksReport }>("/reports?scope=shared&range=4w", ADMIN)).json.report.totals.completed).toBe(0);
    });

    it("exports the report as CSV, safely", async () => {
        const project = await createProject({ name: '=HYPERLINK("evil")' });
        const task = await createTask({ title: "x", projectId: project.id });
        await complete(task.id, null);
        const response = await get("/reports/export?range=4w");
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("text/csv");
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        expect(response.text).toContain("section,key,label,completed");
        expect(response.text).toContain("'=HYPERLINK");
        expect(response.text).not.toMatch(/,=HYPERLINK/);
    });
});

// --- Everything needs Tasks ----------------------------------------------------------------------

describe("access to the new endpoints", () => {
    it("refuses people without Tasks and anyone from another site", async () => {
        await apiCall("POST", "/api/portal/users", { email: "wedding-editor@example.com", role: "editor" });
        for (const path of ["/dashboard", "/goals", "/routines", "/workload", "/reports", "/reports/export"])
            expect((await get(path, "wedding-editor@example.com")).status, path).toBe(403);
    });

    it("renders every new page, and 404s someone else's goal", async () => {
        const goal = await createGoal({ title: "Private goal" });
        const page = async (path: string, email = A) => raw(path, { token: await accessToken({ email }) });
        for (const path of [
            "/portal/tasks/dashboard",
            "/portal/tasks/dashboard?tab=household",
            "/portal/tasks/goals",
            `/portal/tasks/goals/${goal.goal.id}`,
            "/portal/tasks/routines",
            "/portal/tasks/workload",
            "/portal/tasks/workload?scope=shared",
            "/portal/tasks/reports",
            "/portal/tasks/reports?scope=shared&range=12m",
        ]) {
            const response = await page(path);
            expect(response.status, path).toBe(200);
        }
        const theirs = await page(`/portal/tasks/goals/${goal.goal.id}`, B);
        expect(theirs.status).toBe(404);
        expect(await theirs.text()).not.toContain("Private goal");
    });
});
