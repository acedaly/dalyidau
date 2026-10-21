// Publishes Amplenote notes to the blog. Two sources feed it (docs/AMPLENOTE.md):
//
//   The plugin (amplenote/plugin.js), running inside Amplenote whenever the owner uses it: every note
//   tagged website/blog, its public URL (app.getNotePublicURL) and, for published notes only, its
//   content as markdown. POSTed to /api/amplenote/ingest with AMPLENOTE_PUBLISH_TOKEN.
//   The REST API (optional, every 15 minutes): whether each note is still public, tagged and not
//   deleted, and its current title.
//
// A note is public only while ALL of these hold: it carries the tag, Amplenote reports it published
// with a public URL, that URL answers, and (when the API is connected) the API agrees it's public,
// tagged and not deleted. Anything uncertain keeps the last known state: a failed request or an
// empty report never withdraws anything, and absence must be seen twice in a row.
import type { Env } from "../env";
import { escapeHtml, isValidSlug, slugify } from "../lib/html";
import { ALLOWED_IMAGE_TYPES, MAX_IMAGE_BYTES, imageDimensions, mediaUrls } from "../lib/image";
import { type ApiNote, accessToken, hosts, listNotes, loadConnection } from "./client";
import { renderMarkdown } from "./markdown";
import { type Conventions, conventions, extractMetadata, hasTag, publicToken, tagMetadata, websiteTags, withoutRepeatedTitle } from "./metadata";

export const MISSING_THRESHOLD = 2;
const LINK_FAILURE_THRESHOLD = 2;
const FULL_LISTING_HOURS = 6;
const LINK_CHECKS_PER_RUN = 10;
const IMAGES_PER_ARTICLE = 15;
const LOCK_MINUTES = 5;

export interface PluginNote {
    uuid: string;
    name?: string | null;
    tags: string[];
    created?: string | null;
    updated?: string | null;
    publicUrl?: string | null;
    markdown?: string | null;
}

export interface PluginReport {
    /** True when the plugin listed every tagged note, so a note missing from it may have lost its tag. */
    complete: boolean;
    notes: PluginNote[];
}

export interface ArticleRow {
    uuid: string;
    slug: string | null;
    title: string | null;
    website_tags: string;
    public_token: string | null;
    markdown: string | null;
    note_created_at: string | null;
    note_updated_at: string | null;
    first_published_at: string | null;
    plugin_tagged: number | null;
    plugin_published: number | null;
    plugin_seen_at: string | null;
    plugin_missing: number;
    rest_public: number | null;
    rest_tagged: number | null;
    rest_deleted: number | null;
    rest_seen_at: string | null;
    rest_missing: number;
    link_status: string | null;
    link_checked_at: string | null;
    link_failures: number;
    state: "pending" | "published" | "withdrawn";
    reason: string | null;
    content_hash: string | null;
}

export interface RunSummary {
    runId: number | null;
    trigger: string;
    status: "ok" | "partial" | "failed" | "skipped";
    listed: number;
    checked: number;
    published: number;
    updated: number;
    unpublished: number;
    unchanged: number;
    errors: number;
    log: string[];
}

export interface RunOptions {
    trigger: "plugin" | "cron" | "manual";
    fetchImpl?: typeof fetch;
    now?: () => Date;
}

export const postId = (uuid: string) => `amplenote:${uuid}`;

const shortId = (uuid: string) => uuid.slice(0, 8);

const sha256 = async (input: string | Uint8Array) => {
    const data = (typeof input === "string" ? new TextEncoder().encode(input) : input) as Uint8Array<ArrayBuffer>;
    return [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))].map((b) => b.toString(16).padStart(2, "0")).join("");
};

const isoOrNull = (value: string | null | undefined) => {
    if (!value) return null;
    const time = Date.parse(value);
    return Number.isFinite(time) ? new Date(time).toISOString() : null;
};

/**
 * Why a note isn't public, or null when every check passes. `restConnected` adds the API's checks.
 * Pure, so the rules can be read (and tested) in one place.
 */
export const ineligibility = (row: ArticleRow, restConnected: boolean): string | null => {
    if (row.plugin_seen_at === null) return "Waiting for the Amplenote plugin to report this note";
    if (row.plugin_tagged !== 1) return "No longer tagged for the website in Amplenote";
    if (row.plugin_missing >= MISSING_THRESHOLD) return "No longer reported by the Amplenote plugin (tag removed or note deleted)";
    if (row.plugin_published !== 1 || !row.public_token) return "Not published in Amplenote";
    if (!row.title?.trim()) return "The note has no title";
    if (!row.markdown?.trim()) return "Waiting for the article's content from the Amplenote plugin";
    if (row.link_status === "gone" && row.link_failures >= LINK_FAILURE_THRESHOLD) return "Its public Amplenote link no longer works";
    // The first publication needs a confirmed link; after that a passing hiccup keeps the article up.
    if (row.state !== "published" && row.link_status !== "ok") return "Checking its public Amplenote link";
    if (restConnected) {
        if (row.rest_deleted === 1) return "Deleted in Amplenote";
        if (row.rest_public === 0) return "Not published in Amplenote (according to the Amplenote API)";
        if (row.rest_tagged === 0) return "No longer tagged for the website (according to the Amplenote API)";
        if (row.rest_missing >= MISSING_THRESHOLD) return "Missing from the Amplenote API's note list";
        if (row.rest_public === null && row.state !== "published") return "Waiting for the Amplenote API to confirm it's published";
    }
    return null;
};

class Run {
    readonly summary: RunSummary;
    readonly now: () => Date;
    readonly fetchImpl: typeof fetch;
    readonly c: Conventions;
    changed = false;

    constructor(
        readonly env: Env,
        options: RunOptions,
    ) {
        this.now = options.now ?? (() => new Date());
        // Called as this.fetchImpl(...): the global must not be called with this object as `this` (workerd refuses).
        this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
        this.c = conventions(env.AMPLENOTE_TAG);
        this.summary = {
            runId: null,
            trigger: `amplenote:${options.trigger}`,
            status: "ok",
            listed: 0,
            checked: 0,
            published: 0,
            updated: 0,
            unpublished: 0,
            unchanged: 0,
            errors: 0,
            log: [],
        };
    }

    log(message: string) {
        this.summary.log.push(message);
        console.log(JSON.stringify({ event: "amplenote", message }));
    }

    fail(message: string) {
        this.summary.errors++;
        this.summary.log.push(`ERROR ${message}`);
        console.error(JSON.stringify({ event: "amplenote_error", message }));
    }

    timestamp() {
        return this.now().toISOString();
    }

    async articles() {
        return new Map((await this.env.DB.prepare("SELECT * FROM amplenote_articles").all<ArticleRow>()).results.map((r) => [r.uuid, r]));
    }

    /** Records the run alongside the Capacities runs (sync_runs), and invalidates cached pages if anything public changed. */
    async finish(started: string): Promise<RunSummary> {
        const s = this.summary;
        if (s.status === "ok" && s.errors > 0) s.status = "partial";
        const db = this.env.DB;
        if (this.changed) {
            await db
                .prepare("INSERT INTO meta (key, value) VALUES ('content_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
                .bind(String(this.now().getTime()))
                .run();
        }
        const row = await db
            .prepare(
                `INSERT INTO sync_runs (trigger, started_at, finished_at, status, listed, checked, published, updated, unpublished, unchanged, errors, log)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
            )
            .bind(
                s.trigger,
                started,
                this.timestamp(),
                s.status,
                s.listed,
                s.checked,
                s.published,
                s.updated,
                s.unpublished,
                s.unchanged,
                s.errors,
                JSON.stringify(s.log.slice(0, 200)),
            )
            .first<{ id: number }>();
        s.runId = row?.id ?? null;
        console.log(JSON.stringify({ event: "amplenote_complete", ...s, log: undefined }));
        return s;
    }

    // --- Inputs -----------------------------------------------------------------------------------

    /** Applies a plugin report: what Amplenote's own client says about every tagged note. */
    async applyReport(report: PluginReport) {
        const db = this.env.DB;
        const existing = await this.articles();
        const ts = this.timestamp();
        const seen = new Set<string>();
        const statements = [];
        for (const note of report.notes) {
            const uuid = note.uuid.toLowerCase();
            if (seen.has(uuid)) continue;
            seen.add(uuid);
            this.summary.listed++;
            const tagged = hasTag(note.tags, this.c.tag);
            const token = tagged ? publicToken(note.publicUrl, hosts(this.env).public) : null;
            const row = existing.get(uuid);
            if (!tagged && !row) continue; // Never seen as a blog note: nothing about it is stored.
            if (!token) {
                // Tagged but not published (or the tag is gone): record only that, and none of its content.
                statements.push(
                    db
                        .prepare(
                            `INSERT INTO amplenote_articles (uuid, plugin_tagged, plugin_published, plugin_seen_at, plugin_missing, created_at, updated_at)
                             VALUES (?1, ?2, 0, ?3, 0, ?3, ?3)
                             ON CONFLICT(uuid) DO UPDATE SET plugin_tagged = excluded.plugin_tagged, plugin_published = 0, plugin_seen_at = excluded.plugin_seen_at,
                                plugin_missing = 0, public_token = NULL, updated_at = excluded.updated_at`,
                        )
                        .bind(uuid, tagged ? 1 : 0, ts),
                );
                continue;
            }
            const markdown = typeof note.markdown === "string" ? note.markdown : null;
            const tokenChanged = !!row?.public_token && row.public_token !== token;
            statements.push(
                db
                    .prepare(
                        `INSERT INTO amplenote_articles (uuid, title, website_tags, public_token, markdown, note_created_at, note_updated_at,
                            plugin_tagged, plugin_published, plugin_seen_at, plugin_missing, created_at, updated_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, 1, ?8, 0, ?8, ?8)
                         ON CONFLICT(uuid) DO UPDATE SET title = COALESCE(excluded.title, title), website_tags = excluded.website_tags,
                            public_token = excluded.public_token, markdown = COALESCE(excluded.markdown, markdown),
                            note_created_at = COALESCE(excluded.note_created_at, note_created_at), note_updated_at = COALESCE(excluded.note_updated_at, note_updated_at),
                            plugin_tagged = 1, plugin_published = 1, plugin_seen_at = excluded.plugin_seen_at, plugin_missing = 0,
                            link_status = CASE WHEN ?9 THEN NULL ELSE link_status END, link_failures = CASE WHEN ?9 THEN 0 ELSE link_failures END,
                            updated_at = excluded.updated_at`,
                    )
                    .bind(
                        uuid,
                        note.name?.trim() ? note.name.trim().slice(0, 300) : null,
                        JSON.stringify(websiteTags(note.tags, this.c)),
                        token,
                        markdown,
                        isoOrNull(note.created),
                        isoOrNull(note.updated),
                        ts,
                        tokenChanged ? 1 : 0,
                    ),
            );
        }
        if (report.complete) {
            const publishedCount = [...existing.values()].filter((r) => r.state === "published").length;
            if (seen.size === 0 && publishedCount >= 2) {
                // An empty list while articles are live looks like a client that hasn't loaded yet, not
                // like every tag being removed at once. Nothing is withdrawn on its say-so.
                this.fail("The plugin reported no tagged notes at all; ignored. Remove tags one at a time, or use the API connection.");
            } else {
                for (const row of existing.values()) {
                    if (seen.has(row.uuid) || row.plugin_tagged !== 1) continue;
                    statements.push(
                        db.prepare("UPDATE amplenote_articles SET plugin_missing = plugin_missing + 1, updated_at = ? WHERE uuid = ?").bind(ts, row.uuid),
                    );
                    if (row.slug) this.log(`/blog/${row.slug} wasn't in the plugin's list (${row.plugin_missing + 1}/${MISSING_THRESHOLD})`);
                }
            }
        }
        if (statements.length) await db.batch(statements);
    }

    /** Applies the REST API's view. Returns false (and changes nothing) when it can't be used. */
    async applyRest(forceFull = false): Promise<boolean> {
        const env = this.env;
        const connection = await loadConnection(env);
        if (!connection) return false;
        const token = await accessToken(env, connection, this.fetchImpl, this.now());
        if (!token) {
            this.fail("The Amplenote API connection needs to be renewed; its checks were skipped and nothing was changed");
            return false;
        }
        const now = this.now();
        const full =
            forceFull ||
            !connection.list_cursor ||
            !connection.full_listed_at ||
            now.getTime() - Date.parse(connection.full_listed_at) > FULL_LISTING_HOURS * 3_600_000;
        let notes: ApiNote[];
        try {
            // A few minutes' overlap, so a change made while the last listing ran isn't missed.
            notes = await listNotes(env, token, full ? null : connection.list_cursor! - 300, this.fetchImpl);
        } catch (error) {
            this.fail(`${(error as Error).message}; the API's checks were skipped and nothing was changed`);
            await env.DB.prepare("UPDATE amplenote_connection SET last_error = ?, updated_at = ? WHERE id = 1")
                .bind((error as Error).message.slice(0, 300), now.toISOString())
                .run();
            return true;
        }
        if (full && notes.length === 0) {
            this.fail("The Amplenote API listed no notes at all; treated as an incomplete answer and ignored");
            return true;
        }
        const existing = await this.articles();
        const ts = now.toISOString();
        const statements = [];
        const listed = new Set<string>();
        for (const note of notes) {
            listed.add(note.uuid);
            const tagged = hasTag(note.tags, this.c.tag);
            const row = existing.get(note.uuid);
            if (!row && !(tagged && note.public && !note.deleted)) continue; // Only blog notes are stored.
            statements.push(
                env.DB.prepare(
                    `INSERT INTO amplenote_articles (uuid, title, website_tags, rest_public, rest_tagged, rest_deleted, rest_seen_at, rest_missing, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?7, ?7)
                     ON CONFLICT(uuid) DO UPDATE SET title = CASE WHEN ?4 = 1 AND ?5 = 1 AND ?6 = 0 AND ?2 IS NOT NULL THEN ?2 ELSE title END,
                        rest_public = excluded.rest_public, rest_tagged = excluded.rest_tagged, rest_deleted = excluded.rest_deleted,
                        rest_seen_at = excluded.rest_seen_at, rest_missing = 0, updated_at = excluded.updated_at`,
                ).bind(
                    note.uuid,
                    note.name?.trim() ? note.name.trim().slice(0, 300) : null,
                    JSON.stringify(websiteTags(note.tags, this.c)),
                    note.public ? 1 : 0,
                    tagged ? 1 : 0,
                    note.deleted ? 1 : 0,
                    ts,
                ),
            );
            if (!row) this.log(`Found a published, tagged note (${shortId(note.uuid)}) through the API; waiting for the plugin to send its content`);
        }
        if (full) {
            for (const row of existing.values()) {
                if (listed.has(row.uuid) || row.rest_seen_at === null) continue;
                statements.push(
                    env.DB.prepare("UPDATE amplenote_articles SET rest_missing = rest_missing + 1, updated_at = ? WHERE uuid = ?").bind(ts, row.uuid),
                );
            }
        }
        const newest = Math.max(0, ...notes.map((n) => n.updated ?? 0));
        statements.push(
            env.DB.prepare(
                `UPDATE amplenote_connection SET list_cursor = ?, full_listed_at = CASE WHEN ? THEN ? ELSE full_listed_at END, last_error = NULL, updated_at = ? WHERE id = 1`,
            ).bind(Math.max(newest, Math.floor(now.getTime() / 1000) - 60), full ? 1 : 0, ts, ts),
        );
        await env.DB.batch(statements);
        this.summary.listed += notes.length;
        this.log(`Amplenote API: ${full ? "full" : "incremental"} listing, ${notes.length} note(s)`);
        return true;
    }

    /** Confirms public URLs still answer. Only the status is read; the page itself is never parsed. */
    async checkLinks(onlyUnconfirmed: boolean) {
        const rows = (
            await this.env.DB.prepare(
                `SELECT uuid, slug, public_token, link_status FROM amplenote_articles
                 WHERE public_token IS NOT NULL AND plugin_published = 1 ${onlyUnconfirmed ? "AND (link_status IS NULL OR link_status != 'ok')" : ""}
                 ORDER BY COALESCE(link_checked_at, '') ASC LIMIT ?`,
            )
                .bind(LINK_CHECKS_PER_RUN)
                .all<{ uuid: string; slug: string | null; public_token: string; link_status: string | null }>()
        ).results;
        const base = hosts(this.env).public;
        for (const row of rows) {
            let status: "ok" | "gone" | "error";
            let detail = "";
            try {
                const response = await this.fetchImpl(`${base}/${encodeURIComponent(row.public_token)}`, {
                    method: "GET",
                    redirect: "manual",
                    headers: { Accept: "text/html" },
                    signal: AbortSignal.timeout(10_000),
                });
                await response.body?.cancel();
                status = response.status === 200 ? "ok" : response.status === 404 || response.status === 410 ? "gone" : "error";
                detail = ` (${response.status})`;
            } catch (error) {
                status = "error";
                detail = ` (${(error as Error).name})`;
            }
            this.summary.checked++;
            await this.env.DB.prepare(
                `UPDATE amplenote_articles SET link_status = ?1, link_checked_at = ?2,
                    link_failures = CASE ?1 WHEN 'ok' THEN 0 WHEN 'gone' THEN link_failures + 1 ELSE link_failures END WHERE uuid = ?3`,
            )
                .bind(status, this.timestamp(), row.uuid)
                .run();
            if (status !== "ok") this.log(`Public link for ${row.slug ? `/blog/${row.slug}` : `note ${shortId(row.uuid)}`}: ${status}${detail}`);
        }
    }

    // --- Output -----------------------------------------------------------------------------------

    /** Brings posts in line with every article's eligibility. */
    async reconcilePosts(restConnected: boolean) {
        const db = this.env.DB;
        const articles = [...(await this.articles()).values()];
        const decisions = articles.map((row) => ({ row, reason: ineligibility(row, restConnected) }));
        const live = decisions.filter((d) => !d.reason);
        // Slugs of every article that will be public, so links between notes resolve regardless of order.
        const slugs = new Map<string, string>();
        for (const { row } of live) if (row.slug) slugs.set(row.uuid, row.slug);

        for (const { row, reason } of decisions) {
            if (!reason) continue;
            const deleted = await db
                .prepare("DELETE FROM posts WHERE id = ? AND source = 'amplenote' RETURNING slug")
                .bind(postId(row.uuid))
                .first<{ slug: string }>();
            const state = deleted || row.state === "published" || row.state === "withdrawn" ? "withdrawn" : "pending";
            if (deleted) {
                this.changed = true;
                this.summary.unpublished++;
                this.log(`Unpublished /blog/${deleted.slug}: ${reason}`);
            }
            if (state !== row.state || reason !== row.reason) {
                await db
                    .prepare("UPDATE amplenote_articles SET state = ?, reason = ?, updated_at = ? WHERE uuid = ?")
                    .bind(state, reason, this.timestamp(), row.uuid)
                    .run();
            }
        }

        for (const { row } of live) {
            try {
                if (!row.slug) {
                    const slug = await this.assignSlug(row);
                    if (!slug) continue;
                    row.slug = slug;
                    slugs.set(row.uuid, slug);
                }
                const result = await this.publish(row, slugs);
                this.summary[result]++;
            } catch (error) {
                this.fail(`Note ${shortId(row.uuid)}: ${(error as Error).message}. The published version (if any) was kept.`);
            }
        }
    }

    private async slugTaken(slug: string, uuid: string) {
        const clash = await this.env.DB.prepare(
            `SELECT 1 FROM posts WHERE slug = ?1 AND id != ?2
             UNION ALL SELECT 1 FROM slug_redirects WHERE from_slug = ?1 AND post_id != ?2
             UNION ALL SELECT 1 FROM amplenote_articles WHERE slug = ?1 AND uuid != ?3 LIMIT 1`,
        )
            .bind(slug, postId(uuid), uuid)
            .first();
        return !!clash;
    }

    /** A slug from the note's "Website" section or its title, made unique. Kept for good once given. */
    private async assignSlug(row: ArticleRow): Promise<string | null> {
        const { metadata } = extractMetadata(row.markdown ?? "");
        const base = metadata.slug ?? slugify(row.title ?? "");
        if (!base || !isValidSlug(base)) {
            await this.env.DB.prepare("UPDATE amplenote_articles SET reason = ? WHERE uuid = ?")
                .bind("Can't make a web address from the title", row.uuid)
                .run();
            this.fail(`Note ${shortId(row.uuid)}: can't make a web address from its title`);
            return null;
        }
        let slug = base;
        for (let n = 2; await this.slugTaken(slug, row.uuid); n++) slug = `${base.slice(0, 90)}-${n}`;
        await this.env.DB.prepare("UPDATE amplenote_articles SET slug = ?, updated_at = ? WHERE uuid = ?").bind(slug, this.timestamp(), row.uuid).run();
        return slug;
    }

    private async publish(row: ArticleRow, slugs: Map<string, string>): Promise<"published" | "updated" | "unchanged"> {
        const db = this.env.DB;
        const title = row.title!.trim();
        const { metadata, body } = extractMetadata(row.markdown!);
        let slug = row.slug!;
        const redirects: string[] = [];
        // A slug set in the note's Website section moves the article; the old address redirects.
        if (metadata.slug && metadata.slug !== slug) {
            if (await this.slugTaken(metadata.slug, row.uuid)) this.fail(`/blog/${slug}: the slug "${metadata.slug}" is already used; kept /blog/${slug}`);
            else {
                redirects.push(slug);
                slug = metadata.slug;
                slugs.set(row.uuid, slug);
            }
        }

        const existing = await db.prepare("SELECT content_hash FROM posts WHERE id = ?").bind(postId(row.uuid)).first<{ content_hash: string }>();
        const linkContext = [...slugs.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([uuid, s]) => `${uuid}:${s}`)
            .join(",");
        const inputHash = await sha256(JSON.stringify([slug, title, row.website_tags, row.markdown, row.note_created_at, row.note_updated_at, linkContext]));
        if (existing && row.state === "published" && row.content_hash === inputHash && !redirects.length) return "unchanged";

        const markdown = withoutRepeatedTitle(body, title);
        const imageSources = [
            ...new Set([
                ...(metadata.image && metadata.image.toLowerCase() !== "none" ? [metadata.image] : []),
                ...renderMarkdown(markdown, this.dryContext()).images,
            ]),
        ];
        const images = await this.copyImages(imageSources.slice(0, IMAGES_PER_ARTICLE), slug);
        const transforms = this.env.IMAGE_TRANSFORMS === "on";
        const rendered = renderMarkdown(markdown, {
            siteUrl: this.env.SITE_URL,
            image: (url) => {
                const media = images.get(url);
                if (!media) return null;
                return { src: mediaUrls(media.key, media.width, transforms).src, width: media.width, height: media.height };
            },
            noteSlug: (uuid) => slugs.get(uuid) ?? null,
        });
        // "image: none" in the Website section means no featured image; otherwise the named image, else the first one.
        const noImage = metadata.image?.toLowerCase() === "none";
        const featuredImage = noImage ? null : ((metadata.image ? images.get(metadata.image) : undefined) ?? images.get(rendered.images[0] ?? "") ?? null);
        const meta = tagMetadata(JSON.parse(row.website_tags) as string[], this.c);
        const ts = this.timestamp();
        const firstPublished = row.first_published_at ?? ts;
        const publishedAt = metadata.published ?? firstPublished;
        const flat = rendered.text.replace(/\s+/g, " ").trim();
        const summary = metadata.summary ?? (flat.length <= 200 ? flat || null : `${flat.slice(0, 200).replace(/\s+\S*$/, "")}…`);
        const record = {
            title,
            subtitle: metadata.subtitle,
            summary,
            category: meta.category,
            tags: meta.tags,
            featured: meta.featured,
            image_key: featuredImage?.key ?? null,
            image_alt: featuredImage ? title : null,
            image_width: featuredImage?.width ?? null,
            image_height: featuredImage?.height ?? null,
            body_html: rendered.html || `<p>${escapeHtml(summary ?? title)}</p>`,
            toc: rendered.toc,
            search_text: rendered.text.slice(0, 20_000),
            word_count: rendered.wordCount,
            reading_minutes: Math.max(1, Math.round(rendered.wordCount / 225)),
            published_at: publishedAt,
            updated_at: row.note_updated_at && Date.parse(row.note_updated_at) > Date.parse(publishedAt) ? row.note_updated_at : null,
        };
        const contentHash = await sha256(JSON.stringify({ slug, ...record }));
        const statements = [
            db
                .prepare(
                    `INSERT INTO posts (id, slug, title, subtitle, summary, category, tags, featured, image_key, image_alt, image_width, image_height,
                        body_html, toc, search_text, word_count, reading_minutes, published_at, updated_at, source_updated_at, content_hash, render_context, synced_at, source)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'amplenote')
                     ON CONFLICT(id) DO UPDATE SET slug = excluded.slug, title = excluded.title, subtitle = excluded.subtitle, summary = excluded.summary,
                        category = excluded.category, tags = excluded.tags, featured = excluded.featured, image_key = excluded.image_key, image_alt = excluded.image_alt,
                        image_width = excluded.image_width, image_height = excluded.image_height, body_html = excluded.body_html, toc = excluded.toc,
                        search_text = excluded.search_text, word_count = excluded.word_count, reading_minutes = excluded.reading_minutes,
                        published_at = excluded.published_at, updated_at = excluded.updated_at, source_updated_at = excluded.source_updated_at,
                        content_hash = excluded.content_hash, synced_at = excluded.synced_at
                     WHERE posts.source = 'amplenote'`,
                )
                .bind(
                    postId(row.uuid),
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
                    row.note_updated_at,
                    contentHash,
                    ts,
                ),
            // A slug that now belongs to this article must not redirect anywhere.
            db.prepare("DELETE FROM slug_redirects WHERE from_slug = ?").bind(slug),
            db
                .prepare(
                    "UPDATE amplenote_articles SET slug = ?, state = 'published', reason = NULL, first_published_at = COALESCE(first_published_at, ?), content_hash = ?, updated_at = ? WHERE uuid = ?",
                )
                .bind(slug, firstPublished, inputHash, ts, row.uuid),
            ...redirects.map((from) =>
                db
                    .prepare(
                        "INSERT INTO slug_redirects (from_slug, post_id, created_at) VALUES (?, ?, ?) ON CONFLICT(from_slug) DO UPDATE SET post_id = excluded.post_id",
                    )
                    .bind(from, postId(row.uuid), ts),
            ),
        ];
        await db.batch(statements);
        if (redirects.length) this.log(`Slug changed: /blog/${redirects[0]} now redirects to /blog/${slug}`);
        if (existing?.content_hash === contentHash) {
            if (row.state !== "published") this.changed = true;
            return row.state === "published" ? "unchanged" : "published";
        }
        this.changed = true;
        if (existing) {
            this.log(`Updated /blog/${slug}`);
            return "updated";
        }
        this.log(`Published /blog/${slug}`);
        return "published";
    }

    private dryContext() {
        return { siteUrl: this.env.SITE_URL, image: () => null, noteSlug: () => null };
    }

    /** Copies note images into R2 so the site never hotlinks (and its CSP stays img-src 'self'). Only Amplenote's image host. */
    private async copyImages(urls: string[], slug: string) {
        const out = new Map<string, { key: string; width: number | null; height: number | null }>();
        const allowed = hosts(this.env).images;
        const dev = this.env.ENVIRONMENT === "development";
        for (const url of urls) {
            let parsed: URL;
            try {
                parsed = new URL(url);
            } catch {
                continue;
            }
            if (!allowed.includes(parsed.host) || (parsed.protocol !== "https:" && !(dev && parsed.protocol === "http:"))) {
                this.log(`/blog/${slug}: left out an image that isn't hosted by Amplenote`);
                continue;
            }
            const id = `amplenote:${await sha256(url)}`;
            const cached = await this.env.DB.prepare("SELECT r2_key, width, height FROM media WHERE id = ?")
                .bind(id)
                .first<{ r2_key: string; width: number | null; height: number | null }>();
            if (cached) {
                out.set(url, { key: cached.r2_key, width: cached.width, height: cached.height });
                continue;
            }
            try {
                const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
                const type = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
                const ext = ALLOWED_IMAGE_TYPES[type];
                if (!response.ok || !ext) {
                    await response.body?.cancel();
                    this.log(`/blog/${slug}: an image couldn't be copied (${response.ok ? type || "unknown type" : response.status}); left out`);
                    continue;
                }
                const bytes = new Uint8Array(await response.arrayBuffer());
                if (bytes.byteLength > MAX_IMAGE_BYTES) {
                    this.log(`/blog/${slug}: an image is too large; left out`);
                    continue;
                }
                const key = `${(await sha256(bytes)).slice(0, 24)}.${ext}`;
                const dims = imageDimensions(bytes, type);
                await this.env.MEDIA.put(key, bytes, { httpMetadata: { contentType: type, cacheControl: "public, max-age=31536000, immutable" } });
                const ts = this.timestamp();
                await this.env.DB.prepare(
                    "INSERT INTO media (id, r2_key, content_type, width, height, bytes, alt, caption, created_at, checked_at) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?) ON CONFLICT(id) DO NOTHING",
                )
                    .bind(id, key, type, dims?.width ?? null, dims?.height ?? null, bytes.byteLength, ts, ts)
                    .run();
                out.set(url, { key, width: dims?.width ?? null, height: dims?.height ?? null });
            } catch (error) {
                this.log(`/blog/${slug}: an image couldn't be copied (${(error as Error).message}); left out`);
            }
        }
        return out;
    }
}

/** One Amplenote run at a time; a crashed run's lock expires after a few minutes. */
async function locked<T>(env: Env, work: () => Promise<T>): Promise<T | null> {
    const now = Date.now();
    const token = `${now}:${crypto.randomUUID()}`;
    const claimed = await env.DB.prepare(
        `INSERT INTO meta (key, value) VALUES ('amplenote_lock', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value
         WHERE meta.value = '' OR CAST(substr(meta.value, 1, instr(meta.value, ':') - 1) AS INTEGER) < ?2
         RETURNING value`,
    )
        .bind(token, now - LOCK_MINUTES * 60_000)
        .first<{ value: string }>();
    if (claimed?.value !== token) return null;
    try {
        return await work();
    } finally {
        await env.DB.prepare("UPDATE meta SET value = '' WHERE key = 'amplenote_lock' AND value = ?").bind(token).run();
    }
}

const skipped = (trigger: string): RunSummary => ({
    runId: null,
    trigger: `amplenote:${trigger}`,
    status: "skipped",
    listed: 0,
    checked: 0,
    published: 0,
    updated: 0,
    unpublished: 0,
    unchanged: 0,
    errors: 0,
    log: ["Another Amplenote run is in progress; try again shortly"],
});

/** The plugin's report: record it, check new links, take the API's view, then publish what qualifies. */
export async function ingest(env: Env, report: PluginReport, options: Omit<RunOptions, "trigger"> = {}): Promise<RunSummary> {
    const result = await locked(env, async () => {
        const run = new Run(env, { ...options, trigger: "plugin" });
        const started = run.timestamp();
        await run.applyReport(report);
        await run.checkLinks(true);
        // A note the API hasn't confirmed yet may not be in an incremental listing (if publishing doesn't
        // count as a metadata change), so list everything once rather than wait up to six hours.
        const unconfirmed = await env.DB.prepare("SELECT 1 FROM amplenote_articles WHERE plugin_published = 1 AND rest_seen_at IS NULL LIMIT 1").first();
        const rest = await run.applyRest(!!unconfirmed);
        await run.reconcilePosts(rest);
        return run.finish(started);
    });
    return result ?? skipped("plugin");
}

/** The scheduled check (every 15 minutes with the existing cron): the API's view and link checks, no content. */
export async function reconcile(env: Env, options: Omit<RunOptions, "trigger"> & { trigger?: "cron" | "manual" } = {}): Promise<RunSummary> {
    const trigger = options.trigger ?? "cron";
    const [known, connection] = await Promise.all([env.DB.prepare("SELECT COUNT(*) AS n FROM amplenote_articles").first<{ n: number }>(), loadConnection(env)]);
    // Nothing set up yet: nothing to do, and no run is recorded every fifteen minutes.
    if (!known?.n && !connection) return { ...skipped(trigger), log: ["Amplenote publishing isn't set up yet"] };
    const result = await locked(env, async () => {
        const run = new Run(env, { ...options, trigger });
        const started = run.timestamp();
        const rest = await run.applyRest();
        await run.checkLinks(false);
        await run.reconcilePosts(rest);
        return run.finish(started);
    });
    return result ?? skipped(trigger);
}
