// Phase 0: one Worker, two applications in the same isolate.
//
//   request ──► routeRequest (hosts.ts) ──► existing Worker (worker/index.ts, unchanged)
//                                      └──► Payload (Next.js through OpenNext)
//
// The existing Worker keeps its own authentication, role checks, audit log, signed links and rate
// limits: requests reach it exactly as they do today. Payload never sees a wedding-host request.

import { routeRequest, type HostConfig } from "./hosts";
import { handleBridge } from "./bridge";
import { recordSiteDrift } from "../../../worker/site/sync-check";

export interface FetchWorker<E> {
    fetch(request: Request, env: E, ctx: ExecutionContext): Promise<Response> | Response;
}
export interface ScheduledWorker<E> {
    scheduled?(controller: ScheduledController, env: E, ctx: ExecutionContext): Promise<void> | void;
}

export interface PlatformEnv extends HostConfig {
    ASSETS: Fetcher;
    /** Shared secret for Payload's job runner route, called only from `scheduled` below (never from outside). */
    PAYLOAD_JOBS_SECRET?: string;
    /** Payload's own database. Read here only to see whether its job queue has anything due, and for the sync check. */
    D1?: D1Database;
    /** The site's database (the existing Worker's). */
    DB?: D1Database;
}

/**
 * Whether Payload's queue has a job that's due, read straight from its table so an ordinary cron run never
 * starts Payload (starting it from cold costs ~3 s of CPU). Payload's own scheduler (`schedule` on a task)
 * is therefore not used: recurring work stays in the existing cron. Any doubt (no table yet, a D1 error)
 * means "nothing due", and the next run tries again.
 */
export async function payloadHasDueJobs(db: D1Database | undefined, now = new Date()): Promise<boolean> {
    if (!db) return false;
    try {
        const row = await db
            .prepare(
                `SELECT 1 AS due FROM payload_jobs
                 WHERE completed_at IS NULL AND COALESCE(has_error, 0) = 0 AND COALESCE(processing, 0) = 0
                   AND (wait_until IS NULL OR wait_until <= ?1)
                 LIMIT 1`,
            )
            .bind(now.toISOString())
            .first<{ due: number }>();
        return Boolean(row);
    } catch (error) {
        console.log(JSON.stringify({ event: "payload_jobs_check_failed", message: (error as Error).message }));
        return false;
    }
}

const NOT_FOUND = () => new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" } });

const SECURITY_HEADERS: Record<string, string> = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Strict-Transport-Security": "max-age=31536000",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), interest-cohort=(), browsing-topics=()",
    "Cross-Origin-Opener-Policy": "same-origin",
};

/**
 * Payload's API answers with JSON or, under /api/media/file/, an uploaded file. None of it is a page, so
 * if a browser is ever made to open one as a document (an upload that slipped past the type check, a JSON
 * body sniffed as HTML) it runs nothing: no scripts, no plugins, no framing, its own sandboxed origin.
 * The admin's pages keep their own nonce-based policy (src/middleware.ts).
 */
export const API_CSP = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; sandbox";

/** Payload's responses get the same baseline headers the existing Worker sets; the admin is never framed or indexed. */
export function harden(response: Response, admin: boolean, api = false): Response {
    const out = new Response(response.body, response);
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) if (!out.headers.has(key)) out.headers.set(key, value);
    if (api) out.headers.set("Content-Security-Policy", API_CSP);
    if (admin) {
        out.headers.set("X-Frame-Options", "DENY");
        out.headers.set("X-Robots-Tag", "noindex, nofollow");
        if (!out.headers.has("Cache-Control") || !/immutable/.test(out.headers.get("Cache-Control") ?? "")) out.headers.set("Cache-Control", "no-store");
    }
    return out;
}

/**
 * Cross-site write protection for Payload, the same rule /api/portal applies (worker/portal/http.ts).
 * Access's cookie identifies the person on every request, so without this a page on another site could
 * submit a form (Payload accepts multipart bodies) that publishes or deletes as them. A browser always
 * labels a write with its Origin and, today, Sec-Fetch-Site; either one pointing elsewhere is refused.
 * A request with neither isn't from a browser page (scripts, the CI checks) and still needs the Access
 * sign-in like everything else here.
 */
export function crossSiteWrite(request: Request, siteUrl: string): boolean {
    if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") return false;
    const site = request.headers.get("Sec-Fetch-Site");
    if (site && site !== "same-origin" && site !== "none") return true;
    const origin = request.headers.get("Origin");
    if (origin === null) return false;
    const allowed = new Set([new URL(request.url).origin, new URL(siteUrl).origin]);
    return !allowed.has(origin);
}

/** The existing portal sign-in (worker/portal/auth.ts authenticate): verified Access JWT + an active portal role. */
export type Authenticate<E> = (request: Request, env: E) => Promise<{ ok: true } | { ok: false; status: 401 | 403 }>;

/** Payload's admin and API answer nobody without a portal identity, whatever Payload itself would render. */
const PAYLOAD_PRIVATE = (path: string) => path === "/admin" || path.startsWith("/admin/") || path.startsWith("/api/");

/**
 * Never reachable from outside, whoever asks:
 * - Payload's own sign-in routes. Cloudflare Access is the only sign-in, and Payload must not mint its own session.
 * - Payload's internal collections. The job runner is called only by `scheduled` below, straight into Payload.
 */
export const PAYLOAD_BLOCKED = /^\/api\/(?:users\/(?:login|logout|refresh-token|forgot-password|reset-password|first-register|unlock|verify|init)(?:\/|$)|payload-(?:jobs|migrations|kv|locked-documents)(?:\/|$))/;

/**
 * Identity comes only from the Access JWT, checked on every request. Payload's own credentials (its
 * `payload-token` cookie, `Authorization: JWT …` or API-key headers) are removed on the way in, and any
 * `payload-token` cookie Payload tries to set is dropped on the way out. That way, a cookie left in a shared
 * browser can never make Payload act as someone other than the person Access just verified.
 */
export function withoutPayloadCredentials(request: Request): Request {
    const headers = new Headers(request.headers);
    headers.delete("Authorization");
    const cookie = headers.get("Cookie");
    if (cookie !== null) {
        const kept = cookie
            .split(";")
            .map((part) => part.trim())
            .filter((part) => part && !/^payload-token=/i.test(part));
        if (kept.length) headers.set("Cookie", kept.join("; "));
        else headers.delete("Cookie");
    }
    return new Request(request, { headers });
}

function withoutPayloadSession(response: Response): Response {
    const cookies = response.headers.getSetCookie?.() ?? [];
    if (!cookies.some((c) => /^payload-token=/i.test(c))) return response;
    const out = new Response(response.body, response);
    out.headers.delete("Set-Cookie");
    for (const c of cookies) if (!/^payload-token=/i.test(c)) out.headers.append("Set-Cookie", c);
    return out;
}

export function createPlatformWorker<E extends PlatformEnv>(apps: {
    legacy: FetchWorker<E> & ScheduledWorker<E>;
    payload: FetchWorker<E>;
    authenticate: Authenticate<E>;
}) {
    return {
        async fetch(request: Request, env: E, ctx: ExecutionContext): Promise<Response> {
            const url = new URL(request.url);
            const { host, target } = routeRequest(url, env);
            if (target === "deny") return NOT_FOUND();
            const readOnly = request.method === "GET" || request.method === "HEAD";

            if (target === "static") {
                const file = readOnly ? await env.ASSETS.fetch(new Request(url, { method: request.method, headers: request.headers })) : null;
                return file && file.status < 400 ? file : NOT_FOUND();
            }

            // On the site host, static files are served first, as the asset layer does today.
            if (host === "site" && readOnly && /\.[a-z0-9]{2,5}$/i.test(url.pathname) && !url.pathname.startsWith("/api/")) {
                const file = await env.ASSETS.fetch(new Request(url, { method: request.method, headers: request.headers }));
                if (file.status < 400) return file;
            }

            if (url.pathname.startsWith("/api/platform/")) return handleBridge(request, env as never, url);
            if (target === "payload" && PAYLOAD_BLOCKED.test(url.pathname)) return NOT_FOUND();
            if (target === "payload" && PAYLOAD_PRIVATE(url.pathname)) {
                const auth = await apps.authenticate(request, env);
                if (!auth.ok) {
                    return new Response(JSON.stringify({ error: auth.status === 401 ? "unauthenticated" : "forbidden" }), {
                        status: auth.status,
                        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" },
                    });
                }
            }
            if (target === "payload") {
                if (crossSiteWrite(request, env.SITE_URL)) {
                    return new Response(JSON.stringify({ error: "cross_site", message: "Cross-site request refused" }), {
                        status: 403,
                        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" },
                    });
                }
                const response = await apps.payload.fetch(withoutPayloadCredentials(request), env, ctx);
                const api = url.pathname.startsWith("/api/");
                return harden(withoutPayloadSession(response), url.pathname.startsWith("/admin") || api, api);
            }
            return apps.legacy.fetch(request, env, ctx);
        },

        async scheduled(controller: ScheduledController, env: E, ctx: ExecutionContext): Promise<void> {
            // Every existing job (wedding message queue, calendar, centre, assets, intelligence) runs exactly as today.
            await apps.legacy.scheduled?.(controller, env, ctx);
            // Does the public site show what Payload says is published? A few small reads of both databases,
            // without starting Payload; the result is kept for the admin's dashboard and a mismatch is logged
            // as an error (worker/site/sync-check.ts).
            if (env.D1 && env.DB) ctx.waitUntil(recordSiteDrift(env.D1 as never, env.DB as never));
            // Payload's job queue, only when something is due: run through its own route handler with a secret
            // only this code knows. Otherwise Payload isn't touched, so it costs this invocation nothing.
            if (env.PAYLOAD_JOBS_SECRET && (await payloadHasDueJobs(env.D1))) {
                const request = new Request(`${new URL(env.SITE_URL).origin}/api/payload-jobs/run`, {
                    method: "GET",
                    headers: { Authorization: `Bearer ${env.PAYLOAD_JOBS_SECRET}` },
                });
                ctx.waitUntil(
                    Promise.resolve(apps.payload.fetch(request, env, ctx)).then(
                        async (response) => console.log(JSON.stringify({ event: "payload_jobs_run", status: response.status })),
                        (error) => console.error(JSON.stringify({ event: "payload_jobs_error", message: (error as Error).message })),
                    ),
                );
            }
        },
    };
}
