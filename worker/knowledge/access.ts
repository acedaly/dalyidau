// Who may see what in Daly Knowledge.
//
// Portal roles decide whether someone may open the Knowledge application at all (the
// "knowledge.use" permission). Inside it, every space, object, type and search result is reached
// only through the caller's own membership row: a space you aren't a member of doesn't exist as far
// as the API is concerned (404, never 403, so ids can't be probed). Being a portal owner grants
// nothing here; each person's personal space is theirs alone.
import type { D1Database } from "@cloudflare/workers-types";
import { type KnowledgeSpace, type SpaceRole, roleAtLeast } from "../../src/shared/knowledge/types";
import type { PortalUser } from "../../src/shared/portal/types";
import { newId, nowIso } from "../portal/db";
import { HttpError } from "../portal/http";
import { knowledgeAudit } from "./audit";
import { seedTypeStatements } from "./default-types";

export interface SpaceRow {
    id: string;
    name: string;
    kind: "personal" | "shared";
    personal_owner: string | null;
    time_zone: string;
    role: SpaceRole;
}

export const toSpace = (row: SpaceRow): KnowledgeSpace => ({ id: row.id, name: row.name, kind: row.kind, timeZone: row.time_zone, role: row.role });

export const notFound = () => new HttpError(404, "not_found", "Not found");

const SPACE_COLUMNS = "s.id, s.name, s.kind, s.personal_owner, s.time_zone, m.role";

/** The caller's spaces: their personal space first, then shared spaces by name. */
export async function listSpaces(db: D1Database, email: string): Promise<KnowledgeSpace[]> {
    const rows = await db
        .prepare(
            `SELECT ${SPACE_COLUMNS} FROM knowledge_spaces s JOIN knowledge_memberships m ON m.space_id = s.id AND m.email = ?
             ORDER BY s.kind = 'personal' DESC, s.name COLLATE NOCASE`,
        )
        .bind(email)
        .all<SpaceRow>();
    return rows.results.map(toSpace);
}

/**
 * Creates the caller's personal space (with the default object types) the first time they open
 * Knowledge. Safe to call concurrently: the unique index on personal_owner lets only one win, and
 * the membership, types and audit entry are only written for the space that was actually created.
 */
export async function ensurePersonalSpace(db: D1Database, user: PortalUser): Promise<void> {
    const existing = await db
        .prepare("SELECT id FROM knowledge_spaces WHERE kind = 'personal' AND personal_owner = ?")
        .bind(user.email)
        .first<{ id: string }>();
    if (existing) return;
    const id = newId("ksp");
    const now = nowIso();
    const ifCreated = "WHERE EXISTS (SELECT 1 FROM knowledge_spaces WHERE id = ?)";
    await db.batch([
        db
            .prepare(
                `INSERT INTO knowledge_spaces (id, name, kind, personal_owner, created_by, created_at, updated_at)
                 VALUES (?, 'My knowledge', 'personal', ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
            )
            .bind(id, user.email, user.email, now, now),
        db
            .prepare(`INSERT INTO knowledge_memberships (space_id, email, role, added_by, created_at, updated_at) SELECT ?, ?, 'owner', ?, ?, ? ${ifCreated}`)
            .bind(id, user.email, user.email, now, now, id),
        ...seedTypeStatements(db, id, user.email, now, ifCreated),
        knowledgeAudit(db, { spaceId: id, actor: user.email, action: "space.create", entityType: "space", entityId: id, summary: "Created a personal space" }, ifCreated, [id]),
    ]);
}

/** Creates a shared space owned by the caller. */
export async function createSharedSpace(db: D1Database, user: PortalUser, name: string): Promise<string> {
    const id = newId("ksp");
    const now = nowIso();
    await db.batch([
        db
            .prepare("INSERT INTO knowledge_spaces (id, name, kind, personal_owner, created_by, created_at, updated_at) VALUES (?, ?, 'shared', NULL, ?, ?, ?)")
            .bind(id, name, user.email, now, now),
        db
            .prepare("INSERT INTO knowledge_memberships (space_id, email, role, added_by, created_at, updated_at) VALUES (?, ?, 'owner', ?, ?, ?)")
            .bind(id, user.email, user.email, now, now),
        ...seedTypeStatements(db, id, user.email, now),
        knowledgeAudit(db, { spaceId: id, actor: user.email, action: "space.create", entityType: "space", entityId: id, summary: "Created a shared space" }),
    ]);
    return id;
}

const refuseRole = (minimum: SpaceRole) =>
    new HttpError(403, "forbidden", minimum === "owner" ? "Only the space's owners can do that" : "You can only read this space");

/** The space, if the caller is a member with at least `minimum`. Non-members get 404. */
export async function requireSpace(db: D1Database, user: PortalUser, spaceId: string, minimum: SpaceRole = "viewer"): Promise<SpaceRow> {
    const row = await db
        .prepare(`SELECT ${SPACE_COLUMNS} FROM knowledge_spaces s JOIN knowledge_memberships m ON m.space_id = s.id AND m.email = ? WHERE s.id = ?`)
        .bind(user.email, spaceId)
        .first<SpaceRow>();
    if (!row) throw notFound();
    if (!roleAtLeast(row.role, minimum)) throw refuseRole(minimum);
    return row;
}

export interface ObjectAccessRow {
    id: string;
    space_id: string;
    type_id: string;
    status: "active" | "archived" | "trashed";
    version: number;
    role: SpaceRole;
}

/** An object the caller may act on, with their role in its space. Non-members get 404. */
export async function requireObject(db: D1Database, user: PortalUser, objectId: string, minimum: SpaceRole = "viewer"): Promise<ObjectAccessRow> {
    const row = await db
        .prepare(
            `SELECT o.id, o.space_id, o.type_id, o.status, o.version, m.role
             FROM knowledge_objects o JOIN knowledge_memberships m ON m.space_id = o.space_id AND m.email = ? WHERE o.id = ?`,
        )
        .bind(user.email, objectId)
        .first<ObjectAccessRow>();
    if (!row) throw notFound();
    if (!roleAtLeast(row.role, minimum)) throw refuseRole(minimum);
    return row;
}

/** The ids of every space the caller belongs to; search and lookups never look outside them. */
export async function memberSpaceIds(db: D1Database, email: string): Promise<string[]> {
    const rows = await db.prepare("SELECT space_id FROM knowledge_memberships WHERE email = ?").bind(email).all<{ space_id: string }>();
    return rows.results.map((r) => r.space_id);
}
