import { ArrowUpRight } from "@untitledui/icons";
import { Badge } from "@/components/base/badges/badges";
import { PostImage } from "@/components/site/post-image";
import { PostMeta } from "@/components/site/post-meta";
import type { PostSummary } from "@/shared/types";
import { blogHref } from "@/utils/format";

export const PostCard = ({ post, headingLevel = "h3" }: { post: PostSummary; headingLevel?: "h2" | "h3" }) => {
    const Heading = headingLevel;
    return (
        <article className="group relative flex flex-col gap-5">
            <div className="overflow-hidden rounded-2xl ring-1 ring-secondary ring-inset">
                <PostImage image={post.image} title={post.title} className="aspect-[16/10] w-full transition duration-300 ease-out group-hover:scale-[1.02]" />
            </div>
            <div className="flex flex-1 flex-col gap-2">
                {post.category && (
                    <a
                        href={blogHref({ category: post.category })}
                        className="relative z-10 w-max text-sm font-semibold text-brand-secondary hover:text-brand-secondary_hover"
                    >
                        {post.category}
                    </a>
                )}
                <div className="flex items-start justify-between gap-4">
                    <Heading className="text-lg font-semibold text-primary md:text-xl">
                        <a
                            href={`/blog/${post.slug}`}
                            className="outline-focus-ring after:absolute after:inset-0 after:rounded-2xl focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:after:outline-2 focus-visible:after:outline-offset-4 focus-visible:after:outline-focus-ring"
                        >
                            {post.title}
                        </a>
                    </Heading>
                    <ArrowUpRight
                        aria-hidden="true"
                        className="mt-1 size-5 shrink-0 text-fg-quaternary transition duration-150 ease-out group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-fg-brand-secondary"
                    />
                </div>
                {post.summary && <p className="line-clamp-3 text-md text-tertiary">{post.summary}</p>}
            </div>
            <div className="flex flex-col gap-3">
                <PostMeta post={post} />
                {post.tags.length > 0 && (
                    <ul aria-label="Tags" className="relative z-10 flex flex-wrap gap-2">
                        {post.tags.slice(0, 3).map((tag) => (
                            <li key={tag}>
                                <a href={blogHref({ tag })} className="rounded-full outline-focus-ring focus-visible:outline-2 focus-visible:outline-offset-2">
                                    <Badge size="sm" color="gray">
                                        {tag}
                                    </Badge>
                                </a>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </article>
    );
};

export const FeaturedPostCard = ({ post }: { post: PostSummary }) => (
    <article className="group relative grid grid-cols-1 gap-6 md:gap-8 lg:grid-cols-2 lg:items-center lg:gap-12">
        <div className="overflow-hidden rounded-2xl ring-1 ring-secondary ring-inset">
            <PostImage
                image={post.image}
                title={post.title}
                priority
                sizes="(min-width: 1024px) 600px, 100vw"
                className="aspect-[16/10] w-full transition duration-300 ease-out group-hover:scale-[1.02]"
            />
        </div>
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
                <Badge size="md" color="brand">
                    {post.featured ? "Featured" : "Latest"}
                </Badge>
                {post.category && (
                    <a
                        href={blogHref({ category: post.category })}
                        className="relative z-10 text-sm font-semibold text-brand-secondary hover:text-brand-secondary_hover"
                    >
                        {post.category}
                    </a>
                )}
            </div>
            <h2 className="text-display-xs font-semibold text-primary md:text-display-sm">
                <a
                    href={`/blog/${post.slug}`}
                    className="outline-focus-ring after:absolute after:inset-0 after:rounded-2xl focus-visible:outline-2 focus-visible:outline-offset-4"
                >
                    {post.title}
                </a>
            </h2>
            {(post.subtitle || post.summary) && <p className="text-lg text-tertiary">{post.summary ?? post.subtitle}</p>}
            <PostMeta post={post} className="text-md text-tertiary" />
        </div>
    </article>
);
