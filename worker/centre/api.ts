// JSON API for the Intelligence Centre (/api/portal/centre/*). By the time a request gets here the
// portal router has verified the Access identity, the portal role and the same-origin rules. Every
// route needs "centre.use"; managing sources and account settings needs "portal.settings.manage".
// Watch areas, alerts, preferences and wallboards are the caller's own (404 for anyone else's).
import type { ExecutionContext } from "@cloudflare/workers-types";
import { z } from "zod";
import { HAZARD_CATEGORIES } from "../../src/shared/centre/sources";
import { RECORD_KINDS } from "../../src/shared/centre/types";
import type { PortalUser } from "../../src/shared/portal/types";
import type { Env } from "../env";
import { can } from "../portal/auth";
import { HttpError, json, readJson } from "../portal/http";
import { allow } from "../wedding/rsvp";
import { knowledgeFromBriefing, knowledgeFromRecord, taskFromRecord } from "./actions";
import { acknowledgeAlerts, listAlerts } from "./alerts";
import { buildBriefing, withInterpretation } from "./briefing";
import { correlations } from "./correlate";
import { type BBox, NSW_BBOX } from "./geo";
import { collectSource } from "./ingest";
import { mapFeatures } from "./map";
import {
    getRecord,
    listChanges,
    listRecords,
    listRuns,
    loadCentreSettings,
    loadPreferences,
    saveCentreSettings,
    savePreferences,
    seriesFor,
    setSourceEnabled,
    sourceHealth,
} from "./store";
import { centreSummary } from "./summary";
import { createDisplayToken, createWallboard, deleteWallboard, listWallboards, revokeDisplayToken, updateWallboard } from "./wallboard";
import { createWatch, deleteWatch, listWatches, recordsForWatch, requireWatch, updateWatch } from "./watch";

interface Ctx {
    env: Env;
    request: Request;
    url: URL;
    user: PortalUser;
    params: Record<string, string>;
    exec?: Pick<ExecutionContext, "waitUntil">;
}
type Handler = (ctx: Ctx) => Promise<Response>;

const routes: { method: string; pattern: RegExp; keys: string[]; handler: Handler; manage?: boolean }[] = [];
const add = (method: string, path: string, handler: Handler, manage = false) => {
    const keys: string[] = [];
    const pattern = new RegExp(
        `^/api/portal/centre${path.replace(/:([a-zA-Z]+)/g, (_, key: string) => {
            keys.push(key);
            return "([^/]+)";
        })}$`,
    );
    routes.push({ method, pattern, keys, handler, manage });
};

const recordId = (id: string) => {
    if (!/^icr_[a-z0-9]{14}$/.test(id)) throw new HttpError(404, "not_found", "Not found");
    return id;
};

export function parseBBox(value: string | null): BBox | undefined {
    if (!value) return undefined;
    const parts = value.split(",").map(Number);
    if (parts.length !== 4 || !parts.every(Number.isFinite)) throw new HttpError(400, "bad_bbox", "bbox is west,south,east,north");
    const [w, s, e, n] = parts;
    if (w < -180 || e > 180 || s < -90 || n > 90 || w >= e || s >= n || e - w > 60 || n - s > 60) throw new HttpError(400, "bad_bbox", "bbox is out of range");
    return [w, s, e, n];
}

const filterSchema = z.object({
    q: z.string().trim().max(100).default(""),
    category: z.enum(HAZARD_CATEGORIES).nullable().default(null),
    kind: z.enum(RECORD_KINDS).nullable().default(null),
    source: z.string().max(40).nullable().default(null),
    minLevel: z.coerce.number().int().min(0).max(5).default(0),
    watch: z
        .string()
        .regex(/^icw_[a-z0-9]{14}$/)
        .nullable()
        .default(null),
    includeInactive: z
        .enum(["0", "1"])
        .default("0")
        .transform((v) => v === "1"),
    limit: z.coerce.number().int().min(1).max(1000).default(300),
    since: z.iso.datetime({ offset: true }).optional(),
});

export const recordFilters = (url: URL) => {
    const get = (k: string) => url.searchParams.get(k) || undefined;
    return filterSchema.parse({
        q: get("q"),
        category: get("category") ?? null,
        kind: get("kind") ?? null,
        source: get("source") ?? null,
        minLevel: get("minLevel"),
        watch: get("watch") ?? null,
        includeInactive: get("includeInactive"),
        limit: get("limit"),
        since: get("since"),
    });
};

/** Records, filtered; with a watch area, only those that concern it (and the reason). */
export async function filteredRecords(env: Env, user: PortalUser, url: URL) {
    const f = recordFilters(url);
    const bbox = parseBBox(url.searchParams.get("bbox"));
    if (f.watch) {
        const watch = await requireWatch(env.DB, user.email, f.watch);
        const matches = (await recordsForWatch(env.DB, watch, f.limit)).filter(
            (m) =>
                (!f.category || m.record.category === f.category) &&
                (!f.kind || m.record.kind === f.kind) &&
                (!f.source || m.record.sourceId === f.source) &&
                m.record.severityRank >= f.minLevel &&
                (!f.q || `${m.record.title} ${m.record.areaName ?? ""}`.toLowerCase().includes(f.q.toLowerCase())),
        );
        return {
            filters: f,
            records: matches.map((m) => m.record),
            reasons: Object.fromEntries(matches.map((m) => [m.record.id, m.reason])),
            truncated: false,
        };
    }
    const { records, truncated } = await listRecords(env.DB, { ...f, bbox, since: f.since }, f.limit);
    return { filters: f, records, reasons: {}, truncated };
}

// --- Records ---------------------------------------------------------------------------------------

add("GET", "/summary", async ({ env }) => json({ summary: await centreSummary(env.DB, await sourceHealth(env)) }));
add("GET", "/records", async ({ env, user, url }) => {
    const { records, reasons, truncated } = await filteredRecords(env, user, url);
    return json({ records, reasons, truncated });
});
add("GET", "/map", async ({ env, user, url }) => {
    const { settings } = await loadCentreSettings(env.DB);
    url.searchParams.set("limit", String(Math.min(1000, settings.maxMapRecords)));
    const { records, truncated } = await filteredRecords(env, user, url);
    return json({ ...(await mapFeatures(env.DB, records)), truncated });
});
add("GET", "/records/:id", async ({ env, params }) => {
    const found = await getRecord(env.DB, recordId(params.id));
    if (!found) throw new HttpError(404, "not_found", "Not found");
    const { settings } = await loadCentreSettings(env.DB);
    const [changes, series, related] = await Promise.all([
        listChanges(env.DB, { recordId: params.id, limit: 100 }),
        seriesFor(env.DB, params.id, new Date(Date.now() - settings.retention.seriesDays * 86_400_000).toISOString()),
        correlations(env.DB, settings, { recordId: params.id }),
    ]);
    return json({ ...found, changes, series, related });
});
add("POST", "/records/:id/task", async ({ env, user, request, params }) => json(await taskFromRecord(env, user, recordId(params.id), await readJson(request))));
add("POST", "/records/:id/knowledge", async ({ env, user, request, params }) =>
    json(await knowledgeFromRecord(env, user, recordId(params.id), await readJson(request))),
);
add("GET", "/changes", async ({ env, url }) => {
    const since = url.searchParams.get("since");
    if (since && !z.iso.datetime({ offset: true }).safeParse(since).success) throw new HttpError(400, "bad_since", "since is an ISO time");
    return json({ changes: await listChanges(env.DB, { since: since ?? new Date(Date.now() - 86_400_000).toISOString(), limit: 500 }) });
});
add("GET", "/correlations", async ({ env, url }) => {
    const { settings } = await loadCentreSettings(env.DB);
    return json({ correlations: await correlations(env.DB, settings, { bbox: parseBBox(url.searchParams.get("bbox")) ?? null }) });
});

// --- Sources ---------------------------------------------------------------------------------------

add("GET", "/sources", async ({ env }) => json({ sources: await sourceHealth(env), runs: await listRuns(env.DB, { limit: 100 }) }));
add(
    "PUT",
    "/sources/:id",
    async ({ env, user, request, params }) => {
        const body = z
            .object({ enabled: z.boolean() })
            .strict()
            .parse(await readJson(request));
        await setSourceEnabled(env.DB, user, params.id, body.enabled);
        return json({ sources: await sourceHealth(env) });
    },
    true,
);
add(
    "POST",
    "/sources/:id/refresh",
    async ({ env, params }) => {
        // A manual refresh still respects the provider: at most three a source in ten minutes.
        if (!(await allow(env.DB, "centre-refresh", params.id, 3, 600)))
            throw new HttpError(429, "rate_limited", "This source was refreshed recently. Try again in a few minutes.");
        const result = await collectSource(env, params.id, { trigger: "manual" });
        if (result.outcome === "skipped") throw new HttpError(409, "not_enabled", "Switch the source on first (or it's being collected right now)");
        return json({ result, sources: await sourceHealth(env) });
    },
    true,
);

// --- Watch areas and alerts ------------------------------------------------------------------------

add("GET", "/watches", async ({ env, user }) => json({ watches: await listWatches(env.DB, user.email) }));
add("POST", "/watches", async ({ env, user, request }) => json({ watch: await createWatch(env.DB, user, await readJson(request)) }, 201));
add("GET", "/watches/:id", async ({ env, user, params }) => {
    const watch = await requireWatch(env.DB, user.email, params.id);
    return json({ watch, matches: await recordsForWatch(env.DB, watch) });
});
add("PUT", "/watches/:id", async ({ env, user, request, params }) => json({ watch: await updateWatch(env.DB, user, params.id, await readJson(request)) }));
add("DELETE", "/watches/:id", async ({ env, user, params }) => {
    await deleteWatch(env.DB, user, params.id);
    return json({ ok: true });
});
add("GET", "/alerts", async ({ env, user, url }) =>
    json({ alerts: await listAlerts(env.DB, user.email, { unacknowledged: url.searchParams.get("open") === "1", limit: 100 }) }),
);
add("POST", "/alerts/acknowledge", async ({ env, user, request }) => {
    const body = z
        .object({ ids: z.union([z.array(z.string()).max(200), z.literal("all")]) })
        .strict()
        .parse(await readJson(request));
    await acknowledgeAlerts(env.DB, user, body.ids);
    return json({ ok: true });
});

// --- Briefings -------------------------------------------------------------------------------------

const briefingFor = async (env: Env, user: PortalUser, scope: string | null, watchId: string | null, request = false) => {
    const health = await sourceHealth(env);
    const { settings } = await loadCentreSettings(env.DB);
    const watch = scope === "watch" && watchId ? await requireWatch(env.DB, user.email, watchId) : null;
    if (scope === "watch" && !watch) throw new HttpError(422, "validation", "Choose a watch area");
    const related = await correlations(env.DB, settings, {});
    const base = await buildBriefing(env, user, health, {
        scope: watch ? "watch" : scope === "morning" ? "morning" : "nsw",
        watch,
        correlations: watch ? [] : related,
    });
    return withInterpretation(env, user, base, { request });
};
add("GET", "/briefing", async ({ env, user, url }) =>
    json({ briefing: await briefingFor(env, user, url.searchParams.get("scope"), url.searchParams.get("watch")) }),
);
add("POST", "/briefing/interpret", async ({ env, user, request }) => {
    const body = z
        .object({ scope: z.enum(["nsw", "watch", "morning"]), watch: z.string().nullable().optional() })
        .strict()
        .parse(await readJson(request));
    return json({ briefing: await briefingFor(env, user, body.scope, body.watch ?? null, true) });
});
add("POST", "/briefing/knowledge", async ({ env, user, request }) => {
    const body = z
        .object({ scope: z.enum(["nsw", "watch", "morning"]), watch: z.string().nullable().optional(), spaceId: z.string().optional() })
        .strict()
        .parse(await readJson(request));
    const briefing = await briefingFor(env, user, body.scope, body.watch ?? null);
    return json(await knowledgeFromBriefing(env, user, briefing, body.spaceId ? { spaceId: body.spaceId } : {}));
});

// --- Preferences and settings ----------------------------------------------------------------------

add("GET", "/preferences", async ({ env, user }) => json(await loadPreferences(env.DB, user.email)));
add("PUT", "/preferences", async ({ env, user, request }) => {
    const body = z
        .object({ preferences: z.unknown(), version: z.number().int().min(0) })
        .strict()
        .parse(await readJson(request));
    return json(await savePreferences(env.DB, user.email, body.preferences, body.version));
});
add("GET", "/settings", async ({ env }) => json(await loadCentreSettings(env.DB)));
add(
    "PUT",
    "/settings",
    async ({ env, user, request }) => {
        const body = z
            .object({ settings: z.unknown(), version: z.number().int().min(0) })
            .strict()
            .parse(await readJson(request));
        return json(await saveCentreSettings(env.DB, user, body.settings, body.version));
    },
    true,
);

// --- Wallboards ------------------------------------------------------------------------------------

add("GET", "/wallboards", async ({ env, user }) => json({ wallboards: await listWallboards(env.DB, user.email) }));
add("POST", "/wallboards", async ({ env, user, request }) => json({ wallboard: await createWallboard(env.DB, user, await readJson(request)) }, 201));
add("PUT", "/wallboards/:id", async ({ env, user, request, params }) =>
    json({ wallboard: await updateWallboard(env.DB, user, params.id, await readJson(request)) }),
);
add("DELETE", "/wallboards/:id", async ({ env, user, params }) => {
    await deleteWallboard(env.DB, user, params.id);
    return json({ ok: true });
});
add("POST", "/wallboards/:id/displays", async ({ env, user, request, params }) =>
    json(await createDisplayToken(env.DB, user, params.id, await readJson(request)), 201),
);
add("DELETE", "/wallboards/:id/displays/:token", async ({ env, user, params }) => {
    await revokeDisplayToken(env.DB, user, params.id, params.token);
    return json({ ok: true });
});

export async function handleCentreApi(request: Request, env: Env, user: PortalUser, exec?: Pick<ExecutionContext, "waitUntil">): Promise<Response> {
    if (!can(user, "centre.use")) throw new HttpError(403, "forbidden", "You don't have access to the Intelligence Centre");
    const url = new URL(request.url);
    const method = request.method === "HEAD" ? "GET" : request.method;
    let pathMatched = false;
    for (const route of routes) {
        const match = route.pattern.exec(url.pathname);
        if (!match) continue;
        pathMatched = true;
        if (route.method !== method) continue;
        if (route.manage && !can(user, "portal.settings.manage"))
            throw new HttpError(403, "forbidden", "Only owners and admins can change sources and settings");
        const params = Object.fromEntries(route.keys.map((key, i) => [key, decodeURIComponent(match[i + 1])]));
        return route.handler({ env, request, url, user, params, exec });
    }
    if (pathMatched) throw new HttpError(405, "method_not_allowed", "Method not allowed");
    throw new HttpError(404, "not_found", "Not found");
}

export const DEFAULT_BBOX = NSW_BBOX;
