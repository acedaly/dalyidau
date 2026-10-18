# Daly MCP gateway: Tasks and Knowledge for AI clients

AI clients (Claude, ChatGPT, Codex and other MCP clients) reach Daly Tasks and Daly Knowledge through the **existing** MCP server at `https://mcp.daly.id.au/mcp`. That server is the `dalyhub-mcp` Worker, whose source and deployment live in the private `acedaly/DalyHub-V2` repository (`workers/dalyhub-mcp`, runbook `docs/CHIEF_OF_STAFF_MCP.md`, ADR-127 and ADR-128). This repository owns the portal end: `worker/mcp/`.

Nothing here is deployed until the owner approves it. See [Deployment](#deployment-for-later-approval).

## How a call flows

```text
Claude / ChatGPT / Codex
  │  HTTPS, OAuth through Cloudflare Access Managed OAuth (MCP server application)
  ▼
mcp.daly.id.au/mcp  — dalyhub-mcp Worker (DalyHub-V2)
  │  verifies the Access JWT (signature, issuer, MCP application AUD, RS256, sub)
  │  picks the caller's tools: Daly Portal tools for everyone the Access policy admits;
  │  the single-owner DalyHub tools only for DALYHUB_OWNER_EMAILS
  │  validates tool input, rate-limits per person (120 calls, 30 writes a minute)
  │
  ├─ DALYHUB service binding → dalyhub-v2-production :: ChiefOfStaffEntrypoint   (unchanged)
  │
  └─ PORTAL service binding → dalyidau :: PortalMcpEntrypoint.invoke({ assertion, tool, input })
        │  verifies the forwarded Access JWT AGAIN, against MCP_ACCESS_AUD
        │  email → portal role (PORTAL_OWNER_EMAILS, then active portal_users row)
        │  tasks.use / knowledge.use permission, then the tool's own input schema
        │  writes: claim in mcp_writes (audit + request-id replay)
        ▼
     worker/tasks/*, worker/knowledge/*  — the same functions the portal API uses
        │  project / space membership on every record (non-members get "not found")
        ▼
     D1 (dalyidau-production)
```

The gateway has no database binding. The portal has no MCP protocol code. There is one data system: the portal's D1. Nothing is copied into the gateway or into DalyHub.

## Trust model

- **Authentication happens twice.** Access authenticates the person and the gateway checks the token. The portal does not trust the gateway's word for who is calling: the gateway forwards the `Cf-Access-Jwt-Assertion` exactly as it received it, and `verifyMcpAssertion` (`worker/portal/access.ts`) checks the signature against the team's keys, the issuer, **the MCP application's audience only** (`MCP_ACCESS_AUD`, never the portal's `ACCESS_AUD`), expiry, not-before and a real email. A portal browser token is refused, and so is an expired, forged or service token.
- **No identity in arguments.** Every tool schema is strict, and none has an email, user or owner field. Identity comes only from the verified token.
- **The portal's rules, unchanged.** The email gets its role exactly as a browser sign-in does (`userForEmail`, shared with `authenticate`). Tasks tools need `tasks.use`, Knowledge tools need `knowledge.use`, and the Chief of Staff tools need either one. Inside the application every record is reached through the caller's own `task_project_members` or `knowledge_memberships` row. A portal owner gets nothing extra: Aidan cannot see Amelia's personal projects or space, and she cannot see his.
- **Who can call the entrypoint.** A named entrypoint has no route, so it can't be reached from the internet. Any Worker on the account could bind to it, which is why it trusts only what the token proves. If `MCP_ACCESS_AUD` is unset, every call is refused.
- **Cross-module links.** Task → Knowledge references go through `knowledgeReferences`. A person who can see a shared task but not the linked object sees `{ available: false }`: no title, space or id. Linking needs edit rights on the task _and_ read access to the object.
- **Errors don't leak.** Anything outside the caller's projects and spaces is `not_found`. A storage error becomes `unavailable` with no internals. The gateway reports an unreachable portal as `unavailable`, never as an empty list.
- **Logs.** One `mcp_call` line per call (tool, ok, error code, duration). No email, arguments or results.

## Tools

Every result carries `source: "daly-portal"`, ids, and `url` links back to the portal. Lists are capped and say so (`count`, `truncated`, `nextOffset` or `mayHaveMore`).

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

Text from an AI client is never parsed as markup. `paragraphsFromText` turns it into `daly.doc.v1` paragraphs, so `<script>` or `**bold**` is stored and shown as literal text. Reads use `documentToMarkdown`, which escapes everything. Rich content written in the editor is never overwritten through MCP: the body can only be appended to, every change goes through `updateObject` (versioned, revisioned, re-indexed, audited in `knowledge_audit`), and a stale version is a `conflict`.

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
| `tasks_list_goals`, `tasks_get_goal` | read  | Goals (Milestone 3) with progress, milestones and what's next                                                 |
| `tasks_list_routines`                | read  | Routines, who's responsible and who's next                                                                    |
| `tasks_create`                       | write | One task. Defaults to the caller's Inbox. `requestId` doubles as the engine's `clientId`                      |
| `tasks_update`                       | write | Fields of one task. **Needs the version.** `scope` chooses occurrence or series                               |
| `tasks_reschedule`                   | write | Due date and time only. Version optional, since nothing else is sent                                          |
| `tasks_complete`                     | write | `completeTask`: one occurrence of a repeating task, once, even if retried. Open subtasks give `open_subtasks` |
| `tasks_reopen`                       | write | `reopenTask`, including undoing a repeating task's latest completion                                          |
| `tasks_add_comment`                  | write | A comment on a task the caller can edit                                                                       |
| `tasks_link_knowledge`               | write | A task → Knowledge reference, checked by both permission systems                                              |

Recurrence, conflicts, archived-project rules, assignee checks and subtask depth all come from `worker/tasks/tasks.ts`. The MCP layer adds no scheduling logic.

### Chief of Staff

| Tool                            | What it returns                                                                                                                                                                                                                                                                                                            |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chief_of_staff_daily_context`  | From the personal and household dashboards: due today, overdue, next 7 days, high priority, unsorted Inbox, milestones, routines, reviews due, projects and goals needing attention, shared household work (members only), today's personal daily note, Knowledge updated since yesterday, decisions from the last 14 days |
| `chief_of_staff_weekly_context` | The seven days ending `weekEnding`: completed occurrences, overdue, next 14 days and deadlines, project health, goals, routines, and Knowledge notes, meetings and decisions in the period                                                                                                                                 |

Both are facts only. Every item has its id and link. `checked` says which modules were read, and `notChecked` names what is never read (calendar, email, DalyHub). A module the person can't use is absent rather than reported as empty. Counts come from the same functions as the portal's dashboard, in the person's own time zone. There is no model call in the Worker: the client does the reasoning and must label proposals as proposals.

### Deliberately absent

Deleting, trashing or permanently erasing anything. Bulk changes. Moving tasks between projects. Project, goal, space or type administration. Members and sharing. Imports, exports and templates. Revision restore. SQL, files and arbitrary HTTP. These stay in the portal, where a person does them directly. Tool annotations (`readOnlyHint`, `destructiveHint: false`) are informative only. The real enforcement is that these operations don't exist in `PORTAL_MCP_TOOLS`, and the portal refuses any tool name not in it.

## Writes: audit and retries

`mcp_writes` (migration `0018_mcp_writes.sql`) gets one row per write: id, email, tool, request id, status, entity type and id, error code and timestamps. It never holds titles, text or arguments. The Knowledge and Tasks histories (`knowledge_audit`, `task_activity`) also record every MCP write as the person who made it, exactly as for a browser edit.

A write that carries `requestId` is claimed before anything changes, under a unique `(email, request_key)` index:

- **same id, same tool, already done**: the current record is returned with `replayed: true`, and nothing is written again (membership is re-checked first);
- **same id, other tool**: `request_id_reused`;
- **same id, still running**: `in_progress` (a claim older than two minutes is treated as abandoned and can be taken over);
- **failed write**: the row stays as `failed` and the id is released, so a corrected retry can run.

Task creation is protected twice: the ledger, and the Tasks engine's own `clientId` replay. Recurring completion is protected by the engine's per-occurrence guard, whether or not a request id is sent.

`mcp_writes` is in `TABLES` (`scripts/lib/ops.mjs`), so `npm run db:backup` counts and verifies it, and `npm run test:backup` seeds it, restores it and checks that its unique index still refuses a reused request id. It is an ordinary table, so the FTS5-aware backup process is unaffected.

## Legacy DalyHub tools

The gateway's 34 DalyHub tools reach DalyHub's own D1 (`dalyhub-v2`) through `ChiefOfStaffEntrypoint`. That is a single-owner workspace whose only authorisation was "the Access policy admits one person". This milestone leaves them working and unchanged in name, schema and behaviour, with two changes made for safety:

1. They are offered only to identities in the gateway secret `DALYHUB_OWNER_EMAILS`, and to nobody if it is unset. Without this, adding Amelia to the Access policy would give her Aidan's DalyHub. Production deploys require the secret.
2. Each description now starts "DalyHub (older system).", so a client holding both sets can tell the sources apart. Results from the two systems are never merged.

| DalyHub tool(s)                                                   | Decision now                                | Portal equivalent                                                                      | Notes                                                                                                                       |
| ----------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `get_chief_of_staff_context`, `get_weekly_review_context`         | Keep temporarily; deprecate after migration | `chief_of_staff_daily_context`, `chief_of_staff_weekly_context`                        | Different data: DalyHub has waiting-for, decisions and stale-project rules of its own                                       |
| `get_today`                                                       | Keep temporarily                            | `tasks_today`                                                                          | DalyHub uses its own owner time zone                                                                                        |
| `search_dalyhub`                                                  | Keep temporarily                            | `tasks_search` + `knowledge_search`                                                    |                                                                                                                             |
| `capture_item`                                                    | Keep temporarily                            | `tasks_create` (Inbox) or `knowledge_create_object` (`inInbox`)                        | DalyHub capture types (idea, reminder, open decision) have no single portal equivalent                                      |
| `create_task`, `update_task`, `complete_task`, `reopen_task`      | Keep temporarily                            | `tasks_create`, `tasks_update`, `tasks_complete`, `tasks_reopen`                       | DalyHub tasks hang off Areas, Goals and Projects by name; portal tasks belong to membership-scoped projects. Not redirected |
| `get_projects`, `get_project`, `create_project`, `update_project` | Keep                                        | Read: `tasks_list_projects`, `tasks_project_summary`. No MCP project writes            | Different lifecycles and ownership. Project creation and sharing stay in the portal                                         |
| `get_goals`, `get_goal`, `create_goal`, `update_goal`             | Keep                                        | Read: `tasks_list_goals`, `tasks_get_goal`                                             | Portal goals have their own membership. No MCP goal writes yet                                                              |
| `get_note(s)`, `create_note`, `update_note`                       | Keep temporarily                            | `knowledge_*`                                                                          | DalyHub notes are Markdown; Knowledge is `daly.doc.v1` with types and properties                                            |
| `record_decision`, `get_decisions`                                | Keep                                        | `knowledge_create_object` with type `decision`; decisions appear in both context tools |                                                                                                                             |
| `get_people`, `get_person`, `create_person`, `update_person`      | Keep, no replacement                        | none (Knowledge has a `person` type without DalyHub's contact fields)                  | People data is sensitive. No migration planned here                                                                         |
| `get_areas`, `get_area`, `create_area`, `update_area`             | Keep, no replacement                        | none (Tasks has no Areas)                                                              |                                                                                                                             |
| `get_waiting_for`, `create_waiting_for`, `resolve_waiting_for`    | Keep, no replacement                        | none                                                                                   | Could become a label or assignee convention later                                                                           |

Nothing migrates or deletes DalyHub data. Moving DalyHub records into the portal, if wanted, needs its own previewed, reversible import.

## Configuration

| Where                                | Name                      | What                                                                                                                      |
| ------------------------------------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| dalyidau (secret)                    | `MCP_ACCESS_AUD`          | The AUD tag of the `mcp.daly.id.au` Access application (the gateway's `POLICY_AUD`). Without it every MCP call is refused |
| dalyidau                             | `ACCESS_TEAM_DOMAIN`      | Already set for the portal. The MCP application must be on the same team                                                  |
| dalyhub-mcp (secret, production)     | `DALYHUB_OWNER_EMAILS`    | Comma-separated emails that may use the DalyHub tools (Aidan)                                                             |
| dalyhub-mcp                          | `PORTAL` service binding  | `dalyidau` / `PortalMcpEntrypoint` (local: `dalyidau-staging`)                                                            |
| dalyhub-mcp                          | `MCP_CALLS`, `MCP_WRITES` | Rate Limiting bindings, 120 and 30 per person per minute                                                                  |
| Access, `mcp.daly.id.au` application | Allow policy              | Add Amelia's identity so she can connect. She then gets only her own portal data                                          |
| Portal users                         | role                      | Each person needs a portal role with `tasks.use` / `knowledge.use` (owner or admin today)                                 |

## Connecting AI clients

Server URL: `https://mcp.daly.id.au/mcp` (Streamable HTTP). Authentication: OAuth through Cloudflare Access Managed OAuth with dynamic client registration. There is no client secret, bearer token or API key to copy anywhere. Each person signs in as themselves and gets only their own records and what has been shared with them.

None of the clients below have been tested against the deployed gateway yet, because nothing has been deployed. Check each one when activating.

- **Claude (claude.ai, desktop, mobile).** Customize → Connectors → Add custom connector → URL above, leave the OAuth client fields blank → Connect, then sign in through Access. Allowed redirect URI: `https://claude.ai/api/mcp/auth_callback`. Claude asks before running tools that aren't marked read-only, unless you choose "always allow".
- **Claude Code.** `claude mcp add --transport http daly https://mcp.daly.id.au/mcp`, then `/mcp` to sign in. It uses a loopback redirect (`http://localhost:<port>/callback`), which must be in the Access application's allowed redirect URIs.
- **ChatGPT.** Remote MCP connectors with OAuth need developer mode (Settings → Apps & Connectors → Advanced). Create a connector with the URL above and OAuth authentication. Add the redirect URI ChatGPT shows to Allowed redirect URIs. ChatGPT asks for confirmation before write actions.
- **Codex (CLI).** In `~/.codex/config.toml`: `[mcp_servers.daly]` with `url = "https://mcp.daly.id.au/mcp"`, then `codex mcp login daly`. Like Claude Code, it needs its loopback redirect URI allowed.
- **Other clients** need Streamable HTTP and OAuth 2.1 with dynamic client registration. Clients that only speak stdio or SSE, or can't do OAuth, can't connect. Don't weaken Access for them. Access service tokens carry no email, so the portal refuses them.

Try "Brief me from my Daly Portal tasks and notes", "What's overdue in the House project?" or "Add 'renew passport' to my Inbox for next Friday" (good clients send a `requestId`). For the weekly workflow: "Review what I need to do this week, check my Knowledge notes for commitments that aren't tasks yet, and recommend a realistic plan." The client should call `chief_of_staff_weekly_context`, then `knowledge_search`, and propose tasks before creating any.

## Costs

No new paid service. Service binding calls don't add request charges. The Rate Limiting binding is included with Workers. Each tool call costs a few D1 reads, and each write one extra small `mcp_writes` insert and update. At personal scale (hundreds of calls a day) this is a rounding error inside the Workers Paid allowance (10 million requests and 25 billion D1 rows read a month). No AI inference runs in either Worker.

## Testing

- `test/mcp.test.ts` (Vitest in workerd, local D1) runs every tool against the real services. It covers token checks (missing, forged, expired, wrong audience, no email, unconfigured audience, dev identity outside development), roles and permissions, private and shared Tasks and Knowledge isolation, an owner role not opening another person's data, immediate loss of access on removal, viewer roles, cross-module title leaks, retry-safe creates, stale-version conflicts, single-advance recurring completion, open subtasks, time zones, plain-text safety, append-preserves-rich-content, daily notes, the Chief of Staff counts and isolation, and the ledger holding no content.
- In DalyHub-V2, `test/unit/chief-of-staff-mcp*.test.ts` and `test/kernel/chief-of-staff-mcp*-transport.test.ts` cover the gateway: the tool contract, the owner allowlist (including a real signed Access JWT for an owner and a non-owner), assertion forwarding, unreachable-portal reporting, input rejection before the binding, and rate limits.
- `npm run test:backup` covers `mcp_writes`.

## Local development

1. In this repository: `npx wrangler d1 migrations apply DB --local --env staging`, then `npx wrangler dev --env staging --var ENVIRONMENT:development --var SITE_URL:http://localhost:8797 --var ACCESS_DEV_EMAIL:you@example.com --var PORTAL_OWNER_EMAILS:you@example.com --port 8797`. The Worker name `dalyidau-staging` is what the gateway's local binding targets. Nothing remote is used.
2. In DalyHub-V2: `pnpm mcp:dev` with `DEV_MCP_TOKEN` (32+ characters) in `workers/dalyhub-mcp/.dev.vars`.
3. Call `http://localhost:<gateway port>/mcp` with `Authorization: Bearer <DEV_MCP_TOKEN>`. The gateway forwards the assertion `development`, which this Worker accepts only with `ENVIRONMENT=development`, a localhost `SITE_URL` and `ACCESS_DEV_EMAIL` all set. No deployed environment has all three.

## Deployment (for later approval)

Order matters: the portal must have `PortalMcpEntrypoint` and its secret before the gateway binds to it, and the gateway's owner allowlist must be in place before anyone else is admitted.

1. Back up production D1: `npm run db:backup`. Optionally try staging first: `npx wrangler d1 migrations apply DB --remote --env staging`.
2. `npx wrangler secret put MCP_ACCESS_AUD` (production; also `--env staging` for staging). Use the AUD tag of the `mcp.daly.id.au` Access application. Setting it before the deploy is harmless: the current Worker ignores it.
3. Merge the portal PR. The deploy workflow records a D1 time-travel bookmark, applies `0018_mcp_writes.sql` (additive) and deploys `dalyidau` with `PortalMcpEntrypoint`. Its Cloudflare token has been failing since 14 October; by hand from a clean checkout of `main`: `npx wrangler d1 migrations apply DB --remote --env=""`, then `npx wrangler deploy --env=""`.
4. Read-only check: `npx wrangler d1 migrations list DB --remote --env=""` shows `0018` applied.
5. In DalyHub-V2: `pnpm exec wrangler secret put DALYHUB_OWNER_EMAILS --config workers/dalyhub-mcp/wrangler.jsonc --env production` (Aidan's Access email), then `pnpm run mcp:deploy:production`.
6. Check as Aidan: reconnect the Claude connector. Both tool sets are listed, and `get_today` and `tasks_today` both answer.
7. Only then: in Zero Trust, add Amelia to the `mcp.daly.id.au` application's Allow policy, and give her a portal role with Tasks and Knowledge if she doesn't have one. Check as Amelia: only portal tools are listed, and she sees her own records and shared ones only.
8. Add redirect URIs for any client beyond Claude web (Claude Code, Codex loopback, ChatGPT) to the Access application's Managed OAuth settings.

### Rollback

- **Turn portal access off at once:** `npx wrangler secret delete MCP_ACCESS_AUD`. Every portal tool call is then refused. DalyHub tools are unaffected.
- **Gateway:** remove Amelia (and anyone else who isn't the DalyHub owner) from the Access policy **first**, because the previous gateway version offers DalyHub tools to everyone Access admits. Then `pnpm exec wrangler rollback --config workers/dalyhub-mcp/wrangler.jsonc --env production`.
- **Portal:** `npx wrangler rollback`. Leave `0018` in place: it's additive, and the previous Worker never reads it.
