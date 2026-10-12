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
import { ValidationError, householdDef, listEntities } from "./entities";
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
