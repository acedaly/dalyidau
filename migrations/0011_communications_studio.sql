-- Communications Studio: household-addressed campaigns, test sends and thank-you notes.
-- Additive only. Two new columns and three new tables; no guest, household, RSVP response, invitation
-- link or message body is changed. The only existing rows touched are message recipients, which gain
-- the household they were addressed to (worked out from their guest), so a household's history and
-- duplicate protection also cover messages sent before this.

-- The household a recipient row was addressed to. Guests can move between households later, so this
-- is recorded at the time, like the recipient's name and address.
ALTER TABLE message_recipients ADD COLUMN household_id TEXT;
UPDATE message_recipients
SET household_id = (SELECT g.household_id FROM guests g WHERE g.id = message_recipients.guest_id)
WHERE household_id IS NULL;
-- RSVP confirmations already use the household's id as their recipient id.
UPDATE message_recipients
SET household_id = guest_id
WHERE household_id IS NULL AND guest_id IN (SELECT id FROM households);
CREATE INDEX message_recipients_household ON message_recipients (household_id, status);

-- How a message was prepared (individual delivery, sending again), as JSON.
ALTER TABLE messages ADD COLUMN options TEXT NOT NULL DEFAULT '{}';
CREATE INDEX messages_category ON messages (category, status);

-- Controlled test sends. Kept apart from message_recipients so a test never counts as a household
-- being contacted, never appears in delivery history and never blocks or triggers a real send.
CREATE TABLE message_tests (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
    channel TEXT NOT NULL CHECK (channel IN ('email', 'sms')),
    -- One of the owner-approved test addresses or mobiles (Email & SMS settings).
    recipient TEXT NOT NULL,
    -- The household whose details filled the preview, or NULL for the fictional sample.
    sample_household_id TEXT,
    provider TEXT,
    provider_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('sent', 'failed')),
    error TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX message_tests_message ON message_tests (message_id, created_at);

-- A personal line for a household's thank-you card ({{personal_note}}). Erasing the household removes it.
CREATE TABLE thank_you_notes (
    household_id TEXT PRIMARY KEY REFERENCES households (id) ON DELETE CASCADE,
    note TEXT NOT NULL CHECK (length(note) <= 1000),
    updated_by TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
