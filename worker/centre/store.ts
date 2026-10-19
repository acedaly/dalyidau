// Reading the Intelligence Centre's tables: records, changes, source health, settings and
// preferences. Public records are the same for everyone; anything personal is read joined to the
// caller's email elsewhere (watch.ts, alerts.ts, wallboard.ts).
import type { D1Database } from "@cloudflare/workers-types";
import { type HazardCategory, IMPLEMENTED_SOURCES, SOURCES, type SourceDefinition, type SourceStatus, sourceById } from "../../src/shared/centre/sources";
import {
    type CentreChange,
    type CentrePreferences,
    type CentreRecord,
    type CentreSettings,
    type ChangeKind,
    DEFAULT_CENTRE_PREFERENCES,
    DEFAULT_CENTRE_SETTINGS,
    type FetchRun,
    type GeometryQuality,
    type RecordFilters,
    type RecordKind,
    type RecordMetric,
    type SourceHealth,
    centrePreferencesSchema,
    centreSettingsSchema,
} from "../../src/shared/centre/types";
import type { PortalUser } from "../../src/shared/portal/types";
import type { Env } from "../env";
import { auditStatement, nowIso, parseJson } from "../portal/db";
import { HttpError } from "../portal/http";

export interface RecordRow {
    id: string;
    source_id: string;
    external_id: string;
    kind: RecordKind;
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
    has_geometry?: number;
    geometry_quality: GeometryQuality;
    uncertainty_m: number | null;
    area_name: string | null;
    published_at: string | null;
    updated_at: string | null;
    observed_at: string | null;
    first_seen_at: string;
    last_seen_at: string;
    missing_since: string | null;
    active: number;
    source_url: string | null;
    fingerprint: string;
    geometry_hash: string | null;
    metrics: string;
    attrs: string;
    fixture: number;
}

/** Every column but the geometry (which can be large and is only loaded where it's drawn). */
export const RECORD_COLUMNS = `id, source_id, external_id, kind, category, event_type, title, description, status, warning_level, severity_rank,
    lat, lon, min_lat, min_lon, max_lat, max_lon, geometry IS NOT NULL AS has_geometry, geometry_quality, uncertainty_m, area_name,
    published_at, updated_at, observed_at, first_seen_at, last_seen_at, missing_since, active, source_url, fingerprint, geometry_hash, metrics, attrs, fixture`;

export function toRecord(row: RecordRow): CentreRecord {
    const source = sourceById(row.source_id);
    return {
        id: row.id,
        sourceId: row.source_id,
        provider: source?.provider ?? row.source_id,
        externalId: row.external_id,
        kind: row.kind,
        category: row.category,
        eventType: row.event_type,
        title: row.title,
        description: row.description,
        status: row.status,
        warningLevel: row.warning_level,
        severityRank: row.severity_rank,
        lat: row.lat,
        lon: row.lon,
        bbox:
            row.min_lon !== null && row.min_lat !== null && row.max_lon !== null && row.max_lat !== null
                ? [row.min_lon, row.min_lat, row.max_lon, row.max_lat]
                : null,
        hasGeometry: !!row.has_geometry,
        geometryQuality: row.geometry_quality,
        uncertaintyM: row.uncertainty_m,
        areaName: row.area_name,
        publishedAt: row.published_at,
        updatedAt: row.updated_at,
        observedAt: row.observed_at,
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
        missingSince: row.missing_since,
        active: row.active === 1,
        sourceUrl: row.source_url,
        metrics: parseJson<RecordMetric[]>(row.metrics, []),
        attributes: parseJson<Record<string, string>>(row.attrs, {}),
        fixture: row.fixture === 1,
    };
}

export interface ChangeRow {
    id: string;
    record_id: string | null;
    source_id: string;
    kind: ChangeKind;
    at: string;
    from_value: string | null;
    to_value: string | null;
    summary: string;
    severity_rank: number;
    category?: HazardCategory | null;
    title?: string | null;
}

export const toChange = (row: ChangeRow): CentreChange => ({
    id: row.id,
    recordId: row.record_id,
    sourceId: row.source_id,
    kind: row.kind,
    at: row.at,
    fromValue: row.from_value,
    toValue: row.to_value,
    summary: row.summary,
    severityRank: row.severity_rank,
    category: row.category ?? null,
    title: row.title ?? null,
});

export async function getRecord(db: D1Database, id: string): Promise<{ record: CentreRecord; geometry: unknown | null } | null> {
    const row = await db.prepare(`SELECT ${RECORD_COLUMNS}, geometry FROM ic_records WHERE id = ?`).bind(id).first<RecordRow & { geometry: string | null }>();
    return row ? { record: toRecord(row), geometry: row.geometry ? parseJson<unknown>(row.geometry, null) : null } : null;
}

export async function listRecords(
    db: D1Database,
    filters: Partial<RecordFilters> & {
        kinds?: RecordKind[];
        categories?: HazardCategory[];
        sources?: string[];
        bbox?: [number, number, number, number];
        since?: string;
    },
    limit = 500,
): Promise<{ records: CentreRecord[]; truncated: boolean }> {
    const where: string[] = [];
    const binds: unknown[] = [];
    if (!filters.includeInactive) where.push("active = 1");
    if (filters.category) {
        where.push("category = ?");
        binds.push(filters.category);
    }
    if (filters.categories?.length) {
        where.push(`category IN (${filters.categories.map(() => "?").join(",")})`);
        binds.push(...filters.categories);
    }
    if (filters.kind) {
        where.push("kind = ?");
        binds.push(filters.kind);
    }
    if (filters.kinds?.length) {
        where.push(`kind IN (${filters.kinds.map(() => "?").join(",")})`);
        binds.push(...filters.kinds);
    }
    if (filters.source) {
        where.push("source_id = ?");
        binds.push(filters.source);
    }
    if (filters.sources?.length) {
        where.push(`source_id IN (${filters.sources.map(() => "?").join(",")})`);
        binds.push(...filters.sources);
    }
    if (filters.minLevel) {
        where.push("severity_rank >= ?");
        binds.push(filters.minLevel);
    }
    if (filters.q) {
        where.push("(title LIKE ? ESCAPE '\\' OR area_name LIKE ? ESCAPE '\\' OR event_type LIKE ? ESCAPE '\\')");
        const like = `%${filters.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        binds.push(like, like, like);
    }
    if (filters.bbox) {
        // Points inside the box, or areas whose bounding box meets it.
        const [w, s, e, n] = filters.bbox;
        where.push("((lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?) OR (max_lat >= ? AND min_lat <= ? AND max_lon >= ? AND min_lon <= ?))");
        binds.push(s, n, w, e, s, n, w, e);
    }
    if (filters.since) {
        where.push("COALESCE(observed_at, updated_at, published_at, first_seen_at) >= ?");
        binds.push(filters.since);
    }
    const sql = `SELECT ${RECORD_COLUMNS} FROM ic_records ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY severity_rank DESC, COALESCE(updated_at, published_at, observed_at, first_seen_at) DESC LIMIT ?`;
    const rows = await db
        .prepare(sql)
        .bind(...binds, limit + 1)
        .all<RecordRow>();
    return { records: rows.results.slice(0, limit).map(toRecord), truncated: rows.results.length > limit };
}

export async function listChanges(db: D1Database, options: { since?: string; recordId?: string; limit?: number; minRank?: number; kinds?: ChangeKind[] } = {}) {
    const where: string[] = [];
    const binds: unknown[] = [];
    if (options.since) {
        where.push("c.at >= ?");
        binds.push(options.since);
    }
    if (options.recordId) {
        where.push("c.record_id = ?");
        binds.push(options.recordId);
    }
    if (options.minRank) {
        where.push("c.severity_rank >= ?");
        binds.push(options.minRank);
    }
    if (options.kinds?.length) {
        where.push(`c.kind IN (${options.kinds.map(() => "?").join(",")})`);
        binds.push(...options.kinds);
    }
    const rows = await db
        .prepare(
            `SELECT c.*, r.category, r.title FROM ic_changes c LEFT JOIN ic_records r ON r.id = c.record_id
             ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY c.at DESC LIMIT ?`,
        )
        .bind(...binds, options.limit ?? 200)
        .all<ChangeRow>();
    return rows.results.map(toChange);
}

export async function seriesFor(db: D1Database, recordId: string, since: string) {
    const rows = await db
        .prepare("SELECT metric, at, value FROM ic_series WHERE record_id = ? AND at >= ? ORDER BY metric, at LIMIT 5000")
        .bind(recordId, since)
        .all<{ metric: string; at: string; value: number }>();
    const out = new Map<string, { at: string; value: number }[]>();
    for (const r of rows.results) out.set(r.metric, [...(out.get(r.metric) ?? []), { at: r.at, value: r.value }]);
    return [...out].map(([metric, points]) => ({ metric, points }));
}

// --- Sources ---------------------------------------------------------------------------------------

export interface SourceRow {
    id: string;
    enabled: number;
    last_attempt_at: string | null;
    last_success_at: string | null;
    last_published_at: string | null;
    next_due_at: string | null;
    record_count: number;
    consecutive_failures: number;
    error_code: string | null;
    error_message: string | null;
    etag: string | null;
    last_modified: string | null;
    content_hash: string | null;
    state: string;
    lease_until: string | null;
    lease_token: string | null;
    fixture: number;
}

/** One row per implemented source (switched off), created the first time anything asks. */
export async function ensureSources(db: D1Database): Promise<void> {
    const now = nowIso();
    await db.batch(IMPLEMENTED_SOURCES.map((s) => db.prepare("INSERT OR IGNORE INTO ic_sources (id, enabled, updated_at) VALUES (?, 0, ?)").bind(s.id, now)));
}

export async function sourceRows(db: D1Database): Promise<Map<string, SourceRow>> {
    const rows = await db.prepare("SELECT * FROM ic_sources").all<SourceRow>();
    return new Map(rows.results.map((r) => [r.id, r]));
}

export const secretFor = (env: Env, source: SourceDefinition): string | null =>
    source.secretName ? ((env as unknown as Record<string, unknown>)[source.secretName] as string | undefined)?.trim() || null : null;

/** The status rules (docs/INTELLIGENCE_SOURCES.md#statuses). Active only after a validated retrieval. */
export function statusOf(env: Env, source: SourceDefinition, row: SourceRow | undefined, now = Date.now()): { status: SourceStatus; detail: string } {
    if (!source.implemented) {
        const status: SourceStatus =
            source.eligibility === "restricted" ? "restricted" : source.eligibility === "needs_registration" ? "needs_registration" : "unsupported";
        return { status, detail: source.notes };
    }
    if (source.authentication === "free_api_key" && !secretFor(env, source))
        return { status: "needs_registration", detail: `Register for a free key, then add it as the ${source.secretName} Worker secret.` };
    if (!row?.enabled)
        return {
            status: "disabled",
            detail: source.eligibility === "awaiting_verification" ? "Off. Confirm the provider's terms fit your use before switching it on." : "Off.",
        };
    if (!row.last_success_at) {
        if (row.consecutive_failures) return { status: "error", detail: row.error_message ?? "The last attempt failed." };
        return { status: "awaiting_verification", detail: "Switched on. It becomes Active after its first successful, validated retrieval." };
    }
    if (row.consecutive_failures >= 3 && row.error_code === "http_error" && /404|410/.test(row.error_message ?? ""))
        return { status: "unavailable", detail: row.error_message ?? "The provider no longer serves this." };
    if (now - Date.parse(row.last_success_at) > source.staleAfterMinutes * 60_000)
        return {
            status: "stale",
            detail: `No successful retrieval for over ${Math.round(source.staleAfterMinutes / 60)} hours.${row.error_message ? ` Last error: ${row.error_message}` : ""}`,
        };
    if (row.consecutive_failures)
        return { status: "error", detail: `${row.error_message ?? "The last attempt failed."} Showing data from the last successful retrieval.` };
    return { status: "active", detail: "Retrieved and validated." };
}

export async function sourceHealth(env: Env): Promise<SourceHealth[]> {
    await ensureSources(env.DB);
    const rows = await sourceRows(env.DB);
    return (SOURCES as readonly SourceDefinition[]).map((source) => {
        const row = rows.get(source.id);
        const { status, detail } = statusOf(env, source, row);
        return {
            source,
            enabled: !!row?.enabled,
            status,
            statusDetail: detail,
            credentialsPresent: source.authentication !== "free_api_key" || !!secretFor(env, source),
            lastAttemptAt: row?.last_attempt_at ?? null,
            lastSuccessAt: row?.last_success_at ?? null,
            lastPublishedAt: row?.last_published_at ?? null,
            nextDueAt: row?.enabled ? (row.next_due_at ?? null) : null,
            recordCount: row?.record_count ?? 0,
            consecutiveFailures: row?.consecutive_failures ?? 0,
            errorMessage: row?.error_message ?? null,
            fixture: row?.fixture === 1,
        };
    });
}

export async function setSourceEnabled(db: D1Database, user: PortalUser, id: string, enabled: boolean) {
    const source = sourceById(id);
    if (!source?.implemented) throw new HttpError(404, "not_found", "No such source");
    if (source.eligibility === "restricted" || source.eligibility === "unsupported")
        throw new HttpError(409, "not_eligible", "This source can't be switched on");
    await ensureSources(db);
    const now = nowIso();
    await db.batch([
        db
            .prepare(
                "UPDATE ic_sources SET enabled = ?, next_due_at = CASE WHEN ? = 1 THEN ? ELSE next_due_at END, updated_at = ?, updated_by = ? WHERE id = ?",
            )
            .bind(enabled ? 1 : 0, enabled ? 1 : 0, now, now, user.email, id),
        auditStatement(db, {
            actor: user.email,
            action: enabled ? "centre.source.enable" : "centre.source.disable",
            entityType: "centre_source",
            entityId: id,
            summary: `${enabled ? "Switched on" : "Switched off"} ${source.provider}: ${source.dataset}`,
        }),
    ]);
}

export async function listRuns(db: D1Database, options: { sourceId?: string; limit?: number } = {}): Promise<FetchRun[]> {
    const rows = await db
        .prepare(`SELECT * FROM ic_fetch_runs ${options.sourceId ? "WHERE source_id = ?" : ""} ORDER BY started_at DESC LIMIT ?`)
        .bind(...(options.sourceId ? [options.sourceId] : []), options.limit ?? 100)
        .all<{
            id: string;
            source_id: string;
            started_at: string;
            outcome: FetchRun["outcome"];
            http_status: number | null;
            bytes: number;
            records: number;
            created: number;
            changed: number;
            ms: number;
            error_code: string | null;
        }>();
    return rows.results.map((r) => ({
        id: r.id,
        sourceId: r.source_id,
        startedAt: r.started_at,
        outcome: r.outcome,
        httpStatus: r.http_status,
        bytes: r.bytes,
        records: r.records,
        created: r.created,
        changed: r.changed,
        ms: r.ms,
        errorCode: r.error_code,
    }));
}

// --- Settings and preferences ----------------------------------------------------------------------

const SETTINGS_KEY = "settings";

export async function loadCentreSettings(db: D1Database): Promise<{ settings: CentreSettings; version: number }> {
    const row = await db.prepare("SELECT value, version FROM ic_config WHERE key = ?").bind(SETTINGS_KEY).first<{ value: string; version: number }>();
    if (!row) return { settings: DEFAULT_CENTRE_SETTINGS, version: 0 };
    const parsed = centreSettingsSchema.safeParse({ ...DEFAULT_CENTRE_SETTINGS, ...parseJson<object>(row.value, {}) });
    return { settings: parsed.success ? parsed.data : DEFAULT_CENTRE_SETTINGS, version: row.version };
}

export async function saveCentreSettings(db: D1Database, user: PortalUser, input: unknown, version: number) {
    const settings = centreSettingsSchema.parse(input);
    const before = await loadCentreSettings(db);
    if (before.version !== version) throw new HttpError(409, "conflict", "Someone else changed these settings. Reload to see their changes.");
    const now = nowIso();
    const write =
        version === 0
            ? db
                  .prepare("INSERT INTO ic_config (key, value, version, updated_at, updated_by) VALUES (?, ?, 1, ?, ?) ON CONFLICT DO NOTHING")
                  .bind(SETTINGS_KEY, JSON.stringify(settings), now, user.email)
            : db
                  .prepare("UPDATE ic_config SET value = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE key = ? AND version = ?")
                  .bind(JSON.stringify(settings), now, user.email, SETTINGS_KEY, version);
    const [result] = await db.batch([
        write,
        auditStatement(db, {
            actor: user.email,
            action: "centre.settings.update",
            entityType: "centre_settings",
            entityId: SETTINGS_KEY,
            summary: "Changed Intelligence Centre settings",
        }),
    ]);
    if (!result.meta.changes) throw new HttpError(409, "conflict", "Someone else changed these settings. Reload to see their changes.");
    return loadCentreSettings(db);
}

export async function loadPreferences(db: D1Database, email: string): Promise<{ preferences: CentrePreferences; version: number }> {
    const row = await db.prepare("SELECT value, version FROM ic_preferences WHERE email = ?").bind(email).first<{ value: string; version: number }>();
    if (!row) return { preferences: DEFAULT_CENTRE_PREFERENCES, version: 0 };
    const parsed = centrePreferencesSchema.safeParse({ ...DEFAULT_CENTRE_PREFERENCES, ...parseJson<object>(row.value, {}) });
    return { preferences: parsed.success ? parsed.data : DEFAULT_CENTRE_PREFERENCES, version: row.version };
}

export async function savePreferences(db: D1Database, email: string, input: unknown, version: number) {
    const preferences = centrePreferencesSchema.parse(input);
    const now = nowIso();
    const result =
        version === 0
            ? await db
                  .prepare("INSERT INTO ic_preferences (email, value, version, updated_at) VALUES (?, ?, 1, ?) ON CONFLICT DO NOTHING")
                  .bind(email, JSON.stringify(preferences), now)
                  .run()
            : await db
                  .prepare("UPDATE ic_preferences SET value = ?, version = version + 1, updated_at = ? WHERE email = ? AND version = ?")
                  .bind(JSON.stringify(preferences), now, email, version)
                  .run();
    if (!result.meta.changes) throw new HttpError(409, "conflict", "These preferences were changed elsewhere. Reload and try again.");
    return loadPreferences(db, email);
}
