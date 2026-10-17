// Feature switches. Definitions live here so the worker and the browser agree on keys and
// defaults; the feature_flags table only stores overrides. Defaults are chosen to fail closed:
// anything public-facing or anything that contacts guests starts switched off.

export const FLAG_DEFINITIONS = {
    "wedding.site.public": {
        label: "Public wedding website",
        description: "Serve the wedding website at /wedding. While off, /wedding returns 404 and only the portal preview works.",
        default: false,
        group: "Website",
    },
    "wedding.save_the_date.public": {
        label: "Public Save the Date page",
        description:
            "Serve the Save the Date page (/save-the-date) and its calendar file (/save-the-date/calendar) before the website is published. Shows only the couple, date and venue. Publishing the website serves them too.",
        default: false,
        group: "Website",
    },
    "rsvp.native": {
        label: "Native RSVP",
        description:
            "Collect RSVPs with our own form at /wedding/rsvp. While off, the website sends guests to the external RSVP link (Say I Do) and the RSVP API refuses submissions.",
        default: false,
        group: "RSVP",
    },
    "communications.delivery": {
        label: "Email delivery",
        description:
            "Allow messages to be sent. Also needs an email provider configured on the Worker (EMAIL_DELIVERY). While off, messages can be prepared, previewed and exported but never sent.",
        default: false,
        group: "Communications",
    },
    "communications.sms": {
        label: "SMS delivery",
        description:
            "Allow text messages to be sent and replied to. Also needs an SMS provider configured on the Worker (SMS_DELIVERY). While off, SMS campaigns can be prepared and previewed but never sent.",
        default: false,
        group: "Communications",
    },
    "module.communications": {
        label: "Communications module",
        description: "Templates, message preparation and delivery history.",
        default: true,
        group: "Modules",
    },
    "module.planning": {
        label: "Planning module",
        description: "Tasks and the day-of timeline.",
        default: true,
        group: "Modules",
    },
    "module.budget": {
        label: "Budget and suppliers module",
        description: "Budget items, payments and the supplier directory.",
        default: true,
        group: "Modules",
    },
} as const satisfies Record<string, { label: string; description: string; default: boolean; group: string }>;

export type FlagKey = keyof typeof FLAG_DEFINITIONS;
export type Flags = Record<FlagKey, boolean>;

export const FLAG_KEYS = Object.keys(FLAG_DEFINITIONS) as FlagKey[];

export const isFlagKey = (value: unknown): value is FlagKey => typeof value === "string" && value in FLAG_DEFINITIONS;

export const defaultFlags = (): Flags => Object.fromEntries(FLAG_KEYS.map((key) => [key, FLAG_DEFINITIONS[key].default])) as Flags;
