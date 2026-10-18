// Knowledge objects: create, read, update, organise, trash and restore, with revisions, tags,
// links and backlinks.
//
// Every write is one D1 batch (a transaction) holding the change, its revision, the search index
// update, the rebuilt links and the audit entry, so they can never disagree. Saves carry the version
// the editor started from; if anyone saved in between, nothing is written and the caller gets 409.
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { z } from "zod";
import { CONTENT_FORMAT, DocumentError, normaliseDocument } from "../../src/shared/knowledge/content";
import { addDays, startOfLocalDay } from "../../src/shared/knowledge/dates";
import { PERSON_TYPE_SLUG, type PropertyDef, type PropertyValues, applyPropertyChanges, referencedIds } from "../../src/shared/knowledge/properties";
import type {
    KnowledgeLink,
    KnowledgeObjectDetail,
    KnowledgeObjectSummary,
    KnowledgeRevision,
    KnowledgeRevisionDetail,
    LinkFilter,
    ListFilters,
    ObjectStatus,
} from "../../src/shared/knowledge/types";
import type { PortalUser } from "../../src/shared/portal/types";
import { isGuardFailure, newId, nowIso, parseJson, placeholders, requireChange } from "../portal/db";
import { HttpError } from "../portal/http";
import { notFound, requireObject, requireSpace } from "./access";
import { knowledgeAudit } from "./audit";
import { OBJECT_COLUMNS, type ObjectRow, SUMMARY_COLUMNS, type SummaryRow, toObject, toSummary } from "./rows";
import { indexStatements, unindexStatement } from "./search";
import { defaultTemplateId, templateStart } from "./templates";
import { defaultTypeId, getTypeInSpace } from "./types";

/** Consecutive saves by one person within this window update one revision instead of adding more. */
export const REVISION_WINDOW_MS = 10 * 60_000;
export const MAX_TAGS = 30;
export const MAX_BULK = 200;
const OBJECT_ID = /^kob_[a-z0-9]{14}$/;

/** A 409 that tells the editor which version is now current. */
export class KnowledgeConflict extends HttpError {
    constructor(
        message: string,
        readonly current: { version: number; updatedBy: string; updatedAt: string; status: ObjectStatus } | null,
    ) {
        super(409, "conflict", message);
    }
}

// --- Normalising input ---------------------------------------------------------------------------

export const normaliseTitle = (value: string) =>
    value
        .replace(/[\u0000-\u001F\u007F]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 300);

export const normaliseTags = (tags: string[]) => {
    const seen = new Map<string, string>();
    for (const raw of tags) {
        const tag = raw
            .replace(/^#/, "")
            .replace(/[\u0000-\u001F\u007F]/g, "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 50);
        if (tag && !seen.has(tag.toLowerCase())) seen.set(tag.toLowerCase(), tag);
    }
    if (seen.size > MAX_TAGS) throw new HttpError(422, "validation", `Use ${MAX_TAGS} tags or fewer`);
    return [...seen.values()];
};

export const parseContent = (content: unknown) => {
    try {
        return normaliseDocument(content);
    } catch (error) {
        if (error instanceof DocumentError) throw new HttpError(422, "validation", error.message);
        throw error;
    }
};

export const propertyIssue = (issues: { path: string; message: string }[]) => {
    if (issues.length) throw new HttpError(422, "validation", issues[0].message);
};

/** Reference properties may only point at live objects in the same space (and of the right type). */
export async function checkReferences(db: D1Database, spaceId: string, defs: readonly PropertyDef[], values: PropertyValues, keys: Set<string>) {
    const refs = referencedIds(defs, values).filter((r) => keys.has(r.def.key));
    const ids = [...new Set(refs.flatMap((r) => r.ids))];
    if (!ids.length) return;
    const rows = await db
        .prepare(
            `SELECT o.id, o.type_id, t.slug FROM knowledge_objects o JOIN knowledge_object_types t ON t.id = o.type_id
             WHERE o.space_id = ? AND o.status <> 'trashed' AND o.id IN (${placeholders(ids.length)})`,
        )
        .bind(spaceId, ...ids)
        .all<{ id: string; type_id: string; slug: string }>();
    const found = new Map(rows.results.map((r) => [r.id, r]));
    for (const { def, ids: refIds } of refs) {
        for (const id of refIds) {
            const target = found.get(id);
            if (!target) throw new HttpError(422, "validation", `${def.label}: choose objects from this space`);
            if (def.type === "person" && target.slug !== PERSON_TYPE_SLUG) throw new HttpError(422, "validation", `${def.label}: choose a Person`);
            if (def.type === "object" && def.targetTypeId && target.type_id !== def.targetTypeId)
                throw new HttpError(422, "validation", `${def.label}: choose an object of the right type`);
        }
    }
}

// --- Statements ----------------------------------------------------------------------------------

const tagStatements = (db: D1Database, spaceId: string, objectId: string, tags: string[], now: string): D1PreparedStatement[] => [
    db.prepare("DELETE FROM knowledge_object_tags WHERE object_id = ?").bind(objectId),
    ...tags.flatMap((name) => [
        db.prepare("INSERT OR IGNORE INTO knowledge_tags (id, space_id, name, created_at) VALUES (?, ?, ?, ?)").bind(newId("ktg"), spaceId, name, now),
        db
            .prepare(
                "INSERT OR IGNORE INTO knowledge_object_tags (space_id, object_id, tag_id) SELECT ?, ?, id FROM knowledge_tags WHERE space_id = ? AND name = ?",
            )
            .bind(spaceId, objectId, spaceId, name),
    ]),
];

/**
 * Replaces the relations of one origin from a source. Targets are selected from the same space, so
 * a link to an object elsewhere (or one that doesn't exist) simply produces no relation.
 */
const relationStatements = (
    db: D1Database,
    spaceId: string,
    sourceId: string,
    origin: "content" | "property",
    links: { targetId: string; relationType: string }[],
    actor: string,
    now: string,
): D1PreparedStatement[] => [
    db.prepare("DELETE FROM knowledge_relations WHERE source_id = ? AND origin = ?").bind(sourceId, origin),
    ...links
        .filter((link) => link.targetId !== sourceId)
        .map((link) =>
            db
                .prepare(
                    `INSERT OR IGNORE INTO knowledge_relations (id, space_id, source_id, target_id, relation_type, origin, created_by, created_at)
                     SELECT ?, ?, ?, o.id, ?, ?, ?, ? FROM knowledge_objects o WHERE o.space_id = ? AND o.id = ?`,
                )
                .bind(newId("krl"), spaceId, sourceId, link.relationType, origin, actor, now, spaceId, link.targetId),
        ),
];

const contentLinks = (links: string[]) => links.map((targetId) => ({ targetId, relationType: "mentions" }));
const propertyLinks = (defs: readonly PropertyDef[], values: PropertyValues) =>
    referencedIds(defs, values).flatMap(({ def, ids }) => ids.map((targetId) => ({ targetId, relationType: def.key })));

interface Snapshot {
    typeId: string;
    title: string;
    contentJson: string;
    propertiesJson: string;
}

export const revisionInsert = (
    db: D1Database,
    row: { id: string; space_id: string },
    version: number,
    kind: string,
    snap: Snapshot,
    actor: string,
    now: string,
    condition = "",
    conditionBinds: unknown[] = [],
) =>
    db
        .prepare(
            `INSERT INTO knowledge_revisions (id, space_id, object_id, version, kind, type_id, title, content_json, content_format, properties_json, changed_by, started_at, changed_at)
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? ${condition}`,
        )
        .bind(
            newId("krv"),
            row.space_id,
            row.id,
            version,
            kind,
            snap.typeId,
            snap.title,
            snap.contentJson,
            CONTENT_FORMAT,
            snap.propertiesJson,
            actor,
            now,
            now,
            ...conditionBinds,
        );

// --- Reading -------------------------------------------------------------------------------------

/** A link from `o` to another object that isn't in the trash, and one to `o` from such an object. */
const LIVE_OUT = `SELECT 1 FROM knowledge_relations r JOIN knowledge_objects x ON x.id = r.target_id WHERE r.source_id = o.id AND x.status <> 'trashed'`;
const LIVE_IN = `SELECT 1 FROM knowledge_relations r JOIN knowledge_objects x ON x.id = r.source_id WHERE r.target_id = o.id AND x.status <> 'trashed'`;

/** Conditions on `o` for a list's link filter. Daily notes are left out: they're dated and standalone by nature. */
const linkConditions: Record<Exclude<LinkFilter, "any">, string[]> = {
    unlinked: ["o.daily_date IS NULL", `NOT EXISTS (${LIVE_OUT})`, `NOT EXISTS (${LIVE_IN})`],
    no_backlinks: ["o.daily_date IS NULL", `NOT EXISTS (${LIVE_IN})`],
    no_outgoing: ["o.daily_date IS NULL", `NOT EXISTS (${LIVE_OUT})`],
};

export async function listObjects(
    db: D1Database,
    spaceId: string,
    filters: ListFilters,
    page: { limit: number; offset: number } = { limit: 200, offset: 0 },
    timeZone = "UTC",
): Promise<{ objects: KnowledgeObjectSummary[]; total: number }> {
    const where = ["o.space_id = ?"];
    const binds: unknown[] = [spaceId];
    if (filters.view === "inbox") where.push("o.status = 'active' AND o.in_inbox = 1");
    else if (filters.view === "archived") where.push("o.status = 'archived'");
    else if (filters.view === "trashed") where.push("o.status = 'trashed'");
    else where.push("o.status = 'active'");
    if (filters.typeId) {
        where.push("o.type_id = ?");
        binds.push(filters.typeId);
    }
    if (filters.tag) {
        where.push("EXISTS (SELECT 1 FROM knowledge_object_tags ot JOIN knowledge_tags t ON t.id = ot.tag_id WHERE ot.object_id = o.id AND t.name = ?)");
        binds.push(filters.tag);
    }
    if (filters.links && filters.links !== "any") where.push(...linkConditions[filters.links]);
    // Date ranges are whole days in the space's time zone, turned into UTC instants here.
    for (const [column, from, to] of [
        ["o.created_at", filters.createdFrom, filters.createdTo],
        ["o.updated_at", filters.updatedFrom, filters.updatedTo],
    ] as const) {
        if (from) {
            where.push(`${column} >= ?`);
            binds.push(startOfLocalDay(from, timeZone));
        }
        if (to) {
            where.push(`${column} < ?`);
            binds.push(startOfLocalDay(addDays(to, 1), timeZone));
        }
    }
    const order =
        filters.view === "trashed"
            ? "o.trashed_at DESC"
            : filters.sort === "title"
              ? "o.title COLLATE NOCASE, o.updated_at DESC"
              : filters.sort === "created"
                ? "o.created_at DESC"
                : "o.updated_at DESC";
    const [rows, count] = await db.batch([
        db
            .prepare(`SELECT ${SUMMARY_COLUMNS} FROM knowledge_objects o WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ? OFFSET ?`)
            .bind(...binds, page.limit, page.offset),
        db.prepare(`SELECT COUNT(*) AS n FROM knowledge_objects o WHERE ${where.join(" AND ")}`).bind(...binds),
    ]);
    return { objects: (rows.results as SummaryRow[]).map(toSummary), total: (count.results[0] as { n: number }).n };
}

export async function spaceCounts(db: D1Database, spaceId: string) {
    const row = await db
        .prepare(
            `SELECT COALESCE(SUM(status = 'active'), 0) AS active, COALESCE(SUM(status = 'active' AND in_inbox = 1), 0) AS inbox,
                    COALESCE(SUM(status = 'archived'), 0) AS archived, COALESCE(SUM(status = 'trashed'), 0) AS trashed
             FROM knowledge_objects WHERE space_id = ?`,
        )
        .bind(spaceId)
        .first<{ active: number; inbox: number; archived: number; trashed: number }>();
    return row ?? { active: 0, inbox: 0, archived: 0, trashed: 0 };
}

export async function listTags(db: D1Database, spaceId: string): Promise<string[]> {
    const rows = await db
        .prepare(
            `SELECT t.name FROM knowledge_tags t WHERE t.space_id = ? AND EXISTS (
                SELECT 1 FROM knowledge_object_tags ot JOIN knowledge_objects o ON o.id = ot.object_id WHERE ot.tag_id = t.id AND o.status <> 'trashed')
             ORDER BY t.name COLLATE NOCASE`,
        )
        .bind(spaceId)
        .all<{ name: string }>();
    return rows.results.map((r) => r.name);
}

export const loadRow = async (db: D1Database, objectId: string) => {
    const row = await db.prepare(`SELECT ${OBJECT_COLUMNS} FROM knowledge_objects o WHERE o.id = ?`).bind(objectId).first<ObjectRow>();
    if (!row) throw notFound();
    return row;
};

type LinkRow = {
    relation_id: string;
    relation_type: string;
    origin: KnowledgeLink["origin"];
    id: string;
    title: string;
    type_id: string;
    status: ObjectStatus;
};
const toLink = (r: LinkRow): KnowledgeLink => ({
    relationId: r.relation_id,
    relationType: r.relation_type,
    origin: r.origin,
    object: { id: r.id, title: r.title, typeId: r.type_id, status: r.status },
});

/** The object with its links and backlinks. Access must already have been checked. */
export async function objectDetail(db: D1Database, objectId: string): Promise<KnowledgeObjectDetail> {
    const row = await loadRow(db, objectId);
    const object = toObject(row);
    const linkColumns = "r.id AS relation_id, r.relation_type, r.origin, o.id, o.title, o.type_id, o.status";
    const [outgoing, backlinks] = await db.batch([
        db
            .prepare(
                `SELECT ${linkColumns} FROM knowledge_relations r JOIN knowledge_objects o ON o.id = r.target_id
                 WHERE r.source_id = ? AND o.space_id = ? AND o.status <> 'trashed' ORDER BY r.origin, o.title COLLATE NOCASE`,
            )
            .bind(objectId, row.space_id),
        db
            .prepare(
                `SELECT ${linkColumns} FROM knowledge_relations r JOIN knowledge_objects o ON o.id = r.source_id
                 WHERE r.target_id = ? AND o.space_id = ? AND o.status <> 'trashed' ORDER BY o.updated_at DESC`,
            )
            .bind(objectId, row.space_id),
    ]);
    const refIds = [...new Set(Object.values(object.properties).flatMap((v) => (Array.isArray(v) ? v.filter((id) => OBJECT_ID.test(id)) : [])))];
    const referenced: KnowledgeObjectDetail["referenced"] = {};
    if (refIds.length) {
        const refs = await db
            .prepare(`SELECT id, title, type_id, status FROM knowledge_objects WHERE space_id = ? AND id IN (${placeholders(refIds.length)})`)
            .bind(row.space_id, ...refIds)
            .all<{ id: string; title: string; type_id: string; status: ObjectStatus }>();
        for (const r of refs.results) referenced[r.id] = { id: r.id, title: r.title, typeId: r.type_id, status: r.status };
    }
    return { object, outgoing: (outgoing.results as LinkRow[]).map(toLink), backlinks: (backlinks.results as LinkRow[]).map(toLink), referenced };
}

/** Titles matching what was typed after [[, for linking. */
export async function lookupObjects(db: D1Database, spaceId: string, query: string, limit = 8) {
    const q = query.trim().slice(0, 100);
    const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = await db
        .prepare(
            `SELECT id, title, type_id FROM knowledge_objects WHERE space_id = ? AND status <> 'trashed' AND title LIKE ? ESCAPE '\\'
             ORDER BY title LIKE ? ESCAPE '\\' DESC, updated_at DESC LIMIT ?`,
        )
        .bind(spaceId, pattern, `${pattern.slice(1)}`, Math.min(limit, 20))
        .all<{ id: string; title: string; type_id: string }>();
    return rows.results.map((r) => ({ id: r.id, title: r.title, typeId: r.type_id }));
}

// --- Creating ------------------------------------------------------------------------------------

const createInput = z.object({
    typeId: z.string().max(40).optional(),
    title: z.string().max(1000).default(""),
    content: z.unknown().optional(),
    properties: z.record(z.string(), z.unknown()).default({}),
    tags: z.array(z.string().max(100)).max(100).default([]),
    inInbox: z.boolean().default(false),
    /** Start from this template: its title, document and property values, copied. */
    templateId: z.string().max(40).optional(),
    /** Start from the type's default template, if it has one ("New" does; quick capture doesn't). */
    useDefaultTemplate: z.boolean().default(false),
});

export interface CreateObjectOptions {
    /**
     * Where the object came from (e.g. an approved Daly Intelligence suggestion). Unique per space:
     * creating again with the same source returns the object already made instead of a second one.
     */
    source?: { system: string; id: string };
}

/** The object an earlier create with this source made, if the caller can still read it. */
async function objectFromSource(db: D1Database, user: PortalUser, spaceId: string, source: { system: string; id: string }) {
    const row = await db
        .prepare("SELECT id FROM knowledge_objects WHERE space_id = ? AND source_system = ? AND source_id = ?")
        .bind(spaceId, source.system, source.id)
        .first<{ id: string }>();
    if (!row) return null;
    await requireObject(db, user, row.id);
    return objectDetail(db, row.id);
}

export async function createObject(
    db: D1Database,
    user: PortalUser,
    spaceId: string,
    input: unknown,
    options: CreateObjectOptions = {},
): Promise<KnowledgeObjectDetail> {
    const space = await requireSpace(db, user, spaceId, "editor");
    if (options.source) {
        const earlier = await objectFromSource(db, user, spaceId, options.source);
        if (earlier) return earlier;
    }
    const body = createInput.parse(input);
    let type = await getTypeInSpace(db, spaceId, body.typeId ?? (await defaultTypeId(db, spaceId)));
    const templateId = body.templateId ?? (body.useDefaultTemplate ? await defaultTemplateId(db, type.id) : null);
    const start = templateId ? await templateStart(db, spaceId, space.time_zone, templateId) : null;
    if (start && start.typeId !== type.id) {
        if (body.typeId) throw new HttpError(422, "validation", "That template is for a different type");
        type = await getTypeInSpace(db, spaceId, start.typeId);
    }
    if (type.archived) throw new HttpError(422, "validation", "That object type is archived");
    // What the request says wins over the template; the template fills in the rest.
    const content = parseContent(body.content ?? start?.content ?? { type: "doc", content: [] });
    const { values, issues } = applyPropertyChanges(type.schema.properties, {}, { ...start?.properties, ...body.properties }, "create");
    propertyIssue(issues);
    await checkReferences(db, spaceId, type.schema.properties, values, new Set(Object.keys(values)));
    const tags = normaliseTags(body.tags);
    const title = normaliseTitle(body.title || start?.title || "");

    const id = newId("kob");
    const now = nowIso();
    const snap: Snapshot = { typeId: type.id, title, contentJson: JSON.stringify(content.doc), propertiesJson: JSON.stringify(values) };
    const statements = [
        db
            .prepare(
                `INSERT INTO knowledge_objects (id, space_id, type_id, title, content_json, content_format, body_text, properties_json, in_inbox, search_rowid,
                    created_by, updated_by, created_at, updated_at, source_system, source_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(search_rowid), 0) + 1 FROM knowledge_objects), ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
                id,
                spaceId,
                type.id,
                title,
                snap.contentJson,
                CONTENT_FORMAT,
                content.text,
                snap.propertiesJson,
                body.inInbox ? 1 : 0,
                user.email,
                user.email,
                now,
                now,
                options.source?.system ?? null,
                options.source?.id ?? null,
            ),
        revisionInsert(db, { id, space_id: spaceId }, 1, "create", snap, user.email, now),
        ...tagStatements(db, spaceId, id, tags, now),
        ...relationStatements(db, spaceId, id, "content", contentLinks(content.links), user.email, now),
        ...relationStatements(db, spaceId, id, "property", propertyLinks(type.schema.properties, values), user.email, now),
        ...indexStatements(db, id),
        knowledgeAudit(db, {
            spaceId,
            actor: user.email,
            action: "object.create",
            entityType: "object",
            entityId: id,
            summary: templateId ? "Created an object from a template" : "Created an object",
            ...(templateId ? { changes: { templateId } } : {}),
        }),
    ];
    try {
        await db.batch(statements);
    } catch (error) {
        // Two copies of one sourced create at the same moment: the unique index let only the first in.
        if (options.source && /UNIQUE constraint failed: knowledge_objects\.space_id, knowledge_objects\.source_system/.test(String((error as Error)?.message))) {
            const first = await objectFromSource(db, user, spaceId, options.source);
            if (first) return first;
        }
        throw error;
    }
    const detail = await objectDetail(db, id);
    return start?.notices.length ? { ...detail, notices: start.notices } : detail;
}

// --- Updating ------------------------------------------------------------------------------------

const updateInput = z
    .object({
        version: z.number().int().min(1),
        title: z.string().max(1000).optional(),
        content: z.unknown().optional(),
        properties: z.record(z.string(), z.unknown()).optional(),
        typeId: z.string().max(40).optional(),
        tags: z.array(z.string().max(100)).max(100).optional(),
        inInbox: z.boolean().optional(),
        /** The editor's session id: saves from one session within a few minutes share a revision. */
        session: z
            .string()
            .regex(/^[A-Za-z0-9_-]{8,64}$/)
            .optional(),
    })
    .strict();

const conflict = (row: ObjectRow, message = "Someone else saved a newer version. Your changes haven't been saved.") =>
    new KnowledgeConflict(message, { version: row.version, updatedBy: row.updated_by, updatedAt: row.updated_at, status: row.status });

export async function updateObject(db: D1Database, user: PortalUser, objectId: string, input: unknown): Promise<KnowledgeObjectDetail> {
    await requireObject(db, user, objectId, "editor");
    const body = updateInput.parse(input);
    const row = await loadRow(db, objectId);
    if (row.status === "trashed") throw conflict(row, "This object is in the trash. Restore it before editing.");
    if (row.version !== body.version) throw conflict(row);

    const existing = toObject(row);
    let type = await getTypeInSpace(db, row.space_id, row.type_id);
    if (body.typeId && body.typeId !== row.type_id) {
        type = await getTypeInSpace(db, row.space_id, body.typeId);
        if (type.archived) throw new HttpError(422, "validation", "That object type is archived");
    }
    const typeChanged = type.id !== row.type_id;
    const title = body.title === undefined ? row.title : normaliseTitle(body.title);
    const content = body.content === undefined ? null : parseContent(body.content);
    const contentJson = content ? JSON.stringify(content.doc) : row.content_json;
    const { values, issues } = applyPropertyChanges(type.schema.properties, existing.properties, body.properties ?? {}, "update");
    propertyIssue(issues);
    await checkReferences(db, row.space_id, type.schema.properties, values, new Set(Object.keys(body.properties ?? {})));
    const propertiesJson = JSON.stringify(values);
    const tags = body.tags === undefined ? null : normaliseTags(body.tags);
    const inInbox = body.inInbox === undefined ? !!row.in_inbox : body.inInbox;

    const changed = {
        title: title !== row.title,
        content: contentJson !== row.content_json,
        properties: propertiesJson !== row.properties_json,
        type: typeChanged,
        tags: tags !== null && JSON.stringify([...tags].sort()) !== JSON.stringify([...existing.tags].sort()),
        inInbox: inInbox !== !!row.in_inbox,
    };
    const fields = Object.entries(changed)
        .filter(([, on]) => on)
        .map(([field]) => field);
    if (!fields.length) return objectDetail(db, objectId);

    await writeUpdate(db, user, row, {
        kind: "edit",
        snap: { typeId: type.id, title, contentJson, propertiesJson },
        bodyText: content ? content.text : null,
        inInbox,
        tags: changed.tags ? tags : null,
        contentLinks: changed.content && content ? content.links : null,
        propertyLinks: changed.properties || typeChanged ? propertyLinks(type.schema.properties, values) : null,
        revision: changed.title || changed.content || changed.properties || changed.type,
        fields,
        session: body.session ?? null,
    });
    return objectDetail(db, objectId);
}

interface UpdatePlan {
    kind: "edit" | "restore";
    snap: Snapshot;
    bodyText: string | null;
    inInbox: boolean;
    tags: string[] | null;
    contentLinks: string[] | null;
    propertyLinks: { targetId: string; relationType: string }[] | null;
    /** Whether the change is worth a revision (title, content, properties or type). */
    revision: boolean;
    fields: string[];
    session: string | null;
}

async function writeUpdate(db: D1Database, user: PortalUser, row: ObjectRow, plan: UpdatePlan) {
    const now = nowIso();
    const version = row.version + 1;
    const audit = {
        spaceId: row.space_id,
        actor: user.email,
        action: plan.kind === "restore" ? "object.restore_revision" : "object.update",
        entityType: "object" as const,
        entityId: row.id,
        summary: plan.kind === "restore" ? "Restored an earlier version" : "Edited an object",
        changes: { fields: plan.fields },
    };
    const statements: D1PreparedStatement[] = [
        db
            .prepare(
                `UPDATE knowledge_objects SET type_id = ?, title = ?, content_json = ?, content_format = ?, body_text = COALESCE(?, body_text), properties_json = ?,
                    in_inbox = ?, updated_by = ?, updated_at = ?, version = version + 1
                 WHERE id = ? AND version = ? AND status <> 'trashed'`,
            )
            .bind(
                plan.snap.typeId,
                plan.snap.title,
                plan.snap.contentJson,
                CONTENT_FORMAT,
                plan.bodyText,
                plan.snap.propertiesJson,
                plan.inInbox ? 1 : 0,
                user.email,
                now,
                row.id,
                row.version,
            ),
        requireChange(db),
    ];
    if (plan.revision && plan.kind === "edit" && plan.session) {
        // One revision per editing session: extend this session's latest edit revision if it started
        // recently and nobody saved in between; otherwise add a new one (and only then an audit entry).
        statements.push(
            db
                .prepare(
                    `UPDATE knowledge_revisions SET version = ?, type_id = ?, title = ?, content_json = ?, content_format = ?, properties_json = ?, changed_at = ?
                     WHERE id = (SELECT id FROM knowledge_revisions WHERE object_id = ? ORDER BY version DESC LIMIT 1)
                       AND changed_by = ? AND session_id = ? AND kind = 'edit' AND started_at > ?`,
                )
                .bind(
                    version,
                    plan.snap.typeId,
                    plan.snap.title,
                    plan.snap.contentJson,
                    CONTENT_FORMAT,
                    plan.snap.propertiesJson,
                    now,
                    row.id,
                    user.email,
                    plan.session,
                    new Date(Date.now() - REVISION_WINDOW_MS).toISOString(),
                ),
            db
                .prepare(
                    `INSERT INTO knowledge_revisions (id, space_id, object_id, version, kind, type_id, title, content_json, content_format, properties_json, changed_by, session_id, started_at, changed_at)
                     SELECT ?, ?, ?, ?, 'edit', ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() = 0`,
                )
                .bind(
                    newId("krv"),
                    row.space_id,
                    row.id,
                    version,
                    plan.snap.typeId,
                    plan.snap.title,
                    plan.snap.contentJson,
                    CONTENT_FORMAT,
                    plan.snap.propertiesJson,
                    user.email,
                    plan.session,
                    now,
                    now,
                ),
            knowledgeAudit(db, audit, "WHERE changes() > 0"),
        );
    } else if (plan.revision) {
        statements.push(revisionInsert(db, row, version, plan.kind, plan.snap, user.email, now), knowledgeAudit(db, audit));
    } else {
        statements.push(knowledgeAudit(db, audit));
    }
    if (plan.tags) statements.push(...tagStatements(db, row.space_id, row.id, plan.tags, now));
    if (plan.contentLinks) statements.push(...relationStatements(db, row.space_id, row.id, "content", contentLinks(plan.contentLinks), user.email, now));
    if (plan.propertyLinks) statements.push(...relationStatements(db, row.space_id, row.id, "property", plan.propertyLinks, user.email, now));
    statements.push(...indexStatements(db, row.id));
    try {
        await db.batch(statements);
    } catch (error) {
        if (isGuardFailure(error)) throw conflict(await loadRow(db, row.id));
        throw error;
    }
}

// --- Organising ----------------------------------------------------------------------------------

export const STATUS_ACTIONS = {
    archive: { from: ["active"], to: "archived", audit: "object.archive", summary: "Archived an object", minimum: "editor" },
    unarchive: { from: ["archived"], to: "active", audit: "object.unarchive", summary: "Unarchived an object", minimum: "editor" },
    trash: { from: ["active", "archived"], to: "trashed", audit: "object.trash", summary: "Moved an object to the trash", minimum: "editor" },
    restore: { from: ["trashed"], to: "active", audit: "object.restore", summary: "Restored an object from the trash", minimum: "editor" },
} as const;
export type StatusAction = keyof typeof STATUS_ACTIONS;

const statusSet = (to: ObjectStatus) =>
    to === "archived"
        ? "status = 'archived', archived_at = ?1, trashed_at = NULL, trashed_by = NULL"
        : to === "trashed"
          ? "status = 'trashed', trashed_at = ?1, trashed_by = ?2"
          : "status = 'active', archived_at = NULL, trashed_at = NULL, trashed_by = NULL";

export async function changeStatus(db: D1Database, user: PortalUser, objectId: string, action: StatusAction): Promise<KnowledgeObjectDetail> {
    const spec = STATUS_ACTIONS[action];
    const access = await requireObject(db, user, objectId, spec.minimum);
    if (!(spec.from as readonly string[]).includes(access.status))
        throw new HttpError(409, "conflict", access.status === "trashed" ? "This object is in the trash" : `This object is already ${access.status}`);
    const now = nowIso();
    try {
        await db.batch([
            db
                .prepare(
                    `UPDATE knowledge_objects SET ${statusSet(spec.to)}, version = version + 1 WHERE id = ?3 AND status IN (${spec.from.map((s) => `'${s}'`).join(", ")})`,
                )
                .bind(now, user.email, objectId),
            requireChange(db),
            knowledgeAudit(db, {
                spaceId: access.space_id,
                actor: user.email,
                action: spec.audit,
                entityType: "object",
                entityId: objectId,
                summary: spec.summary,
            }),
        ]);
    } catch (error) {
        if (isGuardFailure(error)) throw new HttpError(409, "conflict", "This object changed in the meantime. Reload and try again.");
        throw error;
    }
    return objectDetail(db, objectId);
}

const bulkInput = z.object({
    ids: z.array(z.string().regex(OBJECT_ID)).min(1).max(MAX_BULK),
    action: z.enum(["archive", "unarchive", "trash", "restore", "file"]),
});

/** One action on many objects in a space. Objects not in the right state are skipped, not errors. */
export async function bulkAction(db: D1Database, user: PortalUser, spaceId: string, input: unknown): Promise<{ changed: number }> {
    await requireSpace(db, user, spaceId, "editor");
    const body = bulkInput.parse(input);
    const ids = [...new Set(body.ids)];
    const now = nowIso();
    let update: D1PreparedStatement;
    if (body.action === "file") {
        // "File" takes objects out of the inbox.
        update = db
            .prepare(
                `UPDATE knowledge_objects SET in_inbox = 0, version = version + 1 WHERE space_id = ? AND in_inbox = 1 AND id IN (${placeholders(ids.length)})`,
            )
            .bind(spaceId, ...ids);
    } else {
        const spec = STATUS_ACTIONS[body.action];
        update = db
            .prepare(
                `UPDATE knowledge_objects SET ${statusSet(spec.to)}, version = version + 1
                 WHERE space_id = ?3 AND status IN (${spec.from.map((s) => `'${s}'`).join(", ")}) AND id IN (${ids.map((_, i) => `?${i + 4}`).join(", ")})`,
            )
            .bind(now, user.email, spaceId, ...ids);
    }
    const [result] = await db.batch([
        update,
        knowledgeAudit(
            db,
            {
                spaceId,
                actor: user.email,
                action: `object.bulk_${body.action}`,
                entityType: "object",
                summary: `Bulk ${body.action}`,
                changes: { ids },
            },
            "WHERE changes() > 0",
        ),
    ]);
    return { changed: result.meta.changes ?? 0 };
}

/** Permanently deletes an object that is already in the trash. Owners only, with typed confirmation. */
export async function deletePermanently(db: D1Database, user: PortalUser, objectId: string, input: unknown): Promise<void> {
    z.object({ confirm: z.literal("DELETE", { error: "Type DELETE to confirm" }) }).parse(input);
    const access = await requireObject(db, user, objectId, "owner");
    if (access.status !== "trashed") throw new HttpError(409, "conflict", "Move it to the trash first");
    try {
        await db.batch([
            unindexStatement(db, objectId),
            db.prepare("DELETE FROM knowledge_objects WHERE id = ? AND status = 'trashed'").bind(objectId),
            requireChange(db),
            knowledgeAudit(db, {
                spaceId: access.space_id,
                actor: user.email,
                action: "object.delete_permanently",
                entityType: "object",
                entityId: objectId,
                summary: "Permanently deleted an object and its history",
            }),
        ]);
    } catch (error) {
        if (isGuardFailure(error)) throw new HttpError(409, "conflict", "This object changed in the meantime. Reload and try again.");
        throw error;
    }
}

// --- Revisions -----------------------------------------------------------------------------------

type RevisionRow = {
    id: string;
    version: number;
    kind: KnowledgeRevision["kind"];
    type_id: string;
    title: string;
    content_json: string;
    properties_json: string;
    changed_by: string;
    started_at: string;
    changed_at: string;
};
const toRevision = (r: RevisionRow): KnowledgeRevision => ({
    id: r.id,
    version: r.version,
    kind: r.kind,
    title: r.title,
    changedBy: r.changed_by,
    startedAt: r.started_at,
    changedAt: r.changed_at,
});

export async function listRevisions(db: D1Database, user: PortalUser, objectId: string): Promise<KnowledgeRevision[]> {
    await requireObject(db, user, objectId);
    const rows = await db
        .prepare(
            "SELECT id, version, kind, type_id, title, changed_by, started_at, changed_at FROM knowledge_revisions WHERE object_id = ? ORDER BY version DESC LIMIT 200",
        )
        .bind(objectId)
        .all<RevisionRow>();
    return rows.results.map(toRevision);
}

const loadRevision = async (db: D1Database, objectId: string, revisionId: string) => {
    const row = await db.prepare("SELECT * FROM knowledge_revisions WHERE id = ? AND object_id = ?").bind(revisionId, objectId).first<RevisionRow>();
    if (!row) throw notFound();
    return row;
};

export async function getRevision(db: D1Database, user: PortalUser, objectId: string, revisionId: string): Promise<KnowledgeRevisionDetail> {
    await requireObject(db, user, objectId);
    const row = await loadRevision(db, objectId, revisionId);
    return {
        ...toRevision(row),
        typeId: row.type_id,
        content: parseJson(row.content_json, { type: "doc", content: [] }),
        properties: parseJson(row.properties_json, {}),
    };
}

/** Makes an earlier revision current again, as a new version. History is never rewritten. */
export async function restoreRevision(db: D1Database, user: PortalUser, objectId: string, revisionId: string, input: unknown): Promise<KnowledgeObjectDetail> {
    const { version } = z.object({ version: z.number().int().min(1) }).parse(input);
    await requireObject(db, user, objectId, "editor");
    const row = await loadRow(db, objectId);
    if (row.status === "trashed") throw conflict(row, "This object is in the trash. Restore it before restoring a version.");
    if (row.version !== version) throw conflict(row);
    const revision = await loadRevision(db, objectId, revisionId);
    const type = await getTypeInSpace(db, row.space_id, revision.type_id);
    const content = parseContent(parseJson(revision.content_json, null));
    const values = parseJson<PropertyValues>(revision.properties_json, {});
    await writeUpdate(db, user, row, {
        kind: "restore",
        snap: { typeId: type.id, title: revision.title, contentJson: JSON.stringify(content.doc), propertiesJson: JSON.stringify(values) },
        bodyText: content.text,
        inInbox: !!row.in_inbox,
        tags: null,
        contentLinks: content.links,
        propertyLinks: propertyLinks(type.schema.properties, values),
        revision: true,
        fields: ["title", "content", "properties", "type"],
        session: null,
    });
    return objectDetail(db, objectId);
}

// --- Manual relations ----------------------------------------------------------------------------

const relationInput = z.object({
    targetId: z.string().regex(OBJECT_ID, "Choose an object"),
    relationType: z
        .string()
        .trim()
        .toLowerCase()
        .transform((value) => value.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, ""))
        .pipe(z.string().min(1, "Name the relationship").max(40))
        .default("related"),
});

export async function addRelation(db: D1Database, user: PortalUser, sourceId: string, input: unknown): Promise<KnowledgeObjectDetail> {
    const source = await requireObject(db, user, sourceId, "editor");
    if (source.status === "trashed") throw new HttpError(409, "conflict", "This object is in the trash");
    const body = relationInput.parse(input);
    if (body.targetId === sourceId) throw new HttpError(422, "validation", "An object can't be related to itself");
    // The target must be a live object in the same space; anything else looks like it doesn't exist.
    const target = await db
        .prepare("SELECT id FROM knowledge_objects WHERE id = ? AND space_id = ? AND status <> 'trashed'")
        .bind(body.targetId, source.space_id)
        .first<{ id: string }>();
    if (!target) throw new HttpError(422, "validation", "Choose an object from this space");
    const id = newId("krl");
    const results = await db.batch([
        db
            .prepare(
                `INSERT OR IGNORE INTO knowledge_relations (id, space_id, source_id, target_id, relation_type, origin, created_by, created_at)
                 VALUES (?, ?, ?, ?, ?, 'manual', ?, ?)`,
            )
            .bind(id, source.space_id, sourceId, body.targetId, body.relationType, user.email, nowIso()),
        knowledgeAudit(
            db,
            {
                spaceId: source.space_id,
                actor: user.email,
                action: "relation.create",
                entityType: "relation",
                entityId: id,
                summary: "Linked two objects",
                changes: { sourceId, targetId: body.targetId },
            },
            "WHERE changes() > 0",
        ),
    ]);
    if (!results[0].meta.changes) throw new HttpError(409, "conflict", "These objects are already linked that way");
    return objectDetail(db, sourceId);
}

export async function removeRelation(db: D1Database, user: PortalUser, relationId: string): Promise<void> {
    const relation = await db
        .prepare("SELECT id, space_id, source_id, target_id, origin FROM knowledge_relations WHERE id = ?")
        .bind(relationId)
        .first<{ id: string; space_id: string; source_id: string; target_id: string; origin: string }>();
    if (!relation) throw notFound();
    await requireSpace(db, user, relation.space_id, "editor");
    if (relation.origin !== "manual")
        throw new HttpError(422, "validation", relation.origin === "content" ? "Remove the link from the text instead" : "Clear the property instead");
    await db.batch([
        db.prepare("DELETE FROM knowledge_relations WHERE id = ?").bind(relationId),
        knowledgeAudit(db, {
            spaceId: relation.space_id,
            actor: user.email,
            action: "relation.delete",
            entityType: "relation",
            entityId: relationId,
            summary: "Removed a link between two objects",
            changes: { sourceId: relation.source_id, targetId: relation.target_id },
        }),
    ]);
}

// --- Templates on existing objects ---------------------------------------------------------------

const applyTemplateInput = z.object({ templateId: z.string().max(40), version: z.number().int().min(1) });

/**
 * Adds a template to an object that already exists, without overwriting anything: the template's
 * document goes after what's there, and its property values only fill properties that are empty.
 * It's an ordinary versioned edit, so it's refused (409) if someone saved since `version`.
 */
export async function applyTemplateToObject(db: D1Database, user: PortalUser, objectId: string, input: unknown): Promise<KnowledgeObjectDetail> {
    const access = await requireObject(db, user, objectId, "editor");
    const body = applyTemplateInput.parse(input);
    const space = await requireSpace(db, user, access.space_id);
    const start = await templateStart(db, access.space_id, space.time_zone, body.templateId);
    const row = await loadRow(db, objectId);
    const existing = toObject(row);
    const type = await getTypeInSpace(db, row.space_id, row.type_id);
    const notices = [...start.notices];
    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(start.properties)) {
        const def = type.schema.properties.find((d) => d.key === key);
        if (!def) notices.push(`The template's value for “${key}” wasn't used: ${type.name} has no such property.`);
        else if (existing.properties[key] !== undefined) notices.push(`${def.label} already had a value, so it was kept.`);
        else properties[key] = value;
    }
    const current = (existing.content.content ?? []) as unknown[];
    const added = (start.content.content ?? []) as unknown[];
    const detail = await updateObject(db, user, objectId, {
        version: body.version,
        ...(added.length ? { content: { type: "doc", content: [...current, ...added] } } : {}),
        ...(Object.keys(properties).length ? { properties } : {}),
    });
    return notices.length ? { ...detail, notices } : detail;
}
