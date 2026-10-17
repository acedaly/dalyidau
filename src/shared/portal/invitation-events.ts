// The event lines on an invitation. One set of rules for the printed invitation, the Studio preview,
// the invitation email and the guest's invitation page.
//
// When every event is at the same venue, the venue is named once ("Ceremony and reception at Rhino
// Lodge") and each event keeps its own line with its own time. Otherwise each event names its venue.

export interface InvitationEvent {
    name: string;
    startsAt: string | null;
    venue: string | null;
}

const clean = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();

/** "2:00 pm" from "2027-10-23T14:00", in the time written (no time-zone conversion). */
export const formatEventTime = (dateTime: string | null) => {
    const match = dateTime ? /T(\d{2}):(\d{2})/.exec(dateTime) : null;
    if (!match) return "";
    const hour = Number(match[1]);
    return `${hour % 12 || 12}:${match[2]} ${hour < 12 ? "am" : "pm"}`;
};

/** The venue every event shares, or null when there are fewer than two events or the venues differ. */
export function sharedVenue(events: InvitationEvent[]): string | null {
    if (events.length < 2) return null;
    const venues = events.map((event) => clean(event.venue));
    const first = venues[0];
    if (!first) return null;
    return venues.every((venue) => venue.toLocaleLowerCase("en-AU") === first.toLocaleLowerCase("en-AU")) ? first : null;
}

/** "Ceremony and reception", "Ceremony, reception and farewell". */
const joinEventNames = (names: string[]) => {
    const [head, ...rest] = names.map(clean);
    const all = [head, ...rest.map((name) => (/^\p{Lu}\p{Ll}/u.test(name) ? name.toLocaleLowerCase("en-AU") : name))];
    return all.length <= 1 ? (all[0] ?? "") : `${all.slice(0, -1).join(", ")} and ${all[all.length - 1]}`;
};

/**
 * "Ceremony - 2:00 pm at Rhino Lodge" for each event, or, when all share a venue:
 * "Ceremony and reception at Rhino Lodge", "Ceremony - 2:00 pm", "Reception - 5:30 pm".
 * Times are never dropped; an event without a time keeps a line only when venues differ.
 */
export function invitationEventLines(events: InvitationEvent[]): string[] {
    const venue = sharedVenue(events);
    if (!venue)
        return events.map((event) => {
            const detail = [formatEventTime(event.startsAt), clean(event.venue)].filter(Boolean).join(" at ");
            return [clean(event.name), detail].filter(Boolean).join(" - ");
        });
    // In the order they happen ("Ceremony and reception"), whatever order they're listed in.
    const ordered = [...events].sort((a, b) => (a.startsAt ?? "\uffff").localeCompare(b.startsAt ?? "\uffff"));
    const timed = ordered.filter((event) => formatEventTime(event.startsAt));
    return [
        `${joinEventNames(ordered.map((event) => event.name))} at ${venue}`,
        ...timed.map((event) => `${clean(event.name)} - ${formatEventTime(event.startsAt)}`),
    ];
}
