// Which smaller copies of a published image exist, and how a page asks for them. Shared by the Worker (which
// makes and serves them: worker/lib/image-variants.ts) and the page components (which list them in `srcset`).

/** The only widths ever made. */
export const VARIANT_WIDTHS = [480, 960, 1600] as const;
export type VariantWidth = (typeof VARIANT_WIDTHS)[number];

const MEDIA = /^\/media\/[a-f0-9]{24}\.(jpg|png|webp|avif)$/;

/** The widths worth offering for an image this wide: only smaller ones (nothing is ever enlarged). */
export const smallerWidths = (width: number | null | undefined): VariantWidth[] => (width ? VARIANT_WIDTHS.filter((w) => w < width) : []);

/**
 * A `srcset` for a published image: its smaller copies, then the original at its own width. Undefined when
 * there is nothing smaller to offer, its width isn't known, or it isn't one of the site's own resizable
 * images (an animated GIF is served as it is).
 */
export function variantSrcSet(src: string, width: number | null | undefined): string | undefined {
    if (!MEDIA.test(src)) return undefined;
    const smaller = smallerWidths(width);
    return smaller.length ? [...smaller.map((w) => `${src}?w=${w} ${w}w`), `${src} ${width}w`].join(", ") : undefined;
}
