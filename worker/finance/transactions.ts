// The transaction ledger: reading it (always scoped to accounts the caller can see), categorising,
// manual entries and corrections, transfers between the household's own accounts, and export.
//
// Imported transactions keep the bank's date, amount and description: only their category, note and
// transfer marking change. Manual entries can be corrected or deleted (soft, with history). A
// category someone chose is only ever replaced by another person's explicit choice.
import type { D1Database } from "@cloudflare/workers-types";
import { merchantKeyOf } from "../../src/shared/finance/csv-import";
import { shiftDays } from "../../src/shared/finance/dates";
import { transferSuggestions } from "../../src/shared/finance/ledger";
import { centsToDecimal } from "../../src/shared/finance/money";
import {
    type TransactionFilters,
    type TransactionView,
    type TransferSuggestion,
    bulkCategoriseSchema,
    manualTransactionSchema,
    similarSchema,
    transactionUpdateSchema,
} from "../../src/shared/finance/types";
import type { PortalUser } from "../../src/shared/portal/types";
import { type CsvColumn, toCsv } from "../portal/csv";
import { newId, nowIso } from "../portal/db";
import { HttpError } from "../portal/http";
import { activity, activityWhen, batchInChunks, conflict, notFound, requireAccount, sha256Hex } from "./access";
import { assertAssignable, listCategories } from "./categories";

export interface TransactionRow {
    id: string;
    account_id: string;
    account_name: string;
    posted_on: string;
    sequence: number;
    amount_cents: number;
    description: string;
    merchant: string | null;
    merchant_key: string | null;
    note: string | null;
    category_id: string | null;
    category_source: "manual" | "rule" | "suggestion" | null;
    is_transfer: number;
    transfer_id: string | null;
    source: "import" | "manual";
    import_id: string | null;
    bank_balance_cents: number | null;
    bank_category: string | null;
    version: number;
    created_at: string;
    /** The other side of a linked transfer, and whether the caller can see its account. */
    other_id: string | null;
    other_account: string | null;
    other_on: string | null;
    other_visible: number | null;
}

const SELECT = `SELECT t.*, a.name AS account_name,
    o.id AS other_id, oa.name AS other_account, o.posted_on AS other_on,
    CASE WHEN oa.id IS NULL THEN NULL WHEN oa.owner_email = ?1 OR oa.visibility = 'shared' THEN 1 ELSE 0 END AS other_visible
  FROM finance_transactions t
  JOIN finance_accounts a ON a.id = t.account_id
  LEFT JOIN finance_transfers tr ON tr.id = t.transfer_id
  LEFT JOIN finance_transactions o ON o.id = CASE WHEN tr.out_transaction_id = t.id THEN tr.in_transaction_id ELSE tr.out_transaction_id END
  LEFT JOIN finance_accounts oa ON oa.id = o.account_id`;

/** Accounts the caller can see, as a WHERE fragment on `a` with the caller bound as ?1. */
const VISIBLE = "(a.owner_email = ?1 OR a.visibility = 'shared') AND t.deleted_at IS NULL";

export const toView = (r: TransactionRow): TransactionView => ({
    id: r.id,
    accountId: r.account_id,
    accountName: r.account_name,
    postedOn: r.posted_on,
    amountCents: r.amount_cents,
    description: r.description,
    merchant: r.merchant,
    merchantKey: r.merchant_key,
    note: r.note,
    categoryId: r.category_id,
    categorySource: r.category_source,
    isTransfer: !!r.is_transfer,
    counterpart: r.other_id ? (r.other_visible ? { id: r.other_id, accountName: r.other_account!, postedOn: r.other_on! } : "hidden") : null,
    source: r.source,
    importId: r.import_id,
    bankCategory: r.bank_category,
    bankBalanceCents: r.bank_balance_cents,
    version: r.version,
});

export const ORDER = "ORDER BY t.posted_on DESC, t.created_at DESC, t.sequence DESC, t.id";

export async function requireTransaction(db: D1Database, user: PortalUser, id: string): Promise<TransactionRow> {
    const row = await db.prepare(`${SELECT} WHERE t.id = ?2 AND ${VISIBLE}`).bind(user.email, id).first<TransactionRow>();
    if (!row) throw notFound();
    return row;
}

export const transactionView = async (db: D1Database, user: PortalUser, id: string) => toView(await requireTransaction(db, user, id));

export function filtersFrom(params: URLSearchParams, today: string): TransactionFilters {
    const date = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
    const show = params.get("show");
    const to = date(params.get("to")) ?? today;
    return {
        from: date(params.get("from")) ?? shiftDays(to, -89),
        to,
        accountId: /^fac_[a-z0-9]{14}$/.test(params.get("account") ?? "") ? params.get("account") : null,
        categoryId: /^[a-z0-9_-]{2,40}$/.test(params.get("category") ?? "") ? params.get("category") : null,
        show: show === "uncategorised" || show === "transfers" || show === "manual" ? show : null,
        q: (params.get("q") ?? "").trim().slice(0, 100),
    };
}

/** The ledger for the filters, newest first, bounded. Only accounts the caller can see. */
export async function listTransactions(
    db: D1Database,
    user: PortalUser,
    filters: Partial<TransactionFilters> & { accountIds?: string[]; importId?: string },
    limit = 2000,
): Promise<{ transactions: TransactionView[]; truncated: boolean }> {
    const where: string[] = [VISIBLE];
    const binds: unknown[] = [user.email];
    const bind = (value: unknown) => {
        binds.push(value);
        return `?${binds.length}`;
    };
    if (filters.from) where.push(`t.posted_on >= ${bind(filters.from)}`);
    if (filters.to) where.push(`t.posted_on <= ${bind(filters.to)}`);
    if (filters.accountId) where.push(`t.account_id = ${bind(filters.accountId)}`);
    if (filters.accountIds?.length) where.push(`t.account_id IN (${filters.accountIds.map((id) => bind(id)).join(", ")})`);
    if (filters.importId) where.push(`t.import_id = ${bind(filters.importId)}`);
    if (filters.categoryId === "uncategorised" || filters.show === "uncategorised") where.push("t.category_id IS NULL AND t.is_transfer = 0");
    else if (filters.categoryId) where.push(`t.category_id = ${bind(filters.categoryId)}`);
    if (filters.show === "transfers") where.push("t.is_transfer = 1");
    if (filters.show === "manual") where.push("t.source = 'manual'");
    if (filters.q) {
        const like = `%${filters.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        const p = bind(like);
        where.push(`(t.description LIKE ${p} ESCAPE '\\' OR t.merchant LIKE ${p} ESCAPE '\\' OR t.note LIKE ${p} ESCAPE '\\')`);
    }
    const rows = await db
        .prepare(`${SELECT} WHERE ${where.join(" AND ")} ${ORDER} LIMIT ${Math.max(1, Math.min(limit, 5000)) + 1}`)
        .bind(...binds)
        .all<TransactionRow>();
    const truncated = rows.results.length > limit;
    return { transactions: rows.results.slice(0, limit).map(toView), truncated };
}

// --- Manual entries and corrections ------------------------------------------------------------------

export async function createManual(db: D1Database, user: PortalUser, input: unknown): Promise<{ transaction: TransactionView; replayed: boolean }> {
    const body = manualTransactionSchema.parse(input);
    const existing = await db
        .prepare("SELECT id FROM finance_transactions WHERE created_by = ? AND client_id = ?")
        .bind(user.email, body.clientId)
        .first<{ id: string }>();
    if (existing) return { transaction: await transactionView(db, user, existing.id), replayed: true };
    await requireAccount(db, user, body.accountId);
    await assertAssignable(db, body.categoryId);
    const id = newId("ftx");
    const now = nowIso();
    // A manual entry is never an exact duplicate of anything: its key is unique to it. An import
    // flags it as a possible duplicate instead, for a person to decide.
    const fingerprint = await sha256Hex(`manual|${id}`);
    try {
        await db.batch([
            db
                .prepare(
                    `INSERT INTO finance_transactions (id, account_id, posted_on, amount_cents, description, merchant, merchant_key, note, category_id, category_source, source, fingerprint, client_id, created_by, created_at, updated_by, updated_at)
                     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 'manual', ?, ?, ?, ?, ?, ?)`,
                )
                .bind(
                    id,
                    body.accountId,
                    body.postedOn,
                    body.amountCents,
                    body.description,
                    merchantKeyOf(body.description),
                    body.note || null,
                    body.categoryId,
                    body.categoryId ? "manual" : null,
                    fingerprint,
                    body.clientId,
                    user.email,
                    now,
                    user.email,
                    now,
                ),
            activity(db, {
                actor: user.email,
                action: "transaction.create",
                entityType: "transaction",
                entityId: id,
                accountId: body.accountId,
                detail: { postedOn: body.postedOn, amountCents: body.amountCents, categoryId: body.categoryId },
            }),
        ]);
    } catch (error) {
        if (String(error).includes("UNIQUE")) return createManual(db, user, input);
        throw error;
    }
    return { transaction: await transactionView(db, user, id), replayed: false };
}

export async function updateTransaction(db: D1Database, user: PortalUser, id: string, input: unknown): Promise<TransactionView> {
    const body = transactionUpdateSchema.parse(input);
    const row = await requireTransaction(db, user, id);
    const ledgerFields = body.postedOn !== undefined || body.amountCents !== undefined || body.description !== undefined;
    if (ledgerFields && row.source !== "manual")
        throw new HttpError(422, "validation", "An imported transaction keeps the bank's date, amount and description. Add a note instead.");
    if (body.amountCents !== undefined && row.transfer_id && body.amountCents !== row.amount_cents)
        throw new HttpError(422, "validation", "Unlink the transfer before changing the amount");
    let isTransfer = !!row.is_transfer;
    if (body.isTransfer !== undefined) isTransfer = body.isTransfer;
    let categoryId = body.categoryId !== undefined ? body.categoryId : row.category_id;
    if (body.categoryId !== undefined && body.categoryId !== null) {
        if (isTransfer && body.isTransfer !== false) throw new HttpError(422, "validation", "This is a transfer. Mark it as not a transfer to categorise it.");
        await assertAssignable(db, body.categoryId);
    }
    if (isTransfer) categoryId = null;
    // Unmarking a linked transfer unlinks both sides, which needs both to be visible.
    const unlink = !isTransfer && !!row.transfer_id;
    if (unlink && row.other_visible === 0) throw new HttpError(403, "forbidden", "The other side of this transfer is in an account not shared with you");

    const now = nowIso();
    const detail: Record<string, unknown> = { fields: Object.keys(body).filter((k) => k !== "version") };
    if (categoryId !== row.category_id) detail.category = { from: row.category_id, to: categoryId };
    if (body.postedOn !== undefined && body.postedOn !== row.posted_on) detail.postedOn = { from: row.posted_on, to: body.postedOn };
    if (body.amountCents !== undefined && body.amountCents !== row.amount_cents) detail.amountCents = { from: row.amount_cents, to: body.amountCents };
    const description = body.description ?? row.description;
    const statements = [
        db
            .prepare(
                `UPDATE finance_transactions SET category_id = ?, category_source = ?, note = ?, is_transfer = ?, transfer_id = ?, posted_on = ?, amount_cents = ?, description = ?, merchant_key = ?,
                    version = version + 1, updated_by = ?, updated_at = ? WHERE id = ? AND version = ? AND deleted_at IS NULL`,
            )
            .bind(
                categoryId,
                categoryId ? (categoryId === row.category_id ? row.category_source : "manual") : null,
                body.note !== undefined ? body.note || null : row.note,
                isTransfer ? 1 : 0,
                unlink ? null : row.transfer_id,
                body.postedOn ?? row.posted_on,
                body.amountCents ?? row.amount_cents,
                description,
                body.description !== undefined ? merchantKeyOf(description) : row.merchant_key,
                user.email,
                now,
                id,
                body.version,
            ),
    ];
    const changed = "SELECT 1 FROM finance_transactions WHERE id = ? AND updated_at = ?";
    if (unlink) {
        statements.push(
            db
                .prepare(
                    `UPDATE finance_transactions SET is_transfer = 0, transfer_id = NULL, version = version + 1, updated_by = ?, updated_at = ? WHERE id = ? AND EXISTS (${changed})`,
                )
                .bind(user.email, now, row.other_id, id, now),
            db.prepare(`DELETE FROM finance_transfers WHERE id = ? AND EXISTS (${changed})`).bind(row.transfer_id, id, now),
        );
    }
    statements.push(
        activityWhen(
            db,
            {
                actor: user.email,
                action: unlink ? "transfer.unlink" : "transaction.update",
                entityType: "transaction",
                entityId: id,
                accountId: row.account_id,
                detail,
            },
            changed,
            id,
            now,
        ),
    );
    const [result] = await db.batch(statements);
    if (!result.meta.changes) throw conflict();
    return transactionView(db, user, id);
}

export async function deleteManual(db: D1Database, user: PortalUser, id: string) {
    const row = await requireTransaction(db, user, id);
    if (row.source !== "manual") throw new HttpError(422, "validation", "Imported transactions can't be deleted one by one. Undo the import instead.");
    if (row.transfer_id && row.other_visible === 0)
        throw new HttpError(403, "forbidden", "The other side of this transfer is in an account not shared with you");
    const now = nowIso();
    const statements = [
        db
            .prepare(
                "UPDATE finance_transactions SET deleted_at = ?, deleted_by = ?, is_transfer = 0, transfer_id = NULL, category_id = NULL, category_source = NULL, version = version + 1, updated_by = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
            )
            .bind(now, user.email, user.email, now, id),
    ];
    if (row.transfer_id)
        statements.push(
            db
                .prepare(
                    "UPDATE finance_transactions SET is_transfer = 0, transfer_id = NULL, version = version + 1, updated_by = ?, updated_at = ? WHERE id = ?",
                )
                .bind(user.email, now, row.other_id),
            db.prepare("DELETE FROM finance_transfers WHERE id = ?").bind(row.transfer_id),
        );
    statements.push(
        activity(db, {
            actor: user.email,
            action: "transaction.delete",
            entityType: "transaction",
            entityId: id,
            accountId: row.account_id,
            detail: { postedOn: row.posted_on, amountCents: row.amount_cents, categoryId: row.category_id },
        }),
    );
    await db.batch(statements);
}

// --- Categorising in bulk ----------------------------------------------------------------------------

/** Sets one category on many transactions the caller chose. Transfers and anything not visible are skipped. */
export async function bulkCategorise(db: D1Database, user: PortalUser, input: unknown) {
    const body = bulkCategoriseSchema.parse(input);
    await assertAssignable(db, body.categoryId);
    const ids = [...new Set(body.ids)];
    const visible = await db
        .prepare(
            `SELECT t.id, t.account_id, t.category_id FROM finance_transactions t JOIN finance_accounts a ON a.id = t.account_id
             WHERE ${VISIBLE} AND t.is_transfer = 0 AND t.id IN (${ids.map((_, i) => `?${i + 2}`).join(", ")})`,
        )
        .bind(user.email, ...ids)
        .all<{ id: string; account_id: string; category_id: string | null }>();
    const targets = visible.results.filter((t) => t.category_id !== body.categoryId);
    const now = nowIso();
    await batchInChunks(
        db,
        targets.flatMap((t) => [
            db
                .prepare(
                    "UPDATE finance_transactions SET category_id = ?, category_source = ?, version = version + 1, updated_by = ?, updated_at = ? WHERE id = ? AND is_transfer = 0 AND deleted_at IS NULL",
                )
                .bind(body.categoryId, body.categoryId ? "manual" : null, user.email, now, t.id),
            activity(db, {
                actor: user.email,
                action: "transaction.categorise",
                entityType: "transaction",
                entityId: t.id,
                accountId: t.account_id,
                detail: { category: { from: t.category_id, to: body.categoryId }, bulk: true },
            }),
        ]),
    );
    return { updated: targets.length, skipped: ids.length - targets.length };
}

const SIMILAR = `FROM finance_transactions t JOIN finance_accounts a ON a.id = t.account_id
    WHERE ${VISIBLE} AND t.is_transfer = 0 AND t.merchant_key = ?2 AND t.id <> ?3`;

/** How many other visible transactions share this one's merchant: uncategorised, and categorised differently. */
export async function similarCounts(db: D1Database, user: PortalUser, id: string, categoryId: string | null) {
    const row = await requireTransaction(db, user, id);
    if (!row.merchant_key) return { merchantKey: null, uncategorised: 0, categorisedDifferently: 0 };
    const counts = await db
        .prepare(
            `SELECT SUM(CASE WHEN t.category_id IS NULL THEN 1 ELSE 0 END) AS uncategorised,
                    SUM(CASE WHEN t.category_id IS NOT NULL AND t.category_id <> COALESCE(?4, '') THEN 1 ELSE 0 END) AS different ${SIMILAR}`,
        )
        .bind(user.email, row.merchant_key, id, categoryId)
        .first<{ uncategorised: number | null; different: number | null }>();
    return { merchantKey: row.merchant_key, uncategorised: counts?.uncategorised ?? 0, categorisedDifferently: counts?.different ?? 0 };
}

/**
 * Categorises the other transactions from the same merchant, when the person asks. Ones someone
 * already categorised are left alone unless they explicitly include them.
 */
export async function categoriseSimilar(db: D1Database, user: PortalUser, input: unknown) {
    const body = similarSchema.parse(input);
    await assertAssignable(db, body.categoryId);
    const row = await requireTransaction(db, user, body.transactionId);
    if (!row.merchant_key) return { updated: 0 };
    const targets = await db
        .prepare(
            `SELECT t.id, t.account_id, t.category_id ${SIMILAR} ${body.includeCategorised ? "AND COALESCE(t.category_id, '') <> ?4" : "AND t.category_id IS NULL AND ?4 IS NOT NULL"} LIMIT 2000`,
        )
        .bind(user.email, row.merchant_key, row.id, body.categoryId)
        .all<{ id: string; account_id: string; category_id: string | null }>();
    const ids = targets.results.map((t) => t.id);
    if (!ids.length) return { updated: 0 };
    return bulkCategorise(db, user, { ids: ids.slice(0, 500), categoryId: body.categoryId }).then(async (first) => {
        let updated = first.updated;
        for (let i = 500; i < ids.length; i += 500)
            updated += (await bulkCategorise(db, user, { ids: ids.slice(i, i + 500), categoryId: body.categoryId })).updated;
        return { updated };
    });
}

// --- Transfers ---------------------------------------------------------------------------------------

/** Links money out of one account with the same amount into another as one transfer. */
export async function linkTransfer(db: D1Database, user: PortalUser, outId: string, inId: string) {
    const [out, incoming] = await Promise.all([requireTransaction(db, user, outId), requireTransaction(db, user, inId)]);
    if (out.amount_cents >= 0 || incoming.amount_cents <= 0) throw new HttpError(422, "validation", "A transfer is money out of one account and into another");
    if (out.amount_cents !== -incoming.amount_cents) throw new HttpError(422, "validation", "The two amounts don't match");
    if (out.account_id === incoming.account_id) throw new HttpError(422, "validation", "A transfer is between two different accounts");
    if (out.transfer_id || incoming.transfer_id) throw new HttpError(409, "conflict", "One of these is already linked to another transfer");
    const id = newId("ftr");
    const now = nowIso();
    const free = "(SELECT COUNT(*) FROM finance_transactions WHERE id IN (?, ?) AND transfer_id IS NULL AND deleted_at IS NULL) = 2";
    const linked = "SELECT 1 FROM finance_transfers WHERE id = ? AND created_at = ?";
    await db.batch([
        db
            .prepare(`INSERT INTO finance_transfers (id, out_transaction_id, in_transaction_id, created_by, created_at) SELECT ?, ?, ?, ?, ? WHERE ${free}`)
            .bind(id, outId, inId, user.email, now, outId, inId),
        ...[outId, inId].map((tid) =>
            db
                .prepare(
                    `UPDATE finance_transactions SET is_transfer = 1, transfer_id = ?, category_id = NULL, category_source = NULL, version = version + 1, updated_by = ?, updated_at = ?
                     WHERE id = ? AND transfer_id IS NULL AND EXISTS (${linked})`,
                )
                .bind(id, user.email, now, tid, id, now),
        ),
        activityWhen(
            db,
            {
                actor: user.email,
                action: "transfer.link",
                entityType: "transfer",
                entityId: id,
                accountId: out.account_id,
                detail: { out: outId, in: inId, categories: [out.category_id, incoming.category_id] },
            },
            linked,
            id,
            now,
        ),
    ]);
    const made = await db.prepare("SELECT id FROM finance_transfers WHERE id = ?").bind(id).first();
    if (!made) throw new HttpError(409, "conflict", "One of these was linked to another transfer just now");
    return { out: await transactionView(db, user, outId), in: await transactionView(db, user, inId) };
}

export async function dismissTransfer(db: D1Database, user: PortalUser, outId: string, inId: string) {
    await Promise.all([requireTransaction(db, user, outId), requireTransaction(db, user, inId)]);
    await db
        .prepare(
            "INSERT INTO finance_transfer_dismissals (out_transaction_id, in_transaction_id, dismissed_by, dismissed_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
        )
        .bind(outId, inId, user.email, nowIso())
        .run();
}

/** Likely transfers among the caller's visible transactions in a window (default the last 120 days). */
export async function suggestTransfers(db: D1Database, user: PortalUser, window: { from: string; to: string }): Promise<TransferSuggestion[]> {
    const { transactions } = await listTransactions(db, user, { from: window.from, to: window.to }, 5000);
    const candidates = transactions.filter((t) => !t.isTransfer);
    if (!candidates.length) return [];
    const dismissed = await db
        .prepare(
            "SELECT out_transaction_id || ':' || in_transaction_id AS k FROM finance_transfer_dismissals WHERE out_transaction_id IN (SELECT t.id FROM finance_transactions t WHERE t.posted_on >= ? AND t.posted_on <= ?)",
        )
        .bind(shiftDays(window.from, -7), window.to)
        .all<{ k: string }>();
    const pairs = transferSuggestions(candidates, new Set(dismissed.results.map((r) => r.k)));
    const byId = new Map(candidates.map((t) => [t.id, t]));
    return pairs.slice(0, 100).map((p) => ({ out: byId.get(p.outId)!, in: byId.get(p.inId)!, days: p.days }));
}

// --- Export ------------------------------------------------------------------------------------------

export async function exportCsv(db: D1Database, user: PortalUser, filters: TransactionFilters) {
    const { transactions } = await listTransactions(db, user, filters, 5000);
    const names = new Map((await listCategories(db)).map((c) => [c.id, c.name]));
    const columns: CsvColumn<TransactionView>[] = [
        { header: "Date", value: (t) => t.postedOn },
        { header: "Account", value: (t) => t.accountName },
        { header: "Description", value: (t) => t.description },
        { header: "Amount", value: (t) => centsToDecimal(t.amountCents) },
        { header: "Category", value: (t) => (t.isTransfer ? "Transfer" : t.categoryId ? (names.get(t.categoryId) ?? t.categoryId) : "Uncategorised") },
        { header: "Note", value: (t) => t.note },
        { header: "Source", value: (t) => t.source },
    ];
    await activity(db, { actor: user.email, action: "export.transactions", entityType: "export", detail: { rows: transactions.length } }).run();
    return { filename: `transactions-${filters.from}-to-${filters.to}.csv`, csv: toCsv(transactions, columns) };
}
