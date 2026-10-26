// Wedding Planner, the installable phone app (docs/PLANNER.md): its web app manifest, service
// worker and offline page. The app lives at the root of weddingplanner.daly.id.au and at
// /portal/planner on daly.id.au; `base` is that prefix ("" or "/portal/planner"). Every file here is
// served behind Cloudflare Access and the portal's own sign-in check.
//
// The service worker never stores pages, API responses or media: pages always come from the
// network, and only when the network fails does it show the static offline page. It caches the
// offline page, its stylesheet, the icons and the app's hashed static files (/assets/*, the same
// for everyone). Its cache is named after the app shell's version, so each deploy replaces it.
import { plannerOfflineMarkup } from "../../src/planner/shell-markup";
import { PLANNER_VIEWS, type PlannerView } from "../../src/shared/planner/types";

export const PLANNER_PATH = "/portal/planner";

export const plannerFiles = (base: string) => ({
    manifest: `${base}/manifest.webmanifest`,
    serviceWorker: `${base}/sw.js`,
    offline: `${base}/offline`,
    /** Where the service worker is allowed to work: the whole app. */
    scope: base || "/",
});

/** The view for an address inside the app ("/" → home), or null for anything else. */
export const plannerView = (rest: string): PlannerView | null => {
    if (rest === "" || rest === "/") return "home";
    const view = rest.slice(1);
    return view !== "home" && (PLANNER_VIEWS as readonly string[]).includes(view) ? (view as PlannerView) : null;
};

const ICONS = [
    { src: "/icons/wedding-planner-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/icons/wedding-planner-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "/icons/wedding-planner-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    { src: "/icons/wedding-planner.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
];

const SHORTCUT_ICON = [{ src: "/icons/wedding-planner-192.png", sizes: "192x192", type: "image/png" }];

export const plannerManifest = (base: string) => {
    const start = base || "/";
    return {
        id: start,
        name: "Wedding Planner",
        short_name: "Wedding",
        description: "Guests, RSVPs, tasks, budget, seating and the timeline for our wedding.",
        lang: "en-AU",
        dir: "ltr",
        start_url: start,
        scope: plannerFiles(base).scope,
        display: "standalone",
        background_color: "#ffffff",
        theme_color: "#ffffff",
        categories: ["lifestyle", "productivity"],
        icons: ICONS,
        shortcuts: [
            { name: "Guests", url: `${base}/guests`, icons: SHORTCUT_ICON },
            { name: "Tasks", url: `${base}/tasks`, icons: SHORTCUT_ICON },
            { name: "Budget", url: `${base}/budget`, icons: SHORTCUT_ICON },
        ],
    };
};

/** The stylesheets an app shell links to (hashed, from the Vite build). */
export const shellStylesheets = (shell: string) => [...shell.matchAll(/<link rel="stylesheet"[^>]*href="(\/assets\/[^"]+\.css)"/g)].map((match) => match[1]);

/** The offline page: the app shell without its scripts or data, with the theme script kept so dark mode still applies. */
export const offlineDocument = (shell: string, portalHome: string) =>
    shell
        .replace(/\s*<script type="module"[^>]*><\/script>/g, "")
        .replace(/\s*<link rel="modulepreload"[^>]*>/g, "")
        .replace("<!--app-head-->", `<title>Offline · Wedding Planner</title>\n        <meta name="robots" content="noindex, nofollow">`)
        .replace("<!--app-html-->", plannerOfflineMarkup(portalHome))
        .replace("<!--app-data-->", "");

export const serviceWorkerScript = (version: string, shell: string, base: string) => {
    const files = plannerFiles(base);
    const precache = [files.offline, "/theme-init.js", ...shellStylesheets(shell), ...ICONS.map((icon) => icon.src)];
    return `// Wedding Planner service worker (worker/planner/pwa.ts). Version ${version}.
// Pages and data always come from the network; nothing personal is ever cached.
const CACHE = ${JSON.stringify(`planner-${version}`)};
const OFFLINE = ${JSON.stringify(files.offline)};
const PRECACHE = ${JSON.stringify(precache)};

self.addEventListener("install", (event) => {
    event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches
            .keys()
            .then((keys) => Promise.all(keys.filter((key) => key.startsWith("planner-") && key !== CACHE).map((key) => caches.delete(key))))
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

/**
 * Replaces the service worker the first Wedding Planner release installed for the whole portal
 * (/portal/sw.js): browsers that still have it fetch this, which clears its cache and unregisters
 * it, so the portal goes back to being an ordinary website.
 */
export const RETIRED_PORTAL_WORKER = `// The portal is no longer installable; Wedding Planner is (worker/planner/pwa.ts). This retires the old worker.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches
            .keys()
            .then((keys) => Promise.all(keys.filter((key) => key.startsWith("wedding-planner-")).map((key) => caches.delete(key))))
            .then(() => self.registration.unregister()),
    );
});
`;
