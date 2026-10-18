// The Daily Planner's deterministic core (src/shared/planner/engine.ts): planning hours after leave,
// public holidays and days off, daylight saving in Sydney, free time and buffers, conflicts,
// capacity and suggestions. No database, no network, no clock: "now" is always passed in.
import { describe, expect, it } from "vitest";
import { leaveContext } from "../src/shared/calendar/holidays";
import { DEFAULT_LEAVE_SETTINGS, DEFAULT_PATTERN } from "../src/shared/calendar/leave";
import { wallClock, zonedInstant } from "../src/shared/calendar/time";
import {
    type Availability,
    type Commitment,
    type DayInputs,
    type PlanTask,
    availability,
    capacity,
    conflictsFor,
    freeTime,
    merge,
    planOrder,
    subtract,
    suggestPlan,
} from "../src/shared/planner/engine";
import { DEFAULT_PLANNER_PREFERENCES, type PlannerPreferences, plannerPreferences } from "../src/shared/planner/types";

const SYD = "Australia/Sydney";
const at = (date: string, time: string) => zonedInstant(date, time, SYD);
const ms = (date: string, time: string) => Date.parse(at(date, time));
const hours = (a: Availability) => a.window.reduce((s, i) => s + (i.end - i.start), 0) / 3_600_000;
const everyDay = (start = "09:00", end = "17:00"): PlannerPreferences =>
    plannerPreferences.parse({ workingHours: Array.from({ length: 7 }, () => ({ start, end })) });
const inputs = (prefs: PlannerPreferences = DEFAULT_PLANNER_PREFERENCES, extra: Partial<DayInputs> = {}): DayInputs => ({
    prefs,
    timeZone: SYD,
    leaveContext: leaveContext(DEFAULT_PATTERN, DEFAULT_LEAVE_SETTINGS, []),
    leave: [],
    ...extra,
});
const event = (id: string, date: string, start: string, end: string, extra: Partial<Commitment> = {}): Commitment => ({
    id,
    title: id,
    start: at(date, start),
    end: at(date, end),
    kind: "event",
    source: "local",
    shared: false,
    busy: true,
    ...extra,
});
const task = (id: string, extra: Partial<PlanTask> = {}): PlanTask => ({
    id,
    title: id,
    priority: 4,
    dueDate: null,
    dueTime: null,
    deadline: null,
    occurrenceDate: null,
    estimateMinutes: 60,
    scheduledMinutes: 0,
    ...extra,
});

describe("intervals", () => {
    it("merges and subtracts", () => {
        expect(
            merge([
                { start: 5, end: 9 },
                { start: 1, end: 3 },
                { start: 2, end: 6 },
            ]),
        ).toEqual([{ start: 1, end: 9 }]);
        expect(
            subtract(
                [{ start: 0, end: 10 }],
                [
                    { start: 2, end: 3 },
                    { start: 8, end: 12 },
                ],
            ),
        ).toEqual([
            { start: 0, end: 2 },
            { start: 3, end: 8 },
        ]);
    });
});

describe("planning hours", () => {
    it("uses the person's hours on working days only", () => {
        expect(hours(availability("2026-10-19", inputs()))).toBe(8); // Monday
        const saturday = availability("2026-10-24", inputs());
        expect(saturday.window).toEqual([]);
        expect(saturday.offReason).toBe("Not a planning day");
        // Planning on days off as well: a day with no hours of its own uses 9 to 5.
        expect(hours(availability("2026-10-24", inputs({ ...DEFAULT_PLANNER_PREFERENCES, planOnDaysOff: true })))).toBe(8);
        expect(hours(availability("2026-10-24", inputs(everyDay("10:00", "12:00"))))).toBe(2);
    });

    it("leaves out NSW public holidays, non-working days and leave", () => {
        const labourDay = availability("2026-10-05", inputs());
        expect(labourDay.window).toEqual([]);
        expect(labourDay.offReason).toBe("Labour Day");
        const ctx = leaveContext(DEFAULT_PATTERN, DEFAULT_LEAVE_SETTINGS, [
            {
                id: "ccd_x",
                kind: "non_working",
                name: "Rostered day off",
                start: "2026-10-21",
                end: "2026-10-21",
                region: null,
                school: null,
                scope: "personal",
                mine: true,
            },
        ]);
        expect(availability("2026-10-21", inputs(DEFAULT_PLANNER_PREFERENCES, { leaveContext: ctx })).offReason).toBe("Non-working day");
        const leave = (part: "full" | "am" | "pm" | "hours", h: number | null = null) =>
            availability(
                "2026-10-22",
                inputs(DEFAULT_PLANNER_PREFERENCES, { leave: [{ start: "2026-10-20", end: "2026-10-23", part, hours: h, label: "Annual leave" }] }),
            );
        expect(leave("full").offReason).toBe("Annual leave");
        expect(leave("am").window).toEqual([{ start: ms("2026-10-22", "13:00"), end: ms("2026-10-22", "17:00") }]);
        expect(leave("pm").window).toEqual([{ start: ms("2026-10-22", "09:00"), end: ms("2026-10-22", "13:00") }]);
        expect(leave("hours", 3).window).toEqual([{ start: ms("2026-10-22", "09:00"), end: ms("2026-10-22", "14:00") }]);
    });

    it("measures the days daylight saving starts and ends in real hours", () => {
        const night = everyDay("01:00", "04:00");
        // 4 October 2026: 2 am becomes 3 am, so 1–4 am is two hours. 5 April 2026: 3 am becomes 2 am, so it's four.
        expect(hours(availability("2026-10-04", inputs(night, { leaveContext: null })))).toBe(2);
        expect(hours(availability("2026-04-05", inputs(night, { leaveContext: null })))).toBe(4);
        // An ordinary 9 to 5 is eight hours on both sides of each change.
        for (const d of ["2026-10-02", "2026-10-06", "2026-04-02", "2026-04-07"]) expect(hours(availability(d, inputs()))).toBe(8);
        expect(at("2026-10-06", "09:00")).toBe("2026-10-05T22:00:00.000Z");
        expect(at("2026-04-07", "09:00")).toBe("2026-04-06T23:00:00.000Z");
    });
});

describe("free time and conflicts", () => {
    const day = availability("2026-10-19", inputs());

    it("keeps a buffer after each commitment and ignores free events", () => {
        const free = freeTime(day.window, [event("a", "2026-10-19", "10:00", "11:00"), event("b", "2026-10-19", "13:00", "14:00", { busy: false })], 10);
        expect(free).toEqual([
            { start: ms("2026-10-19", "09:00"), end: ms("2026-10-19", "10:00") },
            { start: ms("2026-10-19", "11:10"), end: ms("2026-10-19", "17:00") },
        ]);
        // Nothing before now.
        expect(freeTime(day.window, [], 0, ms("2026-10-19", "15:30"))).toEqual([{ start: ms("2026-10-19", "15:30"), end: ms("2026-10-19", "17:00") }]);
    });

    it("warns about events, subscribed and shared calendars, other blocks, leave, days off, hours and due times", () => {
        const commitments: Commitment[] = [
            event("standup", "2026-10-19", "09:30", "10:00"),
            event("school", "2026-10-19", "09:45", "10:15", { source: "subscription" }),
            event("pickup", "2026-10-19", "09:50", "10:05", { shared: true }),
            { ...event("ttb_other", "2026-10-19", "09:00", "09:40"), kind: "block", source: "block" },
            event("lunch", "2026-10-19", "09:00", "10:00", { busy: false }),
        ];
        const block = { id: "ttb_me", start: at("2026-10-19", "09:15"), end: at("2026-10-19", "10:30"), dueDate: "2026-10-19", dueTime: "10:00" };
        const found = conflictsFor(block, commitments, [day], SYD);
        expect(found.map((c) => c.kind).sort()).toEqual(["after_due", "block", "event", "event", "event"]);
        expect(found.find((c) => c.with?.id === "school")?.message).toBe("Overlaps school (subscribed calendar)");
        expect(found.find((c) => c.with?.id === "pickup")?.message).toBe("Overlaps pickup (shared calendar)");
        expect(found.some((c) => c.with?.id === "lunch")).toBe(false);
        // The block itself is never its own conflict.
        expect(conflictsFor({ ...block, id: "ttb_other" }, commitments, [day], SYD).some((c) => c.with?.id === "ttb_other")).toBe(false);
        expect(conflictsFor({ id: null, start: at("2026-10-19", "16:30"), end: at("2026-10-19", "17:30") }, [], [day], SYD).map((c) => c.kind)).toEqual([
            "outside_hours",
        ]);
        const saturday = availability("2026-10-24", inputs());
        expect(conflictsFor({ id: null, start: at("2026-10-24", "10:00"), end: at("2026-10-24", "11:00") }, [], [saturday], SYD)[0].kind).toBe("day_off");
        const halfLeave = availability(
            "2026-10-22",
            inputs(DEFAULT_PLANNER_PREFERENCES, { leave: [{ start: "2026-10-22", end: "2026-10-22", part: "pm", hours: null, label: "Leave" }] }),
        );
        expect(conflictsFor({ id: null, start: at("2026-10-22", "14:00"), end: at("2026-10-22", "15:00") }, [], [halfLeave], SYD)[0].kind).toBe("leave");
    });
});

describe("capacity", () => {
    it("adds up the day and says when it's over-committed", () => {
        const day = availability("2026-10-19", inputs());
        const busy = [
            event("a", "2026-10-19", "09:00", "12:00"),
            { ...event("ttb_1", "2026-10-19", "13:00", "14:00"), kind: "block" as const, source: "block" as const },
        ];
        const c = capacity(day, busy, DEFAULT_PLANNER_PREFERENCES, 60);
        expect(c).toMatchObject({ workingMinutes: 480, eventMinutes: 180, blockMinutes: 60, freeMinutes: 240, unscheduledMinutes: 60, status: "balanced" });
        expect(capacity(day, busy, DEFAULT_PLANNER_PREFERENCES, 600).status).toBe("over");
        expect(capacity(day, [], DEFAULT_PLANNER_PREFERENCES, 0).status).toBe("light");
        expect(capacity(availability("2026-10-24", inputs()), [], DEFAULT_PLANNER_PREFERENCES, 0)).toMatchObject({
            status: "off",
            offReason: "Not a planning day",
        });
    });
});

describe("suggestions", () => {
    const prefs = everyDay();
    const days = ["2026-10-19", "2026-10-20", "2026-10-21"].map((d) => availability(d, inputs(prefs)));
    const base = {
        from: "2026-10-19",
        to: "2026-10-21",
        today: "2026-10-19",
        now: ms("2026-10-19", "08:00"),
        timeZone: SYD,
        prefs,
        days,
        commitments: [] as Commitment[],
    };

    it("orders overdue first, then the earliest due date, priority, size and id", () => {
        const order = planOrder(
            [
                task("tsk_e", { priority: 1 }),
                task("tsk_d", { dueDate: "2026-10-21", priority: 4 }),
                task("tsk_c", { dueDate: "2026-10-20", priority: 2 }),
                task("tsk_b", { dueDate: "2026-10-20", priority: 1 }),
                task("tsk_a", { deadline: "2026-10-18" }),
            ],
            "2026-10-19",
        ).map((t) => t.id);
        expect(order).toEqual(["tsk_a", "tsk_b", "tsk_c", "tsk_d", "tsk_e"]);
    });

    it("gives the same plan for the same inputs, in free time, on quarter hours, with buffers and never before now", () => {
        const commitments = [event("meeting", "2026-10-19", "09:00", "10:20")];
        const input = {
            ...base,
            now: ms("2026-10-19", "08:47"),
            commitments,
            tasks: [task("tsk_a", { estimateMinutes: 45 }), task("tsk_b", { estimateMinutes: 30 })],
        };
        const first = suggestPlan(input);
        expect(suggestPlan(input)).toEqual(first);
        // The meeting ends 10:20, plus a 10-minute buffer: 10:30. The next session follows the first and its buffer.
        expect(first.suggestions.map((s) => [s.taskId, s.startDate, s.startTime, s.endTime])).toEqual([
            ["tsk_a", "2026-10-19", "10:30", "11:15"],
            ["tsk_b", "2026-10-19", "11:30", "12:00"],
        ]);
        expect(first.unplaced).toEqual([]);
        expect(first.note).toMatch(/Nothing is scheduled until you accept/);
    });

    it("splits long tasks into sessions, keeps to the daily focus limit, and counts time already planned", () => {
        const limited = plannerPreferences.parse({ ...prefs, maxBlockMinutes: 90, dailyFocusMinutes: 120 });
        const plan = suggestPlan({ ...base, prefs: limited, tasks: [task("tsk_big", { estimateMinutes: 240, scheduledMinutes: 30 })] });
        expect(plan.suggestions.map((s) => [s.startDate, s.durationMinutes, `${s.session}/${s.sessions}`])).toEqual([
            ["2026-10-19", 90, "1/3"],
            ["2026-10-19", 30, "2/3"],
            ["2026-10-20", 90, "3/3"],
        ]);
        // Already fully planned: nothing more to suggest.
        expect(suggestPlan({ ...base, tasks: [task("tsk_done", { estimateMinutes: 60, scheduledMinutes: 60 })] }).suggestions).toEqual([]);
    });

    it("finishes before the task is due when it can, and says so when it can't", () => {
        const dueAt11 = task("tsk_due", { dueDate: "2026-10-19", dueTime: "11:00", estimateMinutes: 60 });
        const early = suggestPlan({ ...base, tasks: [dueAt11] });
        expect(early.suggestions[0]).toMatchObject({ startTime: "09:00", endTime: "10:00", late: false });
        const busyMorning = [event("all-morning", "2026-10-19", "08:00", "11:00")];
        const late = suggestPlan({ ...base, commitments: busyMorning, tasks: [dueAt11] });
        expect(late.suggestions[0]).toMatchObject({ startTime: "11:15", late: true });
        expect(late.suggestions[0].reason).toMatch(/no free time before it's due/);
    });

    it("reports tasks that don't fit", () => {
        const full = days.map((d) => d.date).map((d) => event(`busy-${d}`, d, "09:00", "17:00"));
        const plan = suggestPlan({ ...base, commitments: full, tasks: [task("tsk_x", { estimateMinutes: 60 })] });
        expect(plan.suggestions).toEqual([]);
        expect(plan.unplaced).toEqual([{ taskId: "tsk_x", title: "tsk_x", remainingMinutes: 60, reason: "No free time long enough in this period" }]);
    });

    it("plans across the start of daylight saving in local time", () => {
        const dst = availability("2026-10-04", inputs(everyDay("01:00", "05:00"), { leaveContext: null }));
        const plan = suggestPlan({
            ...base,
            from: "2026-10-04",
            to: "2026-10-04",
            today: "2026-10-04",
            now: ms("2026-10-03", "12:00"),
            prefs: everyDay("01:00", "05:00"),
            days: [dst],
            tasks: [task("tsk_night", { estimateMinutes: 120 })],
        });
        // 1:00 to 1:59 is AEST, then 3:00 AEDT: a two-hour session ends at 4:00 local.
        expect(plan.suggestions[0]).toMatchObject({ startTime: "01:00", endTime: "04:00", durationMinutes: 120 });
        expect(wallClock(plan.suggestions[0].end, SYD).time).toBe("04:00");
    });
});
