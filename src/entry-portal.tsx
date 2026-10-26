// Browser entry for /portal. A separate entry (and HTML shell) from the blog, so neither ships the
// other's code or CSS.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PortalApp } from "@/portal/portal-app";
import type { PortalPageData } from "@/shared/portal/types";
import "@/styles/apps.css";

const payload = document.getElementById("page-data");

if (payload) {
    const { data, path } = JSON.parse(payload.textContent ?? "{}") as { data: PortalPageData; path: string };
    // The server sends only a loading shell (src/portal/boot-shell.ts), so this renders rather than hydrates.
    createRoot(document.getElementById("root")!).render(
        <StrictMode>
            <PortalApp data={data} path={path} />
        </StrictMode>,
    );
}

// The first Wedding Planner release made the whole portal installable, with a service worker for
// /portal. Wedding Planner is now its own app (/portal/planner, weddingplanner.daly.id.au), so that
// worker is removed here; /portal/sw.js also retires it on its own (worker/planner/pwa.ts).
if ("serviceWorker" in navigator) {
    void navigator.serviceWorker
        .getRegistrations()
        .then((registrations) => Promise.all(registrations.filter((r) => new URL(r.scope).pathname === "/portal").map((r) => r.unregister())))
        .catch(() => undefined);
}
