// The article design system's markup: the blocks both publishers produce (capacities/render.ts and
// amplenote/markdown.ts), styled once in src/styles/article.css. Callers pass escaped HTML for
// `inner`/`caption` and plain strings for everything else, which is escaped here. Class names are
// part of the stored HTML of every published post, so existing ones never change meaning: archived
// Capacities posts are never re-rendered and rely on them as they are.
import { escapeHtml } from "./html";

export const CALLOUT_TONES = ["neutral", "info", "brand", "success", "warning", "danger"] as const;
export type CalloutTone = (typeof CALLOUT_TONES)[number];

/** A tinted box. The title row is optional (Capacities callouts have none). */
export const callout = (tone: CalloutTone, inner: string, title?: string | null) =>
    `<aside class="callout" data-tone="${tone}">${title ? `<p class="callout-title">${escapeHtml(title)}</p>` : ""}${inner}</aside>`;

/** A large, centred quotation that breaks up the text. `cite` is escaped HTML. */
export const pullQuote = (inner: string, cite?: string | null) =>
    `<figure class="pullquote"><blockquote>${inner}</blockquote>${cite ? `<figcaption>${cite}</figcaption>` : ""}</figure>`;

/** An ordinary quotation, with an optional attribution (escaped HTML). */
export const quote = (inner: string, cite?: string | null) =>
    cite ? `<figure class="quote"><blockquote>${inner}</blockquote><figcaption>${cite}</figcaption></figure>` : `<blockquote>${inner}</blockquote>`;

/** An image (already-built <img>) with an optional caption (escaped HTML). */
export const imageFigure = (img: string, caption?: string | null) =>
    `<figure class="image">${img}${caption ? `<figcaption>${caption}</figcaption>` : ""}</figure>`;

const hostOf = (url: string) => {
    try {
        return new URL(url).host.replace(/^www\./, "");
    } catch {
        return url;
    }
};

/** A card for a link that stands on its own line. `url` must already be a safe http(s) URL. */
export const linkCard = (url: string, title: string | null) =>
    `<p class="link-card"><a href="${escapeHtml(url)}" rel="noopener noreferrer" target="_blank"><span class="link-card-title">${escapeHtml(title || url)}</span><span class="link-card-host">${escapeHtml(hostOf(url))}</span></a></p>`;

/** A card linking to another article on this blog. */
export const postCard = (slug: string, title: string) =>
    `<p class="link-card"><a href="/blog/${escapeHtml(slug)}"><span class="link-card-title">${escapeHtml(title)}</span><span class="link-card-host">Also on this blog</span></a></p>`;

/** A table from cells that are already escaped HTML. */
export const table = (head: string[], body: string[][]) => {
    const row = (cells: string[], tag: "th" | "td") => cells.map((cell) => `<${tag}>${cell}</${tag}>`).join("");
    return `<div class="table-wrap"><table><thead><tr>${row(head, "th")}</tr></thead><tbody>${body.map((r) => `<tr>${row(r, "td")}</tr>`).join("")}</tbody></table></div>`;
};

/** A code block; `lang` is reduced to a safe token. */
export const codeBlock = (code: string, lang?: string | null) => {
    const safe = (lang || "").replace(/[^a-z0-9+#-]/gi, "").toLowerCase();
    return `<pre${safe ? ` data-lang="${safe}"` : ""}><code${safe ? ` class="language-${safe}"` : ""}>${escapeHtml(code)}</code></pre>`;
};
