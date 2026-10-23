// The ledger's rules, in one place and without a database, so they can be tested exactly:
// what counts as income or spending, balances and how sure we are of them, possible duplicates,
// and transfer suggestions. All amounts are integer cents.
import type { CategoryKind } from "./categories";
import { normaliseDescription } from "./csv-import";
import { daysApart, monthKey } from "./dates";
import { sumCents } from "./money";

// --- Income and spending --------------------------------------------------------------------------

export interface LedgerLine {
    amountCents: number;
    postedOn: string;
    categoryId: string | null;
    isTransfer: boolean;
}

export type Flow = "income" | "expense" | "transfer";

/**
 * Transfers are neither income nor spending. A categorised transaction counts on its category's side,
 * so a refund in Groceries reduces grocery spending rather than counting as income. An uncategorised
 * one counts by its direction until someone categorises it.
 */
export const flowOf = (line: LedgerLine, kindOf: (categoryId: string) => CategoryKind | undefined): Flow => {
    if (line.isTransfer) return "transfer";
    const kind = line.categoryId ? kindOf(line.categoryId) : undefined;
    if (kind) return kind;
    return line.amountCents > 0 ? "income" : "expense";
};

export interface PeriodTotals {
    incomeCents: number;
    expenseCents: number;
    netCents: number;
    transferCount: number;
    uncategorisedCount: number;
}

export function periodTotals(lines: readonly LedgerLine[], kindOf: (categoryId: string) => CategoryKind | undefined): PeriodTotals {
    const income: number[] = [];
    const expense: number[] = [];
    let transferCount = 0;
    let uncategorisedCount = 0;
    for (const line of lines) {
        const flow = flowOf(line, kindOf);
        if (flow === "transfer") transferCount++;
        else {
            if (!line.categoryId) uncategorisedCount++;
            if (flow === "income") income.push(line.amountCents);
            else expense.push(-line.amountCents);
        }
    }
    const incomeCents = sumCents(income);
    const expenseCents = sumCents(expense);
    return { incomeCents, expenseCents, netCents: incomeCents - expenseCents, transferCount, uncategorisedCount };
}

/** Spending per category (net of refunds), largest first. Uncategorised spending is `null`. */
export function spendingByCategory(lines: readonly LedgerLine[], kindOf: (categoryId: string) => CategoryKind | undefined) {
    const totals = new Map<string | null, { cents: number; count: number }>();
    for (const line of lines) {
        if (flowOf(line, kindOf) !== "expense") continue;
        const key = line.categoryId;
        const entry = totals.get(key) ?? { cents: 0, count: 0 };
        entry.cents += -line.amountCents;
        entry.count++;
        totals.set(key, entry);
    }
    return [...totals.entries()].map(([categoryId, v]) => ({ categoryId, cents: v.cents, count: v.count })).sort((a, b) => b.cents - a.cents);
}

/** Income and spending for each month in `months` (YYYY-MM keys), in order. */
export function monthlySeries(lines: readonly LedgerLine[], months: readonly string[], kindOf: (categoryId: string) => CategoryKind | undefined) {
    const byMonth = new Map<string, LedgerLine[]>(months.map((m) => [m, []]));
    for (const line of lines) byMonth.get(monthKey(line.postedOn))?.push(line);
    return months.map((month) => {
        const totals = periodTotals(byMonth.get(month) ?? [], kindOf);
        return { month, incomeCents: totals.incomeCents, expenseCents: totals.expenseCents, netCents: totals.netCents };
    });
}

// --- Balances ---------------------------------------------------------------------------------------

export type BalanceStatus = "incomplete" | "calculated" | "matches_bank" | "reconciled" | "mismatch";

export interface BalanceInput {
    openingCents: number | null;
    openingOn: string | null;
    /** Sum of every transaction dated on or after openingOn. */
    sinceOpeningCents: number;
    /** The latest day an import reported the bank's balance, and our balance at the end of that day. */
    bankCheck: { on: string; bankCents: number; calculatedCents: number } | null;
    /** The latest reconciliation against a statement. */
    reconciliation: { asOf: string; statementCents: number; calculatedCents: number } | null;
}

export interface BalanceView {
    status: BalanceStatus;
    /** Null when there's no starting balance: never shown as zero. */
    balanceCents: number | null;
    /** What the check compared with, when there was one. */
    checkedOn: string | null;
    checkedAgainst: "bank" | "statement" | null;
    differenceCents: number | null;
}

/**
 * How sure we are of a balance. Without a starting balance it's incomplete. Otherwise the most recent
 * check wins: a statement reconciliation or the bank's own running balance in an import. Matching it
 * makes the balance confirmed as at that date; differing is a mismatch, with the difference shown.
 * With no check at all it's calculated: a sum of what has been imported, not confirmed.
 */
export function balanceView(input: BalanceInput): BalanceView {
    if (input.openingCents === null || input.openingOn === null)
        return { status: "incomplete", balanceCents: null, checkedOn: null, checkedAgainst: null, differenceCents: null };
    const balanceCents = input.openingCents + input.sinceOpeningCents;
    const bank = input.bankCheck;
    const statement = input.reconciliation;
    const useBank = bank && (!statement || bank.on > statement.asOf);
    if (useBank) {
        const difference = bank.bankCents - bank.calculatedCents;
        return {
            status: difference === 0 ? "matches_bank" : "mismatch",
            balanceCents,
            checkedOn: bank.on,
            checkedAgainst: "bank",
            differenceCents: difference,
        };
    }
    if (statement) {
        const difference = statement.statementCents - statement.calculatedCents;
        return {
            status: difference === 0 ? "reconciled" : "mismatch",
            balanceCents,
            checkedOn: statement.asOf,
            checkedAgainst: "statement",
            differenceCents: difference,
        };
    }
    return { status: "calculated", balanceCents, checkedOn: null, checkedAgainst: null, differenceCents: null };
}

/**
 * The starting balance a file implies: the bank's balance after its earliest transaction, less that
 * transaction. Offered to the person, never applied on its own.
 */
export function impliedOpening(rows: readonly { position: number; postedOn: string; amountCents: number; bankBalanceCents: number | null }[]) {
    const first = [...rows].sort((a, b) => a.position - b.position)[0];
    if (!first || first.bankBalanceCents === null) return null;
    return { on: first.postedOn, cents: first.bankBalanceCents - first.amountCents };
}

// --- Possible duplicates ------------------------------------------------------------------------------

const tokens = (text: string) =>
    new Set(
        normaliseDescription(text)
            .split(/[\s./-]+/)
            .filter((t) => t.length > 1 && !/\d/.test(t)),
    );

/** Share of distinctive words two descriptions have in common (0–1). */
export const similarity = (a: string, b: string) => {
    const x = tokens(a);
    const y = tokens(b);
    if (!x.size || !y.size) return 0;
    let shared = 0;
    for (const t of x) if (y.has(t)) shared++;
    return shared / (x.size + y.size - shared);
};

export interface DuplicateCandidate {
    id: string;
    postedOn: string;
    amountCents: number;
    description: string;
    source: "import" | "manual";
}

export const DUPLICATE_WINDOW_DAYS = 3;

/**
 * Rows that may already be in the ledger under a different description or date (a pending
 * transaction that posted later, or one someone entered by hand): the same amount within three days,
 * and either similar words or a manual entry. Each ledger transaction matches at most one row, the
 * closest. These are only flagged: a person decides.
 */
export function possibleDuplicates(
    rows: readonly { line: number; postedOn: string; amountCents: number; description: string }[],
    ledger: readonly DuplicateCandidate[],
): Map<number, string> {
    const pairs: { line: number; id: string; days: number; score: number }[] = [];
    for (const row of rows) {
        for (const t of ledger) {
            if (t.amountCents !== row.amountCents) continue;
            const days = daysApart(t.postedOn, row.postedOn);
            if (days > DUPLICATE_WINDOW_DAYS) continue;
            const score = similarity(t.description, row.description);
            if (t.source !== "manual" && score < 0.34) continue;
            pairs.push({ line: row.line, id: t.id, days, score });
        }
    }
    pairs.sort((a, b) => a.days - b.days || b.score - a.score || a.line - b.line);
    const matched = new Map<number, string>();
    const used = new Set<string>();
    for (const pair of pairs) {
        if (matched.has(pair.line) || used.has(pair.id)) continue;
        matched.set(pair.line, pair.id);
        used.add(pair.id);
    }
    return matched;
}

// --- Transfers ----------------------------------------------------------------------------------------

export interface TransferCandidate {
    id: string;
    accountId: string;
    postedOn: string;
    amountCents: number;
    description: string;
}

export const TRANSFER_WINDOW_DAYS = 3;
const TRANSFER_WORDS = /\b(TRANSFER|TFR|XFER|PAYMENT|REPAYMENT|BPAY|INTERNET|ONLINE|OSKO|PAYID|FROM|TO)\b/;

/**
 * Pairs of money out of one account and the same amount into another of the household's accounts
 * within three days: probably a transfer (a savings top-up, a credit-card repayment). Suggestions
 * only, closest first, each transaction in at most one; dismissed pairs aren't suggested again.
 */
export function transferSuggestions(lines: readonly TransferCandidate[], dismissed: ReadonlySet<string> = new Set()) {
    const outs = lines.filter((l) => l.amountCents < 0);
    const ins = lines.filter((l) => l.amountCents > 0);
    const byAmount = new Map<number, TransferCandidate[]>();
    for (const line of ins) byAmount.set(line.amountCents, [...(byAmount.get(line.amountCents) ?? []), line]);
    const pairs: { out: TransferCandidate; in: TransferCandidate; days: number; worded: number }[] = [];
    for (const out of outs) {
        for (const incoming of byAmount.get(-out.amountCents) ?? []) {
            if (incoming.accountId === out.accountId) continue;
            const days = daysApart(out.postedOn, incoming.postedOn);
            if (days > TRANSFER_WINDOW_DAYS || dismissed.has(`${out.id}:${incoming.id}`)) continue;
            const worded =
                Number(TRANSFER_WORDS.test(normaliseDescription(out.description))) + Number(TRANSFER_WORDS.test(normaliseDescription(incoming.description)));
            pairs.push({ out, in: incoming, days, worded });
        }
    }
    pairs.sort((a, b) => a.days - b.days || b.worded - a.worded || a.out.id.localeCompare(b.out.id));
    const used = new Set<string>();
    const chosen: { outId: string; inId: string; days: number }[] = [];
    for (const pair of pairs) {
        if (used.has(pair.out.id) || used.has(pair.in.id)) continue;
        used.add(pair.out.id);
        used.add(pair.in.id);
        chosen.push({ outId: pair.out.id, inId: pair.in.id, days: pair.days });
    }
    return chosen;
}
