// The Daily Planner's arithmetic: when someone can plan work on a day, what's already taken, the free
// time left, conflicts, capacity, and deterministic suggestions for when to work on tasks.
//
// Everything here is a pure function of its inputs, so the browser, the Worker, MCP and Chief of
// Staff all get the same answer, and the same inputs always give the same plan. Nothing is ever
// written: suggestions only become time blocks when the person accepts them.
//
// Times are handled as instants (milliseconds), converted from and to wall-clock times in the
// person's zone with Intl (zonedInstant, wallClock). A day is its own local midnight to the next,
// which is 23 or 25 hours long when daylight saving starts or ends, so durations stay exact.
import type { LeaveContext } from "../calendar/leave";
import { addDays, isoWeekday, wallClock, zonedInstant } from "../calendar/time";
import type { DayCapacity, FreeSlot, PlanResult, PlanSuggestion, PlannerConflict, PlannerPreferences } from "./types";

const MINUTE = 60_000;
const SLOT = 15 * MINUTE;

export interface Interval {
    start: number;
    end: number;
}

const ms = (iso: string) => Date.parse(iso);
const iso = (value: number) => new Date(value).toISOString();
const minutes = (i: Interval) => Math.round((i.end - i.start) / MINUTE);
const total = (list: readonly Interval[]) => list.reduce((s, i) => s + minutes(i), 0);

/** Sorted, non-overlapping. */
export function merge(list: readonly Interval[]): Interval[] {
    const sorted = list.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start || a.end - b.end);
    const out: Interval[] = [];
    for (const i of sorted) {
        const last = out[out.length - 1];
        if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
        else out.push({ ...i });
    }
    return out;
}

/** `from` with every part of `remove` taken out. */
export function subtract(from: readonly Interval[], remove: readonly Interval[]): Interval[] {
    let out = merge(from);
    for (const r of merge(remove)) {
        const next: Interval[] = [];
        for (const i of out) {
            if (r.end <= i.start || r.start >= i.end) next.push(i);
            else {
                if (r.start > i.start) next.push({ start: i.start, end: r.start });
                if (r.end < i.end) next.push({ start: r.end, end: i.end });
            }
        }
        out = next;
    }
    return out;
}

export const intersect = (a: readonly Interval[], b: readonly Interval[]): Interval[] => subtract(a, subtract(a, b));

export const overlaps = (a: Interval, b: Interval) => a.start < b.end && b.start < a.end;

// --- Availability --------------------------------------------------------------------------------

/** Leave that takes time out of a day: requested, approved or taken (never drafts, proposals or scenarios). */
export interface LeaveDay {
    start: string;
    end: string;
    part: "full" | "am" | "pm" | "hours";
    hours: number | null;
    label: string;
}

/** A weekly period (Today's breaks and focus periods): weekdays 1 (Monday) to 7, and local times. */
export interface WeeklyPeriod {
    label?: string;
    days: readonly number[];
    start: string;
    end: string;
}

export interface DayInputs {
    prefs: PlannerPreferences;
    timeZone: string;
    /** Public holidays, non-working days and the work pattern, from the leave engine. Null: none configured. */
    leaveContext: LeaveContext | null;
    leave: readonly LeaveDay[];
    /** Breaks taken out of the planning hours (Today's preferences). */
    breaks?: readonly WeeklyPeriod[];
}

export interface Availability {
    date: string;
    /** When work can be planned (empty on a day off). */
    window: Interval[];
    /** The planning hours as configured, before days off (to tell "outside your hours" from "on leave"). */
    configured: Interval[];
    offReason: string | null;
    /** Breaks taken out of the window that day, with their labels. */
    breaks?: (Interval & { label: string })[];
}

/** A weekly period's instants on one date, or nothing when it isn't on that weekday. */
export function periodOn(date: string, p: WeeklyPeriod, timeZone: string): Interval | null {
    if (!p.days.includes(isoWeekday(date))) return null;
    const start = ms(zonedInstant(date, p.start, timeZone));
    const end = ms(zonedInstant(date, p.end, timeZone));
    return end > start ? { start, end } : null;
}

/** The person's planning hours on a date, less leave, public holidays and non-working days. */
export function availability(date: string, inputs: DayInputs): Availability {
    const hours = inputs.prefs.workingHours[isoWeekday(date) - 1];
    const configured = hours ? [{ start: ms(zonedInstant(date, hours.start, inputs.timeZone)), end: ms(zonedInstant(date, hours.end, inputs.timeZone)) }] : [];
    if (inputs.prefs.planOnDaysOff) {
        const fallback = configured.length
            ? configured
            : [{ start: ms(zonedInstant(date, "09:00", inputs.timeZone)), end: ms(zonedInstant(date, "17:00", inputs.timeZone)) }];
        return withBreaks({ date, window: fallback, configured, offReason: null }, inputs);
    }
    if (!hours) return { date, window: [], configured, offReason: "Not a planning day" };
    if (inputs.leaveContext) {
        // Straight from the context: the leave engine's dayHours reports a work-pattern day off first.
        const holiday = inputs.leaveContext.holidays.get(date);
        if (holiday) return { date, window: [], configured, offReason: holiday };
        if (inputs.leaveContext.nonWorking.has(date)) return { date, window: [], configured, offReason: "Non-working day" };
    }
    let window = configured;
    for (const l of inputs.leave) {
        if (l.start > date || l.end < date) continue;
        const span = window[0];
        if (!span) break;
        if (l.part === "full") return { date, window: [], configured, offReason: l.label };
        const middle = span.start + Math.round((span.end - span.start) / 2 / MINUTE) * MINUTE;
        if (l.part === "am") window = subtract(window, [{ start: span.start, end: middle }]);
        else if (l.part === "pm") window = subtract(window, [{ start: middle, end: span.end }]);
        else if (l.hours) window = subtract(window, [{ start: Math.max(span.start, span.end - l.hours * 60 * MINUTE), end: span.end }]);
    }
    if (!window.length) return { date, window, configured, offReason: "On leave" };
    return withBreaks({ date, window, configured, offReason: null }, inputs);
}

/** Takes the day's breaks out of its window. A day that's all break has no planning hours. */
function withBreaks(day: Availability, inputs: DayInputs): Availability {
    const breaks: (Interval & { label: string })[] = [];
    for (const p of inputs.breaks ?? []) {
        const i = periodOn(day.date, p, inputs.timeZone);
        if (!i) continue;
        const inside = intersect(day.window, [i]);
        for (const part of inside) breaks.push({ ...part, label: p.label || "Break" });
    }
    if (!breaks.length) return day;
    const window = subtract(day.window, breaks);
    return { ...day, window, breaks, offReason: window.length ? null : "Breaks fill the day" };
}

// --- Commitments ---------------------------------------------------------------------------------

/** Something that takes time: an event (yours, shared or subscribed) or a scheduled time block. */
export interface Commitment {
    id: string;
    title: string;
    start: string;
    end: string;
    kind: "event" | "block";
    source: "local" | "subscription" | "import" | "block";
    shared: boolean;
    /** Free events (show as free) don't take time. */
    busy: boolean;
}

const span = (c: { start: string; end: string }): Interval => ({ start: ms(c.start), end: ms(c.end) });

/** Free time in a window: what's left after commitments, with a buffer after each. */
export function freeTime(window: readonly Interval[], commitments: readonly Commitment[], bufferMinutes: number, after = -Infinity): Interval[] {
    const taken = commitments.filter((c) => c.busy).map((c) => ({ start: ms(c.start), end: ms(c.end) + bufferMinutes * MINUTE }));
    const open = subtract(window, taken).map((i) => ({ start: Math.max(i.start, after), end: i.end }));
    return open.filter((i) => i.end > i.start);
}

export function toFreeSlots(list: readonly Interval[], timeZone: string, minimumMinutes = 5): FreeSlot[] {
    return list
        .filter((i) => minutes(i) >= minimumMinutes)
        .map((i) => {
            const s = wallClock(new Date(i.start), timeZone);
            const e = wallClock(new Date(i.end), timeZone);
            return { start: iso(i.start), end: iso(i.end), startDate: s.date, startTime: s.time, endTime: e.time, minutes: minutes(i) };
        });
}

// --- Conflicts -----------------------------------------------------------------------------------

export interface BlockShape {
    id: string | null;
    start: string;
    end: string;
    /** The task's due date and time, and deadline, for "after it's due" warnings. */
    dueDate?: string | null;
    dueTime?: string | null;
    deadline?: string | null;
}

const describeWith = (c: Commitment) =>
    c.kind === "block"
        ? `another planned session (${c.title})`
        : `${c.title}${c.source === "subscription" ? " (subscribed calendar)" : c.shared ? " (shared calendar)" : ""}`;

/**
 * Everything worth warning about for a block or a proposed time: overlapping events (including
 * subscribed calendars and shared commitments the person can see), other blocks, leave and days
 * off, time outside planning hours, and finishing after the task is due. Warnings never stop
 * anything: the person decides.
 */
export function conflictsFor(block: BlockShape, commitments: readonly Commitment[], days: readonly Availability[], timeZone: string): PlannerConflict[] {
    const out: PlannerConflict[] = [];
    const me = span(block);
    for (const c of commitments) {
        if (!c.busy || c.id === block.id || !overlaps(me, span(c))) continue;
        out.push({
            blockId: block.id,
            kind: c.kind === "block" ? "block" : "event",
            message: `Overlaps ${describeWith(c)}`,
            with: { id: c.id, title: c.title, start: c.start, end: c.end, source: c.source, shared: c.shared },
        });
    }
    const date = wallClock(new Date(me.start), timeZone).date;
    const day = days.find((d) => d.date === date);
    if (day) {
        const inBreak = day.breaks?.find((b) => overlaps(me, b));
        if (inBreak) {
            out.push({ blockId: block.id, kind: "break", message: `Overlaps a break (${inBreak.label})`, with: null });
        } else if (!day.window.length && day.offReason) {
            out.push({ blockId: block.id, kind: day.configured.length ? "leave" : "day_off", message: `On a day off: ${day.offReason}`, with: null });
        } else if (subtract([me], day.window).length) {
            const leaveCut = day.configured.length && subtract(intersect([me], day.configured), day.window).length > 0;
            out.push(
                leaveCut
                    ? { blockId: block.id, kind: "leave", message: "Overlaps leave", with: null }
                    : { blockId: block.id, kind: "outside_hours", message: "Outside your planning hours", with: null },
            );
        }
    }
    const limit = dueLimit(block, timeZone);
    if (limit !== null && me.end > limit) out.push({ blockId: block.id, kind: "after_due", message: "Ends after the task is due", with: null });
    return out;
}

/** The instant a task is due by: its due time, or the end of its due date or deadline (whichever is first). */
function dueLimit(t: { dueDate?: string | null; dueTime?: string | null; deadline?: string | null }, timeZone: string): number | null {
    const limits: number[] = [];
    if (t.dueDate) limits.push(ms(t.dueTime ? zonedInstant(t.dueDate, t.dueTime, timeZone) : zonedInstant(addDays(t.dueDate, 1), "00:00", timeZone)));
    if (t.deadline) limits.push(ms(zonedInstant(addDays(t.deadline, 1), "00:00", timeZone)));
    return limits.length ? Math.min(...limits) : null;
}

// --- Capacity ------------------------------------------------------------------------------------

export function capacity(day: Availability, commitments: readonly Commitment[], prefs: PlannerPreferences, unscheduledMinutes: number): DayCapacity {
    const working = total(day.window);
    const events = total(intersect(day.window, merge(commitments.filter((c) => c.busy && c.kind === "event").map(span))));
    const blocks = total(intersect(day.window, merge(commitments.filter((c) => c.kind === "block").map(span))));
    const free = total(subtract(day.window, commitments.filter((c) => c.busy).map(span)));
    const room = Math.min(free, Math.max(0, prefs.dailyFocusMinutes - blocks));
    let status: DayCapacity["status"];
    if (!working) status = "off";
    else if (unscheduledMinutes > room || events + blocks > working) status = "over";
    else if (free < working * 0.2 || blocks >= prefs.dailyFocusMinutes) status = "full";
    else if (events + blocks < working * 0.5) status = "light";
    else status = "balanced";
    return {
        date: day.date,
        workingMinutes: working,
        eventMinutes: events,
        blockMinutes: blocks,
        freeMinutes: free,
        unscheduledMinutes,
        focusLimitMinutes: prefs.dailyFocusMinutes,
        status,
        offReason: working ? null : day.offReason,
    };
}

// --- Suggestions ---------------------------------------------------------------------------------

export interface PlanTask {
    id: string;
    title: string;
    priority: number;
    dueDate: string | null;
    dueTime: string | null;
    deadline: string | null;
    /** The occurrence a session would be for, on a repeating task. */
    occurrenceDate: string | null;
    estimateMinutes: number | null;
    /** Already scheduled for this occurrence. */
    scheduledMinutes: number;
}

export interface PlanInputs {
    from: string;
    to: string;
    today: string;
    /** No suggestion starts before this (normally now). */
    now: number;
    timeZone: string;
    prefs: PlannerPreferences;
    days: readonly Availability[];
    commitments: readonly Commitment[];
    tasks: readonly PlanTask[];
    /** Focus periods: free time inside them is used first, then the rest of the day. */
    preferred?: readonly Interval[];
}

const target = (t: PlanTask) => [t.deadline, t.dueDate].filter((d): d is string => !!d).sort()[0] ?? null;

/**
 * Deterministic order: overdue first, then the earliest due date or deadline, then priority (P1
 * first), then the bigger job, then the task id, so ties always break the same way.
 */
export function planOrder(tasks: readonly PlanTask[], today: string): PlanTask[] {
    const key = (t: PlanTask) => {
        const due = target(t);
        return { overdue: due !== null && due < today ? 0 : 1, due: due ?? "9999-12-31", priority: t.priority };
    };
    return [...tasks].sort((a, b) => {
        const x = key(a);
        const y = key(b);
        return (
            x.overdue - y.overdue ||
            x.due.localeCompare(y.due) ||
            x.priority - y.priority ||
            (b.estimateMinutes ?? 0) - (a.estimateMinutes ?? 0) ||
            a.id.localeCompare(b.id)
        );
    });
}

/**
 * Suggests sessions for tasks in the person's free time between two dates: earliest free time
 * first, never before now, never more than the daily focus limit, sessions between the shortest
 * and longest lengths (a task that needs more gets several), a buffer after each, and before the
 * task is due where possible. Nothing is created: each suggestion has to be accepted.
 */
export function suggestPlan(input: PlanInputs): PlanResult {
    const { prefs, timeZone } = input;
    const dates = input.days.filter((d) => d.date >= input.from && d.date <= input.to).sort((a, b) => a.date.localeCompare(b.date));
    // Free time left on each day, and task time already planned on it.
    const free = new Map<string, Interval[]>();
    const focus = new Map<string, number>();
    for (const day of dates) {
        const open = freeTime(day.window, input.commitments, prefs.bufferMinutes, input.now);
        // Focus periods first (each part in time order), then everything else.
        free.set(day.date, input.preferred?.length ? [...intersect(open, input.preferred), ...subtract(open, input.preferred)] : open);
        focus.set(day.date, total(intersect(day.window, merge(input.commitments.filter((c) => c.kind === "block").map(span)))));
    }

    const suggestions: PlanSuggestion[] = [];
    const unplaced: PlanResult["unplaced"] = [];
    for (const task of planOrder(input.tasks, input.today)) {
        let remaining = (task.estimateMinutes ?? prefs.defaultEstimateMinutes) - task.scheduledMinutes;
        if (remaining < 5) continue;
        const limit = dueLimit(task, timeZone);
        const placed: Omit<PlanSuggestion, "session" | "sessions">[] = [];
        // First before it's due; then, only if that wasn't enough, after.
        for (const late of [false, true]) {
            for (const day of dates) {
                if (remaining < 5) break;
                const slots = free.get(day.date)!;
                for (let i = 0; i < slots.length && remaining >= 5; i++) {
                    const room = prefs.dailyFocusMinutes - focus.get(day.date)!;
                    if (room < Math.min(prefs.minBlockMinutes, remaining)) break;
                    const slot = slots[i];
                    // Sessions start on a quarter hour. Every Australian offset is a multiple of 15 minutes, so UTC quarters are local ones.
                    const start = Math.ceil((late && limit !== null ? Math.max(slot.start, limit) : slot.start) / SLOT) * SLOT;
                    const end = !late && limit !== null ? Math.min(slot.end, limit) : slot.end;
                    const available = Math.floor((end - start) / MINUTE / 5) * 5;
                    const length = Math.min(remaining, prefs.maxBlockMinutes, available, Math.floor(room / 5) * 5);
                    if (length < Math.min(prefs.minBlockMinutes, remaining)) continue;
                    const s = start;
                    const e = start + length * MINUTE;
                    const from = wallClock(new Date(s), timeZone);
                    const to = wallClock(new Date(e), timeZone);
                    placed.push({
                        id: `${task.id}:${iso(s)}`,
                        taskId: task.id,
                        title: task.title,
                        startDate: from.date,
                        startTime: from.time,
                        endTime: to.time,
                        start: iso(s),
                        end: iso(e),
                        durationMinutes: length,
                        occurrenceDate: task.occurrenceDate,
                        late,
                        reason: reasonFor(task, input.today, late),
                    });
                    remaining -= length;
                    focus.set(day.date, focus.get(day.date)! + length);
                    // The rest of the slot, after this session and its buffer.
                    slots.splice(i, 1, ...subtract([slot], [{ start: slot.start, end: e + prefs.bufferMinutes * MINUTE }]));
                    i--;
                }
            }
            if (remaining < 5 || limit === null) break;
        }
        placed.forEach((p, n) => suggestions.push({ ...p, session: n + 1, sessions: placed.length }));
        if (remaining >= 5)
            unplaced.push({
                taskId: task.id,
                title: task.title,
                remainingMinutes: remaining,
                reason: placed.length ? "Only part of it fits in your free time" : "No free time long enough in this period",
            });
    }
    suggestions.sort((a, b) => a.start.localeCompare(b.start) || a.taskId.localeCompare(b.taskId));
    return {
        from: input.from,
        to: input.to,
        suggestions,
        unplaced,
        note: "Suggestions only. Nothing is scheduled until you accept one, and nothing already in your calendar is moved.",
    };
}

function reasonFor(task: PlanTask, today: string, late: boolean): string {
    const due = target(task);
    const parts: string[] = [];
    if (due && due < today) parts.push("overdue");
    else if (due === today) parts.push("due today");
    else if (due) parts.push(`due ${due}`);
    if (task.priority <= 2) parts.push(`P${task.priority}`);
    parts.push(task.estimateMinutes ? `estimated ${task.estimateMinutes} min` : "no estimate (default length)");
    if (late) parts.push("no free time before it's due");
    return parts.join(", ");
}
