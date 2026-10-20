# Daly MCP: Tasks, Knowledge and Calendar for AI clients

AI clients (Claude, ChatGPT, Codex and other MCP clients) reach Daly Tasks, Daly Knowledge, Daly Intelligence and Daly Calendar at `https://mcp.daly.id.au/mcp`. The whole service lives in this repository:

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

Eighty-five tools: the 31 the gateway moved with, five for projects (October 2026, [below](#daly-tasks-projects)), ten for Daly Intelligence ([below](#daly-intelligence)), and those for Calendar, the Daily Planner, Today and the Intelligence Centre (below). Every result carries `source: "daly-portal"`, ids and `url` links back to the portal. Lists are capped and say so (`count`, `truncated`, `nextOffset` or `mayHaveMore`).

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

### Daly Tasks projects

`worker/mcp/projects.ts`. Each tool calls the portal's own `worker/tasks/projects.ts` (`createProject`, `updateProject`, `listProjects`, `getProject`) and `linkProjectKnowledge`, so the rules are exactly the browser's.

| Tool                      | Mode  | What it does                                                                                                                                                                                    |
| ------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tasks_search_projects`   | read  | The caller's projects matching a name: `exact` (same name once case, punctuation and spacing are ignored), `similar` (shares a significant word) or `description`. Archived included by default |
| `tasks_create_project`    | write | A personal or shared project owned by the caller, with optional description, colour, dates, view, up to 20 sections and up to 10 Knowledge references. Refuses an identical name (`duplicate`)  |
| `tasks_update_project`    | write | Name, description, colour, dates (null clears), view, review frequency, status (active, on hold, completed). **Needs the version**                                                              |
| `tasks_archive_project`   | write | Status → archived. Owners only, never the Inbox. **Needs the version.** Everything in the project is kept                                                                                       |
| `tasks_unarchive_project` | write | Status → active (or on hold or completed). Owners only. **Needs the version**                                                                                                                   |

Every project result carries the id, name, `kind` (personal or shared), the caller's `role`, `status`, `version`, counts and `url`. Write results also carry the description, the sections (ids for `tasks_create`'s `sectionId`) and the Knowledge references the caller can read. `tasks_list_projects` and `tasks_project_summary` now include `version` too.

**Who may do what.** Exactly the portal's rules. Anyone with `tasks.use` (owner or admin today) may create a personal or shared project. The creator becomes its only member and owner. **A shared project starts with nobody else in it**: members are added in the portal, never through MCP. Editors change details, only owners change status, archive or restore, and viewers change nothing. Someone else's private project is `not_found` for every tool, whatever their portal role.

**No spoofed owners.** The owner is the person the Access token proves. There's no owner, email, member or creator argument: an extra field is a validation error (`test/mcp-projects.test.ts`, `test/mcp-contract.test.ts`).

**No second Inbox.** `createProject` never makes an Inbox (only `ensureInbox` does, once per person, under a unique index). The MCP tools also refuse "Inbox" as a name for a new or renamed project, in any case or punctuation, so there's never a look-alike. The Inbox itself can't be renamed or archived.

**Duplicates.** Before creating, an assistant should call `tasks_search_projects`. `tasks_create_project` checks too: if the caller already has a project (archived included) with the same normalised name, it's refused with `duplicate`, and `details.matches` lists each one's id, name, kind, role, status, version and link. A similar name isn't a duplicate. When the person confirms they want a second project with the same name, the assistant retries with `allowDuplicateName: true`. Two different requests racing with the same new name can both succeed. That's rare, needs two concurrent writes from one person, and the second shows up in search.

**Validation** is the portal's: name 1–120 characters, description up to 2,000, real dates, target not before start, sections up to 120 characters. Everything that could refuse (validation, permissions, Knowledge access, duplicates) is checked before anything is written, so a refusal never leaves half a project behind. A Knowledge object the caller can't read is `not_found`, and no project is made.

**Versions.** Edits, archive and restore carry the version from the last read. A stale one is `conflict` with `details.current` (`version`, `updatedAt`, `status`), and nothing changes. Archiving an archived project or restoring an active one changes nothing and says so (`alreadyArchived`, `alreadyRestored`).

**Retries.** The request-id ledger applies as for every write. A create also stores the request id as the project's `client_id` (migration `0020`, the same pattern as tasks' Quick Add). So even a request that died after writing, whose ledger claim was abandoned, gets the first project back rather than a second one (or a `duplicate` refusal of itself).

### Archiving is not deleting

|                                                                   | Archive (MCP and portal)                                                                          | Permanent delete (portal only)                                                             |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Who                                                               | Project owners                                                                                    | Project owners, typing DELETE to confirm                                                   |
| What happens                                                      | `status` becomes `archived`. The project is read-only and leaves the sidebar and "My tasks" views | The project row is deleted and its tasks, sections, comments, history and links go with it |
| Tasks, sections, comments, history, Knowledge references, members | All kept, unchanged                                                                               | Gone                                                                                       |
| Reversible                                                        | Yes: `tasks_unarchive_project`, or Settings in the portal                                         | No, except by restoring the database from a backup                                         |
| Through MCP                                                       | `tasks_archive_project`, `tasks_unarchive_project`                                                | **Never.** There's no delete tool, and `PORTAL_MCP_TOOLS` is the whole list                |

### Chief of Staff and other assistants: working with projects

The gateway sends working instructions at `initialize` (`SERVER_INSTRUCTIONS` in `mcp/src/index.ts`), and each tool's description repeats what matters. For a request like _"Create a project to organise the Hilux maintenance, add the tasks we discussed and link any relevant Knowledge records"_:

1. `tasks_search_projects` for the name.
2. If a suitable project exists, offer to reuse it. Otherwise propose one (name, personal or shared, sections).
3. Create it only after the person agrees: `tasks_create_project` with a fresh `requestId` (and `knowledgeObjectIds` found with `knowledge_search`).
4. Add each task once with `tasks_create` (`projectId`, `sectionId`, its own `requestId`). Check `tasks_list` or `tasks_search` first if they may already exist.
5. Link more Knowledge with `tasks_link_knowledge` where the person can read it.
6. Reply with the project's `url` from the result.

Ids come only from results, and nothing is reported as created until a result says so. The Inbox (`tasks_create` with no `projectId`) and existing projects remain the normal destinations: a project is for work that needs one. `test/mcp-gateway/projects.test.ts` runs this flow through the real gateway.

### Chief of Staff

| Tool                            | What it returns                                                                                                                                                                                                                                                                                                            |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chief_of_staff_daily_context`  | From the personal and household dashboards: due today, overdue, next 7 days, high priority, unsorted Inbox, milestones, routines, reviews due, projects and goals needing attention, shared household work (members only), today's personal daily note, Knowledge updated since yesterday, decisions from the last 14 days |
| `chief_of_staff_weekly_context` | The seven days ending `weekEnding`: completed occurrences, overdue, next 14 days and deadlines, project health, goals, routines, and Knowledge notes, meetings and decisions in the period                                                                                                                                 |

Both are facts only, each with its id and link. For people with Calendar, both also carry `calendar`: events for the next 7 (daily) or 14 (weekly) days, overlapping commitments, important dates, planned leave, school holidays with and without leave, projected leave balances and failing subscriptions (worker/calendar/chief.ts). `notChecked` names what's never read: email, external calendars that aren't subscribed in Daly Calendar, and DalyHub, which is retired. There's no model call in either Worker.

### Daly Intelligence

Ten tools, described in [INTELLIGENCE.md](INTELLIGENCE.md#mcp): `knowledge_semantic_search`, `knowledge_find_related`, `intelligence_get_daily_briefing`, `intelligence_get_weekly_review`, `intelligence_list_suggestions`, `intelligence_get_processing_status` and `meetings_get_transcript` (reads), and `intelligence_capture_text`, `intelligence_request_analysis` and `intelligence_approve_suggestion` (writes, through the ledger; `0021` rebuilds `mcp_writes` so a capture or suggestion can be the recorded outcome). Captures only ever create suggestions; applying one needs `intelligence_approve_suggestion` for a suggestion the person explicitly approved, which runs the same code as the portal's Approve button. All need `intelligence.use`; with Intelligence switched off they say so. Reading a briefing never runs a model.

### Daly Calendar and Leave

Seventeen tools, described in [CALENDAR.md](CALENDAR.md#mcp-tools-17-63-in-total). The reads are `calendar_list_calendars`, `calendar_list_events`, `calendar_search_events`, `calendar_get_agenda`, `calendar_find_conflicts`, `calendar_list_subscriptions`, `calendar_school_holidays`, `leave_get_balances`, `leave_list_bookings`, `leave_forecast` and `leave_find_opportunities`. The writes go through the ledger: `calendar_create_event`, `calendar_update_event`, `calendar_create_subscription`, `calendar_refresh_subscription`, `leave_create_proposal` and `leave_update_proposal`. `0022` rebuilds `mcp_writes` for the outcomes `calendar_event`, `calendar_subscription` and `leave_booking`.

All of them need `calendar.use`, and the leave numbers come from the deterministic leave engine. Other people's private events are "Busy", and sensitive events are "Private event" even to their creator. Subscription addresses are never returned. Leave written through MCP is a draft or a proposal and is never requested, approved or taken. There's no delete tool.

### Daily Planner

Four tools (67 in all), described in [DAILY_PLANNER.md](DAILY_PLANNER.md#mcp-tools-4-67-in-total): `planner_get_day` and `planner_suggest_slots` (reads; suggestions create nothing), and `planner_schedule_task` and `planner_update_block` (writes through the ledger; move, resize or cancel, never delete). `0023` rebuilds `mcp_writes` for the `task_time_block` outcome. They need both `calendar.use` and `tasks.use`, and every task is checked through Tasks' own access. Scheduling never changes a task's dates or status.

### Today

Six read-only tools (73 in all), described in [DAILY_PLANNER.md](DAILY_PLANNER.md#mcp-tools-6-73-in-total): `today_get_summary`, `today_get_capacity`, `today_list_unscheduled`, `today_propose_plan`, `today_get_conflicts` and `today_get_briefing`. They need both `calendar.use` and `tasks.use`, call the same functions as `/portal/today`, and never write: acting on a proposal goes through `planner_schedule_task` (one session the person accepted), `tasks_update` or `tasks_reschedule`. Event titles follow Calendar's rules for AI ("Busy", "Private event"). `mcp_writes` doesn't change. The gateway is 2.5.0.

### Intelligence Centre

Twelve read-only tools (85 in all), described in [INTELLIGENCE_CENTRE.md](INTELLIGENCE_CENTRE.md#mcp): `centre_list_sources`, `centre_get_source_health`, `centre_get_situation`, `centre_search_incidents`, `centre_get_record`, `centre_search_warnings`, `centre_get_fire_danger`, `centre_get_observations`, `centre_list_road_disruptions`, `centre_list_watch_areas`, `centre_list_changes` and `centre_get_watch_briefing`. They need `centre.use`. Public records come with the providers' own times, links and attribution, and every result says it isn't an official warning service. Watch areas are the caller's own and **never include a location** (names, kinds and settings only); another person's watch area is `not_found`. No tool collects from a provider, runs a model or writes; `mcp_writes` doesn't change. The gateway is **2.6.0**, and its instructions tell assistants to report levels exactly as given and point people to official warnings. Deploy it only after the portal Worker that serves these tools (rollback: 2.5.0).

### Home & Assets

Sixteen tools (101 in all), described in [HOME_ASSETS.md](HOME_ASSETS.md#mcp). Ten read: `assets_search`, `assets_list`, `assets_get`, `assets_maintenance_history`, `assets_upcoming_maintenance`, `assets_insurance_renewals`, `assets_warranty_expiries`, `assets_list_documents` (names and kinds, never file contents), `assets_summary` and `assets_get_attention`. Six write through the ledger: `assets_create`, `assets_update`, `assets_create_maintenance`, `assets_complete_maintenance`, `assets_link_knowledge` and `assets_create_task`. They need `assets.use` and the asset's own rights (another person's private asset is `not_found`; unshared values and insurance are "not shared with you"). `mcp_writes` is rebuilt in `0026` for the `asset`, `asset_maintenance` and `asset_link` outcomes. `chief_of_staff_daily_context` adds `homeAssets` facts. The gateway is **2.7.0**; deploy it only after the portal Worker that serves these tools (rollback: 2.6.0). No delete, sharing, upload or bulk tool.

### Deliberately absent

Deleting, trashing or erasing anything, including projects (archiving is the reversible alternative). Bulk changes. Moving tasks between projects. Administering goals, spaces or types. Members and sharing, including turning a personal project into a shared one or back. Imports, exports and templates. Revision restore. SQL, files and arbitrary HTTP. These stay in the portal, where a person does them directly. The enforcement is that these operations don't exist in `PORTAL_MCP_TOOLS`, and the portal refuses any tool name not in it.

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
| `create_project`, `update_project`                             | `tasks_create_project`, `tasks_update_project` (plus `tasks_search_projects`, archive and restore)  | None. Added October 2026, after the owner asked for it                                                                                                 |
| `get_goals`, `get_goal`                                        | `tasks_list_goals`, `tasks_get_goal`                                                                | None                                                                                                                                                   |
| `create_goal`, `update_goal`                                   | Portal UI only                                                                                      | **Owner decision**, as for projects                                                                                                                    |
| `get_note(s)`, `create_note`                                   | `knowledge_get_object`, `knowledge_list_objects`, `knowledge_search`, `knowledge_create_object`     | None                                                                                                                                                   |
| `update_note`                                                  | `knowledge_update_object` (title, tags) + `knowledge_append_to_object`                              | Replacing a whole body is deliberately absent, so rich edits are never overwritten                                                                     |
| `record_decision`, `get_decisions`                             | `knowledge_create_object` type `decision`; `knowledge_list_objects` type `decision`                 | None                                                                                                                                                   |
| `get_areas`, `get_area`, `create_area`, `update_area`          | Knowledge objects of type `area` (`knowledge_list_objects`, `knowledge_create_object`)              | Tasks has no Areas. The migration turns each Area into a Knowledge Area plus a label on its tasks                                                      |
| `get_waiting_for`, `create_waiting_for`, `resolve_waiting_for` | Convention: label `waiting`. `tasks_list` with `labels: ["waiting"]`, `tasks_create`/`tasks_update` | No first-class "waiting on" field. The migration applies the convention; a dedicated field is a possible later Tasks feature                           |
| `get_people`, `get_person`, `create_person`, `update_person`   | Knowledge `person` objects (name and notes only)                                                    | **Owner decision:** DalyHub People hold contact details and aren't migrated by default. Nothing essential is lost from Tasks or Knowledge without them |

Nothing essential has to be built before the cutover. The remaining **owner decisions** are whether to add MCP goal creation and whether to migrate People (MCP project management was added in October 2026). Each can be answered after the cutover, because the DalyHub data stays in its backups.

## Writes: audit and retries

`mcp_writes` (migration `0018_mcp_writes.sql`, rebuilt by `0020_mcp_projects.sql` so a project can be the recorded outcome) gets one row per write: id, email, tool, request id, status, entity (`task`, `task_knowledge_link`, `knowledge_object` or `task_project`), error code and timestamps. It never holds titles, text or arguments. Project writes also go into the project's own history (`task_activity`: `project.create`, `project.update`, `project.status`) with field names only, never the name, description or sections. `knowledge_audit` and `task_activity` record every MCP write as the person who made it.

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

## Releasing project management

The five project tools need the portal and the gateway, in that order. Each step needs the owner's approval. The gateway is never deployed by CI.

1. **Portal.** Merging to `main` makes the deploy workflow record a D1 bookmark, apply `0020_mcp_projects.sql`, then deploy `dalyidau` (while CI's token is broken: `npx wrangler d1 migrations apply DB --remote --env=""`, then `npx wrangler deploy --env=""`). `0020` adds `task_projects.client_id` with its unique index (additive) and rebuilds `mcp_writes` to allow `task_project` as an outcome, copying every row (the one non-additive step: SQLite can't widen a CHECK constraint in place. No table refers to `mcp_writes`, and columns and indexes are unchanged). If `0018` isn't applied yet (see [MCP_CUTOVER.md](MCP_CUTOVER.md)), both run in order. Check `npx wrangler d1 migrations list DB --remote --env=""` and `node scripts/db-verify.mjs --env production`.
    - The live gateway keeps working throughout. It advertises only its existing tools, which behave as before (project results gain a `version` field).
2. **Gateway.** `npm run mcp:deploy:dry-run`, then `npx wrangler deploy --config mcp/wrangler.jsonc --env production` (Worker `dalyhub-mcp`; record the current version id first with `npx wrangler deployments list --name dalyhub-mcp`). Clients may need to reconnect, or refresh their tool list, to see 36 tools.
    - If the gateway goes out before the portal, the new tools answer `unknown_tool` and nothing is written.

**Rollback.**

- **Hide the project tools:** `npx wrangler rollback <previous version id> --name dalyhub-mcp`. The previous gateway lists 31 tools. Projects already made stay in the portal as ordinary projects.
- **Portal code:** `npx wrangler rollback <version id> --env=""`. Leave `0020` in place. The previous Worker never reads `client_id`, writes only entity types the rebuilt ledger still accepts, and refuses the new tool names as `unknown_tool` before the ledger is touched.
- **Stop all portal access through MCP** at once: `npx wrangler secret delete MCP_ACCESS_AUD --env=""`.
- **Undo a project made by mistake:** archive it (`tasks_archive_project` or the portal). Deleting it is a deliberate owner action in the portal (Settings → Delete, typing DELETE).

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
    - `protocol.test.ts`: initialize (with the working instructions), `tools/list` (exactly 36, with annotations), calls, none of the 34 legacy tools, `/mcp` only, 401/503 failures, development token limits and Host validation.
    - `isolation.test.ts`: the deployable config binds only `PORTAL` (no D1/KV/R2/DO/queues, nothing named DalyHub, no routes). The source imports nothing from DalyHub, and imports the portal only as types. A whole session (reads, writes, retries, briefings) runs with nothing but the binding and fetches only the Access keys. Also an unreachable or missing portal, per-person and write rate limits, and logs that hold no person, token or content.
    - `identities.test.ts`: two independent identities, both portal owners. Private tasks and notes stay invisible by id, list, search and both briefings. Every write tool is refused on the other person's records. Arguments can't name someone else, and request ids don't cross people. Shared projects and spaces work for editors, viewers can read but not write, a private note on a shared task shows only as `{ available: false }`, and removal cuts access on the next call. A person without a portal role and a service token get nothing.
    - `projects.test.ts`: the Chief of Staff project flow end to end (search, create once with a retry, tasks in sections, Knowledge, link), edit/archive/restore with versions, a second person's isolation, and project writes counted against the write limit.
- `test/mcp-projects.test.ts` covers the project tools against the portal directly: personal and shared creation, who may create, spoofed owners, validation, no second Inbox, matching and duplicates (archived too, per person), replays (including an abandoned ledger claim), stale versions, roles, private-project isolation, archive and restore keeping tasks, sections, comments and both kinds of Knowledge link, Knowledge access on create, and an audit trail without names or text.
- `test/mcp.test.ts` covers the portal entrypoint directly (tokens, roles, isolation, retries, recurrence, Knowledge safety, Chief of Staff).
- `test/mcp-contract.test.ts` compares the gateway's tools with the portal's: names, write set, every argument name, annotations, no identity fields.
- `npm run mcp:deploy:dry-run` builds the production gateway bundle and lists its bindings.

## Local development

1. Portal: `npx wrangler d1 migrations apply DB --local --env staging`, then `npx wrangler dev --env staging --var ENVIRONMENT:development --var SITE_URL:http://localhost:8797 --var ACCESS_DEV_EMAIL:you@example.com --var PORTAL_OWNER_EMAILS:you@example.com --port 8797`.
2. Gateway: put `DEV_MCP_TOKEN=<32+ characters>` in `mcp/.dev.vars`, then `npm run mcp:dev` (port 8798). Its `PORTAL` binding finds the local `dalyidau-staging` through the dev registry.
3. Call `http://localhost:8798/mcp` with `Authorization: Bearer <DEV_MCP_TOKEN>`. The gateway forwards the assertion `development`, which the portal accepts only with `ENVIRONMENT=development`, a localhost `SITE_URL` and `ACCESS_DEV_EMAIL`. The gateway accepts the token only with `AUTH_MODE` and `ENVIRONMENT` both `development` and a localhost request. No deployed environment meets any of that.
