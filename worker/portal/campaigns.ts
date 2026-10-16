// The Communications Studio's rules, in one place, so that the preview, the send check, a scheduled
// send and a manual send all reach the same decision about every household:
//
// - who a campaign goes to (one reachable person per household by default, addressed to the whole
//   household, or each guest individually when chosen);
// - which households are held back, and why (no contact, opted out, already sent, replied, not
//   coming, a revoked link, a detail the message needs that's missing);
// - what each household's copy says (merge values built from the guest list, the published website
//   and the Studio settings; never an invented time, pick-up point or room).
//
// Decisions are made twice: when the message is prepared (the frozen recipient list) and again
// immediately before each recipient is sent (consent, replies and links can change in between, and
// a scheduled message may be sent days later).
import type { D1Database } from "@cloudflare/workers-types";
import { CAMPAIGNS, type CampaignKind, EXCLUSION_REASONS, isCampaignKind } from "../../src/shared/portal/campaigns";
import { MERGE_FIELDS, OPTIONAL_MERGE_FIELDS, renderMergeFields, usedMergeFields } from "../../src/shared/portal/merge-fields";
import { normaliseMobile } from "../../src/shared/portal/phone";
import { smsSegments } from "../../src/shared/portal/sms";
import { type RsvpTravel, followUpReasons, needsOutbound, needsReturn } from "../../src/shared/portal/travel";
import type {
    Audience,
    Guest,
    HouseholdResponse,
    MessageCategory,
    MessageChannel,
    MessageOptions,
    StudioSettings,
    WebsiteContent,
    WeddingDetails,
} from "../../src/shared/portal/types";
import { type StationeryAccent, stationeryEmailHtml } from "../comms/stationery";
import type { Env } from "../env";
import { invitationLinksConfigured, invitationUrl, weddingOrigin } from "../wedding/invitations";
import { isEnabled } from "./flags";
import { type HouseholdAddressing, householdAddressing } from "./invitation-studio";
import { householdResponses } from "./queries";
import { getSettings } from "./settings";
import { loadAllTravel } from "./travel";

// ---------------------------------------------------------------------------------------------
// Formatting

export const formatLongDate = (iso: string) => {
    if (!iso) return "";
    return new Intl.DateTimeFormat("en-AU", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(
        new Date(`${iso.slice(0, 10)}T12:00:00Z`),
    );
};

const formatTime = (dateTime: string | null) => {
    const match = dateTime ? /T(\d{2}):(\d{2})/.exec(dateTime) : null;
    if (!match) return "";
    const hour = Number(match[1]);
    return `${hour % 12 || 12}:${match[2]} ${hour < 12 ? "am" : "pm"}`;
};

/** "Rhino Lodge · Dubbo, NSW" reads as "Rhino Lodge, Dubbo NSW" in sentences. */
export const displayLocation = (location: string) =>
    location
        .replace(/\s*[·•]\s*/g, ", ")
        .replace(/,\s*(NSW|VIC|QLD|SA|WA|TAS|NT|ACT)\b/g, " $1")
        .trim();

const listNames = (names: string[]) => (names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

/** A Google Calendar "add event" link for the wedding day (all day, so no time is implied). */
export function calendarLink(wedding: WeddingDetails) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(wedding.date)) return "";
    const start = wedding.date.replace(/-/g, "");
    const next = new Date(`${wedding.date}T12:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    const end = next.toISOString().slice(0, 10).replace(/-/g, "");
    const params = new URLSearchParams({
        action: "TEMPLATE",
        text: `${wedding.partnerOne} & ${wedding.partnerTwo}'s wedding`,
        dates: `${start}/${end}`,
        location: displayLocation(wedding.location),
    });
    return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

// ---------------------------------------------------------------------------------------------
// Context: everything needed to address and personalise every household, loaded once.

export interface HouseholdInfo {
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
    code: string;
    revoked: boolean;
    /** The signed RSVP link, or null when links aren't configured or this one is revoked. */
    link: string | null;
}

export interface CampaignContext {
    env: Env;
    wedding: WeddingDetails;
    studio: StudioSettings;
    website: WebsiteContent;
    rsvpDeadline: string;
    fallbackRsvpLink: string;
    nativeRsvp: boolean;
    sitePublished: boolean;
    linksConfigured: boolean;
    site: string;
    events: { name: string; startsAt: string | null; venue: string | null }[];
    households: Map<string, HouseholdInfo>;
    addressing: Map<string, HouseholdAddressing>;
    responses: Map<string, HouseholdResponse>;
    travel: Map<string, RsvpTravel>;
    notes: Map<string, string>;
    guests: Guest[];
    guestsById: Map<string, Guest>;
    photo: { url: string; alt: string } | null;
}

export async function campaignContext(env: Env, db: D1Database, guests: Guest[]): Promise<CampaignContext> {
    const [wedding, rsvp, studio, website, native, published, homes, addressing, responses, travel, notes, events] = await Promise.all([
        getSettings(db, "wedding"),
        getSettings(db, "rsvp"),
        getSettings(db, "studio"),
        getSettings(db, "website"),
        isEnabled(db, "rsvp.native"),
        isEnabled(db, "wedding.site.public"),
        db
            .prepare("SELECT id, name, email, phone, rsvp_code, invite_version, invite_revoked_at FROM households WHERE deleted_at IS NULL")
            .all<{
                id: string;
                name: string;
                email: string | null;
                phone: string | null;
                rsvp_code: string;
                invite_version: number;
                invite_revoked_at: string | null;
            }>(),
        householdAddressing(db),
        householdResponses(db),
        loadAllTravel(db),
        db.prepare("SELECT household_id, note FROM thank_you_notes").all<{ household_id: string; note: string }>(),
        db
            .prepare("SELECT name, starts_at, venue_name FROM events WHERE is_public = 1 ORDER BY sort_order, starts_at IS NULL, starts_at, created_at")
            .all<{ name: string; starts_at: string | null; venue_name: string | null }>(),
    ]);
    const site = weddingOrigin(env);
    let photo: CampaignContext["photo"] = null;
    if (studio.thankYou.photoId) {
        const media = await db
            .prepare("SELECT r2_key, alt FROM website_media WHERE id = ?")
            .bind(studio.thankYou.photoId)
            .first<{ r2_key: string; alt: string | null }>();
        // Photos are only served publicly once the website is published.
        if (media && published) photo = { url: `${site}/wedding/media/${media.r2_key.replace(/^wedding\//, "")}`, alt: media.alt ?? "" };
    }
    return {
        env,
        wedding,
        studio,
        website,
        rsvpDeadline: formatLongDate(rsvp.deadline),
        fallbackRsvpLink: native ? `${site}/rsvp` : rsvp.externalUrl || site,
        nativeRsvp: native,
        sitePublished: published,
        linksConfigured: invitationLinksConfigured(env),
        site,
        events: events.results.map((e) => ({ name: e.name, startsAt: e.starts_at, venue: e.venue_name })),
        households: new Map(
            await Promise.all(
                homes.results.map(
                    async (h) =>
                        [
                            h.id,
                            {
                                id: h.id,
                                name: h.name,
                                email: h.email,
                                phone: h.phone,
                                code: h.rsvp_code,
                                revoked: !!h.invite_revoked_at,
                                link: h.invite_revoked_at ? null : await invitationUrl(env, h.id, h.invite_version),
                            },
                        ] as const,
                ),
            ),
        ),
        addressing,
        responses,
        travel,
        notes: new Map(notes.results.map((n) => [n.household_id, n.note])),
        guests,
        guestsById: new Map(guests.map((g) => [g.id, g])),
        photo,
    };
}

// ---------------------------------------------------------------------------------------------
// Merge values

const eventSchedule = (context: CampaignContext) =>
    context.events
        .map((event) => {
            const time = formatTime(event.startsAt);
            const day = event.startsAt && event.startsAt.slice(0, 10) !== context.wedding.date ? `${formatLongDate(event.startsAt)}, ` : "";
            const when = time ? `${day}${time}` : "time to be confirmed";
            return `${event.name}: ${when}${event.venue ? `, ${event.venue}` : ""}`;
        })
        .join("\n");

const sectionText = (website: WebsiteContent, kind: "transport" | "accommodation") =>
    website.sections
        .filter((section) => section.kind === kind && section.visible)
        .map((section) =>
            [
                section.title,
                section.body,
                ...section.items.map((item) =>
                    [item.title, item.body, item.url]
                        .filter((part) => part.trim())
                        .join(": ")
                        .replace(/: (https:)/, " – $1"),
                ),
            ]
                .map((part) => part.trim())
                .filter(Boolean)
                .join("\n"),
        )
        .join("\n\n");

/** The household's own courtesy bus answer, in their words. Never a time or a pick-up point. */
const householdTransport = (context: CampaignContext, householdId: string | null) => {
    const travel = householdId ? context.travel.get(householdId) : undefined;
    if (!travel?.bus) return "";
    const seats = (n: number) => `${n} seat${n === 1 ? "" : "s"}`;
    if (travel.bus === "unsure") return "You weren't sure about the courtesy bus when you replied. Let us know if you'd like a seat.";
    if (travel.bus === "none") return "";
    // Never more seats than guests now coming, as on the transport dashboard.
    const coming = (householdId && context.responses.get(householdId)?.attending) || 0;
    const outbound = Math.min(travel.outbound, coming);
    const home = Math.min(travel.return, coming);
    if (!outbound && !home) return "";
    const parts = [
        needsOutbound(travel.bus) && outbound && `${seats(outbound)} to the wedding`,
        needsReturn(travel.bus) && home && `${seats(home)} home`,
    ].filter(Boolean);
    return `Courtesy bus: you've asked for ${parts.join(" and ")}. The Dubbo RSL will confirm pick-up times closer to the day.`;
};

/** Who in the household still needs to answer, for reminders. */
const rsvpProgress = (context: CampaignContext, householdId: string | null) => {
    if (!householdId) return "";
    const addressing = context.addressing.get(householdId);
    const response = context.responses.get(householdId);
    if (!addressing || !response || response.status === "complete" || response.status === "not_invited") return "";
    if (response.status === "not_started") return "We haven't had a reply from you yet.";
    const waiting = addressing.guestIds
        .map((id) => context.guestsById.get(id))
        .filter((guest): guest is Guest => !!guest && guest.events.some((event) => event.status === "pending"))
        .map((guest) => guest.firstName);
    return waiting.length ? `We still need an answer for ${listNames(waiting)}.` : "";
};

export interface MergeTarget {
    householdId: string | null;
    /** The guest this copy is for: the person it's sent to, or the guest named in an individual message. */
    guest: Pick<Guest, "firstName" | "lastName"> | null;
    /** Addressed to this guest alone (individual delivery or a guest without a household). */
    individual: boolean;
}

export function mergeValues(context: CampaignContext, target: MergeTarget): Record<string, string> {
    const household = target.householdId ? context.households.get(target.householdId) : undefined;
    const addressing = target.householdId ? context.addressing.get(target.householdId) : undefined;
    const fullName = target.guest ? `${target.guest.firstName} ${target.guest.lastName}`.trim() : (household?.name ?? "");
    const studio = context.studio;
    return {
        first_name: target.guest?.firstName ?? "",
        last_name: target.guest?.lastName ?? "",
        full_name: fullName,
        household_name: household?.name ?? fullName,
        invitation_names: (!target.individual && addressing?.recipientLine) || fullName,
        greeting_names: (!target.individual && addressing?.greetingNames) || target.guest?.firstName || household?.name || "",
        rsvp_code: household?.code ?? "",
        rsvp_link: household ? (household.link ?? "") : context.fallbackRsvpLink,
        rsvp_deadline: context.rsvpDeadline,
        rsvp_progress: rsvpProgress(context, target.householdId),
        couple_names: `${context.wedding.partnerOne} & ${context.wedding.partnerTwo}`,
        wedding_date: formatLongDate(context.wedding.date),
        venue: displayLocation(context.wedding.location),
        website_link: context.site,
        calendar_link: studio.saveTheDate.showCalendarLink ? calendarLink(context.wedding) : "",
        event_schedule: eventSchedule(context),
        transport_details: studio.finalDetails.includeTransport ? sectionText(context.website, "transport") : "",
        household_transport: householdTransport(context, target.householdId),
        accommodation_details: studio.finalDetails.includeAccommodation ? sectionText(context.website, "accommodation") : "",
        final_notes: studio.finalDetails.notes,
        thank_you_message: studio.thankYou.message,
        personal_note: (target.householdId && context.notes.get(target.householdId)) || "",
        gallery_link: studio.thankYou.galleryUrl,
    };
}

export const KNOWN_FIELDS: ReadonlySet<string> = new Set(MERGE_FIELDS.map((field) => field.key));

/** Required merge fields this text uses that came out empty for one recipient. */
export const missingValues = (text: string, values: Record<string, string>) =>
    usedMergeFields(text).filter((key) => KNOWN_FIELDS.has(key) && !OPTIONAL_MERGE_FIELDS.has(key) && !values[key]?.trim());

export interface RenderedCopy {
    subject: string;
    text: string;
    html: string;
    sms: ReturnType<typeof smsSegments>;
    missing: string[];
}

export const ACTION_LABELS: Partial<Record<MessageCategory, (values: Record<string, string>) => { label: string; url: string } | null>> = {
    invitation: (v) => (v.rsvp_link ? { label: "Reply to your invitation", url: v.rsvp_link } : null),
    reminder: (v) => (v.rsvp_link ? { label: "Reply now", url: v.rsvp_link } : null),
    save_the_date: (v) => ({ label: "Visit our wedding website", url: v.website_link }),
    final_details: (v) => ({ label: "See all the details", url: v.website_link }),
    thank_you: (v) => (v.gallery_link ? { label: "See the photos", url: v.gallery_link } : null),
};

export function renderCopy(
    context: CampaignContext,
    message: { subject: string; body: string; category: MessageCategory; channel: MessageChannel },
    target: MergeTarget,
    test: { recipient: string } | null = null,
): RenderedCopy {
    const values = mergeValues(context, target);
    const subject = renderMergeFields(message.subject, values);
    const text = renderMergeFields(message.body, values);
    const accent: StationeryAccent = context.studio.accent;
    const action = ACTION_LABELS[message.category]?.(values) ?? null;
    return {
        subject: test ? `[TEST] ${subject}` : subject,
        text: test ? `TEST - sent only to ${test.recipient}. No guest has received this.\n\n${text}` : text,
        html:
            message.channel === "email"
                ? stationeryEmailHtml({
                      kind: isCampaignKind(message.category) ? message.category : message.category === "rsvp_confirmation" ? "rsvp_confirmation" : "update",
                      text,
                      coupleNames: values.couple_names,
                      weddingDate: values.wedding_date,
                      assetOrigin: context.site,
                      accent,
                      // A test is never an invitation to act, but the button still shows where it goes.
                      action,
                      photo: message.category === "thank_you" ? context.photo : null,
                      test,
                  })
                : "",
        sms: smsSegments(test ? `TEST: ${text}` : text),
        missing: missingValues(`${message.subject}\n${message.body}`, values),
    };
}

// ---------------------------------------------------------------------------------------------
// Validation of the copy itself

export function copyProblems(category: MessageCategory, subject: string, body: string) {
    const used = usedMergeFields(`${subject}\n${body}`);
    const unknown = used.filter((key) => !KNOWN_FIELDS.has(key));
    const forbidden = isCampaignKind(category)
        ? used.flatMap((key) => {
              const reason = CAMPAIGNS[category].forbiddenFields[key];
              return reason ? [{ field: key, reason }] : [];
          })
        : [];
    return { unknown, forbidden };
}

// ---------------------------------------------------------------------------------------------
// Audience: which households and guests a campaign is aimed at

/** Households a reminder targets, from RSVP progress and transport follow-up. */
export function reminderHouseholds(context: CampaignContext, targets: NonNullable<Audience["reminder"]>) {
    const out = new Set<string>();
    for (const [id, response] of context.responses) {
        if (response.status === "complete" || response.status === "not_invited") continue;
        if (targets.includes("not_started") && response.status === "not_started") out.add(id);
        if (targets.includes("partial") && response.status === "partial") out.add(id);
    }
    if (targets.includes("follow_up"))
        for (const [id, travel] of context.travel) {
            const response = context.responses.get(id);
            if (response && followUpReasons(travel, response.attending).length) out.add(id);
        }
    return out;
}

// ---------------------------------------------------------------------------------------------
// Eligibility

export type Phase = "prepare" | "send";

export interface EligibilityInput {
    category: MessageCategory;
    channel: MessageChannel;
    subject: string;
    body: string;
    householdId: string | null;
}

/** Why this household can't receive this campaign right now, or null. Consent is checked separately. */
export function householdBlock(context: CampaignContext, input: EligibilityInput, phase: Phase): string | null {
    const used = new Set(usedMergeFields(`${input.subject}\n${input.body}`));
    const householdId = input.householdId;
    const household = householdId ? context.households.get(householdId) : undefined;
    const response = householdId ? context.responses.get(householdId) : undefined;
    const usesLink = used.has("rsvp_link") || used.has("rsvp_code");
    if (input.category === "invitation" || input.category === "reminder") {
        if (household && !context.addressing.get(household.id)?.guestIds.length) return EXCLUSION_REASONS.notInvited;
        if (household && usesLink && household.revoked) return EXCLUSION_REASONS.linkRevoked;
        if (household && used.has("rsvp_link") && !household.link) return EXCLUSION_REASONS.linkMissing;
    }
    if (input.category === "reminder" && response?.status === "complete") return phase === "send" ? EXCLUSION_REASONS.repliedSince : EXCLUSION_REASONS.replied;
    if (input.category === "final_details" && household && (response?.attending ?? 0) === 0) return EXCLUSION_REASONS.notComing;
    return null;
}

/** Opt-outs per guest, kept out of the Guest type so they never travel to pages that don't need them. */
export async function optOuts(db: D1Database) {
    const rows = await db
        .prepare("SELECT id, email_opt_out_at, sms_opt_out_at FROM guests WHERE email_opt_out_at IS NOT NULL OR sms_opt_out_at IS NOT NULL")
        .all<{ id: string; email_opt_out_at: string | null; sms_opt_out_at: string | null }>();
    return new Map(rows.results.map((r) => [r.id, { email: !!r.email_opt_out_at, sms: !!r.sms_opt_out_at }]));
}

export type Consent = Awaited<ReturnType<typeof optOuts>>;

/** Whether a guest can be reached on this channel, and why not. */
export function reachGuest(guest: Pick<Guest, "id" | "email" | "phone">, channel: MessageChannel, consent: Consent) {
    const opted = consent.get(guest.id);
    if (channel === "sms") {
        if (!guest.phone) return { email: null, phone: null, error: EXCLUSION_REASONS.noMobile };
        const phone = normaliseMobile(guest.phone);
        // Never pass a malformed number on to the SMS provider; the mobile number review lists these.
        if (!phone) return { email: null, phone: null, error: EXCLUSION_REASONS.invalidMobile };
        if (opted?.sms) return { email: null, phone, error: EXCLUSION_REASONS.optedOutSms };
        return { email: null, phone, error: null };
    }
    if (!guest.email) return { email: null, phone: null, error: EXCLUSION_REASONS.noEmail };
    if (opted?.email) return { email: guest.email, phone: null, error: EXCLUSION_REASONS.optedOutEmail };
    return { email: guest.email, phone: null, error: null };
}

/**
 * A household's own contact details, used when none of its guests can be reached. Anyone in the
 * household who opted out with the same address or number keeps it opted out.
 */
export function reachHousehold(context: CampaignContext, householdId: string, channel: MessageChannel, consent: Consent) {
    const household = context.households.get(householdId);
    if (!household) return null;
    const members = context.guests.filter((g) => g.householdId === householdId);
    if (channel === "sms") {
        const phone = normaliseMobile(household.phone);
        if (!phone) return null;
        const opted = members.some((g) => consent.get(g.id)?.sms && normaliseMobile(g.phone) === phone);
        return { email: null, phone, error: opted ? EXCLUSION_REASONS.optedOutSms : null };
    }
    if (!household.email) return null;
    const email = household.email.toLowerCase();
    const opted = members.some((g) => consent.get(g.id)?.email && g.email?.toLowerCase() === email);
    return { email: household.email, phone: null, error: opted ? EXCLUSION_REASONS.optedOutEmail : null };
}

/** Households (or guests without one) that already have a live message of this kind, other than `exceptMessageId`. */
export async function alreadyContacted(db: D1Database, category: MessageCategory, status: "prepared" | "sent", exceptMessageId: string | null = null) {
    const rows = await db
        .prepare(
            `SELECT DISTINCT mr.household_id, mr.guest_id FROM message_recipients mr JOIN messages m ON m.id = mr.message_id
             WHERE m.category = ?1 AND m.id != ?2
               AND ${status === "sent" ? "mr.status = 'sent'" : "m.status IN ('draft', 'queued', 'sending', 'sent', 'partial') AND mr.status IN ('pending', 'sent')"}`,
        )
        .bind(category, exceptMessageId ?? "")
        .all<{ household_id: string | null; guest_id: string }>();
    return { households: new Set(rows.results.flatMap((r) => (r.household_id ? [r.household_id] : []))), guests: new Set(rows.results.map((r) => r.guest_id)) };
}

/** Households sent a reminder in the last day by another message. */
export async function recentlyReminded(db: D1Database, exceptMessageId: string, now = Date.now()) {
    const rows = await db
        .prepare(
            `SELECT DISTINCT mr.household_id FROM message_recipients mr JOIN messages m ON m.id = mr.message_id
             WHERE m.category = 'reminder' AND m.id != ? AND mr.status = 'sent' AND mr.household_id IS NOT NULL AND mr.sent_at >= ?`,
        )
        .bind(exceptMessageId, new Date(now - 86_400_000).toISOString())
        .all<{ household_id: string }>();
    return new Set(rows.results.map((r) => r.household_id));
}

export const isHouseholdCampaign = (category: MessageCategory, options: MessageOptions) => isCampaignKind(category) && !options.individualDelivery;

export const oncePerHousehold = (category: MessageCategory, options: MessageOptions) =>
    isCampaignKind(category) && CAMPAIGNS[category as CampaignKind].oncePerHousehold && !options.resend;
