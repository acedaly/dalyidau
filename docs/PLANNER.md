# Wedding Planner (retired 11 Nov 2026)

Wedding Planner was the installable phone app at `weddingplanner.daly.id.au` and `daly.id.au/portal/planner`. It was retired in Phase 3 of the Payload work (`docs/PAYLOAD-NEXT.md`): Payload at `daly.id.au/admin` is the only administration, and its wedding screens work on a phone.

What answers now (`worker/index.ts` `plannerHost`, `portalPage`):

- Pages at either address: a `302` to `https://daly.id.au/admin/wedding` (behind Cloudflare Access), `no-store`, `noindex`.
- `/sw.js` and `/portal/planner/sw.js`: a service worker that deletes the app's caches and unregisters itself, so installed copies stop working cleanly (`worker/planner/pwa.ts`).
- Any API on `weddingplanner.daly.id.au`: `404`. The wedding API is only reachable on `daly.id.au`, behind Access.

The hostname never got its Cloudflare Access destination, so it is a management address without a sign-in in front of it. Nothing private is served there now.

**Proposed for the owner (needs approval, changes routes and DNS):** remove the `weddingplanner.daly.id.au` route from `wrangler.jsonc` and `poc/payload/wrangler.jsonc` and delete its DNS record, after a few weeks so installed apps can unregister. Its icons in `public/icons/wedding-planner-*` can go at the same time.
