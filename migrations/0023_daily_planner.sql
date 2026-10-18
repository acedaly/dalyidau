-- Daily Planner and time blocking (Milestone 6.2). See docs/DAILY_PLANNER.md.
--
-- Tasks stay the source of truth. A time block is a session of time someone sets aside for one of
-- their tasks; it never copies the task and never changes its due date, deadline or status.
-- Blocks belong to one person and are private to them. They're reached only through the person's
-- own membership of the task's project, here in the database as well as in the Worker.
--
-- Additive except for one step: mcp_writes is rebuilt (every row copied) so an MCP write can record
-- a time block as its outcome, the same pattern as 0020, 0021 and 0022. The previous Worker never
-- reads the new tables or column and only writes entity types the rebuilt ledger still accepts.
-- Activity goes to calendar_activity (ids only, never task titles).

-- --- Planning preferences -----------------------------------------------------------------------

-- Each person's working hours for planning, buffers, session lengths and daily focus limit. One JSON
-- document, validated by the Worker (src/shared/planner/types.ts). Kept apart from
-- calendar_preferences so an earlier Worker, which validates that document strictly, never meets
-- fields it doesn't know.
CREATE TABLE planner_preferences (
    email TEXT PRIMARY KEY,
    value TEXT NOT NULL CHECK (json_valid(value) AND length(value) <= 4000),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    updated_at TEXT NOT NULL
);

-- --- Effort estimates ---------------------------------------------------------------------------

-- How long a task is expected to take, in minutes. One per task, shared by everyone who can work on
-- it (like its priority). Removed with the task.
CREATE TABLE task_estimates (
    task_id TEXT PRIMARY KEY REFERENCES task_items (id) ON DELETE CASCADE,
    minutes INTEGER NOT NULL CHECK (minutes BETWEEN 5 AND 2880),
    updated_by TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- --- Time blocks --------------------------------------------------------------------------------

-- Times are stored as the wall-clock date and start time in the block's IANA zone (so 9:00 stays
-- 9:00), a length in minutes, and the UTC instants of its start and end for window queries. The end
-- is the start plus the length in elapsed time.
CREATE TABLE task_time_blocks (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES task_items (id) ON DELETE CASCADE,
    owner_email TEXT NOT NULL COLLATE NOCASE,
    start_date TEXT NOT NULL CHECK (start_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    start_time TEXT NOT NULL CHECK (start_time GLOB '[0-2][0-9]:[0-5][0-9]'),
    duration_minutes INTEGER NOT NULL CHECK (duration_minutes BETWEEN 5 AND 720),
    time_zone TEXT NOT NULL CHECK (length(time_zone) BETWEEN 1 AND 64),
    start_at TEXT NOT NULL,
    end_at TEXT NOT NULL,
    -- For a repeating task: the occurrence (its due date when the session was planned). NULL otherwise.
    occurrence_date TEXT CHECK (occurrence_date IS NULL OR occurrence_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'cancelled')),
    -- How it was made: by hand, by accepting a suggestion, or through MCP.
    source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'suggestion', 'mcp')),
    client_id TEXT CHECK (client_id IS NULL OR length(client_id) BETWEEN 8 AND 64),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    cancelled_at TEXT,
    CHECK (end_at > start_at),
    CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
);
CREATE INDEX task_time_blocks_owner ON task_time_blocks (owner_email, start_at) WHERE status = 'scheduled';
CREATE INDEX task_time_blocks_task ON task_time_blocks (task_id, status);
-- A retried create (lost response) returns the first block instead of making a second.
CREATE UNIQUE INDEX task_time_blocks_client ON task_time_blocks (owner_email, client_id) WHERE client_id IS NOT NULL;

-- Only someone who can work on the task (a member of its project above viewer) can hold time for it.
CREATE TRIGGER task_time_blocks_member BEFORE INSERT ON task_time_blocks
WHEN NOT EXISTS (
    SELECT 1 FROM task_items t JOIN task_project_members m ON m.project_id = t.project_id AND m.email = NEW.owner_email
    WHERE t.id = NEW.task_id AND m.role <> 'viewer'
)
BEGIN
    SELECT RAISE(ABORT, 'Time can only be blocked for a task you can work on');
END;

-- A block always stays with its task and its person.
CREATE TRIGGER task_time_blocks_fixed BEFORE UPDATE OF task_id, owner_email ON task_time_blocks
WHEN NEW.task_id <> OLD.task_id OR NEW.owner_email <> OLD.owner_email
BEGIN
    SELECT RAISE(ABORT, 'A time block stays with its task and person');
END;

-- Leaving a project removes your time blocks for its tasks.
CREATE TRIGGER task_time_blocks_member_removed AFTER DELETE ON task_project_members
BEGIN
    DELETE FROM task_time_blocks WHERE owner_email = OLD.email AND task_id IN (SELECT id FROM task_items WHERE project_id = OLD.project_id);
END;

-- Moving a task to a project someone isn't in removes their blocks for it.
CREATE TRIGGER task_time_blocks_task_moved AFTER UPDATE OF project_id ON task_items
WHEN NEW.project_id <> OLD.project_id
BEGIN
    DELETE FROM task_time_blocks WHERE task_id = NEW.id
        AND NOT EXISTS (SELECT 1 FROM task_project_members m WHERE m.project_id = NEW.project_id AND m.email = task_time_blocks.owner_email AND m.role <> 'viewer');
END;

-- --- Private feeds ------------------------------------------------------------------------------

-- Whether a private ICS feed publishes the owner's time blocks: never ('none', the default), as
-- "Busy", or as "Focus time". A task's title is never published. A separate column, because the
-- feed's scope document is validated strictly by the earlier Worker.
ALTER TABLE calendar_feeds ADD COLUMN time_blocks TEXT NOT NULL DEFAULT 'none' CHECK (time_blocks IN ('none', 'busy', 'focus'));

-- --- MCP ledger ---------------------------------------------------------------------------------

-- SQLite can't widen a CHECK in place: rebuild mcp_writes with the time block outcome, copying every
-- row unchanged (same columns, order and indexes; nothing refers to the table).
CREATE TABLE mcp_writes_next (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    tool TEXT NOT NULL CHECK (length(tool) <= 64),
    -- The client's request id. Cleared when the write fails, so the same id can be tried again.
    request_key TEXT CHECK (request_key IS NULL OR length(request_key) BETWEEN 8 AND 64),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed')),
    entity_type TEXT CHECK (
        entity_type IS NULL OR entity_type IN (
            'task', 'task_knowledge_link', 'knowledge_object', 'task_project', 'ai_capture', 'ai_suggestion',
            'calendar_event', 'calendar_subscription', 'leave_booking', 'task_time_block'
        )
    ),
    entity_id TEXT CHECK (entity_id IS NULL OR length(entity_id) <= 64),
    error_code TEXT CHECK (error_code IS NULL OR length(error_code) <= 40),
    created_at TEXT NOT NULL,
    completed_at TEXT
);

INSERT INTO mcp_writes_next (id, email, tool, request_key, status, entity_type, entity_id, error_code, created_at, completed_at)
SELECT id, email, tool, request_key, status, entity_type, entity_id, error_code, created_at, completed_at FROM mcp_writes;

DROP TABLE mcp_writes;
ALTER TABLE mcp_writes_next RENAME TO mcp_writes;

CREATE UNIQUE INDEX mcp_writes_request ON mcp_writes (email, request_key) WHERE request_key IS NOT NULL;
CREATE INDEX mcp_writes_email ON mcp_writes (email, created_at);
