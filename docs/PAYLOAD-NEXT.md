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

1. Cron CPU: the cron now checks D1 for due Payload jobs and doesn't start Payload otherwise. Confirm on staging (`wrangler tail --env staging` around :00, :15, :30 and :45) and record CPU.
2. Deploy pipeline: `scripts/deploy-staging.mjs` is the only deploy path. Document the production equivalent in the cutover plan.
3. Per-route CPU for unrelated routes (analytics `workersInvocationsAdaptive`, one route type per minute window).
4. All wedding screens as Payload views. The view generalises through the bridge; list the screens from `worker/portal/pages.ts`.
5. PR #48 compatibility: test-rebase in a throwaway worktree, run the platform suite and record conflicts. Don't merge.
6. Investigations:
   - D1 overload, 10 Nov around 19:30Z (analytics only, no log access);
   - production workers.dev dependencies (code search plus analytics). Disabling it needs a production deploy, which is not allowed: prepare the change only.
7. Staging hostname and Access: prepare config and scripts only. Attaching a hostname needs approval.
8. Auth, session and direct-URL tests (as far as possible without real Access).
9. Rollback rehearsal on staging: `wrangler rollback --env staging`, then re-check.
10. Scope and timeline review (owner asked to challenge the 7–9 weeks), and a cutover plan.

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

- Cron CPU on staging after the due-jobs gate.
- Per-route CPU comparison.
- Remaining wedding screens in the browser (`e2e-platform/custom-view.mjs`).
- PR #48 rebase run.
- Staging rollback rehearsal.
