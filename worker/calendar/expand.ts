// Expanding events into occurrences for a window of time, with ical.js doing the RFC 5545 work.
//
// A series is iterated in floating local time (its own wall clock), then each occurrence is turned
// into instants in the event's IANA zone with Intl. That's what keeps a weekly 9 am at 9 am across
// daylight-saving changes, and what makes "the last Friday of the month" land on the right date.
// Excluded dates, added dates and single-occurrence overrides (local edits and feeds' RECURRENCE-ID
// instances) are applied by occurrence key. Everything is bounded: a rule that would produce more
// than the limit stops there, and the caller is told.
import ICAL from "ical.js";
import { UNSUPPORTED_FREQUENCIES } from "../../src/shared/calendar/recurrence";
import { FOREVER, addDays, addWallMinutes, daysBetween, occurrenceKey, wallMinutes, zonedInstant } from "../../src/shared/calendar/time";
import { parseJson } from "../portal/db";

export interface EventTimes {
    all_day: number;
    start_date: string;
    start_time: string | null;
    end_date: string;
    end_time: string | null;
    time_zone: string;
    rrule: string | null;
    rdates: string | null;
    exdates: string | null;
}

export interface OverrideFields {
    title?: string;
    description?: string | null;
    location?: string | null;
    allDay?: boolean;
    startDate?: string;
    startTime?: string | null;
    endDate?: string;
    endTime?: string | null;
    status?: "confirmed" | "tentative" | "cancelled";
}

export interface OverrideRow {
    event_id: string;
    occurrence_key: string;
    cancelled: number;
    fields: string;
    start_at: string | null;
    end_at: string | null;
}

export interface RawOccurrence {
    key: string;
    allDay: boolean;
    startDate: string;
    startTime: string | null;
    endDate: string;
    endTime: string | null;
    startAt: string;
    endAt: string;
    overridden: boolean;
    fields: OverrideFields | null;
}

/** The instants of a local start and end: all-day ends at the start of the day after its last day. */
export function instants(allDay: boolean, startDate: string, startTime: string | null, endDate: string, endTime: string | null, timeZone: string) {
    return allDay
        ? { startAt: zonedInstant(startDate, "00:00", timeZone), endAt: zonedInstant(addDays(endDate, 1), "00:00", timeZone) }
        : { startAt: zonedInstant(startDate, startTime!, timeZone), endAt: zonedInstant(endDate, endTime!, timeZone) };
}

/** Whether ical.js will expand this rule (sub-daily rules from feeds are treated as single events). */
export function usableRule(rrule: string | null): ICAL.Recur | null {
    if (!rrule) return null;
    try {
        const recur = ICAL.Recur.fromString(rrule);
        if (UNSUPPORTED_FREQUENCIES.includes(recur.freq)) return null;
        return recur;
    } catch {
        return null;
    }
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * ical.js rolls an impossible date forward (a yearly 29 February becomes 1 March, a monthly 31st
 * the 1st of the next month). RFC 5545 says such occurrences don't happen, and that's what Google
 * and Apple show, so a rule without its own BY… parts must land on the start's own day (and month).
 */
function impossibleDateFilter(recur: ICAL.Recur, rrule: string, start: string) {
    if (/;?BY(DAY|MONTHDAY|YEARDAY|WEEKNO|SETPOS|MONTH)=/.test(rrule)) return () => true;
    const [month, day] = [Number(start.slice(5, 7)), Number(start.slice(8, 10))];
    if (recur.freq === "YEARLY") return (t: ICAL.Time) => t.month === month && t.day === day;
    if (recur.freq === "MONTHLY") return (t: ICAL.Time) => t.day === day;
    return () => true;
}
const localOf = (t: ICAL.Time) => ({ date: `${t.year}-${pad(t.month)}-${pad(t.day)}`, time: t.isDate ? null : `${pad(t.hour)}:${pad(t.minute)}` });

function shape(row: EventTimes) {
    const allDay = !!row.all_day;
    // Length as people think of it: whole days, or wall-clock minutes.
    const spanDays = daysBetween(row.start_date, row.end_date);
    const spanMinutes = allDay ? 0 : wallMinutes(row.start_date, row.start_time!, row.end_date, row.end_time!);
    return { allDay, spanDays, spanMinutes };
}

function occurrenceAt(row: EventTimes, date: string, time: string | null): Omit<RawOccurrence, "key" | "overridden" | "fields"> {
    const { allDay, spanDays, spanMinutes } = shape(row);
    if (allDay) {
        const endDate = addDays(date, spanDays);
        return { allDay, startDate: date, startTime: null, endDate, endTime: null, ...instants(true, date, null, endDate, null, row.time_zone) };
    }
    const end = addWallMinutes(date, time!, spanMinutes);
    return {
        allDay,
        startDate: date,
        startTime: time,
        endDate: end.date,
        endTime: end.time,
        ...instants(false, date, time, end.date, end.time, row.time_zone),
    };
}

/** An occurrence with a single-occurrence edit applied (it may have moved, changed length or become all-day). */
function applyOverride(
    row: EventTimes,
    base: Omit<RawOccurrence, "key" | "overridden" | "fields">,
    fields: OverrideFields,
): Omit<RawOccurrence, "key" | "overridden" | "fields"> {
    if (fields.startDate === undefined && fields.allDay === undefined && fields.startTime === undefined) return base;
    const allDay = fields.allDay ?? base.allDay;
    const startDate = fields.startDate ?? base.startDate;
    const endDate = fields.endDate ?? (allDay ? startDate : base.endDate);
    const startTime = allDay ? null : (fields.startTime ?? base.startTime ?? "09:00");
    const endTime = allDay ? null : (fields.endTime ?? base.endTime ?? "10:00");
    return { allDay, startDate, startTime, endDate, endTime, ...instants(allDay, startDate, startTime, endDate, endTime, row.time_zone) };
}

export interface Window {
    /** Instants [start, end). */
    start: string;
    end: string;
}

/**
 * The occurrences of one event overlapping a window. `limit` caps the result; `truncated` says it
 * was reached. Iteration itself is capped too, so a pathological rule can't run away.
 */
export function expand(row: EventTimes, overrides: readonly OverrideRow[], window: Window, limit = 2000): { occurrences: RawOccurrence[]; truncated: boolean } {
    const byKey = new Map(overrides.map((o) => [o.occurrence_key, o]));
    const excluded = new Set(parseJson<string[]>(row.exdates, []));
    const out: RawOccurrence[] = [];
    const seen = new Set<string>();
    let truncated = false;

    const consider = (date: string, time: string | null) => {
        const key = occurrenceKey(date, time);
        if (seen.has(key)) return;
        seen.add(key);
        if (excluded.has(key)) return;
        const base = occurrenceAt(row, date, time);
        const override = byKey.get(key);
        if (override?.cancelled) return;
        const fields = override ? parseJson<OverrideFields>(override.fields, {}) : null;
        if (fields?.status === "cancelled") return;
        const occ = fields ? applyOverride(row, base, fields) : base;
        if (occ.startAt < window.end && occ.endAt > window.start) {
            if (out.length >= limit) truncated = true;
            else out.push({ key, ...occ, overridden: !!override, fields });
        }
    };

    const recur = usableRule(row.rrule);
    if (!recur) {
        consider(row.start_date, row.all_day ? null : row.start_time);
    } else {
        const [y, m, d] = row.start_date.split("-").map(Number);
        const [hh, mm] = row.all_day ? [0, 0] : row.start_time!.split(":").map(Number);
        const dtstart = ICAL.Time.fromData({ year: y, month: m, day: d, hour: hh, minute: mm, second: 0, isDate: !!row.all_day });
        const iterator = recur.iterator(dtstart);
        const possible = impossibleDateFilter(recur, row.rrule!, row.start_date);
        const { spanDays, spanMinutes } = shape(row);
        // Anything starting this long before the window can't reach into it.
        const reach = row.all_day ? (spanDays + 2) * 86_400_000 : (spanMinutes + 1440) * 60_000;
        const earliest = new Date(Date.parse(window.start) - reach).toISOString();
        for (let steps = 0; steps < 50_000; steps++) {
            const next = iterator.next();
            if (!next) break;
            if (!possible(next)) continue;
            const local = localOf(next);
            const startAt = row.all_day ? zonedInstant(local.date, "00:00", row.time_zone) : zonedInstant(local.date, local.time!, row.time_zone);
            if (startAt >= window.end) break;
            if (startAt < earliest) continue;
            consider(local.date, row.all_day ? null : local.time);
            if (truncated) break;
        }
        for (const extra of parseJson<string[]>(row.rdates, [])) {
            const [date, time] = extra.split("T");
            consider(date, row.all_day ? null : (time ?? row.start_time));
        }
    }
    // Occurrences moved into the window from outside it.
    for (const o of overrides) {
        if (seen.has(o.occurrence_key) || o.cancelled || !o.start_at || !o.end_at) continue;
        if (!(o.start_at < window.end && o.end_at > window.start)) continue;
        const [date, time] = o.occurrence_key.split("T");
        consider(date, time ?? null);
    }
    out.sort((a, b) => a.startAt.localeCompare(b.startAt));
    return { occurrences: out, truncated };
}

/**
 * The end of a series' last occurrence (for window queries), or FOREVER for one without an end.
 * Rules that end are walked to the end once, when the event is saved.
 */
export function seriesEndAt(row: EventTimes): string {
    const { endAt } = instants(!!row.all_day, row.start_date, row.start_time, row.end_date, row.end_time, row.time_zone);
    const recur = usableRule(row.rrule);
    if (!recur) return endAt;
    if (!recur.count && !recur.until) return FOREVER;
    const [y, m, d] = row.start_date.split("-").map(Number);
    const [hh, mm] = row.all_day ? [0, 0] : row.start_time!.split(":").map(Number);
    const iterator = recur.iterator(ICAL.Time.fromData({ year: y, month: m, day: d, hour: hh, minute: mm, second: 0, isDate: !!row.all_day }));
    const possible = impossibleDateFilter(recur, row.rrule!, row.start_date);
    let last: { date: string; time: string | null } | null = null;
    for (let steps = 0; steps < 50_000; steps++) {
        const next = iterator.next();
        if (!next) break;
        if (possible(next)) last = localOf(next);
    }
    // Still going after the cap: treat it as unending rather than cutting it short.
    if (!last || iterator.next()) return FOREVER;
    let end = occurrenceAt(row, last.date, row.all_day ? null : last.time).endAt;
    for (const extra of parseJson<string[]>(row.rdates, [])) {
        const [date, time] = extra.split("T");
        const candidate = occurrenceAt(row, date, row.all_day ? null : (time ?? row.start_time)).endAt;
        if (candidate > end) end = candidate;
    }
    return end > endAt ? end : endAt;
}

/** How many occurrences of a counted series start before an occurrence key (to split "this and following"). */
export function occurrencesBefore(row: EventTimes, key: string): number {
    const recur = usableRule(row.rrule);
    if (!recur) return 0;
    const [y, m, d] = row.start_date.split("-").map(Number);
    const [hh, mm] = row.all_day ? [0, 0] : row.start_time!.split(":").map(Number);
    const iterator = recur.iterator(ICAL.Time.fromData({ year: y, month: m, day: d, hour: hh, minute: mm, second: 0, isDate: !!row.all_day }));
    const possible = impossibleDateFilter(recur, row.rrule!, row.start_date);
    let n = 0;
    for (let steps = 0; steps < 50_000; steps++) {
        const next = iterator.next();
        if (!next) break;
        if (!possible(next)) continue;
        const local = localOf(next);
        if (occurrenceKey(local.date, row.all_day ? null : local.time) >= key) break;
        n++;
    }
    return n;
}

/** Whether a key is one of the series' own occurrences (before exclusions). */
export function isSeriesOccurrence(row: EventTimes, key: string): boolean {
    const recur = usableRule(row.rrule);
    const date = key.slice(0, 10);
    if (!recur) return key === occurrenceKey(row.start_date, row.all_day ? null : row.start_time);
    if (parseJson<string[]>(row.rdates, []).includes(key)) return true;
    const time = key.length > 10 ? key.slice(11) : null;
    const startAt = zonedInstant(date, time ?? "00:00", row.time_zone);
    const window = { start: startAt, end: new Date(Date.parse(startAt) + 60_000).toISOString() };
    return expand({ ...row, exdates: null }, [], window, 5).occurrences.some((o) => o.key === key);
}
