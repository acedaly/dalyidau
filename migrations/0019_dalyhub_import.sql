-- DalyHub V2 → Daly Portal migration (docs/DALYHUB_MIGRATION.md): which portal records a DalyHub
-- import created, so the import is idempotent (running a plan again creates nothing twice) and
-- reversible (a revert removes exactly what was imported and is still untouched).
--
-- Ids, versions and counts only: never titles or text. Additive only; earlier Workers never read
-- these tables, so rolling the Worker back is safe.

CREATE TABLE dalyhub_import_runs (
    id TEXT PRIMARY KEY,
    owner_email TEXT NOT NULL COLLATE NOCASE,
    -- SHA-256 of the plan as applied, so the preview the owner approved is the plan that runs.
    plan_fingerprint TEXT NOT NULL CHECK (length(plan_fingerprint) = 64),
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'reverted')),
    summary_json TEXT CHECK (summary_json IS NULL OR json_valid(summary_json)),
    created_at TEXT NOT NULL,
    finished_at TEXT,
    reverted_at TEXT
);
CREATE INDEX dalyhub_import_runs_owner ON dalyhub_import_runs (owner_email, created_at);

CREATE TABLE dalyhub_import_items (
    owner_email TEXT NOT NULL COLLATE NOCASE,
    kind TEXT NOT NULL CHECK (kind IN ('project', 'goal', 'task', 'knowledge_object', 'project_knowledge_link')),
    -- The DalyHub entity id (or "checklist:<id>").
    source_id TEXT NOT NULL CHECK (length(source_id) BETWEEN 1 AND 128),
    target_id TEXT NOT NULL CHECK (length(target_id) <= 64),
    run_id TEXT NOT NULL REFERENCES dalyhub_import_runs (id),
    -- The record's version right after import: a later version means someone has edited it since.
    imported_version INTEGER,
    -- 'reverted' once a revert removed the record.
    state TEXT NOT NULL DEFAULT 'imported' CHECK (state IN ('imported', 'reverted')),
    created_at TEXT NOT NULL,
    PRIMARY KEY (owner_email, kind, source_id)
);
CREATE INDEX dalyhub_import_items_run ON dalyhub_import_items (run_id);
CREATE INDEX dalyhub_import_items_target ON dalyhub_import_items (target_id);
