import { ArrowRight } from "@untitledui/icons";
import { BlogSectionSimpleLeftAligned01 } from "@/components/marketing/blog/blog-section-simple-left-aligned-01";
import { useSite } from "@/providers/site-content";
import type { PageData } from "@/shared/types";

/**
 * The public site is a personal notebook, not a marketing landing page.
 * Keep the private portal's styling and application navigation separate.
 */
export const HomePage = ({ data }: { data: Extract<PageData, { route: "home" }> }) => {
    const site = useSite();
    const { home } = data;
    return (
    <>
        <section className="personal-hero relative isolate overflow-hidden border-b border-secondary">
            <div className="relative mx-auto max-w-container px-4 py-20 md:px-8 md:py-28 lg:py-36">
                <div className="max-w-4xl">
                    <p className="personal-eyebrow text-sm font-semibold text-tertiary">{home.eyebrow}</p>
                    <h1 className="personal-display mt-7 max-w-4xl text-[clamp(3.5rem,8vw,7.5rem)] leading-[0.98] tracking-[-0.035em] text-primary">
                        {home.headingEmphasis ? (
                            <>
                                {`${home.heading} `}
                                <em>{home.headingEmphasis}</em>
                            </>
                        ) : (
                            home.heading
                        )}
                    </h1>
                    <p className="mt-8 max-w-2xl text-lg leading-relaxed text-secondary md:mt-10 md:text-xl">
                        {home.intro}
                    </p>
                    <a
                        href={home.ctaHref}
                        className="personal-text-link mt-9 inline-flex items-center gap-2 rounded-xs py-2 text-md font-semibold text-primary outline-focus-ring focus-visible:outline-2 focus-visible:outline-offset-2"
                    >
                        {home.ctaLabel} <ArrowRight aria-hidden="true" className="size-5" />
                    </a>
                </div>
                <div className="personal-hero-doodle pointer-events-none absolute right-[-5rem] bottom-[-8rem] hidden select-none lg:block" aria-hidden="true">
                    *
                </div>
            </div>
        </section>

        <BlogSectionSimpleLeftAligned01 posts={data.latest} eyebrow={home.latestEyebrow} heading={home.latestHeading} />

        <section aria-labelledby="about-this-place" className="border-t border-secondary">
            <div className="mx-auto grid max-w-container gap-6 px-4 py-16 md:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] md:gap-16 md:px-8 md:py-24">
                <h2 id="about-this-place" className="personal-display text-display-md leading-tight text-primary">
                    {home.aboutHeading}
                </h2>
                <div className="max-w-2xl space-y-5 text-lg leading-relaxed text-secondary">
                    {home.aboutParagraphs.map((paragraph, i) => (
                        <p key={i}>{paragraph}</p>
                    ))}
                    {home.showContactLine && <p>
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
                    </p>}
                </div>
            </div>
        </section>
    </>
    );
};
