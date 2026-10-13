// Deleted records, permanent erasure and retention. See docs/PRIVACY.md.
//
// Deleting a guest or household is reversible: the row is marked deleted and hidden everywhere.
// Erasing is not: the row is removed, and every other place that copied their name or contact
// details (message recipient lists, stored RSVP submissions, audit entries) is scrubbed. Erasure
// and retention are owner-only, need the record's name typed back as confirmation, and are never
// run automatically.
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { z } from "zod";
import { normaliseMobile } from "../../src/shared/portal/sms";
import type { DeletedRecord, RetentionPreview } from "../../src/shared/portal/types";
import { auditStatement, nowIso, parseJson } from "./db";
import { ConflictError, NotFoundError, ValidationError } from "./entities";
import { getSettings } from "./settings";

export const ERASED = "[erased]";

const daysAgo = (days: number, now = Date.now()) => new Date(now - days * 86_400_000).toISOString();

export async function listDeleted(db: D1Database): Promise<DeletedRecord[]> {
    const [guests, households] = await db.batch([
        db.prepare(
            `SELECT g.id, g.first_name, g.last_name, g.deleted_at, g.deleted_by, h.name AS household FROM guests g
             LEFT JOIN households h ON h.id = g.household_id WHERE g.deleted_at IS NOT NULL ORDER BY g.deleted_at DESC`,
        ),
        db.prepare(
            `SELECT h.id, h.name, h.deleted_at, h.deleted_by, (SELECT COUNT(*) FROM guests g WHERE g.household_id = h.id) AS members
             FROM households h WHERE h.deleted_at IS NOT NULL ORDER BY h.deleted_at DESC`,
        ),
    ]);
    return [
        ...(guests.results as Record<string, string | null>[]).map((r) => ({
            type: "guest" as const,
            id: r.id!,
            name: `${r.first_name} ${r.last_name ?? ""}`.trim(),
            detail: r.household ? `Household: ${r.household}` : null,
            deletedAt: r.deleted_at!,
            deletedBy: r.deleted_by,
        })),
        ...(households.results as Record<string, string | number | null>[]).map((r) => ({
            type: "household" as const,
            id: String(r.id),
            name: String(r.name),
            detail: Number(r.members) ? `${r.members} guest records still linked` : null,
            deletedAt: String(r.deleted_at),
            deletedBy: (r.deleted_by as string | null) ?? null,
        })),
    ].sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}

// ---------------------------------------------------------------------------------------------
// Households: soft delete and restore (guests are handled in guests.ts)

export async function deleteHousehold(db: D1Database, id: string, actor: string, guests: "unassign" | "delete" = "unassign") {
    const row = await db.prepare("SELECT name FROM households WHERE id = ? AND deleted_at IS NULL").bind(id).first<{ name: string }>();
    if (!row) throw new NotFoundError("Household not found");
    const now = nowIso();
    await db.batch([
        guests === "delete"
            ? db
                  .prepare("UPDATE guests SET deleted_at = ?, deleted_by = ?, updated_at = ? WHERE household_id = ? AND deleted_at IS NULL")
                  .bind(now, actor, now, id)
            : db.prepare("UPDATE guests SET household_id = NULL, updated_at = ? WHERE household_id = ? AND deleted_at IS NULL").bind(now, id),
        db.prepare("UPDATE households SET deleted_at = ?, deleted_by = ?, updated_at = ? WHERE id = ?").bind(now, actor, now, id),
        auditStatement(db, {
            actor,
            action: "household.delete",
            entityType: "household",
            entityId: id,
            summary: `Deleted household “${row.name}” (${guests === "delete" ? "guests soft-deleted" : "guests preserved as unassigned"}; RSVP history kept)`,
        }),
    ]);
}

export async function restore(db: D1Database, type: "guest" | "household", id: string, actor: string) {
    const table = type === "guest" ? "guests" : "households";
    const row = await db.prepare(`SELECT * FROM ${table} WHERE id = ? AND deleted_at IS NOT NULL`).bind(id).first<Record<string, string>>();
    if (!row) throw new NotFoundError(`No deleted ${type} with that id`);
    const name = type === "guest" ? `${row.first_name} ${row.last_name ?? ""}`.trim() : row.name;
    await db.batch([
        db.prepare(`UPDATE ${table} SET deleted_at = NULL, deleted_by = NULL, updated_at = ? WHERE id = ?`).bind(nowIso(), id),
        auditStatement(db, { actor, action: `${type}.restore`, entityType: type, entityId: id, summary: `Restored ${type} “${name}”` }),
    ]);
}

// ---------------------------------------------------------------------------------------------
// Erasure

export const eraseSchema = z.object({
    type: z.enum(["guest", "household"]),
    id: z.string().max(40),
    /** The record's name, typed back by the owner. */
    confirm: z.string().max(200),
});

const sameName = (a: string, b: string) => a.trim().replace(/\s+/g, " ").toLowerCase() === b.trim().replace(/\s+/g, " ").toLowerCase();

/** JSON-escaped form of a value, so it can be found inside stored JSON text. */
const jsonText = (value: string) => JSON.stringify(value).slice(1, -1);

/**
 * Statements that scrub a person's or household's identifying strings from the audit log. Who did
 * what, and when, is kept; the subject becomes "[erased]". Very short strings are skipped so that
 * erasing "Al" can't mangle unrelated entries.
 */
const scrubAudit = (db: D1Database, id: string, strings: string[]): D1PreparedStatement[] => {
    const statements: D1PreparedStatement[] = [
        // Entries about this record lose their field-level details entirely.
        db.prepare("UPDATE audit_log SET changes = NULL WHERE entity_id = ?").bind(id),
    ];
    for (const value of [...new Set(strings.map((s) => s.trim()).filter((s) => s.length >= 3))]) {
        statements.push(
            db.prepare("UPDATE audit_log SET summary = replace(summary, ?1, ?2) WHERE instr(summary, ?1) > 0").bind(value, ERASED),
            db
                .prepare("UPDATE audit_log SET changes = replace(changes, ?1, ?2) WHERE changes IS NOT NULL AND instr(changes, ?1) > 0")
                .bind(jsonText(value), ERASED),
        );
    }
    return statements;
};

/** Deletes stored provider webhooks that mention any of these addresses or numbers. */
const webhookScrub = (db: D1Database, values: (string | null | undefined)[]) =>
    values.filter((v): v is string => !!v && v.length >= 6).map((v) => db.prepare("DELETE FROM comm_webhook_events WHERE instr(payload, ?) > 0").bind(v));

async function eraseGuestStatements(db: D1Database, id: string): Promise<{ statements: D1PreparedStatement[]; name: string }> {
    const guest = await db
        .prepare("SELECT first_name, last_name, email, phone, household_id FROM guests WHERE id = ?")
        .bind(id)
        .first<{ first_name: string; last_name: string; email: string | null; phone: string | null; household_id: string | null }>();
    if (!guest) throw new NotFoundError("Guest not found");
    const name = `${guest.first_name} ${guest.last_name ?? ""}`.trim();

    const statements: D1PreparedStatement[] = [
        // guest_events cascade with the row.
        db.prepare("DELETE FROM guests WHERE id = ?").bind(id),
        // Message history keeps that a message went to someone, not who.
        db.prepare("UPDATE message_recipients SET name = ?, email = NULL, phone = NULL, error = NULL WHERE guest_id = ?").bind(ERASED, id),
        // Text conversations are personal content: remove them, including replies matched by number.
        db.prepare("DELETE FROM sms_messages WHERE guest_id = ?").bind(id),
        ...(normaliseMobile(guest.phone) ? [db.prepare("DELETE FROM sms_messages WHERE phone = ?").bind(normaliseMobile(guest.phone))] : []),
        // Raw provider webhooks carry addresses and numbers.
        ...webhookScrub(db, [guest.email, normaliseMobile(guest.phone)]),
        // Import reports keep that a row was imported, not who it was.
        db.prepare("UPDATE guest_import_rows SET name = ?, address = NULL, notes = '[]' WHERE guest_id = ?").bind(ERASED, id),
    ];

    // Stored RSVP submissions copy names and dietary notes; drop this guest's part of each.
    if (guest.household_id) {
        const submissions = await db
            .prepare("SELECT id, payload FROM rsvp_submissions WHERE household_id = ?")
            .bind(guest.household_id)
            .all<{ id: string; payload: string }>();
        for (const submission of submissions.results) {
            const payload = parseJson<{ guests?: { guestId: string }[] }>(submission.payload, {});
            if (!payload.guests?.some((g) => g.guestId === id)) continue;
            payload.guests = payload.guests.filter((g) => g.guestId !== id);
            statements.push(db.prepare("UPDATE rsvp_submissions SET payload = ? WHERE id = ?").bind(JSON.stringify(payload), submission.id));
        }
    }

    statements.push(...scrubAudit(db, id, [name, guest.email ?? "", guest.phone ?? ""]));
    return { statements, name };
}

async function eraseHouseholdStatements(db: D1Database, id: string): Promise<{ statements: D1PreparedStatement[]; name: string }> {
    const household = await db.prepare("SELECT name, email, phone, address_line1, rsvp_code, invitation_name FROM households WHERE id = ?").bind(id).first<{
        name: string;
        email: string | null;
        phone: string | null;
        address_line1: string | null;
        rsvp_code: string;
        invitation_name: string | null;
    }>();
    if (!household) throw new NotFoundError("Household not found");
    return {
        name: household.name,
        statements: [
            // Submissions cascade; linked guests are kept but unlinked (ON DELETE SET NULL).
            db.prepare("DELETE FROM households WHERE id = ?").bind(id),
            // RSVP confirmation emails are addressed to the household.
            db.prepare("UPDATE message_recipients SET name = ?, email = NULL, phone = NULL, error = NULL WHERE guest_id = ?").bind(ERASED, id),
            db.prepare("DELETE FROM sms_messages WHERE household_id = ?").bind(id),
            db.prepare("UPDATE guest_import_rows SET household_name = ?, address = NULL, notes = '[]' WHERE household_id = ?").bind(ERASED, id),
            ...webhookScrub(db, [household.email]),
            ...scrubAudit(db, id, [
                household.name,
                household.email ?? "",
                household.phone ?? "",
                household.address_line1 ?? "",
                household.rsvp_code,
                household.invitation_name ?? "",
            ]),
        ],
    };
}

export async function erase(db: D1Database, input: unknown, actor: string) {
    const { type, id, confirm } = eraseSchema.parse(input);
    const table = type === "guest" ? "guests" : "households";
    const state = await db.prepare(`SELECT deleted_at FROM ${table} WHERE id = ?`).bind(id).first<{ deleted_at: string | null }>();
    if (!state) throw new NotFoundError(`${type} not found`);
    // Two steps on purpose: delete (reversible) first, then erase.
    if (!state.deleted_at) throw new ConflictError(`Delete this ${type} first. Only deleted records can be erased.`);

    const { statements, name } = type === "guest" ? await eraseGuestStatements(db, id) : await eraseHouseholdStatements(db, id);
    if (!sameName(confirm, name)) throw new ValidationError(`Type the ${type}'s name exactly to confirm`, "confirm");

    statements.push(
        auditStatement(db, {
            actor,
            action: "privacy.erase",
            entityType: type,
            entityId: id,
            summary: `Permanently erased a ${type} record`,
        }),
    );
    await db.batch(statements);
}

// ---------------------------------------------------------------------------------------------
// Retention

export async function retentionPreview(db: D1Database, now = Date.now()): Promise<RetentionPreview> {
    const settings = await getSettings(db, "privacy");
    const auditCutoff = settings.auditRetentionDays > 0 ? daysAgo(settings.auditRetentionDays, now) : null;
    const deletedCutoff = daysAgo(settings.deletedRetentionDays, now);
    const [audit, guests, households] = await db.batch([
        // Erasure records are kept regardless: they're the proof that data was removed.
        db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE at < ? AND action NOT LIKE 'privacy.%'").bind(auditCutoff ?? ""),
        db.prepare("SELECT COUNT(*) AS n FROM guests WHERE deleted_at IS NOT NULL AND deleted_at < ?").bind(deletedCutoff),
        db.prepare("SELECT COUNT(*) AS n FROM households WHERE deleted_at IS NOT NULL AND deleted_at < ?").bind(deletedCutoff),
    ]);
    const count = (r: { results: unknown[] }) => Number((r.results[0] as { n?: number })?.n ?? 0);
    return {
        settings,
        auditCutoff,
        auditEntries: auditCutoff ? count(audit) : 0,
        deletedCutoff,
        deletedRecords: count(guests) + count(households),
    };
}

export const RETENTION_CONFIRMATION = "APPLY RETENTION";

/** Removes audit entries and erases deleted records past their retention period. Manual, owner-only. */
export async function applyRetention(db: D1Database, input: unknown, actor: string, now = Date.now()) {
    const { confirm } = z.object({ confirm: z.string() }).parse(input);
    if (confirm !== RETENTION_CONFIRMATION) throw new ValidationError(`Type ${RETENTION_CONFIRMATION} to confirm`, "confirm");
    const preview = await retentionPreview(db, now);

    const expired = await db.batch([
        db.prepare("SELECT id FROM guests WHERE deleted_at IS NOT NULL AND deleted_at < ?").bind(preview.deletedCutoff),
        db.prepare("SELECT id FROM households WHERE deleted_at IS NOT NULL AND deleted_at < ?").bind(preview.deletedCutoff),
    ]);
    let erased = 0;
    for (const row of expired[0].results as { id: string }[]) {
        const { statements } = await eraseGuestStatements(db, row.id);
        statements.push(
            auditStatement(db, {
                actor,
                action: "privacy.erase",
                entityType: "guest",
                entityId: row.id,
                summary: "Permanently erased a guest record (retention)",
            }),
        );
        await db.batch(statements);
        erased++;
    }
    for (const row of expired[1].results as { id: string }[]) {
        const { statements } = await eraseHouseholdStatements(db, row.id);
        statements.push(
            auditStatement(db, {
                actor,
                action: "privacy.erase",
                entityType: "household",
                entityId: row.id,
                summary: "Permanently erased a household record (retention)",
            }),
        );
        await db.batch(statements);
        erased++;
    }

    let removed = 0;
    if (preview.auditCutoff) {
        const result = await db.prepare("DELETE FROM audit_log WHERE at < ? AND action NOT LIKE 'privacy.%'").bind(preview.auditCutoff).run();
        removed = result.meta.changes ?? 0;
    }
    await auditStatement(db, {
        actor,
        action: "privacy.retention",
        entityType: "settings",
        entityId: "privacy",
        summary: `Applied retention: ${removed} audit entries removed, ${erased} deleted records erased`,
        changes: { auditCutoff: preview.auditCutoff, deletedCutoff: preview.deletedCutoff, removed, erased },
    }).run();
    return { removed, erased };
}
