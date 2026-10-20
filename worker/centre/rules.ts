// Monitoring rules (docs/INTELLIGENCE_CENTRE_9_1.md#monitoring-rules).
//
// A rule is a person's own condition over the records the Centre already collected. Evaluation is
// deterministic, runs after collection (intelligence_centre.rules) and records why each match
// happened. Each subject matches a rule once (the unique dedupe key makes evaluation idempotent):
// an official record per level it reaches, a reading per crossing of the threshold, a source per
// outage. A cooldown and an hourly limit keep notifications low; matches inside them are still
// recorded, marked as not notified. Rules name a watch area for anything geographic, so no rule
// holds coordinates of its own, and nothing about a rule's area is logged or audited.
import type { D1Database } from "@cloudflare/workers-types";
import type {
    MonitoringRule,
    RuleDefinition,
    RuleInput,
    RuleMatch,
    RuleTestMatch,
    RuleTestResult,
} from "../../src/shared/centre/rules";
import { CONDITION_META, MAX_RULES, gustKmh, ruleInputSchema } from "../../src/shared/centre/rules";
import { sourceById } from "../../src/shared/centre/sources";
import type { CentreRecord, WatchArea } from "../../src/shared/centre/types";
import { WARNING_LEVELS } from "../../src/shared/centre/types";
import type { PortalUser } from "../../src/shared/portal/types";
import type { Env } from "../env";
import { can, userForEmail } from "../portal/auth";
import { auditStatement, newId, nowIso, parseJson } from "../portal/db";
import { HttpError } from "../portal/http";
import { createTask } from "../tasks/tasks";
import { type Geometry, type Position, distanceKm, distanceToAreaKm, distanceToLineKm, expandBBox, pointInPolygon, polygonsOf, positions } from "./geo";
import { type VersionRow, sourceGaps, toReplayRecord } from "./history";
import { RECORD_COLUMNS, type RecordRow, loadPreferences, sourceRows, toRecord } from "./store";
import { fireDistricts, matchContextFor, matchWatch, requireWatch, watchBBox } from "./watch";

const MINUTE = 60_000;
/** Rule notifications per person per hour; the rest are recorded but stay quiet. */
const MAX_NOTIFICATIONS_PER_HOUR = 20;
/** Rules evaluated in one cron run. */
const MAX_RULES_PER_RUN = 200;

const sydneyDate = (iso: string | null) =>
    iso ? new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso)) : "unknown";
const when = (iso: string | null) =>
    iso
        ? new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Sydney", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(
              new Date(iso),
          )
        : "time not given";

// --- Reading and writing ------------------------------------------------------------------------------

interface RuleRow {
    id: string;
    email: string;
    name: string;
    condition: RuleDefinition["condition"];
    definition: string;
    watch_id: string | null;
    lookback_minutes: number;
    cooldown_minutes: number;
    notify: RuleInput["notify"];
    enabled: number;
    version: number;
    last_evaluated_at: string | null;
    last_matched_at: string | null;
    created_at: string;
    updated_at: string;
    matches7d?: number;
}

const toRule = (row: RuleRow): MonitoringRule => ({
    id: row.id,
    name: row.name,
    definition: parseJson<RuleDefinition>(row.definition, { condition: "source_stale", sourceId: "rfs-incidents", minutes: null }),
    lookbackMinutes: row.lookback_minutes,
    cooldownMinutes: row.cooldown_minutes,
    notify: row.notify,
    enabled: row.enabled === 1,
    version: row.version,
    lastEvaluatedAt: row.last_evaluated_at,
    lastMatchedAt: row.last_matched_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    matches7d: row.matches7d ?? 0,
});

export async function listRules(db: D1Database, email: string): Promise<MonitoringRule[]> {
    const rows = await db
        .prepare(
            `SELECT r.*, (SELECT COUNT(*) FROM ic_rule_matches m WHERE m.rule_id = r.id AND m.at >= ?) AS matches7d
             FROM ic_rules r WHERE r.email = ? ORDER BY r.name COLLATE NOCASE`,
        )
        .bind(new Date(Date.now() - 7 * 86_400_000).toISOString(), email)
        .all<RuleRow>();
    return rows.results.map(toRule);
}

export async function requireRule(db: D1Database, email: string, id: string): Promise<MonitoringRule> {
    if (!/^icu_[a-z0-9]{14}$/.test(id)) throw new HttpError(404, "not_found", "Not found");
    const row = await db.prepare("SELECT * FROM ic_rules WHERE id = ? AND email = ?").bind(id, email).first<RuleRow>();
    if (!row) throw new HttpError(404, "not_found", "Not found");
    return toRule(row);
}

const watchOf = (d: RuleDefinition): string | null => ("watchId" in d ? d.watchId : null);

/** Validates a rule against the caller's own watch areas and the Centre's sources and districts. */
async function checkInput(db: D1Database, user: PortalUser, body: unknown): Promise<RuleInput> {
    const input = ruleInputSchema.parse(body);
    const d = input.definition;
    const watchId = watchOf(d);
    if (watchId) {
        const watch = await requireWatch(db, user.email, watchId);
        if (!watchBBox(watch.definition) && d.condition !== "road_on_corridor")
            throw new HttpError(422, "validation", "Choose a watch area with a location (a place, drawn area, region or corridor)");
        if (d.condition === "road_on_corridor" && !watchBBox(watch.definition)) throw new HttpError(422, "validation", "Choose a corridor or another area with a location");
    }
    if (d.condition === "source_stale") {
        const source = sourceById(d.sourceId);
        if (!source?.implemented) throw new HttpError(422, "validation", "Choose a source the Centre collects");
    }
    if (d.condition === "total_fire_ban") {
        const districts = await fireDistricts(db);
        if (districts.length && !districts.includes(d.district)) throw new HttpError(422, "validation", "Choose a fire weather district from the list");
    }
    if (input.notify === "email" && input.cooldownMinutes < 30) throw new HttpError(422, "validation", "Email notifications need a cooldown of at least 30 minutes");
    return input;
}

const ruleValues = (input: RuleInput) => [
    input.name,
    input.definition.condition,
    JSON.stringify(input.definition),
    watchOf(input.definition),
    input.lookbackMinutes,
    input.cooldownMinutes,
    input.notify,
    input.enabled ? 1 : 0,
];

export async function createRule(db: D1Database, user: PortalUser, body: unknown, via: "portal" | "mcp" = "portal"): Promise<MonitoringRule> {
    const input = await checkInput(db, user, body);
    const count = await db.prepare("SELECT COUNT(*) AS n FROM ic_rules WHERE email = ?").bind(user.email).first<{ n: number }>();
    if ((count?.n ?? 0) >= MAX_RULES) throw new HttpError(422, "validation", `You can have up to ${MAX_RULES} monitoring rules`);
    const id = newId("icu");
    const now = nowIso();
    await db.batch([
        db
            .prepare(
                `INSERT INTO ic_rules (id, email, name, condition, definition, watch_id, lookback_minutes, cooldown_minutes, notify, enabled, version, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
            )
            .bind(id, user.email, ...ruleValues(input), now, now),
        // Ids and the condition only: a rule's name and area can say where someone lives.
        auditStatement(db, {
            actor: user.email,
            action: "centre.rule.create",
            entityType: "centre_rule",
            entityId: id,
            summary: `Created a ${input.definition.condition} monitoring rule${via === "mcp" ? " through MCP" : ""}`,
        }),
    ]);
    return requireRule(db, user.email, id);
}

export async function updateRule(db: D1Database, user: PortalUser, id: string, body: unknown, via: "portal" | "mcp" = "portal"): Promise<MonitoringRule> {
    const { version, ...rest } = (body ?? {}) as { version?: unknown };
    if (typeof version !== "number") throw new HttpError(422, "validation", "Send the version you edited");
    await requireRule(db, user.email, id);
    const input = await checkInput(db, user, rest);
    const [result] = await db.batch([
        db
            .prepare(
                `UPDATE ic_rules SET name = ?, condition = ?, definition = ?, watch_id = ?, lookback_minutes = ?, cooldown_minutes = ?, notify = ?, enabled = ?,
                    version = version + 1, updated_at = ? WHERE id = ? AND email = ? AND version = ?`,
            )
            .bind(...ruleValues(input), nowIso(), id, user.email, version),
        auditStatement(db, {
            actor: user.email,
            action: "centre.rule.update",
            entityType: "centre_rule",
            entityId: id,
            summary: `Changed a monitoring rule${via === "mcp" ? " through MCP" : ""}`,
        }),
    ]);
    if (!result.meta.changes) throw new HttpError(409, "conflict", "This rule was changed elsewhere. Reload and try again.");
    return requireRule(db, user.email, id);
}

export async function deleteRule(db: D1Database, user: PortalUser, id: string) {
    await requireRule(db, user.email, id);
    await db.batch([
        db.prepare("DELETE FROM ic_rule_matches WHERE rule_id = ? AND email = ?").bind(id, user.email),
        db.prepare("DELETE FROM ic_rules WHERE id = ? AND email = ?").bind(id, user.email),
        auditStatement(db, { actor: user.email, action: "centre.rule.delete", entityType: "centre_rule", entityId: id, summary: "Deleted a monitoring rule" }),
    ]);
}

interface MatchRow {
    id: string;
    rule_id: string;
    rule_name: string | null;
    at: string;
    record_id: string | null;
    source_id: string | null;
    reason: string;
    observed_value: number | null;
    threshold: number | null;
    unit: string | null;
    evidence_at: string | null;
    notified: number;
    suppressed: RuleMatch["suppressed"];
    task_id: string | null;
    acknowledged_at: string | null;
}

const toMatch = (r: MatchRow): RuleMatch => ({
    id: r.id,
    ruleId: r.rule_id,
    ruleName: r.rule_name ?? "Deleted rule",
    at: r.at,
    recordId: r.record_id,
    sourceId: r.source_id,
    reason: r.reason,
    observedValue: r.observed_value,
    threshold: r.threshold,
    unit: r.unit,
    evidenceAt: r.evidence_at,
    notified: r.notified === 1,
    suppressed: r.suppressed,
    taskId: r.task_id,
    acknowledgedAt: r.acknowledged_at,
});

export async function listMatches(
    db: D1Database,
    email: string,
    options: { ruleId?: string; limit?: number; open?: boolean; since?: string } = {},
): Promise<RuleMatch[]> {
    const where = ["m.email = ?"];
    const binds: unknown[] = [email];
    if (options.ruleId) {
        where.push("m.rule_id = ?");
        binds.push(options.ruleId);
    }
    if (options.open) where.push("m.acknowledged_at IS NULL");
    if (options.since) {
        where.push("m.at >= ?");
        binds.push(options.since);
    }
    const rows = await db
        .prepare(
            `SELECT m.*, r.name AS rule_name FROM ic_rule_matches m LEFT JOIN ic_rules r ON r.id = m.rule_id AND r.email = m.email
             WHERE ${where.join(" AND ")} ORDER BY m.at DESC LIMIT ?`,
        )
        .bind(...binds, options.limit ?? 100)
        .all<MatchRow>();
    return rows.results.map(toMatch);
}

export async function requireMatch(db: D1Database, email: string, id: string): Promise<RuleMatch> {
    if (!/^icm_[a-z0-9]{14}$/.test(id)) throw new HttpError(404, "not_found", "Not found");
    const row = await db
        .prepare("SELECT m.*, r.name AS rule_name FROM ic_rule_matches m LEFT JOIN ic_rules r ON r.id = m.rule_id WHERE m.id = ? AND m.email = ?")
        .bind(id, email)
        .first<MatchRow>();
    if (!row) throw new HttpError(404, "not_found", "Not found");
    return toMatch(row);
}

export async function acknowledgeMatches(db: D1Database, user: PortalUser, ids: string[] | "all") {
    const now = nowIso();
    if (ids === "all") {
        await db.prepare("UPDATE ic_rule_matches SET acknowledged_at = ? WHERE email = ? AND acknowledged_at IS NULL").bind(now, user.email).run();
        await db.prepare("UPDATE ic_alerts SET acknowledged_at = ? WHERE email = ? AND kind = 'rule_match' AND acknowledged_at IS NULL").bind(now, user.email).run();
        return;
    }
    for (const id of ids.filter((x) => /^icm_[a-z0-9]{14}$/.test(x)).slice(0, 200)) {
        await db.batch([
            db.prepare("UPDATE ic_rule_matches SET acknowledged_at = COALESCE(acknowledged_at, ?) WHERE id = ? AND email = ?").bind(now, id, user.email),
            db.prepare("UPDATE ic_alerts SET acknowledged_at = COALESCE(acknowledged_at, ?) WHERE change_id = ? AND email = ?").bind(now, id, user.email),
        ]);
    }
}

// --- Geography ----------------------------------------------------------------------------------------

/** The watch area's own points: its centre, its drawn ring, or its route. */
function watchPoints(watch: WatchArea): { points: Position[]; slack: number } {
    const d = watch.definition;
    switch (d.kind) {
        case "point":
            return { points: [[d.lon, d.lat]], slack: d.radiusKm };
        case "polygon":
            return { points: d.ring, slack: 0 };
        case "region":
            return {
                points: [
                    [d.west, d.south],
                    [d.east, d.south],
                    [d.east, d.north],
                    [d.west, d.north],
                ],
                slack: 0,
            };
        case "corridor":
            return { points: d.line, slack: d.bufferKm };
        default:
            return { points: [], slack: 0 };
    }
}

/**
 * Distance from a record to the edge of a watch area (0 when it's inside or its published area
 * overlaps), or null when either has no location. Measured to the published area when there is one.
 */
export function distanceToWatchKm(watch: WatchArea, record: Pick<CentreRecord, "lat" | "lon">, geometry: Geometry | null): number | null {
    const d = watch.definition;
    const { points, slack } = watchPoints(watch);
    if (!points.length) return null;
    const point: Position | null = record.lat !== null && record.lon !== null ? [record.lon, record.lat] : null;
    const area = geometry && polygonsOf(geometry).length ? geometry : null;
    if (d.kind === "polygon" || d.kind === "region") {
        const ring: Position[] = d.kind === "polygon" ? d.ring : [...points, points[0]];
        if (point && pointInPolygon(point, [ring])) return 0;
        if (area && [...positions(area)].some((p) => pointInPolygon(p, [ring]))) return 0;
        if (area && ring.some((q) => polygonsOf(area).some((poly) => pointInPolygon(q, poly)))) return 0;
        const edge = (p: Position) => distanceToLineKm(p, ring);
        if (point) return edge(point);
        if (area) return Math.min(...[...positions(area)].slice(0, 2000).map(edge));
        return null;
    }
    if (d.kind === "corridor") {
        if (point) return Math.max(0, distanceToLineKm(point, d.line) - slack);
        if (area) return Math.max(0, Math.min(...d.line.map((q) => distanceToAreaKm(q, area))) - slack);
        return null;
    }
    const centre = points[0];
    if (area) return Math.max(0, distanceToAreaKm(centre, area) - slack);
    if (point) return Math.max(0, distanceKm(centre, point) - slack);
    return null;
}

// --- Evaluation ---------------------------------------------------------------------------------------

/** One way a rule matched: what, why, and the value against the person's threshold. */
export interface Candidate {
    dedupeKey: string;
    recordId: string | null;
    sourceId: string | null;
    reason: string;
    value: number | null;
    threshold: number | null;
    unit: string | null;
    evidenceAt: string | null;
    rank: number;
}

const levelName = (rank: number) => WARNING_LEVELS[rank - 1] ?? "a published level";

async function loadAround(db: D1Database, watch: WatchArea, radiusKm: number, where: string, binds: unknown[]) {
    const box = watchBBox(watch.definition);
    if (!box) return [];
    const b = expandBBox(box, radiusKm);
    const rows = await db
        .prepare(
            `SELECT ${RECORD_COLUMNS}, geometry FROM ic_records WHERE ${where}
             AND ((lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?) OR (max_lat >= ? AND min_lat <= ? AND max_lon >= ? AND min_lon <= ?)) LIMIT 3000`,
        )
        .bind(...binds, b[1], b[3], b[0], b[2], b[1], b[3], b[0], b[2])
        .all<RecordRow & { geometry: string | null }>();
    return rows.results.map((r) => ({ record: toRecord(r), geometry: r.geometry ? parseJson<Geometry | null>(r.geometry, null) : null }));
}

/** Points of a measurement that cross the threshold (from not meeting it to meeting it), each once. */
const crossings = (points: { at: string; value: number }[], meets: (v: number) => boolean) =>
    points.filter((p, i) => meets(p.value) && (i === 0 || !meets(points[i - 1].value)));

/** The current candidates for a rule, from records and readings as stored now. */
export async function candidatesFor(env: Env, owner: PortalUser, rule: Pick<MonitoringRule, "definition" | "lookbackMinutes">, now = new Date()): Promise<Candidate[]> {
    const db = env.DB;
    const d = rule.definition;
    const since = new Date(now.getTime() - rule.lookbackMinutes * MINUTE).toISOString();
    const out: Candidate[] = [];
    const watch = "watchId" in d ? await requireWatch(db, owner.email, d.watchId).catch(() => null) : null;
    if ("watchId" in d && !watch) return [];
    // A rule's own condition decides the hazard, not the watch area's alert categories.
    const anyHazard = watch ? { ...watch, categories: [] } : null;
    switch (d.condition) {
        case "official_level": {
            const context = await matchContextFor(db, anyHazard!);
            for (const { record, geometry } of await loadAround(db, anyHazard!, d.radiusKm, "active = 1 AND kind IN ('warning', 'incident') AND severity_rank >= ?", [d.minLevel])) {
                if (d.categories.length && !d.categories.includes(record.category)) continue;
                const time = record.updatedAt ?? record.publishedAt ?? record.firstSeenAt;
                if (time < since) continue;
                const inside = matchWatch(anyHazard!, record, geometry, context);
                const km = distanceToWatchKm(anyHazard!, record, geometry);
                if (!inside && (km === null || km > d.radiusKm)) continue;
                out.push({
                    dedupeKey: `${record.id}:${record.warningLevel}`,
                    recordId: record.id,
                    sourceId: record.sourceId,
                    reason: `${record.title}: ${record.warningLevel} as published by ${record.provider} (at or above ${levelName(d.minLevel)}). ${inside ?? `${km!.toFixed(1)} km from the watch area`}.`,
                    value: record.severityRank,
                    threshold: d.minLevel,
                    unit: null,
                    evidenceAt: time,
                    rank: record.severityRank,
                });
            }
            break;
        }
        case "fire_within": {
            for (const { record, geometry } of await loadAround(db, anyHazard!, d.radiusKm, "active = 1 AND kind = 'incident' AND category = 'fire'", [])) {
                if (d.notUnderControlOnly && /^under control$/i.test(record.status ?? "")) continue;
                const time = record.publishedAt ?? record.firstSeenAt;
                if (time < since) continue;
                const km = distanceToWatchKm(anyHazard!, record, geometry);
                if (km === null || km > d.radiusKm) continue;
                out.push({
                    dedupeKey: record.id,
                    recordId: record.id,
                    sourceId: record.sourceId,
                    reason: `${record.title} (${record.status ?? "status not given"}, ${record.provider}) is ${km === 0 ? "in the watch area" : `${km.toFixed(1)} km from it`}: within your ${d.radiusKm} km.`,
                    value: Math.round(km * 10) / 10,
                    threshold: d.radiusKm,
                    unit: "km",
                    evidenceAt: time,
                    rank: record.severityRank,
                });
            }
            break;
        }
        case "road_on_corridor": {
            const context = await matchContextFor(db, anyHazard!);
            for (const { record, geometry } of await loadAround(db, anyHazard!, 1, "active = 1 AND category = 'transport'", [])) {
                if (d.closuresOnly && record.attributes.closure !== "yes") continue;
                const time = record.publishedAt ?? record.firstSeenAt;
                if (time < since) continue;
                const reason = matchWatch(anyHazard!, record, geometry, context);
                if (!reason) continue;
                out.push({
                    dedupeKey: record.id,
                    recordId: record.id,
                    sourceId: record.sourceId,
                    reason: `${record.title} (${record.attributes.closure === "yes" ? "closure" : "hazard"}, Live Traffic NSW): ${reason}.`,
                    value: null,
                    threshold: null,
                    unit: null,
                    evidenceAt: time,
                    rank: record.attributes.closure === "yes" ? 2 : 1,
                });
            }
            break;
        }
        case "gauge_threshold": {
            const gauge = await db
                .prepare(`SELECT ${RECORD_COLUMNS} FROM ic_records WHERE source_id = 'bom-water' AND external_id = ?`)
                .bind(`gauge-${d.station}`)
                .first<RecordRow>();
            if (!gauge) break;
            const points = (
                await db
                    .prepare("SELECT at, value FROM ic_series WHERE record_id = ? AND metric = 'water_level' AND at >= ? ORDER BY at LIMIT 2000")
                    .bind(gauge.id, since)
                    .all<{ at: string; value: number }>()
            ).results;
            const meets = (v: number) => (d.direction === "above" ? v >= d.threshold : v <= d.threshold);
            for (const p of crossings(points, meets))
                out.push({
                    dedupeKey: `${gauge.id}:${p.at}`,
                    recordId: gauge.id,
                    sourceId: "bom-water",
                    reason: `${gauge.title}: ${p.value} m observed ${when(p.at)}, ${d.direction} your ${d.threshold} m (your threshold, not an official flood level).`,
                    value: p.value,
                    threshold: d.threshold,
                    unit: "m",
                    evidenceAt: p.at,
                    rank: 1,
                });
            break;
        }
        case "wind_gust":
        case "temperature": {
            const metric = d.condition === "wind_gust" ? "gust_kmh" : "air_temperature";
            const threshold = d.condition === "wind_gust" ? gustKmh(d.threshold, d.unit) : d.threshold;
            const direction = d.condition === "wind_gust" ? "above" : d.direction;
            const meets = (v: number) => (direction === "above" ? v >= threshold : v <= threshold);
            const context = await matchContextFor(db, anyHazard!);
            const stations = (await loadAround(db, anyHazard!, 0, "source_id = 'bom-observations' AND active = 1", [])).filter(
                ({ record }) => !!matchWatch(anyHazard!, record, null, context),
            );
            for (const { record } of stations.slice(0, 60)) {
                const points = (
                    await db
                        .prepare("SELECT at, value FROM ic_series WHERE record_id = ? AND metric = ? AND at >= ? ORDER BY at LIMIT 500")
                        .bind(record.id, metric, since)
                        .all<{ at: string; value: number }>()
                ).results;
                for (const p of crossings(points, meets))
                    out.push({
                        dedupeKey: `${record.id}:${metric}:${p.at}`,
                        recordId: record.id,
                        sourceId: "bom-observations",
                        reason:
                            d.condition === "wind_gust"
                                ? `${record.title}: a ${p.value} km/h gust observed ${when(p.at)}, at or above your ${d.threshold} ${d.unit}${d.unit === "kn" ? ` (${threshold} km/h)` : ""}. Your threshold, not an official warning threshold.`
                                : `${record.title}: ${p.value} °C observed ${when(p.at)}, ${direction === "above" ? "at or above" : "at or below"} your ${d.threshold} °C. Your threshold, not an official one.`,
                        value: p.value,
                        threshold,
                        unit: d.condition === "wind_gust" ? "km/h" : "°C",
                        evidenceAt: p.at,
                        rank: 1,
                    });
            }
            break;
        }
        case "total_fire_ban": {
            const rows = (
                await db
                    .prepare(`SELECT ${RECORD_COLUMNS} FROM ic_records WHERE source_id = 'rfs-fire-danger' AND active = 1 AND (title = ? OR json_extract(attrs, '$.district') = ?)`)
                    .bind(d.district, d.district)
                    .all<RecordRow>()
            ).results.map(toRecord);
            for (const r of rows) {
                const day = sydneyDate(r.publishedAt ?? r.updatedAt);
                for (const which of ["today", "tomorrow"] as const) {
                    if (d.when !== "either" && d.when !== which) continue;
                    if (r.attributes[which === "today" ? "banToday" : "banTomorrow"] !== "yes") continue;
                    out.push({
                        dedupeKey: `${r.id}:${which}:${day}`,
                        recordId: r.id,
                        sourceId: r.sourceId,
                        reason: `Total Fire Ban ${which} in ${r.title}, as the NSW RFS lists it (published ${when(r.publishedAt)}).`,
                        value: null,
                        threshold: null,
                        unit: null,
                        evidenceAt: r.publishedAt,
                        rank: which === "today" ? 3 : 2,
                    });
                }
            }
            break;
        }
        case "earthquake": {
            for (const { record } of await loadAround(db, anyHazard!, d.radiusKm, "category = 'earthquake'", [])) {
                const magnitude = record.metrics.find((m) => m.key === "magnitude")?.value;
                const time = record.observedAt ?? record.publishedAt ?? record.firstSeenAt;
                if (magnitude === undefined || magnitude < d.minMagnitude || time < since) continue;
                const km = distanceToWatchKm(anyHazard!, record, null);
                if (km === null || km > d.radiusKm) continue;
                out.push({
                    dedupeKey: record.id,
                    recordId: record.id,
                    sourceId: record.sourceId,
                    reason: `Magnitude ${magnitude} earthquake (${record.title}, Geoscience Australia) ${Math.round(km)} km from the watch area, observed ${when(time)}: at or above your magnitude ${d.minMagnitude}.`,
                    value: magnitude,
                    threshold: d.minMagnitude,
                    unit: null,
                    evidenceAt: time,
                    rank: 1,
                });
            }
            break;
        }
        case "source_stale": {
            const source = sourceById(d.sourceId);
            const row = (await sourceRows(db)).get(d.sourceId);
            if (!source || !row?.enabled || !row.last_success_at) break;
            const limit = d.minutes ?? source.staleAfterMinutes;
            const age = Math.round((now.getTime() - Date.parse(row.last_success_at)) / MINUTE);
            if (age < limit) break;
            out.push({
                dedupeKey: `${d.sourceId}:${row.last_success_at}`,
                recordId: null,
                sourceId: d.sourceId,
                reason: `${source.provider}: ${source.dataset} hasn't been retrieved for ${age} minutes (limit ${limit}). Last success ${when(row.last_success_at)}.`,
                value: age,
                threshold: limit,
                unit: "min",
                evidenceAt: row.last_success_at,
                rank: 1,
            });
            break;
        }
    }
    return out;
}

interface PersonState {
    user: PortalUser | null;
    emailAlerts: boolean;
    sentThisHour: number;
}

/** Evaluates enabled rules (all, or one person's) and records new matches. Returns the number recorded. */
export async function evaluateRules(env: Env, options: { now?: Date; email?: string } = {}): Promise<number> {
    const db = env.DB;
    const now = options.now ?? new Date();
    const rows = (
        await db
            .prepare(`SELECT * FROM ic_rules WHERE enabled = 1 ${options.email ? "AND email = ?" : ""} ORDER BY COALESCE(last_evaluated_at, '') LIMIT ?`)
            .bind(...(options.email ? [options.email] : []), MAX_RULES_PER_RUN)
            .all<RuleRow>()
    ).results;
    const people = new Map<string, PersonState>();
    const hourStart = `${now.toISOString().slice(0, 13)}:00:00`;
    let recorded = 0;
    for (const row of rows) {
        const email = row.email.toLowerCase();
        if (!people.has(email)) {
            const auth = await userForEmail(env, email);
            const sent = await db
                .prepare("SELECT COUNT(*) AS n FROM ic_rule_matches WHERE email = ? AND notified = 1 AND at >= ?")
                .bind(email, hourStart)
                .first<{ n: number }>();
            people.set(email, {
                user: auth.ok && can(auth.user, "centre.use") ? auth.user : null,
                emailAlerts: (await loadPreferences(db, email)).preferences.email.alerts,
                sentThisHour: sent?.n ?? 0,
            });
        }
        const person = people.get(email)!;
        // Someone who lost access gets nothing, and their rules aren't evaluated.
        if (!person.user) continue;
        const rule = toRule(row);
        let candidates: Candidate[];
        try {
            candidates = await candidatesFor(env, person.user, rule, now);
        } catch (error) {
            console.log(JSON.stringify({ event: "centre_rule_failed", rule: row.id, message: (error as Error).message.slice(0, 200) }));
            continue;
        }
        const at = nowIso();
        let lastNotified = (
            await db
                .prepare("SELECT MAX(at) AS at FROM ic_rule_matches WHERE rule_id = ? AND notified = 1")
                .bind(row.id)
                .first<{ at: string | null }>()
        )?.at;
        let matched = false;
        for (const c of candidates.slice(0, 50)) {
            const id = newId("icm");
            const cooling = !!lastNotified && Date.parse(lastNotified) > now.getTime() - rule.cooldownMinutes * MINUTE;
            const overLimit = person.sentThisHour >= MAX_NOTIFICATIONS_PER_HOUR;
            const notify = rule.notify !== "none" && !cooling && !overLimit;
            const inserted = await db
                .prepare(
                    `INSERT INTO ic_rule_matches (id, rule_id, email, dedupe_key, at, record_id, source_id, reason, observed_value, threshold, unit, evidence_at, notified, suppressed)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(rule_id, dedupe_key) DO NOTHING`,
                )
                .bind(
                    id,
                    row.id,
                    email,
                    c.dedupeKey.slice(0, 200),
                    at,
                    c.recordId,
                    c.sourceId,
                    c.reason.slice(0, 600),
                    c.value,
                    c.threshold,
                    c.unit,
                    c.evidenceAt,
                    notify ? 1 : 0,
                    rule.notify === "none" ? null : cooling ? "cooldown" : overLimit ? "rate_limit" : null,
                )
                .run();
            if (!inserted.meta.changes) continue;
            recorded++;
            matched = true;
            if (!notify) continue;
            person.sentThisHour++;
            lastNotified = at;
            await db
                .prepare(
                    `INSERT OR IGNORE INTO ic_alerts (id, email, watch_id, record_id, change_id, kind, title, detail, url, level_rank, created_at, email_status)
                     VALUES (?, ?, ?, ?, ?, 'rule_match', ?, ?, ?, ?, ?, ?)`,
                )
                .bind(
                    newId("ica"),
                    email,
                    row.watch_id,
                    c.recordId,
                    id,
                    `Rule matched: ${rule.name}`.slice(0, 300),
                    c.reason.slice(0, 500),
                    `/portal/intelligence-centre/rules#${id}`,
                    c.rank,
                    at,
                    rule.notify === "email" && person.emailAlerts ? "pending" : null,
                )
                .run();
        }
        await db
            .prepare(`UPDATE ic_rules SET last_evaluated_at = ?${matched ? ", last_matched_at = ?" : ""} WHERE id = ?`)
            .bind(...(matched ? [at, at] : [at]), row.id)
            .run();
    }
    return recorded;
}

// --- Testing against history ------------------------------------------------------------------------

/**
 * What a rule would have matched over the last few days, from stored history (versions, series,
 * collection runs). Nothing is written and nobody is notified.
 */
export async function testRule(env: Env, user: PortalUser, body: unknown, days = 7, now = new Date()): Promise<RuleTestResult> {
    const db = env.DB;
    const input = await checkInput(db, user, body);
    const d = input.definition;
    const from = new Date(now.getTime() - days * 86_400_000);
    const notes: string[] = [];
    const matches: RuleTestMatch[] = [];
    const seen = new Set<string>();
    let examined = 0;
    const push = (c: Candidate, at: string) => {
        if (seen.has(c.dedupeKey)) return;
        seen.add(c.dedupeKey);
        matches.push({ at, recordId: c.recordId, reason: c.reason, observedValue: c.value });
    };
    const meta = CONDITION_META[d.condition];
    if (d.condition === "gauge_threshold" || d.condition === "wind_gust" || d.condition === "temperature" || d.condition === "source_stale") {
        if (d.condition === "source_stale") {
            const source = sourceById(d.sourceId)!;
            const limit = d.minutes ?? source.staleAfterMinutes;
            for (const g of await sourceGaps(db, from.toISOString(), now.toISOString(), [d.sourceId])) {
                examined++;
                if (g.minutes >= limit)
                    push(
                        {
                            dedupeKey: `${g.sourceId}:${g.from}`,
                            recordId: null,
                            sourceId: g.sourceId,
                            reason: `${source.dataset}: no successful retrieval for ${g.minutes} minutes after ${when(g.from)} (limit ${limit}).`,
                            value: g.minutes,
                            threshold: limit,
                            unit: "min",
                            evidenceAt: g.from,
                            rank: 1,
                        },
                        new Date(Date.parse(g.from) + limit * MINUTE).toISOString(),
                    );
            }
        } else {
            // Readings: the same crossing logic over the whole period.
            for (const c of await candidatesFor(env, user, { definition: d, lookbackMinutes: days * 1440 }, now)) {
                examined++;
                push(c, c.evidenceAt ?? now.toISOString());
            }
            notes.push("Readings are kept for the measurement retention period (Settings), so older ones can't be tested.");
        }
    } else {
        // Official records: every stored state in the period, as it was stored then.
        const versions = (
            await db
                .prepare(
                    `SELECT * FROM ic_record_versions WHERE (valid_to IS NULL OR valid_to > ?) AND valid_from <= ? AND active = 1 ORDER BY valid_from LIMIT 5000`,
                )
                .bind(from.toISOString(), now.toISOString())
                .all<VersionRow>()
        ).results;
        if (!versions.length) notes.push("No versioned history is stored for this period, so only current records were tested.");
        const watch = "watchId" in d ? { ...(await requireWatch(db, user.email, d.watchId)), categories: [] } : null;
        const states = versions.length
            ? versions.map((v) => ({ at: v.valid_from > from.toISOString() ? v.valid_from : from.toISOString(), record: toReplayRecord(v), hash: v.geometry_hash }))
            : [];
        examined = states.length;
        if (states.length) {
            const geometries = new Map<string, Geometry | null>();
            for (const s of states)
                if (s.hash && !geometries.has(s.hash)) {
                    const g = await db.prepare("SELECT geometry FROM ic_geometries WHERE hash = ?").bind(s.hash).first<{ geometry: string }>();
                    geometries.set(s.hash, g ? parseJson<Geometry | null>(g.geometry, null) : null);
                }
            // Evaluate each state with the rule's own logic, by standing in a one-record table.
            for (const s of states) {
                const record: CentreRecord = {
                    ...s.record,
                    externalId: "",
                    eventType: null,
                    description: null,
                    bbox: null,
                    hasGeometry: !!s.hash,
                    geometryQuality: s.hash ? "polygon" : "point",
                    uncertaintyM: null,
                    firstSeenAt: s.record.validFrom,
                    lastSeenAt: s.record.validFrom,
                    missingSince: null,
                };
                const candidate = stateCandidate(d, watch, record, s.hash ? (geometries.get(s.hash) ?? null) : null);
                if (candidate) push(candidate, s.at);
            }
        } else
            for (const c of await candidatesFor(env, user, { definition: d, lookbackMinutes: days * 1440 }, now)) {
                examined++;
                push(c, c.evidenceAt ?? now.toISOString());
            }
    }
    if (meta.threshold === "own") notes.push("Your threshold is your own choice, not an official warning threshold.");
    notes.push("Matches are shown once per subject, as evaluation records them. Cooldown and notification limits aren't applied in a test.");
    return { from: from.toISOString(), to: now.toISOString(), matches: matches.slice(0, 100), examined, notes };
}

/** Whether one stored state of an official record meets a rule (for testing against history). */
function stateCandidate(d: RuleDefinition, anyHazard: WatchArea | null, record: CentreRecord, geometry: Geometry | null): Candidate | null {
    if (d.condition === "total_fire_ban") {
        if (record.sourceId !== "rfs-fire-danger" || (record.title !== d.district && record.attributes.district !== d.district)) return null;
        const which = (["today", "tomorrow"] as const).find(
            (w) => (d.when === "either" || d.when === w) && record.attributes[w === "today" ? "banToday" : "banTomorrow"] === "yes",
        );
        return which
            ? {
                  dedupeKey: `${record.id}:${which}:${sydneyDate(record.publishedAt)}`,
                  recordId: record.id,
                  sourceId: record.sourceId,
                  reason: `Total Fire Ban ${which} in ${record.title}, as the NSW RFS listed it.`,
                  value: null,
                  threshold: null,
                  unit: null,
                  evidenceAt: record.publishedAt,
                  rank: 3,
              }
            : null;
    }
    if (!anyHazard) return null;
    const km = distanceToWatchKm(anyHazard, record, geometry);
    switch (d.condition) {
        case "official_level":
            if ((record.kind !== "warning" && record.kind !== "incident") || record.severityRank < d.minLevel) return null;
            if (d.categories.length && !d.categories.includes(record.category)) return null;
            if (km === null || km > d.radiusKm) return null;
            return {
                dedupeKey: `${record.id}:${record.warningLevel}`,
                recordId: record.id,
                sourceId: record.sourceId,
                reason: `${record.title}: ${record.warningLevel} as published by ${record.provider}, ${km.toFixed(1)} km from the watch area.`,
                value: record.severityRank,
                threshold: d.minLevel,
                unit: null,
                evidenceAt: record.updatedAt ?? record.publishedAt,
                rank: record.severityRank,
            };
        case "fire_within":
            if (record.kind !== "incident" || record.category !== "fire" || km === null || km > d.radiusKm) return null;
            if (d.notUnderControlOnly && /^under control$/i.test(record.status ?? "")) return null;
            return {
                dedupeKey: record.id,
                recordId: record.id,
                sourceId: record.sourceId,
                reason: `${record.title} (${record.status ?? "status not given"}) ${km.toFixed(1)} km from the watch area.`,
                value: km,
                threshold: d.radiusKm,
                unit: "km",
                evidenceAt: record.publishedAt,
                rank: record.severityRank,
            };
        case "road_on_corridor":
            if (record.category !== "transport" || (d.closuresOnly && record.attributes.closure !== "yes")) return null;
            if (km === null || km > 0.01) return null;
            return {
                dedupeKey: record.id,
                recordId: record.id,
                sourceId: record.sourceId,
                reason: `${record.title} on the corridor.`,
                value: null,
                threshold: null,
                unit: null,
                evidenceAt: record.publishedAt,
                rank: 1,
            };
        case "earthquake": {
            const magnitude = record.metrics.find((m) => m.key === "magnitude")?.value;
            if (record.category !== "earthquake" || magnitude === undefined || magnitude < d.minMagnitude || km === null || km > d.radiusKm) return null;
            return {
                dedupeKey: record.id,
                recordId: record.id,
                sourceId: record.sourceId,
                reason: `Magnitude ${magnitude} earthquake ${Math.round(km)} km from the watch area.`,
                value: magnitude,
                threshold: d.minMagnitude,
                unit: null,
                evidenceAt: record.observedAt,
                rank: 1,
            };
        }
        default:
            return null;
    }
}

// --- Tasks ------------------------------------------------------------------------------------------

/** A follow-up task for a match, through Daly Tasks' own function. Asking again returns the same task. */
export async function taskFromMatch(env: Env, user: PortalUser, matchId: string, body: unknown) {
    if (!can(user, "tasks.use")) throw new HttpError(403, "forbidden", "You can't use Daly Tasks");
    const match = await requireMatch(env.DB, user.email, matchId);
    const input = (body ?? {}) as { dueDate?: unknown; projectId?: unknown };
    const dueDate = typeof input.dueDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.dueDate) ? input.dueDate : undefined;
    const projectId = typeof input.projectId === "string" && /^tpj_[a-z0-9]{14}$/.test(input.projectId) ? input.projectId : undefined;
    const site = new URL(env.SITE_URL).origin;
    const { task, replayed } = await createTask(env.DB, user, {
        title: `Check: ${match.ruleName}`.slice(0, 200),
        description: [
            `Monitoring rule matched ${when(match.at)}.`,
            match.reason,
            match.recordId ? `Record: ${site}/portal/intelligence-centre/records/${match.recordId}` : null,
            "From public information collected by the Intelligence Centre. Always check the official source and follow official warnings.",
        ]
            .filter(Boolean)
            .join("\n\n")
            .slice(0, 4000),
        ...(projectId ? { projectId } : {}),
        ...(dueDate ? { dueDate } : {}),
        labels: [],
        clientId: `centre-match-${matchId}`,
    });
    await env.DB.prepare("UPDATE ic_rule_matches SET task_id = ? WHERE id = ? AND email = ?").bind(task.id, matchId, user.email).run();
    return { taskId: task.id, url: `/portal/tasks/t/${task.id}`, replayed };
}
