# Phase 2: one daly.id.au, managed in Payload. Audit and plan

Directive: owner, 11 Nov 2026. Goal: the owner manages the homepage, pages, navigation, site settings, blog, images and wedding information at `daly.id.au/admin`. Changes appear on the public site without code edits or deploys, and the design stays as it is.

## 1. Audit (11 Nov 2026, production `e50ef215`, commit `4d67319`)

| Area | How it works today |
|---|---|
| Deployable | One Worker, `dalyidau`, built from `poc/payload` (`platform/entry.ts`). `platform/hosts.ts` routes each request either to Payload (Next.js 16 through OpenNext: `/admin`, `/_next/*`, `/api/<payload collection>`) or to the existing Worker (`worker/index.ts`: everything else). CI deploys it from main (`.github/workflows/deploy.yml`). |
| Homepage, about, contact | Server-rendered React (`src/entry-server.tsx`, `src/app.tsx`, `src/pages/*`), hydrated in the browser. **Copy is hard-coded**: `src/content/site.ts` (name, descriptions, email, socials, nav), `src/content/about.ts`, and literal text in `src/pages/home.tsx` and `contact.tsx`. |
| Blog | Payload `posts` collection (drafts, versions, Trash) publishes into D1 `posts` through `worker/blog/payload-publisher.ts` (Lexical → escaped HTML). The public pages, feed, sitemap and SEO come from `worker/posts.ts` and `worker/seo.ts`. |
| Caching | `cachedPage` edge-caches public HTML. The key includes the build and `meta.content_version`, which every publish bumps, so a change shows straight away. |
| Static pages | Only `/about` and `/contact`, as code. Payload has a placeholder `pages` collection that nothing renders. |
| Media | Blog images: public R2 `dalyidau-media`, served at `/media/<hash>.<ext>`. Payload uploads: private R2 `dalyidau-payload-media`; the publisher copies what a post uses into the public bucket. |
| RSS, sitemap, robots, SEO | `worker/seo.ts` (`buildHead`, `sitemapXml`, `rssXml`, `robotsTxt`), all reading `src/content/site.ts`. |
| Domains | `daly.id.au`, `www` (301 to apex), `wedding.daly.id.au`, `weddingplanner.daly.id.au`, all custom domains on the one Worker; `workers_dev: false`. |
| Payload | Collections `users` (Access identity, no passwords), `media`, `pages` (placeholder), `posts`; no globals. Wedding admin is a custom Payload view at `/admin/wedding/*` (`src/views`), backed by the portal's wedding API. |
| Wedding | `wedding.daly.id.au` (`weddingHost`): home, `/rsvp`, guest pages (`/invitation`, `.pdf`, `/save-the-date`, `.ics`), `/wedding/media/*` photos, `/api/wedding/rsvp/*`. On `daly.id.au`, `/wedding` and `/wedding/rsvp` **301 to the wedding host** (query kept: signed links). `weddingPage` already has a path mode (`legacyPaths`), used when the wedding has no host of its own. RSVP POSTs pass `checkMutation` (same origin or SITE_URL). The wedding app sets no cookies; the signed link is the credential. |
| Access | Application `daly.id.au` protects `/portal`, `/api/portal` and 13 Payload paths. The combined Worker also checks the Access JWT and portal role before Payload sees a request (`compose.ts`). |
| Legacy, retirable | Capacities sync and renderer (switched off, kept while its articles exist), Amplenote leftovers (retired), `/portal/wedding` (still the wedding admin's home), the Payload template's `(frontend)` page (unreachable: `/` never routes to Payload). |

## 2. Architecture decision: keep the combined Worker; Payload publishes the site content

The directive asks for a single Next.js + Payload application, but also for no performance regression and no unnecessary complexity. The combined Worker already **is** one application: one repo, one build, one deploy, one CI pipeline, shared D1/R2/Access. What's left is whether the public pages should also be rendered by Next.js.

**Decision: no.** The public pages keep the existing server renderer. Payload becomes the source of every piece of content on them, using the pattern the blog already proves.

Reasons:

- **Performance.** A cold Payload/Next.js start costs about 3 s of CPU in this Worker (measured in Phase 0; it's why the cron avoids starting Payload). The current public renderer answers from the edge cache, or renders in milliseconds with one D1 read. Moving `/` and `/blog` into Next.js would make the first visitor after every isolate start wait for Payload: a regression the directive rules out.
- **Design preservation.** The current pages are React components (Untitled UI, Tailwind 4, React 19.3) with hydration. Rendering them inside Next.js would mean a second React copy, a second CSS pipeline and a hydration rewrite, with real risk of visual drift and no visible benefit.
- **Safety.** Public pages never start Payload, so a Payload bug or a Payload outage can't take the public site down.

How it works:

```
Payload admin (/admin) ── save/publish ──► hooks ──► site publisher (worker/site/publisher.ts)
                                                     writes snapshots to D1 `meta` (site:settings, site:home, page:<slug>)
                                                     and bumps meta.content_version (edge cache key)
Public request ──► existing renderer ──► worker/site/content.ts reads the snapshots (one query)
                                          └─ missing or invalid → today's built-in content (fail-safe)
```

- Snapshots are validated and every string is escaped at render time (React) or rendered from Lexical by the existing escaping renderer (`renderLexical`). No raw HTML from Payload reaches the page.
- Ordinary content changes need no code and no deploy: Payload writes the snapshot, the cache key changes, the next request renders it.

## 3. What is reused, adapted or rebuilt

| Reused unchanged | Adapted | Rebuilt / new |
|---|---|---|
| Combined Worker, routing, Access, CI, backups, monitor | `src/content/site.ts` → defaults in `src/shared/site-content.ts`, delivered with the page data (React context) | Payload globals: **Site settings**, **Navigation**, **Homepage** |
| Blog collection and publisher, feeds, post pages | Header, footer, logo, home, about, contact, blog index read content from the page data | Payload **Pages** collection (rich text, featured image, SEO, drafts, reserved slugs) |
| `renderLexical` (escaping Lexical renderer) | `seo.ts` takes the site settings; sitemap lists CMS pages | `worker/site/{content,publisher}.ts`; generic CMS page template (the About page's layout) |
| Wedding app, RSVP, guest pages, wedding admin view | `/wedding` on `daly.id.au` serves the wedding site (path mode) instead of redirecting | Seed migration: today's copy into the globals and an About page |

## 4. Content model

- **Site settings** (global): site name, short name (logo), title, description, blog title and description, contact email, social links (kind, label, URL), default SEO image, footer text, contact page heading and intro.
- **Navigation** (global): ordered items, each a label plus either a Pages link or a URL. The Wedding item is added automatically while the wedding site is public (wedding module).
- **Homepage** (global, drafts): eyebrow, heading and its emphasised ending, introduction, call to action, latest-posts heading and count, the "about this place" heading and paragraphs, SEO title/description.
- **Pages** (collection, drafts, versions): title, slug, lede, rich text, featured image, "show blog/contact buttons", SEO title/description. Published pages answer at `daly.id.au/<slug>`. Slugs that belong to the application are refused: `admin, api, blog, wedding, portal, media, contact, feed.xml, rss.xml, sitemap.xml, robots.txt, _next, assets, icons, cms, poc, rsvp, invitation, save-the-date, planner, cdn-cgi`, and anything not made of lower-case letters, numbers and hyphens. A renamed page keeps redirecting from its old address.
- **Blog** (`posts`): unchanged.

## 5. Wedding at both addresses

- `wedding.daly.id.au`: unchanged.
- `daly.id.au/wedding`, `/wedding/rsvp`, `/wedding/invitation`…: the same code in path mode (`legacyPaths`). The same data and the same RSVP API (`/api/wedding/rsvp/*` is already routed on both hosts; `checkMutation` accepts same-origin posts).
- Canonical URLs always point to `wedding.daly.id.au` (`/wedding` → `/`, `/wedding/rsvp` → `/rsvp`), so nothing is indexed twice.
- Signed links keep their current rules: never cached, never indexed, no referrer.
- The wedding host is not redirected.

## 6. Keeping the wedding removable

The wedding module stays in `src/wedding`, `worker/wedding`, `worker/portal` (wedding API), `src/planner`, `worker/planner` and `poc/payload/src/views` (admin). The permanent site depends on it in exactly two places: the router's `/wedding` branch (`worker/index.ts`) and the automatic Wedding navigation item. Retiring it means removing those two lines and the views (see `docs/PAYLOAD-NEXT.md`). The new site content code doesn't import anything from the wedding.

## 7. Safety

Before any production change: D1 and R2 backups, restore test, public baseline, wedding fingerprint, both articles saved, CI green, rollback target recorded. 0032/0033 stay in `docs/pending`. No new Cloudflare resources or paid services: the snapshots live in the existing `meta` table, so no D1 migration is needed. Payload adds tables for the new globals and page fields through its own migrations in `dalyidau-payload` (additive).

## 8. Order of work

1. Site content model and fail-safe loader, renderer reading from it (no visual change).
2. Payload globals, Pages, publisher hooks, seed migration.
3. CMS pages route, sitemap, redirects, reserved slugs.
4. `/wedding` on `daly.id.au`.
5. Tests (unit, Worker integration, real-Payload e2e), screenshot comparison, PR, CI, deploy, live verification.
6. Cleanup plan.

## 9. Retiring the wedding later (checklist)

When the wedding is over:

1. Archive: `npm run db:backup -- --env production`, `node scripts/r2-bucket-backup.mjs dalyidau-media`, and export the guest list from Wedding Planner.
2. Switch `wedding.site.public`, `rsvp.native` and the email/SMS switches off in Portal settings → Features. The public wedding pages then answer 404 on both addresses, and the automatic Wedding menu item disappears.
3. Code, when you're ready (one PR): the `/wedding` branch and `weddingHost`/`plannerHost` in `worker/index.ts`; `src/wedding`, `worker/wedding`, `src/planner`, `worker/planner`; the wedding view in `poc/payload/src/views` and its `admin.components` entries in `payload.config.ts`; the wedding routes in `worker/portal/api.ts`; the `wedding.daly.id.au` and `weddingplanner.daly.id.au` routes (owner approval: they're `routes` changes).
4. The wedding tables stay in D1 (and backups) until you approve dropping them in writing, as with 0032/0033.

The site content code (`src/shared/site-content.ts`, `worker/site/`, the Website globals and Pages) imports nothing from the wedding, so none of this touches it.

## 10. Legacy cleanup plan (after the website is live and verified)

| Candidate | Status | Action |
|---|---|---|
| `src/content/site.ts` (now a re-export of the defaults) | Used by the portal sidebar and Worker error pages | Point those at `src/shared/site-content.ts`, then delete |
| `src/components/marketing/features/features-simple-icons-01.tsx` and `topics` | Imported nowhere | Delete |
| Payload template page `poc/payload/src/app/(frontend)` | Unreachable (`/` never routes to Payload) | Delete with its styles |
| `/poc/*` and `/cms` prefixes in `platform/hosts.ts` | Phase 0 experiments | Remove the prefixes and their tests |
| Capacities sync (`worker/sync.ts`, `worker/capacities/*`, mock API, its tests) | Switched off; `render.ts` must stay while Capacities-era HTML exists | Keep `render.ts` and `capacities_archive`; retire the sync and the switch in a separate PR (needs the owner: it removes a publisher) |
| Amplenote leftovers | Retired 9 Nov; `posts.source = 'amplenote'` rows stay | Nothing to delete beyond code already gone |
| `/portal/wedding` dashboard | Still the wedding admin's home (CLAUDE.md) | Keep until the owner prefers `/admin/wedding` |
| `site.ts` constants in `worker/index.ts` (portal titles) | Use the defaults | Fine as is |
| Unused secrets (`CAPACITIES_*` etc.) | Kept on purpose | Only with the owner's approval |

Nothing in this table deletes content, data, backups or secrets.
