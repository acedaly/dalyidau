// Categories and their custom fields. Built-in categories are in code; the household can add its
// own and add custom fields to any category. Categories are household-wide (everyone who can open
// Home & Assets sees the same list): a category name says nothing about anyone's assets.
import type { D1Database } from "@cloudflare/workers-types";
import { type AssetCategory, BUILTIN_CATEGORIES, type CustomFieldDef, builtinCategory } from "../../src/shared/assets/categories";
import { categoryInput } from "../../src/shared/assets/types";
import type { PortalUser } from "../../src/shared/portal/types";
import { newId, nowIso, parseJson } from "../portal/db";
import { HttpError } from "../portal/http";
import { activity } from "./access";

interface CategoryRow {
    id: string;
    name: string;
    builtin: number;
    fields: string;
    archived: number;
    version: number;
}

export async function listCategories(db: D1Database): Promise<AssetCategory[]> {
    const rows = (await db.prepare("SELECT id, name, builtin, fields, archived, version FROM asset_categories ORDER BY name").all<CategoryRow>()).results;
    const byId = new Map(rows.map((r) => [r.id, r]));
    const builtins: AssetCategory[] = BUILTIN_CATEGORIES.map((c) => {
        const row = byId.get(c.id);
        return {
            id: c.id,
            label: c.label,
            group: c.group,
            builtin: true,
            vehicle: "vehicle" in c ? c.vehicle : null,
            fields: parseJson<CustomFieldDef[]>(row?.fields, []),
            archived: false,
            version: row?.version ?? 0,
        };
    });
    const custom: AssetCategory[] = rows
        .filter((r) => !r.builtin)
        .map((r) => ({
            id: r.id,
            label: r.name,
            group: "other",
            builtin: false,
            vehicle: null,
            fields: parseJson<CustomFieldDef[]>(r.fields, []),
            archived: !!r.archived,
            version: r.version,
        }));
    return [...builtins, ...custom];
}

export const categoryMap = (categories: AssetCategory[]) => new Map(categories.map((c) => [c.id, c]));

/** A category id that exists and isn't archived. */
export async function checkCategory(db: D1Database, id: string): Promise<AssetCategory> {
    if (builtinCategory(id)) return (await listCategories(db)).find((c) => c.id === id)!;
    const row = await db.prepare("SELECT id FROM asset_categories WHERE id = ? AND builtin = 0 AND archived = 0").bind(id).first();
    if (!row) throw new HttpError(422, "validation", "Choose a category from the list");
    return (await listCategories(db)).find((c) => c.id === id)!;
}

const uniqueKeys = (fields: CustomFieldDef[]) => {
    const keys = new Set<string>();
    for (const f of fields) {
        if (keys.has(f.key)) throw new HttpError(422, "validation", `Two fields use the key "${f.key}"`);
        if (f.type === "select" && !f.options?.length) throw new HttpError(422, "validation", `Give "${f.label}" some options`);
        keys.add(f.key);
    }
};

export async function createCategory(db: D1Database, user: PortalUser, input: unknown): Promise<AssetCategory> {
    const body = categoryInput.parse(input);
    uniqueKeys(body.fields ?? []);
    const count = await db.prepare("SELECT COUNT(*) AS n FROM asset_categories WHERE builtin = 0").first<{ n: number }>();
    if ((count?.n ?? 0) >= 100) throw new HttpError(422, "limit", "There can be up to 100 household categories");
    const id = newId("acat");
    const now = nowIso();
    await db.batch([
        db
            .prepare("INSERT INTO asset_categories (id, name, builtin, fields, created_by, created_at, updated_by, updated_at) VALUES (?, ?, 0, ?, ?, ?, ?, ?)")
            .bind(id, body.name, JSON.stringify(body.fields ?? []), user.email, now, user.email, now),
        activity(db, { actor: user.email, action: "category.create", entityType: "category", entityId: id }),
    ]);
    return (await listCategories(db)).find((c) => c.id === id)!;
}

/** Renames a household category, or changes any category's custom fields (a built-in keeps its name). */
export async function updateCategory(db: D1Database, user: PortalUser, id: string, input: unknown): Promise<AssetCategory> {
    const body = categoryInput.partial().parse(input);
    if (body.fields) uniqueKeys(body.fields);
    const builtin = builtinCategory(id);
    const now = nowIso();
    if (builtin) {
        if (body.archived) throw new HttpError(422, "validation", "Built-in categories can't be archived");
        await db
            .prepare(
                `INSERT INTO asset_categories (id, name, builtin, fields, created_by, created_at, updated_by, updated_at) VALUES (?1, ?2, 1, ?3, ?4, ?5, ?4, ?5)
                 ON CONFLICT (id) DO UPDATE SET fields = excluded.fields, version = version + 1, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
            )
            .bind(id, builtin.label, JSON.stringify(body.fields ?? []), user.email, now)
            .run();
    } else {
        const row = await db.prepare("SELECT id, name, fields, archived FROM asset_categories WHERE id = ? AND builtin = 0").bind(id).first<CategoryRow>();
        if (!row) throw new HttpError(404, "not_found", "Not found");
        await db
            .prepare("UPDATE asset_categories SET name = ?, fields = ?, archived = ?, version = version + 1, updated_by = ?, updated_at = ? WHERE id = ?")
            .bind(
                body.name ?? row.name,
                body.fields ? JSON.stringify(body.fields) : row.fields,
                body.archived === undefined ? row.archived : body.archived ? 1 : 0,
                user.email,
                now,
                id,
            )
            .run();
    }
    await activity(db, { actor: user.email, action: "category.update", entityType: "category", entityId: id }).run();
    return (await listCategories(db)).find((c) => c.id === id)!;
}

/** Keeps only values for the category's defined fields, each of the field's type. */
export function cleanCustom(fields: CustomFieldDef[], values: Record<string, unknown> | undefined): Record<string, string | number | boolean | null> {
    const out: Record<string, string | number | boolean | null> = {};
    if (!values) return out;
    for (const f of fields) {
        const v = values[f.key];
        if (v === undefined || v === null || v === "") continue;
        if (f.type === "number" && typeof v === "number" && Number.isFinite(v)) out[f.key] = v;
        else if (f.type === "boolean" && typeof v === "boolean") out[f.key] = v;
        else if (f.type === "date" && typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) out[f.key] = v;
        else if (f.type === "select" && typeof v === "string" && f.options?.includes(v)) out[f.key] = v;
        else if (f.type === "text" && typeof v === "string") out[f.key] = v.slice(0, 500);
        else throw new HttpError(422, "validation", `"${f.label}" isn't valid`);
    }
    return out;
}
