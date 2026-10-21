# Capacities setup and publishing

> **Retired as a publisher.** New articles are written in Amplenote ([AMPLENOTE.md](AMPLENOTE.md)).
> Capacities sync is off by default (Portal settings → Features → Capacities sync), and its articles stay
> online from Cloudflare. See [CAPACITIES_RETIREMENT.md](CAPACITIES_RETIREMENT.md) for the archive,
> when to cancel, and moving an article to Amplenote. This page is kept for reference while archived
> articles exist.

## What the API supports (verified October 2026)

Checked against the live OpenAPI spec at `https://api.capacities.io/openapi.json` (version 1.0.0).

| Question | Answer |
| --- | --- |
| Authentication | `Authorization: Bearer cap-api-…`. Tokens are created in the desktop app (Settings → Capacities API), are bound to **one space**, and carry `api:read` and/or `api:write` scopes. This site only needs `api:read`. |
| Listing Blog Posts | `GET /objects/structure?id=<typeId>`: 100 per page with a cursor. Returns ids and titles only, with no timestamps, so every object has to be fetched to see changes. |
| Body content | `GET /object?id=…` returns typed properties plus structured blocks (text with heading/list/quote/callout flags, code, math, grids, embeds, dividers). |
| Properties | Typed: label (select), text, date, boolean, url, entity (links to other objects), lastUpdatedAt, etc. Built-in tags are an entity property linking to Tag objects. |
| Images | Embedded images are separate `MediaImage` objects. Their files are **signed URLs that expire**, so the sync copies them into R2. |
| Tables | Simple tables are separate objects. Their contents come through `GET /object/markdown`, which the sync parses. |
| Webhooks or events | **None.** Publishing is therefore driven by a 15-minute Cron Trigger. |
| Rate limits | `GET /space/structures`: 10 per minute. Object, listing and markdown endpoints: 30 per minute. The sync spaces calls about 2.1 s apart and handles 429 with `Retry-After`. |
| Deprecated API | Not used. |

Blocks the API reports as `unsupported` (for example whiteboards) are skipped and noted in the sync log.

## One-time setup in Capacities

### 1. Create the Blog Post object type

Settings → Object types → New type, named exactly **Blog Post** (or set `CAPACITIES_STRUCTURE_NAME` / `CAPACITIES_STRUCTURE_ID` in `wrangler.jsonc` to match yours). Add these properties. Names matter, case doesn't.

| Property | Type | Notes |
| --- | --- | --- |
| Title | (built in) | Article heading |
| **Status** | Select, single | **Required.** Options: `Draft`, `Published`, `Archived`. Exactly one option must be called `Published`. |
| Slug | Text | Optional. Defaults to the title, e.g. "My First Post" → `my-first-post` |
| Subtitle | Text | Optional, shown under the title |
| Summary | Text | Card excerpt and meta description. Falls back to the built-in Description, then the first 200 characters of the body. |
| Category | Select, single | Optional. Drives the category filter. |
| Tags | (built in) | Capacities tags become public topics, so only use tags you're happy to show |
| Featured Image | Object (Image) or URL | Optional |
| Publish Date | Date | Optional. Falls back to the object's creation date. |
| Updated Date | Date | Optional "last substantive revision" date |
| Featured | Checkbox | Optional. The newest featured post leads the blog page. |

The article body is the object's normal content area.

### 2. Create an API token

Desktop app → Settings → Capacities API → create a token in the space that holds your blog, **read-only** (`api:read`). Store it as a Worker secret, never in the repo:

```bash
npx wrangler secret put CAPACITIES_API_TOKEN --env=""
```

The next cron run (within 15 minutes) or a manual sync will pick it up.

## Publishing workflow

| You want to… | Do this in Capacities | Result |
| --- | --- | --- |
| Publish | Set Status to **Published** | Live at `daly.id.au/blog/<slug>` after the next sync (≤15 min) |
| Edit | Edit the post as normal | Updated after the next sync |
| Rename the URL | Change Slug | New URL live; the old one 301-redirects |
| Unpublish | Set Status to Draft or Archived, or clear it | Removed from the site, sitemap and feed at the next sync |
| Delete | Delete the object | Removed after two consecutive syncs confirm it's gone |
| Publish now | Run a manual sync (see [OPERATIONS.md](OPERATIONS.md)) | Immediate |

Things to know:

- Only **Blog Post** objects marked **Published** ever go public. Pages, daily notes, people, projects and every other type are never read beyond what a published post explicitly embeds.
- Embedding a private note, person or project in a published post shows nothing. Linking to one keeps the link text but drops the link. Linking to another published post works.
- Images embedded in a post are published with it. The image's title (unless it looks like a filename) becomes alt text, and its description becomes the caption.
- Web links embedded as cards become link cards. YouTube and Vimeo links become embedded players.
- With many posts, each run checks the least recently checked ones first (about 30 objects per run with default limits), so in a large space an edit can take more than one run to appear. A manual sync with `--force` re-renders everything it reaches.
