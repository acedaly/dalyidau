// Browser entry for the public wedding website (/wedding) and its portal preview.
import { StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import type { WeddingPageData } from "@/shared/portal/types";
import "@/styles/apps.css";
import { WeddingApp } from "@/wedding/wedding-app";

const payload = document.getElementById("page-data");

if (payload) {
    const { data, path } = JSON.parse(payload.textContent ?? "{}") as { data: WeddingPageData; path: string };
    hydrateRoot(
        document.getElementById("root")!,
        <StrictMode>
            <WeddingApp data={data} path={path} />
        </StrictMode>,
    );
}
