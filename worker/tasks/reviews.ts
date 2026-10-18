// Project reviews: a short, guided look at a project (what's been done since last time, what's
// overdue, what's coming, what has nobody responsible or no date), a note, the health the reviewer
// records, and the next actions they decide on. Everything shown is a query; nothing is generated.
//
// A review belongs to its project and follows its membership: members read reviews, editors and
// owners start, edit, complete and discard them. A project has at most one draft (a partial unique
// index), so two people starting a review at once share it, and edits carry a version so neither
// overwrites the other silently. Completing records the project's numbers at that moment (counts
// only). Next actions are ordinary tasks in the project, created only when the reviewer adds each
// one explicitly; the review remembers which they were.
import type { D1Database } from "@cloudflare/workers-types";
import { z } from "zod";
import type { PortalUser } from "../../src/shared/portal/types";
import { addDays } from "../../src/shared/tasks/dates";
import { HEALTH_STATUSES, type HealthStatus, type ProjectReview, type ReviewSnapshot, type ReviewWorkspace } from "../../src/shared/tasks/productivity";
import type { TaskSummary } from "../../src/shared/tasks/types";
import { isGuardFailure, newId, nowIso, parseJson, requireChange } from "../portal/db";
import { HttpError } from "../portal/http";
import { notFound, preferences, requireProject, requireWritable, todayFor } from "./access";
import { activity } from "./activity";
import { measureProject } from "./health";
import { TASK_COLUMNS } from "./rows";
import { createTask } from "./tasks";
import { all } from "./views";

export class ReviewConflict extends HttpError {
    constructor() {
        super(409, "conflict", "Someone else changed this review since you opened it. Reload to see their changes; yours haven't been saved.");
    }
}

interface ReviewRow {
    id: string;
    project_id: string;
    status: "draft" | "completed";
    note: string;
    health: HealthStatus | null;
    period_start: string | null;
    snapshot_json: string | null;
    started_by: string;
    started_at: string;
    completed_by: string | null;
    completed_at: string | null;
    version: number;
}

const REVIEW_COLUMNS =
    "r.id, r.project_id, r.status, r.note, r.health, r.period_start, r.snapshot_json, r.started_by, r.started_at, r.completed_by, r.completed_at, r.version";

/** The review, if the caller is a member of its project (404 otherwise, whether it exists or not). */
async function requireReview(db: D1Database, user: PortalUser, reviewId: string, minimum: "viewer" | "editor" = "viewer") {
    const row = await db
        .prepare(
            `SELECT ${REVIEW_COLUMNS} FROM task_project_reviews r JOIN task_project_members m ON m.project_id = r.project_id AND m.email = ? WHERE r.id = ?`,
        )
        .bind(user.email, reviewId)
        .first<ReviewRow>();
    if (!row) throw notFound();
    const project = await requireProject(db, user, row.project_id, minimum);
    return { row, project };
}

/** Next actions created from these reviews, as the caller can see them now (tasks moved away are left out). */
async function actionsFor(db: D1Database, email: string, reviewId: string): Promise<TaskSummary[]> {
    return all(
        db,
        `SELECT ${TASK_COLUMNS} FROM task_review_actions a JOIN task_items t ON t.id = a.task_id
         JOIN task_project_members m ON m.project_id = t.project_id AND m.email = ?1
         WHERE a.review_id = ?2 ORDER BY a.created_at LIMIT 50`,
        [email, reviewId],
    );
}

const toReview = (r: ReviewRow, actions: TaskSummary[]): ProjectReview => ({
    id: r.id,
    projectId: r.project_id,
    status: r.status,
    note: r.note,
    health: r.health,
    periodStart: r.period_start,
    snapshot: parseJson<ReviewSnapshot | null>(r.snapshot_json, null),
    startedBy: r.started_by,
    startedAt: r.started_at,
    completedBy: r.completed_by,
    completedAt: r.completed_at,
    version: r.version,
    actions,
});

/** Everything the review screen shows, from the reviewed project only, through the caller's membership. */
async function workspace(db: D1Database, user: PortalUser, row: ReviewRow): Promise<ReviewWorkspace> {
    const prefs = await preferences(db, user.email);
    const today = await todayFor(db, user.email);
    const measured = (await measureProject(db, user.email, row.project_id, today, prefs.timeZone))!;
    const since = row.period_start ?? "0000";
    const scoped = `FROM task_items t JOIN task_project_members m ON m.project_id = t.project_id AND m.email = ?1 WHERE t.project_id = ?2`;
    const [completedSince, completedCount, overdue, upcoming, unresolved, actions] = await Promise.all([
        all(
            db,
            `SELECT ${TASK_COLUMNS} ${scoped} AND t.id IN (SELECT c.task_id FROM task_completions c JOIN task_items x ON x.id = c.task_id
                 WHERE x.project_id = ?2 AND c.kind = 'completed' AND c.undone_at IS NULL AND c.at > ?3)
             ORDER BY t.completed_at IS NULL, t.completed_at DESC, t.updated_at DESC LIMIT 50`,
            [user.email, row.project_id, since],
        ),
        db
            .prepare(
                `SELECT COUNT(*) AS n FROM task_completions c JOIN task_items t ON t.id = c.task_id
                 WHERE t.project_id = ? AND c.kind = 'completed' AND c.undone_at IS NULL AND c.at > ?`,
            )
            .bind(row.project_id, since)
            .first<{ n: number }>(),
        all(
            db,
            `SELECT ${TASK_COLUMNS} ${scoped} AND t.status = 'open' AND (t.due_date < ?3 OR t.deadline < ?3)
             ORDER BY COALESCE(t.deadline, t.due_date), t.priority LIMIT 50`,
            [user.email, row.project_id, today],
        ),
        all(
            db,
            `SELECT ${TASK_COLUMNS} ${scoped} AND t.status = 'open' AND (t.is_milestone = 1 OR t.deadline IS NOT NULL)
               AND COALESCE(t.deadline, t.due_date) BETWEEN ?3 AND ?4
             ORDER BY COALESCE(t.deadline, t.due_date), t.priority LIMIT 30`,
            [user.email, row.project_id, today, addDays(today, 29)],
        ),
        all(
            db,
            `SELECT ${TASK_COLUMNS} ${scoped} AND t.status = 'open' AND t.parent_id IS NULL
               AND ((t.due_date IS NULL AND t.deadline IS NULL) OR (?3 = 'shared' AND t.assignee_email IS NULL))
             ORDER BY t.priority, t.position LIMIT 30`,
            [user.email, row.project_id, measured.kind],
        ),
        actionsFor(db, user.email, row.id),
    ]);
    return {
        review: toReview(row, actions),
        health: measured.health,
        metrics: measured.metrics,
        completedSince,
        completedSinceCount: completedCount?.n ?? 0,
        overdue,
        upcoming,
        unresolved,
    };
}

/**
 * Starts a review of the project, or returns the draft already in progress. The period it covers
 * starts when the previous review was completed (or, for a first review, at the beginning).
 */
export async function startReview(db: D1Database, user: PortalUser, projectId: string): Promise<ReviewWorkspace> {
    const project = await requireProject(db, user, projectId, "editor");
    requireWritable(project);
    if (project.is_inbox) throw new HttpError(422, "validation", "The Inbox isn't reviewed like a project");
    const now = nowIso();
    const id = newId("trv");
    await db.batch([
        db
            .prepare(
                `INSERT INTO task_project_reviews (id, project_id, status, period_start, started_by, started_at, updated_at)
                 SELECT ?, ?, 'draft', (SELECT MAX(completed_at) FROM task_project_reviews WHERE project_id = ? AND status = 'completed'), ?, ?, ?
                 WHERE 1 ON CONFLICT DO NOTHING`,
            )
            .bind(id, projectId, projectId, user.email, now, now),
        activity(db, { projectId, actor: user.email, action: "review.start" }, "WHERE changes() > 0"),
    ]);
    const draft = await db
        .prepare(`SELECT ${REVIEW_COLUMNS} FROM task_project_reviews r WHERE r.project_id = ? AND r.status = 'draft'`)
        .bind(projectId)
        .first<ReviewRow>();
    if (!draft) throw new Error("Review could not be started");
    return workspace(db, user, draft);
}

export async function getReview(db: D1Database, user: PortalUser, reviewId: string): Promise<ReviewWorkspace> {
    const { row } = await requireReview(db, user, reviewId);
    return workspace(db, user, row);
}

/** The project's draft, if one is in progress, without starting one. */
export async function draftFor(db: D1Database, user: PortalUser, projectId: string): Promise<{ id: string; startedBy: string } | null> {
    await requireProject(db, user, projectId);
    const row = await db
        .prepare("SELECT id, started_by FROM task_project_reviews WHERE project_id = ? AND status = 'draft'")
        .bind(projectId)
        .first<{ id: string; started_by: string }>();
    return row ? { id: row.id, startedBy: row.started_by } : null;
}

const editInput = z
    .object({
        version: z.number().int().min(1),
        note: z.string().max(5000, "Keep the note under 5,000 characters").optional(),
        health: z.enum(HEALTH_STATUSES).nullable().optional(),
    })
    .strict();

/** Saves the note or health of a draft. A stale version changes nothing (409). */
export async function updateReview(db: D1Database, user: PortalUser, reviewId: string, input: unknown): Promise<ProjectReview> {
    const body = editInput.parse(input);
    const { row, project } = await requireReview(db, user, reviewId, "editor");
    requireWritable(project);
    if (row.status !== "draft") throw new HttpError(422, "validation", "A completed review can't be changed");
    try {
        await db.batch([
            db
                .prepare(
                    `UPDATE task_project_reviews SET note = COALESCE(?, note), health = CASE WHEN ? THEN ? ELSE health END,
                        version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND status = 'draft'`,
                )
                .bind(body.note?.trimEnd() ?? null, body.health !== undefined ? 1 : 0, body.health ?? null, nowIso(), reviewId, body.version),
            requireChange(db),
        ]);
    } catch (error) {
        if (isGuardFailure(error)) throw new ReviewConflict();
        throw error;
    }
    const fresh = (await requireReview(db, user, reviewId)).row;
    return toReview(fresh, await actionsFor(db, user.email, reviewId));
}

/**
 * Completes the review: the note and health are saved, the project's numbers recorded, and the
 * project's next review is then due one period from now. Guarded on the version, so a completion
 * based on an out-of-date draft (or a second click) changes nothing.
 */
export async function completeReview(db: D1Database, user: PortalUser, reviewId: string, input: unknown): Promise<ProjectReview> {
    const body = editInput.parse(input);
    const { row, project } = await requireReview(db, user, reviewId, "editor");
    requireWritable(project);
    if (row.status === "completed") return toReview(row, await actionsFor(db, user.email, reviewId));
    const ws = await workspace(db, user, row);
    const health = body.health !== undefined ? body.health : (row.health ?? ws.health.status);
    const snapshot: ReviewSnapshot = {
        open: ws.metrics.open,
        completed: ws.metrics.completed,
        overdue: ws.metrics.overdue,
        completedSince: ws.completedSinceCount,
        unassigned: ws.metrics.unassigned,
        undated: ws.metrics.undated,
        health: ws.health.calculated,
    };
    const now = nowIso();
    try {
        await db.batch([
            db
                .prepare(
                    `UPDATE task_project_reviews SET status = 'completed', note = COALESCE(?, note), health = ?, snapshot_json = ?,
                        completed_by = ?, completed_at = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND status = 'draft'`,
                )
                .bind(body.note?.trimEnd() ?? null, health, JSON.stringify(snapshot), user.email, now, now, reviewId, body.version),
            requireChange(db),
            activity(db, { projectId: row.project_id, actor: user.email, action: "review.complete", changes: { health } }),
        ]);
    } catch (error) {
        if (isGuardFailure(error)) {
            const current = (await requireReview(db, user, reviewId)).row;
            if (current.status === "completed") return toReview(current, await actionsFor(db, user.email, reviewId));
            throw new ReviewConflict();
        }
        throw error;
    }
    return toReview((await requireReview(db, user, reviewId)).row, await actionsFor(db, user.email, reviewId));
}

/** Discards a draft. Next actions already created stay: they're ordinary tasks. */
export async function discardReview(db: D1Database, user: PortalUser, reviewId: string) {
    const { row, project } = await requireReview(db, user, reviewId, "editor");
    requireWritable(project);
    if (row.status !== "draft") throw new HttpError(422, "validation", "Completed reviews are kept as the project's history");
    await db.batch([
        db.prepare("DELETE FROM task_project_reviews WHERE id = ? AND status = 'draft'").bind(reviewId),
        activity(db, { projectId: row.project_id, actor: user.email, action: "review.discard" }, "WHERE changes() > 0"),
    ]);
}

/**
 * Adds one next action: an ordinary task in the reviewed project, created and remembered against
 * the review in one batch. The reviewer types each one; nothing is extracted from the note.
 */
export async function addReviewAction(db: D1Database, user: PortalUser, reviewId: string, input: unknown): Promise<ProjectReview> {
    const { row, project } = await requireReview(db, user, reviewId, "editor");
    requireWritable(project);
    if (row.status !== "draft") throw new HttpError(422, "validation", "Add next actions before completing the review");
    const fields = z.object({}).passthrough().parse(input);
    if ("parentId" in fields || "knowledge" in fields || (fields.projectId !== undefined && fields.projectId !== row.project_id))
        throw new HttpError(422, "validation", "A next action is a new task in the project being reviewed");
    const now = nowIso();
    await createTask(
        db,
        user,
        { ...fields, projectId: row.project_id },
        {
            requireProjectId: row.project_id,
            extra: (taskId) => [db.prepare("INSERT INTO task_review_actions (review_id, task_id, created_at) VALUES (?, ?, ?)").bind(reviewId, taskId, now)],
        },
    );
    return toReview((await requireReview(db, user, reviewId)).row, await actionsFor(db, user.email, reviewId));
}

/** Completed reviews of a project, newest first, 20 at a time. */
export async function listReviews(db: D1Database, user: PortalUser, projectId: string, before: string | null) {
    await requireProject(db, user, projectId);
    const rows = await db
        .prepare(
            `SELECT ${REVIEW_COLUMNS} FROM task_project_reviews r WHERE r.project_id = ? AND r.status = 'completed' ${before ? "AND r.completed_at < ?" : ""}
             ORDER BY r.completed_at DESC LIMIT 21`,
        )
        .bind(projectId, ...(before ? [before] : []))
        .all<ReviewRow>();
    const page = rows.results.slice(0, 20);
    const reviews = await Promise.all(page.map(async (r) => toReview(r, await actionsFor(db, user.email, r.id))));
    return { reviews, hasMore: rows.results.length > 20 };
}
