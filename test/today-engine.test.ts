// Today's deterministic core (src/shared/today/engine.ts, and the breaks and focus periods it adds to
// the planner engine): capacity with interval unions, overbooked periods, breaks, leave, non-working
// days, daylight saving, the combined timeline, focus-first suggestions and the recommended next
// actions. No database, no network, no clock: "now" is always passed in. Every name is invented.
import { describe, expect, it } from "vitest";
import { leaveContext } from "../src/shared/calendar/holidays";
import { DEFAULT_LEAVE_SETTINGS, DEFAULT_PATTERN } from "../src/shared/calendar/leave";
import { zonedInstant } from "../src/shared/calendar/time";
import { type Commitment, type DayInputs, type PlanTask, availability, conflictsFor, suggestPlan } from "../src/shared/planner/engine";
import { type PlannerPreferences, type TimeBlockInfo, plannerPreferences } from "../src/shared/planner/types";
import { dayCapacity, dayTimeline, focusOn, nextActions, overbooked } from "../src/shared/today/engine";
import { DEFAULT_TODAY_PREFERENCES, todayPreferences } from "../src/shared/today/types";

const SYD = "Australia/Sydney";
const at = (date: string, time: string) => zonedInstant(date, time, SYD);
const everyDay = (start = "09:00", end = "17:00", extra: Record<string, unknown> = {}): PlannerPreferences =>
    plannerPreferences.parse({ workingHours: Array.from({ length: 7 }, () => ({ start, end })), ...extra });
const inputs = (prefs: PlannerPreferences, extra: Partial<DayInputs> = {}): DayInputs => ({
    prefs,
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
    kind: "event",
    source: "local",
    shared: false,
    busy: true,
    ...extra,
});
const block = (id: string, date: string, start: string, end: string) => commit(id, date, start, end, { kind: "block", source: "block" });
const DAY = "2026-11-02"; // a Monday with no public holiday
const ALL_WEEK = [1, 2, 3, 4, 5, 6, 7];

describe("overbooked periods", () => {
    it("finds where two or more commitments overlap, merges touching pieces, and ignores back-to-back", () => {
        const list = [
            commit("Standup", DAY, "09:00", "10:00"),
            commit("Dentist", DAY, "09:30", "10:30"),
            block("Write report", DAY, "10:15", "11:00"),
            commit("Lunch", DAY, "12:00", "13:00"),
            commit("Call", DAY, "13:00", "13:30"),
            commit("Free event", DAY, "12:30", "12:45", { busy: false }),
        ];
        const o = overbooked(list, SYD);
        expect(o).toHaveLength(2);
        expect(o[0]).toMatchObject({ startTime: "09:30", endTime: "10:00", minutes: 30 });
        expect(o[0].with.map((w) => w.id)).toEqual(["Standup", "Dentist"]);
        expect(o[1]).toMatchObject({ startTime: "10:15", endTime: "10:30", minutes: 15 });
        expect(o[1].with.map((w) => w.kind).sort()).toEqual(["block", "event"]);
    });

    it("counts a triple overlap once, as one period", () => {
        const o = overbooked([commit("a", DAY, "09:00", "11:00"), commit("b", DAY, "09:30", "10:30"), commit("c", DAY, "10:00", "12:00")], SYD);
        expect(o).toHaveLength(1);
        expect(o[0]).toMatchObject({ startTime: "09:30", endTime: "11:00", minutes: 90 });
        expect(o[0].with.map((w) => w.id)).toEqual(["a", "b", "c"]);
    });
});

describe("daily capacity", () => {
    it("uses interval unions: overlapping meetings once, and task time over a meeting not counted again", () => {
        const prefs = everyDay();
        const day = availability(DAY, inputs(prefs));
        const list = [
            commit("Meeting A", DAY, "10:00", "11:00"),
            commit("Meeting B", DAY, "10:30", "11:30"),
            block("Session", DAY, "11:00", "12:00"),
            commit("Evening dinner", DAY, "18:00", "20:00"),
        ];
        const c = dayCapacity(day, list, prefs, 0, SYD);
        expect(c.availableMinutes).toBe(480);
        expect(c.appointmentMinutes).toBe(90); // 10:00–11:30, not 120
        expect(c.taskMinutes).toBe(30); // 11:30–12:00 only
        expect(c.committedMinutes).toBe(120); // 10:00–12:00
        expect(c.freeMinutes).toBe(360);
        expect(c.outsideMinutes).toBe(120);
        expect(c.overbookedMinutes).toBe(60); // 10:30–11:30
        expect(c.status).toBe("over");
        expect(c.explanation.join(" ")).toMatch(/counted once/);
    });

    it("is the same whatever order the commitments come in", () => {
        const prefs = everyDay();
        const day = availability(DAY, inputs(prefs));
        const list = [commit("a", DAY, "09:00", "10:00"), block("b", DAY, "09:30", "11:00"), commit("c", DAY, "13:00", "14:00")];
        expect(dayCapacity(day, [...list].reverse(), prefs, 30, SYD)).toEqual(dayCapacity(day, list, prefs, 30, SYD));
    });

    it("takes breaks out of the planning hours and explains it", () => {
        const prefs = everyDay();
        const breaks = [{ label: "Lunch", days: ALL_WEEK, start: "12:30", end: "13:00" }];
        const day = availability(DAY, inputs(prefs, { breaks }));
        const c = dayCapacity(day, [], prefs, 0, SYD);
        expect(c.availableMinutes).toBe(450);
        expect(c.breakMinutes).toBe(30);
        expect(c.explanation.join(" ")).toMatch(/Lunch 12:30/);
        // A break on other weekdays only doesn't apply.
        const tuesdays = availability(DAY, inputs(prefs, { breaks: [{ label: "Gym", days: [2], start: "12:00", end: "13:00" }] }));
        expect(dayCapacity(tuesdays, [], prefs, 0, SYD).availableMinutes).toBe(480);
    });

    it("has no capacity on a non-working day, a public holiday or full leave, and less on half-day leave", () => {
        const weekdays = plannerPreferences.parse({});
        const sunday = availability("2026-11-01", inputs(weekdays));
        expect(dayCapacity(sunday, [], weekdays, 0, SYD)).toMatchObject({ availableMinutes: 0, status: "off", offReason: "Not a planning day" });
        const labourDay = availability("2026-10-05", inputs(weekdays));
        expect(dayCapacity(labourDay, [], weekdays, 0, SYD)).toMatchObject({ availableMinutes: 0, status: "off" });
        expect(labourDay.offReason).toMatch(/Labour Day/);
        const full = availability(DAY, inputs(weekdays, { leave: [{ start: DAY, end: DAY, part: "full", hours: null, label: "Annual leave" }] }));
        expect(dayCapacity(full, [], weekdays, 0, SYD)).toMatchObject({ availableMinutes: 0, offReason: "Annual leave" });
        const am = availability(DAY, inputs(weekdays, { leave: [{ start: DAY, end: DAY, part: "am", hours: null, label: "Appointment" }] }));
        const c = dayCapacity(am, [], weekdays, 0, SYD);
        expect(c.availableMinutes).toBe(240);
        expect(c.explanation.join(" ")).toMatch(/4 h of leave/);
    });

    it("counts exact hours across daylight saving changes", () => {
        const night = everyDay("01:00", "05:00");
        // No public holidays here: 5 April 2026 is also Easter Sunday.
        const plain = (date: string) => availability(date, inputs(night, { leaveContext: null }));
        // 4 October 2026: 2:00 doesn't exist, so 1:00–5:00 is three real hours.
        expect(dayCapacity(plain("2026-10-04"), [], night, 0, SYD).availableMinutes).toBe(180);
        // 5 April 2026: 2:00–3:00 happens twice, so it's five.
        expect(dayCapacity(plain("2026-04-05"), [], night, 0, SYD).availableMinutes).toBe(300);
        // And a meeting across the change takes its real length.
        const across = dayCapacity(plain("2026-10-04"), [commit("Night call", "2026-10-04", "01:30", "03:30")], night, 0, SYD);
        expect(across.appointmentMinutes).toBe(60);
    });

    it("reports a shortfall when due work doesn't fit the free time or the focus limit", () => {
        const prefs = everyDay("09:00", "17:00", { dailyFocusMinutes: 120 });
        const day = availability(DAY, inputs(prefs));
        const c = dayCapacity(day, [commit("Workshop", DAY, "09:00", "15:00")], prefs, 180, SYD);
        expect(c.freeMinutes).toBe(120);
        expect(c.shortfallMinutes).toBe(60);
        expect(c.status).toBe("over");
        expect(dayCapacity(day, [], prefs, 60, SYD)).toMatchObject({ shortfallMinutes: 0, status: "light" });
    });

    it("leaves calendars the person excluded as free (busy: false) out of availability", () => {
        const prefs = everyDay();
        const day = availability(DAY, inputs(prefs));
        const c = dayCapacity(day, [commit("Partner's roster", DAY, "09:00", "17:00", { busy: false, shared: true })], prefs, 0, SYD);
        expect(c).toMatchObject({ appointmentMinutes: 0, freeMinutes: 480, overbooked: [] });
    });
});

describe("breaks as conflicts", () => {
    it("warns about a session in a break, and doesn't call it leave", () => {
        const prefs = everyDay();
        const breaks = [{ label: "School run", days: ALL_WEEK, start: "15:00", end: "15:30" }];
        const day = availability(DAY, inputs(prefs, { breaks }));
        const c = conflictsFor({ id: "x", start: at(DAY, "14:30"), end: at(DAY, "15:15") }, [], [day], SYD);
        expect(c).toEqual([{ blockId: "x", kind: "break", message: "Overlaps a break (School run)", with: null }]);
    });
});

describe("focus periods in suggestions", () => {
    const task = (id: string, extra: Partial<PlanTask> = {}): PlanTask => ({
        id,
        title: id,
        priority: 2,
        dueDate: DAY,
        dueTime: null,
        deadline: null,
        occurrenceDate: null,
        estimateMinutes: 60,
        scheduledMinutes: 0,
        ...extra,
    });
    const prefs = everyDay("09:00", "17:00", { bufferMinutes: 0 });
    const day = availability(DAY, inputs(prefs));
    const base = { from: DAY, to: DAY, today: DAY, now: Date.parse(at(DAY, "08:00")), timeZone: SYD, prefs, days: [day], commitments: [] as Commitment[] };

    it("uses free time in a focus period first, then the rest of the day, deterministically", () => {
        const focus = focusOn(DAY, [{ label: "Deep work", days: ALL_WEEK, start: "14:00", end: "15:00" }], SYD);
        const a = suggestPlan({ ...base, tasks: [task("tsk_a"), task("tsk_b")], preferred: focus });
        expect(a.suggestions.map((s) => [s.taskId, s.startTime])).toEqual([
            ["tsk_b", "09:00"],
            ["tsk_a", "14:00"],
        ]);
        expect(suggestPlan({ ...base, tasks: [task("tsk_b"), task("tsk_a")], preferred: focus })).toEqual(a);
        // Without focus periods, the earliest free time as before.
        expect(suggestPlan({ ...base, tasks: [task("tsk_a")] }).suggestions[0].startTime).toBe("09:00");
    });

    it("never suggests a session in a break or over a fixed meeting", () => {
        const withBreak = availability(DAY, inputs(prefs, { breaks: [{ label: "Lunch", days: ALL_WEEK, start: "09:00", end: "10:00" }] }));
        const plan = suggestPlan({ ...base, days: [withBreak], commitments: [commit("Board meeting", DAY, "10:00", "11:00")], tasks: [task("tsk_a")] });
        expect(plan.suggestions[0].startTime).toBe("11:00");
    });
});

describe("the timeline", () => {
    const prefs = everyDay();
    const breaks = [{ label: "Lunch", days: ALL_WEEK, start: "12:30", end: "13:00" }];
    const day = availability(DAY, inputs(prefs, { breaks, leave: [{ start: DAY, end: DAY, part: "hours", hours: 2, label: "Appointment" }] }));
    const blockInfo = (id: string, start: string, end: string, extra: Partial<TimeBlockInfo> = {}): TimeBlockInfo => ({
        id,
        taskId: `tsk_${id}`,
        title: `Task ${id}`,
        projectId: "tpj_x",
        projectName: "Home",
        priority: 2,
        taskStatus: "open",
        taskDueDate: null,
        taskDueTime: null,
        recurring: false,
        occurrenceDate: null,
        earlierOccurrence: false,
        start: at(DAY, start),
        end: at(DAY, end),
        startDate: DAY,
        startTime: start,
        endDate: DAY,
        endTime: end,
        durationMinutes: 60,
        blockTimeZone: null,
        status: "scheduled",
        source: "manual",
        canEdit: true,
        version: 1,
        ...extra,
    });
    const events = [
        {
            id: "ev1",
            title: "Team meeting",
            start: at(DAY, "09:00"),
            end: at(DAY, "10:00"),
            allDay: false,
            busy: true,
            counts: true,
            readOnly: false,
            shared: false,
            detail: null,
            url: "/e1",
        },
        {
            id: "ev2",
            title: "School concert",
            start: at(DAY, "10:00"),
            end: at(DAY, "11:00"),
            allDay: false,
            busy: true,
            counts: true,
            readOnly: true,
            shared: true,
            detail: null,
            url: "/e2",
        },
        {
            id: "ev3",
            title: "Pupil-free day",
            start: at(DAY, "00:00"),
            end: at("2026-11-03", "00:00"),
            allDay: true,
            busy: false,
            counts: true,
            readOnly: true,
            shared: true,
            detail: null,
            url: "/e3",
        },
    ];
    const blocks = [blockInfo("b1", "11:00", "12:00"), blockInfo("b2", "13:00", "14:00", { canEdit: false })];
    const commitments = [
        commit("ev1", DAY, "09:00", "10:00"),
        commit("ev2", DAY, "10:00", "11:00"),
        block("b1", DAY, "11:00", "12:00"),
        block("b2", DAY, "13:00", "14:00"),
    ];
    const t = dayTimeline({
        date: DAY,
        timeZone: SYD,
        day,
        events,
        blocks,
        conflicts: [{ blockId: "b1", kind: "event", message: "x", with: null }],
        commitments,
        bufferMinutes: 0,
        focus: focusOn(DAY, [{ label: "Deep work", days: ALL_WEEK, start: "14:00", end: "15:00" }], SYD),
        leave: [],
        holidays: [],
        after: -Infinity,
    });

    it("orders fixed events, movable sessions, breaks, leave, focus and free time by time", () => {
        expect(t.items.map((i) => `${i.startTime} ${i.kind}`)).toEqual([
            "09:00 event",
            "10:00 event",
            "11:00 block",
            "12:00 free",
            "12:30 break",
            "13:00 block",
            "14:00 focus",
            "14:00 free",
            "15:00 leave",
        ]);
        expect(t.allDay).toEqual([{ id: "ev3", title: "Pupil-free day", kind: "event", url: "/e3" }]);
    });

    it("tells fixed commitments from movable sessions, and never offers to change read-only ones", () => {
        const byId = new Map(t.items.map((i) => [i.id, i]));
        expect(byId.get("ev1")).toMatchObject({ fixed: true, movable: false, readOnly: false });
        expect(byId.get("ev2")).toMatchObject({ fixed: true, movable: false, readOnly: true, shared: true });
        expect(byId.get("b1")).toMatchObject({ fixed: false, movable: true, conflict: true, taskId: "tsk_b1" });
        // A session for a task in an archived or read-only project isn't movable.
        expect(byId.get("b2")).toMatchObject({ movable: false, readOnly: true });
    });

    it("hides free time before now on today", () => {
        const later = dayTimeline({
            date: DAY,
            timeZone: SYD,
            day: availability(DAY, inputs(prefs)),
            events: [],
            blocks: [],
            conflicts: [],
            commitments: [],
            bufferMinutes: 0,
            focus: [],
            leave: [],
            holidays: [],
            after: Date.parse(at(DAY, "15:20")),
        });
        expect(later.items).toEqual([expect.objectContaining({ kind: "free", startTime: "15:20", endTime: "17:00", minutes: 100 })]);
    });
});

describe("recommended next actions", () => {
    const ref = (id: string) => ({ id, title: id, url: `/portal/tasks/t/${id}`, kind: "task" as const });
    const facts = {
        isToday: true,
        now: Date.parse(at(DAY, "08:30")),
        conflicts: [] as ReturnType<typeof ref>[],
        overdueUnplanned: [] as ReturnType<typeof ref>[],
        priorities: [] as (ReturnType<typeof ref> & { planned: boolean })[],
        shortfallMinutes: 0,
        freeMinutes: 300,
        nextCommitment: null as (ReturnType<typeof ref> & { start: string }) | null,
        inboxCount: 0,
        unfinishedYesterday: [] as ReturnType<typeof ref>[],
        morningDone: true,
        eveningDone: false,
        localTime: "08:30",
    };

    it("says nothing needs attention rather than inventing something", () => {
        expect(nextActions(facts)).toEqual([{ id: "clear", text: "Nothing needs attention. Your day is planned.", refs: [] }]);
    });

    it("follows fixed rules in a fixed order, naming the records each is about", () => {
        const a = nextActions({
            ...facts,
            nextCommitment: { ...ref("cev_1"), title: "Standup", kind: "task", start: at(DAY, "09:00") },
            conflicts: [ref("conflict:1")],
            overdueUnplanned: [ref("tsk_old")],
            priorities: [
                { ...ref("tsk_p1"), planned: false },
                { ...ref("tsk_p2"), planned: true },
            ],
            shortfallMinutes: 45,
            inboxCount: 3,
            unfinishedYesterday: [ref("tsk_y")],
            morningDone: false,
        });
        expect(a.map((x) => x.id)).toEqual(["next:cev_1", "conflicts", "yesterday", "overdue", "shortfall", "schedule:tsk_p1", "morning", "inbox"]);
        expect(a[0].text).toBe("Get ready for Standup, in 30 min.");
        expect(a.find((x) => x.id === "schedule:tsk_p1")!.refs.map((r) => r.id)).toEqual(["tsk_p1"]);
        // Every reference is one of the facts passed in.
        const known = new Set(["cev_1", "conflict:1", "tsk_old", "tsk_p1", "tsk_y"]);
        for (const x of a) for (const r of x.refs) expect(known.has(r.id)).toBe(true);
    });
});

describe("Today preferences", () => {
    it("has safe defaults and refuses bad periods, duplicate sections and stray fields", () => {
        expect(DEFAULT_TODAY_PREFERENCES.sections).toHaveLength(7);
        expect(DEFAULT_TODAY_PREFERENCES.breaks).toEqual([]);
        expect(todayPreferences.safeParse({ breaks: [{ days: [1], start: "13:00", end: "12:00" }] }).success).toBe(false);
        expect(todayPreferences.safeParse({ sections: ["timeline", "timeline"] }).success).toBe(false);
        expect(todayPreferences.safeParse({ excludedCalendarIds: ["not-an-id"] }).success).toBe(false);
        expect(todayPreferences.safeParse({ somethingElse: true }).success).toBe(false);
        expect(todayPreferences.parse({ focusPeriods: [{ days: [3, 1, 1], start: "09:00", end: "11:00" }] }).focusPeriods[0].days).toEqual([1, 3]);
    });
});
