
### CI and deploy (09:05–09:30Z)

- PR #51. First CI run failed only the client bundle guard (`globals.css` scanned `src/content` instead of `src/shared/site-content.ts`). Fixed. Then CI ✓ and Payload ✓ (now including `site.mjs`) on `9350d5a`.
- **Before deploy:**
  - D1 `dalyidau-production` backup `backups/production-2026-11-11T09-01-37-480Z.sql`, integrity checks "No problems" (guests 73, households 29, posts 2).
  - D1 `dalyidau-payload` export `backups/payload-production-2026-11-11T09-05-07Z.sql`, restored locally, counts identical (posts 3, media 1, users 1, pages 0, migrations 5).
  - R2 `dalyidau-media` 96 objects verified; `dalyidau-payload-media` 1 object verified.
  - Public baseline `backups/public-before-phase2`, wedding fingerprint `backups/wedding-before-phase2.json`, 24 production screenshots (two identical captures).
  - Rollback target **`e50ef215-da68-4544-8ad3-c9a3e902f5fd`**.
- Merged #51 → `67d2f47`. Deploy run 42994355904 ✓ (tests, platform, real-Payload e2e, deploy, smoke). **Production version `b13e3104-5275-48ca-a2ce-146879903a64`.**

### Production verification (09:30–09:55Z)

- **Before Payload started:** public baseline **27/27 unchanged**; wedding **24/24 tables identical**; screenshots identical (one lazy-image timing difference, layout identical).
- `daly.id.au/wedding` and `/wedding/rsvp` 200, canonical `https://wedding.daly.id.au/` and `/rsvp`. A signed-link request at `/wedding/rsvp?invite=…` gets `no-store`, `no-referrer`, `noindex, nofollow`. `wedding.daly.id.au` is unchanged.
- **Payload started** (the owner's signed-in Chrome opened `/admin/globals/homepage`). Migrations `…site_content` and `…site_seed` ran. D1 `meta` now has `site:settings`, `site:home`, `page:about`, `page-id:1`, `site:pages-managed`. The Homepage shows "Published" with today's text.
- **After the seed:** **24/24 screenshots identical** to the pre-deploy baseline. Wedding 24/24 identical. Articles byte-identical. The public baseline changed only `/about`'s text hash. Cause: apostrophes are now encoded `&#39;` instead of `&#x27;` (8 apostrophes, 8 characters). The visible text and the pixels are the same.
- **Live edit check in production** (as the owner, through Payload's API from the admin tab):
  - create a draft page "Payload live check (safe to delete)" → `/payload-live-check` 404;
  - publish → 200, text escaped, in the sitemap; no deploy;
  - a page at `blog` → 400;
  - unpublish → 404;
  - moved to Trash (id 2, restorable).
- **Rollback rehearsal in production:** `wrangler rollback e50ef215` took **4 s**. The old version served the pre-change site exactly (27/27 identical to the original baseline): the snapshots are inert to it. Rolled forward to `b13e3104`. After propagation (under a minute), 30/30 URLs matched the post-seed baseline and the wedding was 24/24 identical.
- **Performance:**
  - Client JS 138.37 KB gzip (was 138.69). CSS 23.99 KB gzip (was 23.95).
  - Time to first byte about 90–110 ms on `/`, `/about`, `/blog`, an article and `/contact` (edge cache).
  - On a cache miss: one extra indexed D1 read (`meta`). Payload is never started by a public page.
- Monitor and baseline now also check `/api/globals/*`, `/admin/globals/homepage` (302 to Access ✓), `daly.id.au/about` and `daly.id.au/wedding`.

### Left in production on purpose

- The test page "Payload live check (safe to delete)" is in Payload's Trash. Delete it permanently whenever you like (owners only).
- From Phase 1: the verification pixel in Payload media and the verification draft post in Trash.
