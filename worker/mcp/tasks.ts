// Daly Tasks tools for the MCP gateway. Each one calls the same functions the portal's own API
// does (worker/tasks), so project membership, archived-project rules, recurrence, conflicts and
// retry-safe creation behave exactly as they do in the browser. Nothing here touches the database
// except through those functions, apart from the read-only project-name lookup in shared.ts.
//
// Deliberately absent: deleting tasks or projects, bulk changes, moving tasks between projects,
// membership and sharing changes, imports and templates. Those stay in the portal, where a person
// makes them directly.
import { z } from "zod";
import { addDays } from "../../src/shared/tasks/dates";
import { ASSIGNEE_FILTERS, DEADLINE_FILTERS, DUE_FILTERS, SCOPE_FILTERS, SORTS, STATUS_FILTERS, taskFilter } from "../../src/shared/tasks/filters";
import { recurrenceInput } from "../../src/shared/tasks/recurrence";
import type { TaskProject, TaskSummary } from "../../src/shared/tasks/types";
import { ensureInbox, preferences, requireTask, todayFor } from "../tasks/access";
import { addComment } from "../tasks/comments";
import { goalDetail, goalsForProject, listGoals } from "../tasks/goals";
import { measureProject } from "../tasks/health";
import { linkKnowledge, projectKnowledgeReferences } from "../tasks/knowledge";
import { getProject, listProjects } from "../tasks/projects";
import { listRoutines } from "../tasks/routines";
import { completeTask, createTask, reopenTask, taskDetail, taskSummary, updateTask } from "../tasks/tasks";
import {
    completedToday,
    filterTasks,
    listDeadlines,
    listOverdue,
    listProjectTasks,
    listToday,
    listUpcoming,
    projectHighlights,
    searchTasks,
} from "../tasks/views";
import { type ToolContext, type ToolDef, bounded, calendarDate, id, limit, portalUrl, projectNames, requestId, taskList, taskOut, tool } from "./shared";

const taskId = id("tsk", "task");
const projectId = id("tpj", "project");
const clockTime = z.string().regex(/^\d{2}:\d{2}$/, "Use a time like 09:30");
const priority = z.number().int().min(1).max(4);
const scope = z.enum(["occurrence", "series"]).optional();

const projectOut = (ctx: ToolContext, p: TaskProject) => ({
    id: p.id,
    name: p.isInbox ? "Inbox" : p.name,
    kind: p.kind,
    isInbox: p.isInbox,
    status: p.status,
    role: p.role,
    startDate: p.startDate,
    targetDate: p.targetDate,
    counts: p.counts,
    memberCount: p.memberCount,
    url: portalUrl(ctx, `/portal/tasks/p/${p.id}`),
});

/** One task as it is now, for write results and replays. */
async function currentTask(ctx: ToolContext, id: string) {
    const task = await taskSummary(ctx.db, id);
    if (!task) return { task: null };
    return { task: taskOut(ctx, task, await projectNames(ctx, [task])) };
}

const replayTask = async (ctx: ToolContext, outcome: { entityId: string }) => {
    // Still subject to membership: someone removed from the project since gets nothing back.
    await requireTask(ctx.db, ctx.user, outcome.entityId);
    return { data: { ...(await currentTask(ctx, outcome.entityId)), replayed: true } };
};

const written = async (ctx: ToolContext, task: TaskSummary, extra: Record<string, unknown> = {}) => ({
    data: { task: taskOut(ctx, task, await projectNames(ctx, [task])), ...extra },
    outcome: { entityType: "task" as const, entityId: task.id },
});

// --- Reads ---------------------------------------------------------------------------------------

const tasksList = tool({
    name: "tasks_list",
    write: false,
    permission: "tasks.use",
    input: z
        .object({
            projectIds: z.array(projectId).max(20).default([]),
            priorities: z.array(priority).max(4).default([]),
            labels: z.array(z.string().trim().min(1).max(60)).max(10).default([]),
            due: z.enum(DUE_FILTERS).default("any"),
            deadline: z.enum(DEADLINE_FILTERS).default("any"),
            assignee: z.enum(ASSIGNEE_FILTERS).default("anyone"),
            status: z.enum(STATUS_FILTERS).default("open"),
            scope: z.enum(SCOPE_FILTERS).default("all"),
            text: z.string().trim().max(200).default(""),
            sort: z.enum(SORTS).default("due"),
            limit: limit(50, 100),
            offset: z.number().int().min(0).max(10_000).default(0),
        })
        .strict(),
    run: async (ctx, input) => {
        const { limit: max, offset, ...rest } = input;
        const filter = taskFilter.parse(rest);
        const today = await todayFor(ctx.db, ctx.user.email);
        const result = await filterTasks(ctx.db, ctx.user.email, filter, today, { limit: max, offset });
        const list = await taskList(ctx, result.tasks, max);
        return { data: { today, ...list, hasMore: result.hasMore, nextOffset: result.hasMore ? offset + max : null } };
    },
});

const tasksGet = tool({
    name: "tasks_get",
    write: false,
    permission: "tasks.use",
    input: z.object({ taskId }).strict(),
    run: async (ctx, { taskId }) => {
        const detail = await taskDetail(ctx.db, ctx.user, await requireTask(ctx.db, ctx.user, taskId));
        const names = new Map([[detail.project.id, detail.project.isInbox ? "Inbox" : detail.project.name]]);
        return {
            data: {
                task: { ...taskOut(ctx, detail.task, names), description: detail.task.description.slice(0, 10_000), recurrence: detail.task.recurrence },
                project: { id: detail.project.id, name: names.get(detail.project.id), kind: detail.project.kind, role: detail.project.role },
                parent: detail.parent,
                subtasks: detail.subtasks.slice(0, 50).map((t) => taskOut(ctx, t, names)),
                comments: detail.comments.slice(-20).map((c) => ({ id: c.id, author: c.author, body: c.body, createdAt: c.createdAt })),
                // Already filtered by the caller's own Knowledge membership: an object they can't read is just "unavailable".
                knowledge: detail.knowledge.map((k) =>
                    k.available
                        ? {
                              available: true,
                              objectId: k.objectId,
                              title: k.title,
                              spaceName: k.spaceName,
                              url: portalUrl(ctx, `/portal/knowledge/o/${k.objectId}`),
                          }
                        : { available: false },
                ),
                completions: detail.completions
                    .slice(0, 10)
                    .map((c) => ({ kind: c.kind, occurrenceDate: c.occurrenceDate, at: c.at, by: c.by, undone: !!c.undoneAt })),
            },
        };
    },
});

const tasksToday = tool({
    name: "tasks_today",
    write: false,
    permission: "tasks.use",
    input: z.object({ limit: limit(50, 100) }).strict(),
    run: async (ctx, { limit: max }) => {
        const prefs = await preferences(ctx.db, ctx.user.email);
        const today = await todayFor(ctx.db, ctx.user.email);
        const [tasks, done] = await Promise.all([
            listToday(ctx.db, ctx.user.email, today, prefs.todayPriority),
            completedToday(ctx.db, ctx.user.email, today, prefs.timeZone),
        ]);
        return { data: { today, timeZone: prefs.timeZone, completedToday: done, ...(await taskList(ctx, tasks, max)) } };
    },
});

const tasksUpcoming = tool({
    name: "tasks_upcoming",
    write: false,
    permission: "tasks.use",
    input: z.object({ from: calendarDate.optional(), days: z.number().int().min(1).max(31).default(7), limit: limit(100, 200) }).strict(),
    run: async (ctx, input) => {
        const today = await todayFor(ctx.db, ctx.user.email);
        const from = input.from && input.from > today ? input.from : today;
        const to = addDays(from, input.days - 1);
        const [tasks, deadlines] = await Promise.all([listUpcoming(ctx.db, ctx.user.email, from, to, today), listDeadlines(ctx.db, ctx.user.email, from, to)]);
        return { data: { today, from, to, ...(await taskList(ctx, tasks, input.limit)), deadlines: (await taskList(ctx, deadlines, 50)).tasks } };
    },
});

const tasksOverdue = tool({
    name: "tasks_overdue",
    write: false,
    permission: "tasks.use",
    input: z.object({ limit: limit(50, 100) }).strict(),
    run: async (ctx, { limit: max }) => {
        const today = await todayFor(ctx.db, ctx.user.email);
        return { data: { today, ...(await taskList(ctx, await listOverdue(ctx.db, ctx.user.email, today), max)) } };
    },
});

const tasksSearch = tool({
    name: "tasks_search",
    write: false,
    permission: "tasks.use",
    input: z.object({ query: z.string().trim().min(1).max(200), limit: limit(25, 50) }).strict(),
    run: async (ctx, input) => {
        const found = await searchTasks(ctx.db, ctx.user.email, input.query, input.limit + 1);
        return {
            data: {
                ...(await taskList(ctx, found.tasks, input.limit)),
                projects: found.projects.map((p) => ({ ...p, url: portalUrl(ctx, `/portal/tasks/p/${p.id}`) })),
            },
        };
    },
});

const tasksListProjects = tool({
    name: "tasks_list_projects",
    write: false,
    permission: "tasks.use",
    input: z.object({ includeArchived: z.boolean().default(false), kind: z.enum(["personal", "shared"]).optional() }).strict(),
    run: async (ctx, input) => {
        await ensureInbox(ctx.db, ctx.user.email);
        const projects = (await listProjects(ctx.db, ctx.user.email, await todayFor(ctx.db, ctx.user.email))).filter(
            (p) => (input.includeArchived || p.status !== "archived") && (!input.kind || p.kind === input.kind),
        );
        const cut = bounded(projects, 100);
        return { data: { projects: cut.items.map((p) => projectOut(ctx, p)), count: cut.count, truncated: cut.truncated } };
    },
});

const tasksProjectSummary = tool({
    name: "tasks_project_summary",
    write: false,
    permission: "tasks.use",
    input: z.object({ projectId }).strict(),
    run: async (ctx, { projectId }) => {
        const email = ctx.user.email;
        const today = await todayFor(ctx.db, email);
        const prefs = await preferences(ctx.db, email);
        const project = await getProject(ctx.db, ctx.user, projectId, today);
        const [measured, highlights, open, goals, knowledge] = await Promise.all([
            measureProject(ctx.db, email, project.id, today, prefs.timeZone),
            projectHighlights(ctx.db, email, project.id),
            listProjectTasks(ctx.db, email, project.id),
            goalsForProject(ctx.db, email, project.id, today),
            projectKnowledgeReferences(ctx.db, ctx.user, project.id),
        ]);
        const overdue = open.filter((t) => (t.dueDate && t.dueDate < today) || (t.deadline && t.deadline < today));
        const upcoming = open.filter((t) => t.dueDate && t.dueDate >= today && t.dueDate <= addDays(today, 14));
        return {
            data: {
                today,
                project: projectOut(ctx, project),
                health: measured
                    ? { status: measured.health.status, reasons: measured.health.reasons.map((r) => r.text), review: measured.metrics.review }
                    : null,
                overdue: await taskList(ctx, overdue, 20),
                upcoming14Days: await taskList(ctx, upcoming, 20),
                upcomingDeadlines: (await taskList(ctx, highlights.upcomingDeadlines, 10)).tasks,
                milestones: (await taskList(ctx, highlights.milestones, 20)).tasks,
                openTasks: await taskList(
                    ctx,
                    open.filter((t) => t.parentId === null),
                    25,
                ),
                goals: goals.map((g) => ({
                    id: g.id,
                    title: g.title,
                    status: g.status,
                    targetDate: g.targetDate,
                    url: portalUrl(ctx, `/portal/tasks/goals/${g.id}`),
                })),
                knowledge: knowledge.map((k) =>
                    k.available ? { available: true, objectId: k.objectId, title: k.title, spaceName: k.spaceName } : { available: false },
                ),
            },
        };
    },
});

const tasksListGoals = tool({
    name: "tasks_list_goals",
    write: false,
    permission: "tasks.use",
    input: z.object({ kind: z.enum(["personal", "shared"]).optional(), activeOnly: z.boolean().default(true) }).strict(),
    run: async (ctx, input) => {
        const today = await todayFor(ctx.db, ctx.user.email);
        const goals = await listGoals(ctx.db, ctx.user.email, today, { kind: input.kind, activeOnly: input.activeOnly });
        const cut = bounded(goals, 50);
        return {
            data: {
                today,
                goals: cut.items.map((g) => ({
                    id: g.id,
                    title: g.title,
                    kind: g.kind,
                    status: g.status,
                    targetDate: g.targetDate,
                    progress: g.progress,
                    milestones: { done: g.milestones.done, total: g.milestones.total, next: g.milestones.next },
                    attention: g.attention,
                    url: portalUrl(ctx, `/portal/tasks/goals/${g.id}`),
                })),
                count: cut.count,
                truncated: cut.truncated,
            },
        };
    },
});

const tasksGetGoal = tool({
    name: "tasks_get_goal",
    write: false,
    permission: "tasks.use",
    input: z.object({ goalId: id("tgl", "goal") }).strict(),
    run: async (ctx, { goalId }) => {
        const detail = await goalDetail(ctx.db, ctx.user, goalId);
        const names = await projectNames(ctx, [...detail.tasks, ...detail.next]);
        return {
            data: {
                goal: { ...detail.goal, description: detail.goal.description.slice(0, 4_000), url: portalUrl(ctx, `/portal/tasks/goals/${detail.goal.id}`) },
                milestones: detail.milestones.slice(0, 30),
                recentProgress: detail.history.slice(0, 10),
                projects: detail.projects.map((p) => ({ id: p.id, name: p.name, kind: p.kind, open: p.open, completed: p.completed })),
                next: detail.next.slice(0, 10).map((t) => taskOut(ctx, t, names)),
                knowledge: detail.knowledge.map((k) =>
                    k.available ? { available: true, objectId: k.objectId, title: k.title, spaceName: k.spaceName } : { available: false },
                ),
            },
        };
    },
});

const tasksListRoutines = tool({
    name: "tasks_list_routines",
    write: false,
    permission: "tasks.use",
    input: z
        .object({
            scope: z.enum(["personal", "shared"]).optional(),
            dueWithinDays: z.number().int().min(0).max(31).optional(),
            mineOnly: z.boolean().default(false),
            includePaused: z.boolean().default(false),
        })
        .strict(),
    run: async (ctx, input) => {
        const today = await todayFor(ctx.db, ctx.user.email);
        const routines = await listRoutines(ctx.db, ctx.user.email, {
            scope: input.scope,
            dueBy: input.dueWithinDays === undefined ? undefined : addDays(today, input.dueWithinDays),
            includePaused: input.includePaused,
            mineOnly: input.mineOnly,
            limit: 50,
        });
        const names = await projectNames(
            ctx,
            routines.map((r) => r.task),
        );
        return {
            data: {
                today,
                routines: routines.map((r) => ({
                    id: r.id,
                    task: taskOut(ctx, r.task, names),
                    rotation: r.rotation,
                    responsible: r.responsible,
                    nextUp: r.nextUp,
                    paused: r.paused,
                    recent: r.recent.slice(0, 3),
                })),
                count: routines.length,
            },
        };
    },
});

// --- Writes --------------------------------------------------------------------------------------

const tasksCreate = tool({
    name: "tasks_create",
    write: true,
    permission: "tasks.use",
    input: z
        .object({
            title: z.string().min(1).max(500),
            description: z.string().max(10_000).optional(),
            projectId: projectId.optional(),
            sectionId: id("tsc", "section").optional(),
            parentId: taskId.optional(),
            priority: priority.optional(),
            dueDate: calendarDate.optional(),
            dueTime: clockTime.optional(),
            deadline: calendarDate.optional(),
            recurrence: recurrenceInput.optional(),
            labels: z.array(z.string().max(60)).max(20).optional(),
            assignee: z.string().max(254).optional(),
            isMilestone: z.boolean().optional(),
            knowledgeObjectIds: z.array(id("kob", "Knowledge object")).max(5).optional(),
            requestId,
        })
        .strict(),
    run: async (ctx, { requestId, knowledgeObjectIds, ...fields }) => {
        // The Tasks engine's own retry protection (clientId) backs up the ledger's.
        const { task, replayed } = await createTask(ctx.db, ctx.user, {
            ...fields,
            ...(requestId ? { clientId: requestId } : {}),
            knowledge: knowledgeObjectIds ?? [],
        });
        return written(ctx, task, { replayed });
    },
    replay: replayTask,
});

const tasksUpdate = tool({
    name: "tasks_update",
    write: true,
    permission: "tasks.use",
    input: z
        .object({
            taskId,
            version: z.number().int().min(1),
            title: z.string().min(1).max(500).optional(),
            description: z.string().max(10_000).optional(),
            priority: priority.optional(),
            dueDate: calendarDate.nullable().optional(),
            dueTime: clockTime.nullable().optional(),
            deadline: calendarDate.nullable().optional(),
            recurrence: recurrenceInput.nullable().optional(),
            labels: z.array(z.string().max(60)).max(20).optional(),
            assignee: z.string().max(254).nullable().optional(),
            isMilestone: z.boolean().optional(),
            scope,
            requestId,
        })
        .strict(),
    run: async (ctx, { taskId, requestId: _, ...changes }) => written(ctx, await updateTask(ctx.db, ctx.user, taskId, changes)),
    replay: replayTask,
});

const tasksReschedule = tool({
    name: "tasks_reschedule",
    write: true,
    permission: "tasks.use",
    input: z
        .object({
            taskId,
            dueDate: calendarDate.nullable(),
            dueTime: clockTime.nullable().optional(),
            /** Optional: when given, the change is refused if the task changed since that version. */
            version: z.number().int().min(1).optional(),
            scope,
            requestId,
        })
        .strict(),
    run: async (ctx, { taskId, version, requestId: _, ...changes }) => {
        // Only the date fields are sent, so without a version this can't overwrite anyone's other edits.
        const current = version ?? (await requireTask(ctx.db, ctx.user, taskId, "editor")).version;
        return written(ctx, await updateTask(ctx.db, ctx.user, taskId, { version: current, ...changes }));
    },
    replay: replayTask,
});

const tasksComplete = tool({
    name: "tasks_complete",
    write: true,
    permission: "tasks.use",
    input: z.object({ taskId, occurrence: calendarDate.optional(), includeSubtasks: z.boolean().default(false), requestId }).strict(),
    run: async (ctx, { taskId, occurrence, includeSubtasks }) => {
        const result = await completeTask(ctx.db, ctx.user, taskId, { occurrence, includeSubtasks });
        return written(ctx, result.task, { alreadyDone: result.alreadyDone, nextDate: result.nextDate });
    },
    replay: replayTask,
});

const tasksReopen = tool({
    name: "tasks_reopen",
    write: true,
    permission: "tasks.use",
    input: z.object({ taskId, requestId }).strict(),
    run: async (ctx, { taskId }) => written(ctx, await reopenTask(ctx.db, ctx.user, taskId)),
    replay: replayTask,
});

const tasksAddComment = tool({
    name: "tasks_add_comment",
    write: true,
    permission: "tasks.use",
    input: z.object({ taskId, body: z.string().min(1).max(5_000), requestId }).strict(),
    run: async (ctx, { taskId, body }) => {
        const comments = await addComment(ctx.db, ctx.user, taskId, { body });
        const mine = comments.filter((c) => c.author === ctx.user.email).at(-1);
        return {
            data: { taskId, comment: mine ? { id: mine.id, createdAt: mine.createdAt } : null, comments: comments.length },
            outcome: { entityType: "task", entityId: taskId },
        };
    },
    replay: replayTask,
});

const tasksLinkKnowledge = tool({
    name: "tasks_link_knowledge",
    write: true,
    permission: "tasks.use",
    input: z.object({ taskId, objectId: id("kob", "Knowledge object"), requestId }).strict(),
    run: async (ctx, { taskId, objectId }) => {
        // linkKnowledge checks both systems: editor of the task's project AND a reader of the object's space.
        const references = await linkKnowledge(ctx.db, ctx.user, taskId, { objectId });
        const link = references.find((r) => r.available && r.objectId === objectId);
        return {
            data: { taskId, objectId, linked: !!link, references: references.length },
            outcome: { entityType: "task_knowledge_link", entityId: link?.linkId ?? taskId },
        };
    },
    replay: async (_ctx, outcome) => ({ data: { linked: true, linkId: outcome.entityId, replayed: true } }),
});

export const TASK_TOOLS: ToolDef[] = [
    tasksList,
    tasksGet,
    tasksToday,
    tasksUpcoming,
    tasksOverdue,
    tasksSearch,
    tasksListProjects,
    tasksProjectSummary,
    tasksListGoals,
    tasksGetGoal,
    tasksListRoutines,
    tasksCreate,
    tasksUpdate,
    tasksReschedule,
    tasksComplete,
    tasksReopen,
    tasksAddComment,
    tasksLinkKnowledge,
];
