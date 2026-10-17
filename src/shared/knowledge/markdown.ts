// Markdown from the stored document format (daly.doc.v1), for exports. Portable rather than
// lossless: the JSON export keeps the exact document. Every piece of text is escaped, links keep
// only safe hrefs, and nothing is ever emitted as HTML, so an exported note can't carry markup that
// a Markdown viewer would run.
import { type DocMark, type DocNode, isSafeHref } from "./content";
import type { PropertyDef, PropertyValues } from "./properties";

export interface MarkdownOptions {
    /** How a link to another object is written. Defaults to a wiki link, [[Title]]. */
    objectLink?: (id: string, label: string) => string;
}

/** Escapes characters Markdown would otherwise treat as inline formatting, links, HTML or entities. */
export const escapeMarkdown = (text: string) => text.replace(/[\\`*_[\]<>|~&]/g, (c) => `\\${c}`);

/** Escapes what would start a heading, quote, list or rule at the beginning of a line. */
const escapeLineStart = (line: string) =>
    line
        .replace(/^(\s*)(#{1,6}(?=\s|$)|>|[-+](?=\s|$)|={3,}|-{3,})/, "$1\\$2")
        .replace(/^(\s*\d{1,9})([.)])(?=\s|$)/, "$1\\$2");

/** Escapes a wiki-link label: brackets and the alias bar can't appear inside [[…]]. */
const wikiLabel = (label: string) => label.replace(/[[\]|]/g, " ").replace(/\s+/g, " ").trim() || "Untitled";

const defaultObjectLink = (_id: string, label: string) => `[[${wikiLabel(label)}]]`;

const fence = (code: string) => {
    const longest = Math.max(2, ...(code.match(/`+/g) ?? []).map((run) => run.length));
    return "`".repeat(longest + 1);
};

const inlineCode = (text: string) => {
    const ticks = "`".repeat(Math.max(1, ...(text.match(/`+/g) ?? []).map((run) => run.length + 1)));
    const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
    return `${ticks}${pad}${text}${pad}${ticks}`;
};

const wrap = (text: string, marks: DocMark[] | undefined) => {
    if (!marks?.length) return escapeMarkdown(text);
    const code = marks.some((m) => m.type === "code");
    let out = code ? inlineCode(text) : escapeMarkdown(text);
    for (const mark of marks) {
        if (mark.type === "bold") out = `**${out}**`;
        else if (mark.type === "italic") out = `*${out}*`;
        else if (mark.type === "strike") out = `~~${out}~~`;
        // Underline has no Markdown form; HTML is never emitted, so it's left as plain text.
    }
    const link = marks.find((m) => m.type === "link");
    const href = link?.attrs?.href;
    if (isSafeHref(href)) out = `[${out}](<${href.replace(/[<>\s]/g, encodeURIComponent)}>)`;
    return out;
};

const inline = (nodes: DocNode[] | undefined, options: Required<MarkdownOptions>): string =>
    (nodes ?? [])
        .map((node) => {
            if (node.type === "text") return wrap(node.text ?? "", node.marks);
            if (node.type === "hardBreak") return "\\\n";
            if (node.type === "objectLink") return options.objectLink(String(node.attrs?.id ?? ""), String(node.attrs?.label ?? ""));
            return "";
        })
        .join("");

const indent = (text: string, prefix: string) =>
    text
        .split("\n")
        .map((line, i) => (i === 0 ? line : line ? `${prefix}${line}` : line))
        .join("\n");

/** Table cells become one line each: block structure inside a cell has no Markdown form. */
const cell = (node: DocNode, options: Required<MarkdownOptions>) =>
    (node.content ?? [])
        .map((child) => block(child, options))
        .join(" ")
        .replace(/\n+/g, " ")
        // Text is already escaped; a pipe that isn't (inside inline code) would still end the cell.
        .replace(/(?<!\\)\|/g, "\\|")
        .trim();

function block(node: DocNode, options: Required<MarkdownOptions>): string {
    const children = node.content ?? [];
    switch (node.type) {
        case "paragraph":
            return inline(children, options).split("\n").map(escapeLineStart).join("\n");
        case "heading":
            return `${"#".repeat(Number(node.attrs?.level ?? 1))} ${inline(children, options)}`;
        case "blockquote":
            return blocks(children, options)
                .split("\n")
                .map((line) => (line ? `> ${line}` : ">"))
                .join("\n");
        case "bulletList":
            return children.map((item) => `- ${indent(blocks(item.content ?? [], options), "  ")}`).join("\n");
        case "orderedList": {
            const start = Number(node.attrs?.start ?? 1);
            return children
                .map((item, i) => {
                    const marker = `${start + i}. `;
                    return `${marker}${indent(blocks(item.content ?? [], options), " ".repeat(marker.length))}`;
                })
                .join("\n");
        }
        case "taskList":
            return children.map((item) => `- [${item.attrs?.checked ? "x" : " "}] ${indent(blocks(item.content ?? [], options), "  ")}`).join("\n");
        case "codeBlock": {
            const code = children.map((c) => c.text ?? "").join("");
            const marks = fence(code);
            const language = typeof node.attrs?.language === "string" ? node.attrs.language : "";
            return `${marks}${language}\n${code}\n${marks}`;
        }
        case "horizontalRule":
            return "---";
        case "table": {
            const rows = children.map((row) => (row.content ?? []).map((c) => cell(c, options)));
            if (!rows.length) return "";
            const width = Math.max(...rows.map((r) => r.length));
            const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, i) => cells[i] ?? "").join(" | ")} |`;
            return [line(rows[0]), `|${" --- |".repeat(width)}`, ...rows.slice(1).map(line)].join("\n");
        }
        default:
            return blocks(children, options);
    }
}

const blocks = (nodes: DocNode[], options: Required<MarkdownOptions>) =>
    nodes
        .map((n) => block(n, options))
        .filter((text, i, all) => text !== "" || i < all.length - 1)
        .join("\n\n");

export const documentToMarkdown = (doc: DocNode, options: MarkdownOptions = {}) =>
    blocks(doc.content ?? [], { objectLink: options.objectLink ?? defaultObjectLink }).trim();

/** A YAML scalar: JSON strings, numbers and booleans are valid YAML, and quoting makes every string safe. */
const yaml = (value: unknown) => JSON.stringify(value);

export interface MarkdownObject {
    id: string;
    title: string;
    typeName: string;
    tags: string[];
    status: string;
    dailyDate: string | null;
    createdAt: string;
    updatedAt: string;
    properties: PropertyValues;
    content: DocNode;
}

/**
 * One object as a Markdown file: YAML front matter (id, type, tags, dates, properties), the title as
 * a heading, then the document. Reference properties hold object ids, which `referenceLabel` turns
 * into titles where it can.
 */
export function objectToMarkdown(
    object: MarkdownObject,
    defs: readonly PropertyDef[],
    options: MarkdownOptions & { referenceLabel?: (id: string) => string | undefined } = {},
) {
    const front: string[] = [
        `id: ${yaml(object.id)}`,
        `title: ${yaml(object.title || "Untitled")}`,
        `type: ${yaml(object.typeName)}`,
        `status: ${yaml(object.status)}`,
        ...(object.dailyDate ? [`daily_date: ${yaml(object.dailyDate)}`] : []),
        `created: ${yaml(object.createdAt)}`,
        `updated: ${yaml(object.updatedAt)}`,
        `tags: [${object.tags.map(yaml).join(", ")}]`,
    ];
    const keys = Object.keys(object.properties);
    if (keys.length) {
        front.push("properties:");
        for (const key of keys) {
            const def = defs.find((d) => d.key === key);
            const value = object.properties[key];
            const shown =
                def && (def.type === "select" || def.type === "multi_select")
                    ? (Array.isArray(value) ? value : [value]).map((v) => def.options?.find((o) => o.id === v)?.label ?? v)
                    : def && (def.type === "person" || def.type === "object") && Array.isArray(value)
                      ? value.map((id) => options.referenceLabel?.(id) ?? id)
                      : value;
            front.push(`  ${yaml(def?.label ?? key)}: ${yaml(Array.isArray(shown) && def?.type === "select" ? shown[0] : shown)}`);
        }
    }
    const body = documentToMarkdown(object.content, options);
    return `---\n${front.join("\n")}\n---\n\n# ${escapeMarkdown(object.title || "Untitled")}\n${body ? `\n${body}\n` : ""}`;
}
