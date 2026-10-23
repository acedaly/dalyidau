// Money as whole cents, parsed from text without floating point. Bank exports write amounts many
// ways ("-45.20", "(45.20)", "45.20 DR", "$1,234.5", "1234"), so the parser reads the digits as
// strings and builds an integer; anything it can't read exactly is refused, never rounded.

export type ParsedAmount = { ok: true; cents: number } | { ok: false; reason: string };

/** The largest amount accepted: $10 billion, well inside a safe integer. */
export const MAX_CENTS = 1_000_000_000_000;

/**
 * Parses a bank amount into signed cents. Empty text is `{ ok: true, cents: 0 }` only when
 * `emptyIsZero` (separate debit/credit columns leave one blank); otherwise it's refused.
 */
export function parseCents(raw: string, options: { emptyIsZero?: boolean } = {}): ParsedAmount {
    let text = raw.trim().replace(/−/g, "-");
    if (!text) return options.emptyIsZero ? { ok: true, cents: 0 } : { ok: false, reason: "No amount" };
    let negative = false;
    if (/^\(.*\)$/.test(text)) {
        negative = true;
        text = text.slice(1, -1).trim();
    }
    const suffix = /\s*(DR|CR)\.?$/i.exec(text);
    if (suffix) {
        if (suffix[1].toUpperCase() === "DR") negative = !negative;
        text = text.slice(0, suffix.index).trim();
    }
    if (text.startsWith("-")) {
        negative = !negative;
        text = text.slice(1).trim();
    } else if (text.startsWith("+")) text = text.slice(1).trim();
    text = text.replace(/^(AUD|A\$|\$)\s*/i, "").replace(/\s*AUD$/i, "");
    // A trailing minus ("45.20-") is used by some exports.
    if (text.endsWith("-")) {
        negative = !negative;
        text = text.slice(0, -1).trim();
    }
    // Thousands separators only in their proper places.
    if (!/^(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$/.test(text) && !/^\.\d{1,2}$/.test(text)) {
        return { ok: false, reason: `"${raw.trim().slice(0, 30)}" isn't an amount` };
    }
    const [whole, fraction = ""] = text.replace(/,/g, "").split(".");
    const cents = Number(whole || "0") * 100 + Number(fraction.padEnd(2, "0"));
    if (!Number.isSafeInteger(cents) || cents > MAX_CENTS) return { ok: false, reason: "Amount is too large" };
    return { ok: true, cents: negative && cents !== 0 ? -cents : cents };
}

/** Sum of integer cents. Throws rather than lose precision. */
export const sumCents = (values: readonly number[]) => {
    let total = 0;
    for (const value of values) {
        if (!Number.isSafeInteger(value)) throw new Error("Not a whole number of cents");
        total += value;
    }
    if (!Number.isSafeInteger(total)) throw new Error("Total is out of range");
    return total;
};

const AUD = new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const AUD_WHOLE = new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", minimumFractionDigits: 0, maximumFractionDigits: 0 });

/**
 * "$1,234.50", "−$45.20". Formatting divides by 100 only for display: Intl formats the exact value of
 * any safe integer of cents correctly to two places.
 */
export const formatAud = (cents: number, options: { whole?: boolean; signed?: boolean } = {}) => {
    const text = (options.whole ? AUD_WHOLE : AUD).format(Math.abs(cents) / 100);
    if (cents < 0) return `−${text}`;
    return options.signed && cents > 0 ? `+${text}` : text;
};

/** Parses what a person typed in a form ("1,234.50", "-20") into cents, or null when it isn't one. */
export const parseInputCents = (value: string): number | null => {
    const parsed = parseCents(value);
    return parsed.ok ? parsed.cents : null;
};

/** "-1234.50": exact, for CSV export (no floating point). */
export const centsToDecimal = (cents: number) => {
    const abs = Math.abs(cents);
    return `${cents < 0 ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
};
