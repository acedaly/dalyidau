import { ArrowRight } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { ContentSectionSimple01 } from "@/components/marketing/content/content-section-simple-01";
import type { PublicPage } from "@/shared/site-content";

/**
 * A page managed in Payload (the About page is one), in the About page's layout. `bodyHtml` was built
 * from Payload's rich text by the escaping renderer when the page was published; the built-in About
 * page (shown until Payload publishes one) has plain paragraphs instead.
 */
export const CmsPage = ({ page }: { page: PublicPage }) => (
    <ContentSectionSimple01 title={page.title} lede={page.lede ?? ""}>
        {page.image && (
            <figure className="not-prose mb-10">
                <img src={page.image.src} alt={page.image.alt} width={page.image.width} height={page.image.height} className="w-full rounded-2xl" />
            </figure>
        )}
        {page.bodyHtml ? (
            <div className="contents" data-page-body dangerouslySetInnerHTML={{ __html: page.bodyHtml }} />
        ) : (
            (page.paragraphs ?? []).map((paragraph) => <p key={paragraph}>{paragraph}</p>)
        )}
        {page.showButtons && (
            <div className="not-prose mt-10 flex flex-col gap-3 border-t border-secondary pt-8 sm:flex-row">
                <Button href="/blog" size="lg" iconTrailing={ArrowRight}>
                    Read the blog
                </Button>
                <Button href="/contact" color="secondary" size="lg">
                    Say hello
                </Button>
            </div>
        )}
    </ContentSectionSimple01>
);
