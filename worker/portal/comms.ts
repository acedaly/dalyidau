// Communications: templates with merge fields, audiences, recipient snapshots and delivery.
//
// Nothing is ever sent unless BOTH the "communications.delivery" flag is on AND the Worker has a
// delivery provider configured (EMAIL_DELIVERY). Until then a message can be prepared, previewed
// per recipient and exported as a mail-merge CSV, which is enough to send through another tool.
import type { D1Database } from "@cloudflare/workers-types";
import { z } from "zod";
import { MERGE_FIELDS } from "../../src/shared/portal/merge-fields";
import type { Audience, Guest, Message, MessageRecipient, WeddingDetails } from "../../src/shared/portal/types";
import type { Env } from "../env";
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
    rsvpLink: (code: string | null) => string;
    householdCodes: Map<string, { name: string; code: string }>;
}

async function mergeContext(env: Env, db: D1Database): Promise<MergeContext> {
    const [wedding, rsvp, native, households] = await Promise.all([
        getSettings(db, "wedding"),
        getSettings(db, "rsvp"),
        isEnabled(db, "rsvp.native"),
        db.prepare("SELECT id, name, rsvp_code FROM households WHERE deleted_at IS NULL").all<{ id: string; name: string; rsvp_code: string }>(),
    ]);
    const site = env.SITE_URL.replace(/\/+$/, "");
    return {
        wedding,
        rsvpDeadline: formatDate(rsvp.deadline),
        rsvpLink: (code) => (native ? `${site}/wedding/rsvp${code ? `?code=${encodeURIComponent(code)}` : ""}` : rsvp.externalUrl || `${site}/wedding`),
        householdCodes: new Map(households.results.map((h) => [h.id, { name: h.name, code: h.rsvp_code }])),
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
        rsvp_link: context.rsvpLink(household?.code ?? null),
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
});

const toMessage = (row: Record<string, unknown>): Message => ({
    id: row.id as string,
    templateId: (row.template_id as string | null) ?? null,
    subject: row.subject as string,
    body: row.body as string,
    audience: parseJson<Audience>(row.audience, {}),
    status: row.status as Message["status"],
    recipientCount: Number(row.recipient_count ?? 0),
    deliveryNote: (row.delivery_note as string | null) ?? null,
    createdBy: row.created_by as string,
    createdAt: row.created_at as string,
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
        .prepare("SELECT guest_id, name, email, status, error, sent_at FROM message_recipients WHERE message_id = ? ORDER BY name COLLATE NOCASE")
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

    const id = newId("msg");
    const now = nowIso();
    const statements = [
        db
            .prepare(
                "INSERT INTO messages (id, template_id, subject, body, audience, status, recipient_count, created_by, created_at) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?)",
            )
            .bind(id, data.templateId ?? null, data.subject, data.body, JSON.stringify(data.audience), guests.length, actor, now),
        ...guests.map((g) =>
            db
                .prepare("INSERT INTO message_recipients (message_id, guest_id, name, email, status, error) VALUES (?, ?, ?, ?, ?, ?)")
                .bind(id, g.id, `${g.firstName} ${g.lastName}`.trim(), g.email, g.email ? "pending" : "skipped", g.email ? null : "No email address"),
        ),
        auditStatement(db, {
            actor,
            action: "message.prepare",
            entityType: "message",
            entityId: id,
            summary: `Prepared “${data.subject}” for ${guests.length} guests`,
            changes: { audience: data.audience },
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
    send(message: { to: string; toName: string; subject: string; text: string }): Promise<void>;
}

/**
 * The configured provider, or null. Only "log" exists today, and only outside production: it writes
 * the message to the Worker log instead of sending it, which is how delivery is exercised in tests
 * and local development. A real provider (Cloudflare Email Service) is a documented next step and
 * needs the owner's approval before it is configured.
 */
export const deliveryProvider = (env: Env): DeliveryProvider | null => {
    const mode = (env.EMAIL_DELIVERY ?? "off").trim().toLowerCase();
    if (mode === "log" && env.ENVIRONMENT !== "production") {
        return {
            name: "log",
            async send(message) {
                console.log(JSON.stringify({ event: "email_logged", to: message.to, subject: message.subject }));
            },
        };
    }
    return null;
};

export async function deliveryAvailable(env: Env, db: D1Database) {
    return !!deliveryProvider(env) && (await isEnabled(db, "communications.delivery"));
}

export async function sendMessage(env: Env, db: D1Database, id: string, actor: string): Promise<Message> {
    const provider = deliveryProvider(env);
    if (!provider || !(await isEnabled(db, "communications.delivery"))) {
        throw new ValidationError(
            "Email delivery is switched off. Turn on “Email delivery” in Settings → Features after a provider is configured.",
            "delivery",
        );
    }
    const found = await getMessage(db, id);
    if (!found) throw new NotFoundError("Message not found");
    if (found.message.status !== "draft") throw new ValidationError("This message has already been sent", "status");

    // Claim the message so a double click cannot send twice.
    const claimed = await db.prepare("UPDATE messages SET status = 'sending' WHERE id = ? AND status = 'draft' RETURNING id").bind(id).first();
    if (!claimed) throw new ValidationError("This message is already being sent", "status");

    const rows = await mergeRows(env, db, id);
    let sent = 0;
    let failed = 0;
    for (const row of rows) {
        if (row.status !== "pending") continue;
        const recipient = { guestId: row.guestId };
        try {
            await provider.send({ to: row.email, toName: row.name, subject: row.subject, text: row.body });
            sent++;
            await db
                .prepare("UPDATE message_recipients SET status = 'sent', sent_at = ?, error = NULL WHERE message_id = ? AND guest_id = ?")
                .bind(nowIso(), id, recipient.guestId)
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

export async function deleteDraft(db: D1Database, id: string, actor: string) {
    const found = await getMessage(db, id);
    if (!found) throw new NotFoundError("Message not found");
    if (found.message.status !== "draft") throw new ValidationError("Only drafts can be deleted; sent messages are kept as history", "status");
    await db.batch([
        db.prepare("DELETE FROM messages WHERE id = ?").bind(id),
        auditStatement(db, { actor, action: "message.delete", entityType: "message", entityId: id, summary: `Deleted draft “${found.message.subject}”` }),
    ]);
}
