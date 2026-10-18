// Answers to leave planning questions, worked out from real calendar days (src/shared/calendar/
// optimiser.ts) and the person's own balances (src/shared/calendar/leave.ts). The portal's planner,
// the MCP tools and Chief of Staff all call this, so every answer is the same wherever it's asked.
// Nothing is guessed: each answer lists its days, the hours they take, and the balance after.
import type { D1Database } from "@cloudflare/workers-types";
import { z } from "zod";
import { leaveContext, schoolHolidaysBetween } from "../../src/shared/calendar/holidays";
import { type ForecastMode, balanceAt, bookingDays, round } from "../../src/shared/calendar/leave";
import { COVERED_YEARS } from "../../src/shared/calendar/nsw";
import { type Break, bestOpportunities, coverPeriod, jointBreaks, longestBreak, planDays, schoolHolidayPlans } from "../../src/shared/calendar/optimiser";
import { addDays, daysBetween, eachDate } from "../../src/shared/calendar/time";
import type { LeaveData, LeaveTypeInfo } from "../../src/shared/calendar/types";
import type { PortalUser } from "../../src/shared/portal/types";
import { ValidationError } from "../portal/entities";
import { preferences, todayFor } from "./access";
import { contextFor, loadLeave } from "./leave";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-10-18");

export const plannerQuestion = z.discriminatedUnion("question", [
    /** What's the longest break this many hours of leave can make? */
    z
        .object({
            question: z.literal("longest_break"),
            budgetHours: z.number().min(0).max(2000),
            from: date.optional(),
            to: date.optional(),
            leaveTypeId: z.string().optional(),
        })
        .strict(),
    /** Which public holidays give the best breaks for the leave they need? */
    z
        .object({
            question: z.literal("public_holidays"),
            budgetHours: z.number().min(0).max(2000).default(76),
            from: date.optional(),
            to: date.optional(),
            leaveTypeId: z.string().optional(),
        })
        .strict(),
    /** What would each school holiday cost, and which have no leave planned? */
    z.object({ question: z.literal("school_holidays"), from: date.optional(), to: date.optional(), leaveTypeId: z.string().optional() }).strict(),
    /** How much leave to be off from `start` to `end`, and the balance afterwards. */
    z.object({ question: z.literal("cover_period"), start: date, end: date, leaveTypeId: z.string().optional() }).strict(),
    /** When can I and someone who shares their leave with me be off together? */
    z
        .object({
            question: z.literal("joint"),
            with: z.string().trim().toLowerCase().email(),
            budgetHours: z.number().min(0).max(2000),
            theirBudgetHours: z.number().min(0).max(2000).optional(),
            from: date.optional(),
            to: date.optional(),
        })
        .strict(),
]);
export type PlannerQuestion = z.input<typeof plannerQuestion>;

const leaveDates = (leave: LeaveData, mode: ForecastMode = "planned") => {
    const ctx = contextFor(leave);
    const types = new Map(leave.types.map((t) => [t.id, t]));
    const dates = new Set<string>();
    for (const b of leave.bookings) {
        if (b.scenarioId || b.status === "cancelled" || b.status === "draft") continue;
        if (mode === "confirmed" && !(b.status === "approved" || b.status === "taken")) continue;
        const type = types.get(b.leaveTypeId);
        if (!type || b.part !== "full") continue;
        for (const d of bookingDays(b, type, ctx)) dates.add(d.date);
    }
    return dates;
};

/** The leave type questions are costed against: the one asked for, else annual leave, else the first that tracks a balance. */
function chooseType(leave: LeaveData, id?: string): LeaveTypeInfo | null {
    const active = leave.types.filter((t) => !t.archived);
    if (id) {
        const found = active.find((t) => t.id === id);
        if (!found) throw new ValidationError("Choose one of your leave types", "leaveTypeId");
        return found;
    }
    return active.find((t) => t.kind === "annual") ?? active.find((t) => t.tracksBalance) ?? null;
}

/** The balance after taking a break's leave dates as a hypothetical booking. */
function balanceAfter(leave: LeaveData, type: LeaveTypeInfo | null, brk: Break | null) {
    if (!type || !type.tracksBalance || !brk) return null;
    const ctx = contextFor(leave);
    const hypothetical = {
        id: "hypothetical",
        leaveTypeId: type.id,
        scenarioId: "what-if",
        startDate: brk.start,
        endDate: brk.end,
        part: "full" as const,
        hours: null,
        dayHours: null,
        status: "proposed" as const,
        title: null,
        note: null,
        version: 1,
        updatedAt: "",
    };
    const input = { type, bookings: [...leave.bookings, hypothetical], adjustments: leave.adjustments, types: leave.types };
    const before = balanceAt({ ...input, bookings: leave.bookings }, ctx, brk.end, "planned");
    const after = balanceAt(input, ctx, brk.end, "planned", "what-if");
    return {
        leaveType: { id: type.id, name: type.name },
        balanceBefore: before.closing,
        balanceAfter: after.closing,
        negative: after.lowest.hours < 0,
        note: "Projected at the end of the break, counting approved, taken, requested and proposed leave. An estimate from your own settings.",
    };
}

const breakOut = (b: Break | null) =>
    b && {
        start: b.start,
        end: b.end,
        daysOff: b.days,
        leaveDays: b.leaveDays,
        leaveHours: round(b.leaveHours, 2),
        leaveDates: b.leaveDates,
        publicHolidays: b.publicHolidays,
        daysOffPerLeaveDay: b.efficiency,
    };

function windowFor(today: string, from?: string, to?: string, maxDays = 730) {
    const start = from ?? today;
    let end = to ?? addDays(start, 365);
    if (daysBetween(start, end) > maxDays) end = addDays(start, maxDays);
    if (end < start) throw new ValidationError("The end is before the start", "to");
    return { start, end };
}

const coverage = (start: string, end: string) => {
    const [first, last] = COVERED_YEARS.publicHolidays;
    const years = [Number(start.slice(0, 4)), Number(end.slice(0, 4))];
    return years.some((y) => y < first || y > last)
        ? `Official NSW holiday dates are only included for ${first}–${last}; days outside those years are costed without public holidays.`
        : null;
};

export async function answer(db: D1Database, user: PortalUser, input: unknown) {
    const q = plannerQuestion.parse(input);
    const leave = await loadLeave(db, user);
    const today = await todayFor(db, user.email);
    const ctx = contextFor(leave);
    const prefs = await preferences(db, user.email);
    const base = {
        question: q.question,
        today,
        configured: leave.profile.configured,
        basis: "Your work pattern, NSW public holidays and the leave you've already booked.",
    };

    switch (q.question) {
        case "longest_break": {
            const w = windowFor(today, q.from, q.to);
            const days = planDays(ctx, w.start, w.end, leaveDates(leave));
            const best = longestBreak(days, q.budgetHours, { minLeaveDays: q.budgetHours > 0 ? 1 : 0 });
            const type = chooseType(leave, q.leaveTypeId);
            return {
                ...base,
                window: w,
                budgetHours: q.budgetHours,
                best: breakOut(best),
                balance: balanceAfter(leave, type, best),
                coverage: coverage(w.start, w.end),
            };
        }
        case "public_holidays": {
            const w = windowFor(today, q.from, q.to);
            const days = planDays(ctx, w.start, w.end, leaveDates(leave));
            const type = chooseType(leave, q.leaveTypeId);
            const options = bestOpportunities(days, q.budgetHours, { maxResults: 8 });
            return {
                ...base,
                window: w,
                budgetHours: q.budgetHours,
                opportunities: options.map((o) => ({ ...breakOut(o)!, balance: balanceAfter(leave, type, o) })),
                coverage: coverage(w.start, w.end),
            };
        }
        case "school_holidays": {
            const w = windowFor(today, q.from, q.to);
            if (prefs.schoolDivision === "none")
                return { ...base, window: w, division: "none", periods: [], note: "School holidays are switched off in Calendar → Settings." };
            const periods = schoolHolidaysBetween(w.start, w.end, prefs.schoolDivision).filter((p) => p.end >= today);
            const plans = schoolHolidayPlans(ctx, periods, leaveDates(leave));
            const type = chooseType(leave, q.leaveTypeId);
            return {
                ...base,
                window: w,
                division: prefs.schoolDivision,
                periods: plans.map((p) => ({
                    id: p.period.id,
                    name: p.period.name,
                    start: p.period.start,
                    end: p.period.end,
                    provisional: !!p.period.provisional,
                    leavePlanned: p.booked,
                    workingDaysNotCovered: p.uncoveredDays,
                    toCoverAll: breakOut(p.cover),
                    balance: balanceAfter(leave, type, p.cover),
                })),
                coverage: coverage(w.start, w.end),
            };
        }
        case "cover_period": {
            if (daysBetween(q.start, q.end) > 366) throw new ValidationError("Ask about at most a year at a time", "end");
            const days = planDays(ctx, addDays(q.start, -9), addDays(q.end, 9));
            const cover = coverPeriod(days, q.start, q.end);
            const type = chooseType(leave, q.leaveTypeId);
            const exact = cover && { ...cover, leaveDates: cover.leaveDates.filter((d) => d >= q.start && d <= q.end) };
            return {
                ...base,
                requested: { start: q.start, end: q.end, days: daysBetween(q.start, q.end) + 1 },
                workingDays: eachDate(q.start, q.end).filter((d) => days.find((x) => x.date === d && !x.off)).length,
                leaveHours: round(
                    days.filter((d) => d.date >= q.start && d.date <= q.end && !d.off).reduce((s, d) => s + d.cost, 0),
                    2,
                ),
                withWeekendsAround: breakOut(cover),
                balance: balanceAfter(leave, type, exact ? { ...exact, start: q.start, end: q.end } : null),
                coverage: coverage(q.start, q.end),
            };
        }
        case "joint": {
            const partner = leave.sharedWithMe.find((s) => s.owner.email === q.with);
            if (!partner)
                return {
                    ...base,
                    available: false,
                    note: "That person hasn't shared their leave with you. They can share it from Calendar → Leave settings → Sharing.",
                };
            if (!partner.pattern) return { ...base, available: false, note: "That person hasn't set up their work pattern yet." };
            const w = windowFor(today, q.from, q.to, 400);
            const theirs = leaveContext(partner.pattern, { includeBankHoliday: false, region: null }, []);
            const theirLeave = new Set<string>();
            for (const b of partner.bookings) if (b.part === "full") for (const d of eachDate(b.startDate, b.endDate, 800)) theirLeave.add(d);
            const breaks = jointBreaks(
                planDays(ctx, w.start, w.end, leaveDates(leave)),
                planDays(theirs, w.start, w.end, theirLeave),
                q.budgetHours,
                q.theirBudgetHours ?? q.budgetHours,
            );
            return {
                ...base,
                available: true,
                with: partner.owner,
                window: w,
                breaks: breaks.map((b) => ({
                    start: b.start,
                    end: b.end,
                    daysOffTogether: b.days,
                    yours: { leaveDays: b.mine.leaveDays, leaveHours: round(b.mine.leaveHours, 2), leaveDates: b.mine.leaveDates },
                    theirs: { leaveDays: b.theirs.leaveDays, leaveHours: round(b.theirs.leaveHours, 2), leaveDates: b.theirs.leaveDates },
                })),
                note: "Their leave is costed on their shared work pattern with statewide holidays only. Their balances are never shared.",
            };
        }
    }
}
