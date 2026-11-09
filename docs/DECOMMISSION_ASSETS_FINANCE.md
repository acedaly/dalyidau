# Decommissioning Home & Assets and Household Finance

Retired 1 Nov 2026. Home & Assets (`/portal/assets`) and Household Finance (`/portal/finance`) duplicated the owner's Cloudflare OS apps, **Home** and **Finances**, which replace them. Both had no rows in production. This release turns off access and removes the code, following the earlier [retirement of Daly Knowledge and Daly Tasks](DECOMMISSION_KNOWLEDGE_TASKS.md). **It does not delete any data.** Every table, and every file under `private/assets/` in R2, stays exactly as it was, and no migration drops anything.

> **Cleanup, 9 Nov 2026:** with the owner's approval, migration `0032` dropped this retirement's tables, except `assets`, `asset_locations`, `attachments` and `knowledge_spaces`, which wait for [docs/pending/0033](pending/0033_drop_retired_portal_app_tables.sql) (kept tables still name the last two in foreign keys). `scripts/sql/decommission-knowledge-tasks-cleanup.sql` is gone. The MCP tool counts and the Today, Calendar and Intelligence details below were superseded the same day, when those applications were retired too ([DECOMMISSION_PORTAL_APPS.md](DECOMMISSION_PORTAL_APPS.md)). What follows is the record of the retirement as it was done.

## What changed for people

| Before                                                                                                                                             | Now                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Home & Assets: assets, vehicles and trailers, places and rentals, maintenance, insurance, warranties, documents, capture, QR labels, reports       | Gone. `/portal/assets…` and `/api/portal/assets…` answer **410**, saying Home in Cloudflare OS replaces it. QR labels printed earlier point at `/portal/assets/item/…`, which now gives the same answer. |
| Household Finance: accounts, NAB CSV imports with review, ledger, categories, transfers, overview                                                  | Gone. `/portal/finance…` and `/api/portal/finance…` answer **410**, saying Finances in Cloudflare OS replaces it.                                                                                        |
| Home & Assets reminders: in-app notifications, reminder emails (`assets.reminders.email`) and the purge of deleted assets' files, every 15 minutes | The cron job is removed. No reminder is sent and **no file is purged** (deleted assets' files stay in R2 until the cleanup).                                                                             |
| Today: a Home & Assets section (what's overdue or due soon)                                                                                        | Gone. Today's other sections (briefing, capacity, timeline, commitments, notifications, Intelligence Centre) are unchanged.                                                                              |
| Calendar: Home & Assets dates as a reminder overlay, and its "Home & Assets reminders" setting                                                     | Gone. Holidays, school terms, leave and non-working days are unchanged. A stored `overlays.assets` choice is ignored (dropped when read, never an error).                                                |
| Launcher, sidebar, Portal settings → Features → Home & Assets (`assets.ai`, `assets.reminders.email`)                                              | Gone. Stored switch rows in `feature_flags` stay and are ignored.                                                                                                                                        |
| Permissions `assets.use` and `finance.use`                                                                                                         | Gone. Permissions aren't stored: they're worked out from each person's role (`portal_users.role`), and the roles are unchanged, so nobody's stored role needs changing.                                  |
| MCP: 14 `assets_*` tools, and Home & Assets in `chief_of_staff_daily_context`                                                                      | Refused with `"retired"` (below). The Chief of Staff context is Calendar only and lists Home & Assets and Household Finance under `notChecked`.                                                          |
| Wedding Planner budget (`/portal/wedding/budget`, `budget_items`) and Wedding Planner tasks                                                        | **Unaffected.** Different features with their own tables.                                                                                                                                                |

Capabilities that couldn't be kept, because they had no meaning without the applications: Today's Home & Assets section, the calendar overlay of asset dates, asset reminder emails, and the Home & Assets facts in the Chief of Staff briefing.

**Left in place (Daly Intelligence, not touched by this release).** Intelligence still has its "Document intelligence" switch, its "Extraction" model and the stand-in for receipt and photo capture in `worker/intelligence/bindings.ts`. Only Home & Assets used them; nothing calls them now. Removing them is a separate change to Daly Intelligence.

## How a retired address answers

`worker/portal/retired.ts` lists every retired page and API path, grouped by retirement, each with its own message. Each request passes the usual Cloudflare Access and role checks first, so someone who isn't signed in learns nothing new. A signed-in person then gets:

- **API:** `410 {"error":"retired","message":"Home & Assets has been retired and replaced by Home in Cloudflare OS…"}` (or `"Household Finance has been retired and replaced by Finances in Cloudflare OS…"`), with `Cache-Control: no-store`.
- **Page:** the portal's "forbidden" page with the same message and status 410.

Home & Assets' task and Knowledge links (`/api/portal/assets/tasks`, `/api/portal/assets/items/…/knowledge`), retired earlier, keep the Knowledge and Tasks message. Nothing behind a retired path reads or writes a retired table: the code that could has been deleted (`worker/assets`, `worker/finance`, `src/portal/assets`, `src/portal/finance`, `src/shared/assets`, `src/shared/finance`, `worker/mcp/assets.ts`, `worker/lib/office-files.ts`, their tests, e2e specs and `fixtures/finance`).

## MCP

The gateway (`mcp/`, version **3.2.0**) advertises **56 tools (13 writes)**: chief of staff (2), Daly Intelligence briefings (2), Calendar and leave (17), Today (3, read-only), the Intelligence Centre (28) and Amplenote (4).

The **14 Home & Assets tools** join the retired list in `worker/mcp/retired.ts` and `mcp/src/portal-tools.ts` (`RETIRED_TOOL_NAMES`, now **65** tools; `test/mcp-contract.test.ts` checks that the two lists match and that no retired tool is advertised): `assets_search`, `assets_list`, `assets_get`, `assets_maintenance_history`, `assets_upcoming_maintenance`, `assets_insurance_renewals`, `assets_warranty_expiries`, `assets_list_documents`, `assets_summary`, `assets_get_attention`, `assets_create`, `assets_update`, `assets_create_maintenance` and `assets_complete_maintenance`. Household Finance never had MCP tools.

A call to one gets `code: "retired"` with a message that names Home & Assets and Home in Cloudflare OS:

- **Portal entrypoint** (what matters now): refuses it after verifying the Access token, before anything is read, whatever the caller's role. The gateway that's live (3.1.0) still advertises the 14 tools until 3.2.0 is deployed, but every call to them is refused here.
- **Gateway 3.2.0** (once deployed by hand): stops advertising them and answers `tools/call` for them itself, after authentication and the rate limit, without reaching the portal.

The Chief of Staff tools now need `calendar.use` (they used to accept Calendar or Home & Assets; everyone with Home & Assets also had Calendar).

## Data inventory

Every table below is kept, unchanged, in this release. The migrations that created them stay in `migrations/`, and `npm run db:verify`'s integrity checks and the backups still cover them.

| Area              | Tables (migration)                                                                                                                                                                                                                                                                                                                                                                      | Also                                                                                                                                                  |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Home & Assets     | `asset_preferences`, `asset_categories`, `asset_locations`, `assets`, `asset_shares`, `asset_vehicles`, `asset_odometer`, `asset_valuations`, `asset_maintenance_templates`, `asset_schedules`, `asset_maintenance`, `asset_policies`, `asset_policy_premiums`, `asset_policy_links`, `asset_warranties`, `asset_claims`, `asset_files`, `asset_notifications`, `asset_activity` (0026) | `asset_knowledge_links`, `asset_task_links` (0026) are already in the [Knowledge and Tasks inventory](DECOMMISSION_KNOWLEDGE_TASKS.md#data-inventory) |
| Household Finance | `finance_accounts`, `finance_categories`, `finance_imports`, `finance_import_rows`, `finance_transfers`, `finance_transactions`, `finance_transfer_dismissals`, `finance_reconciliations`, `finance_activity` (0031)                                                                                                                                                                    | Unique indexes `finance_transactions_fingerprint`, `finance_imports_open_file` and the `*_client` retry keys                                          |
| Other             | `feature_flags` rows `assets.ai`, `assets.reminders.email` (if ever set); `calendar_preferences.value` → `overlays.assets`                                                                                                                                                                                                                                                              | Ignored when read, never rewritten on their own                                                                                                       |

**Still in use by retained applications, never part of a cleanup:** `mcp_writes` (history, including the `asset` and `asset_maintenance` entity types its CHECK constraint still allows), `audit_log`, `feature_flags`, `calendar_preferences`, and the Wedding Planner's `budget_items`, `suppliers` and `tasks`.

**Relationships to retained data.** Retained tables hold no foreign keys to these tables; the only references into them are from each other and from the already-retired `asset_*_links`.

**R2.** `private/assets/<id>/…` holds Home & Assets' photos and documents, one `asset_files` row per key. Nothing serves or deletes them any more (the cron job that purged deleted assets' files is gone). `npm run backup:r2` still saves them. Household Finance kept nothing in R2 (it never stored CSV files or raw lines).

## Export and verified backup

As for the earlier retirement ([DECOMMISSION_KNOWLEDGE_TASKS.md](DECOMMISSION_KNOWLEDGE_TASKS.md#export-and-verified-backup)): `npm run db:backup -- --env production` (it exports every ordinary table, including these), then `npm run backup:r2 -- --env production --encrypt` and `--verify` for `private/assets/`. Production has no rows in either application, so both should be empty; the backup proves it.

## Deployment order

1. **Back up** as above.
2. **Merge and deploy the portal Worker** (CI applies `migrations/`; this release adds none). Retired pages and APIs answer 410, and the `assets_*` tools are refused at the portal. Gateway 3.1.0 keeps working for every remaining tool.
3. **Deploy gateway 3.2.0 by hand, when convenient:** `npm run mcp:deploy:dry-run`, then `npx wrangler deploy --config mcp/wrangler.jsonc --env production`. It stops advertising the 14 tools and answers them itself. Reconnect or refresh ChatGPT and Claude connectors so they pick up the shorter list. Until then, assistants still see the tools but every call answers `"retired"`.

## Rollback

- **Code:** redeploy the previous portal Worker. Every table and file is still there, untouched, so Home & Assets and Household Finance come back exactly as they were.
- **Stored settings stay readable both ways.** A person who saves Calendar settings after this release loses only the retired `overlays.assets` choice; the previous release fills it back in with its default (on).
- **Gateway:** if 3.2.0 was deployed, `npx wrangler rollback <previous version id> --name dalyhub-mcp` brings back 3.1.0, which advertises the 14 tools again.

## Cleanup

There is no cleanup script yet. Dropping these tables and deleting `private/assets/` needs the owner's written approval, a fresh verified backup, and at least 30 days without a rollback, as for [Knowledge and Tasks](DECOMMISSION_KNOWLEDGE_TASKS.md#cleanup). It must be a script under `scripts/sql/`, never a migration.
