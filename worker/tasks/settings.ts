// Saved filters and preferences (time zone, Today option, and each list's sort, grouping and
// layout): all private to one person.
import type { D1Database } from "@cloudflare/workers-types";
import { z } from "zod";
import type { PortalUser } from "../../src/shared/portal/types";
import { isClockTime, isTimeZone } from "../../src/shared/tasks/dates";
import { taskFilter } from "../../src/shared/tasks/filters";
import { LANDING_PAGES, LIMITS, type SavedTaskView, type TaskPreferences } from "../../src/shared/tasks/types";
import {
    VIEW_KEYS,
    type ViewKey,
    type ViewPreferenceMap,
    type ViewPreferences,
    parseViewPreferences,
    viewPreferences,
} from "../../src/shared/tasks/view-preferences";
import { isGuardFailure, newId, nowIso, requireChange } from "../portal/db";
import { HttpError } from "../portal/http";
import { notFound, preferences } from "./access";

interface ViewRow {
    id: string;
    name: string;
    definition_json: string;
    version: number;
}

/** A stored definition is validated again as it's read; one that no longer parses is shown as "all open tasks". */
const toView = (r: ViewRow): SavedTaskView => {
    let definition = taskFilter.parse({});
    try {
        const parsed = taskFilter.safeParse(JSON.parse(r.definition_json));
        if (parsed.success) definition = parsed.data;
    } catch {
        // Keep the default.
    }
    return { id: r.id, name: r.name, definition, version: r.version };
};

export async function listViews(db: D1Database, email: string): Promise<SavedTaskView[]> {
    const rows = await db
        .prepare("SELECT id, name, definition_json, version FROM task_saved_views WHERE owner_email = ? ORDER BY position, name COLLATE NOCASE")
        .bind(email)
        .all<ViewRow>();
    return rows.results.map(toView);
}

export async function getView(db: D1Database, user: PortalUser, viewId: string): Promise<SavedTaskView> {
    const row = await db
        .prepare("SELECT id, name, definition_json, version FROM task_saved_views WHERE id = ? AND owner_email = ?")
        .bind(viewId, user.email)
        .first<ViewRow>();
    if (!row) throw notFound();
    return toView(row);
}

const name = z.string().trim().min(1, "Name the filter").max(LIMITS.viewName);

export async function createView(db: D1Database, user: PortalUser, input: unknown): Promise<SavedTaskView> {
    const body = z.object({ name, definition: taskFilter }).strict().parse(input);
    const count = await db.prepare("SELECT COUNT(*) AS n FROM task_saved_views WHERE owner_email = ?").bind(user.email).first<{ n: number }>();
    if ((count?.n ?? 0) >= 100) throw new HttpError(422, "validation", "You can save up to 100 filters");
    const id = newId("tfv");
    const now = nowIso();
    await db
        .prepare(
            `INSERT INTO task_saved_views (id, owner_email, name, definition_json, position, created_at, updated_at)
             VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM task_saved_views WHERE owner_email = ?), ?, ?)`,
        )
        .bind(id, user.email, body.name, JSON.stringify(body.definition), user.email, now, now)
        .run();
    return getView(db, user, id);
}

export async function updateView(db: D1Database, user: PortalUser, viewId: string, input: unknown): Promise<SavedTaskView> {
    const body = z
        .object({ version: z.number().int().min(1), name: name.optional(), definition: taskFilter.optional() })
        .strict()
        .parse(input);
    const view = await getView(db, user, viewId);
    try {
        await db.batch([
            db
                .prepare(
                    "UPDATE task_saved_views SET name = ?, definition_json = ?, version = version + 1, updated_at = ? WHERE id = ? AND owner_email = ? AND version = ?",
                )
                .bind(body.name ?? view.name, JSON.stringify(body.definition ?? view.definition), nowIso(), viewId, user.email, body.version),
            requireChange(db),
        ]);
    } catch (error) {
        if (isGuardFailure(error)) throw new HttpError(409, "conflict", "This filter changed in another tab. Reload and try again.");
        throw error;
    }
    return getView(db, user, viewId);
}

export async function deleteView(db: D1Database, user: PortalUser, viewId: string) {
    const result = await db.prepare("DELETE FROM task_saved_views WHERE id = ? AND owner_email = ?").bind(viewId, user.email).run();
    if (!result.meta.changes) throw notFound();
}

export async function updatePreferences(db: D1Database, user: PortalUser, input: unknown): Promise<TaskPreferences> {
    const time = z.string().refine(isClockTime, "Use a time like 22:00").nullable();
    const body = z
        .object({
            timeZone: z.string().max(60).refine(isTimeZone, "Choose a time zone").optional(),
            todayPriority: z.number().int().min(1).max(4).nullable().optional(),
            remindersEnabled: z.boolean().optional(),
            reminderEmail: z.boolean().optional(),
            defaultReminderMinutes: z.number().int().min(0).max(10_080).nullable().optional(),
            quietStart: time.optional(),
            quietEnd: time.optional(),
            landingPage: z.enum(LANDING_PAGES).optional(),
        })
        .strict()
        .parse(input);
    const current = await preferences(db, user.email);
    const next: TaskPreferences = { ...current };
    for (const [key, value] of Object.entries(body)) if (value !== undefined) (next as unknown as Record<string, unknown>)[key] = value;
    if (!next.quietStart !== !next.quietEnd) throw new HttpError(422, "validation", "Quiet hours need a start and an end");
    if (next.quietStart && next.quietStart === next.quietEnd) throw new HttpError(422, "validation", "Quiet hours can't start and end at the same time");
    await db
        .prepare(
            `INSERT INTO task_preferences (email, time_zone, today_priority, reminders_enabled, reminder_email, default_reminder_minutes,
                quiet_start, quiet_end, landing_page, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(email) DO UPDATE SET time_zone = excluded.time_zone, today_priority = excluded.today_priority,
                reminders_enabled = excluded.reminders_enabled, reminder_email = excluded.reminder_email,
                default_reminder_minutes = excluded.default_reminder_minutes, quiet_start = excluded.quiet_start, quiet_end = excluded.quiet_end,
                landing_page = excluded.landing_page, updated_at = excluded.updated_at`,
        )
        .bind(
            user.email,
            next.timeZone,
            next.todayPriority,
            next.remindersEnabled ? 1 : 0,
            next.reminderEmail ? 1 : 0,
            next.defaultReminderMinutes,
            next.quietStart,
            next.quietEnd,
            next.landingPage,
            nowIso(),
        )
        .run();
    // Turning reminders or their emails off stops emails that are waiting to go; turning them back
    // on again queues the ones still to come.
    if (!next.remindersEnabled || !next.reminderEmail)
        await db
            .prepare("UPDATE task_reminders SET delivery_status = 'cancelled' WHERE owner_email = ? AND delivery_status = 'pending'")
            .bind(user.email)
            .run();
    else if (!current.remindersEnabled || !current.reminderEmail)
        await db
            .prepare(
                `UPDATE task_reminders SET delivery_status = 'pending', next_attempt_at = remind_at, attempts = 0, claim_token = NULL, claimed_at = NULL
                 WHERE owner_email = ? AND delivery_status = 'cancelled' AND dismissed_at IS NULL AND remind_at > ?`,
            )
            .bind(user.email, nowIso())
            .run();
    return preferences(db, user.email);
}

/** The caller's own choices for each list. */
export async function listViewPreferences(db: D1Database, email: string): Promise<ViewPreferenceMap> {
    const rows = await db
        .prepare("SELECT view, prefs_json FROM task_view_preferences WHERE email = ?")
        .bind(email)
        .all<{ view: ViewKey; prefs_json: string }>();
    return Object.fromEntries(rows.results.filter((r) => VIEW_KEYS.includes(r.view)).map((r) => [r.view, parseViewPreferences(r.prefs_json)]));
}

/** Replaces the caller's choices for one list. Unknown lists are 404, unknown fields 422. */
export async function setViewPreferences(db: D1Database, user: PortalUser, view: string, input: unknown): Promise<ViewPreferences> {
    if (!VIEW_KEYS.includes(view as ViewKey)) throw notFound();
    const prefs = viewPreferences.parse(input);
    await db
        .prepare(
            `INSERT INTO task_view_preferences (email, view, prefs_json, updated_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(email, view) DO UPDATE SET prefs_json = excluded.prefs_json, updated_at = excluded.updated_at`,
        )
        .bind(user.email, view, JSON.stringify(prefs), nowIso())
        .run();
    return prefs;
}
