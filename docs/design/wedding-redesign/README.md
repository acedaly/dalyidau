# Wedding digital invitation redesign

This visual review captures the local wedding defaults at 1440 × 1000 and 390 × 844. The live public feature flag and native RSVP remain unchanged; both were enabled only in the local database for these captures.

## Direction

- Warm ivory paper, chocolate and espresso ink, camel, waratah burgundy, banksia orange, wattle, eucalyptus and deep olive, drawn from the supplied invitation and wedding-party references.
- Alex Brush is reserved for the couple's names, Cormorant Garamond provides the editorial serif voice, and Jost handles practical copy and tracked labels.
- A bespoke painted Australian-native invitation frame anchors the hero. Portal-uploaded hero, venue, accommodation and gallery photography remains supported without overwhelming the invitation.
- Compositions vary by purpose: an invitation hero with our note and the key facts, "The day" (schedule beside the venue), "Stay & travel" cards, an open FAQ and a paper RSVP finale.
- Native RSVP uses the same paper, typography, border and colour language as the public site.

## Layout refresh (November 2026)

Layout only: palette, fonts, the painted invitation frame, copy and Untitled UI components are unchanged, and everything still comes from the portal.

- **Hero**: two columns on desktop (5fr / 6fr, 72px gap, vertically centred). The invitation card sits on the left without the empty field around it. On the right are the date and venue eyebrow, the note from us (formerly its own section) signed in burgundy italic, a 2×2 grid of facts (When, Where, Dress, Reply by), the existing live countdown as a compact row, and "RSVP now" and "The day". Below 900px it stacks: the card, then the text. The separate countdown strip and note section are gone.
- **The day**: Schedule and Venue merged. A heading row (eyebrow and serif heading, introduction on the right), then a timeline of the wedding events (7fr) beside a venue card with Directions and Website (5fr). The landscape illustration behind the venue is gone; an uploaded venue photo shows at the top of the card.
- **Stay & travel**: Accommodation and "Getting home safely" merged on the eucalypt band. There is a card per place to stay, then the courtesy bus in an espresso card.
- **FAQ**: every answer shown, in two columns with hairline dividers; the contact link is in the heading row.
- **Spacing**: sections, the RSVP finale and the footer use 112px on desktop and 72px on phones.
- **Navigation**: The day, Stay & travel, FAQ and RSVP. Old addresses (#schedule, #venue, #stay, #transport, #welcome and each section's own id, such as #details or #bus) still land on the merged sections, because sent invitations and emails may use them (`src/wedding/home-sections.ts`).

Earlier captures of the hero and full homepage are in [before-layout-refresh](before-layout-refresh/). Retake the captures with `node scripts/wedding-captures.mjs <dir>` against a local Worker with the wedding site switched on in the local database.

## Review captures

| Experience    | Desktop                                            | Mobile                                           |
| ------------- | -------------------------------------------------- | ------------------------------------------------ |
| Full homepage | [Desktop homepage](homepage-desktop.jpg)           | [Mobile homepage](homepage-mobile.jpg)           |
| Hero          | [Desktop hero](hero-desktop.jpg)                   | [Mobile hero](hero-mobile.jpg)                   |
| Venue         | [Desktop venue](venue-desktop.jpg)                 | [Mobile venue](venue-mobile.jpg)                 |
| Accommodation | [Desktop accommodation](accommodation-desktop.jpg) | [Mobile accommodation](accommodation-mobile.jpg) |
| FAQ           | [Desktop FAQ](faq-desktop.jpg)                     | [Mobile FAQ](faq-mobile.jpg)                     |
| RSVP finale   | [Desktop RSVP](rsvp-desktop.jpg)                   | [Mobile RSVP](rsvp-mobile.jpg)                   |
| Native RSVP   | [Desktop native RSVP](native-rsvp-desktop.jpg)     | [Mobile native RSVP](native-rsvp-mobile.jpg)     |
| Footer        | [Desktop footer](footer-desktop.jpg)               | [Mobile footer](footer-mobile.jpg)               |

## Verification

- Production build and Cloudflare dry run.
- 490 unit/integration tests.
- End-to-end: 24 public-site tests (4 intentional project skips) and 40 admin and wedding tests, across desktop and mobile.
- Axe accessibility scan, horizontal overflow check and console error check on the public wedding homepage at 1440 × 1000 and 390 × 844, and on the native RSVP. The countdown ticks; on the day it counts down the remaining hours, and it disappears after the ceremony.
- Portal editing, publishing, guest management and the complete native RSVP journey.
