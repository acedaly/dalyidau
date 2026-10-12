// The wedding homepage. Every section kind has its own composition so the page reads like a
// designed invitation rather than a stack of identical blocks. All copy comes from the portal
// (Website editor) and event details from the Wedding Planner; nothing here invents facts.
import { useEffect, useState } from "react";
import { ArrowDown, ArrowUpRight, Heart } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { formatDate, formatTime } from "@/portal/lib/format";
import type { PublicEvent, WebsiteItem, WebsiteSection, WeddingPageData } from "@/shared/portal/types";
import { cx } from "@/utils/cx";
import { EucalyptusBranch, Landscape, Sprig, Stamp } from "@/wedding/components/ornament";
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
    transport: "Transport",
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
    const photo = data.heroImage;
    const [place, ...rest] = details.location.split(/\s*[·,]\s*/);
    // Over a photograph everything is ivory; on the illustrated fallback it uses the leaf green.
    const onPhoto = !!photo;
    return (
        <section id="hero" aria-labelledby="names" className="relative isolate overflow-hidden">
            <div className="relative flex min-h-[min(88svh,52rem)] flex-col items-center justify-center">
                {photo ? (
                    <>
                        <img
                            src={photo.url}
                            alt={photo.alt}
                            width={photo.width ?? undefined}
                            height={photo.height ?? undefined}
                            fetchPriority="high"
                            decoding="async"
                            className="wedding-fade absolute inset-0 -z-20 size-full object-cover"
                        />
                        {/* A soft vignette keeps the lettering legible over any photo. */}
                        <div
                            aria-hidden="true"
                            className="absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_50%_45%,rgb(24_32_22/0.42),rgb(24_32_22/0.18)_55%,rgb(24_32_22/0.45))]"
                        />
                    </>
                ) : (
                    <>
                        <div aria-hidden="true" className="absolute inset-x-0 bottom-0 -z-10 h-[24%] sm:h-[36%]">
                            <Landscape variant="wide" sky={false} className="absolute inset-0" />
                        </div>
                        <EucalyptusBranch draw className="text-eucalypt absolute -top-4 -left-16 w-72 rotate-[14deg] sm:w-96" />
                        <EucalyptusBranch draw flip className="text-eucalypt absolute -top-6 -right-16 w-72 rotate-[-12deg] max-sm:hidden sm:w-96" />
                    </>
                )}

                <div className="wedding-rise relative flex flex-col items-center px-5 pt-20 pb-28 text-center sm:pb-32">
                    {content.heroEyebrow && <Eyebrow className={onPhoto ? "text-ivory/90" : undefined}>{content.heroEyebrow}</Eyebrow>}
                    <h1
                        id="names"
                        className={cx(
                            "wedding-script mt-6 text-[clamp(4.5rem,15vw,10rem)] leading-[0.95]",
                            onPhoto ? "text-ivory [text-shadow:0_2px_24px_rgb(0_0_0/0.35)]" : "text-leaf",
                        )}
                    >
                        {names ? (
                            <>
                                <span className="inline-block">{names[0]}</span> <span className="inline-block">&amp;</span>{" "}
                                <span className="inline-block">{names[1]}</span>
                            </>
                        ) : (
                            content.heroTitle
                        )}
                    </h1>
                    {content.heroSubtitle && (
                        <p className={cx("wedding-display mt-5 text-[1.75rem] sm:text-[2.125rem]", onPhoto ? "text-ivory" : "text-forest")}>
                            {content.heroSubtitle}
                        </p>
                    )}
                    {details.date && (
                        <p
                            className={cx(
                                "wedding-display mt-4 text-[1.375rem] italic sm:text-[1.625rem]",
                                onPhoto ? "text-ivory/95 [text-shadow:0_1px_12px_rgb(0_0_0/0.35)]" : "text-charcoal",
                            )}
                        >
                            <time dateTime={details.date}>{longDate(details.date)}</time>
                        </p>
                    )}
                    {details.location && (
                        <p className={cx("wedding-eyebrow mt-3", onPhoto ? "text-ivory/90" : "text-olive-600")}>
                            {place}
                            {rest.length > 0 && (
                                <>
                                    <span aria-hidden="true"> · </span>
                                    {rest.join(", ")}
                                </>
                            )}
                        </p>
                    )}

                    <div className="mt-10 flex w-full flex-col items-center gap-6 sm:w-auto sm:flex-row sm:gap-8">
                        {links.rsvp && (
                            <Button
                                {...rsvpLinkProps(links)}
                                size="xl"
                                className={cx(onPhoto ? weddingButton.light : weddingButton.primary, "w-full sm:w-auto sm:px-12")}
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
                                onPhoto && "text-ivory decoration-ivory/50 hover:decoration-ivory",
                            )}
                        >
                            Explore our wedding
                            <ArrowDown className="size-4" aria-hidden="true" />
                        </a>
                    </div>
                </div>
            </div>
            {photo?.caption && <p className="sr-only">{photo.caption}</p>}
        </section>
    );
};

// ---------------------------------------------------------------------------------------------
// Countdown, as on the Say I Do site

/** Converts a wall-clock time in a time zone (e.g. 2:00 pm in Sydney, daylight saving included) to a timestamp. */
const zonedTime = (local: string, timeZone: string) => {
    const guess = Date.parse(`${local}:00Z`);
    const offset = (t: number) => {
        const parts = new Intl.DateTimeFormat("en-US", {
            timeZone,
            hourCycle: "h23",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
        }).formatToParts(new Date(t));
        const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
        return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - t;
    };
    return guess - offset(guess - offset(guess));
};

/** Years, months, days, hours, minutes and seconds until `to`, counting whole calendar months first. */
const breakdown = (from: number, to: number) => {
    if (to <= from) return null;
    const addMonths = (n: number) => {
        const d = new Date(from);
        d.setUTCMonth(d.getUTCMonth() + n);
        return d.getTime();
    };
    let months = 0;
    while (addMonths(months + 1) <= to) months++;
    let rest = Math.floor((to - addMonths(months)) / 1000);
    const days = Math.floor(rest / 86_400);
    rest -= days * 86_400;
    const hours = Math.floor(rest / 3600);
    rest -= hours * 3600;
    const minutes = Math.floor(rest / 60);
    return { years: Math.floor(months / 12), months: months % 12, days, hours, minutes, seconds: rest - minutes * 60 };
};

const COUNTDOWN_UNITS = ["years", "months", "days", "hours", "minutes", "seconds"] as const;

const CountdownBand = ({ data }: { data: WeddingPageData }) => {
    const { date, timeZone } = data.details;
    // The first timed event (the ceremony) is the moment we count down to; otherwise midnight.
    const start = data.events.find((e) => e.startsAt && e.startsAt.slice(0, 10) === date && e.startsAt.length >= 16)?.startsAt ?? `${date}T00:00`;
    const [left, setLeft] = useState<ReturnType<typeof breakdown> | undefined>(undefined);
    useEffect(() => {
        // Runs only in the browser, so the server render never disagrees with the visitor's clock.
        const target = zonedTime(start.slice(0, 16), timeZone);
        const tick = () => setLeft(breakdown(Date.now(), target));
        tick();
        const timer = window.setInterval(tick, 1000);
        return () => window.clearInterval(timer);
    }, [start, timeZone]);
    if (!date || left === null) return null;
    const totalDays = left ? Math.ceil((zonedTime(start.slice(0, 16), timeZone) - Date.now()) / 86_400_000) : null;
    return (
        <section aria-label="Countdown to the wedding" className="border-sandstone/50 bg-paper border-b px-5 py-10 sm:py-12">
            {totalDays !== null && <p className="sr-only">{totalDays.toLocaleString("en-AU")} days to go</p>}
            <ol aria-hidden="true" className="mx-auto grid max-w-3xl grid-cols-3 gap-x-4 gap-y-7 sm:grid-cols-6">
                {COUNTDOWN_UNITS.map((unit) => (
                    <li key={unit} className="flex flex-col items-center gap-1">
                        <span className="wedding-script text-leaf text-[2.75rem] tabular-nums sm:text-[3.25rem]">{left ? left[unit] : "–"}</span>
                        <span className="wedding-eyebrow text-[0.6875rem] text-olive-600">{left && left[unit] === 1 ? unit.slice(0, -1) : unit}</span>
                    </li>
                ))}
            </ol>
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
                            <div className="border-sandstone/60 flex flex-col items-center gap-1 border px-10 pt-8 pb-9 text-center sm:px-14">
                                <p className="wedding-eyebrow text-olive-600">{formatDate(details.date, { weekday: "long" })}</p>
                                <p className="wedding-display text-forest text-[6.5rem] leading-[0.95] font-[350]">
                                    {formatDate(details.date, { day: "numeric" })}
                                </p>
                                <p className="wedding-display text-forest text-[1.625rem]">{formatDate(details.date, { month: "long", year: "numeric" })}</p>
                                <span aria-hidden="true" className="bg-clay/60 mt-3 h-px w-10" />
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
                                            <p className="text-charcoal">
                                                <span className="wedding-eyebrow mr-2 text-[0.6875rem] text-olive-600">Attire</span>
                                                {event.dressCode}
                                            </p>
                                        )}
                                        {event.address && (
                                            <a
                                                href={`https://maps.google.com/maps?q=${encodeURIComponent(event.address)}`}
                                                {...external}
                                                className={cx(
                                                    weddingButton.link,
                                                    "mt-1 inline-flex items-center gap-1.5 self-start outline-focus-ring focus-visible:outline-2 focus-visible:outline-offset-4",
                                                )}
                                            >
                                                Get directions
                                                <ArrowUpRight className="size-4" aria-hidden="true" />
                                                <span className="sr-only">(opens in a new tab)</span>
                                            </a>
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
        <section id={section.id} aria-labelledby={`${section.id}-heading`} className="wedding-reveal relative isolate scroll-mt-20">
            {/* On large screens the photo fills the section and the panel sits in normal flow, so long text grows the section instead of spilling out. */}
            <div className="relative -z-10 aspect-[4/3] sm:aspect-[16/9] lg:absolute lg:inset-0 lg:aspect-auto">
                <Photo image={image} shape="none" fallback="wide" sizes="100vw" className="absolute inset-0 rounded-none" />
            </div>
            <div className={cx(container, "lg:flex lg:items-center lg:py-16", image ? "lg:min-h-[min(88vh,52rem)]" : "lg:min-h-[38rem]")}>
                <div className="relative -mt-16 sm:-mt-24 lg:mt-0 lg:w-[31rem]">
                    <div className="bg-paper p-2 shadow-[0_30px_60px_-30px_rgb(36_54_43/0.5)]">
                        <div className="border-sandstone/70 flex flex-col gap-6 border px-6 py-9 sm:px-10 sm:py-11">
                            <SectionHeading id={`${section.id}-heading`} eyebrow={EYEBROWS.venue} title={section.title} size="md" />
                            {section.body && <Prose text={section.body} className="text-charcoal" />}
                            {section.items.length > 0 && (
                                <dl className="border-sandstone/60 flex flex-col gap-4 border-t pt-6">
                                    {section.items.map((item, i) => (
                                        <div key={i} className="flex flex-col gap-1">
                                            <dt className="wedding-eyebrow text-[0.6875rem] text-olive-600">{item.title}</dt>
                                            {item.body && (
                                                <dd className="wedding-prose text-charcoal">
                                                    {item.url ? (
                                                        <a
                                                            href={item.url}
                                                            {...external}
                                                            className="decoration-forest/30 hover:decoration-forest rounded-sm underline underline-offset-4 outline-focus-ring focus-visible:outline-2"
                                                        >
                                                            {item.body}
                                                            <span className="sr-only"> (opens in a new tab)</span>
                                                        </a>
                                                    ) : (
                                                        item.body
                                                    )}
                                                </dd>
                                            )}
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
                                    aria-label="Get directions (opens in a new tab)"
                                >
                                    Get directions
                                </Button>
                            )}
                        </div>
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
    const sectionImage = section.imageId ? data.sectionImages[section.imageId] : null;
    const couple = `${data.details.partnerOne} & ${data.details.partnerTwo}`;
    return (
        <section id={section.id} aria-labelledby={`${section.id}-heading`} className="wedding-reveal bg-sandstone-light/80 scroll-mt-20 py-20 lg:py-28">
            <div className={cx(container, "grid grid-cols-1 gap-12 lg:grid-cols-12 lg:gap-10")}>
                <div className="flex flex-col gap-8 lg:col-span-5">
                    <SectionHeading id={`${section.id}-heading`} eyebrow={EYEBROWS.accommodation} title={section.title} />
                    {section.body && <Prose text={section.body} className="text-charcoal max-w-md" />}
                    <Stamp text="Limited · first come, first served · " className="size-32 rotate-[-8deg] max-lg:hidden">
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

                {section.items.length > 0 && (
                    <ul className="flex flex-col gap-6 lg:col-span-7">
                        {section.items.map((item, i) => {
                            // The section photo belongs to the first place (Rhino Lodge) unless it has its own.
                            const image = (item.imageId && data.sectionImages[item.imageId]) || (i === 0 ? sectionImage : null);
                            return (
                                <li key={i} className="bg-paper p-2 shadow-[0_24px_50px_-30px_rgb(36_54_43/0.35)]">
                                    <article className={cx("border-sandstone/60 grid h-full border", image && "sm:grid-cols-[2fr_3fr]")}>
                                        {image && (
                                            <Photo
                                                image={image}
                                                shape="none"
                                                className="aspect-[16/10] rounded-none sm:aspect-auto sm:h-full"
                                                sizes="(min-width: 640px) 300px, 100vw"
                                            />
                                        )}
                                        <div className="flex flex-col gap-3 px-6 py-7 sm:px-8 sm:py-8">
                                            {item.detail && <Eyebrow className="text-clay-600">{item.detail}</Eyebrow>}
                                            <h3 className="wedding-display text-forest text-[1.875rem] leading-tight sm:text-[2.125rem]">{item.title}</h3>
                                            <p className="flex items-center gap-1.5 text-sm text-olive-600">
                                                <Heart className="size-4" aria-hidden="true" />
                                                Recommended by {couple}
                                            </p>
                                            {item.body && <Prose text={item.body} className="text-charcoal max-w-xl text-[1rem]" />}
                                            <ItemLink item={item} label={i === 0 ? "Book or enquire" : "Visit website"} />
                                        </div>
                                    </article>
                                </li>
                            );
                        })}
                    </ul>
                )}
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
            <div className="flex flex-col gap-6 lg:sticky lg:top-28 lg:col-span-5 lg:self-start">
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
            <div className="wedding-faq border-sandstone border-t lg:col-span-7 lg:col-start-6 lg:mt-3">
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
        <EucalyptusBranch className="text-eucalypt/35 absolute -top-6 -left-28 -z-10 w-72 rotate-[24deg] sm:top-10 sm:-left-16 sm:w-[28rem]" />
        <EucalyptusBranch flip className="text-eucalypt/30 absolute -right-24 bottom-6 -z-10 w-[30rem] rotate-[-14deg] max-sm:hidden sm:-right-16" />
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
            <CountdownBand data={data} />
            <Welcome data={data} />
            {noDetails && <BigDay data={data} section={{ id: "schedule", title: "The big day", body: "" }} dress={null} />}
            {sections.filter((s) => !absorbed.has(s.id)).map(render)}
            {data.gallery.length > 0 && <Gallery data={data} />}
            <RsvpBand data={data} links={links} />
        </>
    );
};
