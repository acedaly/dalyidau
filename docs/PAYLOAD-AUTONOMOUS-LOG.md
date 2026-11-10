# Payload migration: autonomous work log

Newest entries at the bottom. Each entry records what was done, the evidence, and any decisions or blockers. The resumption state is in `docs/PAYLOAD-NEXT.md`.

## 2026-11-10 (UTC), before the autonomous window

- **Phase 0** committed as `02476da` (`experiment/payload-phase0`).
- **Phase 1 staging checkpoint** committed as `8e41596` (`feature/payload-phase1`). See `docs/PAYLOAD_PHASE1.md`.
- **Owner's directions (11 Nov):**
  - Phase 1 continues; build on PR #48 only once it has been reviewed and merged.
  - Prepare a staging hostname and Access configuration, but nothing goes public without approval.
  - Fix the cron CPU; guard deploys against `.dev.vars`; investigate the D1 overload and the production workers.dev address.
  - Stop PID 24285.
  - Challenge the estimate.
- **Autonomous directive received ~20:00Z.** The window ends 2026-11-11T02:02Z.

## 20:00Z: housekeeping, cron and deploy path

- **PID 24285 stopped.** Confirmed first as `wrangler tail dalyidau --format json`, started 1 Nov, parent launchd (orphaned). No other process was touched.
- **PR #48** is OPEN with no review, so work continues on `main`.
- **Cron CPU fix.**
  - `compose.ts` now has `payloadHasDueJobs(env.D1)`, a single indexed SELECT on `payload_jobs`. The job runner, and so Payload itself, starts only when a job is due. Any error counts as "nothing due".
  - Payload's own scheduler (`schedule` on a task) was dropped; recurring work stays in the existing cron.
  - Tests: `platform.test.ts` covers jobs that aren't due (finished, failed, processing, future), a missing table, a missing binding, and a due job (runs, needs the secret).
  - Decision: query D1 directly rather than calling Payload's API, because the API is what costs about 3 s of CPU.
- **`.dev.vars` finding.**
  - `wrangler deploy` never uploads `.dev.vars`. In a Next.js folder, though, Wrangler hands the deploy to `opennextjs-cloudflare deploy`, whose `getEnvFromPlatformProxy` loads `.dev.vars` and `.env*` into the deploy process's environment. A `CLOUDFLARE_*` value there could redirect the account or credentials.
  - Fix: `scripts/deploy-staging.mjs` is now the only deploy path. It refuses if any env file sets `CLOUDFLARE_*`, `CF_*`, `WRANGLER_*` or `OPEN_NEXT_*`, runs `check-staging.mjs`, deploys with `OPEN_NEXT_DEPLOY=true` and a clean environment, then runs `check-staging.mjs --online`.
  - The template's `deploy`, `deploy:app`, `deploy:database` and `preview` scripts were removed; `staging:check` and `staging:deploy` were added.
- **Staging redeployed** through the new script; both checks passed.

## 20:06Z: unattended resumption supervisor (`poc/payload/supervisor/`)

- **How usage limits show up here.** Claude Code writes an assistant record with `"error":"rate_limit"` and text like "You've hit your session limit · resets 12pm (Australia/Sydney)" to the session transcript (`~/.claude/projects/<repo>/<session>.jsonl`). That notice is the authoritative reset time. The session itself doesn't resume.
- **Mechanism (decision: the simplest supported option).**
  - A user-level launchd agent (`au.id.daly.payload-autonomy`, every 10 minutes) runs `supervisor.mjs`.
  - It launches only when all of these hold: no STOP file; before the deadline; fewer than 4 launches; no other `payload-autonomy` session running; the followed transcript quiet for 10 minutes and ending in a limit notice; and the reset time (+3 min) has passed. If the notice can't be read, it backs off 30 min, 1 h, 2 h, then 3 h.
  - It then starts one fresh `claude -p` session (auto permission mode, no MCP servers, deny rules in `headless-settings.json`, risky tools disallowed) with `resume-prompt.md`, which reads `docs/PAYLOAD-NEXT.md`.
  - It then follows the new session.
  - It logs decisions and outcomes only (`~/.payload-autonomy/supervisor.log`), never session content or credentials.
- **Tests.**
  - `node --test poc/payload/supervisor/supervisor.test.mjs`: 5 passing (parsing, Sydney DST, backoff, active, idle, deadline, cap, STOP).
  - The parser works on a real 24 Oct limit notice (resets 01:00Z).
  - Headless smoke test: `success`.
  - The deny rule blocked `git push --dry-run` headlessly (`permission_denials`).
  - Dry-run launch decision works through the file and lock handling.
  - Installed under launchd; first tick logged "wait: session active".
- **Not tested:** a real usage-limit event (one can't be triggered on purpose).
- **Known limits.**
  - Deny rules match command prefixes; a command wrapped in `node -e` wouldn't match. Auto mode's classifier and the prompt's boundaries are the other layers.
  - When the owner returns, run `poc/payload/supervisor/install.sh uninstall` (or `touch ~/.payload-autonomy/STOP`), so the supervisor and the owner's own session never run at the same time.

## 20:15Z: every wedding screen as a Payload view

- `src/views/wedding-routes.ts` is the single list of the 19 wedding screens (same paths as `/portal/wedding/*`). It drives the view's routing, Payload's sidebar (15 links) and in-screen link handling. `wedding-screen.tsx` maps every wedding route to the portal's own page component, the same mapping as `portal-app.tsx`, wedding only, so PR #48's deletions don't affect it.
- In-screen links to `/portal/wedding/*` open the Payload view (plain left-click only). Query strings are dropped for now: a known limitation, since the bridge refuses queries by design.
- The bridge now accepts `msg_` ids (underscore), so message pages work. Dot segments are still refused.
- **Tests:**
  - `wedding-routes.test.ts` (new): every `/portal/wedding` pattern in `pages.ts` is routable; nothing else is; link mapping (3 tests).
  - Browser: **36/36**, with all 19 screens rendering inside Payload, a non-wedding path returning 404, and link navigation staying in Payload.
  - Platform suite: **53 files, 821 tests passing**. Platform tsc clean; root `tsc -b` clean.
- **Known issue (not fixed, on purpose):** under Payload's stricter app tsconfig, `src/portal/pages/message-page.tsx:149` gives TS2339 (the type of `.catch(() => null)`). The root build is clean, the runtime is unaffected, and existing working code isn't changed for it.
- **Test harness:** a test-only `crypto.randomUUID` shim for the http host mapping, because headless Chromium ignores the insecure-origin flag. Production is https.

## 20:25Z: cron CPU confirmed; CPU for unrelated routes measured on Cloudflare

- **Staging cron after the due-jobs gate** (20:15Z, `wrangler tail`): CPU **28 ms** (was 2,915 ms), wall 3.9 s (cold isolate, D1). Outcome ok, 0 exceptions, no Payload log lines, so Payload wasn't started.
- **CPU per route** (`scripts/measure-cpu.sh` and `scripts/cpu-report.mjs`): Workers analytics `cpuTimeP50`/`P99`, one route type per UTC minute, 40 requests each, today's Worker alone (`entry-legacy-baseline.ts`) vs combined. Both ran in the private remote session on staging data.

  | Route | Today p50 / p99 | Combined p50 / p99 |
  |---|---|---|
  | Blog home | 2.4 / 6.8 ms | 2.4 / 7.9 ms |
  | Wedding guests API | 2.5 / 4.4 ms | 2.5 / 4.3 ms |
  | Portal guests page | 5.4 / 20.9 ms | 5.1 / 12.5 ms |

  **No measurable CPU cost on routes that don't use Payload.** The only extra cost is startup (199 vs 112 ms, once per isolate). Raw output: `poc/payload/.poc-results/cpu-report.txt`.

## 20:45Z: PR #48 compatibility (not merged; nothing pushed)

- **PR #48** (`retire-portal`, head `2c7c2a0`) is OPEN, with no review. It removes Calendar, Today, Intelligence, the Centre and Amplenote plus their tables, and drops the old staging env. It touches `worker/index.ts`, `env.ts` and `portal/api.ts`/`pages.ts`, but not the wedding routes Payload uses.
- **Rehearsal** in a throwaway worktree: cherry-picked all 7 Payload commits onto `origin/retire-portal`. **No conflicts.** After building the client: **34 files, 476 tests passing**, including every platform, isolation, cron, staging and wedding-route test. The worktree was removed afterwards.
- **Bundle with PR #48:** today's Worker is 606 KiB gzip (main: 845); combined 4,691 KiB (main: 4,763). Payload dominates.
- **Decision:** no compatibility changes are needed. Once the owner merges #48, `git rebase origin/main` on this branch (expected to be clean), re-run the suite and redeploy staging. The wedding view's own route list means #48's deletion of the other apps' pages has no effect on it.

## 21:00Z: D1 overload and production workers.dev investigations

- **D1 overload (10 Nov ~19:31Z).**
  - D1 analytics per minute, all databases: production's own cron reads **~365,000 rows every 15 minutes** (19:15, 19:30, 19:45). At 19:30–19:31 that coincided with staging's first Payload migrations (stg-content: 65 writes) and staging seeding.
  - `wrangler d1 insights dalyidau-production` (query shapes only): the top query is the Intelligence Centre's housekeeping `DELETE FROM ic_series WHERE record_id NOT IN (SELECT id FROM ic_records)`, at **26.5M rows read per day over 78 runs**. The Centre is also updating ~110k `ic_records` rows a day, so it is actively ingesting in production.
  - **Conclusion:** the account's D1 load is dominated by production's Centre cron; staging was a small spike on top. PR #48 (which retires the Centre) would remove it. I can't confirm effects in production logs (Workers Logs returns 403 for Wrangler's sign-in).
  - **Recommendations for the owner:** check whether the Centre's sources should still be on; merging #48 ends this. Until then, staging migrations should avoid :00/:15/:30/:45.
- **Production workers.dev.**
  - No runtime dependency. There are no references to `dalyidau.<account>.workers.dev` in this repo, the other `~/Projects` repos or the workflows; only daly-finance's own workers.dev appears elsewhere. The MCP gateway binds by service.
  - The code treats workers.dev hosts as `noindex` and requires an Access token for portal/API there (`test/access.test.ts`). `docs/DEPLOYMENT.md` used the address as a manual smoke check.
  - Traffic to it can't be measured with my access.
  - **Prepared, not deployed:** branch `chore/production-workers-dev-off` (`9c739ed`, local) sets `workers_dev: false` and `preview_urls: false`, updates DEPLOYMENT.md, and adds `check-config.mjs` checks (production only). The check passes on the new config. Merging and deploying it is a production change that needs the owner.
