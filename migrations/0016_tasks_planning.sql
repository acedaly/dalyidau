-- Daly Tasks, Milestone 2: planning, reminders, templates and Todoist import.
--
-- Additive: new tables, new nullable or defaulted columns and new indexes. The one UPDATE marks
-- reminders that are still in the future as waiting for background delivery; nothing else that
-- exists is changed. Rolling the Worker back to Milestone 1 leaves the database fully usable: the
-- old code never reads the new columns or tables.

-- Each person's own choices for their lists (sort, grouping, priority and project filters, the
-- Upcoming layout). Validated by the Worker (src/shared/tasks/view-preferences.ts); private.
CREATE TABLE task_view_preferences (
    email TEXT NOT NULL COLLATE NOCASE,
    view TEXT NOT NULL CHECK (view IN ('mine', 'today', 'upcoming', 'overdue', 'inbox')),
    prefs_json TEXT NOT NULL CHECK (json_valid(prefs_json) AND length(prefs_json) <= 4000),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (email, view)
);

-- Reminder and planning preferences, per person. Email reminders are opt-in.
ALTER TABLE task_preferences ADD COLUMN reminders_enabled INTEGER NOT NULL DEFAULT 1 CHECK (reminders_enabled IN (0, 1));
ALTER TABLE task_preferences ADD COLUMN reminder_email INTEGER NOT NULL DEFAULT 0 CHECK (reminder_email IN (0, 1));
-- Minutes before the due time (a date-only task counts as due at 9 am) for a reminder added to every
-- new dated task. NULL: none.
ALTER TABLE task_preferences ADD COLUMN default_reminder_minutes INTEGER CHECK (default_reminder_minutes IS NULL OR default_reminder_minutes BETWEEN 0 AND 10080);
-- Quiet hours, as local wall-clock times. A reminder falling inside them is delivered when they end.
ALTER TABLE task_preferences ADD COLUMN quiet_start TEXT CHECK (quiet_start IS NULL OR quiet_start GLOB '[0-2][0-9]:[0-5][0-9]');
ALTER TABLE task_preferences ADD COLUMN quiet_end TEXT CHECK (quiet_end IS NULL OR quiet_end GLOB '[0-2][0-9]:[0-5][0-9]');
ALTER TABLE task_preferences ADD COLUMN landing_page TEXT NOT NULL DEFAULT 'today' CHECK (landing_page IN ('today', 'upcoming', 'inbox', 'mine'));

-- Background delivery of reminders (worker/tasks/notify.ts), driven by the existing cron trigger.
-- delivery_status: NULL (in-app only: created before this migration and already past),
-- 'pending', 'sent', 'failed' (gave up after retries), 'expired' (too late to be useful) or
-- 'cancelled' (the recipient lost access, the task was completed, or they turned reminders off).
-- A run claims a reminder (claim_token, claimed_at) before sending, so overlapping runs don't both send it.
ALTER TABLE task_reminders ADD COLUMN delivery_status TEXT CHECK (delivery_status IS NULL OR delivery_status IN ('pending', 'sent', 'failed', 'expired', 'cancelled'));
ALTER TABLE task_reminders ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0);
ALTER TABLE task_reminders ADD COLUMN next_attempt_at TEXT;
ALTER TABLE task_reminders ADD COLUMN last_attempt_at TEXT;
ALTER TABLE task_reminders ADD COLUMN delivered_at TEXT;
ALTER TABLE task_reminders ADD COLUMN last_error TEXT CHECK (last_error IS NULL OR length(last_error) <= 300);
ALTER TABLE task_reminders ADD COLUMN claim_token TEXT;
ALTER TABLE task_reminders ADD COLUMN claimed_at TEXT;
CREATE INDEX task_reminders_delivery ON task_reminders(next_attempt_at) WHERE delivery_status = 'pending';
UPDATE task_reminders SET delivery_status = 'pending', next_attempt_at = remind_at
WHERE dismissed_at IS NULL AND remind_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now');

-- Quick Add sends a random id with each new task. If the response is lost and the same request is
-- sent again, the unique index refuses the second insert and the Worker returns the first task.
ALTER TABLE task_items ADD COLUMN client_id TEXT CHECK (client_id IS NULL OR length(client_id) BETWEEN 8 AND 64);
CREATE UNIQUE INDEX task_items_client ON task_items(created_by, client_id) WHERE client_id IS NOT NULL;

-- Today's progress counts what the caller completed today: a range over their own completions.
CREATE INDEX task_completions_by ON task_completions(by, at) WHERE undone_at IS NULL;

-- Exceptions to a repeating task's series, for occurrences that haven't come yet: skip that date,
-- or move that one occurrence to another date. Keyed on the series date it replaces. The task row
-- still holds only the current occurrence; these are consulted when it moves along the series and
-- when later occurrences are projected. Changing the rule removes them.
CREATE TABLE task_recurrence_exceptions (
    task_id TEXT NOT NULL REFERENCES task_items(id) ON DELETE CASCADE,
    occurrence_date TEXT NOT NULL CHECK (occurrence_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    kind TEXT NOT NULL CHECK (kind IN ('skip', 'move')),
    moved_to TEXT CHECK (moved_to IS NULL OR moved_to GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (task_id, occurrence_date),
    CHECK ((kind = 'move') = (moved_to IS NOT NULL))
);

-- Reusable tasks with a checklist. A template is private to its owner unless it belongs to a shared
-- project (shared_project_id), in which case that project's members can see and use it and its
-- editors can change it. Using one creates an ordinary, independent task and subtasks.
CREATE TABLE task_templates (
    id TEXT PRIMARY KEY,
    owner_email TEXT NOT NULL COLLATE NOCASE,
    shared_project_id TEXT REFERENCES task_projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
    title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
    description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 10000),
    priority INTEGER NOT NULL DEFAULT 4 CHECK (priority BETWEEN 1 AND 4),
    default_project_id TEXT REFERENCES task_projects(id) ON DELETE SET NULL,
    labels_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(labels_json)),
    -- Due this many days after the day it's used (0 = that day); NULL: no date.
    due_offset_days INTEGER CHECK (due_offset_days IS NULL OR due_offset_days BETWEEN 0 AND 366),
    due_time TEXT CHECK (due_time IS NULL OR (due_time GLOB '[0-2][0-9]:[0-5][0-9]' AND due_offset_days IS NOT NULL)),
    recurrence_json TEXT CHECK (recurrence_json IS NULL OR (json_valid(recurrence_json) AND due_offset_days IS NOT NULL)),
    -- The checklist: [{ "title": "…", "children": [ … ] }], at most three levels and 100 items.
    subtasks_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(subtasks_json) AND length(subtasks_json) <= 60000),
    archived_at TEXT,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX task_templates_owner ON task_templates(owner_email, name);
CREATE INDEX task_templates_project ON task_templates(shared_project_id) WHERE shared_project_id IS NOT NULL;

-- Imports from other apps (Todoist). One batch per run; items record where each imported project,
-- section, task and comment came from, so importing the same file again finds them instead of
-- making copies. Todoist's CSV export has no ids, so source_key is derived from the item's place in
-- the export (worker/tasks/import.ts documents the rule). target_id has no foreign key: if the
-- imported task was deleted since, a re-import says so and leaves it deleted.
CREATE TABLE task_import_batches (
    id TEXT PRIMARY KEY,
    owner_email TEXT NOT NULL COLLATE NOCASE,
    source TEXT NOT NULL CHECK (source IN ('todoist_csv')),
    file_fingerprint TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
    options_json TEXT NOT NULL CHECK (json_valid(options_json)),
    summary_json TEXT CHECK (summary_json IS NULL OR json_valid(summary_json)),
    created_at TEXT NOT NULL,
    finished_at TEXT
);
CREATE INDEX task_import_batches_owner ON task_import_batches(owner_email, created_at);

CREATE TABLE task_import_items (
    owner_email TEXT NOT NULL COLLATE NOCASE,
    source TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('project', 'section', 'task', 'comment')),
    source_key TEXT NOT NULL CHECK (length(source_key) BETWEEN 1 AND 128),
    target_id TEXT NOT NULL,
    batch_id TEXT NOT NULL REFERENCES task_import_batches(id) ON DELETE CASCADE,
    -- The task's version right after import: a later version means someone has edited it since.
    imported_version INTEGER,
    content_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (owner_email, source, kind, source_key)
);
CREATE INDEX task_import_items_target ON task_import_items(target_id);
