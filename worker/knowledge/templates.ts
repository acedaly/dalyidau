// Templates: a starting title, document (daly.doc.v1, like any object) and property values for one
// object type. Creating an object from a template copies them, so the new object is independent:
// editing either never changes the other. A template's values are checked against its type when
// it's saved, and again against the type as it is now when it's used, because types change: values
// for properties that no longer exist or no longer validate are left out, and the caller is told.
import type { D1Database } from "@cloudflare/workers-types";
import { z } from "zod";
import { EMPTY_DOCUMENT, type DocNode, DocumentError, normaliseDocument } from "../../src/shared/knowledge/content";
import { formatDailyTitle, localDate } from "../../src/shared/knowledge/dates";
import { type PropertyValues, checkValue, isReferenceType } from "../../src/shared/knowledge/properties";
import type { KnowledgeTemplate, KnowledgeType } from "../../src/shared/knowledge/types";
import type { PortalUser } from "../../src/shared/portal/types";
import { isGuardFailure, newId, nowIso, parseJson, requireChange } from "../portal/db";
import { HttpError } from "../portal/http";
import { notFound, requireSpace } from "./access";
import { knowledgeAudit } from "./audit";
import { getTypeInSpace } from "./types";

interface TemplateRow {
    id: string;
    space_id: string;
    type_id: string;
    name: string;
    description: string;
    title: string;
    content_json: string;
    properties_json: string;
    is_default: number;
    archived_at: string | null;
    version: number;
    updated_by: string;
    updated_at: string;
}

export const MAX_TEMPLATES = 500;

const toTemplate = (row: TemplateRow): KnowledgeTemplate => ({
    id: row.id,
    spaceId: row.space_id,
    typeId: row.type_id,
    name: row.name,
    description: row.description,
    title: row.title,
    content: parseJson<DocNode>(row.content_json, EMPTY_DOCUMENT),
    properties: parseJson<PropertyValues>(row.properties_json, {}),
    isDefault: !!row.is_default,
    archived: !!row.archived_at,
    version: row.version,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
});

export async function listTemplates(db: D1Database, spaceId: string): Promise<KnowledgeTemplate[]> {
    const rows = await db
        .prepare("SELECT * FROM knowledge_templates WHERE space_id = ? ORDER BY archived_at IS NOT NULL, name COLLATE NOCASE LIMIT 500")
        .bind(spaceId)
        .all<TemplateRow>();
    return rows.results.map(toTemplate);
}

/** A template the caller can see (any member of its space), or 404. */
export async function getTemplate(db: D1Database, user: PortalUser, templateId: string, minimum: "viewer" | "editor" = "viewer") {
    const row = await db.prepare("SELECT * FROM knowledge_templates WHERE id = ?").bind(templateId).first<TemplateRow>();
    if (!row) throw notFound();
    await requireSpace(db, user, row.space_id, minimum);
    return toTemplate(row);
}

const parseDoc = (content: unknown) => {
    try {
        return normaliseDocument(content ?? EMPTY_DOCUMENT).doc;
    } catch (error) {
        if (error instanceof DocumentError) throw new HttpError(422, "validation", error.message);
        throw error;
    }
};

const isEmpty = (value: unknown) => value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0);

/**
 * Checks template values against a type. Templates only hold starting values, so nothing is
 * required, and references are refused: a template that pointed at one particular object would
 * quietly attach it to everything made from the template.
 */
function templateValues(type: KnowledgeType, raw: Record<string, unknown>): PropertyValues {
    const values: PropertyValues = {};
    for (const [key, value] of Object.entries(raw)) {
        if (isEmpty(value)) continue;
        const def = type.schema.properties.find((d) => d.key === key);
        if (!def) throw new HttpError(422, "validation", `${type.name} has no property “${key}”`);
        if (isReferenceType(def.type)) throw new HttpError(422, "validation", `${def.label}: templates can't fill in links to other objects`);
        const checked = checkValue(def, value);
        if (checked.error !== undefined) throw new HttpError(422, "validation", `${def.label}: ${checked.error}`);
        values[key] = checked.value;
    }
    return values;
}

const templateInput = z.object({
    typeId: z.string().max(40),
    name: z.string().trim().min(1, "Give the template a name").max(80),
    description: z.string().trim().max(300).default(""),
    title: z.string().trim().max(300).default(""),
    content: z.unknown().optional(),
    properties: z.record(z.string(), z.unknown()).default({}),
    isDefault: z.boolean().default(false),
});

/** Statements that make `templateId` the only default for its type (or clear it). */
const defaultStatements = (db: D1Database, typeId: string, templateId: string, isDefault: boolean) =>
    isDefault ? [db.prepare("UPDATE knowledge_templates SET is_default = 0 WHERE type_id = ? AND id <> ? AND is_default = 1").bind(typeId, templateId)] : [];

export async function createTemplate(db: D1Database, user: PortalUser, spaceId: string, input: unknown): Promise<KnowledgeTemplate> {
    await requireSpace(db, user, spaceId, "editor");
    const body = templateInput.parse(input);
    const count = await db.prepare("SELECT COUNT(*) AS n FROM knowledge_templates WHERE space_id = ?").bind(spaceId).first<{ n: number }>();
    if ((count?.n ?? 0) >= MAX_TEMPLATES) throw new HttpError(422, "validation", `A space can have up to ${MAX_TEMPLATES} templates`);
    const type = await getTypeInSpace(db, spaceId, body.typeId);
    const content = parseDoc(body.content);
    const values = templateValues(type, body.properties);
    const id = newId("ktp");
    const now = nowIso();
    await db.batch([
        ...defaultStatements(db, type.id, id, body.isDefault),
        db
            .prepare(
                `INSERT INTO knowledge_templates (id, space_id, type_id, name, description, title, content_json, properties_json, is_default, created_by, updated_by, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
                id,
                spaceId,
                type.id,
                body.name,
                body.description,
                body.title,
                JSON.stringify(content),
                JSON.stringify(values),
                body.isDefault ? 1 : 0,
                user.email,
                user.email,
                now,
                now,
            ),
        knowledgeAudit(db, { spaceId, actor: user.email, action: "template.create", entityType: "template", entityId: id, summary: "Created a template" }),
    ]);
    return getTemplate(db, user, id);
}

const templatePatch = templateInput.partial().omit({ typeId: true }).extend({ version: z.number().int().min(1), archived: z.boolean().optional() }).strict();

const templateConflict = () => new HttpError(409, "conflict", "Someone else changed this template. Reload to see their changes.");

/** Saves a template, refusing (409) if anyone saved it since `version`. */
export async function updateTemplate(db: D1Database, user: PortalUser, templateId: string, input: unknown): Promise<KnowledgeTemplate> {
    const current = await getTemplate(db, user, templateId, "editor");
    const body = templatePatch.parse(input);
    if (body.version !== current.version) throw templateConflict();
    const type = await getTypeInSpace(db, current.spaceId, current.typeId);
    const content = body.content === undefined ? current.content : parseDoc(body.content);
    const values = body.properties === undefined ? current.properties : templateValues(type, body.properties);
    const archived = body.archived ?? current.archived;
    // An archived template can't stay the default.
    const isDefault = archived ? false : (body.isDefault ?? current.isDefault);
    const now = nowIso();
    try {
        await db.batch([
            ...defaultStatements(db, current.typeId, templateId, isDefault),
            db
                .prepare(
                    `UPDATE knowledge_templates SET name = ?, description = ?, title = ?, content_json = ?, properties_json = ?, is_default = ?,
                        archived_at = CASE WHEN ? THEN COALESCE(archived_at, ?) ELSE NULL END, updated_by = ?, updated_at = ?, version = version + 1
                     WHERE id = ? AND version = ?`,
                )
                .bind(
                    body.name ?? current.name,
                    body.description ?? current.description,
                    body.title ?? current.title,
                    JSON.stringify(content),
                    JSON.stringify(values),
                    isDefault ? 1 : 0,
                    archived ? 1 : 0,
                    now,
                    user.email,
                    now,
                    templateId,
                    body.version,
                ),
            requireChange(db),
            knowledgeAudit(db, {
                spaceId: current.spaceId,
                actor: user.email,
                action: body.archived === true ? "template.archive" : "template.update",
                entityType: "template",
                entityId: templateId,
                summary: "Changed a template",
                changes: { fields: Object.keys(body).filter((k) => k !== "version") },
            }),
        ]);
    } catch (error) {
        if (isGuardFailure(error)) throw templateConflict();
        throw error;
    }
    return getTemplate(db, user, templateId);
}

/** Deleting a template never touches the objects made from it: they were copies. */
export async function deleteTemplate(db: D1Database, user: PortalUser, templateId: string): Promise<void> {
    const current = await getTemplate(db, user, templateId, "editor");
    await db.batch([
        db.prepare("DELETE FROM knowledge_templates WHERE id = ?").bind(templateId),
        knowledgeAudit(db, {
            spaceId: current.spaceId,
            actor: user.email,
            action: "template.delete",
            entityType: "template",
            entityId: templateId,
            summary: "Deleted a template",
        }),
    ]);
}

export interface TemplateStart {
    typeId: string;
    title: string;
    content: DocNode;
    properties: PropertyValues;
    /** Values the template had that couldn't be used with the type as it is now. */
    notices: string[];
}

/** {date} in a template title becomes today's date in the space, e.g. "Meeting {date}". */
const fillTitle = (title: string, timeZone: string) => title.replace(/\{date\}/g, () => formatDailyTitle(localDate(new Date(), timeZone)));

/**
 * What a template contributes to a new object, re-checked against the type as it is now. Values for
 * removed properties, or that no longer validate (an option deleted, a rule tightened), are left out
 * with a notice rather than stored invalid or refusing the whole object.
 */
export async function templateStart(db: D1Database, spaceId: string, timeZone: string, templateId: string): Promise<TemplateStart> {
    const row = await db.prepare("SELECT * FROM knowledge_templates WHERE id = ? AND space_id = ?").bind(templateId, spaceId).first<TemplateRow>();
    if (!row) throw new HttpError(422, "validation", "That template isn't in this space");
    if (row.archived_at) throw new HttpError(422, "validation", "That template is archived");
    const template = toTemplate(row);
    const type = await getTypeInSpace(db, spaceId, template.typeId);
    const properties: PropertyValues = {};
    const notices: string[] = [];
    for (const [key, value] of Object.entries(template.properties)) {
        const def = type.schema.properties.find((d) => d.key === key);
        if (!def) {
            notices.push(`The template's value for “${key}” wasn't used: ${type.name} no longer has that property.`);
            continue;
        }
        const checked = checkValue(def, value);
        if (checked.error !== undefined || isReferenceType(def.type)) {
            notices.push(`The template's value for ${def.label} wasn't used: it's no longer valid (${checked.error ?? "links aren't copied"}).`);
            continue;
        }
        properties[key] = checked.value;
    }
    return { typeId: type.id, title: fillTitle(template.title, timeZone), content: template.content, properties, notices };
}

/** The type's default template, if it has one that isn't archived. */
export async function defaultTemplateId(db: D1Database, typeId: string): Promise<string | null> {
    const row = await db
        .prepare("SELECT id FROM knowledge_templates WHERE type_id = ? AND is_default = 1 AND archived_at IS NULL")
        .bind(typeId)
        .first<{ id: string }>();
    return row?.id ?? null;
}
