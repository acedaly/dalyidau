# Portal and wedding website

The same Worker that serves the blog also serves:

| Path                                   | What                                                                                                                                                                          | Who                                                                                                             |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `/portal`                              | Private application launcher. Wedding Planner lives under `/portal/wedding/*`; portal-wide identity, access and settings remain under `/portal/settings` and `/portal/audit`. | The two owners (and anyone you add later), through Cloudflare Access                                            |
| `https://wedding.daly.id.au/`, `/rsvp` | Canonical public wedding website and native RSVP form. Legacy `/wedding` links redirect here without dropping signed credentials.                                             | Guests. Returns 404 until you publish it                                                                        |
| `/api/portal/*`                        | JSON API behind the portal                                                                                                                                                    | Same as `/portal`                                                                                               |
| `/api/wedding/rsvp/*`                  | Public RSVP lookup and submit                                                                                                                                                 | Anyone with a signed household invitation link (or an enabled legacy code), rate-limited, only when switched on |

Nothing here is live until it is deployed, and nothing here has been deployed. See [Going live](#going-live).

---

## What you need to decide or provide

These are yours to do; the code is ready for them.

1. **Cloudflare Access application** (Zero Trust dashboard). See [Set up Cloudflare Access](#set-up-cloudflare-access).
2. **Worker secrets**: `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `PORTAL_OWNER_EMAILS`, and `RSVP_LINK_SECRET`. Until the Access secrets are set, every portal request is refused; invitation links cannot be generated without the RSVP secret.
3. **Wedding details** in Wedding Planner (Wedding settings → General): names, date, location, time zone. The defaults (Aidan & Amelia, 23 October 2027, Rhino Lodge · Dubbo, NSW) and the website's default content come from the Say I Do site.
4. **Say I Do link** (RSVPs → Settings), so the website sends guests to it while the native form is off.
5. **When to switch on the native RSVP form** (Wedding settings → Features → Native RSVP). Off by default. Say I Do stays the live RSVP until you turn this on.
6. **When to publish the website** (Website → Publish). Off by default. It's `noindex` by default too.
7. **Email and SMS providers** (Fastmail JMAP preferred, generic TLS SMTP or SMTP2Go; ClickSend for SMS), if you want the portal to send messages itself. Not configured, by design. See [COMMUNICATIONS.md](COMMUNICATIONS.md).
8. **Production is missing the `ADMIN_TOKEN` secret** (found by `npm run check:config`). It predates the portal; without it the blog's manual resync endpoint is disabled. Set it with `npx wrangler secret put ADMIN_TOKEN --env=""` (e.g. `openssl rand -base64 32`).
9. **Staging** (optional, recommended before production): see [STAGING.md](STAGING.md).
10. **Whether to merge this branch.** Merging to `main` deploys to production automatically (`.github/workflows/deploy.yml`) and would apply all unapplied migrations, including additive `0008_invitation_studio.sql`, `0009_household_invitation_names.sql` (two new household columns; it changes the invitation greeting only if it is still the old default "For") and `0010_rsvp_travel.sql` (one new table for courtesy bus and accommodation answers; no existing row is changed). This task must not be merged or migrated without explicit approval. Importing guests and generating invitations remain manual; neither sends anything.

---

## Set up Cloudflare Access

Access decides who can reach the portal at all. The Worker then verifies Access's signed token itself on every request, so a request that somehow bypasses Access (for example via `*.workers.dev`) is still refused.

1. Zero Trust → **Settings → Authentication**: make sure an email login method is enabled (One-time PIN is fine, or Google/GitHub if you prefer).
2. Zero Trust → **Access → Applications → Add an application → Self-hosted**.
    - **Application domain**: add _two_ destinations on the same application:
        - `daly.id.au` with path `portal`
        - `daly.id.au` with path `api/portal`

        (Access path matching covers everything below each path.)

    - **Session duration**: your choice; 24 hours is reasonable.
3. **Policy**: Action _Allow_, Include → _Emails_ → both of your addresses. Add other people here later, as well as in the portal.
4. Save, then copy from the application's **Overview** tab:
    - the **Application Audience (AUD) tag**
    - your **team domain** (`<team>.cloudflareaccess.com`, shown under Settings → Custom Pages or in the login URL)
5. Set the Worker secrets (they survive deploys; `keep_vars: false` in `wrangler.jsonc` would wipe plain vars set in the dashboard). Both owners' emails go in one comma-separated secret; each of you then signs in with your own Access identity:

```bash
npx wrangler secret put ACCESS_TEAM_DOMAIN   --env=""   # e.g. daly.cloudflareaccess.com
npx wrangler secret put ACCESS_AUD           --env=""   # the AUD tag
npx wrangler secret put PORTAL_OWNER_EMAILS  --env=""   # you@example.com,partner@example.com
npx wrangler secret put RSVP_LINK_SECRET     --env=""   # use a newly generated, high-entropy value
```

6. Check everything without revealing any value:

```bash
npm run check:config -- --url https://daly.id.au --team <team>.cloudflareaccess.com
```

It confirms the three secrets exist (names only), that no development-only setting is present, that `/portal` redirects to the Access login, and that `/api/portal` refuses unauthenticated requests.

For staging, see [STAGING.md](STAGING.md): it has its own Access application and secrets.

### How paths, domains and Access fit together

| Request                                               | Access in front?                             | What the Worker does                                                                                                       |
| ----------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `daly.id.au/portal…`, `daly.id.au/api/portal…`        | Yes (the application's two paths)            | Verifies the Access JWT and the role on every request                                                                      |
| `wedding.daly.id.au`, `/api/wedding/rsvp…`            | No (public)                                  | Serves only if published / switched on; the hostname exposes no portal/admin routes                                        |
| `dalyidau.<sub>.workers.dev/portal…` and preview URLs | No (unless you enable Access on workers.dev) | Still requires a valid Access JWT for _your_ application, so it refuses everyone who isn't already signed in to daly.id.au |
| Anything else                                         | No                                           | The blog                                                                                                                   |

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

| Role   | Can                                                                                                                                                                       |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner  | Everything, including managing people and roles, permanent erasure and retention. Owners come from `PORTAL_OWNER_EMAILS` and can't be changed in the portal.              |
| Admin  | Everything except managing people, erasure and retention.                                                                                                                 |
| Editor | Guests, households, events, RSVP entry, communications (prepare, not send), planning, website content, audit log. No budget, sending, exports, settings or the RSVP link. |
| Viewer | Read-only guests, RSVPs and planning.                                                                                                                                     |

Add people in **Portal settings → People and roles** _and_ in the Access policy. Removing someone from either removes their access. Removing an email from `PORTAL_OWNER_EMAILS` also removes their owner rights immediately.

---

## Security review (October 2026)

What was checked, and how it's covered by tests (`test/access.test.ts`, `test/privacy.test.ts`):

| Area                   | Result                                                                                                                                                                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Access JWT             | RS256 only; signature, issuer, audience, expiry, not-before and issued-at checked; `alg: none`, HMAC, unknown keys, forged signatures, tampered claims and malformed tokens refused. Service tokens (no email) refused.      |
| Authorisation          | Every page and API route needs a verified identity _and_ a role; each route checks its own permission server-side. A sweep test calls every write endpoint without a token (401) and as a viewer (403).                      |
| Role changes           | People can't change their own role; owners from `PORTAL_OWNER_EMAILS` can't be changed in the portal; removing an email from that secret removes owner rights immediately. Every change is audited.                          |
| Development bypass     | `ACCESS_DEV_EMAIL` works only with `ENVIRONMENT=development` **and** a localhost `SITE_URL`; `ACCESS_TEST_JWKS` is ignored in production. `check:config` fails if either is configured on a deployed environment.            |
| workers.dev / previews | Same token checks on every hostname; tested.                                                                                                                                                                                 |
| Missing configuration  | Every portal request refused; the response doesn't say which check failed (it's logged instead).                                                                                                                             |
| CSRF / cross-origin    | Writes need a same-origin `Origin` and a JSON body; any API request a browser marks as cross-site or same-site (another subdomain) is refused, including GETs such as exports.                                               |
| Caching                | Every portal page, API and CSV response, including errors and access-denied pages, is `Cache-Control: no-store` and `noindex`; portal pages are never edge-cached.                                                           |
| Client bundle          | `npm run check:bundle` (in CI) fails if any client file contains a configured owner email, team domain, token or key. Pages only ever include the signed-in user's own email; the People list is owner-only.                 |
| RSVP invitations       | Signed HMAC-SHA-256 links are long, household-scoped, versioned, expirable, revocable and checked with Web Crypto. Invalid, expired, revoked and unknown invitations return the same response. Legacy codes can be disabled. |
| RSVP submissions       | A browser-generated idempotency key and a database unique index prevent double submission, including concurrent retries. Answers are validated again on the Worker.                                                          |
| Concurrency            | Two people editing the same record can't silently overwrite each other (409 with an explanation).                                                                                                                            |

Remaining risk: optional legacy household codes are 8 characters (about 37 bits) and rely on rate limiting. Disable **Allow short household codes** after signed links have been distributed. See also [Outstanding](#outstanding).

## Feature switches

Wedding settings → Features. Stored in D1 (`feature_flags`); defaults in `src/shared/portal/flags.ts`. Every change is audited.

| Switch                                     | Default | Effect                                                                                                                                                                                         |
| ------------------------------------------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public wedding website                     | Off     | `wedding.daly.id.au` serves the site; otherwise it's a normal 404.                                                                                                                             |
| Native RSVP                                | Off     | The website's RSVP button opens our own form, and `/api/wedding/rsvp/*` accepts responses. While off, the button links to Say I Do and the API returns 404. Needs the website switched on too. |
| Email delivery                             | Off     | Allows sending email from the portal (campaigns and RSVP confirmations). Also needs `EMAIL_DELIVERY` and its provider secrets on the Worker.                                                   |
| SMS delivery                               | Off     | Allows sending texts and replies. Also needs `SMS_DELIVERY` and its provider secrets on the Worker.                                                                                            |
| Communications / Planning / Budget modules | On      | Hide a module's pages and API when you don't need it.                                                                                                                                          |

---

## RSVPs: Say I Do now, native later

- **While Say I Do is live**: set its link under RSVPs → Settings. The website's RSVP buttons go there. Record replies in the portal by hand (guest panel → RSVP tab, or select guests → Actions → Set RSVP → "Say I Do"), or import a Say I Do guest list export (see [Importing guests](#importing-guests)).
- **The guest experience**: the invitation link (or code) opens the household's invitation, listing every invited guest by full name in the order of the import file. Guests accept or decline for each person and event, or leave someone unanswered to finish later with the same link (a reply must answer at least one person), add dietary needs and any configured questions on a details step, check everything on a review step, then send. The confirmation page offers an "Add to calendar" file and a way back to change their reply until the deadline. Children are listed individually with a "Child" or "Baby" label; ask age-specific questions (for example a children's meal) with a guest question limited to children.
- **Confirmation email** (RSVPs → Settings): optional, off by default, and only sent when email delivery is on and the guest gives an address.
- **Testing the native form**: Website → Preview → RSVP (or RSVPs → "Test the native form"). The preview uses owner-only endpoints, so it works while the switch is off. Responses there are real writes, so use a test household.
- **Questions**: build household- or guest-level questions under RSVPs → Questions. Types are short text, long text, yes/no, single choice, multiple choice, number and date. Questions can depend on age, attendance at an event, or another answer. Publishing controls whether guests see a question. Meaningful edits create a new version; answers retain the question version and snapshot used when they were submitted.
- **Switching over**: set `RSVP_LINK_SECRET`, copy each household's signed link or use the `{{rsvp_link}}` merge field, test rotation and revocation, then turn on Native RSVP. Consider disabling short codes. Turning Native RSVP off reverts every public button to the configured Say I Do URL immediately.
- **How the native form is protected**: links carry a signed household id and invitation version; the secret never leaves the Worker. Rotation invalidates every older link and revocation disables the current one. Lookups are limited to 20 per 10 minutes per client and submissions to 10; clients are identified by a hash, not their IP. All invalid invitation states look identical. Only guests in that household and events they're invited to can be answered, and the whole household must be answered. Conditional answers are checked on the Worker. Each submission is stored verbatim and audited; retrying the same submission is idempotent.
- **Courtesy bus and accommodation**: see [Transport and accommodation](#transport-and-accommodation). The older per-guest "seat on the courtesy bus?" question (`q_bus`) is superseded by the household transport step while that step is on, so nobody is asked twice; its earlier answers stay in the Questions report.

## Transport and accommodation

Information gathering for booking the Dubbo RSL courtesy bus, not a booking system: nothing reserves a seat, a pick-up or a room. Rules live in `src/shared/portal/travel.ts`, shared by the form, the Worker and the planner.

**On the RSVP** (RSVPs → Settings → "Ask about the courtesy bus and accommodation", on by default; the native RSVP itself stays off until you switch it on): after the details step, households with someone coming see one optional **Travel** step, answered once for the household:

| Question                                                           | Choices                                                                                                                       | Notes                                                                                                                                                           |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Will you need the courtesy bus?                                    | Yes — to the wedding · Yes — home after the reception · Yes — both ways · No — we'll arrange our own transport · Not sure yet | For two or more guests coming, a −/+ count for each chosen direction (defaults to everyone coming; 1 to the number attending). One guest: the count is implied. |
| Where are you planning to stay?                                    | Rhino Lodge glamping · Accommodation in Dubbo · Staying with family or friends · Travelling home · Not sure yet               | Glamping shows a note that it's limited and that choosing it doesn't reserve a place.                                                                           |
| Accommodation name or location (only for "Accommodation in Dubbo") | Free text, 200 characters                                                                                                     | Used to find possible pick-up points; the form says pick-ups can't be promised.                                                                                 |

- Every answer can be left blank or cleared. The Worker re-checks counts against the guests attending in that submission, zeroes counts for a direction that wasn't chosen, and drops the accommodation name for any other choice.
- **Editing a reply** starts from the saved answer. A household that later declines everyone keeps its answer (so nothing is lost if they change their mind), but it stops counting and is flagged. A submission that doesn't include the travel step (an older form, or the step switched off) leaves the saved answer untouched.
- Each answer is stored in the RSVP submission and audited; the accommodation name is redacted from the audit log because it can be an address.

**In the Wedding Planner** (RSVPs → **Transport**; anyone with Wedding Planner access can view, editors and above can change):

- Passengers to Rhino Lodge, passengers home, passengers travelling both ways, and households/guests not sure yet. Counts are capped at the guests attending **now**, so attendance changed in the portal can't inflate the estimate.
- Where attending households are staying, and the Dubbo accommodation names they gave (grouped, as possible pick-up points).
- A table of households with filters for **Needs follow-up** (not sure about the bus or accommodation, interested in glamping, more bus seats than guests now coming, or asked for the bus while nobody is coming) and **No answer yet**.
- **Edit** (pencil) records an answer given by phone or message (`PUT /api/portal/wedding/households/:id/travel`, audited as `rsvp.travel.update`).
- **Export for the RSL** (`/api/portal/export/transport.csv`, needs the export permission, audited as `export.transport`): household, guests attending, email and phone (the household's, else the first guest's), bus choice, passengers each way, where they're staying, accommodation name, follow-up reasons and when it was answered.

Nothing from these answers is ever rendered on the public website.

**Website wording** stays editable in Website → Sections. Accommodation places have an **On-site stay at the venue** switch (shown first as a framed card marked "Limited · first in, first served", with **Get in touch** when a contact email is set; other places appear under "Staying in town"). The courtesy bus section has editable parts ("Getting to the wedding", "Getting home"). **Use suggested wording** on the accommodation, courtesy bus and FAQ sections fills the draft with the agreed October 2026 wording (`src/shared/portal/website-suggestions.ts`) while keeping other places, links and photos; nothing changes publicly until you save and publish. Production already has saved website content, so the new wording appears there only once you do that.

## Importing guests

Guests → Import (`/portal/wedding/guests/import`). Nothing is written until you press Import; the preview is the plan that gets applied.

- **Say I Do exports** are recognised by their Guest Name, Party Name and Unique link columns. Guests sharing a Unique link become one household; a party name used with two different links becomes two households, and one link used with two party names stays one household. Both are flagged. Each household keeps its Say I Do party id (`households.external_id`), so a re-import finds it again.
- **Names**: Guest Name is split into first and last names. One-word names, more than two names, odd characters and lower-case or all-caps names are flagged, with a suggested fix ("Fix capitalisation" applies all of them). Every name is editable in the preview.
- **Addresses**: "-" means no address. The guests' addresses are compared per party: variants of one address (spacing, case, a missing state or postcode) are merged, keeping the most complete; genuinely different ones are a conflict you choose between. Addresses without a number ("Good question") are flagged. Australian addresses are split into street, suburb, state and postcode, and anything that can't be placed stays on the first line.
- **RSVPs**: only an explicit Yes/No counts. An empty Attending cell is no response. "Plus One Allowed: No" never removes a named guest.
- **Matching** (no duplicates): households by Say I Do link, then by name, then by their guests; guests by email, then by name within the household, then by a unique exact name anywhere. Close names are offered as suggestions, never applied automatically. Deleted guests and households are not silently recreated. You can match any row to any existing guest or household, or skip it.
- **Overwrites need confirmation**: filling an empty field or linking a guest with no household is applied; replacing a recorded name, address, household or RSVP only happens when you tick "Replace" (or "Replace all recorded values").
- **Applying** is one D1 batch (one transaction) with compare-and-set checks: if anything changed since the preview, nothing is applied and you're asked to review again. Each import has a client id, so a double click or retry applies once. Importing the same file again shows everything as up to date.
- **Every row is accounted for**: the review has a numbered row ledger covering created, matched, linked, kept/skipped and invalid rows. Every import is in the audit log (`guest.import`) and keeps a per-row report (Guests → Import → Previous imports). Downloading the report CSV needs the export permission and is audited. Erasing a guest or household scrubs it from import reports.

## Households dashboard

Households shows each household's RSVP progress (complete, partly answered, no reply yet, not invited) next to its guests' attendance, a one-click copy of its signed invitation link, and filters by progress. Selection supports event assignment, tags, contact preferences, state/country edits, generation, copying, export and explicit soft deletion. Deletion previews guest/invitation/response counts and asks whether guests should become unassigned or be soft-deleted with the household; RSVP history is never removed. Restore deleted records from Settings → Privacy. Nothing is sent from here.

Invitation Studio generates and previews email, SMS and print versions: **one invitation per household by default**, addressed once to everyone invited. Its editable template shares Australian-native botanical artwork, accent palette, invitation wording, email greeting and email copy across A5 print and email previews. Documentation and fixture exports are explicitly marked as sample previews. Repeating generation updates the existing ledger entry (one per household, channel and link version). It never sends—approval and delivery remain separate in Communications.

### How invitations are addressed

One set of rules (`src/shared/portal/invitation-names.ts`) addresses printed invitations, Studio previews, Studio emails and texts, the `{{invitation_names}}` and `{{greeting_names}}` merge fields, the invitations CSV ("Addressed to") and the "Replying for" line on the RSVP page:

| Household                                    | Invitation reads                       | Email greeting             |
| -------------------------------------------- | -------------------------------------- | -------------------------- |
| One guest                                    | Fred Daly                              | Dear Fred                  |
| Couple, same surname                         | Fred & Ann Daly                        | Dear Fred & Ann            |
| Couple, different surnames                   | Sam Lee & Kate Smith                   | Dear Sam & Kate            |
| Family                                       | Fred, Ann, Tom & Lucy Daly             | Dear Fred, Ann, Tom & Lucy |
| Mixed                                        | Fred & Ann Daly and Kate Smith         | Dear Fred, Ann & Kate      |
| Invitation name "The Daly Family"            | The Daly Family                        | Dear the Daly Family       |
| …with "List each invited person" switched on | The Daly Family / Fred, Ann & Tom Daly | Dear the Daly Family       |

- Only guests invited to an event with RSVPs open are named, in RSVP-form order (import order, then the order they were added).
- **Invitation name** (household panel) overrides the line, e.g. "The Daly Family" or "Mr & Mrs Daly". For larger families, tick **List each invited person beneath the invitation name** to print the names underneath.
- The **Email greeting** template field is the salutation word ("Dear"). Migration 0009 changes the old default "For" to "Dear"; a greeting you chose yourself is kept.
- The RSVP page lists every invited guest by full name, and each person's attendance is chosen separately for each event.

### Individual invitations (advanced)

Studio → Advanced delivery → **Individual invitations** makes one invitation per invited person, addressed to that person, each with its own signed link and QR code. Every individual link still opens the whole household's RSVP and only highlights that guest; normal signature, version, expiry, revocation and rate-limit checks still apply. Use it only when people in a household need separate invitations.

In Communications, an **Invitation** message goes to one reachable person per household (in RSVP order), named with the household's invitation line; the rest of the household is recorded as "Included in the household invitation to …". Households that already have an invitation prepared or sent are skipped. **Send to each guest individually** is the explicit exception.

Sample: [`docs/design/assets/wedding-enhancement/household-invitations-sample.pdf`](design/assets/wedding-enhancement/household-invitations-sample.pdf) (a couple and a family, fictional names).

---

## Email and SMS

Nothing is sent from production today. You can choose email or SMS, categorise and schedule a message, filter by RSVP, event, side, group, tag, age and contact preference, preview it for any guest, and download a **mail-merge CSV**. Invitation recipients are deduplicated against earlier prepared or sent invitations.

Providers (Fastmail JMAP preferred, authenticated TLS SMTP or SMTP2Go for email; ClickSend for SMS), delivery reports, retries, text conversations, opt-outs and the activation checklist are in [COMMUNICATIONS.md](COMMUNICATIONS.md). Each channel needs its provider configured on the Worker **and** its switch on; the scheduled D1 queue stays inert until both are. Provider credentials are Worker secrets, never D1 settings.

---

## What's in the wedding management app

| Area                 | Features                                                                                                                                                                                                                                                                                                          |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Application launcher | Registry-driven cards for each enabled application the signed-in user may access.                                                                                                                                                                                                                                 |
| Dashboard            | Customisable wedding summary widgets, current tasks, RSVP progress, seating, catering, communications and budget status.                                                                                                                                                                                          |
| Dashboard            | Personal, customisable widget grid: countdown, RSVP summary, invitation readiness, seating readiness, communication status, attendance by event, replies over time, guest breakdown, dietary needs, tasks due, budget, latest online replies, recent activity. Add, remove, reorder and resize; saved per person. |
| Guests               | Searchable, sortable, filterable table (RSVP, event, side, group, tag); bulk actions (invite, set RSVP, move household, side, group, tags, delete); profile slide-over with details, per-event RSVP and activity history; custom fields; CSV import (dry run first) and export.                                   |
| Households           | Invitation units with signed links, copy, rotation, revocation, optional legacy codes, contact/postal details and safeguarded bulk actions.                                                                                                                                                                       |
| Invitation Studio    | One household invitation per household (individual invitations as an advanced option): email/SMS/print previews, signed links, real QR codes, printable PDFs and an idempotent generation ledger that never auto-sends.                                                                                           |
| Events               | Ceremony, reception and anything else, with public/private and RSVP on/off per event.                                                                                                                                                                                                                             |
| RSVPs                | Response metrics, attendance by event, replies per household, configurable conditional question builder, versioned answer reports, courtesy bus and accommodation overview with RSL export, online response log and settings.                                                                                     |
| Communications       | Email and SMS, categories, templates, recipient filters, invitation deduplication, scheduling, per-guest preview, frozen recipient lists, delivery reports, retries, SMS cost, text conversations with replies, opt-outs and mail-merge export.                                                                   |
| Seating              | Interactive table plan with capacities, unseated guests, drag/move workflow, warnings and print view.                                                                                                                                                                                                             |
| Catering             | Event meal assignments, age-aware meal categories, dietary/accessibility roll-up and CSV export.                                                                                                                                                                                                                  |
| Tasks                | List and month-calendar views, status, priority, owner, due dates, progress and overdue tracking.                                                                                                                                                                                                                 |
| Timeline             | Day-of run sheet grouped by day.                                                                                                                                                                                                                                                                                  |
| Budget               | Total budget, committed, paid, overdue; per-category progress; payment status per item; linked suppliers.                                                                                                                                                                                                         |
| Suppliers            | Directory with status, contacts and links.                                                                                                                                                                                                                                                                        |
| Website              | Content editor (wide editorial desktop hero, portrait mobile hero, focal point and alt text, welcome, sections with photos, RSVP invitation), R2 photo library, draft/publish, visibility switch, preview.                                                                                                        |
| Wedding settings     | Wedding details, feature switches and custom guest fields.                                                                                                                                                                                                                                                        |
| Portal settings      | Signed-in identity, application permissions, appearance, people and roles, and privacy controls.                                                                                                                                                                                                                  |
| Audit log            | Every change, who made it and when, with field-level before/after values; searchable, exportable. Deletes keep a full snapshot.                                                                                                                                                                                   |

Every list has a meaningful empty state, every save shows field-level validation from the server, and every change is in the audit log. Exports of personal data are audited too.

---

## Design system

- **Portal**: Untitled UI PRO application components, pulled into the repo with `npx untitledui@latest add` (see the list in `src/components/application` and `src/components/base`): sidebar navigation, breadcrumbs, table, pagination, modals, slideout menus, tabs, select, checkbox, toggle, radio, textarea, dropdown, date picker, file upload, metrics, charts base, notifications, progress indicators, badges, avatars, empty states. Portal-specific compositions live in `src/portal/components` (data table, record panel, metric card, toasts, month calendar) and are built only from those components and the theme tokens. Light and dark mode use the site's existing theme system.
- **Wedding website**: the same components, wrapped in `.wedding-theme`, which re-roots every Untitled UI token on the wedding palette (warm ivory, deep forest, eucalyptus, dusty olive, sandstone, terracotta clay) with Cormorant Garamond for display type and Jost for reading text and labels. Each section kind has its own layout (`src/wedding/home-page.tsx`); botanicals and the photo fallback landscape are inline SVG (`src/wedding/components/ornament.tsx`), so the site makes no third-party image requests. Small text uses the deeper olive-600 and clay-600 shades so it meets WCAG AA contrast; the lighter palette colours are kept for illustration and large display type. Because Untitled UI's semantic tokens are chained CSS variables, the wrapper re-declares them all; that file is generated by `node scripts/build-wedding-theme.mjs` from `theme.css`. The site is always light.
- Chart colours (`src/styles/portal.css`) were checked with a colour-blindness validator; every chart also has direct labels, a legend and an accessible table.

### Rendering and Worker CPU

Portal pages are rendered in the browser. For a portal page the Worker authenticates, loads the page's data, and sends the HTML shell with that data and a small static loading state (`src/portal/boot-shell.ts`); `src/entry-portal.tsx` then renders the page. A full React server render of a page such as the dashboard measured about 20 ms of CPU on a cold isolate (about 6 ms warm), most of each portal request's work. The portal is private and `noindex`, so nothing is lost by not rendering it on the server, and leaving it out also removed about 1.4 MB from the Worker bundle (3.3 MB → 1.9 MB, 952 kB → 572 kB gzipped), which makes cold starts cheaper. `test/portal-api.test.ts` still renders every portal page from the exact data the Worker sent, so a page that would crash is caught in CI.

This lowers CPU per portal request, but it is not a confirmed fix for the CPU-limit errors once logged on `GET /portal/wedding`: the account is on Workers Paid (30 s of CPU per request by default), far above anything measured here. See [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md) for what is still to be checked against the production logs.

The public wedding website and RSVP page are still rendered on the server, so guests see the page before any JavaScript runs: the home page costs about 1.5 ms warm (about 15 ms only on a cold isolate's first request) and the RSVP page under 1 ms.

### Builds

The blog, the portal and the wedding site are three HTML shells. `npm run build:client` runs two Vite builds: `vite.config.ts` for the blog and `vite.apps.config.ts` for the portal and wedding site. They're separate because, in one build, React Aria's package index makes every component the portal uses look shared with the blog, and roughly 220 kB of it lands in the blog's bundle. Separately, the blog's JavaScript and CSS are byte-for-byte the size they were before the portal existed. `src/styles/globals.css` also excludes portal-only sources from the blog's Tailwind scan; if the blog starts using one of the excluded component folders, remove it from that list.

---

## Data model (D1, migrations `0002`–`0010`)

| Table                                                               | Contents                                                                                                |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `portal_users`                                                      | Email, name, role, active, last seen                                                                    |
| `audit_log`                                                         | Append-only change history                                                                              |
| `feature_flags`, `settings`, `dashboard_layouts`                    | Switches, settings documents (JSON), personal layouts                                                   |
| `households`, `guests`, `events`, `guest_events`                    | The guest list; a `guest_events` row means "invited", its status is the RSVP                            |
| `custom_fields`                                                     | Extra guest fields (values live in `guests.custom`)                                                     |
| `guest_imports`, `guest_import_rows`                                | Applied guest imports and their per-row reports                                                         |
| `rsvp_submissions`, `rsvp_questions`, `rsvp_answers`, `rate_limits` | Native RSVP history, versioned custom questions/answers and limiter windows                             |
| `rsvp_travel`                                                       | One row per household: courtesy bus choice, passengers each way, where they're staying (migration 0010) |
| `message_templates`, `messages`, `message_recipients`               | Categorised and scheduled email/SMS communications with per-recipient delivery state, attempts and cost |
| `sms_messages`, `comm_webhook_events`                               | Text conversations (outbound and inbound) and deduplicated provider webhooks                            |
| `seating_tables`, `seat_assignments`, `catering_assignments`        | Table plan and catering choices                                                                         |
| `website_media`                                                     | R2 gallery/photo metadata                                                                               |
| `tasks`, `timeline_items`, `suppliers`, `budget_items`              | Planning and budget (money in cents)                                                                    |

Applications are registered in `src/shared/portal/applications.ts`; the registry drives the launcher, application permission gate and application sidebar. Adding a wedding module usually means: a table in a new migration, an `EntityDef` in `worker/portal/entities.ts` (that alone gives validated, audited CRUD at `/api/portal/wedding/<name>`), a loader in `worker/portal/pages.ts`, a page in `src/portal/pages`, and a registry navigation entry. Adding a dashboard widget: its type in `WIDGET_TYPES`, its data in `computeStats`, and its renderer in `src/portal/dashboard/widgets.tsx`.

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

`ACCESS_DEV_EMAIL` lets local development act as that person without Access. It only works when `ENVIRONMENT=development` _and_ `SITE_URL` is on localhost, neither of which is true for a deployed Worker. The seed script refuses to run against anything but localhost.

## Tests

- `npm test` (Vitest in workerd): Access and route protection, privacy, migrations, communications safeguards, signed invitation rotation/revocation, conditional question/version/summary behaviour, idempotent submissions, seating/catering logic, wedding site visibility and server rendering.
- `npm run test:e2e` (Playwright, desktop and mobile): every portal page hydrates without console errors or horizontal overflow, responsive navigation, question builder, guest CRUD, dashboard customisation, native RSVP, and the RSVP → seating → catering workflow.
- `npm run check:styles`: rejects direct Tailwind palette utilities in portal/wedding code so Untitled UI semantic tokens remain mandatory.

## Going live

When you're ready (none of this has been done):

1. Complete [PRODUCTION-LAUNCH.md](PRODUCTION-LAUNCH.md), including Access and the four required secrets.
2. Merge the branch only after approval. CI runs, then the deploy workflow applies pending migrations and deploys.
3. Sign in at `https://daly.id.au/portal`, open Wedding Planner, then fill in Wedding settings → General, events and guests.
4. Preview the website, then publish it when you're happy.
5. Keep Say I Do live until you've tested the native form, then switch over.

## Outstanding

- Native RSVP, public website publishing and production email delivery remain disabled until separately approved. Say I Do remains the live RSVP destination: <https://sayi.do/aidanandamelia2258/>.
- Fastmail JMAP, generic authenticated TLS SMTP, SMTP2Go and ClickSend are implemented but not configured: accounts, any required DNS records, a dedicated SMS number, secrets and controlled tests are still to do ([COMMUNICATIONS.md](COMMUNICATIONS.md#activation-checklist-needs-your-approval)). Confirm with ClickSend that links on `wedding.daly.id.au` are allowed before any SMS invitations.
- Staging has not been deployed and its URL remains a placeholder.
- Erasure can't reach downloaded exports, backup files or D1's 30-day Time Travel history ([PRIVACY.md](PRIVACY.md#places-the-portal-cant-reach)).
