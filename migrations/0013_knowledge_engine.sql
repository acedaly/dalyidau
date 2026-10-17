-- Knowledge Engine v1: additive, private data only.
-- Data lives in D1 and R2, never in this public repository.
-- Application must enforce Cloudflare Access JWT + space membership on EVERY read/write.
-- Do not expose these tables via the public blog or wedding routes.

CREATE TABLE knowledge_spaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'personal' CHECK (kind IN ('personal', 'shared')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE knowledge_memberships (
  space_id TEXT NOT NULL REFERENCES knowledge_spaces(id) ON DELETE CASCADE,
  principal_email TEXT NOT NULL COLLATE NOCASE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (space_id, principal_email)
);

CREATE TABLE knowledge_object_types (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES knowledge_spaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  icon TEXT,
  schema_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(schema_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (space_id, slug),
  UNIQUE (space_id, id)
);

CREATE TABLE knowledge_objects (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES knowledge_spaces(id) ON DELETE CASCADE,
  type_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body_md TEXT NOT NULL DEFAULT '',
  properties_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(properties_json)),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'trashed')),
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at TEXT,
  FOREIGN KEY (space_id, type_id) REFERENCES knowledge_object_types(space_id, id)
);

CREATE INDEX idx_knowledge_objects_space_status_updated
  ON knowledge_objects(space_id, status, updated_at DESC);
CREATE INDEX idx_knowledge_objects_space_type
  ON knowledge_objects(space_id, type_id, title);

CREATE TABLE knowledge_revisions (
  id TEXT PRIMARY KEY,
  object_id TEXT NOT NULL REFERENCES knowledge_objects(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  body_md TEXT NOT NULL,
  properties_json TEXT NOT NULL CHECK (json_valid(properties_json)),
  changed_by TEXT NOT NULL,
  changed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (object_id, version)
);

CREATE TABLE knowledge_relations (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES knowledge_spaces(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES knowledge_objects(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES knowledge_objects(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL DEFAULT 'related',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (source_id <> target_id),
  UNIQUE (source_id, target_id, relation_type)
);
CREATE INDEX idx_knowledge_relations_target ON knowledge_relations(target_id, relation_type);

CREATE TABLE knowledge_tags (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES knowledge_spaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  UNIQUE (space_id, name),
  UNIQUE (space_id, id)
);

CREATE TABLE knowledge_object_tags (
  object_id TEXT NOT NULL REFERENCES knowledge_objects(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES knowledge_tags(id) ON DELETE CASCADE,
  PRIMARY KEY (object_id, tag_id)
);

CREATE TABLE knowledge_attachments (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES knowledge_spaces(id) ON DELETE CASCADE,
  object_id TEXT NOT NULL REFERENCES knowledge_objects(id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  sha256 TEXT,
  uploaded_by TEXT NOT NULL,
  uploaded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_knowledge_attachments_object ON knowledge_attachments(object_id);

-- FTS5 is for keyword search. All matches MUST be constrained by the
-- caller's authorised space IDs in the application query.
CREATE VIRTUAL TABLE knowledge_fts USING fts5(
  title, body_md, content='knowledge_objects', content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER knowledge_fts_insert AFTER INSERT ON knowledge_objects BEGIN
  INSERT INTO knowledge_fts(rowid, title, body_md)
  VALUES (new.rowid, new.title, new.body_md);
END;

CREATE TRIGGER knowledge_fts_delete AFTER DELETE ON knowledge_objects BEGIN
  INSERT INTO knowledge_fts(knowledge_fts, rowid, title, body_md)
  VALUES ('delete', old.rowid, old.title, old.body_md);
END;

CREATE TRIGGER knowledge_fts_update AFTER UPDATE OF title, body_md ON knowledge_objects BEGIN
  INSERT INTO knowledge_fts(knowledge_fts, rowid, title, body_md)
  VALUES ('delete', old.rowid, old.title, old.body_md);
  INSERT INTO knowledge_fts(rowid, title, body_md)
  VALUES (new.rowid, new.title, new.body_md);
END;
