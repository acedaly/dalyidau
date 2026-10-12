// Communications: templates with merge fields, audiences, recipient snapshots and delivery by email
// or SMS through provider-independent interfaces (worker/comms/providers.ts).
//
// Nothing is ever sent unless BOTH the channel's feature switch is on ("communications.delivery"
// for email, "communications.sms" for SMS) AND the Worker has that channel's provider configured
// (EMAIL_DELIVERY / SMS_DELIVERY plus credentials). Until then a message can be prepared, previewed
// per recipient and exported as a mail-merge CSV, which is enough to send through another tool.
import type { D1Database } from "@cloudflare/workers-types";
import { z } from "zod";
import { MERGE_FIELDS } from "../../src/shared/portal/merge-fields";
import { isOptOutReply, normaliseMobile, smsSegments } from "../../src/shared/portal/sms";
import { MESSAGE_CATEGORIES, MESSAGE_CHANNELS } from "../../src/shared/portal/types";
import type {
    Audience,
    Guest,
    Message,
    MessageChannel,
    MessageRecipient,
    RsvpHousehold,
    SmsMessage,
    SmsThread,
    WeddingDetails,
} from "../../src/shared/portal/types";
import { type EmailProvider, type SmsProvider, emailProvider, htmlForText, smsProvider } from "../comms/providers";
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
        withMobile: guests.filter((g) => normaliseMobile(g.phone)).length,
        sample: guests.slice(0, 8).map((g) => ({ id: g.id, name: `${g.firstName} ${g.lastName}`.trim(), email: g.email })),
    };
}

const messageSchema = z.object({
    templateId: z.string().max(40).nullable().optional(),
    subject: z.string().trim().min(1, "Subject is required").max(200),
    body: z.string().trim().min(1, "Body is required").max(20_000),
    audience: audienceSchema,
    channel: z.enum(MESSAGE_CHANNELS).default("email"),
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
    channel: ((row.channel as MessageChannel | null) ?? "email") as MessageChannel,
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
        .prepare(
            `SELECT guest_id, name, email, phone, status, error, sent_at, provider_id, attempts, delivery_status, delivered_at, cost_cents
             FROM message_recipients WHERE message_id = ? ORDER BY name COLLATE NOCASE`,
        )
        .bind(id)
        .all<Record<string, unknown>>();
    return {
        message: toMessage(row),
        recipients: recipients.results.map((r) => ({
            guestId: r.guest_id as string,
            name: r.name as string,
            email: (r.email as string | null) ?? null,
            phone: (r.phone as string | null) ?? null,
            status: r.status as MessageRecipient["status"],
            error: (r.error as string | null) ?? null,
            sentAt: (r.sent_at as string | null) ?? null,
            providerId: (r.provider_id as string | null) ?? null,
            attempts: Number(r.attempts ?? 0),
            deliveryStatus: (r.delivery_status as string | null) ?? null,
            deliveredAt: (r.delivered_at as string | null) ?? null,
            costCents: r.cost_cents === null || r.cost_cents === undefined ? null : Number(r.cost_cents),
        })),
    };
}

/** Opt-outs per guest, kept out of the Guest type so they never travel to pages that don't need them. */
async function optOuts(db: D1Database) {
    const rows = await db
        .prepare("SELECT id, email_opt_out_at, sms_opt_out_at FROM guests WHERE email_opt_out_at IS NOT NULL OR sms_opt_out_at IS NOT NULL")
        .all<{ id: string; email_opt_out_at: string | null; sms_opt_out_at: string | null }>();
    return new Map(rows.results.map((r) => [r.id, { email: !!r.email_opt_out_at, sms: !!r.sms_opt_out_at }]));
}

/** Whether a guest can receive this channel, and why not. */
const reachability = (guest: Guest, channel: MessageChannel, optedOut: { email: boolean; sms: boolean } | undefined) => {
    if (channel === "sms") {
        const phone = normaliseMobile(guest.phone);
        if (!phone) return { phone: null, error: "No mobile number" };
        if (optedOut?.sms) return { phone, error: "Opted out of texts" };
        return { phone, error: null };
    }
    if (!guest.email) return { phone: null, error: "No email address" };
    if (optedOut?.email) return { phone: null, error: "Opted out of email" };
    return { phone: null, error: null };
};

/** Freezes the subject, body and recipient list. Guests who can't be reached on the channel are recorded as skipped. */
export async function prepareMessage(db: D1Database, input: unknown, actor: string): Promise<Message> {
    const data = messageSchema.parse(input);
    const unknown = unknownMergeFields(`${data.subject}\n${data.body}`);
    if (unknown.length) throw new ValidationError(`Unknown merge field${unknown.length > 1 ? "s" : ""}: ${unknown.map((k) => `{{${k}}}`).join(", ")}`, "body");
    const guests = (await listGuests(db)).filter((g) => matchesAudience(g, data.audience));
    if (guests.length === 0) throw new ValidationError("No guests match this audience", "audience");
    if (data.scheduledAt && Date.parse(data.scheduledAt) <= Date.now()) throw new ValidationError("Choose a future sending time", "scheduledAt");
    if (data.channel === "sms" && smsSegments(data.body).segments > 6)
        throw new ValidationError("Keep text messages to six SMS parts or fewer. Link to the website for longer details.", "body");
    const consent = await optOuts(db);

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
                "INSERT INTO messages (id, template_id, subject, body, audience, channel, category, status, recipient_count, created_by, created_at, scheduled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(
                id,
                data.templateId ?? null,
                data.subject,
                data.body,
                JSON.stringify(data.audience),
                data.channel,
                data.category,
                data.scheduledAt ? "queued" : "draft",
                guests.length,
                actor,
                now,
                data.scheduledAt ?? null,
            ),
        ...guests.map((g) => {
            const duplicate = duplicateInvitations.has(g.id);
            const reach = reachability(g, data.channel, consent.get(g.id));
            const error = duplicate ? "Invitation already prepared or sent" : reach.error;
            return db
                .prepare("INSERT INTO message_recipients (message_id, guest_id, name, email, phone, status, error) VALUES (?, ?, ?, ?, ?, ?, ?)")
                .bind(
                    id,
                    g.id,
                    `${g.firstName} ${g.lastName}`.trim(),
                    data.channel === "email" ? g.email : null,
                    reach.phone,
                    error ? "skipped" : "pending",
                    error,
                );
        }),
        auditStatement(db, {
            actor,
            action: "message.prepare",
            entityType: "message",
            entityId: id,
            summary: `${data.scheduledAt ? "Scheduled" : "Prepared"} ${data.channel === "sms" ? "text" : "email"} “${data.subject}” for ${guests.length} guests`,
            changes: {
                audience: data.audience,
                channel: data.channel,
                category: data.category,
                scheduledAt: data.scheduledAt ?? null,
                duplicates: duplicateInvitations.size,
            },
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
        sms: smsSegments(renderMergeFields(input.body, values)),
    };
}

/** Rows for a mail-merge CSV: one per recipient with an email, fully rendered. */
export async function mergeRows(env: Env, db: D1Database, messageId: string) {
    const found = await getMessage(db, messageId);
    if (!found) throw new NotFoundError("Message not found");
    const guests = new Map((await listGuests(db)).map((g) => [g.id, g]));
    const context = await mergeContext(env, db);
    return found.recipients
        .filter((r) => (found.message.channel === "sms" ? r.phone : r.email))
        .map((r) => {
            const guest = guests.get(r.guestId);
            const values = guest ? valuesFor(guest, context) : valuesFor({ firstName: r.name, lastName: "", householdId: null }, context);
            return {
                guestId: r.guestId,
                status: r.status,
                name: r.name,
                email: r.email ?? "",
                phone: r.phone ?? "",
                subject: renderMergeFields(found.message.subject, values),
                body: renderMergeFields(found.message.body, values),
                rsvpCode: values.rsvp_code,
                rsvpLink: values.rsvp_link,
            };
        });
}

// ---------------------------------------------------------------------------------------------
// Delivery

/** Kept for existing callers: the configured email provider. */
export const deliveryProvider = emailProvider;

const CHANNEL_FLAG = { email: "communications.delivery", sms: "communications.sms" } as const;

/** Both safeguards for a channel: its feature switch and a configured provider. */
export async function deliveryAvailable(env: Env, db: D1Database, channel: MessageChannel = "email") {
    const provider = channel === "sms" ? smsProvider(env) : emailProvider(env);
    return !!provider && (await isEnabled(db, CHANNEL_FLAG[channel]));
}

async function providerFor(env: Env, db: D1Database, channel: MessageChannel): Promise<EmailProvider | SmsProvider> {
    const provider = channel === "sms" ? smsProvider(env) : emailProvider(env);
    if (!provider || !(await isEnabled(db, CHANNEL_FLAG[channel]))) {
        throw new ValidationError(
            channel === "sms"
                ? "SMS delivery is switched off. Turn on “SMS delivery” in Settings → Features after an SMS provider is configured."
                : "Email delivery is switched off. Turn on “Email delivery” in Settings → Features after a provider is configured.",
            "delivery",
        );
    }
    return provider;
}

/** A simple, warm HTML version of a plain-text wedding email. Every character of the text is escaped. */
export const weddingEmailHtml = (text: string, wedding: WeddingDetails) => {
    const names = htmlForText(`${wedding.partnerOne} & ${wedding.partnerTwo}`).replace(/<\/?p>/g, "");
    return `<!doctype html><html><body style="margin:0;background:#f8f5ee;padding:32px 16px;font-family:Georgia,'Times New Roman',serif;color:#35332e">
<div style="max-width:560px;margin:0 auto;background:#fcfaf5;border:1px solid #e2d9c8;padding:40px 32px">
<p style="margin:0 0 24px;text-align:center;font-size:28px;color:#354c3e">${names}</p>
<div style="font-size:16px;line-height:1.7">${htmlForText(text).replace(/<p>/g, '<p style="margin:0 0 16px">')}</div>
</div></body></html>`;
};

async function deliver(
    provider: EmailProvider | SmsProvider,
    row: { email: string; phone: string; name: string; subject: string; body: string },
    reference: string,
    wedding: WeddingDetails,
) {
    if (provider.channel === "sms") return provider.send({ to: row.phone, body: row.body, reference });
    const result = await provider.send({
        to: row.email,
        toName: row.name,
        subject: row.subject,
        text: row.body,
        html: weddingEmailHtml(row.body, wedding),
        reference,
    });
    return { ...result, costCents: null };
}

const MAX_ATTEMPTS = 3;

export async function sendMessage(env: Env, db: D1Database, id: string, actor: string, scheduledOnly = false): Promise<Message> {
    const found = await getMessage(db, id);
    if (!found) throw new NotFoundError("Message not found");
    const provider = await providerFor(env, db, found.message.channel);
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

    const [rows, wedding, consent] = await Promise.all([mergeRows(env, db, id), getSettings(db, "wedding"), optOuts(db)]);
    let sent = 0;
    let failed = 0;
    for (const row of rows) {
        if (row.status !== "pending") continue;
        // Consent can change between preparing and sending (a STOP reply, an unsubscribe).
        const opted = consent.get(row.guestId);
        if (found.message.channel === "sms" ? opted?.sms : opted?.email) {
            await db
                .prepare("UPDATE message_recipients SET status = 'skipped', error = ? WHERE message_id = ? AND guest_id = ?")
                .bind(found.message.channel === "sms" ? "Opted out of texts" : "Opted out of email", id, row.guestId)
                .run();
            continue;
        }
        const now = nowIso();
        try {
            const result = await deliver(provider, row, `${id}:${row.guestId}`, wedding);
            sent++;
            const statements = [
                db
                    .prepare(
                        "UPDATE message_recipients SET status = 'sent', sent_at = ?, error = NULL, provider_id = ?, cost_cents = ?, attempts = attempts + 1 WHERE message_id = ? AND guest_id = ?",
                    )
                    .bind(now, result.providerId, result.costCents, id, row.guestId),
            ];
            if (provider.channel === "sms")
                statements.push(
                    smsLogStatement(db, { ...row, status: "sent", providerId: result.providerId, costCents: result.costCents, messageId: id, actor }),
                );
            await db.batch(statements);
        } catch (error) {
            failed++;
            await db
                .prepare("UPDATE message_recipients SET status = 'failed', error = ?, attempts = attempts + 1 WHERE message_id = ? AND guest_id = ?")
                .bind(String((error as Error).message).slice(0, 300), id, row.guestId)
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
            summary: `Sent ${found.message.channel === "sms" ? "text" : "email"} “${found.message.subject}”: ${sent} delivered, ${failed} failed`,
        }),
    ]);
    return (await getMessage(db, id))!.message;
}

/** Tries failed recipients again (up to three attempts each), e.g. after a provider outage. */
export async function retryFailed(env: Env, db: D1Database, id: string, actor: string): Promise<Message> {
    const found = await getMessage(db, id);
    if (!found) throw new NotFoundError("Message not found");
    await providerFor(env, db, found.message.channel);
    if (!["partial", "failed"].includes(found.message.status)) throw new ValidationError("Only messages with failed recipients can be retried", "status");
    const retry = found.recipients.filter((r) => r.status === "failed" && r.attempts < MAX_ATTEMPTS);
    if (!retry.length) throw new ValidationError(`Every failed recipient has already been tried ${MAX_ATTEMPTS} times`, "status");
    // Reset atomically: only one retry can win the claim on the message.
    const claimed = await db.prepare("UPDATE messages SET status = 'draft' WHERE id = ? AND status IN ('partial', 'failed') RETURNING id").bind(id).first();
    if (!claimed) throw new ValidationError("This message is already being retried", "status");
    await db.batch([
        db
            .prepare("UPDATE message_recipients SET status = 'pending', error = NULL WHERE message_id = ? AND status = 'failed' AND attempts < ?")
            .bind(id, MAX_ATTEMPTS),
        auditStatement(db, {
            actor,
            action: "message.retry",
            entityType: "message",
            entityId: id,
            summary: `Retrying ${retry.length} failed recipient${retry.length === 1 ? "" : "s"} of “${found.message.subject}”`,
        }),
    ]);
    return sendMessage(env, db, id, actor);
}

/** Processes the D1-backed scheduled queue. Safe to call from every cron; each message is claimed atomically. */
export async function processDueMessages(env: Env, limit = 10) {
    const [email, sms] = await Promise.all([deliveryAvailable(env, env.DB, "email"), deliveryAvailable(env, env.DB, "sms")]);
    const channels = [email && "'email'", sms && "'sms'"].filter(Boolean);
    if (!channels.length) return { processed: 0 };
    const due = await env.DB.prepare(
        `SELECT id FROM messages WHERE status = 'queued' AND scheduled_at <= ? AND channel IN (${channels.join(", ")}) ORDER BY scheduled_at LIMIT ?`,
    )
        .bind(nowIso(), limit)
        .all<{ id: string }>();
    let processed = 0;
    for (const row of due.results) {
        try {
            await sendMessage(env, env.DB, row.id, "system:scheduled", true);
            processed++;
        } catch (error) {
            console.error(JSON.stringify({ event: "scheduled_message_failed", messageId: row.id, message: (error as Error).message }));
        }
    }
    return { processed };
}

// ---------------------------------------------------------------------------------------------
// RSVP confirmation email

/**
 * Emails a confirmation after an online RSVP. Needs the RSVP setting, the email switch and a
 * provider; returns false (and never throws) otherwise, so a reply is never lost to an email problem.
 * The email is recorded in message history like any other.
 */
export async function sendRsvpConfirmation(env: Env, db: D1Database, household: { id: string; name: string }, result: RsvpHousehold, to: string) {
    try {
        const settings = await getSettings(db, "rsvp");
        if (!settings.confirmationEmail || !(await deliveryAvailable(env, db, "email"))) return false;
        const provider = emailProvider(env)!;
        const wedding = await getSettings(db, "wedding");
        const lines = result.guests.map((guest) => {
            const events = result.events
                .filter((event) => result.responses[guest.id]?.[event.id])
                .map((event) => `${event.name}: ${result.responses[guest.id][event.id] === "attending" ? "attending" : "not attending"}`);
            return `${guest.firstName} ${guest.lastName}`.trim() + (events.length ? ` (${events.join(", ")})` : "");
        });
        const coming = result.guests.some((guest) => Object.values(result.responses[guest.id] ?? {}).includes("attending"));
        const couple = `${wedding.partnerOne} & ${wedding.partnerTwo}`;
        const site = env.SITE_URL.replace(/\/+$/, "");
        const subject = `Your RSVP for ${couple}'s wedding`;
        const body = [
            `Hi ${result.householdName},`,
            coming ? "Thank you for your RSVP. We can't wait to celebrate with you!" : "Thank you for letting us know. We'll miss you.",
            `Here's what we have:\n${lines.map((line) => `• ${line}`).join("\n")}`,
            `If anything changes, you can update your RSVP using the link in your invitation${settings.deadline ? ` until ${formatDate(settings.deadline)}` : ""}. Wedding details are at ${site}/wedding.`,
            `Love,\n${couple}`,
        ].join("\n\n");
        const id = newId("msg");
        const now = nowIso();
        let providerId: string | null = null;
        let error: string | null = null;
        try {
            providerId = (
                await provider.send({
                    to,
                    toName: result.householdName,
                    subject,
                    text: body,
                    html: weddingEmailHtml(body, wedding),
                    reference: `${id}:${household.id}`,
                })
            ).providerId;
        } catch (e) {
            error = String((e as Error).message).slice(0, 300);
        }
        await db.batch([
            db
                .prepare(
                    `INSERT INTO messages (id, subject, body, audience, channel, category, status, recipient_count, delivery_note, created_by, created_at, sent_at)
                     VALUES (?, ?, ?, '{}', 'email', 'rsvp_confirmation', ?, 1, ?, ?, ?, ?)`,
                )
                .bind(
                    id,
                    subject,
                    body,
                    error ? "failed" : "sent",
                    `${error ? "0 sent, 1 failed" : "1 sent, 0 failed"} via ${provider.name}`,
                    `rsvp:${household.id}`,
                    now,
                    now,
                ),
            // Confirmations go to the household, so the recipient row uses the household id.
            db
                .prepare(
                    "INSERT INTO message_recipients (message_id, guest_id, name, email, status, error, sent_at, provider_id, attempts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)",
                )
                .bind(id, household.id, household.name, to, error ? "failed" : "sent", error, error ? null : now, providerId),
        ]);
        return !error;
    } catch (e) {
        console.error(JSON.stringify({ event: "rsvp_confirmation_failed", message: (e as Error).message }));
        return false;
    }
}

// ---------------------------------------------------------------------------------------------
// SMS conversations

function smsLogStatement(
    db: D1Database,
    input: {
        phone: string;
        guestId?: string | null;
        householdId?: string | null;
        body: string;
        status: SmsMessage["status"];
        providerId?: string | null;
        costCents?: number | null;
        error?: string | null;
        messageId?: string | null;
        actor: string;
        direction?: SmsMessage["direction"];
    },
) {
    return db
        .prepare(
            `INSERT INTO sms_messages (id, direction, phone, guest_id, household_id, body, status, provider_id, cost_cents, error, message_id, created_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
            newId("sms"),
            input.direction ?? "outbound",
            input.phone,
            input.guestId ?? null,
            input.householdId ?? null,
            input.body,
            input.status,
            input.providerId ?? null,
            input.costCents ?? null,
            input.error ?? null,
            input.messageId ?? null,
            input.actor,
            nowIso(),
        );
}

const toSms = (r: Record<string, unknown>): SmsMessage => ({
    id: r.id as string,
    direction: r.direction as SmsMessage["direction"],
    phone: r.phone as string,
    guestId: (r.guest_id as string | null) ?? null,
    householdId: (r.household_id as string | null) ?? null,
    body: r.body as string,
    status: r.status as SmsMessage["status"],
    providerId: (r.provider_id as string | null) ?? null,
    costCents: r.cost_cents === null || r.cost_cents === undefined ? null : Number(r.cost_cents),
    error: (r.error as string | null) ?? null,
    messageId: (r.message_id as string | null) ?? null,
    createdBy: r.created_by as string,
    createdAt: r.created_at as string,
    readAt: (r.read_at as string | null) ?? null,
});

/** Guests by normalised mobile number, for matching replies and labelling threads. */
async function guestsByPhone(db: D1Database) {
    const rows = await db
        .prepare(
            `SELECT g.id, g.first_name, g.last_name, g.phone, g.household_id, g.sms_opt_out_at, h.name AS household_name
             FROM guests g LEFT JOIN households h ON h.id = g.household_id WHERE g.deleted_at IS NULL AND g.phone IS NOT NULL`,
        )
        .all<{
            id: string;
            first_name: string;
            last_name: string;
            phone: string;
            household_id: string | null;
            sms_opt_out_at: string | null;
            household_name: string | null;
        }>();
    const map = new Map<string, typeof rows.results>();
    for (const row of rows.results) {
        const phone = normaliseMobile(row.phone);
        if (phone) map.set(phone, [...(map.get(phone) ?? []), row]);
    }
    return map;
}

export async function listSmsThreads(db: D1Database): Promise<SmsThread[]> {
    const [rows, unread, people] = await Promise.all([
        db
            .prepare(
                `SELECT s.* FROM sms_messages s JOIN (SELECT phone, MAX(created_at) AS latest FROM sms_messages GROUP BY phone) t
                 ON t.phone = s.phone AND t.latest = s.created_at ORDER BY s.created_at DESC LIMIT 300`,
            )
            .all<Record<string, unknown>>(),
        db
            .prepare("SELECT phone, COUNT(*) AS n FROM sms_messages WHERE direction = 'inbound' AND read_at IS NULL GROUP BY phone")
            .all<{ phone: string; n: number }>(),
        guestsByPhone(db),
    ]);
    const unreadBy = new Map(unread.results.map((r) => [r.phone, Number(r.n)]));
    const seen = new Set<string>();
    return rows.results.flatMap((row) => {
        const last = toSms(row);
        if (seen.has(last.phone)) return [];
        seen.add(last.phone);
        const guests = people.get(last.phone) ?? [];
        return [
            {
                phone: last.phone,
                guests: guests.map((g) => ({ id: g.id, name: `${g.first_name} ${g.last_name}`.trim(), householdName: g.household_name })),
                last,
                unread: unreadBy.get(last.phone) ?? 0,
                optedOut: guests.some((g) => g.sms_opt_out_at),
            },
        ];
    });
}

export async function smsConversation(db: D1Database, rawPhone: string, actor: string) {
    const phone = normaliseMobile(rawPhone);
    if (!phone) throw new ValidationError("That isn't a mobile number", "phone");
    const rows = await db.prepare("SELECT * FROM sms_messages WHERE phone = ? ORDER BY created_at LIMIT 500").bind(phone).all<Record<string, unknown>>();
    const marked = await db
        .prepare("UPDATE sms_messages SET read_at = ? WHERE phone = ? AND direction = 'inbound' AND read_at IS NULL")
        .bind(nowIso(), phone)
        .run();
    if (marked.meta.changes)
        await auditStatement(db, { actor, action: "sms.read", entityType: "sms", entityId: phone.slice(0, -3) + "***", summary: "Read text replies" }).run();
    const guests = (await guestsByPhone(db)).get(phone) ?? [];
    return {
        phone,
        messages: rows.results.map(toSms),
        guests: guests.map((g) => ({ id: g.id, name: `${g.first_name} ${g.last_name}`.trim(), householdName: g.household_name })),
        optedOut: guests.some((g) => g.sms_opt_out_at),
    };
}

const replySchema = z.object({ phone: z.string().max(40), body: z.string().trim().min(1, "Write a message").max(918) });

/** A manual one-off text, e.g. answering a guest's reply. Same safeguards as campaigns. */
export async function sendSmsReply(env: Env, db: D1Database, input: unknown, actor: string): Promise<SmsMessage> {
    const data = replySchema.parse(input);
    const phone = normaliseMobile(data.phone);
    if (!phone) throw new ValidationError("That isn't a mobile number", "phone");
    const provider = (await providerFor(env, db, "sms")) as SmsProvider;
    const guests = (await guestsByPhone(db)).get(phone) ?? [];
    if (guests.some((g) => g.sms_opt_out_at)) throw new ValidationError("This number has opted out of texts", "phone");
    const id = newId("sms");
    let providerId: string | null = null;
    let costCents: number | null = null;
    let error: string | null = null;
    try {
        ({ providerId, costCents } = await provider.send({ to: phone, body: data.body, reference: id }));
    } catch (e) {
        error = String((e as Error).message).slice(0, 300);
    }
    const now = nowIso();
    await db.batch([
        db
            .prepare(
                `INSERT INTO sms_messages (id, direction, phone, guest_id, household_id, body, status, provider_id, cost_cents, error, created_by, created_at)
                 VALUES (?, 'outbound', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
                id,
                phone,
                guests[0]?.id ?? null,
                guests[0]?.household_id ?? null,
                data.body,
                error ? "failed" : "sent",
                providerId,
                costCents,
                error,
                actor,
                now,
            ),
        auditStatement(db, {
            actor,
            action: "sms.send",
            entityType: "sms",
            entityId: id,
            summary: `${error ? "Failed to send" : "Sent"} a text to ${guests[0] ? `${guests[0].first_name} ${guests[0].last_name}`.trim() : "a guest"}`,
        }),
    ]);
    if (error) throw new ValidationError(`The text wasn't sent: ${error}`, "body");
    return toSms((await db.prepare("SELECT * FROM sms_messages WHERE id = ?").bind(id).first<Record<string, unknown>>())!);
}

/** Records an inbound text (from the provider webhook) and honours STOP replies. */
export async function receiveSms(db: D1Database, input: { from: string; body: string; providerId: string | null }) {
    const phone = normaliseMobile(input.from) ?? input.from.slice(0, 20);
    const guests = (await guestsByPhone(db)).get(phone) ?? [];
    const now = nowIso();
    const statements = [
        smsLogStatement(db, {
            phone,
            guestId: guests[0]?.id ?? null,
            householdId: guests[0]?.household_id ?? null,
            body: input.body.slice(0, 2000),
            status: "received",
            providerId: input.providerId,
            actor: "system:webhook",
            direction: "inbound",
        }),
    ];
    if (isOptOutReply(input.body) && guests.length) {
        for (const guest of guests)
            statements.push(db.prepare("UPDATE guests SET sms_opt_out_at = COALESCE(sms_opt_out_at, ?) WHERE id = ?").bind(now, guest.id));
        statements.push(
            auditStatement(db, {
                actor: "system:webhook",
                action: "consent.sms_opt_out",
                entityType: "guest",
                entityId: guests[0].id,
                summary: `${guests.map((g) => g.first_name).join(" and ")} opted out of texts`,
            }),
        );
    }
    await db.batch(statements);
    return { matched: guests.length > 0 };
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
