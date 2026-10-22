// Categories: the built-in ones (src/shared/finance/categories.ts) and the household's own.
import type { D1Database } from "@cloudflare/workers-types";
import {
    BUILTIN_CATEGORIES,
    BUILTIN_CATEGORY_IDS,
    CATEGORY_GROUPS,
    CATEGORY_GROUP_IDS,
    type CategoryDef,
    type CategoryKind,
} from "../../src/shared/finance/categories";
import { categoryCreateSchema, categoryUpdateSchema } from "../../src/shared/finance/types";
import type { PortalUser } from "../../src/shared/portal/types";
import { newId, nowIso } from "../portal/db";
import { HttpError } from "../portal/http";
import { activity, activityWhen, conflict, notFound } from "./access";

interface CategoryRow {
    id: string;
    name: string;
    kind: CategoryKind;
    group_id: string;
    archived_at: string | null;
    version: number;
}

export async function listCategories(db: D1Database): Promise<CategoryDef[]> {
    const rows = await db.prepare("SELECT * FROM finance_categories ORDER BY lower(name) LIMIT 500").all<CategoryRow>();
    const custom = rows.results.map((r): CategoryDef & { version: number } => ({
        id: r.id,
        name: r.name,
        kind: r.kind,
        groupId: CATEGORY_GROUP_IDS.has(r.group_id) ? r.group_id : "other",
        builtin: false,
        archived: !!r.archived_at,
        version: r.version,
    }));
    return [...BUILTIN_CATEGORIES, ...custom];
}

/** A lookup of each category's kind (archived ones included, so history still adds up). */
export const kindLookup = (categories: readonly CategoryDef[]) => {
    const map = new Map(categories.map((c) => [c.id, c.kind]));
    return (id: string) => map.get(id);
};

/** Refuses a category that doesn't exist or is archived (an archived one stays on old transactions). */
export async function assertAssignable(db: D1Database, id: string | null) {
    if (id === null || BUILTIN_CATEGORY_IDS.has(id)) return;
    const row = await db.prepare("SELECT archived_at FROM finance_categories WHERE id = ?").bind(id).first<{ archived_at: string | null }>();
    if (!row) throw new HttpError(422, "validation", "That category doesn't exist");
    if (row.archived_at) throw new HttpError(422, "validation", "That category is archived");
}

export async function createCategory(db: D1Database, user: PortalUser, input: unknown) {
    const body = categoryCreateSchema.parse(input);
    const group = CATEGORY_GROUPS.find((g) => g.id === body.groupId);
    if (!group) throw new HttpError(422, "validation", "Choose a group");
    if (group.kind !== body.kind)
        throw new HttpError(
            422,
            "validation",
            body.kind === "income" ? "Income categories go in the Income group" : "Spending categories can't go in the Income group",
        );
    if (BUILTIN_CATEGORIES.some((c) => c.name.toLowerCase() === body.name.toLowerCase()))
        throw new HttpError(422, "validation", "There's already a category with that name");
    const id = newId("fcat");
    const now = nowIso();
    try {
        await db.batch([
            db
                .prepare(
                    "INSERT INTO finance_categories (id, name, kind, group_id, created_by, created_at, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                )
                .bind(id, body.name, body.kind, body.groupId, user.email, now, user.email, now),
            activity(db, { actor: user.email, action: "category.create", entityType: "category", entityId: id }),
        ]);
    } catch (error) {
        if (String(error).includes("UNIQUE")) throw new HttpError(422, "validation", "There's already a category with that name");
        throw error;
    }
    return (await listCategories(db)).find((c) => c.id === id)!;
}

export async function updateCategory(db: D1Database, user: PortalUser, id: string, input: unknown) {
    const body = categoryUpdateSchema.parse(input);
    if (BUILTIN_CATEGORY_IDS.has(id)) throw new HttpError(422, "validation", "Built-in categories can't be changed");
    const row = await db.prepare("SELECT * FROM finance_categories WHERE id = ?").bind(id).first<CategoryRow>();
    if (!row) throw notFound();
    if (body.groupId !== undefined) {
        const group = CATEGORY_GROUPS.find((g) => g.id === body.groupId);
        if (!group || group.kind !== row.kind) throw new HttpError(422, "validation", "Choose a group of the same kind");
    }
    const now = nowIso();
    const archivedAt = body.archived === undefined ? row.archived_at : body.archived ? (row.archived_at ?? now) : null;
    let result;
    try {
        [result] = await db.batch([
            db
                .prepare(
                    "UPDATE finance_categories SET name = ?, group_id = ?, archived_at = ?, version = version + 1, updated_by = ?, updated_at = ? WHERE id = ? AND version = ?",
                )
                .bind(body.name ?? row.name, body.groupId ?? row.group_id, archivedAt, user.email, now, id, body.version),
            activityWhen(
                db,
                {
                    actor: user.email,
                    action: body.archived === true ? "category.archive" : body.archived === false ? "category.restore" : "category.update",
                    entityType: "category",
                    entityId: id,
                },
                "SELECT 1 FROM finance_categories WHERE id = ? AND updated_at = ?",
                id,
                now,
            ),
        ]);
    } catch (error) {
        if (String(error).includes("UNIQUE")) throw new HttpError(422, "validation", "There's already a category with that name");
        throw error;
    }
    if (!result.meta.changes) throw conflict();
    return (await listCategories(db)).find((c) => c.id === id)!;
}
