# Portal and wedding website

The same Worker that serves the blog also serves:

| Path | What | Who |
| --- | --- | --- |
| `/portal` → `/portal/wedding` | Private administration platform. The wedding management app lives under `/portal/wedding/*`; portal-wide settings and the audit log under `/portal/settings` and `/portal/audit`. | The two owners (and anyone you add later), through Cloudflare Access |
| `/wedding`, `/wedding/rsvp` | Public wedding website and the native RSVP form | Guests. Returns 404 until you publish it |
| `/api/portal/*` | JSON API behind the portal | Same as `/portal` |
| `/api/wedding/rsvp/*` | Public RSVP lookup and submit | Anyone with a household RSVP code, rate-limited, only when switched on |

Nothing here is live until it is deployed, and nothing here has been deployed. See [Going live](#going-live).

---

## What you need to decide or provide

These are yours to do; the code is ready for them.

1. **Cloudflare Access application** (Zero Trust dashboard). See [Set up Cloudflare Access](#set-up-cloudflare-access).
2. **Worker secrets**: `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `PORTAL_OWNER_EMAILS`. Until all three are set, every portal request is refused.
3. **Wedding details** in the portal (Settings → General): names, date, location, time zone. The defaults are placeholders ("Partner One", "Partner Two").
4. **Say I Do link** (RSVPs → Settings), so the website sends guests to it while the native form is off.
5. **When to switch on the native RSVP form** (Settings → Features → Native RSVP). Off by default. Say I Do stays the live RSVP until you turn this on.
6. **When to publish the website** (Website → Publish). Off by default. It's `noindex` by default too.
7. **Email delivery provider**, if you ever want the portal to send email itself. Not configured, by design. See [Email](#email).
8. **Production is missing the `ADMIN_TOKEN` secret** (found by `npm run check:config`). It predates the portal; without it the blog's manual resync endpoint is disabled. Set it with `npx wrangler secret put ADMIN_TOKEN --env=""` (e.g. `openssl rand -base64 32`).
9. **Staging** (optional, recommended before production): see [STAGING.md](STAGING.md).
10. **Whether to merge this branch.** Merging to `main` deploys to production automatically (`.github/workflows/deploy.yml`) and applies migration `0002_portal_wedding.sql` to the production D1 database. The migration only adds new tables.

---

## Set up Cloudflare Access

Access decides who can reach the portal at all. The Worker then verifies Access's signed token itself on every request, so a request that somehow bypasses Access (for example via `*.workers.dev`) is still refused.

1. Zero Trust → **Settings → Authentication**: make sure an email login method is enabled (One-time PIN is fine, or Google/GitHub if you prefer).
2. Zero Trust → **Access → Applications → Add an application → Self-hosted**.
    - **Application domain**: add *two* destinations on the same application:
        - `daly.id.au` with path `portal`
        - `daly.id.au` with path `api/portal`

      (Access path matching covers everything below each path.)
    - **Session duration**: your choice; 24 hours is reasonable.
3. **Policy**: Action *Allow*, Include → *Emails* → both of your addresses. Add other people here later, as well as in the portal.
4. Save, then copy from the application's **Overview** tab:
    - the **Application Audience (AUD) tag**
    - your **team domain** (`<team>.cloudflareaccess.com`, shown under Settings → Custom Pages or in the login URL)
5. Set the Worker secrets (they survive deploys; `keep_vars: false` in `wrangler.jsonc` would wipe plain vars set in the dashboard). Both owners' emails go in one comma-separated secret; each of you then signs in with your own Access identity:

```bash
npx wrangler secret put ACCESS_TEAM_DOMAIN   --env=""   # e.g. daly.cloudflareaccess.com
npx wrangler secret put ACCESS_AUD           --env=""   # the AUD tag
npx wrangler secret put PORTAL_OWNER_EMAILS  --env=""   # you@example.com,partner@example.com
```

6. Check everything without revealing any value:

```bash
npm run check:config -- --url https://daly.id.au --team <team>.cloudflareaccess.com
```

It confirms the three secrets exist (names only), that no development-only setting is present, that `/portal` redirects to the Access login, and that `/api/portal` refuses unauthenticated requests.

For staging, see [STAGING.md](STAGING.md): it has its own Access application and secrets.

### How paths, domains and Access fit together

| Request | Access in front? | What the Worker does |
| --- | --- | --- |
| `daly.id.au/portal…`, `daly.id.au/api/portal…` | Yes (the application's two paths) | Verifies the Access JWT and the role on every request |
| `daly.id.au/wedding…`, `/api/wedding/rsvp…` | No (public) | Serves only if published / switched on |
| `dalyidau.<sub>.workers.dev/portal…` and preview URLs | No (unless you enable Access on workers.dev) | Still requires a valid Access JWT for *your* application, so it refuses everyone who isn't already signed in to daly.id.au |
| Anything else | No | The blog |

Because the Worker checks the token itself, a missing or wrong Access application can only lock people out, never let them in.

No DNS or `routes` change is needed: the portal is a path on the existing custom domain.

### How the check works (`worker/portal/access.ts`, `worker/portal/auth.ts`)

- Token from the `Cf-Access-Jwt-Assertion` header (or the `CF_Authorization` cookie).
- RS256 only; signature checked against `https://<team>/cdn-cgi/access/certs` (cached ten minutes, refetched once on an unknown key id).
- Issuer must be `https://<team>`, audience must include `ACCESS_AUD`, `exp`/`nbf`/`iat` checked with 60 s of skew, and there must be an email (service tokens are refused).
- The email must then be an owner (`PORTAL_OWNER_EMAILS`) or an **active** row in `portal_users`. Anyone else gets 403, even if Access let them in.
- Missing configuration, a network failure fetching keys, or any malformed token → refused. There is no fallback.
- State-changing API calls must come from this origin (`Origin` header) with a JSON body, so a page on another site can't use your Access session.

---

## Roles

Defined in `src/shared/portal/permissions.ts` and enforced on every API route and page.

| Role | Can |
| --- | --- |
| Owner | Everything, including managing people and roles, permanent erasure and retention. Owners come from `PORTAL_OWNER_EMAILS` and can't be changed in the portal. |
| Admin | Everything except managing people, erasure and retention. |
| Editor | Guests, households, events, RSVP entry, communications (prepare, not send), planning, website content, audit log. No budget, sending, exports, settings or the RSVP link. |
| Viewer | Read-only guests, RSVPs and planning. |

Add people in **Settings → People and roles** *and* in the Access policy. Removing someone from either removes their access. Removing an email from `PORTAL_OWNER_EMAILS` also removes their owner rights immediately.

---

## Security review (October 2026)

What was checked, and how it's covered by tests (`test/access.test.ts`, `test/privacy.test.ts`):

| Area | Result |
| --- | --- |
| Access JWT | RS256 only; signature, issuer, audience, expiry, not-before and issued-at checked; `alg: none`, HMAC, unknown keys, forged signatures, tampered claims and malformed tokens refused. Service tokens (no email) refused. |
| Authorisation | Every page and API route needs a verified identity *and* a role; each route checks its own permission server-side. A sweep test calls every write endpoint without a token (401) and as a viewer (403). |
| Role changes | People can't change their own role; owners from `PORTAL_OWNER_EMAILS` can't be changed in the portal; removing an email from that secret removes owner rights immediately. Every change is audited. |
| Development bypass | `ACCESS_DEV_EMAIL` works only with `ENVIRONMENT=development` **and** a localhost `SITE_URL`; `ACCESS_TEST_JWKS` is ignored in production. `check:config` fails if either is configured on a deployed environment. |
| workers.dev / previews | Same token checks on every hostname; tested. |
| Missing configuration | Every portal request refused; the response doesn't say which check failed (it's logged instead). |
| CSRF / cross-origin | Writes need a same-origin `Origin` and a JSON body; any API request a browser marks as cross-site or same-site (another subdomain) is refused, including GETs such as exports. |
| Caching | Every portal page, API and CSV response, including errors and access-denied pages, is `Cache-Control: no-store` and `noindex`; portal pages are never edge-cached. |
| Client bundle | `npm run check:bundle` (in CI) fails if any client file contains a configured owner email, team domain, token or key. Pages only ever include the signed-in user's own email; the People list is owner-only. |
| RSVP link | Changing where the website's RSVP button sends guests is limited to owners and admins. |
| Concurrency | Two people editing the same record can't silently overwrite each other (409 with an explanation). |

Remaining risks: household RSVP codes are 8 characters (about 37 bits) and rely on rate limiting; longer, revocable invitation links are next on the list. See also [Outstanding](#outstanding).

## Feature switches

Settings → Features. Stored in D1 (`feature_flags`); defaults in `src/shared/portal/flags.ts`. Every change is audited.

| Switch | Default | Effect |
| --- | --- | --- |
| Public wedding website | Off | `/wedding` serves the site; otherwise it's a normal 404. |
| Native RSVP | Off | The website's RSVP button opens our own form, and `/api/wedding/rsvp/*` accepts responses. While off, the button links to Say I Do and the API returns 404. Needs the website switched on too. |
| Email delivery | Off | Allows sending from the portal. Also needs `EMAIL_DELIVERY` configured on the Worker. |
| Communications / Planning / Budget modules | On | Hide a module's pages and API when you don't need it. |

---

## RSVPs: Say I Do now, native later

- **While Say I Do is live**: set its link under RSVPs → Settings. The website's RSVP buttons go there. Record replies in the portal by hand (guest panel → RSVP tab, or select guests → Actions → Set RSVP → "Say I Do"), or import a Say I Do guest export (Guests → Import, tick "These RSVPs came from Say I Do"). Recognised columns are listed in the import dialog.
- **Testing the native form**: Website → Preview → RSVP (or RSVPs → "Test the native form"). The preview uses owner-only endpoints, so it works while the switch is off. Responses there are real writes, so use a test household.
- **Switching over**: give each household its code (Households → Export with codes, or the `{{rsvp_code}}` / `{{rsvp_link}}` merge fields), then turn on Native RSVP. Turning it off again reverts the buttons to Say I Do immediately.
- **How the native form is protected**: the 8-character household code is the only credential (25-letter alphabet without look-alike characters, about 37 bits). Lookups are limited to 20 per 10 minutes per client and submissions to 10; clients are identified by a hash, not their IP. Only guests in that household and events they're invited to (with RSVPs enabled) can be answered, and the whole household must be answered. After the deadline the form is read-only. Each submission is stored verbatim (`rsvp_submissions`) and audited.

---

## Email

Nothing is sent from the portal today. You can prepare a message (subject, body with merge fields, audience), preview it for any guest, and download a **mail-merge CSV** with each guest's personalised subject and body to send from your own email.

Sending from the portal needs both:
1. A provider on the Worker. `EMAIL_DELIVERY=log` exists for tests and local development only and is ignored in production. The natural production choice is Cloudflare Email Service, which needs a sending domain set up and a binding added, so it's left for your decision. The integration point is `deliveryProvider()` in `worker/portal/comms.ts`.
2. The **Email delivery** switch.

Sending claims the message first, so a double click can't send twice, and records per-recipient success or failure.

---

## What's in the wedding management app

| Area | Features |
| --- | --- |
| Dashboard | Personal, customisable widget grid: countdown, RSVP summary, attendance by event, replies over time, guest breakdown, dietary needs, tasks due, budget, latest online replies, recent activity. Add, remove, reorder and resize; saved per person. |
| Guests | Searchable, sortable, filterable table (RSVP, event, side, group, tag); bulk actions (invite, set RSVP, move household, side, group, tags, delete); profile slide-over with details, per-event RSVP and activity history; custom fields; CSV import (dry run first) and export. |
| Households | Invitation units with RSVP codes (copy, re-issue), contact and postal details; CSV export with codes. |
| Events | Ceremony, reception and anything else, with public/private and RSVP on/off per event. |
| RSVPs | Response metrics, attendance by event, replies per household, the online response log and RSVP settings. |
| Communications | Templates, composer with live audience count and per-guest preview, frozen recipient lists, delivery history, mail-merge export. |
| Tasks | List and month-calendar views, status, priority, owner, due dates, progress and overdue tracking. |
| Timeline | Day-of run sheet grouped by day. |
| Budget | Total budget, committed, paid, overdue; per-category progress; payment status per item; linked suppliers. |
| Suppliers | Directory with status, contacts and links. |
| Website | Content editor (hero, welcome, sections), publish switch, preview. |
| Settings | Wedding details, feature switches, custom guest fields, people and roles. |
| Audit log | Every change, who made it and when, with field-level before/after values; searchable, exportable. Deletes keep a full snapshot. |

Every list has a meaningful empty state, every save shows field-level validation from the server, and every change is in the audit log. Exports of personal data are audited too.

---

## Design system

- **Portal**: Untitled UI PRO application components, pulled into the repo with `npx untitledui@latest add` (see the list in `src/components/application` and `src/components/base`): sidebar navigation, breadcrumbs, table, pagination, modals, slideout menus, tabs, select, checkbox, toggle, radio, textarea, dropdown, date picker, file upload, metrics, charts base, notifications, progress indicators, badges, avatars, empty states. Portal-specific compositions live in `src/portal/components` (data table, record panel, metric card, toasts, month calendar) and are built only from those components and the theme tokens. Light and dark mode use the site's existing theme system.
- **Wedding website**: the same components, wrapped in `.wedding-theme`, which re-roots every Untitled UI token on the wedding palette (warm ivory, eucalyptus green, olive, clay) with Cormorant Garamond and Lora. Because Untitled UI's semantic tokens are chained CSS variables, the wrapper re-declares them all; that file is generated by `node scripts/build-wedding-theme.mjs` from `theme.css`. The site is always light.
- Chart colours (`src/styles/portal.css`) were checked with a colour-blindness validator; every chart also has direct labels, a legend and an accessible table.

### Builds

The blog, the portal and the wedding site are three HTML shells. `npm run build:client` runs two Vite builds: `vite.config.ts` for the blog and `vite.apps.config.ts` for the portal and wedding site. They're separate because, in one build, React Aria's package index makes every component the portal uses look shared with the blog, and roughly 220 kB of it lands in the blog's bundle. Separately, the blog's JavaScript and CSS are byte-for-byte the size they were before the portal existed. `src/styles/globals.css` also excludes portal-only sources from the blog's Tailwind scan; if the blog starts using one of the excluded component folders, remove it from that list.

---

## Data model (D1, `migrations/0002_portal_wedding.sql`)

| Table | Contents |
| --- | --- |
| `portal_users` | Email, name, role, active, last seen |
| `audit_log` | Append-only change history |
| `feature_flags`, `settings`, `dashboard_layouts` | Switches, settings documents (JSON), personal layouts |
| `households`, `guests`, `events`, `guest_events` | The guest list; a `guest_events` row means "invited", its status is the RSVP |
| `custom_fields` | Extra guest fields (values live in `guests.custom`) |
| `rsvp_submissions`, `rate_limits` | Native RSVP history and limiter windows |
| `message_templates`, `messages`, `message_recipients` | Communications |
| `tasks`, `timeline_items`, `suppliers`, `budget_items` | Planning and budget (money in cents) |

Adding a module usually means: a table in a new migration, an `EntityDef` in `worker/portal/entities.ts` (that alone gives validated, audited CRUD at `/api/portal/wedding/<name>`), a loader in `worker/portal/pages.ts`, a page in `src/portal/pages`, and a sidebar entry. Adding a dashboard widget: its type in `WIDGET_TYPES`, its data in `computeStats`, and its renderer in `src/portal/dashboard/widgets.tsx`.

---

## Personal data, deletion and retention

Deleting a guest or household is reversible; erasing (owners only) is permanent and scrubs copies in message history, RSVP submissions and the audit log. The audit log never stores the values of sensitive fields. Retention is configurable and only ever applied by an owner. Full details: [PRIVACY.md](PRIVACY.md).

## Database operations

Migrations, `npm run db:verify`, verified backups (`npm run db:backup`), Time Travel restores and rollback: [DATABASE.md](DATABASE.md).

## Local development

```bash
cp .dev.vars.example .dev.vars     # includes ACCESS_DEV_EMAIL and PORTAL_OWNER_EMAILS
npm run db:migrate:local
npm run dev
npm run seed:portal                # optional: invented demo guests, events, budget…
open http://localhost:8787/portal
```

`ACCESS_DEV_EMAIL` lets local development act as that person without Access. It only works when `ENVIRONMENT=development` *and* `SITE_URL` is on localhost, neither of which is true for a deployed Worker. The seed script refuses to run against anything but localhost.

## Tests

- `npm test` (Vitest in workerd): Access token verification (expired, wrong audience/issuer, forged, `alg: none`, unknown key…), fail-closed configuration, roles, CSRF, guests CRUD and audit, custom fields, bulk actions, import/export (including CSV formula-injection), communications gating, RSVP engine (household scoping, deadline, rate limits, privacy), wedding site visibility, and a server render of every portal page.
- `npm run test:e2e` (Playwright, desktop and mobile): every portal page hydrates without console errors or horizontal overflow, adding a guest through the slide-over, server validation, dashboard customisation, a full RSVP on the public site reflected in the portal, the mobile navigation drawer and dark mode.

## Going live

When you're ready (none of this has been done):

1. Set up Access and the three secrets (above).
2. Merge the branch. CI runs, then the deploy workflow applies migration 0002 and deploys.
3. Sign in at `https://daly.id.au/portal`, fill in Settings → General, events, guests.
4. Preview the website, then publish it when you're happy.
5. Keep Say I Do live until you've tested the native form, then switch over.

## Outstanding

- Part B–F of the phase 2 brief (accommodation, seating, transport, catering, RSVP question builder and longer invitation tokens, email provider, website content, dashboard additions, exports) are in progress on this branch.
- Erasure can't reach downloaded CSV files, backup files or D1's 30-day Time Travel history ([PRIVACY.md](PRIVACY.md#places-the-portal-cant-reach)).
