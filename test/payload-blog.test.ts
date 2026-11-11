// Payload as the blog's publisher (worker/blog/payload-publisher.ts, docs/PAYLOAD-BLOG.md): rich text
// is escaped node by node, publishing writes the same `posts` rows the site already renders, an
// imported post's public page doesn't change by a single byte, and the retired Capacities sync can
// never overwrite or delete a post Payload owns.
import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { type LexicalNode, PublishError, publishPayloadPost, renderLexical, unpublishPayloadPost } from "../worker/blog/payload-publisher";
import { createMock, publishedSlugs, resetDb, setCapacitiesSync, sync, testEnv } from "./helpers";

const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
const ctx = { loadMedia: async (id: string | number) => (String(id) === "7" ? { bytes: PNG, contentType: "image/png", alt: "A dot", caption: "<b>tiny</b>" } : null) };

const text = (value: string, format = 0): LexicalNode => ({ type: "text", text: value, format });
const para = (...children: LexicalNode[]): LexicalNode => ({ type: "paragraph", children });
const doc = (...children: LexicalNode[]) => ({ root: { type: "root", children } });

const get = async (path: string) => {
    const response = await SELF.fetch(`https://daly.id.au${path}`, { redirect: "manual" });
    return { status: response.status, html: await response.text(), location: response.headers.get("Location") };
};

const post = (overrides = {}) => ({
    postId: "payload:test-1",
    slug: "hello-payload",
    title: "Hello from Payload",
    summary: "A first post.",
    category: "Notes",
    tags: ["b", "a", "a"],
    publishedAt: "2026-11-11T00:00:00.000Z",
    content: doc({ type: "heading", tag: "h2", children: [text("Why")] }, para(text("Plain "), text("bold", 1), text(" words."))),
    ...overrides,
});

beforeEach(async () => {
    await resetDb();
    await setCapacitiesSync(false);
});

describe("rendering rich text", () => {
    const render = (root: LexicalNode) => renderLexical(root, { siteUrl: "https://daly.id.au", image: () => null });

    it("escapes every string and keeps only safe links", () => {
        const { html } = render(
            doc(
                para(text('<script>alert("x")</script>')),
                para({ type: "link", fields: { url: "javascript:alert(1)" }, children: [text("bad")] }),
                para({ type: "link", fields: { url: "data:text/html,hi" }, children: [text("data")] }),
                para({ type: "link", fields: { url: "//evil.example/x" }, children: [text("protocol-relative")] }),
                para({ type: "link", fields: { url: 'https://example.com/?a="1"' }, children: [text("ok")] }),
                para({ type: "link", fields: { url: "/about" }, children: [text("local")] }),
                { type: "mystery-block", children: [text("<img src=x onerror=alert(1)>")] },
                { type: "heading", tag: "h2", children: [text("A <b>title</b>")] },
            ).root,
        );
        expect(html).not.toMatch(/<script|<img|javascript:|data:text|href="\/\/evil/);
        expect(html).toContain("&lt;script&gt;");
        expect(html).toContain('<a href="https://example.com/?a=%221%22" rel="noopener noreferrer" target="_blank">ok</a>');
        expect(html).toContain('<a href="/about">local</a>');
        expect(html).toContain("<p>bad</p>");
        expect(html).toContain('<h2 id="a-b-title-b">A &lt;b&gt;title&lt;/b&gt;</h2>');
    });

    it("builds headings with unique ids and a table of contents, lists, quotes and code", () => {
        const r = render(
            doc(
                { type: "heading", tag: "h2", children: [text("Plan")] },
                { type: "heading", tag: "h3", children: [text("Plan")] },
                { type: "heading", tag: "h1", children: [text("Top")] },
                { type: "list", listType: "bullet", children: [{ type: "listitem", children: [text("one")] }, { type: "listitem", children: [text("two", 2)] }] },
                { type: "list", listType: "check", children: [{ type: "listitem", checked: true, children: [text("done")] }] },
                { type: "quote", children: [text("Said")] },
                { type: "code", language: "ts<x>", children: [text("a < b")] },
                { type: "horizontalrule" },
            ).root,
        );
        expect(r.toc).toEqual([
            { id: "plan", text: "Plan", level: 2 },
            { id: "plan-2", text: "Plan", level: 3 },
            { id: "top", text: "Top", level: 2 },
        ]);
        expect(r.html).toContain('<h2 id="top">Top</h2>'); // h1 is the page title: content headings start at h2.
        expect(r.html).toContain("<ul><li>one</li><li><em>two</em></li></ul>");
        expect(r.html).toContain('<ul class="checklist"><li><input type="checkbox" disabled checked> done</li></ul>');
        expect(r.html).toContain("<blockquote><p>Said</p></blockquote>");
        expect(r.html).toContain('<pre data-lang="tsx"><code class="language-tsx">a &lt; b</code></pre>');
        expect(r.html).toContain("<hr>");
        expect(r.wordCount).toBe(10);
    });
});

describe("publishing from Payload", () => {
    it("puts the post on the site, in the feed, the sitemap, its category and tags", async () => {
        const result = await publishPayloadPost(testEnv, post(), ctx);
        expect(result).toEqual({ outcome: "published", postId: "payload:test-1", slug: "hello-payload" });
        const row = await testEnv.DB.prepare("SELECT source, tags, summary, reading_minutes FROM posts WHERE id = 'payload:test-1'").first();
        expect(row).toEqual({ source: "payload", tags: '["a","b"]', summary: "A first post.", reading_minutes: 1 });
        const page = await get("/blog/hello-payload");
        expect(page.status).toBe(200);
        expect(page.html).toContain("Hello from Payload");
        expect(page.html).toContain("<strong>bold</strong>");
        expect((await get("/feed.xml")).html).toContain("https://daly.id.au/blog/hello-payload");
        expect((await get("/sitemap.xml")).html).toContain("https://daly.id.au/blog/hello-payload");
        expect((await get("/blog?category=Notes")).html).toContain("/blog/hello-payload");
        expect((await get("/blog?tag=a")).html).toContain("/blog/hello-payload");
        // Republishing the same thing changes nothing.
        expect((await publishPayloadPost(testEnv, post(), ctx)).outcome).toBe("unchanged");
    });

    it("copies images into the public bucket under their content hash and links them", async () => {
        await publishPayloadPost(testEnv, post({ heroMediaId: 7, content: doc(para(text("Pic:")), { type: "upload", relationTo: "media", value: { id: 7 } }) }), ctx);
        const row = await testEnv.DB.prepare("SELECT image_key, image_alt, image_width, body_html FROM posts WHERE id = 'payload:test-1'").first<{
            image_key: string;
            image_alt: string;
            image_width: number;
            body_html: string;
        }>();
        expect(row!.image_key).toMatch(/^[a-f0-9]{24}\.png$/);
        expect(row!.image_alt).toBe("A dot");
        expect(row!.image_width).toBe(1);
        expect(row!.body_html).toContain(`<img src="/media/${row!.image_key}"`);
        expect(row!.body_html).toContain("<figcaption>&lt;b&gt;tiny&lt;/b&gt;</figcaption>");
        expect((await SELF.fetch(`https://daly.id.au/media/${row!.image_key}`)).status).toBe(200);
    });

    it("refuses a featured image it can't read, writing nothing", async () => {
        await expect(publishPayloadPost(testEnv, post({ heroMediaId: 99 }), ctx)).rejects.toThrow(PublishError);
        expect(await publishedSlugs()).toEqual([]);
    });

    it("keeps the old address redirecting when the slug changes, and unpublishing removes both", async () => {
        await publishPayloadPost(testEnv, post(), ctx);
        expect((await publishPayloadPost(testEnv, post({ slug: "renamed" }), ctx)).outcome).toBe("updated");
        const old = await get("/blog/hello-payload");
        expect(old.status).toBe(301);
        expect(old.location).toMatch(/\/blog\/renamed$/);
        expect(await unpublishPayloadPost(testEnv, "payload:test-1")).toBe(true);
        expect((await get("/blog/renamed")).status).toBe(404);
        expect((await get("/blog/hello-payload")).status).toBe(404);
        expect(await unpublishPayloadPost(testEnv, "payload:test-1")).toBe(false);
    });

    it("fails closed: an invalid slug, a slug another post uses, or another publisher's row", async () => {
        await publishPayloadPost(testEnv, post(), ctx);
        await expect(publishPayloadPost(testEnv, post({ postId: "payload:other" }), ctx)).rejects.toThrow(/already used/);
        await expect(publishPayloadPost(testEnv, post({ postId: "payload:x", slug: "", title: "!!!" }), ctx)).rejects.toThrow(PublishError);
        await expect(publishPayloadPost(testEnv, post({ postId: "payload:y", slug: "fine", content: doc(para(text(" "))) }), ctx)).rejects.toThrow(/content/);
        await testEnv.DB.prepare("UPDATE posts SET source = 'capacities' WHERE id = 'payload:test-1'").run();
        await expect(publishPayloadPost(testEnv, post(), ctx)).rejects.toThrow(/capacities publisher/);
        await expect(unpublishPayloadPost(testEnv, "payload:test-1")).rejects.toThrow(/capacities publisher/);
        expect(await publishedSlugs()).toEqual(["hello-payload"]);
    });
});

describe("importing an existing post", () => {
    /** The public surface of one post: page, feed and sitemap, with build-specific noise removed. */
    const snapshot = async (slug: string) => ({
        page: (await get(`/blog/${slug}`)).html.replace(/nonce-[^'"]+|nonce="[^"]+"/g, ""),
        list: (await get("/blog")).html.replace(/nonce-[^'"]+|nonce="[^"]+"/g, ""),
        rss: (await get("/feed.xml")).html.replace(/<lastBuildDate>[^<]*<\/lastBuildDate>/, ""),
        sitemap: (await get("/sitemap.xml")).html,
    });

    it("keeps a Capacities post's public page, feed and sitemap exactly as they were, and the old sync can't touch it", async () => {
        await setCapacitiesSync(true);
        const mock = createMock();
        await sync(mock);
        await setCapacitiesSync(false);
        const row = await testEnv.DB.prepare("SELECT * FROM posts WHERE source = 'capacities' ORDER BY slug LIMIT 1").first<Record<string, never>>();
        const before = await snapshot(row!.slug);

        // What src/blog-import.ts does: claim the row, then publish it from the Payload document.
        await testEnv.DB.prepare("UPDATE posts SET source = 'payload' WHERE id = ? AND source = 'capacities'").bind(row!.id).run();
        const result = await publishPayloadPost(
            testEnv,
            {
                postId: row!.id,
                slug: row!.slug,
                title: row!.title,
                subtitle: row!.subtitle,
                summary: row!.summary,
                category: row!.category,
                tags: JSON.parse(row!.tags),
                featured: !!row!.featured,
                publishedAt: row!.published_at,
                updatedAt: row!.updated_at,
                content: doc(para(text(""))), // An untouched editor: the stored HTML is kept.
                legacy: {
                    body_html: row!.body_html,
                    toc: JSON.parse(row!.toc),
                    search_text: row!.search_text,
                    word_count: row!.word_count,
                    reading_minutes: row!.reading_minutes,
                },
                legacyImage: row!.image_key ? { key: row!.image_key, alt: row!.image_alt, width: row!.image_width, height: row!.image_height } : null,
            },
            ctx,
        );
        // Same content hash as the Capacities render: nothing about the post itself changed.
        expect(result.outcome).toBe("unchanged");
        const after = await testEnv.DB.prepare("SELECT * FROM posts WHERE id = ?").bind(row!.id).first<Record<string, unknown>>();
        for (const column of ["slug", "title", "subtitle", "summary", "category", "tags", "featured", "image_key", "image_alt", "image_width", "image_height", "body_html", "toc", "search_text", "word_count", "reading_minutes", "published_at", "updated_at"])
            expect(after![column], column).toEqual(row![column]);
        expect(await snapshot(row!.slug)).toEqual(before);

        // Capacities sync switched back on, with the post changed and then deleted there: Payload's copy stays.
        await setCapacitiesSync(true);
        mock.control.setSlug(row!.id, "something-else");
        await sync(mock, {}, true);
        for (let i = 0; i < 4; i++) {
            mock.control.remove(row!.id);
            await sync(mock, {}, true);
        }
        const kept = await testEnv.DB.prepare("SELECT source, slug, body_html FROM posts WHERE id = ?").bind(row!.id).first();
        expect(kept).toEqual({ source: "payload", slug: row!.slug, body_html: row!.body_html });
    });
});
