// Formatting shared by portal pages. Dates in the data model are plain strings:
// "YYYY-MM-DD" for dates and "YYYY-MM-DDTHH:MM" for local wall-clock times.

const LOCALE = "en-AU";

/**
 * Dates and wall-clock times are shown as written. Full timestamps (audit log, responses) are shown
 * in `timeZone`, which pages pass from the wedding settings so the server render and the browser
 * agree on every character.
 */
export const formatDate = (
    iso: string | null | undefined,
    options: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" },
    timeZone = "Australia/Sydney",
) => {
    if (!iso) return "";
    const local = iso.length <= 16;
    const date = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso.length === 16 ? `${iso}:00Z` : iso);
    if (Number.isNaN(date.getTime())) return iso;
    try {
        return new Intl.DateTimeFormat(LOCALE, { ...options, timeZone: local ? "UTC" : timeZone }).format(date);
    } catch {
        return new Intl.DateTimeFormat(LOCALE, { ...options, timeZone: "UTC" }).format(date);
    }
};

export const formatDateTime = (iso: string | null | undefined, timeZone?: string) =>
    formatDate(iso, { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }, timeZone);

/** Wall-clock time from "YYYY-MM-DDTHH:MM", e.g. "3:30 pm". */
export const formatTime = (local: string | null | undefined) => (local && local.length >= 16 ? formatDate(local, { hour: "numeric", minute: "2-digit" }) : "");

/** "2 hours ago", "3 days ago"; falls back to a date after a month. */
export const formatRelative = (iso: string, now = Date.now(), timeZone?: string) => {
    const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
    const abs = Math.abs(seconds);
    const rtf = new Intl.RelativeTimeFormat(LOCALE, { numeric: "auto" });
    if (abs < 60) return rtf.format(seconds, "second");
    if (abs < 3600) return rtf.format(Math.round(seconds / 60), "minute");
    if (abs < 86_400) return rtf.format(Math.round(seconds / 3600), "hour");
    if (abs < 30 * 86_400) return rtf.format(Math.round(seconds / 86_400), "day");
    return formatDate(iso, undefined, timeZone);
};

export const formatMoney = (cents: number | null | undefined, currency = "AUD", options: { whole?: boolean } = {}) => {
    if (cents === null || cents === undefined) return "—";
    return new Intl.NumberFormat(LOCALE, {
        style: "currency",
        currency,
        minimumFractionDigits: options.whole ? 0 : 2,
        maximumFractionDigits: options.whole ? 0 : 2,
    }).format(cents / 100);
};

/** Parses "1,234.50" or "$1234" into cents. Returns null for empty input and NaN for junk. */
export const parseMoney = (value: string): number | null => {
    const clean = value.replace(/[$,\s]/g, "");
    if (!clean) return null;
    if (!/^\d+(\.\d{0,2})?$/.test(clean)) return Number.NaN;
    return Math.round(Number.parseFloat(clean) * 100);
};

export const formatNumber = (value: number) => new Intl.NumberFormat(LOCALE).format(value);

export const percent = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

export const pluralise = (count: number, singular: string, plural = `${singular}s`) => `${formatNumber(count)} ${count === 1 ? singular : plural}`;

export const initials = (name: string) =>
    name
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0]?.toUpperCase() ?? "")
        .join("");

/** Days from today (in the wedding's time zone) until a YYYY-MM-DD date. */
export const daysUntil = (isoDate: string, timeZone: string, now = new Date()) => {
    let today: string;
    try {
        today = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
    } catch {
        today = now.toISOString().slice(0, 10);
    }
    return Math.round((Date.parse(`${isoDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
};

export const todayIso = (timeZone: string) => {
    try {
        return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    } catch {
        return new Date().toISOString().slice(0, 10);
    }
};
