# Database: migrations, backups, recovery

The Worker uses one D1 database per environment: `dalyidau-production` and `dalyidau-staging`. The blog's tables can always be rebuilt from Capacities; **the wedding portal's data exists only in D1**, so it needs backups.

## Migrations

| File                                   | What it does                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0001_init.sql`                        | Blog tables                                                                                                                                                                                                                                                                                                                                        |
| `0002_portal_wedding.sql`              | Portal and wedding tables                                                                                                                                                                                                                                                                                                                          |
| `0003_privacy_and_integrity.sql`       | Soft deletion, integrity triggers, append-only audit and concurrent-edit guard                                                                                                                                                                                                                                                                     |
| `0004_seating_catering_rsvp_comms.sql` | Seating, catering, website media, RSVP versioning/idempotency and communication scheduling                                                                                                                                                                                                                                                         |
| `0005_comms_channels.sql`              | Communication channel and provider-delivery records                                                                                                                                                                                                                                                                                                |
| `0006_say_i_do_ceremony.sql`           | Ceremony/site data carried forward from Say I Do                                                                                                                                                                                                                                                                                                   |
| `0007_guest_import.sql`                | Auditable, idempotent guest import staging and reports                                                                                                                                                                                                                                                                                             |
| `0008_invitation_studio.sql`           | Invitation design and generation data                                                                                                                                                                                                                                                                                                              |
| `0009_household_invitation_names.sql`  | Household invitation-name fields                                                                                                                                                                                                                                                                                                                   |
| `0010_rsvp_travel.sql`                 | Courtesy-bus and accommodation responses                                                                                                                                                                                                                                                                                                           |
| `0011_communications_studio.sql`       | Household-aware recipients, controlled test sends and thank-you notes                                                                                                                                                                                                                                                                              |
| `0012_household_consent.sql`           | Household email/SMS opt-out fields                                                                                                                                                                                                                                                                                                                 |
| `0013_knowledge_engine.sql`            | Knowledge spaces, types, objects, revisions, relationships, tags, private audit and derived FTS5 index                                                                                                                                                                                                                                             |
| `0014_knowledge_organising.sql`        | Daily-note uniqueness, collections/memberships, shared pins, personal favourites, validated saved views and templates                                                                                                                                                                                                                              |
| `0015_tasks.sql`                       | Daly Tasks: projects, members, sections, tasks, labels, completions, comments, history, Knowledge references, saved filters, reminders, preferences (see [TASKS_PROJECTS.md](TASKS_PROJECTS.md#data-model))                                                                                                                                        |
| `0016_tasks_planning.sql`              | Daly Tasks Milestone 2: list preferences, reminder and planning preferences, reminder delivery state, Quick Add request ids, repeat exceptions, templates, Todoist import batches and provenance (see [TASKS_PROJECTS.md](TASKS_PROJECTS.md#milestone-2-schema))                                                                                   |
| `0017_tasks_productivity.sql`          | Daly Tasks Milestone 3: project review frequency and manual health, reviews and their next actions, project Knowledge links, goals (members, links, milestones, history), routines and turn order, dashboard preferences (see [TASKS_PROJECTS.md](TASKS_PROJECTS.md#milestone-3-schema))                                                           |
| `0018_mcp_writes.sql`                  | The MCP gateway's write ledger: one row per AI-client write (person, tool, record id, outcome, request id for retry safety), never titles or text (see [MCP.md](MCP.md#writes-audit-and-retries))                                                                                                                                                  |
| `0019_dalyhub_import.sql`              | DalyHub migration provenance: which portal records a DalyHub import created, with their versions, so imports are idempotent and revertible. Ids only (see [DALYHUB_MIGRATION.md](DALYHUB_MIGRATION.md))                                                                                                                                            |
| `0020_mcp_projects.sql`                | MCP project management: `task_projects.client_id` with a unique index per creator (retry-safe project creation), and `mcp_writes` rebuilt, every row copied, so `task_project` can be a write's outcome. The rebuild is the one non-additive step, because SQLite can't widen a CHECK in place (see [MCP.md](MCP.md#releasing-project-management)) |
| `0021_intelligence.sql`                | Daly Intelligence: configuration and preferences, AI exclusions, usage and alerts, jobs, the derived semantic index, captures, transcripts, suggestions, briefings and shared attachments; `mcp_writes` rebuilt (every row copied) for capture and suggestion outcomes (see [INTELLIGENCE.md](INTELLIGENCE.md))                                    |

Rules:

- **Forward-only and additive.** Never edit a migration that has been applied anywhere shared (staging or production). Add a new file.
- **Numbered and applied in order.** `wrangler d1 migrations apply` records each one in `d1_migrations`; `npm run db:verify` checks they were applied in order.
- **Tested from scratch on every test run**: Vitest applies every migration to an empty database, and the e2e run applies them to a fresh local database.
- **Tested on existing data before release**: apply the new migration to a local database that already has data (for example after `npm run seed:portal`), then `npm run db:verify -- --local`.
- **Deploys apply them automatically** (`.github/workflows/deploy.yml`): record a restore point → apply migrations → verify (read-only) → deploy the code. If verification fails, the new code is not deployed.

## Checking a database

```bash
npm run db:verify                      # production (remote, read-only)
npm run db:verify -- --env staging
npm run db:verify -- --local           # your wrangler dev database
```

Checks: migrations applied and in order, SQLite `quick_check`, foreign keys, guest JSON validity, invitations pointing at real guests and events, active guests left in deleted households (warning), RSVP code format, non-negative budget amounts, and for Knowledge: valid object/template/view JSON, every space has an owner, favourites still belong to members, and the search index covers every object (warning; rebuild it with `KNOWLEDGE_FTS_REBUILD` from `worker/knowledge/search.ts`); and for Tasks: every project has an owner and personal projects only their owner, subtasks sit one level below a parent in the same project and section, repeating tasks have a valid rule and a date, and reminders belong to current members (warning). It prints only row counts, never contents.

## Backups

### Automatic: D1 Time Travel

D1 keeps a point-in-time history for **30 days** with no setup. Every deploy logs a bookmark ("Record database restore point") just before migrating, so you can return to exactly that moment.

### Before a risky change: a verified export

```bash
npm run db:backup -- --env production
```

1. Records the schema and row counts on the live database.
2. Exports it to `backups/production-<time>.sql` (read-only on the remote).
3. Restores the file into a throwaway local database, checks every table has at least as many rows as the live one and every table, index, trigger and view is there, and runs all the integrity checks on the restored copy.
4. Writes `backups/…sql.json` with the SHA-256, size and row counts.

**Virtual tables (Knowledge search).** `wrangler d1 export` refuses any database that contains a virtual table ("cannot export databases with Virtual Tables (fts5)"). Once migration `0013` adds `knowledge_fts`, the script exports the ordinary tables one by one instead, then appends their indexes, triggers and views, and finally the statements that recreate `knowledge_fts` and rebuild it from `knowledge_objects` (`scripts/lib/virtual-tables.mjs`). The result is still one `.sql` file that restores with `wrangler d1 execute --file`. A plain `wrangler d1 export` of the whole database won't work any more; use the script. The index is derived data, so nothing is lost by rebuilding it. Daly Tasks (`0015`–`0017`) adds no virtual tables: its search uses ordinary indexed queries, and its triggers and composite keys are restored with the rest of the schema (`npm run test:backup` checks both).

`scripts/lib/ops.mjs` includes every `0014` table in the row-count manifest. `npm run test:backup` is the safe local regression: it migrates a populated `0013` database, adds invented rows to every Milestone 3 table, invokes the real backup command, restores into isolated scratch databases, rebuilds FTS5 and verifies search, relations, schema objects, constraints and unrelated blog/wedding rows. It completed with no problems on 17 October 2026. It never uses a remote binding.

The file contains guests' personal details. `backups/` is git-ignored, and the script makes the folder and every file in it readable by your account only (0700/0600, including older backups). Keep backups somewhere private and delete them when no longer needed: `node scripts/db-backup.mjs --prune 5` keeps the newest five per environment and deletes the rest ([PRIVACY.md](PRIVACY.md#places-the-portal-cant-reach)).

### Files in R2 (Daly Intelligence)

D1 backups hold the `attachments` rows; the files are in R2. `npm run backup:r2 -- --env production --encrypt` (with `BACKUP_PASSPHRASE` set) copies every permanent or kept file to `backups/r2-<env>-<time>/`, verified against D1 and encrypted with AES-256-GCM; `--verify <dir>` re-checks one. Temporary processing files aren't backed up by design. The Vectorize index is derived and is rebuilt from Knowledge, never restored. See [INTELLIGENCE.md](INTELLIGENCE.md#backup-and-recovery).

## Restoring

**Never restore over production without being sure.** Prefer the least destructive option.

### A mistake in the last 30 days (most cases)

```bash
npx wrangler d1 time-travel info dalyidau-production                       # current bookmark
npx wrangler d1 time-travel restore dalyidau-production --timestamp=2027-03-01T10:00:00Z
# or --bookmark=<bookmark from the deploy log>
```

This rewinds the whole database, losing anything written after that time (including RSVPs). Note the current bookmark first so you can undo the restore.

### From an exported backup

Restore into a **new** database, check it, then switch the Worker to it:

```bash
npx wrangler d1 create dalyidau-restore-2027-03-01
npx wrangler d1 execute dalyidau-restore-2027-03-01 --remote --file backups/production-<time>.sql
# point a local check at it, or temporarily bind it in staging, and run npm run db:verify
# then change database_id for the DB binding in wrangler.jsonc (production) and deploy
```

Creating a database is free on the current plan but is a change to the account; do it deliberately.

### From a Daly Knowledge portable export

The JSON/ZIP manifest is a versioned application-level portability format, separate from the whole-D1 SQL backup. Validate a downloaded file without changing a database:

```bash
npm run knowledge:check-export -- path/to/my-knowledge-2026-10-17.zip
```

The restore implementation is exercised only against a fresh local database in `test/knowledge-export.test.ts`. There is deliberately no API or production command that imports it yet: Milestone 4 must add a preview, destination choice, collision reconciliation and attachment handling first. Never experiment by restoring a portable export over staging or production.

### Just one record

Deleted guests and households can be restored from Portal settings → Privacy until they're erased. Other deleted items (tasks, suppliers, budget items, events) are recorded in the audit log with their non-personal fields, so they can be re-entered by hand.

## Rolling back a release

1. **Code only**: `npx wrangler rollback <version-id> --env=""` (see [DEPLOYMENT.md](DEPLOYMENT.md#rollback)). Migrations are additive, so older code keeps working against the newer schema.
2. **Code and data**: roll the code back, then Time Travel to the bookmark logged by the deploy.
3. Revert the commit on `main` so the next deploy doesn't reapply the change.

## How the code protects the data

- Every query binds its values; table and column names come only from fixed definitions in code.
- Every write and its audit entry go in one D1 batch (a transaction).
- Concurrent edits: saves carry the version (`updated_at`) the form was opened with; if someone else saved in between, the save is refused with "Someone else changed this", and nothing is written. `updated_at` is strictly increasing so two saves can't share a version.
- Sending a message claims it first (`draft/queued → sending`), so a double click or overlapping cron can't send twice.
- The RSVP rate limiter is a single atomic upsert.
- Native RSVP retries carry a browser-generated id; a partial unique index permits only one submission per household/id, including concurrent requests.
- Large CSV imports are written in chunks of 400 statements; each chunk is atomic. The import is previewed first, so a failure midway is rare; if it happens, re-running the same file updates the rows already imported rather than duplicating them.
