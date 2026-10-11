import { ArrowRight } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { ContentSectionSimple01 } from "@/components/marketing/content/content-section-simple-01";
import { about } from "@/content/about";

export const AboutPage = () => (
    <ContentSectionSimple01 title={about.heading} lede={about.lede}>
        {about.paragraphs.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
        ))}
        <div className="not-prose mt-10 flex flex-col gap-3 border-t border-secondary pt-8 sm:flex-row">
            <Button href="/blog" size="lg" iconTrailing={ArrowRight}>
                Read the blog
            </Button>
            <Button href="/contact" color="secondary" size="lg">
                Say hello
            </Button>
        </div>
    </ContentSectionSimple01>
);
