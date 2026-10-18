// The leave engine: work patterns, what a booking costs, accrual and balance forecasts.
//
// Everything is worked out in hours from the person's own work pattern, day by day, from the balance
// they entered (as at its effective date) forward. It's deterministic and has no knowledge of any
// employer's system: a forecast is an estimate from the person's own settings, a booking is only
// "approved" when the person says so, and nothing here is ever produced by a model.
//
// Rules, in the order they apply on each day after the balance date:
//   1. Accrual (if any) for that day: per ordinary hour worked (the pattern's hours, including paid
//      leave and public holidays, not unpaid leave or configured non-working days), or a fixed
//      amount per period. Accrual stops at the cap, if there is one.
//   2. Adjustments dated that day.
//   3. Leave taken that day, for bookings the chosen mode counts.
//   4. A yearly reset, if configured: the balance is cut to the carry-over limit at the end of that day.
// Bookings (or the parts of them) on or before the balance date are assumed to be in the balance already.
import { z } from "zod";
import { addDays, daysBetween, eachDate, isoWeekday } from "./time";
import type { LeaveBookingInfo, LeaveStatus, LeaveTypeInfo } from "./types";

// --- Work patterns -------------------------------------------------------------------------------

const hours = z.number().min(0).max(24);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-10-18");

export const workPattern = z.discriminatedUnion("kind", [
    /** Monday to Sunday. */
    z.object({ kind: z.literal("weekly"), hours: z.array(hours).length(7) }).strict(),
    /** Two weeks, Monday of week 1 to Sunday of week 2, from a Monday that started a "week 1" (rostered days off, 9-day fortnights). */
    z
        .object({ kind: z.literal("fortnightly"), hours: z.array(hours).length(14), anchor: isoDate })
        .strict()
        .refine((p) => isoWeekday(p.anchor) === 1, { message: "Week 1 must start on a Monday", path: ["anchor"] }),
]);
export type WorkPattern = z.output<typeof workPattern>;

/** 38 hours a week, Monday to Friday: the National Employment Standards' full-time week. */
export const DEFAULT_PATTERN: WorkPattern = { kind: "weekly", hours: [7.6, 7.6, 7.6, 7.6, 7.6, 0, 0] };

export function patternHours(pattern: WorkPattern, date: string): number {
    if (pattern.kind === "weekly") return pattern.hours[isoWeekday(date) - 1];
    const offset = (((daysBetween(pattern.anchor, date) % 14) + 14) % 14) as number;
    return pattern.hours[offset];
}

/** Average ordinary hours per week. */
export const weeklyHours = (pattern: WorkPattern) => {
    const total = pattern.hours.reduce((sum, h) => sum + h, 0);
    return round(pattern.kind === "weekly" ? total : total / 2);
};

// --- Settings and accrual ------------------------------------------------------------------------

export const leaveSettings = z
    .object({
        /** Count the NSW Bank Holiday as a public holiday (people who work in banks and some financial institutions). */
        includeBankHoliday: z.boolean().default(false),
        /** Which regional public holidays (custom dates with this region) apply. */
        region: z.string().trim().max(80).nullable().default(null),
        /** What the balance forecast counts by default. */
        forecastMode: z.enum(["confirmed", "planned"]).default("planned"),
        /** Employer or label, shown in exports. */
        employer: z.string().trim().max(80).nullable().default(null),
    })
    .strict();
export type LeaveSettings = z.output<typeof leaveSettings>;
export const DEFAULT_LEAVE_SETTINGS: LeaveSettings = leaveSettings.parse({});

export const leaveAccrual = z
    .object({
        method: z.enum(["none", "per_hour", "per_period"]),
        /** per_hour: hours accrued for each ordinary hour worked (4 weeks a year is 4/52 ≈ 0.0769). */
        rate: z.number().min(0).max(1).nullable().default(null),
        /** per_period: hours added every `everyDays` days from `anchor` (e.g. flex or a fixed monthly credit). */
        hours: z.number().min(0).max(1000).nullable().default(null),
        everyDays: z.number().int().min(1).max(366).nullable().default(null),
        anchor: isoDate.nullable().default(null),
        /** Accrual stops while the balance is at or above this (a carry-over assumption). */
        cap: z.number().min(0).max(100000).nullable().default(null),
        /** Each year on this day the balance is cut to `carryOver` hours (leave that doesn't carry over). */
        reset: z
            .object({ month: z.number().int().min(1).max(12), day: z.number().int().min(1).max(31), carryOver: z.number().min(0).max(100000) })
            .nullable()
            .default(null),
    })
    .strict()
    .superRefine((a, ctx) => {
        if (a.method === "per_hour" && a.rate === null) ctx.addIssue({ code: "custom", message: "Give an accrual rate", path: ["rate"] });
        if (a.method === "per_period" && (a.hours === null || a.everyDays === null || a.anchor === null))
            ctx.addIssue({ code: "custom", message: "Give the hours, how often and from when", path: ["hours"] });
    });
export type LeaveAccrual = z.output<typeof leaveAccrual>;

const NONE: LeaveAccrual = { method: "none", rate: null, hours: null, everyDays: null, anchor: null, cap: null, reset: null };

/**
 * Starting points for each kind, from the National Employment Standards (full-time rates scale with
 * ordinary hours, so they suit part-time patterns too). Awards and agreements differ: the settings
 * page says to check the person's own.
 */
export const LEAVE_PRESETS = {
    annual: {
        name: "Annual leave",
        color: "blue",
        paid: true,
        tracksBalance: true,
        deductsPublicHolidays: false,
        accrual: { ...NONE, method: "per_hour", rate: round(4 / 52, 6) },
    },
    long_service: {
        name: "Long service leave",
        color: "indigo",
        paid: true,
        tracksBalance: true,
        deductsPublicHolidays: false,
        // NSW: 2 months (8⅔ weeks) after 10 years, i.e. 0.8667 weeks a year.
        accrual: { ...NONE, method: "per_hour", rate: round(8.6667 / 10 / 52, 6) },
    },
    personal: {
        name: "Personal/carer's leave",
        color: "pink",
        paid: true,
        tracksBalance: true,
        deductsPublicHolidays: false,
        accrual: { ...NONE, method: "per_hour", rate: round(2 / 52, 6) },
    },
    toil: { name: "Time off in lieu", color: "purple", paid: true, tracksBalance: true, deductsPublicHolidays: false, accrual: NONE },
    flex: { name: "Flex leave", color: "orange", paid: true, tracksBalance: true, deductsPublicHolidays: false, accrual: NONE },
    unpaid: { name: "Unpaid leave", color: "gray", paid: false, tracksBalance: false, deductsPublicHolidays: false, accrual: NONE },
    other: { name: "Other leave", color: "green", paid: true, tracksBalance: true, deductsPublicHolidays: false, accrual: NONE },
} as const satisfies Record<
    string,
    Pick<LeaveTypeInfo, "name" | "paid" | "tracksBalance" | "deductsPublicHolidays"> & { color: string; accrual: LeaveAccrual }
>;

// --- Context -------------------------------------------------------------------------------------

/** Everything about the calendar that changes what leave costs. */
export interface LeaveContext {
    pattern: WorkPattern;
    /** Public holidays that apply to this person (statewide, plus their region's, plus the Bank Holiday if chosen). */
    holidays: ReadonlyMap<string, string>;
    /** Configured non-working days: no leave needed, nothing accrues. */
    nonWorking: ReadonlySet<string>;
}

export type DayReason = "working" | "not_working" | "public_holiday" | "non_working";

export interface BookingDay {
    date: string;
    hours: number;
    reason: DayReason;
    holiday?: string;
}

/** The ordinary hours a day would normally be worked, and why it's 0 when it is. */
export function dayHours(ctx: LeaveContext, date: string): { hours: number; reason: DayReason; holiday?: string } {
    if (ctx.nonWorking.has(date)) return { hours: 0, reason: "non_working" };
    const base = patternHours(ctx.pattern, date);
    if (base === 0) return { hours: 0, reason: "not_working" };
    const holiday = ctx.holidays.get(date);
    if (holiday) return { hours: base, reason: "public_holiday", holiday };
    return { hours: base, reason: "working" };
}

type BookingShape = Pick<LeaveBookingInfo, "startDate" | "endDate" | "part" | "hours" | "dayHours">;
type TypeShape = Pick<LeaveTypeInfo, "deductsPublicHolidays">;

/** What each day of a booking takes from the balance. */
export function bookingDays(booking: BookingShape, type: TypeShape, ctx: LeaveContext): BookingDay[] {
    return eachDate(booking.startDate, booking.endDate, 800).map((date) => {
        const day = dayHours(ctx, date);
        if (day.reason === "non_working" || day.reason === "not_working") {
            // An explicit override still counts (an extra shift taken as leave).
            const override = booking.dayHours?.[date];
            return override ? { date, hours: round(override), reason: "working" } : { date, hours: 0, reason: day.reason };
        }
        if (day.reason === "public_holiday" && !type.deductsPublicHolidays) return { date, hours: 0, reason: "public_holiday", holiday: day.holiday };
        let taken = booking.dayHours?.[date] ?? day.hours;
        if (booking.part === "am" || booking.part === "pm") taken = day.hours / 2;
        if (booking.part === "hours") taken = Math.min(booking.hours ?? 0, 24);
        return { date, hours: round(taken), reason: day.reason, ...(day.holiday ? { holiday: day.holiday } : {}) };
    });
}

export const bookingHours = (booking: BookingShape, type: TypeShape, ctx: LeaveContext) =>
    round(bookingDays(booking, type, ctx).reduce((s, d) => s + d.hours, 0));

/** Working days a booking covers (days that cost hours). */
export const bookingWorkingDays = (booking: BookingShape, type: TypeShape, ctx: LeaveContext) =>
    bookingDays(booking, type, ctx).filter((d) => d.hours > 0).length;

// --- Which bookings count ------------------------------------------------------------------------

export type ForecastMode = "confirmed" | "planned" | "all";

const MODE_STATUSES: Record<ForecastMode, readonly LeaveStatus[]> = {
    confirmed: ["approved", "taken"],
    planned: ["approved", "taken", "requested", "proposed"],
    all: ["approved", "taken", "requested", "proposed", "draft"],
};

export const FORECAST_MODE_LABELS: Record<ForecastMode, string> = {
    confirmed: "Approved and taken only",
    planned: "Including requested and proposed",
    all: "Including drafts",
};

/**
 * Whether a booking is counted. Cancelled never is. A scenario's bookings count only when that
 * scenario is being looked at, on top of the mode's real bookings.
 */
export function counts(booking: Pick<LeaveBookingInfo, "status" | "scenarioId">, mode: ForecastMode, scenarioId: string | null = null): boolean {
    if (booking.status === "cancelled") return false;
    if (booking.scenarioId) return booking.scenarioId === scenarioId;
    return MODE_STATUSES[mode].includes(booking.status);
}

// --- Balances ------------------------------------------------------------------------------------

export interface Deduction {
    bookingId: string;
    title: string | null;
    startDate: string;
    endDate: string;
    status: LeaveStatus;
    hours: number;
    scenario: boolean;
}

export interface BalanceBreakdown {
    leaveTypeId: string;
    asOf: string;
    mode: ForecastMode;
    scenarioId: string | null;
    /** The entered balance and its date. */
    opening: number;
    openingDate: string;
    accrued: number;
    adjustments: number;
    taken: number;
    deductions: Deduction[];
    /** Hours lost to a yearly reset, and accrual not earned because of the cap. */
    forfeited: number;
    capped: number;
    closing: number;
    /** The lowest the balance gets on the way, and when. */
    lowest: { hours: number; date: string };
    /** The first day it goes below zero, if it does. */
    negativeFrom: string | null;
    /** asOf is before the balance date: only the entered balance is known. */
    beforeBalanceDate: boolean;
}

export interface BalanceInput {
    type: LeaveTypeInfo;
    bookings: readonly LeaveBookingInfo[];
    adjustments: readonly { leaveTypeId: string; date: string; hours: number }[];
    /** All of the person's types, to know which bookings are unpaid. */
    types: readonly LeaveTypeInfo[];
}

/** The balance of one leave type at the end of `asOf`, with every step that got it there. */
export function balanceAt(
    input: BalanceInput,
    ctx: LeaveContext,
    asOf: string,
    mode: ForecastMode = "planned",
    scenarioId: string | null = null,
): BalanceBreakdown {
    const { type } = input;
    const base: BalanceBreakdown = {
        leaveTypeId: type.id,
        asOf,
        mode,
        scenarioId,
        opening: round(type.balanceHours),
        openingDate: type.balanceDate,
        accrued: 0,
        adjustments: 0,
        taken: 0,
        deductions: [],
        forfeited: 0,
        capped: 0,
        closing: round(type.balanceHours),
        lowest: { hours: round(type.balanceHours), date: type.balanceDate },
        negativeFrom: type.balanceHours < 0 ? type.balanceDate : null,
        beforeBalanceDate: asOf < type.balanceDate,
    };
    if (asOf <= type.balanceDate) return base;

    const counted = input.bookings.filter((b) => counts(b, mode, scenarioId));
    // Leave taken per day for this type, and the days of unpaid leave (which earn nothing).
    const takenOn = new Map<string, number>();
    const perBooking = new Map<string, number>();
    const unpaid = new Set<string>();
    const typeOf = new Map(input.types.map((t) => [t.id, t]));
    for (const booking of counted) {
        const bookingType = typeOf.get(booking.leaveTypeId);
        if (!bookingType) continue;
        for (const day of bookingDays(booking, bookingType, ctx)) {
            if (day.date <= type.balanceDate || day.date > asOf || day.hours === 0) continue;
            if (!bookingType.paid) unpaid.add(day.date);
            if (booking.leaveTypeId !== type.id) continue;
            takenOn.set(day.date, (takenOn.get(day.date) ?? 0) + day.hours);
            perBooking.set(booking.id, (perBooking.get(booking.id) ?? 0) + day.hours);
        }
    }
    const adjustmentsOn = new Map<string, number>();
    for (const a of input.adjustments) {
        if (a.leaveTypeId !== type.id || a.date <= type.balanceDate || a.date > asOf) continue;
        adjustmentsOn.set(a.date, (adjustmentsOn.get(a.date) ?? 0) + a.hours);
    }

    const accrual = type.accrual;
    let balance = type.balanceHours;
    let accrued = 0;
    let adjusted = 0;
    let taken = 0;
    let forfeited = 0;
    let capped = 0;
    let lowest = { hours: balance, date: type.balanceDate };
    let negativeFrom: string | null = balance < 0 ? type.balanceDate : null;

    for (let date = addDays(type.balanceDate, 1); date <= asOf; date = addDays(date, 1)) {
        if (type.tracksBalance) {
            let earn = 0;
            if (accrual.method === "per_hour" && accrual.rate) {
                const day = dayHours(ctx, date);
                if (day.hours > 0 && !unpaid.has(date)) earn = day.hours * accrual.rate;
            } else if (accrual.method === "per_period" && accrual.hours && accrual.everyDays && accrual.anchor) {
                const since = daysBetween(accrual.anchor, date);
                if (since > 0 && since % accrual.everyDays === 0) earn = accrual.hours;
            }
            if (earn > 0 && accrual.cap !== null) {
                const room = Math.max(0, accrual.cap - balance);
                capped += earn - Math.min(earn, room);
                earn = Math.min(earn, room);
            }
            balance += earn;
            accrued += earn;
        }
        const adjustment = adjustmentsOn.get(date) ?? 0;
        balance += adjustment;
        adjusted += adjustment;
        const out = takenOn.get(date) ?? 0;
        balance -= out;
        taken += out;
        if (
            accrual.reset &&
            Number(date.slice(5, 7)) === accrual.reset.month &&
            Number(date.slice(8, 10)) === accrual.reset.day &&
            balance > accrual.reset.carryOver
        ) {
            forfeited += balance - accrual.reset.carryOver;
            balance = accrual.reset.carryOver;
        }
        if (balance < lowest.hours - 1e-9) lowest = { hours: balance, date };
        if (negativeFrom === null && balance < -1e-9) negativeFrom = date;
    }

    const byId = new Map(counted.map((b) => [b.id, b]));
    return {
        ...base,
        accrued: round(accrued),
        adjustments: round(adjusted),
        taken: round(taken),
        deductions: [...perBooking.entries()]
            .map(([id, h]) => {
                const b = byId.get(id)!;
                return {
                    bookingId: id,
                    title: b.title,
                    startDate: b.startDate,
                    endDate: b.endDate,
                    status: b.status,
                    hours: round(h),
                    scenario: !!b.scenarioId,
                };
            })
            .sort((a, b) => a.startDate.localeCompare(b.startDate)),
        forfeited: round(forfeited),
        capped: round(capped),
        closing: round(balance),
        lowest: { hours: round(lowest.hours), date: lowest.date },
        negativeFrom,
    };
}

export interface ForecastPoint {
    date: string;
    confirmed: number;
    planned: number;
    scenario: number | null;
}

/** Month-end balances from `from` for `months` months (the last day of each month). */
export function forecastSeries(input: BalanceInput, ctx: LeaveContext, from: string, months: number, scenarioId: string | null = null): ForecastPoint[] {
    const points: ForecastPoint[] = [];
    let [y, m] = [Number(from.slice(0, 4)), Number(from.slice(5, 7))];
    for (let i = 0; i < months; i++) {
        const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
        const date = `${y}-${String(m).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
        points.push({
            date,
            confirmed: balanceAt(input, ctx, date, "confirmed").closing,
            planned: balanceAt(input, ctx, date, "planned").closing,
            scenario: scenarioId ? balanceAt(input, ctx, date, "planned", scenarioId).closing : null,
        });
        m += 1;
        if (m > 12) [y, m] = [y + 1, 1];
    }
    return points;
}

/** Hours shown as hours and the equivalent days of the person's average working day: "45.6 h (6 days)". */
export function hoursLabel(value: number, pattern: WorkPattern): string {
    const working = pattern.hours.filter((h) => h > 0);
    const average = working.length ? working.reduce((s, h) => s + h, 0) / working.length : 0;
    const text = `${formatHours(value)} h`;
    if (!average) return text;
    const days = round(value / average, 1);
    return `${text} (${days} day${Math.abs(days) === 1 ? "" : "s"})`;
}

export const formatHours = (value: number) =>
    new Intl.NumberFormat("en-AU", { maximumFractionDigits: 2, minimumFractionDigits: Number.isInteger(round(value, 2)) ? 0 : 1 }).format(round(value, 2));

export function round(value: number, places = 4): number {
    const f = 10 ** places;
    return Math.round((value + Number.EPSILON) * f) / f;
}
