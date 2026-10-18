// Semantic Knowledge: embeddings in Vectorize, blended with the existing keyword search.
//
// Privacy model:
//   * Vectors are per space, never per person. Each space is its own Vectorize namespace, and a
//     vector carries only its object id and chunk number: no title, text or snippet. A query only
//     ever names the namespaces of the caller's own spaces.
//   * Retrieval is not authorisation. Every id that comes back is looked up again in D1 joined to
//     the caller's membership (and the search filters), exactly like keyword results, so a removed
//     member, a trashed object or a stray vector never reaches anyone. Excerpts come from D1 after
//     that check.
//   * Excluded spaces and objects (ai_exclusions) are never embedded, and their vectors are removed.
//
// The index is derived. ai_semantic_index records the version and content hash each object was
// embedded at; a pass compares it with knowledge_objects and embeds only what changed (unchanged
// text after a tag edit costs nothing), removes what was deleted, trashed or excluded, and re-embeds
// everything after an embedding-model change. Passes are bounded, resumable and idempotent.
// Keyword search never depends on any of this: when Vectorize, Workers AI or the budget is
// unavailable, search answers from FTS5 and says so.
import type { D1Database } from "@cloudflare/workers-types";
import type { IntelligenceConfig } from "../../src/shared/intelligence/config";
import type { HybridHit, HybridSearchResult, IntelligenceStatus } from "../../src/shared/intelligence/types";
import { HIGHLIGHT_END, HIGHLIGHT_START } from "../../src/shared/knowledge/types";
import type { PortalUser } from "../../src/shared/portal/types";
import type { Env } from "../env";
import { memberSpaceIds, requireObject, requireSpace } from "../knowledge/access";
import { relatedObjects } from "../knowledge/related";
import { type SearchOptions, searchObjects } from "../knowledge/search";
import { nowIso, placeholders } from "../portal/db";
import { AiError, embed } from "./provider";
import { availability, vectorIndex } from "./settings";
import { BudgetExceeded } from "./usage";

/** Target and hard maximum characters per chunk; at most this many chunks per object. */
const CHUNK_TARGET = 1_200;
const CHUNK_MAX = 1_700;
export const MAX_CHUNKS = 48;
/** Cosine similarity a meaning-only match needs to be shown at all. */
export const MIN_SIMILARITY = 0.3;
/** Above this, two objects are flagged as possible duplicates. */
export const DUPLICATE_SIMILARITY = 0.92;

export const vectorId = (objectId: string, chunk: number) => `${objectId}:${chunk}`;

export async function sha256(text: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Splits a note into chunks along its own structure: blocks (paragraphs, list items, headings) are
 * kept together up to a target size, a block too big on its own is split at sentence ends, and every
 * chunk starts with the title so it stands on its own. Deterministic: the same text always gives the
 * same chunks, which is how an excerpt can be found again from a chunk number.
 */
export function chunkText(title: string, body: string): string[] {
    const heading = title.trim() ? `${title.trim()}\n` : "";
    const blocks = body
        .split(/\n+/)
        .map((b) => b.replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .flatMap((block) => {
            if (block.length <= CHUNK_MAX) return [block];
            const parts: string[] = [];
            let current = "";
            for (const sentence of block.split(/(?<=[.!?])\s+/)) {
                const piece = sentence.length > CHUNK_MAX ? sentence.match(new RegExp(`.{1,${CHUNK_MAX}}`, "g"))! : [sentence];
                for (const p of piece) {
                    if (current && current.length + p.length + 1 > CHUNK_TARGET) {
                        parts.push(current);
                        current = "";
                    }
                    current = current ? `${current} ${p}` : p;
                }
            }
            if (current) parts.push(current);
            return parts;
        });
    const chunks: string[] = [];
    let current = "";
    for (const block of blocks) {
        if (current && current.length + block.length + 1 > CHUNK_TARGET) {
            chunks.push(current);
            current = "";
        }
        current = current ? `${current}\n${block}` : block;
        if (chunks.length >= MAX_CHUNKS) break;
    }
    if (current && chunks.length < MAX_CHUNKS) chunks.push(current);
    if (!chunks.length) return heading ? [heading.trim()] : [];
    return chunks.slice(0, MAX_CHUNKS).map((c) => `${heading}${c}`);
}

// --- Indexing --------------------------------------------------------------------------------------

const EXCLUDED = `EXISTS (SELECT 1 FROM ai_exclusions x WHERE x.space_id = o.space_id AND (x.object_id IS NULL OR x.object_id = o.id))`;

export interface SyncReport {
    embedded: number;
    unchanged: number;
    removed: number;
    failed: number;
    stoppedFor: "budget" | "unavailable" | null;
}

/** One bounded pass: remove what's gone, then embed up to `maxObjects` new or changed objects. */
export async function syncSemanticIndex(env: Env, config: IntelligenceConfig, options: { maxObjects?: number } = {}): Promise<SyncReport> {
    const report: SyncReport = { embedded: 0, unchanged: 0, removed: 0, failed: 0, stoppedFor: null };
    const index = vectorIndex(env);
    if (!availability(env, config).semantic || !index) return report;
    const db = env.DB;

    // 1. Vectors whose object was deleted, trashed or excluded.
    const gone = await db
        .prepare(
            `SELECT i.object_id, i.chunk_count FROM ai_semantic_index i LEFT JOIN knowledge_objects o ON o.id = i.object_id
             WHERE o.id IS NULL OR o.status = 'trashed' OR EXISTS (SELECT 1 FROM ai_exclusions x WHERE x.space_id = i.space_id AND (x.object_id IS NULL OR x.object_id = i.object_id))
             LIMIT 200`,
        )
        .all<{ object_id: string; chunk_count: number }>();
    for (const row of gone.results) {
        const ids = Array.from({ length: Math.max(row.chunk_count, 1) }, (_, i) => vectorId(row.object_id, i));
        await index.deleteByIds(ids);
        await db.prepare("DELETE FROM ai_semantic_index WHERE object_id = ?").bind(row.object_id).run();
        report.removed++;
    }

    // 2. New, changed, re-modelled or previously failed objects, most recently edited first.
    const pending = await db
        .prepare(
            `SELECT o.id, o.space_id, o.version, o.title, o.body_text, i.content_hash, i.model, i.chunk_count, i.attempts, i.status
             FROM knowledge_objects o LEFT JOIN ai_semantic_index i ON i.object_id = o.id
             WHERE o.status <> 'trashed' AND NOT ${EXCLUDED}
               AND (i.object_id IS NULL OR i.object_version <> o.version OR i.model <> ?1 OR (i.status = 'failed' AND i.attempts < 3))
             ORDER BY o.updated_at DESC LIMIT ?2`,
        )
        .bind(config.models.embed, Math.min(options.maxObjects ?? config.budgets.maxBatch, 200))
        .all<{
            id: string;
            space_id: string;
            version: number;
            title: string;
            body_text: string;
            content_hash: string | null;
            model: string | null;
            chunk_count: number | null;
            attempts: number | null;
            status: string | null;
        }>();

    for (const o of pending.results) {
        const hash = await sha256(`${config.models.embed}\n${o.title}\n${o.body_text}`);
        if (o.content_hash === hash && o.model === config.models.embed && o.status === "indexed") {
            await db.prepare("UPDATE ai_semantic_index SET object_version = ? WHERE object_id = ?").bind(o.version, o.id).run();
            report.unchanged++;
            continue;
        }
        const chunks = chunkText(o.title, o.body_text);
        try {
            const vectors = chunks.length ? await embed({ env, config, email: null, spaceId: o.space_id, feature: "semantic" }, chunks) : [];
            if (vectors.length)
                await index.upsert(vectors.map((values, i) => ({ id: vectorId(o.id, i), values, namespace: o.space_id, metadata: { o: o.id, c: i } })));
            // A shorter note leaves its old trailing chunks behind: delete them.
            const previous = o.chunk_count ?? 0;
            if (previous > vectors.length)
                await index.deleteByIds(Array.from({ length: previous - vectors.length }, (_, i) => vectorId(o.id, vectors.length + i)));
            await db
                .prepare(
                    `INSERT INTO ai_semantic_index (object_id, space_id, object_version, content_hash, model, chunk_count, status, attempts, error_code, indexed_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'indexed', 0, NULL, ?7)
                     ON CONFLICT(object_id) DO UPDATE SET space_id = ?2, object_version = ?3, content_hash = ?4, model = ?5, chunk_count = ?6, status = 'indexed', attempts = 0, error_code = NULL, indexed_at = ?7`,
                )
                .bind(o.id, o.space_id, o.version, hash, config.models.embed, vectors.length, nowIso())
                .run();
            report.embedded++;
        } catch (error) {
            if (error instanceof BudgetExceeded) {
                report.stoppedFor = "budget";
                break;
            }
            const code = error instanceof AiError ? error.aiCode : "unexpected";
            await db
                .prepare(
                    `INSERT INTO ai_semantic_index (object_id, space_id, object_version, content_hash, model, chunk_count, status, attempts, error_code, indexed_at)
                     VALUES (?1, ?2, ?3, '', ?4, ?5, 'failed', 1, ?6, ?7)
                     ON CONFLICT(object_id) DO UPDATE SET object_version = ?3, status = 'failed', attempts = attempts + 1, error_code = ?6, indexed_at = ?7`,
                )
                .bind(o.id, o.space_id, o.version, config.models.embed, o.chunk_count ?? 0, code, nowIso())
                .run();
            report.failed++;
            if (error instanceof AiError && (error.aiCode === "ai_unavailable" || error.aiCode === "timeout")) {
                report.stoppedFor = "unavailable";
                break;
            }
        }
    }
    if (report.embedded || report.removed || report.failed) console.log(JSON.stringify({ event: "semantic_sync", ...report }));
    return report;
}

/** Re-embed every object in a space on the next passes (an owner's "rebuild"). Vectors are overwritten in place. */
export const requestReindex = (db: D1Database, spaceId: string) =>
    db.prepare("UPDATE ai_semantic_index SET object_version = -1 WHERE space_id = ?").bind(spaceId).run();

export async function indexStatus(db: D1Database, spaceIds: string[]): Promise<IntelligenceStatus["index"]> {
    if (!spaceIds.length) return { indexed: 0, failed: 0, pending: 0, spaces: 0 };
    const binds = [...spaceIds];
    const row = await db
        .prepare(
            `SELECT
                (SELECT COUNT(*) FROM ai_semantic_index WHERE status = 'indexed' AND space_id IN (${placeholders(spaceIds.length)})) AS indexed,
                (SELECT COUNT(*) FROM ai_semantic_index WHERE status = 'failed' AND space_id IN (${placeholders(spaceIds.length)})) AS failed,
                (SELECT COUNT(*) FROM knowledge_objects o LEFT JOIN ai_semantic_index i ON i.object_id = o.id
                    WHERE o.status <> 'trashed' AND o.space_id IN (${placeholders(spaceIds.length)}) AND NOT ${EXCLUDED} AND (i.object_id IS NULL OR i.object_version <> o.version)) AS pending`,
        )
        .bind(...binds, ...binds, ...binds)
        .first<{ indexed: number; failed: number; pending: number }>();
    return { indexed: row?.indexed ?? 0, failed: row?.failed ?? 0, pending: row?.pending ?? 0, spaces: spaceIds.length };
}

// --- Retrieval -------------------------------------------------------------------------------------

interface VectorHit {
    objectId: string;
    chunk: number;
    score: number;
}

const parseVectorId = (id: string): { objectId: string; chunk: number } | null => {
    const match = /^(kob_[a-z0-9]{14}):(\d{1,3})$/.exec(id);
    return match ? { objectId: match[1], chunk: Number(match[2]) } : null;
};

/** Nearest chunks in the given spaces' namespaces, best per object. Never decides access. */
async function nearest(env: Env, vector: number[], spaceIds: string[], topK: number): Promise<VectorHit[]> {
    const index = vectorIndex(env);
    if (!index) return [];
    const best = new Map<string, VectorHit>();
    for (const space of spaceIds.slice(0, 10)) {
        const result = await index.query(vector, { topK, namespace: space, returnMetadata: "none" });
        for (const match of result.matches ?? []) {
            const parsed = parseVectorId(match.id);
            if (!parsed || match.score < MIN_SIMILARITY) continue;
            const existing = best.get(parsed.objectId);
            if (!existing || match.score > existing.score) best.set(parsed.objectId, { ...parsed, score: match.score });
        }
    }
    return [...best.values()].sort((a, b) => b.score - a.score);
}

interface VisibleRow {
    id: string;
    space_id: string;
    title: string;
    type_id: string;
    status: string;
    updated_at: string;
    body_text: string;
    tags_json: string | null;
}

/** The access check after retrieval: only objects in the caller's spaces that match the filters. */
async function visibleObjects(db: D1Database, user: PortalUser, ids: string[], options: Omit<SearchOptions, "limit">): Promise<Map<string, VisibleRow>> {
    if (!ids.length || !options.spaceIds.length) return new Map();
    const where = [`o.id IN (${placeholders(ids.length)})`, `o.space_id IN (${placeholders(options.spaceIds.length)})`];
    const binds: unknown[] = [user.email, ...ids, ...options.spaceIds];
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
        where.push("o.updated_at < date(?, '+1 day')");
        binds.push(options.updatedTo);
    }
    const rows = await db
        .prepare(
            `SELECT o.id, o.space_id, o.title, o.type_id, o.status, o.updated_at, o.body_text,
                (SELECT json_group_array(t.name) FROM knowledge_object_tags ot JOIN knowledge_tags t ON t.id = ot.tag_id WHERE ot.object_id = o.id) AS tags_json
             FROM knowledge_objects o JOIN knowledge_memberships m ON m.space_id = o.space_id AND m.email = ?
             WHERE ${where.join(" AND ")}`,
        )
        .bind(...binds)
        .all<VisibleRow>();
    return new Map(rows.results.map((r) => [r.id, r]));
}

const excerptFor = (row: VisibleRow, chunk: number | null) => {
    const chunks = chunk === null ? [] : chunkText("", row.body_text);
    const text = (chunk !== null && chunks[chunk]) || row.body_text;
    return text.replace(/\s+/g, " ").trim().slice(0, 280);
};

const tagsOf = (json: string | null) => {
    try {
        return (JSON.parse(json ?? "[]") as string[]).sort();
    } catch {
        return [];
    }
};

/** Reciprocal rank fusion: robust to keyword and vector scores being on different scales. */
const RRF_K = 60;

export async function hybridSearch(
    env: Env,
    config: IntelligenceConfig,
    user: PortalUser,
    query: string,
    options: Omit<SearchOptions, "spaceIds"> & { spaceId?: string | null; site: string },
): Promise<HybridSearchResult> {
    const db = env.DB;
    const spaceIds = options.spaceId ? [(await requireSpace(db, user, options.spaceId)).id] : await memberSpaceIds(db, user.email);
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 50);
    const filters = { ...options, spaceIds };
    const keyword = await searchObjects(db, query, { ...filters, limit: 30 });

    let meaning: VectorHit[] = [];
    let fallbackReason: string | null = null;
    if (!availability(env, config).semantic) fallbackReason = "Semantic search is off";
    else if (query.trim().length < 3) fallbackReason = "Query too short for meaning search";
    else {
        try {
            const [vector] = await embed({ env, config, email: user.email, feature: "semantic" }, [query.slice(0, 500)]);
            meaning = await nearest(env, vector, spaceIds, 20);
        } catch (error) {
            fallbackReason =
                error instanceof BudgetExceeded
                    ? "The AI budget is used up for today"
                    : error instanceof AiError
                      ? "Workers AI or Vectorize is unavailable"
                      : "Semantic search failed";
            if (!(error instanceof BudgetExceeded || error instanceof AiError))
                console.error(JSON.stringify({ event: "semantic_search_error", error: (error as Error)?.name }));
        }
    }

    const scores = new Map<
        string,
        { score: number; matchedBy: Set<"keyword" | "meaning">; chunk: number | null; titleSnippet: string | null; keywordExcerpt: string | null }
    >();
    keyword.forEach((hit, rank) => {
        scores.set(hit.object.id, {
            score: 1 / (RRF_K + rank + 1),
            matchedBy: new Set(["keyword"]),
            chunk: null,
            titleSnippet: hit.titleSnippet,
            keywordExcerpt: hit.bodySnippet.split(HIGHLIGHT_START).join("").split(HIGHLIGHT_END).join(""),
        });
    });
    meaning.forEach((hit, rank) => {
        const entry = scores.get(hit.objectId) ?? { score: 0, matchedBy: new Set(), chunk: null, titleSnippet: null, keywordExcerpt: null };
        entry.score += 1 / (RRF_K + rank + 1);
        entry.matchedBy.add("meaning");
        entry.chunk = hit.chunk;
        scores.set(hit.objectId, entry);
    });

    // Keyword hits were already constrained to the caller's spaces; meaning hits are checked here.
    const visible = await visibleObjects(db, user, [...scores.keys()].slice(0, 90), filters);
    const hits: HybridHit[] = [...scores.entries()]
        .filter(([id]) => visible.has(id))
        .sort((a, b) => b[1].score - a[1].score)
        .slice(0, limit)
        .map(([id, s]) => {
            const row = visible.get(id)!;
            return {
                object: {
                    id,
                    spaceId: row.space_id,
                    title: row.title,
                    typeId: row.type_id,
                    status: row.status,
                    updatedAt: row.updated_at,
                    tags: tagsOf(row.tags_json),
                },
                excerpt: s.keywordExcerpt && s.chunk === null ? s.keywordExcerpt.slice(0, 280) : excerptFor(row, s.chunk),
                titleSnippet: s.titleSnippet,
                score: Math.round(s.score * 100_000) / 100_000,
                matchedBy: [...s.matchedBy],
                url: `${options.site}/portal/knowledge/o/${id}`,
            };
        });
    return { hits, mode: fallbackReason ? "keyword" : "hybrid", fallbackReason };
}

export interface RelatedView {
    object: { id: string; title: string; typeId: string; status: string; updatedAt: string };
    reasons: string[];
    strength: "strong" | "possible";
    /** Very close in meaning: possibly the same note twice. */
    possibleDuplicate: boolean;
    url: string;
}

/**
 * Related knowledge for one object: the existing explainable signals (tags, links, collections,
 * wording) plus, when available, similar meaning. Suggestions only: nothing is linked.
 */
export async function relatedWithMeaning(
    env: Env,
    config: IntelligenceConfig,
    user: PortalUser,
    objectId: string,
    site: string,
): Promise<{ related: RelatedView[]; semantic: boolean }> {
    const access = await requireObject(env.DB, user, objectId);
    const base = await relatedObjects(env.DB, access.id, access.space_id, 10);
    const out = new Map<string, RelatedView>(
        base.map((s) => [
            s.object.id,
            {
                object: { id: s.object.id, title: s.object.title, typeId: s.object.typeId, status: s.object.status, updatedAt: s.object.updatedAt },
                reasons: s.reasons,
                strength: s.strength,
                possibleDuplicate: false,
                url: `${site}/portal/knowledge/o/${s.object.id}`,
            },
        ]),
    );
    let semantic = false;
    if (availability(env, config).semantic) {
        try {
            const self = await env.DB.prepare("SELECT title, body_text FROM knowledge_objects WHERE id = ?")
                .bind(access.id)
                .first<{ title: string; body_text: string }>();
            const [first] = chunkText(self?.title ?? "", self?.body_text ?? "");
            if (first) {
                const [vector] = await embed({ env, config, email: user.email, spaceId: access.space_id, feature: "semantic" }, [first]);
                const hits = (await nearest(env, vector, [access.space_id], 12)).filter((h) => h.objectId !== access.id);
                const direct = new Set(
                    (
                        await env.DB.prepare(
                            "SELECT target_id AS id FROM knowledge_relations WHERE source_id = ?1 UNION SELECT source_id FROM knowledge_relations WHERE target_id = ?1",
                        )
                            .bind(access.id)
                            .all<{ id: string }>()
                    ).results.map((r) => r.id),
                );
                const visible = await visibleObjects(
                    env.DB,
                    user,
                    hits.map((h) => h.objectId),
                    { spaceIds: [access.space_id], status: "any" },
                );
                for (const hit of hits) {
                    const row = visible.get(hit.objectId);
                    if (!row || direct.has(hit.objectId)) continue;
                    const duplicate = hit.score >= DUPLICATE_SIMILARITY;
                    const reason = duplicate ? "Very similar content: possibly a duplicate" : "Similar meaning";
                    const existing = out.get(hit.objectId);
                    if (existing) {
                        existing.reasons = [reason, ...existing.reasons].slice(0, 3);
                        existing.strength = "strong";
                        existing.possibleDuplicate = duplicate;
                    } else
                        out.set(hit.objectId, {
                            object: { id: row.id, title: row.title, typeId: row.type_id, status: row.status, updatedAt: row.updated_at },
                            reasons: [reason],
                            strength: hit.score >= 0.6 ? "strong" : "possible",
                            possibleDuplicate: duplicate,
                            url: `${site}/portal/knowledge/o/${row.id}`,
                        });
                }
                semantic = true;
            }
        } catch (error) {
            if (!(error instanceof BudgetExceeded || error instanceof AiError)) throw error;
        }
    }
    const related = [...out.values()]
        .sort((a, b) => Number(b.possibleDuplicate) - Number(a.possibleDuplicate) || Number(b.strength === "strong") - Number(a.strength === "strong"))
        .slice(0, 10);
    return { related, semantic };
}
