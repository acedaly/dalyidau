// The Tasks dashboard (/portal/tasks/dashboard): a personal view of what needs attention and a
// shared household view.
//
// Every number is a COUNT over the same membership-joined SQL as the list it summarises, and the
// list beside it is the first few rows of that same query, so a count can never include anything
// the person couldn't open. The household view looks only at shared projects the caller is a member
// of; nobody's personal projects, Inbox or private goals are ever counted there, whoever's portal
// role is what. Each bucket is two indexed queries with a small LIMIT; nothing is fetched whole.
import type { D1Database } from "@cloudflare/workers-types";
import type { PortalUser } from "../../src/shared/portal/types";
import { addDays, zonedInstant } from "../../src/shared/tasks/dates";
import {
    type Bucket,
    type DashboardPreferences,
    type HouseholdDashboard,
    type HouseholdFilter,
    type PersonalDashboard,
    type ProjectCard,
    dashboardPreferences,
} from "../../src/shared/tasks/productivity";
import { nowIso, parseJson } from "../portal/db";
import { preferences, todayFor } from "./access";
import { listGoals } from "./goals";
import { type MeasuredProject, measureProjects } from "./health";
import { listRoutines } from "./routines";
import { TASK_COLUMNS, type TaskRow, toSummary } from "./rows";
import { DATE_ORDER, MINE, MY_DATED, NOT_PAUSED, all } from "./views";

/** How many items each card lists beside its count. */
const SHOWN = 8;

/** A count and the first rows of one query. `where` may use ?1 (the caller) and must use ?2… for its own binds. */
async function bucket(db: D1Database, email: string, where: string, binds: unknown[], order = DATE_ORDER, limit = SHOWN): Promise<Bucket> {
    const [count, tasks] = await Promise.all([
        db
            .prepare(`SELECT COUNT(*) AS n ${MINE} WHERE ${where}`)
            .bind(email, ...binds)
            .first<{ n: number }>(),
        all(db, `SELECT ${TASK_COLUMNS} ${MINE} WHERE ${where} ${order} LIMIT ${limit}`, [email, ...binds]),
    ]);
    return { count: count?.n ?? 0, tasks };
}

/** Completions in a window on tasks the caller can see, each as the task now but marked done by whoever did it. */
async function completions(db: D1Database, email: string, where: string, from: string, binds: unknown[] = []): Promise<Bucket> {
    const base = `FROM task_completions c JOIN task_items t ON t.id = c.task_id
        JOIN task_project_members m ON m.project_id = t.project_id AND m.email = ?1 JOIN task_projects p ON p.id = t.project_id
        WHERE c.kind = 'completed' AND c.undone_at IS NULL AND c.at >= ?2 AND ${where}`;
    const [count, rows] = await Promise.all([
        db
            .prepare(`SELECT COUNT(*) AS n ${base}`)
            .bind(email, from, ...binds)
            .first<{ n: number }>(),
        db
            .prepare(`SELECT ${TASK_COLUMNS}, c.at AS c_at, c.by AS c_by, c.occurrence_date AS c_occurrence ${base} ORDER BY c.id DESC LIMIT ${SHOWN}`)
            .bind(email, from, ...binds)
            .all<TaskRow & { c_at: string; c_by: string; c_occurrence: string | null }>(),
    ]);
    return {
        count: count?.n ?? 0,
        tasks: rows.results.map((r) => ({
            ...toSummary(r),
            dueDate: r.c_occurrence ?? r.due_date,
            status: "completed",
            completedAt: r.c_at,
            completedBy: r.c_by,
        })),
    };
}

const card = (p: MeasuredProject): ProjectCard => ({
    id: p.id,
    name: p.name,
    color: p.color,
    kind: p.kind,
    open: p.metrics.open,
    completed: p.metrics.completed,
    overdue: p.metrics.overdue,
    targetDate: p.metrics.targetDate,
    health: p.health,
});

/** Most pressing first: at risk, then needs attention, then the soonest target. */
const HEALTH_ORDER = { at_risk: 0, needs_attention: 1, on_track: 2 };
const byUrgency = (a: ProjectCard, b: ProjectCard) =>
    HEALTH_ORDER[a.health.status] - HEALTH_ORDER[b.health.status] || (a.targetDate ?? "9999").localeCompare(b.targetDate ?? "9999");

export async function personalDashboard(db: D1Database, user: PortalUser): Promise<PersonalDashboard> {
    const email = user.email;
    const prefs = await preferences(db, email);
    const today = await todayFor(db, email);
    const week = addDays(today, 7);
    const since = zonedInstant(addDays(today, -6), "00:00", prefs.timeZone);
    const [dueToday, overdue, next7, inbox, highPriority, completedRecently, measured, goals, milestones, routines] = await Promise.all([
        bucket(db, email, `${MY_DATED} AND t.due_date = ?2`, [today]),
        bucket(db, email, `${MY_DATED} AND (t.due_date < ?2 OR t.deadline < ?2)`, [today]),
        bucket(db, email, `${MY_DATED} AND t.due_date > ?2 AND t.due_date <= ?3`, [today, week]),
        // Captured but not sorted yet: undated top-level tasks still in the Inbox.
        bucket(
            db,
            email,
            "p.is_inbox = 1 AND t.status = 'open' AND t.parent_id IS NULL AND t.due_date IS NULL AND t.deadline IS NULL",
            [],
            "ORDER BY t.created_at DESC",
        ),
        bucket(db, email, `${MY_DATED} AND t.priority <= 2`, [], "ORDER BY t.priority, t.due_date IS NULL, t.due_date, t.position"),
        completions(db, email, "c.by = ?1", since),
        measureProjects(db, email, today, prefs.timeZone),
        listGoals(db, email, today, { activeOnly: true }),
        all(
            db,
            `SELECT ${TASK_COLUMNS} ${MINE} WHERE ${MY_DATED} AND t.is_milestone = 1 AND COALESCE(t.deadline, t.due_date) BETWEEN ?2 AND ?3
             ORDER BY COALESCE(t.deadline, t.due_date) LIMIT ${SHOWN}`,
            [email, today, addDays(today, 30)],
        ),
        listRoutines(db, email, { dueBy: week, includePaused: false, mineOnly: true, limit: SHOWN }),
    ]);
    const active = measured.filter((p) => p.status === "active");
    return {
        dueToday,
        overdue,
        next7,
        inbox,
        highPriority,
        completedRecently,
        projects: active
            .filter((p) => p.kind === "personal")
            .map(card)
            .sort(byUrgency)
            .slice(0, SHOWN),
        goals: goals
            .filter((g) => g.kind === "personal" || g.attention)
            .sort((a, b) => Number(!a.attention) - Number(!b.attention))
            .slice(0, SHOWN),
        milestones,
        routines,
        // Projects whose review is due, that the caller could review (members who can edit).
        reviewsDue: active
            .filter((p) => p.metrics.review.due && p.metrics.review.nextDue)
            .map((p) => ({ projectId: p.id, name: p.name, due: p.metrics.review.nextDue! }))
            .slice(0, SHOWN),
    };
}

const assigneeClause: Record<HouseholdFilter, string> = {
    all: "1 = 1",
    mine: "t.assignee_email = ?1",
    others: "t.assignee_email IS NOT NULL AND t.assignee_email <> ?1",
    unassigned: "t.assignee_email IS NULL",
};

export async function householdDashboard(db: D1Database, user: PortalUser, filter: HouseholdFilter): Promise<HouseholdDashboard> {
    const email = user.email;
    const prefs = await preferences(db, email);
    const today = await todayFor(db, email);
    const since = zonedInstant(addDays(today, -6), "00:00", prefs.timeZone);
    // Open tasks in shared projects the caller belongs to, and nothing else.
    const SHARED = `p.kind = 'shared' AND p.status = 'active' AND t.status = 'open' AND ${NOT_PAUSED} AND ${assigneeClause[filter]}`;
    const [projectCount, attention, upcoming, people, commitments, routines, measured, goals, completedRecently] = await Promise.all([
        db
            .prepare(
                "SELECT COUNT(*) AS n FROM task_projects p JOIN task_project_members m ON m.project_id = p.id AND m.email = ? WHERE p.kind = 'shared' AND p.status = 'active'",
            )
            .bind(email)
            .first<{ n: number }>(),
        bucket(db, email, `${SHARED} AND (t.due_date <= ?2 OR t.deadline <= ?2)`, [today]),
        bucket(
            db,
            email,
            `${SHARED} AND (t.due_date BETWEEN ?2 AND ?3 OR t.deadline BETWEEN ?2 AND ?3)`,
            [addDays(today, 1), addDays(today, 14)],
            "ORDER BY COALESCE(MIN(t.due_date, t.deadline), t.due_date, t.deadline), t.priority",
        ),
        db
            .prepare(
                `SELECT t.assignee_email AS email, u.name, COUNT(*) AS open, SUM(t.due_date < ?2 OR t.deadline < ?2) AS overdue
                 ${MINE} LEFT JOIN portal_users u ON u.email = t.assignee_email
                 WHERE p.kind = 'shared' AND p.status = 'active' AND t.status = 'open' AND ${NOT_PAUSED}
                 GROUP BY t.assignee_email ORDER BY t.assignee_email IS NULL, t.assignee_email`,
            )
            .bind(email, today)
            .all<{ email: string | null; name: string | null; open: number; overdue: number | null }>(),
        bucket(db, email, `${SHARED} AND t.deadline IS NOT NULL`, [], "ORDER BY t.deadline, t.priority"),
        listRoutines(db, email, { scope: "shared", includePaused: false, limit: SHOWN }),
        measureProjects(db, email, today, prefs.timeZone, { kind: "shared" }),
        listGoals(db, email, today, { kind: "shared", activeOnly: true }),
        completions(db, email, "p.kind = 'shared'", since),
    ]);
    return {
        filter,
        projectCount: projectCount?.n ?? 0,
        attention,
        upcoming,
        byAssignee: people.results.map((r) => ({ email: r.email, name: r.name, open: r.open, overdue: r.overdue ?? 0 })),
        commitments,
        routines: routines.filter(
            (r) =>
                filter === "all" ||
                (filter === "mine" ? r.responsible === email : filter === "unassigned" ? !r.responsible : r.responsible && r.responsible !== email),
        ),
        projects: measured
            .filter((p) => p.status === "active")
            .map(card)
            .sort(byUrgency)
            .slice(0, SHOWN),
        goals: goals.slice(0, SHOWN),
        completedRecently,
    };
}

// --- Preferences ---------------------------------------------------------------------------------

export async function getDashboardPreferences(db: D1Database, email: string): Promise<DashboardPreferences> {
    const row = await db.prepare("SELECT prefs_json FROM task_dashboard_preferences WHERE email = ?").bind(email).first<{ prefs_json: string }>();
    // A stored value that no longer parses is treated as the defaults.
    const parsed = dashboardPreferences.safeParse(parseJson(row?.prefs_json, {}));
    return parsed.success ? parsed.data : {};
}

export async function setDashboardPreferences(db: D1Database, email: string, input: unknown): Promise<DashboardPreferences> {
    const prefs = dashboardPreferences.parse(input);
    await db
        .prepare(
            `INSERT INTO task_dashboard_preferences (email, prefs_json, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(email) DO UPDATE SET prefs_json = excluded.prefs_json, updated_at = excluded.updated_at`,
        )
        .bind(email, JSON.stringify(prefs), nowIso())
        .run();
    return prefs;
}
