-- Today: the unified daily dashboard, daily planning and Chief of Staff (Milestone 6.3). See
-- docs/DAILY_PLANNER.md#today.
--
-- Additive only: two new tables, nothing altered. Tasks stays the source of truth for a task's
-- status, dates and priority, and time blocks stay in task_time_blocks (0023): Today never copies a
-- task. The previous Worker never reads these tables, so a rollback leaves them unused.
-- Activity goes to calendar_activity (ids only, never titles or notes).

-- Each person's Today preferences: sections and their order, breaks, focus periods, which calendars
-- count towards availability, briefing display and the like. One JSON document, validated by the
-- Worker (src/shared/today/types.ts). Kept apart from planner_preferences, which an earlier Worker
-- validates strictly (it would fall back to defaults on meeting fields it doesn't know).
CREATE TABLE today_preferences (
    email TEXT PRIMARY KEY,
    value TEXT NOT NULL CHECK (json_valid(value) AND length(value) <= 8000),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    updated_at TEXT NOT NULL
);

-- Morning planning and evening review, one of each per person per day. Private to the person.
-- priorities: up to three task ids, each checked through Tasks when saved (never titles).
-- summary: counts and ids only (sessions planned, rescheduled, returned to the list).
-- note: the person's own words from the evening review.
CREATE TABLE daily_reviews (
    email TEXT NOT NULL COLLATE NOCASE,
    date TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    kind TEXT NOT NULL CHECK (kind IN ('morning', 'evening')),
    priorities TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(priorities) AND json_array_length(priorities) <= 3),
    summary TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(summary) AND length(summary) <= 4000),
    note TEXT CHECK (note IS NULL OR length(note) <= 4000),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (email, date, kind)
);
