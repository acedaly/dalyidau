import type { Block, CapacitiesObject, PropertyDefinition, PropertyValue, Structure } from "./types";

/** Property names we look for on the Blog Post type (case-insensitive, first match wins). */
const PROPERTY_NAMES = {
    status: ["status", "publication status"],
    slug: ["slug", "url slug"],
    subtitle: ["subtitle"],
    summary: ["summary", "excerpt", "description"],
    category: ["category"],
    tags: ["tags", "topics"],
    featuredImage: ["featured image", "cover image", "cover", "image"],
    publishDate: ["publish date", "publication date", "published date", "published"],
    updatedDate: ["updated date", "last revised", "updated"],
    featured: ["featured"],
    content: ["content", "body"],
} as const;

export type MappedKey = keyof typeof PROPERTY_NAMES;

export interface BlogSchema {
    structureId: string;
    statusId: string;
    publishedOptionIds: Set<string>;
    props: Partial<Record<MappedKey, PropertyDefinition>>;
}

export class SchemaError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "SchemaError";
    }
}

/**
 * Finds the configured Blog Post structure and its properties. Throws (and the sync aborts
 * without changing anything) if the type or a usable Status property cannot be found.
 */
export const resolveSchema = (structures: Structure[], opts: { structureId?: string; structureName: string }): BlogSchema => {
    let structure: Structure | undefined;
    if (opts.structureId) {
        structure = structures.find((s) => s.id === opts.structureId);
        if (!structure) throw new SchemaError(`Structure ${opts.structureId} not found in the space`);
    } else {
        const name = opts.structureName.trim().toLowerCase();
        const matches = structures.filter((s) => s.title?.trim().toLowerCase() === name || s.pluralName?.trim().toLowerCase() === name);
        if (matches.length === 0) throw new SchemaError(`No object type named "${opts.structureName}" in the space`);
        if (matches.length > 1) throw new SchemaError(`More than one object type is named "${opts.structureName}"; set CAPACITIES_STRUCTURE_ID`);
        structure = matches[0];
    }

    const props: BlogSchema["props"] = {};
    for (const key of Object.keys(PROPERTY_NAMES) as MappedKey[]) {
        const names: readonly string[] = PROPERTY_NAMES[key];
        for (const name of names) {
            const match = structure.propertyDefinitions.find((def) => def.name?.trim().toLowerCase() === name);
            if (match) {
                props[key] = match;
                break;
            }
        }
    }
    // Capacities' built-in tags and description use fixed ids and may have empty names.
    if (!props.tags) props.tags = structure.propertyDefinitions.find((def) => def.id === "tags");
    if (!props.summary) props.summary = structure.propertyDefinitions.find((def) => def.id === "description");

    const status = props.status;
    if (!status) throw new SchemaError(`"${structure.title}" has no Status property`);
    if (status.type !== "label") throw new SchemaError(`Status must be a select (label) property, found ${status.type}`);
    if (status.multiple) throw new SchemaError("Status must be single-select");
    const publishedOptionIds = new Set((status.labelSet ?? []).filter((o) => o.name.trim().toLowerCase() === "published").map((o) => o.id));
    if (publishedOptionIds.size !== 1) throw new SchemaError('Status must have exactly one option named "Published"');

    return { structureId: structure.id, statusId: status.id, publishedOptionIds, props };
};

export type StatusResult = { kind: "published" } | { kind: "not-published"; label: string } | { kind: "unknown"; reason: string };

/**
 * Publication is decided only by the Status label. Anything we cannot read confidently is
 * "unknown", which never publishes new content.
 */
export const readStatus = (object: CapacitiesObject, schema: BlogSchema): StatusResult => {
    const value = object.properties?.[schema.statusId];
    if (!value) return { kind: "unknown", reason: "Status property missing from API response" };
    if (value.type !== "label" || !Array.isArray(value.label)) return { kind: "unknown", reason: `Status has unexpected type ${value.type}` };
    if (value.label.length > 1) return { kind: "unknown", reason: "Status has more than one value" };
    if (value.label.length === 0) return { kind: "not-published", label: "none" };
    const option = value.label[0];
    if (schema.publishedOptionIds.has(option.id)) return { kind: "published" };
    return { kind: "not-published", label: (option.name || option.id).toLowerCase() };
};

const prop = (object: CapacitiesObject, schema: BlogSchema, key: MappedKey): PropertyValue | undefined => {
    const def = schema.props[key];
    return def ? object.properties?.[def.id] : undefined;
};

export const textValue = (value: PropertyValue | undefined): string | null => {
    if (!value) return null;
    let text: string | null = null;
    switch (value.type) {
        case "title":
            text = value.title?.value ?? null;
            break;
        case "text":
            text = value.text?.value ?? null;
            break;
        case "url":
            text = value.url?.value ?? null;
            break;
        case "richText":
            text = (value.richText?.value ?? []).map((t) => t.text ?? "").join("");
            break;
        case "label":
            text = value.label?.[0]?.name ?? null;
            break;
        case "number":
            text = value.number?.value == null ? null : String(value.number.value);
            break;
    }
    text = text?.trim() ?? null;
    return text ? text : null;
};

const dateValue = (value: PropertyValue | undefined): string | null => {
    if (!value || value.type !== "date" || !value.date?.start) return null;
    const date = new Date(value.date.start);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

export interface MappedPost {
    title: string | null;
    slug: string | null;
    subtitle: string | null;
    summary: string | null;
    category: string | null;
    tagNames: string[];
    tagEntityIds: string[];
    featured: boolean;
    imageEntityId: string | null;
    imageUrl: string | null;
    publishDate: string | null;
    updatedDate: string | null;
    createdAt: string | null;
    lastUpdatedAt: string | null;
    blocks: Block[];
}

export const mapObject = (object: CapacitiesObject, schema: BlogSchema): MappedPost => {
    const tags = prop(object, schema, "tags");
    const image = prop(object, schema, "featuredImage");
    const featured = prop(object, schema, "featured");
    const created = Object.values(object.properties ?? {}).find((v) => v.type === "createdAt");
    const updated = Object.values(object.properties ?? {}).find((v) => v.type === "lastUpdatedAt");

    return {
        title: textValue(object.properties?.title),
        slug: textValue(prop(object, schema, "slug")),
        subtitle: textValue(prop(object, schema, "subtitle")),
        summary: textValue(prop(object, schema, "summary")),
        category: textValue(prop(object, schema, "category")),
        tagNames: tags?.type === "label" ? tags.label.map((o) => o.name.trim()).filter(Boolean) : [],
        tagEntityIds: tags?.type === "entity" ? tags.entity.map((e) => e.id) : [],
        featured: featured?.type === "boolean" ? featured.boolean?.value === true : false,
        imageEntityId: image?.type === "entity" ? (image.entity[0]?.id ?? null) : null,
        imageUrl: image?.type === "url" ? (image.url?.value ?? null) : null,
        publishDate: dateValue(prop(object, schema, "publishDate")),
        updatedDate: dateValue(prop(object, schema, "updatedDate")),
        createdAt: created?.type === "createdAt" ? created.createdAt.value : null,
        lastUpdatedAt: updated?.type === "lastUpdatedAt" ? updated.lastUpdatedAt.value : null,
        blocks: contentBlocks(object, schema),
    };
};

/** The article body is the object's block property: "Content" if named, otherwise the only/first one. */
const contentBlocks = (object: CapacitiesObject, schema: BlogSchema): Block[] => {
    const blocks = object.blocks ?? {};
    const named = schema.props.content?.id;
    if (named && Array.isArray(blocks[named])) return blocks[named];
    const keys = Object.keys(blocks);
    if (keys.length === 0) return [];
    return blocks[keys[0]] ?? [];
};
