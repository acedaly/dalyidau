// Retired applications and features. Their records stay in D1 and R2, untouched, until the owner
// approves a cleanup. Their addresses answer 410 Gone, after the usual Access and role checks, so a
// bookmark, an old browser tab or a script gets a clear answer instead of a confusing 404, and
// nothing can read or change the retired records. Each retirement has its own message, so the answer
// names what was actually retired.
//
// - Daly Knowledge and Daly Tasks (docs/DECOMMISSION_KNOWLEDGE_TASKS.md), and with them everything
//   that existed only to serve them: the Daily Planner's time blocks, Today's task routines, Daly
//   Intelligence's capture, suggestions and semantic search, event links to tasks and notes, Home &
//   Assets' task and Knowledge links, and the DalyHub import. Wedding Planner tasks
//   (/portal/wedding/tasks, /api/portal/wedding/tasks) are a different feature and aren't affected.
// - Home & Assets and Household Finance (docs/DECOMMISSION_ASSETS_FINANCE.md), replaced by Home and
//   Finances in Cloudflare OS. The Wedding Planner's budget is a different feature and isn't affected.

export const RETIRED_MESSAGE =
    "Daly Knowledge and Daly Tasks have been retired, along with the features that depended on them. Their records are kept, read-only and unreachable, until the owner approves their removal.";

export const RETIRED_ASSETS_MESSAGE =
    "Home & Assets has been retired and replaced by Home in Cloudflare OS. Its records are kept, read-only and unreachable, until the owner approves their removal.";

export const RETIRED_FINANCE_MESSAGE =
    "Household Finance has been retired and replaced by Finances in Cloudflare OS. Its records are kept, read-only and unreachable, until the owner approves their removal.";

interface Retirement {
    message: string;
    /** API paths that used to exist. Anything under them answers 410. */
    api: readonly RegExp[];
    /** Portal pages that used to exist. */
    pages: readonly RegExp[];
}

/** Checked in order: the first match decides the message (Home & Assets' old task and Knowledge links keep theirs). */
const RETIREMENTS: readonly Retirement[] = [
    {
        message: RETIRED_MESSAGE,
        api: [
            /^\/api\/portal\/knowledge(\/|$)/,
            /^\/api\/portal\/tasks(\/|$)/,
            /^\/api\/portal\/migrations\/dalyhub(\/|$)/,
            /^\/api\/portal\/calendar\/planner(\/|$)/,
            /^\/api\/portal\/calendar\/events\/[^/]+\/(links|task)(\/|$)/,
            /^\/api\/portal\/assets\/items\/[^/]+\/knowledge(\/|$)/,
            /^\/api\/portal\/assets\/tasks(\/|$)/,
            /^\/api\/portal\/centre\/records\/[^/]+\/(task|knowledge|timeline\/knowledge)$/,
            /^\/api\/portal\/centre\/(briefing\/knowledge|rules\/matches\/[^/]+\/task|reports\/[^/]+\/knowledge)$/,
            /^\/api\/portal\/today\/(plan|reviews)(\/|$)/,
            /^\/api\/portal\/intelligence\/(captures|suggestions|search|objects|semantic|jobs|attachments|exclusions|storage)(\/|$)/,
        ],
        pages: [
            /^\/portal\/knowledge(\/|$)/,
            /^\/portal\/tasks(\/|$)/,
            /^\/portal\/calendar\/planner$/,
            /^\/portal\/intelligence\/(inbox|capture|captures|meetings)(\/|$)/,
        ],
    },
    {
        message: RETIRED_ASSETS_MESSAGE,
        api: [/^\/api\/portal\/assets(\/|$)/],
        pages: [/^\/portal\/assets(\/|$)/],
    },
    {
        message: RETIRED_FINANCE_MESSAGE,
        api: [/^\/api\/portal\/finance(\/|$)/],
        pages: [/^\/portal\/finance(\/|$)/],
    },
];

/** The message for a retired API path, or null if it isn't retired. */
export const retiredApiMessage = (path: string): string | null => RETIREMENTS.find((r) => r.api.some((p) => p.test(path)))?.message ?? null;
/** The message for a retired portal page, or null if it isn't retired. */
export const retiredPageMessage = (path: string): string | null => RETIREMENTS.find((r) => r.pages.some((p) => p.test(path)))?.message ?? null;

export const isRetiredApi = (path: string) => retiredApiMessage(path) !== null;
export const isRetiredPage = (path: string) => retiredPageMessage(path) !== null;

export const retiredResponse = (message: string = RETIRED_MESSAGE) =>
    new Response(JSON.stringify({ error: "retired", message }), {
        status: 410,
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
