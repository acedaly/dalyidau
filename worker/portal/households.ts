// Households as the guest-management dashboard shows them: each with its signed invitation link
// and RSVP progress, plus bulk invitation generation. Generating prepares links and marks the
// households ready; it never sends anything (sending stays in Communications, behind its switch).
import type { D1Database } from "@cloudflare/workers-types";
import { z } from "zod";
import type { HouseholdRow } from "../../src/shared/portal/types";
import type { Env } from "../env";
import { invitationLinksConfigured, invitationUrl } from "../wedding/invitations";
import { type CsvColumn, toCsv } from "./csv";
import { auditStatement, chunk, nowIso, placeholders } from "./db";
import { NotFoundError, ValidationError, householdDef, listEntities } from "./entities";
import { householdResponses } from "./queries";

export async function listHouseholdRows(env: Env): Promise<HouseholdRow[]> {
    const [households, responses] = await Promise.all([listEntities(env.DB, householdDef), householdResponses(env.DB)]);
    return Promise.all(
        households.map(async (household) => ({
            ...household,
            invitationUrl: household.inviteRevokedAt ? null : await invitationUrl(env, household.id, household.inviteVersion),
            response: responses.get(household.id)!,
        })),
    );
}

const generateSchema = z.object({ ids: z.array(z.string().max(40)).min(1).max(1000) });

export interface GenerateResult {
    generated: number;
    skipped: { id: string; name: string; reason: string }[];
}

const bulkIds = z.array(z.string().max(40)).min(1).max(1000);
export const householdBulkSchema = z.discriminatedUnion("action", [
    z.object({ action: z.literal("preview-delete"), ids: bulkIds }),
    z.object({ action: z.literal("delete"), ids: bulkIds, guests: z.enum(["unassign", "delete"]), confirmed: z.literal(true) }),
    z.object({ action: z.literal("restore"), ids: bulkIds, restoreGuests: z.boolean().default(false), confirmed: z.literal(true) }),
    z.object({ action: z.literal("assign-event"), ids: bulkIds, eventId: z.string().max(40), confirmed: z.literal(true) }),
    z.object({ action: z.literal("add-tag"), ids: bulkIds, tag: z.string().trim().min(1).max(40), confirmed: z.literal(true) }),
    z.object({ action: z.literal("remove-tag"), ids: bulkIds, tag: z.string().trim().min(1).max(40), confirmed: z.literal(true) }),
    z.object({
        action: z.literal("contact-preference"),
        ids: bulkIds,
        preference: z.enum(["email", "post", "phone", "none"]),
        confirmed: z.literal(true),
    }),
    z.object({
        action: z.literal("edit"),
        ids: bulkIds,
        patch: z.object({ region: z.string().trim().max(100).nullable().optional(), country: z.string().trim().max(100).nullable().optional() }),
        confirmed: z.literal(true),
    }),
]);

export interface HouseholdBulkPreview {
    households: { id: string; name: string; guests: number }[];
    guestCount: number;
    invitedGuests: number;
    confirmedResponses: number;
}

export async function householdBulkPreview(db: D1Database, idsInput: string[], includeDeleted = false): Promise<HouseholdBulkPreview> {
    const ids = [...new Set(bulkIds.parse(idsInput))];
    const households: HouseholdBulkPreview["households"] = [];
    let invitedGuests = 0;
    let confirmedResponses = 0;
    for (const part of chunk(ids)) {
        const rows = await db
            .prepare(
                `SELECT h.id, h.name, COUNT(DISTINCT g.id) AS guests,
                        COUNT(DISTINCT CASE WHEN ge.guest_id IS NOT NULL THEN g.id END) AS invited,
                        SUM(CASE WHEN ge.status != 'pending' THEN 1 ELSE 0 END) AS responses
                 FROM households h LEFT JOIN guests g ON g.household_id = h.id AND g.deleted_at IS NULL
                 LEFT JOIN guest_events ge ON ge.guest_id = g.id
                 WHERE h.id IN (${placeholders(part.length)}) ${includeDeleted ? "" : "AND h.deleted_at IS NULL"}
                 GROUP BY h.id, h.name`,
            )
            .bind(...part)
            .all<{ id: string; name: string; guests: number; invited: number; responses: number }>();
        for (const row of rows.results) {
            households.push({ id: row.id, name: row.name, guests: Number(row.guests) });
            invitedGuests += Number(row.invited);
            confirmedResponses += Number(row.responses);
        }
    }
    return { households, guestCount: households.reduce((n, h) => n + h.guests, 0), invitedGuests, confirmedResponses };
}

/** Bulk household changes are explicit and audited. Deletion is always soft; RSVP rows are never removed. */
export async function bulkUpdateHouseholds(db: D1Database, input: unknown, actor: string) {
    const command = householdBulkSchema.parse(input);
    if (command.action === "preview-delete") return { preview: await householdBulkPreview(db, command.ids), affected: 0 };
    const ids = [...new Set(command.ids)];
    const preview = await householdBulkPreview(db, ids, command.action === "restore");
    if (!preview.households.length) throw new NotFoundError("No matching households");
    const targets = preview.households.map((h) => h.id);
    const now = nowIso();
    const statements = [];
    let summary = "";
    for (const part of chunk(targets)) {
        const list = `(${placeholders(part.length)})`;
        if (command.action === "delete") {
            if (command.guests === "unassign") {
                statements.push(
                    db.prepare(`UPDATE guests SET household_id = NULL, updated_at = ? WHERE household_id IN ${list} AND deleted_at IS NULL`).bind(now, ...part),
                );
            } else {
                statements.push(
                    db
                        .prepare(`UPDATE guests SET deleted_at = ?, deleted_by = ?, updated_at = ? WHERE household_id IN ${list} AND deleted_at IS NULL`)
                        .bind(now, actor, now, ...part),
                );
            }
            statements.push(
                db
                    .prepare(`UPDATE households SET deleted_at = ?, deleted_by = ?, updated_at = ? WHERE id IN ${list} AND deleted_at IS NULL`)
                    .bind(now, actor, now, ...part),
            );
            summary = `Deleted ${targets.length} households and ${command.guests === "delete" ? "soft-deleted" : "unassigned"} ${preview.guestCount} guests (restorable records; RSVP history kept)`;
        } else if (command.action === "restore") {
            statements.push(db.prepare(`UPDATE households SET deleted_at = NULL, deleted_by = NULL, updated_at = ? WHERE id IN ${list}`).bind(now, ...part));
            if (command.restoreGuests)
                statements.push(
                    db.prepare(`UPDATE guests SET deleted_at = NULL, deleted_by = NULL, updated_at = ? WHERE household_id IN ${list}`).bind(now, ...part),
                );
            summary = `Restored ${targets.length} households${command.restoreGuests ? " and their deleted guests" : ""}`;
        } else if (command.action === "assign-event") {
            const event = await db.prepare("SELECT name FROM events WHERE id = ?").bind(command.eventId).first<{ name: string }>();
            if (!event) throw new ValidationError("That event no longer exists", "eventId");
            statements.push(
                db
                    .prepare(
                        `INSERT OR IGNORE INTO guest_events (guest_id, event_id, status)
                         SELECT id, ?, 'pending' FROM guests WHERE household_id IN ${list} AND deleted_at IS NULL`,
                    )
                    .bind(command.eventId, ...part),
            );
            summary = `Assigned guests in ${targets.length} households to ${event.name}`;
        } else if (command.action === "add-tag") {
            statements.push(
                db
                    .prepare(
                        `UPDATE guests SET tags = json_insert(tags, '$[#]', ?), updated_at = ?
                         WHERE household_id IN ${list} AND deleted_at IS NULL
                           AND NOT EXISTS (SELECT 1 FROM json_each(guests.tags) WHERE value = ?)`,
                    )
                    .bind(command.tag, now, ...part, command.tag),
            );
            summary = `Tagged guests in ${targets.length} households “${command.tag}”`;
        } else if (command.action === "remove-tag") {
            statements.push(
                db
                    .prepare(
                        `UPDATE guests SET tags = (SELECT COALESCE(json_group_array(value), '[]') FROM json_each(guests.tags) WHERE value != ?), updated_at = ?
                         WHERE household_id IN ${list} AND deleted_at IS NULL`,
                    )
                    .bind(command.tag, now, ...part),
            );
            summary = `Removed tag “${command.tag}” from guests in ${targets.length} households`;
        } else if (command.action === "contact-preference") {
            statements.push(
                db
                    .prepare(`UPDATE guests SET contact_preference = ?, updated_at = ? WHERE household_id IN ${list} AND deleted_at IS NULL`)
                    .bind(command.preference, now, ...part),
            );
            summary = `Changed contact preference for guests in ${targets.length} households`;
        } else if (command.action === "edit") {
            const sets: string[] = [];
            const values: unknown[] = [];
            if (command.patch.region !== undefined) (sets.push("region = ?"), values.push(command.patch.region || null));
            if (command.patch.country !== undefined) (sets.push("country = ?"), values.push(command.patch.country || null));
            if (!sets.length) throw new ValidationError("Choose a property to update", "patch");
            statements.push(db.prepare(`UPDATE households SET ${sets.join(", ")}, updated_at = ? WHERE id IN ${list}`).bind(...values, now, ...part));
            summary = `Bulk edited ${targets.length} households`;
        }
    }
    statements.push(
        auditStatement(db, {
            actor,
            action: `household.bulk.${command.action}`,
            entityType: "household",
            summary,
            changes: { ids: targets, guestCount: preview.guestCount, invitedGuests: preview.invitedGuests, confirmedResponses: preview.confirmedResponses },
        }),
    );
    await db.batch(statements);
    return { affected: targets.length, preview };
}

/** Marks invitations ready for the chosen households. Revoked links and empty households are skipped, never re-issued. */
export async function generateInvitations(env: Env, input: unknown, actor: string): Promise<GenerateResult> {
    if (!invitationLinksConfigured(env)) throw new ValidationError("Invitation links aren't set up yet: RSVP_LINK_SECRET is missing", "ids");
    const ids = [...new Set(generateSchema.parse(input).ids)];
    const db: D1Database = env.DB;
    const rows: { id: string; name: string; invite_revoked_at: string | null; guests: number }[] = [];
    for (const part of chunk(ids)) {
        const found = await db
            .prepare(
                `SELECT h.id, h.name, h.invite_revoked_at,
                        (SELECT COUNT(*) FROM guests g WHERE g.household_id = h.id AND g.deleted_at IS NULL
                           AND EXISTS (SELECT 1 FROM guest_events ge WHERE ge.guest_id = g.id)) AS guests
                 FROM households h WHERE h.deleted_at IS NULL AND h.id IN (${placeholders(part.length)})`,
            )
            .bind(...part)
            .all<{ id: string; name: string; invite_revoked_at: string | null; guests: number }>();
        rows.push(...found.results);
    }
    const skipped: GenerateResult["skipped"] = [];
    const ready: string[] = [];
    for (const row of rows) {
        if (row.invite_revoked_at) skipped.push({ id: row.id, name: row.name, reason: "Its link is revoked. Issue a new link first." });
        else if (!row.guests) skipped.push({ id: row.id, name: row.name, reason: "Nobody in it is invited to an event yet." });
        else ready.push(row.id);
    }
    if (ready.length === 0) return { generated: 0, skipped };
    const now = nowIso();
    await db.batch([
        ...chunk(ready).map((part) =>
            db.prepare(`UPDATE households SET invitation_generated_at = ? WHERE id IN (${placeholders(part.length)})`).bind(now, ...part),
        ),
        auditStatement(db, {
            actor,
            action: "household.invitation.generate",
            entityType: "household",
            summary: `Generated invitations for ${ready.length} household${ready.length === 1 ? "" : "s"} (nothing was sent)`,
            changes: { ids: ready, skipped: skipped.map((s) => s.id) },
        }),
    ]);
    return { generated: ready.length, skipped };
}

const STATUS_LABELS = { not_invited: "Not invited to an event", not_started: "No reply yet", partial: "Partly answered", complete: "Complete" };

/** One row per household with its link and progress: a mail-merge source for printed or emailed invitations. */
export async function invitationsCsv(env: Env) {
    const rows = await listHouseholdRows(env);
    const columns: CsvColumn<HouseholdRow>[] = [
        { header: "Household", value: (h) => h.name },
        { header: "Guests", value: (h) => h.response.guestNames.join(", ") },
        { header: "Invitation link", value: (h) => h.invitationUrl ?? (h.inviteRevokedAt ? "Revoked" : "") },
        { header: "RSVP code", value: (h) => h.rsvpCode },
        { header: "Invitation generated", value: (h) => h.invitationGeneratedAt?.slice(0, 10) ?? "" },
        { header: "Response", value: (h) => STATUS_LABELS[h.response.status] },
        { header: "Guests answered", value: (h) => `${h.response.answered} of ${h.response.invited}` },
        { header: "Attending", value: (h) => h.response.attending },
        { header: "Email", value: (h) => h.email },
        { header: "Address line 1", value: (h) => h.addressLine1 },
        { header: "Address line 2", value: (h) => h.addressLine2 },
        { header: "Suburb / town", value: (h) => h.locality },
        { header: "State", value: (h) => h.region },
        { header: "Postcode", value: (h) => h.postcode },
        { header: "Country", value: (h) => h.country },
    ];
    return toCsv(rows, columns);
}
