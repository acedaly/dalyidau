// Personal lines for each household's thank-you card ({{personal_note}}). Personal content, so the
// audit log records that a note changed, never what it says. Erasing the household removes it.
import type { D1Database } from "@cloudflare/workers-types";
import { z } from "zod";
import { auditStatement, nowIso } from "./db";
import { NotFoundError } from "./entities";
import { REDACTED } from "./redact";

export async function listThankYouNotes(db: D1Database) {
    const rows = await db
        .prepare("SELECT household_id, note, updated_by, updated_at FROM thank_you_notes ORDER BY updated_at DESC")
        .all<{ household_id: string; note: string; updated_by: string; updated_at: string }>();
    return rows.results.map((r) => ({ householdId: r.household_id, note: r.note, updatedBy: r.updated_by, updatedAt: r.updated_at }));
}

const noteSchema = z.object({ note: z.string().trim().max(1000, "Keep the note to 1,000 characters") });

export async function saveThankYouNote(db: D1Database, householdId: string, input: unknown, actor: string) {
    const { note } = noteSchema.parse(input);
    const household = await db.prepare("SELECT name FROM households WHERE id = ? AND deleted_at IS NULL").bind(householdId).first<{ name: string }>();
    if (!household) throw new NotFoundError("Household not found");
    const now = nowIso();
    await db.batch([
        note
            ? db
                  .prepare(
                      `INSERT INTO thank_you_notes (household_id, note, updated_by, updated_at) VALUES (?1, ?2, ?3, ?4)
                       ON CONFLICT(household_id) DO UPDATE SET note = ?2, updated_by = ?3, updated_at = ?4`,
                  )
                  .bind(householdId, note, actor, now)
            : db.prepare("DELETE FROM thank_you_notes WHERE household_id = ?").bind(householdId),
        auditStatement(db, {
            actor,
            action: "household.thank_you_note",
            entityType: "household",
            entityId: householdId,
            summary: `${note ? "Updated" : "Removed"} the thank-you note for “${household.name}”`,
            changes: { note: [REDACTED, note ? REDACTED : null] },
        }),
    ]);
    return { householdId, note: note || null };
}
