// Repeating tasks. A rule describes a series of calendar dates; a repeating task is one row whose
// due date moves along the series as each occurrence is completed. Nothing is generated ahead of
// time: Upcoming projects later occurrences on the fly, a bounded number at a time.
//
// The rule is a small, validated subset of iCalendar RRULE (RFC 5545), exported as an RRULE string
// for portability. Everything here is pure calendar-date arithmetic: dates are "YYYY-MM-DD" in the
// person's own calendar, so daylight saving never moves an occurrence.
//
// Two ways to repeat:
//   * "scheduled" (the default): occurrences follow the series. Completing an occurrence moves the
//     task to the first date in the series after both the completed date and today, so an overdue
//     weekly task moves to its next future day rather than to a date that's already past. Missed
//     occurrences are not recreated.
//   * "completion": the next occurrence is counted from the day it was completed ("every 3 days
//     after I last did it"). Only for plain intervals (no chosen weekdays).
//
// Month ends: a rule for the 31st falls on the last day of shorter months and returns to the 31st
// when it can. A yearly rule for 29 February falls on the 28th in other years.
import { z } from "zod";
import { addDays, isCalendarDate } from "../knowledge/dates";

export const FREQUENCIES = ["daily", "weekly", "monthly", "yearly"] as const;
export type Frequency = (typeof FREQUENCIES)[number];

export interface RecurrenceRule {
    freq: Frequency;
    interval: number;
    /** Weekly only: ISO weekdays, 1 = Monday … 7 = Sunday. Defaults to the anchor's weekday. */
    weekdays?: number[];
    /** Monthly only: day of the month (1–31), or -1 for the last day. Defaults to the anchor's day. */
    monthDay?: number;
    basis: "scheduled" | "completion";
    /** The first date of the series. Set by the Worker from the task's due date. */
    anchor: string;
    /** No occurrences after this date. */
    until?: string | null;
}

const MAX_INTERVAL: Record<Frequency, number> = { daily: 366, weekly: 104, monthly: 60, yearly: 20 };

const date = z.string().refine(isCalendarDate, "Use a real date (YYYY-MM-DD)");

/** What the browser sends. The anchor is optional: the Worker fills it in from the due date. */
export const recurrenceInput = z
    .object({
        freq: z.enum(FREQUENCIES),
        interval: z.number().int().min(1).max(366).default(1),
        weekdays: z.array(z.number().int().min(1).max(7)).max(7).optional(),
        monthDay: z
            .number()
            .int()
            .refine((n) => n === -1 || (n >= 1 && n <= 31), "Choose a day of the month")
            .optional(),
        basis: z.enum(["scheduled", "completion"]).default("scheduled"),
        anchor: date.optional(),
        until: date.nullable().optional(),
    })
    .strict()
    .superRefine((rule, ctx) => {
        if (rule.interval > MAX_INTERVAL[rule.freq]) ctx.addIssue({ code: "custom", path: ["interval"], message: `At most every ${MAX_INTERVAL[rule.freq]}` });
        if (rule.weekdays && rule.freq !== "weekly") ctx.addIssue({ code: "custom", path: ["weekdays"], message: "Weekdays only apply to weekly repeats" });
        if (rule.weekdays && rule.weekdays.length === 0) ctx.addIssue({ code: "custom", path: ["weekdays"], message: "Choose at least one day" });
        if (rule.monthDay !== undefined && rule.freq !== "monthly")
            ctx.addIssue({ code: "custom", path: ["monthDay"], message: "A day of the month only applies to monthly repeats" });
        if (rule.basis === "completion" && rule.weekdays && rule.weekdays.length)
            ctx.addIssue({ code: "custom", path: ["basis"], message: "Repeating after completion can't use chosen weekdays" });
    });
export type RecurrenceInput = z.input<typeof recurrenceInput>;

// --- Calendar arithmetic -------------------------------------------------------------------------

const parts = (value: string) => {
    const [y, m, d] = value.split("-").map(Number);
    return { y, m, d };
};
const format = (y: number, m: number, d: number) => `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
/** Days since 1970-01-01. */
const dayNumber = (value: string) => {
    const { y, m, d } = parts(value);
    return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
};
const fromDayNumber = (n: number) => new Date(n * 86_400_000).toISOString().slice(0, 10);
export const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
/** ISO weekday: 1 = Monday … 7 = Sunday. */
export const isoWeekday = (value: string) => ((((dayNumber(value) + 3) % 7) + 7) % 7) + 1;
export const daysBetween = (from: string, to: string) => dayNumber(to) - dayNumber(from);
const later = (a: string, b: string) => (a > b ? a : b);

/** The same day `months` later, on the last day of the month if that day doesn't exist. */
export const addMonths = (value: string, months: number, day?: number) => {
    const { y, m, d } = parts(value);
    const index = y * 12 + (m - 1) + months;
    const year = Math.floor(index / 12);
    const month = (index % 12) + 1;
    const wanted = day ?? d;
    return format(year, month, wanted === -1 ? daysInMonth(year, month) : Math.min(wanted, daysInMonth(year, month)));
};

/** Fills in the defaults the rule's anchor implies, so the stored rule says exactly what it does. */
export const withAnchor = (input: z.output<typeof recurrenceInput>, anchor: string): RecurrenceRule => {
    const rule: RecurrenceRule = { freq: input.freq, interval: input.interval, basis: input.basis, anchor, until: input.until ?? null };
    if (input.freq === "weekly" && input.basis === "scheduled")
        rule.weekdays = [...new Set(input.weekdays?.length ? input.weekdays : [isoWeekday(anchor)])].sort();
    if (input.freq === "monthly") rule.monthDay = input.monthDay ?? parts(anchor).d;
    return rule;
};

/** The first date of the series on or after `from`, or null if the series has ended. */
export function firstOnOrAfter(rule: RecurrenceRule, from: string): string | null {
    const start = later(from, rule.anchor);
    let result: string | null = null;
    switch (rule.freq) {
        case "daily": {
            const offset = daysBetween(rule.anchor, start);
            const steps = Math.ceil(offset / rule.interval);
            result = addDays(rule.anchor, steps * rule.interval);
            break;
        }
        case "weekly": {
            const weekdays = rule.weekdays?.length ? rule.weekdays : [isoWeekday(rule.anchor)];
            const anchorMonday = dayNumber(rule.anchor) - (isoWeekday(rule.anchor) - 1);
            let n = dayNumber(start);
            // At most one full cycle of weeks plus one week to look through.
            for (let i = 0; i < rule.interval * 7 + 7; i++, n++) {
                const week = Math.floor((n - anchorMonday) / 7);
                if (week % rule.interval !== 0) {
                    // Jump to the Monday of the next week in the cycle.
                    const nextWeek = week + (rule.interval - (week % rule.interval));
                    n = anchorMonday + nextWeek * 7 - 1;
                    continue;
                }
                const candidate = fromDayNumber(n);
                if (weekdays.includes(isoWeekday(candidate))) {
                    result = candidate;
                    break;
                }
            }
            break;
        }
        case "monthly": {
            const a = parts(rule.anchor);
            const s = parts(start);
            const monthsFromAnchor = s.y * 12 + s.m - (a.y * 12 + a.m);
            let step = Math.max(0, Math.floor(monthsFromAnchor / rule.interval));
            for (let i = 0; i < 3; i++, step++) {
                const candidate = addMonths(format(a.y, a.m, 1), step * rule.interval, rule.monthDay ?? a.d);
                if (candidate >= start) {
                    result = candidate;
                    break;
                }
            }
            break;
        }
        case "yearly": {
            const a = parts(rule.anchor);
            let step = Math.max(0, Math.floor((parts(start).y - a.y) / rule.interval));
            for (let i = 0; i < 3; i++, step++) {
                const year = a.y + step * rule.interval;
                const candidate = format(year, a.m, Math.min(a.d, daysInMonth(year, a.m)));
                if (candidate >= start) {
                    result = candidate;
                    break;
                }
            }
            break;
        }
    }
    if (result && rule.until && result > rule.until) return null;
    return result;
}

export const firstAfter = (rule: RecurrenceRule, value: string) => firstOnOrAfter(rule, addDays(value, 1));

export const isOccurrence = (rule: RecurrenceRule, value: string) => firstOnOrAfter(rule, value) === value;

/**
 * Where a repeating task moves when the occurrence due on `occurrence` is completed (or skipped)
 * on `today`. Null when the series has ended, in which case the task is simply completed.
 */
export function nextOccurrence(rule: RecurrenceRule, occurrence: string, today: string): string | null {
    if (rule.basis === "completion") {
        let next: string;
        switch (rule.freq) {
            case "daily":
                next = addDays(today, rule.interval);
                break;
            case "weekly":
                next = addDays(today, rule.interval * 7);
                break;
            case "monthly":
                next = addMonths(today, rule.interval);
                break;
            case "yearly":
                next = addMonths(today, rule.interval * 12);
                break;
        }
        return rule.until && next > rule.until ? null : next;
    }
    return firstAfter(rule, later(occurrence, today));
}

/** Later occurrences after `after`, up to and including `to`, at most `limit` of them. */
export function occurrencesBetween(rule: RecurrenceRule, after: string, to: string, limit = 14): string[] {
    if (rule.basis === "completion") return [];
    const out: string[] = [];
    let cursor = after;
    while (out.length < limit) {
        const next = firstAfter(rule, cursor);
        if (!next || next > to) break;
        out.push(next);
        cursor = next;
    }
    return out;
}

// --- Describing and exporting --------------------------------------------------------------------

const WEEKDAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ordinal = (n: number) => {
    const suffix = n % 100 >= 11 && n % 100 <= 13 ? "th" : (({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th");
    return `${n}${suffix}`;
};
const UNIT: Record<Frequency, [string, string]> = {
    daily: ["day", "days"],
    weekly: ["week", "weeks"],
    monthly: ["month", "months"],
    yearly: ["year", "years"],
};

/** "Every weekday", "Every 2 weeks on Mon, Thu", "Every month on the last day", "Every 3 days after completion". */
export function describeRule(rule: RecurrenceRule): string {
    const every = rule.interval === 1 ? `Every ${UNIT[rule.freq][0]}` : `Every ${rule.interval} ${UNIT[rule.freq][1]}`;
    let text = every;
    if (rule.basis === "completion") text = `${every} after completion`;
    else if (rule.freq === "weekly") {
        const days = rule.weekdays ?? [isoWeekday(rule.anchor)];
        if (rule.interval === 1 && days.join() === "1,2,3,4,5") text = "Every weekday";
        else if (rule.interval === 1 && days.length === 7) text = "Every day";
        else if (rule.interval === 2 && days.length === 1) text = `Every fortnight on ${WEEKDAY_NAMES[days[0] - 1]}`;
        else text = `${every} on ${days.map((d) => WEEKDAY_NAMES[d - 1]).join(", ")}`;
    } else if (rule.freq === "monthly") {
        const day = rule.monthDay ?? parts(rule.anchor).d;
        text = `${every} on the ${day === -1 ? "last day" : ordinal(day)}`;
    } else if (rule.freq === "yearly") {
        const a = parts(rule.anchor);
        text = `${every} on ${a.d} ${MONTHS[a.m - 1]}`;
    }
    return rule.until ? `${text}, until ${rule.until}` : text;
}

const RRULE_DAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

/** The rule as iCalendar RRULE text, for exports. Completion-based repeats have no RRULE equivalent and say so. */
export function toRRule(rule: RecurrenceRule): string {
    const out = [`FREQ=${rule.freq.toUpperCase()}`];
    if (rule.interval !== 1) out.push(`INTERVAL=${rule.interval}`);
    if (rule.freq === "weekly" && rule.weekdays?.length) out.push(`BYDAY=${rule.weekdays.map((d) => RRULE_DAYS[d - 1]).join(",")}`);
    if (rule.freq === "monthly") out.push(`BYMONTHDAY=${rule.monthDay ?? parts(rule.anchor).d}`);
    if (rule.until) out.push(`UNTIL=${rule.until.replace(/-/g, "")}`);
    return `DTSTART;VALUE=DATE:${rule.anchor.replace(/-/g, "")}\nRRULE:${out.join(";")}${rule.basis === "completion" ? "\nX-DALY-BASIS:COMPLETION" : ""}`;
}

/** A stored rule, re-validated as it's read; anything that no longer parses is treated as no rule. */
export const parseStoredRule = (json: string | null): RecurrenceRule | null => {
    if (!json) return null;
    try {
        const raw = JSON.parse(json) as RecurrenceRule;
        const parsed = recurrenceInput.safeParse(raw);
        if (!parsed.success || !raw.anchor || !isCalendarDate(raw.anchor)) return null;
        return withAnchor(parsed.data, raw.anchor);
    } catch {
        return null;
    }
};
