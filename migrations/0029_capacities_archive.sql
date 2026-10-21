-- Retiring Capacities as a publisher (docs/CAPACITIES_RETIREMENT.md). Additive only: no existing row
-- is changed or removed by this migration. To revert, drop capacities_archive and the three
-- amplenote_articles columns (D1 can drop columns) after restoring any replaced article first.

-- A complete copy of every Capacities article as it is published, taken from Portal settings →
-- Website & Blog ("Check and archive"). The live copy stays in posts; this one is what an article is
-- restored from if its address is ever handed to an Amplenote note and that is undone.
CREATE TABLE capacities_archive (
    id TEXT PRIMARY KEY,                         -- the posts.id (Capacities object id)
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    subtitle TEXT,
    summary TEXT,
    category TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    featured INTEGER NOT NULL DEFAULT 0,
    image_key TEXT,
    image_alt TEXT,
    image_width INTEGER,
    image_height INTEGER,
    body_html TEXT NOT NULL,
    toc TEXT NOT NULL DEFAULT '[]',
    search_text TEXT NOT NULL DEFAULT '',
    word_count INTEGER NOT NULL DEFAULT 0,
    reading_minutes INTEGER NOT NULL DEFAULT 1,
    published_at TEXT NOT NULL,
    updated_at TEXT,
    source_updated_at TEXT,
    content_hash TEXT NOT NULL,
    render_context TEXT,
    synced_at TEXT NOT NULL,
    redirects TEXT NOT NULL DEFAULT '[]',        -- old slugs that redirected to it when archived
    media_keys TEXT NOT NULL DEFAULT '[]',       -- every R2 key it shows (featured image and body)
    archived_at TEXT NOT NULL,
    archived_by TEXT NOT NULL,
    replaced_by TEXT,                            -- Amplenote note uuid now serving its address, if any
    replaced_at TEXT
);
CREATE INDEX capacities_archive_slug ON capacities_archive (slug);

-- An Amplenote note may take over a Capacities article's address ("replaces: <slug>" in its Website
-- section) only once the owner has approved that exact address in the portal.
ALTER TABLE amplenote_articles ADD COLUMN replace_slug TEXT;
ALTER TABLE amplenote_articles ADD COLUMN replace_approved_by TEXT;
ALTER TABLE amplenote_articles ADD COLUMN replace_approved_at TEXT;
