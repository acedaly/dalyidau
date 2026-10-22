// Calls to /api/portal/finance (docs/HOUSEHOLD_FINANCE.md#api).
import { api } from "@/portal/lib/api";
import type { CategoryDef } from "@/shared/finance/categories";
import type { ImportMapping } from "@/shared/finance/csv-import";
import type { AccountView, ImportDetail, InspectResult, TransactionView, TransferSuggestion } from "@/shared/finance/types";

const F = "/api/portal/finance";

export const financeApi = {
    createAccount: (body: Record<string, unknown>) => api<{ account: AccountView; replayed: boolean }>("POST", `${F}/accounts`, body),
    getAccount: (id: string) => api<{ account: AccountView }>("GET", `${F}/accounts/${id}`),
    updateAccount: (id: string, body: Record<string, unknown>) => api<{ account: AccountView }>("PATCH", `${F}/accounts/${id}`, body),
    reconcile: (id: string, body: { asOf: string; statementBalanceCents: number; note: string | null }) =>
        api<{ differenceCents: number; calculatedCents: number; account: AccountView }>("POST", `${F}/accounts/${id}/reconcile`, body),

    createCategory: (body: { name: string; kind: "income" | "expense"; groupId: string }) => api<{ category: CategoryDef }>("POST", `${F}/categories`, body),
    updateCategory: (id: string, body: Record<string, unknown>) => api<{ category: CategoryDef }>("PATCH", `${F}/categories/${id}`, body),

    createTransaction: (body: Record<string, unknown>) => api<{ transaction: TransactionView; replayed: boolean }>("POST", `${F}/transactions`, body),
    updateTransaction: (id: string, body: Record<string, unknown>) => api<{ transaction: TransactionView }>("PATCH", `${F}/transactions/${id}`, body),
    deleteTransaction: (id: string) => api<{ ok: true }>("DELETE", `${F}/transactions/${id}`),
    similar: (id: string, categoryId: string | null) =>
        api<{ merchantKey: string | null; uncategorised: number; categorisedDifferently: number }>(
            "GET",
            `${F}/transactions/${id}/similar${categoryId ? `?category=${encodeURIComponent(categoryId)}` : ""}`,
        ),
    categoriseSimilar: (body: { transactionId: string; categoryId: string; includeCategorised?: boolean }) =>
        api<{ updated: number }>("POST", `${F}/transactions/similar`, body),
    bulkCategorise: (ids: string[], categoryId: string | null) =>
        api<{ updated: number; skipped: number }>("POST", `${F}/transactions/bulk`, { ids, categoryId }),

    suggestions: () => api<{ suggestions: TransferSuggestion[] }>("GET", `${F}/transfers/suggestions`),
    linkTransfer: (outId: string, inId: string) => api<{ out: TransactionView; in: TransactionView }>("POST", `${F}/transfers`, { outId, inId }),
    dismissTransfer: (outId: string, inId: string) => api<{ ok: true }>("POST", `${F}/transfers/dismiss`, { outId, inId }),

    inspect: (accountId: string, text: string) => api<{ inspection: InspectResult }>("POST", `${F}/imports/inspect`, { accountId, text }),
    stage: (body: { accountId: string; filename: string; text: string; mapping: ImportMapping }) =>
        api<{ detail: ImportDetail; replayed: boolean }>("POST", `${F}/imports`, body),
    decide: (id: string, version: number, decisions: { line: number; decision: "include" | "skip" }[]) =>
        api<{ detail: ImportDetail }>("PATCH", `${F}/imports/${id}/rows`, { version, decisions }),
    commit: (id: string, version: number) => api<{ detail: ImportDetail; replayed: boolean }>("POST", `${F}/imports/${id}/commit`, { version }),
    cancel: (id: string, version: number) => api<{ ok: true }>("POST", `${F}/imports/${id}/cancel`, { version }),
    undo: (id: string, version: number) => api<{ ok: true }>("POST", `${F}/imports/${id}/undo`, { version, confirm: true }),
};

/** A retry key for a create, so a double click or a retried request makes one record. */
export const clientKey = () => `fin-${crypto.randomUUID()}`;
