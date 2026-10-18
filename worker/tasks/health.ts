// Project health: deterministic numbers about each project and the status the shared rules derive
// from them (src/shared/tasks/productivity.ts), plus the manual status a member can set instead.
//
// Every count is one grouped query joined to the caller's own membership rows, so a project they
// aren't in contributes nothing and can't even be named. Several projects are measured in one pass
// (the dashboard asks for all of them at once), using the task_items indexes on project_id.
import type { D1Database } from "@cloudflare/workers-types";
import { z } from "zod";
import type { PortalUser } from "../../src/shared/portal/types";
import { addDays, localDate } from "../../src/shared/tasks/dates";
import {
    HEALTH_STATUSES,
    type HealthStatus,
    type ProjectHealth,
    type ProjectMetrics,
    type ReviewFrequency,
    calculateHealth,
    reviewSchedule,
} from "../../src/shared/tasks/productivity";
import type { TaskColor } from "../../src/shared/tasks/types";
import { chunk, isGuardFailure, nowIso, placeholders, requireChange } from "../portal/db";
import { requireProject, requireWritable } from "./access";
import { activity } from "./activity";
import { ProjectConflict } from "./projects";

export interface MeasuredProject {
    id: string;
    name: string;
    color: TaskColor;
    kind: "personal" | "shared";
    isInbox: boolean;
    status: "active" | "on_hold" | "completed" | "archived";
    metrics: ProjectMetrics;
    health: ProjectHealth;
}

interface ProjectRow {
    id: string;
    name: string;
    color: TaskColor;
    kind: "personal" | "shared";
    is_inbox: number;
    status: MeasuredProject["status"];
    start_date: string | null;
    target_date: string | null;
    created_at: string;
    review_frequency: ReviewFrequency;
    health_override: HealthStatus | null;
    health_note: string | null;
    health_set_by: string | null;
    health_set_at: string | null;
}

interface CountRow {
    project_id: string;
    open: number;
    completed: number;
    overdue: number;
    due_soon: number;
    unassigned: number;
    undated: number;
    milestones: number;
    completed_recently: number;
}

/**
 * Measures the given projects (or every project the caller is a member of) as the caller sees them.
 * Projects they aren't a member of are silently absent from the result.
 */
export async function measureProjects(
    db: D1Database,
    email: string,
    today: string,
    timeZone: string,
    options: { projectIds?: string[]; kind?: "personal" | "shared"; includeInbox?: boolean } = {},
): Promise<MeasuredProject[]> {
    const where = ["1 = 1"];
    const binds: unknown[] = [email];
    if (options.kind) (where.push("p.kind = ?"), binds.push(options.kind));
    if (!options.includeInbox) where.push("p.is_inbox = 0");
    if (options.projectIds) {
        if (!options.projectIds.length) return [];
        where.push(`p.id IN (${placeholders(options.projectIds.length)})`);
        binds.push(...options.projectIds);
    }
    const projects = (
        await db
            .prepare(
                `SELECT p.id, p.name, p.color, p.kind, p.is_inbox, p.status, p.start_date, p.target_date, p.created_at, p.review_frequency,
                        p.health_override, p.health_note, p.health_set_by, p.health_set_at
                 FROM task_projects p JOIN task_project_members m ON m.project_id = p.id AND m.email = ?
                 WHERE ${where.join(" AND ")} ORDER BY p.is_inbox DESC, m.position, p.name COLLATE NOCASE LIMIT 200`,
            )
            .bind(...binds)
            .all<ProjectRow>()
    ).results;
    if (!projects.length) return [];

    const counts = new Map<string, CountRow>();
    const lastActivity = new Map<string, string>();
    const lastReview = new Map<string, string>();
    const soon = addDays(today, 6);
    const month = addDays(today, 29);
    const recent = new Date(Date.now() - 14 * 86_400_000).toISOString();
    for (const part of chunk(
        projects.map((p) => p.id),
        50,
    )) {
        const ids = placeholders(part.length);
        const rows = await db
            .prepare(
                `SELECT t.project_id,
                    SUM(t.status = 'open') AS open,
                    SUM(t.status = 'completed') AS completed,
                    SUM(t.status = 'open' AND (t.due_date < ?1 OR t.deadline < ?1)) AS overdue,
                    SUM(t.status = 'open' AND (t.due_date BETWEEN ?1 AND ?2 OR t.deadline BETWEEN ?1 AND ?2)) AS due_soon,
                    SUM(t.status = 'open' AND t.parent_id IS NULL AND t.assignee_email IS NULL) AS unassigned,
                    SUM(t.status = 'open' AND t.parent_id IS NULL AND t.due_date IS NULL AND t.deadline IS NULL) AS undated,
                    SUM(t.status = 'open' AND t.is_milestone = 1 AND COALESCE(t.deadline, t.due_date) BETWEEN ?1 AND ?3) AS milestones,
                    SUM(t.status = 'completed' AND t.completed_at >= ?4) AS completed_recently
                 FROM task_items t WHERE t.project_id IN (${ids}) GROUP BY t.project_id`,
            )
            .bind(today, soon, month, recent, ...part)
            .all<CountRow>();
        for (const r of rows.results) counts.set(r.project_id, r);
        // The newest history entry per project: MAX(id) is a seek on (project_id, id).
        const activityRows = await db
            .prepare(
                `SELECT a.project_id, a.at FROM task_activity a
                 WHERE a.id IN (SELECT MAX(id) FROM task_activity WHERE project_id IN (${ids}) GROUP BY project_id)`,
            )
            .bind(...part)
            .all<{ project_id: string; at: string }>();
        for (const r of activityRows.results) lastActivity.set(r.project_id, r.at);
        const reviewRows = await db
            .prepare(
                `SELECT project_id, MAX(completed_at) AS at FROM task_project_reviews
                 WHERE status = 'completed' AND project_id IN (${ids}) GROUP BY project_id`,
            )
            .bind(...part)
            .all<{ project_id: string; at: string }>();
        for (const r of reviewRows.results) lastReview.set(r.project_id, r.at);
    }

    return projects.map((p) => {
        const c = counts.get(p.id);
        const reviewedAt = lastReview.get(p.id);
        const metrics: ProjectMetrics = {
            open: c?.open ?? 0,
            completed: c?.completed ?? 0,
            overdue: c?.overdue ?? 0,
            dueSoon: c?.due_soon ?? 0,
            unassigned: p.kind === "shared" ? (c?.unassigned ?? 0) : null,
            undated: c?.undated ?? 0,
            upcomingMilestones: c?.milestones ?? 0,
            completedRecently: c?.completed_recently ?? 0,
            lastActivityAt: lastActivity.get(p.id) ?? null,
            startDate: p.start_date,
            targetDate: p.target_date,
            review: reviewSchedule(
                p.review_frequency,
                reviewedAt ? localDate(new Date(reviewedAt), timeZone) : null,
                localDate(new Date(p.created_at), timeZone),
                today,
            ),
        };
        const calculated = calculateHealth(metrics, today);
        const health: ProjectHealth = {
            status: p.health_override ?? calculated.status,
            calculated: calculated.status,
            reasons: calculated.reasons,
            override: p.health_override ? { status: p.health_override, note: p.health_note, by: p.health_set_by, at: p.health_set_at } : null,
        };
        return { id: p.id, name: p.name, color: p.color, kind: p.kind, isInbox: !!p.is_inbox, status: p.status, metrics, health };
    });
}

export async function measureProject(db: D1Database, email: string, projectId: string, today: string, timeZone: string) {
    return (await measureProjects(db, email, today, timeZone, { projectIds: [projectId], includeInbox: true }))[0] ?? null;
}

const healthInput = z
    .object({
        version: z.number().int().min(1),
        /** null clears the manual status, so the calculated one shows again. */
        status: z.enum(HEALTH_STATUSES).nullable(),
        note: z.string().trim().max(280).nullable().default(null),
    })
    .strict();

/** Sets or clears a project's manual health status. Editors and owners; recorded in the history. */
export async function setProjectHealth(db: D1Database, user: PortalUser, projectId: string, input: unknown) {
    const body = healthInput.parse(input);
    const project = await requireProject(db, user, projectId, "editor");
    requireWritable(project);
    const now = nowIso();
    try {
        await db.batch([
            db
                .prepare(
                    `UPDATE task_projects SET health_override = ?, health_note = ?, health_set_by = ?, health_set_at = ?,
                        version = version + 1, updated_by = ?, updated_at = ? WHERE id = ? AND version = ?`,
                )
                .bind(
                    body.status,
                    body.status ? body.note || null : null,
                    body.status ? user.email : null,
                    body.status ? now : null,
                    user.email,
                    now,
                    projectId,
                    body.version,
                ),
            requireChange(db),
            // The status is recorded; the note (free text) isn't.
            activity(db, { projectId, actor: user.email, action: "project.health", changes: { health: body.status } }),
        ]);
    } catch (error) {
        if (isGuardFailure(error)) throw new ProjectConflict();
        throw error;
    }
}
