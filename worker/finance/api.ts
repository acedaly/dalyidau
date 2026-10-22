// JSON API for Household Finance (/api/portal/finance/*). By the time a request gets here the portal
// router has verified the Access identity, the portal role and the same-origin checks. This router
// adds "finance.use"; each handler then checks the caller can see the account it touches
// (worker/finance/access.ts): anything not visible is 404.
import { z } from "zod";
import { shiftDays } from "../../src/shared/finance/dates";
import { accountId, importId, transactionId } from "../../src/shared/finance/types";
import type { PortalUser } from "../../src/shared/portal/types";
import type { Env } from "../env";
import { can } from "../portal/auth";
import { csvResponse } from "../portal/csv";
import { HttpError, json, readJson } from "../portal/http";
import { todayFor } from "./access";
import { accountView, createAccount, listAccounts, listReconciliations, reconcile, updateAccount } from "./accounts";
import { createCategory, listCategories, updateCategory } from "./categories";
import { overview, overviewQuery } from "./dashboard";
import { cancelImport, commitImport, createImport, decideRows, importDetail, inspectFile, listImports, undoImport } from "./imports";
import {
    bulkCategorise,
    categoriseSimilar,
    createManual,
    deleteManual,
    dismissTransfer,
    exportCsv,
    filtersFrom,
    linkTransfer,
    listTransactions,
    similarCounts,
    suggestTransfers,
    transactionView,
    updateTransaction,
} from "./transactions";

interface Ctx {
    env: Env;
    request: Request;
    url: URL;
    user: PortalUser;
    params: Record<string, string>;
}

type Handler = (ctx: Ctx) => Promise<Response>;
const routes: { method: string; pattern: RegExp; keys: string[]; handler: Handler }[] = [];
const add = (method: string, path: string, handler: Handler) => {
    const keys: string[] = [];
    const pattern = new RegExp(
        `^/api/portal/finance${path.replace(/:([a-zA-Z]+)/g, (_, key: string) => {
            keys.push(key);
            return "([^/]+)";
        })}$`,
    );
    routes.push({ method, pattern, keys, handler });
};

/** CSV files arrive as text in JSON: 2 MB of file plus room for escaping. */
const FILE_BODY_BYTES = 5_000_000;
const pair = z.object({ outId: transactionId, inId: transactionId }).strict();

// --- Overview --------------------------------------------------------------------------------------

add("GET", "/overview", async ({ env, url, user }) => {
    const today = await todayFor(env.DB, user.email);
    return json({ overview: await overview(env.DB, user, overviewQuery(url.searchParams, today), today) });
});

// --- Accounts --------------------------------------------------------------------------------------

add("GET", "/accounts", async ({ env, user }) => json({ accounts: await listAccounts(env.DB, user) }));
add("POST", "/accounts", async ({ env, request, user }) => {
    const { account, replayed } = await createAccount(env.DB, user, await readJson(request));
    return json({ account, replayed }, replayed ? 200 : 201);
});
add("GET", "/accounts/:id", async ({ env, user, params }) => json({ account: await accountView(env.DB, user, accountId.parse(params.id)) }));
add("PATCH", "/accounts/:id", async ({ env, request, user, params }) =>
    json({ account: await updateAccount(env.DB, user, accountId.parse(params.id), await readJson(request)) }),
);
add("POST", "/accounts/:id/reconcile", async ({ env, request, user, params }) =>
    json(await reconcile(env.DB, user, accountId.parse(params.id), await readJson(request)), 201),
);
add("GET", "/accounts/:id/reconciliations", async ({ env, user, params }) =>
    json({ reconciliations: await listReconciliations(env.DB, user, accountId.parse(params.id)) }),
);

// --- Categories ------------------------------------------------------------------------------------

add("GET", "/categories", async ({ env }) => json({ categories: await listCategories(env.DB) }));
add("POST", "/categories", async ({ env, request, user }) => json({ category: await createCategory(env.DB, user, await readJson(request)) }, 201));
add("PATCH", "/categories/:id", async ({ env, request, user, params }) =>
    json({ category: await updateCategory(env.DB, user, params.id, await readJson(request)) }),
);

// --- Transactions ----------------------------------------------------------------------------------

add("GET", "/transactions", async ({ env, url, user }) => {
    const filters = filtersFrom(url.searchParams, await todayFor(env.DB, user.email));
    return json({ ...(await listTransactions(env.DB, user, filters)), filters });
});
add("GET", "/transactions.csv", async ({ env, url, user }) => {
    const report = await exportCsv(env.DB, user, filtersFrom(url.searchParams, await todayFor(env.DB, user.email)));
    return csvResponse(report.filename, report.csv);
});
add("POST", "/transactions", async ({ env, request, user }) => {
    const { transaction, replayed } = await createManual(env.DB, user, await readJson(request));
    return json({ transaction, replayed }, replayed ? 200 : 201);
});
add("POST", "/transactions/bulk", async ({ env, request, user }) => json(await bulkCategorise(env.DB, user, await readJson(request))));
add("POST", "/transactions/similar", async ({ env, request, user }) => json(await categoriseSimilar(env.DB, user, await readJson(request))));
add("GET", "/transactions/:id", async ({ env, user, params }) => json({ transaction: await transactionView(env.DB, user, transactionId.parse(params.id)) }));
add("GET", "/transactions/:id/similar", async ({ env, url, user, params }) => {
    const category = url.searchParams.get("category");
    return json(await similarCounts(env.DB, user, transactionId.parse(params.id), category && /^[a-z0-9_-]{2,40}$/.test(category) ? category : null));
});
add("PATCH", "/transactions/:id", async ({ env, request, user, params }) =>
    json({ transaction: await updateTransaction(env.DB, user, transactionId.parse(params.id), await readJson(request)) }),
);
add("DELETE", "/transactions/:id", async ({ env, user, params }) => {
    await deleteManual(env.DB, user, transactionId.parse(params.id));
    return json({ ok: true });
});

// --- Transfers -------------------------------------------------------------------------------------

add("GET", "/transfers/suggestions", async ({ env, user }) => {
    const today = await todayFor(env.DB, user.email);
    return json({ suggestions: await suggestTransfers(env.DB, user, { from: shiftDays(today, -120), to: today }) });
});
add("POST", "/transfers", async ({ env, request, user }) => {
    const body = pair.parse(await readJson(request));
    return json(await linkTransfer(env.DB, user, body.outId, body.inId), 201);
});
add("POST", "/transfers/dismiss", async ({ env, request, user }) => {
    const body = pair.parse(await readJson(request));
    await dismissTransfer(env.DB, user, body.outId, body.inId);
    return json({ ok: true });
});

// --- Imports ---------------------------------------------------------------------------------------

add("GET", "/imports", async ({ env, url, user }) => {
    const account = url.searchParams.get("account");
    return json({ imports: await listImports(env.DB, user, account && /^fac_[a-z0-9]{14}$/.test(account) ? account : null) });
});
add("POST", "/imports/inspect", async ({ env, request, user }) =>
    json({ inspection: await inspectFile(env.DB, user, await readJson(request, FILE_BODY_BYTES)) }),
);
add("POST", "/imports", async ({ env, request, user }) => {
    const { detail, replayed } = await createImport(env.DB, user, await readJson(request, FILE_BODY_BYTES));
    return json({ detail, replayed }, replayed ? 200 : 201);
});
add("GET", "/imports/:id", async ({ env, user, params }) => json({ detail: await importDetail(env.DB, user, importId.parse(params.id)) }));
add("PATCH", "/imports/:id/rows", async ({ env, request, user, params }) =>
    json({ detail: await decideRows(env.DB, user, importId.parse(params.id), await readJson(request)) }),
);
add("POST", "/imports/:id/commit", async ({ env, request, user, params }) =>
    json(await commitImport(env.DB, user, importId.parse(params.id), await readJson(request))),
);
add("POST", "/imports/:id/cancel", async ({ env, request, user, params }) => {
    await cancelImport(env.DB, user, importId.parse(params.id), await readJson(request));
    return json({ ok: true });
});
add("POST", "/imports/:id/undo", async ({ env, request, user, params }) => {
    await undoImport(env.DB, user, importId.parse(params.id), await readJson(request));
    return json({ ok: true });
});

export async function handleFinanceApi(request: Request, env: Env, user: PortalUser): Promise<Response> {
    if (!can(user, "finance.use")) throw new HttpError(403, "forbidden", "You don't have access to Household Finance");
    const url = new URL(request.url);
    const method = request.method === "HEAD" ? "GET" : request.method;
    let pathMatched = false;
    for (const route of routes) {
        const match = route.pattern.exec(url.pathname);
        if (!match) continue;
        pathMatched = true;
        if (route.method !== method) continue;
        const params = Object.fromEntries(route.keys.map((key, i) => [key, decodeURIComponent(match[i + 1])]));
        return route.handler({ env, request, url, user, params });
    }
    if (pathMatched) throw new HttpError(405, "method_not_allowed", "Method not allowed");
    throw new HttpError(404, "not_found", "Not found");
}
