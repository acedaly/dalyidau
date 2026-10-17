// Placeholders available in message templates, written as {{key}}.
//
// Optional fields can legitimately be empty for a household (no personal note, no gallery yet, no
// courtesy bus answer). A line whose optional field comes out empty is left out entirely, so a
// message never shows "Photos from the day: " with nothing after it. Every other field must have a
// value for every recipient, or the recipient is held back in the send check.
export const MERGE_FIELDS = [
    { key: "first_name", label: "First name" },
    { key: "last_name", label: "Last name" },
    { key: "full_name", label: "Full name" },
    { key: "household_name", label: "Household name" },
    // The invitation's own addressing, identical to the printed invitation: "Fred & Ann Daly".
    { key: "invitation_names", label: "Invitation names" },
    // For salutations: "Dear {{greeting_names}}" gives "Dear Fred & Ann".
    { key: "greeting_names", label: "Greeting names" },
    { key: "rsvp_code", label: "RSVP code" },
    { key: "rsvp_link", label: "RSVP link" },
    // The household's own invitation page (the invitation, then RSVP), for texts. Same signed link.
    { key: "invitation_link", label: "Personal invitation link (invitation, then RSVP)" },
    { key: "rsvp_deadline", label: "RSVP deadline" },
    // The whole invitation as designed in Invitation Studio: the botanical card in the email, with
    // the household's own RSVP button and link. Formal invitations only.
    { key: "invitation_card", label: "The invitation (as designed in Invitation Studio)" },
    // "We still need an answer for Tom and Lucy." Only for reminders.
    { key: "rsvp_progress", label: "Who still needs to reply" },
    { key: "couple_names", label: "Couple's names" },
    { key: "wedding_date", label: "Wedding date" },
    { key: "venue", label: "Venue" },
    { key: "website_link", label: "Wedding website link" },
    { key: "calendar_link", label: "Add-to-calendar link (Google Calendar)", optional: true },
    // The Save the Date as designed: names, date, venue, "formal invitation to follow" and Add to
    // Calendar for Apple, Google, Outlook and other calendars. Save the dates only.
    { key: "save_the_date_card", label: "The Save the Date (with Add to Calendar)" },
    // The public Save the Date page. Empty (so the message is held back) until the page is served.
    { key: "save_the_date_link", label: "Save the Date page link" },
    // Each public event with its confirmed time, or "time to be confirmed". Never an invented time.
    { key: "event_schedule", label: "Event times" },
    { key: "transport_details", label: "Courtesy bus details (from the website)", optional: true },
    { key: "household_transport", label: "The household's courtesy bus answer", optional: true },
    { key: "accommodation_details", label: "Accommodation details (from the website)", optional: true },
    { key: "final_notes", label: "Final instructions", optional: true },
    { key: "thank_you_message", label: "Thank-you message" },
    { key: "personal_note", label: "Personal note for the household", optional: true },
    { key: "gallery_link", label: "Photo gallery link", optional: true },
] as const satisfies readonly { key: string; label: string; optional?: boolean }[];

export type MergeFieldKey = (typeof MERGE_FIELDS)[number]["key"];

export const OPTIONAL_MERGE_FIELDS: ReadonlySet<string> = new Set(
    MERGE_FIELDS.filter((field) => "optional" in field && field.optional).map((field) => field.key),
);

const TOKEN = /\{\{\s*([a-z_]+)\s*\}\}/g;

/** Merge fields used in a piece of text, in order of first use. */
export const usedMergeFields = (text: string) => [...new Set([...text.matchAll(TOKEN)].map((match) => match[1]))];

/**
 * Fills in {{ field }} placeholders. Unknown fields stay visible so mistakes show in previews.
 * A line containing an optional field that is empty is dropped, and the blank lines that leaves
 * are tidied so paragraphs stay evenly spaced.
 */
export function renderMergeFields(text: string, values: Partial<Record<string, string>>) {
    const lines = text.split("\n").flatMap((line) => {
        const fields = [...line.matchAll(TOKEN)].map((match) => match[1]);
        if (fields.some((key) => OPTIONAL_MERGE_FIELDS.has(key) && !values[key]?.trim())) return [];
        return [line.replace(TOKEN, (match, key: string) => (key in values ? (values[key] ?? "") : match))];
    });
    return lines
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}
