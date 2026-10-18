// Goals: what someone (or the household) is working towards, with progress worked out from linked
// projects and tasks or entered by hand, milestones and a history.
//
// Access works like projects. Every goal is reached through the caller's own task_goal_members row
// (404 for anyone else, whether it exists or not). A personal goal has exactly one member (a trigger
// enforces it). A shared goal is shared only with the people its owners add: linking it to a shared
// project shares nothing, and being a member of that project grants nothing here.
//
// Links are filtered per reader, always. Progress, "what's next" and the linked lists count only
// projects and tasks the reader is a member of right now, and Knowledge objects they can read right
// now; anything else is left out entirely (not even "hidden"). A shared goal can link only shared
// projects and tasks in shared projects (checked here and by triggers), so a personal project can
// never feed a shared goal.
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { z } from "zod";
import type { PortalUser } from "../../src/shared/portal/types";
import {
    ACTIVE_GOAL_STATUSES,
    GOAL_STATUSES,
    type GoalDetail,
    type GoalMilestone,
    type GoalProgressEvent,
    type GoalStatus,
    type TaskGoal,
    goalAttention,
    goalFields,
    manualPercent,
} from "../../src/shared/tasks/productivity";
import { PROJECT_ROLES, type ProjectRole, type TaskColor, roleAtLeast } from "../../src/shared/tasks/types";
import type { Env } from "../env";
import { requireObject } from "../knowledge/access";
import { can } from "../portal/auth";
import { chunk, isGuardFailure, newId, nowIso, placeholders, requireChange } from "../portal/db";
import { HttpError } from "../portal/http";
import { canUseTasks, notFound, requireProject, requireTask, todayFor } from "./access";
import { TASK_COLUMNS, type TaskRow, toSummary } from "./rows";
import { all } from "./views";

const invalid = (message: string) => new HttpError(422, "validation", message);

export class GoalConflict extends HttpError {
    constructor() {
        super(409, "conflict", "This goal changed since you opened it. Reload to see the latest version; your changes haven't been saved.");
    }
}

interface GoalRow {
    id: string;
    kind: "personal" | "shared";
    title: string;
    description: string;
    status: GoalStatus;
    progress_mode: "tasks" | "manual";
    unit: string | null;
    start_value: number;
    target_value: number | null;
    current_value: number;
    target_date: string | null;
    achieved_at: string | null;
    archived_at: string | null;
    version: number;
    created_at: string;
    updated_at: string;
    role: ProjectRole;
    member_count: number;
}

const GOAL_COLUMNS = `g.id, g.kind, g.title, g.description, g.status, g.progress_mode, g.unit, g.start_value, g.target_value, g.current_value,
    g.target_date, g.achieved_at, g.archived_at, g.version, g.created_at, g.updated_at, gm.role,
    (SELECT COUNT(*) FROM task_goal_members x WHERE x.goal_id = g.id) AS member_count`;
const MY_GOALS = "FROM task_goals g JOIN task_goal_members gm ON gm.goal_id = g.id AND gm.email = ?";

async function requireGoal(db: D1Database, user: PortalUser, goalId: string, minimum: ProjectRole = "viewer"): Promise<GoalRow> {
    const row = await db.prepare(`SELECT ${GOAL_COLUMNS} ${MY_GOALS} WHERE g.id = ?`).bind(user.email, goalId).first<GoalRow>();
    if (!row) throw notFound();
    if (!roleAtLeast(row.role, minimum))
        throw new HttpError(403, "forbidden", minimum === "owner" ? "Only the goal's owners can do that" : "You can only view this goal");
    return row;
}

/**
 * Task progress for each goal as `email` sees it: linked projects' tasks and directly linked tasks,
 * each counted once, only where the reader is a member of the task's project.
 */
async function taskProgress(db: D1Database, email: string, goalIds: string[]) {
    const out = new Map<string, { total: number; done: number }>();
    for (const part of chunk(goalIds, 40)) {
        if (!part.length) continue;
        const ids = placeholders(part.length);
        const rows = await db
            .prepare(
                `WITH visible AS (
                    SELECT l.goal_id, t.id, t.status FROM task_goal_links l JOIN task_items t ON t.project_id = l.project_id
                    JOIN task_project_members m ON m.project_id = t.project_id AND m.email = ?
                    WHERE l.project_id IS NOT NULL AND l.goal_id IN (${ids})
                    UNION
                    SELECT l.goal_id, t.id, t.status FROM task_goal_links l JOIN task_items t ON t.id = l.task_id
                    JOIN task_project_members m ON m.project_id = t.project_id AND m.email = ?
                    WHERE l.task_id IS NOT NULL AND l.goal_id IN (${ids})
                 ) SELECT goal_id, COUNT(*) AS total, SUM(status = 'completed') AS done FROM visible GROUP BY goal_id`,
            )
            .bind(email, ...part, email, ...part)
            .all<{ goal_id: string; total: number; done: number }>();
        for (const r of rows.results) out.set(r.goal_id, { total: r.total, done: r.done ?? 0 });
    }
    return out;
}

async function milestoneSummary(db: D1Database, goalIds: string[]) {
    const out = new Map<string, { done: number; total: number; next: GoalMilestone | null }>();
    for (const part of chunk(goalIds, 50)) {
        if (!part.length) continue;
        const rows = await db
            .prepare(
                `SELECT id, goal_id, title, target_date, done_at, done_by FROM task_goal_milestones WHERE goal_id IN (${placeholders(part.length)})
                 ORDER BY done_at IS NOT NULL, target_date IS NULL, target_date, position LIMIT 2000`,
            )
            .bind(...part)
            .all<{ id: string; goal_id: string; title: string; target_date: string | null; done_at: string | null; done_by: string | null }>();
        for (const r of rows.results) {
            const entry = out.get(r.goal_id) ?? { done: 0, total: 0, next: null };
            entry.total++;
            if (r.done_at) entry.done++;
            else entry.next ??= { id: r.id, title: r.title, targetDate: r.target_date, doneAt: null, doneBy: null };
            out.set(r.goal_id, entry);
        }
    }
    return out;
}

async function toGoals(db: D1Database, email: string, rows: GoalRow[], today: string): Promise<TaskGoal[]> {
    const ids = rows.map((r) => r.id);
    const [progress, milestones] = await Promise.all([taskProgress(db, email, ids), milestoneSummary(db, ids)]);
    return rows.map((r) => {
        const tasks = progress.get(r.id) ?? { total: 0, done: 0 };
        const percent =
            r.status === "achieved"
                ? 100
                : r.progress_mode === "manual"
                  ? manualPercent(r.start_value, r.current_value, r.target_value)
                  : tasks.total
                    ? Math.round((tasks.done / tasks.total) * 100)
                    : null;
        return {
            id: r.id,
            kind: r.kind,
            title: r.title,
            description: r.description,
            status: r.status,
            role: r.role,
            targetDate: r.target_date,
            achievedAt: r.achieved_at,
            archivedAt: r.archived_at,
            progress: {
                mode: r.progress_mode,
                percent,
                done: tasks.done,
                total: tasks.total,
                unit: r.unit,
                start: r.start_value,
                current: r.current_value,
                target: r.target_value,
            },
            milestones: milestones.get(r.id) ?? { done: 0, total: 0, next: null },
            memberCount: r.member_count,
            version: r.version,
            createdAt: r.created_at,
            updatedAt: r.updated_at,
            attention: r.archived_at ? null : goalAttention({ status: r.status, targetDate: r.target_date, percent }, today),
        };
    });
}

/** The caller's goals: active first (by target date), then the rest. Archived ones only when asked for. */
export async function listGoals(
    db: D1Database,
    email: string,
    today: string,
    options: { archived?: boolean; kind?: "personal" | "shared"; activeOnly?: boolean } = {},
): Promise<TaskGoal[]> {
    const where = [options.archived ? "g.archived_at IS NOT NULL" : "g.archived_at IS NULL"];
    const binds: unknown[] = [email];
    if (options.kind) (where.push("g.kind = ?"), binds.push(options.kind));
    if (options.activeOnly) where.push(`g.status IN (${ACTIVE_GOAL_STATUSES.map((s) => `'${s}'`).join(", ")})`);
    const rows = await db
        .prepare(
            `SELECT ${GOAL_COLUMNS} ${MY_GOALS} WHERE ${where.join(" AND ")}
             ORDER BY g.status IN ('achieved', 'abandoned'), g.status = 'on_hold', g.target_date IS NULL, g.target_date, g.title COLLATE NOCASE LIMIT 200`,
        )
        .bind(...binds)
        .all<GoalRow>();
    return toGoals(db, email, rows.results, today);
}

const event = (
    db: D1Database,
    goalId: string,
    by: string,
    entry: { kind: GoalProgressEvent["kind"]; value?: number | null; status?: string | null; note?: string },
) =>
    db
        .prepare("INSERT INTO task_goal_progress (goal_id, kind, value, status, note, at, by) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(goalId, entry.kind, entry.value ?? null, entry.status ?? null, entry.note ?? "", nowIso(), by);

const checkManual = (mode: "tasks" | "manual", start: number, target: number | null) => {
    if (mode === "manual" && (target === null || target === start)) throw invalid("Give a target that's different from the starting value");
};

const createInput = z
    .object({
        title: goalFields.title,
        description: goalFields.description.default(""),
        kind: z.enum(["personal", "shared"]).default("personal"),
        status: z.enum(["not_started", "in_progress"]).default("not_started"),
        targetDate: goalFields.targetDate.default(null),
        progressMode: goalFields.progressMode.default("tasks"),
        unit: goalFields.unit.default(null),
        startValue: goalFields.startValue.default(0),
        targetValue: goalFields.targetValue.default(null),
        /** Projects to link straight away (each checked like any link). */
        projectIds: z
            .array(z.string().regex(/^tpj_[a-z0-9]{14}$/))
            .max(10)
            .default([]),
    })
    .strict();

export async function createGoal(db: D1Database, user: PortalUser, input: unknown): Promise<string> {
    const body = createInput.parse(input);
    checkManual(body.progressMode, body.startValue, body.targetValue);
    const id = newId("tgl");
    const now = nowIso();
    const links: D1PreparedStatement[] = [];
    for (const projectId of [...new Set(body.projectIds)]) links.push(await linkStatement(db, user, id, body.kind, { projectId }, now));
    await db.batch([
        db
            .prepare(
                `INSERT INTO task_goals (id, kind, title, description, status, progress_mode, unit, start_value, target_value, current_value, target_date,
                    created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
                id,
                body.kind,
                body.title,
                body.description,
                body.status,
                body.progressMode,
                body.progressMode === "manual" ? body.unit : null,
                body.startValue,
                body.progressMode === "manual" ? body.targetValue : null,
                body.startValue,
                body.targetDate,
                user.email,
                user.email,
                now,
                now,
            ),
        db
            .prepare("INSERT INTO task_goal_members (goal_id, email, role, added_by, created_at) VALUES (?, ?, 'owner', ?, ?)")
            .bind(id, user.email, user.email, now),
        event(db, id, user.email, { kind: "created", status: body.status, value: body.progressMode === "manual" ? body.startValue : null }),
        ...links,
    ]);
    return id;
}

/** The goal as the caller sees it, with everything its page shows. */
export async function goalDetail(db: D1Database, user: PortalUser, goalId: string): Promise<GoalDetail> {
    const row = await requireGoal(db, user, goalId);
    const today = await todayFor(db, user.email);
    const [goal] = await toGoals(db, user.email, [row], today);
    const [members, milestones, history, projects, tasks, next, knowledge] = await Promise.all([
        db
            .prepare(
                `SELECT m.email, u.name, m.role FROM task_goal_members m LEFT JOIN portal_users u ON u.email = m.email
                 WHERE m.goal_id = ? ORDER BY m.role = 'owner' DESC, m.email`,
            )
            .bind(goalId)
            .all<{ email: string; name: string | null; role: ProjectRole }>(),
        db
            .prepare("SELECT id, title, target_date, done_at, done_by FROM task_goal_milestones WHERE goal_id = ? ORDER BY position LIMIT 100")
            .bind(goalId)
            .all<{ id: string; title: string; target_date: string | null; done_at: string | null; done_by: string | null }>(),
        db
            .prepare(
                `SELECT e.id, e.kind, e.value, e.status, e.note, e.at, e.by, u.name AS by_name FROM task_goal_progress e
                 LEFT JOIN portal_users u ON u.email = e.by WHERE e.goal_id = ? ORDER BY e.id DESC LIMIT 100`,
            )
            .bind(goalId)
            .all<{
                id: number;
                kind: GoalProgressEvent["kind"];
                value: number | null;
                status: GoalStatus | null;
                note: string;
                at: string;
                by: string;
                by_name: string | null;
            }>(),
        db
            .prepare(
                `SELECT l.id AS link_id, p.id, p.name, p.color, p.kind,
                        (SELECT COUNT(*) FROM task_items t WHERE t.project_id = p.id AND t.status = 'open') AS open,
                        (SELECT COUNT(*) FROM task_items t WHERE t.project_id = p.id AND t.status = 'completed') AS completed
                 FROM task_goal_links l JOIN task_projects p ON p.id = l.project_id
                 JOIN task_project_members m ON m.project_id = p.id AND m.email = ?
                 WHERE l.goal_id = ? ORDER BY p.name COLLATE NOCASE LIMIT 50`,
            )
            .bind(user.email, goalId)
            .all<{ link_id: string; id: string; name: string; color: TaskColor; kind: "personal" | "shared"; open: number; completed: number }>(),
        db
            .prepare(
                `SELECT ${TASK_COLUMNS}, l.id AS link_id FROM task_goal_links l JOIN task_items t ON t.id = l.task_id
                 JOIN task_project_members m ON m.project_id = t.project_id AND m.email = ?1
                 WHERE l.goal_id = ?2 ORDER BY t.status = 'completed', t.due_date IS NULL, t.due_date LIMIT 100`,
            )
            .bind(user.email, goalId)
            .all<TaskRow & { link_id: string }>(),
        all(
            db,
            `SELECT ${TASK_COLUMNS} FROM task_items t JOIN task_project_members m ON m.project_id = t.project_id AND m.email = ?1
             WHERE t.status = 'open' AND (t.due_date IS NOT NULL OR t.deadline IS NOT NULL) AND (
                t.project_id IN (SELECT project_id FROM task_goal_links WHERE goal_id = ?2 AND project_id IS NOT NULL)
                OR t.id IN (SELECT task_id FROM task_goal_links WHERE goal_id = ?2 AND task_id IS NOT NULL))
             ORDER BY COALESCE(MIN(t.due_date, t.deadline), t.due_date, t.deadline), t.priority LIMIT 8`,
            [user.email, goalId],
        ),
        goalKnowledge(db, user, goalId),
    ]);
    return {
        goal,
        members: members.results,
        milestones: milestones.results.map((m) => ({ id: m.id, title: m.title, targetDate: m.target_date, doneAt: m.done_at, doneBy: m.done_by })),
        history: history.results.map((e) => ({
            id: e.id,
            kind: e.kind,
            value: e.value,
            status: e.status,
            note: e.note,
            at: e.at,
            by: e.by,
            byName: e.by_name,
        })),
        projects: projects.results.map((p) => ({
            id: p.id,
            linkId: p.link_id,
            name: p.name,
            color: p.color,
            kind: p.kind,
            open: p.open,
            completed: p.completed,
        })),
        tasks: tasks.results.map((t) => ({ ...toSummary(t), linkId: t.link_id })),
        next,
        knowledge,
    };
}

/** Knowledge objects linked to the goal that the caller can read now; everything else is left out. */
async function goalKnowledge(db: D1Database, user: PortalUser, goalId: string): Promise<GoalDetail["knowledge"]> {
    if (!can(user, "knowledge.use")) return [];
    const rows = await db
        .prepare(
            `SELECT l.id, o.id AS object_id, o.title, s.name AS space_name FROM task_goal_links l
             JOIN knowledge_objects o ON o.id = l.object_id AND o.status <> 'trashed'
             JOIN knowledge_spaces s ON s.id = o.space_id
             JOIN knowledge_memberships km ON km.space_id = o.space_id AND km.email = ?
             WHERE l.goal_id = ? ORDER BY l.added_at LIMIT 50`,
        )
        .bind(user.email, goalId)
        .all<{ id: string; object_id: string; title: string; space_name: string }>();
    return rows.results.map((r) => ({ linkId: r.id, available: true as const, objectId: r.object_id, title: r.title || "Untitled", spaceName: r.space_name }));
}

const updateInput = z
    .object({
        version: z.number().int().min(1),
        title: goalFields.title.optional(),
        description: goalFields.description.optional(),
        status: z.enum(GOAL_STATUSES).optional(),
        targetDate: goalFields.targetDate.optional(),
        progressMode: goalFields.progressMode.optional(),
        unit: goalFields.unit.optional(),
        startValue: goalFields.startValue.optional(),
        targetValue: goalFields.targetValue.optional(),
        /** A short note for the history when the status changes. */
        note: z.string().trim().max(500).optional(),
    })
    .strict();

export async function updateGoal(db: D1Database, user: PortalUser, goalId: string, input: unknown) {
    const body = updateInput.parse(input);
    const goal = await requireGoal(db, user, goalId, "editor");
    if (goal.archived_at) throw invalid("This goal is archived. Restore it to make changes.");
    const mode = body.progressMode ?? goal.progress_mode;
    const start = body.startValue ?? goal.start_value;
    const target = body.targetValue !== undefined ? body.targetValue : goal.target_value;
    checkManual(mode, start, target);
    const sets: string[] = [];
    const binds: unknown[] = [];
    const set = (column: string, value: unknown) => (sets.push(`${column} = ?`), binds.push(value));
    if (body.title !== undefined) set("title", body.title);
    if (body.description !== undefined) set("description", body.description);
    if (body.targetDate !== undefined) set("target_date", body.targetDate);
    if (body.progressMode !== undefined) set("progress_mode", body.progressMode);
    if (mode === "manual") {
        if (body.unit !== undefined) set("unit", body.unit);
        if (body.startValue !== undefined) set("start_value", body.startValue);
        if (body.targetValue !== undefined) set("target_value", body.targetValue);
    } else if (body.progressMode === "tasks") (set("unit", null), set("target_value", null));
    const statusChanged = body.status !== undefined && body.status !== goal.status;
    if (statusChanged) {
        set("status", body.status);
        set("achieved_at", body.status === "achieved" ? nowIso() : null);
    }
    if (!sets.length) return;
    const edited = Object.keys(body).some((k) => !["version", "status", "note"].includes(k));
    try {
        await db.batch([
            db
                .prepare(`UPDATE task_goals SET ${sets.join(", ")}, version = version + 1, updated_by = ?, updated_at = ? WHERE id = ? AND version = ?`)
                .bind(...binds, user.email, nowIso(), goalId, body.version),
            requireChange(db),
            ...(statusChanged ? [event(db, goalId, user.email, { kind: "status", status: body.status, note: body.note })] : []),
            ...(edited ? [event(db, goalId, user.email, { kind: "update" })] : []),
        ]);
    } catch (error) {
        if (isGuardFailure(error)) throw new GoalConflict();
        throw error;
    }
}

const progressInput = z.object({ version: z.number().int().min(1), value: goalFields.startValue, note: z.string().trim().max(500).default("") }).strict();

/** Records a new value for a manual goal. A not-started goal becomes in progress. */
export async function recordProgress(db: D1Database, user: PortalUser, goalId: string, input: unknown) {
    const body = progressInput.parse(input);
    const goal = await requireGoal(db, user, goalId, "editor");
    if (goal.archived_at) throw invalid("This goal is archived. Restore it to make changes.");
    if (goal.progress_mode !== "manual") throw invalid("This goal's progress comes from its tasks");
    try {
        await db.batch([
            db
                .prepare(
                    `UPDATE task_goals SET current_value = ?, status = CASE WHEN status = 'not_started' THEN 'in_progress' ELSE status END,
                        version = version + 1, updated_by = ?, updated_at = ? WHERE id = ? AND version = ?`,
                )
                .bind(body.value, user.email, nowIso(), goalId, body.version),
            requireChange(db),
            event(db, goalId, user.email, { kind: "value", value: body.value, note: body.note }),
        ]);
    } catch (error) {
        if (isGuardFailure(error)) throw new GoalConflict();
        throw error;
    }
}

export async function archiveGoal(db: D1Database, user: PortalUser, goalId: string, input: unknown) {
    const { archived } = z.object({ archived: z.boolean() }).strict().parse(input);
    await requireGoal(db, user, goalId, "owner");
    await db.batch([
        db
            .prepare("UPDATE task_goals SET archived_at = ?, version = version + 1, updated_by = ?, updated_at = ? WHERE id = ?")
            .bind(archived ? nowIso() : null, user.email, nowIso(), goalId),
        event(db, goalId, user.email, { kind: "update", note: archived ? "Archived" : "Restored" }),
    ]);
}

export async function deleteGoal(db: D1Database, user: PortalUser, goalId: string, input: unknown) {
    z.object({ confirm: z.literal("DELETE", { message: "Type DELETE to confirm" }) }).parse(input);
    await requireGoal(db, user, goalId, "owner");
    await db.prepare("DELETE FROM task_goals WHERE id = ?").bind(goalId).run();
}

/** Shares a personal goal, or makes a shared goal personal again once only its owner is left. */
export async function setGoalKind(db: D1Database, user: PortalUser, goalId: string, input: unknown) {
    const { kind } = z
        .object({ kind: z.enum(["personal", "shared"]) })
        .strict()
        .parse(input);
    const goal = await requireGoal(db, user, goalId, "owner");
    if (goal.kind === kind) return;
    if (kind === "shared") {
        // A shared goal can't draw on anything personal.
        const personal = await db
            .prepare(
                `SELECT COUNT(*) AS n FROM task_goal_links l
                 LEFT JOIN task_projects p ON p.id = l.project_id
                 LEFT JOIN task_items t ON t.id = l.task_id LEFT JOIN task_projects tp ON tp.id = t.project_id
                 WHERE l.goal_id = ? AND (p.kind = 'personal' OR tp.kind = 'personal')`,
            )
            .bind(goalId)
            .first<{ n: number }>();
        if (personal?.n) throw invalid("Remove the links to personal projects and tasks first: a shared goal can only draw on shared projects");
    } else if (goal.member_count > 1) throw invalid("Remove the other members first");
    await db.batch([
        db
            .prepare("UPDATE task_goals SET kind = ?, version = version + 1, updated_by = ?, updated_at = ? WHERE id = ?")
            .bind(kind, user.email, nowIso(), goalId),
        event(db, goalId, user.email, { kind: "update", note: kind === "shared" ? "Shared" : "Made personal" }),
    ]);
}

// --- Members -------------------------------------------------------------------------------------

export async function listGoalMembers(db: D1Database, goalId: string) {
    const rows = await db
        .prepare(
            `SELECT m.email, u.name, m.role FROM task_goal_members m LEFT JOIN portal_users u ON u.email = m.email
             WHERE m.goal_id = ? ORDER BY m.role = 'owner' DESC, m.email`,
        )
        .bind(goalId)
        .all<{ email: string; name: string | null; role: ProjectRole }>();
    return rows.results;
}

const memberInput = z.object({ email: z.string().trim().toLowerCase().max(254).pipe(z.email("Enter an email address")), role: z.enum(PROJECT_ROLES) }).strict();
const keepsAnOwner = (db: D1Database, goalId: string) =>
    db.prepare("INSERT INTO batch_guard (ok) SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM task_goal_members WHERE goal_id = ? AND role = 'owner')").bind(goalId);

export async function addGoalMember(env: Env, db: D1Database, user: PortalUser, goalId: string, input: unknown) {
    const goal = await requireGoal(db, user, goalId, "owner");
    if (goal.kind === "personal") throw invalid("Share the goal first, then add people");
    const body = memberInput.parse(input);
    if (!(await canUseTasks(env, db, body.email))) throw invalid("Add them to the portal as an owner or admin first (Portal settings → People and roles)");
    const [result] = await db.batch([
        db
            .prepare("INSERT OR IGNORE INTO task_goal_members (goal_id, email, role, added_by, created_at) VALUES (?, ?, ?, ?, ?)")
            .bind(goalId, body.email, body.role, user.email, nowIso()),
        event(db, goalId, user.email, { kind: "member", value: 1 }),
    ]);
    if (!result.meta.changes) throw new HttpError(409, "conflict", "They're already a member");
}

export async function updateGoalMember(db: D1Database, user: PortalUser, goalId: string, email: string, input: unknown) {
    await requireGoal(db, user, goalId, "owner");
    const { role } = z
        .object({ role: z.enum(PROJECT_ROLES) })
        .strict()
        .parse(input);
    try {
        await db.batch([
            db.prepare("UPDATE task_goal_members SET role = ? WHERE goal_id = ? AND email = ?").bind(role, goalId, email),
            requireChange(db),
            keepsAnOwner(db, goalId),
        ]);
    } catch (error) {
        if (isGuardFailure(error)) throw invalid("A shared goal needs at least one owner, and they must be a member");
        throw error;
    }
}

/** Owners remove anyone; anyone may leave a shared goal. Takes effect on their next request. */
export async function removeGoalMember(db: D1Database, user: PortalUser, goalId: string, email: string) {
    const goal = await requireGoal(db, user, goalId, email === user.email ? "viewer" : "owner");
    if (goal.kind === "personal") throw invalid("You can't leave your own personal goal");
    try {
        await db.batch([
            db.prepare("DELETE FROM task_goal_members WHERE goal_id = ? AND email = ?").bind(goalId, email),
            requireChange(db),
            keepsAnOwner(db, goalId),
            event(db, goalId, user.email, { kind: "member", value: -1 }),
        ]);
    } catch (error) {
        if (isGuardFailure(error)) throw invalid("A shared goal needs at least one owner");
        throw error;
    }
}

// --- Links ---------------------------------------------------------------------------------------

const linkInput = z.union([
    z.object({ projectId: z.string().regex(/^tpj_[a-z0-9]{14}$/) }).strict(),
    z.object({ taskId: z.string().regex(/^tsk_[a-z0-9]{14}$/) }).strict(),
    z.object({ objectId: z.string().regex(/^kob_[a-z0-9]{14}$/) }).strict(),
]);

/**
 * The insert for one link, after checking the caller can see what they're linking (404 otherwise)
 * and that a shared goal only draws on shared projects.
 */
async function linkStatement(
    db: D1Database,
    user: PortalUser,
    goalId: string,
    kind: "personal" | "shared",
    target: z.infer<typeof linkInput>,
    now: string,
): Promise<D1PreparedStatement> {
    const id = newId("tgk");
    if ("projectId" in target) {
        const project = await requireProject(db, user, target.projectId);
        if (kind === "shared" && project.kind !== "shared") throw invalid("A shared goal can only link shared projects");
        return db
            .prepare("INSERT OR IGNORE INTO task_goal_links (id, goal_id, project_id, added_by, added_at) VALUES (?, ?, ?, ?, ?)")
            .bind(id, goalId, project.id, user.email, now);
    }
    if ("taskId" in target) {
        const task = await requireTask(db, user, target.taskId);
        if (kind === "shared" && task.project_kind !== "shared") throw invalid("A shared goal can only link tasks in shared projects");
        return db
            .prepare("INSERT OR IGNORE INTO task_goal_links (id, goal_id, task_id, added_by, added_at) VALUES (?, ?, ?, ?, ?)")
            .bind(id, goalId, task.id, user.email, now);
    }
    if (!can(user, "knowledge.use")) throw new HttpError(403, "forbidden", "You don't have access to Knowledge");
    const object = await requireObject(db, user, target.objectId);
    if (object.status === "trashed") throw notFound();
    return db
        .prepare("INSERT OR IGNORE INTO task_goal_links (id, goal_id, object_id, added_by, added_at) VALUES (?, ?, ?, ?, ?)")
        .bind(id, goalId, object.id, user.email, now);
}

export async function linkGoal(db: D1Database, user: PortalUser, goalId: string, input: unknown) {
    const target = linkInput.parse(input);
    const goal = await requireGoal(db, user, goalId, "editor");
    if (goal.archived_at) throw invalid("This goal is archived. Restore it to make changes.");
    const count = await db.prepare("SELECT COUNT(*) AS n FROM task_goal_links WHERE goal_id = ?").bind(goalId).first<{ n: number }>();
    if ((count?.n ?? 0) >= 100) throw invalid("A goal can have at most 100 links");
    await db.batch([await linkStatement(db, user, goalId, goal.kind, target, nowIso()), event(db, goalId, user.email, { kind: "link", value: 1 })]);
}

/** Removes a link. Any editor of the goal can, even one who can't see what it points to. */
export async function unlinkGoal(db: D1Database, user: PortalUser, goalId: string, linkId: string) {
    await requireGoal(db, user, goalId, "editor");
    const result = await db.prepare("DELETE FROM task_goal_links WHERE id = ? AND goal_id = ?").bind(linkId, goalId).run();
    if (!result.meta.changes) throw notFound();
    await event(db, goalId, user.email, { kind: "link", value: -1 }).run();
}

// --- Milestones ----------------------------------------------------------------------------------

const milestoneFields = { title: z.string().trim().min(1, "Name the milestone").max(200), targetDate: goalFields.targetDate };

async function requireMilestone(db: D1Database, user: PortalUser, milestoneId: string) {
    const row = await db
        .prepare("SELECT id, goal_id, title, done_at FROM task_goal_milestones WHERE id = ?")
        .bind(milestoneId)
        .first<{ id: string; goal_id: string; title: string; done_at: string | null }>();
    if (!row) throw notFound();
    const goal = await requireGoal(db, user, row.goal_id, "editor").catch((error) => {
        throw error instanceof HttpError && error.status === 404 ? notFound() : error;
    });
    if (goal.archived_at) throw invalid("This goal is archived. Restore it to make changes.");
    return row;
}

export async function addMilestone(db: D1Database, user: PortalUser, goalId: string, input: unknown) {
    const body = z
        .object({ ...milestoneFields, targetDate: milestoneFields.targetDate.default(null) })
        .strict()
        .parse(input);
    const goal = await requireGoal(db, user, goalId, "editor");
    if (goal.archived_at) throw invalid("This goal is archived. Restore it to make changes.");
    const count = await db.prepare("SELECT COUNT(*) AS n FROM task_goal_milestones WHERE goal_id = ?").bind(goalId).first<{ n: number }>();
    if ((count?.n ?? 0) >= 50) throw invalid("A goal can have at most 50 milestones");
    await db
        .prepare(
            `INSERT INTO task_goal_milestones (id, goal_id, title, target_date, position, created_by, created_at)
             VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM task_goal_milestones WHERE goal_id = ?), ?, ?)`,
        )
        .bind(newId("tgm"), goalId, body.title, body.targetDate, goalId, user.email, nowIso())
        .run();
}

export async function updateMilestone(db: D1Database, user: PortalUser, milestoneId: string, input: unknown) {
    const body = z
        .object({ title: milestoneFields.title.optional(), targetDate: milestoneFields.targetDate.optional(), done: z.boolean().optional() })
        .strict()
        .parse(input);
    const milestone = await requireMilestone(db, user, milestoneId);
    const now = nowIso();
    const statements: D1PreparedStatement[] = [];
    if (body.title !== undefined || body.targetDate !== undefined)
        statements.push(
            db
                .prepare("UPDATE task_goal_milestones SET title = COALESCE(?, title), target_date = CASE WHEN ? THEN ? ELSE target_date END WHERE id = ?")
                .bind(body.title ?? null, body.targetDate !== undefined ? 1 : 0, body.targetDate ?? null, milestoneId),
        );
    if (body.done !== undefined && body.done !== !!milestone.done_at) {
        statements.push(
            db
                .prepare("UPDATE task_goal_milestones SET done_at = ?, done_by = ? WHERE id = ?")
                .bind(body.done ? now : null, body.done ? user.email : null, milestoneId),
            // The history records that a milestone was reached (or un-reached), with its title: goal members can all see it.
            event(db, milestone.goal_id, user.email, { kind: "milestone", value: body.done ? 1 : -1, note: (body.title ?? milestone.title).slice(0, 500) }),
        );
    }
    if (statements.length) await db.batch(statements);
}

export async function deleteMilestone(db: D1Database, user: PortalUser, milestoneId: string) {
    await requireMilestone(db, user, milestoneId);
    await db.prepare("DELETE FROM task_goal_milestones WHERE id = ?").bind(milestoneId).run();
}

/** Goals linked to a project that the caller is a member of (for the project overview). */
export async function goalsForProject(db: D1Database, email: string, projectId: string, today: string): Promise<TaskGoal[]> {
    const rows = await db
        .prepare(
            `SELECT ${GOAL_COLUMNS} ${MY_GOALS} WHERE g.archived_at IS NULL
             AND g.id IN (SELECT goal_id FROM task_goal_links WHERE project_id = ?) ORDER BY g.title COLLATE NOCASE LIMIT 20`,
        )
        .bind(email, projectId)
        .all<GoalRow>();
    return toGoals(db, email, rows.results, today);
}
