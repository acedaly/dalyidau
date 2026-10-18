# Daly MCP: Tasks and Knowledge for AI clients

AI clients (Claude, ChatGPT, Codex and other MCP clients) reach Daly Tasks and Daly Knowledge at `https://mcp.daly.id.au/mcp`. The whole service lives in this repository:

- `mcp/`: the gateway Worker. It handles the MCP protocol, tool descriptions, Access token checks and per-person rate limits.
- `worker/mcp/`: `PortalMcpEntrypoint` in the portal Worker. It handles identity, permissions, membership, data and the write ledger.

There's no DalyHub V2 runtime dependency: no DalyHub Worker, database, `ChiefOfStaffEntrypoint` or service binding. Moving production over is a separate, owner-approved step: [MCP_CUTOVER.md](MCP_CUTOVER.md). Moving useful DalyHub data across is [DALYHUB_MIGRATION.md](DALYHUB_MIGRATION.md).

## Architecture decision (October 2026)

**Decision.** MCP is a permanent Daly Portal capability. The gateway moves from DalyHub-V2 (`workers/dalyhub-mcp`) into this repository as its own small Worker (`mcp/`), bound only to the portal's existing `PortalMcpEntrypoint`. The 34 DalyHub tools are removed, not ported. In production it deploys **under the existing Worker name `dalyhub-mcp`**, so the `mcp.daly.id.au` Custom Domain, the Access application in front of it and its `TEAM_DOMAIN`/`POLICY_AUD` secrets stay exactly as they are.

**Options considered.**

| Option                                                                                    | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Keep the gateway in DalyHub-V2, unbind DalyHub                                         | Rejected. The repository being decommissioned would keep owning a permanent service.                                                                                                                                                                                                                                                                                                                                                              |
| B. Serve `/mcp` from the `dalyidau` Worker itself                                         | Rejected for now. It would put the MCP SDK and `agents` (about 1.3 MB) and `nodejs_compat` into the Worker that serves the public site and the wedding pages, whose CPU has already needed work. It would also need a `routes` change in `wrangler.jsonc` plus a Custom Domain move (owner approval), and it gives MCP and the website one shared rollback. It saves no money: service binding calls are free. It stays possible later if wanted. |
| **C. A separate gateway Worker in this repository, deployed over `dalyhub-mcp` (chosen)** | Smallest change in production: the code only. It keeps defence in depth, since the token is checked twice by two independent implementations. Rollback is one `wrangler rollback`. No new paid infrastructure.                                                                                                                                                                                                                                    |
| C′. The same, as a new Worker `daly-mcp` with the domain moved to it                      | Possible later (optional rename, see the cutover doc). Doing it first would add a Custom Domain move and two new secrets to the cutover, for a cosmetic gain.                                                                                                                                                                                                                                                                                     |

**What stayed exactly the same.** The public URL, Access Managed OAuth (dynamic client registration, no client secrets), the gateway's JWT check (`jose`, RS256, issuer, MCP application audience, non-empty `sub`), the portal's second check (`verifyMcpAssertion` against `MCP_ACCESS_AUD`), the MCP stack (`agents@0.24.0` `createMcpHandler` on `@modelcontextprotocol/server@2.0.0`, stateless Streamable HTTP, `/mcp` only, Host validation), the 31 tool names, descriptions, schemas and annotations (ported byte for byte), and the rate-limit namespaces, so the live counters carry over. Also unchanged: the request-id ledger, the logs and every portal rule.

**What changed.** No DalyHub binding and no DalyHub tools, so no `DALYHUB_OWNER_EMAILS` gate either: there's nothing single-owner left to gate. The local development token now also requires a localhost request. `serverInfo` is `daly-portal` 2.0.0 (clients identify a connector by URL, not by this name). The gateway and portal tool lists are compared field by field in one test (`test/mcp-contract.test.ts`), instead of two repositories each pinning a copy.

## How a call flows

```text
Claude / ChatGPT / Codex
  │  HTTPS, OAuth through Cloudflare Access Managed OAuth (MCP server application)
  ▼
mcp.daly.id.au/mcp — gateway Worker (mcp/, deployed as "dalyhub-mcp")
  │  verifies the Access JWT (jose: signature, issuer, MCP application AUD, RS256, sub)
  │  per-person rate limit (Access subject): 120 requests a minute
  │  MCP protocol; first-pass input validation against the advertised schemas
  │  writes: a second limit, 30 a minute
  ▼
PORTAL service binding → dalyidau :: PortalMcpEntrypoint.invoke({ assertion, tool, input })
  │  verifies the forwarded Access JWT AGAIN (worker/portal/access.ts), against MCP_ACCESS_AUD
  │  email → portal role (PORTAL_OWNER_EMAILS, then an active portal_users row)
  │  tasks.use / knowledge.use, then the tool's own strict input schema
  │  writes: claimed in mcp_writes (audit + request-id replay)
  ▼
worker/tasks/*, worker/knowledge/* — the same functions the portal API uses
  │  project / space membership on every record (non-members get "not found")
  ▼
D1 (dalyidau-production)
```

The gateway has no database, storage, queue or Durable Object binding (`test/mcp-gateway/isolation.test.ts` checks `mcp/wrangler.jsonc`). The portal has no MCP protocol code. There is one data system: the portal's D1.

## Trust model

- **Authentication happens twice.** Access authenticates the person and the gateway checks the token. The portal doesn't take the gateway's word for who's calling: the gateway forwards `Cf-Access-Jwt-Assertion` exactly as received, and `verifyMcpAssertion` checks it again against the MCP application's audience only (never the portal's `ACCESS_AUD`), plus expiry, not-before and a real email. A portal browser token is refused, and so are expired, forged and service tokens.
- **No identity in arguments.** Every schema is strict and none has an email, user, owner or actor field (`test/mcp-contract.test.ts`).
- **The portal's rules, unchanged.** Roles come from `userForEmail`, exactly as for a browser sign-in. Every record is reached through the caller's own project or space membership. A portal owner gets nothing extra: neither owner can see the other's personal projects or space.
- **Who can call the entrypoint.** A named entrypoint has no route. Any Worker on the account could bind to it, which is why it trusts only what the token proves. If `MCP_ACCESS_AUD` is unset, every call is refused.
- **Errors don't leak.** Anything outside the caller's projects and spaces is `not_found`. Storage errors become `unavailable`. An unreachable portal is `unavailable` ("Do not treat this as an empty result"), never an empty list.
- **Logs.** The gateway logs `mcp_gateway_refused` with an HTTP status only. The portal logs one `mcp_call` line per call (tool, ok, error code, duration) and `mcp_auth_refused` with a reason. Never a person, token, argument or result (`isolation.test.ts` checks this).

## Tools

Thirty-one tools. Every result carries `source: "daly-portal"`, ids and `url` links back to the portal. Lists are capped and say so (`count`, `truncated`, `nextOffset` or `mayHaveMore`).

### Daly Knowledge

| Tool                          | Mode  | What it does                                                                                              |
| ----------------------------- | ----- | --------------------------------------------------------------------------------------------------------- |
| `knowledge_list_spaces`       | read  | The caller's spaces, their role, and today's date in each                                                 |
| `knowledge_list_types`        | read  | Object types and their properties in a space (default: personal)                                          |
| `knowledge_search`            | read  | Full-text search (FTS5) across the caller's spaces, with «highlighted» snippets                           |
| `knowledge_get_object`        | read  | One object: properties, version, body as escaped Markdown, links and backlinks                            |
| `knowledge_list_objects`      | read  | Objects by view (all, inbox, archived), type or tag, paged. Trash is never listed                         |
| `knowledge_get_related`       | read  | Links, backlinks, suggested related objects (labelled as suggestions) and linked tasks the caller can see |
| `knowledge_get_daily_note`    | read  | The daily note for a date, or `exists: false`. Never creates one                                          |
| `knowledge_create_object`     | write | Create an object. Text becomes plain paragraphs                                                           |
| `knowledge_update_object`     | write | Title, tags, properties, inbox flag. **Needs the version. Can't replace the body**                        |
| `knowledge_append_to_object`  | write | Add paragraphs to the end, keeping everything already there                                               |
| `knowledge_create_daily_note` | write | Ensure the day's note exists (one per date per space) and optionally append time-stamped text             |

Text from an AI client is never parsed as markup: `paragraphsFromText` stores `<script>` or `**bold**` as literal text, and reads go through `documentToMarkdown`, which escapes everything. The body can only be appended to, every change is versioned, revisioned, re-indexed and audited in `knowledge_audit`, and a stale version is a `conflict`.

### Daly Tasks

| Tool                                 | Mode  | What it does                                                                                                  |
| ------------------------------------ | ----- | ------------------------------------------------------------------------------------------------------------- |
| `tasks_list`                         | read  | The "My tasks" filter (projects, priority, labels, due, deadline, assignee, status, scope), paged             |
| `tasks_get`                          | read  | One task with description, recurrence, subtasks, comments, completions and permitted Knowledge references     |
| `tasks_today`                        | read  | Today's list in the person's time zone, plus completed today                                                  |
| `tasks_upcoming`                     | read  | Up to 31 days ahead, including projected repeats and deadlines                                                |
| `tasks_overdue`                      | read  | Overdue by due date or deadline                                                                               |
| `tasks_search`                       | read  | Tasks and projects by words                                                                                   |
| `tasks_list_projects`                | read  | Inbox, personal and shared projects with counts                                                               |
| `tasks_project_summary`              | read  | Health and reasons, overdue, next 14 days, deadlines, milestones, open tasks, goals and Knowledge             |
| `tasks_list_goals`, `tasks_get_goal` | read  | Goals with progress, milestones and what's next                                                               |
| `tasks_list_routines`                | read  | Routines, who's responsible and who's next                                                                    |
| `tasks_create`                       | write | One task. Defaults to the caller's Inbox. `requestId` doubles as the engine's `clientId`                      |
| `tasks_update`                       | write | Fields of one task. **Needs the version.** `scope` chooses occurrence or series                               |
| `tasks_reschedule`                   | write | Due date and time only. Version optional, since nothing else is sent                                          |
| `tasks_complete`                     | write | `completeTask`: one occurrence of a repeating task, once, even if retried. Open subtasks give `open_subtasks` |
| `tasks_reopen`                       | write | `reopenTask`, including undoing a repeating task's latest completion                                          |
| `tasks_add_comment`                  | write | A comment on a task the caller can edit                                                                       |
| `tasks_link_knowledge`               | write | A task → Knowledge reference, checked by both permission systems                                              |

### Chief of Staff

| Tool                            | What it returns                                                                                                                                                                                                                                                                                                            |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chief_of_staff_daily_context`  | From the personal and household dashboards: due today, overdue, next 7 days, high priority, unsorted Inbox, milestones, routines, reviews due, projects and goals needing attention, shared household work (members only), today's personal daily note, Knowledge updated since yesterday, decisions from the last 14 days |
| `chief_of_staff_weekly_context` | The seven days ending `weekEnding`: completed occurrences, overdue, next 14 days and deadlines, project health, goals, routines, and Knowledge notes, meetings and decisions in the period                                                                                                                                 |

Both are facts only, each with its id and link. `notChecked` names what's never read: calendar, email, and DalyHub, which is retired. There's no model call in either Worker.

### Deliberately absent

Deleting, trashing or erasing anything. Bulk changes. Moving tasks between projects. Administering projects, goals, spaces or types. Members and sharing. Imports, exports and templates. Revision restore. SQL, files and arbitrary HTTP. These stay in the portal, where a person does them directly. The enforcement is that these operations don't exist in `PORTAL_MCP_TOOLS`, and the portal refuses any tool name not in it.

## The 34 DalyHub tools: retired

The DalyHub-backed gateway served 34 tools against DalyHub's single-owner D1. They're gone from this gateway: none is listed, and calling one is an error (`test/mcp-gateway/protocol.test.ts`). Here's where each kind of request goes now, and what has no replacement yet.

| DalyHub tool(s)                                                | Now                                                                                                 | Gap before DalyHub can go                                                                                                                              |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `get_chief_of_staff_context`, `get_weekly_review_context`      | `chief_of_staff_daily_context`, `chief_of_staff_weekly_context`                                     | None, once DalyHub's work is migrated                                                                                                                  |
| `get_today`                                                    | `tasks_today`                                                                                       | None                                                                                                                                                   |
| `search_dalyhub`                                               | `tasks_search` + `knowledge_search`                                                                 | None                                                                                                                                                   |
| `capture_item`                                                 | `tasks_create` (Inbox) or `knowledge_create_object` with `inInbox`                                  | None. DalyHub's capture kinds become "task" or "note"                                                                                                  |
| `create_task`, `update_task`, `complete_task`, `reopen_task`   | `tasks_create`, `tasks_update`, `tasks_complete`, `tasks_reopen`                                    | None                                                                                                                                                   |
| `get_projects`, `get_project`                                  | `tasks_list_projects`, `tasks_project_summary`                                                      | None                                                                                                                                                   |
| `create_project`, `update_project`                             | Portal UI only                                                                                      | **Owner decision:** project creation and settings are deliberately not MCP tools. Add `tasks_create_project` only if wanted                            |
| `get_goals`, `get_goal`                                        | `tasks_list_goals`, `tasks_get_goal`                                                                | None                                                                                                                                                   |
| `create_goal`, `update_goal`                                   | Portal UI only                                                                                      | **Owner decision**, as for projects                                                                                                                    |
| `get_note(s)`, `create_note`                                   | `knowledge_get_object`, `knowledge_list_objects`, `knowledge_search`, `knowledge_create_object`     | None                                                                                                                                                   |
| `update_note`                                                  | `knowledge_update_object` (title, tags) + `knowledge_append_to_object`                              | Replacing a whole body is deliberately absent, so rich edits are never overwritten                                                                     |
| `record_decision`, `get_decisions`                             | `knowledge_create_object` type `decision`; `knowledge_list_objects` type `decision`                 | None                                                                                                                                                   |
| `get_areas`, `get_area`, `create_area`, `update_area`          | Knowledge objects of type `area` (`knowledge_list_objects`, `knowledge_create_object`)              | Tasks has no Areas. The migration turns each Area into a Knowledge Area plus a label on its tasks                                                      |
| `get_waiting_for`, `create_waiting_for`, `resolve_waiting_for` | Convention: label `waiting`. `tasks_list` with `labels: ["waiting"]`, `tasks_create`/`tasks_update` | No first-class "waiting on" field. The migration applies the convention; a dedicated field is a possible later Tasks feature                           |
| `get_people`, `get_person`, `create_person`, `update_person`   | Knowledge `person` objects (name and notes only)                                                    | **Owner decision:** DalyHub People hold contact details and aren't migrated by default. Nothing essential is lost from Tasks or Knowledge without them |

Nothing essential has to be built before the cutover. The three **owner decisions** are whether to add MCP project/goal creation and whether to migrate People. Each can be answered after the cutover, because the DalyHub data stays in its backups.

## Writes: audit and retries

`mcp_writes` (migration `0018_mcp_writes.sql`) gets one row per write: id, email, tool, request id, status, entity, error code and timestamps. It never holds titles, text or arguments. `knowledge_audit` and `task_activity` record every MCP write as the person who made it.

A write that carries `requestId` is claimed first, under a unique `(email, request_key)` index:

- **same id, same tool, already done:** the current record is returned with `replayed: true` (membership is re-checked first);
- **same id, other tool:** `request_id_reused`;
- **same id, still running:** `in_progress` (a claim older than two minutes is treated as abandoned);
- **failed write:** the row stays `failed` and the id is released for a corrected retry.

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
| Portal users                          | role                        | `tasks.use` / `knowledge.use` (owner or admin today)                                                       |

`DALYHUB_OWNER_EMAILS`, if it was ever set on `dalyhub-mcp`, is unused by this code. Removing it is on the decommissioning checklist.

## Connecting AI clients

Server URL: `https://mcp.daly.id.au/mcp` (Streamable HTTP). Authentication: OAuth through Cloudflare Access Managed OAuth with dynamic client registration. There's no client secret, bearer token or API key. Each person signs in as themselves.

- **Claude (claude.ai, desktop, mobile).** Customize → Connectors → Add custom connector → the URL, leave the OAuth fields blank → Connect, then sign in through Access. Redirect URI: `https://claude.ai/api/mcp/auth_callback`. An existing connector at this URL keeps working after the cutover; reconnect it if the tool list looks stale.
- **Claude Code.** `claude mcp add --transport http daly https://mcp.daly.id.au/mcp`, then `/mcp` to sign in. It needs its loopback redirect (`http://localhost:<port>/callback`) in the Access application's allowed redirect URIs.
- **ChatGPT.** Developer mode (Settings → Apps & Connectors → Advanced), a connector with the URL and OAuth. Add the redirect URI ChatGPT shows.
- **Codex (CLI).** `~/.codex/config.toml`: `[mcp_servers.daly]` with `url = "https://mcp.daly.id.au/mcp"`, then `codex mcp login daly`. It needs its loopback redirect URI allowed.
- **Other clients** need Streamable HTTP and OAuth 2.1 with dynamic client registration. Don't weaken Access for clients that can't do that. Service tokens carry no email, so the portal refuses them.

## Costs

No new paid service. The gateway replaces an existing Worker. Service binding calls and Rate Limiting are included with Workers. Each call costs a few D1 reads, and each write one small `mcp_writes` insert and update. No AI inference runs in either Worker.

## Testing

- `npm test` runs both Vitest projects.
- `test/mcp-gateway/` (`vitest.mcp.config.ts`, workerd with `nodejs_compat`, as the gateway runs) drives real MCP JSON-RPC through `mcp/src` into the portal's real `handleMcpCall` and a local D1. The PORTAL hop structured-clones like Worker RPC. Every outbound fetch except the Access key set is refused and recorded.
    - `protocol.test.ts`: initialize, `tools/list` (exactly 31, with annotations), calls, none of the 34 legacy tools, `/mcp` only, 401/503 failures, development token limits and Host validation.
    - `isolation.test.ts`: the deployable config binds only `PORTAL` (no D1/KV/R2/DO/queues, nothing named DalyHub, no routes). The source imports nothing from DalyHub, and imports the portal only as types. A whole session (reads, writes, retries, briefings) runs with nothing but the binding and fetches only the Access keys. Also an unreachable or missing portal, per-person and write rate limits, and logs that hold no person, token or content.
    - `identities.test.ts`: two independent identities, both portal owners. Private tasks and notes stay invisible by id, list, search and both briefings. Every write tool is refused on the other person's records. Arguments can't name someone else, and request ids don't cross people. Shared projects and spaces work for editors, viewers can read but not write, a private note on a shared task shows only as `{ available: false }`, and removal cuts access on the next call. A person without a portal role and a service token get nothing.
- `test/mcp.test.ts` covers the portal entrypoint directly (tokens, roles, isolation, retries, recurrence, Knowledge safety, Chief of Staff).
- `test/mcp-contract.test.ts` compares the gateway's tools with the portal's: names, write set, every argument name, annotations, no identity fields.
- `npm run mcp:deploy:dry-run` builds the production gateway bundle and lists its bindings.

## Local development

1. Portal: `npx wrangler d1 migrations apply DB --local --env staging`, then `npx wrangler dev --env staging --var ENVIRONMENT:development --var SITE_URL:http://localhost:8797 --var ACCESS_DEV_EMAIL:you@example.com --var PORTAL_OWNER_EMAILS:you@example.com --port 8797`.
2. Gateway: put `DEV_MCP_TOKEN=<32+ characters>` in `mcp/.dev.vars`, then `npm run mcp:dev` (port 8798). Its `PORTAL` binding finds the local `dalyidau-staging` through the dev registry.
3. Call `http://localhost:8798/mcp` with `Authorization: Bearer <DEV_MCP_TOKEN>`. The gateway forwards the assertion `development`, which the portal accepts only with `ENVIRONMENT=development`, a localhost `SITE_URL` and `ACCESS_DEV_EMAIL`. The gateway accepts the token only with `AUTH_MODE` and `ENVIRONMENT` both `development` and a localhost request. No deployed environment meets any of that.
