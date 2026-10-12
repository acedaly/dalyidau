// The public wedding website. Built from the same Untitled UI components and React Aria patterns as
// the rest of the site, wrapped in .wedding-theme, which re-roots every design token on the wedding
// palette (ivory, deep forest, eucalyptus, olive, sandstone, clay). See src/styles/wedding.css.
import { ArrowUpRight } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import type { WeddingPageData } from "@/shared/portal/types";
import { cx } from "@/utils/cx";
import { NativeArrangement } from "@/wedding/components/ornament";
import { Eyebrow, longDate, weddingButton } from "@/wedding/components/ui";
import { HomePage } from "@/wedding/home-page";
import { RsvpFlow } from "@/wedding/rsvp/rsvp-flow";
import { MobileRsvpBar, SiteFooter, SiteHeader, siteLinks } from "@/wedding/site-chrome";

const RsvpPage = ({ data }: { data: WeddingPageData }) => {
    // The preview always shows the native form, so owners can test it before switching it on.
    const native = data.rsvp.mode === "native" || data.preview;
    return (
        <section aria-labelledby="rsvp-title" className="bg-sandstone-light relative isolate overflow-hidden px-4 py-14 sm:px-6 sm:py-20 lg:py-24">
            <div className="mx-auto grid max-w-7xl grid-cols-1 gap-12 lg:grid-cols-[.72fr_1.28fr] lg:gap-20">
                <aside className="relative flex flex-col items-start gap-5 lg:sticky lg:top-28 lg:self-start">
                    <Eyebrow>
                        {data.details.partnerOne} &amp; {data.details.partnerTwo}
                    </Eyebrow>
                    <h1 id="rsvp-title" className="wedding-script text-forest text-[4.75rem] leading-[0.9] sm:text-[6.5rem]">
                        Your RSVP
                    </h1>
                    {data.details.date && <p className="wedding-display text-clay-700 text-[1.4rem] italic">{longDate(data.details.date)}</p>}
                    <p className="wedding-prose text-charcoal max-w-sm">
                        We’re so glad you’re here. Reply for everyone named on your invitation, and come back any time before the deadline if plans change.
                    </p>
                    <NativeArrangement quiet className="mt-2 -ml-16 h-72 w-72 rotate-[-8deg] max-lg:hidden" />
                </aside>
                <div className="w-full max-w-2xl lg:justify-self-end">
                    {native ? (
                        <RsvpFlow
                            apiBase={data.preview ? "/api/portal/wedding/rsvp-test" : "/api/wedding/rsvp"}
                            deadline={data.rsvp.deadline}
                            wedding={data.details}
                            homeHref={data.preview ? "/portal/wedding/website/preview" : "/wedding"}
                        />
                    ) : data.rsvp.mode === "external" && data.rsvp.externalUrl ? (
                        <div className="bg-paper border-sandstone flex flex-col items-center gap-6 border px-6 py-12 text-center sm:px-12">
                            <p className="wedding-prose text-charcoal max-w-md">
                                We're collecting replies through our RSVP partner for now. It only takes a minute.
                            </p>
                            <Button
                                href={data.rsvp.externalUrl}
                                size="xl"
                                iconTrailing={ArrowUpRight}
                                target="_blank"
                                rel="noreferrer noopener"
                                className={weddingButton.primary}
                            >
                                Continue to RSVP
                            </Button>
                        </div>
                    ) : (
                        <p className="wedding-prose text-charcoal mx-auto max-w-md text-center">
                            Online replies aren't open yet. Please check back soon, or use the details on your invitation.
                        </p>
                    )}
                </div>
            </div>
        </section>
    );
};

export const WeddingApp = ({ data }: { data: WeddingPageData; path: string }) => {
    const links = siteLinks(data);
    return (
        <div className="wedding-theme wedding-paper flex min-h-dvh flex-col">
            <a
                href="#main"
                className="bg-forest text-ivory sr-only z-50 rounded-full px-5 py-2.5 text-sm font-medium focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
            >
                Skip to content
            </a>
            {data.preview && (
                <p className="bg-olive-700 px-4 py-2 text-center text-sm text-white">
                    Preview from Wedding Planner{data.route === "rsvp" ? ": replies sent here are saved for real, so use a test household." : "."}{" "}
                    <a href="/portal/wedding/website" className="font-semibold underline underline-offset-2">
                        Back to the portal
                    </a>
                </p>
            )}
            <SiteHeader data={data} links={links} />
            <main id="main" className={cx("flex-1", data.route === "rsvp" && "bg-ivory")}>
                {data.route === "rsvp" ? <RsvpPage data={data} /> : <HomePage data={data} links={links} />}
            </main>
            <SiteFooter data={data} links={links} />
            {data.route === "home" && <MobileRsvpBar data={data} links={links} />}
        </div>
    );
};
