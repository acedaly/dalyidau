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

/**
 * Defaults. The couple's names, date, venue and RSVP link are known; everything not yet confirmed
 * (timings, the bus, parking, other accommodation) starts hidden or says it will follow, so nothing
 * is published by assumption. The venue address comes from public listings: confirm it before publishing.
 */
const DEFAULT_WEBSITE: WebsiteContent = {
    heroEyebrow: "Together with our families",
    heroTitle: "",
    heroSubtitle: "We're getting married",
    heroImageId: null,
    welcome:
        "We're getting married, and we'd love for you to celebrate with us.\n\nWe're looking forward to a relaxed country celebration at Rhino Lodge with our favourite people, good food, a few drinks and plenty of memories. Everything you need to know is on this page, and if anything's unclear, just ask.",
    sections: [
        { id: "story", kind: "story", title: "Our story", body: "", items: [], imageId: null, visible: false },
        {
            id: "details",
            kind: "details",
            title: "The big day",
            body: "Our ceremony and reception will both be at Rhino Lodge, so once you've arrived there's nowhere else you need to be. We'll share timings here as soon as they're confirmed.",
            items: [],
            imageId: null,
            visible: true,
        },
        {
            id: "venue",
            kind: "venue",
            title: "Rhino Lodge",
            body: "We chose Rhino Lodge for its big country skies, its relaxed feel and the chance to have everyone together in one place, from the ceremony to the last dance.",
            items: [
                {
                    title: "Address",
                    body: "14L Camp Road, Dubbo NSW 2830",
                    url: "https://www.google.com/maps/search/?api=1&query=Rhino+Lodge%2C+14L+Camp+Road%2C+Dubbo+NSW+2830",
                },
            ],
            imageId: null,
            visible: true,
        },
        {
            id: "stay",
            kind: "accommodation",
            title: "Where to stay",
            body: "Rhino Lodge has limited on-site accommodation, available on a first-in, first-served basis, so if you'd like to stay on site we'd suggest booking early. You're also welcome to make your own arrangements. We'll add a few nearby options here soon.",
            items: [
                {
                    title: "Rhino Lodge",
                    body: "On-site accommodation is limited and available first in, first served. Contact Rhino Lodge directly to book.",
                    url: "",
                },
            ],
            imageId: null,
            visible: true,
        },
        {
            id: "travel",
            kind: "travel",
            title: "Getting there",
            body: "Directions and parking details will be posted here closer to the day.",
            items: [],
            imageId: null,
            visible: false,
        },
        {
            id: "bus",
            kind: "transport",
            title: "Courtesy bus",
            body: "We're looking into a courtesy bus between Dubbo and Rhino Lodge. Nothing is confirmed yet, so please don't rely on it when planning. We'll update this page as soon as we know more.",
            items: [],
            imageId: null,
            visible: false,
        },
        {
            id: "children",
            kind: "children",
            title: "Bring the kids",
            body: "Children are very welcome. We'd love to celebrate with the whole family.\n\nWhen you RSVP you can reply for each child in your household and let us know about any dietary needs.",
            items: [],
            imageId: null,
            visible: true,
        },
        {
            id: "dress",
            kind: "dress",
            title: "What to wear",
            body: "Cocktail / smart casual. It's a country venue, so choose shoes you'll be comfortable in on grass, and bring a layer for when the sun goes down.",
            items: [],
            imageId: null,
            visible: true,
        },
        { id: "gifts", kind: "registry", title: "Gifts", body: "", items: [], imageId: null, visible: false },
        {
            id: "faq",
            kind: "faq",
            title: "Good to know",
            body: "",
            items: [
                {
                    title: "What should I wear?",
                    body: "Cocktail / smart casual. Comfortable shoes for grass are a good idea, plus a layer for the evening.",
                    url: "",
                },
                {
                    title: "Can we bring the kids?",
                    body: "Yes, please do. Children are very welcome, and you can RSVP for each of them individually.",
                    url: "",
                },
                {
                    title: "Is there accommodation at the venue?",
                    body: "Rhino Lodge has limited on-site accommodation, available first in, first served. Contact the lodge directly to book. You're also welcome to stay elsewhere.",
                    url: "",
                },
                {
                    title: "When do I need to RSVP by?",
                    body: "Please reply by the date on your invitation. You can update your RSVP online until then if your plans change.",
                    url: "",
                },
                {
                    title: "What if my dietary requirements change?",
                    body: "Just open your invitation link again and update your RSVP, or let us know directly.",
                    url: "",
                },
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
    website: DEFAULT_WEBSITE,
    website_draft: DEFAULT_WEBSITE,
    rsvp: {
        externalUrl: "https://sayi.do/aidanandamelia2258/",
        deadline: "",
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
