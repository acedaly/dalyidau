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
    // A code block wider than the page scrolls sideways, which a keyboard can only do once the block can take
    // focus. Article HTML is stored as it was published and never re-rendered, so this is done here, for every
    // article old and new (WCAG 2.1.1; axe: scrollable-region-focusable).
    const labelCodeBlocks = () => {
        for (const block of document.querySelectorAll<HTMLElement>("[data-article-body] pre, [data-page-body] pre, .article-body pre")) {
            if (block.hasAttribute("tabindex")) continue;
            block.tabIndex = 0;
            block.setAttribute("role", "region");
            block.setAttribute("aria-label", "Code sample");
        }
    };
    if (document.readyState === "complete") setTimeout(labelCodeBlocks);
    else window.addEventListener("load", () => setTimeout(labelCodeBlocks), { once: true });
}
