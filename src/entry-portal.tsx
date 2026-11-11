// The stylesheet for the wedding and administration screens shown inside Payload's admin
// (poc/payload/platform/bridge.ts reads its hashed file name from shell-portal.html). The portal itself is
// retired (Phase 3): /portal pages redirect to Payload, so this entry ships no application code.
import "@/styles/apps.css";

// Browsers that still have the old portal's or Wedding Planner's service worker unregister it.
if ("serviceWorker" in navigator) {
    void navigator.serviceWorker
        .getRegistrations()
        .then((registrations) => Promise.all(registrations.filter((r) => /^\/portal(\/|$)/.test(new URL(r.scope).pathname)).map((r) => r.unregister())))
        .catch(() => undefined);
}
