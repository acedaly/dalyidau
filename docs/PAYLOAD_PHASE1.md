# Payload CMS: Phase 1 progress report (staging checkpoint)

**Status:** Phase 1 is in progress. This is the checkpoint you asked for before going any further: staging performance, integration progress, open security issues and an updated plan. Nothing in production has changed. No production deploy, migration, route, DNS or Access change was made, and none is proposed here.

Branch: `feature/payload-phase1`, based on `origin/main` at `7a1a1c4` (the version running in production) plus the Phase 0 commit. Phase 0 itself is committed on `experiment/payload-phase0`.

## Decisions carried out

| # | Decision | Result |
|---|---|---|
| 1 | Proceed to Phase 1 | Started. This report is the first checkpoint. |
| 2 | Payload 3.x baseline | Payload 3.93.0. The 4.0 beta isn't used anywhere. |
| 3 | Isolated staging | Staging Worker `dalyidau-payload-staging`, with no routes, no custom domains, and workers.dev and preview URLs off. It has two new D1 databases and two new R2 buckets (below). |
| 4 | Payload's standard admin | Accepted. The wedding screens stay Untitled UI inside it. |
| 5 | Commit Phase 0 | `02476da` on `experiment/payload-phase0`. Local only, not pushed. |
| 6 | CI deploy repair | **Nothing needed.** The `CLOUDFLARE_API_TOKEN` repository secret was replaced on 6 Nov 2026. The main-branch deploy that day (run 42306960918) succeeded and is what production is running. No credential was viewed, rotated or replaced. |
| 7 | `feature/wedding-pwa` merge | **Already merged.** Its head (`8b532a2`) is an ancestor of `origin/main`. Production runs `7a1a1c4`, which contains it (`wrangler deployments list`: version `de231899…`, message `7a1a1c4…`, deployed by CI on 6 Nov). There's nothing left to merge. Only the local `main` branch is behind. |

## New Cloudflare resources (all new, nothing existing touched)

| Resource | Name | Notes |
|---|---|---|
| Worker | `dalyidau-payload-staging` | No routes. workers.dev answers **error 1042** (disabled). Cron `*/15`. |
| D1 | `dalyidau-payload-staging-content` | Payload's own tables (3 Payload migrations). Region OC, like production. |
| D1 | `dalyidau-payload-staging-wedding` | The existing 31 migrations; 50 invented households, 123 invented guests. |
| R2 | `dalyidau-payload-staging-media`, `dalyidau-payload-staging-wedding-media` | Empty. |

The existing `dalyidau-staging` Worker, database and bucket were not used. Open PR #48 proposes removing them.

## How staging is kept away from production

- **Configuration is checked before every deploy.** `poc/payload/scripts/check-staging.mjs` reads both configs through Wrangler's own resolver. It fails on any of these:
  - a D1 database, R2 bucket or Worker name shared with production, the old staging or the local PoC;
  - any route, workers.dev or preview URL;
  - any service, queue, KV, AI or other binding;
  - `ENVIRONMENT` not set to `staging`;
  - a real delivery provider;
  - a non-`.invalid` site address or a non-`example.test` owner;
  - any Access or test identity variable.

  With `--online` it also lists the deployed secret names (never values) and fails on anything beyond `PAYLOAD_SECRET`, `PAYLOAD_JOBS_SECRET`, `RSVP_LINK_SECRET` and `COMMS_WEBHOOK_SECRET`, which are random values that exist only in staging. Both checks pass.
- **No outbound requests.** The staging entry (`platform/entry-staging.ts`) installs `platform/egress.ts` before any other module loads. Every global `fetch` to the internet is refused as a network error and logged by host only. Fastmail, ClickSend, Capacities, Cloudflare's API, Access certificates and daly.id.au are all unreachable, and `test-platform/staging.test.ts` proves it. Nothing was refused during the measurements, so nothing tried.
- **Sign-in stays as strict as production.** The deployed staging Worker has no Access configuration, so `authenticate()` refuses everyone (`not_configured`). The invented test key is accepted only by the existing rule (`ENVIRONMENT` = `development` or `test`), which the deployed Worker never has.
- **Measurement sessions are private.** Measurements ran in private `wrangler dev --remote --env staging` sessions: the same build on Cloudflare's edge with the staging bindings, reachable only through the session's preview token from this machine. Those sessions use the invented key (`.dev.vars.staging`, git-ignored).
- **Links lead nowhere real.** Every address is `.invalid` and every owner is `example.test`, so no link or email staging builds can point somewhere real.

## Staging performance (Cloudflare, 10–11 Nov 2026)

### Startup (reported by Cloudflare at deploy)

| | Upload (gzip) | Worker startup time |
|---|---|---|
| Production today (`dalyidau`, CI deploy 6 Nov) | 845 KiB | **112 ms** |
| Combined Worker, staging | 4,763 KiB (limit 10 MiB) | **199 ms** |

The combined Worker adds 87 ms at startup (1.8×), well inside the 1 s limit. The local estimate in Phase 0 (521 ms vs 197 ms) was pessimistic.

### Requests

All requests were timed from Sydney through the session proxy, so every figure includes about 30–50 ms of network. Each row is one warm request, then 25 more (15 for SSR and writes).

| Request | Today's Worker alone, p50 / p95 | Combined Worker, p50 / p95 |
|---|---|---|
| Static file (network baseline) | 53 / 61 ms | 30 / 47 ms |
| Blog home (SSR) | 75 / 108 | 75 / 105 |
| Portal wedding guests page (SSR) | 144 / 193 | 146 / 161 |
| Guests API list | 102 / 112 | 102 / 117 |
| Add guest (write + audit) | 172 / 186 | 173 / 178 |
| Guest site home | 102 / 120 | 105 / 116 |
| Guest site RSVP lookup | 53 / 67 | 52 / 70 |
| Wedding page data (bridge) | n/a | 152 / 167 |
| Payload `/api/users/me` | n/a | 184 / 195 |
| Payload `/api/pages` | n/a | 203 / 237 |
| Payload admin dashboard (SSR) | n/a | 260 / 389 |
| Payload admin wedding guests view (SSR) | n/a | 208 / 244 |

**Warm requests to today's routes cost the same with Payload in the Worker.**

The Payload admin is about 100–150 ms slower than the existing portal pages. Part of that is the Payload user mirror being looked up or updated on every request, which can be reduced.

### Cold first request to the guest site (fresh session, alternating, 8 each)

| | Median | Range |
|---|---|---|
| Today's Worker alone | ~0.40 s | 0.20–0.49 s (one outlier at 3.2 s) |
| Combined Worker | ~0.46 s | 0.43–0.90 s |

Guests pay roughly 60 ms more on a cold isolate, consistent with the startup difference. Guest routes never initialise Payload.

### The deployed staging Worker's own cron (observed live, 19:45 UTC)

- Both jobs ran: the existing scheduled jobs (`sync_off`), then Payload's job runner (`payload_jobs_run` 200). There were 0 exceptions.
- **That one invocation used 2.9 s of CPU and 7.2 s of wall time.** Payload starts from cold on almost every 15-minute run.
- Across all 724 staging invocations, CPU time was p50 2.8 ms and p99 39.5 ms, with 0 errors.

## Integration progress

- **Rebased onto production code.** The whole existing suite still passes through the combined router: 52 files, 817 tests, including the 3 new staging tests. Both PoC typechecks are clean; the app tsconfig now excludes the Worker folders, which the platform tsconfig checks.
- **Deployed and running on Cloudflare.** The Access gate (401 without identity), the host isolation (`/admin` 404 on the guest host), the wedding views, the bridge, Payload's migrations and the cron all work on the real runtime.
- **Not started yet:**
  - extracting `wedding-core` / `platform-core` from the shared router;
  - the remaining wedding screens beyond the five in the PoC;
  - a production-shaped build pipeline (the PoC builds by hand).

## Open security and operational issues

1. **Real Cloudflare Access hasn't been tested on Payload's paths.** That needs an Access application on a hostname. A staging hostname would be a new custom domain and an Access policy change, neither of which is approved. Everything else about sign-in is tested.
2. **D1 overload error in staging.** One request got `D1_ERROR: Your account is generating too much load on D1 DBs`. It happened right after Payload's first-run migrations on the brand-new databases, and cleared on retry.
   - Production showed 0 Worker exceptions in the 3 hours around it (analytics API).
   - The portal catches D1 errors itself, though, and my Wrangler sign-in can't read Workers logs (403).
   - **Please check production's logs for 10 Nov around 19:30 UTC.** All later measurement load was sequential and throttled, with no recurrence.
3. **Payload's cold start on the cron (2.9 s CPU every 15 minutes).** It's within paid-plan limits, but wasteful, and it shares an isolate with guest traffic. Fix in Phase 1: call Payload's job runner only when work is queued, or less often.
4. **Log noise and one unexplained error.**
   - The Payload sign-in strategy calls `authenticate()` for the job runner's internal request, which logs a harmless `portal_auth_refused` on every cron. Fix: skip the strategy when there's no Access assertion.
   - One `{"level":"error","err":{}}` from Payload on the first admin request (probably the user-mirror write racing first-run migrations) needs reproducing.
5. **Things I noticed in production but didn't change:**
   - The production config sets `workers_dev: true`, so `dalyidau` is also reachable on its workers.dev address, where Access doesn't apply. The portal still fails closed without an Access token, but the guest site and public API are served there too. Worth deciding deliberately.
   - A `wrangler tail dalyidau` process has been streaming production logs on this Mac since 1 Nov (PID 24285, from an earlier session).
6. **Wrangler hands `wrangler deploy` to OpenNext's deploy in this folder.** OpenNext's deploy reads `.dev.vars`. A first deploy attempt went that way and failed before uploading anything; staging deploys now set `OPEN_NEXT_DEPLOY=true`. The production pipeline must do the same, or `.dev.vars` content could be picked up.

## Updated migration plan

| Phase | Scope | Estimate |
|---|---|---|
| 1 (remaining) | Fix items 3, 4 and 6. Split `wedding-core` / `platform-core` out of the router (smaller if PR #48 lands first, since it retires Calendar, Today, Intelligence and the Centre). Build the remaining wedding screens as Payload views next to `/portal/wedding`. Add a CI job for the combined build, the platform tests and `check-staging.mjs`. Re-measure on staging. | 3–4 weeks |
| 2 | Content collections (pages, posts, media) and the public site rendering from Payload, with Capacities and Amplenote archives untouched. | 2 weeks |
| 3 | Real Access on the admin paths (needs your approval for a hostname or policy). Rehearse the cutover and rollback on staging. | 1 week |
| 4 | Production cutover under the same Worker name (`dalyidau`), outside the RSVP-critical window, with `wrangler rollback` as the way back. **Needs separate approval.** | 1 week |

Total: still **7–9 weeks**. PR #48 may shorten Phase 1.

## Decisions needed from you

1. Continue Phase 1 as above.
2. Should I rebase onto PR #48 (`retire-portal`) once you merge it, or keep building against `main`?
3. When you're ready: a staging hostname with an Access application, to test real Access (item 1).
4. Item 5: keep or drop `workers_dev` on production, and stop the old production log tail.

## Reproducing

```bash
cd poc/payload
node scripts/check-staging.mjs --online              # isolation, before any staging deploy
npm run poc:build
OPEN_NEXT_DEPLOY=true npx wrangler deploy --env staging   # never without the check above
node scripts/test-identity.mjs init --staging        # invented key for measurement sessions
OPEN_NEXT_DEPLOY=true npx wrangler dev --remote --env staging --port 8791
STAGING_ORIGIN=https://<preview host> node scripts/measure-staging.mjs site
```

Raw results are in `poc/payload/.poc-results/staging-*.json` (git-ignored).
