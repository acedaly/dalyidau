// The public site's editable content (docs/PAYLOAD-FRONTEND-PLAN.md). Payload is where it's edited;
// its hooks publish snapshots of it into D1 (worker/site/publisher.ts) and the renderer reads them
// (worker/site/content.ts). The defaults below are the site as it was before Payload managed it, and
// they're what renders whenever a snapshot is missing or doesn't validate.
//
// Shared by the Worker and the browser: no Node or Worker APIs here.

export type SocialKind = "linkedin" | "github" | "x" | "instagram" | "youtube";
export const SOCIAL_KINDS: SocialKind[] = ["linkedin", "github", "x", "instagram", "youtube"];

export interface NavItem {
    label: string;
    href: string;
}

export interface SiteSettings {
    name: string;
    /** Initials in the logo mark. */
    shortName: string;
    /** The homepage's <title>. */
    title: string;
    description: string;
    blogTitle: string;
    blogDescription: string;
    /** Public contact email; null hides it everywhere. */
    email: string | null;
    socials: { label: string; href: string; kind: SocialKind }[];
    nav: NavItem[];
    /** Default social preview image (site-relative or absolute https). */
    seoImage: string | null;
    /** After "© <year>" in the footer; defaults to the site name. */
    footerText: string | null;
    contact: { eyebrow: string; heading: string; intro: string; emailDescription: string };
    /** Never changes per deployment: the canonical origin and language. */
    url: string;
    locale: string;
    language: string;
}

export interface HomeContent {
    eyebrow: string;
    heading: string;
    /** The italic ending of the heading. */
    headingEmphasis: string;
    intro: string;
    ctaLabel: string;
    ctaHref: string;
    latestEyebrow: string;
    latestHeading: string;
    latestCount: number;
    aboutHeading: string;
    aboutParagraphs: string[];
    /** Show the "Have a thought to share? Say hello" line (when there's an email). */
    showContactLine: boolean;
    seoTitle: string | null;
    seoDescription: string | null;
}

/**
 * What a post, page or project says about itself to search engines and link previews. Every part is
 * optional: anything left out falls back to the content's own title, summary and image (worker/seo.ts).
 */
export interface Seo {
    title: string | null;
    description: string | null;
    /** The address search engines should treat as the original: a path on this site or a full https address. */
    canonical: string | null;
    socialTitle: string | null;
    socialDescription: string | null;
    image: { src: string; alt: string; width?: number; height?: number } | null;
    /** Ask search engines not to list it (it is also left out of the sitemap). */
    noindex: boolean;
}
export const NO_SEO: Seo = { title: null, description: null, canonical: null, socialTitle: null, socialDescription: null, image: null, noindex: false };
export const SEO_LIMITS = { title: 120, description: 300 } as const;

/** A published CMS page as the renderer gets it. `bodyHtml` was built by the escaping Lexical renderer. */
export interface PublicPage {
    slug: string;
    title: string;
    lede: string | null;
    bodyHtml: string;
    /** Plain paragraphs, used by the built-in About page before Payload has published one. */
    paragraphs?: string[];
    image: { src: string; alt: string; width?: number; height?: number } | null;
    showButtons: boolean;
    seoTitle: string | null;
    seoDescription: string | null;
    seo: Seo;
    updatedAt: string | null;
}

export const DEFAULT_SITE: SiteSettings = {
    name: "Aidan Daly",
    shortName: "AD",
    title: "Aidan Daly",
    description:
        "Aidan Daly's little corner of the internet: what I'm thinking, what I'm learning, and the occasional project or idea worth putting into words.",
    blogTitle: "Blog",
    blogDescription: "What I'm thinking about, what I'm learning, and the occasional project or idea worth putting into words.",
    email: "hello@daly.id.au",
    socials: [],
    nav: [
        { label: "Home", href: "/" },
        { label: "Blog", href: "/blog" },
        { label: "About", href: "/about" },
        { label: "Contact", href: "/contact" },
    ],
    seoImage: null,
    footerText: null,
    contact: {
        eyebrow: "Contact",
        heading: "Get in touch",
        intro: "Questions, ideas or just saying hello. Here's where to find me.",
        emailDescription: "The best way to reach me. I read everything, though replies can take a little while.",
    },
    url: "https://daly.id.au",
    locale: "en_AU",
    language: "en-AU",
};

export const DEFAULT_HOME: HomeContent = {
    eyebrow: "HELLO, I'M AIDAN",
    heading: "Some things are worth",
    headingEmphasis: "writing down.",
    intro: "A place for what I'm learning about people, work and the projects I get carried away with. Not everything fits a theme. That's fine with me.",
    ctaLabel: "Have a read",
    ctaHref: "/blog",
    latestEyebrow: "From the notebook",
    latestHeading: "Recent writing",
    latestCount: 3,
    aboutHeading: "An assortment, really.",
    aboutParagraphs: [
        "Some notes are about leadership and learning. Others are about technology, making things, or ideas I haven't quite finished thinking through.",
        "This is closer to an open notebook than a newsletter. Drop in whenever you like.",
    ],
    showContactLine: true,
    seoTitle: null,
    seoDescription: null,
};

/** The About page before Payload publishes one (and the seed for Payload's About page). */
export const DEFAULT_ABOUT: PublicPage = {
    slug: "about",
    title: "About",
    lede: "Hi, I'm Aidan. This is where I write things down.",
    bodyHtml: "",
    paragraphs: [
        "Most of what ends up here starts as something I'm thinking about, something I'm learning, or a project I've been tinkering with.",
        "A lot of my working life has been about helping people learn and do their jobs well, so leadership and learning come up often. I also like building useful things with technology, usually small tools that make everyday life a bit easier.",
        "Beyond that, expect personal projects, things I've experienced and ideas I'm still working through. Some posts will be polished. Plenty won't be.",
        "If something here is useful to you, or you reckon I've got it wrong, I'd like to hear about it.",
    ],
    image: null,
    showButtons: true,
    seoTitle: null,
    seoDescription: "Hi, I'm Aidan. I write about leadership and learning, building useful things, personal projects, and life in general.",
    seo: { ...NO_SEO, description: "Hi, I'm Aidan. I write about leadership and learning, building useful things, personal projects, and life in general." },
    updatedAt: null,
};

/**
 * Addresses that belong to the application. A CMS page can never take one, whatever Payload is told:
 * the publisher refuses them and the router checks its own routes first.
 */
export const RESERVED_SLUGS = new Set([
    "admin",
    "api",
    "assets",
    "blog",
    "cdn-cgi",
    "cms",
    "contact",
    "feed.xml",
    "icons",
    "index",
    "invitation",
    "media",
    "planner",
    "poc",
    "portal",
    "projects",
    "robots.txt",
    "rss.xml",
    "rsvp",
    "save-the-date",
    "sitemap.xml",
    "wedding",
    "_next",
]);

export const PAGE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Why a page can't use this address, or null when it can. */
export const pageSlugProblem = (slug: string): string | null => {
    if (!PAGE_SLUG.test(slug) || slug.length > 80) return "Use lower-case letters, numbers and single hyphens (up to 80 characters).";
    if (RESERVED_SLUGS.has(slug)) return `daly.id.au/${slug} belongs to the site itself. Choose another address.`;
    return null;
};

// --- Validation -----------------------------------------------------------------------------------
// Snapshots come from D1. Anything that isn't the expected shape falls back to the default, field by field.

const str = (value: unknown, fallback: string, max = 500): string => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : fallback);
const optStr = (value: unknown, max = 500): string | null => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);

/** Links the site may render: site-relative paths, #anchors, http(s) and mailto. */
export const safeLink = (value: unknown): string | null => {
    if (typeof value !== "string") return null;
    const v = value.trim();
    if (/^\/(?!\/)[^\s\\]*$/.test(v) || /^#[\w-]+$/.test(v)) return v;
    if (/^mailto:[^\s<>"]+@[^\s<>"]+$/i.test(v)) return v;
    try {
        const url = new URL(v);
        return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
    } catch {
        return null;
    }
};

/** A canonical address: a path on this site, or a full http(s) address. Anything else is dropped. */
export const canonicalLink = (value: unknown): string | null => {
    const link = safeLink(value);
    return link && (link.startsWith("/") || /^https?:\/\//.test(link)) ? link : null;
};

/**
 * Search and sharing settings as stored in a snapshot. `earlier` is the title and description snapshots
 * carried before the rest existed (seoTitle, seoDescription): still honoured.
 */
export function normaliseSeo(input: unknown, earlier: { title?: unknown; description?: unknown } = {}): Seo {
    const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    const image = o.image && typeof o.image === "object" ? (o.image as Record<string, unknown>) : null;
    const src = image ? safeLink(image.src) : null;
    return {
        title: optStr(o.title, SEO_LIMITS.title) ?? optStr(earlier.title, SEO_LIMITS.title),
        description: optStr(o.description, SEO_LIMITS.description) ?? optStr(earlier.description, SEO_LIMITS.description),
        canonical: canonicalLink(o.canonical),
        socialTitle: optStr(o.socialTitle, SEO_LIMITS.title),
        socialDescription: optStr(o.socialDescription, SEO_LIMITS.description),
        image:
            image && src && src.startsWith("/media/")
                ? {
                      src,
                      alt: typeof image.alt === "string" ? image.alt.slice(0, 300) : "",
                      width: typeof image.width === "number" ? image.width : undefined,
                      height: typeof image.height === "number" ? image.height : undefined,
                  }
                : null,
        noindex: o.noindex === true,
    };
}

const isEmail = (value: unknown): value is string => typeof value === "string" && /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(value.trim());

export function normaliseSite(input: unknown): SiteSettings {
    if (!input || typeof input !== "object") return DEFAULT_SITE;
    const o = input as Record<string, unknown>;
    const d = DEFAULT_SITE;
    const contact = (o.contact && typeof o.contact === "object" ? o.contact : {}) as Record<string, unknown>;
    const nav = Array.isArray(o.nav)
        ? (o.nav as unknown[])
              .map((item) => {
                  const i = (item ?? {}) as Record<string, unknown>;
                  const label = optStr(i.label, 60);
                  const href = safeLink(i.href);
                  return label && href ? { label, href } : null;
              })
              .filter((x): x is NavItem => Boolean(x))
              .slice(0, 12)
        : null;
    const socials = Array.isArray(o.socials)
        ? (o.socials as unknown[])
              .map((item) => {
                  const i = (item ?? {}) as Record<string, unknown>;
                  const href = safeLink(i.href);
                  const kind = SOCIAL_KINDS.includes(i.kind as SocialKind) ? (i.kind as SocialKind) : null;
                  return href && /^https?:/.test(href) && kind ? { label: str(i.label, kind, 60), href, kind } : null;
              })
              .filter((x): x is SiteSettings["socials"][number] => Boolean(x))
              .slice(0, 10)
        : d.socials;
    return {
        name: str(o.name, d.name, 80),
        shortName: str(o.shortName, d.shortName, 4),
        title: str(o.title, d.title, 120),
        description: str(o.description, d.description, 300),
        blogTitle: str(o.blogTitle, d.blogTitle, 80),
        blogDescription: str(o.blogDescription, d.blogDescription, 300),
        // An explicit null (or empty) hides the email; anything else that isn't an address keeps the default.
        email: o.email === null || o.email === "" ? null : isEmail(o.email) ? o.email.trim() : d.email,
        socials,
        nav: nav && nav.length ? nav : d.nav,
        seoImage: safeLink(o.seoImage),
        footerText: optStr(o.footerText, 120),
        contact: {
            eyebrow: str(contact.eyebrow, d.contact.eyebrow, 60),
            heading: str(contact.heading, d.contact.heading, 120),
            intro: str(contact.intro, d.contact.intro, 400),
            emailDescription: str(contact.emailDescription, d.contact.emailDescription, 300),
        },
        url: d.url,
        locale: d.locale,
        language: d.language,
    };
}

export function normaliseHome(input: unknown): HomeContent {
    if (!input || typeof input !== "object") return DEFAULT_HOME;
    const o = input as Record<string, unknown>;
    const d = DEFAULT_HOME;
    const count = typeof o.latestCount === "number" && Number.isInteger(o.latestCount) ? Math.min(Math.max(o.latestCount, 0), 12) : d.latestCount;
    const paragraphs = Array.isArray(o.aboutParagraphs)
        ? (o.aboutParagraphs as unknown[])
              .map((p) => optStr(p, 2000))
              .filter((p): p is string => Boolean(p))
              .slice(0, 10)
        : d.aboutParagraphs;
    return {
        eyebrow: str(o.eyebrow, d.eyebrow, 80),
        heading: str(o.heading, d.heading, 200),
        headingEmphasis: typeof o.headingEmphasis === "string" ? o.headingEmphasis.trim().slice(0, 120) : d.headingEmphasis,
        intro: str(o.intro, d.intro, 1000),
        ctaLabel: str(o.ctaLabel, d.ctaLabel, 60),
        ctaHref: safeLink(o.ctaHref) ?? d.ctaHref,
        latestEyebrow: str(o.latestEyebrow, d.latestEyebrow, 80),
        latestHeading: str(o.latestHeading, d.latestHeading, 120),
        latestCount: count,
        aboutHeading: str(o.aboutHeading, d.aboutHeading, 200),
        aboutParagraphs: paragraphs,
        showContactLine: typeof o.showContactLine === "boolean" ? o.showContactLine : d.showContactLine,
        seoTitle: optStr(o.seoTitle, 120),
        seoDescription: optStr(o.seoDescription, 300),
    };
}

/** A published page snapshot, or null when it isn't one. Its HTML was escaped when it was published. */
export function normalisePage(input: unknown): PublicPage | null {
    if (!input || typeof input !== "object") return null;
    const o = input as Record<string, unknown>;
    if (typeof o.slug !== "string" || pageSlugProblem(o.slug) || typeof o.title !== "string" || !o.title.trim()) return null;
    const image = o.image && typeof o.image === "object" ? (o.image as Record<string, unknown>) : null;
    const src = image ? safeLink(image.src) : null;
    return {
        slug: o.slug,
        title: o.title.trim().slice(0, 200),
        lede: optStr(o.lede, 1000),
        bodyHtml: typeof o.bodyHtml === "string" ? o.bodyHtml : "",
        image:
            image && src && src.startsWith("/")
                ? {
                      src,
                      alt: typeof image.alt === "string" ? image.alt.slice(0, 300) : "",
                      width: typeof image.width === "number" ? image.width : undefined,
                      height: typeof image.height === "number" ? image.height : undefined,
                  }
                : null,
        showButtons: o.showButtons === true,
        seoTitle: optStr(o.seoTitle, 120),
        seoDescription: optStr(o.seoDescription, 300),
        seo: normaliseSeo(o.seo, { title: o.seoTitle, description: o.seoDescription }),
        updatedAt: optStr(o.updatedAt, 40),
    };
}

// --- Projects and the projects-first homepage (Phase 4) ----------------------------------------------

export type ProjectStatus = "active" | "completed" | "experimental" | "archived";
export const PROJECT_STATUSES: { value: ProjectStatus; label: string }[] = [
    { value: "active", label: "Active" },
    { value: "completed", label: "Completed" },
    { value: "experimental", label: "Experimental" },
    { value: "archived", label: "Archived" },
];
export const projectStatusLabel = (status: ProjectStatus) => PROJECT_STATUSES.find((s) => s.value === status)?.label ?? "Active";

export interface SiteImage {
    src: string;
    alt: string;
    width?: number;
    height?: number;
}

/** A published, listed project as cards and the index show it. */
export interface ProjectSummary {
    slug: string;
    title: string;
    summary: string;
    status: ProjectStatus;
    tags: string[];
    featured: boolean;
    order: number;
    image: SiteImage | null;
    websiteUrl: string | null;
    githubUrl: string | null;
    updatedAt: string | null;
    /** Kept out of the sitemap (and search engines are asked not to list it). */
    noindex: boolean;
}

export interface Project extends ProjectSummary {
    /** Built from Payload's rich text by the escaping renderer when published. */
    bodyHtml: string;
    gallery: (SiteImage & { caption?: string | null })[];
    links: { label: string; url: string }[];
    seoTitle: string | null;
    seoDescription: string | null;
    seo: Seo;
    publishedAt: string | null;
}

/** The projects-first homepage's own words (separate from today's homepage until it's switched on). */
export interface ProjectsHomeContent {
    heroTitle: string;
    heroIntro: string;
    heroCtaLabel: string;
    projectsHeading: string;
    projectsIntro: string;
    showMoreProjects: boolean;
    showWriting: boolean;
    writingHeading: string;
    writingCount: number;
    showAbout: boolean;
    aboutHeading: string;
    aboutText: string;
}

export const DEFAULT_PROJECTS_HOME: ProjectsHomeContent = {
    heroTitle: "Building things that interest me.",
    heroIntro: "A collection of personal projects, experiments, ideas and the occasional bit of writing.",
    heroCtaLabel: "Explore projects",
    projectsHeading: "Selected projects",
    projectsIntro: "Things I've built, am building, or am still working out.",
    showMoreProjects: true,
    showWriting: true,
    writingHeading: "Latest writing",
    writingCount: 3,
    showAbout: true,
    aboutHeading: "About",
    aboutText: "Hi, I'm Aidan. I write about leadership and learning, building useful things, personal projects, and life in general.",
};

export function normaliseProjectsHome(input: unknown): ProjectsHomeContent {
    if (!input || typeof input !== "object") return DEFAULT_PROJECTS_HOME;
    const o = input as Record<string, unknown>;
    const d = DEFAULT_PROJECTS_HOME;
    const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
    const count = typeof o.writingCount === "number" && Number.isInteger(o.writingCount) ? Math.min(Math.max(o.writingCount, 0), 6) : d.writingCount;
    return {
        heroTitle: str(o.heroTitle, d.heroTitle, 160),
        heroIntro: str(o.heroIntro, d.heroIntro, 600),
        heroCtaLabel: str(o.heroCtaLabel, d.heroCtaLabel, 60),
        projectsHeading: str(o.projectsHeading, d.projectsHeading, 120),
        projectsIntro: typeof o.projectsIntro === "string" ? o.projectsIntro.trim().slice(0, 400) : d.projectsIntro,
        showMoreProjects: bool(o.showMoreProjects, d.showMoreProjects),
        showWriting: bool(o.showWriting, d.showWriting),
        writingHeading: str(o.writingHeading, d.writingHeading, 120),
        writingCount: count,
        showAbout: bool(o.showAbout, d.showAbout),
        aboutHeading: str(o.aboutHeading, d.aboutHeading, 120),
        aboutText: str(o.aboutText, d.aboutText, 1200),
    };
}

const STATUS_VALUES = new Set(PROJECT_STATUSES.map((s) => s.value));
const httpsLink = (value: unknown): string | null => {
    const link = safeLink(value);
    return link && /^https?:\/\//.test(link) ? link : null;
};
const siteImage = (value: unknown): SiteImage | null => {
    if (!value || typeof value !== "object") return null;
    const i = value as Record<string, unknown>;
    const src = safeLink(i.src);
    if (!src || !src.startsWith("/media/")) return null;
    return {
        src,
        alt: typeof i.alt === "string" ? i.alt.slice(0, 300) : "",
        width: typeof i.width === "number" ? i.width : undefined,
        height: typeof i.height === "number" ? i.height : undefined,
    };
};

export function normaliseProjectSummary(input: unknown): ProjectSummary | null {
    if (!input || typeof input !== "object") return null;
    const o = input as Record<string, unknown>;
    if (typeof o.slug !== "string" || !PAGE_SLUG.test(o.slug) || typeof o.title !== "string" || !o.title.trim()) return null;
    return {
        slug: o.slug,
        title: o.title.trim().slice(0, 160),
        summary: typeof o.summary === "string" ? o.summary.trim().slice(0, 600) : "",
        status: STATUS_VALUES.has(o.status as ProjectStatus) ? (o.status as ProjectStatus) : "active",
        tags: Array.isArray(o.tags)
            ? (o.tags as unknown[])
                  .filter((t): t is string => typeof t === "string" && !!t.trim())
                  .map((t) => t.trim().slice(0, 40))
                  .slice(0, 12)
            : [],
        featured: o.featured === true,
        order: typeof o.order === "number" && Number.isFinite(o.order) ? o.order : 0,
        image: siteImage(o.image),
        websiteUrl: httpsLink(o.websiteUrl),
        githubUrl: httpsLink(o.githubUrl),
        updatedAt: optStr(o.updatedAt, 40),
        noindex: o.noindex === true,
    };
}

export function normaliseProject(input: unknown): Project | null {
    const summary = normaliseProjectSummary(input);
    if (!summary) return null;
    const o = input as Record<string, unknown>;
    return {
        ...summary,
        bodyHtml: typeof o.bodyHtml === "string" ? o.bodyHtml : "",
        gallery: Array.isArray(o.gallery)
            ? (o.gallery as unknown[])
                  .map((g) => {
                      const image = siteImage(g);
                      const caption = g && typeof g === "object" ? optStr((g as Record<string, unknown>).caption, 300) : null;
                      return image ? { ...image, caption } : null;
                  })
                  .filter((g): g is SiteImage & { caption: string | null } => Boolean(g))
                  .slice(0, 24)
            : [],
        links: Array.isArray(o.links)
            ? (o.links as unknown[])
                  .map((l) => {
                      const r = (l ?? {}) as Record<string, unknown>;
                      const url = httpsLink(r.url);
                      const label = optStr(r.label, 60);
                      return url && label ? { label, url } : null;
                  })
                  .filter((l): l is { label: string; url: string } => Boolean(l))
                  .slice(0, 8)
            : [],
        seoTitle: optStr(o.seoTitle, 120),
        seoDescription: optStr(o.seoDescription, 300),
        seo: normaliseSeo(o.seo, { title: o.seoTitle, description: o.seoDescription }),
        publishedAt: optStr(o.publishedAt, 40),
    };
}

/** Featured first, then by display order (lower first), then title. */
export const sortProjects = <T extends { featured: boolean; order: number; title: string }>(projects: T[]) =>
    [...projects].sort((a, b) => Number(b.featured) - Number(a.featured) || a.order - b.order || a.title.localeCompare(b.title));
