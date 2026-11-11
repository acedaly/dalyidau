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

## Current state (11 Nov 2026, ~07:30Z)

- **PR #48 merged** (`0695744`). Production version **`dd843586-a981-41b1-a3eb-a78ef10a3c2c`**, verified: public 22/22 unchanged, wedding 24/24 identical, 188 tables (nothing dropped). 0032/0033 stay in `docs/pending/`.
- **PR #49** (draft, `feature/payload-phase1`) is rebased on main. CI and Payload workflows are green (suite, build/size, blog e2e, authz matrix, browser checks).
- **Ready in production:** D1 `dalyidau-payload`, R2 `dalyidau-payload-media` (both empty), PAYLOAD_SECRET and PAYLOAD_JOBS_SECRET. `production-config.mjs` passes.
- **Rollback target** for the cutover: `dd843586-a981-41b1-a3eb-a78ef10a3c2c`.
- **Blocked, permission:** Cloudflare Access. Chrome isn't signed in to the dashboard, and Wrangler's token can't see Access applications (lists 0). The owner must either sign in to the dashboard in Chrome or provide an API token with "Access: Apps and Policies Edit" (set it as `CLOUDFLARE_ACCESS_TOKEN` in the shell; never commit it).

## Next steps

1. 🔒 **Access** (needs the above). On the existing portal application, keep every existing destination and policy and **add** the destinations `daly.id.au/admin`, `/api/users`, `/api/media`, `/api/pages`, `/api/posts`, `/api/payload-preferences`, `/api/payload-locked-documents`, `/api/payload-kv`, `/api/payload-jobs`, `/api/payload-migrations`, `/api/globals`, `/api/access`. Save the application JSON before and after.
2. Fresh backups (`npm run db:backup -- --env production`, `node scripts/r2-bucket-backup.mjs dalyidau-media`), public baseline and wedding fingerprint.
3. Mark #49 ready and merge. CI deploys the combined Worker and smoke-checks it.
4. Verify: baseline compare (`/admin` and `/api/*` now redirect to Access, which is expected), wedding compare, `/admin` sign-in as the owner, `/admin/wedding`, `/admin/collections/posts`. The two imported posts must stay byte-identical. Then a draft, publish, slug change and unpublish on a test post; media upload.
5. On any critical failure: `npx wrangler rollback dd843586-a981-41b1-a3eb-a78ef10a3c2c --name dalyidau -y`, then re-verify.

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
