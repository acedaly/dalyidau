# Daly Intelligence Centre

Milestone 9, at `/portal/intelligence-centre`: public emergency, weather and environmental information for NSW. It covers official incidents and warnings, fire danger and Total Fire Bans, weather observations, rivers, roads, power outages, air quality, satellite thermal detections, earthquakes and space weather. You can see it on a map and in lists, follow your own private watch areas, get alerts, read briefings and run full-screen **wallboards** for a TV or kiosk.

> **Not an official warning service.** It collects public information for awareness and may be delayed or incomplete. Every page, email, MCP result and wallboard says so, and points to official warnings (Hazards Near Me, Fires Near Me, the Bureau of Meteorology) and Triple Zero (000).

**Status: built and tested; off by default; not deployed.** The code, migration `0025_intelligence_centre.sql`, tests and documentation are in this pull request. Nothing has been deployed or migrated remotely, and no switch, source, secret or binding has been added in production. Collection was **live-tested locally** against the real public services (see [What has and hasn't been validated](#what-has-and-hasnt-been-validated)). Sources and their evidence: [INTELLIGENCE_SOURCES.md](INTELLIGENCE_SOURCES.md).

Three kinds of information are kept apart everywhere they appear, each with its own label:

| Kind         | What                                                                                       | Label                                                    |
| ------------ | ------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| **Official** | What an agency published: incidents, warnings, ratings, outages, road hazards              | "Official"                                               |
| **Observed** | Measurements and detections: weather stations, river gauges, air quality, satellites, Kp   | "Observed"                                               |
| **Derived**  | What this application worked out: changes, correlations, briefing facts, AI interpretation | "Derived, not official" / "AI interpretation, not facts" |

---

## Architecture

```
src/shared/centre/
  sources.ts      The source registry: every source investigated, its licence, attribution, refresh, eligibility and evidence
  types.ts        Records, changes, watch areas, alerts, preferences, settings, correlations, briefings, wallboards, page shapes
worker/centre/
  net.ts          safeFetch: host allow-list, manual redirects, timeout, streamed byte limit, conditional requests; fixture transport (dev only)
  ftp.ts          Read-only anonymous FTP over Workers TCP sockets (EPSV, list with a pattern, retrieve), for the BoM
  xml.ts          A small safe XML reader (no DOCTYPE or ENTITY, bounded depth, count and size)
  geo.ts          Geometry validation and thinning, bounding boxes, distances, point-in-polygon, corridors
  adapters/       One adapter per source: fetch, validate, return canonical records (rfs, bom, geoscience, regional, keyed)
  ingest.ts       The engine: scheduler, leases, replay protection, upserts, change detection, history, snapshots, retention, the cron step
  store.ts        Reads: records, changes, series, source health and status rules, settings, preferences
  watch.ts        Private watch areas and the matching rules
  alerts.ts       Alerts from changes, rate limits, quiet hours, opt-in email and daily digests
  correlate.ts    Deterministic cross-source correlation
  summary.ts      The dashboard's counts
  briefing.ts     Deterministic briefing facts; optional interpretation through Daly Intelligence
  actions.ts      Tasks, Knowledge, Today and Calendar matching, through those applications' own functions
  map.ts          Map features (published areas and points)
  wallboard.ts    Wallboard profiles, display credentials, the display payload
  api.ts pages.ts /api/portal/centre/* and page loaders
worker/mcp/centre.ts    Twelve read-only MCP tools
src/portal/centre/      Pages, the shared map (MapLibre), briefing view, record summary and actions
src/display/            The wallboard display app (/display), with its own shell and bundle
migrations/0025_intelligence_centre.sql
```

**Cloudflare services:** only what the portal already uses. The existing Worker and its 15-minute cron do the collecting. D1 holds records, history, watch areas and alerts. R2 (`MEDIA`, under `private/centre/snapshots/`) holds raw snapshots, only for sources whose terms allow history. Workers AI is used, through Daly Intelligence, only when asked to interpret a briefing. There's no new binding, queue, Durable Object, KV, paid map service or third-party API without a key.

The application is registered in `src/shared/portal/applications.ts` (`intelligence-centre`, permission `centre.use`, which owners and admins have). Its sidebar has four groups: Situation (Overview, Live map, Incidents and warnings, Hazards), Analysis (History, Briefings) and Manage (Watch areas, Wallboards, Sources, Settings). The six hazard views are tabs on one page: weather, fire danger, flood and water, transport, environment and infrastructure.

## Feature switches

All off by default, in Portal settings → Features → **Intelligence Centre** (`src/shared/portal/flags.ts`):

| Switch                             | Effect                                                                                                                                                |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `intelligence_centre.ingestion`    | The cron collects the sources switched on in **Sources**. While off, nothing is fetched on a schedule; records already collected stay, with their age |
| `intelligence_centre.alerts.email` | Emails watch-area alerts and daily summaries to people who opted in. Also needs `EMAIL_DELIVERY`. While off, alerts are in the portal only            |
| `intelligence_centre.wallboard`    | Serves `/display` and accepts display credentials. While off, `/display` and its API answer 404 and every credential is refused; nothing is deleted   |

**Sources** are switched on one at a time on the Sources page (owners and admins, audited), not with feature switches. Every source starts off. Restricted and unsupported sources can't be switched on. A manual **Refresh now** works whether or not the collection switch is on, and is limited to three per source per ten minutes.

## Data model (`0025_intelligence_centre.sql`)

Additive only: twelve new tables, nothing altered, and `mcp_writes` untouched (the MCP tools are read-only).

| Table                                | Contents                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ic_sources`                         | One row per implemented source: on or off, last attempt and success, newest publication seen, next due, failures, a short error, ETag and Last-Modified, content hash, adapter cursor, lease, fixture flag                                                                                                                                                              |
| `ic_fetch_runs`                      | Every collection attempt: outcome, HTTP status, bytes, records, created and changed, duration, error code (reliability history)                                                                                                                                                                                                                                         |
| `ic_records`                         | The canonical record, keyed by `(source_id, external_id)`: kind, category, event type, title, description, status, the provider's own level, a sort rank, point, bounding box, validated geometry, geometry quality and accuracy, published, updated, observed, first and last seen, missing-since, active, source link, fingerprint, metrics, attributes, fixture flag |
| `ic_changes`                         | Detected changes: new, escalated, downgraded, updated, geometry changed, not in the feed, reappeared, ended (by the provider), rating changed, ban declared or lifted, material measurement change, source failed, stale or recovered                                                                                                                                   |
| `ic_series`                          | Measurements over time (temperature, gusts, rain, river level, air quality, Kp), where history is allowed                                                                                                                                                                                                                                                               |
| `ic_watch_areas`                     | Private watch areas, per person                                                                                                                                                                                                                                                                                                                                         |
| `ic_alerts`                          | Alerts, unique per person and change; acknowledgement and email state                                                                                                                                                                                                                                                                                                   |
| `ic_preferences`, `ic_config`        | Each person's preferences; account settings (retention, gauges, air quality sites, correlation, map limits)                                                                                                                                                                                                                                                             |
| `ic_briefings`                       | Interpretations already generated, reused while the facts are unchanged                                                                                                                                                                                                                                                                                                 |
| `ic_wallboards`, `ic_display_tokens` | Wallboard profiles; display credentials (SHA-256 hashes only, revocable, expiring)                                                                                                                                                                                                                                                                                      |

Unrelated records are never merged: an incident, a warning about it, a road closure near it and a satellite detection beside it are four records. Correlation links them by rule; it doesn't combine them.

## Ingestion lifecycle

1. **Schedule.** Each 15-minute cron run (`runCentreCron`, alongside the other cron steps, failures contained) takes up to eight due, enabled sources, three at a time. A source is due at its own interval (15 minutes for incidents, 30 for observations, 3 hours for river gauges). Retention, expiry and email delivery run every time, even with collection off.
2. **Lease.** A collection claims the source for three minutes, so overlapping runs never collect it twice.
3. **Request.** `safeFetch` checks the URL against the source's host allow-list (https only; no private or numeric addresses, credentials or odd ports). It follows at most two redirects, each checked against the same list, and sends `If-None-Match` and `If-Modified-Since`. It enforces a timeout and a byte limit while the body streams in. BoM products come over FTP, with listing times as the conditional check.
4. **Validate.** The adapter parses the response with the safe XML reader or JSON, checks it has the documented shape, validates and thins geometry, and keeps official wording, removing only markup. Anything malformed is an error, not a partial guess.
5. **Replay protection.** A response whose newest publication time is older than one already stored is refused (`rejected`, `replayed`). An identical response (same content hash, or 304) is `unchanged`: nothing is rewritten.
6. **Store.** Records are upserted by the provider's own id, idempotently; a duplicated id in a response is stored once. The first successful collection is a **baseline**, so nothing in it is "new".
7. **Detect changes.** Escalations and downgrades (by the provider's own level), changed published areas, status changes, ratings and bans, material river-level changes (0.3 m by default), records reappearing, and records the provider itself marks ended (CAP `Cancel`, RFS status "Out", a road hazard marked ended, a BoM warning past its expiry or cancelled). **A record missing from a complete response is "no longer in the feed (not confirmed resolved)", never "resolved".** Satellite detections and observations are routine and don't create changes.
8. **History and snapshots.** Measurement series are stored where the source allows history. A gzipped raw snapshot goes to R2 when content changes (20 per source by default).
9. **Alerts** are generated from the changes (see [Notifications](#notifications)).
10. **Failures** back off exponentially (the source's interval × 2ⁿ, at most 6 hours). The third failure in a row records a `source_failed` change; recovery records `source_recovered`. A missing key isn't retried for 24 hours. Sources without a success within their limit get one `source_stale` change.

**Logs** carry the source id, outcome, counts, HTTP status and duration. They never include a URL (it can contain a key), a response body or a record.

## Source health

Every page that shows a source's data shows its freshness: "Retrieved 12 minutes ago", or "Last retrieved 3 hours ago" in warning colour when stale. Any stale or failing source gets a notice at the top of the page and a line on wallboards. The **Sources** page shows the full registry: status and its reason, licence, attribution, access, eligibility, refresh interval, endpoint label, last attempt and success, newest publication seen, record count, next refresh, last error and the evidence notes. Keys and URLs carrying them are never shown.

## Correlation methodology

`worker/centre/correlate.ts`. Deterministic rules over active records from the correlation window (48 hours by default), each with its evidence, distances, times and limitations. Confidence is only ever "low" or "moderate":

| Rule               | Finds                                                                                                                                                                              | Confidence                                            |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `fire-thermal`     | Satellite detections within 5 km of an official fire incident (its published area if it has one) and within 24 hours of its update                                                 | Moderate with three or more detections, otherwise low |
| `fire-roads`       | Road hazards within the correlation distance (25 km) of a fire incident at a warning level or not under control                                                                    | Moderate if the road hazard is itself fire-related    |
| `warning-district` | For a BoM weather or flood warning: river gauges with a recorded rise, flood-related road hazards and (for weather) three or more power outages in the forecast districts it names | Moderate with both a rise and a flooded road          |
| `danger-incidents` | An Extreme or Catastrophic rating or a Total Fire Ban, and active fires in the councils the RFS lists for that district (shared named places)                                      | Moderate                                              |

The district of a located record is the BoM forecast district of the nearest weather station within 60 km. That's an approximation, and the limitations say so. Correlations are labelled "derived, not official" and "may be related", never "caused by". No rule creates or raises a warning level.

## Geospatial behaviour

- **Only what was published is drawn.** Points stay points (an incident or road closure is never buffered into an area or a length of road). Published polygons (RFS incident areas, CAP alert areas) are drawn as published: validated and evenly thinned for storage (5,000 vertices) and the screen (1,500), never smoothed or grown. District and text-only warnings (BoM, fire danger districts) have no shape and are listed beside the map.
- **Accuracy is stated.** Each record carries its geometry quality ("a published point; the incident may cover a much larger area", "a named district", "described in words only") and the provider's accuracy where given (satellite detections ±2 km, earthquake uncertainty).
- **The map** is MapLibre GL JS 6.11.2 (BSD-3). Its basemap is an outline of Australia's states served from this site (`public/centre/australia.geojson`, Natural Earth v5.1.2, public domain, simplified to 25 KB). There are **no third-party tiles**: a tile request would tell a tile host which area someone is looking at, often their home, and would need a wider Content Security Policy. MapLibre's worker is bundled and served from this origin (`worker-src` falls back to `script-src 'self'`), so the CSP is unchanged. The library loads only on pages with a map (a separate chunk, about 286 KB gzipped).
- **Layers:** bush and grass fires, official warning areas, weather, flood, river gauges, roads, power, air quality, satellite detections, earthquakes, other incidents and your watch areas. Official points are solid with a halo, sized by level and coloured by the Australian Warning System where there's a level (Advice yellow, Watch and Act orange, Emergency Warning red). Satellite detections are diamonds, and their clusters are pale. Map controls: zoom, full screen, clustering (click to expand), time filter (6 h, 24 h, 72 h, 7 days, by each record's own time), search, "list only what's in the map view", a details panel and a legend.
- **The map is never the only way to see something.** Every record on it is in the list beside it, and the record page gives everything the map shows, in words.

## Warning display requirements

Official levels and ratings are shown **exactly as published**: Australian Warning System levels for RFS incidents and CAP alerts, and Fire Danger Ratings with Total Fire Bans as the RFS publishes them. BoM warnings in these products carry no AWS level, so they're shown as "Warning (BoM)" with no level assigned. Records keep the provider's wording; only markup is removed. Every record shows its published, last official update and observed times, distinct from when it was collected, plus the provider's link and attribution. Records from fixtures say "Recorded fixture data, not live" everywhere.

## Watch areas

Each person's own, private: other people (including the other portal owner), AI assistants and wallboard displays never see a watch area's location. Kinds: **place and radius**, **drawn area** (polygon, up to 200 points), **region** (bounding box up to 15° across), **fire danger district**, **river gauge**, **road corridor** (a route and a distance either side) and **one incident**. A geographic watch area can also follow a fire danger district. Each has hazard categories, an alert level, in-app and email alerts, quiet hours, an optional end date (for a trip) and a pause switch. There's a limit of 50 per person, and areas must be in or near NSW.

**Matching** (`matchWatch`, with the reason shown each time):

- Distance to a point, or to the edge of a published area (0 inside it).
- Point-in-polygon, plus overlap of published areas.
- Bounding-box overlap for regions; distance to the route for corridors.
- District name for fire danger.
- Station for gauges, and id for incidents.
- BoM's text warnings through the district of the BoM station nearest the area.

Audit entries record ids and kinds only, never a name or coordinates.

## Notifications

Alerts are deterministic and come only from detected changes that concern someone's own watch area: new records, escalations, reappearances, changed published areas, rating changes, Total Fire Bans and material river rises. Road changes alert for closures and major hazards only, and "no longer in the feed" never alerts. Failures and staleness of the critical sources (RFS incidents, alerts and fire danger, BoM warnings) alert people who have watch areas.

- **In the portal** (Overview, Watch areas, Today's notifications) until acknowledged.
- **Deduplicated** by a unique key per person and change, so overlapping cron runs can't alert twice.
- **Rate-limited**: 30 an hour per person, then one "more changes" summary.
- **Email** only with the switch on, a provider configured, the person's opt-in (Settings → My preferences) **and** email turned on for that watch area. Quiet hours hold emails until they end, and one held over 12 hours is dropped. There are three attempts. Every email says it isn't an official warning service, that delivery isn't guaranteed, and to call 000 in an emergency.
- **Daily summary email** at a chosen hour, opt-in.
- Someone who loses access gets nothing more.

## AI integration

Briefings (`/portal/intelligence-centre/briefings`, and on the Overview) are **useful without AI**. Their facts are deterministic: one sentence per fact, built from stored records, each with an id (F1, F2…), a link and its own time. They cover official warnings, significant incidents, fire danger and bans, weather extremes (observed), changes in the last 24 hours, environment, infrastructure and possibly related observations (derived). The briefing also lists the sources that weren't active. Briefings are available for NSW or for one watch area, and can be saved to Knowledge.

**Interpretation** is optional, through Daly Intelligence's provider (`worker/intelligence/provider.ts`): its master switch and the recommendations feature, its budgets (`briefings`), circuit breaker, usage records (never content) and AI Gateway setting. The model sees only the fact sentences, fenced as untrusted data (`fence()`), with a system prompt saying:

- only restate or connect the facts;
- never invent anything;
- never assign or raise a level, or say a place is safe;
- say "may be related", never "caused by".

The model never sees a watch area's name, place name or coordinates: a watch briefing's facts describe the matching records. The answer is schema-validated, then **grounded** (`groundInterpretation`). A sentence is dropped if it cites no fact or an unknown one, contains a number not in its cited facts, or names a warning level or fire danger rating its cited facts don't contain. Interpretations are labelled "AI interpretation, not facts" and reused until the facts change. Wallboards and MCP never run a model; they show only an interpretation the person already prepared.

## Today, Tasks, Calendar and Knowledge

- **Today:** unread Centre alerts appear in Today's notifications. A short "Conditions in your watch areas" card shows only matching warnings and incidents from the person's chosen level (Watch and Act by default), fire danger for their districts, closures and outages, and calendar matches. It's at most six lines, and it doesn't appear when nothing is relevant (Settings → My preferences → Today).
- **Tasks:** "Create task" on any record (and on the map's detail panel) creates a follow-up task through Daly Tasks' own `createTask`, in the Inbox, with the record's source, times and link in the description. An optional due date acts as the reminder. Retrying returns the same task.
- **Knowledge:** "Save to Knowledge" on a record or a briefing creates a note through Daly Knowledge's own `createObject` in the person's personal space, keyed by the record (or briefing hour) so saving again returns the same note.
- **Calendar (opt-in):** "Check my upcoming events" compares the location text of the person's events in the next seven days with places named in current official warnings and incidents (whole words of four letters or more), and lists matches on Today. Private and sensitive events, events of others shown as Busy, and cancelled events are never read.

## Wallboard Mode

A full-screen, read-only view for a monitor, TV or kiosk at `https://daly.id.au/display#t=<credential>`, with no portal navigation. It reuses the Centre's records, watch areas and map; there's no second collection system.

- **Profiles** (Intelligence Centre → Wallboards), per person, up to ten. Each has a name shown on screen, a layout and an area (one of the owner's watch areas, or NSW). It also sets map layers, optional rotation between layouts, seconds per view, refresh interval (30–900 s), and whether to show an interpretation already prepared.
- **Layouts:** **Local Situation** (map, warnings and incidents in the area, fire danger, weather, interpretation), **NSW Overview** (the same for NSW), **Map Focus** (a large map with legend and the most serious records) and **Weather & Environment** (observations, fire danger, weather and flood warnings).
- **Display credentials:** "Add a screen" creates a credential shown **once**: 256 random bits, of which only a SHA-256 hash is stored. It can expire and is revoked instantly; deleting a wallboard revokes all of its credentials. Five active credentials per wallboard.
    - **Least privilege:** a credential reads exactly one wallboard's data from `/api/display/wallboard`, and nothing else in the portal. Portal routes still require Cloudflare Access.
    - **Re-checked on every request:** the switch on, the credential valid and unexpired, and the owner still allowed to open the Centre. Every refusal looks the same (404).
    - **Rate limit:** 30 requests a minute per credential.
    - **Kept off the network and out of logs:** the credential lives in the URL fragment, which browsers never send to a server, and goes to the Worker only in an `Authorization` header. It never appears in logs or Referer headers (`Referrer-Policy: no-referrer`).
    - Display requests from another site are refused.
- **Privacy:** the display gets the area's records, a **frame rounded outwards to 0.1° (about 10 km)**, and the board's name. It never gets the watch area's coordinates, name or place name. Drawing a polygon watch area's outline is a separate opt-in, rounded to 0.01°, and off by default. The map frames the area without asking for the screen's location.
- **On screen:** a large clock and date, the last successful refresh, and each source's age in the footer (sources with problems are named in warning colour). Official, observed and derived panels are labelled. Verified official warning changes in the area from the last two hours are highlighted (new, escalated, area changed, rating changed, ban declared), with motion only where the viewer hasn't asked for reduced motion. The standing disclaimer and every source's attribution are always visible.
- **Continuous operation:**
    - Refreshes on the board's interval, and keeps the last good data through failures.
    - Reconnects with backoff (5 s doubling to 5 minutes), and immediately when the network or the tab comes back.
    - Shows a prominent **"Not updating"** banner when a refresh fails or the last success is older than two intervals (at least 3 minutes).
    - A revoked or expired screen says it has stopped and checks back every 5 minutes.
    - Asks for a screen wake lock where the browser supports it.
    - Rotation pauses with the on-screen button, Space or P.
    - Pasting a new address reloads the board.
- **Sizes:** dark and high contrast; type scales with the screen (`clamp(16px, 1.05vw, 44px)`), so it reads at 1080p and 4K. Both were checked in Chromium. It uses no browser features beyond what Safari 15+, Chrome and kiosk browsers support; the wake lock is optional.
- **Without AI:** everything works; an interpretation appears only if the owner prepared one and turned it on for the board.

## MCP

Twelve **read-only** tools (85 in all), served by `worker/mcp/centre.ts` and advertised by the gateway (`mcp/src/portal-tools.ts`, version **2.6.0**). They need `centre.use`, have strict schemas and no identity fields, use the gateway's existing rate limits, and write nothing (`mcp_writes` doesn't change). Every result includes the providers' attribution and the disclaimer.

| Tool                           | What                                                                                          |
| ------------------------------ | --------------------------------------------------------------------------------------------- |
| `centre_list_sources`          | Every source with status, licence and last success                                            |
| `centre_get_source_health`     | One source: status and why, recent runs, last error                                           |
| `centre_get_situation`         | The NSW summary, the most serious records, and the sources not active                         |
| `centre_search_incidents`      | Incidents by words, hazard, level or watch area                                               |
| `centre_get_record`            | One record with its changes and possibly related records (derived)                            |
| `centre_search_warnings`       | Official warnings in force                                                                    |
| `centre_get_fire_danger`       | Ratings and bans by district                                                                  |
| `centre_get_observations`      | Weather, air, river or Kp observations, with their times                                      |
| `centre_list_road_disruptions` | Road closures and hazards (says when Live Traffic isn't available)                            |
| `centre_list_watch_areas`      | The caller's own watch areas: **names, kinds and settings only, never locations**             |
| `centre_list_changes`          | Detected changes in the last hours, optionally for a watch area                               |
| `centre_get_watch_briefing`    | A deterministic briefing (and an interpretation only if already prepared); never runs a model |

Watch-area writes through MCP were left out. They'd need a new `mcp_writes` outcome (a table rebuild) for little benefit, and the portal's form is where a location should be entered. Deploy the gateway **after** the portal Worker (see [Activation](#activation)).

## API

All under `/api/portal/centre`, with Access and `centre.use`. Writes need the portal's same-origin JSON rules; routes marked † need `portal.settings.manage`.

| Method and path                                                                                                                 | What                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /summary`, `GET /records`, `GET /map`, `GET /records/:id`                                                                  | Counts; filtered records (`q`, `category`, `kind`, `source`, `minLevel`, `watch`, `includeInactive`, `bbox`, `since`, `limit`); map features; one record with changes, series and correlations |
| `POST /records/:id/task`, `POST /records/:id/knowledge`                                                                         | Follow-up task; Knowledge note                                                                                                                                                                 |
| `GET /changes`, `GET /correlations`                                                                                             | Changes since a time; correlations                                                                                                                                                             |
| `GET /sources`, `PUT /sources/:id` †, `POST /sources/:id/refresh` †                                                             | Registry and health; switch on or off; collect now                                                                                                                                             |
| `GET/POST /watches`, `GET/PUT/DELETE /watches/:id`                                                                              | The caller's watch areas, with matches                                                                                                                                                         |
| `GET /alerts`, `POST /alerts/acknowledge`                                                                                       | The caller's alerts                                                                                                                                                                            |
| `GET /briefing`, `POST /briefing/interpret`, `POST /briefing/knowledge`                                                         | Briefing; interpretation; save to Knowledge                                                                                                                                                    |
| `GET/PUT /preferences`, `GET /settings`, `PUT /settings` †                                                                      | The caller's preferences; account settings                                                                                                                                                     |
| `GET/POST /wallboards`, `PUT/DELETE /wallboards/:id`, `POST /wallboards/:id/displays`, `DELETE /wallboards/:id/displays/:token` | The caller's wallboards and display credentials                                                                                                                                                |

Outside Access: `GET /display` (the display shell) and `GET /api/display/wallboard` (Bearer display credential). Both answer 404 unless the wallboard switch is on.

## Data retention

Settings → Account settings (owners and admins). Defaults:

- **Records:** kept 90 days after they're no longer current. Satellite detections, which don't allow history, are removed three days after they leave the provider's window.
- **Changes:** 180 days.
- **Measurements:** 30 days.
- **Collection history:** 30 days.
- **Alerts:** 90 days.
- **R2 snapshots:** 20 per source, for sources that allow history.
- **Watch areas:** past their end date are paused.

Retention runs every cron, deletes only what the settings say, and works with collection off.

## Privacy

- **Identity** is always the verified Access identity (portal and MCP) or a display credential (wallboards). No API or tool takes a person from its input.
- **Private per person:** watch areas, alerts, preferences, wallboards and display credentials, all read joined to the caller's email; anyone else gets 404. Public records are the same for everyone.
- **Locations of watch areas** never appear in logs, audit entries, MCP results, AI prompts or wallboard payloads (tested).
- **Credentials:** the TfNSW and NASA keys are Worker secrets, sent only to their own hosts, and never logged, stored, shown or returned (tested). Display credentials are stored as hashes.
- **Untrusted feed content:** fenced before any model sees it, rendered only as text (React escapes it; markup is stripped at collection), never executed, and unable to issue commands or change records. Feeds only produce records.
- **Fixtures:** the local fixture transport (`CENTRE_FEED_BASE`) works only with `ENVIRONMENT=development` on a localhost `SITE_URL`, which nothing deployed can meet. `check:config` refuses it in a deployed config, and its records are labelled.

## Costs

On the existing Workers Paid plan, with no new paid service. Estimates assume every implemented anonymous source switched on (not measured in production):

| Driver             | Estimate                                                                                                                                                                     |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker invocations | No new requests: collection runs inside the existing cron (96 runs a day). Each run makes up to about 20 outbound requests or FTP sessions (subrequest limit: 1,000 on Paid) |
| CPU                | Parsing is small (the biggest inputs are BoM observations, 0.5 MB, and DEA hotspots, up to about 1.5 MB). Hundreds of milliseconds per run, well under limits                |
| D1 rows written    | Changed records only, plus "last seen" at most hourly per record: roughly 20,000–60,000 rows a day with hotspots on, within the included 50 million a month                  |
| D1 storage         | Tens of MB with default retention (series and hotspots dominate)                                                                                                             |
| R2                 | At most 20 small gzipped snapshots per source: well under 50 MB                                                                                                              |
| Workers AI         | Zero unless someone asks for an interpretation: about 600 tokens out, a few hundred Neurons, within Daly Intelligence's budgets                                              |
| Provider usage     | Each feed is fetched once per interval for everyone (never per person or per screen). Conditional requests and listing times avoid downloading unchanged data                |
| Wallboards         | One small D1-backed request per screen per refresh interval (60 s default): about 1,440 a day per screen                                                                     |

Limits in code: request timeouts (20–90 s), byte limits per source (0.5–12 MB), 3,000 hotspots, 5,000 stored and 1,500 drawn vertices per area, 400 KB geometry, eight sources per run, three at a time, 2,000 map records (configurable), 50 watch areas and 10 wallboards per person, and alert and display rate limits.

## Activation

None of this is done by this pull request. In order, each with the owner's approval:

1. **Review and merge.** Merging to `main` runs the deploy workflow, which applies `0025` (additive) and deploys. Take `npm run db:backup -- --env production` first.
2. **Check terms** for the sources marked Awaiting verification ([INTELLIGENCE_SOURCES.md](INTELLIGENCE_SOURCES.md)), especially the BoM's personal-use terms.
3. **Optionally register for keys:** Transport for NSW Open Data and NASA FIRMS. Then `npx wrangler secret put TFNSW_API_KEY --env=""` and `npx wrangler secret put NASA_FIRMS_MAP_KEY --env=""`. `npm run check:config` reports them without values.
4. **Switch sources on** in Intelligence Centre → Sources, and use **Refresh now** on each. Confirm each becomes Active.
5. **Switch collection on** (Portal settings → Features → Intelligence Centre collection). Watch the Sources page and History for a day.
6. **Optional:** alert emails (needs `EMAIL_DELIVERY`), and wallboard displays.
7. **MCP:** after the portal is live, deploy the gateway by hand (`npm run mcp:deploy:dry-run`, then `npx wrangler deploy --config mcp/wrangler.jsonc --env production`). Deploying 2.6.0 first would advertise twelve tools the portal can't serve yet.

**Ask the NSW SES** (`warnings.capability@ses.nsw.gov.au`) about direct access to its warnings feed if flood and storm warnings are wanted. An adapter can be added once access and terms are confirmed.

## Rollback

- **Instant, no deploy:** switch collection, email and wallboards off (Features), or switch individual sources off (Sources). Revoke display credentials on the Wallboards page.
- **Code:** `npx wrangler rollback <version> --env=""`. Leave `0025` in place: the previous Worker never reads the `ic_*` tables.
- **Gateway:** `npx wrangler rollback --config mcp/wrangler.jsonc --env production` to 2.5.0 (73 tools).
- **Data:** public records can be collected again. Watch areas, alerts, preferences and wallboards are in the regular D1 backups (`npm run db:backup`, checked by `npm run test:backup`), and D1 Time Travel covers recent mistakes.

## Tests

| File                                          | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/centre-ingest.test.ts`                  | Every adapter (RFS four, BoM warnings, observations and water, GA, DEA, air quality batching, Endeavour, ACT without ambulance, NOAA, TfNSW and FIRMS keys never stored); statuses (never Active before a validated retrieval); baseline; escalation, area change, rating and ban changes; "not in feed" never resolved and reappearing; idempotency and duplicate ids; conditional 304; replay refusal; backoff, failure and recovery; lease; the scheduler and its switch; stale; snapshots; retention; permissions                                                                                                                 |
| `test/centre-security.test.ts`                | SSRF (hosts, private and numeric addresses, credentials, ports, schemes), redirects off-host and loops, streamed size limit, timeout, refused keys and rate limits, XXE and entity expansion, depth, count and size limits, entity decoding, markup stripped, encoding by byte order mark, geometry validation and thinning (never inventing points), CAP polygons, FTP listing parsing                                                                                                                                                                                                                                               |
| `test/centre.test.ts`                         | Access by role; cross-site refusal; watch-area privacy, validation, versions and every matching kind with reasons; alerts (once per change, never for "not in feed", other owner's own, levels, acknowledgement, Today, rate limit, opt-in email, quiet hours, lost access); correlation; briefing facts and gaps; grounding of interpretations; prompts without watch names or coordinates and reused interpretations; Tasks and Knowledge (idempotent); briefing to Knowledge; Today's section; MCP (twelve read-only tools, no coordinates, other people's watch areas, disclaimer, attribution, permissions); every page rendered |
| `test/centre-wallboard.test.ts`               | Credentials shown once and hashed; one wallboard only, nothing else in the portal; coarse frame without watch coordinates or names; refusal when unknown, revoked, expired, switched off or owner without access; rate limit; cross-site; profile ownership and validation; stored interpretation only; opt-in rounded outline; the display page (404 when off, no referrer, not on the wedding host); fragment parsing                                                                                                                                                                                                               |
| `test/mcp-contract.test.ts` and gateway tests | 85 tools, field-by-field contract, annotations                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `e2e/intelligence-centre.spec.ts`             | Every Centre page on desktop and Pixel 7 (no errors, no overflow, axe, fixture labels); the map draws (MapLibre canvas), layers switch, search and record page; a watch area added with the form; a wallboard at 1080p and 4K (rotation, pause by keyboard, offline banner and recovery, revocation, axe); a display without a valid address                                                                                                                                                                                                                                                                                          |

All fixtures are invented (`fixtures/intelligence-centre/`) and labelled. No test contacts a real provider.

## What has and hasn't been validated

|                                                                                 |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Live-tested locally** (19 October 2026, real services, the Worker in workerd) | RFS incidents (9), fire danger (21 districts), major updates (placeholder), incident alerts (empty envelope); BoM observations (196 stations, through the socket FTP client), BoM warnings listing and classification (63 products, none a warning); Water Data Online (station 410001); GA earthquakes (46); DEA hotspots (844); Endeavour outages (2 incidents); ACT (all ambulance, so none kept); NOAA (4). Pages, map and wallboard were viewed with that data in Chromium |
| **Implemented and tested with fixtures only**                                   | RFS CAP alerts with content; BoM warnings (no NSW warning was current); air quality (the live API timed out on large requests; the batched adapter wasn't re-run live); TfNSW and FIRMS (no keys)                                                                                                                                                                                                                                                                               |
| **Not validated**                                                               | Production deployment, cron behaviour on Cloudflare, real D1 and R2 volumes, live alert emails, real devices (Safari on iPhone and iPad, smart-TV and kiosk browsers: only Chromium was automated), Workers AI interpretation quality (a stand-in model was used)                                                                                                                                                                                                               |
| **Deferred**                                                                    | NSW SES warnings (permission), WaterNSW (registration), other states' feeds, BoM Space Weather API, TfNSW cameras, telecommunications and water-supply outages, watch-area writes through MCP, drawing a watch area on the map (coordinates are typed), push notifications                                                                                                                                                                                                      |

## Known limitations

- **Coverage:** no NSW SES flood or storm warnings (needs the SES's permission), so flood coverage is BoM warnings (text, by district) and the gauges you follow. Water Data Online can lag by days. Power outages are Endeavour Energy's network only. Roads need a TfNSW key.
- **BoM:**
    - Warnings name forecast districts, not areas, so watch-area matching goes through the nearest station's district (an approximation).
    - With 60+ products to classify, the first collection reads up to 80 sidecars; a busy day could leave some for the next run.
- **Data quality:** air quality readings rotate six sites at a time when every site is followed. RFS `pubDate` and descriptions are read as Sydney time.
- **Limits by design:** correlation rules are few and deliberately conservative. Map labels have no text (no font downloads); names are in the details panel and the list.
- **Not done yet:** watch areas are entered as coordinates (no drawing on the map yet). Email alerts are the only push channel (no mobile push).
