# Daly Tasks & Projects

A private task and project manager at `/portal/tasks` for personal work and work shared between two people: Inbox, Today, Upcoming, projects with sections and boards, subtasks, priorities, due dates and deadlines, repeating tasks, labels, saved filters, comments, history, in-app reminders, links to Daly Knowledge, and portable export. It runs on the existing Worker and D1 database, needs no AI or paid service, and is meant to replace Todoist without locking data into a proprietary format.

**Status:** Milestone 1 is built and tested. **Not deployed.** Migration `0015_tasks.sql` has not been applied to any remote database. See [Deploying](#deploying).

The repository is public: tests and fixtures use invented people and tasks only.

---

## How it fits together

```
src/shared/tasks/          Shared by Worker and browser
  types.ts                 Data shapes, limits, roles, priorities
  recurrence.ts            Repeat rules: validation, next occurrence, RRULE export
  parse.ts                 Quick Add's deterministic text parser
  filters.ts               The filter definition (validated on both sides)
  dates.ts                 Calendar dates, relative labels, zoned reminder instants
worker/tasks/
  access.ts                Project membership: the only way to reach a project, task or result
  api.ts                   /api/portal/tasks/* router
  tasks.ts                 Task engine: create, edit, move, complete/skip/reopen, duplicate, delete, bulk
  projects.ts              Projects, members, sections
  views.ts                 Inbox, Today, Upcoming, Overdue, Completed, filters, search
  labels.ts comments.ts    Labels; comments
  reminders.ts settings.ts Reminders; saved filters and preferences
  knowledge.ts             References to Knowledge objects, checked through Knowledge's own access
  activity.ts export.ts    Privacy-safe history; JSON and CSV export
  pages.ts rows.ts         First-render data for each page; row mapping
src/portal/tasks/          Pages, task row and list, task panel, Quick Add, pickers, dialogs
migrations/0015_tasks.sql  Schema
```

The application is registered in `src/shared/portal/applications.ts` (`tasks`, permission `tasks.use`). Pages render in the browser from data the Worker embeds, like the rest of the portal. It uses Untitled UI PRO throughout: the task panel and filter builder follow the PRO slideout layouts (`create-event-menu`, `filters-menu`), the label picker follows `labels-menu`, project dialogs follow `new-project-modal` and `user-invite-modal`, history and comments use the PRO `activity-feed`, and lists use the PRO dropdowns, badges, tabs, selects, calendar, metrics and progress bars.

The existing wedding planner's tasks (`/portal/wedding/tasks`, table `tasks`) are a separate feature and are unchanged.

## Navigation and views

| View                           | What                                                                                                                                                                                                  |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Inbox**                      | Your own Inbox project: where tasks land when no project is chosen. Nested subtasks, reordering, bulk changes.                                                                                        |
| **Today**                      | Grouped: overdue (by date or deadline), due today, deadline today, and optionally undated tasks at or above a chosen priority (Settings).                                                             |
| **Upcoming**                   | The next 14 days, day by day, with overdue first, date navigation (earlier/later/jump), "Add task" per day and later repeats projected in place.                                                      |
| **Overdue**                    | Everything past its due date or deadline.                                                                                                                                                             |
| **Completed**                  | Every completion and skip, newest first, grouped by day; reopen or undo the latest.                                                                                                                   |
| **My / Shared projects**       | Project cards with progress, your own sidebar order, and completed/archived projects kept separately.                                                                                                 |
| **Project**                    | List (sections, nested subtasks), Board (sections as columns; drag a card or use its menu), Overview (counts, progress, coming up, deadlines, milestones, members, linked Knowledge, recent history). |
| **Labels**                     | Your labels with open counts; rename, recolour, delete; labels others use on shared tasks.                                                                                                            |
| **Filters**                    | A filter builder (projects, labels any/all, priorities, due, deadline, assignee, status, personal/shared, words, sort) and saved filters.                                                             |
| **Search, Activity, Settings** | Search across titles, descriptions, labels and project names; history across your projects; time zone, Today options and export.                                                                      |

Active projects also appear in the sidebar. "My tasks" views (Today, Upcoming, Overdue) show open tasks in **active** projects you can edit that are **assigned to you or to nobody**; a task assigned to someone else stays in its project. Projects on hold, completed or archived don't feed those views.

### Quick Add

Press **q** (or **Add task**) anywhere. Type naturally and check the chips under the field before pressing Enter: each says what was understood and can be dismissed, which puts the words back in the title. The pickers set the same things explicitly and always win. If saving fails, the text stays.

| Write                                                                                                                                                                              | Read as                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `today`, `tomorrow`, `friday`, `this friday`, `next week`, `next month`, `in 3 days`, `23/11`, `23 nov`, `nov 23 2027`, `2027-01-04`                                               | Due date. Numeric dates are day/month (Australian). A date without a year that has passed means next year. |
| `next friday`                                                                                                                                                                      | Friday of next week, flagged as ambiguous; the chip shows the exact date.                                  |
| `at 5pm`, `9:30am`, `17:45`, `noon`                                                                                                                                                | Due time (today if no date).                                                                               |
| `p1` … `p4`                                                                                                                                                                        | Priority.                                                                                                  |
| `@errands`                                                                                                                                                                         | Label (several allowed).                                                                                   |
| `#household`                                                                                                                                                                       | Project, matched by name with spaces ignored; unknown names stay in the title.                             |
| `every day`, `every weekday`, `every wednesday`, `every mon, wed and fri`, `every 3 days`, `every 2 weeks`, `fortnightly`, `every month`, `every 15th`, `every last day`, `yearly` | Repeat, starting on its first occurrence from today.                                                       |
| `{31 oct}`                                                                                                                                                                         | Deadline.                                                                                                  |

There is no language model involved. Anything outside this grammar stays in the title.

### Keyboard

`q` add · `/` search · `g` then `i`/`t`/`u`/`p`/`o` go to Inbox/Today/Upcoming/projects/Overdue · `j`/`k` or ↓/↑ move between tasks · Enter open · `e` complete or reopen · Alt+↑/↓ reorder · Esc close · `?` list them. Shortcuts never fire while typing in a field.

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
- **Bulk**: complete, reschedule, priority, move, add/remove label, delete, for up to 100 tasks, in one batch.
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
- Upcoming projects at most 14 later occurrences per task within the window, computed on the fly.

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

Each person can add reminders to tasks they can see: at a date and time, or relative to the due time (a date-only task counts as due at 9 am in the owner's zone). Relative reminders follow the task when its date changes or it repeats. **Delivery is in-app only**: due reminders appear at the top of any Tasks page, and ones due within the hour appear when their time comes while a page stays open. There is no email, SMS, push or scheduled Worker yet, so a reminder isn't seen unless Tasks is open. Reminders are found with an indexed `(owner_email, remind_at)` range query; nothing scans the table.

## Knowledge integration

A task can reference Knowledge objects (up to 20). Two permission systems apply and neither implies the other:

- **Adding** needs edit access to the task, `knowledge.use`, and read access to the object through Knowledge's own `requireObject` (404 for anything outside the caller's spaces). Trashed objects can't be linked.
- **Reading**: every time, each reference is checked against the reader's current Knowledge membership. If they can't read it (not a member, no `knowledge.use`, or the object is trashed) they see only "A Knowledge item you don't have access to": no title, space or id. The export lists only object ids the exporter can read.
- **Removing** needs edit access to the task, even without access to the object.
- The history records that a reference was added or removed, never which.
- Knowledge isn't changed. `task_knowledge_links` holds ids, with a foreign key that removes the reference when Knowledge permanently deletes the object.
- **Reverse direction**: `GET /api/portal/tasks/knowledge/:objectId` returns linked tasks the caller can see in Tasks, only if they can read the object in Knowledge. The Knowledge object page doesn't show related tasks yet (Milestone 3 of Tasks); this endpoint is the interface it will use.

## API

All under `/api/portal/tasks`, all requiring Access, `tasks.use` and membership. Writes need a same-origin JSON request. Errors are the portal's usual `{ error, message, issues? }`; conflicts return 409 with `current`, and completing a task with open subtasks returns 409 `open_subtasks` with `count`.

| Method and path                                                                                                                 | What                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `GET /lists/:view`                                                                                                              | `inbox`, `today`, `overdue`, `upcoming?from=&days=`, `completed?before=`                                        |
| `GET /filter?…`, `GET /search?q=`                                                                                               | Ad-hoc filter (same fields as saved filters, paginated); search                                                 |
| `POST /tasks`, `GET/PATCH/DELETE /tasks/:id`                                                                                    | Create; detail (subtasks, comments, completions, references, reminders, history); update with `version`; delete |
| `POST /tasks/:id/complete`, `…/skip`, `…/reopen`                                                                                | `{ occurrence, includeSubtasks }`                                                                               |
| `POST /tasks/:id/move`, `…/duplicate`, `POST /tasks/bulk`                                                                       | Move (`projectId`, `sectionId`, `parentId`, `afterId`/`beforeId`); duplicate; bulk actions                      |
| `GET/POST /tasks/:id/comments`, `PATCH/DELETE /comments/:id`                                                                    | Comments                                                                                                        |
| `POST /tasks/:id/knowledge`, `DELETE /tasks/:id/knowledge/:link`, `GET /knowledge/:object`                                      | Knowledge references and reverse lookup                                                                         |
| `POST /tasks/:id/reminders`, `DELETE /reminders/:id`, `POST /reminders/:id/dismiss`, `GET /reminders/due`                       | Reminders                                                                                                       |
| `GET/POST /projects`, `GET/PATCH /projects/:id`, `GET /projects/:id/completed`                                                  | Projects (with counts); update with `version`                                                                   |
| `POST /projects/:id/kind`, `…/delete` (`{ "confirm": "DELETE" }`), `…/position`                                                 | Share/unshare; delete (owner, never the Inbox); your sidebar order                                              |
| `GET/POST /projects/:id/members`, `PATCH/DELETE /projects/:id/members/:email`                                                   | Members (owners change; anyone may leave)                                                                       |
| `POST /projects/:id/sections`, `PATCH /sections/:id`, `POST /sections/:id/position`, `POST /sections/:id/delete` (`{ moveTo }`) | Sections                                                                                                        |
| `GET/POST /labels`, `PATCH/DELETE /labels/:id`                                                                                  | Labels                                                                                                          |
| `GET/POST /filters`, `GET/PATCH/DELETE /filters/:id`, `POST /filters/validate`                                                  | Saved filters                                                                                                   |
| `GET /activity?project=&before=`, `GET/PATCH /preferences`                                                                      | History; time zone and Today option                                                                             |
| `GET /export?format=json                                                                                                        | csv&scope=all                                                                                                   | personal` | Export |

Pages: `/portal/tasks` (Today), `/portal/tasks/{inbox,today,upcoming,overdue,completed,projects,labels,filters,search,activity,settings}`, `/portal/tasks/p/:id?view=list|board|overview`, `/portal/tasks/t/:id` (a task, opened in its project).

## Export format

`GET /export` (Settings → Export) downloads everything the caller can see as **`daly.tasks` version 1** JSON: `projects` (with sections and, for shared projects, members), `tasks` (with parent and section ids, labels, assignee, dates, the stored repeat rule **and** its RRULE text, milestone flag, positions, timestamps, comments and readable Knowledge object ids), `completions` (including skips and undo marks), the caller's `labels`, `savedFilters` and `reminders`, the time zone and the export scope. CSV gives one row per task (id, title, description, project, section, parent id, status, priority, dates, RRULE, labels, assignee, milestone, created, completed) with formula-like cells neutralised. Downloads are `private, no-store`, `nosniff` and sandboxed. Exports are refused above 50,000 tasks (use the database backup).

A Todoist importer is deliberately not built yet: it should be designed against a real Todoist export.

## Testing

| Suite                                   | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/tasks-scheduling.test.ts`         | Repeat rules (intervals, weekdays, fortnights, month ends, leap years, overdue advancement, completion basis, end dates, invalid rules, RRULE), Quick Add parsing (dates, ambiguity, repeats, labels, projects, deadlines, times, false positives), Sydney/Brisbane reminder instants across DST, filter validation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `test/tasks.test.ts`                    | Database constraints and triggers; `tasks.use`; race-safe Inbox; CSRF; private-task isolation across every route, list, search, filter, label, history, export and page; history without text; create/edit/conflict/concurrent edits; duplicate/delete; completion idempotency; bulk atomicity and authorisation; subtask depth, cycles, moves and the open-subtasks question; sections and progress; archived projects; shared projects, assignment, viewers, removal; Today/Upcoming/Overdue and projections; repeating tasks (double and concurrent completion, undo, skip, deadlines, checklists, end dates); labels, filters, saved filters, search escaping; comments; Knowledge leakage (private, removed membership, trashed, deleted, export, reverse lookup); reminders and time zones; history privacy after moves; export structure, CSV injection, scope; every page renders |
| `test/access.test.ts`                   | The second development identity is ignored outside local development                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `e2e/tasks.spec.ts` (desktop + Pixel 7) | Every Tasks page: no errors, no horizontal overflow, no serious axe issues (and the task panel). Journeys A capture → edit → complete (and input kept on failure), B Today, C project with sections, ordering, progress and board moves, D subtasks, E weekly repeat, F/G shared project as two real identities and private-task isolation, H Knowledge link and hidden title, I export structure and CSV                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `npm run test:backup`                   | Applies `0015` over a populated database, fills every `task_*` table, runs the real backup, restores twice, compares row counts and re-checks the personal-project trigger, composite keys and repeat rules                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

Browser tests use a second identity (`ACCESS_DEV_ALT_EMAIL` with a `portal_dev_identity=alt` cookie). It's part of the existing local-development bypass (`ENVIRONMENT=development` and a localhost `SITE_URL`), ignored everywhere else (tested), and `check:config` refuses it on deployed environments.

## Performance and cost

- No new services, bindings, secrets, cron triggers, queues, Durable Objects, AI or external APIs. Everything is D1 queries on existing infrastructure; normal use by two people is a negligible share of the existing Workers Paid plan.
- Each page load is a handful of indexed queries from the caller's membership rows; lists are bounded (Today/overdue 500, projects 2,000 open tasks, completed and filters paginated at 50–200, search 50, history 50 per page). Repeats are projected in memory, at most 14 per task. Reminders use an indexed range query when a page loads; there's no polling.
- The Tasks interface adds about 62 KB gzipped to the portal's JavaScript (454 → 517 KB); the blog bundle is unaffected (`check:bundle`).

## Known limitations

- Reminders are in-app only (no email, SMS, push or background delivery).
- Quick Add understands the grammar above only; no free-form language, and no repeat syntax like "every second Tuesday of the month".
- Repeats: no "nth weekday of the month" rules, no count-limited series, no editing a single occurrence.
- Upcoming is an agenda, not a calendar grid; dragging between dates isn't supported.
- Board drag-and-drop uses native HTML5 dragging (desktop); the card menu is the keyboard and touch alternative. Reordering within lists is by menu and Alt+↑/↓, not dragging.
- Labels are per person; there are no shared, centrally managed labels.
- No mentions, notifications, attachments, task templates or Todoist import yet.
- Knowledge doesn't show related tasks on object pages yet (the API exists).
- Deleting a task is permanent (with confirmation); there's no task trash. Completed tasks are always recoverable.
- Times are floating wall-clock times; two people in different time zones see the same "5 pm".

## Roadmap

- **Milestone 2: Todoist migration and scheduling.** Import from a real Todoist export with preview, reconciliation and idempotent re-runs; reliable reminder delivery (scheduled Worker with an indexed, idempotent queue; email via the existing providers; browser push), richer repeats, calendar feed, templates, more bulk tools and filters.
- **Milestone 3: integrated productivity.** Related tasks on Knowledge pages through `GET /knowledge/:object`, household dashboards, project reviews, goals, shared routines, calendar and timeline views, reporting.
- **Milestone 4: AI and MCP.** Authenticated, membership-scoped MCP tools; search and capture through assistants; suggestions from Knowledge; summaries and briefings; confirmation before consequential writes; metering and cost limits. Tasks must keep working without any of it.

## Deploying

Nothing here is deployed. After approval:

1. Review and merge the draft PR. **Merging to `main` deploys and applies migrations automatically** (`.github/workflows/deploy.yml`), including `0013`–`0015` if they're still unapplied.
2. Before merging, take a verified backup: `npm run db:backup -- --env production`.
3. After deploying: `npm run db:verify -- --env production`, then open `/portal/tasks` as each owner; each gets an Inbox on first visit.
4. Optionally share a project with the other owner (Project → Share → Add member). Admins added in Portal settings can also be invited; wedding editors and viewers can't open Tasks.
5. No secrets, flags or Access changes are needed. Don't set `ACCESS_DEV_ALT_EMAIL` anywhere but local development.
