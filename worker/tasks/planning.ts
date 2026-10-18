// Planning views: workload over the next few weeks, and a project's timeline.
//
// Workload groups open tasks with dates in a window (one to four weeks from a Monday) by day, week,
// project, priority or person, with the same repeats projected as Upcoming and fixed-threshold
// warnings (src/shared/tasks/productivity.ts). It never claims to know effort or capacity: tasks
// have no estimates, so it counts tasks. "Mine" is exactly what Today and Upcoming show (tasks
// assigned to the caller or to nobody, in active projects they can edit); "shared" is every open
// task in the shared projects the caller is a member of, whoever it's assigned to.
//
// The timeline lists a project's dated events in order: start and target, milestones, deadlines,
// due tasks (with a few later repeats), and reviews done and due. Bounded, and from one project the
// caller is a member of.
import type { D1Database } from "@cloudflare/workers-types";
import type { PortalUser } from "../../src/shared/portal/types";
import { addDays, isCalendarDate, localDate, weekStart } from "../../src/shared/tasks/dates";
import {
    type Bucket,
    type ProjectTimeline,
    type TimelineItem,
    WORKLOAD_TASK_LIMIT,
    type Workload,
    workloadWarnings,
} from "../../src/shared/tasks/productivity";
import { projectOccurrences } from "../../src/shared/tasks/recurrence";
import { preferences, requireProject, todayFor } from "./access";
import { measureProject, measureProjects } from "./health";
import { TASK_COLUMNS } from "./rows";
import { exceptionsFor } from "./tasks";
import { DATE_ORDER, MINE, MY_DATED, NOT_PAUSED, all, listUpcoming } from "./views";

const SHARED_OPEN = `p.kind = 'shared' AND p.status = 'active' AND t.status = 'open' AND ${NOT_PAUSED}`;

async function bucket(db: D1Database, email: string, where: string, binds: unknown[]): Promise<Bucket> {
    const [count, tasks] = await Promise.all([
        db
            .prepare(`SELECT COUNT(*) AS n ${MINE} WHERE ${where}`)
            .bind(email, ...binds)
            .first<{ n: number }>(),
        all(db, `SELECT ${TASK_COLUMNS} ${MINE} WHERE ${where} ${DATE_ORDER} LIMIT 50`, [email, ...binds]),
    ]);
    return { count: count?.n ?? 0, tasks };
}

export async function workload(
    db: D1Database,
    user: PortalUser,
    options: { scope: "mine" | "shared"; weeks: number; from?: string | null },
): Promise<Workload> {
    const email = user.email;
    const prefs = await preferences(db, email);
    const today = await todayFor(db, email);
    const weeks = Math.min(Math.max(Math.trunc(options.weeks) || 2, 1), 4);
    // Always from a Monday, never more than a year away.
    const requested = options.from && isCalendarDate(options.from) ? options.from : today;
    const from = weekStart(requested < addDays(today, -366) || requested > addDays(today, 366) ? today : requested);
    const to = addDays(from, weeks * 7 - 1);
    const scope = options.scope === "shared" ? SHARED_OPEN : MY_DATED;
    // A repeat projected at most once per day of the window (daily tasks), however long it is.
    const listed = await listUpcoming(db, email, from, to, today, scope, weeks * 7);
    const [overdue, undated, measured] = await Promise.all([
        bucket(db, email, `${scope} AND (t.due_date < ?2 OR t.deadline < ?2)`, [today]),
        bucket(db, email, `${scope} AND t.parent_id IS NULL AND t.due_date IS NULL AND t.deadline IS NULL`, []),
        measureProjects(db, email, today, prefs.timeZone, options.scope === "shared" ? { kind: "shared" } : {}),
    ]);
    const tasks = listed.slice(0, WORKLOAD_TASK_LIMIT);
    const thisWeek = weekStart(today);
    const inWeek = (date: string | null, start: string) => !!date && date >= start && date <= addDays(start, 6);
    const deadlines = await db
        .prepare(`SELECT COUNT(*) AS n ${MINE} WHERE ${scope} AND t.deadline BETWEEN ?2 AND ?3`)
        .bind(email, from, to)
        .first<{ n: number }>();
    const people = new Map<string, string | null>();
    if (options.scope === "shared") {
        const rows = await db
            .prepare(
                `SELECT DISTINCT a.email, u.name FROM task_project_members mine JOIN task_projects p ON p.id = mine.project_id AND p.kind = 'shared'
                 JOIN task_project_members a ON a.project_id = p.id AND a.role <> 'viewer' LEFT JOIN portal_users u ON u.email = a.email
                 WHERE mine.email = ? ORDER BY a.email LIMIT 50`,
            )
            .bind(email)
            .all<{ email: string; name: string | null }>();
        for (const r of rows.results) people.set(r.email, r.name);
    }
    return {
        scope: options.scope,
        from,
        to,
        weeks,
        tasks,
        overdue,
        undated,
        summary: {
            thisWeek: listed.filter((t) => inWeek(t.dueDate, thisWeek)).length,
            nextWeek: listed.filter((t) => inWeek(t.dueDate, addDays(thisWeek, 7))).length,
            highPriority: listed.filter((t) => t.priority <= 2).length,
            deadlines: deadlines?.n ?? 0,
            projected: listed.filter((t) => t.projected).length,
        },
        warnings: workloadWarnings(
            listed,
            overdue.count,
            measured.filter((p) => p.status === "active").map((p) => ({ id: p.id, name: p.name, targetDate: p.metrics.targetDate, open: p.metrics.open })),
            today,
        ),
        people: [...people].map(([email, name]) => ({ email, name })),
        truncated: listed.length > WORKLOAD_TASK_LIMIT,
    };
}

/** Most dated tasks a timeline lists, and how far ahead repeats are projected. */
const TIMELINE_TASKS = 300;
const TIMELINE_REPEATS = 4;

export async function projectTimeline(db: D1Database, user: PortalUser, projectId: string): Promise<ProjectTimeline> {
    await requireProject(db, user, projectId);
    const prefs = await preferences(db, user.email);
    const today = await todayFor(db, user.email);
    const dates = (await db
        .prepare("SELECT start_date, target_date FROM task_projects WHERE id = ?")
        .bind(projectId)
        .first<{ start_date: string | null; target_date: string | null }>())!;
    const scoped = `${MINE} WHERE t.project_id = ?2`;
    const [tasks, reviews, measured] = await Promise.all([
        all(
            db,
            `SELECT ${TASK_COLUMNS} ${scoped} AND (t.due_date IS NOT NULL OR t.deadline IS NOT NULL)
               AND (t.status = 'open' OR t.is_milestone = 1 OR t.parent_id IS NULL)
             ORDER BY COALESCE(MIN(t.due_date, t.deadline), t.due_date, t.deadline) LIMIT ${TIMELINE_TASKS + 1}`,
            [user.email, projectId],
        ),
        db
            .prepare("SELECT completed_at FROM task_project_reviews WHERE project_id = ? AND status = 'completed' ORDER BY completed_at DESC LIMIT 24")
            .bind(projectId)
            .all<{ completed_at: string }>(),
        measureProject(db, user.email, projectId, today, prefs.timeZone),
    ]);
    const items: TimelineItem[] = [];
    if (dates.start_date) items.push({ kind: "start", date: dates.start_date, label: "Project starts" });
    if (dates.target_date) items.push({ kind: "target", date: dates.target_date, label: "Target date" });
    const shown = tasks.slice(0, TIMELINE_TASKS);
    const horizon = dates.target_date && dates.target_date > today ? dates.target_date : addDays(today, 90);
    const exceptions = await exceptionsFor(
        db,
        shown.filter((t) => t.recurrence?.basis === "scheduled" && t.status === "open").map((t) => t.id),
    );
    for (const task of shown) {
        const done = task.status === "completed";
        if (task.isMilestone) items.push({ kind: "milestone", date: (task.deadline ?? task.dueDate)!, label: task.title, task, done });
        else {
            if (task.dueDate) items.push({ kind: "due", date: task.dueDate, label: task.title, task, done });
            if (task.deadline) items.push({ kind: "deadline", date: task.deadline, label: task.title, task, done });
        }
        if (!done && task.recurrence && task.dueDate)
            for (const { date } of projectOccurrences(task.recurrence, task.dueDate, horizon, TIMELINE_REPEATS, exceptions.get(task.id)))
                items.push({ kind: "due", date, label: task.title, task: { ...task, dueDate: date, projected: true } });
    }
    for (const r of reviews.results)
        items.push({ kind: "review", date: localDate(new Date(r.completed_at), prefs.timeZone), label: "Review completed", done: true });
    if (measured?.metrics.review.nextDue) items.push({ kind: "next_review", date: measured.metrics.review.nextDue, label: "Next review due" });
    items.sort((a, b) => a.date.localeCompare(b.date) || order(a.kind) - order(b.kind));
    return {
        from: items[0]?.date ?? today,
        to: items[items.length - 1]?.date ?? today,
        items,
        truncated: tasks.length > TIMELINE_TASKS,
    };
}

const ORDER: TimelineItem["kind"][] = ["start", "milestone", "deadline", "due", "review", "next_review", "target"];
const order = (kind: TimelineItem["kind"]) => ORDER.indexOf(kind);
