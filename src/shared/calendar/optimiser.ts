// The leave optimiser: deterministic searches over real calendar days.
//
// Each day in the range is either already off (a day the person doesn't work, a public holiday that
// applies to them, a configured non-working day, or leave they've already booked) or costs that
// day's ordinary hours to take off. A "break" is a run of consecutive days off; the optimiser finds
// the runs that a given amount of leave can create. It never guesses and never calls a model: the
// same inputs always give the same answers, and every answer lists the exact days and hours.
import { type LeaveContext, dayHours, round } from "./leave";
import type { SchoolPeriod } from "./nsw";
import { addDays, daysBetween, eachDate } from "./time";

export type OffReason = "not_working" | "public_holiday" | "non_working" | "leave";

export interface PlanDay {
    date: string;
    /** Hours of leave this day would take (0 when already off). */
    cost: number;
    off: boolean;
    reason: OffReason | null;
    holiday?: string;
}

/** The days from `from` to `to`, each marked off or not, for one person. */
export function planDays(ctx: LeaveContext, from: string, to: string, leaveDates: ReadonlySet<string> = new Set()): PlanDay[] {
    return eachDate(from, to, 1100).map((date) => {
        const day = dayHours(ctx, date);
        if (day.reason === "not_working" || day.reason === "non_working") {
            // Still named, so a break says it includes Easter Saturday even for a Monday–Friday worker.
            const holiday = ctx.holidays.get(date);
            return { date, cost: 0, off: true, reason: day.reason, ...(holiday ? { holiday } : {}) };
        }
        if (day.reason === "public_holiday") return { date, cost: 0, off: true, reason: "public_holiday", holiday: day.holiday };
        if (leaveDates.has(date)) return { date, cost: 0, off: true, reason: "leave" };
        return { date, cost: round(day.hours), off: false, reason: null };
    });
}

export interface Break {
    start: string;
    end: string;
    /** Consecutive days off, weekends and holidays included. */
    days: number;
    /** Working days that need leave, and the hours they take. */
    leaveDays: number;
    leaveHours: number;
    /** Dates that need leave. */
    leaveDates: string[];
    publicHolidays: { date: string; name: string }[];
    /** Days off for each day of leave. */
    efficiency: number;
}

function toBreak(days: readonly PlanDay[], i: number, j: number): Break {
    const span = days.slice(i, j + 1);
    const leave = span.filter((d) => !d.off);
    return {
        start: days[i].date,
        end: days[j].date,
        days: j - i + 1,
        leaveDays: leave.length,
        leaveHours: round(leave.reduce((s, d) => s + d.cost, 0)),
        leaveDates: leave.map((d) => d.date),
        publicHolidays: span.filter((d) => d.holiday).map((d) => ({ date: d.date, name: d.holiday! })),
        efficiency: leave.length ? round((j - i + 1) / leave.length, 2) : j - i + 1,
    };
}

/** Widens [i, j] over the days off either side, so a break always includes its weekends. */
function widen(days: readonly PlanDay[], i: number, j: number): [number, number] {
    while (i > 0 && days[i - 1].off) i--;
    while (j < days.length - 1 && days[j + 1].off) j++;
    return [i, j];
}

/**
 * The longest run of days off that `budgetHours` of leave can make. Ties go to the one needing
 * fewer hours, then the earliest. With a budget of 0 it's the longest existing break.
 */
export function longestBreak(days: readonly PlanDay[], budgetHours: number, options: { minLeaveDays?: number } = {}): Break | null {
    if (!days.length) return null;
    let best: { i: number; j: number; cost: number } | null = null;
    let left = 0;
    let cost = 0;
    for (let right = 0; right < days.length; right++) {
        cost += days[right].cost;
        while (cost > budgetHours + 1e-9 && left <= right) {
            cost -= days[left].cost;
            left++;
        }
        if (left > right) continue;
        const length = right - left + 1;
        const leaveDays = days.slice(left, right + 1).filter((d) => !d.off).length;
        if (options.minLeaveDays && leaveDays < options.minLeaveDays) continue;
        if (!best || length > best.j - best.i + 1 || (length === best.j - best.i + 1 && cost < best.cost - 1e-9)) best = { i: left, j: right, cost };
    }
    if (!best) return null;
    const [i, j] = widen(days, best.i, best.j);
    return toBreak(days, i, j);
}

/**
 * Breaks that bridge weekends and public holidays: each joins consecutive runs of days off with as
 * little leave as possible. Ranked by days off per day of leave, then by length. Only breaks that
 * include a public holiday, unless `anyBreak`.
 */
export function bestOpportunities(
    days: readonly PlanDay[],
    budgetHours: number,
    options: { maxResults?: number; anyBreak?: boolean; maxRunsJoined?: number } = {},
): Break[] {
    const runs: { start: number; end: number }[] = [];
    for (let i = 0; i < days.length; i++) {
        if (!days[i].off) continue;
        let j = i;
        while (j + 1 < days.length && days[j + 1].off) j++;
        runs.push({ start: i, end: j });
        i = j;
    }
    const found: Break[] = [];
    const maxJoined = options.maxRunsJoined ?? 6;
    for (let a = 0; a < runs.length; a++) {
        for (let b = a + 1; b < runs.length && b <= a + maxJoined; b++) {
            const candidate = toBreak(days, runs[a].start, runs[b].end);
            if (candidate.leaveHours > budgetHours + 1e-9) break;
            if (!options.anyBreak && !candidate.publicHolidays.length) continue;
            found.push(candidate);
        }
    }
    found.sort((x, y) => y.efficiency - x.efficiency || y.days - x.days || x.start.localeCompare(y.start));
    // One suggestion per starting point: the most efficient way to start a break there.
    const seen = new Set<string>();
    const out: Break[] = [];
    for (const candidate of found) {
        const key = candidate.leaveDates.join(",");
        if (seen.has(candidate.start) || seen.has(key)) continue;
        seen.add(candidate.start);
        seen.add(key);
        out.push(candidate);
        if (out.length >= (options.maxResults ?? 10)) break;
    }
    return out;
}

/** What it takes to be off for every day from `start` to `end`, widened over the days off either side. */
export function coverPeriod(days: readonly PlanDay[], start: string, end: string): Break | null {
    const i = days.findIndex((d) => d.date === start);
    const j = days.findIndex((d) => d.date === end);
    if (i < 0 || j < 0 || j < i) return null;
    const [a, b] = widen(days, i, j);
    return toBreak(days, a, b);
}

export interface JointBreak {
    start: string;
    end: string;
    days: number;
    mine: Break;
    theirs: Break;
}

/**
 * Breaks two people can take together: a day counts as off only when both are off. Each person's
 * leave is costed on their own pattern and holidays, and must fit their own budget.
 */
export function jointBreaks(mine: readonly PlanDay[], theirs: readonly PlanDay[], myBudget: number, theirBudget: number, maxResults = 5): JointBreak[] {
    const theirsByDate = new Map(theirs.map((d) => [d.date, d]));
    const both = mine.filter((d) => theirsByDate.has(d.date));
    if (!both.length) return [];
    const results: JointBreak[] = [];
    // Two pointers per start, over the shared dates, with both budgets.
    for (let i = 0; i < both.length; i++) {
        let mineCost = 0;
        let theirCost = 0;
        let bestJ = -1;
        for (let j = i; j < both.length; j++) {
            mineCost += both[j].cost;
            theirCost += theirsByDate.get(both[j].date)!.cost;
            if (mineCost > myBudget + 1e-9 || theirCost > theirBudget + 1e-9) break;
            bestJ = j;
        }
        if (bestJ < i) continue;
        const span = both.slice(i, bestJ + 1);
        const needsLeave = span.some((d) => !d.off || !theirsByDate.get(d.date)!.off);
        if (!needsLeave) continue;
        const start = span[0].date;
        const end = span.at(-1)!.date;
        const myIndex = [mine.findIndex((d) => d.date === start), mine.findIndex((d) => d.date === end)] as const;
        const theirIndex = [theirs.findIndex((d) => d.date === start), theirs.findIndex((d) => d.date === end)] as const;
        results.push({ start, end, days: daysBetween(start, end) + 1, mine: toBreak(mine, ...myIndex), theirs: toBreak(theirs, ...theirIndex) });
    }
    results.sort(
        (a, b) => b.days - a.days || a.mine.leaveHours + a.theirs.leaveHours - (b.mine.leaveHours + b.theirs.leaveHours) || a.start.localeCompare(b.start),
    );
    // Drop breaks contained in a better one already chosen.
    const out: JointBreak[] = [];
    for (const r of results) {
        if (out.some((o) => o.start <= r.start && o.end >= r.end)) continue;
        out.push(r);
        if (out.length >= maxResults) break;
    }
    return out;
}

export interface SchoolHolidayPlan {
    period: Pick<SchoolPeriod, "id" | "name" | "start" | "end" | "provisional">;
    cover: Break | null;
    /** Leave already booked on any of its days. */
    booked: boolean;
    /** Working days in the holidays not covered by leave or holidays. */
    uncoveredDays: number;
}

/** For each school holiday period: what covering it would cost, and whether leave is already planned in it. */
export function schoolHolidayPlans(
    ctx: LeaveContext,
    periods: readonly Pick<SchoolPeriod, "id" | "name" | "start" | "end" | "provisional">[],
    leaveDates: ReadonlySet<string>,
): SchoolHolidayPlan[] {
    return periods.map((period) => {
        const days = planDays(ctx, addDays(period.start, -9), addDays(period.end, 9), leaveDates);
        const inside = days.filter((d) => d.date >= period.start && d.date <= period.end);
        // Cost with nothing booked, so the plan shows the whole price even if some leave exists.
        const fresh = planDays(ctx, addDays(period.start, -9), addDays(period.end, 9));
        return {
            period,
            cover: coverPeriod(fresh, period.start, period.end),
            booked: inside.some((d) => d.reason === "leave"),
            uncoveredDays: inside.filter((d) => !d.off).length,
        };
    });
}
