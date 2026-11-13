# Wedding Planner (the phone app)

Wedding Planner is the installable phone app for the wedding, at **`daly.id.au/portal/planner`**. It was retired with the portal on 11 Nov 2026 (Phase 3) and restored on 13 Nov 2026 as the phone companion to the Payload admin: Payload at `daly.id.au/admin` is still the only administration, and the app is a quicker front end over the same wedding API (`/api/portal/*`, `worker/portal`), so sign-in, roles, validation and the audit log are the admin's.

## What it does

Home, Guests, Tasks, Budget and More tabs in a single column of cards, with a bottom tab bar on a phone and a side rail on a wider screen (`src/planner`). More holds Seating, Timeline and Suppliers, and links into the wedding admin for what's best done on a bigger screen (households, imports, invitations, communications, the website, settings). Each view has its own address, so the back button, reloads and the manifest's shortcuts work.

## How it's served (`worker/index.ts` `portalPage` → `plannerPage`, `worker/planner/pwa.ts`)

- `/portal/planner` and `/portal/planner/{guests,tasks,budget,more,seating,timeline,suppliers}`: the app (`shell-planner.html`, `src/entry-planner.tsx`). Behind Cloudflare Access's existing `/portal` destination and the portal's own `authenticate()`; people without the wedding application get a 404. `no-store`, `noindex`.
- `/portal/planner/manifest.webmanifest`, `/portal/planner/sw.js`, `/portal/planner/offline`: installable as "Wedding Planner". The service worker never stores pages, API responses or media: pages always come from the network, and only when the network fails does it show the static offline page. It caches only the offline page, its stylesheet, the icons and hashed build files, in a cache named after the shell's version (`planner-<version>`).
- `/portal/sw.js`: still the retiring worker for the first release's portal-wide service worker. It only deletes the old `wedding-planner-` caches, never the app's `planner-` cache.
- Links to the app: "Phone app" in Payload's Wedding menu and "Open the phone app" on the admin's home (`poc/payload/src/views`).

No Cloudflare change was needed: `/portal` and `/api/portal` were already Access destinations.

## `weddingplanner.daly.id.au`

The app's first host never got its own Cloudflare Access destination, so nothing private is served there: pages `302` to the same view at `daly.id.au/portal/planner` (behind Access), `/sw.js` is the retiring worker so old installs from that host remove themselves, and any API answers `404`.

**Proposed for the owner (needs approval, changes routes and DNS):** remove the `weddingplanner.daly.id.au` route from `wrangler.jsonc` and `poc/payload/wrangler.jsonc` and delete its DNS record, once old installs have had time to unregister.

## Tests

`test/wedding-app.test.ts` (Worker: views, sign-in, manifest, service worker, offline page, the old host) and `e2e/wedding-app.spec.ts` (Playwright, desktop and Pixel 7: views fit the screen and pass axe, add and tick off a task, record an RSVP, install, offline page, the service worker's fetch handling).
