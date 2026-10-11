import { ArrowRight } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { Grid } from "@/components/shared-assets/background-patterns/grid";

// Untitled UI PRO "hero-simple-text-01", adapted: the site header lives in the app shell, the
// stock photo is gone, and the remote pattern images are swapped for the local SVG pattern
// (the CSP only allows same-origin images).
export const HeroSimpleText01 = () => {
    return (
        <div className="relative overflow-hidden bg-primary">
            <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-0">
                <Grid size="lg" className="absolute top-0 right-0 translate-x-1/4 -translate-y-1/4 text-border-secondary max-md:hidden" />
                <Grid size="md" className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/3 text-border-secondary md:hidden" />
            </div>

            <section aria-labelledby="hero-heading" className="relative py-16 md:pt-28 md:pb-24">
                <div className="mx-auto w-full max-w-container px-4 md:px-8">
                    <div className="flex max-w-4xl flex-col">
                        <p className="text-md font-semibold text-brand-secondary">Hi, I'm Aidan.</p>
                        <h1
                            id="hero-heading"
                            className="mt-3 text-display-md font-medium text-balance text-primary md:mt-4 md:text-display-lg lg:text-display-xl"
                        >
                            A little{" "}
                            <span className="underline decoration-fg-brand-secondary decoration-[3px] underline-offset-[0.218em] md:decoration-4">corner</span>{" "}
                            of the internet.
                        </h1>
                        <p className="mt-4 max-w-(--breakpoint-sm) text-lg text-pretty text-tertiary md:mt-6 md:text-xl">
                            A place to share what I'm thinking, what I'm learning, and the occasional project or idea worth putting into words.
                        </p>
                        <div className="mt-8 flex w-full flex-col items-stretch gap-3 sm:w-auto sm:flex-row sm:items-start md:mt-12">
                            <Button href="/blog" size="xl" iconTrailing={ArrowRight}>
                                Read the blog
                            </Button>
                            <Button href="/about" color="secondary" size="xl">
                                About me
                            </Button>
                        </div>
                    </div>
                </div>
            </section>
        </div>
    );
};
