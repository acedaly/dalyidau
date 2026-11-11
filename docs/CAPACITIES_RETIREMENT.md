# The Capacities sync switch and archive

Capacities is the blog's publisher ([CAPACITIES.md](CAPACITIES.md)). This page covers how its articles
stay online from Cloudflare whether or not the sync runs, the archive, and when it would be safe to remove
the API token and cancel the subscription.

> **9 Nov 2026:** Amplenote, which replaced Capacities as the publisher for a while, was retired
> ([DECOMMISSION_PORTAL_APPS.md](DECOMMISSION_PORTAL_APPS.md)). The articles it published stay online
> as stored, including any that took over a Capacities article's address (below): the Capacities sync
> still never republishes those. Moving an article to Amplenote, and undoing a move, are gone with it.

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

Portal settings → **Website & Blog** shows the Capacities archive card: the switch, every Capacities
article and its archive copy, and any article an Amplenote note took over before Amplenote was retired. There are no Capacities connection controls in
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
post remains. Even then, removing them is optional: they do nothing while the switch is off.

## Articles an Amplenote note took over

While Amplenote published the blog, an owner could approve an Amplenote note taking over a Capacities
article's address (`replaces:` in the note). The Capacities article was copied into `capacities_archive`,
marked `replaced_by` the note, and the note's article was published at the same address. Since
Amplenote was retired, those addresses keep serving the note's article as stored, and the Capacities
sync never republishes the original. There's no longer a button to undo a move; the original is still in
`capacities_archive` if it's ever wanted back.

## Rollback of this change

- **Turn Capacities back on:** switch it on in Features. Articles an Amplenote note took over stay with
  the note's article.
- **Revert the code:** code older than the archive ignores `capacities_archive`, so it would publish a
  moved article's Capacities object again at a second address. It also syncs whenever a token is set,
  without the empty-listing protection, so delete the token first if Capacities is no longer reachable.
