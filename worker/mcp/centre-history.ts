// Intelligence Centre 9.1 tools for the MCP gateway (docs/INTELLIGENCE_CENTRE_9_1.md#mcp): the
// change feed, timelines, replay metadata, trends, monitoring rules and matches, situation reports,
// correlations, source reliability and wallboard summaries.
//
// Reads return stored records with their own times, links and attribution, and every result
// carries the disclaimer. Four writes, through the ledger like every MCP write: create and update a
// monitoring rule, schedule a report, save a report. No tool deletes anything, runs a model,
// collects from a provider or returns a display credential, a watch area's location or anyone
// else's rules, reports or wallboards.
import { z } from "zod";
import { FEED_CHANGE_GROUPS } from "../../src/shared/centre/history";
import { REGION_IDS, regionById } from "../../src/shared/centre/regions";
import { reportScopeSchema } from "../../src/shared/centre/reports";
import { CONDITION_META, ruleDefinitionSchema } from "../../src/shared/centre/rules";
import { HAZARD_CATEGORIES, sourceById } from "../../src/shared/centre/sources";
import { PRESET_LABELS, WIDGET_META } from "../../src/shared/centre/wallboard";
import { correlations } from "../centre/correlate";
import { centreAnalytics, changeFeed, recordTimeline, replayFrame, replayMeta, sourceReliability } from "../centre/history";
import { buildReport, createSchedule, getReport, listReports, listSchedules, requireSchedule, saveReport } from "../centre/reports";
import { createRule, listMatches, listRules, requireRule, updateRule } from "../centre/rules";
import { loadCentreSettings } from "../centre/store";
import { listWallboards } from "../centre/wallboard";
import { requireWatch } from "../centre/watch";
import { HttpError } from "../portal/http";
import { CENTRE_DISCLAIMER } from "./centre";
import { type ToolContext, type ToolDef, bounded, id, limit, portalUrl, requestId, tool } from "./shared";

const PERMISSION = "centre.use" as const;
const recordId = id("icr", "Intelligence Centre record");
const watchId = id("icw", "watch area");
const ruleId = id("icu", "monitoring rule");
const reportId = id("icp", "situation report");
const iso = z.iso.datetime({ offset: true });

const attribution = (ids: (string | null)[]) =>
    [...new Set(ids.filter((x): x is string => !!x))].map((s) => sourceById(s)?.attribution).filter((a): a is string => !!a);
const respond = (data: Record<string, unknown>, sourceIds: (string | null)[] = []) => ({
    data: { ...data, attribution: attribution(sourceIds), disclaimer: CENTRE_DISCLAIMER },
});
const recordLink = (ctx: ToolContext, recordIdValue: string | null) =>
    recordIdValue ? portalUrl(ctx, `/portal/intelligence-centre/records/${recordIdValue}`) : null;

// --- Reads -----------------------------------------------------------------------------------------------

const searchChanges = tool({
    name: "centre_search_changes",
    write: false,
    permission: PERMISSION,
    input: z
        .object({
            hours: z.number().int().min(1).max(744).default(24),
            hazard: z.enum(HAZARD_CATEGORIES).optional(),
            region: z.enum(REGION_IDS).optional(),
            watchId: watchId.optional(),
            minLevel: z.number().int().min(0).max(3).optional(),
            sourceId: z
                .string()
                .regex(/^[a-z0-9-]{3,40}$/)
                .optional(),
            changeType: z.enum(FEED_CHANGE_GROUPS.map((g) => g.id) as [string, ...string[]]).optional(),
            significantOnly: z.boolean().default(true),
            limit: limit(30, 200),
        })
        .strict(),
    run: async (ctx, input) => {
        const now = Date.now();
        const feed = await changeFeed(
            ctx.env,
            {
                hazard: input.hazard ?? null,
                region: input.region ?? null,
                watch: input.watchId ?? null,
                watchArea: input.watchId ? await requireWatch(ctx.db, ctx.user.email, input.watchId) : null,
                from: new Date(now - input.hours * 3_600_000).toISOString(),
                to: new Date(now).toISOString(),
                minLevel: input.minLevel ?? 0,
                source: input.sourceId ?? null,
                group: input.changeType ?? null,
                significance: input.significantOnly ? "significant" : "all",
            },
            input.limit,
        );
        return respond(
            {
                changes: feed.changes.map((c) => ({
                    id: c.id,
                    label: c.label,
                    kind: c.kind,
                    significant: c.significant,
                    at: c.at,
                    summary: c.summary,
                    from: c.fromValue,
                    to: c.toValue,
                    provider: c.provider,
                    category: c.category,
                    levelNow: c.level,
                    officialSource: c.sourceUrl,
                    ...(c.recordId ? { recordId: c.recordId, url: recordLink(ctx, c.recordId) } : {}),
                })),
                counts: feed.counts,
                truncated: feed.truncated,
                note: "Changes are detected by comparing collections, at collection time. 'No longer in the feed' never means resolved. Significant and routine are the Centre's own classification.",
            },
            feed.changes.map((c) => c.sourceId),
        );
    },
});

const timeline = tool({
    name: "centre_get_timeline",
    write: false,
    permission: PERMISSION,
    input: z.object({ recordId, limit: limit(60, 300) }).strict(),
    run: async (ctx, input) => {
        const t = await recordTimeline(ctx.env, input.recordId);
        if (!t) throw new HttpError(404, "not_found", "Not found");
        const cut = bounded(t.events.slice().reverse(), input.limit);
        return respond(
            {
                record: { id: t.recordId, title: t.title, url: recordLink(ctx, t.recordId) },
                events: cut.items.reverse().map((e) => ({
                    at: e.at,
                    nature: e.nature,
                    label: e.label,
                    detail: e.detail,
                    collectedAt: e.collectedAt,
                    officialSource: e.sourceUrl,
                    ...(e.recordId && e.recordId !== t.recordId ? { relatedRecordId: e.recordId } : {}),
                })),
                count: cut.count,
                truncated: cut.truncated,
                historyBeginsAtBaseline: t.startsAtBaseline,
                versionedFrom: t.historyFrom,
                notes: t.notes,
                note: "official: the provider published it (its own time, plus when the Centre collected it); observed: a measurement or detection; derived: worked out by the Centre, not official; collection: about the Centre's own collecting.",
            },
            t.events.map((e) => e.sourceId),
        );
    },
});

const replay = tool({
    name: "centre_get_replay_metadata",
    write: false,
    permission: PERMISSION,
    input: z
        .object({
            from: iso.optional(),
            to: iso.optional(),
            at: iso.optional().describe("Optionally, a moment to summarise: the records the Centre had stored then."),
            region: z.enum(REGION_IDS).optional(),
            limit: limit(30, 100),
        })
        .strict(),
    run: async (ctx, input) => {
        const to = input.to ? new Date(input.to) : new Date();
        const from = input.from ? new Date(input.from) : new Date(to.getTime() - 86_400_000);
        if (to.getTime() - from.getTime() > 31 * 86_400_000 || to <= from) throw new HttpError(422, "validation", "Choose up to 31 days");
        const meta = await replayMeta(ctx.env, from, to);
        let moment: Record<string, unknown> | undefined;
        if (input.at) {
            if (Date.parse(input.at) > Date.now()) throw new HttpError(422, "validation", "Replay can't show the future");
            const region = input.region && input.region !== "nsw" && input.region !== "australia" ? regionById(input.region)!.bbox : null;
            const frame = await replayFrame(ctx.env, new Date(input.at), { bbox: region, map: false, limit: 500 });
            const cut = bounded(frame.records, input.limit);
            moment = {
                at: frame.at,
                records: cut.items.map((r) => ({
                    id: r.id,
                    title: r.title,
                    provider: r.provider,
                    kind: r.kind,
                    category: r.category,
                    warningLevel: r.warningLevel,
                    status: r.status,
                    storedFrom: r.validFrom,
                    baseline: r.baseline,
                    url: recordLink(ctx, r.id),
                })),
                count: cut.count,
                truncated: cut.truncated || frame.truncated,
                sources: frame.sources.map((s) => ({ sourceId: s.sourceId, dataset: s.dataset, state: s.state, lastSuccessBefore: s.lastSuccessBefore })),
                notes: frame.notes,
            };
        }
        return respond({
            historyStartedAt: meta.historyStartedAt,
            oldestRetained: meta.oldestRetained,
            recording: meta.recording,
            retentionDays: meta.retentionDays,
            steps: meta.steps.slice(-100),
            stepsTruncated: meta.truncated || meta.steps.length > 100,
            collectionGaps: meta.gaps.slice(0, 50),
            ...(moment ? { moment } : {}),
            note: "Replay shows only what was stored at each moment, never what was learnt later. Nothing before historyStartedAt can be replayed.",
        });
    },
});

const trends = tool({
    name: "centre_get_trends",
    write: false,
    permission: PERMISSION,
    input: z.object({ days: z.union([z.literal(7), z.literal(30), z.literal(90)]).default(30) }).strict(),
    run: async (ctx, input) => {
        const a = await centreAnalytics(ctx.env, input.days);
        const total = (points: { value: number }[]) => points.reduce((n, p) => n + p.value, 0);
        return respond({
            range: a.range,
            newRecordsByCategory: a.newRecords.map((s) => ({ category: s.key, label: s.label, total: total(s.points), perDay: s.points })),
            escalations: total(a.transitions.find((t) => t.key === "escalated")?.points ?? []),
            downgrades: total(a.transitions.find((t) => t.key === "downgraded")?.points ?? []),
            significantChangesPerDay: a.significantChanges.points,
            byRegion: a.byRegion,
            byEventType: a.byEventType,
            weatherDailyMaxima: a.weather.map((s) => ({ metric: s.key, label: s.label, perDay: s.points })),
            coverage: a.coverage,
            caveats: a.caveats,
            note: "Counts of what the Centre collected, not complete or official statistics. No forecasts or risk scores.",
        });
    },
});

const ruleOut = (r: Awaited<ReturnType<typeof requireRule>>) => ({
    id: r.id,
    name: r.name,
    condition: r.definition.condition,
    conditionLabel: CONDITION_META[r.definition.condition].label,
    threshold:
        CONDITION_META[r.definition.condition].threshold === "own"
            ? "The person's own threshold, not an official one"
            : CONDITION_META[r.definition.condition].threshold,
    definition: r.definition,
    lookbackMinutes: r.lookbackMinutes,
    cooldownMinutes: r.cooldownMinutes,
    notify: r.notify,
    enabled: r.enabled,
    version: r.version,
    lastEvaluatedAt: r.lastEvaluatedAt,
    lastMatchedAt: r.lastMatchedAt,
    matchesLast7Days: r.matches7d,
});

const rules = tool({
    name: "centre_list_rules",
    write: false,
    permission: PERMISSION,
    input: z.object({}).strict(),
    run: async (ctx) => {
        const list = await listRules(ctx.db, ctx.user.email);
        return respond({
            rules: list.map(ruleOut),
            count: list.length,
            note: "The person's own monitoring rules. Areas are referred to by watch area id (centre_list_watch_areas), never by location. Rules are evaluated deterministically after each collection when the owner has switched monitoring rules on.",
        });
    },
});

const matches = tool({
    name: "centre_list_rule_matches",
    write: false,
    permission: PERMISSION,
    input: z.object({ ruleId: ruleId.optional(), openOnly: z.boolean().default(false), limit: limit(30, 200) }).strict(),
    run: async (ctx, input) => {
        if (input.ruleId) await requireRule(ctx.db, ctx.user.email, input.ruleId);
        const list = await listMatches(ctx.db, ctx.user.email, { ruleId: input.ruleId, open: input.openOnly, limit: input.limit });
        return respond(
            {
                matches: list.map((m) => ({
                    id: m.id,
                    ruleId: m.ruleId,
                    rule: m.ruleName,
                    at: m.at,
                    reason: m.reason,
                    observedValue: m.observedValue,
                    threshold: m.threshold,
                    unit: m.unit,
                    evidenceAt: m.evidenceAt,
                    notified: m.notified,
                    suppressed: m.suppressed,
                    acknowledged: !!m.acknowledgedAt,
                    ...(m.recordId ? { recordId: m.recordId, url: recordLink(ctx, m.recordId) } : {}),
                })),
                count: list.length,
                note: "Why each rule matched, recorded when it was evaluated. A rule match isn't an official warning.",
            },
            list.map((m) => m.sourceId),
        );
    },
});

const reportOut = (ctx: ToolContext, report: Awaited<ReturnType<typeof buildReport>>) => ({
    id: report.id,
    title: report.title,
    scope: report.scopeLabel,
    at: report.at,
    periodFrom: report.periodFrom,
    generatedAt: report.generatedAt,
    historical: report.historical,
    sections: report.sections.map((s) => ({
        title: s.title,
        facts: s.facts.map((f) => ({ ref: f.ref, nature: f.nature, text: f.text, at: f.at, ...(f.url ? { url: portalUrl(ctx, f.url) } : {}) })),
        ...(s.empty ? { emptyBecause: s.empty } : {}),
    })),
    sources: report.sources.map((s) => ({ sourceId: s.sourceId, dataset: `${s.provider}: ${s.dataset}`, status: s.status, lastRetrieved: s.lastSuccessAt })),
    limitations: report.limitations,
    ...(report.narrative.items.length ? { narrative: { label: "AI interpretation of the facts above, not facts", items: report.narrative.items } } : {}),
    ...(report.id ? { url: portalUrl(ctx, `/portal/intelligence-centre/reports/${report.id}`) } : {}),
});

const reportInput = {
    scope: reportScopeSchema,
    at: iso.optional().describe("A past moment to report as the Centre knew it then; omit for now."),
    periodHours: z.number().int().min(1).max(744).default(24),
};

const generate = tool({
    name: "centre_generate_report",
    write: false,
    permission: PERMISSION,
    input: z.object(reportInput).strict(),
    run: async (ctx, input) => {
        if (input.scope.kind === "watch") await requireWatch(ctx.db, ctx.user.email, input.scope.watchId);
        // Deterministic: never runs a model, and isn't saved (centre_save_report does that).
        const report = await buildReport(ctx.env, ctx.user, { scope: input.scope, at: input.at ?? null, periodHours: input.periodHours, narrative: false });
        return respond(
            { report: reportOut(ctx, report), saved: false },
            report.sources.map((s) => s.sourceId),
        );
    },
});

const listReportsTool = tool({
    name: "centre_list_reports",
    write: false,
    permission: PERMISSION,
    input: z.object({ limit: limit(20, 100) }).strict(),
    run: async (ctx, input) => {
        const [reports, schedules] = await Promise.all([listReports(ctx.db, ctx.user.email, input.limit), listSchedules(ctx.db, ctx.user.email)]);
        return respond({
            reports: reports.map((r) => ({
                id: r.id,
                title: r.title,
                scope: r.scope.kind,
                generatedAt: r.generatedAt,
                periodTo: r.periodTo,
                facts: r.facts,
                trigger: r.trigger,
                url: portalUrl(ctx, `/portal/intelligence-centre/reports/${r.id}`),
            })),
            schedules: schedules.map((s) => ({
                id: s.id,
                name: s.name,
                frequency: s.frequency,
                hour: s.hour,
                weekday: s.weekday,
                enabled: s.enabled,
                nextRunAt: s.nextRunAt,
            })),
        });
    },
});

const getReportTool = tool({
    name: "centre_get_report",
    write: false,
    permission: PERMISSION,
    input: z.object({ reportId }).strict(),
    run: async (ctx, input) => {
        const { report } = await getReport(ctx.env, ctx.user.email, input.reportId);
        return respond(
            { report: reportOut(ctx, report) },
            report.sources.map((s) => s.sourceId),
        );
    },
});

const correlationsTool = tool({
    name: "centre_list_correlations",
    write: false,
    permission: PERMISSION,
    input: z
        .object({
            recordId: recordId.optional(),
            region: z.enum(REGION_IDS).optional(),
            basis: z.enum(["explicit", "derived"]).optional(),
            limit: limit(20, 100),
        })
        .strict(),
    run: async (ctx, input) => {
        const { settings } = await loadCentreSettings(ctx.db);
        const bbox = input.region && input.region !== "nsw" && input.region !== "australia" ? regionById(input.region)!.bbox : null;
        const found = (await correlations(ctx.db, settings, { bbox, recordId: input.recordId })).filter((c) => !input.basis || c.basis === input.basis);
        const cut = bounded(found, input.limit);
        return respond(
            {
                correlations: cut.items.map((c) => ({
                    rule: c.rule,
                    basis: c.basis,
                    label:
                        c.basis === "explicit" ? "Linked by the provider itself" : "May be related (derived by rule; not official and not evidence of cause)",
                    title: c.title,
                    explanation: c.explanation,
                    confidence: c.confidence,
                    factors: c.factors,
                    limitations: c.limitations,
                    records: c.records.map((r) => ({
                        id: r.recordId,
                        title: r.title,
                        provider: r.provider,
                        at: r.at,
                        distanceKm: r.distanceKm,
                        officialSource: r.sourceUrl,
                    })),
                })),
                count: cut.count,
                truncated: cut.truncated,
            },
            [],
        );
    },
});

const reliability = tool({
    name: "centre_get_source_reliability",
    write: false,
    permission: PERMISSION,
    input: z
        .object({
            sourceId: z
                .string()
                .regex(/^[a-z0-9-]{3,40}$/)
                .optional(),
            days: z.number().int().min(1).max(400).default(30),
        })
        .strict(),
    run: async (ctx, input) => {
        const list = (await sourceReliability(ctx.db, input.days)).filter((r) => !input.sourceId || r.sourceId === input.sourceId);
        if (input.sourceId && !list.length) throw new HttpError(404, "not_found", "Not found");
        return respond({
            sources: list.map((r) => ({
                sourceId: r.sourceId,
                dataset: `${r.provider}: ${r.dataset}`,
                availabilityPercent: r.availability,
                averageRetrievalMs: r.avgMs,
                averagePublicationToCollectionSeconds: r.avgDelayS,
                maxPublicationToCollectionSeconds: r.maxDelayS,
                consecutiveFailures: r.consecutiveFailures,
                lastValidatedAt: r.lastValidatedAt,
                longestGapMinutes: r.longestGapMinutes,
                ...(input.sourceId ? { perDay: r.days } : {}),
            })),
            note: "Availability is the share of collection attempts that succeeded, from the Centre's own daily records.",
        });
    },
});

const wallboards = tool({
    name: "centre_list_wallboards",
    write: false,
    permission: PERMISSION,
    input: z.object({}).strict(),
    run: async (ctx) => {
        const boards = await listWallboards(ctx.db, ctx.user.email);
        // Configuration summaries only: no display credentials (or their hashes) and no locations.
        return respond({
            wallboards: boards.map((b) => ({
                id: b.id,
                name: b.name,
                area: b.watchId ? { watchId: b.watchId } : "NSW",
                theme: b.theme,
                rotates: b.rotate && b.views.length > 1,
                rotationSeconds: b.rotationSeconds,
                refreshSeconds: b.refreshSeconds,
                views: b.views.map((v) => ({
                    name: v.name,
                    preset: PRESET_LABELS[v.preset],
                    customised: v.customised,
                    widgets: v.widgets.map((w) => WIDGET_META[w.type].label),
                })),
                activeScreens: b.tokens.filter((t) => !t.revokedAt && (!t.expiresAt || Date.parse(t.expiresAt) > Date.now())).length,
                url: portalUrl(ctx, `/portal/intelligence-centre/wallboards/${b.id}`),
            })),
            count: boards.length,
            note: "Screens are managed in the portal; display addresses are never available through MCP.",
        });
    },
});

// --- Writes ------------------------------------------------------------------------------------------------

const ruleFields = {
    name: z.string().trim().min(1).max(80),
    definition: ruleDefinitionSchema,
    lookbackMinutes: z.number().int().min(15).max(10080).optional(),
    cooldownMinutes: z.number().int().min(0).max(10080).optional(),
    notify: z.enum(["none", "in_app", "email"]).optional(),
    enabled: z.boolean().optional(),
};

const createRuleTool = tool({
    name: "centre_create_rule",
    write: true,
    permission: PERMISSION,
    input: z.object({ ...ruleFields, requestId }).strict(),
    run: async (ctx, input) => {
        const { requestId: _r, ...fields } = input;
        const rule = await createRule(ctx.db, ctx.user, fields, "mcp");
        return { data: { rule: ruleOut(rule), disclaimer: CENTRE_DISCLAIMER }, outcome: { entityType: "centre_rule", entityId: rule.id } };
    },
    replay: async (ctx, outcome) => ({ data: { rule: ruleOut(await requireRule(ctx.db, ctx.user.email, outcome.entityId)), replayed: true } }),
});

const updateRuleTool = tool({
    name: "centre_update_rule",
    write: true,
    permission: PERMISSION,
    input: z
        .object({
            ruleId,
            version: z.number().int().min(1),
            name: ruleFields.name.optional(),
            definition: ruleDefinitionSchema.optional(),
            lookbackMinutes: ruleFields.lookbackMinutes,
            cooldownMinutes: ruleFields.cooldownMinutes,
            notify: ruleFields.notify,
            enabled: ruleFields.enabled,
            requestId,
        })
        .strict(),
    run: async (ctx, input) => {
        const { ruleId: target, requestId: _r, version, ...changes } = input;
        const current = await requireRule(ctx.db, ctx.user.email, target);
        // Fields not sent keep their current values.
        const merged = {
            name: changes.name ?? current.name,
            definition: changes.definition ?? current.definition,
            lookbackMinutes: changes.lookbackMinutes ?? current.lookbackMinutes,
            cooldownMinutes: changes.cooldownMinutes ?? current.cooldownMinutes,
            notify: changes.notify ?? current.notify,
            enabled: changes.enabled ?? current.enabled,
        };
        const rule = await updateRule(ctx.db, ctx.user, target, { ...merged, version }, "mcp");
        return { data: { rule: ruleOut(rule) }, outcome: { entityType: "centre_rule", entityId: rule.id } };
    },
    replay: async (ctx, outcome) => ({ data: { rule: ruleOut(await requireRule(ctx.db, ctx.user.email, outcome.entityId)), replayed: true } }),
});

const scheduleTool = tool({
    name: "centre_schedule_report",
    write: true,
    permission: PERMISSION,
    input: z
        .object({
            name: z.string().trim().min(1).max(80),
            scope: reportScopeSchema,
            frequency: z.enum(["daily", "weekly"]),
            weekday: z.number().int().min(0).max(6).nullable().optional(),
            hour: z.number().int().min(0).max(23),
            timeZone: z.string().max(60).optional(),
            periodHours: z.number().int().min(1).max(744).optional(),
            notify: z.enum(["none", "in_app", "email"]).optional(),
            requestId,
        })
        .strict(),
    run: async (ctx, input) => {
        const { requestId: _r, ...fields } = input;
        const schedule = await createSchedule(ctx.db, ctx.user, { ...fields, narrative: false, enabled: true }, "mcp");
        return {
            data: {
                schedule: {
                    id: schedule.id,
                    name: schedule.name,
                    frequency: schedule.frequency,
                    hour: schedule.hour,
                    weekday: schedule.weekday,
                    nextRunAt: schedule.nextRunAt,
                },
                note: "Scheduled reports run only when the owner has switched scheduled reports on. A report isn't made again when its facts haven't changed.",
            },
            outcome: { entityType: "centre_report_schedule", entityId: schedule.id },
        };
    },
    replay: async (ctx, outcome) => {
        const s = await requireSchedule(ctx.db, ctx.user.email, outcome.entityId);
        return {
            data: { schedule: { id: s.id, name: s.name, frequency: s.frequency, hour: s.hour, weekday: s.weekday, nextRunAt: s.nextRunAt }, replayed: true },
        };
    },
});

const saveReportTool = tool({
    name: "centre_save_report",
    write: true,
    permission: PERMISSION,
    input: z.object({ ...reportInput, title: z.string().trim().min(1).max(160).optional(), requestId }).strict(),
    run: async (ctx, input) => {
        if (input.scope.kind === "watch") await requireWatch(ctx.db, ctx.user.email, input.scope.watchId);
        const report = await buildReport(ctx.env, ctx.user, {
            scope: input.scope,
            at: input.at ?? null,
            periodHours: input.periodHours,
            title: input.title,
            narrative: false,
        });
        const saved = await saveReport(ctx.env, ctx.user, report, { trigger: "mcp" });
        return {
            data: { report: reportOut(ctx, saved.report), saved: true, disclaimer: CENTRE_DISCLAIMER },
            outcome: { entityType: "centre_report", entityId: saved.summary.id },
        };
    },
    replay: async (ctx, outcome) => {
        const { report } = await getReport(ctx.env, ctx.user.email, outcome.entityId);
        return { data: { report: reportOut(ctx, report), saved: true, replayed: true } };
    },
});

export const CENTRE_HISTORY_TOOLS: ToolDef[] = [
    searchChanges,
    timeline,
    replay,
    trends,
    rules,
    matches,
    generate,
    listReportsTool,
    getReportTool,
    correlationsTool,
    reliability,
    wallboards,
    createRuleTool,
    updateRuleTool,
    scheduleTool,
    saveReportTool,
];
