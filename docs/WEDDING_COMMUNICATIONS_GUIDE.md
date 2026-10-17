# Wedding communications guide

How to send every guest communication from Wedding Planner: what each one is for, how to choose who gets it, how to check it and how to send it safely. Provider set-up (Fastmail, ClickSend, secrets) is in [COMMUNICATIONS.md](COMMUNICATIONS.md).

**Nothing is sent until you choose Send on a checked draft**, and only when that channel's switch is on (Wedding settings → Features) and its provider is configured on the Worker. Generating invitations, preparing drafts, previewing, printing and exporting never send anything.

---

## The guest journey

Communications → **Communications Studio** has a card for each step. Every one goes to **one person per household by default**, addressed to the whole household exactly as the printed invitation is ("Fred & Ann Daly"), in the wedding stationery design.

| Step | What it's for                                                                                                   | Default recipients         | Sent once per household?   | Printable?                  |
| ---- | --------------------------------------------------------------------------------------------------------------- | -------------------------- | -------------------------- | --------------------------- |
| 1    | **Save the date**: the date and place, "Formal invitation to follow". Never invites anyone or changes any RSVP. | Whoever you choose         | Yes                        | Yes (A5 card)               |
| 2    | **Formal invitation**: the invitation itself, with each household's own RSVP link. By text, a link to it.       | Whoever you choose         | Yes                        | Yes, from Invitation Studio |
| 3    | **RSVP reminder**: to households with no reply yet, partly answered, or needing travel follow-up.               | Whoever you choose         | No (but never twice a day) | No                          |
| 4    | **Final information**: times, venue, courtesy bus and accommodation, for households who are coming.             | Whoever you choose         | Yes                        | No                          |
| 5    | **Thank you**: a card per household, with an optional photo, personal note and gallery link.                    | Whoever you choose         | Yes                        | Yes (A5 card)               |
| —    | **RSVP confirmation**: sent on its own after each online RSVP (RSVPs → Settings). Not a campaign.               | The household that replied | —                          | —                           |

"Sent once per household" means a household that already has one prepared or sent is held back from a new one, unless you switch on **Send again to households that already have one** for that message.

---

## Choosing recipients

The composer has three modes:

- **Specific people** (the default). Pick households and/or guests from searchable lists. Exactly those are used: no filter can add anyone, and choosing nobody is refused rather than meaning "everyone". Choosing one household reaches that household alone. Choosing one guest sends their household's message to them, addressed to the whole household (or just to them with **Send to each guest individually**).
- **Filtered group**. RSVP status, event, side, group, tag, age group, contact preference, and for reminders the targets (No reply yet, Partly answered, Needs follow-up), with the reason each household is included.
- **All eligible**. Every guest on the list.

Below the choice you always see three separate numbers: **households selected**, **guests in them**, and the **emails or texts that would actually be sent**, with each recipient's name and the exact address or number. Anyone held back is listed with the reason.

---

## From draft to sent

1. **Create** from a Studio card (or prepare drafts from Invitation Studio, below). Choose email or SMS, recipients, and customise the wording. Merge fields such as `{{greeting_names}}` are filled in for each household.
2. **Preview**. The email exactly as it will arrive, at desktop and phone widths, or the text as a phone shows it. Pick any household, or the fictional sample (Alex Example). Missing details are flagged.
3. **Prepare draft**. This freezes the recipient list. Nothing is sent.
4. On the draft's page:
    - **Send a test**: only to the approved test addresses or mobiles (Communications → Email & SMS settings, owners and admins), using the fictional sample or any household's details. Tests are marked `[TEST]`, never count as contacting anyone, never change an RSVP and don't appear in delivery history.
    - **Send check**: households and messages that would go now, the full list of delivery addresses, everyone held back and why (no address, invalid mobile, opted out, already sent, replied since, revoked link, not coming…), warnings (website not published, native RSVP off, times to be confirmed, PDF attachments) and the SMS parts and estimated cost.
    - **Schedule** or **Send**. For more than one recipient you confirm the exact count from the send check and tick "I've previewed it, sent a test and checked who it goes to". If anything changed since the check, the send is refused and you're asked to check again.
5. **Delivery**: each recipient's status (sent, failed, delivered, bounced) appears on the message and in each household's **Communications history** (Households → open a household). **Retry** tries only failed recipients, up to three times each.

Everything is re-checked for every recipient at the moment it's sent, including scheduled sends days later: an opt-out, a reply that completes the household (for reminders), a revoked link, or the same campaign sent by another message all hold that household back.

---

## Formal invitations: Invitation Studio to the guest's inbox

### One-household test (do this first)

1. **Invitation Studio**: tick one household (for example a family member's), tick **Email**, choose **Preview every version**, then **Email** to see the exact email that will be sent.
2. Leave **Also prepare email drafts in Communications** on. Optionally tick **Attach each household's printable invitation**.
3. **Generate (do not send)**. The household now shows "Email draft", and **Review and send** opens the draft.
4. On the draft: **Send check** lists one address (theirs). Open **PDF** next to it to see the attachment. **Send a test** to your own approved address with that household's details.
5. When delivery is approved and switched on: **Send to 1 household**.
6. In the guest's inbox: the botanical invitation, an **RSVP** button, the link written out in full and, if chosen, the PDF with its QR code. The link opens that household's RSVP, listing each invited guest; replies appear under RSVPs and on the household.

### What the guest receives

- Your greeting and introduction from the Studio template, then **the invitation itself**: the native botanical artwork, "Invitation for" and the household's name exactly as printed, the date, venue and events, "Kindly reply by…", an **RSVP** button that goes straight to the household's RSVP form, and the same link written out for email clients that block buttons. Every word is real text, so it reads properly with images blocked.
- A plain-text version for text-only email apps.
- Optionally, **the household's printable invitation as a PDF**: the same file as Studio → Download printable PDF, with its own QR code.
- Each household's email carries only its own signed link and QR code.
- When the ceremony and reception share a venue, it's named once ("Ceremony and reception at Rhino Lodge") with each event's own time beneath. Dates and the RSVP deadline always come from settings.

### By text: the household's invitation page

A text can't show the invitation, and a PDF or MMS isn't reliable on every phone, so the invitation text links to **the household's own invitation page** (`{{invitation_link}}`):

> Dear Fred & Ann, it's Aidan & Amelia! We'd love you to join us on Saturday 23 October 2027. Your personal invitation and RSVP: https://wedding.daly.id.au/invitation?invite=… Please reply by Saturday 25 September 2027.

- The page shows the household's invitation, built by the same Studio code as the email and the printed card, then a prominent **RSVP** button (the existing RSVP form, same answers) and **Download invitation (PDF)**.
- It uses the household's existing signed link: no login or code. A revoked, replaced, expired or mistyped link gets a friendly "isn't working" page that names nobody. It follows the RSVP page's switch (Public wedding website), is never cached or indexed, sends no referrer and never names the household in its title or link preview.
- The email's RSVP button still goes straight to the RSVP form.

The Studio template (wording, accent, artwork) is captured when the draft is prepared, so editing the template afterwards doesn't change a draft you've already checked. Prepare it again (Replace) to use the new template.

### Avoiding duplicates

- Preparing again for households that already have an unsent Studio draft is refused, and the Studio links to it. **Replace with new drafts** deletes and recreates it, and only works for an unsent draft that covers no other households.
- A household that has been sent an invitation is held back from any new invitation draft unless **Send again** is on. Sent messages are never deleted or changed; they stay as history.

### PDF attachments

Fastmail (JMAP blob upload) and authenticated SMTP, and SMTP2Go, attach each household's PDF. Cloudflare Email Service can't attach, so a message that promises a PDF is refused on it rather than sent without one. If a PDF can't be built or uploaded for a household, that household is marked failed with the reason and can be retried; it's never sent without its attachment. Each PDF is about 0.6 MB and is generated while sending, so very large sends are best split into batches of 100–200 households.

---

## Save the date

The default Save the Date email is the designed announcement (`{{save_the_date_card}}`): **SAVE THE DATE**, the couple, "Are getting married!", the date, the venue and "Formal invitation to follow.", then **Add to calendar** (Apple Calendar, Google Calendar, Outlook, Microsoft 365 and a universal `.ics` file for anything else) and **View the Save the Date**. It's addressed to the household ("Dear Fred & Ann") and never includes an RSVP link, code or deadline (they're refused), never marks anyone as invited and never changes an RSVP.

The text (`{{save_the_date_link}}`):

> Hi Fred & Ann! Save the date: Aidan & Amelia are getting married on Saturday 23 October 2027 at Rhino Lodge, Dubbo NSW. Add it to your calendar and see the details: https://wedding.daly.id.au/save-the-date Formal invitation to follow.

That's two SMS parts; the send check shows the parts and estimated cost before anything is sent.

- **The page** (`/save-the-date`) is public and the same for everyone: no household names, codes or links. It's served once the website is published, or earlier with the **Public Save the Date page** switch. Until then the email leaves out the Apple Calendar, `.ics` and page links (Google, Outlook and Microsoft 365 still work), texts that link to the page are held back, and the send check says so.
- **The calendar event** comes from settings: "Aidan & Amelia's Wedding", the date and the venue. Without a confirmed start _and_ finish time it's an all-day event; with both, the times are Sydney time. It never carries a household's details, uses the same UID every time (so saving it again updates rather than duplicates it in calendars that honour that), and guests always choose to save it themselves: nothing is sent as a calendar invite. Changing the date later doesn't update calendars on its own.

## Final information and thank you

- **Wording & design** on each card sets the default wording (email and text), the accent colour and the stationery details: Save the Date headline, follow-up line and add-to-calendar link; final instructions and whether to include the website's courtesy bus and accommodation sections; the thank-you headline, message, wedding photograph and gallery link.
- **Final information never invents anything.** Times come from Events (an event with no time says "time to be confirmed"), the bus and accommodation from the _published_ website, and each household's own bus answer from their RSVP (capped at the guests now coming, with "The Dubbo RSL will confirm pick-up times closer to the day").
- **Thank you**: **Personal notes** adds a line for each household (`{{personal_note}}`). Lines whose optional field is empty, such as "Photos from the day:" without a gallery link, are left out automatically. Thank-yous are never sent automatically.
- **Printable cards**: on a Save the Date or Thank You draft, **Printable cards** makes one A5 page per household, with nothing within 28 pt of the edge.

---

## Text messages

Keep texts short and link to the website or the guest's own page; the composer shows the length and SMS parts (curly quotes and emoji shorten each part). Every number is checked as a valid mobile in E.164 before anything reaches ClickSend. Guests who reply STOP are opted out automatically. Replies appear under Communications → Text conversations and in the household's history. See COMMUNICATIONS.md before sending SMS invitations (link approval with ClickSend).

---

## Who can do what

| Action                                                   | Owner | Admin | Editor | Viewer |
| -------------------------------------------------------- | ----- | ----- | ------ | ------ |
| Preview, see drafts, the send check and history          | ✓     | ✓     | ✓      | ✓      |
| Create and prepare drafts, Studio drafts, notes, wording | ✓     | ✓     | ✓      |        |
| Send, schedule, retry, send tests                        | ✓     | ✓     |        |        |
| Choose the approved test recipients                      | ✓     | ✓     |        |        |
| Download printable cards, PDFs and mail-merge CSVs       | ✓     | ✓     |        |        |

Viewers see that a text reply arrived in a household's history, not what it says.
