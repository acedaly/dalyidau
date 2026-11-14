import type { D1Database } from "@cloudflare/workers-types";
// Payload as the publisher of the site's content (docs/PAYLOAD-FRONTEND-PLAN.md): its hooks call
// these functions, which validate what Payload holds and write public snapshots into D1 `meta`, then
// bump `content_version` so the edge cache serves the change on the next request. The public pages
// never start Payload; they read these snapshots (worker/site/content.ts).
//
// Same rules as the blog publisher: every string is validated here and escaped when rendered; rich
// text goes through the escaping Lexical renderer; links are limited to http(s), mailto and paths on
// this site; images are copied into the public bucket under their content hash. Fails closed.
import {
    type HomeContent,
    type NavItem,
    PAGE_SLUG,
    PROJECT_STATUSES,
    type Project,
    type ProjectsHomeContent,
    type PublicPage,
    type SiteSettings,
    normaliseHome,
    normalisePage,
    normaliseProject,
    normaliseProjectsHome,
    normaliseSite,
    pageSlugProblem,
    safeLink,
} from "../../src/shared/site-content";
import {
    type LexicalNode,
    type MediaFile,
    PublishError,
    type PublishMode,
    type PublisherEnv,
    lexicalHasContent,
    renderLexical,
    storePublicImage,
    uploadIds,
} from "../blog/payload-publisher";
import { mediaUrls } from "../lib/image";
import { SNAPSHOT } from "./content";

export { PublishError };

const bump = (db: D1Database, now: string) =>
    db.prepare("INSERT INTO meta (key, value) VALUES ('content_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(now);
const put = (db: D1Database, key: string, value: unknown) =>
    db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(key, JSON.stringify(value));
const del = (db: D1Database, key: string) => db.prepare("DELETE FROM meta WHERE key = ?").bind(key);
/**
 * Old addresses belong to an item, not to the address it happened to live at. While an item is off the
 * site its redirects point at this marker instead of an address: it can never be a real address (addresses
 * are lower-case letters, numbers and hyphens), so they answer 404 and reveal nothing, a different item
 * that publishes at the old address inherits none of them, and when the item is published again, wherever,
 * they are pointed at its new address.
 */
const offSite = (kind: "page" | "project", id: string | number) => `@${kind}:${id}`;

/** The address an item is published at now, if any. */
async function currentSlug(db: D1Database, idKey: string): Promise<string | null> {
    const raw = (await db.prepare("SELECT value FROM meta WHERE key = ?").bind(idKey).first<{ value: string }>())?.value;
    try {
        const slug: unknown = raw ? JSON.parse(raw) : null;
        return typeof slug === "string" ? slug : null;
    } catch {
        return null;
    }
}

/** Points every redirect that leads to `from` at `to` instead. `prefix` is the kind's redirect key prefix. */
const repoint = (db: D1Database, prefix: "page-redirect:" | "project-redirect:", from: string, to: string) =>
    db.prepare("UPDATE meta SET value = ? WHERE substr(key, 1, ?) = ? AND value = ?").bind(JSON.stringify(to), prefix.length, prefix, JSON.stringify(from));
const dropRedirectsTo = (db: D1Database, prefix: "page-redirect:" | "project-redirect:", to: string) =>
    db.prepare("DELETE FROM meta WHERE substr(key, 1, ?) = ? AND value = ?").bind(prefix.length, prefix, JSON.stringify(to));
const ownerOf = (value: string): unknown => {
    try {
        return (JSON.parse(value) as { id?: unknown } | null)?.id;
    } catch {
        return undefined;
    }
};
const pageIdKey = (id: string | number) => `page-id:${id}`;

type Kind = "page" | "project";
const SNAPSHOT_PREFIX = { page: "page:", project: "project:" } as const;
const REDIRECT_PREFIX = { page: "page-redirect:", project: "project-redirect:" } as const;
const OWNED_BY = "json_valid(value) AND CAST(json_extract(value, '$.id') AS TEXT) = ";

/**
 * Every snapshot of one item, found by the id inside it, not by the address it is believed to be at: two
 * saves that overlap (a rename and an unpublish, or two renames) can each act on an address the other has
 * just changed, and a snapshot removed "by address" would then be left on the site. `except` keeps one.
 * Each one removed leaves a redirect from its address to `to` (the item's new address, or its off-site marker).
 */
const sweepSnapshots = (db: D1Database, kind: Kind, id: string | number, to: string | null, except: string | null = null) => {
    const prefix = SNAPSHOT_PREFIX[kind];
    const where = `substr(key, 1, ${prefix.length}) = '${prefix}' AND ${OWNED_BY}?1 AND key != ?2`;
    const statements = [];
    if (to !== null)
        statements.push(
            db
                .prepare(
                    `INSERT INTO meta (key, value) SELECT '${REDIRECT_PREFIX[kind]}' || substr(key, ${prefix.length + 1}), ?3 FROM meta WHERE ${where}
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
                )
                .bind(String(id), except ?? "", JSON.stringify(to)),
        );
    statements.push(db.prepare(`DELETE FROM meta WHERE ${where}`).bind(String(id), except ?? ""));
    return statements;
};

/**
 * Payload gives a new document the number of the last one deleted (its tables don't use AUTOINCREMENT).
 * A snapshot made before this document existed is therefore an earlier document's, not this one's: it must
 * not be replaced, renamed, redirected or taken down in this document's name.
 */
async function earlierDocumentsSlug(db: D1Database, kind: Kind, id: string | number, createdAt: string | null | undefined): Promise<string | null> {
    const created = createdAt ? Date.parse(createdAt) : NaN;
    if (Number.isNaN(created)) return null;
    const prefix = SNAPSHOT_PREFIX[kind];
    const { results } = await db
        .prepare(`SELECT key, json_extract(value, '$.updatedAt') AS updatedAt FROM meta WHERE substr(key, 1, ${prefix.length}) = '${prefix}' AND ${OWNED_BY}?1`)
        .bind(String(id))
        .all<{ key: string; updatedAt: string | null }>();
    const earlier = results.find((r) => Date.parse(r.updatedAt ?? "") < created);
    return earlier ? earlier.key.slice(prefix.length) : null;
}
const EARLIER = (kind: Kind, slug: string) =>
    `The website still has an earlier ${kind} (at ${kind === "page" ? "/" : "/projects/"}${slug}) that Payload no longer has a document for, under the number this ${kind} was given. It's listed under "Website sync" on the dashboard: an owner can remove it there, and then this can be published.`;

export interface SiteSettingsInput {
    name?: string | null;
    shortName?: string | null;
    title?: string | null;
    description?: string | null;
    blogTitle?: string | null;
    blogDescription?: string | null;
    email?: string | null;
    socials?: Array<{ label?: string | null; url?: string | null; kind?: string | null }> | null;
    footerText?: string | null;
    contact?: { eyebrow?: string | null; heading?: string | null; intro?: string | null; emailDescription?: string | null } | null;
    seoImageMediaId?: string | number | null;
}

export interface NavigationInput {
    /** Each item: a label and either a published page's slug or a link. */
    items: Array<{ label?: string | null; pageSlug?: string | null; url?: string | null }>;
}

export interface MediaLoader {
    loadMedia(id: string | number): Promise<MediaFile | null>;
    now?: () => Date;
    transforms?: boolean;
    /** `publish` (default), `check` or `preview`: see PublishMode in ../blog/payload-publisher. */
    mode?: PublishMode;
}

const strict = (value: unknown, what: string, max: number): string => {
    if (typeof value !== "string" || !value.trim()) throw new PublishError(`${what} can't be empty.`);
    if (value.trim().length > max) throw new PublishError(`${what} is too long (at most ${max} characters).`);
    return value.trim();
};

/** The navigation as the site will render it. Items pointing at unpublished pages are left out. */
export function resolveNavigation(input: NavigationInput, published: Set<string>): NavItem[] {
    const items: NavItem[] = [];
    for (const [i, item] of input.items.entries()) {
        const label = strict(item.label, `Menu item ${i + 1}'s label`, 60);
        if (item.pageSlug) {
            if (published.has(item.pageSlug)) items.push({ label, href: `/${item.pageSlug}` });
            continue;
        }
        const href = safeLink(item.url);
        if (!href) throw new PublishError(`Menu item "${label}" needs a link: a path such as /blog, or a full https:// address.`);
        items.push({ label, href });
    }
    if (items.length > 12) throw new PublishError("The menu can have at most 12 items.");
    return items;
}

/** The settings snapshot, validated. Pure: used before saving (to show the editor what's wrong) and when publishing. */
export function settingsSnapshot(input: SiteSettingsInput, nav: NavItem[], seoImage: string | null = null) {
    const email = input.email?.trim() || null;
    if (email && !/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(email)) throw new PublishError(`"${email}" isn't an email address.`);
    const socials = (input.socials ?? []).map((s, i) => {
        const href = safeLink(s.url);
        if (!href || !/^https:/.test(href)) throw new PublishError(`Social link ${i + 1} needs a full https:// address.`);
        return { label: strict(s.label ?? s.kind, `Social link ${i + 1}'s label`, 60), href, kind: s.kind };
    });
    const snapshot = {
        name: strict(input.name, "Site name", 80),
        shortName: strict(input.shortName, "Logo initials", 4),
        title: strict(input.title, "Homepage title", 120),
        description: strict(input.description, "Site description", 300),
        blogTitle: strict(input.blogTitle, "Blog title", 80),
        blogDescription: strict(input.blogDescription, "Blog description", 300),
        email,
        socials,
        nav,
        seoImage,
        footerText: input.footerText?.trim() || null,
        contact: {
            eyebrow: strict(input.contact?.eyebrow, "Contact page label", 60),
            heading: strict(input.contact?.heading, "Contact page heading", 120),
            intro: strict(input.contact?.intro, "Contact page introduction", 400),
            emailDescription: strict(input.contact?.emailDescription, "Contact page email description", 300),
        },
    };
    // What will render must be exactly what was validated: normalising must not drop anything.
    const rendered = normaliseSite(snapshot);
    if (rendered.socials.length !== socials.length) throw new PublishError("A social link has an unknown kind.");
    if (nav.length && rendered.nav.length !== nav.length) throw new PublishError("A menu item couldn't be used.");
    return { snapshot, rendered };
}

/** Writes the site settings and navigation snapshot. */
export async function publishSiteSettings(env: PublisherEnv, input: SiteSettingsInput, nav: NavItem[], ctx: MediaLoader): Promise<SiteSettings> {
    const now = (ctx.now?.() ?? new Date()).toISOString();
    let seoImage: string | null = null;
    if (input.seoImageMediaId !== undefined && input.seoImageMediaId !== null) {
        const file = await ctx.loadMedia(input.seoImageMediaId);
        const stored = file ? await storePublicImage(env, `payload-media:${input.seoImageMediaId}`, file, now) : null;
        if (!stored) throw new PublishError("The social preview image couldn't be read, or isn't a JPEG, PNG, GIF, WebP or AVIF under 15 MB.");
        seoImage = `/media/${stored.key}`;
    }
    const { snapshot, rendered } = settingsSnapshot(input, nav, seoImage);
    await env.DB.batch([put(env.DB, SNAPSHOT.settings, snapshot), bump(env.DB, now)]);
    return rendered;
}

/** The homepage snapshot, validated. Pure. */
export function homeSnapshot(input: Partial<Record<keyof HomeContent, unknown>>) {
    const paragraphs = Array.isArray(input.aboutParagraphs) ? input.aboutParagraphs : [];
    const snapshot = {
        eyebrow: strict(input.eyebrow, "Eyebrow", 80),
        heading: strict(input.heading, "Heading", 200),
        headingEmphasis: typeof input.headingEmphasis === "string" ? input.headingEmphasis.trim() : "",
        intro: strict(input.intro, "Introduction", 1000),
        ctaLabel: strict(input.ctaLabel, "Button label", 60),
        ctaHref:
            safeLink(input.ctaHref) ??
            (() => {
                throw new PublishError("The button needs a link: a path such as /blog, or a full https:// address.");
            })(),
        latestEyebrow: strict(input.latestEyebrow, "Latest posts label", 80),
        latestHeading: strict(input.latestHeading, "Latest posts heading", 120),
        latestCount:
            typeof input.latestCount === "number" && Number.isInteger(input.latestCount) && input.latestCount >= 0 && input.latestCount <= 12
                ? input.latestCount
                : (() => {
                      throw new PublishError("Show between 0 and 12 latest posts.");
                  })(),
        aboutHeading: strict(input.aboutHeading, "About section heading", 200),
        aboutParagraphs: paragraphs.map((p, i) => strict(p, `About paragraph ${i + 1}`, 2000)),
        showContactLine: input.showContactLine !== false,
        seoTitle: typeof input.seoTitle === "string" && input.seoTitle.trim() ? input.seoTitle.trim() : null,
        seoDescription: typeof input.seoDescription === "string" && input.seoDescription.trim() ? input.seoDescription.trim() : null,
    };
    if (snapshot.aboutParagraphs.length > 10) throw new PublishError("The about section can have at most 10 paragraphs.");
    return snapshot;
}

export async function publishHome(env: PublisherEnv, input: Partial<Record<keyof HomeContent, unknown>>, now = new Date()): Promise<HomeContent> {
    const snapshot = homeSnapshot(input);
    await env.DB.batch([put(env.DB, SNAPSHOT.home, snapshot), bump(env.DB, now.toISOString())]);
    return normaliseHome(snapshot);
}

export interface PageInput {
    /** Payload's id for the page: it tracks the page's address across renames. */
    id: string | number;
    slug: string;
    title: string;
    lede?: string | null;
    content?: { root?: LexicalNode } | null;
    heroMediaId?: string | number | null;
    showButtons?: boolean | null;
    seoTitle?: string | null;
    seoDescription?: string | null;
    /** When Payload created the document: tells it apart from an earlier one that had the same number. */
    createdAt?: string | null;
    updatedAt?: string | null;
}

/** Why this page can't be published, or null. Used before saving so the editor sees the reason. */
export function pageProblem(input: Pick<PageInput, "slug" | "title">): string | null {
    if (!input.title?.trim()) return "A published page needs a title.";
    return pageSlugProblem(input.slug ?? "");
}

/** Publishes a page at daly.id.au/<slug>. A renamed page's old address redirects to the new one. */
export async function publishPage(env: PublisherEnv, input: PageInput, ctx: MediaLoader): Promise<PublicPage> {
    const now = (ctx.now?.() ?? new Date()).toISOString();
    const problem = pageProblem(input);
    if (problem) throw new PublishError(problem);
    const slug = input.slug;
    const mode = ctx.mode ?? "publish";
    // A preview claims no address; a check and a publish refuse one another item holds.
    if (mode !== "preview") {
        const owner = await env.DB.prepare("SELECT value FROM meta WHERE key = ?").bind(SNAPSHOT.page(slug)).first<{ value: string }>();
        // A damaged snapshot belongs to nobody: it can be replaced.
        const ownerId = owner ? ownerOf(owner.value) : undefined;
        if (owner && ownerId !== undefined && String(ownerId) !== String(input.id))
            throw new PublishError(`daly.id.au/${slug} is already used by another page.`);
        const earlier = await earlierDocumentsSlug(env.DB, "page", input.id, input.createdAt);
        if (earlier) throw new PublishError(EARLIER("page", earlier));
    }

    const stored = new Map<string, { key: string; alt: string; width: number | null; height: number | null; caption?: string | null }>();
    const copy = async (id: string | number) => {
        const key = String(id);
        if (stored.has(key)) return stored.get(key)!;
        const file = await ctx.loadMedia(id);
        if (!file) return null;
        const image = await storePublicImage(env, `payload-media:${key}`, file, now, mode);
        if (image) stored.set(key, { ...image, caption: file.caption ?? null });
        return image;
    };
    const root = input.content?.root;
    let bodyHtml = "";
    if (lexicalHasContent(root)) {
        for (const id of uploadIds(root))
            if (!(await copy(id)))
                throw new PublishError(
                    "An image in the text couldn't be read, or isn't a JPEG, PNG, GIF, WebP or AVIF under 15 MB. Remove it or upload it again.",
                );
        bodyHtml = renderLexical(root, {
            siteUrl: env.SITE_URL,
            image: (id) => {
                const image = stored.get(String(id));
                return image ? { ...image, ...mediaUrls(image.key, image.width, !!ctx.transforms) } : null;
            },
        }).html;
    }
    let image: PublicPage["image"] = null;
    if (input.heroMediaId !== undefined && input.heroMediaId !== null) {
        const hero = await copy(input.heroMediaId);
        if (!hero) throw new PublishError("The featured image couldn't be read, or isn't a JPEG, PNG, GIF, WebP or AVIF under 15 MB.");
        image = { src: `/media/${hero.key}`, alt: hero.alt, width: hero.width ?? undefined, height: hero.height ?? undefined };
    }
    const snapshot = {
        id: input.id,
        slug,
        title: input.title.trim(),
        lede: input.lede?.trim() || null,
        bodyHtml,
        image,
        showButtons: !!input.showButtons,
        seoTitle: input.seoTitle?.trim() || null,
        seoDescription: input.seoDescription?.trim() || null,
        updatedAt: input.updatedAt ?? now,
    };
    const page = normalisePage(snapshot);
    if (!page) throw new PublishError("This page can't be published as it is.");
    if (mode !== "publish") return page;

    const previousSlug = await currentSlug(env.DB, pageIdKey(input.id));
    const statements = [
        put(env.DB, SNAPSHOT.page(slug), snapshot),
        put(env.DB, pageIdKey(input.id), slug),
        // Addresses this page had before it was last taken off the site lead to it again.
        repoint(env.DB, "page-redirect:", offSite("page", input.id), slug),
        put(env.DB, SNAPSHOT.pagesManaged, true),
        bump(env.DB, now),
    ];
    if (previousSlug && previousSlug !== slug) {
        statements.push(del(env.DB, SNAPSHOT.page(previousSlug)), put(env.DB, SNAPSHOT.redirect(previousSlug), slug));
        // Earlier addresses of this page follow it to its new one.
        statements.push(repoint(env.DB, "page-redirect:", previousSlug, slug));
    }
    // Any other snapshot of this page (an overlapping save's) goes too, leaving its address redirecting here.
    statements.push(...sweepSnapshots(env.DB, "page", input.id, slug, SNAPSHOT.page(slug)));
    // Last, so it wins over the lines above: an address a page now owns never redirects.
    statements.push(del(env.DB, SNAPSHOT.redirect(slug)));
    await env.DB.batch(statements);
    return page;
}

/**
 * Takes a page off the site (unpublished or in Trash). Its addresses, the current one included, are kept
 * for it (see offSite): they answer 404 while it's off the site and lead to it again when it's back, even
 * at a new address. `forget` is for a page deleted for good: its addresses are released.
 */
export async function unpublishPage(
    env: PublisherEnv,
    id: string | number,
    options: { forget?: boolean; now?: Date; createdAt?: string | null } = {},
): Promise<boolean> {
    // What's on the site under this number is an earlier document's: not this one's to take down.
    if (await earlierDocumentsSlug(env.DB, "page", id, options.createdAt)) return false;
    const slug = await currentSlug(env.DB, pageIdKey(id));
    const marker = offSite("page", id);
    const statements = slug ? [del(env.DB, SNAPSHOT.page(slug)), del(env.DB, pageIdKey(id))] : [del(env.DB, pageIdKey(id))];
    if (options.forget) {
        statements.push(dropRedirectsTo(env.DB, "page-redirect:", marker));
        if (slug) statements.push(dropRedirectsTo(env.DB, "page-redirect:", slug));
    } else if (slug) {
        statements.push(repoint(env.DB, "page-redirect:", slug, marker), put(env.DB, SNAPSHOT.redirect(slug), marker));
    }
    // By the id inside the snapshot as well: a save that overlapped this one may have moved the page meanwhile.
    const sweep = sweepSnapshots(env.DB, "page", id, options.forget ? null : marker);
    const swept = statements.length + sweep.length - 1;
    statements.push(...sweep, put(env.DB, SNAPSHOT.pagesManaged, true));
    // Nothing public changes when the page wasn't on the site: cached pages stay as they are.
    const at = (options.now ?? new Date()).toISOString();
    if (slug || options.forget) statements.push(bump(env.DB, at));
    const results = await env.DB.batch(statements);
    const sweptSome = (results[swept]?.meta?.changes ?? 0) > 0;
    if (sweptSome && !slug && !options.forget) await bump(env.DB, at).run();
    return Boolean(slug) || sweptSome;
}

/** Slugs of the pages currently on the site. */
export async function publishedSlugs(db: D1Database): Promise<Set<string>> {
    const { results } = await db.prepare("SELECT value FROM meta WHERE key LIKE 'page-id:%'").all<{ value: string }>();
    return new Set(results.map((r) => JSON.parse(r.value) as string));
}

// --- Projects (Phase 4) ---------------------------------------------------------------------------------

export interface ProjectInput {
    /** Payload's id: it tracks the project's address across renames. */
    id: string | number;
    slug: string;
    title: string;
    summary?: string | null;
    content?: { root?: LexicalNode } | null;
    heroMediaId?: string | number | null;
    gallery?: Array<{ mediaId: string | number | null; caption?: string | null }> | null;
    status?: string | null;
    tags?: string[] | null;
    featured?: boolean | null;
    order?: number | null;
    websiteUrl?: string | null;
    githubUrl?: string | null;
    links?: Array<{ label?: string | null; url?: string | null }> | null;
    seoTitle?: string | null;
    seoDescription?: string | null;
    publishedAt?: string | null;
    /** When Payload created the document: tells it apart from an earlier one that had the same number. */
    createdAt?: string | null;
    updatedAt?: string | null;
}

const projectKey = (slug: string) => `project:${slug}`;
const projectIdKey = (id: string | number) => `project-id:${id}`;
export const projectRedirectKey = (slug: string) => `project-redirect:${slug}`;

/** Why this project can't be published, or null. Pure: used before saving too. */
export function projectProblem(input: Pick<ProjectInput, "slug" | "title" | "status" | "websiteUrl" | "githubUrl" | "links">): string | null {
    if (!input.title?.trim()) return "A published project needs a title.";
    if (!PAGE_SLUG.test(input.slug ?? "") || (input.slug ?? "").length > 80)
        return "Give the project an address made of lower-case letters, numbers and single hyphens.";
    if (input.status && !PROJECT_STATUSES.some((s) => s.value === input.status)) return "Choose a status: Active, Completed, Experimental or Archived.";
    for (const [label, url] of [
        ["Website", input.websiteUrl],
        ["GitHub", input.githubUrl],
    ] as const)
        if (url && !/^https?:\/\//.test(safeLink(url) ?? "")) return `The ${label} link needs a full https:// address.`;
    for (const [i, link] of (input.links ?? []).entries()) {
        if (!link.label?.trim()) return `Link ${i + 1} needs a label.`;
        if (!/^https?:\/\//.test(safeLink(link.url) ?? "")) return `Link "${link.label}" needs a full https:// address.`;
    }
    return null;
}

/**
 * Rebuilds the list of public projects (cards, the index, the sitemap) from the published snapshots, inside
 * the database: the statement goes last in the same batch as the change, so it reads the rows as that batch
 * has just left them. D1 runs a batch as one transaction and one write at a time, so:
 * - the project and the list are written together or not at all, and
 * - two projects published at the same moment can't each write a list that misses the other (a list built
 *   in the Worker from an earlier read could).
 * The list holds each snapshot without its long fields; the readers normalise and sort it (projectList).
 */
const rebuildProjectIndex = (db: D1Database) =>
    db
        .prepare(
            `INSERT INTO meta (key, value)
             SELECT ?1, (
                 SELECT json_group_array(json(summary)) FROM (
                     SELECT json_remove(value, '$.bodyHtml', '$.gallery', '$.links', '$.seoTitle', '$.seoDescription') AS summary
                     FROM meta
                     WHERE substr(key, 1, 8) = 'project:' AND json_valid(value)
                     ORDER BY json_extract(value, '$.featured') DESC, json_extract(value, '$.order'), json_extract(value, '$.title') COLLATE NOCASE
                 )
             )
             WHERE true
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .bind(SNAPSHOT.projects);

/** Rebuilds the project list on its own (the Republish action, when only the list is out of step). */
export async function republishProjectList(env: Pick<PublisherEnv, "DB">, now = new Date()): Promise<void> {
    await env.DB.batch([rebuildProjectIndex(env.DB), bump(env.DB, now.toISOString())]);
}

/** Publishes a project at daly.id.au/projects/<slug>. A renamed project's old address redirects. */
export async function publishProject(env: PublisherEnv, input: ProjectInput, ctx: MediaLoader): Promise<Project> {
    const now = (ctx.now?.() ?? new Date()).toISOString();
    const problem = projectProblem(input);
    if (problem) throw new PublishError(problem);
    const slug = input.slug;
    const mode = ctx.mode ?? "publish";
    // A preview claims no address; a check and a publish refuse one another item holds.
    if (mode !== "preview") {
        const owner = await env.DB.prepare("SELECT value FROM meta WHERE key = ?").bind(projectKey(slug)).first<{ value: string }>();
        // A damaged snapshot belongs to nobody: it can be replaced.
        const ownerId = owner ? ownerOf(owner.value) : undefined;
        if (owner && ownerId !== undefined && String(ownerId) !== String(input.id))
            throw new PublishError(`daly.id.au/projects/${slug} is already used by another project.`);
        const earlier = await earlierDocumentsSlug(env.DB, "project", input.id, input.createdAt);
        if (earlier) throw new PublishError(EARLIER("project", earlier));
    }

    const stored = new Map<string, { key: string; alt: string; width: number | null; height: number | null; caption?: string | null }>();
    const copy = async (id: string | number) => {
        const key = String(id);
        if (stored.has(key)) return stored.get(key)!;
        const file = await ctx.loadMedia(id);
        if (!file) return null;
        const image = await storePublicImage(env, `payload-media:${key}`, file, now, mode);
        if (image) stored.set(key, { ...image, caption: file.caption ?? null });
        return image;
    };
    const asImage = (img: { key: string; alt: string; width: number | null; height: number | null }) => ({
        src: `/media/${img.key}`,
        alt: img.alt,
        width: img.width ?? undefined,
        height: img.height ?? undefined,
    });

    let image: Project["image"] = null;
    if (input.heroMediaId !== undefined && input.heroMediaId !== null) {
        const hero = await copy(input.heroMediaId);
        if (!hero) throw new PublishError("The cover image couldn't be read, or isn't a JPEG, PNG, GIF, WebP or AVIF under 15 MB.");
        image = asImage(hero);
    }
    const gallery: Project["gallery"] = [];
    for (const [i, item] of (input.gallery ?? []).entries()) {
        if (item.mediaId === null || item.mediaId === undefined) continue;
        const shot = await copy(item.mediaId);
        if (!shot) throw new PublishError(`Screenshot ${i + 1} couldn't be read, or isn't a JPEG, PNG, GIF, WebP or AVIF under 15 MB.`);
        gallery.push({ ...asImage(shot), caption: item.caption?.trim() || null });
    }
    const root = input.content?.root;
    let bodyHtml = "";
    if (lexicalHasContent(root)) {
        for (const id of uploadIds(root))
            if (!(await copy(id)))
                throw new PublishError(
                    "An image in the text couldn't be read, or isn't a JPEG, PNG, GIF, WebP or AVIF under 15 MB. Remove it or upload it again.",
                );
        bodyHtml = renderLexical(root, {
            siteUrl: env.SITE_URL,
            image: (id) => {
                const img = stored.get(String(id));
                return img ? { ...img, ...mediaUrls(img.key, img.width, !!ctx.transforms) } : null;
            },
        }).html;
    }
    const snapshot = {
        id: input.id,
        slug,
        title: input.title.trim(),
        summary: input.summary?.trim() ?? "",
        status: input.status || "active",
        tags: [...new Set((input.tags ?? []).map((t) => t.trim()).filter(Boolean))],
        featured: !!input.featured,
        order: typeof input.order === "number" && Number.isFinite(input.order) ? input.order : 0,
        image,
        websiteUrl: input.websiteUrl ? safeLink(input.websiteUrl) : null,
        githubUrl: input.githubUrl ? safeLink(input.githubUrl) : null,
        bodyHtml,
        gallery,
        links: (input.links ?? []).map((l) => ({ label: l.label!.trim(), url: safeLink(l.url)! })),
        seoTitle: input.seoTitle?.trim() || null,
        seoDescription: input.seoDescription?.trim() || null,
        publishedAt: input.publishedAt ?? now,
        updatedAt: input.updatedAt ?? now,
    };
    const project = normaliseProject(snapshot);
    if (!project) throw new PublishError("This project can't be published as it is.");
    if (mode !== "publish") return project;

    const previousSlug = await currentSlug(env.DB, projectIdKey(input.id));
    const statements = [
        put(env.DB, projectKey(slug), snapshot),
        put(env.DB, projectIdKey(input.id), slug),
        // Addresses this project had before it was last taken off the site lead to it again.
        repoint(env.DB, "project-redirect:", offSite("project", input.id), slug),
    ];
    if (previousSlug && previousSlug !== slug) {
        statements.push(del(env.DB, projectKey(previousSlug)), put(env.DB, projectRedirectKey(previousSlug), slug));
        statements.push(repoint(env.DB, "project-redirect:", previousSlug, slug));
    }
    // Any other snapshot of this project (an overlapping save's) goes too, leaving its address redirecting here.
    statements.push(...sweepSnapshots(env.DB, "project", input.id, slug, projectKey(slug)));
    // Last, so it wins over the lines above: an address a project now owns never redirects.
    statements.push(del(env.DB, projectRedirectKey(slug)));
    statements.push(rebuildProjectIndex(env.DB), bump(env.DB, now));
    await env.DB.batch(statements);
    return project;
}

/**
 * Takes a project off the site (unpublished, hidden or in Trash), in one batch with the project list
 * (rebuildProjectIndex).
 * Its addresses, the current one included, are kept for it (see offSite): they answer 404 while it's off
 * the site and lead to it again when it's back, even at a new address. `forget` is for a project deleted
 * for good: its addresses are released.
 */
export async function unpublishProject(
    env: PublisherEnv,
    id: string | number,
    options: { forget?: boolean; now?: Date; createdAt?: string | null } = {},
): Promise<boolean> {
    // What's on the site under this number is an earlier document's: not this one's to take down.
    if (await earlierDocumentsSlug(env.DB, "project", id, options.createdAt)) return false;
    const slug = await currentSlug(env.DB, projectIdKey(id));
    const marker = offSite("project", id);
    const statements = slug ? [del(env.DB, projectKey(slug)), del(env.DB, projectIdKey(id))] : [del(env.DB, projectIdKey(id))];
    if (options.forget) {
        statements.push(dropRedirectsTo(env.DB, "project-redirect:", marker));
        if (slug) statements.push(dropRedirectsTo(env.DB, "project-redirect:", slug));
    } else if (slug) {
        statements.push(repoint(env.DB, "project-redirect:", slug, marker), put(env.DB, projectRedirectKey(slug), marker));
    }
    // By the id inside the snapshot as well: a save that overlapped this one may have moved the project meanwhile.
    const sweep = sweepSnapshots(env.DB, "project", id, options.forget ? null : marker);
    const swept = statements.length + sweep.length - 1;
    statements.push(...sweep, rebuildProjectIndex(env.DB), bump(env.DB, (options.now ?? new Date()).toISOString()));
    const results = await env.DB.batch(statements);
    return Boolean(slug) || (results[swept]?.meta?.changes ?? 0) > 0;
}

/** The projects-first homepage's words, validated. Pure. */
export function projectsHomeSnapshot(input: Partial<Record<keyof ProjectsHomeContent, unknown>>) {
    const count = input.writingCount;
    const snapshot = {
        heroTitle: strict(input.heroTitle, "Hero title", 160),
        heroIntro: strict(input.heroIntro, "Hero introduction", 600),
        heroCtaLabel: strict(input.heroCtaLabel, "Hero link text", 60),
        projectsHeading: strict(input.projectsHeading, "Projects heading", 120),
        projectsIntro: typeof input.projectsIntro === "string" ? input.projectsIntro.trim() : "",
        showMoreProjects: input.showMoreProjects !== false,
        showWriting: input.showWriting !== false,
        writingHeading: strict(input.writingHeading, "Writing heading", 120),
        writingCount:
            typeof count === "number" && Number.isInteger(count) && count >= 0 && count <= 6
                ? count
                : (() => {
                      throw new PublishError("Show between 0 and 6 articles.");
                  })(),
        showAbout: input.showAbout !== false,
        aboutHeading: strict(input.aboutHeading, "About heading", 120),
        aboutText: strict(input.aboutText, "About text", 1200),
    };
    return snapshot;
}

export async function publishProjectsHome(
    env: PublisherEnv,
    input: Partial<Record<keyof ProjectsHomeContent, unknown>>,
    now = new Date(),
): Promise<ProjectsHomeContent> {
    const snapshot = projectsHomeSnapshot(input);
    await env.DB.batch([put(env.DB, SNAPSHOT.projectsHome, snapshot), bump(env.DB, now.toISOString())]);
    return normaliseProjectsHome(snapshot);
}
