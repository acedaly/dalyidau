// Household routines: ongoing responsibilities (bins every Wednesday, smoke alarms every six months)
// built on one ordinary repeating task each.
//
// Nothing about the schedule is duplicated. The routine's schedule is the task's repeat rule (the
// same recurrence engine as every repeating task), its checklist is the task's subtasks (reopened for
// each occurrence), its history is the task's completions, who completed each one is recorded there,
// and who is responsible now is the task's assignee. task_routines adds only what a task can't hold:
// whether the routine is paused and how responsibility rotates. So routine state can't drift from
// task completion: completing the task from any list is completing the routine.
//
// Visibility is the project's: a routine in a personal project (the Inbox by default) is private; in
// a shared project, its members see it. Rotation ("take turns") is among people who can be assigned
// the task, in a fixed order; completing an occurrence passes it to the next person (done in the same
// batch as the completion, in tasks.ts), skipping one doesn't, and reassigning it by hand simply
// changes whose turn it is now. Missed occurrences aren't recreated, so they never move the turn on.
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { z } from "zod";
import type { PortalUser } from "../../src/shared/portal/types";
import { ROTATIONS, type Rotation, type RoutineCompletion, type TaskRoutine, nextInTurn } from "../../src/shared/tasks/productivity";
import { daysBetween, firstOnOrAfter, parseStoredRule, recurrenceInput } from "../../src/shared/tasks/recurrence";
import { type TaskColor, roleAtLeast } from "../../src/shared/tasks/types";
import { chunk, isGuardFailure, newId, nowIso, placeholders, requireChange } from "../portal/db";
import { HttpError } from "../portal/http";
import { notFound, requireTask, requireWritable, todayFor } from "./access";
import { activity } from "./activity";
import { relativeReminderStatements } from "./reminders";
import { TASK_COLUMNS, type TaskRow, toSummary } from "./rows";
import { createTask } from "./tasks";
import { participantsFor } from "./turns";

const invalid = (message: string) => new HttpError(422, "validation", message);

export class RoutineConflict extends HttpError {
    constructor() {
        super(409, "conflict", "This routine changed since you opened it. Reload to see the latest version.");
    }
}

interface RoutineRow extends TaskRow {
    routine_id: string;
    rotation: Rotation;
    paused_at: string | null;
    routine_version: number;
    p_name: string;
    p_kind: "personal" | "shared";
    p_inbox: number;
    p_color: TaskColor;
    p_status: string;
    role: "owner" | "editor" | "viewer";
}

const ROUTINE_FROM = `FROM task_routines ro JOIN task_items t ON t.id = ro.task_id
    JOIN task_project_members m ON m.project_id = t.project_id AND m.email = ?1
    JOIN task_projects p ON p.id = t.project_id`;
const ROUTINE_COLUMNS = `${TASK_COLUMNS}, ro.id AS routine_id, ro.rotation, ro.paused_at, ro.version AS routine_version,
    p.name AS p_name, p.kind AS p_kind, p.is_inbox AS p_inbox, p.color AS p_color, p.status AS p_status, m.role`;

/** The latest five completions and skips of each task, newest first. */
async function recentFor(db: D1Database, taskIds: string[]) {
    const out = new Map<string, RoutineCompletion[]>();
    for (const part of chunk(taskIds, 50)) {
        if (!part.length) continue;
        const rows = await db
            .prepare(
                `SELECT task_id, kind, occurrence_date, at, by, name FROM (
                    SELECT c.task_id, c.kind, c.occurrence_date, c.at, c.by, u.name, ROW_NUMBER() OVER (PARTITION BY c.task_id ORDER BY c.id DESC) AS n
                    FROM task_completions c LEFT JOIN portal_users u ON u.email = c.by
                    WHERE c.undone_at IS NULL AND c.task_id IN (${placeholders(part.length)})
                 ) WHERE n <= 5 ORDER BY task_id, at DESC`,
            )
            .bind(...part)
            .all<{ task_id: string; kind: "completed" | "skipped"; occurrence_date: string | null; at: string; by: string; name: string | null }>();
        for (const r of rows.results)
            (out.get(r.task_id) ?? out.set(r.task_id, []).get(r.task_id)!).push({
                kind: r.kind,
                occurrenceDate: r.occurrence_date,
                at: r.at,
                by: r.by,
                byName: r.name,
            });
    }
    return out;
}

async function toRoutines(db: D1Database, rows: RoutineRow[]): Promise<TaskRoutine[]> {
    const [participants, recent] = await Promise.all([
        participantsFor(
            db,
            rows.map((r) => r.routine_id),
        ),
        recentFor(
            db,
            rows.map((r) => r.id),
        ),
    ]);
    return rows.map((r) => {
        const people = participants.get(r.routine_id) ?? [];
        return {
            id: r.routine_id,
            task: toSummary(r),
            project: { id: r.project_id, name: r.p_name, kind: r.p_kind, isInbox: !!r.p_inbox, color: r.p_color },
            rotation: r.rotation,
            participants: people,
            responsible: r.assignee_email,
            nextUp:
                r.rotation === "turns"
                    ? nextInTurn(
                          people.map((p) => p.email),
                          r.assignee_email,
                      )
                    : null,
            paused: !!r.paused_at,
            pausedAt: r.paused_at,
            canEdit: roleAtLeast(r.role, "editor") && r.p_status !== "archived",
            version: r.routine_version,
            recent: recent.get(r.id) ?? [],
        };
    });
}

/**
 * The caller's routines: in every project they're a member of (personal ones are theirs alone),
 * soonest first. `scope` narrows to personal or shared projects; `dueBy` to those due by a date.
 */
export async function listRoutines(
    db: D1Database,
    email: string,
    options: { scope?: "personal" | "shared"; dueBy?: string; includePaused?: boolean; mineOnly?: boolean; limit?: number } = {},
): Promise<TaskRoutine[]> {
    const where = ["p.status <> 'archived'"];
    const binds: unknown[] = [email];
    if (options.scope) (where.push(`p.kind = ?${binds.length + 1}`), binds.push(options.scope));
    if (options.dueBy) (where.push(`t.status = 'open' AND t.due_date <= ?${binds.length + 1}`), binds.push(options.dueBy));
    if (options.includePaused === false) where.push("ro.paused_at IS NULL");
    if (options.mineOnly) where.push("(t.assignee_email IS NULL OR t.assignee_email = ?1)");
    const rows = await db
        .prepare(
            `SELECT ${ROUTINE_COLUMNS} ${ROUTINE_FROM} WHERE ${where.join(" AND ")}
             ORDER BY ro.paused_at IS NOT NULL, t.status = 'completed', t.due_date IS NULL, t.due_date, t.title COLLATE NOCASE LIMIT ${Math.min(options.limit ?? 200, 200)}`,
        )
        .bind(...binds)
        .all<RoutineRow>();
    return toRoutines(db, rows.results);
}

async function requireRoutine(db: D1Database, user: PortalUser, routineId: string, minimum: "viewer" | "editor" = "viewer") {
    const row = await db.prepare(`SELECT ${ROUTINE_COLUMNS} ${ROUTINE_FROM} WHERE ro.id = ?2`).bind(user.email, routineId).first<RoutineRow>();
    if (!row) throw notFound();
    if (!roleAtLeast(row.role, minimum)) throw new HttpError(403, "forbidden", "You can only view this routine");
    if (minimum !== "viewer" && row.p_status === "archived") throw invalid("This project is archived. Restore it to make changes.");
    return row;
}

export async function getRoutine(db: D1Database, user: PortalUser, routineId: string): Promise<TaskRoutine> {
    return (await toRoutines(db, [await requireRoutine(db, user, routineId)]))[0];
}

/** The routine built on this task, if there is one and the caller can see it. */
export async function routineForTask(db: D1Database, user: PortalUser, taskId: string): Promise<TaskRoutine | null> {
    const row = await db.prepare(`SELECT ${ROUTINE_COLUMNS} ${ROUTINE_FROM} WHERE ro.task_id = ?2`).bind(user.email, taskId).first<RoutineRow>();
    return row ? (await toRoutines(db, [row]))[0] : null;
}

const emailList = z.array(z.string().trim().toLowerCase().max(254).pipe(z.email("Not a valid person"))).max(10, "At most 10 people take turns");

/** Checks that everyone taking turns can be assigned tasks in the project: an editor or owner of a shared project. */
async function checkParticipants(db: D1Database, projectId: string, kind: "personal" | "shared", rotation: Rotation, emails: string[]) {
    const unique = [...new Set(emails)];
    if (unique.length !== emails.length) throw invalid("Each person can only be in the turns once");
    if (rotation === "none") return [];
    if (kind !== "shared") throw invalid("Taking turns needs a shared project: share it first");
    if (unique.length < 2) throw invalid("Choose at least two people to take turns");
    const rows = await db
        .prepare(`SELECT email FROM task_project_members WHERE project_id = ? AND role <> 'viewer' AND email IN (${placeholders(unique.length)})`)
        .bind(projectId, ...unique)
        .all<{ email: string }>();
    if (rows.results.length !== unique.length) throw invalid("Everyone taking turns must be an editor or owner of the project");
    return unique;
}

const participantStatements = (db: D1Database, routineId: string, emails: string[]) => [
    db.prepare("DELETE FROM task_routine_participants WHERE routine_id = ?").bind(routineId),
    ...emails.map((email, i) => db.prepare("INSERT INTO task_routine_participants (routine_id, email, position) VALUES (?, ?, ?)").bind(routineId, email, i)),
];

const newRoutineInput = z
    .object({
        title: z.string().max(1000),
        description: z.string().max(20_000).default(""),
        projectId: z
            .string()
            .regex(/^tpj_[a-z0-9]{14}$/)
            .optional(),
        priority: z.number().int().min(1).max(4).optional(),
        dueDate: z.string().nullable().optional(),
        dueTime: z.string().nullable().optional(),
        recurrence: recurrenceInput,
        rotation: z.enum(ROTATIONS).default("none"),
        participants: emailList.default([]),
        assignee: z.string().nullable().optional(),
        checklist: z.array(z.string().trim().min(1).max(200)).max(30, "At most 30 checklist items").default([]),
        clientId: z.string().optional(),
    })
    .strict();

const convertInput = z
    .object({ taskId: z.string().regex(/^tsk_[a-z0-9]{14}$/), rotation: z.enum(ROTATIONS).default("none"), participants: emailList.default([]) })
    .strict();

/**
 * A new routine: a repeating task (with its checklist as subtasks) and the routine, in one batch.
 * Or, given `taskId`, an existing repeating task becomes a routine. A task is one routine at most.
 */
export async function createRoutine(db: D1Database, user: PortalUser, input: unknown): Promise<TaskRoutine> {
    if (input && typeof input === "object" && "taskId" in input) return convertToRoutine(db, user, convertInput.parse(input));
    const body = newRoutineInput.parse(input);
    const routineId = newId("trt");
    const now = nowIso();
    // Participants are checked against the destination project before anything is written.
    let participants: string[] = [];
    const { task, replayed } = await createTask(
        db,
        user,
        {
            title: body.title,
            description: body.description,
            ...(body.projectId ? { projectId: body.projectId } : {}),
            ...(body.priority ? { priority: body.priority } : {}),
            ...(body.dueDate !== undefined ? { dueDate: body.dueDate } : {}),
            ...(body.dueTime !== undefined ? { dueTime: body.dueTime } : {}),
            recurrence: body.recurrence,
            ...(body.rotation === "turns" && body.participants.length
                ? { assignee: body.participants[0] }
                : body.assignee !== undefined
                  ? { assignee: body.assignee }
                  : {}),
            ...(body.clientId ? { clientId: body.clientId } : {}),
        },
        {
            extra: (taskId, projectId) => [
                db
                    .prepare("INSERT INTO task_routines (id, task_id, rotation, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
                    .bind(routineId, taskId, body.rotation, user.email, now, now),
                ...participants.map((email, i) =>
                    db.prepare("INSERT INTO task_routine_participants (routine_id, email, position) VALUES (?, ?, ?)").bind(routineId, email, i),
                ),
                ...body.checklist.map((title, i) =>
                    db
                        .prepare(
                            `INSERT INTO task_items (id, project_id, section_id, parent_id, depth, title, position, created_by, updated_by, created_at, updated_at)
                             VALUES (?, ?, NULL, ?, 1, ?, ?, ?, ?, ?, ?)`,
                        )
                        .bind(newId("tsk"), projectId, taskId, title.replace(/\s+/g, " "), i + 1, user.email, user.email, now, now),
                ),
                activity(db, { projectId, taskId, actor: user.email, action: "routine.create", changes: { rotation: body.rotation } }),
            ],
            check: async (projectId, kind) => {
                participants = await checkParticipants(db, projectId, kind, body.rotation, body.participants);
            },
        },
    );
    if (replayed) {
        const existing = await routineForTask(db, user, task.id);
        if (existing) return existing;
    }
    return getRoutine(db, user, routineId);
}

async function convertToRoutine(db: D1Database, user: PortalUser, body: z.infer<typeof convertInput>): Promise<TaskRoutine> {
    const task = await requireTask(db, user, body.taskId, "editor");
    requireWritable(task);
    if (!task.recurrence_json) throw invalid("Make the task repeat first: a routine needs a schedule");
    if (task.parent_id) throw invalid("A subtask can't be a routine; use its parent task");
    const participants = await checkParticipants(db, task.project_id, task.project_kind, body.rotation, body.participants);
    const routineId = newId("trt");
    const now = nowIso();
    try {
        await db.batch([
            db
                .prepare("INSERT INTO task_routines (id, task_id, rotation, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
                .bind(routineId, task.id, body.rotation, user.email, now, now),
            ...participantStatements(db, routineId, participants),
            // Taking turns starts with the first person unless it's already one of theirs.
            ...(participants.length && !participants.includes(task.assignee_email ?? "")
                ? [
                      db
                          .prepare("UPDATE task_items SET assignee_email = ?, version = version + 1, updated_by = ?, updated_at = ? WHERE id = ?")
                          .bind(participants[0], user.email, now, task.id),
                  ]
                : []),
            activity(db, { projectId: task.project_id, taskId: task.id, actor: user.email, action: "routine.create", changes: { rotation: body.rotation } }),
        ]);
    } catch (error) {
        if (/UNIQUE constraint failed: task_routines\.task_id/.test(String((error as Error)?.message)))
            throw new HttpError(409, "conflict", "This task is already a routine");
        throw error;
    }
    return getRoutine(db, user, routineId);
}

const updateInput = z.object({ version: z.number().int().min(1), rotation: z.enum(ROTATIONS).optional(), participants: emailList.optional() }).strict();

/** Changes how responsibility rotates, or who takes turns. The task itself is edited like any task. */
export async function updateRoutine(db: D1Database, user: PortalUser, routineId: string, input: unknown): Promise<TaskRoutine> {
    const body = updateInput.parse(input);
    const row = await requireRoutine(db, user, routineId, "editor");
    const rotation = body.rotation ?? row.rotation;
    const current = (await participantsFor(db, [routineId])).get(routineId)?.map((p) => p.email) ?? [];
    const participants = await checkParticipants(db, row.project_id, row.p_kind, rotation, body.participants ?? current);
    const now = nowIso();
    try {
        await db.batch([
            db
                .prepare("UPDATE task_routines SET rotation = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?")
                .bind(rotation, now, routineId, body.version),
            requireChange(db),
            ...participantStatements(db, routineId, participants),
            ...(participants.length && !participants.includes(row.assignee_email ?? "")
                ? [
                      db
                          .prepare("UPDATE task_items SET assignee_email = ?, version = version + 1, updated_by = ?, updated_at = ? WHERE id = ?")
                          .bind(participants[0], user.email, now, row.id),
                  ]
                : []),
            activity(db, { projectId: row.project_id, taskId: row.id, actor: user.email, action: "routine.update", changes: { rotation } }),
        ]);
    } catch (error) {
        if (isGuardFailure(error)) throw new RoutineConflict();
        throw error;
    }
    return getRoutine(db, user, routineId);
}

/**
 * Pauses or resumes a routine. While paused it stays in its project but leaves Today, Upcoming,
 * Overdue and the dashboards, and its reminder emails are cancelled. Resuming a routine whose date
 * passed while it was paused moves it to its next scheduled date from today, without recording the
 * missed occurrences as done or skipped.
 */
export async function pauseRoutine(db: D1Database, user: PortalUser, routineId: string, input: unknown): Promise<TaskRoutine> {
    const { paused, version } = z
        .object({ paused: z.boolean(), version: z.number().int().min(1) })
        .strict()
        .parse(input);
    const row = await requireRoutine(db, user, routineId, "editor");
    if (paused === !!row.paused_at) return getRoutine(db, user, routineId);
    const now = nowIso();
    const statements: D1PreparedStatement[] = [
        db
            .prepare("UPDATE task_routines SET paused_at = ?, paused_by = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?")
            .bind(paused ? now : null, paused ? user.email : null, now, routineId, version),
        requireChange(db),
    ];
    let moved: string | null = null;
    if (paused) {
        statements.push(db.prepare("UPDATE task_reminders SET delivery_status = 'cancelled' WHERE task_id = ? AND delivery_status = 'pending'").bind(row.id));
    } else {
        const today = await todayFor(db, user.email);
        const rule = parseStoredRule(row.recurrence_json);
        if (rule && row.status === "open" && row.due_date && row.due_date < today) {
            moved = firstOnOrAfter(rule, today);
            if (moved) {
                const shift = daysBetween(row.due_date, moved);
                statements.push(
                    db
                        .prepare(
                            `UPDATE task_items SET due_date = ?, deadline = CASE WHEN deadline IS NULL THEN NULL ELSE date(deadline, ?) END,
                                version = version + 1, updated_by = ?, updated_at = ? WHERE id = ? AND due_date = ?`,
                        )
                        .bind(moved, `+${shift} days`, user.email, now, row.id, row.due_date),
                    ...(await relativeReminderStatements(db, row.id, moved, row.due_time)),
                );
            }
        }
    }
    statements.push(
        activity(db, {
            projectId: row.project_id,
            taskId: row.id,
            actor: user.email,
            action: paused ? "routine.pause" : "routine.resume",
            changes: { paused, ...(moved ? { dueDate: moved } : {}) },
        }),
    );
    try {
        await db.batch(statements);
    } catch (error) {
        if (isGuardFailure(error)) throw new RoutineConflict();
        throw error;
    }
    return getRoutine(db, user, routineId);
}

/** Stops treating the task as a routine. The task, its schedule and its history stay as they are. */
export async function deleteRoutine(db: D1Database, user: PortalUser, routineId: string) {
    const row = await requireRoutine(db, user, routineId, "editor");
    await db.batch([
        db.prepare("DELETE FROM task_routines WHERE id = ?").bind(routineId),
        activity(db, { projectId: row.project_id, taskId: row.id, actor: user.email, action: "routine.delete" }),
    ]);
}

/** A routine's full history, newest first, 50 at a time. */
export async function routineHistory(db: D1Database, user: PortalUser, routineId: string, before: number | null) {
    const row = await requireRoutine(db, user, routineId);
    const rows = await db
        .prepare(
            `SELECT c.id, c.kind, c.occurrence_date, c.at, c.by, u.name FROM task_completions c LEFT JOIN portal_users u ON u.email = c.by
             WHERE c.task_id = ? AND c.undone_at IS NULL ${before ? "AND c.id < ?" : ""} ORDER BY c.id DESC LIMIT 51`,
        )
        .bind(row.id, ...(before ? [before] : []))
        .all<{ id: number; kind: "completed" | "skipped"; occurrence_date: string | null; at: string; by: string; name: string | null }>();
    return {
        entries: rows.results.slice(0, 50).map((r) => ({ id: r.id, kind: r.kind, occurrenceDate: r.occurrence_date, at: r.at, by: r.by, byName: r.name })),
        hasMore: rows.results.length > 50,
    };
}
