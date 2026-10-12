// Settings documents (wedding details, website content, RSVP and budget). Each is a single JSON
// row validated on write and merged over defaults on read, so adding a field never breaks old data.
import type { D1Database } from "@cloudflare/workers-types";
import { z } from "zod";
import type { SettingsDocuments, SettingsKey } from "../../src/shared/portal/types";
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

export const SETTINGS_SCHEMAS = {
    wedding: z.object({
        partnerOne: text(60),
        partnerTwo: text(60),
        date: isoDate,
        location: text(120),
        timeZone,
    }),
    website: z.object({
        heroEyebrow: text(80),
        heroTitle: text(120),
        heroSubtitle: text(240),
        welcome: text(4000),
        sections: z.array(z.object({ id: z.string().regex(/^[a-z0-9-]{1,40}$/), title: text(80).min(1), body: text(6000) })).max(20),
        contactEmail: z.union([z.literal(""), z.string().trim().email()]),
        noindex: z.boolean(),
    }),
    rsvp: z.object({
        externalUrl: httpsUrl,
        deadline: isoDate,
        collectDietary: z.boolean(),
        collectMessage: z.boolean(),
    }),
    budget: z.object({
        totalCents: z.number().int().min(0).max(100_000_000_00),
        currency: z.string().regex(/^[A-Z]{3}$/),
    }),
} satisfies { [K in SettingsKey]: z.ZodType<SettingsDocuments[K]> };

/** Placeholders only. Real names, dates and places are the couple's to enter in the portal. */
export const SETTINGS_DEFAULTS: SettingsDocuments = {
    wedding: { partnerOne: "Partner One", partnerTwo: "Partner Two", date: "", location: "", timeZone: "Australia/Sydney" },
    website: {
        heroEyebrow: "Together with their families",
        heroTitle: "",
        heroSubtitle: "We can't wait to celebrate with you.",
        welcome: "",
        sections: [
            { id: "travel", title: "Getting there", body: "" },
            { id: "stay", title: "Where to stay", body: "" },
            { id: "faq", title: "Questions", body: "" },
        ],
        contactEmail: "",
        noindex: true,
    },
    rsvp: { externalUrl: "", deadline: "", collectDietary: true, collectMessage: true },
    budget: { totalCents: 0, currency: "AUD" },
};

const SETTINGS_LABELS: Record<SettingsKey, string> = {
    wedding: "wedding details",
    website: "website content",
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
