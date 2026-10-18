# Daily Planner and time blocking (Milestone 6.2)

Daly Calendar and Daly Tasks become one scheduling system. You can set aside time for a task by dragging it onto the calendar or choosing a time, have several sessions per task, and move, resize or cancel them. Your events, shared and subscribed calendars, leave and planned task time sit in one timeline. The Daily Planner shows free time, capacity and conflicts, and suggests when to work on tasks. Nothing is scheduled until you accept it.

**Status:** draft PR. Nothing is merged or deployed, and migration `0023_daily_planner.sql` hasn't been applied anywhere remote. There's no new feature switch, secret or binding, and no existing switch value changes. See [Deploying](#deploying) and [Rollback](#rollback).

The repository is public, so tests and fixtures only use invented people and tasks.

---

## Principles

- **Tasks is the source of truth.** A time block holds a task's id, never a copy of it. Creating, moving, resizing or cancelling a block never changes the task's title, due date, deadline, priority or status. Completing a task from Calendar goes through Tasks' own API (`POST /api/portal/tasks/tasks/:id/complete`), its permissions and its history.
- **Suggestions only.** The planner proposes sessions from your free time, but nothing is created until you accept one (as it is, or adjusted first). No commitment is ever moved automatically: not events, not blocks, not tasks.
- **Deterministic.** The same inputs always give the same plan. There's no AI, no randomness and no paid service in any calculation, so Chief of Staff and MCP report what the portal worked out.
- **Private.** Blocks belong to one person, and nobody else ever sees them. Where you choose, a private feed shows them as "Busy" or "Focus time", never a task's title.

## How it fits together

```
src/shared/planner/
  types.ts                  Preferences (validated), shapes, limits, feed options
  engine.ts                 Availability, free time, conflicts, capacity, deterministic suggestions
worker/planner/
  blocks.ts                 Planning preferences, estimates, time blocks (create, move, resize, cancel)
  planning.ts               Task lists, a window's commitments, day plans, checks, suggestions
  facts.ts                  Facts for Chief of Staff and Intelligence briefings
worker/mcp/planner.ts       4 MCP tools
worker/calendar/api.ts      /api/portal/calendar/planner/* (Calendar's router, plus tasks.use)
worker/calendar/feeds.ts    Blocks in private feeds (as Busy or Focus time)
src/portal/calendar/
  planner-api.ts            Browser client, drag payloads
  planner-ui.tsx            Tasks panel, Schedule dialog, block panel, conflicts
  views.tsx                 Blocks in the day/week grid and phone lists, drop targets
  pages/calendar-planner-page.tsx   The Daily Planner
migrations/0023_daily_planner.sql
```

## What you see

| Where                                      | What                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Calendar day and week views                | A collapsible **Tasks to plan** panel beside the grid (below it on smaller screens), with tabs for Today, Overdue, Upcoming (7 days), Priority (P1 and P2) and Unscheduled. Blocks appear in the timeline with your events, dashed so they're distinct, and marked when they conflict. A **Daily planner** button opens the planner for the day.                                                   |
| Daily planner (`/portal/calendar/planner`) | One day: a capacity summary (planning hours, commitments, planned task time, free time and unplanned due work), the Tasks panel, the day's timeline (events, shared and subscribed calendars, leave, holidays and blocks), free time, conflicts, a **Suggested plan** for 1 to 7 days (Accept, Adjust or Skip each), and **Planning settings**. `?date=` chooses the day; `?block=` opens a block. |
| Calendar → Calendars and sharing → feeds   | **Time planned for tasks**: don't include (default), as "Busy", or as "Focus time".                                                                                                                                                                                                                                                                                                                |
| Navigation                                 | **Daily planner** under Calendar, for people who can open Tasks.                                                                                                                                                                                                                                                                                                                                   |

### Scheduling a task

- **Drag** a task from the panel onto a time in the day or week grid. It's planned there in 15-minute steps, for the time it still needs (its estimate less what's already planned) or an hour. Dropping on an event is allowed: the warning says what it overlaps. A toast confirms, lists any conflicts and offers **Undo**.
- **Schedule** (the keyboard and touch way, and on phones the only way): choose the date, start and length. Conflicts are checked as you choose ("Schedule anyway" when there are some). You can pick from the day's free time or ask for **Suggest times in the next week**, and set the task's **Estimated effort**.
- **Several sessions** per task are fine. A repeating task's session is for its current occurrence (recorded as `occurrence_date`). When that occurrence is completed and the task moves on, the session stays as a record and is marked "That occurrence is done", and the next occurrence starts with nothing planned.
- **Moving and resizing**: drag a block to another time, or open it and choose **Move or change length**, **15 min shorter** or **15 min longer**. **Cancel this time** frees the time and keeps the record. There's no delete.
- **Completing**: the round button on a task in the panel, or **Complete task** in a block's panel, uses Tasks' API, which handles repeats, subtasks (it asks first) and Undo.

## Who can see what

1. Cloudflare Access and the portal's JWT check, unchanged.
2. The planner needs **both `calendar.use` and `tasks.use`** (owners and admins). Routes live under Calendar's router (which checks `calendar.use`), and each one also checks `tasks.use`. Wedding editors and viewers get 403. The page is a 404 for anyone who can open Calendar but not Tasks.
3. **Every task is checked through Tasks' own access** (`requireTask`, editor or above, project not archived). A task you can't see is a 404, never a 403, as in Tasks. Viewers of a shared project can't plan or estimate its tasks.
4. **Blocks are the owner's alone.** Each read joins the block to its owner's current membership of the task's project. Someone else's block id is a 404.
5. **The database enforces it too** (`0023`):
    - a trigger refuses a block for anyone who isn't a member above viewer of the task's project;
    - a block can't change task or person;
    - leaving a project removes your blocks for its tasks;
    - moving a task to a project you're not in removes your blocks for it;
    - deleting a task removes its blocks and estimate (foreign keys).
6. **Events follow Calendar's rules.** Your window comes from `occurrencesInWindow`, so other people's private events are "Busy", sensitive events are "Private event" wherever AI can read them, and calendars you can't see aren't there at all. Hidden calendars are left out of planning, as they're left out of view.
7. **History** goes to `calendar_activity`: `time_block.create`, `time_block.update`, `time_block.cancel`, `estimate.set`, `estimate.clear` and `planner.preferences`, with ids only, never a title. MCP writes are marked `via = 'mcp'` and also go through the `mcp_writes` ledger.

## Data model (`0023_daily_planner.sql`)

| Table / column               | Holds                                                                                                                                                                                                                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `task_time_blocks`           | One session: task id, owner, wall-clock start date and time, IANA zone, length in minutes, UTC start and end instants, occurrence date (repeating tasks), status (`scheduled`/`cancelled`), source (`manual`, `suggestion`, `mcp`), client id (idempotent retries), version |
| `task_estimates`             | One estimate per task in minutes (5 to 2,880), shared by everyone who can work on it, like its priority                                                                                                                                                                     |
| `planner_preferences`        | Each person's planning hours per weekday, buffer, shortest and longest session, daily focus limit, default estimate, "plan on days off" (JSON, validated)                                                                                                                   |
| `calendar_feeds.time_blocks` | `none` (default), `busy` or `focus`                                                                                                                                                                                                                                         |
| `mcp_writes`                 | Rebuilt (every row copied) to accept the `task_time_block` outcome; the same columns and indexes                                                                                                                                                                            |

Ids are `ttb_` plus 14 random characters. Why separate tables:

- Estimates and blocks live outside `task_items`, so Tasks' rows, versions, API and MCP contract don't change.
- Planning preferences and the feed option live outside `calendar_preferences` and the feed's `scope`, because the earlier Worker validates both strictly (`.strict()`). A rollback would otherwise reject documents containing fields it doesn't know.

## Time zones and daylight saving

- Blocks store the **wall-clock** date and start in the zone they were planned in (your Calendar time zone, `Australia/Sydney` by default), plus instants. The end is the start plus the length in **elapsed** time.
- On 4 October 2026 (clocks go forward at 2 am), a 1:30 am two-hour session ends at 4:30 am local. On 5 April 2026 (clocks go back at 3 am) it ends at 2:30 am local. Both are two real hours.
- A start in the hour daylight saving skips (for example 2:30 am on 4 October) is refused with an explanation, not moved silently. In the repeated hour in April, the shared conversion picks one of the two (see the note in [CALENDAR.md](CALENDAR.md#events-recurrence-time-zones)).
- Days are measured from local midnight to the next, so the 23- and 25-hour days are exact. Suggestions start on quarter hours: every Australian offset is a multiple of 15 minutes, so UTC quarters are local ones.
- Changing only a block's length keeps its start exactly as planned. A new start is read in your current zone, as the planner shows it. A block planned in another zone says so.

## The planner's arithmetic (`src/shared/planner/engine.ts`)

- **Planning hours**: your hours for that weekday (default Monday to Friday, 9 to 5). Removed from them:
    - NSW public holidays that apply to you, and your non-working days (both from the leave engine's context);
    - your **requested, approved or taken** leave, never drafts, proposals or scenarios. A full day removes everything, a morning or afternoon booking removes that half, and an hours booking removes that many hours from the end of the day.

    **Plan on days off** includes weekends, holidays and leave; a day with no hours of its own then uses 9 to 5.

- **Commitments**: your timed events that show as busy (local, shared, imported and subscribed), plus your scheduled blocks. Free events, all-day events and cancelled occurrences don't take time.
- **Free time**: planning hours less commitments, with your buffer (default 10 minutes) after each, and never before now.
- **Conflicts** (warnings, never refusals): overlaps with events, which say when they're in a subscribed or shared calendar; overlaps with other blocks; leave; days off; time outside planning hours; and ending after the task's due time, due date or deadline.
- **Capacity**: planning hours, busy event time inside them, planned block time, free time, and the estimated time still needed for tasks due that day (or overdue, on today). The day is shown as Light, Balanced, Full, Over-committed or Day off.
- **Suggestions**:
    1. Tasks are ordered deterministically: overdue first, then the earliest due date or deadline, then priority (P1 first), then the larger estimate, then the task id.
    2. Each task needs its estimate (or your default) less what's already planned for its current occurrence.
    3. Sessions go into the earliest free time, between your shortest and longest session lengths (several sessions when needed), with a buffer after each, within your daily focus limit (default 5 hours, counting blocks already planned), and finishing before the task is due when possible.
    4. Only when nothing earlier is free do sessions go after the due time; they're marked late, with the reason.
    5. Tasks that don't fit are listed with the time they still need.

    By default the candidates are Today, Overdue, Upcoming and Priority tasks not yet fully planned, or the tasks you choose (at most 50, each checked through Tasks).

## Private feeds

Blocks are published only when the feed's **Time planned for tasks** option is on, as "Busy" or "Focus time", with `CLASS:PRIVATE` and no description, location or link, and never the task's title or project. Only your own scheduled blocks for tasks you can still work on are included, from 30 days ago to a year ahead. They use the zone they were planned in (`@planner.daly.id.au` UIDs). The whole route stays behind the existing **Calendar subscription addresses** switch (`calendar.feeds`, unchanged). A feed can now publish only time blocks. A feed publishing nothing at all is still refused.

## Chief of Staff and briefings

- `chief_of_staff_daily_context` adds a `planner` section for people with both Calendar and Tasks: today's capacity, planned sessions, free time (total, longest and slots), conflicts, tasks due and not yet planned (with estimates), and up to five suggested sessions. It's marked "not scheduled; nothing is created unless the person accepts it".
- The daily Intelligence briefing's existing **Calendar and leave** section adds "Planned: …", conflict and "Not planned yet: …" items. There's no new section key, so saved briefing settings and earlier Workers are unaffected.
- Every item links to the portal. AI explains, but never supplies times, capacity or conflicts.

## MCP tools (4; 67 in total)

| Tool                    | Notes                                                                                                                                                                |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `planner_get_day`       | Read. The day's facts, as above.                                                                                                                                     |
| `planner_suggest_slots` | Read. Suggestions for 1 to 14 days, optionally for chosen tasks. Creates nothing.                                                                                    |
| `planner_schedule_task` | Write. Blocks time for a task the person can work on, at a time they agreed to. Conflicts are returned as warnings. `requestId` makes a retry return the same block. |
| `planner_update_block`  | Write. Move, resize or cancel (`cancel: true`) a block, with the version read. No delete.                                                                            |

Identity comes only from the re-verified Access token. Writes go through `mcp_writes` (entity type `task_time_block`, ids only) and the gateway's write rate limit. `PORTAL_MCP_TOOLS` and `mcp/src/portal-tools.ts` are compared field by field in `test/mcp-contract.test.ts`. The gateway's version is now **2.4.0**, and its instructions say suggestions are proposals to confirm with the person.

## Performance and cost

- **D1**: a window is the Calendar window (unchanged), one indexed query on `task_time_blocks (owner_email, start_at)`, and Tasks' own list queries. Estimates and planned minutes are read in chunks of 90 ids.
- The engine runs in the Worker or the browser, bounded by the window (at most 62 days, and suggestions at most 14).
- **Bundles**: no new dependency or service. The Worker dry-run is 2,786 KiB (841 KiB gzipped), up from 2,752 KiB (831 KiB). The portal browser bundle grew from about 2.58 MB to 2.63 MB.

## Known limitations

- Blocks don't repeat. Plan each session, or use suggestions over several days.
- Dragging works with a mouse or trackpad in the desktop day and week grids. On phones and tablets, and with the keyboard, use **Schedule**. Resizing is in the block's panel rather than by dragging an edge.
- All-day events don't take planning time, even when they're marked busy (travel days, for example). Use leave, a non-working day or a busy timed event.
- Others' blocks are never shared, so "shared commitments" means shared calendar events. Joint planning across two people's free time isn't included.
- In the repeated hour when daylight saving ends, a typed start is read as one of the two (the shared conversion's choice).
- The personal Calendar backup (Settings → Backup) doesn't include blocks or estimates, because they belong to tasks that a restore wouldn't recreate. Database backups include all three tables.

## Testing

- `test/planner-engine.test.ts`: interval arithmetic, planning hours (weekdays, NSW Labour Day, non-working days, full, morning, afternoon and hours leave), daylight saving on both 2026 changes, free time and buffers, every conflict kind (including subscribed and shared calendars), capacity statuses, and suggestion ordering, determinism, quarter hours, buffers, "never before now", splitting, the focus limit, already-planned time, due times, late sessions, unplaced tasks and planning across the October change.
- `test/planner.test.ts`:
    - the database's triggers and checks; cascades on task deletion, leaving a project and moving a task;
    - several sessions, moving, resizing, cancelling, stale versions, idempotent retries and refusals;
    - Tasks unchanged, and history without content;
    - daylight saving through the API;
    - a repeating task completed through Tasks;
    - privacy between people, viewers, wedding editors and 404s for others' tasks;
    - conflicts with your events, shared calendars (others' private events as Busy) and subscribed calendars;
    - capacity, deterministic suggestions that create nothing, and accepted and adjusted suggestions;
    - Labour Day;
    - feeds (none, busy, focus; no titles);
    - MCP (reads, the ledger, replay, cancel, another person's task, Chief of Staff);
    - the planner page, and the Tasks panel in day and week views but not month.
- `e2e/planner.spec.ts` (desktop and Pixel 7):
    - axe and no horizontal scrolling on the planner, week and day views;
    - scheduling with the button, then resizing and cancelling;
    - dragging a task onto the week grid (desktop), and collapsing the panel;
    - suggesting, accepting and completing a task.
- MCP contract and gateway tests updated for 67 tools. `npm run test:backup` fills and restores the three tables, and `npm run db:verify` has a new check: time blocks belong to people who can still work on their task.

## Deploying

Nothing here has been run against a remote database or deployed.

1. **Check remote migration state** (read-only): `npx wrangler d1 migrations list DB --remote --env=""`. `0023_daily_planner.sql` will be unapplied (and so will earlier ones, if they haven't deployed).
2. **Back up and verify**: `npm run db:backup -- --env production`. Note the D1 Time Travel bookmark it logs.
3. **Merge the draft PR** after review. **Merging to `main` deploys and applies migrations automatically** (`.github/workflows/deploy.yml`), including 0023's `mcp_writes` rebuild (every row is copied; the earlier Worker only writes entity types the rebuilt ledger still accepts). By hand instead: `npx wrangler d1 migrations apply DB --remote --env=""`, then `npx wrangler deploy --env=""`.
4. `npm run db:verify -- --env production`.
5. Open `/portal/calendar/planner` as each owner. Check Planning settings (hours default to Monday to Friday, 9 to 5), set an estimate on a task or two, and try **Suggest a plan**.
6. **MCP**: the gateway is deployed by hand only (`npm run mcp:deploy:dry-run`, then `npx wrangler deploy --config mcp/wrangler.jsonc --env production`), **after** the portal Worker is live with 0023. Until then the gateway (2.3.0) doesn't advertise the four planner tools. Deploying 2.4.0 before the portal would advertise tools the portal can't serve yet. See [MCP_CUTOVER.md](MCP_CUTOVER.md).
7. No new secret, binding, switch, DNS, `routes` or Access change. Feeds that publish blocks need the existing `calendar.feeds` switch, which is not changed here.

## Rollback

- **Code**: `npx wrangler rollback --env=""` (or revert the merge commit on `main`, which redeploys the previous Worker). The previous Worker never reads `task_time_blocks`, `task_estimates`, `planner_preferences` or `calendar_feeds.time_blocks`, and it writes only ledger entity types the rebuilt `mcp_writes` still accepts. Feeds keep working: the old Worker ignores the new column, so blocks simply stop appearing in them.
- **MCP gateway**: if 2.4.0 was deployed, roll it back with `npx wrangler rollback --config mcp/wrangler.jsonc --env production` so it stops advertising the planner tools.
- **Schema**: D1 has no down migrations, and the new tables are harmless to leave in place. To remove them entirely, restore the backup from step 2 or use D1 Time Travel to the bookmark. Either also reverts any other data written since, so prefer leaving the tables.
- **Data only** (keeping the code): blocks can be cancelled in the portal or with `planner_update_block`. Nothing else depends on them.
