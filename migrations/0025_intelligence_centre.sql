-- Daly Intelligence Centre (Milestone 9): public hazard and environmental information, private
-- watch areas, alerts and wallboards. See docs/INTELLIGENCE_CENTRE.md and docs/INTELLIGENCE_SOURCES.md.
--
-- Additive only: new tables, nothing altered, mcp_writes untouched (the MCP tools are read-only).
-- The previous Worker never reads these tables, so a rollback leaves them unused. Every source
-- starts switched off, and scheduled collection needs the intelligence_centre.ingestion switch.
--
-- Public records (ic_records and below) are the same for everyone. Watch areas, alerts,
-- preferences and wallboards belong to one person and are always read joined to their email.

-- One row per implemented source: whether it's on, and how its collection is going. What the
-- source is (provider, licence, attribution) lives in code (src/shared/centre/sources.ts).
CREATE TABLE ic_sources (
    id TEXT PRIMARY KEY CHECK (length(id) <= 40),
    enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
    last_attempt_at TEXT,
    last_success_at TEXT,
    -- The newest publication time seen in the source's own data (replayed or older responses are refused).
    last_published_at TEXT,
    next_due_at TEXT,
    record_count INTEGER NOT NULL DEFAULT 0,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    -- A short code and a sentence for people. Never a URL with a key in it, never a response body.
    error_code TEXT CHECK (error_code IS NULL OR length(error_code) <= 40),
    error_message TEXT CHECK (error_message IS NULL OR length(error_message) <= 300),
    etag TEXT CHECK (etag IS NULL OR length(etag) <= 200),
    last_modified TEXT CHECK (last_modified IS NULL OR length(last_modified) <= 100),
    content_hash TEXT CHECK (content_hash IS NULL OR length(content_hash) <= 80),
    -- Adapter cursor (e.g. which BoM product ids are warnings), validated by the adapter.
    state TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(state) AND length(state) <= 20000),
    -- A collection run holds the lease so two cron invocations never collect the same source at once.
    lease_until TEXT,
    lease_token TEXT,
    -- Records collected from a recorded fixture or a local stand-in (development and tests only).
    fixture INTEGER NOT NULL DEFAULT 0 CHECK (fixture IN (0, 1)),
    updated_at TEXT NOT NULL,
    updated_by TEXT
);

-- Each collection attempt: source reliability history. Ids, counts and codes only.
CREATE TABLE ic_fetch_runs (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    started_at TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'unchanged', 'error', 'rejected')),
    http_status INTEGER,
    bytes INTEGER NOT NULL DEFAULT 0,
    records INTEGER NOT NULL DEFAULT 0,
    created INTEGER NOT NULL DEFAULT 0,
    changed INTEGER NOT NULL DEFAULT 0,
    ms INTEGER NOT NULL DEFAULT 0,
    error_code TEXT CHECK (error_code IS NULL OR length(error_code) <= 40),
    trigger TEXT NOT NULL DEFAULT 'cron' CHECK (trigger IN ('cron', 'manual'))
);
CREATE INDEX ic_fetch_runs_source ON ic_fetch_runs (source_id, started_at);
CREATE INDEX ic_fetch_runs_started ON ic_fetch_runs (started_at);

-- The canonical record: an incident, warning, rating, observation station, disruption or
-- detection, keyed by its provider's own id. Unrelated records are never merged.
CREATE TABLE ic_records (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    external_id TEXT NOT NULL CHECK (length(external_id) <= 200),
    kind TEXT NOT NULL CHECK (kind IN ('incident', 'warning', 'rating', 'observation', 'disruption', 'detection', 'event')),
    category TEXT NOT NULL CHECK (length(category) <= 20),
    event_type TEXT CHECK (event_type IS NULL OR length(event_type) <= 120),
    title TEXT NOT NULL CHECK (length(title) <= 300),
    description TEXT CHECK (description IS NULL OR length(description) <= 8000),
    status TEXT CHECK (status IS NULL OR length(status) <= 120),
    -- Exactly as the provider published it. Never inferred.
    warning_level TEXT CHECK (warning_level IS NULL OR length(warning_level) <= 60),
    severity_rank INTEGER NOT NULL DEFAULT 0,
    lat REAL CHECK (lat IS NULL OR lat BETWEEN -90 AND 90),
    lon REAL CHECK (lon IS NULL OR lon BETWEEN -180 AND 180),
    min_lat REAL, min_lon REAL, max_lat REAL, max_lon REAL,
    -- Validated, size-limited GeoJSON geometry published by the provider (null: none published).
    geometry TEXT CHECK (geometry IS NULL OR (json_valid(geometry) AND length(geometry) <= 400000)),
    geometry_quality TEXT NOT NULL DEFAULT 'none' CHECK (geometry_quality IN ('point', 'polygon', 'line', 'district', 'area_text', 'none')),
    uncertainty_m REAL,
    area_name TEXT CHECK (area_name IS NULL OR length(area_name) <= 300),
    published_at TEXT,
    updated_at TEXT,
    observed_at TEXT,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    missing_since TEXT,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    source_url TEXT CHECK (source_url IS NULL OR length(source_url) <= 500),
    -- Hash of the fields that matter, to tell a real change from a re-send.
    fingerprint TEXT NOT NULL,
    geometry_hash TEXT,
    metrics TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(metrics) AND length(metrics) <= 8000),
    attrs TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(attrs) AND length(attrs) <= 8000),
    fixture INTEGER NOT NULL DEFAULT 0 CHECK (fixture IN (0, 1)),
    UNIQUE (source_id, external_id)
);
CREATE INDEX ic_records_active ON ic_records (active, category, severity_rank);
CREATE INDEX ic_records_source ON ic_records (source_id, active);
CREATE INDEX ic_records_place ON ic_records (lat, lon) WHERE lat IS NOT NULL;
CREATE INDEX ic_records_seen ON ic_records (last_seen_at);

-- Meaningful changes, detected deterministically between collections.
CREATE TABLE ic_changes (
    id TEXT PRIMARY KEY,
    record_id TEXT,
    source_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (length(kind) <= 30),
    at TEXT NOT NULL,
    from_value TEXT CHECK (from_value IS NULL OR length(from_value) <= 300),
    to_value TEXT CHECK (to_value IS NULL OR length(to_value) <= 300),
    summary TEXT NOT NULL CHECK (length(summary) <= 500),
    severity_rank INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ic_changes_at ON ic_changes (at);
CREATE INDEX ic_changes_record ON ic_changes (record_id, at) WHERE record_id IS NOT NULL;

-- Measurements over time (river levels, temperatures, air quality), where terms allow history.
CREATE TABLE ic_series (
    record_id TEXT NOT NULL,
    metric TEXT NOT NULL CHECK (length(metric) <= 40),
    at TEXT NOT NULL,
    value REAL NOT NULL,
    PRIMARY KEY (record_id, metric, at)
);
CREATE INDEX ic_series_at ON ic_series (at);

-- Private watch areas. The definition can be a home: it is never logged, audited, sent to a model,
-- returned over MCP or given to a wallboard display.
CREATE TABLE ic_watch_areas (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL COLLATE NOCASE,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
    kind TEXT NOT NULL CHECK (kind IN ('point', 'polygon', 'region', 'fire_district', 'gauge', 'corridor', 'incident')),
    definition TEXT NOT NULL CHECK (json_valid(definition) AND length(definition) <= 20000),
    fire_district TEXT CHECK (fire_district IS NULL OR length(fire_district) <= 80),
    min_lat REAL, min_lon REAL, max_lat REAL, max_lon REAL,
    categories TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(categories)),
    min_level INTEGER NOT NULL DEFAULT 0 CHECK (min_level BETWEEN 0 AND 3),
    notify_in_app INTEGER NOT NULL DEFAULT 1 CHECK (notify_in_app IN (0, 1)),
    notify_email INTEGER NOT NULL DEFAULT 0 CHECK (notify_email IN (0, 1)),
    quiet_start TEXT, quiet_end TEXT,
    expires_at TEXT,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX ic_watch_areas_email ON ic_watch_areas (email);
CREATE INDEX ic_watch_areas_enabled ON ic_watch_areas (enabled);

-- In-app alerts. One per person per change (the unique key makes generation idempotent: two cron
-- runs can't alert or email twice). Email delivery is opt-in and behind its own switch.
CREATE TABLE ic_alerts (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL COLLATE NOCASE,
    watch_id TEXT,
    record_id TEXT,
    change_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (length(kind) <= 30),
    title TEXT NOT NULL CHECK (length(title) <= 300),
    detail TEXT CHECK (detail IS NULL OR length(detail) <= 500),
    url TEXT NOT NULL CHECK (length(url) <= 500),
    level_rank INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    acknowledged_at TEXT,
    email_status TEXT CHECK (email_status IS NULL OR email_status IN ('pending', 'sending', 'sent', 'skipped', 'failed')),
    email_attempts INTEGER NOT NULL DEFAULT 0,
    emailed_at TEXT,
    UNIQUE (email, change_id)
);
CREATE INDEX ic_alerts_inbox ON ic_alerts (email, created_at) WHERE acknowledged_at IS NULL;
CREATE INDEX ic_alerts_email ON ic_alerts (created_at) WHERE email_status = 'pending';

-- Each person's preferences (Today section, emails, quiet hours, calendar matching).
CREATE TABLE ic_preferences (
    email TEXT PRIMARY KEY COLLATE NOCASE,
    value TEXT NOT NULL CHECK (json_valid(value) AND length(value) <= 4000),
    version INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
);

-- Account settings (retention, gauges, correlation distances): one document.
CREATE TABLE ic_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL CHECK (json_valid(value) AND length(value) <= 8000),
    version INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL
);

-- Interpretations a model wrote about a briefing's facts, reused while the facts are unchanged.
CREATE TABLE ic_briefings (
    email TEXT NOT NULL COLLATE NOCASE,
    scope TEXT NOT NULL CHECK (length(scope) <= 40),
    fingerprint TEXT NOT NULL,
    interpretation TEXT NOT NULL CHECK (json_valid(interpretation) AND length(interpretation) <= 8000),
    model TEXT,
    generated_at TEXT NOT NULL,
    PRIMARY KEY (email, scope)
);

-- Wallboard profiles, owned by one person.
CREATE TABLE ic_wallboards (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL COLLATE NOCASE,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
    config TEXT NOT NULL CHECK (json_valid(config) AND length(config) <= 4000),
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX ic_wallboards_email ON ic_wallboards (email);

-- Display credentials: each one reads one wallboard and nothing else. Only a SHA-256 hash of the
-- token is stored; the token itself is shown once. Revoking is immediate.
CREATE TABLE ic_display_tokens (
    id TEXT PRIMARY KEY,
    wallboard_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 60),
    created_by TEXT NOT NULL COLLATE NOCASE,
    created_at TEXT NOT NULL,
    expires_at TEXT,
    revoked_at TEXT,
    last_used_at TEXT,
    uses INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ic_display_tokens_board ON ic_display_tokens (wallboard_id);
