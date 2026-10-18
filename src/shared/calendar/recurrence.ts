// Repeat rules for events people create in Daly Calendar.
//
// The editor offers a structured subset of RFC 5545 RRULE (daily, weekly on chosen days, monthly on
// a day or an nth weekday, yearly; an interval; an end date or a count). It's stored as RRULE text
// with a floating UNTIL, the same form subscribed feeds use, and expanded on the Worker with
// ical.js (worker/calendar/expand.ts). Feeds may carry rules outside this subset: those are kept
// and expanded exactly, and the editor shows them as "Custom repeat" without changing them.
import { z } from "zod";
import { isoWeekday } from "./time";

export const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

const WEEKDAY_NAMES: Record<Weekday, string> = { MO: "Monday", TU: "Tuesday", WE: "Wednesday", TH: "Thursday", FR: "Friday", SA: "Saturday", SU: "Sunday" };
const ORDINALS: Record<number, string> = { 1: "first", 2: "second", 3: "third", 4: "fourth", [-1]: "last" };

export const repeatRule = z
    .object({
        freq: z.enum(["daily", "weekly", "monthly", "yearly"]),
        interval: z.number().int().min(1).max(99).default(1),
        /** Weekly: which days. Defaults to the start date's weekday. */
        byDay: z.array(z.enum(WEEKDAYS)).max(7).optional(),
        /** Monthly: on the start date's day of the month, or on its nth weekday ("second Tuesday", "last Friday"). */
        monthly: z.enum(["day", "weekday"]).optional(),
        /** The last date an occurrence may start on (local), or */
        until: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .nullish(),
        /** how many occurrences in all. */
        count: z.number().int().min(1).max(1000).nullish(),
    })
    .strict()
    .refine((r) => !(r.until && r.count), { message: "End on a date or after a number of times, not both", path: ["count"] });

export type RepeatRule = z.output<typeof repeatRule>;
export type RepeatInput = z.input<typeof repeatRule>;

const weekdayOf = (date: string): Weekday => WEEKDAYS[isoWeekday(date) - 1];

/** Which week of the month a date is in (1–4), or -1 for the last when it's in the final seven days. */
export const weekOfMonth = (date: string): number => {
    const day = Number(date.slice(8, 10));
    const [y, m] = [Number(date.slice(0, 4)), Number(date.slice(5, 7))];
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    if (day + 7 > last) return -1;
    return Math.ceil(day / 7);
};

/** RRULE text for a rule starting on `startDate` (and at `startTime` for timed events). UNTIL is floating local time. */
export function toRRule(rule: RepeatRule, startDate: string, startTime: string | null): string {
    const parts = [`FREQ=${rule.freq.toUpperCase()}`];
    if (rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`);
    if (rule.freq === "weekly") {
        const days = rule.byDay?.length ? rule.byDay : [weekdayOf(startDate)];
        parts.push(`BYDAY=${WEEKDAYS.filter((d) => days.includes(d)).join(",")}`);
    }
    if (rule.freq === "monthly") {
        if (rule.monthly === "weekday") parts.push(`BYDAY=${weekOfMonth(startDate)}${weekdayOf(startDate)}`);
        else parts.push(`BYMONTHDAY=${Number(startDate.slice(8, 10))}`);
    }
    if (rule.count) parts.push(`COUNT=${rule.count}`);
    if (rule.until) {
        const compact = rule.until.replaceAll("-", "");
        // The whole last day counts: an occurrence later that day still happens.
        parts.push(startTime ? `UNTIL=${compact}T235959` : `UNTIL=${compact}`);
    }
    return parts.join(";");
}

const field = (rrule: string, name: string) => new RegExp(`(?:^|;)${name}=([^;]+)`).exec(rrule)?.[1] ?? null;

/** The editor's view of stored RRULE text, or null when it's outside what the editor offers (shown as "Custom repeat"). */
export function fromRRule(rrule: string, startDate: string): RepeatRule | null {
    const allowed = new Set(["FREQ", "INTERVAL", "BYDAY", "BYMONTHDAY", "COUNT", "UNTIL", "WKST"]);
    const keys = rrule.split(";").map((p) => p.split("=")[0]);
    if (keys.some((k) => !allowed.has(k))) return null;
    const freq = field(rrule, "FREQ")?.toLowerCase();
    if (freq !== "daily" && freq !== "weekly" && freq !== "monthly" && freq !== "yearly") return null;
    const interval = Number(field(rrule, "INTERVAL") ?? "1");
    const count = field(rrule, "COUNT");
    const untilRaw = field(rrule, "UNTIL");
    const until = untilRaw ? `${untilRaw.slice(0, 4)}-${untilRaw.slice(4, 6)}-${untilRaw.slice(6, 8)}` : null;
    if (untilRaw?.endsWith("Z")) return null;
    const byDay = field(rrule, "BYDAY");
    const rule: RepeatRule = { freq, interval, until, count: count ? Number(count) : null };
    if (freq === "weekly") {
        if (byDay) {
            const days = byDay.split(",");
            if (days.some((d) => !(WEEKDAYS as readonly string[]).includes(d))) return null;
            rule.byDay = days as Weekday[];
        }
    } else if (freq === "monthly") {
        const monthDay = field(rrule, "BYMONTHDAY");
        if (byDay) {
            const match = /^(-1|[1-4])(MO|TU|WE|TH|FR|SA|SU)$/.exec(byDay);
            if (!match || match[2] !== weekdayOf(startDate) || Number(match[1]) !== weekOfMonth(startDate)) return null;
            rule.monthly = "weekday";
        } else if (monthDay && Number(monthDay) !== Number(startDate.slice(8, 10))) return null;
        else rule.monthly = "day";
    } else if (byDay || field(rrule, "BYMONTHDAY")) return null;
    const parsed = repeatRule.safeParse(rule);
    return parsed.success ? parsed.data : null;
}

const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : `${n} ${many}`);

/** "Every week on Monday and Thursday, 10 times", "Every month on the last Friday until Sat 3 Apr 2027". */
export function describeRepeat(rule: RepeatRule, startDate: string, untilLabel?: (date: string) => string): string {
    const unit = { daily: "day", weekly: "week", monthly: "month", yearly: "year" }[rule.freq];
    let text = rule.interval === 1 ? `Every ${unit}` : `Every ${plural(rule.interval, unit)}`;
    if (rule.freq === "weekly") {
        const days = rule.byDay?.length ? rule.byDay : [weekdayOf(startDate)];
        const names = WEEKDAYS.filter((d) => days.includes(d)).map((d) => WEEKDAY_NAMES[d]);
        text += ` on ${names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0]}`;
    } else if (rule.freq === "monthly") {
        text +=
            rule.monthly === "weekday"
                ? ` on the ${ORDINALS[weekOfMonth(startDate)]} ${WEEKDAY_NAMES[weekdayOf(startDate)]}`
                : ` on day ${Number(startDate.slice(8, 10))}`;
    } else if (rule.freq === "yearly") {
        text += ` on ${Number(startDate.slice(8, 10))} ${new Intl.DateTimeFormat("en-AU", { month: "long", timeZone: "UTC" }).format(Date.parse(`${startDate}T00:00:00Z`))}`;
    }
    if (rule.count) text += `, ${rule.count} time${rule.count === 1 ? "" : "s"}`;
    if (rule.until) text += ` until ${untilLabel ? untilLabel(rule.until) : rule.until}`;
    return text;
}

/** Frequencies the Worker refuses to expand: sub-daily rules from feeds are shown as single events. */
export const UNSUPPORTED_FREQUENCIES = ["SECONDLY", "MINUTELY", "HOURLY"];
