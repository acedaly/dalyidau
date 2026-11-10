// Phase 0: one Worker, two applications in the same isolate.
//
//   request ──► routeRequest (hosts.ts) ──► existing Worker (worker/index.ts, unchanged)
//                                      └──► Payload (Next.js through OpenNext)
//
// The existing Worker keeps its own authentication, role checks, audit log, signed links and rate
// limits: requests reach it exactly as they do today. Payload never sees a wedding-host request.

import { routeRequest, type HostConfig } from "./hosts";
import { handleBridge } from "./bridge";

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
}

const NOT_FOUND = () => new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" } });

const SECURITY_HEADERS: Record<string, string> = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Strict-Transport-Security": "max-age=31536000",
};

/** Payload's responses get the same baseline headers the existing Worker sets; the admin is never framed or indexed. */
function harden(response: Response, admin: boolean): Response {
    const out = new Response(response.body, response);
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) if (!out.headers.has(key)) out.headers.set(key, value);
    if (admin) {
        out.headers.set("X-Frame-Options", "DENY");
        out.headers.set("X-Robots-Tag", "noindex, nofollow");
        if (!out.headers.has("Cache-Control") || !/immutable/.test(out.headers.get("Cache-Control") ?? "")) out.headers.set("Cache-Control", "no-store");
    }
    return out;
}

/** The existing portal sign-in (worker/portal/auth.ts authenticate): verified Access JWT + an active portal role. */
export type Authenticate<E> = (request: Request, env: E) => Promise<{ ok: true } | { ok: false; status: 401 | 403 }>;

/** Payload's admin and API answer nobody without a portal identity, whatever Payload itself would render. */
const PAYLOAD_PRIVATE = (path: string) => path === "/admin" || path.startsWith("/admin/") || path.startsWith("/api/");

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
            if (target === "payload" && PAYLOAD_PRIVATE(url.pathname)) {
                const auth = await apps.authenticate(request, env);
                if (!auth.ok) {
                    return new Response(JSON.stringify({ error: auth.status === 401 ? "unauthenticated" : "forbidden" }), {
                        status: auth.status,
                        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" },
                    });
                }
            }
            if (target === "payload") return harden(await apps.payload.fetch(request, env, ctx), url.pathname.startsWith("/admin") || url.pathname.startsWith("/api/"));
            return apps.legacy.fetch(request, env, ctx);
        },

        async scheduled(controller: ScheduledController, env: E, ctx: ExecutionContext): Promise<void> {
            // Every existing job (wedding message queue, calendar, centre, assets, intelligence) runs exactly as today.
            await apps.legacy.scheduled?.(controller, env, ctx);
            // Payload's job queue, if it has one: run through its own route handler with a secret only this code knows.
            if (env.PAYLOAD_JOBS_SECRET) {
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
