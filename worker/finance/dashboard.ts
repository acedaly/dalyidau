// The Household Finance overview: balances (with how sure we are of each), income and spending for
// a date range against the period before it, six months of history, spending by category, recent
// and uncategorised transactions, and transfer suggestions. Only accounts the caller can see are
// read, so a private account never reaches the other person's overview, even as part of a total.
import type { D1Database } from "@cloudflare/workers-types";
import { groupName } from "../../src/shared/finance/categories";
import { daysApart, monthKey, monthStart, shiftDays } from "../../src/shared/finance/dates";
import { type LedgerLine, monthlySeries, periodTotals, spendingByCategory } from "../../src/shared/finance/ledger";
import type { FinanceOverview } from "../../src/shared/finance/types";
import type { PortalUser } from "../../src/shared/portal/types";
import { listAccounts } from "./accounts";
import { kindLookup, listCategories } from "./categories";
import { listImports } from "./imports";
import { listTransactions, suggestTransfers } from "./transactions";

export interface OverviewQuery {
    from: string;
    to: string;
    accountIds: string[];
}

export function overviewQuery(params: URLSearchParams, today: string): OverviewQuery {
    const date = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) ? v : null);
    let from = date(params.get("from")) ?? monthStart(today);
    let to = date(params.get("to")) ?? today;
    if (from > to) [from, to] = [to, from];
    // At most two years in one view.
    if (daysApart(from, to) > 731) from = shiftDays(to, -731);
    const accountIds = (params.get("accounts") ?? "")
        .split(",")
        .filter((id) => /^fac_[a-z0-9]{14}$/.test(id))
        .slice(0, 50);
    return { from, to, accountIds };
}

async function ledgerLines(db: D1Database, user: PortalUser, accountIds: string[], from: string, to: string): Promise<LedgerLine[]> {
    if (!accountIds.length) return [];
    const rows = await db
        .prepare(
            `SELECT t.amount_cents, t.posted_on, t.category_id, t.is_transfer FROM finance_transactions t JOIN finance_accounts a ON a.id = t.account_id
             WHERE (a.owner_email = ?1 OR a.visibility = 'shared') AND t.deleted_at IS NULL AND t.posted_on >= ?2 AND t.posted_on <= ?3
               AND t.account_id IN (${accountIds.map((_, i) => `?${i + 4}`).join(", ")})`,
        )
        .bind(user.email, from, to, ...accountIds)
        .all<{ amount_cents: number; posted_on: string; category_id: string | null; is_transfer: number }>();
    return rows.results.map((r) => ({ amountCents: r.amount_cents, postedOn: r.posted_on, categoryId: r.category_id, isTransfer: !!r.is_transfer }));
}

export async function overview(db: D1Database, user: PortalUser, query: OverviewQuery, today: string): Promise<FinanceOverview> {
    const [accounts, categories] = await Promise.all([listAccounts(db, user), listCategories(db)]);
    const visible = new Set(accounts.map((a) => a.id));
    const chosen = query.accountIds.filter((id) => visible.has(id));
    const ids = (chosen.length ? chosen : accounts.map((a) => a.id)).slice(0, 90);
    const kindOf = kindLookup(categories);
    const span = daysApart(query.from, query.to);
    const previousTo = shiftDays(query.from, -1);
    const previousFrom = shiftDays(previousTo, -span);
    const firstMonth = monthStart(query.to, -5);
    const months = Array.from({ length: 6 }, (_, i) => monthKey(monthStart(query.to, i - 5)));

    const [current, previous, history, recent, uncategorised, suggestions, imports] = await Promise.all([
        ledgerLines(db, user, ids, query.from, query.to),
        ledgerLines(db, user, ids, previousFrom, previousTo),
        ledgerLines(db, user, ids, firstMonth, query.to),
        listTransactions(db, user, { accountIds: ids }, 8),
        ids.length
            ? db
                  .prepare(
                      `SELECT COUNT(*) AS n FROM finance_transactions t JOIN finance_accounts a ON a.id = t.account_id
                       WHERE (a.owner_email = ?1 OR a.visibility = 'shared') AND t.deleted_at IS NULL AND t.category_id IS NULL AND t.is_transfer = 0
                         AND t.account_id IN (${ids.map((_, i) => `?${i + 2}`).join(", ")})`,
                  )
                  .bind(user.email, ...ids)
                  .first<{ n: number }>()
            : null,
        suggestTransfers(db, user, { from: shiftDays(today, -120), to: today }),
        listImports(db, user),
    ]);

    const names = new Map(categories.map((c) => [c.id, c]));
    const byCategory = spendingByCategory(current, kindOf).map((s) => {
        const category = s.categoryId ? names.get(s.categoryId) : null;
        return {
            categoryId: s.categoryId,
            name: s.categoryId ? (category?.name ?? "Unknown category") : "Uncategorised",
            groupId: category?.groupId ?? null,
            groupName: category ? groupName(category.groupId) : null,
            cents: s.cents,
            count: s.count,
        };
    });

    const included = accounts.filter((a) => ids.includes(a.id) && !a.archived);
    const position = { assetsCents: 0, liabilitiesCents: 0, netCents: 0, incompleteAccounts: 0, unconfirmedAccounts: 0 };
    for (const account of included) {
        const { balance } = account;
        if (balance.balanceCents === null) {
            position.incompleteAccounts++;
            continue;
        }
        if (balance.status === "calculated" || balance.status === "mismatch") position.unconfirmedAccounts++;
        if (balance.balanceCents >= 0) position.assetsCents += balance.balanceCents;
        else position.liabilitiesCents += -balance.balanceCents;
    }
    position.netCents = position.assetsCents - position.liabilitiesCents;

    const idSet = new Set(ids);
    return {
        from: query.from,
        to: query.to,
        accountIds: chosen,
        accounts,
        totals: periodTotals(current, kindOf),
        previous: { ...periodTotals(previous, kindOf), from: previousFrom, to: previousTo },
        months: monthlySeries(history, months, kindOf),
        byCategory,
        recent: recent.transactions,
        uncategorisedCount: uncategorised?.n ?? 0,
        transferSuggestionCount: suggestions.filter((s) => idSet.has(s.out.accountId) || idSet.has(s.in.accountId)).length,
        position,
        lastImport: imports.find((i) => i.status === "committed") ?? null,
    };
}
