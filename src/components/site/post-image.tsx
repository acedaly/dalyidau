import type { PostImage as PostImageData } from "@/shared/types";
import { cx } from "@/utils/cx";

interface PostImageProps {
    image: PostImageData | null;
    title: string;
    className?: string;
    sizes?: string;
    priority?: boolean;
}

/** Featured image, or a quiet patterned placeholder when an article has none. */
export const PostImage = ({ image, title, className, sizes = "(min-width: 1024px) 400px, (min-width: 768px) 50vw, 100vw", priority }: PostImageProps) => {
    if (!image) {
        return (
            <div
                aria-hidden="true"
                className={cx(
                    "relative flex items-end overflow-hidden bg-secondary bg-[radial-gradient(var(--color-border-secondary)_1px,transparent_1px)] bg-size-[16px_16px] p-5",
                    className,
                )}
            >
                <span className="line-clamp-2 max-w-[80%] text-display-xs font-semibold tracking-tight text-quaternary/60">{title}</span>
            </div>
        );
    }
    return (
        <img
            src={image.src}
            srcSet={image.srcSet}
            sizes={image.srcSet ? sizes : undefined}
            alt={image.alt}
            width={image.width}
            height={image.height}
            loading={priority ? "eager" : "lazy"}
            decoding="async"
            fetchPriority={priority ? "high" : undefined}
            className={cx("bg-secondary object-cover", className)}
        />
    );
};
