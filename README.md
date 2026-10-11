# daly.id.au

Personal website and blog for Aidan Daly. The blog is written in [Capacities](https://capacities.io) and published automatically to a Cloudflare Worker. No CMS, no paid hosting, no manual deploys for new posts.

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

| Command | What it does |
| --- | --- |
| `npm run typecheck` | TypeScript for the app, worker, tests and config |
| `npm test` | Builds the client, then runs the Vitest suite inside workerd with local D1 and R2 |
| `npm run test:e2e` | Playwright against `wrangler dev` and the mock API (desktop and mobile) |
| `npm run build` | Typecheck, client build and a Worker bundle dry run |
| `npm run deploy` | Manual production deploy (normally GitHub Actions does this) |
| `npm run deploy:staging` | Deploy the staging Worker |

## Repository layout

```
src/                 React app (Untitled UI components), shared by server render and browser
  components/base…   Untitled UI React components (from the official starter kit)
  components/site/   Site components: header, footer, post cards, pagination, TOC, share links
  content/           Editable site settings and About copy
  pages/             Home, Blog, Article, About, Contact, 404
  entry-server.tsx   renderToString for the Worker
  entry-client.tsx   Hydration in the browser
worker/              Cloudflare Worker
  index.ts           Routing, SSR assembly, caching, media, admin API, cron handler
  sync.ts            Capacities → D1/R2 synchronisation
  capacities/        API client, schema mapping and block-to-HTML renderer
  posts.ts           D1 queries for public pages
  seo.ts             Meta tags, JSON-LD, sitemap, RSS, robots.txt
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
