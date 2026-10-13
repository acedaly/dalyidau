import type { D1Database } from "@cloudflare/workers-types";
import type { AuditEntry, HouseholdResponse, RsvpStatus, RsvpSubmission, RsvpSubmissionPayload } from "../../src/shared/portal/types";
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
            `SELECT s.*, h.name AS household_name FROM rsvp_submissions s JOIN households h ON h.id = s.household_id AND h.deleted_at IS NULL
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

/** Every live household's RSVP progress, counted per invited guest and per guest × event. */
export async function householdResponses(db: D1Database): Promise<Map<string, HouseholdResponse>> {
    const [households, guests, invitations] = await db.batch([
        db.prepare("SELECT id FROM households WHERE deleted_at IS NULL"),
        db.prepare(
            `SELECT id, household_id, first_name, last_name FROM guests WHERE deleted_at IS NULL AND household_id IS NOT NULL
             ORDER BY is_plus_one, household_order IS NULL, household_order, age_group, created_at, rowid`,
        ),
        db.prepare(
            `SELECT ge.guest_id, ge.status, ge.responded_at FROM guest_events ge
             JOIN guests g ON g.id = ge.guest_id AND g.deleted_at IS NULL AND g.household_id IS NOT NULL`,
        ),
    ]);
    const byGuest = new Map<string, { status: RsvpStatus; respondedAt: string | null }[]>();
    for (const row of invitations.results as { guest_id: string; status: RsvpStatus; responded_at: string | null }[]) {
        byGuest.set(row.guest_id, [...(byGuest.get(row.guest_id) ?? []), { status: row.status, respondedAt: row.responded_at }]);
    }
    const out = new Map<string, HouseholdResponse>();
    for (const { id } of households.results as { id: string }[]) {
        out.set(id, {
            status: "not_invited",
            invited: 0,
            answered: 0,
            partial: 0,
            attending: 0,
            declined: 0,
            waiting: 0,
            invitations: 0,
            answeredInvitations: 0,
            lastResponseAt: null,
            guestNames: [],
        });
    }
    for (const guest of guests.results as { id: string; household_id: string; first_name: string; last_name: string }[]) {
        const summary = out.get(guest.household_id);
        if (!summary) continue;
        summary.guestNames.push(`${guest.first_name} ${guest.last_name ?? ""}`.trim());
        const events = byGuest.get(guest.id) ?? [];
        if (events.length === 0) continue;
        const answered = events.filter((e) => e.status !== "pending");
        summary.invited++;
        summary.invitations += events.length;
        summary.answeredInvitations += answered.length;
        if (answered.length === events.length) summary.answered++;
        else if (answered.length > 0) summary.partial++;
        else summary.waiting++;
        if (events.some((e) => e.status === "attending")) summary.attending++;
        else if (events.every((e) => e.status === "declined")) summary.declined++;
        for (const e of answered)
            if (e.respondedAt && (!summary.lastResponseAt || e.respondedAt > summary.lastResponseAt)) summary.lastResponseAt = e.respondedAt;
    }
    for (const summary of out.values()) {
        summary.status =
            summary.invitations === 0
                ? "not_invited"
                : summary.answeredInvitations === 0
                  ? "not_started"
                  : summary.answeredInvitations === summary.invitations
                    ? "complete"
                    : "partial";
    }
    return out;
}

/** Households with how many of their invited guests have answered everything. */
export async function householdResponseCounts(db: D1Database) {
    const [rows, responses] = await Promise.all([
        db
            .prepare("SELECT id, name, rsvp_code FROM households WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE")
            .all<{ id: string; name: string; rsvp_code: string }>(),
        householdResponses(db),
    ]);
    return rows.results.map((r) => {
        const response = responses.get(r.id)!;
        return { id: r.id, name: r.name, rsvpCode: r.rsvp_code, guests: response.invited, responded: response.answered, status: response.status };
    });
}

export async function distinctGuestValues(db: D1Database) {
    const [groups, tags] = await db.batch([
        db.prepare(
            "SELECT DISTINCT group_name AS v FROM guests WHERE deleted_at IS NULL AND group_name IS NOT NULL AND group_name != '' ORDER BY v COLLATE NOCASE",
        ),
        db.prepare("SELECT DISTINCT j.value AS v FROM guests, json_each(guests.tags) j WHERE guests.deleted_at IS NULL ORDER BY v COLLATE NOCASE"),
    ]);
    return { groups: (groups.results as { v: string }[]).map((r) => r.v), tags: (tags.results as { v: string }[]).map((r) => r.v) };
}
