-- Opt-outs for a household's own email address and mobile number. A campaign can fall back to the
-- household's contact details when none of its guests can be reached; those details need consent of
-- their own, because guest opt-outs are recorded per guest. Additive: two empty columns.
ALTER TABLE households ADD COLUMN email_opt_out_at TEXT;
ALTER TABLE households ADD COLUMN sms_opt_out_at TEXT;
