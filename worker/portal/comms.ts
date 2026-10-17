// Communications: campaigns and one-off messages by email or SMS through provider-independent
// interfaces (worker/comms/providers.ts). The rules for who a campaign reaches and what each
// household's copy says live in ./campaigns.ts.
//
// Nothing is ever sent unless BOTH the channel's feature switch is on ("communications.delivery"
// for email, "communications.sms" for SMS) AND the Worker has that channel's provider configured
// (EMAIL_DELIVERY / SMS_DELIVERY plus credentials). Until then a message can be prepared, previewed
// per household, tested to the owner-approved test addresses and exported as a mail-merge CSV.
import type { D1Database } from "@cloudflare/workers-types";
import { z } from "zod";
import { CAMPAIGNS, EXCLUSION_REASONS, isCampaignKind } from "../../src/shared/portal/campaigns";
import { MERGE_FIELDS, renderMergeFields, usedMergeFields } from "../../src/shared/portal/merge-fields";
import { normaliseMobile } from "../../src/shared/portal/phone";
import { isOptOutReply, smsSegments } from "../../src/shared/portal/sms";
import { MESSAGE_CATEGORIES, MESSAGE_CHANNELS } from "../../src/shared/portal/types";
import type {
    Audience,
    Guest,
    Message,
    MessageChannel,
    MessageOptions,
    MessagePreflight,
    MessageRecipient,
    RsvpHousehold,
    SmsMessage,
    SmsThread,
} from "../../src/shared/portal/types";
import { type EmailAttachment, type EmailProvider, type SmsProvider, emailProvider, smsProvider } from "../comms/providers";
import { stationeryEmailHtml } from "../comms/stationery";
import type { Env } from "../env";
import { weddingOrigin } from "../wedding/invitations";
import {
    type CampaignContext,
    type Consent,
    type ContactState,
    KNOWN_FIELDS,
    alreadyContacted,
    campaignContext,
    contactedReason,
    copyProblems,
    formatLongDate,
    householdBlock,
    isHouseholdCampaign,
    oncePerHousehold,
    optOuts,
    reachGuest,
    reachHousehold,
    recentlyReminded,
    reminderHouseholds,
    renderCopy,
} from "./campaigns";
import { auditStatement, newId, nowIso, parseJson } from "./db";
import { ConflictError, NotFoundError, ValidationError } from "./entities";
import { isEnabled } from "./flags";
import { listGuests } from "./guests";
import { type StudioData, loadStudioData, printableInvitations } from "./invitation-studio";
import { getSettings } from "./settings";

export { MERGE_FIELDS, renderMergeFields };

export const unknownMergeFields = (text: string) => usedMergeFields(text).filter((key) => !KNOWN_FIELDS.has(key));

const ids = z.array(z.string().max(40)).max(2000);

export const audienceSchema = z.object({
    mode: z.enum(["specific", "filtered", "all"]).optional(),
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
    guestIds: ids.optional(),
    householdIds: ids.optional(),
    reminder: z
        .array(z.enum(["not_started", "partial", "follow_up"]))
        .max(3)
        .optional(),
    ageGroup: z
        .array(z.enum(["adult", "child", "infant"]))
        .max(3)
        .optional(),
    contactPreference: z
        .array(z.enum(["email", "post", "phone", "none"]))
        .max(4)
        .optional(),
});

/** The guest-level filters. Household selection and reminder targets are applied in `audienceGuests`. */
export const matchesAudience = (guest: Guest, audience: Audience) => {
    if (audience.mode === "all") return true;
    if (audience.mode === "specific")
        return !!audience.guestIds?.includes(guest.id) || (!!guest.householdId && !!audience.householdIds?.includes(guest.householdId));
    if (audience.mode !== "filtered") {
        if (audience.guestIds?.length && !audience.guestIds.includes(guest.id)) return false;
        if (audience.householdIds?.length && !(guest.householdId && audience.householdIds.includes(guest.householdId))) return false;
    }
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

/**
 * Guests a campaign is aimed at. A specific selection is exactly what was chosen: no filter can add
 * anyone to it, and choosing nobody matches nobody (never everyone). Reminder targets narrow a
 * filtered group; a specific household that has replied is still held back by the eligibility check.
 */
const audienceGuests = (context: CampaignContext, audience: Audience) => {
    if (audience.mode === "specific") return context.guests.filter((guest) => matchesAudience(guest, audience));
    const remind = audience.mode !== "all" && audience.reminder?.length ? reminderHouseholds(context, audience.reminder) : null;
    return context.guests.filter((guest) => matchesAudience(guest, audience) && (!remind || (!!guest.householdId && remind.has(guest.householdId))));
};

export async function audiencePreview(env: Env, db: D1Database, input: unknown) {
    const audience = audienceSchema.parse(input);
    const context = await campaignContext(env, db, await listGuests(db));
    const guests = audienceGuests(context, audience);
    const households = new Set(guests.flatMap((g) => (g.householdId ? [g.householdId] : [])));
    return {
        total: guests.length,
        households: households.size,
        withEmail: guests.filter((g) => g.email).length,
        withMobile: guests.filter((g) => normaliseMobile(g.phone)).length,
        invalidMobile: guests.filter((g) => g.phone && !normaliseMobile(g.phone)).length,
        sample: guests.slice(0, 8).map((g) => ({ id: g.id, name: `${g.firstName} ${g.lastName}`.trim(), email: g.email })),
        // Why each household is included, for reminders: "No reply yet", "Partly answered"…
        reasons: audience.reminder?.length
            ? [...households].slice(0, 200).map((id) => ({
                  householdId: id,
                  name: context.households.get(id)?.name ?? "",
                  status: context.responses.get(id)?.status ?? "not_invited",
                  followUp: !!audience.reminder?.includes("follow_up") && reminderHouseholds(context, ["follow_up"]).has(id),
              }))
            : [],
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
    /**
     * Campaigns go to one person per household by default, addressed to the whole household.
     * True sends one to every matching guest instead (the explicit individual-delivery option).
     */
    individualDelivery: z.boolean().default(false),
    /** Include households that already have one of this kind (save the date, invitation, final details, thank you). */
    resend: z.boolean().default(false),
    /** Formal invitations by email: attach each household's printable invitation (PDF, with its QR code). */
    attachPdf: z.boolean().default(false),
    /** Set when prepared from Invitation Studio. */
    source: z.literal("invitation-studio").optional(),
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
    options: parseJson<MessageOptions>(row.options, {}),
});

export async function listMessages(db: D1Database): Promise<Message[]> {
    const rows = await db.prepare("SELECT * FROM messages ORDER BY created_at DESC LIMIT 200").all<Record<string, unknown>>();
    return rows.results.map(toMessage);
}

const toRecipient = (r: Record<string, unknown>): MessageRecipient => ({
    guestId: r.guest_id as string,
    householdId: (r.household_id as string | null) ?? null,
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
});

export async function getMessage(db: D1Database, id: string): Promise<{ message: Message; recipients: MessageRecipient[] } | null> {
    const row = await db.prepare("SELECT * FROM messages WHERE id = ?").bind(id).first<Record<string, unknown>>();
    if (!row) return null;
    const recipients = await db
        .prepare(
            `SELECT guest_id, household_id, name, email, phone, status, error, sent_at, provider_id, attempts, delivery_status, delivered_at, cost_cents
             FROM message_recipients WHERE message_id = ? ORDER BY name COLLATE NOCASE`,
        )
        .bind(id)
        .all<Record<string, unknown>>();
    return { message: toMessage(row), recipients: recipients.results.map(toRecipient) };
}

// ---------------------------------------------------------------------------------------------
// Preparing: freezes the copy and the recipient list

interface PlannedRecipient {
    guestId: string;
    householdId: string | null;
    name: string;
    email: string | null;
    phone: string | null;
    error: string | null;
}

/**
 * Who a campaign goes to. For a household campaign: one reachable person per household, in RSVP
 * order, else the household's own contact details; everyone else in the household is recorded as
 * included in that message. A household that's held back is held back for everyone in it.
 */
function planRecipients(
    context: CampaignContext,
    data: { category: Message["category"]; channel: MessageChannel; subject: string; body: string; options: MessageOptions },
    guests: Guest[],
    consent: Consent,
    contacted: { households: Map<string, ContactState>; guests: Map<string, ContactState> },
): PlannedRecipient[] {
    const once = oncePerHousehold(data.category, data.options);
    const eligibility = (householdId: string | null) => householdBlock(context, { ...data, householdId }, "prepare");
    const person = (guest: Guest) => `${guest.firstName} ${guest.lastName}`.trim();
    const included = (line: string) => `Included in the household ${data.category === "invitation" ? "invitation" : "message"} to ${line}`;

    if (!isHouseholdCampaign(data.category, data.options))
        return guests.map((guest) => {
            const reach = reachGuest(guest, data.channel, consent);
            const duplicate =
                once && contactedReason(contacted.guests.get(guest.id) ?? (guest.householdId ? contacted.households.get(guest.householdId) : undefined));
            return {
                guestId: guest.id,
                householdId: guest.householdId,
                name: person(guest),
                email: data.channel === "email" ? reach.email : null,
                phone: reach.phone,
                error: duplicate || eligibility(guest.householdId) || reach.error,
            };
        });

    const plan: PlannedRecipient[] = [];
    const byHousehold = new Map<string | null, Guest[]>();
    for (const guest of guests) byHousehold.set(guest.householdId, [...(byHousehold.get(guest.householdId) ?? []), guest]);
    for (const [householdId, members] of byHousehold) {
        // Guests without a household are each their own invitation.
        if (!householdId) {
            for (const guest of members) {
                const reach = reachGuest(guest, data.channel, consent);
                plan.push({
                    guestId: guest.id,
                    householdId: null,
                    name: person(guest),
                    email: data.channel === "email" ? reach.email : null,
                    phone: reach.phone,
                    error: (once && contactedReason(contacted.guests.get(guest.id))) || eligibility(null) || reach.error,
                });
            }
            continue;
        }
        const addressing = context.addressing.get(householdId);
        const order = (guest: Guest) => {
            const index = addressing?.guestIds.indexOf(guest.id) ?? -1;
            return index === -1 ? Number.MAX_SAFE_INTEGER : index;
        };
        const sorted = [...members].sort((a, b) => order(a) - order(b));
        const blocked = (once && contactedReason(contacted.households.get(householdId))) || eligibility(householdId);
        const reaches = sorted.map((guest) => ({ guest, reach: reachGuest(guest, data.channel, consent) }));
        const line = addressing?.recipientLine || context.households.get(householdId)?.name || person(sorted[0]);
        if (blocked) {
            for (const { guest, reach } of reaches)
                plan.push({
                    guestId: guest.id,
                    householdId,
                    name: person(guest),
                    email: data.channel === "email" ? reach.email : null,
                    phone: reach.phone,
                    error: blocked,
                });
            continue;
        }
        const chosen = reaches.find(({ reach }) => !reach.error);
        const fallback = chosen ? null : reachHousehold(context, householdId, data.channel, consent);
        if (fallback && !fallback.error) {
            // The household's own contact: the recipient id is the household id, as for RSVP confirmations.
            plan.push({ guestId: householdId, householdId, name: line, email: fallback.email, phone: fallback.phone, error: null });
            for (const { guest } of reaches)
                plan.push({ guestId: guest.id, householdId, name: person(guest), email: null, phone: null, error: included(line) });
            continue;
        }
        for (const { guest, reach } of reaches) {
            const isChosen = chosen?.guest.id === guest.id;
            plan.push({
                guestId: guest.id,
                householdId,
                name: isChosen ? line : person(guest),
                email: data.channel === "email" ? reach.email : null,
                phone: reach.phone,
                error: isChosen ? null : chosen ? included(line) : (fallback?.error ?? reach.error),
            });
        }
    }
    return plan;
}

export async function prepareMessage(env: Env, db: D1Database, input: unknown, actor: string): Promise<Message> {
    const data = messageSchema.parse(input);
    const { unknown, forbidden } = copyProblems(data.category, data.subject, data.body);
    if (unknown.length) throw new ValidationError(`Unknown merge field${unknown.length > 1 ? "s" : ""}: ${unknown.map((k) => `{{${k}}}`).join(", ")}`, "body");
    if (forbidden.length) throw new ValidationError(`{{${forbidden[0].field}}}: ${forbidden[0].reason}`, "body");
    if (data.scheduledAt && Date.parse(data.scheduledAt) <= Date.now()) throw new ValidationError("Choose a future sending time", "scheduledAt");
    if (data.channel === "sms" && smsSegments(data.body).segments > 6)
        throw new ValidationError("Keep text messages to six SMS parts or fewer. Link to the website for longer details.", "body");

    if (data.audience.mode === "specific" && !data.audience.guestIds?.length && !data.audience.householdIds?.length)
        throw new ValidationError("Choose at least one guest or household", "audience");
    const context = await campaignContext(env, db, await listGuests(db));
    const guests = audienceGuests(context, data.audience);
    if (guests.length === 0) throw new ValidationError("No guests match this audience", "audience");
    if (data.attachPdf && (data.category !== "invitation" || data.channel !== "email"))
        throw new ValidationError("Only email invitations can carry the printable invitation", "attachPdf");
    // An invitation keeps the Studio template it was prepared with: what was previewed is what's sent.
    const template =
        data.category === "invitation"
            ? {
                  template: await getSettings(db, "invitation"),
                  templateUpdatedAt:
                      (await db.prepare("SELECT updated_at FROM settings WHERE key = 'invitation'").first<{ updated_at: string }>())?.updated_at ?? null,
                  attachPdf: data.attachPdf,
              }
            : null;
    const options: MessageOptions = {
        ...(data.individualDelivery ? { individualDelivery: true } : {}),
        ...(data.resend ? { resend: true } : {}),
        ...(data.source ? { source: data.source } : {}),
        ...(template ? { invitation: template } : {}),
    };
    const [consent, contacted] = await Promise.all([optOuts(db), alreadyContacted(db, data.category, data.channel, "prepared")]);
    const plan = planRecipients(context, { ...data, options }, guests, consent, contacted);
    const households = new Set(plan.filter((p) => !p.error && p.householdId).map((p) => p.householdId)).size;

    const id = newId("msg");
    const now = nowIso();
    const statements = [
        db
            .prepare(
                "INSERT INTO messages (id, template_id, subject, body, audience, channel, category, status, recipient_count, created_by, created_at, scheduled_at, options) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
                JSON.stringify(options),
            ),
        ...plan.map((p) =>
            db
                .prepare(
                    "INSERT INTO message_recipients (message_id, guest_id, household_id, name, email, phone, status, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                )
                .bind(id, p.guestId, p.householdId, p.name, p.email, p.phone, p.error ? "skipped" : "pending", p.error),
        ),
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
                duplicates: plan.filter((p) => p.error === EXCLUSION_REASONS.alreadySent || p.error === EXCLUSION_REASONS.alreadyDrafted).length,
                ...(isCampaignKind(data.category) ? { delivery: options.individualDelivery ? "individual" : "household", households } : {}),
                ...(options.resend ? { resend: true } : {}),
            },
        }),
    ];
    for (let i = 0; i < statements.length; i += 400) await db.batch(statements.slice(i, i + 400));
    return (await getMessage(db, id))!.message;
}

/**
 * Exactly who a message would be prepared for, without preparing it: the households and guests the
 * selection covers, and the people and addresses it would actually go to, with everyone held back
 * and why. Uses the same planning as preparing.
 */
export async function planPreview(env: Env, db: D1Database, input: unknown) {
    const data = messageSchema.parse({ subject: "x", body: "x", ...(input as object) });
    if (data.audience.mode === "specific" && !data.audience.guestIds?.length && !data.audience.householdIds?.length)
        return { households: 0, guests: 0, recipients: [], held: [] };
    const context = await campaignContext(env, db, await listGuests(db));
    const guests = audienceGuests(context, data.audience);
    const options: MessageOptions = { ...(data.individualDelivery ? { individualDelivery: true } : {}), ...(data.resend ? { resend: true } : {}) };
    const [consent, contacted] = await Promise.all([optOuts(db), alreadyContacted(db, data.category, data.channel, "prepared")]);
    const plan = planRecipients(context, { ...data, options }, guests, consent, contacted);
    const held = new Map<string, number>();
    for (const p of plan) if (p.error && !p.error.startsWith("Included in the household")) held.set(p.error, (held.get(p.error) ?? 0) + 1);
    return {
        households: new Set(guests.flatMap((g) => (g.householdId ? [g.householdId] : []))).size,
        guests: guests.length,
        recipients: plan
            .filter((p) => !p.error)
            .slice(0, 500)
            .map((p) => ({
                name: p.name,
                to: (data.channel === "sms" ? p.phone : p.email) ?? "",
                householdId: p.householdId,
                // Included only because "send another" is on: they already have one (sent, or in an unsent draft).
                again: data.resend ? ((p.householdId ? contacted.households.get(p.householdId) : contacted.guests.get(p.guestId)) ?? null) : null,
            })),
        held: [...held].map(([reason, count]) => ({ reason, count })),
    };
}

// ---------------------------------------------------------------------------------------------
// Previews

const previewSchema = z.object({
    subject: z.string().max(200),
    body: z.string().max(20_000),
    category: z.enum([...MESSAGE_CATEGORIES, "rsvp_confirmation"]).default("update"),
    channel: z.enum(MESSAGE_CHANNELS).default("email"),
    guestId: z.string().max(40).nullable().optional(),
    householdId: z.string().max(40).nullable().optional(),
    individual: z.boolean().default(false),
});

/** A fictional household for previews when nobody is chosen (or the list is empty). */
const SAMPLE_GUEST = { firstName: "Alex", lastName: "Example" };

export async function previewMessage(env: Env, db: D1Database, input: unknown) {
    const data = previewSchema.parse(input);
    const guests = await listGuests(db);
    const context = await campaignContext(env, db, guests);
    const guest = data.guestId ? guests.find((g) => g.id === data.guestId) : undefined;
    const householdId = data.householdId ?? guest?.householdId ?? null;
    const household = householdId ? context.households.get(householdId) : undefined;
    const target = household
        ? {
              householdId: household.id,
              guestId: guest?.id ?? null,
              guest: guest ?? context.guestsById.get(context.addressing.get(household.id)?.guestIds[0] ?? "") ?? null,
              individual: data.individual,
          }
        : { householdId: null, guest: guest ?? SAMPLE_GUEST, individual: true, sample: !guest };
    // In the portal the artwork loads from this site, so previews work before the wedding site is live.
    const rendered = renderCopy(context, { ...data }, target, null, env.SITE_URL.replace(/\/+$/, ""));
    return {
        guest: guest ? { id: guest.id, name: `${guest.firstName} ${guest.lastName}`.trim(), email: guest.email } : null,
        household: household ? { id: household.id, name: context.addressing.get(household.id)?.recipientLine || household.name } : null,
        sample: !household && !guest,
        subject: rendered.subject,
        body: rendered.text,
        html: rendered.html,
        unknownFields: unknownMergeFields(`${data.subject}\n${data.body}`),
        forbidden: copyProblems(data.category, data.subject, data.body).forbidden,
        missing: rendered.missing,
        sms: rendered.sms,
    };
}

/** The copy one recipient gets, worked out the same way for sending, testing, the CSV and the send check. */
const targetFor = (context: CampaignContext, message: Message, recipient: Pick<MessageRecipient, "guestId" | "householdId" | "name">) => {
    const guest = context.guestsById.get(recipient.guestId);
    const household = recipient.householdId ? context.households.get(recipient.householdId) : undefined;
    // A message sent to the household's own address has the household's id as its recipient id.
    const named = guest ?? (household ? (context.guestsById.get(context.addressing.get(household.id)?.guestIds[0] ?? "") ?? null) : null);
    return {
        householdId: recipient.householdId,
        guestId: guest?.id ?? null,
        guest: named ?? { firstName: recipient.name, lastName: "" },
        individual: !isHouseholdCampaign(message.category, message.options),
    };
};

/** Rows for a mail-merge CSV: one per recipient with an address, fully rendered. */
export async function mergeRows(env: Env, db: D1Database, messageId: string) {
    const found = await getMessage(db, messageId);
    if (!found) throw new NotFoundError("Message not found");
    const context = await campaignContext(env, db, await listGuests(db));
    return found.recipients
        .filter((r) => (found.message.channel === "sms" ? r.phone : r.email))
        .map((r) => {
            const target = targetFor(context, found.message, r);
            const copy = renderCopy(context, found.message, target);
            const household = r.householdId ? context.households.get(r.householdId) : undefined;
            return {
                guestId: r.guestId,
                status: r.status,
                name: r.name,
                email: r.email ?? "",
                phone: r.phone ?? "",
                subject: copy.subject,
                body: copy.text,
                rsvpCode: household?.code ?? "",
                rsvpLink: household ? (household.link ?? "") : context.fallbackRsvpLink,
            };
        });
}

// ---------------------------------------------------------------------------------------------
// Delivery safeguards

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

/** A plain-text wedding email in the stationery layout. Every character of the text is escaped. */
export const weddingEmailHtml = (text: string, env: Env, coupleNames: string, weddingDate = "") =>
    stationeryEmailHtml({ kind: "update", text, coupleNames, weddingDate, assetOrigin: weddingOrigin(env) });

/**
 * What would happen to each pending recipient if the message were sent now. Used by the send check
 * and by sending itself, so the check shows exactly what sending does.
 */
async function planSend(env: Env, db: D1Database, found: { message: Message; recipients: MessageRecipient[] }, context?: CampaignContext) {
    const { message } = found;
    const ctx = context ?? (await campaignContext(env, db, await listGuests(db)));
    const [consent, sentElsewhere, reminded] = await Promise.all([
        optOuts(db),
        oncePerHousehold(message.category, message.options) ? alreadyContacted(db, message.category, message.channel, "sent", message.id) : null,
        message.category === "reminder" ? recentlyReminded(db, message.id) : null,
    ]);
    return found.recipients.map((recipient) => {
        if (recipient.status !== "pending") return { recipient, action: "keep" as const, reason: recipient.error };
        const guest = ctx.guestsById.get(recipient.guestId);
        // Consent can change between preparing and sending (a STOP reply, an unsubscribe). A message to
        // a household's own address or number (its recipient id is the household id) is checked
        // against the household's consent and every guest with that address or number.
        const householdContact = !guest && ctx.households.has(recipient.guestId);
        const optedOut = householdContact
            ? !!reachHousehold(ctx, recipient.guestId, message.channel, consent)?.error
            : guest
              ? reachGuest(
                    { ...guest, email: recipient.email ?? guest.email, phone: recipient.phone ?? guest.phone },
                    message.channel,
                    consent,
                ).error?.startsWith("Opted out")
              : !!(message.channel === "sms" ? consent.get(recipient.guestId)?.sms : consent.get(recipient.guestId)?.email);
        const block =
            (optedOut && (message.channel === "sms" ? EXCLUSION_REASONS.optedOutSms : EXCLUSION_REASONS.optedOutEmail)) ||
            (recipient.householdId && sentElsewhere?.households.has(recipient.householdId) && EXCLUSION_REASONS.alreadySentElsewhere) ||
            (!recipient.householdId && sentElsewhere?.guests.has(recipient.guestId) && EXCLUSION_REASONS.alreadySentElsewhere) ||
            (recipient.householdId && reminded?.has(recipient.householdId) && EXCLUSION_REASONS.remindedRecently) ||
            // A guest deleted since the message was prepared isn't contacted.
            (!guest && !ctx.households.has(recipient.guestId) && "No longer on the guest list") ||
            householdBlock(ctx, { ...message, householdId: recipient.householdId }, "send");
        const copy = renderCopy(ctx, message, targetFor(ctx, message, recipient));
        const missing = !block && copy.missing.length ? `${EXCLUSION_REASONS.missingDetail}: {{${copy.missing.join("}}, {{")}}}` : null;
        const reason = block || missing;
        return reason ? { recipient, action: "skip" as const, reason, copy } : { recipient, action: "send" as const, reason: null, copy };
    });
}

/** Everything to check before a campaign is sent or scheduled. */
export async function preflight(env: Env, db: D1Database, id: string): Promise<MessagePreflight> {
    const found = await getMessage(db, id);
    if (!found) throw new NotFoundError("Message not found");
    const { message } = found;
    const context = await campaignContext(env, db, await listGuests(db));
    const [plan, available, comms, sentBefore] = await Promise.all([
        planSend(env, db, found, context),
        deliveryAvailable(env, db, message.channel),
        getSettings(db, "comms"),
        // "Send another": who already received one, so the check and the confirmation can say so.
        message.options.resend ? alreadyContacted(db, message.category, message.channel, "sent", message.id) : null,
    ]);
    const sending = plan.filter((p) => p.action === "send");
    const isRepeat = (r: MessageRecipient) => !!sentBefore && (r.householdId ? sentBefore.households.has(r.householdId) : sentBefore.guests.has(r.guestId));
    const again = new Set(sending.filter((p) => isRepeat(p.recipient)).map((p) => p.recipient.householdId ?? p.recipient.guestId)).size;
    const excluded = new Map<string, string[]>();
    for (const p of plan)
        if (p.action !== "send" && p.reason && !p.reason.startsWith("Included in the household"))
            excluded.set(p.reason, [...(excluded.get(p.reason) ?? []), p.recipient.name]);
    const used = new Set(usedMergeFields(`${message.subject}\n${message.body}`));
    const warnings: string[] = [];
    const personalLink = used.has("rsvp_link") || used.has("invitation_link") || used.has("invitation_card");
    if (personalLink && !context.linksConfigured)
        warnings.push("Invitation links aren't set up on the Worker (RSVP_LINK_SECRET), so RSVP links can't be included.");
    if ((personalLink || used.has("rsvp_code")) && !context.nativeRsvp)
        warnings.push("Native RSVP is switched off, so RSVP links won't open the RSVP form until it's switched on.");
    if ((used.has("website_link") || personalLink) && !context.sitePublished)
        warnings.push("The wedding website isn't published yet, so links to it won't open for guests.");
    if ((used.has("save_the_date_card") || used.has("save_the_date_link")) && !context.saveTheDatePublic)
        warnings.push(
            "The Save the Date page isn't switched on yet (publish the website, or switch on “Public Save the Date page”). Until then emails leave out the Apple Calendar, .ics and page links, and texts that link to the page are held back.",
        );
    if (isCampaignKind(message.category))
        for (const field of CAMPAIGNS[message.category].expectedFields[message.channel])
            if (!used.has(field)) warnings.push(`This ${CAMPAIGNS[message.category].label.toLowerCase()} doesn't include {{${field}}}.`);
    if (message.category === "thank_you" && context.studio.thankYou.photoId && !context.photo)
        warnings.push("The wedding photo can only be shown once the website is published, so it's left out for now.");
    if (message.category === "final_details" && context.events.some((e) => !e.startsAt))
        warnings.push("Some events have no time yet; they'll say “time to be confirmed”.");
    if (wantsPdf(message)) {
        const provider = emailProvider(env);
        if (provider && !provider.supportsAttachments)
            warnings.push(`${provider.name} can't attach the printable invitation, so sending will be refused. Use Fastmail, or prepare it without the PDF.`);
        else warnings.push("Each household's printable invitation (PDF, with its own QR code) will be attached.");
    }
    if (message.options.resend)
        warnings.push(
            again
                ? `“Send another” is on: ${again} household${again === 1 ? " that was" : "s that were"} already sent one will get another. They're marked below.`
                : "“Send another” is on, but nobody here has been sent one yet.",
        );
    const parts = sending.reduce((total, p) => total + (message.channel === "sms" ? p.copy.sms.segments : 0), 0);
    const maxParts = Math.max(0, ...sending.map((p) => (message.channel === "sms" ? p.copy.sms.segments : 0)));
    const tests = await db
        .prepare("SELECT channel, recipient, status, error, created_by, created_at FROM message_tests WHERE message_id = ? ORDER BY created_at DESC LIMIT 10")
        .bind(id)
        .all<{ channel: MessageChannel; recipient: string; status: "sent" | "failed"; error: string | null; created_by: string; created_at: string }>();
    return {
        messageId: id,
        category: message.category,
        channel: message.channel,
        status: message.status,
        households: new Set(sending.map((p) => p.recipient.householdId ?? p.recipient.guestId)).size,
        recipients: sending.length,
        again,
        excluded: [...excluded].map(([reason, names]) => ({ reason, count: names.length, names: names.slice(0, 12) })).sort((a, b) => b.count - a.count),
        warnings,
        sms:
            message.channel === "sms"
                ? { parts, maxParts, estimatedCents: comms.smsCentsPerPart === null ? null : Math.round(parts * comms.smsCentsPerPart) }
                : null,
        deliveryAvailable: available,
        testRecipients: message.channel === "sms" ? comms.testMobiles : comms.testEmails,
        tests: tests.results.map((t) => ({ channel: t.channel, recipient: t.recipient, status: t.status, error: t.error, by: t.created_by, at: t.created_at })),
        sending: sending.slice(0, 500).map((p) => ({
            name: p.recipient.name,
            to: (message.channel === "sms" ? p.recipient.phone : p.recipient.email) ?? "",
            householdId: p.recipient.householdId,
            guestId: p.recipient.guestId,
            sentBefore: isRepeat(p.recipient),
        })),
    };
}

async function deliver(
    provider: EmailProvider | SmsProvider,
    row: { email: string | null; phone: string | null; name: string },
    copy: { subject: string; text: string; html: string },
    reference: string,
    attachments: EmailAttachment[] = [],
) {
    if (provider.channel === "sms") return provider.send({ to: row.phone ?? "", body: copy.text, reference });
    const result = await provider.send({
        to: row.email ?? "",
        toName: row.name,
        subject: copy.subject,
        text: copy.text,
        html: copy.html,
        reference,
        attachments,
    });
    return { ...result, costCents: null };
}

const wantsPdf = (message: Message) => message.category === "invitation" && message.channel === "email" && !!message.options.invitation?.attachPdf;

/**
 * The household's own printable invitation from Invitation Studio, with its QR code and signed link,
 * built with the template captured when the message was prepared. Throws rather than return nothing.
 */
async function invitationPdf(env: Env, studio: StudioData, message: Message, householdId: string | null, guestId: string | null) {
    if (!householdId) throw new ValidationError("The printable invitation needs a household", "attachPdf");
    const individual = !!message.options.individualDelivery && !!guestId;
    const bytes = await printableInvitations(
        env,
        {
            householdIds: [householdId],
            delivery: individual ? "individual" : "household",
            channels: ["print"],
            ...(individual ? { onlyGuestId: guestId } : {}),
        },
        studio,
    );
    const household = studio.households.find((h) => h.id === householdId);
    return { filename: `Wedding invitation - ${household?.recipientLine ?? "household"}.pdf`, contentType: "application/pdf" as const, bytes };
}

/**
 * One recipient's printable invitation, for previewing the attachment before sending. With
 * individual delivery a household has several recipients, each with their own invitation and link,
 * so the recipient is chosen by guest id when given.
 */
export async function messageInvitationPdf(env: Env, db: D1Database, id: string, householdId: string, guestId: string | null = null) {
    const found = await getMessage(db, id);
    if (!found) throw new NotFoundError("Message not found");
    if (found.message.category !== "invitation") throw new ValidationError("Only invitations have a printable invitation", "category");
    const recipient = found.recipients.find(
        (r) => r.householdId === householdId && (!guestId || r.guestId === guestId) && !r.error?.startsWith("Included in the household"),
    );
    if (!recipient) throw new NotFoundError("That household isn't a recipient of this message");
    const studio = await loadStudioData(env, found.message.options.invitation?.template);
    return invitationPdf(env, studio, found.message, householdId, recipient.guestId);
}

const MAX_ATTEMPTS = 3;

const sendSchema = z.object({
    /** The number of recipients the person confirmed in the send check. Required for more than one. */
    confirmCount: z.number().int().min(0).optional(),
    /** "Send another": the person confirmed that households already sent one will get another. */
    confirmAgain: z.boolean().default(false),
});

const repeatRecipientKey = (recipient: MessageRecipient) => (recipient.householdId ? `household:${recipient.householdId}` : `guest:${recipient.guestId}`);

/** The distinct households (or standalone guests) in this send that have already received this campaign. */
async function repeatRecipientKeys(db: D1Database, message: Message, toSend: { recipient: MessageRecipient }[]) {
    if (!message.options.resend || !toSend.length) return new Set<string>();
    const sent = await alreadyContacted(db, message.category, message.channel, "sent", message.id);
    return new Set(
        toSend
            .filter(({ recipient }) => (recipient.householdId ? sent.households.has(recipient.householdId) : sent.guests.has(recipient.guestId)))
            .map(({ recipient }) => repeatRecipientKey(recipient)),
    );
}

/** "Send another" needs its own confirmation whenever it would reach someone who was already sent one, even one household. */
async function requireAgainConfirmed(db: D1Database, message: Message, toSend: { recipient: MessageRecipient }[], confirmed: boolean) {
    const again = await repeatRecipientKeys(db, message, toSend);
    if (again.size && !confirmed)
        throw new ConflictError(
            `${again.size} recipient${again.size === 1 ? " was" : "s were"} already sent one. Confirm that they should get another before sending.`,
        );
    return again;
}

export async function sendMessage(env: Env, db: D1Database, id: string, actor: string, scheduledOnly = false, input: unknown = {}): Promise<Message> {
    const { confirmCount, confirmAgain } = sendSchema.parse(input ?? {});
    const found = await getMessage(db, id);
    if (!found) throw new NotFoundError("Message not found");
    const provider = await providerFor(env, db, found.message.channel);
    const sendable = scheduledOnly ? found.message.status === "queued" : found.message.status === "draft" || found.message.status === "queued";
    if (!sendable) throw new ValidationError("This message has already been sent", "status");
    if (scheduledOnly && (!found.message.scheduledAt || Date.parse(found.message.scheduledAt) > Date.now()))
        throw new ValidationError("This message is not due yet", "scheduledAt");

    if (wantsPdf(found.message) && provider.channel === "email" && !provider.supportsAttachments)
        throw new ValidationError(`${provider.name} can't attach the printable invitation. Prepare it again without the PDF, or use Fastmail.`, "attachPdf");
    const context = await campaignContext(env, db, await listGuests(db));
    let plan = await planSend(env, db, found, context);
    let toSend = plan.filter((p) => p.action === "send");
    if (scheduledOnly && found.message.options.resend) {
        const repeatedNow = await repeatRecipientKeys(db, found.message, toSend);
        const confirmedWhenScheduled = new Set(found.message.options.scheduledResendConfirmed ?? []);
        // A household that received this campaign after scheduling was never part of the user's
        // explicit "send another" confirmation. Hold it back instead of broadening that approval.
        if ([...repeatedNow].some((key) => !confirmedWhenScheduled.has(key))) {
            plan = plan.map((item) =>
                item.action === "send" && repeatedNow.has(repeatRecipientKey(item.recipient)) && !confirmedWhenScheduled.has(repeatRecipientKey(item.recipient))
                    ? { ...item, action: "skip" as const, reason: EXCLUSION_REASONS.resendNotConfirmed }
                    : item,
            );
            toSend = plan.filter((p) => p.action === "send");
        }
    }
    const studio = wantsPdf(found.message) ? await loadStudioData(env, found.message.options.invitation?.template) : null;
    // Bulk sends need the count the person saw in the send check; anything else means the list changed.
    if (!scheduledOnly && toSend.length > 1 && confirmCount !== toSend.length)
        throw new ConflictError(
            confirmCount === undefined
                ? `Confirm the send check first: this will go to ${toSend.length} recipients.`
                : `The recipient list has changed since you checked it (now ${toSend.length}). Review the send check again.`,
        );
    // Scheduled sends use the exact repeat-recipient snapshot persisted when they were scheduled.
    if (!scheduledOnly) await requireAgainConfirmed(db, found.message, toSend, confirmAgain);

    // Claim the message so a double click, a second tab or a cron retry cannot send twice.
    const claimed = await db
        .prepare(`UPDATE messages SET status = 'sending' WHERE id = ? AND status IN (${scheduledOnly ? "'queued'" : "'draft', 'queued'"}) RETURNING id`)
        .bind(id)
        .first();
    if (!claimed) throw new ValidationError("This message is already being sent", "status");

    let sent = 0;
    let failed = 0;
    let held = 0;
    for (const p of plan) {
        if (p.action === "keep") continue;
        if (p.action === "skip") {
            held++;
            await db
                .prepare("UPDATE message_recipients SET status = 'skipped', error = ? WHERE message_id = ? AND guest_id = ? AND status = 'pending'")
                .bind(p.reason, id, p.recipient.guestId)
                .run();
            continue;
        }
        // Each recipient is claimed too, so nothing is sent twice even if two sends overlap.
        const mine = await db
            .prepare("UPDATE message_recipients SET attempts = attempts + 1 WHERE message_id = ? AND guest_id = ? AND status = 'pending' RETURNING guest_id")
            .bind(id, p.recipient.guestId)
            .first();
        if (!mine) continue;
        const now = nowIso();
        try {
            const attachments = studio ? [await invitationPdf(env, studio, found.message, p.recipient.householdId, p.recipient.guestId)] : [];
            const result = await deliver(provider, p.recipient, p.copy, `${id}:${p.recipient.guestId}`, attachments);
            sent++;
            const statements = [
                db
                    .prepare(
                        "UPDATE message_recipients SET status = 'sent', sent_at = ?, error = NULL, provider_id = ?, cost_cents = ? WHERE message_id = ? AND guest_id = ?",
                    )
                    .bind(now, result.providerId, result.costCents, id, p.recipient.guestId),
            ];
            if (provider.channel === "sms")
                statements.push(
                    smsLogStatement(db, {
                        phone: p.recipient.phone ?? "",
                        guestId: context.guestsById.has(p.recipient.guestId) ? p.recipient.guestId : null,
                        householdId: p.recipient.householdId,
                        body: p.copy.text,
                        status: "sent",
                        providerId: result.providerId,
                        costCents: result.costCents,
                        messageId: id,
                        actor,
                    }),
                );
            await db.batch(statements);
        } catch (error) {
            failed++;
            await db
                .prepare("UPDATE message_recipients SET status = 'failed', error = ? WHERE message_id = ? AND guest_id = ?")
                .bind(String((error as Error).message).slice(0, 300), id, p.recipient.guestId)
                .run();
        }
    }
    const status = failed === 0 ? "sent" : sent === 0 ? "failed" : "partial";
    await db.batch([
        db
            .prepare("UPDATE messages SET status = ?, sent_at = ?, delivery_note = ? WHERE id = ?")
            .bind(status, nowIso(), `${sent} sent, ${failed} failed${held ? `, ${held} held back` : ""} via ${provider.name}`, id),
        auditStatement(db, {
            actor,
            action: "message.send",
            entityType: "message",
            entityId: id,
            summary: `Sent ${found.message.channel === "sms" ? "text" : "email"} “${found.message.subject}”: ${sent} delivered, ${failed} failed${held ? `, ${held} held back at sending` : ""}`,
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
    // The person asked for exactly these; they've seen who failed (and confirmed any "send another" when first sending).
    return sendMessage(env, db, id, actor, false, {
        confirmCount: (await planSend(env, db, (await getMessage(db, id))!)).filter((p) => p.action === "send").length,
        confirmAgain: true,
    });
}

const scheduleSchema = z.object({
    scheduledAt: z.string().refine((value) => Number.isFinite(Date.parse(value)), "Choose a valid date and time"),
    confirmCount: z.number().int().min(0),
    confirmAgain: z.boolean().default(false),
});

/** Schedules a checked draft. The scheduler re-checks consent and eligibility when it sends. */
export async function scheduleMessage(env: Env, db: D1Database, id: string, input: unknown, actor: string): Promise<Message> {
    const data = scheduleSchema.parse(input);
    if (Date.parse(data.scheduledAt) <= Date.now()) throw new ValidationError("Choose a future sending time", "scheduledAt");
    const found = await getMessage(db, id);
    if (!found) throw new NotFoundError("Message not found");
    if (found.message.status !== "draft") throw new ValidationError("Only drafts can be scheduled", "status");
    const toSend = (await planSend(env, db, found)).filter((p) => p.action === "send");
    const count = toSend.length;
    if (data.confirmCount !== count)
        throw new ConflictError(`The recipient list has changed since you checked it (now ${count}). Review the send check again.`);
    const scheduledResendConfirmed = await requireAgainConfirmed(db, found.message, toSend, data.confirmAgain);
    const scheduledAt = new Date(data.scheduledAt).toISOString();
    const options = found.message.options.resend
        ? { ...found.message.options, scheduledResendConfirmed: [...scheduledResendConfirmed].sort() }
        : found.message.options;
    const updated = await db
        .prepare("UPDATE messages SET status = 'queued', scheduled_at = ?, options = ? WHERE id = ? AND status = 'draft' RETURNING id")
        .bind(scheduledAt, JSON.stringify(options), id)
        .first();
    if (!updated) throw new ValidationError("This message changed while you were scheduling it", "status");
    await auditStatement(db, {
        actor,
        action: "message.schedule",
        entityType: "message",
        entityId: id,
        summary: `Scheduled “${found.message.subject}” for ${count} recipients`,
        changes: { scheduledAt },
    }).run();
    return (await getMessage(db, id))!.message;
}

const testSchema = z.object({
    to: z.string().trim().max(254),
    /** Whose details fill the test: a chosen household, or null for the fictional sample. */
    householdId: z.string().max(40).nullable().default(null),
});

/**
 * A controlled test of one message, to one of the owner-approved test addresses or mobiles only.
 * It's recorded in message_tests, never in the message's recipients: it doesn't count as anyone
 * being contacted, change any RSVP or block or trigger the real send. It needs a configured provider
 * but not the delivery switch, which only guards guests.
 */
export async function sendTest(env: Env, db: D1Database, id: string, input: unknown, actor: string) {
    const data = testSchema.parse(input);
    const found = await getMessage(db, id);
    if (!found) throw new NotFoundError("Message not found");
    const { message } = found;
    const comms = await getSettings(db, "comms");
    const to = message.channel === "sms" ? normaliseMobile(data.to) : data.to.toLowerCase();
    const allowed = message.channel === "sms" ? comms.testMobiles : comms.testEmails;
    if (!to || !allowed.includes(to))
        throw new ValidationError(
            allowed.length
                ? "Tests can only go to the approved test recipients in Email & SMS settings."
                : "Add a test recipient in Email & SMS settings first (owners and admins).",
            "to",
        );
    const provider = message.channel === "sms" ? smsProvider(env) : emailProvider(env);
    if (!provider) throw new ValidationError(`No ${message.channel === "sms" ? "SMS" : "email"} provider is configured on the Worker`, "to");
    const context = await campaignContext(env, db, await listGuests(db));
    const household = data.householdId ? context.households.get(data.householdId) : undefined;
    if (data.householdId && !household) throw new NotFoundError("Household not found");
    const target = household
        ? { householdId: household.id, guest: context.guestsById.get(context.addressing.get(household.id)?.guestIds[0] ?? "") ?? null, individual: false }
        : { householdId: null, guest: SAMPLE_GUEST, individual: true, sample: true };
    const copy = renderCopy(context, message, target, { recipient: to });
    if (wantsPdf(message) && !household)
        throw new ValidationError("Choose a household to test the attached invitation; a fictional one has no RSVP link.", "householdId");
    if (wantsPdf(message) && provider.channel === "email" && !provider.supportsAttachments)
        throw new ValidationError(`${provider.name} can't attach the printable invitation`, "to");
    const testId = newId("tst");
    let providerId: string | null = null;
    let error: string | null = null;
    try {
        const attachments =
            wantsPdf(message) && household
                ? [await invitationPdf(env, await loadStudioData(env, message.options.invitation?.template), message, household.id, null)]
                : [];
        ({ providerId } = await deliver(provider, { email: to, phone: to, name: "Wedding Planner test" }, copy, `test:${testId}`, attachments));
    } catch (e) {
        error = String((e as Error).message).slice(0, 300);
    }
    await db.batch([
        db
            .prepare(
                `INSERT INTO message_tests (id, message_id, channel, recipient, sample_household_id, provider, provider_id, status, error, created_by, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(testId, id, message.channel, to, household?.id ?? null, provider.name, providerId, error ? "failed" : "sent", error, actor, nowIso()),
        auditStatement(db, {
            actor,
            action: "message.test",
            entityType: "message",
            entityId: id,
            summary: `${error ? "Failed to send" : "Sent"} a test of “${message.subject}” to an approved test ${message.channel === "sms" ? "mobile" : "address"}`,
            changes: { sample: household ? "household" : "fictional" },
        }),
    ]);
    if (error) throw new ValidationError(`The test wasn't sent: ${error}`, "to");
    return { ok: true, to, provider: provider.name };
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

const formatDate = formatLongDate;

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
                .map(
                    (event) =>
                        `${event.name}: ${{ attending: "attending", declined: "not attending", pending: "not answered yet" }[result.responses[guest.id][event.id]]}`,
                );
            return `${guest.firstName} ${guest.lastName}`.trim() + (events.length ? ` (${events.join(", ")})` : "");
        });
        const coming = result.guests.some((guest) => Object.values(result.responses[guest.id] ?? {}).includes("attending"));
        const couple = `${wedding.partnerOne} & ${wedding.partnerTwo}`;
        const site = weddingOrigin(env);
        const subject = `Your RSVP for ${couple}'s wedding`;
        const body = [
            `Hi ${result.householdName},`,
            coming ? "Thank you for your RSVP. We can't wait to celebrate with you!" : "Thank you for letting us know. We'll miss you.",
            `Here's what we have:\n${lines.map((line) => `• ${line}`).join("\n")}`,
            `If anything changes, you can update your RSVP using the link in your invitation${settings.deadline ? ` until ${formatDate(settings.deadline)}` : ""}. Wedding details are at ${site}.`,
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
                    html: stationeryEmailHtml({
                        kind: "rsvp_confirmation",
                        text: body,
                        coupleNames: couple,
                        weddingDate: formatDate(wedding.date),
                        assetOrigin: site,
                    }),
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
                    "INSERT INTO message_recipients (message_id, guest_id, household_id, name, email, status, error, sent_at, provider_id, attempts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)",
                )
                .bind(id, household.id, household.id, household.name, to, error ? "failed" : "sent", error, error ? null : now, providerId),
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

/** Households by their own normalised mobile number, for consent on household contact details. */
async function householdsByPhone(db: D1Database) {
    const rows = await db
        .prepare("SELECT id, name, phone, sms_opt_out_at FROM households WHERE deleted_at IS NULL AND phone IS NOT NULL AND phone != ''")
        .all<{ id: string; name: string; phone: string; sms_opt_out_at: string | null }>();
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
    const homes = await householdsByPhone(db);
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
                optedOut: guests.some((g) => g.sms_opt_out_at) || (homes.get(last.phone) ?? []).some((h) => h.sms_opt_out_at),
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
    const homes = (await householdsByPhone(db)).get(phone) ?? [];
    return {
        phone,
        messages: rows.results.map(toSms),
        guests: guests.map((g) => ({ id: g.id, name: `${g.first_name} ${g.last_name}`.trim(), householdName: g.household_name })),
        optedOut: guests.some((g) => g.sms_opt_out_at) || homes.some((h) => h.sms_opt_out_at),
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
    const homes = (await householdsByPhone(db)).get(phone) ?? [];
    if (guests.some((g) => g.sms_opt_out_at) || homes.some((h) => h.sms_opt_out_at)) throw new ValidationError("This number has opted out of texts", "phone");
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
    // Consent belongs to the number: households whose own contact number it is stop being texted too.
    const homes = (await householdsByPhone(db)).get(phone) ?? [];
    const now = nowIso();
    const statements = [
        smsLogStatement(db, {
            phone,
            guestId: guests[0]?.id ?? null,
            householdId: guests[0]?.household_id ?? homes[0]?.id ?? null,
            body: input.body.slice(0, 2000),
            status: "received",
            providerId: input.providerId,
            actor: "system:webhook",
            direction: "inbound",
        }),
    ];
    if (isOptOutReply(input.body) && (guests.length || homes.length)) {
        for (const guest of guests)
            statements.push(db.prepare("UPDATE guests SET sms_opt_out_at = COALESCE(sms_opt_out_at, ?) WHERE id = ?").bind(now, guest.id));
        for (const home of homes)
            statements.push(db.prepare("UPDATE households SET sms_opt_out_at = COALESCE(sms_opt_out_at, ?) WHERE id = ?").bind(now, home.id));
        statements.push(
            auditStatement(db, {
                actor: "system:webhook",
                action: "consent.sms_opt_out",
                entityType: guests.length ? "guest" : "household",
                entityId: guests[0]?.id ?? homes[0].id,
                summary: `${[...guests.map((g) => g.first_name), ...homes.map((h) => `${h.name} (household number)`)].join(" and ")} opted out of texts`,
            }),
        );
    }
    await db.batch(statements);
    return { matched: guests.length > 0 || homes.length > 0 };
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
