# Backup, deployment, rollback and recovery

How to put daly.id.au right when something goes wrong, and how to change it safely. Production is the only
environment. For day-to-day use see [WEBSITE-GUIDE.md](WEBSITE-GUIDE.md); for how it fits together,
[ARCHITECTURE.md](ARCHITECTURE.md).

## What holds what

| Thing                       | Where                              | Holds                                                                      |
| --------------------------- | ---------------------------------- | -------------------------------------------------------------------------- |
| Worker `dalyidau`           | Cloudflare Workers                 | All the code: the public site, Payload at `/admin`, the wedding, the cron. |
| D1 `dalyidau-payload`       | Payload's database (binding `D1`)  | Posts, pages, projects, settings, drafts, versions, the media records.     |
| D1 `dalyidau-production`    | The site's database (binding `DB`) | What the public site shows (published copies), and **all wedding data**.   |
| R2 `dalyidau-payload-media` | Payload's files (binding `R2`)     | Every uploaded image, private.                                             |
| R2 `dalyidau-media`         | The site's files (binding `MEDIA`) | Published images and their smaller copies (`variants/`), wedding photos.   |

The public site never starts Payload: it reads published copies from `dalyidau-production`. So **if Payload is
down, the public site and the wedding site stay up**; only editing stops.

## Backups

```sh
npm run db:backup -- --env production                 # the site's database, wedding data included
npm run payload:backup                                # Payload's database
node scripts/r2-bucket-backup.mjs dalyidau-media      # published images, wedding photos
node scripts/r2-bucket-backup.mjs dalyidau-payload-media
```

Each database backup is read-only on Cloudflare, is restored into a throwaway local database to prove it
restores, and writes a manifest beside the file in `backups/` (git-ignored, owner-only). Details:
[DATABASE.md](DATABASE.md), [PAYLOAD-BACKUP.md](PAYLOAD-BACKUP.md).

Besides these, **D1 Time Travel** keeps 30 days of both databases with no action needed.

Take the two database backups before every deploy that carries a migration, and before restoring anything.

## Deploying

A deploy happens when a pull request is merged to `main` (`.github/workflows/deploy.yml`): the full test suites
run again, the site's database migrations are applied, and the Worker goes out. Nothing deploys from a branch.

Before merging:

1. CI is green on the pull request and the commit is the one that was reviewed.
2. If it carries a migration: back up both databases, and for a Payload migration rehearse it on that backup
   (`node scripts/payload-migration-rehearsal.mjs backups/dalyidau-payload-<time>.sql`). It must pass.
3. Capture what the site serves and the wedding's data, to compare afterwards:

```sh
node scripts/public-baseline.mjs capture output/baseline/before
node scripts/wedding-fingerprint.mjs capture output/wedding-before.json
```

After the deploy finishes:

```sh
node scripts/public-baseline.mjs capture output/baseline/after
node scripts/public-baseline.mjs compare output/baseline/before output/baseline/after     # only what you expected changed
node scripts/wedding-fingerprint.mjs capture output/wedding-after.json
node scripts/wedding-fingerprint.mjs compare output/wedding-before.json output/wedding-after.json   # all 24 tables identical
npx wrangler deployments list --name dalyidau                                              # note the new version
```

Then open `/admin` once: Payload applies its own pending migrations on its first request, and the dashboard's
Website sync should say the site matches.

A difference in `public-baseline` isn't always the deploy: anything published in Payload in between shows too.

## Rolling back

| Situation                          | What to do                                                                                                                                                                                                       |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A bad deploy (code)                | `npx wrangler deployments list --name dalyidau`, then `npx wrangler rollback <previous version id> --name dalyidau -y`. Takes seconds. Then revert the merge on `main` so the next deploy doesn't bring it back. |
| A deploy that carried a migration  | Roll the code back as above and **leave the schema**. Every migration here is additive: earlier code ignores the new tables and columns. Never run a Payload migration's `down` in production.                   |
| The deploy itself failed in CI     | Nothing was changed if the tests failed. If the Worker upload failed after migrations ran, the migrations are additive and harmless: fix and re-run the workflow.                                                |
| A Payload migration stopped midway | `/admin` won't start; the public site is unaffected. Restore Payload's database with Time Travel to just before the deploy (below), fix the cause, rehearse, deploy again. Or roll the code back.                |

## Recovering

### Payload (`/admin`) is unavailable

The public site and the wedding keep working. Check, in order:

1. `https://daly.id.au/api/health` answers: the Worker is up.
2. Cloudflare Access lets you in: a sign-in loop is Access, not Payload.
3. The Worker's logs (`npx wrangler tail dalyidau`) while loading `/admin`: a migration error names the
   statement (see "A Payload migration stopped midway"); anything else, roll back to the previous version.

Nothing is lost while it's down: there's simply no way to edit until it's back.

### A database operation failed

- **While publishing:** Payload saved, the site wasn't updated, and the editor was told so. Save again, or press
  Republish on the dashboard. See "Publishing is inconsistent".
- **A database is damaged or has wrong data:** restore it to a moment before the damage.

```sh
npx wrangler d1 time-travel info dalyidau-payload --timestamp=2026-11-14T05:00:00Z      # check first
npx wrangler d1 time-travel restore dalyidau-payload --timestamp=2026-11-14T05:00:00Z   # prints a bookmark that undoes it
```

The same for `dalyidau-production`, **which also rewinds the wedding's data** to that moment: only do that if
nothing in the wedding has changed since, or accept losing it. To restore part of a database, restore the
backup file into a **new** database and copy what's needed across (PAYLOAD-BACKUP.md, DATABASE.md).

- After restoring Payload's database, the site still shows what was last published. Open the dashboard: Website
  sync lists every difference, and Republish makes the site match the restored content.

### Publishing is inconsistent (Payload says one thing, the site shows another)

The dashboard's **Website sync** panel compares the two, live, and the cron checks every 15 minutes (logged as
`site_out_of_sync`).

| It says                                         | Means                                                       | Do                                                                          |
| ----------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------- |
| published here, but not on the website          | A publish didn't reach the site.                            | **Republish**.                                                              |
| the website shows an older version              | A later save didn't reach the site, or an older one landed. | **Republish**.                                                              |
| on the website, but not published here          | An unpublish didn't reach the site.                         | **Republish** (takes it down).                                              |
| on the website, but there's no document here    | The document was deleted for good, or Payload lost it.      | Decide. Republish leaves it alone. An owner can remove it (a copy is kept). |
| the list of projects / redirects is out of date | The list wasn't rewritten.                                  | **Republish**.                                                              |
| Couldn't check                                  | One of the databases couldn't be read.                      | Reload. If it persists, check the Worker's logs.                            |

Republish runs the same code as saving, is safe to press twice, and reports each item as fixed, failed or left
alone. A copy of anything an owner removes is kept in the site's database under `removed:<kind>:<id>:<when>`
(table `meta`), and the redirect list a write replaced is kept one back under `site:redirects-previous`.

### Something was unpublished by accident

Open it in Payload and **Publish** again. It returns at the same address, and every old address it had leads to
it again (they're kept while it's off the site). If it was moved to Trash, restore it from Trash first.

If it was **deleted for good**, Payload no longer has it or its versions. Restore Payload's database to a moment
before the delete into a **new** database (PAYLOAD-BACKUP.md, "From a backup file", or Time Travel on a copy),
copy the document's content back by hand, and publish. If the site's copy is still up (the dashboard lists it
as "no document here"), leave it up until the document is back.

If the wrong version was published, open **Versions**, pick the right one and **Restore**.

### An image is missing or broken on the site

Published images are copied to `dalyidau-media` under their content hash. Publish the item again (or press
Republish): the copy is made again from Payload's library. Smaller copies (`variants/…`) are remade on demand;
deleting them is always safe.

### The wedding

Wedding data lives only in `dalyidau-production`. Its recovery, and what must never be done to it, are in
[DATABASE.md](DATABASE.md#restoring) and [PORTAL.md](PORTAL.md). Nothing in the website's publishing writes to
the wedding's tables: `scripts/wedding-fingerprint.mjs` proves that around every deploy.

## Known limitations

| Area         | Limitation                                                                                                                                                                                           |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Publishing   | Payload and the site are two databases with no shared transaction. A failed copy is retried, reported and repairable, but can't be made impossible.                                                  |
| Publishing   | No scheduled publishing, and no autosave: Preview shows the last **saved** draft.                                                                                                                    |
| Website sync | The homepage's words, the menu and site settings aren't compared item by item. Republish rewrites the menu and settings every time; re-save the Homepage if it looks wrong.                          |
| Redirects    | Paths only (no query strings or wildcards), on daly.id.au only. Outside the blog, exactly as typed.                                                                                                  |
| Images       | Smaller copies use Cloudflare Images' free allowance (5,000 new copies a month). Beyond it, or if the service fails, the original is served. Animated GIFs and AVIF originals' sizes aren't checked. |
| Images       | An image's structure is checked when published, not its pixels: a file that is well-formed but corrupt inside shows as a broken picture.                                                             |
| Payload      | D1 runs a Payload migration statement by statement, without a transaction. Hence: additive migrations only, rehearsed on a backup.                                                                   |
| Payload      | Document numbers can be reused after a delete (turning that off would rebuild every table). The publisher guards against a reused number.                                                            |
| Admin        | Usable on a phone, but Payload's editor is built for a wider screen: long forms scroll, and the rich-text toolbar is cramped.                                                                        |
| Environment  | Production is the only environment. Everything is tested locally and in CI against invented data before it deploys.                                                                                  |
| Security     | HSTS has no `includeSubDomains` (it would bind every daly.id.au subdomain): the owner's call.                                                                                                        |

The full findings register, with what was fixed where, is [AUDIT-2026-11.md](AUDIT-2026-11.md).
