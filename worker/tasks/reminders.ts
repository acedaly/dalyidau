// Reminders. Each belongs to one person. It's shown to them in the app when it falls due (found
// with an indexed range query on (owner, remind_at) when a Tasks page loads, with a timer for the
// ones coming up while it stays open) and, if they've turned on email reminders and delivery is
// switched on, emailed by the background processor (notify.ts). delivery_status tracks the email:
// every new or moved reminder is "pending" until it's sent, given up on, or cancelled.
//
// A relative reminder ("30 minutes before") follows its task: it's recalculated whenever the due
// date or time changes, including when a repeating task moves on. A task with a date but no time
// counts as due at 9 am in the reminder owner's time zone.
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { z } from "zod";
import type { PortalUser } from "../../src/shared/portal/types";
import { isCalendarDate, isClockTime, zonedInstant } from "../../src/shared/tasks/dates";
import { type DueReminder, LIMITS, type TaskReminder } from "../../src/shared/tasks/types";
import { newId, nowIso } from "../portal/db";
import { HttpError } from "../portal/http";
import { DEFAULT_TIME_ZONE, notFound, preferences, requireTask } from "./access";

export const DEFAULT_REMINDER_TIME = "09:00";

/** SET clauses: a reminder (re)scheduled for ?1 waits for delivery afresh; a stopped one won't be emailed. */
const PENDING = "delivery_status = 'pending', next_attempt_at = ?1, attempts = 0, last_error = NULL, claim_token = NULL, claimed_at = NULL";
export const CANCEL = "delivery_status = CASE WHEN delivery_status = 'pending' THEN 'cancelled' ELSE delivery_status END";

/** A relative reminder on a new task, from the person's default reminder setting. */
export const defaultReminderStatement = (
    db: D1Database,
    taskId: string,
    owner: string,
    due: string,
    time: string | null,
    offset: number,
    timeZone: string,
): D1PreparedStatement => {
    const at = relativeInstant(due, time, offset, timeZone);
    return db
        .prepare(
            `INSERT INTO task_reminders (id, task_id, owner_email, kind, offset_minutes, remind_at, created_at, delivery_status, next_attempt_at)
             VALUES (?, ?, ?, 'relative', ?, ?, ?, 'pending', ?)`,
        )
        .bind(newId("trm"), taskId, owner, offset, at, nowIso(), at);
};

const relativeInstant = (due: string, time: string | null, offset: number, timeZone: string) =>
    new Date(new Date(zonedInstant(due, time ?? DEFAULT_REMINDER_TIME, timeZone)).getTime() - offset * 60_000).toISOString();

/** Statements that move a task's relative reminders to follow a new due date and time. */
export async function relativeReminderStatements(db: D1Database, taskId: string, due: string | null, time: string | null): Promise<D1PreparedStatement[]> {
    const rows = await db
        .prepare(
            `SELECT r.id, r.offset_minutes, COALESCE(p.time_zone, ?) AS time_zone FROM task_reminders r LEFT JOIN task_preferences p ON p.email = r.owner_email
             WHERE r.task_id = ? AND r.kind = 'relative'`,
        )
        .bind(DEFAULT_TIME_ZONE, taskId)
        .all<{ id: string; offset_minutes: number; time_zone: string }>();
    return rows.results.map((r) =>
        due
            ? db
                  .prepare(`UPDATE task_reminders SET remind_at = ?1, dismissed_at = NULL, ${PENDING} WHERE id = ?2`)
                  .bind(relativeInstant(due, time, r.offset_minutes, r.time_zone), r.id)
            : // With no date there's nothing to be relative to; keep it, but it can't fire.
              db.prepare(`UPDATE task_reminders SET dismissed_at = COALESCE(dismissed_at, ?), ${CANCEL} WHERE id = ?`).bind(nowIso(), r.id),
    );
}

const reminderInput = z.discriminatedUnion("kind", [
    z
        .object({
            kind: z.literal("absolute"),
            date: z.string().refine(isCalendarDate, "Choose a date"),
            time: z.string().refine(isClockTime, "Choose a time"),
        })
        .strict(),
    z.object({ kind: z.literal("relative"), offsetMinutes: z.number().int().min(0).max(10_080) }).strict(),
]);

const toReminder = (r: {
    id: string;
    kind: "absolute" | "relative";
    offset_minutes: number | null;
    remind_at: string;
    dismissed_at: string | null;
    delivery_status: TaskReminder["deliveryStatus"];
}): TaskReminder => ({
    id: r.id,
    kind: r.kind,
    offsetMinutes: r.offset_minutes,
    remindAt: r.remind_at,
    dismissedAt: r.dismissed_at,
    deliveryStatus: r.delivery_status,
});

/** The caller's own reminders on a task. Other people's reminders are never shown. */
export async function remindersFor(db: D1Database, email: string, taskId: string): Promise<TaskReminder[]> {
    const rows = await db
        .prepare(
            "SELECT id, kind, offset_minutes, remind_at, dismissed_at, delivery_status FROM task_reminders WHERE task_id = ? AND owner_email = ? ORDER BY remind_at",
        )
        .bind(taskId, email)
        .all<Parameters<typeof toReminder>[0]>();
    return rows.results.map(toReminder);
}

/** Any member, viewers included, may remind themselves about a task they can see. */
export async function addReminder(db: D1Database, user: PortalUser, taskId: string, input: unknown): Promise<TaskReminder[]> {
    const body = reminderInput.parse(input);
    const task = await requireTask(db, user, taskId);
    const { timeZone } = await preferences(db, user.email);
    const count = await db
        .prepare("SELECT COUNT(*) AS n FROM task_reminders WHERE task_id = ? AND owner_email = ?")
        .bind(taskId, user.email)
        .first<{ n: number }>();
    if ((count?.n ?? 0) >= LIMITS.remindersPerTask) throw new HttpError(422, "validation", `At most ${LIMITS.remindersPerTask} reminders per task`);
    let remindAt: string;
    if (body.kind === "absolute") remindAt = zonedInstant(body.date, body.time, timeZone);
    else {
        if (!task.due_date) throw new HttpError(422, "validation", "Give the task a date before adding a reminder relative to it");
        remindAt = relativeInstant(task.due_date, task.due_time, body.offsetMinutes, timeZone);
    }
    await db
        .prepare(
            `INSERT INTO task_reminders (id, task_id, owner_email, kind, offset_minutes, remind_at, created_at, delivery_status, next_attempt_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        )
        .bind(newId("trm"), taskId, user.email, body.kind, body.kind === "relative" ? body.offsetMinutes : null, remindAt, nowIso(), remindAt)
        .run();
    return remindersFor(db, user.email, taskId);
}

const ownReminder = async (db: D1Database, user: PortalUser, reminderId: string) => {
    // Through the task, so a reminder on a task you can no longer see can't be touched either.
    const row = await db
        .prepare(
            `SELECT r.id, r.task_id FROM task_reminders r JOIN task_items t ON t.id = r.task_id
             JOIN task_project_members m ON m.project_id = t.project_id AND m.email = r.owner_email
             WHERE r.id = ? AND r.owner_email = ?`,
        )
        .bind(reminderId, user.email)
        .first<{ id: string; task_id: string }>();
    if (!row) throw notFound();
    return row;
};

export async function deleteReminder(db: D1Database, user: PortalUser, reminderId: string) {
    const row = await ownReminder(db, user, reminderId);
    await db.prepare("DELETE FROM task_reminders WHERE id = ?").bind(row.id).run();
}

export async function dismissReminder(db: D1Database, user: PortalUser, reminderId: string) {
    const row = await ownReminder(db, user, reminderId);
    // Dismissed in the app: don't email it as well.
    await db.prepare(`UPDATE task_reminders SET dismissed_at = COALESCE(dismissed_at, ?), ${CANCEL} WHERE id = ?`).bind(nowIso(), row.id).run();
}

/**
 * The caller's undismissed reminders on open tasks they can still see, due up to `until`. Uses the
 * (owner_email, remind_at) index; never scans other people's reminders.
 */
export async function dueReminders(db: D1Database, email: string, until: Date): Promise<DueReminder[]> {
    const rows = await db
        .prepare(
            `SELECT r.id, r.task_id, r.remind_at, t.title FROM task_reminders r
             JOIN task_items t ON t.id = r.task_id AND t.status = 'open'
             JOIN task_project_members m ON m.project_id = t.project_id AND m.email = r.owner_email
             WHERE r.owner_email = ? AND r.dismissed_at IS NULL AND r.remind_at <= ? ORDER BY r.remind_at LIMIT 50`,
        )
        .bind(email, until.toISOString())
        .all<{ id: string; task_id: string; remind_at: string; title: string }>();
    return rows.results.map((r) => ({ id: r.id, taskId: r.task_id, title: r.title, remindAt: r.remind_at }));
}
