// Dates for Tasks. Due dates and deadlines are calendar dates and due times are wall-clock times in
// the person's own time zone ("floating"), so neither ever shifts with UTC or daylight saving.
// Only reminders are instants, worked out from a date, a time and an IANA zone with Intl.
import { addDays, isCalendarDate, localDate } from "../knowledge/dates";
import { daysBetween, isoWeekday } from "./recurrence";

export { addDays, isCalendarDate, localDate };

export const isTimeZone = (value: string) => {
    try {
        new Intl.DateTimeFormat("en-AU", { timeZone: value });
        return true;
    } catch {
        return false;
    }
};

export const isClockTime = (value: unknown): value is string => typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);

/** Minutes `timeZone` is ahead of UTC at `instant`. */
const offsetMinutes = (instant: number, timeZone: string) => {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    }).formatToParts(new Date(instant));
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
    const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
    return Math.round((asUtc - Math.floor(instant / 1000) * 1000) / 60_000);
};

/**
 * The instant a local date and time happen in `timeZone`, as ISO in UTC. A time inside the hour
 * that daylight saving skips (2:30 am on the first Sunday of October in Sydney) comes out an hour
 * later; in the repeated hour in April, the first of the two.
 */
export function zonedInstant(date: string, time: string, timeZone: string): string {
    const [y, mo, d] = date.split("-").map(Number);
    const [h, mi] = time.split(":").map(Number);
    const wall = Date.UTC(y, mo - 1, d, h, mi);
    // Twice: the first guess can land on the other side of a daylight saving change.
    let instant = wall - offsetMinutes(wall, timeZone) * 60_000;
    instant = wall - offsetMinutes(instant, timeZone) * 60_000;
    return new Date(instant).toISOString();
}

const SHORT = new Intl.DateTimeFormat("en-AU", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const SHORT_YEAR = new Intl.DateTimeFormat("en-AU", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const LONG = new Intl.DateTimeFormat("en-AU", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
/** en-AU puts a comma after the weekday ("Tue, 3 Nov"); the app writes dates without it. */
const plain = (text: string) => text.replace(",", "");
const utc = (date: string) => {
    const [y, m, d] = date.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
};

/** "Today", "Tomorrow", "Yesterday", "Friday" (within the week ahead), "Fri 23 Oct", "Mon 4 Jan 2027". */
export function relativeDate(date: string, today: string): string {
    const diff = daysBetween(today, date);
    if (diff === 0) return "Today";
    if (diff === 1) return "Tomorrow";
    if (diff === -1) return "Yesterday";
    if (diff > 1 && diff < 7) return new Intl.DateTimeFormat("en-AU", { weekday: "long", timeZone: "UTC" }).format(utc(date));
    return plain(date.slice(0, 4) === today.slice(0, 4) ? SHORT.format(utc(date)) : SHORT_YEAR.format(utc(date)));
}

/** "Friday 23 October" for day headings. */
export const longDate = (date: string) => plain(LONG.format(utc(date)));
export const shortDate = (date: string) => plain(SHORT_YEAR.format(utc(date)));

/** "5:30 pm" from "17:30". */
export function clockLabel(time: string): string {
    const [h, m] = time.split(":").map(Number);
    const suffix = h < 12 ? "am" : "pm";
    const hour = h % 12 === 0 ? 12 : h % 12;
    return m ? `${hour}:${String(m).padStart(2, "0")} ${suffix}` : `${hour} ${suffix}`;
}

/** The Monday on or before a date. */
export const weekStart = (date: string) => addDays(date, 1 - isoWeekday(date));
