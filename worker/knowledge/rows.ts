// Row mapping shared by the object, search and page loaders.
import { type DocNode, EMPTY_DOCUMENT } from "../../src/shared/knowledge/content";
import type { PropertyValues } from "../../src/shared/knowledge/properties";
import type { KnowledgeObject, KnowledgeObjectSummary, ObjectStatus } from "../../src/shared/knowledge/types";
import { parseJson } from "../portal/db";

export interface SummaryRow {
    id: string;
    space_id: string;
    type_id: string;
    title: string;
    status: ObjectStatus;
    in_inbox: number;
    daily_date: string | null;
    excerpt: string;
    tags_json: string | null;
    created_at: string;
    updated_at: string;
    updated_by: string;
}

export interface ObjectRow extends SummaryRow {
    content_json: string;
    content_format: string;
    properties_json: string;
    version: number;
    created_by: string;
    archived_at: string | null;
    trashed_at: string | null;
    search_rowid: number;
}

/** Columns for a summary of `o` (knowledge_objects). */
export const SUMMARY_COLUMNS = `o.id, o.space_id, o.type_id, o.title, o.status, o.in_inbox, o.daily_date, substr(o.body_text, 1, 240) AS excerpt,
    (SELECT json_group_array(t.name) FROM knowledge_object_tags ot JOIN knowledge_tags t ON t.id = ot.tag_id WHERE ot.object_id = o.id) AS tags_json,
    o.created_at, o.updated_at, o.updated_by`;

export const OBJECT_COLUMNS = `${SUMMARY_COLUMNS}, o.content_json, o.content_format, o.properties_json, o.version, o.created_by, o.archived_at, o.trashed_at, o.search_rowid`;

export const toSummary = (row: SummaryRow): KnowledgeObjectSummary => ({
    id: row.id,
    spaceId: row.space_id,
    typeId: row.type_id,
    title: row.title,
    status: row.status,
    inInbox: !!row.in_inbox,
    dailyDate: row.daily_date,
    excerpt: row.excerpt.replace(/\s+/g, " ").trim(),
    tags: parseJson<string[]>(row.tags_json, []).sort((a, b) => a.localeCompare(b)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
});

export const toObject = (row: ObjectRow): KnowledgeObject => ({
    ...toSummary(row),
    content: parseJson<DocNode>(row.content_json, EMPTY_DOCUMENT),
    contentFormat: row.content_format,
    properties: parseJson<PropertyValues>(row.properties_json, {}),
    version: row.version,
    createdBy: row.created_by,
    archivedAt: row.archived_at,
    trashedAt: row.trashed_at,
});
