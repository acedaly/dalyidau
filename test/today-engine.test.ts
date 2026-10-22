// Today's deterministic core (src/shared/today/availability.ts and engine.ts): planning hours after
// leave, public holidays, non-working days and breaks, capacity with interval unions, overbooked
// periods, daylight saving, the combined timeline and the recommended next actions. No database, no
// network, no clock: "now" is always passed in. Every name is invented.
import { describe, expect, it } from "vitest";
import { leaveContext } from "../src/shared/calendar/holidays";
import { DEFAULT_LEAVE_SETTINGS, DEFAULT_PATTERN } from "../src/shared/calendar/leave";
import { zonedInstant } from "../src/shared/calendar/time";
import {
    type Commitment,
    DEFAULT_PLANNING_HOURS,
    type DayInputs,
    type PlanningHours,
    availability,
    freeTime,
    intersect,
    merge,
    planningHours,
    subtract,
} from "../src/shared/today/availability";
import { dayCapacity, dayTimeline, nextActions, overbooked } from "../src/shared/today/engine";
import { DEFAULT_TODAY_PREFERENCES, todayPreferences } from "../src/shared/today/types";

const SYD = "Australia/Sydney";
const at = (date: string, time: string) => zonedInstant(date, time, SYD);
const everyDay = (start = "09:00", end = "17:00", extra: Record<string, unknown> = {}): PlanningHours =>
    planningHours.parse({ workingHours: Array.from({ length: 7 }, () => ({ start, end })), ...extra });
const inputs = (hours: PlanningHours, extra: Partial<DayInputs> = {}): DayInputs => ({
    hours,
    timeZone: SYD,
    leaveContext: leaveContext(DEFAULT_PATTERN, DEFAULT_LEAVE_SETTINGS, []),
    leave: [],
    ...extra,
});
const commit = (id: string, date: string, start: string, end: string, extra: Partial<Commitment> = {}): Commitment => ({
    id,
    title: id,
    start: at(date, start),
    end: at(date, end),
    source: "local",
    shared: false,
    busy: true,
    ...extra,
});
const DAY = "2026-11-02"; // a Monday with no public holiday
const ALL_WEEK = [1, 2, 3, 4, 5, 6, 7];

describe("intervals and planning hours", () => {
    it("merges, subtracts and intersects", () => {
        expect(
            merge([
                { start: 5, end: 8 },
                { start: 1, end: 3 },
                { start: 2, end: 4 },
            ]),
        ).toEqual([
            { start: 1, end: 4 },
            { start: 5, end: 8 },
        ]);
        expect(subtract([{ start: 0, end: 10 }], [{ start: 3, end: 5 }])).toEqual([
            { start: 0, end: 3 },
            { start: 5, end: 10 },
        ]);
        expect(intersect([{ start: 0, end: 10 }], [{ start: 8, end: 12 }])).toEqual([{ start: 8, end: 10 }]);
    });

    it("keeps a buffer after each busy commitment and ignores free events", () => {
        const day = availability(DAY, inputs(everyDay()));
        const free = freeTime(day.window, [commit("a", DAY, "09:00", "10:00"), commit("b", DAY, "11:00", "12:00", { busy: false })], 15);
        expect(free).toEqual([{ start: Date.parse(at(DAY, "10:15")), end: Date.parse(at(DAY, "17:00")) }]);
    });

    it("reads documents saved by the retired Daily Planner, keeping the hours and dropping session settings", () => {
        const stored = {
            workingHours: Array.from({ length: 7 }, () => ({ start: "08:00", end: "16:00" })),
            bufferMinutes: 5,
            minBlockMinutes: 30,
            maxBlockMinutes: 120,
            dailyFocusMinutes: 300,
            defaultEstimateMinutes: 60,
            planOnDaysOff: false,
        };
        expect(planningHours.parse(stored)).toEqual({ workingHours: stored.workingHours, bufferMinutes: 5, planOnDaysOff: false });
        expect(DEFAULT_PLANNING_HOURS.workingHours.filter(Boolean)).toHaveLength(5);
        expect(planningHours.safeParse({ workingHours: [{ start: "17:00", end: "09:00" }] }).success).toBe(false);
        expect(planningHours.safeParse({ somethingElse: true }).success).toBe(false);
    });
});

describe("overbooked periods", () => {
    it("finds where two or more commitments overlap, merges touching pieces, and ignores back-to-back", () => {
        const list = [
            commit("Standup", DAY, "09:00", "10:00"),
            commit("Dentist", DAY, "09:30", "10:30"),
            commit("Lunch", DAY, "12:00", "13:00"),
            commit("Call", DAY, "13:00", "13:30"),
            commit("Free event", DAY, "12:30", "12:45", { busy: false }),
        ];
        const o = overbooked(list, SYD);
        expect(o).toHaveLength(1);
        expect(o[0]).toMatchObject({ startTime: "09:30", endTime: "10:00", minutes: 30 });
        expect(o[0].with.map((w) => w.id)).toEqual(["Standup", "Dentist"]);
    });

    it("counts a triple overlap once, as one period", () => {
        const o = overbooked([commit("a", DAY, "09:00", "11:00"), commit("b", DAY, "09:30", "10:30"), commit("c", DAY, "10:00", "12:00")], SYD);
        expect(o).toHaveLength(1);
        expect(o[0]).toMatchObject({ startTime: "09:30", endTime: "11:00", minutes: 90 });
        expect(o[0].with.map((w) => w.id)).toEqual(["a", "b", "c"]);
    });
});

describe("daily capacity", () => {
    it("uses interval unions: overlapping meetings are counted once", () => {
        const day = availability(DAY, inputs(everyDay()));
        const list = [commit("Meeting A", DAY, "10:00", "11:00"), commit("Meeting B", DAY, "10:30", "11:30"), commit("Evening dinner", DAY, "18:00", "20:00")];
        const c = dayCapacity(day, list, SYD);
        expect(c.availableMinutes).toBe(480);
        expect(c.appointmentMinutes).toBe(90); // 10:00–11:30, not 120
        expect(c.freeMinutes).toBe(390);
        expect(c.outsideMinutes).toBe(120);
        expect(c.overbookedMinutes).toBe(30); // 10:30–11:00
        expect(c.status).toBe("over");
        expect(c.explanation.join(" ")).toMatch(/counted once/);
        expect(c).not.toHaveProperty("taskMinutes");
    });

    it("is the same whatever order the commitments come in", () => {
        const day = availability(DAY, inputs(everyDay()));
        const list = [commit("a", DAY, "09:00", "10:00"), commit("b", DAY, "09:30", "11:00"), commit("c", DAY, "13:00", "14:00")];
        expect(dayCapacity(day, [...list].reverse(), SYD)).toEqual(dayCapacity(day, list, SYD));
    });

    it("calls a lightly booked day light, and a nearly full one full", () => {
        const day = availability(DAY, inputs(everyDay()));
        expect(dayCapacity(day, [commit("a", DAY, "09:00", "10:00")], SYD).status).toBe("light");
        expect(dayCapacity(day, [commit("a", DAY, "09:00", "13:00")], SYD).status).toBe("balanced");
        expect(dayCapacity(day, [commit("a", DAY, "09:00", "16:30")], SYD).status).toBe("full");
    });

    it("takes breaks out of the planning hours and explains it", () => {
        const breaks = [{ label: "Lunch", days: ALL_WEEK, start: "12:30", end: "13:00" }];
        const day = availability(DAY, inputs(everyDay(), { breaks }));
        const c = dayCapacity(day, [], SYD);
        expect(c.availableMinutes).toBe(450);
        expect(c.breakMinutes).toBe(30);
        expect(c.explanation.join(" ")).toMatch(/Lunch 12:30/);
        const tuesdays = availability(DAY, inputs(everyDay(), { breaks: [{ label: "Gym", days: [2], start: "12:00", end: "13:00" }] }));
        expect(dayCapacity(tuesdays, [], SYD).availableMinutes).toBe(480);
    });

    it("has no capacity on a non-working day, a public holiday or full leave, and less on half-day leave", () => {
        const weekdays = planningHours.parse({});
        const sunday = availability("2026-11-01", inputs(weekdays));
        expect(dayCapacity(sunday, [], SYD)).toMatchObject({ availableMinutes: 0, status: "off", offReason: "Not a planning day" });
        const labourDay = availability("2026-10-05", inputs(weekdays));
        expect(dayCapacity(labourDay, [], SYD)).toMatchObject({ availableMinutes: 0, status: "off" });
        expect(labourDay.offReason).toMatch(/Labour Day/);
        const full = availability(DAY, inputs(weekdays, { leave: [{ start: DAY, end: DAY, part: "full", hours: null, label: "Annual leave" }] }));
        expect(dayCapacity(full, [], SYD)).toMatchObject({ availableMinutes: 0, offReason: "Annual leave" });
        const am = availability(DAY, inputs(weekdays, { leave: [{ start: DAY, end: DAY, part: "am", hours: null, label: "Appointment" }] }));
        const c = dayCapacity(am, [], SYD);
        expect(c.availableMinutes).toBe(240);
        expect(c.explanation.join(" ")).toMatch(/4 h of leave/);
    });

    it("counts exact hours across daylight saving changes", () => {
        const night = everyDay("01:00", "05:00");
        // No public holidays here: 5 April 2026 is also Easter Sunday.
        const plain = (date: string) => availability(date, inputs(night, { leaveContext: null }));
        expect(dayCapacity(plain("2026-10-04"), [], SYD).availableMinutes).toBe(180);
        expect(dayCapacity(plain("2026-04-05"), [], SYD).availableMinutes).toBe(300);
        const across = dayCapacity(plain("2026-10-04"), [commit("Night call", "2026-10-04", "01:30", "03:30")], SYD);
        expect(across.appointmentMinutes).toBe(60);
    });

    it("leaves calendars the person excluded as free (busy: false) out of availability", () => {
        const day = availability(DAY, inputs(everyDay()));
        const c = dayCapacity(day, [commit("Partner's roster", DAY, "09:00", "17:00", { busy: false, shared: true })], SYD);
        expect(c).toMatchObject({ appointmentMinutes: 0, freeMinutes: 480, overbooked: [] });
    });
});

describe("the timeline", () => {
    const breaks = [{ label: "Lunch", days: ALL_WEEK, start: "12:30", end: "13:00" }];
    const day = availability(DAY, inputs(everyDay(), { breaks, leave: [{ start: DAY, end: DAY, part: "hours", hours: 2, label: "Appointment" }] }));
    const event = (id: string, title: string, start: string, end: string, extra: Record<string, unknown> = {}) => ({
        id,
        title,
        start: at(DAY, start),
        end: at(DAY, end),
        allDay: false,
        busy: true,
        counts: true,
        readOnly: false,
        shared: false,
        detail: null,
        url: `/${id}`,
        ...extra,
    });
    const events = [
        event("ev1", "Team meeting", "09:00", "10:00"),
        event("ev2", "School concert", "09:30", "11:00", { readOnly: true, shared: true }),
        { ...event("ev3", "Pupil-free day", "00:00", "00:00", { readOnly: true, shared: true, busy: false }), end: at("2026-11-03", "00:00"), allDay: true },
    ];
    const t = dayTimeline({
        date: DAY,
        timeZone: SYD,
        day,
        events,
        commitments: [commit("ev1", DAY, "09:00", "10:00"), commit("ev2", DAY, "09:30", "11:00")],
        bufferMinutes: 0,
        leave: [],
        holidays: [],
        after: -Infinity,
    });

    it("orders events, breaks, leave and free time by time, with all-day items apart", () => {
        expect(t.items.map((i) => `${i.startTime} ${i.kind}`)).toEqual([
            "09:00 event",
            "09:30 event",
            "11:00 free",
            "12:30 break",
            "13:00 free",
            "15:00 leave",
        ]);
        expect(t.allDay).toEqual([{ id: "ev3", title: "Pupil-free day", kind: "event", url: "/ev3" }]);
    });

    it("marks read-only events and the ones in an overbooked period", () => {
        const byId = new Map(t.items.map((i) => [i.id, i]));
        expect(byId.get("ev1")).toMatchObject({ readOnly: false, conflict: true });
        expect(byId.get("ev2")).toMatchObject({ readOnly: true, shared: true, conflict: true });
        expect(t.items.every((i) => !("taskId" in i))).toBe(true);
    });

    it("hides free time before now on today", () => {
        const later = dayTimeline({
            date: DAY,
            timeZone: SYD,
            day: availability(DAY, inputs(everyDay())),
            events: [],
            commitments: [],
            bufferMinutes: 0,
            leave: [],
            holidays: [],
            after: Date.parse(at(DAY, "15:20")),
        });
        expect(later.items).toEqual([expect.objectContaining({ kind: "free", startTime: "15:20", endTime: "17:00", minutes: 100 })]);
    });
});

describe("recommended next actions", () => {
    const ref = (id: string) => ({ id, title: id, url: `/portal/calendar?event=${id}`, kind: "event" as const });
    const facts = {
        isToday: true,
        now: Date.parse(at(DAY, "08:30")),
        conflicts: [] as ReturnType<typeof ref>[],
        freeMinutes: 300,
        availableMinutes: 480,
        nextCommitment: null as (ReturnType<typeof ref> & { start: string }) | null,
    };

    it("says nothing needs attention rather than inventing something", () => {
        expect(nextActions(facts)).toEqual([{ id: "clear", text: "Nothing needs attention.", refs: [] }]);
    });

    it("follows fixed rules in a fixed order, naming the records each is about", () => {
        const a = nextActions({
            ...facts,
            nextCommitment: { ...ref("cev_1"), title: "Standup", start: at(DAY, "09:00") },
            conflicts: [{ ...ref("overbooked:1"), kind: "event" }],
            freeMinutes: 0,
        });
        expect(a.map((x) => x.id)).toEqual(["next:cev_1", "conflicts", "full"]);
        expect(a[0].text).toBe("Get ready for Standup, in 30 min.");
        const known = new Set(["cev_1", "overbooked:1"]);
        for (const x of a) for (const r of x.refs) expect(known.has(r.id)).toBe(true);
    });
});

describe("Today preferences", () => {
    it("has safe defaults and refuses bad periods, duplicate sections and stray fields", () => {
        expect(DEFAULT_TODAY_PREFERENCES.sections).toEqual(["briefing", "capacity", "timeline", "commitments", "notifications"]);
        expect(DEFAULT_TODAY_PREFERENCES.breaks).toEqual([]);
        expect(todayPreferences.safeParse({ breaks: [{ days: [1], start: "13:00", end: "12:00" }] }).success).toBe(false);
        expect(todayPreferences.safeParse({ sections: ["timeline", "timeline"] }).success).toBe(false);
        expect(todayPreferences.safeParse({ excludedCalendarIds: ["not-an-id"] }).success).toBe(false);
        expect(todayPreferences.safeParse({ somethingElse: true }).success).toBe(false);
        expect(todayPreferences.parse({ breaks: [{ days: [3, 1, 1], start: "12:00", end: "12:30" }] }).breaks[0].days).toEqual([1, 3]);
    });

    it("reads documents saved before Daly Tasks was retired, keeping breaks and calendars", () => {
        const stored = {
            ...DEFAULT_TODAY_PREFERENCES,
            sections: ["attention", "timeline", "deadlines", "briefing"],
            startView: "morning",
            showCompleted: false,
            focusPeriods: [{ label: "Deep work", days: [1], start: "09:00", end: "11:00" }],
            breaks: [{ label: "Lunch", days: [1, 2, 3, 4, 5], start: "12:30", end: "13:00" }],
            excludedCalendarIds: ["cal_aaaaaaaaaaaaaa"],
        };
        const parsed = todayPreferences.parse(stored);
        expect(parsed.sections).toEqual(["timeline", "briefing"]);
        expect(parsed.startView).toBe("dashboard");
        expect(parsed.breaks).toHaveLength(1);
        expect(parsed.excludedCalendarIds).toEqual(["cal_aaaaaaaaaaaaaa"]);
        expect(parsed).not.toHaveProperty("focusPeriods");
        expect(parsed).not.toHaveProperty("showCompleted");
    });
});
