import type { D1Database } from "@cloudflare/workers-types";
import type { BlogFilters, Post, PostSummary, TocEntry } from "../src/shared/types";
import { mediaUrls } from "./lib/image";

export const PAGE_SIZE = 9;

interface Row {
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
    published_at: string;
    updated_at: string | null;
    reading_minutes: number;
    body_html?: string;
    toc?: string;
}

const SUMMARY_COLUMNS =
    "id, slug, title, subtitle, summary, category, tags, featured, image_key, image_alt, image_width, image_height, published_at, updated_at, reading_minutes";

const parseJson = <T>(value: string | undefined | null, fallback: T): T => {
    try {
        return value ? (JSON.parse(value) as T) : fallback;
    } catch {
        return fallback;
    }
};

export const toSummary = (row: Row, transforms: boolean): PostSummary => ({
    slug: row.slug,
    title: row.title,
    subtitle: row.subtitle,
    summary: row.summary,
    category: row.category,
    tags: parseJson<string[]>(row.tags, []),
    featured: row.featured === 1,
    image: row.image_key
        ? {
              ...mediaUrls(row.image_key, row.image_width, transforms),
              alt: row.image_alt ?? row.title,
              width: row.image_width ?? undefined,
              height: row.image_height ?? undefined,
          }
        : null,
    publishedAt: row.published_at,
    updatedAt: row.updated_at,
    readingMinutes: row.reading_minutes,
});

export class PostStore {
    constructor(
        private readonly db: D1Database,
        private readonly transforms: boolean,
    ) {}

    async latest(limit: number): Promise<PostSummary[]> {
        const { results } = await this.db.prepare(`SELECT ${SUMMARY_COLUMNS} FROM posts ORDER BY published_at DESC LIMIT ?`).bind(limit).all<Row>();
        return results.map((r) => toSummary(r, this.transforms));
    }

    async all(): Promise<(PostSummary & { bodyHtml: string })[]> {
        const { results } = await this.db.prepare(`SELECT ${SUMMARY_COLUMNS}, body_html FROM posts ORDER BY published_at DESC`).all<Row>();
        return results.map((r) => ({ ...toSummary(r, this.transforms), bodyHtml: r.body_html ?? "" }));
    }

    async bySlug(slug: string): Promise<(Post & { id: string }) | null> {
        const row = await this.db.prepare(`SELECT ${SUMMARY_COLUMNS}, body_html, toc FROM posts WHERE slug = ?`).bind(slug).first<Row>();
        if (!row) return null;
        return { ...toSummary(row, this.transforms), id: row.id, bodyHtml: row.body_html ?? "", toc: parseJson<TocEntry[]>(row.toc, []) };
    }

    /** Current slug for a renamed post, if the old slug is known. */
    async redirectFor(slug: string): Promise<string | null> {
        const row = await this.db
            .prepare("SELECT p.slug FROM slug_redirects r JOIN posts p ON p.id = r.post_id WHERE r.from_slug = ?")
            .bind(slug)
            .first<{ slug: string }>();
        return row?.slug ?? null;
    }

    async related(post: { id: string; category: string | null; tags: string[] }, limit = 3): Promise<PostSummary[]> {
        const { results } = await this.db
            .prepare(`SELECT ${SUMMARY_COLUMNS} FROM posts WHERE id != ? ORDER BY published_at DESC LIMIT 50`)
            .bind(post.id)
            .all<Row>();
        const tags = new Set(post.tags.map((t) => t.toLowerCase()));
        return results
            .map((row, index) => {
                const summary = toSummary(row, this.transforms);
                let score = summary.tags.filter((t) => tags.has(t.toLowerCase())).length * 2;
                if (post.category && summary.category === post.category) score += 3;
                return { summary, score, index };
            })
            .sort((a, b) => b.score - a.score || a.index - b.index)
            .slice(0, limit)
            .map((r) => r.summary);
    }

    /** The highlighted post: the newest one marked Featured, otherwise the newest overall. */
    async featured(): Promise<PostSummary | null> {
        const row = await this.db.prepare(`SELECT ${SUMMARY_COLUMNS} FROM posts ORDER BY featured DESC, published_at DESC LIMIT 1`).first<Row>();
        return row ? toSummary(row, this.transforms) : null;
    }

    async categories(): Promise<{ name: string; count: number }[]> {
        const { results } = await this.db
            .prepare(
                "SELECT category AS name, COUNT(*) AS count FROM posts WHERE category IS NOT NULL AND category != '' GROUP BY category ORDER BY count DESC, name ASC",
            )
            .all<{ name: string; count: number }>();
        return results;
    }

    async search(filters: BlogFilters, excludeSlug: string | null = null) {
        const where: string[] = [];
        const params: (string | number)[] = [];
        if (excludeSlug) {
            where.push("slug != ?");
            params.push(excludeSlug);
        }
        if (filters.q) {
            const like = `%${filters.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
            where.push("(title LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\' OR search_text LIKE ? ESCAPE '\\')");
            params.push(like, like, like, like);
        }
        if (filters.category) {
            where.push("category = ?");
            params.push(filters.category);
        }
        if (filters.tag) {
            where.push("EXISTS (SELECT 1 FROM json_each(posts.tags) WHERE lower(json_each.value) = lower(?))");
            params.push(filters.tag);
        }
        const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
        const total =
            (
                await this.db
                    .prepare(`SELECT COUNT(*) AS n FROM posts ${clause}`)
                    .bind(...params)
                    .first<{ n: number }>()
            )?.n ?? 0;
        const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
        const page = Math.min(Math.max(1, filters.page), totalPages);
        const { results } = await this.db
            .prepare(`SELECT ${SUMMARY_COLUMNS} FROM posts ${clause} ORDER BY published_at DESC LIMIT ? OFFSET ?`)
            .bind(...params, PAGE_SIZE, (page - 1) * PAGE_SIZE)
            .all<Row>();
        return { posts: results.map((r) => toSummary(r, this.transforms)), total, totalPages, page };
    }

    async sitemapEntries(): Promise<{ slug: string; lastmod: string }[]> {
        const { results } = await this.db
            .prepare("SELECT slug, COALESCE(updated_at, published_at) AS lastmod FROM posts ORDER BY published_at DESC")
            .all<{ slug: string; lastmod: string }>();
        return results;
    }
}
