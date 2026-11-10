// Phase 0, experiment 2: the page data a wedding screen needs, for screens rendered inside Payload's admin.
//
// It is the existing portal page loader, called with the existing sign-in and role checks and the same
// credential redaction as the server-rendered portal (worker/index.ts portalPage). Nothing is reimplemented.

import type { PortalPageData } from "../../../src/shared/portal/types";
import type { Env } from "../../../worker/env";
import { authenticate, can } from "../../../worker/portal/auth";
import { loadFlags } from "../../../worker/portal/flags";
import { loadPortalPage } from "../../../worker/portal/pages";
import { CREDENTIAL_PERMISSION, hideCredentials } from "../../../worker/portal/redact";
import { getSettings } from "../../../worker/portal/settings";

const HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: HEADERS });

/** Only wedding screens are offered to Payload (message pages are /portal/wedding/communications/msg_…). */
const WEDDING_PAGE = /^\/portal\/wedding(?:\/[a-z0-9_-]+){0,3}$/;

export async function handleBridge(request: Request, env: Env, url: URL): Promise<Response> {
    if (url.pathname !== "/api/platform/wedding-page") return json({ error: "not_found" }, 404);
    if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
    const auth = await authenticate(request, env);
    // As portalApi: the reason is logged by authenticate, never returned.
    if (!auth.ok) return json({ error: auth.status === 401 ? "unauthenticated" : "forbidden" }, auth.status);
    const path = url.searchParams.get("path") ?? "";
    if (!WEDDING_PAGE.test(path)) return json({ error: "not_found" }, 404);
    const pageUrl = new URL(path, url.origin);
    const [flags, wedding] = await Promise.all([loadFlags(env.DB), getSettings(env.DB, "wedding")]);
    const result = await loadPortalPage(path, pageUrl, env, auth.user, flags);
    const pageData = can(auth.user, CREDENTIAL_PERMISSION) ? result.data : hideCredentials(result.data);
    const data = { ...pageData, context: { user: auth.user, flags, wedding, environment: env.ENVIRONMENT } } as PortalPageData;
    const styles = await portalStyles(env);
    return json({ title: result.title, status: result.status, data, styles, shadowDefaults: await shadowDefaults(env, styles) }, result.status);
}

/** The portal's built stylesheet(s), read from its own HTML shell so hashed file names always match the deploy. */
async function portalStyles(env: Env): Promise<string[]> {
    const shell = await env.ASSETS.fetch("https://assets.local/shell-portal.html");
    if (!shell.ok) return [];
    const html = await shell.text();
    return [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="(\/assets\/[A-Za-z0-9._-]+\.css)"/g)].map((m) => m[1]);
}

/**
 * Tailwind v4 gives its --tw-* variables their starting values with @property, which browsers ignore inside
 * a shadow root; without them every ring and shadow utility computes to nothing. Tailwind ships the same
 * values as a fallback for older browsers; the wedding view applies that fallback inside its shadow root.
 */
async function shadowDefaults(env: Env, styles: string[]): Promise<string> {
    const blocks: string[] = [];
    for (const href of styles) {
        const css = await (await env.ASSETS.fetch(`https://assets.local${href}`)).text();
        const match = /@layer properties\{@supports [^{]+\{\*,:before,:after,::backdrop\{([^}]*)\}/.exec(css);
        if (match) blocks.push(match[1]);
    }
    return blocks.length ? `@layer properties{*,:before,:after,::backdrop{${blocks.join(";")}}}` : "";
}
