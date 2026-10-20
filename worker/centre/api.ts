// JSON API for the Intelligence Centre (/api/portal/centre/*). By the time a request gets here the
// portal router has verified the Access identity, the portal role and the same-origin rules. Every
// route needs "centre.use"; managing sources and account settings needs "portal.settings.manage".
// Watch areas, alerts, preferences and wallboards are the caller's own (404 for anyone else's).
import type { ExecutionContext } from "@cloudflare/workers-types";
import { z } from "zod";
import { FEED_CHANGE_GROUPS, type FeedFilters } from "../../src/shared/centre/history";
import { REGION_IDS, type RegionId, regionById } from "../../src/shared/centre/regions";
import { reportRequestSchema } from "../../src/shared/centre/reports";
import { HAZARD_CATEGORIES } from "../../src/shared/centre/sources";
import { RECORD_KINDS } from "../../src/shared/centre/types";
import { MAP_LAYERS } from "../../src/shared/centre/types";
import type { PortalUser } from "../../src/shared/portal/types";
import type { Env } from "../env";
import { can } from "../portal/auth";
import { HttpError, json, readJson } from "../portal/http";
import { allow } from "../wedding/rsvp";
import { knowledgeFromBriefing, knowledgeFromRecord, knowledgeFromTimeline, linkEvent, listEventLinks, taskFromRecord, unlinkEvent } from "./actions";
import { acknowledgeAlerts, listAlerts } from "./alerts";
import { askAssistant } from "./assistant";
import { basemapInfo, serveTile } from "./basemap";
import { buildBriefing, withInterpretation } from "./briefing";
import { correlations } from "./correlate";
import { displayStateKey, wallboardPayloadV2 } from "./display";
import { type BBox, NSW_BBOX } from "./geo";
import { centreAnalytics, changeFeed, recordTimeline, replayCompare, replayFrame, replayMeta, situationTimeline, sourceReliability } from "./history";
import { collectSource } from "./ingest";
import { mapFeatures } from "./map";
import {
    buildReport,
    createSchedule,
    deleteReport,
    deleteSchedule,
    generateReport,
    getReport,
    listReports,
    listSchedules,
    reportToKnowledge,
    updateSchedule,
} from "./reports";
import { acknowledgeMatches, createRule, deleteRule, listMatches, listRules, taskFromMatch, testRule, updateRule } from "./rules";
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
import {
    createDisplayToken,
    createWallboard,
    deleteWallboard,
    duplicateWallboard,
    listWallboards,
    requireWallboard,
    revokeDisplayToken,
    saveViews,
    updateWallboard,
} from "./wallboard";
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

// --- History: timelines, replay, the change feed, analytics (9.1) ------------------------------------

const iso = z.iso.datetime({ offset: true });
const region = z.enum(REGION_IDS).nullable();

/** The "What's changed" filters from a query string (bad values are refused, not guessed). */
export async function feedFilters(env: Env, user: PortalUser, url: URL): Promise<FeedFilters & { watchArea: Awaited<ReturnType<typeof requireWatch>> | null }> {
    const get = (k: string) => url.searchParams.get(k) || undefined;
    const now = Date.now();
    const f = z
        .object({
            hazard: z.enum(HAZARD_CATEGORIES).nullable().default(null),
            region: region.default(null),
            watch: z
                .string()
                .regex(/^icw_[a-z0-9]{14}$/)
                .nullable()
                .default(null),
            from: iso.default(new Date(now - 86_400_000).toISOString()),
            to: iso.default(new Date(now).toISOString()),
            minLevel: z.coerce.number().int().min(0).max(5).default(0),
            source: z
                .string()
                .regex(/^[a-z0-9-]{3,40}$/)
                .nullable()
                .default(null),
            group: z
                .enum(FEED_CHANGE_GROUPS.map((g) => g.id) as [string, ...string[]])
                .nullable()
                .default(null),
            significance: z.enum(["significant", "all"]).default("significant"),
        })
        .parse({
            hazard: get("hazard") ?? null,
            region: get("region") ?? null,
            watch: get("watch") ?? null,
            from: get("from"),
            to: get("to"),
            minLevel: get("minLevel"),
            source: get("source") ?? null,
            group: get("group") ?? null,
            significance: get("significance"),
        });
    if (Date.parse(f.to) - Date.parse(f.from) > 31 * 86_400_000) throw new HttpError(400, "bad_range", "Choose at most 31 days");
    return { ...f, watchArea: f.watch ? await requireWatch(env.DB, user.email, f.watch) : null };
}

add("GET", "/feed", async ({ env, user, url }) => {
    const filters = await feedFilters(env, user, url);
    return json(await changeFeed(env, filters, Math.min(500, Number(url.searchParams.get("limit") ?? 300) || 300)));
});
add("GET", "/records/:id/timeline", async ({ env, params }) => {
    const timeline = await recordTimeline(env, recordId(params.id));
    if (!timeline) throw new HttpError(404, "not_found", "Not found");
    return json({ timeline });
});
add("POST", "/records/:id/timeline/knowledge", async ({ env, user, request, params }) =>
    json(await knowledgeFromTimeline(env, user, recordId(params.id), await readJson(request))),
);
add("GET", "/timeline", async ({ env, user, url }) => {
    const watchId = url.searchParams.get("watch");
    const regionId = region.parse(url.searchParams.get("region") || null) as RegionId | null;
    const hours = z.coerce
        .number()
        .int()
        .min(1)
        .max(720)
        .default(24)
        .parse(url.searchParams.get("hours") ?? undefined);
    const watch = watchId ? await requireWatch(env.DB, user.email, watchId) : null;
    return json({ timeline: await situationTimeline(env, { watch, region: regionId }, hours) });
});

const replayScope = async (env: Env, user: PortalUser, url: URL) => {
    const watchId = url.searchParams.get("watch");
    const regionId = region.parse(url.searchParams.get("region") || null);
    const layers = (url.searchParams.get("layers") ?? "").split(",").filter(Boolean);
    return {
        watch: watchId ? await requireWatch(env.DB, user.email, watchId) : null,
        bbox: regionId && regionId !== "nsw" && regionId !== "australia" ? regionById(regionId)!.bbox : null,
        layers: z.array(z.enum(MAP_LAYERS)).max(MAP_LAYERS.length).parse(layers),
        includeInactive: url.searchParams.get("includeInactive") === "1",
    };
};
add("GET", "/replay", async ({ env, user, url }) => {
    const at = iso.parse(url.searchParams.get("at") ?? undefined);
    if (Date.parse(at) > Date.now() + 60_000) throw new HttpError(400, "bad_time", "Replay can't show the future");
    return json({ frame: await replayFrame(env, new Date(at), await replayScope(env, user, url)) });
});
add("GET", "/replay/meta", async ({ env, url }) => {
    const to = new Date(iso.default(new Date().toISOString()).parse(url.searchParams.get("to") ?? undefined));
    const from = new Date(iso.default(new Date(to.getTime() - 86_400_000).toISOString()).parse(url.searchParams.get("from") ?? undefined));
    if (to.getTime() - from.getTime() > 31 * 86_400_000 || to <= from) throw new HttpError(400, "bad_range", "Choose up to 31 days");
    return json({ meta: await replayMeta(env, from, to) });
});
add("GET", "/replay/compare", async ({ env, user, url }) => {
    const a = iso.parse(url.searchParams.get("a") ?? undefined);
    const b = iso.parse(url.searchParams.get("b") ?? undefined);
    return json({ comparison: await replayCompare(env, new Date(a), new Date(b), await replayScope(env, user, url)) });
});
add("GET", "/analytics", async ({ env, url }) => {
    const days = z.coerce
        .number()
        .int()
        .refine((d) => [7, 30, 90].includes(d), "7, 30 or 90 days")
        .default(30)
        .parse(url.searchParams.get("days") ?? undefined);
    return json({ analytics: await centreAnalytics(env, days) });
});
add("GET", "/reliability", async ({ env, url }) => {
    const days = z.coerce
        .number()
        .int()
        .min(1)
        .max(400)
        .default(30)
        .parse(url.searchParams.get("days") ?? undefined);
    return json({ reliability: await sourceReliability(env.DB, days) });
});

// --- Monitoring rules ----------------------------------------------------------------------------------

add("GET", "/rules", async ({ env, user }) =>
    json({ rules: await listRules(env.DB, user.email), matches: await listMatches(env.DB, user.email, { limit: 100 }) }),
);
add("POST", "/rules", async ({ env, user, request }) => json({ rule: await createRule(env.DB, user, await readJson(request)) }, 201));
add("POST", "/rules/test", async ({ env, user, request, url }) => {
    if (!(await allow(env.DB, "centre-rule-test", user.email, 30, 3600)))
        throw new HttpError(429, "rate_limited", "Too many tests this hour. Try again later.");
    const days = z.coerce
        .number()
        .int()
        .min(1)
        .max(30)
        .default(7)
        .parse(url.searchParams.get("days") ?? undefined);
    return json({ result: await testRule(env, user, await readJson(request), days) });
});
add("GET", "/rules/matches", async ({ env, user, url }) =>
    json({
        matches: await listMatches(env.DB, user.email, {
            open: url.searchParams.get("open") === "1",
            ruleId: url.searchParams.get("rule") ?? undefined,
            limit: 200,
        }),
    }),
);
add("POST", "/rules/matches/acknowledge", async ({ env, user, request }) => {
    const body = z
        .object({ ids: z.union([z.array(z.string()).max(200), z.literal("all")]) })
        .strict()
        .parse(await readJson(request));
    await acknowledgeMatches(env.DB, user, body.ids);
    return json({ ok: true });
});
add("POST", "/rules/matches/:id/task", async ({ env, user, request, params }) => json(await taskFromMatch(env, user, params.id, await readJson(request))));
add("PUT", "/rules/:id", async ({ env, user, request, params }) => json({ rule: await updateRule(env.DB, user, params.id, await readJson(request)) }));
add("DELETE", "/rules/:id", async ({ env, user, params }) => {
    await deleteRule(env.DB, user, params.id);
    return json({ ok: true });
});

// --- Situation reports -----------------------------------------------------------------------------------

add("GET", "/reports", async ({ env, user }) => json({ reports: await listReports(env.DB, user.email), schedules: await listSchedules(env.DB, user.email) }));
add("POST", "/reports/preview", async ({ env, user, request }) => {
    if (!(await allow(env.DB, "centre-report", user.email, 30, 3600))) throw new HttpError(429, "rate_limited", "Too many reports this hour. Try again later.");
    return json({ report: await buildReport(env, user, reportRequestSchema.parse(await readJson(request))) });
});
add("POST", "/reports", async ({ env, user, request }) => {
    if (!(await allow(env.DB, "centre-report", user.email, 30, 3600))) throw new HttpError(429, "rate_limited", "Too many reports this hour. Try again later.");
    return json(await generateReport(env, user, await readJson(request)), 201);
});
add("GET", "/reports/:id", async ({ env, user, params }) => json(await getReport(env, user.email, params.id)));
add("DELETE", "/reports/:id", async ({ env, user, params }) => {
    await deleteReport(env, user, params.id);
    return json({ ok: true });
});
add("POST", "/reports/:id/knowledge", async ({ env, user, request, params }) => json(await reportToKnowledge(env, user, params.id, await readJson(request))));
add("GET", "/schedules", async ({ env, user }) => json({ schedules: await listSchedules(env.DB, user.email) }));
add("POST", "/schedules", async ({ env, user, request }) => json({ schedule: await createSchedule(env.DB, user, await readJson(request)) }, 201));
add("PUT", "/schedules/:id", async ({ env, user, request, params }) =>
    json({ schedule: await updateSchedule(env.DB, user, params.id, await readJson(request)) }),
);
add("DELETE", "/schedules/:id", async ({ env, user, params }) => {
    await deleteSchedule(env.DB, user, params.id);
    return json({ ok: true });
});

// --- Assistant ---------------------------------------------------------------------------------------

add("POST", "/assistant", async ({ env, user, request }) => json({ answer: await askAssistant(env, user, await readJson(request)) }));

// --- Wallboard 2.0 -------------------------------------------------------------------------------------

add("PUT", "/wallboards/:id/views", async ({ env, user, request, params }) =>
    json({ wallboard: await saveViews(env.DB, user, params.id, await readJson(request)) }),
);
add("POST", "/wallboards/:id/duplicate", async ({ env, user, request, params }) =>
    json({ wallboard: await duplicateWallboard(env.DB, user, params.id, await readJson(request)) }, 201),
);
/** The owner's own preview of a board: exactly what a screen would get (no credential involved). */
add("GET", "/wallboards/:id/preview", async ({ env, user, params }) => {
    const board = await requireWallboard(env.DB, user.email, params.id);
    const wallboard = await wallboardPayloadV2(env, board, user, { stateKey: await displayStateKey(env.DB, board) });
    // The owner's browser fetches tiles through Access, not a display credential.
    return json({ wallboard: { ...wallboard, basemap: await basemapInfo(env, "portal") } });
});

// --- Journeys ---------------------------------------------------------------------------------------

add("GET", "/events/links", async ({ env, user }) => json({ links: await listEventLinks(env, user) }));
add("POST", "/events/links", async ({ env, user, request }) => json({ links: await linkEvent(env, user, await readJson(request)) }, 201));
add("DELETE", "/events/links/:id", async ({ env, user, params }) => {
    await unlinkEvent(env, user, params.id);
    return json({ ok: true });
});

// --- Detailed basemap ---------------------------------------------------------------------------------

add("GET", "/basemap", async ({ env }) => json({ basemap: await basemapInfo(env, "portal") }));
add("GET", "/basemap/:z/:x/:tile", async ({ env, request, params }) => {
    const y = /^(\d{1,6})\.mvt$/.exec(params.tile)?.[1];
    if (!y || !/^\d{1,2}$/.test(params.z) || !/^\d{1,6}$/.test(params.x)) throw new HttpError(404, "not_found", "Not found");
    return serveTile(env, request, Number(params.z), Number(params.x), Number(y));
});

export const DEFAULT_BBOX = NSW_BBOX;
