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
    visible: z.boolean().default(true),
});

const website = z.object({
    heroEyebrow: text(80),
    heroTitle: text(120),
    heroSubtitle: text(240),
    heroImageId: z.string().max(40).nullable().default(null),
    welcome: text(4000),
    sections: z.array(section).max(20),
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
    }),
    budget: z.object({
        totalCents: z.number().int().min(0).max(100_000_000_00),
        currency: z.string().regex(/^[A-Z]{3}$/),
    }),
} satisfies { [K in SettingsKey]: z.ZodType<SettingsDocuments[K], unknown> };

/**
 * Defaults. The couple's names, date, venue and RSVP link are known; everything not yet confirmed
 * (timings, the bus, travel) starts as a hidden draft so nothing is published by assumption.
 */
const DEFAULT_WEBSITE: WebsiteContent = {
    heroEyebrow: "Together with their families",
    heroTitle: "",
    heroSubtitle: "invite you to celebrate their wedding at Rhino Lodge.",
    heroImageId: null,
    welcome: "",
    sections: [
        { id: "story", kind: "story", title: "Our story", body: "", items: [], visible: false },
        {
            id: "details",
            kind: "details",
            title: "The day",
            body: "Our ceremony and reception will both be held at Rhino Lodge on Saturday 23 October 2027. Timings will follow.",
            items: [],
            visible: true,
        },
        {
            id: "stay",
            kind: "accommodation",
            title: "Where to stay",
            body: "Accommodation at Rhino Lodge is first in, first served, so book early if you'd like to stay on site. Guests arrange their own accommodation; if Rhino Lodge is full, the places below are good alternatives.",
            items: [{ title: "Rhino Lodge", body: "On-site accommodation, first in, first served. Contact Rhino Lodge directly to book.", url: "" }],
            visible: true,
        },
        { id: "travel", kind: "travel", title: "Getting there", body: "", items: [], visible: false },
        {
            id: "bus",
            kind: "transport",
            title: "Courtesy bus",
            body: "We're hoping to arrange a courtesy bus. Details will be posted here once confirmed.",
            items: [],
            visible: false,
        },
        { id: "children", kind: "children", title: "Children and families", body: "Children are very welcome.", items: [], visible: true },
        { id: "dress", kind: "dress", title: "Dress code", body: "Cocktail / smart casual.", items: [], visible: true },
        { id: "gifts", kind: "registry", title: "Gifts", body: "", items: [], visible: false },
        { id: "faq", kind: "faq", title: "Questions", body: "", items: [], visible: false },
    ],
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
    wedding: { partnerOne: "Aidan", partnerTwo: "Amelia", date: "2027-10-23", location: "Rhino Lodge", timeZone: "Australia/Sydney" },
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
