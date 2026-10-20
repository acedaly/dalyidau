// Situation reports (docs/INTELLIGENCE_CENTRE_9_1.md#situation-reports).
//
// Deterministic first: every fact is one sentence built from stored records, labelled official,
// observed, derived or collection, with its own time and a link. A report for a past moment reads
// replay's versions (what the Centre knew then), never today's records. An optional narrative
// goes through Daly Intelligence (switches, budgets, circuit breaker), sees only the fact
// sentences, fenced, and is grounded like briefings: a sentence citing no fact, or a number or
// level its facts don't contain, is dropped. Reports are stored in R2 (private/centre/reports/),
// listed from D1, and owned by the person who made them.
import type { D1Database } from "@cloudflare/workers-types";
import { addDays, isoWeekday, localDate, zonedInstant } from "../../src/shared/calendar/time";
import { regionById } from "../../src/shared/centre/regions";
import type {
    ReportFact,
    ReportRequest,
    ReportSchedule,
    ReportScope,
    ReportSection,
    ReportSectionKey,
    ReportSummary,
    ScheduleInput,
    SituationReport,
} from "../../src/shared/centre/reports";
import { MAX_SCHEDULES, REPORT_SECTIONS, reportRequestSchema, reportScopeSchema, scheduleInputSchema } from "../../src/shared/centre/reports";
import { CATEGORY_LABELS } from "../../src/shared/centre/sources";
import type { CentreRecord, Correlation, WatchArea } from "../../src/shared/centre/types";
import { FIRE_DANGER_RATINGS, fireDangerRank } from "../../src/shared/centre/types";
import { paragraphsFromText } from "../../src/shared/knowledge/content";
import type { PortalUser } from "../../src/shared/portal/types";
import type { Env } from "../env";
import { fence } from "../intelligence/prompts";
import { generateJson } from "../intelligence/provider";
import { availability, loadConfig } from "../intelligence/settings";
import { BudgetExceeded } from "../intelligence/usage";
import { addRelation, createObject } from "../knowledge/objects";
import { can, userForEmail } from "../portal/auth";
import { auditStatement, newId, nowIso, parseJson } from "../portal/db";
import { HttpError } from "../portal/http";
import { writableSpace } from "./actions";
import { sha256Hex } from "./adapters/types";
import { CENTRE_BRIEFING_SYSTEM, groundInterpretation, interpretationSchema } from "./briefing";
import { correlations } from "./correlate";
import { type BBox, distanceKm } from "./geo";
import { changeFeed, replayFrame } from "./history";
import { listRecords, loadCentreSettings, loadPreferences, sourceHealth } from "./store";
import { recordsForWatch, requireWatch, watchBBox } from "./watch";

const REPORT_PREFIX = "private/centre/reports/";
const RECORD_PATH = "/portal/intelligence-centre/records/";
/** A report "at" a time within this of now is a current report. */
const CURRENT_MS = 30 * 60_000;

const when = (iso: string | null) =>
    iso
        ? new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Sydney", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(
              new Date(iso),
          )
        : "time not given";

// --- Scope ----------------------------------------------------------------------------------------------

interface ResolvedScope {
    label: string;
    watch: WatchArea | null;
    bbox: BBox | null;
    category: CentreRecord["category"] | null;
    recordId: string | null;
}

async function resolveScope(db: D1Database, user: PortalUser, scope: ReportScope): Promise<ResolvedScope> {
    switch (scope.kind) {
        case "nsw":
            return { label: "New South Wales", watch: null, bbox: null, category: null, recordId: null };
        case "watch": {
            const watch = await requireWatch(db, user.email, scope.watchId);
            return { label: watch.name, watch, bbox: watchBBox(watch.definition), category: null, recordId: null };
        }
        case "region": {
            const region = regionById(scope.region)!;
            return {
                label: region.label,
                watch: null,
                bbox: scope.region === "nsw" || scope.region === "australia" ? null : region.bbox,
                category: null,
                recordId: null,
            };
        }
        case "hazard": {
            const region = regionById(scope.region)!;
            return {
                label: `${CATEGORY_LABELS[scope.category]}, ${region.label}`,
                watch: null,
                bbox: scope.region === "nsw" || scope.region === "australia" ? null : region.bbox,
                category: scope.category,
                recordId: null,
            };
        }
        case "incident": {
            const row = await db.prepare("SELECT title FROM ic_records WHERE id = ?").bind(scope.recordId).first<{ title: string }>();
            const version = row
                ? null
                : await db
                      .prepare("SELECT title FROM ic_record_versions WHERE record_id = ? ORDER BY seq DESC LIMIT 1")
                      .bind(scope.recordId)
                      .first<{ title: string }>();
            if (!row && !version) throw new HttpError(404, "not_found", "Not found");
            return { label: (row ?? version)!.title, watch: null, bbox: null, category: null, recordId: scope.recordId };
        }
    }
}

/** The records a report covers: current ones, or (for a past moment) the versions stored then. */
async function scopeRecords(env: Env, scope: ResolvedScope, at: Date, historical: boolean): Promise<{ records: CentreRecord[]; notes: string[] }> {
    const db = env.DB;
    const notes: string[] = [];
    let records: CentreRecord[];
    if (historical) {
        const frame = await replayFrame(env, at, { watch: scope.watch, bbox: scope.bbox, map: false, limit: 3000 });
        notes.push(...frame.notes);
        records = frame.records.map((r) => ({
            ...r,
            externalId: "",
            eventType: null,
            description: null,
            bbox: null,
            hasGeometry: false,
            geometryQuality: "point",
            uncertaintyM: null,
            firstSeenAt: r.validFrom,
            lastSeenAt: r.validFrom,
            missingSince: null,
        }));
    } else if (scope.watch) records = (await recordsForWatch(db, scope.watch, 1000)).map((m) => m.record);
    else records = (await listRecords(db, scope.bbox ? { bbox: scope.bbox } : {}, 3000)).records;
    if (scope.category) records = records.filter((r) => r.category === scope.category || (scope.category === "flood" && r.category === "water"));
    if (scope.recordId) {
        const anchor = records.find((r) => r.id === scope.recordId);
        if (anchor?.lat !== null && anchor?.lat !== undefined && anchor.lon !== null) {
            const p: [number, number] = [anchor.lon, anchor.lat];
            records = records.filter(
                (r) => r.id === anchor.id || (r.lat !== null && r.lon !== null && distanceKm(p, [r.lon, r.lat]) <= 30) || r.kind === "rating",
            );
            notes.push("An incident report covers the incident and records within 30 km of it.");
        } else records = anchor ? [anchor] : [];
    }
    return { records, notes };
}

// --- Building ----------------------------------------------------------------------------------------------

export async function buildReport(env: Env, user: PortalUser, request: ReportRequest, now = new Date()): Promise<SituationReport> {
    const db = env.DB;
    const at = request.at ? new Date(request.at) : now;
    if (at.getTime() > now.getTime() + 60_000) throw new HttpError(422, "validation", "A report can't describe the future");
    const historical = now.getTime() - at.getTime() > CURRENT_MS;
    const periodFrom = new Date(at.getTime() - request.periodHours * 3_600_000).toISOString();
    const scope = await resolveScope(db, user, request.scope);
    const { records, notes } = await scopeRecords(env, scope, at, historical);
    const health = await sourceHealth(env);
    const { settings } = await loadCentreSettings(db);
    let n = 0;
    const fact = (
        text: string,
        nature: ReportFact["nature"],
        r?: Pick<CentreRecord, "id" | "sourceId" | "updatedAt" | "publishedAt" | "observedAt"> | null,
        time?: string | null,
    ): ReportFact => ({
        ref: `F${++n}`,
        text,
        nature,
        recordId: r?.id ?? null,
        sourceId: r?.sourceId ?? null,
        at: time ?? r?.updatedAt ?? r?.publishedAt ?? r?.observedAt ?? null,
        url: r ? `${RECORD_PATH}${r.id}` : null,
    });
    const sections = new Map<ReportSectionKey, { facts: ReportFact[]; empty: string | null }>();
    const put = (key: ReportSectionKey, facts: ReportFact[], empty: string | null = null) => sections.set(key, { facts, empty: facts.length ? null : empty });

    const warnings = records.filter((r) => r.kind === "warning").sort((a, b) => b.severityRank - a.severityRank);
    const incidents = records.filter((r) => r.kind === "incident" || r.kind === "event").sort((a, b) => b.severityRank - a.severityRank);
    const ratings = records.filter((r) => r.kind === "rating");
    const roads = records.filter((r) => r.category === "transport");
    const outages = records.filter((r) => r.category === "power");
    const stations = records.filter((r) => r.sourceId === "bom-observations");
    const gauges = records.filter((r) => r.sourceId === "bom-water");
    const inactive = health.filter((h) => h.source.implemented && !h.source.informational && h.status !== "active");

    // 2. Official warnings.
    put(
        "warnings",
        warnings
            .slice(0, 10)
            .map((w) =>
                fact(`${w.provider}: ${w.title}${w.warningLevel ? ` (${w.warningLevel}, as published)` : ""}. Issued ${when(w.publishedAt)}.`, "official", w),
            ),
        "No official warnings in the sources collected for this scope. That isn't confirmation that none are in force: check official channels.",
    );

    // 3. Current incidents.
    const levelled = incidents.filter((i) => i.severityRank >= 1);
    put(
        "incidents",
        [
            ...(incidents.length
                ? [
                      fact(
                          `${incidents.length} ${incidents.length === 1 ? "incident is" : "incidents are"} listed by the emergency services sources collected for this scope.`,
                          "official",
                          null,
                          at.toISOString(),
                      ),
                  ]
                : []),
            ...(levelled.length ? levelled : incidents)
                .slice(0, 8)
                .map((i) =>
                    fact(
                        `${i.title}${i.warningLevel ? `: ${i.warningLevel}` : ""}${i.status ? `, ${i.status}` : ""}${i.areaName ? `, ${i.areaName}` : ""} (${i.provider}). Updated ${when(i.updatedAt ?? i.publishedAt)}.`,
                        "official",
                        i,
                    ),
                ),
        ],
        "No incidents in the sources collected for this scope.",
    );

    // 4. Significant changes in the period.
    const feed = await changeFeed(
        env,
        {
            hazard: scope.category,
            region: request.scope.kind === "region" || request.scope.kind === "hazard" ? request.scope.region : null,
            watch: null,
            watchArea: scope.watch,
            from: periodFrom,
            to: at.toISOString(),
            minLevel: 0,
            source: null,
            group: null,
            significance: "significant",
        },
        200,
    );
    const changes = scope.recordId ? feed.changes.filter((c) => !c.recordId || records.some((r) => r.id === c.recordId)) : feed.changes;
    put(
        "changes",
        [
            ...(changes.length
                ? [
                      fact(
                          `${changes.length} significant ${changes.length === 1 ? "change was" : "changes were"} detected between ${when(periodFrom)} and ${when(at.toISOString())}.`,
                          "derived",
                          null,
                          at.toISOString(),
                      ),
                  ]
                : []),
            ...changes.slice(0, 10).map((c) => ({
                ...fact(`${c.label}: ${c.summary} (detected ${when(c.at)}).`, "derived", null, c.at),
                recordId: c.recordId,
                sourceId: c.sourceId,
                url: c.recordId ? `${RECORD_PATH}${c.recordId}` : null,
            })),
        ],
        `No significant changes were detected in the ${request.periodHours} hours before this time.`,
    );

    // 5. Fire danger.
    if (ratings.length) {
        const top = (key: "today" | "tomorrow") => Math.max(0, ...ratings.map((r) => fireDangerRank(r.attributes[key])));
        const bans = ratings.filter((r) => r.attributes.banToday === "yes");
        const published = ratings[0].publishedAt ?? ratings[0].updatedAt;
        put("fire_danger", [
            fact(
                `Highest Fire Danger Rating today: ${FIRE_DANGER_RATINGS[top("today")]}; tomorrow: ${FIRE_DANGER_RATINGS[top("tomorrow")]} (NSW RFS).`,
                "official",
                null,
                published,
            ),
            fact(
                bans.length ? `Total Fire Ban today in: ${bans.map((b) => b.title).join(", ")}.` : "No Total Fire Ban is listed for today.",
                "official",
                null,
                published,
            ),
            ...ratings
                .filter((r) => fireDangerRank(r.attributes.today) >= 2)
                .slice(0, 6)
                .map((r) => fact(`${r.title}: ${r.attributes.today} today, ${r.attributes.tomorrow} tomorrow.`, "official", r)),
        ]);
        if (scope.bbox && !scope.watch)
            notes.push("Fire danger districts have no published boundaries, so a region's report lists the ratings for every district.");
    } else put("fire_danger", [], "Fire danger isn't being collected, or no rating was stored for this scope.");

    // 6. Weather and environmental observations (current readings, or the highest in the period for a past moment).
    const weather: ReportFact[] = [];
    if (historical) {
        const ids = (await stationIdsIn(db, scope.bbox)).slice(0, 90);
        if (ids.length) {
            const peaks = await db
                .prepare(
                    `SELECT s.record_id, r.title, s.metric, MAX(s.value) AS value, s.at FROM ic_series s JOIN ic_records r ON r.id = s.record_id
                     WHERE s.record_id IN (${ids.map(() => "?").join(",")}) AND s.metric IN ('air_temperature', 'gust_kmh', 'rainfall') AND s.at BETWEEN ? AND ? GROUP BY s.metric`,
                )
                .bind(...ids, periodFrom, at.toISOString())
                .all<{ record_id: string; title: string; metric: string; value: number; at: string }>();
            const label: Record<string, string> = { air_temperature: "Highest temperature", gust_kmh: "Strongest gust", rainfall: "Most rain since 9 am" };
            const unit: Record<string, string> = { air_temperature: " °C", gust_kmh: " km/h", rainfall: " mm" };
            for (const p of peaks.results)
                weather.push(
                    fact(
                        `${label[p.metric]}: ${p.value}${unit[p.metric]} at ${p.title} (observed ${when(p.at)}).`,
                        "observed",
                        { id: p.record_id, sourceId: "bom-observations", updatedAt: null, publishedAt: null, observedAt: p.at },
                        p.at,
                    ),
                );
        }
    } else {
        const extreme = (key: string, label: string, unit: string) => {
            const best = stations
                .map((s) => ({ s, v: s.metrics.find((m) => m.key === key)?.value }))
                .filter((x): x is { s: CentreRecord; v: number } => typeof x.v === "number")
                .sort((a, b) => b.v - a.v)[0];
            return best
                ? fact(`${label}: ${best.v}${unit} at ${best.s.title} (observed ${when(best.s.observedAt)}).`, "observed", best.s, best.s.observedAt)
                : null;
        };
        for (const f of [
            extreme("air_temperature", "Highest temperature", " °C"),
            extreme("gust_kmh", "Strongest gust", " km/h"),
            extreme("rainfall", "Most rain since 9 am", " mm"),
        ])
            if (f) weather.push(f);
        const air = records.filter((r) => r.category === "air").sort((a, b) => b.severityRank - a.severityRank)[0];
        if (air?.status)
            weather.push(
                fact(
                    `Poorest air quality category reported: ${air.status} at ${air.title} (NSW Government category, observed ${when(air.observedAt)}).`,
                    "observed",
                    air,
                    air.observedAt,
                ),
            );
    }
    put(
        "weather",
        weather,
        historical
            ? "No weather readings are stored for this period (measurements are kept for the retention period)."
            : "No weather observations in this scope.",
    );

    // 7. Flood and water.
    const floodWarnings = warnings.filter((w) => w.category === "flood");
    const rises = changes.filter((c) => c.kind === "measurement_change");
    put(
        "water",
        [
            ...floodWarnings.slice(0, 5).map((w) => fact(`Flood warning: ${w.title} (${w.provider}, issued ${when(w.publishedAt)}).`, "official", w)),
            ...rises
                .slice(0, 5)
                .map((c) => ({ ...fact(c.summary, "observed", null, c.at), recordId: c.recordId, url: c.recordId ? `${RECORD_PATH}${c.recordId}` : null })),
            ...gauges
                .slice(0, 5)
                .map((g) => {
                    const level = g.metrics.find((m) => m.key === "water_level");
                    return level ? fact(`${g.title}: ${level.value} m (observed ${when(g.observedAt)}).`, "observed", g, g.observedAt) : null;
                })
                .filter((f): f is ReportFact => !!f),
        ],
        "No flood warnings, river rises or followed gauges in this scope. NSW SES flood warnings aren't collected (permission is needed).",
    );

    // 8. Transport and infrastructure.
    const closures = roads.filter((r) => r.attributes.closure === "yes");
    const customers = outages.reduce((sum, o) => sum + (o.metrics.find((m) => m.key === "customers")?.value ?? 0), 0);
    const tfnsw = health.find((h) => h.source.id === "tfnsw-live-traffic");
    put(
        "transport",
        [
            ...(roads.length
                ? [
                      fact(
                          `${roads.length} road ${roads.length === 1 ? "hazard" : "hazards"} listed by Live Traffic NSW, ${closures.length} of them closures.`,
                          "official",
                          null,
                          at.toISOString(),
                      ),
                  ]
                : []),
            ...closures.slice(0, 6).map((r) => fact(`Closure: ${r.title} (published ${when(r.publishedAt)}).`, "official", r)),
            ...(outages.length
                ? [
                      fact(
                          `${outages.length} unplanned power ${outages.length === 1 ? "outage" : "outages"} listed, affecting ${customers} customers.`,
                          "official",
                          null,
                          at.toISOString(),
                      ),
                  ]
                : []),
        ],
        tfnsw && tfnsw.status !== "active"
            ? `Road disruptions aren't available: ${tfnsw.statusDetail} This is not the same as no disruptions.`
            : "No road hazards or power outages listed for this scope.",
    );

    // 9. Potential cross-source relationships (derived; computed from current records only).
    let related: Correlation[] = [];
    if (!historical) {
        related = await correlations(db, settings, { bbox: scope.bbox, now: at, recordId: scope.recordId ?? undefined });
        if (scope.watch) {
            const ids = new Set(records.map((r) => r.id));
            related = related.filter((c) => c.records.some((r) => ids.has(r.recordId)));
        }
    }
    put(
        "correlations",
        related.slice(0, 6).map((c) =>
            fact(
                `${c.title}. ${c.basis === "explicit" ? "Linked by the provider." : `May be related (${c.confidence} confidence; derived by rule, not official, not evidence of cause).`}`,
                "derived",
                null,
                c.records
                    .map((r) => r.at)
                    .filter((x): x is string => !!x)
                    .sort()
                    .pop() ?? at.toISOString(),
            ),
        ),
        historical
            ? "Correlations are worked out from current records, so they aren't available for a past moment."
            : "No possible relationships were found by the Centre's rules.",
    );

    // 10. Source health and information gaps.
    put(
        "gaps",
        inactive
            .slice(0, 12)
            .map((h) =>
                fact(`${h.source.provider}: ${h.source.dataset} is ${h.status.replace(/_/g, " ")}. ${h.statusDetail}`, "collection", null, h.lastSuccessAt),
            ),
        "Every source the Centre implements was active when this report was generated.",
    );

    // 11. Sources and collection times.
    const used = [...new Set(records.map((r) => r.sourceId))];
    const sources = health
        .filter((h) => h.source.implemented && (used.includes(h.source.id) || h.enabled))
        .map((h) => ({
            sourceId: h.source.id,
            provider: h.source.provider,
            dataset: h.source.dataset,
            status: h.status,
            lastSuccessAt: h.lastSuccessAt,
            attribution: h.source.attribution,
        }));
    put(
        "sources",
        sources.map((s) => fact(`${s.provider}: ${s.dataset}. Last retrieved ${when(s.lastSuccessAt)}.`, "collection", null, s.lastSuccessAt)),
        "No sources are switched on.",
    );

    // 1. Overview (derived from the sections above; written last, numbered first).
    const overview: ReportFact[] = [
        fact(
            `${warnings.length} official ${warnings.length === 1 ? "warning" : "warnings"}${warnings.some((w) => w.severityRank >= 1) ? ` (highest level: ${warnings[0].warningLevel ?? "no AWS level"})` : ""}, ${incidents.length} ${incidents.length === 1 ? "incident" : "incidents"} and ${roads.length + outages.length} disruptions in the sources collected for ${scope.label}${historical ? `, as stored at ${when(at.toISOString())}` : ""}.`,
            "derived",
            null,
            at.toISOString(),
        ),
    ];
    if (changes.length)
        overview.push(fact(`${changes.length} significant changes in the ${request.periodHours} hours before.`, "derived", null, at.toISOString()));
    if (inactive.length)
        overview.push(
            fact(
                `${inactive.length} ${inactive.length === 1 ? "source wasn't" : "sources weren't"} active, so parts of the picture are missing (see Source health).`,
                "derived",
                null,
                at.toISOString(),
            ),
        );
    put("overview", overview);

    // Renumber in reading order so F1 is the first fact a reader meets.
    let ref = 0;
    const renumber = new Map<string, string>();
    const ordered: ReportSection[] = REPORT_SECTIONS.map(({ key, title }) => {
        const s = sections.get(key) ?? { facts: [], empty: null };
        return {
            key,
            title,
            empty: s.empty,
            facts: s.facts.map((f) => {
                const next = `F${++ref}`;
                renumber.set(f.ref, next);
                return { ...f, ref: next };
            }),
        };
    });
    const limitations = [
        "Collected from public sources for awareness. Not an official warning service; it may be delayed or incomplete. Follow official warnings and directions; in an emergency call Triple Zero (000).",
        "Official facts keep the provider's own wording, levels and times. Derived facts (counts, changes, correlations) were worked out by the Centre and aren't official.",
        ...notes,
    ];
    const facts = ordered.flatMap((s) => s.facts);
    const fingerprint = await sha256Hex(JSON.stringify([request.scope, facts.map((f) => f.text)]));
    const title =
        request.title?.trim() ||
        `${historical ? "Situation report (historical)" : "Situation report"}: ${scope.label}, ${new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Sydney", dateStyle: "medium", timeStyle: "short" }).format(at)}`;
    const report: SituationReport = {
        id: null,
        title: title.slice(0, 160),
        scope: request.scope,
        scopeLabel: scope.label,
        at: at.toISOString(),
        periodFrom,
        generatedAt: now.toISOString(),
        historical,
        sections: ordered,
        sources,
        limitations,
        narrative: { status: "not_requested", items: [], model: null },
        fingerprint,
    };
    return request.narrative ? withNarrative(env, user, report) : report;
}

async function stationIdsIn(db: D1Database, bbox: BBox | null): Promise<string[]> {
    const rows = bbox
        ? await db
              .prepare("SELECT id FROM ic_records WHERE source_id = 'bom-observations' AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ? LIMIT 200")
              .bind(bbox[1], bbox[3], bbox[0], bbox[2])
              .all<{ id: string }>()
        : await db.prepare("SELECT id FROM ic_records WHERE source_id = 'bom-observations' LIMIT 400").all<{ id: string }>();
    return rows.results.map((r) => r.id);
}

/** A readable narrative of the facts, if Daly Intelligence is on; grounded and labelled as interpretation. */
async function withNarrative(env: Env, user: PortalUser, report: SituationReport): Promise<SituationReport> {
    const { config } = await loadConfig(env.DB);
    if (!availability(env, config).recommendations) return { ...report, narrative: { status: "off", items: [], model: null } };
    const facts = report.sections.flatMap((s) => s.facts).filter((f) => f.nature !== "collection");
    if (!facts.length) return report;
    try {
        const lines = facts.map((f) => `[${f.ref}] ${f.text}`).join("\n");
        const { value, model } = await generateJson(
            { env, config, email: user.email, feature: "briefings" },
            {
                role: "summarise",
                system: CENTRE_BRIEFING_SYSTEM,
                prompt: fence("public-records", lines, 10_000),
                maxTokens: 600,
                schema: interpretationSchema,
            },
        );
        return { ...report, narrative: { status: "ready", items: groundInterpretation(value.items, facts), model } };
    } catch (error) {
        return { ...report, narrative: { status: error instanceof BudgetExceeded ? "budget" : "unavailable", items: [], model: null } };
    }
}

// --- Storing ---------------------------------------------------------------------------------------------

interface ReportRow {
    id: string;
    email: string;
    title: string;
    scope: string;
    period_from: string | null;
    period_to: string;
    generated_at: string;
    fingerprint: string;
    facts: number;
    object_key: string;
    narrative: string | null;
    narrative_model: string | null;
    schedule_id: string | null;
    knowledge_object_id: string | null;
    trigger: ReportSummary["trigger"];
}

const toSummary = (r: ReportRow): ReportSummary => ({
    id: r.id,
    title: r.title,
    scope: reportScopeSchema.safeParse(parseJson(r.scope, {})).data ?? { kind: "nsw" },
    periodFrom: r.period_from,
    periodTo: r.period_to,
    generatedAt: r.generated_at,
    facts: r.facts,
    trigger: r.trigger,
    scheduleId: r.schedule_id,
    knowledgeObjectId: r.knowledge_object_id,
    hasNarrative: !!r.narrative,
});

export async function saveReport(
    env: Env,
    user: PortalUser,
    report: SituationReport,
    options: { trigger: ReportSummary["trigger"]; scheduleId?: string | null },
) {
    const id = newId("icp");
    const key = `${REPORT_PREFIX}${id}.json`;
    const stored = { ...report, id };
    await env.MEDIA.put(key, JSON.stringify(stored), { httpMetadata: { contentType: "application/json" } });
    await env.DB.batch([
        env.DB.prepare(
            `INSERT INTO ic_reports (id, email, title, scope, period_from, period_to, generated_at, fingerprint, facts, object_key, narrative, narrative_model, schedule_id, trigger)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
            id,
            user.email,
            report.title,
            JSON.stringify(report.scope),
            report.periodFrom,
            report.at,
            report.generatedAt,
            report.fingerprint,
            report.sections.reduce((n, s) => n + s.facts.length, 0),
            key,
            report.narrative.items.length ? JSON.stringify(report.narrative.items) : null,
            report.narrative.model,
            options.scheduleId ?? null,
            options.trigger,
        ),
        auditStatement(env.DB, {
            actor: user.email,
            action: "centre.report.create",
            entityType: "centre_report",
            entityId: id,
            summary: `Generated a ${report.scope.kind} situation report${options.trigger === "mcp" ? " through MCP" : options.trigger === "schedule" ? " on a schedule" : ""}`,
        }),
    ]);
    return { report: stored, summary: (await requireReportRow(env.DB, user.email, id)).summary };
}

export async function generateReport(env: Env, user: PortalUser, body: unknown, trigger: ReportSummary["trigger"] = "manual") {
    const request = reportRequestSchema.parse(body);
    return saveReport(env, user, await buildReport(env, user, request), { trigger });
}

async function requireReportRow(db: D1Database, email: string, id: string): Promise<{ row: ReportRow; summary: ReportSummary }> {
    if (!/^icp_[a-z0-9]{14}$/.test(id)) throw new HttpError(404, "not_found", "Not found");
    const row = await db.prepare("SELECT * FROM ic_reports WHERE id = ? AND email = ?").bind(id, email).first<ReportRow>();
    if (!row) throw new HttpError(404, "not_found", "Not found");
    return { row, summary: toSummary(row) };
}

export async function listReports(db: D1Database, email: string, limit = 50): Promise<ReportSummary[]> {
    const rows = await db.prepare("SELECT * FROM ic_reports WHERE email = ? ORDER BY generated_at DESC LIMIT ?").bind(email, limit).all<ReportRow>();
    return rows.results.map(toSummary);
}

export async function getReport(env: Env, email: string, id: string): Promise<{ report: SituationReport; summary: ReportSummary }> {
    const { row, summary } = await requireReportRow(env.DB, email, id);
    const object = await env.MEDIA.get(row.object_key);
    if (!object) throw new HttpError(410, "gone", "This report's content is no longer stored");
    return { report: (await object.json()) as SituationReport, summary };
}

export async function deleteReport(env: Env, user: PortalUser, id: string) {
    const { row } = await requireReportRow(env.DB, user.email, id);
    await env.MEDIA.delete(row.object_key);
    await env.DB.batch([
        env.DB.prepare("DELETE FROM ic_reports WHERE id = ? AND email = ?").bind(id, user.email),
        auditStatement(env.DB, {
            actor: user.email,
            action: "centre.report.delete",
            entityType: "centre_report",
            entityId: id,
            summary: "Deleted a situation report",
        }),
    ]);
}

/** Reports past retention: their R2 content and their rows. */
export async function expireReports(env: Env, before: string) {
    const rows = await env.DB.prepare("SELECT id, object_key FROM ic_reports WHERE generated_at < ? LIMIT 100")
        .bind(before)
        .all<{ id: string; object_key: string }>();
    if (!rows.results.length) return;
    await env.MEDIA.delete(rows.results.map((r) => r.object_key));
    await env.DB.batch(rows.results.map((r) => env.DB.prepare("DELETE FROM ic_reports WHERE id = ?").bind(r.id)));
}

/** The report as plain text (Knowledge notes and exports): sections, facts with links, limitations. */
export function reportText(report: SituationReport, site: string): string {
    return [
        `${report.title}. Generated ${when(report.generatedAt)}${report.historical ? `, describing ${when(report.at)} as the Centre knew it then` : ""}.`,
        ...report.sections.flatMap((s) => [
            s.title,
            ...(s.facts.length ? s.facts.map((f) => `[${f.ref}] ${f.text}${f.url ? ` (${site}${f.url})` : ""}`) : [s.empty ?? "Nothing to report."]),
        ]),
        ...(report.narrative.items.length
            ? ["Narrative (AI interpretation of the facts above, not facts):", ...report.narrative.items.map((i) => `${i.text} [${i.refs.join(", ")}]`)]
            : []),
        "Limitations",
        ...report.limitations,
        ...[...new Set(report.sources.map((s) => s.attribution).filter(Boolean))],
    ].join("\n\n");
}

/** Saves a report as a Knowledge note (once; saving again returns the same note), optionally linked to an existing note. */
export async function reportToKnowledge(env: Env, user: PortalUser, id: string, body: unknown) {
    const input = (body ?? {}) as { spaceId?: unknown; relateTo?: unknown };
    const { report, summary } = await getReport(env, user.email, id);
    const space = await writableSpace(env, user, typeof input.spaceId === "string" ? input.spaceId : undefined);
    const site = new URL(env.SITE_URL).origin;
    const detail = await createObject(
        env.DB,
        user,
        space.id,
        {
            title: report.title.slice(0, 300),
            content: { type: "doc", content: paragraphsFromText(reportText(report, site).slice(0, 60_000)) },
            tags: ["intelligence-centre", "situation-report"],
        },
        { source: { system: "intelligence-centre-report", id } },
    );
    await env.DB.prepare("UPDATE ic_reports SET knowledge_object_id = ? WHERE id = ? AND email = ?").bind(detail.object.id, id, user.email).run();
    let linked = false;
    if (typeof input.relateTo === "string" && /^kob_[a-z0-9]{14}$/.test(input.relateTo)) {
        await addRelation(env.DB, user, detail.object.id, { targetId: input.relateTo, relationType: "evidence" }).catch((error: unknown) => {
            if (!(error instanceof HttpError && error.status === 409)) throw error;
        });
        linked = true;
    }
    return { objectId: detail.object.id, url: `/portal/knowledge/o/${detail.object.id}`, linked, reportId: summary.id };
}

// --- Schedules -----------------------------------------------------------------------------------------

interface ScheduleRow {
    id: string;
    email: string;
    name: string;
    scope: string;
    frequency: ScheduleInput["frequency"];
    weekday: number | null;
    hour: number;
    time_zone: string;
    period_hours: number;
    notify: ScheduleInput["notify"];
    save_to_knowledge: number;
    narrative: number;
    enabled: number;
    version: number;
    next_run_at: string | null;
    last_run_at: string | null;
    last_report_id: string | null;
    last_fingerprint: string | null;
    created_at: string;
    updated_at: string;
}

const toSchedule = (r: ScheduleRow): ReportSchedule => ({
    id: r.id,
    name: r.name,
    scope: reportScopeSchema.safeParse(parseJson(r.scope, {})).data ?? { kind: "nsw" },
    frequency: r.frequency,
    weekday: r.weekday,
    hour: r.hour,
    timeZone: r.time_zone,
    periodHours: r.period_hours,
    notify: r.notify,
    saveToKnowledge: r.save_to_knowledge === 1,
    narrative: r.narrative === 1,
    enabled: r.enabled === 1,
    version: r.version,
    nextRunAt: r.next_run_at,
    lastRunAt: r.last_run_at,
    lastReportId: r.last_report_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
});

/** The next time a schedule runs after `from`, in its own time zone (daylight saving included). */
export function nextRun(s: Pick<ScheduleInput, "frequency" | "weekday" | "hour" | "timeZone">, from: Date): string {
    const today = localDate(from, s.timeZone);
    for (let i = 0; i <= 8; i++) {
        const date = addDays(today, i);
        if (s.frequency === "weekly" && isoWeekday(date) % 7 !== s.weekday) continue;
        const at = zonedInstant(date, `${String(s.hour).padStart(2, "0")}:00`, s.timeZone);
        if (Date.parse(at) > from.getTime()) return at;
    }
    return new Date(from.getTime() + 7 * 86_400_000).toISOString();
}

export async function listSchedules(db: D1Database, email: string): Promise<ReportSchedule[]> {
    const rows = await db.prepare("SELECT * FROM ic_report_schedules WHERE email = ? ORDER BY name COLLATE NOCASE").bind(email).all<ScheduleRow>();
    return rows.results.map(toSchedule);
}

export async function requireSchedule(db: D1Database, email: string, id: string): Promise<ReportSchedule> {
    if (!/^ics_[a-z0-9]{14}$/.test(id)) throw new HttpError(404, "not_found", "Not found");
    const row = await db.prepare("SELECT * FROM ic_report_schedules WHERE id = ? AND email = ?").bind(id, email).first<ScheduleRow>();
    if (!row) throw new HttpError(404, "not_found", "Not found");
    return toSchedule(row);
}

async function checkSchedule(db: D1Database, user: PortalUser, body: unknown): Promise<ScheduleInput> {
    const input = scheduleInputSchema.parse(body);
    if (input.scope.kind === "watch") await requireWatch(db, user.email, input.scope.watchId);
    if (input.scope.kind === "incident")
        throw new HttpError(422, "validation", "Schedule a report for an area or a hazard; an incident report is made on demand");
    try {
        new Intl.DateTimeFormat("en-AU", { timeZone: input.timeZone });
    } catch {
        throw new HttpError(422, "validation", "Unknown time zone");
    }
    return input;
}

const scheduleValues = (s: ScheduleInput) => [
    s.name,
    JSON.stringify(s.scope),
    s.frequency,
    s.frequency === "weekly" ? s.weekday : null,
    s.hour,
    s.timeZone,
    s.periodHours,
    s.notify,
    s.saveToKnowledge ? 1 : 0,
    s.narrative ? 1 : 0,
    s.enabled ? 1 : 0,
];

export async function createSchedule(db: D1Database, user: PortalUser, body: unknown, via: "portal" | "mcp" = "portal"): Promise<ReportSchedule> {
    const input = await checkSchedule(db, user, body);
    const count = await db.prepare("SELECT COUNT(*) AS n FROM ic_report_schedules WHERE email = ?").bind(user.email).first<{ n: number }>();
    if ((count?.n ?? 0) >= MAX_SCHEDULES) throw new HttpError(422, "validation", `You can have up to ${MAX_SCHEDULES} report schedules`);
    const id = newId("ics");
    const now = nowIso();
    await db.batch([
        db
            .prepare(
                `INSERT INTO ic_report_schedules (id, email, name, scope, frequency, weekday, hour, time_zone, period_hours, notify, save_to_knowledge, narrative, enabled,
                    version, next_run_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
            )
            .bind(id, user.email, ...scheduleValues(input), nextRun(input, new Date()), now, now),
        auditStatement(db, {
            actor: user.email,
            action: "centre.report_schedule.create",
            entityType: "centre_report_schedule",
            entityId: id,
            summary: `Scheduled a ${input.frequency} ${input.scope.kind} report${via === "mcp" ? " through MCP" : ""}`,
        }),
    ]);
    return requireSchedule(db, user.email, id);
}

export async function updateSchedule(db: D1Database, user: PortalUser, id: string, body: unknown): Promise<ReportSchedule> {
    const { version, ...rest } = (body ?? {}) as { version?: unknown };
    if (typeof version !== "number") throw new HttpError(422, "validation", "Send the version you edited");
    await requireSchedule(db, user.email, id);
    const input = await checkSchedule(db, user, rest);
    const [result] = await db.batch([
        db
            .prepare(
                `UPDATE ic_report_schedules SET name = ?, scope = ?, frequency = ?, weekday = ?, hour = ?, time_zone = ?, period_hours = ?, notify = ?, save_to_knowledge = ?,
                    narrative = ?, enabled = ?, next_run_at = ?, version = version + 1, updated_at = ? WHERE id = ? AND email = ? AND version = ?`,
            )
            .bind(...scheduleValues(input), nextRun(input, new Date()), nowIso(), id, user.email, version),
        auditStatement(db, {
            actor: user.email,
            action: "centre.report_schedule.update",
            entityType: "centre_report_schedule",
            entityId: id,
            summary: "Changed a report schedule",
        }),
    ]);
    if (!result.meta.changes) throw new HttpError(409, "conflict", "This schedule was changed elsewhere. Reload and try again.");
    return requireSchedule(db, user.email, id);
}

export async function deleteSchedule(db: D1Database, user: PortalUser, id: string) {
    await requireSchedule(db, user.email, id);
    await db.batch([
        db.prepare("DELETE FROM ic_report_schedules WHERE id = ? AND email = ?").bind(id, user.email),
        auditStatement(db, {
            actor: user.email,
            action: "centre.report_schedule.delete",
            entityType: "centre_report_schedule",
            entityId: id,
            summary: "Deleted a report schedule",
        }),
    ]);
}

/** Due schedules (a few per cron run). A report whose facts haven't changed since the last one isn't made again. */
export async function runDueReports(env: Env, options: { now?: Date; max?: number } = {}) {
    const db = env.DB;
    const now = options.now ?? new Date();
    const due = await db
        .prepare("SELECT * FROM ic_report_schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at LIMIT ?")
        .bind(now.toISOString(), options.max ?? 3)
        .all<ScheduleRow>();
    const results: { scheduleId: string; outcome: "created" | "unchanged" | "skipped" | "failed"; reportId?: string }[] = [];
    for (const row of due.results) {
        const schedule = toSchedule(row);
        const next = nextRun(schedule, now);
        const claimed = await db
            .prepare("UPDATE ic_report_schedules SET next_run_at = ?, last_run_at = ? WHERE id = ? AND next_run_at = ?")
            .bind(next, now.toISOString(), row.id, row.next_run_at)
            .run();
        if (!claimed.meta.changes) continue; // another run took it
        const auth = await userForEmail(env, row.email);
        if (!auth.ok || !can(auth.user, "centre.use")) {
            results.push({ scheduleId: row.id, outcome: "skipped" });
            continue;
        }
        try {
            const report = await buildReport(
                env,
                auth.user,
                { scope: schedule.scope, at: null, periodHours: schedule.periodHours, narrative: schedule.narrative },
                now,
            );
            if (row.last_fingerprint && row.last_fingerprint === report.fingerprint) {
                results.push({ scheduleId: row.id, outcome: "unchanged" });
                continue;
            }
            const { summary } = await saveReport(
                env,
                auth.user,
                { ...report, title: `${schedule.name}: ${report.title}`.slice(0, 160) },
                { trigger: "schedule", scheduleId: row.id },
            );
            await db
                .prepare("UPDATE ic_report_schedules SET last_report_id = ?, last_fingerprint = ? WHERE id = ?")
                .bind(summary.id, report.fingerprint, row.id)
                .run();
            if (schedule.saveToKnowledge && can(auth.user, "knowledge.use")) await reportToKnowledge(env, auth.user, summary.id, {}).catch(() => undefined);
            if (schedule.notify !== "none") {
                const prefs = await loadPreferences(db, row.email);
                await db
                    .prepare(
                        `INSERT OR IGNORE INTO ic_alerts (id, email, record_id, change_id, kind, title, detail, url, level_rank, created_at, email_status)
                         VALUES (?, ?, NULL, ?, 'report', ?, ?, ?, 0, ?, ?)`,
                    )
                    .bind(
                        newId("ica"),
                        row.email,
                        summary.id,
                        `Report ready: ${schedule.name}`.slice(0, 300),
                        report.sections[0]?.facts[0]?.text.slice(0, 500) ?? null,
                        `/portal/intelligence-centre/reports/${summary.id}`,
                        nowIso(),
                        schedule.notify === "email" && prefs.preferences.email.alerts ? "pending" : null,
                    )
                    .run();
            }
            results.push({ scheduleId: row.id, outcome: "created", reportId: summary.id });
        } catch (error) {
            console.log(JSON.stringify({ event: "centre_report_failed", schedule: row.id, message: (error as Error).message.slice(0, 200) }));
            results.push({ scheduleId: row.id, outcome: "failed" });
        }
    }
    return results;
}
