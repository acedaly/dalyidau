# Payload migration: how to resume

Read this first if you are a Claude Code session picking up this work. Then read the last entries of `docs/PAYLOAD-AUTONOMOUS-LOG.md`.

## Window and authority

- **Phase 2 directive (owner, 11 Nov 2026 ~05:30Z):** complete the Payload migration through staging and **production**, autonomously, including: reviewing and merging PR #48 if verified safe; pushing the Payload branch and CI workflows; creating D1/R2/other Cloudflare resources; the staging hostname and Cloudflare Access; Payload's production Access paths and secrets; native Payload website/blog management; migrating the blog into Payload (content, media, URLs, SEO preserved); staging and production deploys; tests, backups, monitoring and rollback procedures. Don't stop at milestones.
- **Window:** assumed to run until **2026-11-14T05:40Z** (72 h; the directive gave no end). The supervisor uses this deadline.
- Make routine technical decisions yourself and record why in the log.

## Safety boundaries (always in force)

Mandatory before any production deploy (record evidence in the log):

1. production data backed up **and** restore-tested (`npm run db:backup -- --env production`; `node scripts/r2-bucket-backup.mjs dalyidau-media`);
2. Cloudflare Access protects every administrative route (`node scripts/public-baseline.mjs capture` checks the private paths);
3. production users and permissions work;
4. CI and integration tests pass;
5. blog content, media, URLs, RSS and SEO preserved (`public-baseline.mjs compare`);
6. wedding guest records, RSVPs and seating unchanged (`node scripts/wedding-fingerprint.mjs capture/compare`);
7. deployment and rollback rehearsed;
8. no secrets in logs, commits or client code.

Never:

- delete existing production data, remove backups, disable authentication or do anything irreversible. **Migration 0032 (drop of 84 retired tables) is held back** in `docs/pending/` for this reason;
- migrate or remove wedding data;
- buy services or accept material recurring costs;
- weaken production security to make a deploy work;
- deploy if a critical security or data-integrity check fails. If a validation fails: fix it or roll back.
- change DNS, or the root `routes` block, beyond what the directive covers (the Payload staging hostname);
- send real email/SMS or switch features on.

Deploy incrementally; verify the live site, blog and wedding after each change.

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
