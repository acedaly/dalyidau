-- Drops the tables of applications retired earlier, approved by the owner (9 Nov 2026):
-- Daly Knowledge and Daly Tasks (docs/DECOMMISSION_KNOWLEDGE_TASKS.md) and what existed only to serve
-- them, Home & Assets and Household Finance (docs/DECOMMISSION_ASSETS_FINANCE.md). No code reads or
-- writes any of them (test/decommission.test.ts). Back up first: npm run db:backup -- --env production.
--
-- These 84 tables, nothing else: every asset_* (19), finance_* (9), knowledge_* (15, with the
-- knowledge_fts virtual table: dropping it removes its FTS5 shadow tables too) and task_* (31) table,
-- and dalyhub_import_items, dalyhub_import_runs, daily_reviews, ai_captures, ai_exclusions,
-- ai_semantic_index, ai_suggestions, ai_transcript_parts, ai_transcripts and calendar_event_links.
-- Their indexes and triggers go with them. No view refers to them, and the only triggers on other
-- tables that named them (task_time_blocks_*) are on task_* tables themselves.
--
-- Two approved tables are held back: asset_locations and knowledge_spaces. Kept tables still declare
-- foreign keys to them (assets.location_id, attachments.space_id), and D1 enforces foreign keys: with
-- either parent gone, every insert into the child fails ("no such table"), so a backup holding their
-- rows could no longer be restored, and PRAGMA foreign_key_check (npm run db:verify) refuses the whole
-- database. They go with assets and attachments in docs/pending/0033_drop_retired_portal_app_tables.sql.
--
-- NOT dropped either: the plain `tasks` table (Wedding Planner's tasks), `assets` and `attachments`
-- (not approved; listed in docs/pending/0033 for a later, separately approved cleanup), and every
-- table of the applications retired on 9 Nov 2026 (docs/DECOMMISSION_PORTAL_APPS.md).
--
-- Children before parents, so no foreign key is ever left pointing at a row that's gone.
PRAGMA defer_foreign_keys = ON;

-- Links from other applications to tasks and notes, and what Knowledge and Tasks alone used.
DROP TABLE IF EXISTS calendar_event_links;
DROP TABLE IF EXISTS asset_task_links;
DROP TABLE IF EXISTS asset_knowledge_links;
DROP TABLE IF EXISTS task_time_blocks;
DROP TABLE IF EXISTS task_estimates;
DROP TABLE IF EXISTS daily_reviews;
DROP TABLE IF EXISTS ai_transcript_parts;
DROP TABLE IF EXISTS ai_transcripts;
DROP TABLE IF EXISTS ai_suggestions;
DROP TABLE IF EXISTS ai_captures;
DROP TABLE IF EXISTS ai_semantic_index;
DROP TABLE IF EXISTS ai_exclusions;
DROP TABLE IF EXISTS dalyhub_import_items;
DROP TABLE IF EXISTS dalyhub_import_runs;

-- Daly Tasks.
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

-- Daly Knowledge (knowledge_spaces stays, see above).
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

-- Home & Assets (`assets` and asset_locations stay, see above).
DROP TABLE IF EXISTS asset_notifications;
DROP TABLE IF EXISTS asset_activity;
DROP TABLE IF EXISTS asset_files;
DROP TABLE IF EXISTS asset_claims;
DROP TABLE IF EXISTS asset_warranties;
DROP TABLE IF EXISTS asset_policy_links;
DROP TABLE IF EXISTS asset_policy_premiums;
DROP TABLE IF EXISTS asset_policies;
DROP TABLE IF EXISTS asset_maintenance;
DROP TABLE IF EXISTS asset_schedules;
DROP TABLE IF EXISTS asset_maintenance_templates;
DROP TABLE IF EXISTS asset_valuations;
DROP TABLE IF EXISTS asset_odometer;
DROP TABLE IF EXISTS asset_vehicles;
DROP TABLE IF EXISTS asset_shares;
DROP TABLE IF EXISTS asset_categories;
DROP TABLE IF EXISTS asset_preferences;

-- Household Finance.
DROP TABLE IF EXISTS finance_activity;
DROP TABLE IF EXISTS finance_reconciliations;
DROP TABLE IF EXISTS finance_transfer_dismissals;
DROP TABLE IF EXISTS finance_import_rows;
DROP TABLE IF EXISTS finance_transactions;
DROP TABLE IF EXISTS finance_transfers;
DROP TABLE IF EXISTS finance_imports;
DROP TABLE IF EXISTS finance_categories;
DROP TABLE IF EXISTS finance_accounts;
