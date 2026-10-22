# Retiring Capacities

Amplenote is the only publishing source ([AMPLENOTE.md](AMPLENOTE.md)). This page covers how the
articles first published from Capacities stay online without it, when it's safe to remove the API token
and cancel the subscription, how to move an old article to Amplenote at the same address, and how to undo
each step.

## Why nothing is lost

A Capacities article has never been read from Capacities when someone visits it. The sync copied
everything into Cloudflare when it published:

| What                                                    | Where                                                                      |
| ------------------------------------------------------- | -------------------------------------------------------------------------- |
| Rendered article (escaped HTML), title, subtitle, dates | D1 `posts` (`source = 'capacities'`)                                       |
| Category, tags, featured flag, summary, reading time    | D1 `posts`                                                                 |
| Search text                                             | D1 `posts.search_text` (search reads only this)                            |
| Featured image and every image in the body              | R2 bucket `dalyidau-media`, served at `/media/<key>` with `img-src 'self'` |
| Old addresses after a rename                            | D1 `slug_redirects` (301 to the current address)                           |
| RSS, sitemap, Open Graph and structured data, related   | built from `posts` on each request                                         |

The article HTML uses the classes in `worker/lib/article-html.ts`, styled by `src/styles/article.css`.
That stylesheet is the shared design system for both publishers, and archived articles pick up its
improvements (callout icons, pull quotes, link cards) without being re-rendered. So `worker/capacities/render.ts`
is only needed to render _new_ Capacities content. It stays in the repository while archived articles
exist, because the stored HTML is its output and the tests that pin that output depend on it.

## The switch: Capacities sync

**Portal settings → Features → Website & Blog → Capacities sync** (`website.capacities.sync`).

- **On:** the 15-minute cron and the manual sync (`POST /api/admin/sync`, `npm run sync:local`) read
  Capacities and publish, update or unpublish Blog Posts as before.
- **Off (the default) means archived:** the cron makes no request to Capacities and records no run. The
  manual sync answers 409 without contacting it. Nothing can change or unpublish a Capacities article. If
  the switch can't be read, it counts as off.

Even with the switch on, two new protections hold:

- A listing that returns **no Blog Posts at all** while some are published is treated as an outage
  (lapsed subscription, moved space, API change), not as every article being deleted. The run is
  marked partial and says so.
- A missing or revoked token, or Capacities being unreachable, fails the run and changes nothing (as
  before).

Portal settings → **Website & Blog** shows the source of each article (Amplenote active, Capacities
archived or syncing) and the Capacities archive card. There are no Capacities connection controls in
the portal: the only one was the manual sync endpoint, which now refuses while sync is off.

## Retiring Capacities, step by step

Nothing here changes production data except step 3, which only _adds_ archive rows.

1. **Deploy** this change. Migration `0029_capacities_archive.sql` is additive: one table and three
   nullable columns. Back up first: `npm run db:backup`.
2. **Check the switch.** It starts off after the deploy, so syncing has already stopped. To keep
   syncing for a while, switch it on, and switch it off when you're ready.
3. **Portal settings → Website & Blog → Capacities archive → Check and archive.** This copies every
   Capacities article into `capacities_archive` and checks every image it shows exists in R2. It is
   audited (`website.capacities.archive`). Run it again whenever the card says an archive is out of date.
4. **Take an off-Cloudflare copy:**
    ```sh
    npm run db:backup                                          # D1, including posts and capacities_archive
    npm run capacities:inventory -- --env production --download # every blog image + inventory.json
    ```
    Both write to git-ignored folders (`backups/`, `migration-work/`): they contain real articles.
    The inventory exits non-zero if any image is missing or any article isn't archived.
5. **Check every article in a browser**, including one old address from `inventory.json`.

### When it's safe to remove the token and cancel

When the card says **Safe to retire Capacities**, all of these hold:

- Capacities sync is switched off.
- Every Capacities article has a current copy in the archive.
- Every image is in R2 (checked by Check and archive).

Then, with the backups from step 4 kept somewhere safe:

```sh
npx wrangler secret delete CAPACITIES_API_TOKEN --env=""
```

and cancel the subscription. `npm run check:config` warns that the token is missing; that warning is
expected from now on. Nothing on the site changes.

Keep `worker/sync.ts`, `worker/capacities/` and `fixtures/capacities/` until no `source = 'capacities'`
post remains (every article moved to Amplenote, below). Even then, removing them is optional: they
do nothing while the switch is off.

## Moving an article to Amplenote at the same address

You may want to edit an old article in Amplenote. Importing it as an ordinary note would publish a
**second** copy at another address, so the publisher refuses: a note whose title or address matches a
Capacities article waits, with the reason shown in Portal settings → Website & Blog.

To move it instead:

1. Copy the article into an Amplenote note. Tag it `website/blog` and publish it in Amplenote.
2. In the note's Website section, name the article it replaces (its slug, `/blog/<slug>` or the full
   address all work):
    ```
    # Website
    replaces: building-my-ai-chief-of-staff
    ```
3. Wait for the plugin to run. In Portal settings → Website & Blog the note shows
   "Replaces the Capacities article … at /blog/<slug>" with **Approve move**. Approval needs Capacities
   sync switched off, and only an owner or admin can give it (audited, `website.capacities.replace`).

On approval, one atomic batch:

- copies the Capacities article into `capacities_archive`, marked as replaced by the note;
- removes it from `posts` (the archived copy keeps every column);
- points its old addresses (`slug_redirects`) at the note;
- publishes the note at the **same address**.

What the note doesn't set is kept from the original: its **published date** (so RSS order and dates
don't jump), category, tags, subtitle, summary and featured image. The note's own `website/category/…`,
`website/tag/…`, `subtitle:`, `summary:`, `published:` and `image:` override them. `slug:` is ignored
while `replaces:` is there. If the note was already published at another address, that address
redirects. A Capacities sync switched back on later never republishes a moved article.

Until it's approved, a note that was already live keeps its current version, and one that wasn't stays
unpublished. It is never published at a different address. `replaces:` naming something that isn't a
published Capacities article holds the note too, so a typo can't publish a duplicate.

### Undoing a move

Portal settings → Website & Blog → the note → **Restore Capacities version** (audited,
`website.capacities.restore`). In one batch, the archived copy goes back into `posts` exactly as it
was, its own old addresses point at it again, the note's post is removed, and the note goes back to
waiting for approval while it still says `replaces:`. Remove that line from the note to publish it at
an address of its own instead.

## Rollback of this change

- **Turn Capacities back on:** switch it on in Features. Moved articles stay with Amplenote; undo each
  move first if you want Capacities to own it again.
- **Revert the code:** the previous code ignores `capacities_archive` and the new columns. Undo any
  moves first: the old sync doesn't know about them and would publish a moved article's Capacities
  object again at a second address. The old code also syncs whenever a token is set, without the
  empty-listing protection, so delete the token first if Capacities is no longer reachable.
- **Drop the migration** (only after undoing every move): `DROP TABLE capacities_archive;` and drop
  `amplenote_articles.replace_slug`, `replace_approved_by` and `replace_approved_at`.
