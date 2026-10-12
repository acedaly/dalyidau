# Wedding portal production launch checklist

Status on 12 October 2026: **code-complete, not approved for production launch**. Merging this branch would run the production deploy workflow, so do not merge until the owners have completed this checklist. No deployment, DNS change, Access-policy change, website publish or email send was performed during development.

## Release gates

- [ ] PR CI is green at the exact commit being approved.
- [ ] Review the portal on an isolated staging deployment with fictional data. Staging has not yet been deployed and its `SITE_URL` is still a placeholder.
- [ ] Take a verified production backup: `npm run db:backup -- --env production`.
- [ ] Record current D1 row counts and confirm `npm run db:verify` passes.
- [ ] Confirm Cloudflare Access covers `/portal*` and `/api/portal*`, permits only intended people, and has a separate role row for every non-owner.
- [ ] Set the required production secrets without putting values in source control:

    ```bash
    npx wrangler secret put ACCESS_TEAM_DOMAIN --env=""
    npx wrangler secret put ACCESS_AUD --env=""
    npx wrangler secret put PORTAL_OWNER_EMAILS --env=""
    npx wrangler secret put RSVP_LINK_SECRET --env=""
    npx wrangler secret put ADMIN_TOKEN --env=""
    ```

    Generate a new high-entropy RSVP value (at least 32 random bytes), store it in the secret manager, and retain a recoverable copy. Changing it invalidates every previously issued signed invitation link.

- [ ] Run `npm run check:config -- --url https://daly.id.au --team <team>.cloudflareaccess.com` after setting secrets.
- [ ] Confirm the configured external RSVP destination is still <https://sayi.do/aidanandamelia2258/>.
- [ ] Confirm **Native RSVP**, **Public wedding website**, and **Email delivery** feature switches are off.
- [ ] Confirm `EMAIL_DELIVERY` remains `off` in production.
- [ ] Review wedding details, events, guest invitations, accommodation wording, courtesy-bus wording, gallery permissions and accessibility/dietary records.
- [ ] Review full JSON and CSV exports on a private device, then securely delete test exports.

## Native RSVP approval (later, separate decision)

- [ ] Test a signed invitation end to end in staging: open, answer conditional questions, submit, retry the same submission, edit the answer, rotate, and revoke.
- [ ] Verify event attendance appears in RSVP reports, seating and catering.
- [ ] Review every published question and its scope, required state, conditions and answer report. Confirm the courtesy-bus question is informational only.
- [ ] Distribute only the current signed household links. Rotate any link disclosed to the wrong person.
- [ ] Decide whether to disable legacy short codes. Signed links are the preferred credential.
- [ ] Set the RSVP deadline/link-expiry policy and a contact route for changes after closing.
- [ ] Only then enable **Native RSVP**. Until that approval, Say I Do remains the live destination.

## Public website approval (later, separate decision)

- [ ] Preview desktop and mobile pages, images, alt text, venue/accommodation links and all visible sections.
- [ ] Confirm accommodation remains information-only and courtesy transport remains a simple information/interest workflow.
- [ ] Confirm the correct RSVP mode and deadline are shown.
- [ ] Decide whether `noindex` should remain on.
- [ ] Only then use Website → Publish. Publishing was not performed by this change.

## Cloudflare Email Service (optional, manual approval required)

The application supports Cloudflare Email Service directly. No Resend fallback is currently justified: adding another processor and secret would increase operational and privacy surface without solving a demonstrated gap.

1. Obtain approval to onboard the sending domain. In Cloudflare, open **Compute → Email Service → Email Sending**, add the domain, and review the DNS records Cloudflare proposes. Do not create or change DNS without owner approval.
2. Verify the sending identity and choose a monitored `EMAIL_FROM` address.
3. Add the binding to both environments that should be allowed to send:

    ```jsonc
    "send_email": [{ "name": "EMAIL" }]
    ```

4. Add `EMAIL_FROM` as a non-secret environment variable and change `EMAIL_DELIVERY` from `off` to `cloudflare` only in the approved environment.
5. Deploy to staging first. Enable **Email delivery** in staging, send only to controlled test addresses, and verify provider ids, failure handling, invitation deduplication and the scheduled queue.
6. Return staging and production to `EMAIL_DELIVERY: "off"` until a separate production-send approval. Production delivery requires both the Worker configuration and the database feature switch, so either one being off prevents sends.

## After an approved merge

- [ ] Watch the deploy job record the D1 Time Travel bookmark, apply migrations, verify the database and deploy the Worker.
- [ ] Sign in through Access and smoke-test `/portal`, Guests, Households, RSVPs, Seating, Catering, Communications, Website and the full JSON export.
- [ ] Verify the public wedding site and native RSVP API still return 404 while their switches are off.
- [ ] Verify Say I Do is still the public RSVP target.
- [ ] Review Worker errors, traces and scheduled-trigger logs without logging guest content.
- [ ] Keep the pre-deploy bookmark and backup reference with the release record; follow [DATABASE.md](DATABASE.md) if rollback is required.

## Current known blockers

- Production `RSVP_LINK_SECRET` has not been confirmed.
- The existing configuration audit previously reported `ADMIN_TOKEN` missing.
- Staging has not been deployed, and its final workers.dev URL/Access application are not configured.
- Cloudflare Email Service domain onboarding, DNS, sender identity and binding are deliberately not configured.
- Native RSVP, website publishing and email delivery require owner acceptance testing and explicit approval.
