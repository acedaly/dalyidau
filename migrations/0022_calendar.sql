-- Daly Calendar, Family Planner and Leave Planner (Milestone 6). See docs/CALENDAR.md.
--
-- Additive except for one step: mcp_writes is rebuilt (every row copied) so an MCP write can record
-- a calendar event, a subscription or a leave booking as its outcome, the same pattern as 0020 and
-- 0021. The previous Worker never reads the new tables and only writes entity types the rebuilt
-- ledger still accepts.
--
-- Access is by calendar membership, like Tasks projects: every event, subscription and feed is
-- reached through the caller's calendar_members row. Leave records belong to one person only.
-- Activity rows hold ids, never titles, descriptions, locations or URLs.

-- --- Preferences --------------------------------------------------------------------------------

-- Each person's own choices (time zone, week start, default view, school division, overlays,
-- reminders and notifications). One JSON document, validated by the Worker (src/shared/calendar/types.ts).
CREATE TABLE calendar_preferences (
    email TEXT PRIMARY KEY,
    value TEXT NOT NULL CHECK (json_valid(value)),
    version INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
);

-- --- Calendars and membership -------------------------------------------------------------------

CREATE TABLE calendars (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
    description TEXT CHECK (description IS NULL OR length(description) <= 1000),
    color TEXT NOT NULL DEFAULT 'brand' CHECK (length(color) <= 20),
    -- personal: the owner's own (others can be given free/busy only); shared: household members.
    kind TEXT NOT NULL CHECK (kind IN ('personal', 'shared')),
    purpose TEXT NOT NULL DEFAULT 'general' CHECK (purpose IN ('general', 'family', 'work', 'school', 'care', 'birthdays', 'travel', 'subscription')),
    -- subscription calendars hold a read-only copy of an external ICS feed.
    source TEXT NOT NULL DEFAULT 'local' CHECK (source IN ('local', 'subscription')),
    time_zone TEXT NOT NULL DEFAULT 'Australia/Sydney',
    owner_email TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
    version INTEGER NOT NULL DEFAULT 1,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (is_default = 0 OR (kind = 'personal' AND source = 'local'))
);
CREATE UNIQUE INDEX calendars_default ON calendars (owner_email) WHERE is_default = 1;

CREATE TABLE calendar_members (
    calendar_id TEXT NOT NULL REFERENCES calendars (id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    -- freebusy members see only that a time is busy: never a title, place, description or attendee.
    role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer', 'freebusy')),
    -- Each person's own show/hide and colour for the calendar.
    hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
    color TEXT CHECK (color IS NULL OR length(color) <= 20),
    position INTEGER NOT NULL DEFAULT 0,
    added_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (calendar_id, email)
);
CREATE INDEX calendar_members_email ON calendar_members (email);

-- A personal calendar stays private: apart from its owner, people can only see free/busy.
CREATE TRIGGER calendar_members_personal_insert BEFORE INSERT ON calendar_members
WHEN (SELECT kind FROM calendars WHERE id = NEW.calendar_id) = 'personal'
    AND NEW.role <> 'freebusy' AND NEW.email <> (SELECT owner_email FROM calendars WHERE id = NEW.calendar_id)
BEGIN
    SELECT RAISE(ABORT, 'A personal calendar is shared as free/busy only');
END;
CREATE TRIGGER calendar_members_personal_update BEFORE UPDATE OF role ON calendar_members
WHEN (SELECT kind FROM calendars WHERE id = NEW.calendar_id) = 'personal'
    AND NEW.role <> 'freebusy' AND NEW.email <> (SELECT owner_email FROM calendars WHERE id = NEW.calendar_id)
BEGIN
    SELECT RAISE(ABORT, 'A personal calendar is shared as free/busy only');
END;
CREATE TRIGGER calendars_kind_personal BEFORE UPDATE OF kind ON calendars
WHEN NEW.kind = 'personal'
    AND EXISTS (SELECT 1 FROM calendar_members WHERE calendar_id = NEW.id AND role <> 'freebusy' AND email <> NEW.owner_email)
BEGIN
    SELECT RAISE(ABORT, 'Remove other members before making a calendar personal');
END;
-- Subscribed calendars are read-only copies: nobody can be an editor of one.
CREATE TRIGGER calendar_members_subscription_readonly BEFORE INSERT ON calendar_members
WHEN NEW.role = 'editor' AND (SELECT source FROM calendars WHERE id = NEW.calendar_id) = 'subscription'
BEGIN
    SELECT RAISE(ABORT, 'Subscribed calendars are read-only');
END;
CREATE TRIGGER calendar_members_subscription_readonly_update BEFORE UPDATE OF role ON calendar_members
WHEN NEW.role = 'editor' AND (SELECT source FROM calendars WHERE id = NEW.calendar_id) = 'subscription'
BEGIN
    SELECT RAISE(ABORT, 'Subscribed calendars are read-only');
END;

-- --- Events -------------------------------------------------------------------------------------

-- One row per event or recurring series. Times are stored as the wall-clock date and time in the
-- event's own IANA zone (so 9:00 stays 9:00 across daylight saving), plus the UTC instants of the
-- first occurrence and of the end of the series for window queries.
CREATE TABLE calendar_events (
    id TEXT PRIMARY KEY,
    calendar_id TEXT NOT NULL REFERENCES calendars (id) ON DELETE CASCADE,
    source TEXT NOT NULL DEFAULT 'local' CHECK (source IN ('local', 'subscription', 'import')),
    -- iCalendar UID: stable across edits, feeds and exports.
    uid TEXT NOT NULL CHECK (length(uid) BETWEEN 1 AND 255),
    title TEXT NOT NULL CHECK (length(title) <= 300),
    description TEXT CHECK (description IS NULL OR length(description) <= 8000),
    location TEXT CHECK (location IS NULL OR length(location) <= 500),
    url TEXT CHECK (url IS NULL OR length(url) <= 1000),
    all_day INTEGER NOT NULL CHECK (all_day IN (0, 1)),
    -- All-day: first and last day (inclusive). Timed: local start and end.
    start_date TEXT NOT NULL,
    start_time TEXT,
    end_date TEXT NOT NULL,
    end_time TEXT,
    time_zone TEXT NOT NULL,
    start_at TEXT NOT NULL,
    end_at TEXT NOT NULL,
    -- RFC 5545 RRULE (floating UNTIL), validated by the Worker; extra dates and excluded occurrences as occurrence keys.
    rrule TEXT CHECK (rrule IS NULL OR length(rrule) <= 500),
    rdates TEXT CHECK (rdates IS NULL OR json_valid(rdates)),
    exdates TEXT CHECK (exdates IS NULL OR json_valid(exdates)),
    -- The end of the last occurrence; '9999-12-31T00:00:00.000Z' for a series without an end.
    series_end_at TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'general' CHECK (
        category IN ('general', 'appointment', 'family', 'birthday', 'anniversary', 'school', 'travel', 'commitment', 'care', 'pickup', 'dropoff', 'work', 'other')
    ),
    color TEXT CHECK (color IS NULL OR length(color) <= 20),
    -- private: other members see "Busy"; sensitive (children, care, health): as private, and never
    -- shown with details in feeds, notifications, briefings or AI tools.
    visibility TEXT NOT NULL DEFAULT 'default' CHECK (visibility IN ('default', 'private', 'sensitive')),
    show_as TEXT NOT NULL DEFAULT 'busy' CHECK (show_as IN ('busy', 'free')),
    status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'tentative', 'cancelled')),
    -- Who an event concerns and who is responsible (pickups, care): names and one member email.
    people TEXT CHECK (people IS NULL OR json_valid(people)),
    -- Subscriptions: a hash of the source event, so an unchanged event isn't rewritten.
    content_hash TEXT,
    client_id TEXT CHECK (client_id IS NULL OR length(client_id) BETWEEN 8 AND 64),
    version INTEGER NOT NULL DEFAULT 1,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK ((all_day = 1 AND start_time IS NULL AND end_time IS NULL) OR (all_day = 0 AND start_time IS NOT NULL AND end_time IS NOT NULL)),
    CHECK (end_date >= start_date),
    CHECK (end_at >= start_at),
    CHECK (series_end_at >= end_at)
);
CREATE UNIQUE INDEX calendar_events_uid ON calendar_events (calendar_id, uid);
CREATE UNIQUE INDEX calendar_events_client ON calendar_events (created_by, client_id) WHERE client_id IS NOT NULL;
CREATE INDEX calendar_events_window ON calendar_events (calendar_id, start_at, series_end_at);

-- Local edits (and external RECURRENCE-ID instances) to single occurrences of a series, keyed on the
-- occurrence's original local start ('YYYY-MM-DD' or 'YYYY-MM-DDTHH:MM').
CREATE TABLE calendar_event_overrides (
    event_id TEXT NOT NULL REFERENCES calendar_events (id) ON DELETE CASCADE,
    occurrence_key TEXT NOT NULL CHECK (length(occurrence_key) BETWEEN 10 AND 16),
    cancelled INTEGER NOT NULL DEFAULT 0 CHECK (cancelled IN (0, 1)),
    -- Changed fields only (title, description, location, start/end dates and times, status), validated by the Worker.
    fields TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fields)),
    start_at TEXT,
    end_at TEXT,
    updated_by TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (event_id, occurrence_key)
);
CREATE INDEX calendar_event_overrides_moved ON calendar_event_overrides (start_at) WHERE start_at IS NOT NULL;

-- References from events to existing Tasks and Knowledge records: ids only, checked through each
-- module's own access on every read. Deleting the record removes the reference.
CREATE TABLE calendar_event_links (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES calendar_events (id) ON DELETE CASCADE,
    task_id TEXT REFERENCES task_items (id) ON DELETE CASCADE,
    project_id TEXT REFERENCES task_projects (id) ON DELETE CASCADE,
    object_id TEXT REFERENCES knowledge_objects (id) ON DELETE CASCADE,
    added_by TEXT NOT NULL,
    added_at TEXT NOT NULL,
    CHECK ((task_id IS NOT NULL) + (project_id IS NOT NULL) + (object_id IS NOT NULL) = 1)
);
CREATE UNIQUE INDEX calendar_event_links_unique ON calendar_event_links (event_id, coalesce(task_id, project_id, object_id));
CREATE INDEX calendar_event_links_task ON calendar_event_links (task_id) WHERE task_id IS NOT NULL;

-- Each person's own reminders on an event (every occurrence of a series).
CREATE TABLE calendar_reminders (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES calendar_events (id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    minutes_before INTEGER NOT NULL CHECK (minutes_before BETWEEN 0 AND 40320),
    created_at TEXT NOT NULL,
    UNIQUE (event_id, email, minutes_before)
);
CREATE INDEX calendar_reminders_email ON calendar_reminders (email);

-- In-app notifications and their optional email delivery. The unique key makes generation
-- idempotent: overlapping cron runs can't create (or email) the same notification twice.
CREATE TABLE calendar_notifications (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('event', 'leave', 'school', 'subscription')),
    ref_id TEXT NOT NULL,
    occurrence_key TEXT NOT NULL,
    fire_at TEXT NOT NULL,
    -- What the in-app list shows. Private and sensitive events are stored as "Private event".
    title TEXT NOT NULL CHECK (length(title) <= 300),
    detail TEXT CHECK (detail IS NULL OR length(detail) <= 300),
    url TEXT CHECK (url IS NULL OR length(url) <= 500),
    email_status TEXT CHECK (email_status IS NULL OR email_status IN ('pending', 'sending', 'sent', 'skipped', 'failed')),
    email_attempts INTEGER NOT NULL DEFAULT 0,
    emailed_at TEXT,
    dismissed_at TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (email, kind, ref_id, occurrence_key)
);
CREATE INDEX calendar_notifications_inbox ON calendar_notifications (email, fire_at) WHERE dismissed_at IS NULL;
CREATE INDEX calendar_notifications_email ON calendar_notifications (fire_at) WHERE email_status = 'pending';

-- --- External subscriptions ---------------------------------------------------------------------

-- The URL is a credential (Google's secret address, an iCloud share): stored encrypted when
-- CALENDAR_ENCRYPTION_KEY is set, never returned to the browser after it is added, never logged.
CREATE TABLE calendar_subscriptions (
    id TEXT PRIMARY KEY,
    calendar_id TEXT NOT NULL UNIQUE REFERENCES calendars (id) ON DELETE CASCADE,
    owner_email TEXT NOT NULL,
    url_secret TEXT NOT NULL,
    url_hash TEXT NOT NULL,
    url_display TEXT NOT NULL CHECK (length(url_display) <= 200),
    provider TEXT NOT NULL DEFAULT 'other' CHECK (provider IN ('google', 'apple', 'outlook', 'other')),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    refresh_minutes INTEGER NOT NULL DEFAULT 360 CHECK (refresh_minutes BETWEEN 60 AND 10080),
    etag TEXT CHECK (etag IS NULL OR length(etag) <= 200),
    last_modified TEXT CHECK (last_modified IS NULL OR length(last_modified) <= 100),
    next_refresh_at TEXT NOT NULL,
    lease_until TEXT,
    last_attempt_at TEXT,
    last_success_at TEXT,
    last_status TEXT CHECK (last_status IS NULL OR last_status IN ('ok', 'not_modified', 'error')),
    last_error_code TEXT CHECK (last_error_code IS NULL OR length(last_error_code) <= 40),
    last_error TEXT CHECK (last_error IS NULL OR length(last_error) <= 300),
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    failing_since TEXT,
    event_count INTEGER NOT NULL DEFAULT 0,
    last_bytes INTEGER,
    client_id TEXT CHECK (client_id IS NULL OR length(client_id) BETWEEN 8 AND 64),
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX calendar_subscriptions_url ON calendar_subscriptions (owner_email, url_hash);
CREATE UNIQUE INDEX calendar_subscriptions_client ON calendar_subscriptions (owner_email, client_id) WHERE client_id IS NOT NULL;
CREATE INDEX calendar_subscriptions_due ON calendar_subscriptions (next_refresh_at) WHERE enabled = 1;

-- --- Outbound feeds -----------------------------------------------------------------------------

-- Private ICS addresses for Apple Calendar, Outlook and Google Calendar. Only a SHA-256 hash of the
-- token is stored, so a database copy can't be used to read anyone's calendar.
CREATE TABLE calendar_feeds (
    id TEXT PRIMARY KEY,
    owner_email TEXT NOT NULL,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
    token_hash TEXT NOT NULL UNIQUE,
    token_hint TEXT NOT NULL CHECK (length(token_hint) <= 8),
    -- Which calendars, leave and task deadlines, and whether titles are included (validated by the Worker).
    scope TEXT NOT NULL CHECK (json_valid(scope)),
    created_at TEXT NOT NULL,
    rotated_at TEXT,
    revoked_at TEXT,
    last_accessed_at TEXT,
    access_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX calendar_feeds_owner ON calendar_feeds (owner_email);

-- --- Holidays and school dates ------------------------------------------------------------------

-- Official NSW public holidays and school terms ship with the code (src/shared/calendar/nsw.ts,
-- with their source and verification date). These are the person's own additions: a school's
-- own development days, regional holidays, non-working days.
CREATE TABLE calendar_custom_dates (
    id TEXT PRIMARY KEY,
    owner_email TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('school_holiday', 'development_day', 'school_event', 'regional_holiday', 'non_working')),
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    region TEXT CHECK (region IS NULL OR length(region) <= 80),
    school TEXT CHECK (school IS NULL OR length(school) <= 120),
    -- household: every Calendar user in the portal sees it; personal: only its owner.
    scope TEXT NOT NULL DEFAULT 'personal' CHECK (scope IN ('personal', 'household')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (end_date >= start_date)
);
CREATE INDEX calendar_custom_dates_owner ON calendar_custom_dates (owner_email, start_date);

-- --- Leave --------------------------------------------------------------------------------------

-- Each person's work pattern and leave rules. Leave is always the person's own: no portal role
-- grants access to anyone else's balances.
CREATE TABLE leave_profiles (
    email TEXT PRIMARY KEY,
    pattern TEXT NOT NULL CHECK (json_valid(pattern)),
    settings TEXT NOT NULL CHECK (json_valid(settings)),
    version INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
);

CREATE TABLE leave_types (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('annual', 'long_service', 'personal', 'toil', 'flex', 'unpaid', 'other')),
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
    color TEXT NOT NULL DEFAULT 'blue' CHECK (length(color) <= 20),
    paid INTEGER NOT NULL DEFAULT 1 CHECK (paid IN (0, 1)),
    tracks_balance INTEGER NOT NULL DEFAULT 1 CHECK (tracks_balance IN (0, 1)),
    -- The balance in hours as at the end of balance_date, as the person's payslip or HR system shows it.
    balance_hours REAL NOT NULL DEFAULT 0 CHECK (balance_hours BETWEEN -10000 AND 100000),
    balance_date TEXT NOT NULL,
    -- How it accrues, any cap and yearly reset (validated by the Worker, src/shared/calendar/leave.ts).
    accrual TEXT NOT NULL CHECK (json_valid(accrual)),
    deducts_public_holidays INTEGER NOT NULL DEFAULT 0 CHECK (deducts_public_holidays IN (0, 1)),
    position INTEGER NOT NULL DEFAULT 0,
    archived_at TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (email, name)
);

CREATE TABLE leave_adjustments (
    id TEXT PRIMARY KEY,
    leave_type_id TEXT NOT NULL REFERENCES leave_types (id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    date TEXT NOT NULL,
    hours REAL NOT NULL CHECK (hours BETWEEN -10000 AND 10000 AND hours <> 0),
    reason TEXT CHECK (reason IS NULL OR length(reason) <= 200),
    created_at TEXT NOT NULL
);
CREATE INDEX leave_adjustments_type ON leave_adjustments (leave_type_id, date);

-- What-if plans: bookings in a scenario never affect confirmed balances.
CREATE TABLE leave_scenarios (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
    note TEXT CHECK (note IS NULL OR length(note) <= 500),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX leave_scenarios_email ON leave_scenarios (email);

-- Draft, proposed, requested, approved, taken or cancelled. Nothing here is ever assumed to be
-- approved by an employer: only the person marks a booking approved or taken.
CREATE TABLE leave_bookings (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    leave_type_id TEXT NOT NULL REFERENCES leave_types (id) ON DELETE CASCADE,
    scenario_id TEXT REFERENCES leave_scenarios (id) ON DELETE CASCADE,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    -- full days, a morning or afternoon (half the day's hours), or chosen hours (single-day bookings).
    part TEXT NOT NULL DEFAULT 'full' CHECK (part IN ('full', 'am', 'pm', 'hours')),
    hours REAL CHECK (hours IS NULL OR hours BETWEEN 0 AND 24),
    -- Per-day hour overrides for unusual days ({"2026-12-24": 4}), validated by the Worker.
    day_hours TEXT CHECK (day_hours IS NULL OR json_valid(day_hours)),
    status TEXT NOT NULL CHECK (status IN ('draft', 'proposed', 'requested', 'approved', 'taken', 'cancelled')),
    title TEXT CHECK (title IS NULL OR length(title) <= 120),
    note TEXT CHECK (note IS NULL OR length(note) <= 1000),
    client_id TEXT CHECK (client_id IS NULL OR length(client_id) BETWEEN 8 AND 64),
    version INTEGER NOT NULL DEFAULT 1,
    created_by TEXT NOT NULL DEFAULT 'portal' CHECK (created_by IN ('portal', 'mcp', 'import')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (end_date >= start_date),
    CHECK (part = 'full' OR start_date = end_date),
    CHECK ((part = 'hours') = (hours IS NOT NULL))
);
CREATE INDEX leave_bookings_email ON leave_bookings (email, start_date);
CREATE UNIQUE INDEX leave_bookings_client ON leave_bookings (email, client_id) WHERE client_id IS NOT NULL;

-- One person explicitly letting another see when they're on leave (dates and status, never balances).
CREATE TABLE leave_shares (
    owner_email TEXT NOT NULL,
    viewer_email TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (owner_email, viewer_email),
    CHECK (owner_email <> viewer_email)
);
CREATE INDEX leave_shares_viewer ON leave_shares (viewer_email);

-- --- History ------------------------------------------------------------------------------------

-- Every Calendar and Leave write: who, what kind of record and which one. Never titles, text, URLs or hours.
CREATE TABLE calendar_activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL CHECK (length(action) <= 60),
    entity_type TEXT NOT NULL CHECK (length(entity_type) <= 40),
    entity_id TEXT,
    calendar_id TEXT,
    via TEXT NOT NULL DEFAULT 'portal' CHECK (via IN ('portal', 'mcp', 'system'))
);
CREATE INDEX calendar_activity_actor ON calendar_activity (actor, at);
CREATE INDEX calendar_activity_calendar ON calendar_activity (calendar_id, at) WHERE calendar_id IS NOT NULL;

-- --- MCP ledger ---------------------------------------------------------------------------------

-- SQLite can't widen a CHECK in place: rebuild mcp_writes with the calendar outcomes, copying every
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
            'calendar_event', 'calendar_subscription', 'leave_booking'
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
