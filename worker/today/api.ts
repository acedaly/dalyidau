// JSON API for Today (/api/portal/today/*). By the time a request gets here the portal router has
// verified the Access identity, the portal role and the same-origin checks (CSRF). Today needs
// Calendar; everything it reads goes through Calendar's own access rules, and everything it changes
// goes through Calendar's own functions. These routes only add what's Today's own: its preferences
// and the person's planning hours.
import { z } from "zod";
import type { PortalUser } from "../../src/shared/portal/types";
import type { Env } from "../env";
import { HttpError, json, readJson } from "../portal/http";
import { TODAY_PARTS, type TodayPart, todayDashboard } from "./dashboard";
import { loadTodayPrefs, saveTodayPrefs } from "./prefs";
import { loadPlanningHours, requireToday, savePlanningHours } from "./window";

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
add("GET", "/hours", async ({ env, user }) => json(await loadPlanningHours(env.DB, user.email)));
add("PUT", "/hours", async ({ env, request, user }) => json(await savePlanningHours(env.DB, user, await readJson(request))));

export async function handleTodayApi(request: Request, env: Env, user: PortalUser): Promise<Response> {
    requireToday(user);
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
