import type { D1Database } from "@cloudflare/workers-types";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, type PDFFont, StandardFonts, rgb } from "pdf-lib";
import QRCode from "qrcode";
import { z } from "zod";
import { type InvitationAddressing, invitationAddressing, salutation } from "../../src/shared/portal/invitation-names";
import type { InvitationPreview, InvitationStudioHousehold } from "../../src/shared/portal/types";
import type { Env } from "../env";
import { invitationUrl, typedRsvpAddress } from "../wedding/invitations";
import { auditStatement, newId, nowIso, placeholders } from "./db";
import { ValidationError } from "./entities";
import { getSettings } from "./settings";

const requestSchema = z.object({
    householdIds: z.array(z.string().max(40)).min(1).max(250),
    /**
     * "household" (the default) makes one invitation per household, addressed to everyone invited.
     * "individual" is the advanced option: one per invited person, each with their own QR code,
     * which still opens the whole household's RSVP.
     */
    delivery: z.enum(["household", "individual"]).default("household"),
    channels: z
        .array(z.enum(["email", "sms", "print"]))
        .min(1)
        .max(3)
        .default(["print"]),
    /** Used only for fixture/documentation output. Normal Studio previews are never labelled sample. */
    sample: z.boolean().default(false),
});

/** One version per household (or per person for individual delivery); generation stores one row per version and channel. */
const MAX_RECIPIENTS = 1000;
/** Artefact rows per INSERT. Rows travel as one JSON parameter, so a whole run is a handful of D1 queries. */
const ARTIFACT_ROWS_PER_STATEMENT = 250;

/** The RSVP page's order, so an invitation names people in the order they appear on the form. */
const HOUSEHOLD_ORDER = "g.is_plus_one, g.household_order IS NULL, g.household_order, g.age_group, g.created_at, g.rowid";

export interface HouseholdAddressing extends InvitationAddressing {
    /** Invited guests in RSVP order, for choosing who receives a household's single email or text. */
    guestIds: string[];
}

/**
 * How every live household's invitation is addressed: its invitation name, or the names of the
 * guests invited to an event with RSVPs open (the people its RSVP link lets it answer for).
 */
export async function householdAddressing(db: D1Database): Promise<Map<string, HouseholdAddressing>> {
    const [homes, guests] = await db.batch([
        db.prepare("SELECT id, name, invitation_name, invitation_list_names FROM households WHERE deleted_at IS NULL"),
        db.prepare(
            `SELECT g.id, g.household_id, g.first_name, g.last_name FROM guests g
             WHERE g.deleted_at IS NULL AND g.household_id IS NOT NULL
               AND EXISTS (SELECT 1 FROM guest_events ge JOIN events e ON e.id = ge.event_id WHERE ge.guest_id = g.id AND e.rsvp_enabled = 1)
             ORDER BY ${HOUSEHOLD_ORDER}`,
        ),
    ]);
    const people = new Map<string, { id: string; firstName: string; lastName: string }[]>();
    for (const guest of guests.results as { id: string; household_id: string; first_name: string; last_name: string | null }[])
        people.set(guest.household_id, [
            ...(people.get(guest.household_id) ?? []),
            { id: guest.id, firstName: guest.first_name, lastName: guest.last_name ?? "" },
        ]);
    const out = new Map<string, HouseholdAddressing>();
    for (const home of homes.results as { id: string; name: string; invitation_name: string | null; invitation_list_names: number }[]) {
        const invited = people.get(home.id) ?? [];
        out.set(home.id, {
            ...invitationAddressing(invited, { invitationName: home.invitation_name, listNames: !!home.invitation_list_names }, home.name),
            guestIds: invited.map((guest) => guest.id),
        });
    }
    return out;
}

export async function listStudioHouseholds(db: D1Database): Promise<InvitationStudioHousehold[]> {
    const [homes, guests, deliveries] = await db.batch([
        db.prepare(
            `SELECT id, name, email, phone, rsvp_code, invite_version, invite_revoked_at, invitation_generated_at,
                    invitation_name, invitation_list_names
             FROM households WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE`,
        ),
        db.prepare(
            // `invited` mirrors the RSVP form, which only shows guests invited to an event with RSVPs open.
            `SELECT g.id, g.household_id, g.first_name, g.last_name,
                    EXISTS (SELECT 1 FROM guest_events ge JOIN events e ON e.id = ge.event_id
                            WHERE ge.guest_id = g.id AND e.rsvp_enabled = 1) AS invited
             FROM guests g WHERE g.deleted_at IS NULL AND g.household_id IS NOT NULL
             ORDER BY ${HOUSEHOLD_ORDER}`,
        ),
        db.prepare(
            `SELECT household_id, channel, status, updated_at FROM (
                 SELECT household_id, channel, status, updated_at,
                        ROW_NUMBER() OVER (PARTITION BY household_id, channel ORDER BY updated_at DESC, id DESC) AS position
                 FROM invitation_artifacts
             ) WHERE position = 1 ORDER BY updated_at DESC`,
        ),
    ]);
    return (homes.results as Record<string, unknown>[]).map((home) => {
        const members = (guests.results as Record<string, unknown>[])
            .filter((guest) => guest.household_id === home.id)
            .map((guest) => {
                const firstName = String(guest.first_name);
                const lastName = String(guest.last_name ?? "");
                return { id: String(guest.id), name: `${firstName} ${lastName}`.trim(), firstName, lastName, invited: Boolean(guest.invited) };
            });
        const invitationName = (home.invitation_name as string | null) ?? null;
        const invitationListNames = Boolean(home.invitation_list_names);
        return {
            id: String(home.id),
            name: String(home.name),
            invitationName,
            invitationListNames,
            recipientLine: invitationAddressing(
                members.filter((guest) => guest.invited),
                { invitationName, listNames: invitationListNames },
                String(home.name),
            ).recipientLine,
            email: (home.email as string | null) ?? null,
            phone: (home.phone as string | null) ?? null,
            rsvpCode: String(home.rsvp_code),
            inviteVersion: Number(home.invite_version),
            inviteRevoked: home.invite_revoked_at != null,
            invitationGeneratedAt: (home.invitation_generated_at as string | null) ?? null,
            guests: members,
            delivery: (deliveries.results as Record<string, unknown>[])
                .filter((delivery) => delivery.household_id === home.id)
                .map((delivery) => ({
                    channel: delivery.channel as "email" | "sms" | "print",
                    status: String(delivery.status),
                    updatedAt: String(delivery.updated_at),
                })),
        };
    });
}

const formatDate = (date: string) =>
    date
        ? new Intl.DateTimeFormat("en-AU", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })
              .format(new Date(`${date}T12:00:00Z`))
              .replace(/^(\p{L}+)\s/u, "$1, ")
        : "";

const formatTime = (dateTime: string | null) => {
    if (!dateTime) return "";
    const match = /T(\d{2}):(\d{2})/.exec(dateTime);
    if (!match) return "";
    const hour = Number(match[1]);
    const minute = match[2];
    return `${hour % 12 || 12}:${minute} ${hour < 12 ? "am" : "pm"}`;
};

const displayLocation = (location: string) =>
    location
        .replace(/\s*[·•]\s*/g, ", ")
        .replace(/,\s*(NSW|VIC|QLD|SA|WA|TAS|NT|ACT)\b/g, " $1")
        .trim();

const mergeCopy = (copy: string, values: Record<string, string>) => copy.replace(/\{\{([a-z_]+)\}\}/g, (token, key: string) => values[key] ?? token);

const svgDataUrl = async (value: string) => {
    const svg = await QRCode.toString(value, {
        type: "svg",
        errorCorrectionLevel: "M",
        margin: 4,
        width: 512,
        color: { dark: "#3c2a23", light: "#fcf9f3" },
    });
    return `data:image/svg+xml;base64,${btoa(svg)}`;
};

export async function invitationPreviews(env: Env, input: unknown): Promise<InvitationPreview[]> {
    const request = requestSchema.parse(input);
    const households = await listStudioHouseholds(env.DB);
    const selected = households.filter((household) => request.householdIds.includes(household.id));
    if (selected.length !== new Set(request.householdIds).size) throw new ValidationError("One of those households no longer exists", "householdIds");
    const [wedding, rsvp, template, events] = await Promise.all([
        getSettings(env.DB, "wedding"),
        getSettings(env.DB, "rsvp"),
        getSettings(env.DB, "invitation"),
        env.DB.prepare("SELECT name, starts_at, venue_name, address FROM events WHERE is_public = 1 ORDER BY sort_order, starts_at").all<{
            name: string;
            starts_at: string | null;
            venue_name: string | null;
            address: string | null;
        }>(),
    ]);
    const eventLines = events.results.map((event) => {
        const time = formatTime(event.starts_at);
        const detail = [time, event.venue_name].filter(Boolean).join(" at ");
        return [event.name, detail].filter(Boolean).join(" - ");
    });
    // Only guests the RSVP form will show get an invitation, matching the bulk generator: a household
    // with nobody invited to an RSVP-enabled event, or a revoked link, would get a link that 404s.
    const skipped = selected.filter((household) => household.inviteRevoked || !household.guests.some((guest) => guest.invited));
    if (skipped.length)
        throw new ValidationError(
            `${skipped.map((household) => household.name).join(", ")} ${skipped.length === 1 ? "has" : "have"} no one invited to an event with RSVPs open, or a revoked link. Deselect ${skipped.length === 1 ? "it" : "them"} first.`,
            "householdIds",
        );
    const individual = request.delivery === "individual";
    const recipients = selected.map((household) => {
        const invited = household.guests.filter((guest) => guest.invited);
        return { household, invited, targets: individual ? invited : [null] };
    });
    if (recipients.reduce((total, { targets }) => total + targets.length, 0) > MAX_RECIPIENTS)
        throw new ValidationError(`That is more than ${MAX_RECIPIENTS} invitations. Choose fewer households.`, "householdIds");
    const previews: InvitationPreview[] = [];
    for (const { household, invited, targets } of recipients) {
        const guestNames = invited.map((person) => person.name);
        for (const guest of targets) {
            const rsvpUrl = await invitationUrl(env, household.id, household.inviteVersion, guest?.id);
            if (!rsvpUrl) throw new ValidationError("Invitation links are not configured", "householdIds");
            const coupleNames = `${wedding.partnerOne} & ${wedding.partnerTwo}`;
            // A household invitation is addressed to everyone invited, once. An individual one is
            // addressed to that person alone; their link still opens the whole household's RSVP.
            const addressing = guest
                ? invitationAddressing([guest], {}, guest.name)
                : invitationAddressing(invited, { invitationName: household.invitationName, listNames: household.invitationListNames }, household.name);
            const greeting = salutation(template.greetingPrefix, addressing.greetingNames);
            const addressedTo = addressing.namesLine ? `${addressing.recipientLine} (${addressing.namesLine})` : addressing.recipientLine;
            const deadline = formatDate(rsvp.deadline);
            const weddingDate = formatDate(wedding.date);
            const location = displayLocation(wedding.location);
            const mergeValues = {
                couple_names: coupleNames,
                household_name: household.name,
                guest_name: guest?.name ?? "",
                invitation_names: addressing.recipientLine,
                greeting_names: addressing.greetingNames,
                wedding_date: weddingDate,
                wedding_location: location,
                rsvp_deadline: deadline,
            };
            previews.push({
                key: `${household.id}:${guest?.id ?? "household"}`,
                householdId: household.id,
                guestId: guest?.id ?? null,
                householdName: household.name,
                delivery: request.delivery,
                guestNames,
                highlightedGuest: guest?.name ?? null,
                coupleNames,
                recipientLine: addressing.recipientLine,
                namesLine: addressing.namesLine,
                greeting,
                eyebrow: mergeCopy(template.eyebrow, mergeValues),
                invitationLine: mergeCopy(template.invitationLine, mergeValues),
                weddingDate,
                location,
                artwork: template.artwork,
                accent: template.accent,
                sample: request.sample,
                rsvpUrl,
                fallback: typedRsvpAddress(env),
                rsvpCode: rsvp.allowCodes ? household.rsvpCode : null,
                qrDataUrl: await svgDataUrl(rsvpUrl),
                eventLines,
                deadline,
                emailSubject: `You're invited to ${coupleNames}'s wedding`,
                emailBody: [
                    `${greeting},`,
                    mergeCopy(template.emailIntroduction, mergeValues),
                    `${coupleNames}\n${weddingDate}\n${location}`,
                    ...eventLines,
                    `This invitation is for ${addressedTo}.${guestNames.length > 1 ? " You can reply for each person separately." : ""}`,
                    `${deadline ? `Please reply by ${deadline}: ` : "RSVP: "}${rsvpUrl}`,
                    // Only offer the code when the RSVP page accepts codes.
                    ...(rsvp.allowCodes ? [`If the link does not open, visit ${typedRsvpAddress(env)} and enter ${household.rsvpCode}.`] : []),
                    mergeCopy(template.emailSignoff, mergeValues),
                ].join("\n\n"),
                smsBody: `${greeting}, you're invited to ${coupleNames}'s wedding on ${weddingDate}. ${deadline ? `RSVP by ${deadline}: ` : "RSVP: "}${rsvpUrl}`,
            });
        }
    }
    return previews;
}

/** Records generated artefacts only. Sending remains a separate, explicit Communications action. */
export async function generateStudioInvitations(env: Env, input: unknown, actor: string) {
    const request = requestSchema.parse(input);
    const previews = await invitationPreviews(env, request);
    const now = nowIso();
    const rows = previews.flatMap((preview) => {
        const version = Number(preview.rsvpUrl.match(/invite=[^.]+\.([0-9]+)/)?.[1] ?? 1);
        return request.channels.map((channel) => ({
            id: newId("inv"),
            household_id: preview.householdId,
            guest_id: preview.guestId,
            recipient_key: preview.guestId ?? "household",
            channel,
            invite_version: version,
        }));
    });
    const statements = [];
    for (let start = 0; start < rows.length; start += ARTIFACT_ROWS_PER_STATEMENT) {
        statements.push(
            env.DB.prepare(
                // `WHERE true` lets SQLite parse the upsert after a SELECT.
                `INSERT INTO invitation_artifacts (id, household_id, guest_id, recipient_key, channel, invite_version, status, created_by, created_at, updated_at)
                     SELECT value ->> 'id', value ->> 'household_id', value ->> 'guest_id', value ->> 'recipient_key', value ->> 'channel',
                            value ->> 'invite_version', 'generated', ?2, ?3, ?3
                     FROM json_each(?1) WHERE true
                     ON CONFLICT(household_id, recipient_key, channel, invite_version) DO UPDATE SET updated_at = excluded.updated_at`,
            ).bind(JSON.stringify(rows.slice(start, start + ARTIFACT_ROWS_PER_STATEMENT)), actor, now),
        );
    }
    const ids = [...new Set(previews.map((preview) => preview.householdId))];
    for (let start = 0; start < ids.length; start += 80) {
        const part = ids.slice(start, start + 80);
        statements.push(
            env.DB.prepare(`UPDATE households SET invitation_generated_at = ?, updated_at = ? WHERE id IN (${placeholders(part.length)})`).bind(
                now,
                now,
                ...part,
            ),
        );
    }
    statements.push(
        auditStatement(env.DB, {
            actor,
            action: "invitation.generate",
            entityType: "invitation",
            summary: `Generated ${previews.length} invitation${previews.length === 1 ? "" : "s"} for ${ids.length} households (nothing sent)`,
            changes: { householdIds: ids, channels: request.channels, delivery: request.delivery },
        }),
    );
    await env.DB.batch(statements);
    return { generated: previews.length, households: ids.length, channels: request.channels, sent: 0, previews };
}

const wrap = (text: string, font: PDFFont, size: number, maxWidth: number) => {
    const words = text.trim().split(/\s+/);
    const lines: string[] = [];
    let line = "";
    for (const word of words) {
        const next = `${line} ${word}`.trim();
        if (font.widthOfTextAtSize(next, size) > maxWidth && line) (lines.push(line), (line = word));
        else line = next;
    }
    if (line) lines.push(line);
    return lines;
};

export async function printableInvitations(env: Env, input: unknown): Promise<Uint8Array> {
    const request = requestSchema.parse(input);
    const previews = await invitationPreviews(env, request);
    const pdf = await PDFDocument.create();
    pdf.registerFontkit(fontkit);
    const [artworkResponse, scriptResponse] = await Promise.all([
        env.ASSETS.fetch("https://assets.local/wedding/native-invitation-frame.jpg"),
        env.ASSETS.fetch("https://assets.local/wedding/invitation-script.woff"),
    ]);
    if (previews.some((preview) => preview.artwork === "native-botanicals") && !artworkResponse.ok)
        throw new Error("Invitation botanical artwork is missing; run the client build");
    const artwork = artworkResponse.ok ? await pdf.embedJpg(await artworkResponse.arrayBuffer()) : null;
    if (!scriptResponse.ok) throw new Error("Invitation script font is missing; run the client build");
    const script = await pdf.embedFont(await scriptResponse.arrayBuffer(), { subset: true });
    const serif = await pdf.embedFont(StandardFonts.TimesRoman);
    const serifBold = await pdf.embedFont(StandardFonts.TimesRomanBold);
    const serifItalic = await pdf.embedFont(StandardFonts.TimesRomanItalic);
    const sans = await pdf.embedFont(StandardFonts.Helvetica);
    const sansBold = await pdf.embedFont(StandardFonts.HelveticaBold);
    const pageWidth = 419.53;
    const pageHeight = 595.28;
    const espresso = rgb(0.235, 0.165, 0.137);
    const ivory = rgb(0.969, 0.949, 0.918);
    const accentColours = {
        burgundy: rgb(0.545, 0.184, 0.239),
        rust: rgb(0.769, 0.42, 0.235),
        eucalyptus: rgb(0.322, 0.439, 0.329),
    };
    for (const preview of previews) {
        const page = pdf.addPage([pageWidth, pageHeight]);
        page.drawRectangle({ x: 0, y: 0, width: pageWidth, height: pageHeight, color: ivory });
        if (artwork && preview.artwork === "native-botanicals") page.drawImage(artwork, { x: 0, y: 0, width: pageWidth, height: pageHeight });
        const accent = accentColours[preview.accent];
        const centre = (text: string, y: number, size: number, font = serif, color = espresso) =>
            page.drawText(text, { x: (pageWidth - font.widthOfTextAtSize(text, size)) / 2, y, size, font, color });
        const centredLines = (text: string, y: number, size: number, font: PDFFont, maxWidth: number, leading: number, color = espresso) => {
            for (const line of wrap(text, font, size, maxWidth)) {
                centre(line, y, size, font, color);
                y -= leading;
            }
            return y;
        };

        // A soft ivory wash behind the heading keeps the script names readable where the banksia and
        // wattle reach in, without hiding the artwork.
        if (artwork && preview.artwork === "native-botanicals")
            for (const [xScale, yScale, opacity] of [
                [188, 80, 0.28],
                [168, 64, 0.32],
                [146, 50, 0.36],
            ] as const)
                page.drawEllipse({ x: pageWidth / 2, y: 488, xScale, yScale, color: ivory, opacity });

        if (preview.sample) {
            page.drawRectangle({ x: 111, y: 572, width: 198, height: 15, color: ivory, opacity: 0.94 });
            centre("SAMPLE PREVIEW - NOT FOR DELIVERY", 577, 6.5, sansBold, accent);
        }
        centre(preview.eyebrow.toUpperCase(), 532, 7.2, sansBold, espresso);
        const scriptSize = Math.min(38, (350 / script.widthOfTextAtSize(preview.coupleNames, 38)) * 38);
        centre(preview.coupleNames, 481, scriptSize, script, accent);
        page.drawLine({ start: { x: 172, y: 468 }, end: { x: 248, y: 468 }, thickness: 0.8, color: rgb(0.784, 0.604, 0.204) });
        const afterLine = centredLines(preview.invitationLine, 448, 12, serifItalic, 282, 15);
        // One recipient line, never a separate heading plus a repeated list. Long lines step down a
        // size rather than run into the date.
        let recipientSize = 14;
        let recipientLines = wrap(preview.recipientLine, serifBold, recipientSize, 290);
        if (recipientLines.length > 2) {
            recipientSize = 12;
            recipientLines = wrap(preview.recipientLine, serifBold, recipientSize, 300).slice(0, 3);
        }
        let recipientY = Math.min(414, afterLine - 5);
        for (const line of recipientLines) {
            centre(line, recipientY, recipientSize, serifBold, espresso);
            recipientY -= recipientSize + 3;
        }
        // Listed names stop short of the date line.
        if (preview.namesLine)
            for (const [index, line] of wrap(preview.namesLine, sans, 8.5, 260).entries()) {
                const y = recipientY - 1 - index * 11;
                if (y < 362) break;
                centre(line, y, 8.5, sans, rgb(0.365, 0.416, 0.337));
            }

        centre(preview.weddingDate.toUpperCase(), 349, 13, serifBold, espresso);
        centre(preview.location, 327, 11, serifItalic, accent);
        let eventY = 300;
        for (const event of preview.eventLines.slice(0, 3)) eventY = centredLines(event, eventY, 8.5, sans, 270, 12, espresso) - 2;
        if (preview.deadline) centre(`Kindly reply by ${preview.deadline}`, Math.max(238, eventY - 5), 8.5, sansBold, accent);

        const qr = QRCode.create(preview.rsvpUrl, { errorCorrectionLevel: "M" });
        const modules = qr.modules.size;
        const quiet = 4;
        const box = 112;
        const cell = box / (modules + quiet * 2);
        const x0 = (pageWidth - box) / 2;
        const y0 = 92;
        page.drawRectangle({ x: x0, y: y0, width: box, height: box, color: rgb(1, 1, 1) });
        for (let row = 0; row < modules; row++) {
            for (let column = 0; column < modules; column++) {
                if (!qr.modules.get(row, column)) continue;
                page.drawRectangle({
                    x: x0 + (column + quiet) * cell,
                    y: y0 + box - (row + quiet + 1) * cell,
                    width: cell + 0.02,
                    height: cell + 0.02,
                    color: espresso,
                });
            }
        }
        // The caption shares the ivory panel so it stays legible over the foliage. The typed fallback
        // is only useful with a code; without one the QR code is the way in.
        const panelBottom = preview.rsvpCode ? 39 : 69;
        page.drawRectangle({ x: 96, y: panelBottom, width: 228, height: 86 - panelBottom, color: ivory, opacity: 0.94 });
        centre("SCAN TO RSVP", 75, 7.5, sansBold, accent);
        if (preview.rsvpCode) {
            centre(preview.fallback, 56, 7.5, sans, espresso);
            centre(`INVITATION CODE  ${preview.rsvpCode}`, 44, 7.2, sansBold, espresso);
        }
    }
    pdf.setTitle(`${previews[0]?.coupleNames ?? "Wedding"} - Wedding invitations`);
    pdf.setCreator("Wedding Planner Invitation Studio");
    return pdf.save();
}
