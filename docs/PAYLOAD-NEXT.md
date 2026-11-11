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

## Current state (11 Nov 2026, 06:30Z)

- **Branch** `feature/payload-phase1`, pushed; draft **PR #49**. Rebased on PR #48 (`origin/retire-portal`, `4ed0a0e`, with migration 0032 held back in `docs/pending/`).
- **Production:** unchanged code (7a1a1c4). New versions only from adding Payload's two secrets. **Rollback target: `8c82618c-18bf-456b-9d09-8e3d1315a368`** (today's code plus the secrets; earlier `de231899`).
- **Created:** D1 `dalyidau-payload` (`857fc770-…`), R2 `dalyidau-payload-media` (both empty); secrets PAYLOAD_SECRET and PAYLOAD_JOBS_SECRET on `dalyidau`.
- **Staging** `dalyidau-payload-staging` runs `f2be3f6` (version `3750d5bf`), with no routes; isolation checks pass.
- **Backups (11 Nov 05:40Z):** `backups/production-2026-11-11T05-40-22-671Z.sql` (restore-tested), `backups/r2-bucket-dalyidau-media-2026-11-11T05-41-06-514Z` (95 objects verified). Baseline and fingerprint are in the scratchpad; re-capture before the cutover.

## Next steps, in order (each blocked item needs the owner)

1. 🔒 **Merge PR #48.** The session classifier refused `gh pr merge` because it deploys. CI then deploys it. Verify with `node scripts/public-baseline.mjs capture`/`compare` and `node scripts/wedding-fingerprint.mjs`.
2. Rebase #49 on main (`git rebase --onto origin/main origin/retire-portal`), then push.
3. 🔒 **Access paths** on the portal application (needs a signed-in dashboard; Wrangler can't do it): `admin`, `api/users`, `api/media`, `api/pages`, `api/posts`, `api/payload-preferences`, `api/payload-locked-documents`, `api/payload-kv`, `api/payload-jobs`, `api/payload-migrations`, `api/globals`, `api/access`. The Worker reads only the `Cf-Access-Jwt-Assertion` header, so every Payload path must be covered.
4. Fresh backups, baseline and fingerprint.
5. 🔒 **Merge #49** (the cutover: CI deploys the combined Worker). Smoke checks, then baseline/fingerprint compare, then `/admin` sign-in, `/admin/wedding`, `/admin/collections/posts`. The two imported posts must stay byte-identical. Roll back on any failure.
6. Optional: the staging hostname behind Access (plan A); Pages content in Payload; monitoring workflow.

## Results so far

- Root 463/463 + 18/18; platform 489/490 (PDF-preview timeout under load, 13/13 alone); blog e2e 36/36 on fresh state; authz matrix all passed; `test:backup` passed with nothing dropped.
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
