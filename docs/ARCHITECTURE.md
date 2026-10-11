# Architecture

## The short version

One Cloudflare Worker (`dalyidau`) does everything:

- **Serves the site.** Each page is server-rendered with React (`react-dom/server`) inside the Worker, so articles arrive as complete HTML. The browser then hydrates the same React tree for the interactive bits (theme toggle, mobile menu, copy-link button, active table-of-contents highlighting). Static files (JS, CSS, fonts, icons) come straight from Workers static assets without invoking the Worker.
- **Syncs from Capacities.** A Cron Trigger runs every 15 minutes, reads Blog Post objects through the Capacities API, and writes published articles to D1 and their images to R2.

There is no separate CMS, database server or build step for content. A new post never needs a Git commit or deploy.

## Why this shape

| Decision | Reason |
| --- | --- |
| Vite + React, server-rendered in the Worker | Untitled UI React is a client component library; rendering it in the Worker gives crawlable HTML without adopting a heavier framework. Rendering takes roughly 1–1.5 ms of CPU per page. |
| Plain links, no client-side router | Every navigation is a fresh server render served from the edge cache. Simpler, works without JavaScript, and nothing breaks on refresh. |
| D1 for articles | Small, relational, free tier is generous, and search/filtering are just SQL. |
| R2 for images | Capacities file URLs are signed and expire, so images have to be copied somewhere stable. R2 is free up to 10 GB. |
| Cron polling instead of webhooks | The Capacities API (v1.0.0) has no webhooks or change events. See [CAPACITIES.md](CAPACITIES.md). |
| Article HTML rendered at sync time | Pages only read a stored HTML string. The renderer is a typed AST walk that escapes every string, so there is no HTML sanitiser to keep up to date. |

## Request flow

1. Static assets (`/assets/*`, icons, `theme-init.js`) are served by the asset layer.
2. Everything else hits `worker/index.ts`:
   - `www.daly.id.au/*` → 301 to the apex.
   - `/robots.txt`, `/sitemap.xml`, `/feed.xml` are generated from D1.
   - `/media/<hash>.<ext>` streams from R2 with a one-year immutable cache.
   - `/api/health` is public; `/api/admin/*` needs the `ADMIN_TOKEN` bearer token.
   - Pages: route → query D1 → `render()` → inject into `shell.html` with meta tags and JSON-LD.
3. Successful HTML on the production host is kept in the Cloudflare edge cache. The cache key includes the build hash and a `content_version` that every sync with changes bumps, so new and edited posts appear immediately.

## Sync flow (`worker/sync.ts`)

1. `GET /space/structures`: find the Blog Post type and its properties. If the type, its Status property or the "Published" option can't be found, the run stops and **nothing changes**.
2. `GET /objects/structure` (paged): list every Blog Post id. If any page fails, deletion detection is skipped for this run.
3. Phase A, classify: fetch objects (never-seen first, then least recently checked) and decide published / not published / unreadable.
4. Phase B, render: for published objects, resolve images, tags, web links and tables (cached in D1), render HTML, and upsert if the content hash changed.
5. Unpublishing happens when an object's Status is anything but Published, when it moves to another type, or when it is missing from **two consecutive complete listings**.
6. The run is recorded in `sync_runs` and logged as JSON to Workers Logs.

The canonical identity of an article is its Capacities object id. Slugs can change; the old slug is kept in `slug_redirects` and answers with a 301.

## Data model (D1)

| Table | Contents |
| --- | --- |
| `posts` | Published articles only: metadata, rendered HTML, TOC, search text |
| `sources` | Every Blog Post id seen, last status label, last check, error. No content. |
| `slug_redirects` | Old slug → post id |
| `media` | Capacities media id → R2 key, type, dimensions, alt text |
| `entity_cache` | Titles/URLs of tags, web links and tables (refreshed weekly) |
| `sync_runs` | One row per run with counts and log lines (last 500 kept) |
| `meta` | `content_version` for cache invalidation |

## Security model

- The Capacities token and admin token are Worker secrets. They are never sent to the browser or logged. The token is only sent to `api.capacities.io`; signed file downloads go out without it.
- Only objects of the configured type whose single-select Status is exactly the "Published" option are ever written to `posts`. An unreadable status is an error, never a publish.
- References in an article to other Capacities objects are dropped unless they are images, web links/tweets, simple tables or other **published** blog posts. Inline links to private notes keep their text but lose the link.
- All article text is escaped; links are limited to `http`, `https` and `mailto`; SVG uploads are not served (script risk).
- Strict CSP (`script-src 'self'`, no inline scripts), HSTS, `nosniff`, `frame-ancestors 'none'` and a restrictive Permissions-Policy on every response.
- No public endpoint returns unpublished data. `/api/health` reports only the time and status of the last sync.

## Design system

The UI uses Untitled UI React components from the official Vite starter kit (`npx untitledui init --vite`): Button, ButtonUtility, Badge, BadgeWithDot, Input, Tooltip, FeaturedIcon, background patterns, social icons and the theme tokens and typography. The header is adapted from the kit's marketing header.

Untitled UI PRO sections were added with `npx untitledui@latest add` and adapted to the site's content, data and CSP. They live in `src/components/marketing/` and `src/components/application/`:

| PRO component | Used for |
| --- | --- |
| `hero-simple-text-01` | Homepage hero |
| `blog-section-simple-left-aligned-01` and its blog card (`Simple01Vertical`) | Homepage "Latest writing" and every post card |
| `features-simple-icons-01` (`FeatureTextFeaturedIconTopLeft`) | Homepage "What I write about" |
| `content-section-simple-01` | About page |
| `footer-small-01` | Site footer |
| `empty-state` | Empty and no-results states |

Each file notes what was changed from the original. In short: demo content and stock photos were replaced with site data; remote pattern images were swapped for the local SVG patterns (the CSP only allows same-origin images); and unused variants (file-type icons, illustrations, the grid-check pattern) were removed to keep the client bundle small. The empty state uses a `div` and an `h2` instead of `main` and `h1` because it renders inside the page's own `main`.
