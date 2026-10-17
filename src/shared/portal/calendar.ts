// "Add to calendar" for the wedding, shared by the Save the Date (email, SMS page, .ics download) and
// the RSVP confirmation. Built only from Wedding Planner settings and public event times, so a
// calendar file never carries a household's names, code or signed RSVP link.
//
// - Without a confirmed start AND finish time it's an all-day event, with the exclusive end date
//   calendars expect. Times are never invented.
// - With both, the times are the wedding's own time zone (Australia/Sydney) written as UTC instants,
//   which every calendar reads correctly without a VTIMEZONE block.
// - The UID is stable, so saving the file again updates the same event in calendars that honour UIDs
//   rather than adding a second one. Nothing is pushed to guests: they choose to save it.
import type { WeddingDetails } from "./types";

export interface CalendarEvent {
    uid: string;
    title: string;
    location: string;
    description: string;
    url: string;
    /** YYYY-MM-DD, the wedding date. */
    date: string;
    timeZone: string;
    /** UTC instants, only when a confirmed start and finish are both set. Otherwise all-day. */
    start: Date | null;
    end: Date | null;
}

/** "Rhino Lodge · Dubbo, NSW" reads as "Rhino Lodge, Dubbo NSW". */
export const weddingLocation = (location: string) =>
    location
        .replace(/\s*[·•]\s*/g, ", ")
        .replace(/,\s*(NSW|VIC|QLD|SA|WA|TAS|NT|ACT)\b/g, " $1")
        .trim();

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/;

/** The UTC instant of a wall-clock time ("2027-10-23T15:30") in an IANA time zone. */
export function zonedTimeToUtc(local: string, timeZone: string): Date | null {
    const match = LOCAL.exec(local);
    if (!match) return null;
    const [, y, m, d, h, min] = match.map(Number);
    const wall = Date.UTC(y, m - 1, d, h, min);
    let format: Intl.DateTimeFormat;
    try {
        format = new Intl.DateTimeFormat("en-US", {
            timeZone,
            hourCycle: "h23",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
        });
    } catch {
        return null;
    }
    const offset = (instant: number) => {
        const parts = Object.fromEntries(format.formatToParts(new Date(instant)).map((part) => [part.type, part.value]));
        return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - instant;
    };
    // Two passes settle the offset either side of a daylight-saving change.
    const first = wall - offset(wall);
    return new Date(wall - offset(first));
}

const nextDay = (date: string) => {
    const day = new Date(`${date}T12:00:00Z`);
    day.setUTCDate(day.getUTCDate() + 1);
    return day.toISOString().slice(0, 10);
};

/** The wedding as one calendar event, or null while the date is undecided. */
export function weddingCalendarEvent(input: {
    details: WeddingDetails;
    events: { startsAt: string | null; endsAt: string | null }[];
    /** The wedding website, e.g. https://wedding.daly.id.au. */
    site: string;
}): CalendarEvent | null {
    const { details, site } = input;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(details.date)) return null;
    const couple = [details.partnerOne, details.partnerTwo].filter(Boolean).join(" & ");
    const location = weddingLocation(details.location);
    const timeZone = details.timeZone || "Australia/Sydney";
    // Only times on the wedding day count; a later farewell brunch doesn't stretch the event.
    const onTheDay = (value: string | null) => (value && value.slice(0, 10) === details.date && LOCAL.test(value) ? value : null);
    const starts = input.events.map((event) => onTheDay(event.startsAt)).filter((value): value is string => !!value);
    // A reception can finish after midnight, so finishes on the following day count too.
    const finishDays = [details.date, nextDay(details.date)];
    const ends = input.events
        .map((event) => (event.endsAt && LOCAL.test(event.endsAt) && finishDays.includes(event.endsAt.slice(0, 10)) ? event.endsAt : null))
        .filter((value): value is string => !!value);
    const start = starts.length ? zonedTimeToUtc(starts.sort()[0], timeZone) : null;
    const end = ends.length ? zonedTimeToUtc(ends.sort()[ends.length - 1], timeZone) : null;
    const timed = !!start && !!end && end.getTime() > start.getTime();
    let host = "daly.id.au";
    try {
        host = new URL(site).hostname;
    } catch {
        // Keep the default host; the UID only needs to be stable and unique.
    }
    return {
        uid: `wedding-${details.date}@${host}`,
        title: `${couple}'s Wedding`,
        location,
        description: [`${couple} are getting married${location ? ` at ${location}` : ""}.`, site ? `Details: ${site}` : ""].filter(Boolean).join("\n\n"),
        url: site,
        date: details.date,
        timeZone,
        start: timed ? start : null,
        end: timed ? end : null,
    };
}

// ---------------------------------------------------------------------------------------------
// iCalendar (RFC 5545)

/** TEXT values escape backslash, semicolon, comma and newlines. */
export const icsText = (value: string) =>
    value
        .replace(/\\/g, "\\\\")
        .replace(/;/g, "\\;")
        .replace(/,/g, "\\,")
        .replace(/\r\n|\r|\n/g, "\\n");

const encoder = new TextEncoder();

/** Folds a content line at 75 octets, never inside a UTF-8 character. */
export function foldIcsLine(line: string): string {
    const out: string[] = [];
    let current = "";
    let octets = 0;
    for (const char of line) {
        const size = encoder.encode(char).length;
        // Continuation lines start with a space, which counts towards their 75 octets.
        const limit = out.length ? 74 : 75;
        if (octets + size > limit) {
            out.push(current);
            current = "";
            octets = 0;
        }
        current += char;
        octets += size;
    }
    out.push(current);
    return out.join("\r\n ");
}

const utcStamp = (date: Date) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
const dateValue = (date: string) => date.replace(/-/g, "");

export function icsFile(event: CalendarEvent, now = new Date()): string {
    const lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//daly.id.au//Wedding Planner//EN",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        "BEGIN:VEVENT",
        `UID:${event.uid}`,
        `DTSTAMP:${utcStamp(now)}`,
        ...(event.start && event.end
            ? [`DTSTART:${utcStamp(event.start)}`, `DTEND:${utcStamp(event.end)}`]
            : [`DTSTART;VALUE=DATE:${dateValue(event.date)}`, `DTEND;VALUE=DATE:${dateValue(nextDay(event.date))}`]),
        `SUMMARY:${icsText(event.title)}`,
        ...(event.location ? [`LOCATION:${icsText(event.location)}`] : []),
        ...(event.description ? [`DESCRIPTION:${icsText(event.description)}`] : []),
        ...(event.url ? [`URL:${event.url}`] : []),
        "TRANSP:OPAQUE",
        "END:VEVENT",
        "END:VCALENDAR",
    ];
    return lines.map(foldIcsLine).join("\r\n") + "\r\n";
}

/** A filename for the download, e.g. "amelia-aidan-wedding.ics". */
export const icsFilename = (details: WeddingDetails) =>
    `${[details.partnerOne, details.partnerTwo, "wedding"]
        .join("-")
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")}.ics`;

// ---------------------------------------------------------------------------------------------
// Web calendars

/** Google Calendar's "create event" page, prefilled. */
export function googleCalendarUrl(event: CalendarEvent) {
    const dates = event.start && event.end ? `${utcStamp(event.start)}/${utcStamp(event.end)}` : `${dateValue(event.date)}/${dateValue(nextDay(event.date))}`;
    const params = new URLSearchParams({
        action: "TEMPLATE",
        text: event.title,
        dates,
        details: event.description,
        location: event.location,
        ctz: event.timeZone,
    });
    return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/** Outlook on the web's compose page: "live" for Outlook.com, "office" for Microsoft 365 work and school accounts. */
export function outlookCalendarUrl(event: CalendarEvent, service: "live" | "office" = "live") {
    const timed = !!event.start && !!event.end;
    const params = new URLSearchParams({
        path: "/calendar/action/compose",
        rru: "addevent",
        subject: event.title,
        startdt: timed ? event.start!.toISOString().replace(/\.\d+/, "") : event.date,
        enddt: timed ? event.end!.toISOString().replace(/\.\d+/, "") : nextDay(event.date),
        allday: timed ? "false" : "true",
        location: event.location,
        body: event.description,
    });
    return `https://outlook.${service === "live" ? "live" : "office"}.com/calendar/0/action/compose?${params.toString()}`;
}

/** Every way to save the wedding: the .ics file serves Apple Calendar and anything else that imports it. */
export interface CalendarLinks {
    google: string;
    outlook: string;
    office365: string;
    /** The universal .ics file, or null when it isn't being served yet. */
    ics: string | null;
}

export const calendarLinks = (event: CalendarEvent, icsUrl: string | null): CalendarLinks => ({
    google: googleCalendarUrl(event),
    outlook: outlookCalendarUrl(event, "live"),
    office365: outlookCalendarUrl(event, "office"),
    ics: icsUrl,
});
