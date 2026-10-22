// When someone is available on a day: their planning hours (working hours) less leave, public
// holidays, non-working days and breaks, and the free time left after their commitments. Shared by
// Today's capacity and timeline (src/shared/today/engine.ts), the Worker and MCP.
//
// Everything here is a pure function of its inputs, so the same inputs always give the same answer.
// Times are handled as instants (milliseconds), converted from and to wall-clock times in the
// person's zone with Intl (zonedInstant, wallClock). A day is its own local midnight to the next,
// which is 23 or 25 hours long when daylight saving starts or ends, so durations stay exact.
import { z } from "zod";
import type { LeaveContext } from "../calendar/leave";
import { isoWeekday, zonedInstant } from "../calendar/time";

const MINUTE = 60_000;

// --- Planning hours (stored in planner_preferences, migration 0023) --------------------------------

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time like 09:00");
const day = z
    .object({ start: clock, end: clock })
    .strict()
    .refine((d) => d.end > d.start, { message: "The day must end after it starts", path: ["end"] });

/** Monday first. Null: no planning hours that day. */
const DEFAULT_WEEK = [...Array.from({ length: 5 }, () => ({ start: "09:00", end: "17:00" })), null, null];

/** Settings the retired Daily Planner kept in the same document (session lengths, estimates). Read past, never saved. */
const RETIRED_KEYS = ["minBlockMinutes", "maxBlockMinutes", "dailyFocusMinutes", "defaultEstimateMinutes"];

export const planningHours = z.preprocess(
    (value) => (value && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([k]) => !RETIRED_KEYS.includes(k))) : value),
    z
        .object({
            /** Monday to Sunday. Events, leave and public holidays are taken out of them. */
            workingHours: z.array(day.nullable()).length(7).default(DEFAULT_WEEK),
            /** Kept free after every event. */
            bufferMinutes: z.number().int().min(0).max(60).default(10),
            /** Count weekends, public holidays, non-working days and leave as available too. */
            planOnDaysOff: z.boolean().default(false),
        })
        .strict(),
);

export type PlanningHours = z.output<typeof planningHours>;
export const DEFAULT_PLANNING_HOURS: PlanningHours = planningHours.parse({});

// --- Intervals -----------------------------------------------------------------------------------

export interface Interval {
    start: number;
    end: number;
}

const ms = (iso: string) => Date.parse(iso);

/** Sorted, non-overlapping. */
export function merge(list: readonly Interval[]): Interval[] {
    const sorted = list.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start || a.end - b.end);
    const out: Interval[] = [];
    for (const i of sorted) {
        const last = out[out.length - 1];
        if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
        else out.push({ ...i });
    }
    return out;
}

/** `from` with every part of `remove` taken out. */
export function subtract(from: readonly Interval[], remove: readonly Interval[]): Interval[] {
    let out = merge(from);
    for (const r of merge(remove)) {
        const next: Interval[] = [];
        for (const i of out) {
            if (r.end <= i.start || r.start >= i.end) next.push(i);
            else {
                if (r.start > i.start) next.push({ start: i.start, end: r.start });
                if (r.end < i.end) next.push({ start: r.end, end: i.end });
            }
        }
        out = next;
    }
    return out;
}

export const intersect = (a: readonly Interval[], b: readonly Interval[]): Interval[] => subtract(a, subtract(a, b));

// --- Availability --------------------------------------------------------------------------------

/** Leave that takes time out of a day: requested, approved or taken (never drafts, proposals or scenarios). */
export interface LeaveDay {
    start: string;
    end: string;
    part: "full" | "am" | "pm" | "hours";
    hours: number | null;
    label: string;
}

/** A weekly period (Today's breaks): weekdays 1 (Monday) to 7, and local times. */
export interface WeeklyPeriod {
    label?: string;
    days: readonly number[];
    start: string;
    end: string;
}

export interface DayInputs {
    hours: PlanningHours;
    timeZone: string;
    /** Public holidays, non-working days and the work pattern, from the leave engine. Null: none configured. */
    leaveContext: LeaveContext | null;
    leave: readonly LeaveDay[];
    /** Breaks taken out of the planning hours (Today's preferences). */
    breaks?: readonly WeeklyPeriod[];
}

export interface Availability {
    date: string;
    /** When the person is available (empty on a day off). */
    window: Interval[];
    /** The planning hours as configured, before days off (to tell "outside your hours" from "on leave"). */
    configured: Interval[];
    offReason: string | null;
    /** Breaks taken out of the window that day, with their labels. */
    breaks?: (Interval & { label: string })[];
}

/** A weekly period's instants on one date, or nothing when it isn't on that weekday. */
export function periodOn(date: string, p: WeeklyPeriod, timeZone: string): Interval | null {
    if (!p.days.includes(isoWeekday(date))) return null;
    const start = ms(zonedInstant(date, p.start, timeZone));
    const end = ms(zonedInstant(date, p.end, timeZone));
    return end > start ? { start, end } : null;
}

/** The person's planning hours on a date, less leave, public holidays and non-working days. */
export function availability(date: string, inputs: DayInputs): Availability {
    const hours = inputs.hours.workingHours[isoWeekday(date) - 1];
    const configured = hours ? [{ start: ms(zonedInstant(date, hours.start, inputs.timeZone)), end: ms(zonedInstant(date, hours.end, inputs.timeZone)) }] : [];
    if (inputs.hours.planOnDaysOff) {
        const fallback = configured.length
            ? configured
            : [{ start: ms(zonedInstant(date, "09:00", inputs.timeZone)), end: ms(zonedInstant(date, "17:00", inputs.timeZone)) }];
        return withBreaks({ date, window: fallback, configured, offReason: null }, inputs);
    }
    if (!hours) return { date, window: [], configured, offReason: "Not a planning day" };
    if (inputs.leaveContext) {
        // Straight from the context: the leave engine's dayHours reports a work-pattern day off first.
        const holiday = inputs.leaveContext.holidays.get(date);
        if (holiday) return { date, window: [], configured, offReason: holiday };
        if (inputs.leaveContext.nonWorking.has(date)) return { date, window: [], configured, offReason: "Non-working day" };
    }
    let window = configured;
    for (const l of inputs.leave) {
        if (l.start > date || l.end < date) continue;
        const span = window[0];
        if (!span) break;
        if (l.part === "full") return { date, window: [], configured, offReason: l.label };
        const middle = span.start + Math.round((span.end - span.start) / 2 / MINUTE) * MINUTE;
        if (l.part === "am") window = subtract(window, [{ start: span.start, end: middle }]);
        else if (l.part === "pm") window = subtract(window, [{ start: middle, end: span.end }]);
        else if (l.hours) window = subtract(window, [{ start: Math.max(span.start, span.end - l.hours * 60 * MINUTE), end: span.end }]);
    }
    if (!window.length) return { date, window, configured, offReason: "On leave" };
    return withBreaks({ date, window, configured, offReason: null }, inputs);
}

/** Takes the day's breaks out of its window. A day that's all break has no planning hours. */
function withBreaks(day: Availability, inputs: DayInputs): Availability {
    const breaks: (Interval & { label: string })[] = [];
    for (const p of inputs.breaks ?? []) {
        const i = periodOn(day.date, p, inputs.timeZone);
        if (!i) continue;
        const inside = intersect(day.window, [i]);
        for (const part of inside) breaks.push({ ...part, label: p.label || "Break" });
    }
    if (!breaks.length) return day;
    const window = subtract(day.window, breaks);
    return { ...day, window, breaks, offReason: window.length ? null : "Breaks fill the day" };
}

// --- Commitments ---------------------------------------------------------------------------------

/** An event that takes time: the person's own, shared or subscribed. */
export interface Commitment {
    id: string;
    title: string;
    start: string;
    end: string;
    source: "local" | "subscription" | "import";
    shared: boolean;
    /** Free events (show as free) don't take time. */
    busy: boolean;
}

/** Free time in a window: what's left after commitments, with a buffer after each. */
export function freeTime(window: readonly Interval[], commitments: readonly Commitment[], bufferMinutes: number, after = -Infinity): Interval[] {
    const taken = commitments.filter((c) => c.busy).map((c) => ({ start: ms(c.start), end: ms(c.end) + bufferMinutes * MINUTE }));
    const open = subtract(window, taken).map((i) => ({ start: Math.max(i.start, after), end: i.end }));
    return open.filter((i) => i.end > i.start);
}
