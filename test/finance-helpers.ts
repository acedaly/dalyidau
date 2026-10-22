// Helpers for the Household Finance tests. Every account, amount and file is invented
// (fixtures/finance/fixtures.ts): no real bank data.
import { expect } from "vitest";
import type { ImportMapping } from "../src/shared/finance/csv-import";
import type { AccountView, ImportDetail, InspectResult, TransactionView } from "../src/shared/finance/types";
import { OWNER, SECOND_OWNER, apiCall } from "./portal-helpers";

export const FIN = "/api/portal/finance";
export const A = OWNER;
export const B = SECOND_OWNER; // the other household owner: sees A's shared accounts, never A's private ones
export const ADMIN = "admin@example.com";
export const EDITOR = "wedding-editor@example.com";

export const fin = <R = unknown>(method: string, path: string, body?: unknown, email = A) => apiCall<R>(method, `${FIN}${path}`, body, { email });

export const addPortalUser = (email: string, role: "admin" | "editor" | "viewer") => apiCall("POST", "/api/portal/users", { email, role });

export async function account(body: Record<string, unknown>, email = A): Promise<AccountView> {
    const result = await fin<{ account: AccountView }>("POST", "/accounts", { kind: "transaction", ...body }, email);
    expect(result.status, result.text).toBe(201);
    return result.json.account;
}

export async function getAccount(id: string, email = A): Promise<AccountView> {
    const result = await fin<{ account: AccountView }>("GET", `/accounts/${id}`, undefined, email);
    expect(result.status, result.text).toBe(200);
    return result.json.account;
}

export async function inspect(accountId: string, text: string, email = A): Promise<InspectResult> {
    const result = await fin<{ inspection: InspectResult }>("POST", "/imports/inspect", { accountId, text }, email);
    expect(result.status, result.text).toBe(200);
    return result.json.inspection;
}

/** Inspects, then stages with the suggested layout. */
export async function stage(accountId: string, text: string, email = A, filename = "export.csv", mapping?: ImportMapping): Promise<ImportDetail> {
    const chosen = mapping ?? (await inspect(accountId, text, email)).mapping;
    expect(chosen, "a layout was found").not.toBeNull();
    const result = await fin<{ detail: ImportDetail }>("POST", "/imports", { accountId, filename, text, mapping: chosen }, email);
    expect([200, 201], result.text).toContain(result.status);
    return result.json.detail;
}

export async function commit(detail: ImportDetail, email = A): Promise<ImportDetail> {
    const result = await fin<{ detail: ImportDetail }>("POST", `/imports/${detail.summary.id}/commit`, { version: detail.summary.version }, email);
    expect(result.status, result.text).toBe(200);
    return result.json.detail;
}

export async function importFile(accountId: string, text: string, email = A) {
    return commit(await stage(accountId, text, email), email);
}

export async function transactions(query = "", email = A): Promise<TransactionView[]> {
    const result = await fin<{ transactions: TransactionView[] }>("GET", `/transactions?from=2026-01-01&to=2026-12-31${query}`, undefined, email);
    expect(result.status, result.text).toBe(200);
    return result.json.transactions;
}

export const byDescription = (list: TransactionView[], text: string) => list.filter((t) => t.description.includes(text));
