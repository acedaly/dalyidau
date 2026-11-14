# Payload: backups and restores

Payload keeps the website's content in its own D1 database, **`dalyidau-payload`**: blog posts, pages,
projects, the homepage, navigation, site settings, Payload's users and the media records, plus every
draft and version. The media files themselves are in R2, **`dalyidau-payload-media`**. The wedding data,
the feature switches and the published snapshots the public site reads are in `dalyidau-production`
(see [DATABASE.md](DATABASE.md)), which has its own backups.

Prefer the least destructive option. Restoring the Payload database never changes the public site by
itself: the site reads published snapshots from `dalyidau-production`, and those change only when
something is published again in `/admin`.

## Making a backup

```sh
npm run payload:backup                       # dalyidau-payload (production), read-only on Cloudflare
node scripts/r2-bucket-backup.mjs dalyidau-payload-media
```

`payload:backup` (`scripts/payload-backup.mjs`):

1. counts every table's rows on the live database;
2. exports it (`wrangler d1 export`, read-only);
3. reorders the export with `scripts/d1-export-reorder.py` so it restores (below);
4. restores the reordered file into a throwaway **local** database and checks that every table has at
   least as many rows as the live one, every table and index is there, SQLite's quick check passes and no
   row points at a missing parent;
5. writes `backups/dalyidau-payload-<time>.sql` (the file to restore from), the raw export
   (`….export.sql`) and a manifest (`….sql.json`: sha256, row counts, `ok`).

It exits non-zero if any check fails. `backups/` is git-ignored and owner-only (0700/0600): the database
holds Payload's user list.

Make one before any change to Payload's collections or migrations, and before restoring anything.

### Why the export has to be reordered

D1 exports tables alphabetically, each followed by its rows, so a child table's rows (for example
`homepage_about_paragraphs`, which points at `homepage`) can come before the parent table exists. D1
refuses those rows on import whatever the foreign-key pragmas say, so **a raw `wrangler d1 export` of
this database does not restore.** `d1-export-reorder.py` puts every `CREATE TABLE` first, then all the
rows, then indexes and everything else, each group in its original order. Nothing is added, dropped or
changed. For any export made by hand:

```sh
python3 -I scripts/d1-export-reorder.py export.sql > restore.sql
```

Verified on 12 Nov 2026 against production (25 tables, every count matched).

## Rehearsing a migration

Before a change to Payload's collections or globals reaches production, run its migration on a copy:

```sh
npm run payload:backup
node scripts/payload-migration-rehearsal.mjs backups/dalyidau-payload-<time>.sql
```

It restores the backup into a throwaway local database, runs Payload's own migration runner (what production
runs when `/admin` first opens after a deploy) and compares every table that existed before, row for row and
value for value. It fails if a row is lost or changed, a table or index is gone, or SQLite's integrity or
foreign-key checks fail. Nothing on Cloudflare is touched, and your local development state is set aside and
put back.

## Restoring

### A mistake in the last 30 days (most cases)

D1 Time Travel restores the whole database to a moment in time, with no file needed:

```sh
npx wrangler d1 time-travel info dalyidau-payload --timestamp=2026-11-12T10:00:00Z   # check first
npx wrangler d1 time-travel restore dalyidau-payload --timestamp=2026-11-12T10:00:00Z
```

It prints a bookmark you can restore to undo the restore.

### From a backup file

Restoring from a file needs an **empty** database: the file creates every table. The safe way is a new
database, then pointing the Worker at it, so the old one stays as it was until you're sure.

```sh
npx wrangler d1 create dalyidau-payload-restore
npx wrangler d1 execute dalyidau-payload-restore --remote --file backups/dalyidau-payload-<time>.sql --yes
```

Then change the `D1` binding's `database_name` and `database_id` in `poc/payload/wrangler.jsonc` (the
production environment) to the new database, and deploy through a pull request as usual. To go back,
change the binding back. Only the owner approves deleting either database.

### After restoring

1. Open `daly.id.au/admin` and check the posts, pages and projects are there.
2. Payload applies any newer migrations on its first request; the restored `payload_migrations` table
   says which have run.
3. The public site keeps showing what was last published. To make it match the restored content, open
   each item and publish it again (Homepage, Navigation and Site settings: **Save**; posts, pages and
   projects: **Publish changes**).
4. If media files are missing, restore them from the R2 backup: `manifest.json` maps each file back to
   its key; upload each with `npx wrangler r2 object put dalyidau-payload-media/<key> --file … --remote`.
