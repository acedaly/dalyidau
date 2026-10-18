// Reading and writing iCalendar (RFC 5545).
//
// Reading uses ical.js. Every value that comes out is treated as untrusted text: control characters
// are stripped, lengths are capped, links are kept only if they're http(s), and nothing is ever
// rendered as HTML. Times keep their wall clock in the event's own zone. Zones are resolved in this
// order: an IANA name (Google, Apple), a Windows name (Outlook, Exchange), the feed's VTIMEZONE
// definition (converted through UTC), then the calendar's default zone for floating times.
//
// Writing produces VCALENDAR text with a VTIMEZONE for every zone used (generated from Intl's own
// rules), RRULE/EXDATE for series and RECURRENCE-ID for single-occurrence changes, so Apple
// Calendar, Outlook and Google Calendar show the same times this calendar does.
import ICAL from "ical.js";
import { UNSUPPORTED_FREQUENCIES } from "../../src/shared/calendar/recurrence";
import { addDays, isTimeZone, occurrenceKey, wallClock, wallMinutes, zoneOffsetMinutes, zonedInstant } from "../../src/shared/calendar/time";
import type { OverrideFields } from "./expand";

// --- Reading -------------------------------------------------------------------------------------

export interface ParsedOverride {
    key: string;
    cancelled: boolean;
    fields: OverrideFields;
}

export interface ParsedEvent {
    uid: string;
    title: string;
    description: string | null;
    location: string | null;
    url: string | null;
    allDay: boolean;
    startDate: string;
    startTime: string | null;
    endDate: string;
    endTime: string | null;
    timeZone: string;
    rrule: string | null;
    exdates: string[];
    rdates: string[];
    visibility: "default" | "private";
    showAs: "busy" | "free";
    status: "confirmed" | "tentative";
    overrides: ParsedOverride[];
}

export interface ParsedCalendar {
    name: string | null;
    timeZone: string | null;
    events: ParsedEvent[];
    /** Events left out (cancelled, unreadable, over the limit), and why, as counts. */
    skipped: Record<string, number>;
}

export class IcsError extends Error {
    constructor(
        readonly code: "not_calendar" | "parse_error" | "too_many_events",
        message: string,
    ) {
        super(message);
    }
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g;
export const cleanText = (value: unknown, max: number): string | null => {
    if (value === null || value === undefined) return null;
    const text = String(value).replace(CONTROL, "").replace(/\r\n?/g, "\n").trim();
    return text ? text.slice(0, max) : null;
};
const cleanUrl = (value: unknown): string | null => {
    const text = cleanText(value, 1000);
    if (!text) return null;
    try {
        const url = new URL(text);
        return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
    } catch {
        return null;
    }
};

/** Windows zone names (Outlook, Exchange) for the zones an Australian household is likely to meet. */
const WINDOWS_ZONES: Record<string, string> = {
    "AUS Eastern Standard Time": "Australia/Sydney",
    "E. Australia Standard Time": "Australia/Brisbane",
    "Cen. Australia Standard Time": "Australia/Adelaide",
    "AUS Central Standard Time": "Australia/Darwin",
    "W. Australia Standard Time": "Australia/Perth",
    "Tasmania Standard Time": "Australia/Hobart",
    "Lord Howe Standard Time": "Australia/Lord_Howe",
    "New Zealand Standard Time": "Pacific/Auckland",
    UTC: "UTC",
    "GMT Standard Time": "Europe/London",
    "W. Europe Standard Time": "Europe/Berlin",
    "Romance Standard Time": "Europe/Paris",
    "Central Europe Standard Time": "Europe/Budapest",
    "Eastern Standard Time": "America/New_York",
    "Central Standard Time": "America/Chicago",
    "Mountain Standard Time": "America/Denver",
    "Pacific Standard Time": "America/Los_Angeles",
    "Hawaiian Standard Time": "Pacific/Honolulu",
    "Singapore Standard Time": "Asia/Singapore",
    "China Standard Time": "Asia/Shanghai",
    "Tokyo Standard Time": "Asia/Tokyo",
    "India Standard Time": "Asia/Kolkata",
    "Fiji Standard Time": "Pacific/Fiji",
};

/** An IANA zone for a TZID, or null when it can't be mapped. */
export function resolveZone(tzid: string | null | undefined): string | null {
    if (!tzid) return null;
    const id = tzid.trim().replace(/^"|"$/g, "");
    if (WINDOWS_ZONES[id]) return WINDOWS_ZONES[id];
    if (/^[A-Za-z]+\/[A-Za-z0-9_+\-]+(\/[A-Za-z0-9_+\-]+)?$/.test(id) && isTimeZone(id)) return id;
    // "/freeassociation.sourceforge.net/Australia/Sydney" and similar prefixes.
    const tail = /([A-Za-z]+\/[A-Za-z0-9_+\-]+(?:\/[A-Za-z0-9_+\-]+)?)$/.exec(id)?.[1];
    if (tail && isTimeZone(tail)) return tail;
    // "(UTC+10:00) Canberra, Melbourne, Sydney".
    if (/Sydney|Canberra|Melbourne/i.test(id)) return "Australia/Sydney";
    if (/Brisbane/i.test(id)) return "Australia/Brisbane";
    if (/Adelaide/i.test(id)) return "Australia/Adelaide";
    if (/Darwin/i.test(id)) return "Australia/Darwin";
    if (/Perth/i.test(id)) return "Australia/Perth";
    if (/Hobart/i.test(id)) return "Australia/Hobart";
    if (/^(UTC|GMT|Z|Etc\/UTC)$/i.test(id)) return "UTC";
    return null;
}

const pad = (n: number) => String(n).padStart(2, "0");
const localParts = (t: ICAL.Time) => ({ date: `${t.year}-${pad(t.month)}-${pad(t.day)}`, time: t.isDate ? null : `${pad(t.hour)}:${pad(t.minute)}` });
const isUtc = (t: ICAL.Time) => t.zone === ICAL.Timezone.utcTimezone || t.zone?.tzid === "UTC";

interface Resolved {
    date: string;
    time: string | null;
    zone: string;
}

/** A property's time as wall clock in an IANA zone. */
function resolveTime(prop: ICAL.Property, timezones: Map<string, ICAL.Timezone>, fallback: string): Resolved | null {
    const value = prop.getFirstValue() as ICAL.Time | null;
    if (!value || typeof value !== "object" || !("year" in value)) return null;
    const local = localParts(value);
    if (value.isDate) return { date: local.date, time: null, zone: fallback };
    if (isUtc(value)) return { date: local.date, time: local.time, zone: "UTC" };
    const tzid = prop.getParameter("tzid") as string | null;
    const iana = resolveZone(tzid);
    if (iana) return { date: local.date, time: local.time, zone: iana };
    const definition = tzid ? timezones.get(tzid) : undefined;
    if (definition) {
        const t = value.clone();
        t.zone = definition;
        const wall = wallClock(new Date(t.toUnixTime() * 1000), fallback);
        return { date: wall.date, time: wall.time, zone: fallback };
    }
    return { date: local.date, time: local.time, zone: fallback };
}

/** A time from another property (EXDATE, RECURRENCE-ID) as an occurrence key in the event's own zone. */
function keyFor(value: ICAL.Time, tzid: string | null, event: { allDay: boolean; timeZone: string }, timezones: Map<string, ICAL.Timezone>): string {
    const local = localParts(value);
    if (event.allDay || value.isDate) return local.date;
    let instant: string | null = null;
    if (isUtc(value)) instant = zonedInstant(local.date, local.time!, "UTC");
    else {
        const zone = resolveZone(tzid) ?? (tzid && timezones.has(tzid) ? null : event.timeZone);
        if (zone) instant = zonedInstant(local.date, local.time!, zone);
        else if (tzid) {
            const t = value.clone();
            t.zone = timezones.get(tzid)!;
            instant = new Date(t.toUnixTime() * 1000).toISOString();
        }
    }
    const wall = instant ? wallClock(instant, event.timeZone) : { date: local.date, time: local.time! };
    return occurrenceKey(wall.date, wall.time);
}

/** RRULE text with any UTC UNTIL turned into the event's floating local time (how expand.ts iterates). */
function localRule(recur: ICAL.Recur, event: { allDay: boolean; timeZone: string }): string | null {
    if (UNSUPPORTED_FREQUENCIES.includes(recur.freq)) return null;
    const text = recur.toString();
    if (!recur.until) return text;
    const until = recur.until;
    const parts = localParts(until);
    let floating: string;
    if (event.allDay) floating = parts.date.replaceAll("-", "");
    else if (until.isDate) floating = `${parts.date.replaceAll("-", "")}T235959`;
    else {
        const wall = isUtc(until) ? wallClock(zonedInstant(parts.date, parts.time!, "UTC"), event.timeZone) : { date: parts.date, time: parts.time! };
        floating = `${wall.date.replaceAll("-", "")}T${wall.time.replace(":", "")}${pad(until.second)}`;
    }
    return text.replace(/UNTIL=[^;]+/, `UNTIL=${floating}`);
}

interface Times {
    allDay: boolean;
    startDate: string;
    startTime: string | null;
    endDate: string;
    endTime: string | null;
    timeZone: string;
}

function eventTimes(component: ICAL.Component, timezones: Map<string, ICAL.Timezone>, fallback: string): Times | null {
    const startProp = component.getFirstProperty("dtstart");
    if (!startProp) return null;
    const start = resolveTime(startProp, timezones, fallback);
    if (!start) return null;
    const allDay = start.time === null;
    const endProp = component.getFirstProperty("dtend");
    const duration = component.getFirstPropertyValue("duration") as ICAL.Duration | null;
    if (allDay) {
        let endExclusive = start.date;
        const end = endProp ? resolveTime(endProp, timezones, fallback) : null;
        if (end) endExclusive = end.date;
        else if (duration) endExclusive = addDays(start.date, Math.max(1, Math.round(duration.toSeconds() / 86400)));
        else endExclusive = addDays(start.date, 1);
        const endDate = endExclusive > start.date ? addDays(endExclusive, -1) : start.date;
        return { allDay, startDate: start.date, startTime: null, endDate, endTime: null, timeZone: fallback };
    }
    const startAt = zonedInstant(start.date, start.time!, start.zone);
    let endAt = startAt;
    const end = endProp ? resolveTime(endProp, timezones, fallback) : null;
    if (end?.time) endAt = zonedInstant(end.date, end.time, end.zone);
    else if (duration) endAt = new Date(Date.parse(startAt) + duration.toSeconds() * 1000).toISOString();
    if (endAt < startAt) endAt = startAt;
    const wallEnd = wallClock(endAt, start.zone);
    return { allDay, startDate: start.date, startTime: start.time, endDate: wallEnd.date, endTime: wallEnd.time, timeZone: start.zone };
}

const textOf = (component: ICAL.Component, name: string, max: number) => cleanText(component.getFirstPropertyValue(name), max);

/**
 * Parses a whole feed. Events are grouped by UID: the master (with its RRULE, EXDATEs and RDATEs)
 * and its RECURRENCE-ID instances. A feed without a master for a UID becomes one event per instance.
 */
export function parseIcs(text: string, options: { fallbackZone: string; maxEvents?: number }): ParsedCalendar {
    const trimmed = text.replace(/^\uFEFF/, "").trimStart();
    if (!/^BEGIN:VCALENDAR/i.test(trimmed)) throw new IcsError("not_calendar", "That address didn't return a calendar (no BEGIN:VCALENDAR).");
    let root: ICAL.Component;
    try {
        root = new ICAL.Component(ICAL.parse(trimmed));
    } catch {
        throw new IcsError("parse_error", "The calendar couldn't be read: it isn't valid iCalendar.");
    }
    const skipped: Record<string, number> = {};
    const skip = (reason: string) => (skipped[reason] = (skipped[reason] ?? 0) + 1);
    const timezones = new Map<string, ICAL.Timezone>();
    for (const vtz of root.getAllSubcomponents("vtimezone")) {
        try {
            const tz = new ICAL.Timezone(vtz);
            if (tz.tzid) timezones.set(tz.tzid, tz);
        } catch {
            skip("bad_timezone");
        }
    }
    const declared = resolveZone(cleanText(root.getFirstPropertyValue("x-wr-timezone"), 64));
    const fallback = declared ?? options.fallbackZone;
    const max = options.maxEvents ?? 5000;

    const masters = new Map<string, ParsedEvent>();
    const instances: { uid: string; component: ICAL.Component }[] = [];
    for (const component of root.getAllSubcomponents("vevent")) {
        let uid = cleanText(component.getFirstPropertyValue("uid"), 255);
        if (component.getFirstProperty("recurrence-id")) {
            if (uid) instances.push({ uid, component });
            else skip("no_uid");
            continue;
        }
        const status = String(component.getFirstPropertyValue("status") ?? "").toUpperCase();
        if (status === "CANCELLED") {
            skip("cancelled");
            continue;
        }
        const times = eventTimes(component, timezones, fallback);
        if (!times) {
            skip("no_start");
            continue;
        }
        // A UID is required; a feed that omits it gets a stable one from what it does say.
        uid ??= `nouid-${hashString(`${textOf(component, "summary", 300) ?? ""}|${times.startDate}|${times.startTime ?? ""}`)}`;
        if (masters.has(uid)) {
            skip("duplicate_uid");
            continue;
        }
        if (masters.size >= max) {
            skip("over_limit");
            continue;
        }
        const recurValue = component.getFirstPropertyValue("rrule") as ICAL.Recur | null;
        const rrule = recurValue ? localRule(recurValue, times) : null;
        if (recurValue && !rrule) skip("sub_daily_repeat");
        const exdates: string[] = [];
        for (const prop of component.getAllProperties("exdate"))
            for (const value of prop.getValues() as ICAL.Time[]) exdates.push(keyFor(value, prop.getParameter("tzid") as string | null, times, timezones));
        const rdates: string[] = [];
        for (const prop of component.getAllProperties("rdate"))
            for (const value of prop.getValues() as unknown[])
                if (value && typeof value === "object" && "year" in value)
                    rdates.push(keyFor(value as ICAL.Time, prop.getParameter("tzid") as string | null, times, timezones));
        const klass = String(component.getFirstPropertyValue("class") ?? "").toUpperCase();
        masters.set(uid, {
            uid,
            title: textOf(component, "summary", 300) ?? "Untitled",
            description: textOf(component, "description", 8000),
            location: textOf(component, "location", 500),
            url: cleanUrl(component.getFirstPropertyValue("url")),
            ...times,
            rrule,
            exdates: [...new Set(exdates)].slice(0, 2000),
            rdates: rrule ? [...new Set(rdates)].slice(0, 500) : [],
            visibility: klass === "PRIVATE" || klass === "CONFIDENTIAL" ? "private" : "default",
            showAs: String(component.getFirstPropertyValue("transp") ?? "").toUpperCase() === "TRANSPARENT" ? "free" : "busy",
            status: status === "TENTATIVE" ? "tentative" : "confirmed",
            overrides: [],
        });
    }

    for (const { uid, component } of instances) {
        const master = masters.get(uid);
        const status = String(component.getFirstPropertyValue("status") ?? "").toUpperCase();
        const times = eventTimes(component, timezones, master?.timeZone ?? fallback);
        if (!master) {
            // An orphan instance: keep it as an event of its own (unless it's a cancellation).
            if (status === "CANCELLED" || !times || masters.size >= max) {
                skip(status === "CANCELLED" ? "cancelled" : "orphan_instance");
                continue;
            }
            const instanceUid = `${uid}#${times.startDate}${times.startTime ?? ""}`.slice(0, 255);
            if (masters.has(instanceUid)) continue;
            masters.set(instanceUid, {
                uid: instanceUid,
                title: textOf(component, "summary", 300) ?? "Untitled",
                description: textOf(component, "description", 8000),
                location: textOf(component, "location", 500),
                url: cleanUrl(component.getFirstPropertyValue("url")),
                ...times,
                rrule: null,
                exdates: [],
                rdates: [],
                visibility: "default",
                showAs: "busy",
                status: status === "TENTATIVE" ? "tentative" : "confirmed",
                overrides: [],
            });
            continue;
        }
        const ridProp = component.getFirstProperty("recurrence-id")!;
        const key = keyFor(ridProp.getFirstValue() as ICAL.Time, ridProp.getParameter("tzid") as string | null, master, timezones);
        if (status === "CANCELLED") {
            master.overrides.push({ key, cancelled: true, fields: {} });
            continue;
        }
        const fields: OverrideFields = {};
        const title = textOf(component, "summary", 300);
        if (title && title !== master.title) fields.title = title;
        const description = textOf(component, "description", 8000);
        if (description !== master.description) fields.description = description;
        const location = textOf(component, "location", 500);
        if (location !== master.location) fields.location = location;
        if (times) {
            const wallStart = times.allDay || times.timeZone === master.timeZone ? times : moveZone(times, master.timeZone);
            if (wallStart.allDay !== master.allDay) fields.allDay = wallStart.allDay;
            fields.startDate = wallStart.startDate;
            fields.startTime = wallStart.startTime;
            fields.endDate = wallStart.endDate;
            fields.endTime = wallStart.endTime;
        }
        if (status === "TENTATIVE") fields.status = "tentative";
        master.overrides.push({ key, cancelled: false, fields });
    }

    return { name: cleanText(root.getFirstPropertyValue("x-wr-calname"), 100), timeZone: declared, events: [...masters.values()], skipped };
}

/** The same moment as wall clock in another zone. */
function moveZone(t: Times, zone: string): Times {
    const start = wallClock(zonedInstant(t.startDate, t.startTime!, t.timeZone), zone);
    const end = wallClock(zonedInstant(t.endDate, t.endTime!, t.timeZone), zone);
    return { ...t, startDate: start.date, startTime: start.time, endDate: end.date, endTime: end.time, timeZone: zone };
}

/** A short, stable, non-cryptographic hash (FNV-1a) for ids and change detection. */
export function hashString(text: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
}

// --- Writing -------------------------------------------------------------------------------------

export interface SerialOverride {
    key: string;
    cancelled: boolean;
    title: string;
    description: string | null;
    location: string | null;
    allDay: boolean;
    startDate: string;
    startTime: string | null;
    endDate: string;
    endTime: string | null;
}

export interface SerialEvent {
    uid: string;
    title: string;
    description: string | null;
    location: string | null;
    url: string | null;
    allDay: boolean;
    startDate: string;
    startTime: string | null;
    endDate: string;
    endTime: string | null;
    timeZone: string;
    rrule: string | null;
    exdates: string[];
    rdates?: string[];
    status: "confirmed" | "tentative" | "cancelled";
    showAs: "busy" | "free";
    private: boolean;
    categories?: string[];
    updatedAt: string;
    overrides?: SerialOverride[];
}

/** Escapes TEXT values (RFC 5545 §3.3.11). */
export const escapeText = (value: string) => value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

/** Folds a content line at 75 octets without splitting a UTF-8 character. */
export function fold(line: string): string {
    const encoder = new TextEncoder();
    if (encoder.encode(line).length <= 75) return line;
    const parts: string[] = [];
    let current = "";
    let bytes = 0;
    for (const char of line) {
        const size = encoder.encode(char).length;
        if (bytes + size > (parts.length ? 74 : 75)) {
            parts.push(current);
            current = "";
            bytes = 0;
        }
        current += char;
        bytes += size;
    }
    parts.push(current);
    return parts.join("\r\n ");
}

const compactDate = (date: string) => date.replaceAll("-", "");
const localDateTime = (date: string, time: string) => `${compactDate(date)}T${time.replace(":", "")}00`;
const utcStamp = (iso: string) => `${iso.slice(0, 19).replaceAll("-", "").replaceAll(":", "")}Z`;

function timeLines(name: "DTSTART" | "DTEND" | "RECURRENCE-ID", allDay: boolean, date: string, time: string | null, zone: string): string {
    if (allDay) return `${name};VALUE=DATE:${compactDate(date)}`;
    if (zone === "UTC") return `${name}:${localDateTime(date, time!)}Z`;
    return `${name};TZID=${zone}:${localDateTime(date, time!)}`;
}

/** STANDARD/DAYLIGHT components for an IANA zone between two years, from Intl's own transitions. */
export function vtimezone(zone: string, fromYear: number, toYear: number): string[] {
    const lines = ["BEGIN:VTIMEZONE", `TZID:${zone}`];
    const start = Date.UTC(fromYear, 0, 1);
    const end = Date.UTC(toYear + 1, 0, 1);
    const fmt = (m: number) => `${m < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(m) / 60))}${pad(Math.abs(m) % 60)}`;
    const transitions: { at: number; from: number; to: number }[] = [];
    let previous = zoneOffsetMinutes(zone, start);
    for (let t = start + 86_400_000; t <= end; t += 86_400_000) {
        const offset = zoneOffsetMinutes(zone, t);
        if (offset === previous) continue;
        // Narrow to the minute it changed.
        let lo = t - 86_400_000;
        let hi = t;
        while (hi - lo > 60_000) {
            const mid = lo + Math.floor((hi - lo) / 120_000) * 60_000;
            if (zoneOffsetMinutes(zone, mid) === previous) lo = mid;
            else hi = mid;
        }
        transitions.push({ at: hi, from: previous, to: offset });
        previous = offset;
    }
    if (!transitions.length) {
        lines.push("BEGIN:STANDARD", "DTSTART:19700101T000000", `TZOFFSETFROM:${fmt(previous)}`, `TZOFFSETTO:${fmt(previous)}`, "END:STANDARD");
    } else {
        const standard = Math.min(...transitions.map((x) => Math.min(x.from, x.to)));
        for (const x of transitions) {
            const kind = x.to > standard ? "DAYLIGHT" : "STANDARD";
            const wall = new Date(x.at + x.from * 60_000).toISOString();
            lines.push(
                `BEGIN:${kind}`,
                `DTSTART:${wall.slice(0, 19).replaceAll("-", "").replaceAll(":", "")}`,
                `TZOFFSETFROM:${fmt(x.from)}`,
                `TZOFFSETTO:${fmt(x.to)}`,
                `END:${kind}`,
            );
        }
    }
    lines.push("END:VTIMEZONE");
    return lines;
}

const VTIMEZONE_CACHE = new Map<string, string[]>();

/** A whole VCALENDAR. */
export function serializeCalendar(options: { name: string; description?: string; events: SerialEvent[]; refreshHours?: number }): string {
    const now = utcStamp(new Date().toISOString());
    const lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Daly Portal//Daly Calendar//EN",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        `X-WR-CALNAME:${escapeText(options.name)}`,
    ];
    if (options.description) lines.push(`X-WR-CALDESC:${escapeText(options.description)}`);
    if (options.refreshHours) lines.push(`REFRESH-INTERVAL;VALUE=DURATION:PT${options.refreshHours}H`, `X-PUBLISHED-TTL:PT${options.refreshHours}H`);
    const zones = new Set(options.events.filter((e) => !e.allDay && e.timeZone !== "UTC").map((e) => e.timeZone));
    const years = options.events.map((e) => Number(e.startDate.slice(0, 4)));
    const thisYear = new Date().getUTCFullYear();
    const from = Math.max(Math.min(thisYear - 1, ...years), thisYear - 20);
    const to = thisYear + 10;
    for (const zone of zones) {
        const cacheKey = `${zone}:${from}:${to}`;
        let block = VTIMEZONE_CACHE.get(cacheKey);
        if (!block) {
            block = vtimezone(zone, from, to);
            VTIMEZONE_CACHE.set(cacheKey, block);
        }
        lines.push(...block);
    }
    for (const e of options.events) {
        const common = (title: string, description: string | null, location: string | null) => {
            const out = [`SUMMARY:${escapeText(title)}`];
            if (description) out.push(`DESCRIPTION:${escapeText(description)}`);
            if (location) out.push(`LOCATION:${escapeText(location)}`);
            return out;
        };
        const endOf = (allDay: boolean, endDate: string, endTime: string | null, zone: string) =>
            allDay ? timeLines("DTEND", true, addDays(endDate, 1), null, zone) : timeLines("DTEND", false, endDate, endTime, zone);
        lines.push(
            "BEGIN:VEVENT",
            `UID:${escapeText(e.uid)}`,
            `DTSTAMP:${now}`,
            `LAST-MODIFIED:${utcStamp(e.updatedAt)}`,
            timeLines("DTSTART", e.allDay, e.startDate, e.startTime, e.timeZone),
            endOf(e.allDay, e.endDate, e.endTime, e.timeZone),
            ...common(e.title, e.description, e.location),
        );
        if (e.url) lines.push(`URL:${e.url}`);
        if (e.rrule) lines.push(`RRULE:${e.rrule}`);
        const keyLine = (name: "EXDATE" | "RDATE", key: string) =>
            key.length === 10 ? `${name};VALUE=DATE:${compactDate(key)}` : timeLines(name as "DTSTART", false, key.slice(0, 10), key.slice(11), e.timeZone);
        if (e.rrule) for (const key of e.exdates) lines.push(keyLine("EXDATE", key));
        if (e.rrule) for (const key of e.rdates ?? []) lines.push(keyLine("RDATE", key));
        if (e.categories?.length) lines.push(`CATEGORIES:${e.categories.map(escapeText).join(",")}`);
        lines.push(
            `STATUS:${e.status.toUpperCase()}`,
            `TRANSP:${e.showAs === "free" ? "TRANSPARENT" : "OPAQUE"}`,
            `CLASS:${e.private ? "PRIVATE" : "PUBLIC"}`,
            "END:VEVENT",
        );
        for (const o of e.overrides ?? []) {
            const rid =
                o.key.length === 10
                    ? `RECURRENCE-ID;VALUE=DATE:${compactDate(o.key)}`
                    : timeLines("RECURRENCE-ID", false, o.key.slice(0, 10), o.key.slice(11), e.timeZone);
            lines.push(
                "BEGIN:VEVENT",
                `UID:${escapeText(e.uid)}`,
                `DTSTAMP:${now}`,
                rid,
                timeLines("DTSTART", o.allDay, o.startDate, o.startTime, e.timeZone),
                endOf(o.allDay, o.endDate, o.endTime, e.timeZone),
                ...common(o.title, o.description, o.location),
                `STATUS:${o.cancelled ? "CANCELLED" : e.status.toUpperCase()}`,
                `CLASS:${e.private ? "PRIVATE" : "PUBLIC"}`,
                "END:VEVENT",
            );
        }
    }
    lines.push("END:VCALENDAR");
    return `${lines.map(fold).join("\r\n")}\r\n`;
}

/** An event's length in wall minutes (helper for callers building overrides). */
export const durationMinutes = (e: { startDate: string; startTime: string; endDate: string; endTime: string }) =>
    wallMinutes(e.startDate, e.startTime, e.endDate, e.endTime);
