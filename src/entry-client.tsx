import { StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { App } from "@/app";
import type { PageData } from "@/shared/types";
import "@/styles/globals.css";

const payload = document.getElementById("page-data");

if (payload) {
    const { data, path } = JSON.parse(payload.textContent ?? "{}") as { data: PageData; path: string };
    // The article body is server-rendered only once; reuse it from the DOM rather than shipping it twice.
    if (data.route === "post") {
        data.post.bodyHtml = document.querySelector("[data-article-body]")?.innerHTML ?? "";
    }
    hydrateRoot(
        document.getElementById("root")!,
        <StrictMode>
            <App data={data} path={path} />
        </StrictMode>,
    );
}
