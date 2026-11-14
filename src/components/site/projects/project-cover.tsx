import { useImageSrcSet } from "@/providers/site-frame";
import type { SiteImage } from "@/shared/site-content";
import { cx } from "@/utils/cx";

const initials = (title: string) =>
    title
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((w) => w[0]!.toUpperCase())
        .join("");

/**
 * A project's cover: its screenshot, or (when it has none) a quiet textured panel with its initials.
 * The box keeps its proportions either way, so cards line up and nothing shifts while images load.
 */
export const ProjectCover = ({
    image,
    title,
    ratio = "aspect-[16/10]",
    priority = false,
    sizes,
    className,
}: {
    image: SiteImage | null;
    title: string;
    ratio?: string;
    priority?: boolean;
    sizes?: string;
    className?: string;
}) => {
    const srcSet = useImageSrcSet()(image);
    return (
        <div className={cx("relative overflow-hidden rounded-xl border border-secondary bg-secondary", ratio, className)}>
            {image ? (
                <img
                    src={image.src}
                    alt={image.alt}
                    srcSet={srcSet}
                    width={image.width}
                    height={image.height}
                    // Without `sizes` a browser assumes the image fills the window and picks the largest copy.
                    sizes={srcSet ? (sizes ?? "(min-width: 1024px) 400px, (min-width: 768px) 50vw, 100vw") : sizes}
                    loading={priority ? "eager" : "lazy"}
                    decoding="async"
                    fetchPriority={priority ? "high" : undefined}
                    className="v2-card-image absolute inset-0 size-full object-cover object-top"
                />
            ) : (
                <div aria-hidden="true" className="v2-cover-fallback v2-card-image absolute inset-0 flex items-center justify-center">
                    <span className="v2-display text-display-lg text-brand-secondary/70 md:text-display-xl">{initials(title)}</span>
                </div>
            )}
        </div>
    );
};
