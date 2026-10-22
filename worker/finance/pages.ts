// First-render data for Household Finance's pages (/portal/finance/*). The portal page router has
// already checked "finance.use". Anything the caller can't see returns null (the 404 page).
import { shiftDays } from "../../src/shared/finance/dates";
import type { FinanceRoute, FinanceShell } from "../../src/shared/finance/types";
import type { PortalUser } from "../../src/shared/portal/types";
import type { Env } from "../env";
import { HttpError } from "../portal/http";
import { todayFor } from "./access";
import { accountOptions, accountView, listAccounts, listReconciliations } from "./accounts";
import { listCategories } from "./categories";
import { overview, overviewQuery } from "./dashboard";
import { importDetail, listImports } from "./imports";
import { filtersFrom, listTransactions, suggestTransfers } from "./transactions";

export type FinancePage = "overview" | "transactions" | "accounts" | "account" | "import" | "import-review" | "settings";

const notVisible = (error: unknown) => {
    if (error instanceof HttpError && (error.status === 404 || error.status === 422)) return null;
    throw error;
};

async function shell(env: Env, user: PortalUser): Promise<FinanceShell> {
    const [today, categories, accounts] = await Promise.all([todayFor(env.DB, user.email), listCategories(env.DB), accountOptions(env.DB, user)]);
    return { today, categories, accounts };
}

export async function loadFinancePage(env: Env, user: PortalUser, url: URL, page: FinancePage, id?: string): Promise<FinanceRoute | null> {
    const base = await shell(env, user);
    const db = env.DB;
    switch (page) {
        case "overview":
            return { route: "finance-overview", ...base, overview: await overview(db, user, overviewQuery(url.searchParams, base.today), base.today) };
        case "transactions": {
            const filters = filtersFrom(url.searchParams, base.today);
            const [{ transactions, truncated }, suggestions] = await Promise.all([
                listTransactions(db, user, filters),
                suggestTransfers(db, user, { from: shiftDays(base.today, -120), to: base.today }),
            ]);
            return { route: "finance-transactions", ...base, transactions, truncated, filters, suggestions };
        }
        case "accounts":
            return { route: "finance-accounts", ...base, accounts: await listAccounts(db, user) };
        case "account": {
            const account = await accountView(db, user, id!).catch(notVisible);
            if (!account) return null;
            const [{ transactions, truncated }, imports, reconciliations] = await Promise.all([
                listTransactions(db, user, { accountId: id }, 1000),
                listImports(db, user, id),
                listReconciliations(db, user, id!),
            ]);
            return { route: "finance-account", ...base, account, transactions, truncated, imports, reconciliations };
        }
        case "import": {
            const account = url.searchParams.get("account");
            const chosen = account && base.accounts.some((a) => a.id === account) ? account : null;
            return { route: "finance-import", ...base, imports: await listImports(db, user), accountId: chosen };
        }
        case "import-review": {
            const detail = await importDetail(db, user, id!).catch(notVisible);
            if (!detail) return null;
            return { route: "finance-import-review", ...base, detail };
        }
        case "settings": {
            const usage = await db
                .prepare(
                    `SELECT t.category_id AS id, COUNT(*) AS n FROM finance_transactions t JOIN finance_accounts a ON a.id = t.account_id
                     WHERE (a.owner_email = ?1 OR a.visibility = 'shared') AND t.deleted_at IS NULL AND t.category_id IS NOT NULL GROUP BY t.category_id`,
                )
                .bind(user.email)
                .all<{ id: string; n: number }>();
            return { route: "finance-settings", ...base, usage: Object.fromEntries(usage.results.map((r) => [r.id, r.n])) };
        }
    }
}
