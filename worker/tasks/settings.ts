// Saved filters and preferences: both private to one person.
import type { D1Database } from "@cloudflare/workers-types";
import { z } from "zod";
import type { PortalUser } from "../../src/shared/portal/types";
import { isTimeZone } from "../../src/shared/tasks/dates";
import { taskFilter } from "../../src/shared/tasks/filters";
import { LIMITS, type SavedTaskView, type TaskPreferences } from "../../src/shared/tasks/types";
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
    const body = z
        .object({
            timeZone: z.string().max(60).refine(isTimeZone, "Choose a time zone").optional(),
            todayPriority: z.number().int().min(1).max(4).nullable().optional(),
        })
        .strict()
        .parse(input);
    const current = await preferences(db, user.email);
    const next = { timeZone: body.timeZone ?? current.timeZone, todayPriority: body.todayPriority !== undefined ? body.todayPriority : current.todayPriority };
    await db
        .prepare(
            `INSERT INTO task_preferences (email, time_zone, today_priority, updated_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(email) DO UPDATE SET time_zone = excluded.time_zone, today_priority = excluded.today_priority, updated_at = excluded.updated_at`,
        )
        .bind(user.email, next.timeZone, next.todayPriority, nowIso())
        .run();
    return preferences(db, user.email);
}
