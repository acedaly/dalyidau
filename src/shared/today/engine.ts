// Today's arithmetic: daily capacity, overbooked periods, the combined timeline and the Chief of
// Staff's recommended next actions. Pure functions of their inputs, like the planner engine they build
// on (src/shared/planner/engine.ts), so the page, the Worker and MCP always agree, and the same
// inputs always give the same answer. Nothing here writes or calls a model.
//
// Overlaps are handled with interval unions: two meetings at the same time take that time once, and a
// task session over a meeting isn't counted again as task time. Every figure comes with a plain
// explanation of how it was worked out.
import { addDays, timeLabel, wallClock, zonedInstant } from "../calendar/time";
import { type Availability, type Commitment, type Interval, type WeeklyPeriod, freeTime, intersect, merge, periodOn, subtract } from "../planner/engine";
import type { PlannerConflict, PlannerPreferences, TimeBlockInfo } from "../planner/types";
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
        with: [...r.ids].sort((a, b) => a - b).map((i) => ({ id: busy[i].id, title: busy[i].title, kind: busy[i].kind })),
    }));
}

/**
 * A day's capacity. Planning hours come from availability (working hours less leave, public holidays,
 * non-working days and breaks); appointments and task sessions are unions inside them, sessions
 * counted only where they don't overlap an appointment; free time is what's left.
 */
export function dayCapacity(
    day: Availability,
    commitments: readonly Commitment[],
    prefs: PlannerPreferences,
    unscheduledMinutes: number,
    timeZone: string,
): TodayCapacity {
    const window = day.window;
    const busy = commitments.filter((c) => c.busy);
    const events = merge(busy.filter((c) => c.kind === "event").map(span));
    const blocks = merge(busy.filter((c) => c.kind === "block").map(span));
    const all = merge([...events, ...blocks]);
    const available = total(window);
    const appointment = total(intersect(window, events));
    const task = total(intersect(window, subtract(blocks, events)));
    const committed = total(intersect(window, all));
    const free = available - committed;
    const breakMinutes = total(day.breaks ?? []);
    // Commitments that day (local midnight to midnight) outside the hours.
    const whole = [{ start: ms(zonedInstant(day.date, "00:00", timeZone)), end: ms(zonedInstant(addDays(day.date, 1), "00:00", timeZone)) }];
    const outside = total(subtract(intersect(all, whole), window));
    const over = overbooked(commitments, timeZone);
    const overMinutes = total(merge(over.map(span)));
    const shortfall = Math.max(0, unscheduledMinutes - Math.max(0, Math.min(free, prefs.dailyFocusMinutes - task)));

    let status: TodayCapacity["status"];
    if (!available) status = "off";
    else if (shortfall > 0 || overMinutes > 0) status = "over";
    else if (free < available * 0.2 || task >= prefs.dailyFocusMinutes) status = "full";
    else if (committed < available * 0.5) status = "light";
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
        explanation.push(
            `Appointments take ${hoursLabel(appointment)} of it${events.length > 1 ? " (overlapping appointments counted once)" : ""}; task sessions take ${hoursLabel(task)} more${
                total(intersect(window, blocks)) > task ? " (the parts over appointments aren't counted twice)" : ""
            }.`,
        );
        explanation.push(`${hoursLabel(free)} free.`);
    }
    if (outside) explanation.push(`${hoursLabel(outside)} of commitments fall outside the planning hours and don't reduce them.`);
    if (over.length)
        explanation.push(`Overbooked for ${hoursLabel(overMinutes)}: ${over.map((o) => `${timeLabel(o.startTime)}–${timeLabel(o.endTime)}`).join(", ")}.`);
    if (unscheduledMinutes)
        explanation.push(
            `${hoursLabel(unscheduledMinutes)} of estimated work is due and not yet planned${
                shortfall ? `; ${hoursLabel(shortfall)} of it doesn't fit in the free time and daily focus limit` : ""
            }.`,
        );

    return {
        date: day.date,
        availableMinutes: available,
        appointmentMinutes: appointment,
        taskMinutes: task,
        committedMinutes: committed,
        freeMinutes: free,
        breakMinutes,
        outsideMinutes: outside,
        overbooked: over,
        overbookedMinutes: overMinutes,
        unscheduledMinutes,
        shortfallMinutes: shortfall,
        focusLimitMinutes: prefs.dailyFocusMinutes,
        status,
        offReason: available ? null : day.offReason,
        explanation,
    };
}

/** Focus periods on one date, as instants. */
export const focusOn = (date: string, periods: readonly WeeklyPeriod[], timeZone: string): (Interval & { label: string })[] =>
    periods.flatMap((p) => {
        const i = periodOn(date, p, timeZone);
        return i ? [{ ...i, label: p.label || "Focus time" }] : [];
    });

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
    blocks: readonly TimeBlockInfo[];
    conflicts: readonly PlannerConflict[];
    commitments: readonly Commitment[];
    bufferMinutes: number;
    focus: readonly (Interval & { label: string })[];
    leave: readonly { id: string; title: string; allDay: boolean; url: string | null }[];
    holidays: readonly { id: string; title: string }[];
    /** Free time before this isn't shown (now, on today). */
    after: number;
}

/**
 * The day as one ordered list: fixed events, movable task sessions, breaks, focus periods and free
 * time, in time order. Events from subscribed or imported calendars, and events the person can't
 * edit, are marked read-only: Today never changes them.
 */
export function dayTimeline(input: TimelineInputs): DayTimeline {
    const { timeZone } = input;
    const local = (value: string) => wallClock(new Date(value), timeZone).time;
    const conflicted = new Set(input.conflicts.map((c) => c.blockId).filter(Boolean));
    const items: TimelineItem[] = [];
    for (const e of input.events) {
        if (e.allDay) continue;
        const m = minutes(span(e));
        items.push({
            id: e.id,
            kind: "event",
            title: e.title,
            start: e.start,
            end: e.end,
            startTime: local(e.start),
            endTime: local(e.end),
            minutes: m,
            fixed: true,
            movable: false,
            readOnly: e.readOnly,
            busy: e.busy && e.counts,
            shared: e.shared,
            conflict: false,
            detail: [!e.busy ? "Shows as free" : !e.counts ? "Doesn't count towards availability" : null, e.detail].filter(Boolean).join(" · ") || null,
            url: e.url,
            taskId: null,
        });
    }
    for (const b of input.blocks) {
        items.push({
            id: b.id,
            kind: "block",
            title: b.title,
            start: b.start,
            end: b.end,
            startTime: b.startTime,
            endTime: b.endTime,
            minutes: b.durationMinutes,
            fixed: false,
            movable: b.canEdit && b.status === "scheduled" && b.taskStatus === "open" && !b.earlierOccurrence,
            readOnly: !b.canEdit,
            busy: b.status === "scheduled",
            shared: false,
            conflict: conflicted.has(b.id),
            detail: [b.projectName, b.taskStatus === "completed" || b.earlierOccurrence ? "Task completed" : null].filter(Boolean).join(" · ") || null,
            url: `/portal/tasks/t/${b.taskId}`,
            taskId: b.taskId,
        });
    }
    for (const br of input.day.breaks ?? []) {
        items.push({
            id: `break:${br.start}`,
            kind: "break",
            title: br.label,
            start: iso(br.start),
            end: iso(br.end),
            startTime: clockOf(br.start, timeZone),
            endTime: clockOf(br.end, timeZone),
            minutes: minutes(br),
            fixed: true,
            movable: false,
            readOnly: true,
            busy: false,
            shared: false,
            conflict: false,
            detail: "Break",
            url: null,
            taskId: null,
        });
    }
    // Part-day leave shows as the hours it removed.
    const leaveCut = subtract(input.day.configured, [...input.day.window, ...(input.day.breaks ?? [])]);
    if (input.day.window.length)
        for (const l of leaveCut)
            items.push({
                id: `leave:${l.start}`,
                kind: "leave",
                title: "Leave",
                start: iso(l.start),
                end: iso(l.end),
                startTime: clockOf(l.start, timeZone),
                endTime: clockOf(l.end, timeZone),
                minutes: minutes(l),
                fixed: true,
                movable: false,
                readOnly: true,
                busy: false,
                shared: false,
                conflict: false,
                detail: "Unavailable",
                url: "/portal/calendar/leave",
                taskId: null,
            });
    for (const f of intersect(input.focus, input.day.window).length ? input.focus : []) {
        items.push({
            id: `focus:${f.start}`,
            kind: "focus",
            title: f.label,
            start: iso(f.start),
            end: iso(f.end),
            startTime: clockOf(f.start, timeZone),
            endTime: clockOf(f.end, timeZone),
            minutes: minutes(f),
            fixed: false,
            movable: false,
            readOnly: true,
            busy: false,
            shared: false,
            conflict: false,
            detail: "Kept for focused work: Plan My Day uses it first",
            url: null,
            taskId: null,
        });
    }
    for (const f of freeTime(input.day.window, input.commitments, input.bufferMinutes, input.after)) {
        if (minutes(f) < 15) continue;
        items.push({
            id: `free:${f.start}`,
            kind: "free",
            title: "Free",
            start: iso(f.start),
            end: iso(f.end),
            startTime: clockOf(f.start, timeZone),
            endTime: clockOf(f.end, timeZone),
            minutes: minutes(f),
            fixed: false,
            movable: false,
            readOnly: true,
            busy: false,
            shared: false,
            conflict: false,
            detail: null,
            url: null,
            taskId: null,
        });
    }
    const order: Record<TimelineItem["kind"], number> = { leave: 0, break: 1, event: 2, block: 3, focus: 4, free: 5 };
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
    overdueUnplanned: BriefingRef[];
    priorities: (BriefingRef & { planned: boolean })[];
    shortfallMinutes: number;
    freeMinutes: number;
    nextCommitment: (BriefingRef & { start: string }) | null;
    inboxCount: number;
    unfinishedYesterday: BriefingRef[];
    morningDone: boolean;
    eveningDone: boolean;
    localTime: string;
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
    if (f.unfinishedYesterday.length)
        out.push({
            id: "yesterday",
            text: `Decide what to do with ${plural(f.unfinishedYesterday.length, "unfinished task")} from yesterday: reschedule or return to the list.`,
            refs: f.unfinishedYesterday.slice(0, 6),
        });
    if (f.overdueUnplanned.length)
        out.push({
            id: "overdue",
            text: `Plan time for, postpone or complete ${plural(f.overdueUnplanned.length, "overdue task")}.`,
            refs: f.overdueUnplanned.slice(0, 6),
        });
    if (f.shortfallMinutes > 0)
        out.push({
            id: "shortfall",
            text: `${hoursLabel(f.shortfallMinutes)} of work due doesn't fit in ${hoursLabel(f.freeMinutes)} free: postpone something or plan it on another day.`,
            refs: [],
        });
    const unplanned = f.priorities.filter((p) => !p.planned);
    if (unplanned.length)
        out.push({
            id: `schedule:${unplanned[0].id}`,
            text: `Schedule time for ${unplanned[0].title}${unplanned.length > 1 ? ` and ${plural(unplanned.length - 1, "other priority", "other priorities")}` : ""}.`,
            refs: unplanned.slice(0, 3),
        });
    if (f.isToday && !f.morningDone && f.localTime < "12:00") out.push({ id: "morning", text: "Run Morning planning to choose today's top three.", refs: [] });
    if (f.isToday && !f.eveningDone && f.localTime >= "16:00") out.push({ id: "evening", text: "Run the Evening review to close out the day.", refs: [] });
    if (f.inboxCount > 0) out.push({ id: "inbox", text: `Sort ${plural(f.inboxCount, "task")} in your Inbox.`, refs: [] });
    // A briefing never has nothing to say, but it never makes something up either.
    if (!out.length) out.push({ id: "clear", text: "Nothing needs attention. Your day is planned.", refs: [] });
    return out;
}
