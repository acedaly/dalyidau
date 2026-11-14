import type { D1Database } from "@cloudflare/workers-types";
// Reads the site content Payload published (worker/site/publisher.ts). One indexed D1 read per
// uncached page; anything missing or malformed falls back to the built-in content, field by field,
// so a bad snapshot can never break the public site (docs/PAYLOAD-FRONTEND-PLAN.md).
import {
    DEFAULT_ABOUT,
    DEFAULT_HOME,
    DEFAULT_PROJECTS_HOME,
    DEFAULT_SITE,
    type HomeContent,
    type Project,
    type ProjectSummary,
    type ProjectsHomeContent,
    type PublicPage,
    type SiteSettings,
    normaliseHome,
    normalisePage,
    normaliseProject,
    normaliseProjectSummary,
    normaliseProjectsHome,
    normaliseSite,
    sortProjects,
} from "../../src/shared/site-content";

export const SNAPSHOT = {
    settings: "site:settings",
    home: "site:home",
    /** Set once Payload has published the pages; from then on a missing page is really missing. */
    pagesManaged: "site:pages-managed",
    page: (slug: string) => `page:${slug}`,
    redirect: (slug: string) => `page-redirect:${slug}`,
    /** Every public project's summary, already sorted (worker/site/publisher.ts rebuilds it). */
    projects: "site:projects",
    projectsHome: "site:projects-home",
    project: (slug: string) => `project:${slug}`,
    projectRedirect: (slug: string) => `project-redirect:${slug}`,
} as const;

const parse = (value: string | null | undefined): unknown => {
    if (!value) return null;
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
};

const logFailure = (what: string, error: unknown) =>
    console.error(JSON.stringify({ event: "site_content_unavailable", what, message: (error as Error).message }));

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
        if (
            moved &&
            moved !== slug &&
            normalisePage(parse((await db.prepare("SELECT value FROM meta WHERE key = ?").bind(SNAPSHOT.page(moved)).first<{ value: string }>())?.value))
        )
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
        const { results } = await db
            .prepare("SELECT key, value FROM meta WHERE key LIKE 'page:%' OR key = ?")
            .bind(SNAPSHOT.pagesManaged)
            .all<{ key: string; value: string }>();
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

// --- Projects (Phase 4) ---------------------------------------------------------------------------------

const projectList = (value: string | undefined): ProjectSummary[] => {
    const parsed = parse(value);
    // Sorted here, not trusted from storage: the list is built inside the database (publisher.ts rebuildProjectIndex).
    return Array.isArray(parsed) ? sortProjects(parsed.map(normaliseProjectSummary).filter(Boolean) as ProjectSummary[]) : [];
};

/** Everything the projects-first homepage needs except posts, in one query. */
export async function loadProjectsHome(db: D1Database): Promise<{ site: SiteSettings; content: ProjectsHomeContent; projects: ProjectSummary[] }> {
    try {
        const { results } = await db
            .prepare("SELECT key, value FROM meta WHERE key IN (?, ?, ?)")
            .bind(SNAPSHOT.settings, SNAPSHOT.projectsHome, SNAPSHOT.projects)
            .all<{ key: string; value: string }>();
        const by = new Map(results.map((r) => [r.key, r.value]));
        return {
            site: normaliseSite(parse(by.get(SNAPSHOT.settings))),
            content: normaliseProjectsHome(parse(by.get(SNAPSHOT.projectsHome))),
            projects: projectList(by.get(SNAPSHOT.projects)),
        };
    } catch (error) {
        logFailure("projects home", error);
        return { site: DEFAULT_SITE, content: DEFAULT_PROJECTS_HOME, projects: [] };
    }
}

export async function loadProjects(db: D1Database): Promise<ProjectSummary[]> {
    try {
        const row = await db.prepare("SELECT value FROM meta WHERE key = ?").bind(SNAPSHOT.projects).first<{ value: string }>();
        return projectList(row?.value);
    } catch (error) {
        logFailure("projects", error);
        return [];
    }
}

export type ProjectLookup = { project: Project; related: ProjectSummary[] } | { redirect: string } | null;

/** A published project by its address (with up to three others to read next), the address it moved to, or null. */
export async function loadProject(db: D1Database, slug: string): Promise<ProjectLookup> {
    try {
        const { results } = await db
            .prepare("SELECT key, value FROM meta WHERE key IN (?, ?, ?)")
            .bind(SNAPSHOT.project(slug), SNAPSHOT.projectRedirect(slug), SNAPSHOT.projects)
            .all<{ key: string; value: string }>();
        const by = new Map(results.map((r) => [r.key, r.value]));
        const project = normaliseProject(parse(by.get(SNAPSHOT.project(slug))));
        if (project && project.slug === slug) {
            const others = projectList(by.get(SNAPSHOT.projects)).filter((p) => p.slug !== slug);
            const shared = (p: ProjectSummary) => p.tags.filter((t) => project.tags.includes(t)).length;
            const related = [...others].sort((a, b) => shared(b) - shared(a)).slice(0, 3);
            return { project, related };
        }
        const target = parse(by.get(SNAPSHOT.projectRedirect(slug)));
        // Only to a project that's on the site: a project taken off it keeps its old addresses (for when
        // it comes back) but they answer 404 meanwhile, without revealing where it lived.
        if (typeof target === "string" && target !== slug && projectList(by.get(SNAPSHOT.projects)).some((p) => p.slug === target)) return { redirect: target };
        return null;
    } catch (error) {
        logFailure("project", error);
        return null;
    }
}
