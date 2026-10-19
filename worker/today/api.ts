// JSON API for Today (/api/portal/today/*). By the time a request gets here the portal router has
// verified the Access identity, the portal role and the same-origin checks (CSRF). Today needs both
// Calendar and Tasks (as the Daily Planner does); everything it reads goes through their own access
// rules, and everything it changes goes through their own functions. These routes only add what's
// Today's own: its preferences, the morning and evening records, and Plan My Day.
import { z } from "zod";
import type { PortalUser } from "../../src/shared/portal/types";
import type { Env } from "../env";
import { requirePlanner } from "../planner/blocks";
import { HttpError, json, readJson } from "../portal/http";
import { TODAY_PARTS, type TodayPart, todayDashboard } from "./dashboard";
import { applyPlan, proposePlan } from "./plan";
import { loadTodayPrefs, saveTodayPrefs } from "./prefs";
import { loadReviews, saveReview } from "./reviews";

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
        `^/api/portal/today${path.replace(/:([a-zA-Z]+)/g, (_, key: string) => {
            keys.push(key);
            return "([^/]+)";
        })}$`,
    );
    routes.push({ method, pattern, keys, handler });
};

const parts = z.array(z.enum(TODAY_PARTS)).max(TODAY_PARTS.length);

add("GET", "", async ({ env, url, user }) => {
    const requested = url.searchParams.get("parts");
    const result = parts.safeParse(requested ? requested.split(",") : []);
    if (!result.success) throw new HttpError(400, "bad_parts", `Ask for some of: ${TODAY_PARTS.join(", ")}`);
    return json({ today: await todayDashboard(env.DB, user, { date: url.searchParams.get("date"), parts: result.data as TodayPart[] }) });
});
add("GET", "/preferences", async ({ env, user }) => json(await loadTodayPrefs(env.DB, user.email)));
add("PUT", "/preferences", async ({ env, request, user }) => json(await saveTodayPrefs(env.DB, user, await readJson(request))));
add("GET", "/reviews/:date", async ({ env, user, params }) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(params.date)) throw new HttpError(400, "bad_date", "Use a date like 2026-10-19");
    return json({ reviews: await loadReviews(env.DB, user, params.date) });
});
add("PUT", "/reviews/:date/:kind", async ({ env, request, user, params }) =>
    json({ review: await saveReview(env.DB, user, params.date, params.kind, await readJson(request)) }),
);
add("POST", "/plan", async ({ env, request, user }) => json({ proposal: await proposePlan(env.DB, user, await readJson(request)) }));
add("POST", "/plan/apply", async ({ env, request, user }) => json(await applyPlan(env.DB, user, await readJson(request))));

export async function handleTodayApi(request: Request, env: Env, user: PortalUser): Promise<Response> {
    requirePlanner(user);
    const url = new URL(request.url);
    const method = request.method === "HEAD" ? "GET" : request.method;
    let pathMatched = false;
    for (const route of routes) {
        const match = route.pattern.exec(url.pathname);
        if (!match) continue;
        pathMatched = true;
        if (route.method !== method) continue;
        const params = Object.fromEntries(route.keys.map((key, i) => [key, decodeURIComponent(match[i + 1])]));
        try {
            return await route.handler({ env, request, url, user, params });
        } catch (error) {
            if (error instanceof SyntaxError) throw new HttpError(400, "bad_json", "Request body is not valid JSON");
            throw error;
        }
    }
    if (pathMatched) throw new HttpError(405, "method_not_allowed", "Method not allowed");
    throw new HttpError(404, "not_found", "Not found");
}
