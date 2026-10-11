import { ArrowRight, BookOpen01, Mail01, Tool02 } from "@untitledui/icons";
import { BadgeWithDot } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { FeaturedIcon } from "@/components/foundations/featured-icon/featured-icon";
import { Grid } from "@/components/shared-assets/background-patterns/grid";
import { EmptyPosts } from "@/components/site/empty-posts";
import { PostCard } from "@/components/site/post-card";
import { SectionHeader } from "@/components/site/section-header";
import { about } from "@/content/about";
import { site } from "@/content/site";
import type { PageData } from "@/shared/types";

const sections = [
    { title: "Writing", description: "Notes and longer pieces, published straight from my notebook.", href: "/blog", icon: BookOpen01, cta: "Read the blog" },
    { title: "About", description: "Who I am and what I spend my time on.", href: "/about", icon: Tool02, cta: "More about me" },
    { title: "Contact", description: "The best way to reach me.", href: "/contact", icon: Mail01, cta: "Get in touch" },
];

export const HomePage = ({ data }: { data: Extract<PageData, { route: "home" }> }) => (
    <>
        {/* Introduction */}
        <section className="relative overflow-hidden">
            <Grid size="lg" className="pointer-events-none absolute top-0 left-1/2 hidden -translate-x-1/2 -translate-y-1/3 text-border-secondary md:block" />
            <div className="relative mx-auto max-w-container px-4 pt-16 pb-16 md:px-8 md:pt-24 md:pb-24">
                <div className="flex max-w-3xl flex-col items-start">
                    <BadgeWithDot type="pill-color" color="brand" size="md">
                        {site.location}
                    </BadgeWithDot>
                    <h1 className="mt-4 text-display-md font-semibold text-primary md:text-display-xl">{site.name}</h1>
                    <p className="mt-4 max-w-2xl text-lg text-tertiary md:mt-6 md:text-xl">{about.lede} This is the front door. Writing lives on the blog.</p>
                    <div className="mt-8 flex w-full flex-col-reverse items-stretch gap-3 sm:w-auto sm:flex-row sm:items-start md:mt-12">
                        {site.email && (
                            <Button href={`mailto:${site.email}`} color="secondary" size="xl">
                                Get in touch
                            </Button>
                        )}
                        <Button href="/blog" size="xl" iconTrailing={ArrowRight}>
                            Read the blog
                        </Button>
                    </div>
                </div>
            </div>
        </section>

        {/* Latest writing */}
        <section aria-labelledby="latest-heading" className="border-t border-secondary bg-primary py-16 md:py-24">
            <div className="mx-auto max-w-container px-4 md:px-8">
                <SectionHeader
                    id="latest-heading"
                    eyebrow="Blog"
                    title="Latest writing"
                    action={
                        <Button href="/blog" color="secondary" size="lg" iconTrailing={ArrowRight} className="max-md:hidden">
                            View all posts
                        </Button>
                    }
                />
                <div className="mt-12 md:mt-16">
                    {data.latest.length ? (
                        <div className="grid grid-cols-1 gap-12 md:grid-cols-2 md:gap-x-8 lg:grid-cols-3">
                            {data.latest.map((post) => (
                                <PostCard key={post.slug} post={post} />
                            ))}
                        </div>
                    ) : (
                        <EmptyPosts
                            title="Nothing published yet"
                            description="The first articles are on their way. Check back soon, or follow along with the RSS feed."
                        />
                    )}
                </div>
                <Button href="/blog" color="secondary" size="lg" iconTrailing={ArrowRight} className="mt-12 w-full md:hidden">
                    View all posts
                </Button>
            </div>
        </section>

        {/* About */}
        <section aria-labelledby="about-heading" className="bg-secondary py-16 md:py-24">
            <div className="mx-auto grid max-w-container grid-cols-1 gap-8 px-4 md:px-8 lg:grid-cols-[1fr_1.4fr] lg:gap-16">
                <SectionHeader id="about-heading" eyebrow="About" title="A little about me" />
                <div className="flex flex-col items-start gap-6">
                    <p className="text-lg text-tertiary md:text-xl">{about.short}</p>
                    <Button href="/about" color="link-color" size="lg" iconTrailing={ArrowRight}>
                        More about me
                    </Button>
                </div>
            </div>
        </section>

        {/* Around the site — room for more sections later */}
        <section aria-labelledby="explore-heading" className="py-16 md:py-24">
            <div className="mx-auto max-w-container px-4 md:px-8">
                <h2 id="explore-heading" className="sr-only">
                    Around the site
                </h2>
                <ul className="grid grid-cols-1 gap-6 md:grid-cols-3 md:gap-8">
                    {sections.map((section) => (
                        <li
                            key={section.href}
                            className="group relative flex flex-col items-start gap-4 rounded-2xl bg-primary p-6 ring-1 ring-secondary transition duration-150 ease-out ring-inset hover:ring-primary md:p-8"
                        >
                            <FeaturedIcon icon={section.icon} color="brand" theme="light" size="lg" />
                            <div className="flex flex-col gap-1">
                                <h3 className="text-lg font-semibold text-primary">
                                    <a
                                        href={section.href}
                                        className="outline-focus-ring after:absolute after:inset-0 after:rounded-2xl focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-focus-ring"
                                    >
                                        {section.title}
                                    </a>
                                </h3>
                                <p className="text-md text-tertiary">{section.description}</p>
                            </div>
                            <span className="mt-auto flex items-center gap-1.5 text-md font-semibold text-brand-secondary">
                                {section.cta}
                                <ArrowRight aria-hidden="true" className="size-5 transition duration-150 ease-out group-hover:translate-x-0.5" />
                            </span>
                        </li>
                    ))}
                </ul>
            </div>
        </section>
    </>
);
