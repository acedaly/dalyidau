// Retiring Capacities (docs/CAPACITIES_RETIREMENT.md): once its sync is switched off, nothing asks
// Capacities for anything, and every article it published stays exactly as it was: page, images,
// search, categories, tags, RSS, sitemap, redirects and SEO metadata. No missing token, failed
// request, empty listing or deleted object can unpublish it. The archive keeps a second copy and
// says when it's safe to cancel.
import { SELF, createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDS } from "../fixtures/capacities/fixtures.mjs";
import { archiveCapacities, capacitiesStatus, mediaKeys } from "../worker/capacities/archive";
import worker from "../worker/index";
import { runSync } from "../worker/sync";
import { type Mock, createMock, publishedSlugs, resetDb, setCapacitiesSync, sync, testEnv } from "./helpers";
import { apiCall, portalEnv } from "./portal-helpers";

const NOTEBOOK = "publishing-from-my-notebook";
const TRAINING = "running-a-good-training-session";
const ADMIN = { Authorization: `Bearer ${testEnv.ADMIN_TOKEN}` };

const get = async (path: string) => {
    const response = await SELF.fetch(`https://daly.id.au${path}`, { redirect: "manual" });
    return { status: response.status, html: await response.text(), location: response.headers.get("Location") };
};

/** Everything public about the blog that must survive: the full HTML of each page, feeds and search. */
const publicSnapshot = async () => {
    const posts = (
        await testEnv.DB.prepare("SELECT slug, image_key, body_html, category, tags FROM posts WHERE source = 'capacities' ORDER BY slug").all<{
            slug: string;
            image_key: string | null;
            body_html: string;
            category: string | null;
            tags: string;
        }>()
    ).results;
    const pages: Record<string, unknown> = {};
    for (const post of posts) {
        const article = await get(`/blog/${post.slug}`);
        pages[post.slug] = {
            status: article.status,
            body: /data-article-body[^>]*>([\s\S]*?)<\/div><footer/.exec(article.html)?.[1],
            head: /<head>([\s\S]*?)<\/head>/.exec(article.html)?.[1]?.replace(/nonce-[^'"]+|nonce="[^"]+"/g, ""),
        };
        for (const key of mediaKeys(post)) pages[`/media/${key}`] = (await SELF.fetch(`https://daly.id.au/media/${key}`)).status;
        if (post.category)
            pages[`category:${post.category}`] = (await get(`/blog?category=${encodeURIComponent(post.category)}`)).html.includes(`/blog/${post.slug}`);
        for (const tag of JSON.parse(post.tags) as string[])
            pages[`tag:${tag}`] = (await get(`/blog?tag=${encodeURIComponent(tag)}`)).html.includes(`/blog/${post.slug}`);
    }
    return {
        slugs: posts.map((p) => p.slug),
        pages,
        rss: (await get("/feed.xml")).html.replace(/<lastBuildDate>[^<]*<\/lastBuildDate>/, ""),
        sitemap: (await get("/sitemap.xml")).html,
        search: (await get("/blog?q=notebook")).html.includes(`/blog/${NOTEBOOK}`),
    };
};

let mock: Mock;

beforeEach(async () => {
    await resetDb();
    mock = createMock();
    await sync(mock);
    expect(await publishedSlugs()).toHaveLength(3);
});

afterEach(() => vi.restoreAllMocks());

describe("switching Capacities sync off", () => {
    it("is off unless switched on: the default never contacts Capacities", async () => {
        await testEnv.DB.prepare("DELETE FROM feature_flags WHERE key = 'website.capacities.sync'").run();
        const calls = vi.fn(mock.handle);
        const result = await runSync(testEnv, {
            trigger: "test",
            fetchImpl: ((input: RequestInfo, init?: RequestInit) => calls(new Request(input, init))) as typeof fetch,
        });
        expect(result.status).toBe("off");
        expect(calls).not.toHaveBeenCalled();
        expect(await publishedSlugs()).toHaveLength(3);
    });

    it("stops the scheduled job from calling Capacities, and records no run", async () => {
        await setCapacitiesSync(false);
        const runs = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM sync_runs").first<{ n: number }>();
        const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => mock.handle(new Request(input as RequestInfo, init)));
        const ctx = createExecutionContext();
        await worker.scheduled(createScheduledController({ scheduledTime: Date.now(), cron: "*/15 * * * *" }) as never, testEnv, ctx as never);
        await waitOnExecutionContext(ctx);
        expect(fetchSpy.mock.calls.filter(([input]) => String(input instanceof Request ? input.url : input).includes("capacities"))).toHaveLength(0);
        expect(await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM sync_runs").first<{ n: number }>()).toEqual(runs);
        expect(await publishedSlugs()).toHaveLength(3);
    });

    it("refuses a manual sync with a clear answer", async () => {
        await setCapacitiesSync(false);
        const fetchSpy = vi.spyOn(globalThis, "fetch");
        const response = await SELF.fetch("https://daly.id.au/api/admin/sync?force=1", { method: "POST", headers: ADMIN });
        expect(response.status).toBe(409);
        expect(((await response.json()) as { error: string }).error).toMatch(/switched off/);
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(await publishedSlugs()).toHaveLength(3);
    });

    it("keeps every archived article exactly as it was, whatever happens to Capacities", async () => {
        mock.control.setSlug(IDS.training, "training-sessions-that-work"); // An old address that must keep redirecting.
        await sync(mock);
        const before = await publicSnapshot();
        expect(before.rss).toContain("Publishing straight from my notebook");
        expect(Object.values(before.pages).filter((v) => v === 200).length).toBeGreaterThan(0);

        await setCapacitiesSync(false);
        // Capacities goes away entirely: every object removed, then every request failing, then no token at all.
        for (const id of Object.values(IDS)) mock.control.remove(id);
        mock.control.fail("all");
        for (const overrides of [{}, { CAPACITIES_API_TOKEN: undefined }, { CAPACITIES_API_TOKEN: "revoked-token" }]) {
            for (let i = 0; i < 3; i++) await sync(mock, overrides);
            await setCapacitiesSync(false); // sync() switches it on for the Capacities tests; off is what's being tested.
            for (let i = 0; i < 3; i++)
                await runSync(
                    { ...testEnv, ...overrides },
                    { trigger: "cron", fetchImpl: ((input: RequestInfo, init?: RequestInit) => mock.handle(new Request(input, init))) as typeof fetch },
                );
            await setCapacitiesSync(true);
        }
        await setCapacitiesSync(false);
        const ctx = createExecutionContext();
        await worker.scheduled(createScheduledController({ scheduledTime: Date.now(), cron: "*/15 * * * *" }) as never, testEnv, ctx as never);
        await waitOnExecutionContext(ctx);

        const after = await publicSnapshot();
        expect(after).toEqual(before);
        const old = await get(`/blog/${TRAINING}`);
        expect(old.status).toBe(301);
        expect(old.location).toBe("https://daly.id.au/blog/training-sessions-that-work");
    });
});

describe("with Capacities sync still on", () => {
    it("never unpublishes because the token is missing or Capacities is unreachable", async () => {
        for (let i = 0; i < 3; i++) expect((await sync(mock, { CAPACITIES_API_TOKEN: undefined })).status).toBe("failed");
        mock.control.fail("all");
        for (let i = 0; i < 3; i++) await sync(mock);
        expect(await publishedSlugs()).toHaveLength(3);
    });

    it("treats an empty listing (a lapsed subscription or moved space) as an outage, not as every article deleted", async () => {
        for (const id of Object.values(IDS)) mock.control.remove(id);
        for (let i = 0; i < 4; i++) {
            const result = await sync(mock);
            expect(result.unpublished).toBe(0);
        }
        expect(await publishedSlugs()).toHaveLength(3);
        const run = await testEnv.DB.prepare("SELECT log FROM sync_runs ORDER BY id DESC LIMIT 1").first<{ log: string }>();
        expect(run!.log).toMatch(/listed no Blog Posts while 3 are published/);
    });

    it("still unpublishes a single article taken down in Capacities (the switch changes nothing else)", async () => {
        mock.control.setStatus(IDS.training, "Draft");
        await sync(mock, {}, true);
        expect(await publishedSlugs()).toHaveLength(2);
    });
});

describe("the archive", () => {
    it("copies every article, checks every image in R2, and only then says it's safe to retire", async () => {
        const initial = await capacitiesStatus(testEnv);
        expect(initial.safeToRetire).toBe(false);
        expect(initial.articles.every((a) => a.archive === "none")).toBe(true);
        expect(initial.checks.find((c) => c.id === "sync-off")!.ok).toBe(false);

        await setCapacitiesSync(false);
        const status = await archiveCapacities(testEnv, "owner@example.com");
        expect(status.totals.articles).toBe(3);
        expect(status.totals.images).toBeGreaterThan(0);
        expect(status.totals.missingImages).toBe(0);
        expect(status.articles.every((a) => a.archive === "current")).toBe(true);
        expect(status.safeToRetire).toBe(true);

        // The archived copy is the published row, column for column.
        const live = await testEnv.DB.prepare("SELECT * FROM posts WHERE slug = ?").bind(NOTEBOOK).first<Record<string, unknown>>();
        const copy = await testEnv.DB.prepare("SELECT * FROM capacities_archive WHERE id = ?").bind(live!.id).first<Record<string, unknown>>();
        for (const [column, value] of Object.entries(live!)) if (column !== "source") expect(copy![column], column).toEqual(value);
        expect(JSON.parse(String(copy!.media_keys))).toContain(live!.image_key);

        // Archiving changed nothing public.
        expect(await publishedSlugs()).toHaveLength(3);
    });

    it("isn't safe to retire while an image is missing from R2", async () => {
        await setCapacitiesSync(false);
        const post = await testEnv.DB.prepare("SELECT image_key FROM posts WHERE slug = ?").bind(NOTEBOOK).first<{ image_key: string }>();
        await testEnv.MEDIA.delete(post!.image_key);
        const status = await archiveCapacities(testEnv, "owner@example.com");
        expect(status.totals.missingImages).toBe(1);
        expect(status.safeToRetire).toBe(false);
        expect(status.articles.find((a) => a.slug === NOTEBOOK)!.missingImages).toBe(1);
    });

    it("notices an archive that no longer matches what's published", async () => {
        await archiveCapacities(testEnv, "owner@example.com");
        mock.control.appendParagraph(IDS.notebook, "Written after archiving.");
        await sync(mock);
        expect((await capacitiesStatus(testEnv)).articles.find((a) => a.slug === NOTEBOOK)!.archive).toBe("outdated");
    });

    it("is owner and admin only, audited, and shown in Portal settings → Website & Blog", async () => {
        const env = await portalEnv();
        expect((await apiCall("POST", "/api/portal/users", { email: "editor@example.com", role: "editor" }, { env })).status).toBe(200);
        expect((await apiCall("POST", "/api/portal/website/capacities/archive", {}, { email: "editor@example.com", env })).status).toBe(403);
        const response = await apiCall<{ capacities: { totals: { articles: number } } }>("POST", "/api/portal/website/capacities/archive", {}, { env });
        expect(response.status).toBe(200);
        expect(response.json.capacities.totals.articles).toBe(3);
        const audit = await testEnv.DB.prepare("SELECT action FROM audit_log WHERE action = 'website.capacities.archive'").first();
        expect(audit).not.toBeNull();
    });
});
