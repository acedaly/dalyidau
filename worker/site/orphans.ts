// Content on the site that Payload has no document for (docs/AUDIT-2026-11.md, Phase 2a).
//
// It happens when a document is deleted for good in Payload and the site's copy of that delete fails, and
// it is also exactly what a lost document or an emptied Payload database looks like. So nothing removes it
// automatically, Republish included. An owner can remove one item at a time, on purpose; a full copy of what
// was on the site is kept first, so the removal can be undone by hand and no article is ever simply deleted.
import type { D1Database } from "@cloudflare/workers-types";
import { type PublisherEnv, unpublishPayloadPost } from "../blog/payload-publisher";
import { unpublishPage, unpublishProject } from "./publisher";
import type { DriftKind } from "./sync-check";

export const removedKey = (kind: DriftKind, siteId: string) => `removed:${kind}:${siteId}`;

/** The site's copy of an item, whole: a post's row, or a page's or project's snapshot with its address. */
async function siteCopy(db: D1Database, kind: DriftKind, siteId: string): Promise<{ slug: string; copy: unknown } | null> {
    if (kind === "post") {
        const row = await db.prepare("SELECT * FROM posts WHERE id = ? AND source = 'payload'").bind(siteId).first<Record<string, unknown>>();
        if (!row) return null;
        const { results } = await db.prepare("SELECT from_slug, created_at FROM slug_redirects WHERE post_id = ?").bind(siteId).all();
        return { slug: String(row.slug), copy: { row, redirects: results } };
    }
    const prefix = `${kind}:`;
    const { results } = await db
        .prepare("SELECT key, value FROM meta WHERE substr(key, 1, ?1) = ?2 AND json_valid(value) AND CAST(json_extract(value, '$.id') AS TEXT) = ?3")
        .bind(prefix.length, prefix, siteId)
        .all<{ key: string; value: string }>();
    if (!results.length) return null;
    return { slug: results[0].key.slice(prefix.length), copy: { snapshots: results } };
}

/**
 * Takes one orphaned item off the site, keeping a full copy under `removed:<kind>:<siteId>` first. The caller
 * must have confirmed that Payload really has no document for it (poc/payload/src/site/sync.ts does).
 * Returns the address it had, or null when it wasn't on the site.
 */
export async function removeOrphan(env: PublisherEnv, kind: DriftKind, siteId: string, by: string | null, now = new Date()): Promise<string | null> {
    const found = await siteCopy(env.DB, kind, siteId);
    if (!found) return null;
    await env.DB.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(removedKey(kind, siteId), JSON.stringify({ kind, siteId, slug: found.slug, removedAt: now.toISOString(), by, copy: found.copy }))
        .run();
    if (kind === "post") await unpublishPayloadPost(env, siteId, { now });
    else {
        // By its id if the site knows it by id, and by its address either way (an orphan may have lost its id row).
        if (kind === "page") await unpublishPage(env, siteId, { now });
        else await unpublishProject(env, siteId, { now });
        await env.DB.prepare("DELETE FROM meta WHERE key = ? AND json_valid(value) AND CAST(json_extract(value, '$.id') AS TEXT) = ?")
            .bind(`${kind}:${found.slug}`, siteId)
            .run();
        if (kind === "project") await unpublishProject(env, siteId, { now });
    }
    return found.slug;
}
