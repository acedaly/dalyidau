# Wedding Planner (the phone app)

A clean, installable app for running the wedding from a phone: **https://weddingplanner.daly.id.au**, and the same app at **https://daly.id.au/portal/planner**. It's a front end only. It reads and writes through the portal's own wedding API (`/api/portal/wedding/*`, `/api/portal/dashboard`) as the signed-in person, so roles, validation and the audit log are exactly the portal's, and it stores nothing of its own.

| Tab    | What it does                                                                                                                       |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Home   | Countdown, quick "Add a task", RSVP numbers by event, what's due, the budget, households to follow up, recent replies, seating     |
| Guests | Search and filter by RSVP; a guest's sheet has Call/Email and records their RSVP for each event; Add guest                         |
| Tasks  | Add with an optional due date; Overdue / This week / Later / No due date; tick off; open to edit title, date and notes; Done list  |
| Budget | Committed, paid, still to pay, overdue; by category; items with their payment state (read-only)                                    |
| More   | Seating (tables and who's not seated), the day's timeline, suppliers with Call/Email/Website, links into the full portal, sign out |

Anything that's better on a big screen (households and invitations, imports, seating drag-and-drop, budget and supplier editing, communications, the website) links into the full portal at `daly.id.au/portal/wedding`.

## How it's built

- **One Worker.** Served by the same `dalyidau` Worker as the portal (`plannerHost` and `plannerPage` in `worker/index.ts`), from its own Vite entry (`shell-planner.html`, `src/entry-planner.tsx`, `src/planner/`). It uses Untitled UI components and the portal's theme tokens in the calm, card-per-section layout of Daly Home: tabs at the bottom on phones, a rail from `md` up.
- **Same sign-in, same data.** Every page and API call goes through the portal's Access check (`worker/portal/auth.ts`). Page data is the portal context (person, switches, wedding details); everything else is fetched from the API. Hidden modules and missing permissions hide the matching tab.
- **Its own address is narrow.** On `PLANNER_URL` (`weddingplanner.daly.id.au`) the Worker answers only the app (`/`, `/guests`, `/tasks`, `/budget`, `/more`, `/seating`, `/timeline`, `/suppliers`), its manifest, service worker and offline page, and `/api/portal/wedding/*`, `/api/portal/dashboard` and `/api/portal/me`. Everything else is 404. Writes are accepted only from the request's own origin (`checkMutation`).
- **Installable.** Manifest at `<base>/manifest.webmanifest` (start and scope `<base>`, fetched with credentials because it's behind Access), icons in `public/icons/wedding-planner*` (`node scripts/wedding-app-icons.mjs`), and a service worker at `<base>/sw.js` (`worker/planner/pwa.ts`). `<base>` is `""` on its own address and `/portal/planner` on daly.id.au.
- **Offline.** Pages and data always come from the network. When the network fails, the service worker shows a static "You're offline" page with Try again. It caches only that page, its stylesheet, the icons and the hashed `/assets/*` files: **never a page, API response or media**, so no guest data is stored on the phone. There's no offline editing.
- **The first release's portal app is retired.** It briefly made the whole portal installable (scope `/portal`). The portal is a website again: its shell has no manifest, `/portal/sw.js` serves a worker that clears its cache and unregisters itself, and the portal's own script removes that registration.

## Cloudflare Access for weddingplanner.daly.id.au (one step, by hand)

The address is a custom domain on the Worker, but Cloudflare Access isn't in front of it until someone adds it. Until then the Worker refuses everyone there (no token means no Access) with a page pointing to `daly.id.au/portal/planner`. It fails closed: nothing is served without Access.

1. Zero Trust → **Access → Applications** → the existing **portal** application (destinations `daly.id.au/portal` and `daly.id.au/api/portal`) → **Configure**.
2. Add a destination: subdomain `weddingplanner`, domain `daly.id.au`, **path empty** (the whole host). Save.
3. Leave the policy alone: the same Allow policy now covers the new host.

That's all: no new application, AUD secret or Linked App Token policy, because the app runs on the portal's own Worker and uses the portal application's token as it is. Check by opening `https://weddingplanner.daly.id.au` (Access sign-in, then the app). To undo, remove the destination; the host goes back to refusing everyone.

## Installing it

- **iPhone:** open the address in Safari, sign in, then Share → **Add to Home Screen**. Home Screen apps keep their own sign-in, so you'll sign in once more inside the app.
- **Android:** Chrome → Install (or ⋮ → Install app).
- **Mac/PC:** the install button in Chrome or Edge's address bar, or Safari → File → Add to Dock.

Long-press the icon for shortcuts to Guests, Tasks and Budget.

## Tests

`test/wedding-app.test.ts` (both addresses, the narrow host, sign-in, manifest, service worker, retired portal worker) and `e2e/wedding-app.spec.ts` (every view at phone and desktop width with axe, adding and finishing a task, recording an RSVP, install, offline cache, and the service worker's fetch handling run in Node, because Playwright can't take a service worker's own requests offline).

## Rollback

- Code: `npx wrangler rollback <version-id> --env=""`.
- The address: remove the `weddingplanner.daly.id.au` route from `wrangler.jsonc` and deploy (the DNS record goes with it), and remove its Access destination.
