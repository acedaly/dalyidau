// Header, mobile menu, sticky mobile RSVP bar and footer for the wedding website.
import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Menu02, XClose } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import type { SectionKind, WeddingPageData } from "@/shared/portal/types";
import { cx } from "@/utils/cx";
import { EucalyptusBranch } from "@/wedding/components/ornament";
import { shortDate, weddingButton } from "@/wedding/components/ui";

export interface SiteLinks {
    home: string;
    /** Where RSVP buttons go: the native page, or Say I Do while native RSVP is off. Null when closed. */
    rsvp: string | null;
    rsvpExternal: boolean;
}

export const siteLinks = (data: WeddingPageData): SiteLinks => {
    const home = data.preview ? "/portal/wedding/website/preview" : "/wedding";
    const nativePage = data.preview ? "/portal/wedding/website/preview/rsvp" : "/wedding/rsvp";
    // The preview always shows the native form, so owners can try it before switching it on.
    if (data.preview || data.rsvp.mode === "native") return { home, rsvp: nativePage, rsvpExternal: false };
    if (data.rsvp.mode === "external" && data.rsvp.externalUrl) return { home, rsvp: data.rsvp.externalUrl, rsvpExternal: true };
    return { home, rsvp: null, rsvpExternal: false };
};

export const rsvpLinkProps = (links: SiteLinks) =>
    links.rsvpExternal ? { href: links.rsvp ?? undefined, target: "_blank", rel: "noreferrer noopener" } : { href: links.rsvp ?? undefined };

/** Short navigation labels for each kind of section. */
const NAV_LABELS: Partial<Record<SectionKind, string>> = {
    story: "Our story",
    details: "Schedule",
    venue: "Venue",
    accommodation: "Stay",
    travel: "Travel",
    transport: "Transport",
    children: "Families",
    faq: "FAQ",
    registry: "Gifts",
};

export const navItems = (data: WeddingPageData) => {
    const seen = new Set<string>();
    const items: { id: string; label: string }[] = [];
    for (const section of data.content.sections) {
        const label = NAV_LABELS[section.kind];
        if (!label || seen.has(label)) continue;
        seen.add(label);
        items.push({ id: section.id, label });
    }
    if (!seen.has("Schedule") && data.events.length > 0) items.unshift({ id: "schedule", label: "Schedule" });
    return items;
};

export const Monogram = ({ data, className }: { data: WeddingPageData; className?: string }) => (
    <span className={cx("wedding-display text-forest inline-flex items-baseline gap-1", className)}>
        {data.details.partnerOne.charAt(0)}
        <span className="text-clay text-[0.8em] italic">&amp;</span>
        {data.details.partnerTwo.charAt(0)}
    </span>
);

export const SiteHeader = ({ data, links }: { data: WeddingPageData; links: SiteLinks }) => {
    const items = data.route === "home" ? navItems(data) : [];
    const menu = useRef<HTMLDetailsElement>(null);
    const close = () => menu.current?.removeAttribute("open");
    const anchor = (id: string) => (data.route === "home" ? `#${id}` : `${links.home}#${id}`);

    return (
        <header className="border-sandstone/50 bg-ivory/90 supports-[backdrop-filter]:bg-ivory/80 sticky top-0 z-30 border-b backdrop-blur-md">
            <nav aria-label="Wedding" className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6 lg:h-[4.5rem] lg:px-10">
                <a
                    href={links.home}
                    className="rounded-sm text-[1.75rem] leading-none outline-focus-ring focus-visible:outline-2 focus-visible:outline-offset-4"
                    aria-label={`${data.details.partnerOne} and ${data.details.partnerTwo}: home`}
                >
                    <Monogram data={data} />
                </a>

                <div className="flex items-center gap-2 lg:gap-8">
                    {items.length > 0 && (
                        <ul className="flex items-center gap-7 max-lg:hidden">
                            {items.slice(0, 6).map((item) => (
                                <li key={item.id}>
                                    <a
                                        href={anchor(item.id)}
                                        className="wedding-eyebrow text-charcoal/80 hover:text-forest rounded-sm text-[0.6875rem] outline-focus-ring transition duration-100 ease-linear focus-visible:outline-2 focus-visible:outline-offset-4"
                                    >
                                        {item.label}
                                    </a>
                                </li>
                            ))}
                        </ul>
                    )}
                    {links.rsvp && (
                        <Button
                            {...rsvpLinkProps(links)}
                            size="sm"
                            className={cx(weddingButton.primary, "min-h-10 px-5 py-2.5 text-[0.75rem]")}
                            iconTrailing={links.rsvpExternal ? ArrowUpRight : undefined}
                        >
                            RSVP
                        </Button>
                    )}
                    {items.length > 0 && (
                        <details ref={menu} className="group relative lg:hidden">
                            <summary
                                className="text-forest flex size-11 cursor-pointer list-none items-center justify-center rounded-full outline-focus-ring focus-visible:outline-2 [&::-webkit-details-marker]:hidden"
                                aria-label="Menu"
                            >
                                <Menu02 className="size-6 group-open:hidden" aria-hidden="true" />
                                <XClose className="hidden size-6 group-open:block" aria-hidden="true" />
                            </summary>
                            <div className="border-sandstone/60 bg-ivory fixed inset-x-0 top-16 z-40 border-b px-6 pt-4 pb-8 shadow-lg">
                                <ul className="flex flex-col">
                                    {items.map((item) => (
                                        <li key={item.id} className="border-sandstone/40 border-b last:border-0">
                                            <a
                                                href={anchor(item.id)}
                                                onClick={close}
                                                className="wedding-display text-forest flex min-h-14 items-center text-[1.625rem] outline-focus-ring focus-visible:outline-2"
                                            >
                                                {item.label}
                                            </a>
                                        </li>
                                    ))}
                                </ul>
                                <EucalyptusBranch className="text-eucalypt mx-auto mt-6 w-40" />
                            </div>
                        </details>
                    )}
                </div>
            </nav>
        </header>
    );
};

/**
 * On phones, a slim RSVP bar slides up once the hero has scrolled away and hides again over the
 * RSVP section, so the button is always to hand without covering the content that matters.
 */
export const MobileRsvpBar = ({ data, links }: { data: WeddingPageData; links: SiteLinks }) => {
    const [visible, setVisible] = useState(false);
    useEffect(() => {
        const hero = document.getElementById("hero");
        const rsvp = document.getElementById("rsvp");
        if (!hero || typeof IntersectionObserver === "undefined") return;
        let pastHero = false;
        let atRsvp = false;
        const update = () => setVisible(pastHero && !atRsvp);
        const observer = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (entry.target === hero) pastHero = !entry.isIntersecting;
                if (entry.target === rsvp) atRsvp = entry.isIntersecting;
            }
            update();
        });
        observer.observe(hero);
        if (rsvp) observer.observe(rsvp);
        return () => observer.disconnect();
    }, []);
    if (!links.rsvp) return null;
    return (
        <div
            className={cx(
                "border-sandstone/60 bg-ivory/95 fixed inset-x-0 bottom-0 z-30 border-t px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur-md transition-[translate,opacity,visibility] duration-300 ease-out sm:hidden",
                visible ? "visible translate-y-0 opacity-100" : "pointer-events-none invisible translate-y-full opacity-0",
            )}
            // Hidden bars are inert, so they can't be tabbed to or read out.
            inert={!visible}
        >
            <div className="flex items-center justify-between gap-4">
                <p className="text-charcoal text-sm leading-snug">
                    <span className="wedding-display text-forest block text-lg">Will you join us?</span>
                    {data.rsvp.deadline && <span className="text-tertiary">Kindly reply by {shortDate(data.rsvp.deadline)}</span>}
                </p>
                <Button {...rsvpLinkProps(links)} className={cx(weddingButton.primary, "shrink-0 px-6")}>
                    RSVP
                </Button>
            </div>
        </div>
    );
};

export const SiteFooter = ({ data, links }: { data: WeddingPageData; links: SiteLinks }) => (
    <footer className="border-sandstone/50 border-t px-4 pt-16 pb-28 sm:px-6 sm:pb-16 lg:px-10">
        <div className="mx-auto flex max-w-3xl flex-col items-center gap-5 text-center">
            <a href={links.home} className="rounded-sm text-[3.5rem] leading-none outline-focus-ring focus-visible:outline-2" aria-label="Back to the top">
                <Monogram data={data} />
            </a>
            <p className="wedding-eyebrow text-olive-600">
                {data.details.date && <span>{shortDate(data.details.date)}</span>}
                {data.details.date && data.details.location && <span aria-hidden="true"> · </span>}
                {data.details.location}
            </p>
            {data.content.contactEmail && (
                <p className="text-sm text-tertiary">
                    Questions? Email us at{" "}
                    <a
                        href={`mailto:${data.content.contactEmail}`}
                        className="text-forest decoration-forest/30 hover:decoration-forest rounded-sm underline underline-offset-4 outline-focus-ring focus-visible:outline-2"
                    >
                        {data.content.contactEmail}
                    </a>
                </p>
            )}
            <EucalyptusBranch className="text-eucalypt/80 mt-2 w-44" />
        </div>
    </footer>
);
