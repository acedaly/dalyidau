// The portable export format for Daly Knowledge, "daly.knowledge.export.v1". One JSON document
// holds a space (or one object) with everything needed to rebuild it: types and their property
// schemas, objects with their editor documents (daly.doc.v1, not flattened text), tags, every
// relation, collections, pins, templates, saved views, the exporter's favourites, revisions and
// the audit trail. See docs/KNOWLEDGE_ENGINE.md#export.
//
// The schema is the contract: the Worker builds exports that satisfy it, and anything reading an
// export (the round-trip restore, scripts/lib/knowledge-export-check.mjs, a future importer)
// validates against it first. Newer versions are recognised and refused with a clear message.
import { z } from "zod";
import { CONTENT_FORMAT } from "./content";
import { typeSchemaSchema } from "./properties";

export const EXPORT_FORMAT = "daly.knowledge.export.v1";
const FORMAT_PATTERN = /^daly\.knowledge\.export\.v(\d+)$/;

const id = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[a-z0-9]{14}$`));
const iso = z.string().min(10).max(40);
const email = z.string().min(3).max(254);
const json = z.unknown();
const propertyValue = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]);

export const exportedType = z.object({
    id: id("kty"),
    name: z.string(),
    slug: z.string(),
    icon: z.string(),
    description: z.string(),
    schema: typeSchemaSchema,
    sortOrder: z.number().int(),
    archivedAt: iso.nullable(),
    version: z.number().int().min(1),
    createdBy: email,
    createdAt: iso,
    updatedAt: iso,
});

export const exportedObject = z.object({
    id: id("kob"),
    typeId: id("kty"),
    title: z.string().max(300),
    contentFormat: z.literal(CONTENT_FORMAT),
    /** The editor document, exactly as stored. */
    content: json,
    properties: z.record(z.string(), propertyValue),
    status: z.enum(["active", "archived", "trashed"]),
    inInbox: z.boolean(),
    /** The calendar date of a daily note (YYYY-MM-DD in the space's time zone when it was created). */
    dailyDate: z.string().nullable(),
    tags: z.array(z.string()),
    /** Where it was imported from, if it was: keeps future imports idempotent. */
    source: z.object({ system: z.string(), id: z.string() }).nullable(),
    version: z.number().int().min(1),
    createdBy: email,
    createdAt: iso,
    updatedBy: email,
    updatedAt: iso,
    archivedAt: iso.nullable(),
    trashedAt: iso.nullable(),
    trashedBy: email.nullable(),
});

export const exportedRelation = z.object({
    id: id("krl"),
    sourceId: id("kob"),
    targetId: id("kob"),
    relationType: z.string().min(1).max(40),
    /** content and property relations are derived from documents and properties; manual ones only exist here. */
    origin: z.enum(["manual", "content", "property"]),
    createdBy: email,
    createdAt: iso,
});

export const exportedCollection = z.object({
    id: id("kcl"),
    name: z.string(),
    description: z.string(),
    sortOrder: z.number().int(),
    archivedAt: iso.nullable(),
    version: z.number().int().min(1),
    createdBy: email,
    createdAt: iso,
    updatedBy: email,
    updatedAt: iso,
    items: z.array(z.object({ objectId: id("kob"), position: z.number(), pinnedAt: iso.nullable(), addedBy: email, addedAt: iso })),
});

export const exportedTemplate = z.object({
    id: id("ktp"),
    typeId: id("kty"),
    name: z.string(),
    description: z.string(),
    title: z.string(),
    content: json,
    properties: z.record(z.string(), propertyValue),
    isDefault: z.boolean(),
    archivedAt: iso.nullable(),
    version: z.number().int().min(1),
    createdBy: email,
    createdAt: iso,
    updatedBy: email,
    updatedAt: iso,
});

export const exportedSavedView = z.object({
    id: id("kvw"),
    name: z.string(),
    /** Shared with the space, or private to the person who exported. Other people's private views are never exported. */
    shared: z.boolean(),
    definition: json,
    createdBy: email,
    createdAt: iso,
    updatedAt: iso,
});

export const exportedRevision = z.object({
    id: id("krv"),
    objectId: id("kob"),
    version: z.number().int().min(1),
    kind: z.enum(["create", "edit", "restore", "import"]),
    typeId: id("kty"),
    title: z.string(),
    content: json,
    properties: z.record(z.string(), propertyValue),
    changedBy: email,
    startedAt: iso,
    changedAt: iso,
});

export const exportedAudit = z.object({
    at: iso,
    actor: email,
    action: z.string(),
    entityType: z.string(),
    entityId: z.string().nullable(),
    summary: z.string(),
    changes: json.nullable(),
});

export const knowledgeExportSchema = z.object({
    format: z.literal(EXPORT_FORMAT),
    contentFormat: z.literal(CONTENT_FORMAT),
    exportedAt: iso,
    exportedBy: email,
    /** "space": everything in the space. "object": one object, its type and its links (linked objects by title only). */
    scope: z.enum(["space", "object"]),
    includes: z.object({ revisions: z.boolean(), audit: z.boolean() }),
    space: z.object({
        id: id("ksp"),
        name: z.string(),
        kind: z.enum(["personal", "shared"]),
        timeZone: z.string(),
        createdAt: iso,
    }),
    /** Shared spaces only: who belongs and their role. Emails and roles, nothing else. */
    members: z.array(z.object({ email, role: z.enum(["owner", "editor", "viewer"]) })),
    types: z.array(exportedType),
    objects: z.array(exportedObject),
    relations: z.array(exportedRelation),
    /** Object exports: the objects at the other end of its links, so references stay readable. */
    linkedObjects: z.array(z.object({ id: id("kob"), title: z.string(), typeId: id("kty") })),
    collections: z.array(exportedCollection),
    pins: z.array(z.object({ objectId: id("kob"), position: z.number(), pinnedBy: email, pinnedAt: iso })),
    templates: z.array(exportedTemplate),
    savedViews: z.array(exportedSavedView),
    /** The exporter's own favourites; nobody else's. */
    favourites: z.array(z.object({ objectId: id("kob"), position: z.number(), createdAt: iso })),
    revisions: z.array(exportedRevision),
    audit: z.array(exportedAudit),
});
export type KnowledgeExport = z.infer<typeof knowledgeExportSchema>;

export class ExportFormatError extends Error {}

/**
 * Validates an export: recognises the format and version first, so a newer export gets a clear
 * refusal rather than a list of schema errors, then checks the whole document and that every
 * reference inside it resolves. Throws ExportFormatError.
 */
export function parseKnowledgeExport(input: unknown): KnowledgeExport {
    const format = (input as { format?: unknown } | null)?.format;
    const match = typeof format === "string" ? FORMAT_PATTERN.exec(format) : null;
    if (!match) throw new ExportFormatError("This isn't a Daly Knowledge export");
    if (Number(match[1]) !== 1) throw new ExportFormatError(`This export uses format version ${match[1]}, which this version can't read`);
    const parsed = knowledgeExportSchema.safeParse(input);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new ExportFormatError(`The export is invalid at ${issue.path.join(".") || "the top level"}: ${issue.message}`);
    }
    const data = parsed.data;
    const problems = exportReferenceProblems(data);
    if (problems.length) throw new ExportFormatError(`The export's references don't resolve: ${problems.slice(0, 3).join("; ")}`);
    return data;
}

/** References inside an export that point at nothing in it. Empty for a consistent export. */
export function exportReferenceProblems(data: KnowledgeExport): string[] {
    const problems: string[] = [];
    const types = new Set(data.types.map((t) => t.id));
    const objects = new Set(data.objects.map((o) => o.id));
    const linkable = new Set([...objects, ...data.linkedObjects.map((o) => o.id)]);
    const unique = (label: string, ids: string[]) => {
        if (new Set(ids).size !== ids.length) problems.push(`duplicate ${label} ids`);
    };
    unique("type", data.types.map((t) => t.id));
    unique("object", data.objects.map((o) => o.id));
    unique("relation", data.relations.map((r) => r.id));
    for (const o of data.objects) if (!types.has(o.typeId)) problems.push(`object ${o.id} has an unknown type`);
    for (const r of data.relations) {
        const inside = data.scope === "space" ? objects : linkable;
        if (!inside.has(r.sourceId) || !inside.has(r.targetId)) problems.push(`relation ${r.id} points outside the export`);
    }
    for (const c of data.collections) for (const item of c.items) if (!objects.has(item.objectId)) problems.push(`collection ${c.id} holds an unknown object`);
    for (const p of data.pins) if (!objects.has(p.objectId)) problems.push(`a pin points at an unknown object`);
    for (const f of data.favourites) if (!objects.has(f.objectId)) problems.push(`a favourite points at an unknown object`);
    for (const t of data.templates) if (!types.has(t.typeId)) problems.push(`template ${t.id} has an unknown type`);
    for (const r of data.revisions) if (!objects.has(r.objectId)) problems.push(`revision ${r.id} belongs to an unknown object`);
    const dailyDates = data.objects.filter((o) => o.dailyDate).map((o) => o.dailyDate);
    if (new Set(dailyDates).size !== dailyDates.length) problems.push("two daily notes share a date");
    return problems;
}
