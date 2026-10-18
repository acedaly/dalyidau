-- Daly Intelligence (docs/INTELLIGENCE.md): the shared AI layer for Tasks, Knowledge and later
-- applications. Semantic search, Intelligent Capture, the AI Suggestions Inbox, Chief of Staff
-- briefings, meeting transcription, document extraction, usage and budgets, and shared attachments.
--
-- Principles the schema enforces or supports:
--   * AI proposes, people approve. Suggestions are rows a person reviews; nothing here writes Tasks
--     or Knowledge records by itself. An approved suggestion records the record it produced.
--   * Content-free bookkeeping. ai_usage, ai_jobs and the semantic index hold ids, counts, models
--     and outcomes, never prompts, titles, note text or transcripts.
--   * Private by owner. Captures, transcripts, suggestions and briefings belong to one person
--     (email) and are only ever read joined to that email. Knowledge access is re-checked through
--     space membership whenever Knowledge content is involved.
--   * Derived and rebuildable. ai_semantic_index only describes what is in Vectorize; dropping both
--     loses nothing, the indexer rebuilds them from knowledge_objects.
--
-- Additive except for one step: mcp_writes is rebuilt (every row copied) so an MCP write can
-- record a capture or a suggestion as its outcome, exactly as 0020 did for projects. The previous
-- Worker never reads the new tables and only writes entity types the rebuilt ledger still accepts.

-- --- Configuration -------------------------------------------------------------------------------

-- Account-wide settings: feature switches (all off by default), models, budgets and retention.
-- One JSON document per key, validated by the Worker (src/shared/intelligence/config.ts).
CREATE TABLE ai_config (
    key TEXT PRIMARY KEY CHECK (key IN ('intelligence')),
    value TEXT NOT NULL CHECK (json_valid(value)),
    version INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL
);

-- Each person's own choices: briefing sections and times, concise or detailed, notifications,
-- pausing scheduled intelligence, and spaces left out of their briefings.
CREATE TABLE ai_preferences (
    email TEXT PRIMARY KEY,
    value TEXT NOT NULL CHECK (json_valid(value)),
    version INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
);

-- Knowledge left out of AI processing: a whole space (object_id NULL) or one object. Excluded
-- content is never embedded, analysed or used as context, and its vectors are removed.
CREATE TABLE ai_exclusions (
    id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL REFERENCES knowledge_spaces(id) ON DELETE CASCADE,
    object_id TEXT,
    excluded_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (space_id, object_id) REFERENCES knowledge_objects(space_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX ai_exclusions_target ON ai_exclusions(space_id, COALESCE(object_id, ''));

-- --- Usage and budgets ---------------------------------------------------------------------------

-- One row per model call. Never the prompt, the input or the output.
CREATE TABLE ai_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    day TEXT NOT NULL,
    month TEXT NOT NULL,
    email TEXT,
    space_id TEXT,
    feature TEXT NOT NULL CHECK (length(feature) <= 40),
    task TEXT NOT NULL CHECK (task IN ('generate', 'extract', 'summarise', 'classify', 'embed', 'transcribe', 'document')),
    provider TEXT NOT NULL CHECK (length(provider) <= 40),
    model TEXT NOT NULL CHECK (length(model) <= 120),
    input_units INTEGER NOT NULL DEFAULT 0,
    output_units INTEGER NOT NULL DEFAULT 0,
    unit TEXT NOT NULL CHECK (unit IN ('tokens', 'audio_seconds', 'documents')),
    neurons REAL NOT NULL DEFAULT 0 CHECK (neurons >= 0),
    estimated_usd REAL NOT NULL DEFAULT 0 CHECK (estimated_usd >= 0),
    measured INTEGER NOT NULL DEFAULT 0 CHECK (measured IN (0, 1)),
    duration_ms INTEGER NOT NULL DEFAULT 0,
    ok INTEGER NOT NULL CHECK (ok IN (0, 1)),
    error_code TEXT CHECK (error_code IS NULL OR length(error_code) <= 40),
    job_id TEXT
);
CREATE INDEX ai_usage_day ON ai_usage(day, feature);
CREATE INDEX ai_usage_month ON ai_usage(month);
CREATE INDEX ai_usage_email ON ai_usage(email, day);
CREATE INDEX ai_usage_recent ON ai_usage(provider, id DESC);

-- Budget alerts already raised, so each threshold is reported once per period.
CREATE TABLE ai_alerts (
    period TEXT NOT NULL,
    scope TEXT NOT NULL CHECK (length(scope) <= 60),
    threshold INTEGER NOT NULL CHECK (threshold BETWEEN 1 AND 100),
    raised_at TEXT NOT NULL,
    PRIMARY KEY (period, scope, threshold)
);

-- --- Background work -----------------------------------------------------------------------------

-- Durable, idempotent jobs, run by the cron and nudged after a request. A dedupe key allows only
-- one live job per subject; a claim with a token lets exactly one runner work on a job at a time,
-- and a claim that goes stale is taken over. Failures back off and stop after max_attempts.
CREATE TABLE ai_jobs (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('capture.analyse', 'meeting.transcribe', 'document.extract', 'briefing.prepare')),
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'waiting_approval', 'done', 'failed', 'cancelled')),
    subject_id TEXT NOT NULL,
    dedupe_key TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
    run_after TEXT NOT NULL,
    claim TEXT,
    claimed_at TEXT,
    progress TEXT CHECK (progress IS NULL OR json_valid(progress)),
    estimate_neurons REAL,
    error_code TEXT CHECK (error_code IS NULL OR length(error_code) <= 40),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    finished_at TEXT
);
CREATE UNIQUE INDEX ai_jobs_live ON ai_jobs(dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running', 'waiting_approval');
CREATE INDEX ai_jobs_due ON ai_jobs(status, run_after);
CREATE INDEX ai_jobs_email ON ai_jobs(email, created_at DESC);
CREATE INDEX ai_jobs_subject ON ai_jobs(subject_id);

-- --- Semantic index (derived) --------------------------------------------------------------------

-- What Vectorize holds for each Knowledge object: its version and content hash when embedded, the
-- model and how many chunks. Vectors live in a namespace per space and carry only ids. No foreign
-- key on purpose: a row outliving its object is how the indexer knows which vectors to delete.
CREATE TABLE ai_semantic_index (
    object_id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL,
    object_version INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    model TEXT NOT NULL,
    chunk_count INTEGER NOT NULL CHECK (chunk_count BETWEEN 0 AND 256),
    status TEXT NOT NULL CHECK (status IN ('indexed', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    error_code TEXT CHECK (error_code IS NULL OR length(error_code) <= 40),
    indexed_at TEXT NOT NULL
);
CREATE INDEX ai_semantic_index_space ON ai_semantic_index(space_id);

-- --- Capture, transcripts and suggestions ---------------------------------------------------------

-- Something a person handed to Intelligent Capture: pasted text, a document, a recording, an
-- existing Knowledge object or text from another application. `text` is the source content (as
-- captured, extracted or transcribed); `summary` is generated commentary, kept apart from it.
CREATE TABLE ai_captures (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    space_id TEXT REFERENCES knowledge_spaces(id) ON DELETE SET NULL,
    source TEXT NOT NULL CHECK (source IN ('text', 'document', 'audio', 'knowledge', 'mcp', 'app')),
    title TEXT NOT NULL CHECK (length(title) <= 300),
    text TEXT CHECK (text IS NULL OR length(text) <= 400000),
    text_hash TEXT,
    source_object_id TEXT,
    attachment_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('received', 'extracting', 'transcribing', 'analysing', 'ready', 'failed', 'cancelled')),
    error_code TEXT CHECK (error_code IS NULL OR length(error_code) <= 40),
    summary TEXT CHECK (summary IS NULL OR length(summary) <= 20000),
    language TEXT CHECK (language IS NULL OR length(language) <= 12),
    request_key TEXT CHECK (request_key IS NULL OR length(request_key) BETWEEN 8 AND 64),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    analysed_at TEXT
);
CREATE INDEX ai_captures_email ON ai_captures(email, created_at DESC);
CREATE UNIQUE INDEX ai_captures_request ON ai_captures(email, request_key) WHERE request_key IS NOT NULL;

-- Timing and language for a transcribed recording. Each chunk's text is kept as it completes, so
-- a transcription interrupted part-way resumes where it stopped instead of starting again.
CREATE TABLE ai_transcripts (
    capture_id TEXT PRIMARY KEY REFERENCES ai_captures(id) ON DELETE CASCADE,
    model TEXT NOT NULL,
    language TEXT,
    duration_seconds REAL,
    chunks_total INTEGER NOT NULL CHECK (chunks_total BETWEEN 1 AND 500),
    chunks_done INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    completed_at TEXT
);
CREATE TABLE ai_transcript_parts (
    capture_id TEXT NOT NULL REFERENCES ai_transcripts(capture_id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,
    offset_seconds REAL NOT NULL DEFAULT 0,
    text TEXT NOT NULL,
    segments TEXT CHECK (segments IS NULL OR json_valid(segments)),
    PRIMARY KEY (capture_id, idx)
);

-- A proposed action for one person to review. `payload` is the validated proposal; `evidence`
-- quotes the source it came from. Applying moves pending → applying → applied under a version
-- check, and records the Tasks or Knowledge record it produced, so it can never apply twice.
CREATE TABLE ai_suggestions (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    capture_id TEXT REFERENCES ai_captures(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('task', 'project', 'knowledge_object', 'decision', 'meeting_note', 'tags', 'link', 'follow_up', 'fact')),
    status TEXT NOT NULL CHECK (status IN ('pending', 'applying', 'applied', 'dismissed', 'failed')),
    payload TEXT NOT NULL CHECK (json_valid(payload)),
    reason TEXT CHECK (reason IS NULL OR length(reason) <= 1000),
    evidence TEXT CHECK (evidence IS NULL OR length(evidence) <= 1000),
    confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    depends_on TEXT,
    dedupe_key TEXT NOT NULL,
    result_type TEXT CHECK (result_type IS NULL OR result_type IN ('task', 'task_project', 'knowledge_object', 'knowledge_relation', 'knowledge_tags')),
    result_id TEXT,
    error_code TEXT CHECK (error_code IS NULL OR length(error_code) <= 40),
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    decided_at TEXT
);
CREATE INDEX ai_suggestions_email ON ai_suggestions(email, status, created_at DESC);
CREATE INDEX ai_suggestions_capture ON ai_suggestions(capture_id);
CREATE UNIQUE INDEX ai_suggestions_dedupe ON ai_suggestions(email, capture_id, dedupe_key);

-- --- Briefings -----------------------------------------------------------------------------------

-- One daily briefing per person and date, one weekly review per person and week ending. `facts`
-- are what Tasks and Knowledge record; `recommendations` (optional) are AI proposals, labelled as
-- such. The fingerprint is a hash of the facts: when nothing changed, nothing is regenerated.
CREATE TABLE ai_briefings (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('daily', 'weekly')),
    period TEXT NOT NULL CHECK (length(period) = 10),
    facts TEXT NOT NULL CHECK (json_valid(facts)),
    fingerprint TEXT NOT NULL,
    recommendations TEXT CHECK (recommendations IS NULL OR json_valid(recommendations)),
    model TEXT,
    status TEXT NOT NULL CHECK (status IN ('facts_only', 'ready', 'failed')),
    generated_at TEXT NOT NULL,
    notified_at TEXT,
    UNIQUE (email, kind, period)
);

-- --- Shared attachments --------------------------------------------------------------------------

-- Files in R2, for every application. Retention:
--   permanent  Knowledge attachments: kept until someone deletes them on purpose.
--   referenced Task and project attachments: kept while the task exists, then a grace period.
--   temporary  Uploads for processing: purged after processing (a short, configurable period).
-- `keep` = 1 marks a file for permanent retention; nothing automatic ever deletes it.
CREATE TABLE attachments (
    id TEXT PRIMARY KEY,
    owner_email TEXT NOT NULL,
    purpose TEXT NOT NULL CHECK (purpose IN ('knowledge', 'task', 'processing')),
    space_id TEXT REFERENCES knowledge_spaces(id) ON DELETE SET NULL,
    object_id TEXT,
    task_id TEXT,
    capture_id TEXT,
    r2_key TEXT NOT NULL UNIQUE,
    filename TEXT NOT NULL CHECK (length(filename) <= 200),
    content_type TEXT NOT NULL CHECK (length(content_type) <= 100),
    bytes INTEGER NOT NULL DEFAULT 0 CHECK (bytes >= 0),
    sha256 TEXT,
    retention TEXT NOT NULL CHECK (retention IN ('permanent', 'referenced', 'temporary')),
    keep INTEGER NOT NULL DEFAULT 0 CHECK (keep IN (0, 1)),
    status TEXT NOT NULL CHECK (status IN ('uploading', 'stored', 'processed', 'failed', 'deleted')),
    upload_id TEXT,
    parts TEXT CHECK (parts IS NULL OR json_valid(parts)),
    purge_after TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    CHECK (keep = 0 OR retention = 'permanent')
);
CREATE INDEX attachments_owner ON attachments(owner_email, created_at DESC);
CREATE INDEX attachments_purge ON attachments(status, purge_after);
CREATE INDEX attachments_object ON attachments(object_id);
CREATE INDEX attachments_task ON attachments(task_id);

-- --- MCP write ledger ----------------------------------------------------------------------------

-- SQLite can't widen a CHECK in place: rebuild mcp_writes with the capture and suggestion outcomes,
-- copying every row unchanged (same columns, order and indexes; nothing refers to the table).
CREATE TABLE mcp_writes_next (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    tool TEXT NOT NULL CHECK (length(tool) <= 64),
    -- The client's request id. Cleared when the write fails, so the same id can be tried again.
    request_key TEXT CHECK (request_key IS NULL OR length(request_key) BETWEEN 8 AND 64),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed')),
    entity_type TEXT CHECK (
        entity_type IS NULL OR entity_type IN ('task', 'task_knowledge_link', 'knowledge_object', 'task_project', 'ai_capture', 'ai_suggestion')
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
