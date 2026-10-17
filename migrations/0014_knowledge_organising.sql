-- Daly Knowledge, Milestone 3: daily notes, collections, pins, favourites, saved views and
-- templates. Additive: one nullable column on knowledge_objects and new tables. Nothing existing is
-- rewritten, and every existing row stays valid (a NULL daily_date isn't a daily note).
--
-- Same rules as 0013: every row carries its space_id, and composite foreign keys onto (space_id, id)
-- make the database itself refuse a collection item, pin, favourite or template that crosses spaces.

-- Daily notes: an ordinary object with the calendar date it belongs to, fixed when it's created (in
-- the space's time zone at that moment), so changing the time zone later never moves old notes.
ALTER TABLE knowledge_objects ADD COLUMN daily_date TEXT CHECK (daily_date IS NULL OR daily_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]');
-- One daily note per date per space, so two tabs or a double click can't make two.
CREATE UNIQUE INDEX knowledge_objects_daily ON knowledge_objects(space_id, daily_date) WHERE daily_date IS NOT NULL;

-- Collections group objects without copying them. Deleting a collection deletes its membership rows
-- only; the objects are untouched.
CREATE TABLE knowledge_collections (
    id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL REFERENCES knowledge_spaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
    description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 500),
    sort_order INTEGER NOT NULL DEFAULT 0,
    archived_at TEXT,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_by TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (space_id, id)
);
CREATE INDEX knowledge_collections_space ON knowledge_collections(space_id, sort_order);

-- An object's place in a collection. position orders the collection (fractional, so moving one item
-- touches one row); pinned_at keeps an item at the top of that collection.
CREATE TABLE knowledge_collection_items (
    space_id TEXT NOT NULL,
    collection_id TEXT NOT NULL,
    object_id TEXT NOT NULL,
    position REAL NOT NULL,
    pinned_at TEXT,
    added_by TEXT NOT NULL,
    added_at TEXT NOT NULL,
    PRIMARY KEY (collection_id, object_id),
    FOREIGN KEY (space_id, collection_id) REFERENCES knowledge_collections(space_id, id) ON DELETE CASCADE,
    FOREIGN KEY (space_id, object_id) REFERENCES knowledge_objects(space_id, id) ON DELETE CASCADE
);
CREATE INDEX knowledge_collection_items_order ON knowledge_collection_items(collection_id, position);
CREATE INDEX knowledge_collection_items_object ON knowledge_collection_items(object_id);

-- Objects pinned to the top of a space's home. Shared by everyone in the space; editors pin.
CREATE TABLE knowledge_pins (
    space_id TEXT NOT NULL,
    object_id TEXT NOT NULL,
    position REAL NOT NULL,
    pinned_by TEXT NOT NULL,
    pinned_at TEXT NOT NULL,
    PRIMARY KEY (space_id, object_id),
    FOREIGN KEY (space_id, object_id) REFERENCES knowledge_objects(space_id, id) ON DELETE CASCADE
);

-- Personal favourites: one person's shortcuts, never anyone else's, even in a shared space. Every read
-- joins the person's current membership, so a favourite never outlives their access; removing someone
-- from a space also deletes their favourites there.
CREATE TABLE knowledge_favourites (
    email TEXT NOT NULL COLLATE NOCASE,
    space_id TEXT NOT NULL,
    object_id TEXT NOT NULL,
    position REAL NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (email, object_id),
    FOREIGN KEY (space_id, object_id) REFERENCES knowledge_objects(space_id, id) ON DELETE CASCADE
);
CREATE INDEX knowledge_favourites_space ON knowledge_favourites(space_id, email);

-- Saved views: a name and a filter definition (validated by the Worker against a fixed list of
-- fields, never SQL). owner_email set = private to that person; NULL = shared with the space.
CREATE TABLE knowledge_saved_views (
    id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL REFERENCES knowledge_spaces(id) ON DELETE CASCADE,
    owner_email TEXT COLLATE NOCASE,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
    definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
    sort_order INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_by TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX knowledge_saved_views_space ON knowledge_saved_views(space_id, owner_email);

-- Templates: a starting document (daly.doc.v1, like any object) and property values for one type.
-- Creating an object from a template copies them; the object never changes when the template does.
CREATE TABLE knowledge_templates (
    id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL REFERENCES knowledge_spaces(id) ON DELETE CASCADE,
    type_id TEXT NOT NULL,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
    description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 300),
    -- The new object's title; {date} becomes the space's date when it's used.
    title TEXT NOT NULL DEFAULT '' CHECK (length(title) <= 300),
    content_json TEXT NOT NULL DEFAULT '{"type":"doc","content":[]}' CHECK (json_valid(content_json)),
    properties_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(properties_json)),
    is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
    archived_at TEXT,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_by TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (space_id, id),
    FOREIGN KEY (space_id, type_id) REFERENCES knowledge_object_types(space_id, id)
);
CREATE INDEX knowledge_templates_type ON knowledge_templates(space_id, type_id);
-- At most one default template per type.
CREATE UNIQUE INDEX knowledge_templates_default ON knowledge_templates(type_id) WHERE is_default = 1 AND archived_at IS NULL;
