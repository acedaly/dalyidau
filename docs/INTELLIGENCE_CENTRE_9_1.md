# Intelligence Centre 9.1: Advanced Intelligence Centre and Wallboard 2.0

Milestone 9.1 builds on the [Intelligence Centre](INTELLIGENCE_CENTRE.md) (Milestone 9). It isn't a rewrite: it uses the same sources, ingestion engine, records, watch areas, alerts, correlation engine, map and display credentials. Sources are described in [INTELLIGENCE_SOURCES.md](INTELLIGENCE_SOURCES.md).

> **Not an official warning service.** Everything here is public information collected for awareness. It may be delayed or incomplete.
>
> - Official levels are shown exactly as each provider published them.
> - Derived analysis (changes, correlations, summaries, rule matches, AI narrative) is labelled as derived and never presented as an agency's assessment.
> - Every screen points to official warnings and Triple Zero (000).

**Status: built and tested, off by default, not deployed.**

- Migration `0027_intelligence_centre_9_1.sql` hasn't been applied anywhere remote.
- The four new switches default off.
- No basemap archive has been uploaded.
- The MCP gateway (2.8.0) hasn't been deployed.

What was and wasn't validated is in [Validation](#validation).

> **Since 9.1:** Daly Tasks and Daly Knowledge are retired ([DECOMMISSION_KNOWLEDGE_TASKS.md](DECOMMISSION_KNOWLEDGE_TASKS.md)). "Create task" on a record or rule match and "Save to Knowledge" on a record, briefing, timeline or report are gone, and their routes answer 410. Scheduled reports that had "save to Knowledge" on still run; the setting is ignored. The leftover columns (`ic_rule_matches.task_id`, `ic_reports.knowledge_object_id`, `ic_report_schedules.save_to_knowledge`) are kept. The MCP gateway is now 3.0.0, with 66 tools (28 of them the Centre's).

## Contents

- [What's new](#whats-new)
- [Feature switches](#feature-switches)
- [Data model (0027)](#data-model-0027)
- [History: versions, timelines and replay](#history)
- [What's changed](#whats-changed)
- [Correlation](#correlation)
- [Monitoring rules](#monitoring-rules)
- [Situation reports](#situation-reports)
- [Assistant](#assistant)
- [Analytics and source health](#analytics-and-source-health)
- [Wallboard 2.0](#wallboard-20)
- [Detailed basemap](#detailed-basemap)
- [Today and Calendar](#today-and-calendar)
- [MCP](#mcp)
- [API](#api)
- [Security and privacy](#security-and-privacy)
- [Retention](#retention)
- [Performance and costs](#performance-and-costs)
- [Activation](#activation)
- [Rollback](#rollback)
- [Validation](#validation)
- [Limitations and deferred work](#limitations-and-deferred-work)

## What's new

| Area                                                                           | Where                            | Code                                                                                                                                            |
| ------------------------------------------------------------------------------ | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Wallboard 2.0: five presets, custom widget grids, rotation, themes, renewal    | Wallboards, `/display`           | `src/shared/centre/wallboard.ts`, `worker/centre/display.ts`, `worker/centre/wallboard.ts`, `src/display/*`, `centre-wallboard-editor-page.tsx` |
| Detailed basemap: OpenStreetMap vector tiles served from this site's R2 bucket | Every Centre map                 | `worker/centre/basemap.ts`, `src/portal/centre/map/basemap-style.ts`, `public/centre/fonts/`, `scripts/centre-basemap.mjs`                      |
| Versioned history, incident and situation timelines, historical replay         | Record pages, Timelines, Replay  | `worker/centre/history.ts`, `worker/centre/ingest.ts`                                                                                           |
| What's changed: one feed of meaningful developments across sources             | What's changed                   | `changeFeed` in `history.ts`, `src/shared/centre/history.ts`                                                                                    |
| More correlation rules, explicit links, evidence factors, caps                 | Correlations                     | `worker/centre/correlate.ts`                                                                                                                    |
| Monitoring rules: deterministic conditions in stated units                     | Monitoring rules                 | `worker/centre/rules.ts`, `src/shared/centre/rules.ts`                                                                                          |
| Situation reports: on demand, historical and scheduled                         | Reports                          | `worker/centre/reports.ts`, `src/shared/centre/reports.ts`                                                                                      |
| Assistant: questions answered from stored records through fixed tools          | Assistant                        | `worker/centre/assistant.ts`, `src/shared/centre/assistant.ts`                                                                                  |
| Analytics and source reliability                                               | Analytics, Sources               | `centreAnalytics`, `sourceReliability` in `history.ts`                                                                                          |
| Today and Calendar integrations                                                | Today, record pages, Watch areas | `worker/centre/actions.ts`                                                                                                                      |
| Sixteen MCP tools (28 for the Centre)                                          | Gateway 2.8.0 (now 3.0.0)        | `worker/mcp/centre-history.ts`, `mcp/src/portal-tools.ts`                                                                                       |

The Centre's navigation has three groups:

- **Situation:** Overview, Live map, What's changed, Incidents and warnings, Hazards.
- **Analysis:** History, Timelines, Replay, Analytics, Correlations, Briefings, Reports, Assistant.
- **Manage:** Watch areas, Monitoring rules, Wallboards, Sources, Settings.

## Feature switches

These are new and all off by default. Owners and admins set them in Portal settings → Features → Intelligence Centre (`src/shared/portal/flags.ts`).

| Switch                          | Effect                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `intelligence_centre.history`   | Each collection also stores a version of every record it writes, for timelines and replay. Records already stored when it's switched on get a **baseline** version dated then; their earlier states were never kept. While off, nothing new is versioned. Timelines then fall back to detected changes, and replay covers only the periods that were recorded. |
| `intelligence_centre.rules`     | Evaluates everyone's monitoring rules after each collection and notifies matches. Rules can be created and tested against history while it's off; nothing is evaluated on a schedule.                                                                                                                                                                          |
| `intelligence_centre.reports`   | Runs scheduled reports. On-demand reports always work.                                                                                                                                                                                                                                                                                                         |
| `intelligence_centre.assistant` | Lets the assistant use Daly Intelligence (a model) to understand questions and phrase grounded answers. It also needs Daly Intelligence switched on. While off, the assistant still answers, from built-in question types, without any model.                                                                                                                  |

These are unchanged and still needed: `intelligence_centre.ingestion` (collection), `intelligence_centre.wallboard` (screens) and `intelligence_centre.alerts.email` (emails, including rule and report notifications).

The detailed basemap has no switch. It shows when an archive is installed and Settings → Basemap is **Detailed**, which is the default for settings never saved. The outline remains the fallback.

## Data model (0027)

The migration is additive, with one exception: `mcp_writes` is rebuilt (every row copied) so it accepts the `centre_rule`, `centre_report` and `centre_report_schedule` outcomes. Milestones 0020–0026 used the same pattern. Existing tables gain only nullable or defaulted columns (`ALTER TABLE ADD COLUMN`), so a populated database migrates in place. The previous Worker never reads the new tables or columns.

| Table or column                                                                                     | Contents                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ic_record_versions`                                                                                | One row per stored state of a record:<br>• when it became current (`valid_from`) and when a later collection replaced it (`valid_to`)<br>• the change that produced it, and a baseline flag<br>• every displayed field (descriptions are capped at 2,000 characters)<br>• `active` and `missing`.<br>Only sources whose terms allow history are versioned. Observations and detections are kept as series instead. |
| `ic_geometries`                                                                                     | Published areas, stored once per distinct shape (versions refer to them by hash).                                                                                                                                                                                                                                                                                                                                  |
| `ic_fetch_runs.delay_s`                                                                             | Seconds from the provider's publication time to collection.                                                                                                                                                                                                                                                                                                                                                        |
| `ic_source_daily`                                                                                   | Per source per UTC day: attempts, successes, unchanged, errors, refusals, timing, bytes, records, delay totals, first and last success, and the longest gap between successes.                                                                                                                                                                                                                                     |
| `ic_rules`, `ic_rule_matches`                                                                       | Each person's rules, and why each matched. A unique (rule, subject) key makes evaluation idempotent.                                                                                                                                                                                                                                                                                                               |
| `ic_reports`, `ic_report_schedules`                                                                 | Report metadata (the full report is in R2 at `private/centre/reports/<id>.json`) and schedules.                                                                                                                                                                                                                                                                                                                    |
| `ic_wallboard_views`                                                                                | A board's views: preset, name, position and widgets (JSON, validated).                                                                                                                                                                                                                                                                                                                                             |
| `ic_display_tokens` + `renewable`, `lifetime_days`, `previous_hash`, `previous_until`, `renewed_at` | Renewable display credentials, with a short overlap.                                                                                                                                                                                                                                                                                                                                                               |
| `ic_event_links`                                                                                    | One of a person's calendar events linked to one of their watch areas (ids only).                                                                                                                                                                                                                                                                                                                                   |
| `ic_cache`                                                                                          | Computed analytics over public records (no personal data), reused until expiry.                                                                                                                                                                                                                                                                                                                                    |

New indexes: `ic_changes (source_id, at)` and `(kind, at)`, plus indexes on every new table for its ownership, time and lookup queries.

`npm run test:backup` populates and restores every new table. `npm run db:verify` adds three consistency checks:

- one open version per record;
- valid JSON;
- rules, matches and links belonging to their watch areas' owners;
- views belonging to boards.

`npm run backup:r2` now includes the stored reports.

## History

### Versions

`storeBatch` (`worker/centre/ingest.ts`) writes each changed or new record and then copies the row it just wrote into `ic_record_versions`, in the same ordered batch. A version is exactly what the collection stored, and nothing learnt later is added to it.

- **New** records start at version 1, labelled with the change detected (`new`).
- **Changed** records close their open version (`valid_to = now`) and get the next one (`escalated`, `downgraded`, `geometry_changed`, `updated`, `reappeared`, `ended` and so on).
- **Gone from a complete listing:** a version with `missing = 1` (`not_in_feed`). This never means resolved.
- **Expired** BoM warnings get an `ended` version.
- **Baseline:** a source's first collection, and any record that existed before history recording reached it, start with `baseline = 1`. That means "recorded as it already stood; earlier states weren't kept". A record that changes in that same collection gets one baseline version, never a zero-length one.
- `ic_config` key `history` notes when recording first stored anything, so "history began" survives retention.

### Timelines

**Record timelines** (`recordTimeline`) are shown on every record page and are available over MCP. Each event is labelled:

- **Official:** published by the provider. It shows the provider's own update time _and_ when the Centre collected it. A provider time is used only when it falls after the previous collection and no later than this one, so an update is never shown as known before it was collected.
- **Observed:** measurements and detections. These are the strongest gust, highest temperature and most rain at stations within 30 km, and satellite detections within 5 km grouped by hour. Detections are kept for only three days.
- **Derived:** worked out by the Centre. This includes "no longer in the feed" and correlations involving the record.
- **Collection:** about the Centre's own collecting. This includes "first collected", "history begins here" and **collection gaps**: periods with no successful retrieval for longer than the source's stale limit, from `ic_fetch_runs`, during which updates may be missing.

Road disruptions first reported within 25 km while the record was current are included as official records, marked "nearby isn't the same as related". Without versions, the record's detected changes are shown instead, and the timeline says so.

**Situation timelines** (Timelines page) cover the changes and collection gaps for a watch area, a region or NSW over 6 hours to 30 days, each labelled by nature.

### Replay

`replayFrame` reads only versions in force at the chosen moment (`valid_from ≤ T < valid_to`), never `ic_records`. A past record is therefore always shown as it was stored then. Its published area comes from the version's geometry hash.

For each source, it says what was known at that moment:

- **current**, or **stale**: no success within its stale limit before T, judged from runs and daily rollups;
- **not collected**;
- **before history**;
- **unknown**: sources whose terms don't allow history, such as satellite hotspots.

Notes cover:

- moments before history began (there is nothing to show);
- versions removed by retention;
- stale sources at that moment;
- baseline records;
- the fact that observations aren't replayed (see their charts).

The Replay page has:

- a date and time input;
- a scrubber over a 24-hour period with the moments things changed, and collection gaps shaded;
- previous and next step;
- play and pause at 1×, 2×, 5× or 10×;
- layer filters and a watch area or region scope;
- the map beside the list;
- source states;
- **compare two moments**: added, no longer current, and changed fields.

Replay can't go back past history recording's start or the version retention (120 days by default), and doesn't claim to.

## What's changed

The **What's changed** page, the `/feed` API and the `centre_search_changes` tool combine every enabled source's detected changes into one feed. It can be filtered by:

- hazard;
- region;
- watch area;
- period (up to 31 days);
- minimum level;
- source;
- change type: new, escalations and downgrades, published areas, fire danger and bans, ended/reopened/no longer listed, measurements, source failures and recovery, other updates.

Each change links to its record and the official source. **Significance** is deterministic (`isSignificant`):

| Significant                                                                                                                         | Routine                                     |
| ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Escalations, bans declared, changed published areas, source failures, staleness and recovery, reappearances, material river changes | Ordinary updates and records leaving a feed |
| New warnings and levelled incidents, new flood or weather warnings, new road closures and outages                                   | New unlevelled incidents                    |
| Rating changes from High up                                                                                                         | Ratings below High                          |
| Downgrades and endings of levelled records, and reopened roads                                                                      | —                                           |

Routine changes stay visible under "all"; nothing routine creates a notification. Station observations never create changes.

## Correlation

The deterministic engine (`worker/centre/correlate.ts`) now labels every result with a **basis** and the **factors** it weighed: geography, time, hazard, identifier, measurement, freshness and accuracy.

- **explicit:** an authoritative source links the records itself. Shown as "Linked by the provider".
- **derived:** the Centre's rule found them near each other in place and time. Shown as "May be related", with a confidence of low or moderate (never higher), "not official and not evidence of cause", and its limitations.

| Rule               | Finds                                                                                                                                                       | Basis    |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `alert-incident`   | An RFS CAP alert whose `IncidentId` is an RFS incident's published identifier                                                                               | Explicit |
| `fire-thermal`     | Satellite detections within 5 km of a fire incident, within 24 h                                                                                            | Derived  |
| `fire-roads`       | Road hazards within the correlation distance (25 km) of a levelled or uncontrolled fire                                                                     | Derived  |
| `warning-district` | BoM weather or flood warnings with observed river rises, flood-related road hazards and (for weather) three or more outages in the named forecast districts | Derived  |
| `danger-incidents` | Extreme or Catastrophic rating, or a Total Fire Ban, with active fires in the district's councils                                                           | Derived  |
| `wind-gusts`       | Wind, storm or severe weather warnings with observed gusts ≥ 90 km/h (the Bureau's damaging-gust threshold) at stations in the named districts after issue  | Derived  |
| `heat-temperature` | Heat warnings with observed ≥ 40 °C in the named districts (a reference the Centre uses, not the Bureau's heatwave definition, which is stated)             | Derived  |
| `air-fire`         | Air quality Poor or worse (the NSW Government's category) with an active fire or three or more detections within 50 km                                      | Derived  |
| `multi-warning`    | Two or more official warnings whose published areas overlap, or that name the same districts                                                                | Derived  |

Every rule is anchored on an official record. The results are capped so loosely related records can't multiply:

- 20 members per group;
- 40 groups per rule;
- 150 groups in all;
- each warning in at most one multi-warning group.

No rule creates, raises or infers a level, merges records or invents an incident.

## Monitoring rules

Each person's own rules are on the Monitoring rules page and through MCP (create and update only). A rule has:

- a name;
- one condition;
- a lookback (15 minutes to 7 days);
- a cooldown (0 to 7 days);
- a notification choice (none, in the portal, or email);
- an enabled switch.

Geographic conditions name one of the person's **watch areas**, so a rule never holds coordinates of its own. The rule's own condition decides the hazard, not the watch area's alert categories.

| Condition          | Matches                                                                                                                        | Threshold        | Units                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ---------------- | -------------------------------------- |
| `official_level`   | An official warning or incident at or above Advice, Watch and Act or Emergency Warning, in the area or within a distance of it | Official level   | km                                     |
| `fire_within`      | A bush or grass fire incident within a distance (optionally only those not under control)                                      | The person's own | km                                     |
| `road_on_corridor` | A road closure or hazard matching a corridor (or another watch area)                                                           | Official         | —                                      |
| `gauge_threshold`  | A river gauge reading crossing above or below a level                                                                          | The person's own | m                                      |
| `wind_gust`        | An observed gust at a station in the area at or above a speed                                                                  | The person's own | km/h or knots (converted; 10–300 km/h) |
| `temperature`      | An observed temperature at or above, or at or below, a value                                                                   | The person's own | °C                                     |
| `total_fire_ban`   | A Total Fire Ban for a district today, tomorrow or either, as the RFS lists it                                                 | Official         | —                                      |
| `earthquake`       | A Geoscience Australia earthquake at or above a magnitude within a distance                                                    | The person's own | magnitude, km                          |
| `source_stale`     | A source not retrieved for longer than its limit (or a time chosen)                                                            | Operational      | min                                    |

**Evaluation** (`evaluateRules`) runs after collection when `intelligence_centre.rules` is on, deterministically, with no model.

- The lookback applies to when a record reached its state (its update or publication time) and to readings.
- Readings match **once per crossing**: from not meeting the threshold to meeting it.
- Official records match once per level reached, so an escalation matches again.
- Bans match once per district, day and "today/tomorrow". Stale sources match once per outage.
- Every match records why it matched: the record, the value against the threshold with its unit (marked "your threshold, not an official one" where that applies) and the evidence's own time.
- The unique key makes evaluation idempotent across overlapping cron runs.
- **Notifications** go to the portal's alerts (`kind = rule_match`). They are emailed only if the rule asks, the person opted into alert emails, and the alert email switch and a provider are on.
- **Limits:** the cooldown and 20 notifications per person per hour. Matches inside them are still recorded, marked `cooldown` or `rate_limit`. Email notification needs a cooldown of at least 30 minutes.
- Someone who loses access to the Centre has their rules skipped.

**Test against history** (`POST /rules/test?days=7`) evaluates the rule over stored versions, readings or collection runs for the last 1–30 days. It shows hypothetical matches without writing or notifying anything.

Matches no longer make follow-up tasks: "Create task" was retired with Daly Tasks.

## Situation reports

`buildReport` produces a deterministic report for one of these scopes:

- NSW;
- one of the caller's watch areas;
- a region (an approximate named extent, `src/shared/centre/regions.ts`);
- one incident (and records within 30 km);
- a hazard in a region.

A report covers a period ending now or at **a past moment**. A past moment is read from replay's versions only, and the report is marked historical.

It has eleven sections, each fact numbered (F1…) and labelled official, observed, derived or collection, with its own time and a link:

1. Situation overview
2. Official warnings
3. Current incidents
4. Significant recent changes
5. Fire danger
6. Weather and environmental observations
7. Flood and water information
8. Transport and infrastructure disruptions
9. Potential cross-source relationships
10. Source health and information gaps
11. Sources and collection times

An empty section says why. For example, "Road disruptions aren't available: the Transport for NSW API key (TFNSW_API_KEY) hasn't been added. This isn't the same as there being none." Correlations aren't computed for past moments, and the report says so.

**Optional narrative:** Daly Intelligence's provider (switches, `briefings` budget, circuit breaker) sees only the fenced fact sentences. Each sentence of its answer must cite facts, and one with a number or level its facts don't contain is dropped. It is labelled "AI interpretation, not facts".

Reports can be generated on demand (preview, then save), printed, and downloaded as Markdown or JSON. They are stored in R2 and listed from D1. Only their author can see them.

**Schedules** are daily or weekly at an hour in a time zone (daylight saving handled), up to ten per person. When `intelligence_centre.reports` is on, the cron runs up to three due schedules per run. A schedule whose facts haven't changed since its last report (same fingerprint) doesn't make another one. New reports can notify, by alert or email under the alert rules. (A schedule's old "save to Knowledge" setting is ignored.)

## Assistant

`POST /assistant` and the Assistant page answer questions from stored records through nine deterministic tools:

| Tool                      | What it covers                                       |
| ------------------------- | ---------------------------------------------------- |
| `watch_changes`           | What changed in a watch area or NSW                  |
| `current_warnings`        | Official warnings in force                           |
| `escalations`             | Escalated records                                    |
| `river_trends`            | River level trends                                   |
| `roads_near_incidents`    | Road disruptions near followed or levelled incidents |
| `observations_for_record` | Observations around a warning or incident            |
| `compare_dates`           | Two moments, through replay                          |
| `incident_development`    | How an incident developed (its timeline)             |
| `data_gaps`               | Missing or stale information                         |

- **Without AI:** the question is understood from its words: periods ("past 3 days", "today", "this week"), dates, quoted incident names and the person's own watch-area names. The answer is the tool's facts with a plain lead sentence, labelled as coming from built-in question types.
- **With AI** (assistant switch and Daly Intelligence on): a model chooses the tool and parameters (schema-validated, falling back to the word rules), then writes up to five sentences from the fenced facts. They are grounded like briefings. The model never sees a watch area's name or location: names in the question are replaced with aliases (`[watch area W1]`) before anything is sent. It never decides a level, a severity or whether a place is safe.
- Every answer shows what was looked at, the facts with their nature and links, source freshness, and the limitations.
- **Limits:** questions are 3–500 characters, with control characters removed. Each person can ask 30 an hour.

## Analytics and source health

The **Analytics** page (`centreAnalytics`, cached 15 minutes in `ic_cache`, over 7, 30 or 90 days) shows:

- new official records per day by category, and escalations and downgrades;
- significant changes per day;
- activity by approximate region and by event type;
- daily maxima of temperature, gust and rain;
- followed river levels;
- source availability and how many days each source was collected.

Its caveats are always shown: these are counts of what was collected from the sources switched on, not complete or official NSW statistics, and nothing is a forecast or a risk score.

The **Sources** page adds reliability over 30 days from `ic_source_daily`:

- availability percentage;
- average retrieval time;
- average and maximum publication-to-collection delay;
- consecutive failures;
- longest gap;
- last validated retrieval;
- records over time.

Every source that isn't active has a plain gap message (`src/shared/centre/gaps.ts`). The same messages appear on wallboard widgets and in reports.

## Wallboard 2.0

### Presets

Every view is a 12 × 12 grid. A board can have up to six views (rotated in order), each with up to 16 widgets.

| Preset                         | Widgets                                                                                                                                                                                                                                                        |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Local Situation**            | Map at 8 × 10 cells: about 56% of the content area on a 16:9 screen, with layers, legend and the area framed. Situation summary, official warnings, nearby incidents, fire danger (and bans), current weather, and recent changes as a strip under the map.    |
| **NSW Situation Overview**     | Statewide map at 7 × 12 cells (58%). Activity counts by category with level lines, warnings by level, fire danger for every district, significant changes in 24 hours. All widgets are scoped to the NSW region.                                               |
| **Weather & Environment**      | Weather and flood warnings, a station observations table, temperature and gust charts, a rainfall chart, river gauges, air quality, satellite detections.                                                                                                      |
| **Transport & Infrastructure** | Map with transport, power, warning, flood and fire layers. Road disruptions (closures first, "On your corridor" for the owner's corridor watch areas), electricity outages with customers, source update times, relevant warnings, and road and power changes. |
| **Intelligence & Trends**      | Significant changes, the most serious incident's timeline, correlations, trends, the briefing (an interpretation only if prepared), source health with 24-hour success rates.                                                                                  |
| Map Focus (classic)            | The original layout, kept for boards made before 9.1.                                                                                                                                                                                                          |

**Radar and satellite imagery:** none is shown. No verified, licensed public interface for redistributing BoM radar or satellite imagery was found (see [INTELLIGENCE_SOURCES.md](INTELLIGENCE_SOURCES.md)). Satellite _thermal detections_ are shown as points, labelled as not confirmed fires. Nothing is fabricated.

### Widget catalogue

Defined in `WIDGET_META` in `src/shared/centre/wallboard.ts`, each widget with its nature label, minimum size, default size and allowed settings. There are 22 types:

- incident map;
- official warnings;
- nearby incidents (nearest first, without distances);
- fire danger;
- Total Fire Bans;
- current weather;
- observation chart (temperature, gusts, rain, river level, PM2.5, PM10, ozone, Kp);
- rainfall chart;
- river gauge;
- air quality;
- recent changes (optionally significant only and by category);
- incident timeline (chosen record, or the most serious current incident);
- road disruptions (optionally with corridors);
- electricity outages;
- satellite detections;
- cross-source correlations;
- trends;
- situation summary;
- intelligence briefing;
- source health;
- source update times;
- clock and date.

**Settings**, where they apply:

- title;
- **area**: the board's area, one of the owner's watch areas, or a named region (NSW, ACT, eight approximate NSW regions, or Australia for national datasets);
- map layers and legend;
- how many items;
- period;
- significant only;
- categories;
- station or gauge;
- measurement;
- record;
- corridors;
- show interpretation;
- show seconds.

**Validation** (`layoutProblems`) runs in the editor and again on the Worker:

- inside the grid;
- each widget's minimum size;
- no overlaps;
- known settings only;
- unique ids;
- watch areas the owner's own;
- records that exist.

### Layout editor

Wallboards → a board opens the editor (`/portal/intelligence-centre/wallboards/<id>`).

- **Board settings:** name, area, theme, type size (75–175%), clock, burn-in protection, rotation and seconds per view, refresh interval, map layers, interpretation, the watch-outline opt-in.
- **Views as tabs:** add from any preset, rename, move earlier or later, remove, or restore the preset layout.
- **The grid canvas:** drag a widget to move it, or drag its corner handle to resize it, snapping to cells.
- **Keyboard:** focus a widget, then arrow keys move it, Shift + arrow resizes it and Delete removes it. Every change is announced.
- **Widget catalogue and settings:** add a widget at its default size in the first free place, then edit its settings.
- **Preview:** renders the actual display view at 1920 × 1080, scaled.

Saving sends the board settings, then the views, each with its version, so a conflict (another tab saved first) is refused rather than overwritten. The Wallboards page also creates boards from presets, duplicates them (settings and views, never screens), and manages screens.

### Display behaviour

`/display#t=…` requests `GET /api/display/wallboard?v=2`. A screen still running the earlier page keeps getting the payload it understands.

**Freshness and errors**

- **Unchanged refreshes:** the Worker computes a cheap state key (board version, newest change, newest collection attempt, newest stored interpretation, and a five-minute bucket). When the screen sends the key it already has (`If-None-Match`), the Worker answers **304** without building anything.
- **Reconnection:** backoff from 5 s, doubling to 5 minutes, and immediately when the network or the tab returns. The last good data stays on screen.
- **"Not updating":** a persistent banner when refreshes fail or the last success is older than two intervals (at least 3 minutes).
- **Stopped screens:** a revoked or expired screen says it has stopped.
- **Widget problems:** a stale-source dot, a "not available" message per unavailable source, and an honest empty state.

**Warnings pinned above every view**

- Emergency Warnings in force in the board's area, and official warning changes there in the last two hours (new, escalated, area or rating changed, ban declared), are pinned in a strip above every view.
- The grid shrinks for the strip; no widget covers it.
- Each entry shows the level as published, the provider, the publication and update times, the change, and the official link as readable text.
- AI text is never shown as a warning.

**Rotation and controls**

- Rotation uses a restrained 300 ms fade (motion-safe only).
- Pause and resume with the button, Space or P; Previous and Next with the buttons or the arrow keys.
- Full screen with the button or F. Browsers only allow full screen after a click or key press, and the screen says so when it's refused.

**Appearance**

- **Type size:** `clamp(14px, min(0.88vw, 1.6vh), 40px)` times the board's scale: about 17 px at 1080p, 22 px at 1440p and 34 px at 4K. Ultrawide screens are sized by height.
- **Themes:** dark and high contrast. High contrast is black, white and heavier rings, and passes axe.
- **Burn-in protection:** the picture shifts a few pixels every three minutes.
- **Wake lock** where the browser supports it.
- **Identity:** the board's name, the view name and "view n of m".
- **Clock:** optional, in the header.
- **Footer:** source freshness, the disclaimer and every source's attribution.
- **Narrow or portrait screens** (tablets, below 1024 px wide) stack the widgets in reading order and scroll.

### Kiosk setup

- **Chrome or Chromium:** run `chromium --kiosk --noerrdialogs --disable-session-crashed-bubble --autoplay-policy=no-user-gesture-required "https://daly.id.au/display#t=<address>"`. Disable screen blanking in the operating system; the wake lock covers the browser itself.
- **Safari (macOS):** open the address, then View → Enter Full Screen (⌃⌘F). Set Energy settings so the display doesn't sleep; Safari 16.4+ supports the wake lock while the page is visible.
- **iPad:** Guided Access (Settings → Accessibility) with Auto-Lock off; add the page to the Home Screen for a full-screen web app.
- **Smart TVs and signage players:** use the device's kiosk or "web app" mode with the full address including `#t=…`. Choose an expiring, renewable address for screens that stay up for months.
- **Recovery:** after a power cut, the page reconnects by itself. If the address was renewed while the screen was off for longer than the overlap, paste the current address again from the Wallboards page.

Only Chromium was tested automatically. Safari, iPad and TV browsers weren't (see [Validation](#validation)).

### Display credentials

The existing model still applies:

- 256-bit tokens, shown once, stored as SHA-256 hashes;
- held in the URL fragment and sent only in the Authorization header;
- one board each, nothing else in the portal;
- re-checked on every request (switch, expiry, revocation, the owner's access);
- 30 refreshes a minute;
- cross-site requests refused;
- every refusal is the same 404.

New in 9.1:

- **Renewal:** an address created with an expiry can be marked "renew itself". From 14 days before expiry, the payload tells the screen it's due. The screen posts to `/api/display/renew`, receives a new token once, and replaces the address in place.
    - The credential row stays the same, so revoking it still stops the screen.
    - The old token works for a 15-minute overlap, then is refused.
    - The old token can't renew again; renewals are limited to three an hour.
    - Each renewal is audited (ids only).
- **Tiles:** basemap tiles for screens are served at `/api/display/tiles/{z}/{x}/{y}.mvt` with the same credential and checks, a separate limit of 600 a minute, and no per-tile use record.
- **Privacy:** a widget's area is sent as records and a frame rounded out to 0.1°, never a watch area's coordinates or name (tested). A widget names an area only by the owner's own title or a region's name.

## Detailed basemap

**Approach**

- **Archive:** one PMTiles archive of OpenStreetMap vector tiles (the Protomaps build, ODbL data, BSD-3 style code) for NSW, the ACT and a margin (`140.5,-38.0,154.0,-27.8`).
- **Storage:** in this site's own R2 bucket at `private/centre/basemap/basemap.pmtiles`.
- **Serving:** the Worker reads it by range (`pmtiles` 4.5.0 in `worker/centre/basemap.ts`) and serves ordinary tiles:
    - behind Access for the portal (`/api/portal/centre/basemap/...`);
    - behind a display credential for screens.
- **Caching:** tile addresses carry the archive's version, so browsers cache them for a week (immutable); a replaced archive changes the address.
- **Privacy:** no third-party tile host sees what anyone looks at, the Content Security Policy is unchanged (same origin), and OpenStreetMap's public tile servers aren't used.

**What it shows:** towns and suburbs with labels, roads and highways, state and local boundaries, rivers, streams and lakes, coastline, land cover, parks and other land use. Styles are from `@protomaps/basemaps` 5.7.2 (light and dark for the portal, dark and black for screens). These are left out: points of interest, road shields, one-way arrows, buildings and house numbers (sprites and clutter). Town labels are kept without their dot icons. Glyphs (Noto Sans Regular, Medium and Italic; Latin, Latin Extended and punctuation ranges, OFL) are served from `public/centre/fonts/`.

**Terrain:** land cover and parks give some topographic context. Hillshade and contours aren't included (deferred; see below).

**Fallback:** the Natural Earth state outline stays underneath, so areas outside the archive, or a site with no archive, still show the states. The map's attribution names OpenStreetMap contributors and Protomaps whenever the detailed map is on.

**Building and installing (owner only):** `npm run centre:basemap -- --maxzoom 13` uses the go-pmtiles CLI to extract from the latest Protomaps build into `migration-work/` (git-ignored). It prints the upload command and never uploads anything itself. Measured on 20 October 2026 for this extent:

| Max zoom | Archive  | Detail                                  | Upload with                                              |
| -------- | -------- | --------------------------------------- | -------------------------------------------------------- |
| 12       | ≈ 100 MB | Towns, main roads                       | `wrangler r2 object put`                                 |
| 13       | ≈ 210 MB | Most streets in towns (**recommended**) | `wrangler r2 object put`                                 |
| 14       | ≈ 419 MB | All streets                             | rclone or another S3 client (Wrangler's limit is 315 MB) |
| 15       | ≈ 878 MB | Full detail                             | rclone                                                   |

A real 13 MB extract (Blue Mountains to Sydney, zoom 12) was loaded into local R2 and viewed on wallboards at 1080p, 4K, ultrawide (3440 × 1440) and 1280 × 800, and on the portal map. Town labels, roads, waterways and coastline drew correctly.

## Today and Calendar

**Today:** the Intelligence Centre section adds:

- significant developments in the person's watch areas in the last 24 hours;
- their unacknowledged rule matches;
- the latest scheduled report's first facts;
- failures of the critical sources (RFS incidents, alerts and fire danger, BoM warnings);
- upcoming **journeys**.

Each part can be switched off in Settings → My preferences → Today. Existing preferences keep working; the new options default on. Nothing shows when nothing is relevant.

Tasks from rule matches and records, and saving records, briefings, timelines and reports to Knowledge, were retired with Daly Tasks and Daly Knowledge.

**Calendar (journeys):** link one of your events (read through Calendar's own `eventDetail`, with its permissions) to one of your watch areas, such as a route corridor or a destination. This needs a confirmation. For 14 days before the event, Today shows what concerns that watch area. Links are ids only, and the event's details are read through Calendar every time. No calendar event is changed.

Nothing creates events automatically.

## MCP

Sixteen new tools are served by `worker/mcp/centre-history.ts`. They need `centre.use`, have strict schemas, take no identity fields, and every result carries the disclaimer and attribution. That makes 28 Centre tools; with 9.1 the gateway was **2.8.0** (117 tools in all). Gateway 3.0.0 has 66 in all, after the Tasks and Knowledge tools were retired ([MCP.md](MCP.md)).

**Read (12):**

| Tool                            | Returns                                                                                        |
| ------------------------------- | ---------------------------------------------------------------------------------------------- |
| `centre_search_changes`         | The change feed, with filters and significance                                                 |
| `centre_get_timeline`           | A record's timeline, labelled by nature                                                        |
| `centre_get_replay_metadata`    | History start, retained range, steps and gaps, and optionally the records stored at one moment |
| `centre_get_trends`             | Analytics totals, with caveats                                                                 |
| `centre_list_rules`             | The person's own rules                                                                         |
| `centre_list_rule_matches`      | Matches of those rules                                                                         |
| `centre_generate_report`        | A deterministic report: not saved, never runs a model                                          |
| `centre_list_reports`           | Saved reports and schedules                                                                    |
| `centre_get_report`             | One saved report                                                                               |
| `centre_list_correlations`      | Correlations with basis labels and factors                                                     |
| `centre_get_source_reliability` | Source reliability                                                                             |
| `centre_list_wallboards`        | Wallboard summaries: views, widgets, active screen count; never addresses or hashes            |

**Write (4),** through the `mcp_writes` ledger (a retried request id returns the first result): `centre_create_rule`, `centre_update_rule` (only the fields sent change; versioned), `centre_schedule_report` and `centre_save_report`.

No tool deletes anything, returns a watch area's location or a display credential, collects from a provider or runs a model. Deploy the gateway only **after** the portal Worker (see [Activation](#activation)).

## API

Everything is under `/api/portal/centre`, behind Access and `centre.use`, with the portal's same-origin rules for writes. Everything personal is the caller's own (404 otherwise).

| Method and path                                                                                                                                         | What                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /feed`                                                                                                                                             | What's changed (`hazard`, `region`, `watch`, `from`, `to`, `minLevel`, `source`, `group`, `significance`)                                |
| `GET /records/:id/timeline`, `POST /records/:id/timeline/knowledge`                                                                                     | Timeline; save it to Knowledge (retired, 410)                                                                                            |
| `GET /timeline`                                                                                                                                         | Situation timeline (`watch`, `region`, `hours`)                                                                                          |
| `GET /replay?at=`, `GET /replay/meta`, `GET /replay/compare?a=&b=`                                                                                      | Replay (`watch`, `region`, `layers`, `includeInactive`)                                                                                  |
| `GET /analytics?days=7\|30\|90`, `GET /reliability?days=`                                                                                               | Analytics; reliability                                                                                                                   |
| `GET/POST /rules`, `PUT/DELETE /rules/:id`, `POST /rules/test`, `GET /rules/matches`, `POST /rules/matches/acknowledge`, `POST /rules/matches/:id/task` | Monitoring rules (the `task` route is retired, 410)                                                                                      |
| `GET/POST /reports`, `POST /reports/preview`, `GET/DELETE /reports/:id`, `POST /reports/:id/knowledge`                                                  | Reports (the `knowledge` route is retired, 410)                                                                                          |
| `GET/POST /schedules`, `PUT/DELETE /schedules/:id`                                                                                                      | Report schedules                                                                                                                         |
| `POST /assistant`                                                                                                                                       | Assistant                                                                                                                                |
| `PUT /wallboards/:id/views`, `POST /wallboards/:id/duplicate`, `GET /wallboards/:id/preview`                                                            | Wallboard 2.0 (the existing wallboard routes accept `views`, `theme`, `scale`, `clock`, `burnIn`, `rotate`; displays accept `renewable`) |
| `GET/POST /events/links`, `DELETE /events/links/:id`                                                                                                    | Journeys                                                                                                                                 |
| `GET /basemap`, `GET /basemap/:z/:x/:y.mvt`                                                                                                             | Basemap info and tiles                                                                                                                   |

Outside Access, with a display credential: `GET /api/display/wallboard?v=2` (304 with `If-None-Match`), `POST /api/display/renew` and `GET /api/display/tiles/:z/:x/:y.mvt`.

## Security and privacy

- **Identity:** always the verified Access identity (portal and MCP) or a display credential (screens). No route or tool reads a person from its input.
- **Ownership:** rules, matches, reports, schedules, wallboards, views, journey links and alerts are the caller's own, read joined to their email. Anyone else gets 404.
- **Watch-area locations and names never appear in:**
    - logs or audit entries (rules, reports, links and renewals are audited by id and kind);
    - MCP results, model prompts (the assistant uses aliases) or screen payloads.
    - The tests check each of these.
- **Validation:** strict zod schemas everywhere; layout validation in two places; units validated; question length and characters limited.
- **Rate limits:** display refreshes (30 a minute), tiles (600 a minute), renewal (3 an hour), the assistant (30 an hour), report generation (30 an hour), rule tests (30 an hour) and rule notifications (20 an hour).
- **Untrusted text:** feed content reaches a model only fenced; model output is schema-validated and grounded. Records are rendered as text only.
- **Caching:** API responses are `no-store` (except immutable, version-addressed basemap tiles, cached privately). Nothing secret is in client bundles (`npm run check:bundle`).

## Retention

Settings → Account settings now also covers:

| Data                 | Default      | Range  | Notes                                                                |
| -------------------- | ------------ | ------ | -------------------------------------------------------------------- |
| Superseded versions  | 120 days     | 7–400  | Open versions stay while their record does; unused shapes are pruned |
| Daily source rollups | 400 days     | 30–800 |                                                                      |
| Rule matches         | 180 days     | 7–400  |                                                                      |
| Reports              | 365 days     | 7–800  | Their R2 content is deleted too                                      |
| Analytics cache      | Until expiry | —      |                                                                      |

Retention runs every cron, whatever the switches.

## Performance and costs

Everything runs on the existing Workers Paid plan. There is no new binding, service, subscription, paid map or paid data API.

| Driver        | Estimate                                                                                                                                                                                                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Versions      | One row per changed official record per collection (observations and detections excluded). A busy fire day of about 100 incidents updated hourly is about 2,400 rows a day, well under 1 MB/day. 120 days of retention is tens of MB in D1.                                                            |
| Daily rollups | One upsert per collection run; about 15 sources × 96 runs a day                                                                                                                                                                                                                                        |
| Rules         | Up to 200 rules per cron run, each a few bounded queries; 50 candidates per rule                                                                                                                                                                                                                       |
| Reports       | Up to three scheduled per cron run; unchanged facts skipped; one small R2 object each                                                                                                                                                                                                                  |
| Wallboards    | One request per screen per refresh. Unchanged refreshes are a 304 after two tiny queries. A changed one builds each area once and shares it between widgets.                                                                                                                                           |
| Basemap       | One archive of 100–900 MB in R2, about US$0.003–0.014 a month beyond the free 10 GB. Tile reads are R2 Class B operations. Browsers cache tiles for a week and screens don't pan, so a screen loads a few dozen tiles per session. The Worker re-checks the archive at most once a minute per isolate. |
| Analytics     | Computed at most every 15 minutes per range                                                                                                                                                                                                                                                            |
| AI            | Zero unless someone asks the assistant or requests a narrative, within Daly Intelligence's budgets                                                                                                                                                                                                     |

All queries are bounded: limits on records, changes, versions, steps, series and members. The map library and basemap style load only on pages with a map.

## Activation

None of this is done by this pull request. Do it in order, each step with the owner's approval:

1. **Back up, then merge.** Run `npm run db:backup -- --env production` first. Merging to `main` runs the deploy workflow, which applies `0027` and deploys. `0027` rebuilds `mcp_writes`, copying every row.
2. **Check:** run `npm run db:verify -- --env production`. The three new consistency checks should pass on an empty history.
3. **Optionally install the detailed basemap:** run `npm run centre:basemap -- --maxzoom 13`, upload with the printed command, then confirm Settings → Basemap is **Detailed** and open the Live map.
4. **Switch history recording on** (Features). Records get their baseline at their next collection. Watch Replay and a record timeline for a day.
5. **Create rules** and test them against history, then switch **monitoring rules** on.
6. **Schedule reports** if wanted, then switch **scheduled reports** on.
7. **Wallboards:** open each board in the editor and save its views (boards from before 9.1 keep working meanwhile, showing their original layouts as the new presets). Consider renewable, expiring addresses for long-running screens.
8. **Assistant with AI (optional):** only with Daly Intelligence already on and its budgets set.
9. **MCP:** after the portal is live, run `npm run mcp:deploy:dry-run`, then `npx wrangler deploy --config mcp/wrangler.jsonc --env production`. Never deploy the gateway before the portal; the current gateway is 3.0.0 ([MCP_CUTOVER.md](MCP_CUTOVER.md)).

## Rollback

- **Instant, no deploy:** switch history, rules, reports or the assistant off; set Basemap to **Outline**; revoke screens.
- **Code:** `npx wrangler rollback <version> --env=""`. Leave `0027` in place: the previous Worker never reads the new tables or columns, and `mcp_writes` keeps accepting every earlier outcome.
- **Gateway:** `npx wrangler rollback --config mcp/wrangler.jsonc --env production` back to the previous version.
- **Data:**
    - versions, rollups and the cache can be rebuilt from future collections;
    - rules, matches, reports metadata, schedules, views and links are in the regular D1 backups;
    - report content is in `npm run backup:r2`;
    - the basemap archive can be deleted from R2 at any time; maps fall back to the outline.

## Validation

### Automated, passing on this branch

**Typecheck and checks:** `npm run typecheck`, `check:styles` and `check:bundle` pass, and the client builds.

**Vitest (Worker): 59 files, 1,078 tests.** The new files are:

| File                         | Covers                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `centre-history.test.ts`     | Versions and baselines; replay integrity, before-history and stale-source notes; comparison and steps; timelines with provider and collection times; the change feed and its filters; daily rollups and reliability; analytics and caching; retention                                                                                                      |
| `centre-rules.test.ts`       | Privacy and audit; units and knots; every condition; dedupe and escalation; cooldown and notify none; the switch; lost access; history tests that write nothing; the retired task route                                                                                                                                                                    |
| `centre-reports.test.ts`     | Report sections and natures; empty-section messages; watch privacy; historical reports from versions only; R2 storage and ownership; the retired Knowledge route; a grounded narrative; schedules across daylight saving with unchanged facts skipped; expiry; the assistant's word routing, AI off, AI with aliases and grounding, limits                 |
| `centre-wallboard-2.test.ts` | View validation; legacy boards; duplication; payload with every preset's widgets and no watch name or coordinates; unavailable-source messages; pinned Emergency Warnings; 304; the legacy payload; owner-only preview; renewal with overlap and revocation; basemap tiles from a generated PMTiles archive, with credential, Access and cross-site checks |
| `centre-mcp.test.ts`         | The new reads, ledger replay for rule and report writes, conflicts, other people's records, no coordinates, no display credentials                                                                                                                                                                                                                         |

**Vitest (gateway): 4 files, 37 tests.** The contract and protocol tests covered 117 tools at the time (66 since gateway 3.0.0).

**Playwright (Chromium, desktop and Pixel 7):**

- Every new page passes axe (serious and critical), fits the screen and has no errors.
- The five presets at **1920 × 1080, 2560 × 1440 and 3840 × 2160**: every widget present, no scrolling, axe passes at 1080p.
- High contrast passes axe; pause and keyboard view steps work.
- The editor's keyboard move and resize: an overlap is refused, then the change saves.
- The assistant without AI, and replay beside the map.
- The existing Centre specs pass, updated for the v2 display.

### Viewed by hand

Wallboards with a real OpenStreetMap extract (local R2 only) were viewed in Chromium screenshots at 1080p, 4K, 3440 × 1440 and 1280 × 800, as was the portal map. All data shown was the invented fixtures.

### Not validated

- Production deployment, migration on the production database, real cron behaviour on Cloudflare.
- Real D1 and R2 volumes, real feeds over days (history and replay were tested with fixtures at chosen times).
- Live rule and report emails.
- Workers AI quality for the assistant and narratives (a scripted stand-in model was used).
- **Safari or WebKit, iPhone or iPad, smart-TV and kiosk browsers:** only Chromium was automated. Full screen and wake lock behaviour on those is unverified.
- The full NSW basemap extract in production R2.

## Limitations and deferred work

- **Replay** starts when history recording is switched on; nothing earlier can be reconstructed. Observations and detections aren't replayed as records. Correlations and reports for past moments don't include correlations.
- **Coverage:** the gaps in [INTELLIGENCE_SOURCES.md](INTELLIGENCE_SOURCES.md) still apply. That means no NSW SES warnings (permission needed) and roads only with a TfNSW key. Satellite imagery and radar aren't shown, because no licensed interface permits redistribution.
- **Regions** are approximate rectangles. Fire danger districts have no boundaries, so a region's report lists every district.
- **Rule lookback** for official records uses their update time. A long-running warning not updated within the lookback won't match a newly created rule until its next update.
- **Terrain:** no hillshade or contours yet. Adding them needs an openly licensed DEM tile archive (for example a bounded extract served like the basemap); deferred.
- **Not done:** the editor's preview uses the portal's colours (not high contrast) and an approximate type size; wallboard charts have no axis labels beyond minimum, maximum and latest readings; mobile push notifications.
