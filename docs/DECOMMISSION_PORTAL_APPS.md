# Retiring the portal's other applications

Retired 9 Nov 2026: **Daly Calendar** (with the Leave Planner), **Today**, **Daly Intelligence**, the **Intelligence Centre** (with its wallboards), **Amplenote** (blog publishing and the AI-assistant connection), the portal's **application launcher**, and the **staging environment**. This follows the earlier retirements of [Daly Knowledge and Daly Tasks](DECOMMISSION_KNOWLEDGE_TASKS.md) and [Home & Assets and Household Finance](DECOMMISSION_ASSETS_FINANCE.md).

What's left: the blog (Capacities, its sync and every article already published, whichever publisher wrote it), the public wedding website, RSVP and guest pages, the Wedding Planner (the portal's wedding admin and the phone app) and Portal settings. They work exactly as before.

This release removes the code. **The retired applications' data stays** until the owner approves [docs/pending/0033_drop_retired_portal_app_tables.sql](pending/0033_drop_retired_portal_app_tables.sql). The same release adds migration `0032`, approved by the owner, which drops most of the tables of the _earlier_ retirements ([below](#database)).

## What changed for people

| Before                                                                                                                                                           | Now                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/portal`: the application launcher                                                                                                                              | Redirects (302, after sign-in) to `/portal/wedding`, Wedding Planner's dashboard. The sidebar shows Wedding Planner's navigation on every page, Portal settings and the audit log included; the logo and breadcrumbs lead to Wedding Planner.                               |
| Daly Calendar and the Leave Planner (`/portal/calendar…`, `/api/portal/calendar…`)                                                                               | **410**, "Daly Calendar and the Leave Planner have been retired…".                                                                                                                                                                                                          |
| Private calendar subscription addresses (`/calendar/feed/<token>.ics`)                                                                                           | **410** to anyone (they never needed sign-in), saying only that the address is retired.                                                                                                                                                                                     |
| Calendar reminders, leave and school-holiday notices, subscription refreshes (cron)                                                                              | Removed. Nothing is fetched or sent.                                                                                                                                                                                                                                        |
| Today (`/portal/today`, `/api/portal/today…`)                                                                                                                    | **410**, "Today has been retired…".                                                                                                                                                                                                                                         |
| Daly Intelligence (`/portal/intelligence…`, `/api/portal/intelligence…`), its briefings and its cron                                                             | **410**, "Daly Intelligence has been retired…". The `AI` binding and `AI_GATEWAY_ID` are gone from `wrangler.jsonc`: nothing can call Workers AI.                                                                                                                           |
| Intelligence Centre (`/portal/intelligence-centre…`, `/api/portal/centre…`) and its collection cron                                                              | **410**, "The Intelligence Centre has been retired, along with its wallboards…". No public feed is fetched.                                                                                                                                                                 |
| Wallboard screens (`/display`, `/api/display/…`, map tiles)                                                                                                      | **410** to anyone. Display credentials no longer open anything.                                                                                                                                                                                                             |
| Amplenote publishing: the plugin's reports (`/api/amplenote/ingest`), Amplenote's sign-in redirect (`/api/integrations/amplenote/callback`), the 15-minute check | **410** to anyone; the check is removed. Articles Amplenote published (`posts.source = 'amplenote'`) stay online exactly as stored, with their old addresses' redirects.                                                                                                    |
| Portal settings → Website & Blog: Amplenote plugin, connection, articles and replacements                                                                        | Shows the Capacities articles and their archive only (`/api/portal/website/amplenote…` answers **410**).                                                                                                                                                                    |
| Portal settings → Calendar & Subscriptions, Intelligence; Features → Portal, Calendar, Intelligence Centre, the Amplenote switch                                 | Gone. `/portal/settings/calendar` and `/portal/settings/intelligence` redirect to Portal settings. Stored switch rows stay in `feature_flags` and are ignored.                                                                                                              |
| Permissions `calendar.use`, `intelligence.use`, `centre.use`                                                                                                     | Gone. Permissions are worked out from roles, which are unchanged.                                                                                                                                                                                                           |
| The staging environment (`env.staging`, `npm run deploy:staging`, `seed:staging`, the deploy workflow's staging option, `check-config --env staging`)            | Removed. Production is the only environment. Its D1 database, R2 bucket and Vectorize indexes were already deleted in Cloudflare.                                                                                                                                           |
| `dalyidau.<account>.workers.dev`                                                                                                                                 | Off (`workers_dev: false`). The Worker answers only on its custom domains: `daly.id.au`, `www`, `wedding` and `weddingplanner`. Nothing used the workers.dev address (CI, tests and scripts use `localhost` or the custom domains; the MCP gateway uses a service binding). |

Every retired address passes the usual Cloudflare Access and role checks first (except the five public ones above, which never had them), so someone who isn't signed in learns nothing new. `worker/portal/retired.ts` is the single table of every retired page and API, for all three retirements, each with its own message.

**Deliberately kept, because the wedding uses it:**

- The wedding's **Save the Date calendar file** (`/save-the-date/calendar`, `/save-the-date.ics`) and the RSVP confirmation's "Add to calendar" (`src/shared/portal/calendar.ts`). They're the Wedding Planner's, not Daly Calendar's.
- Wedding Planner's **dashboard** (`/portal/wedding`, `src/portal/dashboard`, `dashboard_layouts`, `GET`/`PUT /api/portal/dashboard`). It's the wedding admin's home (countdown, RSVPs, budget…), and the phone app reads its numbers. Only the launcher in front of it was retired.
- The **Capacities archive** (`capacities_archive`, Portal settings → Website & Blog). The Capacities sync still skips any article whose address an Amplenote note took over, so it can't collide with the Amplenote article now at that address.
- `/api/health` still ignores old `amplenote:` runs in `sync_runs` when it reports the last sync.
- The Worker's 15-minute cron: the Capacities sync (only while its switch is on) and scheduled wedding messages.

Removed code: `worker/{calendar,today,intelligence,centre,amplenote}`, `src/portal/{calendar,today,intelligence,centre}`, `src/shared/{calendar,today,intelligence,centre}`, `src/display`, `src/entry-display.tsx`, `shell-display.html`, `amplenote/` (the plugin), `public/centre/`, the launcher page, the MCP tools (`worker/mcp/{calendar,today,chief,intelligence,centre,centre-history,amplenote}.ts`) and the MCP write ledger (`worker/mcp/ledger.ts`), their tests, e2e specs and fixtures, `scripts/{mock-feeds,mock-amplenote,amplenote-live-check,amplenote-write-check,centre-basemap,seed-staging}.mjs`, the dependencies `maplibre-gl`, `pmtiles`, `@protomaps/basemaps` and `ical.js`, and the docs (`AMPLENOTE`, `CALENDAR`, `DAILY_PLANNER`, `INTELLIGENCE`, `INTELLIGENCE_CENTRE`, `INTELLIGENCE_CENTRE_9_1`, `INTELLIGENCE_SOURCES`, `STAGING`, and the already-retired `HOME_ASSETS` and `HOUSEHOLD_FINANCE`; they're in Git history).

## MCP

The portal now serves **no MCP tools**. Every one it served (56: Calendar and leave 17, Today and the Chief of Staff context 5, Intelligence briefings 2, Intelligence Centre 28, Amplenote 4) joins the retired list: `worker/mcp/retired.ts` (`RETIRED_MCP_GROUPS`) and `mcp/src/portal-tools.ts` (`RETIRED_TOOL_GROUPS`), **121 tools** in all, compared by `test/mcp-contract.test.ts`. A call to one gets `code: "retired"` with the message of its retirement, at the portal (after verifying the Access token) and, from gateway **4.0.0**, at the gateway itself without reaching the portal.

The gateway therefore no longer needs its `PORTAL` service binding: nothing it serves calls the portal. The binding is kept (it's harmless, and any portal tool added later would use it), and the gateway works without it (`test/mcp-gateway/isolation.test.ts`). For local development the binding now points at `dalyidau` (run the portal with `wrangler dev`), as the `dalyidau-staging` Worker no longer exists.

With no portal tools, gateway 4.0.0 built from this branch advertises **no tools** (its `tools/list` answers "method not found"). The Personal Tasks and Knowledge tools on Cloudflare OS (`personal_tasks_*`, `personal_knowledge_*`) are not on `main`: they're on branch `mcp-cloudflare-os-r003399`, from which the live gateway was deployed. **Deploy the gateway only from a merge of that branch with this change**, or the live Cloudflare OS tools disappear. Expect conflicts in `mcp/src/index.ts` (server info and instructions), `mcp/wrangler.jsonc` and `test/mcp-gateway/{isolation,protocol}.test.ts`.

## Database

### Migration 0032 (in this release): the earlier retirements' tables

Approved by the owner. Drops **84 tables**, which no code has read or written since their applications were retired: every `task_*` (31), `finance_*` (9), `knowledge_*` but `knowledge_spaces` (15, including the `knowledge_fts` virtual table, whose FTS5 shadow tables go with it) and `asset_*` but `asset_locations` (19) table, and `dalyhub_import_items`, `dalyhub_import_runs`, `daily_reviews`, `ai_captures`, `ai_exclusions`, `ai_semantic_index`, `ai_suggestions`, `ai_transcript_parts`, `ai_transcripts` and `calendar_event_links`. Their indexes and triggers go with them; no view or other table's trigger refers to them.

Not dropped:

- The Wedding Planner's `tasks` table.
- `assets` and `attachments` (not in the approved list).
- **`asset_locations` and `knowledge_spaces`**, although approved: `assets.location_id` and `attachments.space_id` still declare foreign keys to them, and D1 enforces foreign keys. With either parent gone, every insert into the child fails with "no such table" (so a backup holding those rows could no longer be restored), and `PRAGMA foreign_key_check` (the first check of `npm run db:verify`, which CI runs after migrating) refuses the whole database. `npm run test:backup` caught this. They're in the pending cleanup, after `assets` and `attachments`.

`npm run test:backup` applies 0032 to a database holding rows in every table: exactly those 84 tables go, every other row stays, foreign keys stay sound, and a backup of the result restores.

### Pending: docs/pending/0033 (owner approval needed)

[docs/pending/0033_drop_retired_portal_app_tables.sql](pending/0033_drop_retired_portal_app_tables.sql) is **not a migration**; nothing runs it. It drops the 55 tables that are unused after this release: Calendar and leave (17), `today_preferences`, `planner_preferences`, Intelligence (`ai_config`, `ai_preferences`, `ai_usage`, `ai_alerts`, `ai_jobs`, `ai_briefings`) and `attachments`, the Intelligence Centre's 22 `ic_*` tables, `amplenote_articles`, `amplenote_connection`, `amplenote_oauth_states`, `mcp_writes`, `assets`, `asset_locations` and `knowledge_spaces`. `test/decommission.test.ts` runs it and then exercises the wedding site, RSVP, Wedding Planner, Portal settings and the blog.

Kept because retained code uses them: `dashboard_layouts`, `capacities_archive`, `entity_cache`, and every wedding and blog table.

To approve it: back up (`npm run db:backup -- --env production`, and `npm run backup:r2 -- --env production --encrypt` for the attachment files and situation reports), then copy it to `migrations/0033_….sql` and update `scripts/lib/ops.mjs` (`TABLES`, `INTEGRITY_CHECKS`) in the same change. Afterwards, delete the R2 objects it names (`private/attachments/`, `private/centre/`, `private/assets/`) in the dashboard.

## Configuration

`wrangler.jsonc`: removed `env.staging`, the `ai` binding and the `AI_GATEWAY_ID` var; `workers_dev` is now `false`. Routes and custom domains are unchanged.

**Secrets nothing reads any more**, to delete after this release is deployed (`npx wrangler secret delete <NAME>`), if they're set:

- `AMPLENOTE_PUBLISH_TOKEN`, `AMPLENOTE_CLIENT_ID`, `AMPLENOTE_CLIENT_SECRET`, `AMPLENOTE_TOKEN_KEY` (and the optional var `AMPLENOTE_TAG`)
- `CALENDAR_ENCRYPTION_KEY`
- `TFNSW_API_KEY`, `NASA_FIRMS_MAP_KEY`

Development-only settings that are gone too: `AI_PROVIDER`, `CENTRE_FEED_BASE`, `AMPLENOTE_TEST_BASE`. `MCP_ACCESS_AUD` is still read (the portal's MCP entrypoint verifies callers before refusing them). Also deletable: the `dalyidau-staging` Worker if it still exists, the GitHub environment `staging`, the AI Gateway `daly-intelligence`, and the Amplenote API application registered for the blog.

## Deployment order

1. **Back up**: `npm run db:backup -- --env production` (0032 drops tables).
2. **Merge and deploy the portal Worker** (CI applies `0032` and runs `db:verify`). Retired addresses answer 410; the gateway that's live keeps working: its Cloudflare OS tools are unaffected, and its retired portal tools are refused by the portal.
3. **Gateway, when convenient**: merge this change with `mcp-cloudflare-os-r003399`, then deploy by hand (`npm run mcp:deploy:dry-run`, then `npx wrangler deploy --config mcp/wrangler.jsonc --env production`). Reconnect or refresh Claude and ChatGPT so they drop the retired tools.
4. **Delete the secrets** listed above.
5. **Later, with approval**: [docs/pending/0033](pending/0033_drop_retired_portal_app_tables.sql).

## Rollback

- **Code:** redeploy the previous Worker version. Calendar, Today, Intelligence, the Centre and Amplenote come back with their data (it's untouched until 0033), except that their crons resume and `workers_dev` is whatever that version declares. The secrets must still be set for Amplenote and the Centre's keyed sources.
- **Migration 0032 can't be undone by redeploying.** The dropped tables (all retired, and empty or unused in production) come back only from the backup in step 1 or D1 Time Travel (`npx wrangler d1 time-travel restore DB --timestamp <before the deploy>`, which also undoes everything else written since).
- **Staging** can't be rolled back: its resources are gone.
