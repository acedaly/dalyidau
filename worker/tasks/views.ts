// Task lists: Inbox, Today, Upcoming, Overdue, Completed, projects, filters and search.
//
// Every query starts from the caller's own membership rows (JOIN task_project_members … email = ?),
// so nothing outside their projects can appear, whatever the filter says. Lists are bounded and use
// the task_items indexes on (project_id, status, due_date / deadline / section).
//
// What "my" date views show: open tasks in active projects where the caller can edit, that are
// assigned to them or to nobody. Tasks assigned to someone else stay in their project, not in the
// caller's Today. The Inbox is the caller's own Inbox project only: shared tasks assigned to them
// never become Inbox records, and no task is ever copied to appear in two places.
import type { D1Database } from "@cloudflare/workers-types";
import { addDays, zonedInstant } from "../../src/shared/tasks/dates";
import type { TaskFilter } from "../../src/shared/tasks/filters";
import { projectOccurrences } from "../../src/shared/tasks/recurrence";
import type { CompletedEntry, TaskSummary } from "../../src/shared/tasks/types";
import { likePattern } from "../portal/db";
import { TASK_COLUMNS, type TaskRow, toSummary } from "./rows";
import { exceptionsFor } from "./tasks";

export const MINE = `FROM task_items t
    JOIN task_project_members m ON m.project_id = t.project_id AND m.email = ?1
    JOIN task_projects p ON p.id = t.project_id`;
// A paused routine (Milestone 3) keeps its task and date but stays out of the date views until it's resumed.
export const NOT_PAUSED = "NOT EXISTS (SELECT 1 FROM task_routines r WHERE r.task_id = t.id AND r.paused_at IS NOT NULL)";
export const MY_DATED = `p.status = 'active' AND m.role <> 'viewer' AND (t.assignee_email IS NULL OR t.assignee_email = ?1) AND t.status = 'open' AND ${NOT_PAUSED}`;
export const DATE_ORDER = "ORDER BY t.due_date IS NULL, t.due_date, t.due_time IS NULL, t.due_time, t.priority, p.is_inbox DESC, t.position";

export const all = async (db: D1Database, sql: string, binds: unknown[]) =>
    (
        await db
            .prepare(sql)
            .bind(...binds)
            .all<TaskRow>()
    ).results.map(toSummary);

/** Open tasks in the caller's Inbox, in their order (subtasks included; the page nests them). */
export const listInbox = (db: D1Database, email: string, inboxId: string) =>
    all(db, `SELECT ${TASK_COLUMNS} ${MINE} WHERE t.project_id = ?2 AND t.status = 'open' ORDER BY t.depth, t.position LIMIT 1000`, [email, inboxId]);

/**
 * Today: overdue, due today, deadline today or passed, and (if the person chose it) undated tasks
 * at a high priority. Undated tasks are otherwise left out.
 */
export const listToday = (db: D1Database, email: string, today: string, todayPriority: number | null) =>
    all(
        db,
        `SELECT ${TASK_COLUMNS} ${MINE} WHERE ${MY_DATED}
         AND (t.due_date <= ?2 OR t.deadline <= ?2 ${todayPriority ? "OR (t.due_date IS NULL AND t.priority <= ?3)" : ""})
         ${DATE_ORDER} LIMIT 500`,
        todayPriority ? [email, today, todayPriority] : [email, today],
    );

export const listOverdue = (db: D1Database, email: string, today: string) =>
    all(db, `SELECT ${TASK_COLUMNS} ${MINE} WHERE ${MY_DATED} AND (t.due_date < ?2 OR t.deadline < ?2) ${DATE_ORDER} LIMIT 500`, [email, today]);

/** Most projected repeats shown per task in Upcoming, however long the window. */
export const PROJECTION_LIMIT = 14;

/**
 * How many tasks the caller completed today, in their own time zone: the "done" half of Today's
 * progress. Undone completions and skips don't count; tasks they can no longer see don't either.
 */
export async function completedToday(db: D1Database, email: string, today: string, timeZone: string): Promise<number> {
    const row = await db
        .prepare(
            `SELECT COUNT(*) AS n FROM task_completions c JOIN task_items t ON t.id = c.task_id
             JOIN task_project_members m ON m.project_id = t.project_id AND m.email = ?1
             WHERE c.by = ?1 AND c.kind = 'completed' AND c.undone_at IS NULL AND c.at >= ?2 AND c.at < ?3`,
        )
        .bind(email, zonedInstant(today, "00:00", timeZone), zonedInstant(addDays(today, 1), "00:00", timeZone))
        .first<{ n: number }>();
    return row?.n ?? 0;
}

/**
 * Upcoming: tasks due from `from` to `to`, plus later repeats of repeating tasks in that window,
 * worked out on the fly (marked `projected`) rather than stored. A week or month that started
 * before today shows open tasks on their (past) dates, but never projects repeats into the past.
 */
export async function listUpcoming(
    db: D1Database,
    email: string,
    from: string,
    to: string,
    today = from,
    /** Which tasks: by default the caller's own (MY_DATED); the workload view also asks for shared ones. Uses ?1 only. */
    scope = MY_DATED,
    projectionLimit = PROJECTION_LIMIT,
): Promise<TaskSummary[]> {
    const tasks = await all(db, `SELECT ${TASK_COLUMNS} ${MINE} WHERE ${scope} AND t.due_date BETWEEN ?2 AND ?3 ${DATE_ORDER} LIMIT 1000`, [email, from, to]);
    // Repeating tasks due before the window also repeat inside it.
    const repeating = await all(
        db,
        `SELECT ${TASK_COLUMNS} ${MINE} WHERE ${scope} AND t.recurrence_json IS NOT NULL AND t.due_date <= ?2 ${DATE_ORDER} LIMIT 500`,
        [email, to],
    );
    const projected: TaskSummary[] = [];
    // Skipped and moved occurrences, for every repeating task in one pass.
    const exceptions = await exceptionsFor(
        db,
        repeating.filter((t) => t.recurrence?.basis === "scheduled").map((t) => t.id),
    );
    for (const task of repeating) {
        if (!task.recurrence || !task.dueDate) continue;
        const start = from > today ? from : today;
        const after = task.dueDate < start ? addDays(start, -1) : task.dueDate;
        for (const { date, seriesDate } of projectOccurrences(task.recurrence, after, to, projectionLimit, exceptions.get(task.id))) {
            if (date === task.dueDate) continue;
            projected.push({ ...task, dueDate: date, projected: true, seriesDate });
        }
    }
    return [...tasks, ...projected].sort(
        (a, b) => (a.dueDate ?? "").localeCompare(b.dueDate ?? "") || (a.dueTime ?? "99").localeCompare(b.dueTime ?? "99") || a.priority - b.priority,
    );
}

/** Open tasks whose deadline falls in a window: the calendar marks them on their deadline's day. */
export const listDeadlines = (db: D1Database, email: string, from: string, to: string) =>
    all(db, `SELECT ${TASK_COLUMNS} ${MINE} WHERE ${MY_DATED} AND t.deadline BETWEEN ?2 AND ?3 ORDER BY t.deadline, t.priority LIMIT 500`, [email, from, to]);

/**
 * What was completed in a window, each on the date of the occurrence that was done (a repeating
 * task appears once per completed occurrence), as the task is now but marked completed. Only the
 * caller's "my" tasks, like the rest of the calendar.
 */
export async function completedBetween(db: D1Database, email: string, from: string, to: string): Promise<TaskSummary[]> {
    const rows = await db
        .prepare(
            `SELECT ${TASK_COLUMNS}, c.occurrence_date AS c_occurrence, c.at AS c_at, c.by AS c_by
             FROM task_completions c JOIN task_items t ON t.id = c.task_id
             JOIN task_project_members m ON m.project_id = t.project_id AND m.email = ?1 JOIN task_projects p ON p.id = t.project_id
             WHERE c.kind = 'completed' AND c.undone_at IS NULL AND c.occurrence_date BETWEEN ?2 AND ?3
               AND (t.assignee_email IS NULL OR t.assignee_email = ?1) AND t.parent_id IS NULL
             ORDER BY c.occurrence_date LIMIT 500`,
        )
        .bind(email, from, to)
        .all<TaskRow & { c_occurrence: string; c_at: string; c_by: string }>();
    return rows.results.map((r) => ({ ...toSummary(r), dueDate: r.c_occurrence, status: "completed", completedAt: r.c_at, completedBy: r.c_by }));
}

/** Completions (newest first) on tasks the caller can still see, with each task as it is now. */
export async function listCompleted(db: D1Database, email: string, options: { before?: number | null; limit?: number; projectId?: string | null } = {}) {
    const limit = Math.min(options.limit ?? 50, 200);
    const rows = await db
        .prepare(
            `SELECT ${TASK_COLUMNS}, c.id AS c_id, c.kind AS c_kind, c.occurrence_date AS c_occurrence, c.next_date AS c_next, c.at AS c_at, c.by AS c_by
             FROM task_completions c JOIN task_items t ON t.id = c.task_id
             JOIN task_project_members m ON m.project_id = t.project_id AND m.email = ?
             WHERE c.undone_at IS NULL ${options.before ? "AND c.id < ?" : ""} ${options.projectId ? "AND t.project_id = ?" : ""}
             ORDER BY c.id DESC LIMIT ?`,
        )
        .bind(email, ...(options.before ? [options.before] : []), ...(options.projectId ? [options.projectId] : []), limit + 1)
        .all<TaskRow & { c_id: number; c_kind: "completed" | "skipped"; c_occurrence: string | null; c_next: string | null; c_at: string; c_by: string }>();
    const entries: CompletedEntry[] = rows.results.slice(0, limit).map((r) => ({
        task: toSummary(r),
        completion: { id: r.c_id, kind: r.c_kind, occurrenceDate: r.c_occurrence, nextDate: r.c_next, at: r.c_at, by: r.c_by, undoneAt: null },
    }));
    return { entries, hasMore: rows.results.length > limit };
}

/** A project's tasks: all open ones, in section and position order (the page nests subtasks). */
export const listProjectTasks = (db: D1Database, email: string, projectId: string, status: "open" | "completed" = "open") =>
    all(
        db,
        `SELECT ${TASK_COLUMNS} ${MINE} WHERE t.project_id = ?2 AND t.status = ?3
         ORDER BY ${status === "completed" ? "t.completed_at DESC" : "t.depth, t.position"} LIMIT ${status === "completed" ? 200 : 2000}`,
        [email, projectId, status],
    );

// --- Filters -------------------------------------------------------------------------------------

/**
 * Turns a validated filter into parameterised SQL. Each clause comes from a fixed list chosen by
 * the filter's enum values; user text only ever reaches SQL as a bound parameter.
 */
export async function filterTasks(
    db: D1Database,
    email: string,
    filter: TaskFilter,
    today: string,
    page: { limit: number; offset: number } = { limit: 200, offset: 0 },
): Promise<{ tasks: TaskSummary[]; hasMore: boolean }> {
    const where: string[] = [];
    const binds: unknown[] = [email];
    const bind = (value: unknown) => {
        binds.push(value);
        return `?${binds.length}`;
    };
    if (filter.status !== "all") where.push(`t.status = ${bind(filter.status)}`);
    if (filter.scope !== "all") where.push(`p.kind = ${bind(filter.scope)}`);
    // Archived projects only appear when asked for by name.
    if (!filter.projectIds.length) where.push("p.status <> 'archived'");
    else where.push(`t.project_id IN (${filter.projectIds.map(bind).join(", ")})`);
    if (filter.sectionIds.length) where.push(`t.section_id IN (${filter.sectionIds.map(bind).join(", ")})`);
    if (filter.priorities.length) where.push(`t.priority IN (${filter.priorities.map(bind).join(", ")})`);
    const t = bind(today);
    switch (filter.due) {
        case "overdue":
            where.push(`t.due_date < ${t}`);
            break;
        case "today":
            where.push(`t.due_date = ${t}`);
            break;
        case "next7":
            where.push(`t.due_date BETWEEN ${t} AND ${bind(addDays(today, 6))}`);
            break;
        case "next30":
            where.push(`t.due_date BETWEEN ${t} AND ${bind(addDays(today, 29))}`);
            break;
        case "scheduled":
            where.push("t.due_date IS NOT NULL");
            break;
        case "none":
            where.push("t.due_date IS NULL");
            break;
    }
    switch (filter.deadline) {
        case "overdue":
            where.push(`t.deadline < ${t}`);
            break;
        case "next7":
            where.push(`t.deadline BETWEEN ${t} AND ${bind(addDays(today, 6))}`);
            break;
        case "has":
            where.push("t.deadline IS NOT NULL");
            break;
        case "none":
            where.push("t.deadline IS NULL");
            break;
    }
    switch (filter.assignee) {
        case "mine":
            // What the caller is responsible for: like Today, active projects they can edit, and
            // tasks assigned to them or to nobody (personal tasks never have an assignee).
            where.push("(t.assignee_email IS NULL OR t.assignee_email = ?1) AND m.role <> 'viewer' AND p.status = 'active'");
            break;
        case "me":
            where.push("t.assignee_email = ?1");
            break;
        case "unassigned":
            where.push("t.assignee_email IS NULL");
            break;
        case "others":
            where.push("t.assignee_email IS NOT NULL AND t.assignee_email <> ?1");
            break;
    }
    if (filter.labels.length) {
        const names = filter.labels.map(bind).join(", ");
        where.push(
            filter.labelMode === "all"
                ? `(SELECT COUNT(*) FROM task_item_labels l WHERE l.task_id = t.id AND l.name IN (${names})) = ${bind(new Set(filter.labels.map((l) => l.toLowerCase())).size)}`
                : `EXISTS (SELECT 1 FROM task_item_labels l WHERE l.task_id = t.id AND l.name IN (${names}))`,
        );
    }
    for (const word of words(filter.text)) {
        const p = bind(likePattern(word));
        where.push(`(t.title LIKE ${p} ESCAPE '\\' OR t.description LIKE ${p} ESCAPE '\\')`);
    }
    const order = {
        due: "t.due_date IS NULL, t.due_date, t.due_time IS NULL, t.due_time, t.priority",
        priority: "t.priority, t.due_date IS NULL, t.due_date",
        created: "t.created_at DESC",
        updated: "t.updated_at DESC",
        title: "t.title COLLATE NOCASE",
        // The order the caller sees in their sidebar and in each project: Inbox first, then their
        // project order, sections in order, then each task's place in its list.
        manual: "p.is_inbox DESC, m.position, t.project_id, (SELECT s.position FROM task_sections s WHERE s.id = t.section_id), t.depth, t.position",
    }[filter.sort];
    const limit = bind(page.limit + 1);
    const offset = bind(page.offset);
    const tasks = await all(
        db,
        `SELECT ${TASK_COLUMNS} ${MINE} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ${order}, t.id LIMIT ${limit} OFFSET ${offset}`,
        binds,
    );
    return { tasks: tasks.slice(0, page.limit), hasMore: tasks.length > page.limit };
}

/** Search words: at most eight, each at most 60 characters. */
const words = (text: string) =>
    text
        .split(/\s+/)
        .map((w) => w.trim().slice(0, 60))
        .filter(Boolean)
        .slice(0, 8);

/**
 * Search across the caller's projects: every word must appear in a task's title, description or
 * labels (or its project's name). LIKE with escaped, bound patterns: for two people's tasks this is
 * fast enough without a full-text index, and it adds nothing the backup tooling must rebuild.
 */
export async function searchTasks(db: D1Database, email: string, query: string, limit = 50) {
    const terms = words(query);
    if (!terms.length) return { tasks: [] as TaskSummary[], projects: [] as { id: string; name: string }[] };
    const clauses = terms.map(
        (_, i) =>
            `(t.title LIKE ?${i + 2} ESCAPE '\\' OR t.description LIKE ?${i + 2} ESCAPE '\\' OR p.name LIKE ?${i + 2} ESCAPE '\\'
              OR EXISTS (SELECT 1 FROM task_item_labels l WHERE l.task_id = t.id AND l.name LIKE ?${i + 2} ESCAPE '\\'))`,
    );
    const patterns = terms.map(likePattern);
    const tasks = await all(
        db,
        `SELECT ${TASK_COLUMNS} ${MINE} WHERE ${clauses.join(" AND ")}
         ORDER BY t.status = 'completed', t.title LIKE ?2 ESCAPE '\\' DESC, t.updated_at DESC LIMIT ${Math.min(limit, 100)}`,
        [email, ...patterns],
    );
    const projects = await db
        .prepare(
            `SELECT p.id, p.name FROM task_projects p JOIN task_project_members m ON m.project_id = p.id AND m.email = ?1
             WHERE ${terms.map((_, i) => `p.name LIKE ?${i + 2} ESCAPE '\\'`).join(" AND ")} ORDER BY p.name LIMIT 10`,
        )
        .bind(email, ...patterns)
        .all<{ id: string; name: string }>();
    return { tasks, projects: projects.results };
}

/** Deadlines and milestones for a project's overview. */
export const projectHighlights = async (db: D1Database, email: string, projectId: string) => ({
    upcomingDeadlines: await all(
        db,
        `SELECT ${TASK_COLUMNS} ${MINE} WHERE t.project_id = ?2 AND t.status = 'open' AND t.deadline IS NOT NULL ORDER BY t.deadline LIMIT 10`,
        [email, projectId],
    ),
    milestones: await all(
        db,
        `SELECT ${TASK_COLUMNS} ${MINE} WHERE t.project_id = ?2 AND t.is_milestone = 1 ORDER BY t.status = 'completed', COALESCE(t.deadline, t.due_date) IS NULL, COALESCE(t.deadline, t.due_date) LIMIT 20`,
        [email, projectId],
    ),
});
