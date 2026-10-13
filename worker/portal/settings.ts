// Settings documents (wedding details, website content, RSVP and budget). Each is a single JSON
// row validated on write and merged over defaults on read, so adding a field never breaks old data.
import type { D1Database } from "@cloudflare/workers-types";
import { z } from "zod";
import { SECTION_KINDS, type SettingsDocuments, type SettingsKey, type WebsiteContent } from "../../src/shared/portal/types";
import { auditStatement, diff, nowIso, parseJson } from "./db";

const text = (max: number) => z.string().trim().max(max);
const isoDate = z.union([z.literal(""), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")]);
const httpsUrl = z.union([
    z.literal(""),
    z
        .string()
        .trim()
        .url()
        .refine((u) => u.startsWith("https://"), "Use an https:// link"),
]);
const timeZone = z.string().refine((tz) => {
    try {
        new Intl.DateTimeFormat("en-AU", { timeZone: tz });
        return true;
    } catch {
        return false;
    }
}, "Unknown time zone");

const item = z.object({
    title: text(120).min(1, "Give it a title"),
    body: text(2000).default(""),
    url: z
        .union([
            z.literal(""),
            z
                .string()
                .trim()
                .url()
                .refine((u) => /^https?:\/\//.test(u), "Use an http(s) link"),
        ])
        .default(""),
    detail: text(80).default(""),
    imageId: z.string().max(40).nullable().default(null),
});

const section = z.object({
    id: z.string().regex(/^[a-z0-9-]{1,40}$/),
    // Sections saved before kinds existed are treated as custom text sections.
    kind: z.enum(SECTION_KINDS).default("custom"),
    title: text(80).min(1, "Every section needs a heading"),
    body: text(6000),
    items: z.array(item).max(30).default([]),
    imageId: z.string().max(40).nullable().default(null),
    visible: z.boolean().default(true),
});

const website = z.object({
    heroEyebrow: text(80),
    heroTitle: text(120),
    heroSubtitle: text(240),
    heroImageId: z.string().max(40).nullable().default(null),
    heroFocalX: z.number().min(0).max(100).default(50),
    heroFocalY: z.number().min(0).max(100).default(50),
    welcome: text(4000),
    sections: z.array(section).max(20),
    rsvpHeading: text(120).default("We hope you'll celebrate with us."),
    rsvpText: text(600).default(""),
    showGallery: z.boolean().default(false),
    contactEmail: z.union([z.literal(""), z.string().trim().email()]),
    noindex: z.boolean(),
});

export const SETTINGS_SCHEMAS = {
    privacy: z.object({
        auditRetentionDays: z.number().int().min(0).max(3650),
        deletedRetentionDays: z.number().int().min(7).max(3650),
    }),
    catering: z
        .object({
            eventId: z.string().max(40).nullable(),
            categories: z
                .array(
                    z.object({
                        id: z.string().regex(/^[a-z0-9_]{1,40}$/),
                        label: text(60).min(1, "Every category needs a name"),
                        description: text(200).default(""),
                        appliesTo: z.enum(["any", "adult", "child"]).default("any"),
                    }),
                )
                .min(1, "Keep at least one meal category")
                .max(20),
            adultDefault: z.string().max(40).nullable(),
            notes: text(4000).default(""),
        })
        .refine((c) => new Set(c.categories.map((x) => x.id)).size === c.categories.length, { message: "Category ids must be unique", path: ["categories"] })
        .refine((c) => !c.adultDefault || c.categories.some((x) => x.id === c.adultDefault), {
            message: "The adult default must be one of the categories",
            path: ["adultDefault"],
        }),
    wedding: z.object({
        partnerOne: text(60),
        partnerTwo: text(60),
        date: isoDate,
        location: text(120),
        timeZone,
    }),
    invitation: z.object({
        artwork: z.enum(["native-botanicals", "none"]),
        accent: z.enum(["burgundy", "rust", "eucalyptus"]),
        eyebrow: text(80).min(1),
        invitationLine: text(240).min(1),
        greetingPrefix: text(30).min(1),
        emailIntroduction: text(1000).min(1),
        emailSignoff: text(240).min(1),
    }),
    website,
    website_draft: website,
    rsvp: z.object({
        externalUrl: httpsUrl,
        deadline: isoDate,
        collectDietary: z.boolean(),
        collectMessage: z.boolean(),
        /** Let households change their answers after the deadline. */
        allowChangesAfterDeadline: z.boolean().default(false),
        /** Accept the short household codes as well as invitation links. */
        allowCodes: z.boolean().default(true),
        /** Invitation links stop working this many days after the deadline (0 = when the deadline passes is irrelevant; never expire). */
        linkExpiryDays: z.number().int().min(0).max(3650).default(60),
        /** Email a confirmation after an online reply (also needs email delivery switched on). */
        confirmationEmail: z.boolean().default(false),
    }),
    budget: z.object({
        totalCents: z.number().int().min(0).max(100_000_000_00),
        currency: z.string().regex(/^[A-Z]{3}$/),
    }),
} satisfies { [K in SettingsKey]: z.ZodType<SettingsDocuments[K], unknown> };

/** A website item with the optional fields filled in. */
const entry = (title: string, body: string, url = "", detail = ""): WebsiteContent["sections"][number]["items"][number] => ({
    title,
    body,
    url,
    detail,
    imageId: null,
});

/**
 * Defaults, taken from the couple's Say I Do website (October 2026): ceremony at 2:00pm, smart
 * casual, RSVP by 25 September 2027, on-site glamping, The Westbury and the Dubbo RSL courtesy bus.
 * Anything not on that site (a story, travel details, gifts) starts hidden, so nothing is
 * published by assumption.
 */
const DEFAULT_WEBSITE: WebsiteContent = {
    heroEyebrow: "Together with our families",
    heroTitle: "",
    heroSubtitle: "We're getting married",
    heroImageId: null,
    heroFocalX: 50,
    heroFocalY: 50,
    welcome: "We are excited to be getting married and even more excited to share the day with you.",
    sections: [
        { id: "story", kind: "story", title: "Our story", body: "", items: [], imageId: null, visible: false },
        {
            id: "details",
            kind: "details",
            title: "Schedule",
            body: "Our ceremony and reception will both be held at Rhino Lodge, so once you've arrived there's nowhere else you need to be.",
            items: [],
            imageId: null,
            visible: true,
        },
        {
            id: "venue",
            kind: "venue",
            title: "Rhino Lodge",
            body: "We're celebrating at Rhino Lodge in Dubbo. Rhino Lodge offers beautiful on-site glamping accommodation, so you can stay right where the celebrations are happening!",
            items: [
                entry("Address", "14L Camp Rd, Dubbo NSW 2830", "https://maps.google.com/maps?q=14L%20Camp%20Rd%2C%20Dubbo%20NSW%202830%2C%20Australia"),
                entry("Website", "rhinolodge.com.au", "https://www.rhinolodge.com.au/"),
            ],
            imageId: null,
            visible: true,
        },
        {
            id: "stay",
            kind: "accommodation",
            title: "Accommodation",
            body: "For those travelling to celebrate with us, we've put together a list of recommended accommodation options nearby. You're also more than welcome to make your own arrangements.\n\nPlease note that accommodation at Rhino Lodge is limited and will be available on a **first come, first served basis**. We recommend getting in early if you'd like to stay on-site.\n\nIf Rhino Lodge is fully booked, there are plenty of other great accommodation options in and around Dubbo to choose from.",
            items: [
                entry(
                    "Dubbo Rhino Lodge",
                    "Beautiful on-site glamping, so you can stay right where the celebrations are happening. Spots are limited: contact Rhino Lodge directly to book.",
                    "https://www.rhinolodge.com.au/accommodation/",
                    "99 m from the ceremony",
                ),
                entry("The Westbury Dubbo", "A boutique hotel in the centre of Dubbo.", "https://westburydubbo.com.au/", "5.2 km from the ceremony"),
            ],
            imageId: null,
            visible: true,
        },
        { id: "travel", kind: "travel", title: "Getting there", body: "", items: [], imageId: null, visible: false },
        {
            id: "bus",
            kind: "transport",
            title: "Getting home safely",
            body: "For guests staying in Dubbo, the Dubbo RSL courtesy bus will be available to help you get home safely after the celebrations.\n\nWe'll share more information about transport arrangements closer to the big day.",
            items: [],
            imageId: null,
            visible: true,
        },
        {
            id: "children",
            kind: "children",
            title: "Bring the kids",
            body: "Children are very welcome at our wedding! We'd love for families to celebrate with us, so please feel free to bring your little ones along and include them in your RSVP.",
            items: [],
            imageId: null,
            visible: false,
        },
        { id: "dress", kind: "dress", title: "What to wear", body: "Smart casual.", items: [], imageId: null, visible: false },
        { id: "gifts", kind: "registry", title: "Gifts", body: "", items: [], imageId: null, visible: false },
        {
            id: "faq",
            kind: "faq",
            title: "Frequently asked questions",
            body: "We've pulled together a handy Q&A to help you get the info you need in no time, so you can focus on the fun stuff!",
            items: [
                entry(
                    "Are children invited to the wedding?",
                    "Children are very welcome at our wedding! We'd love for families to celebrate with us, so please feel free to bring your little ones along and include them in your RSVP.",
                ),
                entry(
                    "When do we need to RSVP by?",
                    "Please send through your RSVP by 25 September 2027 so we can finalise all the details for the day. We can't wait to celebrate with you!",
                ),
                entry("Are the wedding ceremony and the reception at the same venue?", "Yes, both the ceremony and reception will be held at the same venue."),
                entry(
                    "Is there accommodation onsite?",
                    "Yes. Rhino Lodge has on-site glamping accommodation available. If you'd like to stay at the venue, please contact Rhino Lodge directly to arrange your booking.",
                ),
            ],
            imageId: null,
            visible: true,
        },
    ],
    rsvpHeading: "We hope you'll celebrate with us.",
    rsvpText: "",
    showGallery: false,
    contactEmail: "",
    noindex: true,
};

export const SETTINGS_DEFAULTS: SettingsDocuments = {
    privacy: { auditRetentionDays: 730, deletedRetentionDays: 90 },
    catering: {
        eventId: null,
        categories: [
            { id: "adult_buffet", label: "Adult buffet", description: "The main buffet. Older children can have it too.", appliesTo: "any" },
            { id: "kids_meal", label: "Children's meal", description: "A separate children's meal.", appliesTo: "child" },
            { id: "no_meal", label: "No meal", description: "Babies and anyone not eating.", appliesTo: "any" },
        ],
        adultDefault: "adult_buffet",
        notes: "",
    },
    wedding: { partnerOne: "Aidan", partnerTwo: "Amelia", date: "2027-10-23", location: "Rhino Lodge · Dubbo, NSW", timeZone: "Australia/Sydney" },
    invitation: {
        artwork: "native-botanicals",
        accent: "burgundy",
        eyebrow: "Together with their families",
        invitationLine: "invite you to celebrate their marriage",
        greetingPrefix: "Dear",
        emailIntroduction: "We would love you to join us as we celebrate our wedding.",
        emailSignoff: "With love,\n{{couple_names}}",
    },
    website: DEFAULT_WEBSITE,
    website_draft: DEFAULT_WEBSITE,
    rsvp: {
        externalUrl: "https://sayi.do/aidanandamelia2258/",
        deadline: "2027-09-25",
        collectDietary: true,
        collectMessage: true,
        allowChangesAfterDeadline: false,
        allowCodes: true,
        linkExpiryDays: 60,
        confirmationEmail: false,
    },
    budget: { totalCents: 0, currency: "AUD" },
};

const SETTINGS_LABELS: Record<SettingsKey, string> = {
    privacy: "privacy and retention settings",
    catering: "catering settings",
    wedding: "wedding details",
    invitation: "invitation template",
    website: "published website content",
    website_draft: "website draft",
    rsvp: "RSVP settings",
    budget: "budget settings",
};

export async function getSettings<K extends SettingsKey>(db: D1Database, key: K): Promise<SettingsDocuments[K]> {
    const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
    const stored = parseJson<Partial<SettingsDocuments[K]>>(row?.value, {});
    const merged = { ...SETTINGS_DEFAULTS[key], ...stored };
    const parsed = SETTINGS_SCHEMAS[key].safeParse(merged);
    // Stored data that no longer validates falls back to defaults rather than breaking pages.
    return (parsed.success ? parsed.data : SETTINGS_DEFAULTS[key]) as SettingsDocuments[K];
}

export async function saveSettings<K extends SettingsKey>(db: D1Database, key: K, value: unknown, actor: string): Promise<SettingsDocuments[K]> {
    const parsed = SETTINGS_SCHEMAS[key].parse(value) as SettingsDocuments[K];
    const before = await getSettings(db, key);
    const changes = diff(before as unknown as Record<string, unknown>, parsed as unknown as Record<string, unknown>);
    await db.batch([
        db
            .prepare(
                `INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?3, updated_by = ?4`,
            )
            .bind(key, JSON.stringify(parsed), nowIso(), actor),
        auditStatement(db, {
            actor,
            action: "settings.update",
            entityType: "settings",
            entityId: key,
            summary: `Updated ${SETTINGS_LABELS[key]}`,
            changes,
        }),
    ]);
    return parsed;
}
