-- Invitation Studio generation ledger and provider validation. Additive only: no invitation is sent
-- and no existing guest, household, RSVP, message, media or setting is changed.

CREATE TABLE invitation_artifacts (
    id TEXT PRIMARY KEY,
    household_id TEXT NOT NULL REFERENCES households (id) ON DELETE CASCADE,
    guest_id TEXT REFERENCES guests (id) ON DELETE SET NULL,
    recipient_key TEXT NOT NULL,
    channel TEXT NOT NULL CHECK (channel IN ('email', 'sms', 'print')),
    invite_version INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'generated' CHECK (status IN ('generated', 'accepted', 'delivered', 'replied', 'failed', 'revoked')),
    provider_id TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (household_id, recipient_key, channel, invite_version)
);
CREATE INDEX invitation_artifacts_household ON invitation_artifacts (household_id, created_at DESC);
CREATE INDEX invitation_artifacts_status ON invitation_artifacts (channel, status, updated_at DESC);

-- Records only the outcome and time of a controlled provider check. Credentials remain Worker
-- secrets and are never stored in D1, audit changes or error payloads.
CREATE TABLE communication_provider_checks (
    channel TEXT PRIMARY KEY CHECK (channel IN ('email', 'sms')),
    provider TEXT NOT NULL,
    tested_at TEXT NOT NULL,
    tested_by TEXT NOT NULL,
    result TEXT NOT NULL CHECK (result IN ('connected', 'sent'))
);
