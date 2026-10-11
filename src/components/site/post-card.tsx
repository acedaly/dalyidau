import { ArrowUpRight } from "@untitledui/icons";
import { Badge } from "@/components/base/badges/badges";
import { Simple01Vertical } from "@/components/marketing/blog/base-components/blog-cards";
import { PostImage } from "@/components/site/post-image";
import { PostMeta } from "@/components/site/post-meta";
import type { PostSummary } from "@/shared/types";
import { blogHref } from "@/utils/format";

export const PostCard = ({ post, headingLevel = "h3" }: { post: PostSummary; headingLevel?: "h2" | "h3" }) => (
    <Simple01Vertical post={post} headingLevel={headingLevel} />
);

/** Wide card for the newest or featured post, matching the Untitled UI blog card styling. */
export const FeaturedPostCard = ({ post, headingLevel = "h2" }: { post: PostSummary; headingLevel?: "h2" | "h3" }) => {
    const Heading = headingLevel;
    return (
        <article className="group relative grid grid-cols-1 gap-6 md:gap-8 lg:grid-cols-[1.15fr_1fr] lg:items-center lg:gap-16">
            <div className="relative overflow-hidden rounded-2xl bg-secondary before:pointer-events-none before:absolute before:inset-0 before:z-10 before:rounded-[inherit] before:ring-1 before:ring-black/5 before:ring-inset dark:before:ring-white/10">
                <PostImage
                    image={post.image}
                    title={post.title}
                    priority
                    sizes="(min-width: 1024px) 640px, 100vw"
                    className="aspect-[1.5] w-full transition duration-300 ease-out group-hover:scale-[1.03] motion-reduce:transition-none"
                />
            </div>
            <div className="flex flex-col gap-4">
                <div className="flex flex-wrap items-center gap-3">
                    {post.featured && (
                        <Badge size="md" color="brand" type="pill-color">
                            Featured
                        </Badge>
                    )}
                    {post.category && (
                        <a
                            href={blogHref({ category: post.category })}
                            className="relative z-20 rounded-xs text-sm font-semibold text-brand-secondary outline-focus-ring hover:text-brand-secondary_hover focus-visible:outline-2 focus-visible:outline-offset-2"
                        >
                            {post.category}
                        </a>
                    )}
                </div>
                <Heading className="flex justify-between gap-x-4 text-display-xs font-semibold text-primary md:text-display-sm">
                    <a
                        href={`/blog/${post.slug}`}
                        className="rounded-md outline-focus-ring after:absolute after:inset-0 after:z-10 after:rounded-2xl focus-visible:outline-2 focus-visible:outline-offset-4"
                    >
                        {post.title}
                    </a>
                    <ArrowUpRight
                        aria-hidden="true"
                        className="mt-1 size-6 shrink-0 text-fg-quaternary transition duration-150 ease-out group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-fg-brand-secondary motion-reduce:transition-none"
                    />
                </Heading>
                {(post.summary || post.subtitle) && <p className="text-lg text-tertiary">{post.summary ?? post.subtitle}</p>}
                <PostMeta post={post} className="text-md text-tertiary" />
            </div>
        </article>
    );
};
