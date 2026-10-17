// Object types: named kinds of object (Person, Project, …) with their own properties. Types are
// data, so people create and change them without code changes. A type in use is archived, never
// deleted, and editing a type never removes values already stored on objects.
import type { D1Database } from "@cloudflare/workers-types";
import { z } from "zod";
import { type TypeSchema, typeSchemaSchema } from "../../src/shared/knowledge/properties";
import { type KnowledgeType, TYPE_ICONS, type TypeIcon } from "../../src/shared/knowledge/types";
import type { PortalUser } from "../../src/shared/portal/types";
import { isGuardFailure, newId, nowIso, requireChange } from "../portal/db";
import { HttpError } from "../portal/http";
import { notFound, requireSpace } from "./access";
import { knowledgeAudit } from "./audit";

interface TypeRow {
    id: string;
    space_id: string;
    name: string;
    slug: string;
    icon: string;
    description: string;
    schema_json: string;
    sort_order: number;
    archived_at: string | null;
    version: number;
    object_count?: number;
}

export const parseSchema = (json: string): TypeSchema => {
    try {
        const parsed = typeSchemaSchema.safeParse(JSON.parse(json));
        return parsed.success ? parsed.data : { properties: [] };
    } catch {
        return { properties: [] };
    }
};

const toType = (row: TypeRow): KnowledgeType => ({
    id: row.id,
    spaceId: row.space_id,
    name: row.name,
    slug: row.slug,
    icon: (TYPE_ICONS as readonly string[]).includes(row.icon) ? (row.icon as TypeIcon) : "file",
    description: row.description,
    schema: parseSchema(row.schema_json),
    sortOrder: row.sort_order,
    archived: !!row.archived_at,
    version: row.version,
    objectCount: row.object_count ?? 0,
});

export async function listTypes(db: D1Database, spaceId: string): Promise<KnowledgeType[]> {
    const rows = await db
        .prepare(
            `SELECT t.*, (SELECT COUNT(*) FROM knowledge_objects o WHERE o.type_id = t.id AND o.status <> 'trashed') AS object_count
             FROM knowledge_object_types t WHERE t.space_id = ? ORDER BY t.archived_at IS NOT NULL, t.sort_order, t.name COLLATE NOCASE`,
        )
        .bind(spaceId)
        .all<TypeRow>();
    return rows.results.map(toType);
}

/** A type in the given space, or 404. Space membership must already have been checked. */
export async function getTypeInSpace(db: D1Database, spaceId: string, typeId: string): Promise<KnowledgeType> {
    const row = await db.prepare("SELECT * FROM knowledge_object_types WHERE id = ? AND space_id = ?").bind(typeId, spaceId).first<TypeRow>();
    if (!row) throw new HttpError(422, "validation", "That object type isn't in this space");
    return toType(row);
}

const typeInput = z.object({
    name: z.string().trim().min(1, "Give the type a name").max(60),
    icon: z.enum(TYPE_ICONS).default("file"),
    description: z.string().trim().max(300).default(""),
    schema: typeSchemaSchema.default({ properties: [] }),
});

const slugFor = (name: string) =>
    name
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 40) || "type";

/** Every object type a reference property points at must be in the same space. */
async function checkTargets(db: D1Database, spaceId: string, schema: TypeSchema, selfId?: string) {
    const targets = [...new Set(schema.properties.map((p) => p.targetTypeId).filter((id): id is string => !!id && id !== selfId))];
    if (!targets.length) return;
    const found = await db
        .prepare(`SELECT id FROM knowledge_object_types WHERE space_id = ? AND id IN (${targets.map(() => "?").join(", ")})`)
        .bind(spaceId, ...targets)
        .all<{ id: string }>();
    if (found.results.length !== targets.length) throw new HttpError(422, "validation", "A reference property points at a type that isn't in this space");
}

export async function createType(db: D1Database, user: PortalUser, spaceId: string, input: unknown): Promise<KnowledgeType> {
    await requireSpace(db, user, spaceId, "editor");
    const body = typeInput.parse(input);
    await checkTargets(db, spaceId, body.schema);
    const taken = new Set(
        (await db.prepare("SELECT slug FROM knowledge_object_types WHERE space_id = ?").bind(spaceId).all<{ slug: string }>()).results.map((r) => r.slug),
    );
    const base = slugFor(body.name);
    let slug = base;
    for (let n = 2; taken.has(slug); n++) slug = `${base.slice(0, 36)}_${n}`;
    const id = newId("kty");
    const now = nowIso();
    await db.batch([
        db
            .prepare(
                `INSERT INTO knowledge_object_types (id, space_id, name, slug, icon, description, schema_json, sort_order, created_by, updated_by, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM knowledge_object_types WHERE space_id = ?), ?, ?, ?, ?)`,
            )
            .bind(id, spaceId, body.name, slug, body.icon, body.description, JSON.stringify(body.schema), spaceId, user.email, user.email, now, now),
        knowledgeAudit(db, { spaceId, actor: user.email, action: "type.create", entityType: "type", entityId: id, summary: "Created an object type" }),
    ]);
    return getTypeInSpace(db, spaceId, id);
}

const typePatch = typeInput.partial().extend({ version: z.number().int().min(1), archived: z.boolean().optional() });

export async function updateType(db: D1Database, user: PortalUser, typeId: string, input: unknown): Promise<KnowledgeType> {
    const row = await db.prepare("SELECT * FROM knowledge_object_types WHERE id = ?").bind(typeId).first<TypeRow>();
    if (!row) throw notFound();
    await requireSpace(db, user, row.space_id, "editor");
    const body = typePatch.parse(input);
    if (body.version !== row.version) throw new HttpError(409, "conflict", "Someone else changed this type. Reload to see their changes.");
    const before = toType(row);

    if (body.schema) {
        // A key keeps its meaning: changing a property's type would make stored values invalid.
        for (const def of body.schema.properties) {
            const old = before.schema.properties.find((p) => p.key === def.key);
            if (old && old.type !== def.type)
                throw new HttpError(422, "validation", `“${def.label}” already holds ${old.type} values. Add a new property instead of changing its type.`);
        }
        await checkTargets(db, row.space_id, body.schema, typeId);
    }
    if (body.archived === true && !row.archived_at) {
        const live = await db.prepare("SELECT COUNT(*) AS n FROM knowledge_object_types WHERE space_id = ? AND archived_at IS NULL").bind(row.space_id).first<{ n: number }>();
        if ((live?.n ?? 0) <= 1) throw new HttpError(422, "validation", "A space needs at least one type that isn't archived");
    }

    const now = nowIso();
    const changed = Object.keys(body).filter((k) => k !== "version");
    try {
        await db.batch([
            db
                .prepare(
                    `UPDATE knowledge_object_types SET name = ?, icon = ?, description = ?, schema_json = ?, archived_at = ?, updated_by = ?, updated_at = ?, version = version + 1
                     WHERE id = ? AND version = ?`,
                )
                .bind(
                    body.name ?? row.name,
                    body.icon ?? row.icon,
                    body.description ?? row.description,
                    JSON.stringify(body.schema ?? before.schema),
                    body.archived === undefined ? row.archived_at : body.archived ? (row.archived_at ?? now) : null,
                    user.email,
                    now,
                    typeId,
                    body.version,
                ),
            requireChange(db),
            knowledgeAudit(db, {
                spaceId: row.space_id,
                actor: user.email,
                action: body.archived === true ? "type.archive" : body.archived === false ? "type.unarchive" : "type.update",
                entityType: "type",
                entityId: typeId,
                summary: "Changed an object type",
                changes: { fields: changed },
            }),
        ]);
    } catch (error) {
        if (isGuardFailure(error)) throw new HttpError(409, "conflict", "Someone else changed this type. Reload to see their changes.");
        throw error;
    }
    return getTypeInSpace(db, row.space_id, typeId);
}

/** The space's default type for quick capture: Page if it exists and isn't archived, else the first live type. */
export async function defaultTypeId(db: D1Database, spaceId: string): Promise<string> {
    const row = await db
        .prepare("SELECT id FROM knowledge_object_types WHERE space_id = ? AND archived_at IS NULL ORDER BY slug <> 'page', sort_order LIMIT 1")
        .bind(spaceId)
        .first<{ id: string }>();
    if (!row) throw new HttpError(422, "validation", "Create an object type first");
    return row.id;
}
