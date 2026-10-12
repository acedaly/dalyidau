# Wedding digital invitation redesign

This visual review captures the local wedding defaults at 1440 × 1000 and 390 × 844. The live public feature flag and native RSVP remain unchanged; both were enabled only in the local database for these captures.

## Direction

- Warm ivory paper, chocolate and espresso ink, camel, waratah burgundy, banksia orange, wattle, eucalyptus and deep olive, drawn from the supplied invitation and wedding-party references.
- Alex Brush is reserved for the couple's names, Cormorant Garamond provides the editorial serif voice, and Jost handles practical copy and tracked labels.
- A bespoke painted Australian-native invitation frame anchors the hero. Portal-uploaded hero, venue, accommodation and gallery photography remains supported without overwhelming the invitation.
- Compositions vary by purpose: portrait invitation hero, light countdown strip, oversized welcome typography, editorial event schedule, full-width venue, directory-style accommodation, quiet transport and FAQ sections, and a paper RSVP finale.
- Native RSVP uses the same paper, typography, border and colour language as the public site.

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
- 195 unit/integration tests.
- 47 end-to-end tests across desktop and mobile, with 5 intentional project skips.
- Axe accessibility scan, horizontal overflow check and console error check on the public wedding homepage and native RSVP.
- Portal editing, publishing, guest management and the complete native RSVP journey.
