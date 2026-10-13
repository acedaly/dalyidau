-- Household invitation addressing. Additive only: no invitation is sent, and no guest, RSVP,
-- message or generated invitation is changed.

-- How the household is addressed on its invitation, e.g. "The Daly Family" or "Mr & Mrs Daly".
-- NULL means "use the invited guests' names", e.g. "Fred & Ann Daly".
ALTER TABLE households ADD COLUMN invitation_name TEXT;
-- With a custom invitation name, also list the individually invited people beneath it.
ALTER TABLE households ADD COLUMN invitation_list_names INTEGER NOT NULL DEFAULT 0;

-- The greeting prefix is now only the email salutation ("Dear Fred & Ann,"). The invitation itself
-- shows the recipient line on its own, so the old default "For" becomes "Dear". A prefix the
-- couple chose themselves is left alone.
UPDATE settings SET value = json_set(value, '$.greetingPrefix', 'Dear')
WHERE key = 'invitation' AND json_valid(value) AND json_extract(value, '$.greetingPrefix') = 'For';
