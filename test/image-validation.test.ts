// What may be copied to the public bucket as an image (worker/lib/image.ts imageProblem): a whole,
// well-formed file of one of the five types and a sane size. A file that only starts like an image, is cut
// short, has no picture or claims an absurd size is refused, and a publish that needs it writes nothing.
import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { publishPayloadPost } from "../worker/blog/payload-publisher";
import { MAX_IMAGE_PIXELS, imageDimensions, imageProblem } from "../worker/lib/image";
import { PublishError, publishProject } from "../worker/site/publisher";
import { publishedSlugs, resetDb, testEnv } from "./helpers";
import { sampleImage } from "./image-samples";

const TYPES = [
    ["png", "image/png"],
    ["jpeg", "image/jpeg"],
    ["gif", "image/gif"],
    ["webp", "image/webp"],
    ["webpLossless", "image/webp"],
    ["avif", "image/avif"],
] as const;
const text = (value: string) => new TextEncoder().encode(value);
const join = (...parts: Uint8Array[]) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) (out.set(p, at), (at += p.length));
    return out;
};

beforeEach(async () => {
    await resetDb();
    await testEnv.DB.prepare("DELETE FROM meta WHERE key != 'content_version'").run();
});

describe("imageProblem", () => {
    it("accepts a real image of each type, and reads its size", () => {
        for (const [name, type] of TYPES) {
            expect(imageProblem(sampleImage(name), type), name).toBeNull();
            if (type !== "image/avif") expect(imageDimensions(sampleImage(name), type), name).toEqual({ width: 4, height: 3 });
        }
    });

    it("accepts a real image with harmless bytes after its end (some cameras and editors add them)", () => {
        for (const name of ["png", "jpeg"] as const) expect(imageProblem(join(sampleImage(name), text("trailing notes")), `image/${name}`), name).toBeNull();
        expect(imageProblem(join(sampleImage("gif"), new Uint8Array(4)), "image/gif")).toBeNull();
    });

    it("refuses a file that's cut short, at any point", () => {
        for (const [name, type] of TYPES) {
            const whole = sampleImage(name);
            for (const keep of [0.25, 0.5, 0.75, 0.95]) {
                const cut = whole.subarray(0, Math.floor(whole.length * keep));
                expect(imageProblem(cut, type), `${name} cut to ${keep}`).not.toBeNull();
            }
            expect(imageProblem(whole.subarray(0, whole.length - 1), type), `${name} missing its last byte`).not.toBeNull();
        }
    });

    it("refuses a file that only starts like an image", () => {
        for (const [name, type] of TYPES) {
            const start = sampleImage(name).subarray(0, 16);
            const html = join(start, text("<!doctype html><script>alert(1)</script>"));
            expect(imageProblem(html, type), `${name} header + HTML`).not.toBeNull();
            expect(imageProblem(join(start, new Uint8Array(4096)), type), `${name} header + zeros`).not.toBeNull();
        }
        expect(imageProblem(text("<svg xmlns='http://www.w3.org/2000/svg'/>"), "image/png")).not.toBeNull();
        expect(imageProblem(new Uint8Array(0), "image/jpeg")).not.toBeNull();
    });

    it("refuses one type's file under another type's label", () => {
        for (const [name, type] of TYPES)
            for (const [, other] of TYPES) if (other !== type) expect(imageProblem(sampleImage(name), other), `${name} as ${other}`).not.toBeNull();
    });

    it("refuses types the site doesn't publish, and an image claiming an absurd size", () => {
        expect(imageProblem(sampleImage("png"), "image/svg+xml")).not.toBeNull();
        expect(imageProblem(sampleImage("png"), "text/html")).not.toBeNull();
        // A PNG whose header says 60,000 × 60,000: a few hundred bytes that would cost a browser gigabytes to decode.
        const bomb = sampleImage("png").slice();
        const view = new DataView(bomb.buffer);
        view.setUint32(16, 60000);
        view.setUint32(20, 60000);
        expect(imageProblem(bomb, "image/png")).toMatch(/too large/);
        const wide = sampleImage("png").slice();
        new DataView(wide.buffer).setUint32(16, 10001);
        new DataView(wide.buffer).setUint32(20, 10000);
        expect(10001 * 10000).toBeGreaterThan(MAX_IMAGE_PIXELS);
        expect(imageProblem(wide, "image/png")).toMatch(/too large/);
        const none = sampleImage("png").slice();
        new DataView(none.buffer).setUint32(16, 0);
        expect(imageProblem(none, "image/png")).not.toBeNull();
    });
});

describe("publishing with a damaged image", () => {
    const damaged = sampleImage("png").subarray(0, 100);
    const media = {
        loadMedia: async (id: string | number) =>
            String(id) === "7"
                ? { bytes: sampleImage("jpeg"), contentType: "image/jpeg", alt: "Fine" }
                : String(id) === "8"
                  ? { bytes: damaged, contentType: "image/png", alt: "Damaged" }
                  : null,
    };
    const bucketKeys = async () => (await testEnv.MEDIA.list()).objects.map((o) => o.key);

    it("refuses a post or project whose featured image is damaged, writing nothing", async () => {
        const before = await bucketKeys();
        await expect(
            publishPayloadPost(
                testEnv,
                {
                    postId: "payload:img",
                    slug: "with-image",
                    title: "With image",
                    content: { root: { type: "root", children: [{ type: "paragraph", children: [{ type: "text", text: "Words." }] }] } },
                    heroMediaId: 8,
                },
                media,
            ),
        ).rejects.toThrow(PublishError);
        await expect(publishProject(testEnv, { id: 1, slug: "lamp", title: "Lamp", heroMediaId: 8 }, media)).rejects.toThrow(PublishError);
        await expect(publishProject(testEnv, { id: 1, slug: "lamp", title: "Lamp", heroMediaId: 7, gallery: [{ mediaId: 8 }] }, media)).rejects.toThrow(
            /Screenshot 1/,
        );
        expect(await publishedSlugs()).toEqual([]);
        expect((await testEnv.DB.prepare("SELECT key FROM meta WHERE key LIKE 'project%'").all()).results).toEqual([]);
        // The damaged file never reached the public bucket (the good cover of the refused project may have).
        const added = (await bucketKeys()).filter((k) => !before.includes(k));
        expect(added.every((k) => k.endsWith(".jpg"))).toBe(true);
    });

    it("publishes with a sound image, served as that image", async () => {
        await testEnv.DB.prepare(
            "INSERT INTO feature_flags (key, enabled, updated_at, updated_by) VALUES ('website.projects_home', 1, '2026-01-01T00:00:00.000Z', 'test') ON CONFLICT(key) DO UPDATE SET enabled = 1",
        ).run();
        const project = await publishProject(testEnv, { id: 1, slug: "lamp", title: "Lamp", heroMediaId: 7 }, media);
        expect(project.image).toMatchObject({ width: 4, height: 3 });
        const file = await SELF.fetch(`https://daly.id.au${project.image!.src}`);
        expect(file.status).toBe(200);
        expect(file.headers.get("Content-Type")).toBe("image/jpeg");
        expect(file.headers.get("X-Content-Type-Options")).toBe("nosniff");
    });
});
