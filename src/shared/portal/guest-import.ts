// Pure helpers and data shapes for the guest CSV import (worker/portal/import.ts) and its preview
// dialog. Nothing here touches the database, so it's unit-tested directly.

// ---------------------------------------------------------------------------------------------
// Names

/** Lower-case words that start a surname: "Ludwig van Beethoven", "Maria de la Cruz". */
const SURNAME_PARTICLES = new Set(["van", "von", "de", "da", "di", "del", "della", "der", "den", "du", "la", "le", "dos", "das", "ter", "ten", "bin", "al"]);

const collapse = (value: string) => value.replace(/\s+/g, " ").trim();

/** Case- and accent-insensitive form used for matching names. Never shown or stored. */
export const matchKey = (value: string) =>
    collapse(
        value
            .normalize("NFKD")
            .replace(/\p{M}/gu, "")
            .toLowerCase()
            .replace(/[’‘`]/g, "'")
            .replace(/[^\p{L}\p{N}' -]/gu, " "),
    );

const capitaliseWord = (word: string) =>
    word
        .split(/([-'’])/)
        .map((part) => (/^[-'’]$/.test(part) || part === "" ? part : part[0].toLocaleUpperCase("en-AU") + part.slice(1).toLocaleLowerCase("en-AU")))
        .join("");

/** "ross smith" → "Ross Smith", "FENWICK-HALE" → "Fenwick-Hale". Particles after the first word stay lower case. */
export const properCase = (value: string) =>
    collapse(value)
        .split(" ")
        .map((word, i) => (i > 0 && SURNAME_PARTICLES.has(word.toLowerCase()) ? word.toLowerCase() : capitaliseWord(word)))
        .join(" ");

/** A word typed all in lower case, or shouted in capitals (two or more letters). */
const oddCase = (word: string) => {
    const letters = word.replace(/[^\p{L}]/gu, "");
    if (!letters || SURNAME_PARTICLES.has(word.toLowerCase())) return false;
    const first = letters[0];
    if (first === first.toLocaleLowerCase("en-AU") && first !== first.toLocaleUpperCase("en-AU")) return true;
    return letters.length > 1 && letters === letters.toLocaleUpperCase("en-AU") && letters !== letters.toLocaleLowerCase("en-AU");
};

const CONNECTORS = new Set(["and", "&", "of", "the", "+"]);

/**
 * A party or household name with lower-case or shouted names fixed ("Ross smith & Tameka Pearce"
 * → "Ross Smith & Tameka Pearce"), or null when it already looks right. Connecting words stay.
 */
export const suggestPartyName = (value: string) => {
    let changed = false;
    const fixed = collapse(value)
        .split(" ")
        .map((word, i) => {
            const bare = word.replace(/[,;]+$/, "");
            if ((i > 0 && CONNECTORS.has(bare.toLowerCase())) || !oddCase(bare)) return word;
            changed = true;
            return capitaliseWord(bare) + word.slice(bare.length);
        })
        .join(" ");
    return changed ? fixed : null;
};

export interface SplitName {
    firstName: string;
    lastName: string;
    /** Why a person should look at this name before importing. Empty when it looks ordinary. */
    review: string[];
    /** A suggested correction (capitalisation), if any. */
    suggestion: { firstName: string; lastName: string } | null;
}

/**
 * Splits "Guest Name" into first and last names. Ordinary two-word names split cleanly; anything
 * else is split as sensibly as possible and flagged for review rather than guessed silently.
 */
export function splitGuestName(raw: string): SplitName {
    const name = collapse(raw.replace(/^["']+|["']+$/g, ""));
    const words = name ? name.split(" ") : [];
    const review: string[] = [];
    let firstName = "";
    let lastName = "";

    if (words.length === 1) {
        firstName = words[0];
        review.push("Only one name was given. Add a surname if you know it.");
    } else if (words.length === 2) {
        [firstName, lastName] = words;
    } else if (words.length > 2) {
        const particle = words.findIndex((word, i) => i > 0 && i < words.length - 1 && SURNAME_PARTICLES.has(word.toLowerCase()));
        const split = particle > 0 ? particle : words.length - 1;
        firstName = words.slice(0, split).join(" ");
        lastName = words.slice(split).join(" ");
        if (particle < 0) review.push("More than two names. Check which part is the surname.");
    }

    if (/(^|\s)(&|and|\+)(\s|$)/i.test(name)) review.push("This looks like more than one person.");
    if (/[^\p{L}\p{M}'’ .-]/u.test(name)) review.push("The name contains unusual characters.");
    const needsCase = words.some(oddCase);
    if (needsCase) review.push("Check the capitalisation.");
    const suggestion = needsCase ? { firstName: properCase(firstName), lastName: properCase(lastName) } : null;
    return { firstName, lastName, review, suggestion };
}

// ---------------------------------------------------------------------------------------------
// Addresses

export interface PostalAddress {
    addressLine1: string | null;
    addressLine2: string | null;
    locality: string | null;
    region: string | null;
    postcode: string | null;
    country: string | null;
}

export const ADDRESS_FIELDS = ["addressLine1", "addressLine2", "locality", "region", "postcode", "country"] as const;

/** "-", "n/a" and blanks mean "no address", not an address called "-". */
export const isBlankAddress = (raw: string | null | undefined) => !raw || /^[\s\-–—.?]*$/.test(raw) || /^(n\/?a|none|tbc|tba|unknown)$/i.test(raw.trim());

/** Punctuation-, case- and space-insensitive form for comparing addresses. */
export const addressKey = (raw: string) => raw.toLowerCase().replace(/[^a-z0-9]/g, "");

const STATES = "NSW|VIC|QLD|SA|WA|TAS|NT|ACT";
const STREET_TYPES = new Set(
    (
        "street st road rd avenue ave av drive dr crescent cres cct circuit place pl lane ln way court ct parade pde close cl terrace tce " +
        "highway hwy boulevard blvd grove gr square sq esplanade esp loop rise row track trail walk mews ridge glen gardens gdns promenade"
    ).split(" "),
);

/** A post office box or locked bag, kept together as the first line. */
const PO_BOX = /^((?:p\.?\s*o\.?\s*box|post office box|locked bag|gpo box)\s*\d+)\s*,?\s*(.*)$/i;

/**
 * Best-effort split of an Australian one-line address into the household's postal fields.
 * Anything it can't place stays in the first line, so nothing is ever lost.
 */
export function parseAddress(raw: string): PostalAddress {
    let rest = collapse(raw).replace(/[,\s]+$/, "");
    let postcode: string | null = null;
    let region: string | null = null;

    const pc = /^(.*?\S)[\s,]*(\d{4})$/.exec(rest);
    // Four trailing digits are a postcode unless they're the box number itself.
    if (pc && !/box\s*$|bag\s*$/i.test(pc[1])) {
        postcode = pc[2];
        rest = pc[1].replace(/[,\s]+$/, "");
    }
    const state = new RegExp(`^(.*?)[\\s,]*\\b(${STATES})\\.?$`, "i").exec(rest);
    if (state && state[1]) {
        region = state[2].toUpperCase();
        rest = state[1].replace(/[,\s]+$/, "");
    }

    let addressLine1 = rest;
    let locality: string | null = null;
    const box = PO_BOX.exec(rest);
    if (box) {
        addressLine1 = box[1];
        locality = box[2] || null;
    } else if (rest.includes(",")) {
        const parts = rest
            .split(",")
            .map((p) => p.trim())
            .filter(Boolean);
        const last = parts[parts.length - 1];
        // "Sample Street, 1A" is a street and a number, not a suburb.
        if (parts.length > 1 && !/\d/.test(last)) {
            locality = last;
            addressLine1 = parts.slice(0, -1).join(", ");
        }
    } else {
        const words = rest.split(" ");
        let streetEnd = -1;
        words.forEach((word, i) => {
            if (i > 0 && STREET_TYPES.has(word.toLowerCase().replace(/\.$/, ""))) streetEnd = i;
        });
        if (streetEnd > 0 && streetEnd < words.length - 1) {
            addressLine1 = words.slice(0, streetEnd + 1).join(" ");
            locality = words.slice(streetEnd + 1).join(" ");
        }
    }
    return {
        addressLine1: addressLine1 || null,
        addressLine2: null,
        locality,
        region,
        postcode,
        country: region || postcode ? "Australia" : null,
    };
}

/** Street addresses have a number; a PO box has its box number. "Good question" has neither. */
export const addressLooksIncomplete = (raw: string) => !/\d/.test(raw);

export const formatAddress = (address: Partial<PostalAddress> | null | undefined) =>
    address
        ? [address.addressLine1, address.addressLine2, [address.locality, address.region, address.postcode].filter(Boolean).join(" "), address.country]
              .filter((part) => part && part.trim())
              .join(", ")
        : "";

export interface AddressChoice {
    /** The address as typed (the most complete variant). */
    text: string;
    /** Which guests gave it (or a variant of it). */
    guests: string[];
}

/**
 * Groups the addresses a party's guests gave. Variants that only differ in spacing, case or
 * punctuation, or where one is a shortened form of the other ("4 Palmer St Exampleton" vs
 * "4 Palmer St Exampleton NSW 2390"), count as one address; the most complete is kept.
 */
export function groupAddresses(entries: { raw: string | null; guest: string }[]): AddressChoice[] {
    const groups: { key: string; text: string; guests: string[] }[] = [];
    for (const { raw, guest } of entries) {
        if (isBlankAddress(raw)) continue;
        const text = collapse(raw!);
        const key = addressKey(text);
        const same = groups.find((g) => g.key === key || g.key.startsWith(key) || key.startsWith(g.key));
        if (!same) groups.push({ key, text, guests: [guest] });
        else {
            same.guests.push(guest);
            if (key.length > same.key.length) Object.assign(same, { key, text });
        }
    }
    // The address most guests gave comes first; ties keep the file's order.
    return groups.sort((a, b) => b.guests.length - a.guests.length).map(({ text, guests }) => ({ text, guests }));
}

// ---------------------------------------------------------------------------------------------
// Say I Do

/** The party id from a Say I Do unique link, e.g. "https://sayi.do/s/AB12CD" → "AB12CD". */
export const sayIDoLinkId = (raw: string) => /^https?:\/\/(?:www\.)?sayi\.do\/s\/([A-Za-z0-9]{4,32})\/?$/i.exec(raw.trim())?.[1].toUpperCase() ?? null;

// ---------------------------------------------------------------------------------------------
// Small string helpers

export const levenshtein = (a: string, b: string) => {
    if (a === b) return 0;
    const row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        let previous = row[0];
        row[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const current = row[j];
            row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
            previous = current;
        }
    }
    return row[b.length];
};

// ---------------------------------------------------------------------------------------------
// The plan the preview shows and the import applies

export interface ImportIssue {
    level: "error" | "warning" | "info";
    message: string;
}

export interface ImportFieldChange {
    field: string;
    label: string;
    from: string | null;
    to: string | null;
    /** Replacing something already recorded (a name, an address, an RSVP) needs explicit confirmation. */
    needsConfirmation: boolean;
    /** Whether this change will be applied: always for additions, only when confirmed for overwrites. */
    applied: boolean;
}

export type ImportTarget<Matched extends string> =
    { kind: "new" } | { kind: "existing"; id: string; name: string; matchedBy: Matched; householdName?: string | null } | { kind: "skip"; reason: string };

export interface ImportSuggestion {
    id: string;
    name: string;
    detail: string | null;
    reason: string;
}

export interface ImportHouseholdPlan {
    /** Stable within one file: "link:<id>" for Say I Do parties, else "party:<name>". */
    key: string;
    name: string;
    /** Every party name used for this group in the file (more than one is flagged). */
    sourceNames: string[];
    /** Capitalisation fix for the name, if it needs one. */
    suggestedName: string | null;
    externalId: string | null;
    lines: number[];
    address: PostalAddress | null;
    /** The distinct addresses guests gave; more than one is a conflict to resolve. */
    addressChoices: AddressChoice[];
    addressConflict: boolean;
    target: ImportTarget<"link" | "name" | "guests" | "chosen">;
    action: "create" | "update" | "unchanged" | "skip";
    changes: ImportFieldChange[];
    suggestions: ImportSuggestion[];
    issues: ImportIssue[];
}

export interface ImportGuestPlan {
    /** "L<line>": stable for a file. */
    key: string;
    line: number;
    rawName: string;
    firstName: string;
    lastName: string;
    nameReview: string[];
    suggestedName: { firstName: string; lastName: string } | null;
    householdKey: string | null;
    /** Only an explicit Yes/No in the file; an empty Attending cell is no response. */
    rsvp: "attending" | "declined" | null;
    /** Informational: Say I Do's "Plus One Allowed" never removes a named guest. */
    plusOneAllowed: boolean | null;
    target: ImportTarget<"email" | "name" | "chosen">;
    action: "create" | "update" | "link" | "unchanged" | "skip";
    changes: ImportFieldChange[];
    suggestions: ImportSuggestion[];
    issues: ImportIssue[];
}

export interface ImportPlan {
    source: "sayido" | "csv";
    fileSha256: string;
    columns: { header: string; field: string | null }[];
    fileIssues: ImportIssue[];
    households: ImportHouseholdPlan[];
    guests: ImportGuestPlan[];
    /** Rows that can't be imported at all (no name, invalid email…). */
    errors: { line: number; name: string; message: string }[];
    events: { id: string; name: string; rsvpEnabled: boolean }[];
    /** Events new guests (and existing guests with no invitations) will be invited to. */
    inviteEventIds: string[];
    previousImports: { id: string; createdAt: string; actor: string }[];
    /** Versions (updated_at) of every existing record the plan touches, for the import to check. */
    basis: Record<string, string>;
    summary: ImportSummary;
}

export interface ImportSummary {
    rows: number;
    guests: Record<ImportGuestPlan["action"], number>;
    households: Record<ImportHouseholdPlan["action"], number>;
    errors: number;
    /** Names to look at before importing. */
    nameReview: number;
    /** Overwrites waiting for confirmation (not applied until confirmed). */
    unconfirmed: number;
    addressConflicts: number;
}

export interface ImportDecisions {
    households?: Record<
        string,
        {
            name?: string;
            /** null clears the address; omit to use the address from the file. */
            address?: PostalAddress | null;
            /** "new", "skip" or an existing household id. */
            target?: string;
            confirm?: string[];
        }
    >;
    guests?: Record<string, { firstName?: string; lastName?: string; target?: string; confirm?: string[] }>;
    /** Defaults to every event with RSVPs switched on. */
    inviteEventIds?: string[];
    rsvpSource?: "sayido" | "import";
}

export interface ImportReportRow {
    line: number;
    name: string;
    householdName: string | null;
    address: string | null;
    action: string;
    householdAction: string | null;
    guestId: string | null;
    householdId: string | null;
    notes: string[];
}

export interface ImportReport {
    id: string;
    createdAt: string;
    actor: string;
    source: "sayido" | "csv";
    fileName: string | null;
    summary: ImportSummary;
    rows: ImportReportRow[];
}

export interface ImportHistoryEntry {
    id: string;
    createdAt: string;
    actor: string;
    source: "sayido" | "csv";
    fileName: string | null;
    summary: ImportSummary;
}
