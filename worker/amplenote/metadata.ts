// Conventions that turn an Amplenote note into article metadata, with nothing to fill in on the
// website (docs/AMPLENOTE.md#writing-conventions):
//
//   website/blog              required: the note is meant for the blog (plus Amplenote's own Publish)
//   website/featured          the featured article
//   website/category/<name>   its category
//   website/tag/<name>        a public tag (the note's other tags are never shown or stored)
//
// and an optional section headed "Website" holding "key: value" lines (slug, subtitle, summary,
// published, image). That section is removed before the article is rendered.
import { isValidSlug, slugify } from "../lib/html";

export const DEFAULT_TAG = "website/blog";

export const PUBLIC_HOST = "public.amplenote.com";

export interface Conventions {
    /** The tag that marks a note for the blog, lower-case. */
    tag: string;
    /** Its parent ("website"); category, tag and featured tags live under it. */
    namespace: string;
}

export const conventions = (configured: string | undefined): Conventions => {
    const tag = (configured?.trim() || DEFAULT_TAG).toLowerCase().replace(/^#/, "");
    const namespace = tag.includes("/") ? tag.slice(0, tag.lastIndexOf("/")) : tag;
    return { tag, namespace };
};

export const hasTag = (tags: readonly string[], tag: string) => tags.some((t) => t.trim().toLowerCase() === tag);

/** Only the tags under the website namespace, so private tags never reach the database or the page. */
export const websiteTags = (tags: readonly string[], c: Conventions) =>
    [...new Set(tags.map((t) => t.trim().toLowerCase()).filter((t) => t === c.tag || t.startsWith(`${c.namespace}/`)))].sort();

const label = (value: string) => {
    const words = value.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
    return words ? words[0].toUpperCase() + words.slice(1) : "";
};

export const tagMetadata = (tags: readonly string[], c: Conventions) => {
    const own = websiteTags(tags, c);
    const under = (kind: string) =>
        own
            .filter((t) => t.startsWith(`${c.namespace}/${kind}/`))
            .map((t) => label(t.slice(`${c.namespace}/${kind}/`.length)))
            .filter(Boolean);
    return {
        featured: own.includes(`${c.namespace}/featured`),
        category: under("category")[0] ?? null,
        tags: [...new Set(under("tag"))].sort((a, b) => a.localeCompare(b)),
    };
};

/**
 * The token in a note's public URL (https://public.amplenote.com/<token>), or null for anything else.
 * `base` is only ever different for the local stand-in in development (client.ts hosts()).
 */
export const publicToken = (url: string | null | undefined, base = `https://${PUBLIC_HOST}`): string | null => {
    if (!url) return null;
    try {
        const parsed = new URL(url);
        const expected = new URL(base);
        if (parsed.protocol !== expected.protocol || parsed.host !== expected.host || parsed.username || parsed.password) return null;
        const prefix = expected.pathname.replace(/\/+$/, "");
        if (!parsed.pathname.startsWith(`${prefix}/`)) return null;
        const match = /^\/(?:embed\/)?([A-Za-z0-9_-]{6,64})\/?$/.exec(parsed.pathname.slice(prefix.length));
        return match ? match[1] : null;
    } catch {
        return null;
    }
};

export const publicUrl = (token: string) => `https://${PUBLIC_HOST}/${token}`;

export interface NoteMetadata {
    slug: string | null;
    subtitle: string | null;
    summary: string | null;
    published: string | null;
    image: string | null;
    /** The slug of a Capacities article this note takes over (with the owner's approval in the portal). */
    replaces: string | null;
}

const KEYS: Record<string, keyof NoteMetadata> = {
    slug: "slug",
    url: "slug",
    subtitle: "subtitle",
    summary: "summary",
    excerpt: "summary",
    description: "summary",
    published: "published",
    date: "published",
    image: "image",
    "featured image": "image",
    replaces: "replaces",
    "replaces capacities": "replaces",
};

const SECTION = /^(#{1,6})\s+\**website(?:\s+metadata)?\**\s*:?\s*$/i;

/** Splits the optional "Website" section out of the note: its values, and the markdown without it. */
export const extractMetadata = (markdown: string): { metadata: NoteMetadata; body: string } => {
    const metadata: NoteMetadata = { slug: null, subtitle: null, summary: null, published: null, image: null, replaces: null };
    const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
    const start = lines.findIndex((line) => SECTION.test(line.trim()));
    if (start < 0) return { metadata, body: markdown };
    const level = SECTION.exec(lines[start].trim())![1].length;
    let end = start + 1;
    while (end < lines.length) {
        const heading = /^(#{1,6})\s/.exec(lines[end].trim());
        if (heading && heading[1].length <= level) break;
        end++;
    }
    for (const raw of lines.slice(start + 1, end)) {
        const line = raw
            .replace(/<!--[\s\S]*?-->/g, "")
            .trim()
            .replace(/^(?:[-*+]|\d+[.)])\s+/, "")
            .replace(/\*\*|__/g, "");
        const pair = /^\|?\s*([^|:]+?)\s*(?::|\|)\s*(.+?)\s*\|?\s*$/.exec(line);
        if (!pair) continue;
        const key = KEYS[pair[1].trim().toLowerCase()];
        let value = pair[2].trim();
        if (!key || !value || /^-+$/.test(value)) continue;
        const linked = /^!?\[[^\]]*\]\(([^)\s]+)[^)]*\)$/.exec(value);
        if (linked) value = linked[1];
        metadata[key] = value.slice(0, key === "summary" ? 400 : 200);
    }
    if (metadata.replaces) {
        // Accepts the slug, /blog/<slug> or the article's full address.
        const slug = /(?:^|\/blog\/)([a-z0-9-]+)\/?(?:[?#].*)?$/i.exec(metadata.replaces.trim())?.[1]?.toLowerCase() ?? "";
        metadata.replaces = isValidSlug(slug) ? slug : null;
    }
    if (metadata.slug) {
        const slug = slugify(metadata.slug);
        metadata.slug = slug && isValidSlug(slug) ? slug : null;
    }
    if (metadata.published) {
        const time = Date.parse(metadata.published);
        metadata.published = Number.isFinite(time) ? new Date(time).toISOString() : null;
    }
    return { metadata, body: [...lines.slice(0, start), ...lines.slice(end)].join("\n") };
};

/** Removes a leading heading that only repeats the note's title (Amplenote shows the title separately). */
export const withoutRepeatedTitle = (markdown: string, title: string) => {
    const lines = markdown.split("\n");
    const first = lines.findIndex((line) => line.trim() && line.trim() !== "\\");
    if (first < 0) return markdown;
    const heading = /^#{1,6}\s+(.*?)\s*#*$/.exec(lines[first].trim());
    if (heading && heading[1].replace(/[*_]/g, "").trim().toLowerCase() === title.trim().toLowerCase()) lines.splice(first, 1);
    return lines.join("\n");
};
