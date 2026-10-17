// Spaces and who belongs to them. Personal spaces have exactly one member, their owner, and can't
// be shared. Shared spaces are managed by their owners and always keep at least one owner.
import type { D1Database } from "@cloudflare/workers-types";
import { z } from "zod";
import { type KnowledgeMember, SPACE_ROLES } from "../../src/shared/knowledge/types";
import { isRole, permissionsFor } from "../../src/shared/portal/permissions";
import type { PortalUser } from "../../src/shared/portal/types";
import type { Env } from "../env";
import { ownerEmails } from "../portal/auth";
import { isGuardFailure, nowIso, requireChange } from "../portal/db";
import { HttpError } from "../portal/http";
import { notFound, requireSpace } from "./access";
import { knowledgeAudit } from "./audit";

const isTimeZone = (value: string) => {
    try {
        new Intl.DateTimeFormat("en-AU", { timeZone: value });
        return true;
    } catch {
        return false;
    }
};

const spacePatch = z.object({
    name: z.string().trim().min(1, "Give the space a name").max(80).optional(),
    timeZone: z.string().max(60).refine(isTimeZone, "Choose a time zone").optional(),
});

export async function updateSpace(db: D1Database, user: PortalUser, spaceId: string, input: unknown) {
    const space = await requireSpace(db, user, spaceId, "owner");
    const body = spacePatch.parse(input);
    await db.batch([
        db
            .prepare("UPDATE knowledge_spaces SET name = ?, time_zone = ?, updated_at = ? WHERE id = ?")
            .bind(body.name ?? space.name, body.timeZone ?? space.time_zone, nowIso(), spaceId),
        knowledgeAudit(db, {
            spaceId,
            actor: user.email,
            action: "space.update",
            entityType: "space",
            entityId: spaceId,
            summary: "Changed the space's settings",
            changes: { fields: Object.keys(body) },
        }),
    ]);
}

export async function listMembers(db: D1Database, user: PortalUser, spaceId: string): Promise<KnowledgeMember[]> {
    await requireSpace(db, user, spaceId);
    const rows = await db
        .prepare(
            `SELECT m.email, u.name, m.role, m.added_by, m.created_at FROM knowledge_memberships m LEFT JOIN portal_users u ON u.email = m.email
             WHERE m.space_id = ? ORDER BY m.role = 'owner' DESC, m.email`,
        )
        .bind(spaceId)
        .all<{ email: string; name: string | null; role: KnowledgeMember["role"]; added_by: string; created_at: string }>();
    return rows.results.map((r) => ({ email: r.email, name: r.name, role: r.role, addedBy: r.added_by, createdAt: r.created_at }));
}

/** Only people who can already open Knowledge in the portal can be added to a space. */
async function canUseKnowledge(env: Env, db: D1Database, email: string) {
    if (ownerEmails(env).has(email)) return true;
    const row = await db.prepare("SELECT role, active FROM portal_users WHERE email = ?").bind(email).first<{ role: string; active: number }>();
    return !!row?.active && isRole(row.role) && permissionsFor(row.role).includes("knowledge.use");
}

const memberInput = z.object({
    email: z.string().trim().toLowerCase().max(254).pipe(z.email("Enter an email address")),
    role: z.enum(SPACE_ROLES),
});

const sharedSpace = async (db: D1Database, user: PortalUser, spaceId: string) => {
    const space = await requireSpace(db, user, spaceId, "owner");
    if (space.kind === "personal") throw new HttpError(422, "validation", "Personal spaces can't be shared. Create a shared space instead.");
    return space;
};

export async function addMember(env: Env, db: D1Database, user: PortalUser, spaceId: string, input: unknown) {
    await sharedSpace(db, user, spaceId);
    const body = memberInput.parse(input);
    if (!(await canUseKnowledge(env, db, body.email)))
        throw new HttpError(422, "validation", "Add them to the portal as an owner or admin first (Portal settings → People and roles)");
    const now = nowIso();
    const [result] = await db.batch([
        db
            .prepare("INSERT OR IGNORE INTO knowledge_memberships (space_id, email, role, added_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
            .bind(spaceId, body.email, body.role, user.email, now, now),
        knowledgeAudit(
            db,
            { spaceId, actor: user.email, action: "member.add", entityType: "member", entityId: body.email, summary: `Added a member as ${body.role}` },
            "WHERE changes() > 0",
        ),
    ]);
    if (!result.meta.changes) throw new HttpError(409, "conflict", "They're already a member");
}

/** Removing or demoting the last owner would leave a space nobody can manage. */
const keepsAnOwner = (db: D1Database, spaceId: string) =>
    db
        .prepare("INSERT INTO batch_guard (ok) SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM knowledge_memberships WHERE space_id = ? AND role = 'owner')")
        .bind(spaceId);

export async function updateMember(db: D1Database, user: PortalUser, spaceId: string, email: string, input: unknown) {
    await sharedSpace(db, user, spaceId);
    const { role } = z.object({ role: z.enum(SPACE_ROLES) }).parse(input);
    try {
        await db.batch([
            db.prepare("UPDATE knowledge_memberships SET role = ?, updated_at = ? WHERE space_id = ? AND email = ?").bind(role, nowIso(), spaceId, email),
            requireChange(db),
            keepsAnOwner(db, spaceId),
            knowledgeAudit(db, {
                spaceId,
                actor: user.email,
                action: "member.role",
                entityType: "member",
                entityId: email,
                summary: `Changed a member's role to ${role}`,
            }),
        ]);
    } catch (error) {
        if (isGuardFailure(error)) {
            const exists = await db.prepare("SELECT 1 FROM knowledge_memberships WHERE space_id = ? AND email = ?").bind(spaceId, email).first();
            if (!exists) throw notFound();
            throw new HttpError(422, "validation", "A space needs at least one owner");
        }
        throw error;
    }
}

export async function removeMember(db: D1Database, user: PortalUser, spaceId: string, email: string) {
    await sharedSpace(db, user, spaceId);
    try {
        await db.batch([
            db.prepare("DELETE FROM knowledge_memberships WHERE space_id = ? AND email = ?").bind(spaceId, email),
            requireChange(db),
            keepsAnOwner(db, spaceId),
            // Their own shortcuts in this space go with their access.
            db.prepare("DELETE FROM knowledge_favourites WHERE space_id = ? AND email = ?").bind(spaceId, email),
            db.prepare("DELETE FROM knowledge_saved_views WHERE space_id = ? AND owner_email = ?").bind(spaceId, email),
            knowledgeAudit(db, { spaceId, actor: user.email, action: "member.remove", entityType: "member", entityId: email, summary: "Removed a member" }),
        ]);
    } catch (error) {
        if (isGuardFailure(error)) {
            const exists = await db.prepare("SELECT 1 FROM knowledge_memberships WHERE space_id = ? AND email = ?").bind(spaceId, email).first();
            if (!exists) throw notFound();
            throw new HttpError(422, "validation", "A space needs at least one owner");
        }
        throw error;
    }
}
