// The public wedding website. Built from the same Untitled UI components and React Aria patterns as
// the rest of the site, wrapped in .wedding-theme, which re-roots every design token on the wedding
// palette (ivory, eucalyptus, olive, clay) and serif typography. See src/styles/wedding.css.
import { Fragment } from "react";
import { Calendar, LinkExternal01, Mail01, MarkerPin01, Stars02 } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { formatDate, formatTime } from "@/portal/lib/format";
import type { PublicEvent, WebsiteSection, WeddingPageData } from "@/shared/portal/types";
import { cx } from "@/utils/cx";
import { Arch, Sprig } from "@/wedding/components/ornament";
import { RsvpFlow } from "@/wedding/rsvp-flow";

const paragraphs = (text: string) =>
    text
        .split(/\n\s*\n/)
        .map((p) => p.trim())
        .filter(Boolean);

const longDate = (iso: string) => formatDate(iso, { weekday: "long", day: "numeric", month: "long", year: "numeric" });

const Header = ({ data, links }: { data: WeddingPageData; links: { home: string; rsvp: string } }) => {
    const initials = `${data.details.partnerOne.charAt(0)} & ${data.details.partnerTwo.charAt(0)}`;
    const visibleSections = data.content.sections.filter((s) => s.body.trim() || s.items.length);
    return (
        <header className="sticky top-0 z-20 border-b border-secondary bg-primary/90 backdrop-blur supports-[backdrop-filter]:bg-primary/75">
            <nav aria-label="Wedding" className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3 md:px-8">
                <a
                    href={links.home}
                    className="wedding-display rounded-md text-xl text-primary outline-focus-ring focus-visible:outline-2 focus-visible:outline-offset-4"
                >
                    {initials}
                </a>
                <ul className="flex items-center gap-1 text-sm sm:gap-4">
                    {data.events.length > 0 && (
                        <li className="max-sm:hidden">
                            <a
                                href={`${links.home}#schedule`}
                                className="rounded-md px-2 py-1 text-secondary outline-focus-ring hover:text-primary focus-visible:outline-2"
                            >
                                Schedule
                            </a>
                        </li>
                    )}
                    {visibleSections.slice(0, 3).map((s) => (
                        <li key={s.id} className="max-md:hidden">
                            <a
                                href={`${links.home}#${s.id}`}
                                className="rounded-md px-2 py-1 text-secondary outline-focus-ring hover:text-primary focus-visible:outline-2"
                            >
                                {s.title}
                            </a>
                        </li>
                    ))}
                    {data.rsvp.mode !== "closed" && (
                        <li>
                            <Button href={links.rsvp} size="sm">
                                RSVP
                            </Button>
                        </li>
                    )}
                </ul>
            </nav>
        </header>
    );
};

const EventCard = ({ event }: { event: PublicEvent }) => (
    <li className="flex flex-col gap-4 rounded-2xl bg-primary p-6 text-center shadow-xs ring-1 ring-secondary sm:p-8">
        <h3 className="wedding-display text-display-xs text-primary">{event.name}</h3>
        {event.startsAt ? (
            <p className="flex items-center justify-center gap-2 text-secondary">
                <Calendar className="size-4 text-brand-600" aria-hidden="true" />
                <span>
                    {longDate(event.startsAt.slice(0, 10))}
                    <br />
                    {formatTime(event.startsAt)}
                    {event.endsAt && event.endsAt.slice(0, 10) === event.startsAt.slice(0, 10) && ` – ${formatTime(event.endsAt)}`}
                </span>
            </p>
        ) : (
            <p className="text-tertiary">Time to be announced</p>
        )}
        {(event.venueName || event.address) && (
            <p className="flex items-start justify-center gap-2 text-secondary">
                <MarkerPin01 className="mt-1 size-4 shrink-0 text-brand-600" aria-hidden="true" />
                <span>
                    {event.venueName}
                    {event.venueName && event.address && <br />}
                    {event.address && <span className="text-tertiary">{event.address}</span>}
                </span>
            </p>
        )}
        {event.dressCode && (
            <p className="flex items-center justify-center gap-2 text-sm text-tertiary">
                <Stars02 className="size-4 text-brand-600" aria-hidden="true" />
                {event.dressCode}
            </p>
        )}
        {event.description && (
            <div className="wedding-prose flex flex-col gap-3 text-sm text-tertiary">
                {paragraphs(event.description).map((p, i) => (
                    <p key={i}>{p}</p>
                ))}
            </div>
        )}
    </li>
);

const RsvpCall = ({ data, href }: { data: WeddingPageData; href: string }) => {
    if (data.rsvp.mode === "closed") return null;
    return (
        <section id="rsvp" aria-labelledby="rsvp-heading" className="bg-brand-primary px-4 py-20 md:px-8">
            <div className="mx-auto flex max-w-2xl flex-col items-center gap-6 text-center">
                <Sprig />
                <h2 id="rsvp-heading" className="wedding-display text-display-md text-primary">
                    Will you join us?
                </h2>
                {data.rsvp.deadline && <p className="text-lg text-secondary">Kindly reply by {longDate(data.rsvp.deadline)}.</p>}
                {data.rsvp.mode === "external" && data.rsvp.externalUrl && !data.preview ? (
                    <Button href={data.rsvp.externalUrl} size="xl" iconTrailing={LinkExternal01} target="_blank" rel="noreferrer">
                        RSVP online
                    </Button>
                ) : (
                    <Button href={href} size="xl">
                        RSVP online
                    </Button>
                )}
            </div>
        </section>
    );
};

const SectionBody = ({ section }: { section: WebsiteSection }) => (
    <>
        {section.body && (
            <div className="wedding-prose flex flex-col gap-4 text-lg leading-relaxed text-secondary">
                {paragraphs(section.body).map((p, j) => (
                    <p key={j}>{p}</p>
                ))}
            </div>
        )}
        {section.items.length > 0 &&
            (section.kind === "faq" ? (
                <dl className="flex w-full flex-col divide-y divide-secondary text-left">
                    {section.items.map((item, j) => (
                        <details key={j} className="group py-4">
                            <summary className="flex cursor-pointer items-center justify-between gap-4 rounded-md text-lg font-medium text-primary outline-focus-ring focus-visible:outline-2">
                                <dt>{item.title}</dt>
                                <span aria-hidden="true" className="text-brand-600 transition duration-200 group-open:rotate-45">
                                    +
                                </span>
                            </summary>
                            <dd className="wedding-prose mt-3 text-md leading-relaxed text-secondary">
                                {paragraphs(item.body).map((p, k) => (
                                    <p key={k}>{p}</p>
                                ))}
                            </dd>
                        </details>
                    ))}
                </dl>
            ) : (
                <ul className={cx("grid w-full grid-cols-1 gap-4 text-left", section.items.length > 1 && "sm:grid-cols-2")}>
                    {section.items.map((item, j) => (
                        <li key={j} className="flex flex-col gap-2 rounded-2xl bg-primary p-5 shadow-xs ring-1 ring-secondary">
                            <h3 className="wedding-display text-xl text-primary">{item.title}</h3>
                            {item.body && (
                                <div className="wedding-prose text-md leading-relaxed text-secondary">
                                    {paragraphs(item.body).map((p, k) => (
                                        <p key={k}>{p}</p>
                                    ))}
                                </div>
                            )}
                            {item.url && (
                                <a
                                    href={item.url}
                                    target="_blank"
                                    rel="noreferrer noopener"
                                    className="mt-auto inline-flex items-center gap-1.5 self-start rounded-md text-sm font-semibold text-brand-secondary underline-offset-4 outline-focus-ring hover:underline focus-visible:outline-2"
                                >
                                    {section.kind === "accommodation" ? "Book or enquire" : section.kind === "travel" ? "Open map" : "Visit"}
                                    <LinkExternal01 className="size-4" aria-hidden="true" />
                                </a>
                            )}
                        </li>
                    ))}
                </ul>
            ))}
    </>
);

const Schedule = ({ events }: { events: PublicEvent[] }) => (
    <section id="schedule" aria-labelledby="schedule-heading" className="wedding-reveal bg-secondary px-4 py-20 md:px-8">
        <div className="mx-auto flex max-w-5xl flex-col gap-12">
            <h2 id="schedule-heading" className="wedding-display text-center text-display-md text-primary">
                The celebration
            </h2>
            <ul className={cx("grid grid-cols-1 gap-6", events.length > 1 && "md:grid-cols-2", events.length > 2 && "lg:grid-cols-3")}>
                {events.map((event) => (
                    <EventCard key={event.id} event={event} />
                ))}
            </ul>
        </div>
    </section>
);

const Home = ({ data, links }: { data: WeddingPageData; links: { home: string; rsvp: string } }) => {
    const { details, content } = data;
    const names = content.heroTitle || `${details.partnerOne} & ${details.partnerTwo}`;
    const sections = content.sections.filter((s) => s.body.trim() || s.items.length);
    // The schedule follows the "wedding details" section, or the welcome if there isn't one.
    const detailsIndex = sections.findIndex((s) => s.kind === "details");

    return (
        <>
            <section aria-labelledby="names" className="relative overflow-hidden px-4 pt-14 pb-16 md:px-8 md:pt-20 md:pb-24">
                <div className="wedding-rise relative mx-auto flex max-w-xl flex-col items-center gap-6 px-10 pt-20 pb-14 text-center sm:px-14">
                    <Arch />
                    {content.heroEyebrow && (
                        <p className="relative text-xs tracking-[0.18em] text-tertiary uppercase sm:text-sm sm:tracking-[0.25em]">{content.heroEyebrow}</p>
                    )}
                    <h1 id="names" className="wedding-display relative text-display-lg leading-tight text-primary italic sm:text-display-xl">
                        {names}
                    </h1>
                    {content.heroSubtitle && <p className="relative max-w-md text-lg text-secondary">{content.heroSubtitle}</p>}
                    <Sprig className="relative" />
                    {(details.date || details.location) && (
                        <p className="relative text-md tracking-[0.15em] text-secondary uppercase">
                            {details.date && longDate(details.date)}
                            {details.date && details.location && <span aria-hidden="true"> · </span>}
                            {details.location}
                        </p>
                    )}
                </div>
                {data.heroImage && (
                    <figure className="wedding-rise mx-auto mt-4 max-w-4xl [animation-delay:150ms]">
                        <img
                            src={data.heroImage.url}
                            alt={data.heroImage.alt}
                            width={data.heroImage.width ?? undefined}
                            height={data.heroImage.height ?? undefined}
                            fetchPriority="high"
                            className="aspect-[4/3] w-full rounded-t-[999px] rounded-b-3xl object-cover shadow-lg sm:aspect-[16/9]"
                        />
                        {data.heroImage.caption && <figcaption className="mt-3 text-center text-sm text-tertiary italic">{data.heroImage.caption}</figcaption>}
                    </figure>
                )}
            </section>

            {content.welcome && (
                <section aria-label="Welcome" className="wedding-reveal px-4 pb-20 md:px-8">
                    <div className="wedding-prose mx-auto flex max-w-2xl flex-col gap-5 text-center text-lg leading-relaxed text-secondary">
                        {paragraphs(content.welcome).map((p, i) => (
                            <p key={i}>{p}</p>
                        ))}
                    </div>
                </section>
            )}

            {detailsIndex < 0 && data.events.length > 0 && <Schedule events={data.events} />}

            {sections.map((section, i) => (
                <Fragment key={section.id}>
                    <section
                        id={section.id}
                        aria-labelledby={`${section.id}-heading`}
                        className={cx("wedding-reveal px-4 py-20 md:px-8", (i + (detailsIndex >= 0 && i > detailsIndex ? 1 : 0)) % 2 === 1 && "bg-secondary")}
                    >
                        <div className="mx-auto flex max-w-3xl flex-col items-center gap-6 text-center">
                            <h2 id={`${section.id}-heading`} className="wedding-display text-display-sm text-primary">
                                {section.title}
                            </h2>
                            <SectionBody section={section} />
                        </div>
                    </section>
                    {i === detailsIndex && data.events.length > 0 && <Schedule events={data.events} />}
                </Fragment>
            ))}

            {data.gallery.length > 0 && (
                <section id="gallery" aria-labelledby="gallery-heading" className="wedding-reveal px-4 py-20 md:px-8">
                    <div className="mx-auto flex max-w-6xl flex-col gap-10">
                        <h2 id="gallery-heading" className="wedding-display text-center text-display-sm text-primary">
                            Gallery
                        </h2>
                        <ul className="columns-1 gap-4 sm:columns-2 lg:columns-3">
                            {data.gallery.map((photo) => (
                                <li key={photo.id} className="mb-4 break-inside-avoid">
                                    <figure>
                                        <img
                                            src={photo.url}
                                            alt={photo.alt}
                                            width={photo.width ?? undefined}
                                            height={photo.height ?? undefined}
                                            loading="lazy"
                                            decoding="async"
                                            className="w-full rounded-2xl object-cover shadow-xs"
                                        />
                                        {photo.caption && <figcaption className="mt-2 text-center text-sm text-tertiary italic">{photo.caption}</figcaption>}
                                    </figure>
                                </li>
                            ))}
                        </ul>
                    </div>
                </section>
            )}

            <RsvpCall data={data} href={links.rsvp} />
        </>
    );
};

const RsvpPage = ({ data }: { data: WeddingPageData }) => {
    // The preview always shows the native form, so owners can test it before switching it on.
    const native = data.rsvp.mode === "native" || data.preview;
    return (
        <section aria-labelledby="rsvp-title" className="px-4 py-16 md:px-8 md:py-24">
            <div className="mx-auto flex max-w-3xl flex-col items-center gap-10">
                <div className="flex flex-col items-center gap-4 text-center">
                    <Sprig />
                    <h1 id="rsvp-title" className="wedding-display text-display-md text-primary">
                        RSVP
                    </h1>
                </div>
                {native ? (
                    <RsvpFlow apiBase={data.preview ? "/api/portal/wedding/rsvp-test" : "/api/wedding/rsvp"} deadline={data.rsvp.deadline} />
                ) : data.rsvp.mode === "external" && data.rsvp.externalUrl ? (
                    <div className="flex flex-col items-center gap-5 text-center">
                        <p className="max-w-md text-lg text-secondary">We're collecting replies through our RSVP partner. It only takes a minute.</p>
                        <Button href={data.rsvp.externalUrl} size="xl" iconTrailing={LinkExternal01} target="_blank" rel="noreferrer">
                            Continue to RSVP
                        </Button>
                    </div>
                ) : (
                    <p className="max-w-md text-center text-lg text-secondary">
                        Online RSVPs aren't open yet. Please check back soon, or use the details on your invitation.
                    </p>
                )}
            </div>
        </section>
    );
};

export const WeddingApp = ({ data }: { data: WeddingPageData; path: string }) => {
    const links = data.preview
        ? { home: "/portal/wedding/website/preview", rsvp: "/portal/wedding/website/preview/rsvp" }
        : { home: "/wedding", rsvp: "/wedding/rsvp" };
    return (
        <div className="wedding-theme flex min-h-dvh flex-col">
            <a
                href="#main"
                className="sr-only z-50 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary shadow-lg ring-1 ring-primary focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
            >
                Skip to content
            </a>
            {data.preview && (
                <p className="bg-olive-700 px-4 py-2 text-center text-sm text-white">
                    Preview from the portal{data.route === "rsvp" ? ": RSVPs sent here are saved for real, so test with a test household." : "."}{" "}
                    <a href="/portal/wedding/website" className="font-semibold underline underline-offset-2">
                        Back to the portal
                    </a>
                </p>
            )}
            <Header data={data} links={links} />
            <main id="main" className="flex-1">
                {data.route === "rsvp" ? <RsvpPage data={data} /> : <Home data={data} links={links} />}
            </main>
            <footer className="border-t border-secondary px-4 py-10 text-center md:px-8">
                <div className="mx-auto flex max-w-2xl flex-col items-center gap-3">
                    <p className="wedding-display text-xl text-primary">
                        {data.details.partnerOne} & {data.details.partnerTwo}
                    </p>
                    {data.details.date && <p className="text-sm text-tertiary">{longDate(data.details.date)}</p>}
                    {data.content.contactEmail && (
                        <a
                            href={`mailto:${data.content.contactEmail}`}
                            className="flex items-center gap-2 text-sm text-brand-secondary underline-offset-2 hover:underline"
                        >
                            <Mail01 className="size-4" aria-hidden="true" />
                            {data.content.contactEmail}
                        </a>
                    )}
                </div>
            </footer>
        </div>
    );
};
