// Data shapes shared by the worker (server render) and the browser (hydration).

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
}

export interface BlogFilters {
    q: string;
    category: string | null;
    tag: string | null;
    page: number;
}

export type PageData =
    | { route: "home"; latest: PostSummary[] }
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
    | { route: "about" }
    | { route: "contact" }
    | { route: "not-found"; path: string };

export interface PageProps {
    data: PageData;
    /** Path of the current request, used for active navigation state. */
    path: string;
}
