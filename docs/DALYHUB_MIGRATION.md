# DalyHub V2 → Daly Portal data migration

How useful DalyHub V2 data moves into Daly Tasks and Daly Knowledge before DalyHub is retired. **Nothing here runs by itself.** Every step is started by the owner, previewed first and reversible. Production data is never imported or changed automatically.

Code: `src/shared/migration/dalyhub.ts` (the planner), `scripts/dalyhub-plan.mjs` (local planning), `worker/migration/dalyhub.ts` (preview, apply, revert), `migrations/0019_dalyhub_import.sql` (provenance). Tests: `test/dalyhub-migration.test.ts`.

## DalyHub's data model (audit)

DalyHub V2 keeps one owner's workspace in D1 `dalyhub-v2` (about 2.6 MB in October 2026), with attachments in R2 `dalyhub-v2-attachments`. The schema has 59 migrations. Every record is a row in `entities` (`id`, `workspace_id`, `type`, `title`, timestamps, soft `deleted_at`), and each type keeps its fields in a `*_details` table. Structure comes from `spine_records` (Area → Goal → Project → Task, with `completed_at`) and typed `entity_links` (`task.belongs_to_project`, `project.belongs_to_area`, `project.advances_goal`, `task.waiting_on`, `link.related` and others). Tags live in `entity_tags`.

| DalyHub data                                                                                    | Tables                                                                                                                                                  | Useful in the portal?                                                          |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Tasks (status, P1–P4, due and scheduled dates, waiting/delegation, someday, time sectors)       | `task_details`, `task_checklist_items`, `task_recurrence_rules`                                                                                         | **Yes**: Daly Tasks                                                            |
| Projects (planned/active/on hold, archived)                                                     | `project_details`                                                                                                                                       | **Yes**: Tasks projects                                                        |
| Goals (target date, definition of done, measurement, milestones)                                | `goal_details`, `goal_measurements`, `goal_milestones`                                                                                                  | **Yes**: Tasks goals (without measurement history or milestones)               |
| Areas                                                                                           | `area_details`                                                                                                                                          | **Yes**: Knowledge Area objects, plus a label on their tasks                   |
| Notes (Markdown)                                                                                | `note_details`                                                                                                                                          | **Yes**: Knowledge Pages                                                       |
| Decisions                                                                                       | `decision_details`                                                                                                                                      | **Yes**: Knowledge Decisions                                                   |
| Meetings (agenda, notes)                                                                        | `meeting_details`, `meeting_items`, `meeting_item_tasks`                                                                                                | **Yes**: Knowledge Meetings (agenda and notes; meeting items aren't split out) |
| People (contact details, relationships, follow-ups)                                             | `person_details`, `workspace_members`                                                                                                                   | **Owner decision**. Not migrated by default                                    |
| Diary                                                                                           | `diary_entry_details`                                                                                                                                   | No. Private by DalyHub's own rules                                             |
| Finance, assets, obligations                                                                    | `finance_*`, `asset_*`, `obligation_details`                                                                                                            | No home in the portal                                                          |
| Habits                                                                                          | `habit_*`                                                                                                                                               | Could become Tasks routines later; not migrated                                |
| Reviews, insights, AI, notifications, calendar, templates, views, preferences, offline receipts | `review_*`, `ai_*`, `notification*`, `external_calendar_*`, `project_template_*`, `task_saved_views`, `owner_app_preferences`, `offline_*`, `capture_*` | No. History, configuration or DalyHub machinery                                |
| Attachment files                                                                                | `attachments` + R2                                                                                                                                      | Not copied. They stay in the final R2 backup                                   |

## What the migration does

| DalyHub                                         | Daly Portal                                                                                                                                 |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Project (open)                                  | A **personal** Tasks project. Its status, Area and goal go in the description. Archived and completed ones are skipped unless asked for     |
| Task (open)                                     | A task in that project, or the Inbox. Scheduled date → due date, due date → deadline (with only a due date, it's the due date). P1–P4 kept  |
| Checklist item (open)                           | A subtask                                                                                                                                   |
| Waiting / delegated                             | Label `waiting`. "Waiting on … since …; follow up …" in the description, and the follow-up date as the due date                             |
| Someday / on hold                               | Labels `someday` / `on-hold`                                                                                                                |
| Repeating task                                  | One task, label `was-repeating`, with a note to set the repeat up again. DalyHub's rules aren't translated, so nothing repeats unexpectedly |
| Area                                            | A Knowledge **Area** object (listing its projects) and a label with its name on its tasks                                                   |
| Goal (open)                                     | A personal Tasks goal, with its definition of done, target date and links to the migrated projects that advance it                          |
| Note                                            | A Knowledge **Page** with its tags. **Markdown is kept as literal text**: there's no Markdown importer, and text is never parsed as markup  |
| Decision                                        | A Knowledge **Decision** (status, decided-on date, rationale, review date)                                                                  |
| Meeting (not cancelled)                         | A Knowledge **Meeting** (date, place, agenda and notes as text)                                                                             |
| Note, decision or meeting filed under a project | Linked to that project (Tasks → Knowledge reference)                                                                                        |
| Everything                                      | Label or tag `dalyhub`, so it's easy to find, review or tidy up                                                                             |

Everything goes into the **personal** records of the owner running it, through the ordinary Tasks and Knowledge services. Every validation, history entry, `knowledge_audit` / `task_activity` row and search index applies, exactly as if typed in. Nothing is shared, and nobody else's records are read or changed (tested with a second owner).

## Procedure

Run as the portal owner. Each step says whether it writes anything.

### 1. Back up (writes nothing to production)

- Portal: `npm run db:backup` (exports, restores and verifies `dalyidau-production` locally). Also note the D1 Time Travel bookmark: `npx wrangler d1 time-travel info DB --env=""`.
- DalyHub: run its encrypted **Production D1 backup** workflow (`.github/workflows/production-backup.yml` in DalyHub-V2) and keep the artifact.

### 2. Export DalyHub (read-only on DalyHub)

In DalyHub-V2, export production through its audited wrapper (`scripts/production-d1.mjs`), or `npx wrangler d1 export dalyhub-v2 --remote --output dalyhub.sql`. Put the SQL file in this repository's `migration-work/` folder. **That folder is git-ignored and must stay that way: this repository is public**, and the export holds the whole DalyHub life (People, Diary, Finance). Delete the file when the migration is verified.

### 3. Plan locally (writes nothing; no network)

```sh
node scripts/dalyhub-plan.mjs migration-work/dalyhub.sql            # open work only
node scripts/dalyhub-plan.mjs migration-work/dalyhub.sql --include-completed --include-archived
```

This loads the export into an in-memory SQLite database (Node 22.18+, built-in `node:sqlite`). It writes `migration-work/dalyhub-plan.json` and `migration-work/dalyhub-preview.md`: what will be created, what's left behind and why, and warnings. Only the records listed in the plan ever reach the portal. People, Diary and Finance never leave your machine. Read the preview and edit the plan by hand if you like (remove entries), then re-run the preview step below.

### 4. Turn the migration routes on (production config, owner approval)

`npx wrangler secret put DALYHUB_MIGRATION --env=""` with the value `on`. A secret, not a var, so it's switched without a deploy and isn't in the repository. While unset, every migration route answers 404.

### 5. Preview against production (writes nothing)

The routes need the owner's Access session, so call them from a terminal with `cloudflared access curl` (or the browser console on daly.id.au/portal):

```sh
cloudflared access curl https://daly.id.au/api/portal/migrations/dalyhub/preview \
  -X POST -H 'content-type: application/json' -H 'origin: https://daly.id.au' \
  --data "{\"plan\": $(cat migration-work/dalyhub-plan.json)}"
```

The answer has the plan's `fingerprint`, how many records would be created, how many were imported before, and any imported and then removed since (those stay removed). Check it against the local preview.

### 6. Apply (writes: owner's own records only)

```sh
cloudflared access curl https://daly.id.au/api/portal/migrations/dalyhub/apply \
  -X POST -H 'content-type: application/json' -H 'origin: https://daly.id.au' \
  --data "{\"plan\": $(cat migration-work/dalyhub-plan.json), \"fingerprint\": \"<from preview>\"}"
```

Each request creates at most 40 records and answers `{ runId, done, created, remaining }`. Repeat with `"runId": "<runId>"` added until `done` is true. A different plan is refused (`plan_changed`). Running the same plan again creates nothing twice. A run cut off part-way resumes where it stopped (tasks are also protected by the Tasks engine's own request-id guard). Every request writes one `audit_log` row with counts only.

### 7. Verify (read-only)

- In the portal: Tasks → label `dalyhub`; Knowledge → tag `dalyhub`. Spot-check projects, waiting items, goals and a few notes against DalyHub.
- Through MCP: `chief_of_staff_daily_context` should now carry the open work DalyHub's briefing had.
- `GET /api/portal/migrations/dalyhub/runs` lists runs and their summaries.
- `npm run db:backup` again: provenance tables are counted and verified like any other.

### 8. Revert (if needed)

```sh
# What would be removed, and what would be kept (writes nothing):
cloudflared access curl https://daly.id.au/api/portal/migrations/dalyhub/runs/<runId>/revert -X POST \
  -H 'content-type: application/json' -H 'origin: https://daly.id.au' --data '{"dryRun": true}'
# Then for real:
... --data '{"dryRun": false}'
```

Revert removes, newest first, only the records the run created that are **untouched since**: same version, no comments, no subtasks or tasks added inside, and for projects nothing else in them. Knowledge objects go to the **Trash**, where they can still be restored. Anything edited is **kept** and listed with the reason. Nothing that wasn't imported is ever touched. As a last resort for the whole database, D1 Time Travel can return to the bookmark from step 1, but that also undoes every other change made since, so prefer revert.

### 9. Switch off

`npx wrangler secret delete DALYHUB_MIGRATION --env=""`, and delete `migration-work/`.

## Must be verified before DalyHub is decommissioned

- The plan's "left behind" list has been read, and the owner has decided about People (see [MCP.md](MCP.md#the-34-dalyhub-tools-retired)).
- Open DalyHub tasks, projects, goals, notes, decisions and meetings appear in the portal with the `dalyhub` label or tag.
- Anything with no portal home (finance, assets, diary, attachments) is in the final DalyHub backup ([MCP_CUTOVER.md](MCP_CUTOVER.md#dalyhub-decommissioning-checklist)) and the owner has confirmed that's enough.
