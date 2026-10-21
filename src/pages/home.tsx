import { ArrowRight } from "@untitledui/icons";
import { BlogSectionSimpleLeftAligned01 } from "@/components/marketing/blog/blog-section-simple-left-aligned-01";
import { site } from "@/content/site";
import type { PageData } from "@/shared/types";

/**
 * The public site is a personal notebook, not a marketing landing page.
 * Keep the private portal's styling and application navigation separate.
 */
export const HomePage = ({ data }: { data: Extract<PageData, { route: "home" }> }) => (
    <>
        <section className="personal-hero relative isolate overflow-hidden border-b border-secondary">
            <div className="relative mx-auto max-w-container px-4 py-20 md:px-8 md:py-28 lg:py-36">
                <div className="max-w-4xl">
                    <p className="personal-eyebrow text-sm font-semibold text-tertiary">HELLO, I'M AIDAN</p>
                    <h1 className="personal-display mt-7 max-w-4xl text-[clamp(3.5rem,8vw,7.5rem)] leading-[0.98] tracking-[-0.035em] text-primary">
                        Some things are worth <em>writing down.</em>
                    </h1>
                    <p className="mt-8 max-w-2xl text-lg leading-relaxed text-secondary md:mt-10 md:text-xl">
                        A place for what I'm learning about people, work and the projects I get carried away with.
                        Not everything fits a theme. That's fine with me.
                    </p>
                    <a
                        href="/blog"
                        className="personal-text-link mt-9 inline-flex items-center gap-2 rounded-xs py-2 text-md font-semibold text-primary outline-focus-ring focus-visible:outline-2 focus-visible:outline-offset-2"
                    >
                        Have a read <ArrowRight aria-hidden="true" className="size-5" />
                    </a>
                </div>
                <div className="personal-hero-doodle pointer-events-none absolute right-[-5rem] bottom-[-8rem] hidden select-none lg:block" aria-hidden="true">
                    *
                </div>
            </div>
        </section>

        <BlogSectionSimpleLeftAligned01 posts={data.latest} />

        <section aria-labelledby="about-this-place" className="border-t border-secondary">
            <div className="mx-auto grid max-w-container gap-6 px-4 py-16 md:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] md:gap-16 md:px-8 md:py-24">
                <h2 id="about-this-place" className="personal-display text-display-md leading-tight text-primary">
                    An assortment, really.
                </h2>
                <div className="max-w-2xl space-y-5 text-lg leading-relaxed text-secondary">
                    <p>Some notes are about leadership and learning. Others are about technology, making things, or ideas I haven't quite finished thinking through.</p>
                    <p>This is closer to an open notebook than a newsletter. Drop in whenever you like.</p>
                    <p>
                        {site.email ? (
                            <>
                                Have a thought to share?{" "}
                                <a href={`mailto:${site.email}`} className="personal-text-link text-primary underline underline-offset-4">
                                    Say hello
                                </a>
                                .
                            </>
                        ) : (
                            <a href="/about" className="personal-text-link text-primary underline underline-offset-4">A bit more about me</a>
                        )}
                    </p>
                </div>
            </div>
        </section>
    </>
);
