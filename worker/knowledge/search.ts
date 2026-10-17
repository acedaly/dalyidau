// Keyword search over titles, text and tags with SQLite FTS5.
//
// knowledge_fts is a derived index whose rowid is knowledge_objects.search_rowid. It is written in
// the same batch as every object change (indexStatements) and can be rebuilt from scratch at any
// time (KNOWLEDGE_FTS_REBUILD), which is how a restored backup gets its index back. Every search
// joins back to knowledge_objects and is constrained to the caller's own space ids.
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { HIGHLIGHT_END, HIGHLIGHT_START, type KnowledgeSearchHit } from "../../src/shared/knowledge/types";
import { placeholders } from "../portal/db";
import { SUMMARY_COLUMNS, type SummaryRow, toSummary } from "./rows";

const INDEX_SELECT = `SELECT o.search_rowid, o.title, o.body_text,
    COALESCE((SELECT group_concat(t.name, ' ') FROM knowledge_object_tags ot JOIN knowledge_tags t ON t.id = ot.tag_id WHERE ot.object_id = o.id), '')
    FROM knowledge_objects o`;

/** Rebuilds the whole index from knowledge_objects. Run after restoring a backup. */
export const KNOWLEDGE_FTS_REBUILD = [`DELETE FROM knowledge_fts`, `INSERT INTO knowledge_fts (rowid, title, body, tags) ${INDEX_SELECT}`];

/** Re-indexes one object from what's in the database at that point in the batch. */
export const indexStatements = (db: D1Database, objectId: string): D1PreparedStatement[] => [
    db.prepare("DELETE FROM knowledge_fts WHERE rowid = (SELECT search_rowid FROM knowledge_objects WHERE id = ?)").bind(objectId),
    db.prepare(`INSERT INTO knowledge_fts (rowid, title, body, tags) ${INDEX_SELECT} WHERE o.id = ?`).bind(objectId),
];

export const unindexStatement = (db: D1Database, objectId: string): D1PreparedStatement =>
    db.prepare("DELETE FROM knowledge_fts WHERE rowid = (SELECT search_rowid FROM knowledge_objects WHERE id = ?)").bind(objectId);

const MAX_TERMS = 12;

/**
 * Turns what someone typed into a safe FTS5 query. FTS5 has its own syntax (AND, NEAR, column
 * filters, quotes); user input is never passed through as syntax. Words become quoted prefix terms
 * that must all match; text in double quotes becomes a phrase.
 */
export function ftsQuery(input: string): string | null {
    const terms: string[] = [];
    const phrase = /"([^"]*)"/g;
    const words = (text: string) => text.match(/[\p{L}\p{N}]+/gu) ?? [];
    for (const match of input.matchAll(phrase)) {
        const inner = words(match[1]);
        if (inner.length) terms.push(`"${inner.join(" ")}"`);
    }
    for (const word of words(input.replace(phrase, " "))) terms.push(`"${word}"*`);
    return terms.length ? terms.slice(0, MAX_TERMS).join(" ") : null;
}

export interface SearchOptions {
    spaceIds: string[];
    typeId?: string | null;
    status?: "active" | "archived" | "any";
    tag?: string | null;
    /** Updated on or after / before this date (YYYY-MM-DD, UTC). */
    updatedFrom?: string | null;
    updatedTo?: string | null;
    limit?: number;
}

export async function searchObjects(db: D1Database, query: string, options: SearchOptions): Promise<KnowledgeSearchHit[]> {
    const match = ftsQuery(query);
    if (!match || options.spaceIds.length === 0) return [];
    const where = [`knowledge_fts MATCH ?`, `o.space_id IN (${placeholders(options.spaceIds.length)})`];
    const binds: unknown[] = [match, ...options.spaceIds];
    const status = options.status ?? "active";
    where.push(status === "any" ? "o.status <> 'trashed'" : "o.status = ?");
    if (status !== "any") binds.push(status);
    if (options.typeId) {
        where.push("o.type_id = ?");
        binds.push(options.typeId);
    }
    if (options.tag) {
        where.push("EXISTS (SELECT 1 FROM knowledge_object_tags ot JOIN knowledge_tags t ON t.id = ot.tag_id WHERE ot.object_id = o.id AND t.name = ?)");
        binds.push(options.tag);
    }
    if (options.updatedFrom) {
        where.push("o.updated_at >= ?");
        binds.push(options.updatedFrom);
    }
    if (options.updatedTo) {
        // Inclusive of the whole day.
        where.push("o.updated_at < date(?, '+1 day')");
        binds.push(options.updatedTo);
    }
    const rows = await db
        .prepare(
            `SELECT ${SUMMARY_COLUMNS},
                highlight(knowledge_fts, 0, ?, ?) AS title_snippet,
                snippet(knowledge_fts, 1, ?, ?, '…', 16) AS body_snippet
             FROM knowledge_fts JOIN knowledge_objects o ON o.search_rowid = knowledge_fts.rowid
             WHERE ${where.join(" AND ")}
             ORDER BY bm25(knowledge_fts, 10.0, 1.0, 4.0), o.updated_at DESC
             LIMIT ?`,
        )
        .bind(HIGHLIGHT_START, HIGHLIGHT_END, HIGHLIGHT_START, HIGHLIGHT_END, ...binds, Math.min(options.limit ?? 50, 100))
        .all<SummaryRow & { title_snippet: string; body_snippet: string }>();
    return rows.results.map((row) => ({ object: toSummary(row), titleSnippet: row.title_snippet, bodySnippet: row.body_snippet }));
}
