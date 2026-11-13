// The website's content managed in Payload (docs/PAYLOAD-FRONTEND-PLAN.md): Payload's hooks publish
// snapshots through worker/site/publisher.ts and the public pages render them. Before anything is
// published the site shows its built-in text; publishing changes the next request without a deploy;
// every string is escaped; reserved addresses can't be taken; bad snapshots fall back safely.
import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_HOME, DEFAULT_SITE, pageSlugProblem } from "../src/shared/site-content";
import {
    PublishError,
    homeSnapshot,
    publishHome,
    publishPage,
    publishSiteSettings,
    publishedSlugs,
    resolveNavigation,
    unpublishPage,
} from "../worker/site/publisher";
import { resetDb, testEnv } from "./helpers";

const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
const media = { loadMedia: async (id: string | number) => (String(id) === "7" ? { bytes: PNG, contentType: "image/png", alt: "A dot" } : null) };

const get = async (path: string) => {
    const response = await SELF.fetch(`https://daly.id.au${path}`, { redirect: "manual" });
    return { status: response.status, html: await response.text(), location: response.headers.get("Location") };
};

const settings = (overrides = {}) => ({
    name: DEFAULT_SITE.name,
    shortName: DEFAULT_SITE.shortName,
    title: DEFAULT_SITE.title,
    description: DEFAULT_SITE.description,
    blogTitle: DEFAULT_SITE.blogTitle,
    blogDescription: DEFAULT_SITE.blogDescription,
    email: DEFAULT_SITE.email,
    socials: [],
    contact: DEFAULT_SITE.contact,
    ...overrides,
});
const para = (text: string) => ({ type: "paragraph", children: [{ type: "text", text }] });
const content = (...texts: string[]) => ({ root: { type: "root", children: texts.map(para) } });

beforeEach(async () => {
    await resetDb();
    await testEnv.DB.prepare("DELETE FROM meta WHERE key != 'content_version'").run();
});

describe("before Payload publishes anything", () => {
    it("shows the built-in homepage, About page, menu and contact page", async () => {
        const home = await get("/");
        expect(home.status).toBe(200);
        expect(home.html).toContain("Some things are worth <em>writing down.</em>");
        expect(home.html).toContain(">HELLO, I&#x27;M AIDAN</p>");
        const about = await get("/about");
        expect(about.status).toBe(200);
        expect(about.html).toContain("Hi, I&#x27;m Aidan. This is where I write things down.");
        expect(about.html).toContain("Read the blog");
        expect(about.html).toContain('"@type":"ProfilePage"');
        expect((await get("/contact")).html).toContain("Get in touch");
        expect((await get("/sitemap.xml")).html).toContain("<loc>https://daly.id.au/about</loc>");
        expect((await get("/some-page")).status).toBe(404);
    });
});

describe("publishing from Payload", () => {
    it("changes the site name, menu, footer, contact page and feed on the next request", async () => {
        const nav = resolveNavigation(
            {
                items: [
                    { label: "Writing", url: "/blog" },
                    { label: "Elsewhere", url: "https://example.com/x" },
                ],
            },
            new Set(),
        );
        await publishSiteSettings(
            testEnv,
            settings({
                name: "A <b>Daly</b>",
                footerText: "Written in Sydney",
                contact: { ...DEFAULT_SITE.contact, heading: "Say g'day" },
                socials: [{ kind: "github", label: "GitHub", url: "https://github.com/example" }],
            }),
            nav,
            media,
        );
        const home = await get("/");
        expect(home.html).toContain("A &lt;b&gt;Daly&lt;/b&gt;");
        expect(home.html).not.toContain("<b>Daly</b>");
        expect(home.html).toContain('href="https://example.com/x"');
        expect(home.html).toContain(">Writing<");
        expect(home.html).not.toContain(">About<");
        expect(home.html).toContain("Written in Sydney");
        expect(home.html).toContain('href="https://github.com/example"');
        expect((await get("/contact")).html).toContain("Say g&#x27;day");
        expect((await get("/feed.xml")).html).toContain("<title>A &lt;b&gt;Daly&lt;/b&gt; — Blog</title>");
    });

    it("changes the homepage, and drafts are never public", async () => {
        await publishHome(testEnv, {
            ...DEFAULT_HOME,
            heading: "Notes from",
            headingEmphasis: "the shed.",
            latestCount: 0,
            aboutParagraphs: ["<script>x</script>"],
        });
        const home = await get("/");
        expect(home.html).toContain("Notes from <em>the shed.</em>");
        expect(home.html).toContain("&lt;script&gt;x&lt;/script&gt;");
        expect(home.html).not.toContain("<script>x</script>");
    });

    it("refuses invalid content before anything is written", async () => {
        expect(() => homeSnapshot({ ...DEFAULT_HOME, ctaHref: "javascript:alert(1)" })).toThrow(PublishError);
        expect(() => homeSnapshot({ ...DEFAULT_HOME, heading: "  " })).toThrow(PublishError);
        await expect(publishSiteSettings(testEnv, settings({ email: "not an email" }), [], media)).rejects.toThrow(PublishError);
        await expect(
            publishSiteSettings(testEnv, settings({ socials: [{ kind: "github", label: "x", url: "javascript:alert(1)" }] }), [], media),
        ).rejects.toThrow(PublishError);
        expect(() => resolveNavigation({ items: [{ label: "Bad", url: "javascript:alert(1)" }] }, new Set())).toThrow(PublishError);
        expect(await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM meta WHERE key LIKE 'site:%'").first<{ n: number }>()).toEqual({ n: 0 });
    });

    it("bumps the content version so cached pages are replaced", async () => {
        const before = await testEnv.DB.prepare("SELECT value FROM meta WHERE key = 'content_version'").first<{ value: string }>();
        await publishHome(testEnv, DEFAULT_HOME, new Date("2030-01-01T00:00:00Z"));
        const after = await testEnv.DB.prepare("SELECT value FROM meta WHERE key = 'content_version'").first<{ value: string }>();
        expect(after?.value).toBe("2030-01-01T00:00:00.000Z");
        expect(after?.value).not.toBe(before?.value);
    });
});

describe("pages", () => {
    it("publishes a page with escaped rich text and an image, lists it, renames it and takes it down", async () => {
        await publishPage(
            testEnv,
            {
                id: 11,
                slug: "now",
                title: "What I'm doing <now>",
                lede: "A now page.",
                content: content("First.", "<img src=x onerror=alert(1)>"),
                heroMediaId: 7,
            },
            media,
        );
        const page = await get("/now");
        expect(page.status).toBe(200);
        expect(page.html).toContain("What I&#x27;m doing &lt;now&gt;");
        expect(page.html).toContain("<p>First.</p>");
        expect(page.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
        expect(page.html).not.toContain("<img src=x");
        expect(page.html).toMatch(/<img src="\/media\/[a-f0-9]{24}\.png" alt="A dot"/);
        expect(page.html).toContain("<title>What I&#39;m doing &lt;now&gt; — Aidan Daly</title>");
        expect((await get("/sitemap.xml")).html).toContain("<loc>https://daly.id.au/now</loc>");
        // Once Payload manages pages, the built-in About page is gone unless Payload publishes one.
        expect((await get("/about")).status).toBe(404);

        await publishPage(testEnv, { id: 11, slug: "these-days", title: "These days", content: content("Moved.") }, media);
        expect((await get("/now")).location).toBe("https://daly.id.au/these-days");
        expect((await get("/these-days")).html).toContain("Moved.");
        await publishPage(testEnv, { id: 11, slug: "lately", title: "Lately", content: content("Again.") }, media);
        expect((await get("/now")).location).toBe("https://daly.id.au/lately");
        expect((await get("/these-days")).location).toBe("https://daly.id.au/lately");
        expect([...(await publishedSlugs(testEnv.DB))]).toEqual(["lately"]);

        await unpublishPage(testEnv, 11);
        expect((await get("/lately")).status).toBe(404);
        expect((await get("/now")).status).toBe(404);
        expect((await get("/sitemap.xml")).html).not.toContain("/lately");
    });

    it("keeps a page's old addresses through an unpublish and brings them back when it returns at a new one", async () => {
        await publishPage(testEnv, { id: 11, slug: "now", title: "Now", content: content("One.") }, media);
        await publishPage(testEnv, { id: 11, slug: "these-days", title: "These days", content: content("Two.") }, media);
        await unpublishPage(testEnv, 11);
        for (const path of ["/now", "/these-days"]) {
            const off = await get(path);
            expect(off.status, path).toBe(404);
            expect(off.location, path).toBeNull();
        }
        await publishPage(testEnv, { id: 11, slug: "lately", title: "Lately", content: content("Three.") }, media);
        expect((await get("/now")).location).toBe("https://daly.id.au/lately");
        expect((await get("/these-days")).location).toBe("https://daly.id.au/lately");
        expect((await get("/lately")).html).toContain("Three.");
        expect([...(await publishedSlugs(testEnv.DB))]).toEqual(["lately"]);
    });

    it("old addresses belong to the page, not to where it lived: another page taking its last address inherits none of them", async () => {
        // Page 11: /a, then /b. Taken off the site.
        await publishPage(testEnv, { id: 11, slug: "a", title: "Eleven", content: content("Eleven.") }, media);
        await publishPage(testEnv, { id: 11, slug: "b", title: "Eleven", content: content("Eleven.") }, media);
        await unpublishPage(testEnv, 11);
        // Page 12 takes /b, then moves to /c.
        await publishPage(testEnv, { id: 12, slug: "b", title: "Twelve", content: content("Twelve.") }, media);
        expect((await get("/b")).html).toContain("Twelve.");
        expect((await get("/a")).status, "11's old address must not lead to 12").toBe(404);
        await publishPage(testEnv, { id: 12, slug: "c", title: "Twelve", content: content("Twelve.") }, media);
        expect((await get("/b")).location).toBe("https://daly.id.au/c");
        expect((await get("/a")).status, "…nor follow 12 when it moves").toBe(404);
        // Page 11 comes back at /d: /a is its again; /b stays 12's.
        await publishPage(testEnv, { id: 11, slug: "d", title: "Eleven", content: content("Eleven.") }, media);
        expect((await get("/a")).location).toBe("https://daly.id.au/d");
        expect((await get("/b")).location).toBe("https://daly.id.au/c");
        expect((await get("/d")).html).toContain("Eleven.");
        expect((await get("/c")).html).toContain("Twelve.");
        expect([...(await publishedSlugs(testEnv.DB))].sort()).toEqual(["c", "d"]);
    });

    it("comes back at an address it had before as the page itself, not a redirect", async () => {
        await publishPage(testEnv, { id: 11, slug: "a", title: "Eleven", content: content("Eleven.") }, media);
        await publishPage(testEnv, { id: 11, slug: "b", title: "Eleven", content: content("Eleven.") }, media);
        await unpublishPage(testEnv, 11);
        await publishPage(testEnv, { id: 11, slug: "a", title: "Eleven", content: content("Eleven.") }, media);
        expect((await get("/a")).status).toBe(200);
        expect((await get("/b")).location).toBe("https://daly.id.au/a");
    });

    it("a page deleted for good releases its addresses, so a new page with the same id inherits nothing", async () => {
        await publishPage(testEnv, { id: 11, slug: "a", title: "Eleven", content: content("Eleven.") }, media);
        await publishPage(testEnv, { id: 11, slug: "b", title: "Eleven", content: content("Eleven.") }, media);
        await unpublishPage(testEnv, 11); // into Trash
        await unpublishPage(testEnv, 11, { forget: true }); // deleted for good
        const left = await testEnv.DB.prepare("SELECT key FROM meta WHERE key LIKE 'page-redirect:%' OR key LIKE 'page-id:%'").all();
        expect(left.results).toEqual([]);
        await publishPage(testEnv, { id: 11, slug: "z", title: "A different page", content: content("New.") }, media);
        expect((await get("/a")).status).toBe(404);
        expect((await get("/b")).status).toBe(404);
        // Deleted for good while still published: the same.
        await publishPage(testEnv, { id: 11, slug: "y", title: "A different page", content: content("New.") }, media);
        await unpublishPage(testEnv, 11, { forget: true });
        expect(
            (await testEnv.DB.prepare("SELECT key FROM meta WHERE key LIKE 'page-redirect:%' OR key LIKE 'page-id:%' OR key LIKE 'page:%'").all()).results,
        ).toEqual([]);
    });

    it("never takes an address the site uses itself, or another page's", async () => {
        for (const slug of ["blog", "wedding", "admin", "contact", "api", "portal", "media", "feed.xml", "Bad Slug", "a--b", ""])
            expect(pageSlugProblem(slug), slug).not.toBeNull();
        await expect(publishPage(testEnv, { id: 1, slug: "wedding", title: "Mine" }, media)).rejects.toThrow(PublishError);
        await expect(publishPage(testEnv, { id: 1, slug: "blog", title: "Mine" }, media)).rejects.toThrow(PublishError);
        await publishPage(testEnv, { id: 1, slug: "uses", title: "Uses" }, media);
        await expect(publishPage(testEnv, { id: 2, slug: "uses", title: "Also uses" }, media)).rejects.toThrow(PublishError);
        // A stray snapshot under a reserved address is ignored by the router.
        await testEnv.DB.prepare("INSERT INTO meta (key, value) VALUES ('page:contact', ?)")
            .bind(JSON.stringify({ slug: "contact", title: "Hijack" }))
            .run();
        expect((await get("/contact")).html).not.toContain("Hijack");
        expect((await get("/blog")).status).toBe(200);
    });

    it("shows a menu link to a page only while the page is published", () => {
        const items = [
            { label: "About", pageSlug: "about" },
            { label: "Blog", url: "/blog" },
        ];
        expect(resolveNavigation({ items }, new Set(["about"]))).toEqual([
            { label: "About", href: "/about" },
            { label: "Blog", href: "/blog" },
        ]);
        expect(resolveNavigation({ items }, new Set())).toEqual([{ label: "Blog", href: "/blog" }]);
    });
});

describe("damaged snapshots", () => {
    it("fall back to the built-in content instead of breaking the site", async () => {
        await testEnv.DB.batch([
            testEnv.DB.prepare("INSERT INTO meta (key, value) VALUES ('site:settings', '{not json')"),
            testEnv.DB.prepare("INSERT INTO meta (key, value) VALUES ('site:home', ?)").bind(
                JSON.stringify({ heading: 42, ctaHref: "javascript:alert(1)", latestCount: 9999 }),
            ),
        ]);
        const home = await get("/");
        expect(home.status).toBe(200);
        expect(home.html).toContain("Some things are worth");
        expect(home.html).toContain('href="/blog"');
        expect(home.html).not.toContain("javascript:");
    });
});
