import { SearchLg, XClose } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { EmptyPosts } from "@/components/site/empty-posts";
import { LinkPagination } from "@/components/site/link-pagination";
import { FeaturedPostCard, PostCard } from "@/components/site/post-card";
import { site } from "@/content/site";
import type { PageData } from "@/shared/types";
import { cx } from "@/utils/cx";
import { blogHref } from "@/utils/format";

type BlogData = Extract<PageData, { route: "blog" }>;

const FilterLink = ({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) => (
    <a
        href={href}
        aria-current={active ? "page" : undefined}
        className={cx(
            "flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold whitespace-nowrap outline-focus-ring transition duration-100 ease-linear focus-visible:outline-2 focus-visible:outline-offset-2",
            active ? "bg-primary_hover text-secondary ring-1 ring-primary ring-inset" : "text-quaternary hover:bg-primary_hover hover:text-secondary",
        )}
    >
        {children}
    </a>
);

export const BlogIndexPage = ({ data }: { data: BlogData }) => {
    const { filters, posts, featured, categories } = data;
    const filtered = !!(filters.q || filters.category || filters.tag);

    return (
        <div className="mx-auto max-w-container px-4 pt-12 pb-16 md:px-8 md:pt-20 md:pb-24">
            <header className="flex flex-col gap-8 md:flex-row md:items-end md:justify-between">
                <div className="flex max-w-3xl flex-col gap-3 md:gap-4">
                    <p className="text-sm font-semibold text-brand-secondary md:text-md">Writing</p>
                    <h1 className="text-display-md font-semibold text-primary md:text-display-lg">{site.blogTitle}</h1>
                    <p className="text-lg text-tertiary md:text-xl">{site.blogDescription}</p>
                </div>
                <form method="get" action="/blog" role="search" className="w-full md:max-w-80">
                    {filters.category && <input type="hidden" name="category" value={filters.category} />}
                    {filters.tag && <input type="hidden" name="tag" value={filters.tag} />}
                    <Input
                        name="q"
                        type="search"
                        size="md"
                        icon={SearchLg}
                        placeholder="Search articles"
                        aria-label="Search articles"
                        defaultValue={filters.q}
                    />
                </form>
            </header>

            {categories.length > 0 && (
                <nav aria-label="Categories" className="-mx-4 mt-10 overflow-x-auto px-4 pb-1 md:mx-0 md:mt-12 md:px-0">
                    <ul className="flex gap-1">
                        <li>
                            <FilterLink href={blogHref({ q: filters.q })} active={!filters.category}>
                                All posts
                            </FilterLink>
                        </li>
                        {categories.map((category) => (
                            <li key={category.name}>
                                <FilterLink href={blogHref({ q: filters.q, category: category.name })} active={filters.category === category.name}>
                                    {category.name}
                                    <span className="text-xs font-medium text-quaternary">{category.count}</span>
                                </FilterLink>
                            </li>
                        ))}
                    </ul>
                </nav>
            )}

            {filtered && (
                <div className="mt-8 flex flex-wrap items-center gap-3" aria-live="polite">
                    <p className="text-md text-tertiary">
                        {data.totalPosts === 1 ? "1 article" : `${data.totalPosts} articles`}
                        {filters.q && (
                            <>
                                {" "}
                                matching <span className="font-semibold text-secondary">“{filters.q}”</span>
                            </>
                        )}
                        {filters.tag && (
                            <>
                                {" "}
                                tagged <span className="font-semibold text-secondary">{filters.tag}</span>
                            </>
                        )}
                        {filters.category && (
                            <>
                                {" "}
                                in <span className="font-semibold text-secondary">{filters.category}</span>
                            </>
                        )}
                    </p>
                    <Button href="/blog" color="link-gray" size="sm" iconLeading={XClose}>
                        Clear filters
                    </Button>
                </div>
            )}

            {featured && (
                <section aria-label="Featured article" className="mt-10 md:mt-12">
                    <FeaturedPostCard post={featured} />
                </section>
            )}

            <section aria-label="Articles" className={cx(featured ? "mt-16 border-t border-secondary pt-12 md:mt-20 md:pt-16" : "mt-10 md:mt-12")}>
                {posts.length > 0 ? (
                    <div className="grid grid-cols-1 gap-12 md:grid-cols-2 md:gap-x-8 md:gap-y-12 lg:grid-cols-3">
                        {posts.map((post) => (
                            <PostCard key={post.slug} post={post} headingLevel="h2" />
                        ))}
                    </div>
                ) : featured ? null : filtered ? (
                    <EmptyPosts
                        title="No articles found"
                        description="Nothing matches that. Try a different search, or have a look through everything."
                        action={
                            <Button href="/blog" color="secondary" size="md">
                                Show all articles
                            </Button>
                        }
                    />
                ) : (
                    <EmptyPosts
                        title="Nothing here yet"
                        description="The first posts are on their way. Subscribe to the RSS feed and you'll see them as soon as they're up."
                    />
                )}
            </section>

            {data.totalPages > 1 && (
                <div className="mt-12 md:mt-16">
                    <LinkPagination page={filters.page} total={data.totalPages} href={(page) => blogHref({ ...filters, page })} />
                </div>
            )}
        </div>
    );
};
