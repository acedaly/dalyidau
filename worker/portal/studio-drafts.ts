// From Invitation Studio to Communications: turns the households selected in the Studio into one
// reviewable draft per channel (email, SMS), never a send. Each draft is addressed exactly to the
// Studio selection (a "specific" audience, so nothing else can be added), keeps the Studio's
// template, wording and household addressing, and uses each household's own signed RSVP link.
//
// Preparing again for households that already have any unsent invitation draft is refused, so
// drafts can't pile up; "replace" swaps the old draft for a new one, and only ever an unsent draft
// that covers no other households. Sent invitations are history and are never touched. A resend is
// a separate, explicit choice and remains a draft until the send check is confirmed.
import type { D1Database } from "@cloudflare/workers-types";
import { z } from "zod";
import { studioInvitationCopy } from "../../src/shared/portal/campaigns";
import type { Message } from "../../src/shared/portal/types";
import type { Env } from "../env";
import { alreadyContacted } from "./campaigns";
import { prepareMessage } from "./comms";
import { auditStatement, placeholders } from "./db";
import { ValidationError } from "./entities";
import { invitationPreviews } from "./invitation-studio";
import { getSettings } from "./settings";

const schema = z.object({
    householdIds: z.array(z.string().max(40)).min(1, "Choose at least one household").max(1000),
    delivery: z.enum(["household", "individual"]).default("household"),
    channels: z
        .array(z.enum(["email", "sms"]))
        .min(1, "Choose email or SMS")
        .max(2),
    /** Attach each household's printable invitation to the email. */
    attachPdf: z.boolean().default(false),
    /** Deliberately prepare another invitation after one was already sent on this channel. */
    resend: z.boolean().default(false),
    replace: z.boolean().default(false),
});

export interface StudioDraftConflict {
    messageId: string;
    channel: "email" | "sms";
    subject: string;
    households: number;
    /** Households in the draft that aren't in this selection; such a draft is never replaced automatically. */
    others: number;
}

export interface StudioSentConflict {
    channel: "email" | "sms";
    householdIds: string[];
}

/** Unsent invitation drafts that include any of these households. */
async function pendingStudioDrafts(db: D1Database, householdIds: string[], channels: string[]): Promise<StudioDraftConflict[]> {
    const rows = await db
        .prepare(
            `SELECT m.id, m.channel, m.subject, mr.household_id FROM messages m JOIN message_recipients mr ON mr.message_id = m.id
             WHERE m.category = 'invitation' AND m.status IN ('draft', 'queued') AND m.channel IN (${placeholders(channels.length)})
               AND mr.household_id IS NOT NULL`,
        )
        .bind(...channels)
        .all<{ id: string; channel: "email" | "sms"; subject: string; household_id: string }>();
    const wanted = new Set(householdIds);
    const byMessage = new Map<string, { channel: "email" | "sms"; subject: string; households: Set<string> }>();
    for (const row of rows.results) {
        const entry = byMessage.get(row.id) ?? { channel: row.channel, subject: row.subject, households: new Set<string>() };
        entry.households.add(row.household_id);
        byMessage.set(row.id, entry);
    }
    return [...byMessage]
        .filter(([, entry]) => [...entry.households].some((id) => wanted.has(id)))
        .map(([messageId, entry]) => ({
            messageId,
            channel: entry.channel,
            subject: entry.subject,
            households: entry.households.size,
            others: [...entry.households].filter((id) => !wanted.has(id)).length,
        }));
}

/** Selected households that have actually been sent an invitation on each selected channel. */
async function previouslySent(db: D1Database, householdIds: string[], channels: ("email" | "sms")[]): Promise<StudioSentConflict[]> {
    const conflicts: StudioSentConflict[] = [];
    for (const channel of channels) {
        const contacted = await alreadyContacted(db, "invitation", channel, "sent");
        const sent = householdIds.filter((id) => contacted.households.has(id));
        if (sent.length) conflicts.push({ channel, householdIds: sent });
    }
    return conflicts;
}

export async function prepareStudioDrafts(
    env: Env,
    db: D1Database,
    input: unknown,
    actor: string,
): Promise<{ drafts: Message[]; conflicts: StudioDraftConflict[]; sent: StudioSentConflict[] }> {
    const data = schema.parse(input);
    const householdIds = [...new Set(data.householdIds)];
    // The same checks as generating: every household exists, has someone invited and a working link.
    const previews = await invitationPreviews(env, { householdIds, delivery: data.delivery, channels: ["print"] });

    const [conflicts, sent] = await Promise.all([pendingStudioDrafts(db, householdIds, data.channels), previouslySent(db, householdIds, data.channels)]);
    if (conflicts.length && !data.replace) return { drafts: [], conflicts, sent };
    // Do not delete an existing draft until the person has also explicitly chosen to prepare a
    // resend. This matters when a household has both sent history and a newer unsent draft.
    if (sent.length && !data.resend) return { drafts: [], conflicts, sent };
    const blocked = conflicts.filter((c) => c.others > 0);
    if (blocked.length)
        throw new ValidationError(
            `A draft also includes ${blocked[0].others} household${blocked[0].others === 1 ? "" : "s"} you haven't selected. Open it in Communications and delete it, or select those households too.`,
            "replace",
        );
    for (const conflict of conflicts) {
        // Only an unsent draft is ever replaced; anything already sent stays as history.
        const removed = await db
            .prepare(
                `DELETE FROM messages WHERE id = ? AND status IN ('draft', 'queued')
                 AND NOT EXISTS (SELECT 1 FROM message_recipients WHERE message_id = messages.id AND status IN ('sent', 'failed')) RETURNING id`,
            )
            .bind(conflict.messageId)
            .first();
        if (!removed) throw new ValidationError("A draft has started sending or has history, so it can't be replaced. Open it in Communications.", "replace");
        await auditStatement(db, {
            actor,
            action: "message.delete",
            entityType: "message",
            entityId: conflict.messageId,
            summary: `Replaced the unsent ${conflict.channel === "sms" ? "text" : "email"} invitation draft “${conflict.subject}” with a new one from Invitation Studio`,
        }).run();
    }

    const template = await getSettings(db, "invitation");
    const copy = studioInvitationCopy(template);
    // Individual invitations go to exactly the invited guests the Studio made them for.
    const guestIds = data.delivery === "individual" ? previews.flatMap((p) => (p.guestId ? [p.guestId] : [])) : [];
    const drafts: Message[] = [];
    for (const channel of data.channels)
        drafts.push(
            await prepareMessage(
                env,
                db,
                {
                    subject: copy.subject,
                    body: channel === "sms" ? copy.smsBody : copy.body,
                    channel,
                    category: "invitation",
                    audience: data.delivery === "individual" ? { mode: "specific", guestIds } : { mode: "specific", householdIds },
                    individualDelivery: data.delivery === "individual",
                    attachPdf: channel === "email" && data.attachPdf,
                    source: "invitation-studio",
                    resend: data.resend,
                },
                actor,
            ),
        );
    return { drafts, conflicts: [], sent: [] };
}
