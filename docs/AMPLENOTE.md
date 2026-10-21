# Publishing from Amplenote

Blog articles can be written and published in Amplenote. Each one becomes an ordinary post: it's
server-rendered at `daly.id.au/blog/<slug>` and appears on the homepage, the blog index, categories,
tags, search, related articles, RSS, the sitemap and in Open Graph and structured data. Nothing is
entered on the website for each article.

Capacities keeps working alongside it, unchanged (`worker/sync.ts` now only touches its own rows).

## What you do

1. Write the article as a note. **The note's title is the article's title.**
2. Tag it `website/blog`.
3. Publish it with Amplenote's own **Publish**.

The next time the plugin runs, the article is on the site. The plugin runs by itself whenever Amplenote
loads it or you move between notes, at most every ten minutes. Editing works the same way. Unpublishing
the note in Amplenote, or removing the tag, takes the article off the site. Nothing on the site is
deleted: the stored copy is kept, and republishing restores the same address.

**Both** the tag and a real Amplenote publication are required. A tagged draft never appears, and
nothing it contains (not even its title) is sent or stored.

### Writing conventions (all optional)

| In Amplenote                          | On the site                                  |
| ------------------------------------- | -------------------------------------------- |
| tag `website/category/making-things`  | category "Making things"                     |
| tag `website/tag/gardening`           | tag "Gardening"                              |
| tag `website/featured`                | the featured article                         |
| first image in the note               | featured image (copied into R2)              |
| a heading `# Website` with lines like | removed from the article and used instead:   |
| `slug: my-address`                    | the address (the old one redirects)          |
| `summary: …`                          | excerpt (otherwise the first 200 characters) |
| `subtitle: …`                         | subtitle                                     |
| `published: 2026-09-01`               | published date (otherwise first publication) |
| `image: none` or an image URL         | featured image choice                        |

The note's other tags are never sent to the website or stored. Changing the title doesn't change the
address, so links keep working. Use `slug:` to move an article on purpose. Links to other notes become
links to their articles when those notes are published here, and plain text otherwise.

## Why it works this way (verified against Amplenote's documentation, 21 October 2026)

**The REST API can't publish articles by itself.** Its spec (`https://api.amplenote.com/doc/swagger.json`,
"Amplenote API 1.0", host `api.amplenote.com`, base path `/v4`) has these paths only:

| Path                                                                   | Purpose                                                                                                |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `GET /notes` (`?since=<unix>`)                                         | metadata for every note: `uuid`, `name`, `tags`, `timestamps`, `deleted`, `public` (boolean) and so on |
| `GET /notes/deleted`                                                   | deleted notes                                                                                          |
| `POST /notes`, `PATCH /notes/{uuid}/restore`                           | create and restore                                                                                     |
| `POST /notes/{uuid}/actions`                                           | add content (write-only)                                                                               |
| `POST /notes/{uuid}/media`, `PUT …/media/{id}`, `POST /accounts/media` | upload media                                                                                           |

Its overview says it is "intended to provide functionality to implement common use-cases without
providing access to a user's encryption keys or (encrypted) note content". So, through the API:

- **Missing: note content.** No endpoint reads a note's text or attachments.
- **Missing: the public URL or token.** `public` says only "whether this note has been shared publicly".
- **Missing: webhooks or change events.** There's only `GET /notes?since=`.
- **Available:** OAuth2 authorization code (with PKCE, per amplenote.com/help/amplenote_security_design),
  two-hour access tokens with refresh tokens, and scopes `notes:list`, `notes:create`,
  `notes:create-content-action` and `notes:create-image`. This site asks only for `notes:list`.

**Confirmed against the owner's approved application (live check, 21 October 2026):**

- The authorization code exchange (PKCE, `client_id` in the form body) and a refresh both answered 200.
- Access tokens last 7,200 seconds. The refresh token did **not** rotate; the code keeps the stored one
  unless a refresh returns a new one, so rotation starting later is handled too.
- `GET /v4/notes` answered 200 with an **object** holding a `notes` array (the spec describes it as
  "metadata for all notes and tags"), not a bare array. Both listings are read that way.
- No public note URL or publication token appears anywhere in the response, so the plugin is needed
  for every new article.

**The Plugin API can.** `app.filterNotes({ tag })`, `app.getNotePublicURL(note)` ("String URL for the
published note, or null if the note is not published") and `app.getNoteContent(note)` (markdown) give
everything an article needs. The `onNavigate` hook is "called when the user changes locations in the
app … Also called when plugin initially loads", so the plugin runs without a button. Plugins run only
inside an open Amplenote client: there's no background or scheduled hook.

So the split is:

| Who                                          | When                                  | What                                                                                                                                                               |
| -------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Plugin** (`amplenote/plugin.js`)           | while Amplenote is open on any device | finds tagged notes, their public URL, title, dates, `website/` tags and content; sends them to `/api/amplenote/ingest`. **New articles and content edits.**        |
| **Worker cron** (existing 15-minute trigger) | always, Amplenote open or not         | checks each article's public link still answers (status only, never parsed). With the API connected: unpublished, untagged or deleted notes and **title changes**. |
| **D1 and R2**                                | always                                | the stored, rendered article and its images. **The site never needs Amplenote to be open or reachable.**                                                           |

What this means in practice:

- A **new** article appears the next time Amplenote is open (on your phone, desktop or the web), with
  no clicks. It can't appear while Amplenote is closed everywhere: only the plugin can obtain its
  link and content.
- A **content edit** follows the same way.
- **Unpublishing, untagging, deleting and renaming** are picked up within 15 minutes even while Amplenote
  is closed, once the API is connected. Without the API, the plugin picks them up the next time it runs,
  and the cron's link check still removes an article whose public link stops working.
- The **"Publish to website now"** command (Amplenote's app menu) is only a backup.

## Safety rules (worker/amplenote/publisher.ts, `ineligibility`)

An article is public only while **all** of these hold:

- the plugin reports the tag and a `public.amplenote.com` URL;
- the content has arrived;
- the public link answered 200 at least once;
- with the API connected, the API also says `public`, tagged and not deleted.

Anything uncertain keeps the last known state:

- A failed request, an expired connection or an unreadable answer changes nothing.
- Absence must be seen in two complete reports (or two full API listings) in a row.
- A plugin report with no tagged notes at all, while two or more articles are live, is ignored.
- A link answering 404/410 twice withdraws the article; any other answer is treated as an outage.
- An explicit "not published" (from the plugin) or `public: false` (from the API) withdraws it at once.

Article HTML is built by escaping every string (`worker/amplenote/markdown.ts`). Raw HTML in a note,
including scripts, comments and embeds, is dropped. Images are copied into R2 only from Amplenote's
image host, so the CSP stays `img-src 'self'`. No Amplenote script or iframe is loaded anywhere, which
means the proof of concept's CSP exception and `/blog/amplenote-test` page are gone.

## One-time setup

Nothing here is live until you merge, and merging deploys production (`deploy.yml`) and applies
migration `0028_amplenote_publishing.sql`. That migration is additive: one `posts.source` column
(existing rows become `capacities`) and three new tables. Back up first with `npm run db:backup`.

### 1. Worker secrets

```sh
openssl rand -base64 33 | npx wrangler secret put AMPLENOTE_PUBLISH_TOKEN --env=""   # also goes in the plugin
openssl rand -base64 33 | npx wrangler secret put AMPLENOTE_TOKEN_KEY     --env=""   # seals OAuth tokens in D1
npx wrangler secret put AMPLENOTE_CLIENT_ID     --env=""                             # your approved application
npx wrangler secret put AMPLENOTE_CLIENT_SECRET --env=""                             # only if Amplenote issued one
```

Without `AMPLENOTE_PUBLISH_TOKEN`, `/api/amplenote/ingest` answers 404. Without the client id and token
key, the API connection is simply unavailable. `AMPLENOTE_TAG` (a plain var) changes the tag from
`website/blog`. Copy the publishing token before piping it to wrangler, or set it with the
interactive prompt, because you'll need it again in step 3.

### 2. Check the real API first (no deploy needed)

With the currently registered redirect address (`https://daly.id.au/blog`), unchanged:

```sh
export AMPLENOTE_CLIENT_ID=…          # in your own terminal, never in a file
node scripts/amplenote-live-check.mjs start
# open the printed link, approve; you land on daly.id.au/blog?code=…&state=…
node scripts/amplenote-live-check.mjs finish "<that whole address>" --token 32pmddtDM8Xfgwca3nbmfTLm
```

It reports which token fields come back, whether refresh tokens rotate, the shape of both listings,
every field on your notes (and the type of tag values), your `website/blog` notes with their `public`
flag, and whether the public token appears anywhere in the API's response. It prints and saves no
tokens. The first run is recorded above under "Confirmed". Run it again once a note is tagged
`website/blog` and published: it should then list that note with `public=true`, and the `?since=`
line should count it if you published it in the last 24 hours.

### 3. Install the plugin (once)

Portal settings → **Website & Blog** → _Set up the plugin_ has both pieces to copy. In Amplenote:

1. Create a note named "daly.id.au publisher". Paste the settings table, then a code block holding the
   plugin code.
2. Settings → Plugins: choose the note next to "Add a plugin", then **Add Plugin**.
3. Open the plugin's settings (the gear icon) and fill in **Publishing token** (the value from step 1).
   Fill in **Website** too, unless the site is `https://daly.id.au`.
4. Run **daly.id.au publisher: Publish to website now** from the app menu once, to confirm it works.

### 4. Connect the API (optional, recommended)

This step is what makes removals and title changes work while Amplenote is closed.

1. In your Amplenote API application, add the redirect address
   `https://daly.id.au/api/integrations/amplenote/callback` (Portal settings → Website shows it with a
   copy button). Do this only after the deploy. Keep `https://daly.id.au/blog` until then.
2. Portal settings → Website & Blog → **Connect Amplenote**, and approve.

The connect step runs behind Cloudflare Access (owners and admins). The callback is outside Access, so
each sign-in is protected in other ways:

- the state is single use, lasts ten minutes and is stored server-side;
- PKCE (S256) is used, and its verifier is sealed;
- an HttpOnly, `SameSite=Lax` cookie set when you pressed Connect must come back with the callback.

The code is exchanged on the server, and the tokens are sealed with `AMPLENOTE_TOKEN_KEY` and never
reach a browser. **Reconnect** and **Disconnect** are on the same page. Disconnecting deletes the tokens
here; to revoke the grant on Amplenote's side as well, remove it in your Amplenote account.

### 5. The proof-of-concept note

`/blog/amplenote-test` is no longer a special page. To keep that address for the test note, add a
`# Website` section with `slug: amplenote-test`. Otherwise it appears at the slug of its title.

## Limitations

- New articles and content edits need Amplenote to be opened somewhere (no clicks). This is the
  Plugin API's design: nothing documented runs while Amplenote is closed.
- The plugin talks to the Worker directly. Amplenote's docs say plugin `fetch` is subject to CORS; the
  endpoint answers the preflight for any origin and accepts only the bearer token, never cookies. If
  Amplenote's sandbox blocks the request anyway, "Publish to website now" will say so. The fallback
  is asking Amplenote support to add `daly.id.au` to their CORS proxy allow-list.
- The publishing token is stored in the plugin's settings, which Amplenote syncs in plain text. It can
  only submit Amplenote reports, not reach the portal or anything else. If it leaks, someone could send
  forged content. With the API connected they can only change articles the API confirms are your own
  public, tagged notes; without it they could publish anything. Rotate it by updating the secret and
  the plugin setting together.
- Rendering covers headings, paragraphs, emphasis, links, lists, tasks, quotes, tables, code, rules,
  images and footnotes. Amplenote-specific embeds and colours are left out.
- Images must be on Amplenote's image host (`images.amplenote.com`, inferred from published notes,
  not documented). Any that can't be copied are left out and logged.
- Not verified against the live service yet: a tagged note in the listing (the first live check had
  none), whether `?since=` includes notes whose `public` flag changed, and the plugin sandbox's CORS
  behaviour. A second run of step 2 checks the first two; "Publish to website now" after the deploy
  checks CORS. The code tolerates `?since=` going either way: a full listing runs every six hours and
  whenever a new article is unconfirmed.

## Local development and tests

`npm run mock:amplenote` starts an invented stand-in (`fixtures/amplenote`) on :8792. Point
`AMPLENOTE_TEST_BASE=http://localhost:8792` at it with `ENVIRONMENT=development`; the override is
ignored anywhere else, and `check:config` refuses it in `wrangler.jsonc` or secrets.

`test/amplenote.test.ts` and `e2e/amplenote.spec.ts` run the real plugin code against the stand-in.
No test calls the real Amplenote.
