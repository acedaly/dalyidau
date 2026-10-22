// Reading bank CSV exports. Deterministic: a layout (preset or the person's own mapping) says which
// column holds what, every row is checked, and a row that can't be read is kept and shown with its
// reason, never dropped. Nothing here guesses with a model.
//
// NAB is the first preset. Its Internet Banking export has been seen in two layouts: with a header
// row (Date, Amount, Account Number, , Transaction Type, Transaction Details, Balance, Category,
// Merchant Name) and an older one without (date, amount, two empty columns, type, details, balance).
// Columns are found by their header names, so an extra or reordered column doesn't break it. The
// account-number column is only compared with the account's last digits; it is never stored.
import { z } from "zod";
import { DATE_FORMATS, type DateFormat, detectDateFormat, parseBankDate } from "./dates";
import { parseCents } from "./money";

export const PRESETS = ["nab", "commbank", "westpac", "anz", "ing", "custom"] as const;
export type PresetId = (typeof PRESETS)[number];

export const PRESET_LABELS: Record<PresetId, string> = {
    nab: "NAB",
    commbank: "Commonwealth Bank",
    westpac: "Westpac",
    anz: "ANZ",
    ing: "ING",
    custom: "Another bank (choose columns)",
};

export const LIMITS = {
    fileBytes: 2_000_000,
    rows: 5_000,
    columns: 40,
} as const;

const column = z
    .number()
    .int()
    .min(0)
    .max(LIMITS.columns - 1);

export const importMappingSchema = z
    .object({
        preset: z.enum(PRESETS),
        hasHeader: z.boolean(),
        /** Lines before the header (or the first transaction), e.g. an account title line. */
        skipLines: z.number().int().min(0).max(20).default(0),
        dateColumn: column,
        dateFormat: z.enum(DATE_FORMATS),
        descriptionColumns: z.array(column).min(1).max(4),
        /** Used when the description columns are empty (NAB's transaction type). */
        fallbackDescriptionColumn: column.nullable().default(null),
        merchantColumn: column.nullable().default(null),
        amountMode: z.enum(["signed", "debit_credit"]),
        amountColumn: column.nullable().default(null),
        debitColumn: column.nullable().default(null),
        creditColumn: column.nullable().default(null),
        /** For exports that show money out as positive (some credit cards). */
        invertAmounts: z.boolean().default(false),
        balanceColumn: column.nullable().default(null),
        categoryColumn: column.nullable().default(null),
        /** Only compared with the account's last digits. Never stored. */
        accountColumn: column.nullable().default(null),
    })
    .strict()
    .superRefine((m, ctx) => {
        if (m.amountMode === "signed" && m.amountColumn === null) ctx.addIssue({ code: "custom", path: ["amountColumn"], message: "Choose the amount column" });
        if (m.amountMode === "debit_credit" && (m.debitColumn === null || m.creditColumn === null))
            ctx.addIssue({ code: "custom", path: ["debitColumn"], message: "Choose both the debit and credit columns" });
    });
export type ImportMapping = z.infer<typeof importMappingSchema>;

// --- Presets ----------------------------------------------------------------------------------------

interface HeaderPreset {
    /** Header names (lower case) for each field; the first name found wins. */
    date: string[];
    description: string[];
    fallbackDescription?: string[];
    merchant?: string[];
    amount?: string[];
    debit?: string[];
    credit?: string[];
    balance?: string[];
    category?: string[];
    account?: string[];
}

const HEADER_PRESETS: Partial<Record<PresetId, HeaderPreset>> = {
    nab: {
        date: ["date"],
        description: ["transaction details", "details", "description", "narrative"],
        fallbackDescription: ["transaction type"],
        merchant: ["merchant name"],
        amount: ["amount"],
        balance: ["balance"],
        category: ["category"],
        account: ["account number"],
    },
    westpac: {
        date: ["date"],
        description: ["narrative", "description"],
        debit: ["debit amount", "debit"],
        credit: ["credit amount", "credit"],
        balance: ["balance"],
        category: ["categories", "category"],
        account: ["bank account"],
    },
    ing: {
        date: ["date"],
        description: ["description"],
        debit: ["debit"],
        credit: ["credit"],
        balance: ["balance"],
    },
    commbank: { date: ["date"], description: ["description"], amount: ["amount"], balance: ["balance"] },
    anz: { date: ["date"], description: ["description", "details"], amount: ["amount"], balance: ["balance"] },
};

/** Layouts without a header row, by preset: [date, amount, description columns, balance]. */
const HEADERLESS: Partial<Record<PresetId, { columns: number; mapping: Omit<ImportMapping, "preset" | "dateFormat"> }>> = {
    nab: {
        columns: 7,
        mapping: {
            hasHeader: false,
            skipLines: 0,
            dateColumn: 0,
            descriptionColumns: [5],
            fallbackDescriptionColumn: 4,
            merchantColumn: null,
            amountMode: "signed",
            amountColumn: 1,
            debitColumn: null,
            creditColumn: null,
            invertAmounts: false,
            balanceColumn: 6,
            categoryColumn: null,
            accountColumn: null,
        },
    },
    commbank: {
        columns: 4,
        mapping: {
            hasHeader: false,
            skipLines: 0,
            dateColumn: 0,
            descriptionColumns: [2],
            fallbackDescriptionColumn: null,
            merchantColumn: null,
            amountMode: "signed",
            amountColumn: 1,
            debitColumn: null,
            creditColumn: null,
            invertAmounts: false,
            balanceColumn: 3,
            categoryColumn: null,
            accountColumn: null,
        },
    },
    anz: {
        columns: 3,
        mapping: {
            hasHeader: false,
            skipLines: 0,
            dateColumn: 0,
            descriptionColumns: [2],
            fallbackDescriptionColumn: null,
            merchantColumn: null,
            amountMode: "signed",
            amountColumn: 1,
            debitColumn: null,
            creditColumn: null,
            invertAmounts: false,
            balanceColumn: null,
            categoryColumn: null,
            accountColumn: null,
        },
    },
};

const find = (header: string[], names: string[] | undefined) => {
    if (!names) return null;
    for (const name of names) {
        const index = header.indexOf(name);
        if (index >= 0) return index;
    }
    return null;
};

const datesIn = (rows: string[][], index: number) => rows.map((r) => r[index] ?? "").filter((v) => v.trim() !== "");

/** A preset's mapping for this file, or null when its columns aren't there. */
export function presetMapping(preset: PresetId, rows: string[][]): ImportMapping | null {
    if (!rows.length) return null;
    const header = rows[0].map((h) => h.trim().toLowerCase());
    const spec = HEADER_PRESETS[preset];
    if (spec) {
        const date = find(header, spec.date);
        const description = find(header, spec.description);
        const amount = find(header, spec.amount);
        const debit = find(header, spec.debit);
        const credit = find(header, spec.credit);
        const usable = date !== null && description !== null && (spec.amount ? amount !== null : debit !== null && credit !== null);
        if (usable) {
            const { format } = detectDateFormat(datesIn(rows.slice(1, 200), date));
            if (format)
                return {
                    preset,
                    hasHeader: true,
                    skipLines: 0,
                    dateColumn: date,
                    dateFormat: format,
                    descriptionColumns: [description],
                    fallbackDescriptionColumn: find(header, spec.fallbackDescription),
                    merchantColumn: find(header, spec.merchant),
                    amountMode: spec.amount ? "signed" : "debit_credit",
                    amountColumn: spec.amount ? amount : null,
                    debitColumn: spec.amount ? null : debit,
                    creditColumn: spec.amount ? null : credit,
                    invertAmounts: false,
                    balanceColumn: find(header, spec.balance),
                    categoryColumn: find(header, spec.category),
                    accountColumn: find(header, spec.account),
                };
        }
    }
    const headerless = HEADERLESS[preset];
    if (headerless) {
        const widths = rows.slice(0, 50).map((r) => r.length);
        if (widths.every((w) => w >= headerless.columns)) {
            const { format } = detectDateFormat(datesIn(rows.slice(0, 200), headerless.mapping.dateColumn));
            if (format) return { preset, dateFormat: format, ...headerless.mapping };
        }
    }
    return null;
}

/** The first preset whose layout fits, trying `preferred` (the account's last one) first. */
export function detectMapping(rows: string[][], preferred?: PresetId | null): ImportMapping | null {
    const order = [...new Set([preferred, "nab", "westpac", "ing", "commbank", "anz"].filter((p): p is PresetId => !!p && p !== "custom"))];
    for (const preset of order) {
        const mapping = presetMapping(preset, rows);
        if (mapping) return mapping;
    }
    return null;
}

// --- Rows ---------------------------------------------------------------------------------------------

export interface ParsedRow {
    line: number;
    /** Chronological order (0 = earliest). */
    position: number;
    ok: boolean;
    error: string | null;
    postedOn: string | null;
    amountCents: number | null;
    description: string | null;
    merchant: string | null;
    merchantKey: string | null;
    bankCategory: string | null;
    bankBalanceCents: number | null;
    /** The duplicate key before hashing (account id is added by the Worker). Valid rows only. */
    key: string | null;
}

export interface ParsedFile {
    rows: ParsedRow[];
    /** Structural lines that aren't transactions (a header, skipped title lines). Counted, not hidden. */
    headerLines: number;
    newestFirst: boolean;
    warnings: string[];
    /** Account-number digits seen in the file (only the last four), for the hint check. */
    accountEndings: string[];
}

const clean = (value: string | undefined) => (value ?? "").replace(/\s+/g, " ").trim();

/** Upper case, single spaces: how a description is compared for duplicates. Digits are kept. */
export const normaliseDescription = (text: string) =>
    text
        .toUpperCase()
        .replace(/[^\p{L}\p{N}&@#*./-]+/gu, " ")
        .replace(/\s+/g, " ")
        .trim();

const NOISE = new Set([
    "EFTPOS",
    "VISA",
    "MASTERCARD",
    "DEBIT",
    "CREDIT",
    "PURCHASE",
    "PURCH",
    "POS",
    "CARD",
    "CARDS",
    "TAP",
    "AND",
    "PAY",
    "PAYPASS",
    "PAYWAVE",
    "ONLINE",
    "DIRECT",
    "TRANSACTION",
    "DETAILS",
    "PENDING",
    "VALUE",
    "DATE",
    "AU",
    "AUS",
    "AUSTRALIA",
    "NSW",
    "VIC",
    "QLD",
    "ACT",
    "SA",
    "WA",
    "TAS",
    "NT",
    "AUD",
    "INT",
    "LTD",
    "PTY",
]);

/**
 * A short, stable key for a merchant ("WOOLWORTHS 1234 SYDNEY NS" → "WOOLWORTHS"), used to offer
 * "categorise the others like this". A heuristic for grouping only: it never decides anything itself.
 */
export function merchantKeyOf(text: string): string | null {
    const tokens = normaliseDescription(text)
        .replace(/[./-]/g, " ")
        .split(" ")
        .filter((t) => t.length > 1 && !/\d/.test(t) && !/^X+$/.test(t) && !NOISE.has(t.replace(/[*#@&]/g, "")));
    const key = tokens.slice(0, 3).join(" ").replace(/[*#@]/g, "").trim();
    return key ? key.slice(0, 200) : null;
}

/** "WOOLWORTHS 1234 SYDNEY" → "Woolworths 1234 Sydney": the description, tidied for display. */
export const displayMerchant = (text: string) =>
    clean(text)
        .toLowerCase()
        .replace(/\b(\p{L})/gu, (c) => c.toUpperCase())
        .slice(0, 200);

/** Reads every row of a file with a mapping. `rows` are CSV rows with their line numbers. */
export function parseRows(rows: { cells: string[]; line: number }[], mapping: ImportMapping): ParsedFile {
    const warnings: string[] = [];
    const skip = mapping.skipLines + (mapping.hasHeader ? 1 : 0);
    const body = rows.slice(skip);
    const needed =
        1 +
        Math.max(
            mapping.dateColumn,
            ...mapping.descriptionColumns,
            mapping.amountMode === "signed" ? (mapping.amountColumn ?? 0) : Math.max(mapping.debitColumn ?? 0, mapping.creditColumn ?? 0),
        );
    const endings = new Set<string>();

    const parsed = body.map((row, index): ParsedRow & { fileIndex: number } => {
        const cells = row.cells;
        const base = {
            fileIndex: index,
            line: row.line,
            position: 0,
            postedOn: null,
            amountCents: null,
            description: null,
            merchant: null,
            merchantKey: null,
            bankCategory: null,
            bankBalanceCents: null,
            key: null,
        };
        const fail = (error: string, partial: Partial<ParsedRow> = {}) => ({ ...base, ...partial, ok: false, error });
        if (cells.length < needed) return fail(`This row has ${cells.length} column${cells.length === 1 ? "" : "s"}; the layout needs ${needed}`);

        const postedOn = parseBankDate(cells[mapping.dateColumn] ?? "", mapping.dateFormat as DateFormat);
        let description = clean(
            mapping.descriptionColumns
                .map((i) => clean(cells[i]))
                .filter(Boolean)
                .join(" "),
        );
        if (!description && mapping.fallbackDescriptionColumn !== null) description = clean(cells[mapping.fallbackDescriptionColumn]);
        description = description.slice(0, 500);
        if (!postedOn)
            return fail(`"${clean(cells[mapping.dateColumn]).slice(0, 30)}" isn't a date in the chosen format`, { description: description || null });

        let amount: number;
        if (mapping.amountMode === "signed") {
            const result = parseCents(cells[mapping.amountColumn!] ?? "");
            if (!result.ok) return fail(result.reason, { postedOn, description: description || null });
            amount = result.cents;
        } else {
            const debit = parseCents(cells[mapping.debitColumn!] ?? "", { emptyIsZero: true });
            const credit = parseCents(cells[mapping.creditColumn!] ?? "", { emptyIsZero: true });
            if (!debit.ok) return fail(`Debit: ${debit.reason}`, { postedOn, description: description || null });
            if (!credit.ok) return fail(`Credit: ${credit.reason}`, { postedOn, description: description || null });
            if (debit.cents !== 0 && credit.cents !== 0) return fail("Both a debit and a credit on one row", { postedOn, description: description || null });
            // Some banks write debits as negative numbers, some as positive: either way it's money out.
            amount = credit.cents !== 0 ? Math.abs(credit.cents) : -Math.abs(debit.cents);
        }
        if (mapping.invertAmounts) amount = -amount;
        if (amount === 0) return fail("The amount is zero", { postedOn, description: description || null });
        if (!description) return fail("No description", { postedOn, amountCents: amount });

        let balance: number | null = null;
        if (mapping.balanceColumn !== null && clean(cells[mapping.balanceColumn])) {
            const result = parseCents(cells[mapping.balanceColumn] ?? "");
            if (!result.ok) return fail(`Balance: ${result.reason}`, { postedOn, amountCents: amount, description });
            balance = result.cents;
        }
        if (mapping.accountColumn !== null) {
            const digits = (cells[mapping.accountColumn] ?? "").replace(/\D/g, "");
            if (digits.length >= 2) endings.add(digits.slice(-4));
        }
        const merchantText = mapping.merchantColumn !== null ? clean(cells[mapping.merchantColumn]) : "";
        const merchant = merchantText ? merchantText.slice(0, 200) : null;
        return {
            ...base,
            ok: true,
            error: null,
            postedOn,
            amountCents: amount,
            description,
            merchant,
            merchantKey: merchantKeyOf(merchant ?? description),
            bankCategory: mapping.categoryColumn !== null ? clean(cells[mapping.categoryColumn]).slice(0, 80) || null : null,
            bankBalanceCents: balance,
        };
    });

    // Banks sort newest-first or oldest-first. Count the direction between consecutive dated rows.
    let down = 0;
    let up = 0;
    const dated = parsed.filter((r) => r.postedOn);
    for (let i = 1; i < dated.length; i++) {
        if (dated[i].postedOn! < dated[i - 1].postedOn!) down++;
        else if (dated[i].postedOn! > dated[i - 1].postedOn!) up++;
    }
    const newestFirst = down > up;
    if (down > 0 && up > 0) warnings.push("The rows aren't in date order. Each day's transactions are kept in the order the file lists them.");

    // Chronological position: by date, and within a day in the bank's own order (reversed for newest-first).
    // Rows without a date go last, in file order (they're never imported).
    const byFile = (a: { fileIndex: number }, b: { fileIndex: number }) => (newestFirst ? b.fileIndex - a.fileIndex : a.fileIndex - b.fileIndex);
    const chronological = [
        ...dated.sort((a, b) => (a.postedOn !== b.postedOn ? (a.postedOn! < b.postedOn! ? -1 : 1) : byFile(a, b))),
        ...parsed.filter((r) => !r.postedOn).sort((a, b) => a.fileIndex - b.fileIndex),
    ];
    const occurrences = new Map<string, number>();
    chronological.forEach((row, position) => {
        row.position = position;
        if (!row.ok) return;
        const base = `${row.postedOn}|${row.amountCents}|${normaliseDescription(row.description!)}`;
        const n = occurrences.get(base) ?? 0;
        occurrences.set(base, n + 1);
        row.key = `${base}|${n}`;
    });

    return {
        rows: parsed.map(({ fileIndex: _, ...row }) => row),
        headerLines: Math.min(skip, rows.length),
        newestFirst,
        warnings,
        accountEndings: [...endings],
    };
}
