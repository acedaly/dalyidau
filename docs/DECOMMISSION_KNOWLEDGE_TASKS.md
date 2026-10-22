# Decommissioning Daly Knowledge and Daly Tasks

Daly Knowledge (`/portal/knowledge`) and Daly Tasks (`/portal/tasks`) are retired, along with everything that existed only to serve them. This release turns off access and removes the code. **It does not delete any data.** The tables, the full-text index and the R2 files stay exactly as they were until the owner approves the separate cleanup described [below](#cleanup).

## What changed for people

| Before                                                                                               | Now                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Daly Knowledge: spaces, notes, objects, templates, collections, daily notes, search                  | Gone. `/portal/knowledge…` answers **410** with a message saying so.                                                                                                                                                                                                  |
| Daly Tasks: projects, tasks, routines, goals, labels, filters, reviews, reminders, Todoist import    | Gone. `/portal/tasks…` answers **410**. The 15-minute task-reminder cron job is removed.                                                                                                                                                                              |
| Daily Planner (`/portal/calendar/planner`): time blocks, estimates, suggested slots                  | Gone (**410**). Its planning hours (working hours, buffer, days off) moved to **Today → Customise Today → Planning hours and buffers**, in the same `planner_preferences` row, so nobody loses their settings.                                                        |
| Today: tasks, Plan My Day, morning planning, evening review, routines, Quick capture                 | Today is now calendar-only: briefing, capacity, timeline, commitments, notifications, Home & Assets and Intelligence Centre sections, and **Add appointment**. It needs `calendar.use` (it used to need `tasks.use` too).                                             |
| Daly Intelligence: capture, inbox, suggestions, meetings, documents, semantic search                 | Reduced to the platform (switches, budget, models, usage) and the **daily briefing and weekly review**, which now draw on Calendar. Capture, inbox and meetings answer **410**. Every capture and suggestion kind targeted Tasks or Knowledge, so none could be kept. |
| Calendar: link an event to a task or note; task overlay; feeds with tasks                            | Links, task overlay and the feeds' task option are gone. Events, subscriptions, leave balances, the leave planner, holidays, family view and feeds are unchanged.                                                                                                     |
| Home & Assets: "Create task" from a due date; link to a Knowledge note; auto-tasks                   | Gone. Maintenance records, schedules, reminders (in-app and email), Today's Home & Assets section, insurance, warranties and files are unchanged. Today's section no longer says whether a task exists.                                                               |
| Intelligence Centre: make a task from a record or rule match; save a briefing or report to Knowledge | Gone. Records, alerts, rules, reports (scheduled too), wallboards and event links are unchanged. Scheduled reports that had "save to Knowledge" on still run; the setting is ignored.                                                                                 |
| DalyHub migration (`/api/portal/migrations/dalyhub`)                                                 | Gone (**410**). The `DALYHUB_MIGRATION` secret is no longer read.                                                                                                                                                                                                     |
| Wedding Planner tasks (`/portal/wedding/tasks`)                                                      | **Unaffected.** A different feature with its own `tasks` table.                                                                                                                                                                                                       |

Capabilities that couldn't be kept, because they had no meaning without Tasks or Knowledge: the task list and completion on Today, Plan My Day and the routines, time blocking, AI capture and suggestions, semantic search, meeting transcription, and the "create task" or "save to Knowledge" actions in Calendar, Home & Assets and the Intelligence Centre.

## How a retired address answers

`worker/portal/retired.ts` lists every retired page and API path. Each request passes the usual Cloudflare Access and role checks first, so someone who isn't signed in learns nothing new. A signed-in person then gets:

- **API:** `410 {"error":"retired","message":"Daly Knowledge and Daly Tasks have been retired…"}`, with `Cache-Control: no-store`.
- **Page:** the portal's "forbidden" page with the same message and status 410.

Nothing behind a retired path reads or writes a retired table. The code that could has been deleted.

## MCP

The gateway (`mcp/`, version **3.0.0**) advertises **66 tools (14 writes)**: chief of staff (2), Daly Intelligence briefings (2), Calendar and leave (17), Today (3, read-only), the Intelligence Centre (28) and Home & Assets (14).

The **51 retired tools** are listed in `worker/mcp/retired.ts` and `mcp/src/portal-tools.ts` (`RETIRED_TOOL_NAMES`). `test/mcp-contract.test.ts` checks that the two lists match and that no retired tool is advertised. They cover every `knowledge_*`, `tasks_*` and `planner_*` tool, plus `intelligence_list_suggestions`, `intelligence_get_processing_status`, `intelligence_capture_text`, `intelligence_request_analysis`, `intelligence_approve_suggestion`, `meetings_get_transcript`, `today_list_unscheduled`, `today_propose_plan`, `today_get_conflicts`, `assets_link_knowledge` and `assets_create_task`.

A call to a retired tool gets a clear answer at both layers:

- **Gateway 3.0.0:** answers `tools/call` for a retired name itself, after authentication and the rate limit, with an `isError` result whose `code` is `"retired"`. The call never reaches the portal.
- **Portal entrypoint:** refuses it with `"retired"` after verifying the Access token, before anything is read. An older gateway (2.x) that still advertises the tools therefore can't reach a retired record either.

## Data inventory

Every table below is kept, unchanged, in this release. The migrations that created them stay in `migrations/`.

| Area                | Tables (migration)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Also                                                                                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Knowledge           | `knowledge_spaces`, `knowledge_memberships`, `knowledge_object_types`, `knowledge_objects`, `knowledge_revisions`, `knowledge_relations`, `knowledge_tags`, `knowledge_object_tags`, `knowledge_audit` (0013); `knowledge_collections`, `knowledge_collection_items`, `knowledge_pins`, `knowledge_favourites`, `knowledge_saved_views`, `knowledge_templates` (0014)                                                                                                                                                                                                                                                                                      | FTS5 `knowledge_fts` and its shadow tables; trigger `knowledge_audit_immutable`                                                                      |
| Tasks               | `task_preferences`, `task_projects`, `task_project_members`, `task_sections`, `task_items`, `task_labels`, `task_item_labels`, `task_completions`, `task_comments`, `task_activity`, `task_knowledge_links`, `task_saved_views`, `task_reminders` (0015); `task_view_preferences`, `task_recurrence_exceptions`, `task_templates`, `task_import_batches`, `task_import_items` (0016); `task_project_reviews`, `task_review_actions`, `task_project_knowledge_links`, `task_goals`, `task_goal_members`, `task_goal_links`, `task_goal_milestones`, `task_goal_progress`, `task_routines`, `task_routine_participants`, `task_dashboard_preferences` (0017) | Triggers `task_personal_single_member`, `task_personal_kind`, `task_inbox_kind` (0015) and `task_goal_*` (0017); index `task_projects_client` (0020) |
| DalyHub import      | `dalyhub_import_runs`, `dalyhub_import_items` (0019)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |                                                                                                                                                      |
| Intelligence        | `ai_exclusions`, `ai_semantic_index`, `ai_captures`, `ai_transcripts`, `ai_transcript_parts`, `ai_suggestions`, `attachments` (0021)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Jobs of kinds other than `briefing.prepare` in `ai_jobs` are never claimed again                                                                     |
| Calendar            | `calendar_event_links` (0022)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Foreign keys to `task_items`, `task_projects`, `knowledge_objects` with `ON DELETE CASCADE`                                                          |
| Daily Planner       | `task_estimates`, `task_time_blocks` (0023)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Triggers `task_time_blocks_*`                                                                                                                        |
| Today               | `daily_reviews` (0024)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |                                                                                                                                                      |
| Home & Assets       | `asset_knowledge_links`, `asset_task_links` (0026)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |                                                                                                                                                      |
| Intelligence Centre | Columns only: `ic_rule_matches.task_id`, `ic_reports.knowledge_object_id`, `ic_report_schedules.save_to_knowledge` (0027)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Left as nullable leftovers, even after the cleanup                                                                                                   |

**Still in use by retained applications, never part of the cleanup:** `planner_preferences` (Today's planning hours), `today_preferences`, `ai_config`, `ai_preferences`, `ai_usage`, `ai_alerts`, `ai_jobs`, `ai_briefings`, `mcp_writes` (history, including retired entity types), `audit_log`, `feature_flags`, and the Wedding Planner's `tasks`.

**Relationships to retained data.**

- Retained tables hold no foreign keys to retired ones. The only other references to `knowledge_spaces` are from `ai_captures` and `attachments`, which are retired too.
- The links tables (`calendar_event_links`, `asset_task_links`, `asset_knowledge_links`) point from retained records into retired ones. Deleting an event or an asset still removes its own link rows, as before. Nothing else touches them.
- Retention, cron and Intelligence's runner never delete captures, attachments or any other retired row.

**R2.**

- `private/attachments/<id>/…` holds the files of Knowledge attachments and Intelligence uploads. Rows in `attachments` record each key.
- Nothing serves or deletes these files any more. Home & Assets' own files (`private/assets/…`) are unaffected.

**Vectorize.** The `VECTORS` bindings (`daly-knowledge`, `daly-knowledge-staging`) are removed from `wrangler.jsonc`. The indexes themselves are untouched; the owner can delete them in the dashboard when they choose. The `AI` binding stays for the briefings.

## Export and verified backup

Before deploying, and again before any cleanup:

1. `npm run db:backup -- --env production`. It exports every ordinary table, rebuilds `knowledge_fts` from `scripts/lib/virtual-tables.mjs` (D1 can't export virtual tables), restores the result into a throwaway local database, re-runs `npm run db:verify`'s integrity checks (which still cover the Knowledge and Tasks tables) and compares row counts.
2. `BACKUP_PASSPHRASE=… npm run backup:r2 -- --env production --encrypt`, then `--verify`. This saves every kept attachment by id, with SHA-256 checks.
3. `npm run test:backup` proves the round trip locally with invented Knowledge and Tasks rows.
4. Keep both backups somewhere private (they hold real notes and tasks). Never commit them: the repo is public.

## Deployment order

1. **Back up** as above.
2. **Merge and deploy the portal Worker** (CI applies `migrations/`; this release adds none). Retired pages and APIs answer 410, and retired MCP tools are refused at the portal. Gateway 2.x keeps working for every remaining tool.
3. **Deploy the gateway 3.0.0 by hand:** `npx wrangler deploy --config mcp/wrangler.jsonc --env production`. It stops advertising the retired tools and answers them itself. Reconnect or refresh ChatGPT and Claude connectors so they pick up the shorter list.
4. Optionally, delete the `DALYHUB_MIGRATION` secret and the two Vectorize indexes once the release has settled.

The order matters only one way: a 3.0.0 gateway in front of an old portal would still work, but would describe tools the old portal also has. Portal first keeps both layers consistent.

## Rollback

- **Code:** redeploy the previous portal Worker (and gateway 2.x if it was updated). Every retired table and file is still there, untouched, so Knowledge, Tasks and the planner come back exactly as they were.
- **Stored settings stay readable both ways.** This release reads old Today, Intelligence and Calendar preferences by dropping retired keys, and never rewrites them on its own. A person who saves settings after the deploy loses only the retired keys (for example Today's hidden Tasks section). The previous release fills those back in with its defaults.
- **Vectorize:** to roll back, put the `vectorize` blocks back in `wrangler.jsonc`. The indexes still exist.

## Cleanup

`scripts/sql/decommission-knowledge-tasks-cleanup.sql` drops every retired table listed above. It also deletes the unclaimed retired `ai_jobs` and any `tasks.*` or `knowledge.*` rows in `feature_flags`.

It is **not a migration** and nothing runs it automatically. `test/decommission.test.ts` runs it against a test database to prove the retained applications keep working afterwards.

Run it only:

1. with the owner's written approval;
2. at least 30 days after this release, with no rollback needed in that time;
3. after a fresh, verified D1 backup and R2 export (above), stored privately;
4. after deleting the R2 objects under `private/attachments/` whose keys are in `attachments.r2_key` (the SQL removes that table, and with it the keys);

```sh
npx wrangler d1 execute DB --remote --env="" --file scripts/sql/decommission-knowledge-tasks-cleanup.sql
```

After it:

- Remove `knowledge_fts` from `scripts/lib/virtual-tables.mjs`.
- Remove the Knowledge and Tasks checks from `scripts/lib/ops.mjs` and the retired rows from `scripts/test-backup.mjs`.
- A rollback to a release before this one is no longer possible without restoring the backup.
