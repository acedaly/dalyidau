// Smaller copies of published images (docs/AUDIT-2026-11.md, H6): made at publish time and by the media
// route, only at the site's own widths, in the best format the browser accepts, and never able to break a
// publish or a page.
import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { variantSrcSet } from "../src/shared/image-variants";
import { publishPayloadPost } from "../worker/blog/payload-publisher";
import { imageMode, mediaUrls } from "../worker/lib/image";
import { type ImagesBinding, canResize, ensureVariant, prepareVariants, variantFormat, variantKey, variantWidths } from "../worker/lib/image-variants";
import { publishProject } from "../worker/site/publisher";
import { resetDb, testEnv } from "./helpers";
import { pngOfSize, sampleImage } from "./image-samples";

const KEY = "0123456789abcdef01234567.jpg";

/** Stands in for Cloudflare's Images binding: records what was asked and answers with labelled bytes. */
const fakeImages = (options: { fail?: boolean; answerAs?: string } = {}) => {
    const calls: Array<{ width?: number; fit?: string; format: string; quality?: number }> = [];
    const binding: ImagesBinding = {
        input: () => ({
            transform: (transform) => ({
                output: async (output) => {
                    calls.push({ ...transform, ...output });
                    if (options.fail) throw new Error("9422: transformation limit reached");
                    return {
                        response: () =>
                            new Response(`resized:${transform.width}:${output.format}`, { headers: { "Content-Type": options.answerAs ?? output.format } }),
                    };
                },
            }),
        }),
    };
    return { binding, calls };
};
const stored = async () => (await testEnv.MEDIA.list()).objects.map((o) => o.key).sort();
const words = (text: string) => ({ root: { type: "root", children: [{ type: "paragraph", children: [{ type: "text", text }] }] } });

beforeEach(async () => {
    await resetDb();
    await testEnv.DB.prepare("DELETE FROM meta").run();
});

describe("which copies exist", () => {
    it("offers only smaller widths, only for the site's own resizable images", () => {
        expect(variantWidths(KEY, 3000)).toEqual([480, 960, 1600]);
        expect(variantWidths(KEY, 1200)).toEqual([480, 960]);
        expect(variantWidths(KEY, 480)).toEqual([]);
        expect(variantWidths(KEY, null)).toEqual([]);
        // An animated image is served as it is.
        expect(canResize("0123456789abcdef01234567.gif")).toBe(false);
        expect(variantWidths("0123456789abcdef01234567.gif", 3000)).toEqual([]);
        expect(canResize("../secret.jpg")).toBe(false);
    });

    it("lists them in srcset, closing with the original at its own width", () => {
        expect(mediaUrls(KEY, 1200, "variants")).toEqual({
            src: `/media/${KEY}`,
            srcSet: `/media/${KEY}?w=480 480w, /media/${KEY}?w=960 960w, /media/${KEY} 1200w`,
        });
        expect(mediaUrls(KEY, 400, "variants")).toEqual({ src: `/media/${KEY}` });
        expect(mediaUrls(KEY, null, "variants")).toEqual({ src: `/media/${KEY}` });
        expect(mediaUrls(KEY, 1200, false)).toEqual({ src: `/media/${KEY}` });
        // The page components build the same list from a snapshot's image.
        expect(variantSrcSet(`/media/${KEY}`, 1200)).toBe(mediaUrls(KEY, 1200, "variants").srcSet);
        expect(variantSrcSet("/media/0123456789abcdef01234567.gif", 1200)).toBeUndefined();
        expect(variantSrcSet("https://example.com/a.jpg", 1200)).toBeUndefined();
        expect(variantSrcSet("/wedding/media/x.jpg", 1200)).toBeUndefined();
        expect([imageMode("variants"), imageMode("on"), imageMode("off"), imageMode(undefined)]).toEqual(["variants", true, false, false]);
    });

    it("answers in AVIF or WebP when the browser accepts one; otherwise with the original, never a third format", () => {
        expect(variantFormat(KEY, "image/avif,image/webp,image/*")).toBe("avif");
        expect(variantFormat(KEY, "image/webp,image/*")).toBe("webp");
        expect(variantFormat(KEY, "image/*")).toBeNull();
        expect(variantFormat(KEY, "*/*")).toBeNull();
        expect(variantFormat(KEY, null)).toBeNull();
        expect(variantFormat("0123456789abcdef01234567.gif", "image/avif")).toBeNull();
    });
});

describe("making a copy", () => {
    it("makes it once, keeps it in the bucket, and never enlarges", async () => {
        await testEnv.MEDIA.put(KEY, sampleImage("jpeg"));
        const { binding, calls } = fakeImages();
        const env = { MEDIA: testEnv.MEDIA, IMAGES: binding };
        const first = await ensureVariant(env, KEY, 960, "webp");
        expect(first?.contentType).toBe("image/webp");
        expect(calls).toEqual([{ width: 960, fit: "scale-down", format: "image/webp", quality: 80 }]);
        // Two requests arriving together for a copy that isn't made yet share the making.
        const together = await Promise.all([ensureVariant(env, KEY, 480, "avif"), ensureVariant(env, KEY, 480, "avif"), ensureVariant(env, KEY, 480, "avif")]);
        expect(together.every(Boolean)).toBe(true);
        expect(calls.filter((c) => c.width === 480)).toHaveLength(1);
        calls.length = 1;
        await testEnv.MEDIA.delete(variantKey(KEY, 480, "avif"));
        expect(await stored()).toEqual([KEY, variantKey(KEY, 960, "webp")]);
        expect(await (await testEnv.MEDIA.get(variantKey(KEY, 960, "webp")))!.text()).toBe("resized:960:image/webp");
        // Asked for again: read from the bucket, not made again.
        const again = await ensureVariant(env, KEY, 960, "webp");
        expect(again?.contentType).toBe("image/webp");
        expect(calls).toHaveLength(1);
        // And still there for a Worker with no binding at all.
        expect(await ensureVariant({ MEDIA: testEnv.MEDIA }, KEY, 960, "webp")).not.toBeNull();
    });

    it("gives up quietly, storing nothing, when it can't be made", async () => {
        await testEnv.MEDIA.put(KEY, sampleImage("jpeg"));
        // No binding (a Worker without it, or local development).
        expect(await ensureVariant({ MEDIA: testEnv.MEDIA }, KEY, 480, "avif")).toBeNull();
        // The service refuses (over the free allowance, a file it can't read).
        expect(await ensureVariant({ MEDIA: testEnv.MEDIA, IMAGES: fakeImages({ fail: true }).binding }, KEY, 480, "avif")).toBeNull();
        // The service answers in another format than asked: not stored under the wrong name.
        expect(await ensureVariant({ MEDIA: testEnv.MEDIA, IMAGES: fakeImages({ answerAs: "image/jpeg" }).binding }, KEY, 480, "avif")).toBeNull();
        // No original; an animated image; a key that isn't one of ours.
        const { binding, calls } = fakeImages();
        expect(await ensureVariant({ MEDIA: testEnv.MEDIA, IMAGES: binding }, "ffffffffffffffffffffffff.jpg", 480, "avif")).toBeNull();
        expect(await ensureVariant({ MEDIA: testEnv.MEDIA, IMAGES: binding }, "0123456789abcdef01234567.gif", 480, "avif")).toBeNull();
        expect(calls).toEqual([]);
        expect(await stored()).toEqual([KEY]);
    });

    it("prepares every smaller copy in both modern formats", async () => {
        await testEnv.MEDIA.put(KEY, sampleImage("jpeg"));
        const { binding, calls } = fakeImages();
        expect(await prepareVariants({ MEDIA: testEnv.MEDIA, IMAGES: binding }, KEY, 1200)).toBe(4);
        expect(calls.map((c) => `${c.width}:${c.format}`).sort()).toEqual(["480:image/avif", "480:image/webp", "960:image/avif", "960:image/webp"]);
        expect(await prepareVariants({ MEDIA: testEnv.MEDIA }, KEY, 1200)).toBe(0);
        expect(await prepareVariants({ MEDIA: testEnv.MEDIA, IMAGES: binding }, KEY, 300)).toBe(0);
        // From the bytes the publisher already holds: the original isn't read from the bucket again.
        const fromBytes = fakeImages();
        const noOriginal = "aaaaaaaaaaaaaaaaaaaaaaaa.jpg";
        expect(await prepareVariants({ MEDIA: testEnv.MEDIA, IMAGES: fromBytes.binding }, noOriginal, 1200, sampleImage("jpeg"))).toBe(4);
        // A publish makes a bounded number ahead of time; the rest are left to the media route.
        const budget = { left: 3 };
        const bounded = fakeImages();
        expect(
            await prepareVariants({ MEDIA: testEnv.MEDIA, IMAGES: bounded.binding }, "bbbbbbbbbbbbbbbbbbbbbbbb.jpg", 3000, sampleImage("jpeg"), budget),
        ).toBe(3);
        expect(
            await prepareVariants({ MEDIA: testEnv.MEDIA, IMAGES: bounded.binding }, "cccccccccccccccccccccccc.jpg", 3000, sampleImage("jpeg"), budget),
        ).toBe(0);
        expect([bounded.calls.length, budget.left]).toEqual([3, 0]);
    });
});

describe("publishing", () => {
    // 2,000 pixels wide: every smaller width is worth making.
    const wide = async () => ({ loadMedia: async () => ({ bytes: await pngOfSize(2000, 4), contentType: "image/png", alt: "A wide picture" }) });
    const post = { postId: "payload:1", slug: "hello", title: "Hello", content: words("Words."), heroMediaId: 7, publishedAt: "2026-11-01T00:00:00.000Z" };

    it("makes the copies as the image is published, when the site is set to", async () => {
        const { binding, calls } = fakeImages();
        await publishPayloadPost({ ...testEnv, IMAGE_TRANSFORMS: "variants", IMAGES: binding }, post, await wide());
        const row = await testEnv.DB.prepare("SELECT image_key, image_width FROM posts WHERE id = 'payload:1'").first<{
            image_key: string;
            image_width: number;
        }>();
        expect(row!.image_width).toBe(2000);
        expect(calls.map((c) => `${c.width}:${c.format}`).sort()).toEqual([
            "1600:image/avif",
            "1600:image/webp",
            "480:image/avif",
            "480:image/webp",
            "960:image/avif",
            "960:image/webp",
        ]);
        expect((await stored()).filter((k) => k.startsWith("variants/"))).toHaveLength(6);
        // The published page asks for them: the featured image carries a srcset of the site's own copies.
        const html = await (await SELF.fetch("https://daly.id.au/blog/hello")).text();
        expect(testEnv.IMAGE_TRANSFORMS).toBe("variants");
        expect(html).toContain(`/media/${row!.image_key}?w=960 960w`);
        // Published again: nothing is made twice.
        await publishPayloadPost({ ...testEnv, IMAGE_TRANSFORMS: "variants", IMAGES: binding }, { ...post, title: "Hello again" }, await wide());
        expect(calls).toHaveLength(6);
        // Set not to: the original alone, exactly as before.
        const quiet = fakeImages();
        await publishPayloadPost({ ...testEnv, IMAGE_TRANSFORMS: "off", IMAGES: quiet.binding }, { ...post, postId: "payload:2", slug: "again" }, await wide());
        expect(quiet.calls).toEqual([]);
    });

    it("a publish succeeds, with the original, even when no copy can be made", async () => {
        const refusing = fakeImages({ fail: true });
        const outcome = await publishPayloadPost({ ...testEnv, IMAGE_TRANSFORMS: "variants", IMAGES: refusing.binding }, post, await wide());
        expect(outcome.outcome).toBe("published");
        expect(refusing.calls.length).toBeGreaterThan(0);
        expect((await SELF.fetch("https://daly.id.au/blog/hello")).status).toBe(200);
        await publishProject(
            { ...testEnv, IMAGE_TRANSFORMS: "variants", IMAGES: refusing.binding },
            { id: 1, slug: "lamp", title: "Lamp", heroMediaId: 7 },
            await wide(),
        );
        expect((await stored()).filter((k) => k.startsWith("variants/"))).toEqual([]);
    });

    it("an image in the text of an article is given its smaller copies too", async () => {
        const content = {
            root: {
                type: "root",
                children: [
                    { type: "upload", relationTo: "media", value: 7 },
                    { type: "paragraph", children: [{ type: "text", text: "Words." }] },
                ],
            },
        };
        const { binding } = fakeImages();
        await publishPayloadPost({ ...testEnv, IMAGE_TRANSFORMS: "variants", IMAGES: binding }, { ...post, content, heroMediaId: null }, await wide());
        const row = await testEnv.DB.prepare("SELECT body_html FROM posts WHERE id = 'payload:1'").first<{ body_html: string }>();
        expect(row!.body_html).toMatch(/srcset="\/media\/[a-f0-9]{24}\.png\?w=480 480w, [^"]*\.png 2000w"/);
        expect(row!.body_html).toContain("sizes=");
    });
});

describe("the media route", () => {
    const bytes = sampleImage("jpeg");
    const ask = (path: string, accept?: string) => SELF.fetch(`https://daly.id.au${path}`, accept ? { headers: { Accept: accept } } : undefined);
    const known = (key: string, width: number) =>
        testEnv.DB.prepare(
            "INSERT INTO media (id, r2_key, content_type, width, height, bytes, created_at, checked_at) VALUES (?1, ?2, 'image/jpeg', ?3, 10, 1, ?4, ?4)",
        )
            .bind(`payload-media:${key}`, key, width, "2026-11-01T00:00:00.000Z")
            .run();

    it("serves the stored copy at an offered width, in the format the browser accepts", async () => {
        if (testEnv.IMAGE_TRANSFORMS !== "variants") throw new Error("these tests need IMAGE_TRANSFORMS=variants (wrangler.jsonc)");
        await testEnv.MEDIA.put(KEY, bytes, { httpMetadata: { contentType: "image/jpeg" } });
        await known(KEY, 2000);
        await testEnv.MEDIA.put(variantKey(KEY, 960, "webp"), "the webp copy");
        await testEnv.MEDIA.put(variantKey(KEY, 960, "avif"), "the avif copy");
        const webp = await ask(`/media/${KEY}?w=960&utm_source=x`, "image/webp,*/*");
        expect([webp.status, webp.headers.get("Content-Type"), webp.headers.get("Vary"), await webp.text()]).toEqual([
            200,
            "image/webp",
            "Accept",
            "the webp copy",
        ]);
        expect(webp.headers.get("Cache-Control")).toContain("immutable");
        const avif = await ask(`/media/${KEY}?w=960`, "image/avif,image/webp,*/*");
        expect([avif.headers.get("Content-Type"), await avif.text()]).toEqual(["image/avif", "the avif copy"]);
    });

    it("answers with the original, making nothing, for anything the site doesn't offer", async () => {
        // Its own image: the test above left copies of KEY in the edge cache, as a real visitor would.
        const OWN = "1111111111111111aaaaaaaa.jpg";
        await testEnv.MEDIA.put(OWN, bytes, { httpMetadata: { contentType: "image/jpeg" } });
        await known(OWN, 800);
        const before = await stored();
        for (const [query, accept] of [
            ["", "image/avif,image/webp"],
            ["?w=123", "image/avif"], // not a width the site makes
            ["?w=abc", "image/avif"],
            ["?w=99999", "image/avif"],
            ["?w=960", "image/avif"], // wider than this 800-pixel image
            ["?w=1600", "image/webp"],
            ["?w=480", "*/*"], // a browser that accepts neither modern format
            ["?w=480", undefined],
        ] as const) {
            const response = await ask(`/media/${OWN}${query}`, accept);
            expect([response.status, response.headers.get("Content-Type")], `${query} ${accept}`).toEqual([200, "image/jpeg"]);
            expect((await response.arrayBuffer()).byteLength, `${query} ${accept}`).toBe(bytes.byteLength);
        }
        expect(await stored()).toEqual(before);
        // An image the site has no record of, or that isn't there, makes nothing either.
        await testEnv.MEDIA.put("dddddddddddddddddddddddd.jpg", bytes, { httpMetadata: { contentType: "image/jpeg" } });
        expect((await ask("/media/dddddddddddddddddddddddd.jpg?w=480", "image/avif")).headers.get("Content-Type")).toBe("image/jpeg");
        expect((await ask("/media/ffffffffffffffffffffffff.jpg?w=960", "image/avif")).status).toBe(404);
        expect((await stored()).filter((k) => k.startsWith("variants/"))).toEqual([]);
        // The copies themselves, and a draft's private images, aren't addresses.
        expect((await ask("/media/variants/0123456789abcdef01234567-960.webp")).status).toBe(404);
    });

    it("a draft preview's image stays private, with or without a width", async () => {
        const secret = "eeeeeeeeeeeeeeeeeeeeeeee.jpg";
        await testEnv.MEDIA.put(`preview/${secret}`, bytes, { httpMetadata: { contentType: "image/jpeg" } });
        for (const query of ["", "?w=480", "?w=960"]) {
            const response = await ask(`/media/${secret}${query}`, "image/avif,image/webp");
            expect([response.status, response.headers.get("Cache-Control")], query).toEqual([404, "no-store"]);
        }
        expect((await stored()).filter((k) => k.startsWith("variants/"))).toEqual([]);
    });
});
