// Time blocks, effort estimates and planning preferences (migration 0023, docs/DAILY_PLANNER.md).
//
// A block is one person's time for one of their tasks. Tasks stays the source of truth: a block
// holds the task's id only, never a copy of it, and creating, moving or cancelling one never
// changes the task. Every read and write goes through the caller's own membership of the task's
// project (as Tasks' requireTask does), and the database refuses a block for anyone who can't work
// on the task. Blocks are private: nobody else ever sees them, other than as "Busy" or "Focus time"
// in a feed the owner chose to publish them in. History holds ids only.
import type { D1Database } from "@cloudflare/workers-types";
import { z } from "zod";
import { addDays, wallClock, zonedInstant } from "../../src/shared/calendar/time";
import { BLOCK_LIMITS, DEFAULT_PLANNER_PREFERENCES, type PlannerPreferences, type TimeBlockInfo, plannerPreferences } from "../../src/shared/planner/types";
import type { PortalUser } from "../../src/shared/portal/types";
import type { Priority } from "../../src/shared/tasks/types";
import { activity, preferences as calendarPreferences } from "../calendar/access";
import { newId, nowIso, parseJson } from "../portal/db";
import { HttpError } from "../portal/http";
import { requireTask, requireWritable } from "../tasks/access";

const MINUTE = 60_000;
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-10-19");
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time like 09:30");
const duration = z
    .number()
    .int()
    .min(BLOCK_LIMITS.minMinutes, `At least ${BLOCK_LIMITS.minMinutes} minutes`)
    .max(BLOCK_LIMITS.maxMinutes, `At most ${BLOCK_LIMITS.maxMinutes / 60} hours`)
    .refine((m) => m % 5 === 0, "Use whole 5-minute steps");
export const blockId = z.string().regex(/^ttb_[a-z0-9]{14}$/, "Not a valid time block id");
const taskId = z.string().regex(/^tsk_[a-z0-9]{14}$/, "Not a valid task id");

export class BlockConflict extends HttpError {
    constructor(readonly current: TimeBlockInfo) {
        super(409, "conflict", "This time block changed since you opened it. Here it is as it is now.");
    }
}

/** Planning needs both applications: the calendar to plan in, and the tasks to plan. */
export function requirePlanner(user: PortalUser) {
    if (!user.permissions.includes("tasks.use") || !user.permissions.includes("calendar.use"))
        throw new HttpError(403, "forbidden", "The planner needs access to both Calendar and Tasks");
}

// --- Preferences ---------------------------------------------------------------------------------

export async function plannerPrefs(db: D1Database, email: string): Promise<{ preferences: PlannerPreferences; version: number }> {
    const row = await db.prepare("SELECT value, version FROM planner_preferences WHERE email = ?").bind(email).first<{ value: string; version: number }>();
    if (!row) return { preferences: DEFAULT_PLANNER_PREFERENCES, version: 0 };
    // An older or damaged document falls back to the defaults rather than breaking the planner.
    const parsed = plannerPreferences.safeParse({ ...DEFAULT_PLANNER_PREFERENCES, ...parseJson<Record<string, unknown>>(row.value, {}) });
    return { preferences: parsed.success ? parsed.data : DEFAULT_PLANNER_PREFERENCES, version: row.version };
}

const savePrefsInput = z.object({ preferences: plannerPreferences, version: z.number().int().min(0) }).strict();

export async function savePlannerPrefs(db: D1Database, user: PortalUser, input: unknown) {
    const body = savePrefsInput.parse(input);
    const now = nowIso();
    const value = JSON.stringify(body.preferences);
    const write =
        body.version === 0
            ? db
                  .prepare("INSERT INTO planner_preferences (email, value, version, updated_at) VALUES (?, ?, 1, ?) ON CONFLICT DO NOTHING")
                  .bind(user.email, value, now)
            : db
                  .prepare("UPDATE planner_preferences SET value = ?, version = version + 1, updated_at = ? WHERE email = ? AND version = ?")
                  .bind(value, now, user.email, body.version);
    const result = await write.run();
    if (!result.meta.changes) throw new HttpError(409, "conflict", "Your planning settings changed in another window. Reload to see them.");
    await activity(db, { actor: user.email, action: "planner.preferences", entityType: "planner_preferences" }).run();
    return plannerPrefs(db, user.email);
}

// --- Estimates -----------------------------------------------------------------------------------

const estimateInput = z.object({ minutes: z.number().int().min(5).max(2880).nullable() }).strict();

/** Sets or clears how long a task is expected to take. Anyone who can edit the task can. */
export async function setEstimate(db: D1Database, user: PortalUser, id: string, input: unknown, via: "portal" | "mcp" = "portal") {
    const { minutes } = estimateInput.parse(input);
    const task = await requireTask(db, user, taskId.parse(id), "editor");
    requireWritable(task);
    const write =
        minutes === null
            ? db.prepare("DELETE FROM task_estimates WHERE task_id = ?").bind(task.id)
            : db
                  .prepare(
                      `INSERT INTO task_estimates (task_id, minutes, updated_by, updated_at) VALUES (?, ?, ?, ?)
                       ON CONFLICT(task_id) DO UPDATE SET minutes = excluded.minutes, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
                  )
                  .bind(task.id, minutes, user.email, nowIso());
    await db.batch([
        write,
        activity(db, { actor: user.email, action: minutes === null ? "estimate.clear" : "estimate.set", entityType: "task", entityId: task.id, via }),
    ]);
    return { taskId: task.id, minutes };
}

export async function estimatesFor(db: D1Database, ids: readonly string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (let i = 0; i < ids.length; i += 90) {
        const rows = await db
            .prepare("SELECT task_id, minutes FROM task_estimates WHERE task_id IN (SELECT value FROM json_each(?))")
            .bind(JSON.stringify(ids.slice(i, i + 90)))
            .all<{ task_id: string; minutes: number }>();
        for (const r of rows.results) out.set(r.task_id, r.minutes);
    }
    return out;
}

// --- Reading blocks ------------------------------------------------------------------------------

interface BlockRow {
    id: string;
    task_id: string;
    start_date: string;
    start_time: string;
    duration_minutes: number;
    time_zone: string;
    start_at: string;
    end_at: string;
    occurrence_date: string | null;
    status: "scheduled" | "cancelled";
    source: "manual" | "suggestion" | "mcp";
    version: number;
    title: string;
    project_id: string;
    project_name: string;
    is_inbox: number;
    project_status: string;
    priority: number;
    task_status: "open" | "completed";
    due_date: string | null;
    due_time: string | null;
    recurrence_json: string | null;
    role: string;
}

// The caller's own blocks, joined to their own membership of the task's project: a block for a task
// they can no longer work on is never returned (and the database removes it when they leave).
const SELECT = `SELECT b.id, b.task_id, b.start_date, b.start_time, b.duration_minutes, b.time_zone, b.start_at, b.end_at, b.occurrence_date,
        b.status, b.source, b.version, t.title, t.project_id, p.name AS project_name, p.is_inbox, p.status AS project_status, t.priority,
        t.status AS task_status, t.due_date, t.due_time, t.recurrence_json, m.role
    FROM task_time_blocks b JOIN task_items t ON t.id = b.task_id
    JOIN task_project_members m ON m.project_id = t.project_id AND m.email = b.owner_email
    JOIN task_projects p ON p.id = t.project_id`;
const MINE = "b.owner_email = ? AND m.role <> 'viewer'";

function toInfo(r: BlockRow, timeZone: string): TimeBlockInfo {
    const s = wallClock(r.start_at, timeZone);
    const e = wallClock(r.end_at, timeZone);
    const recurring = !!r.recurrence_json;
    return {
        id: r.id,
        taskId: r.task_id,
        title: r.title,
        projectId: r.project_id,
        projectName: r.is_inbox ? "Inbox" : r.project_name,
        priority: r.priority as Priority,
        taskStatus: r.task_status,
        taskDueDate: r.due_date,
        taskDueTime: r.due_time,
        recurring,
        occurrenceDate: r.occurrence_date,
        // The series has moved on past this session's occurrence: that occurrence was completed or skipped.
        earlierOccurrence: recurring && !!r.occurrence_date && (r.due_date === null || r.occurrence_date < r.due_date),
        start: r.start_at,
        end: r.end_at,
        startDate: s.date,
        startTime: s.time,
        // A block ending at midnight ends at the end of its day, as people read it.
        endDate: e.time === "00:00" ? addDays(e.date, -1) : e.date,
        endTime: e.time === "00:00" ? "24:00" : e.time,
        durationMinutes: r.duration_minutes,
        blockTimeZone: r.time_zone !== timeZone ? r.time_zone : null,
        status: r.status,
        source: r.source,
        canEdit: r.project_status !== "archived" && r.role !== "viewer",
        version: r.version,
    };
}

/** The caller's scheduled blocks overlapping two instants. */
export async function blocksBetween(db: D1Database, user: PortalUser, start: string, end: string, timeZone: string): Promise<TimeBlockInfo[]> {
    const rows = await db
        .prepare(`${SELECT} WHERE ${MINE} AND b.status = 'scheduled' AND b.start_at < ? AND b.end_at > ? ORDER BY b.start_at, b.id LIMIT 1000`)
        .bind(user.email, end, start)
        .all<BlockRow>();
    return rows.results.map((r) => toInfo(r, timeZone));
}

/** One of the caller's blocks (any status). Someone else's, or one they can no longer reach, is a 404. */
export async function getBlock(db: D1Database, user: PortalUser, id: string, timeZone?: string): Promise<TimeBlockInfo> {
    const row = await db.prepare(`${SELECT} WHERE ${MINE} AND b.id = ?`).bind(user.email, blockId.parse(id)).first<BlockRow>();
    if (!row) throw new HttpError(404, "not_found", "Not found");
    return toInfo(row, timeZone ?? (await calendarPreferences(db, user.email)).timeZone);
}

/** Scheduled minutes and upcoming sessions per task, for the task's current occurrence. */
export async function plannedFor(db: D1Database, user: PortalUser, ids: readonly string[]): Promise<Map<string, { minutes: number; upcoming: number }>> {
    const out = new Map<string, { minutes: number; upcoming: number }>();
    const now = nowIso();
    for (let i = 0; i < ids.length; i += 90) {
        const rows = await db
            .prepare(
                `SELECT b.task_id, SUM(b.duration_minutes) AS minutes, SUM(CASE WHEN b.end_at > ? THEN 1 ELSE 0 END) AS upcoming
                 FROM task_time_blocks b JOIN task_items t ON t.id = b.task_id
                 WHERE b.owner_email = ? AND b.status = 'scheduled' AND b.task_id IN (SELECT value FROM json_each(?))
                   AND (b.occurrence_date IS NULL OR t.recurrence_json IS NULL OR b.occurrence_date = t.due_date)
                 GROUP BY b.task_id`,
            )
            .bind(now, user.email, JSON.stringify(ids.slice(i, i + 90)))
            .all<{ task_id: string; minutes: number; upcoming: number }>();
        for (const r of rows.results) out.set(r.task_id, { minutes: r.minutes, upcoming: r.upcoming });
    }
    return out;
}

// --- Writing blocks ------------------------------------------------------------------------------

/**
 * The instants of a wall-clock start in a zone, refusing a time that doesn't exist (the hour skipped
 * when daylight saving starts). In the hour repeated when it ends, the shared conversion picks one
 * of the two; the round trip is still exact.
 */
export function blockInstants(startDate: string, startTime: string, minutes: number, timeZone: string) {
    const start = zonedInstant(startDate, startTime, timeZone);
    const back = wallClock(start, timeZone);
    if (back.date !== startDate || back.time !== startTime)
        throw new HttpError(
            422,
            "validation",
            `${startTime} doesn't exist on ${startDate} in ${timeZone.replace(/_/g, " ")}: the clocks go forward. Choose another time.`,
        );
    return { start, end: new Date(Date.parse(start) + minutes * MINUTE).toISOString() };
}

export const createBlockInput = z
    .object({
        taskId,
        startDate: date,
        startTime: clock,
        durationMinutes: duration,
        /** For a repeating task: which occurrence (default: the one due now). */
        occurrenceDate: date.nullable().optional(),
        source: z.enum(["manual", "suggestion"]).default("manual"),
        clientId: z
            .string()
            .regex(/^[A-Za-z0-9_-]{8,64}$/)
            .optional(),
    })
    .strict();

export async function createBlock(db: D1Database, user: PortalUser, input: unknown, via: "portal" | "mcp" = "portal"): Promise<TimeBlockInfo> {
    const body = createBlockInput.parse(input);
    const task = await requireTask(db, user, body.taskId, "editor");
    requireWritable(task);
    if (task.status !== "open") throw new HttpError(422, "completed", "This task is already completed");
    const timeZone = (await calendarPreferences(db, user.email)).timeZone;
    if (body.clientId) {
        const existing = await db
            .prepare("SELECT id FROM task_time_blocks WHERE owner_email = ? AND client_id = ?")
            .bind(user.email, body.clientId)
            .first<{ id: string }>();
        if (existing) return getBlock(db, user, existing.id, timeZone);
    }
    const { start, end } = blockInstants(body.startDate, body.startTime, body.durationMinutes, timeZone);
    const upcoming = await db
        .prepare("SELECT COUNT(*) AS n FROM task_time_blocks WHERE owner_email = ? AND status = 'scheduled' AND end_at > ?")
        .bind(user.email, nowIso())
        .first<{ n: number }>();
    if ((upcoming?.n ?? 0) >= BLOCK_LIMITS.upcomingPerPerson)
        throw new HttpError(422, "limit", `You can have up to ${BLOCK_LIMITS.upcomingPerPerson} upcoming time blocks`);
    const occurrence = task.recurrence_json ? (body.occurrenceDate ?? task.due_date) : null;
    const id = newId("ttb");
    const now = nowIso();
    const source = via === "mcp" ? "mcp" : body.source;
    const inserted = await db
        .prepare(
            `INSERT INTO task_time_blocks (id, task_id, owner_email, start_date, start_time, duration_minutes, time_zone, start_at, end_at, occurrence_date, source, client_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        )
        .bind(
            id,
            task.id,
            user.email,
            body.startDate,
            body.startTime,
            body.durationMinutes,
            timeZone,
            start,
            end,
            occurrence,
            source,
            body.clientId ?? null,
            now,
            now,
        )
        .run();
    if (!inserted.meta.changes && body.clientId) {
        // A concurrent retry with the same client id won the insert: return that one.
        const row = await db
            .prepare("SELECT id FROM task_time_blocks WHERE owner_email = ? AND client_id = ?")
            .bind(user.email, body.clientId)
            .first<{ id: string }>();
        if (row) return getBlock(db, user, row.id, timeZone);
    }
    await activity(db, { actor: user.email, action: "time_block.create", entityType: "time_block", entityId: id, via }).run();
    return getBlock(db, user, id, timeZone);
}

export const updateBlockInput = z
    .object({
        version: z.number().int().min(1),
        startDate: date.optional(),
        startTime: clock.optional(),
        durationMinutes: duration.optional(),
        /** Cancelling keeps the record (and its history) but frees the time. */
        status: z.literal("cancelled").optional(),
    })
    .strict()
    .refine((b) => b.startDate || b.startTime || b.durationMinutes || b.status, "Change the time, the length or cancel it");

/** Moves, resizes or cancels one of the caller's blocks. The version must be the one they read. */
export async function updateBlock(db: D1Database, user: PortalUser, id: string, input: unknown, via: "portal" | "mcp" = "portal"): Promise<TimeBlockInfo> {
    const body = updateBlockInput.parse(input);
    const timeZone = (await calendarPreferences(db, user.email)).timeZone;
    const current = await getBlock(db, user, id, timeZone);
    if (!current.canEdit) throw new HttpError(422, "archived", "This task's project is archived or read-only. Restore it to change its time.");
    if (current.version !== body.version) throw new BlockConflict(current);
    if (current.status === "cancelled") throw new HttpError(422, "cancelled", "This time block was cancelled");
    const now = nowIso();
    let write;
    if (body.status === "cancelled") {
        write = db
            .prepare(
                "UPDATE task_time_blocks SET status = 'cancelled', cancelled_at = ?, version = version + 1, updated_at = ? WHERE id = ? AND owner_email = ? AND version = ?",
            )
            .bind(now, now, current.id, user.email, body.version);
    } else {
        if (current.taskStatus === "completed") throw new HttpError(422, "completed", "This task is already completed. Cancel the block instead.");
        // A new start is read in the person's zone, as the planner shows it; a change of length alone
        // keeps the start exactly as it was planned, in the zone it was planned in.
        const row = await db.prepare("SELECT start_date, start_time, duration_minutes FROM task_time_blocks WHERE id = ?").bind(current.id).first<{
            start_date: string;
            start_time: string;
            duration_minutes: number;
        }>();
        const local = body.startDate || body.startTime ? { date: body.startDate ?? current.startDate, time: body.startTime ?? current.startTime } : null;
        const startDate = local?.date ?? row!.start_date;
        const startTime = local?.time ?? row!.start_time;
        const zone = local ? timeZone : (current.blockTimeZone ?? timeZone);
        const minutes = body.durationMinutes ?? current.durationMinutes;
        const { start, end } = blockInstants(startDate, startTime, minutes, zone);
        write = db
            .prepare(
                `UPDATE task_time_blocks SET start_date = ?, start_time = ?, duration_minutes = ?, time_zone = ?, start_at = ?, end_at = ?, version = version + 1, updated_at = ?
                 WHERE id = ? AND owner_email = ? AND version = ? AND status = 'scheduled'`,
            )
            .bind(startDate, startTime, minutes, zone, start, end, now, current.id, user.email, body.version);
    }
    const result = await write.run();
    if (!result.meta.changes) throw new BlockConflict(await getBlock(db, user, id, timeZone));
    await activity(db, {
        actor: user.email,
        action: body.status === "cancelled" ? "time_block.cancel" : "time_block.update",
        entityType: "time_block",
        entityId: current.id,
        via,
    }).run();
    return getBlock(db, user, id, timeZone);
}
