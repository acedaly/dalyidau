# daly.id.au

Personal website and blog for Aidan Daly. The blog is written in [Amplenote](https://www.amplenote.com) and published automatically to a Cloudflare Worker ([docs/AMPLENOTE.md](docs/AMPLENOTE.md)); older articles from [Capacities](https://capacities.io) are archived in Cloudflare ([docs/CAPACITIES_RETIREMENT.md](docs/CAPACITIES_RETIREMENT.md)). No CMS, no paid hosting, no manual deploys for new posts.

The same Worker hosts a private portal at `/portal` (behind Cloudflare Access) with [Today](docs/DAILY_PLANNER.md#today), a daily dashboard built on the calendar, and six applications: the Wedding Planner, [Daly Calendar](docs/CALENDAR.md) (calendars, subscriptions, family planning, NSW holidays and a leave planner), [Daly Intelligence](docs/INTELLIGENCE.md) (calendar briefings and the portal's AI settings and budget, off by default), the [Intelligence Centre](docs/INTELLIGENCE_CENTRE.md) (public emergency, weather and environmental information with watch areas, alerts and wallboards, off by default) [Home & Assets](docs/HOME_ASSETS.md) (what the household owns, maintains, insures or will replace) and [Household Finance](docs/HOUSEHOLD_FINANCE.md) (bank CSV imports, balances and where the money goes; owners only); and the public wedding website at `/wedding`. Daly Knowledge and Daly Tasks are retired ([docs/DECOMMISSION_KNOWLEDGE_TASKS.md](docs/DECOMMISSION_KNOWLEDGE_TASKS.md)). See [docs/PORTAL.md](docs/PORTAL.md).

```
Amplenote note tagged website/blog ──(plugin, when published)──▶ Worker ──▶ D1 (articles) + R2 (images)
Capacities (retired: its articles are archived in D1/R2; sync off)                           │
                                                                                             │
Browser ◀── server-rendered React (Untitled UI) ◀── Worker fetch ────────────────────────────┘
```

## Quick start

```bash
npm ci
cp .dev.vars.example .dev.vars
scripts/local-up.sh            # mock Capacities API + wrangler dev on http://localhost:8787
npm run sync:local             # runs a real sync against the mock API
scripts/local-down.sh
```

| Command                           | What it does                                                                                           |
| --------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `npm run typecheck`               | TypeScript for the app, worker, tests and config                                                       |
| `npm test`                        | Builds the client, then runs the Vitest suite inside workerd with local D1 and R2                      |
| `npm run test:e2e`                | Playwright against `wrangler dev` and the mock API (desktop and mobile)                                |
| `npm run build`                   | Typecheck, client builds (blog, then portal and wedding site) and a Worker bundle dry run              |
| `npm run seed:portal`             | Fill a local portal with invented demo data (localhost only)                                           |
| `npm run check:config`            | Check an environment's configuration and secret names (never values); `-- --env staging`, `-- --url …` |
| `npm run check:bundle`            | After a build: no portal code in the blog bundle, no secrets in any client file                        |
| `npm run db:verify` / `db:backup` | Read-only database health check / verified backup ([docs/DATABASE.md](docs/DATABASE.md))               |
| `npm run seed:staging`            | Fictional demo data for staging (`-- --yes`) or a local database (`-- --local`)                        |
| `npm run deploy`                  | Manual production deploy (normally GitHub Actions does this)                                           |
| `npm run deploy:staging`          | Deploy the staging Worker                                                                              |

## Repository layout

```
src/                 React app (Untitled UI components), shared by server render and browser
  components/base…   Untitled UI React components (from the official starter kit)
  components/site/   Site components: header, footer, post cards, pagination, TOC, share links
  content/           Editable site settings and About copy
  pages/             Home, Blog, Article, About, Contact, 404
  portal/            The private portal: the wedding management app, Calendar, Today, Intelligence, the Intelligence Centre and Home & Assets
  wedding/           The public wedding website and RSVP form
  shared/portal/     Roles, feature flags and data types shared by the worker and the browser
  shared/calendar/   Calendar's time handling, repeat rules, NSW holiday data, leave engine and optimiser
  entry-server.tsx   renderToString for the Worker (blog, portal, wedding)
  entry-client.tsx   Blog hydration; entry-portal.tsx and entry-wedding.tsx for the other areas
worker/              Cloudflare Worker
  index.ts           Routing, SSR assembly, caching, media, admin API, cron handler
  sync.ts            Capacities → D1/R2 synchronisation
  capacities/        API client, schema mapping and block-to-HTML renderer
  posts.ts           D1 queries for public pages
  seo.ts             Meta tags, JSON-LD, sitemap, RSS, robots.txt
  portal/            Access verification, roles, audited CRUD, guests, comms, import/export, API
  calendar/          Calendar: membership, events and recurrence, ICS, subscriptions, feeds, leave, notifications, API
  today/ intelligence/ centre/ assets/   Today, Daly Intelligence, the Intelligence Centre and Home & Assets
  mcp/               PortalMcpEntrypoint: the MCP tools behind the gateway in mcp/
  wedding/           Public wedding pages and the RSVP engine
migrations/          D1 schema
fixtures/capacities/ Sample Capacities space and mock API (development and tests only)
test/                Vitest (workerd) tests
e2e/                 Playwright tests
docs/                Setup, deployment and operations
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md): how it fits together and why
- [Capacities setup and publishing](docs/CAPACITIES.md): the Blog Post type, publishing and unpublishing
- [Deployment](docs/DEPLOYMENT.md): Cloudflare resources, secrets, CI, DNS cut-over and rollback
- [Operations](docs/OPERATIONS.md): logs, manual resync, troubleshooting and running costs
- [Portal and wedding website](docs/PORTAL.md): Cloudflare Access setup, roles, feature switches, RSVPs, email, data model
- [Daly Intelligence](docs/INTELLIGENCE.md): Workers AI, briefings, budgets and usage, costs, backups and activation
- [Home & Assets](docs/HOME_ASSETS.md): the asset register, vehicles and trailers, places and rentals, maintenance, insurance, warranties, files, QR labels, reports, integrations, MCP, deployment and rollback
- [Household Finance](docs/HOUSEHOLD_FINANCE.md): the repository assessment and Milestone 11 plan, accounts and balance confidence, CSV imports and duplicates, categorising, transfers, the data model, deployment and rollback
- [Intelligence Centre](docs/INTELLIGENCE_CENTRE.md) and its [public sources](docs/INTELLIGENCE_SOURCES.md): ingestion, map, watch areas, alerts, correlation, briefings, wallboards, MCP, costs, activation and rollback
- [Communications](docs/COMMUNICATIONS.md): SMTP2Go email, ClickSend SMS, webhooks, consent and the activation checklist
- [Privacy and personal data](docs/PRIVACY.md): what's collected, retention, deleting and erasing
- [Database](docs/DATABASE.md): migrations, verification, backups, restore and rollback
- [Staging](docs/STAGING.md): the separate staging environment and how to set it up
- [Retiring Daly Knowledge and Daly Tasks](docs/DECOMMISSION_KNOWLEDGE_TASKS.md): what was removed, what's kept, MCP, deployment order, rollback and the owner-approved cleanup
- [Daly Calendar](docs/CALENDAR.md): calendars, recurrence and time zones, ICS subscriptions (SSRF rules) and private feeds, the Family Planner, NSW holidays and school dates, the leave engine and optimiser, MCP, deployment and rollback
- [Today](docs/DAILY_PLANNER.md#today): the daily dashboard at `/portal/today`: capacity from planning hours, the timeline, Add appointment, the Chief of Staff briefing and MCP
- [Daly MCP gateway](docs/MCP.md): Daly Portal for Claude, ChatGPT and Codex through `mcp.daly.id.au` (gateway Worker in `mcp/`): architecture decision, trust model, tools, audit, client set-up and testing
- [MCP cutover and DalyHub decommissioning](docs/MCP_CUTOVER.md): gateway 3.0.0, ordered production cutover, real-client checks, monitoring, rollback and the DalyHub retirement checklist
