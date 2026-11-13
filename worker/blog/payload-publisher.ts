import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
// Payload as the blog's publisher (docs/PAYLOAD-BLOG.md). Payload is where posts are written and
// kept; publishing a post writes its public form into the same `posts` table (source 'payload') and
// `media` bucket the site has always read, so the public pages, feeds, sitemap and SEO are rendered
// by exactly the code that renders them today.
//
// Every string from Payload is escaped here (the same rule as capacities/render.ts): rich text is
// rendered from Lexical's JSON node by node, unknown nodes contribute only their escaped text, and
// links are limited to http(s), mailto and site-relative paths. Posts imported from the earlier
// publishers keep their stored HTML byte for byte until someone edits their content in Payload.
import type { TocEntry } from "../../src/shared/types";
import { codeBlock, imageFigure, quote } from "../lib/article-html";
import { escapeHtml, isExternal, isValidSlug, safeUrl, slugify } from "../lib/html";
import { ALLOWED_IMAGE_TYPES, MAX_IMAGE_BYTES, imageDimensions, mediaUrls } from "../lib/image";

/** A Lexical node as Payload stores it (only the fields this renderer reads). */
export interface LexicalNode {
    type?: string;
    children?: LexicalNode[];
    text?: string;
    format?: number | string;
    tag?: string;
    listType?: string;
    checked?: boolean;
    url?: string;
    fields?: { url?: string; newTab?: boolean; linkType?: string; doc?: unknown } | null;
    relationTo?: string;
    value?: unknown;
    language?: string;
}

export interface StoredImage {
    key: string;
    alt: string;
    width: number | null;
    height: number | null;
}

/** An image file from Payload's own media store, read on demand. */
export interface MediaFile {
    bytes: Uint8Array;
    contentType: string;
    alt: string;
    caption?: string | null;
}

export interface PayloadPostInput {
    /** The `posts.id` this post is published under. Imported posts keep their original id. */
    postId: string;
    slug: string;
    title: string;
    subtitle?: string | null;
    summary?: string | null;
    category?: string | null;
    tags?: string[] | null;
    featured?: boolean | null;
    publishedAt?: string | null;
    updatedAt?: string | null;
    /** Lexical rich text. When empty and `legacy` is present, the stored HTML is kept as it is. */
    content?: { root?: LexicalNode } | null;
    /** What an imported post had in `posts`, kept verbatim. */
    legacy?: {
        body_html: string;
        toc: TocEntry[];
        search_text: string;
        word_count: number;
        reading_minutes: number;
    } | null;
    /** The featured image: an id in Payload's media collection, or one already in the public bucket. */
    heroMediaId?: string | number | null;
    legacyImage?: StoredImage | null;
}

export interface PublisherEnv {
    DB: D1Database;
    MEDIA: R2Bucket;
    SITE_URL: string;
}

export interface PublishContext {
    /** Reads a Payload media document's file; null when it doesn't exist or isn't an image. */
    loadMedia(id: string | number): Promise<MediaFile | null>;
    now?: () => Date;
    /** Image transformations (srcset) — off unless the zone has them. */
    transforms?: boolean;
}

export class PublishError extends Error {}

const FORMAT = { bold: 1, italic: 2, strikethrough: 4, underline: 8, code: 16, subscript: 32, superscript: 64 };

const sha256 = async (input: string | Uint8Array) => {
    const data = (typeof input === "string" ? new TextEncoder().encode(input) : input) as Uint8Array<ArrayBuffer>;
    return [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))].map((b) => b.toString(16).padStart(2, "0")).join("");
};

export const excerpt = (text: string) => {
    const flat = text.replace(/\s+/g, " ").trim();
    if (flat.length <= 200) return flat || null;
    return flat.slice(0, 200).replace(/\s+\S*$/, "") + "…";
};

/** Links allowed in post content: http(s), mailto and paths on this site. Everything else is dropped. */
export const safeHref = (value: string | undefined | null): string | null => {
    if (!value) return null;
    const trimmed = value.trim();
    if (/^\/(?!\/)[^\s\\]*$/.test(trimmed)) return trimmed;
    if (/^#[\w-]+$/.test(trimmed)) return trimmed;
    return safeUrl(trimmed);
};

export interface RenderedContent {
    html: string;
    toc: TocEntry[];
    text: string;
    wordCount: number;
    /** Ids of the Payload media used inline, in order. */
    images: Array<string | number>;
}

/**
 * Renders Lexical JSON to the article markup. `image` resolves an upload node to a public image
 * (already stored in the public bucket) or null to leave it out.
 */
export const renderLexical = (
    root: LexicalNode | null | undefined,
    ctx: { siteUrl: string; image: (id: string | number) => (StoredImage & { caption?: string | null; srcSet?: string; src: string }) | null },
): RenderedContent => {
    const toc: TocEntry[] = [];
    const used = new Set<string>();
    const textParts: string[] = [];
    const images: Array<string | number> = [];

    const plain = (node: LexicalNode): string =>
        node.type === "text" ? (node.text ?? "") : node.type === "linebreak" ? "\n" : (node.children ?? []).map(plain).join("");

    const headingId = (text: string) => {
        const base = slugify(text) || "section";
        let id = base;
        for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
        used.add(id);
        return id;
    };

    const inline = (nodes: LexicalNode[] | undefined): string =>
        (nodes ?? [])
            .map((node) => {
                switch (node.type) {
                    case "text": {
                        const format = typeof node.format === "number" ? node.format : 0;
                        let html = escapeHtml(node.text ?? "");
                        if (format & FORMAT.code) return `<code>${html}</code>`;
                        if (format & FORMAT.bold) html = `<strong>${html}</strong>`;
                        if (format & FORMAT.italic) html = `<em>${html}</em>`;
                        if (format & FORMAT.strikethrough) html = `<s>${html}</s>`;
                        if (format & FORMAT.underline) html = `<u>${html}</u>`;
                        if (format & FORMAT.subscript) html = `<sub>${html}</sub>`;
                        if (format & FORMAT.superscript) html = `<sup>${html}</sup>`;
                        return html;
                    }
                    case "linebreak":
                        return "<br>";
                    case "tab":
                        return " ";
                    case "link":
                    case "autolink": {
                        const inner = inline(node.children);
                        // Links to another Payload document (linkType "internal") aren't resolved: the text stays.
                        const href = node.fields?.linkType === "internal" ? null : safeHref(node.fields?.url ?? node.url);
                        if (!href) return inner;
                        const external = /^https?:/.test(href) && isExternal(href, ctx.siteUrl);
                        return `<a href="${escapeHtml(href)}"${external ? ' rel="noopener noreferrer" target="_blank"' : ""}>${inner}</a>`;
                    }
                    default:
                        // Unknown inline nodes contribute their text, escaped, and nothing else.
                        return escapeHtml(plain(node));
                }
            })
            .join("");

    const list = (node: LexicalNode): string => {
        const tag = node.listType === "number" ? "ol" : "ul";
        const check = node.listType === "check";
        const items = (node.children ?? [])
            .map((item) => {
                const nested = (item.children ?? []).filter((c) => c.type === "list");
                const own = (item.children ?? []).filter((c) => c.type !== "list");
                if (nested.length && !own.length) return nested.map(list).join("");
                textParts.push(own.map(plain).join(""));
                const box = check ? `<input type="checkbox" disabled${item.checked ? " checked" : ""}> ` : "";
                return `<li>${box}${inline(own)}${nested.map(list).join("")}</li>`;
            })
            .join("");
        return `<${tag}${check ? ' class="checklist"' : ""}>${items}</${tag}>`;
    };

    const block = (node: LexicalNode): string => {
        switch (node.type) {
            case "paragraph": {
                const text = plain(node);
                if (!text.trim() && !(node.children ?? []).some((c) => c.type === "linebreak")) return "";
                textParts.push(text);
                return `<p>${inline(node.children)}</p>`;
            }
            case "heading": {
                const level = Math.min(6, Math.max(2, Number(/^h([1-6])$/.exec(node.tag ?? "")?.[1] ?? 2)));
                const text = plain(node).trim();
                if (!text) return "";
                const id = headingId(text);
                textParts.push(text);
                if (level === 2 || level === 3) toc.push({ id, text, level });
                return `<h${level} id="${id}">${inline(node.children)}</h${level}>`;
            }
            case "quote":
                textParts.push(plain(node));
                return quote(`<p>${inline(node.children)}</p>`);
            case "list":
                return list(node);
            case "horizontalrule":
                return "<hr>";
            case "code": {
                const code = plain(node);
                textParts.push(code);
                return codeBlock(code, node.language);
            }
            case "upload": {
                if (node.relationTo !== "media") return "";
                const value = node.value as { id?: string | number } | string | number | null;
                const id = typeof value === "object" && value ? value.id : value;
                if (id === undefined || id === null) return "";
                const image = ctx.image(id);
                if (!image) return "";
                images.push(id);
                const dims = image.width && image.height ? ` width="${image.width}" height="${image.height}"` : "";
                const srcSet = image.srcSet ? ` srcset="${escapeHtml(image.srcSet)}" sizes="(min-width: 768px) 720px, 100vw"` : "";
                return imageFigure(
                    `<img src="${escapeHtml(image.src)}"${srcSet} alt="${escapeHtml(image.alt)}"${dims} loading="lazy" decoding="async">`,
                    image.caption ? escapeHtml(image.caption) : null,
                );
            }
            default: {
                // Unknown block: keep its text as a paragraph rather than dropping words silently.
                const text = plain(node).trim();
                if (!text) return "";
                textParts.push(text);
                return `<p>${escapeHtml(text)}</p>`;
            }
        }
    };

    const html = (root?.children ?? []).map(block).join("");
    const text = textParts.join("\n").trim();
    const wordCount = text ? text.split(/\s+/).filter(Boolean).length : 0;
    return { html, toc, text, wordCount, images };
};

/** Every upload id in a Lexical tree, so their files can be copied before rendering. */
export const uploadIds = (root: LexicalNode | null | undefined): Array<string | number> => {
    const ids: Array<string | number> = [];
    const walk = (node: LexicalNode) => {
        if (node.type === "upload" && node.relationTo === "media") {
            const value = node.value as { id?: string | number } | string | number | null;
            const id = typeof value === "object" && value ? value.id : value;
            if (id !== undefined && id !== null) ids.push(id);
        }
        for (const child of node.children ?? []) walk(child);
    };
    if (root) walk(root);
    return ids;
};

/** True when the editor holds any words or images (an untouched editor holds one empty paragraph). */
export const lexicalHasContent = (root: LexicalNode | null | undefined): boolean => {
    const walk = (node: LexicalNode): boolean =>
        (node.type === "text" && !!node.text?.trim()) || (node.type === "upload" && node.relationTo === "media") || (node.children ?? []).some(walk);
    return !!root && walk(root);
};

/**
 * Copies an image into the public bucket under its content hash (the same scheme as the Capacities
 * sync) and records it in `media`. Returns null for anything that isn't an allowed image type.
 */
export async function storePublicImage(env: PublisherEnv, mediaId: string, file: MediaFile, now: string): Promise<StoredImage | null> {
    const type = file.contentType.split(";")[0].trim().toLowerCase();
    const ext = ALLOWED_IMAGE_TYPES[type];
    if (!ext || file.bytes.byteLength > MAX_IMAGE_BYTES) return null;
    const key = `${(await sha256(file.bytes)).slice(0, 24)}.${ext}`;
    const dims = imageDimensions(file.bytes, type);
    if (!(await env.MEDIA.head(key)))
        await env.MEDIA.put(key, file.bytes, { httpMetadata: { contentType: type, cacheControl: "public, max-age=31536000, immutable" } });
    await env.DB.prepare(
        "INSERT INTO media (id, r2_key, content_type, width, height, bytes, alt, caption, created_at, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET r2_key = excluded.r2_key, content_type = excluded.content_type, width = excluded.width, height = excluded.height, bytes = excluded.bytes, alt = excluded.alt, caption = excluded.caption, checked_at = excluded.checked_at",
    )
        .bind(mediaId, key, type, dims?.width ?? null, dims?.height ?? null, file.bytes.byteLength, file.alt || null, file.caption ?? null, now, now)
        .run();
    return { key, alt: file.alt, width: dims?.width ?? null, height: dims?.height ?? null };
}

const bumpContentVersion = (db: D1Database, now: string) =>
    db.prepare("INSERT INTO meta (key, value) VALUES ('content_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(now);

export type PublishOutcome = { outcome: "published" | "updated" | "unchanged"; postId: string; slug: string };

/**
 * Publishes (or republishes) a Payload post into `posts`. Fails closed: an invalid slug, a slug owned
 * by another post, or a row owned by another publisher is refused and nothing is written.
 */
export async function publishPayloadPost(env: PublisherEnv, input: PayloadPostInput, ctx: PublishContext): Promise<PublishOutcome> {
    const now = (ctx.now?.() ?? new Date()).toISOString();
    const title = input.title?.trim();
    if (!title) throw new PublishError("A published post needs a title.");
    const slug = slugify(input.slug || title);
    if (!slug || !isValidSlug(slug)) throw new PublishError(`"${input.slug}" can't be used as a web address.`);

    const existing = await env.DB.prepare("SELECT id, slug, source, content_hash FROM posts WHERE id = ?")
        .bind(input.postId)
        .first<{ id: string; slug: string; source: string; content_hash: string }>();
    // An imported post is claimed by its import (payload-import.ts) before it's published from here.
    if (existing && existing.source !== "payload") throw new PublishError(`Post ${input.postId} belongs to the ${existing.source} publisher.`);
    const clash = await env.DB.prepare("SELECT id FROM posts WHERE slug = ? AND id != ?").bind(slug, input.postId).first<{ id: string }>();
    if (clash) throw new PublishError(`/blog/${slug} is already used by another post.`);

    // Images first, so the HTML only ever points at files that exist.
    const stored = new Map<string, StoredImage & { caption?: string | null }>();
    const copy = async (id: string | number) => {
        const key = String(id);
        if (stored.has(key)) return stored.get(key)!;
        const file = await ctx.loadMedia(id);
        if (!file) return null;
        const image = await storePublicImage(env, `payload-media:${key}`, file, now);
        if (image) stored.set(key, { ...image, caption: file.caption ?? null });
        return image;
    };

    const root = input.content?.root;
    const hasContent = lexicalHasContent(root);
    let body: { html: string; toc: TocEntry[]; text: string; wordCount: number; readingMinutes: number };
    if (hasContent) {
        for (const id of uploadIds(root)) await copy(id);
        const rendered = renderLexical(root, {
            siteUrl: env.SITE_URL,
            image: (id) => {
                const image = stored.get(String(id));
                return image ? { ...image, ...mediaUrls(image.key, image.width, !!ctx.transforms) } : null;
            },
        });
        body = {
            html: rendered.html,
            toc: rendered.toc,
            text: rendered.text,
            wordCount: rendered.wordCount,
            readingMinutes: Math.max(1, Math.round(rendered.wordCount / 225)),
        };
    } else if (input.legacy) {
        body = {
            html: input.legacy.body_html,
            toc: input.legacy.toc,
            text: input.legacy.search_text,
            wordCount: input.legacy.word_count,
            readingMinutes: input.legacy.reading_minutes,
        };
    } else throw new PublishError("A published post needs some content.");

    let image: StoredImage | null = input.legacyImage ?? null;
    if (input.heroMediaId !== undefined && input.heroMediaId !== null) {
        image = await copy(input.heroMediaId);
        if (!image) throw new PublishError("The featured image couldn't be read, or isn't a JPEG, PNG, GIF, WebP or AVIF under 15 MB.");
    }

    const record = {
        title,
        subtitle: input.subtitle?.trim() || null,
        summary: input.summary?.trim() || excerpt(body.text),
        category: input.category?.trim() || null,
        tags: [...new Set((input.tags ?? []).map((t) => t.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
        featured: !!input.featured,
        image_key: image?.key ?? null,
        image_alt: image ? image.alt || title : null,
        image_width: image?.width ?? null,
        image_height: image?.height ?? null,
        body_html: body.html,
        toc: body.toc,
        search_text: body.text.slice(0, 20_000),
        word_count: body.wordCount,
        reading_minutes: body.readingMinutes,
        published_at: input.publishedAt ?? now,
        updated_at: input.updatedAt ?? null,
    };
    const content_hash = await sha256(JSON.stringify({ slug, ...record }));
    if (existing && existing.content_hash === content_hash && existing.slug === slug) return { outcome: "unchanged", postId: input.postId, slug };

    const statements = [
        env.DB.prepare(
            `INSERT INTO posts (id, slug, title, subtitle, summary, category, tags, featured, image_key, image_alt, image_width, image_height,
                body_html, toc, search_text, word_count, reading_minutes, published_at, updated_at, source_updated_at, content_hash, render_context, synced_at, source)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'payload')
             ON CONFLICT(id) DO UPDATE SET slug = excluded.slug, title = excluded.title, subtitle = excluded.subtitle, summary = excluded.summary,
                category = excluded.category, tags = excluded.tags, featured = excluded.featured, image_key = excluded.image_key, image_alt = excluded.image_alt,
                image_width = excluded.image_width, image_height = excluded.image_height, body_html = excluded.body_html, toc = excluded.toc,
                search_text = excluded.search_text, word_count = excluded.word_count, reading_minutes = excluded.reading_minutes,
                published_at = excluded.published_at, updated_at = excluded.updated_at, source_updated_at = excluded.source_updated_at,
                content_hash = excluded.content_hash, synced_at = excluded.synced_at
             WHERE posts.source = 'payload'`,
        ).bind(
            input.postId,
            slug,
            record.title,
            record.subtitle,
            record.summary,
            record.category,
            JSON.stringify(record.tags),
            record.featured ? 1 : 0,
            record.image_key,
            record.image_alt,
            record.image_width,
            record.image_height,
            record.body_html,
            JSON.stringify(record.toc),
            record.search_text,
            record.word_count,
            record.reading_minutes,
            record.published_at,
            record.updated_at,
            input.updatedAt ?? now,
            content_hash,
            now,
        ),
        // A slug that now belongs to this post must not redirect anywhere.
        env.DB.prepare("DELETE FROM slug_redirects WHERE from_slug = ?").bind(slug),
        bumpContentVersion(env.DB, now),
    ];
    // The old address keeps working: it redirects to the new one.
    if (existing && existing.slug !== slug)
        statements.push(
            env.DB.prepare(
                "INSERT INTO slug_redirects (from_slug, post_id, created_at) VALUES (?, ?, ?) ON CONFLICT(from_slug) DO UPDATE SET post_id = excluded.post_id",
            ).bind(existing.slug, input.postId, now),
        );
    await env.DB.batch(statements);
    return { outcome: existing ? "updated" : "published", postId: input.postId, slug };
}

/**
 * Takes a Payload post off the public site. Only rows Payload owns are touched. The post itself stays
 * in Payload (and in backups).
 *
 * Its old addresses are kept, and its current one is added to them: while the post is off the site
 * they all answer 404 (redirectFor joins on the posts row, which is gone), and when it's published
 * again, at this address or a new one, every earlier address leads to it again. `forget` is for a post
 * deleted for good: its addresses are released.
 */
export async function unpublishPayloadPost(env: PublisherEnv, postId: string, options: { forget?: boolean; now?: Date } = {}): Promise<boolean> {
    const row = await env.DB.prepare("SELECT source, slug FROM posts WHERE id = ?").bind(postId).first<{ source: string; slug: string }>();
    if (row && row.source !== "payload") throw new PublishError(`Post ${postId} belongs to the ${row.source} publisher.`);
    const at = (options.now ?? new Date()).toISOString();
    if (!row) {
        // Already off the site (in Trash, say). Deleting it for good still releases the addresses kept for it.
        if (options.forget)
            await env.DB.prepare("DELETE FROM slug_redirects WHERE post_id = ? AND NOT EXISTS (SELECT 1 FROM posts WHERE id = ?)").bind(postId, postId).run();
        return false;
    }
    await env.DB.batch([
        env.DB.prepare("DELETE FROM posts WHERE id = ? AND source = 'payload'").bind(postId),
        options.forget
            ? env.DB.prepare("DELETE FROM slug_redirects WHERE post_id = ?").bind(postId)
            : env.DB.prepare(
                  "INSERT INTO slug_redirects (from_slug, post_id, created_at) VALUES (?, ?, ?) ON CONFLICT(from_slug) DO UPDATE SET post_id = excluded.post_id",
              ).bind(row.slug, postId, at),
        bumpContentVersion(env.DB, at),
    ]);
    return true;
}
