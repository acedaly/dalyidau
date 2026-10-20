import type { ExecutionContext, ScheduledController } from "@cloudflare/workers-types";
import { site } from "../src/content/site";
import { render, renderWedding } from "../src/entry-server";
import { portalBootShell } from "../src/portal/boot-shell";
import { applicationById, canAccessApplication } from "../src/shared/portal/applications";
import { SAVE_THE_DATE_CALENDAR_PATH, icsFilename } from "../src/shared/portal/calendar";
import { SETTINGS_REDIRECTS } from "../src/shared/portal/settings-sections";
import type { GuestInvitationPageData, PortalPageData, SaveTheDatePageData, WeddingPageData } from "../src/shared/portal/types";
import type { BlogFilters, PageData, PageRoute } from "../src/shared/types";
import { processAssetReminders } from "./assets/notify";
import { serveFeed } from "./calendar/feeds";
import { processCalendarNotifications } from "./calendar/notify";
import { processDueSubscriptions } from "./calendar/subscriptions";
import { runCentreCron } from "./centre/ingest";
import { DisplayRefused, authenticateDisplay, wallboardPayload } from "./centre/wallboard";
import { handleCommsWebhook } from "./comms/webhooks";
import type { Env } from "./env";
import { runIntelligenceCron } from "./intelligence/runner";
import { withSecurityHeaders } from "./lib/headers";
import { escapeHtml, jsonForScript } from "./lib/html";
import { loggablePath } from "./lib/log";
import { handlePortalApi } from "./portal/api";
import { type AuthResult, authenticate, can } from "./portal/auth";
import { processDueMessages } from "./portal/comms";
import { loadFlags } from "./portal/flags";
import { json as apiJson, checkMutation, errorResponse, readJson } from "./portal/http";
import { loadPortalPage } from "./portal/pages";
import { CREDENTIAL_PERMISSION, hideCredentials } from "./portal/redact";
import { getSettings } from "./portal/settings";
import { PostStore } from "./posts";
import { buildHead, robotsTxt, rssXml, sitemapXml } from "./seo";
import { type SyncSummary, runSync } from "./sync";
import { processTaskReminders } from "./tasks/notify";
import { guestInvitationPage, guestInvitationPdf, saveTheDateAvailable, saveTheDateCalendar, saveTheDatePage } from "./wedding/guest-pages";
import { weddingOrigin } from "./wedding/invitations";
import { serveMedia } from "./wedding/media";
import { RsvpError, allow, lookupRsvp, submitRsvp } from "./wedding/rsvp";
import { loadWeddingPage, weddingTitle } from "./wedding/site";

const HTML_EDGE_TTL = 300;
/** Edge-cached HTML is keyed on the content version, so it can live much longer than the browser cache. */
const PAGE_CACHE_TTL = 86_400;
const SYNC_LOCK_MINUTES = 15;

// The MCP gateway (mcp.daly.id.au) reaches Tasks and Knowledge through this, over a service binding only.
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

    async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
        ctx.waitUntil(guardedSync(env, "cron", false).then(() => undefined));
        ctx.waitUntil(processDueMessages(env).then(() => undefined));
        // Task reminders: a failure here never affects the other jobs (or anyone completing tasks).
        ctx.waitUntil(
            processTaskReminders(env).then(
                () => undefined,
                (error) => console.error(JSON.stringify({ event: "task_reminders_error", message: (error as Error).message })),
            ),
        );
        // Daly Calendar: subscription refreshes, then reminders and notices. Each failure stays contained.
        ctx.waitUntil(
            processDueSubscriptions(env)
                .catch((error) => console.error(JSON.stringify({ event: "calendar_subscriptions_error", message: (error as Error).message })))
                .then(() => processCalendarNotifications(env))
                .then(
                    () => undefined,
                    (error) => console.error(JSON.stringify({ event: "calendar_notifications_error", message: (error as Error).message })),
                ),
        );
        // Intelligence Centre: retention always; collecting public sources only with its switch on.
        ctx.waitUntil(
            runCentreCron(env).then(
                () => undefined,
                (error) => console.error(JSON.stringify({ event: "centre_cron_error", message: (error as Error).message })),
            ),
        );
        // Home & Assets: reminders (email only with its switch on), automatic Tasks people asked for, and purging deleted assets.
        ctx.waitUntil(
            processAssetReminders(env, { scheduledTime: controller.scheduledTime }).then(
                () => undefined,
                (error) => console.error(JSON.stringify({ event: "asset_reminders_error", message: (error as Error).message })),
            ),
        );
        // Daly Intelligence: retention always; jobs, briefings and the semantic index only when switched on.
        ctx.waitUntil(
            runIntelligenceCron(env).then(
                () => undefined,
                (error) => console.error(JSON.stringify({ event: "intelligence_cron_error", message: (error as Error).message })),
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

    const path = url.pathname;

    // Keep old invitations working, including their signed query credential. Media stays in place
    // for authenticated portal previews and previously cached pages.
    if (weddingHasOwnHost && url.hostname === siteUrl.hostname && (path === "/wedding" || path === "/wedding/rsvp")) {
        const target = path === "/wedding" ? "/" : "/rsvp";
        // The query can be a signed invitation link: never cache the redirect or pass the URL on.
        return new Response(null, {
            status: 301,
            headers: { Location: `${weddingUrl.origin}${target}${url.search}`, ...PRIVATE_HEADERS, "Referrer-Policy": "no-referrer" },
        });
    }

    if (path.startsWith("/api/portal/")) return portalApi(request, env, ctx);
    // Private calendar feeds for Apple Calendar, Outlook and Google Calendar: a token in the path,
    // outside Cloudflare Access (calendar apps can't sign in). See worker/calendar/feeds.ts.
    const feed = /^\/calendar\/feed\/([A-Za-z0-9_-]{1,64})\.ics$/.exec(path);
    if (feed)
        return request.method === "GET" || request.method === "HEAD"
            ? serveFeed(env, feed[1])
            : new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    if (path.startsWith("/api/wedding/")) return weddingApi(request, env, url);
    // Wallboard displays: a display credential, not Cloudflare Access (worker/centre/wallboard.ts).
    if (path === "/api/display/wallboard") return displayApi(request, env);
    if (path === "/display") return displayPage(request, env, path);
    if (path.startsWith("/api/comms/webhooks/")) return handleCommsWebhook(request, env, url);
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

    // The portal and the wedding site are never edge-cached: one is private, the other changes as
    // the couple edits it.
    if (path === "/portal" || path.startsWith("/portal/")) return portalPage(request, env, url);
    const photo = /^\/wedding\/media\/([^/]+)$/.exec(path);
    if (photo) return weddingPhoto(request, env, photo[1]);
    if (path === "/wedding" || path.startsWith("/wedding/")) return weddingPage(request, env, url, indexable);

    const publicFlags = await loadFlags(env.DB);
    const weddingPublished = publicFlags["wedding.site.public"];
    return cachedPage(request, env, ctx, indexable, weddingPublished ? "wedding-public" : "wedding-private", async () => {
        const result = await route(path, url, store);
        if ("redirect" in result) return Response.redirect(`${url.origin}${result.redirect}`, 301);
        return renderPage(env, { ...result.data, context: { weddingPublished } }, path, result.status, !indexable);
    });
}

type RouteResult = { data: PageRoute; status: number } | { redirect: string };

async function route(path: string, url: URL, store: PostStore): Promise<RouteResult> {
    if (path === "/") return { data: { route: "home", latest: await store.latest(3) }, status: 200 };
    if (path === "/about") return { data: { route: "about" }, status: 200 };
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

type Area = "site" | "portal" | "wedding" | "display";

const SHELL_FILES: Record<Area, string> = { site: "shell.html", portal: "shell-portal.html", wedding: "shell-wedding.html", display: "shell-display.html" };
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
    return new Response(html, { status: input.status, headers: { "Content-Type": "text/html; charset=utf-8", ...input.headers } });
}

async function renderPage(env: Env, data: PageData, path: string, status: number, noindex: boolean): Promise<Response> {
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
        },
    });
}

const PRIVATE_HEADERS = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };

// --- Portal ---------------------------------------------------------------------------------------

async function portalPage(request: Request, env: Env, url: URL): Promise<Response> {
    const auth = await authenticate(request, env);
    if (!auth.ok) return accessDenied(auth);
    const path = url.pathname;
    // Old settings addresses. Checked after sign-in, so a redirect reveals nothing to strangers.
    const moved = Object.hasOwn(SETTINGS_REDIRECTS, path) ? SETTINGS_REDIRECTS[path] : null;
    if (moved) {
        const response = Response.redirect(`${url.origin}${moved}`, 302);
        const redirected = new Response(response.body, response);
        for (const [key, value] of Object.entries(PRIVATE_HEADERS)) redirected.headers.set(key, value);
        return redirected;
    }
    const preview = /^\/portal\/wedding\/website\/preview(\/rsvp)?$/.exec(path);
    if (preview) {
        const application = applicationById("wedding");
        if (!application || !canAccessApplication(auth.user, application)) {
            return new Response("Not found", { status: 404, headers: PRIVATE_HEADERS });
        }
        const data = await loadWeddingPage(env.DB, preview[1] ? "rsvp" : "home", true);
        return renderWeddingDocument(env, data, path, 200, true, PRIVATE_HEADERS);
    }

    const [flags, wedding] = await Promise.all([loadFlags(env.DB), getSettings(env.DB, "wedding")]);
    const result = await loadPortalPage(path, url, env, auth.user, flags);
    // Viewers never receive RSVP codes or signed links, in page data any more than from the API.
    const pageData = can(auth.user, CREDENTIAL_PERMISSION) ? result.data : hideCredentials(result.data);
    const data: PortalPageData = { ...pageData, context: { user: auth.user, flags, wedding, environment: env.ENVIRONMENT } };
    return renderDocument(env, {
        area: "portal",
        head: [`<title>${escapeHtml(result.title)} · Portal · ${escapeHtml(site.name)}</title>`, `<meta name="robots" content="noindex, nofollow">`].join(
            "\n        ",
        ),
        body: portalBootShell(result.title),
        data,
        path,
        status: result.status,
        headers: PRIVATE_HEADERS,
    });
}

async function portalApi(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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
    return handlePortalApi(request, env, auth.user, ctx);
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

// --- Wallboard displays ---------------------------------------------------------------------------

const DISPLAY_HEADERS = { ...PRIVATE_HEADERS, "Referrer-Policy": "no-referrer" };

/** The display's page: a static shell. The credential stays in the URL fragment, which never reaches the Worker. */
async function displayPage(request: Request, env: Env, path: string): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    if (!(await loadFlags(env.DB))["intelligence_centre.wallboard"]) return new Response("Not found", { status: 404, headers: DISPLAY_HEADERS });
    return renderDocument(env, {
        area: "display",
        head: [`<title>Wallboard · ${escapeHtml(site.name)}</title>`, `<meta name="robots" content="noindex, nofollow">`].join("\n        "),
        body: "",
        data: null,
        path,
        status: 200,
        headers: DISPLAY_HEADERS,
    });
}

async function displayApi(request: Request, env: Env): Promise<Response> {
    if (request.method !== "GET") return apiJson({ error: "method_not_allowed" }, 405);
    try {
        checkCrossSiteDisplay(request);
        const { board, owner } = await authenticateDisplay(env, request);
        return apiJson({ wallboard: await wallboardPayload(env, board, owner) }, 200, { "Referrer-Policy": "no-referrer" });
    } catch (error) {
        // Every refusal looks the same: an unknown, revoked or expired credential, or the switch off.
        if (error instanceof DisplayRefused) return apiJson({ error: error.status === 429 ? "rate_limited" : "not_found" }, error.status);
        return errorResponse(error, "/api/display/wallboard");
    }
}

/** Display data is only for the display page itself (same origin), never another site. */
const checkCrossSiteDisplay = (request: Request) => {
    const fetchSite = request.headers.get("Sec-Fetch-Site");
    if (fetchSite === "cross-site" || fetchSite === "same-site") throw new DisplayRefused(404);
};

// --- Wedding website ------------------------------------------------------------------------------

async function weddingPage(request: Request, env: Env, url: URL, indexable: boolean): Promise<Response> {
    const guest = GUEST_PATHS.has(url.pathname.slice("/wedding".length)) ? url.pathname.slice("/wedding".length) : null;
    if (guest) return guestPage(request, env, url, guest);
    const route = url.pathname === "/wedding" ? "home" : url.pathname === "/wedding/rsvp" ? "rsvp" : null;
    const flags = await loadFlags(env.DB);
    // Until the couple publishes it, /wedding is indistinguishable from any other missing page.
    if (!route || !flags["wedding.site.public"])
        return renderPage(env, { route: "not-found", path: url.pathname, context: { weddingPublished: false } }, url.pathname, 404, true);
    const data = { ...(await loadWeddingPage(env.DB, route, false)), legacyPaths: true };
    const noindex = data.content.noindex || !indexable || route === "rsvp";
    return renderWeddingDocument(env, data, url.pathname, 200, noindex, weddingPageHeaders(route, noindex));
}

async function weddingHost(request: Request, env: Env, url: URL, canonical: URL): Promise<Response> {
    const path = url.pathname;
    if (path.startsWith("/api/wedding/")) return weddingApi(request, env, url);
    if (path.startsWith("/portal") || path.startsWith("/api/portal/") || path.startsWith("/api/admin/") || path.startsWith("/api/comms/")) {
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
            ...(data.preview ? [] : [`<link rel="canonical" href="${escapeHtml(`${site}${path}`)}">`]),
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

/** Website photos are public once the site is; before that, only signed-in portal users (the preview) see them. */
async function weddingPhoto(request: Request, env: Env, file: string): Promise<Response> {
    const flags = await loadFlags(env.DB);
    if (!flags["wedding.site.public"]) {
        const auth = await authenticate(request, env);
        if (!auth.ok) return new Response("Not found", { status: 404, headers: PRIVATE_HEADERS });
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
    const params = new URLSearchParams(url.search);
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

/** Runs a sync unless another holds the lock. Returns null when skipped. */
export async function guardedSync(env: Env, trigger: "cron" | "manual", force: boolean): Promise<SyncSummary | null> {
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
