import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { z } from "zod";
import type { CustomField, Guest, GuestEventStatus, RsvpSource, RsvpStatus } from "../../src/shared/portal/types";
import { auditStatement, chunk, diff, newId, nowIso, parseJson, placeholders } from "./db";
import { NotFoundError, ValidationError, customFieldDef, fields, listEntities } from "./entities";

const guestSchema = z.object({
    firstName: fields.str(80).min(1, "First name is required"),
    lastName: fields.str(80).default(""),
    email: fields.email,
    phone: fields.optStr(40),
    householdId: fields.opt(z.string().max(40)),
    side: z.enum(["partner_one", "partner_two", "shared"]).default("shared"),
    groupName: fields.optStr(80),
    ageGroup: z.enum(["adult", "child", "infant"]).default("adult"),
    isPlusOne: z.boolean().default(false),
    dietary: fields.optStr(500),
    accessibility: fields.optStr(500),
    notes: fields.optStr(4000),
    tags: z.array(fields.str(40).min(1)).max(30).default([]),
    custom: z.record(z.string(), z.union([z.string().max(500), z.number(), z.boolean(), z.null()])).default({}),
    /** Event ids the guest is invited to. */
    events: z.array(z.string().max(40)).max(50).optional(),
});
export type GuestInput = z.input<typeof guestSchema>;

const COLUMNS: Record<string, string> = {
    firstName: "first_name",
    lastName: "last_name",
    email: "email",
    phone: "phone",
    householdId: "household_id",
    side: "side",
    groupName: "group_name",
    ageGroup: "age_group",
    isPlusOne: "is_plus_one",
    dietary: "dietary",
    accessibility: "accessibility",
    notes: "notes",
    tags: "tags",
    custom: "custom",
};

const toColumn = (field: string, value: unknown) => {
    if (field === "tags" || field === "custom") return JSON.stringify(value);
    if (field === "isPlusOne") return value ? 1 : 0;
    return value ?? null;
};

export const deriveRsvp = (events: GuestEventStatus[]): Guest["rsvp"] => {
    if (events.length === 0) return "not_invited";
    if (events.some((e) => e.status === "attending")) return "attending";
    if (events.every((e) => e.status === "declined")) return "declined";
    return "pending";
};

const toGuest = (row: Record<string, unknown>, events: GuestEventStatus[]): Guest => ({
    id: row.id as string,
    householdId: (row.household_id as string | null) ?? null,
    householdName: (row.household_name as string | null) ?? null,
    firstName: row.first_name as string,
    lastName: (row.last_name as string) ?? "",
    email: (row.email as string | null) ?? null,
    phone: (row.phone as string | null) ?? null,
    side: row.side as Guest["side"],
    groupName: (row.group_name as string | null) ?? null,
    ageGroup: row.age_group as Guest["ageGroup"],
    isPlusOne: row.is_plus_one === 1,
    dietary: (row.dietary as string | null) ?? null,
    accessibility: (row.accessibility as string | null) ?? null,
    notes: (row.notes as string | null) ?? null,
    tags: parseJson<string[]>(row.tags, []),
    custom: parseJson<Guest["custom"]>(row.custom, {}),
    events,
    rsvp: deriveRsvp(events),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
});

const SELECT = "SELECT g.*, h.name AS household_name FROM guests g LEFT JOIN households h ON h.id = g.household_id";

type EventRow = { guest_id: string; event_id: string; status: RsvpStatus; source: RsvpSource | null; responded_at: string | null };
const toEventStatus = (row: EventRow): GuestEventStatus => ({ eventId: row.event_id, status: row.status, source: row.source, respondedAt: row.responded_at });

export async function listGuests(db: D1Database): Promise<Guest[]> {
    const [guests, events] = await db.batch([
        db.prepare(`${SELECT} ORDER BY g.last_name COLLATE NOCASE, g.first_name COLLATE NOCASE`),
        db.prepare("SELECT ge.* FROM guest_events ge JOIN events e ON e.id = ge.event_id ORDER BY e.sort_order, e.starts_at"),
    ]);
    const byGuest = new Map<string, GuestEventStatus[]>();
    for (const row of events.results as EventRow[]) {
        const list = byGuest.get(row.guest_id) ?? [];
        list.push(toEventStatus(row));
        byGuest.set(row.guest_id, list);
    }
    return (guests.results as Record<string, unknown>[]).map((row) => toGuest(row, byGuest.get(row.id as string) ?? []));
}

export async function getGuest(db: D1Database, id: string): Promise<Guest | null> {
    const row = await db.prepare(`${SELECT} WHERE g.id = ?`).bind(id).first<Record<string, unknown>>();
    if (!row) return null;
    const events = await db
        .prepare("SELECT ge.* FROM guest_events ge JOIN events e ON e.id = ge.event_id WHERE ge.guest_id = ? ORDER BY e.sort_order, e.starts_at")
        .bind(id)
        .all<EventRow>();
    return toGuest(row, events.results.map(toEventStatus));
}

const guestName = (g: { firstName?: unknown; lastName?: unknown }) => `${g.firstName ?? ""} ${g.lastName ?? ""}`.trim();

/** Validates custom values against the active field definitions; unknown keys are dropped. */
export function cleanCustom(input: Record<string, unknown>, definitions: CustomField[]): Guest["custom"] {
    const out: Guest["custom"] = {};
    for (const field of definitions) {
        if (field.archived || !(field.key in input)) continue;
        const value = input[field.key];
        if (value === null || value === "" || value === undefined) {
            out[field.key] = null;
            continue;
        }
        const fail = (message: string) => {
            throw new ValidationError(`${field.label}: ${message}`, `custom.${field.key}`);
        };
        switch (field.type) {
            case "text":
                if (typeof value !== "string") fail("expected text");
                out[field.key] = (value as string).trim().slice(0, 500);
                break;
            case "number": {
                const n = typeof value === "number" ? value : Number(value);
                if (!Number.isFinite(n)) fail("expected a number");
                out[field.key] = n;
                break;
            }
            case "boolean":
                if (typeof value === "boolean") out[field.key] = value;
                else if (value === "true" || value === "yes") out[field.key] = true;
                else if (value === "false" || value === "no") out[field.key] = false;
                else fail("expected yes or no");
                break;
            case "select":
                if (typeof value !== "string" || !field.options.includes(value)) fail(`choose one of ${field.options.join(", ")}`);
                out[field.key] = value as string;
                break;
            case "date":
                if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail("use YYYY-MM-DD");
                out[field.key] = value as string;
                break;
        }
    }
    return out;
}

async function checkReferences(db: D1Database, householdId: unknown, eventIds: string[] | undefined) {
    if (typeof householdId === "string") {
        const exists = await db.prepare("SELECT 1 FROM households WHERE id = ?").bind(householdId).first();
        if (!exists) throw new ValidationError("That household no longer exists", "householdId");
    }
    if (eventIds?.length) {
        const found = await db
            .prepare(`SELECT COUNT(*) AS n FROM events WHERE id IN (${placeholders(eventIds.length)})`)
            .bind(...eventIds)
            .first<{ n: number }>();
        if ((found?.n ?? 0) !== new Set(eventIds).size) throw new ValidationError("One of the events no longer exists", "events");
    }
}

const invitationStatements = (db: D1Database, guestId: string, current: string[], wanted: string[]): D1PreparedStatement[] => {
    const add = wanted.filter((id) => !current.includes(id));
    const remove = current.filter((id) => !wanted.includes(id));
    return [
        ...add.map((eventId) => db.prepare("INSERT OR IGNORE INTO guest_events (guest_id, event_id, status) VALUES (?, ?, 'pending')").bind(guestId, eventId)),
        ...remove.map((eventId) => db.prepare("DELETE FROM guest_events WHERE guest_id = ? AND event_id = ?").bind(guestId, eventId)),
    ];
};

export async function createGuest(db: D1Database, input: unknown, actor: string): Promise<Guest> {
    const data = guestSchema.parse(input);
    const definitions = await listEntities(db, customFieldDef);
    const custom = cleanCustom(data.custom, definitions);
    await checkReferences(db, data.householdId, data.events);

    const id = newId("gst");
    const now = nowIso();
    const values: Record<string, unknown> = { ...data, custom };
    const columns = ["id", "created_at", "updated_at", ...Object.values(COLUMNS)];
    const bound = [id, now, now, ...Object.keys(COLUMNS).map((field) => toColumn(field, values[field]))];
    await db.batch([
        db.prepare(`INSERT INTO guests (${columns.join(", ")}) VALUES (${placeholders(columns.length)})`).bind(...bound),
        ...invitationStatements(db, id, [], [...new Set(data.events ?? [])]),
        auditStatement(db, { actor, action: "guest.create", entityType: "guest", entityId: id, summary: `Added guest “${guestName(data)}”` }),
    ]);
    return (await getGuest(db, id))!;
}

export async function updateGuest(db: D1Database, id: string, input: unknown, actor: string): Promise<Guest> {
    const before = await getGuest(db, id);
    if (!before) throw new NotFoundError("Guest not found");
    const sent = new Set(input && typeof input === "object" ? Object.keys(input) : []);
    const parsed = guestSchema.partial().parse(input);
    const patch = Object.fromEntries(Object.entries(parsed).filter(([key]) => sent.has(key))) as Partial<z.output<typeof guestSchema>>;

    if (patch.custom) {
        const definitions = await listEntities(db, customFieldDef);
        // Merge so a form that only knows some fields cannot wipe the others.
        patch.custom = { ...before.custom, ...cleanCustom(patch.custom, definitions) };
    }
    await checkReferences(db, patch.householdId, patch.events);

    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [field, column] of Object.entries(COLUMNS)) {
        if (!(field in patch)) continue;
        sets.push(`${column} = ?`);
        values.push(toColumn(field, patch[field as keyof typeof patch]));
    }
    const currentEvents = before.events.map((e) => e.eventId);
    const wantedEvents = patch.events ? [...new Set(patch.events)] : currentEvents;
    const changes = diff(before as unknown as Record<string, unknown>, { ...patch, events: undefined });
    delete changes.events;
    if (patch.events && JSON.stringify([...currentEvents].sort()) !== JSON.stringify([...wantedEvents].sort())) {
        changes.events = [currentEvents, wantedEvents];
    }
    if (Object.keys(changes).length === 0) return before;

    const statements: D1PreparedStatement[] = [];
    if (sets.length) statements.push(db.prepare(`UPDATE guests SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).bind(...values, nowIso(), id));
    else statements.push(db.prepare("UPDATE guests SET updated_at = ? WHERE id = ?").bind(nowIso(), id));
    statements.push(...invitationStatements(db, id, currentEvents, wantedEvents));
    statements.push(
        auditStatement(db, {
            actor,
            action: "guest.update",
            entityType: "guest",
            entityId: id,
            summary: `Updated guest “${guestName({ ...before, ...patch })}”`,
            changes,
        }),
    );
    await db.batch(statements);
    return (await getGuest(db, id))!;
}

export async function deleteGuest(db: D1Database, id: string, actor: string) {
    const before = await getGuest(db, id);
    if (!before) throw new NotFoundError("Guest not found");
    await db.batch([
        db.prepare("DELETE FROM guests WHERE id = ?").bind(id),
        auditStatement(db, {
            actor,
            action: "guest.delete",
            entityType: "guest",
            entityId: id,
            summary: `Deleted guest “${guestName(before)}”`,
            changes: { deleted: before },
        }),
    ]);
}

const rsvpSchema = z.object({
    eventId: z.string().max(40),
    status: z.enum(["pending", "attending", "declined"]),
    source: z.enum(["portal", "sayido"]).default("portal"),
});

/** Records an RSVP entered by hand in the portal (including responses copied from Say I Do). */
export async function setGuestRsvp(db: D1Database, guestId: string, input: unknown, actor: string): Promise<Guest> {
    const { eventId, status, source } = rsvpSchema.parse(input);
    const guest = await getGuest(db, guestId);
    if (!guest) throw new NotFoundError("Guest not found");
    const current = guest.events.find((e) => e.eventId === eventId);
    if (!current) throw new ValidationError("The guest is not invited to that event", "eventId");
    if (current.status === status) return guest;
    const event = await db.prepare("SELECT name FROM events WHERE id = ?").bind(eventId).first<{ name: string }>();
    await db.batch([
        db
            .prepare("UPDATE guest_events SET status = ?, source = ?, responded_at = ? WHERE guest_id = ? AND event_id = ?")
            .bind(status, status === "pending" ? null : source, status === "pending" ? null : nowIso(), guestId, eventId),
        auditStatement(db, {
            actor,
            action: "rsvp.update",
            entityType: "guest",
            entityId: guestId,
            summary: `Set ${guestName(guest)}'s RSVP for ${event?.name ?? "an event"} to ${status}`,
            changes: { [`events.${eventId}`]: [current.status, status], source },
        }),
    ]);
    return (await getGuest(db, guestId))!;
}

// ---------------------------------------------------------------------------------------------
// Bulk actions

export const bulkSchema = z.discriminatedUnion("action", [
    z.object({ action: z.literal("delete"), ids: z.array(z.string()).min(1).max(1000) }),
    z.object({ action: z.literal("invite"), ids: z.array(z.string()).min(1).max(1000), eventId: z.string() }),
    z.object({ action: z.literal("uninvite"), ids: z.array(z.string()).min(1).max(1000), eventId: z.string() }),
    z.object({
        action: z.literal("set-rsvp"),
        ids: z.array(z.string()).min(1).max(1000),
        eventId: z.string(),
        status: z.enum(["pending", "attending", "declined"]),
        source: z.enum(["portal", "sayido"]).default("portal"),
    }),
    z.object({ action: z.literal("set-household"), ids: z.array(z.string()).min(1).max(1000), householdId: z.string().nullable() }),
    z.object({ action: z.literal("set-side"), ids: z.array(z.string()).min(1).max(1000), side: z.enum(["partner_one", "partner_two", "shared"]) }),
    z.object({ action: z.literal("set-group"), ids: z.array(z.string()).min(1).max(1000), groupName: fields.optStr(80) }),
    z.object({ action: z.literal("add-tag"), ids: z.array(z.string()).min(1).max(1000), tag: fields.str(40).min(1) }),
    z.object({ action: z.literal("remove-tag"), ids: z.array(z.string()).min(1).max(1000), tag: fields.str(40).min(1) }),
]);

export async function bulkUpdateGuests(db: D1Database, input: unknown, actor: string): Promise<{ affected: number }> {
    const command = bulkSchema.parse(input);
    const ids = [...new Set(command.ids)];
    const existing = new Set<string>();
    for (const part of chunk(ids)) {
        const rows = await db
            .prepare(`SELECT id FROM guests WHERE id IN (${placeholders(part.length)})`)
            .bind(...part)
            .all<{ id: string }>();
        for (const row of rows.results) existing.add(row.id);
    }
    const targets = ids.filter((id) => existing.has(id));
    if (targets.length === 0) return { affected: 0 };

    let eventName = "";
    if ("eventId" in command) {
        const event = await db.prepare("SELECT name FROM events WHERE id = ?").bind(command.eventId).first<{ name: string }>();
        if (!event) throw new ValidationError("That event no longer exists", "eventId");
        eventName = event.name;
    }
    if (command.action === "set-household" && command.householdId) await checkReferences(db, command.householdId, undefined);

    const now = nowIso();
    const statements: D1PreparedStatement[] = [];
    let summary = "";
    for (const part of chunk(targets)) {
        const inList = `(${placeholders(part.length)})`;
        switch (command.action) {
            case "delete":
                statements.push(db.prepare(`DELETE FROM guests WHERE id IN ${inList}`).bind(...part));
                summary = `Deleted ${targets.length} guests`;
                break;
            case "invite":
                for (const id of part)
                    statements.push(
                        db.prepare("INSERT OR IGNORE INTO guest_events (guest_id, event_id, status) VALUES (?, ?, 'pending')").bind(id, command.eventId),
                    );
                summary = `Invited ${targets.length} guests to ${eventName}`;
                break;
            case "uninvite":
                statements.push(db.prepare(`DELETE FROM guest_events WHERE event_id = ? AND guest_id IN ${inList}`).bind(command.eventId, ...part));
                summary = `Removed ${targets.length} guests from ${eventName}`;
                break;
            case "set-rsvp":
                statements.push(
                    db
                        .prepare(`UPDATE guest_events SET status = ?, source = ?, responded_at = ? WHERE event_id = ? AND guest_id IN ${inList}`)
                        .bind(
                            command.status,
                            command.status === "pending" ? null : command.source,
                            command.status === "pending" ? null : now,
                            command.eventId,
                            ...part,
                        ),
                );
                summary = `Set RSVP for ${eventName} to ${command.status} for ${targets.length} guests`;
                break;
            case "set-household":
                statements.push(db.prepare(`UPDATE guests SET household_id = ?, updated_at = ? WHERE id IN ${inList}`).bind(command.householdId, now, ...part));
                summary = command.householdId ? `Moved ${targets.length} guests to a household` : `Removed ${targets.length} guests from their households`;
                break;
            case "set-side":
                statements.push(db.prepare(`UPDATE guests SET side = ?, updated_at = ? WHERE id IN ${inList}`).bind(command.side, now, ...part));
                summary = `Changed side for ${targets.length} guests`;
                break;
            case "set-group":
                statements.push(
                    db.prepare(`UPDATE guests SET group_name = ?, updated_at = ? WHERE id IN ${inList}`).bind(command.groupName ?? null, now, ...part),
                );
                summary = `Changed group for ${targets.length} guests`;
                break;
            case "add-tag":
                statements.push(
                    db
                        .prepare(
                            `UPDATE guests SET tags = json_insert(tags, '$[#]', ?), updated_at = ?
                             WHERE id IN ${inList} AND NOT EXISTS (SELECT 1 FROM json_each(guests.tags) WHERE value = ?)`,
                        )
                        .bind(command.tag, now, ...part, command.tag),
                );
                summary = `Tagged ${targets.length} guests “${command.tag}”`;
                break;
            case "remove-tag":
                statements.push(
                    db
                        .prepare(
                            `UPDATE guests SET tags = (SELECT COALESCE(json_group_array(value), '[]') FROM json_each(guests.tags) WHERE value != ?), updated_at = ?
                             WHERE id IN ${inList}`,
                        )
                        .bind(command.tag, now, ...part),
                );
                summary = `Removed tag “${command.tag}” from ${targets.length} guests`;
                break;
        }
    }

    // For deletes, keep a snapshot of every removed guest so the audit log can restore them by hand.
    const snapshot = command.action === "delete" ? (await listGuests(db)).filter((g) => existing.has(g.id)) : undefined;
    statements.push(
        auditStatement(db, {
            actor,
            action: `guest.bulk.${command.action}`,
            entityType: "guest",
            summary,
            changes: { ids: targets, ...("eventId" in command ? { eventId: command.eventId } : {}), ...(snapshot ? { deleted: snapshot } : {}) },
        }),
    );
    await db.batch(statements);
    return { affected: targets.length };
}
