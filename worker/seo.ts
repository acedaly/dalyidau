import { about } from "../src/content/about";
import { site } from "../src/content/site";
import type { PageData, PostSummary } from "../src/shared/types";
import { escapeHtml, jsonForScript } from "./lib/html";

export interface HeadInput {
    data: PageData;
    siteUrl: string;
    path: string;
    noindex: boolean;
}

const absolute = (siteUrl: string, path: string) => new URL(path, siteUrl).toString();

const DEFAULT_IMAGE = "/og-default.png";

export const pageTitle = (data: PageData) => {
    switch (data.route) {
        case "home":
            return site.title;
        case "amplenote-preview":
            return `Amplenote preview — ${site.name}`;
        case "blog": {
            const parts = [site.blogTitle];
            if (data.filters.category) parts.unshift(data.filters.category);
            if (data.filters.tag) parts.unshift(`#${data.filters.tag}`);
            if (data.filters.page > 1) parts.push(`Page ${data.filters.page}`);
            return `${parts.join(" · ")} — ${site.name}`;
        }
        case "post":
            return `${data.post.title} — ${site.name}`;
        case "about":
            return `About — ${site.name}`;
        case "contact":
            return `Contact — ${site.name}`;
        case "not-found":
            return `Page not found — ${site.name}`;
    }
};

const pageDescription = (data: PageData) => {
    switch (data.route) {
        case "amplenote-preview":
            return "A non-indexed preview of an Amplenote article on the personal site.";
        case "post":
            return data.post.summary ?? data.post.subtitle ?? site.description;
        case "blog":
            return site.blogDescription;
        case "about":
            return about.short;
        case "contact":
            return `How to get in touch with ${site.name}.`;
        default:
            return site.description;
    }
};

export const canonicalPath = (data: PageData, path: string) => {
    if (data.route === "blog") {
        // Filtered and searched views canonicalise to their unfiltered page.
        const params = new URLSearchParams();
        if (data.filters.category) params.set("category", data.filters.category);
        if (data.filters.tag) params.set("tag", data.filters.tag);
        if (data.filters.page > 1) params.set("page", String(data.filters.page));
        const query = params.toString();
        return `/blog${query ? `?${query}` : ""}`;
    }
    if (data.route === "post") return `/blog/${data.post.slug}`;
    return path;
};

export const buildHead = ({ data, siteUrl, path, noindex }: HeadInput) => {
    const title = pageTitle(data);
    const description = pageDescription(data);
    const canonical = absolute(siteUrl, canonicalPath(data, path));
    const isPost = data.route === "post";
    const image = isPost && data.post.image ? absolute(siteUrl, data.post.image.src) : absolute(siteUrl, DEFAULT_IMAGE);
    const searchNoindex = data.route === "blog" && !!data.filters.q;

    const tags = [
        `<title>${escapeHtml(title)}</title>`,
        `<meta name="description" content="${escapeHtml(description)}">`,
        data.route !== "not-found" ? `<link rel="canonical" href="${escapeHtml(canonical)}">` : "",
        noindex || searchNoindex || data.route === "not-found"
            ? `<meta name="robots" content="noindex, follow">`
            : `<meta name="robots" content="index, follow, max-image-preview:large">`,
        `<link rel="alternate" type="application/rss+xml" title="${escapeHtml(`${site.name} — ${site.blogTitle}`)}" href="${escapeHtml(absolute(siteUrl, "/feed.xml"))}">`,
        `<meta property="og:site_name" content="${escapeHtml(site.name)}">`,
        `<meta property="og:locale" content="${site.locale}">`,
        `<meta property="og:type" content="${isPost ? "article" : "website"}">`,
        `<meta property="og:title" content="${escapeHtml(isPost ? data.post.title : title)}">`,
        `<meta property="og:description" content="${escapeHtml(description)}">`,
        `<meta property="og:url" content="${escapeHtml(canonical)}">`,
        `<meta property="og:image" content="${escapeHtml(image)}">`,
        isPost && data.post.image?.alt ? `<meta property="og:image:alt" content="${escapeHtml(data.post.image.alt)}">` : "",
        isPost && data.post.image?.width ? `<meta property="og:image:width" content="${data.post.image.width}">` : "",
        isPost && data.post.image?.height ? `<meta property="og:image:height" content="${data.post.image.height}">` : "",
        `<meta name="twitter:card" content="summary_large_image">`,
        `<meta name="twitter:title" content="${escapeHtml(isPost ? data.post.title : title)}">`,
        `<meta name="twitter:description" content="${escapeHtml(description)}">`,
        `<meta name="twitter:image" content="${escapeHtml(image)}">`,
    ];

    if (isPost) {
        const post = data.post;
        tags.push(`<meta property="article:published_time" content="${escapeHtml(post.publishedAt)}">`);
        if (post.updatedAt) tags.push(`<meta property="article:modified_time" content="${escapeHtml(post.updatedAt)}">`);
        if (post.category) tags.push(`<meta property="article:section" content="${escapeHtml(post.category)}">`);
        for (const tag of post.tags) tags.push(`<meta property="article:tag" content="${escapeHtml(tag)}">`);
    }

    if (data.route === "amplenote-preview") tags.push(`<script defer src="https://public.amplenote.com/embed.js"></script>`);

    tags.push(`<script type="application/ld+json">${jsonForScript(structuredData(data, siteUrl, canonical, image, description))}</script>`);
    return tags.filter(Boolean).join("\n        ");
};

const person = (siteUrl: string) => ({ "@type": "Person", name: site.name, url: absolute(siteUrl, "/about") });

const structuredData = (data: PageData, siteUrl: string, canonical: string, image: string, description: string) => {
    if (data.route === "post") {
        const post = data.post;
        return {
            "@context": "https://schema.org",
            "@type": "BlogPosting",
            mainEntityOfPage: { "@type": "WebPage", "@id": canonical },
            headline: post.title,
            alternativeHeadline: post.subtitle ?? undefined,
            description,
            image: [image],
            datePublished: post.publishedAt,
            dateModified: post.updatedAt ?? post.publishedAt,
            author: person(siteUrl),
            publisher: person(siteUrl),
            articleSection: post.category ?? undefined,
            keywords: post.tags.length ? post.tags.join(", ") : undefined,
            inLanguage: site.language,
        };
    }
    if (data.route === "blog") {
        return {
            "@context": "https://schema.org",
            "@type": "Blog",
            name: `${site.name} — ${site.blogTitle}`,
            url: canonical,
            description: site.blogDescription,
            author: person(siteUrl),
            inLanguage: site.language,
        };
    }
    if (data.route === "about") {
        return { "@context": "https://schema.org", "@type": "ProfilePage", url: canonical, mainEntity: { ...person(siteUrl), description: about.short } };
    }
    return {
        "@context": "https://schema.org",
        "@type": "WebSite",
        name: site.name,
        url: absolute(siteUrl, "/"),
        description: site.description,
        inLanguage: site.language,
        author: person(siteUrl),
    };
};

const xml = (value: string) => escapeHtml(value);

export const sitemapXml = (siteUrl: string, posts: { slug: string; lastmod: string }[]) => {
    const latest = posts[0]?.lastmod;
    const urls = [
        { loc: "/", lastmod: latest },
        { loc: "/blog", lastmod: latest },
        { loc: "/about" },
        { loc: "/contact" },
        ...posts.map((p) => ({ loc: `/blog/${p.slug}`, lastmod: p.lastmod })),
    ];
    const body = urls
        .map(
            (u) => `  <url><loc>${xml(absolute(siteUrl, u.loc))}</loc>${u.lastmod ? `<lastmod>${xml(new Date(u.lastmod).toISOString())}</lastmod>` : ""}</url>`,
        )
        .join("\n");
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
};

export const rssXml = (siteUrl: string, posts: (PostSummary & { bodyHtml: string })[]) => {
    const items = posts
        .slice(0, 30)
        .map((post) => {
            const link = absolute(siteUrl, `/blog/${post.slug}`);
            // Relative links and images in the body must be absolute for feed readers.
            const body = post.bodyHtml.replace(/(href|src)="\/(?!\/)/g, `$1="${siteUrl.replace(/\/$/, "")}/`);
            return [
                "    <item>",
                `      <title>${xml(post.title)}</title>`,
                `      <link>${xml(link)}</link>`,
                `      <guid isPermaLink="true">${xml(link)}</guid>`,
                `      <pubDate>${new Date(post.publishedAt).toUTCString()}</pubDate>`,
                post.summary ? `      <description>${xml(post.summary)}</description>` : "",
                post.category ? `      <category>${xml(post.category)}</category>` : "",
                ...post.tags.map((t) => `      <category>${xml(t)}</category>`),
                `      <content:encoded><![CDATA[${body.replace(/]]>/g, "]]]]><![CDATA[>")}]]></content:encoded>`,
                "    </item>",
            ]
                .filter(Boolean)
                .join("\n");
        })
        .join("\n");
    const updated = posts[0] ? new Date(posts[0].updatedAt ?? posts[0].publishedAt).toUTCString() : new Date(0).toUTCString();
    return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>${xml(`${site.name} — ${site.blogTitle}`)}</title>
    <link>${xml(absolute(siteUrl, "/blog"))}</link>
    <atom:link href="${xml(absolute(siteUrl, "/feed.xml"))}" rel="self" type="application/rss+xml"/>
    <description>${xml(site.blogDescription)}</description>
    <language>${site.language.toLowerCase()}</language>
    <lastBuildDate>${updated}</lastBuildDate>
${items}
  </channel>
</rss>
`;
};

export const robotsTxt = (siteUrl: string, allowIndexing: boolean) =>
    allowIndexing ? `User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /portal\n\nSitemap: ${absolute(siteUrl, "/sitemap.xml")}\n` : "User-agent: *\nDisallow: /\n";
