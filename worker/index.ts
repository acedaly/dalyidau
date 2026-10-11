import type { ExecutionContext, ScheduledController } from "@cloudflare/workers-types";
import { site } from "../src/content/site";
import { render } from "../src/entry-server";
import type { BlogFilters, PageData } from "../src/shared/types";
import type { Env } from "./env";
import { withSecurityHeaders } from "./lib/headers";
import { jsonForScript } from "./lib/html";
import { PostStore } from "./posts";
import { buildHead, robotsTxt, rssXml, sitemapXml } from "./seo";
import { type SyncSummary, runSync } from "./sync";

const HTML_EDGE_TTL = 300;
/** Edge-cached HTML is keyed on the content version, so it can live much longer than the browser cache. */
const PAGE_CACHE_TTL = 86_400;
const SYNC_LOCK_MINUTES = 15;

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        try {
            return withSecurityHeaders(await handle(request, env, ctx));
        } catch (error) {
            console.error(JSON.stringify({ event: "request_error", path: new URL(request.url).pathname, message: (error as Error).message }));
            return withSecurityHeaders(
                new Response(errorPage(), { status: 500, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }),
            );
        }
    },

    async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
        ctx.waitUntil(guardedSync(env, "cron", false).then(() => undefined));
    },
};

async function handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const siteUrl = new URL(env.SITE_URL);

    // www → apex, preserving path and query.
    if (url.hostname === `www.${siteUrl.hostname}`) {
        return Response.redirect(`${siteUrl.origin}${url.pathname}${url.search}`, 301);
    }

    const path = url.pathname;

    if (path.startsWith("/api/")) return api(request, env, url);
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });

    // Only the configured production host is indexable; workers.dev and staging are not.
    const indexable = env.ENVIRONMENT === "production" && url.hostname === siteUrl.hostname;
    const store = new PostStore(env.DB, env.IMAGE_TRANSFORMS === "on");

    if (path.startsWith("/media/")) return media(request, env, ctx, path.slice(7));
    if (path === "/robots.txt") return text(robotsTxt(env.SITE_URL, indexable), "text/plain", 3600);
    if (path === "/sitemap.xml") return text(sitemapXml(env.SITE_URL, await store.sitemapEntries()), "application/xml", HTML_EDGE_TTL);
    if (path === "/feed.xml" || path === "/rss.xml") return text(rssXml(env.SITE_URL, await store.all()), "application/rss+xml", HTML_EDGE_TTL);

    // Canonical paths: no trailing slash, lower-case slugs.
    if (path.length > 1 && path.endsWith("/")) return Response.redirect(`${url.origin}${path.replace(/\/+$/, "")}${url.search}`, 301);

    return cachedPage(request, env, ctx, indexable, async () => {
        const result = await route(path, url, store);
        if ("redirect" in result) return Response.redirect(`${url.origin}${result.redirect}`, 301);
        return renderPage(env, result.data, path, result.status, !indexable);
    });
}

type RouteResult = { data: PageData; status: number } | { redirect: string };

async function route(path: string, url: URL, store: PostStore): Promise<RouteResult> {
    if (path === "/") return { data: { route: "home", latest: await store.latest(3) }, status: 200 };
    if (path === "/about") return { data: { route: "about" }, status: 200 };
    if (path === "/contact") return { data: { route: "contact" }, status: 200 };

    if (path === "/blog") {
        const filters = readFilters(url);
        const unfiltered = !filters.q && !filters.category && !filters.tag;
        const featured = unfiltered && filters.page === 1 ? await store.featured() : null;
        const [result, categories] = await Promise.all([store.search(filters, featured?.slug ?? null), store.categories()]);
        return {
            data: {
                route: "blog",
                featured,
                posts: result.posts,
                categories,
                filters: { ...filters, page: result.page },
                totalPages: result.totalPages,
                totalPosts: result.total + (featured ? 1 : 0),
            },
            status: 200,
        };
    }

    const match = /^\/blog\/([^/]+)$/.exec(path);
    if (match) {
        let slug: string;
        try {
            slug = decodeURIComponent(match[1]);
        } catch {
            return notFound(path);
        }
        if (slug !== slug.toLowerCase()) return { redirect: `/blog/${encodeURIComponent(slug.toLowerCase())}` };
        const post = await store.bySlug(slug);
        if (post) {
            const related = await store.related(post);
            const { id: _id, ...publicPost } = post;
            return { data: { route: "post", post: publicPost, related, url: `/blog/${post.slug}` }, status: 200 };
        }
        const moved = await store.redirectFor(slug);
        if (moved) return { redirect: `/blog/${moved}` };
    }

    return notFound(path);
}

const notFound = (path: string): RouteResult => ({ data: { route: "not-found", path }, status: 404 });

const readFilters = (url: URL): BlogFilters => {
    const page = Number.parseInt(url.searchParams.get("page") ?? "1", 10);
    const clean = (value: string | null) => (value ?? "").trim().slice(0, 100) || null;
    return {
        q: clean(url.searchParams.get("q")) ?? "",
        category: clean(url.searchParams.get("category")),
        tag: clean(url.searchParams.get("tag")),
        page: Number.isFinite(page) && page > 0 ? Math.min(page, 1000) : 1,
    };
};

let shellCache: { html: string; version: string } | null = null;

async function shell(env: Env) {
    if (shellCache) return shellCache;
    const response = await env.ASSETS.fetch("https://assets.local/shell.html");
    if (!response.ok) throw new Error(`App shell missing (${response.status}); run vite build`);
    const html = await response.text();
    const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(html));
    shellCache = {
        html,
        version: [...new Uint8Array(digest)]
            .slice(0, 6)
            .map((b) => b.toString(16).padStart(2, "0"))
            .join(""),
    };
    return shellCache;
}

async function renderPage(env: Env, data: PageData, path: string, status: number, noindex: boolean): Promise<Response> {
    const { html: template } = await shell(env);
    const body = render(data, path);
    const head = buildHead({ data, siteUrl: env.SITE_URL, path, noindex });
    // The article body is already in the markup; the client reads it back from the DOM instead of duplicating it here.
    const payload = data.route === "post" ? { ...data, post: { ...data.post, bodyHtml: "" } } : data;
    const html = template
        .replace("<!--app-head-->", head)
        .replace("<!--app-html-->", body)
        .replace("<!--app-data-->", `<script type="application/json" id="page-data">${jsonForScript({ data: payload, path })}</script>`);
    return new Response(html, {
        status,
        headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": status === 200 ? "public, max-age=0, must-revalidate" : "no-store",
            ...(noindex ? { "X-Robots-Tag": "noindex" } : {}),
        },
    });
}

/**
 * Edge-caches successful HTML. The key includes the app build and the content version, which
 * every sync that changes public content bumps, so new and edited posts show up immediately.
 */
async function cachedPage(request: Request, env: Env, ctx: ExecutionContext, indexable: boolean, produce: () => Promise<Response>): Promise<Response> {
    const url = new URL(request.url);
    // Cache API types differ slightly between DOM and Workers; this is the Workers default cache.
    const cache = (globalThis as unknown as { caches?: { default: Cache } }).caches?.default;
    const cacheable = indexable && !!cache && request.method === "GET" && !url.searchParams.has("q");
    if (!cacheable) return produce();

    const [{ version: build }, content] = await Promise.all([
        shell(env),
        env.DB.prepare("SELECT value FROM meta WHERE key = 'content_version'").first<{ value: string }>(),
    ]);
    const params = new URLSearchParams(url.search);
    params.set("__b", build);
    params.set("__c", content?.value ?? "0");
    const key = new Request(`${url.origin}${url.pathname}?${params}`);

    const hit = await cache.match(key);
    if (hit) {
        // The long TTL is for the edge only; browsers always revalidate HTML.
        const fresh = new Response(hit.body, hit);
        fresh.headers.set("Cache-Control", "public, max-age=0, must-revalidate");
        return fresh;
    }
    const response = await produce();
    if (response.status === 200) {
        const copy = new Response(response.clone().body, response);
        copy.headers.set("Cache-Control", `public, max-age=${PAGE_CACHE_TTL}`);
        ctx.waitUntil(cache.put(key, copy));
    }
    return response;
}

async function media(request: Request, env: Env, ctx: ExecutionContext, key: string): Promise<Response> {
    if (!/^[a-f0-9]{24}\.(jpg|png|gif|webp|avif)$/.test(key)) return new Response("Not found", { status: 404 });
    const cache = (globalThis as unknown as { caches: { default: Cache } }).caches?.default;
    const cacheKey = new Request(new URL(request.url).toString());
    const hit = cache ? await cache.match(cacheKey) : undefined;
    if (hit) return hit;

    const object = await env.MEDIA.get(key);
    if (!object) return new Response("Not found", { status: 404 });
    const headers = new Headers();
    headers.set("Content-Type", object.httpMetadata?.contentType ?? "application/octet-stream");
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
    headers.set("ETag", object.httpEtag);
    headers.set("Content-Disposition", "inline");
    const response = new Response(object.body as unknown as ReadableStream, { headers });
    if (cache) ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
}

async function api(request: Request, env: Env, url: URL): Promise<Response> {
    if (url.pathname === "/api/health") {
        const last = await env.DB.prepare("SELECT finished_at, status FROM sync_runs WHERE status != 'running' ORDER BY id DESC LIMIT 1").first<{
            finished_at: string;
            status: string;
        }>();
        return json({ ok: true, lastSync: last ?? null }, 200);
    }

    if (url.pathname.startsWith("/api/admin/")) {
        if (!(await authorised(request, env))) return json({ error: "unauthorised" }, 401, { "WWW-Authenticate": "Bearer" });

        if (url.pathname === "/api/admin/sync") {
            if (request.method !== "POST") return json({ error: "use POST" }, 405);
            const result = await guardedSync(env, "manual", url.searchParams.get("force") === "1");
            if (!result) return json({ error: "a sync is already running" }, 409);
            return json(result, result.status === "failed" ? 502 : 200);
        }

        if (url.pathname === "/api/admin/status") {
            const runs = await env.DB.prepare("SELECT * FROM sync_runs ORDER BY id DESC LIMIT 20").all();
            const errors = await env.DB.prepare("SELECT id, status, last_checked_at, last_error FROM sources WHERE last_error IS NOT NULL").all();
            const posts = await env.DB.prepare("SELECT slug, title, published_at, synced_at FROM posts ORDER BY published_at DESC").all();
            return json(
                { runs: runs.results.map((r) => ({ ...r, log: JSON.parse(String(r.log ?? "[]")) })), sourceErrors: errors.results, posts: posts.results },
                200,
            );
        }
    }

    return json({ error: "not found" }, 404);
}

/** Runs a sync unless one started recently and has not finished. Returns null when skipped. */
export async function guardedSync(env: Env, trigger: "cron" | "manual", force: boolean): Promise<SyncSummary | null> {
    const cutoff = new Date(Date.now() - SYNC_LOCK_MINUTES * 60_000).toISOString();
    const running = await env.DB.prepare("SELECT id FROM sync_runs WHERE status = 'running' AND started_at > ? LIMIT 1").bind(cutoff).first();
    if (running) {
        console.log(JSON.stringify({ event: "sync_skipped", reason: "already running", trigger }));
        return null;
    }
    await env.DB.prepare("UPDATE sync_runs SET status = 'failed', log = '[\"Run did not finish\"]' WHERE status = 'running' AND started_at <= ?")
        .bind(cutoff)
        .run();
    return runSync(env, { trigger, force });
}

async function authorised(request: Request, env: Env) {
    const expected = env.ADMIN_TOKEN;
    const header = request.headers.get("Authorization") ?? "";
    if (!expected || expected.length < 24 || !header.startsWith("Bearer ")) return false;
    const encoder = new TextEncoder();
    const [a, b] = await Promise.all([
        crypto.subtle.digest("SHA-256", encoder.encode(header.slice(7))),
        crypto.subtle.digest("SHA-256", encoder.encode(expected)),
    ]);
    const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual?: (a: ArrayBuffer, b: ArrayBuffer) => boolean };
    if (subtle.timingSafeEqual) return subtle.timingSafeEqual(a, b);
    const x = new Uint8Array(a);
    const y = new Uint8Array(b);
    let diff = 0;
    for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
    return diff === 0;
}

const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body, null, 2), {
        status,
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
    });

const text = (body: string, type: string, ttl: number) =>
    new Response(body, { headers: { "Content-Type": `${type}; charset=utf-8`, "Cache-Control": `public, max-age=${ttl}` } });

const errorPage =
    () => `<!doctype html><html lang="en-AU"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Something went wrong — ${site.name}</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#181d27}a{color:#6941c6}@media(prefers-color-scheme:dark){body{background:#0c0e12;color:#f7f7f7}a{color:#b692f6}}</style></head>
<body><h1>Something went wrong</h1><p>The page couldn't be loaded just now. Please try again in a moment.</p><p><a href="/">Go to the homepage</a></p></body></html>`;
