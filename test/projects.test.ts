// Projects and the projects-first homepage (Phase 4, docs/PAYLOAD-FRONTEND-PLAN.md): Payload publishes
// project snapshots (worker/site/publisher.ts); the pages exist publicly only once the switch is on; owners
// and admins can preview them at /portal/preview before that; every string is escaped; nothing unpublished
// is ever served.
import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PROJECTS_HOME, DEFAULT_SITE, pageSlugProblem, projectsMenus } from "../src/shared/site-content";
import { publishPayloadPost } from "../worker/blog/payload-publisher";
import { pageCacheKey } from "../worker/index";
import { PublishError, projectProblem, publishProject, publishProjectsHome, unpublishProject } from "../worker/site/publisher";
import { testEnv } from "./helpers";
import { accessToken, apiCall, call, resetPortal } from "./portal-helpers";

const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
const media = { loadMedia: async (id: string | number) => (String(id) === "7" ? { bytes: PNG, contentType: "image/png", alt: "A screenshot" } : null) };

const get = async (path: string) => {
    const response = await SELF.fetch(`https://daly.id.au${path}`, { redirect: "manual" });
    return { status: response.status, html: await response.text(), location: response.headers.get("Location"), headers: response.headers };
};
const setSwitch = (enabled: boolean) =>
    testEnv.DB.prepare(
        "INSERT INTO feature_flags (key, enabled, updated_at, updated_by) VALUES ('website.projects_home', ?1, '2026-01-01T00:00:00.000Z', 'test') ON CONFLICT(key) DO UPDATE SET enabled = ?1",
    )
        .bind(enabled ? 1 : 0)
        .run();
const project = (overrides = {}) => ({
    id: 1,
    slug: "lamp",
    title: "A <b>lamp</b>",
    summary: "It glows.",
    status: "active",
    tags: ["Wood", "Wood", "LEDs"],
    featured: true,
    order: 1,
    heroMediaId: 7,
    gallery: [{ mediaId: 7, caption: "On the desk" }],
    websiteUrl: "https://example.com/lamp",
    content: { root: { type: "root", children: [{ type: "paragraph", children: [{ type: "text", text: "<script>x</script> Made by hand." }] }] } },
    ...overrides,
});

beforeEach(async () => {
    await resetPortal();
    await testEnv.DB.prepare("DELETE FROM meta WHERE key != 'content_version'").run();
    await setSwitch(false);
});

describe("publishing projects", () => {
    it("refuses invalid projects before writing anything", () => {
        expect(projectProblem({ slug: "Bad Slug", title: "x" })).toBeTruthy();
        expect(projectProblem({ slug: "ok", title: " " })).toBeTruthy();
        expect(projectProblem({ slug: "ok", title: "x", status: "secret" })).toBeTruthy();
        expect(projectProblem({ slug: "ok", title: "x", websiteUrl: "javascript:alert(1)" })).toBeTruthy();
        expect(projectProblem({ slug: "ok", title: "x", links: [{ label: "Bad", url: "ftp://x" }] })).toBeTruthy();
        expect(projectProblem({ slug: "ok", title: "x", githubUrl: "https://github.com/x" })).toBeNull();
        // A Page can never take /projects.
        expect(pageSlugProblem("projects")).toBeTruthy();
    });

    it("orders featured projects first, then by display order, and keeps addresses unique", async () => {
        await publishProject(testEnv, project({ id: 1, slug: "b", title: "B", featured: false, order: 2 }), media);
        await publishProject(testEnv, project({ id: 2, slug: "a", title: "A", featured: false, order: 1 }), media);
        await publishProject(testEnv, project({ id: 3, slug: "c", title: "C", featured: true, order: 9 }), media);
        const index = JSON.parse((await testEnv.DB.prepare("SELECT value FROM meta WHERE key = 'site:projects'").first<{ value: string }>())!.value);
        expect(index.map((p: { slug: string }) => p.slug)).toEqual(["c", "a", "b"]);
        await expect(publishProject(testEnv, project({ id: 4, slug: "a", title: "Another A" }), media)).rejects.toThrow(PublishError);
    });
});

describe("with the switch off", () => {
    it("keeps today's homepage, and /projects isn't public", async () => {
        await publishProject(testEnv, project(), media);
        const home = await get("/");
        expect(home.html).toContain("Some things are worth");
        expect(home.html).not.toContain('class="site-v2"');
        expect((await get("/projects")).status).toBe(404);
        expect((await get("/projects/lamp")).status).toBe(404);
        expect((await get("/sitemap.xml")).html).not.toContain("/projects");
    });

    it("lets owners and admins preview the redesign privately; nobody else", async () => {
        await publishProject(testEnv, project(), media);
        const owner = await call("/portal/preview", { token: await accessToken() });
        expect(owner.status).toBe(200);
        expect(owner.headers.get("Cache-Control")).toBe("no-store");
        expect(owner.headers.get("X-Robots-Tag")).toContain("noindex");
        const html = await owner.text();
        expect(html).toContain('class="site-v2"');
        expect(html).toContain(DEFAULT_PROJECTS_HOME.heroTitle);
        expect(html).toContain('href="/portal/preview/projects/lamp"');
        expect(html).toContain('<link rel="canonical" href="https://daly.id.au/">');
        expect((await call("/portal/preview/projects/lamp", { token: await accessToken() })).status).toBe(200);
        expect((await call("/portal/preview", { token: null })).status).toBe(401);
        await apiCall("POST", "/api/portal/users", { email: "editor@example.com", role: "editor" });
        expect((await call("/portal/preview", { token: await accessToken({ email: "editor@example.com" }) })).status).toBe(404);
    });
});

describe("with the switch on", () => {
    it("before any project is published, says so plainly and points at what there is", async () => {
        await setSwitch(true);
        const home = await get("/");
        expect(home.html).toContain("Nothing is written up here yet.");
        // No button promising projects that aren't there, and nothing about writing "below" when none is shown.
        // (What's rendered, not the page's embedded data, which carries every label.)
        const shown = home.html.split('id="page-data"')[0];
        expect(shown).not.toContain("Explore projects");
        expect(shown).not.toContain("below");
        const index = await get("/projects");
        expect(index.status).toBe(200);
        expect(index.html).toContain("Nothing is written up here yet.");
        expect(index.html).not.toContain("0 projects");
        // An empty list isn't a page for search engines: not in the sitemap, and marked noindex.
        expect((await get("/sitemap.xml")).html).not.toContain("/projects");
        expect(index.html).toContain('<meta name="robots" content="noindex, follow">');
        // With nothing written either, no link promises writing: not in the sentence, not as the hero button.
        const main = (html: string) => /<main[\s\S]*?<\/main>/.exec(html)?.[0] ?? "";
        expect(main(home.html)).not.toContain('href="/blog"');
        expect(main(index.html)).not.toContain('href="/blog"');
    });

    it("points at the writing from the empty states only when there is some, and it's shown", async () => {
        await setSwitch(true);
        const main = (html: string) => /<main[\s\S]*?<\/main>/.exec(html)?.[0] ?? "";
        await publishPayloadPost(
            testEnv,
            {
                postId: "payload:w",
                slug: "a-post",
                title: "A post",
                content: { root: { type: "root", children: [{ type: "paragraph", children: [{ type: "text", text: "Words." }] }] } },
            },
            media,
        );
        // An article exists and writing is shown: both empty states link to it, and the hero button leads there.
        expect(main((await get("/")).html)).toContain("Read the writing");
        expect(main((await get("/projects")).html)).toContain('href="/blog"');
        // The homepage set to list no articles still has writing to point at.
        await publishProjectsHome(testEnv, { ...DEFAULT_PROJECTS_HOME, writingCount: 0 });
        expect(main((await get("/")).html)).toContain("Read the writing");
        // Writing switched off for the site: nothing points at it, although the article exists.
        await publishProjectsHome(testEnv, { ...DEFAULT_PROJECTS_HOME, showWriting: false });
        expect(main((await get("/")).html)).not.toContain('href="/blog"');
        expect(main((await get("/projects")).html)).not.toContain('href="/blog"');
        // Once a project is published, /projects is in the sitemap and indexable like any page.
        await publishProject(testEnv, project(), media);
        expect((await get("/sitemap.xml")).html).toContain("<loc>https://daly.id.au/projects</loc>");
        expect((await get("/projects")).html).not.toContain('content="noindex');
        await testEnv.DB.prepare("DELETE FROM posts WHERE id = 'payload:w'").run();
    });

    it("the page for an address that doesn't exist offers the projects as well as the writing", async () => {
        await setSwitch(true);
        const missing = await get("/no-such-page");
        expect(missing.status).toBe(404);
        // The page's own buttons, not the header's links (which are there on every page).
        const main = (html: string) => /<main[\s\S]*?<\/main>/.exec(html)?.[0] ?? "";
        expect(main(missing.html)).toMatch(/href="\/projects"[^>]*>(?:<[^>]+>)*See the projects/);
        expect(main(missing.html)).toMatch(/href="\/blog"[^>]*>(?:<[^>]+>)*Read the writing/);
        await setSwitch(false);
        const classic = await get("/no-such-page");
        expect(main(classic.html)).toContain("Browse the blog");
        expect(main(classic.html)).not.toContain("See the projects");
    });

    it("shows the projects-first homepage, the index and each project, escaped", async () => {
        await setSwitch(true);
        await publishProject(testEnv, project(), media);
        await publishProjectsHome(testEnv, { ...DEFAULT_PROJECTS_HOME, heroTitle: "Things I <make>." });
        const home = await get("/");
        expect(home.status).toBe(200);
        expect(home.html).toContain('class="site-v2"');
        expect(home.html).toContain("Things I &lt;make&gt;.");
        expect(home.html).toContain("A &lt;b&gt;lamp&lt;/b&gt;");
        expect(home.html).toContain('href="/projects/lamp"');
        expect((await get("/projects")).html).toContain("A &lt;b&gt;lamp&lt;/b&gt;");
        const page = await get("/projects/lamp");
        expect(page.status).toBe(200);
        expect(page.html).toContain("&lt;script&gt;x&lt;/script&gt; Made by hand.");
        expect(page.html).not.toContain("<script>x</script>");
        expect(page.html).toMatch(/<img src="\/media\/[a-f0-9]{24}\.png"/);
        expect(page.html).toContain("On the desk");
        expect(page.html).toContain('href="https://example.com/lamp"');
        expect(page.html).toContain("<title>A &lt;b&gt;lamp&lt;/b&gt; — Aidan Daly</title>");
        expect((await get("/sitemap.xml")).html).toContain("<loc>https://daly.id.au/projects/lamp</loc>");
        // Writing and the blog are unchanged.
        expect((await get("/blog")).status).toBe(200);
        expect((await get("/feed.xml")).status).toBe(200);
    });

    it("redirects a renamed project and removes an unpublished one", async () => {
        await setSwitch(true);
        await publishProject(testEnv, project(), media);
        await publishProject(testEnv, project({ slug: "desk-lamp" }), media);
        expect((await get("/projects/lamp")).location).toBe("https://daly.id.au/projects/desk-lamp");
        await unpublishProject(testEnv, 1);
        expect((await get("/projects/desk-lamp")).status).toBe(404);
        expect((await get("/projects/lamp")).status).toBe(404);
        expect((await get("/projects")).html).not.toContain("lamp");
        expect((await get("/")).html).toContain("Nothing is written up here yet.");
    });

    it("keeps a project's old addresses through an unpublish: 404 while it's off, redirecting again once it's back", async () => {
        await setSwitch(true);
        await publishProject(testEnv, project(), media);
        await publishProject(testEnv, project({ slug: "desk-lamp" }), media);
        await unpublishProject(testEnv, 1);
        for (const path of ["/projects/lamp", "/projects/desk-lamp"]) {
            const off = await get(path);
            expect(off.status, path).toBe(404);
            expect(off.location, path).toBeNull();
        }
        await publishProject(testEnv, project({ slug: "reading-lamp" }), media);
        expect((await get("/projects/lamp")).location).toBe("https://daly.id.au/projects/reading-lamp");
        expect((await get("/projects/desk-lamp")).location).toBe("https://daly.id.au/projects/reading-lamp");
        const index = (await get("/projects")).html;
        expect(index).toContain("/projects/reading-lamp");
        expect(index).not.toContain('/projects/desk-lamp"');
    });

    it("old addresses belong to the project, not to where it lived: another project taking its last address inherits none of them", async () => {
        await setSwitch(true);
        await publishProject(testEnv, project(), media);
        await publishProject(testEnv, project({ slug: "desk-lamp" }), media);
        await unpublishProject(testEnv, 1);
        await publishProject(testEnv, project({ id: 2, slug: "desk-lamp", title: "Another lamp" }), media);
        expect((await get("/projects/desk-lamp")).html).toContain("Another lamp");
        expect((await get("/projects/lamp")).status, "1's old address must not lead to 2").toBe(404);
        await publishProject(testEnv, project({ id: 2, slug: "floor-lamp", title: "Another lamp" }), media);
        expect((await get("/projects/desk-lamp")).location).toBe("https://daly.id.au/projects/floor-lamp");
        expect((await get("/projects/lamp")).status, "…nor follow 2 when it moves").toBe(404);
        await publishProject(testEnv, project({ slug: "old-lamp" }), media);
        expect((await get("/projects/lamp")).location).toBe("https://daly.id.au/projects/old-lamp");
        expect((await get("/projects/desk-lamp")).location).toBe("https://daly.id.au/projects/floor-lamp");
        const list = (await testEnv.DB.prepare("SELECT value FROM meta WHERE key = 'site:projects'").first<{ value: string }>())!.value;
        expect((JSON.parse(list) as Array<{ slug: string }>).map((p) => p.slug).sort()).toEqual(["floor-lamp", "old-lamp"]);
    });

    it("a project deleted for good releases its addresses", async () => {
        await setSwitch(true);
        await publishProject(testEnv, project(), media);
        await publishProject(testEnv, project({ slug: "desk-lamp" }), media);
        await unpublishProject(testEnv, 1);
        await unpublishProject(testEnv, 1, { forget: true });
        expect(
            (await testEnv.DB.prepare("SELECT key FROM meta WHERE key LIKE 'project-redirect:%' OR key LIKE 'project-id:%' OR key LIKE 'project:%'").all())
                .results,
        ).toEqual([]);
        await publishProject(testEnv, project({ slug: "new-thing", title: "Unrelated" }), media);
        expect((await get("/projects/lamp")).status).toBe(404);
        expect((await get("/projects/desk-lamp")).status).toBe(404);
    });

    it("writes a project and the project list in one batch, so a failed write can't leave them disagreeing", async () => {
        await setSwitch(true);
        await publishProject(testEnv, project(), media);
        // D1 can fail any one batch. Before, a project was written in one batch and the list in a second:
        // failing the second left the project at its new address but the list (cards, sitemap) at the old one.
        const failingAfterFirstBatch = () => {
            let batches = 0;
            return {
                ...testEnv,
                DB: new Proxy(testEnv.DB, {
                    get(target, prop) {
                        if (prop === "batch")
                            return async (statements: Parameters<typeof target.batch>[0]) => {
                                if (++batches > 1) throw new Error("D1 batch failed");
                                return target.batch(statements);
                            };
                        const value = Reflect.get(target, prop);
                        return typeof value === "function" ? value.bind(target) : value;
                    },
                }),
            } as never;
        };
        const consistent = async () => {
            const { results } = await testEnv.DB.prepare("SELECT key, value FROM meta WHERE key LIKE 'project:%' OR key = 'site:projects'").all<{
                key: string;
                value: string;
            }>();
            const list = JSON.parse(results.find((r) => r.key === "site:projects")?.value ?? "[]") as Array<{ slug: string; title: string }>;
            const snapshots = results.filter((r) => r.key.startsWith("project:")).map((r) => JSON.parse(r.value) as { slug: string; title: string });
            expect(list.map((p) => `${p.slug}:${p.title}`).sort()).toEqual(snapshots.map((p) => `${p.slug}:${p.title}`).sort());
            return list.map((p) => p.slug);
        };
        // And if the one batch fails, nothing has changed: there's no write outside it.
        const failingEveryBatch = {
            ...testEnv,
            DB: new Proxy(testEnv.DB, {
                get(target, prop) {
                    if (prop === "batch" || prop === "exec")
                        return async () => {
                            throw new Error("D1 batch failed");
                        };
                    const value = Reflect.get(target, prop);
                    if (prop === "prepare")
                        return (sql: string) => {
                            if (!/^\s*SELECT/i.test(sql)) throw new Error(`a write outside the batch: ${sql}`);
                            return target.prepare(sql);
                        };
                    return typeof value === "function" ? value.bind(target) : value;
                },
            }),
        } as never;
        const snapshot = async () =>
            (await testEnv.DB.prepare("SELECT key, value FROM meta WHERE key LIKE 'project%' OR key = 'site:projects' ORDER BY key").all()).results;
        const before = await snapshot();
        await expect(publishProject(failingEveryBatch, project({ slug: "desk-lamp", title: "Renamed" }), media)).rejects.toThrow();
        await expect(unpublishProject(failingEveryBatch, 1)).rejects.toThrow();
        expect(await snapshot()).toEqual(before);

        await publishProject(failingAfterFirstBatch(), project({ slug: "desk-lamp", title: "Renamed" }), media);
        expect(await consistent()).toEqual(["desk-lamp"]);
        await unpublishProject(failingAfterFirstBatch(), 1);
        expect(await consistent()).toEqual([]);
    });

    it("two projects published at the same moment both end up in the list", async () => {
        await setSwitch(true);
        // Hold every publish at the point of writing until all of them have got there, so each has done
        // all its reading before any has written: the interleaving in which a list built from an earlier
        // read loses a project.
        const publishers = 4;
        let waiting = 0;
        let release!: () => void;
        const allReady = new Promise<void>((resolve) => (release = resolve));
        const gated = {
            ...testEnv,
            DB: new Proxy(testEnv.DB, {
                get(target, prop) {
                    if (prop === "batch")
                        return async (statements: Parameters<typeof target.batch>[0]) => {
                            if (++waiting === publishers) release();
                            await allReady;
                            return target.batch(statements);
                        };
                    const value = Reflect.get(target, prop);
                    return typeof value === "function" ? value.bind(target) : value;
                },
            }),
        } as never;
        await Promise.all(
            Array.from({ length: publishers }, (_, i) =>
                publishProject(gated, project({ id: i + 1, slug: `lamp-${i + 1}`, title: `Lamp ${i + 1}`, featured: false, order: i }), media),
            ),
        );
        const stored = JSON.parse((await testEnv.DB.prepare("SELECT value FROM meta WHERE key = 'site:projects'").first<{ value: string }>())!.value) as Array<{
            slug: string;
            bodyHtml?: string;
        }>;
        expect(stored.map((p) => p.slug).sort()).toEqual(["lamp-1", "lamp-2", "lamp-3", "lamp-4"]);
        expect(
            stored.every((p) => p.bodyHtml === undefined),
            "the list carries summaries, not whole projects",
        ).toBe(true);
        const index = (await get("/projects")).html;
        for (let i = 1; i <= publishers; i++) expect(index).toContain(`/projects/lamp-${i}`);
        expect(index.indexOf("Lamp 1")).toBeLessThan(index.indexOf("Lamp 4"));
        expect((await get("/sitemap.xml")).html).toContain("/projects/lamp-3");

        // The same for taking projects down at the same moment as another goes up.
        waiting = 0;
        await Promise.all([
            unpublishProject(gated, 1),
            unpublishProject(gated, 2),
            publishProject(gated, project({ id: 5, slug: "lamp-5", title: "Lamp 5" }), media),
            unpublishProject(gated, 3),
        ]);
        const after = JSON.parse((await testEnv.DB.prepare("SELECT value FROM meta WHERE key = 'site:projects'").first<{ value: string }>())!.value) as Array<{
            slug: string;
        }>;
        expect(after.map((p) => p.slug).sort()).toEqual(["lamp-4", "lamp-5"]);
    });

    it("leaves a damaged snapshot out of the list instead of failing the publish", async () => {
        await setSwitch(true);
        await testEnv.DB.prepare("INSERT INTO meta (key, value) VALUES ('project:broken', '{not json')").run();
        await publishProject(testEnv, project(), media);
        expect((await get("/projects")).html).toContain("/projects/lamp");
        expect((await get("/projects/broken")).status).toBe(404);
    });

    it("switches on and off on the next request, through the edge cache", async () => {
        await publishProject(testEnv, project(), media);
        const design = async () => ((await get("/")).html.includes('class="site-v2"') ? "projects" : "classic");
        expect(await design()).toBe("classic");
        expect(await design()).toBe("classic"); // now cached
        await setSwitch(true);
        expect(await design()).toBe("projects");
        expect((await get("/projects/lamp")).status).toBe(200);
        await setSwitch(false);
        expect(await design()).toBe("classic");
        expect((await get("/projects/lamp")).status).toBe(404);
        await setSwitch(true);
        expect(await design()).toBe("projects");
    });

    it("uses the Daly brand icons only in the projects-first design", async () => {
        const classic = (await get("/")).html;
        expect(classic).toContain('href="/favicon.svg"');
        expect(classic).not.toContain("/brand/");
        await setSwitch(true);
        const branded = (await get("/")).html;
        expect(branded).toContain('<link rel="icon" href="/brand/favicon.svg"');
        expect(branded).toContain('href="/brand/favicon-32.png"');
        expect(branded).toContain('href="/brand/apple-touch-icon.png"');
        expect(branded).not.toContain('href="/favicon.ico"');
        // The logo is drawn inline, with the name for screen readers.
        expect(branded).toMatch(/<svg viewBox="0 0 437 180"[^>]*aria-hidden="true"/);
    });

    it("falls back safely from a damaged snapshot", async () => {
        await setSwitch(true);
        await testEnv.DB.batch([
            testEnv.DB.prepare("INSERT INTO meta (key, value) VALUES ('site:projects', '{not json')"),
            testEnv.DB.prepare("INSERT INTO meta (key, value) VALUES ('site:projects-home', ?)").bind(JSON.stringify({ heroTitle: 5, writingCount: 999 })),
        ]);
        const home = await get("/");
        expect(home.status).toBe(200);
        expect(home.html).toContain(DEFAULT_PROJECTS_HOME.heroTitle);
    });
});

describe("the projects-first menus", () => {
    const labels = (items: { label: string }[]) => items.map((i) => i.label);

    it("header: Projects, Writing, About, Wedding; Contact is in the footer", () => {
        const nav = [
            { label: "Home", href: "/" },
            { label: "Blog", href: "/blog" },
            { label: "About", href: "/about" },
            { label: "Contact", href: "/contact" },
        ];
        const { header, footer } = projectsMenus(nav, true);
        expect(labels(header)).toEqual(["Projects", "Writing", "About", "Wedding"]);
        expect(labels(footer)).toEqual(["Projects", "Writing", "About", "Contact"]);
        expect(labels(projectsMenus(nav, false).header)).toEqual(["Projects", "Writing", "About"]);
        // The menu as the site ships it, before anything is saved in Payload.
        expect(labels(projectsMenus(DEFAULT_SITE.nav, false).footer).at(-1)).toBe("Contact");
    });

    it("keeps what the editor chose: their own name for the blog, their own Projects label, extra items, the order", () => {
        const nav = [
            { label: "Notes", href: "/blog" },
            { label: "Work", href: "/projects" },
            { label: "Uses", href: "/uses" },
            { label: "Say hello", href: "/contact" },
        ];
        const { header, footer } = projectsMenus(nav, false);
        expect(labels(header)).toEqual(["Work", "Notes", "Uses"]);
        expect(labels(footer)).toEqual(["Work", "Notes", "Uses", "Say hello"]);
    });

    it("renders them: no Contact in the header, Contact in the footer", async () => {
        await setSwitch(true);
        const html = (await get("/")).html;
        const header = /<nav aria-label="Main"[\s\S]*?<\/nav>/.exec(html)![0];
        const footer = /<nav aria-label="Footer"[\s\S]*?<\/nav>/.exec(html)![0];
        expect(header).toContain(">Projects<");
        expect(header).toContain(">Writing<");
        expect(header).not.toContain("/contact");
        expect(footer).toContain('href="/contact"');
        expect(footer).not.toContain("Wedding");
        // The classic design's menu is untouched.
        await setSwitch(false);
        const classic = /<nav aria-label="Main"[\s\S]*?<\/nav>/.exec((await get("/")).html)![0];
        expect(classic).toContain(">Blog<");
    });
});

describe("the page cache's key", () => {
    const key = (address: string, build = "b1", content = "c1", variant = "v1") => pageCacheKey(new URL(address), build, content, variant);

    it("is the same for one page however the link was shared", () => {
        const plain = key("https://daly.id.au/blog/a-post");
        for (const shared of [
            "https://daly.id.au/blog/a-post?utm_source=newsletter&utm_medium=email",
            "https://daly.id.au/blog/a-post?fbclid=abc123",
            "https://daly.id.au/blog/a-post?ref=somewhere&gclid=x",
            // A visitor can't write the internal parts of the key themselves.
            "https://daly.id.au/blog/a-post?__b=other&__c=other&__v=other",
        ])
            expect(key(shared), shared).toBe(plain);
    });

    it("differs for everything that changes what a page shows", () => {
        const keys = [
            "https://daly.id.au/blog",
            "https://daly.id.au/blog?page=2",
            "https://daly.id.au/blog?category=Notes",
            "https://daly.id.au/blog?tag=cloudflare",
            "https://daly.id.au/blog?tag=cloudflare&page=2",
            "https://daly.id.au/projects",
        ].map((address) => key(address));
        expect(new Set(keys).size).toBe(keys.length);
        // The order parameters arrive in doesn't matter; tracking parameters beside real ones are dropped.
        expect(key("https://daly.id.au/blog?page=2&tag=cloudflare&utm_source=x")).toBe(key("https://daly.id.au/blog?tag=cloudflare&page=2"));
        // A parameter a page doesn't read under another spelling isn't a filter (readFilters reads `page`, not `Page`).
        expect(key("https://daly.id.au/blog?Page=2")).toBe(key("https://daly.id.au/blog"));
    });

    it("changes when the code, the content or the design does, so nothing stale is served", () => {
        const base = key("https://daly.id.au/");
        expect(key("https://daly.id.au/", "b2")).not.toBe(base);
        expect(key("https://daly.id.au/", "b1", "c2")).not.toBe(base);
        expect(key("https://daly.id.au/", "b1", "c1", "v2")).not.toBe(base);
    });
});
