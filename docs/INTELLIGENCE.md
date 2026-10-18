# Daly Intelligence

The shared AI layer of Daly Portal (Milestone 5) at `/portal/intelligence`: Intelligent Capture, the AI Suggestions Inbox, semantic Knowledge search, the Chief of Staff daily briefing and weekly review, meeting transcription, document extraction, AI usage and budgets, and shared attachments with retention. It's one engine that Tasks, Knowledge and future applications (budget, home and assets, calendar) call; nothing is duplicated per application.

**The rule it's built on: AI proposes, people approve, and the portal stays the source of truth.** Background work only ever produces suggestions. A task, project or Knowledge record is created when the person approves it, through the same functions and checks as the portal's own buttons.

**Status:** built and tested locally with deterministic stand-ins for the models. **Off by default and not deployed.** Workers AI and Vectorize aren't connected (no bindings in `wrangler.jsonc`), every feature switch is off, and migration `0021_intelligence.sql` hasn't been applied anywhere. No model has been called by this work: see [What has and hasn't been validated](#what-has-and-hasnt-been-validated). Activation is a short owner checklist: [Activation](#activation).

---

## Architecture

```
src/shared/intelligence/
  config.ts        Feature switches, model registry and prices, budgets, limits, retention, preferences (Worker and browser)
  types.ts         Suggestion payload schemas (validated on create, edit and approve) and API shapes
worker/intelligence/
  bindings.ts      The narrow AI and Vectorize interfaces used, plus deterministic stand-ins for tests/dev
  provider.ts      The only way to call a model: switches, circuit breaker, budget, timeout, usage, validation
  usage.ts         ai_usage, budgets (checked before each call), alerts, the circuit breaker
  jobs.ts          Durable D1 job queue: dedupe, claims, bounded steps, backoff, dead letter, cost approval
  runner.ts        Cron pass (retention, alerts, briefings, jobs, semantic index) and per-request nudges
  semantic.ts      Chunking, incremental Vectorize index, hybrid search, related-by-meaning
  capture.ts       Intelligent Capture: captures, grounded extraction, suggestion drafting, project matching
  suggestions.ts   The Inbox: list, edit, dismiss, exactly-once approval into Tasks and Knowledge
  documents.ts     Document extraction with safeguards
  meetings.ts      Recording plans (WAV/MP3 cutting), resumable transcription, then analysis
  briefings.ts     Daily briefing and weekly review: facts, optional recommendations, scheduling
  attachments.ts   Shared R2 attachments: chunked upload, byte checks, downloads, retention
  prompts.ts       Prompts and the untrusted-content fence
  settings.ts      Account settings, preferences, exclusions, binding detection, availability
  api.ts pages.ts views.ts   /api/portal/intelligence/* and page loaders
worker/mcp/intelligence.ts   Ten MCP tools (below)
src/portal/intelligence/     Overview, Capture, Suggestions, Briefings, Meetings, AI and storage settings
migrations/0021_intelligence.sql
```

The application is registered in `src/shared/portal/applications.ts` (`intelligence`, permission `intelligence.use`, which owners and admins have; wedding editors and viewers don't). Knowledge gains "Related by meaning" on its search page, possible duplicates and meaning-based suggestions under Related knowledge, and "Analyse with Intelligence…" on object pages. Each falls back silently to what Knowledge did before.

### Cloudflare services and why

| Need                        | Used                                                                    | Why not something else                                                                                                                                                                                                                                                |
| --------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inference, embeddings, ASR  | **Workers AI** (`AI` binding)                                           | On the existing Workers Paid plan, 10,000 Neurons a day included today, no keys to store. No external provider is used; confidential material never leaves Cloudflare's network for a third party                                                                     |
| Semantic index              | **Vectorize** (`VECTORS` binding), one namespace per Knowledge space    | Included allowance (50M queried and 10M stored dimensions a month on Workers Paid) covers a household many times over                                                                                                                                                 |
| Document text               | **Workers AI Markdown Conversion** (`env.AI.toMarkdown`)                | PDF and Office parsing without bundling a parser into the Worker                                                                                                                                                                                                      |
| Background work             | **D1 job table + the existing 15-minute cron + `ctx.waitUntil` nudges** | Cloudflare Queues would need a new binding and resource for a few jobs a day. The job table gives dedupe, claims, retries, a dead letter and cost approval, and is tested. Handlers don't depend on the trigger, so Queues can replace it later without changing them |
| State, audit, configuration | **D1** (`0021`)                                                         | Authoritative and backed up with everything else                                                                                                                                                                                                                      |
| Files                       | **R2** (`MEDIA`, under `private/`)                                      | The existing bucket; the prefix is never served publicly (tested). A dedicated private bucket is possible later and only changes `attachments.ts`                                                                                                                     |
| Observability (optional)    | **AI Gateway** (`AI_GATEWAY_ID` var)                                    | Off by default. When set, calls go through the gateway with `collectLog: false` requested; **turn log collection off on the gateway itself** too, because prompts contain private notes                                                                               |

## Privacy and permissions

- **Identity** is always the verified Access identity (browser) or the re-verified Access token (MCP). No API or tool takes an owner, email or user id from its input.
- **Ownership.** Captures, transcripts, suggestions, jobs, briefings and uploaded files belong to one person and are always read joined to their email. Anyone else gets 404, whatever their portal role. The other portal owner can't see your captures.
- **Knowledge** is reached only through space membership (`worker/knowledge/access.ts`), exactly as in Knowledge. **Tasks** through project membership. Suggestion payloads can only contain ids the Worker put there after a membership check, and **approval re-checks every id** (an edited suggestion pointing at someone else's project is 404).
- **Semantic search.** Vectors are per space, never per person: each space is a Vectorize namespace and a vector carries only `{o: objectId, c: chunk}`, no title or text. Queries name only the caller's spaces, and every result is looked up again in D1 joined to membership and filters before anything (title, excerpt) is returned. Tested against an index that deliberately returns another person's vector. Removing a member takes effect on the next query; trashed, deleted and excluded objects disappear from results immediately and their vectors are removed by the next index pass.
- **Exclusions.** A space editor can exclude a space or object from AI (Settings → Privacy, or `POST /exclusions`). Excluded content is never embedded, analysed or used as context, and its vectors are removed. People can also leave spaces out of their own briefings.
- **Prompt injection.** Everything from notes, uploads, transcripts and other applications is fenced as untrusted data (`prompts.ts`: markers the content can't forge, a system rule never to follow it). Whatever a model returns is schema-validated, then **grounded**: each item must quote evidence found in the source, names (owners, projects, people waited on) must appear in the source, dates must be real and plausible, ids are never taken from a model. The worst a malicious document can do is produce a pending suggestion that quotes it, which a person reads and dismisses (tested).
- **Logs** hold events, codes, models and counts: never a person, a prompt, a note, a transcript or a filename (tested). `ai_usage`, `ai_jobs`, `mcp_writes` and the semantic index hold ids and numbers only.
- **Confidential material.** Workers AI runs on Cloudflare; nothing goes to another AI provider. NSW RFS operational information still needs the data-governance decision noted in [KNOWLEDGE_ENGINE.md](KNOWLEDGE_ENGINE.md) before it's entered; excluding a space keeps it out of AI entirely.
- **Not built:** email notifications. Briefings are in-app only, so nothing is ever emailed.

## Models and costs

Configurable per kind of work in **AI and storage settings → Features and models** (owners and admins). Defaults favour cheap models; the capable one is used only for single-piece meeting summaries and detailed briefings.

| Work                                 | Default                                    | Published price (15 Oct 2026)               | Notes                                                                                   |
| ------------------------------------ | ------------------------------------------ | ------------------------------------------- | --------------------------------------------------------------------------------------- |
| Tags, classification                 | `@cf/meta/llama-3.2-3b-instruct`           | 4,625 / 30,475 Neurons per M in/out tokens  | Small; enough for tags                                                                  |
| Extraction (tasks, decisions, dates) | `@cf/google/gemma-4-26b-a4b-it`            | 9,091 / 27,273                              | Mixture-of-experts; chosen for JSON adherence per Neuron. **Accuracy not yet measured** |
| Summaries, briefing recommendations  | `@cf/google/gemma-4-26b-a4b-it`            | as above                                    |                                                                                         |
| Detailed meeting summaries           | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | 26,668 / 204,805                            | Output is expensive; bounded to 1,500 tokens a call                                     |
| Embeddings                           | `@cf/baai/bge-m3` (1,024 dims)             | 1,075 Neurons per M tokens                  | Multilingual, cheapest. Qwen3 0.6B is the same size and price with longer input         |
| Speech to text                       | `@cf/openai/whisper-large-v3-turbo`        | $0.000513 per audio minute (≈ 46.6 Neurons) | Language detection, segment timestamps, **no speaker diarisation**                      |
| Document text                        | Markdown Conversion                        | Not priced per token for text formats       | Images are refused before conversion, so no image model is called                       |

$0.011 per 1,000 Neurons beyond the free daily allocation (10,000 Neurons/day at present). **Rough per-use estimates** at the defaults (estimates, not measurements): analysing a one-page note ≈ 30–60 Neurons; a 30-minute meeting ≈ 1,400 (transcription) + 100–400 (analysis); embedding 1,000 average notes once ≈ 600; a search ≈ 0.02; a recommendations pass ≈ 30. A household's normal use fits inside the free allocation; long recordings are the one thing that can exceed it, which is why they ask first above the confirmation threshold.

These prices come from Cloudflare's pricing page on 15 October 2026 and are stored in `src/shared/intelligence/config.ts` for estimates only. Cloudflare can change prices and the free allocation; check them before relying on the figures.

### Usage and budgets

- Every call records one `ai_usage` row: model, feature, task, units (tokens, audio seconds, documents), Neurons (from the response's token counts when it reports them, `measured = 1`; otherwise our estimate), estimated USD, duration, success, person. Never content.
- Before each call, its **estimate** is checked against the account's daily and monthly budgets, the person's daily budget and the feature's daily budget. Over any → refused (`budget_exceeded`); a background job waits until after midnight UTC without spending an attempt. Defaults: 9,000/day, 270,000/month, 5,000 per person per day, per-feature limits, everything above 1,500 Neurons asks first.
- **Budgets are the portal's safeguard, not a Cloudflare billing cap.** Two simultaneous requests can both pass; Cloudflare bills what it measures. The usage page says so.
- Alerts are recorded once per threshold (50/80/100 % by default) per day/month and for the free allocation, shown on the usage page and logged as `ai_budget_alert`.
- **Circuit breaker:** five unavailable failures in a row within five minutes pause new calls for two minutes.
- **Cost-saving:** unchanged text is never re-embedded (content hash, so a tag edit costs nothing); jobs are deduplicated per subject; captures are deduplicated by request id; recommendations are reused while a briefing's facts are unchanged and only generated when asked or scheduled; context is capped (`maxContextCharacters`); expensive work asks first; everything can be switched off at once.

## Features

### Intelligent Capture → Suggestions Inbox

Text, documents, recordings, Knowledge notes (`?object=` or "Analyse with Intelligence…"), MCP and other applications (`source: "app"`) all become a **capture** (`ai_captures`): its source text, kept apart from the generated summary. A job extracts items in bounded pieces and writes **suggestions** (`ai_suggestions`):

| Kind                                     | Approving does                                                                                                                                                 |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Task, Follow-up                          | `createTask` in the matched project or the Inbox (follow-ups get the `waiting` label), linked to the capture's note                                            |
| New project                              | `createProject` (refused if one with that name exists: edit the tasks to use it)                                                                               |
| Knowledge note, Decision, Meeting record | `createObject` of type page/resource, decision (status decided) or meeting, with provenance; a kept document's file becomes a permanent attachment of the note |
| Tags, Link                               | `updateObject` tags, `addRelation` (only for a Knowledge-object capture; links come from the existing related engine)                                          |
| Fact                                     | Appended to an object, or a new note                                                                                                                           |

- **Projects:** a project named in the source is matched against the person's own writable projects (exact, then similar). If none fits, one "New project" suggestion is proposed (reused across captures while pending) and its tasks depend on it. Nothing is created without approval; another person's project is never matched.
- **Exactly once:** pending → applying under a version → applied with the record's id. The write carries the suggestion id as its retry key (`client_id` on tasks and projects, `source_system/source_id` on Knowledge objects, added to `createObject` for this), so a crash part-way and a retry make one record (tested).
- **Approve selected** applies in a working order (projects, notes, then tasks) and reports each result.
- **Provenance:** created tasks and notes link back to `/portal/intelligence/captures/<id>`, where the source is shown.
- Suggestions already pending or applied from another capture in the last 30 days are skipped.

### Semantic and hybrid search

Chunking follows the note's structure (blocks kept together to ~1,200 characters, long ones split at sentences, title on every chunk, at most 48 chunks). The cron (or "Update the semantic index now") embeds new and changed objects, removes deleted/trashed/excluded ones and re-embeds after a model change; each pass is bounded and resumable, and failures are retried three times. Search runs FTS5 and the vector query, merges by reciprocal rank fusion, then applies the access check and filters (space, type, tag, status, dates). Without Vectorize, AI or budget it returns keyword results and says why. `GET /api/portal/intelligence/search`, `knowledge_semantic_search`.

Evaluation: `test/intelligence-semantic.test.ts` runs a fixed invented corpus with the stand-in embedder (pipeline only: hybrid recall@3 1.0 vs keyword 0.5, exact-record recall 1.0, 0 cross-space leaks, median 3 ms locally). `npm run intelligence:eval` runs the same corpus against real Workers AI on demand (owner's credentials, a few hundred Neurons); it has **not** been run.

### Chief of Staff

`/portal/intelligence/briefing` and `/briefing/weekly`. Facts from Tasks and Knowledge in the person's time zone and chosen sections: today, overdue, deadlines (14 days), priority projects (health not on track), decisions (14 days), follow-ups (`follow-up` label), waiting on others (`waiting` label), household (shared projects), Knowledge updates; weekly adds completed work, projects at risk, projects without activity for 14 days, milestones and housekeeping (unsorted Inbox, reviews due). Each item has its id and link. For people with Daly Calendar, a **Calendar and leave** section adds today's or this week's events, overlapping commitments, birthdays and anniversaries, upcoming leave, school holidays without leave, and failing subscriptions. These come from worker/calendar/chief.ts, are deterministic, and say "Busy" or "Private event" for private and sensitive events. The page states what was read and what never was (email, finances, external services, and calendar too when that section is off or the person can't use Calendar).

Recommendations are optional, labelled "AI suggestions, not facts", may only cite the briefing's own ids (others are dropped), are generated on request or at the scheduled time, and are reused until the facts' fingerprint changes. Changes since the previous briefing are counted. Preferences (sections, times, weekly day, concise/detailed, personal or all, recommendations, in-app notice, pause, excluded spaces) live in Settings → My briefings. Scheduled preparation queues one job per person, kind and day once their time has passed, only for people who saved preferences and haven't paused, and only with "Scheduled intelligence" on.

### Meetings and documents

- **Upload:** chunked into 6 MiB parts (base64 JSON, the portal API's only body type) assembled with an R2 multipart upload, with progress. The first part's bytes must match the claimed format. Limits are configurable (defaults: documents 10 MB/60 pages, recordings 50 MB/90 minutes).
- **Recordings:** WAV (PCM) is cut exactly into ≤ 4-minute pieces with their own headers; MP3 at frame boundaries (duration estimated from the bitrate); M4A, OGG, FLAC and WebM are sent whole up to 8 MB and otherwise refused with "convert to MP3" (no demuxer in the Worker; we don't claim to cut them). Each piece's text is stored as it completes, so a failure resumes (tested). Segment timestamps are offset per piece. Language is detected or chosen. **No speaker attribution**, and the analysis prompt forbids naming anyone the transcript doesn't. A recording estimated above the confirmation threshold waits for "Go ahead". Whether Workers AI decodes each container is Cloudflare's behaviour and isn't verified here.
- **Documents:** text/Markdown/CSV are decoded locally; PDFs are refused if encrypted or over the page limit (counted from page objects; compressed object streams can hide them, so size is the backstop); Office files have their ZIP directory read first and decompression bombs are refused (size, ratio, entry count, ZIP64). Conversion is Markdown Conversion with a timeout. Nothing is executed or rendered. There is no virus scanner: files are private, downloaded only as `attachment` with `nosniff` and a sandbox CSP, never served inline or publicly.
- Outputs: a meeting record (generated summary and source transcript under separate headings), decisions, tasks with owners only where named; a document becomes a resource note that keeps the file permanently.

### Attachments, retention and storage

`attachments` is shared infrastructure, not a Files app. Retention (Settings → Storage shows sizes, your files and what's due):

| Kind                              | Kept                                                                                                                  |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Permanent (Knowledge attachments) | Until someone deletes it on purpose (typed `DELETE`). `keep = 1`; the schema refuses `keep` on anything not permanent |
| Referenced (task attachments)     | While the task exists, then 30 days (configurable), recoverable until then                                            |
| Temporary (processing uploads)    | 7 days after processing (0–30), failed ones 14 (1–30) for investigation                                               |
| Abandoned uploads                 | 24 hours                                                                                                              |

The cron's retention pass runs even with Intelligence off and calls no model. Captures go after `captureDays` (365) once nothing is pending; briefings after 90 days; finished jobs after 90; usage after 400.

## MCP

Ten tools (46 in total), same rules as everything else in [MCP.md](MCP.md): Access token verified twice, strict schemas with no identity fields, per-person rate limits, the request-id ledger (`mcp_writes`, rebuilt in `0021` to record `ai_capture` and `ai_suggestion` outcomes), content-free logs.

| Tool                                 | Mode  | What                                                                                             |
| ------------------------------------ | ----- | ------------------------------------------------------------------------------------------------ |
| `knowledge_semantic_search`          | read  | Hybrid search; says when it fell back to keywords                                                |
| `knowledge_find_related`             | read  | Related notes with reasons and possible duplicates; nothing linked                               |
| `intelligence_get_daily_briefing`    | read  | Facts plus already-prepared recommendations; never runs a model                                  |
| `intelligence_get_weekly_review`     | read  | As above, for a week                                                                             |
| `intelligence_list_suggestions`      | read  | The Inbox                                                                                        |
| `intelligence_get_processing_status` | read  | Availability and capture/job states                                                              |
| `meetings_get_transcript`            | read  | A transcript, capped; speakers not identified                                                    |
| `intelligence_capture_text`          | write | Queue text for analysis. Creates suggestions only                                                |
| `intelligence_request_analysis`      | write | Analyse a readable, non-excluded Knowledge object                                                |
| `intelligence_approve_suggestion`    | write | Apply one suggestion the person explicitly approved. Same path as the Approve button; idempotent |

Not exposed: dismissing, editing, bulk approval, deleting files or captures, settings, exclusions, starting arbitrary jobs. Approval can't be bypassed: capture tools only create pending suggestions, and the only way to apply one is the approve tool or the portal, both through `approveSuggestion`.

## API

All under `/api/portal/intelligence`, requiring Access and `intelligence.use`; writes need the portal's same-origin JSON rules.

| Method and path                                                                                                                                                                        | What                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `GET /status`                                                                                                                                                                          | Switches, bindings, availability, circuit, index counts       |
| `GET/PUT /settings`                                                                                                                                                                    | Account document (`PUT` owners and admins, with `version`)    |
| `GET/PUT /preferences`                                                                                                                                                                 | The caller's briefing preferences (with `version`)            |
| `POST /exclusions`                                                                                                                                                                     | `{ spaceId, objectId?, excluded }` (space editors)            |
| `GET /usage`, `GET /storage`                                                                                                                                                           | Usage summary; storage totals and the caller's files          |
| `GET /search`, `GET /objects/:id/related`                                                                                                                                              | Hybrid search; related by meaning                             |
| `POST /semantic/sync`, `POST /semantic/reindex`                                                                                                                                        | One index pass (owners/admins); rebuild a space (space owner) |
| `POST /captures`, `GET /captures`, `GET /captures/:id`, `GET /captures/:id/transcript`, `POST /captures/:id/cancel`                                                                    | Capture lifecycle                                             |
| `GET /suggestions`, `PATCH /suggestions/:id`, `POST /suggestions/:id/approve`, `POST /suggestions/:id/dismiss`, `POST /suggestions/approve`                                            | The Inbox                                                     |
| `GET /jobs/:id`, `POST /jobs/:id/run                                                                                                                                                   | retry                                                         | approve | cancel` | The caller's jobs |
| `POST /attachments`, `POST /attachments/:id/parts/:n`, `POST /attachments/:id/complete`, `GET /attachments/:id/download`, `POST /attachments/:id/keep`, `POST /attachments/:id/delete` | Files                                                         |
| `GET /briefings/:kind`, `POST /briefings/:kind/recommend`                                                                                                                              | `daily` or `weekly`                                           |

## Reliability

- Work never blocks a page: captures return at once; jobs run in a `waitUntil` nudge (≤ 25 s), the cron (≤ ~6.5 min a run) and, while a capture page is open, bounded `run` calls.
- Jobs: one live job per subject, token claims (stale after 5 minutes), steps saved as they finish, backoff (30 s, 5 min, 30 min, 2 h), `failed` after three attempts or a permanent error, retry and cancel by the owner, cost approval. A job runs as its creator with their **current** role and memberships; someone who lost access gets a failed job.
- Failure isolation: every cron step is caught and logged; the blog sync, wedding messages and task reminders are separate `waitUntil`s. Public website, RSVP and Wedding Planner never import this code. With AI or Vectorize down, Tasks, Knowledge and keyword search are unaffected (tested), and the master switch stops all AI work at once.

## Backup and recovery

- **D1:** all `0021` tables are ordinary tables, exported by `npm run db:backup` and checked by `npm run test:backup`, which now populates every Intelligence table (including a suggestion outcome in the rebuilt MCP ledger) and verifies the restore (passed 18 October 2026, locally). `db-verify` checks JSON validity, that kept files are permanent and unscheduled, Knowledge attachments still pointing at objects, and stuck jobs.
- **Vectorize is derived.** After restoring D1 elsewhere, delete `ai_semantic_index` (or point `VECTORS` at an empty index) and the cron re-embeds everything from Knowledge (tested). Changing the embedding model triggers the same.
- **R2 Knowledge attachments:** `npm run backup:r2 -- --env production [--encrypt]` downloads every permanent or kept file to `backups/r2-<env>-<time>/` with a manifest (size and SHA-256), verifies each against D1's size, optionally seals each with AES-256-GCM under `BACKUP_PASSPHRASE` (scrypt), and reads everything back to verify. `--verify <dir>` re-checks a backup (a wrong passphrase or altered file fails). Tested locally with an invented file.
- **Off-Cloudflare copies:** the backup lands on the owner's computer, outside Cloudflare. **Not automated:** there's no approved off-Cloudflare storage or credential for an unattended job, and adding one would be a new service. The remaining step is the owner's: run `db:backup` and `backup:r2 --encrypt` together on a schedule (e.g. weekly) and copy the folders to their own encrypted storage. Retention deletion never touches permanent or kept files, so a backup can't be the only copy of something the portal deleted automatically.
- D1 Time Travel remains the first recovery option for recent mistakes; it isn't the only one.

## Activation

Nothing here is done by this pull request. In order, each step with the owner's approval:

1. **Review and merge** (merging `main` runs the deploy workflow, which applies `0021` and deploys). `0021` is additive except the `mcp_writes` rebuild, which copies every row, keeps columns and indexes, and leaves the previous Worker working. Take `npm run db:backup -- --env production` first.
2. **Create the Vectorize index** (production and staging separately):
    ```bash
    npx wrangler vectorize create daly-knowledge --dimensions=1024 --metric=cosine
    npx wrangler vectorize create daly-knowledge-staging --dimensions=1024 --metric=cosine
    ```
3. **Add the bindings** to `wrangler.jsonc` (top level, and in `env.staging` with the staging index) in a small PR:
    ```jsonc
    "ai": { "binding": "AI" },
    "vectorize": [{ "binding": "VECTORS", "index_name": "daly-knowledge" }],
    ```
    Tests and browser tests stay offline with them present (`remoteBindings: false`, `wrangler dev --local`; verified on this branch with no Cloudflare login). `npm run dev` would use real Workers AI with the developer's login; put `AI_PROVIDER=mock` in `.dev.vars` to stay offline. `node scripts/check-config.mjs` reports the bindings and refuses `AI_PROVIDER` in a deployed config.
4. **Optional AI Gateway:** create a gateway with log collection off, then `AI_GATEWAY_ID` as a var.
5. **Switch on gradually** in Intelligence → AI and storage settings: Intelligence, then Capture; check usage; then Documents, Meetings, Semantic search (the cron then indexes up to `maxBatch` objects every 15 minutes), Recommendations and Scheduled. Run `npm run intelligence:eval` first if you want real-model numbers.
6. **MCP:** deploy the gateway by hand as in [MCP.md](MCP.md#releasing-project-management) (`npm run mcp:deploy:dry-run`, then `npx wrangler deploy --config mcp/wrangler.jsonc --env production`). Before the portal is deployed the new tools answer `unknown_tool`; with Intelligence off they answer that it's off.

**Rollback:** switch Intelligence off (instant, no deploy). Remove the bindings to make AI impossible. Code: `npx wrangler rollback <version> --env=""`; leave `0021` in place (the previous Worker ignores the new tables and only writes ledger entity types the rebuilt table accepts). Gateway: roll back `dalyhub-mcp` to the 36-tool version. Undo a wrongly approved suggestion by archiving or trashing what it created, as for anything else.

## Tests

| File                                 | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/intelligence.test.ts`          | Defaults off, binding detection, settings permissions/versions/validation, budgets and usage without content, malformed output, retries and circuit breaker, fences, log content, grounding (invented evidence, names, dates), capture → suggestions, project matching and isolation, approval order and exactly-once (including a crashed approval), edits re-checked against access, privacy between people, duplicates, dismissal, Knowledge-object analysis and exclusions, viewers, cost approval, request ids, cancellation, a runner whose person lost access, Tasks/Knowledge with AI off |
| `test/intelligence-semantic.test.ts` | Chunking, incremental index (hash, tags, trash, exclusion, model change), budget/unavailable stops, hybrid search, a leaking index, membership removal, deleted objects, Vectorize failure fallback, related and duplicates, the evaluation corpus, rebuild from empty                                                                                                                                                                                                                                                                                                                            |
| `test/intelligence-files.test.ts`    | Byte checks, PDF and ZIP-bomb checks, document capture and permanent keeping, page limits, prompt injection in a document, WAV/MP3 parsing, a resumed multi-piece transcription, unsplittable formats, cost approval for audio, retention never touching kept files, task grace periods, private downloads and public routes, storage summary                                                                                                                                                                                                                                                     |
| `test/intelligence-briefing.test.ts` | Facts and links, "not checked", recommendations limited to the briefing's ids and reused while unchanged, scope and exclusions, the weekly review, scheduled preparation once a day and paused, MCP capture/replay/approval/isolation/identity fields, MCP search fallback                                                                                                                                                                                                                                                                                                                        |
| `e2e/intelligence.spec.ts`           | Every page on desktop and Pixel 7: no errors, no horizontal overflow, no serious axe issues; capture → review → approve into Tasks; briefing labels                                                                                                                                                                                                                                                                                                                                                                                                                                               |

## What has and hasn't been validated

|                                                 |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Implemented and tested locally**              | Everything above, with deterministic stand-ins for Workers AI and Vectorize, a local D1 and R2, in workerd and Chromium                                                                                                                                                                                                                                                                                                                                                                        |
| **Implemented, needs Cloudflare configuration** | Workers AI and Vectorize bindings, the Vectorize index, optional AI Gateway, applying `0021`, deploying the gateway                                                                                                                                                                                                                                                                                                                                                                            |
| **Not validated against live providers**        | Real model accuracy (extraction quality, JSON reliability, embedding relevance, transcription quality), Whisper's acceptance of each audio container and request size, Markdown Conversion output and cost for each document type, real Neuron consumption vs our estimates, real latency                                                                                                                                                                                                      |
| **Deferred**                                    | Email notifications for briefings (in-app only; no email without owner approval); Cloudflare Queues (the D1 queue suffices now); speaker diarisation (not offered by the chosen model); cutting M4A/OGG/FLAC/WebM (needs a demuxer); OCR of scanned PDFs; automated off-Cloudflare backups (needs an approved destination); attachments inside the Knowledge editor and Capacities import (Knowledge Milestone 4); calendar, email and banking integrations (none exist, and briefings say so) |
