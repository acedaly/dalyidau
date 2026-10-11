import { ArrowRight } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { Simple01Vertical } from "@/components/marketing/blog/base-components/blog-cards";
import { EmptyPosts } from "@/components/site/empty-posts";
import { FeaturedPostCard } from "@/components/site/post-card";
import type { PostSummary } from "@/shared/types";
import { cx } from "@/utils/cx";

// Untitled UI PRO "blog-section-simple-left-aligned-01", fed with the latest published posts.
// A lone post gets the wide featured layout so the section never looks half-empty.
export const BlogSectionSimpleLeftAligned01 = ({ posts }: { posts: PostSummary[] }) => {
    return (
        <section aria-labelledby="latest-heading" className="bg-primary py-16 md:py-24">
            <div className="mx-auto max-w-container px-4 md:px-8">
                <div className="flex flex-col items-start justify-between gap-6 lg:flex-row lg:items-end">
                    <div className="max-w-3xl">
                        <p className="text-sm font-semibold text-brand-secondary md:text-md">From the blog</p>
                        <h2 id="latest-heading" className="mt-3 text-display-sm font-semibold text-primary md:text-display-md">
                            Latest writing
                        </h2>
                    </div>

                    {posts.length > 0 && (
                        <div className="hidden gap-3 lg:flex">
                            <Button href="/blog" color="secondary" size="lg" iconTrailing={ArrowRight}>
                                All posts
                            </Button>
                        </div>
                    )}
                </div>

                <div className="mt-10 md:mt-16">
                    {posts.length === 0 ? (
                        <EmptyPosts
                            title="Nothing here yet"
                            description="The first posts are on their way. Subscribe to the RSS feed and you'll see them as soon as they're up."
                            action={
                                <Button href="/feed.xml" color="secondary" size="md">
                                    Subscribe via RSS
                                </Button>
                            }
                        />
                    ) : posts.length === 1 ? (
                        <FeaturedPostCard post={posts[0]} headingLevel="h3" />
                    ) : (
                        <ul className={cx("grid grid-cols-1 gap-x-8 gap-y-12 md:grid-cols-2 md:gap-y-16", posts.length > 2 && "lg:grid-cols-3")}>
                            {posts.map((post) => (
                                <li key={post.slug}>
                                    <Simple01Vertical post={post} />
                                </li>
                            ))}
                        </ul>
                    )}
                </div>

                {posts.length > 0 && (
                    <div className="mt-12 flex flex-col gap-3 lg:hidden">
                        <Button href="/blog" color="secondary" size="lg" iconTrailing={ArrowRight}>
                            All posts
                        </Button>
                    </div>
                )}
            </div>
        </section>
    );
};
