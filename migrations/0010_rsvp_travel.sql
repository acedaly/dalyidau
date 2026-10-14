-- Courtesy bus and accommodation answers from the native RSVP, one row per household.
-- Additive only: creates one new table and changes no existing row, so every household, guest,
-- RSVP response, question and answer is preserved.
--
-- Counts are passengers, not invited guests: a family of five might need three seats to Rhino Lodge
-- and two home. The Worker checks them against the guests attending when the reply is saved.
CREATE TABLE rsvp_travel (
    household_id TEXT PRIMARY KEY REFERENCES households(id) ON DELETE CASCADE,
    bus TEXT CHECK (bus IN ('to', 'home', 'both', 'none', 'unsure')),
    outbound_count INTEGER NOT NULL DEFAULT 0 CHECK (outbound_count BETWEEN 0 AND 30),
    return_count INTEGER NOT NULL DEFAULT 0 CHECK (return_count BETWEEN 0 AND 30),
    stay TEXT CHECK (stay IN ('glamping', 'dubbo', 'family', 'home', 'unsure')),
    -- Free text such as "The Westbury" or "Motel on Cobra St"; only kept for accommodation in Dubbo.
    stay_location TEXT CHECK (stay_location IS NULL OR length(stay_location) <= 200),
    source TEXT NOT NULL DEFAULT 'native' CHECK (source IN ('native', 'manual')),
    updated_at TEXT NOT NULL,
    updated_by TEXT
);
