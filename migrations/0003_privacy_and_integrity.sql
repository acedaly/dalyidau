-- Soft deletion for personal records, and database-level guards that back up the app's validation.
-- Additive only: new nullable columns, new indexes and triggers. Safe to apply to a database that
-- already holds 0002 data; existing rows are treated as not deleted.

-- A deleted guest or household is hidden everywhere (lists, stats, exports, RSVP) but can be
-- restored until an owner erases it permanently (see docs/PRIVACY.md).
ALTER TABLE guests ADD COLUMN deleted_at TEXT;
ALTER TABLE guests ADD COLUMN deleted_by TEXT;
ALTER TABLE households ADD COLUMN deleted_at TEXT;
ALTER TABLE households ADD COLUMN deleted_by TEXT;
CREATE INDEX guests_deleted ON guests (deleted_at);
CREATE INDEX households_deleted ON households (deleted_at);

-- JSON columns must hold valid JSON of the right shape.
CREATE TRIGGER guests_json_insert BEFORE INSERT ON guests
WHEN json_valid(NEW.tags) = 0 OR json_type(NEW.tags) != 'array' OR json_valid(NEW.custom) = 0 OR json_type(NEW.custom) != 'object'
BEGIN SELECT RAISE(ABORT, 'guests.tags must be a JSON array and guests.custom a JSON object'); END;

CREATE TRIGGER guests_json_update BEFORE UPDATE OF tags, custom ON guests
WHEN json_valid(NEW.tags) = 0 OR json_type(NEW.tags) != 'array' OR json_valid(NEW.custom) = 0 OR json_type(NEW.custom) != 'object'
BEGIN SELECT RAISE(ABORT, 'guests.tags must be a JSON array and guests.custom a JSON object'); END;

-- Money is never negative.
CREATE TRIGGER budget_items_amounts_insert BEFORE INSERT ON budget_items
WHEN NEW.estimated_cents < 0 OR NEW.paid_cents < 0 OR COALESCE(NEW.actual_cents, 0) < 0
BEGIN SELECT RAISE(ABORT, 'budget amounts must not be negative'); END;

CREATE TRIGGER budget_items_amounts_update BEFORE UPDATE OF estimated_cents, actual_cents, paid_cents ON budget_items
WHEN NEW.estimated_cents < 0 OR NEW.paid_cents < 0 OR COALESCE(NEW.actual_cents, 0) < 0
BEGIN SELECT RAISE(ABORT, 'budget amounts must not be negative'); END;

-- The audit log is append-only except for retention and erasure, which only ever delete rows or
-- blank their details. Rewriting who did something, or when, is refused.
CREATE TRIGGER audit_log_immutable BEFORE UPDATE OF at, actor, action, entity_type, entity_id ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit entries cannot be rewritten'); END;

-- Lets a D1 batch abort itself: `INSERT INTO batch_guard (ok) SELECT 0 WHERE changes() = 0` fails
-- the CHECK (and rolls back the whole batch) when the previous statement changed nothing. Used for
-- compare-and-set updates, so two people saving the same record can't silently overwrite each other.
CREATE TABLE batch_guard (ok INTEGER NOT NULL CHECK (ok = 1));
