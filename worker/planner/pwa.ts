// Wedding Planner, the installable phone app, is retired (Phase 3: Payload at daly.id.au/admin is the only
// administration; docs/PLANNER.md). What's left: the service worker served at the old apps' addresses
// (/portal/sw.js, /portal/planner/sw.js and weddingplanner.daly.id.au/sw.js), so a phone that still has
// one installed clears its cache and unregisters it the next time the browser checks for an update.

export const PLANNER_PATH = "/portal/planner";

export const RETIRED_APP_WORKER = `// The portal and Wedding Planner apps are retired; Payload at daly.id.au/admin is the admin now.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches
            .keys()
            .then((keys) => Promise.all(keys.filter((key) => /^(wedding-)?planner-/.test(key)).map((key) => caches.delete(key))))
            .then(() => self.registration.unregister())
            .then(() => self.clients.matchAll({ type: "window" }))
            .then((clients) => Promise.all(clients.map((client) => client.navigate(client.url).catch(() => undefined)))),
    );
});
`;
