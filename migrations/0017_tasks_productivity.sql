-- Daly Tasks, Milestone 3: integrated productivity (dashboards, project health and reviews, goals,
-- household routines, project Knowledge links, reports).
--
-- Additive only: new tables, new nullable or defaulted columns, new indexes and triggers. Nothing
-- that exists is changed or deleted. The Milestone 2 Worker never reads any of it, so rolling the
-- Worker back leaves the database fully usable.
--
-- Access model, unchanged: everything is reached through the caller's own membership row. Reviews,
-- routines and project Knowledge links belong to a project and follow its membership. Goals have
-- their own membership (task_goal_members), exactly like projects: a personal goal has one member,
-- and a shared goal is shared only with the people added to it. Linking a goal to a shared project
-- shares nothing.

-- --- Project health and reviews ------------------------------------------------------------------

-- How often the project should be reviewed ('none': on demand only), and an optional manual health
-- status that replaces the calculated one until it's cleared (who set it and when are kept).
ALTER TABLE task_projects ADD COLUMN review_frequency TEXT NOT NULL DEFAULT 'none' CHECK (review_frequency IN ('none', 'weekly', 'fortnightly', 'monthly'));
ALTER TABLE task_projects ADD COLUMN health_override TEXT CHECK (health_override IS NULL OR health_override IN ('on_track', 'needs_attention', 'at_risk'));
ALTER TABLE task_projects ADD COLUMN health_note TEXT CHECK (health_note IS NULL OR length(health_note) <= 280);
ALTER TABLE task_projects ADD COLUMN health_set_by TEXT;
ALTER TABLE task_projects ADD COLUMN health_set_at TEXT;

-- A review: a short note written by a member, the health they recorded, and the project's numbers
-- at the moment it was completed (counts only, never titles). At most one draft per project, so two
-- people starting a review at once end up in the same one; edits carry a version.
CREATE TABLE task_project_reviews (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES task_projects(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('draft', 'completed')),
    note TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 5000),
    health TEXT CHECK (health IS NULL OR health IN ('on_track', 'needs_attention', 'at_risk')),
    -- What "since the last review" means for this one: the previous review's completion (an instant).
    period_start TEXT,
    snapshot_json TEXT CHECK (snapshot_json IS NULL OR (json_valid(snapshot_json) AND length(snapshot_json) <= 4000)),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    started_by TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_by TEXT,
    completed_at TEXT,
    updated_at TEXT NOT NULL,
    CHECK ((status = 'completed') = (completed_at IS NOT NULL AND completed_by IS NOT NULL))
);
CREATE UNIQUE INDEX task_project_reviews_draft ON task_project_reviews(project_id) WHERE status = 'draft';
CREATE INDEX task_project_reviews_project ON task_project_reviews(project_id, completed_at);

-- Next actions created from a review: ordinary tasks, remembered against the review that made them.
CREATE TABLE task_review_actions (
    review_id TEXT NOT NULL REFERENCES task_project_reviews(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL REFERENCES task_items(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (review_id, task_id)
);
CREATE INDEX task_review_actions_task ON task_review_actions(task_id);

-- --- Project ↔ Knowledge -------------------------------------------------------------------------

-- References from a project to Knowledge objects, like task_knowledge_links: ids only. What a person
-- sees of the object is decided by their own Knowledge membership every time it's read.
CREATE TABLE task_project_knowledge_links (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES task_projects(id) ON DELETE CASCADE,
    object_id TEXT NOT NULL REFERENCES knowledge_objects(id) ON DELETE CASCADE,
    added_by TEXT NOT NULL,
    added_at TEXT NOT NULL,
    UNIQUE (project_id, object_id)
);
CREATE INDEX task_project_knowledge_links_object ON task_project_knowledge_links(object_id);

-- --- Goals ---------------------------------------------------------------------------------------

-- Progress is either worked out from linked projects and tasks ('tasks'), or entered by hand
-- ('manual') against a target in a unit of the person's choosing ("$", "km", "chapters").
CREATE TABLE task_goals (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('personal', 'shared')),
    title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
    description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 4000),
    status TEXT NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started', 'in_progress', 'on_hold', 'achieved', 'abandoned')),
    progress_mode TEXT NOT NULL DEFAULT 'tasks' CHECK (progress_mode IN ('tasks', 'manual')),
    unit TEXT CHECK (unit IS NULL OR length(unit) BETWEEN 1 AND 20),
    start_value REAL NOT NULL DEFAULT 0,
    target_value REAL,
    current_value REAL NOT NULL DEFAULT 0,
    target_date TEXT CHECK (target_date IS NULL OR target_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    achieved_at TEXT,
    archived_at TEXT,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_by TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (progress_mode = 'tasks' OR (target_value IS NOT NULL AND target_value <> start_value)),
    CHECK ((status = 'achieved') = (achieved_at IS NOT NULL))
);

CREATE TABLE task_goal_members (
    goal_id TEXT NOT NULL REFERENCES task_goals(id) ON DELETE CASCADE,
    email TEXT NOT NULL COLLATE NOCASE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
    added_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (goal_id, email)
);
CREATE INDEX task_goal_members_email ON task_goal_members(email);

-- As for projects: a personal goal belongs to one person, whatever the Worker does.
CREATE TRIGGER task_goal_personal_single_member BEFORE INSERT ON task_goal_members
WHEN (SELECT kind FROM task_goals WHERE id = NEW.goal_id) = 'personal'
     AND EXISTS (SELECT 1 FROM task_goal_members WHERE goal_id = NEW.goal_id)
BEGIN
    SELECT RAISE(ABORT, 'personal goals have exactly one member');
END;
CREATE TRIGGER task_goal_personal_kind BEFORE UPDATE OF kind ON task_goals
WHEN NEW.kind = 'personal' AND (SELECT COUNT(*) FROM task_goal_members WHERE goal_id = NEW.id) > 1
BEGIN
    SELECT RAISE(ABORT, 'personal goals have exactly one member');
END;

-- What a goal is linked to: a project, a task or a Knowledge object (exactly one per row). Progress
-- and lists are worked out per reader from the links they can see; links to things they can't see
-- are left out entirely. A shared goal may only link shared projects and tasks in shared projects
-- (the triggers below back the Worker's check), so a personal project can never feed a shared goal.
CREATE TABLE task_goal_links (
    id TEXT PRIMARY KEY,
    goal_id TEXT NOT NULL REFERENCES task_goals(id) ON DELETE CASCADE,
    project_id TEXT REFERENCES task_projects(id) ON DELETE CASCADE,
    task_id TEXT REFERENCES task_items(id) ON DELETE CASCADE,
    object_id TEXT REFERENCES knowledge_objects(id) ON DELETE CASCADE,
    added_by TEXT NOT NULL,
    added_at TEXT NOT NULL,
    CHECK ((project_id IS NOT NULL) + (task_id IS NOT NULL) + (object_id IS NOT NULL) = 1)
);
CREATE UNIQUE INDEX task_goal_links_project ON task_goal_links(goal_id, project_id) WHERE project_id IS NOT NULL;
CREATE UNIQUE INDEX task_goal_links_task ON task_goal_links(goal_id, task_id) WHERE task_id IS NOT NULL;
CREATE UNIQUE INDEX task_goal_links_object ON task_goal_links(goal_id, object_id) WHERE object_id IS NOT NULL;
CREATE INDEX task_goal_links_by_project ON task_goal_links(project_id) WHERE project_id IS NOT NULL;
CREATE INDEX task_goal_links_by_task ON task_goal_links(task_id) WHERE task_id IS NOT NULL;
CREATE INDEX task_goal_links_by_object ON task_goal_links(object_id) WHERE object_id IS NOT NULL;

CREATE TRIGGER task_goal_links_shared_project BEFORE INSERT ON task_goal_links
WHEN NEW.project_id IS NOT NULL AND (SELECT kind FROM task_goals WHERE id = NEW.goal_id) = 'shared'
     AND (SELECT kind FROM task_projects WHERE id = NEW.project_id) <> 'shared'
BEGIN
    SELECT RAISE(ABORT, 'a shared goal can only link shared projects');
END;
CREATE TRIGGER task_goal_links_shared_task BEFORE INSERT ON task_goal_links
WHEN NEW.task_id IS NOT NULL AND (SELECT kind FROM task_goals WHERE id = NEW.goal_id) = 'shared'
     AND (SELECT p.kind FROM task_items t JOIN task_projects p ON p.id = t.project_id WHERE t.id = NEW.task_id) <> 'shared'
BEGIN
    SELECT RAISE(ABORT, 'a shared goal can only link tasks in shared projects');
END;

CREATE TABLE task_goal_milestones (
    id TEXT PRIMARY KEY,
    goal_id TEXT NOT NULL REFERENCES task_goals(id) ON DELETE CASCADE,
    title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
    target_date TEXT CHECK (target_date IS NULL OR target_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    done_at TEXT,
    done_by TEXT,
    position REAL NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    CHECK ((done_at IS NULL) = (done_by IS NULL))
);
CREATE INDEX task_goal_milestones_goal ON task_goal_milestones(goal_id, position);

-- The goal's history: each progress update (with the value it moved to), status change, milestone,
-- edit, membership and link change, with an optional short note written by the person. Append-only.
-- Membership and link entries never name the person, project, task or Knowledge object involved.
CREATE TABLE task_goal_progress (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    goal_id TEXT NOT NULL REFERENCES task_goals(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('created', 'value', 'status', 'milestone', 'update', 'member', 'link')),
    value REAL,
    status TEXT,
    note TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 500),
    at TEXT NOT NULL,
    by TEXT NOT NULL
);
CREATE INDEX task_goal_progress_goal ON task_goal_progress(goal_id, id);

-- --- Routines ------------------------------------------------------------------------------------

-- A routine is an ongoing responsibility built on one ordinary repeating task: its schedule is the
-- task's repeat rule, its checklist the task's subtasks, its history the task's completions, and who
-- is responsible the task's assignee. Only what a task can't hold lives here: whether it's paused,
-- and how responsibility rotates. One routine per task.
CREATE TABLE task_routines (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL UNIQUE REFERENCES task_items(id) ON DELETE CASCADE,
    -- 'none': whoever is assigned stays responsible. 'turns': each completed occurrence passes the
    -- task to the next participant in order; a skipped occurrence doesn't.
    rotation TEXT NOT NULL DEFAULT 'none' CHECK (rotation IN ('none', 'turns')),
    paused_at TEXT,
    paused_by TEXT,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK ((paused_at IS NULL) = (paused_by IS NULL))
);
CREATE INDEX task_routines_paused ON task_routines(task_id) WHERE paused_at IS NOT NULL;

-- The order people take turns in. Each must be able to be assigned the task (an editor or owner of
-- its shared project); leaving the project removes them here in the same batch.
CREATE TABLE task_routine_participants (
    routine_id TEXT NOT NULL REFERENCES task_routines(id) ON DELETE CASCADE,
    email TEXT NOT NULL COLLATE NOCASE,
    position INTEGER NOT NULL CHECK (position >= 0),
    PRIMARY KEY (routine_id, email)
);
CREATE INDEX task_routine_participants_email ON task_routine_participants(email);

-- --- Dashboard and reports -----------------------------------------------------------------------

-- Each person's dashboard choices (which tab opens, hidden cards, the household filter). Validated by
-- the Worker; private.
CREATE TABLE task_dashboard_preferences (
    email TEXT PRIMARY KEY COLLATE NOCASE,
    prefs_json TEXT NOT NULL CHECK (json_valid(prefs_json) AND length(prefs_json) <= 2000),
    updated_at TEXT NOT NULL
);
