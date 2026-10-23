// Household Finance: shapes shared by the Worker and the portal pages, and the validation for every
// write. Amounts are integer cents throughout.
import { z } from "zod";
import type { CategoryDef } from "./categories";
import { type ImportMapping, type PresetId, importMappingSchema } from "./csv-import";
import type { BalanceView, PeriodTotals } from "./ledger";
import { MAX_CENTS } from "./money";

export const ACCOUNT_KINDS = ["transaction", "savings", "credit_card", "cash", "loan"] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

export const ACCOUNT_KIND_LABELS: Record<AccountKind, string> = {
    transaction: "Everyday account",
    savings: "Savings account",
    credit_card: "Credit card",
    cash: "Cash",
    loan: "Loan or liability",
};

/** Accounts whose balance is usually money owed (shown as "owed" when negative). */
export const LIABILITY_KINDS: ReadonlySet<AccountKind> = new Set(["credit_card", "loan"]);

export type AccountVisibility = "private" | "shared";

export const BALANCE_STATUS_LABELS: Record<BalanceView["status"], string> = {
    incomplete: "No starting balance",
    calculated: "Calculated, not confirmed",
    matches_bank: "Matches the bank",
    reconciled: "Reconciled",
    mismatch: "Doesn't match",
};

export const isDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));

const date = z.string().refine(isDate, "Enter a date");
const cents = z
    .number()
    .int("Amounts are whole cents")
    .refine((v) => Math.abs(v) <= MAX_CENTS, "Amount is too large");
const text = (max: number) => z.string().trim().max(max);
const clientId = z.string().min(8).max(64);
const version = z.number().int().min(1);

export const accountId = z.string().regex(/^fac_[a-z0-9]{14}$/, "Not an account");
export const transactionId = z.string().regex(/^ftx_[a-z0-9]{14}$/, "Not a transaction");
export const importId = z.string().regex(/^fim_[a-z0-9]{14}$/, "Not an import");
export const categoryId = z.string().regex(/^[a-z0-9_-]{2,40}$/, "Not a category");

export const accountCreateSchema = z
    .object({
        name: text(80).min(1, "Give the account a name"),
        institution: text(80).nullable().default(null),
        kind: z.enum(ACCOUNT_KINDS),
        numberHint: z
            .string()
            .regex(/^\d{2,4}$/, "Up to the last four digits only")
            .nullable()
            .default(null),
        openingBalanceCents: cents.nullable().default(null),
        openingBalanceOn: date.nullable().default(null),
        visibility: z.enum(["private", "shared"]).default("private"),
        clientId: clientId.optional(),
    })
    .strict()
    .refine((v) => (v.openingBalanceCents === null) === (v.openingBalanceOn === null), {
        message: "A starting balance needs its date, and a date needs the balance",
        path: ["openingBalanceOn"],
    });

export const accountUpdateSchema = z
    .object({
        version,
        name: text(80).min(1, "Give the account a name").optional(),
        institution: text(80).nullable().optional(),
        kind: z.enum(ACCOUNT_KINDS).optional(),
        numberHint: z
            .string()
            .regex(/^\d{2,4}$/, "Up to the last four digits only")
            .nullable()
            .optional(),
        openingBalanceCents: cents.nullable().optional(),
        openingBalanceOn: date.nullable().optional(),
        visibility: z.enum(["private", "shared"]).optional(),
        archived: z.boolean().optional(),
    })
    .strict();

export const reconcileSchema = z
    .object({
        asOf: date,
        statementBalanceCents: cents,
        note: text(500).nullable().default(null),
    })
    .strict();

export const manualTransactionSchema = z
    .object({
        accountId,
        postedOn: date,
        amountCents: cents.refine((v) => v !== 0, "Enter an amount other than zero"),
        description: text(500).min(1, "Describe the transaction"),
        categoryId: categoryId.nullable().default(null),
        note: text(1000).nullable().default(null),
        clientId,
    })
    .strict();

export const transactionUpdateSchema = z
    .object({
        version,
        categoryId: categoryId.nullable().optional(),
        note: text(1000).nullable().optional(),
        isTransfer: z.boolean().optional(),
        // Manual entries only: imported ones keep the bank's date, amount and description.
        postedOn: date.optional(),
        amountCents: cents.refine((v) => v !== 0, "Enter an amount other than zero").optional(),
        description: text(500).min(1).optional(),
    })
    .strict();

export const bulkCategoriseSchema = z
    .object({
        ids: z.array(transactionId).min(1).max(500),
        categoryId: categoryId.nullable(),
    })
    .strict();

export const similarSchema = z
    .object({
        transactionId,
        categoryId,
        /** Also change ones someone already categorised differently. Off unless they ask. */
        includeCategorised: z.boolean().default(false),
    })
    .strict();

export const categoryCreateSchema = z
    .object({
        name: text(60).min(1, "Name the category"),
        kind: z.enum(["income", "expense"]),
        groupId: z.string().min(2).max(40),
    })
    .strict();

export const categoryUpdateSchema = z
    .object({
        version,
        name: text(60).min(1).optional(),
        groupId: z.string().min(2).max(40).optional(),
        archived: z.boolean().optional(),
    })
    .strict();

export const inspectSchema = z
    .object({
        accountId,
        text: z.string().min(1, "The file is empty"),
    })
    .strict();

export const importCreateSchema = z
    .object({
        accountId,
        filename: text(200).min(1),
        text: z.string().min(1, "The file is empty"),
        mapping: importMappingSchema,
    })
    .strict();

export const importDecisionSchema = z
    .object({
        version,
        decisions: z
            .array(z.object({ line: z.number().int().min(1), decision: z.enum(["include", "skip"]) }).strict())
            .min(1)
            .max(5000),
    })
    .strict();

// --- Views -----------------------------------------------------------------------------------------

export interface AccountView {
    id: string;
    name: string;
    institution: string | null;
    kind: AccountKind;
    numberHint: string | null;
    visibility: AccountVisibility;
    /** The caller owns it (and so can change sharing, archive it and set its starting balance). */
    mine: boolean;
    ownerName: string | null;
    openingBalanceCents: number | null;
    openingBalanceOn: string | null;
    balance: BalanceView;
    transactionCount: number;
    /** Transactions dated before the starting balance: listed, but not in the balance. */
    beforeOpeningCount: number;
    firstTransactionOn: string | null;
    lastTransactionOn: string | null;
    lastImportAt: string | null;
    lastPreset: PresetId | null;
    archived: boolean;
    version: number;
}

export interface AccountOption {
    id: string;
    name: string;
    kind: AccountKind;
    visibility: AccountVisibility;
    mine: boolean;
    archived: boolean;
}

export interface TransactionView {
    id: string;
    accountId: string;
    accountName: string;
    postedOn: string;
    amountCents: number;
    description: string;
    merchant: string | null;
    merchantKey: string | null;
    note: string | null;
    categoryId: string | null;
    categorySource: "manual" | "rule" | "suggestion" | null;
    isTransfer: boolean;
    /** The other side of a linked transfer; "hidden" when it's in an account not shared with the caller. */
    counterpart: { id: string; accountName: string; postedOn: string } | "hidden" | null;
    source: "import" | "manual";
    importId: string | null;
    bankCategory: string | null;
    bankBalanceCents: number | null;
    version: number;
}

export type ImportStatus = "review" | "committing" | "committed" | "cancelled" | "undone";

export interface ImportSummary {
    id: string;
    accountId: string;
    accountName: string;
    filename: string;
    status: ImportStatus;
    preset: PresetId;
    rowsTotal: number;
    rowsNew: number;
    rowsDuplicate: number;
    rowsPossible: number;
    rowsInvalid: number;
    rowsImported: number | null;
    firstOn: string | null;
    lastOn: string | null;
    bankClosingCents: number | null;
    warnings: string[];
    createdBy: string;
    createdAt: string;
    committedAt: string | null;
    closedAt: string | null;
    version: number;
}

export type ImportRowStatus = "new" | "duplicate" | "possible_duplicate" | "invalid";

export interface ImportRowView {
    line: number;
    position: number;
    status: ImportRowStatus;
    decision: "include" | "skip" | null;
    postedOn: string | null;
    amountCents: number | null;
    description: string | null;
    bankBalanceCents: number | null;
    error: string | null;
    /** The ledger transaction it duplicates or may duplicate. */
    match: { id: string; postedOn: string; amountCents: number; description: string; source: "import" | "manual" } | null;
}

/** What committing would do now: the counts the review screen shows. */
export interface ImportPlan {
    toImport: number;
    excluded: number;
    duplicates: number;
    invalid: number;
    undecided: number;
}

export interface ImportDetail {
    summary: ImportSummary;
    rows: ImportRowView[];
    plan: ImportPlan;
    mapping: ImportMapping;
    /** A starting balance the file implies (bank balance after the first row, less that row). */
    impliedOpening: { on: string; cents: number } | null;
    /** Whether the account has no starting balance yet (so the suggestion is worth showing). */
    accountHasOpening: boolean;
    sameFileImportedAt: string | null;
}

export interface InspectResult {
    /** The first rows of the file, so the person can check the columns. */
    preview: string[][];
    columns: number;
    mapping: ImportMapping | null;
    dateAmbiguous: boolean;
    /** Already imported to this account (by SHA-256): when. */
    sameFileImportedAt: string | null;
    lines: number;
}

export interface CategorySpend {
    categoryId: string | null;
    name: string;
    groupId: string | null;
    groupName: string | null;
    cents: number;
    count: number;
}

export interface TransferSuggestion {
    out: TransactionView;
    in: TransactionView;
    days: number;
}

export interface FinanceOverview {
    from: string;
    to: string;
    accountIds: string[];
    accounts: AccountView[];
    totals: PeriodTotals;
    previous: PeriodTotals & { from: string; to: string };
    months: { month: string; incomeCents: number; expenseCents: number; netCents: number }[];
    byCategory: CategorySpend[];
    recent: TransactionView[];
    uncategorisedCount: number;
    transferSuggestionCount: number;
    position: { assetsCents: number; liabilitiesCents: number; netCents: number; incompleteAccounts: number; unconfirmedAccounts: number };
    lastImport: ImportSummary | null;
}

export interface TransactionFilters {
    from: string;
    to: string;
    accountId: string | null;
    categoryId: string | null;
    /** "uncategorised" | "transfers" | "manual" | null */
    show: "uncategorised" | "transfers" | "manual" | null;
    q: string;
}

export interface FinanceShell {
    today: string;
    categories: CategoryDef[];
    accounts: AccountOption[];
}

export type FinanceRoute =
    | ({ route: "finance-overview"; overview: FinanceOverview } & FinanceShell)
    | ({
          route: "finance-transactions";
          transactions: TransactionView[];
          truncated: boolean;
          filters: TransactionFilters;
          suggestions: TransferSuggestion[];
      } & FinanceShell)
    | ({ route: "finance-accounts"; accounts: AccountView[] } & FinanceShell)
    | ({
          route: "finance-account";
          account: AccountView;
          transactions: TransactionView[];
          truncated: boolean;
          imports: ImportSummary[];
          reconciliations: {
              id: string;
              asOf: string;
              statementCents: number;
              calculatedCents: number;
              differenceCents: number;
              note: string | null;
              createdAt: string;
          }[];
      } & FinanceShell)
    | ({ route: "finance-import"; imports: ImportSummary[]; accountId: string | null } & FinanceShell)
    | ({ route: "finance-import-review"; detail: ImportDetail } & FinanceShell)
    | ({ route: "finance-settings"; usage: Record<string, number> } & FinanceShell);
