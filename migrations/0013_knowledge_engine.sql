-- Daly Knowledge (/portal/knowledge): private spaces, object types, objects, revisions, tags,
-- relationships and full-text search. Additive: no existing table is changed.
--
-- The data lives in D1, never in this public repository. The Worker verifies the Cloudflare Access
-- identity and the caller's space membership on every read and write (worker/knowledge/); these
-- constraints are a second line of defence, not a substitute.
--
-- Every child row carries its space_id, and composite foreign keys onto (space_id, id) make the
-- database itself refuse a relation, tag, revision or type reference that crosses two spaces.

CREATE TABLE knowledge_spaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
    kind TEXT NOT NULL CHECK (kind IN ('personal', 'shared')),
    -- The person a personal space belongs to; NULL for shared spaces.
    personal_owner TEXT COLLATE NOCASE,
    -- IANA time zone used for "today" (daily notes, dates without a time).
    time_zone TEXT NOT NULL DEFAULT 'Australia/Sydney',
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK ((kind = 'personal') = (personal_owner IS NOT NULL))
);
-- One personal space per person, so two first visits at once can't create two.
CREATE UNIQUE INDEX knowledge_spaces_personal ON knowledge_spaces(personal_owner) WHERE kind = 'personal';

CREATE TABLE knowledge_memberships (
    space_id TEXT NOT NULL REFERENCES knowledge_spaces(id) ON DELETE CASCADE,
    email TEXT NOT NULL COLLATE NOCASE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
    added_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (space_id, email)
);
CREATE INDEX knowledge_memberships_email ON knowledge_memberships(email);

CREATE TABLE knowledge_object_types (
    id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL REFERENCES knowledge_spaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
    -- Stable key for code and imports ("person", "meeting"); never changes after creation.
    slug TEXT NOT NULL,
    icon TEXT NOT NULL DEFAULT 'file',
    description TEXT NOT NULL DEFAULT '',
    -- { "properties": [ { key, label, type, required, options, ... } ] }, validated by the Worker.
    schema_json TEXT NOT NULL DEFAULT '{"properties":[]}' CHECK (json_valid(schema_json)),
    sort_order INTEGER NOT NULL DEFAULT 0,
    archived_at TEXT,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_by TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (space_id, slug),
    UNIQUE (space_id, id)
);

CREATE TABLE knowledge_objects (
    id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL REFERENCES knowledge_spaces(id) ON DELETE CASCADE,
    type_id TEXT NOT NULL,
    title TEXT NOT NULL CHECK (length(title) <= 300),
    -- The document, in the format named by content_format (docs/KNOWLEDGE_ENGINE.md#content-format).
    content_json TEXT NOT NULL DEFAULT '{"type":"doc","content":[]}' CHECK (json_valid(content_json)),
    content_format TEXT NOT NULL DEFAULT 'daly.doc.v1',
    -- Plain text derived from content_json by the Worker; feeds search and previews.
    body_text TEXT NOT NULL DEFAULT '',
    properties_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(properties_json)),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'trashed')),
    -- Captured but not yet organised.
    in_inbox INTEGER NOT NULL DEFAULT 0 CHECK (in_inbox IN (0, 1)),
    -- Where an imported object came from, e.g. ('capacities', '<capacities id>'): makes imports idempotent.
    source_system TEXT,
    source_id TEXT,
    -- The object's row in knowledge_fts. An ordinary column, so it survives export and restore.
    search_rowid INTEGER NOT NULL UNIQUE,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_by TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT,
    trashed_at TEXT,
    trashed_by TEXT,
    UNIQUE (space_id, id),
    FOREIGN KEY (space_id, type_id) REFERENCES knowledge_object_types(space_id, id)
);
CREATE INDEX knowledge_objects_space_status_updated ON knowledge_objects(space_id, status, updated_at DESC);
CREATE INDEX knowledge_objects_space_type ON knowledge_objects(space_id, type_id, status);
CREATE INDEX knowledge_objects_inbox ON knowledge_objects(space_id, in_inbox) WHERE in_inbox = 1;
CREATE UNIQUE INDEX knowledge_objects_source ON knowledge_objects(space_id, source_system, source_id) WHERE source_id IS NOT NULL;

-- Snapshots of an object after each saved change. Consecutive autosaves by one person within a
-- few minutes update the latest snapshot rather than adding one per keystroke pause.
CREATE TABLE knowledge_revisions (
    id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL,
    object_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('create', 'edit', 'restore', 'import')),
    type_id TEXT NOT NULL,
    title TEXT NOT NULL,
    content_json TEXT NOT NULL CHECK (json_valid(content_json)),
    content_format TEXT NOT NULL,
    properties_json TEXT NOT NULL CHECK (json_valid(properties_json)),
    changed_by TEXT NOT NULL,
    started_at TEXT NOT NULL,
    changed_at TEXT NOT NULL,
    UNIQUE (object_id, version),
    FOREIGN KEY (space_id, object_id) REFERENCES knowledge_objects(space_id, id) ON DELETE CASCADE
);
CREATE INDEX knowledge_revisions_object ON knowledge_revisions(object_id, version DESC);

-- Directed, typed links. origin says who maintains the row: 'manual' (added by a person),
-- 'content' (a link in the document, rebuilt on every save) or 'property' (an object-reference
-- property, rebuilt when properties change). Backlinks are the same rows read by target_id.
CREATE TABLE knowledge_relations (
    id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    relation_type TEXT NOT NULL CHECK (length(relation_type) BETWEEN 1 AND 40),
    origin TEXT NOT NULL CHECK (origin IN ('manual', 'content', 'property')),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    CHECK (source_id <> target_id),
    UNIQUE (source_id, target_id, relation_type, origin),
    FOREIGN KEY (space_id, source_id) REFERENCES knowledge_objects(space_id, id) ON DELETE CASCADE,
    FOREIGN KEY (space_id, target_id) REFERENCES knowledge_objects(space_id, id) ON DELETE CASCADE
);
CREATE INDEX knowledge_relations_target ON knowledge_relations(target_id, relation_type);

CREATE TABLE knowledge_tags (
    id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL REFERENCES knowledge_spaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL COLLATE NOCASE CHECK (length(name) BETWEEN 1 AND 50),
    created_at TEXT NOT NULL,
    UNIQUE (space_id, name),
    UNIQUE (space_id, id)
);

CREATE TABLE knowledge_object_tags (
    space_id TEXT NOT NULL,
    object_id TEXT NOT NULL,
    tag_id TEXT NOT NULL,
    PRIMARY KEY (object_id, tag_id),
    FOREIGN KEY (space_id, object_id) REFERENCES knowledge_objects(space_id, id) ON DELETE CASCADE,
    FOREIGN KEY (space_id, tag_id) REFERENCES knowledge_tags(space_id, id) ON DELETE CASCADE
);
CREATE INDEX knowledge_object_tags_tag ON knowledge_object_tags(tag_id);

-- Knowledge has its own audit trail, readable only by a space's owners. The portal-wide audit_log
-- is visible to every editor, so it must not reveal what is in someone's private notes. Summaries
-- name the action and the record id, never titles or content.
CREATE TABLE knowledge_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    space_id TEXT NOT NULL,
    at TEXT NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT,
    summary TEXT NOT NULL,
    changes TEXT CHECK (changes IS NULL OR json_valid(changes))
);
CREATE INDEX knowledge_audit_space ON knowledge_audit(space_id, id DESC);
CREATE TRIGGER knowledge_audit_immutable BEFORE UPDATE ON knowledge_audit
BEGIN SELECT RAISE(ABORT, 'audit entries cannot be rewritten'); END;

-- Keyword search. A derived index: the Worker writes it in the same batch as the object, and it can
-- be rebuilt at any time from knowledge_objects (KNOWLEDGE_FTS_REBUILD in worker/knowledge/search.ts,
-- also run by scripts/db-backup.mjs after a restore).
--
-- Deliberately not an external-content table and without triggers: `wrangler d1 export` refuses a
-- database containing any virtual table, so backups export the ordinary tables one by one and
-- recreate this index afterwards. Its rowid is knowledge_objects.search_rowid.
--
-- Every query MUST join knowledge_objects and constrain it to the caller's authorised space ids.
CREATE VIRTUAL TABLE knowledge_fts USING fts5(
    title,
    body,
    tags,
    tokenize = 'unicode61 remove_diacritics 2',
    prefix = '2 3'
);
