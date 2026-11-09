-- PENDING: NOT A MIGRATION. Waiting for the owner's approval; nothing runs it.
--
-- Drops the tables of the applications retired on 9 Nov 2026 (docs/DECOMMISSION_PORTAL_APPS.md):
-- Daly Calendar and the Leave Planner, Today (and the Daily Planner's planning hours), Daly
-- Intelligence, the Intelligence Centre, Amplenote publishing and its AI-assistant connection, and the
-- MCP write ledger (the portal serves no MCP tools any more). Also what migration 0032 left behind:
-- Home & Assets' `assets` and Daly Intelligence's `attachments` (Knowledge attachments), which weren't
-- in the approved list, and the approved asset_locations and knowledge_spaces, which they still name
-- in foreign keys (so they can only go after them).
--
-- Every table below was confirmed unused by the code in this release: no Worker or browser code reads
-- or writes it (test/decommission.test.ts runs this file and then exercises the wedding site, RSVP,
-- Wedding Planner, the portal and the blog). Its rows are still in production until this runs.
--
-- To approve it: back up first (npm run db:backup -- --env production, and
-- npm run backup:r2 -- --env production --encrypt for the files below), keep the backup, then copy this
-- file to migrations/0033_drop_retired_portal_app_tables.sql (the next free number) so CI applies it,
-- and update scripts/lib/ops.mjs (TABLES, INTEGRITY_CHECKS) and docs/DATABASE.md in the same change.
--
-- R2 objects these tables point at are NOT deleted by this, and become unindexed once it runs:
--   private/attachments/…   (attachments.r2_key)       Knowledge attachments
--   private/centre/reports/… (ic_reports.object_key)   situation reports
--   private/centre/snapshots/…, private/centre/basemap/ the Centre's feed snapshots and map tiles
--   private/assets/…        (asset_files was dropped by 0032; empty in production)
-- Delete them in the dashboard (or with wrangler r2 object delete) after the R2 backup.
--
-- Deliberately NOT here, because retained code still uses them: `dashboard_layouts` (Wedding
-- Planner's dashboard widgets), `capacities_archive` and `entity_cache` (the blog's Capacities sync and
-- its archive), and the wedding's `tasks`, `events` and every other wedding table. Stored switch rows
-- in `feature_flags` for retired switches (calendar.*, intelligence_centre.*, portal.other_applications,
-- website.amplenote.assistant, assets.*, tasks.*, knowledge.*) are ignored when read; deleting them is
-- optional: DELETE FROM feature_flags WHERE key NOT IN (<the keys in src/shared/portal/flags.ts>).
--
-- Children before parents.
PRAGMA defer_foreign_keys = ON;

-- Daly Calendar and the Leave Planner (0022).
DROP TABLE IF EXISTS calendar_activity;
DROP TABLE IF EXISTS calendar_notifications;
DROP TABLE IF EXISTS calendar_reminders;
DROP TABLE IF EXISTS calendar_event_overrides;
DROP TABLE IF EXISTS calendar_events;
DROP TABLE IF EXISTS calendar_feeds;
DROP TABLE IF EXISTS calendar_subscriptions;
DROP TABLE IF EXISTS calendar_members;
DROP TABLE IF EXISTS calendars;
DROP TABLE IF EXISTS calendar_custom_dates;
DROP TABLE IF EXISTS calendar_preferences;
DROP TABLE IF EXISTS leave_shares;
DROP TABLE IF EXISTS leave_bookings;
DROP TABLE IF EXISTS leave_adjustments;
DROP TABLE IF EXISTS leave_scenarios;
DROP TABLE IF EXISTS leave_types;
DROP TABLE IF EXISTS leave_profiles;

-- Today and the Daily Planner's planning hours (0023, 0024).
DROP TABLE IF EXISTS today_preferences;
DROP TABLE IF EXISTS planner_preferences;

-- Daly Intelligence (0021), with the Knowledge attachments index.
DROP TABLE IF EXISTS ai_jobs;
DROP TABLE IF EXISTS ai_briefings;
DROP TABLE IF EXISTS ai_alerts;
DROP TABLE IF EXISTS ai_usage;
DROP TABLE IF EXISTS ai_preferences;
DROP TABLE IF EXISTS ai_config;
DROP TABLE IF EXISTS attachments;

-- Intelligence Centre (0025, 0027).
DROP TABLE IF EXISTS ic_event_links;
DROP TABLE IF EXISTS ic_wallboard_views;
DROP TABLE IF EXISTS ic_report_schedules;
DROP TABLE IF EXISTS ic_reports;
DROP TABLE IF EXISTS ic_rule_matches;
DROP TABLE IF EXISTS ic_rules;
DROP TABLE IF EXISTS ic_display_tokens;
DROP TABLE IF EXISTS ic_wallboards;
DROP TABLE IF EXISTS ic_alerts;
DROP TABLE IF EXISTS ic_watch_areas;
DROP TABLE IF EXISTS ic_briefings;
DROP TABLE IF EXISTS ic_preferences;
DROP TABLE IF EXISTS ic_config;
DROP TABLE IF EXISTS ic_cache;
DROP TABLE IF EXISTS ic_source_daily;
DROP TABLE IF EXISTS ic_geometries;
DROP TABLE IF EXISTS ic_record_versions;
DROP TABLE IF EXISTS ic_series;
DROP TABLE IF EXISTS ic_changes;
DROP TABLE IF EXISTS ic_records;
DROP TABLE IF EXISTS ic_fetch_runs;
DROP TABLE IF EXISTS ic_sources;

-- Amplenote publishing and its connection (0028, 0030). Posts it published stay in `posts`.
DROP TABLE IF EXISTS amplenote_oauth_states;
DROP TABLE IF EXISTS amplenote_connection;
DROP TABLE IF EXISTS amplenote_articles;

-- The MCP write ledger (0018 and its rebuilds).
DROP TABLE IF EXISTS mcp_writes;

-- Home & Assets' main table and its places, and the Knowledge spaces attachments named (their other
-- tables went in 0032).
DROP TABLE IF EXISTS assets;
DROP TABLE IF EXISTS asset_locations;
DROP TABLE IF EXISTS knowledge_spaces;
