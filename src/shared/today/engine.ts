// Today's arithmetic: daily capacity, overbooked periods, the combined timeline and the Chief of
// Staff's recommended next actions. Pure functions of their inputs, like the availability they build
// on (./availability.ts), so the page, the Worker and MCP always agree, and the same inputs always
// give the same answer. Nothing here writes or calls a model.
//
// Overlaps are handled with interval unions: two meetings at the same time take that time once. Every
// figure comes with a plain explanation of how it was worked out.
import { addDays, timeLabel, wallClock, zonedInstant } from "../calendar/time";
import { type Availability, type Commitment, type Interval, freeTime, intersect, merge, subtract } from "./availability";
import type { BriefingRef, DayTimeline, NextAction, Overbooked, TimelineItem, TodayCapacity } from "./types";

const MINUTE = 60_000;
const ms = (iso: string) => Date.parse(iso);
const iso = (value: number) => new Date(value).toISOString();
const minutes = (i: Interval) => Math.round((i.end - i.start) / MINUTE);
const total = (list: readonly Interval[]) => list.reduce((s, i) => s + minutes(i), 0);
const span = (c: { start: string; end: string }): Interval => ({ start: ms(c.start), end: ms(c.end) });

export const hoursLabel = (m: number) => {
    const h = Math.floor(m / 60);
    const r = m % 60;
    return h ? (r ? `${h} h ${r} min` : `${h} h`) : `${r} min`;
};

const clockOf = (value: number, timeZone: string) => wallClock(new Date(value), timeZone).time;
const range = (i: Interval, timeZone: string) => `${timeLabel(clockOf(i.start, timeZone))}–${timeLabel(clockOf(i.end, timeZone))}`;

/**
 * Where two or more busy commitments overlap, as merged periods, with what overlaps there. A sweep
 * over start and end points: depth two or more is overbooked.
 */
export function overbooked(commitments: readonly Commitment[], timeZone: string): Overbooked[] {
    // Sorted first, so the result doesn't depend on the order commitments arrive in.
    const busy = commitments
        .filter((c) => c.busy && ms(c.end) > ms(c.start))
        .sort((a, b) => ms(a.start) - ms(b.start) || ms(a.end) - ms(b.end) || a.id.localeCompare(b.id));
    const points = busy.flatMap((c, i) => [
        { at: ms(c.start), delta: 1, i },
        { at: ms(c.end), delta: -1, i },
    ]);
    // Ends before starts at the same instant: back-to-back isn't an overlap.
    points.sort((a, b) => a.at - b.at || a.delta - b.delta || a.i - b.i);
    const raw: (Interval & { ids: Set<number> })[] = [];
    const open = new Set<number>();
    let from = 0;
    for (const p of points) {
        if (open.size >= 2 && p.at > from) raw.push({ start: from, end: p.at, ids: new Set(open) });
        if (p.delta > 0) open.add(p.i);
        else open.delete(p.i);
        from = p.at;
    }
    // Join touching pieces into one period.
    const joined: (Interval & { ids: Set<number> })[] = [];
    for (const r of raw) {
        const last = joined[joined.length - 1];
        if (last && r.start <= last.end) {
            last.end = Math.max(last.end, r.end);
            r.ids.forEach((id) => last.ids.add(id));
        } else joined.push({ ...r, ids: new Set(r.ids) });
    }
    return joined.map((r) => ({
        start: iso(r.start),
        end: iso(r.end),
        startTime: clockOf(r.start, timeZone),
        endTime: clockOf(r.end, timeZone),
        minutes: minutes(r),
        with: [...r.ids].sort((a, b) => a - b).map((i) => ({ id: busy[i].id, title: busy[i].title })),
    }));
}

/**
 * A day's capacity. Planning hours come from availability (working hours less leave, public holidays,
 * non-working days and breaks); appointments are a union inside them; free time is what's left.
 */
export function dayCapacity(day: Availability, commitments: readonly Commitment[], timeZone: string): TodayCapacity {
    const window = day.window;
    const events = merge(commitments.filter((c) => c.busy).map(span));
    const available = total(window);
    const appointment = total(intersect(window, events));
    const free = available - appointment;
    const breakMinutes = total(day.breaks ?? []);
    // Appointments that day (local midnight to midnight) outside the hours.
    const whole = [{ start: ms(zonedInstant(day.date, "00:00", timeZone)), end: ms(zonedInstant(addDays(day.date, 1), "00:00", timeZone)) }];
    const outside = total(subtract(intersect(events, whole), window));
    const over = overbooked(commitments, timeZone);
    const overMinutes = total(merge(over.map(span)));

    let status: TodayCapacity["status"];
    if (!available) status = "off";
    else if (overMinutes > 0) status = "over";
    else if (free < available * 0.2) status = "full";
    else if (appointment < available * 0.5) status = "light";
    else status = "balanced";

    const explanation: string[] = [];
    if (!available) explanation.push(day.offReason ? `No planning hours: ${day.offReason}.` : "No planning hours this day.");
    else {
        const hours = (day.configured.length ? day.configured : window).map((i) => range(i, timeZone)).join(", ");
        explanation.push(`Planning hours ${hours}.`);
        if (day.breaks?.length)
            explanation.push(`Less breaks: ${day.breaks.map((b) => `${b.label} ${range(b, timeZone)}`).join(", ")} (${hoursLabel(breakMinutes)}).`);
        const cut = total(day.configured) - available - breakMinutes;
        if (cut > 0) explanation.push(`Less ${hoursLabel(cut)} of leave.`);
        explanation.push(`${hoursLabel(available)} available.`);
        explanation.push(`Appointments take ${hoursLabel(appointment)} of it${events.length > 1 ? " (overlapping appointments counted once)" : ""}.`);
        explanation.push(`${hoursLabel(free)} free.`);
    }
    if (outside) explanation.push(`${hoursLabel(outside)} of appointments fall outside the planning hours and don't reduce them.`);
    if (over.length)
        explanation.push(`Overbooked for ${hoursLabel(overMinutes)}: ${over.map((o) => `${timeLabel(o.startTime)}–${timeLabel(o.endTime)}`).join(", ")}.`);

    return {
        date: day.date,
        availableMinutes: available,
        appointmentMinutes: appointment,
        freeMinutes: free,
        breakMinutes,
        outsideMinutes: outside,
        overbooked: over,
        overbookedMinutes: overMinutes,
        status,
        offReason: available ? null : day.offReason,
        explanation,
    };
}

// --- Timeline ------------------------------------------------------------------------------------

export interface TimelineEvent {
    id: string;
    title: string;
    start: string;
    end: string;
    allDay: boolean;
    busy: boolean;
    /** Its calendar counts towards availability. */
    counts: boolean;
    readOnly: boolean;
    shared: boolean;
    detail: string | null;
    url: string;
}

export interface TimelineInputs {
    date: string;
    timeZone: string;
    day: Availability;
    events: readonly TimelineEvent[];
    commitments: readonly Commitment[];
    bufferMinutes: number;
    leave: readonly { id: string; title: string; allDay: boolean; url: string | null }[];
    holidays: readonly { id: string; title: string }[];
    /** Free time before this isn't shown (now, on today). */
    after: number;
}

const fixedItem = (item: Omit<TimelineItem, "readOnly" | "busy" | "shared" | "conflict" | "url"> & Partial<TimelineItem>): TimelineItem => ({
    readOnly: true,
    busy: false,
    shared: false,
    conflict: false,
    url: null,
    ...item,
});

/**
 * The day as one ordered list: events, breaks, part-day leave and free time, in time order. Events
 * from subscribed or imported calendars, and events the person can't edit, are marked read-only:
 * Today never changes them. Events in an overbooked period are marked as conflicts.
 */
export function dayTimeline(input: TimelineInputs): DayTimeline {
    const { timeZone } = input;
    const local = (value: string) => wallClock(new Date(value), timeZone).time;
    const conflicted = new Set(overbooked(input.commitments, timeZone).flatMap((o) => o.with.map((w) => w.id)));
    const items: TimelineItem[] = [];
    for (const e of input.events) {
        if (e.allDay) continue;
        items.push({
            id: e.id,
            kind: "event",
            title: e.title,
            start: e.start,
            end: e.end,
            startTime: local(e.start),
            endTime: local(e.end),
            minutes: minutes(span(e)),
            readOnly: e.readOnly,
            busy: e.busy && e.counts,
            shared: e.shared,
            conflict: conflicted.has(e.id),
            detail: [!e.busy ? "Shows as free" : !e.counts ? "Doesn't count towards availability" : null, e.detail].filter(Boolean).join(" · ") || null,
            url: e.url,
        });
    }
    for (const br of input.day.breaks ?? []) {
        items.push(
            fixedItem({
                id: `break:${br.start}`,
                kind: "break",
                title: br.label,
                start: iso(br.start),
                end: iso(br.end),
                startTime: clockOf(br.start, timeZone),
                endTime: clockOf(br.end, timeZone),
                minutes: minutes(br),
                detail: "Break",
            }),
        );
    }
    // Part-day leave shows as the hours it removed.
    const leaveCut = subtract(input.day.configured, [...input.day.window, ...(input.day.breaks ?? [])]);
    if (input.day.window.length)
        for (const l of leaveCut)
            items.push(
                fixedItem({
                    id: `leave:${l.start}`,
                    kind: "leave",
                    title: "Leave",
                    start: iso(l.start),
                    end: iso(l.end),
                    startTime: clockOf(l.start, timeZone),
                    endTime: clockOf(l.end, timeZone),
                    minutes: minutes(l),
                    detail: "Unavailable",
                    url: "/portal/calendar/leave",
                }),
            );
    for (const f of freeTime(input.day.window, input.commitments, input.bufferMinutes, input.after)) {
        if (minutes(f) < 15) continue;
        items.push(
            fixedItem({
                id: `free:${f.start}`,
                kind: "free",
                title: "Free",
                start: iso(f.start),
                end: iso(f.end),
                startTime: clockOf(f.start, timeZone),
                endTime: clockOf(f.end, timeZone),
                minutes: minutes(f),
                detail: null,
            }),
        );
    }
    const order: Record<TimelineItem["kind"], number> = { leave: 0, break: 1, event: 2, free: 3 };
    items.sort((a, b) => a.start.localeCompare(b.start) || order[a.kind] - order[b.kind] || a.end.localeCompare(b.end) || a.id.localeCompare(b.id));
    const allDay: DayTimeline["allDay"] = [
        ...input.holidays.map((h) => ({ id: h.id, title: h.title, kind: "holiday" as const, url: null })),
        ...input.leave.filter((l) => l.allDay).map((l) => ({ id: l.id, title: l.title, kind: "leave" as const, url: l.url })),
        ...input.events.filter((e) => e.allDay).map((e) => ({ id: e.id, title: e.title, kind: "event" as const, url: e.url })),
    ];
    return {
        date: input.date,
        timeZone,
        hours: input.day.window.map((i) => ({ start: clockOf(i.start, timeZone), end: clockOf(i.end, timeZone) })),
        allDay,
        items,
    };
}

// --- Recommended next actions ----------------------------------------------------------------------

export interface NextActionFacts {
    isToday: boolean;
    now: number;
    conflicts: BriefingRef[];
    freeMinutes: number;
    availableMinutes: number;
    nextCommitment: (BriefingRef & { start: string }) | null;
}

/**
 * Recommended next actions, by fixed rules over the facts (never a model): each one names the
 * records it's about. The order is fixed, so the same facts always give the same list.
 */
export function nextActions(f: NextActionFacts): NextAction[] {
    const out: NextAction[] = [];
    const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
    if (f.isToday && f.nextCommitment) {
        const inMinutes = Math.round((ms(f.nextCommitment.start) - f.now) / MINUTE);
        if (inMinutes >= 0 && inMinutes <= 60)
            out.push({
                id: `next:${f.nextCommitment.id}`,
                text: `Get ready for ${f.nextCommitment.title}, in ${hoursLabel(inMinutes)}.`,
                refs: [f.nextCommitment],
            });
    }
    if (f.conflicts.length) out.push({ id: "conflicts", text: `Resolve ${plural(f.conflicts.length, "scheduling conflict")}.`, refs: f.conflicts.slice(0, 6) });
    if (f.availableMinutes > 0 && f.freeMinutes <= 0) out.push({ id: "full", text: "Your planning hours are fully booked: protect a break.", refs: [] });
    // A briefing never has nothing to say, but it never makes something up either.
    if (!out.length) out.push({ id: "clear", text: "Nothing needs attention.", refs: [] });
    return out;
}
