# Wedding Planner production readiness

Status on 17 October 2026, for the final feature sprint (branch `feature/communications-studio`, which builds on PR #15). **Not merged, not deployed, nothing switched on, nothing sent.** Merging to `main` deploys to production and applies migration `0011`; that needs the owners' approval.

This report separates four things: what is implemented **and verified** by automated tests, what is implemented but **not yet live-tested** with real providers or devices, what is **blocked** on provider or Cloudflare configuration, and what was **deferred**.

## Summary

The critical guest journey (one household: Invitation Studio → Communications draft → the exact email → send check → send → open the personalised link → RSVP → recorded in Wedding Planner) works end to end in automated tests with a mocked Fastmail, and in a real browser up to the point of sending (the e2e Worker has no provider). **It has not been demonstrated with a real Fastmail send and a real inbox**, so the release is not ready to call production-ready until the UAT script below is run once by the owners.

---

## 1. Implemented and verified (automated)

`npm test`: **349 passed** (22 files), plus `typecheck`, `check:styles` and `check:bundle` clean. `npx playwright test e2e/portal.spec.ts e2e/communications-studio.spec.ts`: all passed on desktop and mobile. The full e2e suite result is in the PR.

| Area                            | What's covered                                                                                                                                                                                                                                                                                                                                   | Tests                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| Communications Studio           | Five campaign types, one message per household by default, individual delivery, "send again", default wording and stationery settings                                                                                                                                                                                                            | `test/communications-studio.test.ts`                           |
| Save the Date                   | Household-addressed; designed card with Add to Calendar (Apple/.ics, Google, Outlook, Microsoft 365); text to the public page; never changes RSVPs, invitation versions or links; RSVP links, codes and deadlines refused                                                                                                                        | same                                                           |
| RSVP reminders                  | Targets (no reply, partly answered, follow-up) with reasons; replied households never included; re-checked at send and by the scheduler; no second reminder within 24 hours                                                                                                                                                                      | same                                                           |
| Final information               | Event times or "time to be confirmed", household bus answer capped at guests coming, only attending households                                                                                                                                                                                                                                   | same                                                           |
| Thank you                       | Per-household notes (redacted in audit), empty optional lines dropped, printable cards                                                                                                                                                                                                                                                           | same                                                           |
| Duplicate protection            | Once-per-household campaigns at prepare and at send; double click and overlapping sends deliver once (message and recipient claims)                                                                                                                                                                                                              | same                                                           |
| Send check and confirmation     | Exclusions with reasons, link and publishing warnings, SMS parts and estimated cost, full delivery address list; bulk sends and scheduling need the confirmed count; editors can't send, schedule or test (scheduling via prepare included)                                                                                                      | same                                                           |
| Controlled tests                | Approved test recipients only; `[TEST]` labelled; never in delivery history; no RSVP or household change; work with the delivery switch off                                                                                                                                                                                                      | same                                                           |
| Recipient selection             | Specific / filtered / all; a specific selection is never broadened by filters and is never "everyone" when empty; one household reaches that household alone                                                                                                                                                                                     | `test/invitation-delivery.test.ts`                             |
| Studio → Communications         | Generating never sends; one draft per channel for exactly the selected households; duplicate drafts refused; explicit replace of unsent drafts only; sent history untouched; editor/viewer permissions                                                                                                                                           | same                                                           |
| Invitation email                | The Studio card in the body (addressing, date, venue, events, deadline, "RSVP" button, visible fallback link); each email contains only its own household's signed link; decorative images only; template captured at prepare                                                                                                                    | same                                                           |
| PDF attachments                 | Per-household Studio PDF uploaded as a JMAP blob and attached; failed upload fails that household (never sent without it); providers that can't attach refuse; SMTP MIME (`multipart/mixed`, base64, filename)                                                                                                                                   | same                                                           |
| Provider failures               | Failure recorded per recipient; retry sends only failures                                                                                                                                                                                                                                                                                        | same                                                           |
| RSVP integration                | The link from the sent email opens the household with its invited guests; per-guest answers saved; nothing reaches other households                                                                                                                                                                                                              | same                                                           |
| Guest invitation page           | The invitation text links to the household's own page (same signed link): its invitation, an RSVP button to the existing form, and its PDF with a QR code that scans to its own link; tampered, replaced, revoked and expired links refused with a page naming nobody; closed until the website is published; `no-store`, `noindex`, no referrer | `test/guest-journey.test.ts`, `e2e/guest-pages.spec.ts`        |
| Save the Date page and calendar | Public page and `.ics` (correct MIME and download headers, CRLF, escaping, folding, stable UID, all-day with exclusive end unless start and finish are confirmed, Sydney time as UTC); Google and Outlook links; no household details; closed until switched on                                                                                  | same                                                           |
| Contact readiness               | Per-household flags (no contact, unreachable, email or text only, invalid mobile, opted out); filters on Households                                                                                                                                                                                                                              | `test/communications-studio.test.ts`                           |
| Household timeline              | Messages (sent, held, failed), Studio generation, RSVPs and replies; reply text only for people who can read conversations; tests excluded                                                                                                                                                                                                       | same                                                           |
| Migration 0011                  | Additive; only fills the new `household_id`; new tables exist                                                                                                                                                                                                                                                                                    | same                                                           |
| Mobile numbers, erasure         | E.164 everywhere, legacy review, erasure of legacy numbers and household webhooks                                                                                                                                                                                                                                                                | `test/mobile-numbers.test.ts`, `test/privacy.test.ts` (PR #14) |
| Portal rendering                | Every portal page renders from the data the Worker sends; portal responses carry only a loading shell                                                                                                                                                                                                                                            | `test/portal-api.test.ts`, `test/access.test.ts` (PR #15)      |

## 2. Implemented, not yet live-tested

| Item                                                       | Why it isn't verified yet                                                                                                                                                                                                                                                                           | How to verify                                                                           |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Real Fastmail delivery of the invitation email and PDF     | Tests mock JMAP (session, upload, `Email/set`, submission). The upload and attachment shapes follow RFC 8620/8621, but no real Fastmail account was used.                                                                                                                                           | UAT step 6–9                                                                            |
| Rendering in Fastmail, Apple Mail, Gmail, iOS/Android mail | Checked in Chromium at 720 px and 390 px only (`docs/design/assets/communications-studio/email-*.jpg`). The layout uses tables, inline styles, no background images and a small-screen media query, which these clients support; Outlook desktop ignores the media query and keeps desktop spacing. | Send tests to accounts on each client                                                   |
| PDF generation cost during large sends                     | Each attachment is built with pdf-lib while sending (artwork cached per isolate). Not profiled in production.                                                                                                                                                                                       | Send to 20–50 households first; split very large sends into batches of 100–200          |
| ClickSend SMS campaigns                                    | Mocked in tests.                                                                                                                                                                                                                                                                                    | One controlled text to an approved test mobile                                          |
| Scheduled sends on the production cron                     | Covered with mocked providers; the cron itself runs every 15 minutes.                                                                                                                                                                                                                               | Schedule a test-household message 20 minutes ahead                                      |
| iPhone Safari RSVP                                         | The existing RSVP e2e tests run on a Pixel 7 profile and desktop Chrome, not WebKit.                                                                                                                                                                                                                | Open a test household's link on an iPhone                                               |
| Worker CPU on `GET /portal/wedding`                        | PR #15 removes the portal's server render (about 20 ms cold) and 1.4 MB from the Worker. The account is on Workers Paid (30 s default), so this is **not a confirmed fix** for the earlier CPU-limit errors.                                                                                        | Check the original log entry (outcome, `cpuTime`, date) and Workers → Settings → Limits |

## 3. Blocked by provider or Cloudflare configuration

- **Feature switches** (Portal settings → Features): Email delivery, SMS delivery, Public wedding website, Public Save the Date page and Native RSVP are all off. The invitation link opens the native RSVP only when both of the last two are on; the send check warns about this.
- **Fastmail**: `EMAIL_DELIVERY` is `fastmail` in `wrangler.jsonc`; `FASTMAIL_API_TOKEN` must be a Worker secret with Mail and Email Submission scopes, and `wedding@daly.id.au` must be an identity. Validate under Communications → Email & SMS settings.
- **ClickSend**: `SMS_DELIVERY` is `clicksend`; credentials, the dedicated number (`SMS_FROM`) and ClickSend's approval of `wedding.daly.id.au` links are still to be confirmed (COMMUNICATIONS.md).
- **Test recipients**: none are set. An owner adds their own addresses and mobiles in Email & SMS settings before any test send.
- **`RSVP_LINK_SECRET`, Access** (`ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `PORTAL_OWNER_EMAILS`), `COMMS_WEBHOOK_SECRET` and `ADMIN_TOKEN`: see PRODUCTION-LAUNCH.md. Without the RSVP secret, invitation links and the invitation card can't be produced (drafts hold households back with "Invitation links aren't set up").

## 4. Deferred (non-essential)

- A side-by-side comparison of every public website section on real devices (Part 9) and a fresh iPhone pass of the RSVP flow (Part 6) beyond the existing automated accessibility and overflow checks.
- A full repeat of the October security review: this sprint reviewed only the new endpoints (permissions per route, test recipient allowlist, PDF previews limited to a message's own recipients, tokens never in repository samples).
- Inline QR codes in the email body: email clients block inline (data-URI) images, so the email uses the household's link button and written-out link, and the QR code is in the optional PDF.
- Cloudflare Email Service attachments (refused for now rather than silently omitted).

---

## Database migrations 0011 and 0012

`migrations/0011_communications_studio.sql`, additive:

- `message_recipients.household_id` (new column, indexed with status), filled for existing rows from each recipient's guest (or, for RSVP confirmations, the household id they already use). No other column or row changes.
- `messages.options` (JSON, default `{}`): individual delivery, "send again", Studio source and the captured invitation template.
- `message_tests`: controlled test sends, deleted with their message.
- `thank_you_notes`: one personal note per household, deleted with the household.

`migrations/0012_household_consent.sql`, additive: `households.email_opt_out_at` and `households.sms_opt_out_at` (empty). A campaign can fall back to a household's own email or mobile when none of its guests can be reached; an unsubscribe or STOP through that address or number is recorded on the household, and consent then belongs to the address or number wherever it's used (the household, and any guest who shares it).

Upgrade compatibility: older Workers ignore the new columns and tables; the new Worker treats messages without `options` as household campaigns with no "send again", and recipients without `household_id` as unknown (which can only hold back, never add, a recipient).

## Before deploying

1. Back up: `npm run db:backup -- --env production` (verified backup, see DATABASE.md), and note the D1 Time Travel bookmark the deploy job records.
2. Record row counts: `npm run db:verify`, plus `SELECT COUNT(*) FROM message_recipients`, `messages`, `households`, `guests`, `guest_events`.
3. Merge PR #15, then this PR (each runs CI; merging deploys).

## After deploying: data checks

- `SELECT COUNT(*) FROM message_recipients WHERE household_id IS NULL`: only recipients whose guest has since been deleted or has no household.
- Counts from step 2 unchanged for households, guests and RSVPs (`guest_events`).
- Open Households: each household shows its contact flags; open one to see its Communications history.
- Open Invitation Studio: households previously generated show "Generated".
- Nothing queued unexpectedly: `SELECT id, status, scheduled_at FROM messages WHERE status IN ('queued', 'sending')`.

## Recovery

- **Code**: revert the merge commit on `main` (deploys the previous Worker). The new columns and tables are ignored by the old code.
- **Data**: restore the backup, or use D1 Time Travel to the recorded bookmark (`npx wrangler d1 time-travel restore dalyidau-production --bookmark <id>`), following DATABASE.md. Time Travel also reverts any RSVPs received since, so prefer a code revert unless data is damaged.
- **Stop sending immediately**: switch off Email delivery and SMS delivery (Portal settings → Features). Queued messages stay queued and are re-checked when the switches come back on.

---

## UAT script: one household (to be run by the owners)

Use a real guest who has agreed to help (for example a family member), and your own address as a test recipient. Steps 1–5 are covered by automated tests and the e2e journey; 6–13 need a real send.

| #   | Step                                                                                                                             | Status                               |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| 1   | Invitation Studio: select one household                                                                                          | Automated (e2e)                      |
| 2   | Tick Email (and the PDF); Preview every version → Email; Generate (do not send)                                                  | Automated (e2e)                      |
| 3   | The household shows "Email draft"; Review and send opens it                                                                      | Automated (e2e)                      |
| 4   | Preview the exact email; open the household's PDF from the send check                                                            | Automated (tests, e2e)               |
| 5   | Send check lists exactly one address, the guest's                                                                                | Automated (tests, e2e)               |
| 6   | Add your test address; Send a test with this household's details; check your inbox                                               | Owner                                |
| 7   | Switch on Email delivery; Send to 1 household (confirm)                                                                          | Owner, needs approval                |
| 8   | Guest confirms receipt; botanical design visible, also with images blocked                                                       | Owner                                |
| 9   | PDF attached, opens, QR code scans to the same link                                                                              | Owner                                |
| 10  | The link opens the household's RSVP                                                                                              | Automated (tests) / Owner on a phone |
| 11  | Each invited guest appears                                                                                                       | Automated (tests) / Owner            |
| 12  | Submit; the reply appears in RSVPs and the household's history                                                                   | Automated (tests) / Owner            |
| 13  | No other household was contacted: the message shows one sent recipient; Communications history of another household is unchanged | Automated (tests) / Owner            |

Switch Email delivery off again afterwards until you're ready for everyone.
