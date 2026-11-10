# Payload CMS: Phase 0 technical validation

**Date:** 10 November 2026 · **Branch:** `experiment/payload-phase0` (from `feature/wedding-pwa`, uncommitted) · **Proof of concept:** [`poc/payload/`](../poc/payload/README.md)

**Target:** Option 1b: Payload CMS 3.x on Cloudflare Workers, with the wedding administration as native Payload views and the wedding backend running in the same Worker.

**Status:** Phase 0 is complete. Phase 1 has **not** started and waits for your approval.

Nothing was deployed, created in Cloudflare, purchased or changed in production. Every run used local `wrangler dev` / workerd resources and invented data (`example.test` people, a locally generated Access signing key).

## Verdict

| # | Experiment | Result |
|---|---|---|
| 1 | Payload on Workers: bundle size, PDF generation | **Pass, with conditions.** 4.7 MiB gzipped (limit 10 MiB). PDFs work. Startup CPU is about 2.6× today's and must be measured on Cloudflare. |
| 2 | Existing wedding screens as Payload custom views, isolated styling | **Pass.** Five screens run unchanged inside Payload. Styles are isolated both ways. One Tailwind gap was found and fixed. |
| 3 | Cloudflare Access and wedding roles | **Pass.** Payload signs in only through the existing Access verifier and portal roles. Three insecure Payload defaults were found and closed. |
| 4 | Existing API router inside Payload against the wedding D1, atomic SQL | **Pass.** The existing Worker runs unchanged in-process. The whole existing test suite passes through the combined router. |
| 5 | Scheduled messaging, webhooks, outbound comms | **Pass.** The existing cron, webhooks and providers are unchanged. The cron also drives Payload's job queue. |
| 6 | Wedding site on its own hostname, admin strictly isolated | **Pass.** The hostname is decided before anything else runs. Payload is unreachable from guest hosts (tested exhaustively). |
| 7 | Payload and Next.js upgrades | **Partial.** Minor upgrades pass. The official template's pinned versions don't run. Payload 4 (beta) needs code changes, a 114-statement content migration and a CSP fix. |

**Recommendation:** proceed to Phase 1, with the conditions in [Recommendation](#recommendation). The approach works without rewriting any wedding logic. The remaining risks are operational (cold-start cost, a shared failure domain, Payload 4 timing), not feasibility risks.

## Corrections to the brief (please read first)

Some of the brief's assumptions don't match the current system. The plan below has been adjusted for each.

1. **There is no dedicated wedding D1 database.** Wedding tables live in `dalyidau-production` (binding `DB`). That database also holds the blog, portal users, audit log, feature switches, Calendar, Today, Intelligence Centre, Home & Assets, Finance and the retired Knowledge/Tasks data.
   - *Adjusted:* Payload gets its own D1 (binding `D1`). `DB` stays exactly as it is.
   - Splitting the wedding tables out is a separate, risky migration. I don't recommend it before the wedding.
2. **There is no separate wedding Worker.** One Worker, `dalyidau`, serves `daly.id.au`, `www`, `wedding.daly.id.au` and `weddingplanner.daly.id.au`.
   - *Adjusted:* "keep the wedding Worker as rollback" means keeping the previous `dalyidau` version deployable.
   - The simplest form is to deploy the combined Worker *as* `dalyidau`. Then there is no route or DNS change at all, and rollback is `wrangler rollback`. See [Phase 4](#revised-effort-estimate).
3. **The "wedding API router" is the portal router.** `handlePortalApi` also dispatches Calendar, Today, Intelligence, Centre, Home & Assets and Finance.
   - *Adjusted:* the PoC runs the whole existing Worker in-process, unchanged.
   - Extracting a standalone `wedding-core` package means splitting that router. That's real Phase 1 work, not a rename.
4. **The MCP gateway** binds to `PortalMcpEntrypoint`, which is exported from the same Worker. The combined entry re-exports it. If the combined Worker ever gets a new name, the gateway's service binding must be redeployed by hand.
5. **Production context** (from project notes):
   - The live wedding code is deployed from `feature/wedding-pwa`, which is not on `main`.
   - CI deploys are broken (rejected API token).
   - The wedding production switches (site, native RSVP, email, SMS) are on.
   - The wedding is on 23 October 2027.

## How the proof of concept works

```
request ─► platform/hosts.ts  (hostname + path decide first, for every request incl. static files)
             ├─ wedding / weddingplanner host ─► existing Worker (worker/index.ts, unchanged)
             │                                    + an allow-list of the existing build's static files
             ├─ daly.id.au  /admin, /_next, /api/<payload collection>
             │      └─ Access gate (existing authenticate()) ─► Payload (Next.js via OpenNext)
             └─ daly.id.au  everything else ─► existing Worker (portal, APIs, webhooks, blog)
scheduled ─► existing Worker's scheduled()  (all jobs, unchanged)  ─► then Payload's job runner (secret)
```

- **`platform/`** is the combined Worker entry, about 200 lines.
  - `hosts.ts`: routing rules.
  - `compose.ts`: the router, the Access gate and the cron.
  - `bridge.ts`: page data for the wedding views, served by the existing `loadPortalPage`.
- **`src/auth/access-strategy.ts`** is a Payload auth strategy that calls the existing `authenticate()`. Payload passwords, its login form and API keys are disabled.
- **`src/views/`** renders the existing `GuestsPage`, `HouseholdsPage`, `RsvpsPage`, `SeatingPage` and `DashboardPage` components, unmodified, inside a Shadow DOM in Payload's admin.
- **Not changed:** not one line under `worker/`, `src/` or `migrations/`. The existing Worker is imported as-is.

## Results

### 1. Payload on Workers: bundle size and PDF generation: pass, with conditions

| Build | Raw | Gzipped (limit) |
|---|---|---|
| Existing `dalyidau` Worker today | 2.9 MiB | 0.89 MiB |
| Payload 3.93 template alone (unminified) | 15.9 MiB | 3.7 MiB |
| **Combined: Payload + entire existing Worker + 5 wedding views** | **15.1 MiB** | **4.67 MiB** (10 MiB on Workers Paid) |
| Combined on Payload 4.0.0-beta.7 | 16.6 MiB | 5.1 MiB |

Sizes come from `wrangler deploy --dry-run`, which runs the same packaging step as a real upload.

**Startup CPU** (`wrangler check startup`, measured on this Mac and therefore indicative only): about **521 ms combined vs 197 ms today**.

- Payload's request handler loads lazily, so guest-host requests never run it.
- But every cold isolate still parses the 15 MiB script, including those serving the guest site.
- This fits within Cloudflare's script startup limit, but the margin must be confirmed on Cloudflare itself before any production use.

**PDFs:** the existing `pdf-lib` code generated output inside the combined Worker:

- the invitation print set: 4 A5 pages, 660 KB, 0.29 s;
- save-the-date cards: 4 pages, 409 KB, 0.04 s.

Payload-side image processing (`sharp`) isn't available on Workers, so the Media collection keeps crop and focal point off, as Payload's template does.

**Template problems found:**
- The official `with-cloudflare-d1` template imports a migrations folder that doesn't exist.
- Its build fails with `SQLITE_BUSY` unless Next.js uses a single build worker (`experimental.cpus: 1`).
- Payload 3.93 requires Node ≥ 24.22.1 (this Mac has 24.18; it only warned).
- It needs Workers Paid. I haven't checked the account's plan, and nothing was purchased.

### 2. Wedding screens as native Payload views: pass

The dashboard, Guests, Households, RSVPs and Seating screens render at `/admin/wedding/...` inside Payload's navigation (links added to Payload's sidebar). **19/19 browser checks pass** (`e2e-platform/custom-view.mjs`):

- **Isolation, both ways:**
  - Payload's computed styles are identical before and after a wedding screen opens.
  - The portal stylesheet never enters Payload's document.
  - The screen keeps the portal's own typography and colours.
- **React Aria overlays** (slide-outs, menus) open inside the isolation boundary, styled. This uses `UNSAFE_PortalProvider`.
- **Dark mode** follows Payload's theme without touching Payload's document.
- **Viewer role:** the "Add household" button is hidden and RSVP codes are redacted (`rsvpCode: null`), exactly as in the portal.

**Found and fixed:** browsers ignore Tailwind v4's `@property` defaults inside a shadow root, so every ring and shadow utility collapsed (borderless inputs and selects). The bridge now supplies Tailwind's own fallback values inside the shadow root. The results then match the portal.

**Limitations:**
- Links *inside* the existing screens still point to `/portal/wedding/...` (for example "Import guests"). Phase 2 must map them to `/admin/wedding/...`, or keep both.
- 22 wedding screens exist in total; five were wired up here.

### 3. Access authentication and wedding roles: pass

- **How identity works:** Payload trusts only the existing `authenticate()`, which checks the Access JWT signature, audience, issuer and expiry, then the role from `portal_users` / `PORTAL_OWNER_EMAILS`.
  - Payload's `users` table is only an email-and-role mirror, refreshed on every request, and grants nothing.
  - Roles are still managed only in the portal.
- **What's refused:** a fail-closed gate in front of Payload refuses `/admin` and every Payload API path for:
  - no token (401);
  - a forged key, an expired token or a wrong audience (403);
  - a valid person with no portal role (403).
- **Revocation:** a deactivated portal user loses Payload access on their next request.
- **Who can use what:**
  - Content editing (Pages) is limited to owners and admins.
  - The users list is limited to owners.
  - Payload's own users can't be created, changed or deleted at all.

**Insecure Payload defaults found and closed:**
1. **Unauthenticated admin shell.** Without the gate, Payload answers `/admin` with HTTP 200 and an "Unauthorized" page to anyone. Access would normally block this first; the gate makes it independent of Access.
2. **Gravatar.** Payload's admin loads Gravatar avatars by default, sending a hash of each person's email address to gravatar.com. Switched off (`admin.avatar: 'default'`).
3. **No Content-Security-Policy.** The portal sends a strict CSP; Payload sends none, and Payload doesn't run under the portal's `script-src 'self'`.
   - Fixed with a per-request nonce (`src/middleware.ts`). It keeps the portal's other directives, including `frame-ancestors 'none'`, with zero violations.
   - GraphQL is switched off as an unused surface.

### 4. Existing API router inside the Payload Worker: pass

- **Existing suite:** all **55 test files / 917 tests pass** through the combined router. That is all 53 existing files (903 tests) plus 2 new platform files.
  - Every `import worker from "../worker/index"` is swapped for the combined router (`test-platform/vitest.platform.config.ts`).
  - Payload is replaced by a stand-in that records every request reaching it.
  - A dedicated test proves the swap took effect.
- **Atomic SQL:** the existing code's 215 `D1.batch()` call sites (25 files in the portal, wedding and comms code) run against the same `DB` binding with the same statements, so transaction semantics are unchanged. I didn't write a separate atomicity test; the existing import, seating and RSVP suites cover them.
- **Route ownership:** the existing `/api/portal|wedding|comms|display|admin|amplenote|integrations` prefixes always win over Payload's REST API, and a test fails if a Payload collection would shadow one.

### 5. Scheduled messaging, webhooks, outbound comms: pass

- **Cron:** the Worker's cron runs the existing `scheduled()` exactly as today (message queue, calendar, Centre, assets, Intelligence).
  - New test: a queued wedding email due now was sent **once** through the development `log` provider. A second cron run sent nothing, and Payload was never involved.
  - Live: the cron then called Payload's job runner with a secret. Payload logged "Running 1 jobs." and ran a stand-in task.
  - The same endpoint refuses a signed-in owner without the secret (401).
- **Webhooks:** `/api/comms/webhooks/*` is accepted with the right key (200) and refused with a wrong key (404). It is unreachable on the wedding host (404).
- **Providers:** the existing Fastmail and ClickSend providers are unchanged and were not called. Real sending was never attempted.

**Limitation:** Payload has no scheduler of its own on Workers. Its jobs run only at the Worker's cron cadence (15 minutes).

### 6. Wedding site on its own hostname, admin isolated: pass

- **Hostname first:** the asset binding uses `run_worker_first: true`, so the hostname rules apply to static files too.
- **Guest hosts get only:**
  - the existing Worker's narrow wedding surface;
  - `/api/wedding/*`;
  - the planner host's own wedding API;
  - an allow-list of the existing build's static files.
- **Tests:**
  - 32 administration paths (including `/%61dmin`, `/admin%2f…`, `/assets/../admin`, `//admin`, `/ADMIN`, `/_next/static/*`, Payload's API and job runner) × GET and POST × signed in and anonymous, on both guest hosts: all refused, and Payload never called.
  - A generated sweep of 8,000+ paths found none routed to Payload from a guest host.
- **Existing exposure closed:** today, with no `run_worker_first`, the wedding host also serves the portal's static build (for example `/shell-portal.html` and the portal's JS bundles). That is code, not data, but the combined design no longer serves it.
- **Cost:** every static-file request now invokes the Worker (billed requests).

### 7. Dependency upgrades: partial

- **Template pins don't run.** The template's pinned Next 16.4.1 + OpenNext 1.20.1 build, but every Payload route fails at runtime (`Unexpected loadManifest(...preview-props.json)`).
  - OpenNext 1.20.16 requires Next ≥ 16.4.5. Upgrading to Next 16.4.6 + OpenNext 1.20.16 + Wrangler 4.149 fixed it.
  - **Lesson:** Payload's template and OpenNext must be upgraded in lockstep and tested at runtime, not just built.
- **Payload 4.0.0-beta.7** (released 4 November 2026; 3.x is still current):
  - **Three code changes:** storage adapters moved from `plugins` to `storage`; `DefaultTemplate` moved to `@payloadcms/ui/rsc`; `@payloadcms/next/rsc` was removed. See `evidence/payload-4-beta-upgrade.patch`.
  - **Content-database migration:** 114 SQL statements, including table rebuilds and new version tables for `users` and `media`. Generating it needs answers to **interactive rename prompts**, so it can't run unattended in CI as-is.
  - **Wedding data:** the wedding database was untouched.
  - **Browser checks:** 17/19 pass.
    - Real regression: the v4 admin adds an inline script without the CSP nonce, so it's blocked under the strict policy.
    - The other failure is a check made obsolete because Payload 4 adopted the same font as the portal.

## Unresolved risks

1. **Not yet measured on Cloudflare:** real startup time, the Access JWT on the real hostnames, and the upload itself. All Phase 0 evidence is local (workerd), which is close to production but not production.
2. **One failure domain.** In-process means a Payload or Next.js startup error, a dependency bug or a CPU spike can take down the RSVP site and webhooks with it. Today a CMS problem can't affect guests.
3. **Guest cold starts get slower** (startup CPU about 2.6×), for no guest benefit.
4. **Payload 4 is close.** Building on 3.x now means a major upgrade (code, a content-schema migration, the CSP regression) soon after, possibly during the wedding run-up.
5. **Untitled UI PRO mandate.** Payload's chrome isn't Untitled UI; the wedding screens inside it still are. Whether that's acceptable is your call.
6. **Owner actions still open:**
   - The deploy pipeline is broken (CI token rejected).
   - `feature/wedding-pwa` (live) isn't on `main`.
   - The planner host's Access destination is still pending.
   - Phase 1 depends on the first two.
7. **Migration tooling.** Payload's Drizzle migrations prompt interactively on renames, which needs a terminal. CI needs pre-generated migrations, reviewed by hand.
8. **Other applications.** Calendar, Today and the Intelligence Centre already run inside the combined Worker, because they share the portal router, but their screens aren't Payload views.
   - Shared sign-in, switches (`feature_flags`) and the audit log should stay in the portal code as the single source.
   - Payload should consume them as the PoC does. A separate `platform-core` (auth, flags, audit) package is the natural Phase 1 extraction alongside `wedding-core`.

## Revised effort estimate

Elapsed estimates for one developer working with an AI assistant, assuming the owner actions are done promptly.

| Phase | Work | Estimate |
|---|---|---|
| 1. Platform foundation | Fix the deploy token; staging Worker and D1 for Payload; backups for the new D1; measured cold start on Cloudflare; extract `platform-core` and `wedding-core` (split `handlePortalApi`); Payload pages and navigation; decide whether the blog moves to Payload or stays rendered by the existing code (stored HTML must keep rendering) | 3–4 weeks |
| 2. Wedding administration | Remaining 17 screens, link mapping, nested routes (message and household detail), browser tests per screen, role checks per screen | 2–3 weeks |
| 3. Backend integration | Mostly done by composition: hardening, staging rehearsal with invented data, alerting, keeping the previous version deployable | 1 week |
| 4. Production migration | Verified backups, rehearsal, cutover as a new version of the same `dalyidau` Worker (no DNS/route change), tested `wrangler rollback` | 3–5 days |
| **Total** | | **7–9 weeks** (add about 1–2 weeks if Payload 4 is adopted mid-way) |

## Recommendation

**Proceed to Phase 1, with these conditions:**

1. **Deploy as the same Worker name** (`dalyidau`) when the time comes. That means no DNS, route or MCP-binding change, and rollback is a version rollback. Before then, the first Phase 1 step is an isolated staging deploy (needs your approval) to measure startup time and real Access behaviour. Stop if the startup margin is thin.
2. **Keep `/portal/wedding` working alongside `/admin/wedding`** until every screen has proven parity. This costs nothing: the existing Worker still serves it.
3. **Don't cut over during the RSVP-critical window.** Pick a date with you once invitation and RSVP dates are fixed, and freeze Payload upgrades from then until after 23 October 2027.
4. **Decide on Payload 4 first.** Either wait for 4.0 GA (likely weeks away) or start on 3.x and accept one major upgrade before cutover.

## Decisions needed from you

1. Approve Phase 1 (or not), and the conditions above.
2. Payload 3.x now, or wait for 4.0 GA.
3. Approval for an isolated staging deploy (new Worker and new D1; no routes; workers.dev off) to measure on Cloudflare.
4. Whether Payload's non-Untitled UI admin chrome is acceptable under the Untitled UI PRO mandate.
5. Fix the CI deploy token and merge `feature/wedding-pwa` to `main` (prerequisites).

## How to reproduce

From `poc/payload/` (see its README):

1. `node scripts/test-identity.mjs init`
2. `npm run poc:build`
3. `npm run poc:migrate`
4. `npx wrangler dev --port 8790 --local --test-scheduled`
5. `node scripts/seed-invented.mjs`
6. `node e2e-platform/custom-view.mjs`

Server-side suites: `npx vitest run --config poc/payload/test-platform/vitest.platform.config.ts` (from the repository root).
