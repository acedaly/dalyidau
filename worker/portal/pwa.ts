// Wedding Planner as an installable app (docs/PORTAL.md#installing-wedding-planner): the web app
// manifest, the service worker and its offline page. All three are served from /portal, behind
// Cloudflare Access and the portal's own sign-in check, like every other portal address.
//
// The service worker never stores portal pages, API responses or media: pages always come from the
// network, and only when the network fails does it show the static offline page. It caches the
// offline page, its stylesheet and the app's hashed static files (/assets/*, the same for everyone).
// Its cache is named after the portal shell's version, so each deploy replaces it.
import { portalOfflineShell } from "../../src/portal/boot-shell";

export const MANIFEST_PATH = "/portal/manifest.webmanifest";
export const SERVICE_WORKER_PATH = "/portal/sw.js";
export const OFFLINE_PATH = "/portal/offline";
/** The installed app covers the whole portal, so Portal settings and the launcher open inside it too. */
export const APP_SCOPE = "/portal";
export const START_URL = "/portal/wedding";

const ICONS = [
    { src: "/icons/wedding-planner-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/icons/wedding-planner-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "/icons/wedding-planner-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    { src: "/icons/wedding-planner.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
];

const SHORTCUT_ICON = [{ src: "/icons/wedding-planner-192.png", sizes: "192x192", type: "image/png" }];

export const webAppManifest = () => ({
    id: START_URL,
    name: "Wedding Planner",
    short_name: "Wedding",
    description: "Guests, RSVPs, seating, budget, suppliers, tasks and the timeline for our wedding.",
    lang: "en-AU",
    dir: "ltr",
    start_url: START_URL,
    scope: APP_SCOPE,
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#ffffff",
    categories: ["lifestyle", "productivity"],
    icons: ICONS,
    shortcuts: [
        { name: "Guests", url: "/portal/wedding/guests", icons: SHORTCUT_ICON },
        { name: "RSVPs", url: "/portal/wedding/rsvps", icons: SHORTCUT_ICON },
        { name: "Seating", url: "/portal/wedding/seating", icons: SHORTCUT_ICON },
        { name: "Tasks", url: "/portal/wedding/tasks", icons: SHORTCUT_ICON },
    ],
});

/** The stylesheets the portal shell links to (hashed, from the Vite build). */
export const shellStylesheets = (shell: string) => [...shell.matchAll(/<link rel="stylesheet"[^>]*href="(\/assets\/[^"]+\.css)"/g)].map((match) => match[1]);

/**
 * The offline page: the portal shell without its scripts (it needs none, and holds no data), with
 * the theme script kept so dark mode still applies.
 */
export const offlineDocument = (shell: string, siteShortName: string) =>
    shell
        .replace(/\s*<script type="module"[^>]*><\/script>/g, "")
        .replace(/\s*<link rel="modulepreload"[^>]*>/g, "")
        .replace("<!--app-head-->", `<title>Offline · Wedding Planner</title>\n        <meta name="robots" content="noindex, nofollow">`)
        .replace("<!--app-html-->", portalOfflineShell(siteShortName))
        .replace("<!--app-data-->", "");

export const serviceWorkerScript = (version: string, shell: string) => {
    const precache = [OFFLINE_PATH, "/theme-init.js", ...shellStylesheets(shell), ...ICONS.map((icon) => icon.src)];
    return `// Wedding Planner service worker (worker/portal/pwa.ts). Version ${version}.
// Pages and data always come from the network; nothing personal is ever cached.
const CACHE = ${JSON.stringify(`wedding-planner-${version}`)};
const OFFLINE = ${JSON.stringify(OFFLINE_PATH)};
const PRECACHE = ${JSON.stringify(precache)};

self.addEventListener("install", (event) => {
    event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches
            .keys()
            .then((keys) => Promise.all(keys.filter((key) => key.startsWith("wedding-planner-") && key !== CACHE).map((key) => caches.delete(key))))
            .then(() => self.clients.claim()),
    );
});

self.addEventListener("fetch", (event) => {
    const request = event.request;
    if (request.method !== "GET") return;
    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;
    if (request.mode === "navigate") {
        // Network only. Cloudflare Access's sign-in redirect passes straight through.
        event.respondWith(fetch(request).catch(() => caches.match(OFFLINE).then((page) => page || Response.error())));
        return;
    }
    // Hashed build files never change, and the offline page's own files are precached.
    if (url.pathname.startsWith("/assets/") || PRECACHE.includes(url.pathname)) {
        event.respondWith(
            caches.match(request).then(
                (hit) =>
                    hit ||
                    fetch(request).then((response) => {
                        if (response.ok && url.pathname.startsWith("/assets/")) {
                            const copy = response.clone();
                            event.waitUntil(caches.open(CACHE).then((cache) => cache.put(request, copy)));
                        }
                        return response;
                    }),
            ),
        );
    }
    // Everything else (the API, media, uploads) goes to the network untouched.
});
`;
};
