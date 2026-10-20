// History (docs/INTELLIGENCE_CENTRE_9_1.md#history): incident and situation timelines, historical
// replay, the "What's changed" feed, analytics and source reliability.
//
// Historical integrity comes first. Replay reads only versions stored at or before the moment
// chosen (ic_record_versions.valid_from), never the current record, so nothing learnt later leaks
// into the past. Official events carry the provider's own time and, beside it, when the Centre
// collected them: an update is never shown as known before it was collected. Periods before
// history recording began, past retention, or when a source wasn't being retrieved are said
// plainly instead of looking like quiet periods.
import type { D1Database } from "@cloudflare/workers-types";
import type {
    AnalyticsSeries,
    CentreAnalytics,
    FeedChange,
    FeedFilters,
    RecordTimeline,
    ReplayComparison,
    ReplayFrame,
    ReplayMeta,
    ReplayRecord,
    ReplaySourceState,
    SituationTimeline,
    SourceReliability,
    TimelineEvent,
    TimelineNature,
} from "../../src/shared/centre/history";
import { FEED_CHANGE_GROUPS, feedLabel, isSignificant } from "../../src/shared/centre/history";
import { REGIONS, type RegionId, regionById } from "../../src/shared/centre/regions";
import { CATEGORY_LABELS, type HazardCategory, IMPLEMENTED_SOURCES, sourceById } from "../../src/shared/centre/sources";
import type { CentreChange, CentreRecord, ChangeKind, MapLayer, RecordMetric, WatchArea } from "../../src/shared/centre/types";
import { CHANGE_KIND_LABELS } from "../../src/shared/centre/types";
import type { Env } from "../env";
import { nowIso, parseJson } from "../portal/db";
import { isEnabled } from "../portal/flags";
import { correlations } from "./correlate";
import { type BBox, type Geometry, type Position, distanceKm, expandBBox } from "./geo";
import { buildFeatures, layerOf, screenArea } from "./map";
import { getRecord, listChanges, loadCentreSettings, sourceRows } from "./store";
import { matchContextFor, matchWatch, recordsForWatch } from "./watch";

const HOUR = 3_600_000;
const DAY = 86_400_000;
const MAX_TIMELINE_EVENTS = 400;

const when = (iso: string | null) =>
    iso
        ? new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Sydney", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(
              new Date(iso),
          )
        : "time not given";

const minutesLabel = (m: number) => (m < 120 ? `${m} minutes` : m < 2880 ? `${Math.round(m / 60)} hours` : `${Math.round(m / 1440)} days`);

// --- Versions ----------------------------------------------------------------------------------------

export interface VersionRow {
    id: string;
    record_id: string;
    source_id: string;
    seq: number;
    valid_from: string;
    valid_to: string | null;
    baseline: number;
    change_kind: string | null;
    kind: CentreRecord["kind"];
    category: HazardCategory;
    event_type: string | null;
    title: string;
    description: string | null;
    status: string | null;
    warning_level: string | null;
    severity_rank: number;
    lat: number | null;
    lon: number | null;
    min_lat: number | null;
    min_lon: number | null;
    max_lat: number | null;
    max_lon: number | null;
    geometry_quality: CentreRecord["geometryQuality"];
    geometry_hash: string | null;
    uncertainty_m: number | null;
    area_name: string | null;
    published_at: string | null;
    updated_at: string | null;
    observed_at: string | null;
    active: number;
    missing: number;
    source_url: string | null;
    metrics: string;
    attrs: string;
    fixture: number;
}

export const toReplayRecord = (v: VersionRow): ReplayRecord => ({
    id: v.record_id,
    versionSeq: v.seq,
    sourceId: v.source_id,
    provider: sourceById(v.source_id)?.provider ?? v.source_id,
    kind: v.kind,
    category: v.category,
    title: v.title,
    status: v.status,
    warningLevel: v.warning_level,
    severityRank: v.severity_rank,
    lat: v.lat,
    lon: v.lon,
    areaName: v.area_name,
    publishedAt: v.published_at,
    updatedAt: v.updated_at,
    observedAt: v.observed_at,
    active: v.active === 1,
    missing: v.missing === 1,
    baseline: v.baseline === 1,
    validFrom: v.valid_from,
    validTo: v.valid_to,
    sourceUrl: v.source_url,
    metrics: parseJson<RecordMetric[]>(v.metrics, []),
    attributes: parseJson<Record<string, string>>(v.attrs, {}),
    fixture: v.fixture === 1,
});

/** A version in the shape the watch matcher and map builder read (its own stored values only). */
const asRecord = (v: VersionRow): CentreRecord => ({
    ...toReplayRecord(v),
    externalId: "",
    eventType: v.event_type,
    description: v.description,
    bbox: v.min_lon !== null && v.min_lat !== null && v.max_lon !== null && v.max_lat !== null ? [v.min_lon, v.min_lat, v.max_lon, v.max_lat] : null,
    hasGeometry: !!v.geometry_hash,
    geometryQuality: v.geometry_quality,
    uncertaintyM: v.uncertainty_m,
    firstSeenAt: v.valid_from,
    lastSeenAt: v.valid_from,
    missingSince: v.missing ? v.valid_from : null,
});

/** When history recording first stored anything (kept even after old versions are removed). */
export async function historyStartedAt(db: D1Database): Promise<string | null> {
    const row = await db.prepare("SELECT json_extract(value, '$.startedAt') AS at FROM ic_config WHERE key = 'history'").first<{ at: string | null }>();
    if (row?.at) return row.at;
    return (await db.prepare("SELECT MIN(valid_from) AS at FROM ic_record_versions").first<{ at: string | null }>())?.at ?? null;
}

/** Notes the moment history recording first wrote (idempotent). */
export const markHistoryStarted = (db: D1Database, at: string) =>
    db
        .prepare("INSERT OR IGNORE INTO ic_config (key, value, version, updated_at, updated_by) VALUES ('history', ?, 1, ?, 'system')")
        .bind(JSON.stringify({ startedAt: at }), at);

async function geometriesByHash(db: D1Database, hashes: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const unique = [...new Set(hashes)];
    for (let i = 0; i < unique.length; i += 90) {
        const part = unique.slice(i, i + 90);
        const rows = await db
            .prepare(`SELECT hash, geometry FROM ic_geometries WHERE hash IN (${part.map(() => "?").join(",")})`)
            .bind(...part)
            .all<{ hash: string; geometry: string }>();
        for (const r of rows.results) out.set(r.hash, r.geometry);
    }
    return out;
}

// --- Source gaps -------------------------------------------------------------------------------------

/** Periods with no successful retrieval for longer than the source's own limit, from collection runs. */
export async function sourceGaps(
    db: D1Database,
    from: string,
    to: string,
    sourceIds?: string[],
): Promise<{ sourceId: string; from: string; to: string; minutes: number }[]> {
    const ids = sourceIds ?? IMPLEMENTED_SOURCES.map((s) => s.id);
    if (!ids.length) return [];
    const rows = await db
        .prepare(
            `SELECT source_id, started_at FROM ic_fetch_runs WHERE outcome IN ('ok', 'unchanged') AND started_at BETWEEN ? AND ?
             AND source_id IN (${ids.map(() => "?").join(",")}) ORDER BY source_id, started_at LIMIT 20000`,
        )
        .bind(from, to, ...ids)
        .all<{ source_id: string; started_at: string }>();
    const bySource = new Map<string, string[]>();
    for (const r of rows.results) bySource.set(r.source_id, [...(bySource.get(r.source_id) ?? []), r.started_at]);
    const gaps: { sourceId: string; from: string; to: string; minutes: number }[] = [];
    for (const [sourceId, times] of bySource) {
        const limit = (sourceById(sourceId)?.staleAfterMinutes ?? 90) * 60_000;
        for (let i = 1; i < times.length; i++) {
            const ms = Date.parse(times[i]) - Date.parse(times[i - 1]);
            if (ms > limit) gaps.push({ sourceId, from: times[i - 1], to: times[i], minutes: Math.round(ms / 60_000) });
        }
    }
    return gaps.sort((a, b) => a.from.localeCompare(b.from)).slice(0, 200);
}

const gapEvent = (g: { sourceId: string; from: string; to: string; minutes: number }): TimelineEvent => {
    const source = sourceById(g.sourceId);
    return {
        at: g.from,
        kind: "source_gap",
        nature: "collection",
        label: "Collection gap",
        detail: `No successful retrieval of ${source ? `${source.provider}: ${source.dataset}` : g.sourceId} for ${minutesLabel(g.minutes)} (until ${when(g.to)}). Updates the provider published in this time may be missing here.`,
        recordId: null,
        sourceId: g.sourceId,
        sourceUrl: null,
        collectedAt: null,
    };
};

// --- Timelines -----------------------------------------------------------------------------------------

const CHANGE_NATURE: Partial<Record<ChangeKind, TimelineNature>> = {
    measurement_change: "observed",
    not_in_feed: "derived",
    source_failed: "collection",
    source_stale: "collection",
    source_recovered: "collection",
};

const changeEvent = (c: CentreChange): TimelineEvent => ({
    at: c.at,
    kind: "change",
    nature: CHANGE_NATURE[c.kind] ?? "official",
    label: CHANGE_KIND_LABELS[c.kind],
    detail: `${c.summary} (detected when collected, ${when(c.at)})`,
    recordId: c.recordId,
    sourceId: c.sourceId,
    sourceUrl: null,
    collectedAt: c.at,
});

/**
 * An official event's time: the provider's own update time when it gave one that fits (after the
 * previous collection, not after this one), otherwise when it was collected.
 */
const officialTime = (v: VersionRow, previous: VersionRow | null) => {
    const own = v.updated_at ?? v.published_at;
    if (own && own <= v.valid_from && (!previous || own > previous.valid_from)) return own;
    return v.valid_from;
};

function versionEvents(versions: VersionRow[], provider: string): TimelineEvent[] {
    const events: TimelineEvent[] = [];
    for (let i = 1; i < versions.length; i++) {
        const a = versions[i - 1];
        const b = versions[i];
        const base = { recordId: b.record_id, sourceId: b.source_id, sourceUrl: b.source_url, collectedAt: b.valid_from };
        const at = officialTime(b, a);
        const before = parseJson<Record<string, string>>(a.attrs, {});
        const after = parseJson<Record<string, string>>(b.attrs, {});
        let described = false;
        if (a.warning_level !== b.warning_level) {
            events.push({
                ...base,
                at,
                kind: "level_change",
                nature: "official",
                label:
                    b.severity_rank > a.severity_rank
                        ? "Warning level raised"
                        : b.severity_rank < a.severity_rank
                          ? "Warning level lowered"
                          : "Warning level changed",
                detail: `${a.warning_level ?? "No level"} → ${b.warning_level ?? "no level"}, as ${provider} published it.`,
            });
            described = true;
        }
        if (b.kind === "rating" && before.today !== after.today) {
            events.push({
                ...base,
                at,
                kind: "level_change",
                nature: "official",
                label: "Fire Danger Rating changed",
                detail: `Today: ${before.today ?? "not listed"} → ${after.today ?? "not listed"}.`,
            });
            described = true;
        }
        if (b.kind === "rating" && before.banToday !== after.banToday) {
            events.push({
                ...base,
                at,
                kind: "status_change",
                nature: "official",
                label: after.banToday === "yes" ? "Total Fire Ban declared" : "Total Fire Ban no longer listed",
                detail: `For today, as the RFS lists it.`,
            });
            described = true;
        }
        if (a.status !== b.status && b.active === 1) {
            events.push({
                ...base,
                at,
                kind: "status_change",
                nature: "official",
                label: "Status changed",
                detail: `${a.status ?? "No status"} → ${b.status ?? "no status"}.`,
            });
            described = true;
        }
        if (a.geometry_hash !== b.geometry_hash) {
            events.push({
                ...base,
                at,
                kind: "area_change",
                nature: "official",
                label: !a.geometry_hash ? "Published area added" : !b.geometry_hash ? "Published area removed" : "Published area changed",
                detail: `As ${provider} published it. The Centre draws areas exactly as published.`,
            });
            described = true;
        }
        if (a.active === 1 && b.active === 0 && b.missing === 0) {
            events.push({
                ...base,
                at,
                kind: "ended",
                nature: "official",
                label: "Provider marked it ended",
                detail: `${provider} marked it ${b.status ?? "ended"}.`,
            });
            described = true;
        }
        if (a.missing === 0 && b.missing === 1) {
            events.push({
                ...base,
                at: b.valid_from,
                kind: "not_in_feed",
                nature: "derived",
                label: "No longer in the feed",
                detail: "It wasn't in the provider's next complete listing. That isn't confirmation it's resolved.",
            });
            described = true;
        }
        if ((a.missing === 1 || a.active === 0) && b.active === 1) {
            events.push({
                ...base,
                at: b.valid_from,
                kind: "reappeared",
                nature: "official",
                label: "Back in the feed",
                detail: `${provider} listed it again.`,
            });
            described = true;
        }
        if (!described)
            events.push({
                ...base,
                at,
                kind: "provider_update",
                nature: "official",
                label: "Provider updated it",
                detail:
                    b.updated_at && b.updated_at !== a.updated_at
                        ? `${provider}'s update of ${when(b.updated_at)}.`
                        : `${provider} changed the record's details.`,
            });
    }
    return events;
}

/** Observations, roads and detections near a record during its life: evidence, labelled by what it is. */
async function surroundings(db: D1Database, record: CentreRecord, from: string, to: string): Promise<TimelineEvent[]> {
    if (record.lat === null || record.lon === null) return [];
    const point: Position = [record.lon, record.lat];
    const events: TimelineEvent[] = [];
    const near = (km: number) => expandBBox([point[0], point[1], point[0], point[1]], km);
    const base = { collectedAt: null, sourceUrl: null } as const;

    // Weather observations within 30 km: the strongest gust, highest temperature and most rain.
    const box = near(30);
    const stations = (
        await db
            .prepare("SELECT id, title, lat, lon FROM ic_records WHERE source_id = 'bom-observations' AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ? LIMIT 80")
            .bind(box[1], box[3], box[0], box[2])
            .all<{ id: string; title: string; lat: number; lon: number }>()
    ).results.filter((s) => distanceKm(point, [s.lon, s.lat]) <= 30);
    if (stations.length) {
        const peaks = await db
            .prepare(
                `SELECT record_id, metric, MAX(value) AS value, at FROM ic_series WHERE record_id IN (${stations.map(() => "?").join(",")})
                 AND metric IN ('gust_kmh', 'air_temperature', 'rainfall') AND at BETWEEN ? AND ? GROUP BY metric`,
            )
            .bind(...stations.map((s) => s.id), from, to)
            .all<{ record_id: string; metric: string; value: number; at: string }>();
        const labels: Record<string, [string, string]> = {
            gust_kmh: ["Strongest gust nearby", "km/h"],
            air_temperature: ["Highest temperature nearby", "°C"],
            rainfall: ["Most rain since 9 am nearby", "mm"],
        };
        for (const p of peaks.results) {
            const s = stations.find((x) => x.id === p.record_id)!;
            events.push({
                ...base,
                at: p.at,
                kind: "observation",
                nature: "observed",
                label: labels[p.metric][0],
                detail: `${p.value} ${labels[p.metric][1]} at ${s.title}, about ${Math.round(distanceKm(point, [s.lon, s.lat]))} km away (Bureau of Meteorology observation).`,
                recordId: s.id,
                sourceId: "bom-observations",
            });
        }
    }

    // Road closures and hazards first reported within 25 km while it was current.
    if (record.category !== "transport") {
        const roadBox = near(25);
        const roads = (
            await db
                .prepare(
                    `SELECT id, title, lat, lon, published_at, first_seen_at, source_url FROM ic_records WHERE category = 'transport' AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?
                     AND first_seen_at BETWEEN ? AND ? ORDER BY first_seen_at LIMIT 40`,
                )
                .bind(roadBox[1], roadBox[3], roadBox[0], roadBox[2], from, to)
                .all<{ id: string; title: string; lat: number; lon: number; published_at: string | null; first_seen_at: string; source_url: string | null }>()
        ).results.filter((r) => distanceKm(point, [r.lon, r.lat]) <= 25);
        for (const r of roads.slice(0, 10))
            events.push({
                at: r.published_at && r.published_at <= r.first_seen_at ? r.published_at : r.first_seen_at,
                kind: "road",
                nature: "official",
                label: "Road disruption reported nearby",
                detail: `${r.title}, about ${Math.round(distanceKm(point, [r.lon, r.lat]))} km away (Transport for NSW). Nearby isn't the same as related.`,
                recordId: r.id,
                sourceId: "tfnsw-live-traffic",
                sourceUrl: r.source_url,
                collectedAt: r.first_seen_at,
            });
    }

    // Satellite detections within 5 km, grouped by hour (detections are kept only briefly).
    if (record.category === "fire") {
        const fireBox = near(5);
        const detections = (
            await db
                .prepare(
                    `SELECT lat, lon, observed_at, source_id FROM ic_records WHERE kind = 'detection' AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?
                     AND observed_at BETWEEN ? AND ? LIMIT 500`,
                )
                .bind(fireBox[1], fireBox[3], fireBox[0], fireBox[2], from, to)
                .all<{ lat: number; lon: number; observed_at: string; source_id: string }>()
        ).results.filter((d) => distanceKm(point, [d.lon, d.lat]) <= 5);
        const byHour = new Map<string, { n: number; source: string }>();
        for (const d of detections) {
            const hour = `${d.observed_at.slice(0, 13)}:00:00.000Z`;
            byHour.set(hour, { n: (byHour.get(hour)?.n ?? 0) + 1, source: d.source_id });
        }
        for (const [hour, { n, source }] of [...byHour].slice(-12))
            events.push({
                ...base,
                at: hour,
                kind: "detection",
                nature: "observed",
                label: "Satellite detections nearby",
                detail: `${n} thermal ${n === 1 ? "detection" : "detections"} within 5 km in this hour (heat signatures, not confirmed fire activity).`,
                recordId: null,
                sourceId: source,
            });
    }
    return events;
}

export async function recordTimeline(env: Env, recordId: string, options: { now?: Date } = {}): Promise<RecordTimeline | null> {
    const db = env.DB;
    const now = options.now ?? new Date();
    const found = await getRecord(db, recordId);
    const versions = (await db.prepare("SELECT * FROM ic_record_versions WHERE record_id = ? ORDER BY seq LIMIT 500").bind(recordId).all<VersionRow>()).results;
    if (!found && !versions.length) return null;
    const record = found?.record ?? asRecord(versions[versions.length - 1]);
    const provider = record.provider;
    const events: TimelineEvent[] = [];
    const notes: string[] = [];
    const firstCollected = found?.record.firstSeenAt ?? versions[0]?.valid_from ?? null;

    if (firstCollected)
        events.push({
            at: firstCollected,
            kind: "first_seen",
            nature: "collection",
            label: "First collected by Daly Intelligence",
            detail: `The first collection of ${provider} that contained it.`,
            recordId,
            sourceId: record.sourceId,
            sourceUrl: null,
            collectedAt: firstCollected,
        });
    if (record.publishedAt)
        events.push({
            at: record.publishedAt,
            kind: "published",
            nature: "official",
            label: `Published by ${provider}`,
            detail: `The provider's own publication time.${firstCollected && record.publishedAt < firstCollected ? ` It was collected later, at ${when(firstCollected)}.` : ""}`,
            recordId,
            sourceId: record.sourceId,
            sourceUrl: record.sourceUrl,
            collectedAt: firstCollected,
        });

    const historyFrom = versions[0]?.valid_from ?? null;
    const startsAtBaseline = versions[0]?.baseline === 1;
    if (versions.length) {
        if (startsAtBaseline)
            events.push({
                at: versions[0].valid_from,
                kind: "baseline",
                nature: "collection",
                label: "History begins here",
                detail: "Recorded as it already stood. Earlier updates weren't kept as history (only the changes detected below, if any).",
                recordId,
                sourceId: record.sourceId,
                sourceUrl: null,
                collectedAt: versions[0].valid_from,
            });
        events.push(...versionEvents(versions, provider));
        notes.push(`Each official update shows the provider's own time where it gave one, and when the Centre collected it.`);
    } else
        notes.push(
            "No versioned history is stored for this record (history recording was off, or it wasn't collected since). The changes detected between collections are shown instead.",
        );

    // Changes detected before history recording reached it (or all of them, without versions).
    const changes = await listChanges(db, { recordId, limit: 300 });
    for (const c of changes) if (!historyFrom || c.at < historyFrom) events.push(changeEvent(c));

    const end = record.active ? now.toISOString() : (versions[versions.length - 1]?.valid_from ?? record.lastSeenAt);
    const from = new Date(Math.max(Date.parse(firstCollected ?? end) - 6 * HOUR, Date.parse(end) - 14 * DAY)).toISOString();
    const to = new Date(Math.min(Date.parse(end) + 6 * HOUR, now.getTime())).toISOString();
    events.push(...(await surroundings(db, record, from, to)));

    const { settings } = await loadCentreSettings(db);
    if (record.active)
        for (const c of await correlations(db, settings, { recordId }))
            events.push({
                at:
                    c.records
                        .map((r) => r.at)
                        .filter((x): x is string => !!x)
                        .sort()
                        .pop() ?? now.toISOString(),
                kind: "correlation",
                nature: "derived",
                label: c.basis === "explicit" ? "Linked by the provider" : "Possibly related (derived)",
                detail: `${c.title}. ${c.explanation} ${c.basis === "explicit" ? "" : "Derived by a rule; not official and not evidence of cause."}`.trim(),
                recordId: null,
                sourceId: null,
                sourceUrl: null,
                collectedAt: null,
            });

    const gaps = await sourceGaps(db, from, to, [record.sourceId]);
    events.push(...gaps.map(gapEvent));
    const oldestRun = await db
        .prepare("SELECT MIN(started_at) AS at FROM ic_fetch_runs WHERE source_id = ?")
        .bind(record.sourceId)
        .first<{ at: string | null }>();
    if (oldestRun?.at && oldestRun.at > from)
        notes.push(`Collection gaps before ${when(oldestRun.at)} can't be shown: older collection runs are past their retention.`);
    if (record.category === "fire") notes.push("Satellite detections are kept for only a few days, so older detections aren't shown.");

    events.sort((a, b) => a.at.localeCompare(b.at) || a.kind.localeCompare(b.kind));
    return {
        recordId,
        title: record.title,
        events: events.slice(-MAX_TIMELINE_EVENTS),
        startsAtBaseline,
        historyFrom,
        notes,
    };
}

/** Ids of every stored record that concerns a watch area or lies in a region. */
async function scopeRecordIds(db: D1Database, scope: { watch: WatchArea | null; region: RegionId | null }): Promise<Set<string> | null> {
    if (scope.watch) return new Set((await recordsForWatch(db, scope.watch, 3000, { includeInactive: true })).map((m) => m.record.id));
    if (scope.region && scope.region !== "nsw" && scope.region !== "australia") {
        const [w, s, e, n] = regionById(scope.region)!.bbox;
        const rows = await db
            .prepare(
                "SELECT id FROM ic_records WHERE (lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?) OR (max_lat >= ? AND min_lat <= ? AND max_lon >= ? AND min_lon <= ?) LIMIT 5000",
            )
            .bind(s, n, w, e, s, n, w, e)
            .all<{ id: string }>();
        return new Set(rows.results.map((r) => r.id));
    }
    return null;
}

export async function situationTimeline(
    env: Env,
    scope: { watch: WatchArea | null; region: RegionId | null },
    hours: number,
    now = new Date(),
): Promise<SituationTimeline> {
    const db = env.DB;
    const from = new Date(now.getTime() - hours * HOUR).toISOString();
    const to = now.toISOString();
    const ids = await scopeRecordIds(db, scope);
    const changes = (await listChanges(db, { since: from, limit: 3000 })).filter((c) => (ids ? !c.recordId || ids.has(c.recordId) : true));
    const events = changes.filter((c) => c.kind !== "updated" || c.severityRank >= 1).map(changeEvent);
    events.push(...(await sourceGaps(db, from, to)).map(gapEvent));
    events.sort((a, b) => b.at.localeCompare(a.at));
    const notes = [
        "Changes are detected by comparing each collection with the one before, at collection time. Routine updates without a level are left out.",
        "A record missing from a feed is shown as such, never as resolved.",
    ];
    if (scope.watch) notes.push("Matched to the watch area by each record's current location as published.");
    if (scope.region) notes.push(regionById(scope.region)?.note ?? "");
    const { settings } = await loadCentreSettings(db);
    if (hours > settings.retention.changeDays * 24) notes.push(`Changes are kept for ${settings.retention.changeDays} days.`);
    return {
        scopeLabel: scope.watch ? scope.watch.name : scope.region ? (regionById(scope.region)?.label ?? "NSW") : "New South Wales",
        from,
        to,
        events: events.slice(0, 500),
        truncated: events.length > 500,
        notes: notes.filter(Boolean),
    };
}

// --- Replay --------------------------------------------------------------------------------------------

async function replaySourceStates(db: D1Database, at: string, startedAt: string | null): Promise<ReplaySourceState[]> {
    const [runs, daily, firsts, rows] = await Promise.all([
        db
            .prepare("SELECT source_id, MAX(started_at) AS last FROM ic_fetch_runs WHERE outcome IN ('ok', 'unchanged') AND started_at <= ? GROUP BY source_id")
            .bind(at)
            .all<{ source_id: string; last: string | null }>(),
        db
            .prepare("SELECT source_id, MAX(last_success_at) AS last FROM ic_source_daily WHERE day <= ? AND last_success_at <= ? GROUP BY source_id")
            .bind(at.slice(0, 10), at)
            .all<{ source_id: string; last: string | null }>(),
        db.prepare("SELECT source_id, MIN(valid_from) AS first FROM ic_record_versions GROUP BY source_id").all<{ source_id: string; first: string }>(),
        sourceRows(db),
    ]);
    const last = new Map<string, string>();
    for (const r of [...runs.results, ...daily.results])
        if (r.last && (!last.has(r.source_id) || r.last > last.get(r.source_id)!)) last.set(r.source_id, r.last);
    const first = new Map(firsts.results.map((r) => [r.source_id, r.first]));
    return IMPLEMENTED_SOURCES.filter((s) => rows.get(s.id)?.enabled || last.has(s.id) || first.has(s.id)).map((s) => {
        const lastSuccessBefore = last.get(s.id) ?? null;
        const base = { sourceId: s.id, dataset: s.dataset, provider: s.provider, lastSuccessBefore };
        if (!s.history) return { ...base, state: "unknown" as const, note: "Its terms don't allow keeping history, so it isn't part of replay." };
        if (!lastSuccessBefore)
            return first.get(s.id) && at < first.get(s.id)!
                ? { ...base, state: "before_history" as const, note: `History for this source begins ${when(first.get(s.id)!)}.` }
                : { ...base, state: "not_collected" as const, note: "Not collected before this moment." };
        const age = Date.parse(at) - Date.parse(lastSuccessBefore);
        if (age > s.staleAfterMinutes * 60_000)
            return {
                ...base,
                state: "stale" as const,
                note: `Not retrieved for ${minutesLabel(Math.round(age / 60_000))} at this moment: what's shown from it may be out of date.`,
            };
        if (startedAt && at < startedAt) return { ...base, state: "before_history" as const, note: "Before history recording began." };
        return { ...base, state: "current" as const, note: `Last retrieved ${when(lastSuccessBefore)}.` };
    });
}

export interface ReplayOptions {
    bbox?: BBox | null;
    watch?: WatchArea | null;
    layers?: MapLayer[] | null;
    includeInactive?: boolean;
    limit?: number;
    map?: boolean;
}

/** Versions in force at a moment, as stored then. */
async function versionsAt(db: D1Database, at: string, options: ReplayOptions): Promise<{ rows: VersionRow[]; truncated: boolean }> {
    const where = ["valid_from <= ?", "(valid_to IS NULL OR valid_to > ?)"];
    const binds: unknown[] = [at, at];
    if (!options.includeInactive) where.push("active = 1");
    if (options.bbox) {
        const [w, s, e, n] = options.bbox;
        where.push("((lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?) OR (max_lat >= ? AND min_lat <= ? AND max_lon >= ? AND min_lon <= ?) OR lat IS NULL)");
        binds.push(s, n, w, e, s, n, w, e);
    }
    const limit = Math.min(options.limit ?? 1500, 3000);
    const rows = await db
        .prepare(`SELECT * FROM ic_record_versions WHERE ${where.join(" AND ")} ORDER BY severity_rank DESC, valid_from DESC LIMIT ?`)
        .bind(...binds, limit + 1)
        .all<VersionRow>();
    return { rows: rows.results.slice(0, limit), truncated: rows.results.length > limit };
}

export async function replayFrame(env: Env, at: Date, options: ReplayOptions = {}): Promise<ReplayFrame> {
    const db = env.DB;
    const iso = at.toISOString();
    const [startedAt, { settings }] = await Promise.all([historyStartedAt(db), loadCentreSettings(db)]);
    const { rows, truncated } = await versionsAt(db, iso, options);
    let chosen = rows;
    const hashes = rows.filter((r) => r.geometry_hash).map((r) => r.geometry_hash!);
    const geometries = await geometriesByHash(db, hashes);
    if (options.watch) {
        const context = await matchContextFor(db, options.watch);
        chosen = rows.filter((v) =>
            matchWatch(
                options.watch!,
                asRecord(v),
                v.geometry_hash ? parseJson<Geometry | null>(geometries.get(v.geometry_hash) ?? null, null) : null,
                context,
            ),
        );
    }
    if (options.layers?.length) chosen = chosen.filter((v) => options.layers!.includes(layerOf({ category: v.category, kind: v.kind, sourceId: v.source_id })));
    const records = chosen.map(toReplayRecord);
    const areas = new Map<string, Geometry>();
    if (options.map !== false)
        for (const v of chosen) {
            const area = v.geometry_hash ? screenArea(geometries.get(v.geometry_hash) ?? null) : null;
            if (area) areas.set(v.record_id, area);
        }
    const map =
        options.map === false
            ? { type: "FeatureCollection" as const, features: [] }
            : buildFeatures(
                  chosen.map((v) => ({ ...asRecord(v), id: v.record_id })),
                  areas,
              );
    const sources = await replaySourceStates(db, iso, startedAt);
    const notes: string[] = [];
    if (!startedAt) notes.push("History recording hasn't stored anything yet, so there's nothing to replay.");
    else if (iso < startedAt) notes.push(`History recording began ${when(startedAt)}. Nothing earlier can be replayed.`);
    const oldest = await db.prepare("SELECT MIN(valid_from) AS at FROM ic_record_versions").first<{ at: string | null }>();
    if (oldest?.at && startedAt && oldest.at > startedAt && iso < oldest.at)
        notes.push(`Versions older than ${settings.retention.versionDays} days have been removed (retention), so this moment may be incomplete.`);
    const stale = sources.filter((s) => s.state === "stale");
    if (stale.length)
        notes.push(
            `${stale.length} ${stale.length === 1 ? "source wasn't" : "sources weren't"} up to date at this moment: ${stale.map((s) => s.dataset).join("; ")}.`,
        );
    if (records.some((r) => r.baseline))
        notes.push("Records marked baseline were already in their feed when first recorded; their earlier states weren't kept.");
    notes.push("Observations (weather, rivers, air) and satellite detections aren't replayed as records: see their charts and the record timelines.");
    return { at: iso, records, map, sources, truncated, notes, historyStartedAt: startedAt };
}

export async function replayMeta(env: Env, from: Date, to: Date): Promise<ReplayMeta> {
    const db = env.DB;
    const [startedAt, { settings }, recording] = await Promise.all([
        historyStartedAt(db),
        loadCentreSettings(db),
        isEnabled(db, "intelligence_centre.history"),
    ]);
    const steps = await db
        .prepare(
            "SELECT substr(valid_from, 1, 16) AS minute, MIN(valid_from) AS at, COUNT(*) AS n FROM ic_record_versions WHERE valid_from BETWEEN ? AND ? GROUP BY minute ORDER BY minute LIMIT 601",
        )
        .bind(from.toISOString(), to.toISOString())
        .all<{ minute: string; at: string; n: number }>();
    const oldest = await db.prepare("SELECT MIN(valid_from) AS at FROM ic_record_versions").first<{ at: string | null }>();
    const gaps = await sourceGaps(db, from.toISOString(), to.toISOString());
    return {
        historyStartedAt: startedAt,
        oldestRetained: oldest?.at ?? null,
        steps: steps.results.slice(0, 600).map((s) => ({ at: s.at, changes: s.n })),
        truncated: steps.results.length > 600,
        gaps: gaps.map((g) => ({ sourceId: g.sourceId, from: g.from, to: g.to })),
        retentionDays: settings.retention.versionDays,
        recording,
    };
}

const COMPARED: (keyof ReplayRecord)[] = ["warningLevel", "status", "title", "areaName", "active", "missing", "lat", "lon"];

export async function replayCompare(env: Env, a: Date, b: Date, options: ReplayOptions = {}): Promise<ReplayComparison> {
    const [first, second] = await Promise.all([replayFrame(env, a, { ...options, map: false }), replayFrame(env, b, { ...options, map: false })]);
    const before = new Map(first.records.map((r) => [r.id, r]));
    const after = new Map(second.records.map((r) => [r.id, r]));
    const changed: ReplayComparison["changed"] = [];
    let unchanged = 0;
    for (const [id, r] of after) {
        const old = before.get(id);
        if (!old) continue;
        const fields = COMPARED.filter((f) => old[f] !== r[f]);
        if (old.versionSeq !== r.versionSeq && !fields.length) fields.push("updatedAt");
        if (fields.length) changed.push({ before: old, after: r, fields });
        else unchanged++;
    }
    return {
        a: first.at,
        b: second.at,
        added: [...after.values()].filter((r) => !before.has(r.id)),
        removed: [...before.values()].filter((r) => !after.has(r.id)),
        changed,
        unchanged,
        notes: [...new Set([...first.notes, ...second.notes])],
    };
}

// --- What's changed ------------------------------------------------------------------------------------

interface FeedRow {
    id: string;
    record_id: string | null;
    source_id: string;
    kind: ChangeKind;
    at: string;
    from_value: string | null;
    to_value: string | null;
    summary: string;
    severity_rank: number;
    category: HazardCategory | null;
    title: string | null;
    warning_level: string | null;
    source_url: string | null;
    area_name: string | null;
}

export async function changeFeed(
    env: Env,
    filters: FeedFilters & { watchArea?: WatchArea | null },
    limit = 300,
): Promise<{ changes: FeedChange[]; truncated: boolean; counts: { significant: number; routine: number } }> {
    const db = env.DB;
    const where = ["c.at >= ?", "c.at <= ?"];
    const binds: unknown[] = [filters.from, filters.to];
    if (filters.hazard) {
        where.push("(r.category = ? OR c.record_id IS NULL)");
        binds.push(filters.hazard);
    }
    if (filters.source) {
        where.push("c.source_id = ?");
        binds.push(filters.source);
    }
    if (filters.minLevel) {
        where.push("c.severity_rank >= ?");
        binds.push(filters.minLevel);
    }
    const group = FEED_CHANGE_GROUPS.find((g) => g.id === filters.group);
    if (group) {
        where.push(`c.kind IN (${group.kinds.map(() => "?").join(",")})`);
        binds.push(...group.kinds);
    }
    const region = filters.region && filters.region !== "nsw" && filters.region !== "australia" ? regionById(filters.region) : null;
    if (region) {
        const [w, s, e, n] = region.bbox;
        where.push(
            "((r.lat BETWEEN ? AND ? AND r.lon BETWEEN ? AND ?) OR (r.max_lat >= ? AND r.min_lat <= ? AND r.max_lon >= ? AND r.min_lon <= ?) OR c.record_id IS NULL)",
        );
        binds.push(s, n, w, e, s, n, w, e);
    }
    const rows = await db
        .prepare(
            `SELECT c.*, r.category, r.title, r.warning_level, r.source_url, r.area_name FROM ic_changes c LEFT JOIN ic_records r ON r.id = c.record_id
             WHERE ${where.join(" AND ")} ORDER BY c.at DESC LIMIT 5000`,
        )
        .bind(...binds)
        .all<FeedRow>();
    const ids = filters.watchArea ? await scopeRecordIds(db, { watch: filters.watchArea, region: null }) : null;
    const all = rows.results
        .filter((r) => !ids || !r.record_id || ids.has(r.record_id))
        .map((r): FeedChange => {
            const change: CentreChange = {
                id: r.id,
                recordId: r.record_id,
                sourceId: r.source_id,
                kind: r.kind,
                at: r.at,
                fromValue: r.from_value,
                toValue: r.to_value,
                summary: r.summary,
                severityRank: r.severity_rank,
                category: r.category,
                title: r.title,
            };
            return {
                ...change,
                label: feedLabel(change),
                significant: isSignificant(change),
                provider: sourceById(r.source_id)?.provider ?? r.source_id,
                level: r.warning_level,
                sourceUrl: r.source_url,
                areaName: r.area_name,
            };
        });
    const counts = { significant: all.filter((c) => c.significant).length, routine: all.filter((c) => !c.significant).length };
    const shown = filters.significance === "significant" ? all.filter((c) => c.significant) : all;
    return { changes: shown.slice(0, limit), truncated: shown.length > limit || rows.results.length >= 5000, counts };
}

// --- Source reliability ------------------------------------------------------------------------------

interface DailyRow {
    source_id: string;
    day: string;
    attempts: number;
    ok: number;
    unchanged: number;
    errors: number;
    rejected: number;
    total_ms: number;
    records_max: number;
    delay_total_s: number;
    delay_count: number;
    delay_max_s: number;
    last_success_at: string | null;
    longest_gap_minutes: number;
}

export async function sourceReliability(db: D1Database, days = 30, now = new Date()): Promise<SourceReliability[]> {
    const since = new Date(now.getTime() - days * DAY).toISOString().slice(0, 10);
    const [daily, rows] = await Promise.all([
        db.prepare("SELECT * FROM ic_source_daily WHERE day >= ? ORDER BY source_id, day LIMIT 20000").bind(since).all<DailyRow>(),
        sourceRows(db),
    ]);
    const bySource = new Map<string, DailyRow[]>();
    for (const r of daily.results) bySource.set(r.source_id, [...(bySource.get(r.source_id) ?? []), r]);
    return IMPLEMENTED_SOURCES.filter((s) => bySource.has(s.id) || rows.get(s.id)?.enabled).map((s) => {
        const list = bySource.get(s.id) ?? [];
        const sum = (f: (r: DailyRow) => number) => list.reduce((n, r) => n + f(r), 0);
        const attempts = sum((r) => r.attempts);
        const good = sum((r) => r.ok + r.unchanged);
        const delays = sum((r) => r.delay_count);
        const row = rows.get(s.id);
        return {
            sourceId: s.id,
            provider: s.provider,
            dataset: s.dataset,
            days: list.map((r) => ({
                date: r.day,
                attempts: r.attempts,
                ok: r.ok + r.unchanged,
                errors: r.errors + r.rejected,
                availability: r.attempts ? Math.round(((r.ok + r.unchanged) / r.attempts) * 1000) / 10 : null,
                avgMs: r.attempts ? Math.round(r.total_ms / r.attempts) : null,
                delayS: r.delay_count ? Math.round(r.delay_total_s / r.delay_count) : null,
                recordsMax: r.records_max,
                longestGapMinutes: r.longest_gap_minutes,
            })),
            availability: attempts ? Math.round((good / attempts) * 1000) / 10 : null,
            avgMs: attempts ? Math.round(sum((r) => r.total_ms) / attempts) : null,
            avgDelayS: delays ? Math.round(sum((r) => r.delay_total_s) / delays) : null,
            maxDelayS: list.length ? Math.max(...list.map((r) => r.delay_max_s)) || null : null,
            consecutiveFailures: row?.consecutive_failures ?? 0,
            lastValidatedAt: row?.last_success_at ?? null,
            longestGapMinutes: list.length ? Math.max(...list.map((r) => r.longest_gap_minutes)) : 0,
        };
    });
}

// --- Analytics -------------------------------------------------------------------------------------------

const CACHE_MINUTES = 15;

export async function cached<T>(db: D1Database, key: string, minutes: number, compute: () => Promise<T>, now = new Date()): Promise<T> {
    const row = await db.prepare("SELECT value FROM ic_cache WHERE key = ? AND expires_at > ?").bind(key, now.toISOString()).first<{ value: string }>();
    if (row) return JSON.parse(row.value) as T;
    const value = await compute();
    const json = JSON.stringify(value);
    if (json.length <= 400_000)
        await db
            .prepare(
                "INSERT INTO ic_cache (key, value, computed_at, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, computed_at = excluded.computed_at, expires_at = excluded.expires_at",
            )
            .bind(key, json, now.toISOString(), new Date(now.getTime() + minutes * 60_000).toISOString())
            .run();
    return value;
}

const dayList = (from: Date, days: number) => Array.from({ length: days }, (_, i) => new Date(from.getTime() + i * DAY).toISOString().slice(0, 10));

export async function centreAnalytics(env: Env, days: number, now = new Date()): Promise<CentreAnalytics> {
    return cached(env.DB, `analytics:${days}:${now.toISOString().slice(0, 15)}`, CACHE_MINUTES, () => computeAnalytics(env, days, now), now);
}

async function computeAnalytics(env: Env, days: number, now: Date): Promise<CentreAnalytics> {
    const db = env.DB;
    const start = new Date(now.getTime() - (days - 1) * DAY);
    start.setUTCHours(0, 0, 0, 0);
    const from = start.toISOString();
    const dates = dayList(start, days);
    const [news, transitions, firstSeen, eventTypes, changes, weather, gauges] = await Promise.all([
        db
            .prepare(
                `SELECT substr(c.at, 1, 10) AS day, COALESCE(r.category, 'emergency') AS category, COUNT(*) AS n FROM ic_changes c LEFT JOIN ic_records r ON r.id = c.record_id
                 WHERE c.kind = 'new' AND c.at >= ? GROUP BY day, category`,
            )
            .bind(from)
            .all<{ day: string; category: HazardCategory; n: number }>(),
        db
            .prepare(
                "SELECT substr(at, 1, 10) AS day, kind, COUNT(*) AS n FROM ic_changes WHERE kind IN ('escalated', 'downgraded') AND at >= ? GROUP BY day, kind",
            )
            .bind(from)
            .all<{ day: string; kind: string; n: number }>(),
        db
            .prepare("SELECT category, lat, lon FROM ic_records WHERE first_seen_at >= ? AND kind IN ('incident', 'warning', 'disruption') LIMIT 20000")
            .bind(from)
            .all<{ category: HazardCategory; lat: number | null; lon: number | null }>(),
        db
            .prepare(
                "SELECT event_type, COUNT(*) AS n FROM ic_records WHERE first_seen_at >= ? AND kind IN ('incident', 'warning', 'disruption') AND event_type IS NOT NULL GROUP BY event_type ORDER BY n DESC LIMIT 12",
            )
            .bind(from)
            .all<{ event_type: string; n: number }>(),
        db
            .prepare(
                "SELECT c.kind, c.at, c.severity_rank, c.to_value, r.category FROM ic_changes c LEFT JOIN ic_records r ON r.id = c.record_id WHERE c.at >= ? LIMIT 50000",
            )
            .bind(from)
            .all<{ kind: ChangeKind; at: string; severity_rank: number; to_value: string | null; category: HazardCategory | null }>(),
        db
            .prepare(
                "SELECT substr(at, 1, 10) AS day, metric, MAX(value) AS value FROM ic_series WHERE metric IN ('air_temperature', 'gust_kmh', 'rainfall') AND at >= ? GROUP BY day, metric",
            )
            .bind(from)
            .all<{ day: string; metric: string; value: number }>(),
        db.prepare("SELECT id, title FROM ic_records WHERE source_id = 'bom-water' ORDER BY title LIMIT 12").all<{ id: string; title: string }>(),
    ]);
    const series = (key: string, label: string, values: Map<string, number>): AnalyticsSeries => ({
        key,
        label,
        points: dates.map((date) => ({ date, value: values.get(date) ?? 0 })),
    });
    const categories = [...new Set(news.results.map((r) => r.category))];
    const newRecords = categories.map((c) =>
        series(c, CATEGORY_LABELS[c] ?? c, new Map(news.results.filter((r) => r.category === c).map((r) => [r.day, r.n]))),
    );
    const transitionSeries = ["escalated", "downgraded"].map((k) =>
        series(k, k === "escalated" ? "Escalations" : "Downgrades", new Map(transitions.results.filter((r) => r.kind === k).map((r) => [r.day, r.n]))),
    );
    const byCategory = new Map<HazardCategory, number>();
    for (const r of firstSeen.results) byCategory.set(r.category, (byCategory.get(r.category) ?? 0) + 1);
    const byRegion = REGIONS.filter((r) => r.id !== "nsw" && r.id !== "australia").map((region) => {
        const [w, s, e, n] = region.bbox;
        return {
            region: region.id,
            label: region.label,
            count: firstSeen.results.filter((r) => r.lat !== null && r.lon !== null && r.lon >= w && r.lon <= e && r.lat >= s && r.lat <= n).length,
        };
    });
    const significantByDay = new Map<string, number>();
    for (const c of changes.results)
        if (isSignificant({ kind: c.kind, category: c.category, severityRank: c.severity_rank, toValue: c.to_value }))
            significantByDay.set(c.at.slice(0, 10), (significantByDay.get(c.at.slice(0, 10)) ?? 0) + 1);
    const weatherSeries = [
        ["air_temperature", "Highest temperature (°C)"],
        ["gust_kmh", "Strongest gust (km/h)"],
        ["rainfall", "Most rain since 9 am (mm)"],
    ].map(([metric, label]) => series(metric, label, new Map(weather.results.filter((r) => r.metric === metric).map((r) => [r.day, r.value]))));
    const rivers = [];
    for (const g of gauges.results) {
        const points = (
            await db
                .prepare("SELECT at, value FROM ic_series WHERE record_id = ? AND metric = 'water_level' AND at >= ? ORDER BY at LIMIT 2000")
                .bind(g.id, from)
                .all<{ at: string; value: number }>()
        ).results;
        if (points.length) rivers.push({ recordId: g.id, label: g.title, points });
    }
    const reliability = await sourceReliability(db, days, now);
    const { settings } = await loadCentreSettings(db);
    const caveats = [
        "These are counts of what the Centre collected from the sources that were switched on, not complete or official statistics for NSW.",
        "A source switched off, failing or added part-way through the period undercounts it; the coverage table shows how many days each source was collected.",
        "Regions are approximate rectangles and overlap; a record can count towards more than one.",
        `Records removed by retention (${settings.retention.recordDays} days after they're no longer current) and changes older than ${settings.retention.changeDays} days aren't counted.`,
        "Weather values are the highest single readings collected each day, not averages or official climate statistics.",
        "Nothing here is a forecast or a risk score.",
    ];
    return {
        range: { from, to: now.toISOString(), days },
        computedAt: nowIso(),
        newRecords,
        transitions: transitionSeries,
        byCategory: [...byCategory]
            .map(([category, count]) => ({ category, label: CATEGORY_LABELS[category] ?? category, count }))
            .sort((a, b) => b.count - a.count),
        byRegion: byRegion.sort((a, b) => b.count - a.count),
        byEventType: eventTypes.results.map((r) => ({ eventType: r.event_type, count: r.n })),
        significantChanges: series("significant", "Significant changes", significantByDay),
        rivers,
        weather: weatherSeries,
        sources: reliability,
        caveats,
        coverage: reliability.map((r) => ({
            sourceId: r.sourceId,
            dataset: `${r.provider}: ${r.dataset}`,
            daysCollected: r.days.filter((d) => d.ok > 0).length,
            daysInRange: days,
        })),
    };
}
