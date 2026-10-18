// Background reminder delivery. The existing cron trigger (every 15 minutes) calls
// processTaskReminders, which emails reminders that have fallen due to people who asked for them.
//
// Delivery is at least once, not exactly once. Each reminder is claimed with a conditional UPDATE
// before it's sent, so two overlapping runs can't both send it; but if the email provider accepts
// the message and the Worker then fails before recording it, the next run sends it again. The
// provider can't tell us whether an earlier attempt got through, so a rare duplicate is the price of
// never silently losing a reminder.
//
// Before sending, everything is checked again as it is now, not as it was when the reminder was
// made: the recipient must still be a member of the task's project and able to open Tasks, the
// task must be open, the reminder undismissed, and their reminder and email preferences on.
// Anything else cancels the email (the in-app reminder is unaffected). Emails contain the task's
// title, date, priority and project, and a link that needs the portal's sign-in: never its
// description, comments, labels or linked Knowledge.
//
// Bounded: at most `limit` reminders per run, found with the partial index on next_attempt_at.
// Failures are retried with backoff (5 min, 15 min, 1 h, 4 h), then given up on. A reminder more
// than six hours late (delivery was off, or the provider was down) is marked expired, not sent.
// Quiet hours never drop a reminder: it waits until they end.
import type { D1Database } from "@cloudflare/workers-types";
import { addDays, clockLabel, localDate, longDate, zonedInstant } from "../../src/shared/tasks/dates";
import { PRIORITY_LABELS, type Priority } from "../../src/shared/tasks/types";
import { type EmailProvider, ProviderError, emailProvider, htmlForText } from "../comms/providers";
import type { Env } from "../env";
import { isEnabled } from "../portal/flags";
import { DEFAULT_TIME_ZONE, canUseTasks } from "./access";

export const RETRY_MINUTES = [5, 15, 60, 240];
export const MAX_ATTEMPTS = RETRY_MINUTES.length + 1;
const STALE_HOURS = 6;
/** A claim older than this belongs to a run that died; the reminder can be taken again. */
const CLAIM_MINUTES = 10;

interface DueRow {
    id: string;
    task_id: string;
    owner_email: string;
    remind_at: string;
    attempts: number;
    dismissed_at: string | null;
    title: string;
    status: "open" | "completed";
    due_date: string | null;
    due_time: string | null;
    priority: number;
    project_name: string;
    project_kind: "personal" | "shared";
    is_inbox: number;
    is_member: number;
    name: string | null;
    time_zone: string | null;
    reminders_enabled: number | null;
    reminder_email: number | null;
    quiet_start: string | null;
    quiet_end: string | null;
}

const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/** If `now` is inside the person's quiet hours, when they end (as an instant); otherwise null. */
export function quietUntil(now: Date, timeZone: string, start: string | null, end: string | null): string | null {
    if (!start || !end) return null;
    const local = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
    const today = localDate(now, timeZone);
    const t = minutes(local);
    const [s, e] = [minutes(start), minutes(end)];
    // 22:00–07:00 wraps past midnight; 13:00–14:00 doesn't.
    const inside = s < e ? t >= s && t < e : t >= s || t < e;
    if (!inside) return null;
    const endDay = s < e || t < e ? today : addDays(today, 1);
    return zonedInstant(endDay, end, timeZone);
}

/** The email for one reminder: plain text, every value escaped in the HTML. */
export function reminderEmail(row: DueRow, siteUrl: string) {
    const due = row.due_date ? `${longDate(row.due_date)}${row.due_time ? `, ${clockLabel(row.due_time)}` : ""}` : "No date";
    const priority = PRIORITY_LABELS[(row.priority as Priority) ?? 4];
    const project = row.is_inbox ? "Inbox" : row.project_name;
    const link = `${siteUrl.replace(/\/+$/, "")}/portal/tasks/t/${row.task_id}`;
    const text = [
        `Reminder: ${row.title}`,
        `Due: ${due}\nPriority: ${priority.short} (${priority.label})\nProject: ${project}`,
        `Open it in Daly Tasks (you'll be asked to sign in):\n${link}`,
        "You're receiving this because you turned on email reminders in Daly Tasks. To stop them, turn them off in Tasks → Settings.",
    ].join("\n\n");
    return { subject: `Reminder: ${row.title}`.slice(0, 200), text, html: htmlForText(text) };
}

export interface ReminderRunResult {
    sent: number;
    retried: number;
    failed: number;
    cancelled: number;
    expired: number;
    deferred: number;
    /** Why nothing was attempted, if nothing was. */
    skipped?: "delivery_off";
}

/** Sends due reminders. Safe to call from every cron run, and from two at once. */
export async function processTaskReminders(
    env: Env,
    options: { now?: Date; limit?: number; provider?: EmailProvider | null } = {},
): Promise<ReminderRunResult> {
    const db = env.DB;
    const result: ReminderRunResult = { sent: 0, retried: 0, failed: 0, cancelled: 0, expired: 0, deferred: 0 };
    const provider = options.provider !== undefined ? options.provider : emailProvider(env);
    // Nothing is attempted (and nothing is marked) unless delivery is on: switching it on later sends what's due.
    if (!provider || !(await isEnabled(db, "tasks.reminders.email"))) return { ...result, skipped: "delivery_off" };
    const now = options.now ?? new Date();
    const nowText = now.toISOString();
    const due = await db
        .prepare("SELECT id FROM task_reminders WHERE delivery_status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?")
        .bind(nowText, Math.min(options.limit ?? 20, 50))
        .all<{ id: string }>();

    for (const { id } of due.results) {
        const token = crypto.randomUUID();
        const claimed = await db
            .prepare(
                `UPDATE task_reminders SET claim_token = ?, claimed_at = ? WHERE id = ? AND delivery_status = 'pending' AND next_attempt_at <= ?
                 AND (claimed_at IS NULL OR claimed_at < ?)`,
            )
            .bind(token, nowText, id, nowText, new Date(now.getTime() - CLAIM_MINUTES * 60_000).toISOString())
            .run();
        if (!claimed.meta.changes) continue; // Another run has it.
        const outcome = await deliver(env, db, provider, id, token, now);
        result[outcome]++;
    }
    if (due.results.length) console.log(JSON.stringify({ event: "task_reminders", ...result }));
    return result;
}

type Outcome = Exclude<keyof ReminderRunResult, "skipped">;

async function deliver(env: Env, db: D1Database, provider: EmailProvider, id: string, token: string, now: Date): Promise<Outcome> {
    const nowText = now.toISOString();
    const row = await db
        .prepare(
            `SELECT r.id, r.task_id, r.owner_email, r.remind_at, r.attempts, r.dismissed_at, t.title, t.status, t.due_date, t.due_time, t.priority,
                    p.name AS project_name, p.kind AS project_kind, p.is_inbox, (m.email IS NOT NULL) AS is_member, u.name,
                    pr.time_zone, pr.reminders_enabled, pr.reminder_email, pr.quiet_start, pr.quiet_end
             FROM task_reminders r JOIN task_items t ON t.id = r.task_id JOIN task_projects p ON p.id = t.project_id
             LEFT JOIN task_project_members m ON m.project_id = t.project_id AND m.email = r.owner_email
             LEFT JOIN task_preferences pr ON pr.email = r.owner_email
             LEFT JOIN portal_users u ON u.email = r.owner_email
             WHERE r.id = ? AND r.claim_token = ?`,
        )
        .bind(id, token)
        .first<DueRow>();
    if (!row) return "cancelled";
    const finish = (status: "sent" | "failed" | "expired" | "cancelled", error: string | null = null) =>
        db
            .prepare(
                `UPDATE task_reminders SET delivery_status = ?, last_error = ?, claim_token = NULL, claimed_at = NULL,
                    delivered_at = CASE WHEN ? = 'sent' THEN ? ELSE delivered_at END
                 WHERE id = ? AND claim_token = ?`,
            )
            .bind(status, error, status, nowText, id, token)
            .run();

    // Access and wishes as they are now.
    const allowed = !!row.is_member && (await canUseTasks(env, db, row.owner_email));
    if (!allowed || row.status !== "open" || row.dismissed_at || !row.reminders_enabled || !row.reminder_email) {
        await finish("cancelled", !allowed ? "no access" : row.status !== "open" ? "task completed" : row.dismissed_at ? "dismissed" : "reminder emails off");
        return "cancelled";
    }
    if (new Date(row.remind_at).getTime() < now.getTime() - STALE_HOURS * 3_600_000) {
        await finish("expired", "too late to send");
        return "expired";
    }
    const quiet = quietUntil(now, row.time_zone ?? DEFAULT_TIME_ZONE, row.quiet_start, row.quiet_end);
    if (quiet) {
        await db
            .prepare("UPDATE task_reminders SET next_attempt_at = ?, claim_token = NULL, claimed_at = NULL WHERE id = ? AND claim_token = ?")
            .bind(quiet, id, token)
            .run();
        return "deferred";
    }

    const email = reminderEmail(row, env.SITE_URL);
    const attempts = row.attempts + 1;
    await db.prepare("UPDATE task_reminders SET attempts = ?, last_attempt_at = ? WHERE id = ? AND claim_token = ?").bind(attempts, nowText, id, token).run();
    try {
        await provider.send({ to: row.owner_email, toName: row.name ?? "", ...email, reference: `task-reminder:${row.id}` });
    } catch (error) {
        const retryable = !(error instanceof ProviderError) || error.retryable;
        const message = (error instanceof ProviderError ? error.message : "delivery failed").slice(0, 300);
        console.error(JSON.stringify({ event: "task_reminder_failed", reminderId: id, attempts, retryable, message }));
        if (retryable && attempts < MAX_ATTEMPTS) {
            const next = new Date(now.getTime() + RETRY_MINUTES[attempts - 1] * 60_000).toISOString();
            await db
                .prepare(
                    "UPDATE task_reminders SET next_attempt_at = ?, last_error = ?, claim_token = NULL, claimed_at = NULL WHERE id = ? AND claim_token = ?",
                )
                .bind(next, message, id, token)
                .run();
            return "retried";
        }
        await finish("failed", message);
        return "failed";
    }
    await finish("sent");
    return "sent";
}
