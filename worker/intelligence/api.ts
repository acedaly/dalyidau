// JSON API for Daly Intelligence (/api/portal/intelligence/*). The portal router has already
// verified the Access identity, the portal role and the same-origin rules. This router adds the
// "intelligence.use" permission; every handler then works only on the caller's own preferences,
// briefings and usage (settings are for owners and admins).
//
// Capture, suggestions, semantic search, jobs and attachments were retired with Daly Knowledge and
// Daly Tasks: their paths answer 410 Gone (worker/portal/retired.ts).
import { z } from "zod";
import type { PortalUser } from "../../src/shared/portal/types";
import type { Env } from "../env";
import { can } from "../portal/auth";
import { HttpError, json, readJson } from "../portal/http";
import { getBriefing } from "./briefings";
import { intelligenceStatus, loadConfig, loadPreferences, saveConfig, savePreferences } from "./settings";
import { usageSummary } from "./usage";

interface Ctx {
    env: Env;
    request: Request;
    url: URL;
    user: PortalUser;
    params: Record<string, string>;
    site: string;
}

type Handler = (ctx: Ctx) => Promise<Response>;
const routes: { method: string; pattern: RegExp; keys: string[]; handler: Handler }[] = [];
const add = (method: string, path: string, handler: Handler) => {
    const keys: string[] = [];
    const pattern = new RegExp(
        `^/api/portal/intelligence${path.replace(/:([a-zA-Z]+)/g, (_, key: string) => {
            keys.push(key);
            return "([^/]+)";
        })}$`,
    );
    routes.push({ method, pattern, keys, handler });
};

const requireManage = (user: PortalUser) => {
    if (!can(user, "portal.settings.manage")) throw new HttpError(403, "forbidden", "Only owners and admins can change Intelligence settings");
};

// --- Status, settings, preferences, usage ----------------------------------------------------------

add("GET", "/status", async ({ env }) => json({ status: await intelligenceStatus(env) }));

add("GET", "/settings", async ({ env }) => json(await loadConfig(env.DB)));
add("PUT", "/settings", async ({ env, request, user }) => {
    requireManage(user);
    const body = z
        .object({ version: z.number().int().min(0), config: z.unknown() })
        .strict()
        .parse(await readJson(request));
    return json(await saveConfig(env.DB, user, body.config, body.version));
});

add("GET", "/preferences", async ({ env, user }) => json(await loadPreferences(env.DB, user.email)));
add("PUT", "/preferences", async ({ env, request, user }) => {
    const body = z
        .object({ version: z.number().int().min(0), preferences: z.unknown() })
        .strict()
        .parse(await readJson(request));
    return json(await savePreferences(env.DB, user, body.preferences, body.version));
});

add("GET", "/usage", async ({ env, user }) => json({ usage: await usageSummary(env.DB, (await loadConfig(env.DB)).config, user.email) }));

// --- Briefings -------------------------------------------------------------------------------------

const kindOf = (value: string) => {
    if (value !== "daily" && value !== "weekly") throw new HttpError(404, "not_found", "Not found");
    return value;
};
add("GET", "/briefings/:kind", async ({ env, user, params, site }) => json({ briefing: await getBriefing(env, user, kindOf(params.kind), { site }) }));
add("POST", "/briefings/:kind/recommend", async ({ env, user, params, site }) =>
    json({ briefing: await getBriefing(env, user, kindOf(params.kind), { site, recommend: true }) }),
);

// --- Dispatch --------------------------------------------------------------------------------------

export async function handleIntelligenceApi(request: Request, env: Env, user: PortalUser): Promise<Response> {
    if (!can(user, "intelligence.use")) throw new HttpError(403, "forbidden", "You don't have access to Intelligence");
    const url = new URL(request.url);
    const method = request.method === "HEAD" ? "GET" : request.method;
    let pathMatched = false;
    for (const route of routes) {
        const match = route.pattern.exec(url.pathname);
        if (!match) continue;
        pathMatched = true;
        if (route.method !== method) continue;
        const params = Object.fromEntries(route.keys.map((key, i) => [key, decodeURIComponent(match[i + 1])]));
        return route.handler({ env, request, url, user, params, site: new URL(env.SITE_URL).origin });
    }
    if (pathMatched) throw new HttpError(405, "method_not_allowed", "Method not allowed");
    throw new HttpError(404, "not_found", "Not found");
}
