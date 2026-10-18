-- Daly MCP gateway (docs/MCP.md): one row per write an AI client makes through mcp.daly.id.au.
--
-- The table is the audit trail for MCP writes and also what makes a retried write safe: a write
-- that carries a request id the same person already used returns the first result instead of
-- writing again. It holds ids and outcomes only, never titles, text or arguments, so it can't leak
-- private Knowledge or task content (Knowledge's own audit stays in knowledge_audit, Tasks' in
-- task_activity; both still record every MCP write as the person who made it).
--
-- Additive only. The Milestone 3 Worker never reads it, so rolling the Worker back is safe.

CREATE TABLE mcp_writes (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    tool TEXT NOT NULL CHECK (length(tool) <= 64),
    -- The client's request id. Cleared when the write fails, so the same id can be tried again.
    request_key TEXT CHECK (request_key IS NULL OR length(request_key) BETWEEN 8 AND 64),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed')),
    entity_type TEXT CHECK (entity_type IS NULL OR entity_type IN ('task', 'task_knowledge_link', 'knowledge_object')),
    entity_id TEXT CHECK (entity_id IS NULL OR length(entity_id) <= 64),
    error_code TEXT CHECK (error_code IS NULL OR length(error_code) <= 40),
    created_at TEXT NOT NULL,
    completed_at TEXT
);

CREATE UNIQUE INDEX mcp_writes_request ON mcp_writes (email, request_key) WHERE request_key IS NOT NULL;
CREATE INDEX mcp_writes_email ON mcp_writes (email, created_at);
