-- Amplenote as a second publishing source for the public blog (docs/AMPLENOTE.md).
-- Additive only: existing posts keep source 'capacities' and nothing is removed.
-- To revert, drop the three amplenote_* tables and DELETE FROM posts WHERE source = 'amplenote';
-- the two new posts columns are then unused (SQLite can't drop them before 3.35, D1 can).

-- Which publisher owns each public row. The Capacities sync only ever touches its own rows.
ALTER TABLE posts ADD COLUMN source TEXT NOT NULL DEFAULT 'capacities';
CREATE INDEX posts_source ON posts (source);

-- Every Amplenote note carrying the website tag that the plugin or the API has reported, public
-- or not. Content is stored only for notes reported as published; a row here is never public by
-- itself: the posts row is written only while every check in worker/amplenote/publisher.ts passes.
CREATE TABLE amplenote_articles (
    uuid TEXT PRIMARY KEY,                       -- Amplenote note UUID (stable identity)
    slug TEXT UNIQUE,                            -- assigned the first time the note is published
    title TEXT,
    website_tags TEXT NOT NULL DEFAULT '[]',     -- only tags under website/ (never the note's other tags)
    public_token TEXT,                           -- from the note's public URL, as reported by the plugin
    markdown TEXT,                               -- note content as markdown, only while published
    note_created_at TEXT,
    note_updated_at TEXT,
    first_published_at TEXT,                     -- first time every check passed
    -- What each source last said. NULL means "not known yet".
    plugin_tagged INTEGER,
    plugin_published INTEGER,
    plugin_seen_at TEXT,
    plugin_missing INTEGER NOT NULL DEFAULT 0,   -- consecutive complete plugin reports without this note
    rest_public INTEGER,
    rest_tagged INTEGER,
    rest_deleted INTEGER,
    rest_seen_at TEXT,
    rest_missing INTEGER NOT NULL DEFAULT 0,     -- consecutive full API listings without this note
    link_status TEXT,                            -- ok | gone | error, from checking the public URL
    link_checked_at TEXT,
    link_failures INTEGER NOT NULL DEFAULT 0,    -- consecutive "gone" answers
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'published', 'withdrawn')),
    reason TEXT,                                 -- why it isn't public, in plain words
    content_hash TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX amplenote_articles_state ON amplenote_articles (state);

-- The owner's Amplenote API connection (OAuth). One row; tokens are sealed with AMPLENOTE_TOKEN_KEY.
CREATE TABLE amplenote_connection (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    access_token TEXT NOT NULL,
    refresh_token TEXT,
    expires_at TEXT,
    scope TEXT,
    connected_by TEXT NOT NULL,
    connected_at TEXT NOT NULL,
    list_cursor INTEGER,                         -- unix time of the last successful listing
    full_listed_at TEXT,
    last_error TEXT,
    updated_at TEXT NOT NULL
);

-- Pending OAuth sign-ins: single use, ten minutes, tied to the browser (a cookie nonce, stored only
-- as its hash) and to the portal user who started them.
CREATE TABLE amplenote_oauth_states (
    state TEXT PRIMARY KEY,
    verifier TEXT NOT NULL,                      -- PKCE verifier, sealed
    browser TEXT NOT NULL,                       -- SHA-256 of the cookie nonce
    actor TEXT NOT NULL,
    created_at TEXT NOT NULL
);
