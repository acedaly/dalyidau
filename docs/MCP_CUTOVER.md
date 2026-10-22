# MCP cutover and DalyHub decommissioning

The ordered plan for moving `mcp.daly.id.au` from the DalyHub-V2 gateway to the gateway in this repository ([MCP.md](MCP.md)), then retiring DalyHub V2, and the release of gateway **3.0.0**, which retires the Daly Knowledge and Daly Tasks tools. **Every production step needs the owner's approval** and is run by hand. Nothing here merges, deploys, migrates a remote database, or changes DNS, Access or secrets on its own.

## Gateway 3.0.0: Knowledge and Tasks retired

Daly Knowledge, Daly Tasks, the Daily Planner and Intelligence's capture and suggestions are retired ([DECOMMISSION_KNOWLEDGE_TASKS.md](DECOMMISSION_KNOWLEDGE_TASKS.md)). Gateway 3.0.0 advertises **66 tools (14 writes)**: chief of staff (2), Daly Intelligence briefings (2), Calendar and leave (17), Today (3, read-only), the Intelligence Centre (28) and Home & Assets (14). The **51 retired tools** are answered with `"retired"`:

- by the gateway (3.0.0), after authentication and the rate limit, as an `isError` result with `code: "retired"`, without reaching the portal;
- by the portal entrypoint, after verifying the Access token and before anything is read, whichever gateway sent the call. So a 2.x gateway still advertising them can't reach a retired record.

**Order: portal first, then the gateway.**

1. **Back up** D1 and R2 as in [DECOMMISSION_KNOWLEDGE_TASKS.md](DECOMMISSION_KNOWLEDGE_TASKS.md#export-and-verified-backup).
2. **Portal.** Merge and deploy the portal Worker (no new migrations). Retired tools are refused at the portal; gateway 2.x keeps working for every remaining tool.
3. **Gateway 3.0.0, by hand:**
    ```sh
    npx wrangler deployments list --name dalyhub-mcp   # record the current version id for rollback
    npm run test:mcp
    npm run mcp:deploy:dry-run                          # bindings must be exactly PORTAL, MCP_CALLS, MCP_WRITES
    npx wrangler deploy --config mcp/wrangler.jsonc --env production
    ```
4. **Reconnect or refresh** the Claude and ChatGPT connectors so they pick up the shorter list, then run the [real-client checks](#real-client-testing).

A 3.0.0 gateway in front of an older portal would still work, but would describe tools the old portal also has; portal first keeps both layers consistent.

**Rollback:** `npx wrangler rollback <version id from step 3> --name dalyhub-mcp` brings back the 2.x tool list, whose retired tools the portal still refuses. Rolling back the portal too brings Knowledge and Tasks back exactly as they were, because their data is untouched.

---

The rest of this document is the original cutover plan from DalyHub-V2 (October 2026). Its tool counts and checks have been updated for 3.0.0; the DalyHub data migration it once included was removed with Daly Knowledge and Daly Tasks.

## Where things stood (18 October 2026)

| What                         | State                                                                                                                                                                                                     |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Live `dalyhub-mcp` Worker    | Last deployed **21 September** from DalyHub-V2: the original 34 DalyHub tools only, no portal tools, no owner gate. DalyHub-V2 PR #311 (portal tools + owner gate) was **never deployed**                 |
| Live `dalyidau` Worker       | Last deployed 18 October 02:40 UTC, before #28 merged (02:50). So `PortalMcpEntrypoint` and migration `0018` were **probably not live**; step 2 checks. CI's Cloudflare token had failed since 14 October |
| `MCP_ACCESS_AUD` on dalyidau | Not set as far as known; step 2 checks by name                                                                                                                                                            |

**Consequence.** For anyone connected to the DalyHub gateway, the cutover swaps the entire tool list: the 34 DalyHub tools go and the Daly Portal tools arrive. So the order is: **portal first, then the gateway**.

## What's implemented, what needs activation, what waits

| Implemented and tested                                                                   | Needs production activation (owner approval)                      | Waits until the cutover is stable                                            |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Gateway Worker `mcp/` with no DalyHub dependency                                         | Deploy `dalyidau` (CI or by hand), applying its migrations        | Deleting any DalyHub Worker, database, bucket or secret                      |
| 66 portal tools, double token check, permissions, retries, logs, rate limits             | `MCP_ACCESS_AUD` secret on dalyidau                               | Adding further people to the MCP Access policy (safe after step 5; optional) |
| Removal of the 34 DalyHub tools and the 51 retired portal tools                          | Gateway deploy over `dalyhub-mcp`                                 | Archiving DalyHub-V2 and closing #311                                        |
| Tests: protocol, isolation from DalyHub, two identities, contract, retired tools, backup | Access redirect URIs for Claude Code / Codex / ChatGPT, if wanted | Removing `DALYHUB_OWNER_EMAILS` from `dalyhub-mcp`                           |

## Ordered production cutover

Run from a clean checkout of `main`. Record the time of each step.

### 0. Freeze and record (read-only)

1. Record the rollback targets:
    - `npx wrangler deployments list --name dalyhub-mcp`: note the current **version id**.
    - `npx wrangler deployments list --env=""`: note the current dalyidau version id.
    - `npx wrangler d1 time-travel info DB --env=""`: note the portal D1 bookmark.
2. Back up: `npm run db:backup` (portal), and DalyHub's encrypted **Production D1 backup** workflow.

### 1. Portal: secret (approval: secrets)

`npx wrangler secret put MCP_ACCESS_AUD --env=""` with the AUD tag of the `mcp.daly.id.au` Access application (the same value as the gateway's `POLICY_AUD`). Harmless before the deploy: a Worker without the entrypoint ignores it. Check by name: `npx wrangler secret list --env=""`.

### 2. Portal: deploy (approval: deploy and remote migrations)

Merging to `main` makes the deploy workflow record a D1 bookmark, apply pending migrations, and deploy `dalyidau`. While its token is broken, run by hand: `npx wrangler d1 migrations apply DB --remote --env=""`, then `npx wrangler deploy --env=""`. Then check:

- `npx wrangler d1 migrations list DB --remote --env=""` shows every migration applied.
- `node scripts/db-verify.mjs --env production` passes.
- The site, portal and wedding pages load. The Wedding Planner is untouched by this change, but check it anyway.

A gateway that doesn't bind to the portal is unaffected by this step.

### 3. DalyHub data (no longer migrated)

The DalyHub import (`/api/portal/migrations/dalyhub`, `scripts/dalyhub-plan.mjs`) was removed with Daly Knowledge and Daly Tasks, which it imported into, and now answers 410. DalyHub's data stays in its own database and backups until the decommissioning checklist below.

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

There are no single-owner tools, so admitting another person to the `mcp.daly.id.au` Access policy only gives them their own and shared portal data. Give them a portal role with the applications they need (Calendar, Home & Assets, the Intelligence Centre) first, then repeat the two-person checks below with their account.

### 7. Optional, later: rename the Worker

Renaming `dalyhub-mcp` to `daly-mcp` is cosmetic. If wanted, do it once everything is stable: rename it in the dashboard (Workers → dalyhub-mcp → Settings), check the Custom Domain followed it, then change `env.production.name` in `mcp/wrangler.jsonc` to match. Until then the name must stay `dalyhub-mcp`, or a deploy would create a second Worker with no domain or secrets.

## Real-client testing

Do these in order, in **Claude (web)** first, then **Claude Code**, **ChatGPT** (developer mode) and **Codex**. Check each client's redirect URI is allowed in the Access application before trying it. Record pass/fail per client.

| #   | Ask the client                                         | Expect                                                                                                                                                                   |
| --- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | List your tools                                        | 66 tools, all Daly Portal (`calendar_*`, `leave_*`, `today_*`, `centre_*`, `assets_*`, `intelligence_*`, `chief_of_staff_*`); no `tasks_*`, `knowledge_*` or `get_today` |
| 2   | "Brief me from my Daly Portal"                         | Calls `chief_of_staff_daily_context`; events and Home & Assets items match the portal                                                                                    |
| 3   | "What's on today, and how busy am I?"                  | `today_get_summary` or `today_get_capacity`; matches `/portal/today`                                                                                                     |
| 4   | "Add 'MCP cutover test' to my calendar tomorrow at 9"  | Client asks before writing; one event appears; `mcp_writes` has one `done` row                                                                                           |
| 5   | Ask it to do 4 again in the same conversation          | No duplicate if the client reused its requestId; otherwise a second event (delete it by hand)                                                                            |
| 6   | "Show my tasks" (a client with a cached old tool list) | A `tasks_*` call answers `"retired"`, and the client says Daly Tasks is retired                                                                                          |
| 7   | Second person (if admitted): "List my calendars"       | Only their own and shared calendars; never the owner's personal ones                                                                                                     |
| 8   | Second person: ask for the owner's private event by id | `not_found`                                                                                                                                                              |
| 9   | Sign out of Access, then call a tool                   | The client asks to sign in again; no data                                                                                                                                |

## Monitoring

Workers Observability (dashboard → Workers → the Worker → Logs, or the Query Builder). There's nothing to set up, and no paid alerting.

| Signal                                         | Where                                                                                                                               | Normal                                                                         | Act when                                                        |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| `mcp_call` with `ok: false`, grouped by `code` | `dalyidau` logs                                                                                                                     | Occasional `not_found`, `validation`, `conflict`; `retired` from stale clients | Any `unavailable`, or `unauthenticated` from a signed-in client |
| `mcp_auth_refused` by `reason`                 | `dalyidau` logs                                                                                                                     | None                                                                           | `wrong_audience` (`MCP_ACCESS_AUD` wrong), `keys_unavailable`   |
| `mcp_gateway_refused` by `status`              | `dalyhub-mcp` logs                                                                                                                  | Some 401 (clients refreshing tokens)                                           | Any 503 (auth not configured); repeated 429                     |
| `mcp_gateway_retired_tool` by `tool`           | `dalyhub-mcp` logs                                                                                                                  | A few, right after 3.0.0                                                       | Persisting for one client: reconnect it                         |
| HTTP 5xx and exceptions                        | both Workers                                                                                                                        | None                                                                           | Any                                                             |
| `mcp_tool_error`                               | `dalyidau` logs                                                                                                                     | None                                                                           | Any: a bug, with the tool name and error class                  |
| Failed writes                                  | `SELECT tool, error_code, COUNT(*) FROM mcp_writes WHERE status = 'failed' AND created_at > datetime('now','-1 day') GROUP BY 1, 2` | Low                                                                            | A rising count for one tool                                     |

Check daily for the first week, then weekly until DalyHub is decommissioned.

## Rollback

Fastest first. None of these touch DNS or Access.

1. **Stop portal access through MCP at once:** `npx wrangler secret delete MCP_ACCESS_AUD --env=""`. Every portal tool call is refused (`unauthenticated`). The rest of the portal is unaffected.
2. **Gateway back to an earlier version:** `npx wrangler rollback <version id> --name dalyhub-mcp`. Rolling back to the 21 September DalyHub gateway serves DalyHub's 34 tools to **everyone the Access policy admits, without an owner gate**, so **if anyone besides the owner was added in step 6, remove them from the Access policy first.** DalyHub itself must still exist for that to work, which is one reason decommissioning waits.
3. **Portal:** `npx wrangler rollback <version id> --env=""`. Leave applied migrations in place: earlier Workers ignore what they don't know, and the rebuilt `mcp_writes` accepts everything an earlier Worker writes.
4. Last resort for the whole portal database: D1 Time Travel to the bookmark from step 0, which also undoes every other change since.

## DalyHub decommissioning checklist

Start only when all of these hold: the cutover has been stable for at least **30 days**, the People decision is made, and the owner approves. Each deletion is separate, needs explicit approval, and is irreversible. **Disable before deleting**, and keep everything restorable until the last step.

### A. Final backups (before anything is switched off)

- [ ] Run DalyHub's encrypted **Production D1 backup** workflow. Download the artifact and store it offline (encrypted). Record its SHA-256.
- [ ] Take the canonical in-app export (DalyHub → Settings → Privacy & data → "Download full DalyHub export") and store it with the D1 dump.
- [ ] Copy R2 `dalyhub-v2-attachments` and `dalyhub-v2-backups` to offline storage (for example `rclone` with R2 credentials), and check object counts match.
- [ ] Record the `dalyhub-v2` D1 Time Travel bookmark (restorable for 30 days).
- [ ] **Prove the backup restores:** decrypt the dump locally, load it into SQLite (`sqlite3 restore.db < dump.sql`) and check its row counts match the live database, then delete the plaintext.
- [ ] Tag the DalyHub-V2 repository at its final commit (`git tag final-2026-xx-xx`) so the code that matches the backup can be rebuilt.

### B. Remove the ways back in (reversible)

- [ ] Close DalyHub-V2 PR #311 as superseded, and leave the stale `feature/daly-mcp-portal-integration` branches until the owner says to delete them.
- [ ] In DalyHub-V2, remove or disable the `mcp:deploy:*` scripts, so nobody can redeploy the old gateway over `dalyhub-mcp`.
- [ ] Remove `DALYHUB_OWNER_EMAILS` from `dalyhub-mcp` (`npx wrangler secret delete DALYHUB_OWNER_EMAILS --name dalyhub-mcp`), if it was ever set. This gateway never reads it.
- [ ] Remove the portal's `DALYHUB_MIGRATION` secret, if it was ever set: nothing reads it any more.
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
4. Take a canonical in-app export to confirm the restore.
