// The five guest communications in the Communications Studio, in the order guests receive them.
// One set of rules, shared by the Studio, the Worker that prepares and sends messages, and the
// tests, so what the couple is told and what actually happens can't drift apart.
//
// Every campaign goes to one person per household by default, addressed to the whole household,
// exactly like the printed invitation. Sending to each guest individually is an explicit option.
import type { InvitationTemplateSettings, MessageCategory } from "./types";

export const CAMPAIGN_KINDS = ["save_the_date", "invitation", "reminder", "final_details", "thank_you"] as const;
export type CampaignKind = (typeof CAMPAIGN_KINDS)[number];

export const isCampaignKind = (category: MessageCategory): category is CampaignKind => (CAMPAIGN_KINDS as readonly string[]).includes(category);

export interface CampaignCopy {
    subject: string;
    body: string;
    smsBody: string;
}

export interface CampaignDefinition {
    label: string;
    /** One line for the Studio card. */
    description: string;
    /**
     * Sent once per household and channel. A household that already has one in an unsent draft, or
     * was already sent one, on the same channel is held back unless "send another" is chosen.
     * Reminders can be sent more than once (with a warning).
     */
    oncePerHousehold: boolean;
    /** Merge fields that can't be used, with the reason shown to the couple. */
    forbiddenFields: Partial<Record<string, string>>;
    /** Merge fields it should normally include; their absence is a warning in the send check. */
    expectedFields: string[];
    /** A printable card can be made from it in the portal. */
    printable: boolean;
    copy: CampaignCopy;
}

const NOT_FOR_SAVE_THE_DATE = "A save the date comes before the formal invitation, so it doesn't include an RSVP link or code.";

export const CAMPAIGNS: Record<CampaignKind, CampaignDefinition> = {
    save_the_date: {
        label: "Save the date",
        description: "The date and place, with the formal invitation to follow. Doesn't invite anyone or change any RSVP.",
        oncePerHousehold: true,
        forbiddenFields: { rsvp_link: NOT_FOR_SAVE_THE_DATE, rsvp_code: NOT_FOR_SAVE_THE_DATE, rsvp_progress: NOT_FOR_SAVE_THE_DATE },
        expectedFields: ["website_link"],
        printable: true,
        copy: {
            subject: "Save the date: {{couple_names}}, {{wedding_date}}",
            body: [
                "Dear {{greeting_names}},",
                "We're getting married, and we'd love you to save the date.",
                "{{couple_names}}\n{{wedding_date}}\n{{venue}}",
                "A formal invitation will follow. In the meantime, you'll find everything we know so far at {{website_link}}.",
                "Add it to your calendar: {{calendar_link}}",
                "With love,\n{{couple_names}}",
            ].join("\n\n"),
            smsBody: "{{couple_names}} here! Please save the date for our wedding: {{wedding_date}}, {{venue}}. Formal invitation to follow. {{website_link}}",
        },
    },
    invitation: {
        label: "Formal invitation",
        description: "The invitation itself, with each household's own RSVP link. Printed versions come from Invitation Studio.",
        oncePerHousehold: true,
        forbiddenFields: {},
        expectedFields: ["invitation_card"],
        printable: false,
        copy: {
            subject: "You're invited to {{couple_names}}'s wedding",
            body: [
                "Dear {{greeting_names}},",
                "We would love you to join us as we celebrate our wedding.",
                "{{invitation_card}}",
                "With love,\n{{couple_names}}",
            ].join("\n\n"),
            smsBody: "{{couple_names}} here. You're invited to our wedding on {{wedding_date}}! Please RSVP by {{rsvp_deadline}}: {{rsvp_link}}",
        },
    },
    reminder: {
        label: "RSVP reminder",
        description: "A gentle nudge to households that haven't replied, or replied for only some of their guests.",
        oncePerHousehold: false,
        forbiddenFields: {},
        expectedFields: ["rsvp_link"],
        printable: false,
        copy: {
            subject: "A gentle reminder to RSVP by {{rsvp_deadline}}",
            body: [
                "Dear {{greeting_names}},",
                "We're busy getting everything ready and would love to know if you can join us on {{wedding_date}}. {{rsvp_progress}}",
                "Please reply by {{rsvp_deadline}}: {{rsvp_link}}",
                "With love,\n{{couple_names}}",
            ].join("\n\n"),
            smsBody: "{{couple_names}} here. A gentle reminder to RSVP for our wedding by {{rsvp_deadline}}: {{rsvp_link}}",
        },
    },
    final_details: {
        label: "Final information",
        description: "Times, venue, courtesy bus and accommodation for the households who are coming. Only confirmed details are used.",
        oncePerHousehold: true,
        forbiddenFields: {},
        expectedFields: ["event_schedule"],
        printable: false,
        copy: {
            subject: "Final details for {{wedding_date}}",
            body: [
                "Dear {{greeting_names}},",
                "We can't wait to celebrate with you! Here's everything you need for the day.",
                "{{event_schedule}}",
                "Venue: {{venue}}",
                "{{household_transport}}",
                "{{transport_details}}",
                "{{accommodation_details}}",
                "{{final_notes}}",
                "Everything is also on our website: {{website_link}}",
                "With love,\n{{couple_names}}",
            ].join("\n\n"),
            smsBody: "{{couple_names}} here. The final details for our wedding on {{wedding_date}} are on our website: {{website_link}} See you soon!",
        },
    },
    thank_you: {
        label: "Thank you",
        description: "A thank-you card for each household, with an optional photo, personal note and gallery link. Never sent automatically.",
        oncePerHousehold: true,
        forbiddenFields: {},
        expectedFields: ["thank_you_message"],
        printable: true,
        copy: {
            subject: "Thank you from {{couple_names}}",
            body: [
                "Dear {{greeting_names}},",
                "{{thank_you_message}}",
                "{{personal_note}}",
                "Photos from the day: {{gallery_link}}",
                "With love,\n{{couple_names}}",
            ].join("\n\n"),
            smsBody: "{{couple_names}} here. Thank you so much for being part of our wedding. It meant the world to us.",
        },
    },
};

/**
 * The wording of an invitation prepared from Invitation Studio, from the Studio's own template: its
 * greeting, introduction and sign-off around {{invitation_card}}, the designed invitation itself.
 */
export function studioInvitationCopy(template: InvitationTemplateSettings): CampaignCopy {
    // The Studio's own merge fields, in Communications' names.
    const map = (text: string) => text.replace(/\{\{\s*wedding_location\s*\}\}/g, "{{venue}}").replace(/\{\{\s*guest_name\s*\}\}/g, "{{full_name}}");
    return {
        subject: "You're invited to {{couple_names}}'s wedding",
        body: [`${template.greetingPrefix} {{greeting_names}},`, map(template.emailIntroduction), "{{invitation_card}}", map(template.emailSignoff)].join(
            "\n\n",
        ),
        smsBody: `${template.greetingPrefix} {{greeting_names}}, you're invited to {{couple_names}}'s wedding on {{wedding_date}}. Please RSVP by {{rsvp_deadline}}: {{rsvp_link}}`,
    };
}

/** Who an RSVP reminder can be aimed at. Manual selection uses the audience's household list. */
export const REMINDER_TARGETS = ["not_started", "partial", "follow_up"] as const;
export type ReminderTarget = (typeof REMINDER_TARGETS)[number];

export const REMINDER_TARGET_LABELS: Record<ReminderTarget, { label: string; hint: string }> = {
    not_started: { label: "No reply yet", hint: "Households that haven't answered for anyone." },
    partial: { label: "Partly answered", hint: "Households that answered for some guests or events but not all." },
    follow_up: { label: "Needs follow-up", hint: "Not sure about the courtesy bus or accommodation, or other travel answers to check." },
};

/** Why a household or guest is held back from a campaign. Shown in the send check and on each recipient. */
export const EXCLUSION_REASONS = {
    noEmail: "No email address",
    noMobile: "No mobile number",
    invalidMobile: "Mobile number isn't valid",
    optedOutEmail: "Opted out of email",
    optedOutSms: "Opted out of texts",
    alreadyDrafted: "Already in an unsent draft for this household (nothing sent yet)",
    alreadySent: "Already sent to this household",
    alreadySentElsewhere: "Already sent to this household in another message",
    replied: "Already replied for everyone",
    repliedSince: "Replied for everyone since this was prepared",
    remindedRecently: "Reminded in the last 24 hours",
    notInvited: "No one in this household is invited to an event with RSVPs open",
    linkRevoked: "Invitation link revoked",
    linkMissing: "Invitation links aren't set up",
    notComing: "No one in this household is coming",
    noReachable: "No one in this household can be reached on this channel",
    missingDetail: "A detail this message needs is missing",
} as const;
