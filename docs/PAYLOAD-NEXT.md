# Payload migration: how to resume

Read this first if you are a Claude Code session picking up this work.

## Phase 3: wedding publishing fixed, portal retired (directive 11 Nov 2026 ~09:35Z, current)

- Journal: `docs/PAYLOAD-FRONTEND-LOG.md` ("Phase 3"). Dependency map: `docs/PAYLOAD-PORTAL-RETIREMENT.md`.
- **Publishing fix live:** #53, production `d982daf3` (rollback `b13e3104`). Verified on both wedding addresses.
- **Portal retirement:** branch `feature/retire-portal`; PR, deploy and production checks follow (see the log).
- The wedding and administration screens' browser suite runs inside Payload: `npx playwright test -c playwright.admin.config.ts` (needs `npm run poc:build` in `poc/payload`).
- Next directive queued by the owner: **Phase 4, projects-first homepage redesign.** Do it on its own branch, publish to staging only, and **stop for the owner's visual approval before the live homepage changes.**

## Phase 2: the website in Payload (directive 11 Nov 2026, current)

- Plan and audit: `docs/PAYLOAD-FRONTEND-PLAN.md`. Journal: `docs/PAYLOAD-FRONTEND-LOG.md` (read its last entries).
- Branch `feature/payload-website` (from `origin/main` `417d9f7`). Window: six hours from ~08:20Z.
- Authority: standing approval for reversible, verified deploys. Not approved: destructive migrations (0032/0033 stay in `docs/pending`), irreversible data changes, weaker security, paid services, redirecting `wedding.daly.id.au`.
- Design: Payload publishes snapshots into D1 `meta`; the public renderer reads them (`worker/site/`). Public pages never start Payload.
- Verify around every production change: `node scripts/public-baseline.mjs compare`, `node scripts/wedding-fingerprint.mjs compare`, `node scripts/visual-baseline.mjs capture output/visual/<name>` then `compare output/visual/prod-before output/visual/<name>`.
- Local real-Payload checks (CI order): fresh `--persist-to` state, `wrangler d1 migrations apply DB --local`, `blog.mjs --seed`, `wrangler dev --local --port 8790 --env-file .dev.vars.authz`, then `site.mjs`, `blog.mjs`, `authz.mjs`.

## Earlier phases

The rest of this file is Phase 0/1 and the cutover; its journal is `docs/PAYLOAD-AUTONOMOUS-LOG.md`.

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

## Current state (11 Nov 2026, 08:05Z): Payload is in production

- **Production:** `924ecbf2-92e4-4a21-884b-f5e944ab4063` (#49, `209757c`), verified (see the log's "CUTOVER" entry). The blog has been imported into Payload.
- **Rollback:** `npx wrangler rollback dd843586-a981-41b1-a3eb-a78ef10a3c2c --name dalyidau -y` (code only, ~3 s; no wedding data step). Undoing the blog import is optional: Payload's migration `down` (or set `posts.source` back from `legacy.originalRow`). The old code renders the posts as they are either way.
- **Access:** application `daly.id.au` (`8d982c04…`) now has 15 destinations (the 2 originals plus 13 Payload paths). The policy is unchanged.
- **Held back (never apply without the owner's fresh written approval):** `docs/pending/0032`, `0033`; unused secrets kept.

## Outstanding

- `weddingplanner.daly.id.au` needs its own Access destination (pre-existing).
- Verify the admin, editor and viewer roles live when those people next sign in (CI covers them).
- Optional: website pages (about/contact) in Payload; retire `/portal/wedding` once the Payload admin is preferred; the `message-page.tsx` typing quirk.

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
