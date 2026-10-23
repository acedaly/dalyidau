// Household Finance (Milestone 11.1) through the portal API with real (local) D1: accounts,
// importing NAB CSV files (review, duplicates across overlapping files, invalid rows, commit,
// cancel, undo), balances checked against the bank, categorising, transfers, the overview,
// export, and who can see what. See docs/HOUSEHOLD_FINANCE.md.
import { beforeEach, describe, expect, it } from "vitest";
import { NAB_CREDIT_CARD, NAB_FILE_A, NAB_FILE_B, NAB_HEADERLESS, NAB_SAVINGS } from "../fixtures/finance/fixtures";
import type { AccountView, FinanceOverview, ImportDetail, ImportSummary, TransactionView } from "../src/shared/finance/types";
import {
    A,
    ADMIN,
    B,
    EDITOR,
    account,
    addPortalUser,
    byDescription,
    commit,
    fin,
    getAccount,
    importFile,
    inspect,
    stage,
    transactions,
} from "./finance-helpers";
import { accessToken, db, call as rawCall, resetPortal } from "./portal-helpers";

beforeEach(resetPortal);

const everyday = (email = A, visibility: "private" | "shared" = "shared") =>
    account({ name: "Everyday", institution: "NAB", numberHint: "4321", openingBalanceCents: 250000, openingBalanceOn: "2026-09-01", visibility }, email);

const overview = async (query = "from=2026-09-01&to=2026-09-30", email = A) => {
    const result = await fin<{ overview: FinanceOverview }>("GET", `/overview?${query}`, undefined, email);
    expect(result.status, result.text).toBe(200);
    return result.json.overview;
};

describe("access", () => {
    it("is for the household's owners only", async () => {
        await addPortalUser(ADMIN, "admin");
        await addPortalUser(EDITOR, "editor");
        expect((await fin("GET", "/accounts")).status).toBe(200);
        expect((await fin("GET", "/accounts", undefined, B)).status).toBe(200);
        expect((await fin("GET", "/accounts", undefined, ADMIN)).status).toBe(403);
        expect((await fin("GET", "/accounts", undefined, EDITOR)).status).toBe(403);
        expect((await rawCall("/portal/finance", { token: await accessToken({ email: ADMIN }) })).status).toBe(403);
        expect((await rawCall("/api/portal/finance/accounts")).status).toBe(401);
        const page = await rawCall("/portal/finance", { token: await accessToken({ email: A }) });
        expect(page.status).toBe(200);
    });

    it("refuses cross-site requests, including the export", async () => {
        const token = await accessToken({ email: A });
        const csv = await rawCall("/api/portal/finance/transactions.csv", { token, headers: { "Sec-Fetch-Site": "cross-site" } });
        expect(csv.status).toBe(403);
        const post = await rawCall("/api/portal/finance/accounts", {
            method: "POST",
            token,
            headers: { Origin: "https://evil.example", "Content-Type": "application/json" },
            body: JSON.stringify({ name: "x", kind: "cash" }),
        });
        expect(post.status).toBe(403);
    });

    it("keeps a private account and its transactions from the other owner everywhere", async () => {
        const mine = await account({ name: "My card", kind: "credit_card", openingBalanceCents: -100000, openingBalanceOn: "2026-09-01" });
        await importFile(mine.id, NAB_CREDIT_CARD);
        const ours = await everyday();
        await importFile(ours.id, NAB_FILE_A);

        // B sees only the shared account, its transactions and totals.
        expect((await fin<{ accounts: AccountView[] }>("GET", "/accounts", undefined, B)).json.accounts.map((a) => a.name)).toEqual(["Everyday"]);
        expect((await fin("GET", `/accounts/${mine.id}`, undefined, B)).status).toBe(404);
        expect((await rawCall(`/portal/finance/accounts/${mine.id}`, { token: await accessToken({ email: B }) })).status).toBe(404);
        const theirs = await transactions("", B);
        expect(theirs.every((t) => t.accountId === ours.id)).toBe(true);
        expect(byDescription(await transactions(`&q=JB`, B), "JB")).toHaveLength(0);
        const card = byDescription(await transactions(), "JB HI-FI")[0];
        expect((await fin("GET", `/transactions/${card.id}`, undefined, B)).status).toBe(404);
        expect((await fin("PATCH", `/transactions/${card.id}`, { version: card.version, categoryId: "shopping" }, B)).status).toBe(404);
        const bView = await overview(`from=2026-09-01&to=2026-09-30&accounts=${mine.id}`, B);
        expect(bView.accounts.map((a) => a.id)).toEqual([ours.id]);
        expect(bView.totals.expenseCents).toBe((await overview("from=2026-09-01&to=2026-09-30", B)).totals.expenseCents);
        expect(bView.totals.expenseCents).toBe(74584); // file A only (its transfer is spending until linked), never A's card
        const exported = await rawCall("/api/portal/finance/transactions.csv?from=2026-01-01&to=2026-12-31", { token: await accessToken({ email: B }) });
        expect(await exported.text()).not.toContain("JB HI-FI");
        // Imports of a private account are private too.
        expect((await fin<{ imports: ImportSummary[] }>("GET", "/imports", undefined, B)).json.imports.every((i) => i.accountId === ours.id)).toBe(true);

        // A sees both.
        expect((await fin<{ accounts: AccountView[] }>("GET", "/accounts")).json.accounts).toHaveLength(2);
    });

    it("lets only the owner change an account's sharing, starting balance or archive it", async () => {
        const ours = await everyday();
        const rename = await fin<{ account: AccountView }>("PATCH", `/accounts/${ours.id}`, { version: ours.version, name: "Joint everyday" }, B);
        expect(rename.status, rename.text).toBe(200);
        const hide = await fin("PATCH", `/accounts/${ours.id}`, { version: rename.json.account.version, visibility: "private" }, B);
        expect(hide.status).toBe(403);
        const opening = await fin(
            "PATCH",
            `/accounts/${ours.id}`,
            { version: rename.json.account.version, openingBalanceCents: 1, openingBalanceOn: "2026-09-01" },
            B,
        );
        expect(opening.status).toBe(403);
        // A stale version is refused, never overwritten.
        expect((await fin("PATCH", `/accounts/${ours.id}`, { version: ours.version, name: "Stale" })).status).toBe(409);
        expect((await getAccount(ours.id)).name).toBe("Joint everyday");
        // Made private by its owner, it disappears for B.
        expect((await fin("PATCH", `/accounts/${ours.id}`, { version: rename.json.account.version, visibility: "private" })).status).toBe(200);
        expect((await fin("GET", `/accounts/${ours.id}`, undefined, B)).status).toBe(404);
    });

    it("stores no full account numbers or raw lines", async () => {
        expect((await fin("POST", "/accounts", { name: "x", kind: "transaction", numberHint: "123456789" })).status).toBe(422);
        const ours = await everyday();
        await importFile(ours.id, NAB_FILE_A);
        const tables = ["finance_accounts", "finance_imports", "finance_import_rows", "finance_transactions", "finance_activity"];
        for (const table of tables) {
            const rows = await db().prepare(`SELECT * FROM ${table}`).all();
            expect(JSON.stringify(rows.results), table).not.toContain("000004321");
        }
    });
});

describe("importing a NAB file", () => {
    it("previews, stages for review, and commits only when asked", async () => {
        const ours = await everyday();
        const inspection = await inspect(ours.id, NAB_FILE_A);
        expect(inspection.mapping).toMatchObject({ preset: "nab", dateFormat: "d MMM yy" });
        expect(inspection.preview[0][0]).toBe("Date");
        expect(inspection.sameFileImportedAt).toBeNull();

        const staged = await stage(ours.id, NAB_FILE_A);
        expect(staged.summary).toMatchObject({
            status: "review",
            rowsTotal: 8,
            rowsNew: 8,
            rowsDuplicate: 0,
            rowsInvalid: 0,
            firstOn: "2026-09-01",
            lastOn: "2026-09-12",
            bankClosingCents: 495416,
        });
        expect(staged.plan).toEqual({ toImport: 8, excluded: 0, duplicates: 0, invalid: 0, undecided: 0 });
        // Nothing reaches the ledger while it's under review.
        expect(await transactions()).toHaveLength(0);

        const done = await commit(staged);
        expect(done.summary).toMatchObject({ status: "committed", rowsImported: 8 });
        const list = await transactions();
        expect(list).toHaveLength(8);
        expect(byDescription(list, "CAFE NERO")).toHaveLength(2);
        expect(list[0]).toMatchObject({ postedOn: "2026-09-12", amountCents: -7140, merchant: "Ampol", source: "import", categoryId: null });

        // The balance matches the bank's own closing balance in the file.
        const after = await getAccount(ours.id);
        expect(after.balance).toMatchObject({ status: "matches_bank", balanceCents: 495416, checkedOn: "2026-09-12", differenceCents: 0 });
        expect(after.lastPreset).toBe("nab");
    });

    it("never imports the same transaction twice: same file, overlapping files, repeated commits", async () => {
        const ours = await everyday();
        const first = await stage(ours.id, NAB_FILE_A);
        await commit(first);
        // Committing again (a retry or double click) changes nothing.
        const again = await fin<{ detail: ImportDetail; replayed: boolean }>("POST", `/imports/${first.summary.id}/commit`, { version: first.summary.version });
        expect(again.json.replayed).toBe(true);
        expect(await transactions()).toHaveLength(8);

        // The same file again: every row is an exact duplicate.
        expect((await inspect(ours.id, NAB_FILE_A)).sameFileImportedAt).not.toBeNull();
        const same = await stage(ours.id, NAB_FILE_A);
        expect(same.summary).toMatchObject({ rowsNew: 0, rowsDuplicate: 8 });
        expect(same.summary.warnings.join(" ")).toMatch(/imported before/);
        expect(same.rows.every((r) => r.match !== null)).toBe(true);
        expect((await commit(same)).summary.rowsImported).toBe(0);
        expect(await transactions()).toHaveLength(8);

        // An overlapping file: the two shared rows are duplicates, the invalid rows are reported.
        const overlap = await stage(ours.id, NAB_FILE_B);
        expect(overlap.summary).toMatchObject({ rowsTotal: 7, rowsNew: 3, rowsDuplicate: 2, rowsInvalid: 2 });
        expect(overlap.rows.filter((r) => r.status === "invalid").map((r) => [r.line, r.error])).toEqual([
            [3, '"31 Feb 26" isn\'t a date in the chosen format'],
            [5, "The amount is zero"],
        ]);
        const done = await commit(overlap);
        expect(done.summary.rowsImported).toBe(3);
        expect(await transactions()).toHaveLength(11);
        expect((await getAccount(ours.id)).balance).toMatchObject({ status: "matches_bank", balanceCents: 780916 });
    });

    it("returns the open import when the same file is staged twice", async () => {
        const ours = await everyday();
        const one = await stage(ours.id, NAB_FILE_A);
        const two = await stage(ours.id, NAB_FILE_A);
        expect(two.summary.id).toBe(one.summary.id);
    });

    it("can exclude rows, and cancel before committing", async () => {
        const ours = await everyday();
        const staged = await stage(ours.id, NAB_FILE_A);
        const netflix = staged.rows.find((r) => r.description?.includes("NETFLIX"))!;
        const decided = await fin<{ detail: ImportDetail }>("PATCH", `/imports/${staged.summary.id}/rows`, {
            version: staged.summary.version,
            decisions: [{ line: netflix.line, decision: "skip" }],
        });
        expect(decided.status, decided.text).toBe(200);
        expect(decided.json.detail.plan).toMatchObject({ toImport: 7, excluded: 1 });
        // The old version is refused.
        expect(
            (await fin("PATCH", `/imports/${staged.summary.id}/rows`, { version: staged.summary.version, decisions: [{ line: 2, decision: "skip" }] })).status,
        ).toBe(409);

        const cancel = await fin("POST", `/imports/${staged.summary.id}/cancel`, { version: decided.json.detail.summary.version });
        expect(cancel.status, cancel.text).toBe(200);
        expect(await transactions()).toHaveLength(0);
        expect((await db().prepare("SELECT COUNT(*) AS n FROM finance_import_rows").first<{ n: number }>())!.n).toBe(0);
        expect((await fin("POST", `/imports/${staged.summary.id}/commit`, { version: decided.json.detail.summary.version + 1 })).status).toBe(409);

        // Staged again and committed with the exclusion.
        const again = await stage(ours.id, NAB_FILE_A);
        const skip = await fin<{ detail: ImportDetail }>("PATCH", `/imports/${again.summary.id}/rows`, {
            version: again.summary.version,
            decisions: [{ line: netflix.line, decision: "skip" }],
        });
        await commit(skip.json.detail);
        expect(byDescription(await transactions(), "NETFLIX")).toHaveLength(0);
        // Without Netflix the ledger no longer matches the bank, and says so.
        expect((await getAccount(ours.id)).balance).toMatchObject({ status: "mismatch", differenceCents: -1899 });
    });

    it("asks about possible duplicates, such as something entered by hand", async () => {
        const ours = await everyday();
        const manual = await fin<{ transaction: TransactionView }>("POST", "/transactions", {
            accountId: ours.id,
            postedOn: "2026-09-11",
            amountCents: -7140,
            description: "Fuel",
            categoryId: "fuel",
            clientId: "manual-fuel-0001",
        });
        expect(manual.status, manual.text).toBe(201);
        const staged = await stage(ours.id, NAB_FILE_A);
        expect(staged.summary.rowsPossible).toBe(1);
        expect(staged.plan.undecided).toBe(1);
        const row = staged.rows.find((r) => r.status === "possible_duplicate")!;
        expect(row.match).toMatchObject({ id: manual.json.transaction.id, source: "manual" });
        // Can't commit until it's decided.
        expect((await fin("POST", `/imports/${staged.summary.id}/commit`, { version: staged.summary.version })).status).toBe(422);
        const decided = await fin<{ detail: ImportDetail }>("PATCH", `/imports/${staged.summary.id}/rows`, {
            version: staged.summary.version,
            decisions: [{ line: row.line, decision: "skip" }],
        });
        await commit(decided.json.detail);
        expect(byDescription(await transactions(), "AMPOL")).toHaveLength(0);
        expect(byDescription(await transactions(), "Fuel")).toHaveLength(1);
    });

    it("can undo a committed import, and the file can be imported again", async () => {
        const ours = await everyday();
        const done = await importFile(ours.id, NAB_FILE_A);
        expect((await fin("POST", `/imports/${done.summary.id}/undo`, { version: done.summary.version })).status).toBe(422);
        const undo = await fin("POST", `/imports/${done.summary.id}/undo`, { version: done.summary.version, confirm: true });
        expect(undo.status, undo.text).toBe(200);
        expect(await transactions()).toHaveLength(0);
        // Kept, soft-deleted, for the record.
        expect((await db().prepare("SELECT COUNT(*) AS n FROM finance_transactions WHERE deleted_at IS NOT NULL").first<{ n: number }>())!.n).toBe(8);
        const again = await stage(ours.id, NAB_FILE_A);
        expect(again.summary.rowsNew).toBe(8);
        await commit(again);
        expect(await transactions()).toHaveLength(8);
    });

    it("reads the older headerless layout and suggests a starting balance from the bank's", async () => {
        const savings = await account({ name: "Savings", kind: "savings" });
        const staged = await stage(savings.id, NAB_HEADERLESS);
        expect(staged.impliedOpening).toEqual({ on: "2026-10-01", cents: 0 });
        expect(staged.accountHasOpening).toBe(false);
        await commit(staged);
        // No starting balance yet: never shown as zero.
        expect((await getAccount(savings.id)).balance).toMatchObject({ status: "incomplete", balanceCents: null });
        const set = await fin<{ account: AccountView }>("PATCH", `/accounts/${savings.id}`, {
            version: savings.version,
            openingBalanceCents: 0,
            openingBalanceOn: "2026-10-01",
        });
        expect(set.json.account.balance).toMatchObject({ status: "matches_bank", balanceCents: 117620 });
    });

    it("warns when the file's account number doesn't match the account", async () => {
        const other = await account({ name: "Other", numberHint: "9999" });
        const staged = await stage(other.id, NAB_FILE_A);
        expect(staged.summary.warnings.join(" ")).toMatch(/doesn't end in 9999/);
    });

    it("refuses a layout that reads nothing, and files too large", async () => {
        const ours = await everyday();
        const { mapping } = await inspect(ours.id, NAB_FILE_A);
        const wrong = await fin("POST", "/imports", {
            accountId: ours.id,
            filename: "x.csv",
            text: NAB_FILE_A,
            mapping: { ...mapping, dateFormat: "yyyy-MM-dd" },
        });
        expect(wrong.status).toBe(422);
        expect(wrong.text).toMatch(/None of the rows/);
        const big = await fin("POST", "/imports/inspect", { accountId: ours.id, text: `${"x".repeat(2_100_000)}` });
        expect(big.status).toBe(413);
    });

    it("lets the other owner import into a shared account, but not into a private one", async () => {
        const ours = await everyday();
        const mine = await account({ name: "Mine", visibility: "private" });
        expect((await importFile(ours.id, NAB_FILE_A, B)).summary.rowsImported).toBe(8);
        expect((await fin("POST", "/imports/inspect", { accountId: mine.id, text: NAB_FILE_A }, B)).status).toBe(404);
    });
});

describe("categorising", () => {
    it("categorises one, then the others from the same merchant when asked, never overwriting a choice", async () => {
        const ours = await everyday();
        await importFile(ours.id, NAB_FILE_A);
        await importFile(ours.id, NAB_FILE_B);
        const [woolworthsLatest, woolworthsEarlier] = byDescription(await transactions(), "WOOLWORTHS");
        expect(woolworthsLatest.merchantKey).toBe("WOOLWORTHS");

        const first = await fin<{ transaction: TransactionView }>("PATCH", `/transactions/${woolworthsLatest.id}`, {
            version: woolworthsLatest.version,
            categoryId: "groceries",
        });
        expect(first.json.transaction).toMatchObject({ categoryId: "groceries", categorySource: "manual" });
        const counts = await fin<{ uncategorised: number }>("GET", `/transactions/${woolworthsLatest.id}/similar?category=groceries`);
        expect(counts.json.uncategorised).toBe(1);

        // Someone categorised the earlier one differently; "the others" leaves it alone unless asked.
        await fin("PATCH", `/transactions/${woolworthsEarlier.id}`, { version: woolworthsEarlier.version, categoryId: "shopping" });
        const similar = await fin<{ updated: number }>("POST", "/transactions/similar", { transactionId: woolworthsLatest.id, categoryId: "groceries" });
        expect(similar.json.updated).toBe(0);
        expect(byDescription(await transactions(), "WOOLWORTHS 1234")[0].categoryId).toBe("shopping");
        const forced = await fin<{ updated: number }>("POST", "/transactions/similar", {
            transactionId: woolworthsLatest.id,
            categoryId: "groceries",
            includeCategorised: true,
        });
        expect(forced.json.updated).toBe(1);

        // Categorising is recorded with the category ids, never the description.
        const history = await db().prepare("SELECT detail FROM finance_activity WHERE action = 'transaction.update'").all<{ detail: string }>();
        expect(history.results[0].detail).toContain('"to":"groceries"');
        expect(JSON.stringify(history.results)).not.toContain("WOOLWORTHS");
    });

    it("categorises in bulk, skipping transfers and anything not visible", async () => {
        const ours = await everyday();
        const mine = await account({ name: "Mine", visibility: "private", openingBalanceCents: 0, openingBalanceOn: "2026-09-01" });
        await importFile(ours.id, NAB_FILE_A);
        await importFile(mine.id, NAB_SAVINGS);
        const list = await transactions();
        const coffees = byDescription(list, "CAFE NERO").map((t) => t.id);
        const hidden = byDescription(list, "FROM EVERYDAY")[0].id;
        const result = await fin<{ updated: number; skipped: number }>("POST", "/transactions/bulk", { ids: [...coffees, hidden], categoryId: "coffee" }, B);
        expect(result.json).toEqual({ updated: 2, skipped: 1 });
        expect(byDescription(await transactions(), "FROM EVERYDAY")[0].categoryId).toBeNull();
    });

    it("refuses unknown or archived categories, and allows household ones", async () => {
        const ours = await everyday();
        await importFile(ours.id, NAB_FILE_A);
        const t = (await transactions())[0];
        expect((await fin("PATCH", `/transactions/${t.id}`, { version: t.version, categoryId: "made-up" })).status).toBe(422);
        const created = await fin<{ category: { id: string; version: number } }>("POST", "/categories", {
            name: "Camping",
            kind: "expense",
            groupId: "lifestyle",
        });
        expect(created.status, created.text).toBe(201);
        expect((await fin("POST", "/categories", { name: "camping", kind: "expense", groupId: "lifestyle" })).status).toBe(422);
        expect((await fin("POST", "/categories", { name: "Bonus", kind: "income", groupId: "food" })).status).toBe(422);
        const ok = await fin<{ transaction: TransactionView }>("PATCH", `/transactions/${t.id}`, { version: t.version, categoryId: created.json.category.id });
        expect(ok.status, ok.text).toBe(200);
        await fin("PATCH", `/categories/${created.json.category.id}`, { version: created.json.category.version, archived: true });
        const next = (await transactions())[1];
        expect((await fin("PATCH", `/transactions/${next.id}`, { version: next.version, categoryId: created.json.category.id })).status).toBe(422);
        // Already categorised transactions keep it.
        expect((await transactions())[0].categoryId).toBe(created.json.category.id);
    });

    it("keeps an imported transaction's bank details, and lets manual ones be corrected and deleted", async () => {
        const ours = await everyday();
        await importFile(ours.id, NAB_FILE_A);
        const imported = (await transactions())[0];
        expect((await fin("PATCH", `/transactions/${imported.id}`, { version: imported.version, amountCents: -1 })).status).toBe(422);
        expect((await fin("DELETE", `/transactions/${imported.id}`)).status).toBe(422);
        const noted = await fin<{ transaction: TransactionView }>("PATCH", `/transactions/${imported.id}`, { version: imported.version, note: "Road trip" });
        expect(noted.json.transaction.note).toBe("Road trip");

        const cash = await account({ name: "Cash", kind: "cash", openingBalanceCents: 10000, openingBalanceOn: "2026-09-01" });
        const body = { accountId: cash.id, postedOn: "2026-09-03", amountCents: -2000, description: "Markets", clientId: "cash-entry-0001" };
        const made = await fin<{ transaction: TransactionView }>("POST", "/transactions", body);
        // A retry with the same key returns the same entry.
        const retry = await fin<{ transaction: TransactionView; replayed: boolean }>("POST", "/transactions", body);
        expect(retry.json).toMatchObject({ replayed: true, transaction: { id: made.json.transaction.id } });
        const fixed = await fin<{ transaction: TransactionView }>("PATCH", `/transactions/${made.json.transaction.id}`, {
            version: made.json.transaction.version,
            amountCents: -2500,
        });
        expect(fixed.json.transaction.amountCents).toBe(-2500);
        expect((await getAccount(cash.id)).balance).toMatchObject({ status: "calculated", balanceCents: 7500 });
        expect((await fin("DELETE", `/transactions/${made.json.transaction.id}`)).status).toBe(200);
        expect((await getAccount(cash.id)).balance.balanceCents).toBe(10000);
        const audit = await db()
            .prepare("SELECT action, detail FROM finance_activity WHERE entity_id = ? ORDER BY id")
            .bind(made.json.transaction.id)
            .all<{ action: string; detail: string }>();
        expect(audit.results.map((r) => r.action)).toEqual(["transaction.create", "transaction.update", "transaction.delete"]);
        expect(audit.results[1].detail).toContain('"amountCents":{"from":-2000,"to":-2500}');
    });
});

describe("transfers and the overview", () => {
    async function household() {
        const ours = await everyday();
        const savings = await account({ name: "Savings", kind: "savings", openingBalanceCents: 1000000, openingBalanceOn: "2026-09-01", visibility: "shared" });
        const card = await account({
            name: "Credit card",
            kind: "credit_card",
            openingBalanceCents: -100000,
            openingBalanceOn: "2026-09-01",
            visibility: "shared",
        });
        await importFile(ours.id, NAB_FILE_A);
        await importFile(ours.id, NAB_FILE_B);
        await importFile(savings.id, NAB_SAVINGS);
        await importFile(card.id, NAB_CREDIT_CARD);
        return { ours, savings, card };
    }

    it("suggests transfers, and once confirmed they're neither income nor spending", async () => {
        const { savings, card } = await household();
        const before = await overview();
        // Before linking, the savings top-up and card repayment look like spending and income.
        expect(before.totals).toMatchObject({ incomeCents: 640000 + 50000 + 30000 });
        expect(before.transferSuggestionCount).toBe(2);

        const page = await fin<{ suggestions: { out: TransactionView; in: TransactionView; days: number }[] }>("GET", "/transfers/suggestions");
        expect(page.json.suggestions.map((s) => [s.out.description, s.in.accountId, s.days])).toEqual([
            ["ONLINE TRANSFER TO SAVINGS", savings.id, 0],
            ["ONLINE PAYMENT TO CREDIT CARD", card.id, 1],
        ]);
        for (const s of page.json.suggestions) {
            const linked = await fin("POST", "/transfers", { outId: s.out.id, inId: s.in.id });
            expect(linked.status, linked.text).toBe(201);
        }
        // Linking twice is refused.
        const first = page.json.suggestions[0];
        expect((await fin("POST", "/transfers", { outId: first.out.id, inId: first.in.id })).status).toBe(409);

        const after = await overview();
        expect(after.totals).toEqual({
            incomeCents: 640000,
            // File A and B spending, plus the card purchase; the repayment isn't counted again.
            expenseCents: 8435 + 450 + 450 + 1899 + 6210 + 7140 + 4500 + 19900,
            netCents: 640000 - 48984,
            transferCount: 4,
            uncategorisedCount: 10,
        });
        expect(after.transferSuggestionCount).toBe(0);
        const linkedOut = (await transactions()).find((t) => t.id === first.out.id)!;
        expect(linkedOut).toMatchObject({ isTransfer: true, counterpart: { id: first.in.id, accountName: "Savings" } });
        // A transfer can't be categorised until it's unmarked, which unlinks both sides.
        expect((await fin("PATCH", `/transactions/${linkedOut.id}`, { version: linkedOut.version, categoryId: "groceries" })).status).toBe(422);
        const unmarked = await fin<{ transaction: TransactionView }>("PATCH", `/transactions/${linkedOut.id}`, {
            version: linkedOut.version,
            isTransfer: false,
        });
        expect(unmarked.json.transaction).toMatchObject({ isTransfer: false, counterpart: null });
        expect((await transactions()).find((t) => t.id === first.in.id)).toMatchObject({ isTransfer: false });
    });

    it("shows the other side of a transfer into a private account as hidden", async () => {
        const ours = await everyday();
        const mine = await account({ name: "My savings", kind: "savings", visibility: "private" });
        await importFile(ours.id, NAB_FILE_A);
        await importFile(mine.id, NAB_SAVINGS);
        const out = byDescription(await transactions(), "TO SAVINGS")[0];
        const incoming = byDescription(await transactions(), "FROM EVERYDAY")[0];
        expect((await fin("POST", "/transfers", { outId: out.id, inId: incoming.id }, B)).status).toBe(404);
        await fin("POST", "/transfers", { outId: out.id, inId: incoming.id });
        const seen = byDescription(await transactions("", B), "TO SAVINGS")[0];
        expect(seen.counterpart).toBe("hidden");
        expect((await fin("PATCH", `/transactions/${seen.id}`, { version: seen.version, isTransfer: false }, B)).status).toBe(403);
        expect(JSON.stringify(await overview(undefined, B))).not.toContain("My savings");
    });

    it("dismissed suggestions aren't suggested again", async () => {
        await household();
        const page = await fin<{ suggestions: { out: TransactionView; in: TransactionView }[] }>("GET", "/transfers/suggestions");
        const [first] = page.json.suggestions;
        expect((await fin("POST", "/transfers/dismiss", { outId: first.out.id, inId: first.in.id })).status).toBe(200);
        const next = await fin<{ suggestions: { out: TransactionView }[] }>("GET", "/transfers/suggestions");
        expect(next.json.suggestions.map((s) => s.out.id)).not.toContain(first.out.id);
    });

    it("adds up balances, spending by category and months, all reconciling with the ledger", async () => {
        const { ours, card } = await household();
        const groceries = byDescription(await transactions(), "WOOLWORTHS").concat(byDescription(await transactions(), "COLES"));
        await fin("POST", "/transactions/bulk", { ids: groceries.map((t) => t.id), categoryId: "groceries" });
        const view = await overview();
        const byName = Object.fromEntries(view.byCategory.map((c) => [c.name, c.cents]));
        expect(byName.Groceries).toBe(8435 + 6210 + 4500);
        expect(view.byCategory.reduce((s, c) => s + c.cents, 0)).toBe(view.totals.expenseCents);
        expect(view.months.at(-1)).toMatchObject({ month: "2026-09", incomeCents: view.totals.incomeCents, expenseCents: view.totals.expenseCents });
        expect(view.months).toHaveLength(6);
        // Sum of every account's balance = assets − liabilities.
        const balances = view.accounts.map((a) => a.balance.balanceCents!);
        expect(view.position.netCents).toBe(balances.reduce((s, b) => s + b, 0));
        expect(view.accounts.find((a) => a.id === card.id)!.balance).toMatchObject({ balanceCents: -89900, status: "matches_bank" });
        expect(view.uncategorisedCount).toBe(14 - 3);
        // An account filter narrows everything to it.
        const one = await overview(`from=2026-09-01&to=2026-09-30&accounts=${card.id}`);
        expect(one.totals).toMatchObject({ incomeCents: 30000, expenseCents: 19900 });
        // The previous period (the same length, just before) is there for comparison.
        expect(view.previous).toMatchObject({ from: "2026-08-02", to: "2026-08-31", incomeCents: 0 });
        expect(ours.id).toBeTruthy();
    });

    it("records reconciliation against a statement, showing a difference rather than fixing it", async () => {
        const ours = await everyday();
        await importFile(ours.id, NAB_FILE_A);
        const exact = await fin<{ differenceCents: number; account: AccountView }>("POST", `/accounts/${ours.id}/reconcile`, {
            asOf: "2026-09-30",
            statementBalanceCents: 495416,
        });
        expect(exact.status, exact.text).toBe(201);
        expect(exact.json.account.balance).toMatchObject({ status: "reconciled", checkedAgainst: "statement" });
        const off = await fin<{ differenceCents: number; account: AccountView }>("POST", `/accounts/${ours.id}/reconcile`, {
            asOf: "2026-10-01",
            statementBalanceCents: 495000,
        });
        expect(off.json.differenceCents).toBe(-416);
        expect(off.json.account.balance).toMatchObject({ status: "mismatch", differenceCents: -416 });
        expect((await fin("POST", `/accounts/${ours.id}/reconcile`, { asOf: "2026-08-01", statementBalanceCents: 0 })).status).toBe(422);
        expect(await transactions()).toHaveLength(8);
    });

    it("exports what the caller can see, with formulas neutralised", async () => {
        const ours = await everyday();
        await fin("POST", "/transactions", {
            accountId: ours.id,
            postedOn: "2026-09-02",
            amountCents: -100,
            description: "=HYPERLINK(1)",
            clientId: "formula-0001",
        });
        const response = await rawCall("/api/portal/finance/transactions.csv?from=2026-09-01&to=2026-09-30", { token: await accessToken({ email: A }) });
        const text = await response.text();
        expect(response.headers.get("Content-Type")).toMatch(/text\/csv/);
        expect(text).toContain("'=HYPERLINK(1)");
        expect(text).toContain("-1.00");
    });
});

describe("database rules", () => {
    it("refuses a second live transaction with the same fingerprint, and impossible rows", async () => {
        const ours = await everyday();
        await importFile(ours.id, NAB_FILE_A);
        const row = await db().prepare("SELECT * FROM finance_transactions LIMIT 1").first<Record<string, unknown>>();
        const copy = { ...row, id: "ftx_copy0000000001" };
        const columns = Object.keys(copy);
        const insert = (values: Record<string, unknown>) =>
            db()
                .prepare(`INSERT INTO finance_transactions (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
                .bind(...columns.map((c) => values[c] ?? null))
                .run();
        await expect(insert(copy)).rejects.toThrow(/UNIQUE/);
        await expect(insert({ ...copy, fingerprint: "f".repeat(64), amount_cents: 0 })).rejects.toThrow(/CHECK/);
        await expect(insert({ ...copy, fingerprint: "e".repeat(64), is_transfer: 1, category_id: "groceries", category_source: "manual" })).rejects.toThrow(
            /CHECK/,
        );
        await expect(
            db()
                .prepare(
                    "INSERT INTO finance_reconciliations (id, account_id, as_of, statement_balance_cents, calculated_balance_cents, difference_cents, created_by, created_at) VALUES ('frc_x', ?, '2026-09-01', 10, 5, 4, 'x', 'x')",
                )
                .bind(ours.id)
                .run(),
        ).rejects.toThrow(/CHECK/);
    });

    it("loads the pages", async () => {
        const ours = await everyday();
        const staged = await stage(ours.id, NAB_FILE_A);
        const token = await accessToken({ email: A });
        for (const path of [
            "/portal/finance",
            "/portal/finance/transactions",
            "/portal/finance/accounts",
            `/portal/finance/accounts/${ours.id}`,
            "/portal/finance/import",
            `/portal/finance/import/${staged.summary.id}`,
            "/portal/finance/settings",
        ]) {
            const response = await rawCall(path, { token });
            expect(response.status, path).toBe(200);
        }
        expect((await rawCall("/portal/finance/accounts/fac_00000000000000", { token })).status).toBe(404);
    });
});
