// Related knowledge, worked out from what's already stored: shared tags, objects linked to or from
// the same places, shared collections and similar wording (FTS5). No AI, no embeddings, nothing
// stored. Each signal is one bounded, indexed query over the object's own space; the scores are
// added up in the Worker and every suggestion says why it's there.
//
// Objects already linked directly are left out (they're listed under Links and Backlinks), as are
// trashed objects and anything outside the object's space. Suggestions never create relations: a
// person decides whether to link.
import type { D1Database } from "@cloudflare/workers-types";
import type { ObjectRef, RelatedSuggestion } from "../../src/shared/knowledge/types";
import { placeholders } from "../portal/db";

const CANDIDATES = 40;
const STOP_WORDS = new Set(
    "the and for with from that this into about over under your our their there what when where which who why how are was were been have has had not but you can will just than then also note notes".split(
        " ",
    ),
);

/** A safe FTS5 query matching any of the title's distinctive words. Terms are quoted, so nothing is syntax. */
export const similarityQuery = (title: string): string | null => {
    const words = [...new Set((title.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length >= 3 && !STOP_WORDS.has(w)))].slice(0, 6);
    return words.length ? words.map((w) => `"${w}"*`).join(" OR ") : null;
};

interface Signal {
    score: number;
    reasons: string[];
    kinds: Set<string>;
}

const quote = (title: string) => `“${title || "Untitled"}”`;

export async function relatedObjects(db: D1Database, objectId: string, spaceId: string, limit = 8): Promise<RelatedSuggestion[]> {
    const self = await db
        .prepare("SELECT title, type_id FROM knowledge_objects WHERE id = ? AND space_id = ?")
        .bind(objectId, spaceId)
        .first<{ title: string; type_id: string }>();
    if (!self) return [];
    const match = similarityQuery(self.title);

    const [direct, tags, coLinked, coCited, collections] = await db.batch([
        db.prepare("SELECT target_id AS id FROM knowledge_relations WHERE source_id = ?1 UNION SELECT source_id FROM knowledge_relations WHERE target_id = ?1").bind(objectId),
        // Objects sharing a tag, with the tags' names.
        db
            .prepare(
                `SELECT b.object_id AS id, COUNT(*) AS n, group_concat(t.name, ', ' ORDER BY t.name COLLATE NOCASE, t.name) AS via FROM knowledge_object_tags a
                 JOIN knowledge_object_tags b ON b.tag_id = a.tag_id AND b.object_id <> a.object_id
                 JOIN knowledge_tags t ON t.id = a.tag_id
                 WHERE a.object_id = ? AND b.space_id = ? GROUP BY b.object_id ORDER BY n DESC LIMIT ${CANDIDATES}`,
            )
            .bind(objectId, spaceId),
        // Objects that link to something this links to.
        db
            .prepare(
                `SELECT b.source_id AS id, COUNT(DISTINCT a.target_id) AS n, MIN(a.target_id) AS via FROM knowledge_relations a
                 JOIN knowledge_relations b ON b.target_id = a.target_id AND b.source_id <> a.source_id
                 WHERE a.source_id = ? AND b.space_id = ? GROUP BY b.source_id ORDER BY n DESC LIMIT ${CANDIDATES}`,
            )
            .bind(objectId, spaceId),
        // Objects linked from a note that also links here.
        db
            .prepare(
                `SELECT b.target_id AS id, COUNT(DISTINCT a.source_id) AS n, MIN(a.source_id) AS via FROM knowledge_relations a
                 JOIN knowledge_relations b ON b.source_id = a.source_id AND b.target_id <> a.target_id
                 WHERE a.target_id = ? AND b.space_id = ? GROUP BY b.target_id ORDER BY n DESC LIMIT ${CANDIDATES}`,
            )
            .bind(objectId, spaceId),
        // Objects in the same collections; smaller collections say more.
        db
            .prepare(
                `SELECT b.object_id AS id, COUNT(*) AS n, MIN(c.name) AS via FROM knowledge_collection_items a
                 JOIN knowledge_collection_items b ON b.collection_id = a.collection_id AND b.object_id <> a.object_id
                 JOIN knowledge_collections c ON c.id = a.collection_id AND c.archived_at IS NULL
                 WHERE a.object_id = ? AND b.space_id = ? GROUP BY b.object_id
                 ORDER BY n DESC, MIN((SELECT COUNT(*) FROM knowledge_collection_items s WHERE s.collection_id = a.collection_id)) LIMIT ${CANDIDATES}`,
            )
            .bind(objectId, spaceId),
    ]);
    const similar = match
        ? await db
              .prepare(
                  `SELECT o.id FROM knowledge_fts JOIN knowledge_objects o ON o.search_rowid = knowledge_fts.rowid
                   WHERE knowledge_fts MATCH ? AND o.space_id = ? AND o.id <> ? AND o.status <> 'trashed'
                   ORDER BY bm25(knowledge_fts, 10.0, 1.0, 4.0) LIMIT 10`,
              )
              .bind(match, spaceId, objectId)
              .all<{ id: string }>()
        : { results: [] as { id: string }[] };

    const excluded = new Set([objectId, ...(direct.results as { id: string }[]).map((r) => r.id)]);
    const signals = new Map<string, Signal>();
    const add = (id: string, kind: string, score: number, reason: string) => {
        if (excluded.has(id)) return;
        const signal = signals.get(id) ?? { score: 0, reasons: [], kinds: new Set<string>() };
        signal.score += score;
        signal.reasons.push(reason);
        signal.kinds.add(kind);
        signals.set(id, signal);
    };

    type Row = { id: string; n: number; via: string };
    // The titles of the objects that explain a link-based suggestion.
    const viaIds = [...(coLinked.results as Row[]), ...(coCited.results as Row[])].map((r) => r.via);
    const viaTitles = new Map<string, string>();
    if (viaIds.length) {
        const unique = [...new Set(viaIds)].slice(0, 90);
        const rows = await db
            .prepare(`SELECT id, title FROM knowledge_objects WHERE space_id = ? AND id IN (${placeholders(unique.length)})`)
            .bind(spaceId, ...unique)
            .all<{ id: string; title: string }>();
        for (const r of rows.results) viaTitles.set(r.id, r.title);
    }

    for (const r of tags.results as Row[])
        add(r.id, "tags", 3 * Math.min(r.n, 4), r.n === 1 ? `Shares the tag ${r.via}` : `Shares ${r.n} tags: ${r.via}`);
    for (const r of coLinked.results as Row[])
        add(r.id, "links", 2 * Math.min(r.n, 3), r.n === 1 ? `Also links to ${quote(viaTitles.get(r.via) ?? "")}` : `Links to ${r.n} of the same objects`);
    for (const r of coCited.results as Row[])
        add(r.id, "links", 2 * Math.min(r.n, 3), r.n === 1 ? `Mentioned alongside this in ${quote(viaTitles.get(r.via) ?? "")}` : `Mentioned alongside this in ${r.n} notes`);
    for (const r of collections.results as Row[]) add(r.id, "collections", 2 + Math.min(r.n - 1, 2), r.n === 1 ? `Also in ${quote(r.via)}` : `In ${r.n} of the same collections`);
    similar.results.forEach((r, rank) => add(r.id, "text", rank < 3 ? 1.5 : 1, "Similar wording"));

    if (!signals.size) return [];
    // The strongest candidates, within D1's limit on bound parameters.
    const ids = [...signals.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, 95).map(([id]) => id);
    const rows = await db
        .prepare(
            `SELECT id, space_id, title, type_id, status, daily_date, updated_at FROM knowledge_objects
             WHERE space_id = ? AND status <> 'trashed' AND id IN (${placeholders(ids.length)})`,
        )
        .bind(spaceId, ...ids)
        .all<{ id: string; space_id: string; title: string; type_id: string; status: ObjectRef["status"]; daily_date: string | null; updated_at: string }>();

    return rows.results
        .map((r) => {
            const signal = signals.get(r.id)!;
            // The same type adds a little weight, but never makes a suggestion on its own.
            const score = signal.score + (r.type_id === self.type_id ? 0.5 : 0);
            return {
                object: { id: r.id, spaceId: r.space_id, title: r.title, typeId: r.type_id, status: r.status, dailyDate: r.daily_date, updatedAt: r.updated_at },
                score,
                strength: (signal.kinds.size >= 2 || signal.score >= 5 ? "strong" : "possible") as RelatedSuggestion["strength"],
                reasons: signal.reasons.slice(0, 3),
            };
        })
        .filter((s) => s.score >= 1.5)
        .sort((a, b) => b.score - a.score || b.object.updatedAt.localeCompare(a.object.updatedAt))
        .slice(0, limit);
}

/** Of these objects, the ones that are organised (tagged or in a collection) even if nothing links to them. */
export async function organisedIds(db: D1Database, ids: string[]): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const out = new Set<string>();
    for (let i = 0; i < ids.length; i += 90) {
        const part = ids.slice(i, i + 90);
        const rows = await db
            .prepare(
                `SELECT object_id FROM knowledge_object_tags WHERE object_id IN (${placeholders(part.length)})
                 UNION SELECT object_id FROM knowledge_collection_items WHERE object_id IN (${placeholders(part.length)})`,
            )
            .bind(...part, ...part)
            .all<{ object_id: string }>();
        for (const r of rows.results) out.add(r.object_id);
    }
    return out;
}
