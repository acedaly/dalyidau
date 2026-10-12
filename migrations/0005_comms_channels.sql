-- Communications providers: email (SMTP2Go) and SMS (ClickSend) behind one abstraction.
-- Additive only: existing messages are email, and nothing here sends anything by itself.

-- Each message goes out on one channel.
ALTER TABLE messages ADD COLUMN channel TEXT NOT NULL DEFAULT 'email' CHECK (channel IN ('email', 'sms'));

-- Per-recipient delivery details reported by providers and their webhooks.
ALTER TABLE message_recipients ADD COLUMN phone TEXT;
ALTER TABLE message_recipients ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
-- Provider-reported outcome after sending: delivered, bounced, complained, undelivered…
ALTER TABLE message_recipients ADD COLUMN delivery_status TEXT;
ALTER TABLE message_recipients ADD COLUMN delivered_at TEXT;
-- SMS cost in cents, as reported by the provider at send time.
ALTER TABLE message_recipients ADD COLUMN cost_cents INTEGER;

-- Consent: a guest who replies STOP or unsubscribes is never messaged on that channel again.
ALTER TABLE guests ADD COLUMN email_opt_out_at TEXT;
ALTER TABLE guests ADD COLUMN sms_opt_out_at TEXT;

-- SMS conversations: every outbound and inbound text, matched to a guest by phone number.
CREATE TABLE sms_messages (
    id TEXT PRIMARY KEY,
    direction TEXT NOT NULL CHECK (direction IN ('outbound', 'inbound')),
    -- E.164, e.g. +61412345678
    phone TEXT NOT NULL,
    guest_id TEXT,
    household_id TEXT,
    body TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'delivered', 'failed', 'received')),
    provider_id TEXT,
    cost_cents INTEGER,
    error TEXT,
    -- The campaign this text belongs to, if any.
    message_id TEXT REFERENCES messages (id) ON DELETE SET NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    read_at TEXT
);
CREATE INDEX sms_messages_phone ON sms_messages (phone, created_at);
CREATE INDEX sms_messages_provider ON sms_messages (provider_id);
CREATE INDEX sms_messages_unread ON sms_messages (direction, read_at);

-- Raw provider webhooks. The unique key makes retried deliveries from the provider harmless.
CREATE TABLE comm_webhook_events (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    kind TEXT NOT NULL,
    dedupe_key TEXT NOT NULL UNIQUE,
    provider_id TEXT,
    payload TEXT NOT NULL,
    received_at TEXT NOT NULL,
    -- 1 when it was matched to a message or guest and applied.
    applied INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX comm_webhook_events_received ON comm_webhook_events (received_at DESC);
