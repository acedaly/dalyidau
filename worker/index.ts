import type { D1Database, ExecutionContext, ScheduledController } from "@cloudflare/workers-types";
import { site } from "../src/content/site";
import { render, renderWedding } from "../src/entry-server";
import { plannerBootMarkup } from "../src/planner/shell-markup";
import type { PlannerPageData } from "../src/shared/planner/types";
import { WEDDING_PREVIEW, adminPathForPortal } from "../src/shared/portal/admin-paths";
import { applicationById, canAccessApplication } from "../src/shared/portal/applications";
import { SAVE_THE_DATE_CALENDAR_PATH, icsFilename } from "../src/shared/portal/calendar";
import type { GuestInvitationPageData, PortalUser, SaveTheDatePageData, WeddingPageData } from "../src/shared/portal/types";
import { RESERVED_SLUGS, type SiteSettings } from "../src/shared/site-content";
import type { BlogFilters, PageData, PageRoute } from "../src/shared/types";
import { PREVIEW_MEDIA_PREFIX } from "./blog/payload-publisher";
import { handleCommsWebhook } from "./comms/webhooks";
import type { Env } from "./env";
import { bearerMatches } from "./lib/bearer";
import { withSecurityHeaders } from "./lib/headers";
import { escapeHtml, jsonForScript } from "./lib/html";
import { loggablePath } from "./lib/log";
import { PLANNER_PATH, RETIRED_APP_WORKER, offlineDocument, plannerFiles, plannerManifest, plannerView, serviceWorkerScript } from "./planner/pwa";
import { handlePortalApi } from "./portal/api";
import { type AuthResult, authenticate } from "./portal/auth";
import { processDueMessages } from "./portal/comms";
import { loadFlags } from "./portal/flags";
import { json as apiJson, checkMutation, errorResponse, readJson } from "./portal/http";
import { isRetiredPublicPath, retiredPageMessage, retiredPublicResponse } from "./portal/retired";
import { getSettings } from "./portal/settings";
import { PostStore, toSummary } from "./posts";
import { buildHead, robotsTxt, rssXml, sitemapXml } from "./seo";
import { listPages, loadPage, loadProject, loadProjects, loadProjectsHome, loadSite, loadSiteAndHome } from "./site/content";
import { type PreviewKind, cleanPreviews, loadDraftPreview } from "./site/preview";
import { manualRedirect } from "./site/redirects";
import { SYNC_OFF_MESSAGE, type SyncSummary, capacitiesSyncEnabled, runSync } from "./sync";
import { guestInvitationPage, guestInvitationPdf, saveTheDateAvailable, saveTheDateCalendar, saveTheDatePage } from "./wedding/guest-pages";
import { weddingOrigin } from "./wedding/invitations";
import { serveMedia } from "./wedding/media";
import { RsvpError, allow, lookupRsvp, submitRsvp } from "./wedding/rsvp";
import { loadWeddingPage, weddingTitle } from "./wedding/site";

const HTML_EDGE_TTL = 300;
/** Edge-cached HTML is keyed on the content version, so it can live much longer than the browser cache. */
const PAGE_CACHE_TTL = 86_400;
const SYNC_LOCK_MINUTES = 15;

// The MCP gateway (mcp.daly.id.au) reaches the portal through this, over a service binding only.
export { PortalMcpEntrypoint } from "./mcp/entrypoint";

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        try {
            return withSecurityHeaders(await handle(request, env, ctx));
        } catch (error) {
            console.error(JSON.stringify({ event: "request_error", path: loggablePath(new URL(request.url).pathname), message: (error as Error).message }));
            return withSecurityHeaders(
                new Response(errorPage(), { status: 500, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }),
            );
        }
    },

    async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
        ctx.waitUntil(guardedSync(env, "cron", false).then(() => undefined));
        ctx.waitUntil(processDueMessages(env).then(() => undefined));
        // Draft previews are for looking at now: old ones, and their private images, are removed (worker/site/preview.ts).
        ctx.waitUntil(
            cleanPreviews(env.DB, env.MEDIA).then(
                () => undefined,
                (error) => console.error(JSON.stringify({ event: "preview_cleanup_failed", message: (error as Error).message })),
            ),
        );
    },
};

async function handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const siteUrl = new URL(env.SITE_URL);
    const weddingUrl = new URL(weddingOrigin(env));

    // www → apex, preserving path and query.
    if (url.hostname === `www.${siteUrl.hostname}`) {
        return Response.redirect(`${siteUrl.origin}${url.pathname}${url.search}`, 301);
    }

    // The wedding custom domain is a deliberately narrow public surface. Portal, admin, health,
    // communication webhook and personal-site routes never fall through onto this hostname.
    // On staging WEDDING_URL is `<staging host>/wedding`, so the wedding site is served by path instead.
    const weddingHasOwnHost = weddingUrl.hostname !== siteUrl.hostname;
    if (weddingHasOwnHost && url.hostname === weddingUrl.hostname) return weddingHost(request, env, url, weddingUrl);
    // Wedding Planner's own address (PLANNER_URL): the app and the wedding API, nothing else.
    if (env.PLANNER_URL && url.hostname === new URL(env.PLANNER_URL).hostname) return plannerHost(request, env, url);

    const path = url.pathname;

    // daly.id.au/wedding is the same wedding website as the wedding host, served by path (weddingPage
    // below, `legacyPaths`), including old invitation links with their signed query credential. Its
    // canonical address stays on the wedding host, so nothing is indexed twice.

    if (path.startsWith("/api/portal/")) return portalApi(request, env);
    // Retired addresses that never sat behind Cloudflare Access (calendar feeds, wallboard displays,
    // the Amplenote plugin and its sign-in): a plain 410 that says only that they're retired.
    if (isRetiredPublicPath(path)) return retiredPublicResponse();
    if (path.startsWith("/api/wedding/")) return weddingApi(request, env, url);
    if (path.startsWith("/api/comms/webhooks/")) return handleCommsWebhook(request, env, url);
    if (path.startsWith("/api/")) return api(request, env, url);
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });

    // Only the configured production host is indexable; workers.dev and staging are not.
    const indexable = env.ENVIRONMENT === "production" && url.hostname === siteUrl.hostname;
    const store = new PostStore(env.DB, env.IMAGE_TRANSFORMS === "on");

    if (path.startsWith("/media/")) return media(request, env, ctx, path.slice(7));
    if (path === "/robots.txt") return text(robotsTxt(env.SITE_URL, indexable), "text/plain", 3600);
    if (path === "/sitemap.xml") {
        const [posts, pages, flags] = await Promise.all([store.sitemapEntries(), listPages(env.DB), loadFlags(env.DB)]);
        const projectsOn = flags["website.projects_home"];
        const projects = projectsOn ? (await loadProjects(env.DB)).filter((p) => !p.noindex) : [];
        return text(sitemapXml(env.SITE_URL, posts, pages, projects, projectsOn), "application/xml", HTML_EDGE_TTL);
    }
    if (path === "/feed.xml" || path === "/rss.xml") {
        const [posts, site] = await Promise.all([store.all(), loadSite(env.DB)]);
        return text(rssXml(env.SITE_URL, posts, site), "application/rss+xml", HTML_EDGE_TTL);
    }

    // Canonical paths: no trailing slash, lower-case slugs.
    if (path.length > 1 && path.endsWith("/")) return Response.redirect(`${url.origin}${path.replace(/\/+$/, "")}${url.search}`, 301);

    // The portal and the wedding site are never edge-cached: one is private, the other changes as
    // the couple edits it.
    if (path === "/portal" || path.startsWith("/portal/")) return portalPage(request, env, url);
    const photo = /^\/wedding\/media\/([^/]+)$/.exec(path);
    if (photo) return weddingPhoto(request, env, photo[1]);
    if (path === "/wedding" || path.startsWith("/wedding/")) return weddingPage(request, env, url, indexable);

    const publicFlags = await loadFlags(env.DB);
    const weddingPublished = publicFlags["wedding.site.public"];
    // The projects-first design (Phase 4) is public only once switched on in Administration → Features.
    const projects = publicFlags["website.projects_home"];
    const variant = `${weddingPublished ? "wedding-public" : "wedding-private"}-${projects ? "projects" : "classic"}`;
    return cachedPage(request, env, ctx, indexable, variant, async () => {
        const result = await route(path, url, store, env.DB, projects);
        if ("redirect" in result) return Response.redirect(`${url.origin}${result.redirect}`, 301);
        // Nothing answers this address: a redirect kept by hand in Payload (Website → Redirects), if there is one.
        if (result.status === 404) {
            const manual = await manualRedirect(env.DB, path);
            // Browsers keep a permanent redirect for good unless told otherwise: an hour, so removing one in Payload works.
            if (manual)
                return new Response(null, {
                    status: manual.status,
                    headers: { Location: manual.to.startsWith("/") ? `${url.origin}${manual.to}` : manual.to, "Cache-Control": "public, max-age=3600" },
                });
        }
        const site = result.site ?? (await loadSite(env.DB));
        const context = { weddingPublished, site, ...(projects ? { design: "projects" as const } : {}) };
        return renderPage(env, { ...result.data, context }, path, result.status, !indexable);
    });
}

type RouteResult = { data: PageRoute; status: number; site?: SiteSettings } | { redirect: string };

async function route(path: string, url: URL, store: PostStore, db: D1Database, projects = false): Promise<RouteResult> {
    if (projects) {
        const routed = await projectRoute(path, store, db);
        if (routed) return routed;
    }
    if (path === "/") {
        const { site, home } = await loadSiteAndHome(db);
        return { data: { route: "home", latest: home.latestCount ? await store.latest(home.latestCount) : [], home }, status: 200, site };
    }
    if (path === "/contact") return { data: { route: "contact" }, status: 200 };

    if (path === "/blog") {
        const filters = readFilters(url);
        const unfiltered = !filters.q && !filters.category && !filters.tag;
        // The featured post is left out of every unfiltered page so pagination stays stable;
        // its card only appears on page 1.
        const featured = unfiltered ? await store.featured() : null;
        const [result, categories] = await Promise.all([store.search(filters, featured?.slug ?? null), store.categories()]);
        return {
            data: {
                route: "blog",
                featured: result.page === 1 ? featured : null,
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

    // Pages managed in Payload, at daly.id.au/<slug>. Every application route above wins, and the
    // publisher refuses reserved addresses, so a page can never take over one of them.
    const page = /^\/([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(path);
    if (page && !RESERVED_SLUGS.has(page[1])) {
        const found = await loadPage(db, page[1]);
        if (found && "page" in found) return { data: { route: "page", page: found.page }, status: 200 };
        if (found) return { redirect: `/${found.redirect}` };
    }

    return notFound(path);
}

const notFound = (path: string): RouteResult => ({ data: { route: "not-found", path }, status: 404 });

/** The projects-first pages: /, /projects and /projects/<slug> (null for anything else). `base` prefixes redirects in the preview. */
async function projectRoute(path: string, store: PostStore, db: D1Database, base = ""): Promise<RouteResult | null> {
    if (path === "/") {
        const { site, content, projects } = await loadProjectsHome(db);
        const latest = content.showWriting && content.writingCount ? await store.latest(content.writingCount) : [];
        return { data: { route: "projects-home", content, projects, latest }, status: 200, site };
    }
    if (path === "/projects") {
        const [{ site, content, projects }] = await Promise.all([loadProjectsHome(db)]);
        return { data: { route: "projects", projects, intro: content.projectsIntro }, status: 200, site };
    }
    const match = /^\/projects\/([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(path);
    if (match) {
        const found = await loadProject(db, match[1]);
        if (found && "project" in found) return { data: { route: "project", project: found.project, related: found.related }, status: 200 };
        if (found) return { redirect: `${base}/projects/${found.redirect}` };
        return notFound(path);
    }
    if (path.startsWith("/projects/")) return notFound(path);
    return null;
}

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

type Area = "site" | "wedding" | "planner";

const SHELL_FILES: Record<Area, string> = {
    site: "shell.html",
    wedding: "shell-wedding.html",
    planner: "shell-planner.html",
};
const shellCache = new Map<Area, { html: string; version: string }>();

async function shell(env: Env, area: Area = "site") {
    const cached = shellCache.get(area);
    if (cached) return cached;
    const response = await env.ASSETS.fetch(`https://assets.local/${SHELL_FILES[area]}`);
    if (!response.ok) throw new Error(`App shell ${SHELL_FILES[area]} missing (${response.status}); run vite build`);
    const html = await response.text();
    const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(html));
    const entry = {
        html,
        version: [...new Uint8Array(digest)]
            .slice(0, 6)
            .map((b) => b.toString(16).padStart(2, "0"))
            .join(""),
    };
    shellCache.set(area, entry);
    return entry;
}

interface DocumentInput {
    area: Area;
    head: string;
    body: string;
    data: unknown;
    path: string;
    status: number;
    headers: Record<string, string>;
    /** Extra attributes for the <html> element. */
    htmlAttributes?: string;
}

async function renderDocument(env: Env, input: DocumentInput): Promise<Response> {
    const { html: template } = await shell(env, input.area);
    let html = template
        .replace("<!--app-head-->", input.head)
        .replace("<!--app-html-->", input.body)
        .replace(
            "<!--app-data-->",
            `<script type="application/json" id="page-data">${jsonForScript({ area: input.area, data: input.data, path: input.path })}</script>`,
        );
    if (input.htmlAttributes) html = html.replace('<html lang="en-AU">', `<html lang="en-AU" ${input.htmlAttributes}>`);
    // The projects-first design uses the Daly logo pack's icons (public/brand) and navy browser chrome in dark mode.
    if (input.htmlAttributes?.includes("site-v2"))
        html = html
            .replace('href="/favicon.svg"', 'href="/brand/favicon.svg"')
            .replace(/<link rel="icon" href="\/favicon\.ico"[^>]*>/, '<link rel="icon" href="/brand/favicon-32.png" type="image/png" sizes="32x32" />')
            .replace('href="/apple-touch-icon.png"', 'href="/brand/apple-touch-icon.png"')
            .replace('content="#0c0e12"', 'content="#10203a"');
    return new Response(html, { status: input.status, headers: { "Content-Type": "text/html; charset=utf-8", ...input.headers } });
}

async function renderPage(env: Env, data: PageData, path: string, status: number, noindex: boolean, headers: Record<string, string> = {}): Promise<Response> {
    const body = render(data, path);
    const head = buildHead({ data, siteUrl: env.SITE_URL, path, noindex });
    // The article body is already in the markup; the client reads it back from the DOM instead of duplicating it here.
    const payload = data.route === "post" ? { ...data, post: { ...data.post, bodyHtml: "" } } : data;
    return renderDocument(env, {
        area: "site",
        head,
        body,
        data: payload,
        path,
        status,
        headers: {
            "Cache-Control": status === 200 ? "public, max-age=0, must-revalidate" : "no-store",
            ...(noindex ? { "X-Robots-Tag": "noindex" } : {}),
            ...headers,
        },
        // The projects-first design's palette and type (src/styles/globals.css .site-v2).
        htmlAttributes: data.context.design === "projects" ? 'class="site-v2"' : undefined,
    });
}

const PRIVATE_HEADERS = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };

// --- Portal (retired: Payload at /admin is the only administration, docs/PAYLOAD-NEXT.md) ----------

/**
 * The old portal pages: every human-facing address now opens its Payload equivalent
 * (src/shared/portal/admin-paths.ts), so bookmarks and links already sent keep working. Checked after
 * sign-in, so a redirect reveals nothing to strangers. /api/portal/* is the admin's API and isn't touched.
 * Two things stay: the draft preview of the wedding website (a rendered wedding page, opened from the
 * Website screen) and the retired service workers, so installed copies of the old apps remove themselves.
 */
async function portalPage(request: Request, env: Env, url: URL): Promise<Response> {
    const auth = await authenticate(request, env);
    if (!auth.ok) return accessDenied(auth);
    const path = url.pathname;
    if (path === "/portal/sw.js") return retiredWorker();
    // Wedding Planner, the phone app (docs/PLANNER.md), and its manifest, service worker and offline page.
    if (path === PLANNER_PATH || path.startsWith(`${PLANNER_PATH}/`)) return plannerPage(env, auth.user, url);
    const preview = WEDDING_PREVIEW.exec(path);
    if (preview) {
        const application = applicationById("wedding");
        if (!application || !canAccessApplication(auth.user, application)) {
            return new Response("Not found", { status: 404, headers: PRIVATE_HEADERS });
        }
        const data = await loadWeddingPage(env.DB, preview[1] ? "rsvp" : "home", true);
        return renderWeddingDocument(env, data, path, 200, true, PRIVATE_HEADERS);
    }
    // The projects-first design before it's switched on (Phase 4): owners and admins only, never cached or indexed.
    // A draft, as it will look once published (worker/site/preview.ts): owners and admins only, never cached or indexed.
    const draft = /^\/portal\/preview\/draft\/(page|project|post)\/([^/]+)$/.exec(path);
    if (draft) return previewDraft(env, auth.user.role, draft[1] as PreviewKind, draft[2]);
    const preview2 = /^\/portal\/preview(\/.*)?$/.exec(path);
    if (preview2) return previewSite(env, auth.user.role, preview2[1] ?? "/");
    // Applications retired earlier keep their own message (worker/portal/retired.ts) rather than a redirect.
    const retired = retiredPageMessage(path);
    if (retired) return retiredPage(retired);
    return privateRedirect(`${url.origin}${adminPathForPortal(`${path}${url.search}`) ?? "/admin"}`);
}

/** A draft from Payload, rendered by the same components as the public page it will become. */
async function previewDraft(env: Env, role: string, kind: PreviewKind, id: string): Promise<Response> {
    if (role !== "owner" && role !== "admin") return new Response("Not found", { status: 404, headers: PRIVATE_HEADERS });
    const preview = await loadDraftPreview(env.DB, kind, id);
    if (!preview) {
        const html = `<!doctype html><html lang="en-AU"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>Preview expired</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#181d27}a{color:#b8401c}@media(prefers-color-scheme:dark){body{background:#10203a;color:#f3f5f8}a{color:#f0a48c}}</style></head>
<body><h1>This preview isn’t available</h1><p>Previews last a day. Open the document in the admin and press Preview again.</p><p><a href="/admin">Open the admin</a></p></body></html>`;
        return new Response(html, { status: 404, headers: { "Content-Type": "text/html; charset=utf-8", ...PRIVATE_HEADERS } });
    }
    const [site, flags] = await Promise.all([loadSite(env.DB), loadFlags(env.DB)]);
    const design = preview.kind === "project" || flags["website.projects_home"] ? { design: "projects" as const } : {};
    const context = {
        weddingPublished: flags["wedding.site.public"],
        site,
        ...design,
        preview: { published: preview.published, createdAt: preview.createdAt },
    };
    if (preview.kind === "page") return renderPage(env, { route: "page", page: preview.data, context }, `/${preview.data.slug}`, 200, true, PRIVATE_HEADERS);
    if (preview.kind === "project")
        return renderPage(env, { route: "project", project: preview.data, related: [], context }, `/projects/${preview.data.slug}`, 200, true, PRIVATE_HEADERS);
    const { slug, record } = preview.data;
    // No resizing service here: it couldn't load a private preview image.
    const summary = toSummary({ ...record, slug, tags: JSON.stringify(record.tags), featured: record.featured ? 1 : 0 } as never, false);
    const post = { ...summary, bodyHtml: record.body_html, toc: record.toc };
    return renderPage(env, { route: "post", post, related: [], url: `/blog/${slug}`, context }, `/blog/${slug}`, 200, true, PRIVATE_HEADERS);
}

/** The redesigned public pages at /portal/preview, /portal/preview/projects and /portal/preview/projects/<slug>. */
async function previewSite(env: Env, role: string, rest: string): Promise<Response> {
    if (role !== "owner" && role !== "admin") return new Response("Not found", { status: 404, headers: PRIVATE_HEADERS });
    const base = "/portal/preview";
    const store = new PostStore(env.DB, env.IMAGE_TRANSFORMS === "on");
    const result = (await projectRoute(rest, store, env.DB, base)) ?? notFound(`${base}${rest}`);
    if ("redirect" in result) return privateRedirect(`${new URL(env.SITE_URL).origin}${result.redirect}`);
    const [site, flags] = await Promise.all([result.site ?? loadSite(env.DB), loadFlags(env.DB)]);
    const context = { weddingPublished: flags["wedding.site.public"], site, design: "projects" as const, base };
    return renderPage(env, { ...result.data, context }, `${base}${rest === "/" ? "" : rest}`, result.status, true, PRIVATE_HEADERS);
}

/** Plain HTML, no app bundle: an application that has been retired, and where things are now. */
function retiredPage(message: string): Response {
    const html = `<!doctype html><html lang="en-AU"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>Retired — ${escapeHtml(site.name)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#181d27}a{color:#6941c6}@media(prefers-color-scheme:dark){body{background:#0c0e12;color:#f7f7f7}a{color:#b692f6}}</style></head>
<body><h1>Retired</h1><p>${escapeHtml(message)}</p><p><a href="/admin">Open the admin</a> · <a href="/">Go to the homepage</a></p></body></html>`;
    return new Response(html, { status: 410, headers: { "Content-Type": "text/html; charset=utf-8", ...PRIVATE_HEADERS } });
}

const privateRedirect = (location: string) => new Response(null, { status: 302, headers: { Location: location, ...PRIVATE_HEADERS } });

const retiredWorker = () => new Response(RETIRED_APP_WORKER, { headers: { "Content-Type": "text/javascript; charset=utf-8", ...PRIVATE_HEADERS } });

/**
 * weddingplanner.daly.id.au, the app's first host (docs/PLANNER.md). It never got its Cloudflare Access
 * destination, so nothing private answers here: pages go to the same view of the app on daly.id.au (behind
 * Access), the service worker an earlier install left on this host retires itself, and the API is closed.
 */
function plannerHost(request: Request, env: Env, url: URL): Response {
    const path = url.pathname;
    if (path === "/sw.js") return retiredWorker();
    if (path.startsWith("/api/")) return apiJson({ error: "not_found" }, 404);
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    const view = plannerView(path.replace(/\/+$/, "")) ?? "home";
    return privateRedirect(`${new URL(env.SITE_URL).origin}${PLANNER_PATH}${view === "home" ? "" : `/${view}`}`);
}

// --- Wedding Planner (docs/PLANNER.md) --------------------------------------------------------------

/** The app, its manifest, service worker and offline page, at /portal/planner. Signed in already (portalPage). */
async function plannerPage(env: Env, user: PortalUser, url: URL): Promise<Response> {
    const application = applicationById("wedding");
    if (!application || !canAccessApplication(user, application)) return new Response("Not found", { status: 404, headers: PRIVATE_HEADERS });
    const base = PLANNER_PATH;
    const path = url.pathname;
    const files = plannerFiles(base);
    const adminUrl = `${new URL(env.SITE_URL).origin}/admin/wedding`;
    if (path === files.manifest)
        return new Response(JSON.stringify(plannerManifest(base)), {
            headers: { "Content-Type": "application/manifest+json; charset=utf-8", ...PRIVATE_HEADERS },
        });
    if (path === files.serviceWorker || path === files.offline) {
        const { html, version } = await shell(env, "planner");
        if (path === files.offline)
            return new Response(offlineDocument(html, adminUrl), { headers: { "Content-Type": "text/html; charset=utf-8", ...PRIVATE_HEADERS } });
        return new Response(serviceWorkerScript(version, html, base), {
            // At <base>/sw.js, but it looks after <base> itself too.
            headers: { "Content-Type": "text/javascript; charset=utf-8", "Service-Worker-Allowed": files.scope, ...PRIVATE_HEADERS },
        });
    }
    const view = plannerView(path.slice(base.length));
    if (!view) return new Response("Not found", { status: 404, headers: PRIVATE_HEADERS });
    const [flags, wedding] = await Promise.all([loadFlags(env.DB), getSettings(env.DB, "wedding")]);
    const data: PlannerPageData = { context: { user, flags, wedding, environment: env.ENVIRONMENT }, base, view, portalUrl: adminUrl };
    return renderDocument(env, {
        area: "planner",
        head: [
            `<title>Wedding Planner</title>`,
            `<meta name="robots" content="noindex, nofollow">`,
            // Behind Cloudflare Access, so the manifest is fetched with credentials.
            `<link rel="manifest" href="${escapeHtml(files.manifest)}" crossorigin="use-credentials">`,
        ].join("\n        "),
        body: plannerBootMarkup(),
        data,
        path,
        status: 200,
        headers: PRIVATE_HEADERS,
    });
}

async function portalApi(request: Request, env: Env): Promise<Response> {
    const auth = await authenticate(request, env);
    // The reason is logged, not returned: it would tell an attacker which check failed.
    if (!auth.ok) return apiJson({ error: auth.status === 401 ? "unauthenticated" : "forbidden" }, auth.status);
    // Owners can try the native RSVP form from the website preview before it goes live.
    const url = new URL(request.url);
    const test = /^\/api\/portal\/wedding\/rsvp-test\/(lookup|submit)$/.exec(url.pathname);
    if (test) {
        if (!auth.user.permissions.includes("wedding.rsvp.edit")) return apiJson({ error: "forbidden", message: "You can't test RSVPs" }, 403);
        return rsvpEndpoint(request, env, test[1] as "lookup" | "submit");
    }
    return handlePortalApi(request, env, auth.user);
}

/** Plain HTML, no app bundle: nothing about the portal is revealed to someone who isn't signed in. */
function accessDenied(auth: Extract<AuthResult, { ok: false }>): Response {
    const misconfigured = auth.reason === "not_configured" || auth.reason === "keys_unavailable";
    const message = misconfigured
        ? "The portal isn't available right now."
        : auth.reason === "no_role" || auth.reason === "inactive"
          ? "You're signed in, but this account hasn't been given access to the portal."
          : "Please sign in to continue.";
    const html = `<!doctype html><html lang="en-AU"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>Portal — ${escapeHtml(site.name)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#181d27}a{color:#6941c6}@media(prefers-color-scheme:dark){body{background:#0c0e12;color:#f7f7f7}a{color:#b692f6}}</style></head>
<body><h1>Portal</h1><p>${escapeHtml(message)}</p><p><a href="/cdn-cgi/access/logout">Sign out</a> · <a href="/">Go to the homepage</a></p></body></html>`;
    return new Response(html, { status: auth.status, headers: { "Content-Type": "text/html; charset=utf-8", ...PRIVATE_HEADERS } });
}

// --- Wedding website ------------------------------------------------------------------------------

/** The wedding host's path for a /wedding/... path on the site host (the canonical address). */
const weddingHostPath = (path: string) => (path === "/wedding" ? "/" : path.slice("/wedding".length));

async function weddingPage(request: Request, env: Env, url: URL, indexable: boolean): Promise<Response> {
    const guest = GUEST_PATHS.has(url.pathname.slice("/wedding".length)) ? url.pathname.slice("/wedding".length) : null;
    if (guest) return guestPage(request, env, url, guest);
    const route = url.pathname === "/wedding" ? "home" : url.pathname === "/wedding/rsvp" ? "rsvp" : null;
    const flags = await loadFlags(env.DB);
    // Until the couple publishes it, /wedding is indistinguishable from any other missing page.
    if (!route || !flags["wedding.site.public"])
        return renderPage(
            env,
            { route: "not-found", path: url.pathname, context: { weddingPublished: false, site: await loadSite(env.DB) } },
            url.pathname,
            404,
            true,
        );
    const data = { ...(await loadWeddingPage(env.DB, route, false)), legacyPaths: true };
    const noindex = data.content.noindex || !indexable || route === "rsvp";
    return renderWeddingDocument(env, data, url.pathname, 200, noindex, weddingPageHeaders(route, noindex));
}

async function weddingHost(request: Request, env: Env, url: URL, canonical: URL): Promise<Response> {
    const path = url.pathname;
    if (path.startsWith("/api/wedding/")) return weddingApi(request, env, url);
    if (
        path.startsWith("/portal") ||
        path.startsWith("/api/portal/") ||
        path.startsWith("/api/admin/") ||
        path.startsWith("/api/comms/") ||
        path.startsWith("/api/amplenote/") ||
        path.startsWith("/api/integrations/")
    ) {
        return new Response("Not found", { status: 404, headers: PRIVATE_HEADERS });
    }
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    if (path.length > 1 && path.endsWith("/")) return Response.redirect(`${canonical.origin}${path.replace(/\/+$/, "")}${url.search}`, 301);
    const photo = /^\/wedding\/media\/([^/]+)$/.exec(path);
    if (photo) return weddingPhoto(request, env, photo[1]);
    const indexable = env.ENVIRONMENT === "production" && url.hostname === canonical.hostname;
    if (path === "/robots.txt") return text(robotsTxt(canonical.origin, indexable), "text/plain", 3600);
    if (path === "/sitemap.xml") {
        const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${canonical.origin}/</loc></url>\n</urlset>\n`;
        return text(xml, "application/xml", HTML_EDGE_TTL);
    }
    if (GUEST_PATHS.has(path)) return guestPage(request, env, url, path);
    const route = path === "/" ? "home" : path === "/rsvp" ? "rsvp" : null;
    const flags = await loadFlags(env.DB);
    if (!route || !flags["wedding.site.public"]) {
        return new Response("Not found", {
            status: 404,
            headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
        });
    }
    const data = await loadWeddingPage(env.DB, route, false);
    const noindex = data.content.noindex || !indexable || route === "rsvp";
    return renderWeddingDocument(env, data, path, 200, noindex, weddingPageHeaders(route, noindex));
}

/**
 * The RSVP page is opened with a signed link in its address, so it's never stored by any cache and
 * never sends that address on as a referrer. Its HTML holds no household details (they're fetched
 * once the link is checked), but the URL itself is the credential.
 */
const weddingPageHeaders = (route: WeddingPageData["route"], noindex: boolean): Record<string, string> =>
    route === "rsvp"
        ? { ...PRIVATE_HEADERS, "Referrer-Policy": "no-referrer" }
        : { "Cache-Control": "public, max-age=0, must-revalidate", ...(noindex ? { "X-Robots-Tag": "noindex" } : {}) };

function renderWeddingDocument(env: Env, data: WeddingPageData, path: string, status: number, noindex: boolean, headers: Record<string, string>) {
    const title = weddingTitle(data);
    const site = weddingOrigin(env);
    const couple = `${data.details.partnerOne} & ${data.details.partnerTwo}`;
    const when = data.details.date
        ? new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(
              new Date(`${data.details.date}T12:00:00Z`),
          )
        : "";
    const description =
        data.route === "rsvp"
            ? `RSVP for ${couple}'s wedding.`
            : `${couple} are getting married${when ? ` on ${when}` : ""}${data.details.location ? ` at ${data.details.location}` : ""}.`;
    // Social previews use the hero photo, but only on the public site (the preview is private).
    const image = !data.preview && data.heroImage ? `${site}${data.heroImage.url}` : null;
    return renderDocument(env, {
        area: "wedding",
        head: [
            `<title>${escapeHtml(title)}</title>`,
            `<meta name="description" content="${escapeHtml(description)}">`,
            `<meta name="robots" content="${noindex ? "noindex, nofollow" : "index, follow"}">`,
            ...(data.route === "rsvp" ? [`<meta name="referrer" content="no-referrer">`] : []),
            // Under daly.id.au/wedding (path mode) the canonical address is still the wedding host's.
            ...(data.preview ? [] : [`<link rel="canonical" href="${escapeHtml(`${site}${data.legacyPaths ? weddingHostPath(path) : path}`)}">`]),
            `<meta property="og:title" content="${escapeHtml(title)}">`,
            `<meta property="og:description" content="${escapeHtml(description)}">`,
            `<meta property="og:type" content="website">`,
            ...(image
                ? [
                      `<meta property="og:image" content="${escapeHtml(image)}">`,
                      `<meta property="og:image:alt" content="${escapeHtml(data.heroImage!.alt || couple)}">`,
                      `<meta name="twitter:card" content="summary_large_image">`,
                  ]
                : []),
            `<meta name="theme-color" content="#f8f5ee">`,
        ].join("\n        "),
        body: renderWedding(data, path),
        data,
        path,
        status,
        headers,
        // The wedding site has its own light palette; the stored dark-mode preference doesn't apply.
        htmlAttributes: 'data-theme-lock="light"',
    });
}

// "/save-the-date.ics" stays for links in messages already sent; new messages link SAVE_THE_DATE_CALENDAR_PATH.
const SAVE_THE_DATE_CALENDARS = new Set([SAVE_THE_DATE_CALENDAR_PATH, "/save-the-date.ics"]);
const GUEST_PATHS = new Set(["/invitation", "/invitation.pdf", "/save-the-date", ...SAVE_THE_DATE_CALENDARS]);

const GUEST_NOT_FOUND = () => new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", ...PRIVATE_HEADERS } });

/**
 * The pages guests reach from a message (see worker/wedding/guest-pages.ts). The invitation pages
 * follow the RSVP page: served once the website is published, and only for a valid signed link.
 * They're never cached or indexed, and the signed link isn't sent on as a referrer.
 */
async function guestPage(request: Request, env: Env, url: URL, path: string): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    if (path === "/save-the-date" || SAVE_THE_DATE_CALENDARS.has(path)) {
        if (!(await saveTheDateAvailable(env))) return GUEST_NOT_FOUND();
        if (SAVE_THE_DATE_CALENDARS.has(path)) {
            const calendar = await saveTheDateCalendar(env);
            if (!calendar) return GUEST_NOT_FOUND();
            const wedding = await getSettings(env.DB, "wedding");
            return new Response(calendar, {
                headers: {
                    "Content-Type": "text/calendar; charset=utf-8",
                    // Inline, so iPhone Safari shows its "Add to Calendar" sheet for the one event instead of
                    // saving a file to Downloads. Desktop browsers can't display it and save it under this name.
                    "Content-Disposition": `inline; filename="${icsFilename(wedding)}"`,
                    "Cache-Control": "public, max-age=300",
                    "X-Robots-Tag": "noindex",
                },
            });
        }
        const data = await saveTheDatePage(env);
        if (!data) return GUEST_NOT_FOUND();
        return renderGuestDocument(env, data, url.pathname, 200, { "Cache-Control": "public, max-age=0, must-revalidate", "X-Robots-Tag": "noindex" });
    }
    const flags = await loadFlags(env.DB);
    if (!flags["wedding.site.public"]) return GUEST_NOT_FOUND();
    // Building an invitation (and above all its PDF) is real work: limit each visitor, as the RSVP API does.
    const client = request.headers.get("CF-Connecting-IP") ?? "unknown";
    if (!(await allow(env.DB, path === "/invitation.pdf" ? "invitation-pdf" : "invitation-page", client, path === "/invitation.pdf" ? 20 : 60, 600)))
        return new Response("Too many requests. Please wait a few minutes and try again.", {
            status: 429,
            headers: { "Content-Type": "text/plain; charset=utf-8", "Retry-After": "600", ...PRIVATE_HEADERS },
        });
    const token = url.searchParams.get("invite");
    if (path === "/invitation.pdf") {
        const pdf = await guestInvitationPdf(env, token);
        if (!pdf) return GUEST_NOT_FOUND();
        return new Response(new Uint8Array(pdf.bytes).buffer, {
            headers: {
                "Content-Type": "application/pdf",
                "Content-Disposition": `attachment; filename="${pdf.filename}"`,
                ...PRIVATE_HEADERS,
                "Referrer-Policy": "no-referrer",
            },
        });
    }
    const data = await guestInvitationPage(env, token);
    // An invalid link gets the same friendly page as a revoked one, with nothing about who it was for.
    return renderGuestDocument(env, data, url.pathname, data.invitation ? 200 : 404, { ...PRIVATE_HEADERS, "Referrer-Policy": "no-referrer" });
}

function renderGuestDocument(env: Env, data: GuestInvitationPageData | SaveTheDatePageData, path: string, status: number, headers: Record<string, string>) {
    const couple = `${data.details.partnerOne} & ${data.details.partnerTwo}`;
    // Titles and previews never name a household: links get pasted into chats that unfurl them.
    const title = data.route === "invitation" ? `Your invitation · ${couple}` : `Save the date · ${couple}`;
    const description = data.route === "invitation" ? `An invitation to ${couple}'s wedding.` : `${couple} are getting married. Formal invitation to follow.`;
    return renderDocument(env, {
        area: "wedding",
        head: [
            `<title>${escapeHtml(title)}</title>`,
            `<meta name="description" content="${escapeHtml(description)}">`,
            `<meta name="robots" content="noindex, nofollow">`,
            `<meta name="referrer" content="no-referrer">`,
            `<meta property="og:title" content="${escapeHtml(title)}">`,
            `<meta property="og:description" content="${escapeHtml(description)}">`,
            `<meta name="theme-color" content="#f8f5ee">`,
        ].join("\n        "),
        body: renderWedding(data, path),
        data,
        path,
        status,
        headers,
        htmlAttributes: 'data-theme-lock="light"',
    });
}

/**
 * Website photos are public once the site is; before that, only the people who may open the wedding
 * website's draft preview (portalPage's WEDDING_PREVIEW check) see them, not every signed-in role.
 */
async function weddingPhoto(request: Request, env: Env, file: string): Promise<Response> {
    const flags = await loadFlags(env.DB);
    if (!flags["wedding.site.public"]) {
        const auth = await authenticate(request, env);
        const application = applicationById("wedding");
        if (!auth.ok || !application || !canAccessApplication(auth.user, application))
            return new Response("Not found", { status: 404, headers: PRIVATE_HEADERS });
        const response = await serveMedia(env.MEDIA, file);
        const copy = new Response(response.body, response);
        copy.headers.set("Cache-Control", "private, no-store");
        return copy;
    }
    return serveMedia(env.MEDIA, file);
}

async function weddingApi(request: Request, env: Env, url: URL): Promise<Response> {
    const match = /^\/api\/wedding\/rsvp\/(lookup|submit)$/.exec(url.pathname);
    if (!match) return apiJson({ error: "not_found" }, 404);
    const flags = await loadFlags(env.DB);
    if (!flags["rsvp.native"] || !flags["wedding.site.public"]) {
        return apiJson({ error: "closed", message: "Online RSVPs aren't open here. Please use the link on your invitation." }, 404);
    }
    return rsvpEndpoint(request, env, match[1] as "lookup" | "submit");
}

async function rsvpEndpoint(request: Request, env: Env, action: "lookup" | "submit"): Promise<Response> {
    try {
        if (request.method !== "POST") return apiJson({ error: "method_not_allowed" }, 405, { Allow: "POST" });
        checkMutation(request, env);
        const body = await readJson(request, 50_000);
        if (action === "lookup") return apiJson({ household: await lookupRsvp(env, request, body) });
        return apiJson(await submitRsvp(env, request, body));
    } catch (error) {
        if (error instanceof RsvpError) return apiJson({ error: error.code, message: error.message }, error.status);
        return errorResponse(error, new URL(request.url).pathname);
    }
}

/**
 * Edge-caches successful HTML. The key includes the app build and the content version, which
 * every sync that changes public content bumps, so new and edited posts show up immediately.
 */
/** The query parameters a public page's content depends on (readFilters; `q` is never cached). */
const PAGE_PARAMS = ["category", "page", "tag"];

async function cachedPage(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
    indexable: boolean,
    variant: string,
    produce: () => Promise<Response>,
): Promise<Response> {
    const url = new URL(request.url);
    // Cache API types differ slightly between DOM and Workers; this is the Workers default cache.
    const cache = (globalThis as unknown as { caches?: { default: Cache } }).caches?.default;
    const cacheable = indexable && !!cache && request.method === "GET" && !url.searchParams.has("q");
    if (!cacheable) return produce();

    const [{ version: build }, content] = await Promise.all([
        shell(env),
        env.DB.prepare("SELECT value FROM meta WHERE key = 'content_version'").first<{ value: string }>(),
    ]);
    // Only what the pages read (the blog's filters). Tracking parameters (utm_*, fbclid…) would otherwise
    // give every shared link its own copy in the cache.
    const params = new URLSearchParams();
    for (const name of PAGE_PARAMS) for (const value of url.searchParams.getAll(name)) params.append(name, value);
    params.set("__b", build);
    params.set("__c", content?.value ?? "0");
    params.set("__v", variant);
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
    if (!object) return previewMedia(request, env, key);
    const headers = new Headers();
    headers.set("Content-Type", object.httpMetadata?.contentType ?? "application/octet-stream");
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
    headers.set("ETag", object.httpEtag);
    headers.set("Content-Disposition", "inline");
    const response = new Response(object.body as unknown as ReadableStream, { headers });
    if (cache) ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
}

/**
 * An image that isn't public: it may belong to a draft preview (worker/site/preview.ts), kept under a private
 * prefix. Only a signed-in owner or admin gets it, never from a cache; to anyone else it doesn't exist.
 */
async function previewMedia(request: Request, env: Env, key: string): Promise<Response> {
    const missing = () => new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
    // An ordinary visitor's missing image: no sign-in to check, and nothing to log.
    if (!request.headers.get("Cf-Access-Jwt-Assertion") && !/(?:^|;\s*)CF_Authorization=/.test(request.headers.get("Cookie") ?? "")) return missing();
    const auth = await authenticate(request, env);
    if (!auth.ok || (auth.user.role !== "owner" && auth.user.role !== "admin")) return missing();
    const object = await env.MEDIA.get(PREVIEW_MEDIA_PREFIX + key);
    if (!object) return missing();
    return new Response(object.body as unknown as ReadableStream, {
        headers: { "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream", "Content-Disposition": "inline", ...PRIVATE_HEADERS },
    });
}

async function api(request: Request, env: Env, url: URL): Promise<Response> {
    if (url.pathname === "/api/health") {
        const last = await env.DB.prepare(
            "SELECT finished_at, status FROM sync_runs WHERE status != 'running' AND trigger NOT LIKE 'amplenote:%' ORDER BY id DESC LIMIT 1",
        ).first<{
            finished_at: string;
            status: string;
        }>();
        return json({ ok: true, lastSync: last ?? null }, 200);
    }

    if (url.pathname.startsWith("/api/admin/")) {
        if (!(await authorised(request, env))) return json({ error: "unauthorised" }, 401, { "WWW-Authenticate": "Bearer" });

        if (url.pathname === "/api/admin/sync") {
            if (request.method !== "POST") return json({ error: "use POST" }, 405);
            if (!(await capacitiesSyncEnabled(env))) return json({ error: SYNC_OFF_MESSAGE }, 409);
            const result = await guardedSync(env, "manual", url.searchParams.get("force") === "1");
            if (!result) return json({ error: "a sync is already running" }, 409);
            return json(result, result.status === "failed" ? 502 : 200);
        }

        if (url.pathname === "/api/admin/status") {
            const runs = await env.DB.prepare("SELECT * FROM sync_runs ORDER BY id DESC LIMIT 20").all();
            const errors = await env.DB.prepare("SELECT id, status, last_checked_at, last_error FROM sources WHERE last_error IS NOT NULL").all();
            const posts = await env.DB.prepare("SELECT slug, title, source, published_at, synced_at FROM posts ORDER BY published_at DESC").all();
            return json(
                { runs: runs.results.map((r) => ({ ...r, log: JSON.parse(String(r.log ?? "[]")) })), sourceErrors: errors.results, posts: posts.results },
                200,
            );
        }
    }

    return json({ error: "not found" }, 404);
}

/** Runs a sync unless another holds the lock. Returns null when skipped. */
export async function guardedSync(env: Env, trigger: "cron" | "manual", force: boolean): Promise<SyncSummary | null> {
    // Switched off (archived): return before taking the lock or touching sync_runs. runSync checks again.
    if (!(await capacitiesSyncEnabled(env))) return runSync(env, { trigger, force });
    const now = Date.now();
    const token = `${now}:${crypto.randomUUID()}`;
    // Atomic claim: the upsert only takes the lock when it is free or older than the lock window
    // (a crashed run), and RETURNING yields a row only when this invocation won it.
    const claimed = await env.DB.prepare(
        `INSERT INTO meta (key, value) VALUES ('sync_lock', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value
         WHERE meta.value = '' OR CAST(substr(meta.value, 1, instr(meta.value, ':') - 1) AS INTEGER) < ?2
         RETURNING value`,
    )
        .bind(token, now - SYNC_LOCK_MINUTES * 60_000)
        .first<{ value: string }>();
    if (claimed?.value !== token) {
        console.log(JSON.stringify({ event: "sync_skipped", reason: "already running", trigger }));
        return null;
    }
    try {
        await env.DB.prepare("UPDATE sync_runs SET status = 'failed', log = '[\"Run did not finish\"]' WHERE status = 'running'").run();
        return await runSync(env, { trigger, force });
    } finally {
        await env.DB.prepare("UPDATE meta SET value = '' WHERE key = 'sync_lock' AND value = ?").bind(token).run();
    }
}

const authorised = (request: Request, env: Env) => bearerMatches(request.headers.get("Authorization"), env.ADMIN_TOKEN);

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
