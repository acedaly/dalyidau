# Wedding Planner security and privacy review

**Date:** 17 October 2026 · **Scope:** the private portal (`/portal`, `/api/portal/*`), the public wedding site (`wedding.daly.id.au`), the guest pages from PR #19 (`/invitation`, `/invitation.pdf`, `/save-the-date`, `/save-the-date.ics`), the public RSVP API, communications (Fastmail, ClickSend, SMTP2Go webhooks), D1, R2, backups, logging and browser protections. **Branch:** `security/wedding-review` (built on PR #19).

This report contains no guest records, credentials or signed links. Production was only read: four read-only queries (settings flags, role counts, template and message counts) and unauthenticated `GET` requests to public URLs.

## Recommendation

**GO, once this PR (and PR #19, which it builds on) is deployed and the owner actions below are done.** No critical or high-severity issues were found. Four medium and three low findings are fixed in this PR. Until it's deployed, production still has two of them: the RSVP page's cache headers (F3) and the webhook secret in request paths (F2).

Owner actions before invitations go out by SMS:

1. Merge PR #19, then this PR, and deploy. GitHub's deploy workflow has been failing since 14 October (invalid `CLOUDFLARE_API_TOKEN`), so this needs a manual deploy or a fixed token.
2. In ClickSend (and SMTP2Go if it's used), change the webhook URLs to the `?key=` form (docs/COMMUNICATIONS.md), then rotate `COMMS_WEBHOOK_SECRET` (F2).
3. Run `node scripts/db-backup.mjs --prune 5` once. It makes the existing backups owner-only and deletes all but the newest five per environment (F7). There are currently 12 production backups on the development Mac, dated 12–17 October.

## What was reviewed

| Area                    | Endpoints and flows                                                                                                                                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Portal authentication   | `worker/portal/access.ts` (Access JWT), `worker/portal/auth.ts` (roles), `portalPage` and `portalApi` in `worker/index.ts`                                                                            |
| Portal authorisation    | All 87 routes in `worker/portal/api.ts`: guests, households, invitations, Communications, RSVP reports, catering/dietary, transport, seating, CSV/JSON exports, PDFs, settings, users, privacy, audit |
| Signed invitation links | `worker/wedding/invitations.ts` (HMAC-SHA256 tokens, version, revocation, expiry), RSVP codes                                                                                                         |
| Public RSVP API         | `POST /api/wedding/rsvp/lookup` and `/submit` (`worker/wedding/rsvp.ts`)                                                                                                                              |
| Guest pages             | `/invitation`, `/invitation.pdf`, `/rsvp`, `/save-the-date`, `/save-the-date.ics`, the wedding website, `/wedding/media/*`                                                                            |
| Communications          | Fastmail JMAP, ClickSend, SMTP/SMTP2Go adapters, preview, test send, send check, scheduled sends, opt-outs, webhooks                                                                                  |
| Data stores             | D1 (only bound to the Worker), R2 `dalyidau-media`, local backups (`scripts/db-backup.mjs`), migrations and seed scripts                                                                              |
| Browser and telemetry   | Security headers, CSP, cache and referrer policies, the Worker's own logs, Cloudflare Workers Logs and traces                                                                                         |

## Controls verified

**Private portal**

- Cloudflare Access fronts `/portal` and `/api/portal/*` at the edge; live, an anonymous request is redirected to the Access login.
- The Worker doesn't rely on that alone. It verifies the Access JWT itself: RS256 only (no `none` or HMAC confusion), the team's published keys, issuer, audience, expiry, not-before, and an email claim (service tokens are refused). Missing configuration fails closed.
- Roles come from `PORTAL_OWNER_EMAILS` or an active `portal_users` row. A verified identity with no role gets 403.
- Every API route declares a permission, and the router enforces it before the handler runs. Hidden buttons are never the control. Module switches are enforced server-side too.
- Exports, PDFs and the full JSON export need `wedding.export` (owners and admins). Erasure and retention are owner-only and need typed confirmation.
- Mutations require a same-origin `Origin` and a JSON body (CSRF). Every portal call, including GETs, refuses `Sec-Fetch-Site: cross-site`.
- The wedding host returns 404 for `/portal`, `/api/portal/*`, `/api/admin/*` and `/api/comms/*` (confirmed live).
- `/api/admin/*` needs a bearer token of at least 24 characters, compared in constant time.

**Signed invitation links**

- The token holds a random household id, a version, an optional guest id, and a 256-bit HMAC-SHA256 under `RSVP_LINK_SECRET` (at least 32 bytes). It's verified with `crypto.subtle.verify`, in constant time.
- A token is refused when:
    - its format is wrong, or it's altered, truncated, re-pointed or signed with another secret;
    - its version doesn't match the household (rotated);
    - the household is revoked or deleted;
    - its guest isn't in that household;
    - it's past the RSVP deadline plus `linkExpiryDays` (60 in production).
- All of these give the same response, so they can't be told apart.
- Holding a link gives access to that one household and nothing else. Submitting for a guest or event outside the household is rejected, not ignored. The portal never accepts a household id alone as a credential.
- Revoking and rotating are available per household and are audited.
- RSVP codes: 8 characters from a 25-character alphabet (about 1.5 × 10¹¹ combinations), rate-limited per visitor (20 lookups and 10 submissions per 10 minutes). Production has codes switched on.

**Leakage**

- `observability.redact_query_string` is set, so Cloudflare Workers Logs and traces drop query strings, and with them `?invite=` tokens. It's a real Wrangler option, documented as "Whether query strings are removed from request URLs in logs and traces."
- The Worker's own logs record paths, never queries or bodies. Webhook secrets in paths are now masked (F2).
- No analytics or third-party scripts: the CSP allows scripts from `'self'` only.
- The invitation page, PDF, RSVP page and legacy RSVP redirect are `no-store`, `noindex` and `no-referrer` (header and `<meta>`, F3). Titles and link previews never name a household.
- Save the Date calendar links and the `.ics` file are generic and public, built from settings only. They carry no household name, code or signed link (tested).
- The PDF is only served for a valid signed link (`/invitation.pdf?invite=…`). Portal PDFs need a sign-in and `wedding.export`.

**Data minimisation**

- The public RSVP lookup returns only the household's own invited guests (names, age group, dietary), its events, answers and travel. It returns no email, phone, address, notes, RSVP code, other households or communications history (tested).
- The public website, Save the Date page, `.ics`, sitemap and robots file contain no guest data (tested).
- The audit log redacts sensitive fields (email, phone, dietary, address, notes).

**Communications**

- Provider credentials are Worker secrets. `check:config` confirms none are plain variables. Status responses report provider names and the From address only, and errors never echo credentials.
- **Recipient isolation:**
    - Each email carries only its own household's link and PDF.
    - A specific selection is never broadened by filters, and an empty one is never treated as "everyone".
    - One reachable person per household.
- **Duplicate and repeat-send protection:**
    - Overlapping sends deliver once (message and recipient claims).
    - Once-per-household campaigns are checked when the draft is prepared and again at send.
    - A send needs the confirmed recipient count.
- **Opt-outs:** re-checked at send. STOP replies opt a number out automatically.
- **Tests:** go only to approved test recipients, are labelled `[TEST]`, and never count as contacting anyone.
- Webhooks:
    - A wrong secret, or none configured, gives 404, and the secret is compared in constant time.
    - Payloads are limited to 64 KB.
    - Each event is stored once under a unique key, so provider retries and replays are harmless.
- Existing tests cover all of this (`test/invitation-delivery.test.ts`, `test/communications-studio.test.ts`, `test/comms-providers.test.ts`).

**RSVP abuse**

- Lookups and submissions are rate-limited per client IP (hashed, never stored raw) in D1.
- Schemas cap every field (zod).
- Retries carrying the same client id return the saved result without writing twice or sending a second confirmation; a unique index is the final guard.
- The deadline is enforced server-side.
- Requests must come from the same origin with a JSON body.
- React escapes everything it renders, and emails escape every string. The only raw-HTML render is the blog's article body, which is built by escaping every string.
- CSV exports neutralise formulas.
- No CAPTCHA: links are unguessable and codes are rate-limited, so it would only add friction for guests.

**Data stores**

- D1 is reachable only through the Worker binding, and nothing exposes SQL.
- Migrations contain no `DROP`, `DELETE` or `TRUNCATE`.
- `seed-staging` refuses to run if staging and production share a database; `seed-portal` refuses anything but localhost.
- Deleting a record is reversible; erasing needs it deleted first, then owner confirmation.
- **R2:** blog images live under 24-hex-character keys, and wedding photos are served only from `wedding/` with random 96-bit names. Unpublished photos need a portal sign-in. Nothing guest-related (imports, PDFs) is stored in R2.
- **Backups:** `backups/` is git-ignored and has never been committed (checked in git history). They aren't in the deployed assets either (`dist/client` holds only the build).

**Browser protections**

- Every Worker response carries:
    - a CSP (`default-src 'self'`, scripts from self only, `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`, `upgrade-insecure-requests`);
    - `X-Frame-Options: DENY`;
    - `X-Content-Type-Options: nosniff`;
    - HSTS;
    - a Permissions-Policy;
    - `Cross-Origin-Opener-Policy`.
- Static assets get `nosniff` and HSTS from `_headers`.
- The app sets no cookies of its own. The only cookie is Cloudflare Access's `CF_Authorization`, which Access manages.
- These headers don't break the email artwork, invitation PDFs or the RSVP form: the full Playwright suite checks for console errors on these pages.

## Findings and fixes

| #   | Severity | Finding                                                                                                                                                                                                                                                                                                                                                    | Status                                                                                                                                                                                                                                                                                               |
| --- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | Medium   | **A read-only viewer could obtain RSVP credentials.** `invitations/preview` and `messages/preview` (both `wedding.view`) returned every household's signed link, QR code and code, and household lists and page data included RSVP codes. A viewer could then change any household's RSVP on the public form. No active viewers exist in production today. | **Fixed.** Both previews now need `wedding.comms.edit`. For anyone without `wedding.rsvp.edit` (viewers), every portal API response and page payload has `rsvpCode` and `qrDataUrl` removed and every `invite=` token masked (`hideCredentials`, applied centrally in the router and page renderer). |
| F2  | Medium   | **The webhook secret was recorded in logs.** It was the last path segment of the webhook URL. Query strings are redacted from Cloudflare's logs and traces, but paths aren't, and the Worker's own error log recorded the path too.                                                                                                                        | **Fixed in code.** The secret is now accepted as `?key=` (redacted); the old path form still works so existing provider settings don't break; the Worker's logs mask webhook paths (`worker/lib/log.ts`). **Owner action:** update the provider URLs, then rotate the secret.                        |
| F3  | Medium   | **The RSVP page opened with a signed link was cacheable and sent a referrer.** `/rsvp?invite=…` was served `public, max-age=0` with `strict-origin-when-cross-origin`, and the legacy `daly.id.au/wedding/rsvp?invite=…` 301 had no cache controls (confirmed live).                                                                                       | **Fixed.** `/rsvp` (both hosts) and the legacy redirect are `no-store`, `noindex, nofollow` and `no-referrer`, with a referrer `<meta>` tag. The invitation pages from PR #19 already were.                                                                                                          |
| F4  | Medium   | **Body size limits trusted Content-Length.** The RSVP API (50 KB), portal API (1.5 MB) and webhooks (64 KB) buffered a chunked body completely before checking its size.                                                                                                                                                                                   | **Fixed.** `readText` enforces the limit while the body streams and cancels it when exceeded (413; 400 for webhooks).                                                                                                                                                                                |
| F5  | Low      | **Invitation page and PDF had no rate limit.** Each request builds the invitation, and the PDF is about 0.6 MB.                                                                                                                                                                                                                                            | **Fixed.** Per-visitor limits in D1: 20 PDFs and 60 pages per 10 minutes (429 with `Retry-After`).                                                                                                                                                                                                   |
| F6  | Low      | **Test signing keys (`ACCESS_TEST_JWKS`) were honoured on staging.** A key set left in staging's variables would let anyone sign their own portal identity there.                                                                                                                                                                                          | **Fixed.** Honoured only when `ENVIRONMENT` is `test` or `development`.                                                                                                                                                                                                                              |
| F7  | Low      | **Local production backups were readable by any account on the Mac** (mode 644), and there was no retention tooling.                                                                                                                                                                                                                                       | **Fixed in code.** The backup script makes `backups/` 0700 and every file 0600 (including existing ones), and `--prune N` keeps the newest N per environment. **Owner action:** run it once.                                                                                                         |

## Remaining risks (accepted or for the owner)

- **Forwarded links.** Anyone holding a household's link can see and change that household's RSVP, which is the purpose of the link. If one is shared by mistake, revoke or rotate it. Links stop working 60 days after the RSVP deadline.
- **RSVP codes** are shorter than links. They're rate-limited per IP but have no global limit, which is fine at this guest-list size. Optionally add a Cloudflare WAF rate-limiting rule for `/api/wedding/rsvp/*` (dashboard change; needs your approval). Switching codes off (`allowCodes`) removes this risk entirely once printed invitations no longer depend on them.
- **Confirmation email address.** Someone holding a valid link or code can have the RSVP confirmation sent to an address they type, and can set the household's email if it has none. That's rate-limited, and it only exposes that household's own RSVP.
- **Website photos** are public once the site is published, under random 96-bit names.
- **D1 Time Travel** keeps erased data recoverable by the account owner for up to 30 days (documented in PRIVACY.md).
- **Erased records lose their opt-out marker.** Re-importing an erased guest would make them contactable again.
- The CSP allows inline styles (`'unsafe-inline'` in `style-src`), which React and Tailwind need; scripts are self-only.
- **The live wedding site is public.** `wedding.daly.id.au` currently returns 200 to anonymous visitors, so the "Public wedding website" switch is on in production. It shows no guest data (tested), but confirm that's intended.

## Test results

- **Vitest, 385 tests, all passing.** The new `test/security.test.ts` checks that:
    - all 87 portal API routes, read from the source, refuse anonymous visitors (401) and identities without a role (403); portal pages, exports and PDFs do too; tokens signed with another key are refused; self-signed tokens are refused on staging and production;
    - viewers never receive RSVP codes or signed links (API responses and page data) and can't build invitation or message previews;
    - one household's link opens only that household; answering for another household's guest or an uninvited event is refused, and the other household's RSVP is unchanged;
    - altered, re-pointed, re-versioned, truncated and foreign-secret tokens are refused, as is a household id on its own; revoked and rotated links stop working on the RSVP API, the invitation page and the PDF;
    - the RSVP page, invitation page, PDF and legacy redirect use `no-store`, `no-referrer` and `noindex`;
    - public pages, the `.ics` file, the sitemap and robots carry no names, contact details, dietary notes, codes or links;
    - the PDF rate limit applies per visitor;
    - oversized bodies are refused, including streamed bodies with no Content-Length;
    - webhooks with a wrong or missing secret store nothing; the `?key=` form and the old path form both work; webhooks are unreachable on the wedding host;
    - the Worker's logs never contain a signed link, the webhook secret or a guest email, including when a webhook fails.
- **Existing suites:**
    - `test/guest-journey.test.ts` (invitation page security, calendar content);
    - `test/invitation-delivery.test.ts` (per-household links and PDF attachments whose QR codes decode to their own household's link; specific selections never broadened);
    - `test/communications-studio.test.ts` (overlapping sends deliver once, opt-outs re-checked at send, test sends isolated);
    - `test/access.test.ts` (JWT verification, roles, inactive users).
- **Playwright, 59 tests, all passing** (desktop and mobile). They include the invitation-page-to-RSVP journey and console-error checks with the security headers in place.
- **Build and checks:** `npm run build`, `check:config`, `check:bundle`, `check:styles` and Prettier all pass.
- **Manual checks on production (read-only):**
    - Anonymous requests to `/portal/wedding`, `/api/portal/me` and `/api/portal/wedding/guests` are redirected to the Access login with `no-store`.
    - The wedding host returns 404 for `/portal` and `/api/portal/me`.
    - A wrong webhook secret returns 404.
    - Security headers are present on the wedding host.
    - `/rsvp` is currently served with `public, max-age=0` and `strict-origin-when-cross-origin` (F3, fixed here, not yet deployed).
    - Settings and counts: no active viewer or editor accounts; RSVP codes are on; links expire 60 days after the deadline.
