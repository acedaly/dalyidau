// Daly Knowledge and Daly Tasks are retired (docs/DECOMMISSION_KNOWLEDGE_TASKS.md), and with them
// everything that existed only to serve them: the Daily Planner's time blocks, Today's task routines,
// Daly Intelligence's capture, suggestions and semantic search, event links to tasks and notes, Home &
// Assets' task and Knowledge links, and the DalyHub import. Their records stay in D1 and R2,
// untouched, until the owner approves the cleanup.
//
// Their addresses answer 410 Gone, after the usual Access and role checks, so a bookmark, an old
// browser tab or a script gets a clear answer instead of a confusing 404, and nothing can read or
// change the retired records. Wedding Planner tasks (/portal/wedding/tasks, /api/portal/wedding/tasks)
// are a different feature and aren't affected.

export const RETIRED_MESSAGE =
    "Daly Knowledge and Daly Tasks have been retired, along with the features that depended on them. Their records are kept, read-only and unreachable, until the owner approves their removal.";

/** API paths that used to exist. Anything under them answers 410. */
const RETIRED_API: readonly RegExp[] = [
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
];

/** Portal pages that used to exist. */
const RETIRED_PAGES: readonly RegExp[] = [
    /^\/portal\/knowledge(\/|$)/,
    /^\/portal\/tasks(\/|$)/,
    /^\/portal\/calendar\/planner$/,
    /^\/portal\/intelligence\/(inbox|capture|captures|meetings)(\/|$)/,
];

export const isRetiredApi = (path: string) => RETIRED_API.some((p) => p.test(path));
export const isRetiredPage = (path: string) => RETIRED_PAGES.some((p) => p.test(path));

export const retiredResponse = () =>
    new Response(JSON.stringify({ error: "retired", message: RETIRED_MESSAGE }), {
        status: 410,
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
