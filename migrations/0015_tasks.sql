-- Daly Tasks & Projects, Milestone 1. Additive: new task_* tables only. Nothing existing is touched;
-- in particular the wedding planner's own `tasks` table is unrelated and stays as it is.
--
-- Access model (enforced by the Worker, backed here wherever the database can do it):
--   * Every task belongs to exactly one project. Each person's Inbox is a personal project.
--   * A project is reached only through a task_project_members row. Personal projects have exactly
--     one member, their owner (the triggers below refuse a second). Shared projects have owners,
--     editors and viewers. Portal roles grant nothing inside a project.
--   * Sections, parents and assignees are composite foreign keys onto (project_id, …), so the
--     database itself refuses a task whose section, parent or assignee belongs to another project.

-- One row per person: their time zone decides what "today" means for them.
CREATE TABLE task_preferences (
    email TEXT PRIMARY KEY COLLATE NOCASE,
    time_zone TEXT NOT NULL DEFAULT 'Australia/Sydney' CHECK (length(time_zone) BETWEEN 1 AND 60),
    -- Undated open tasks at this priority or more urgent also appear in Today (NULL: none).
    today_priority INTEGER CHECK (today_priority IS NULL OR today_priority BETWEEN 1 AND 4),
    updated_at TEXT NOT NULL
);

CREATE TABLE task_projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
    description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
    color TEXT NOT NULL DEFAULT 'gray' CHECK (color IN ('gray', 'brand', 'error', 'warning', 'success', 'blue', 'indigo', 'purple', 'pink', 'orange')),
    kind TEXT NOT NULL CHECK (kind IN ('personal', 'shared')),
    is_inbox INTEGER NOT NULL DEFAULT 0 CHECK (is_inbox IN (0, 1)),
    -- Set only on an Inbox: whose it is. One Inbox per person (unique index below).
    inbox_owner TEXT COLLATE NOCASE,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'on_hold', 'completed', 'archived')),
    start_date TEXT CHECK (start_date IS NULL OR start_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    target_date TEXT CHECK (target_date IS NULL OR target_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    default_view TEXT NOT NULL DEFAULT 'list' CHECK (default_view IN ('list', 'board')),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_by TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK ((is_inbox = 1) = (inbox_owner IS NOT NULL)),
    CHECK (is_inbox = 0 OR (kind = 'personal' AND status = 'active'))
);
CREATE UNIQUE INDEX task_projects_inbox ON task_projects(inbox_owner) WHERE is_inbox = 1;

-- Who can reach a project, and where it sits in their own sidebar (position is per person).
CREATE TABLE task_project_members (
    project_id TEXT NOT NULL REFERENCES task_projects(id) ON DELETE CASCADE,
    email TEXT NOT NULL COLLATE NOCASE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
    position REAL NOT NULL DEFAULT 0,
    added_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (project_id, email)
);
CREATE INDEX task_project_members_email ON task_project_members(email, position);

-- A personal project belongs to one person. Even a bug in the Worker can't add someone else to it,
-- or turn a shared project with several members back into a personal one.
CREATE TRIGGER task_personal_single_member BEFORE INSERT ON task_project_members
WHEN (SELECT kind FROM task_projects WHERE id = NEW.project_id) = 'personal'
     AND EXISTS (SELECT 1 FROM task_project_members WHERE project_id = NEW.project_id)
BEGIN
    SELECT RAISE(ABORT, 'personal projects have exactly one member');
END;
CREATE TRIGGER task_personal_kind BEFORE UPDATE OF kind ON task_projects
WHEN NEW.kind = 'personal' AND (SELECT COUNT(*) FROM task_project_members WHERE project_id = NEW.id) > 1
BEGIN
    SELECT RAISE(ABORT, 'personal projects have exactly one member');
END;
CREATE TRIGGER task_inbox_kind BEFORE UPDATE OF kind, is_inbox, inbox_owner ON task_projects
WHEN OLD.is_inbox = 1 AND (NEW.kind <> OLD.kind OR NEW.is_inbox <> OLD.is_inbox OR NEW.inbox_owner IS NOT OLD.inbox_owner)
BEGIN
    SELECT RAISE(ABORT, 'an Inbox stays personal');
END;

CREATE TABLE task_sections (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES task_projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
    position REAL NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (project_id, id)
);
CREATE INDEX task_sections_project ON task_sections(project_id, position);

-- Tasks. Dates are calendar dates ("YYYY-MM-DD") and times wall-clock times ("HH:MM"), never
-- timestamps, so a task due on the 24th stays on the 24th whatever the time zone or daylight saving.
-- Deleting a section that still has tasks is refused (no ON DELETE action on section_id): the
-- Worker moves them first.
CREATE TABLE task_items (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES task_projects(id) ON DELETE CASCADE,
    section_id TEXT,
    parent_id TEXT,
    -- 0 for a top-level task; subtasks nest at most three levels deep.
    depth INTEGER NOT NULL DEFAULT 0 CHECK (depth BETWEEN 0 AND 3),
    title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
    description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 10000),
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed')),
    -- 1 is the most urgent (P1), 4 the default (P4).
    priority INTEGER NOT NULL DEFAULT 4 CHECK (priority BETWEEN 1 AND 4),
    due_date TEXT CHECK (due_date IS NULL OR due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    due_time TEXT CHECK (due_time IS NULL OR (due_time GLOB '[0-2][0-9]:[0-5][0-9]' AND due_date IS NOT NULL)),
    deadline TEXT CHECK (deadline IS NULL OR deadline GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    -- A validated rule (src/shared/tasks/recurrence.ts). A repeating task always has a due date.
    recurrence_json TEXT CHECK (recurrence_json IS NULL OR (json_valid(recurrence_json) AND due_date IS NOT NULL)),
    is_milestone INTEGER NOT NULL DEFAULT 0 CHECK (is_milestone IN (0, 1)),
    assignee_email TEXT COLLATE NOCASE,
    position REAL NOT NULL,
    completed_at TEXT,
    completed_by TEXT,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_by TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
    CHECK ((parent_id IS NULL) = (depth = 0)),
    CHECK (parent_id IS NULL OR parent_id <> id),
    UNIQUE (project_id, id),
    FOREIGN KEY (project_id, section_id) REFERENCES task_sections(project_id, id),
    FOREIGN KEY (project_id, parent_id) REFERENCES task_items(project_id, id) ON DELETE CASCADE,
    -- An assignee must be a member of the task's project. Removing a member clears their
    -- assignments first, in the same batch.
    FOREIGN KEY (project_id, assignee_email) REFERENCES task_project_members(project_id, email)
);
CREATE INDEX task_items_project ON task_items(project_id, status, section_id, position);
CREATE INDEX task_items_parent ON task_items(parent_id, position) WHERE parent_id IS NOT NULL;
CREATE INDEX task_items_due ON task_items(project_id, status, due_date) WHERE due_date IS NOT NULL;
CREATE INDEX task_items_deadline ON task_items(project_id, status, deadline) WHERE deadline IS NOT NULL;
CREATE INDEX task_items_assignee ON task_items(assignee_email, status, due_date) WHERE assignee_email IS NOT NULL;
CREATE INDEX task_items_completed ON task_items(project_id, completed_at) WHERE status = 'completed';

-- A person's labels: their names, colours and order. Tasks carry label names (task_item_labels),
-- so everyone in a shared project sees the same labels on a shared task.
CREATE TABLE task_labels (
    id TEXT PRIMARY KEY,
    owner_email TEXT NOT NULL COLLATE NOCASE,
    name TEXT NOT NULL COLLATE NOCASE CHECK (length(name) BETWEEN 1 AND 60),
    color TEXT NOT NULL DEFAULT 'gray' CHECK (color IN ('gray', 'brand', 'error', 'warning', 'success', 'blue', 'indigo', 'purple', 'pink', 'orange')),
    position REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (owner_email, name)
);

CREATE TABLE task_item_labels (
    task_id TEXT NOT NULL REFERENCES task_items(id) ON DELETE CASCADE,
    name TEXT NOT NULL COLLATE NOCASE CHECK (length(name) BETWEEN 1 AND 60),
    added_by TEXT NOT NULL,
    added_at TEXT NOT NULL,
    PRIMARY KEY (task_id, name)
);
CREATE INDEX task_item_labels_name ON task_item_labels(name);

-- Completion history: one row each time a task (or one occurrence of a repeating task) is completed
-- or skipped. Reopening marks the row undone rather than deleting it.
CREATE TABLE task_completions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL REFERENCES task_items(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('completed', 'skipped')),
    -- The due date that was completed, and (for a repeating task) the one it moved on to.
    occurrence_date TEXT,
    next_date TEXT,
    at TEXT NOT NULL,
    by TEXT NOT NULL,
    undone_at TEXT,
    undone_by TEXT
);
CREATE INDEX task_completions_task ON task_completions(task_id, id);
CREATE INDEX task_completions_at ON task_completions(at);

CREATE TABLE task_comments (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES task_items(id) ON DELETE CASCADE,
    author_email TEXT NOT NULL COLLATE NOCASE,
    body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
    created_at TEXT NOT NULL,
    edited_at TEXT
);
CREATE INDEX task_comments_task ON task_comments(task_id, created_at);

-- A project's history, readable by its members only. Entries record the action, the task id and,
-- for changes, which fields changed (with values only for dates, priority, assignee and status):
-- never titles, descriptions or comments. task_id has no foreign key so history outlives a task.
CREATE TABLE task_activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES task_projects(id) ON DELETE CASCADE,
    task_id TEXT,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    at TEXT NOT NULL,
    changes TEXT CHECK (changes IS NULL OR json_valid(changes))
);
CREATE INDEX task_activity_project ON task_activity(project_id, id);
CREATE INDEX task_activity_task ON task_activity(task_id, id) WHERE task_id IS NOT NULL;

-- References from a task to Daly Knowledge objects. Only the id is stored; what a person sees of
-- the object is decided by their own Knowledge membership every time it's read.
CREATE TABLE task_knowledge_links (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES task_items(id) ON DELETE CASCADE,
    object_id TEXT NOT NULL REFERENCES knowledge_objects(id) ON DELETE CASCADE,
    added_by TEXT NOT NULL,
    added_at TEXT NOT NULL,
    UNIQUE (task_id, object_id)
);
CREATE INDEX task_knowledge_links_object ON task_knowledge_links(object_id);

-- Saved filters: a name and a definition validated by the Worker against a fixed list of fields
-- (src/shared/tasks/filters.ts), never SQL. Always private to the person who saved them.
CREATE TABLE task_saved_views (
    id TEXT PRIMARY KEY,
    owner_email TEXT NOT NULL COLLATE NOCASE,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
    definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
    position REAL NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX task_saved_views_owner ON task_saved_views(owner_email, position);

-- Reminders, each belonging to one person. remind_at is an instant (UTC); a relative reminder is
-- recalculated whenever its task's due date or time changes. Delivery is in-app only for now.
CREATE TABLE task_reminders (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES task_items(id) ON DELETE CASCADE,
    owner_email TEXT NOT NULL COLLATE NOCASE,
    kind TEXT NOT NULL CHECK (kind IN ('absolute', 'relative')),
    offset_minutes INTEGER CHECK (offset_minutes IS NULL OR offset_minutes BETWEEN 0 AND 10080),
    remind_at TEXT NOT NULL,
    dismissed_at TEXT,
    created_at TEXT NOT NULL,
    CHECK ((kind = 'relative') = (offset_minutes IS NOT NULL))
);
CREATE INDEX task_reminders_due ON task_reminders(owner_email, remind_at) WHERE dismissed_at IS NULL;
CREATE INDEX task_reminders_task ON task_reminders(task_id);
