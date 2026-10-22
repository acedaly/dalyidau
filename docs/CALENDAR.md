# Daly Calendar, Family Planner and Leave Planner (Milestone 6)

A personal and household calendar at `/portal/calendar`, built on the existing Worker, D1 and Access: day, week, month and agenda views, a 12-month year planner, personal and shared calendars, repeating events, external ICS/webcal subscriptions, private ICS feeds for other calendar apps, NSW public holidays and school terms, a family planner, and an annual leave planner with forecasts and a deterministic optimiser. It's connected to Today, Home & Assets, Intelligence (Chief of Staff) and the MCP gateway. There's no paid service and no AI in any calculation. Calendar works whether Intelligence is on or off.

**Status:** this is a draft PR. Nothing is merged or deployed, and migration `0022_calendar.sql` hasn't been applied anywhere remote. Both new switches start **off**. See [Deploying](#deploying).

The repository is public, so tests and fixtures only use invented people, events and calendars.

**Today**: [`/portal/today`](DAILY_PLANNER.md#today) shows Calendar's events, leave and holidays in one daily timeline, with capacity worked out from each person's planning hours. Its **Add appointment** goes through Calendar's own event API. External (subscribed or imported) events are only ever read there.

**Retired:** the Daily Planner (`/portal/calendar/planner`, time blocks and the Tasks panel), links from events to tasks, projects and Knowledge, the task overlay, and the feeds' task option were removed with Daly Tasks and Daly Knowledge. The planner's page and API answer 410; `calendar_event_links` is kept untouched until the owner approves the cleanup. See [DECOMMISSION_KNOWLEDGE_TASKS.md](DECOMMISSION_KNOWLEDGE_TASKS.md).

---

## How it fits together

```
src/shared/calendar/        Shared by the Worker and the browser (and so by MCP and Chief of Staff)
  types.ts                  Shapes, roles, categories, visibility, preferences (validated), page payloads
  time.ts                   Wall-clock ↔ instant conversion with Intl, date helpers, labels
  recurrence.ts             The editor's repeat rules ↔ RRULE text
  nsw.ts                    Official NSW public holidays and school periods, with source and verification date
  holidays.ts               Which holidays apply to a person; overlays
  leave.ts                  The leave engine: work patterns, booking costs, accrual, balances, forecasts
  optimiser.ts              Longest break, public holiday opportunities, cover a period, joint breaks
  views.ts                  What each view covers
worker/calendar/
  access.ts                 Calendar membership: the only way to reach a calendar or event
  calendars.ts events.ts    Calendars, members, events, occurrences, reminders
  expand.ts                 Recurrence expansion with ical.js (floating local time → instants)
  ics.ts                    ICS parsing (ical.js) and writing (with generated VTIMEZONEs)
  safe-fetch.ts secret.ts   SSRF-hardened fetching; subscription address encryption
  subscriptions.ts          External subscriptions and the background refresh
  feeds.ts                  Private outbound ICS feeds
  holidays.ts               Custom dates and overlays
  leave.ts planner.ts       Leave records; planning questions
  notify.ts                 Notifications (cron)
  export.ts xlsx.ts         Import, export, PDF, Excel, backup and restore
  chief.ts pages.ts api.ts  Chief of Staff facts, page loaders, /api/portal/calendar/*
worker/mcp/calendar.ts      17 MCP tools
src/portal/calendar/        Pages, views, event panel, year planner, leave UI
migrations/0022_calendar.sql
```

The application is registered in `src/shared/portal/applications.ts` (`calendar`, permission `calendar.use`, which owners and admins have). The views are adapted from Untitled UI PRO's calendar (`src/components/application/calendar/base-components`, installed with `npx untitledui@latest example informational-02/09`). The column headers, event pills, time marker and date icon are used as they are. The PRO `Calendar` itself works only in the browser's local time zone, keeps its own state and puts click handlers on plain `div`s, so it wasn't kept. Instead, `src/portal/calendar/views.tsx` builds controlled, keyboard-accessible views on those parts, in the person's own time zone. The event panel follows PRO's `create-event-menu` layout, using the portal's `RecordPanel`.

## Pages

| Page                          | What                                                                                                                                                                                                                        |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Calendar (`/portal/calendar`) | Day, week, month and agenda (`?view=`, `?date=`), calendar show/hide chips, search, notifications, the event panel (`?event=` opens one). Phones get a stacked week and a month grid with the chosen day's list underneath. |
| Year planner                  | Twelve months with NSW public holidays, school holidays, leave (yours and shared), busy days. Printable.                                                                                                                    |
| Family planner                | Shared and family-purpose calendars: the next eight weeks, care/pickup/drop-off with who it's for and who's responsible, birthdays and anniversaries, school holidays and who's away.                                       |
| Leave and balances            | Overview (balances today and on 31 December), bookings with status, forecast with the full calculation, adjustments, what-if scenarios (adopt as proposals). CSV, Excel and PDF.                                            |
| Plan time off                 | Questions answered from real days (below).                                                                                                                                                                                  |
| Leave settings                | Work pattern (weekly or a two-week roster), region, Bank Holiday, leave types with balance, accrual, cap and yearly reset, and sharing.                                                                                     |
| Calendars and sharing         | Calendars, members and roles, your colour, ICS export, private feeds.                                                                                                                                                       |
| Subscriptions                 | Add, rename, colour, personal/shared, enable/disable, show/hide, refresh interval, refresh now, last success, errors, remove.                                                                                               |
| Holidays and school dates     | Official NSW data with sources and verification dates; your school's own dates, regional holidays and non-working days.                                                                                                     |
| Settings, import and export   | Time zone, week start, default view, school division, overlays, reminders and notifications, one-time ICS import, exports, backup and restore.                                                                              |

## Who can see what

1. **Cloudflare Access** and the portal's JWT check, unchanged.
2. **Portal role → `calendar.use`**: owners and admins. Wedding editors and viewers get 403.
3. **Calendar membership** decides everything inside, checked on the Worker for every request:
    - Every calendar, event, subscription and reminder is reached joined to the caller's own `calendar_members` row. A calendar you're not in is a **404**, whether it exists or not. Being a portal owner grants nothing.
    - Roles: **owner** (everything, including sharing and deletion), **editor** (events), **viewer** (read), **free/busy** (only that time is busy: no title, place, notes or people).
    - **Personal** calendars can only be shared as free/busy. **Shared** calendars are for the household. The database enforces both with triggers (and refuses editors on subscribed calendars).
    - Each person has their own colour and show/hide for each calendar.
4. **Event visibility**: `default` (the calendar's members see the details), `private` (only the creator sees them; everyone else sees "Busy" and can't open it), and `sensitive` (private, and also never shown with details in feeds, emails, briefings or MCP tools, even to the creator's AI assistant). Use sensitive for children, care and health.
5. **Leave is always the person's own.** Sharing (`leave_shares`) lets chosen people see your leave dates and status, never balances, notes or titles.
6. History (`calendar_activity`) records who did what to which record: ids only, never titles, text, URLs or hours. Calendar writes don't go to the wedding `audit_log`.

## Events, recurrence, time zones

- Events store their **wall-clock date and time in their own IANA zone** (default: the calendar's zone, `Australia/Sydney`), plus the UTC instants of the first occurrence and the end of the series, for window queries. All-day events are floating dates.
- Recurrence is RFC 5545 RRULE. The editor offers daily, weekdays, weekly on chosen days, fortnightly, monthly on a date or an nth/last weekday, and yearly, ending never, on a date or after N times. Feeds can carry any rule. Those are kept exactly as they are and shown as "Custom repeat".
- **Expansion** (`worker/calendar/expand.ts`) uses ical.js to iterate in floating local time, then converts each occurrence with Intl. A weekly 9 am meeting stays at 9 am on both sides of a daylight-saving change (tested across 4 October 2026). ical.js rolls impossible dates forward (a yearly 29 February became 1 March). RFC 5545 says those occurrences don't exist, so they're skipped, as Google and Apple do.
- Single-occurrence changes live in `calendar_event_overrides`, keyed by the occurrence's original local start. **This and following** splits the series. Removing one occurrence adds an exclusion, and Restore undoes it. Edits carry the version you read, so a stale edit gets 409 with the current event.
- Views show events in the viewer's time zone and mark events from another zone. Expansion is bounded (2,000 occurrences per window, 50,000 iteration steps), and the page says when it was cut short.
- A time inside the hour daylight saving skips comes out an hour later. In the repeated hour in April, `zonedInstant` (`src/shared/calendar/time.ts`) currently picks the **second** 2:30, although its comment says the first. Calendar only relies on the round trip, which is correct either way.

## External subscriptions

- Paste an `https://` or `webcal://` address (Google secret/public address, iCloud public calendar, Outlook published ICS, a school, club or holiday feed). The address is **checked and fetched before anything is saved**. Addresses that can't work are refused with the reason. One that's only temporarily unreachable is saved and retried.
- **Refresh**: every 6 hours by default (1 hour to 1 week), from the existing 15-minute cron, at most 4 per run, with a lease so overlapping runs never fetch the same feed. Conditional requests (ETag, Last-Modified) mean an unchanged feed costs a 304.
- **Sync**: events are matched on UID, so an event keeps its id, links and reminders when the feed changes it. A content hash skips unchanged events. `RECURRENCE-ID` instances become single-occurrence changes. `STATUS:CANCELLED` and events that disappear from the feed are removed. A feed that suddenly returns nothing is believed only when a second refresh agrees (fail safe).
- **Failures** back off (15 min doubling, capped at the interval and at a day) and never stop the schedule. After three in a row the owner gets a notification, and every Calendar page shows a warning.
- **Read-only**: subscribed events can't be edited, and nobody can be an editor of a subscribed calendar (enforced by the database). You can still add your own reminders and links to them.
- **Time zones**: IANA TZIDs (Google, Apple), Windows names (Outlook/Exchange: `AUS Eastern Standard Time` and others), a feed's own VTIMEZONE, UTC, and floating times in the feed's `X-WR-TIMEZONE` or the calendar's zone. Sub-daily repeats (HOURLY, MINUTELY) are shown once rather than expanded.
- **Untrusted content**: control and direction-override characters are stripped, lengths capped (title 300, description 8,000), only http(s) links kept, at most 5,000 events per feed. Nothing from a feed is ever rendered as HTML.

### SSRF protection (`worker/calendar/safe-fetch.ts`)

- https only (webcal is converted). No `user:password@`, no port other than 443.
- No IP literals at all. Private, loopback, link-local, CGNAT, multicast, documentation and special ranges are refused, including IPv4 inside IPv6 (`::ffff:`, NAT64). So are `localhost`, single-label names and internal suffixes (`.local`, `.internal`, `.lan`, `.home.arpa`…), and this site's own hosts (`daly.id.au` and its subdomains).
- The name is resolved over DNS-over-HTTPS (Cloudflare's resolver). If **any** A/AAAA answer is private, the fetch is refused.
- Redirects are followed by hand (at most 3) and every hop goes through the same checks. An https → http redirect is refused.
- A 15-second timeout, and at most 5 MB read while streaming (whether or not the server says how big it is). HTML, JSON, images and anything not starting with `BEGIN:VCALENDAR` are refused.

### Subscription addresses are credentials

They're never returned to the browser after they're added. Pages and MCP show only the host (`calendar.google.com/…`). They're never logged and never written to history or backups. Only a SHA-256 fingerprint is used for duplicate checks. With the optional **`CALENDAR_ENCRYPTION_KEY`** secret (32+ characters), they're stored AES-GCM encrypted, and addresses stored before the key was set are encrypted at their next refresh. If the key is later removed or changed, those subscriptions report "key unavailable" and need adding again.

## Private feeds (outbound)

`/calendar/feed/<token>.ics`, outside `/portal`, because calendar apps can't sign in through Access. Each address is chosen per feed: which calendars, your approved and requested leave, and whether to include details or publish busy times only.

- The token is 256 bits of randomness, and only its SHA-256 is stored. **Rotate** issues a new address and ends the old one. **Revoke** ends it. The same 404 answers "switched off", "unknown" and "revoked".
- Every request re-checks the owner as they are now: they can still open Calendar, and for each calendar they're still a member (calendars they've lost are silently dropped). Free/busy calendars, private and sensitive events are always "Busy". Subscribed calendars are never republished.
- Series are published as RRULE + VTIMEZONE (generated from Intl's own transitions) + RECURRENCE-ID, so other apps show the same times.
- Responses are `text/calendar`, `private, max-age=300`, `noindex`, `no-referrer`. Access is recorded at most every 15 minutes.
- The whole route is behind the **Calendar subscription addresses** switch (`calendar.feeds`), **off by default**. One-way only: changes made in another app never come back.

## The leave engine

Everything is in hours, worked out day by day from the person's own settings (`src/shared/calendar/leave.ts`). It's the same code in the browser, the Worker, MCP and Chief of Staff.

- **Work pattern**: hours per weekday, or a 14-day roster from a "week 1" Monday (rostered days off, 9-day fortnights, part time).
- **What a booking costs**: each day's ordinary hours. Days you don't work and configured non-working days cost nothing. Public holidays that apply to you (NSW statewide and additional days, your region's custom holidays, the Bank Holiday if you choose it) aren't deducted unless the leave type says to. Half days are half the day's hours, or you give a number of hours. Unusual days can carry their own hours.
- **Accrual**: per ordinary hour worked (NES presets: annual 4/52 ≈ 0.0769; personal/carer's 2/52; NSW long service 8⅔ weeks per 10 years), or a fixed amount per period, or none (adjust by hand). Paid leave and public holidays accrue; unpaid leave and non-working days don't. An optional cap (carry-over assumption) and yearly reset are supported.
- **Balances**: from the balance the person entered, as at its date, forward: accrual, then adjustments, then leave taken, then any reset, each day. Bookings on or before the balance date are assumed to be in that balance already. A breakdown shows every step, the lowest point and the first day it goes negative.
- **Statuses**: draft, proposed, requested, approved, taken, cancelled. Forecasts count _approved and taken_ ("confirmed"), plus _requested and proposed_ ("planned"), or plus _drafts_. Cancelled leave never counts. Nothing is ever assumed approved: only the person marks leave approved or taken, in the portal. MCP can only create drafts and proposals, and can't change leave once it's requested.
- **Scenarios**: bookings attached to a scenario count only when that scenario is being looked at, on top of the real plan. **Adopt** copies them in as proposals.
- Balances are estimates from the person's own settings, not their employer's records, and every page says so.

### Planning questions (`worker/calendar/planner.ts`, `src/shared/calendar/optimiser.ts`)

A day is "off" if you don't work it, it's an applicable public holiday or a non-working day, or you already have leave on it. Any other day costs its hours. Questions:

| Question                             | How                                                                                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Leave for the July school holidays   | Cover the period, widened over adjacent weekends: leave days, hours, days off, balance afterwards.                                          |
| Longest break with 35 hours          | Two-pointer search for the longest run of days whose cost fits the budget; ties go to fewer hours, then earliest.                           |
| Best public holiday opportunities    | Join runs of days off with the least leave, ranked by days off per day of leave, then length; one suggestion per start.                     |
| Balance after two weeks in October   | Cost the dates, then forecast with them as a hypothetical booking.                                                                          |
| When can we both take leave?         | Only with someone who **shares** their leave with you: a day counts as off only when both are, each costed on their own pattern and budget. |
| Which school holidays have no leave? | Each upcoming period, whether leave is planned in it, and what covering it would cost.                                                      |

Answers list exact dates and hours. Years without official holiday data are flagged ("costed without public holidays").

## NSW holidays and school dates

`src/shared/calendar/nsw.ts` ships the official data, so leave never depends on a third-party feed:

- **Public holidays 2025–2027** come from nsw.gov.au (2026–2027) and the NSW 2025 iCalendar file, with New Year's Day 2025 and the Bank Holiday from the Act. That includes the additional days (Anzac Day 27 April 2026 and 26 April 2027; Boxing Day 28 December 2026; 27 and 28 December 2027). **2028 is provisional**, worked out from the Public Holidays Act rules and Easter, and labelled as such everywhere. The Bank Holiday is listed as "not a public holiday".
- **School terms, holidays and development days 2025–2028**, Eastern and Western divisions, come from education.nsw.gov.au. 2028 is published without development days and is marked provisional.
- Every entry has a source URL and a verification date (18 October 2026), both shown on the Holidays page.
- **Add a year**: copy the published dates into `nsw.ts`, set `verifiedOn`, update `COVERED_YEARS`, and run `npm test`. `test/calendar-engine.test.ts` checks weekdays, ordering, overlaps and sources.
- Regional public holidays, schools near the borders, non-government schools and a school's own pupil-free days are **custom dates**, personal or for the whole household. Custom school dates are shown alongside the official ones, never instead of them.

## Home & Assets and Chief of Staff

- **Home & Assets** dates (registration, roadside renewal, inspections, policy renewals, warranties ending, leases ending, maintenance due, and booked work without its own appointment) are a reminder overlay worked out from Home & Assets on each request, through its access rules, never copied as events. Each person can turn them off (`overlays.assets`, Settings → Overlays). A booked service can become a real appointment through `createEvent`, once per record. See [HOME_ASSETS.md](HOME_ASSETS.md#integrations).
- **Chief of Staff** (`chief_of_staff_daily_context` / `weekly_context`) and **Intelligence briefings** (the new "Calendar and leave" section) include: the next 7 or 14 days of events, overlapping commitments, important dates, planned leave, school holidays with and without leave, projected balances, and failing subscriptions. Calendar is no longer listed under `notChecked` for people with Calendar. Every fact is deterministic and linked. Private events are "Busy" and sensitive ones "Private event". AI can explain them, but never supplies dates, balances or approvals.

## MCP tools

| Tool                                                                                                                                                                                                               | Notes                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `calendar_list_calendars`, `calendar_list_events` (≤ 92 days), `calendar_search_events`, `calendar_get_agenda`, `calendar_find_conflicts`, `calendar_list_subscriptions` (failingOnly), `calendar_school_holidays` | Reads. Sensitive events are "Private event"; others' private events "Busy"; subscription addresses never returned. |
| `leave_get_balances`, `leave_list_bookings`, `leave_forecast`, `leave_find_opportunities`                                                                                                                          | Reads, from the leave engine and planner.                                                                          |
| `calendar_create_event`, `calendar_update_event`                                                                                                                                                                   | Writes, only in calendars the person edits; series/occurrence/following; version checked.                          |
| `calendar_create_subscription`, `calendar_refresh_subscription`                                                                                                                                                    | Writes. Same SSRF checks; at most one refresh a minute.                                                            |
| `leave_create_proposal`, `leave_update_proposal`                                                                                                                                                                   | Writes. **Draft or proposed only**; can cancel, never request, approve or take.                                    |

Seventeen of the gateway's 66 tools (3.0.0; [MCP.md](MCP.md)). Identity comes only from the re-verified Access token. Writes go through `mcp_writes` (ids only, request ids replay; the ledger was rebuilt in 0022 for `calendar_event`, `calendar_subscription` and `leave_booking`) and the gateway's write rate limit. There are no delete tools. `PORTAL_MCP_TOOLS` and `mcp/src/portal-tools.ts` are compared field by field in `test/mcp-contract.test.ts`. The gateway's instructions describe Calendar.

## Notifications

The cron calls `processCalendarNotifications` every 15 minutes. It creates:

- reminders for events with per-person reminders (up to 4 weeks ahead);
- leave starting within a week (requested or approved);
- school holidays starting within a fortnight (for the person's division);
- failing subscriptions (after three failures).

Each has a unique key `(person, kind, record, occurrence)`, so overlapping runs can't duplicate one. Access is re-checked before anything is created. Notifications show under the bell on every Calendar page. **Email** goes out only when the **Calendar reminder emails** switch (`calendar.reminders.email`, off) is on, an email provider is configured and the person turned email on. Emails say "an event in your calendar" and when, and include a title only if the person asked and the event isn't private or sensitive. They're retried with backoff and skipped if more than 6 hours late. Notifications older than 60 days are deleted.

## Import, export, backup

- **One-time ICS import** (Settings) copies events into one of your calendars as ordinary editable events, with a preview first. Importing the same file twice adds nothing (UID).
- **ICS export** per calendar (RRULE, VTIMEZONE, overrides; others' private events as Busy).
- **Leave**: CSV (formula-safe), an Excel workbook (`.xlsx` written by `worker/calendar/xlsx.ts`, no dependency: bookings, balances by month, a day-by-day year) and an A4 PDF year planner (pdf-lib).
- **Backup**: one JSON with your calendars, events, overrides, reminders, custom dates, leave and preferences, without subscription or feed addresses. **Restore** previews first, then adds everything as new records ("… (restored)"), matching leave types by name, and never changes or removes anything existing.
- Database backups (`npm run db:backup`) include all 18 tables. `npm run test:backup` fills and restores every one and checks that the triggers and rules survive. `npm run db:verify` has three new Calendar checks.

## Data model (`0022_calendar.sql`)

| Table                                                                                                     | Holds                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `calendar_preferences`                                                                                    | Each person's settings (JSON, validated)                                                                                                    |
| `calendars`, `calendar_members`                                                                           | Calendars (personal/shared, purpose, local/subscription, one default per person); members, roles, per-person colour and show/hide           |
| `calendar_events`, `calendar_event_overrides`                                                             | Events (wall clock + zone, instants, RRULE/RDATE/EXDATE, category, visibility, people, content hash, client id); single-occurrence changes  |
| `calendar_reminders`                                                                                      | Each person's reminders                                                                                                                     |
| `calendar_event_links`                                                                                    | Retired links to tasks, projects and Knowledge (ids, foreign keys). Kept, unread, until the approved cleanup                                |
| `calendar_notifications`                                                                                  | In-app notifications and email state, one per unique key                                                                                    |
| `calendar_subscriptions`, `calendar_feeds`                                                                | Subscriptions (sealed address, fingerprint, ETag, schedule, errors); feeds (token hash, scope)                                              |
| `calendar_custom_dates`                                                                                   | Your school dates, regional holidays, non-working days                                                                                      |
| `leave_profiles`, `leave_types`, `leave_adjustments`, `leave_scenarios`, `leave_bookings`, `leave_shares` | Pattern and settings; types with balance and accrual; adjustments; scenarios; bookings with status and client id; who sees your leave dates |
| `calendar_activity`                                                                                       | History without content                                                                                                                     |
| `mcp_writes`                                                                                              | Rebuilt (every row copied) to accept the three calendar outcomes; the same columns and indexes                                              |

Ids are prefixed random strings (`cal_`, `cev_`, `csb_`, `cfd_`, `crm_`, `cel_`, `cnt_`, `ccd_`, `lvt_`, `lvb_`, `lva_`, `lvs_`). The database refuses a personal calendar shared beyond free/busy, editors on subscribed calendars, a second default calendar, events ending before they start, part days spanning several days, and bookings without hours for "hours".

## Performance and cost

- **D1**: a window is one indexed query on `(calendar_id, start_at, series_end_at)`, plus overrides in chunks. Expansion runs in the Worker.
- **Subscriptions**: one conditional GET per feed per interval (default 6 h). DNS is two small DoH queries.
- **Feeds**: one build per request, which calendar apps typically make every few hours, with `max-age=300`.
- **Notifications**: bounded (500 reminder rows, 20 emails per run).
- **Bundles**: no new paid service. `ical.js` 2.2.1 runs only in the Worker. The Worker dry-run is 2,752 KiB (831 KiB gzipped). The portal browser bundle grew from about 2.40 MB to 2.58 MB.

## Known limitations

- **No two-way sync.** Subscriptions are read-only, and feeds publish one way. There are no CalDAV, Google or Microsoft APIs.
- The NSW data covers 2025–2028 (2028 provisional). Later years are costed without public holidays and labelled as such until they're added.
- Regional holidays, border schools and non-government schools have to be added as custom dates.
- Leave balances are estimates. Award-specific rules beyond accrual, cap, reset and public-holiday deduction (loadings, cashing out, pro-rata on service anniversaries for long service leave) aren't modelled. Use adjustments for those.
- Joint planning uses the partner's shared pattern with statewide holidays only. Their custom and regional dates and their balances aren't shared.
- A feed whose TZID is neither IANA nor a known Windows name, and that has no usable VTIMEZONE, is read in the calendar's zone.
- Notifications are in-app. Email needs the switch and a provider. There are no push notifications.
- Calendar was checked in Chromium (desktop and Pixel 7 emulation). Real-device checks of feeds in Apple Calendar, Outlook and Google Calendar still need doing.
- Bulk delete, attendees and invitations (RSVP to events), and attachments on events are not included.

## Testing

- `test/calendar-engine.test.ts`: daylight saving, view windows, recurrence (DST, exclusions, moved and cancelled occurrences, 29 February, counts, runaway rules), NSW data integrity, the leave engine (costs, part time, rosters, accrual, unpaid, statuses, scenarios, caps, resets, negatives) and the optimiser.
- `test/calendar-ics.test.ts`: Google, Outlook and UTC feeds, hostile content, writing and round-tripping ICS, VTIMEZONE, URL normalisation, private address detection (including mapped IPv6), DNS-based refusal, redirect checks, conditional requests, size, type and retry classification.
- `test/calendar.test.ts`: database guarantees, access (owners and admins only, CSRF), privacy (personal, free/busy, private, sensitive, search, removal), per-person show/hide, series/occurrence/following edits, stale edits, time zones, idempotent creates, subscriptions end to end (304, UID stability, cancellations, duplicates, SSRF after DNS, backoff, notifications, the empty-feed hold, rate limit, encryption), feeds (switch, privacy, hash-only storage, rotate, revoke, lost access, busy-only, no republishing), leave privacy and sharing, planning answers, exports, MCP (masking, proposals only, replay, no addresses, permissions), idempotent notifications, and backup and restore.
- `e2e/calendar.spec.ts`: launcher columns and card height at 375, 768, 1280 and 1680 px; every Calendar and Leave page on desktop and Pixel 7 with axe and no horizontal scroll; creating an event; holidays on the year planner; leave setup, booking preview, forecast and planner; unsafe subscription addresses.
- MCP contract and gateway tests cover the Calendar tools; `test:backup` covers 0022.

## Deploying

The steps below are from Milestone 6's release, kept for reference.

1. **Check remote migration state** (read-only): `npx wrangler d1 migrations list DB --remote --env=""`. `0022_calendar.sql` will be unapplied, and so will `0021` if Milestone 5 hasn't deployed.
2. **Back up and verify**: `npm run db:backup -- --env production`.
3. **Merge the draft PR** after review. **Merging to `main` deploys and applies migrations automatically** (`.github/workflows/deploy.yml`), including 0022's `mcp_writes` rebuild (every row is copied, and the earlier Worker only writes entity types the rebuilt ledger still accepts). By hand instead: `npx wrangler d1 migrations apply DB --remote --env=""`, then `npx wrangler deploy --env=""`.
4. `npm run db:verify -- --env production`.
5. Open `/portal/calendar` as each owner. Each gets a default calendar on first visit. Set up leave from a payslip. Create a shared household calendar and add the other owner.
6. **Optional configuration** (owner's choice; none is needed for the core app):
    - `npx wrangler secret put CALENDAR_ENCRYPTION_KEY --env=""` (e.g. `openssl rand -base64 48`) to encrypt subscription addresses. Set it before adding subscriptions, or they're encrypted at their next refresh.
    - Portal settings → Features (also linked from Calendar → Settings and Portal settings → Calendar & Subscriptions) → **Calendar subscription addresses** (`calendar.feeds`) to serve private feeds. Off by default because anyone with an address can read it.
    - Portal settings → Features (also linked from Calendar → Settings and Portal settings → Calendar & Subscriptions) → **Calendar reminder emails** (`calendar.reminders.email`), plus the existing `EMAIL_DELIVERY` secrets. Off by default; send yourself a test reminder first.
7. **MCP**: the gateway is deployed by hand only (`npm run mcp:deploy:dry-run`, then `npx wrangler deploy --config mcp/wrangler.jsonc --env production`), after the portal Worker is live with 0022. It changes code only (Worker `dalyhub-mcp`). The current gateway is 3.0.0: follow [MCP_CUTOVER.md](MCP_CUTOVER.md).
8. No DNS, `routes` or Access changes. `/calendar/feed/*` is a path on the existing domain outside the Access application's `portal` and `api/portal` paths. That's intended: calendar apps can't sign in, and the token is the credential.

**Rollback**: redeploy the previous Worker (`npx wrangler rollback --env=""`). The new tables are ignored by earlier code. The rebuilt `mcp_writes` keeps the same columns, and earlier code writes only entity types it still accepts. D1 has no down migrations, so reverting the schema means restoring a backup (or D1 Time Travel to the bookmark logged before migrating). Switching the two switches off stops feeds and emails immediately. Disabling a subscription stops its fetches.
