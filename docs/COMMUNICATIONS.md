# Communications: email (Fastmail JMAP, SMTP or SMTP2Go) and SMS (ClickSend)

Wedding Planner prepares, sends and tracks guest email and text messages from one place
(**Wedding Planner → Communications**). Providers sit behind a small interface (`worker/comms/providers.ts`),
so the portal never depends on a particular service.

**Nothing is sent today.** Sending needs, per channel, all of:

| Channel | Worker setting                                 | Secrets                                   | Switch (Wedding settings → Features) |
| ------- | ---------------------------------------------- | ----------------------------------------- | ------------------------------------ |
| Email   | `EMAIL_DELIVERY = "fastmail"` and `EMAIL_FROM` | `FASTMAIL_API_TOKEN`                      | Email delivery                       |
| SMS     | `SMS_DELIVERY = "clicksend"` and `SMS_FROM`    | `CLICKSEND_USERNAME`, `CLICKSEND_API_KEY` | SMS delivery                         |

Both start `off` in `wrangler.jsonc`, and both switches default off. `log` modes exist for tests and local development and are ignored in production.

---

## How it works

- **Prepare** a message (choose Email or Text message, a category, an audience, a schedule). The recipient list is frozen with each guest's email or mobile number. Guests without one, or who have opted out, are recorded as _skipped_ with the reason.
- **Send** (admins and owners). The message is claimed atomically so a double click can't send twice. Each recipient's provider id, attempt count and (for SMS) cost are stored.
- **Retry** failed recipients from the message page. Only failures are retried, up to three attempts each.
- **Schedule**: the existing 15-minute cron sends due messages, only on channels whose safeguards are on.
- **Delivery reports** arrive by webhook and update each recipient: _delivered_, _bounced_, _complained_, _undelivered_.
- **Text conversations** (Communications → Text conversations): every outbound and inbound SMS by mobile number, matched to guests, with manual replies. Reading conversations needs the communications permission (editors and up). Replying needs the send permission (admins and owners).
- **Consent**: a reply of `STOP` (or `UNSUBSCRIBE`, `OPT OUT`…) marks the guest as opted out of texts; an SMTP2Go spam complaint or unsubscribe marks them opted out of email. When a message went to a household's own email or mobile (none of its guests could be reached), the opt-out is recorded on the household. Consent belongs to the address or number: a household's opt-out also covers any guest who shares that address or number, and a STOP from a number opts out every guest and household with it. Opted-out guests are skipped at prepare time _and_ re-checked at send time.
- **RSVP confirmations**: with RSVPs → Settings → "Email a confirmation…" on, a guest who gives an email address in the native RSVP gets a confirmation listing everyone's answers. It is recorded in message history (category "RSVP confirmation"). A failed confirmation never fails the RSVP.
- **Audit**: preparing, sending, retrying, replying, reading replies and opt-outs are all audited.
- **Privacy**: erasing a guest also deletes their text conversations and any stored webhook payloads that mention their email or number.

Guest and household mobile numbers are stored in E.164 (`+61412345678`), using one shared utility (`src/shared/portal/phone.ts`) for the guest and household forms, the APIs, CSV import, SMS recipients and the SMS provider:

- Australian mobiles can be entered as `0412 345 678`, `+61 412 345 678` or `61412345678`, with spaces, dots, dashes or brackets. Overseas numbers must start with `+` and their country code and are kept as entered (never given `+61`).
- Landlines, numbers with letters or extensions, several numbers in one cell and the wrong number of digits are refused with an explanation. CSV import leaves such a number out with a warning, still imports the guest, and never blanks a number a guest already has.
- Every SMS provider refuses anything that isn't already a valid E.164 mobile, so a malformed number can't reach ClickSend. A guest whose saved number can't be texted is skipped with "Mobile number isn't valid".
- CSV exports write Australian mobiles as `0412 345 678`, which re-imports to the same number.
- **Numbers saved before this** keep working (they're normalised when a message is prepared) and are left exactly as they are until someone reviews them: **Guests → Review mobiles** previews every saved number that isn't in E.164 yet. Clear-cut ones are ticked, ones read with an assumption (nine digits, probably a lost leading 0) need ticking, and ones that can't be read must be fixed by hand. Opening the review changes nothing; only ticked numbers change, only if they still hold the previewed value, and each change is audited on the record without storing the number. An untouched legacy value doesn't block saving other changes to a guest.

The composer shows SMS length and parts: curly quotes and emoji switch a message to Unicode, which shortens each part from 160 to 70 characters.

### Communications Studio, tests and attachments

How to prepare, check, test and send each guest communication is in [WEDDING_COMMUNICATIONS_GUIDE.md](WEDDING_COMMUNICATIONS_GUIDE.md). For provider set-up, three things matter:

- **Test recipients** (Communications → Email & SMS settings → Campaign test recipients, owners and admins): the only addresses and mobiles a campaign test can go to. A test needs a configured provider but not the delivery switch, because it can never reach a guest. Tests are stored in `message_tests`, not in delivery history.
- **Bulk sends need confirmation**: `POST /api/portal/wedding/messages/:id/send` and `/schedule` take `confirmCount`, the number of recipients shown in the send check (`GET …/preflight`); a mismatch is a 409. Scheduling needs the send permission.
- **PDF attachments** (formal invitations by email, optional): Fastmail uploads each household's PDF as a JMAP blob (`uploadUrl` from the session, then `attachments` on `Email/set`), authenticated SMTP sends `multipart/mixed`, and SMTP2Go sends `attachments`. Cloudflare Email Service is marked as unable to attach, so such a message is refused there rather than sent without its PDF. The Fastmail token needs Mail and Email Submission scopes; uploads use the same token.

---

## Email: Fastmail JMAP (preferred)

Fastmail is used through its official JMAP session and Email Submission APIs. The token must have
both Mail and Email Submission access, and `EMAIL_FROM` must match an identity returned by
`Identity/get`. The Worker validates the session, scopes and identity before submitting mail.

```bash
npx wrangler secret put FASTMAIL_API_TOKEN --env=""
```

```jsonc
"EMAIL_DELIVERY": "fastmail",
"EMAIL_FROM": "\"Amelia & Aidan\" <wedding@daly.id.au>",
"EMAIL_REPLY_TO": "wedding@daly.id.au"
```

Create and rotate the API token in Fastmail, then replace the Worker secret with the command above.
The token is never accepted by a browser endpoint or stored in D1. Use **Wedding Planner → Email &
SMS settings** to validate the session and send one controlled test to an address you own. Official
references: [Fastmail API tokens](https://www.fastmail.com/dev/#authentication) and
[JMAP Email Submission](https://www.fastmail.com/dev/email-submission.html).

## Email: generic authenticated SMTP

Set `EMAIL_DELIVERY = "smtp"`, then provision `SMTP_USERNAME` and `SMTP_PASSWORD` as Worker
secrets. `SMTP_HOST`, `SMTP_PORT` and `SMTP_SECURITY` are configuration values. Only implicit TLS on
465 and STARTTLS on 587 are accepted; port 25 and unauthenticated/plaintext configurations are
rejected. Connection validation remains incomplete until a controlled test succeeds.

## Email: SMTP2Go

What you need to do (needs your approval and access):

1. **Create an SMTP2Go account** and choose a plan. The free tier is enough for a wedding guest list.
2. **Verify the sender domain** `daly.id.au` (Sending → Verified senders → Sender domains). SMTP2Go gives you CNAME records for DKIM, return-path and tracking. **Adding them is a DNS change, so it's yours to approve**; it doesn't affect the website or existing mail. Check your DMARC policy still passes afterwards.
3. **Sender**: `"Amelia & Aidan" <wedding@daly.id.au>`. Decide where replies go. Either make `wedding@daly.id.au` a real mailbox or alias (for example in Fastmail), or set `EMAIL_REPLY_TO` to one of your own addresses.
4. **API key**: Settings → API Keys → Add. Give it **send email** permission only.
5. **Webhook**: Settings → Webhooks → Add, URL `https://daly.id.au/api/comms/webhooks/smtp2go?key=<COMMS_WEBHOOK_SECRET>`, events: delivered, bounce, spam, unsubscribe, reject. JSON payloads.
6. Set the Worker configuration:

```bash
openssl rand -hex 24                                    # a new webhook secret
npx wrangler secret put COMMS_WEBHOOK_SECRET --env=""
npx wrangler secret put SMTP2GO_API_KEY      --env=""
```

and in `wrangler.jsonc` → `vars`:

```jsonc
"EMAIL_DELIVERY": "smtp2go",
"EMAIL_FROM": "\"Amelia & Aidan\" <wedding@daly.id.au>",
// optional:
"EMAIL_REPLY_TO": "you@example.com",
"SMTP2GO_API_BASE": "https://au-api.smtp2go.com/v3"   // Australian region endpoint
```

7. `npm run check:config` checks the secret names (never values).
8. **Controlled test**: prepare a message to a test audience of your own two addresses, switch on _Email delivery_, send, and check the delivery report in the portal. Switch it off again until you're ready.

Cloudflare Email Service remains available (`EMAIL_DELIVERY = "cloudflare"` with an `EMAIL` binding) but is no longer the preferred provider.

---

## SMS: ClickSend

### Sender: use a dedicated number

Since **1 July 2026** Australian carriers check alphanumeric sender IDs against the ACMA **SMS Sender ID Register**. Unregistered IDs (such as `AmeliaAidan`) are replaced with the word **"Unverified"**. Registration is designed for organisations: applicants with an ABN go through identity verification, others through a certified provider. Generic names aren't accepted. A private couple may not be eligible for `AmeliaAidan`, and an alphanumeric sender **can't receive replies** anyway.

**Recommendation:** rent a **dedicated Australian virtual mobile number** from ClickSend. Numeric senders aren't affected by the register, guests can reply, and replies come back into the portal. Every message should identify you in the body, e.g. _"Amelia & Aidan here, …"_. The composer reminds you.

If you still want `AmeliaAidan`, ask ClickSend whether a private individual can register it and what it costs. It would be send-only.

### Before sending invitations by SMS

- **Links**: ask ClickSend to confirm that messages containing `https://wedding.daly.id.au/invitation?invite=…` (invitation texts) and `https://wedding.daly.id.au/save-the-date` links are allowed on your account. Some providers hold messages with unknown links, require URL allow-listing or force their own shortener. **This hasn't been confirmed yet.** Don't send SMS invitations until it is.
- **Payload check**: ClickSend's push formats for delivery receipts and inbound messages aren't fully documented publicly. The webhook parser accepts the common field names (`message_id`, `status_text`/`status_code`, `from`, `body`, `custom_string`) as JSON or form posts, and keeps every raw payload. Before relying on it, send yourself a test text, reply to it, and confirm both appear correctly under Text conversations.

### Setup

1. Create a ClickSend account, add credit and buy a dedicated number (Numbers → Buy a number → Australia, SMS-capable).
2. **Inbound rule** (Messaging → SMS → Inbound rules, or the dedicated number's settings): action "URL", `https://daly.id.au/api/comms/webhooks/clicksend-inbound?key=<COMMS_WEBHOOK_SECRET>`.
3. **Delivery reports** (Messaging → SMS → Delivery reports): action "URL", `https://daly.id.au/api/comms/webhooks/clicksend-receipt?key=<COMMS_WEBHOOK_SECRET>`.
4. Worker configuration:

```bash
npx wrangler secret put CLICKSEND_USERNAME --env=""   # API username (Developers → API credentials)
npx wrangler secret put CLICKSEND_API_KEY  --env=""
```

and in `wrangler.jsonc` → `vars`: `"SMS_DELIVERY": "clicksend"`, `"SMS_FROM": "+614XXXXXXXX"` (the dedicated number).

5. **Controlled test**: give yourselves a test guest record with your own mobile, prepare an SMS to that guest only, switch on _SMS delivery_, send, reply, and check the conversation and cost in the portal.

ClickSend reports a price per message, which the portal stores and totals per campaign. A message that needs several SMS parts costs several times as much.

---

## Webhook endpoints

| URL                                                       | Provider and events                          |
| --------------------------------------------------------- | -------------------------------------------- |
| `POST /api/comms/webhooks/smtp2go?key=<secret>`           | SMTP2Go delivered, bounce, spam, unsubscribe |
| `POST /api/comms/webhooks/clicksend-receipt?key=<secret>` | ClickSend delivery receipts                  |
| `POST /api/comms/webhooks/clicksend-inbound?key=<secret>` | ClickSend inbound SMS (replies)              |

- Providers can't sign in through Cloudflare Access, so these are public URLs authenticated by the secret in the `key` query parameter, compared in constant time. It's a query parameter because Cloudflare's request logs and traces drop query strings (`observability.redact_query_string`) but keep paths. The older form with the secret as the last path segment still works so existing provider settings don't break, but it ends up in Cloudflare's request logs: move providers to `?key=` and then rotate the secret. Without `COMMS_WEBHOOK_SECRET` every request is a 404, and a wrong secret looks identical. Rotate the secret by setting a new value and updating both providers.
- Each event is stored once in `comm_webhook_events` (unique dedupe key), so provider retries are harmless.
- Authenticated requests always get 200, even for events that aren't applied, so providers don't retry forever.

---

## Activation checklist (needs your approval)

1. Chosen email provider: Fastmail token and sender identity, authenticated SMTP credentials, or SMTP2Go account/domain/API key/webhook; then `EMAIL_DELIVERY`.
2. ClickSend: account, dedicated number, link approval, inbound and receipt URLs, secrets, `SMS_DELIVERY`, `SMS_FROM`.
3. `COMMS_WEBHOOK_SECRET`.
4. Deploy only after review and explicit approval; migration `0008_invitation_studio.sql` is additive and creates generation/check ledgers.
5. Controlled tests to your own addresses and numbers only, then switch each channel off again.
6. Turn on _Email delivery_ / _SMS delivery_ when you're ready to contact guests. Optionally turn on RSVP confirmations.

Nothing in this list has been done.
