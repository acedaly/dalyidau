// A project's history (task_activity), readable only by the project's current members. Entries
// name the action and the task id and, for changes, which fields changed. Values are recorded only
// for fields that reveal nothing private (dates, priority, status, assignee, section); never
// titles, descriptions, comments, labels or Knowledge references. The portal-wide audit_log, which
// every portal editor can read, is never used for Tasks.
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import type { TaskActivityEntry } from "../../src/shared/tasks/types";
import { nowIso, parseJson } from "../portal/db";

export interface ActivityInput {
    projectId: string;
    taskId?: string | null;
    actor: string;
    action: string;
    changes?: Record<string, unknown>;
}

/** Fields whose values may go into the history. Anything else is recorded by name only. */
const SAFE_VALUES = new Set([
    "priority",
    "dueDate",
    "dueTime",
    "deadline",
    "status",
    "assignee",
    "isMilestone",
    "occurrence",
    "next",
    "role",
    "count",
    "kind",
    "health",
    "frequency",
    "rotation",
    "paused",
]);

/** Keeps values only for SAFE_VALUES; every other changed field becomes `true`. */
export const safeChanges = (changes: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(changes).map(([key, value]) => [key, SAFE_VALUES.has(key) ? value : true]));

/**
 * Builds the history insert so it can go in the same batch as the change it records. `condition`
 * (e.g. "WHERE changes() > 0") makes it conditional on the batch's previous statement.
 */
export const activity = (db: D1Database, entry: ActivityInput, condition = "", conditionBinds: unknown[] = []): D1PreparedStatement =>
    db
        .prepare(`INSERT INTO task_activity (project_id, task_id, actor, action, at, changes) SELECT ?, ?, ?, ?, ?, ? ${condition}`)
        .bind(
            entry.projectId,
            entry.taskId ?? null,
            entry.actor,
            entry.action,
            nowIso(),
            entry.changes === undefined ? null : JSON.stringify(safeChanges(entry.changes)),
            ...conditionBinds,
        );

interface ActivityRow {
    id: number;
    project_id: string;
    task_id: string | null;
    task_title: string | null;
    actor: string;
    actor_name: string | null;
    action: string;
    at: string;
    changes: string | null;
}

/**
 * History the caller may read: entries of projects they belong to now. A task's current title is
 * shown only if the caller can still see that task (it may since have moved to a project they
 * aren't in); the history itself never stores it.
 */
export async function listActivity(
    db: D1Database,
    email: string,
    options: { projectId?: string | null; taskId?: string | null; limit?: number; before?: number | null } = {},
): Promise<TaskActivityEntry[]> {
    const where: string[] = [];
    const binds: unknown[] = [email, email];
    if (options.projectId) (where.push("a.project_id = ?"), binds.push(options.projectId));
    if (options.taskId) (where.push("a.task_id = ?"), binds.push(options.taskId));
    if (options.before) (where.push("a.id < ?"), binds.push(options.before));
    binds.push(Math.min(options.limit ?? 50, 200));
    const rows = await db
        .prepare(
            `SELECT a.id, a.project_id, a.task_id, a.actor, a.action, a.at, a.changes, u.name AS actor_name,
                    CASE WHEN tm.email IS NOT NULL THEN t.title END AS task_title
             FROM task_activity a
             JOIN task_project_members m ON m.project_id = a.project_id AND m.email = ?
             LEFT JOIN task_items t ON t.id = a.task_id
             LEFT JOIN task_project_members tm ON tm.project_id = t.project_id AND tm.email = ?
             LEFT JOIN portal_users u ON u.email = a.actor
             ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
             ORDER BY a.id DESC LIMIT ?`,
        )
        .bind(...binds)
        .all<ActivityRow>();
    return rows.results.map((r) => ({
        id: r.id,
        projectId: r.project_id,
        taskId: r.task_id,
        taskTitle: r.task_title,
        actor: r.actor,
        actorName: r.actor_name,
        action: r.action,
        at: r.at,
        changes: parseJson<Record<string, unknown> | null>(r.changes, null),
    }));
}
