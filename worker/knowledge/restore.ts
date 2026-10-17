// Rebuilds a space from a "daly.knowledge.export.v1" export, keeping every id. It is what proves an
// export is complete: test/knowledge-export.test.ts exports a space, deletes it, restores the export
// and checks that exporting again gives the same thing. A future "import a Daly export" feature will
// call it; it isn't routed yet.
//
// It refuses to touch anything that exists: the space and every object id must be new. Documents
// are validated as they would be on any save, and the search index is rebuilt from the restored rows.
// Statements run in chunks, so a failure part-way leaves a partial space: restore into a database
// (or space id) you can throw away, check it, then use it.
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { CONTENT_FORMAT, normaliseDocument } from "../../src/shared/knowledge/content";
import { type KnowledgeExport, parseKnowledgeExport } from "../../src/shared/knowledge/export";
import { newId, nowIso, placeholders } from "../portal/db";
import { HttpError } from "../portal/http";
import { knowledgeAudit } from "./audit";

const CHUNK = 100;

export async function restoreExport(db: D1Database, input: unknown, actor: string): Promise<{ spaceId: string; objects: number }> {
    const data: KnowledgeExport = parseKnowledgeExport(input);
    if (data.scope !== "space") throw new HttpError(422, "validation", "Only a whole-space export can be restored");
    const space = data.space;
    if (await db.prepare("SELECT 1 FROM knowledge_spaces WHERE id = ?").bind(space.id).first())
        throw new HttpError(409, "conflict", "That space already exists here");
    for (let i = 0; i < data.objects.length; i += 90) {
        const ids = data.objects.slice(i, i + 90).map((o) => o.id);
        const clash = await db.prepare(`SELECT id FROM knowledge_objects WHERE id IN (${placeholders(ids.length)}) LIMIT 1`).bind(...ids).first();
        if (clash) throw new HttpError(409, "conflict", "Objects in this export already exist here");
    }

    const now = nowIso();
    const owner = data.exportedBy;
    const s: D1PreparedStatement[] = [];
    s.push(
        db
            .prepare(
                "INSERT INTO knowledge_spaces (id, name, kind, personal_owner, time_zone, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(space.id, space.name, space.kind, space.kind === "personal" ? owner : null, space.timeZone, owner, space.createdAt || now, now),
    );
    const members = space.kind === "personal" ? [{ email: owner, role: "owner" as const }] : data.members;
    for (const m of members)
        s.push(
            db
                .prepare("INSERT INTO knowledge_memberships (space_id, email, role, added_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
                .bind(space.id, m.email, m.role, actor, now, now),
        );
    for (const t of data.types)
        s.push(
            db
                .prepare(
                    `INSERT INTO knowledge_object_types (id, space_id, name, slug, icon, description, schema_json, sort_order, archived_at, version, created_by, updated_by, created_at, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                )
                .bind(
                    t.id,
                    space.id,
                    t.name,
                    t.slug,
                    t.icon,
                    t.description,
                    JSON.stringify(t.schema),
                    t.sortOrder,
                    t.archivedAt,
                    t.version,
                    t.createdBy,
                    t.createdBy,
                    t.createdAt,
                    t.updatedAt,
                ),
        );
    for (const o of data.objects) {
        let normalised;
        try {
            normalised = normaliseDocument(o.content);
        } catch (error) {
            throw new HttpError(422, "validation", `Object ${o.id}: ${(error as Error).message}`);
        }
        s.push(
            db
                .prepare(
                    `INSERT INTO knowledge_objects (id, space_id, type_id, title, content_json, content_format, body_text, properties_json, status, in_inbox, daily_date,
                        source_system, source_id, search_rowid, version, created_by, updated_by, created_at, updated_at, archived_at, trashed_at, trashed_by)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(search_rowid), 0) + 1 FROM knowledge_objects), ?, ?, ?, ?, ?, ?, ?, ?)`,
                )
                .bind(
                    o.id,
                    space.id,
                    o.typeId,
                    o.title,
                    JSON.stringify(normalised.doc),
                    CONTENT_FORMAT,
                    normalised.text,
                    JSON.stringify(o.properties),
                    o.status,
                    o.inInbox ? 1 : 0,
                    o.dailyDate,
                    o.source?.system ?? null,
                    o.source?.id ?? null,
                    o.version,
                    o.createdBy,
                    o.updatedBy,
                    o.createdAt,
                    o.updatedAt,
                    o.archivedAt,
                    o.trashedAt,
                    o.trashedBy,
                ),
        );
    }
    const tagNames = [...new Map(data.objects.flatMap((o) => o.tags).map((name) => [name.toLowerCase(), name])).values()];
    for (const name of tagNames)
        s.push(db.prepare("INSERT INTO knowledge_tags (id, space_id, name, created_at) VALUES (?, ?, ?, ?)").bind(newId("ktg"), space.id, name, now));
    for (const o of data.objects)
        for (const name of o.tags)
            s.push(
                db
                    .prepare(
                        "INSERT OR IGNORE INTO knowledge_object_tags (space_id, object_id, tag_id) SELECT ?, ?, id FROM knowledge_tags WHERE space_id = ? AND name = ?",
                    )
                    .bind(space.id, o.id, space.id, name),
            );
    for (const r of data.relations)
        s.push(
            db
                .prepare(
                    "INSERT INTO knowledge_relations (id, space_id, source_id, target_id, relation_type, origin, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                )
                .bind(r.id, space.id, r.sourceId, r.targetId, r.relationType, r.origin, r.createdBy, r.createdAt),
        );
    for (const r of data.revisions)
        s.push(
            db
                .prepare(
                    `INSERT INTO knowledge_revisions (id, space_id, object_id, version, kind, type_id, title, content_json, content_format, properties_json, changed_by, started_at, changed_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                )
                .bind(
                    r.id,
                    space.id,
                    r.objectId,
                    r.version,
                    r.kind,
                    r.typeId,
                    r.title,
                    JSON.stringify(r.content),
                    CONTENT_FORMAT,
                    JSON.stringify(r.properties),
                    r.changedBy,
                    r.startedAt,
                    r.changedAt,
                ),
        );
    for (const c of data.collections) {
        s.push(
            db
                .prepare(
                    `INSERT INTO knowledge_collections (id, space_id, name, description, sort_order, archived_at, version, created_by, updated_by, created_at, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                )
                .bind(c.id, space.id, c.name, c.description, c.sortOrder, c.archivedAt, c.version, c.createdBy, c.updatedBy, c.createdAt, c.updatedAt),
        );
        for (const item of c.items)
            s.push(
                db
                    .prepare(
                        "INSERT INTO knowledge_collection_items (space_id, collection_id, object_id, position, pinned_at, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    )
                    .bind(space.id, c.id, item.objectId, item.position, item.pinnedAt, item.addedBy, item.addedAt),
            );
    }
    for (const p of data.pins)
        s.push(
            db
                .prepare("INSERT INTO knowledge_pins (space_id, object_id, position, pinned_by, pinned_at) VALUES (?, ?, ?, ?, ?)")
                .bind(space.id, p.objectId, p.position, p.pinnedBy, p.pinnedAt),
        );
    for (const t of data.templates)
        s.push(
            db
                .prepare(
                    `INSERT INTO knowledge_templates (id, space_id, type_id, name, description, title, content_json, properties_json, is_default, archived_at, version, created_by, updated_by, created_at, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                )
                .bind(
                    t.id,
                    space.id,
                    t.typeId,
                    t.name,
                    t.description,
                    t.title,
                    JSON.stringify(normaliseDocument(t.content).doc),
                    JSON.stringify(t.properties),
                    t.isDefault ? 1 : 0,
                    t.archivedAt,
                    t.version,
                    t.createdBy,
                    t.updatedBy,
                    t.createdAt,
                    t.updatedAt,
                ),
        );
    data.savedViews.forEach((v, index) =>
        s.push(
            db
                .prepare(
                    `INSERT INTO knowledge_saved_views (id, space_id, owner_email, name, definition_json, sort_order, created_by, updated_by, created_at, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                )
                .bind(v.id, space.id, v.shared ? null : owner, v.name, JSON.stringify(v.definition), index, v.createdBy, v.createdBy, v.createdAt, v.updatedAt),
        ),
    );
    for (const f of data.favourites)
        s.push(
            db
                .prepare("INSERT INTO knowledge_favourites (email, space_id, object_id, position, created_at) VALUES (?, ?, ?, ?, ?)")
                .bind(owner, space.id, f.objectId, f.position, f.createdAt),
        );
    for (const a of data.audit)
        s.push(
            db
                .prepare("INSERT INTO knowledge_audit (space_id, at, actor, action, entity_type, entity_id, summary, changes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
                .bind(space.id, a.at, a.actor, a.action, a.entityType, a.entityId, a.summary, a.changes === null ? null : JSON.stringify(a.changes)),
        );
    s.push(
        db
            .prepare(
                `INSERT INTO knowledge_fts (rowid, title, body, tags) SELECT o.search_rowid, o.title, o.body_text,
                    COALESCE((SELECT group_concat(t.name, ' ') FROM knowledge_object_tags ot JOIN knowledge_tags t ON t.id = ot.tag_id WHERE ot.object_id = o.id), '')
                 FROM knowledge_objects o WHERE o.space_id = ?`,
            )
            .bind(space.id),
        knowledgeAudit(db, {
            spaceId: space.id,
            actor,
            action: "space.restore",
            entityType: "space",
            entityId: space.id,
            summary: "Restored the space from an export",
            changes: { objects: data.objects.length, exportedAt: data.exportedAt },
        }),
    );

    for (let i = 0; i < s.length; i += CHUNK) await db.batch(s.slice(i, i + CHUNK));
    return { spaceId: space.id, objects: data.objects.length };
}
