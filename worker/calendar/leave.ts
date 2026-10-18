// Leave records: the person's work pattern, leave types and balances, bookings, adjustments,
// what-if scenarios and who they share their leave dates with. Every query is scoped to the
// caller's own email; there is no route by which anyone sees someone else's balances, and shared
// leave exposes only dates and status, to the people chosen.
//
// Statuses are the person's own record. Nothing here (or in MCP, or in AI) can mark leave approved
// or taken on their behalf except the person in the portal.
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { z } from "zod";
import { leaveContext } from "../../src/shared/calendar/holidays";
import {
    type BalanceBreakdown,
    DEFAULT_LEAVE_SETTINGS,
    DEFAULT_PATTERN,
    type ForecastMode,
    LEAVE_PRESETS,
    type LeaveAccrual,
    type LeaveContext,
    balanceAt,
    bookingHours,
    leaveAccrual,
    leaveSettings,
    workPattern,
} from "../../src/shared/calendar/leave";
import { daysBetween } from "../../src/shared/calendar/time";
import {
    CALENDAR_COLORS,
    type CalendarColor,
    LEAVE_KINDS,
    LEAVE_STATUSES,
    type LeaveBookingInfo,
    type LeaveData,
    type LeaveKind,
    type LeaveStatus,
    type LeaveTypeInfo,
    type SharedLeave,
} from "../../src/shared/calendar/types";
import type { PortalUser } from "../../src/shared/portal/types";
import type { Env } from "../env";
import { newId, nowIso, parseJson } from "../portal/db";
import { ValidationError } from "../portal/entities";
import { HttpError } from "../portal/http";
import { activity, canUseCalendar, todayFor } from "./access";
import { listCustomDates } from "./holidays";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-10-18");
const asColor = (value: string): CalendarColor => ((CALENDAR_COLORS as readonly string[]).includes(value) ? (value as CalendarColor) : "blue");
const notFound = () => new HttpError(404, "not_found", "Not found");

// --- Reading -------------------------------------------------------------------------------------

interface TypeRow {
    id: string;
    kind: LeaveKind;
    name: string;
    color: string;
    paid: number;
    tracks_balance: number;
    balance_hours: number;
    balance_date: string;
    accrual: string;
    deducts_public_holidays: number;
    archived_at: string | null;
    version: number;
}

const toType = (r: TypeRow): LeaveTypeInfo => {
    const accrual = leaveAccrual.safeParse(parseJson(r.accrual, {}));
    return {
        id: r.id,
        kind: r.kind,
        name: r.name,
        color: asColor(r.color),
        paid: !!r.paid,
        tracksBalance: !!r.tracks_balance,
        balanceHours: r.balance_hours,
        balanceDate: r.balance_date,
        accrual: accrual.success ? accrual.data : (LEAVE_PRESETS.other.accrual as LeaveAccrual),
        deductsPublicHolidays: !!r.deducts_public_holidays,
        archived: !!r.archived_at,
        version: r.version,
    };
};

interface BookingRow {
    id: string;
    leave_type_id: string;
    scenario_id: string | null;
    start_date: string;
    end_date: string;
    part: LeaveBookingInfo["part"];
    hours: number | null;
    day_hours: string | null;
    status: LeaveStatus;
    title: string | null;
    note: string | null;
    version: number;
    updated_at: string;
}

const BOOKING_COLUMNS = "id, leave_type_id, scenario_id, start_date, end_date, part, hours, day_hours, status, title, note, version, updated_at";

const toBooking = (r: BookingRow): LeaveBookingInfo => ({
    id: r.id,
    leaveTypeId: r.leave_type_id,
    scenarioId: r.scenario_id,
    startDate: r.start_date,
    endDate: r.end_date,
    part: r.part,
    hours: r.hours,
    dayHours: parseJson<Record<string, number> | null>(r.day_hours, null),
    status: r.status,
    title: r.title,
    note: r.note,
    version: r.version,
    updatedAt: r.updated_at,
});

/** Everything about the caller's leave, plus what others share with them. */
export async function loadLeave(db: D1Database, user: PortalUser): Promise<LeaveData> {
    const [profile, types, bookings, adjustments, scenarios, customDates, sharedWith, sharedWithMe] = await Promise.all([
        db
            .prepare("SELECT pattern, settings, version FROM leave_profiles WHERE email = ?")
            .bind(user.email)
            .first<{ pattern: string; settings: string; version: number }>(),
        db.prepare("SELECT * FROM leave_types WHERE email = ? ORDER BY archived_at IS NOT NULL, position, name").bind(user.email).all<TypeRow>(),
        db.prepare(`SELECT ${BOOKING_COLUMNS} FROM leave_bookings WHERE email = ? ORDER BY start_date LIMIT 2000`).bind(user.email).all<BookingRow>(),
        db.prepare("SELECT id, leave_type_id, date, hours, reason FROM leave_adjustments WHERE email = ? ORDER BY date").bind(user.email).all<{
            id: string;
            leave_type_id: string;
            date: string;
            hours: number;
            reason: string | null;
        }>(),
        db
            .prepare("SELECT id, name, note FROM leave_scenarios WHERE email = ? ORDER BY created_at")
            .bind(user.email)
            .all<{ id: string; name: string; note: string | null }>(),
        listCustomDates(db, user),
        db
            .prepare("SELECT s.viewer_email AS email, u.name FROM leave_shares s LEFT JOIN portal_users u ON u.email = s.viewer_email WHERE s.owner_email = ?")
            .bind(user.email)
            .all<{
                email: string;
                name: string | null;
            }>(),
        sharedLeaveFor(db, user),
    ]);
    const pattern = workPattern.safeParse(parseJson(profile?.pattern ?? null, null));
    const settings = leaveSettings.safeParse(parseJson(profile?.settings ?? null, {}));
    return {
        profile: {
            pattern: pattern.success ? pattern.data : DEFAULT_PATTERN,
            settings: settings.success ? settings.data : DEFAULT_LEAVE_SETTINGS,
            version: profile?.version ?? 0,
            configured: !!profile,
        },
        types: types.results.map(toType),
        bookings: bookings.results.map(toBooking),
        adjustments: adjustments.results.map((a) => ({ id: a.id, leaveTypeId: a.leave_type_id, date: a.date, hours: a.hours, reason: a.reason })),
        scenarios: scenarios.results,
        customDates,
        sharedWith: sharedWith.results,
        sharedWithMe,
    };
}

/** Leave other people have chosen to share with the caller: dates and status only. */
export async function sharedLeaveFor(db: D1Database, user: PortalUser): Promise<SharedLeave[]> {
    const owners = await db
        .prepare(
            `SELECT s.owner_email, u.name, p.pattern FROM leave_shares s LEFT JOIN portal_users u ON u.email = s.owner_email LEFT JOIN leave_profiles p ON p.email = s.owner_email
             WHERE s.viewer_email = ?`,
        )
        .bind(user.email)
        .all<{ owner_email: string; name: string | null; pattern: string | null }>();
    const out: SharedLeave[] = [];
    for (const o of owners.results) {
        const bookings = await db
            .prepare(
                `SELECT id, start_date, end_date, status, part FROM leave_bookings WHERE email = ? AND scenario_id IS NULL AND status IN ('proposed', 'requested', 'approved', 'taken')
                 ORDER BY start_date LIMIT 500`,
            )
            .bind(o.owner_email)
            .all<{ id: string; start_date: string; end_date: string; status: LeaveStatus; part: LeaveBookingInfo["part"] }>();
        const pattern = workPattern.safeParse(parseJson(o.pattern, null));
        out.push({
            owner: { email: o.owner_email, name: o.name },
            pattern: pattern.success ? pattern.data : null,
            bookings: bookings.results.map((b) => ({ id: b.id, startDate: b.start_date, endDate: b.end_date, status: b.status, part: b.part })),
        });
    }
    return out;
}

export const contextFor = (leave: Pick<LeaveData, "profile" | "customDates">): LeaveContext =>
    leaveContext(leave.profile.pattern, leave.profile.settings, leave.customDates);

export interface TypeSummary {
    type: LeaveTypeInfo;
    today: { confirmed: number; planned: number };
    asOf: BalanceBreakdown;
}

/** Each active, balance-tracking type's balance today and at `asOf`. */
export function summarise(leave: LeaveData, today: string, asOf: string, mode: ForecastMode = "planned", scenarioId: string | null = null): TypeSummary[] {
    const ctx = contextFor(leave);
    return leave.types
        .filter((t) => !t.archived)
        .map((type) => {
            const input = { type, bookings: leave.bookings, adjustments: leave.adjustments, types: leave.types };
            return {
                type,
                today: { confirmed: balanceAt(input, ctx, today, "confirmed").closing, planned: balanceAt(input, ctx, today, "planned").closing },
                asOf: balanceAt(input, ctx, asOf, mode, scenarioId),
            };
        });
}

// --- Profile -------------------------------------------------------------------------------------

const profileInput = z.object({ version: z.number().int().min(0), pattern: workPattern, settings: leaveSettings }).strict();

export async function saveProfile(db: D1Database, user: PortalUser, input: unknown) {
    const body = profileInput.parse(input);
    const now = nowIso();
    const [result] = await db.batch([
        body.version === 0
            ? db
                  .prepare("INSERT INTO leave_profiles (email, pattern, settings, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (email) DO NOTHING")
                  .bind(user.email, JSON.stringify(body.pattern), JSON.stringify(body.settings), now)
            : db
                  .prepare("UPDATE leave_profiles SET pattern = ?, settings = ?, version = version + 1, updated_at = ? WHERE email = ? AND version = ?")
                  .bind(JSON.stringify(body.pattern), JSON.stringify(body.settings), now, user.email, body.version),
        activity(db, { actor: user.email, action: "leave.profile.save", entityType: "leave_profile", entityId: null }),
    ]);
    if (!result.meta.changes) throw new HttpError(409, "conflict", "Your work pattern changed in another window. Reload and try again.");
    return loadLeave(db, user);
}

// --- Types ---------------------------------------------------------------------------------------

const typeInput = z
    .object({
        kind: z.enum(LEAVE_KINDS),
        name: z.string().trim().min(1).max(60).optional(),
        color: z.enum(CALENDAR_COLORS).optional(),
        paid: z.boolean().optional(),
        tracksBalance: z.boolean().optional(),
        balanceHours: z.number().min(-10000).max(100000).default(0),
        balanceDate: date,
        accrual: leaveAccrual.optional(),
        deductsPublicHolidays: z.boolean().optional(),
    })
    .strict();

export async function createType(db: D1Database, user: PortalUser, input: unknown) {
    const body = typeInput.parse(input);
    const preset = LEAVE_PRESETS[body.kind];
    const id = newId("lvt");
    const now = nowIso();
    try {
        await db.batch([
            db
                .prepare(
                    `INSERT INTO leave_types (id, email, kind, name, color, paid, tracks_balance, balance_hours, balance_date, accrual, deducts_public_holidays, position, created_at, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT coalesce(max(position), 0) + 1 FROM leave_types WHERE email = ?), ?, ?)`,
                )
                .bind(
                    id,
                    user.email,
                    body.kind,
                    body.name ?? preset.name,
                    body.color ?? preset.color,
                    (body.paid ?? preset.paid) ? 1 : 0,
                    (body.tracksBalance ?? preset.tracksBalance) ? 1 : 0,
                    body.balanceHours,
                    body.balanceDate,
                    JSON.stringify(body.accrual ?? preset.accrual),
                    (body.deductsPublicHolidays ?? preset.deductsPublicHolidays) ? 1 : 0,
                    user.email,
                    now,
                    now,
                ),
            activity(db, { actor: user.email, action: "leave.type.create", entityType: "leave_type", entityId: id }),
        ]);
    } catch (error) {
        if (/UNIQUE/.test((error as Error).message)) throw new ValidationError("You already have a leave type with that name", "name");
        throw error;
    }
    return loadLeave(db, user);
}

// No defaults in a patch: a field left out stays as it is.
const typePatch = z
    .object({
        version: z.number().int().min(1),
        name: z.string().trim().min(1).max(60).optional(),
        color: z.enum(CALENDAR_COLORS).optional(),
        paid: z.boolean().optional(),
        tracksBalance: z.boolean().optional(),
        balanceHours: z.number().min(-10000).max(100000).optional(),
        balanceDate: date.optional(),
        accrual: leaveAccrual.optional(),
        deductsPublicHolidays: z.boolean().optional(),
        archived: z.boolean().optional(),
    })
    .strict();

export async function updateType(db: D1Database, user: PortalUser, id: string, input: unknown) {
    const body = typePatch.parse(input);
    const sets: string[] = [];
    const binds: unknown[] = [];
    const set = (column: string, value: unknown) => (sets.push(`${column} = ?`), binds.push(value));
    if (body.name !== undefined) set("name", body.name);
    if (body.color !== undefined) set("color", body.color);
    if (body.paid !== undefined) set("paid", body.paid ? 1 : 0);
    if (body.tracksBalance !== undefined) set("tracks_balance", body.tracksBalance ? 1 : 0);
    if (body.balanceHours !== undefined) set("balance_hours", body.balanceHours);
    if (body.balanceDate !== undefined) set("balance_date", body.balanceDate);
    if (body.accrual !== undefined) set("accrual", JSON.stringify(body.accrual));
    if (body.deductsPublicHolidays !== undefined) set("deducts_public_holidays", body.deductsPublicHolidays ? 1 : 0);
    if (body.archived !== undefined) set("archived_at", body.archived ? nowIso() : null);
    const [result] = await db.batch([
        db
            .prepare(`UPDATE leave_types SET ${[...sets, "version = version + 1", "updated_at = ?"].join(", ")} WHERE id = ? AND email = ? AND version = ?`)
            .bind(...binds, nowIso(), id, user.email, body.version),
        activity(db, { actor: user.email, action: "leave.type.update", entityType: "leave_type", entityId: id }),
    ]);
    if (!result.meta.changes) {
        const exists = await db.prepare("SELECT 1 FROM leave_types WHERE id = ? AND email = ?").bind(id, user.email).first();
        throw exists ? new HttpError(409, "conflict", "This leave type changed in another window. Reload and try again.") : notFound();
    }
    return loadLeave(db, user);
}

/** Deleting a type deletes its bookings and adjustments too, so it asks for the word first. */
export async function deleteType(db: D1Database, user: PortalUser, id: string) {
    const result = await db.batch([
        db.prepare("DELETE FROM leave_types WHERE id = ? AND email = ?").bind(id, user.email),
        activity(db, { actor: user.email, action: "leave.type.delete", entityType: "leave_type", entityId: id }),
    ]);
    if (!result[0].meta.changes) throw notFound();
    return loadLeave(db, user);
}

// --- Bookings ------------------------------------------------------------------------------------

const bookingShape = {
    leaveTypeId: z.string().regex(/^lvt_[a-z0-9]{14}$/, "Choose a leave type"),
    scenarioId: z
        .string()
        .regex(/^lvs_[a-z0-9]{14}$/)
        .nullish(),
    startDate: date,
    endDate: date,
    part: z.enum(["full", "am", "pm", "hours"]),
    hours: z.number().min(0).max(24).nullish(),
    dayHours: z.record(date, z.number().min(0).max(24)).nullish(),
    status: z.enum(LEAVE_STATUSES),
    title: z.string().trim().max(120).nullish(),
    note: z.string().trim().max(1000).nullish(),
};

export const bookingInput = z
    .object({
        ...bookingShape,
        part: bookingShape.part.default("full"),
        status: bookingShape.status.default("draft"),
        clientId: z
            .string()
            .regex(/^[A-Za-z0-9_-]{8,64}$/)
            .optional(),
    })
    .strict();

type BookingFields = z.output<typeof bookingInput>;

function checkBooking(b: Pick<BookingFields, "startDate" | "endDate" | "part" | "hours" | "dayHours">) {
    if (b.endDate < b.startDate) throw new ValidationError("The leave ends before it starts", "endDate");
    if (daysBetween(b.startDate, b.endDate) > 730) throw new ValidationError("One booking can cover at most two years", "endDate");
    if (b.part !== "full" && b.startDate !== b.endDate) throw new ValidationError("Part days are for single-day bookings", "part");
    if (b.part === "hours" && (b.hours === null || b.hours === undefined)) throw new ValidationError("Say how many hours", "hours");
    if (b.dayHours)
        for (const d of Object.keys(b.dayHours))
            if (d < b.startDate || d > b.endDate) throw new ValidationError("Day hours must be within the booking", "dayHours");
}

async function requireType(db: D1Database, user: PortalUser, id: string) {
    const row = await db.prepare("SELECT id FROM leave_types WHERE id = ? AND email = ?").bind(id, user.email).first();
    if (!row) throw new ValidationError("Choose one of your leave types", "leaveTypeId");
}

async function requireScenario(db: D1Database, user: PortalUser, id: string | null | undefined) {
    if (!id) return;
    const row = await db.prepare("SELECT id FROM leave_scenarios WHERE id = ? AND email = ?").bind(id, user.email).first();
    if (!row) throw new ValidationError("Choose one of your scenarios", "scenarioId");
}

export interface BookingOptions {
    via?: "portal" | "mcp";
    /** MCP may only create and change drafts and proposals: approval and taking leave are the person's own record. */
    allowedStatuses?: readonly LeaveStatus[];
}

export async function createBooking(db: D1Database, user: PortalUser, input: unknown, options: BookingOptions = {}) {
    const body = bookingInput.parse(input);
    if (options.allowedStatuses && !options.allowedStatuses.includes(body.status))
        throw new ValidationError(
            `Leave created here can only be ${options.allowedStatuses.join(" or ")}. The person marks it requested, approved or taken in the portal.`,
            "status",
        );
    if (body.clientId) {
        const earlier = await db
            .prepare(`SELECT ${BOOKING_COLUMNS} FROM leave_bookings WHERE email = ? AND client_id = ?`)
            .bind(user.email, body.clientId)
            .first<BookingRow>();
        if (earlier) return { booking: toBooking(earlier), replayed: true };
    }
    checkBooking(body);
    await requireType(db, user, body.leaveTypeId);
    await requireScenario(db, user, body.scenarioId);
    const id = newId("lvb");
    const now = nowIso();
    await db.batch([
        db
            .prepare(
                `INSERT INTO leave_bookings (id, email, leave_type_id, scenario_id, start_date, end_date, part, hours, day_hours, status, title, note, client_id, created_by, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
                id,
                user.email,
                body.leaveTypeId,
                body.scenarioId ?? null,
                body.startDate,
                body.endDate,
                body.part,
                body.part === "hours" ? (body.hours ?? 0) : null,
                body.dayHours ? JSON.stringify(body.dayHours) : null,
                body.status,
                body.title ?? null,
                body.note ?? null,
                body.clientId ?? null,
                options.via ?? "portal",
                now,
                now,
            ),
        activity(db, { actor: user.email, action: "leave.booking.create", entityType: "leave_booking", entityId: id, via: options.via }),
    ]);
    const row = await db.prepare(`SELECT ${BOOKING_COLUMNS} FROM leave_bookings WHERE id = ?`).bind(id).first<BookingRow>();
    return { booking: toBooking(row!), replayed: false };
}

const bookingPatch = z
    .object({ ...bookingShape, version: z.number().int().min(1) })
    .partial()
    .required({ version: true })
    .strict();

export async function updateBooking(db: D1Database, user: PortalUser, id: string, input: unknown, options: BookingOptions = {}) {
    const body = bookingPatch.parse(input);
    const current = await db.prepare(`SELECT ${BOOKING_COLUMNS} FROM leave_bookings WHERE id = ? AND email = ?`).bind(id, user.email).first<BookingRow>();
    if (!current) throw notFound();
    if (options.allowedStatuses) {
        if (!options.allowedStatuses.includes(current.status))
            throw new HttpError(422, "status", `This leave is ${current.status}. Only the person can change it, in the portal.`);
        if (body.status && !options.allowedStatuses.includes(body.status))
            throw new ValidationError(
                `Leave can only be set to ${options.allowedStatuses.join(" or ")} here. The person marks it requested, approved or taken in the portal.`,
                "status",
            );
    }
    const next = {
        startDate: body.startDate ?? current.start_date,
        endDate: body.endDate ?? current.end_date,
        part: body.part ?? current.part,
        hours: body.hours !== undefined ? body.hours : current.hours,
        dayHours: body.dayHours !== undefined ? body.dayHours : parseJson<Record<string, number> | null>(current.day_hours, null),
    };
    checkBooking(next);
    if (body.leaveTypeId) await requireType(db, user, body.leaveTypeId);
    if (body.scenarioId) await requireScenario(db, user, body.scenarioId);
    const sets: string[] = [];
    const binds: unknown[] = [];
    const set = (column: string, value: unknown) => (sets.push(`${column} = ?`), binds.push(value));
    if (body.leaveTypeId) set("leave_type_id", body.leaveTypeId);
    if (body.scenarioId !== undefined) set("scenario_id", body.scenarioId ?? null);
    set("start_date", next.startDate);
    set("end_date", next.endDate);
    set("part", next.part);
    set("hours", next.part === "hours" ? (next.hours ?? 0) : null);
    set("day_hours", next.dayHours ? JSON.stringify(next.dayHours) : null);
    if (body.status) set("status", body.status);
    if (body.title !== undefined) set("title", body.title ?? null);
    if (body.note !== undefined) set("note", body.note ?? null);
    const [result] = await db.batch([
        db
            .prepare(`UPDATE leave_bookings SET ${[...sets, "version = version + 1", "updated_at = ?"].join(", ")} WHERE id = ? AND email = ? AND version = ?`)
            .bind(...binds, nowIso(), id, user.email, body.version),
        activity(db, {
            actor: user.email,
            action: body.status && body.status !== current.status ? `leave.booking.${body.status}` : "leave.booking.update",
            entityType: "leave_booking",
            entityId: id,
            via: options.via,
        }),
    ]);
    if (!result.meta.changes) throw new HttpError(409, "conflict", "This booking changed in another window. Reload and try again.");
    const row = await db.prepare(`SELECT ${BOOKING_COLUMNS} FROM leave_bookings WHERE id = ?`).bind(id).first<BookingRow>();
    return toBooking(row!);
}

export async function deleteBooking(db: D1Database, user: PortalUser, id: string) {
    const result = await db.batch([
        db.prepare("DELETE FROM leave_bookings WHERE id = ? AND email = ?").bind(id, user.email),
        activity(db, { actor: user.email, action: "leave.booking.delete", entityType: "leave_booking", entityId: id }),
    ]);
    if (!result[0].meta.changes) throw notFound();
}

/** Copies a scenario's bookings into the real plan as proposals (the scenario stays as it was). */
export async function adoptScenario(db: D1Database, user: PortalUser, scenarioId: string) {
    await requireScenario(db, user, scenarioId);
    const now = nowIso();
    const rows = await db
        .prepare(`SELECT ${BOOKING_COLUMNS} FROM leave_bookings WHERE email = ? AND scenario_id = ? AND status <> 'cancelled'`)
        .bind(user.email, scenarioId)
        .all<BookingRow>();
    const statements: D1PreparedStatement[] = rows.results.map((r) =>
        db
            .prepare(
                `INSERT INTO leave_bookings (id, email, leave_type_id, scenario_id, start_date, end_date, part, hours, day_hours, status, title, note, created_at, updated_at)
                 VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?)`,
            )
            .bind(newId("lvb"), user.email, r.leave_type_id, r.start_date, r.end_date, r.part, r.hours, r.day_hours, r.title, r.note, now, now),
    );
    statements.push(activity(db, { actor: user.email, action: "leave.scenario.adopt", entityType: "leave_scenario", entityId: scenarioId }));
    await db.batch(statements);
    return loadLeave(db, user);
}

// --- Adjustments and scenarios -------------------------------------------------------------------

const adjustmentInput = z
    .object({
        leaveTypeId: z.string().regex(/^lvt_[a-z0-9]{14}$/),
        date,
        hours: z
            .number()
            .min(-10000)
            .max(10000)
            .refine((h) => h !== 0, "An adjustment can't be zero"),
        reason: z.string().trim().max(200).nullish(),
    })
    .strict();

export async function addAdjustment(db: D1Database, user: PortalUser, input: unknown) {
    const body = adjustmentInput.parse(input);
    await requireType(db, user, body.leaveTypeId);
    const id = newId("lva");
    await db.batch([
        db
            .prepare("INSERT INTO leave_adjustments (id, leave_type_id, email, date, hours, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
            .bind(id, body.leaveTypeId, user.email, body.date, body.hours, body.reason ?? null, nowIso()),
        activity(db, { actor: user.email, action: "leave.adjustment.create", entityType: "leave_adjustment", entityId: id }),
    ]);
    return loadLeave(db, user);
}

export async function deleteAdjustment(db: D1Database, user: PortalUser, id: string) {
    const result = await db.batch([
        db.prepare("DELETE FROM leave_adjustments WHERE id = ? AND email = ?").bind(id, user.email),
        activity(db, { actor: user.email, action: "leave.adjustment.delete", entityType: "leave_adjustment", entityId: id }),
    ]);
    if (!result[0].meta.changes) throw notFound();
    return loadLeave(db, user);
}

const scenarioInput = z.object({ name: z.string().trim().min(1).max(80), note: z.string().trim().max(500).nullish() }).strict();

export async function createScenario(db: D1Database, user: PortalUser, input: unknown) {
    const body = scenarioInput.parse(input);
    const id = newId("lvs");
    const now = nowIso();
    await db.batch([
        db
            .prepare("INSERT INTO leave_scenarios (id, email, name, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
            .bind(id, user.email, body.name, body.note ?? null, now, now),
        activity(db, { actor: user.email, action: "leave.scenario.create", entityType: "leave_scenario", entityId: id }),
    ]);
    return { id, leave: await loadLeave(db, user) };
}

export async function deleteScenario(db: D1Database, user: PortalUser, id: string) {
    const result = await db.batch([
        db.prepare("DELETE FROM leave_scenarios WHERE id = ? AND email = ?").bind(id, user.email),
        activity(db, { actor: user.email, action: "leave.scenario.delete", entityType: "leave_scenario", entityId: id }),
    ]);
    if (!result[0].meta.changes) throw notFound();
    return loadLeave(db, user);
}

// --- Sharing -------------------------------------------------------------------------------------

const shareInput = z.object({ email: z.string().trim().toLowerCase().email().max(254) }).strict();

/** Lets someone see when the caller is on leave (dates and status, never balances or notes). */
export async function shareLeave(env: Env, db: D1Database, user: PortalUser, input: unknown) {
    const { email } = shareInput.parse(input);
    if (email === user.email) throw new ValidationError("That's you", "email");
    if (!(await canUseCalendar(env, db, email)))
        throw new ValidationError("That person can't open Calendar. Give them access in Portal settings first.", "email");
    await db.batch([
        db
            .prepare("INSERT INTO leave_shares (owner_email, viewer_email, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING")
            .bind(user.email, email, nowIso()),
        activity(db, { actor: user.email, action: "leave.share.add", entityType: "leave_share", entityId: null }),
    ]);
    return loadLeave(db, user);
}

export async function unshareLeave(db: D1Database, user: PortalUser, email: string) {
    await db.batch([
        db.prepare("DELETE FROM leave_shares WHERE owner_email = ? AND viewer_email = ?").bind(user.email, email.trim().toLowerCase()),
        activity(db, { actor: user.email, action: "leave.share.remove", entityType: "leave_share", entityId: null }),
    ]);
    return loadLeave(db, user);
}

/** Starts someone off with annual and personal/carer's leave from a balance they give (used by the setup step). */
export async function quickSetup(db: D1Database, user: PortalUser, input: unknown) {
    const body = z
        .object({
            pattern: workPattern,
            settings: leaveSettings.optional(),
            balanceDate: date,
            annualHours: z.number().min(-10000).max(100000),
            personalHours: z.number().min(-10000).max(100000).nullable(),
        })
        .strict()
        .parse(input);
    const existing = await db.prepare("SELECT version FROM leave_profiles WHERE email = ?").bind(user.email).first<{ version: number }>();
    await saveProfile(db, user, { version: existing?.version ?? 0, pattern: body.pattern, settings: body.settings ?? DEFAULT_LEAVE_SETTINGS });
    const kinds = await db.prepare("SELECT kind FROM leave_types WHERE email = ?").bind(user.email).all<{ kind: string }>();
    const have = new Set(kinds.results.map((k) => k.kind));
    if (!have.has("annual")) await createType(db, user, { kind: "annual", balanceHours: body.annualHours, balanceDate: body.balanceDate });
    if (body.personalHours !== null && !have.has("personal"))
        await createType(db, user, { kind: "personal", balanceHours: body.personalHours, balanceDate: body.balanceDate });
    return loadLeave(db, user);
}

/** Hours a hypothetical booking would take, for the planner's live total. */
export async function quote(db: D1Database, user: PortalUser, input: unknown) {
    const body = z
        .object({
            leaveTypeId: z.string(),
            startDate: date,
            endDate: date,
            part: z.enum(["full", "am", "pm", "hours"]).default("full"),
            hours: z.number().nullish(),
        })
        .parse(input);
    const leave = await loadLeave(db, user);
    const type = leave.types.find((t) => t.id === body.leaveTypeId);
    if (!type) throw notFound();
    return { hours: bookingHours({ ...body, hours: body.hours ?? null, dayHours: null }, type, contextFor(leave)), today: await todayFor(db, user.email) };
}
