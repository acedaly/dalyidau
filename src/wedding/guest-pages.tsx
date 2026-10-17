// The pages guests open from a message: their own invitation (from the invitation text) and the
// Save the Date. Phone-first, in the stationery's own look: the botanical bands from the emails,
// ivory paper, espresso type and the template's accent. Every action is a plain link, so the pages
// work before (or without) JavaScript.
import type { ReactNode } from "react";
import { ArrowRight, ArrowUpRight, CalendarPlus01, Download01 } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import type { GuestInvitationPageData, SaveTheDatePageData } from "@/shared/portal/types";
import { cx } from "@/utils/cx";
import { EucalyptusBranch } from "@/wedding/components/ornament";
import { weddingButton } from "@/wedding/components/ui";

const ACCENTS = {
    burgundy: "#783B4A",
    rust: "#9C765C",
    clay: "#9C765C",
    eucalyptus: "#667463",
} as const;

const CoupleNames = ({ names, accent }: { names: string; accent: string }) => {
    const [first, second] = names.split(/\s+&\s+/, 2);
    if (!second) return <>{names}</>;
    return (
        <>
            <span className="block">{first}</span>
            <span className="my-1 block text-[0.5em] leading-none italic" style={{ color: accent }}>
                &amp;
            </span>
            <span className="block">{second}</span>
        </>
    );
};

const Rule = ({ accent }: { accent: string }) => <hr className="mx-auto my-6 w-full max-w-xs border-0 border-t" style={{ borderColor: `${accent}38` }} />;

/** The paper card, framed top and bottom by the banksia-and-wattle and waratah bands. */
const Stationery = ({ labelledBy, accent, children }: { labelledBy: string; accent: string; children: ReactNode }) => (
    <article
        aria-labelledby={labelledBy}
        className="bg-ivory text-forest mx-auto w-full max-w-[34rem] overflow-hidden text-center shadow-[0_28px_80px_-44px_rgb(73_52_45/0.6)] ring-1 ring-[#d8cdbc]"
        style={{ boxShadow: `inset 0 0 0 1px ${accent}22` }}
    >
        <img src="/wedding/email/botanical-header.jpg" alt="" width={1200} height={431} className="block h-auto w-full" />
        <div className="px-6 pt-2 pb-2 sm:px-12">{children}</div>
        <img src="/wedding/email/botanical-footer.jpg" alt="" width={1200} height={359} className="block h-auto w-full" />
    </article>
);

const Page = ({ children, websiteUrl, coupleNames }: { children: ReactNode; websiteUrl: string | null; coupleNames: string }) => (
    <div className="wedding-theme wedding-paper flex min-h-dvh flex-col">
        <main id="main" className="flex-1 px-3 py-5 sm:px-6 sm:py-12">
            {children}
        </main>
        <footer className="flex flex-col items-center gap-3 px-4 pt-2 pb-10 text-center">
            <EucalyptusBranch className="text-eucalypt/80 w-32" />
            <p className="wedding-eyebrow text-[0.6875rem] text-olive-600">{coupleNames}</p>
            {websiteUrl && (
                <Button href={websiteUrl} color="link-gray" iconTrailing={ArrowUpRight} className={weddingButton.link}>
                    Our wedding website
                </Button>
            )}
        </footer>
    </div>
);

export const GuestInvitationPage = ({ data }: { data: GuestInvitationPageData }) => {
    const couple = `${data.details.partnerOne} & ${data.details.partnerTwo}`;
    const invitation = data.invitation;
    if (!invitation)
        return (
            <Page websiteUrl={data.websiteUrl} coupleNames={couple}>
                <Stationery labelledBy="invitation-title" accent={ACCENTS.burgundy}>
                    <h1 id="invitation-title" className="wedding-display mt-2 text-[2rem] leading-tight">
                        This invitation link isn’t working
                    </h1>
                    <p className="wedding-prose text-charcoal mx-auto mt-4 max-w-sm pb-6">
                        It may have been replaced with a newer one, or copied only in part. Please use the most recent message we sent you, or get in touch with
                        us and we’ll send you a fresh link.
                    </p>
                </Stationery>
            </Page>
        );
    const accent = ACCENTS[invitation.accent];
    return (
        <Page websiteUrl={data.websiteUrl} coupleNames={couple}>
            <Stationery labelledBy="invitation-title" accent={accent}>
                <p className="text-[0.6875rem] font-semibold tracking-[0.28em] uppercase">{invitation.eyebrow}</p>
                <h1 id="invitation-title" className="wedding-names mt-4 text-[3.4rem] leading-[1.02] text-balance sm:text-[4.25rem]">
                    <CoupleNames names={invitation.coupleNames} accent={accent} />
                </h1>
                <p className="mx-auto mt-4 max-w-xs font-serif text-[1.125rem] leading-snug italic">{invitation.invitationLine}</p>

                <Rule accent={accent} />
                <p className="text-[0.625rem] font-semibold tracking-[0.26em] uppercase" style={{ color: accent }}>
                    Invitation for
                </p>
                <p className="wedding-display mt-2 text-[1.75rem] leading-tight font-semibold text-balance">{invitation.recipientLine}</p>
                {invitation.namesLine && <p className="mt-2 text-sm leading-snug text-balance text-[#4f614d]">{invitation.namesLine}</p>}

                <Rule accent={accent} />
                <p className="text-[0.8125rem] font-semibold tracking-[0.16em] uppercase" style={{ color: accent }}>
                    {invitation.weddingDate}
                </p>
                <p className="wedding-display mt-1.5 text-[1.6rem] leading-tight font-semibold">{invitation.location}</p>
                {invitation.eventLines.length > 0 && (
                    <ul className="text-charcoal mt-3 space-y-1 text-[0.9375rem] leading-snug">
                        {invitation.eventLines.map((line) => (
                            <li key={line}>{line}</li>
                        ))}
                    </ul>
                )}

                <div className="mt-8 flex flex-col items-stretch gap-3 sm:mx-auto sm:max-w-xs">
                    {invitation.deadline && <p className="text-sm font-semibold">Kindly reply by {invitation.deadline}</p>}
                    <Button href={invitation.rsvpUrl} size="xl" iconTrailing={ArrowRight} className={cx(weddingButton.primary, "w-full justify-center")}>
                        RSVP
                    </Button>
                    <Button
                        href={invitation.pdfUrl}
                        size="lg"
                        iconLeading={Download01}
                        // The icon follows the text colour (ivory on hover) rather than the solid button's faint white.
                        className={cx(weddingButton.outline, "w-full justify-center *:data-icon:text-current hover:*:data-icon:text-current")}
                        download
                        rel="nofollow"
                    >
                        Download invitation (PDF)
                    </Button>
                </div>
                <p className="mx-auto mt-5 mb-4 max-w-xs text-xs leading-relaxed text-tertiary">
                    This link is just for your household. You can come back to it any time to change your reply before the deadline.
                </p>
            </Stationery>
        </Page>
    );
};

export const SaveTheDatePage = ({ data }: { data: SaveTheDatePageData }) => {
    const card = data.saveTheDate;
    const accent = ACCENTS[card.accent];
    const choices = card.calendar
        ? [
              // Opened in place: iPhone Safari shows "Add to Calendar" for the one event.
              card.calendar.ics && { label: "Apple Calendar", href: card.calendar.ics, newTab: false },
              { label: "Google Calendar", href: card.calendar.google, newTab: true },
              { label: "Outlook", href: card.calendar.outlook, newTab: true },
              { label: "Microsoft 365", href: card.calendar.office365, newTab: true },
          ].filter((choice): choice is { label: string; href: string; newTab: boolean } => !!choice)
        : [];
    return (
        <Page websiteUrl={data.websiteUrl} coupleNames={card.coupleNames}>
            <Stationery labelledBy="save-the-date-title" accent={accent}>
                <p className="text-[0.75rem] font-semibold tracking-[0.3em] uppercase" style={{ color: accent }}>
                    {card.headline}
                </p>
                <h1 id="save-the-date-title" className="wedding-names mt-4 text-[3.6rem] leading-[1.02] text-balance sm:text-[4.5rem]">
                    <CoupleNames names={card.coupleNames} accent={accent} />
                </h1>
                <p className="mt-4 font-serif text-[1.3rem] leading-snug italic">{card.tagline}</p>

                <Rule accent={accent} />
                <p className="text-[0.875rem] font-semibold tracking-[0.16em] uppercase" style={{ color: accent }}>
                    {card.weddingDate}
                </p>
                <p className="wedding-display mt-1.5 text-[1.7rem] leading-tight font-semibold">{card.location}</p>
                {card.followUp && <p className="mt-4 font-serif text-[1.0625rem] italic">{card.followUp}</p>}

                {choices.length > 0 && (
                    <section aria-labelledby="add-to-calendar" className="mt-8 mb-6">
                        <h2 id="add-to-calendar" className="flex items-center justify-center gap-2 text-[0.6875rem] font-semibold tracking-[0.26em] uppercase">
                            <CalendarPlus01 className="size-4" aria-hidden="true" />
                            Add to calendar
                        </h2>
                        <ul className="mt-4 grid grid-cols-1 gap-2.5 min-[380px]:grid-cols-2">
                            {choices.map((choice) => (
                                <li key={choice.label}>
                                    <Button
                                        href={choice.href}
                                        size="lg"
                                        className={cx(weddingButton.outline, "w-full justify-center px-3 tracking-[0.12em]")}
                                        {...(choice.newTab ? { target: "_blank", rel: "noreferrer noopener" } : {})}
                                    >
                                        {choice.label}
                                    </Button>
                                </li>
                            ))}
                        </ul>
                        {card.calendar?.ics && (
                            <p className="mt-4 text-xs leading-relaxed text-tertiary">
                                Using another calendar app?{" "}
                                <a
                                    href={card.calendar.ics}
                                    className="text-forest decoration-forest/30 hover:decoration-forest rounded-sm font-medium underline underline-offset-4 outline-focus-ring focus-visible:outline-2"
                                >
                                    Download the calendar event (.ics)
                                </a>
                                . Your calendar will ask before adding it.
                            </p>
                        )}
                    </section>
                )}
                {choices.length === 0 && <div className="pb-6" />}
            </Stationery>
        </Page>
    );
};
