// Projects and the projects-first homepage (Phase 4, docs/PAYLOAD-FRONTEND-PLAN.md): Payload publishes
// project snapshots (worker/site/publisher.ts); the pages exist publicly only once the switch is on; owners
// and admins can preview them at /portal/preview before that; every string is escaped; nothing unpublished
// is ever served.
import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PROJECTS_HOME, pageSlugProblem } from "../src/shared/site-content";
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
        expect((await get("/")).html).toContain("Projects are on their way");
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
