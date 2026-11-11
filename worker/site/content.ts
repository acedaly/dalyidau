import type { D1Database } from "@cloudflare/workers-types";
// Reads the site content Payload published (worker/site/publisher.ts). One indexed D1 read per
// uncached page; anything missing or malformed falls back to the built-in content, field by field,
// so a bad snapshot can never break the public site (docs/PAYLOAD-FRONTEND-PLAN.md).
import {
    DEFAULT_ABOUT,
    DEFAULT_HOME,
    DEFAULT_SITE,
    type HomeContent,
    type PublicPage,
    type SiteSettings,
    normaliseHome,
    normalisePage,
    normaliseSite,
} from "../../src/shared/site-content";

export const SNAPSHOT = {
    settings: "site:settings",
    home: "site:home",
    /** Set once Payload has published the pages; from then on a missing page is really missing. */
    pagesManaged: "site:pages-managed",
    page: (slug: string) => `page:${slug}`,
    redirect: (slug: string) => `page-redirect:${slug}`,
} as const;

const parse = (value: string | null | undefined): unknown => {
    if (!value) return null;
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
};

const logFailure = (what: string, error: unknown) => console.error(JSON.stringify({ event: "site_content_unavailable", what, message: (error as Error).message }));

export async function loadSite(db: D1Database): Promise<SiteSettings> {
    try {
        const row = await db.prepare("SELECT value FROM meta WHERE key = ?").bind(SNAPSHOT.settings).first<{ value: string }>();
        return normaliseSite(parse(row?.value));
    } catch (error) {
        logFailure("settings", error);
        return DEFAULT_SITE;
    }
}

export async function loadSiteAndHome(db: D1Database): Promise<{ site: SiteSettings; home: HomeContent }> {
    try {
        const { results } = await db
            .prepare("SELECT key, value FROM meta WHERE key IN (?, ?)")
            .bind(SNAPSHOT.settings, SNAPSHOT.home)
            .all<{ key: string; value: string }>();
        const by = new Map(results.map((r) => [r.key, r.value]));
        return { site: normaliseSite(parse(by.get(SNAPSHOT.settings))), home: normaliseHome(parse(by.get(SNAPSHOT.home))) };
    } catch (error) {
        logFailure("home", error);
        return { site: DEFAULT_SITE, home: DEFAULT_HOME };
    }
}

export type PageLookup = { page: PublicPage } | { redirect: string } | null;

/** A published page by its address, the address it moved to, or null. */
export async function loadPage(db: D1Database, slug: string): Promise<PageLookup> {
    try {
        const { results } = await db
            .prepare("SELECT key, value FROM meta WHERE key IN (?, ?, ?)")
            .bind(SNAPSHOT.page(slug), SNAPSHOT.redirect(slug), SNAPSHOT.pagesManaged)
            .all<{ key: string; value: string }>();
        const by = new Map(results.map((r) => [r.key, r.value]));
        const page = normalisePage(parse(by.get(SNAPSHOT.page(slug))));
        if (page && page.slug === slug) return { page };
        const target = parse(by.get(SNAPSHOT.redirect(slug)));
        const moved = typeof target === "string" ? target : null;
        if (moved && moved !== slug && normalisePage(parse((await db.prepare("SELECT value FROM meta WHERE key = ?").bind(SNAPSHOT.page(moved)).first<{ value: string }>())?.value)))
            return { redirect: moved };
        // Until Payload has published its pages, /about is the built-in one.
        if (slug === "about" && !by.has(SNAPSHOT.pagesManaged)) return { page: DEFAULT_ABOUT };
        return null;
    } catch (error) {
        logFailure("page", error);
        return slug === "about" ? { page: DEFAULT_ABOUT } : null;
    }
}

/** Published pages for the sitemap: address and last change. */
export async function listPages(db: D1Database): Promise<{ slug: string; lastmod: string | null }[]> {
    try {
        const { results } = await db.prepare("SELECT key, value FROM meta WHERE key LIKE 'page:%' OR key = ?").bind(SNAPSHOT.pagesManaged).all<{ key: string; value: string }>();
        const managed = results.some((r) => r.key === SNAPSHOT.pagesManaged);
        const pages = results
            .filter((r) => r.key.startsWith("page:"))
            .map((r) => normalisePage(parse(r.value)))
            .filter((p): p is PublicPage => Boolean(p))
            .map((p) => ({ slug: p.slug, lastmod: p.updatedAt }))
            .sort((a, b) => a.slug.localeCompare(b.slug));
        if (!managed && !pages.some((p) => p.slug === "about")) pages.unshift({ slug: "about", lastmod: null });
        return pages;
    } catch (error) {
        logFailure("pages", error);
        return [{ slug: "about", lastmod: null }];
    }
}
