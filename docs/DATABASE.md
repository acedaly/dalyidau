# Database: migrations, backups, recovery

The Worker uses one D1 database per environment: `dalyidau-production` and `dalyidau-staging`. The blog's tables can always be rebuilt from Capacities; **the wedding portal's data exists only in D1**, so it needs backups.

## Migrations

| File | What it does |
| --- | --- |
| `0001_init.sql` | Blog tables |
| `0002_portal_wedding.sql` | Portal and wedding tables (new tables only) |
| `0003_privacy_and_integrity.sql` | Soft deletion columns, integrity triggers (JSON shape, no negative money, append-only audit), `batch_guard` for safe concurrent edits. Additive only. |

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

Checks: migrations applied and in order, SQLite `quick_check`, foreign keys, guest JSON validity, invitations pointing at real guests and events, active guests left in deleted households (warning), RSVP code format, non-negative budget amounts. It prints only row counts, never contents.

## Backups

### Automatic: D1 Time Travel

D1 keeps a point-in-time history for **30 days** with no setup. Every deploy logs a bookmark ("Record database restore point") just before migrating, so you can return to exactly that moment.

### Before a risky change: a verified export

```bash
npm run db:backup -- --env production
```

1. Records row counts on the live database.
2. Exports it to `backups/production-<time>.sql` (read-only on the remote).
3. Restores the file into a throwaway local database, checks every table has at least as many rows as the live one, and runs all the integrity checks on the restored copy.
4. Writes `backups/…sql.json` with the SHA-256, size and row counts.

The file contains guests' personal details. `backups/` is git-ignored; keep backups somewhere private and delete them when no longer needed ([PRIVACY.md](PRIVACY.md#places-the-portal-cant-reach)).

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

### Just one record

Deleted guests and households can be restored from Settings → Privacy until they're erased. Other deleted items (tasks, suppliers, budget items, events) are recorded in the audit log with their non-personal fields, so they can be re-entered by hand.

## Rolling back a release

1. **Code only**: `npx wrangler rollback <version-id> --env=""` (see [DEPLOYMENT.md](DEPLOYMENT.md#rollback)). Migrations are additive, so older code keeps working against the newer schema.
2. **Code and data**: roll the code back, then Time Travel to the bookmark logged by the deploy.
3. Revert the commit on `main` so the next deploy doesn't reapply the change.

## How the code protects the data

- Every query binds its values; table and column names come only from fixed definitions in code.
- Every write and its audit entry go in one D1 batch (a transaction).
- Concurrent edits: saves carry the version (`updated_at`) the form was opened with; if someone else saved in between, the save is refused with "Someone else changed this", and nothing is written. `updated_at` is strictly increasing so two saves can't share a version.
- Sending a message claims it first (`draft → sending`), so a double click can't send twice.
- The RSVP rate limiter is a single atomic upsert.
- Large CSV imports are written in chunks of 400 statements; each chunk is atomic. The import is previewed first, so a failure midway is rare; if it happens, re-running the same file updates the rows already imported rather than duplicating them.
