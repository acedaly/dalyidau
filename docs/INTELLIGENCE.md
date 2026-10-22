# Daly Intelligence

The shared AI layer of Daly Portal at `/portal/intelligence`: the Chief of Staff **daily briefing and weekly review** (built from Daly Calendar), and the platform other applications use for AI: feature switches, models, budgets, usage and the one provider every model call goes through. Home & Assets and the Intelligence Centre call it; nothing is duplicated per application.

**The rule it's built on: facts come from the portal's records, and AI only explains them.** A briefing's facts are worked out without a model. Recommendations are optional, labelled "AI suggestions, not facts", and may only cite the briefing's own records. Nothing a model returns is saved as a record without a person.

**Status:** everything is off by default. The `AI` binding is declared in `wrangler.jsonc`, but every feature switch is off, so no model is called until an owner switches Intelligence on. Tests and CI only ever use the deterministic stand-ins in `worker/intelligence/bindings.ts`.

> **Retired:** Intelligent Capture, the Suggestions Inbox, meeting transcription, document capture into Knowledge, shared attachments and semantic (Vectorize) search were removed with Daly Knowledge and Daly Tasks, because every capture and suggestion targeted one of them. Their pages and APIs answer 410, their MCP tools are refused with `"retired"`, the `VECTORS` binding is gone, and their tables (`ai_captures`, `ai_suggestions`, `ai_transcripts`, `ai_semantic_index`, `attachments` and others) are kept untouched until the owner approves a cleanup. See [DECOMMISSION_KNOWLEDGE_TASKS.md](DECOMMISSION_KNOWLEDGE_TASKS.md).

---

## Architecture

```
src/shared/intelligence/
  config.ts        Feature switches, model registry and prices, budgets, limits, retention, preferences (Worker and browser)
  types.ts         Briefing and API shapes
worker/intelligence/
  bindings.ts      The narrow Workers AI interface used, plus deterministic stand-ins for tests/dev
  provider.ts      The only way to call a model: switches, circuit breaker, budget, timeout, usage, validation
  usage.ts         ai_usage, budgets (checked before each call), alerts, the circuit breaker
  jobs.ts          Durable D1 job queue (briefing preparation only): dedupe, claims, bounded steps, backoff
  runner.ts        Cron pass: retention, alerts, scheduled briefings, jobs
  briefings.ts     Daily briefing and weekly review: facts, optional recommendations, scheduling
  prompts.ts       Prompts and the untrusted-content fence
  settings.ts      Account settings, preferences, binding detection, availability
  api.ts pages.ts  /api/portal/intelligence/* and page loaders
worker/calendar/chief.ts     The Calendar and leave facts briefings are built from
worker/mcp/intelligence.ts   Two MCP tools (below)
src/portal/intelligence/     Overview, Daily briefing, Weekly review, AI settings
```

The application is registered in `src/shared/portal/applications.ts` (`intelligence`, permission `intelligence.use`, which owners and admins have; wedding editors and viewers don't).

### Cloudflare services and why

| Need                        | Used                                                     | Why not something else                                                                                                                           |
| --------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Inference                   | **Workers AI** (`AI` binding)                            | On the existing Workers Paid plan, 10,000 Neurons a day included today, no keys to store. No external provider is used                           |
| Document text               | **Workers AI Markdown Conversion** (`env.AI.toMarkdown`) | PDF and Office parsing for Home & Assets capture without bundling a parser into the Worker                                                       |
| Background work             | **D1 job table + the existing 15-minute cron**           | Cloudflare Queues would need a new binding and resource for a few briefings a day. The job table gives dedupe, claims and retries, and is tested |
| State, audit, configuration | **D1** (`0021`)                                          | Authoritative and backed up with everything else                                                                                                 |
| Observability (optional)    | **AI Gateway** (`AI_GATEWAY_ID` var)                     | Off by default. When set, calls go through the gateway with `collectLog: false` requested; **turn log collection off on the gateway itself** too |

## Privacy and permissions

- **Identity** is always the verified Access identity (browser) or the re-verified Access token (MCP). No API or tool takes an owner, email or user id from its input.
- **Ownership.** Briefings, preferences and jobs belong to one person and are always read joined to their email. Anyone else gets 404, whatever their portal role.
- **Calendar facts** are read through Calendar's own access (`worker/calendar/chief.ts`): calendars the person can't see aren't there, others' private events are "Busy" and sensitive events "Private event".
- **Prompt injection.** Everything from records and other applications is fenced as untrusted data (`prompts.ts`: markers the content can't forge, a system rule never to follow it). Whatever a model returns is schema-validated, then **grounded**: every reference must be one of the facts' own ids, or it's dropped; ids are never taken from a model.
- **Logs** hold events, codes, models and counts: never a person, a prompt or a record's text (tested). `ai_usage` and `ai_jobs` hold ids and numbers only.
- **Confidential material.** Workers AI runs on Cloudflare; nothing goes to another AI provider.
- **Not built:** email notifications. Briefings are in-app only, so nothing is ever emailed.

## Models and costs

Configurable per kind of work in **AI settings → Features and models** (owners and admins). Defaults favour cheap models.

| Work                                 | Default                                    | Published price (15 Oct 2026)              | Notes                                                               |
| ------------------------------------ | ------------------------------------------ | ------------------------------------------ | ------------------------------------------------------------------- |
| Extraction (Home & Assets documents) | `@cf/google/gemma-4-26b-a4b-it`            | 9,091 / 27,273 Neurons per M in/out tokens | Chosen for JSON adherence per Neuron. **Accuracy not yet measured** |
| Summaries, briefing recommendations  | `@cf/google/gemma-4-26b-a4b-it`            | as above                                   |                                                                     |
| Detailed briefings                   | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | 26,668 / 204,805                           | Output is expensive; kept bounded                                   |
| Document text                        | Markdown Conversion                        | Not priced per token for text formats      | Images are refused before conversion                                |

$0.011 per 1,000 Neurons beyond the free daily allocation (10,000 Neurons/day at present). A recommendations pass is roughly 30 Neurons at the defaults (an estimate, not a measurement), so a household's normal use fits inside the free allocation.

These prices come from Cloudflare's pricing page on 15 October 2026 and are stored in `src/shared/intelligence/config.ts` for estimates only. Cloudflare can change prices and the free allocation; check them before relying on the figures.

### Usage and budgets

- Every call records one `ai_usage` row: model, feature, task, units, Neurons (from the response's token counts when it reports them, `measured = 1`; otherwise our estimate), estimated USD, duration, success, person. Never content.
- Before each call, its **estimate** is checked against the account's daily and monthly budgets, the person's daily budget and the feature's daily budget (`documents`, `briefings`). Over any → refused (`budget_exceeded`); a background job waits until after midnight UTC without spending an attempt. Defaults: 9,000/day, 270,000/month, 5,000 per person per day, 1,500 per feature per day.
- **Budgets are the portal's safeguard, not a Cloudflare billing cap.** Two simultaneous requests can both pass; Cloudflare bills what it measures. The usage page says so.
- Alerts are recorded once per threshold (50/80/100 % by default) per day/month and for the free allocation, shown on the usage page and logged as `ai_budget_alert`.
- **Circuit breaker:** five unavailable failures in a row within five minutes pause new calls for two minutes.
- **Cost-saving:** recommendations are reused while a briefing's facts are unchanged and only generated when asked or scheduled; scheduled jobs are deduplicated per person, kind and day; everything can be switched off at once.

## Features

The switches (`ai_config`, AI settings → Features and models): **Intelligence** (the master switch), **Document intelligence** (Home & Assets document suggestions, with `assets.ai` on too), **AI briefing recommendations** and **Scheduled intelligence**. All default off. Settings saved before the retirement may hold switches and preferences for capture, meetings, semantic search or excluded spaces; they're read past and never saved again.

### Chief of Staff briefings

`/portal/intelligence/briefing` and `/briefing/weekly`. Facts come from Daly Calendar in the person's time zone, from `worker/calendar/chief.ts`: today's or this week's events, overlapping commitments, birthdays and anniversaries, upcoming leave, school holidays without leave, and failing subscriptions. They're deterministic, each has its id and a link, and private and sensitive events are "Busy" or "Private event". The page states what was read and what never was (email, finances, external services, and the calendar too when that section is off or the person can't use Calendar).

Recommendations are optional, labelled "AI suggestions, not facts", may only cite the briefing's own ids (others are dropped), are generated on request or at the scheduled time, and are reused until the facts' fingerprint changes. Changes since the previous briefing are counted. Preferences (sections: Calendar and leave, changes since last briefing, suggested next actions; daily time, weekly day and time, concise or detailed, recommendations, in-app notice, pause) live in **AI settings → My briefings**. Scheduled preparation queues one `briefing.prepare` job per person, kind and day once their time has passed, only for people who saved preferences and haven't paused, and only with "Scheduled intelligence" on.

[Today](DAILY_PLANNER.md#today) shows its own deterministic Chief of Staff facts and next actions (no model). Its **Explain my day** button asks for this daily briefing's recommendations (`POST /briefings/daily/recommend`), so the same rules hold: off unless Intelligence is on, within budget, and every reference must be one of the facts.

### Intelligence Centre

The [Intelligence Centre](INTELLIGENCE_CENTRE.md#ai-integration) uses the same provider for optional briefing interpretations (budget feature `briefings`, recommendations switch). Only fenced fact sentences from public records are sent, never a watch area's name or location, and every sentence must be grounded in the facts it cites.

### Home & Assets capture

Home & Assets can ask for receipt, photo and policy suggestions through this provider (the "documents" budget), only when its own `assets.ai` switch and Intelligence's documents feature are both on. Text is fenced, output schema-checked and grounded in the document's text, and nothing is saved without a person. Its files are in `asset_files`. See [HOME_ASSETS.md](HOME_ASSETS.md#capture-and-ai).

### Retention

The cron's retention pass runs even with Intelligence off and calls no model: briefings go after 90 days (configurable), finished briefing jobs after 90, usage rows after 400. Captures, suggestions, transcripts, attachments and jobs of other kinds from before the retirement are never deleted or claimed again: they wait for the owner's approved cleanup.

## MCP

Two read-only tools, under the same rules as everything else in [MCP.md](MCP.md): Access token verified twice, strict schemas with no identity fields, per-person rate limits, content-free logs.

| Tool                              | Mode | What                                                            |
| --------------------------------- | ---- | --------------------------------------------------------------- |
| `intelligence_get_daily_briefing` | read | Facts plus already-prepared recommendations; never runs a model |
| `intelligence_get_weekly_review`  | read | As above, for a week                                            |

The retired capture, suggestion, search and transcript tools (`intelligence_list_suggestions`, `intelligence_get_processing_status`, `intelligence_capture_text`, `intelligence_request_analysis`, `intelligence_approve_suggestion`, `meetings_get_transcript`, and the `knowledge_*` search tools) are refused with `"retired"`.

## API

All under `/api/portal/intelligence`, requiring Access and `intelligence.use`; writes need the portal's same-origin JSON rules.

| Method and path                                           | What                                                       |
| --------------------------------------------------------- | ---------------------------------------------------------- |
| `GET /status`                                             | Switches, bindings, availability, circuit                  |
| `GET/PUT /settings`                                       | Account document (`PUT` owners and admins, with `version`) |
| `GET/PUT /preferences`                                    | The caller's briefing preferences (with `version`)         |
| `GET /usage`                                              | Usage summary                                              |
| `GET /briefings/:kind`, `POST /briefings/:kind/recommend` | `daily` or `weekly`                                        |

`/captures`, `/suggestions`, `/search`, `/objects`, `/semantic`, `/jobs`, `/attachments`, `/exclusions` and `/storage` answer 410 (`worker/portal/retired.ts`), as do the `/portal/intelligence/inbox`, `/capture`, `/captures` and `/meetings` pages.

## Reliability

- Opening a briefing never waits on a model: facts cost a handful of D1 reads, and recommendations are only generated when asked for or scheduled.
- Jobs: one live job per subject, token claims (stale after 5 minutes), backoff, `failed` after three attempts or a permanent error. A job runs as its creator with their **current** role; someone who lost access gets a failed job.
- Failure isolation: every cron step is caught and logged; the blog sync and wedding messages are separate `waitUntil`s. The public website, RSVP and Wedding Planner never import this code, and the master switch stops all AI work at once.

## Backup and recovery

- **D1:** Intelligence's tables are ordinary tables, exported by `npm run db:backup` and checked by `npm run test:backup`. The retired tables are still exported until the cleanup.
- **R2:** `npm run backup:r2 -- --env production [--encrypt]` saves the retired Knowledge attachments under `private/attachments/` (kept until the cleanup) along with Home & Assets' files. See [DECOMMISSION_KNOWLEDGE_TASKS.md](DECOMMISSION_KNOWLEDGE_TASKS.md#export-and-verified-backup).
- D1 Time Travel remains the first recovery option for recent mistakes.

## Activation

Each step with the owner's approval:

1. **Optional AI Gateway:** create a gateway with log collection off, then `AI_GATEWAY_ID` as a var.
2. **Switch on gradually** in Intelligence → AI settings → Features and models: Intelligence, then AI briefing recommendations; check usage; then Scheduled intelligence, and Document intelligence when Home & Assets' `assets.ai` is wanted.
3. **MCP:** the briefing tools are in gateway 3.0.0, deployed by hand after the portal ([MCP_CUTOVER.md](MCP_CUTOVER.md)). With Intelligence off they answer that it's off.

`npm run dev` would use real Workers AI with the developer's login; put `AI_PROVIDER=mock` in `.dev.vars` to stay offline. `node scripts/check-config.mjs` refuses `AI_PROVIDER` in a deployed config.

**Rollback:** switch Intelligence off (instant, no deploy). Code: `npx wrangler rollback <version> --env=""`; `0021` stays in place.

## Tests

| File                        | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/intelligence.test.ts` | Defaults off and off without the binding, AI Gateway detection, settings permissions, versions and validation, settings saved before the retirement, wedding roles refused, usage without content and budgets, malformed output, the circuit breaker, fences, briefings (facts and links, "not checked", grounded and reused recommendations, sections, scheduled preparation), retired jobs and routes (410), MCP briefings and retired tools |
| `e2e/intelligence.spec.ts`  | Every page on desktop and Pixel 7: no errors, no horizontal overflow, no serious axe issues; retired pages and APIs; the briefing separates facts from AI suggestions                                                                                                                                                                                                                                                                          |

## What has and hasn't been validated

|                                          |                                                                                                                                                                        |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Implemented and tested locally**       | Everything above, with deterministic stand-ins for Workers AI, a local D1 and R2, in workerd and Chromium                                                              |
| **Not validated against live providers** | Real model accuracy and JSON reliability, Markdown Conversion output and cost for each document type, real Neuron consumption, real latency                            |
| **Deferred**                             | Email notifications for briefings (in-app only; no email without owner approval); Cloudflare Queues; email and banking integrations (none exist, and briefings say so) |
