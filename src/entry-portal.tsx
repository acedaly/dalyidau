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
