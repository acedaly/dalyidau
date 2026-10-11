import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { IDS } from "../fixtures/capacities/fixtures.mjs";
import { MISSING_THRESHOLD } from "../worker/sync";
import { type Mock, createMock, publishedSlugs, resetDb, sync, testEnv } from "./helpers";

const NOTEBOOK = "publishing-from-my-notebook";
const TRAINING = "running-a-good-training-session";
const TOOLS = "small-tools-and-big-wins-quotes-tags-and-unicode";

const page = async (path: string) => {
    const response = await SELF.fetch(`https://daly.id.au${path}`, { redirect: "manual" });
    return { status: response.status, html: await response.text(), location: response.headers.get("Location") };
};

let mock: Mock;

beforeEach(async () => {
    await resetDb();
    mock = createMock();
});

describe("publishing rules", () => {
    it("publishes only Blog Posts whose Status is Published", async () => {
        const result = await sync(mock);
        expect(result.status).toBe("ok");
        expect(result.published).toBe(3);
        expect(await publishedSlugs()).toEqual([TRAINING, NOTEBOOK, TOOLS].sort());
    });

    it("keeps drafts, archived posts and posts without a status private", async () => {
        await sync(mock);
        for (const slug of ["secret-draft", "archived-post", "no-status", "a-draft-that-must-stay-private"]) {
            expect((await page(`/blog/${slug}`)).status).toBe(404);
        }
        const everything = await testEnv.DB.prepare("SELECT * FROM posts").all();
        expect(JSON.stringify(everything.results)).not.toMatch(/PRIVATE/);
        for (const path of ["/", "/blog", "/feed.xml", "/sitemap.xml"]) {
            expect((await page(path)).html).not.toMatch(/PRIVATE|secret-draft|archived-post/);
        }
        // Searching for draft-only text finds nothing.
        const search = await page("/blog?q=PRIVATE%20DRAFT");
        expect(search.html).toContain("No articles found");
        expect(search.html).not.toContain("PRIVATE DRAFT CONTENT");
    });

    it("never exposes private objects referenced from a published post", async () => {
        await sync(mock);
        const { html } = await page(`/blog/${NOTEBOOK}`);
        expect(html).not.toContain("PRIVATE PERSON NAME");
        expect(html).not.toContain("PRIVATE NOTE TITLE");
        expect(html).not.toContain(IDS.privateNote);
        // The link text stays, but it is not a link.
        expect(html).toMatch(/Links to private notes turn into plain text/);
    });

    it("updates a published article when it is edited", async () => {
        await sync(mock);
        mock.control.appendParagraph(IDS.notebook, "A fresh paragraph added later.");
        mock.control.setTitle(IDS.notebook, "Publishing straight from my notebook, revised");
        const result = await sync(mock);
        expect(result.updated).toBe(1);
        const { html } = await page(`/blog/${NOTEBOOK}`);
        expect(html).toContain("A fresh paragraph added later.");
        expect(html).toContain("Publishing straight from my notebook, revised");
    });

    it("does no work for unchanged posts", async () => {
        await sync(mock);
        const second = await sync(mock);
        expect(second.unchanged).toBe(3);
        expect(second.published + second.updated).toBe(0);
    });

    it("unpublishes a post when its status leaves Published", async () => {
        await sync(mock);
        mock.control.setStatus(IDS.training, "Draft");
        const result = await sync(mock);
        expect(result.unpublished).toBe(1);
        expect((await page(`/blog/${TRAINING}`)).status).toBe(404);
        expect((await page("/blog")).html).not.toContain("Notes on running a good training session");

        mock.control.setStatus(IDS.tools, "Archived");
        mock.control.setStatus(IDS.notebook, null);
        await sync(mock);
        expect(await publishedSlugs()).toEqual([]);
    });

    it("keeps old URLs working after a slug change", async () => {
        await sync(mock);
        mock.control.setSlug(IDS.training, "training-sessions-that-work");
        await sync(mock);
        const old = await page(`/blog/${TRAINING}`);
        expect(old.status).toBe(301);
        expect(old.location).toBe("https://daly.id.au/blog/training-sessions-that-work");
        expect((await page("/blog/training-sessions-that-work")).status).toBe(200);
        // The other post's link to it follows the rename.
        expect((await page(`/blog/${NOTEBOOK}`)).html).toContain('href="/blog/training-sessions-that-work"');
    });

    it("never creates duplicates for the same object", async () => {
        await sync(mock);
        mock.control.setSlug(IDS.notebook, "renamed");
        await sync(mock);
        await sync(mock, {}, true);
        const count = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM posts WHERE id = ?").bind(IDS.notebook).first<{ n: number }>();
        expect(count?.n).toBe(1);
    });

    it("refuses a slug that another post already uses", async () => {
        await sync(mock);
        mock.control.setSlug(IDS.tools, TRAINING);
        const result = await sync(mock);
        expect(result.errors).toBe(1);
        // Both posts keep their last good versions.
        expect(await publishedSlugs()).toEqual([TRAINING, NOTEBOOK, TOOLS].sort());
    });
});

describe("failure handling", () => {
    it("changes nothing when the structures request fails", async () => {
        await sync(mock);
        mock.control.fail("structures");
        const result = await sync(mock);
        expect(result.status).toBe("failed");
        expect(await publishedSlugs()).toHaveLength(3);
    });

    it("changes nothing during a full API outage", async () => {
        await sync(mock);
        mock.control.fail("all");
        await sync(mock);
        await sync(mock);
        expect(await publishedSlugs()).toHaveLength(3);
    });

    it("does not treat a failed listing as deletions", async () => {
        await sync(mock);
        mock.control.fail("listing");
        for (let i = 0; i < MISSING_THRESHOLD + 1; i++) await sync(mock);
        expect(await publishedSlugs()).toHaveLength(3);
    });

    it("keeps the last valid version when one object fails to load", async () => {
        await sync(mock);
        mock.control.appendParagraph(IDS.notebook, "Edit that cannot be fetched yet.");
        mock.control.fail(`object:${IDS.notebook}`);
        const result = await sync(mock);
        expect(result.errors).toBe(1);
        const { status, html } = await page(`/blog/${NOTEBOOK}`);
        expect(status).toBe(200);
        expect(html).not.toContain("Edit that cannot be fetched yet.");
        mock.control.recover();
        await sync(mock);
        expect((await page(`/blog/${NOTEBOOK}`)).html).toContain("Edit that cannot be fetched yet.");
    });

    it("removes a deleted object only after repeated absence from complete listings", async () => {
        await sync(mock);
        mock.control.remove(IDS.training);
        await sync(mock);
        expect(await publishedSlugs()).toContain(TRAINING);
        await sync(mock);
        expect(await publishedSlugs()).not.toContain(TRAINING);
    });

    it("fails closed when the Status cannot be read", async () => {
        const object = mock.control.state.objects.get(IDS.draft);
        for (const key of Object.keys(object.properties)) if (object.properties[key].type === "label" && key !== "tags") delete object.properties[key];
        const result = await sync(mock);
        expect(await publishedSlugs()).not.toContain("secret-draft");
        expect(result.errors).toBeGreaterThan(0);
    });

    it("fails closed when the type has no Published option", async () => {
        const realHandle = mock.handle;
        mock.handle = async (request: Request) => {
            const response = await realHandle(request);
            if (!new URL(request.url).pathname.startsWith("/space/structures")) return response;
            const body = (await response.json()) as { structures: { propertyDefinitions: { name: string; labelSet?: { name: string }[] }[] }[] };
            const status = body.structures[0].propertyDefinitions.find((d) => d.name === "Status")!;
            status.labelSet = status.labelSet!.filter((o) => o.name !== "Published");
            return Response.json(body);
        };
        const result = await sync(mock);
        expect(result.status).toBe("failed");
        expect(await publishedSlugs()).toEqual([]);
    });

    it("spreads work across runs when the request budget is small", async () => {
        const first = await sync(mock, { SYNC_MAX_REQUESTS: "12" });
        expect(first.log.join("\n")).toMatch(/deferred|budget/i);
        for (let i = 0; i < 6; i++) await sync(mock, { SYNC_MAX_REQUESTS: "12" });
        expect(await publishedSlugs()).toHaveLength(3);
    });

    it("records each run in the sync log", async () => {
        await sync(mock);
        const runs = await testEnv.DB.prepare("SELECT status, published FROM sync_runs").all<{ status: string; published: number }>();
        expect(runs.results).toEqual([{ status: "ok", published: 3 }]);
    });
});

describe("content", () => {
    it("escapes special characters and drops unsafe links", async () => {
        await sync(mock);
        const { html } = await page(`/blog/${TOOLS}`);
        expect(html).not.toMatch(/<script>alert/);
        expect(html).toContain("&lt;script&gt;alert(&#39;boom&#39;)&lt;/script&gt;");
        expect(html).not.toContain('href="javascript:');
        expect(html).not.toContain('href="data:');
        expect(html).toContain("東京");
        expect(html).toContain("<title>Small tools &amp; big wins — “quotes”, &lt;tags&gt; and ünïcödé — Aidan Daly</title>");
    });

    it("renders formatting from Capacities blocks", async () => {
        await sync(mock);
        const { html } = await page(`/blog/${NOTEBOOK}`);
        expect(html).toContain('<h2 id="why-write-in-a-notebook-first">');
        expect(html).toMatch(/<ol><li>Lists Blog Post objects/);
        expect(html).toMatch(/<ul><li>Images are copied into R2\.<\/li>/);
        expect(html).toContain('<aside class="callout" data-tone="info">');
        expect(html).toContain("<blockquote><p>The best system is the one you actually use.</p></blockquote>");
        expect(html).toContain('<pre data-lang="typescript"><code class="language-typescript">');
        expect(html).toContain("<th>Step</th>");
        expect(html).toContain("youtube-nocookie.com/embed/dQw4w9WgXcQ");
        expect(html).toContain("<details><summary>Open for a tangent</summary>");
        expect(html).toContain('<input type="checkbox" disabled checked');
        expect(html).toContain("<hr>");
        expect(html).toContain('<figure class="pullquote">');
    });

    it("copies images into R2 and serves them from the site", async () => {
        await sync(mock);
        const { html } = await page(`/blog/${NOTEBOOK}`);
        const src = /<figure class="image"><img src="(\/media\/[a-f0-9]{24}\.png)"/.exec(html)?.[1];
        expect(src).toBeTruthy();
        expect(html).toContain('alt="Soft lilac shapes"');
        expect(html).toContain("<figcaption>A sample inline image with a caption.</figcaption>");
        const image = await SELF.fetch(`https://daly.id.au${src}`);
        expect(image.status).toBe(200);
        expect(image.headers.get("Content-Type")).toBe("image/png");
        expect(image.headers.get("Cache-Control")).toContain("immutable");
        // The API token is never sent to the file host (the mock rejects it).
        expect(mock.control.state.requests.some((r) => r.startsWith("GET /__files/"))).toBe(true);
        // Featured image on the card.
        expect((await page("/blog")).html).toMatch(/<img src="\/media\/[a-f0-9]{24}\.jpg"/);
    });

    it("picks up changes to referenced objects once their cache goes stale", async () => {
        await sync(mock);
        mock.control.state.objects.get(IDS.tagWriting).properties.title.title.value = "Writing well";
        mock.control.state.objects.get(IDS.imgInline).properties.description.text.value = "An updated caption.";
        // Fresh caches: nothing re-read, nothing re-rendered.
        expect((await sync(mock)).unchanged).toBe(3);
        expect((await page(`/blog/${NOTEBOOK}`)).html).not.toContain("An updated caption.");

        const old = new Date(Date.now() - 8 * 86_400_000).toISOString();
        await testEnv.DB.batch([
            testEnv.DB.prepare("UPDATE posts SET synced_at = ?").bind(old),
            testEnv.DB.prepare("UPDATE entity_cache SET checked_at = ?").bind(old),
            testEnv.DB.prepare("UPDATE media SET checked_at = ?").bind(old),
        ]);
        await sync(mock);
        const { html } = await page(`/blog/${NOTEBOOK}`);
        expect(html).toContain("<figcaption>An updated caption.</figcaption>");
        expect(html).toContain("Writing well");
    });

    it("a forced sync refreshes cached images and references", async () => {
        await sync(mock);
        mock.control.state.objects.get(IDS.imgInline).properties.description.text.value = "Forced caption.";
        await sync(mock, {}, true);
        expect((await page(`/blog/${NOTEBOOK}`)).html).toContain("<figcaption>Forced caption.</figcaption>");
    });

    it("resolves Capacities tags to names", async () => {
        await sync(mock);
        const tags = await testEnv.DB.prepare("SELECT tags FROM posts WHERE id = ?").bind(IDS.notebook).first<{ tags: string }>();
        expect(JSON.parse(tags!.tags)).toEqual(["Capacities", "Systems thinking", "Writing"]);
    });
});
