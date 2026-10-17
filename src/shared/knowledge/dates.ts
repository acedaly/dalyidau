// Calendar dates for daily notes. A daily note belongs to a date ("YYYY-MM-DD") in its space's time
// zone, worked out with Intl, which knows each zone's daylight saving rules (Sydney's clocks change,
// Brisbane's and Perth's don't, Lord Howe's move by half an hour).

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Whether a "YYYY-MM-DD" string is a real calendar date within a sensible range. */
export const isCalendarDate = (value: unknown): value is string => {
    if (typeof value !== "string") return false;
    const match = DATE.exec(value);
    if (!match) return false;
    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    if (year < 1900 || year > 2200) return false;
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};

/** The calendar date at `instant` in `timeZone`. */
export const localDate = (instant: Date, timeZone: string): string => {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(instant);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")}`;
};

/** The date `days` after (or before) a calendar date. Pure date arithmetic: time zones don't apply. */
export const addDays = (date: string, days: number): string => {
    const [year, month, day] = date.split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
};

/** "Saturday 17 October 2026". */
export const formatDailyTitle = (date: string): string => {
    const [year, month, day] = date.split("-").map(Number);
    return new Intl.DateTimeFormat("en-AU", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(
        Date.UTC(year, month - 1, day),
    );
};

/** Minutes `timeZone` is ahead of UTC at `instant` (e.g. 660 for Sydney in summer). */
const offsetMinutes = (instant: Date, timeZone: string) => {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    }).formatToParts(instant);
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
    const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
    return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60_000);
};

/** The instant a calendar date begins in `timeZone`, as an ISO string in UTC. */
export const startOfLocalDay = (date: string, timeZone: string): string => {
    const [year, month, day] = date.split("-").map(Number);
    const guess = Date.UTC(year, month - 1, day);
    // Twice: the first pass can land on the other side of a daylight saving change.
    let instant = guess - offsetMinutes(new Date(guess), timeZone) * 60_000;
    instant = guess - offsetMinutes(new Date(instant), timeZone) * 60_000;
    return new Date(instant).toISOString();
};
