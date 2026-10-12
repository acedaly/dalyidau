// Seating planner. Tables are ordinary audited records; assignments are one row per guest (a guest
// can't be seated twice). The planner works from the meal event chosen in catering settings.
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { z } from "zod";
import type { CateringSettings, RsvpStatus, SeatingGuest, SeatingSnapshot, SeatingState, SeatingTable, WeddingEvent } from "../../src/shared/portal/types";
import { auditStatement, chunk, newId, nowIso, parseJson, placeholders } from "./db";
import { type EntityDef, NotFoundError, ValidationError, eventDef, fields, listEntities } from "./entities";
import { getSettings } from "./settings";

export const seatingTableDef: EntityDef<SeatingTable> = {
    type: "seating_table",
    noun: "table",
    table: "seating_tables",
    idPrefix: "tbl",
    columns: {
        name: { column: "name" },
        shape: { column: "shape" },
        capacity: { column: "capacity", kind: "int" },
        sortOrder: { column: "sort_order", kind: "int" },
        notes: { column: "notes" },
    },
    create: z.object({
        name: fields.str(60).min(1, "Give the table a name"),
        shape: z.enum(["round", "rectangle"]).default("round"),
        capacity: z.number().int().min(1, "At least one seat").max(60, "At most 60 seats").default(10),
        sortOrder: z.number().int().min(0).max(10_000).default(0),
        notes: fields.optStr(500),
    }),
    orderBy: "t.sort_order, t.name COLLATE NOCASE",
    title: (t) => t.name,
    read: "wedding.view",
    write: "wedding.planning.edit",
};

/** The event the meal (and so the seating) is for: the configured one, else "Reception", else the first. */
export function mealEvent(events: WeddingEvent[], settings: CateringSettings): WeddingEvent | null {
    return (
        (settings.eventId && events.find((e) => e.id === settings.eventId)) || events.find((e) => /reception|dinner|meal/i.test(e.name)) || events[0] || null
    );
}

export async function seatingGuests(db: D1Database, eventId: string | null): Promise<SeatingGuest[]> {
    const rows = await db
        .prepare(
            `SELECT g.id, g.first_name, g.last_name, g.household_id, h.name AS household_name, g.age_group, g.dietary, g.allergies,
                    g.meal_category, g.is_plus_one, g.plus_one_of, g.group_name, g.side,
                    ge.status AS status, sa.table_id, sa.position
             FROM guests g
             LEFT JOIN households h ON h.id = g.household_id AND h.deleted_at IS NULL
             LEFT JOIN guest_events ge ON ge.guest_id = g.id AND ge.event_id = ?1
             LEFT JOIN seat_assignments sa ON sa.guest_id = g.id
             WHERE g.deleted_at IS NULL AND (?1 IS NULL OR ge.event_id IS NOT NULL OR sa.table_id IS NOT NULL)
             ORDER BY h.name COLLATE NOCASE, g.is_plus_one, g.age_group, g.first_name COLLATE NOCASE`,
        )
        .bind(eventId)
        .all<Record<string, unknown>>();
    return rows.results.map((r) => ({
        id: r.id as string,
        name: `${r.first_name} ${r.last_name ?? ""}`.trim(),
        firstName: r.first_name as string,
        householdId: (r.household_id as string | null) ?? null,
        householdName: (r.household_name as string | null) ?? null,
        ageGroup: r.age_group as SeatingGuest["ageGroup"],
        dietary: (r.dietary as string | null) ?? null,
        allergies: (r.allergies as string | null) ?? null,
        mealCategory: (r.meal_category as string | null) ?? null,
        isPlusOne: r.is_plus_one === 1,
        plusOneOf: (r.plus_one_of as string | null) ?? null,
        groupName: (r.group_name as string | null) ?? null,
        side: r.side as SeatingGuest["side"],
        // Not invited to the meal event (but seated anyway) shows as not invited.
        status: ((r.status as RsvpStatus | null) ?? "not_invited") as SeatingGuest["status"],
        tableId: (r.table_id as string | null) ?? null,
        position: Number(r.position ?? 0),
    }));
}

export async function listSnapshots(db: D1Database): Promise<SeatingSnapshot[]> {
    const rows = await db
        .prepare("SELECT id, name, created_at, created_by, assignments FROM seating_snapshots ORDER BY created_at DESC LIMIT 50")
        .all<Record<string, string>>();
    return rows.results.map((r) => ({
        id: r.id,
        name: r.name,
        createdAt: r.created_at,
        createdBy: r.created_by,
        seated: parseJson<unknown[]>(r.assignments, []).length,
    }));
}

export async function seatingState(db: D1Database): Promise<SeatingState> {
    const [settings, events] = await Promise.all([getSettings(db, "catering"), listEntities(db, eventDef)]);
    const event = mealEvent(events, settings);
    const [tables, guests, snapshots] = await Promise.all([listEntities(db, seatingTableDef), seatingGuests(db, event?.id ?? null), listSnapshots(db)]);
    return { event: event ? { id: event.id, name: event.name } : null, tables, guests, snapshots, categories: settings.categories };
}

const assignSchema = z.object({
    guestIds: z.array(z.string().max(40)).min(1).max(500),
    /** null moves the guests back to "unassigned". */
    tableId: z.string().max(40).nullable(),
    /** Insert before this position (others shift down); omitted = at the end. */
    position: z.number().int().min(0).max(1000).optional(),
});

/** Seats guests at a table (or unseats them). Moving between tables keeps everything else about the guest. */
export async function assignSeats(db: D1Database, input: unknown, actor: string): Promise<void> {
    const { guestIds, tableId, position } = assignSchema.parse(input);
    const ids = [...new Set(guestIds)];
    let tableName = "";
    if (tableId) {
        const table = await db.prepare("SELECT name FROM seating_tables WHERE id = ?").bind(tableId).first<{ name: string }>();
        if (!table) throw new ValidationError("That table no longer exists", "tableId");
        tableName = table.name;
    }
    const found = new Map<string, string>();
    for (const part of chunk(ids)) {
        const rows = await db
            .prepare(`SELECT id, first_name, last_name FROM guests WHERE deleted_at IS NULL AND id IN (${placeholders(part.length)})`)
            .bind(...part)
            .all<{ id: string; first_name: string; last_name: string }>();
        for (const r of rows.results) found.set(r.id, `${r.first_name} ${r.last_name ?? ""}`.trim());
    }
    const targets = ids.filter((id) => found.has(id));
    if (targets.length === 0) throw new NotFoundError("No such guests");

    const now = nowIso();
    const statements: D1PreparedStatement[] = [];
    if (!tableId) {
        for (const part of chunk(targets))
            statements.push(db.prepare(`DELETE FROM seat_assignments WHERE guest_id IN (${placeholders(part.length)})`).bind(...part));
    } else {
        // Current order at the destination, excluding the guests being moved, then insert them.
        const current = await db
            .prepare("SELECT guest_id FROM seat_assignments WHERE table_id = ? ORDER BY position, assigned_at")
            .bind(tableId)
            .all<{ guest_id: string }>();
        const order = current.results.map((r) => r.guest_id).filter((id) => !targets.includes(id));
        const at = position === undefined ? order.length : Math.min(position, order.length);
        order.splice(at, 0, ...targets);
        order.forEach((guestId, index) => {
            statements.push(
                db
                    .prepare(
                        `INSERT INTO seat_assignments (guest_id, table_id, position, assigned_at, assigned_by) VALUES (?1, ?2, ?3, ?4, ?5)
                         ON CONFLICT(guest_id) DO UPDATE SET table_id = ?2, position = ?3,
                            assigned_at = CASE WHEN seat_assignments.table_id = ?2 THEN seat_assignments.assigned_at ELSE ?4 END,
                            assigned_by = CASE WHEN seat_assignments.table_id = ?2 THEN seat_assignments.assigned_by ELSE ?5 END`,
                    )
                    .bind(guestId, tableId, index, now, actor),
            );
        });
    }
    const names = targets.map((id) => found.get(id)!);
    const who = names.length <= 3 ? names.join(", ") : `${names.slice(0, 2).join(", ")} and ${names.length - 2} others`;
    statements.push(
        auditStatement(db, {
            actor,
            action: tableId ? "seating.assign" : "seating.unassign",
            entityType: "seating",
            entityId: tableId,
            summary: tableId ? `Seated ${who} at ${tableName}` : `Unseated ${who}`,
            changes: { ids: targets, tableId },
        }),
    );
    await db.batch(statements);
}

export async function saveSnapshot(db: D1Database, input: unknown, actor: string): Promise<SeatingSnapshot[]> {
    const { name } = z.object({ name: fields.str(80).min(1, "Give the arrangement a name") }).parse(input);
    const [tables, assignments] = await db.batch([
        db.prepare("SELECT id, name, shape, capacity, sort_order, notes FROM seating_tables"),
        db.prepare("SELECT guest_id, table_id, position FROM seat_assignments"),
    ]);
    const id = newId("snp");
    await db.batch([
        db
            .prepare("INSERT INTO seating_snapshots (id, name, tables, assignments, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)")
            .bind(id, name, JSON.stringify(tables.results), JSON.stringify(assignments.results), nowIso(), actor),
        auditStatement(db, { actor, action: "seating.snapshot", entityType: "seating", entityId: id, summary: `Saved the seating arrangement “${name}”` }),
    ]);
    return listSnapshots(db);
}

/** Replaces the current tables and seats with a saved arrangement. Guests who no longer exist are skipped. */
export async function restoreSnapshot(db: D1Database, id: string, actor: string): Promise<void> {
    const snapshot = await db.prepare("SELECT name, tables, assignments FROM seating_snapshots WHERE id = ?").bind(id).first<Record<string, string>>();
    if (!snapshot) throw new NotFoundError("No such saved arrangement");
    const tables = parseJson<Record<string, unknown>[]>(snapshot.tables, []);
    const assignments = parseJson<{ guest_id: string; table_id: string; position: number }[]>(snapshot.assignments, []);
    const live = new Set((await db.prepare("SELECT id FROM guests WHERE deleted_at IS NULL").all<{ id: string }>()).results.map((r) => r.id));
    const now = nowIso();
    const statements: D1PreparedStatement[] = [db.prepare("DELETE FROM seat_assignments"), db.prepare("DELETE FROM seating_tables")];
    for (const t of tables) {
        statements.push(
            db
                .prepare("INSERT INTO seating_tables (id, name, shape, capacity, sort_order, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
                .bind(t.id, t.name, t.shape, t.capacity, t.sort_order, t.notes ?? null, now, now),
        );
    }
    for (const a of assignments.filter((a) => live.has(a.guest_id))) {
        statements.push(
            db
                .prepare("INSERT INTO seat_assignments (guest_id, table_id, position, assigned_at, assigned_by) VALUES (?, ?, ?, ?, ?)")
                .bind(a.guest_id, a.table_id, a.position, now, actor),
        );
    }
    statements.push(
        auditStatement(db, {
            actor,
            action: "seating.restore",
            entityType: "seating",
            entityId: id,
            summary: `Restored the seating arrangement “${snapshot.name}”`,
        }),
    );
    await db.batch(statements);
}

export async function deleteSnapshot(db: D1Database, id: string, actor: string) {
    const row = await db.prepare("SELECT name FROM seating_snapshots WHERE id = ?").bind(id).first<{ name: string }>();
    if (!row) throw new NotFoundError("No such saved arrangement");
    await db.batch([
        db.prepare("DELETE FROM seating_snapshots WHERE id = ?").bind(id),
        auditStatement(db, {
            actor,
            action: "seating.snapshot.delete",
            entityType: "seating",
            entityId: id,
            summary: `Deleted the saved arrangement “${row.name}”`,
        }),
    ]);
}
