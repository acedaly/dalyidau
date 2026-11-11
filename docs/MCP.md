# Daly MCP: Daly Portal for AI clients

AI clients (Claude, ChatGPT, Codex and other MCP clients) connect to `https://mcp.daly.id.au/mcp`. Since 9 Nov 2026 **Daly Portal serves no tools through it**: every application that had tools was retired ([DECOMMISSION_PORTAL_APPS.md](DECOMMISSION_PORTAL_APPS.md)), and the gateway answers any of their tools with `"retired"`. The gateway's Cloudflare OS tools (Personal Tasks and Knowledge) are on branch `mcp-cloudflare-os-r003399`, not on `main`; deploy the gateway only from a merge with that branch. The service lives in this repository:

- `mcp/`: the gateway Worker. It handles the MCP protocol, tool descriptions, Access token checks and per-person rate limits.
- `worker/mcp/`: `PortalMcpEntrypoint` in the portal Worker. It verifies identity and permissions, and refuses retired tools. It serves no tools, and has no write ledger any more.

There's no DalyHub V2 runtime dependency: no DalyHub Worker, database, `ChiefOfStaffEntrypoint` or service binding. Moving production over was a separate, owner-approved step: [MCP_CUTOVER.md](MCP_CUTOVER.md).

> **Daly Knowledge and Daly Tasks are retired** (gateway 3.0.0). Every `knowledge_*`, `tasks_*` and `planner_*` tool, Intelligence's capture and suggestion tools, Today's planning tools and Home & Assets' task and Knowledge links were removed. Calling one gets a `"retired"` answer (below). See [DECOMMISSION_KNOWLEDGE_TASKS.md](DECOMMISSION_KNOWLEDGE_TASKS.md#mcp).

> **Home & Assets and Household Finance are retired** (1 Nov 2026, gateway 3.2.0), replaced by Home and Finances in Cloudflare OS. The 14 `assets_*` tools are refused with `"retired"` by the portal (and by gateway 3.2.0 once it's deployed), and the Chief of Staff context no longer has a Home & Assets section. Household Finance never had tools. See [DECOMMISSION_ASSETS_FINANCE.md](DECOMMISSION_ASSETS_FINANCE.md#mcp).

## Architecture decision (October 2026)

**Decision.** MCP is a permanent Daly Portal capability. The gateway moved from DalyHub-V2 (`workers/dalyhub-mcp`) into this repository as its own small Worker (`mcp/`), bound only to the portal's existing `PortalMcpEntrypoint`. The 34 DalyHub tools were removed, not ported. In production it deploys **under the existing Worker name `dalyhub-mcp`**, so the `mcp.daly.id.au` Custom Domain, the Access application in front of it and its `TEAM_DOMAIN`/`POLICY_AUD` secrets stay exactly as they are.

**Options considered.**

| Option                                                                                    | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Keep the gateway in DalyHub-V2, unbind DalyHub                                         | Rejected. The repository being decommissioned would keep owning a permanent service.                                                                                                                                                                                                                                                                                                                                                              |
| B. Serve `/mcp` from the `dalyidau` Worker itself                                         | Rejected for now. It would put the MCP SDK and `agents` (about 1.3 MB) and `nodejs_compat` into the Worker that serves the public site and the wedding pages, whose CPU has already needed work. It would also need a `routes` change in `wrangler.jsonc` plus a Custom Domain move (owner approval), and it gives MCP and the website one shared rollback. It saves no money: service binding calls are free. It stays possible later if wanted. |
| **C. A separate gateway Worker in this repository, deployed over `dalyhub-mcp` (chosen)** | Smallest change in production: the code only. It keeps defence in depth, since the token is checked twice by two independent implementations. Rollback is one `wrangler rollback`. No new paid infrastructure.                                                                                                                                                                                                                                    |
| C′. The same, as a new Worker `daly-mcp` with the domain moved to it                      | Possible later (optional rename, see the cutover doc). Doing it first would add a Custom Domain move and two new secrets to the cutover, for a cosmetic gain.                                                                                                                                                                                                                                                                                     |

**What stayed the same in the move.** The public URL, Access Managed OAuth (dynamic client registration, no client secrets), the gateway's JWT check (`jose`, RS256, issuer, MCP application audience, non-empty `sub`), the portal's second check (`verifyMcpAssertion` against `MCP_ACCESS_AUD`), the MCP stack (`createMcpHandler` from `agents` on `@modelcontextprotocol/server`, stateless Streamable HTTP, `/mcp` only, Host validation), and the rate-limit namespaces, so the live counters carried over. The gateway and portal tool lists are compared field by field in one test (`test/mcp-contract.test.ts`).

## How a call flows

```text
Claude / ChatGPT / Codex
  │  HTTPS, OAuth through Cloudflare Access Managed OAuth (MCP server application)
  ▼
mcp.daly.id.au/mcp — gateway Worker (mcp/, deployed as "dalyhub-mcp")
  │  verifies the Access JWT (jose: signature, issuer, MCP application AUD, RS256, sub)
  │  per-person rate limit (Access subject): 120 requests a minute
  │  a retired tool name is answered here with "retired"
  │  MCP protocol; first-pass input validation against the advertised schemas
  │  writes: a second limit, 30 a minute
  ▼
PORTAL service binding → dalyidau :: PortalMcpEntrypoint.invoke({ assertion, tool, input })
  │  verifies the forwarded Access JWT AGAIN (worker/portal/access.ts), against MCP_ACCESS_AUD
  │  email → portal role (PORTAL_OWNER_EMAILS, then an active portal_users row)
  │  retired tool → "retired"; a tool it doesn't serve → "unknown_tool" (today: every other name)
  │  (a tool it served would then check its permission and strict input schema)
  ▼
D1 (dalyidau-production): only portal_users, to find the caller's role
```

The gateway has no database, storage, queue or Durable Object binding (`test/mcp-gateway/isolation.test.ts` checks `mcp/wrangler.jsonc`). The portal has no MCP protocol code. There is one data system: the portal's D1.

## Trust model

- **Authentication happens twice.** Access authenticates the person and the gateway checks the token. The portal doesn't take the gateway's word for who's calling: the gateway forwards `Cf-Access-Jwt-Assertion` exactly as received, and `verifyMcpAssertion` checks it again against the MCP application's audience only (never the portal's `ACCESS_AUD`), plus expiry, not-before and a real email. A portal browser token is refused, and so are expired, forged and service tokens.
- **No identity in arguments.** Every schema is strict and none has an email, user, owner or actor field (`test/mcp-contract.test.ts`).
- **The portal's rules, unchanged.** Roles come from `userForEmail`, exactly as for a browser sign-in. Retired tools are refused before anything else is read, whatever the role.
- **Who can call the entrypoint.** A named entrypoint has no route. Any Worker on the account could bind to it, which is why it trusts only what the token proves. If `MCP_ACCESS_AUD` is unset, every call is refused.
- **Errors don't leak.** Anything the caller can't reach is `not_found`. Storage errors become `unavailable`. An unreachable portal is `unavailable` ("Do not treat this as an empty result"), never an empty list.
- **Logs.** The gateway logs `mcp_gateway_refused` with an HTTP status only, and `mcp_gateway_retired_tool` with the tool name. The portal logs one `mcp_call` line per call (tool, ok, error code, duration) and `mcp_auth_refused` with a reason. Never a person, token, argument or result (`isolation.test.ts` checks this).

## Tools

The portal serves **none** (`PORTAL_MCP_TOOLS` in `worker/mcp/entrypoint.ts` is empty, and so is `PORTAL_TOOL_NAMES` in `mcp/src/portal-tools.ts`). With no tools, the gateway offers no tools capability: `tools/list` answers "method not found". A new portal tool would be a read with a permission (`worker/mcp/shared.ts`), listed on both sides with the same argument names.

### Retired tools

The **121 retired tools** are listed by retirement in `worker/mcp/retired.ts` (`RETIRED_MCP_GROUPS`) and `mcp/src/portal-tools.ts` (`RETIRED_TOOL_GROUPS`); `test/mcp-contract.test.ts` checks the two match and that none is advertised:

| Retirement                                                                                         | Tools                                                                                                                                                                 | Since         |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| Daly Knowledge and Daly Tasks ([DECOMMISSION_KNOWLEDGE_TASKS.md](DECOMMISSION_KNOWLEDGE_TASKS.md)) | 51: every `knowledge_*`, `tasks_*` and `planner_*` tool, Intelligence's capture and suggestion tools, Today's planning tools, Home & Assets' task and Knowledge links | gateway 3.0.0 |
| Home & Assets ([DECOMMISSION_ASSETS_FINANCE.md](DECOMMISSION_ASSETS_FINANCE.md))                   | 14 `assets_*`                                                                                                                                                         | 3.2.0         |
| Daly Calendar and the Leave Planner ([DECOMMISSION_PORTAL_APPS.md](DECOMMISSION_PORTAL_APPS.md))   | 17 `calendar_*` and `leave_*`                                                                                                                                         | 4.0.0         |
| Today and its Chief of Staff context                                                               | 5: `today_get_*`, `chief_of_staff_daily_context`, `chief_of_staff_weekly_context`                                                                                     | 4.0.0         |
| Daly Intelligence's briefings                                                                      | 2: `intelligence_get_daily_briefing`, `intelligence_get_weekly_review`                                                                                                | 4.0.0         |
| The Intelligence Centre                                                                            | 28 `centre_*`                                                                                                                                                         | 4.0.0         |
| Amplenote                                                                                          | 4 `amplenote_*`                                                                                                                                                       | 4.0.0         |

- **The gateway** answers `tools/call` for a retired name itself, after authentication and the rate limit, with an `isError` result whose `code` is `"retired"` and whose message names the retirement. The call never reaches the portal.
- **The portal entrypoint** refuses it with `"retired"` after verifying the Access token, before anything is read, whatever the caller's role. So an older gateway that still advertises them can't reach a retired record either.

The 34 tools the DalyHub-backed gateway served are gone too: none is listed, and calling one is an error (`test/mcp-gateway/protocol.test.ts`).

## Writes

There are no write tools, so there's no write ledger in the code any more. `mcp_writes` (migration `0018` and its rebuilds) keeps its history until [docs/pending/0033](pending/0033_drop_retired_portal_app_tables.sql) is approved.

## Configuration

| Where                                 | Name                        | What                                                                                                       |
| ------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------- |
| dalyidau (secret)                     | `MCP_ACCESS_AUD`            | AUD tag of the `mcp.daly.id.au` Access application (the gateway's `POLICY_AUD`). Unset: every call refused |
| dalyidau                              | `ACCESS_TEAM_DOMAIN`        | Already set for the portal. The MCP application is on the same team                                        |
| gateway `dalyhub-mcp` (secrets, kept) | `TEAM_DOMAIN`, `POLICY_AUD` | Already on the existing Worker; deploying the new code doesn't touch them                                  |
| gateway                               | `PORTAL` service binding    | `dalyidau` / `PortalMcpEntrypoint` (locally too). No longer needed by any tool; kept, and harmless         |
| gateway                               | `MCP_CALLS`, `MCP_WRITES`   | Rate Limiting namespaces 4401 and 4402: 120 and 30 per person per minute                                   |
| Access, `mcp.daly.id.au` application  | Allow policy                | Who may connect. Each person then sees only their own and shared portal data                               |

`DALYHUB_OWNER_EMAILS`, if it was ever set on `dalyhub-mcp`, is unused by this code. Removing it is on the decommissioning checklist.

## Releasing a gateway version

The portal first, then the gateway. Each step needs the owner's approval. The gateway is never deployed by CI.

1. **Portal.** Merging to `main` deploys `dalyidau` and applies any migrations. The live gateway keeps working throughout: it advertises its existing tools, and the portal serves them (retired ones are refused with `"retired"`).
2. **Gateway.** Record the current version id (`npx wrangler deployments list --name dalyhub-mcp`), then `npm run mcp:deploy:dry-run` and `npx wrangler deploy --config mcp/wrangler.jsonc --env production`. Clients may need to reconnect, or refresh their tool list, to see the change.

For 4.0.0 (Calendar, Today, Intelligence, the Intelligence Centre and Amplenote retired): merge this with branch `mcp-cloudflare-os-r003399` first, or the live Cloudflare OS tools disappear; then deploy. Until then the live gateway advertises the retired tools and the portal refuses them. See [DECOMMISSION_PORTAL_APPS.md](DECOMMISSION_PORTAL_APPS.md#mcp).

For 3.2.0 (Home & Assets retired): merge, then deploy the gateway when convenient; no migration. Until then 3.1.0 advertises the `assets_*` tools and the portal refuses them. Rollback to 3.1.0 only advertises them again. See [DECOMMISSION_ASSETS_FINANCE.md](DECOMMISSION_ASSETS_FINANCE.md#deployment-order).

For 3.1.0 (Amplenote): merge (migration `0030` rebuilds `mcp_writes`; back up first with `npm run db:backup`), then deploy the gateway. Rollback to 3.0.0 only stops advertising the four tools. Nothing reaches Amplenote until the owner switches on Amplenote for AI assistants and reconnects.

For 3.0.0 the full order (backup first) is in [DECOMMISSION_KNOWLEDGE_TASKS.md](DECOMMISSION_KNOWLEDGE_TASKS.md#deployment-order) and [MCP_CUTOVER.md](MCP_CUTOVER.md#gateway-300-knowledge-and-tasks-retired).

**Rollback.**

- **Gateway:** `npx wrangler rollback <previous version id> --name dalyhub-mcp`. A 2.x gateway advertises the retired tools again, but the portal still refuses them.
- **Portal code:** `npx wrangler rollback <version id> --env=""`.
- **Stop all portal access through MCP** at once: `npx wrangler secret delete MCP_ACCESS_AUD --env=""`.

## Connecting AI clients

Server URL: `https://mcp.daly.id.au/mcp` (Streamable HTTP). Authentication: OAuth through Cloudflare Access Managed OAuth with dynamic client registration. There's no client secret, bearer token or API key. Each person signs in as themselves.

- **Claude (claude.ai, desktop, mobile).** Customize → Connectors → Add custom connector → the URL, leave the OAuth fields blank → Connect, then sign in through Access. Redirect URI: `https://claude.ai/api/mcp/auth_callback`. Reconnect it if the tool list looks stale.
- **Claude Code.** `claude mcp add --transport http daly https://mcp.daly.id.au/mcp`, then `/mcp` to sign in. It needs its loopback redirect (`http://localhost:<port>/callback`) in the Access application's allowed redirect URIs.
- **ChatGPT.** Developer mode (Settings → Apps & Connectors → Advanced), a connector with the URL and OAuth. Add the redirect URI ChatGPT shows.
- **Codex (CLI).** `~/.codex/config.toml`: `[mcp_servers.daly]` with `url = "https://mcp.daly.id.au/mcp"`, then `codex mcp login daly`. It needs its loopback redirect URI allowed.
- **Other clients** need Streamable HTTP and OAuth 2.1 with dynamic client registration. Don't weaken Access for clients that can't do that. Service tokens carry no email, so the portal refuses them.

## Costs

No new paid service. The gateway replaces an existing Worker. Service binding calls and Rate Limiting are included with Workers. Each call costs a few D1 reads, and each write one small `mcp_writes` insert and update. No AI inference runs in either Worker.

## Testing

- `npm test` runs both Vitest projects.
- `test/mcp-gateway/` (`vitest.mcp.config.ts`, workerd with `nodejs_compat`, as the gateway runs) drives real MCP JSON-RPC through `mcp/src` into the portal's real `handleMcpCall`. The PORTAL hop structured-clones like Worker RPC. Every outbound request but the Access key set is refused.
    - `protocol.test.ts`: initialize (with the instructions), no tools listed, every retired tool answered with its retirement's message without reaching the portal, none of the 34 legacy tools, `/mcp` only, Access checks, the development token and the Host check.
    - `isolation.test.ts`: the deployable config binds only `PORTAL` (no D1/KV/R2/DO/queues, nothing named DalyHub, no routes). The source imports nothing from DalyHub. A session runs with nothing but the binding, and without it. Rate limits and logs.
- `test/mcp.test.ts` covers the portal entrypoint directly: tokens, roles, no tools served, and every retired tool refused for every role with its retirement's message.
- `test/mcp-contract.test.ts` compares the gateway's tools and retired tools with the portal's.
- `npm run mcp:deploy:dry-run` builds the production gateway bundle and lists its bindings.

## Local development

1. Portal: `npx wrangler d1 migrations apply DB --local --env=""`, then `npx wrangler dev --env="" --var ENVIRONMENT:development --var SITE_URL:http://localhost:8797 --var ACCESS_DEV_EMAIL:you@example.com --var PORTAL_OWNER_EMAILS:you@example.com --port 8797`.
2. Gateway: put `DEV_MCP_TOKEN=<32+ characters>` in `mcp/.dev.vars`, then `npm run mcp:dev` (port 8798). Its `PORTAL` binding finds the local `dalyidau` through the dev registry.
3. Call `http://localhost:8798/mcp` with `Authorization: Bearer <DEV_MCP_TOKEN>`. The gateway forwards the assertion `development`, which the portal accepts only with `ENVIRONMENT=development`, a localhost `SITE_URL` and `ACCESS_DEV_EMAIL`. The gateway accepts the token only with `AUTH_MODE` and `ENVIRONMENT` both `development` and a localhost request. No deployed environment meets any of that.
