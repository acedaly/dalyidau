// Mobile number review: finds guest and household numbers saved before numbers were standardised,
// shows what each would become in E.164, and applies only the changes someone ticks and confirms.
//
// Nothing changes on preview. Clear-cut numbers (0412 345 678 → +61412345678) are offered ticked;
// ones read with an assumption (nine digits, a lost leading 0) are offered unticked; numbers that
// can't be read are listed for fixing by hand and can never be applied. An apply only writes a row
// that still holds the exact value that was previewed, so a later edit is never overwritten.
import type { D1Database } from "@cloudflare/workers-types";
import { z } from "zod";
import { isE164Mobile, parseMobile } from "../../src/shared/portal/phone";
import { MOBILE_REVIEW_BATCH, type MobileReview, type MobileReviewRow } from "../../src/shared/portal/types";
import { auditIfChanged, nowIso } from "./db";
import { ValidationError } from "./entities";
import { redactChanges } from "./redact";

const TABLES = { guest: "guests", household: "households" } as const;

const classify = (row: Omit<MobileReviewRow, "status" | "proposed" | "reason">): MobileReviewRow => {
    const result = parseMobile(row.stored);
    if (!result.ok) return { ...row, status: "invalid", proposed: null, reason: result.message };
    if (result.assumed)
        return {
            ...row,
            status: "check",
            proposed: result.e164,
            reason: "Nine digits starting with 4. Probably an Australian mobile that lost its leading 0.",
        };
    return { ...row, status: "update", proposed: result.e164, reason: null };
};

export async function mobileReview(db: D1Database): Promise<MobileReview> {
    const [guests, households] = await db.batch([
        db.prepare(
            `SELECT g.id, TRIM(g.first_name || ' ' || g.last_name) AS name, g.phone, h.name AS household
             FROM guests g LEFT JOIN households h ON h.id = g.household_id
             WHERE g.deleted_at IS NULL AND g.phone IS NOT NULL AND g.phone != ''
             ORDER BY g.last_name COLLATE NOCASE, g.first_name COLLATE NOCASE`,
        ),
        db.prepare("SELECT id, name, phone FROM households WHERE deleted_at IS NULL AND phone IS NOT NULL AND phone != '' ORDER BY name COLLATE NOCASE"),
    ]);
    type Row = { id: string; name: string; phone: string; household?: string | null };
    const all = [
        ...(guests.results as Row[]).map((r) => ({ kind: "guest" as const, id: r.id, name: r.name, household: r.household ?? null, stored: r.phone })),
        ...(households.results as Row[]).map((r) => ({ kind: "household" as const, id: r.id, name: r.name, household: null, stored: r.phone })),
    ];
    const rows = all.filter((r) => !isE164Mobile(r.stored)).map(classify);
    return {
        rows,
        counts: {
            standard: all.length - rows.length,
            update: rows.filter((r) => r.status === "update").length,
            check: rows.filter((r) => r.status === "check").length,
            invalid: rows.filter((r) => r.status === "invalid").length,
        },
    };
}

const applySchema = z.object({
    changes: z
        .array(z.object({ kind: z.enum(["guest", "household"]), id: z.string().max(40), from: z.string().max(200), to: z.string().max(20) }))
        .min(1, "Choose at least one number")
        .max(MOBILE_REVIEW_BATCH),
    confirmed: z.literal(true),
});

export async function applyMobileReview(db: D1Database, input: unknown, actor: string) {
    const { changes } = applySchema.parse(input);
    const seen = new Set<string>();
    const statements = changes.flatMap((change) => {
        const key = `${change.kind}:${change.id}`;
        if (seen.has(key)) throw new ValidationError("Each number can only be changed once", "changes");
        seen.add(key);
        // The server decides the new value: it must be exactly what the stored value normalises to.
        const result = parseMobile(change.from);
        if (!result.ok || result.e164 !== change.to) throw new ValidationError("A number can only be changed to its standard form", "changes");
        return [
            db
                .prepare(`UPDATE ${TABLES[change.kind]} SET phone = ?, updated_at = ? WHERE id = ? AND phone = ? AND deleted_at IS NULL`)
                .bind(change.to, nowIso(), change.id, change.from),
            // Recorded on the record's own history, in the same batch, only if the update applied.
            // Like every audit entry, it notes that the number changed but not the number itself.
            auditIfChanged(db, {
                actor,
                action: `${change.kind}.update`,
                entityType: change.kind,
                entityId: change.id,
                summary: "Standardised the mobile number to international format (mobile number review)",
                changes: redactChanges({ phone: [change.from, change.to] }),
            }),
        ];
    });
    const results = await db.batch(statements);
    const updated = changes.filter((_, i) => (results[i * 2]?.meta.changes ?? 0) > 0).length;
    return { updated, skipped: changes.length - updated };
}
