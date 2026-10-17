// The pages a guest reaches from a message, outside the main wedding website:
//
// - /invitation?invite=…      the household's own invitation, then an RSVP button (from the invitation text)
// - /invitation.pdf?invite=…  the same household's printable invitation, with its QR code
// - /save-the-date            the public Save the Date, with Add to Calendar
// - /save-the-date.ics        the universal calendar file
//
// The invitation pages use the household's existing signed link and nothing else: no login, no
// code, and a link that's revoked, replaced, expired or mistyped shows the same page as any other.
// They're built by the same Invitation Studio code as the printed and emailed invitation, for
// exactly one household. The Save the Date pages carry no household details at all.
import { icsFile, weddingCalendarEvent } from "../../src/shared/portal/calendar";
import type { GuestInvitationPageData, SaveTheDatePageData } from "../../src/shared/portal/types";
import type { Env } from "../env";
import { displayLocation, saveTheDateCard } from "../portal/campaigns";
import { ValidationError } from "../portal/entities";
import { loadFlags } from "../portal/flags";
import { invitationPreviews, loadStudioData, printableInvitations } from "../portal/invitation-studio";
import { getSettings } from "../portal/settings";
import { householdForInvitation, weddingOrigin } from "./invitations";

/** The household and guest a signed link opens, or null. Only a valid, current, unexpired link counts. */
async function verifiedInvitation(env: Env, token: string | null) {
    if (!token || token.length > 400) return null;
    const settings = await getSettings(env.DB, "rsvp");
    const household = await householdForInvitation(env.DB, env, token, settings);
    if (!household) return null;
    const request = {
        householdIds: [household.id],
        delivery: household.highlightedGuestId ? ("individual" as const) : ("household" as const),
        channels: ["print" as const],
        ...(household.highlightedGuestId ? { onlyGuestId: household.highlightedGuestId } : {}),
    };
    return { household, request };
}

export async function guestInvitationPage(env: Env, token: string | null): Promise<GuestInvitationPageData> {
    const [details, flags] = await Promise.all([getSettings(env.DB, "wedding"), loadFlags(env.DB)]);
    const site = weddingOrigin(env);
    const page: GuestInvitationPageData = { route: "invitation", details, invitation: null, websiteUrl: flags["wedding.site.public"] ? site : null };
    const verified = await verifiedInvitation(env, token);
    if (!verified) return page;
    let preview;
    try {
        [preview] = await invitationPreviews(env, verified.request);
    } catch (error) {
        // Nobody invited to an event with RSVPs open (or links not configured): no invitation to show.
        if (error instanceof ValidationError) return page;
        throw error;
    }
    if (!preview) return page;
    return {
        ...page,
        invitation: {
            eyebrow: preview.eyebrow,
            coupleNames: preview.coupleNames,
            invitationLine: preview.invitationLine,
            recipientLine: preview.recipientLine,
            namesLine: preview.namesLine,
            weddingDate: preview.weddingDate,
            location: preview.location,
            eventLines: preview.eventLines,
            deadline: preview.deadline,
            accent: preview.accent,
            rsvpUrl: preview.rsvpUrl,
            pdfUrl: `${site}/invitation.pdf?invite=${encodeURIComponent(token!)}`,
        },
    };
}

/** The household's printable invitation, or null when the link isn't valid. */
export async function guestInvitationPdf(env: Env, token: string | null) {
    const verified = await verifiedInvitation(env, token);
    if (!verified) return null;
    try {
        const bytes = await printableInvitations(env, verified.request, await loadStudioData(env));
        return { bytes, filename: "Wedding invitation.pdf" };
    } catch (error) {
        if (error instanceof ValidationError) return null;
        throw error;
    }
}

/** The Save the Date pages are served once the website is published, or with their own switch before that. */
export async function saveTheDateAvailable(env: Env) {
    const flags = await loadFlags(env.DB);
    return flags["wedding.site.public"] || flags["wedding.save_the_date.public"];
}

async function saveTheDateInputs(env: Env) {
    const [wedding, studio, flags, events] = await Promise.all([
        getSettings(env.DB, "wedding"),
        getSettings(env.DB, "studio"),
        loadFlags(env.DB),
        env.DB.prepare(
            "SELECT name, starts_at, ends_at, venue_name FROM events WHERE is_public = 1 ORDER BY sort_order, starts_at IS NULL, starts_at, created_at",
        ).all<{
            name: string;
            starts_at: string | null;
            ends_at: string | null;
            venue_name: string | null;
        }>(),
    ]);
    return {
        wedding,
        studio,
        site: weddingOrigin(env),
        sitePublished: flags["wedding.site.public"],
        saveTheDatePublic: flags["wedding.site.public"] || flags["wedding.save_the_date.public"],
        events: events.results.map((e) => ({ name: e.name, startsAt: e.starts_at, endsAt: e.ends_at, venue: e.venue_name })),
    };
}

export async function saveTheDatePage(env: Env): Promise<SaveTheDatePageData | null> {
    const inputs = await saveTheDateInputs(env);
    const card = saveTheDateCard(inputs);
    if (!card) return null;
    return {
        route: "save-the-date",
        details: inputs.wedding,
        saveTheDate: {
            headline: card.headline,
            coupleNames: card.coupleNames,
            tagline: card.tagline,
            weddingDate: card.weddingDate,
            location: card.location || displayLocation(inputs.wedding.location),
            followUp: card.followUp,
            accent: inputs.studio.accent,
            calendar: card.calendar,
        },
        websiteUrl: inputs.sitePublished ? inputs.site : null,
    };
}

/** The universal .ics file, or null while the wedding date is undecided. */
export async function saveTheDateCalendar(env: Env) {
    const inputs = await saveTheDateInputs(env);
    const event = weddingCalendarEvent({ details: inputs.wedding, events: inputs.events, site: inputs.site });
    return event ? icsFile(event) : null;
}
