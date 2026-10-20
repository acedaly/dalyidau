// Times and numbers on a wallboard, always in the board's own time zone.

export const clock = (date: Date, timeZone: string, seconds = false) =>
    new Intl.DateTimeFormat("en-AU", { timeZone, hour: "numeric", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}) }).format(date);

export const dayLabel = (date: Date, timeZone: string) =>
    new Intl.DateTimeFormat("en-AU", { timeZone, weekday: "long", day: "numeric", month: "long" }).format(date);

export const at = (iso: string | null | undefined, timeZone: string) =>
    iso
        ? new Intl.DateTimeFormat("en-AU", { timeZone, day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(iso))
        : "time not given";

export const shortTime = (iso: string | null | undefined, timeZone: string) =>
    iso ? new Intl.DateTimeFormat("en-AU", { timeZone, hour: "numeric", minute: "2-digit" }).format(new Date(iso)) : "–";

export const ago = (iso: string | null | undefined, now: number) => {
    if (!iso) return "never";
    const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
    return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};

/** A link shown as text a viewer can read and type (a wallboard isn't clicked). */
export const readableLink = (url: string | null | undefined) => (url ? url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "") : null);
