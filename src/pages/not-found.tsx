import { ArrowLeft, FileSearch02 } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { FeaturedIcon } from "@/components/foundations/featured-icon/featured-icon";
import { Circle } from "@/components/shared-assets/background-patterns/circle";

// Follows the Untitled UI empty-state layout.
export const NotFoundPage = () => (
    <section className="flex min-h-[60vh] items-center justify-center overflow-hidden px-4 py-16 md:py-24">
        <div className="mx-auto flex w-full max-w-lg flex-col items-center text-center">
            <div className="relative mb-6">
                <Circle size="md" className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" />
                <FeaturedIcon icon={FileSearch02} color="gray" theme="modern" size="xl" className="relative" />
            </div>
            <p className="relative text-sm font-semibold text-brand-secondary">404 error</p>
            <h1 className="relative mt-2 text-display-xs font-semibold text-primary md:text-display-sm">Page not found</h1>
            <p className="relative mt-3 text-md text-tertiary md:text-lg">
                Sorry, that page doesn't exist or has moved. Try the blog, or head back to the homepage.
            </p>
            <div className="relative mt-8 flex w-full flex-col-reverse gap-3 sm:w-auto sm:flex-row">
                <Button href="/" color="secondary" size="lg" iconLeading={ArrowLeft}>
                    Go home
                </Button>
                <Button href="/blog" size="lg">
                    Browse the blog
                </Button>
            </div>
        </div>
    </section>
);
