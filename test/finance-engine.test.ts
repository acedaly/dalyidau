// Household Finance's deterministic rules, without a database: amounts in cents, dates, CSV layouts,
// duplicate keys, possible duplicates, transfers, income and spending, and balance confidence.
import { describe, expect, it } from "vitest";
import { NAB_FILE_A, NAB_FILE_B, NAB_HEADERLESS, WESTPAC_FILE } from "../fixtures/finance/fixtures";
import { BUILTIN_CATEGORIES } from "../src/shared/finance/categories";
import { detectMapping, merchantKeyOf, parseRows, presetMapping } from "../src/shared/finance/csv-import";
import { detectDateFormat, monthEnd, monthStart, parseBankDate } from "../src/shared/finance/dates";
import {
    balanceView,
    impliedOpening,
    monthlySeries,
    periodTotals,
    possibleDuplicates,
    spendingByCategory,
    transferSuggestions,
} from "../src/shared/finance/ledger";
import { centsToDecimal, formatAud, parseCents, sumCents } from "../src/shared/finance/money";
import { kindLookup } from "../worker/finance/categories";
import { parseCsvRows } from "../worker/portal/csv";

const kindOf = kindLookup(BUILTIN_CATEGORIES);
const rowsOf = (text: string) => parseCsvRows(text);

describe("amounts in cents", () => {
    it("reads the ways banks write amounts, exactly", () => {
        const cases: [string, number][] = [
            ["-45.20", -4520],
            ["45.2", 4520],
            ["$1,234.50", 123450],
            ["(19.99)", -1999],
            ["45.20 DR", -4520],
            ["45.20 CR", 4520],
            ["-$0.05", -5],
            ["1234", 123400],
            [".5", 50],
            ["12.34-", -1234],
            ["0.10", 10],
            ["AUD 7.00", 700],
            ["−3.00", -300],
        ];
        for (const [text, cents] of cases) expect(parseCents(text), text).toEqual({ ok: true, cents });
    });

    it("refuses anything it can't read exactly, rather than rounding", () => {
        for (const text of ["12.345", "1,23.00", "abc", "1.2.3", "", "12,34", "$", "1e5"]) expect(parseCents(text).ok, text).toBe(false);
        expect(parseCents("", { emptyIsZero: true })).toEqual({ ok: true, cents: 0 });
    });

    it("sums and formats without floating-point drift", () => {
        // 0.1 + 0.2 in floating point is 0.30000000000000004; in cents it's 30.
        expect(sumCents([10, 20])).toBe(30);
        expect(sumCents(Array.from({ length: 1000 }, () => 1))).toBe(1000);
        expect(() => sumCents([0.5])).toThrow();
        expect(formatAud(123450)).toBe("$1,234.50");
        expect(formatAud(-4520)).toBe("−$45.20");
        expect(formatAud(500, { signed: true })).toBe("+$5.00");
        expect(centsToDecimal(-123405)).toBe("-1234.05");
        expect(centsToDecimal(7)).toBe("0.07");
    });
});

describe("dates", () => {
    it("parses each format strictly and rejects impossible dates", () => {
        expect(parseBankDate("02 Sep 26", "d MMM yy")).toBe("2026-09-02");
        expect(parseBankDate("2-Sep-2026", "d MMM yyyy")).toBe("2026-09-02");
        expect(parseBankDate("23/10/2026", "d/M/yyyy")).toBe("2026-10-23");
        expect(parseBankDate("10/23/2026", "M/d/yyyy")).toBe("2026-10-23");
        expect(parseBankDate("2026-10-23", "yyyy-MM-dd")).toBe("2026-10-23");
        expect(parseBankDate("20261023", "yyyyMMdd")).toBe("2026-10-23");
        expect(parseBankDate("31 Feb 26", "d MMM yy")).toBeNull();
        expect(parseBankDate("29/02/2027", "d/M/yyyy")).toBeNull();
        expect(parseBankDate("29/02/2028", "d/M/yyyy")).toBe("2028-02-29");
        expect(parseBankDate("23/10/2026", "M/d/yyyy")).toBeNull();
    });

    it("prefers day-first and says when a file could be read either way", () => {
        expect(detectDateFormat(["03/04/2026", "05/04/2026"])).toEqual({ format: "d/M/yyyy", ambiguous: true });
        expect(detectDateFormat(["03/04/2026", "25/04/2026"])).toEqual({ format: "d/M/yyyy", ambiguous: false });
        expect(detectDateFormat(["12 Sep 26"])).toEqual({ format: "d MMM yy", ambiguous: false });
    });

    it("works out month boundaries", () => {
        expect(monthStart("2026-01-15", -1)).toBe("2025-12-01");
        expect(monthStart("2026-11-30", 2)).toBe("2027-01-01");
        expect(monthEnd("2028-02-10")).toBe("2028-02-29");
    });
});

describe("CSV layouts", () => {
    it("finds NAB's columns by their header names, including merchant and account number", () => {
        const mapping = detectMapping(rowsOf(NAB_FILE_A).map((r) => r.cells))!;
        expect(mapping).toMatchObject({
            preset: "nab",
            hasHeader: true,
            dateColumn: 0,
            dateFormat: "d MMM yy",
            amountMode: "signed",
            amountColumn: 1,
            accountColumn: 2,
            fallbackDescriptionColumn: 4,
            descriptionColumns: [5],
            balanceColumn: 6,
            categoryColumn: 7,
            merchantColumn: 8,
        });
    });

    it("reads NAB's older layout without a header", () => {
        const mapping = detectMapping(rowsOf(NAB_HEADERLESS).map((r) => r.cells))!;
        expect(mapping).toMatchObject({ preset: "nab", hasHeader: false, descriptionColumns: [5], balanceColumn: 6 });
        const file = parseRows(rowsOf(NAB_HEADERLESS), mapping);
        expect(file.rows.every((r) => r.ok)).toBe(true);
        expect(file.headerLines).toBe(0);
    });

    it("reads separate debit and credit columns (Westpac)", () => {
        const mapping = detectMapping(rowsOf(WESTPAC_FILE).map((r) => r.cells))!;
        expect(mapping).toMatchObject({ preset: "westpac", amountMode: "debit_credit", dateFormat: "d/M/yyyy" });
        const file = parseRows(rowsOf(WESTPAC_FILE), mapping);
        expect(file.rows.map((r) => r.amountCents)).toEqual([210000, -5620]);
        expect(file.newestFirst).toBe(false);
        expect(
            presetMapping(
                "commbank",
                rowsOf(WESTPAC_FILE).map((r) => r.cells),
            ),
        ).toBeNull();
    });

    it("orders a newest-first file chronologically and keeps a bank's own order within a day", () => {
        const mapping = detectMapping(rowsOf(NAB_FILE_A).map((r) => r.cells))!;
        const file = parseRows(rowsOf(NAB_FILE_A), mapping);
        expect(file.newestFirst).toBe(true);
        expect(file.headerLines).toBe(1);
        const chronological = [...file.rows].sort((a, b) => a.position - b.position);
        expect(chronological.map((r) => r.bankBalanceCents)).toEqual([570000, 561565, 561115, 560665, 558766, 508766, 502556, 495416]);
        expect(file.accountEndings).toEqual(["4321"]);
    });

    it("gives two identical purchases on one day different duplicate keys", () => {
        const mapping = detectMapping(rowsOf(NAB_FILE_A).map((r) => r.cells))!;
        const coffees = parseRows(rowsOf(NAB_FILE_A), mapping).rows.filter((r) => r.description?.includes("CAFE NERO"));
        expect(coffees).toHaveLength(2);
        expect(new Set(coffees.map((r) => r.key)).size).toBe(2);
        expect(coffees.map((r) => r.key!.endsWith("|0") || r.key!.endsWith("|1"))).toEqual([true, true]);
    });

    it("keeps rows it can't read, each with a reason", () => {
        const mapping = detectMapping(rowsOf(NAB_FILE_B).map((r) => r.cells))!;
        const file = parseRows(rowsOf(NAB_FILE_B), mapping);
        const bad = file.rows.filter((r) => !r.ok);
        expect(bad.map((r) => [r.line, r.error])).toEqual([
            [3, '"31 Feb 26" isn\'t a date in the chosen format'],
            [5, "The amount is zero"],
        ]);
        expect(file.rows).toHaveLength(7);
        // A short row is refused with its column count, not padded.
        const short = parseRows(rowsOf(`${NAB_FILE_A.split("\n")[0]}\n12 Sep 26,-1.00`), mapping);
        expect(short.rows[0].error).toMatch(/has 2 columns/);
    });

    it("never stores the account number: only its last digits are compared", () => {
        const mapping = detectMapping(rowsOf(NAB_FILE_A).map((r) => r.cells))!;
        const file = parseRows(rowsOf(NAB_FILE_A), mapping);
        expect(JSON.stringify(file.rows)).not.toContain("000004321");
    });

    it("groups a merchant's transactions under one key", () => {
        expect(merchantKeyOf("WOOLWORTHS 1234 SYDNEY")).toBe("WOOLWORTHS SYDNEY");
        expect(merchantKeyOf("Woolworths")).toBe("WOOLWORTHS");
        expect(merchantKeyOf("VISA PURCHASE NETFLIX.COM MELBOURNE AU")).toBe("NETFLIX COM MELBOURNE");
        expect(merchantKeyOf("1234 5678")).toBeNull();
    });
});

describe("possible duplicates", () => {
    const row = { line: 2, postedOn: "2026-09-12", amountCents: -7140, description: "AMPOL FOODARY 3 SURRY HILLS" };
    it("flags the same amount within three days with similar words, or a manual entry", () => {
        const pending = { id: "t1", postedOn: "2026-09-11", amountCents: -7140, description: "AMPOL SURRY HILLS PENDING", source: "import" as const };
        const manual = { id: "t2", postedOn: "2026-09-13", amountCents: -7140, description: "Fuel", source: "manual" as const };
        expect(possibleDuplicates([row], [pending]).get(2)).toBe("t1");
        expect(possibleDuplicates([row], [manual]).get(2)).toBe("t2");
    });
    it("ignores different amounts, distant dates and unrelated merchants", () => {
        const other = { id: "t3", postedOn: "2026-09-12", amountCents: -7140, description: "KMART BROADWAY", source: "import" as const };
        const later = { id: "t4", postedOn: "2026-09-20", amountCents: -7140, description: "AMPOL FOODARY 3", source: "import" as const };
        const amount = { id: "t5", postedOn: "2026-09-12", amountCents: -7141, description: "AMPOL FOODARY 3", source: "import" as const };
        expect(possibleDuplicates([row], [other, later, amount]).size).toBe(0);
    });
    it("matches each ledger transaction to at most one row", () => {
        const one = { id: "t1", postedOn: "2026-09-12", amountCents: -450, description: "CAFE NERO", source: "import" as const };
        const rows = [
            { line: 2, postedOn: "2026-09-12", amountCents: -450, description: "CAFE NERO SYDNEY" },
            { line: 3, postedOn: "2026-09-12", amountCents: -450, description: "CAFE NERO SYDNEY" },
        ];
        expect(possibleDuplicates(rows, [one]).size).toBe(1);
    });
});

describe("transfers", () => {
    it("pairs money out and the same amount in another account within three days, closest first", () => {
        const lines = [
            { id: "out1", accountId: "everyday", postedOn: "2026-09-08", amountCents: -50000, description: "ONLINE TRANSFER TO SAVINGS" },
            { id: "in1", accountId: "savings", postedOn: "2026-09-08", amountCents: 50000, description: "TRANSFER FROM EVERYDAY" },
            { id: "in2", accountId: "savings", postedOn: "2026-09-10", amountCents: 50000, description: "INTEREST" },
            { id: "same", accountId: "everyday", postedOn: "2026-09-08", amountCents: 50000, description: "REFUND" },
            { id: "far", accountId: "card", postedOn: "2026-09-20", amountCents: 50000, description: "PAYMENT" },
        ];
        expect(transferSuggestions(lines)).toEqual([{ outId: "out1", inId: "in1", days: 0 }]);
        expect(transferSuggestions(lines, new Set(["out1:in1"]))).toEqual([{ outId: "out1", inId: "in2", days: 2 }]);
    });
});

describe("income, spending and balances", () => {
    const lines = [
        { amountCents: 320000, postedOn: "2026-09-01", categoryId: "salary", isTransfer: false },
        { amountCents: -8435, postedOn: "2026-09-02", categoryId: "groceries", isTransfer: false },
        // A refund in Groceries reduces grocery spending; it isn't income.
        { amountCents: 1000, postedOn: "2026-09-03", categoryId: "groceries", isTransfer: false },
        { amountCents: -50000, postedOn: "2026-09-08", categoryId: null, isTransfer: true },
        { amountCents: 50000, postedOn: "2026-09-08", categoryId: null, isTransfer: true },
        // A credit-card purchase is spending; its repayment (a transfer) is not counted again.
        { amountCents: -19900, postedOn: "2026-09-03", categoryId: "shopping", isTransfer: false },
        { amountCents: -30000, postedOn: "2026-09-15", categoryId: null, isTransfer: true },
        { amountCents: 30000, postedOn: "2026-09-16", categoryId: null, isTransfer: true },
        { amountCents: -1899, postedOn: "2026-10-05", categoryId: null, isTransfer: false },
    ];

    it("never counts transfers, nets refunds, and counts uncategorised by direction", () => {
        expect(periodTotals(lines, kindOf)).toEqual({
            incomeCents: 320000,
            expenseCents: 8435 - 1000 + 19900 + 1899,
            netCents: 320000 - 29234,
            transferCount: 4,
            uncategorisedCount: 1,
        });
        expect(spendingByCategory(lines, kindOf)).toEqual([
            { categoryId: "shopping", cents: 19900, count: 1 },
            { categoryId: "groceries", cents: 7435, count: 2 },
            { categoryId: null, cents: 1899, count: 1 },
        ]);
        expect(monthlySeries(lines, ["2026-08", "2026-09", "2026-10"], kindOf).map((m) => m.expenseCents)).toEqual([0, 27335, 1899]);
    });

    it("says how sure it is of a balance", () => {
        const base = { openingCents: 250000, openingOn: "2026-09-01", sinceOpeningCents: 245416 };
        expect(balanceView({ ...base, openingCents: null, openingOn: null, bankCheck: null, reconciliation: null })).toMatchObject({
            status: "incomplete",
            balanceCents: null,
        });
        expect(balanceView({ ...base, bankCheck: null, reconciliation: null })).toMatchObject({ status: "calculated", balanceCents: 495416 });
        expect(balanceView({ ...base, bankCheck: { on: "2026-09-12", bankCents: 495416, calculatedCents: 495416 }, reconciliation: null })).toMatchObject({
            status: "matches_bank",
            checkedOn: "2026-09-12",
        });
        expect(balanceView({ ...base, bankCheck: { on: "2026-09-12", bankCents: 495516, calculatedCents: 495416 }, reconciliation: null })).toMatchObject({
            status: "mismatch",
            differenceCents: 100,
        });
        // The most recent check wins.
        expect(
            balanceView({
                ...base,
                bankCheck: { on: "2026-09-12", bankCents: 1, calculatedCents: 2 },
                reconciliation: { asOf: "2026-09-30", statementCents: 5, calculatedCents: 5 },
            }),
        ).toMatchObject({ status: "reconciled", checkedAgainst: "statement" });
    });

    it("works out the starting balance a file implies", () => {
        expect(
            impliedOpening([
                { position: 1, postedOn: "2026-09-02", amountCents: -8435, bankBalanceCents: 561565 },
                { position: 0, postedOn: "2026-09-01", amountCents: 320000, bankBalanceCents: 570000 },
            ]),
        ).toEqual({ on: "2026-09-01", cents: 250000 });
        expect(impliedOpening([{ position: 0, postedOn: "2026-09-01", amountCents: 1, bankBalanceCents: null }])).toBeNull();
    });
});
