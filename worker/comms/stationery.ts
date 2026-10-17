// Guest email in the wedding's stationery style: warm ivory paper, espresso type, one restrained
// accent and the fine-art native botanicals from the printed invitation, cropped into an asymmetric
// header (banksia and wattle) and footer (waratah and gum nuts).
//
// Built for email clients rather than browsers: one 600px table, inline styles only, no web fonts
// it depends on (Georgia stands in for the display serif), no background images. Every word is live
// text, so it reads the same with images blocked; the artwork is decorative (empty alt) and the
// paper colour carries the look on its own. Every string is escaped; links are only ever the URLs
// the portal produced, shown with readable text.
import type { CalendarLinks } from "../../src/shared/portal/calendar";
import type { CampaignKind } from "../../src/shared/portal/campaigns";

export const PALETTE = {
    ivory: "#F5F0E7",
    // The artwork's own paper tone, so the botanical bands sit seamlessly on the page.
    paper: "#F6F0E5",
    // The surround: a deeper ivory, like a card on a linen table.
    table: "#EDE5D8",
    espresso: "#49342D",
    burgundy: "#783B4A",
    clay: "#9C765C",
    eucalyptus: "#798676",
    // Body copy on ivory; espresso at full strength is reserved for headings.
    ink: "#4F3D36",
    rule: "#E4DACB",
} as const;

export type StationeryAccent = "burgundy" | "clay" | "eucalyptus";

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const URL_PATTERN = /https:\/\/[^\s<>"')]+[^\s<>"').,;:!?]/g;

/** Escapes a paragraph and turns the https links in it into accessible links. */
const linkify = (text: string, accent: string) => {
    let html = "";
    let last = 0;
    for (const match of text.matchAll(URL_PATTERN)) {
        html += escapeHtml(text.slice(last, match.index)).replace(/\n/g, "<br>");
        const url = match[0];
        const label = url.replace(/^https:\/\//, "").replace(/\?.*$/, "");
        html += `<a href="${escapeHtml(url)}" style="color:${accent};text-decoration:underline;word-break:break-word">${escapeHtml(label)}</a>`;
        last = match.index + url.length;
    }
    return html + escapeHtml(text.slice(last)).replace(/\n/g, "<br>");
};

/** The printed invitation's content, for showing the invitation itself in the email. */
export interface InvitationCard {
    eyebrow: string;
    coupleNames: string;
    invitationLine: string;
    /** "Fred & Ann Daly", exactly as printed. */
    recipientLine: string;
    namesLine: string | null;
    weddingDate: string;
    location: string;
    eventLines: string[];
    deadline: string;
    /** The household's own signed RSVP link. */
    rsvpUrl: string;
    /** "wedding.daly.id.au/rsvp" and the household code, when short codes are accepted. */
    code: { address: string; code: string } | null;
}

/** Stands in for the card inside the text until the HTML is built. Can't occur in typed text. */
export const CARD_MARKER = "\u0000invitation-card\u0000";

/** The Save the Date announcement, for showing it in the email. Nothing in it is household-specific. */
export interface SaveTheDateCard {
    /** "Save the date". */
    headline: string;
    coupleNames: string;
    /** "Are getting married!" */
    tagline: string;
    /** "Saturday, 23 October 2027". */
    weddingDate: string;
    location: string;
    /** "Formal invitation to follow." Empty hides it. */
    followUp: string;
    /** Null when the couple has switched the calendar link off. */
    calendar: CalendarLinks | null;
    /** The public Save the Date page, or null while it isn't being served. */
    pageUrl: string | null;
}

/** Stands in for the Save the Date inside the text until the HTML is built. */
export const SAVE_THE_DATE_MARKER = "\u0000save-the-date\u0000";

/** Each way to save the date, in the order guests see them. The .ics file serves Apple Calendar and other apps. */
export const calendarChoices = (links: CalendarLinks) =>
    [
        links.ics ? { label: "Apple Calendar", url: links.ics } : null,
        { label: "Google Calendar", url: links.google },
        { label: "Outlook", url: links.outlook },
        { label: "Microsoft 365", url: links.office365 },
        links.ics ? { label: "Other calendars (.ics)", url: links.ics } : null,
    ].filter((choice): choice is { label: string; url: string } => !!choice);

/** The Save the Date as plain text, for the text part of the email and text-only clients. */
export function saveTheDateText(card: SaveTheDateCard) {
    return [
        card.headline.toUpperCase(),
        `${card.coupleNames}\n${card.tagline}`,
        [card.weddingDate, card.location].filter(Boolean).join("\n"),
        card.followUp,
        card.calendar ? ["Add it to your calendar:", ...calendarChoices(card.calendar).map((choice) => `${choice.label}: ${choice.url}`)].join("\n") : "",
        card.pageUrl ? `View the Save the Date: ${card.pageUrl}` : "",
    ]
        .filter(Boolean)
        .join("\n\n");
}

/**
 * The Save the Date in the email body, framed by the botanical artwork like the invitation. Every
 * word is live text and every calendar choice is a plain link, so it all works with images blocked.
 */
export function saveTheDateHtml(card: SaveTheDateCard, accent: string, assetOrigin: string) {
    const font = "Georgia,'Times New Roman',Times,serif";
    const sans = "'Helvetica Neue',Helvetica,Arial,sans-serif";
    const [one, two] = card.coupleNames.split(/\s+&\s+/, 2);
    const names = two
        ? `${escapeHtml(one)}<br><span style="font-style:italic;font-size:28px;color:${accent}">&amp;</span><br>${escapeHtml(two)}`
        : escapeHtml(card.coupleNames);
    const rule = `<tr><td style="padding:0 34px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-top:1px solid ${accent}33;font-size:0;line-height:0;height:1px">&nbsp;</td></tr></table></td></tr>`;
    const row = (html: string, style: string) => `<tr><td align="center" class="card-pad" style="${style}">${html}</td></tr>`;
    // Calendar choices as bordered text links, two to a row; they wrap naturally on phones.
    const choices = card.calendar ? calendarChoices(card.calendar) : [];
    const choiceCell = (choice: { label: string; url: string }) =>
        `<td align="center" valign="middle" width="50%" style="padding:4px"><a href="${escapeHtml(choice.url)}" style="display:block;padding:11px 8px;border:1px solid ${accent}66;border-radius:2px;font-family:${sans};font-size:13px;font-weight:bold;color:${accent};text-decoration:none">${escapeHtml(choice.label)}</a></td>`;
    const choiceRows: string[] = [];
    for (let index = 0; index < choices.length; index += 2) {
        const pair = choices.slice(index, index + 2);
        choiceRows.push(`<tr>${pair.map(choiceCell).join("")}${pair.length === 1 ? '<td width="50%" style="padding:4px">&nbsp;</td>' : ""}</tr>`);
    }
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${PALETTE.ivory}" style="background:${PALETTE.ivory};border:1px solid ${accent}33;margin:4px 0 22px">
<tr><td style="padding:0;line-height:0;font-size:0"><img src="${escapeHtml(assetOrigin)}/wedding/email/botanical-header.jpg" width="518" alt="" role="presentation" style="display:block;width:100%;height:auto;border:0"></td></tr>
${row(escapeHtml(card.headline.toUpperCase()), `padding:6px 34px 2px;font-family:${sans};font-size:12px;font-weight:bold;letter-spacing:0.28em;color:${accent}`)}
${row(names, `padding:14px 34px 4px;font-family:${font};font-size:44px;line-height:1.1;color:${PALETTE.espresso}`)}
${row(escapeHtml(card.tagline), `padding:8px 40px 20px;font-family:${font};font-size:19px;font-style:italic;line-height:1.45;color:${PALETTE.ink}`)}
${rule}
${row(escapeHtml(card.weddingDate.toUpperCase()), `padding:20px 34px 4px;font-family:${sans};font-size:14px;font-weight:bold;letter-spacing:0.14em;color:${accent}`)}
${row(escapeHtml(card.location), `padding:2px 34px 8px;font-family:${font};font-size:23px;font-weight:bold;color:${PALETTE.espresso}`)}
${card.followUp ? row(escapeHtml(card.followUp), `padding:6px 34px 18px;font-family:${font};font-size:16px;font-style:italic;color:${PALETTE.ink}`) : ""}
${
    choices.length
        ? `${rule}
${row("ADD TO CALENDAR", `padding:18px 34px 8px;font-family:${sans};font-size:10px;font-weight:bold;letter-spacing:0.24em;color:${PALETTE.espresso}`)}
<tr><td class="card-pad" style="padding:0 30px 12px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${choiceRows.join("")}</table></td></tr>`
        : ""
}
${card.pageUrl ? row(`<a href="${escapeHtml(card.pageUrl)}" style="color:${accent};text-decoration:underline;font-weight:bold">View the Save the Date</a>`, `padding:4px 34px 14px;font-family:${sans};font-size:13px;line-height:1.6;color:${PALETTE.ink}`) : ""}
<tr><td style="padding:0;line-height:0;font-size:0"><img src="${escapeHtml(assetOrigin)}/wedding/email/botanical-footer.jpg" width="518" alt="" role="presentation" style="display:block;width:100%;height:auto;border:0"></td></tr>
</table>`;
}

/** The invitation as plain text, for the text part of the email and text-only clients. */
export function invitationCardText(card: InvitationCard) {
    return [
        `${card.coupleNames}\n${card.invitationLine}`,
        `This invitation is for ${card.recipientLine}${card.namesLine ? ` (${card.namesLine})` : ""}.`,
        [card.weddingDate, card.location, ...card.eventLines].filter(Boolean).join("\n"),
        `${card.deadline ? `Please reply by ${card.deadline}: ` : "RSVP: "}${card.rsvpUrl}`,
        ...(card.code ? [`If the link doesn't open, visit ${card.code.address} and enter ${card.code.code}.`] : []),
    ].join("\n\n");
}

/**
 * The invitation card in the email body: the same content, order and hierarchy as the printed and
 * Studio-previewed invitation, framed by the botanical artwork, with the household's RSVP button and
 * its link written out in full for clients that block buttons or images.
 */
export function invitationCardHtml(card: InvitationCard, accent: string, assetOrigin: string) {
    const font = "Georgia,'Times New Roman',Times,serif";
    const sans = "'Helvetica Neue',Helvetica,Arial,sans-serif";
    const [one, two] = card.coupleNames.split(/\s+&\s+/, 2);
    const names = two
        ? `${escapeHtml(one)}<br><span style="font-style:italic;font-size:26px;color:${accent}">&amp;</span><br>${escapeHtml(two)}`
        : escapeHtml(card.coupleNames);
    const rule = `<tr><td style="padding:0 34px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-top:1px solid ${accent}33;font-size:0;line-height:0;height:1px">&nbsp;</td></tr></table></td></tr>`;
    const row = (html: string, style: string) => `<tr><td align="center" class="card-pad" style="${style}">${html}</td></tr>`;
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${PALETTE.ivory}" style="background:${PALETTE.ivory};border:1px solid ${accent}33;margin:4px 0 22px">
<tr><td style="padding:0;line-height:0;font-size:0"><img src="${escapeHtml(assetOrigin)}/wedding/email/botanical-header.jpg" width="518" alt="" role="presentation" style="display:block;width:100%;height:auto;border:0"></td></tr>
${row(escapeHtml(card.eyebrow.toUpperCase()), `padding:6px 34px 2px;font-family:${sans};font-size:11px;font-weight:bold;letter-spacing:0.24em;color:${PALETTE.espresso}`)}
${row(names, `padding:12px 34px 4px;font-family:${font};font-size:40px;line-height:1.12;color:${PALETTE.espresso}`)}
${row(escapeHtml(card.invitationLine), `padding:8px 40px 20px;font-family:${font};font-size:17px;font-style:italic;line-height:1.45;color:${PALETTE.ink}`)}
${rule}
${row("INVITATION FOR", `padding:16px 34px 4px;font-family:${sans};font-size:10px;font-weight:bold;letter-spacing:0.24em;color:${accent}`)}
${row(escapeHtml(card.recipientLine), `padding:2px 34px ${card.namesLine ? "4px" : "16px"};font-family:${font};font-size:24px;font-weight:bold;line-height:1.25;color:${PALETTE.espresso}`)}
${card.namesLine ? row(escapeHtml(card.namesLine), `padding:0 34px 16px;font-family:${sans};font-size:13px;line-height:1.5;color:#4F614D`) : ""}
${rule}
${row(escapeHtml(card.weddingDate.toUpperCase()), `padding:18px 34px 4px;font-family:${sans};font-size:13px;font-weight:bold;letter-spacing:0.14em;color:${accent}`)}
${row(escapeHtml(card.location), `padding:2px 34px 6px;font-family:${font};font-size:22px;font-weight:bold;color:${PALETTE.espresso}`)}
${card.eventLines.length ? row(card.eventLines.map(escapeHtml).join("<br>"), `padding:0 34px 14px;font-family:${sans};font-size:13px;line-height:1.6;color:${PALETTE.ink}`) : ""}
${card.deadline ? row(`Kindly reply by ${escapeHtml(card.deadline)}`, `padding:8px 34px 12px;font-family:${sans};font-size:13px;font-weight:bold;color:${PALETTE.espresso}`) : ""}
<tr><td align="center" class="card-pad" style="padding:4px 34px 14px">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="${accent}" style="border-radius:2px">
<a href="${escapeHtml(card.rsvpUrl)}" style="display:inline-block;padding:15px 44px;font-family:${sans};font-size:14px;font-weight:bold;letter-spacing:0.16em;text-transform:uppercase;color:#FFFFFF;text-decoration:none">RSVP</a>
</td></tr></table></td></tr>
${row(
    `If the button doesn't open, copy this link into your browser:<br><a href="${escapeHtml(card.rsvpUrl)}" style="color:${accent};text-decoration:underline;word-break:break-all">${escapeHtml(card.rsvpUrl)}</a>${card.code ? `<br>Or visit ${escapeHtml(card.code.address)} and enter <strong>${escapeHtml(card.code.code)}</strong>.` : ""}`,
    `padding:0 34px 12px;font-family:${sans};font-size:12px;line-height:1.6;color:${PALETTE.ink}`,
)}
<tr><td style="padding:0;line-height:0;font-size:0"><img src="${escapeHtml(assetOrigin)}/wedding/email/botanical-footer.jpg" width="518" alt="" role="presentation" style="display:block;width:100%;height:auto;border:0"></td></tr>
</table>`;
}

export interface StationeryEmail {
    kind: CampaignKind | "update" | "rsvp_confirmation";
    /** Plain-text body exactly as the guest's text part reads. */
    text: string;
    coupleNames: string;
    weddingDate: string;
    /** Absolute origin of the wedding site, for the artwork. */
    assetOrigin: string;
    accent?: StationeryAccent;
    /** The main action, e.g. the household's RSVP link. Also present in the text. */
    action?: { label: string; url: string } | null;
    /** A wedding photograph for thank-you cards (absolute https URL), with its alt text. */
    photo?: { url: string; alt: string } | null;
    /** A controlled test: a banner says so and names who it was sent to. */
    test?: { recipient: string } | null;
    /** The invitation itself, shown where the text contains CARD_MARKER (formal invitations). */
    card?: InvitationCard | null;
    /** The Save the Date, shown where the text contains SAVE_THE_DATE_MARKER. */
    saveTheDate?: SaveTheDateCard | null;
}

const EYEBROWS: Record<StationeryEmail["kind"], string> = {
    save_the_date: "Save the date",
    invitation: "You're invited",
    reminder: "A gentle reminder",
    final_details: "The final details",
    thank_you: "With thanks",
    update: "A note from us",
    rsvp_confirmation: "Your RSVP",
};

export function stationeryEmailHtml(input: StationeryEmail): string {
    const accent = PALETTE[input.accent ?? "burgundy"];
    const font = "Georgia,'Times New Roman',Times,serif";
    const sans = "'Helvetica Neue',Helvetica,Arial,sans-serif";
    const paragraphs = input.text
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) =>
            p === CARD_MARKER && input.card
                ? invitationCardHtml(input.card, accent, input.assetOrigin)
                : p === SAVE_THE_DATE_MARKER && input.saveTheDate
                  ? saveTheDateHtml(input.saveTheDate, accent, input.assetOrigin)
                  : `<p style="margin:0 0 18px;font-family:${font};font-size:17px;line-height:1.65;color:${PALETTE.ink}">${linkify(p.replaceAll(CARD_MARKER, "").replaceAll(SAVE_THE_DATE_MARKER, ""), accent)}</p>`,
        )
        .join("");
    // With the invitation or Save the Date card in the body, the card carries the names, date and actions.
    const withCard = (!!input.card && input.text.includes(CARD_MARKER)) || (!!input.saveTheDate && input.text.includes(SAVE_THE_DATE_MARKER));
    const [one, two] = input.coupleNames.split(/\s+&\s+/, 2);
    const names = two
        ? `${escapeHtml(one)}<br><span style="font-style:italic;font-size:24px;color:${accent}">&amp;</span><br>${escapeHtml(two)}`
        : escapeHtml(input.coupleNames);
    const preheader = escapeHtml(input.text.replaceAll(CARD_MARKER, " ").replaceAll(SAVE_THE_DATE_MARKER, " ").replace(/\s+/g, " ").slice(0, 110));
    const button =
        input.action && !withCard
            ? `<tr><td align="center" style="padding:6px 40px 30px">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="${accent}" style="border-radius:2px">
<a href="${escapeHtml(input.action.url)}" style="display:inline-block;padding:14px 30px;font-family:${sans};font-size:14px;font-weight:bold;letter-spacing:0.08em;text-transform:uppercase;color:#FFFFFF;text-decoration:none">${escapeHtml(input.action.label)}</a>
</td></tr></table></td></tr>`
            : "";
    const photo = input.photo
        ? `<tr><td style="padding:0 40px 28px"><img src="${escapeHtml(input.photo.url)}" width="520" alt="${escapeHtml(input.photo.alt)}" style="display:block;width:100%;max-width:520px;height:auto;border:0"></td></tr>`
        : "";
    const test = input.test
        ? `<tr><td style="padding:14px 24px;background:#FFF4D6;border-bottom:1px solid #E8D49B;font-family:${sans};font-size:13px;line-height:1.5;color:#5C4813;text-align:center"><strong>TEST</strong> · sent only to ${escapeHtml(input.test.recipient)}. No guest has received this, and nothing in the guest list has changed.</td></tr>`
        : "";
    return `<!doctype html>
<html lang="en-AU">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(EYEBROWS[input.kind])} · ${escapeHtml(input.coupleNames)}</title>
<style>
/* Phones: give the words the width. Clients that ignore this keep the desktop spacing. */
@media only screen and (max-width: 520px) {
  .outer { padding: 12px 6px !important; }
  .pad { padding-left: 20px !important; padding-right: 20px !important; }
  .card-pad { padding-left: 14px !important; padding-right: 14px !important; }
}
</style>
</head>
<body style="margin:0;padding:0;background:${PALETTE.table}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${PALETTE.table}" style="background:${PALETTE.table}">
<tr><td align="center" class="outer" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="${PALETTE.paper}" style="width:100%;max-width:600px;background:${PALETTE.paper};border:1px solid ${PALETTE.rule}">
${test}
${
    withCard
        ? `<tr><td class="pad" style="padding:28px 40px 10px">${paragraphs}</td></tr>`
        : `<tr><td style="padding:0;line-height:0;font-size:0"><img src="${escapeHtml(input.assetOrigin)}/wedding/email/botanical-header.jpg" width="600" alt="" role="presentation" style="display:block;width:100%;max-width:600px;height:auto;border:0"></td></tr>
<tr><td align="center" style="padding:8px 40px 4px;font-family:${sans};font-size:12px;letter-spacing:0.22em;text-transform:uppercase;color:${accent}">${escapeHtml(EYEBROWS[input.kind])}</td></tr>
<tr><td align="center" style="padding:10px 40px 6px;font-family:${font};font-size:38px;line-height:1.15;color:${PALETTE.espresso}">${names}</td></tr>
${input.weddingDate ? `<tr><td align="center" style="padding:6px 40px 26px;font-family:${sans};font-size:13px;letter-spacing:0.16em;text-transform:uppercase;color:${PALETTE.clay}">${escapeHtml(input.weddingDate)}</td></tr>` : ""}
<tr><td style="padding:0 40px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-top:1px solid ${PALETTE.rule};font-size:0;line-height:0;height:1px">&nbsp;</td></tr></table></td></tr>
${photo ? photo.replace("padding:0 40px 28px", "padding:28px 40px 4px") : ""}
<tr><td class="pad" style="padding:28px 40px 6px">${paragraphs}</td></tr>
${button}
<tr><td style="padding:0;line-height:0;font-size:0"><img src="${escapeHtml(input.assetOrigin)}/wedding/email/botanical-footer.jpg" width="600" alt="" role="presentation" style="display:block;width:100%;max-width:600px;height:auto;border:0"></td></tr>`
}
</table>
<p style="margin:16px 0 0;font-family:${sans};font-size:12px;line-height:1.5;color:${PALETTE.clay}">Sent with love by ${escapeHtml(input.coupleNames)}. Reply to this email to reach us.</p>
</td></tr>
</table>
</body>
</html>`;
}
