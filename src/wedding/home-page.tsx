// The wedding homepage. Every section kind has its own composition so the page reads like a
// designed invitation rather than a stack of identical blocks. All copy comes from the portal
// (Website editor) and event details from the Wedding Planner; nothing here invents facts.
import { useEffect, useState } from "react";
import { ArrowDown, ArrowUpRight } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { formatDate, formatTime } from "@/portal/lib/format";
import type { PublicEvent, WebsiteItem, WebsiteSection, WeddingPageData } from "@/shared/portal/types";
import { cx } from "@/utils/cx";
import { EucalyptusBranch, Sprig, Stamp } from "@/wedding/components/ornament";
import { Eyebrow, Photo, Prose, SectionHeading, longDate, paragraphs, weddingButton } from "@/wedding/components/ui";
import { type SiteLinks, rsvpLinkProps } from "@/wedding/site-chrome";

const container = "mx-auto w-full max-w-7xl px-5 sm:px-8 lg:px-10";

/** Eyebrow labels by section kind. Custom sections have none. */
const EYEBROWS: Partial<Record<WebsiteSection["kind"], string>> = {
    story: "Our story",
    details: "The celebration",
    venue: "The venue",
    accommodation: "Accommodation",
    travel: "Getting there",
    transport: "Getting there",
    children: "Families",
    dress: "Dress code",
    registry: "Gifts",
    faq: "Questions",
};

const external = { target: "_blank", rel: "noreferrer noopener" } as const;

const ItemLink = ({ item, label }: { item: WebsiteItem; label: string }) =>
    item.url ? (
        <a
            href={item.url}
            {...external}
            className={cx(
                weddingButton.link,
                "inline-flex items-center gap-1.5 self-start outline-focus-ring focus-visible:outline-2 focus-visible:outline-offset-4",
            )}
        >
            {label}
            <ArrowUpRight className="size-4" aria-hidden="true" />
            <span className="sr-only">(opens in a new tab)</span>
        </a>
    ) : null;

// ---------------------------------------------------------------------------------------------
// Hero

/** "Aidan & Amelia" from the custom title when it has two names, otherwise from Wedding settings. */
const coupleNames = (data: WeddingPageData): [string, string] | null => {
    const title = data.content.heroTitle.trim();
    if (!title) return [data.details.partnerOne, data.details.partnerTwo];
    const parts = title.split(/\s+(?:&|and|\+)\s+/i);
    return parts.length === 2 ? [parts[0], parts[1]] : null;
};

const Hero = ({ data, links }: { data: WeddingPageData; links: SiteLinks }) => {
    const { details, content } = data;
    const names = coupleNames(data);
    const [place, ...rest] = details.location.split(/\s*[·,]\s*/);
    return (
        <section id="hero" aria-labelledby="names" className="relative overflow-hidden">
            <div className={cx(container, "grid grid-cols-1 items-center gap-12 pt-10 pb-16 sm:pt-14 lg:grid-cols-12 lg:gap-6 lg:pt-16 lg:pb-24")}>
                <div className="wedding-rise flex flex-col items-center text-center lg:col-span-6 lg:items-start lg:text-left">
                    {content.heroEyebrow && <Eyebrow>{content.heroEyebrow}</Eyebrow>}
                    <h1 id="names" className="wedding-display text-forest mt-7 font-[400]">
                        {names ? (
                            <>
                                <span className="block text-[clamp(4.25rem,17vw,8.75rem)] leading-[0.9] tracking-[-0.02em]">{names[0]}</span>{" "}
                                <span className="text-clay block py-1 text-[clamp(2.75rem,10vw,4.75rem)] leading-none italic lg:pl-[0.9em]">&amp;</span>{" "}
                                <span className="block text-[clamp(4.25rem,17vw,8.75rem)] leading-[0.9] tracking-[-0.02em] lg:pl-[0.6em]">{names[1]}</span>
                            </>
                        ) : (
                            <span className="block text-[clamp(3.25rem,12vw,6.5rem)] leading-[0.95]">{content.heroTitle}</span>
                        )}
                    </h1>
                    {content.heroSubtitle && <p className="wedding-display text-charcoal mt-8 text-[1.75rem] sm:text-[2rem]">{content.heroSubtitle}</p>}

                    {(details.date || details.location) && (
                        <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row sm:gap-5 lg:items-center">
                            {details.date && (
                                <p className="wedding-display text-forest text-[1.5rem]">
                                    <time dateTime={details.date}>{longDate(details.date)}</time>
                                </p>
                            )}
                            {details.date && details.location && <span aria-hidden="true" className="bg-olive/50 h-px w-10 sm:h-8 sm:w-px" />}
                            {details.location && (
                                <p className="wedding-eyebrow text-olive-600">
                                    {place}
                                    {rest.length > 0 && (
                                        <>
                                            <span aria-hidden="true"> · </span>
                                            {rest.join(", ")}
                                        </>
                                    )}
                                </p>
                            )}
                        </div>
                    )}

                    <div className="mt-10 flex w-full flex-col items-center gap-6 sm:w-auto sm:flex-row sm:gap-8">
                        {links.rsvp && (
                            <Button
                                {...rsvpLinkProps(links)}
                                size="xl"
                                className={cx(weddingButton.primary, "w-full sm:w-auto sm:px-10")}
                                iconTrailing={links.rsvpExternal ? ArrowUpRight : undefined}
                            >
                                RSVP
                            </Button>
                        )}
                        <a
                            href="#welcome"
                            className={cx(
                                weddingButton.link,
                                "inline-flex items-center gap-2 outline-focus-ring focus-visible:outline-2 focus-visible:outline-offset-4",
                            )}
                        >
                            Explore our wedding
                            <ArrowDown className="size-4" aria-hidden="true" />
                        </a>
                    </div>
                </div>

                <div className="relative mx-auto w-full max-w-[22rem] sm:max-w-[26rem] lg:col-span-6 lg:mr-4 lg:ml-auto lg:max-w-[30rem]">
                    <Photo
                        image={data.heroImage}
                        shape="arch"
                        ratio="4 / 5"
                        priority
                        sizes="(min-width: 1024px) 480px, 90vw"
                        className="wedding-fade shadow-[0_30px_60px_-30px_rgb(53_76_62/0.45)]"
                    />
                    <EucalyptusBranch draw className="text-eucalypt absolute -top-6 -left-14 w-56 rotate-[-18deg] sm:-left-20 sm:w-72" />
                    <EucalyptusBranch draw flip className="text-olive/80 absolute -right-12 -bottom-8 w-48 rotate-[12deg] sm:-right-16 sm:w-60" />
                    {data.heroImage?.caption && <p className="mt-5 text-center text-sm text-tertiary italic">{data.heroImage.caption}</p>}
                    {details.date && (
                        <p
                            aria-hidden="true"
                            className="wedding-eyebrow text-olive/70 absolute top-1/2 -right-14 origin-center translate-x-1/2 -translate-y-1/2 rotate-90 text-[0.625rem] whitespace-nowrap max-lg:hidden"
                        >
                            {formatDate(details.date, { day: "2-digit", month: "2-digit", year: "numeric" }).replace(/\//g, " · ")}
                        </p>
                    )}
                </div>
            </div>
        </section>
    );
};

// ---------------------------------------------------------------------------------------------
// Welcome

const Welcome = ({ data }: { data: WeddingPageData }) => {
    const [lead, ...rest] = paragraphs(data.content.welcome);
    if (!lead) return <div id="welcome" />;
    return (
        <section id="welcome" aria-label="Welcome" className="wedding-reveal scroll-mt-20 px-5 pt-8 pb-20 sm:px-8 sm:pt-16 lg:py-28">
            <div className="mx-auto flex max-w-3xl flex-col items-center gap-8 text-center">
                <Sprig />
                <p className="wedding-display text-forest text-[1.875rem] leading-[1.25] text-balance sm:text-[2.5rem]">{lead}</p>
                {rest.length > 0 && <Prose text={rest.join("\n\n")} className="text-charcoal max-w-xl" />}
                <p className="wedding-display text-clay text-[1.5rem] italic">
                    {data.details.partnerOne} &amp; {data.details.partnerTwo}
                </p>
            </div>
        </section>
    );
};

// ---------------------------------------------------------------------------------------------
// The big day: date card, event timeline and dress code

const Countdown = ({ date }: { date: string }) => {
    // Calculated after hydration so the server render never disagrees with the visitor's clock.
    const [days, setDays] = useState<number | null>(null);
    useEffect(() => {
        const target = Date.parse(`${date}T00:00:00+10:00`);
        setDays(Math.ceil((target - Date.now()) / 86_400_000));
    }, [date]);
    if (days === null || days < 0) return <p className="h-5" />;
    return <p className="wedding-eyebrow text-clay-600">{days === 0 ? "Today" : days === 1 ? "Tomorrow" : `${days.toLocaleString("en-AU")} days to go`}</p>;
};

const eventTime = (event: PublicEvent) => {
    if (!event.startsAt || event.startsAt.length < 16) return null;
    const end = event.endsAt && event.endsAt.slice(0, 10) === event.startsAt.slice(0, 10) ? formatTime(event.endsAt) : "";
    return `${formatTime(event.startsAt)}${end ? ` – ${end}` : ""}`;
};

const BigDay = ({ data, section, dress }: { data: WeddingPageData; section: Pick<WebsiteSection, "id" | "title" | "body">; dress: WebsiteSection | null }) => {
    const { details, events } = data;
    return (
        <section
            id={section.id}
            aria-labelledby={`${section.id}-heading`}
            className="wedding-reveal border-sandstone/40 bg-paper scroll-mt-20 border-y py-20 lg:py-28"
        >
            <div className={cx(container, "grid grid-cols-1 gap-14 lg:grid-cols-12 lg:gap-10")}>
                <div className="flex flex-col gap-8 lg:col-span-5">
                    <SectionHeading id={`${section.id}-heading`} eyebrow={EYEBROWS.details} title={section.title} />
                    {section.body && <Prose text={section.body} className="text-charcoal max-w-md" />}
                    {details.date && (
                        <div className="border-sandstone relative mt-2 self-center border p-2 lg:self-start">
                            <div className="border-sandstone/60 flex flex-col items-center gap-1 border px-10 py-8 text-center sm:px-14">
                                <p className="wedding-eyebrow text-olive-600">{formatDate(details.date, { weekday: "long" })}</p>
                                <p className="wedding-display text-forest text-[6.5rem] leading-[0.95] font-[350]">
                                    {formatDate(details.date, { day: "numeric" })}
                                </p>
                                <p className="wedding-display text-forest text-[1.625rem]">{formatDate(details.date, { month: "long", year: "numeric" })}</p>
                                <span aria-hidden="true" className="bg-clay/60 my-3 h-px w-10" />
                                <Countdown date={details.date} />
                            </div>
                        </div>
                    )}
                </div>

                <div className="flex flex-col gap-14 lg:col-span-6 lg:col-start-7 lg:pt-24">
                    {events.length > 0 ? (
                        <ol className="border-sandstone relative flex flex-col gap-12 border-l pl-8 sm:pl-10">
                            {events.map((event) => {
                                const time = eventTime(event);
                                return (
                                    <li key={event.id} className="relative flex flex-col gap-2">
                                        <span
                                            aria-hidden="true"
                                            className="bg-paper ring-clay absolute top-2 -left-[calc(2rem+5px)] size-2.5 rounded-full ring-1 sm:-left-[calc(2.5rem+5px)]"
                                        />
                                        <p className="wedding-eyebrow text-clay-600">{time ?? "Time to be confirmed"}</p>
                                        <h3 className="wedding-display text-forest text-[2rem] sm:text-[2.375rem]">{event.name}</h3>
                                        {(event.venueName || event.address) && (
                                            <p className="text-charcoal">
                                                {event.venueName}
                                                {event.venueName && event.address && <span aria-hidden="true"> · </span>}
                                                {event.address && <span className="text-tertiary">{event.address}</span>}
                                            </p>
                                        )}
                                        {event.startsAt && event.startsAt.slice(0, 10) !== details.date && (
                                            <p className="text-sm text-tertiary">{longDate(event.startsAt.slice(0, 10))}</p>
                                        )}
                                        {event.description && <Prose text={event.description} className="max-w-lg text-tertiary" />}
                                        {event.dressCode && (
                                            <p className="text-sm text-tertiary">
                                                <span className="wedding-eyebrow mr-2 text-[0.625rem] text-olive-600">Dress</span>
                                                {event.dressCode}
                                            </p>
                                        )}
                                    </li>
                                );
                            })}
                        </ol>
                    ) : (
                        <div className="border-sandstone flex flex-col gap-3 border-l pl-8 sm:pl-10">
                            <p className="wedding-eyebrow text-clay-600">Timings</p>
                            <p className="wedding-display text-forest text-[1.75rem]">To be confirmed</p>
                            <p className="max-w-sm text-tertiary">We'll post the order of the day here once it's set.</p>
                        </div>
                    )}

                    {dress && (
                        <div id={dress.id} className="border-sandstone/60 scroll-mt-24 border-t pt-10">
                            <Eyebrow>{EYEBROWS.dress}</Eyebrow>
                            <h3 className="wedding-display text-forest mt-3 text-[1.875rem]">{dress.title}</h3>
                            {dress.body && <Prose text={dress.body} className="text-charcoal mt-4 max-w-lg" />}
                        </div>
                    )}
                </div>
            </div>
        </section>
    );
};

// ---------------------------------------------------------------------------------------------
// Venue

const Venue = ({ data, section }: { data: WeddingPageData; section: WebsiteSection }) => {
    const image = section.imageId ? data.sectionImages[section.imageId] : null;
    const mapItem = section.items.find((item) => item.url);
    return (
        <section id={section.id} aria-labelledby={`${section.id}-heading`} className="wedding-reveal relative scroll-mt-20">
            <div className={cx("relative aspect-[4/3] sm:aspect-[16/9] lg:aspect-auto", image ? "lg:h-[min(88vh,52rem)]" : "lg:h-[36rem]")}>
                <Photo image={image} shape="none" fallback="wide" sizes="100vw" className="absolute inset-0 rounded-none" />
            </div>
            <div className="relative z-10 mx-4 -mt-16 sm:mx-8 sm:-mt-24 lg:absolute lg:bottom-14 lg:left-10 lg:m-0 lg:w-[31rem] xl:left-[max(2.5rem,calc((100vw-80rem)/2+2.5rem))]">
                <div className="bg-paper p-2 shadow-[0_30px_60px_-30px_rgb(36_54_43/0.5)]">
                    <div className="border-sandstone/70 flex flex-col gap-6 border px-6 py-9 sm:px-10 sm:py-11">
                        <SectionHeading id={`${section.id}-heading`} eyebrow={EYEBROWS.venue} title={section.title} size="md" />
                        {section.body && <Prose text={section.body} className="text-charcoal" />}
                        {section.items.length > 0 && (
                            <dl className="border-sandstone/60 flex flex-col gap-4 border-t pt-6">
                                {section.items.map((item, i) => (
                                    <div key={i} className="flex flex-col gap-1">
                                        <dt className="wedding-eyebrow text-[0.6875rem] text-olive-600">{item.title}</dt>
                                        {item.body && <dd className="wedding-prose text-charcoal">{item.body}</dd>}
                                    </div>
                                ))}
                            </dl>
                        )}
                        {mapItem && (
                            <Button
                                href={mapItem.url}
                                {...external}
                                className={cx(weddingButton.outline, "self-start")}
                                iconTrailing={ArrowUpRight}
                                aria-label="Directions and map (opens in a new tab)"
                            >
                                Directions &amp; map
                            </Button>
                        )}
                    </div>
                </div>
            </div>
            <div className="h-20 lg:hidden" />
        </section>
    );
};

// ---------------------------------------------------------------------------------------------
// Accommodation

const Accommodation = ({ data, section }: { data: WeddingPageData; section: WebsiteSection }) => {
    const image = section.imageId ? data.sectionImages[section.imageId] : null;
    const [featured, ...others] = section.items;
    return (
        <section id={section.id} aria-labelledby={`${section.id}-heading`} className="wedding-reveal bg-sandstone-light/80 scroll-mt-20 py-20 lg:py-28">
            <div className={cx(container, "grid grid-cols-1 gap-12 lg:grid-cols-12 lg:gap-10")}>
                <div className="flex flex-col gap-8 lg:col-span-5">
                    <SectionHeading id={`${section.id}-heading`} eyebrow={EYEBROWS.accommodation} title={section.title} />
                    {section.body && <Prose text={section.body} className="text-charcoal max-w-md" />}
                    <Stamp text="Limited · first in, first served · " className="size-32 rotate-[-8deg] max-lg:hidden">
                        <text
                            x="60"
                            y="66"
                            textAnchor="middle"
                            fill="currentColor"
                            fontSize="15"
                            style={{ fontFamily: "var(--font-wedding-display)", fontStyle: "italic" }}
                        >
                            book early
                        </text>
                    </Stamp>
                </div>

                <div className="flex flex-col gap-8 lg:col-span-7">
                    {featured && (
                        <article className="bg-paper p-2 shadow-[0_24px_50px_-30px_rgb(36_54_43/0.35)]">
                            <div className="border-sandstone/60 flex flex-col border">
                                {image && <Photo image={image} shape="none" ratio="16 / 9" sizes="(min-width: 1024px) 700px, 100vw" className="rounded-none" />}
                                <div className="flex flex-col gap-4 px-6 py-8 sm:px-10 sm:py-10">
                                    <Eyebrow className="text-clay-600">{others.length > 0 ? "Our first pick" : "Stay on site"}</Eyebrow>
                                    <h3 className="wedding-display text-forest text-[2.25rem] sm:text-[2.75rem]">{featured.title}</h3>
                                    {featured.body && <Prose text={featured.body} className="text-charcoal max-w-xl" />}
                                    <ItemLink item={featured} label="Book or enquire" />
                                </div>
                            </div>
                        </article>
                    )}
                    {others.length > 0 && (
                        <div className="flex flex-col gap-2">
                            <Eyebrow>Nearby alternatives</Eyebrow>
                            <ul className="divide-sandstone border-sandstone divide-y border-y">
                                {others.map((item, i) => (
                                    <li key={i} className="grid grid-cols-1 gap-3 py-7 sm:grid-cols-[1fr_auto] sm:items-baseline sm:gap-8">
                                        <div className="flex flex-col gap-2">
                                            <h3 className="wedding-display text-forest text-[1.625rem]">{item.title}</h3>
                                            {item.body && <Prose text={item.body} className="max-w-lg text-[1rem] text-tertiary" />}
                                        </div>
                                        <ItemLink item={item} label="Visit" />
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                </div>
            </div>
        </section>
    );
};

// ---------------------------------------------------------------------------------------------
// Getting there and the courtesy bus

const Travel = ({ data, section, transport }: { data: WeddingPageData; section: WebsiteSection; transport: WebsiteSection | null }) => {
    const image = section.imageId ? data.sectionImages[section.imageId] : transport?.imageId ? data.sectionImages[transport.imageId] : null;
    return (
        <section id={section.id} aria-labelledby={`${section.id}-heading`} className="wedding-reveal scroll-mt-20 py-20 lg:py-28">
            <div className={cx(container, "grid grid-cols-1 gap-12 lg:grid-cols-12 lg:gap-10")}>
                <div className="flex flex-col gap-8 lg:col-span-5">
                    <SectionHeading id={`${section.id}-heading`} eyebrow={EYEBROWS[section.kind]} title={section.title} />
                    {section.body && <Prose text={section.body} className="text-charcoal max-w-md" />}
                    {section.items.length > 0 && (
                        <ul className="divide-sandstone/70 border-sandstone/70 flex flex-col divide-y border-t">
                            {section.items.map((item, i) => (
                                <li key={i} className="flex flex-col gap-2 py-6">
                                    <h3 className="wedding-display text-forest text-[1.5rem]">{item.title}</h3>
                                    {item.body && <Prose text={item.body} className="text-[1rem] text-tertiary" />}
                                    <ItemLink item={item} label="Open map" />
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
                <div className="flex flex-col gap-8 lg:col-span-6 lg:col-start-7">
                    {image && <Photo image={image} ratio="4 / 3" sizes="(min-width: 1024px) 600px, 100vw" />}
                    {transport && (
                        <div id={transport.id} className="border-sandstone scroll-mt-24 border p-2">
                            <div className="border-sandstone/60 flex flex-col gap-4 border px-6 py-8 sm:px-10 sm:py-10">
                                <Eyebrow className="text-clay-600">Transport</Eyebrow>
                                <h3 className="wedding-display text-forest text-[2rem]">{transport.title}</h3>
                                {transport.body && <Prose text={transport.body} className="text-charcoal" />}
                                {transport.items.map((item, i) => (
                                    <div key={i} className="border-sandstone/60 flex flex-col gap-1 border-t pt-4">
                                        <p className="wedding-eyebrow text-[0.6875rem] text-olive-600">{item.title}</p>
                                        {item.body && <Prose text={item.body} className="text-[1rem] text-tertiary" />}
                                        <ItemLink item={item} label="More" />
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                    {!image && !transport && <EucalyptusBranch className="text-eucalypt w-72 self-center lg:mt-16" />}
                </div>
            </div>
        </section>
    );
};

// ---------------------------------------------------------------------------------------------
// Story, children and other text-led sections

const Feature = ({ data, section, tone }: { data: WeddingPageData; section: WebsiteSection; tone: "ivory" | "eucalypt" }) => {
    const image = section.imageId ? data.sectionImages[section.imageId] : null;
    return (
        <section
            id={section.id}
            aria-labelledby={`${section.id}-heading`}
            className={cx("wedding-reveal scroll-mt-20 py-20 lg:py-28", tone === "eucalypt" ? "bg-eucalypt-light" : "border-sandstone/40 border-t")}
        >
            {image ? (
                <div className={cx(container, "grid grid-cols-1 items-center gap-12 lg:grid-cols-12 lg:gap-10")}>
                    <div className="mx-auto w-full max-w-md lg:col-span-5 lg:max-w-none">
                        <Photo image={image} shape="arch" ratio="4 / 5" sizes="(min-width: 1024px) 480px, 90vw" />
                    </div>
                    <div className="flex flex-col gap-8 lg:col-span-6 lg:col-start-7">
                        <SectionHeading id={`${section.id}-heading`} eyebrow={EYEBROWS[section.kind]} title={section.title} />
                        {section.body && <Prose text={section.body} className="text-charcoal max-w-lg" />}
                        <SectionItems items={section.items} />
                    </div>
                </div>
            ) : (
                <div className="mx-auto flex max-w-2xl flex-col items-center gap-8 px-5 text-center sm:px-8">
                    <EucalyptusBranch className="text-eucalypt w-56" />
                    <SectionHeading id={`${section.id}-heading`} eyebrow={EYEBROWS[section.kind]} title={section.title} align="center" />
                    {section.body && <Prose text={section.body} className="text-charcoal" />}
                    <SectionItems items={section.items} />
                </div>
            )}
        </section>
    );
};

const SectionItems = ({ items }: { items: WebsiteItem[] }) =>
    items.length > 0 ? (
        <ul className="divide-sandstone/70 border-sandstone/70 flex w-full flex-col divide-y border-y text-left">
            {items.map((item, i) => (
                <li key={i} className="flex flex-col gap-2 py-6">
                    <h3 className="wedding-display text-forest text-[1.5rem]">{item.title}</h3>
                    {item.body && <Prose text={item.body} className="text-[1rem] text-tertiary" />}
                    <ItemLink item={item} label="Visit" />
                </li>
            ))}
        </ul>
    ) : null;

// ---------------------------------------------------------------------------------------------
// FAQ

const Faq = ({ data, section }: { data: WeddingPageData; section: WebsiteSection }) => (
    <section id={section.id} aria-labelledby={`${section.id}-heading`} className="wedding-reveal border-sandstone/40 scroll-mt-20 border-t py-20 lg:py-28">
        <div className={cx(container, "grid grid-cols-1 gap-12 lg:grid-cols-12 lg:gap-10")}>
            <div className="flex flex-col gap-6 lg:sticky lg:top-28 lg:col-span-4 lg:self-start">
                <SectionHeading id={`${section.id}-heading`} eyebrow={EYEBROWS.faq} title={section.title} />
                {section.body && <Prose text={section.body} className="text-charcoal" />}
                {data.content.contactEmail && (
                    <p className="text-tertiary">
                        Can't find what you need?{" "}
                        <a
                            href={`mailto:${data.content.contactEmail}`}
                            className="text-forest decoration-forest/30 hover:decoration-forest rounded-sm underline underline-offset-4 outline-focus-ring focus-visible:outline-2"
                        >
                            Send us a note
                        </a>
                        .
                    </p>
                )}
            </div>
            <div className="wedding-faq border-sandstone border-t lg:col-span-7 lg:col-start-6">
                {section.items.map((item, i) => (
                    <details key={i} className="group border-sandstone border-b">
                        <summary className="flex min-h-16 cursor-pointer items-center justify-between gap-6 py-5 outline-focus-ring focus-visible:outline-2 focus-visible:outline-offset-2">
                            <h3 className="wedding-display text-forest text-[1.375rem] leading-snug sm:text-[1.625rem]">{item.title}</h3>
                            <span aria-hidden="true" className="text-clay relative size-4 shrink-0">
                                <span className="absolute top-1/2 left-0 h-px w-4 -translate-y-1/2 bg-current" />
                                <span data-plus-vertical className="absolute top-0 left-1/2 h-4 w-px -translate-x-1/2 bg-current" />
                            </span>
                        </summary>
                        <div className="max-w-2xl pb-7">
                            {item.body && <Prose text={item.body} className="text-charcoal" />}
                            {item.url && (
                                <div className="mt-4">
                                    <ItemLink item={item} label="More information" />
                                </div>
                            )}
                        </div>
                    </details>
                ))}
            </div>
        </div>
    </section>
);

// ---------------------------------------------------------------------------------------------
// Gallery

const Gallery = ({ data }: { data: WeddingPageData }) => (
    <section id="gallery" aria-labelledby="gallery-heading" className="wedding-reveal border-sandstone/40 scroll-mt-20 border-t py-20 lg:py-28">
        <div className={cx(container, "flex flex-col gap-12")}>
            <SectionHeading id="gallery-heading" eyebrow="Moments" title="A few of our favourites" align="center" />
            {/* Balanced columns keep each photo's own proportions, whatever the number of photos. */}
            <ul className={cx("gap-3 sm:gap-5", data.gallery.length === 1 ? "mx-auto max-w-3xl" : "columns-2", data.gallery.length > 2 && "lg:columns-3")}>
                {data.gallery.map((photo) => (
                    <li key={photo.id} className="mb-3 break-inside-avoid sm:mb-5">
                        <figure className="flex flex-col gap-2">
                            <Photo
                                image={photo}
                                ratio={photo.width && photo.height ? `${photo.width} / ${photo.height}` : "4 / 3"}
                                sizes="(min-width: 1024px) 33vw, 50vw"
                            />
                            {photo.caption && <figcaption className="text-sm text-tertiary italic">{photo.caption}</figcaption>}
                        </figure>
                    </li>
                ))}
            </ul>
        </div>
    </section>
);

// ---------------------------------------------------------------------------------------------
// RSVP invitation

const RsvpBand = ({ data, links }: { data: WeddingPageData; links: SiteLinks }) => (
    <section id="rsvp" aria-labelledby="rsvp-heading" className="bg-forest relative isolate scroll-mt-16 overflow-hidden px-5 py-24 sm:px-8 lg:py-32">
        <EucalyptusBranch className="text-eucalypt/35 absolute top-10 -left-24 -z-10 w-[28rem] rotate-[24deg] sm:-left-16" />
        <EucalyptusBranch flip className="text-eucalypt/30 absolute -right-24 bottom-6 -z-10 w-[30rem] rotate-[-14deg] sm:-right-16" />
        <div className="mx-auto flex max-w-2xl flex-col items-center gap-7 text-center">
            <Eyebrow className="text-sandstone">RSVP</Eyebrow>
            <h2 id="rsvp-heading" className="wedding-display text-ivory text-[2.75rem] leading-[1.05] text-balance sm:text-[3.75rem] lg:text-[4.25rem]">
                {data.content.rsvpHeading || "We hope you'll celebrate with us."}
            </h2>
            {data.rsvp.deadline && links.rsvp && (
                <p className="wedding-display text-sandstone text-[1.375rem] italic">Kindly reply by {longDate(data.rsvp.deadline)}</p>
            )}
            {data.content.rsvpText && <Prose text={data.content.rsvpText} className="text-ivory/85 max-w-lg" />}
            {links.rsvp ? (
                <>
                    <Button
                        {...rsvpLinkProps(links)}
                        size="xl"
                        className={cx(weddingButton.light, "mt-2 w-full sm:w-auto sm:px-12")}
                        iconTrailing={links.rsvpExternal ? ArrowUpRight : undefined}
                    >
                        RSVP now
                    </Button>
                    {!links.rsvpExternal && (
                        <p className="text-ivory/70 max-w-sm text-sm">Use the personal link from your invitation, or enter the code printed on it.</p>
                    )}
                </>
            ) : (
                <p className="text-ivory/80">Online replies will open soon. We'll let you know when.</p>
            )}
        </div>
    </section>
);

// ---------------------------------------------------------------------------------------------

export const HomePage = ({ data, links }: { data: WeddingPageData; links: SiteLinks }) => {
    const sections = data.content.sections.filter((s) => s.body.trim() || s.items.length || s.kind === "venue");
    const has = (kind: WebsiteSection["kind"]) => sections.some((s) => s.kind === kind);
    // The dress code sits inside "the big day", and the courtesy bus inside "getting there", when both exist.
    const dress = has("details") ? (sections.find((s) => s.kind === "dress") ?? null) : null;
    const transport = has("travel") ? (sections.find((s) => s.kind === "transport") ?? null) : null;
    const absorbed = new Set([dress?.id, transport?.id].filter(Boolean));
    const noDetails = !has("details") && data.events.length > 0;

    let feature = 0;
    const render = (section: WebsiteSection) => {
        switch (section.kind) {
            case "details":
                return <BigDay key={section.id} data={data} section={section} dress={dress} />;
            case "venue":
                return <Venue key={section.id} data={data} section={section} />;
            case "accommodation":
                return <Accommodation key={section.id} data={data} section={section} />;
            case "travel":
                return <Travel key={section.id} data={data} section={section} transport={transport} />;
            case "transport":
                return <Travel key={section.id} data={data} section={section} transport={null} />;
            case "faq":
                return section.items.length > 0 ? (
                    <Faq key={section.id} data={data} section={section} />
                ) : (
                    <Feature key={section.id} data={data} section={section} tone="ivory" />
                );
            default:
                // Children get the soft eucalyptus band; other text sections alternate quietly.
                return (
                    <Feature
                        key={section.id}
                        data={data}
                        section={section}
                        tone={section.kind === "children" || (section.kind !== "dress" && feature++ % 2 === 1) ? "eucalypt" : "ivory"}
                    />
                );
        }
    };

    return (
        <>
            <Hero data={data} links={links} />
            <Welcome data={data} />
            {noDetails && <BigDay data={data} section={{ id: "schedule", title: "The big day", body: "" }} dress={null} />}
            {sections.filter((s) => !absorbed.has(s.id)).map(render)}
            {data.gallery.length > 0 && <Gallery data={data} />}
            <RsvpBand data={data} links={links} />
        </>
    );
};
