// Retired applications and features: one table of every address that used to exist, each with the
// message of the retirement it went with. Their addresses answer 410 Gone, after the usual Access and
// role checks, so a bookmark, an old browser tab or a script gets a clear answer instead of a
// confusing 404, and nothing can read or change the retired records.
//
// - Daly Knowledge and Daly Tasks (docs/DECOMMISSION_KNOWLEDGE_TASKS.md), and with them everything
//   that existed only to serve them. Wedding Planner tasks (/portal/wedding/tasks,
//   /api/portal/wedding/tasks) are a different feature and aren't affected.
// - Home & Assets and Household Finance (docs/DECOMMISSION_ASSETS_FINANCE.md), replaced by Home and
//   Finances in Cloudflare OS. The Wedding Planner's budget is a different feature.
// - Daly Calendar and the Leave Planner, Today, Daly Intelligence, the Intelligence Centre and its
//   wallboards, and Amplenote (docs/DECOMMISSION_PORTAL_APPS.md). The wedding's Save the Date
//   calendar file (/save-the-date/calendar) is the Wedding Planner's own and isn't affected.
//
// Addresses that never sat behind Cloudflare Access (calendar subscription feeds, wallboard screens,
// the Amplenote plugin and its sign-in) answer a plain 410 to anyone: RETIRED_PUBLIC below.

const kept = "Its records are kept, read-only and unreachable, until the owner approves their removal.";

export const RETIRED_MESSAGE = `Daly Knowledge and Daly Tasks have been retired, along with the features that depended on them. Their records are kept, read-only and unreachable, until the owner approves their removal.`;
export const RETIRED_ASSETS_MESSAGE = `Home & Assets has been retired and replaced by Home in Cloudflare OS. ${kept}`;
export const RETIRED_FINANCE_MESSAGE = `Household Finance has been retired and replaced by Finances in Cloudflare OS. ${kept}`;
export const RETIRED_CALENDAR_MESSAGE = `Daly Calendar and the Leave Planner have been retired. ${kept}`;
export const RETIRED_TODAY_MESSAGE = `Today has been retired. ${kept}`;
export const RETIRED_INTELLIGENCE_MESSAGE = `Daly Intelligence has been retired. ${kept}`;
export const RETIRED_CENTRE_MESSAGE = `The Intelligence Centre has been retired, along with its wallboards. ${kept}`;
export const RETIRED_AMPLENOTE_MESSAGE =
    "Publishing from Amplenote has been retired: the blog publishes from Capacities. Articles already on the site stay exactly as they are.";

interface Retirement {
    message: string;
    /** API paths that used to exist. Anything under them answers 410. */
    api: readonly RegExp[];
    /** Portal pages that used to exist. */
    pages: readonly RegExp[];
}

/** Checked in order: the first match decides the message (older, more specific paths keep theirs). */
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
    { message: RETIRED_ASSETS_MESSAGE, api: [/^\/api\/portal\/assets(\/|$)/], pages: [/^\/portal\/assets(\/|$)/] },
    { message: RETIRED_FINANCE_MESSAGE, api: [/^\/api\/portal\/finance(\/|$)/], pages: [/^\/portal\/finance(\/|$)/] },
    { message: RETIRED_CALENDAR_MESSAGE, api: [/^\/api\/portal\/calendar(\/|$)/], pages: [/^\/portal\/calendar(\/|$)/] },
    { message: RETIRED_TODAY_MESSAGE, api: [/^\/api\/portal\/today(\/|$)/], pages: [/^\/portal\/today(\/|$)/] },
    { message: RETIRED_INTELLIGENCE_MESSAGE, api: [/^\/api\/portal\/intelligence(\/|$)/], pages: [/^\/portal\/intelligence(\/|$)/] },
    { message: RETIRED_CENTRE_MESSAGE, api: [/^\/api\/portal\/centre(\/|$)/], pages: [/^\/portal\/intelligence-centre(\/|$)/] },
    { message: RETIRED_AMPLENOTE_MESSAGE, api: [/^\/api\/portal\/website\/amplenote(\/|$)/], pages: [] },
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

/**
 * Retired addresses outside Cloudflare Access: private calendar subscription feeds, the wallboard
 * page and its API and map tiles, the Amplenote plugin's reports and Amplenote's sign-in redirect.
 * Anyone may ask, so the answer names nothing but the fact that the address is retired.
 */
const RETIRED_PUBLIC: readonly RegExp[] = [
    /^\/calendar\/feed\//,
    /^\/display$/,
    /^\/api\/display(\/|$)/,
    /^\/api\/amplenote(\/|$)/,
    /^\/api\/integrations\/amplenote(\/|$)/,
];

export const isRetiredPublicPath = (path: string) => RETIRED_PUBLIC.some((pattern) => pattern.test(path));

export const retiredPublicResponse = () =>
    new Response("Gone: this address has been retired.", {
        status: 410,
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" },
    });
