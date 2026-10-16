// Guest email in the wedding's stationery style: warm ivory paper, espresso type, one restrained
// accent and the fine-art native botanicals from the printed invitation, cropped into an asymmetric
// header (banksia and wattle) and footer (waratah and gum nuts).
//
// Built for email clients rather than browsers: one 600px table, inline styles only, no web fonts
// it depends on (Georgia stands in for the display serif), no background images. Every word is live
// text, so it reads the same with images blocked; the artwork is decorative (empty alt) and the
// paper colour carries the look on its own. Every string is escaped; links are only ever the URLs
// the portal produced, shown with readable text.
import type { CampaignKind } from "../../src/shared/portal/campaigns";

export const PALETTE = {
    ivory: "#F5F0E7",
    paper: "#FBF8F2",
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
        .map((p) => `<p style="margin:0 0 18px;font-family:${font};font-size:17px;line-height:1.65;color:${PALETTE.ink}">${linkify(p, accent)}</p>`)
        .join("");
    const [one, two] = input.coupleNames.split(/\s+&\s+/, 2);
    const names = two
        ? `${escapeHtml(one)}<br><span style="font-style:italic;font-size:24px;color:${accent}">&amp;</span><br>${escapeHtml(two)}`
        : escapeHtml(input.coupleNames);
    const preheader = escapeHtml(input.text.replace(/\s+/g, " ").slice(0, 110));
    const button = input.action
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
</head>
<body style="margin:0;padding:0;background:${PALETTE.ivory}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${PALETTE.ivory}" style="background:${PALETTE.ivory}">
<tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="${PALETTE.paper}" style="width:100%;max-width:600px;background:${PALETTE.paper};border:1px solid ${PALETTE.rule}">
${test}
<tr><td style="padding:0;line-height:0;font-size:0"><img src="${escapeHtml(input.assetOrigin)}/wedding/email/botanical-header.jpg" width="600" alt="" role="presentation" style="display:block;width:100%;max-width:600px;height:auto;border:0"></td></tr>
<tr><td align="center" style="padding:8px 40px 4px;font-family:${sans};font-size:12px;letter-spacing:0.22em;text-transform:uppercase;color:${accent}">${escapeHtml(EYEBROWS[input.kind])}</td></tr>
<tr><td align="center" style="padding:10px 40px 6px;font-family:${font};font-size:38px;line-height:1.15;color:${PALETTE.espresso}">${names}</td></tr>
${input.weddingDate ? `<tr><td align="center" style="padding:6px 40px 26px;font-family:${sans};font-size:13px;letter-spacing:0.16em;text-transform:uppercase;color:${PALETTE.clay}">${escapeHtml(input.weddingDate)}</td></tr>` : ""}
<tr><td style="padding:0 40px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-top:1px solid ${PALETTE.rule};font-size:0;line-height:0;height:1px">&nbsp;</td></tr></table></td></tr>
${photo ? photo.replace("padding:0 40px 28px", "padding:28px 40px 4px") : ""}
<tr><td style="padding:28px 40px 6px">${paragraphs}</td></tr>
${button}
<tr><td style="padding:0;line-height:0;font-size:0"><img src="${escapeHtml(input.assetOrigin)}/wedding/email/botanical-footer.jpg" width="600" alt="" role="presentation" style="display:block;width:100%;max-width:600px;height:auto;border:0"></td></tr>
</table>
<p style="margin:16px 0 0;font-family:${sans};font-size:12px;line-height:1.5;color:${PALETTE.clay}">Sent with love by ${escapeHtml(input.coupleNames)}. Reply to this email to reach us.</p>
</td></tr>
</table>
</body>
</html>`;
}
