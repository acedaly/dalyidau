# daly.id.au

Personal website for Aidan Daly: projects, writing and an About page, on a single Cloudflare Worker. Content is written in Payload CMS at `daly.id.au/admin` and published straight to the site, with no deploy ([docs/WEBSITE-GUIDE.md](docs/WEBSITE-GUIDE.md)). Articles published earlier from Capacities and Amplenote stay online as stored ([docs/CAPACITIES_RETIREMENT.md](docs/CAPACITIES_RETIREMENT.md)).

The same Worker hosts the public wedding website (`wedding.daly.id.au`) and a private portal at `/portal` (behind Cloudflare Access) whose one application is the Wedding Planner, also installable as a phone app at `weddingplanner.daly.id.au` ([docs/PLANNER.md](docs/PLANNER.md)). See [docs/PORTAL.md](docs/PORTAL.md). The portal's other applications are retired: Daly Knowledge and Daly Tasks ([docs/DECOMMISSION_KNOWLEDGE_TASKS.md](docs/DECOMMISSION_KNOWLEDGE_TASKS.md)), Home & Assets and Household Finance ([docs/DECOMMISSION_ASSETS_FINANCE.md](docs/DECOMMISSION_ASSETS_FINANCE.md)), and Daly Calendar, Today, Daly Intelligence, the Intelligence Centre and Amplenote publishing ([docs/DECOMMISSION_PORTAL_APPS.md](docs/DECOMMISSION_PORTAL_APPS.md)).

```
Capacities Blog Post (Status: Published) ──(cron, every 15 min, while sync is on)──▶ Worker ──▶ D1 (articles) + R2 (images)
                                                                                                  │
Browser ◀── server-rendered React (Untitled UI) ◀── Worker fetch ─────────────────────────────────┘
```

## Quick start

```bash
npm ci
cp .dev.vars.example .dev.vars
scripts/local-up.sh            # mock Capacities API + wrangler dev on http://localhost:8787
npm run sync:local             # runs a real sync against the mock API
scripts/local-down.sh
```

| Command                           | What it does                                                                                   |
| --------------------------------- | ---------------------------------------------------------------------------------------------- |
| `npm run typecheck`               | TypeScript for the app, worker, tests and config                                               |
| `npm test`                        | Builds the client, then runs the Vitest suite inside workerd with local D1 and R2              |
| `npm run test:e2e`                | Playwright against `wrangler dev` and the mock API (desktop and mobile)                        |
| `npm run build`                   | Typecheck, client builds (blog, then portal and wedding site) and a Worker bundle dry run      |
| `npm run seed:portal`             | Fill a local portal with invented demo data (localhost only)                                   |
| `npm run check:config`            | Check production's configuration and secret names (never values); `-- --offline`, `-- --url …` |
| `npm run check:bundle`            | After a build: no portal code in the blog bundle, no secrets in any client file                |
| `npm run db:verify` / `db:backup` | Read-only database health check / verified backup ([docs/DATABASE.md](docs/DATABASE.md))       |
| `npm run deploy`                  | Manual production deploy (normally GitHub Actions does this)                                   |

## Repository layout

```
src/                 React app (Untitled UI components), shared by server render and browser
  components/base…   Untitled UI React components (from the official starter kit)
  components/site/   Site components: header, footer, post cards, pagination, TOC, share links
  content/           Editable site settings and About copy
  pages/             Home, Blog, Article, About, Contact, 404
  portal/            The private portal: the Wedding Planner's management pages and Portal settings
  planner/           Wedding Planner, the installable phone app
  wedding/           The public wedding website and RSVP form
  shared/portal/     Roles, feature flags and data types shared by the worker and the browser
  entry-server.tsx   renderToString for the Worker (blog, portal, wedding)
  entry-client.tsx   Blog hydration; entry-portal.tsx, entry-planner.tsx and entry-wedding.tsx for the other areas
worker/              Cloudflare Worker
  index.ts           Routing, SSR assembly, caching, media, admin API, cron handler
  sync.ts            Capacities → D1/R2 synchronisation
  capacities/        API client, schema mapping and block-to-HTML renderer
  posts.ts           D1 queries for public pages
  seo.ts             Meta tags, JSON-LD, sitemap, RSS, robots.txt
  portal/            Access verification, roles, audited CRUD, guests, comms, import/export, API, retired addresses
  planner/           Wedding Planner's manifest, service worker and offline page
  mcp/               PortalMcpEntrypoint: the portal's end of the MCP gateway in mcp/ (it serves no tools now)
  wedding/           Public wedding pages and the RSVP engine
migrations/          D1 schema
fixtures/capacities/ Sample Capacities space and mock API (development and tests only)
test/                Vitest (workerd) tests
e2e/                 Playwright tests
docs/                Setup, deployment and operations
```

## Documentation

- [Running the website from Payload](docs/WEBSITE-GUIDE.md): publishing, projects, images, search settings, the menu, redirects, history
- [Backup, deployment, rollback and recovery](docs/RECOVERY.md): what to do when something goes wrong, and the known limitations
- [Architecture](docs/ARCHITECTURE.md): how it fits together and why
- [Findings register](docs/AUDIT-2026-11.md): the November 2026 audit, and what each phase fixed
- [Capacities setup and publishing](docs/CAPACITIES.md): the Blog Post type, publishing and unpublishing
- [The Capacities sync switch and archive](docs/CAPACITIES_RETIREMENT.md): keeping articles online without Capacities, and when it's safe to cancel
- [Deployment](docs/DEPLOYMENT.md): Cloudflare resources, secrets, CI, DNS cut-over and rollback
- [Operations](docs/OPERATIONS.md): logs, manual resync, troubleshooting and running costs
- [Portal and wedding website](docs/PORTAL.md): Cloudflare Access setup, roles, feature switches, RSVPs, email, data model
- [Wedding Planner](docs/PLANNER.md): the installable phone app
- [Communications](docs/COMMUNICATIONS.md): SMTP2Go email, ClickSend SMS, webhooks, consent and the activation checklist
- [Privacy and personal data](docs/PRIVACY.md): what's collected, retention, deleting and erasing
- [Database](docs/DATABASE.md): migrations, verification, backups, restore and rollback
- [Daly MCP gateway](docs/MCP.md): the gateway Worker in `mcp/` (`mcp.daly.id.au`): trust model, retired tools, client set-up and testing
- [MCP cutover and DalyHub decommissioning](docs/MCP_CUTOVER.md): gateway 3.0.0, ordered production cutover, real-client checks, monitoring, rollback and the DalyHub retirement checklist
- Retirements: [Daly Knowledge and Daly Tasks](docs/DECOMMISSION_KNOWLEDGE_TASKS.md), [Home & Assets and Household Finance](docs/DECOMMISSION_ASSETS_FINANCE.md), and [Daly Calendar, Today, Daly Intelligence, the Intelligence Centre, Amplenote and staging](docs/DECOMMISSION_PORTAL_APPS.md)
