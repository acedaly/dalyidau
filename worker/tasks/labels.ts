// Labels. Each person has their own list (names, colours, order). Tasks carry label names, so a
// label on a shared task is seen by everyone in that project, and filtering by label works across
// personal and shared tasks. Renaming or deleting a label changes only tasks the person can edit;
// a shared task whose project they only view keeps its label.
import type { D1Database } from "@cloudflare/workers-types";
import { z } from "zod";
import type { PortalUser } from "../../src/shared/portal/types";
import { COLORS, LIMITS, type TaskLabel } from "../../src/shared/tasks/types";
import { newId, nowIso } from "../portal/db";
import { HttpError } from "../portal/http";
import { notFound } from "./access";
import { normaliseLabels } from "./tasks";

/** Tasks a person can edit, as SQL for `task_id IN (…)`. */
const EDITABLE_TASKS = `SELECT t.id FROM task_items t JOIN task_project_members m ON m.project_id = t.project_id AND m.email = ? AND m.role <> 'viewer'
    JOIN task_projects p ON p.id = t.project_id AND p.status <> 'archived'`;

export async function listLabels(db: D1Database, email: string): Promise<TaskLabel[]> {
    const rows = await db
        .prepare(
            `SELECT l.id, l.name, l.color,
                (SELECT COUNT(*) FROM task_item_labels il JOIN task_items t ON t.id = il.task_id AND t.status = 'open'
                 JOIN task_project_members m ON m.project_id = t.project_id AND m.email = ? WHERE il.name = l.name) AS open_count
             FROM task_labels l WHERE l.owner_email = ? ORDER BY l.position, l.name COLLATE NOCASE`,
        )
        .bind(email, email)
        .all<{ id: string; name: string; color: TaskLabel["color"]; open_count: number }>();
    return rows.results.map((r) => ({ id: r.id, name: r.name, color: r.color, openCount: r.open_count }));
}

/** Names on tasks the person can see that aren't in their own list (added by someone else in a shared project). */
export async function otherLabels(db: D1Database, email: string): Promise<string[]> {
    const rows = await db
        .prepare(
            `SELECT DISTINCT il.name FROM task_item_labels il JOIN task_items t ON t.id = il.task_id
             JOIN task_project_members m ON m.project_id = t.project_id AND m.email = ?
             WHERE NOT EXISTS (SELECT 1 FROM task_labels l WHERE l.owner_email = ? AND l.name = il.name) ORDER BY il.name COLLATE NOCASE LIMIT 100`,
        )
        .bind(email, email)
        .all<{ name: string }>();
    return rows.results.map((r) => r.name);
}

const labelInput = z.object({ name: z.string().max(200), color: z.enum(COLORS).default("gray") }).strict();

const cleanName = (name: string) => {
    const [clean] = normaliseLabels([name]);
    if (!clean) throw new HttpError(422, "validation", "Name the label");
    if (clean.length > LIMITS.labelName) throw new HttpError(422, "validation", `Keep label names under ${LIMITS.labelName} characters`);
    return clean;
};

export async function createLabel(db: D1Database, user: PortalUser, input: unknown) {
    const body = labelInput.parse(input);
    const name = cleanName(body.name);
    const now = nowIso();
    const result = await db
        .prepare(
            `INSERT OR IGNORE INTO task_labels (id, owner_email, name, color, position, created_at, updated_at)
             VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM task_labels WHERE owner_email = ?), ?, ?)`,
        )
        .bind(newId("tlb"), user.email, name, body.color, user.email, now, now)
        .run();
    if (!result.meta.changes) throw new HttpError(409, "conflict", "You already have a label with that name");
}

const ownLabel = async (db: D1Database, user: PortalUser, labelId: string) => {
    const row = await db
        .prepare("SELECT id, name FROM task_labels WHERE id = ? AND owner_email = ?")
        .bind(labelId, user.email)
        .first<{ id: string; name: string }>();
    if (!row) throw notFound();
    return row;
};

export async function updateLabel(db: D1Database, user: PortalUser, labelId: string, input: unknown) {
    const body = z
        .object({ name: z.string().max(200).optional(), color: z.enum(COLORS).optional() })
        .strict()
        .parse(input);
    const label = await ownLabel(db, user, labelId);
    const name = body.name !== undefined ? cleanName(body.name) : label.name;
    const now = nowIso();
    if (name.toLowerCase() !== label.name.toLowerCase()) {
        const clash = await db.prepare("SELECT 1 FROM task_labels WHERE owner_email = ? AND name = ? AND id <> ?").bind(user.email, name, labelId).first();
        if (clash) throw new HttpError(409, "conflict", "You already have a label with that name");
    }
    await db.batch([
        db.prepare("UPDATE task_labels SET name = ?, color = COALESCE(?, color), updated_at = ? WHERE id = ?").bind(name, body.color ?? null, now, labelId),
        // Tasks that already have the new name keep one copy; the rest are renamed.
        db
            .prepare(
                `DELETE FROM task_item_labels WHERE name = ? AND task_id IN (${EDITABLE_TASKS}) AND task_id IN (SELECT task_id FROM task_item_labels WHERE name = ?)`,
            )
            .bind(label.name, user.email, name),
        db.prepare(`UPDATE task_item_labels SET name = ? WHERE name = ? AND task_id IN (${EDITABLE_TASKS})`).bind(name, label.name, user.email),
    ]);
}

/** Deletes the label from the person's list and from every task they can edit. Tasks themselves are untouched. */
export async function deleteLabel(db: D1Database, user: PortalUser, labelId: string) {
    const label = await ownLabel(db, user, labelId);
    await db.batch([
        db.prepare(`DELETE FROM task_item_labels WHERE name = ? AND task_id IN (${EDITABLE_TASKS})`).bind(label.name, user.email),
        db.prepare("DELETE FROM task_labels WHERE id = ?").bind(labelId),
    ]);
}
