import type { TocEntry } from "../../src/shared/types";
import { escapeHtml, isExternal, safeUrl, slugify } from "../lib/html";
import type { Block, GroupBlock, ListType, TextBlock, Token } from "./types";

/** What an embedded Capacities object resolves to. Anything unresolved is dropped from public output. */
export type Embed =
    | { kind: "image"; src: string; srcSet?: string; alt: string; caption: string | null; width: number | null; height: number | null }
    | { kind: "link"; url: string; title: string | null }
    | { kind: "video"; embedUrl: string; url: string; title: string | null }
    | { kind: "post"; slug: string; title: string }
    | { kind: "table"; rows: string[][] };

export interface RenderContext {
    siteUrl: string;
    /** Slug of a published blog post, or null. Links to anything else render as plain text. */
    postSlug(entityId: string): string | null;
    embed(entityId: string): Embed | null;
}

export interface RenderResult {
    html: string;
    toc: TocEntry[];
    text: string;
    wordCount: number;
    /** Block types we could not render, for the sync log. */
    skipped: string[];
}

/** Collects every object id a body references, so the sync can resolve them before rendering. */
export const collectReferences = (blocks: Block[]) => {
    const embeds = new Set<string>();
    const links = new Set<string>();
    const visitTokens = (tokens: Token[]) => {
        for (const token of tokens) if (token.type === "LinkToken" && token.entityId) links.add(token.entityId);
    };
    const visit = (list: Block[]) => {
        for (const block of list) {
            switch (block.type) {
                case "TextBlock":
                    visitTokens(block.tokens ?? []);
                    visit(block.blocks ?? []);
                    break;
                case "GroupBlock":
                    visit(block.blocks ?? []);
                    break;
                case "GridBlock":
                    for (const column of block.columns ?? []) visit(column);
                    break;
                case "EntityBlock":
                    if (block.entityId) embeds.add(block.entityId);
                    break;
            }
        }
    };
    visit(blocks);
    return { embeds: [...embeds], links: [...links] };
};

const CALLOUT_TONES: Record<string, string> = {
    gray: "neutral",
    blue: "info",
    sky: "info",
    cyan: "info",
    indigo: "info",
    violet: "brand",
    purple: "brand",
    fuchsia: "brand",
    green: "success",
    emerald: "success",
    teal: "success",
    lime: "success",
    yellow: "warning",
    amber: "warning",
    orange: "warning",
    red: "danger",
    rose: "danger",
    pink: "danger",
};

const calloutTone = (colorTheme: string | undefined) => {
    if (!colorTheme?.startsWith("bg-")) return null;
    return CALLOUT_TONES[colorTheme.slice(3)] ?? "neutral";
};

const headingLevel = (block: TextBlock): number | null => {
    const { key, val } = block.hierarchy ?? { key: "Base", val: 0 };
    if (!/^H\d$/.test(key) || val < 1) return null;
    // The article title is the page's h1, so Capacities H1 becomes h2, and so on.
    return Math.min(6, val + 1);
};

type ListFamily = "ul" | "ol" | "todo";

const listFamily = (block: Block): { family: ListFamily; type?: ListType } | null => {
    if (block.type !== "TextBlock" && block.type !== "GroupBlock") return null;
    if (block.type === "TextBlock" && headingLevel(block)) return null;
    if (block.todo) return { family: "todo" };
    if (!block.list) return null;
    return { family: block.list.type === "bullet" ? "ul" : "ol", type: block.list.type };
};

const OL_TYPES: Record<string, string> = { alphabetical: ' type="a"', roman: ' type="i"', numerical: "" };

export const renderBlocks = (blocks: Block[], ctx: RenderContext): RenderResult => {
    const toc: TocEntry[] = [];
    const usedIds = new Set<string>();
    const textParts: string[] = [];
    const skipped: string[] = [];

    const plain = (tokens: Token[]) => tokens.map((token) => token.text ?? "").join("");

    const inline = (tokens: Token[]): string =>
        tokens
            .map((token) => {
                const text = token.text ?? "";
                switch (token.type) {
                    case "CodeToken":
                        return `<code>${escapeHtml(text)}</code>`;
                    case "MathToken":
                        return `<code class="math">${escapeHtml(text)}</code>`;
                    case "LinkToken": {
                        if (token.entityId) {
                            const slug = ctx.postSlug(token.entityId);
                            return slug ? `<a href="/blog/${escapeHtml(slug)}">${escapeHtml(text)}</a>` : escapeHtml(text);
                        }
                        const href = safeUrl(token.url);
                        if (!href) return escapeHtml(text);
                        const external = isExternal(href, ctx.siteUrl) && !href.startsWith("mailto:");
                        return `<a href="${escapeHtml(href)}"${external ? ' rel="noopener noreferrer" target="_blank"' : ""}>${escapeHtml(text || href)}</a>`;
                    }
                    default: {
                        let html = escapeHtml(text);
                        const style = token.style ?? {};
                        if (style.bold) html = `<strong>${html}</strong>`;
                        if (style.italic) html = `<em>${html}</em>`;
                        if (style.strikethrough) html = `<s>${html}</s>`;
                        if (style.underline) html = `<u>${html}</u>`;
                        if (token.color?.startsWith("bg-")) html = `<mark>${html}</mark>`;
                        return html;
                    }
                }
            })
            .join("");

    const headingId = (text: string) => {
        const base = slugify(text) || "section";
        let id = base;
        for (let n = 2; usedIds.has(id); n++) id = `${base}-${n}`;
        usedIds.add(id);
        return id;
    };

    const renderEmbed = (entityId: string | null): string => {
        if (!entityId) return "";
        const embed = ctx.embed(entityId);
        if (!embed) return "";
        switch (embed.kind) {
            case "image": {
                const dims = embed.width && embed.height ? ` width="${embed.width}" height="${embed.height}"` : "";
                const srcSet = embed.srcSet ? ` srcset="${escapeHtml(embed.srcSet)}" sizes="(min-width: 768px) 720px, 100vw"` : "";
                const caption = embed.caption ? `<figcaption>${escapeHtml(embed.caption)}</figcaption>` : "";
                if (embed.caption) textParts.push(embed.caption);
                return `<figure class="image"><img src="${escapeHtml(embed.src)}"${srcSet} alt="${escapeHtml(embed.alt)}"${dims} loading="lazy" decoding="async">${caption}</figure>`;
            }
            case "video":
                return `<figure class="video"><div class="video-frame"><iframe src="${escapeHtml(embed.embedUrl)}" title="${escapeHtml(embed.title ?? "Embedded video")}" loading="lazy" allow="accelerometer; encrypted-media; gyroscope; picture-in-picture; fullscreen" referrerpolicy="strict-origin-when-cross-origin"></iframe></div><figcaption><a href="${escapeHtml(embed.url)}" rel="noopener noreferrer" target="_blank">${escapeHtml(embed.title ?? embed.url)}</a></figcaption></figure>`;
            case "link": {
                const host = new URL(embed.url).host.replace(/^www\./, "");
                return `<p class="link-card"><a href="${escapeHtml(embed.url)}" rel="noopener noreferrer" target="_blank"><span class="link-card-title">${escapeHtml(embed.title ?? embed.url)}</span><span class="link-card-host">${escapeHtml(host)}</span></a></p>`;
            }
            case "post":
                return `<p class="link-card"><a href="/blog/${escapeHtml(embed.slug)}"><span class="link-card-title">${escapeHtml(embed.title)}</span><span class="link-card-host">Also on this blog</span></a></p>`;
            case "table": {
                if (!embed.rows.length) return "";
                const [head, ...body] = embed.rows;
                for (const row of embed.rows) textParts.push(row.join(" "));
                const cells = (row: string[], tag: "th" | "td") => row.map((cell) => `<${tag}>${escapeHtml(cell)}</${tag}>`).join("");
                return `<div class="table-wrap"><table><thead><tr>${cells(head, "th")}</tr></thead><tbody>${body.map((row) => `<tr>${cells(row, "td")}</tr>`).join("")}</tbody></table></div>`;
            }
        }
    };

    const renderListItem = (block: TextBlock | GroupBlock): string => {
        const checkbox = block.todo
            ? `<input type="checkbox" disabled${block.todo.isDone ? " checked" : ""} aria-label="${block.todo.isDone ? "Done" : "Not done"}"> `
            : "";
        if (block.type === "GroupBlock") return `<li>${checkbox}${renderList(block.blocks ?? [])}</li>`;
        textParts.push(plain(block.tokens ?? []));
        const children = block.blocks?.length ? renderList(block.blocks) : "";
        return `<li>${checkbox}${inline(block.tokens ?? [])}${children}</li>`;
    };

    const renderTextBlock = (block: TextBlock): string => {
        const tokens = block.tokens ?? [];
        const text = plain(tokens);
        const level = headingLevel(block);
        const children = block.blocks?.length ? `<div class="indent">${renderList(block.blocks)}</div>` : "";

        if (level) {
            if (!text.trim()) return children;
            const id = headingId(text);
            textParts.push(text);
            if (level === 2 || level === 3) toc.push({ id, text: text.trim(), level });
            return `<h${level} id="${id}">${inline(tokens)}</h${level}>${children}`;
        }

        if (block.toggle) {
            textParts.push(text);
            return `<details${block.toggle.isOpen ? " open" : ""}><summary>${inline(tokens)}</summary>${block.blocks?.length ? renderList(block.blocks) : ""}</details>`;
        }

        if (!text.trim() && !children) return "";
        textParts.push(text);
        const paragraph = text.trim() ? `<p>${inline(tokens)}</p>` : "";
        const tone = calloutTone(block.colorTheme);
        if (tone) return `<aside class="callout" data-tone="${tone}">${paragraph}${children}</aside>`;
        return paragraph + children;
    };

    function renderList(list: Block[]): string {
        let html = "";
        for (let i = 0; i < list.length; i++) {
            const block = list[i];
            const family = listFamily(block);

            if (family) {
                const items: (TextBlock | GroupBlock)[] = [];
                while (i < list.length) {
                    const next = listFamily(list[i]);
                    if (!next || next.family !== family.family || next.type !== family.type) break;
                    items.push(list[i] as TextBlock | GroupBlock);
                    i++;
                }
                i--;
                const body = items.map(renderListItem).join("");
                if (family.family === "todo") html += `<ul class="task-list">${body}</ul>`;
                else if (family.family === "ul") html += `<ul>${body}</ul>`;
                else html += `<ol${OL_TYPES[family.type ?? "numerical"] ?? ""}>${body}</ol>`;
                continue;
            }

            if (block.type === "TextBlock" && block.quote && !headingLevel(block)) {
                const layout = block.quote.layout;
                const quotes: TextBlock[] = [];
                while (i < list.length) {
                    const next = list[i];
                    if (next.type !== "TextBlock" || !next.quote || next.quote.layout !== layout || headingLevel(next)) break;
                    quotes.push(next);
                    i++;
                }
                i--;
                const inner = quotes.map(renderTextBlock).join("");
                if (!inner) continue;
                html += layout === "standout" ? `<figure class="pullquote"><blockquote>${inner}</blockquote></figure>` : `<blockquote>${inner}</blockquote>`;
                continue;
            }

            switch (block.type) {
                case "TextBlock":
                    html += renderTextBlock(block);
                    break;
                case "GroupBlock": {
                    const inner = renderList(block.blocks ?? []);
                    const tone = calloutTone(block.colorTheme);
                    html += tone ? `<aside class="callout" data-tone="${tone}">${inner}</aside>` : inner;
                    break;
                }
                case "GridBlock": {
                    const columns = (block.columns ?? []).map((column) => `<div>${renderList(column)}</div>`).join("");
                    html += `<div class="columns" style="--columns:${Math.max(1, block.columns?.length ?? 1)}">${columns}</div>`;
                    break;
                }
                case "CodeBlock": {
                    const lang = (block.lang || "").replace(/[^a-z0-9+#-]/gi, "").toLowerCase();
                    textParts.push(block.text);
                    html += `<pre${lang ? ` data-lang="${lang}"` : ""}><code${lang ? ` class="language-${lang}"` : ""}>${escapeHtml(block.text ?? "")}</code></pre>`;
                    break;
                }
                case "MathBlock":
                    html += `<pre class="math"><code>${escapeHtml(block.text ?? "")}</code></pre>`;
                    break;
                case "HorizontalLineBlock":
                    html += "<hr>";
                    break;
                case "EntityBlock":
                    html += renderEmbed(block.entityId);
                    break;
                default:
                    skipped.push((block as { blockType?: string; type: string }).blockType ?? (block as { type: string }).type);
            }
        }
        return html;
    }

    const html = renderList(blocks);
    const text = textParts
        .join("\n")
        .replace(/[ \t]+/g, " ")
        .trim();
    const wordCount = text ? text.split(/\s+/).filter(Boolean).length : 0;
    return { html, toc, text, wordCount, skipped };
};

/** Parses the first GitHub-style pipe table out of a Markdown export (used for Capacities simple tables). */
export const parseMarkdownTable = (markdown: string): string[][] => {
    const lines = markdown.split(/\r?\n/);
    const rows: string[][] = [];
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("|")) {
            if (rows.length) break;
            continue;
        }
        const cells = trimmed
            .replace(/^\||\|$/g, "")
            .split(/(?<!\\)\|/)
            .map((cell) => cell.trim().replace(/\\\|/g, "|"));
        if (cells.every((cell) => /^:?-+:?$/.test(cell))) continue;
        rows.push(cells.map(stripInlineMarkdown));
    }
    return rows;
};

const stripInlineMarkdown = (value: string) =>
    value
        .replace(/\[\[([^\]]+)\]\]/g, "$1")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/(\*\*|__|\*|_|`|~~)/g, "")
        .replace(/<[^>]+>/g, "");
