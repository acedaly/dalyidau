// Data shapes shared by the worker (server render) and the browser (hydration).
import type { HomeContent, Project, ProjectSummary, ProjectsHomeContent, PublicPage, Seo, SiteSettings } from "./site-content";

export interface TocEntry {
    id: string;
    text: string;
    level: 2 | 3;
}

export interface PostImage {
    src: string;
    srcSet?: string;
    alt: string;
    width?: number;
    height?: number;
}

export interface PostSummary {
    slug: string;
    title: string;
    subtitle: string | null;
    summary: string | null;
    category: string | null;
    tags: string[];
    featured: boolean;
    image: PostImage | null;
    publishedAt: string;
    updatedAt: string | null;
    readingMinutes: number;
}

export interface Post extends PostSummary {
    /** Sanitised article HTML. Omitted from the embedded JSON and read back from the DOM on hydration. */
    bodyHtml: string;
    toc: TocEntry[];
    /** Search and sharing settings, when the post sets any (posts published from Payload). */
    seo?: Seo | null;
}

export interface BlogFilters {
    q: string;
    category: string | null;
    tag: string | null;
    page: number;
}

export type PageRoute =
    | { route: "home"; latest: PostSummary[]; home: HomeContent }
    | {
          route: "blog";
          featured: PostSummary | null;
          posts: PostSummary[];
          categories: { name: string; count: number }[];
          filters: BlogFilters;
          totalPages: number;
          totalPosts: number;
      }
    | { route: "post"; post: Post; related: PostSummary[]; url: string }
    | { route: "page"; page: PublicPage }
    /** `hasWriting`: the writing is shown on this site and there is at least one article (so a link to it leads somewhere). */
    | { route: "projects-home"; content: ProjectsHomeContent; projects: ProjectSummary[]; latest: PostSummary[]; hasWriting: boolean }
    | { route: "projects"; projects: ProjectSummary[]; intro: string; hasWriting: boolean }
    | { route: "project"; project: Project; related: ProjectSummary[] }
    | { route: "contact" }
    | { route: "not-found"; path: string };

export interface PublicSiteContext {
    /** The Wedding navigation item is public only while the wedding website is published. */
    weddingPublished: boolean;
    /** Site settings and navigation, as published from Payload (defaults when nothing is). */
    site: SiteSettings;
    /** "projects": the projects-first design (switched on, or the private preview). Absent: today's design. */
    design?: "projects";
    /** The private preview's address prefix ("/portal/preview"); links to the redesigned pages keep it. */
    base?: string;
    /** The site makes smaller copies of its images (worker/lib/image-variants.ts): components list them in `srcset`. */
    imageVariants?: boolean;
    /** Set only on a draft preview (worker/site/preview.ts): the page says so, above everything else. */
    preview?: { published: boolean; createdAt: string };
}

export type PageData = PageRoute & { context: PublicSiteContext };

export interface PageProps {
    data: PageData;
    /** Path of the current request, used for active navigation state. */
    path: string;
}
