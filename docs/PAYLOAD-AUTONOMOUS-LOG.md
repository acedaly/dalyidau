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
