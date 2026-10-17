// The stored document format, "daly.doc.v1": a documented subset of the ProseMirror JSON that the
// editor (Tiptap) produces. See docs/KNOWLEDGE_ENGINE.md#content-format.
//
// The Worker runs every document through normaliseDocument before storing it. Unknown node and
// mark types are refused (nothing is silently lost); unknown attributes are dropped; links must be
// http(s), mailto or a path on this site. Nothing in a document is ever rendered as raw HTML.

export const CONTENT_FORMAT = "daly.doc.v1";

export interface DocMark {
    type: string;
    attrs?: Record<string, unknown>;
}

export interface DocNode {
    type: string;
    attrs?: Record<string, unknown>;
    content?: DocNode[];
    marks?: DocMark[];
    text?: string;
}

export const EMPTY_DOCUMENT: DocNode = { type: "doc", content: [] };

/** Plain text as paragraphs, one per line (blank lines become empty paragraphs). */
export const paragraphsFromText = (text: string): DocNode[] =>
    text
        .split(/\r?\n/)
        .map((line) => line.trimEnd())
        .map((line) => (line ? { type: "paragraph", content: [{ type: "text", text: line }] } : { type: "paragraph" }));

const OBJECT_ID = /^kob_[a-z0-9]{14}$/;
/** In-app links to an object, e.g. /portal/knowledge/o/kob_…, count as links for backlinks. */
const OBJECT_PATH = /^\/portal\/knowledge\/o\/(kob_[a-z0-9]{14})(?:[?#].*)?$/;

export const MAX_DEPTH = 40;
export const MAX_NODES = 50_000;

type Children = "block" | "inline" | "text" | "none" | readonly string[];

interface NodeSpec {
    children: Children;
    /** Validates and normalises the node's attributes; returns an error message on failure. */
    attrs?: (attrs: Record<string, unknown>) => { attrs?: Record<string, unknown>; error?: string };
    inline?: boolean;
}

const BLOCKS = new Set(["paragraph", "heading", "blockquote", "bulletList", "orderedList", "taskList", "codeBlock", "horizontalRule", "table"]);
const INLINE = new Set(["text", "hardBreak", "objectLink"]);

const intIn = (value: unknown, min: number, max: number) => typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;

const cellAttrs = (attrs: Record<string, unknown>) => {
    const colspan = attrs.colspan ?? 1;
    const rowspan = attrs.rowspan ?? 1;
    const colwidth = attrs.colwidth ?? null;
    if (!intIn(colspan, 1, 50) || !intIn(rowspan, 1, 50)) return { error: "Invalid table cell span" };
    if (colwidth !== null && !(Array.isArray(colwidth) && colwidth.length <= 50 && colwidth.every((w) => intIn(w, 0, 5000))))
        return { error: "Invalid table column width" };
    return { attrs: { colspan, rowspan, colwidth } };
};

const SPECS: Record<string, NodeSpec> = {
    doc: { children: "block" },
    paragraph: { children: "inline" },
    heading: {
        children: "inline",
        attrs: (a) => (intIn(a.level, 1, 6) ? { attrs: { level: a.level } } : { error: "Headings are levels 1 to 6" }),
    },
    blockquote: { children: "block" },
    bulletList: { children: ["listItem"] },
    orderedList: {
        children: ["listItem"],
        attrs: (a) => {
            const start = a.start ?? 1;
            const type = a.type ?? null;
            if (!intIn(start, 0, 1_000_000)) return { error: "Invalid list start" };
            if (type !== null && !["1", "a", "A", "i", "I"].includes(type as string)) return { error: "Invalid list numbering" };
            return { attrs: { start, type } };
        },
    },
    listItem: { children: "block" },
    taskList: { children: ["taskItem"] },
    taskItem: {
        children: "block",
        attrs: (a) => (typeof (a.checked ?? false) === "boolean" ? { attrs: { checked: a.checked ?? false } } : { error: "Invalid checklist item" }),
    },
    codeBlock: {
        children: "text",
        attrs: (a) => {
            const language = a.language ?? null;
            return language === null || (typeof language === "string" && /^[a-zA-Z0-9+#._-]{1,30}$/.test(language))
                ? { attrs: { language } }
                : { error: "Invalid code language" };
        },
    },
    horizontalRule: { children: "none" },
    table: { children: ["tableRow"] },
    tableRow: { children: ["tableCell", "tableHeader"] },
    tableCell: { children: "block", attrs: cellAttrs },
    tableHeader: { children: "block", attrs: cellAttrs },
    text: { children: "none", inline: true },
    hardBreak: { children: "none", inline: true },
    objectLink: {
        children: "none",
        inline: true,
        attrs: (a) => {
            if (typeof a.id !== "string" || !OBJECT_ID.test(a.id)) return { error: "Invalid object link" };
            const label = typeof a.label === "string" ? a.label.slice(0, 300) : "";
            return { attrs: { id: a.id, label } };
        },
    },
};

/** Whether an href is safe to store and render: http(s), mailto, or a path on this site. */
export const isSafeHref = (href: unknown): href is string => {
    if (typeof href !== "string" || href.length > 2000) return false;
    if (/^\/(?![/\\])/.test(href)) return true;
    try {
        const url = new URL(href);
        return url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:";
    } catch {
        return false;
    }
};

const MARKS: Record<string, (attrs: Record<string, unknown>) => { attrs?: Record<string, unknown>; error?: string }> = {
    bold: () => ({}),
    italic: () => ({}),
    underline: () => ({}),
    strike: () => ({}),
    code: () => ({}),
    link: (a) => (isSafeHref(a.href) ? { attrs: { href: a.href } } : { error: "Links must start with https://, mailto: or /" }),
};

export class DocumentError extends Error {}

export interface NormalisedDocument {
    doc: DocNode;
    /** Plain text: blocks separated by newlines, object links by their label. */
    text: string;
    /** Ids of objects the document links to, in order of first appearance. */
    links: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Validates a document, returning a clean copy with its text and links. Throws DocumentError. */
export function normaliseDocument(input: unknown): NormalisedDocument {
    let count = 0;
    const links: string[] = [];
    const text: string[] = [];

    const visit = (raw: unknown, depth: number, allowed: Children): DocNode => {
        if (++count > MAX_NODES) throw new DocumentError("The document is too large");
        if (depth > MAX_DEPTH) throw new DocumentError("The document is nested too deeply");
        if (!isRecord(raw) || typeof raw.type !== "string") throw new DocumentError("The document is malformed");
        const spec = SPECS[raw.type];
        if (!spec) throw new DocumentError(`Unsupported content: ${raw.type.slice(0, 40)}`);
        const fits =
            allowed === "block"
                ? BLOCKS.has(raw.type)
                : allowed === "inline"
                  ? INLINE.has(raw.type)
                  : allowed === "text"
                    ? raw.type === "text"
                    : allowed === "none"
                      ? false
                      : allowed.includes(raw.type);
        if (!fits) throw new DocumentError(`${raw.type} can't appear there`);

        const node: DocNode = { type: raw.type };
        if (spec.attrs) {
            const result = spec.attrs(isRecord(raw.attrs) ? raw.attrs : {});
            if (result.error) throw new DocumentError(result.error);
            if (result.attrs) node.attrs = result.attrs;
        }

        if (raw.type === "text") {
            if (typeof raw.text !== "string" || raw.text.length === 0) throw new DocumentError("Empty text in the document");
            node.text = raw.text;
            text.push(raw.text);
            if (raw.marks !== undefined) {
                if (!Array.isArray(raw.marks) || raw.marks.length > 10) throw new DocumentError("The document is malformed");
                if (allowed === "text" && raw.marks.length) throw new DocumentError("Code blocks can't be formatted");
                const marks: DocMark[] = [];
                for (const rawMark of raw.marks) {
                    if (!isRecord(rawMark) || typeof rawMark.type !== "string" || !MARKS[rawMark.type])
                        throw new DocumentError(`Unsupported formatting: ${String((rawMark as { type?: unknown })?.type).slice(0, 40)}`);
                    const result = MARKS[rawMark.type](isRecord(rawMark.attrs) ? rawMark.attrs : {});
                    if (result.error) throw new DocumentError(result.error);
                    if (marks.some((m) => m.type === rawMark.type)) continue;
                    marks.push(result.attrs ? { type: rawMark.type, attrs: result.attrs } : { type: rawMark.type });
                    if (rawMark.type === "link") {
                        const match = OBJECT_PATH.exec(result.attrs!.href as string);
                        if (match && !links.includes(match[1])) links.push(match[1]);
                    }
                }
                if (marks.length) node.marks = marks;
            }
            return node;
        }
        if (raw.type === "objectLink") {
            const id = node.attrs!.id as string;
            if (!links.includes(id)) links.push(id);
            text.push(node.attrs!.label as string);
            return node;
        }
        if (raw.type === "hardBreak") {
            text.push("\n");
            return node;
        }

        if (raw.content !== undefined && raw.content !== null) {
            if (!Array.isArray(raw.content)) throw new DocumentError("The document is malformed");
            if (spec.children === "none" && raw.content.length) throw new DocumentError(`${raw.type} can't contain anything`);
            if (raw.content.length) {
                node.content = raw.content.map((child) => visit(child, depth + 1, spec.children));
            }
        }
        if (!spec.inline && raw.type !== "doc") text.push("\n");
        return node;
    };

    const doc = visit(input, 0, ["doc"]);
    if (!doc.content) doc.content = [];
    return {
        doc,
        text: text
            .join("")
            // Control characters are never meaningful in notes, and search snippets use two of them as highlight markers.
            .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
            .replace(/[ \t]+\n/g, "\n")
            .replace(/\n{3,}/g, "\n\n")
            .trim(),
        links,
    };
}
