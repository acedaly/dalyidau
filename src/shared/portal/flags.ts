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
    "tasks.reminders.email": {
        label: "Task reminder emails",
        description:
            "Email Daly Tasks reminders in the background to people who have turned on email reminders in Tasks → Settings. Also needs an email provider configured on the Worker (EMAIL_DELIVERY). While off, reminders appear only in the app.",
        default: false,
        group: "Communications",
    },
    "calendar.feeds": {
        label: "Calendar subscription addresses",
        description:
            "Serve the private ICS addresses people create in Calendar → Calendars (for Apple Calendar, Outlook and Google Calendar). Anyone holding an address can read what it publishes, so it starts off. While off, every address answers 404; nothing is deleted.",
        default: false,
        group: "Calendar",
    },
    "calendar.reminders.email": {
        label: "Calendar reminder emails",
        description:
            "Email Calendar reminders, upcoming leave, school holiday and subscription failure notices to people who turned on email in Calendar → Settings. Also needs an email provider configured on the Worker (EMAIL_DELIVERY). While off, notifications appear only in the app.",
        default: false,
        group: "Calendar",
    },
    "intelligence_centre.ingestion": {
        label: "Intelligence Centre collection",
        description:
            "Collect the public sources switched on in Intelligence Centre → Sources every 15 minutes (each at its own interval). While off, nothing is fetched from any provider; records already collected stay, marked with their age.",
        default: false,
        group: "Intelligence Centre",
    },
    "intelligence_centre.alerts.email": {
        label: "Intelligence Centre alert emails",
        description:
            "Email watch-area alerts and daily summaries to people who opted in for a watch area. Also needs an email provider configured on the Worker (EMAIL_DELIVERY). Never a replacement for official warnings, and delivery isn't guaranteed. While off, alerts are in the portal only.",
        default: false,
        group: "Intelligence Centre",
    },
    "intelligence_centre.wallboard": {
        label: "Wallboard displays",
        description:
            "Serve wallboards at /display to screens holding a display credential (created in Intelligence Centre → Wallboards). Each credential reads one wallboard and nothing else. While off, /display answers 404 and every credential is refused; nothing is deleted.",
        default: false,
        group: "Intelligence Centre",
    },
    "assets.ai": {
        label: "Home & Assets AI suggestions",
        description:
            "Let Home & Assets ask Daly Intelligence to read a receipt, a photo or a policy document and suggest values for a person to check and approve. Also needs Intelligence and its document feature switched on (Intelligence settings) and Workers AI connected. While off, every capture works by hand and nothing is sent to a model.",
        default: false,
        group: "Home & Assets",
    },
    "assets.reminders.email": {
        label: "Home & Assets reminder emails",
        description:
            "Email reminders (servicing, registration, renewals, warranty expiry) to people who turned email on in Home & Assets → Settings. Also needs an email provider configured on the Worker (EMAIL_DELIVERY). While off, reminders appear only in the portal.",
        default: false,
        group: "Home & Assets",
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
