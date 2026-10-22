import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import type { TocEntry } from "../src/shared/types";
import { BudgetExhaustedError, CapacitiesClient, CapacitiesError } from "./capacities/client";
import { type BlogSchema, type MappedPost, SchemaError, mapObject, readStatus, resolveSchema, textValue } from "./capacities/mapping";
import { type Embed, collectReferences, parseMarkdownTable, renderBlocks } from "./capacities/render";
import type { CapacitiesObject } from "./capacities/types";
import type { Env } from "./env";
import { isValidSlug, safeUrl, slugify } from "./lib/html";
import { ALLOWED_IMAGE_TYPES, MAX_IMAGE_BYTES, imageDimensions, mediaUrls } from "./lib/image";
import { isEnabled } from "./portal/flags";

/** A post must be absent from this many consecutive complete listings before it is treated as deleted. */
export const MISSING_THRESHOLD = 2;
const ENTITY_CACHE_DAYS = 7;

export interface SyncOptions {
    trigger: "cron" | "manual" | "test";
    /** Re-render every checked post even if unchanged. */
    force?: boolean;
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    now?: () => Date;
}

export interface SyncSummary {
    runId: number | null;
    /** "off": Capacities sync is switched off (archived), so nothing was requested or changed. */
    status: "ok" | "partial" | "failed" | "off";
    listed: number;
    checked: number;
    published: number;
    updated: number;
    unpublished: number;
    unchanged: number;
    errors: number;
    log: string[];
}

interface PostRow {
    id: string;
    slug: string;
    title: string;
    content_hash: string;
    source_updated_at: string | null;
    render_context: string | null;
    synced_at: string;
}

interface Candidate {
    id: string;
    slug: string;
    mapped: MappedPost;
    existing?: PostRow;
}

/** API requests kept back from fetching so a run can still render what it fetched. */
const RENDER_RESERVE = 8;

interface SourceRow {
    id: string;
    status: string | null;
    last_checked_at: string | null;
    missing_count: number;
}

interface MediaRow {
    id: string;
    r2_key: string;
    width: number | null;
    height: number | null;
    alt: string | null;
    caption: string | null;
    checked_at: string;
}

interface EntityRow {
    id: string;
    structure_id: string;
    title: string | null;
    url: string | null;
    checked_at: string;
}

/** The switch is "website.capacities.sync" (Portal settings → Features). Off, or unreadable, means archived. */
export const capacitiesSyncEnabled = async (env: Env) => {
    try {
        return await isEnabled(env.DB, "website.capacities.sync");
    } catch {
        return false;
    }
};

export const SYNC_OFF_MESSAGE =
    "Capacities sync is switched off (Portal settings → Features). Archived Capacities articles stay published from Cloudflare; nothing was requested from Capacities.";

export const runSync = async (env: Env, options: SyncOptions): Promise<SyncSummary> => {
    const now = options.now ?? (() => new Date());
    const db = env.DB;
    // Archived: no request to Capacities, no change to any post, and no run recorded every 15 minutes.
    if (!(await capacitiesSyncEnabled(env))) {
        console.log(JSON.stringify({ event: "sync_off", trigger: options.trigger }));
        return {
            runId: null,
            status: "off",
            listed: 0,
            checked: 0,
            published: 0,
            updated: 0,
            unpublished: 0,
            unchanged: 0,
            errors: 0,
            log: [SYNC_OFF_MESSAGE],
        };
    }
    const summary: SyncSummary = {
        runId: null,
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
    const log = (message: string) => {
        summary.log.push(message);
        console.log(JSON.stringify({ event: "sync", message }));
    };
    const fail = (message: string) => {
        summary.errors++;
        summary.log.push(`ERROR ${message}`);
        console.error(JSON.stringify({ event: "sync_error", message }));
    };

    const started = now().toISOString();
    const run = await db
        .prepare("INSERT INTO sync_runs (trigger, started_at, status) VALUES (?, ?, 'running') RETURNING id")
        .bind(options.trigger, started)
        .first<{ id: number }>();
    summary.runId = run?.id ?? null;

    const finish = async () => {
        if (summary.status === "ok" && summary.errors > 0) summary.status = "partial";
        if (summary.published + summary.updated + summary.unpublished > 0) {
            await db
                .prepare("INSERT INTO meta (key, value) VALUES ('content_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
                .bind(String(Date.now()))
                .run();
        }
        await db
            .prepare(
                "UPDATE sync_runs SET finished_at = ?, status = ?, listed = ?, checked = ?, published = ?, updated = ?, unpublished = ?, unchanged = ?, errors = ?, log = ? WHERE id = ?",
            )
            .bind(
                now().toISOString(),
                summary.status,
                summary.listed,
                summary.checked,
                summary.published,
                summary.updated,
                summary.unpublished,
                summary.unchanged,
                summary.errors,
                JSON.stringify(summary.log.slice(0, 200)),
                summary.runId,
            )
            .run();
        await db.prepare("DELETE FROM sync_runs WHERE id <= (SELECT MAX(id) FROM sync_runs) - 500").run();
        console.log(JSON.stringify({ event: "sync_complete", ...summary, log: undefined }));
        return summary;
    };

    if (!env.CAPACITIES_API_TOKEN) {
        summary.status = "failed";
        fail("CAPACITIES_API_TOKEN is not set; nothing was changed");
        return finish();
    }

    const client = new CapacitiesClient({
        token: env.CAPACITIES_API_TOKEN,
        baseUrl: env.CAPACITIES_API_BASE || "https://api.capacities.io",
        maxRequests: clampInt(env.SYNC_MAX_REQUESTS, 40, 3, 45),
        spacingMs: clampInt(env.SYNC_REQUEST_SPACING_MS, 2100, 0, 10_000),
        fetchImpl: options.fetchImpl,
        sleep: options.sleep,
    });

    // 1. Schema. Any doubt about the type or its Status property aborts the run untouched.
    let schema: BlogSchema;
    try {
        schema = resolveSchema(await client.structures(), {
            structureId: env.CAPACITIES_STRUCTURE_ID,
            structureName: env.CAPACITIES_STRUCTURE_NAME || "Blog Post",
        });
    } catch (error) {
        summary.status = "failed";
        fail(`${error instanceof SchemaError ? "Schema" : "Structures request"}: ${(error as Error).message}. Nothing was changed.`);
        return finish();
    }

    // 2. Listing. A failed or partial listing is never used to infer deletions.
    let listedIds: string[] | null = null;
    try {
        const listed = await client.listAll(schema.structureId);
        listedIds = listed.filter((o) => o.structureId === schema.structureId).map((o) => o.id);
        summary.listed = listedIds.length;
    } catch (error) {
        fail(`Listing failed (${(error as Error).message}); checking known posts only and skipping deletion checks`);
    }

    // Only Capacities' own rows: posts from other publishers (Amplenote) are never checked, renamed or removed here.
    const posts = new Map(
        (
            await db
                .prepare("SELECT id, slug, title, content_hash, source_updated_at, render_context, synced_at FROM posts WHERE source = 'capacities'")
                .all<PostRow>()
        ).results.map((r) => [r.id, r]),
    );
    // Slugs other publishers hold (or have reserved), which a Capacities post must not take.
    const otherSlugs = new Set(
        (
            await db
                .prepare("SELECT slug FROM posts WHERE source != 'capacities' UNION SELECT slug FROM amplenote_articles WHERE slug IS NOT NULL")
                .all<{ slug: string }>()
        ).results.map((r) => r.slug),
    );
    const sources = new Map(
        (await db.prepare("SELECT id, status, last_checked_at, missing_count FROM sources").all<SourceRow>()).results.map((r) => [r.id, r]),
    );
    const timestamp = now().toISOString();

    // A listing with no Blog Posts at all while posts are published is far likelier to be a lapsed
    // subscription, a moved space or an outage than the deletion of every article: it isn't used to
    // infer deletions. Each known post is still checked individually (a 404 only counts, see classify).
    if (listedIds && listedIds.length === 0 && posts.size > 0) {
        fail(`Capacities listed no Blog Posts while ${posts.size} are published; treated as an outage and nothing was unpublished`);
        listedIds = null;
    }

    if (listedIds) {
        const listedSet = new Set(listedIds);
        const statements = [];
        for (const id of listedIds) {
            statements.push(
                db
                    .prepare(
                        "INSERT INTO sources (id, last_listed_at, missing_count) VALUES (?, ?, 0) ON CONFLICT(id) DO UPDATE SET last_listed_at = excluded.last_listed_at, missing_count = 0",
                    )
                    .bind(id, timestamp),
            );
        }
        // Deletion detection: only after a complete listing, and only after repeated absence.
        for (const source of sources.values()) {
            if (listedSet.has(source.id)) continue;
            const missing = source.missing_count + 1;
            if (missing >= MISSING_THRESHOLD) {
                if (posts.has(source.id)) {
                    statements.push(db.prepare("DELETE FROM posts WHERE id = ?").bind(source.id));
                    statements.push(db.prepare("DELETE FROM slug_redirects WHERE post_id = ?").bind(source.id));
                    summary.unpublished++;
                    log(`Unpublished /blog/${posts.get(source.id)!.slug}: object no longer exists in Capacities`);
                    posts.delete(source.id);
                }
                statements.push(db.prepare("DELETE FROM sources WHERE id = ?").bind(source.id));
            } else {
                statements.push(db.prepare("UPDATE sources SET missing_count = ? WHERE id = ?").bind(missing, source.id));
                if (posts.has(source.id)) log(`/blog/${posts.get(source.id)!.slug} missing from listing (${missing}/${MISSING_THRESHOLD}); kept`);
            }
        }
        if (statements.length) await db.batch(statements);
    }

    // 3. Decide what to check this run: never-seen objects first, then least recently checked.
    // Articles whose address now belongs to an Amplenote note (capacities/archive.ts) are never published again from here.
    const moved = new Set((await db.prepare("SELECT id FROM capacities_archive WHERE replaced_by IS NOT NULL").all<{ id: string }>()).results.map((r) => r.id));
    const candidates = (listedIds ?? [...new Set([...posts.keys(), ...sources.keys()])]).filter((id) => !moved.has(id));
    const order = [...candidates].sort((a, b) => {
        const ca = sources.get(a)?.last_checked_at ?? "";
        const cb = sources.get(b)?.last_checked_at ?? "";
        return ca.localeCompare(cb);
    });

    const transforms = env.IMAGE_TRANSFORMS === "on";
    const resolver = new Resolver(db, env.MEDIA, client, transforms, timestamp, !!options.force, options.fetchImpl);

    const recordError = async (id: string, error: unknown) => {
        summary.checked++;
        fail(`Object ${shortId(id)}: ${(error as Error).message}. Existing published version (if any) kept.`);
        await db
            .prepare(
                "INSERT INTO sources (id, last_checked_at, last_error) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET last_checked_at = excluded.last_checked_at, last_error = excluded.last_error",
            )
            .bind(id, now().toISOString(), (error as Error).message.slice(0, 500))
            .run();
    };

    // Phase A: fetch and classify. Requests are held back so that rendering (images, tags) can finish.
    const toPublish: Candidate[] = [];
    let classified = 0;
    for (const id of order) {
        if (client.remaining < 1 || (toPublish.length > 0 && client.remaining <= RENDER_RESERVE)) {
            log(`Request budget reached; ${order.length - classified} object(s) deferred to the next run`);
            break;
        }
        try {
            const outcome = await classify(id);
            classified++;
            if (outcome === "unpublished") {
                summary.unpublished++;
                summary.checked++;
            } else if (outcome) toPublish.push(outcome);
            else summary.checked++;
        } catch (error) {
            if (error instanceof BudgetExhaustedError) break;
            classified++;
            await recordError(id, error);
        }
    }

    // Every post that will be public after this run, so cross-links resolve regardless of order.
    const linkTargets = new Map<string, { slug: string; title: string }>();
    for (const post of posts.values()) linkTargets.set(post.id, { slug: post.slug, title: post.title });
    const accepted: Candidate[] = [];
    for (const candidate of toPublish) {
        const clash =
            otherSlugs.has(candidate.slug) ||
            [...linkTargets.entries()].some(([otherId, target]) => target.slug === candidate.slug && otherId !== candidate.id);
        if (clash) {
            await recordError(candidate.id, new Error(`Slug "${candidate.slug}" is already used by another published post`));
            continue;
        }
        linkTargets.set(candidate.id, { slug: candidate.slug, title: candidate.mapped.title! });
        accepted.push(candidate);
    }
    const renderContext = (
        await sha256(
            [...linkTargets.entries()]
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([id, t]) => `${id}:${t.slug}:${t.title}`)
                .join("\n"),
        )
    ).slice(0, 16);

    // Phase B: render and store.
    for (const candidate of accepted) {
        try {
            const result = await publish(candidate);
            summary[result]++;
            summary.checked++;
        } catch (error) {
            if (error instanceof BudgetExhaustedError) {
                log(`Request budget reached while rendering /blog/${candidate.slug}; it will be retried next run`);
                break;
            }
            await recordError(candidate.id, error);
        }
    }

    return finish();

    function markChecked(id: string, status: string, error: string | null = null) {
        return db
            .prepare(
                "INSERT INTO sources (id, status, last_checked_at, last_error) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, last_checked_at = excluded.last_checked_at, last_error = excluded.last_error",
            )
            .bind(id, status, now().toISOString(), error);
    }

    async function classify(id: string): Promise<Candidate | "unpublished" | null> {
        let object: CapacitiesObject;
        try {
            object = await client.object(id);
        } catch (error) {
            if (error instanceof CapacitiesError && error.isNotFound) {
                // Treated like absence from the listing: counted, not acted on immediately.
                await db.prepare("UPDATE sources SET last_checked_at = ?, last_error = 'not found' WHERE id = ?").bind(now().toISOString(), id).run();
                log(`Object ${shortId(id)} returned 404; will unpublish only after repeated absence from the listing`);
                return null;
            }
            throw error;
        }

        const existing = posts.get(id);
        if (object.id !== id) throw new Error("API returned a different object than requested");

        if (object.structureId !== schema.structureId) {
            // The object has been moved to another type: it is no longer a Blog Post.
            if (existing) {
                await db.batch([
                    db.prepare("DELETE FROM posts WHERE id = ?").bind(id),
                    db.prepare("DELETE FROM slug_redirects WHERE post_id = ?").bind(id),
                    markChecked(id, "not a blog post"),
                ]);
                posts.delete(id);
                log(`Unpublished /blog/${existing.slug}: object is no longer a Blog Post`);
                return "unpublished";
            }
            await markChecked(id, "not a blog post").run();
            return null;
        }

        const status = readStatus(object, schema);
        if (status.kind === "unknown") throw new Error(`Status unreadable (${status.reason})`);

        if (status.kind === "not-published") {
            if (existing) {
                await db.batch([
                    db.prepare("DELETE FROM posts WHERE id = ?").bind(id),
                    db.prepare("DELETE FROM slug_redirects WHERE post_id = ?").bind(id),
                    markChecked(id, status.label),
                ]);
                posts.delete(id);
                log(`Unpublished /blog/${existing.slug}: status is now "${status.label}"`);
                return "unpublished";
            }
            await markChecked(id, status.label).run();
            return null;
        }

        const mapped = mapObject(object, schema);
        if (!mapped.title) throw new Error("Published post has no title");
        const slug = mapped.slug ? slugify(mapped.slug) : slugify(mapped.title);
        if (!slug || !isValidSlug(slug)) throw new Error(`Cannot derive a valid slug from "${mapped.slug ?? mapped.title}"`);
        return { id, slug, mapped, existing };
    }

    async function publish({ id, slug, mapped, existing }: Candidate): Promise<"published" | "updated" | "unchanged"> {
        // Skip work when nothing it depends on has changed since the last successful render.
        if (
            existing &&
            !options.force &&
            mapped.lastUpdatedAt &&
            existing.source_updated_at === mapped.lastUpdatedAt &&
            existing.slug === slug &&
            existing.render_context === renderContext &&
            // Re-render periodically anyway, so changes to referenced tags, links, tables and
            // images (which don't touch the post's own lastUpdatedAt) still come through.
            !isStale(existing.synced_at, timestamp)
        ) {
            await markChecked(id, "published").run();
            return "unchanged";
        }

        const record = await buildRecord(slug, mapped);
        if (existing && existing.content_hash === record.content_hash) {
            await db.batch([
                db
                    .prepare("UPDATE posts SET source_updated_at = ?, render_context = ?, synced_at = ? WHERE id = ?")
                    .bind(mapped.lastUpdatedAt, renderContext, now().toISOString(), id),
                markChecked(id, "published"),
            ]);
            return "unchanged";
        }

        const statements = [
            db
                .prepare(
                    `INSERT INTO posts (id, slug, title, subtitle, summary, category, tags, featured, image_key, image_alt, image_width, image_height,
                        body_html, toc, search_text, word_count, reading_minutes, published_at, updated_at, source_updated_at, content_hash, render_context, synced_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                     ON CONFLICT(id) DO UPDATE SET slug = excluded.slug, title = excluded.title, subtitle = excluded.subtitle, summary = excluded.summary,
                        category = excluded.category, tags = excluded.tags, featured = excluded.featured, image_key = excluded.image_key, image_alt = excluded.image_alt,
                        image_width = excluded.image_width, image_height = excluded.image_height, body_html = excluded.body_html, toc = excluded.toc,
                        search_text = excluded.search_text, word_count = excluded.word_count, reading_minutes = excluded.reading_minutes,
                        published_at = excluded.published_at, updated_at = excluded.updated_at, source_updated_at = excluded.source_updated_at,
                        content_hash = excluded.content_hash, render_context = excluded.render_context, synced_at = excluded.synced_at`,
                )
                .bind(
                    id,
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
                    mapped.lastUpdatedAt,
                    record.content_hash,
                    renderContext,
                    now().toISOString(),
                ),
            // A slug that now belongs to this post must not redirect anywhere.
            db.prepare("DELETE FROM slug_redirects WHERE from_slug = ?").bind(slug),
            markChecked(id, "published"),
        ];
        if (existing && existing.slug !== slug) {
            statements.push(
                db
                    .prepare(
                        "INSERT INTO slug_redirects (from_slug, post_id, created_at) VALUES (?, ?, ?) ON CONFLICT(from_slug) DO UPDATE SET post_id = excluded.post_id",
                    )
                    .bind(existing.slug, id, now().toISOString()),
            );
            log(`Slug changed: /blog/${existing.slug} now redirects to /blog/${slug}`);
        }
        await db.batch(statements);
        posts.set(id, {
            id,
            slug,
            title: record.title,
            content_hash: record.content_hash,
            source_updated_at: mapped.lastUpdatedAt,
            render_context: renderContext,
            synced_at: now().toISOString(),
        });

        if (existing) {
            log(`Updated /blog/${slug}`);
            return "updated";
        }
        log(`Published /blog/${slug}`);
        return "published";
    }

    async function buildRecord(slug: string, mapped: MappedPost) {
        const refs = collectReferences(mapped.blocks);
        // Embedded blog posts are already known; everything else is looked up (and cached).
        await resolver.preload(
            refs.embeds.filter((ref) => !linkTargets.has(ref)),
            refs.links,
        );
        if (mapped.imageEntityId) await resolver.preload([mapped.imageEntityId], []);
        const tagNames = [...mapped.tagNames, ...(await resolver.tagNames(mapped.tagEntityIds))];

        const rendered = renderBlocks(mapped.blocks, {
            siteUrl: env.SITE_URL,
            postSlug: (entityId) => linkTargets.get(entityId)?.slug ?? null,
            embed: (entityId) => resolver.embed(entityId, linkTargets),
        });
        if (rendered.skipped.length) log(`/blog/${slug}: skipped unsupported block(s): ${[...new Set(rendered.skipped)].join(", ")}`);

        let image: { key: string; alt: string; width: number | null; height: number | null } | null = null;
        if (mapped.imageEntityId) {
            const media = resolver.media(mapped.imageEntityId);
            if (media) image = { key: media.r2_key, alt: media.alt ?? "", width: media.width, height: media.height };
            else log(`/blog/${slug}: featured image could not be resolved`);
        } else if (mapped.imageUrl && safeUrl(mapped.imageUrl)) {
            const media = await resolver.importUrl(mapped.imageUrl);
            if (media) image = { key: media.r2_key, alt: "", width: media.width, height: media.height };
        }

        const toc: TocEntry[] = rendered.toc;
        const summaryText = mapped.summary ?? excerpt(rendered.text);
        const record = {
            title: mapped.title!,
            subtitle: mapped.subtitle,
            summary: summaryText,
            category: mapped.category,
            tags: [...new Set(tagNames.map((t) => t.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
            featured: mapped.featured,
            image_key: image?.key ?? null,
            image_alt: image ? image.alt || mapped.title! : null,
            image_width: image?.width ?? null,
            image_height: image?.height ?? null,
            body_html: rendered.html,
            toc,
            search_text: rendered.text.slice(0, 20_000),
            word_count: rendered.wordCount,
            reading_minutes: Math.max(1, Math.round(rendered.wordCount / 225)),
            published_at: mapped.publishDate ?? mapped.createdAt ?? now().toISOString(),
            updated_at: mapped.updatedDate,
        };
        const content_hash = await sha256(JSON.stringify({ slug, ...record }));
        return { ...record, content_hash };
    }
};

/**
 * Resolves objects referenced from an article: images (copied into R2), web links, tables,
 * tags and other blog posts. Results are cached in D1 so repeat runs cost no API calls.
 */
class Resolver {
    private readonly mediaRows = new Map<string, MediaRow>();
    private readonly entities = new Map<string, EntityRow>();
    private readonly tables = new Map<string, string[][]>();
    /** Objects already re-read during this run. */
    private readonly refreshed = new Set<string>();

    constructor(
        private readonly db: D1Database,
        private readonly bucket: R2Bucket,
        private readonly client: CapacitiesClient,
        private readonly transforms: boolean,
        private readonly timestamp: string,
        /** Re-read every referenced object, ignoring cache freshness. */
        private readonly force: boolean,
        private readonly fetchImpl: typeof fetch = fetch.bind(globalThis),
    ) {}

    private fresh(checkedAt: string | undefined) {
        return !!checkedAt && !this.force && !isStale(checkedAt, this.timestamp);
    }

    async preload(embedIds: string[], _linkIds: string[]) {
        const ids = embedIds.filter((id) => !this.refreshed.has(id));
        if (!ids.length) return;
        await this.loadCached(ids.filter((id) => !this.mediaRows.has(id) && !this.entities.has(id)));

        for (const id of ids) {
            if (this.fresh(this.mediaRows.get(id)?.checked_at)) continue;
            const cached = this.entities.get(id);
            if (cached && this.fresh(cached.checked_at) && cached.structure_id !== "RootSimpleTable") continue;

            const object = await this.client.object(id);
            this.refreshed.add(id);
            if (object.structureId === "MediaImage") {
                await this.importMedia(object);
                continue;
            }
            const title = textValue(object.properties?.title);
            const urlValue = Object.values(object.properties ?? {}).find((v) => v.type === "url");
            const url = urlValue ? textValue(urlValue) : null;
            const row: EntityRow = { id, structure_id: object.structureId, title, url: safeUrl(url), checked_at: this.timestamp };
            this.entities.set(id, row);
            await this.db
                .prepare(
                    "INSERT INTO entity_cache (id, structure_id, title, url, checked_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET structure_id = excluded.structure_id, title = excluded.title, url = excluded.url, checked_at = excluded.checked_at",
                )
                .bind(row.id, row.structure_id, row.title, row.url, row.checked_at)
                .run();
            if (object.structureId === "RootSimpleTable") {
                this.tables.set(id, parseMarkdownTable(await this.client.markdown(id)));
            }
        }
    }

    private async loadCached(ids: string[]) {
        for (let i = 0; i < ids.length; i += 50) {
            const chunk = ids.slice(i, i + 50);
            const marks = chunk.map(() => "?").join(",");
            const media = await this.db
                .prepare(`SELECT id, r2_key, width, height, alt, caption, checked_at FROM media WHERE id IN (${marks})`)
                .bind(...chunk)
                .all<MediaRow>();
            for (const row of media.results) this.mediaRows.set(row.id, row);
            const entities = await this.db
                .prepare(`SELECT id, structure_id, title, url, checked_at FROM entity_cache WHERE id IN (${marks})`)
                .bind(...chunk)
                .all<EntityRow>();
            for (const row of entities.results) this.entities.set(row.id, row);
        }
    }

    async tagNames(ids: string[]): Promise<string[]> {
        if (!ids.length) return [];
        await this.loadCached(ids.filter((id) => !this.entities.has(id)));
        const names: string[] = [];
        for (const id of ids) {
            let row = this.entities.get(id);
            if (!row || (!this.fresh(row.checked_at) && !this.refreshed.has(id))) {
                const object = await this.client.object(id);
                this.refreshed.add(id);
                row = { id, structure_id: object.structureId, title: textValue(object.properties?.title), url: null, checked_at: this.timestamp };
                this.entities.set(id, row);
                await this.db
                    .prepare(
                        "INSERT INTO entity_cache (id, structure_id, title, url, checked_at) VALUES (?, ?, ?, NULL, ?) ON CONFLICT(id) DO UPDATE SET structure_id = excluded.structure_id, title = excluded.title, checked_at = excluded.checked_at",
                    )
                    .bind(row.id, row.structure_id, row.title, row.checked_at)
                    .run();
            }
            // Only real tags become public topics.
            if (row.structure_id === "RootTag" && row.title) names.push(row.title);
        }
        return names;
    }

    media(id: string) {
        return this.mediaRows.get(id) ?? null;
    }

    embed(id: string, posts: Map<string, { slug: string; title: string }>): Embed | null {
        const media = this.mediaRows.get(id);
        if (media) {
            const urls = mediaUrls(media.r2_key, media.width, this.transforms);
            return { kind: "image", ...urls, alt: media.alt ?? "", caption: media.caption, width: media.width, height: media.height };
        }
        const post = posts.get(id);
        if (post) return { kind: "post", slug: post.slug, title: post.title };

        const entity = this.entities.get(id);
        if (!entity) return null;
        if (entity.structure_id === "RootSimpleTable") {
            const rows = this.tables.get(id);
            return rows?.length ? { kind: "table", rows } : null;
        }
        // Web links and tweets are public by nature. Every other object type stays private.
        if ((entity.structure_id === "MediaWebResource" || entity.structure_id === "MediaTweet") && entity.url) {
            const video = videoEmbed(entity.url);
            if (video) return { kind: "video", embedUrl: video, url: entity.url, title: entity.title };
            return { kind: "link", url: entity.url, title: entity.title };
        }
        return null;
    }

    private async importMedia(object: CapacitiesObject) {
        const file = object.files?.find((f) => f.fileType in ALLOWED_IMAGE_TYPES);
        if (!file) return;
        const title = textValue(object.properties?.title);
        const description = textValue(object.properties?.description);
        const row = await this.store(
            object.id,
            file.url,
            file.fileType,
            looksLikeFilename(title) ? (description ?? "") : (title ?? ""),
            description && !looksLikeFilename(description) ? description : null,
        );
        if (row) this.mediaRows.set(object.id, row);
    }

    /** Featured images given as a URL property are copied too, so the site never hotlinks. */
    async importUrl(url: string) {
        const id = `url:${await sha256(url)}`;
        await this.loadCached([id]);
        const cached = this.mediaRows.get(id);
        if (cached && (this.fresh(cached.checked_at) || this.refreshed.has(id))) return cached;
        this.refreshed.add(id);
        const row = await this.store(id, url, null, "", null);
        if (row) this.mediaRows.set(id, row);
        return row;
    }

    private async store(id: string, url: string, declaredType: string | null, alt: string, caption: string | null): Promise<MediaRow | null> {
        this.client.take();
        // Signed file URLs need no credentials; the API token is never sent here.
        const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
        if (!response.ok) throw new Error(`Image download failed (${response.status})`);
        const type = (response.headers.get("content-type") ?? declaredType ?? "").split(";")[0].trim().toLowerCase();
        const ext = ALLOWED_IMAGE_TYPES[type];
        if (!ext) {
            await response.body?.cancel();
            return null;
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > MAX_IMAGE_BYTES) return null;
        const digest = await sha256(bytes);
        const key = `${digest.slice(0, 24)}.${ext}`;
        const dims = imageDimensions(bytes, type);
        await this.bucket.put(key, bytes, { httpMetadata: { contentType: type, cacheControl: "public, max-age=31536000, immutable" } });
        const row: MediaRow = {
            id,
            r2_key: key,
            width: dims?.width ?? null,
            height: dims?.height ?? null,
            alt: alt || null,
            caption,
            checked_at: this.timestamp,
        };
        await this.db
            .prepare(
                "INSERT INTO media (id, r2_key, content_type, width, height, bytes, alt, caption, created_at, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET r2_key = excluded.r2_key, content_type = excluded.content_type, width = excluded.width, height = excluded.height, bytes = excluded.bytes, alt = excluded.alt, caption = excluded.caption, checked_at = excluded.checked_at",
            )
            .bind(id, key, type, row.width, row.height, bytes.byteLength, row.alt, row.caption, this.timestamp, this.timestamp)
            .run();
        return row;
    }
}

const videoEmbed = (url: string): string | null => {
    try {
        const u = new URL(url);
        const host = u.hostname.replace(/^www\.|^m\./, "");
        let id: string | null = null;
        if (host === "youtube.com" && u.pathname === "/watch") id = u.searchParams.get("v");
        else if (host === "youtu.be") id = u.pathname.slice(1);
        else if (host === "youtube.com" && u.pathname.startsWith("/shorts/")) id = u.pathname.split("/")[2];
        if (id && /^[\w-]{6,20}$/.test(id)) return `https://www.youtube-nocookie.com/embed/${id}`;
        if (host === "vimeo.com" && /^\/\d+$/.test(u.pathname)) return `https://player.vimeo.com/video${u.pathname}?dnt=1`;
    } catch {
        // Not a URL we can embed.
    }
    return null;
};

const looksLikeFilename = (value: string | null) =>
    !value || /\.(jpe?g|png|gif|webp|avif|heic)$/i.test(value) || /^(img|image|screenshot|photo)[-_ ]?\d/i.test(value);

const isStale = (checkedAt: string, now: string) => Date.parse(now) - Date.parse(checkedAt) > ENTITY_CACHE_DAYS * 86_400_000;

const excerpt = (text: string) => {
    const flat = text.replace(/\s+/g, " ").trim();
    if (flat.length <= 200) return flat || null;
    return flat.slice(0, 200).replace(/\s+\S*$/, "") + "…";
};

const shortId = (id: string) => id.slice(0, 8);

const clampInt = (value: string | undefined, fallback: number, min: number, max: number) => {
    const n = Number.parseInt(value ?? "", 10);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

const sha256 = async (input: string | Uint8Array) => {
    const data = (typeof input === "string" ? new TextEncoder().encode(input) : input) as Uint8Array<ArrayBuffer>;
    const digest = await crypto.subtle.digest("SHA-256", data);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};
