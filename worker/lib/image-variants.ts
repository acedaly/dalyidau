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
export type VariantFormat = (typeof VARIANT_FORMATS)[number];

const CONTENT_TYPE: Record<VariantFormat, string> = { avif: "image/avif", webp: "image/webp" };
/** Visually lossless for photographs and screenshots at these sizes, at a fraction of the bytes. */
const QUALITY: Record<VariantFormat, number> = { avif: 60, webp: 80 };

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

/**
 * The format to answer in, or null for "the original": only the two modern formats are ever made, and only
 * for a browser that says it accepts one. A browser that doesn't gets the image as it was published, so a
 * request can't be used to make copies the site never offers.
 */
export function variantFormat(key: string, accept: string | null): VariantFormat | null {
    if (!canResize(key)) return null;
    const accepted = (accept ?? "").toLowerCase();
    if (accepted.includes("image/avif")) return "avif";
    if (accepted.includes("image/webp")) return "webp";
    return null;
}

/**
 * The widths worth offering for an image this wide: only smaller ones (nothing is ever enlarged). Empty when
 * the width isn't known or the image can't be resized.
 */
export const variantWidths = (key: string, width: number | null | undefined): VariantWidth[] => (canResize(key) ? smallerWidths(width) : []);

/** One copy at a time per Worker instance: simultaneous requests for a copy that isn't made yet share the making. */
const making = new Map<string, Promise<{ body: ArrayBuffer; contentType: string } | null>>();

/**
 * The stored copy of `key` at `width` in `format`, made now if it isn't there yet. `source` is the original's
 * bytes when the caller already has them (publishing does). Null when it can't be made (no binding, the
 * original is missing, the service refused or answered in another format): the caller serves the original.
 */
export async function ensureVariant(
    env: VariantEnv,
    key: string,
    width: VariantWidth,
    format: VariantFormat,
    source?: Uint8Array,
): Promise<{ body: ReadableStream | ArrayBuffer; contentType: string; etag?: string } | null> {
    if (!canResize(key)) return null;
    const stored = variantKey(key, width, format);
    try {
        // Publishing only needs to know it's there; a request needs its bytes.
        if (source) {
            if (await env.MEDIA.head(stored)) return { body: new ArrayBuffer(0), contentType: CONTENT_TYPE[format] };
        } else {
            const existing = await env.MEDIA.get(stored);
            if (existing) return { body: existing.body as unknown as ReadableStream, contentType: CONTENT_TYPE[format], etag: existing.httpEtag };
        }
        if (!env.IMAGES) return null;
        const images = env.IMAGES;
        const pending =
            making.get(stored) ??
            (async () => {
                const input = source
                    ? (new Blob([source as unknown as BlobPart]).stream() as unknown as ReadableStream)
                    : ((await env.MEDIA.get(key))?.body as unknown as ReadableStream | undefined);
                if (!input) return null;
                const made = (
                    await images
                        .input(input)
                        // scale-down: never larger than the original, whatever was asked for.
                        .transform({ width, fit: "scale-down" })
                        .output({ format: CONTENT_TYPE[format], quality: QUALITY[format] })
                ).response();
                if (!made.ok) throw new Error(`Images answered ${made.status}`);
                // Stored under the format's name for good, so it must really be that format.
                const type = made.headers.get("Content-Type")?.split(";")[0].trim();
                if (type && type !== CONTENT_TYPE[format]) throw new Error(`Images answered ${type}, not ${CONTENT_TYPE[format]}`);
                const bytes = await made.arrayBuffer();
                if (!bytes.byteLength) throw new Error("Images returned nothing");
                await env.MEDIA.put(stored, bytes, {
                    httpMetadata: { contentType: CONTENT_TYPE[format], cacheControl: "public, max-age=31536000, immutable" },
                });
                return { body: bytes, contentType: CONTENT_TYPE[format] };
            })();
        making.set(stored, pending);
        try {
            return await pending;
        } finally {
            making.delete(stored);
        }
    } catch (error) {
        // Over the plan's allowance (error 9422), a file the service can't read, a bad moment: the original is served.
        console.warn(JSON.stringify({ event: "image_variant_failed", key, width, format, message: (error as Error).message?.slice(0, 200) }));
        return null;
    }
}

/** How many copies one publish may make ahead of time; the rest are made by the media route when first asked for. */
export const PUBLISH_VARIANT_BUDGET = 24;

/**
 * Makes the smaller copies of a newly published image ahead of time, in both modern formats, from the bytes
 * the publisher already holds. Best effort and bounded: `budget` is shared by every image in one publish, so
 * a project with two dozen screenshots doesn't spend the request making 150 copies. Whatever isn't made here
 * is made by the media route the first time it's asked for.
 */
export async function prepareVariants(
    env: VariantEnv,
    key: string,
    width: number | null | undefined,
    source?: Uint8Array,
    budget: { left: number } = { left: PUBLISH_VARIANT_BUDGET },
): Promise<number> {
    if (!env.IMAGES) return 0;
    const wanted = variantWidths(key, width).flatMap((w) => VARIANT_FORMATS.map((format) => [w, format] as const));
    const now = wanted.slice(0, Math.max(0, budget.left));
    budget.left -= now.length;
    return (await Promise.all(now.map(([w, format]) => ensureVariant(env, key, w, format, source)))).filter(Boolean).length;
}
