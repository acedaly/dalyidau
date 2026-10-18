// Dates and times for Daly Calendar, shared by the Worker and the browser.
//
// Events keep their wall-clock date and time in their own IANA zone ("9:00 in Australia/Sydney"),
// so a weekly 9 am meeting is at 9 am on both sides of a daylight-saving change. Instants (UTC ISO
// strings) are worked out from those with Intl, never with fixed offsets. All-day events are
// floating dates: the 24th is the 24th wherever you are.
import { addDays, isCalendarDate, localDate } from "../knowledge/dates";
import { isClockTime, isTimeZone, zonedInstant } from "../tasks/dates";
import { daysBetween, isoWeekday } from "../tasks/recurrence";

export { addDays, daysBetween, isCalendarDate, isClockTime, isTimeZone, isoWeekday, localDate, zonedInstant };

export const DEFAULT_TIME_ZONE = "Australia/Sydney";
/** The end of a series that never ends, so window queries can compare strings. */
export const FOREVER = "9999-12-31T00:00:00.000Z";

const PARTS = new Map<string, Intl.DateTimeFormat>();
const partsFormatter = (timeZone: string) => {
    let f = PARTS.get(timeZone);
    if (!f) {
        f = new Intl.DateTimeFormat("en-CA", {
            timeZone,
            hourCycle: "h23",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
        });
        PARTS.set(timeZone, f);
    }
    return f;
};

/** The local date and time of an instant in a zone: { date: "2026-10-04", time: "03:30" }. */
export function wallClock(instant: string | Date, timeZone: string): { date: string; time: string } {
    const parts = partsFormatter(timeZone).formatToParts(typeof instant === "string" ? new Date(instant) : instant);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
    const hour = get("hour") === "24" ? "00" : get("hour");
    return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${hour}:${get("minute")}` };
}

/** Minutes between two wall-clock moments, ignoring daylight saving (an event's length as people think of it). */
export const wallMinutes = (startDate: string, startTime: string, endDate: string, endTime: string) =>
    daysBetween(startDate, endDate) * 1440 + toMinutes(endTime) - toMinutes(startTime);

export const toMinutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

export const fromMinutes = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/** A wall-clock moment moved by some minutes (across midnight as needed). */
export function addWallMinutes(date: string, time: string, minutes: number): { date: string; time: string } {
    const total = toMinutes(time) + minutes;
    const days = Math.floor(total / 1440);
    return { date: addDays(date, days), time: fromMinutes(total - days * 1440) };
}

/**
 * The key of one occurrence of a series: its original local start in the event's zone.
 * "2026-10-19" for all-day events, "2026-10-19T09:00" for timed ones.
 */
export const occurrenceKey = (date: string, time: string | null) => (time ? `${date}T${time}` : date);

export const isOccurrenceKey = (value: unknown): value is string =>
    typeof value === "string" && (/^\d{4}-\d{2}-\d{2}$/.test(value) || /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/.test(value));

/** The instant a local day starts in a zone. */
export const dayStart = (date: string, timeZone: string) => zonedInstant(date, "00:00", timeZone);

/** The instants covering local dates `from`..`to` (inclusive) in a zone: [start, end). */
export const dayWindow = (from: string, to: string, timeZone: string) => ({ start: dayStart(from, timeZone), end: dayStart(addDays(to, 1), timeZone) });

/** Every date from `from` to `to` inclusive. */
export function eachDate(from: string, to: string, max = 1100): string[] {
    const out: string[] = [];
    for (let d = from; d <= to && out.length < max; d = addDays(d, 1)) out.push(d);
    return out;
}

/** The first day of the week containing a date (weekStart 1 = Monday, the Australian default; 0 = Sunday). */
export const startOfWeek = (date: string, weekStart: 0 | 1 = 1) => {
    const weekday = isoWeekday(date) % 7; // Sunday 0 … Saturday 6
    return addDays(date, -((weekday - weekStart + 7) % 7));
};

export const startOfMonth = (date: string) => `${date.slice(0, 7)}-01`;

export const endOfMonth = (date: string) => {
    const [y, m] = date.split("-").map(Number);
    return `${date.slice(0, 7)}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
};

export const addMonthsToDate = (date: string, months: number) => {
    const [y, m, d] = date.split("-").map(Number);
    const total = y * 12 + (m - 1) + months;
    const year = Math.floor(total / 12);
    const month = (total % 12) + 1;
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return `${year}-${String(month).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
};

const utc = (date: string) => Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
const fmt = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-AU", { ...options, timeZone: "UTC" });
const DAY = fmt({ weekday: "short", day: "numeric", month: "short" });
const DAY_YEAR = fmt({ weekday: "short", day: "numeric", month: "short", year: "numeric" });
const LONG = fmt({ weekday: "long", day: "numeric", month: "long", year: "numeric" });
const MONTH = fmt({ month: "long", year: "numeric" });
const SHORT_MONTH = fmt({ month: "short" });
const WEEKDAY = fmt({ weekday: "short" });
/** en-AU puts a comma after the weekday; the portal writes dates without it. */
const plain = (text: string) => text.replace(",", "");

/** "Mon 19 Oct", or "Mon 19 Oct 2027" outside the reference year. */
export const dayLabel = (date: string, referenceYear?: string) =>
    plain((referenceYear && date.slice(0, 4) !== referenceYear ? DAY_YEAR : DAY).format(utc(date)));
export const longDateLabel = (date: string) => plain(LONG.format(utc(date)));
export const monthLabel = (date: string) => MONTH.format(utc(date));
export const shortMonthLabel = (date: string) => SHORT_MONTH.format(utc(date));
export const weekdayLabel = (date: string) => WEEKDAY.format(utc(date));

/** "9 am", "5:30 pm" from "17:30". */
export function timeLabel(time: string): string {
    const [hours, minutes] = time.split(":").map(Number);
    const suffix = hours < 12 ? "am" : "pm";
    const hour = hours % 12 === 0 ? 12 : hours % 12;
    return minutes ? `${hour}:${String(minutes).padStart(2, "0")} ${suffix}` : `${hour} ${suffix}`;
}

/** "Mon 19 Oct – Fri 23 Oct", "Mon 19 Oct" for one day. */
export const rangeLabel = (from: string, to: string, referenceYear?: string) =>
    from === to ? dayLabel(from, referenceYear) : `${dayLabel(from, referenceYear)} – ${dayLabel(to, referenceYear)}`;

/** The short name of a zone at a moment ("AEDT", "AEST", "GMT+10"), for showing which zone a time is in. */
export function zoneAbbreviation(timeZone: string, at: Date = new Date()): string {
    try {
        const part = new Intl.DateTimeFormat("en-AU", { timeZone, timeZoneName: "short" }).formatToParts(at).find((p) => p.type === "timeZoneName");
        return part?.value ?? timeZone;
    } catch {
        return timeZone;
    }
}

/** Minutes a zone is ahead of UTC at an instant (for building VTIMEZONE definitions). */
export function zoneOffsetMinutes(timeZone: string, at: number): number {
    const wall = wallClock(new Date(at), timeZone);
    const asUtc = Date.UTC(
        Number(wall.date.slice(0, 4)),
        Number(wall.date.slice(5, 7)) - 1,
        Number(wall.date.slice(8, 10)),
        Number(wall.time.slice(0, 2)),
        Number(wall.time.slice(3, 5)),
    );
    return Math.round((asUtc - Math.floor(at / 60_000) * 60_000) / 60_000);
}
