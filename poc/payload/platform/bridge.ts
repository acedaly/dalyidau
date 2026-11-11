// Phase 0, experiment 2: the page data a wedding screen needs, for screens rendered inside Payload's admin.
//
// It is the existing portal page loader, called with the existing sign-in and role checks and the same
// credential redaction as the server-rendered portal (worker/index.ts portalPage). Nothing is reimplemented.

import type { Env } from "../../../worker/env";
import { loadAdminPage } from "../../../worker/portal/admin-page";

const HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: HEADERS });

export async function handleBridge(request: Request, env: Env, url: URL): Promise<Response> {
    if (url.pathname !== "/api/platform/wedding-page") return json({ error: "not_found" }, 404);
    if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
    const result = await loadAdminPage(request, env, url.searchParams.get("path") ?? "");
    if (!result.ok) return json({ error: result.error }, result.status);
    const styles = await portalStyles(env);
    return json({ title: result.title, status: result.status, data: result.data, styles, shadowDefaults: await shadowDefaults(env, styles) }, result.status);
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
