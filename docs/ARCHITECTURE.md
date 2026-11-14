# Architecture

How daly.id.au is put together, as of November 2026. For using it, see [WEBSITE-GUIDE.md](WEBSITE-GUIDE.md); for
operating it, [RECOVERY.md](RECOVERY.md).

## The short version

One Cloudflare Worker (`dalyidau`) answers every request for `daly.id.au` and `wedding.daly.id.au`. Inside it:

- **The public site** (`worker/`, `src/`): each page is rendered by React in the Worker and hydrated in the
  browser. It reads only what has been published, from one D1 database and one R2 bucket.
- **Payload CMS** (`poc/payload/`, at `/admin`): where content is written. It has its own D1 database and R2
  bucket. Its hooks copy what's published to the site's database.
- **The wedding** (`worker/wedding`, `worker/portal`, `src/wedding`, `src/planner`): the public wedding site,
  its administration inside Payload, and the phone app. See [PORTAL.md](PORTAL.md), [PLANNER.md](PLANNER.md).

```
            editor                                   visitor
              │                                         │
   Cloudflare Access (sign-in)                          │
              ▼                                         ▼
   ┌──────────────────────────────── Worker `dalyidau` ───────────────────────────────┐
   │  Payload /admin, /api/*  ──publish (hooks)──▶  site snapshots  ──▶  public pages  │
   │        │                                            │                    │        │
   └────────┼────────────────────────────────────────────┼────────────────────┼────────┘
            ▼                                            ▼                    ▼
   D1 dalyidau-payload                          D1 dalyidau-production   R2 dalyidau-media
   R2 dalyidau-payload-media                    (also all wedding data)  (published images)
```

The two halves share nothing at request time: **a public page never starts Payload**, so the site stays up,
and fast, whatever Payload is doing.

## Why this shape

| Decision                                        | Reason                                                                                                                                    |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| React rendered in the Worker, plain links       | Complete HTML for every page, nothing breaks on refresh, works without JavaScript. No client router.                                      |
| Payload publishes copies, the site reads copies | The public site needs no CMS at request time, can be cached hard at the edge, and can't expose a draft: drafts never reach its database.  |
| HTML built when published, never on request     | Rich text is turned into HTML once, by a renderer that escapes every string. Pages read a stored string. No sanitiser to keep up to date. |
| Images copied under their content hash          | A published image's address never changes and can be cached for a year. Smaller copies are made once and kept.                            |
| One Worker                                      | One deploy, one rollback, one set of security headers and one sign-in (Cloudflare Access) for everything private.                         |
| Feature switches                                | The public wedding site, RSVP, email and the projects-first design are switched in Administration → Features, not by deploying.           |

## A request

`worker/index.ts`, in order:

1. Host rules: `www` redirects to the apex; the wedding host serves only the wedding.
2. `/admin`, Payload's `/api/*` and `/_next/*` go to Payload (`poc/payload/platform/compose.ts`), which first
   verifies the Cloudflare Access token and the person's role, refuses writes from another site, and adds the
   security headers. Everything it doesn't own falls through to the site's Worker.
3. `/api/portal/*`, `/portal/*`, `/wedding/*`: the wedding and its API (never cached).
4. `/media/<hash>.<ext>`: a published image from R2. With `?w=480|960|1600` it is the smaller copy, in AVIF or
   WebP if the browser accepts them (`worker/lib/image-variants.ts`).
5. `/robots.txt`, `/sitemap.xml`, `/feed.xml`: generated from the site's database.
6. Pages: `/`, `/projects`, `/projects/<slug>`, `/blog`, `/blog/<slug>`, `/contact`, `/<page>`. The route reads
   the published copy, React renders it into `shell.html` with the head (`worker/seo.ts`).
7. Nothing matched: a redirect kept by hand in Payload, if there is one for that address; otherwise the 404 page.

On the production host a successful page is kept in Cloudflare's edge cache, keyed by the path, the blog's
filters, the build and a `content_version` that every publish bumps: an edit shows on the next request.

## Publishing

Payload saves a document in its own database; then its `afterChange` hook copies the published version to the
site (`poc/payload/src/site/publishing.ts` → `worker/site/publisher.ts`, `worker/blog/payload-publisher.ts`).
The two databases can't share a transaction, so:

| Step                | What it does                                                                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Check before saving | `beforeChange` runs the publisher in `check` mode: every refusal a publish would give, nothing written. A publish that can't work isn't saved.               |
| Copy, with retries  | The write is idempotent and tried three times (`worker/site/settle.ts`). A failure tells the editor plainly.                                                 |
| Settle              | After writing, the document is read again; if it changed meanwhile the copy is redone, so overlapping saves end on the latest version.                       |
| Compare             | `worker/site/sync-check.ts` compares Payload's published documents with the site, from the two databases alone: every 15 minutes, and live on the dashboard. |
| Repair              | Republish (`poc/payload/src/site/sync.ts`) runs the same code as saving for whatever differs.                                                                |

What the site stores:

| Content                  | Where in `dalyidau-production`                                                                                                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Posts                    | Table `posts` (rendered HTML, table of contents, search text, `seo`), `slug_redirects` for old addresses                                                                                       |
| Pages, projects          | Table `meta`: `page:<slug>`, `project:<slug>` (snapshots), `page-id:`/`project-id:` (which address each has), `page-redirect:`/`project-redirect:` (old addresses), `site:projects` (the list) |
| Homepage, settings, menu | `meta`: `site:home`, `site:projects-home`, `site:settings`                                                                                                                                     |
| Redirects kept by hand   | `meta`: `site:redirects`                                                                                                                                                                       |
| Draft previews           | `meta`: `preview:*` (a day), images under the private bucket prefix `preview/`                                                                                                                 |
| Sync status              | `meta`: `site:sync-check`, `site:sync-status`                                                                                                                                                  |

Old addresses belong to the item, not the address: unpublishing keeps them (they answer 404 until it's back),
and only deleting the item for good releases them.

## Data

- **Payload's database** has a table per collection and global, their version tables, and Payload's own. Its
  schema changes only through Payload migrations (`poc/payload/src/migrations`), which are additive and
  rehearsed on a backup ([PAYLOAD-BACKUP.md](PAYLOAD-BACKUP.md)).
- **The site's database** (`migrations/`, [DATABASE.md](DATABASE.md)) holds the published copies above, the
  feature switches, and every wedding table. Migrations are forward-only and applied by the deploy.
- Articles published before Payload (from Capacities and Amplenote) live in `posts` as stored HTML and are never
  re-rendered ([CAPACITIES_RETIREMENT.md](CAPACITIES_RETIREMENT.md)).

## Security

- **Sign-in is Cloudflare Access.** Every private route verifies the Access token (signature, issuer, audience,
  expiry) and the person's role in the Worker itself, and fails closed. Payload has no passwords of its own.
- **Only owners and admins edit the website**; only owners delete for good.
- **Nothing unpublished reaches the site's database**, so no public route can return it. Previews are private,
  uncached and `noindex`.
- **All content is escaped** when rendered; links are limited to http(s), mailto and paths on this site; only
  five image types are accepted, checked by content and structure; a redirect can only lead to http(s).
- **Writes from another site are refused** before Payload sees them (`Origin` / `Sec-Fetch-Site`).
- **Headers:** a strict Content-Security-Policy with no inline scripts, HSTS, `nosniff`, no framing, a
  restrictive Permissions-Policy.
- The findings register and what each phase fixed: [AUDIT-2026-11.md](AUDIT-2026-11.md).

## Front end

- **Design system:** Untitled UI React (PRO) on React Aria and Tailwind CSS v4, with the Daly brand over it for
  the projects-first design (`.site-v2` in `src/styles/globals.css`: navy, vermilion, Space Grotesk headings).
- **Three browser bundles**, so the public site never carries admin or wedding code: the site (`shell.html`), the
  wedding, and the planner. `npm run check:bundle` enforces the site's budget.
- **Light and dark**, following the device unless the visitor chooses; no flash on load (`public/theme-init.js`).
- **Images:** `srcset` of the site's own smaller copies, width and height set, lazy below the fold.
- **Fonts:** self-hosted, the two used above the fold preloaded.
- **Accessibility:** WCAG 2.2 AA, checked by axe in both designs, light and dark, phone and desktop, with
  keyboard and no-overflow checks (`e2e/site-accessibility.spec.ts`).

## Tests

| Suite                                                            | Covers                                                                                 |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `npm test`                                                       | The Worker in workerd with local D1/R2: publishing, routes, security, the wedding.     |
| `npx vitest run --config poc/payload/test-platform/…`            | The same suite through the combined router, plus platform and security tests.          |
| `poc/payload/e2e-platform/*.mjs`                                 | Real Payload: publishing end to end, the authorisation matrix, the admin in a browser. |
| `npm run test:e2e`, `playwright.admin.config.ts`                 | The public site and the wedding screens in a browser, with axe.                        |
| `npm run test:backup`, `scripts/payload-migration-rehearsal.mjs` | Backups restore; a migration leaves every existing row intact.                         |
