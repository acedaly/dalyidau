# Daly MCP: Daly Portal for AI clients

AI clients (Claude, ChatGPT, Codex and other MCP clients) reach Daly Calendar and Today, Daly Intelligence's briefings, the Intelligence Centre and Home & Assets at `https://mcp.daly.id.au/mcp`. The whole service lives in this repository:

- `mcp/`: the gateway Worker. It handles the MCP protocol, tool descriptions, Access token checks and per-person rate limits.
- `worker/mcp/`: `PortalMcpEntrypoint` in the portal Worker. It handles identity, permissions, access to each record, data and the write ledger.

There's no DalyHub V2 runtime dependency: no DalyHub Worker, database, `ChiefOfStaffEntrypoint` or service binding. Moving production over was a separate, owner-approved step: [MCP_CUTOVER.md](MCP_CUTOVER.md).

> **Daly Knowledge and Daly Tasks are retired** (gateway 3.0.0). Every `knowledge_*`, `tasks_*` and `planner_*` tool, Intelligence's capture and suggestion tools, Today's planning tools and Home & Assets' task and Knowledge links were removed. Calling one gets a `"retired"` answer (below). See [DECOMMISSION_KNOWLEDGE_TASKS.md](DECOMMISSION_KNOWLEDGE_TASKS.md#mcp).

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
  │  retired tool → "retired"; then the tool's permission (calendar.use, assets.use, …) and strict input schema
  │  writes: claimed in mcp_writes (audit + request-id replay)
  ▼
worker/calendar/*, worker/assets/*, worker/centre/*, … — the same functions the portal API uses
  │  calendar membership, asset rights, the caller's own watch areas (others get "not found")
  ▼
D1 (dalyidau-production)
```

The gateway has no database, storage, queue or Durable Object binding (`test/mcp-gateway/isolation.test.ts` checks `mcp/wrangler.jsonc`). The portal has no MCP protocol code. There is one data system: the portal's D1.

## Trust model

- **Authentication happens twice.** Access authenticates the person and the gateway checks the token. The portal doesn't take the gateway's word for who's calling: the gateway forwards `Cf-Access-Jwt-Assertion` exactly as received, and `verifyMcpAssertion` checks it again against the MCP application's audience only (never the portal's `ACCESS_AUD`), plus expiry, not-before and a real email. A portal browser token is refused, and so are expired, forged and service tokens.
- **No identity in arguments.** Every schema is strict and none has an email, user, owner or actor field (`test/mcp-contract.test.ts`).
- **The portal's rules, unchanged.** Roles come from `userForEmail`, exactly as for a browser sign-in. Every record is reached through the caller's own access: calendar membership, an asset's owner or its shares, their own watch areas. A portal owner gets nothing extra: neither owner can see the other's private calendars or assets.
- **Who can call the entrypoint.** A named entrypoint has no route. Any Worker on the account could bind to it, which is why it trusts only what the token proves. If `MCP_ACCESS_AUD` is unset, every call is refused.
- **Errors don't leak.** Anything the caller can't reach is `not_found`. Storage errors become `unavailable`. An unreachable portal is `unavailable` ("Do not treat this as an empty result"), never an empty list.
- **Logs.** The gateway logs `mcp_gateway_refused` with an HTTP status only, and `mcp_gateway_retired_tool` with the tool name. The portal logs one `mcp_call` line per call (tool, ok, error code, duration) and `mcp_auth_refused` with a reason. Never a person, token, argument or result (`isolation.test.ts` checks this).

## Tools

**Seventy tools (17 writes)** in gateway 3.1.0: chief of staff (2), Daly Intelligence briefings (2), Calendar and leave (17), Today (3), the Intelligence Centre (28), Home & Assets (14) and Amplenote (4). Every result carries `source: "daly-portal"`, ids and `url` links back to the portal. Lists are capped and say so (`count`, `truncated`, `nextOffset` or `mayHaveMore`).

### Chief of Staff

| Tool                            | What it returns                                                                                                                                                                                                                                                                                      |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chief_of_staff_daily_context`  | For people with Calendar, `calendar`: events for the next 7 days, overlapping commitments, important dates, planned leave, school holidays with and without leave, projected leave balances and failing subscriptions. For people with Home & Assets, `homeAssets`: what's overdue or due in 30 days |
| `chief_of_staff_weekly_context` | For people with Calendar, the same `calendar` facts over 14 days (no Home & Assets section)                                                                                                                                                                                                          |

Both are facts only, each with its id and link, from `worker/calendar/chief.ts` and Home & Assets' briefing facts. They need Calendar or Home & Assets; a module the caller can't use is absent. `notChecked` names what's never read: email, external calendars that aren't subscribed in Daly Calendar, Daly Tasks and Daly Knowledge (retired), and DalyHub (retired). There's no model call in either Worker.

### Daly Intelligence

Two read-only tools, described in [INTELLIGENCE.md](INTELLIGENCE.md#mcp): `intelligence_get_daily_briefing` and `intelligence_get_weekly_review`. They need `intelligence.use`; with Intelligence switched off they say so. Reading a briefing never runs a model.

### Daly Calendar and Leave

Seventeen tools, described in [CALENDAR.md](CALENDAR.md#mcp-tools). The reads are `calendar_list_calendars`, `calendar_list_events`, `calendar_search_events`, `calendar_get_agenda`, `calendar_find_conflicts`, `calendar_list_subscriptions`, `calendar_school_holidays`, `leave_get_balances`, `leave_list_bookings`, `leave_forecast` and `leave_find_opportunities`. Six write through the ledger: `calendar_create_event`, `calendar_update_event`, `calendar_create_subscription`, `calendar_refresh_subscription`, `leave_create_proposal` and `leave_update_proposal`.

All of them need `calendar.use`, and the leave numbers come from the deterministic leave engine. Other people's private events are "Busy", and sensitive events are "Private event" even to their creator. Subscription addresses are never returned. Leave written through MCP is a draft or a proposal and is never requested, approved or taken. There's no delete tool.

### Today

Three read-only tools, described in [DAILY_PLANNER.md](DAILY_PLANNER.md#mcp-tools-3): `today_get_summary`, `today_get_capacity` and `today_get_briefing`. They need `calendar.use`, call the same functions as `/portal/today`, and never write: to add an appointment an assistant uses `calendar_create_event`. Event titles follow Calendar's rules for AI ("Busy", "Private event").

### Intelligence Centre

Twenty-eight tools, described in [INTELLIGENCE_CENTRE.md](INTELLIGENCE_CENTRE.md#mcp) and [INTELLIGENCE_CENTRE_9_1.md](INTELLIGENCE_CENTRE_9_1.md#mcp). They need `centre.use`.

- **Reads (24):** `centre_list_sources`, `centre_get_source_health`, `centre_get_situation`, `centre_search_incidents`, `centre_get_record`, `centre_search_warnings`, `centre_get_fire_danger`, `centre_get_observations`, `centre_list_road_disruptions`, `centre_list_watch_areas`, `centre_list_changes`, `centre_get_watch_briefing`, `centre_search_changes`, `centre_get_timeline`, `centre_get_replay_metadata`, `centre_get_trends`, `centre_list_rules`, `centre_list_rule_matches`, `centre_generate_report` (deterministic, not saved, never runs a model), `centre_list_reports`, `centre_get_report`, `centre_list_correlations`, `centre_get_source_reliability` and `centre_list_wallboards` (never display addresses or hashes).
- **Writes (4), through the ledger:** `centre_create_rule`, `centre_update_rule`, `centre_schedule_report` and `centre_save_report`.

Public records come with the providers' own times, links and attribution, and every result says it isn't an official warning service. Watch areas are the caller's own and **never include a location** (names, kinds and settings only); another person's watch area is `not_found`. Rules name watch areas by id, never coordinates. No tool collects from a provider or runs a model.

### Home & Assets

Fourteen tools, described in [HOME_ASSETS.md](HOME_ASSETS.md#mcp). Ten read: `assets_search`, `assets_list`, `assets_get`, `assets_maintenance_history`, `assets_upcoming_maintenance`, `assets_insurance_renewals`, `assets_warranty_expiries`, `assets_list_documents` (names and kinds, never file contents), `assets_summary` and `assets_get_attention`. Four write through the ledger: `assets_create`, `assets_update`, `assets_create_maintenance` and `assets_complete_maintenance`. They need `assets.use` and the asset's own rights (another person's private asset is `not_found`; unshared values and insurance are "not shared with you"). No delete, sharing, upload or bulk tool.

### Amplenote

Four tools, added in gateway 3.1.0 and described in [AMPLENOTE.md](AMPLENOTE.md#ai-assistants), that reach the owner's own Amplenote through Amplenote's REST API. Amplenote is the source of truth: the portal stores no note list, content or task, runs no sync and queues nothing. Unlike the other tools they return Amplenote links, not portal links.

| Tool                    | Mode  | What it does                                                                                                   |
| ----------------------- | ----- | -------------------------------------------------------------------------------------------------------------- |
| `amplenote_list_notes`  | read  | Note titles, tags, times and links (newest change first), filtered by words, tag or change date. Never content |
| `amplenote_create_note` | write | A new note with a name and tags                                                                                |
| `amplenote_append`      | write | Plain text added to a note, one paragraph per line. Nothing in the note is changed or removed                  |
| `amplenote_create_task` | write | One task added to a note. Due date, Important/Urgent and reminder are refused unless confirmed (below)         |

- **Who:** only a portal owner who is also the person who connected Amplenote (Portal settings → Website & Blog), and only while **Amplenote for AI assistants** (`website.amplenote.assistant`, default off) is on. The tools carry `portal.settings.manage`; the owner and connection checks are in `worker/amplenote/assistant.ts`. The other owner gets one fixed refusal that says nothing about the connection.
- **Scopes:** writes need `notes:create` and `notes:create-content-action`. Connecting asks for them only while the switch is on, so the blog-only connection stays list-only until the owner reconnects.
- **Task properties are never dropped.** Amplenote's documentation doesn't say which attributes a task node accepts, so each property starts unconfirmed, and a request that asks for one is refused with `validation` and `details.unsupported`, creating nothing. `scripts/amplenote-write-check.mjs` is the live check that confirms them; `TASK_PROPERTIES` is updated only from its results.
- **Unknown outcomes.** If Amplenote doesn't answer, or fails with a 5xx, the write may have happened. The tool answers `unavailable` with `details.outcome: "unknown"`, and the ledger keeps that request id (`error_code` `outcome_unknown`), so a retry with the same id is refused (`conflict`) instead of adding the note or task twice.
- `mcp_writes` is rebuilt in `0030` for the `amplenote_note` outcome (the note's uuid). All four are annotated `openWorldHint: true`.
- **Not possible through Amplenote's API, so absent:** reading or searching note content; finding, changing, rescheduling or completing tasks; editing or deleting anything.

### Deliberately absent

Deleting, trashing or erasing anything. Bulk changes. Members and sharing. Imports, exports and templates. SQL, files and arbitrary HTTP. These stay in the portal, where a person does them directly. The enforcement is that these operations don't exist in `PORTAL_MCP_TOOLS`, and the portal refuses any tool name not in it.

### Retired tools

The **51 retired tools** are listed in `worker/mcp/retired.ts` and `mcp/src/portal-tools.ts` (`RETIRED_TOOL_NAMES`), and `test/mcp-contract.test.ts` checks the two lists match and that no retired tool is advertised. They cover every `knowledge_*`, `tasks_*` and `planner_*` tool, plus `intelligence_list_suggestions`, `intelligence_get_processing_status`, `intelligence_capture_text`, `intelligence_request_analysis`, `intelligence_approve_suggestion`, `meetings_get_transcript`, `today_list_unscheduled`, `today_propose_plan`, `today_get_conflicts`, `assets_link_knowledge` and `assets_create_task`.

- **Gateway 3.0.0** answers `tools/call` for a retired name itself, after authentication and the rate limit, with an `isError` result whose `code` is `"retired"`. The call never reaches the portal.
- **Portal entrypoint** refuses it with `"retired"` after verifying the Access token, before anything is read. So an older gateway (2.x) that still advertises the tools can't reach a retired record either.

### The 34 DalyHub tools: retired

The DalyHub-backed gateway served 34 tools against DalyHub's single-owner D1. They're gone from this gateway: none is listed, and calling one is an error (`test/mcp-gateway/protocol.test.ts`). Their Daly Portal replacements for tasks, notes, projects and decisions were themselves retired with Daly Tasks and Daly Knowledge, so there is no MCP replacement for them now. The Chief of Staff context tools remain (`chief_of_staff_daily_context`, `chief_of_staff_weekly_context`), drawing on Calendar and Home & Assets.

## Writes: audit and retries

`mcp_writes` (migration `0018_mcp_writes.sql`, rebuilt by later migrations to widen its outcomes) gets one row per write: id, email, tool, request id, status, entity (`calendar_event`, `calendar_subscription`, `leave_booking`, `asset`, `asset_maintenance`, `centre_rule`, `centre_report` or `centre_report_schedule`), error code and timestamps. It never holds titles, text or arguments. Rows written by retired tools (tasks, Knowledge objects, projects, captures, suggestions, time blocks) stay as history; nothing writes or replays them any more.

A write that carries `requestId` is claimed first, under a unique `(email, request_key)` index:

- **same id, same tool, already done:** the current record is returned with `replayed: true` (access is re-checked first);
- **same id, other tool:** `request_id_reused`;
- **same id, still running:** `in_progress` (a claim older than two minutes is treated as abandoned);
- **failed write:** the row stays `failed` and the id is released for a corrected retry;
- **outcome unknown** (an outside service, Amplenote, didn't confirm the write): the row stays `failed` with `outcome_unknown` and keeps the id, so a retry with it is refused (`conflict`) instead of writing twice.

Request ids are per person: the same id from two people creates two records and replays neither across them (`identities.test.ts`).

## Configuration

| Where                                 | Name                        | What                                                                                                       |
| ------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------- |
| dalyidau (secret)                     | `MCP_ACCESS_AUD`            | AUD tag of the `mcp.daly.id.au` Access application (the gateway's `POLICY_AUD`). Unset: every call refused |
| dalyidau                              | `ACCESS_TEAM_DOMAIN`        | Already set for the portal. The MCP application is on the same team                                        |
| gateway `dalyhub-mcp` (secrets, kept) | `TEAM_DOMAIN`, `POLICY_AUD` | Already on the existing Worker; deploying the new code doesn't touch them                                  |
| gateway                               | `PORTAL` service binding    | `dalyidau` / `PortalMcpEntrypoint` (locally `dalyidau-staging`)                                            |
| gateway                               | `MCP_CALLS`, `MCP_WRITES`   | Rate Limiting namespaces 4401 and 4402: 120 and 30 per person per minute                                   |
| Access, `mcp.daly.id.au` application  | Allow policy                | Who may connect. Each person then sees only their own and shared portal data                               |
| Portal users                          | role                        | `calendar.use`, `intelligence.use`, `centre.use`, `assets.use` (owner or admin today)                      |

`DALYHUB_OWNER_EMAILS`, if it was ever set on `dalyhub-mcp`, is unused by this code. Removing it is on the decommissioning checklist.

## Releasing a gateway version

The portal first, then the gateway. Each step needs the owner's approval. The gateway is never deployed by CI.

1. **Portal.** Merging to `main` deploys `dalyidau` and applies any migrations. The live gateway keeps working throughout: it advertises its existing tools, and the portal serves them (retired ones are refused with `"retired"`).
2. **Gateway.** Record the current version id (`npx wrangler deployments list --name dalyhub-mcp`), then `npm run mcp:deploy:dry-run` and `npx wrangler deploy --config mcp/wrangler.jsonc --env production`. Clients may need to reconnect, or refresh their tool list, to see the change.

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
- `test/mcp-gateway/` (`vitest.mcp.config.ts`, workerd with `nodejs_compat`, as the gateway runs) drives real MCP JSON-RPC through `mcp/src` into the portal's real `handleMcpCall` and a local D1. The PORTAL hop structured-clones like Worker RPC. Every outbound fetch except the Access key set is refused and recorded.
    - `protocol.test.ts`: initialize (with the working instructions), `tools/list` (exactly 70, with annotations), a retired tool answered with `"retired"` without reaching the portal, none of the 34 legacy tools, calls, schema validation, `/mcp` only, 401/503 failures, development token limits and Host validation.
    - `isolation.test.ts`: the deployable config binds only `PORTAL` (no D1/KV/R2/DO/queues, nothing named DalyHub, no routes). The source imports nothing from DalyHub. A whole session (reads, writes, retries, briefings) runs with nothing but the binding. Also an unreachable or missing portal, per-person and write rate limits, and logs that hold no person, token or content.
    - `identities.test.ts`: two independent identities, both portal owners. Private events and assets stay invisible by id, list, search and briefing, and can't be changed by the other person. Arguments can't name someone else, and request ids don't cross people. A shared calendar shows its events to a member, with the other's private events as "Busy", and removal cuts access on the next call. A person without a portal role and a service token get nothing.
- `test/amplenote-assistant.test.ts` covers the Amplenote tools against the stand-in in `fixtures/amplenote`: the switch, owner-only access, scopes, the ledger, unknown outcomes and refused task properties.
- `test/mcp.test.ts` covers the portal entrypoint directly (tokens, roles, the 70 tools, retired tools refused for every role, Chief of Staff, the write ledger).
- `test/mcp-contract.test.ts` compares the gateway's tools with the portal's: names, retired names, write set, every argument name, annotations, no identity fields.
- `npm run mcp:deploy:dry-run` builds the production gateway bundle and lists its bindings.

## Local development

1. Portal: `npx wrangler d1 migrations apply DB --local --env staging`, then `npx wrangler dev --env staging --var ENVIRONMENT:development --var SITE_URL:http://localhost:8797 --var ACCESS_DEV_EMAIL:you@example.com --var PORTAL_OWNER_EMAILS:you@example.com --port 8797`.
2. Gateway: put `DEV_MCP_TOKEN=<32+ characters>` in `mcp/.dev.vars`, then `npm run mcp:dev` (port 8798). Its `PORTAL` binding finds the local `dalyidau-staging` through the dev registry.
3. Call `http://localhost:8798/mcp` with `Authorization: Bearer <DEV_MCP_TOKEN>`. The gateway forwards the assertion `development`, which the portal accepts only with `ENVIRONMENT=development`, a localhost `SITE_URL` and `ACCESS_DEV_EMAIL`. The gateway accepts the token only with `AUTH_MODE` and `ENVIRONMENT` both `development` and a localhost request. No deployed environment meets any of that.
