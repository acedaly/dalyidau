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

# Phase 3 (owner directive 11 Nov 2026, ~09:35Z: fix wedding publishing, retire the portal)

## 09:35–10:15Z: wedding publishing defect, root cause and fix (#53, production `d982daf3`)

- **Reproduced in production** with the owner's signed-in Chrome on `daly.id.au/admin/wedding/website`. A real mouse click on "Publish changes" opened no dialog and sent no request. The same for "Save draft". Text fields worked, so editing looked fine but nothing ever saved or published.
- **Ruled out:**
  - the API (`PUT /api/portal/settings/website_draft` and `POST …/website/publish` both 200 from the same tab, data persisted);
  - permissions (owner has `wedding.website.edit`);
  - Access and routing;
  - caching (the public pages read the published setting on each request);
  - hostnames (both addresses read the same row).
- **Root cause:** inside Payload the wedding screens render in a shadow root, for style isolation. React Aria decides a press from pointer events it watches on the document, and across a shadow boundary those events are retargeted to the host element. So every press counted as "released outside the button" and was cancelled. This affected every button in every embedded wedding screen. A synthetic `element.click()` worked (a different code path), which is why the CI browser check never saw it.
- **Second fault found on the way:** Publish called "save draft" first but ignored a failed save (`useSubmit` swallows errors). It then republished the previous draft and said "Changes published".
- **Fix:** `enableShadowDOM()` (React Aria's shadow DOM mode, `react-stately/private/flags/flags`) in `poc/payload/src/views/wedding-screen.tsx`; Publish stops if the save fails. New real-click test `e2e-platform/wedding-publish.mjs` (Payload workflow).
- **Verified in production (10:05–10:12Z), real mouse, non-sensitive test text:**
  - set the small heading to "Together with our families (publishing test)" → dialog opened, PUT 200, POST publish 200, toast;
  - `wedding.daly.id.au/` and `daly.id.au/wedding` both served the new text, no sign-in;
  - saved a draft "(draft only)": absent from both addresses;
  - restored "Together with our families" and published: both addresses back to the original.
  - Public baseline 30/30 unchanged. Wedding tables identical except `audit_log` +5 (the test's own saves and publishes).

## 10:15Z onwards: retiring the portal (branch `feature/retire-portal`)

- Dependency map: `docs/PAYLOAD-PORTAL-RETIREMENT.md`.
- New **Administration** section in Payload (`/admin/administration/*`): General, Users and permissions, Features, Integrations and security, Privacy, Capacities archive, Audit log. The same components and loader as the portal, with the same per-section permission checks.
- Menu groups: Website · Blog and Media · Wedding · Wedding Planning · Administration. Payload's Users collection is hidden, since people are managed in Users and permissions.
- `/portal/*` pages redirect to Payload. The draft preview stays. Retired apps keep a plain 410. The planner (phone app and its host) is retired.
- **Found and fixed a second shadow-root bug:** a dialog opened over another (the "Delete guest?" confirmation over the guest panel) was `inert`, so visible but unclickable. React Aria's shadow DOM mode pauses only the first dialog's document observer, not its shadow-root observer, and that observer inerts the new dialog. Workaround: overlays added to the screen's container are marked `data-react-aria-top-layer` by an observer registered first.
- Wording updated (Portal settings → Administration, "the portal" → "the admin"). The settings page's own theme toggle was removed (appearance follows Payload). Page headers are no longer `<header>` landmarks (Payload has the banner). Tab URLs point at `/admin/…`.
- **Tests:**
  - root 463/463, MCP 18/18, public e2e 24/24;
  - platform suite (updated: planner host redirect, bridge query, strict link mapping, Administration routes);
  - the four wedding/administration browser specs moved into Payload (`playwright.admin.config.ts`, desktop and mobile, axe scoped to the screen): 40/40.
