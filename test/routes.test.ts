import { SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { createMock, resetDb, sync } from "./helpers";

const get = (path: string, init: RequestInit & { host?: string } = {}) =>
    SELF.fetch(`https://${init.host ?? "daly.id.au"}${path}`, { redirect: "manual", ...init });

beforeAll(async () => {
    await resetDb();
    await sync(createMock());
});

describe("pages", () => {
    it.each(["/", "/blog", "/about", "/contact", "/blog/publishing-from-my-notebook"])("serves %s with server-rendered HTML", async (path) => {
        const response = await get(path);
        expect(response.status).toBe(200);
        expect(response.headers.get("Content-Type")).toContain("text/html");
        const html = await response.text();
        // Real markup, not an empty SPA shell.
        expect(html).toMatch(/<main id="main"[^>]*>.*<h1/s);
        expect(html).toContain('<script type="application/json" id="page-data">');
        expect(html).toMatch(/<link rel="canonical" href="https:\/\/daly\.id\.au/);
    });

    it("never lets browsers cache HTML for long, even on an edge cache hit", async () => {
        await get("/about");
        const second = await get("/about");
        expect(second.headers.get("Cache-Control")).toBe("public, max-age=0, must-revalidate");
    });

    it("puts the whole article in the initial HTML", async () => {
        const html = await (await get("/blog/publishing-from-my-notebook")).text();
        expect(html).toContain("<h1");
        expect(html).toContain("Publishing straight from my notebook");
        expect(html).toContain("That&#39;s the whole loop.");
        expect(html).toContain('"@type":"BlogPosting"');
        expect(html).toContain('<meta property="og:type" content="article">');
        expect(html).toContain('<meta property="og:image" content="https://daly.id.au/media/');
        expect(html).toContain('<meta property="article:published_time" content="2026-10-08T00:00:00.000Z">');
        expect(html).toContain("On this page");
        expect(html).toContain("Keep reading");
    });

    it("gives every page a unique title and description", async () => {
        const titles = new Set<string>();
        for (const path of ["/", "/blog", "/about", "/contact", "/blog/publishing-from-my-notebook", "/blog/running-a-good-training-session"]) {
            const html = await (await get(path)).text();
            titles.add(/<title>(.*?)<\/title>/.exec(html)![1]);
            expect(html).toMatch(/<meta name="description" content="[^"]+">/);
        }
        expect(titles.size).toBe(6);
    });

    it("returns a real 404 for unknown articles and pages", async () => {
        for (const path of ["/blog/does-not-exist", "/nope", "/blog/a/b"]) {
            const response = await get(path);
            expect(response.status).toBe(404);
            const html = await response.text();
            expect(html).toContain("Page not found");
            expect(html).toContain('<meta name="robots" content="noindex, follow">');
        }
    });

    it("filters the blog by category, tag and search", async () => {
        const byCategory = await (await get("/blog?category=Training")).text();
        expect(byCategory).toContain("Notes on running a good training session");
        expect(byCategory).not.toContain("Publishing straight from my notebook</a></h2>");
        const byTag = await (await get("/blog?tag=Writing")).text();
        expect(byTag).toContain("1 article");
        const search = await (await get("/blog?q=escaping")).text();
        expect(search).toContain("Small tools &amp; big wins");
        expect(search).toContain('<meta name="robots" content="noindex, follow">');
    });

    it("normalises URLs", async () => {
        expect((await get("/blog/")).headers.get("Location")).toBe("https://daly.id.au/blog");
        expect((await get("/blog/Running-A-Good-Training-Session")).headers.get("Location")).toBe("https://daly.id.au/blog/running-a-good-training-session");
        const www = await get("/blog?page=1", { host: "www.daly.id.au" });
        expect(www.status).toBe(301);
        expect(www.headers.get("Location")).toBe("https://daly.id.au/blog?page=1");
    });
});

describe("feeds and crawlers", () => {
    it("serves an XML sitemap with every published article", async () => {
        const response = await get("/sitemap.xml");
        expect(response.headers.get("Content-Type")).toContain("application/xml");
        const xml = await response.text();
        expect(xml).toContain("<loc>https://daly.id.au/blog/publishing-from-my-notebook</loc>");
        expect(xml).toContain("<loc>https://daly.id.au/about</loc>");
        expect(xml.match(/<url>/g)).toHaveLength(7);
    });

    it("serves an RSS feed with absolute links", async () => {
        const response = await get("/feed.xml");
        expect(response.headers.get("Content-Type")).toContain("application/rss+xml");
        const xml = await response.text();
        expect(xml).toContain("<item>");
        expect(xml.match(/<item>/g)).toHaveLength(3);
        expect(xml).toContain('src="https://daly.id.au/media/');
        expect(xml).not.toMatch(/src="\/media/);
    });

    it("allows indexing on the production host only", async () => {
        expect(await (await get("/robots.txt")).text()).toContain("Sitemap: https://daly.id.au/sitemap.xml");
        const preview = await get("/robots.txt", { host: "dalyidau.example.workers.dev" });
        expect(await preview.text()).toContain("Disallow: /");
        const page = await get("/", { host: "dalyidau.example.workers.dev" });
        expect(page.headers.get("X-Robots-Tag")).toBe("noindex");
    });
});

describe("security", () => {
    it("sends security headers", async () => {
        const response = await get("/");
        expect(response.headers.get("Content-Security-Policy")).toContain("script-src 'self'");
        expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
        expect(response.headers.get("X-Frame-Options")).toBe("DENY");
        expect(response.headers.get("Strict-Transport-Security")).toContain("max-age=");
    });

    it("protects the admin endpoints", async () => {
        expect((await get("/api/admin/sync", { method: "POST" })).status).toBe(401);
        expect((await get("/api/admin/sync", { method: "POST", headers: { Authorization: "Bearer wrong-token-wrong-token-wrong" } })).status).toBe(401);
        expect((await get("/api/admin/status")).status).toBe(401);
        const ok = await get("/api/admin/status", { headers: { Authorization: "Bearer test-admin-token-0123456789abcdef" } });
        expect(ok.status).toBe(200);
    });

    it("exposes no unpublished data through the public API", async () => {
        const health = await (await get("/api/health")).text();
        expect(health).not.toMatch(/draft|PRIVATE/i);
        expect((await get("/api/posts")).status).toBe(404);
    });

    it("never leaks secrets into pages", async () => {
        for (const path of ["/", "/blog/publishing-from-my-notebook"]) {
            const html = await (await get(path)).text();
            expect(html).not.toContain("cap-api-");
            expect(html).not.toContain("test-admin-token");
        }
    });

    it("rejects odd media paths", async () => {
        expect((await get("/media/../secret")).status).toBe(404);
        expect((await get("/media/abc.svg")).status).toBe(404);
    });
});
