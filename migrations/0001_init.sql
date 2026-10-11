-- Public, published articles only. Drafts never land in this table.
CREATE TABLE posts (
    id TEXT PRIMARY KEY,                 -- Capacities object id (canonical identity)
    slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    subtitle TEXT,
    summary TEXT,
    category TEXT,
    tags TEXT NOT NULL DEFAULT '[]',     -- JSON array of tag names
    featured INTEGER NOT NULL DEFAULT 0,
    image_key TEXT,                      -- R2 key of the featured image
    image_alt TEXT,
    image_width INTEGER,
    image_height INTEGER,
    body_html TEXT NOT NULL,             -- sanitised HTML rendered at sync time
    toc TEXT NOT NULL DEFAULT '[]',      -- JSON array of { id, text, level }
    search_text TEXT NOT NULL DEFAULT '',
    word_count INTEGER NOT NULL DEFAULT 0,
    reading_minutes INTEGER NOT NULL DEFAULT 1,
    published_at TEXT NOT NULL,
    updated_at TEXT,
    source_updated_at TEXT,
    content_hash TEXT NOT NULL,
    render_context TEXT,                 -- hash of linkable posts when rendered
    synced_at TEXT NOT NULL
);
CREATE INDEX posts_published_at ON posts (published_at DESC);
CREATE INDEX posts_category ON posts (category);

-- Every Blog Post object seen in Capacities, published or not. Holds no content.
CREATE TABLE sources (
    id TEXT PRIMARY KEY,
    status TEXT,                         -- last observed status label, lower-case
    last_checked_at TEXT,
    last_listed_at TEXT,
    missing_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT
);

-- Old slugs keep working after a rename.
CREATE TABLE slug_redirects (
    from_slug TEXT PRIMARY KEY,
    post_id TEXT NOT NULL,
    created_at TEXT NOT NULL
);

-- Capacities media copied into R2 (Capacities file URLs are signed and expire).
CREATE TABLE media (
    id TEXT PRIMARY KEY,                 -- Capacities media object id
    r2_key TEXT NOT NULL,
    content_type TEXT NOT NULL,
    width INTEGER,
    height INTEGER,
    bytes INTEGER NOT NULL,
    alt TEXT,
    caption TEXT,
    created_at TEXT NOT NULL
);

-- Small cache for tag names, web links and other referenced objects.
CREATE TABLE entity_cache (
    id TEXT PRIMARY KEY,
    structure_id TEXT NOT NULL,
    title TEXT,
    url TEXT,
    checked_at TEXT NOT NULL
);

CREATE TABLE sync_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trigger TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL,                -- running | ok | partial | failed
    listed INTEGER NOT NULL DEFAULT 0,
    checked INTEGER NOT NULL DEFAULT 0,
    published INTEGER NOT NULL DEFAULT 0,
    updated INTEGER NOT NULL DEFAULT 0,
    unpublished INTEGER NOT NULL DEFAULT 0,
    unchanged INTEGER NOT NULL DEFAULT 0,
    errors INTEGER NOT NULL DEFAULT 0,
    log TEXT NOT NULL DEFAULT '[]'
);

-- Small key/value store. content_version changes whenever public content changes,
-- which invalidates edge-cached HTML.
CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
INSERT INTO meta (key, value) VALUES ('content_version', '0');
