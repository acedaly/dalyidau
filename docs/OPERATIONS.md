# Operations

## Configuration reference

Variables live in `wrangler.jsonc`. Secrets are set with `wrangler secret put`.

| Name | Kind | Default | Purpose |
| --- | --- | --- | --- |
| `CAPACITIES_API_TOKEN` | secret | | Read-only Capacities API token |
| `ADMIN_TOKEN` | secret | | Bearer token for `/api/admin/*` (24+ characters) |
| `SITE_URL` | var | `https://daly.id.au` | Canonical origin for links, sitemap, feed |
| `ENVIRONMENT` | var | `production` | Only `production` on `SITE_URL`'s host is indexable |
| `CAPACITIES_API_BASE` | var | `https://api.capacities.io` | API host (the mock in development) |
| `CAPACITIES_STRUCTURE_NAME` | var | `Blog Post` | Object type to publish from |
| `CAPACITIES_STRUCTURE_ID` | var | unset | Pin the type by id instead of name |
| `SYNC_MAX_REQUESTS` | var | `40` | API calls plus image downloads per run (Workers free plan allows 50 subrequests) |
| `SYNC_REQUEST_SPACING_MS` | var | `2100` | Gap between API calls (Capacities allows 30 per minute) |
| `IMAGE_TRANSFORMS` | var | `off` | `on` adds responsive `srcset` via Cloudflare Image Transformations (enable on the zone first; free plan includes 5,000 unique transformations a month) |

Site name, description, contact email, socials and navigation are in `src/content/site.ts`. About copy is in `src/content/about.ts` and is placeholder text until you replace it.

## Manual resync

```bash
ADMIN_TOKEN=… node scripts/trigger-sync.mjs https://daly.id.au           # normal run
ADMIN_TOKEN=… node scripts/trigger-sync.mjs https://daly.id.au --force   # re-render every post it reaches
# or
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" https://daly.id.au/api/admin/sync
```

The response is the run summary with its log lines. A run takes about 2 seconds per object because of the rate limit. Only one run happens at a time; a second request gets HTTP 409.

`GET /api/admin/status` (same token) shows the last 20 runs, objects with errors, and every published post.

## Logs

- Dashboard → Workers & Pages → dalyidau → Logs (Workers Logs is on; free plan keeps 3 days).
- Live: `npx wrangler tail --env=""`.
- Every run logs `{"event":"sync_complete",…}`. Problems log `{"event":"sync_error",…}`, and request failures log `request_error`. Logs never include tokens or private note content; object ids are shortened to 8 characters.
- History is also in D1: `npx wrangler d1 execute dalyidau-production --remote --command "SELECT id, trigger, status, published, updated, unpublished, errors, started_at FROM sync_runs ORDER BY id DESC LIMIT 10"`.

## Troubleshooting

| Symptom | Likely cause and fix |
| --- | --- |
| Run status `failed`, "No object type named Blog Post" | The type is missing or renamed. Fix the name or set `CAPACITIES_STRUCTURE_ID`. |
| `failed`, "Status must have exactly one option named Published" | Rename the select option to `Published`. |
| `failed`, "returned 401" | Token wrong, revoked or for another space. `wrangler secret put CAPACITIES_API_TOKEN` again. |
| A post doesn't appear | Check its Status is exactly Published, it's a Blog Post (not a Page), and look at `/api/admin/status` → `sourceErrors`. Slug clashes and missing titles are reported there. |
| An edit hasn't shown up | Wait for the next run or sync manually. Large spaces rotate through posts across runs. |
| An image is missing | Only JPEG, PNG, GIF, WebP and AVIF up to 15 MB are copied. SVG is skipped deliberately. |
| `Rate limited` in the log | Raise `SYNC_REQUEST_SPACING_MS` or lower `SYNC_MAX_REQUESTS`. |
| "Request budget reached" | Normal with many posts; the rest are done next run. |
| Site shows an error page | `wrangler tail` for `request_error`; roll back if a deploy caused it. |
| "Exceeded CPU limit" errors | Unlikely (a page render is about 1–1.5 ms), but if a very large article trips the free plan's 10 ms limit, split the article or move to Workers Paid. |

## Local development

```bash
cp .dev.vars.example .dev.vars
scripts/local-up.sh        # builds, migrates local D1, starts mock API (:8790) + wrangler dev (:8787)
npm run sync:local
curl -X POST localhost:8790/__control -d '{"action":"setStatus","args":["50000000-0000-4000-8000-000000000004","Published"]}'
npm run sync:local         # the draft is now live locally
scripts/local-down.sh
```

To test against your real Capacities space locally, put your real token and `CAPACITIES_API_BASE=https://api.capacities.io` in `.dev.vars`. Local data stays in `.wrangler/state`.

## Running costs

All within Cloudflare's free plans at personal-blog traffic. **Expected cost: $0 a month** (the domain registration is separate and already yours).

| Service | Usage | Free allowance |
| --- | --- | --- |
| Workers requests | Page views (static assets are free and don't count) plus 96 cron runs a day | 100,000 a day |
| Workers CPU | About 1–1.5 ms per uncached page render | 10 ms per request |
| Subrequests | ≤ 40 per sync run | 50 per invocation |
| Cron Triggers | 1 | 5 per account (check DalyHub's usage if you add more) |
| D1 | A few reads per page; writes only when content changes | 5 M reads, 100 k writes a day, 5 GB |
| R2 | Article images | 10 GB storage, 1 M writes, 10 M reads a month |
| Workers Logs | About 5–10 lines per sync | 200 k events a day |
| Image Transformations | Off by default | 5,000 unique a month if enabled |

Nothing here auto-upgrades to a paid plan. If a limit is hit, requests fail rather than bill.
