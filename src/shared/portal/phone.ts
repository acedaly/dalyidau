// Guest mobile numbers. The single place that decides what a valid mobile is and how it's stored,
// shared by the portal forms, the guest/household APIs, the CSV importer, the legacy review and
// SMS sending, so they can never disagree. Numbers are stored in E.164 (+61412345678), which is
// what ClickSend expects.
//
// Australian mobiles can be written locally (0412 345 678) or internationally (+61 412 345 678,
// 61412345678). Overseas numbers must start with + and their country code; we never guess a
// country for them, so a New Zealand "021 123 4567" is refused rather than given +61.

/** Field label and guidance, shared so every form says the same thing. */
export const MOBILE_LABEL = "Mobile number";
export const MOBILE_PLACEHOLDER = "e.g. 0412 345 678";
export const MOBILE_HINT = "Australian mobile, e.g. 0412 345 678. For overseas numbers, start with + and the country code.";

export type MobileProblem = "characters" | "landline" | "australian_length" | "country_code" | "international_length";

export type MobileResult =
    | {
          ok: true;
          /** E.164, e.g. +61412345678. */
          e164: string;
          australian: boolean;
          /**
           * The number was read with an assumption: nine digits starting with 4, as a spreadsheet
           * leaves an Australian mobile after dropping its leading 0. Fine for something a person
           * just typed or imported; the legacy review asks before changing a stored value like it.
           */
          assumed: boolean;
      }
    | { ok: false; problem: MobileProblem; message: string };

const MESSAGES: Record<MobileProblem, string> = {
    characters: "Use only digits, spaces, brackets, dashes and a leading +.",
    landline: "That looks like a landline. Enter a mobile number, e.g. 0412 345 678, or start an overseas number with + and the country code.",
    australian_length: "Australian mobile numbers have 10 digits, e.g. 0412 345 678.",
    country_code: "Enter an Australian mobile (e.g. 0412 345 678), or start an overseas number with + and the country code.",
    international_length: "That overseas number is too short or too long. Check the country code and number.",
};

const fail = (problem: MobileProblem): MobileResult => ({ ok: false, problem, message: MESSAGES[problem] });
const australian = (nine: string, assumed = false): MobileResult => ({ ok: true, e164: `+61${nine}`, australian: true, assumed });

/** Reads Australian national digits after the 61 (or a leading 0) has been taken off. */
const afterAustralianPrefix = (rest: string): MobileResult => {
    if (/^4\d{8}$/.test(rest)) return australian(rest);
    if (/^4/.test(rest)) return fail("australian_length");
    if (/^[2378]\d{8}$/.test(rest)) return fail("landline");
    return fail("australian_length");
};

/**
 * Parses a mobile number for storage and SMS. Spaces, dots, dashes and brackets are allowed
 * anywhere; letters, extensions, several numbers in one cell and spreadsheet artefacts such as
 * "4.12E+08" are refused. An empty value is not a number: callers decide whether it's allowed.
 */
export function parseMobile(raw: string): MobileResult {
    // Non-breaking and other Unicode spaces arrive from spreadsheets and copied contact cards, and a
    // leading apostrophe is a spreadsheet's "keep this as text" marker (our own exports add one to +).
    const value = raw
        .replace(/[\s\u00a0\u2000-\u200b\u202f]+/g, " ")
        .trim()
        .replace(/^'/, "");
    if (!/^\+?[\d ().-]+$/.test(value)) return fail("characters");
    const plus = value.startsWith("+");
    // "+44 (0)7700 900123": the (0) is a trunk prefix written for local callers, not part of E.164.
    const digits = (plus ? value.replace(/\(0\)/g, "") : value).replace(/\D/g, "");

    if (plus) {
        if (digits.startsWith("61")) {
            // "+61 0412 345 678" is a common slip; the 0 doesn't belong after the country code.
            const rest = digits.slice(2);
            return afterAustralianPrefix(rest.startsWith("0") ? rest.slice(1) : rest);
        }
        if (digits.startsWith("0")) return fail("country_code");
        // E.164 allows up to 15 digits; nothing real is shorter than 8 including the country code.
        if (digits.length < 8 || digits.length > 15) return fail("international_length");
        return { ok: true, e164: `+${digits}`, australian: false, assumed: false };
    }

    if (digits.startsWith("0")) return digits.startsWith("00") ? fail("country_code") : afterAustralianPrefix(digits.slice(1));
    if (digits.startsWith("61") && digits.length >= 11) {
        const rest = digits.slice(2);
        return afterAustralianPrefix(rest.startsWith("0") ? rest.slice(1) : rest);
    }
    if (/^4\d{8}$/.test(digits)) return australian(digits, true);
    return fail("country_code");
}

/** The E.164 form of a valid mobile, or null for anything else (including empty). */
export function normaliseMobile(raw: string | null | undefined): string | null {
    if (!raw || !raw.trim()) return null;
    const result = parseMobile(raw);
    return result.ok ? result.e164 : null;
}

/** True only for a value already stored exactly as SMS sending expects it. */
export const isE164Mobile = (value: string | null | undefined): value is string => !!value && normaliseMobile(value) === value;

/**
 * For people reading a stored number, e.g. in CSV exports: Australian mobiles as 0412 345 678
 * (which also keeps spreadsheets from reading a leading + as a formula), anything else as stored.
 * Re-importing the result gives back the same E.164 number.
 */
export function formatMobile<T extends string | null | undefined>(stored: T): T | string {
    const match = stored ? /^\+614(\d{2})(\d{3})(\d{3})$/.exec(stored) : null;
    return match ? `04${match[1]} ${match[2]} ${match[3]}` : stored;
}
