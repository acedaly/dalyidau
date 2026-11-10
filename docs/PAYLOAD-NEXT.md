# Payload migration: how to resume

Read this first if you are a Claude Code session picking up this work. Then read the last entries of `docs/PAYLOAD-AUTONOMOUS-LOG.md`.

## Window and authority

- The owner's autonomous directive (11 Nov 2026) authorises unattended work until **2026-11-11T02:02Z (13:02 Sydney)**. **After that, stop:** save work, update this file and the log, and write the final summary into the log.
- Make routine technical decisions yourself and record why in the log. Don't ask the owner questions; they're away.

## Safety boundaries (always in force)

Never do any of the following:

- deploy to production (the `dalyidau` Worker, or anything from the repo root);
- touch production D1 (`dalyidau-production`) or R2 (`dalyidau-media`) data;
- merge PR #48 or any PR, or push to `main`;
- change DNS, routes, custom domains, Cloudflare Access or authentication settings;
- expose staging publicly, which includes attaching a hostname, enabling workers.dev or enabling preview URLs;
- delete existing Cloudflare resources or do anything irreversible;
- add paid services;
- disable security controls;
- work around usage limits.

The only deploy allowed is `cd poc/payload && npm run staging:deploy` (isolated staging, checks before and after). Use invented data only. **Commit locally; don't push.**

If something needs an unapproved action, record it as a blocker in the log and move on to independent work.

## Current state

- **Branch:** `feature/payload-phase1`, based on `origin/main` at `7a1a1c4` (what production runs). Run `git log --oneline -5` for the latest commit.
- Phase 0 is on `experiment/payload-phase0` (`02476da`).
- **Staging:**
  - Worker `dalyidau-payload-staging`: no routes, workers.dev off.
  - D1: `dalyidau-payload-staging-content` and `-wedding` (invented data).
  - R2: `dalyidau-payload-staging-media` and `-wedding-media`.
- **Reports:**
  - `docs/PAYLOAD_PHASE0.md`
  - `docs/PAYLOAD_PHASE1.md`, the first staging checkpoint
  - `docs/PAYLOAD-AUTONOMOUS-LOG.md`, the journal

## Task list (highest value first; tick in the log, not here)

Done (details in the log):

- cron CPU (2.9 s to 28 ms);
- the guarded deploy path;
- per-route CPU (no cost);
- all 19 wedding screens as Payload views;
- PR #48 rehearsal (clean, 476/476);
- the D1 overload cause (production Centre cron);
- workers.dev change prepared (`chore/production-workers-dev-off`);
- Payload authorisation fixes (121/121).

Remaining:

1. Redeploy staging with the security fixes; rehearse `wrangler rollback --env staging` and roll forward; re-run `check-staging --online` and record timings.
2. Staging hostname and Access: config, a pre-attach verifier and probe scripts only. Attaching or creating Access needs approval and an Access read token from the owner.
3. Scope and timeline review (challenge the 7–9 weeks): minimum usable system, keep-as-is, essential vs optional.
4. Production cutover and rollback plan (evidence-based), using the staging rehearsal.
5. Optional, if time remains:
   - add a CI job (platform suite, `check-staging`, authz matrix) as a workflow file; don't push;
   - make query strings survive in-screen links.

## Resume commands

```bash
cd /Users/aidandaly/Projects/dalyidau && git status --short && git log --oneline -5
cd poc/payload
node scripts/check-staging.mjs --online                    # must pass
npm run poc:build                                          # if src/ or platform/ changed
npm run staging:deploy                                     # only deploy path
cd ../.. && npx vitest run --config poc/payload/test-platform/vitest.platform.config.ts   # 52 files
cd poc/payload && npm run poc:typecheck                    # app tsc needs NODE_OPTIONS=--max-old-space-size=8192
```

## Outstanding tests

- Authz matrix: `npx wrangler dev --local --port 8790 --env-file .dev.vars.authz`, then `node e2e-platform/authz.mjs` (121 checks).
- Browser checks: plain `wrangler dev --local --port 8790`, then `node e2e-platform/custom-view.mjs` (39 checks).

- Cron CPU on staging after the due-jobs gate.
- Per-route CPU comparison.
- Remaining wedding screens in the browser (`e2e-platform/custom-view.mjs`).
- PR #48 rebase run.
- Staging rollback rehearsal.
