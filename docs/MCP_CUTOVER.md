# MCP cutover and DalyHub decommissioning

The ordered plan for moving `mcp.daly.id.au` from the DalyHub-V2 gateway to the gateway in this repository ([MCP.md](MCP.md)), and then retiring DalyHub V2. **Every production step needs the owner's approval** and is run by hand. Nothing here merges, deploys, migrates a remote database, or changes DNS, Access or secrets on its own.

## Where things stand (18 October 2026)

| What                         | State                                                                                                                                                                                                    |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Live `dalyhub-mcp` Worker    | Last deployed **21 September** from DalyHub-V2: the original 34 DalyHub tools only, no portal tools, no owner gate. DalyHub-V2 PR #311 (portal tools + owner gate) was **never deployed**                |
| Live `dalyidau` Worker       | Last deployed 18 October 02:40 UTC, before #28 merged (02:50). So `PortalMcpEntrypoint` and migration `0018` are **probably not live**; step 2 checks. CI's Cloudflare token has failed since 14 October |
| `MCP_ACCESS_AUD` on dalyidau | Not set as far as known; step 2 checks by name                                                                                                                                                           |
| This branch                  | Gateway in `mcp/`, migration tooling, `0019` (additive), tests. Not merged, not deployed                                                                                                                 |

**Consequence.** For anyone connected today, the cutover swaps the entire tool list: the 34 DalyHub tools go and 31 Daly Portal tools arrive. So the order is: **portal first, then data migration, then the gateway**. That way the owner's open work is already in the portal when the DalyHub tools disappear.

## What's implemented, what needs activation, what waits

| Implemented and tested in this branch                                                | Needs production activation (owner approval)                            | Waits until the data migration is verified                                   |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Gateway Worker `mcp/` with no DalyHub dependency                                     | Merge, then deploy `dalyidau` (CI or by hand), applying `0018` + `0019` | Deleting any DalyHub Worker, database, bucket or secret                      |
| 31 portal tools, double token check, permissions, retries, logs, rate limits         | `MCP_ACCESS_AUD` secret on dalyidau                                     | Adding further people to the MCP Access policy (safe after step 5; optional) |
| Removal of the 34 DalyHub tools                                                      | Gateway deploy over `dalyhub-mcp`                                       | Archiving DalyHub-V2 and closing #311                                        |
| Migration planner, preview/apply/revert routes (off by default), provenance tables   | `DALYHUB_MIGRATION` secret while migrating                              | Removing `DALYHUB_OWNER_EMAILS` from `dalyhub-mcp`                           |
| Tests: protocol, isolation from DalyHub, two identities, contract, migration, backup | Access redirect URIs for Claude Code / Codex / ChatGPT, if wanted       |                                                                              |

## Ordered production cutover

Run from a clean checkout of `main` after this branch is merged. Record the time of each step.

### 0. Freeze and record (read-only)

1. Announce a short freeze on DalyHub writes for the migration window.
2. Record the rollback targets:
    - `npx wrangler deployments list --name dalyhub-mcp`: note the current **version id** (the 21 September DalyHub gateway).
    - `npx wrangler deployments list --env=""`: note the current dalyidau version id.
    - `npx wrangler d1 time-travel info DB --env=""`: note the portal D1 bookmark.
3. Back up: `npm run db:backup` (portal), and DalyHub's encrypted **Production D1 backup** workflow.

### 1. Portal: secret (approval: secrets)

`npx wrangler secret put MCP_ACCESS_AUD --env=""` with the AUD tag of the `mcp.daly.id.au` Access application (the same value as the gateway's `POLICY_AUD`). Harmless before the deploy: the current Worker ignores it. Check by name: `npx wrangler secret list --env=""`.

### 2. Portal: deploy (approval: deploy and remote migrations)

Merging to `main` makes the deploy workflow record a D1 bookmark, apply `0018_mcp_writes.sql` and `0019_dalyhub_import.sql` (both additive) and deploy `dalyidau`. While its token is broken, run by hand: `npx wrangler d1 migrations apply DB --remote --env=""`, then `npx wrangler deploy --env=""`. Then check:

- `npx wrangler d1 migrations list DB --remote --env=""` shows `0018` and `0019` applied.
- `node scripts/db-verify.mjs --env production` passes.
- The site, portal and wedding pages load. The Wedding Planner is untouched by this change, but check it anyway.

The live `dalyhub-mcp` doesn't bind to the portal, so this step changes nothing for MCP clients yet.

### 3. Data migration (approval: production data)

Follow [DALYHUB_MIGRATION.md](DALYHUB_MIGRATION.md) steps 2–9: export, plan locally, preview, apply, **verify**, switch off. Don't continue until the owner is satisfied with what's in the portal.

### 4. Gateway: deploy over `dalyhub-mcp` (approval: deploy)

```sh
npm ci
npm run test:mcp                 # gateway tests, locally
npm run mcp:deploy:dry-run       # bindings must be exactly PORTAL (dalyidau#PortalMcpEntrypoint), MCP_CALLS, MCP_WRITES
npx wrangler deploy --config mcp/wrangler.jsonc --env production
```

This uploads new code to the **existing** Worker. It keeps the Custom Domain, the Access application, `TEAM_DOMAIN`, `POLICY_AUD` and the rate-limit namespaces. Wrangler refuses if either required secret is missing. No DNS, route, Access or secret changes. If Wrangler asks about a Worker last deployed from elsewhere, that's DalyHub-V2: confirm.

### 5. Verify as the owner (read-only, then one write)

1. `curl -si https://mcp.daly.id.au/mcp`: Access answers (a redirect or 401). The Worker is never reached without Access.
2. Reconnect the Claude connector (Customize → Connectors → the existing Daly connector → Disconnect / Connect).
3. Run the real-client checks below in Claude web first.
4. Watch the logs (below) for ten minutes.

### 6. Optionally admit other people (approval: Access policy)

There are no single-owner tools any more, so admitting another person to the `mcp.daly.id.au` Access policy only gives them their own and shared portal data. Give them a portal role with Tasks and Knowledge first, then repeat the two-person checks below with their account.

### 7. Optional, later: rename the Worker

Renaming `dalyhub-mcp` to `daly-mcp` is cosmetic. If wanted, do it once everything is stable: rename it in the dashboard (Workers → dalyhub-mcp → Settings), check the Custom Domain followed it, then change `env.production.name` in `mcp/wrangler.jsonc` to match. Until then the name must stay `dalyhub-mcp`, or a deploy would create a second Worker with no domain or secrets.

## Real-client testing

Do these in order, in **Claude (web)** first, then **Claude Code**, **ChatGPT** (developer mode) and **Codex**. Check each client's redirect URI is allowed in the Access application before trying it. Record pass/fail per client.

| #   | Ask the client                                            | Expect                                                                                       |
| --- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 1   | List your tools                                           | 31 tools, all Daly Portal (`tasks_*`, `knowledge_*`, `chief_of_staff_*`); no `get_today`     |
| 2   | "Brief me from my Daly Portal tasks and notes"            | Calls `chief_of_staff_daily_context`; numbers match the portal dashboard                     |
| 3   | "What's overdue?"                                         | `tasks_overdue`; matches Tasks → Overdue                                                     |
| 4   | "Search my notes for <a word in a migrated DalyHub note>" | `knowledge_search` finds the `dalyhub`-tagged page                                           |
| 5   | "Add 'MCP cutover test' to my Inbox for tomorrow"         | Client asks before writing; one task appears; `mcp_writes` has one `done` row                |
| 6   | Ask it to do 5 again in the same conversation             | No duplicate if the client reused its requestId; otherwise a second task (delete it by hand) |
| 7   | "Complete 'MCP cutover test'"                             | Completed in the portal                                                                      |
| 8   | "Append 'checked from <client>' to today's daily note"    | Text appears at the end of the daily note; nothing else changed                              |
| 9   | Second person (if admitted): "List my projects"           | Only their own and shared projects; never the owner's personal ones                          |
| 10  | Second person: ask for the owner's private task by its id | `not_found`                                                                                  |
| 11  | Sign out of Access, then call a tool                      | The client asks to sign in again; no data                                                    |

## Monitoring

Workers Observability (dashboard → Workers → the Worker → Logs, or the Query Builder). There's nothing to set up, and no paid alerting.

| Signal                                         | Where                                                                                                                               | Normal                                           | Act when                                                        |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------- |
| `mcp_call` with `ok: false`, grouped by `code` | `dalyidau` logs                                                                                                                     | Occasional `not_found`, `validation`, `conflict` | Any `unavailable`, or `unauthenticated` from a signed-in client |
| `mcp_auth_refused` by `reason`                 | `dalyidau` logs                                                                                                                     | None                                             | `wrong_audience` (`MCP_ACCESS_AUD` wrong), `keys_unavailable`   |
| `mcp_gateway_refused` by `status`              | `dalyhub-mcp` logs                                                                                                                  | Some 401 (clients refreshing tokens)             | Any 503 (auth not configured); repeated 429                     |
| HTTP 5xx and exceptions                        | both Workers                                                                                                                        | None                                             | Any                                                             |
| `mcp_tool_error`                               | `dalyidau` logs                                                                                                                     | None                                             | Any: a bug, with the tool name and error class                  |
| Failed writes                                  | `SELECT tool, error_code, COUNT(*) FROM mcp_writes WHERE status = 'failed' AND created_at > datetime('now','-1 day') GROUP BY 1, 2` | Low                                              | A rising count for one tool                                     |

Check daily for the first week, then weekly until DalyHub is decommissioned.

## Rollback

Fastest first. None of these touch DNS or Access.

1. **Stop portal access through MCP at once:** `npx wrangler secret delete MCP_ACCESS_AUD --env=""`. Every portal tool call is refused (`unauthenticated`). The rest of the portal is unaffected.
2. **Gateway back to the DalyHub gateway:** `npx wrangler rollback <version id from step 0> --name dalyhub-mcp`. That version serves DalyHub's 34 tools to **everyone the Access policy admits, without an owner gate**. So **if anyone besides the owner was added in step 6, remove them from the Access policy first.** DalyHub itself must still exist for this to work, which is one reason decommissioning waits.
3. **Portal:** `npx wrangler rollback <version id> --env=""`. Leave `0018` and `0019` in place: they're additive and earlier Workers never read them.
4. **Migrated data:** revert the run ([DALYHUB_MIGRATION.md](DALYHUB_MIGRATION.md#8-revert-if-needed)). Last resort for the whole portal database: D1 Time Travel to the bookmark from step 0, which also undoes every other change since.

## DalyHub decommissioning checklist

Start only when all of these hold: the cutover has been stable for at least **30 days**, the data migration is verified, the People decision is made, and the owner approves. Each deletion is separate, needs explicit approval, and is irreversible. **Disable before deleting**, and keep everything restorable until the last step.

### A. Final backups (before anything is switched off)

- [ ] Run DalyHub's encrypted **Production D1 backup** workflow. Download the artifact and store it offline (encrypted). Record its SHA-256.
- [ ] Take the canonical in-app export (DalyHub → Settings → Privacy & data → "Download full DalyHub export") and store it with the D1 dump.
- [ ] Copy R2 `dalyhub-v2-attachments` and `dalyhub-v2-backups` to offline storage (for example `rclone` with R2 credentials), and check object counts match.
- [ ] Record the `dalyhub-v2` D1 Time Travel bookmark (restorable for 30 days).
- [ ] **Prove the backup restores:** decrypt the dump locally, load it into SQLite (`node scripts/dalyhub-plan.mjs <file>` must parse it and report the same counts as the live preview), then delete the plaintext.
- [ ] Tag the DalyHub-V2 repository at its final commit (`git tag final-2026-xx-xx`) so the code that matches the backup can be rebuilt.

### B. Remove the ways back in (reversible)

- [ ] Close DalyHub-V2 PR #311 as superseded, and leave the stale `feature/daly-mcp-portal-integration` branches until the owner says to delete them.
- [ ] In DalyHub-V2, remove or disable the `mcp:deploy:*` scripts, so nobody can redeploy the old gateway over `dalyhub-mcp`.
- [ ] Remove `DALYHUB_OWNER_EMAILS` from `dalyhub-mcp` (`npx wrangler secret delete DALYHUB_OWNER_EMAILS --name dalyhub-mcp`), if it was ever set. This gateway never reads it.
- [ ] Put DalyHub's own Access application(s) on an owner-only policy and announce read-only use.
- [ ] Disable DalyHub's cron triggers (`*/15` on `dalyhub-v2-production`) and its scheduled GitHub workflows, after the final backup.

### C. Unroute (reversible by re-adding)

- [ ] Remove DalyHub's custom domains or routes from `dalyhub-v2-production` (approval: DNS). Keep the Worker deployed but unreachable for 30 days.
- [ ] Remove the DalyHub Access applications once nothing routes to them (approval: Access).

### D. Delete (irreversible; each one separately approved, after the 30 days)

- [ ] Worker `dalyhub-v2-production`.
- [ ] Worker `dalyhub-v2-backup`, once its backups are copied (A).
- [ ] D1 `dalyhub-v2`, only after the restore proof in A, and only once its Time Travel window no longer matters.
- [ ] R2 `dalyhub-v2-attachments` and `dalyhub-v2-backups`, only after the offline copies are verified.
- [ ] DalyHub's secrets and GitHub environment secrets (backup passphrase **only after** the offline backups are confirmed decryptable with a copy kept elsewhere).
- [ ] Archive the DalyHub-V2 repository (read-only). Don't delete it.

**Never delete:** the `dalyhub-mcp` Worker. It _is_ the Daly MCP gateway now, until an optional rename.

### Recovery, if DalyHub is ever needed again

1. Create a new D1 database and load the decrypted dump (`npx wrangler d1 execute <new db> --remote --file dump.sql`), or, within 30 days of deletion, restore with Time Travel.
2. Recreate the R2 buckets from the offline copies.
3. Check out the final tag of DalyHub-V2, put the new database id in its production configuration, and deploy with its `scripts/deploy-production.mjs`.
4. Take a canonical in-app export to confirm the restore, then decide whether to migrate anything more ([DALYHUB_MIGRATION.md](DALYHUB_MIGRATION.md)).
