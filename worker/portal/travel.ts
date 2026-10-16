// Courtesy bus and accommodation answers (rsvp_travel): saved by the native RSVP, or by the couple
// after a phone call, and summarised for booking the Dubbo RSL bus. Private to the Wedding Planner;
// nothing here is ever rendered on the public site.
import type { D1Database } from "@cloudflare/workers-types";
import {
    type BusChoice,
    type RsvpTravel,
    STAY_CHOICES,
    type StayChoice,
    followUpReasons,
    hasTravelAnswer,
    validateTravel,
} from "../../src/shared/portal/travel";
import type { TravelHouseholdRow, TravelOverview } from "../../src/shared/portal/types";
import { auditStatement, nowIso } from "./db";
import { NotFoundError, ValidationError } from "./entities";
import { REDACTED } from "./redact";

interface TravelRow {
    household_id: string;
    bus: BusChoice | null;
    outbound_count: number;
    return_count: number;
    stay: StayChoice | null;
    stay_location: string | null;
    source: "native" | "manual";
    updated_at: string;
}

const fromRow = (row: TravelRow): RsvpTravel => ({
    bus: row.bus,
    outbound: row.outbound_count,
    return: row.return_count,
    stay: row.stay,
    stayLocation: row.stay_location,
});

export const loadTravelStatement = (db: D1Database, householdId: string) => db.prepare("SELECT * FROM rsvp_travel WHERE household_id = ?").bind(householdId);

export const travelFromRow = (row: TravelRow | null): RsvpTravel | null => (row ? fromRow(row) : null);

/** Every household's saved answer, for personalising messages. */
export async function loadAllTravel(db: D1Database): Promise<Map<string, RsvpTravel>> {
    const rows = await db.prepare("SELECT * FROM rsvp_travel").all<TravelRow>();
    return new Map(rows.results.map((row) => [row.household_id, fromRow(row)]));
}

/** Upsert for the same batch as the RSVP (or manual edit) it belongs to. */
export const saveTravelStatement = (db: D1Database, householdId: string, travel: RsvpTravel, source: "native" | "manual", actor: string, now = nowIso()) =>
    db
        .prepare(
            `INSERT INTO rsvp_travel (household_id, bus, outbound_count, return_count, stay, stay_location, source, updated_at, updated_by)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(household_id) DO UPDATE SET
               bus = ?2, outbound_count = ?3, return_count = ?4, stay = ?5, stay_location = ?6, source = ?7, updated_at = ?8, updated_by = ?9`,
        )
        .bind(householdId, travel.bus, travel.outbound, travel.return, travel.stay, travel.stayLocation, source, now, actor);

/** What the audit log keeps: the choices and counts, never the accommodation name (it can be an address). */
export const auditTravel = (travel: RsvpTravel) => ({ ...travel, stayLocation: travel.stayLocation ? REDACTED : null });

/** Guests attending at least one event, per household. */
const attendingStatement = (db: D1Database, householdId?: string) =>
    db
        .prepare(
            `SELECT g.household_id, COUNT(DISTINCT g.id) AS n FROM guests g JOIN guest_events ge ON ge.guest_id = g.id
             WHERE g.deleted_at IS NULL AND g.household_id IS NOT NULL AND ge.status = 'attending' ${householdId ? "AND g.household_id = ?" : ""}
             GROUP BY g.household_id`,
        )
        .bind(...(householdId ? [householdId] : []));

/** The couple records (or corrects) a household's answer by hand, e.g. after a phone call. */
export async function saveTravelManually(db: D1Database, householdId: string, input: unknown, actor: string) {
    const [household, attending, before] = await db.batch<Record<string, unknown>>([
        db.prepare("SELECT id, name FROM households WHERE id = ? AND deleted_at IS NULL").bind(householdId),
        attendingStatement(db, householdId),
        loadTravelStatement(db, householdId),
    ]);
    const found = household.results[0] as { id: string; name: string } | undefined;
    if (!found) throw new NotFoundError("Household not found");
    const coming = Number((attending.results[0] as { n?: number } | undefined)?.n ?? 0);
    if (coming === 0) throw new ValidationError("Nobody in this household is attending yet, so there's no transport to record.", "bus");
    const checked = validateTravel(input, coming);
    if ("error" in checked) throw new ValidationError(checked.error, checked.field);
    const previous = travelFromRow((before.results[0] as unknown as TravelRow) ?? null);
    await db.batch([
        saveTravelStatement(db, householdId, checked.value, "manual", actor),
        auditStatement(db, {
            actor,
            action: "rsvp.travel.update",
            entityType: "household",
            entityId: householdId,
            summary: `Updated transport and accommodation for ${found.name}`,
            changes: { before: previous ? auditTravel(previous) : null, after: auditTravel(checked.value) },
        }),
    ]);
    return checked.value;
}

/** Everything the transport overview and the RSL export need, in one batch of three queries. */
export async function travelOverview(db: D1Database): Promise<TravelOverview> {
    const [households, attending, travel] = await db.batch<Record<string, unknown>>([
        db.prepare(
            `SELECT h.id, h.name, h.email, h.phone,
                    (SELECT g.email FROM guests g WHERE g.household_id = h.id AND g.deleted_at IS NULL AND g.email IS NOT NULL AND g.email != ''
                     ORDER BY g.is_plus_one, g.household_order IS NULL, g.household_order, g.created_at LIMIT 1) AS guest_email,
                    (SELECT g.phone FROM guests g WHERE g.household_id = h.id AND g.deleted_at IS NULL AND g.phone IS NOT NULL AND g.phone != ''
                     ORDER BY g.is_plus_one, g.household_order IS NULL, g.household_order, g.created_at LIMIT 1) AS guest_phone
             FROM households h WHERE h.deleted_at IS NULL ORDER BY h.name COLLATE NOCASE`,
        ),
        attendingStatement(db),
        db.prepare("SELECT * FROM rsvp_travel"),
    ]);
    const coming = new Map((attending.results as { household_id: string; n: number }[]).map((r) => [r.household_id, Number(r.n)]));
    const answers = new Map((travel.results as unknown as TravelRow[]).map((r) => [r.household_id, r]));

    const rows: TravelHouseholdRow[] = [];
    for (const h of households.results as {
        id: string;
        name: string;
        email: string | null;
        phone: string | null;
        guest_email: string | null;
        guest_phone: string | null;
    }[]) {
        const count = coming.get(h.id) ?? 0;
        const stored = answers.get(h.id) ?? null;
        // Only households with someone coming, or with an answer that may now need a follow-up.
        if (count === 0 && !stored) continue;
        const value = travelFromRow(stored);
        rows.push({
            householdId: h.id,
            householdName: h.name,
            attending: count,
            email: h.email || h.guest_email,
            phone: h.phone || h.guest_phone,
            travel: value,
            outbound: value ? Math.min(value.outbound, count) : 0,
            return: value ? Math.min(value.return, count) : 0,
            followUp: value ? followUpReasons(value, count) : [],
            source: stored?.source ?? null,
            updatedAt: stored?.updated_at ?? null,
        });
    }

    const live = rows.filter((r) => r.attending > 0);
    const unsure = live.filter((r) => r.travel?.bus === "unsure");
    return {
        outbound: live.reduce((n, r) => n + r.outbound, 0),
        return: live.reduce((n, r) => n + r.return, 0),
        bothWays: live.filter((r) => r.travel?.bus === "both").reduce((n, r) => n + Math.min(r.outbound, r.return), 0),
        unsure: { households: unsure.length, guests: unsure.reduce((n, r) => n + r.attending, 0) },
        unanswered: live.filter((r) => !hasTravelAnswer(r.travel)).length,
        byStay: [...STAY_CHOICES, null].map((stay) => {
            const matching = live.filter((r) => (r.travel?.stay ?? null) === stay);
            return { stay, households: matching.length, guests: matching.reduce((n, r) => n + r.attending, 0) };
        }),
        households: rows,
    };
}
