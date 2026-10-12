# Wedding design and communications direction

This is an initial Rhino Lodge bush-country refresh, not a complete Say I Do replacement or production rollout.

## Design
- Warm paper and sandy earth, eucalyptus and olive, restrained timber warmth.
- Large serif invitation typography; genuine photos from existing R2 media.
- Preserve Untitled UI accessibility and the current editable wedding sections.
- No third-party hotlinked photos or invented event information.

## Email
- SMTP2GO transactional email is integrated behind both gates: EMAIL_DELIVERY=smtp2go and communications.delivery enabled.
- Set SMTP2GO_API_KEY as a Worker secret. Set EMAIL_FROM=wedding@daly.id.au after verifying the domain in SMTP2GO.
- Display sender name is Aidan & Amelia; uses the AU SMTP2GO API.
- Do not activate sending without controlled test email and explicit approval. Provider delivery webhooks are not yet integrated.

## SMS
- No SMS provider or live sending is integrated in this branch.
- SMTP2GO has an SMS API for paid accounts, but its API sender field documents an E.164 number. Verify Australian support and two-way replies before choosing it.
- Branded Australian SMS sender IDs require registration since 1 July 2026. Do not promise messages will appear from Aidan & Amelia without registration.
- Consider ClickSend or SMSGlobal if SMTP2GO SMS isn't suitable. Prioritise two-way Australian number, REST API, webhooks and per-message charging.
- Segmented recipients, channel opt-outs, costs, delivery tracking, retries and explicit send confirmation are required before live SMS.

## Replacing Say I Do
1. Import and reconcile existing guest responses and households.
2. Test native signed invitation links, expiry, rotation, household separation and conditional RSVP questions.
3. Confirm seating and catering updates from native responses.
4. Test email and SMS only with controlled recipients.
5. Communicate the change to guests carefully, freeze Say I Do entries, reconcile outstanding responses and only then switch native RSVP on.
6. Keep public publishing and bulk communications off until separately approved.

Official references:
- https://developers.smtp2go.com/reference/send-standard-email
- https://developers.smtp2go.com/reference/send-sms
- https://developers.smtp2go.com/docs/webhooks-overview
- https://www.acma.gov.au/sms-sender-id-register
