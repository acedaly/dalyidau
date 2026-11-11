// The wedding homepage. All copy comes from the portal (Website editor) and event details from the
// wedding events; nothing here invents facts. The page reads: an invitation hero (the card beside our
// note, the key facts, the countdown and the RSVP), "The day" (schedule and venue), "Stay & travel"
// (accommodation and the courtesy bus), any other sections in the portal's order, the FAQ, the
// gallery and the RSVP finale. How sections are grouped lives in home-sections.ts.
import { type ReactNode, useEffect, useState } from "react";
import { ArrowUpRight, Bus, Mail01, Moon02 } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { formatDate, formatTime } from "@/portal/lib/format";
import type { PublicEvent, WebsiteItem, WebsiteSection, WeddingPageData } from "@/shared/portal/types";
import { isOnSite } from "@/shared/portal/website-suggestions";
import { cx } from "@/utils/cx";
import { EucalyptusBranch, SignatureBotanicals, Sprig } from "@/wedding/components/ornament";
import { Eyebrow, Photo, Prose, SectionHeading, longDate, paragraphs, shortDate, weddingButton } from "@/wedding/components/ui";
import { DAY_ID, type HomeLayout, STAY_ID, homeLayout, isMerged } from "@/wedding/home-sections";
import { type SiteLinks, rsvpLinkProps } from "@/wedding/site-chrome";

const container = "mx-auto w-full max-w-7xl px-5 sm:px-8 lg:px-10";
/** Section spacing: 72px on phones, 112px on desktop. */
const sectionPad = "py-18 lg:py-28";

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

const ItemLink = ({ item, label, className }: { item: WebsiteItem; label: string; className?: string }) =>
    item.url ? (
        <a
            href={item.url}
            {...external}
            className={cx(
                weddingButton.link,
                "inline-flex items-center gap-1.5 self-start outline-focus-ring focus-visible:outline-2 focus-visible:outline-offset-4",
                className,
            )}
        >
            {label}
            <ArrowUpRight className="size-4" aria-hidden="true" />
            <span className="sr-only">(opens in a new tab)</span>
        </a>
    ) : null;

/** Empty anchors for the ids a merged section used to have, so old links still land on it. */
const Anchors = ({ ids }: { ids: string[] }) => (
    <>
        {ids.map((id) => (
            <span key={id} id={id} aria-hidden="true" className="block scroll-mt-20" />
        ))}
    </>
);

/** Eyebrow and a large serif heading on the left, the introduction on the right. */
const HeadingRow = ({ id, eyebrow, title, children }: { id: string; eyebrow: string; title: string; children?: ReactNode }) => (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 lg:items-end lg:gap-16">
        <SectionHeading id={id} eyebrow={eyebrow} title={title} />
        {children && <div className="flex max-w-xl flex-col gap-4 lg:pb-3">{children}</div>}
    </div>
);

// ---------------------------------------------------------------------------------------------
// Hero

/** "Amelia & Aidan" from the custom title when it has two names, otherwise from Wedding settings. */
const coupleNames = (data: WeddingPageData): [string, string] | null => {
    const title = data.content.heroTitle.trim();
    if (!title) return [data.details.partnerOne, data.details.partnerTwo];
    const parts = title.split(/\s+(?:&|and|\+)\s+/i);
    return parts.length === 2 ? [parts[0], parts[1]] : null;
};

/**
 * The watercolour frame's top (banksia, wattle) or bottom (waratah) as a band sized to the card's width, fading into the
 * paper, so the florals frame the invitation on phones and tablets without sitting behind any text.
 */
const FrameBand = ({ edge }: { edge: "top" | "bottom" }) => (
    <div
        aria-hidden="true"
        className={cx(
            "relative -z-10 shrink-0 overflow-hidden min-[900px]:hidden",
            edge === "top"
                ? "aspect-[2/1] [mask-image:linear-gradient(to_bottom,black_62%,transparent)] sm:aspect-[5/2]"
                : "aspect-[2/1] [mask-image:linear-gradient(to_top,black_62%,transparent)] sm:aspect-[5/2]",
        )}
    >
        <img
            src="/wedding/native-invitation-frame.jpg"
            alt=""
            width="1122"
            height="1402"
            fetchPriority={edge === "top" ? "high" : undefined}
            decoding="async"
            className={cx("size-full object-cover", edge === "top" ? "object-top" : "object-bottom")}
        />
    </div>
);

/** The printed invitation: the painted frame with "Together with our families", our names and "We're getting married". */
const InvitationCard = ({ data }: { data: WeddingPageData }) => {
    const { content } = data;
    const names = coupleNames(data);
    return (
        <article
            className="border-tan/45 bg-ivory shadow-forest/15 relative isolate mx-auto flex w-full max-w-[28rem] flex-col overflow-hidden border shadow-[0_28px_80px_-34px_currentColor] min-[900px]:aspect-[1122/1402] min-[900px]:max-w-none min-[900px]:justify-center"
            data-testid="hero-card"
        >
            {/* Desktop: the whole painted frame, with the wording in its open centre. */}
            <img
                src="/wedding/native-invitation-frame.jpg"
                alt=""
                aria-hidden="true"
                width="1122"
                height="1402"
                fetchPriority="high"
                decoding="async"
                className="absolute inset-0 -z-10 hidden size-full object-cover min-[900px]:block"
            />
            <FrameBand edge="top" />
            <div className="flex flex-col items-center px-6 py-2 text-center min-[900px]:mx-[8%] min-[900px]:bg-[radial-gradient(closest-side,rgb(245_240_231/0.92),rgb(245_240_231/0.6)_70%,transparent)] min-[900px]:px-[6%] min-[900px]:py-10">
                {content.heroEyebrow && <Eyebrow className="text-forest/80 text-[0.62rem] sm:text-[0.7rem]">{content.heroEyebrow}</Eyebrow>}
                <h1 id="names" className="wedding-names text-forest mt-5 text-[clamp(4.25rem,18vw,6rem)] min-[900px]:text-[clamp(3.6rem,5.4vw,5.25rem)]">
                    {names ? (
                        <>
                            <span className="block pr-[0.35em]">{names[0]}</span> <span className="text-leaf block pl-[0.28em]">&amp; {names[1]}</span>
                        </>
                    ) : (
                        content.heroTitle
                    )}
                </h1>
                {content.heroSubtitle && (
                    <p className="wedding-display text-leaf mt-6 text-[1.25rem] italic min-[900px]:mt-7 sm:text-[1.4rem]">{content.heroSubtitle}</p>
                )}
            </div>
            <FrameBand edge="bottom" />
        </article>
    );
};

const firstTimedEvent = (data: WeddingPageData) =>
    data.events.find((e) => e.startsAt && e.startsAt.slice(0, 10) === data.details.date && e.startsAt.length >= 16) ?? null;

/** "Ceremony & reception" from the event names. */
const joinNames = (names: string[]) =>
    names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} & ${names.at(-1)!.charAt(0).toLowerCase()}${names.at(-1)!.slice(1)}`;

/** When, where, dress and reply-by, each from the wedding settings, events and RSVP settings. */
const heroFacts = (data: WeddingPageData, links: SiteLinks, place: string, rest: string[]) => {
    const { details, events } = data;
    const facts: { label: string; value: string; note: string }[] = [];
    if (details.date) {
        const timed = firstTimedEvent(data);
        const weekday = formatDate(details.date, { weekday: "long" });
        facts.push({
            label: "When",
            value: shortDate(details.date),
            note: timed ? `${weekday} · ${timed.name} ${formatTime(timed.startsAt)}` : `${weekday} · Time TBC`,
        });
    }
    if (place) facts.push({ label: "Where", value: place, note: rest.join(", ") });
    const dressed = events.filter((e) => e.dressCode?.trim());
    if (dressed.length > 0) {
        const code = dressed[0].dressCode!.trim();
        const same = dressed.filter((e) => e.dressCode!.trim().toLowerCase() === code.toLowerCase());
        facts.push({ label: "Dress", value: code, note: joinNames(same.map((e) => e.name)) });
    }
    if (data.rsvp.deadline && links.rsvp) {
        facts.push({ label: "Reply by", value: shortDate(data.rsvp.deadline), note: `${formatDate(data.rsvp.deadline, { weekday: "long" })} · RSVP online` });
    }
    return facts;
};

const Hero = ({ data, links, dayId }: { data: WeddingPageData; links: SiteLinks; dayId: string | null }) => {
    const { details, content } = data;
    const photo = data.heroImage;
    const [place = "", ...rest] = details.location.split(/\s*[·,]\s*/).filter(Boolean);
    const [lead, ...more] = paragraphs(content.welcome);
    const eyebrow = [details.date && longDate(details.date), [place, rest[0]].filter(Boolean).join(", ")].filter(Boolean).join(" · ");
    const facts = heroFacts(data, links, place, rest);

    return (
        <section
            id="hero"
            aria-labelledby="names"
            className="bg-sandstone relative isolate overflow-hidden px-4 py-10 min-[900px]:py-16 sm:px-8 sm:py-14 lg:px-10 lg:py-20"
            data-testid="wedding-hero"
        >
            {photo && (
                <>
                    <img
                        src={photo.url}
                        alt={photo.alt}
                        width={photo.width ?? undefined}
                        height={photo.height ?? undefined}
                        fetchPriority="high"
                        decoding="async"
                        className="wedding-fade absolute inset-0 -z-20 size-full scale-105 object-cover opacity-25 saturate-[.72]"
                        style={{ objectPosition: `${content.heroFocalX}% ${content.heroFocalY}%` }}
                    />
                    <span
                        aria-hidden="true"
                        className="absolute inset-0 -z-10 bg-[linear-gradient(90deg,rgb(234_225_211/0.9),rgb(234_225_211/0.8),rgb(234_225_211/0.9))]"
                    />
                </>
            )}

            <div className="wedding-rise mx-auto grid w-full max-w-7xl grid-cols-1 gap-12 min-[900px]:grid-cols-[5fr_6fr] min-[900px]:items-center min-[900px]:gap-12 lg:gap-18">
                <InvitationCard data={data} />

                <div id="welcome" className="flex scroll-mt-24 flex-col" data-testid="hero-copy">
                    {eyebrow && <Eyebrow className="text-clay-600 text-[0.66rem] sm:text-[0.72rem]">{eyebrow}</Eyebrow>}
                    {lead && (
                        <div className="mt-6 flex flex-col gap-4">
                            <p className="wedding-display text-forest text-[1.85rem] leading-[1.18] text-pretty sm:text-[2.15rem] lg:text-[2.4rem]">{lead}</p>
                            {more.length > 0 && <Prose text={more.join("\n\n")} className="text-charcoal max-w-xl" />}
                            <p className="wedding-display text-leaf text-[1.4rem] italic sm:text-[1.55rem]">
                                {details.partnerOne} &amp; {details.partnerTwo}
                            </p>
                        </div>
                    )}

                    {facts.length > 0 && (
                        <dl className="border-forest/20 mt-9 grid grid-cols-2 border-b">
                            {facts.map((fact, i) => (
                                <div
                                    key={fact.label}
                                    className={cx("border-forest/20 flex flex-col gap-1 border-t py-4", i % 2 === 0 ? "pr-4" : "border-l pl-4 sm:pl-6")}
                                >
                                    <dt className="wedding-eyebrow text-[0.62rem] text-olive-600">{fact.label}</dt>
                                    <dd className="wedding-display text-forest text-[1.3rem] leading-tight sm:text-[1.5rem]">{fact.value}</dd>
                                    {fact.note && <dd className="text-[0.8125rem] leading-snug text-tertiary">{fact.note}</dd>}
                                </div>
                            ))}
                        </dl>
                    )}

                    <Countdown data={data} />

                    <div className="mt-8 flex flex-col gap-3 min-[420px]:flex-row min-[420px]:items-center sm:gap-4">
                        {links.rsvp && (
                            <Button
                                {...rsvpLinkProps(links)}
                                size="lg"
                                className={cx(weddingButton.primary, "justify-center sm:px-9")}
                                iconTrailing={links.rsvpExternal ? ArrowUpRight : undefined}
                            >
                                RSVP now
                            </Button>
                        )}
                        {dayId && (
                            <Button href={`#${dayId}`} size="lg" className={cx(weddingButton.outline, "justify-center sm:px-9")}>
                                The day
                            </Button>
                        )}
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

/** Days, hours, minutes and seconds until `to`. A single day count is easier for guests to parse. */
const breakdown = (from: number, to: number) => {
    if (to <= from) return null;
    let rest = Math.floor((to - from) / 1000);
    const days = Math.floor(rest / 86_400);
    rest -= days * 86_400;
    const hours = Math.floor(rest / 3600);
    rest -= hours * 3600;
    const minutes = Math.floor(rest / 60);
    return { days, hours, minutes, seconds: rest - minutes * 60 };
};

const COUNTDOWN_UNITS = ["days", "hours", "minutes", "seconds"] as const;

/** A compact four-column countdown under the hero's facts. It disappears once the moment has passed. */
const Countdown = ({ data }: { data: WeddingPageData }) => {
    const { date, timeZone } = data.details;
    // The first timed event (the ceremony) is the moment we count down to; otherwise midnight.
    const start = firstTimedEvent(data)?.startsAt ?? `${date}T00:00`;
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
        <section aria-label="Countdown to the wedding" className="border-forest/20 border-b py-4" data-testid="countdown">
            {totalDays !== null && <p className="sr-only">{totalDays.toLocaleString("en-AU")} days to go</p>}
            <ol aria-hidden="true" className="grid grid-cols-4 gap-2">
                {COUNTDOWN_UNITS.map((unit) => (
                    <li key={unit} className="flex flex-col gap-1">
                        <span className="wedding-display text-forest text-[1.75rem] leading-none lining-nums tabular-nums sm:text-[2rem]" data-unit={unit}>
                            {left ? left[unit] : "–"}
                        </span>
                        <span className="wedding-eyebrow text-[0.56rem] text-olive-600 max-[359px]:tracking-[0.12em]! sm:text-[0.6rem]">
                            {left && left[unit] === 1 ? unit.slice(0, -1) : unit}
                        </span>
                    </li>
                ))}
            </ol>
        </section>
    );
};

// ---------------------------------------------------------------------------------------------
// The day: the schedule beside the venue

const eventTime = (event: PublicEvent) => {
    if (!event.startsAt || event.startsAt.length < 16) return null;
    const end = event.endsAt && event.endsAt.slice(0, 10) === event.startsAt.slice(0, 10) ? formatTime(event.endsAt) : "";
    return `${formatTime(event.startsAt)}${end ? ` – ${end}` : ""}`;
};

const mapsUrl = (address: string) => `https://maps.google.com/maps?q=${encodeURIComponent(address)}`;
const isMapLink = (url: string) => /(^|\/\/)(www\.)?(maps\.|goo\.gl\/maps|maps\.app\.goo\.gl)|google\.[a-z.]+\/maps/i.test(url);

const Timeline = ({ data, venueName }: { data: WeddingPageData; venueName: string }) => {
    const { details, events } = data;
    const row = "border-forest/20 grid grid-cols-[6.25rem_1fr] gap-x-5 border-b py-7 sm:grid-cols-[9rem_1fr] sm:gap-x-8";
    const time = "wedding-display text-leaf pt-1 text-[1.3rem] leading-tight sm:text-[1.5rem]";
    if (events.length === 0)
        return (
            <div className={cx(row, "border-t")}>
                <p className={time}>Time TBC</p>
                <div className="flex flex-col gap-2">
                    <h3 className="wedding-display text-forest text-[1.75rem] leading-tight">To be confirmed</h3>
                    <p className="text-tertiary">We'll post the order of the day here once it's set.</p>
                </div>
            </div>
        );
    return (
        <ol className="border-forest/20 border-t" data-testid="timeline">
            {events.map((event) => {
                const where = event.venueName && event.venueName !== venueName ? event.venueName : "";
                const meta = [where, event.dressCode && `Dress: ${event.dressCode}`].filter(Boolean).join(" · ");
                return (
                    <li key={event.id} className={row}>
                        <p className={time}>{eventTime(event) ?? "Time TBC"}</p>
                        <div className="flex flex-col gap-2">
                            <h3 className="wedding-display text-forest text-[1.75rem] leading-tight sm:text-[2rem]">{event.name}</h3>
                            {event.startsAt && event.startsAt.slice(0, 10) !== details.date && (
                                <p className="text-sm text-tertiary">{longDate(event.startsAt.slice(0, 10))}</p>
                            )}
                            {event.description && <Prose text={event.description} className="text-charcoal max-w-lg text-[1rem]" />}
                            {meta && <p className="text-[0.9375rem] text-tertiary">{meta}</p>}
                        </div>
                    </li>
                );
            })}
        </ol>
    );
};

const VenueCard = ({ data, venue }: { data: WeddingPageData; venue: WebsiteSection }) => {
    const image = venue.imageId ? data.sectionImages[venue.imageId] : null;
    const addressItem = venue.items.find((item) => /address/i.test(item.title));
    const address = addressItem?.body || data.events.find((e) => e.address)?.address || "";
    const mapItem = venue.items.find((item) => item.url && isMapLink(item.url)) ?? (addressItem?.url ? addressItem : undefined);
    const directions = mapItem?.url || (address ? mapsUrl(address) : "");
    const websiteItem = venue.items.find((item) => item !== mapItem && item.url && !isMapLink(item.url));
    const others = venue.items.filter((item) => item !== addressItem && item !== websiteItem && item !== mapItem);
    return (
        <article className="bg-paper border-sandstone flex flex-col overflow-hidden border" data-testid="venue-card">
            {image && <Photo image={image} shape="none" className="aspect-[4/3] rounded-none" sizes="(min-width: 1024px) 480px, 100vw" />}
            <div className="flex flex-col gap-5 px-6 py-8 sm:px-9 sm:py-10">
                <Eyebrow className="text-clay-600">{EYEBROWS.venue}</Eyebrow>
                <h3 className="wedding-display text-forest -mt-1 text-[2.25rem] leading-[1.05] sm:text-[2.6rem]">{venue.title}</h3>
                {venue.body && <Prose text={venue.body} className="text-charcoal text-[1rem]" />}
                {(address || others.length > 0) && (
                    <dl className="border-sandstone flex flex-col gap-4 border-t pt-5">
                        {address && (
                            <div className="flex flex-col gap-1">
                                <dt className="wedding-eyebrow text-[0.6875rem] text-olive-600">{addressItem?.title || "Address"}</dt>
                                <dd className="text-charcoal">{address}</dd>
                            </div>
                        )}
                        {others.map((item, i) => (
                            <div key={i} className="flex flex-col gap-1">
                                <dt className="wedding-eyebrow text-[0.6875rem] text-olive-600">{item.title}</dt>
                                {item.body && <dd className="text-charcoal">{item.body}</dd>}
                            </div>
                        ))}
                    </dl>
                )}
                {(directions || websiteItem) && (
                    <div className="mt-1 flex flex-col gap-3 min-[420px]:flex-row min-[420px]:flex-wrap">
                        {directions && (
                            <Button href={directions} {...external} className={cx(weddingButton.primary, "justify-center")} iconTrailing={ArrowUpRight}>
                                Directions<span className="sr-only"> (opens in a new tab)</span>
                            </Button>
                        )}
                        {websiteItem && (
                            <Button href={websiteItem.url} {...external} className={cx(weddingButton.outline, "justify-center")} iconTrailing={ArrowUpRight}>
                                Website<span className="sr-only"> (opens in a new tab)</span>
                            </Button>
                        )}
                    </div>
                )}
            </div>
        </article>
    );
};

const TheDay = ({ data, day }: { data: WeddingPageData; day: NonNullable<HomeLayout["day"]> }) => {
    const { details, venue, dress } = day;
    return (
        <section id={DAY_ID} aria-labelledby={`${DAY_ID}-heading`} className={cx("wedding-reveal scroll-mt-20", sectionPad)}>
            <Anchors ids={day.anchors} />
            <div className={container}>
                <HeadingRow id={`${DAY_ID}-heading`} eyebrow="The day" title={details?.title || "The big day"}>
                    {details?.body && <Prose text={details.body} className="text-charcoal" />}
                </HeadingRow>
                <div className={cx("mt-12 grid grid-cols-1 items-start gap-12 lg:mt-16 lg:gap-16", venue && "lg:grid-cols-[7fr_5fr]")}>
                    <div className="flex flex-col gap-12">
                        <Timeline data={data} venueName={venue?.title ?? ""} />
                        {dress && (
                            <div>
                                <Eyebrow>{EYEBROWS.dress}</Eyebrow>
                                <h3 className="wedding-display text-forest mt-3 text-[1.875rem]">{dress.title}</h3>
                                {dress.body && <Prose text={dress.body} className="text-charcoal mt-4 max-w-lg" />}
                            </div>
                        )}
                    </div>
                    {venue && <VenueCard data={data} venue={venue} />}
                </div>
            </div>
        </section>
    );
};

// ---------------------------------------------------------------------------------------------
// Stay & travel: a card for each place to stay, then the courtesy bus in ink

/** "On site · limited" for the on-site stay; "5.2 km · our pick" for places in town. */
const stayTag = (item: WebsiteItem, onSite: boolean) => {
    if (onSite) return "On site · limited";
    const distance = /\d[\d.,]*\s?k?m\b/i.exec(item.detail)?.[0];
    return distance ? `${distance} · our pick` : item.detail || "Our pick";
};

/** "Getting home" reads as the evening trip; anything else as the trip out. */
const busIcon = (title: string) => (/home|return|back/i.test(title) ? Moon02 : Bus);

const card = "bg-paper border-forest/15 flex flex-col overflow-hidden border";
const cardBody = "flex flex-1 flex-col gap-4 px-6 py-7 sm:px-8 sm:py-8";
const cardTag = "wedding-eyebrow text-clay-600 text-[0.64rem]";
const cardTitle = "wedding-display text-forest text-[1.9rem] leading-[1.08] sm:text-[2.1rem]";

const StayAndTravel = ({ data, stay, links }: { data: WeddingPageData; stay: NonNullable<HomeLayout["stay"]>; links: SiteLinks }) => {
    const { accommodation, travel, transport } = stay;
    const contact = data.content.contactEmail.trim();
    const sectionImage = accommodation?.imageId ? data.sectionImages[accommodation.imageId] : null;
    const places = (accommodation?.items ?? []).map((item, i, items) => ({ item, onSite: isOnSite(item, i, items) }));
    // The section photo belongs to the on-site stay (or the first place when none is on site) unless it has its own.
    const photoOwner = places.findIndex((p) => p.onSite) === -1 ? 0 : places.findIndex((p) => p.onSite);
    const imageFor = (item: WebsiteItem, i: number) => (item.imageId && data.sectionImages[item.imageId]) || (i === photoOwner ? sectionImage : null);
    const lead = accommodation ?? travel ?? transport!;
    // The transport section's words stay in its own card, so it only gives the heading when it is all there is.
    const intro = [lead !== transport ? lead.body : "", travel && travel !== lead ? travel.body : ""].filter(Boolean).join("\n\n");
    const travelImage = travel?.imageId ? data.sectionImages[travel.imageId] : null;
    const transportImage = transport?.imageId ? data.sectionImages[transport.imageId] : null;

    return (
        <section id={STAY_ID} aria-labelledby={`${STAY_ID}-heading`} className={cx("wedding-reveal bg-eucalypt-light scroll-mt-20", sectionPad)}>
            <Anchors ids={stay.anchors} />
            <div className={container}>
                <HeadingRow id={`${STAY_ID}-heading`} eyebrow="Stay & travel" title={lead.title}>
                    {intro && <Prose text={intro} className="text-charcoal" />}
                </HeadingRow>
                <ul className="mt-12 grid grid-cols-1 gap-5 md:grid-cols-2 lg:mt-16 lg:grid-cols-3 lg:gap-6" data-testid="stay-cards">
                    {places.map(({ item, onSite }, i) => {
                        const image = imageFor(item, i);
                        return (
                            <li key={`stay-${i}`} className={card} data-testid={onSite ? "onsite-stay" : "town-stay"}>
                                {image && <Photo image={image} shape="none" className="aspect-[16/10] rounded-none" sizes="(min-width: 1024px) 400px, 100vw" />}
                                <div className={cardBody}>
                                    <p className={cardTag}>{stayTag(item, onSite)}</p>
                                    <h3 className={cardTitle}>{item.title}</h3>
                                    {item.body && <Prose text={item.body} className="text-charcoal text-[1rem]" />}
                                    <div className="mt-auto flex flex-wrap items-center gap-x-6 gap-y-3 pt-2">
                                        <ItemLink item={item} label="Visit website" />
                                        {onSite && contact && (
                                            <a
                                                href={`mailto:${contact}?subject=${encodeURIComponent(`Staying at ${item.title.replace(/^stay at\s+/i, "")}`)}`}
                                                className={cx(
                                                    weddingButton.link,
                                                    "inline-flex items-center gap-1.5 outline-focus-ring focus-visible:outline-2 focus-visible:outline-offset-4",
                                                )}
                                            >
                                                <Mail01 className="size-4" aria-hidden="true" />
                                                Email us
                                            </a>
                                        )}
                                    </div>
                                </div>
                            </li>
                        );
                    })}
                    {travel &&
                        travel.items.map((item, i) => (
                            <li key={`travel-${i}`} className={card}>
                                {i === 0 && travelImage && (
                                    <Photo image={travelImage} shape="none" className="aspect-[16/10] rounded-none" sizes="(min-width: 1024px) 400px, 100vw" />
                                )}
                                <div className={cardBody}>
                                    <p className={cardTag}>{EYEBROWS.travel}</p>
                                    <h3 className={cardTitle}>{item.title}</h3>
                                    {item.body && <Prose text={item.body} className="text-charcoal text-[1rem]" />}
                                    <div className="mt-auto pt-2">
                                        <ItemLink item={item} label="Open map" />
                                    </div>
                                </div>
                            </li>
                        ))}
                    {transport && (
                        <li className="bg-forest text-ivory [&_strong]:text-ivory flex flex-col overflow-hidden" data-testid="transport-card">
                            {transportImage && (
                                <Photo image={transportImage} shape="none" className="aspect-[16/10] rounded-none" sizes="(min-width: 1024px) 400px, 100vw" />
                            )}
                            <div className={cardBody}>
                                <p className="wedding-eyebrow text-ivory/80 text-[0.64rem]">{EYEBROWS.transport}</p>
                                <h3 className="wedding-display text-ivory text-[1.9rem] leading-[1.08] sm:text-[2.1rem]">{transport.title}</h3>
                                {transport.body && <Prose text={transport.body} className="text-ivory/90 text-[1rem]" />}
                                {transport.items.length > 0 && (
                                    <ul className="border-ivory/20 flex flex-col gap-5 border-t pt-5">
                                        {transport.items.map((item, i) => {
                                            const Icon = busIcon(item.title);
                                            return (
                                                <li key={i} className="flex gap-3">
                                                    <Icon className="text-ivory/80 mt-0.5 size-5 shrink-0" aria-hidden="true" />
                                                    <div className="flex flex-col gap-1">
                                                        <p className="font-medium">{item.title}</p>
                                                        {item.body && <Prose text={item.body} className="text-ivory/85 text-[0.9375rem] leading-relaxed" />}
                                                        {item.url && (
                                                            <a
                                                                href={item.url}
                                                                {...external}
                                                                className="text-ivory decoration-ivory/40 hover:decoration-ivory outline-ivory self-start rounded-sm text-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2"
                                                            >
                                                                More information <span className="sr-only">(opens in a new tab)</span>
                                                            </a>
                                                        )}
                                                    </div>
                                                </li>
                                            );
                                        })}
                                    </ul>
                                )}
                                {/* Say I Do doesn't ask about the bus, so only point to the native RSVP. */}
                                {links.rsvp && !links.rsvpExternal && (
                                    <div className="mt-auto pt-2">
                                        <a
                                            {...rsvpLinkProps(links)}
                                            className="text-ivory decoration-ivory/40 hover:decoration-ivory outline-ivory inline-flex rounded-sm text-[0.8125rem] font-medium tracking-[0.18em] uppercase underline underline-offset-[6px] transition duration-100 ease-linear focus-visible:outline-2 focus-visible:outline-offset-4"
                                        >
                                            Let us know in your RSVP
                                        </a>
                                    </div>
                                )}
                            </div>
                        </li>
                    )}
                </ul>
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
            className={cx("wedding-reveal scroll-mt-20", sectionPad, tone === "eucalypt" ? "bg-eucalypt-light" : "border-sandstone/40 border-t")}
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
// FAQ: every answer open, in two columns

const Faq = ({ data, section }: { data: WeddingPageData; section: WebsiteSection }) => (
    <section id={section.id} aria-labelledby={`${section.id}-heading`} className={cx("wedding-reveal bg-paper scroll-mt-20", sectionPad)}>
        <div className={container}>
            <HeadingRow id={`${section.id}-heading`} eyebrow={EYEBROWS.faq!} title={section.title}>
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
            </HeadingRow>
            <div className="mt-12 grid grid-cols-1 md:grid-cols-2 md:gap-x-12 lg:mt-16 lg:gap-x-16" data-testid="faq-list">
                {section.items.map((item, i) => (
                    <article key={i} className="border-forest/20 flex flex-col gap-3 border-t py-7 sm:py-8">
                        <h3 className="wedding-display text-forest text-[1.5rem] leading-snug sm:text-[1.7rem]">{item.title}</h3>
                        {item.body && <Prose text={item.body} className="text-charcoal max-w-xl text-[1rem]" />}
                        <ItemLink item={item} label="More information" />
                    </article>
                ))}
            </div>
        </div>
    </section>
);

// ---------------------------------------------------------------------------------------------
// Gallery

const Gallery = ({ data }: { data: WeddingPageData }) => (
    <section id="gallery" aria-labelledby="gallery-heading" className={cx("wedding-reveal border-sandstone/40 scroll-mt-20 border-t", sectionPad)}>
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
    <section id="rsvp" aria-labelledby="rsvp-heading" className={cx("bg-sandstone relative isolate scroll-mt-16 overflow-hidden px-4 sm:px-8", sectionPad)}>
        <SignatureBotanicals />
        <div className="border-tan/40 bg-ivory relative z-10 mx-auto max-w-5xl border px-6 py-16 shadow-[0_24px_70px_-45px_rgb(60_42_35/0.35)] sm:px-12 sm:py-20 lg:px-20">
            <div className="relative mx-auto flex max-w-3xl flex-col items-center gap-7 text-center">
                <Eyebrow className="text-olive">RSVP</Eyebrow>
                <h2 id="rsvp-heading" className="wedding-display text-forest text-[3.5rem] leading-[0.98] text-balance sm:text-[4.8rem] lg:text-[5.5rem]">
                    {data.content.rsvpHeading || "We hope you'll celebrate with us."}
                </h2>
                {data.rsvp.deadline && links.rsvp && (
                    <p className="wedding-display text-leaf text-[1.375rem] italic">Kindly reply by {longDate(data.rsvp.deadline)}</p>
                )}
                {data.content.rsvpText && <Prose text={data.content.rsvpText} className="text-charcoal max-w-lg" />}
                {links.rsvp ? (
                    <>
                        <Button
                            {...rsvpLinkProps(links)}
                            size="xl"
                            className={cx(weddingButton.primary, "mt-2 w-full sm:w-auto sm:px-12")}
                            iconTrailing={links.rsvpExternal ? ArrowUpRight : undefined}
                        >
                            RSVP now
                        </Button>
                        {!links.rsvpExternal && (
                            <p className="max-w-sm text-sm text-tertiary">Use the personal link from your invitation, or enter the code printed on it.</p>
                        )}
                    </>
                ) : (
                    <p className="text-tertiary">Online replies will open soon. We'll let you know when.</p>
                )}
                <Sprig className="mt-2" />
            </div>
        </div>
    </section>
);

// ---------------------------------------------------------------------------------------------

export const HomePage = ({ data, links }: { data: WeddingPageData; links: SiteLinks }) => {
    const layout = homeLayout(data);
    const { day, stay } = layout;
    let feature = 0;
    let dayDrawn = false;
    let stayDrawn = false;
    const render = (section: WebsiteSection) => {
        // "The day" and "Stay & travel" sit where the first of their sections sits in the portal's order.
        if (isMerged(layout, section)) {
            if (day && Object.values(day).includes(section)) {
                if (dayDrawn) return null;
                dayDrawn = true;
                return <TheDay key={DAY_ID} data={data} day={day} />;
            }
            if (stay && !stayDrawn) {
                stayDrawn = true;
                return <StayAndTravel key={STAY_ID} data={data} stay={stay} links={links} />;
            }
            return null;
        }
        if (section.kind === "faq")
            return section.items.length > 0 ? (
                <Faq key={section.id} data={data} section={section} />
            ) : (
                <Feature key={section.id} data={data} section={section} tone="ivory" />
            );
        // Children get the soft eucalyptus band; other text sections alternate quietly.
        return (
            <Feature
                key={section.id}
                data={data}
                section={section}
                tone={section.kind === "children" || (section.kind !== "dress" && feature++ % 2 === 1) ? "eucalypt" : "ivory"}
            />
        );
    };
    // Events without a schedule section: the day still comes first, as before.
    const dayFirst = day && !day.details && !day.venue && !day.dress;

    return (
        <>
            <Hero data={data} links={links} dayId={day ? DAY_ID : null} />
            {dayFirst && <TheDay data={data} day={day} />}
            {layout.sections.map(render)}
            {data.gallery.length > 0 && <Gallery data={data} />}
            <RsvpBand data={data} links={links} />
        </>
    );
};
