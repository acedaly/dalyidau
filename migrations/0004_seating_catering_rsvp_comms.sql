-- Seating, catering, configurable RSVP questions, invitation links, scheduled communications and
-- the website gallery. Additive only: new tables, nullable or defaulted columns, indexes.

-- Guests: named plus-ones, allergies (separate from preferences), meal category, contact preference.
ALTER TABLE guests ADD COLUMN plus_one_of TEXT REFERENCES guests (id) ON DELETE SET NULL;
ALTER TABLE guests ADD COLUMN allergies TEXT;
-- A catering category id from the catering settings; NULL means "not decided yet".
ALTER TABLE guests ADD COLUMN meal_category TEXT;
ALTER TABLE guests ADD COLUMN contact_preference TEXT NOT NULL DEFAULT 'email' CHECK (contact_preference IN ('email', 'post', 'phone', 'none'));

-- Households: invitation links are derived from a secret and this version; bump it to rotate,
-- set invite_revoked_at to revoke. Nothing secret is stored.
ALTER TABLE households ADD COLUMN invite_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE households ADD COLUMN invite_revoked_at TEXT;

-- Seating
CREATE TABLE seating_tables (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    shape TEXT NOT NULL DEFAULT 'round' CHECK (shape IN ('round', 'rectangle')),
    capacity INTEGER NOT NULL DEFAULT 10 CHECK (capacity BETWEEN 1 AND 60),
    sort_order INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- One seat per guest, enforced by the primary key: a guest can't be at two tables.
CREATE TABLE seat_assignments (
    guest_id TEXT PRIMARY KEY REFERENCES guests (id) ON DELETE CASCADE,
    table_id TEXT NOT NULL REFERENCES seating_tables (id) ON DELETE CASCADE,
    position INTEGER NOT NULL DEFAULT 0,
    assigned_at TEXT NOT NULL,
    assigned_by TEXT NOT NULL
);
CREATE INDEX seat_assignments_table ON seat_assignments (table_id, position);

-- Saved arrangements that can be restored later.
CREATE TABLE seating_snapshots (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    tables TEXT NOT NULL,                -- JSON array of tables at the time
    assignments TEXT NOT NULL,           -- JSON array of { guestId, tableId, position }
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL
);

-- Configurable RSVP questions. Editing a question's wording or choices bumps its version; answers
-- keep the version and a snapshot of the question they answered, so old answers stay readable.
CREATE TABLE rsvp_questions (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    help TEXT,
    type TEXT NOT NULL CHECK (type IN ('short_text', 'long_text', 'single_choice', 'multiple_choice', 'yes_no', 'number', 'date')),
    options TEXT NOT NULL DEFAULT '[]',  -- JSON array of strings, for choice questions
    required INTEGER NOT NULL DEFAULT 0,
    scope TEXT NOT NULL DEFAULT 'guest' CHECK (scope IN ('guest', 'household')),
    audience TEXT NOT NULL DEFAULT 'all' CHECK (audience IN ('all', 'adult', 'child')),
    event_id TEXT REFERENCES events (id) ON DELETE SET NULL,
    condition TEXT,                      -- JSON { questionId, equals } or NULL
    published INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE rsvp_answers (
    question_id TEXT NOT NULL REFERENCES rsvp_questions (id) ON DELETE CASCADE,
    household_id TEXT NOT NULL REFERENCES households (id) ON DELETE CASCADE,
    guest_id TEXT NOT NULL DEFAULT '',   -- '' for household-level questions
    value TEXT NOT NULL,                 -- JSON
    question_version INTEGER NOT NULL,
    question_snapshot TEXT NOT NULL,     -- JSON { label, type, options } as answered
    source TEXT NOT NULL,                -- native | portal
    answered_at TEXT NOT NULL,
    PRIMARY KEY (question_id, household_id, guest_id)
);
CREATE INDEX rsvp_answers_guest ON rsvp_answers (guest_id);

-- The optional courtesy-bus question, unpublished until the couple turns it on.
INSERT INTO rsvp_questions (id, label, help, type, options, required, scope, audience, published, sort_order, created_at, updated_at)
VALUES ('q_bus', 'Would you like a seat on the courtesy bus?', 'If a courtesy bus runs, we''ll confirm times closer to the day.', 'yes_no', '[]', 0, 'guest', 'all', 0, 100, '2026-10-12T00:00:00.000Z', '2026-10-12T00:00:00.000Z');

-- Duplicate submissions (double taps, retries) are recognised by a client-generated id.
ALTER TABLE rsvp_submissions ADD COLUMN client_id TEXT;
CREATE UNIQUE INDEX rsvp_submissions_client ON rsvp_submissions (household_id, client_id) WHERE client_id IS NOT NULL;

-- Communications: categories, scheduling, provider message ids for delivery webhooks.
ALTER TABLE message_templates ADD COLUMN category TEXT NOT NULL DEFAULT 'update';
ALTER TABLE messages ADD COLUMN category TEXT NOT NULL DEFAULT 'update';
ALTER TABLE messages ADD COLUMN scheduled_at TEXT;
ALTER TABLE message_recipients ADD COLUMN provider_id TEXT;
CREATE INDEX message_recipients_provider ON message_recipients (provider_id);
CREATE INDEX messages_due ON messages (status, scheduled_at);

-- Photos for the public website, stored in R2 under wedding/.
CREATE TABLE website_media (
    id TEXT PRIMARY KEY,
    r2_key TEXT NOT NULL UNIQUE,
    content_type TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    width INTEGER,
    height INTEGER,
    alt TEXT NOT NULL DEFAULT '',
    caption TEXT,
    in_gallery INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
