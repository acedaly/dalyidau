// CSV imports: inspect a file, stage its rows for review, then commit, cancel or undo.
//
// Staging reads every row with the chosen layout (src/shared/finance/csv-import.ts) and classifies
// it: new; an exact duplicate of a transaction already in the ledger (same account, date, amount,
// description and occurrence that day: never imported again); a possible duplicate (the same amount
// within a few days with similar words, or a manual entry: a person decides); or invalid (kept with
// its reason, never imported, never hidden). Nothing reaches the ledger until someone commits.
//
// Committing is one D1 batch, so it's all or nothing: it claims the import (review → committing with
// a token), inserts the chosen rows that aren't already there, and marks it committed. The unique
// (account, fingerprint) index means a second commit, a retry, or the same file imported twice can't
// write a transaction twice. Cancelling drops the staged rows. Undoing soft-deletes what the import
// wrote, so the same file can be imported again.
import type { D1Database } from "@cloudflare/workers-types";
import { z } from "zod";
import { type ImportMapping, LIMITS, detectMapping, importMappingSchema, parseRows } from "../../src/shared/finance/csv-import";
import { detectDateFormat, shiftDays } from "../../src/shared/finance/dates";
import { DUPLICATE_WINDOW_DAYS, impliedOpening, possibleDuplicates } from "../../src/shared/finance/ledger";
import {
    type ImportDetail,
    type ImportPlan,
    type ImportRowStatus,
    type ImportRowView,
    type ImportSummary,
    type InspectResult,
    importCreateSchema,
    importDecisionSchema,
    inspectSchema,
} from "../../src/shared/finance/types";
import type { PortalUser } from "../../src/shared/portal/types";
import { parseCsvRows } from "../portal/csv";
import { newId, nowIso, parseJson } from "../portal/db";
import { HttpError } from "../portal/http";
import { ACCOUNT_VISIBLE, type AccountRow, activity, activityWhen, batchInChunks, conflict, notFound, requireAccount, sha256Hex } from "./access";

interface ImportRow {
    id: string;
    account_id: string;
    account_name: string;
    filename: string;
    file_sha256: string;
    mapping: string;
    status: ImportSummary["status"];
    rows_total: number;
    rows_new: number;
    rows_duplicate: number;
    rows_possible: number;
    rows_invalid: number;
    rows_imported: number | null;
    first_on: string | null;
    last_on: string | null;
    bank_closing_cents: number | null;
    warnings: string;
    created_by: string;
    created_at: string;
    committed_at: string | null;
    closed_at: string | null;
    version: number;
}

const summaryOf = (r: ImportRow): ImportSummary => {
    const mapping = importMappingSchema.safeParse(parseJson(r.mapping, null));
    return {
        id: r.id,
        accountId: r.account_id,
        accountName: r.account_name,
        filename: r.filename,
        status: r.status,
        preset: mapping.success ? mapping.data.preset : "custom",
        rowsTotal: r.rows_total,
        rowsNew: r.rows_new,
        rowsDuplicate: r.rows_duplicate,
        rowsPossible: r.rows_possible,
        rowsInvalid: r.rows_invalid,
        rowsImported: r.rows_imported,
        firstOn: r.first_on,
        lastOn: r.last_on,
        bankClosingCents: r.bank_closing_cents,
        warnings: parseJson<string[]>(r.warnings, []),
        createdBy: r.created_by,
        createdAt: r.created_at,
        committedAt: r.committed_at,
        closedAt: r.closed_at,
        version: r.version,
    };
};

const SELECT_IMPORT = `SELECT i.*, a.name AS account_name FROM finance_imports i JOIN finance_accounts a ON a.id = i.account_id`;

async function requireImport(db: D1Database, user: PortalUser, id: string): Promise<ImportRow> {
    const row = await db.prepare(`${SELECT_IMPORT} WHERE i.id = ?2 AND ${ACCOUNT_VISIBLE}`).bind(user.email, id).first<ImportRow>();
    if (!row) throw notFound();
    return row;
}

export async function listImports(db: D1Database, user: PortalUser, accountId?: string | null): Promise<ImportSummary[]> {
    const rows = await db
        .prepare(`${SELECT_IMPORT} WHERE ${ACCOUNT_VISIBLE} ${accountId ? "AND i.account_id = ?2" : ""} ORDER BY i.created_at DESC LIMIT 100`)
        .bind(user.email, ...(accountId ? [accountId] : []))
        .all<ImportRow>();
    return rows.results.map(summaryOf);
}

const readFile = (text: string) => {
    if (new TextEncoder().encode(text).byteLength > LIMITS.fileBytes)
        throw new HttpError(413, "too_large", "That file is larger than 2 MB. Export a shorter date range.");
    const rows = parseCsvRows(text);
    if (!rows.length) throw new HttpError(422, "validation", "The file has no rows");
    if (rows.length > LIMITS.rows + 25)
        throw new HttpError(422, "validation", `That file has more than ${LIMITS.rows.toLocaleString("en-AU")} rows. Export a shorter date range.`);
    if (rows.some((r) => r.cells.length > LIMITS.columns)) throw new HttpError(422, "validation", "That file has too many columns to be a bank export");
    return rows;
};

async function committedAt(db: D1Database, accountId: string, sha: string) {
    const row = await db
        .prepare(
            "SELECT committed_at FROM finance_imports WHERE account_id = ? AND file_sha256 = ? AND status = 'committed' ORDER BY committed_at DESC LIMIT 1",
        )
        .bind(accountId, sha)
        .first<{ committed_at: string }>();
    return row?.committed_at ?? null;
}

const savedMapping = (account: AccountRow): ImportMapping | null => {
    if (!account.import_mapping) return null;
    const parsed = importMappingSchema.safeParse(parseJson(account.import_mapping, null));
    return parsed.success ? parsed.data : null;
};

/** The first rows and a suggested layout, so the person can check the columns before staging. */
export async function inspectFile(db: D1Database, user: PortalUser, input: unknown): Promise<InspectResult> {
    const body = inspectSchema.parse(input);
    const account = await requireAccount(db, user, body.accountId);
    const rows = readFile(body.text);
    const cells = rows.map((r) => r.cells);
    const saved = savedMapping(account);
    // The layout this account used last time, if the file still fits it; otherwise the presets.
    let mapping: ImportMapping | null = null;
    if (saved) {
        const trial = parseRows(rows.slice(0, 50), saved);
        if (trial.rows.some((r) => r.ok)) mapping = saved;
    }
    mapping ??= detectMapping(cells, saved?.preset);
    const dateSamples = mapping ? cells.slice(mapping.skipLines + (mapping.hasHeader ? 1 : 0), 200).map((r) => r[mapping!.dateColumn] ?? "") : [];
    return {
        preview: cells.slice(0, 8).map((r) => r.map((c) => c.slice(0, 120))),
        columns: Math.max(...cells.slice(0, 50).map((r) => r.length)),
        mapping,
        dateAmbiguous: mapping ? detectDateFormat(dateSamples).ambiguous && mapping.dateFormat === "d/M/yyyy" : false,
        sameFileImportedAt: await committedAt(db, account.id, await sha256Hex(body.text)),
        lines: rows.length,
    };
}

/** Exact duplicates: transactions already in the ledger with these fingerprints. */
async function existingFingerprints(db: D1Database, accountId: string, fingerprints: string[]) {
    const found = new Map<string, string>();
    for (let i = 0; i < fingerprints.length; i += 90) {
        const chunk = fingerprints.slice(i, i + 90);
        const rows = await db
            .prepare(
                `SELECT id, fingerprint FROM finance_transactions WHERE account_id = ?1 AND deleted_at IS NULL AND fingerprint IN (${chunk.map((_, j) => `?${j + 2}`).join(", ")})`,
            )
            .bind(accountId, ...chunk)
            .all<{ id: string; fingerprint: string }>();
        for (const r of rows.results) found.set(r.fingerprint, r.id);
    }
    return found;
}

/** Stages a file for review. Re-sending the same file while it's under review returns that import. */
export async function createImport(db: D1Database, user: PortalUser, input: unknown): Promise<{ detail: ImportDetail; replayed: boolean }> {
    const body = importCreateSchema.parse(input);
    const account = await requireAccount(db, user, body.accountId);
    if (account.archived_at) throw new HttpError(422, "validation", "That account is archived. Restore it before importing.");
    const sha = await sha256Hex(body.text);
    const open = await db
        .prepare("SELECT id FROM finance_imports WHERE account_id = ? AND file_sha256 = ? AND status IN ('review', 'committing')")
        .bind(account.id, sha)
        .first<{ id: string }>();
    if (open) return { detail: await importDetail(db, user, open.id), replayed: true };

    const file = parseRows(readFile(body.text), body.mapping);
    const valid = file.rows.filter((r) => r.ok);
    if (!file.rows.length) throw new HttpError(422, "validation", "The file has no transactions after its header");
    if (!valid.length) {
        const first = file.rows[0];
        throw new HttpError(422, "validation", `None of the rows could be read with this layout. Line ${first.line}: ${first.error}`);
    }

    const fingerprints = new Map<number, string>();
    for (const row of valid) fingerprints.set(row.line, await sha256Hex(`${account.id}|${row.key}`));
    const exact = await existingFingerprints(db, account.id, [...fingerprints.values()]);

    // Possible duplicates among the rest: the ledger near these dates, minus what's matched exactly.
    const dates = valid.map((r) => r.postedOn!).sort();
    const claimed = new Set(exact.values());
    const nearby = await db
        .prepare(
            "SELECT id, posted_on, amount_cents, description, source FROM finance_transactions WHERE account_id = ? AND deleted_at IS NULL AND posted_on >= ? AND posted_on <= ? LIMIT 20000",
        )
        .bind(account.id, shiftDays(dates[0], -DUPLICATE_WINDOW_DAYS), shiftDays(dates[dates.length - 1], DUPLICATE_WINDOW_DAYS))
        .all<{ id: string; posted_on: string; amount_cents: number; description: string; source: "import" | "manual" }>();
    const fresh = valid.filter((r) => !exact.has(fingerprints.get(r.line)!));
    const possible = possibleDuplicates(
        fresh.map((r) => ({ line: r.line, postedOn: r.postedOn!, amountCents: r.amountCents!, description: r.description! })),
        nearby.results
            .filter((t) => !claimed.has(t.id))
            .map((t) => ({ id: t.id, postedOn: t.posted_on, amountCents: t.amount_cents, description: t.description, source: t.source })),
    );

    const statusOf = (line: number, ok: boolean): ImportRowStatus =>
        !ok ? "invalid" : exact.has(fingerprints.get(line)!) ? "duplicate" : possible.has(line) ? "possible_duplicate" : "new";
    const counts = { new: 0, duplicate: 0, possible_duplicate: 0, invalid: 0 };
    for (const row of file.rows) counts[statusOf(row.line, row.ok)]++;

    const warnings = [...file.warnings];
    if (account.number_hint && file.accountEndings.length && !file.accountEndings.some((e) => e.endsWith(account.number_hint!)))
        warnings.push(`This file's account number doesn't end in ${account.number_hint}, the digits saved for ${account.name}. Check it's the right account.`);
    if (account.opening_balance_on && dates[0] < account.opening_balance_on)
        warnings.push("Some rows are dated before the account's starting balance. They'll be listed, but they don't change the balance.");
    const previously = await committedAt(db, account.id, sha);
    if (previously) warnings.push("This exact file was imported before. Rows already in the ledger are marked as duplicates and won't be imported again.");
    const last = [...valid].sort((a, b) => b.position - a.position)[0];

    const id = newId("fim");
    const now = nowIso();
    const importStatement = db
        .prepare(
            `INSERT INTO finance_imports (id, account_id, filename, file_sha256, mapping, rows_total, rows_new, rows_duplicate, rows_possible, rows_invalid, first_on, last_on, bank_closing_cents, warnings, created_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
            id,
            account.id,
            body.filename,
            sha,
            JSON.stringify(body.mapping),
            file.rows.length,
            counts.new,
            counts.duplicate,
            counts.possible_duplicate,
            counts.invalid,
            dates[0],
            dates[dates.length - 1],
            last.bankBalanceCents,
            JSON.stringify(warnings).slice(0, 2000),
            user.email,
            now,
        );
    const rowStatements = file.rows.map((row) => {
        const fingerprint = row.ok ? fingerprints.get(row.line)! : null;
        const status = statusOf(row.line, row.ok);
        return db
            .prepare(
                `INSERT INTO finance_import_rows (import_id, line, position, status, posted_on, amount_cents, description, merchant, merchant_key, bank_category, bank_balance_cents, fingerprint, match_transaction_id, error)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
                id,
                row.line,
                row.position,
                status,
                row.postedOn,
                row.amountCents,
                row.description,
                row.merchant,
                row.merchantKey,
                row.bankCategory,
                row.bankBalanceCents,
                fingerprint,
                status === "duplicate" ? exact.get(fingerprint!)! : status === "possible_duplicate" ? possible.get(row.line)! : null,
                row.error?.slice(0, 300) ?? null,
            );
    });
    try {
        await db.batch([
            importStatement,
            ...rowStatements.slice(0, 199),
            activity(db, {
                actor: user.email,
                action: "import.stage",
                entityType: "import",
                entityId: id,
                accountId: account.id,
                detail: { rows: file.rows.length, ...counts },
            }),
        ]);
        await batchInChunks(db, rowStatements.slice(199));
    } catch (error) {
        // Never leave a half-staged import behind.
        await db.batch([
            db.prepare("DELETE FROM finance_import_rows WHERE import_id = ?").bind(id),
            db.prepare("DELETE FROM finance_imports WHERE id = ? AND status = 'review'").bind(id),
        ]);
        if (String(error).includes("finance_imports_open_file") || String(error).includes("UNIQUE")) {
            const again = await db
                .prepare("SELECT id FROM finance_imports WHERE account_id = ? AND file_sha256 = ? AND status IN ('review', 'committing')")
                .bind(account.id, sha)
                .first<{ id: string }>();
            if (again) return { detail: await importDetail(db, user, again.id), replayed: true };
        }
        throw error;
    }
    return { detail: await importDetail(db, user, id), replayed: false };
}

interface StagedRow {
    line: number;
    position: number;
    status: ImportRowStatus;
    decision: "include" | "skip" | null;
    posted_on: string | null;
    amount_cents: number | null;
    description: string | null;
    bank_balance_cents: number | null;
    error: string | null;
    m_id: string | null;
    m_on: string | null;
    m_amount: number | null;
    m_description: string | null;
    m_source: "import" | "manual" | null;
}

export const planOf = (rows: readonly Pick<ImportRowView, "status" | "decision">[]): ImportPlan => {
    const plan: ImportPlan = { toImport: 0, excluded: 0, duplicates: 0, invalid: 0, undecided: 0 };
    for (const row of rows) {
        if (row.status === "invalid") plan.invalid++;
        else if (row.status === "duplicate") plan.duplicates++;
        else if (row.status === "possible_duplicate" && row.decision === null) plan.undecided++;
        else if (row.decision === "skip") plan.excluded++;
        else plan.toImport++;
    }
    return plan;
};

export async function importDetail(db: D1Database, user: PortalUser, id: string): Promise<ImportDetail> {
    const row = await requireImport(db, user, id);
    const staged = await db
        .prepare(
            `SELECT r.line, r.position, r.status, r.decision, r.posted_on, r.amount_cents, r.description, r.bank_balance_cents, r.error,
                t.id AS m_id, t.posted_on AS m_on, t.amount_cents AS m_amount, t.description AS m_description, t.source AS m_source
             FROM finance_import_rows r LEFT JOIN finance_transactions t ON t.id = r.match_transaction_id AND t.account_id = ?2
             WHERE r.import_id = ?1 ORDER BY r.position DESC`,
        )
        .bind(id, row.account_id)
        .all<StagedRow>();
    const rows: ImportRowView[] = staged.results.map((r) => ({
        line: r.line,
        position: r.position,
        status: r.status,
        decision: r.decision,
        postedOn: r.posted_on,
        amountCents: r.amount_cents,
        description: r.description,
        bankBalanceCents: r.bank_balance_cents,
        error: r.error,
        match: r.m_id ? { id: r.m_id, postedOn: r.m_on!, amountCents: r.m_amount!, description: r.m_description!, source: r.m_source! } : null,
    }));
    const account = await db
        .prepare("SELECT opening_balance_on FROM finance_accounts WHERE id = ?")
        .bind(row.account_id)
        .first<{ opening_balance_on: string | null }>();
    const mapping = importMappingSchema.parse(parseJson(row.mapping, null));
    return {
        summary: summaryOf(row),
        rows,
        plan: planOf(rows),
        mapping,
        impliedOpening: impliedOpening(
            rows
                .filter((r) => r.status !== "invalid")
                .map((r) => ({ position: r.position, postedOn: r.postedOn!, amountCents: r.amountCents!, bankBalanceCents: r.bankBalanceCents })),
        ),
        accountHasOpening: !!account?.opening_balance_on,
        sameFileImportedAt: row.status === "review" ? await committedAt(db, row.account_id, row.file_sha256) : null,
    };
}

const reviewing = (row: ImportRow) => {
    if (row.status !== "review")
        throw new HttpError(
            409,
            "conflict",
            row.status === "committed" ? "This import has already been committed" : "This import is no longer open for review",
        );
};

/** Include or skip rows. Exact duplicates and invalid rows can't be included. */
export async function decideRows(db: D1Database, user: PortalUser, id: string, input: unknown): Promise<ImportDetail> {
    const body = importDecisionSchema.parse(input);
    const row = await requireImport(db, user, id);
    reviewing(row);
    const now = nowIso();
    const guard = "SELECT 1 FROM finance_imports WHERE id = ? AND status = 'review' AND commit_token = ?";
    const token = `decide:${now}`;
    const statements = [
        db
            .prepare("UPDATE finance_imports SET version = version + 1, commit_token = ? WHERE id = ? AND status = 'review' AND version = ?")
            .bind(token, id, body.version),
        ...body.decisions.map((d) =>
            db
                .prepare(
                    `UPDATE finance_import_rows SET decision = ? WHERE import_id = ? AND line = ? AND status IN ('new', 'possible_duplicate') AND EXISTS (${guard})`,
                )
                .bind(d.decision, id, d.line, id, token),
        ),
    ];
    const [first] = await db.batch(statements.slice(0, 200));
    if (!first.meta.changes) throw conflict("This import was changed somewhere else. Reload and try again.");
    await batchInChunks(db, statements.slice(200));
    return importDetail(db, user, id);
}

const versionOnly = z.object({ version: z.number().int().min(1) }).strict();

export async function commitImport(db: D1Database, user: PortalUser, id: string, input: unknown): Promise<{ detail: ImportDetail; replayed: boolean }> {
    const { version } = versionOnly.parse(input);
    const row = await requireImport(db, user, id);
    if (row.status === "committed") return { detail: await importDetail(db, user, id), replayed: true };
    reviewing(row);
    const detail = await importDetail(db, user, id);
    if (detail.plan.undecided)
        throw new HttpError(422, "validation", `Decide on ${detail.plan.undecided} possible duplicate${detail.plan.undecided === 1 ? "" : "s"} first`);
    const token = newId("tok");
    const now = nowIso();
    const claimed = "SELECT 1 FROM finance_imports WHERE id = ? AND status = 'committing' AND commit_token = ?";
    const done = "SELECT 1 FROM finance_imports WHERE id = ? AND status = 'committed' AND commit_token = ?";
    const [claim] = await db.batch([
        db
            .prepare(
                "UPDATE finance_imports SET status = 'committing', commit_token = ?, version = version + 1 WHERE id = ? AND status = 'review' AND version = ?",
            )
            .bind(token, id, version),
        db
            .prepare(
                `INSERT INTO finance_transactions (id, account_id, posted_on, sequence, amount_cents, description, merchant, merchant_key, source, import_id, import_line, fingerprint, bank_balance_cents, bank_category, created_by, created_at, updated_by, updated_at)
                 SELECT 'ftx_' || lower(hex(randomblob(7))), ?, r.posted_on, r.position, r.amount_cents, r.description, r.merchant, r.merchant_key, 'import', r.import_id, r.line, r.fingerprint, r.bank_balance_cents, r.bank_category, ?, ?, ?, ?
                 FROM finance_import_rows r
                 WHERE r.import_id = ? AND EXISTS (${claimed})
                   AND ((r.status = 'new' AND COALESCE(r.decision, 'include') = 'include') OR (r.status = 'possible_duplicate' AND r.decision = 'include'))
                   AND NOT EXISTS (SELECT 1 FROM finance_transactions x WHERE x.account_id = ? AND x.fingerprint = r.fingerprint AND x.deleted_at IS NULL)
                 ORDER BY r.position`,
            )
            .bind(row.account_id, user.email, now, user.email, now, id, id, token, row.account_id),
        db
            .prepare(
                `UPDATE finance_imports SET status = 'committed', rows_imported = (SELECT COUNT(*) FROM finance_transactions WHERE import_id = ?), committed_by = ?, committed_at = ?, version = version + 1
                 WHERE id = ? AND status = 'committing' AND commit_token = ?`,
            )
            .bind(id, user.email, now, id, token),
        // Remember the layout for the account's next import (not a change to the account's own details).
        db.prepare(`UPDATE finance_accounts SET import_mapping = ? WHERE id = ? AND EXISTS (${done})`).bind(row.mapping, row.account_id, id, token),
        activityWhen(
            db,
            { actor: user.email, action: "import.commit", entityType: "import", entityId: id, accountId: row.account_id, detail: { ...detail.plan } },
            done,
            id,
            token,
        ),
    ]);
    if (!claim.meta.changes) {
        const now2 = await requireImport(db, user, id);
        if (now2.status === "committed") return { detail: await importDetail(db, user, id), replayed: true };
        throw conflict("This import was changed somewhere else. Reload and try again.");
    }
    return { detail: await importDetail(db, user, id), replayed: false };
}

/** Drops a staged import before it's committed. Nothing reaches the ledger. */
export async function cancelImport(db: D1Database, user: PortalUser, id: string, input: unknown) {
    const { version } = versionOnly.parse(input);
    const row = await requireImport(db, user, id);
    if (row.status === "cancelled") return;
    reviewing(row);
    const now = nowIso();
    const cancelled = "SELECT 1 FROM finance_imports WHERE id = ? AND status = 'cancelled' AND closed_at = ?";
    const [result] = await db.batch([
        db
            .prepare(
                "UPDATE finance_imports SET status = 'cancelled', closed_by = ?, closed_at = ?, version = version + 1 WHERE id = ? AND status = 'review' AND version = ?",
            )
            .bind(user.email, now, id, version),
        db.prepare(`DELETE FROM finance_import_rows WHERE import_id = ? AND EXISTS (${cancelled})`).bind(id, id, now),
        activityWhen(db, { actor: user.email, action: "import.cancel", entityType: "import", entityId: id, accountId: row.account_id }, cancelled, id, now),
    ]);
    if (!result.meta.changes) throw conflict("This import was changed somewhere else. Reload and try again.");
}

/**
 * Takes a committed import back out of the ledger: its transactions are soft-deleted (with their
 * categories, for the record) and any transfer links to them removed. Needs sight of both sides of
 * every linked transfer.
 */
export async function undoImport(db: D1Database, user: PortalUser, id: string, input: unknown) {
    const { version, confirm } = z
        .object({ version: z.number().int().min(1), confirm: z.literal(true) })
        .strict()
        .parse(input);
    void confirm;
    const row = await requireImport(db, user, id);
    if (row.status !== "committed") throw new HttpError(409, "conflict", "Only a committed import can be undone");
    const hidden = await db
        .prepare(
            `SELECT COUNT(*) AS n FROM finance_transactions t JOIN finance_transfers tr ON tr.id = t.transfer_id
             JOIN finance_transactions o ON o.id = CASE WHEN tr.out_transaction_id = t.id THEN tr.in_transaction_id ELSE tr.out_transaction_id END
             JOIN finance_accounts oa ON oa.id = o.account_id
             WHERE t.import_id = ? AND t.deleted_at IS NULL AND NOT (oa.owner_email = ? OR oa.visibility = 'shared')`,
        )
        .bind(id, user.email)
        .first<{ n: number }>();
    if (hidden?.n) throw new HttpError(403, "forbidden", "Some of these transactions are linked to transfers in an account not shared with you");
    const now = nowIso();
    const undone = "SELECT 1 FROM finance_imports WHERE id = ? AND status = 'undone' AND closed_at = ?";
    const linked = "SELECT transfer_id FROM finance_transactions WHERE import_id = ? AND transfer_id IS NOT NULL AND deleted_at IS NULL";
    const [result] = await db.batch([
        db
            .prepare(
                "UPDATE finance_imports SET status = 'undone', closed_by = ?, closed_at = ?, version = version + 1 WHERE id = ? AND status = 'committed' AND version = ?",
            )
            .bind(user.email, now, id, version),
        db
            .prepare(
                `UPDATE finance_transactions SET is_transfer = 0, transfer_id = NULL, version = version + 1, updated_by = ?, updated_at = ?
                 WHERE transfer_id IN (${linked}) AND (import_id IS NULL OR import_id <> ?) AND EXISTS (${undone})`,
            )
            .bind(user.email, now, id, id, id, now),
        db.prepare(`DELETE FROM finance_transfers WHERE id IN (${linked}) AND EXISTS (${undone})`).bind(id, id, now),
        db
            .prepare(
                `UPDATE finance_transactions SET deleted_at = ?, deleted_by = ?, is_transfer = 0, transfer_id = NULL, version = version + 1, updated_by = ?, updated_at = ?
                 WHERE import_id = ? AND deleted_at IS NULL AND EXISTS (${undone})`,
            )
            .bind(now, user.email, user.email, now, id, id, now),
        activityWhen(
            db,
            { actor: user.email, action: "import.undo", entityType: "import", entityId: id, accountId: row.account_id, detail: { rows: row.rows_imported } },
            undone,
            id,
            now,
        ),
    ]);
    if (!result.meta.changes) throw conflict("This import was changed somewhere else. Reload and try again.");
}
