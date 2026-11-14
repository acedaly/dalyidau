// Redirects managed by hand in Payload (Website → Redirects; docs/AUDIT-2026-11.md, Phase 2b).
//
// The site already redirects on its own when a post, page or project is renamed (slug_redirects and the
// `page-redirect:` / `project-redirect:` rows): those are untouched and always win. A redirect kept here is
// only consulted when nothing else answers an address, so it can never hide a live page. The whole list is
// one snapshot (`site:redirects`), written in one statement: it is either the old list or the new one.
import type { D1Database } from "@cloudflare/workers-types";
import { RESERVED_SLUGS, safeLink } from "../../src/shared/site-content";
import { PublishError, type PublisherEnv } from "../blog/payload-publisher";
import { SNAPSHOT } from "./content";

export const REDIRECTS_KEY = "site:redirects";
export const REDIRECT_STATUSES = [301, 302] as const;
export type RedirectStatus = (typeof REDIRECT_STATUSES)[number];
export const MAX_REDIRECTS = 500;

export interface RedirectInput {
    from?: string | null;
    to?: string | null;
    status?: string | number | null;
    enabled?: boolean | null;
}
export interface SiteRedirect {
    to: string;
    status: RedirectStatus;
}
export interface RedirectsSnapshot {
    /** The Payload save this list was made from (the sync check compares it). */
    updatedAt: string | null;
    redirects: Record<string, SiteRedirect>;
}

/** Addresses that never reach the redirect step: the applications and files answer them first. */
const NEVER_REACHED = /^\/(admin|api|portal|media|wedding|_next|assets|brand)(\/|$)/;

/**
 * An old address as the site compares it: a path, without a trailing slash, query or fragment. Returns the
 * normalised path, or why it can't be used.
 */
export function redirectFrom(value: unknown): { path: string } | { problem: string } {
    if (typeof value !== "string" || !value.trim()) return { problem: "needs an old address, such as /old-page." };
    let path = value.trim();
    // A full address on this site is accepted and reduced to its path.
    const own = /^https?:\/\/(?:www\.)?daly\.id\.au(\/.*)?$/i.exec(path);
    if (own) path = own[1] ?? "/";
    if (!path.startsWith("/") || path.startsWith("//")) return { problem: "needs an old address that starts with / (a path on this site)." };
    if (/[?#]/.test(path)) return { problem: "can't include a ? or # in the old address: only the path is matched." };
    if (/[\s\\]/.test(path) || path.length > 300) return { problem: "has an old address with spaces in it, or one that's too long." };
    // As the Worker sees an address: percent-encoded (so /café is stored as /caf%C3%A9 and matches).
    try {
        path = new URL(path, "https://daly.id.au").pathname;
    } catch {
        return { problem: "has an old address that isn't a valid path." };
    }
    path = path.replace(/\/+$/, "");
    if (!path) return { problem: "can't redirect the homepage." };
    if (NEVER_REACHED.test(path))
        return { problem: `can't redirect ${path}: addresses under /${NEVER_REACHED.exec(path)![1]} are answered before redirects are looked at.` };
    return { path };
}

/** A destination: a path on this site or a full http(s) address. */
export function redirectTo(value: unknown): { to: string } | { problem: string } {
    const link = typeof value === "string" ? safeLink(value.trim()) : null;
    if (!link || !(link.startsWith("/") || /^https?:\/\//.test(link)))
        return { problem: "needs a destination: a path on this site (/blog) or a full https:// address." };
    if (link.length > 1000) return { problem: "has a destination that's too long." };
    return { to: link };
}

/** The path a destination has on this site (for spotting loops and chains), or null when it leads elsewhere. */
const ownPath = (to: string): string | null => {
    try {
        const url = new URL(to, "https://daly.id.au");
        return /^(www\.)?daly\.id\.au$/i.test(url.hostname) ? url.pathname.replace(/\/+$/, "") || "/" : null;
    } catch {
        return null;
    }
};

/**
 * The enabled redirects as the site stores them, or the first problem in the editor's words ("Redirect 3 …").
 * Pure. Duplicates (two rows for one old address, enabled or not), loops and chains through another row are refused.
 */
export function redirectsSnapshot(rows: RedirectInput[], updatedAt: string | null = null): RedirectsSnapshot {
    if (rows.length > MAX_REDIRECTS) throw new PublishError(`Keep the list to ${MAX_REDIRECTS} redirects.`);
    const redirects: Record<string, SiteRedirect> = {};
    const seen = new Map<string, number>();
    rows.forEach((row, i) => {
        const n = `Redirect ${i + 1}`;
        const from = redirectFrom(row.from);
        if ("problem" in from) throw new PublishError(`${n} ${from.problem}`);
        const to = redirectTo(row.to);
        if ("problem" in to) throw new PublishError(`${n} ${to.problem}`);
        const status = Number(row.status ?? 301);
        if (!REDIRECT_STATUSES.includes(status as RedirectStatus)) throw new PublishError(`${n} needs a type: permanent (301) or temporary (302).`);
        if (seen.has(from.path))
            throw new PublishError(`${n} repeats the old address of redirect ${seen.get(from.path)! + 1} (${from.path}). Keep one of them.`);
        seen.set(from.path, i);
        // Compared as paths on this site, so a full daly.id.au address or a ?query can't hide a loop.
        if (ownPath(to.to) === from.path) throw new PublishError(`${n} points ${from.path} at itself.`);
        if (row.enabled !== false) redirects[from.path] = { to: to.to, status: status as RedirectStatus };
    });
    for (const [from, { to }] of Object.entries(redirects)) {
        const next = redirects[ownPath(to) ?? ""];
        if (next)
            throw new PublishError(
                `The redirect from ${from} leads to ${to}, which is itself redirected (to ${next.to}). Point it straight at the final address.`,
            );
    }
    return { updatedAt, redirects };
}

/** A list in one canonical string: what the sync check compares (order and formatting never matter). */
export const redirectsFingerprint = (redirects: Record<string, SiteRedirect>) =>
    JSON.stringify(
        Object.keys(redirects)
            .sort()
            .map((from) => [from, redirects[from].to, redirects[from].status]),
    );

const parse = (value: string | null | undefined): unknown => {
    try {
        return value ? JSON.parse(value) : null;
    } catch {
        return null;
    }
};

/** The stored list, validated again on the way out: nothing unsafe is ever sent as a Location. */
export function normaliseRedirects(input: unknown): RedirectsSnapshot {
    const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    const redirects: Record<string, SiteRedirect> = {};
    for (const [key, value] of Object.entries((o.redirects && typeof o.redirects === "object" ? o.redirects : {}) as Record<string, unknown>)) {
        const from = redirectFrom(key);
        const v = (value ?? {}) as Record<string, unknown>;
        const to = redirectTo(v.to);
        if ("problem" in from || "problem" in to || from.path !== key) continue;
        redirects[key] = { to: to.to, status: v.status === 302 ? 302 : 301 };
    }
    return { updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : null, redirects };
}

/**
 * What already answers an old address, in the editor's words, or null when a redirect from it would work.
 * A redirect is only reached when nothing else answers, so one from a live address would never be used,
 * and one from an address the site already redirects itself would be a second, hidden answer.
 */
export async function addressInUse(db: D1Database, path: string): Promise<string | null> {
    if (
        path === "/blog" ||
        path === "/contact" ||
        path === "/projects" ||
        path === "/feed.xml" ||
        path === "/rss.xml" ||
        path === "/sitemap.xml" ||
        path === "/robots.txt"
    )
        return `${path} is one of the site's own pages.`;
    const post = /^\/blog\/([^/]+)$/.exec(path);
    if (post) {
        if (await db.prepare("SELECT 1 FROM posts WHERE slug = ?").bind(post[1]).first())
            return `${path} is a published post. A redirect from it would never be used.`;
        const moved = await db
            .prepare("SELECT p.slug FROM slug_redirects r JOIN posts p ON p.id = r.post_id WHERE r.from_slug = ?")
            .bind(post[1])
            .first<{ slug: string }>();
        if (moved) return `${path} already redirects to /blog/${moved.slug} (the post was renamed).`;
        return null;
    }
    const project = /^\/projects\/([^/]+)$/.exec(path);
    const page = /^\/([^/]+)$/.exec(path);
    const kind = project ? "project" : page ? "page" : null;
    if (!kind) return null;
    const slug = (project ?? page)![1];
    if (kind === "page" && RESERVED_SLUGS.has(slug)) return `${path} is an address the site uses itself.`;
    const keys = kind === "page" ? [SNAPSHOT.page(slug), SNAPSHOT.redirect(slug)] : [SNAPSHOT.project(slug), SNAPSHOT.projectRedirect(slug)];
    const { results } = await db
        .prepare("SELECT key, value FROM meta WHERE key IN (?, ?)")
        .bind(...keys)
        .all<{ key: string; value: string }>();
    const by = new Map(results.map((r) => [r.key, r.value]));
    if (by.has(keys[0])) return `${path} is a published ${kind}. A redirect from it would never be used.`;
    const target = parse(by.get(keys[1]));
    // An address kept for an item that's off the site (a marker, not an address) answers nothing: free to redirect.
    if (typeof target === "string" && !target.startsWith("@"))
        return `${path} already redirects to ${kind === "page" ? "/" : "/projects/"}${target} (the ${kind} was renamed).`;
    return null;
}

/**
 * Publishes the whole list. `check` validates it (and every old address against what the site already
 * answers) and writes nothing; Payload runs it before saving.
 */
export async function publishRedirects(
    env: Pick<PublisherEnv, "DB">,
    rows: RedirectInput[],
    options: { mode?: "publish" | "check"; updatedAt?: string | null; now?: Date } = {},
): Promise<RedirectsSnapshot> {
    const snapshot = redirectsSnapshot(rows, options.updatedAt ?? null);
    if (options.mode === "check") {
        // Only when the editor saves the list. A page published later at a redirect's old address simply
        // answers first; that must never make the stored list unpublishable (Republish writes it as it is).
        for (const from of Object.keys(snapshot.redirects)) {
            const used = await addressInUse(env.DB, from);
            if (used) throw new PublishError(`${used} Remove that redirect, or switch it off.`);
        }
        return snapshot;
    }
    await env.DB.batch([
        env.DB.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(
            REDIRECTS_KEY,
            JSON.stringify(snapshot),
        ),
        env.DB.prepare("INSERT INTO meta (key, value) VALUES ('content_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(
            (options.now ?? new Date()).toISOString(),
        ),
    ]);
    return snapshot;
}

export async function loadRedirects(db: D1Database): Promise<RedirectsSnapshot> {
    const row = await db.prepare("SELECT value FROM meta WHERE key = ?").bind(REDIRECTS_KEY).first<{ value: string }>();
    return normaliseRedirects(parse(row?.value));
}

/** Where an address that nothing else answered should go, if a redirect is kept for it. Never throws. */
export async function manualRedirect(db: D1Database, path: string): Promise<SiteRedirect | null> {
    try {
        return (await loadRedirects(db)).redirects[path.replace(/\/+$/, "") || "/"] ?? null;
    } catch (error) {
        console.error(JSON.stringify({ event: "redirects_unreadable", message: (error as Error).message }));
        return null;
    }
}

export interface AutomaticRedirect {
    kind: "post" | "page" | "project";
    from: string;
    /** Where it leads now, or null while the item it belongs to is off the site (the address then answers 404). */
    to: string | null;
    title: string | null;
    createdAt: string | null;
}

/** The redirects the site keeps by itself, for the admin to look at (read-only). */
export async function automaticRedirects(db: D1Database): Promise<AutomaticRedirect[]> {
    const [posts, meta] = await Promise.all([
        db
            .prepare("SELECT r.from_slug, r.created_at, p.slug, p.title FROM slug_redirects r LEFT JOIN posts p ON p.id = r.post_id ORDER BY r.from_slug")
            .all<{ from_slug: string; created_at: string | null; slug: string | null; title: string | null }>(),
        db
            .prepare(
                `SELECT key, value FROM meta WHERE substr(key, 1, 14) = 'page-redirect:' OR substr(key, 1, 17) = 'project-redirect:'
                 UNION ALL
                 SELECT key, json_object('title', json_extract(value, '$.title')) FROM meta WHERE (substr(key, 1, 5) = 'page:' OR substr(key, 1, 8) = 'project:') AND json_valid(value)`,
            )
            .all<{ key: string; value: string }>(),
    ]);
    const titles = new Map<string, string | null>();
    for (const row of meta.results)
        if (row.key.startsWith("page:") || row.key.startsWith("project:"))
            titles.set(row.key, ((parse(row.value) as { title?: string } | null)?.title ?? null) as string | null);
    const list: AutomaticRedirect[] = posts.results.map((r) => ({
        kind: "post",
        from: `/blog/${r.from_slug}`,
        to: r.slug ? `/blog/${r.slug}` : null,
        title: r.title,
        createdAt: r.created_at,
    }));
    for (const row of meta.results) {
        const kind = row.key.startsWith("page-redirect:") ? "page" : row.key.startsWith("project-redirect:") ? "project" : null;
        if (!kind) continue;
        const base = kind === "page" ? "/" : "/projects/";
        const target = parse(row.value);
        const live = typeof target === "string" && !target.startsWith("@") && titles.has(`${kind}:${target}`);
        list.push({
            kind,
            from: `${base}${row.key.slice(kind.length + 10)}`,
            to: live ? `${base}${target}` : null,
            title: live ? (titles.get(`${kind}:${target}`) ?? null) : null,
            createdAt: null,
        });
    }
    return list.sort((a, b) => a.from.localeCompare(b.from));
}
