// Phase 0, experiment 6: which hostname may reach which part of the combined Worker.
//
// Decided before anything else runs (the Worker runs first for every request, static files included),
// so a path that isn't on a host's list never reaches Payload, Next.js or a static file there.

export type Host = "site" | "wedding" | "planner" | "unknown";
export type Target = "legacy" | "payload" | "static" | "deny";

export interface HostConfig {
    SITE_URL: string;
    WEDDING_URL?: string;
    PLANNER_URL?: string;
}

const hostname = (value?: string) => (value ? new URL(value).hostname : null);

export function classifyHost(url: URL, config: HostConfig): Host {
    const site = hostname(config.SITE_URL);
    if (url.hostname === site || url.hostname === `www.${site}`) return "site";
    if (url.hostname === hostname(config.WEDDING_URL) && hostname(config.WEDDING_URL) !== site) return "wedding";
    if (url.hostname === hostname(config.PLANNER_URL)) return "planner";
    return "unknown";
}

/** Payload and Next.js own these on the site host only. Everything else stays with the existing Worker. */
const PAYLOAD_PREFIXES = ["/admin", "/_next/", "/cms", "/poc/"];

/**
 * Payload's REST API lives under /api/<collection>. These /api prefixes belong to the existing Worker
 * and always win, so no Payload collection may ever be named after one (checked in tests).
 */
export const LEGACY_API_PREFIXES = [
    "/api/portal/",
    "/api/wedding/",
    "/api/comms/",
    "/api/display/",
    "/api/admin/",
    "/api/amplenote/",
    "/api/integrations/",
    "/api/platform/",
];

/** Payload's REST API: /api/<collection>[/...] and /api/<global>... for the slugs Payload is configured with. */
export const PAYLOAD_API_SLUGS = ["users", "media", "pages", "projects", "posts", "payload-preferences", "payload-locked-documents", "payload-migrations", "payload-kv", "payload-jobs", "globals", "access"];

/** Static files the guest-facing hosts may load: the existing site's own build output, never Next.js or Payload's. */
const GUEST_STATIC = [/^\/assets\/[A-Za-z0-9._-]+$/, /^\/wedding\/[A-Za-z0-9._/-]+\.(?:jpg|jpeg|png|webp|svg|woff2)$/, /^\/(?:favicon\.(?:ico|svg)|apple-touch-icon\.png|theme-init\.js)$/, /^\/icons\/[A-Za-z0-9._-]+$/];

const startsWithAny = (path: string, prefixes: string[]) => prefixes.some((prefix) => path === prefix.replace(/\/$/, "") || path.startsWith(prefix));

/** Where a request goes. `static` means: the existing build's static file, served by the asset binding. */
export function routeRequest(url: URL, config: HostConfig): { host: Host; target: Target } {
    const host = classifyHost(url, config);
    const path = url.pathname;
    // Normalise before deciding: encoded slashes and dot segments never smuggle a path past the lists.
    if (/%2f|%5c|\\|\/\.\.?(?:\/|$)/i.test(path)) return { host, target: "deny" };

    if (host === "wedding" || host === "planner") {
        // The guest site and the phone app: the existing Worker's own narrow surface, plus its static files.
        // Next.js, Payload's admin, its API and its static files are simply not reachable here.
        if (GUEST_STATIC.some((pattern) => pattern.test(path))) return { host, target: "static" };
        if (path.startsWith("/_next") || path.startsWith("/admin") || path.startsWith("/cms") || path.startsWith("/poc")) return { host, target: "deny" };
        if (path.startsWith("/api/") && !(path.startsWith("/api/wedding/") || (host === "planner" && path.startsWith("/api/portal/")))) {
            return { host, target: "deny" };
        }
        return { host, target: "legacy" };
    }

    if (host === "site") {
        if (startsWithAny(path, LEGACY_API_PREFIXES)) return { host, target: "legacy" };
        if (path.startsWith("/api/")) {
            const slug = path.split("/")[2] ?? "";
            return { host, target: PAYLOAD_API_SLUGS.includes(slug) ? "payload" : "legacy" };
        }
        if (startsWithAny(path, PAYLOAD_PREFIXES)) return { host, target: "payload" };
        return { host, target: "legacy" };
    }

    // workers.dev, staging previews and anything else: the existing Worker decides (it treats unknown
    // hosts as the site host today), but Payload is never reachable on a host it wasn't configured for.
    return { host, target: startsWithAny(path, PAYLOAD_PREFIXES) ? "deny" : "legacy" };
}
