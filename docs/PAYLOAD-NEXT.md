# Payload migration: how to resume

Read this first if you are a Claude Code session picking up this work. Then read the last entries of `docs/PAYLOAD-AUTONOMOUS-LOG.md`.

## Window and authority

- The owner's autonomous directive (11 Nov 2026) authorised unattended work until 2026-11-11T02:02Z. **That work has ended:** every remaining task needs the owner's approval (see "Blocked on the owner"). Don't restart unattended work without a new instruction.
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
- all 19 wedding screens in Payload;
- PR #48 rehearsal (clean, 476/476) and review;
- D1 overload cause (production Centre cron);
- workers.dev change prepared (`chore/production-workers-dev-off`, local);
- Payload authorisation fixes (121/121);
- staging rollback and full cutover rehearsal (data identical, 3 s);
- staging Access prepared (`staging-access.mjs`, access mode);
- scope review (`docs/PAYLOAD-SCOPE-REVIEW.md`);
- cutover plan (`docs/PAYLOAD-CUTOVER-PLAN.md`);
- CI workflow `.github/workflows/payload.yml` (local, not pushed).

Remaining unblocked work: none of substance. Optional polish: the Payload-tsconfig typing quirk in `message-page.tsx`, and caching the user mirror per isolate.

**Blocked on the owner** (see the cutover plan):

- the Access application and read-only token for staging, and attaching the hostname;
- PR #48 merge;
- production D1/R2 and secrets;
- production Access paths;
- merging the CI workflow changes;
- the cutover itself;
- deploying `chore/production-workers-dev-off`.

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
- Browser checks: plain `wrangler dev --local --port 8790`, then `node e2e-platform/custom-view.mjs` (43 checks).

- Cron CPU on staging after the due-jobs gate.
- Per-route CPU comparison.
- Remaining wedding screens in the browser (`e2e-platform/custom-view.mjs`).
- PR #48 rebase run.
- Staging rollback rehearsal.
