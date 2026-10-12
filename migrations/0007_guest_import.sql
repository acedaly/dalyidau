-- Guest list imports (Say I Do and other CSVs) and invitation generation.
-- Additive only: no existing row is changed by this migration.

-- Where a household came from, so a re-import finds it again instead of creating a duplicate.
-- For Say I Do this is the party's unique link id (https://sayi.do/s/<id>). Soft-deleted
-- households keep their reference, so re-importing a deleted party is flagged, never recreated.
ALTER TABLE households ADD COLUMN external_source TEXT;
ALTER TABLE households ADD COLUMN external_id TEXT;
CREATE UNIQUE INDEX households_external ON households (external_source, external_id) WHERE external_id IS NOT NULL;

-- When invitations were last generated in bulk for this household (links ready to send).
-- Generating never sends anything.
ALTER TABLE households ADD COLUMN invitation_generated_at TEXT;

-- The order guests are listed in on their household's invitation (from the import file).
ALTER TABLE guests ADD COLUMN household_order INTEGER;

-- One row per applied import. client_id makes a retried import a no-op.
CREATE TABLE guest_imports (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL CHECK (source IN ('sayido', 'csv')),
    file_name TEXT,
    file_sha256 TEXT NOT NULL,
    actor TEXT NOT NULL,
    created_at TEXT NOT NULL,
    summary TEXT NOT NULL                -- JSON counts; no personal data
);
CREATE INDEX guest_imports_created ON guest_imports (created_at DESC);
CREATE INDEX guest_imports_file ON guest_imports (file_sha256);

-- The import report: what happened to every row. Holds names and addresses, so erasing a guest or
-- household scrubs its rows here too (worker/portal/privacy.ts).
CREATE TABLE guest_import_rows (
    import_id TEXT NOT NULL REFERENCES guest_imports (id) ON DELETE CASCADE,
    line INTEGER NOT NULL,
    guest_id TEXT,
    household_id TEXT,
    name TEXT NOT NULL,
    household_name TEXT,
    address TEXT,
    action TEXT NOT NULL,                -- create | update | link | unchanged | skip | error
    household_action TEXT,               -- create | update | unchanged | skip
    notes TEXT NOT NULL DEFAULT '[]',    -- JSON array of strings
    PRIMARY KEY (import_id, line)
);
CREATE INDEX guest_import_rows_guest ON guest_import_rows (guest_id);
CREATE INDEX guest_import_rows_household ON guest_import_rows (household_id);
