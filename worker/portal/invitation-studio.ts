import type { D1Database } from "@cloudflare/workers-types";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import QRCode from "qrcode";
import { z } from "zod";
import type { InvitationPreview, InvitationStudioHousehold } from "../../src/shared/portal/types";
import type { Env } from "../env";
import { invitationUrl, weddingOrigin } from "../wedding/invitations";
import { auditStatement, newId, nowIso, placeholders } from "./db";
import { ValidationError } from "./entities";
import { getSettings } from "./settings";

const requestSchema = z.object({
    householdIds: z.array(z.string().max(40)).min(1).max(250),
    guestSpecific: z.boolean().default(false),
    channels: z
        .array(z.enum(["email", "sms", "print"]))
        .min(1)
        .max(3)
        .default(["print"]),
});

export async function listStudioHouseholds(db: D1Database): Promise<InvitationStudioHousehold[]> {
    const [homes, guests, deliveries] = await db.batch([
        db.prepare(
            `SELECT id, name, email, phone, rsvp_code, invite_version, invitation_generated_at
             FROM households WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE`,
        ),
        db.prepare(
            `SELECT id, household_id, first_name, last_name FROM guests
             WHERE deleted_at IS NULL AND household_id IS NOT NULL ORDER BY household_order IS NULL, household_order, first_name`,
        ),
        db.prepare(
            `SELECT household_id, channel, status, updated_at FROM (
                 SELECT household_id, channel, status, updated_at,
                        ROW_NUMBER() OVER (PARTITION BY household_id, channel ORDER BY updated_at DESC, id DESC) AS position
                 FROM invitation_artifacts
             ) WHERE position = 1 ORDER BY updated_at DESC`,
        ),
    ]);
    return (homes.results as Record<string, unknown>[]).map((home) => ({
        id: String(home.id),
        name: String(home.name),
        email: (home.email as string | null) ?? null,
        phone: (home.phone as string | null) ?? null,
        rsvpCode: String(home.rsvp_code),
        inviteVersion: Number(home.invite_version),
        invitationGeneratedAt: (home.invitation_generated_at as string | null) ?? null,
        guests: (guests.results as Record<string, unknown>[])
            .filter((guest) => guest.household_id === home.id)
            .map((guest) => ({ id: String(guest.id), name: `${guest.first_name} ${guest.last_name ?? ""}`.trim() })),
        delivery: (deliveries.results as Record<string, unknown>[])
            .filter((delivery) => delivery.household_id === home.id)
            .map((delivery) => ({
                channel: delivery.channel as "email" | "sms" | "print",
                status: String(delivery.status),
                updatedAt: String(delivery.updated_at),
            })),
    }));
}

const formatDate = (date: string) =>
    date
        ? new Intl.DateTimeFormat("en-AU", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(
              new Date(`${date}T12:00:00Z`),
          )
        : "";

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
    const [wedding, rsvp, events] = await Promise.all([
        getSettings(env.DB, "wedding"),
        getSettings(env.DB, "rsvp"),
        env.DB.prepare("SELECT name, starts_at, venue_name FROM events WHERE is_public = 1 ORDER BY sort_order, starts_at").all<{
            name: string;
            starts_at: string | null;
            venue_name: string | null;
        }>(),
    ]);
    const eventLines = events.results.map((event) =>
        [event.name, event.starts_at ? formatDate(event.starts_at.slice(0, 10)) : null, event.venue_name].filter(Boolean).join(" - "),
    );
    const previews: InvitationPreview[] = [];
    for (const household of selected) {
        const targets = request.guestSpecific && household.guests.length ? household.guests.map((guest) => ({ guest })) : [{ guest: null }];
        for (const { guest } of targets) {
            const rsvpUrl = await invitationUrl(env, household.id, household.inviteVersion, guest?.id);
            if (!rsvpUrl) throw new ValidationError("Invitation links are not configured", "householdIds");
            const coupleNames = `${wedding.partnerOne} & ${wedding.partnerTwo}`;
            const greeting = guest?.name ?? household.name;
            const deadline = formatDate(rsvp.deadline);
            previews.push({
                key: `${household.id}:${guest?.id ?? "household"}`,
                householdId: household.id,
                guestId: guest?.id ?? null,
                householdName: household.name,
                guestNames: household.guests.map((person) => person.name),
                highlightedGuest: guest?.name ?? null,
                coupleNames,
                rsvpUrl,
                fallback: `${new URL(weddingOrigin(env)).host}/rsvp`,
                rsvpCode: household.rsvpCode,
                qrDataUrl: await svgDataUrl(rsvpUrl),
                eventLines,
                deadline,
                emailSubject: `You're invited to ${coupleNames}'s wedding`,
                emailBody: [
                    `Dear ${greeting},`,
                    `${coupleNames} request the pleasure of your company at their wedding.`,
                    ...eventLines,
                    `${deadline ? `Please reply by ${deadline}: ` : "RSVP: "}${rsvpUrl}`,
                    `If the link does not open, visit ${new URL(weddingOrigin(env)).host}/rsvp and enter ${household.rsvpCode}.`,
                ].join("\n\n"),
                smsBody: `${greeting}, you're invited to ${coupleNames}'s wedding. ${deadline ? `RSVP by ${deadline}: ` : "RSVP: "}${rsvpUrl}`,
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
    const statements = [];
    for (const preview of previews) {
        const version = Number(preview.rsvpUrl.match(/invite=[^.]+\.([0-9]+)/)?.[1] ?? 1);
        for (const channel of request.channels) {
            statements.push(
                env.DB.prepare(
                    `INSERT INTO invitation_artifacts (id, household_id, guest_id, recipient_key, channel, invite_version, status, created_by, created_at, updated_at)
                         VALUES (?, ?, ?, ?, ?, ?, 'generated', ?, ?, ?)
                         ON CONFLICT(household_id, recipient_key, channel, invite_version) DO UPDATE SET updated_at = excluded.updated_at`,
                ).bind(newId("inv"), preview.householdId, preview.guestId, preview.guestId ?? "household", channel, version, actor, now, now),
            );
        }
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
            changes: { householdIds: ids, channels: request.channels, guestSpecific: request.guestSpecific },
        }),
    );
    await env.DB.batch(statements);
    return { generated: previews.length, households: ids.length, channels: request.channels, sent: 0, previews };
}

const wrap = (text: string, max = 72) => {
    const words = text.split(/\s+/);
    const lines: string[] = [];
    let line = "";
    for (const word of words) {
        if (`${line} ${word}`.trim().length > max && line) (lines.push(line), (line = word));
        else line = `${line} ${word}`.trim();
    }
    if (line) lines.push(line);
    return lines;
};

export async function printableInvitations(env: Env, input: unknown): Promise<Uint8Array> {
    const request = requestSchema.parse(input);
    const previews = await invitationPreviews(env, request);
    const wedding = await getSettings(env.DB, "wedding");
    const pdf = await PDFDocument.create();
    const serif = await pdf.embedFont(StandardFonts.TimesRoman);
    const serifBold = await pdf.embedFont(StandardFonts.TimesRomanBold);
    const sans = await pdf.embedFont(StandardFonts.Helvetica);
    for (const preview of previews) {
        const page = pdf.addPage([595.28, 841.89]);
        page.drawRectangle({ x: 0, y: 0, width: 595.28, height: 841.89, color: rgb(0.988, 0.976, 0.953) });
        page.drawRectangle({ x: 28, y: 28, width: 539.28, height: 785.89, borderColor: rgb(0.55, 0.18, 0.24), borderWidth: 1 });
        const centre = (text: string, y: number, size: number, font = serif) =>
            page.drawText(text, { x: (595.28 - font.widthOfTextAtSize(text, size)) / 2, y, size, font, color: rgb(0.235, 0.165, 0.137) });
        centre("TOGETHER WITH OUR FAMILIES", 762, 9, sans);
        centre(`${wedding.partnerOne} & ${wedding.partnerTwo}`, 700, 35, serifBold);
        centre("request the pleasure of your company", 662, 15);
        centre(`Dear ${preview.highlightedGuest ?? preview.householdName}`, 614, 18, serifBold);
        let y = 574;
        for (const line of preview.eventLines.flatMap((event) => wrap(event, 66))) {
            centre(line, y, 12, sans);
            y -= 18;
        }
        if (preview.deadline) centre(`Kindly reply by ${preview.deadline}`, y - 14, 12, serifBold);

        const qr = QRCode.create(preview.rsvpUrl, { errorCorrectionLevel: "M" });
        const modules = qr.modules.size;
        const quiet = 4;
        const box = 174;
        const cell = box / (modules + quiet * 2);
        const x0 = (595.28 - box) / 2;
        const y0 = 190;
        page.drawRectangle({ x: x0, y: y0, width: box, height: box, color: rgb(1, 1, 1) });
        for (let row = 0; row < modules; row++) {
            for (let column = 0; column < modules; column++) {
                if (!qr.modules.get(row, column)) continue;
                page.drawRectangle({
                    x: x0 + (column + quiet) * cell,
                    y: y0 + box - (row + quiet + 1) * cell,
                    width: cell + 0.02,
                    height: cell + 0.02,
                    color: rgb(0.235, 0.165, 0.137),
                });
            }
        }
        centre("Scan to RSVP", 165, 13, serifBold);
        centre(`${preview.fallback}  -  code ${preview.rsvpCode}`, 142, 9, sans);
        centre(preview.guestNames.join(" • "), 106, 10, serif);
    }
    pdf.setTitle(`${wedding.partnerOne} & ${wedding.partnerTwo} - Wedding invitations`);
    pdf.setCreator("Wedding Planner Invitation Studio");
    return pdf.save();
}
