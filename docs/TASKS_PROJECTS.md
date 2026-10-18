# Daly Tasks & Projects

A private task and project manager at `/portal/tasks` for personal work and work shared between two people: Inbox, Today, Upcoming, projects with sections and boards, subtasks, priorities, due dates and deadlines, repeating tasks, labels, saved filters, comments, history, in-app reminders, links to Daly Knowledge, and portable export. Milestone 3 adds a personal and household dashboard, project health and reviews, goals, household routines, workload and timelines, reports, and related tasks on Knowledge pages. It runs on the existing Worker and D1 database, needs no AI or paid service, and is meant to replace Todoist without locking data into a proprietary format.

**Status:** Milestones 1 and 2 are merged (PRs #25 and #26). Milestone 3 (integrated productivity) is built and tested on `feature/tasks-milestone-3`, branched from `main` after #26, as a draft PR. **Nothing from Milestone 3 is deployed**, and migration `0017_tasks_productivity.sql` hasn't been applied to any remote database. Whether `0015`/`0016` have reached production depends on whether the deploy after each merge succeeded (the deploy token was reported invalid from 14 October); check before deploying. See [Deploying](#deploying).

The repository is public: tests and fixtures use invented people and tasks only.

---

## How it fits together

```
src/shared/tasks/          Shared by Worker and browser
  types.ts                 Data shapes, limits, roles, priorities
  recurrence.ts            Repeat rules: validation, next occurrence, exceptions, moving a series, RRULE export
  parse.ts                 Quick Add's deterministic text parser (and its "not understood" hints)
  filters.ts               The filter definition (validated on both sides)
  dates.ts                 Calendar dates, relative labels, zoned reminder instants
  view-preferences.ts      Each person's list choices; Upcoming's agenda/week/month windows
  templates.ts             Template and checklist validation
  todoist.ts               Reading Todoist's CSV export; import matching keys
  productivity.ts          Milestone 3 shapes and the fixed rules: health, reviews, goals, turns, workload warnings, reports
worker/tasks/
  access.ts                Project membership: the only way to reach a project, task or result
  api.ts                   /api/portal/tasks/* router
  tasks.ts                 Task engine: create, edit, move, complete/skip/reopen, duplicate, delete, bulk
  projects.ts              Projects, members, sections
  views.ts                 Inbox, Today, Upcoming, Overdue, Completed, filters, search
  labels.ts comments.ts    Labels; comments
  reminders.ts settings.ts Reminders; saved filters and preferences
  notify.ts                Background reminder emails (run by the existing cron trigger)
  templates.ts import.ts   Templates; Todoist import (preview, reconcile, bounded resumable runs)
  knowledge.ts             References to Knowledge objects, checked through Knowledge's own access
  activity.ts export.ts    Privacy-safe history; JSON and CSV export
  pages.ts rows.ts         First-render data for each page; row mapping
  dashboard.ts             Milestone 3: personal and household dashboards, dashboard preferences
  health.ts reviews.ts     Project metrics and health; project reviews and next actions
  goals.ts                 Goals: membership, links, progress, milestones, history
  routines.ts turns.ts     Household routines on repeating tasks; taking turns
  planning.ts reports.ts   Workload and project timelines; reports and their CSV
src/portal/tasks/          Pages, task row and list, task panel, Quick Add (also portal-wide), pickers, dialogs,
                           reschedule dialog, calendar, templates, Todoist import, zip reader
migrations/0015_tasks.sql  Schema (Milestone 1)
migrations/0016_tasks_planning.sql  Schema additions (Milestone 2)
migrations/0017_tasks_productivity.sql  Schema additions (Milestone 3)
src/portal/knowledge/related-tasks.tsx  "Tasks" on a Knowledge object page
```

The application is registered in `src/shared/portal/applications.ts` (`tasks`, permission `tasks.use`). Pages render in the browser from data the Worker embeds, like the rest of the portal. It uses Untitled UI PRO throughout: the task panel and filter builder follow the PRO slideout layouts (`create-event-menu`, `filters-menu`), the label picker follows `labels-menu`, project dialogs follow `new-project-modal` and `user-invite-modal`, history and comments use the PRO `activity-feed`, and lists use the PRO dropdowns, badges, tabs, selects, calendar, metrics and progress bars.

The existing wedding planner's tasks (`/portal/wedding/tasks`, table `tasks`) are a separate feature and are unchanged.

## Navigation and views

| View                           | What                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Inbox**                      | Your own Inbox project: where tasks land when no project is chosen. Nested subtasks, reordering, bulk changes.                                                                                                                                                                                                                                                                                           |
| **Today**                      | Grouped: overdue (by date or deadline), due today, deadline today, and optionally undated tasks at or above a chosen priority (Settings). Shows what you've done today against what's left, and moves every overdue task to today in one go.                                                                                                                                                             |
| **Upcoming**                   | Three layouts, remembered per person: **Agenda** (the next 14 days, as in Milestone 1), **Week** (Monday–Sunday, seven columns on desktop, stacked days on phones) and **Month** (a calendar with the selected day's agenda below). Overdue first, earlier/later/today/jump-to-date, counts per day, deadlines on their own day, completed occurrences struck through, later repeats projected in place. |
| **All my tasks**               | Every open task you're responsible for (personal, and shared ones assigned to you or to nobody), paged 100 at a time, with your own sort, grouping, priority, project, section and assignee choices; can be saved as a filter.                                                                                                                                                                           |
| **Templates**                  | Reusable tasks with checklists (below).                                                                                                                                                                                                                                                                                                                                                                  |
| **Overdue**                    | Everything past its due date or deadline.                                                                                                                                                                                                                                                                                                                                                                |
| **Completed**                  | Every completion and skip, newest first, grouped by day; reopen or undo the latest.                                                                                                                                                                                                                                                                                                                      |
| **My / Shared projects**       | Project cards with progress, your own sidebar order, and completed/archived projects kept separately.                                                                                                                                                                                                                                                                                                    |
| **Project**                    | List (sections, nested subtasks), Board (sections as columns; drag a card or use its menu), Overview (health and reviews, counts, progress, coming up, deadlines, milestones, goals, members, project and task Knowledge, recent history), Timeline (M3).                                                                                                                                                |
| **Labels**                     | Your labels with open counts; rename, recolour, delete; labels others use on shared tasks.                                                                                                                                                                                                                                                                                                               |
| **Filters**                    | A filter builder (projects, labels any/all, priorities, due, deadline, assignee, status, personal/shared, words, sort) and saved filters.                                                                                                                                                                                                                                                                |
| **Dashboard** (M3)             | Personal and Household tabs: what needs attention and how projects, goals and routines are going (below).                                                                                                                                                                                                                                                                                                |
| **Goals**, **Routines** (M3)   | Goals with progress, milestones and history; household routines with turns (below).                                                                                                                                                                                                                                                                                                                      |
| **Workload**, **Reports** (M3) | One to four weeks of dated work grouped by day, week, project, priority or person, with warnings; completions over time and where things stand, with CSV (below).                                                                                                                                                                                                                                        |
| **Search, Activity, Settings** | Search across titles, descriptions, labels and project names; history across your projects; time zone, Today options and export.                                                                                                                                                                                                                                                                         |

Active projects also appear in the sidebar. "My tasks" views (Today, Upcoming, Overdue) show open tasks in **active** projects you can edit that are **assigned to you or to nobody**; a task assigned to someone else stays in its project. Projects on hold, completed or archived don't feed those views.

### Quick Add

Press **q** (or **Add task**) on any portal page: in Tasks, the sidebar's **Add task** on every other page, and the floating **+** button on phones. Outside Tasks, Quick Add loads the caller's projects and labels the first time it opens (`GET /shell`); on a Knowledge page it offers to link the new task to that page (checked against Knowledge access by the Worker before anything is saved), and you stay on the page you were on. People without `tasks.use` never see the button or the shortcut, and the API refuses them. Type naturally and check the chips under the field before pressing Enter: each says what was understood and can be dismissed, which puts the words back in the title. The pickers set the same things explicitly and always win. If saving fails, the text stays.

| Write                                                                                                                                                                                                                                                           | Read as                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `today`, `tomorrow`, `friday`, `this friday`, `next week`, `next month`, `in 3 days`, `23/11`, `23 nov`, `nov 23 2027`, `2027-01-04`                                                                                                                            | Due date. Numeric dates are day/month (Australian). A date without a year that has passed means next year. |
| `next friday`                                                                                                                                                                                                                                                   | Friday of next week, flagged as ambiguous; the chip shows the exact date.                                  |
| `at 5pm`, `9:30am`, `17:45`, `noon`                                                                                                                                                                                                                             | Due time (today if no date).                                                                               |
| `p1` … `p4`                                                                                                                                                                                                                                                     | Priority.                                                                                                  |
| `@errands`                                                                                                                                                                                                                                                      | Label (several allowed).                                                                                   |
| `#household`                                                                                                                                                                                                                                                    | Project, matched by name with spaces ignored; unknown names stay in the title.                             |
| `every day`, `every weekday`, `every wednesday`, `every mon, wed and fri`, `every 3 days`, `every 2 weeks`, `fortnightly`, `every other monday`, `every month`, `every 15th`, `every last day`, `every 2nd tuesday`, `every last friday of the month`, `yearly` | Repeat, starting on its first occurrence from today (or from the date chosen with the picker).             |
| `in a week`, `in a fortnight`, `in 2 fortnights`, `in a year`                                                                                                                                                                                                   | Due date.                                                                                                  |
| `{31 oct}`                                                                                                                                                                                                                                                      | Deadline.                                                                                                  |

There is no language model involved. Anything outside this grammar stays in the title, and words that look like a date, repeat or project but weren't understood ("end of month", "every 2nd tuesday of the quarter", an unknown `#project`) are pointed out under the field so they're never dropped silently. Choosing a date with the picker replaces only a typed date: a typed repeat then starts from the chosen date, and a time can be set too. Each draft carries a random request id, so a retry after a lost response (or a double press) returns the task already created instead of a copy.

### Keyboard

`q` add (any portal page) · `/` search · `g` then `i`/`t`/`u`/`p`/`o`/`m`/`w` go to Inbox/Today/Upcoming/projects/Overdue/all my tasks/this week · `j`/`k` or ↓/↑ move between tasks · Enter open · `e` complete or reopen · `s` reschedule · `1`–`4` priority · Alt+↑/↓ reorder · arrow keys move between days in the month view · Esc close · `?` list them. Shortcuts never fire while typing in a field or in the Knowledge editor. Knowledge keeps `c` (capture) and ⌘K/Ctrl+K; Tasks uses `q`, so they don't clash.

### Phones

Every Tasks page is tested on Pixel 7 emulation for horizontal overflow and serious axe issues. Controls never depend on hover: each task's menu button is always visible, touch targets are at least 36–44 px, and the board scrolls sideways inside its own area.

## Data model

| Table                             | Holds                                                                                                                                                                                                          |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `task_preferences`                | Each person's time zone and Today option                                                                                                                                                                       |
| `task_projects`                   | Name, description, colour, `personal`/`shared`, Inbox flag and owner, status (active, on hold, completed, archived), start and target dates, default view, version                                             |
| `task_project_members`            | Who can reach a project, their role and their own sidebar position                                                                                                                                             |
| `task_sections`                   | Ordered sections of a project                                                                                                                                                                                  |
| `task_items`                      | Tasks and subtasks (`parent_id`, `depth` 0–3), title, description, status, priority 1–4, due date and optional time, deadline, repeat rule, milestone flag, assignee, fractional position, completion, version |
| `task_labels`, `task_item_labels` | Each person's label list; label names on tasks                                                                                                                                                                 |
| `task_completions`                | Every completion or skip, with the occurrence and next date, and undo marks                                                                                                                                    |
| `task_comments`                   | Plain-text comments                                                                                                                                                                                            |
| `task_activity`                   | Project history without text                                                                                                                                                                                   |
| `task_knowledge_links`            | Task → Knowledge object references (ids only)                                                                                                                                                                  |
| `task_saved_views`                | Saved filter definitions, private to their owner                                                                                                                                                               |
| `task_reminders`                  | Each person's reminders: absolute instants or relative to the due date                                                                                                                                         |

Ids are prefixed random strings (`tpj_`, `tsc_`, `tsk_`, `tlb_`, `tcm_`, `tkl_`, `tfv_`, `trm_`) and never change.

What the database itself enforces (so a Worker bug can't break it):

- `(project_id, section_id)`, `(project_id, parent_id)` and `(project_id, assignee_email)` are composite foreign keys: a task's section, parent and assignee must belong to the task's own project, and the assignee must be a member.
- A section that still has tasks can't be deleted (no cascade on `section_id`).
- Triggers keep a personal project to exactly one member, refuse turning a shared project with several members personal, and keep an Inbox personal.
- One Inbox per person (partial unique index); depth between 0 and 3, consistent with `parent_id`; status and `completed_at` agree; a repeating task has a date; a due time needs a date.
- Deleting a task removes its subtasks, labels, comments, completions, reminders and Knowledge references. Knowledge permanently deleting an object removes references to it.

Indexes cover Inbox and project lists (`project_id, status, section_id, position`), date views (`project_id, status, due_date` and `deadline`), assignees, completed lists, labels by name, history by project and task, and reminders by `(owner_email, remind_at)`.

## Who can see what

1. **Cloudflare Access** and the portal's JWT check, unchanged.
2. **Portal role → `tasks.use`**: owners and admins can open Tasks. Wedding editors and viewers can't.
3. **Project membership** decides everything inside, checked on the Worker for every request:
    - Every project, task, section, comment, reminder, saved filter and result is reached joined to the caller's own membership row. A project or task you're not in is a **404**, never a 403, whether it exists or not.
    - Being a portal owner grants nothing: each person's Inbox and personal projects are theirs alone.
    - Shared projects have **Owner** (everything, including members, sharing, archiving and deletion), **Editor** (tasks, sections, details, comments) and **Viewer** (read; can set their own reminders; can't be assigned).
    - Assignees must be editors or owners of the task's project. Personal projects have no assignees.
    - Removing someone takes effect on their next request; their assignments in that project are cleared and their reminders on its tasks deleted in the same batch. Demoting to viewer clears their assignments.
    - Bulk changes check every task; if any isn't editable by the caller, nothing changes and the answer is 404 without saying which.
    - Knowledge space membership grants nothing in Tasks, and Tasks membership grants nothing in Knowledge (below).
4. Writes need a same-origin `Origin` and a JSON body, and cross-site reads are refused (the portal's existing CSRF rules). Ids, owners and project ids from the browser are never trusted.
5. Tasks never appear on public, blog or wedding routes, or in the portal-wide `audit_log`.

## Task lifecycle

- **Create** in the Inbox (default), a project, a section, under a parent, from any date view (with that date) or from a filtered view. Priority defaults to P4; no date or project is required.
- **Edit** with optimistic concurrency: every save carries the version it started from. If someone saved in between, nothing is written; the API returns 409 with the current task and the panel keeps your text and offers **Keep my changes** or **Discard mine**.
- **Move** a task with its subtasks to another project, section or parent, or up/down among its siblings (Alt+↑/↓ or the menu; the board also supports dragging). Moving under its own subtask, or deeper than three levels below a top-level task, is refused. Moving into another project clears assignees and reminders that wouldn't be allowed there.
- **Complete / reopen.** A one-off task is completed once (a repeat click is recognised and returns "already done"); reopening marks the completion undone, keeping the history. **Completing a task with open subtasks is never silent**: the API answers `open_subtasks` and the app asks whether to complete them too. Subtasks complete and reopen independently.
- **Duplicate** copies the task, its subtasks and labels (open, without comments, history or reminders). **Delete** asks for confirmation and removes the subtree.
- **Bulk**: complete, reschedule, shift dates by a number of days (deadlines stay; undated tasks are left alone), remove dates, priority, move, add/remove label, delete, for up to 100 tasks, in one batch.
- **Milestones** are tasks flagged as milestones; the project overview lists them with their dates.

## Repeating tasks

A repeating task is one row whose due date moves along a series; nothing is generated ahead of time. Rules (`src/shared/tasks/recurrence.ts`) are a validated subset of iCalendar RRULE: daily, weekly (chosen weekdays), monthly (a day of the month or the last day), yearly; any interval within limits; an optional end date; and a basis.

- **On a fixed schedule** (default): completing an occurrence moves the task to the first date in the series after both the completed date and today. An overdue weekly task done late goes to its next future day, not to a date already past; missed occurrences aren't recreated.
- **After completion**: the next date counts from the day it was completed (plain intervals only).
- Month ends: a rule for the 31st uses the last day of shorter months and returns to the 31st. 29 February falls on the 28th in other years.
- **Idempotent**: completion is guarded on the occurrence the person saw, in one batch with the completion row. A double click, a second tab or two people at once record one completion; the others get "already done".
- **Skip** advances without completing (recorded as skipped). **Undo** reverses the latest completion or skip, if the task hasn't moved on since.
- A deadline moves along with each occurrence by the same number of days. A repeating task's subtasks are a checklist: they reopen for the next occurrence.
- Setting or changing a rule moves the due date to the rule's first occurrence on or after it, which becomes the anchor. Clearing the date of a repeating task is refused; stop the repeat first. Rules are exported as stored and as RRULE text.
- Upcoming projects at most 14 later occurrences per task within the window, computed on the fly, never into the past.

### Milestone 2: more patterns, occurrences and the series

Rules stay one validated JSON object per task; Milestone 1 rules parse unchanged (tested). New, optional fields:

| Pattern                                                                                 | Field                                             | RRULE                              |
| --------------------------------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------- |
| The 1st–4th or last weekday of the month ("2nd Tuesday", "last Friday"); every N months | `monthWeekday: { week: 1–4 or -1, weekday: 1–7 }` | `BYDAY=2TU`                        |
| The last Monday–Friday of the month                                                     | `lastWorkday: true`                               | `BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1` |
| End after N occurrences (counting the first)                                            | `count` (1–1,000)                                 | `COUNT=N`                          |

A "5th Tuesday" isn't offered: most months don't have one, and RFC 5545's answer (skip those months) surprises people. Every N years and every N months were already supported. Count limits and weekday-of-month rules are for repeats on a fixed schedule only.

**One occurrence or the series.** The task row always holds the _current_ occurrence; nothing is stored for later ones except exceptions:

- **Reschedule this occurrence only** (the default when a repeating task's date changes, from the panel, a row, the calendar, dragging or bulk changes): the due date moves, the rule keeps its anchor. Completing it carries on along the original series from the later of its original date and its new one, so nothing is repeated.
- **This and later occurrences** (`PATCH /tasks/:id` with `scope: "series"`): the rule moves to the new date. Weekdays shift by the same number of days (Mon/Thu moved to a Tuesday becomes Tue/Fri), a day of the month becomes the new date's day (a "last day" stays last), a weekday of the month becomes the new date's ("2nd Tuesday" moved to the 19th becomes "3rd Thursday"), a limited series keeps the occurrences it has left. Recorded in the history as a series change.
- **Skip or move a later occurrence** (from Upcoming or the calendar: `POST /tasks/:id/occurrences` with `skip`, `move` or `restore`): stored in `task_recurrence_exceptions`, keyed on the series date. Skipped dates are passed over and moved ones land on their new date, both when the task moves along the series and in projections. Only for occurrences after the current one; editors only; Undo restores it. Changing the rule removes its exceptions.
- **Skip the current occurrence** and **end the series** (set it to "Doesn't repeat", or give it an end date or count) work as in Milestone 1.
- **Reopening** undoes the latest completion as before; exceptions are untouched.
- **Missed occurrences** aren't recreated; an overdue repeating task stays one task until it's done or skipped, and completing it moves to the first series date after both its date and today.
- An occurrence's title, description, priority and checklist are shared by the whole series (one row); changing one occurrence's description alone isn't possible.

Completion stays guarded on the occurrence the person saw, in one batch with the completion record, so double clicks, retries and two people at once still record one completion (tested with exceptions too).

## Dates and time zones

Due dates and deadlines are calendar dates (`YYYY-MM-DD`) and due times wall-clock times (`HH:MM`), stored as text, never timestamps, so a task due on the 24th is due on the 24th whatever the time zone or daylight saving. "Today" is worked out in each person's own IANA time zone (default `Australia/Sydney`, changeable in Settings). Only reminders are instants: they're computed with Intl from a date, time and zone, and tested across Sydney's daylight-saving changes (a time in the skipped hour comes out an hour later).

## Labels, filters and search

- Each person has their own label list (names, colours, order). Tasks carry label **names**, so a label on a shared task is seen by everyone in that project and filters work across personal and shared work. Labels typed in Quick Add join your list. Renaming or deleting a label changes only tasks you can edit.
- Filters are a fixed set of fields (`src/shared/tasks/filters.ts`), validated in the browser and again on the Worker, and compiled to parameterised SQL that always starts from the caller's memberships. No SQL, column names or expressions are ever accepted. Saved filters are private and re-validated when read.
- Search is `LIKE` over titles, descriptions, labels and project names with escaped, bound patterns; every word must match, results are capped at 50. For two people's tasks this is fast without a full-text index, and it adds no virtual table for the backup tooling to rebuild.

## Comments and history

- Comments are plain text (5,000 characters), shown as text, never HTML. Editors and owners add them; authors edit their own; authors and project owners delete. No mentions or notifications.
- `task_activity` records meaningful actions (create, complete, skip, reopen, reschedule, priority, assignee, moves, project and member changes) with the task id and, for changes, which fields changed. Values are kept only for dates, priority, status, assignee and similar fields: never titles, descriptions, comments, labels or Knowledge ids. Repeated text edits by one person within ten minutes add one entry. History is readable by the project's current members; a task's title is shown only while the reader can still see the task (it may have moved to a project they're not in).

## Reminders

Each person can add reminders to tasks they can see: at a date and time, or relative to the due time (a date-only task counts as due at 9 am in the owner's zone). Relative reminders follow the task when its date changes or it repeats. Each person can also choose a default reminder for new dated tasks (Settings). Due reminders appear at the top of any Tasks page, and ones due within the hour appear when their time comes while a page stays open. Reminders are found with an indexed `(owner_email, remind_at)` range query; nothing scans the table.

### Background email reminders (Milestone 2)

Reminders can also be emailed, so they arrive when Tasks isn't open. It needs all three:

1. an email provider configured on the Worker (`EMAIL_DELIVERY` and its secrets: the same Fastmail/SMTP/SMTP2Go/Cloudflare providers the portal already uses, `worker/comms/providers.ts`);
2. the portal feature switch **Task reminder emails** (`tasks.reminders.email`, Portal settings → Features), **off by default**;
3. the person's own **Email my reminders to me** (Tasks → Settings), also off by default.

**How it runs.** The existing cron trigger (every 15 minutes, `wrangler.jsonc`) calls `processTaskReminders` (`worker/tasks/notify.ts`), alongside the Capacities sync and the scheduled message queue. Nothing new is scheduled per task. Each run takes at most 20 reminders whose `next_attempt_at` has passed (partial index on pending reminders), oldest first. For each it:

- claims it with a conditional `UPDATE` (a token and time), so overlapping runs can't both send it; a claim older than 10 minutes belongs to a run that died and can be taken over;
- checks everything again as it is now: the recipient is still a member of the task's project and can open Tasks, the task is open, the reminder isn't dismissed, and their reminder and email preferences are on. Otherwise the email is cancelled (the in-app reminder is unaffected);
- skips (marks `expired`) a reminder more than six hours late, e.g. because delivery was off or the provider was down for a long time, rather than sending something stale;
- waits out quiet hours: inside them, `next_attempt_at` becomes the end of the quiet hours (local wall-clock time in the person's zone, across midnight and daylight saving) and it's sent then. Nothing is dropped;
- sends one email to the reminder's owner: the task's title, due date and time, priority, project name, and a link to `/portal/tasks/t/:id`, which still needs the portal sign-in. Never its description, comments, labels, assignee or linked Knowledge (tested);
- on failure, retries after 5 min, 15 min, 1 h and 4 h (`attempts`, `last_attempt_at`, `last_error`), then marks it `failed`. A rejection the provider says isn't worth retrying fails at once.

Moving a task, its date changing as it repeats, or recalculating a relative reminder puts the email back to `pending` for its new time. Dismissing a reminder in the app, completing the task, leaving the project or turning email reminders off cancels it; turning them back on queues the ones still to come.

**Delivery is at least once, not exactly once.** The claim prevents two runs sending the same reminder, but if the provider accepts a message and the Worker fails before recording it, the next run sends it again. Providers can't tell us whether an earlier attempt got through, so a rare duplicate is preferred to a lost reminder. Emails arrive within about 15 minutes of the reminder time (the cron interval). Delivery failures never affect anything else: completing tasks, the other cron jobs and in-app reminders carry on.

**Not built: browser push.** Web Push needs VAPID keys (new Worker secrets), payload encryption, subscription storage and a service worker, and on iPhone and iPad it works only for a site added to the Home Screen (iOS 16.4+); the portal isn't an installable web app yet. It's deferred rather than half-built; email is the external channel for now.

**Tested with a mock provider only.** No real email has been sent; the tests never send any (the test environment has `EMAIL_DELIVERY=off`, and the processor is given a mock). The switch must stay off until the owner approves.

## Knowledge integration

A task can reference Knowledge objects (up to 20). Two permission systems apply and neither implies the other:

- **Adding** needs edit access to the task, `knowledge.use`, and read access to the object through Knowledge's own `requireObject` (404 for anything outside the caller's spaces). Trashed objects can't be linked.
- **Reading**: every time, each reference is checked against the reader's current Knowledge membership. If they can't read it (not a member, no `knowledge.use`, or the object is trashed) they see only "A Knowledge item you don't have access to": no title, space or id. The export lists only object ids the exporter can read.
- **Removing** needs edit access to the task, even without access to the object.
- The history records that a reference was added or removed, never which.
- Knowledge isn't changed. `task_knowledge_links` holds ids, with a foreign key that removes the reference when Knowledge permanently deletes the object.
- **Reverse direction**: `GET /api/portal/tasks/knowledge/:objectId` returns linked tasks and projects the caller can see in Tasks (with their projects' names), only if they can read the object in Knowledge. Since Milestone 3 the Knowledge object page shows them (below).
- **Create a task from a Knowledge page** (Milestone 2): portal-wide Quick Add on a Knowledge object page offers "Link to “…”". `POST /tasks` with `knowledge: [objectId]` checks, before writing anything, that the caller can add tasks to the destination project, has `knowledge.use`, and can read the object through Knowledge's own `requireObject` (404 otherwise, so nothing can be probed); the task and the reference are written in one batch. No note content is copied, and reminder emails never mention linked Knowledge.

## API

All under `/api/portal/tasks`, all requiring Access, `tasks.use` and membership. Writes need a same-origin JSON request. Errors are the portal's usual `{ error, message, issues? }`; conflicts return 409 with `current`, and completing a task with open subtasks returns 409 `open_subtasks` with `count`.

| Method and path                                                                                                                 | What                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /lists/:view`                                                                                                              | `inbox`, `today`, `overdue`, `upcoming?from=&days=`, `completed?before=`                                                                                |
| `GET /filter?…`, `GET /search?q=`                                                                                               | Ad-hoc filter (same fields as saved filters, paginated); search                                                                                         |
| `POST /tasks`, `GET/PATCH/DELETE /tasks/:id`                                                                                    | Create (optional `clientId` for safe retries, `knowledge` ids to link); detail; update with `version` (and `scope` for a repeating task's date); delete |
| `POST /tasks/:id/complete`, `…/skip`, `…/reopen`                                                                                | `{ occurrence, includeSubtasks }`                                                                                                                       |
| `POST /tasks/:id/move`, `…/duplicate`, `POST /tasks/bulk`                                                                       | Move (`projectId`, `sectionId`, `parentId`, `afterId`/`beforeId`); duplicate; bulk actions                                                              |
| `GET/POST /tasks/:id/comments`, `PATCH/DELETE /comments/:id`                                                                    | Comments                                                                                                                                                |
| `POST /tasks/:id/knowledge`, `DELETE /tasks/:id/knowledge/:link`, `GET /knowledge/:object`                                      | Knowledge references and reverse lookup                                                                                                                 |
| `POST /tasks/:id/reminders`, `DELETE /reminders/:id`, `POST /reminders/:id/dismiss`, `GET /reminders/due`                       | Reminders                                                                                                                                               |
| `GET/POST /projects`, `GET/PATCH /projects/:id`, `GET /projects/:id/completed`                                                  | Projects (with counts); update with `version`                                                                                                           |
| `POST /projects/:id/kind`, `…/delete` (`{ "confirm": "DELETE" }`), `…/position`                                                 | Share/unshare; delete (owner, never the Inbox); your sidebar order                                                                                      |
| `GET/POST /projects/:id/members`, `PATCH/DELETE /projects/:id/members/:email`                                                   | Members (owners change; anyone may leave)                                                                                                               |
| `POST /projects/:id/sections`, `PATCH /sections/:id`, `POST /sections/:id/position`, `POST /sections/:id/delete` (`{ moveTo }`) | Sections                                                                                                                                                |
| `GET/POST /labels`, `PATCH/DELETE /labels/:id`                                                                                  | Labels                                                                                                                                                  |
| `GET/POST /filters`, `GET/PATCH/DELETE /filters/:id`, `POST /filters/validate`                                                  | Saved filters                                                                                                                                           |
| `GET /activity?project=&before=`, `GET/PATCH /preferences`                                                                      | History; time zone, Today option, reminders, quiet hours, first page                                                                                    |
| `GET /preferences/views`, `PUT /preferences/views/:view`                                                                        | Each person's list choices (`mine`, `today`, `upcoming`, `overdue`, `inbox`)                                                                            |
| `GET /shell`                                                                                                                    | Projects, sections, labels and people for Quick Add outside Tasks                                                                                       |
| `GET /lists/upcoming?mode=agenda                                                                                                | week                                                                                                                                                    | month&from=`                                                          | Upcoming windows, with `deadlines` and `done` for week and month |
| `POST /tasks/:id/occurrences`                                                                                                   | Skip, move or restore a later occurrence (`{ action, date, to? }`)                                                                                      |
| `GET/POST /templates`, `GET/PATCH/DELETE /templates/:id`, `POST /templates/:id/duplicate`, `…/use`, `POST /tasks/:id/template`  | Templates                                                                                                                                               |
| `GET /import`, `POST /import/todoist/preview`, `POST /import/todoist/run`                                                       | Todoist import (below)                                                                                                                                  |
| `GET /export?format=json                                                                                                        | csv&scope=all                                                                                                                                           | personal`                                                             | Export                                                           |
| `GET /dashboard?tab=personal                                                                                                    | household&filter=`, `PUT /preferences/dashboard`                                                                                                        | Dashboards (M3); each person's tab, hidden cards and household filter |
| `GET/PATCH /projects/:id/health`, `GET /projects/:id/timeline`                                                                  | Project metrics and health, manual status (`{ version, status, note }`); timeline (M3)                                                                  |
| `GET/POST /projects/:id/knowledge`, `DELETE /projects/:id/knowledge/:link`                                                      | Project Knowledge references (M3)                                                                                                                       |
| `POST /projects/:id/reviews` (start or join the draft), `GET /projects/:id/reviews?before=`                                     | Reviews (M3)                                                                                                                                            |
| `GET/PATCH /reviews/:id`, `POST /reviews/:id/complete`, `…/discard`, `…/actions`                                                | A review: workspace, note and health (`version`), complete, discard a draft, add a next action (a new task in the project)                              |
| `GET/POST /goals`, `GET/PATCH /goals/:id`, `POST /goals/:id/progress`, `…/archive`, `…/delete`, `…/kind`                        | Goals (M3); edits and progress carry `version`                                                                                                          |
| `GET/POST /goals/:id/members`, `PATCH/DELETE /goals/:id/members/:email`, `POST /goals/:id/links`, `DELETE /goals/:id/links/:id` | Goal members and links (`{ projectId }`, `{ taskId }` or `{ objectId }`)                                                                                |
| `POST /goals/:id/milestones`, `PATCH/DELETE /goal-milestones/:id`                                                               | Milestones                                                                                                                                              |
| `GET/POST /routines`, `GET/PATCH/DELETE /routines/:id`, `POST /routines/:id/pause`, `GET /routines/:id/history?before=`         | Routines (M3): create (or `{ taskId }` to convert), turns, pause/resume (`version`), stop, history                                                      |
| `GET /workload?scope=&weeks=&from=`, `GET /reports?scope=&range=`, `GET /reports/export`                                        | Workload, reports and their CSV (M3)                                                                                                                    |

Pages: `/portal/tasks` (the person's chosen first page, Today by default), `/portal/tasks/{inbox,today,upcoming,overdue,mine,completed,projects,labels,filters,templates,search,activity,settings,dashboard,goals,routines,workload,reports}`, `/portal/tasks/goals/:id`, `/portal/tasks/p/:id?view=list|board|overview|timeline`, `/portal/tasks/t/:id` (a task, opened in its project).

## Templates

A template is a task with a checklist that comes round again: a name, the task's title and description, priority, labels, an optional destination project, an optional due date relative to the day it's used ("the same day", "a week later") with a time and a repeat, and a checklist of up to 100 items nested at most three levels (edited as text: one item per line, two spaces per level). **Use** creates an ordinary, independent task and subtasks in one batch; editing or deleting the template later doesn't touch tasks made from it. Templates can be duplicated, archived, restored and deleted; any task can be **Saved as template** from its panel (its subtasks become the checklist).

Who sees one: a template is private to its owner, whatever their portal role, unless it's shared with a **shared project**, in which case that project's members can see and use it and its editors can change it. Leaving or being removed from the project removes it from view at once. Using a template checks the destination like any new task (an editor of a project that isn't archived); a template's default project that the user can no longer add to falls back to their Inbox. Everything else is a 404.

## Importing from Todoist

Tasks → Settings → **Import from Todoist**. No Todoist account is connected and no credentials are asked for; nothing in Todoist is changed.

**What it reads.** Todoist's own CSV export: "Export as CSV" on a project, or the CSV files inside a backup zip from Todoist's settings (the zip is unpacked in the browser with the platform's `DecompressionStream`; only `.csv` entries are read). One file is one project. The columns are the ones Todoist documents for its CSV format (help article "Format a CSV file to import into Todoist"): `TYPE` (task, section, note, meta), `CONTENT`, `DESCRIPTION`, `PRIORITY`, `INDENT`, `AUTHOR`, `RESPONSIBLE`, `DATE`, `DATE_LANG`, `TIMEZONE`, `DURATION`, `DURATION_UNIT`, `DEADLINE`, `DEADLINE_LANG`, `IS_COLLAPSED`, `meta`.

| Imported                         | How                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project                          | A new **personal** project named after the file (a backup's `Name [1234].csv` gives "Name", and the bracketed id makes re-imports match), or an existing project you can edit, chosen per project in the preview. Never shared automatically; a project of yours with the same name is pointed out. Board layout (`view_style=board`) is kept. |
| Sections                         | Matched by an earlier import, then by name, else created.                                                                                                                                                                                                                                                                                      |
| Tasks and subtasks               | `INDENT` 1–4 becomes nesting (at most three levels below a task, as everywhere in Tasks); order is kept.                                                                                                                                                                                                                                       |
| Description, labels              | `DESCRIPTION`; `@label` words in `CONTENT` become labels.                                                                                                                                                                                                                                                                                      |
| Priority                         | You choose which way round the numbers go: Todoist's help says 1 is p1, but files made from its API use 4 for p1. The preview shows the numbers found in the file. A blank priority is P4 (Todoist would read it as p1; P4 is the safer default here).                                                                                         |
| Dates, times, repeats, deadlines | `DATE` and `DEADLINE`, read with Quick Add's grammar (ISO dates too). A repeating date starts from its next occurrence after the import, because Todoist's export drops the start date. Dates in other languages, or phrases outside the grammar, are reported and the task is imported without a date.                                        |
| Comments                         | `note` rows become comments on the task above, written by you.                                                                                                                                                                                                                                                                                 |

**Not in the export, so not imported** (the preview says so): completed tasks, creation and completion times, Todoist's ids, assignees and authors (they're names, not Daly Portal people), durations, reminders, attachments, and the start of repeating tasks. Columns with data that isn't used are listed per project. **This has been tested with invented files in the documented format, not with a real export from Todoist's servers**; a real export may have quirks these files don't. Please try a real one before relying on it (the preview writes nothing).

**Preview, then import.** The preview (nothing written) shows each project's destination, counts and a sample of its tasks, each marked new, already imported, will be updated, changed in both, deleted here since, or already here (a possible duplicate); every warning; and what the format can't carry. You choose:

- **Possible duplicates** (a task not imported before with the same title as an open task in the same place in the destination): link to the existing task (default; recorded, so later imports find it) or import anyway.
- **Changed in Todoist since the last import**: keep what's here (default) or update from Todoist, which only ever updates tasks not edited in Daly Tasks since they were imported (the stored version is compared). Tasks changed in both are never overwritten; they're reported as conflicts.

**Importing again never duplicates.** Every imported project, section, task and comment is recorded in `task_import_items` with a key derived from its place in the export (Todoist's CSV has no ids): the project (by backup id, else name), the section and which of that name it is, the titles of its parent tasks, its own title and which of that title it is among its siblings. So renaming or moving a task in Todoist makes it a new task on the next import; changing its description, date or priority is a change to the same task. A task deleted in Daly Tasks after it was imported stays deleted. Each run is recorded in `task_import_batches` with the files' fingerprint.

**Bounded and resumable.** A run writes at most 250 tasks, each task with its labels, comments and record in the same atomic D1 batch, and the browser calls again until it's done (showing progress). If one stops part-way (a network drop, a closed tab), everything before is saved and recorded; importing the same files again carries on from there without duplicating anything (tested by interrupting a 600-task import).

**Limits and safety.** CSV or zip only; each CSV at most 2 MB, 30 projects and 5,000 tasks per import, 8 MB per request; the CSV is parsed by the Worker (never trusted from the browser), with control characters removed and every value stored as plain text and shown escaped (formula-like text is kept as text: it's never evaluated here, and the CSV export neutralises it). Projects you can't edit can't be chosen (404); imports are per person and invisible to anyone else. Errors are plain sentences without file contents; logs record batch ids and counts only.

## Milestone 2 schema

`0016_tasks_planning.sql` is additive: one new column set on `task_preferences` (reminders on/off, email reminders, default reminder, quiet hours, first page), one on `task_reminders` (delivery status, attempts, next and last attempt, delivered time, last error, claim), `task_items.client_id` with a unique index on `(created_by, client_id)`, an index on completions by person and time (Today's progress), and new tables `task_view_preferences`, `task_recurrence_exceptions`, `task_templates`, `task_import_batches` and `task_import_items`. Its single `UPDATE` marks reminders still in the future as pending email delivery (nothing is sent until the switch and the person's choice are on). The Milestone 1 Worker ignores all of it, so rolling the Worker back is safe without touching the database. D1 has no down migrations; reverting the schema would mean restoring a backup, and isn't needed for a Worker rollback.

`npm run test:backup` fills every new table, runs the real FTS-aware backup script, restores twice and checks row counts for every table, that delivery state, request ids, exceptions, templates and import records survive, and that the restored copy still refuses a duplicate request id. `npm run db:verify` gains checks for shared templates, stale exceptions and reminder emails stuck mid-delivery.

## Milestone 3: integrated productivity

Milestone 3 connects what's already there rather than adding a second system: dashboards and reports are queries over the same tasks, routines are repeating tasks, reviews and goals point at existing projects and tasks, and Knowledge links reuse the one reference mechanism. Nothing uses AI, and every status comes with the rule that produced it. The shared rules and their thresholds live in `src/shared/tasks/productivity.ts` (named constants, tested); this section states them in words.

### Architecture

```
Dashboard ─┐                       ┌─ task_items, task_completions (unchanged engine)
Workload  ─┼─ bounded SQL joined ──┼─ task_project_members (who can see what)
Reports   ─┘  to membership        ├─ task_project_reviews, task_review_actions
Project overview/timeline ─────────┼─ task_projects (+ review frequency, health override)
Goals ─── task_goal_members ───────┼─ task_goals, _links, _milestones, _progress
Routines ── one repeating task ────┼─ task_routines, task_routine_participants
Knowledge page ── GET /knowledge/:id ┴─ task_knowledge_links, task_project_knowledge_links
```

Each module checks access the way the rest of Tasks does: reached through the caller's own membership row, 404 for anything else. Goals are the one new access model, and they copy projects' exactly (below).

### Dashboard (`/portal/tasks/dashboard`)

**Personal** (`GET /dashboard?tab=personal`). "My" means what Today means: open tasks in active projects you can edit, assigned to you or to nobody, excluding paused routines.

| Card                    | Exactly                                                                                                                 |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Due today               | Due date is today.                                                                                                      |
| Overdue                 | Due date or deadline before today.                                                                                      |
| Next 7 days             | Due tomorrow to seven days from today.                                                                                  |
| High priority           | P1 or P2, any date or none.                                                                                             |
| Waiting in your Inbox   | Undated, deadline-free top-level tasks still in your Inbox ("captured but not sorted").                                 |
| Completed this week     | Your own completions (not skips, not undone) since the start of the day six days ago, in your time zone.                |
| Personal projects       | Active personal projects with progress and health, most pressing first (at risk, needs attention, then soonest target). |
| Goals                   | Your active personal goals, and active shared goals that need attention.                                                |
| Upcoming milestones     | Open milestones (yours, as above) dated in the next 30 days.                                                            |
| Your routines this week | Unpaused routines due within seven days, assigned to you or nobody.                                                     |
| Reviews due             | Active projects whose review is due (below).                                                                            |

Today and overdue tasks are the ordinary task rows: complete (with Undo), reschedule, change priority and open, without leaving the page. After any change the dashboard is read again, so its counts never drift from the lists.

**Household** (`GET /dashboard?tab=household&filter=all|mine|others|unassigned`). Only **shared projects you are a member of** are counted, in any role. Nobody's personal projects, Inbox or personal goals ever appear or are counted, whatever their portal role; removing someone from a project takes it off their household dashboard on their next request (tested). Cards: needs attention (open, due or deadline today or earlier), coming up (next 14 days), who's doing what (open and overdue counts per assignee and "not assigned", presented as a spread of work, not a score), shared commitments (open tasks with a deadline), household routines, shared projects with health, active shared goals you're a member of, and shared work done this week with who did it. The filter narrows the task cards by assignee.

Each person's tab, hidden cards and household filter are stored in `task_dashboard_preferences` (validated, private).

### Tasks ↔ Knowledge

- **Knowledge object pages show a "Tasks" section** (`src/portal/knowledge/related-tasks.tsx`), for people with `tasks.use`, from `GET /knowledge/:objectId`: linked tasks (title, status, priority, due date, project and assignee) and linked projects (with progress), each a link into Tasks. The Worker answers 404 unless the reader can read the object in Knowledge right now, and then lists only tasks and projects they're a member of in Tasks: someone else's private tasks linked to a shared note are never listed or counted (tested). Trashed objects list nothing.
- **Add linked task** on that section opens the portal-wide Quick Add with the object pre-linked (the M2 mechanism, checked again by the Worker). When it's saved, Quick Add announces the new task (`daly:tasks-created`, id only) and the section reloads, without a page load. No note content is copied.
- **Projects can reference Knowledge objects** (`task_project_knowledge_links`, project overview → "Project Knowledge"), with the same rules as tasks: adding needs edit access to the project and read access to the object; every read re-checks the reader's Knowledge membership, and anything they can't read is "A Knowledge item you don't have access to" (no title, space or id); any project editor can remove one. The overview also still lists Knowledge linked from the project's tasks. There is no second project record: a project only holds the object ids.
- Goals can link Knowledge objects too; there an unreadable object is left out entirely (below).

### Project health

`GET /projects/:id/health` (and the overview). Numbers, all over the project's tasks and subtasks as the member sees them: open, completed, overdue (open past due date or deadline), due in the next seven days, open top-level tasks with nobody assigned (shared projects only), open top-level tasks with no date or deadline, open milestones in the next 30 days, completed in the last 14 days, the latest history entry, the start and target dates, and the review schedule.

The calculated status, with its reasons listed wherever it's shown:

- **At risk** if any of: the target date has passed with tasks open; the target is within 14 days and less than half the tasks are done; five or more tasks are overdue; or at least two are overdue and they're more than a third of the open tasks.
- otherwise **Needs attention** if any of: a task is overdue; the target is within 30 days and less than three quarters are done; a review is due; there's been no activity for more than 30 days with tasks open; or **there are no open tasks** (a project is never "on track" just because nothing is late: it needs next steps or to be marked completed).
- otherwise **On track**, with "Nothing overdue · n% of N tasks done" and the time to target as its reasons.

Only active projects are measured on the dashboard. **Manual status**: an editor can set On track / Needs attention / At risk with an optional short note (`PATCH /projects/:id/health`, with the project's version); it replaces the calculated status until cleared, and the overview shows who set it, when, and what the calculation says. The history records the status, never the note. "Blocked" isn't represented in Tasks, so it isn't a rule; on-hold projects simply aren't measured.

### Project reviews

A guided review in one dialog from the project overview ("Review project"):

1. The health and its reasons.
2. **Done since last time**: tasks completed since the previous review was completed (or ever, for a first review), with the count.
3. **Overdue**, **milestones and deadlines in the next 30 days**, and **unresolved** (open top-level tasks with no date, or in a shared project with nobody assigned).
4. A **note** (up to 5,000 characters, members only), and the **health to record** (as calculated, or one of the three).
5. **Next actions**: typed one at a time with an optional due date; each becomes an ordinary task in the project straight away and is remembered against the review (`task_review_actions`). Nothing is extracted from the note.
6. **Complete review** saves the note and health and records a **snapshot** of the numbers at that moment (counts only, never titles).

The draft is stored (`task_project_reviews`, status `draft`), with **at most one draft per project** (partial unique index): two people starting a review at once share it, closing the dialog keeps it, and "Continue review" picks it up. Edits carry a version; a stale save is refused with 409 and the dialog shows the other person's note while keeping yours in the box. Completing twice is recognised. Discarding a draft keeps any next actions already created. Viewers can read reviews but not start, edit or complete them; non-members get 404. Completed reviews are the project's review history (`GET /projects/:id/reviews`, 20 at a time), and appear on the timeline.

**Review frequency** (project settings): on demand, weekly, fortnightly or monthly. The next review is due one period after the last completed review, or after the project was created if it's never been reviewed (monthly uses the same day next month, or the month's last day). A due review makes the project "needs attention" and appears under "Reviews due" on the dashboard. Linking reviews to Knowledge objects isn't built (the review's next actions can be linked like any task).

### Goals (`/portal/tasks/goals`, `/portal/tasks/goals/:id`)

A goal has a title, an optional description ("why it matters") and target date, a status (**not started, in progress, on hold, achieved, abandoned**), personal or shared visibility, links, milestones and a history.

**Progress**, one of two modes:

- **From tasks**: the share of linked work that's done, counting each task once: every task and subtask in linked projects plus individually linked tasks. Repeating tasks count as open (they stay open by design). With nothing linked that the reader can see, progress is "No linked tasks yet" rather than 0%.
- **A number I update**: a starting value, a target and an optional unit ("$", "km", "books"); progress is how far the current value has moved from the start towards the target, so decreasing targets (weight 90 → 80) work too, capped at 0–100%. Each update records the value and an optional note. This isn't a finance engine: there are no transactions, currencies or forecasts.

An achieved goal is 100%. When everything linked is done the goal page suggests marking it achieved; it never changes status by itself (except that a first manual update moves "not started" to "in progress"). **Milestones** are checkpoints with optional dates, ticked off by members; the next undone one shows on cards. **History** (`task_goal_progress`, append-only) records creation, each value with its note, status changes, milestones reached or reopened, edits, archiving, and that a member or link was added or removed, without naming who or what. **Needs attention** (dashboard): an active goal whose target date has passed, or is within 14 days and not complete, or that hasn't started and is due within 30 days. Goals can be archived (read-only, hidden from the list) and restored, and deleted by owners with confirmation (milestones and history go with them; linked projects and tasks are never touched).

**Who can see a goal.** `task_goal_members`, like projects: owner, editor, viewer; a personal goal has exactly one member (a trigger enforces it); a non-member gets 404 for everything; being a portal owner grants nothing. A personal goal can be shared (then owners add people who can open Tasks); a shared goal can become personal again once only its owner is left. Shared goals keep at least one owner, and anyone can leave.

- **Linking a goal to a shared project shares nothing**: project members who aren't goal members can't see the goal (tested).
- **A shared goal can only link shared projects and tasks in shared projects** (checked by the Worker and by insert triggers; sharing a personal goal that links personal work is refused until those links are removed; a project made personal again, or a task moved into a personal project, leaves every shared goal in the same batch). So a personal project never feeds a shared goal.
- **Everything is worked out per reader**: progress, "what's next", linked projects and tasks count only what that member can open now, and linked Knowledge only what they can read now; anything else is **left out entirely**, so two members of a shared goal can see different task progress if they're in different projects (tested). Links to things you can't see can still be removed by an editor from the API, but aren't listed.
- Linking needs read access to the target (any role in its project; read access to the Knowledge object).

### Routines (`/portal/tasks/routines`)

A routine is an ongoing responsibility **built on one ordinary repeating task**: its schedule is the task's repeat rule (the same recurrence engine, exceptions and all), its checklist is the task's subtasks (ticked for each occurrence and reopened for the next), its history is the task's completions (who and when), and who's responsible is the task's assignee. `task_routines` holds only what a task can't: paused or not, and rotation. One routine per task (unique key), so routine state can't drift from task completion: completing, skipping, rescheduling or editing the task from any list is doing it to the routine.

- **Create** a new routine (title, notes, project, a repeat, a start date, an optional checklist of up to 30 items, and turns), written with its task and checklist in one batch with a request id (a retry returns the same routine); or turn an existing repeating top-level task into one (`POST /routines {taskId}`). Personal routines live in your Inbox by default; put one in a shared project for the household to see it. Visibility is the project's.
- The page shows each routine's schedule, next date, project, who's responsible and who's next, checklist progress, when it was last done and by whom, and its full history; **Done** and **Skip** are the task's own actions (with the checklist question and Undo).
- **Taking turns** (shared projects only, two to ten people who can be assigned there, in a fixed order). When an occurrence is **completed**, the task passes to the next person in the order, in the same batch as the completion, whoever actually completed it. **Skipping doesn't pass the turn.** **Missed occurrences** aren't recreated (a repeating task stays one task until it's done), so they never move the turn on by themselves; a late completion passes it once. **Undo** of a completion gives the turn back. **Reassigning by hand** simply makes it that person's turn, and the order carries on from them. Someone who leaves the project or becomes a viewer is removed from the turns in the same batch; if the next person can no longer be assigned at the moment of completion, the assignee is left as it was. A calendar-fixed rota ("Alex on odd weeks") isn't built: with turns that pass on completion, a skipped or late week can't silently swap people.
- **Pause** keeps the task, its date and history, but takes it out of Today, Upcoming, Overdue, the dashboards and workload, and cancels its pending reminder emails. **Resume** moves a date that passed while paused to the next scheduled date from today, without recording the missed occurrences as done or skipped; reminder emails follow the new date.
- **Stop** (delete the routine) keeps the task and its history; deleting the task removes the routine.
- Viewers see shared routines but can't change them.

### Timeline and workload

**Project timeline** (project → Timeline): start date, target date, milestones, deadlines, due dates, up to four later repeats of each open repeating task (up to the target date, or 90 days ahead), completed reviews and the next review due, in date order, grouped by month, with today marked. At most 300 dated tasks are read (the page says if there are more). It's a list rather than a Gantt chart: tasks have no durations or dependencies, and a list reads the same on a phone. Upcoming's week and month views (M2) are unchanged.

**Workload** (`/portal/tasks/workload?scope=mine|shared&weeks=1–4&from=&group=`): open dated tasks in a window starting on the Monday of the chosen week (one to four weeks, never more than a year from today), with repeats projected as in Upcoming (at most one per day of the window per task) and never into the past; overdue and undated tasks are listed separately. Group by day, week, project, priority or (shared) person. Summary: this week, next week, high priority (P1–P2) in the window, deadlines in the window, overdue, no date. "Mine" is what Today and Upcoming show; "shared" is every open task in shared projects you're a member of, whoever it's assigned to. **Warnings**, fixed thresholds over counts: three or more P1/P2 tasks due on one day; otherwise eight or more tasks due on one day; three or more overdue; an active project whose target date is within 14 days with five or more open tasks. **Nothing estimates effort or capacity**: tasks have no estimates, so the page counts tasks and says so. At most 600 tasks are shown per window.

Week boundaries are Mondays in the person's own calendar (dates are floating, so daylight-saving changes don't move them; tested across Sydney's October change). Month buckets in reports are calendar months.

### Reports (`/portal/tasks/reports?scope=personal|shared&range=4w|12w|6m|12m`)

Built only from `task_completions`. Definitions (also on the page under "How these are worked out"):

- **Completed**: each completion of a task, subtask or occurrence of a repeating task in the range, by its time in your time zone. Undone completions don't count. **Projected repeats never count**: only what actually happened is recorded.
- **Late**: completed on a later day than the date that was due (the occurrence's date for repeats). Undated tasks are never late. "On time" is the rest, as a share.
- **Skipped**: occurrences of repeating tasks passed over with Skip.
- **By week** for ranges up to 12 weeks (Monday-start), **by month** beyond; empty periods are shown.
- **Completed by project**, **repeating tasks** (completed and skipped occurrences each, marked when it's a routine), **open now by priority** and **overdue now** (personal: as Today counts them; shared: every open task in shared projects), and goal progress.
- **Personal** counts what you completed (anywhere you can still see). **Shared** counts completions in shared projects you belong to, by anyone in them, plus **open work by person** in those projects, presented as a spread of work, never as a ranking or a measure of anyone.

Reads are bounded: a range is at most a year and at most 20,000 completions are read (the report says if it was cut short). **CSV**: `GET /reports/export` (the page's CSV button) gives every figure as rows with a section column (period, project, priority, repeat, person, goal), with formula-like cells neutralised and the usual private, no-store download headers.

### Permissions summary

| Boundary                                        | How it's enforced (all server-side; tested)                                                                                                         |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Portal owner doesn't see others' private data   | Every new query joins the caller's own membership row (projects or goals); portal role only decides `tasks.use`.                                    |
| Shared project ≠ access to a goal               | Goals have their own members; linking grants nothing.                                                                                               |
| Knowledge reference ≠ Knowledge access          | Every read re-checks `knowledge.use` and space membership; unreadable objects are hidden or "unavailable".                                          |
| Knowledge access ≠ Tasks access                 | The object's related tasks list only tasks in projects the reader is a member of.                                                                   |
| Removed users lose access at once               | Every request re-reads membership; leaving also clears assignments, reminders and turns in the same batch.                                          |
| Counts can't reveal private records             | Dashboard, workload and report counts are COUNTs over the same membership-joined queries as their lists; shared views look only at shared projects. |
| Shared routines can't expose private tasks      | A routine is a task in one project; its visibility is that project's.                                                                               |
| Direct API requests and bulk operations         | Every route checks membership and role itself; review actions can only go into the reviewed project.                                                |
| Exports scoped                                  | The report CSV is built from the same scoped report.                                                                                                |
| No private text in logs or the portal audit log | Tasks history records statuses and ids, never notes, titles or which object was linked; nothing goes to `audit_log`.                                |

### Milestone 3 schema

`0017_tasks_productivity.sql` is additive: five nullable or defaulted columns on `task_projects` (`review_frequency`, `health_override`, `health_note`, `health_set_by`, `health_set_at`), and new tables `task_project_reviews` (+ partial unique index: one draft per project), `task_review_actions`, `task_project_knowledge_links`, `task_goals`, `task_goal_members` (+ single-member trigger for personal goals), `task_goal_links` (exactly one of project, task or Knowledge object per row; unique per target; triggers refusing personal projects and tasks in shared goals), `task_goal_milestones`, `task_goal_progress`, `task_routines` (unique `task_id`), `task_routine_participants` and `task_dashboard_preferences`. Every foreign key cascades from its owner (deleting a project removes its reviews and links; deleting a task removes its routine, review-action records and goal links; Knowledge permanently deleting an object removes references to it); nothing existing is changed or deleted. Indexes cover reviews by project and completion, goal membership by person, goal links by target, milestones and history by goal, routines by task and paused state, and participants by person. The Milestone 2 Worker never reads any of it, so a Worker rollback needs no database change. Ids: `trv_` reviews, `tpk_` project Knowledge links, `tgl_` goals, `tgk_` goal links, `tgm_` milestones, `trt_` routines.

**Backups.** No virtual tables are added, so the FTS-aware backup handles everything as ordinary tables. `npm run test:backup` now fills every Milestone 3 table on top of the Knowledge, wedding, blog and earlier Tasks rows, runs the real backup, restores twice, compares row counts for every table, and checks that health overrides, review snapshots and next actions, goal values, links, milestones and history, and routines with their turn order and completion history survive, and that the restored copy still refuses a second routine on a task, a second draft review for a project, and a personal project in a shared goal. The backup script's row-count check now also covers the Tasks tables. `npm run db:verify` adds: every goal has an owner and personal goals only theirs; shared goals draw only on shared projects; routines sit on repeating top-level tasks; people taking turns can still be assigned. A future Backup Centre should treat all `task_*` tables as one unit (they reference each other and `knowledge_objects`), keep using the per-table export while `knowledge_fts` exists, and check the same integrity rules after a restore.

### Performance and cost (Milestone 3)

- **No new services, bindings, secrets, cron triggers, queues, Durable Objects, AI or external APIs.** Everything is D1 queries on the existing Worker; normal use by two people is a negligible share of the existing Workers Paid plan.
- **Dashboard**: about 15 small indexed queries per load (each card is a COUNT plus a LIMIT 8, joined to the caller's memberships), plus one grouped count per 50 projects for health. Re-read after a change, debounced; no polling.
- **Workload and timeline**: bounded windows (≤ 4 weeks; ≤ 600 shown; ≤ 300 timeline tasks), projections computed in memory.
- **Reports**: one range query on `task_completions(at)` (≤ 20,000 rows, a year at most) aggregated on the Worker, never sent to the browser whole; a few grouped counts.
- **Bundle**: the new pages are part of the portal bundle; the blog bundle is unchanged (`check:bundle`).

## Export format

`GET /export` (Settings → Export) downloads everything the caller can see as **`daly.tasks` version 1** JSON: `projects` (with sections and, for shared projects, members), `tasks` (with parent and section ids, labels, assignee, dates, the stored repeat rule **and** its RRULE text, milestone flag, positions, timestamps, comments and readable Knowledge object ids), `completions` (including skips and undo marks), the caller's `labels`, `savedFilters` and `reminders`, the time zone and the export scope. CSV gives one row per task (id, title, description, project, section, parent id, status, priority, dates, RRULE, labels, assignee, milestone, created, completed) with formula-like cells neutralised. Downloads are `private, no-store`, `nosniff` and sandboxed. Exports are refused above 50,000 tasks (use the database backup).

A Todoist importer is deliberately not built yet: it should be designed against a real Todoist export.

## Testing

| Suite                                      | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `test/tasks-scheduling.test.ts`            | Repeat rules (intervals, weekdays, fortnights, month ends, leap years, overdue advancement, completion basis, end dates, invalid rules, RRULE), Quick Add parsing (dates, ambiguity, repeats, labels, projects, deadlines, times, false positives), Sydney/Brisbane reminder instants across DST, filter validation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `test/tasks.test.ts`                       | Database constraints and triggers; `tasks.use`; race-safe Inbox; CSRF; private-task isolation across every route, list, search, filter, label, history, export and page; history without text; create/edit/conflict/concurrent edits; duplicate/delete; completion idempotency; bulk atomicity and authorisation; subtask depth, cycles, moves and the open-subtasks question; sections and progress; archived projects; shared projects, assignment, viewers, removal; Today/Upcoming/Overdue and projections; repeating tasks (double and concurrent completion, undo, skip, deadlines, checklists, end dates); labels, filters, saved filters, search escaping; comments; Knowledge leakage (private, removed membership, trashed, deleted, export, reverse lookup); reminders and time zones; history privacy after moves; export structure, CSV injection, scope; every page renders                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `test/access.test.ts`                      | The second development identity is ignored outside local development                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `e2e/tasks.spec.ts` (desktop + Pixel 7)    | Every Tasks page: no errors, no horizontal overflow, no serious axe issues (and the task panel). Journeys A capture → edit → complete (and input kept on failure), B Today, C project with sections, ordering, progress and board moves, D subtasks, E weekly repeat, F/G shared project as two real identities and private-task isolation, H Knowledge link and hidden title, I export structure and CSV                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `test/tasks-milestone3.test.ts`            | Milestone 3 through the real API and database: the health, review-schedule, goal, turn and workload rules with their thresholds; personal dashboard counts equal to the lists, nothing private counted; household dashboard for two members, assignee filters, removal; Tasks ↔ Knowledge both ways with private notes, private tasks, revoked membership and trashed objects; project health, manual status with version, 404 for non-members; reviews (shared draft, version conflicts, next actions only into the project, snapshot, history, viewer and stranger access, frequency and "reviews due"); goals (privacy, task and manual progress, each task counted once, milestones, history, archive and delete, sharing only through membership, no personal work in shared goals even past the Worker, per-reader progress, Knowledge links); routines (schedule, checklist and history, duplicates and retries, turns on complete/skip/undo, eligibility and removal, pause and resume, privacy and viewers); workload (Monday windows, bounds, projections, overdue and undated, shared scope, DST); timeline (order, bounded repeats); reports (weeks and months, late, skips, undone, projected repeats never counted, shared scope, CSV injection); `tasks.use` on every new endpoint; every new page renders and a stranger's goal is 404 |
| `e2e/tasks-m3.spec.ts` (desktop + Pixel 7) | Every new page without errors, overflow or serious axe issues; 1 complete from the personal dashboard; 2/8/11 household dashboard as two identities with assignee filter and nothing private; 3 Knowledge page → linked tasks, Add task linked without a reload, task → note; 4 review with note and next action, completed; 5/6 goal linked to a project with manual progress and history; 7/8 shared routine taking turns, completed with its checklist, seen by the other person as their turn; 9 timeline; 10 personal and shared reports and CSV; 11 A's goals, routines and reports hidden from B                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `npm run test:backup`                      | Applies `0015` over a populated database, fills every `task_*` table, runs the real backup, restores twice, compares row counts and re-checks the personal-project trigger, composite keys and repeat rules                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

Browser tests use a second identity (`ACCESS_DEV_ALT_EMAIL` with a `portal_dev_identity=alt` cookie). It's part of the existing local-development bypass (`ENVIRONMENT=development` and a localhost `SITE_URL`), ignored everywhere else (tested), and `check:config` refuses it on deployed environments.

## Performance and cost

- No new services, bindings, secrets, cron triggers, queues, Durable Objects, AI or external APIs. Everything is D1 queries on existing infrastructure; normal use by two people is a negligible share of the existing Workers Paid plan.
- Each page load is a handful of indexed queries from the caller's membership rows; lists are bounded (Today/overdue 500, projects 2,000 open tasks, completed and filters paginated at 50–200, search 50, history 50 per page). Repeats are projected in memory, at most 14 per task. Reminders use an indexed range query when a page loads; there's no polling.
- The Tasks interface adds about 62 KB gzipped to the portal's JavaScript (454 → 517 KB); the blog bundle is unaffected (`check:bundle`).

## Performance and cost (Milestone 2)

- **Cron:** no new trigger. The existing 15-minute cron gains one indexed query (pending reminders due now) and, only when there are due reminders, a few small queries and one email each. With email reminders off it costs a single flag read per run.
- **Email:** one email per reminder per person who turned email reminders on (plus rare at-least-once duplicates and up to four retries for failures). For two people that's typically a handful a day, well within any of the configured providers' free or existing allowances.
- **D1:** Quick Add outside Tasks reads the shell once per page load when opened. Upcoming's week and month add two bounded queries (deadlines and completions in the window, 500 rows each). Imports write in bounded batches (at most 250 tasks a request). The test suite exercises 3,000 tasks in one Inbox and checks the lists stay within their bounds and respond quickly.
- **Bundle:** Tasks is part of the portal bundle, as before; the portal-wide Quick Add reuses it (the portal is a single bundle already, so there's nothing extra to lazy-load), and fetches its data only when opened. The blog bundle is unchanged (`check:bundle`).
- No new services, bindings, secrets, queues, Durable Objects or dependencies. Background email needs a provider the portal already supports.

## Known limitations

- Email is the only background reminder channel: no browser push, SMS or phone notifications. Delivery is at least once (a rare duplicate is possible), within about 15 minutes, and has only been tested with a mock provider.
- Quick Add understands the grammar above only; no free-form language. It points out what it didn't understand.
- Repeats: no "5th weekday" rules, no hourly repeats, and an occurrence's text and checklist are shared by the whole series.
- Calendar dragging is desktop-only (HTML5 drag and drop); the reschedule dialog (menu, "s", or tapping a later repeat) does everything dragging does, on every device.
- Todoist import reads CSV exports only (no live account, no JSON API dump), has been tested with invented files only, and can't bring completed tasks, timestamps, assignees, durations, reminders or attachments, because the export doesn't contain them.
- Collapsed sections aren't remembered between visits.
- Board drag-and-drop uses native HTML5 dragging (desktop); the card menu is the keyboard and touch alternative. Reordering within lists is by menu and Alt+↑/↓, not dragging.
- Labels are per person; there are no shared, centrally managed labels.
- No mentions, attachments or comment notifications.
- Milestone 3: no effort estimates or capacity (workload counts tasks); no Gantt chart, dependencies or durations (the timeline is a dated list); "blocked" isn't a task state; routine turns pass on completion (no calendar-fixed rota); goals have no financial engine (one number against a target); reviews can't be linked to Knowledge objects directly (their next actions can); dashboard cards can be hidden but not rearranged; the reports chart is the only chart, with a table view for screen readers; nothing is pushed or emailed about due reviews or goals (they show on the dashboard).
- Two members of a shared goal can see different task-based progress if they're members of different linked projects: progress is always worked out from what the reader can open.
- Deleting a task is permanent (with confirmation); there's no task trash. Completed tasks are always recoverable.
- Times are floating wall-clock times; two people in different time zones see the same "5 pm".

## Roadmap

- **Milestone 2: planning, reminders, templates, Todoist import.** Merged (#26). Deferred from it: browser push (needs an installable portal and VAPID secrets), a calendar (iCal) feed, remembering collapsed sections, and verifying the import against a real Todoist export.
- **Milestone 3 (this branch): integrated productivity.** Built: see above. Deferred: optional task estimates (and then capacity), calendar-fixed rotas, reminders for due reviews and goals, Knowledge links on reviews, dashboard card ordering and pinned/favourite projects, bulk "move all overdue" across projects from the dashboard (Today already does it for your tasks), waiting-on indicators, a daily planning checklist.
- **Milestone 4: AI and MCP.** The first part is built (draft PR, not deployed): authenticated, membership-scoped MCP tools through the `mcp.daly.id.au` gateway (`mcp/` in this repository), covering reads, search, capture, bounded edits and daily and weekly briefings. Destructive and bulk tools are left out entirely. See [MCP.md](MCP.md). Still to come: suggestions from Knowledge, and metering if any AI inference is ever added server-side. Tasks keeps working without any of it.

## Deploying

Nothing from Milestone 3 is deployed. The general steps, for any milestone, after approval:

1. Review and merge the draft PR. **Merging to `main` deploys and applies migrations automatically** (`.github/workflows/deploy.yml`), including `0013`–`0015` if they're still unapplied.
2. Before merging, take a verified backup: `npm run db:backup -- --env production`.
3. After deploying: `npm run db:verify -- --env production`, then open `/portal/tasks` as each owner; each gets an Inbox on first visit.
4. Optionally share a project with the other owner (Project → Share → Add member). Admins added in Portal settings can also be invited; wedding editors and viewers can't open Tasks.
5. No secrets, flags or Access changes are needed. Don't set `ACCESS_DEV_ALT_EMAIL` anywhere but local development.

**Milestone 2 specifically:**

1. Check the remote migration state first, read-only: `npx wrangler d1 migrations list DB --remote --env=""`. `0016_tasks_planning.sql` (and `0015` if Milestone 1 was never deployed, since the deploy token had expired) will be listed as unapplied.
2. Take and verify a backup: `npm run db:backup -- --env production`.
3. Merge the draft PR. The deploy workflow applies `0016` (and anything earlier still unapplied) and deploys the Worker. To apply the migration by hand instead: `npx wrangler d1 migrations apply DB --remote --env=""`, then `npx wrangler deploy --env=""`.
4. `npm run db:verify -- --env production`: all migrations applied, the new checks pass.
5. Open `/portal/tasks/upcoming?mode=week`, `/portal/tasks/mine`, `/portal/tasks/templates` and Settings as each owner; press `q` on a Knowledge page.
6. **Email reminders stay off** until the owner decides. To turn them on: confirm `EMAIL_DELIVERY` and its secrets are set on the production Worker (they're shared with wedding communications), switch on **Task reminder emails** in Portal settings → Features, then each person turns on **Email my reminders to me** in Tasks → Settings. Send yourself a test reminder a few minutes ahead and wait for the next 15-minute cron run.
7. Try the Todoist import with a real export (the preview writes nothing) before importing everything.

**Milestone 3 specifically** (none of this has been run):

1. Read-only check of the remote migration state: `npx wrangler d1 migrations list DB --remote --env=""`. `0017_tasks_productivity.sql` (and any of `0013`–`0016` the failed deploys left behind) will be listed as unapplied.
2. Take and verify a backup: `npm run db:backup -- --env production`.
3. Merge the draft PR after review. The deploy workflow applies `0017` (and anything earlier still unapplied) and deploys the Worker. By hand instead: `npx wrangler d1 migrations apply DB --remote --env=""`, then `npx wrangler deploy --env=""`.
4. `npm run db:verify -- --env production`: all migrations applied and the new goal and routine checks pass.
5. As each owner, open `/portal/tasks/dashboard` (both tabs), `/portal/tasks/goals`, `/portal/tasks/routines`, `/portal/tasks/workload` and `/portal/tasks/reports`, a project's Overview and Timeline, and a Knowledge page with a linked task.
6. No secrets, feature flags, cron changes, Access changes or email are involved. Existing data is untouched; projects start with "on demand" reviews and no manual health.

**Rollback:** redeploy the previous Worker (`npx wrangler rollback --env=""` or redeploy `main`'s previous commit). The new columns and tables are ignored by earlier code (Milestone 3's by Milestone 2's), so the database needn't change; D1 has no down migrations and reverting the schema would mean restoring a backup. If email reminders misbehave, switch **Task reminder emails** off: nothing more is sent, and pending reminders stay queued.
