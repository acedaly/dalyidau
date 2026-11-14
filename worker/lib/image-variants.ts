// Smaller copies of a published image (docs/AUDIT-2026-11.md, H6).
//
// An image is published once, at full size, under its content hash (`<hash>.<ext>` in the public bucket).
// Pages then ask for it at the width they need: `/media/<hash>.jpg?w=960`. The copy at that width, in the
// best format the browser accepts (AVIF, then WebP, then the original's own), is made by Cloudflare's Images
// binding and kept in the bucket under `variants/`, so each one is made once, ever.
//
// They are made when the image is published (so the first visitor doesn't wait), and by the media route for
// anything that isn't there yet: images published before this existed need no republishing.
//
// Nothing here can fail a publish or break a page. Without the binding, over the plan's allowance, or on any
// error, the answer is the original image.
import type { R2Bucket } from "@cloudflare/workers-types";
import { VARIANT_WIDTHS, type VariantWidth, smallerWidths } from "../../src/shared/image-variants";

// The widths ever made (a request for any other is answered with the original) are shared with the pages.
export { VARIANT_WIDTHS, type VariantWidth };
export const VARIANT_FORMATS = ["avif", "webp"] as const;
export type VariantFormat = (typeof VARIANT_FORMATS)[number] | "jpg" | "png";

const CONTENT_TYPE: Record<VariantFormat, string> = { avif: "image/avif", webp: "image/webp", jpg: "image/jpeg", png: "image/png" };
/** Visually lossless for photographs and screenshots at these sizes, at a fraction of the bytes. */
const QUALITY: Record<VariantFormat, number> = { avif: 60, webp: 80, jpg: 82, png: 90 };

/** The slice of Cloudflare's Images binding this uses (https://developers.cloudflare.com/images/optimization/binding/). */
export interface ImagesBinding {
    input(stream: ReadableStream): {
        transform(options: { width?: number; fit?: string }): {
            output(options: { format: string; quality?: number }): Promise<{ response(): Response }>;
        };
    };
}

export interface VariantEnv {
    MEDIA: R2Bucket;
    IMAGES?: ImagesBinding;
}

const KEY = /^([a-f0-9]{24})\.(jpg|png|webp|avif|gif)$/;

/** Animated images are left as they are: a resized still of a GIF isn't the same picture. */
export const canResize = (key: string) => KEY.test(key) && !key.endsWith(".gif");

export const variantKey = (key: string, width: VariantWidth, format: VariantFormat) => `variants/${KEY.exec(key)![1]}-${width}.${format}`;

export const isVariantWidth = (value: number): value is VariantWidth => (VARIANT_WIDTHS as readonly number[]).includes(value);

/** The format to answer in: the best the browser says it accepts, otherwise the original's own (resized). */
export function variantFormat(key: string, accept: string | null): VariantFormat {
    const accepted = (accept ?? "").toLowerCase();
    if (accepted.includes("image/avif")) return "avif";
    if (accepted.includes("image/webp")) return "webp";
    const ext = KEY.exec(key)?.[2];
    // A WebP or AVIF original asked for by a browser that didn't say it accepts it: JPEG is the safe answer.
    return ext === "png" ? "png" : "jpg";
}

/**
 * The widths worth offering for an image this wide: only smaller ones (nothing is ever enlarged). Empty when
 * the width isn't known or the image can't be resized.
 */
export const variantWidths = (key: string, width: number | null | undefined): VariantWidth[] => (canResize(key) ? smallerWidths(width) : []);

/**
 * The stored copy of `key` at `width` in `format`, made now if it isn't there yet. Null when it can't be
 * made (no binding, the original is missing, the service refused): the caller serves the original.
 */
export async function ensureVariant(
    env: VariantEnv,
    key: string,
    width: VariantWidth,
    format: VariantFormat,
): Promise<{ body: ReadableStream | ArrayBuffer; contentType: string; etag?: string } | null> {
    if (!canResize(key)) return null;
    const stored = variantKey(key, width, format);
    try {
        const existing = await env.MEDIA.get(stored);
        if (existing) return { body: existing.body as unknown as ReadableStream, contentType: CONTENT_TYPE[format], etag: existing.httpEtag };
        if (!env.IMAGES) return null;
        const original = await env.MEDIA.get(key);
        if (!original) return null;
        const made = (
            await env.IMAGES.input(original.body as unknown as ReadableStream)
                // scale-down: never larger than the original, whatever was asked for.
                .transform({ width, fit: "scale-down" })
                .output({ format: CONTENT_TYPE[format], quality: QUALITY[format] })
        ).response();
        if (!made.ok) throw new Error(`Images answered ${made.status}`);
        const bytes = await made.arrayBuffer();
        if (!bytes.byteLength) throw new Error("Images returned nothing");
        await env.MEDIA.put(stored, bytes, { httpMetadata: { contentType: CONTENT_TYPE[format], cacheControl: "public, max-age=31536000, immutable" } });
        return { body: bytes, contentType: CONTENT_TYPE[format] };
    } catch (error) {
        // Over the plan's allowance (error 9422), a file the service can't read, a bad moment: the original is served.
        console.warn(JSON.stringify({ event: "image_variant_failed", key, width, format, message: (error as Error).message?.slice(0, 200) }));
        return null;
    }
}

/**
 * Makes every smaller copy of a newly published image ahead of time, in both modern formats. Best effort:
 * whatever isn't made here is made by the media route the first time it's asked for.
 */
export async function prepareVariants(env: VariantEnv, key: string, width: number | null | undefined): Promise<number> {
    if (!env.IMAGES) return 0;
    const jobs = variantWidths(key, width).flatMap((w) => VARIANT_FORMATS.map((format) => ensureVariant(env, key, w, format)));
    return (await Promise.all(jobs)).filter(Boolean).length;
}
