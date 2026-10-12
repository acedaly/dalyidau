// Browser entry for /portal. A separate entry (and HTML shell) from the blog, so neither ships the
// other's code or CSS.
import { StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { PortalApp } from "@/portal/portal-app";
import type { PortalPageData } from "@/shared/portal/types";
import "@/styles/apps.css";

const payload = document.getElementById("page-data");

if (payload) {
    const { data, path } = JSON.parse(payload.textContent ?? "{}") as { data: PortalPageData; path: string };
    hydrateRoot(
        document.getElementById("root")!,
        <StrictMode>
            <PortalApp data={data} path={path} />
        </StrictMode>,
    );
}
