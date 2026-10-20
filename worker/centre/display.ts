// What a Wallboard 2.0 screen receives (docs/INTELLIGENCE_CENTRE_9_1.md#wallboard-20): its views and
// every widget's data, built once per refresh from the records the Centre already holds. Each
// distinct area (the board's, a watch area, a region) is loaded once and shared by the widgets
// that show it. A screen sends back the state key it last had; when nothing that could change the
// board has changed, it gets 304 and nothing is rebuilt.
//
// Privacy, as before: for a watch area the screen gets the records that concern it and a frame
// rounded outwards to 0.1° (about 10 km), never the area's coordinates or name (a widget's title
// is the owner's own words). "Nearby" lists are ordered by distance without showing distances.
import type { D1Database } from "@cloudflare/workers-types";
import { sourceGapMessage } from "../../src/shared/centre/gaps";
import { feedLabel, isSignificant } from "../../src/shared/centre/history";
import { type RegionId, regionById } from "../../src/shared/centre/regions";
import { recordNature } from "../../src/shared/centre/types";
import type { CentreBriefing, CentreChange, CentreRecord, MapLayer, SourceHealth, Wallboard, WatchArea } from "../../src/shared/centre/types";
import { CHANGE_KIND_LABELS, fireDangerRank } from "../../src/shared/centre/types";
import type {
    ChartMetric,
    DisplayAlert,
    DisplayChange,
    DisplayRecord,
    DisplaySource,
    DisplayTimelineEvent,
    FireDangerRow,
    WallboardPayloadV2,
    Widget,
    WidgetData,
    WidgetScope,
} from "../../src/shared/centre/wallboard";
import { CHART_METRIC_LABELS, WIDGET_META } from "../../src/shared/centre/wallboard";
import type { PortalUser } from "../../src/shared/portal/types";
import type { Env } from "../env";
import { parseJson } from "../portal/db";
import { sha256Hex } from "./adapters/types";
import { basemapInfo } from "./basemap";
import { buildBriefing } from "./briefing";
import { correlations } from "./correlate";
import { type BBox, NSW_BBOX, type Position, coarseBBox, distanceKm, expandBBox } from "./geo";
import { recordTimeline } from "./history";
import { layerOf, mapFeatures } from "./map";
import { getRecord, listChanges, listRecords, loadCentreSettings, loadPreferences, sourceHealth } from "./store";
import { listWatches, recordsForWatch, requireWatch, watchBBox, watchCentre } from "./watch";

const HOUR = 3_600_000;
const OFFICIAL_KINDS: CentreRecord["kind"][] = ["incident", "warning", "disruption", "event"];
/** Official warning changes worth pinning above every view. */
const HIGHLIGHT_KINDS = new Set(["new", "escalated", "ban_declared", "rating_changed", "geometry_changed"]);

/** The sources each widget's data comes from: named (with why) when they aren't active. */
const WIDGET_SOURCES: Partial<Record<Widget["type"], string[]>> = {
    map: ["rfs-incidents", "rfs-incident-alerts", "bom-warnings", "tfnsw-live-traffic", "endeavour-outages", "dea-hotspots"],
    warnings: ["rfs-incident-alerts", "bom-warnings"],
    nearby_incidents: ["rfs-incidents", "act-esa-incidents"],
    fire_danger: ["rfs-fire-danger"],
    fire_bans: ["rfs-fire-danger"],
    weather: ["bom-observations"],
    observation_chart: ["bom-observations"],
    rainfall_chart: ["bom-observations"],
    river_gauge: ["bom-water"],
    air_quality: ["nsw-air-quality"],
    roads: ["tfnsw-live-traffic"],
    outages: ["endeavour-outages"],
    detections: ["dea-hotspots", "nasa-firms"],
    incident_timeline: ["rfs-incidents"],
};

export const toDisplay = (r: CentreRecord): DisplayRecord => ({
    id: r.id,
    kind: r.kind,
    category: r.category,
    nature: recordNature(r.kind),
    title: r.title,
    status: r.status,
    level: r.warningLevel,
    rank: r.severityRank,
    areaName: r.areaName,
    provider: r.provider,
    sourceId: r.sourceId,
    publishedAt: r.publishedAt,
    updatedAt: r.updatedAt,
    observedAt: r.observedAt,
    sourceUrl: r.sourceUrl,
    metrics: r.metrics,
    attributes: Object.fromEntries(
        Object.entries(r.attributes).filter(([k]) =>
            ["closure", "major", "today", "tomorrow", "banToday", "banTomorrow", "hazardType", "council", "district"].includes(k),
        ),
    ),
    fixture: r.fixture,
});

const toDisplayChange = (c: CentreChange): DisplayChange => ({
    id: c.id,
    kind: c.kind,
    label: feedLabel(c),
    at: c.at,
    summary: c.summary,
    category: c.category,
    recordId: c.recordId,
    sourceId: c.sourceId,
    significant: isSignificant(c),
});

const fireRow = (r: CentreRecord): FireDangerRow => ({
    district: r.title,
    today: r.attributes.today ?? "No rating",
    tomorrow: r.attributes.tomorrow ?? "No rating",
    banToday: r.attributes.banToday === "yes",
    banTomorrow: r.attributes.banTomorrow === "yes",
    updatedAt: r.updatedAt,
});

/** A cheap fingerprint of everything that can change a board: compared before anything is built. */
export async function displayStateKey(db: D1Database, board: Wallboard, now = new Date()): Promise<string> {
    const row = await db
        .prepare(
            "SELECT (SELECT MAX(at) FROM ic_changes) AS changed, (SELECT MAX(last_attempt_at) FROM ic_sources) AS attempted, (SELECT MAX(generated_at) FROM ic_briefings) AS briefed",
        )
        .first<{ changed: string | null; attempted: string | null; briefed: string | null }>();
    // Five-minute buckets: "last two hours" highlights and source ages move on even when nothing new arrives.
    const bucket = Math.floor(now.getTime() / (5 * 60_000));
    return (await sha256Hex(JSON.stringify([board.id, board.version, board.updatedAt, row?.changed, row?.attempted, row?.briefed, bucket]))).slice(0, 32);
}

interface Scope {
    key: string;
    label: string;
    watch: WatchArea | null;
    frame: BBox;
    centre: Position | null;
    records: CentreRecord[];
    /** Lazily loaded on first use. */
    observations?: CentreRecord[];
    ratings?: CentreRecord[];
}

class Builder {
    private scopes = new Map<string, Promise<Scope>>();
    private changes: Promise<CentreChange[]> | null = null;
    private dailyRates: Promise<Map<string, number>> | null = null;
    private health: SourceHealth[] = [];
    private watches: Promise<WatchArea[]> | null = null;

    constructor(
        private readonly env: Env,
        private readonly board: Wallboard,
        private readonly owner: PortalUser,
        private readonly now: Date,
    ) {}

    async init() {
        this.health = await sourceHealth(this.env);
        return this;
    }

    get db() {
        return this.env.DB;
    }

    private scopeKey(scope: WidgetScope | undefined) {
        if (!scope || scope.kind === "board") return this.board.watchId ? `watch:${this.board.watchId}` : "region:nsw";
        return scope.kind === "watch" ? `watch:${scope.watchId}` : `region:${scope.region}`;
    }

    scope(scope: WidgetScope | undefined, title?: string): Promise<Scope> {
        const key = this.scopeKey(scope);
        if (!this.scopes.has(key)) this.scopes.set(key, this.loadScope(key, scope, title));
        return this.scopes.get(key)!;
    }

    private async loadScope(key: string, scope: WidgetScope | undefined, title?: string): Promise<Scope> {
        const boardScope = !scope || scope.kind === "board";
        const [kind, id] = key.split(":") as ["watch" | "region", string];
        if (kind === "watch") {
            const watch = await requireWatch(this.db, this.owner.email, id).catch(() => null);
            const label = boardScope ? this.board.name : (title ?? "Selected area");
            if (!watch) return { key, label, watch: null, frame: NSW_BBOX, centre: null, records: [] };
            const records = (await recordsForWatch(this.db, watch, 600)).map((m) => m.record);
            const box = watchBBox(watch.definition);
            const located = records.filter((r) => r.lat !== null && r.lon !== null);
            const frame = box
                ? coarseBBox(expandBBox(box, 10))
                : located.length
                  ? coarseBBox(
                        expandBBox(
                            [
                                Math.min(...located.map((r) => r.lon!)),
                                Math.min(...located.map((r) => r.lat!)),
                                Math.max(...located.map((r) => r.lon!)),
                                Math.max(...located.map((r) => r.lat!)),
                            ],
                            15,
                        ),
                    )
                  : NSW_BBOX;
            return { key, label, watch, frame, centre: watchCentre(watch.definition), records };
        }
        const region = regionById(id as RegionId) ?? regionById("nsw")!;
        const bbox = region.id === "australia" ? null : region.bbox;
        const records = (await listRecords(this.db, { kinds: [...OFFICIAL_KINDS, "detection", "rating"], ...(bbox ? { bbox } : {}) }, 2000)).records;
        return {
            key,
            label: boardScope ? this.board.name : region.label,
            watch: null,
            frame: region.bbox,
            centre: [(region.bbox[0] + region.bbox[2]) / 2, (region.bbox[1] + region.bbox[3]) / 2],
            records,
        };
    }

    async observations(s: Scope) {
        s.observations ??= (await listRecords(this.db, { kinds: ["observation"], bbox: s.frame }, 600)).records;
        return s.observations;
    }

    async ratings(s: Scope) {
        if (!s.ratings) s.ratings = s.watch ? s.records.filter((r) => r.kind === "rating") : (await listRecords(this.db, { kinds: ["rating"] }, 100)).records;
        return s.ratings;
    }

    /** Changes in the last week (the most any widget looks back), loaded once. */
    allChanges() {
        this.changes ??= listChanges(this.db, { since: new Date(this.now.getTime() - 168 * HOUR).toISOString(), limit: 3000 });
        return this.changes;
    }

    async changesIn(s: Scope, hours: number) {
        const ids = new Set(s.records.map((r) => r.id));
        const since = new Date(this.now.getTime() - hours * HOUR).toISOString();
        const statewide = !s.watch && s.key === "region:nsw";
        return (await this.allChanges()).filter((c) => c.at >= since && ((c.recordId && ids.has(c.recordId)) || (statewide && !c.recordId)));
    }

    rates() {
        this.dailyRates ??= this.db
            .prepare(
                "SELECT source_id, SUM(CASE WHEN outcome IN ('ok', 'unchanged') THEN 1 ELSE 0 END) AS good, COUNT(*) AS n FROM ic_fetch_runs WHERE started_at >= ? GROUP BY source_id",
            )
            .bind(new Date(this.now.getTime() - 24 * HOUR).toISOString())
            .all<{ source_id: string; good: number; n: number }>()
            .then((r) => new Map(r.results.map((x) => [x.source_id, x.n ? Math.round((x.good / x.n) * 100) : 0])));
        return this.dailyRates;
    }

    corridorWatches() {
        this.watches ??= listWatches(this.db, this.owner.email);
        return this.watches;
    }

    async sources(): Promise<DisplaySource[]> {
        const rates = await this.rates();
        return this.health
            .filter((h) => h.source.implemented && h.enabled)
            .map((h) => ({
                id: h.source.id,
                provider: h.source.provider,
                dataset: h.source.dataset,
                status: h.status,
                lastSuccessAt: h.lastSuccessAt,
                lastPublishedAt: h.lastPublishedAt,
                attribution: h.source.attribution,
                successRate24h: rates.has(h.source.id) ? rates.get(h.source.id)! : null,
                gap: sourceGapMessage(h),
            }));
    }

    private problems(type: Widget["type"]) {
        const ids = WIDGET_SOURCES[type] ?? [];
        const health = this.health.filter((h) => ids.includes(h.source.id));
        return {
            unavailable: health
                .filter((h) => h.status !== "active" && h.status !== "stale" && h.status !== "error")
                .map((h) => ({ sourceId: h.source.id, message: sourceGapMessage(h) ?? "" })),
            stale: health.filter((h) => h.status === "stale" || h.status === "error").map((h) => h.source.id),
        };
    }

    async widget(viewId: string, w: Widget): Promise<WidgetData> {
        const meta = WIDGET_META[w.type];
        const st = w.settings;
        const s = w.type === "clock" || w.type === "source_health" || w.type === "source_timestamps" ? null : await this.scope(st.scope, st.title);
        const base = {
            key: `${viewId}:${w.id}`,
            // A chart is named by what it measures unless the owner titled it.
            title:
                st.title ||
                (w.type === "observation_chart"
                    ? CHART_METRIC_LABELS[st.metric ?? "air_temperature"].label
                    : w.type === "rainfall_chart"
                      ? "Rain since 9 am"
                      : meta.label),
            nature: meta.nature,
            scopeLabel: s?.label ?? this.board.name,
            ...this.problems(w.type),
        };
        const limit = st.limit ?? 5;
        const official = (s?.records ?? []).filter((r) => OFFICIAL_KINDS.includes(r.kind));
        const byCategory = (list: CentreRecord[]) => (st.categories?.length ? list.filter((r) => st.categories!.includes(r.category)) : list);
        const list = (
            type: "warnings" | "nearby_incidents" | "roads" | "outages" | "detections" | "air_quality" | "weather",
            items: CentreRecord[],
            extra: { corridorIds?: string[]; customers?: number | null } = {},
        ): WidgetData => ({
            ...base,
            type,
            records: items.slice(0, limit).map(toDisplay),
            total: items.length,
            corridorIds: extra.corridorIds ?? [],
            customers: extra.customers ?? null,
        });
        switch (w.type) {
            case "map": {
                const layers = (st.layers?.length ? st.layers : this.board.layers) as MapLayer[];
                const { settings } = await loadCentreSettings(this.db);
                const mapped = s!.records.filter((r) => r.kind !== "rating" && r.kind !== "observation" && layers.includes(layerOf(r)));
                const shown = mapped.slice(0, settings.maxMapRecords);
                const boardScope = !st.scope || st.scope.kind === "board";
                const outline =
                    boardScope && this.board.showWatchOutline && s!.watch?.definition.kind === "polygon"
                        ? s!.watch.definition.ring.map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100] as [number, number])
                        : null;
                return {
                    ...base,
                    type: "map",
                    frame: s!.frame,
                    features: (await mapFeatures(this.db, shown)).features,
                    layers,
                    legend: st.legend ?? true,
                    outline,
                    truncated: mapped.length > shown.length,
                    unmapped: official.filter((r) => r.lat === null && !r.hasGeometry).length,
                };
            }
            case "warnings":
                return list(
                    "warnings",
                    byCategory(official.filter((r) => r.kind === "warning")).sort((a, b) => b.severityRank - a.severityRank),
                );
            case "nearby_incidents": {
                const centre = s!.centre;
                const incidents = byCategory(official.filter((r) => r.kind === "incident" || r.kind === "event"));
                const sorted = centre
                    ? incidents.sort((a, b) => dist(centre, a) - dist(centre, b) || b.severityRank - a.severityRank)
                    : incidents.sort((a, b) => b.severityRank - a.severityRank);
                return list("nearby_incidents", sorted);
            }
            case "fire_danger":
            case "fire_bans": {
                const ratings = await this.ratings(s!);
                const rows = ratings.map(fireRow);
                const chosen =
                    w.type === "fire_bans"
                        ? rows.filter((r) => r.banToday || r.banTomorrow)
                        : rows.sort((a, b) => fireDangerRank(b.today) - fireDangerRank(a.today) || Number(b.banToday) - Number(a.banToday)).slice(0, limit);
                return { ...base, type: w.type, districts: chosen, updatedAt: ratings[0]?.updatedAt ?? null };
            }
            case "weather":
                return list(
                    "weather",
                    (await this.observations(s!))
                        .filter((o) => o.category === "weather")
                        .sort((a, b) => (b.observedAt ?? "").localeCompare(a.observedAt ?? "")),
                );
            case "air_quality":
                return list(
                    "air_quality",
                    (await this.observations(s!)).filter((o) => o.category === "air").sort((a, b) => b.severityRank - a.severityRank),
                );
            case "observation_chart":
            case "rainfall_chart":
            case "river_gauge": {
                const metric: ChartMetric =
                    w.type === "rainfall_chart" ? "rainfall" : w.type === "river_gauge" ? "water_level" : (st.metric ?? "air_temperature");
                const hours = st.hours ?? (w.type === "river_gauge" ? 72 : 24);
                const prefix = w.type === "river_gauge" ? "gauge-" : "station-";
                let candidates: CentreRecord[];
                if (w.type === "river_gauge")
                    candidates = (await listRecords(this.db, { sources: ["bom-water"], kinds: ["observation"] }, 50)).records.filter(
                        (g) => !st.station || g.externalId === `${prefix}${st.station}`,
                    );
                else {
                    const obs = (await this.observations(s!)).filter(
                        (o) => o.sourceId === "bom-observations" || (o.category === "air" && ["pm25", "pm10", "ozone"].includes(metric)),
                    );
                    candidates = st.station
                        ? obs.filter((o) => o.externalId === `${prefix}${st.station}`)
                        : obs
                              .filter((o) => o.metrics.some((m) => m.key === metric))
                              .sort((a, b) => (b.metrics.find((m) => m.key === metric)?.value ?? 0) - (a.metrics.find((m) => m.key === metric)?.value ?? 0));
                }
                const chosen = candidates.slice(0, w.type === "river_gauge" ? limit : 3);
                const since = new Date(this.now.getTime() - hours * HOUR).toISOString();
                const series = [];
                for (const r of chosen) {
                    const points = (
                        await this.db
                            .prepare("SELECT at, value FROM ic_series WHERE record_id = ? AND metric = ? AND at >= ? ORDER BY at LIMIT 400")
                            .bind(r.id, metric, since)
                            .all<{ at: string; value: number }>()
                    ).results;
                    const latest = r.metrics.find((m) => m.key === metric);
                    series.push({ label: r.title, recordId: r.id, latest: latest?.value ?? null, latestAt: r.observedAt, points });
                }
                return { ...base, type: w.type, metric, unit: CHART_METRIC_LABELS[metric].unit, series };
            }
            case "recent_changes": {
                let changes = await this.changesIn(s!, st.hours ?? 24);
                if (st.categories?.length) changes = changes.filter((c) => !c.category || st.categories!.includes(c.category));
                const shown = changes.map(toDisplayChange).filter((c) => !st.significantOnly || c.significant);
                return { ...base, type: "recent_changes", changes: shown.slice(0, limit), total: shown.length };
            }
            case "incident_timeline": {
                // The record the owner chose, or the most serious current incident in the area.
                const target =
                    (st.recordId ? (s!.records.find((r) => r.id === st.recordId) ?? (await getRecord(this.db, st.recordId))?.record) : null) ??
                    official
                        .filter((r) => r.kind === "incident")
                        .sort((a, b) => b.severityRank - a.severityRank || (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))[0];
                const timeline = target ? await recordTimeline(this.env, target.id, { now: this.now }) : null;
                const events: DisplayTimelineEvent[] = (timeline?.events ?? [])
                    .slice(-(st.limit ?? 8))
                    .map((e) => ({ at: e.at, label: e.label, detail: e.detail, nature: e.nature }));
                return { ...base, type: "incident_timeline", record: target ? toDisplay(target) : null, events };
            }
            case "roads": {
                let roads = official.filter((r) => r.category === "transport");
                const corridorIds: string[] = [];
                if (st.corridors) {
                    for (const watch of (await this.corridorWatches()).filter((x) => x.definition.kind === "corridor" && x.enabled).slice(0, 10)) {
                        for (const m of await recordsForWatch(this.db, { ...watch, categories: [] }, 100))
                            if (m.record.category === "transport") {
                                corridorIds.push(m.record.id);
                                if (!roads.some((r) => r.id === m.record.id)) roads = [...roads, m.record];
                            }
                    }
                }
                const ranked = roads.sort(
                    (a, b) =>
                        Number(corridorIds.includes(b.id)) - Number(corridorIds.includes(a.id)) ||
                        Number(b.attributes.closure === "yes") - Number(a.attributes.closure === "yes") ||
                        (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""),
                );
                return list("roads", ranked, { corridorIds: [...new Set(corridorIds)] });
            }
            case "outages": {
                const outages = official.filter((r) => r.category === "power");
                return list(
                    "outages",
                    outages.sort(
                        (a, b) => (b.metrics.find((m) => m.key === "customers")?.value ?? 0) - (a.metrics.find((m) => m.key === "customers")?.value ?? 0),
                    ),
                    { customers: outages.reduce((n, o) => n + (o.metrics.find((m) => m.key === "customers")?.value ?? 0), 0) },
                );
            }
            case "detections": {
                const since = new Date(this.now.getTime() - (st.hours ?? 24) * HOUR).toISOString();
                return list(
                    "detections",
                    s!.records
                        .filter((r) => r.kind === "detection" && (r.observedAt ?? "") >= since)
                        .sort((a, b) => (b.observedAt ?? "").localeCompare(a.observedAt ?? "")),
                );
            }
            case "correlations": {
                const { settings } = await loadCentreSettings(this.db);
                const ids = new Set(s!.records.map((r) => r.id));
                const found = (await correlations(this.db, settings, { bbox: s!.frame, now: this.now })).filter(
                    (c) => !s!.watch || c.records.some((r) => ids.has(r.recordId)),
                );
                return { ...base, type: "correlations", correlations: found.slice(0, limit) };
            }
            case "trends": {
                const hours = st.hours ?? 168;
                const changes = (await this.changesIn(s!, hours)).filter(
                    (c) => c.kind === "new" && c.category && (!st.categories?.length || st.categories.includes(c.category)),
                );
                const days = new Map<string, Record<string, number>>();
                for (let t = this.now.getTime() - hours * HOUR; t <= this.now.getTime(); t += 24 * HOUR) days.set(new Date(t).toISOString().slice(0, 10), {});
                for (const c of changes) {
                    const day = days.get(c.at.slice(0, 10)) ?? {};
                    day[c.category!] = (day[c.category!] ?? 0) + 1;
                    days.set(c.at.slice(0, 10), day);
                }
                return {
                    ...base,
                    type: "trends",
                    days: [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, counts]) => ({ date, counts })),
                    note: "New official records per day as collected (UTC dates): not complete statistics.",
                };
            }
            case "summary": {
                const warnings = official.filter((r) => r.kind === "warning");
                const incidents = official.filter((r) => r.kind === "incident" || r.kind === "event");
                const ratings = await this.ratings(s!);
                const top = Math.max(0, ...ratings.map((r) => fireDangerRank(r.attributes.today)));
                const bans = ratings.filter((r) => r.attributes.banToday === "yes").length;
                const level = (n: number) => official.filter((r) => r.severityRank === n).length;
                const recent = (await this.changesIn(s!, 6)).filter((c) => isSignificant(c)).length;
                const newest = this.health
                    .map((h) => h.lastSuccessAt)
                    .filter((x): x is string => !!x)
                    .sort()
                    .pop();
                const lines = [
                    `${warnings.length} official ${warnings.length === 1 ? "warning" : "warnings"} and ${incidents.length} ${incidents.length === 1 ? "incident" : "incidents"} in the sources collected.`,
                    level(3) || level(2)
                        ? `${level(3)} at Emergency Warning, ${level(2)} at Watch and Act, as published.`
                        : "None at Watch and Act or Emergency Warning in the sources collected.",
                    ratings.length
                        ? `Highest Fire Danger Rating today: ${["No rating", "Moderate", "High", "Extreme", "Catastrophic"][top]}${bans ? `; Total Fire Ban in ${bans} ${bans === 1 ? "district" : "districts"}` : ""}.`
                        : "Fire danger isn't being collected.",
                    `${recent} significant ${recent === 1 ? "change" : "changes"} in the last six hours.`,
                    newest
                        ? `Latest successful collection ${Math.max(0, Math.round((this.now.getTime() - Date.parse(newest)) / 60_000))} minutes before this refresh (${new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Sydney", hour: "numeric", minute: "2-digit" }).format(new Date(newest))}).`
                        : "Nothing has been collected yet.",
                ];
                const counts = [
                    { label: "Fires", value: incidents.filter((r) => r.category === "fire").length },
                    { label: "Other incidents", value: incidents.filter((r) => r.category !== "fire").length },
                    { label: "Warnings", value: warnings.length },
                    { label: "Road hazards", value: official.filter((r) => r.category === "transport").length },
                    { label: "Power outages", value: official.filter((r) => r.category === "power").length },
                    {
                        label: "Detections (24 h)",
                        value: s!.records.filter(
                            (r) => r.kind === "detection" && (r.observedAt ?? "") >= new Date(this.now.getTime() - 24 * HOUR).toISOString(),
                        ).length,
                    },
                ];
                return { ...base, type: "summary", lines, counts };
            }
            case "briefing": {
                const b = await buildBriefing(this.env, this.owner, this.health, {
                    scope: s!.watch ? "watch" : "nsw",
                    watch: s!.watch,
                    correlations: [],
                    now: this.now,
                });
                const facts = b.sections.flatMap((x) => x.facts).slice(0, limit);
                let interpretation: CentreBriefing["interpretation"] | null = null;
                if (st.showInterpretation ?? this.board.showInterpretation) {
                    const stored = await this.db
                        .prepare("SELECT interpretation, model FROM ic_briefings WHERE email = ? AND scope = ?")
                        .bind(this.owner.email, s!.watch ? `watch:${s!.watch.id}` : "nsw:nsw")
                        .first<{ interpretation: string; model: string | null }>();
                    interpretation = stored
                        ? { status: "ready", items: parseJson(stored.interpretation, []), model: stored.model }
                        : { status: "not_requested", items: [], model: null };
                }
                return { ...base, type: "briefing", facts, interpretation };
            }
            case "source_health":
            case "source_timestamps":
                return { ...base, type: w.type, sources: await this.sources() };
            case "clock":
                return { ...base, type: "clock", showSeconds: st.showSeconds ?? true };
        }
    }

    /** Emergency Warnings in force in the board's own area, and official warning changes there in the last two hours. */
    async alerts(): Promise<DisplayAlert[]> {
        const s = await this.scope(undefined);
        const inForce = s.records.filter((r) => (r.kind === "warning" || r.kind === "incident") && r.severityRank >= 3);
        const recordById = new Map(s.records.map((r) => [r.id, r]));
        const since = new Date(this.now.getTime() - 2 * HOUR).toISOString();
        const changes = (await this.changesIn(s, 2)).filter(
            (c) =>
                c.at >= since &&
                HIGHLIGHT_KINDS.has(c.kind) &&
                c.recordId &&
                ["warning", "incident", "rating"].includes(recordById.get(c.recordId)?.kind ?? ""),
        );
        const out = new Map<string, DisplayAlert>();
        for (const c of changes) {
            const r = recordById.get(c.recordId!)!;
            if (!out.has(r.id))
                out.set(r.id, {
                    id: c.id,
                    recordId: r.id,
                    title: r.title,
                    level: r.warningLevel,
                    rank: Math.max(r.severityRank, c.severityRank),
                    provider: r.provider,
                    publishedAt: r.publishedAt,
                    updatedAt: r.updatedAt,
                    sourceUrl: r.sourceUrl,
                    change: `${CHANGE_KIND_LABELS[c.kind]}: ${c.summary}`,
                    changedAt: c.at,
                });
        }
        for (const r of inForce)
            if (!out.has(r.id))
                out.set(r.id, {
                    id: r.id,
                    recordId: r.id,
                    title: r.title,
                    level: r.warningLevel,
                    rank: r.severityRank,
                    provider: r.provider,
                    publishedAt: r.publishedAt,
                    updatedAt: r.updatedAt,
                    sourceUrl: r.sourceUrl,
                    change: null,
                    changedAt: null,
                });
        return [...out.values()]
            .sort((a, b) => b.rank - a.rank || (b.changedAt ?? b.updatedAt ?? "").localeCompare(a.changedAt ?? a.updatedAt ?? ""))
            .slice(0, 6);
    }
}

const dist = (centre: Position, r: CentreRecord) => (r.lat !== null && r.lon !== null ? distanceKm(centre, [r.lon, r.lat]) : Number.POSITIVE_INFINITY);

export async function wallboardPayloadV2(
    env: Env,
    board: Wallboard,
    owner: PortalUser,
    options: { now?: Date; stateKey?: string; expiresAt?: string | null; renewable?: boolean } = {},
): Promise<WallboardPayloadV2> {
    const now = options.now ?? new Date();
    const builder = await new Builder(env, board, owner, now).init();
    const [{ preferences }, basemap] = await Promise.all([loadPreferences(env.DB, owner.email), basemapInfo(env, "display")]);
    const data: Record<string, WidgetData> = {};
    for (const view of board.views)
        for (const w of view.widgets) {
            try {
                data[`${view.id}:${w.id}`] = await builder.widget(view.id, w);
            } catch (error) {
                // One widget failing never blanks the screen: it says so and the others carry on.
                console.log(JSON.stringify({ event: "centre_widget_failed", type: w.type, message: (error as Error).message.slice(0, 200) }));
            }
        }
    const scope = await builder.scope(undefined);
    return {
        version: 2,
        stateKey: options.stateKey ?? (await displayStateKey(env.DB, board, now)),
        board: {
            name: board.name,
            theme: board.theme,
            scale: board.scale,
            clock: board.clock,
            burnIn: board.burnIn,
            rotate: board.rotate && board.views.length > 1,
            rotationSeconds: board.rotationSeconds,
            refreshSeconds: board.refreshSeconds,
        },
        views: board.views.map((v) => ({
            id: v.id,
            name: v.name,
            preset: v.preset,
            widgets: v.widgets.map(({ id, type, x, y, w, h }) => ({ id, type, x, y, w, h })),
        })),
        data,
        alerts: await builder.alerts(),
        sources: await builder.sources(),
        basemap,
        areaLabel: scope.label,
        generatedAt: now.toISOString(),
        timeZone: preferences.timeZone,
        renewal: {
            due: !!options.renewable && !!options.expiresAt && Date.parse(options.expiresAt) - now.getTime() < 14 * 86_400_000,
            expiresAt: options.expiresAt ?? null,
        },
    };
}
