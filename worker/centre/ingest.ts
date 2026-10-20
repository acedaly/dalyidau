// The ingestion engine (docs/INTELLIGENCE_CENTRE.md#ingestion-lifecycle).
//
// A bounded scheduler on the existing 15-minute cron: each run collects at most a few due sources,
// three at a time, under a per-source lease so overlapping runs never collect one source twice.
// Each collection: conditional request (ETag / Last-Modified, or the FTP listing's times), strict
// timeouts and byte limits (net.ts), validation (the adapter), replay protection (a response older
// than one already stored is refused), idempotent upserts keyed by the provider's own id, change
// detection, history and alerts. Failures back off exponentially; nothing a feed contains is ever
// executed, and nothing it omits is ever taken to mean "resolved".
//
// With history recording on (intelligence_centre.history), every state a record is stored in is
// also copied into ic_record_versions, straight from the row just written, so replay and timelines
// show exactly what was collected at that moment and nothing learnt later. Each run also adds to
// the source's daily reliability rollup (ic_source_daily).
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { type SourceDefinition, sourceById } from "../../src/shared/centre/sources";
import { type CentreSettings, type ChangeKind, fireDangerRank } from "../../src/shared/centre/types";
import type { Env } from "../env";
import { newId, nowIso, parseJson } from "../portal/db";
import { isEnabled } from "../portal/flags";
import { ADAPTERS } from "./adapters";
import { type ParsedBatch, type ParsedRecord, sha256Hex } from "./adapters/types";
import { alertsForChanges, deliverAlertEmails } from "./alerts";
import { type Geometry, bboxOf } from "./geo";
import { markHistoryStarted } from "./history";
import { type CentreTransport, FetchFailure, defaultTransport } from "./net";
import { expireReports, runDueReports } from "./reports";
import { evaluateRules } from "./rules";
import { type SourceRow, ensureSources, loadCentreSettings, secretFor } from "./store";

const LEASE_MS = 3 * 60_000;
const MAX_SOURCES_PER_RUN = 8;
const CONCURRENCY = 3;
const MAX_BACKOFF_MS = 6 * 3_600_000;
/** Below these kinds, being added or dropped from a feed is routine and not a "change". */
const QUIET_KINDS = new Set(["observation", "detection"]);
/** Kept as measurement series instead of versions (they change at every collection). */
const UNVERSIONED_KINDS = "('observation', 'detection')";

export interface CollectOptions {
    now?: Date;
    transport?: CentreTransport;
    trigger?: "cron" | "manual";
    /** When the collection is recorded as stored (tests that build history at chosen times). Defaults to now. */
    recordedAt?: Date;
}

export interface CollectResult {
    sourceId: string;
    outcome: "ok" | "unchanged" | "error" | "rejected" | "skipped";
    records: number;
    created: number;
    changed: number;
    errorCode?: string;
    message?: string;
}

const statements = async (db: D1Database, list: D1PreparedStatement[]) => {
    for (let i = 0; i < list.length; i += 80) await db.batch(list.slice(i, i + 80));
};

/** Plain sentences for people; the error's own text is already written for them (net.ts, adapters). */
const friendly = (error: unknown): { code: string; message: string; retryable: boolean; status: number | null } => {
    if (error instanceof FetchFailure) return { code: error.code, message: error.message.slice(0, 300), retryable: error.retryable, status: error.httpStatus };
    return { code: "internal", message: "Something went wrong while reading this source.", retryable: true, status: null };
};

const backoffMs = (source: SourceDefinition, failures: number) => Math.min(MAX_BACKOFF_MS, source.refreshMinutes * 60_000 * 2 ** Math.max(0, failures - 1));

// --- Fingerprints ----------------------------------------------------------------------------------

const significant = (r: ParsedRecord) =>
    JSON.stringify([
        r.title,
        r.description ?? null,
        r.status ?? null,
        r.warningLevel ?? null,
        r.point ?? null,
        r.areaName ?? null,
        r.publishedAt ?? null,
        r.updatedAt ?? null,
        r.observedAt ?? null,
        r.metrics ?? [],
        r.attrs ?? {},
        !!r.ended,
    ]);

interface ExistingRow {
    id: string;
    external_id: string;
    fingerprint: string;
    geometry_hash: string | null;
    warning_level: string | null;
    severity_rank: number;
    status: string | null;
    attrs: string;
    metrics: string;
    active: number;
    missing_since: string | null;
    kind: string;
    title: string;
}

interface Change {
    id: string;
    recordId: string | null;
    sourceId: string;
    kind: ChangeKind;
    at: string;
    from: string | null;
    to: string | null;
    summary: string;
    rank: number;
}

// --- Versions (replay and timelines) ---------------------------------------------------------------

const VERSION_COLUMNS = `id, record_id, source_id, seq, valid_from, baseline, change_kind, kind, category, event_type, title, description, status,
    warning_level, severity_rank, lat, lon, min_lat, min_lon, max_lat, max_lon, geometry_quality, geometry_hash, uncertainty_m, area_name,
    published_at, updated_at, observed_at, active, missing, source_url, metrics, attrs, fixture`;
const VERSION_FROM_RECORD = `r.kind, r.category, r.event_type, r.title, substr(r.description, 1, 2000), r.status, r.warning_level, r.severity_rank,
    r.lat, r.lon, r.min_lat, r.min_lon, r.max_lat, r.max_lon, r.geometry_quality, r.geometry_hash, r.uncertainty_m, r.area_name,
    r.published_at, r.updated_at, r.observed_at, r.active, CASE WHEN r.missing_since IS NULL THEN 0 ELSE 1 END, r.source_url, r.metrics, r.attrs, r.fixture`;

/**
 * The record's stored state as a new version: the open version is closed at `at` and the row as it
 * now is (after this batch's write to it) is copied, published area included.
 */
export const versionStatements = (db: D1Database, recordId: string, at: string, changeKind: string | null, baseline = false): D1PreparedStatement[] => [
    db.prepare("UPDATE ic_record_versions SET valid_to = ? WHERE record_id = ? AND valid_to IS NULL").bind(at, recordId),
    db
        .prepare(
            `INSERT INTO ic_record_versions (${VERSION_COLUMNS})
             SELECT ?, r.id, r.source_id, (SELECT COALESCE(MAX(v.seq), 0) + 1 FROM ic_record_versions v WHERE v.record_id = r.id), ?, ?, ?, ${VERSION_FROM_RECORD}
             FROM ic_records r WHERE r.id = ? AND r.kind NOT IN ${UNVERSIONED_KINDS}`,
        )
        .bind(newId("icv"), at, baseline ? 1 : 0, changeKind, recordId),
    db
        .prepare(
            "INSERT OR IGNORE INTO ic_geometries (hash, geometry, first_seen_at) SELECT geometry_hash, geometry, ? FROM ic_records WHERE id = ? AND geometry IS NOT NULL",
        )
        .bind(at, recordId),
];

/**
 * Records stored before history recording began get one baseline version, dated now: their state
 * as it is, honestly marked, and nothing about what it was before.
 */
const baselineStatements = (db: D1Database, sourceId: string, at: string): D1PreparedStatement[] => [
    db
        .prepare(
            `INSERT OR IGNORE INTO ic_geometries (hash, geometry, first_seen_at)
             SELECT geometry_hash, geometry, ? FROM ic_records r WHERE r.source_id = ? AND r.geometry IS NOT NULL AND r.kind NOT IN ${UNVERSIONED_KINDS}
             AND NOT EXISTS (SELECT 1 FROM ic_record_versions v WHERE v.record_id = r.id)`,
        )
        .bind(at, sourceId),
    db
        .prepare(
            `INSERT INTO ic_record_versions (${VERSION_COLUMNS})
             SELECT 'icv_' || lower(hex(randomblob(7))), r.id, r.source_id, 1, ?, 1, NULL, ${VERSION_FROM_RECORD}
             FROM ic_records r WHERE r.source_id = ? AND r.kind NOT IN ${UNVERSIONED_KINDS}
             AND NOT EXISTS (SELECT 1 FROM ic_record_versions v WHERE v.record_id = r.id)`,
        )
        .bind(at, sourceId),
];

const changeStatement = (db: D1Database, c: Change) =>
    db
        .prepare("INSERT INTO ic_changes (id, record_id, source_id, kind, at, from_value, to_value, summary, severity_rank) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(c.id, c.recordId, c.sourceId, c.kind, c.at, c.from?.slice(0, 300) ?? null, c.to?.slice(0, 300) ?? null, c.summary.slice(0, 500), c.rank);

/** Record a source-level change (failure, stale, recovered). */
export async function sourceChange(db: D1Database, sourceId: string, kind: ChangeKind, summary: string, at = nowIso()) {
    await changeStatement(db, { id: newId("icc"), recordId: null, sourceId, kind, at, from: null, to: null, summary, rank: 0 }).run();
}

// --- Storing a batch -------------------------------------------------------------------------------

export interface StoreOutcome {
    created: number;
    changed: number;
    changes: Change[];
}

/** Writes a parsed batch: upserts, change detection, records no longer in the feed, history. */
export async function storeBatch(
    db: D1Database,
    source: SourceDefinition,
    batch: ParsedBatch,
    options: { now: string; fixture: boolean; baseline: boolean; settings: CentreSettings; history?: boolean },
): Promise<StoreOutcome> {
    const { now } = options;
    const versioned = !!options.history && source.history;
    // Records already versioned: anything else written now starts its history here, as a baseline.
    const hasHistory = versioned
        ? new Set(
              (
                  await db.prepare("SELECT DISTINCT record_id FROM ic_record_versions WHERE source_id = ?").bind(source.id).all<{ record_id: string }>()
              ).results.map((r) => r.record_id),
          )
        : new Set<string>();
    const hourAgo = new Date(Date.parse(now) - 3_600_000).toISOString();
    const existing = new Map(
        (
            await db
                .prepare(
                    "SELECT id, external_id, fingerprint, geometry_hash, warning_level, severity_rank, status, attrs, metrics, active, missing_since, kind, title FROM ic_records WHERE source_id = ?",
                )
                .bind(source.id)
                .all<ExistingRow>()
        ).results.map((r) => [r.external_id, r]),
    );
    const writes: D1PreparedStatement[] = [];
    const changes: Change[] = [];
    const seen = new Set<string>();
    const existingIds = new Set([...existing.values()].map((r) => r.id));
    /** Records written in this batch, for their new versions (written after every record's own write). */
    const touched = new Map<string, string | null>();
    let created = 0;
    let changed = 0;
    const change = (recordId: string | null, kind: ChangeKind, summary: string, rank: number, from: string | null = null, to: string | null = null) =>
        changes.push({ id: newId("icc"), recordId, sourceId: source.id, kind, at: now, from, to, summary, rank });

    for (const r of batch.records) {
        if (seen.has(r.externalId)) continue; // a provider listing the same id twice: first wins
        seen.add(r.externalId);
        const geometry = r.geometry ?? null;
        const geometryJson = geometry ? JSON.stringify(geometry) : null;
        if (geometryJson && geometryJson.length > 400_000)
            throw new FetchFailure("too_large", "A published area is more detailed than this application stores", null, false);
        const bbox = geometry ? bboxOf(geometry as Geometry) : r.point ? [r.point[0], r.point[1], r.point[0], r.point[1]] : null;
        const fingerprint = await sha256Hex(significant(r));
        const geometryHash = geometryJson ? await sha256Hex(geometryJson) : null;
        const prior = existing.get(r.externalId);
        const active = r.ended ? 0 : 1;
        const values = [
            r.kind,
            r.category,
            r.eventType ?? null,
            r.title.slice(0, 300),
            r.description?.slice(0, 8000) ?? null,
            r.status?.slice(0, 120) ?? null,
            r.warningLevel?.slice(0, 60) ?? null,
            r.severityRank ?? 0,
            r.point?.[1] ?? null,
            r.point?.[0] ?? null,
            bbox?.[1] ?? null,
            bbox?.[0] ?? null,
            bbox?.[3] ?? null,
            bbox?.[2] ?? null,
            geometryJson,
            r.geometryQuality,
            r.uncertaintyM ?? null,
            r.areaName?.slice(0, 300) ?? null,
            r.publishedAt ?? null,
            r.updatedAt ?? null,
            r.observedAt ?? null,
            r.sourceUrl ?? null,
            fingerprint,
            geometryHash,
            JSON.stringify(r.metrics ?? []),
            JSON.stringify(r.attrs ?? {}),
            options.fixture ? 1 : 0,
        ];
        if (!prior) {
            const id = newId("icr");
            created++;
            writes.push(
                db
                    .prepare(
                        `INSERT INTO ic_records (id, source_id, external_id, kind, category, event_type, title, description, status, warning_level, severity_rank,
                            lat, lon, min_lat, min_lon, max_lat, max_lon, geometry, geometry_quality, uncertainty_m, area_name, published_at, updated_at, observed_at,
                            source_url, fingerprint, geometry_hash, metrics, attrs, fixture, first_seen_at, last_seen_at, active)
                         VALUES (?, ?, ?, ${values.map(() => "?").join(", ")}, ?, ?, ?)
                         ON CONFLICT(source_id, external_id) DO NOTHING`,
                    )
                    .bind(id, source.id, r.externalId, ...values, now, now, active),
            );
            if (versioned) touched.set(id, options.baseline ? "baseline" : r.ended ? "ended" : "new");
            // The first collection is a baseline: what's already there isn't "new".
            if (!options.baseline && !QUIET_KINDS.has(r.kind) && !r.ended)
                change(id, r.category === "fire_danger" ? "updated" : "new", `New: ${r.title}`, r.severityRank ?? 0, null, r.warningLevel ?? r.status ?? null);
            continue;
        }
        const unchanged = prior.fingerprint === fingerprint && prior.geometry_hash === geometryHash && prior.active === active && !prior.missing_since;
        if (unchanged) {
            // At most hourly: "last seen" drives retention, and rewriting thousands of unchanged rows
            // every collection would be most of the database writes.
            writes.push(db.prepare("UPDATE ic_records SET last_seen_at = ? WHERE id = ? AND last_seen_at < ?").bind(now, prior.id, hourAgo));
            continue;
        }
        changed++;
        writes.push(
            db
                .prepare(
                    `UPDATE ic_records SET kind = ?, category = ?, event_type = ?, title = ?, description = ?, status = ?, warning_level = ?, severity_rank = ?,
                        lat = ?, lon = ?, min_lat = ?, min_lon = ?, max_lat = ?, max_lon = ?, geometry = ?, geometry_quality = ?, uncertainty_m = ?, area_name = ?,
                        published_at = ?, updated_at = ?, observed_at = ?, source_url = ?, fingerprint = ?, geometry_hash = ?, metrics = ?, attrs = ?, fixture = ?,
                        last_seen_at = ?, missing_since = NULL, active = ?
                     WHERE id = ?`,
                )
                .bind(...values, now, active, prior.id),
        );
        if (versioned && !QUIET_KINDS.has(r.kind)) touched.set(prior.id, null);
        if (QUIET_KINDS.has(r.kind)) {
            // Observations change every time; only a material river level change is recorded.
            if (r.category === "water") {
                const before = parseJson<{ key: string; value: number }[]>(prior.metrics, []).find((m) => m.key === "water_level")?.value;
                const after = r.metrics?.find((m) => m.key === "water_level")?.value;
                if (before !== undefined && after !== undefined && Math.abs(after - before) >= options.settings.riverChangeMetres)
                    change(
                        prior.id,
                        "measurement_change",
                        `${r.title}: river level ${after > before ? "rose" : "fell"} from ${before} m to ${after} m (observed)`,
                        0,
                        String(before),
                        String(after),
                    );
            }
            continue;
        }
        if (prior.missing_since || !prior.active) {
            if (active) change(prior.id, "reappeared", `Back in the feed: ${r.title}`, r.severityRank ?? 0);
        }
        if (r.ended && prior.active) {
            change(prior.id, "ended", `${source.provider} marked it ${r.status ?? "ended"}: ${r.title}`, r.severityRank ?? 0, prior.status, r.status ?? null);
            continue;
        }
        if (r.kind === "rating") {
            const before = parseJson<Record<string, string>>(prior.attrs, {});
            const after = r.attrs ?? {};
            if (before.today !== after.today)
                change(
                    prior.id,
                    "rating_changed",
                    `${r.title}: today's Fire Danger Rating is ${after.today} (was ${before.today ?? "not listed"})`,
                    fireDangerRank(after.today),
                    before.today ?? null,
                    after.today ?? null,
                );
            if (before.banToday !== "yes" && after.banToday === "yes") change(prior.id, "ban_declared", `Total Fire Ban today: ${r.title}`, 3, "no", "yes");
            if (before.banToday === "yes" && after.banToday !== "yes")
                change(prior.id, "ban_lifted", `${r.title}: a Total Fire Ban is no longer listed for today`, 0, "yes", "no");
            if (before.banTomorrow !== "yes" && after.banTomorrow === "yes")
                change(prior.id, "ban_declared", `Total Fire Ban tomorrow: ${r.title}`, 2, "no", "yes (tomorrow)");
            continue;
        }
        const rank = r.severityRank ?? 0;
        if (r.warningLevel !== prior.warning_level && rank > prior.severity_rank)
            change(
                prior.id,
                "escalated",
                `${r.title}: ${prior.warning_level ?? "no level"} → ${r.warningLevel}`,
                rank,
                prior.warning_level,
                r.warningLevel ?? null,
            );
        else if (r.warningLevel !== prior.warning_level && rank < prior.severity_rank)
            change(
                prior.id,
                "downgraded",
                `${r.title}: ${prior.warning_level} → ${r.warningLevel ?? "no level"}`,
                rank,
                prior.warning_level,
                r.warningLevel ?? null,
            );
        else if (geometryHash && prior.geometry_hash && geometryHash !== prior.geometry_hash)
            change(prior.id, "geometry_changed", `${r.title}: the published area changed`, rank);
        else if (prior.fingerprint !== fingerprint && (r.status ?? null) !== prior.status)
            change(prior.id, "updated", `${r.title}: ${prior.status ?? "no status"} → ${r.status ?? "no status"}`, rank, prior.status, r.status ?? null);
    }

    // Records the adapter kept without re-reading are still current.
    for (const id of batch.keep ?? []) {
        seen.add(id);
        const prior = existing.get(id);
        if (prior?.active) writes.push(db.prepare("UPDATE ic_records SET last_seen_at = ? WHERE id = ? AND last_seen_at < ?").bind(now, prior.id, hourAgo));
    }

    // Gone from a complete listing: no longer in the feed. Never "resolved".
    if (batch.complete) {
        for (const [externalId, prior] of existing) {
            if (seen.has(externalId) || !prior.active) continue;
            writes.push(db.prepare("UPDATE ic_records SET active = 0, missing_since = COALESCE(missing_since, ?) WHERE id = ?").bind(now, prior.id));
            if (versioned && !QUIET_KINDS.has(prior.kind)) touched.set(prior.id, "not_in_feed");
            if (!QUIET_KINDS.has(prior.kind))
                change(prior.id, "not_in_feed", `No longer in the ${source.provider} feed (not confirmed resolved): ${prior.title}`, prior.severity_rank);
        }
    }

    for (const c of changes) writes.push(changeStatement(db, c));
    if (versioned) writes.push(markHistoryStarted(db, now));
    // Each written record's new version, labelled with the change detected for it (if any).
    for (const [recordId, label] of touched) {
        const detected = changes.find((c) => c.recordId === recordId)?.kind ?? label;
        // The first collection of a source is a baseline: the provider published these before it. So
        // is the first version of a record stored before history recording began.
        if (label === "baseline") writes.push(...versionStatements(db, recordId, now, null, true));
        else writes.push(...versionStatements(db, recordId, now, detected ?? "updated", !hasHistory.has(recordId) && existingIds.has(recordId)));
    }
    // Unchanged records stored before history recording began get one baseline version, dated now.
    if (versioned) writes.push(...baselineStatements(db, source.id, now));
    await statements(db, writes);

    if (batch.series?.length && source.history) {
        const ids = new Map(
            (
                await db.prepare("SELECT id, external_id FROM ic_records WHERE source_id = ?").bind(source.id).all<{ id: string; external_id: string }>()
            ).results.map((r) => [r.external_id, r.id]),
        );
        await statements(
            db,
            batch.series
                .filter((p) => ids.has(p.externalId))
                .map((p) =>
                    db
                        .prepare("INSERT OR IGNORE INTO ic_series (record_id, metric, at, value) VALUES (?, ?, ?, ?)")
                        .bind(ids.get(p.externalId)!, p.metric, p.at, p.value),
                ),
        );
    }
    return { created, changed, changes };
}

// --- Snapshots (R2) --------------------------------------------------------------------------------

async function snapshot(env: Env, source: SourceDefinition, bytes: Uint8Array, at: string, keep: number) {
    if (!keep || !source.history) return;
    const prefix = `private/centre/snapshots/${source.id}/`;
    const body = new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream("gzip")));
    await env.MEDIA.put(`${prefix}${at.replace(/[:.]/g, "-")}.gz`, await body.arrayBuffer(), { httpMetadata: { contentType: "application/gzip" } });
    const listed = await env.MEDIA.list({ prefix, limit: 1000 });
    const old = listed.objects.map((o) => o.key).sort();
    if (old.length > keep) await env.MEDIA.delete(old.slice(0, old.length - keep));
}

// --- Collecting one source -------------------------------------------------------------------------

export async function collectSource(env: Env, sourceId: string, options: CollectOptions = {}): Promise<CollectResult> {
    const db = env.DB;
    const source = sourceById(sourceId);
    const adapter = ADAPTERS[sourceId];
    if (!source || !adapter) return { sourceId, outcome: "skipped", records: 0, created: 0, changed: 0, message: "Not implemented" };
    const now = options.now ?? new Date();
    const at = options.recordedAt?.toISOString() ?? nowIso();
    const transport = options.transport ?? defaultTransport(env);
    await ensureSources(db);
    const token = crypto.randomUUID();
    const leased = await db
        .prepare("UPDATE ic_sources SET lease_until = ?, lease_token = ? WHERE id = ? AND enabled = 1 AND (lease_until IS NULL OR lease_until < ?)")
        .bind(new Date(now.getTime() + LEASE_MS).toISOString(), token, sourceId, now.toISOString())
        .run();
    if (!leased.meta.changes) return { sourceId, outcome: "skipped", records: 0, created: 0, changed: 0, message: "Off, or already being collected" };
    const row = (await db.prepare("SELECT * FROM ic_sources WHERE id = ?").bind(sourceId).first<SourceRow>())!;
    const started = Date.now();
    const runId = newId("icf");
    const release = (sets: string, binds: unknown[]) =>
        db
            .prepare(`UPDATE ic_sources SET ${sets}, lease_until = NULL, lease_token = NULL, updated_at = ? WHERE id = ? AND lease_token = ?`)
            .bind(...binds, at, sourceId, token);
    const run = (
        outcome: "ok" | "unchanged" | "error" | "rejected",
        extra: {
            status?: number | null;
            bytes?: number;
            records?: number;
            created?: number;
            changed?: number;
            code?: string | null;
            publishedAt?: string | null;
            active?: number;
        },
    ): D1PreparedStatement[] => {
        const ms = Date.now() - started;
        // How long after the provider's own publication time this collection stored it.
        const delay = extra.publishedAt ? Math.round((Date.parse(at) - Date.parse(extra.publishedAt)) / 1000) : null;
        const delayS = delay !== null && Number.isFinite(delay) && delay >= 0 && delay < 30 * 86_400 ? delay : null;
        const success = outcome === "ok" || outcome === "unchanged";
        const gap = success && row.last_success_at ? Math.max(0, Math.round((Date.parse(at) - Date.parse(row.last_success_at)) / 60_000)) : 0;
        return [
            db
                .prepare(
                    "INSERT INTO ic_fetch_runs (id, source_id, started_at, outcome, http_status, bytes, records, created, changed, ms, error_code, trigger, delay_s) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                )
                .bind(
                    runId,
                    sourceId,
                    at,
                    outcome,
                    extra.status ?? null,
                    extra.bytes ?? 0,
                    extra.records ?? 0,
                    extra.created ?? 0,
                    extra.changed ?? 0,
                    ms,
                    extra.code ?? null,
                    options.trigger ?? "cron",
                    delayS,
                ),
            db
                .prepare(
                    `INSERT INTO ic_source_daily (source_id, day, attempts, ok, unchanged, errors, rejected, total_ms, max_ms, bytes, records_max, created, changed,
                        delay_total_s, delay_count, delay_max_s, first_success_at, last_success_at, longest_gap_minutes)
                     VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                     ON CONFLICT(source_id, day) DO UPDATE SET
                        attempts = attempts + 1, ok = ok + excluded.ok, unchanged = unchanged + excluded.unchanged, errors = errors + excluded.errors,
                        rejected = rejected + excluded.rejected, total_ms = total_ms + excluded.total_ms, max_ms = MAX(max_ms, excluded.max_ms),
                        bytes = bytes + excluded.bytes, records_max = MAX(records_max, excluded.records_max), created = created + excluded.created,
                        changed = changed + excluded.changed, delay_total_s = delay_total_s + excluded.delay_total_s,
                        delay_count = delay_count + excluded.delay_count, delay_max_s = MAX(delay_max_s, excluded.delay_max_s),
                        first_success_at = COALESCE(first_success_at, excluded.first_success_at),
                        last_success_at = COALESCE(excluded.last_success_at, last_success_at),
                        longest_gap_minutes = MAX(longest_gap_minutes, excluded.longest_gap_minutes)`,
                )
                .bind(
                    sourceId,
                    at.slice(0, 10),
                    outcome === "ok" ? 1 : 0,
                    outcome === "unchanged" ? 1 : 0,
                    outcome === "error" ? 1 : 0,
                    outcome === "rejected" ? 1 : 0,
                    ms,
                    ms,
                    extra.bytes ?? 0,
                    extra.active ?? 0,
                    extra.created ?? 0,
                    extra.changed ?? 0,
                    delayS ?? 0,
                    delayS === null ? 0 : 1,
                    delayS ?? 0,
                    success ? at : null,
                    success ? at : null,
                    gap,
                ),
        ];
    };
    const nextDue = (ms: number) => new Date(now.getTime() + ms).toISOString();
    const secret = secretFor(env, source);
    try {
        if (source.authentication === "free_api_key" && !secret)
            throw new FetchFailure("credentials_missing", `Needs the ${source.secretName} Worker secret`, null, false);
        const { settings } = await loadCentreSettings(db);
        const batch = await adapter.run({
            env,
            transport,
            source,
            state: parseJson<Record<string, unknown>>(row.state, {}),
            etag: row.etag,
            lastModified: row.last_modified,
            settings,
            now,
            secret,
        });
        const state = batch.state ? JSON.stringify(batch.state) : row.state;
        if (state.length > 20_000) throw new FetchFailure("too_large", "Adapter state is too large", null, false);
        // Replay protection: a response older than data already stored is refused, not applied.
        if (batch.publishedAt && row.last_published_at && batch.publishedAt < row.last_published_at) {
            await db.batch([
                release("last_attempt_at = ?, next_due_at = ?, error_code = 'replayed', error_message = ?", [
                    at,
                    nextDue(source.refreshMinutes * 60_000),
                    "The service sent data older than what's already stored; it was ignored.",
                ]),
                ...run("rejected", { status: batch.httpStatus, bytes: batch.bytes, code: "replayed" }),
            ]);
            return { sourceId, outcome: "rejected", records: 0, created: 0, changed: 0, errorCode: "replayed" };
        }
        const recovered = row.consecutive_failures >= 3;
        if (batch.notModified || (batch.contentHash && batch.contentHash === row.content_hash)) {
            await db.batch([
                release(
                    "last_attempt_at = ?, last_success_at = ?, next_due_at = ?, consecutive_failures = 0, error_code = NULL, error_message = NULL, etag = COALESCE(?, etag), last_modified = COALESCE(?, last_modified), state = ?",
                    [at, at, nextDue(source.refreshMinutes * 60_000), batch.etag ?? null, batch.lastModified ?? null, state],
                ),
                ...run("unchanged", { status: batch.httpStatus, bytes: batch.bytes, active: row.record_count }),
            ]);
            if (recovered) await sourceChange(db, sourceId, "source_recovered", `${source.dataset} is being retrieved again`);
            return { sourceId, outcome: "unchanged", records: row.record_count, created: 0, changed: 0 };
        }
        const history = await isEnabled(db, "intelligence_centre.history");
        const stored = await storeBatch(db, source, batch, { now: at, fixture: transport.fixture, baseline: !row.last_success_at, settings, history });
        const count = await db.prepare("SELECT COUNT(*) AS n FROM ic_records WHERE source_id = ? AND active = 1").bind(sourceId).first<{ n: number }>();
        await db.batch([
            release(
                `last_attempt_at = ?, last_success_at = ?, next_due_at = ?, consecutive_failures = 0, error_code = NULL, error_message = NULL,
                 etag = ?, last_modified = ?, content_hash = ?, state = ?, record_count = ?, fixture = ?,
                 last_published_at = CASE WHEN ? IS NOT NULL AND (last_published_at IS NULL OR ? > last_published_at) THEN ? ELSE last_published_at END`,
                [
                    at,
                    at,
                    nextDue(source.refreshMinutes * 60_000),
                    batch.etag ?? null,
                    batch.lastModified ?? null,
                    batch.contentHash ?? null,
                    state,
                    count?.n ?? 0,
                    transport.fixture ? 1 : 0,
                    batch.publishedAt,
                    batch.publishedAt,
                    batch.publishedAt,
                ],
            ),
            ...run("ok", {
                status: batch.httpStatus,
                bytes: batch.bytes,
                records: batch.records.length,
                created: stored.created,
                changed: stored.changed,
                publishedAt: batch.publishedAt,
                active: count?.n ?? 0,
            }),
        ]);
        if (recovered) await sourceChange(db, sourceId, "source_recovered", `${source.dataset} is being retrieved again`);
        if (batch.snapshot) {
            await snapshot(env, source, batch.snapshot, at, settings.retention.snapshotsPerSource).catch((error: unknown) =>
                console.log(JSON.stringify({ event: "centre_snapshot_failed", source: sourceId, message: (error as Error).message })),
            );
        }
        if (stored.changes.length)
            await alertsForChanges(
                env,
                stored.changes.map((c) => c.id),
                { now },
            );
        console.log(
            JSON.stringify({
                event: "centre_collect",
                source: sourceId,
                outcome: "ok",
                records: batch.records.length,
                created: stored.created,
                changed: stored.changed,
                ms: Date.now() - started,
            }),
        );
        return { sourceId, outcome: "ok", records: batch.records.length, created: stored.created, changed: stored.changed };
    } catch (error) {
        const f = friendly(error);
        const failures = row.consecutive_failures + 1;
        // A missing key isn't retried until it's added; anything else backs off.
        const wait = f.code === "credentials_missing" ? 24 * 3_600_000 : backoffMs(source, failures);
        await db.batch([
            release("last_attempt_at = ?, next_due_at = ?, consecutive_failures = ?, error_code = ?, error_message = ?", [
                at,
                nextDue(wait),
                failures,
                f.code,
                f.message,
            ]),
            ...run("error", { status: f.status, code: f.code }),
        ]);
        if (failures === 3) await sourceChange(db, sourceId, "source_failed", `${source.dataset}: three attempts in a row failed (${f.message})`);
        // Operational log: the source and the code. Never a URL (it can carry a key) or a response.
        console.log(JSON.stringify({ event: "centre_collect", source: sourceId, outcome: "error", code: f.code, status: f.status, ms: Date.now() - started }));
        return { sourceId, outcome: "error", records: 0, created: 0, changed: 0, errorCode: f.code, message: f.message };
    }
}

// --- The scheduler ---------------------------------------------------------------------------------

export async function runDueSources(env: Env, options: CollectOptions & { max?: number } = {}): Promise<CollectResult[]> {
    const now = options.now ?? new Date();
    await ensureSources(env.DB);
    const due = await env.DB.prepare(
        "SELECT id FROM ic_sources WHERE enabled = 1 AND (next_due_at IS NULL OR next_due_at <= ?) AND (lease_until IS NULL OR lease_until < ?) ORDER BY COALESCE(next_due_at, '') LIMIT ?",
    )
        .bind(now.toISOString(), now.toISOString(), options.max ?? MAX_SOURCES_PER_RUN)
        .all<{ id: string }>();
    const queue = due.results.map((r) => r.id);
    const results: CollectResult[] = [];
    const worker = async () => {
        for (let id = queue.shift(); id; id = queue.shift())
            results.push(await collectSource(env, id, { ...options, now, trigger: options.trigger ?? "cron" }));
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
    return results;
}

/** Sources not retrieved for longer than they should be: one "stale" change each time it happens. */
export async function checkStaleSources(env: Env, now = new Date()) {
    const rows = await env.DB.prepare("SELECT id, last_success_at FROM ic_sources WHERE enabled = 1 AND last_success_at IS NOT NULL").all<{
        id: string;
        last_success_at: string;
    }>();
    for (const row of rows.results) {
        const source = sourceById(row.id);
        if (!source || now.getTime() - Date.parse(row.last_success_at) < source.staleAfterMinutes * 60_000) continue;
        const already = await env.DB.prepare("SELECT 1 FROM ic_changes WHERE source_id = ? AND kind = 'source_stale' AND at >= ?")
            .bind(row.id, row.last_success_at)
            .first();
        if (!already)
            await sourceChange(
                env.DB,
                row.id,
                "source_stale",
                `${source.dataset} hasn't been retrieved since ${row.last_success_at.slice(0, 16).replace("T", " ")} UTC`,
            );
    }
}

/** Warnings past the provider's own expiry time stop being current (the provider set the time). */
export async function expireWarnings(db: D1Database, now = new Date(), history = false) {
    const rows = await db
        .prepare(
            "SELECT id, title FROM ic_records WHERE active = 1 AND kind = 'warning' AND json_extract(attrs, '$.expires') IS NOT NULL AND json_extract(attrs, '$.expires') < ?",
        )
        .bind(now.toISOString())
        .all<{ id: string; title: string }>();
    const at = nowIso();
    await statements(
        db,
        rows.results.flatMap((r) => [
            db.prepare("UPDATE ic_records SET active = 0 WHERE id = ?").bind(r.id),
            ...(history ? versionStatements(db, r.id, at, "ended") : []),
            changeStatement(db, {
                id: newId("icc"),
                recordId: r.id,
                sourceId: "bom-warnings",
                kind: "ended",
                at,
                from: null,
                to: null,
                summary: `Expired at the time the provider set: ${r.title}`,
                rank: 0,
            }),
        ]),
    );
}

/** Retention: only data the settings say to drop, never anything else. */
export async function applyRetention(env: Env, now = new Date()) {
    const { settings } = await loadCentreSettings(env.DB);
    const before = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
    await env.DB.batch([
        env.DB.prepare("DELETE FROM ic_records WHERE active = 0 AND last_seen_at < ?").bind(before(settings.retention.recordDays)),
        // Detections without history permission go once they leave the provider's own window.
        env.DB.prepare("DELETE FROM ic_records WHERE active = 0 AND kind = 'detection' AND last_seen_at < ?").bind(before(3)),
        env.DB.prepare("DELETE FROM ic_changes WHERE at < ?").bind(before(settings.retention.changeDays)),
        env.DB.prepare("DELETE FROM ic_series WHERE at < ?").bind(before(settings.retention.seriesDays)),
        env.DB.prepare("DELETE FROM ic_fetch_runs WHERE started_at < ?").bind(before(settings.retention.fetchRunDays)),
        env.DB.prepare("DELETE FROM ic_alerts WHERE created_at < ?").bind(before(settings.retention.alertDays)),
        env.DB.prepare("DELETE FROM ic_series WHERE record_id NOT IN (SELECT id FROM ic_records)"),
        env.DB.prepare("UPDATE ic_watch_areas SET enabled = 0 WHERE enabled = 1 AND expires_at IS NOT NULL AND expires_at < ?").bind(now.toISOString()),
        // History (9.1): superseded versions past their retention; open versions stay while the record does.
        env.DB.prepare("DELETE FROM ic_record_versions WHERE valid_to IS NOT NULL AND valid_to < ?").bind(before(settings.retention.versionDays)),
        env.DB.prepare("DELETE FROM ic_record_versions WHERE valid_to IS NULL AND valid_from < ? AND record_id NOT IN (SELECT id FROM ic_records)").bind(
            before(settings.retention.versionDays),
        ),
        env.DB.prepare(
            `DELETE FROM ic_geometries WHERE first_seen_at < ? AND hash NOT IN (SELECT geometry_hash FROM ic_record_versions WHERE geometry_hash IS NOT NULL)
             AND hash NOT IN (SELECT geometry_hash FROM ic_records WHERE geometry_hash IS NOT NULL)`,
        ).bind(before(1)),
        env.DB.prepare("DELETE FROM ic_source_daily WHERE day < ?").bind(before(settings.retention.sourceDailyDays).slice(0, 10)),
        env.DB.prepare("DELETE FROM ic_rule_matches WHERE at < ?").bind(before(settings.retention.ruleMatchDays)),
        env.DB.prepare("DELETE FROM ic_cache WHERE expires_at < ?").bind(now.toISOString()),
    ]);
    await expireReports(env, before(settings.retention.reportDays));
}

/** The cron step. Retention always runs; collection only with the owner's switch on. */
export async function runCentreCron(env: Env, options: CollectOptions = {}) {
    const now = options.now ?? new Date();
    await ensureSources(env.DB);
    if (await isEnabled(env.DB, "intelligence_centre.ingestion")) {
        await runDueSources(env, { ...options, now });
        await checkStaleSources(env, now);
    }
    await expireWarnings(env.DB, now, await isEnabled(env.DB, "intelligence_centre.history"));
    // Each step's failure is contained: rules and reports never stop retention or email delivery.
    const step = async (name: string, work: () => Promise<unknown>) => {
        try {
            await work();
        } catch (error) {
            console.log(JSON.stringify({ event: "centre_cron_step_failed", step: name, message: (error as Error).message.slice(0, 200) }));
        }
    };
    if (await isEnabled(env.DB, "intelligence_centre.rules")) await step("rules", () => evaluateRules(env, { now }));
    if (await isEnabled(env.DB, "intelligence_centre.reports")) await step("reports", () => runDueReports(env, { now }));
    await applyRetention(env, now);
    await deliverAlertEmails(env, { now });
}
