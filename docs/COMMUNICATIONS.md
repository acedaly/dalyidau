# Communications: email (SMTP2Go) and SMS (ClickSend)

Wedding Planner prepares, sends and tracks guest email and text messages from one place
(**Wedding Planner → Communications**). Providers sit behind a small interface (`worker/comms/providers.ts`),
so the portal never depends on a particular service.

**Nothing is sent today.** Sending needs, per channel, all of:

| Channel | Worker setting                                | Secrets                                   | Switch (Wedding settings → Features) |
| ------- | --------------------------------------------- | ----------------------------------------- | ------------------------------------ |
| Email   | `EMAIL_DELIVERY = "smtp2go"` and `EMAIL_FROM` | `SMTP2GO_API_KEY`                         | Email delivery                       |
| SMS     | `SMS_DELIVERY = "clicksend"` and `SMS_FROM`   | `CLICKSEND_USERNAME`, `CLICKSEND_API_KEY` | SMS delivery                         |

Both start `off` in `wrangler.jsonc`, and both switches default off. `log` modes exist for tests and local development and are ignored in production.

---

## How it works

- **Prepare** a message (choose Email or Text message, a category, an audience, a schedule). The recipient list is frozen with each guest's email or mobile number. Guests without one, or who have opted out, are recorded as _skipped_ with the reason.
- **Send** (admins and owners). The message is claimed atomically so a double click can't send twice. Each recipient's provider id, attempt count and (for SMS) cost are stored.
- **Retry** failed recipients from the message page. Only failures are retried, up to three attempts each.
- **Schedule**: the existing 15-minute cron sends due messages, only on channels whose safeguards are on.
- **Delivery reports** arrive by webhook and update each recipient: _delivered_, _bounced_, _complained_, _undelivered_.
- **Text conversations** (Communications → Text conversations): every outbound and inbound SMS by mobile number, matched to guests, with manual replies. Reading conversations needs the communications permission (editors and up). Replying needs the send permission (admins and owners).
- **Consent**: a reply of `STOP` (or `UNSUBSCRIBE`, `OPT OUT`…) marks the guest as opted out of texts; an SMTP2Go spam complaint or unsubscribe marks them opted out of email. Opted-out guests are skipped at prepare time _and_ re-checked at send time.
- **RSVP confirmations**: with RSVPs → Settings → "Email a confirmation…" on, a guest who gives an email address in the native RSVP gets a confirmation listing everyone's answers. It is recorded in message history (category "RSVP confirmation"). A failed confirmation never fails the RSVP.
- **Audit**: preparing, sending, retrying, replying, reading replies and opt-outs are all audited.
- **Privacy**: erasing a guest also deletes their text conversations and any stored webhook payloads that mention their email or number.

Phone numbers are normalised to E.164. Australian mobiles can be entered locally (`0412 345 678`); landlines are never texted. The composer shows SMS length and parts: curly quotes and emoji switch a message to Unicode, which shortens each part from 160 to 70 characters.

---

## Email: SMTP2Go

What you need to do (needs your approval and access):

1. **Create an SMTP2Go account** and choose a plan. The free tier is enough for a wedding guest list.
2. **Verify the sender domain** `daly.id.au` (Sending → Verified senders → Sender domains). SMTP2Go gives you CNAME records for DKIM, return-path and tracking. **Adding them is a DNS change, so it's yours to approve**; it doesn't affect the website or existing mail. Check your DMARC policy still passes afterwards.
3. **Sender**: `"Aidan & Amelia" <wedding@daly.id.au>`. Decide where replies go. Either make `wedding@daly.id.au` a real mailbox or alias (for example in Fastmail), or set `EMAIL_REPLY_TO` to one of your own addresses.
4. **API key**: Settings → API Keys → Add. Give it **send email** permission only.
5. **Webhook**: Settings → Webhooks → Add, URL `https://daly.id.au/api/comms/webhooks/smtp2go/<COMMS_WEBHOOK_SECRET>`, events: delivered, bounce, spam, unsubscribe, reject. JSON payloads.
6. Set the Worker configuration:

```bash
openssl rand -hex 24                                    # a new webhook secret
npx wrangler secret put COMMS_WEBHOOK_SECRET --env=""
npx wrangler secret put SMTP2GO_API_KEY      --env=""
```

and in `wrangler.jsonc` → `vars`:

```jsonc
"EMAIL_DELIVERY": "smtp2go",
"EMAIL_FROM": "\"Aidan & Amelia\" <wedding@daly.id.au>",
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

Since **1 July 2026** Australian carriers check alphanumeric sender IDs against the ACMA **SMS Sender ID Register**. Unregistered IDs (such as `AidanAmelia`) are replaced with the word **"Unverified"**. Registration is designed for organisations: applicants with an ABN go through identity verification, others through a certified provider. Generic names aren't accepted. A private couple may not be eligible for `AidanAmelia`, and an alphanumeric sender **can't receive replies** anyway.

**Recommendation:** rent a **dedicated Australian virtual mobile number** from ClickSend. Numeric senders aren't affected by the register, guests can reply, and replies come back into the portal. Every message should identify you in the body, e.g. _"Aidan & Amelia here, …"_. The composer reminds you.

If you still want `AidanAmelia`, ask ClickSend whether a private individual can register it and what it costs. It would be send-only.

### Before sending invitations by SMS

- **Links**: ask ClickSend to confirm that messages containing `https://daly.id.au/wedding/rsvp?invite=…` links are allowed on your account. Some providers hold messages with unknown links, require URL allow-listing or force their own shortener. **This hasn't been confirmed yet.** Don't send SMS invitations until it is.
- **Payload check**: ClickSend's push formats for delivery receipts and inbound messages aren't fully documented publicly. The webhook parser accepts the common field names (`message_id`, `status_text`/`status_code`, `from`, `body`, `custom_string`) as JSON or form posts, and keeps every raw payload. Before relying on it, send yourself a test text, reply to it, and confirm both appear correctly under Text conversations.

### Setup

1. Create a ClickSend account, add credit and buy a dedicated number (Numbers → Buy a number → Australia, SMS-capable).
2. **Inbound rule** (Messaging → SMS → Inbound rules, or the dedicated number's settings): action "URL", `https://daly.id.au/api/comms/webhooks/clicksend-inbound/<COMMS_WEBHOOK_SECRET>`.
3. **Delivery reports** (Messaging → SMS → Delivery reports): action "URL", `https://daly.id.au/api/comms/webhooks/clicksend-receipt/<COMMS_WEBHOOK_SECRET>`.
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

| URL                                                   | Provider and events                          |
| ----------------------------------------------------- | -------------------------------------------- |
| `POST /api/comms/webhooks/smtp2go/<secret>`           | SMTP2Go delivered, bounce, spam, unsubscribe |
| `POST /api/comms/webhooks/clicksend-receipt/<secret>` | ClickSend delivery receipts                  |
| `POST /api/comms/webhooks/clicksend-inbound/<secret>` | ClickSend inbound SMS (replies)              |

- Providers can't sign in through Cloudflare Access, so these are public URLs authenticated by the secret path segment, compared in constant time. Without `COMMS_WEBHOOK_SECRET` every request is a 404, and a wrong secret looks identical. Rotate the secret by setting a new value and updating both providers.
- Each event is stored once in `comm_webhook_events` (unique dedupe key), so provider retries are harmless.
- Authenticated requests always get 200, even for events that aren't applied, so providers don't retry forever.

---

## Activation checklist (needs your approval)

1. SMTP2Go: account, domain DNS records, sender, API key, webhook, secrets, `EMAIL_DELIVERY`.
2. ClickSend: account, dedicated number, link approval, inbound and receipt URLs, secrets, `SMS_DELIVERY`, `SMS_FROM`.
3. `COMMS_WEBHOOK_SECRET`.
4. Deploy (merging deploys production and applies migration `0005_comms_channels.sql`).
5. Controlled tests to your own addresses and numbers only, then switch each channel off again.
6. Turn on _Email delivery_ / _SMS delivery_ when you're ready to contact guests. Optionally turn on RSVP confirmations.

Nothing in this list has been done.
