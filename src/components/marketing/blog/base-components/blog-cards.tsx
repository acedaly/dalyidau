import { ArrowUpRight } from "@untitledui/icons";
import { PostImage } from "@/components/site/post-image";
import { PostMeta } from "@/components/site/post-meta";
import type { PostSummary } from "@/shared/types";
import { cx } from "@/utils/cx";
import { blogHref } from "@/utils/format";

// Untitled UI PRO blog card ("Simple01Vertical"), adapted to the site's PostSummary. There is one
// author, so the avatar row becomes the date and reading time. The whole card is one link target;
// the category stays separately clickable.

const imageFrame =
    "relative overflow-hidden rounded-2xl bg-secondary before:pointer-events-none before:absolute before:inset-0 before:z-10 before:rounded-[inherit] before:ring-1 before:ring-black/5 before:ring-inset dark:before:ring-white/10";

export const Simple01Vertical = ({
    post,
    headingLevel = "h3",
    imageClassName,
    priority,
}: {
    post: PostSummary;
    headingLevel?: "h2" | "h3";
    imageClassName?: string;
    priority?: boolean;
}) => {
    const Heading = headingLevel;
    return (
        <article className="group relative flex flex-col gap-4 md:gap-5">
            <div className={imageFrame}>
                <PostImage
                    image={post.image}
                    title={post.title}
                    priority={priority}
                    className={cx(
                        "aspect-[1.5] w-full transition duration-300 ease-out group-hover:scale-[1.03] motion-reduce:transition-none",
                        imageClassName,
                    )}
                />
            </div>

            <div className="flex flex-1 flex-col gap-2">
                {post.category && (
                    <a
                        href={blogHref({ category: post.category })}
                        className="relative z-20 w-max rounded-xs text-sm font-semibold text-brand-secondary outline-focus-ring hover:text-brand-secondary_hover focus-visible:outline-2 focus-visible:outline-offset-2"
                    >
                        {post.category}
                    </a>
                )}
                <div className="flex flex-col gap-1">
                    <Heading className="flex justify-between gap-x-4 text-lg font-semibold text-primary">
                        <a
                            href={`/blog/${post.slug}`}
                            className="rounded-md outline-focus-ring after:absolute after:inset-0 after:z-10 after:rounded-2xl focus-visible:outline-2 focus-visible:outline-offset-2"
                        >
                            {post.title}
                        </a>
                        <ArrowUpRight
                            aria-hidden="true"
                            className="mt-0.5 size-6 shrink-0 text-fg-quaternary transition duration-150 ease-out group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-fg-brand-secondary motion-reduce:transition-none"
                        />
                    </Heading>
                    {(post.summary || post.subtitle) && <p className="line-clamp-2 text-md text-tertiary">{post.summary ?? post.subtitle}</p>}
                </div>
            </div>

            <PostMeta post={post} />
        </article>
    );
};
