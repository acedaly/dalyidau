// Daly Calendar's deterministic core: time zones and daylight saving, repeat rules and their
// exceptions, the official NSW data, the leave engine and the optimiser. No database, no network.
import { describe, expect, it } from "vitest";
import { applicableHolidays, leaveContext, schoolHolidaysBetween } from "../src/shared/calendar/holidays";
import {
    DEFAULT_PATTERN,
    LEAVE_PRESETS,
    balanceAt,
    bookingDays,
    bookingHours,
    counts,
    forecastSeries,
    patternHours,
    weeklyHours,
} from "../src/shared/calendar/leave";
import { NSW_PUBLIC_HOLIDAYS, NSW_SCHOOL_PERIODS, SOURCES } from "../src/shared/calendar/nsw";
import { bestOpportunities, coverPeriod, jointBreaks, longestBreak, planDays, schoolHolidayPlans } from "../src/shared/calendar/optimiser";
import { describeRepeat, fromRRule, repeatRule, toRRule } from "../src/shared/calendar/recurrence";
import { addDays, isoWeekday, wallClock, zoneOffsetMinutes, zonedInstant } from "../src/shared/calendar/time";
import type { LeaveBookingInfo, LeaveTypeInfo } from "../src/shared/calendar/types";
import { viewWindow } from "../src/shared/calendar/views";
import { expand, isSeriesOccurrence, occurrencesBefore, seriesEndAt } from "../worker/calendar/expand";

const SYD = "Australia/Sydney";

describe("time zones and daylight saving", () => {
    it("turns Sydney wall-clock times into the right instants on both sides of a change", () => {
        // 4 October 2026: clocks go forward at 2 am (AEST +10 → AEDT +11).
        expect(zonedInstant("2026-10-03", "09:00", SYD)).toBe("2026-10-02T23:00:00.000Z");
        expect(zonedInstant("2026-10-04", "09:00", SYD)).toBe("2026-10-03T22:00:00.000Z");
        // A time in the skipped hour comes out an hour later.
        expect(wallClock(zonedInstant("2026-10-04", "02:30", SYD), SYD)).toEqual({ date: "2026-10-04", time: "03:30" });
        // 5 April 2026: clocks go back at 3 am. 2:30 happens twice; either way it reads back as 2:30.
        expect(["2026-04-04T15:30:00.000Z", "2026-04-04T16:30:00.000Z"]).toContain(zonedInstant("2026-04-05", "02:30", SYD));
        expect(wallClock(zonedInstant("2026-04-05", "02:30", SYD), SYD)).toEqual({ date: "2026-04-05", time: "02:30" });
        expect(zoneOffsetMinutes(SYD, Date.parse("2026-07-01T00:00:00Z"))).toBe(600);
        expect(zoneOffsetMinutes(SYD, Date.parse("2026-12-01T00:00:00Z"))).toBe(660);
        // Brisbane has no daylight saving.
        expect(zonedInstant("2026-12-01", "09:00", "Australia/Brisbane")).toBe("2026-11-30T23:00:00.000Z");
    });

    it("works out view windows from Monday (the Australian default) or Sunday", () => {
        expect(viewWindow("week", "2026-10-18", 1)).toEqual({ from: "2026-10-12", to: "2026-10-18" });
        expect(viewWindow("week", "2026-10-18", 0)).toEqual({ from: "2026-10-18", to: "2026-10-24" });
        expect(viewWindow("month", "2026-10-18", 1)).toEqual({ from: "2026-09-28", to: "2026-11-01" });
    });
});

const weekly9am = {
    all_day: 0,
    start_date: "2026-09-28",
    start_time: "09:00",
    end_date: "2026-09-28",
    end_time: "10:00",
    time_zone: SYD,
    rrule: "FREQ=WEEKLY;BYDAY=MO",
    rdates: null,
    exdates: null,
};
const window = (from: string, to: string) => ({ start: zonedInstant(from, "00:00", SYD), end: zonedInstant(addDays(to, 1), "00:00", SYD) });

describe("repeat rules", () => {
    it("keeps a weekly 9 am at 9 am across daylight saving", () => {
        const { occurrences } = expand(weekly9am, [], window("2026-09-28", "2026-10-12"));
        expect(occurrences.map((o) => [o.key, wallClock(o.startAt, SYD).time])).toEqual([
            ["2026-09-28T09:00", "09:00"],
            ["2026-10-05T09:00", "09:00"],
            ["2026-10-12T09:00", "09:00"],
        ]);
        // The instants differ by an hour less than a week, because the clocks went forward.
        expect(Date.parse(occurrences[1].startAt) - Date.parse(occurrences[0].startAt)).toBe(7 * 86_400_000 - 3_600_000);
    });

    it("applies excluded dates, moved occurrences and cancellations by occurrence key", () => {
        const row = { ...weekly9am, exdates: JSON.stringify(["2026-10-05T09:00"]) };
        const overrides = [
            {
                event_id: "e",
                occurrence_key: "2026-10-12T09:00",
                cancelled: 0,
                fields: JSON.stringify({ startDate: "2026-10-13", startTime: "14:00", endDate: "2026-10-13", endTime: "15:00", title: "Moved" }),
                start_at: zonedInstant("2026-10-13", "14:00", SYD),
                end_at: zonedInstant("2026-10-13", "15:00", SYD),
            },
            { event_id: "e", occurrence_key: "2026-10-19T09:00", cancelled: 1, fields: "{}", start_at: null, end_at: null },
        ];
        const { occurrences } = expand(row, overrides, window("2026-09-28", "2026-10-26"));
        expect(occurrences.map((o) => [o.key, o.startDate, o.startTime, o.fields?.title ?? null])).toEqual([
            ["2026-09-28T09:00", "2026-09-28", "09:00", null],
            ["2026-10-12T09:00", "2026-10-13", "14:00", "Moved"],
            ["2026-10-26T09:00", "2026-10-26", "09:00", null],
        ]);
        // A moved occurrence is found even when only its new date is in the window.
        expect(expand(row, overrides, window("2026-10-13", "2026-10-13")).occurrences.map((o) => o.key)).toEqual(["2026-10-12T09:00"]);
    });

    it("builds, reads back and describes the editor's rules", () => {
        const rule = repeatRule.parse({ freq: "monthly", monthly: "weekday" });
        expect(toRRule(rule, "2026-10-30", "18:00")).toBe("FREQ=MONTHLY;BYDAY=-1FR");
        expect(fromRRule("FREQ=MONTHLY;BYDAY=-1FR", "2026-10-30")).toMatchObject({ freq: "monthly", monthly: "weekday" });
        expect(describeRepeat(rule, "2026-10-30")).toBe("Every month on the last Friday");
        const fortnight = repeatRule.parse({ freq: "weekly", interval: 2, byDay: ["TU", "TH"], until: "2026-12-17" });
        expect(toRRule(fortnight, "2026-10-13", "15:00")).toBe("FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;UNTIL=20261217T235959");
        expect(describeRepeat(fortnight, "2026-10-13")).toBe("Every 2 weeks on Tuesday and Thursday until 2026-12-17");
        // Rules from feeds outside the editor's subset are kept as they are.
        expect(fromRRule("FREQ=YEARLY;BYMONTH=3;BYDAY=2SU", "2027-03-14")).toBeNull();
        expect(() => repeatRule.parse({ freq: "daily", until: "2026-12-01", count: 3 })).toThrow();
    });

    it("finds a series' end, counts earlier occurrences and checks occurrence keys", () => {
        const counted = { ...weekly9am, rrule: "FREQ=WEEKLY;BYDAY=MO;COUNT=3" };
        expect(seriesEndAt(counted)).toBe(zonedInstant("2026-10-12", "10:00", SYD));
        expect(seriesEndAt(weekly9am)).toBe("9999-12-31T00:00:00.000Z");
        expect(occurrencesBefore(counted, "2026-10-12T09:00")).toBe(2);
        expect(isSeriesOccurrence(counted, "2026-10-05T09:00")).toBe(true);
        expect(isSeriesOccurrence(counted, "2026-10-06T09:00")).toBe(false);
    });

    it("repeats all-day birthdays yearly, and 29 February only in leap years", () => {
        const birthday = {
            all_day: 1,
            start_date: "2024-02-29",
            start_time: null,
            end_date: "2024-02-29",
            end_time: null,
            time_zone: SYD,
            rrule: "FREQ=YEARLY",
            rdates: null,
            exdates: null,
        };
        const { occurrences } = expand(birthday, [], window("2025-01-01", "2028-12-31"));
        expect(occurrences.map((o) => o.startDate)).toEqual(["2028-02-29"]);
        const multi = { ...birthday, start_date: "2026-12-24", end_date: "2026-12-26", rrule: null };
        expect(expand(multi, [], window("2026-12-25", "2026-12-25")).occurrences[0]).toMatchObject({ startDate: "2026-12-24", endDate: "2026-12-26" });
    });

    it("refuses to run away on a pathological rule", () => {
        const daily = { ...weekly9am, start_date: "2000-01-01", rrule: "FREQ=DAILY" };
        const result = expand(daily, [], window("2026-01-01", "2026-12-31"), 100);
        expect(result.occurrences).toHaveLength(100);
        expect(result.truncated).toBe(true);
    });
});

describe("NSW official data", () => {
    const weekday = (d: string) => ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][isoWeekday(d) - 1];

    it("has the right weekday for every holiday whose day is fixed by the Act", () => {
        for (const h of NSW_PUBLIC_HOLIDAYS) {
            if (h.name === "Good Friday") expect(weekday(h.date), h.date).toBe("Fri");
            if (h.name === "Easter Saturday") expect(weekday(h.date), h.date).toBe("Sat");
            if (h.name === "Easter Monday" || h.name === "King's Birthday" || h.name === "Labour Day" || h.name === "Bank Holiday")
                expect(weekday(h.date), h.date).toBe("Mon");
            if (h.name === "King's Birthday") expect(Number(h.date.slice(8)), h.date).toBeGreaterThan(7);
            if (h.name === "Labour Day") expect(Number(h.date.slice(8)), h.date).toBeLessThanOrEqual(7);
            if (h.kind === "additional") expect(["Mon", "Tue"], h.date).toContain(weekday(h.date));
            expect(SOURCES[h.source], h.date).toBeDefined();
        }
        // The additional Anzac Day on the Monday after a weekend Anzac Day (published for 2026 and 2027).
        expect(NSW_PUBLIC_HOLIDAYS.filter((h) => h.name.startsWith("Anzac")).map((h) => h.date)).toEqual([
            "2025-04-25",
            "2026-04-25",
            "2026-04-27",
            "2027-04-25",
            "2027-04-26",
            "2028-04-25",
        ]);
        expect(NSW_PUBLIC_HOLIDAYS.filter((h) => h.provisional).every((h) => h.date.startsWith("2028"))).toBe(true);
    });

    it("has school periods that start before they end, terms that don't overlap holidays, and a source for each", () => {
        for (const p of NSW_SCHOOL_PERIODS) {
            expect(p.start <= p.end, p.id).toBe(true);
            expect(SOURCES[p.source], p.id).toBeDefined();
        }
        for (const division of ["eastern", "western"] as const) {
            const relevant = NSW_SCHOOL_PERIODS.filter(
                (p) => p.kind !== "development_day" && (p.division === "both" || p.division === division) && !(p.year === 2025 || p.year === 2028),
            );
            const terms = relevant.filter((p) => p.kind === "term");
            const holidays = relevant.filter((p) => p.kind === "holidays");
            for (const t of terms) for (const h of holidays) expect(t.end < h.start || h.end < t.start, `${t.id} vs ${h.id}`).toBe(true);
        }
        // July 2026 school holidays: Monday 6 to Friday 17 July.
        expect(schoolHolidaysBetween("2026-07-01", "2026-07-31", "eastern").map((p) => [p.start, p.end])).toEqual([["2026-07-06", "2026-07-17"]]);
        // Western division's summer holidays run a week longer.
        expect(schoolHolidaysBetween("2027-01-20", "2027-01-31", "western")[0].end).toBe("2027-02-03");
    });

    it("applies the Bank Holiday and regional holidays only when they apply", () => {
        const regional = [
            {
                id: "ccd_1",
                kind: "regional_holiday" as const,
                name: "Show day",
                start: "2026-04-10",
                end: "2026-04-10",
                region: "Dubbo",
                school: null,
                scope: "household" as const,
                mine: false,
            },
        ];
        expect(applicableHolidays({ includeBankHoliday: false, region: null }, regional).has("2026-08-03")).toBe(false);
        expect(applicableHolidays({ includeBankHoliday: true, region: null }, regional).has("2026-08-03")).toBe(true);
        expect(applicableHolidays({ includeBankHoliday: false, region: "Sydney" }, regional).has("2026-04-10")).toBe(false);
        expect(applicableHolidays({ includeBankHoliday: false, region: "dubbo" }, regional).get("2026-04-10")).toBe("Show day");
    });
});

// --- Leave ---------------------------------------------------------------------------------------

const ctx = leaveContext(DEFAULT_PATTERN, { includeBankHoliday: false, region: null }, []);
const annual = (over: Partial<LeaveTypeInfo> = {}): LeaveTypeInfo => ({
    id: "lvt_annual000000000",
    kind: "annual",
    name: "Annual leave",
    color: "blue",
    paid: true,
    tracksBalance: true,
    balanceHours: 100,
    balanceDate: "2026-06-30",
    accrual: LEAVE_PRESETS.annual.accrual,
    deductsPublicHolidays: false,
    archived: false,
    version: 1,
    ...over,
});
let n = 0;
const booking = (over: Partial<LeaveBookingInfo>): LeaveBookingInfo => ({
    id: `lvb_${String(n++).padStart(14, "0")}`,
    leaveTypeId: "lvt_annual000000000",
    scenarioId: null,
    startDate: "2026-10-05",
    endDate: "2026-10-09",
    part: "full",
    hours: null,
    dayHours: null,
    status: "approved",
    title: null,
    note: null,
    version: 1,
    updatedAt: "",
    ...over,
});

describe("leave engine", () => {
    it("costs leave in the person's own hours, skipping weekends and public holidays", () => {
        const type = annual();
        // Mon 5 Oct 2026 is Labour Day: 4 working days of 7.6 h.
        expect(bookingHours(booking({}), type, ctx)).toBe(30.4);
        expect(bookingDays(booking({}), type, ctx)[0]).toMatchObject({ date: "2026-10-05", hours: 0, reason: "public_holiday", holiday: "Labour Day" });
        // The Anzac Day additional day (Mon 27 Apr 2026) isn't deducted; the Saturday is a weekend anyway.
        expect(bookingHours(booking({ startDate: "2026-04-25", endDate: "2026-04-30" }), type, ctx)).toBe(22.8);
        // Unless the type counts public holidays as leave.
        expect(bookingHours(booking({}), annual({ deductsPublicHolidays: true }), ctx)).toBe(38);
        // Part days.
        expect(bookingHours(booking({ startDate: "2026-10-07", endDate: "2026-10-07", part: "am" }), type, ctx)).toBe(3.8);
        expect(bookingHours(booking({ startDate: "2026-10-07", endDate: "2026-10-07", part: "hours", hours: 2.5 }), type, ctx)).toBe(2.5);
    });

    it("handles part-time and fortnightly rostered patterns", () => {
        const partTime = leaveContext({ kind: "weekly", hours: [8, 8, 0, 6, 0, 0, 0] }, { includeBankHoliday: false, region: null }, []);
        expect(weeklyHours({ kind: "weekly", hours: [8, 8, 0, 6, 0, 0, 0] })).toBe(22);
        // Mon 12 – Fri 16 Oct 2026: Mon 8 + Tue 8 + Thu 6.
        expect(bookingHours(booking({ startDate: "2026-10-12", endDate: "2026-10-16" }), annual(), partTime)).toBe(22);
        const nineDay = { kind: "fortnightly" as const, anchor: "2026-10-12", hours: [8.4, 8.4, 8.4, 8.4, 8.4, 0, 0, 8.4, 8.4, 8.4, 8.4, 0, 0, 0] };
        expect(patternHours(nineDay, "2026-10-23")).toBe(0); // the RDO
        expect(patternHours(nineDay, "2026-10-16")).toBe(8.4);
        expect(patternHours(nineDay, "2026-11-06")).toBe(0); // two fortnights later
        expect(patternHours(nineDay, "2026-10-09")).toBe(0); // the fortnight before
    });

    it("accrues four weeks a year for a full-time year, and nothing during unpaid leave", () => {
        const type = annual({ balanceHours: 0, balanceDate: "2026-12-31" });
        const year = balanceAt({ type, bookings: [], adjustments: [], types: [type] }, ctx, "2027-12-31");
        // 261 weekdays in 2027 × 7.6 h × 4/52 (public holidays are paid days, so they accrue too).
        expect(year.accrued).toBeCloseTo(261 * 7.6 * (4 / 52), 1);
        expect(year.closing).toBeCloseTo(152.6, 0);
        const unpaid: LeaveTypeInfo = { ...annual(), id: "lvt_unpaid00000000", kind: "unpaid", name: "Unpaid", paid: false, tracksBalance: false };
        const withUnpaid = balanceAt(
            { type, bookings: [booking({ leaveTypeId: unpaid.id, startDate: "2027-07-05", endDate: "2027-07-09" })], adjustments: [], types: [type, unpaid] },
            ctx,
            "2027-12-31",
        );
        expect(year.accrued - withUnpaid.accrued).toBeCloseTo(5 * 7.6 * (4 / 52), 3);
    });

    it("counts bookings by status and keeps scenarios apart, and ignores what's already in the entered balance", () => {
        const type = annual({ accrual: { ...LEAVE_PRESETS.annual.accrual, method: "none", rate: null } });
        const bookings = [
            booking({ status: "approved" }),
            booking({ startDate: "2026-11-02", endDate: "2026-11-02", status: "requested" }),
            booking({ startDate: "2026-11-03", endDate: "2026-11-03", status: "draft" }),
            booking({ startDate: "2026-11-04", endDate: "2026-11-04", status: "cancelled" }),
            booking({ startDate: "2026-11-05", endDate: "2026-11-05", status: "draft", scenarioId: "lvs_scenario000000" }),
            booking({ startDate: "2026-06-01", endDate: "2026-06-05", status: "taken" }), // before the balance date
        ];
        const input = { type, bookings, adjustments: [{ leaveTypeId: type.id, date: "2026-07-15", hours: 7.6 }], types: [type] };
        expect(balanceAt(input, ctx, "2026-12-31", "confirmed").closing).toBeCloseTo(100 + 7.6 - 30.4, 6);
        expect(balanceAt(input, ctx, "2026-12-31", "planned").closing).toBeCloseTo(100 + 7.6 - 30.4 - 7.6, 6);
        expect(balanceAt(input, ctx, "2026-12-31", "all").closing).toBeCloseTo(100 + 7.6 - 30.4 - 15.2, 6);
        expect(balanceAt(input, ctx, "2026-12-31", "planned", "lvs_scenario000000").closing).toBeCloseTo(100 + 7.6 - 30.4 - 7.6 - 7.6, 6);
        expect(counts({ status: "draft", scenarioId: "lvs_other" }, "all", null)).toBe(false);
        const breakdown = balanceAt(input, ctx, "2026-12-31", "planned");
        expect(breakdown.deductions.map((d) => d.hours)).toEqual([30.4, 7.6]);
        expect(breakdown.adjustments).toBe(7.6);
        expect(balanceAt(input, ctx, "2026-06-01").beforeBalanceDate).toBe(true);
    });

    it("applies caps and yearly resets, and says when a balance goes negative", () => {
        const capped = annual({ balanceHours: 150, balanceDate: "2026-06-30", accrual: { ...LEAVE_PRESETS.annual.accrual, cap: 152 } });
        const c = balanceAt({ type: capped, bookings: [], adjustments: [], types: [capped] }, ctx, "2026-12-31");
        expect(c.closing).toBe(152);
        expect(c.capped).toBeGreaterThan(0);
        const reset = annual({ balanceHours: 50, accrual: { ...LEAVE_PRESETS.other.accrual, reset: { month: 7, day: 1, carryOver: 20 } } });
        expect(balanceAt({ type: reset, bookings: [], adjustments: [], types: [reset] }, ctx, "2026-07-02")).toMatchObject({ closing: 20, forfeited: 30 });
        const low = annual({ balanceHours: 10, accrual: { ...LEAVE_PRESETS.other.accrual } });
        const neg = balanceAt(
            { type: low, bookings: [booking({ startDate: "2026-07-13", endDate: "2026-07-17" })], adjustments: [], types: [low] },
            ctx,
            "2026-08-31",
        );
        expect(neg.negativeFrom).toBe("2026-07-14");
        expect(neg.lowest.hours).toBe(-28);
        const series = forecastSeries({ type: low, bookings: [], adjustments: [], types: [low] }, ctx, "2026-07-15", 3);
        expect(series.map((p) => p.date)).toEqual(["2026-07-31", "2026-08-31", "2026-09-30"]);
    });
});

describe("leave optimiser", () => {
    it("finds the longest break for a number of hours", () => {
        // 35 hours at 7 h a day is five days of leave: a week bridged by two weekends gives nine days.
        const seven = leaveContext({ kind: "weekly", hours: [7, 7, 7, 7, 7, 0, 0] }, { includeBankHoliday: false, region: null }, []);
        const best = longestBreak(planDays(seven, "2026-11-01", "2026-11-30"), 35, { minLeaveDays: 1 })!;
        expect(best).toMatchObject({ days: 9, leaveDays: 5, leaveHours: 35 });
        // Around Christmas 2026 the same hours go much further.
        const xmas = longestBreak(planDays(seven, "2026-12-14", "2027-01-10"), 35, { minLeaveDays: 1 })!;
        expect(xmas.days).toBeGreaterThan(9);
        expect(xmas.publicHolidays.map((p) => p.name)).toEqual(expect.arrayContaining(["Christmas Day"]));
    });

    it("ranks public holiday opportunities by days off per day of leave", () => {
        const options = bestOpportunities(planDays(ctx, "2027-03-01", "2027-05-31"), 38);
        // Easter 2027 (Good Friday 26 March, Easter Monday 29 March): four days of leave make ten days off,
        // either side of Easter; ties go to the earlier one.
        expect(options[0]).toMatchObject({ start: "2027-03-20", end: "2027-03-29", leaveDays: 4, days: 10 });
        expect(options[0].publicHolidays.map((p) => p.name)).toEqual(["Good Friday", "Easter Saturday", "Easter Sunday", "Easter Monday"]);
        expect(options.some((o) => o.start === "2027-03-26" && o.days === 10)).toBe(true);
        expect(options[0].efficiency).toBe(2.5);
        expect(options.every((o) => o.publicHolidays.length > 0)).toBe(true);
    });

    it("costs a school holiday period and notices leave already planned in it", () => {
        const winter = schoolHolidaysBetween("2026-07-01", "2026-07-31", "eastern");
        const days = planDays(ctx, "2026-06-20", "2026-07-31");
        expect(coverPeriod(days, "2026-07-06", "2026-07-17")).toMatchObject({
            start: "2026-07-04",
            end: "2026-07-19",
            days: 16,
            leaveDays: 10,
            leaveHours: 76,
        });
        const [plan] = schoolHolidayPlans(ctx, winter, new Set(["2026-07-08"]));
        expect(plan.booked).toBe(true);
        expect(plan.uncoveredDays).toBe(9);
    });

    it("finds time off two people can take together, each on their own hours", () => {
        const partner = leaveContext({ kind: "weekly", hours: [0, 8, 8, 8, 8, 0, 0] }, { includeBankHoliday: false, region: null }, []);
        const breaks = jointBreaks(planDays(ctx, "2026-11-01", "2026-11-30"), planDays(partner, "2026-11-01", "2026-11-30"), 15.2, 16);
        expect(breaks[0].days).toBeGreaterThanOrEqual(4);
        expect(breaks[0].mine.leaveHours).toBeLessThanOrEqual(15.2);
        expect(breaks[0].theirs.leaveHours).toBeLessThanOrEqual(16);
    });
});
