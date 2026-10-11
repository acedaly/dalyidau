const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => ESCAPES[char]);

/** Allows only http(s) and mailto links. Anything else (javascript:, data:, relative) is rejected. */
export const safeUrl = (value: string | null | undefined): string | null => {
    if (!value) return null;
    const trimmed = value.trim();
    try {
        const url = new URL(trimmed);
        if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:") return url.toString();
    } catch {
        // Not an absolute URL.
    }
    return null;
};

export const isExternal = (href: string, siteUrl: string) => {
    try {
        return new URL(href).host !== new URL(siteUrl).host;
    } catch {
        return true;
    }
};

/** URL-safe slug: lower-case ASCII letters, digits and single hyphens. */
export const slugify = (value: string) =>
    value
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/&/g, " and ")
        .replace(/['’]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 96)
        .replace(/-+$/g, "");

export const isValidSlug = (slug: string) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) && slug.length <= 96;

/** Embeds JSON inside a <script> tag without allowing the content to close it. */
export const jsonForScript = (value: unknown) =>
    JSON.stringify(value)
        .replace(/</g, "\\u003c")
        .replace(/>/g, "\\u003e")
        .replace(/&/g, "\\u0026")
        .replace(/\u2028/g, "\\u2028")
        .replace(/\u2029/g, "\\u2029");
