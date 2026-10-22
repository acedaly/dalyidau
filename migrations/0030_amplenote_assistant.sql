-- Amplenote for AI assistants (docs/AMPLENOTE.md#ai-assistants, docs/MCP.md#amplenote): four MCP tools
-- that list note titles and add notes, text and tasks to the owner's Amplenote. Amplenote stays the
-- only place the notes live: nothing here stores note content, a note list or a task.
--
-- Additive except for one step: mcp_writes is rebuilt (every row copied) so an MCP write can record
-- an Amplenote note as its outcome, the same pattern as 0020–0027. The previous Worker keeps working
-- against the rebuilt ledger: it only writes entity types the ledger still accepts, and it never
-- reads the new amplenote_oauth_states column.

-- The scope a sign-in asked Amplenote for, so the connection records what was granted even when
-- Amplenote's token response doesn't repeat it. NULL on sign-ins started before this migration.
ALTER TABLE amplenote_oauth_states ADD COLUMN scope TEXT CHECK (scope IS NULL OR length(scope) <= 200);

-- SQLite can't widen a CHECK in place: rebuild mcp_writes with the Amplenote outcome, copying every
-- row and recreating both indexes.
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
            'calendar_event', 'calendar_subscription', 'leave_booking', 'task_time_block',
            'asset', 'asset_maintenance', 'asset_link',
            'centre_rule', 'centre_report', 'centre_report_schedule',
            'amplenote_note'
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
