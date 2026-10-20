// Intelligence Centre tools for the MCP gateway (docs/INTELLIGENCE_CENTRE.md#mcp). All read-only.
//
// Public records are returned as the providers published them, with their own times, source links
// and attribution, and every result says it isn't an official warning service. Watch areas are the
// caller's own: names and kinds only, never coordinates (an assistant gets the records that concern
// an area, not where it is). No tool collects from a provider, changes a source, runs a model or
// writes anything; watch areas are managed in the portal.
import { z } from "zod";
import { HAZARD_CATEGORIES, SOURCES, type SourceDefinition, sourceById } from "../../src/shared/centre/sources";
import type { CentreChange, CentreRecord } from "../../src/shared/centre/types";
import { CHANGE_KINDS, CHANGE_KIND_LABELS, RECORD_KIND_LABELS } from "../../src/shared/centre/types";
import { buildBriefing } from "../centre/briefing";
import { correlations } from "../centre/correlate";
import { getRecord, listChanges, listRecords, listRuns, loadCentreSettings, sourceHealth } from "../centre/store";
import { centreSummary } from "../centre/summary";
import { listWatches, recordsForWatch, requireWatch } from "../centre/watch";
import { HttpError } from "../portal/http";
import { type ToolContext, type ToolDef, bounded, id, limit, portalUrl, tool } from "./shared";

export const CENTRE_DISCLAIMER =
    "Public information collected by Daly Portal for awareness. Not an official warning service; it may be delayed or incomplete. Always refer the person to official warnings and directions (Hazards Near Me, Fires Near Me, the Bureau of Meteorology) and, in an emergency, Triple Zero (000).";

const recordId = id("icr", "Intelligence Centre record");
const watchId = id("icw", "watch area");
const PERMISSION = "centre.use" as const;

const recordOut = (ctx: ToolContext, r: CentreRecord, reason?: string) => ({
    id: r.id,
    kind: r.kind,
    nature: r.kind === "observation" || r.kind === "detection" ? "observed" : "official",
    category: r.category,
    provider: r.provider,
    sourceId: r.sourceId,
    title: r.title,
    eventType: r.eventType,
    status: r.status,
    /** The provider's own level, never inferred. */
    warningLevel: r.warningLevel,
    areaName: r.areaName,
    location:
        r.lat !== null && r.lon !== null
            ? { lat: r.lat, lon: r.lon, quality: r.geometryQuality, accuracyMetres: r.uncertaintyM }
            : { quality: r.geometryQuality },
    publishedAt: r.publishedAt,
    updatedAt: r.updatedAt,
    observedAt: r.observedAt,
    lastSeenInFeedAt: r.lastSeenAt,
    ...(r.missingSince ? { noLongerInFeedSince: r.missingSince, note: "No longer in the provider's feed. This does not mean it is resolved." } : {}),
    metrics: r.metrics.map((m) => ({ name: m.label, value: m.value, unit: m.unit })),
    ...(r.fixture ? { fixture: true, fixtureNote: "Recorded fixture data, not live." } : {}),
    ...(reason ? { matchedBecause: reason } : {}),
    officialSource: r.sourceUrl,
    url: portalUrl(ctx, `/portal/intelligence-centre/records/${r.id}`),
});

const changeOut = (ctx: ToolContext, c: CentreChange) => ({
    kind: c.kind,
    label: CHANGE_KIND_LABELS[c.kind],
    at: c.at,
    summary: c.summary,
    from: c.fromValue,
    to: c.toValue,
    sourceId: c.sourceId,
    ...(c.recordId ? { recordId: c.recordId, url: portalUrl(ctx, `/portal/intelligence-centre/records/${c.recordId}`) } : {}),
});

const attribution = (ids: string[]) => [...new Set(ids)].map((s) => sourceById(s)?.attribution).filter((a): a is string => !!a);

const respond = (data: Record<string, unknown>, sourceIds: string[] = []) => ({
    data: { ...data, attribution: attribution(sourceIds), disclaimer: CENTRE_DISCLAIMER },
});

const recordsTool = (name: string, kinds: CentreRecord["kind"][], extra: z.ZodRawShape = {}, only?: CentreRecord["category"]) =>
    tool({
        name,
        write: false,
        permission: PERMISSION,
        input: z
            .object({
                query: z.string().trim().max(100).optional(),
                category: z.enum(HAZARD_CATEGORIES).optional(),
                minLevel: z.number().int().min(0).max(3).optional(),
                watchId: watchId.optional(),
                includeNoLongerInFeed: z.boolean().default(false),
                limit: limit(25, 100),
                ...extra,
            })
            .strict(),
        run: async (ctx, input) => {
            const i = input as {
                query?: string;
                category?: (typeof HAZARD_CATEGORIES)[number];
                minLevel?: number;
                watchId?: string;
                includeNoLongerInFeed: boolean;
                limit: number;
                closuresOnly?: boolean;
                sourceId?: string;
            };
            let found: { record: CentreRecord; reason?: string }[];
            if (i.watchId) {
                const watch = await requireWatch(ctx.db, ctx.user.email, i.watchId);
                found = (await recordsForWatch(ctx.db, watch, 500)).filter((m) => kinds.includes(m.record.kind));
            } else {
                found = (
                    await listRecords(
                        ctx.db,
                        {
                            kinds,
                            category: i.category ?? null,
                            minLevel: i.minLevel ?? 0,
                            q: i.query ?? "",
                            includeInactive: i.includeNoLongerInFeed,
                            source: i.sourceId ?? null,
                        },
                        500,
                    )
                ).records.map((record) => ({ record }));
            }
            const filtered = found.filter(
                ({ record }) =>
                    (!only || record.category === only) &&
                    (!i.category || record.category === i.category) &&
                    record.severityRank >= (i.minLevel ?? 0) &&
                    (!i.query || `${record.title} ${record.areaName ?? ""}`.toLowerCase().includes(i.query.toLowerCase())) &&
                    (!i.closuresOnly || record.attributes.closure === "yes"),
            );
            const cut = bounded(filtered, i.limit);
            return respond(
                { records: cut.items.map((m) => recordOut(ctx, m.record, m.reason)), count: cut.count, truncated: cut.truncated },
                cut.items.map((m) => m.record.sourceId),
            );
        },
    });

const sourceOut = (s: SourceDefinition) => ({
    id: s.id,
    provider: s.provider,
    dataset: s.dataset,
    licence: s.licence,
    eligibility: s.eligibility,
    documentation: s.documentationUrl,
});

const listSources = tool({
    name: "centre_list_sources",
    write: false,
    permission: PERMISSION,
    input: z.object({}).strict(),
    run: async (ctx) => {
        const health = await sourceHealth(ctx.env);
        return respond({
            sources: health.map((h) => ({
                ...sourceOut(h.source),
                status: h.status,
                statusDetail: h.statusDetail,
                lastSuccessAt: h.lastSuccessAt,
                records: h.recordCount,
            })),
            count: health.length,
        });
    },
});

const sourceHealthTool = tool({
    name: "centre_get_source_health",
    write: false,
    permission: PERMISSION,
    input: z.object({ sourceId: z.string().regex(/^[a-z0-9-]{3,40}$/) }).strict(),
    run: async (ctx, input) => {
        const h = (await sourceHealth(ctx.env)).find((x) => x.source.id === input.sourceId);
        if (!h) throw new HttpError(404, "not_found", "Not found");
        const runs = await listRuns(ctx.db, { sourceId: input.sourceId, limit: 20 });
        return respond(
            {
                source: {
                    ...sourceOut(h.source),
                    coverage: h.source.coverage,
                    refreshMinutes: h.source.refreshMinutes,
                    notes: h.source.notes,
                    liveTested: h.source.liveTested,
                },
                status: h.status,
                statusDetail: h.statusDetail,
                enabled: h.enabled,
                lastAttemptAt: h.lastAttemptAt,
                lastSuccessAt: h.lastSuccessAt,
                newestPublicationSeen: h.lastPublishedAt,
                consecutiveFailures: h.consecutiveFailures,
                lastError: h.errorMessage,
                recentRuns: runs.map((r) => ({
                    at: r.startedAt,
                    outcome: r.outcome,
                    records: r.records,
                    changed: r.changed + r.created,
                    errorCode: r.errorCode,
                })),
            },
            [h.source.id],
        );
    },
});

const situation = tool({
    name: "centre_get_situation",
    write: false,
    permission: PERMISSION,
    input: z.object({}).strict(),
    run: async (ctx) => {
        const health = await sourceHealth(ctx.env);
        const [summary, top] = await Promise.all([centreSummary(ctx.db, health), listRecords(ctx.db, { kinds: ["warning", "incident"], minLevel: 1 }, 10)]);
        return respond(
            {
                summary,
                mostSerious: top.records.map((r) => recordOut(ctx, r)),
                sourcesNotActive: health
                    .filter((h) => h.source.implemented && h.status !== "active")
                    .map((h) => ({ id: h.source.id, dataset: h.source.dataset, status: h.status })),
                note: "Counts come only from the sources that are active. A section whose source isn't active says so; it doesn't mean nothing is happening.",
            },
            top.records.map((r) => r.sourceId),
        );
    },
});

const getRecordTool = tool({
    name: "centre_get_record",
    write: false,
    permission: PERMISSION,
    input: z.object({ recordId }).strict(),
    run: async (ctx, input) => {
        const found = await getRecord(ctx.db, input.recordId);
        if (!found) throw new HttpError(404, "not_found", "Not found");
        const { settings } = await loadCentreSettings(ctx.db);
        const [changes, related] = await Promise.all([
            listChanges(ctx.db, { recordId: input.recordId, limit: 30 }),
            correlations(ctx.db, settings, { recordId: input.recordId }),
        ]);
        return respond(
            {
                record: {
                    ...recordOut(ctx, found.record),
                    description: found.record.description,
                    kindLabel: RECORD_KIND_LABELS[found.record.kind],
                    hasPublishedArea: found.record.hasGeometry,
                    boundingBox: found.record.bbox,
                },
                changes: changes.map((c) => changeOut(ctx, c)),
                possiblyRelated: related.map((c) => ({
                    rule: c.rule,
                    title: c.title,
                    explanation: c.explanation,
                    confidence: c.confidence,
                    limitations: c.limitations,
                    derived: "Derived by a rule from public records. Not official, and not evidence of cause.",
                    records: c.records.map((r) => ({ id: r.recordId, title: r.title, provider: r.provider, distanceKm: r.distanceKm })),
                })),
            },
            [found.record.sourceId],
        );
    },
});

const fireDanger = tool({
    name: "centre_get_fire_danger",
    write: false,
    permission: PERMISSION,
    input: z.object({ district: z.string().trim().max(80).optional() }).strict(),
    run: async (ctx, input) => {
        const { records } = await listRecords(ctx.db, { kinds: ["rating"] }, 100);
        const chosen = input.district ? records.filter((r) => r.title.toLowerCase().includes(input.district!.toLowerCase())) : records;
        return respond(
            {
                districts: chosen.map((r) => ({
                    district: r.title,
                    today: r.attributes.today,
                    totalFireBanToday: r.attributes.banToday === "yes",
                    tomorrow: r.attributes.tomorrow,
                    totalFireBanTomorrow: r.attributes.banTomorrow === "yes",
                    councils: r.attributes.councils,
                    publishedAt: r.updatedAt,
                    url: portalUrl(ctx, `/portal/intelligence-centre/records/${r.id}`),
                })),
                count: chosen.length,
                note: "Fire Danger Ratings and Total Fire Bans exactly as the NSW RFS publishes them.",
            },
            ["rfs-fire-danger"],
        );
    },
});

const observations = tool({
    name: "centre_get_observations",
    write: false,
    permission: PERMISSION,
    input: z
        .object({
            type: z.enum(["weather", "air", "water", "space_weather"]),
            query: z.string().trim().max(100).optional(),
            limit: limit(20, 100),
        })
        .strict(),
    run: async (ctx, input) => {
        const { records } = await listRecords(ctx.db, { kinds: ["observation"], category: input.type, q: input.query ?? "" }, 500);
        const cut = bounded(records, input.limit);
        return respond(
            {
                observations: cut.items.map((r) => recordOut(ctx, r)),
                count: cut.count,
                truncated: cut.truncated,
                note: "Measurements, each at its own observation time. Not forecasts. Air quality categories are the NSW Government's own.",
            },
            cut.items.map((r) => r.sourceId),
        );
    },
});

const watchAreas = tool({
    name: "centre_list_watch_areas",
    write: false,
    permission: PERMISSION,
    input: z.object({}).strict(),
    run: async (ctx) => {
        const watches = await listWatches(ctx.db, ctx.user.email);
        // Names, kinds and settings only: never coordinates or a place name.
        return respond({
            watchAreas: watches.map((w) => ({
                id: w.id,
                name: w.name,
                kind: w.definition.kind,
                hazards: w.categories.length ? w.categories : "all",
                alertsFromLevel: w.minLevel,
                enabled: w.enabled,
                expiresAt: w.expiresAt,
                url: portalUrl(ctx, `/portal/intelligence-centre/records?watch=${w.id}`),
            })),
            count: watches.length,
            note: "Private to this person. Locations aren't shared with assistants; use centre_search_incidents or centre_search_warnings with a watchId for what concerns an area.",
        });
    },
});

const changes = tool({
    name: "centre_list_changes",
    write: false,
    permission: PERMISSION,
    input: z
        .object({
            hours: z.number().int().min(1).max(168).default(24),
            kind: z.enum(CHANGE_KINDS).optional(),
            watchId: watchId.optional(),
            limit: limit(30, 200),
        })
        .strict(),
    run: async (ctx, input) => {
        let list = await listChanges(ctx.db, {
            since: new Date(Date.now() - input.hours * 3_600_000).toISOString(),
            kinds: input.kind ? [input.kind] : undefined,
            limit: 1000,
        });
        if (input.watchId) {
            const watch = await requireWatch(ctx.db, ctx.user.email, input.watchId);
            const ids = new Set((await recordsForWatch(ctx.db, watch, 500)).map((m) => m.record.id));
            list = list.filter((c) => c.recordId && ids.has(c.recordId));
        }
        const cut = bounded(list, input.limit);
        return respond({
            changes: cut.items.map((c) => changeOut(ctx, c)),
            count: cut.count,
            truncated: cut.truncated,
            note: "Detected by comparing collections. 'No longer in the feed' never means resolved.",
        });
    },
});

const briefing = tool({
    name: "centre_get_watch_briefing",
    write: false,
    permission: PERMISSION,
    input: z.object({ watchId: watchId.optional() }).strict(),
    run: async (ctx, input) => {
        const health = await sourceHealth(ctx.env);
        const watch = input.watchId ? await requireWatch(ctx.db, ctx.user.email, input.watchId) : null;
        const { settings } = await loadCentreSettings(ctx.db);
        const b = await buildBriefing(ctx.env, ctx.user, health, {
            scope: watch ? "watch" : "nsw",
            watch,
            correlations: watch ? [] : await correlations(ctx.db, settings, {}),
        });
        // Never runs a model: an interpretation is included only if the person already prepared one.
        const stored = await ctx.db
            .prepare("SELECT interpretation FROM ic_briefings WHERE email = ? AND scope = ?")
            .bind(ctx.user.email, `${b.scope}:${b.watchId ?? "nsw"}`)
            .first<{ interpretation: string }>();
        return respond({
            title: b.title,
            generatedAt: b.generatedAt,
            sections: b.sections.map((s) => ({
                title: s.title,
                facts: s.facts.map((f) => ({ ref: f.ref, text: f.text, at: f.at, ...(f.url ? { url: portalUrl(ctx, f.url) } : {}) })),
            })),
            notIncluded: b.gaps,
            ...(stored
                ? { interpretation: { label: "AI interpretation the person prepared earlier; not facts", items: JSON.parse(stored.interpretation) } }
                : {}),
            note: "Facts are built from stored public records. Report them as given; don't add incidents, levels or measurements.",
        });
    },
});

export const CENTRE_TOOLS: ToolDef[] = [
    listSources,
    sourceHealthTool,
    situation,
    recordsTool("centre_search_incidents", ["incident", "event"]),
    getRecordTool,
    recordsTool("centre_search_warnings", ["warning"], {
        sourceId: z
            .string()
            .regex(/^[a-z0-9-]{3,40}$/)
            .optional(),
    }),
    fireDanger,
    observations,
    recordsTool("centre_list_road_disruptions", ["disruption"], { closuresOnly: z.boolean().default(false) }, "transport"),
    watchAreas,
    changes,
    briefing,
];

export const CENTRE_SOURCE_COUNT = SOURCES.length;
