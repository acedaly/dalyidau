// Renders the markdown the Amplenote plugin sends (note.content()) into article HTML. Like
// capacities/render.ts, every string is escaped and only a fixed set of tags is produced: raw HTML
// in the note (comments, <object> embeds, anything else) is dropped, never passed through.
import type { TocEntry } from "../../src/shared/types";
import { type CalloutTone, callout, codeBlock, imageFigure, linkCard, postCard, pullQuote, quote, table } from "../lib/article-html";
import { escapeHtml, isExternal, safeUrl, slugify } from "../lib/html";

export interface MarkdownContext {
    siteUrl: string;
    /** Local URL for an image already copied into R2, or null to leave the image out. */
    image: (url: string) => { src: string; width: number | null; height: number | null } | null;
    /** Slug of another published Amplenote article, for links between notes. */
    noteSlug: (uuid: string) => string | null;
}

export interface MarkdownResult {
    html: string;
    toc: TocEntry[];
    text: string;
    wordCount: number;
    /** Every image URL in the note, in order, for copying into R2 before rendering. */
    images: string[];
}

const NOTE_LINK = /^https:\/\/(?:www\.)?amplenote\.com\/notes\/([0-9a-f-]{36})(?:[?#].*)?$/i;

/** Lines that start a block other than a paragraph. */
const BLOCK_START = /^(?:#{1,6}\s|```|~~~|>|\s*(?:[-*+]|\d+[.)])\s|\|.*\||(?:-{3,}|\*{3,}|_{3,})\s*$)/;

interface ListItem {
    indent: number;
    ordered: boolean;
    task: "open" | "done" | null;
    text: string;
}

/** Raw HTML outside code: script and style elements with their content, comments (task metadata) and every other tag. */
const stripHtml = (text: string) =>
    text
        .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, "")
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/<\/?[a-z][^>\n]*>/gi, "");

/** Strips what never reaches the page (raw HTML, Amplenote's blank-line markers), leaving code exactly as written. */
export const cleanMarkdown = (markdown: string) => {
    const out: string[] = [];
    let prose: string[] = [];
    let fence: string | null = null;
    // Inline code spans keep their text; everything around them loses its HTML.
    const flush = () => {
        if (!prose.length) return;
        const text = prose
            .join("\n")
            .split(/(`+[^`\n]*?`+)/)
            .map((part, i) => (i % 2 ? part : stripHtml(part)))
            .join("");
        out.push(...text.split("\n").map((line) => (line.trim() === "\\" ? "" : line)));
        prose = [];
    };
    for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
        const marker = /^(```|~~~)/.exec(line)?.[1];
        if (fence) {
            out.push(line);
            if (marker === fence) fence = null;
        } else if (marker) {
            flush();
            fence = marker;
            out.push(line);
        } else prose.push(line);
    }
    flush();
    return out.join("\n");
};

/** Text that would start another block if it began a line, escaped so it stays a paragraph. */
const asParagraph = (text: string) => text.replace(/^(\s*)([-*+](?=\s)|>|#|\|)/, "$1\\$2").replace(/^(\s*\d+)([.)]\s)/, "$1\\$2");

/**
 * Text pasted into Amplenote often arrives with every paragraph as a heading (### …), which would
 * otherwise render as a page of bold sub-headings with no table of contents. When one heading level
 * holds most of the note's lines and reads like sentences, its lines are turned back into
 * paragraphs, except short ones that are entirely bold, which were the real headings: those become
 * section headings (##). Nothing changes for a note written normally. See docs/AMPLENOTE.md.
 */
export const normaliseHeadingWall = (lines: string[]): string[] => {
    const levels = new Map<number, string[]>();
    let other = 0;
    let fence: string | null = null;
    for (const line of lines) {
        const marker = /^(```|~~~)/.exec(line)?.[1];
        if (fence) {
            if (marker === fence) fence = null;
            continue;
        }
        if (marker) fence = marker;
        const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
        if (heading) levels.set(heading[1].length, [...(levels.get(heading[1].length) ?? []), heading[2]]);
        else if (line.trim() && line.trim() !== "\\") other++;
    }
    const wall = [...levels.entries()].find(([, texts]) => {
        if (texts.length < 8 || texts.length <= other * 2) return false;
        const sentences = texts.filter((t) => t.replace(/[*_]/g, "").trim().length > 60 || /[.!?,;:]["'”’)]?$/.test(t.replace(/[*_]+$/, "").trim()));
        return sentences.length * 2 >= texts.length;
    })?.[0];
    if (!wall) return lines;

    const out: string[] = [];
    fence = null;
    for (const line of lines) {
        const marker = /^(```|~~~)/.exec(line)?.[1];
        if (fence || marker) {
            if (fence && marker === fence) fence = null;
            else if (!fence) fence = marker!;
            out.push(line);
            continue;
        }
        const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
        if (!heading || heading[1].length !== wall) {
            out.push(line);
            continue;
        }
        const text = heading[2];
        const bold = /^(\*\*|__)([^*_].*?)\1$/.exec(text.trim());
        const inner = bold?.[2].trim() ?? "";
        if (bold && inner.length <= 90 && !/[.,;]$/.test(inner)) out.push(`${"#".repeat(Math.min(wall, 2))} ${text.trim()}`);
        else out.push(asParagraph(text), "");
    }
    return out;
};

/** Callout markers at the start of a quote: [!NOTE] (as GitHub and Obsidian write them), **Note:** or an emoji. */
const CALLOUT_KINDS: Record<string, { tone: CalloutTone; label: string }> = {
    note: { tone: "info", label: "Note" },
    info: { tone: "info", label: "Note" },
    tip: { tone: "success", label: "Tip" },
    success: { tone: "success", label: "Success" },
    important: { tone: "brand", label: "Important" },
    key: { tone: "brand", label: "Key point" },
    warning: { tone: "warning", label: "Warning" },
    caution: { tone: "danger", label: "Caution" },
    danger: { tone: "danger", label: "Caution" },
    callout: { tone: "neutral", label: "" },
    aside: { tone: "neutral", label: "" },
};
const CALLOUT_EMOJI: Record<string, CalloutTone> = {
    "💡": "success",
    ℹ️: "info",
    "📝": "info",
    "📌": "brand",
    "⭐": "brand",
    "⚠️": "warning",
    "❗": "danger",
    "🚨": "danger",
    "✅": "success",
};
const PULL_KINDS = new Set(["pullquote", "pull-quote", "pull"]);

type QuoteKind = { kind: "quote" } | { kind: "pull" } | { kind: "callout"; tone: CalloutTone; title: string | null };

/** Reads (and removes) a leading marker from a quote's lines. */
export const quoteKind = (lines: string[]): { kind: QuoteKind; lines: string[] } => {
    const first = lines.findIndex((line) => line.trim());
    if (first < 0) return { kind: { kind: "quote" }, lines };
    const line = lines[first].trim();
    const rest = (replacement: string) => {
        const copy = [...lines];
        if (replacement.trim()) copy[first] = replacement;
        else copy.splice(first, 1);
        return copy;
    };
    // Amplenote may escape the brackets: \[!NOTE\].
    const bracket = /^\\?\[!([a-z-]+)\\?\]\s*(.*)$/i.exec(line);
    if (bracket) {
        const name = bracket[1].toLowerCase();
        if (PULL_KINDS.has(name)) return { kind: { kind: "pull" }, lines: rest(bracket[2]) };
        const known = CALLOUT_KINDS[name];
        if (known) {
            // Text after the marker is the callout's title, as in Obsidian.
            const title = bracket[2].replace(/[*_]/g, "").trim() || known.label || null;
            return { kind: { kind: "callout", tone: known.tone, title }, lines: rest("") };
        }
    }
    const label = /^(\*\*|__)([a-z ]+?):?\1:?\s*(.*)$/i.exec(line);
    const named = label && CALLOUT_KINDS[label[2].trim().toLowerCase()];
    if (label && named && named.label) return { kind: { kind: "callout", tone: named.tone, title: label[2].trim() }, lines: rest(label[3]) };
    const emoji = Object.keys(CALLOUT_EMOJI).find((e) => line.startsWith(e));
    if (emoji) return { kind: { kind: "callout", tone: CALLOUT_EMOJI[emoji], title: null }, lines: rest(line.slice(emoji.length).trim()) };
    return { kind: { kind: "quote" }, lines };
};

/** A closing "— Name" line in a quote: its attribution. */
const attribution = (lines: string[]): { cite: string | null; lines: string[] } => {
    let last = lines.length - 1;
    while (last >= 0 && !lines[last].trim()) last--;
    if (last < 1) return { cite: null, lines };
    const match = /^(?:—|–|--|~)\s*(\S.*)$/.exec(lines[last].trim());
    return match ? { cite: match[1], lines: lines.slice(0, last) } : { cite: null, lines };
};

export const imageUrls = (markdown: string): string[] => {
    const urls: string[] = [];
    for (const match of cleanMarkdown(markdown).matchAll(/!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) urls.push(match[1]);
    return [...new Set(urls)];
};

export const renderMarkdown = (markdown: string, ctx: MarkdownContext): MarkdownResult => {
    const toc: TocEntry[] = [];
    const usedIds = new Set<string>();
    const textParts: string[] = [];
    const footnotes: string[] = [];
    const lines = normaliseHeadingWall(cleanMarkdown(markdown).split("\n"));

    const headingId = (text: string) => {
        const base = slugify(text) || "section";
        let id = base;
        for (let n = 2; usedIds.has(id); n++) id = `${base}-${n}`;
        usedIds.add(id);
        return id;
    };

    const link = (label: string, target: string) => {
        const note = NOTE_LINK.exec(target);
        if (note) {
            // Links to other notes work only when that note is itself published here; private notes stay private.
            const slug = ctx.noteSlug(note[1].toLowerCase());
            return slug ? `<a href="/blog/${escapeHtml(slug)}">${label}</a>` : label;
        }
        const href = safeUrl(target);
        if (!href) return label;
        const external = isExternal(href, ctx.siteUrl) && !href.startsWith("mailto:");
        return `<a href="${escapeHtml(href)}"${external ? ' rel="noopener noreferrer" target="_blank"' : ""}>${label}</a>`;
    };

    /** A paragraph that is only a link (a bare address or [text](address)) becomes a card. */
    const linkOnly = (source: string): { html: string; text: string } | null => {
        const match = /^\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)(?:\s+"[^"]*")?\)$/.exec(source) ?? /^<?(https?:\/\/[^\s<>]+)>?$/.exec(source);
        if (!match) return null;
        const [label, target] = match.length === 3 && match[2] !== undefined ? [plain(match[1]), match[2]] : [null, match[1]];
        const note = NOTE_LINK.exec(target);
        if (note) {
            const slug = ctx.noteSlug(note[1].toLowerCase());
            return slug && label ? { html: postCard(slug, label), text: label } : null;
        }
        const href = safeUrl(target);
        if (!href || !/^https?:/.test(href) || !isExternal(href, ctx.siteUrl)) return null;
        const title = label || href.replace(/^https?:\/\/(?:www\.)?/, "").replace(/\/$/, "");
        return { html: linkCard(href, title), text: title };
    };

    const image = (alt: string, url: string) => {
        const local = ctx.image(url);
        if (!local) return "";
        const dims = local.width && local.height ? ` width="${local.width}" height="${local.height}"` : "";
        return `<img src="${escapeHtml(local.src)}" alt="${escapeHtml(alt)}"${dims} loading="lazy" decoding="async">`;
    };

    const INLINE =
        /\\([\\`*_{}[\]()#+\-.!~=|>])|(`+)([\s\S]*?[^`])\2(?!`)|!\[([^\]]*)\]\(((?:[^()\s]|\([^()\s]*\))+)(?:\s+"[^"]*")?\)|\[([^\]]+)\]\[\^[^\]]+\]|\[\^[^\]]+\]|\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)(?:\s+"[^"]*")?\)|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|~~([\s\S]+?)~~|==([\s\S]+?)==|\*(?=\S)([\s\S]*?\S)\*|(?<![\p{L}\p{N}])_(?=\S)([\s\S]*?\S)_(?![\p{L}\p{N}])|<?(https?:\/\/[^\s<>]+[^\s<>.,;:!?)\]'"])>?/gu;

    /** Inline markdown to HTML. Text between the recognised patterns is escaped. */
    const inline = (source: string, inLink = false): string => {
        let html = "";
        let last = 0;
        for (const m of source.matchAll(INLINE)) {
            html += escapeHtml(source.slice(last, m.index));
            last = m.index + m[0].length;
            if (m[1] !== undefined) html += escapeHtml(m[1]);
            else if (m[2] !== undefined) html += `<code>${escapeHtml(m[3].replace(/^ (.+) $/, "$1"))}</code>`;
            else if (m[5] !== undefined) html += image(m[4].split("|")[0].trim(), m[5]);
            else if (m[6] !== undefined) html += inline(m[6], inLink);
            else if (m[0].startsWith("[^")) continue;
            // Links never nest: inside a link's text, another link is just its text.
            else if (m[8] !== undefined) html += inLink ? inline(m[7], true) : link(inline(m[7], true), m[8]);
            else if (m[9] !== undefined || m[10] !== undefined) html += `<strong>${inline(m[9] ?? m[10], inLink)}</strong>`;
            else if (m[11] !== undefined) html += `<s>${inline(m[11], inLink)}</s>`;
            else if (m[12] !== undefined) html += `<mark>${inline(m[12], inLink)}</mark>`;
            else if (m[13] !== undefined || m[14] !== undefined) html += `<em>${inline(m[13] ?? m[14], inLink)}</em>`;
            else if (m[15] !== undefined) html += inLink ? escapeHtml(m[0]) : link(escapeHtml(m[15]), m[15]);
        }
        return html + escapeHtml(source.slice(last));
    };

    /** The words a reader sees, for search, excerpts and reading time. */
    const plain = (source: string) =>
        source
            .replace(/!\[([^\]]*)\]\([^)]*\)/g, "")
            .replace(/\[\^[^\]]+\]/g, "")
            .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
            .replace(/[*_~=`\\]/g, "")
            .trim();

    const cells = (row: string) =>
        row
            .trim()
            .replace(/^\||\|$/g, "")
            .split(/(?<!\\)\|/)
            .map((cell) => cell.trim());

    const renderList = (items: ListItem[]): string => {
        let html = "";
        let i = 0;
        while (i < items.length) {
            const first = items[i];
            const group: { item: ListItem; children: ListItem[] }[] = [];
            while (i < items.length && items[i].indent === first.indent && items[i].ordered === first.ordered && !!items[i].task === !!first.task) {
                const item = items[i++];
                const children: ListItem[] = [];
                while (i < items.length && items[i].indent > first.indent) children.push(items[i++]);
                group.push({ item, children });
            }
            if (!group.length) {
                // A deeper item with no parent at this level: render it at this level.
                group.push({ item: items[i++], children: [] });
            }
            const tag = first.ordered ? "ol" : "ul";
            const body = group
                .map(({ item, children }) => {
                    textParts.push(plain(item.text));
                    const box = item.task
                        ? `<input type="checkbox" disabled${item.task === "done" ? " checked" : ""} aria-label="${item.task === "done" ? "Done" : "Not done"}"> `
                        : "";
                    return `<li>${box}${inline(item.text)}${children.length ? renderList(children) : ""}</li>`;
                })
                .join("");
            html += `<${tag}${first.task ? ' class="task-list"' : ""}>${body}</${tag}>`;
        }
        return html;
    };

    const blocks: string[] = [];
    for (let i = 0; i < lines.length;) {
        const line = lines[i];
        if (!line.trim()) {
            i++;
            continue;
        }

        const footnote = /^\[\^[^\]]+\]:\s*(.*)$/.exec(line);
        if (footnote) {
            if (footnote[1].trim()) {
                footnotes.push(inline(footnote[1]));
                textParts.push(plain(footnote[1]));
            }
            i++;
            continue;
        }

        const fence = /^(```|~~~)\s*([\w+#-]*)/.exec(line);
        if (fence) {
            const code: string[] = [];
            i++;
            while (i < lines.length && !lines[i].startsWith(fence[1])) code.push(lines[i++]);
            i++;
            const lang = fence[2];
            textParts.push(code.join("\n"));
            blocks.push(codeBlock(code.join("\n"), lang));
            continue;
        }

        const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
        if (heading) {
            i++;
            const text = plain(heading[2]);
            if (!text) continue;
            // The page title is the only <h1>: note headings start at <h2>.
            const level = Math.min(6, heading[1].length + 1);
            const id = headingId(text);
            textParts.push(text);
            if (level === 2 || level === 3) toc.push({ id, text, level });
            blocks.push(`<h${level} id="${id}">${inline(heading[2])}</h${level}>`);
            continue;
        }

        if (/^(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
            blocks.push("<hr>");
            i++;
            continue;
        }

        if (line.startsWith(">")) {
            const quoted: string[] = [];
            while (i < lines.length && lines[i].startsWith(">")) quoted.push(lines[i++].replace(/^>\s?/, ""));
            const { kind, lines: content } = quoteKind(quoted);
            const { cite, lines: body } = kind.kind === "callout" ? { cite: null, lines: content } : attribution(content);
            const inner = renderMarkdown(body.join("\n"), ctx);
            if (!inner.html && kind.kind !== "callout") continue;
            textParts.push(inner.text);
            if (cite) textParts.push(plain(cite));
            const citeHtml = cite ? inline(cite) : null;
            if (kind.kind === "callout") {
                if (kind.title) textParts.push(kind.title);
                blocks.push(callout(kind.tone, inner.html, kind.title));
            } else blocks.push(kind.kind === "pull" ? pullQuote(inner.html, citeHtml) : quote(inner.html, citeHtml));
            continue;
        }

        if (/^\s*\|.*\|\s*$/.test(line)) {
            const rows: string[] = [];
            while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
            const parsed = rows.map(cells);
            const separator = parsed[1]?.every((cell) => /^:?-{1,}:?$/.test(cell));
            const [head, ...body] = separator ? [parsed[0], ...parsed.slice(2)] : parsed;
            for (const row of [head, ...body]) textParts.push(row.map(plain).join(" "));
            blocks.push(
                table(
                    head.map((cell) => inline(cell)),
                    body.map((r) => r.map((cell) => inline(cell))),
                ),
            );
            continue;
        }

        if (/^\s*(?:[-*+]|\d+[.)])\s/.test(line)) {
            const items: ListItem[] = [];
            while (i < lines.length) {
                const item = /^(\s*)(?:([-*+])|(\d+)[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/.exec(lines[i]);
                if (item) {
                    items.push({
                        indent: item[1].replace(/\t/g, "    ").length,
                        ordered: !!item[3],
                        task: item[4] === undefined ? null : item[4] === " " ? "open" : "done",
                        text: item[5],
                    });
                    i++;
                } else if (lines[i].trim() && /^\s+/.test(lines[i]) && items.length) {
                    // A wrapped continuation of the previous item.
                    items[items.length - 1].text += ` ${lines[i++].trim()}`;
                } else break;
            }
            blocks.push(renderList(items));
            continue;
        }

        const paragraph: string[] = [];
        while (i < lines.length && lines[i].trim() && (paragraph.length === 0 || !BLOCK_START.test(lines[i]))) paragraph.push(lines[i++]);
        const source = paragraph.join("\n");
        const lone = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)$/.exec(source.trim());
        if (lone) {
            const img = image(lone[1].split("|")[0].trim(), lone[2]);
            // A caption: an image title ("…"), or a line in italics directly below the image.
            let caption = lone[3]?.trim() || null;
            let next = i;
            while (next < lines.length && !lines[next].trim()) next++;
            const italic = next < lines.length ? /^(\*|_)(?!\1)(\S(?:.*\S)?)\1$/.exec(lines[next].trim()) : null;
            if (img && italic && (next + 1 >= lines.length || !lines[next + 1].trim())) {
                caption = italic[2];
                i = next + 1;
            }
            if (img) {
                if (caption) textParts.push(plain(caption));
                blocks.push(imageFigure(img, caption ? inline(caption) : null));
            }
            continue;
        }
        const card = linkOnly(source.trim());
        if (card) {
            blocks.push(card.html);
            textParts.push(card.text);
            continue;
        }
        const text = plain(source);
        if (!text && !/!\[/.test(source)) continue;
        textParts.push(text);
        // A trailing backslash or two trailing spaces is a line break, as in Amplenote.
        const html = source
            .split("\n")
            .map((part, index, all) => inline(part.replace(/(?:\\| {2,})$/, "")) + (index < all.length - 1 ? (/(?:\\| {2,})$/.test(part) ? "<br>" : " ") : ""))
            .join("");
        if (html.trim()) blocks.push(`<p>${html}</p>`);
    }

    if (footnotes.length)
        blocks.push(`<section class="footnotes" aria-label="Notes"><ol>${footnotes.map((note) => `<li>${note}</li>`).join("")}</ol></section>`);

    const text = textParts
        .filter(Boolean)
        .join("\n")
        .replace(/[ \t]+/g, " ")
        .trim();
    return { html: blocks.join(""), toc, text, wordCount: text ? text.split(/\s+/).filter(Boolean).length : 0, images: imageUrls(markdown) };
};
