// Accounts and their balances. A balance is the starting balance plus every transaction dated on
// or after its date, worked out when read and never stored. How sure we are of it comes from the
// most recent check: the bank's own running balance in an import, or a statement someone reconciled
// against (src/shared/finance/ledger.ts, balanceView). Without a starting balance there's no balance.
import type { D1Database } from "@cloudflare/workers-types";
import { importMappingSchema } from "../../src/shared/finance/csv-import";
import { balanceView } from "../../src/shared/finance/ledger";
import {
    type AccountKind,
    type AccountOption,
    type AccountView,
    accountCreateSchema,
    accountUpdateSchema,
    reconcileSchema,
} from "../../src/shared/finance/types";
import type { PortalUser } from "../../src/shared/portal/types";
import { namesFor } from "../assets/access";
import { newId, nowIso, parseJson } from "../portal/db";
import { HttpError } from "../portal/http";
import { ACCOUNT_VISIBLE, type AccountRow, activity, activityWhen, conflict, isMine, requireAccount, visibleAccountRows } from "./access";

interface Stats {
    account_id: string;
    n: number;
    first_on: string | null;
    last_on: string | null;
    since_opening: number | null;
    before_opening: number;
}
interface BankCheck {
    account_id: string;
    posted_on: string;
    bank_balance_cents: number;
    calculated: number | null;
}
interface Reconciliation {
    account_id: string;
    as_of: string;
    statement_balance_cents: number;
    calculated_balance_cents: number;
}

/** Views for the given accounts (all visible to the caller), with balances, checks and import state. */
export async function accountViews(db: D1Database, user: PortalUser, rows: AccountRow[]): Promise<AccountView[]> {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const list = ids.map(() => "?").join(", ");
    const [stats, bank, recs, imports, names] = await Promise.all([
        db
            .prepare(
                `SELECT t.account_id, COUNT(*) AS n, MIN(t.posted_on) AS first_on, MAX(t.posted_on) AS last_on,
                    SUM(CASE WHEN a.opening_balance_on IS NOT NULL AND t.posted_on >= a.opening_balance_on THEN t.amount_cents ELSE 0 END) AS since_opening,
                    SUM(CASE WHEN a.opening_balance_on IS NOT NULL AND t.posted_on < a.opening_balance_on THEN 1 ELSE 0 END) AS before_opening
                 FROM finance_transactions t JOIN finance_accounts a ON a.id = t.account_id
                 WHERE t.deleted_at IS NULL AND t.account_id IN (${list}) GROUP BY t.account_id`,
            )
            .bind(...ids)
            .all<Stats>(),
        // The latest transaction that carried the bank's balance (the last one on its day), and our
        // own balance at the end of that day.
        db
            .prepare(
                `SELECT r.account_id, r.posted_on, r.bank_balance_cents,
                    a.opening_balance_cents + (SELECT COALESCE(SUM(x.amount_cents), 0) FROM finance_transactions x
                        WHERE x.account_id = r.account_id AND x.deleted_at IS NULL AND x.posted_on >= a.opening_balance_on AND x.posted_on <= r.posted_on) AS calculated
                 FROM (SELECT t.account_id, t.posted_on, t.bank_balance_cents,
                         ROW_NUMBER() OVER (PARTITION BY t.account_id ORDER BY t.posted_on DESC, t.created_at DESC, t.sequence DESC) AS rn
                       FROM finance_transactions t WHERE t.deleted_at IS NULL AND t.bank_balance_cents IS NOT NULL AND t.account_id IN (${list})) r
                 JOIN finance_accounts a ON a.id = r.account_id
                 WHERE r.rn = 1 AND a.opening_balance_on IS NOT NULL AND r.posted_on >= a.opening_balance_on`,
            )
            .bind(...ids)
            .all<BankCheck>(),
        db
            .prepare(
                `SELECT account_id, as_of, statement_balance_cents, calculated_balance_cents FROM (
                    SELECT r.*, ROW_NUMBER() OVER (PARTITION BY r.account_id ORDER BY r.as_of DESC, r.created_at DESC) AS rn
                    FROM finance_reconciliations r WHERE r.account_id IN (${list})) WHERE rn = 1`,
            )
            .bind(...ids)
            .all<Reconciliation>(),
        db
            .prepare(
                `SELECT account_id, MAX(committed_at) AS at FROM finance_imports WHERE status = 'committed' AND account_id IN (${list}) GROUP BY account_id`,
            )
            .bind(...ids)
            .all<{ account_id: string; at: string }>(),
        namesFor(
            db,
            rows.map((r) => r.owner_email),
        ),
    ]);
    const statsBy = new Map(stats.results.map((s) => [s.account_id, s]));
    const bankBy = new Map(bank.results.map((b) => [b.account_id, b]));
    const recBy = new Map(recs.results.map((r) => [r.account_id, r]));
    const importBy = new Map(imports.results.map((i) => [i.account_id, i.at]));
    return rows.map((row) => {
        const s = statsBy.get(row.id);
        const b = bankBy.get(row.id);
        const r = recBy.get(row.id);
        const mapping = row.import_mapping ? importMappingSchema.safeParse(parseJson(row.import_mapping, null)) : null;
        return {
            id: row.id,
            name: row.name,
            institution: row.institution,
            kind: row.kind as AccountKind,
            numberHint: row.number_hint,
            visibility: row.visibility,
            mine: isMine(row, user),
            ownerName: names.get(row.owner_email.toLowerCase()) ?? null,
            openingBalanceCents: row.opening_balance_cents,
            openingBalanceOn: row.opening_balance_on,
            balance: balanceView({
                openingCents: row.opening_balance_cents,
                openingOn: row.opening_balance_on,
                sinceOpeningCents: s?.since_opening ?? 0,
                bankCheck: b && b.calculated !== null ? { on: b.posted_on, bankCents: b.bank_balance_cents, calculatedCents: b.calculated } : null,
                reconciliation: r ? { asOf: r.as_of, statementCents: r.statement_balance_cents, calculatedCents: r.calculated_balance_cents } : null,
            }),
            transactionCount: s?.n ?? 0,
            beforeOpeningCount: s?.before_opening ?? 0,
            firstTransactionOn: s?.first_on ?? null,
            lastTransactionOn: s?.last_on ?? null,
            lastImportAt: importBy.get(row.id) ?? null,
            lastPreset: mapping?.success ? mapping.data.preset : null,
            archived: !!row.archived_at,
            version: row.version,
        };
    });
}

export async function listAccounts(db: D1Database, user: PortalUser): Promise<AccountView[]> {
    return accountViews(db, user, await visibleAccountRows(db, user));
}

export async function accountView(db: D1Database, user: PortalUser, id: string): Promise<AccountView> {
    const row = await requireAccount(db, user, id);
    return (await accountViews(db, user, [row]))[0];
}

export async function accountOptions(db: D1Database, user: PortalUser): Promise<AccountOption[]> {
    return (await visibleAccountRows(db, user)).map((r) => ({
        id: r.id,
        name: r.name,
        kind: r.kind as AccountKind,
        visibility: r.visibility,
        mine: isMine(r, user),
        archived: !!r.archived_at,
    }));
}

export async function createAccount(db: D1Database, user: PortalUser, input: unknown): Promise<{ account: AccountView; replayed: boolean }> {
    const body = accountCreateSchema.parse(input);
    if (body.clientId) {
        const existing = await db
            .prepare("SELECT id FROM finance_accounts WHERE owner_email = ? AND client_id = ?")
            .bind(user.email, body.clientId)
            .first<{ id: string }>();
        if (existing) return { account: await accountView(db, user, existing.id), replayed: true };
    }
    const id = newId("fac");
    const now = nowIso();
    try {
        await db.batch([
            db
                .prepare(
                    `INSERT INTO finance_accounts (id, owner_email, name, institution, kind, number_hint, opening_balance_cents, opening_balance_on, visibility, client_id, created_by, created_at, updated_by, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                )
                .bind(
                    id,
                    user.email,
                    body.name,
                    body.institution || null,
                    body.kind,
                    body.numberHint,
                    body.openingBalanceCents,
                    body.openingBalanceOn,
                    body.visibility,
                    body.clientId ?? null,
                    user.email,
                    now,
                    user.email,
                    now,
                ),
            activity(db, {
                actor: user.email,
                action: "account.create",
                entityType: "account",
                entityId: id,
                accountId: id,
                detail: { visibility: body.visibility },
            }),
        ]);
    } catch (error) {
        // A retry racing the first attempt: answer with the account the first one made.
        if (body.clientId && String(error).includes("UNIQUE")) return createAccount(db, user, input);
        throw error;
    }
    return { account: await accountView(db, user, id), replayed: false };
}

export async function updateAccount(db: D1Database, user: PortalUser, id: string, input: unknown): Promise<AccountView> {
    const body = accountUpdateSchema.parse(input);
    const row = await requireAccount(db, user, id);
    const manages =
        body.visibility !== undefined || body.archived !== undefined || body.openingBalanceCents !== undefined || body.openingBalanceOn !== undefined;
    if (manages && !isMine(row, user)) throw new HttpError(403, "forbidden", "Only the account's owner can change its sharing, starting balance or archive it");
    const opening = body.openingBalanceCents !== undefined ? body.openingBalanceCents : row.opening_balance_cents;
    const openingOn = body.openingBalanceOn !== undefined ? body.openingBalanceOn : row.opening_balance_on;
    if ((opening === null) !== (openingOn === null)) throw new HttpError(422, "validation", "A starting balance needs its date, and a date needs the balance");
    const now = nowIso();
    const changed = Object.keys(body).filter((k) => k !== "version");
    const detail: Record<string, unknown> = { fields: changed };
    if (body.openingBalanceCents !== undefined || body.openingBalanceOn !== undefined)
        detail.opening = { from: [row.opening_balance_cents, row.opening_balance_on], to: [opening, openingOn] };
    if (body.visibility !== undefined) detail.visibility = { from: row.visibility, to: body.visibility };
    const [result] = await db.batch([
        db
            .prepare(
                `UPDATE finance_accounts SET name = ?, institution = ?, kind = ?, number_hint = ?, opening_balance_cents = ?, opening_balance_on = ?, visibility = ?, archived_at = ?,
                    version = version + 1, updated_by = ?, updated_at = ? WHERE id = ? AND version = ?`,
            )
            .bind(
                body.name ?? row.name,
                body.institution !== undefined ? body.institution || null : row.institution,
                body.kind ?? row.kind,
                body.numberHint !== undefined ? body.numberHint : row.number_hint,
                opening,
                openingOn,
                body.visibility ?? row.visibility,
                body.archived === undefined ? row.archived_at : body.archived ? (row.archived_at ?? now) : null,
                user.email,
                now,
                id,
                body.version,
            ),
        activityWhen(
            db,
            { actor: user.email, action: "account.update", entityType: "account", entityId: id, accountId: id, detail },
            "SELECT 1 FROM finance_accounts WHERE id = ? AND updated_at = ?",
            id,
            now,
        ),
    ]);
    if (!result.meta.changes) throw conflict();
    return accountView(db, user, id);
}

/** Our balance at the end of `date`, or null without a starting balance on or before it. */
export async function balanceAt(db: D1Database, row: AccountRow, date: string): Promise<number | null> {
    if (row.opening_balance_cents === null || row.opening_balance_on === null || date < row.opening_balance_on) return null;
    const sum = await db
        .prepare(
            "SELECT COALESCE(SUM(amount_cents), 0) AS s FROM finance_transactions WHERE account_id = ? AND deleted_at IS NULL AND posted_on >= ? AND posted_on <= ?",
        )
        .bind(row.id, row.opening_balance_on, date)
        .first<{ s: number }>();
    return row.opening_balance_cents + (sum?.s ?? 0);
}

/** Records a comparison with a statement. It changes no transaction: the difference is shown, not fixed. */
export async function reconcile(db: D1Database, user: PortalUser, id: string, input: unknown) {
    const body = reconcileSchema.parse(input);
    const row = await requireAccount(db, user, id);
    const calculated = await balanceAt(db, row, body.asOf);
    if (calculated === null)
        throw new HttpError(422, "validation", row.opening_balance_on ? "That date is before the account's starting balance" : "Set a starting balance first");
    const recId = newId("frc");
    const difference = body.statementBalanceCents - calculated;
    await db.batch([
        db
            .prepare(
                `INSERT INTO finance_reconciliations (id, account_id, as_of, statement_balance_cents, calculated_balance_cents, difference_cents, note, created_by, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(recId, id, body.asOf, body.statementBalanceCents, calculated, difference, body.note || null, user.email, nowIso()),
        activity(db, {
            actor: user.email,
            action: "account.reconcile",
            entityType: "reconciliation",
            entityId: recId,
            accountId: id,
            detail: { asOf: body.asOf, statementCents: body.statementBalanceCents, calculatedCents: calculated, differenceCents: difference },
        }),
    ]);
    return { differenceCents: difference, calculatedCents: calculated, account: await accountView(db, user, id) };
}

export async function listReconciliations(db: D1Database, user: PortalUser, id: string) {
    await requireAccount(db, user, id);
    const rows = await db
        .prepare("SELECT * FROM finance_reconciliations WHERE account_id = ? ORDER BY as_of DESC, created_at DESC LIMIT 50")
        .bind(id)
        .all<{
            id: string;
            as_of: string;
            statement_balance_cents: number;
            calculated_balance_cents: number;
            difference_cents: number;
            note: string | null;
            created_at: string;
        }>();
    return rows.results.map((r) => ({
        id: r.id,
        asOf: r.as_of,
        statementCents: r.statement_balance_cents,
        calculatedCents: r.calculated_balance_cents,
        differenceCents: r.difference_cents,
        note: r.note,
        createdAt: r.created_at,
    }));
}

/** Ids of the accounts the caller can see (optionally only these), for scoping every ledger read. */
export async function visibleIds(db: D1Database, user: PortalUser, only?: readonly string[]): Promise<string[]> {
    const rows = await db.prepare(`SELECT a.id FROM finance_accounts a WHERE ${ACCOUNT_VISIBLE}`).bind(user.email).all<{ id: string }>();
    const ids = rows.results.map((r) => r.id);
    return only && only.length ? ids.filter((id) => only.includes(id)) : ids;
}
