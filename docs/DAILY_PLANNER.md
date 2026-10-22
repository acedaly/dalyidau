# Today (formerly the Daily Planner)

This document covers **[Today](#today)**, the daily dashboard at `/portal/today`. It keeps its old file name because other documents link to `DAILY_PLANNER.md#today`.

> **The Daily Planner is retired.** Time blocks, estimates, suggested sessions, Plan My Day, morning planning, the evening review, routines and Quick capture were removed with Daly Tasks and Daly Knowledge (`docs/DECOMMISSION_KNOWLEDGE_TASKS.md`). `/portal/calendar/planner`, `/api/portal/calendar/planner/*` and `/api/portal/today/plan` and `/reviews` answer **410**, and the `planner_*` and Today planning MCP tools are refused with `"retired"`. Their tables (`task_time_blocks`, `task_estimates`, `daily_reviews`) are kept untouched until the owner approves the cleanup. The planner's **planning hours** were kept: they're the same `planner_preferences` row, now edited from Customise Today.

---

# Today

One place to see the day: `/portal/today` brings together Daly Calendar (events, shared and subscribed calendars, leave and holidays), portal notifications, Home & Assets and Intelligence Centre sections, and a Chief of Staff briefing, with an optional explanation from Daly Intelligence.

There's no feature switch, secret or binding of its own.

## Principles

- **Today owns no events.** Calendar is the source of truth. Today reads events, leave and holidays through Calendar's own functions and access rules, and the one change it offers, **Add appointment**, goes through Calendar's event API (`POST /api/portal/calendar/events`) with its permissions and history. Today's own records are only its preferences and the person's planning hours.
- **Deterministic, and it works without AI.** Capacity, overbooked periods, the timeline and recommended next actions come from fixed rules over the records (`src/shared/today/availability.ts`, `src/shared/today/engine.ts`). AI is an optional explanation on top, and can't add facts.
- **Private.** Everything Today shows is the signed-in person's own view: others' private events in shared calendars are "Busy", and preferences and planning hours belong to one person.

## Architecture

```
src/shared/today/
  availability.ts          Planning hours (validated), interval arithmetic, availability for a day
  engine.ts                Capacity with interval unions, overbooked periods, the timeline, next actions
  types.ts                 Preferences (validated), dashboard, capacity, timeline and briefing shapes
worker/today/
  window.ts                Planning hours (planner_preferences) and a window of events, leave and availability
  dashboard.ts             The dashboard, part by part (plan, commitments, notifications, briefing)
  briefing.ts              Chief of Staff facts and next actions
  prefs.ts                 Today preferences
  api.ts                   /api/portal/today/*
worker/mcp/today.ts        3 read-only MCP tools
src/portal/today/
  pages/today-page.tsx     The page
  sections.tsx             Briefing, capacity, timeline, commitments, notifications
  add-appointment.tsx      Add appointment (through Calendar's API)
  settings-dialog.tsx      Customise Today
  planning-hours-dialog.tsx  Planning hours and buffers
  assets-section.tsx centre-section.tsx   Home & Assets and Intelligence Centre sections
  today-api.ts             Browser client
```

Today is a portal-level page (not inside one application), so the sidebar shows it under **Applications**, above **All Applications**, and the launcher (`/portal`) has a **Today** card above the application cards.

**Intelligence Centre:** unread Centre alerts for the person's own watch areas appear in Today's notifications (source `intelligence-centre`), and a short "Conditions in your watch areas" card sits above the sections. It shows only matching warnings and incidents from the person's chosen level, fire danger for their districts, closures and outages, and optional calendar matches. It has at most six lines and doesn't appear when nothing is relevant. A failure there never stops Today loading. Configured in Intelligence Centre → Settings, not in Today's own preferences.

**Home & Assets:** a section (on by default, each person's own, Home & Assets → Settings) lists what's overdue or due in the next 30, 60 or 90 days (registration, renewals, servicing, warranties, inspections, leases, urgent repairs), each a sentence from a record. See [HOME_ASSETS.md](HOME_ASSETS.md#integrations).

## Data

| Table                 | Holds                                                                                                                                                                                                                                                       |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `today_preferences`   | One JSON document per person (`0024`, validated by `todayPreferences`): sections and their order, timeline view (list or grid), "Open in Calendar" view, start view, calendars left out of availability, breaks, briefing detail, AI explanation, lookahead |
| `planner_preferences` | One JSON document per person (`0023`, validated by `planningHours`): planning hours per weekday, the buffer kept after each event, and "plan on days off"                                                                                                   |

Documents saved before the retirement can hold the planner's session lengths, focus limit and default estimate, or Today's task sections, focus periods and "show completed". They're read past rather than failing validation, so nobody loses their hours, breaks or calendars, and they're dropped the next time the person saves. Each save is versioned (a stale save is a 409).

History goes to `calendar_activity` with ids only: `today.preferences` and `planner.preferences`.

## User journeys

- **Open Today.** A greeting and the date in your time zone (Australia/Sydney unless you changed Calendar's), then the sections in your order: Chief of Staff briefing, capacity, timeline, commitments (your own today; shared household calendars for the next days) and notifications (Calendar notices and Intelligence Centre alerts).
- **Change day.** Today, Tomorrow, the previous and next day, or any date within a year with the date picker. These are plain links (`?date=`).
- **Timeline.** Events (marked read-only for subscribed, imported or view-only calendars, and shared), breaks, part-day leave and free time, in time order. All-day items (holidays, leave, all-day events) sit above. The list works on every screen; on larger screens the timeline can be shown as Calendar's time grid. Opening an event goes to it in Calendar.
- **Add appointment.** Title, calendar (only ones you can write to), date and time. It's created through Calendar's own API, then the page reloads so the timeline shows it.
- **Customise Today.** Sections and order, start view, timeline view, "Open in Calendar" view, briefing detail and lookahead, the AI explanation, which calendars count towards availability, breaks, and **Planning hours and buffers** (working hours for each weekday, the buffer after each event, and whether days off count).

## Capacity calculations (`dayCapacity`)

All of it is interval arithmetic on instants for the day, from local midnight to the next (so 23- and 25-hour days are exact):

1. **Available** = planning hours for the weekday (default Monday to Friday, 9 to 5) less public holidays and non-working days (your work pattern), less requested, approved or taken leave (full, morning, afternoon or hours; never drafts, proposals or scenarios), less **breaks**. "Plan on days off" counts weekends, holidays and leave too.
2. **Appointments** = the union of busy timed events (yours, shared, subscribed and imported) inside the available hours. Two overlapping meetings take their time once. Free events, all-day events, cancelled occurrences and calendars you left out of availability don't count.
3. **Free** = available less appointments. The timeline's free slots also keep your buffer (default 10 minutes) after each busy event.
4. **Outside hours** = commitments that day outside the planning hours (shown, but not taken from capacity).
5. **Overbooked** = periods where two or more busy commitments overlap (a sweep over start and end points; back-to-back isn't an overlap), merged when they touch, with what overlaps there.
6. **Status**: Day off (no hours), Overbooked (an overlap), Full (less than 20% free), Light (less than half committed), otherwise Balanced.

Each figure comes with a plain explanation ("How this was worked out"). The same function runs for the page and MCP, and the result doesn't depend on the order records arrive in.

## Chief of Staff briefing

Today's briefing (`worker/today/briefing.ts`) lists, each with a link to its record: today's commitments, overbooked periods, capacity, and shared household commitments (your lookahead). **Recommended next actions** come from fixed rules, in a fixed order: the next commitment within an hour, conflicts, and a fully booked day. If nothing applies, it says so rather than inventing something. It also says what wasn't read (email, messages, finances, services outside the portal). No model is involved.

**Explain my day** (when Intelligence is open to you and the explanation is on in Customise Today) asks Daly Intelligence's daily briefing for recommendations (`POST /api/portal/intelligence/briefings/daily/recommend`): Intelligence's switches, budget, circuit breaker and `fence()` apply, every reference a model returns must be one of the briefing's own facts or it's dropped, and recommendations are reused while the facts' fingerprint is unchanged. Nothing calls a model when Today loads. See [INTELLIGENCE.md](INTELLIGENCE.md#chief-of-staff-briefings).

For MCP and anything an assistant reads, event titles follow Calendar's rules for AI: others' private events "Busy", sensitive events "Private event". On your own Today page you see your own sensitive events' titles, as in Calendar.

## Permissions

1. Cloudflare Access and the portal's JWT check, unchanged.
2. Today needs **`calendar.use`** (owners and admins). The API answers 403 otherwise; the page shows the portal's "no access" page; the sidebar link and launcher card only appear for people who have it.
3. Events are read through Calendar's own access: calendar membership (hidden calendars stay out; others' private events are "Busy"). Only calendars you can see can be left out of availability, and Add appointment only offers calendars you can write to.
4. Preferences and planning hours are per person and versioned.

## API

All under `/api/portal/today`, behind Access, the portal role and the same-origin checks.

| Method and path        | What                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------- |
| `GET ?date=&parts=`    | The dashboard, or some parts of it (`plan`, `commitments`, `notifications`, `briefing`) |
| `GET/PUT /preferences` | Today preferences (with `version`)                                                      |
| `GET/PUT /hours`       | Planning hours and buffers in `planner_preferences` (with `version`)                    |

`/plan` and `/reviews` answer 410.

## MCP tools (3)

All read-only. They need `calendar.use`, take identity only from the re-verified Access token, use the same functions as the page, and write nothing (no `mcp_writes` rows). To add an appointment an assistant uses `calendar_create_event`, with its own checks, ledger and audit.

| Tool                 | Returns                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------- |
| `today_get_summary`  | Capacity, the timeline (excluding free time), all-day items and notifications, with links |
| `today_get_capacity` | Every capacity figure, overbooked periods and the explanation                             |
| `today_get_briefing` | The Chief of Staff briefing, with a link for every item and the recommended next actions  |

`today_list_unscheduled`, `today_propose_plan` and `today_get_conflicts` are retired and refused with `"retired"`. `PORTAL_MCP_TOOLS` and `mcp/src/portal-tools.ts` match field by field (`test/mcp-contract.test.ts`). See [MCP.md](MCP.md).

## Performance and caching

- The page's first render is one Worker request: the dashboard parts run in parallel over indexed D1 queries, plus the day's events and overlays for the time grid.
- After a change, only the affected parts are fetched again (`GET /api/portal/today?parts=…`), never the whole page.
- **Caching:** none on the server. Every part is computed from the records on each request. The only reused result is Intelligence's own recommendations, cached against its facts' fingerprint. No model call happens on load.

## Backup

`npm run db:backup` exports `today_preferences` and `planner_preferences` with everything else (`scripts/lib/ops.mjs`). The personal Calendar backup (Settings → Backup) doesn't include them.

## Limitations

- Today is for one person. Shared commitments are shared calendar events; nobody else's free time is planned jointly.
- Breaks repeat weekly on chosen weekdays; there are no one-off breaks (use a busy event).
- Capacity counts all-day events as free (use leave, a non-working day or a busy timed event).
- "Explain my day" uses Intelligence's daily briefing, which covers today only, whichever date Today shows.
- Adding an appointment reloads the page, so the time grid shows the new event.

## Testing

- `test/today-engine.test.ts`: interval arithmetic, buffers, planning hours saved by the retired planner, overbooked sweeps (back-to-back, triple overlaps), capacity unions, order independence, statuses, breaks, non-working days, public holidays, full and half-day leave, daylight saving, excluded calendars, timeline ordering, read-only items, free time after now, next-action rules and preference validation.
- `test/today.test.ts`: access (Calendar needed; wedding editors refused), 410s for Plan My Day, the reviews and the Daily Planner, the dashboard with overlaps counted once, selective parts, shared-calendar privacy ("Busy"), excluded calendars, preferences and planning hours (versions, validation, breaks in capacity, documents from before the retirement), the briefing's grounding, the three MCP tools (read-only, no ledger rows, retired tools refused), and the pages, sidebar and launcher.
- `e2e/today.spec.ts` (desktop and Pixel 7): axe and no horizontal scrolling, the launcher card and sidebar link; an appointment added from Today; planning hours saved from Customise Today, and the retired planner answering 410.
