// Custom properties for knowledge object types. Shared by the Worker, which is the authority and
// validates every value against the object's type, and the browser, which uses it for forms.
import { z } from "zod";

export const PROPERTY_TYPES = [
    "text",
    "long_text",
    "number",
    "currency",
    "date",
    "datetime",
    "checkbox",
    "select",
    "multi_select",
    "url",
    "email",
    "phone",
    "person",
    "object",
] as const;
export type PropertyType = (typeof PROPERTY_TYPES)[number];

export const PROPERTY_TYPE_LABELS: Record<PropertyType, string> = {
    text: "Text",
    long_text: "Long text",
    number: "Number",
    currency: "Currency",
    date: "Date",
    datetime: "Date and time",
    checkbox: "Checkbox",
    select: "Single select",
    multi_select: "Multi-select",
    url: "URL",
    email: "Email",
    phone: "Phone",
    person: "Person",
    object: "Object reference",
};

/** Properties whose values are ids of other objects in the same space. */
export const isReferenceType = (type: PropertyType) => type === "person" || type === "object";
/** The object type a person reference must point at. */
export const PERSON_TYPE_SLUG = "person";

export const MAX_PROPERTIES = 50;
export const MAX_OPTIONS = 100;
export const MAX_REFERENCES = 50;

const optionSchema = z.object({
    id: z
        .string()
        .trim()
        .regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, "Option ids are lower-case letters, numbers, - and _"),
    label: z.string().trim().min(1, "Give the option a label").max(60),
});
export type PropertyOption = z.infer<typeof optionSchema>;

export const propertyDefSchema = z.object({
    key: z
        .string()
        .trim()
        .regex(/^[a-z][a-z0-9_]{0,39}$/, "Keys start with a letter and use lower-case letters, numbers and _"),
    label: z.string().trim().min(1, "Give the property a name").max(60),
    type: z.enum(PROPERTY_TYPES),
    required: z.boolean().default(false),
    description: z.string().trim().max(200).default(""),
    /** Choices for select and multi-select. */
    options: z.array(optionSchema).max(MAX_OPTIONS).optional(),
    /** ISO 4217 code for currency properties. */
    currency: z
        .string()
        .regex(/^[A-Z]{3}$/)
        .optional(),
    /** For object references: only objects of this type may be chosen. */
    targetTypeId: z.string().max(40).nullable().optional(),
    /** For references and multi-select: whether more than one value is allowed. */
    multiple: z.boolean().optional(),
    default: z.unknown().optional(),
});
export type PropertyDef = z.infer<typeof propertyDefSchema>;

export const typeSchemaSchema = z.object({ properties: z.array(propertyDefSchema).max(MAX_PROPERTIES).default([]) }).superRefine((schema, ctx) => {
    const keys = new Set<string>();
    schema.properties.forEach((def, index) => {
        if (keys.has(def.key)) ctx.addIssue({ code: "custom", path: ["properties", index, "key"], message: `“${def.key}” is used twice` });
        keys.add(def.key);
        if (def.type === "select" || def.type === "multi_select") {
            if (!def.options?.length) ctx.addIssue({ code: "custom", path: ["properties", index, "options"], message: "Add at least one option" });
            const ids = new Set<string>();
            for (const option of def.options ?? []) {
                if (ids.has(option.id))
                    ctx.addIssue({ code: "custom", path: ["properties", index, "options"], message: `Option “${option.id}” is used twice` });
                ids.add(option.id);
            }
        }
        if (def.default !== undefined && def.default !== null) {
            if (isReferenceType(def.type)) ctx.addIssue({ code: "custom", path: ["properties", index, "default"], message: "References can't have a default" });
            else if (checkValue(def, def.default).error)
                ctx.addIssue({ code: "custom", path: ["properties", index, "default"], message: "The default isn't a valid value" });
        }
    });
});
export type TypeSchema = z.infer<typeof typeSchemaSchema>;

export type PropertyValue = string | number | boolean | string[];
export type PropertyValues = Record<string, PropertyValue>;

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const isRealDate = (value: string) => {
    const match = DATE.exec(value);
    if (!match) return false;
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    return date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() === Number(match[2]) - 1 && date.getUTCDate() === Number(match[3]);
};

const isHttpUrl = (value: string) => {
    try {
        const url = new URL(value);
        return url.protocol === "https:" || url.protocol === "http:";
    } catch {
        return false;
    }
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Checked = { value: PropertyValue; error?: undefined } | { value?: undefined; error: string };

/** Checks one non-null value against its definition and returns it normalised. */
export function checkValue(def: PropertyDef, raw: unknown): Checked {
    const text = (max: number): Checked => {
        if (typeof raw !== "string") return { error: "Enter text" };
        const value = raw.trim();
        return value.length > max ? { error: `Use ${max} characters or fewer` } : { value };
    };
    switch (def.type) {
        case "text":
            return text(500);
        case "long_text":
            return text(10_000);
        case "number":
            return typeof raw === "number" && Number.isFinite(raw) ? { value: raw } : { error: "Enter a number" };
        case "currency":
            return typeof raw === "number" && Number.isSafeInteger(raw) ? { value: raw } : { error: "Enter an amount in cents" };
        case "date":
            return typeof raw === "string" && isRealDate(raw) ? { value: raw } : { error: "Enter a date as YYYY-MM-DD" };
        case "datetime": {
            // A time with an explicit offset, stored in UTC.
            if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(raw))
                return { error: "Enter a date and time with a time zone" };
            const time = Date.parse(raw);
            return Number.isNaN(time) ? { error: "Enter a real date and time" } : { value: new Date(time).toISOString() };
        }
        case "checkbox":
            return typeof raw === "boolean" ? { value: raw } : { error: "Choose yes or no" };
        case "select":
            return typeof raw === "string" && def.options?.some((o) => o.id === raw) ? { value: raw } : { error: "Choose one of the options" };
        case "multi_select": {
            if (!Array.isArray(raw) || raw.length > MAX_OPTIONS) return { error: "Choose from the options" };
            const ids = [...new Set(raw)];
            return ids.every((id) => typeof id === "string" && def.options?.some((o) => o.id === id))
                ? { value: ids as string[] }
                : { error: "Choose from the options" };
        }
        case "url": {
            const checked = text(2000);
            return checked.error || isHttpUrl(checked.value as string) ? checked : { error: "Enter a web address starting with https://" };
        }
        case "email": {
            const checked = text(254);
            return checked.error || EMAIL.test(checked.value as string)
                ? { value: (checked.value as string).toLowerCase() }
                : { error: "Enter an email address" };
        }
        case "phone": {
            const checked = text(40);
            if (checked.error) return checked;
            const value = checked.value as string;
            const digits = value.replace(/\D/g, "").length;
            return /^\+?[\d\s().-]+$/.test(value) && digits >= 6 && digits <= 20 ? { value } : { error: "Enter a phone number" };
        }
        case "person":
        case "object": {
            const ids = typeof raw === "string" ? [raw] : raw;
            if (!Array.isArray(ids) || ids.length > MAX_REFERENCES || !ids.every((id) => typeof id === "string" && /^kob_[a-z0-9]{14}$/.test(id)))
                return { error: "Choose objects from this space" };
            const unique = [...new Set(ids as string[])];
            if (!def.multiple && unique.length > 1) return { error: "Choose one object" };
            return { value: unique };
        }
    }
}

export interface PropertyIssue {
    path: string;
    message: string;
}

const isEmpty = (value: unknown) => value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0);

/**
 * Applies a change to an object's properties. `changes` maps keys to new values; null or empty
 * clears a key. Keys the type doesn't define are refused, but values already stored for a property
 * the type no longer has are kept (so editing a type never destroys data). Required properties are
 * enforced on create, and can never be cleared afterwards.
 */
export function applyPropertyChanges(
    defs: readonly PropertyDef[],
    existing: PropertyValues,
    changes: Record<string, unknown>,
    mode: "create" | "update",
): { values: PropertyValues; issues: PropertyIssue[] } {
    const issues: PropertyIssue[] = [];
    const byKey = new Map(defs.map((def) => [def.key, def]));
    const values: PropertyValues = { ...existing };

    for (const [key, raw] of Object.entries(changes)) {
        const def = byKey.get(key);
        if (!def) {
            issues.push({ path: `properties.${key}`, message: "This type has no such property" });
            continue;
        }
        if (isEmpty(raw)) {
            if (def.required) issues.push({ path: `properties.${key}`, message: `${def.label} is required` });
            delete values[key];
            continue;
        }
        const checked = checkValue(def, raw);
        if (checked.error !== undefined) issues.push({ path: `properties.${key}`, message: `${def.label}: ${checked.error}` });
        else values[key] = checked.value;
    }

    if (mode === "create") {
        for (const def of defs) {
            if (values[def.key] === undefined && def.default !== undefined && def.default !== null) {
                const checked = checkValue(def, def.default);
                if (checked.error === undefined) values[def.key] = checked.value;
            }
            if (def.required && isEmpty(values[def.key]) && !issues.some((i) => i.path === `properties.${def.key}`))
                issues.push({ path: `properties.${def.key}`, message: `${def.label} is required` });
        }
    }
    return { values, issues };
}

/** Every object id referenced by a reference property, keyed by property. */
export const referencedIds = (defs: readonly PropertyDef[], values: PropertyValues) =>
    defs.filter((def) => isReferenceType(def.type) && Array.isArray(values[def.key])).map((def) => ({ def, ids: values[def.key] as string[] }));
