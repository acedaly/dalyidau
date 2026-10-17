// Portable exports: a whole space (owners) or one object (anyone who can read it), as the versioned
// JSON format in src/shared/knowledge/export.ts, as Markdown, or as a ZIP of both. Exports are built
// on request and streamed straight back; nothing is stored, so there is no URL to leak.
//
// Only rows from the one authorised space are read. Other people's favourites and private saved
// views are never included, and member details are limited to emails and roles.
import type { D1Database } from "@cloudflare/workers-types";
import { CONTENT_FORMAT, type DocNode, EMPTY_DOCUMENT } from "../../src/shared/knowledge/content";
import { EXPORT_FORMAT, type KnowledgeExport, exportReferenceProblems } from "../../src/shared/knowledge/export";
import { type MarkdownOptions, objectToMarkdown } from "../../src/shared/knowledge/markdown";
import type { PropertyValues } from "../../src/shared/knowledge/properties";
import type { PortalUser } from "../../src/shared/portal/types";
import { nowIso, parseJson } from "../portal/db";
import { requireObject, requireSpace } from "./access";
import { knowledgeAudit } from "./audit";
import { parseSchema } from "./types";
import { buildZip } from "./zip";

/** Rows are read in pages so no single D1 response gets large. */
const PAGE = 500;

async function allRows<T extends { id: string }>(db: D1Database, sql: string, binds: unknown[]): Promise<T[]> {
    const out: T[] = [];
    let after = "";
    for (;;) {
        const page = await db
            .prepare(`${sql} AND id > ? ORDER BY id LIMIT ${PAGE}`)
            .bind(...binds, after)
            .all<T>();
        out.push(...page.results);
        if (page.results.length < PAGE) return out;
        after = page.results[page.results.length - 1].id;
    }
}

interface ObjectExportRow {
    id: string;
    type_id: string;
    title: string;
    content_json: string;
    properties_json: string;
    status: "active" | "archived" | "trashed";
    in_inbox: number;
    daily_date: string | null;
    source_system: string | null;
    source_id: string | null;
    version: number;
    created_by: string;
    created_at: string;
    updated_by: string;
    updated_at: string;
    archived_at: string | null;
    trashed_at: string | null;
    trashed_by: string | null;
}

const OBJECT_SELECT = `SELECT id, type_id, title, content_json, properties_json, status, in_inbox, daily_date, source_system, source_id, version,
    created_by, created_at, updated_by, updated_at, archived_at, trashed_at, trashed_by FROM knowledge_objects`;

const toExportedObject = (row: ObjectExportRow, tags: string[]): KnowledgeExport["objects"][number] => ({
    id: row.id,
    typeId: row.type_id,
    title: row.title,
    contentFormat: CONTENT_FORMAT,
    content: parseJson<DocNode>(row.content_json, EMPTY_DOCUMENT),
    properties: parseJson<PropertyValues>(row.properties_json, {}),
    status: row.status,
    inInbox: !!row.in_inbox,
    dailyDate: row.daily_date,
    tags,
    source: row.source_system && row.source_id ? { system: row.source_system, id: row.source_id } : null,
    version: row.version,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
    trashedAt: row.trashed_at,
    trashedBy: row.trashed_by,
});

interface TypeRow {
    id: string;
    name: string;
    slug: string;
    icon: string;
    description: string;
    schema_json: string;
    sort_order: number;
    archived_at: string | null;
    version: number;
    created_by: string;
    created_at: string;
    updated_at: string;
}
const toExportedType = (r: TypeRow): KnowledgeExport["types"][number] => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    icon: r.icon,
    description: r.description,
    schema: parseSchema(r.schema_json),
    sortOrder: r.sort_order,
    archivedAt: r.archived_at,
    version: r.version,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
});

interface RevisionRow {
    id: string;
    object_id: string;
    version: number;
    kind: "create" | "edit" | "restore" | "import";
    type_id: string;
    title: string;
    content_json: string;
    properties_json: string;
    changed_by: string;
    started_at: string;
    changed_at: string;
}
const toExportedRevision = (r: RevisionRow): KnowledgeExport["revisions"][number] => ({
    id: r.id,
    objectId: r.object_id,
    version: r.version,
    kind: r.kind,
    typeId: r.type_id,
    title: r.title,
    content: parseJson<DocNode>(r.content_json, EMPTY_DOCUMENT),
    properties: parseJson<PropertyValues>(r.properties_json, {}),
    changedBy: r.changed_by,
    startedAt: r.started_at,
    changedAt: r.changed_at,
});

interface RelationRow {
    id: string;
    source_id: string;
    target_id: string;
    relation_type: string;
    origin: "manual" | "content" | "property";
    created_by: string;
    created_at: string;
}
const toExportedRelation = (r: RelationRow): KnowledgeExport["relations"][number] => ({
    id: r.id,
    sourceId: r.source_id,
    targetId: r.target_id,
    relationType: r.relation_type,
    origin: r.origin,
    createdBy: r.created_by,
    createdAt: r.created_at,
});

const tagsByObject = async (db: D1Database, spaceId: string, objectId?: string) => {
    const rows = await db
        .prepare(
            `SELECT ot.object_id, t.name FROM knowledge_object_tags ot JOIN knowledge_tags t ON t.id = ot.tag_id
             WHERE ot.space_id = ? ${objectId ? "AND ot.object_id = ?" : ""} ORDER BY t.name COLLATE NOCASE`,
        )
        .bind(...(objectId ? [spaceId, objectId] : [spaceId]))
        .all<{ object_id: string; name: string }>();
    const map = new Map<string, string[]>();
    for (const r of rows.results) map.set(r.object_id, [...(map.get(r.object_id) ?? []), r.name]);
    return map;
};

export interface ExportOptions {
    revisions: boolean;
}

/** Everything in a space. Owners only: it includes the members list and the audit trail. */
export async function exportSpace(db: D1Database, user: PortalUser, spaceId: string, options: ExportOptions): Promise<KnowledgeExport> {
    const space = await requireSpace(db, user, spaceId, "owner");
    const spaceRow = await db.prepare("SELECT created_at FROM knowledge_spaces WHERE id = ?").bind(spaceId).first<{ created_at: string }>();

    const [members, types, collections, pins, templates, views, favourites, audit] = await db.batch([
        db.prepare("SELECT email, role FROM knowledge_memberships WHERE space_id = ? ORDER BY email").bind(spaceId),
        db.prepare("SELECT * FROM knowledge_object_types WHERE space_id = ? ORDER BY sort_order, id").bind(spaceId),
        db.prepare("SELECT * FROM knowledge_collections WHERE space_id = ? ORDER BY sort_order, id").bind(spaceId),
        db.prepare("SELECT object_id, position, pinned_by, pinned_at FROM knowledge_pins WHERE space_id = ? ORDER BY position").bind(spaceId),
        db.prepare("SELECT * FROM knowledge_templates WHERE space_id = ? ORDER BY name COLLATE NOCASE, id").bind(spaceId),
        // Shared views, and the exporter's own private ones; never anyone else's.
        db
            .prepare("SELECT * FROM knowledge_saved_views WHERE space_id = ? AND (owner_email IS NULL OR owner_email = ?) ORDER BY sort_order, id")
            .bind(spaceId, user.email),
        db.prepare("SELECT object_id, position, created_at FROM knowledge_favourites WHERE space_id = ? AND email = ? ORDER BY position").bind(spaceId, user.email),
        db.prepare("SELECT at, actor, action, entity_type, entity_id, summary, changes FROM knowledge_audit WHERE space_id = ? ORDER BY id").bind(spaceId),
    ]);
    const objectRows = await allRows<ObjectExportRow>(db, `${OBJECT_SELECT} WHERE space_id = ?`, [spaceId]);
    const objectIds = new Set(objectRows.map((r) => r.id));
    const tagMap = await tagsByObject(db, spaceId);
    const relations = await allRows<RelationRow>(db, "SELECT * FROM knowledge_relations WHERE space_id = ?", [spaceId]);
    const items = await db
        .prepare("SELECT collection_id, object_id, position, pinned_at, added_by, added_at FROM knowledge_collection_items WHERE space_id = ? ORDER BY position")
        .bind(spaceId)
        .all<{ collection_id: string; object_id: string; position: number; pinned_at: string | null; added_by: string; added_at: string }>();
    const revisions = options.revisions ? await allRows<RevisionRow>(db, "SELECT * FROM knowledge_revisions WHERE space_id = ?", [spaceId]) : [];

    // Rows are read one query at a time, not as one snapshot: anything that refers to an object
    // created after the objects were read is left out, so the export is always self-consistent.
    const known = (objectId: string) => objectIds.has(objectId);
    type Row = Record<string, unknown>;
    const data: KnowledgeExport = {
        format: EXPORT_FORMAT,
        contentFormat: CONTENT_FORMAT,
        exportedAt: nowIso(),
        exportedBy: user.email,
        scope: "space",
        includes: { revisions: options.revisions, audit: true },
        space: { id: space.id, name: space.name, kind: space.kind, timeZone: space.time_zone, createdAt: spaceRow?.created_at ?? "" },
        members: space.kind === "shared" ? (members.results as { email: string; role: "owner" | "editor" | "viewer" }[]) : [],
        types: (types.results as unknown as TypeRow[]).map(toExportedType),
        objects: objectRows.map((r) => toExportedObject(r, tagMap.get(r.id) ?? [])),
        relations: relations.filter((r) => known(r.source_id) && known(r.target_id)).map(toExportedRelation),
        linkedObjects: [],
        collections: (collections.results as Row[]).map((c) => ({
            id: c.id as string,
            name: c.name as string,
            description: c.description as string,
            sortOrder: c.sort_order as number,
            archivedAt: (c.archived_at as string | null) ?? null,
            version: c.version as number,
            createdBy: c.created_by as string,
            createdAt: c.created_at as string,
            updatedBy: c.updated_by as string,
            updatedAt: c.updated_at as string,
            items: items.results
                .filter((i) => i.collection_id === c.id && known(i.object_id))
                .map((i) => ({ objectId: i.object_id, position: i.position, pinnedAt: i.pinned_at, addedBy: i.added_by, addedAt: i.added_at })),
        })),
        pins: (pins.results as Row[])
            .filter((p) => known(p.object_id as string))
            .map((p) => ({ objectId: p.object_id as string, position: p.position as number, pinnedBy: p.pinned_by as string, pinnedAt: p.pinned_at as string })),
        templates: (templates.results as Row[]).map((t) => ({
            id: t.id as string,
            typeId: t.type_id as string,
            name: t.name as string,
            description: t.description as string,
            title: t.title as string,
            content: parseJson<DocNode>(t.content_json, EMPTY_DOCUMENT),
            properties: parseJson<PropertyValues>(t.properties_json, {}),
            isDefault: !!t.is_default,
            archivedAt: (t.archived_at as string | null) ?? null,
            version: t.version as number,
            createdBy: t.created_by as string,
            createdAt: t.created_at as string,
            updatedBy: t.updated_by as string,
            updatedAt: t.updated_at as string,
        })),
        savedViews: (views.results as Row[]).map((v) => ({
            id: v.id as string,
            name: v.name as string,
            shared: v.owner_email === null,
            definition: parseJson(v.definition_json, {}),
            createdBy: v.created_by as string,
            createdAt: v.created_at as string,
            updatedAt: v.updated_at as string,
        })),
        favourites: (favourites.results as Row[])
            .filter((f) => known(f.object_id as string))
            .map((f) => ({ objectId: f.object_id as string, position: f.position as number, createdAt: f.created_at as string })),
        revisions: revisions
            .filter((r) => known(r.object_id))
            .sort((a, b) => a.object_id.localeCompare(b.object_id) || a.version - b.version)
            .map(toExportedRevision),
        audit: (audit.results as Row[]).map((a) => ({
            at: a.at as string,
            actor: a.actor as string,
            action: a.action as string,
            entityType: a.entity_type as string,
            entityId: (a.entity_id as string | null) ?? null,
            summary: a.summary as string,
            changes: parseJson(a.changes, null),
        })),
    };
    const problems = exportReferenceProblems(data);
    if (problems.length) throw new Error(`Export is inconsistent: ${problems[0]}`);
    await knowledgeAudit(db, {
        spaceId,
        actor: user.email,
        action: "space.export",
        entityType: "space",
        entityId: spaceId,
        summary: "Exported the space",
        changes: { objects: data.objects.length, revisions: options.revisions },
    }).run();
    return data;
}

/** One object with its type, tags and links (the objects at the other end by title only). */
export async function exportObject(db: D1Database, user: PortalUser, objectId: string, options: ExportOptions): Promise<KnowledgeExport> {
    const access = await requireObject(db, user, objectId);
    const space = await requireSpace(db, user, access.space_id);
    const [objectRow, typeRow, relations, spaceRow] = await Promise.all([
        db.prepare(`${OBJECT_SELECT} WHERE id = ?`).bind(objectId).first<ObjectExportRow>(),
        db.prepare("SELECT * FROM knowledge_object_types WHERE id = ? AND space_id = ?").bind(access.type_id, access.space_id).first<TypeRow>(),
        db
            .prepare(
                `SELECT r.*, o.title AS other_title, o.type_id AS other_type FROM knowledge_relations r
                 JOIN knowledge_objects o ON o.id = CASE WHEN r.source_id = ?1 THEN r.target_id ELSE r.source_id END
                 WHERE (r.source_id = ?1 OR r.target_id = ?1) AND r.space_id = ?2 AND o.space_id = ?2 AND o.status <> 'trashed'`,
            )
            .bind(objectId, access.space_id)
            .all<RelationRow & { other_title: string; other_type: string }>(),
        db.prepare("SELECT created_at FROM knowledge_spaces WHERE id = ?").bind(access.space_id).first<{ created_at: string }>(),
    ]);
    if (!objectRow || !typeRow) throw new Error("Object vanished during export");
    const tags = (await tagsByObject(db, access.space_id, objectId)).get(objectId) ?? [];
    const revisions = options.revisions ? await allRows<RevisionRow>(db, "SELECT * FROM knowledge_revisions WHERE object_id = ?", [objectId]) : [];
    const linked = new Map<string, { id: string; title: string; typeId: string }>();
    for (const r of relations.results) {
        const other = r.source_id === objectId ? r.target_id : r.source_id;
        linked.set(other, { id: other, title: r.other_title, typeId: r.other_type });
    }
    const data: KnowledgeExport = {
        format: EXPORT_FORMAT,
        contentFormat: CONTENT_FORMAT,
        exportedAt: nowIso(),
        exportedBy: user.email,
        scope: "object",
        includes: { revisions: options.revisions, audit: false },
        space: { id: space.id, name: space.name, kind: space.kind, timeZone: space.time_zone, createdAt: spaceRow?.created_at ?? "" },
        members: [],
        types: [toExportedType(typeRow)],
        objects: [toExportedObject(objectRow, tags)],
        relations: relations.results.map(toExportedRelation),
        linkedObjects: [...linked.values()],
        collections: [],
        pins: [],
        templates: [],
        savedViews: [],
        favourites: [],
        revisions: revisions.sort((a, b) => a.version - b.version).map(toExportedRevision),
        audit: [],
    };
    await knowledgeAudit(db, {
        spaceId: access.space_id,
        actor: user.email,
        action: "object.export",
        entityType: "object",
        entityId: objectId,
        summary: "Exported an object",
    }).run();
    return data;
}

// --- Files ---------------------------------------------------------------------------------------

/** A file-name-safe version of a title: letters, digits, spaces and a few separators, at most 60 characters. */
export const safeFileStem = (title: string) =>
    (title || "Untitled")
        .normalize("NFC")
        .replace(/[^\p{L}\p{N} _,'()&+-]+/gu, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 60)
        .trim() || "Untitled";

const folderFor = (status: string) => (status === "trashed" ? "Trash" : status === "archived" ? "Archive" : "Objects");

/** Each object's path in the ZIP. Ids make names unique; daily notes are filed by date (unique per space). */
export function objectPaths(data: KnowledgeExport): Map<string, string> {
    const types = new Map(data.types.map((t) => [t.id, t]));
    const paths = new Map<string, string>();
    for (const o of data.objects) {
        const folder = folderFor(o.status);
        paths.set(
            o.id,
            o.dailyDate && o.status !== "trashed"
                ? `Daily notes/${o.dailyDate}.md`
                : `${folder}/${safeFileStem(types.get(o.typeId)?.name ?? "Objects")}/${safeFileStem(o.title)} (${o.id}).md`,
        );
    }
    return paths;
}

export function objectMarkdown(data: KnowledgeExport, objectId: string, options: MarkdownOptions = {}) {
    const object = data.objects.find((o) => o.id === objectId)!;
    const type = data.types.find((t) => t.id === object.typeId);
    const titles = new Map([...data.objects, ...data.linkedObjects].map((o) => [o.id, o.title || "Untitled"]));
    return objectToMarkdown(
        {
            id: object.id,
            title: object.title,
            typeName: type?.name ?? "Object",
            tags: object.tags,
            status: object.status,
            dailyDate: object.dailyDate,
            createdAt: object.createdAt,
            updatedAt: object.updatedAt,
            properties: object.properties,
            content: object.content as DocNode,
        },
        type?.schema.properties ?? [],
        { ...options, referenceLabel: (id) => titles.get(id) },
    );
}

const README = (data: KnowledgeExport) => `# ${data.space.name}: Daly Knowledge export

Exported ${data.exportedAt} by ${data.exportedBy}.

- \`manifest.json\` is the complete export in the documented \`${EXPORT_FORMAT}\` format: types and property
  schemas, every object's editor document (${CONTENT_FORMAT}), properties, tags, links, collections, templates,
  saved views, your favourites${data.includes.revisions ? ", revision history" : ""} and the audit trail. It is the file to
  keep and the one an import reads.
- Every object is also a Markdown file with YAML front matter, for reading in any editor. Links between
  objects are wiki links (\`[[file|title]]\`), which Obsidian and similar tools follow. Markdown can't hold
  everything (table layout, underline, typed links); the JSON can.

Archived objects are in Archive/, trashed ones in Trash/, daily notes in Daily notes/.
`;

export function exportZip(data: KnowledgeExport): Uint8Array<ArrayBuffer> {
    const paths = objectPaths(data);
    const link = (id: string, label: string) => {
        const path = paths.get(id);
        const clean = (label || "Untitled").replace(/[[\]|]/g, " ").trim() || "Untitled";
        return path ? `[[${path.replace(/\.md$/, "")}|${clean}]]` : `[[${clean}]]`;
    };
    return buildZip(
        [
            { name: "README.md", data: README(data) },
            { name: "manifest.json", data: JSON.stringify(data, null, 2) },
            ...data.objects.map((o) => ({ name: paths.get(o.id)!, data: objectMarkdown(data, o.id, { objectLink: link }) })),
        ],
        new Date(data.exportedAt),
    );
}
