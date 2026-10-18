-- Daly MCP project management (docs/MCP.md): AI clients can create, edit, archive and restore
-- Tasks projects through mcp.daly.id.au.
--
-- 1. Retry-safe project creation, exactly as 0016 did for tasks. A create that carries a client id
--    and is sent again (a dropped connection, a retried MCP call) hits the unique index, and the
--    Worker returns the first project instead of making a second one. Additive.
ALTER TABLE task_projects ADD COLUMN client_id TEXT CHECK (client_id IS NULL OR length(client_id) BETWEEN 8 AND 64);
CREATE UNIQUE INDEX task_projects_client ON task_projects(created_by, client_id) WHERE client_id IS NOT NULL;

-- 2. The MCP write ledger must be able to name a project as the record a write produced. SQLite
--    can't change a CHECK constraint in place, so mcp_writes is rebuilt with the wider list and
--    every row copied across unchanged. This is the one non-additive step, and a safe one: no table
--    refers to mcp_writes, the columns, their order and both indexes are identical, and the
--    previous Worker only ever writes the entity types it already knew, so rolling the code back
--    needs nothing.
CREATE TABLE mcp_writes_next (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    tool TEXT NOT NULL CHECK (length(tool) <= 64),
    -- The client's request id. Cleared when the write fails, so the same id can be tried again.
    request_key TEXT CHECK (request_key IS NULL OR length(request_key) BETWEEN 8 AND 64),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed')),
    entity_type TEXT CHECK (entity_type IS NULL OR entity_type IN ('task', 'task_knowledge_link', 'knowledge_object', 'task_project')),
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
