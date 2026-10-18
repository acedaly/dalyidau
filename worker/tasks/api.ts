// JSON API for Daly Tasks (/api/portal/tasks/*). By the time a request gets here the portal router
// has verified the Access identity, the portal role and the same-origin checks (CSRF). This router
// adds the "tasks.use" permission; each handler then checks the caller's membership of the project
// it touches (worker/tasks/access.ts).
import { z } from "zod";
import type { PortalUser } from "../../src/shared/portal/types";
import { addDays } from "../../src/shared/tasks/dates";
import { filterFromParams, taskFilter } from "../../src/shared/tasks/filters";
import { HOUSEHOLD_FILTERS, type HouseholdFilter, REPORT_RANGES, type ReportRange } from "../../src/shared/tasks/productivity";
import { upcomingWindow } from "../../src/shared/tasks/view-preferences";
import type { Env } from "../env";
import { can } from "../portal/auth";
import { HttpError, json, readJson } from "../portal/http";
import { ensureInbox, preferences, requireProject, requireTask, todayFor } from "./access";
import { listActivity } from "./activity";
import { addComment, deleteComment, editComment, listComments } from "./comments";
import { getDashboardPreferences, householdDashboard, personalDashboard, setDashboardPreferences } from "./dashboard";
import { exportCsv, exportTasks } from "./export";
import {
    addGoalMember,
    addMilestone,
    archiveGoal,
    createGoal,
    deleteGoal,
    deleteMilestone,
    goalDetail,
    linkGoal,
    listGoalMembers,
    listGoals,
    recordProgress,
    removeGoalMember,
    setGoalKind,
    unlinkGoal,
    updateGoal,
    updateGoalMember,
    updateMilestone,
} from "./goals";
import { measureProject, setProjectHealth } from "./health";
import { listImports, previewImport, runImport } from "./import";
import { linkKnowledge, linkProjectKnowledge, projectKnowledgeReferences, relatedForObject, unlinkKnowledge, unlinkProjectKnowledge } from "./knowledge";
import { createLabel, deleteLabel, listLabels, otherLabels, updateLabel } from "./labels";
import { shell, upcomingMode } from "./pages";
import { projectTimeline, workload } from "./planning";
import {
    addMember,
    createProject,
    createSection,
    deleteProject,
    deleteSection,
    getProject,
    listMembers,
    listProjects,
    moveProject,
    moveSection,
    removeMember,
    renameSection,
    sectionsFor,
    setProjectKind,
    updateMember,
    updateProject,
} from "./projects";
import { addReminder, deleteReminder, dismissReminder, dueReminders } from "./reminders";
import { reportCsv, tasksReport } from "./reports";
import { addReviewAction, completeReview, discardReview, draftFor, getReview, listReviews, startReview, updateReview } from "./reviews";
import { createRoutine, deleteRoutine, getRoutine, listRoutines, pauseRoutine, routineHistory, updateRoutine } from "./routines";
import { createView, deleteView, getView, listViewPreferences, listViews, setViewPreferences, updatePreferences, updateView } from "./settings";
import {
    OpenSubtasks,
    TaskConflict,
    bulkTasks,
    changeOccurrence,
    completeTask,
    createTask,
    deleteTask,
    duplicateTask,
    moveTask,
    reopenTask,
    taskDetail,
    updateTask,
} from "./tasks";
import { createTemplate, deleteTemplate, duplicateTemplate, getTemplate, listTemplates, templateFromTask, updateTemplate, useTemplate } from "./templates";
import {
    completedBetween,
    completedToday,
    filterTasks,
    listCompleted,
    listDeadlines,
    listInbox,
    listOverdue,
    listProjectTasks,
    listToday,
    listUpcoming,
    searchTasks,
} from "./views";

interface Ctx {
    env: Env;
    request: Request;
    url: URL;
    user: PortalUser;
    params: Record<string, string>;
}

type Handler = (ctx: Ctx) => Promise<Response>;
const routes: { method: string; pattern: RegExp; keys: string[]; handler: Handler }[] = [];
const add = (method: string, path: string, handler: Handler) => {
    const keys: string[] = [];
    const pattern = new RegExp(
        `^/api/portal/tasks${path.replace(/:([a-zA-Z]+)/g, (_, key: string) => {
            keys.push(key);
            return "([^/]+)";
        })}$`,
    );
    routes.push({ method, pattern, keys, handler });
};

const boundedInteger = (value: string | null, fallback: number, minimum: number, maximum: number) => {
    if (value === null || value.trim() === "") return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(Math.max(Math.trunc(parsed), minimum), maximum) : fallback;
};

// --- Lists ---------------------------------------------------------------------------------------

add("GET", "/lists/:view", async ({ env, url, user, params }) => {
    const prefs = await preferences(env.DB, user.email);
    const today = await todayFor(env.DB, user.email);
    switch (params.view) {
        case "inbox":
            return json({ tasks: await listInbox(env.DB, user.email, await ensureInbox(env.DB, user.email)) });
        case "today": {
            const [tasks, done] = await Promise.all([
                listToday(env.DB, user.email, today, prefs.todayPriority),
                completedToday(env.DB, user.email, today, prefs.timeZone),
            ]);
            return json({ today, tasks, progress: { done } });
        }
        case "overdue":
            return json({ today, tasks: await listOverdue(env.DB, user.email, today) });
        case "upcoming": {
            // The same window the page shows: an agenda, a week or a month, never before this week or month.
            const mode = upcomingMode(url.searchParams.get("mode"), "agenda");
            const window = upcomingWindow(mode, url.searchParams.get("from"), today);
            const from = window.from;
            // The agenda's length can be chosen, as in Milestone 1; weeks and months are fixed.
            const days = mode === "agenda" ? boundedInteger(url.searchParams.get("days"), window.days, 1, 62) : window.days;
            const to = addDays(from, days - 1);
            const [tasks, deadlines, done] = await Promise.all([
                listUpcoming(env.DB, user.email, from, to, today),
                mode === "agenda" ? [] : listDeadlines(env.DB, user.email, from, to),
                mode === "agenda" ? [] : completedBetween(env.DB, user.email, from, to),
            ]);
            return json({ today, mode, from, days, tasks, deadlines, done });
        }
        case "completed":
            return json(
                await listCompleted(env.DB, user.email, {
                    before: boundedInteger(url.searchParams.get("before"), 0, 0, Number.MAX_SAFE_INTEGER) || null,
                    projectId: url.searchParams.get("project"),
                }),
            );
    }
    throw new HttpError(404, "not_found", "Not found");
});

add("GET", "/filter", async ({ env, url, user }) => {
    const filter = filterFromParams(url.searchParams);
    const today = await todayFor(env.DB, user.email);
    return json(
        await filterTasks(env.DB, user.email, filter, today, {
            limit: boundedInteger(url.searchParams.get("limit"), 100, 1, 200),
            offset: boundedInteger(url.searchParams.get("offset"), 0, 0, 100_000),
        }),
    );
});

add("GET", "/search", async ({ env, url, user }) => json(await searchTasks(env.DB, user.email, (url.searchParams.get("q") ?? "").slice(0, 300))));

// --- Tasks ---------------------------------------------------------------------------------------

// 201 for a new task; 200 with the same task when a retry repeats a request that already created it.
add("POST", "/tasks", async ({ env, request, user }) => {
    const { task, replayed } = await createTask(env.DB, user, await readJson(request, 64_000));
    return json({ task, replayed }, replayed ? 200 : 201);
});
add("POST", "/tasks/bulk", async ({ env, request, user }) => json(await bulkTasks(env.DB, user, await readJson(request))));
add("GET", "/tasks/:id", async ({ env, user, params }) => json(await taskDetail(env.DB, user, await requireTask(env.DB, user, params.id))));
add("PATCH", "/tasks/:id", async ({ env, request, user, params }) =>
    json({ task: await updateTask(env.DB, user, params.id, await readJson(request, 64_000)) }),
);
add("DELETE", "/tasks/:id", async ({ env, user, params }) => {
    await deleteTask(env.DB, user, params.id);
    return json({ ok: true });
});
add("POST", "/tasks/:id/complete", async ({ env, request, user, params }) => json(await completeTask(env.DB, user, params.id, await readJson(request))));
add("POST", "/tasks/:id/skip", async ({ env, request, user, params }) => json(await completeTask(env.DB, user, params.id, await readJson(request), true)));
add("POST", "/tasks/:id/reopen", async ({ env, user, params }) => json({ task: await reopenTask(env.DB, user, params.id) }));
add("POST", "/tasks/:id/move", async ({ env, request, user, params }) => json({ task: await moveTask(env.DB, user, params.id, await readJson(request)) }));
add("POST", "/tasks/:id/duplicate", async ({ env, user, params }) => json({ task: await duplicateTask(env.DB, user, params.id) }, 201));
// One later occurrence of a repeating task: skip it, move it, or restore it.
add("POST", "/tasks/:id/occurrences", async ({ env, request, user, params }) =>
    json({ task: await changeOccurrence(env.DB, user, params.id, await readJson(request)) }),
);
add("POST", "/tasks/:id/template", async ({ env, request, user, params }) =>
    json({ template: await templateFromTask(env.DB, user, params.id, await readJson(request)) }, 201),
);

// --- Templates -----------------------------------------------------------------------------------

add("GET", "/templates", async ({ env, url, user }) => json({ templates: await listTemplates(env.DB, user.email, url.searchParams.get("archived") === "1") }));
add("POST", "/templates", async ({ env, request, user }) => json({ template: await createTemplate(env.DB, user, await readJson(request, 128_000)) }, 201));
add("GET", "/templates/:id", async ({ env, user, params }) => json({ template: await getTemplate(env.DB, user, params.id) }));
add("PATCH", "/templates/:id", async ({ env, request, user, params }) =>
    json({ template: await updateTemplate(env.DB, user, params.id, await readJson(request, 128_000)) }),
);
add("DELETE", "/templates/:id", async ({ env, user, params }) => {
    await deleteTemplate(env.DB, user, params.id);
    return json({ ok: true });
});
add("POST", "/templates/:id/duplicate", async ({ env, user, params }) => json({ template: await duplicateTemplate(env.DB, user, params.id) }, 201));
add("POST", "/templates/:id/use", async ({ env, request, user, params }) =>
    json({ task: await useTemplate(env.DB, user, params.id, await readJson(request)) }, 201),
);

// --- Import --------------------------------------------------------------------------------------

/** Up to 8 MB of CSV text per request (each file at most 2 MB). */
const IMPORT_BYTES = 8_000_000;
add("GET", "/import", async ({ env, user }) => json({ imports: await listImports(env.DB, user.email) }));
add("POST", "/import/todoist/preview", async ({ env, request, user }) => json(await previewImport(env.DB, user, await readJson(request, IMPORT_BYTES))));
add("POST", "/import/todoist/run", async ({ env, request, user }) => json(await runImport(env.DB, user, await readJson(request, IMPORT_BYTES))));

add("GET", "/tasks/:id/comments", async ({ env, user, params }) => json({ comments: await listComments(env.DB, user, params.id) }));
add("POST", "/tasks/:id/comments", async ({ env, request, user, params }) =>
    json({ comments: await addComment(env.DB, user, params.id, await readJson(request, 32_000)) }, 201),
);
add("PATCH", "/comments/:id", async ({ env, request, user, params }) =>
    json({ comments: await editComment(env.DB, user, params.id, await readJson(request, 32_000)) }),
);
add("DELETE", "/comments/:id", async ({ env, user, params }) => json({ comments: await deleteComment(env.DB, user, params.id) }));

add("POST", "/tasks/:id/knowledge", async ({ env, request, user, params }) =>
    json({ knowledge: await linkKnowledge(env.DB, user, params.id, await readJson(request)) }, 201),
);
add("DELETE", "/tasks/:id/knowledge/:link", async ({ env, user, params }) => json({ knowledge: await unlinkKnowledge(env.DB, user, params.id, params.link) }));
// Everything in Tasks related to a Knowledge object (its page's "Tasks" section): linked tasks and projects the caller can see.
add("GET", "/knowledge/:object", async ({ env, user, params }) => json(await relatedForObject(env.DB, user, params.object)));

add("POST", "/tasks/:id/reminders", async ({ env, request, user, params }) =>
    json({ reminders: await addReminder(env.DB, user, params.id, await readJson(request)) }, 201),
);
add("DELETE", "/reminders/:id", async ({ env, user, params }) => {
    await deleteReminder(env.DB, user, params.id);
    return json({ ok: true });
});
add("POST", "/reminders/:id/dismiss", async ({ env, user, params }) => {
    await dismissReminder(env.DB, user, params.id);
    return json({ ok: true });
});
add("GET", "/reminders/due", async ({ env, user }) => json({ reminders: await dueReminders(env.DB, user.email, new Date(Date.now() + 60 * 60_000)) }));

// --- Projects, members and sections --------------------------------------------------------------

add("GET", "/projects", async ({ env, user }) => {
    await ensureInbox(env.DB, user.email);
    return json({ projects: await listProjects(env.DB, user.email, await todayFor(env.DB, user.email)) });
});
add("POST", "/projects", async ({ env, request, user }) => {
    const { id } = await createProject(env.DB, user, await readJson(request));
    return json({ project: await getProject(env.DB, user, id, await todayFor(env.DB, user.email)) }, 201);
});
add("GET", "/projects/:id", async ({ env, user, params }) => {
    const today = await todayFor(env.DB, user.email);
    const project = await getProject(env.DB, user, params.id, today);
    const [tasks, members, sections] = await Promise.all([
        listProjectTasks(env.DB, user.email, project.id),
        listMembers(env.DB, project.id),
        sectionsFor(env.DB, user.email),
    ]);
    return json({ project, tasks, members, sections: sections[project.id] ?? [] });
});
add("GET", "/projects/:id/completed", async ({ env, user, params }) => {
    await requireProject(env.DB, user, params.id);
    return json({ tasks: await listProjectTasks(env.DB, user.email, params.id, "completed") });
});
add("PATCH", "/projects/:id", async ({ env, request, user, params }) => {
    await updateProject(env.DB, user, params.id, await readJson(request));
    return json({ project: await getProject(env.DB, user, params.id, await todayFor(env.DB, user.email)) });
});
add("POST", "/projects/:id/kind", async ({ env, request, user, params }) => {
    const { kind } = z
        .object({ kind: z.enum(["personal", "shared"]) })
        .strict()
        .parse(await readJson(request));
    await setProjectKind(env.DB, user, params.id, kind);
    return json({ project: await getProject(env.DB, user, params.id, await todayFor(env.DB, user.email)) });
});
add("POST", "/projects/:id/delete", async ({ env, request, user, params }) => {
    await deleteProject(env.DB, user, params.id, await readJson(request));
    return json({ ok: true });
});
add("POST", "/projects/:id/position", async ({ env, request, user, params }) => {
    await moveProject(env.DB, user, params.id, await readJson(request));
    return json({ ok: true });
});
add("GET", "/projects/:id/members", async ({ env, user, params }) => {
    await requireProject(env.DB, user, params.id);
    return json({ members: await listMembers(env.DB, params.id) });
});
add("POST", "/projects/:id/members", async ({ env, request, user, params }) => {
    await addMember(env, env.DB, user, params.id, await readJson(request));
    return json({ members: await listMembers(env.DB, params.id) }, 201);
});
add("PATCH", "/projects/:id/members/:email", async ({ env, request, user, params }) => {
    await updateMember(env.DB, user, params.id, params.email.toLowerCase(), await readJson(request));
    return json({ members: await listMembers(env.DB, params.id) });
});
add("DELETE", "/projects/:id/members/:email", async ({ env, user, params }) => {
    const email = params.email.toLowerCase();
    await removeMember(env.DB, user, params.id, email);
    // Someone who just left can no longer read the member list.
    return json(email === user.email ? { ok: true } : { members: await listMembers(env.DB, params.id) });
});
add("POST", "/projects/:id/sections", async ({ env, request, user, params }) =>
    json({ section: await createSection(env.DB, user, params.id, await readJson(request)) }, 201),
);
add("PATCH", "/sections/:id", async ({ env, request, user, params }) => {
    await renameSection(env.DB, user, params.id, await readJson(request));
    return json({ ok: true });
});
add("POST", "/sections/:id/position", async ({ env, request, user, params }) => {
    await moveSection(env.DB, user, params.id, await readJson(request));
    return json({ ok: true });
});
add("POST", "/sections/:id/delete", async ({ env, request, user, params }) => {
    await deleteSection(env.DB, user, params.id, await readJson(request));
    return json({ ok: true });
});

// --- Labels, filters, activity and preferences ---------------------------------------------------

add("GET", "/labels", async ({ env, user }) => json({ labels: await listLabels(env.DB, user.email), others: await otherLabels(env.DB, user.email) }));
add("POST", "/labels", async ({ env, request, user }) => {
    await createLabel(env.DB, user, await readJson(request));
    return json({ labels: await listLabels(env.DB, user.email) }, 201);
});
add("PATCH", "/labels/:id", async ({ env, request, user, params }) => {
    await updateLabel(env.DB, user, params.id, await readJson(request));
    return json({ labels: await listLabels(env.DB, user.email) });
});
add("DELETE", "/labels/:id", async ({ env, user, params }) => {
    await deleteLabel(env.DB, user, params.id);
    return json({ labels: await listLabels(env.DB, user.email) });
});

add("GET", "/filters", async ({ env, user }) => json({ views: await listViews(env.DB, user.email) }));
add("POST", "/filters", async ({ env, request, user }) => json({ view: await createView(env.DB, user, await readJson(request)) }, 201));
add("GET", "/filters/:id", async ({ env, user, params }) => {
    const view = await getView(env.DB, user, params.id);
    return json({ view, ...(await filterTasks(env.DB, user.email, view.definition, await todayFor(env.DB, user.email))) });
});
add("PATCH", "/filters/:id", async ({ env, request, user, params }) => json({ view: await updateView(env.DB, user, params.id, await readJson(request)) }));
add("DELETE", "/filters/:id", async ({ env, user, params }) => {
    await deleteView(env.DB, user, params.id);
    return json({ ok: true });
});
// Validates a definition without saving it, so the filter builder can show problems early.
add("POST", "/filters/validate", async ({ request }) => json({ definition: taskFilter.parse(await readJson(request)) }));

add("GET", "/activity", async ({ env, url, user }) => {
    const projectId = url.searchParams.get("project");
    if (projectId) await requireProject(env.DB, user, projectId);
    return json({
        entries: await listActivity(env.DB, user.email, {
            projectId,
            before: boundedInteger(url.searchParams.get("before"), 0, 0, Number.MAX_SAFE_INTEGER) || null,
            limit: 50,
        }),
    });
});

add("GET", "/preferences", async ({ env, user }) => json({ preferences: await preferences(env.DB, user.email) }));
add("GET", "/preferences/views", async ({ env, user }) => json({ views: await listViewPreferences(env.DB, user.email) }));
add("PUT", "/preferences/views/:view", async ({ env, request, user, params }) =>
    json({ preferences: await setViewPreferences(env.DB, user, params.view, await readJson(request)) }),
);

// Projects, sections, labels and people for Quick Add on pages outside Tasks.
add("GET", "/shell", async ({ env, user }) => json({ shell: await shell(env, user) }));
add("PATCH", "/preferences", async ({ env, request, user }) => json({ preferences: await updatePreferences(env.DB, user, await readJson(request)) }));

// --- Milestone 3: dashboard ----------------------------------------------------------------------

add("GET", "/dashboard", async ({ env, url, user }) => {
    const saved = await getDashboardPreferences(env.DB, user.email);
    const tab = url.searchParams.get("tab") === "household" ? "household" : url.searchParams.get("tab") === "personal" ? "personal" : (saved.tab ?? "personal");
    const param = url.searchParams.get("filter");
    const filter: HouseholdFilter = HOUSEHOLD_FILTERS.includes(param as HouseholdFilter) ? (param as HouseholdFilter) : (saved.household ?? "all");
    return json(
        tab === "household"
            ? { tab, preferences: saved, household: await householdDashboard(env.DB, user, filter) }
            : { tab, preferences: saved, personal: await personalDashboard(env.DB, user) },
    );
});
add("PUT", "/preferences/dashboard", async ({ env, request, user }) =>
    json({ preferences: await setDashboardPreferences(env.DB, user.email, await readJson(request)) }),
);

// --- Milestone 3: project health, reviews, Knowledge and timeline --------------------------------

add("GET", "/projects/:id/health", async ({ env, user, params }) => {
    await requireProject(env.DB, user, params.id);
    const prefs = await preferences(env.DB, user.email);
    const measured = await measureProject(env.DB, user.email, params.id, await todayFor(env.DB, user.email), prefs.timeZone);
    return json({ health: measured!.health, metrics: measured!.metrics, draft: await draftFor(env.DB, user, params.id) });
});
add("PATCH", "/projects/:id/health", async ({ env, request, user, params }) => {
    await setProjectHealth(env.DB, user, params.id, await readJson(request));
    const prefs = await preferences(env.DB, user.email);
    const measured = await measureProject(env.DB, user.email, params.id, await todayFor(env.DB, user.email), prefs.timeZone);
    return json({ health: measured!.health, metrics: measured!.metrics });
});
add("GET", "/projects/:id/timeline", async ({ env, user, params }) => json({ timeline: await projectTimeline(env.DB, user, params.id) }));
add("GET", "/projects/:id/knowledge", async ({ env, user, params }) => {
    await requireProject(env.DB, user, params.id);
    return json({ knowledge: await projectKnowledgeReferences(env.DB, user, params.id) });
});
add("POST", "/projects/:id/knowledge", async ({ env, request, user, params }) =>
    json({ knowledge: await linkProjectKnowledge(env.DB, user, params.id, await readJson(request)) }, 201),
);
add("DELETE", "/projects/:id/knowledge/:link", async ({ env, user, params }) =>
    json({ knowledge: await unlinkProjectKnowledge(env.DB, user, params.id, params.link) }),
);
add("POST", "/projects/:id/reviews", async ({ env, user, params }) => json(await startReview(env.DB, user, params.id), 201));
add("GET", "/projects/:id/reviews", async ({ env, url, user, params }) => json(await listReviews(env.DB, user, params.id, url.searchParams.get("before"))));
add("GET", "/reviews/:id", async ({ env, user, params }) => json(await getReview(env.DB, user, params.id)));
add("PATCH", "/reviews/:id", async ({ env, request, user, params }) => json({ review: await updateReview(env.DB, user, params.id, await readJson(request)) }));
add("POST", "/reviews/:id/complete", async ({ env, request, user, params }) =>
    json({ review: await completeReview(env.DB, user, params.id, await readJson(request)) }),
);
add("POST", "/reviews/:id/discard", async ({ env, user, params }) => {
    await discardReview(env.DB, user, params.id);
    return json({ ok: true });
});
add("POST", "/reviews/:id/actions", async ({ env, request, user, params }) =>
    json({ review: await addReviewAction(env.DB, user, params.id, await readJson(request, 64_000)) }, 201),
);

// --- Milestone 3: goals --------------------------------------------------------------------------

add("GET", "/goals", async ({ env, url, user }) =>
    json({ goals: await listGoals(env.DB, user.email, await todayFor(env.DB, user.email), { archived: url.searchParams.get("archived") === "1" }) }),
);
add("POST", "/goals", async ({ env, request, user }) => {
    const id = await createGoal(env.DB, user, await readJson(request));
    return json(await goalDetail(env.DB, user, id), 201);
});
add("GET", "/goals/:id", async ({ env, user, params }) => json(await goalDetail(env.DB, user, params.id)));
add("PATCH", "/goals/:id", async ({ env, request, user, params }) => {
    await updateGoal(env.DB, user, params.id, await readJson(request));
    return json(await goalDetail(env.DB, user, params.id));
});
add("POST", "/goals/:id/progress", async ({ env, request, user, params }) => {
    await recordProgress(env.DB, user, params.id, await readJson(request));
    return json(await goalDetail(env.DB, user, params.id));
});
add("POST", "/goals/:id/archive", async ({ env, request, user, params }) => {
    await archiveGoal(env.DB, user, params.id, await readJson(request));
    return json(await goalDetail(env.DB, user, params.id));
});
add("POST", "/goals/:id/delete", async ({ env, request, user, params }) => {
    await deleteGoal(env.DB, user, params.id, await readJson(request));
    return json({ ok: true });
});
add("POST", "/goals/:id/kind", async ({ env, request, user, params }) => {
    await setGoalKind(env.DB, user, params.id, await readJson(request));
    return json(await goalDetail(env.DB, user, params.id));
});
add("GET", "/goals/:id/members", async ({ env, user, params }) => {
    await goalDetail(env.DB, user, params.id);
    return json({ members: await listGoalMembers(env.DB, params.id) });
});
add("POST", "/goals/:id/members", async ({ env, request, user, params }) => {
    await addGoalMember(env, env.DB, user, params.id, await readJson(request));
    return json({ members: await listGoalMembers(env.DB, params.id) }, 201);
});
add("PATCH", "/goals/:id/members/:email", async ({ env, request, user, params }) => {
    await updateGoalMember(env.DB, user, params.id, params.email.toLowerCase(), await readJson(request));
    return json({ members: await listGoalMembers(env.DB, params.id) });
});
add("DELETE", "/goals/:id/members/:email", async ({ env, user, params }) => {
    const email = params.email.toLowerCase();
    await removeGoalMember(env.DB, user, params.id, email);
    return json(email === user.email ? { ok: true } : { members: await listGoalMembers(env.DB, params.id) });
});
add("POST", "/goals/:id/links", async ({ env, request, user, params }) => {
    await linkGoal(env.DB, user, params.id, await readJson(request));
    return json(await goalDetail(env.DB, user, params.id), 201);
});
add("DELETE", "/goals/:id/links/:link", async ({ env, user, params }) => {
    await unlinkGoal(env.DB, user, params.id, params.link);
    return json(await goalDetail(env.DB, user, params.id));
});
add("POST", "/goals/:id/milestones", async ({ env, request, user, params }) => {
    await addMilestone(env.DB, user, params.id, await readJson(request));
    return json(await goalDetail(env.DB, user, params.id), 201);
});
add("PATCH", "/goal-milestones/:id", async ({ env, request, user, params }) => {
    await updateMilestone(env.DB, user, params.id, await readJson(request));
    return json({ ok: true });
});
add("DELETE", "/goal-milestones/:id", async ({ env, user, params }) => {
    await deleteMilestone(env.DB, user, params.id);
    return json({ ok: true });
});

// --- Milestone 3: routines -----------------------------------------------------------------------

add("GET", "/routines", async ({ env, url, user }) => {
    const scope = url.searchParams.get("scope");
    return json({ routines: await listRoutines(env.DB, user.email, { scope: scope === "personal" || scope === "shared" ? scope : undefined }) });
});
add("POST", "/routines", async ({ env, request, user }) => json({ routine: await createRoutine(env.DB, user, await readJson(request, 64_000)) }, 201));
add("GET", "/routines/:id", async ({ env, user, params }) => json({ routine: await getRoutine(env.DB, user, params.id) }));
add("PATCH", "/routines/:id", async ({ env, request, user, params }) =>
    json({ routine: await updateRoutine(env.DB, user, params.id, await readJson(request)) }),
);
add("DELETE", "/routines/:id", async ({ env, user, params }) => {
    await deleteRoutine(env.DB, user, params.id);
    return json({ ok: true });
});
add("POST", "/routines/:id/pause", async ({ env, request, user, params }) =>
    json({ routine: await pauseRoutine(env.DB, user, params.id, await readJson(request)) }),
);
add("GET", "/routines/:id/history", async ({ env, url, user, params }) =>
    json(await routineHistory(env.DB, user, params.id, boundedInteger(url.searchParams.get("before"), 0, 0, Number.MAX_SAFE_INTEGER) || null)),
);

// --- Milestone 3: workload and reports -----------------------------------------------------------

add("GET", "/workload", async ({ env, url, user }) =>
    json({
        workload: await workload(env.DB, user, {
            scope: url.searchParams.get("scope") === "shared" ? "shared" : "mine",
            weeks: boundedInteger(url.searchParams.get("weeks"), 2, 1, 4),
            from: url.searchParams.get("from"),
        }),
    }),
);
const reportParams = (url: URL) => ({
    scope: url.searchParams.get("scope") === "shared" ? ("shared" as const) : ("personal" as const),
    range: (Object.keys(REPORT_RANGES).includes(url.searchParams.get("range") ?? "") ? url.searchParams.get("range") : "12w") as ReportRange,
});
add("GET", "/reports", async ({ env, url, user }) => {
    const { scope, range } = reportParams(url);
    return json({ report: await tasksReport(env.DB, user, scope, range) });
});

// --- Export --------------------------------------------------------------------------------------

/** Exports are private downloads: never cached, never rendered, never sniffed. */
const download = (body: BodyInit, type: string, filename: string) =>
    new Response(body, {
        headers: {
            "Content-Type": type,
            "Content-Disposition": `attachment; filename="${filename}"`,
            "Cache-Control": "private, no-store",
            "Content-Security-Policy": "default-src 'none'; sandbox",
            "X-Content-Type-Options": "nosniff",
            "X-Robots-Tag": "noindex",
        },
    });

add("GET", "/export", async ({ env, url, user }) => {
    const scope = url.searchParams.get("scope") === "personal" ? "personal" : "all";
    const data = await exportTasks(env.DB, user, scope);
    const stem = `daly-tasks-${data.exportedAt.slice(0, 10)}`;
    return url.searchParams.get("format") === "csv"
        ? download(exportCsv(data), "text/csv; charset=utf-8", `${stem}.csv`)
        : download(JSON.stringify(data, null, 2), "application/json; charset=utf-8", `${stem}.json`);
});

add("GET", "/reports/export", async ({ env, url, user }) => {
    const { scope, range } = reportParams(url);
    const report = await tasksReport(env.DB, user, scope, range);
    return download(reportCsv(report), "text/csv; charset=utf-8", `daly-tasks-report-${scope}-${report.to}.csv`);
});

// --- Dispatch ------------------------------------------------------------------------------------

export async function handleTasksApi(request: Request, env: Env, user: PortalUser): Promise<Response> {
    if (!can(user, "tasks.use")) throw new HttpError(403, "forbidden", "You don't have access to Tasks");
    const url = new URL(request.url);
    const method = request.method === "HEAD" ? "GET" : request.method;
    let pathMatched = false;
    for (const route of routes) {
        const match = route.pattern.exec(url.pathname);
        if (!match) continue;
        pathMatched = true;
        if (route.method !== method) continue;
        const params = Object.fromEntries(route.keys.map((key, i) => [key, decodeURIComponent(match[i + 1])]));
        try {
            return await route.handler({ env, request, url, user, params });
        } catch (error) {
            // The browser needs the current task to offer a way forward, and the count to ask about subtasks.
            if (error instanceof TaskConflict) return json({ error: error.code, message: error.message, current: error.current }, 409);
            if (error instanceof OpenSubtasks) return json({ error: error.code, message: error.message, count: error.count }, 409);
            throw error;
        }
    }
    if (pathMatched) throw new HttpError(405, "method_not_allowed", "Method not allowed");
    throw new HttpError(404, "not_found", "Not found");
}
