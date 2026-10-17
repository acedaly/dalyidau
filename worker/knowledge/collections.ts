// Organising without copying: collections (named groups of objects, ordered by hand), pins (objects
// kept at the top of a space's home or of a collection) and favourites (one person's own shortcuts).
//
// None of these change the objects themselves, and all of them stay inside one space: an object
// can only join a collection, be pinned or be favourited in the space it belongs to (checked here
// and enforced by composite foreign keys). Lists only show objects that aren't in the trash, and
// favourites are always read through the person's current membership, so a stale row never reveals
// an object after they lose access.
import type { D1Database } from "@cloudflare/workers-types";
import { z } from "zod";
import type { CollectionItem, KnowledgeCollection, ObjectRef } from "../../src/shared/knowledge/types";
import type { PortalUser } from "../../src/shared/portal/types";
import { isGuardFailure, newId, nowIso, placeholders, requireChange } from "../portal/db";
import { HttpError } from "../portal/http";
import { notFound, requireObject, requireSpace } from "./access";
import { knowledgeAudit } from "./audit";
import { SUMMARY_COLUMNS, type SummaryRow, toSummary } from "./rows";

const OBJECT_ID = /^kob_[a-z0-9]{14}$/;
export const MAX_COLLECTIONS = 500;
const MAX_ADD = 200;

interface CollectionRow {
    id: string;
    space_id: string;
    name: string;
    description: string;
    archived_at: string | null;
    version: number;
    updated_at: string;
    item_count: number;
}

const COLLECTION_COLUMNS = `c.id, c.space_id, c.name, c.description, c.archived_at, c.version, c.updated_at,
    (SELECT COUNT(*) FROM knowledge_collection_items i JOIN knowledge_objects o ON o.id = i.object_id WHERE i.collection_id = c.id AND o.status <> 'trashed') AS item_count`;

const toCollection = (r: CollectionRow): KnowledgeCollection => ({
    id: r.id,
    spaceId: r.space_id,
    name: r.name,
    description: r.description,
    archived: !!r.archived_at,
    version: r.version,
    itemCount: r.item_count,
    updatedAt: r.updated_at,
});

export async function listCollections(db: D1Database, spaceId: string, { archived = false } = {}): Promise<KnowledgeCollection[]> {
    const rows = await db
        .prepare(
            `SELECT ${COLLECTION_COLUMNS} FROM knowledge_collections c WHERE c.space_id = ? AND (c.archived_at IS NULL OR ?)
             ORDER BY c.archived_at IS NOT NULL, c.sort_order, c.name COLLATE NOCASE LIMIT ${MAX_COLLECTIONS}`,
        )
        .bind(spaceId, archived ? 1 : 0)
        .all<CollectionRow>();
    return rows.results.map(toCollection);
}

/** A collection the caller can act on, with its space. Non-members get 404. */
export async function requireCollection(db: D1Database, user: PortalUser, collectionId: string, minimum: "viewer" | "editor" = "viewer") {
    const row = await db.prepare(`SELECT ${COLLECTION_COLUMNS} FROM knowledge_collections c WHERE c.id = ?`).bind(collectionId).first<CollectionRow>();
    if (!row) throw notFound();
    const space = await requireSpace(db, user, row.space_id, minimum);
    return { collection: toCollection(row), space };
}

const collectionInput = z.object({
    name: z.string().trim().min(1, "Give the collection a name").max(80),
    description: z.string().trim().max(500).default(""),
});

export async function createCollection(db: D1Database, user: PortalUser, spaceId: string, input: unknown): Promise<KnowledgeCollection> {
    await requireSpace(db, user, spaceId, "editor");
    const body = collectionInput.parse(input);
    const count = await db.prepare("SELECT COUNT(*) AS n FROM knowledge_collections WHERE space_id = ?").bind(spaceId).first<{ n: number }>();
    if ((count?.n ?? 0) >= MAX_COLLECTIONS) throw new HttpError(422, "validation", `A space can have up to ${MAX_COLLECTIONS} collections`);
    const id = newId("kcl");
    const now = nowIso();
    await db.batch([
        db
            .prepare(
                `INSERT INTO knowledge_collections (id, space_id, name, description, sort_order, created_by, updated_by, created_at, updated_at)
                 VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM knowledge_collections WHERE space_id = ?), ?, ?, ?, ?)`,
            )
            .bind(id, spaceId, body.name, body.description, spaceId, user.email, user.email, now, now),
        knowledgeAudit(db, { spaceId, actor: user.email, action: "collection.create", entityType: "collection", entityId: id, summary: "Created a collection" }),
    ]);
    return (await requireCollection(db, user, id)).collection;
}

const collectionPatch = collectionInput.partial().extend({ version: z.number().int().min(1), archived: z.boolean().optional() }).strict();

export async function updateCollection(db: D1Database, user: PortalUser, collectionId: string, input: unknown): Promise<KnowledgeCollection> {
    const { collection } = await requireCollection(db, user, collectionId, "editor");
    const body = collectionPatch.parse(input);
    const stale = () => new HttpError(409, "conflict", "Someone else changed this collection. Reload to see their changes.");
    if (body.version !== collection.version) throw stale();
    const now = nowIso();
    try {
        await db.batch([
            db
                .prepare(
                    `UPDATE knowledge_collections SET name = ?, description = ?, archived_at = CASE WHEN ? THEN COALESCE(archived_at, ?) ELSE NULL END,
                        updated_by = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?`,
                )
                .bind(
                    body.name ?? collection.name,
                    body.description ?? collection.description,
                    (body.archived ?? collection.archived) ? 1 : 0,
                    now,
                    user.email,
                    now,
                    collectionId,
                    body.version,
                ),
            requireChange(db),
            knowledgeAudit(db, {
                spaceId: collection.spaceId,
                actor: user.email,
                action: body.archived === true ? "collection.archive" : body.archived === false ? "collection.unarchive" : "collection.update",
                entityType: "collection",
                entityId: collectionId,
                summary: "Changed a collection",
                changes: { fields: Object.keys(body).filter((k) => k !== "version") },
            }),
        ]);
    } catch (error) {
        if (isGuardFailure(error)) throw stale();
        throw error;
    }
    return (await requireCollection(db, user, collectionId)).collection;
}

/** Deletes the collection and its membership rows. The objects in it are untouched. */
export async function deleteCollection(db: D1Database, user: PortalUser, collectionId: string): Promise<void> {
    const { collection } = await requireCollection(db, user, collectionId, "editor");
    await db.batch([
        db.prepare("DELETE FROM knowledge_collections WHERE id = ?").bind(collectionId),
        knowledgeAudit(db, {
            spaceId: collection.spaceId,
            actor: user.email,
            action: "collection.delete",
            entityType: "collection",
            entityId: collectionId,
            summary: "Deleted a collection (its objects were kept)",
        }),
    ]);
}

// --- Items ---------------------------------------------------------------------------------------

/** A collection's objects (not in the trash), pinned first, then in their order. */
export async function collectionItems(
    db: D1Database,
    collectionId: string,
    page: { limit: number; offset: number } = { limit: 200, offset: 0 },
): Promise<{ items: CollectionItem[]; total: number }> {
    const [rows, count] = await db.batch([
        db
            .prepare(
                `SELECT ${SUMMARY_COLUMNS}, i.position, i.pinned_at FROM knowledge_collection_items i JOIN knowledge_objects o ON o.id = i.object_id
                 WHERE i.collection_id = ? AND o.status <> 'trashed' ORDER BY i.pinned_at IS NULL, i.position LIMIT ? OFFSET ?`,
            )
            .bind(collectionId, Math.min(page.limit, 200), page.offset),
        db
            .prepare(
                "SELECT COUNT(*) AS n FROM knowledge_collection_items i JOIN knowledge_objects o ON o.id = i.object_id WHERE i.collection_id = ? AND o.status <> 'trashed'",
            )
            .bind(collectionId),
    ]);
    return {
        items: (rows.results as (SummaryRow & { position: number; pinned_at: string | null })[]).map((r) => ({
            ...toSummary(r),
            position: r.position,
            pinned: !!r.pinned_at,
        })),
        total: (count.results[0] as { n: number }).n,
    };
}

const addInput = z.object({ objectIds: z.array(z.string().regex(OBJECT_ID)).min(1).max(MAX_ADD) });

/**
 * Adds objects to the end of a collection. Only live objects in the collection's own space can be
 * added (anything else is skipped, as if it didn't exist); objects already in it stay where they are.
 */
export async function addToCollection(db: D1Database, user: PortalUser, collectionId: string, input: unknown): Promise<{ added: number }> {
    const { collection } = await requireCollection(db, user, collectionId, "editor");
    const ids = [...new Set(addInput.parse(input).objectIds)];
    const now = nowIso();
    const results = await db.batch([
        ...ids.map((objectId) =>
            db
                .prepare(
                    `INSERT OR IGNORE INTO knowledge_collection_items (space_id, collection_id, object_id, position, added_by, added_at)
                     SELECT ?, ?, o.id, (SELECT COALESCE(MAX(position), 0) + 1 FROM knowledge_collection_items WHERE collection_id = ?), ?, ?
                     FROM knowledge_objects o WHERE o.id = ? AND o.space_id = ? AND o.status <> 'trashed'`,
                )
                .bind(collection.spaceId, collectionId, collectionId, user.email, now, objectId, collection.spaceId),
        ),
        knowledgeAudit(db, {
            spaceId: collection.spaceId,
            actor: user.email,
            action: "collection.add",
            entityType: "collection",
            entityId: collectionId,
            summary: "Added objects to a collection",
            changes: { ids },
        }),
    ]);
    const added = results.slice(0, ids.length).reduce((n, r) => n + (r.meta.changes ?? 0), 0);
    if (!added && ids.length === 1) {
        const inside = await db.prepare("SELECT 1 FROM knowledge_collection_items WHERE collection_id = ? AND object_id = ?").bind(collectionId, ids[0]).first();
        if (!inside) throw new HttpError(422, "validation", "Choose an object from this space");
    }
    return { added };
}

export async function removeFromCollection(db: D1Database, user: PortalUser, collectionId: string, objectId: string): Promise<void> {
    const { collection } = await requireCollection(db, user, collectionId, "editor");
    const [result] = await db.batch([
        db.prepare("DELETE FROM knowledge_collection_items WHERE collection_id = ? AND object_id = ?").bind(collectionId, objectId),
        knowledgeAudit(
            db,
            {
                spaceId: collection.spaceId,
                actor: user.email,
                action: "collection.remove",
                entityType: "collection",
                entityId: collectionId,
                summary: "Removed an object from a collection (the object was kept)",
                changes: { objectId },
            },
            "WHERE changes() > 0",
        ),
    ]);
    if (!result.meta.changes) throw notFound();
}

const moveInput = z.object({
    objectId: z.string().regex(OBJECT_ID),
    /** Put it straight after this item; null puts it first. */
    afterId: z.string().regex(OBJECT_ID).nullable(),
});

/**
 * Moves one item. Positions are fractional, so a move rewrites one row: the midpoint between its new
 * neighbours. When repeated moves squeeze two positions too close together, the collection is
 * renumbered first (rare, and still one batch).
 */
export async function moveInCollection(db: D1Database, user: PortalUser, collectionId: string, input: unknown): Promise<void> {
    const { collection } = await requireCollection(db, user, collectionId, "editor");
    const body = moveInput.parse(input);
    if (body.afterId === body.objectId) return;
    const position = async (objectId: string) =>
        (
            await db
                .prepare("SELECT position FROM knowledge_collection_items WHERE collection_id = ? AND object_id = ?")
                .bind(collectionId, objectId)
                .first<{ position: number }>()
        )?.position;
    if ((await position(body.objectId)) === undefined) throw notFound();
    const neighbours = async () => {
        const after = body.afterId ? await position(body.afterId) : undefined;
        if (body.afterId && after === undefined) throw new HttpError(422, "validation", "That item isn't in this collection");
        const next = await db
            .prepare(
                `SELECT position FROM knowledge_collection_items WHERE collection_id = ? AND object_id <> ? ${after === undefined ? "" : "AND position > ?"}
                 ORDER BY position LIMIT 1`,
            )
            .bind(collectionId, body.objectId, ...(after === undefined ? [] : [after]))
            .first<{ position: number }>();
        return after === undefined ? { low: (next?.position ?? 0) - 2, high: next?.position ?? 0 } : { low: after, high: next?.position ?? after + 2 };
    };
    let { low, high } = await neighbours();
    if (high - low < 1e-6) {
        await db
            .prepare(
                `UPDATE knowledge_collection_items SET position = (SELECT n FROM (SELECT object_id, ROW_NUMBER() OVER (ORDER BY position) AS n
                    FROM knowledge_collection_items WHERE collection_id = ?1) r WHERE r.object_id = knowledge_collection_items.object_id) WHERE collection_id = ?1`,
            )
            .bind(collectionId)
            .run();
        ({ low, high } = await neighbours());
    }
    await db.batch([
        db
            .prepare("UPDATE knowledge_collection_items SET position = ? WHERE collection_id = ? AND object_id = ?")
            .bind((low + high) / 2, collectionId, body.objectId),
        knowledgeAudit(db, {
            spaceId: collection.spaceId,
            actor: user.email,
            action: "collection.reorder",
            entityType: "collection",
            entityId: collectionId,
            summary: "Reordered a collection",
            changes: { objectId: body.objectId },
        }),
    ]);
}

export async function pinInCollection(db: D1Database, user: PortalUser, collectionId: string, objectId: string, pinned: boolean): Promise<void> {
    const { collection } = await requireCollection(db, user, collectionId, "editor");
    const [result] = await db.batch([
        db
            .prepare("UPDATE knowledge_collection_items SET pinned_at = ? WHERE collection_id = ? AND object_id = ?")
            .bind(pinned ? nowIso() : null, collectionId, objectId),
        knowledgeAudit(
            db,
            {
                spaceId: collection.spaceId,
                actor: user.email,
                action: pinned ? "collection.pin" : "collection.unpin",
                entityType: "collection",
                entityId: collectionId,
                summary: pinned ? "Pinned an object in a collection" : "Unpinned an object in a collection",
                changes: { objectId },
            },
            "WHERE changes() > 0",
        ),
    ]);
    if (!result.meta.changes) throw notFound();
}

/** The collections an object is in, for its page. */
export async function objectCollections(db: D1Database, objectId: string, spaceId: string): Promise<{ id: string; name: string }[]> {
    const rows = await db
        .prepare(
            `SELECT c.id, c.name FROM knowledge_collection_items i JOIN knowledge_collections c ON c.id = i.collection_id
             WHERE i.object_id = ? AND c.space_id = ? AND c.archived_at IS NULL ORDER BY c.name COLLATE NOCASE`,
        )
        .bind(objectId, spaceId)
        .all<{ id: string; name: string }>();
    return rows.results;
}

// --- Pins on the space's home ---------------------------------------------------------------------

const REF_COLUMNS = "o.id, o.space_id, o.title, o.type_id, o.status, o.daily_date, o.updated_at";
type RefRow = { id: string; space_id: string; title: string; type_id: string; status: ObjectRef["status"]; daily_date: string | null; updated_at: string };
const toRef = (r: RefRow): ObjectRef => ({
    id: r.id,
    spaceId: r.space_id,
    title: r.title,
    typeId: r.type_id,
    status: r.status,
    dailyDate: r.daily_date,
    updatedAt: r.updated_at,
});

export const MAX_PINS = 24;

export async function listPins(db: D1Database, spaceId: string): Promise<ObjectRef[]> {
    const rows = await db
        .prepare(
            `SELECT ${REF_COLUMNS} FROM knowledge_pins p JOIN knowledge_objects o ON o.id = p.object_id
             WHERE p.space_id = ? AND o.status <> 'trashed' ORDER BY p.position LIMIT ${MAX_PINS}`,
        )
        .bind(spaceId)
        .all<RefRow>();
    return rows.results.map(toRef);
}

/** Pins or unpins an object on its space's home. Editors only: everyone in the space sees pins. */
export async function setPinned(db: D1Database, user: PortalUser, objectId: string, pinned: boolean): Promise<void> {
    const access = await requireObject(db, user, objectId, "editor");
    if (pinned && access.status === "trashed") throw new HttpError(409, "conflict", "This object is in the trash");
    if (pinned) {
        const count = await db
            .prepare("SELECT COUNT(*) AS n, COALESCE(MAX(object_id = ?), 0) AS already FROM knowledge_pins WHERE space_id = ?")
            .bind(objectId, access.space_id)
            .first<{ n: number; already: number }>();
        if (!(count?.already ?? 0) && (count?.n ?? 0) >= MAX_PINS)
            throw new HttpError(422, "validation", `Up to ${MAX_PINS} objects can be pinned. Unpin one first.`);
    }
    await db.batch([
        pinned
            ? db
                  .prepare(
                      `INSERT OR IGNORE INTO knowledge_pins (space_id, object_id, position, pinned_by, pinned_at)
                       VALUES (?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM knowledge_pins WHERE space_id = ?), ?, ?)`,
                  )
                  .bind(access.space_id, objectId, access.space_id, user.email, nowIso())
            : db.prepare("DELETE FROM knowledge_pins WHERE space_id = ? AND object_id = ?").bind(access.space_id, objectId),
        knowledgeAudit(
            db,
            {
                spaceId: access.space_id,
                actor: user.email,
                action: pinned ? "object.pin" : "object.unpin",
                entityType: "object",
                entityId: objectId,
                summary: pinned ? "Pinned an object" : "Unpinned an object",
            },
            "WHERE changes() > 0",
        ),
    ]);
}

// --- Favourites ----------------------------------------------------------------------------------

export const MAX_FAVOURITES = 200;

/**
 * The caller's favourites that aren't in the trash, in one space or across all their spaces. Joined
 * to their membership now, not when they were favourited.
 */
export async function listFavourites(db: D1Database, email: string, spaceId?: string, limit = MAX_FAVOURITES): Promise<ObjectRef[]> {
    const rows = await db
        .prepare(
            `SELECT ${REF_COLUMNS} FROM knowledge_favourites f
             JOIN knowledge_memberships m ON m.space_id = f.space_id AND m.email = f.email
             JOIN knowledge_objects o ON o.id = f.object_id AND o.space_id = f.space_id
             WHERE f.email = ? ${spaceId ? "AND f.space_id = ?" : ""} AND o.status <> 'trashed' ORDER BY f.position LIMIT ?`,
        )
        .bind(...(spaceId ? [email, spaceId] : [email]), limit)
        .all<RefRow>();
    return rows.results.map(toRef);
}

/** Favourites or unfavourites an object for the caller only. Any member, viewers included. */
export async function setFavourite(db: D1Database, user: PortalUser, objectId: string, favourite: boolean): Promise<void> {
    const access = await requireObject(db, user, objectId);
    if (favourite) {
        const count = await db
            .prepare("SELECT COUNT(*) AS n, COALESCE(MAX(object_id = ?), 0) AS already FROM knowledge_favourites WHERE email = ?")
            .bind(objectId, user.email)
            .first<{ n: number; already: number }>();
        if (!(count?.already ?? 0) && (count?.n ?? 0) >= MAX_FAVOURITES)
            throw new HttpError(422, "validation", `You can have up to ${MAX_FAVOURITES} favourites`);
    }
    await db.batch([
        favourite
            ? db
                  .prepare(
                      `INSERT OR IGNORE INTO knowledge_favourites (email, space_id, object_id, position, created_at)
                       VALUES (?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM knowledge_favourites WHERE email = ?), ?)`,
                  )
                  .bind(user.email, access.space_id, objectId, user.email, nowIso())
            : db.prepare("DELETE FROM knowledge_favourites WHERE email = ? AND object_id = ?").bind(user.email, objectId),
        knowledgeAudit(
            db,
            {
                spaceId: access.space_id,
                actor: user.email,
                action: favourite ? "object.favourite" : "object.unfavourite",
                entityType: "object",
                entityId: objectId,
                summary: favourite ? "Added an object to their favourites" : "Removed an object from their favourites",
            },
            "WHERE changes() > 0",
        ),
    ]);
}

/** Whether the caller has favourited each object, and which are pinned, for an object page. */
export async function navigationState(db: D1Database, email: string, objectId: string, spaceId: string) {
    const [favourite, pinned] = await db.batch([
        db.prepare("SELECT 1 AS yes FROM knowledge_favourites WHERE email = ? AND object_id = ?").bind(email, objectId),
        db.prepare("SELECT 1 AS yes FROM knowledge_pins WHERE space_id = ? AND object_id = ?").bind(spaceId, objectId),
    ]);
    return { favourite: favourite.results.length > 0, pinned: pinned.results.length > 0 };
}

/** Which of these ids the caller has favourited (for search results and lists). */
export async function favouriteIds(db: D1Database, email: string, ids: string[]): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const rows = await db
        .prepare(`SELECT object_id FROM knowledge_favourites WHERE email = ? AND object_id IN (${placeholders(ids.length)})`)
        .bind(email, ...ids)
        .all<{ object_id: string }>();
    return new Set(rows.results.map((r) => r.object_id));
}
