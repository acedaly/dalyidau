// Placeholders available in message templates, written as {{key}}.
export const MERGE_FIELDS = [
    { key: "first_name", label: "First name" },
    { key: "last_name", label: "Last name" },
    { key: "full_name", label: "Full name" },
    { key: "household_name", label: "Household name" },
    { key: "rsvp_code", label: "RSVP code" },
    { key: "rsvp_link", label: "RSVP link" },
    { key: "rsvp_deadline", label: "RSVP deadline" },
    { key: "couple_names", label: "Couple's names" },
    { key: "wedding_date", label: "Wedding date" },
] as const;
