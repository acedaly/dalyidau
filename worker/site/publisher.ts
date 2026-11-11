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
    type PublicPage,
    type SiteSettings,
    normaliseHome,
    normalisePage,
    normaliseSite,
    pageSlugProblem,
    safeLink,
} from "../../src/shared/site-content";
import { type LexicalNode, type MediaFile, PublishError, type PublisherEnv, lexicalHasContent, renderLexical, storePublicImage, uploadIds } from "../blog/payload-publisher";
import { mediaUrls } from "../lib/image";
import { SNAPSHOT } from "./content";

export { PublishError };

const bump = (db: D1Database, now: string) =>
    db.prepare("INSERT INTO meta (key, value) VALUES ('content_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(now);
const put = (db: D1Database, key: string, value: unknown) =>
    db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(key, JSON.stringify(value));
const del = (db: D1Database, key: string) => db.prepare("DELETE FROM meta WHERE key = ?").bind(key);
const pageIdKey = (id: string | number) => `page-id:${id}`;

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
        ctaHref: safeLink(input.ctaHref) ?? (() => { throw new PublishError("The button needs a link: a path such as /blog, or a full https:// address."); })(),
        latestEyebrow: strict(input.latestEyebrow, "Latest posts label", 80),
        latestHeading: strict(input.latestHeading, "Latest posts heading", 120),
        latestCount: typeof input.latestCount === "number" && Number.isInteger(input.latestCount) && input.latestCount >= 0 && input.latestCount <= 12 ? input.latestCount : (() => { throw new PublishError("Show between 0 and 12 latest posts."); })(),
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
    const owner = await env.DB.prepare("SELECT value FROM meta WHERE key = ?").bind(SNAPSHOT.page(slug)).first<{ value: string }>();
    const ownerId = owner ? (JSON.parse(owner.value) as { id?: unknown }).id : undefined;
    if (owner && ownerId !== undefined && String(ownerId) !== String(input.id)) throw new PublishError(`daly.id.au/${slug} is already used by another page.`);

    const stored = new Map<string, { key: string; alt: string; width: number | null; height: number | null; caption?: string | null }>();
    const copy = async (id: string | number) => {
        const key = String(id);
        if (stored.has(key)) return stored.get(key)!;
        const file = await ctx.loadMedia(id);
        if (!file) return null;
        const image = await storePublicImage(env, `payload-media:${key}`, file, now);
        if (image) stored.set(key, { ...image, caption: file.caption ?? null });
        return image;
    };
    const root = input.content?.root;
    let bodyHtml = "";
    if (lexicalHasContent(root)) {
        for (const id of uploadIds(root)) await copy(id);
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

    const previous = (await env.DB.prepare("SELECT value FROM meta WHERE key = ?").bind(pageIdKey(input.id)).first<{ value: string }>())?.value;
    const previousSlug = previous ? (JSON.parse(previous) as string) : null;
    const statements = [
        put(env.DB, SNAPSHOT.page(slug), snapshot),
        put(env.DB, pageIdKey(input.id), slug),
        // An address a page now owns never redirects.
        del(env.DB, SNAPSHOT.redirect(slug)),
        put(env.DB, SNAPSHOT.pagesManaged, true),
        bump(env.DB, now),
    ];
    if (previousSlug && previousSlug !== slug) {
        statements.push(del(env.DB, SNAPSHOT.page(previousSlug)), put(env.DB, SNAPSHOT.redirect(previousSlug), slug));
        // Earlier addresses of this page follow it to its new one.
        statements.push(
            env.DB.prepare("UPDATE meta SET value = ? WHERE key LIKE 'page-redirect:%' AND value = ?").bind(JSON.stringify(slug), JSON.stringify(previousSlug)),
        );
    }
    await env.DB.batch(statements);
    return page;
}

/** Takes a page off the site (unpublished, in Trash or deleted). Its old addresses stop redirecting. */
export async function unpublishPage(env: PublisherEnv, id: string | number, now = new Date()): Promise<boolean> {
    const current = (await env.DB.prepare("SELECT value FROM meta WHERE key = ?").bind(pageIdKey(id)).first<{ value: string }>())?.value;
    const slug = current ? (JSON.parse(current) as string) : null;
    await env.DB.batch([
        ...(slug
            ? [
                  del(env.DB, SNAPSHOT.page(slug)),
                  env.DB.prepare("DELETE FROM meta WHERE key LIKE 'page-redirect:%' AND value = ?").bind(JSON.stringify(slug)),
              ]
            : []),
        del(env.DB, pageIdKey(id)),
        put(env.DB, SNAPSHOT.pagesManaged, true),
        bump(env.DB, now.toISOString()),
    ]);
    return Boolean(slug);
}

/** Slugs of the pages currently on the site. */
export async function publishedSlugs(db: D1Database): Promise<Set<string>> {
    const { results } = await db.prepare("SELECT value FROM meta WHERE key LIKE 'page-id:%'").all<{ value: string }>();
    return new Set(results.map((r) => JSON.parse(r.value) as string));
}
