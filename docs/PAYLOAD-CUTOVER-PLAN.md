# Payload wedding admin: staging Access test, production cutover and rollback

**Prepared 11 Nov 2026. Nothing in this plan has been carried out.** Every step marked 🔒 needs the owner's explicit approval. The evidence behind each step is in `docs/PAYLOAD-AUTONOMOUS-LOG.md`.

## What a cutover is (and isn't)

- **It is:** deploying the combined Worker (Payload plus today's Worker, `poc/payload/platform/entry.ts`) under the **same Worker name, `dalyidau`**. Routes, DNS, the MCP gateway's service binding and the wedding database stay exactly as they are.
- **It isn't:** a data migration. Wedding data stays in `dalyidau-production` and its existing tables. Payload gets a new, empty database of its own.
- **Rollback** is `wrangler rollback <previous version>`. On staging it took **3 s**, with wedding data identical before, during and after (12 tables hashed row by row).

## A. Staging behind real Access (test sign-in, sessions, direct URLs)

1. 🔒 **Create an Access application** (Zero Trust → Access → Applications → Self-hosted):
   - Domain: `payload-staging.daly.id.au`, **whole host** (no path).
   - Policy: Allow, include the owner's email (and Amelia's, if wanted). No bypass, no "Everyone".
   - Session duration: 24 h, same as the portal.
2. 🔒 **Create a read-only API token** ("Access: Apps and Policies Read", this account) and use it for this check only:

   ```bash
   CF_ACCESS_READ_TOKEN=… node poc/payload/scripts/staging-access.mjs verify
   ```

   This must print `✓`. It refuses a path-only application, a bypass policy or "Everyone".
3. **Set the staging secrets** (values from the dashboard; never commit them):

   ```bash
   cd poc/payload
   npx wrangler secret put ACCESS_TEAM_DOMAIN --env staging
   npx wrangler secret put ACCESS_AUD --env staging
   npx wrangler secret put PORTAL_OWNER_EMAILS --env staging
   ```

4. **Edit `poc/payload/wrangler.jsonc` `env.staging`:**
   - `"routes": [{ "pattern": "payload-staging.daly.id.au", "custom_domain": true }]`
   - `"SITE_URL": "https://payload-staging.daly.id.au"`
   - remove `PORTAL_OWNER_EMAILS` from vars

   `node scripts/check-staging.mjs` enforces all of this ("access mode").
5. 🔒 **Deploy:** `CF_ACCESS_READ_TOKEN=… npm run staging:deploy`. The script runs `verify` **before** uploading (no Access, no deploy) and `probe` afterwards. Every path must redirect to Access or be refused; if anything answers, detach the hostname at once.
6. **Test by hand in a browser:**
   - sign in, then open all 19 wedding screens under `/admin/wedding`;
   - sign out (the Access logout URL) and confirm `/admin` asks again;
   - set a 15-minute session and confirm expiry;
   - remove a test helper's role in the portal and confirm their next request is refused;
   - open direct URLs (`/admin/wedding/guests`, `/api/platform/wedding-page?...`, `/api/users`) in a private window: all go to Access.

   Record the results in the log.
7. Afterwards, either keep it (for UAT) or remove the route and redeploy (`routes: []`), and delete the Access application.

## B. Production preparation (no user-visible change)

1. 🔒 **Merge PR #48** (recommended first). Then `git rebase origin/main` on `feature/payload-phase1`; the rehearsal showed no conflicts and 476/476 tests passing.
2. 🔒 **New resources:**
   - D1 `dalyidau-payload` (location OC), bound as `D1`;
   - R2 `dalyidau-payload-media`, bound as `R2`.

   The production `DB` and `MEDIA` bindings stay as they are.
3. 🔒 **Secrets** on `dalyidau`: `PAYLOAD_SECRET` and `PAYLOAD_JOBS_SECRET` (random; set with `wrangler secret put`, never in files).
4. **Production config:** move the combined Worker's config into the root `wrangler.jsonc`. Keep the name, routes, crons and every existing binding; add `D1` and `R2`; set `main` to the combined entry, `assets.run_worker_first: true` and `nodejs_compat`. `check-config.mjs` gains the same isolation and identity checks as staging.
5. **CI** (`.github/workflows/deploy.yml`), in this order:
   1. `npm ci` (root and `poc/payload`), then the client build, the OpenNext build and the asset merge;
   2. the platform suite and `check-config`;
   3. the D1 restore point (already in the workflow);
   4. `OPEN_NEXT_DEPLOY=true npx wrangler deploy` with a clean environment and no `.dev.vars` in the checkout.

   This needs your review, and should run first as a workflow-dispatch to staging.
6. 🔒 **Access:** add these paths to the existing portal Access application (same AUD, so no secret changes): `admin`, `api/platform`, `api/users`, `api/pages`, `api/media` and `api/payload-preferences`. Until this is done, the Worker refuses everyone on those paths (401); nothing is exposed.

## C. Cutover runbook (🔒, outside the RSVP-critical window, owner present)

1. **Pre-checks:**
   - `wrangler deployments list` and note the current version ID (the **rollback target**);
   - `wrangler d1 time-travel info DB` and note the bookmark;
   - confirm no scheduled message is due within the next hour (Communications screen).
2. Deploy through CI (or the reviewed script), and note the new version ID and Cloudflare's reported startup time. Expect roughly 150–240 ms; the limit is 1,000 ms.
3. **Smoke checks (10 minutes):**
   - `https://wedding.daly.id.au/` loads, and an RSVP lookup with a test code answers;
   - `/portal/wedding` works;
   - `/admin/wedding` works for the owner;
   - `wedding.daly.id.au/admin` returns 404;
   - the next cron run (`:00`, `:15`, `:30` or `:45`) completes, with CPU in tens of ms in Workers analytics;
   - the MCP gateway answers.
4. **Monitor for 48 hours:** Workers analytics (errors, CPU p99, startup), D1 analytics and email/SMS delivery events.

## D. Rollback

- **Trigger:** any guest-facing error, a cron failure, or anything unexplained.
- **Action:** `npx wrangler rollback <rollback target> -y` (3 s on staging). No data step is needed: the wedding tables are untouched by the cutover, and Payload's database is separate and can stay.
- **If a later wedding schema change were involved** (not part of this cutover): D1 Time Travel restores to the bookmark noted in C1.

## Evidence summary

| Claim | Evidence |
|---|---|
| Guests never reach the admin | 32 named paths × methods × identities, plus 8,000+ generated paths (platform tests); `/admin` returns 404 on the guest host on Cloudflare |
| Only Access identities reach Payload; no Payload sessions | Authz matrix 121/121 on the real Payload; platform tests for credential stripping |
| No extra CPU on today's routes | Cloudflare analytics, same p50 for blog, API and portal page |
| The cron doesn't start Payload | 28 ms CPU on staging (was 2,915 ms) |
| Rollback is fast and safe | Staging rehearsal: 3 s, wedding data identical at every step |
| Works on today's code and on PR #48 | 826 tests on main; 476 on PR #48 |
