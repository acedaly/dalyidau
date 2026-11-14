// Draft preview (worker/site/preview.ts, docs/AUDIT-2026-11.md H5): a draft built by the publishers' preview
// mode is shown on the site's own pages to signed-in owners and admins only. Nothing public changes, nobody
// else can see the page or its images, and previews expire.
import { beforeEach, describe, expect, it } from "vitest";
import { PREVIEW_MEDIA_PREFIX, preparePayloadPost } from "../worker/blog/payload-publisher";
import { PREVIEW_MEDIA_TTL_MS, PREVIEW_TTL_MS, cleanPreviews, loadDraftPreview, previewPath, storeDraftPreview } from "../worker/site/preview";
import { publishPage, publishProject } from "../worker/site/publisher";
import { testEnv } from "./helpers";
import { sampleImage } from "./image-samples";
import { accessToken, apiCall, call, resetPortal } from "./portal-helpers";

const media = {
    loadMedia: async (id: string | number) => (String(id) === "7" ? { bytes: sampleImage("jpeg"), contentType: "image/jpeg", alt: "A draft picture" } : null),
    mode: "preview" as const,
};
const words = (text: string) => ({ root: { type: "root", children: [{ type: "paragraph", children: [{ type: "text", text }] }] } });
const now = () => new Date().toISOString();

beforeEach(async () => {
    await resetPortal();
    await testEnv.DB.prepare("DELETE FROM meta WHERE key != 'content_version'").run();
    for (const object of (await testEnv.MEDIA.list()).objects) await testEnv.MEDIA.delete(object.key);
});

async function draftPage() {
    const page = await publishPage(testEnv, { id: 5, slug: "now", title: "Now <draft>", content: words("Draft words & <b>marks</b>."), heroMediaId: 7 }, media);
    await storeDraftPreview(testEnv.DB, { kind: "page", createdAt: now(), published: false, data: page }, 5);
    return page;
}

describe("draft preview", () => {
    it("shows an owner the draft on the site's own page, escaped, marked as a preview, never cached or indexed", async () => {
        await draftPage();
        const response = await call(previewPath("page", 5), { token: await accessToken() });
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain("Now &lt;draft&gt;");
        expect(html).toContain("Draft words &amp; &lt;b&gt;marks&lt;/b&gt;.");
        expect(html).toContain("Draft preview: only you can see this.");
        expect(html).toContain("It isn’t on the website yet.");
        expect(response.headers.get("Cache-Control")).toBe("no-store");
        expect(response.headers.get("X-Robots-Tag")).toContain("noindex");
        expect(html).toMatch(/<meta name="robots" content="noindex/);
    });

    it("changes nothing public: the address, the sitemap and the image stay unknown to everyone else", async () => {
        const page = await draftPage();
        expect((await call("/now")).status).toBe(404);
        expect(await (await call("/sitemap.xml")).text()).not.toContain("/now");
        // The preview's image: nothing for the public, the picture for the owner, never from a cache.
        const src = page.image!.src;
        const anonymous = await call(src);
        expect(anonymous.status).toBe(404);
        const owner = await call(src, { token: await accessToken() });
        expect(owner.status).toBe(200);
        expect(owner.headers.get("Content-Type")).toBe("image/jpeg");
        expect(owner.headers.get("Cache-Control")).toBe("no-store");
        expect((await call(src)).status, "the owner's view wasn't cached for the next visitor").toBe(404);
        expect((await call(`/media/${PREVIEW_MEDIA_PREFIX}${src.slice(7)}`)).status).toBe(404);
    });

    it("is for owners and admins only", async () => {
        await draftPage();
        await apiCall("POST", "/api/portal/users", { email: "admin@example.com", role: "admin" });
        await apiCall("POST", "/api/portal/users", { email: "editor@example.com", role: "editor" });
        await apiCall("POST", "/api/portal/users", { email: "viewer@example.com", role: "viewer" });
        const as = async (email: string | null) => (await call(previewPath("page", 5), email ? { token: await accessToken({ email }) } : {})).status;
        expect(await as("admin@example.com")).toBe(200);
        expect(await as("editor@example.com")).toBe(404);
        expect(await as("viewer@example.com")).toBe(404);
        expect(await as("stranger@example.com")).not.toBe(200);
        expect(await as(null)).not.toBe(200);
        // The wedding host never serves it.
        expect((await call(previewPath("page", 5), { token: await accessToken(), host: "wedding.daly.id.au" })).status).not.toBe(200);
    });

    it("previews a project and a blog post the same way, and says when a published version exists", async () => {
        const project = await publishProject(
            testEnv,
            {
                id: 3,
                slug: "lamp",
                title: "Lamp",
                summary: "It glows.",
                content: words("Made by hand."),
                heroMediaId: 7,
                gallery: [{ mediaId: 7, caption: "On the desk" }],
            },
            media,
        );
        await storeDraftPreview(testEnv.DB, { kind: "project", createdAt: now(), published: true, data: project }, 3);
        const projectHtml = await (await call(previewPath("project", 3), { token: await accessToken() })).text();
        expect(projectHtml).toContain("Made by hand.");
        expect(projectHtml).toContain("On the desk");
        expect(projectHtml).toContain("The published page stays as it is until you publish.");
        expect((await call("/projects/lamp")).status).toBe(404);

        const prepared = await preparePayloadPost(
            testEnv,
            { postId: "payload:9", slug: "a-draft-post", title: "A draft post", content: words("Post words."), heroMediaId: 7 },
            media,
        );
        await storeDraftPreview(testEnv.DB, { kind: "post", createdAt: now(), published: false, data: { slug: prepared.slug, record: prepared.record } }, 9);
        const post = await call(previewPath("post", 9), { token: await accessToken() });
        expect(post.status).toBe(200);
        const postHtml = await post.text();
        expect(postHtml).toContain("A draft post");
        expect(postHtml).toContain("Post words.");
        expect((await call("/blog/a-draft-post")).status).toBe(404);
        expect(await (await call("/feed.xml")).text()).not.toContain("a-draft-post");
        expect((await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM posts").first<{ n: number }>())!.n).toBe(0);
    });

    it("expires after a day, refuses odd ids, and old previews and their images are cleaned up", async () => {
        const page = await draftPage();
        const later = new Date(Date.now() + PREVIEW_TTL_MS + 1000);
        expect(await loadDraftPreview(testEnv.DB, "page", "5")).not.toBeNull();
        expect(await loadDraftPreview(testEnv.DB, "page", "5", later)).toBeNull();
        expect(await loadDraftPreview(testEnv.DB, "project", "5")).toBeNull();
        expect(await loadDraftPreview(testEnv.DB, "page", "../5")).toBeNull();
        await expect(storeDraftPreview(testEnv.DB, { kind: "page", createdAt: now(), published: false, data: page }, "a/b")).rejects.toThrow();
        expect((await call("/portal/preview/draft/page/999", { token: await accessToken() })).status).toBe(404);

        expect(await cleanPreviews(testEnv.DB, testEnv.MEDIA)).toEqual({ previews: 0, images: 0 });
        expect(await cleanPreviews(testEnv.DB, testEnv.MEDIA, later)).toEqual({ previews: 1, images: 0 });
        expect((await call(previewPath("page", 5), { token: await accessToken() })).status).toBe(404);
        const muchLater = new Date(Date.now() + PREVIEW_MEDIA_TTL_MS + 60_000);
        expect((await cleanPreviews(testEnv.DB, testEnv.MEDIA, muchLater)).images).toBe(1);
        expect((await testEnv.MEDIA.list({ prefix: PREVIEW_MEDIA_PREFIX })).objects).toEqual([]);
    });
});
