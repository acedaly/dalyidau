-- Private portal (/portal) and wedding management (/portal/wedding, /wedding).
-- Nothing here is read by the blog. Every table is only reachable through routes that verify a
-- Cloudflare Access identity, except the RSVP lookup and submit endpoints, which need a valid
-- household RSVP code and are rate-limited.

-- Portal identities. Emails come from Cloudflare Access and are stored lower-case.
-- Owners listed in PORTAL_OWNER_EMAILS always resolve to the owner role, even without a row here.
CREATE TABLE portal_users (
    email TEXT PRIMARY KEY,
    name TEXT,
    role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'editor', 'viewer')),
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    last_seen_at TEXT
);

-- Append-only record of every change made through the portal or the RSVP form.
CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    actor TEXT NOT NULL,                 -- email, "rsvp:<household id>" or "system"
    action TEXT NOT NULL,                -- e.g. guest.create, guest.update, flag.update, export.guests
    entity_type TEXT NOT NULL,
    entity_id TEXT,
    summary TEXT NOT NULL,
    changes TEXT                         -- JSON: { field: [before, after] } or a snapshot for deletes
);
CREATE INDEX audit_log_at ON audit_log (at DESC);
CREATE INDEX audit_log_entity ON audit_log (entity_type, entity_id);

-- Overrides for the feature flags defined in src/shared/portal/flags.ts. A missing row means the default.
CREATE TABLE feature_flags (
    key TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL
);

-- Small JSON documents: wedding details, website content, RSVP and budget settings.
CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL
);

-- Per-user dashboard layout.
CREATE TABLE dashboard_layouts (
    email TEXT PRIMARY KEY,
    widgets TEXT NOT NULL,               -- JSON array of { id, type, size }
    updated_at TEXT NOT NULL
);

-- An invitation unit. The RSVP code is the only credential the public RSVP form accepts.
CREATE TABLE households (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    rsvp_code TEXT NOT NULL UNIQUE,
    email TEXT,
    phone TEXT,
    address_line1 TEXT,
    address_line2 TEXT,
    locality TEXT,
    region TEXT,
    postcode TEXT,
    country TEXT,
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE guests (
    id TEXT PRIMARY KEY,
    household_id TEXT REFERENCES households (id) ON DELETE SET NULL,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL DEFAULT '',
    email TEXT,
    phone TEXT,
    side TEXT NOT NULL DEFAULT 'shared' CHECK (side IN ('partner_one', 'partner_two', 'shared')),
    group_name TEXT,                     -- free text: Family, Friends, Work…
    age_group TEXT NOT NULL DEFAULT 'adult' CHECK (age_group IN ('adult', 'child', 'infant')),
    is_plus_one INTEGER NOT NULL DEFAULT 0,
    dietary TEXT,
    accessibility TEXT,
    notes TEXT,
    tags TEXT NOT NULL DEFAULT '[]',     -- JSON array of strings
    custom TEXT NOT NULL DEFAULT '{}',   -- JSON object keyed by custom_fields.key
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX guests_household ON guests (household_id);
CREATE INDEX guests_name ON guests (last_name, first_name);

-- Ceremony, reception, recovery brunch…
CREATE TABLE events (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    starts_at TEXT,                      -- local wall-clock time, "YYYY-MM-DDTHH:MM"
    ends_at TEXT,
    venue_name TEXT,
    address TEXT,
    description TEXT,
    dress_code TEXT,
    is_public INTEGER NOT NULL DEFAULT 1, -- shown on the public wedding website
    rsvp_enabled INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- A row means the guest is invited to the event. Status is their RSVP for it.
CREATE TABLE guest_events (
    guest_id TEXT NOT NULL REFERENCES guests (id) ON DELETE CASCADE,
    event_id TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'attending', 'declined')),
    source TEXT,                         -- portal | native | sayido | import
    responded_at TEXT,
    PRIMARY KEY (guest_id, event_id)
);
CREATE INDEX guest_events_event ON guest_events (event_id, status);

-- Extra guest fields defined by the couple without a code change.
CREATE TABLE custom_fields (
    id TEXT PRIMARY KEY,
    entity TEXT NOT NULL DEFAULT 'guest',
    key TEXT NOT NULL,
    label TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('text', 'number', 'boolean', 'select', 'date')),
    options TEXT NOT NULL DEFAULT '[]',  -- JSON array of strings, for select
    help TEXT,
    show_in_table INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (entity, key)
);

-- Every response received through the native RSVP form, kept verbatim.
CREATE TABLE rsvp_submissions (
    id TEXT PRIMARY KEY,
    household_id TEXT NOT NULL REFERENCES households (id) ON DELETE CASCADE,
    submitted_at TEXT NOT NULL,
    payload TEXT NOT NULL,               -- JSON
    message TEXT
);
CREATE INDEX rsvp_submissions_household ON rsvp_submissions (household_id, submitted_at DESC);

-- Fixed-window counters for public endpoints. Keys are hashed; no IP addresses are stored.
CREATE TABLE rate_limits (
    key TEXT PRIMARY KEY,
    window_start INTEGER NOT NULL,
    count INTEGER NOT NULL
);

CREATE TABLE message_templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,                  -- plain text with {{merge_fields}}
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- A message is a snapshot of subject, body and recipients at the time it was prepared.
CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    template_id TEXT REFERENCES message_templates (id) ON DELETE SET NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    audience TEXT NOT NULL,              -- JSON description of the filter used
    status TEXT NOT NULL CHECK (status IN ('draft', 'queued', 'sending', 'sent', 'partial', 'failed')),
    recipient_count INTEGER NOT NULL DEFAULT 0,
    delivery_note TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    sent_at TEXT
);
CREATE INDEX messages_created ON messages (created_at DESC);

CREATE TABLE message_recipients (
    message_id TEXT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
    guest_id TEXT NOT NULL,
    name TEXT NOT NULL,
    email TEXT,
    status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
    error TEXT,
    sent_at TEXT,
    PRIMARY KEY (message_id, guest_id)
);

CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'in_progress', 'done')),
    priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high')),
    category TEXT,
    due_date TEXT,                       -- YYYY-MM-DD
    assignee TEXT,                       -- portal user email
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
);
CREATE INDEX tasks_due ON tasks (status, due_date);

-- The day-of run sheet.
CREATE TABLE timeline_items (
    id TEXT PRIMARY KEY,
    starts_at TEXT NOT NULL,             -- "YYYY-MM-DDTHH:MM"
    ends_at TEXT,
    title TEXT NOT NULL,
    location TEXT,
    owner TEXT,                          -- who is responsible (free text: a person or supplier)
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE suppliers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT,
    status TEXT NOT NULL DEFAULT 'researching' CHECK (status IN ('researching', 'quoted', 'booked', 'cancelled')),
    contact_name TEXT,
    email TEXT,
    phone TEXT,
    website TEXT,
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- Money is stored in cents.
CREATE TABLE budget_items (
    id TEXT PRIMARY KEY,
    category TEXT NOT NULL,
    description TEXT NOT NULL,
    supplier_id TEXT REFERENCES suppliers (id) ON DELETE SET NULL,
    estimated_cents INTEGER NOT NULL DEFAULT 0,
    actual_cents INTEGER,
    paid_cents INTEGER NOT NULL DEFAULT 0,
    due_date TEXT,
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX budget_items_category ON budget_items (category);
