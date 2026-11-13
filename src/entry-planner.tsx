// Browser entry for Wedding Planner (/portal/planner). Its own entry and
// HTML shell, so the app loads only what it uses.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PlannerApp } from "@/planner/planner-app";
import type { PlannerPageData } from "@/shared/planner/types";
import "@/styles/apps.css";

const payload = document.getElementById("page-data");

if (payload) {
    const { data } = JSON.parse(payload.textContent ?? "{}") as { data: PlannerPageData };
    createRoot(document.getElementById("root")!).render(
        <StrictMode>
            <PlannerApp data={data} />
        </StrictMode>,
    );

    // The service worker adds the offline page and keeps the app's static files; it never stores
    // pages or wedding data (worker/planner/pwa.ts). Best effort: the app works the same without it.
    if ("serviceWorker" in navigator && window.isSecureContext) {
        window.addEventListener("load", () => {
            navigator.serviceWorker.register(`${data.base}/sw.js`, { scope: data.base || "/" }).catch(() => undefined);
        });
    }
}
