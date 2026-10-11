import { ArrowRight } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { about } from "@/content/about";
import { site } from "@/content/site";

export const AboutPage = () => (
    <div className="mx-auto max-w-container px-4 pt-12 pb-16 md:px-8 md:pt-20 md:pb-24">
        <div className="mx-auto max-w-3xl">
            <p className="text-sm font-semibold text-brand-secondary md:text-md">{site.location}</p>
            <h1 className="mt-3 text-display-md font-semibold text-primary md:text-display-lg">{about.heading}</h1>
            <p className="mt-4 text-lg text-tertiary md:mt-6 md:text-xl">{about.lede}</p>

            <div className="prose mt-10 max-w-none border-t border-secondary pt-10 md:prose-lg md:mt-12 md:pt-12">
                {about.paragraphs.map((paragraph) => (
                    <p key={paragraph}>{paragraph}</p>
                ))}
            </div>

            <div className="mt-12 flex flex-col gap-3 sm:flex-row">
                <Button href="/blog" size="lg" iconTrailing={ArrowRight}>
                    Read the blog
                </Button>
                <Button href="/contact" color="secondary" size="lg">
                    Get in touch
                </Button>
            </div>
        </div>
    </div>
);
