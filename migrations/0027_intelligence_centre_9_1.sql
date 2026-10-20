-- Intelligence Centre 9.1 (Milestone 9.1): versioned history for timelines and replay, source
-- reliability rollups, monitoring rules, situation reports, wallboard views (widget layouts),
-- renewable display credentials, journey links and an analytics cache. See
-- docs/INTELLIGENCE_CENTRE_9_1.md.
--
-- Additive except for one step: mcp_writes is rebuilt (every row copied) so an MCP write can record
-- a monitoring rule, a report or a report schedule as its outcome, the same pattern as 0020–0026.
-- Existing tables only gain nullable or defaulted columns (ALTER TABLE ADD COLUMN), so a populated
-- database migrates in place and the previous Worker keeps working: it never reads the new tables
-- or columns, and only writes entity types the rebuilt ledger still accepts.
--
-- Historical integrity: a version row is what a collection stored at that moment (valid_from), and
-- stays that way. Nothing here back-fills the past: records already present when versioning first
-- runs get a "baseline" version dated then, and anything earlier is only in ic_changes.
--
-- Rules, matches, reports, schedules and links belong to one person and are always read joined to
-- their email. Reports' full text lives in R2 (MEDIA, under private/centre/reports/), never in logs.

-- --- Versioned record history ---------------------------------------------------------------------

-- One row per state a record was stored in. valid_to is when a later collection replaced it (null:
-- still the latest). Only sources whose terms allow history are versioned, and observations
-- (measured every collection) are kept as series instead. Descriptions are capped at 2,000 characters.
CREATE TABLE ic_record_versions (
    id TEXT PRIMARY KEY,
    record_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    seq INTEGER NOT NULL CHECK (seq >= 1),
    valid_from TEXT NOT NULL,
    valid_to TEXT,
    -- Already in the feed when versioning began: its earlier states weren't recorded.
    baseline INTEGER NOT NULL DEFAULT 0 CHECK (baseline IN (0, 1)),
    -- The change that produced this version (new, escalated, ended…), when one was detected.
    change_kind TEXT CHECK (change_kind IS NULL OR length(change_kind) <= 30),
    kind TEXT NOT NULL CHECK (length(kind) <= 20),
    category TEXT NOT NULL CHECK (length(category) <= 20),
    event_type TEXT CHECK (event_type IS NULL OR length(event_type) <= 120),
    title TEXT NOT NULL CHECK (length(title) <= 300),
    description TEXT CHECK (description IS NULL OR length(description) <= 2000),
    status TEXT CHECK (status IS NULL OR length(status) <= 120),
    warning_level TEXT CHECK (warning_level IS NULL OR length(warning_level) <= 60),
    severity_rank INTEGER NOT NULL DEFAULT 0,
    lat REAL, lon REAL, min_lat REAL, min_lon REAL, max_lat REAL, max_lon REAL,
    geometry_quality TEXT NOT NULL DEFAULT 'none' CHECK (length(geometry_quality) <= 20),
    geometry_hash TEXT CHECK (geometry_hash IS NULL OR length(geometry_hash) <= 80),
    uncertainty_m REAL,
    area_name TEXT CHECK (area_name IS NULL OR length(area_name) <= 300),
    published_at TEXT,
    updated_at TEXT,
    observed_at TEXT,
    active INTEGER NOT NULL CHECK (active IN (0, 1)),
    -- Not in the provider's latest complete listing (never the same as ended or resolved).
    missing INTEGER NOT NULL DEFAULT 0 CHECK (missing IN (0, 1)),
    source_url TEXT CHECK (source_url IS NULL OR length(source_url) <= 500),
    metrics TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(metrics) AND length(metrics) <= 8000),
    attrs TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(attrs) AND length(attrs) <= 8000),
    fixture INTEGER NOT NULL DEFAULT 0 CHECK (fixture IN (0, 1)),
    UNIQUE (record_id, seq)
);
CREATE INDEX ic_record_versions_record ON ic_record_versions (record_id, valid_from);
CREATE INDEX ic_record_versions_from ON ic_record_versions (valid_from);
CREATE INDEX ic_record_versions_to ON ic_record_versions (valid_to);
CREATE INDEX ic_record_versions_source ON ic_record_versions (source_id, valid_from);

-- Published areas, stored once per distinct shape (versions refer to them by hash).
CREATE TABLE ic_geometries (
    hash TEXT PRIMARY KEY CHECK (length(hash) <= 80),
    geometry TEXT NOT NULL CHECK (json_valid(geometry) AND length(geometry) <= 400000),
    first_seen_at TEXT NOT NULL
);

-- --- Source reliability ---------------------------------------------------------------------------

-- Publication-to-collection delay of each run, in seconds (null: the provider gave no time).
ALTER TABLE ic_fetch_runs ADD COLUMN delay_s INTEGER;

-- One row per source per UTC day, kept far longer than individual runs: availability, timing,
-- delay and the longest gap between successful retrievals (which replay uses to flag outages).
CREATE TABLE ic_source_daily (
    source_id TEXT NOT NULL CHECK (length(source_id) <= 40),
    day TEXT NOT NULL CHECK (length(day) = 10),
    attempts INTEGER NOT NULL DEFAULT 0,
    ok INTEGER NOT NULL DEFAULT 0,
    unchanged INTEGER NOT NULL DEFAULT 0,
    errors INTEGER NOT NULL DEFAULT 0,
    rejected INTEGER NOT NULL DEFAULT 0,
    total_ms INTEGER NOT NULL DEFAULT 0,
    max_ms INTEGER NOT NULL DEFAULT 0,
    bytes INTEGER NOT NULL DEFAULT 0,
    records_max INTEGER NOT NULL DEFAULT 0,
    created INTEGER NOT NULL DEFAULT 0,
    changed INTEGER NOT NULL DEFAULT 0,
    delay_total_s INTEGER NOT NULL DEFAULT 0,
    delay_count INTEGER NOT NULL DEFAULT 0,
    delay_max_s INTEGER NOT NULL DEFAULT 0,
    first_success_at TEXT,
    last_success_at TEXT,
    longest_gap_minutes INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (source_id, day)
);
CREATE INDEX ic_source_daily_day ON ic_source_daily (day);

CREATE INDEX ic_changes_source ON ic_changes (source_id, at);
CREATE INDEX ic_changes_kind ON ic_changes (kind, at);

-- --- Monitoring rules -----------------------------------------------------------------------------

-- A person's own deterministic rule: a condition with a threshold in stated units, over one of
-- their watch areas (never new coordinates). Their thresholds aren't official thresholds.
CREATE TABLE ic_rules (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL COLLATE NOCASE,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
    condition TEXT NOT NULL CHECK (
        condition IN (
            'official_level', 'fire_within', 'road_on_corridor', 'gauge_threshold', 'wind_gust', 'temperature',
            'total_fire_ban', 'earthquake', 'source_stale'
        )
    ),
    definition TEXT NOT NULL CHECK (json_valid(definition) AND length(definition) <= 4000),
    watch_id TEXT,
    lookback_minutes INTEGER NOT NULL CHECK (lookback_minutes BETWEEN 15 AND 10080),
    cooldown_minutes INTEGER NOT NULL CHECK (cooldown_minutes BETWEEN 0 AND 10080),
    notify TEXT NOT NULL DEFAULT 'in_app' CHECK (notify IN ('none', 'in_app', 'email')),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    version INTEGER NOT NULL DEFAULT 1,
    last_evaluated_at TEXT,
    last_matched_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX ic_rules_email ON ic_rules (email);
CREATE INDEX ic_rules_enabled ON ic_rules (enabled);

-- Why a rule matched, once per rule and subject (the unique key makes evaluation idempotent: two
-- cron runs can't match or notify twice). suppressed: matched inside the cooldown, not notified.
CREATE TABLE ic_rule_matches (
    id TEXT PRIMARY KEY,
    rule_id TEXT NOT NULL,
    email TEXT NOT NULL COLLATE NOCASE,
    dedupe_key TEXT NOT NULL CHECK (length(dedupe_key) <= 200),
    at TEXT NOT NULL,
    record_id TEXT,
    source_id TEXT CHECK (source_id IS NULL OR length(source_id) <= 40),
    reason TEXT NOT NULL CHECK (length(reason) <= 600),
    observed_value REAL,
    threshold REAL,
    unit TEXT CHECK (unit IS NULL OR length(unit) <= 10),
    evidence_at TEXT,
    notified INTEGER NOT NULL DEFAULT 0 CHECK (notified IN (0, 1)),
    suppressed TEXT CHECK (suppressed IS NULL OR suppressed IN ('cooldown', 'rate_limit', 'disabled')),
    task_id TEXT,
    acknowledged_at TEXT,
    UNIQUE (rule_id, dedupe_key)
);
CREATE INDEX ic_rule_matches_email ON ic_rule_matches (email, at);
CREATE INDEX ic_rule_matches_rule ON ic_rule_matches (rule_id, at);

-- --- Situation reports ----------------------------------------------------------------------------

-- A generated report: metadata here, the full report (facts, sources, gaps) in R2 at object_key.
CREATE TABLE ic_reports (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL COLLATE NOCASE,
    title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
    scope TEXT NOT NULL CHECK (json_valid(scope) AND length(scope) <= 2000),
    period_from TEXT,
    period_to TEXT NOT NULL,
    generated_at TEXT NOT NULL,
    fingerprint TEXT NOT NULL CHECK (length(fingerprint) <= 80),
    facts INTEGER NOT NULL DEFAULT 0,
    object_key TEXT NOT NULL CHECK (length(object_key) <= 200),
    -- An optional AI narrative of the validated facts, grounded like briefings.
    narrative TEXT CHECK (narrative IS NULL OR (json_valid(narrative) AND length(narrative) <= 8000)),
    narrative_model TEXT,
    schedule_id TEXT,
    knowledge_object_id TEXT,
    trigger TEXT NOT NULL DEFAULT 'manual' CHECK (trigger IN ('manual', 'schedule', 'mcp'))
);
CREATE INDEX ic_reports_email ON ic_reports (email, generated_at);
CREATE INDEX ic_reports_schedule ON ic_reports (schedule_id, generated_at) WHERE schedule_id IS NOT NULL;

CREATE TABLE ic_report_schedules (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL COLLATE NOCASE,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
    scope TEXT NOT NULL CHECK (json_valid(scope) AND length(scope) <= 2000),
    frequency TEXT NOT NULL CHECK (frequency IN ('daily', 'weekly')),
    weekday INTEGER CHECK (weekday IS NULL OR weekday BETWEEN 0 AND 6),
    hour INTEGER NOT NULL CHECK (hour BETWEEN 0 AND 23),
    time_zone TEXT NOT NULL CHECK (length(time_zone) <= 60),
    period_hours INTEGER NOT NULL DEFAULT 24 CHECK (period_hours BETWEEN 1 AND 744),
    notify TEXT NOT NULL DEFAULT 'in_app' CHECK (notify IN ('none', 'in_app', 'email')),
    save_to_knowledge INTEGER NOT NULL DEFAULT 0 CHECK (save_to_knowledge IN (0, 1)),
    narrative INTEGER NOT NULL DEFAULT 0 CHECK (narrative IN (0, 1)),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    version INTEGER NOT NULL DEFAULT 1,
    next_run_at TEXT,
    last_run_at TEXT,
    last_report_id TEXT,
    last_fingerprint TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX ic_report_schedules_email ON ic_report_schedules (email);
CREATE INDEX ic_report_schedules_due ON ic_report_schedules (enabled, next_run_at);

-- --- Wallboards -----------------------------------------------------------------------------------

-- The views a wallboard shows (and rotates through, in position order): a preset or a custom grid
-- of widgets. A board without rows here shows the views its original layout and rotation describe.
CREATE TABLE ic_wallboard_views (
    id TEXT PRIMARY KEY,
    wallboard_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 20),
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
    preset TEXT NOT NULL CHECK (length(preset) <= 20),
    customised INTEGER NOT NULL DEFAULT 0 CHECK (customised IN (0, 1)),
    widgets TEXT NOT NULL CHECK (json_valid(widgets) AND json_type(widgets) = 'array' AND length(widgets) <= 24000),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX ic_wallboard_views_board ON ic_wallboard_views (wallboard_id, position);

-- Renewable display credentials: a screen near its expiry can swap its credential for a new one
-- (the owner's choice, per credential). The old hash keeps working for a short overlap only.
ALTER TABLE ic_display_tokens ADD COLUMN renewable INTEGER NOT NULL DEFAULT 0 CHECK (renewable IN (0, 1));
ALTER TABLE ic_display_tokens ADD COLUMN lifetime_days INTEGER CHECK (lifetime_days IS NULL OR lifetime_days BETWEEN 1 AND 730);
ALTER TABLE ic_display_tokens ADD COLUMN previous_hash TEXT;
ALTER TABLE ic_display_tokens ADD COLUMN previous_until TEXT;
ALTER TABLE ic_display_tokens ADD COLUMN renewed_at TEXT;
CREATE INDEX ic_display_tokens_previous ON ic_display_tokens (previous_hash) WHERE previous_hash IS NOT NULL;

-- --- Journeys and calendar events -----------------------------------------------------------------

-- A person's own calendar event linked to one of their watch areas (a route corridor or a
-- destination), so the Centre shows what concerns the trip around its dates. Ids only.
CREATE TABLE ic_event_links (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL COLLATE NOCASE,
    event_id TEXT NOT NULL CHECK (length(event_id) <= 64),
    watch_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (email, event_id, watch_id)
);
CREATE INDEX ic_event_links_email ON ic_event_links (email);

-- --- Analytics cache ------------------------------------------------------------------------------

-- Computed analytics over public records only (never anyone's watch areas), reused until expiry.
CREATE TABLE ic_cache (
    key TEXT PRIMARY KEY CHECK (length(key) <= 200),
    value TEXT NOT NULL CHECK (json_valid(value) AND length(value) <= 400000),
    computed_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);
CREATE INDEX ic_cache_expires ON ic_cache (expires_at);

-- --- MCP write ledger -----------------------------------------------------------------------------

-- SQLite can't widen a CHECK in place: rebuild mcp_writes with the Centre outcomes, copying every
-- row unchanged (same columns, order and indexes; nothing refers to the table).
CREATE TABLE mcp_writes_next (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    tool TEXT NOT NULL CHECK (length(tool) <= 64),
    -- The client's request id. Cleared when the write fails, so the same id can be tried again.
    request_key TEXT CHECK (request_key IS NULL OR length(request_key) BETWEEN 8 AND 64),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed')),
    entity_type TEXT CHECK (
        entity_type IS NULL OR entity_type IN (
            'task', 'task_knowledge_link', 'knowledge_object', 'task_project', 'ai_capture', 'ai_suggestion',
            'calendar_event', 'calendar_subscription', 'leave_booking', 'task_time_block',
            'asset', 'asset_maintenance', 'asset_link',
            'centre_rule', 'centre_report', 'centre_report_schedule'
        )
    ),
    entity_id TEXT CHECK (entity_id IS NULL OR length(entity_id) <= 64),
    error_code TEXT CHECK (error_code IS NULL OR length(error_code) <= 40),
    created_at TEXT NOT NULL,
    completed_at TEXT
);

INSERT INTO mcp_writes_next (id, email, tool, request_key, status, entity_type, entity_id, error_code, created_at, completed_at)
SELECT id, email, tool, request_key, status, entity_type, entity_id, error_code, created_at, completed_at FROM mcp_writes;

DROP TABLE mcp_writes;
ALTER TABLE mcp_writes_next RENAME TO mcp_writes;

CREATE UNIQUE INDEX mcp_writes_request ON mcp_writes (email, request_key) WHERE request_key IS NOT NULL;
CREATE INDEX mcp_writes_email ON mcp_writes (email, created_at);
