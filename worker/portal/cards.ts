// Printable Save the Date and Thank You cards, one A5 page per household, in the same stationery as
// the printed invitation (worker/portal/invitation-studio.ts): warm ivory paper, the fine-art native
// botanicals, Times for the display serif and Helvetica for small capitals, one accent colour.
//
// Every element sits at least 28pt inside the trim so a home or print-shop printer never clips it.
// Printing is not delivery: nothing here records a household as contacted.
import type { D1Database } from "@cloudflare/workers-types";
import { PDFDocument, type PDFFont, type PDFPage, StandardFonts, rgb } from "pdf-lib";
import { z } from "zod";
import type { Env } from "../env";
import { campaignContext, mergeValues } from "./campaigns";
import { NotFoundError, ValidationError } from "./entities";
import { listGuests } from "./guests";

const PAGE = { width: 419.53, height: 595.28 };
/** Nothing is drawn closer to the edge than this. */
const SAFE = 28;

const hex = (value: string) => rgb(parseInt(value.slice(1, 3), 16) / 255, parseInt(value.slice(3, 5), 16) / 255, parseInt(value.slice(5, 7), 16) / 255);
const COLOURS = {
    ivory: hex("#F5F0E7"),
    espresso: hex("#49342D"),
    ink: hex("#4F3D36"),
    burgundy: hex("#783B4A"),
    clay: hex("#9C765C"),
    eucalyptus: hex("#798676"),
};

export const cardsSchema = z.object({
    kind: z.enum(["save_the_date", "thank_you"]),
    householdIds: z.array(z.string().max(40)).min(1, "Choose at least one household").max(500),
    /** Fixture and documentation output only; marks every page as a sample. */
    sample: z.boolean().default(false),
});

const wrap = (text: string, font: PDFFont, size: number, maxWidth: number) => {
    const lines: string[] = [];
    for (const paragraph of text.split(/\n/)) {
        let line = "";
        for (const word of paragraph.trim().split(/\s+/).filter(Boolean)) {
            const next = `${line} ${word}`.trim();
            if (font.widthOfTextAtSize(next, size) > maxWidth && line) {
                lines.push(line);
                line = word;
            } else line = next;
        }
        lines.push(line);
    }
    return lines;
};

/** pdf-lib's standard fonts only cover WinAnsi; anything else becomes its closest plain form. */
const printable = (text: string) =>
    text
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[‘’]/g, "'")
        .replace(/[“”]/g, '"')
        .replace(/[–—]/g, "-")
        .replace(/[^\x20-\x7e\n]/g, "");

interface Drawing {
    page: PDFPage;
    centre: (text: string, y: number, size: number, font: PDFFont, color?: ReturnType<typeof rgb>) => void;
    lines: (text: string, y: number, size: number, font: PDFFont, maxWidth: number, leading: number, color?: ReturnType<typeof rgb>, floor?: number) => number;
}

const drawing = (page: PDFPage): Drawing => {
    const centre: Drawing["centre"] = (text, y, size, font, color = COLOURS.espresso) => {
        const value = printable(text);
        page.drawText(value, { x: (PAGE.width - font.widthOfTextAtSize(value, size)) / 2, y, size, font, color });
    };
    return {
        page,
        centre,
        lines: (text, y, size, font, maxWidth, leading, color = COLOURS.ink, floor = SAFE + 20) => {
            for (const line of wrap(printable(text), font, size, maxWidth)) {
                if (y < floor) break;
                if (line) centre(line, y, size, font, color);
                y -= leading;
            }
            return y;
        },
    };
};

export async function printableCards(env: Env, db: D1Database, input: unknown): Promise<Uint8Array> {
    const request = cardsSchema.parse(input);
    const context = await campaignContext(env, db, await listGuests(db));
    const households = [...new Set(request.householdIds)].map((id) => context.households.get(id));
    if (households.some((h) => !h)) throw new NotFoundError("One of those households no longer exists");
    const accent = COLOURS[context.studio.accent];

    const pdf = await PDFDocument.create();
    const frameName = request.kind === "save_the_date" ? "native-save-the-date-frame.jpg" : "native-invitation-frame.jpg";
    const frameResponse = await env.ASSETS.fetch(`https://assets.local/wedding/${frameName}`);
    if (!frameResponse.ok) throw new Error("Card artwork is missing; run the client build");
    const frame = await pdf.embedJpg(await frameResponse.arrayBuffer());
    const footerResponse = await env.ASSETS.fetch("https://assets.local/wedding/email/botanical-footer.jpg");
    const footer = footerResponse.ok ? await pdf.embedJpg(await footerResponse.arrayBuffer()) : null;

    // The thank-you photograph comes straight from R2, so it prints whether or not the site is published.
    let photo: Awaited<ReturnType<PDFDocument["embedJpg"]>> | null = null;
    if (request.kind === "thank_you" && context.studio.thankYou.photoId) {
        const media = await db
            .prepare("SELECT r2_key, content_type FROM website_media WHERE id = ?")
            .bind(context.studio.thankYou.photoId)
            .first<{ r2_key: string; content_type: string }>();
        const object = media ? await env.MEDIA.get(media.r2_key) : null;
        if (object && media) {
            const bytes = await object.arrayBuffer();
            if (media.content_type === "image/jpeg") photo = await pdf.embedJpg(bytes);
            else if (media.content_type === "image/png") photo = await pdf.embedPng(bytes);
            // WebP can't be embedded in a PDF; the card is printed without it.
        }
    }

    const serif = await pdf.embedFont(StandardFonts.TimesRoman);
    const serifItalic = await pdf.embedFont(StandardFonts.TimesRomanItalic);
    const serifBold = await pdf.embedFont(StandardFonts.TimesRomanBold);
    const sans = await pdf.embedFont(StandardFonts.Helvetica);
    const sansBold = await pdf.embedFont(StandardFonts.HelveticaBold);

    for (const household of households as NonNullable<(typeof households)[number]>[]) {
        const values = mergeValues(context, { householdId: household.id, guest: null, individual: false });
        const page = pdf.addPage([PAGE.width, PAGE.height]);
        const d = drawing(page);
        page.drawRectangle({ x: 0, y: 0, width: PAGE.width, height: PAGE.height, color: COLOURS.ivory });
        if (request.sample) {
            page.drawRectangle({ x: 111, y: PAGE.height - 34, width: 198, height: 15, color: COLOURS.ivory, opacity: 0.94 });
            d.centre("SAMPLE PREVIEW - NOT FOR DELIVERY", PAGE.height - 29, 6.5, sansBold, accent);
        }
        const [one, two] = values.couple_names.split(/\s+&\s+/, 2);
        const fit = (name: string, max: number) => Math.min(max, (300 / serif.widthOfTextAtSize(printable(name), max)) * max);

        if (request.kind === "save_the_date") {
            page.drawImage(frame, { x: 0, y: 0, width: PAGE.width, height: PAGE.height });
            // A soft paper clearing behind the type, as on the invitation.
            for (const [x, y, opacity] of [
                [176, 150, 0.28],
                [150, 124, 0.36],
            ] as const)
                page.drawEllipse({ x: PAGE.width / 2, y: 318, xScale: x, yScale: y, color: COLOURS.ivory, opacity });
            d.centre(context.studio.saveTheDate.headline.toUpperCase(), 452, 9, sansBold, accent);
            if (two) {
                d.centre(one, 404, fit(one, 40), serif);
                d.centre("&", 372, 19, serifItalic, accent);
                d.centre(two, 334, fit(two, 40), serif);
            } else d.centre(values.couple_names, 370, fit(values.couple_names, 40), serif);
            page.drawLine({ start: { x: 120, y: 312 }, end: { x: 300, y: 312 }, thickness: 0.6, color: accent, opacity: 0.4 });
            d.centre(values.wedding_date.toUpperCase(), 290, 10, sansBold, accent);
            d.lines(values.venue, 266, 15, serifBold, 280, 18, COLOURS.espresso);
            if (context.studio.saveTheDate.followUp) d.lines(context.studio.saveTheDate.followUp, 226, 11.5, serifItalic, 260, 14, COLOURS.ink);
            d.centre(values.website_link.replace(/^https:\/\//, ""), 196, 8.5, sans, COLOURS.ink);
            const addressed = context.addressing.get(household.id)?.recipientLine || household.name;
            d.lines(`For ${addressed}`, 168, 9, sans, 250, 12, COLOURS.eucalyptus);
        } else {
            // With a photograph: the photo across the top, the waratah band along the foot.
            // Without one: the full botanical frame, like the invitation.
            let top = PAGE.height - SAFE - 16;
            if (photo) {
                const width = PAGE.width - SAFE * 2;
                const height = Math.min(220, (photo.height / photo.width) * width);
                page.drawImage(photo, { x: SAFE, y: PAGE.height - SAFE - height, width, height });
                if (footer) page.drawImage(footer, { x: 0, y: 0, width: PAGE.width, height: (footer.height / footer.width) * PAGE.width });
                top = PAGE.height - SAFE - height - 34;
            } else {
                page.drawImage(frame, { x: 0, y: 0, width: PAGE.width, height: PAGE.height });
                page.drawEllipse({ x: PAGE.width / 2, y: 330, xScale: 168, yScale: 170, color: COLOURS.ivory, opacity: 0.34 });
                top = 470;
            }
            d.centre(context.studio.thankYou.headline.toUpperCase(), top, 9, sansBold, accent);
            const greeting = `Dear ${values.greeting_names},`;
            let y = d.lines(greeting, top - 34, 15, serifItalic, 280, 18, COLOURS.espresso);
            y = d.lines(values.thank_you_message, y - 8, 11, serif, 270, 15, COLOURS.ink, photo ? 120 : 150);
            if (values.personal_note) y = d.lines(values.personal_note, y - 8, 11, serifItalic, 270, 15, COLOURS.ink, photo ? 110 : 140);
            d.centre("With love,", y - 14, 10, serif, COLOURS.ink);
            d.centre(values.couple_names, y - 32, 15, serif, COLOURS.espresso);
        }
    }
    if (!pdf.getPageCount()) throw new ValidationError("Choose at least one household", "householdIds");
    pdf.setTitle(`${context.wedding.partnerOne} & ${context.wedding.partnerTwo} - ${request.kind === "save_the_date" ? "Save the date" : "Thank you"} cards`);
    pdf.setCreator("Wedding Planner Communications Studio");
    return pdf.save();
}
