# Daily Planner, time blocking and Today (Milestones 6.2 and 6.3)

This document covers the Daily Planner and time blocking (Milestone 6.2, below), and **[Today](#today)** (Milestone 6.3): the unified daily dashboard at `/portal/today`, Plan My Day, morning and evening routines, Quick capture, personalisation and the Chief of Staff briefing.

## Daily Planner and time blocking (Milestone 6.2)

Daly Calendar and Daly Tasks become one scheduling system. You can set aside time for a task by dragging it onto the calendar or choosing a time, have several sessions per task, and move, resize or cancel them. Your events, shared and subscribed calendars, leave and planned task time sit in one timeline. The Daily Planner shows free time, capacity and conflicts, and suggests when to work on tasks. Nothing is scheduled until you accept it.

**Status:** merged in #34. Whether migration `0023_daily_planner.sql` has reached production depends on the deploy. There's no new feature switch, secret or binding, and no existing switch value changes. See [Deploying](#deploying) and [Rollback](#rollback).

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

---

# Today

Milestone 6.3. One place to plan and run the day: `/portal/today` brings together Daly Calendar, Daly Tasks, the Daily Planner's time blocks, Daly Knowledge (capture), Daly Intelligence (an optional explanation), portal notifications and a Chief of Staff briefing. You can open Today, understand your day, schedule work, review priorities and finish the day without going between applications.

**Status:** draft PR. Nothing is merged or deployed, and migration `0024_today.sql` hasn't been applied anywhere remote. There's no new feature switch, secret, binding or paid service, and no existing switch changes. See [Deploying Today](#deploying-today) and [Rolling back Today](#rolling-back-today).

## Principles

- **Today owns no tasks, events or sessions.** Tasks stays the source of truth for a task's status, due date and priority; Calendar for events; the Daily Planner for time blocks; Knowledge for notes. Today reads them through each application's own functions and access rules, and every change goes back through their own APIs: completing (`POST /api/portal/tasks/tasks/:id/complete`), postponing and priority (`PATCH /api/portal/tasks/tasks/:id`), scheduling, moving, resizing and cancelling sessions (`/api/portal/calendar/planner/blocks`), appointments (`POST /api/portal/calendar/events`), notes (Knowledge's object and daily-note APIs) and AI capture (`POST /api/portal/intelligence/captures`). Scheduling never creates a second task record.
- **Proposals before changes.** Plan My Day and Morning planning show proposed sessions first. Each can be accepted, rejected or adjusted, and nothing is created until the person approves. Meetings, other sessions and task deadlines are never moved. The evening review moves nothing unless the person chooses it for each session.
- **Deterministic, and it works without AI.** Capacity, conflicts, proposals, priorities and recommended next actions come from fixed rules over the records (`src/shared/today/engine.ts`, `src/shared/planner/engine.ts`). AI is an optional explanation on top, and can't add facts.
- **Private.** Everything Today shows is the signed-in person's own view: others' private events in shared calendars are "Busy", other people's sessions never appear, and reviews and preferences belong to one person.

## Architecture

```
src/shared/today/
  types.ts                 Preferences (validated), dashboard, capacity, timeline, briefing and review shapes
  engine.ts                Capacity with interval unions, overbooked periods, the timeline, next actions
src/shared/planner/engine.ts   (6.2) plus breaks (taken out of availability) and focus periods (used first)
worker/today/
  dashboard.ts             The dashboard, part by part (plan, deadlines, commitments, notifications, completed, briefing, reviews)
  briefing.ts              Chief of Staff facts and next actions
  plan.ts                  Plan My Day: propose (read-only) and apply (approved sessions only)
  prefs.ts                 Today preferences
  reviews.ts               Morning planning and evening review records
  api.ts                   /api/portal/today/*
worker/mcp/today.ts        6 read-only MCP tools
worker/planner/planning.ts (6.2) now reads Today's breaks, focus periods and excluded calendars, and adds an Inbox list
src/portal/today/
  pages/today-page.tsx     The page
  sections.tsx             Briefing, capacity, timeline, needs attention, deadlines, commitments, notifications
  plan-my-day.tsx          The proposal editor and Plan My Day dialog
  routines.tsx             Morning planning and evening review
  quick-capture.tsx        Quick capture
  settings-dialog.tsx      Customise Today
  today-api.ts             Browser client
migrations/0024_today.sql
```

Today is a portal-level page (not inside one application), so the sidebar shows it under **Applications**, above **All Applications**, and the launcher (`/portal`) has a **Today** card above the application cards. Calendar, Tasks, Knowledge and Intelligence stay where they were, and the Calendar's own Daily planner is unchanged.

## Data model (`0024_today.sql`)

Additive only: two new tables, nothing altered.

| Table               | Holds                                                                                                                                                                                                                                                                                          |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `today_preferences` | One JSON document per person (validated by `todayPreferences`): sections and their order, timeline view (list or grid), "Open in Calendar" view, start of the day, show completed tasks, calendars left out of availability, breaks, focus periods, briefing detail, AI explanation, lookahead |
| `daily_reviews`     | One morning and one evening record per person per day: up to three priority task ids, a summary of counts (planned, rescheduled, returned, kept, completed, follow-ups, capacity confirmed), the evening note in the person's words, and a version                                             |

Working hours, buffers, session lengths and the daily focus limit stay in the Daily Planner's `planner_preferences` (Customise Today opens them). Breaks and focus periods are kept apart from it because the earlier Worker validates that document strictly and would fall back to defaults on fields it doesn't know.

History goes to `calendar_activity` with ids only: `today.preferences`, `today.morning` and `today.evening` (entity `daily_review`, id `date:kind`), and `today.plan_applied` (entity `today_plan`, id the date). Each session created, moved or cancelled is also recorded by the planner itself (`time_block.*`), and Tasks records its own changes.

## User journeys

- **Open Today.** A greeting and the date in your time zone (Australia/Sydney unless you changed Calendar's), then the sections in your order: Chief of Staff briefing, capacity, timeline, needs attention (due today, overdue, high priority with no time planned, and what's done), upcoming deadlines, commitments (your own today; shared household calendars for the next days) and notifications (Calendar notices, task reminders, AI suggestions waiting). The **Tasks** panel sits beside them (below on phones) and collapses.
- **Change day.** Today, Tomorrow, the previous and next day, or any date with the date picker. These are plain links (`?date=`).
- **Timeline.** Fixed commitments (events, marked read-only for subscribed, imported or view-only calendars, and shared), movable task sessions, breaks, part-day leave, focus periods and free time, in time order. All-day items (holidays, leave, all-day events) sit above. **Move or resize** opens the planner's session panel; **Plan a task** in a free slot schedules an unscheduled task there. The list works on every screen; the time grid (larger screens) supports dragging tasks and sessions as in Calendar.
- **Tasks panel.** Inbox, Today, Overdue, Upcoming, Priority and Unscheduled, filterable by project. Each task shows its estimate, planned time and what's still left to plan. **Schedule** (several sessions are fine), complete, **Postpone to tomorrow** or **a week**, change priority (P1 to P4, where you can edit it) and **Open the task**, all through Tasks.
- **Plan my day.** A proposal for the day (see [Planning algorithm](#planning-algorithm)). Each session can be ticked (accepted) or unticked (rejected), and its start and length changed. **Approve** creates only the ticked ones.
- **Morning planning** (optional, when you choose it, or automatically before noon if your start of the day is "Morning planning"): review the day, choose the top three (pre-filled by the planner's order), confirm capacity, look at proposed sessions for them and what's due, approve.
- **Evening review** (optional): what got done; each unfinished session on the day (task still open) to reschedule (a date and time, or **Suggest a time**), return to the unscheduled list (cancels the session, the task doesn't change) or leave as it is (the default); tomorrow's preview; a private note and follow-up tasks (to your Inbox, optionally due tomorrow).
- **Quick capture.** Task (Tasks' Quick Add, which picks a project), Note to Knowledge (Inbox or today's daily note), Appointment (your calendar), and, when Intelligence is open to you, **Capture for AI to sort**, whose suggestions wait for your approval. Everything except the last works with AI off.
- **Customise Today.** Sections and order, start of the day, timeline view, "Open in Calendar" view, briefing detail and lookahead, show completed tasks, the AI explanation, which calendars count towards availability, breaks, focus periods, and (through the planner's settings) working hours and session lengths.

## Capacity calculations (`dayCapacity`)

All of it is interval arithmetic on instants for the day, from local midnight to the next (so 23- and 25-hour days are exact):

1. **Available** = planning hours for the weekday (the Daily Planner's working hours) less public holidays and non-working days (your work pattern), less requested, approved or taken leave (full, morning, afternoon or hours), less **breaks**. "Plan on days off" works as in 6.2.
2. **Appointments** = the union of busy timed events (yours, shared, subscribed and imported) inside the available hours. Two overlapping meetings take their time once. Free events, all-day events, cancelled occurrences and calendars you left out of availability don't count.
3. **Task time** = the union of your scheduled sessions inside the available hours, **less any part that overlaps an appointment**, so nothing is counted twice.
4. **Committed** = the union of both inside the hours. **Free** = available less committed.
5. **Outside hours** = commitments that day outside the planning hours (shown, but not taken from capacity).
6. **Overbooked** = periods where two or more busy commitments overlap (a sweep over start and end points; back-to-back isn't an overlap), merged when they touch, with what overlaps there.
7. **Unscheduled workload** = estimated time still needed for tasks due that day (or overdue, on today), less what's planned for their current occurrence; tasks without an estimate use your default. **Shortfall** = how much of it doesn't fit in the free time or what's left of the daily focus limit.
8. **Status**: Day off (no hours), Overbooked (a shortfall or an overlap), Full (less than 20% free, or the focus limit reached), Light (less than half committed), otherwise Balanced.

Each figure comes with a plain explanation ("How this was worked out"). The same function runs for the page and MCP, and the result doesn't depend on the order records arrive in.

The Calendar's own Daily Planner shows 6.2's capacity summary; both now take breaks and excluded calendars into account, because they share the planning window.

## Planning algorithm

Plan My Day uses the 6.2 planner (`suggestPlan`) with one addition:

1. Candidates: tasks due today, overdue, upcoming (7 days) and P1–P2 not yet fully planned, or the tasks you chose (Morning planning sends your top three and what's due).
2. Order: overdue first, then the earliest due date or deadline, then priority, then the larger estimate, then the id.
3. Each needs its estimate (or your default) less what's planned for its current occurrence.
4. **Focus periods first**: free time inside your focus periods is offered before the rest of the day (each part in time order). Without focus periods, the earliest free time, as before.
5. Sessions between your shortest and longest lengths, on quarter hours, never before now, with your buffer after each, within the daily focus limit, before the task is due where possible (late sessions are marked), never in a break, over a meeting, on leave or a day off.
6. Tasks that don't fit are listed with the time they still need.

Each proposed session carries any warnings (from `conflictsFor`) and whether it's in a focus period. **Applying** (`POST /api/portal/today/plan/apply`) takes up to 20 approved sessions, each with its own client id, and creates them one by one through the planner's `createBlock`: every task is re-checked through Tasks, a repeat with the same client ids creates nothing new, and a session that can't be created (completed meanwhile, no access) is reported while the rest go ahead. Proposing (`POST /api/portal/today/plan`) is read-only, and the same inputs give the same proposal.

## Chief of Staff integration

Today's briefing (`worker/today/briefing.ts`) lists, each with a link to its record:

- today's commitments (events and planned sessions), top priorities (your morning choice, otherwise the planner's order), overdue work, scheduling conflicts and overbooked periods, capacity, project deadlines and milestones (two weeks), shared household commitments (your lookahead), sessions from yesterday whose tasks are still open, and
- **recommended next actions** from fixed rules, in a fixed order: the next commitment within an hour, conflicts, yesterday's unfinished work, overdue work with no time, a shortfall, scheduling the top priority, Morning planning (before noon) or the Evening review (from 4 pm) if not done, and sorting the Inbox. If nothing applies, it says so rather than inventing something.

It also says what wasn't read (email, messages, finances, services outside the portal). No model is involved.

**Explain my day** (when Intelligence is open to you and the explanation is on in Customise Today) asks Daly Intelligence's existing daily briefing for recommendations (`POST /api/portal/intelligence/briefings/daily/recommend`). That path is unchanged: Intelligence's switches, budget, circuit breaker and `fence()`, model output schema-validated, every reference a model returns must be one of the briefing's own facts or it's dropped, and recommendations are reused while the facts' fingerprint is unchanged. Nothing calls a model when Today loads.

For MCP and anything an assistant reads, event titles follow Calendar's rules for AI: others' private events "Busy", sensitive events "Private event". On your own Today page you see your own sensitive events' titles, as in Calendar.

## Permissions

1. Cloudflare Access and the portal's JWT check, unchanged.
2. Today needs **both `calendar.use` and `tasks.use`** (owners and admins), like the Daily Planner. The API answers 403 otherwise; the page shows the portal's "no access" page; the sidebar link and launcher card only appear for people who have both.
3. Tasks, events and sessions are read through Tasks', Calendar's and the planner's own access: project membership (viewers can't plan or edit a shared project's tasks), calendar membership (hidden calendars stay out; others' private events are "Busy"), and sessions joined to their owner's membership. Someone else's session never appears.
4. Morning priorities are checked through Tasks (`requireTask`): a task you can't see is a 404. Only calendars you can see can be left out of availability.
5. Preferences and reviews are per person and versioned (a stale save is a 409).

## MCP tools (6; 73 in total)

All read-only. They need `calendar.use` and `tasks.use`, take identity only from the re-verified Access token, and use the same functions as the page. Writes go through the existing tools: `planner_schedule_task` and `planner_update_block` for sessions, `tasks_update` and `tasks_reschedule` for tasks, each with its ledger, idempotency and audit. No new write tool was needed, so `mcp_writes` doesn't change.

| Tool                     | Returns                                                                                                                                        |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `today_get_summary`      | Capacity, the timeline (fixed, movable, read-only), due today, overdue, high-priority unscheduled, deadlines, notifications, routines done     |
| `today_get_capacity`     | Every capacity figure, overbooked periods and the explanation                                                                                  |
| `today_list_unscheduled` | Tasks with no time planned for their current occurrence, optionally in one project                                                             |
| `today_propose_plan`     | Plan My Day's proposal, with warnings. Creates nothing: the assistant schedules only sessions the person accepts, with `planner_schedule_task` |
| `today_get_conflicts`    | Sessions that overlap events, sessions, breaks, leave or days off, or end after the task is due, plus overbooked periods                       |
| `today_get_briefing`     | The Chief of Staff briefing, with a link for every item and the recommended next actions                                                       |

`PORTAL_MCP_TOOLS` and `mcp/src/portal-tools.ts` match field by field (`test/mcp-contract.test.ts`). The gateway is now **2.5.0**, and its instructions say Today's tools only read and proposals need the person's agreement.

## Configuration

- **Per person** (Customise Today): everything listed in [User journeys](#user-journeys). Defaults: every section in the order above, list timeline, day view, the whole dashboard, completed tasks shown, every calendar counts, no breaks, no focus periods, full briefing with the AI explanation offered, 7 days of shared commitments. With no breaks or focus periods, the 6.2 planner behaves exactly as before.
- **Time zone**: Calendar's time zone setting (default `Australia/Sydney`).
- **Portal**: no new switch, secret, binding or Access change. The AI explanation needs Daly Intelligence's existing switches; with them off (the default), "Explain my day" says so and the facts stand alone.
- **Feeds**: Today publishes nothing. Task sessions reach a private ICS feed only through 6.2's per-feed option (off by default), as "Busy" or "Focus time", never a title.

## Performance and caching

- The page's first render is one Worker request: the dashboard parts run in parallel (`Promise.all`) over indexed D1 queries (the planning window, Tasks' lists, deadlines, shared commitments, notifications, completed tasks, reviews), plus the day's events and overlays for the time grid.
- After a change, only the affected parts are fetched again (`GET /api/portal/today?parts=plan,briefing,completed`, or `notifications`, or `reviews,briefing`), never the whole page.
- **Caching**: none on the server. Every part is computed from the records on each request, so there's nothing to invalidate or to go stale. The only reused result is Intelligence's own recommendations, cached against its facts' fingerprint (unchanged from Milestone 5). No model call happens on load.
- Bundles: no new dependency. The portal bundle grew by Today's pages (see the PR for sizes).

## Deploying Today

Nothing here has been run against a remote database or deployed.

1. Check remote migration state (read-only): `npx wrangler d1 migrations list DB --remote --env=""`. `0024_today.sql` will be unapplied (and 0023 too, if 6.2 hasn't deployed).
2. Back up and verify: `npm run db:backup -- --env production`, and note the D1 Time Travel bookmark it logs.
3. Merge the draft PR after review. **Merging to `main` deploys and applies migrations automatically** (`.github/workflows/deploy.yml`). 0024 only creates two tables.
4. `npm run db:verify -- --env production` (it now checks that Today's preferences and reviews are valid JSON).
5. Open `/portal/today` as each owner: check the hours in Customise Today → Working hours, add a lunch break if you want one, and try Plan my day.
6. **MCP**: deploy the gateway by hand **after** the portal Worker is live (`npm run mcp:deploy:dry-run`, then `npx wrangler deploy --config mcp/wrangler.jsonc --env production`). Until then the gateway (2.4.0) doesn't advertise the six Today tools. Deploying 2.5.0 first would advertise tools the portal can't serve yet. See [MCP_CUTOVER.md](MCP_CUTOVER.md).

## Backup

`npm run db:backup` exports `today_preferences` and `daily_reviews` with everything else (`scripts/lib/ops.mjs`), and `npm run test:backup` fills, backs up and restores both. The personal Calendar backup (Settings → Backup) doesn't include them, as it doesn't include time blocks.

## Rolling back Today

- **Code**: `npx wrangler rollback --env=""`, or revert the merge commit on `main`. The previous Worker never reads `today_preferences` or `daily_reviews`, so they're simply unused. Breaks and excluded calendars then stop affecting the Daily Planner, which goes back to 6.2's behaviour.
- **MCP gateway**: if 2.5.0 was deployed, `npx wrangler rollback --config mcp/wrangler.jsonc --env production`.
- **Schema**: D1 has no down migrations, and the two tables are harmless to leave. To remove them, restore the step 2 backup or use Time Travel, which also reverts other data written since, so prefer leaving them.
- **Data only**: sessions created by Plan My Day are ordinary time blocks (source `suggestion`) and can be cancelled in the portal.

## Limitations

- Today is for one person. Shared commitments are shared calendar events; nobody else's sessions, tasks or free time are planned jointly.
- Breaks and focus periods repeat weekly on chosen weekdays; there are no one-off breaks (use a busy event).
- Dragging works in the time grid on larger screens with a mouse or trackpad. On phones, and with the keyboard, use Schedule, Plan a task, or Move or resize.
- Sessions don't repeat, as in 6.2.
- Capacity counts all-day events as free (use leave, a non-working day or a busy timed event).
- The evening review's follow-ups go to your Tasks Inbox; pick a project afterwards in Tasks.
- "Explain my day" uses Intelligence's daily briefing, which covers today only, whichever date Today shows.
- Adding an appointment from Quick capture reloads the page, so the time grid shows the new event.

## Testing Today

- `test/today-engine.test.ts`: overbooked sweeps (back-to-back, triple overlaps), capacity unions (overlapping meetings, sessions over meetings, outside hours), order independence, breaks, non-working days, Labour Day, full and half-day leave, both 2026 daylight saving changes, shortfalls and statuses, excluded calendars, break conflicts, focus-first suggestions (deterministic, never in a break or over a meeting), timeline ordering, fixed and movable and read-only items, free time after now, next-action rules and grounding, and preference validation.
- `test/today.test.ts`: access (wedding editors refused at the API, page and MCP), the dashboard with overlaps counted once, selective parts, shared-calendar privacy ("Busy") and others' sessions, excluded calendars (and the Calendar planner agreeing), preferences (versions, validation, breaks in capacity, suggestions and conflicts, history without content), Plan My Day (nothing before approval, accept, reject and adjust, retries, tasks unchanged, focus periods first, multiple sessions, failures reported, past days refused), morning and evening records (priorities checked through Tasks, versions, privacy), yesterday's unfinished sessions untouched until decided, the briefing's grounding (every task reference matches its record, nothing of anyone else's, no model calls), the six MCP tools (read-only, sensitive titles as "Private event", no ledger rows, refusals), and the pages, sidebar and launcher.
- `e2e/today.spec.ts` (desktop and Pixel 7): axe and no horizontal scrolling on today and tomorrow, the launcher card and sidebar link; Plan my day with one session rejected and one adjusted; completing a task and opening Quick capture with the keyboard; morning planning and an evening review that returns a session.
- Updated: MCP counts (73) and the gateway protocol tests, the backup test, `db:verify`, and the reset list for tests.
