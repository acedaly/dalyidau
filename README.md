# daly.id.au

Personal website and blog for Aidan Daly. The blog is written in [Capacities](https://capacities.io) and published automatically to a Cloudflare Worker. No CMS, no paid hosting, no manual deploys for new posts.

The same Worker hosts a private portal at `/portal` (behind Cloudflare Access) with two applications, the Wedding Planner and [Daly Knowledge](docs/KNOWLEDGE_ENGINE.md), and the public wedding website at `/wedding`. See [docs/PORTAL.md](docs/PORTAL.md).

```
Capacities "Blog Post" ──(API, every 15 min)──▶ Worker cron ──▶ D1 (articles) + R2 (images)
                                                                   │
Browser ◀── server-rendered React (Untitled UI) ◀── Worker fetch ──┘
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
  portal/            The private portal: the wedding management app and Knowledge (portal/knowledge)
  wedding/           The public wedding website and RSVP form
  shared/portal/     Roles, feature flags and data types shared by the worker and the browser
  shared/knowledge/  Knowledge's document format, properties and data types
  entry-server.tsx   renderToString for the Worker (blog, portal, wedding)
  entry-client.tsx   Blog hydration; entry-portal.tsx and entry-wedding.tsx for the other areas
worker/              Cloudflare Worker
  index.ts           Routing, SSR assembly, caching, media, admin API, cron handler
  sync.ts            Capacities → D1/R2 synchronisation
  capacities/        API client, schema mapping and block-to-HTML renderer
  posts.ts           D1 queries for public pages
  seo.ts             Meta tags, JSON-LD, sitemap, RSS, robots.txt
  portal/            Access verification, roles, audited CRUD, guests, comms, import/export, API
  knowledge/         Knowledge: space membership, objects, revisions, links, search, API
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
- [Communications](docs/COMMUNICATIONS.md): SMTP2Go email, ClickSend SMS, webhooks, consent and the activation checklist
- [Privacy and personal data](docs/PRIVACY.md): what's collected, retention, deleting and erasing
- [Database](docs/DATABASE.md): migrations, verification, backups, restore and rollback
- [Staging](docs/STAGING.md): the separate staging environment and how to set it up
- [Daly Knowledge](docs/KNOWLEDGE_ENGINE.md): the private knowledge application at `/portal/knowledge`: access model, content format, search, history and roadmap
