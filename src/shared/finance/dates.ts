// Dates in bank exports. Each format is explicit: an Australian export is day-first, and a date is
// never guessed month-first unless that format was chosen. Every result is a real calendar date.

export const DATE_FORMATS = ["d/M/yyyy", "d/M/yy", "d MMM yy", "d MMM yyyy", "yyyy-MM-dd", "M/d/yyyy", "yyyyMMdd"] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

export const DATE_FORMAT_LABELS: Record<DateFormat, string> = {
    "d/M/yyyy": "Day/month/year (23/10/2026)",
    "d/M/yy": "Day/month/short year (23/10/26)",
    "d MMM yy": "Day month-name short year (23 Oct 26)",
    "d MMM yyyy": "Day month-name year (23 Oct 2026)",
    "yyyy-MM-dd": "Year-month-day (2026-10-23)",
    "M/d/yyyy": "Month/day/year, US (10/23/2026)",
    yyyyMMdd: "Compact (20261023)",
};

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

const isoOf = (year: number, month: number, day: number): string | null => {
    if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1) return null;
    const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
    if (day > days) return null;
    return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
};

/** Two-digit years are this century: bank exports cover recent history. */
const fullYear = (text: string) => (text.length === 2 ? 2000 + Number(text) : Number(text));

/** Parses `raw` in `format` to YYYY-MM-DD, or null. Separators /, - and . are accepted interchangeably. */
export function parseBankDate(raw: string, format: DateFormat): string | null {
    const text = raw.trim();
    let m: RegExpExecArray | null;
    switch (format) {
        case "d/M/yyyy":
            m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text);
            return m ? isoOf(Number(m[3]), Number(m[2]), Number(m[1])) : null;
        case "d/M/yy":
            m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2})$/.exec(text);
            return m ? isoOf(fullYear(m[3]), Number(m[2]), Number(m[1])) : null;
        case "M/d/yyyy":
            m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text);
            return m ? isoOf(Number(m[3]), Number(m[1]), Number(m[2])) : null;
        case "d MMM yy":
        case "d MMM yyyy": {
            m = /^(\d{1,2})[\s/-]+([A-Za-z]{3})[A-Za-z]*\.?[\s/-]+(\d{2}|\d{4})$/.exec(text);
            if (!m || (format === "d MMM yy") !== (m[3].length === 2)) return null;
            const month = MONTHS.indexOf(m[2].toLowerCase()) + 1;
            return month ? isoOf(fullYear(m[3]), month, Number(m[1])) : null;
        }
        case "yyyy-MM-dd":
            m = /^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})(?:[T ].*)?$/.exec(text);
            return m ? isoOf(Number(m[1]), Number(m[2]), Number(m[3])) : null;
        case "yyyyMMdd":
            m = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
            return m ? isoOf(Number(m[1]), Number(m[2]), Number(m[3])) : null;
    }
}

/**
 * The format most samples parse in (at least 80% of them: a stray bad date is reported on its own
 * row, not allowed to hide the layout), day-first before month-first. A file where "03/04/2026"
 * parses both ways and no sample settles it keeps day-first, the Australian convention, and says so.
 */
export function detectDateFormat(samples: readonly string[]): { format: DateFormat | null; ambiguous: boolean } {
    const values = samples.map((s) => s.trim()).filter(Boolean);
    if (!values.length) return { format: null, ambiguous: false };
    const scores = DATE_FORMATS.map((f) => ({ f, n: values.filter((v) => parseBankDate(v, f) !== null).length }));
    const best = Math.max(...scores.map((s) => s.n));
    if (best === 0 || best < values.length * 0.8) return { format: null, ambiguous: false };
    const fits = scores.filter((s) => s.n === best).map((s) => s.f);
    const format = fits[0];
    return { format, ambiguous: format === "d/M/yyyy" && fits.includes("M/d/yyyy") };
}

export const monthKey = (date: string) => date.slice(0, 7);

/** The first day of the month `offset` months from the one containing `date`. */
export const monthStart = (date: string, offset = 0) => {
    const year = Number(date.slice(0, 4));
    const month = Number(date.slice(5, 7)) - 1 + offset;
    const y = year + Math.floor(month / 12);
    const mm = ((month % 12) + 12) % 12;
    return `${y}-${String(mm + 1).padStart(2, "0")}-01`;
};

/** The last day of the month containing `date`. */
export const monthEnd = (date: string) => {
    const next = monthStart(date, 1);
    const d = new Date(Date.parse(`${next}T00:00:00Z`) - 86_400_000);
    return d.toISOString().slice(0, 10);
};

export const shiftDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export const daysApart = (a: string, b: string) => Math.round(Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
