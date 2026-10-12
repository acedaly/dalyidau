// Communications: templates with merge fields, audiences, recipient snapshots and delivery.
//
// Nothing is ever sent unless BOTH the "communications.delivery" flag is on AND the Worker has a
// delivery provider configured (EMAIL_DELIVERY). Until then a message can be prepared, previewed
// per recipient and exported as a mail-merge CSV, which is enough to send through another tool.
import type { D1Database } from "@cloudflare/workers-types";
import { z } from "zod";
import { MERGE_FIELDS } from "../../src/shared/portal/merge-fields";
import { MESSAGE_CATEGORIES } from "../../src/shared/portal/types";
import type { Audience, Guest, Message, MessageRecipient, WeddingDetails } from "../../src/shared/portal/types";
import type { Env } from "../env";
import { invitationUrl } from "../wedding/invitations";
import { auditStatement, newId, nowIso, parseJson } from "./db";
import { NotFoundError, ValidationError } from "./entities";
import { isEnabled } from "./flags";
import { listGuests } from "./guests";
import { getSettings } from "./settings";

export { MERGE_FIELDS };

/** Replaces {{ field }} placeholders. Unknown fields are left visible so mistakes show in previews. */
export const renderMergeFields = (text: string, values: Record<string, string>) =>
    text.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (match, key: string) => (key in values ? values[key] : match));

export const unknownMergeFields = (text: string) => {
    const known = new Set<string>(MERGE_FIELDS.map((f) => f.key));
    return [...new Set([...text.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)].map((m) => m[1]).filter((k) => !known.has(k)))];
};

const formatDate = (iso: string) => {
    if (!iso) return "";
    const d = new Date(`${iso}T12:00:00Z`);
    return new Intl.DateTimeFormat("en-AU", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(d);
};

interface MergeContext {
    wedding: WeddingDetails;
    rsvpDeadline: string;
    fallbackRsvpLink: string;
    householdCodes: Map<string, { name: string; code: string; link: string | null }>;
}

async function mergeContext(env: Env, db: D1Database): Promise<MergeContext> {
    const [wedding, rsvp, native, households] = await Promise.all([
        getSettings(db, "wedding"),
        getSettings(db, "rsvp"),
        isEnabled(db, "rsvp.native"),
        db
            .prepare("SELECT id, name, rsvp_code, invite_version, invite_revoked_at FROM households WHERE deleted_at IS NULL")
            .all<{ id: string; name: string; rsvp_code: string; invite_version: number; invite_revoked_at: string | null }>(),
    ]);
    const site = env.SITE_URL.replace(/\/+$/, "");
    return {
        wedding,
        rsvpDeadline: formatDate(rsvp.deadline),
        fallbackRsvpLink: native ? `${site}/wedding/rsvp` : rsvp.externalUrl || `${site}/wedding`,
        householdCodes: new Map(
            await Promise.all(
                households.results.map(
                    async (h) =>
                        [
                            h.id,
                            {
                                name: h.name,
                                code: h.rsvp_code,
                                link: h.invite_revoked_at ? null : await invitationUrl(env, h.id, h.invite_version),
                            },
                        ] as const,
                ),
            ),
        ),
    };
}

const valuesFor = (guest: Pick<Guest, "firstName" | "lastName" | "householdId">, context: MergeContext): Record<string, string> => {
    const household = guest.householdId ? context.householdCodes.get(guest.householdId) : undefined;
    return {
        first_name: guest.firstName,
        last_name: guest.lastName,
        full_name: `${guest.firstName} ${guest.lastName}`.trim(),
        household_name: household?.name ?? `${guest.firstName} ${guest.lastName}`.trim(),
        rsvp_code: household?.code ?? "",
        rsvp_link: household?.link ?? context.fallbackRsvpLink,
        rsvp_deadline: context.rsvpDeadline,
        couple_names: `${context.wedding.partnerOne} & ${context.wedding.partnerTwo}`,
        wedding_date: formatDate(context.wedding.date),
    };
};

export const audienceSchema = z.object({
    rsvp: z
        .array(z.enum(["pending", "attending", "declined", "not_invited"]))
        .max(4)
        .optional(),
    eventId: z.string().max(40).nullable().optional(),
    side: z
        .array(z.enum(["partner_one", "partner_two", "shared"]))
        .max(3)
        .optional(),
    groupName: z.string().max(80).nullable().optional(),
    tag: z.string().max(40).nullable().optional(),
    guestIds: z.array(z.string().max(40)).max(2000).optional(),
    ageGroup: z
        .array(z.enum(["adult", "child", "infant"]))
        .max(3)
        .optional(),
    contactPreference: z
        .array(z.enum(["email", "post", "phone", "none"]))
        .max(4)
        .optional(),
});

export const matchesAudience = (guest: Guest, audience: Audience) => {
    if (audience.guestIds?.length && !audience.guestIds.includes(guest.id)) return false;
    if (audience.eventId && !guest.events.some((e) => e.eventId === audience.eventId)) return false;
    if (audience.rsvp?.length) {
        // With an event selected, RSVP filters apply to that event's response.
        const status = audience.eventId ? (guest.events.find((e) => e.eventId === audience.eventId)?.status ?? "not_invited") : guest.rsvp;
        if (!audience.rsvp.includes(status)) return false;
    }
    if (audience.side?.length && !audience.side.includes(guest.side)) return false;
    if (audience.groupName && guest.groupName !== audience.groupName) return false;
    if (audience.tag && !guest.tags.includes(audience.tag)) return false;
    if (audience.ageGroup?.length && !audience.ageGroup.includes(guest.ageGroup)) return false;
    if (audience.contactPreference?.length && !audience.contactPreference.includes(guest.contactPreference)) return false;
    return true;
};

export async function audiencePreview(db: D1Database, input: unknown) {
    const audience = audienceSchema.parse(input);
    const guests = (await listGuests(db)).filter((g) => matchesAudience(g, audience));
    return {
        total: guests.length,
        withEmail: guests.filter((g) => g.email).length,
        sample: guests.slice(0, 8).map((g) => ({ id: g.id, name: `${g.firstName} ${g.lastName}`.trim(), email: g.email })),
    };
}

const messageSchema = z.object({
    templateId: z.string().max(40).nullable().optional(),
    subject: z.string().trim().min(1, "Subject is required").max(200),
    body: z.string().trim().min(1, "Body is required").max(20_000),
    audience: audienceSchema,
    category: z.enum(MESSAGE_CATEGORIES).default("update"),
    scheduledAt: z
        .string()
        .nullable()
        .optional()
        .refine((value) => !value || Number.isFinite(Date.parse(value)), "Choose a valid date and time"),
});

const toMessage = (row: Record<string, unknown>): Message => ({
    id: row.id as string,
    templateId: (row.template_id as string | null) ?? null,
    subject: row.subject as string,
    body: row.body as string,
    audience: parseJson<Audience>(row.audience, {}),
    category: (row.category as Message["category"]) ?? "update",
    status: row.status as Message["status"],
    recipientCount: Number(row.recipient_count ?? 0),
    deliveryNote: (row.delivery_note as string | null) ?? null,
    createdBy: row.created_by as string,
    createdAt: row.created_at as string,
    scheduledAt: (row.scheduled_at as string | null) ?? null,
    sentAt: (row.sent_at as string | null) ?? null,
});

export async function listMessages(db: D1Database): Promise<Message[]> {
    const rows = await db.prepare("SELECT * FROM messages ORDER BY created_at DESC LIMIT 200").all<Record<string, unknown>>();
    return rows.results.map(toMessage);
}

export async function getMessage(db: D1Database, id: string): Promise<{ message: Message; recipients: MessageRecipient[] } | null> {
    const row = await db.prepare("SELECT * FROM messages WHERE id = ?").bind(id).first<Record<string, unknown>>();
    if (!row) return null;
    const recipients = await db
        .prepare("SELECT guest_id, name, email, status, error, sent_at, provider_id FROM message_recipients WHERE message_id = ? ORDER BY name COLLATE NOCASE")
        .bind(id)
        .all<Record<string, unknown>>();
    return {
        message: toMessage(row),
        recipients: recipients.results.map((r) => ({
            guestId: r.guest_id as string,
            name: r.name as string,
            email: (r.email as string | null) ?? null,
            status: r.status as MessageRecipient["status"],
            error: (r.error as string | null) ?? null,
            sentAt: (r.sent_at as string | null) ?? null,
            providerId: (r.provider_id as string | null) ?? null,
        })),
    };
}

/** Freezes the subject, body and recipient list. Guests without an email are recorded as skipped. */
export async function prepareMessage(db: D1Database, input: unknown, actor: string): Promise<Message> {
    const data = messageSchema.parse(input);
    const unknown = unknownMergeFields(`${data.subject}\n${data.body}`);
    if (unknown.length) throw new ValidationError(`Unknown merge field${unknown.length > 1 ? "s" : ""}: ${unknown.map((k) => `{{${k}}}`).join(", ")}`, "body");
    const guests = (await listGuests(db)).filter((g) => matchesAudience(g, data.audience));
    if (guests.length === 0) throw new ValidationError("No guests match this audience", "audience");
    if (data.scheduledAt && Date.parse(data.scheduledAt) <= Date.now()) throw new ValidationError("Choose a future sending time", "scheduledAt");

    const duplicateInvitations = new Set<string>();
    if (data.category === "invitation") {
        const rows = await db
            .prepare(
                `SELECT DISTINCT mr.guest_id FROM message_recipients mr JOIN messages m ON m.id = mr.message_id
                 WHERE m.category = 'invitation' AND m.status IN ('draft', 'queued', 'sending', 'sent', 'partial')
                   AND mr.status IN ('pending', 'sent')`,
            )
            .all<{ guest_id: string }>();
        for (const row of rows.results) duplicateInvitations.add(row.guest_id);
    }

    const id = newId("msg");
    const now = nowIso();
    const statements = [
        db
            .prepare(
                "INSERT INTO messages (id, template_id, subject, body, audience, category, status, recipient_count, created_by, created_at, scheduled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(
                id,
                data.templateId ?? null,
                data.subject,
                data.body,
                JSON.stringify(data.audience),
                data.category,
                data.scheduledAt ? "queued" : "draft",
                guests.length,
                actor,
                now,
                data.scheduledAt ?? null,
            ),
        ...guests.map((g) => {
            const duplicate = duplicateInvitations.has(g.id);
            const status = g.email && !duplicate ? "pending" : "skipped";
            const error = duplicate ? "Invitation already prepared or sent" : g.email ? null : "No email address";
            return db
                .prepare("INSERT INTO message_recipients (message_id, guest_id, name, email, status, error) VALUES (?, ?, ?, ?, ?, ?)")
                .bind(id, g.id, `${g.firstName} ${g.lastName}`.trim(), g.email, status, error);
        }),
        auditStatement(db, {
            actor,
            action: "message.prepare",
            entityType: "message",
            entityId: id,
            summary: `${data.scheduledAt ? "Scheduled" : "Prepared"} “${data.subject}” for ${guests.length} guests`,
            changes: { audience: data.audience, category: data.category, scheduledAt: data.scheduledAt ?? null, duplicates: duplicateInvitations.size },
        }),
    ];
    for (let i = 0; i < statements.length; i += 400) await db.batch(statements.slice(i, i + 400));
    return (await getMessage(db, id))!.message;
}

export async function previewMessage(env: Env, db: D1Database, input: { subject: string; body: string; guestId?: string | null }) {
    const guests = await listGuests(db);
    const guest = (input.guestId && guests.find((g) => g.id === input.guestId)) || guests[0];
    const context = await mergeContext(env, db);
    const sample = guest ?? { firstName: "Alex", lastName: "Example", householdId: null };
    const values = valuesFor(sample, context);
    return {
        guest: guest ? { id: guest.id, name: `${guest.firstName} ${guest.lastName}`.trim(), email: guest.email } : null,
        subject: renderMergeFields(input.subject, values),
        body: renderMergeFields(input.body, values),
        unknownFields: unknownMergeFields(`${input.subject}\n${input.body}`),
    };
}

/** Rows for a mail-merge CSV: one per recipient with an email, fully rendered. */
export async function mergeRows(env: Env, db: D1Database, messageId: string) {
    const found = await getMessage(db, messageId);
    if (!found) throw new NotFoundError("Message not found");
    const guests = new Map((await listGuests(db)).map((g) => [g.id, g]));
    const context = await mergeContext(env, db);
    return found.recipients
        .filter((r) => r.email)
        .map((r) => {
            const guest = guests.get(r.guestId);
            const values = guest ? valuesFor(guest, context) : valuesFor({ firstName: r.name, lastName: "", householdId: null }, context);
            return {
                guestId: r.guestId,
                status: r.status,
                name: r.name,
                email: r.email!,
                subject: renderMergeFields(found.message.subject, values),
                body: renderMergeFields(found.message.body, values),
                rsvpCode: values.rsvp_code,
                rsvpLink: values.rsvp_link,
            };
        });
}

// ---------------------------------------------------------------------------------------------
// Delivery

export interface DeliveryProvider {
    name: string;
    send(message: { to: string; toName: string; subject: string; text: string }): Promise<{ providerId: string | null }>;
}

const htmlForText = (text: string) => {
    const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    return escaped
        .split(/\n{2,}/)
        .map((paragraph) => `<p>${paragraph.replace(/\n/g, "<br>")}</p>`)
        .join("");
};

/** The configured provider, or null. Production remains off until EMAIL_DELIVERY changes deliberately. */
export const deliveryProvider = (env: Env): DeliveryProvider | null => {
    const mode = (env.EMAIL_DELIVERY ?? "off").trim().toLowerCase();
    if (mode === "log" && env.ENVIRONMENT !== "production") {
        return {
            name: "log",
            async send(message) {
                console.log(JSON.stringify({ event: "email_logged", to: message.to, subject: message.subject }));
                return { providerId: `log_${crypto.randomUUID()}` };
            },
        };
    }
    if (mode === "cloudflare" && env.EMAIL && env.EMAIL_FROM) {
        return {
            name: "cloudflare-email-service",
            async send(message) {
                const result = await env.EMAIL!.send({
                    to: { email: message.to, name: message.toName },
                    from: env.EMAIL_FROM!,
                    subject: message.subject,
                    text: message.text,
                    html: htmlForText(message.text),
                });
                return { providerId: result.messageId };
            },
        };
    }
    return null;
};

export async function deliveryAvailable(env: Env, db: D1Database) {
    return !!deliveryProvider(env) && (await isEnabled(db, "communications.delivery"));
}

export async function sendMessage(env: Env, db: D1Database, id: string, actor: string, scheduledOnly = false): Promise<Message> {
    const provider = deliveryProvider(env);
    if (!provider || !(await isEnabled(db, "communications.delivery"))) {
        throw new ValidationError(
            "Email delivery is switched off. Turn on “Email delivery” in Settings → Features after a provider is configured.",
            "delivery",
        );
    }
    const found = await getMessage(db, id);
    if (!found) throw new NotFoundError("Message not found");
    const sendable = scheduledOnly ? found.message.status === "queued" : found.message.status === "draft" || found.message.status === "queued";
    if (!sendable) throw new ValidationError("This message has already been sent", "status");
    if (scheduledOnly && (!found.message.scheduledAt || Date.parse(found.message.scheduledAt) > Date.now()))
        throw new ValidationError("This message is not due yet", "scheduledAt");

    // Claim the message so a double click cannot send twice.
    const claimed = await db
        .prepare(`UPDATE messages SET status = 'sending' WHERE id = ? AND status IN (${scheduledOnly ? "'queued'" : "'draft', 'queued'"}) RETURNING id`)
        .bind(id)
        .first();
    if (!claimed) throw new ValidationError("This message is already being sent", "status");

    const rows = await mergeRows(env, db, id);
    let sent = 0;
    let failed = 0;
    for (const row of rows) {
        if (row.status !== "pending") continue;
        const recipient = { guestId: row.guestId };
        try {
            const result = await provider.send({ to: row.email, toName: row.name, subject: row.subject, text: row.body });
            sent++;
            await db
                .prepare("UPDATE message_recipients SET status = 'sent', sent_at = ?, error = NULL, provider_id = ? WHERE message_id = ? AND guest_id = ?")
                .bind(nowIso(), result.providerId, id, recipient.guestId)
                .run();
        } catch (error) {
            failed++;
            await db
                .prepare("UPDATE message_recipients SET status = 'failed', error = ? WHERE message_id = ? AND guest_id = ?")
                .bind(String((error as Error).message).slice(0, 300), id, recipient.guestId)
                .run();
        }
    }
    const status = failed === 0 ? "sent" : sent === 0 ? "failed" : "partial";
    await db.batch([
        db
            .prepare("UPDATE messages SET status = ?, sent_at = ?, delivery_note = ? WHERE id = ?")
            .bind(status, nowIso(), `${sent} sent, ${failed} failed via ${provider.name}`, id),
        auditStatement(db, {
            actor,
            action: "message.send",
            entityType: "message",
            entityId: id,
            summary: `Sent “${found.message.subject}”: ${sent} delivered, ${failed} failed`,
        }),
    ]);
    return (await getMessage(db, id))!.message;
}

/** Processes the D1-backed scheduled queue. Safe to call from every cron; each message is claimed atomically. */
export async function processDueMessages(env: Env, limit = 10) {
    if (!(await deliveryAvailable(env, env.DB))) return { processed: 0 };
    const due = await env.DB.prepare("SELECT id FROM messages WHERE status = 'queued' AND scheduled_at <= ? ORDER BY scheduled_at LIMIT ?")
        .bind(nowIso(), limit)
        .all<{ id: string }>();
    let processed = 0;
    for (const row of due.results) {
        try {
            await sendMessage(env, env.DB, row.id, "system:scheduled", true);
            processed++;
        } catch (error) {
            console.error(JSON.stringify({ event: "scheduled_email_failed", messageId: row.id, message: (error as Error).message }));
        }
    }
    return { processed };
}

export async function cancelScheduledMessage(db: D1Database, id: string, actor: string) {
    const found = await getMessage(db, id);
    if (!found) throw new NotFoundError("Message not found");
    if (found.message.status !== "queued") throw new ValidationError("Only scheduled messages can be cancelled", "status");
    await db.batch([
        db.prepare("UPDATE messages SET status = 'draft', scheduled_at = NULL WHERE id = ? AND status = 'queued'").bind(id),
        auditStatement(db, {
            actor,
            action: "message.unschedule",
            entityType: "message",
            entityId: id,
            summary: `Cancelled scheduled delivery of “${found.message.subject}”`,
        }),
    ]);
    return (await getMessage(db, id))!.message;
}

export async function deleteDraft(db: D1Database, id: string, actor: string) {
    const found = await getMessage(db, id);
    if (!found) throw new NotFoundError("Message not found");
    if (!["draft", "queued"].includes(found.message.status))
        throw new ValidationError("Only drafts can be deleted; sent messages are kept as history", "status");
    await db.batch([
        db.prepare("DELETE FROM messages WHERE id = ?").bind(id),
        auditStatement(db, { actor, action: "message.delete", entityType: "message", entityId: id, summary: `Deleted draft “${found.message.subject}”` }),
    ]);
}
