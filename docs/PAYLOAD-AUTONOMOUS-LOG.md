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
