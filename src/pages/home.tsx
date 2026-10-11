import { BlogSectionSimpleLeftAligned01 } from "@/components/marketing/blog/blog-section-simple-left-aligned-01";
import { FeaturesSimpleIcons01 } from "@/components/marketing/features/features-simple-icons-01";
import { HeroSimpleText01 } from "@/components/marketing/header-section/hero-simple-text-01";
import { site } from "@/content/site";
import type { PageData } from "@/shared/types";

export const HomePage = ({ data }: { data: Extract<PageData, { route: "home" }> }) => (
    <>
        <HeroSimpleText01 />
        <BlogSectionSimpleLeftAligned01 posts={data.latest} />
        <FeaturesSimpleIcons01 />

        {/* A quiet sign-off rather than a call-to-action banner. */}
        <section aria-label="Say hello" className="py-16 md:py-20">
            <div className="mx-auto max-w-container px-4 md:px-8">
                <p className="max-w-2xl text-lg text-tertiary md:text-xl">
                    Thanks for stopping by.{" "}
                    {site.email ? (
                        <>
                            If something here sparks a thought, I'd love to hear it at{" "}
                            <a
                                href={`mailto:${site.email}`}
                                className="rounded-xs font-semibold text-brand-secondary underline decoration-transparent underline-offset-4 outline-focus-ring transition duration-100 ease-linear hover:decoration-current focus-visible:outline-2 focus-visible:outline-offset-2"
                            >
                                {site.email}
                            </a>
                            .
                        </>
                    ) : (
                        "New posts show up in the RSS feed as soon as they're published."
                    )}
                </p>
            </div>
        </section>
    </>
);
