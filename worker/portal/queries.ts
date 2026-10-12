import type { D1Database } from "@cloudflare/workers-types";
import type { AuditEntry, RsvpSubmission, RsvpSubmissionPayload } from "../../src/shared/portal/types";
import { likePattern, parseJson } from "./db";

const AUDIT_PAGE_SIZE = 50;

export async function listAudit(db: D1Database, url: URL) {
    const q = (url.searchParams.get("q") ?? "").trim().slice(0, 100);
    const entity = (url.searchParams.get("entity") ?? "").trim().slice(0, 40) || null;
    const entityId = (url.searchParams.get("entityId") ?? "").trim().slice(0, 40) || null;
    const requested = Number.parseInt(url.searchParams.get("page") ?? "1", 10);
    const where: string[] = [];
    const binds: unknown[] = [];
    if (q) {
        where.push("(summary LIKE ? ESCAPE '\\' OR actor LIKE ? ESCAPE '\\' OR action LIKE ? ESCAPE '\\')");
        binds.push(likePattern(q), likePattern(q), likePattern(q));
    }
    if (entity) {
        where.push("entity_type = ?");
        binds.push(entity);
    }
    if (entityId) {
        // Bulk actions record their targets in changes.ids rather than entity_id.
        where.push("(entity_id = ? OR EXISTS (SELECT 1 FROM json_each(audit_log.changes, '$.ids') WHERE value = ?))");
        binds.push(entityId, entityId);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const count = await db
        .prepare(`SELECT COUNT(*) AS n FROM audit_log ${clause}`)
        .bind(...binds)
        .first<{ n: number }>();
    const totalPages = Math.max(1, Math.ceil((count?.n ?? 0) / AUDIT_PAGE_SIZE));
    const page = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), totalPages) : 1;
    const rows = await db
        .prepare(`SELECT * FROM audit_log ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`)
        .bind(...binds, AUDIT_PAGE_SIZE, (page - 1) * AUDIT_PAGE_SIZE)
        .all<Record<string, unknown>>();
    const entries: AuditEntry[] = rows.results.map((r) => ({
        id: r.id as number,
        at: r.at as string,
        actor: r.actor as string,
        action: r.action as string,
        entityType: r.entity_type as string,
        entityId: (r.entity_id as string | null) ?? null,
        summary: r.summary as string,
        changes: parseJson(r.changes, null),
    }));
    return { entries, page, totalPages, filters: { q, entity } };
}

export async function listSubmissions(db: D1Database, limit = 100): Promise<RsvpSubmission[]> {
    const rows = await db
        .prepare(
            `SELECT s.*, h.name AS household_name FROM rsvp_submissions s JOIN households h ON h.id = s.household_id
             ORDER BY s.submitted_at DESC LIMIT ?`,
        )
        .bind(limit)
        .all<Record<string, unknown>>();
    return rows.results.map((r) => ({
        id: r.id as string,
        householdId: r.household_id as string,
        householdName: r.household_name as string,
        submittedAt: r.submitted_at as string,
        message: (r.message as string | null) ?? null,
        payload: parseJson<RsvpSubmissionPayload>(r.payload, { guests: [] }),
    }));
}

/** Households with how many of their invited guests have answered everything. */
export async function householdResponseCounts(db: D1Database) {
    const rows = await db
        .prepare(
            `SELECT h.id, h.name, h.rsvp_code,
                    COUNT(DISTINCT g.id) AS guests,
                    COUNT(DISTINCT CASE WHEN NOT EXISTS (
                        SELECT 1 FROM guest_events ge WHERE ge.guest_id = g.id AND ge.status = 'pending'
                    ) AND EXISTS (SELECT 1 FROM guest_events ge WHERE ge.guest_id = g.id) THEN g.id END) AS responded
             FROM households h LEFT JOIN guests g ON g.household_id = h.id
             GROUP BY h.id ORDER BY h.name COLLATE NOCASE`,
        )
        .all<{ id: string; name: string; rsvp_code: string; guests: number; responded: number }>();
    return rows.results.map((r) => ({ id: r.id, name: r.name, rsvpCode: r.rsvp_code, guests: r.guests, responded: r.responded }));
}

export async function distinctGuestValues(db: D1Database) {
    const [groups, tags] = await db.batch([
        db.prepare("SELECT DISTINCT group_name AS v FROM guests WHERE group_name IS NOT NULL AND group_name != '' ORDER BY v COLLATE NOCASE"),
        db.prepare("SELECT DISTINCT j.value AS v FROM guests, json_each(guests.tags) j ORDER BY v COLLATE NOCASE"),
    ]);
    return { groups: (groups.results as { v: string }[]).map((r) => r.v), tags: (tags.results as { v: string }[]).map((r) => r.v) };
}
