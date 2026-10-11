import { ArrowLeft, ArrowRight, ChevronDown } from "@untitledui/icons";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { PostCard } from "@/components/site/post-card";
import { PostImage } from "@/components/site/post-image";
import { ShareLinks } from "@/components/site/share-links";
import { TableOfContents } from "@/components/site/table-of-contents";
import { site } from "@/content/site";
import type { PageData } from "@/shared/types";
import { blogHref, formatDate, sameDay } from "@/utils/format";

type PostData = Extract<PageData, { route: "post" }>;

export const BlogPostPage = ({ data }: { data: PostData }) => {
    const { post, related } = data;
    const showToc = post.toc.length >= 3;
    const shareUrl = `${site.url}${data.url}`;
    const showUpdated = post.updatedAt && !sameDay(post.updatedAt, post.publishedAt);

    return (
        <>
            <article className="pt-8 pb-16 md:pt-12 md:pb-24">
                <header className="mx-auto max-w-container px-4 md:px-8">
                    <Button href="/blog" color="link-gray" size="md" iconLeading={ArrowLeft}>
                        All posts
                    </Button>
                    <div className="mx-auto mt-8 flex max-w-3xl flex-col items-center text-center md:mt-12">
                        {post.category && (
                            <a
                                href={blogHref({ category: post.category })}
                                className="text-sm font-semibold text-brand-secondary hover:text-brand-secondary_hover md:text-md"
                            >
                                {post.category}
                            </a>
                        )}
                        <h1 className="mt-3 text-display-sm font-semibold text-balance text-primary md:mt-4 md:text-display-lg">{post.title}</h1>
                        {post.subtitle && <p className="mt-4 text-lg text-balance text-tertiary md:mt-6 md:text-xl">{post.subtitle}</p>}
                        <dl className="mt-6 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-sm text-tertiary md:mt-8 md:text-md">
                            <div className="flex gap-1">
                                <dt className="sr-only">Published</dt>
                                <dd>
                                    <time dateTime={post.publishedAt}>{formatDate(post.publishedAt)}</time>
                                </dd>
                            </div>
                            {showUpdated && (
                                <div className="flex gap-1">
                                    <dt>Updated</dt>
                                    <dd>
                                        <time dateTime={post.updatedAt!}>{formatDate(post.updatedAt)}</time>
                                    </dd>
                                </div>
                            )}
                            <div className="flex gap-1">
                                <dt className="sr-only">Reading time</dt>
                                <dd>{post.readingMinutes} min read</dd>
                            </div>
                        </dl>
                    </div>
                    {post.image && (
                        <figure className="mx-auto mt-10 max-w-5xl md:mt-16">
                            <PostImage
                                image={post.image}
                                title={post.title}
                                priority
                                sizes="(min-width: 1024px) 1024px, 100vw"
                                className="max-h-[560px] w-full rounded-xl md:rounded-2xl"
                            />
                        </figure>
                    )}
                </header>

                <div className="mx-auto mt-10 grid max-w-container grid-cols-1 gap-10 px-4 md:mt-16 md:px-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,720px)_minmax(0,1fr)] lg:gap-12">
                    <div className="hidden lg:block" aria-hidden="true" />

                    <div className="min-w-0">
                        {showToc && (
                            <details className="group mb-8 rounded-xl bg-secondary p-4 ring-1 ring-secondary ring-inset lg:hidden">
                                <summary className="flex cursor-pointer list-none items-center justify-between text-md font-semibold text-primary">
                                    On this page
                                    <ChevronDown aria-hidden="true" className="size-5 text-fg-quaternary transition duration-150 group-open:rotate-180" />
                                </summary>
                                <TableOfContents toc={post.toc} className="mt-3 [&>p]:sr-only" />
                            </details>
                        )}

                        <div className="article-body prose max-w-none md:prose-lg" data-article-body dangerouslySetInnerHTML={{ __html: post.bodyHtml }} />

                        <footer className="mt-12 flex flex-col gap-6 border-t border-secondary pt-8 md:flex-row md:items-start md:justify-between">
                            {post.tags.length > 0 ? (
                                <ul aria-label="Tags" className="flex flex-wrap gap-2">
                                    {post.tags.map((tag) => (
                                        <li key={tag}>
                                            <a
                                                href={blogHref({ tag })}
                                                className="rounded-full outline-focus-ring focus-visible:outline-2 focus-visible:outline-offset-2"
                                            >
                                                <Badge size="md" color="gray">
                                                    {tag}
                                                </Badge>
                                            </a>
                                        </li>
                                    ))}
                                </ul>
                            ) : (
                                <span />
                            )}
                            <ShareLinks url={shareUrl} title={post.title} />
                        </footer>
                    </div>

                    <aside className="hidden lg:block">{showToc && <TableOfContents toc={post.toc} className="sticky top-28" />}</aside>
                </div>
            </article>

            <section aria-labelledby="related-heading" className="border-t border-secondary bg-secondary py-16 md:py-24">
                <div className="mx-auto max-w-container px-4 md:px-8">
                    <div className="flex items-end justify-between gap-4">
                        <h2 id="related-heading" className="text-display-xs font-semibold text-primary md:text-display-sm">
                            {related.length ? "Keep reading" : `More from ${site.name}`}
                        </h2>
                        <Button href="/blog" color="secondary" size="lg" iconTrailing={ArrowRight} className="max-md:hidden">
                            Back to the blog
                        </Button>
                    </div>
                    {related.length > 0 && (
                        <div className="mt-10 grid grid-cols-1 gap-12 md:mt-12 md:grid-cols-2 md:gap-x-8 lg:grid-cols-3">
                            {related.map((item) => (
                                <PostCard key={item.slug} post={item} />
                            ))}
                        </div>
                    )}
                    <Button href="/blog" color="secondary" size="lg" iconLeading={ArrowLeft} className="mt-10 w-full md:hidden">
                        Back to the blog
                    </Button>
                </div>
            </section>
        </>
    );
};
