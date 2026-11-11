# Phase 2 (website in Payload): work log

Directive: owner, 11 Nov 2026 (one daly.id.au managed in Payload; standing approval for reversible, verified deploys). Plan: `docs/PAYLOAD-FRONTEND-PLAN.md`. Resume: `docs/PAYLOAD-NEXT.md`.

## 11 Nov 2026

### Audit and decision (~08:20Z)

- Production `e50ef215` (#50, `417d9f7`). One combined Worker: Payload/Next.js at `/admin` and `/api/<collection>`, the existing renderer for everything else.
- Hard-coded site content found in `src/content/site.ts`, `src/content/about.ts`, `src/pages/home.tsx` and `contact.tsx`. The Payload `pages` collection was a placeholder that nothing rendered.
- **Decision:** don't move the public pages into Next.js. A cold Payload start costs about 3 s of CPU; the public renderer answers from the edge cache or in milliseconds. Payload instead **publishes** the site's content into D1 snapshots (`meta` table: `site:settings`, `site:home`, `page:<slug>`, `page-redirect:<old>`, `page-id:<id>`), the pattern the blog already uses, and bumps `content_version` (the edge-cache key). Reasons are in the plan, §2.
- Wedding: `daly.id.au/wedding` 301'd to the wedding host. The path mode (`legacyPaths`) already existed; the client calls its API by relative path; `checkMutation` accepts same-origin posts; the wedding app sets no cookies; all generated links (email, PDF, invitation) use `WEDDING_URL`.

### Baseline (~08:30Z)

- `scripts/visual-baseline.mjs` (new): 6 public pages × desktop 1440 / phone 390 × light / dark = 24 full-page screenshots. Two captures of production compared **identical** (stable baseline), kept locally in `output/visual/prod-before`.

### Build (08:35–09:40Z)

- `src/shared/site-content.ts`: types, the built-in defaults (exactly today's text), validation (`normaliseSite/Home/Page`, field by field fallback), reserved addresses.
- Renderer: settings reach components through a React context (`src/providers/site-content.tsx`) filled from the page data, so server and hydration agree. Header, footer, logo, home, contact, blog index/post read it. `/about` is now a generic CMS page (`CmsPage`, the About layout). New route `/<slug>` for published pages, after every application route; `RESERVED_SLUGS` checked again in the router.
- `worker/site/content.ts` (loader, one D1 read, fail-safe) and `worker/site/publisher.ts` (validation, Lexical through the existing escaping `renderLexical`, images copied by content hash with `storePublicImage`, renames redirect, unpublish removes redirects).
- `seo.ts`: titles, descriptions, OG image, JSON-LD and the feed use the published settings; the sitemap lists published pages (no `lastmod`, so it stays byte-stable).
- Payload: globals **Site settings**, **Navigation**, **Homepage** (drafts), collection **Pages** rewritten (drafts, versions, Trash, featured image, SEO, buttons option, reserved/duplicate address refusal with a 400). All in a "Website" group with Blog posts and Media. Read and write: owners and admins; permanent delete: owners.
- Migrations: `20261111_084356_site_content` (schema, **additive only**: new tables, new nullable columns) and `20261111_090000_site_seed` (data: the current text into the globals and an About page, published; leaves anything already saved alone; `down` removes only the snapshots).
- Wedding: `daly.id.au/wedding*` now serves the same wedding app by path; canonical always `https://wedding.daly.id.au/…`. Tests updated from "301" to "served, same rules".

### Verification (local, 09:00–09:50Z)

- Root suite **472/472** + MCP 18/18 (one earlier full run had 3 load timeouts; those files pass alone, 69/69). New `test/site-content.test.ts` 9/9.
- Platform suite through the combined router **500/500**.
- Real Payload (`wrangler dev`, fresh state, CI order): **`e2e-platform/site.mjs` all passed** (new: seed keeps every public page the same; drafts private; publish shows on the next request; escaping; unsafe links/emails refused; reserved and duplicate addresses refused; menu follows publish/rename/unpublish; editor/viewer refused; no identity → 401), **`blog.mjs` all passed**, **authz matrix all passed** (now also every global × role).
- Browser checks (wedding screens in Payload) **45/45**. Admin screenshots of Homepage, Navigation, Site settings, Pages: render, no page errors.
- **Visual:** the old code and the new code on identical local data (production's posts and images from the 07:23Z backup): **24/24 screenshots identical** (one lazy-image timing difference on a re-capture, layout identical). After the Payload seed (real combined Worker): About and Contact **8/8 identical**. Found and fixed on the way: a 16 px gap above the About text (the typography plugin's first-child rule outranked an arbitrary variant by cascade layer; fixed with two plain rules in `article.css`).
- Found and fixed: creating a second page at an existing address returned 500 (unique index) → now a 400 with a message, for drafts too.
