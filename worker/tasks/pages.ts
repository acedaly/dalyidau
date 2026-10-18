// First-render data for the Tasks pages (/portal/tasks/*). The portal page router has already
// checked the "tasks.use" permission; these check project membership. Anything the caller can't
// see returns null, which the router turns into the ordinary 404 page.
import type { PortalUser } from "../../src/shared/portal/types";
import { addDays } from "../../src/shared/tasks/dates";
import { EMPTY_FILTER, filterFromParams } from "../../src/shared/tasks/filters";
import {
    HOUSEHOLD_FILTERS,
    type HouseholdFilter,
    REPORT_RANGES,
    type ReportRange,
    WORKLOAD_GROUPS,
    type WorkloadGroup,
} from "../../src/shared/tasks/productivity";
import type { TasksRoute, TasksShell } from "../../src/shared/tasks/types";
import { UPCOMING_MODES, type UpcomingMode, mineFilter, upcomingWindow } from "../../src/shared/tasks/view-preferences";
import type { Env } from "../env";
import { can } from "../portal/auth";
import { HttpError } from "../portal/http";
import { ensureInbox, preferences, requireProject, requireTask, todayFor } from "./access";
import { listActivity } from "./activity";
import { getDashboardPreferences, householdDashboard, personalDashboard } from "./dashboard";
import { goalDetail, goalsForProject, listGoals } from "./goals";
import { measureProject } from "./health";
import { listImports } from "./import";
import { knowledgeReferences, projectKnowledgeReferences } from "./knowledge";
import { listLabels } from "./labels";
import { projectTimeline, workload } from "./planning";
import { assignableMembers, getProject, listMembers, listProjects, sectionsFor } from "./projects";
import { dueReminders } from "./reminders";
import { tasksReport } from "./reports";
import { draftFor, listReviews } from "./reviews";
import { listRoutines } from "./routines";
import { getView, listViewPreferences, listViews } from "./settings";
import { listTemplates } from "./templates";
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
    projectHighlights,
    searchTasks,
} from "./views";

export type TasksPage =
    | "home"
    | "templates"
    | "inbox"
    | "today"
    | "upcoming"
    | "overdue"
    | "mine"
    | "completed"
    | "projects"
    | "project"
    | "task"
    | "labels"
    | "filters"
    | "search"
    | "activity"
    | "settings"
    | "dashboard"
    | "goals"
    | "goal"
    | "routines"
    | "workload"
    | "reports";

/** Hidden behind 404: a project or task the caller isn't a member of. */
const visible = async <T>(load: () => Promise<T>): Promise<T | null> => {
    try {
        return await load();
    } catch (error) {
        if (error instanceof HttpError && (error.status === 404 || error.status === 403)) return null;
        throw error;
    }
};

/** What every Tasks page needs, and what Quick Add needs anywhere in the portal (GET /shell). */
export async function shell(env: Env, user: PortalUser): Promise<TasksShell> {
    const inboxId = await ensureInbox(env.DB, user.email);
    const prefs = await preferences(env.DB, user.email);
    const today = await todayFor(env.DB, user.email);
    const [projects, sections, assignable, labels, views, reminders, viewPreferences] = await Promise.all([
        listProjects(env.DB, user.email, today),
        sectionsFor(env.DB, user.email),
        assignableMembers(env.DB, user.email),
        listLabels(env.DB, user.email),
        listViews(env.DB, user.email),
        // Due now or within the hour; the page shows each one when its time comes.
        dueReminders(env.DB, user.email, new Date(Date.now() + 60 * 60_000)),
        listViewPreferences(env.DB, user.email),
    ]);
    return {
        today,
        preferences: prefs,
        inboxId,
        projects,
        sections,
        assignable,
        labels,
        views,
        reminders,
        canUseKnowledge: can(user, "knowledge.use"),
        viewPreferences,
    };
}

/** Upcoming's layout: from the URL if given, otherwise the person's last choice. */
export const upcomingMode = (param: string | null, saved: UpcomingMode | undefined): UpcomingMode =>
    UPCOMING_MODES.includes(param as UpcomingMode) ? (param as UpcomingMode) : (saved ?? "agenda");

export async function loadTasksPage(env: Env, user: PortalUser, url: URL, page: TasksPage, arg?: string): Promise<TasksRoute | null> {
    return visible(async (): Promise<TasksRoute> => {
        const s = await shell(env, user);
        // /portal/tasks opens the person's chosen first page.
        if (page === "home") page = s.preferences.landingPage;
        switch (page) {
            case "templates": {
                const [templates, archived] = await Promise.all([listTemplates(env.DB, user.email), listTemplates(env.DB, user.email, true)]);
                return { route: "tasks-templates", ...s, templates, archived };
            }
            case "inbox":
                return { route: "tasks-view", ...s, view: "inbox", tasks: await listInbox(env.DB, user.email, s.inboxId), progress: null };
            case "today": {
                const [tasks, done] = await Promise.all([
                    listToday(env.DB, user.email, s.today, s.preferences.todayPriority),
                    completedToday(env.DB, user.email, s.today, s.preferences.timeZone),
                ]);
                return { route: "tasks-view", ...s, view: "today", tasks, progress: { done } };
            }
            case "overdue":
                return { route: "tasks-view", ...s, view: "overdue", tasks: await listOverdue(env.DB, user.email, s.today), progress: null };
            case "upcoming": {
                const mode = upcomingMode(url.searchParams.get("mode"), s.viewPreferences.upcoming?.mode);
                const { from, days } = upcomingWindow(mode, url.searchParams.get("from"), s.today);
                const to = addDays(from, days - 1);
                // Overdue tasks come first, unless the window is already showing the days they're due on.
                const showsToday = from <= s.today && to >= s.today;
                const [tasks, overdue, deadlines, done] = await Promise.all([
                    listUpcoming(env.DB, user.email, from, to, s.today),
                    showsToday ? listOverdue(env.DB, user.email, s.today) : Promise.resolve([]),
                    mode === "agenda" ? Promise.resolve([]) : listDeadlines(env.DB, user.email, from, to),
                    mode === "agenda" ? Promise.resolve([]) : completedBetween(env.DB, user.email, from, to),
                ]);
                return {
                    route: "tasks-upcoming",
                    ...s,
                    mode,
                    from,
                    days,
                    tasks,
                    overdue: overdue.filter((t) => !!t.dueDate && t.dueDate < from),
                    deadlines,
                    done,
                };
            }
            case "mine": {
                const filter = mineFilter(s.viewPreferences.mine ?? {});
                const { tasks, hasMore } = await filterTasks(env.DB, user.email, filter, s.today, { limit: 100, offset: 0 });
                return { route: "tasks-mine", ...s, filter, tasks, hasMore };
            }
            case "completed": {
                const { entries, hasMore } = await listCompleted(env.DB, user.email, { limit: 50 });
                return { route: "tasks-completed", ...s, entries, hasMore };
            }
            case "projects": {
                const kind = url.searchParams.get("kind") === "shared" ? "shared" : "personal";
                return { route: "tasks-projects", ...s, kind, archived: s.projects.filter((p) => p.status === "archived") };
            }
            case "task": {
                // A link to one task opens its project with the task's panel open.
                const task = await requireTask(env.DB, user, arg!);
                return loadProject(env, user, url, s, task.project_id, task.id);
            }
            case "project":
                return loadProject(env, user, url, s, arg!, url.searchParams.get("task"));
            case "labels":
                return { route: "tasks-labels", ...s };
            case "filters": {
                const savedId = url.searchParams.get("saved");
                const savedView = savedId ? await getView(env.DB, user, savedId) : null;
                const filter = savedView?.definition ?? (url.search ? filterFromParams(url.searchParams) : EMPTY_FILTER);
                const { tasks, hasMore } = await filterTasks(env.DB, user.email, filter, s.today);
                return { route: "tasks-filters", ...s, filter, savedView, tasks, hasMore };
            }
            case "search": {
                const query = (url.searchParams.get("q") ?? "").slice(0, 300);
                const { tasks, projects } = await searchTasks(env.DB, user.email, query);
                return { route: "tasks-search", ...s, query, tasks, matchedProjects: projects };
            }
            case "activity": {
                const projectId = url.searchParams.get("project");
                if (projectId) await requireProject(env.DB, user, projectId);
                return { route: "tasks-activity", ...s, projectId, entries: await listActivity(env.DB, user.email, { projectId, limit: 50 }) };
            }
            case "settings":
                return { route: "tasks-settings", ...s, imports: await listImports(env.DB, user.email) };
            case "dashboard": {
                const saved = await getDashboardPreferences(env.DB, user.email);
                const param = url.searchParams.get("tab");
                const tab = param === "household" || param === "personal" ? param : (saved.tab ?? "personal");
                const filterParam = url.searchParams.get("filter") as HouseholdFilter | null;
                const filter = filterParam && HOUSEHOLD_FILTERS.includes(filterParam) ? filterParam : (saved.household ?? "all");
                return {
                    route: "tasks-dashboard",
                    ...s,
                    tab,
                    dashboardPreferences: saved,
                    personal: tab === "personal" ? await personalDashboard(env.DB, user) : null,
                    household: tab === "household" ? await householdDashboard(env.DB, user, filter) : null,
                };
            }
            case "goals": {
                const [goals, archived] = await Promise.all([
                    listGoals(env.DB, user.email, s.today),
                    listGoals(env.DB, user.email, s.today, { archived: true }),
                ]);
                return { route: "tasks-goals", ...s, goals, archived };
            }
            case "goal":
                return { route: "tasks-goal", ...s, detail: await goalDetail(env.DB, user, arg!) };
            case "routines":
                return { route: "tasks-routines", ...s, routines: await listRoutines(env.DB, user.email) };
            case "workload": {
                const groupParam = url.searchParams.get("group") as WorkloadGroup | null;
                return {
                    route: "tasks-workload",
                    ...s,
                    group: groupParam && WORKLOAD_GROUPS.includes(groupParam) ? groupParam : "day",
                    workload: await workload(env.DB, user, {
                        scope: url.searchParams.get("scope") === "shared" ? "shared" : "mine",
                        weeks: Number(url.searchParams.get("weeks") ?? 2),
                        from: url.searchParams.get("from"),
                    }),
                };
            }
            case "reports": {
                const rangeParam = url.searchParams.get("range") as ReportRange | null;
                const range = rangeParam && rangeParam in REPORT_RANGES ? rangeParam : "12w";
                const scope = url.searchParams.get("scope") === "shared" ? "shared" : "personal";
                return { route: "tasks-reports", ...s, range, report: await tasksReport(env.DB, user, scope, range) };
            }
        }
    });
}

async function loadProject(env: Env, user: PortalUser, url: URL, s: TasksShell, projectId: string, openTask: string | null): Promise<TasksRoute> {
    const project = await getProject(env.DB, user, projectId, s.today);
    const requested = url.searchParams.get("view");
    const tab = requested === "board" || requested === "overview" || requested === "list" || requested === "timeline" ? requested : project.defaultView;
    const [tasks, members] = await Promise.all([listProjectTasks(env.DB, user.email, project.id), listMembers(env.DB, project.id)]);
    let overview = null;
    if (tab === "overview") {
        const [highlights, activity] = await Promise.all([
            projectHighlights(env.DB, user.email, project.id),
            listActivity(env.DB, user.email, { projectId: project.id, limit: 10 }),
        ]);
        const references = await knowledgeReferences(
            env.DB,
            user,
            tasks.map((t) => t.id),
        );
        // Each object once, however many tasks link to it.
        const seen = new Set<string>();
        const knowledge = [...references.values()].flat().filter((r) => {
            const key = r.available ? r.objectId : r.linkId;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
        const [measured, projectKnowledge, draftReview, last, goals] = await Promise.all([
            project.isInbox ? null : measureProject(env.DB, user.email, project.id, s.today, s.preferences.timeZone),
            projectKnowledgeReferences(env.DB, user, project.id),
            project.isInbox ? null : draftFor(env.DB, user, project.id),
            project.isInbox ? null : listReviews(env.DB, user, project.id, null),
            goalsForProject(env.DB, user.email, project.id, s.today),
        ]);
        const latest = last?.reviews[0];
        overview = {
            ...highlights,
            activity,
            knowledge: knowledge.slice(0, 20),
            projectKnowledge,
            health: measured?.health ?? null,
            metrics: measured?.metrics ?? null,
            draftReview,
            lastReview: latest ? { id: latest.id, completedAt: latest.completedAt!, completedBy: latest.completedBy!, note: latest.note } : null,
            goals,
        };
    }
    const timeline = tab === "timeline" ? await projectTimeline(env.DB, user, project.id) : null;
    // An open-task id that isn't in this project (or isn't visible to the caller) is simply ignored.
    const task = openTask ? await visible(() => requireTask(env.DB, user, openTask)) : null;
    const open = task && task.project_id === project.id ? task.id : null;
    return { route: "tasks-project", ...s, project, tab, tasks, completedCount: project.counts.completed, members, overview, timeline, openTask: open };
}
