-- Daly Knowledge and Daly Tasks: the destructive cleanup. NOT A MIGRATION, and not run by CI.
--
-- It lives outside migrations/ on purpose: merging to main applies migrations/ automatically, and
-- this deletes data for good. Run it only with the owner's written approval, only after every step in
-- docs/DECOMMISSION_KNOWLEDGE_TASKS.md#cleanup (a verified D1 backup, the R2 export of
-- private/attachments/, a release with no code reading these tables running for at least 30 days).
--
--   npx wrangler d1 execute DB --remote --env="" --file scripts/sql/decommission-knowledge-tasks-cleanup.sql
--
-- Retained applications never read any of these tables (test/decommission.test.ts and the unit
-- suites prove it). Columns in retained tables that once held a task or note id
-- (ic_rule_matches.task_id, ic_reports.knowledge_object_id, ic_report_schedules.save_to_knowledge)
-- stay as harmless nullable leftovers; mcp_writes and audit_log rows stay as history.
-- planner_preferences and today_preferences stay: Today uses them.

PRAGMA defer_foreign_keys = ON;

-- Links from retained applications to tasks and notes.
DROP TABLE IF EXISTS calendar_event_links;
DROP TABLE IF EXISTS asset_task_links;
DROP TABLE IF EXISTS asset_knowledge_links;

-- The Daily Planner's time blocks and estimates, and Today's morning and evening reviews.
DROP TABLE IF EXISTS task_time_blocks;
DROP TABLE IF EXISTS task_estimates;
DROP TABLE IF EXISTS daily_reviews;

-- Daly Intelligence's capture, suggestions, semantic index and files. Delete the R2 objects listed
-- in attachments.r2_key (private/attachments/) BEFORE this, or their keys are lost.
DROP TABLE IF EXISTS ai_transcript_parts;
DROP TABLE IF EXISTS ai_transcripts;
DROP TABLE IF EXISTS ai_suggestions;
DROP TABLE IF EXISTS ai_captures;
DROP TABLE IF EXISTS ai_semantic_index;
DROP TABLE IF EXISTS ai_exclusions;
DROP TABLE IF EXISTS attachments;
DELETE FROM ai_jobs WHERE kind <> 'briefing.prepare';

-- The DalyHub import.
DROP TABLE IF EXISTS dalyhub_import_items;
DROP TABLE IF EXISTS dalyhub_import_runs;

-- Daly Tasks, children first.
DROP TABLE IF EXISTS task_import_items;
DROP TABLE IF EXISTS task_import_batches;
DROP TABLE IF EXISTS task_templates;
DROP TABLE IF EXISTS task_recurrence_exceptions;
DROP TABLE IF EXISTS task_view_preferences;
DROP TABLE IF EXISTS task_dashboard_preferences;
DROP TABLE IF EXISTS task_routine_participants;
DROP TABLE IF EXISTS task_routines;
DROP TABLE IF EXISTS task_goal_progress;
DROP TABLE IF EXISTS task_goal_milestones;
DROP TABLE IF EXISTS task_goal_links;
DROP TABLE IF EXISTS task_goal_members;
DROP TABLE IF EXISTS task_goals;
DROP TABLE IF EXISTS task_review_actions;
DROP TABLE IF EXISTS task_project_reviews;
DROP TABLE IF EXISTS task_project_knowledge_links;
DROP TABLE IF EXISTS task_reminders;
DROP TABLE IF EXISTS task_saved_views;
DROP TABLE IF EXISTS task_knowledge_links;
DROP TABLE IF EXISTS task_activity;
DROP TABLE IF EXISTS task_comments;
DROP TABLE IF EXISTS task_completions;
DROP TABLE IF EXISTS task_item_labels;
DROP TABLE IF EXISTS task_labels;
DROP TABLE IF EXISTS task_items;
DROP TABLE IF EXISTS task_sections;
DROP TABLE IF EXISTS task_project_members;
DROP TABLE IF EXISTS task_projects;
DROP TABLE IF EXISTS task_preferences;

-- Daly Knowledge, children first. Dropping knowledge_fts removes its FTS5 shadow tables too.
DROP TABLE IF EXISTS knowledge_fts;
DROP TABLE IF EXISTS knowledge_templates;
DROP TABLE IF EXISTS knowledge_saved_views;
DROP TABLE IF EXISTS knowledge_favourites;
DROP TABLE IF EXISTS knowledge_pins;
DROP TABLE IF EXISTS knowledge_collection_items;
DROP TABLE IF EXISTS knowledge_collections;
DROP TABLE IF EXISTS knowledge_audit;
DROP TABLE IF EXISTS knowledge_object_tags;
DROP TABLE IF EXISTS knowledge_tags;
DROP TABLE IF EXISTS knowledge_relations;
DROP TABLE IF EXISTS knowledge_revisions;
DROP TABLE IF EXISTS knowledge_objects;
DROP TABLE IF EXISTS knowledge_object_types;
DROP TABLE IF EXISTS knowledge_memberships;
DROP TABLE IF EXISTS knowledge_spaces;

-- Switches that no longer exist.
DELETE FROM feature_flags WHERE key LIKE 'tasks.%' OR key LIKE 'knowledge.%';
