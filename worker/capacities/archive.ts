// Retiring Capacities without losing anything (docs/CAPACITIES_RETIREMENT.md).
//
// Every Capacities article already lives entirely in Cloudflare: its rendered HTML, metadata and
// search text in D1 (posts), its images in R2 (media), its old addresses in slug_redirects. Nothing
// at request time asks Capacities for anything. This module proves that (the inventory checks every
// image in R2), keeps a second copy of each article in capacities_archive, and says when it's safe
// to remove the API token and cancel. It never deletes a post, an image or a redirect.
//
// An article's address can be handed to an Amplenote note ("replaces:" in the note's Website
// section, approved in the portal). That move happens in amplenote/publisher.ts; undoing it, which
// puts the archived Capacities copy back exactly as it was, happens here.
import type { CapacitiesStatus } from "../../src/shared/website";
import type { Env } from "../env";
import { auditStatement, nowIso } from "../portal/db";
import { capacitiesSyncEnabled } from "../sync";

/** The posts columns an archived copy keeps, in one place so archive and restore can't drift. */
export const POST_COLUMNS = [
    "id",
    "slug",
    "title",
    "subtitle",
    "summary",
    "category",
    "tags",
    "featured",
    "image_key",
    "image_alt",
    "image_width",
    "image_height",
    "body_html",
    "toc",
    "search_text",
    "word_count",
    "reading_minutes",
    "published_at",
    "updated_at",
    "source_updated_at",
    "content_hash",
    "render_context",
    "synced_at",
] as const;

export interface CapacitiesPostRow {
    id: string;
    slug: string;
    title: string;
    subtitle: string | null;
    summary: string | null;
    category: string | null;
    tags: string;
    featured: number;
    image_key: string | null;
    image_alt: string | null;
    image_width: number | null;
    image_height: number | null;
    body_html: string;
    published_at: string;
    content_hash: string;
}

export interface ArchiveRow extends CapacitiesPostRow {
    redirects: string;
    media_keys: string;
    archived_at: string;
    replaced_by: string | null;
    replaced_at: string | null;
}

const MEDIA_KEY = /\/media\/([a-f0-9]{24}\.(?:jpg|png|gif|webp|avif))/g;

/** Every R2 key an article shows: its featured image and each image in its body (including srcset). */
export const mediaKeys = (row: Pick<CapacitiesPostRow, "image_key" | "body_html">) =>
    [...new Set([...(row.image_key ? [row.image_key] : []), ...[...row.body_html.matchAll(MEDIA_KEY)].map((m) => m[1])])].sort();

/**
 * Copies a live Capacities article into the archive. `replacedBy` marks it as handed to an Amplenote
 * note. A statement, so callers can make it part of a larger atomic batch.
 */
export const archiveStatement = (env: Env, row: CapacitiesPostRow, redirects: string[], actor: string, replacedBy: string | null = null) => {
    const ts = nowIso();
    const columns = POST_COLUMNS.join(", ");
    const updates = [...POST_COLUMNS.filter((c) => c !== "id"), "redirects", "media_keys", "archived_at", "archived_by"]
        .map((c) => `${c} = excluded.${c}`)
        .join(", ");
    return env.DB.prepare(
        `INSERT INTO capacities_archive (${columns}, redirects, media_keys, archived_at, archived_by, replaced_by, replaced_at)
         SELECT ${columns}, ?2, ?3, ?4, ?5, ?6, CASE WHEN ?6 IS NULL THEN NULL ELSE ?4 END FROM posts WHERE id = ?1 AND source = 'capacities'
         ON CONFLICT(id) DO UPDATE SET ${updates}, replaced_by = excluded.replaced_by, replaced_at = excluded.replaced_at`,
    ).bind(row.id, JSON.stringify(redirects), JSON.stringify(mediaKeys(row)), ts, actor, replacedBy);
};

const livePosts = async (env: Env) =>
    (
        await env.DB.prepare(
            "SELECT id, slug, title, subtitle, summary, category, tags, featured, image_key, image_alt, image_width, image_height, body_html, published_at, content_hash FROM posts WHERE source = 'capacities' ORDER BY published_at DESC",
        ).all<CapacitiesPostRow>()
    ).results;

const redirectsByPost = async (env: Env) => {
    const map = new Map<string, string[]>();
    for (const r of (await env.DB.prepare("SELECT from_slug, post_id FROM slug_redirects ORDER BY from_slug").all<{ from_slug: string; post_id: string }>())
        .results)
        map.set(r.post_id, [...(map.get(r.post_id) ?? []), r.from_slug]);
    return map;
};

/** What Portal settings → Website & Blog shows about Capacities. `verifyMedia` checks every image in R2. */
export async function capacitiesStatus(env: Env, options: { verifyMedia?: boolean } = {}): Promise<CapacitiesStatus> {
    const [syncEnabled, posts, redirects, archived, lastRun] = await Promise.all([
        capacitiesSyncEnabled(env),
        livePosts(env),
        redirectsByPost(env),
        env.DB.prepare("SELECT id, slug, title, content_hash, archived_at, replaced_by, replaced_at FROM capacities_archive").all<
            Pick<ArchiveRow, "id" | "slug" | "title" | "content_hash" | "archived_at" | "replaced_by" | "replaced_at">
        >(),
        env.DB.prepare(
            "SELECT finished_at, status FROM sync_runs WHERE status != 'running' AND trigger NOT LIKE 'amplenote:%' ORDER BY id DESC LIMIT 1",
        ).first<{ finished_at: string | null; status: string }>(),
    ]);
    const archive = new Map(archived.results.map((r) => [r.id, r]));

    const keys = [...new Set(posts.flatMap(mediaKeys))];
    let missing: Set<string> | null = null;
    if (options.verifyMedia) {
        missing = new Set();
        for (const key of keys) if (!(await env.MEDIA.head(key))) missing.add(key);
    }

    const articles = posts.map((p) => {
        const copy = archive.get(p.id);
        const images = mediaKeys(p);
        return {
            id: p.id,
            slug: p.slug,
            title: p.title,
            publishedAt: p.published_at,
            redirects: redirects.get(p.id) ?? [],
            images: images.length,
            missingImages: missing ? images.filter((k) => missing!.has(k)).length : null,
            archive: !copy ? ("none" as const) : copy.content_hash === p.content_hash ? ("current" as const) : ("outdated" as const),
            archivedAt: copy?.archived_at ?? null,
        };
    });
    const replaced = archived.results
        .filter((r) => r.replaced_by)
        .map((r) => ({ id: r.id, slug: r.slug, title: r.title, replacedBy: r.replaced_by!, replacedAt: r.replaced_at }));

    const checks = [
        {
            id: "sync-off",
            label: "Capacities sync is switched off",
            ok: !syncEnabled,
            detail: syncEnabled ? "Switch it off in Portal settings → Features → Website & Blog." : "No scheduled job or manual sync calls Capacities.",
        },
        {
            id: "archived",
            label: "Every Capacities article is archived in Cloudflare",
            ok: articles.every((a) => a.archive === "current"),
            detail: articles.every((a) => a.archive === "current")
                ? `${articles.length} article${articles.length === 1 ? "" : "s"} copied to the archive, matching what's published.`
                : "Run Check and archive.",
        },
        {
            id: "images",
            label: "Every image is stored in R2",
            ok: missing !== null && missing.size === 0,
            detail:
                missing === null
                    ? "Run Check and archive to check each image."
                    : missing.size === 0
                      ? `All ${keys.length} images found.`
                      : `${missing.size} image(s) missing from R2.`,
        },
    ];

    return {
        syncEnabled,
        tokenConfigured: !!env.CAPACITIES_API_TOKEN,
        lastSync: lastRun ? { finishedAt: lastRun.finished_at, status: lastRun.status } : null,
        articles,
        replaced,
        totals: {
            articles: articles.length,
            images: keys.length,
            missingImages: missing ? missing.size : null,
            redirects: articles.reduce((n, a) => n + a.redirects.length, 0),
        },
        checks,
        safeToRetire: checks.every((c) => c.ok),
        checkedAt: options.verifyMedia ? nowIso() : null,
    };
}

/** Checks every image and copies every Capacities article into the archive. Changes no published post. */
export async function archiveCapacities(env: Env, actor: string): Promise<CapacitiesStatus> {
    const [posts, redirects] = await Promise.all([livePosts(env), redirectsByPost(env)]);
    const replaced = new Set(
        (await env.DB.prepare("SELECT id FROM capacities_archive WHERE replaced_by IS NOT NULL").all<{ id: string }>()).results.map((r) => r.id),
    );
    const statements = posts.filter((p) => !replaced.has(p.id)).map((p) => archiveStatement(env, p, redirects.get(p.id) ?? [], actor));
    if (statements.length) await env.DB.batch(statements);
    const status = await capacitiesStatus(env, { verifyMedia: true });
    await auditStatement(env.DB, {
        actor,
        action: "website.capacities.archive",
        entityType: "website",
        entityId: "capacities",
        summary: `Archived ${statements.length} Capacities article(s); ${status.totals.images} image(s) checked, ${status.totals.missingImages ?? 0} missing from R2`,
    }).run();
    return status;
}

/**
 * Puts a Capacities article back at its address after it was handed to an Amplenote note: the
 * archived copy becomes the live post again (as it was), its own old addresses redirect to it, and
 * the note goes back to waiting for approval. One atomic batch.
 */
export async function undoReplacement(env: Env, uuid: string, actor: string, amplenotePostId: string) {
    const row = await env.DB.prepare("SELECT id, slug, title, redirects FROM capacities_archive WHERE replaced_by = ?")
        .bind(uuid)
        .first<{ id: string; slug: string; title: string; redirects: string }>();
    if (!row) return false;
    const ownRedirects = JSON.parse(row.redirects) as string[];
    const columns = POST_COLUMNS.join(", ");
    const ts = nowIso();
    const marks = ownRedirects.map(() => "?").join(", ");
    await env.DB.batch([
        env.DB.prepare("DELETE FROM posts WHERE id = ? AND source = 'amplenote'").bind(amplenotePostId),
        env.DB.prepare(`INSERT INTO posts (${columns}, source) SELECT ${columns}, 'capacities' FROM capacities_archive WHERE id = ?`).bind(row.id),
        // The note's own old addresses go with it; the article's own come back to it.
        env.DB.prepare(`DELETE FROM slug_redirects WHERE post_id = ?${ownRedirects.length ? ` AND from_slug NOT IN (${marks})` : ""}`).bind(
            amplenotePostId,
            ...ownRedirects,
        ),
        env.DB.prepare("UPDATE slug_redirects SET post_id = ? WHERE post_id = ?").bind(row.id, amplenotePostId),
        env.DB.prepare("UPDATE capacities_archive SET replaced_by = NULL, replaced_at = NULL WHERE id = ?").bind(row.id),
        env.DB.prepare(
            `UPDATE amplenote_articles SET replace_slug = NULL, replace_approved_by = NULL, replace_approved_at = NULL, slug = NULL, content_hash = NULL,
                state = CASE WHEN state = 'published' THEN 'withdrawn' ELSE state END,
                reason = 'Replacement undone: the Capacities article is back at its address', updated_at = ?
             WHERE uuid = ?`,
        ).bind(ts, uuid),
        env.DB.prepare("INSERT INTO meta (key, value) VALUES ('content_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(
            String(Date.now()),
        ),
        auditStatement(env.DB, {
            actor,
            action: "website.capacities.restore",
            entityType: "website",
            entityId: row.id,
            summary: `Restored the Capacities article at /blog/${row.slug} (undid its replacement by an Amplenote note)`,
        }),
    ]);
    return true;
}
