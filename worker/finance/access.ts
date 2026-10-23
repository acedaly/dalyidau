// Who may see and change what in Household Finance.
//
// Portal roles decide whether someone may open Household Finance at all ("finance.use", owners
// only). Inside it, every account has an owner. A private account is its owner's alone; a shared
// account is visible to, and its transactions can be categorised and imported by, everyone who can
// open Household Finance. Only the owner can change an account's sharing, starting balance or
// archive it. A transaction is visible exactly when its account is. Being a portal owner grants
// nothing here: neither owner can see the other's private accounts, and an account you can't see
// doesn't exist as far as the API is concerned (404, never 403), so ids can't be probed.
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { localDate } from "../../src/shared/calendar/time";
import type { PortalUser } from "../../src/shared/portal/types";
import { preferences as calendarPreferences } from "../calendar/access";
import { nowIso } from "../portal/db";
import { HttpError } from "../portal/http";

export const notFound = () => new HttpError(404, "not_found", "Not found");
export const conflict = (message = "Someone else changed this. Reload and try again.") => new HttpError(409, "conflict", message);

/** Accounts the caller (bound as ?1) can see, aliased `a`. */
export const ACCOUNT_VISIBLE = "(a.owner_email = ?1 OR a.visibility = 'shared')";

export interface AccountRow {
    id: string;
    owner_email: string;
    name: string;
    institution: string | null;
    kind: string;
    number_hint: string | null;
    opening_balance_cents: number | null;
    opening_balance_on: string | null;
    visibility: "private" | "shared";
    import_mapping: string | null;
    archived_at: string | null;
    client_id: string | null;
    version: number;
    created_by: string;
    created_at: string;
    updated_by: string;
    updated_at: string;
}

export const isMine = (row: Pick<AccountRow, "owner_email">, user: PortalUser) => row.owner_email.toLowerCase() === user.email.toLowerCase();

/**
 * The account, if the caller can see it. "manage" (sharing, starting balance, archiving) is the
 * owner's alone; anything else visible is usable. Not visible: 404.
 */
export async function requireAccount(db: D1Database, user: PortalUser, id: string, need: "view" | "manage" = "view"): Promise<AccountRow> {
    const row = await db.prepare(`SELECT a.* FROM finance_accounts a WHERE a.id = ?2 AND ${ACCOUNT_VISIBLE}`).bind(user.email, id).first<AccountRow>();
    if (!row) throw notFound();
    if (need === "manage" && !isMine(row, user)) throw new HttpError(403, "forbidden", "Only the account's owner can do that");
    return row;
}

export async function visibleAccountRows(db: D1Database, user: PortalUser): Promise<AccountRow[]> {
    const rows = await db
        .prepare(`SELECT a.* FROM finance_accounts a WHERE ${ACCOUNT_VISIBLE} ORDER BY a.archived_at IS NOT NULL, a.kind, lower(a.name) LIMIT 200`)
        .bind(user.email)
        .all<AccountRow>();
    return rows.results;
}

// --- History ---------------------------------------------------------------------------------------

export interface ActivityInput {
    actor: string;
    action: string;
    entityType: "account" | "transaction" | "transfer" | "import" | "category" | "reconciliation" | "export";
    entityId?: string | null;
    accountId?: string | null;
    via?: "portal" | "mcp" | "system";
    /** Field names and, for ledger corrections, ids, dates and amounts. Never descriptions or notes. */
    detail?: Record<string, unknown> | null;
}

export const activity = (db: D1Database, entry: ActivityInput): D1PreparedStatement =>
    db
        .prepare("INSERT INTO finance_activity (at, actor, action, entity_type, entity_id, account_id, via, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(
            nowIso(),
            entry.actor,
            entry.action,
            entry.entityType,
            entry.entityId ?? null,
            entry.accountId ?? null,
            entry.via ?? "portal",
            entry.detail ? JSON.stringify(entry.detail).slice(0, 2000) : null,
        );

/**
 * The same history row, written only when `exists` (an EXISTS subquery over the change just made in
 * the same batch) holds: a refused compare-and-set save leaves no history behind.
 */
export const activityWhen = (db: D1Database, entry: ActivityInput, exists: string, ...binds: unknown[]): D1PreparedStatement =>
    db
        .prepare(
            `INSERT INTO finance_activity (at, actor, action, entity_type, entity_id, account_id, via, detail) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (${exists})`,
        )
        .bind(
            nowIso(),
            entry.actor,
            entry.action,
            entry.entityType,
            entry.entityId ?? null,
            entry.accountId ?? null,
            entry.via ?? "portal",
            entry.detail ? JSON.stringify(entry.detail).slice(0, 2000) : null,
            ...binds,
        );

/** The person's time zone (from Calendar) and today's date in it. */
export async function todayFor(db: D1Database, email: string): Promise<string> {
    const timeZone = (await calendarPreferences(db, email)).timeZone;
    return localDate(new Date(), timeZone);
}

/** SHA-256 hex of a string. */
export async function sha256Hex(text: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Runs statements in atomic chunks (each D1 batch is one transaction). */
export async function batchInChunks(db: D1Database, statements: D1PreparedStatement[], size = 200) {
    for (let i = 0; i < statements.length; i += size) await db.batch(statements.slice(i, i + size));
}
