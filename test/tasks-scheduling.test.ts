// Daly Tasks: recurrence, Quick Add parsing and time zones. Pure functions, no database.
import { describe, expect, it } from "vitest";
import { clockLabel, relativeDate, zonedInstant } from "../src/shared/tasks/dates";
import { EMPTY_FILTER, describeFilter, filterFromParams, filterToParams, taskFilter } from "../src/shared/tasks/filters";
import { parseQuickAdd } from "../src/shared/tasks/parse";
import {
    type RecurrenceRule,
    describeRule,
    firstOnOrAfter,
    isoWeekday,
    nextOccurrence,
    occurrencesBetween,
    parseStoredRule,
    recurrenceInput,
    toRRule,
    withAnchor,
} from "../src/shared/tasks/recurrence";

const rule = (input: Record<string, unknown>, anchor: string): RecurrenceRule => withAnchor(recurrenceInput.parse(input), anchor);

describe("recurrence", () => {
    it("knows its weekdays", () => {
        expect(isoWeekday("2026-10-19")).toBe(1); // Monday
        expect(isoWeekday("2026-10-25")).toBe(7);
        expect(isoWeekday("1970-01-01")).toBe(4);
    });

    it("repeats daily and every few days from the anchor", () => {
        const daily = rule({ freq: "daily" }, "2026-10-18");
        expect(nextOccurrence(daily, "2026-10-18", "2026-10-18")).toBe("2026-10-19");
        const every3 = rule({ freq: "daily", interval: 3 }, "2026-10-18");
        expect(occurrencesBetween(every3, "2026-10-18", "2026-10-30")).toEqual(["2026-10-21", "2026-10-24", "2026-10-27", "2026-10-30"]);
        expect(firstOnOrAfter(every3, "2026-10-22")).toBe("2026-10-24");
    });

    it("repeats on chosen weekdays, every weekday and fortnightly", () => {
        const monWed = rule({ freq: "weekly", weekdays: [3, 1] }, "2026-10-19");
        expect(monWed.weekdays).toEqual([1, 3]);
        expect(occurrencesBetween(monWed, "2026-10-19", "2026-11-02")).toEqual(["2026-10-21", "2026-10-26", "2026-10-28", "2026-11-02"]);
        const weekdays = rule({ freq: "weekly", weekdays: [1, 2, 3, 4, 5] }, "2026-10-23");
        expect(nextOccurrence(weekdays, "2026-10-23", "2026-10-23")).toBe("2026-10-26"); // Friday → Monday
        expect(describeRule(weekdays)).toBe("Every weekday");
        const fortnight = rule({ freq: "weekly", interval: 2 }, "2026-10-21");
        expect(occurrencesBetween(fortnight, "2026-10-21", "2026-11-30")).toEqual(["2026-11-04", "2026-11-18"]);
        expect(describeRule(fortnight)).toBe("Every fortnight on Wed");
        // Fortnightly on two days: the off weeks are skipped as a whole.
        const twoDays = rule({ freq: "weekly", interval: 2, weekdays: [2, 4] }, "2026-10-20");
        expect(occurrencesBetween(twoDays, "2026-10-20", "2026-11-06")).toEqual(["2026-10-22", "2026-11-03", "2026-11-05"]);
    });

    it("handles month ends and leap years", () => {
        const on31 = rule({ freq: "monthly" }, "2026-01-31");
        expect(on31.monthDay).toBe(31);
        expect(occurrencesBetween(on31, "2026-01-31", "2026-05-31")).toEqual(["2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31"]);
        expect(nextOccurrence(rule({ freq: "monthly" }, "2028-01-31"), "2028-01-31", "2028-01-31")).toBe("2028-02-29");
        const last = rule({ freq: "monthly", monthDay: -1 }, "2026-04-30");
        expect(occurrencesBetween(last, "2026-04-30", "2026-07-31")).toEqual(["2026-05-31", "2026-06-30", "2026-07-31"]);
        expect(describeRule(last)).toBe("Every month on the last day");
        const leap = rule({ freq: "yearly" }, "2028-02-29");
        expect(occurrencesBetween(leap, "2028-02-29", "2032-12-31")).toEqual(["2029-02-28", "2030-02-28", "2031-02-28", "2032-02-29"]);
        expect(describeRule(leap)).toBe("Every year on 29 Feb");
    });

    it("moves an overdue task to its next future occurrence, not to a past one", () => {
        const weekly = rule({ freq: "weekly" }, "2026-10-05"); // Mondays
        // Completed on Wednesday 21st for the occurrence on the 5th: next is Monday 26th.
        expect(nextOccurrence(weekly, "2026-10-05", "2026-10-21")).toBe("2026-10-26");
        // Completed early (on the 1st) for the occurrence on the 5th: next is the 12th.
        expect(nextOccurrence(weekly, "2026-10-05", "2026-10-01")).toBe("2026-10-12");
    });

    it("counts from completion when asked", () => {
        const after = rule({ freq: "daily", interval: 3, basis: "completion" }, "2026-10-01");
        expect(nextOccurrence(after, "2026-10-01", "2026-10-18")).toBe("2026-10-21");
        expect(describeRule(after)).toBe("Every 3 days after completion");
        expect(occurrencesBetween(after, "2026-10-01", "2026-12-31")).toEqual([]);
        expect(nextOccurrence(rule({ freq: "monthly", basis: "completion" }, "2026-01-31"), "2026-01-31", "2026-01-31")).toBe("2026-02-28");
    });

    it("stops at the end date", () => {
        const until = rule({ freq: "weekly", until: "2026-11-01" }, "2026-10-19");
        expect(nextOccurrence(until, "2026-10-26", "2026-10-26")).toBeNull();
        expect(occurrencesBetween(until, "2026-10-19", "2026-12-31")).toEqual(["2026-10-26"]);
    });

    it("refuses rules that don't make sense", () => {
        expect(recurrenceInput.safeParse({ freq: "daily", weekdays: [1] }).success).toBe(false);
        expect(recurrenceInput.safeParse({ freq: "weekly", weekdays: [] }).success).toBe(false);
        expect(recurrenceInput.safeParse({ freq: "weekly", weekdays: [8] }).success).toBe(false);
        expect(recurrenceInput.safeParse({ freq: "weekly", interval: 0 }).success).toBe(false);
        expect(recurrenceInput.safeParse({ freq: "yearly", interval: 50 }).success).toBe(false);
        expect(recurrenceInput.safeParse({ freq: "monthly", monthDay: 32 }).success).toBe(false);
        expect(recurrenceInput.safeParse({ freq: "weekly", weekdays: [1], basis: "completion" }).success).toBe(false);
        expect(recurrenceInput.safeParse({ freq: "hourly" }).success).toBe(false);
        expect(recurrenceInput.safeParse({ freq: "daily", sql: "1" }).success).toBe(false);
        expect(parseStoredRule('{"freq":"weekly","interval":1,"basis":"scheduled"}')).toBeNull(); // no anchor
        expect(parseStoredRule("not json")).toBeNull();
    });

    it("exports as RRULE", () => {
        expect(toRRule(rule({ freq: "weekly", interval: 2, weekdays: [1, 4], until: "2027-01-31" }, "2026-10-19"))).toBe(
            "DTSTART;VALUE=DATE:20261019\nRRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;UNTIL=20270131",
        );
        expect(toRRule(rule({ freq: "daily", interval: 3, basis: "completion" }, "2026-10-19"))).toContain("X-DALY-BASIS:COMPLETION");
    });
});

describe("Quick Add parsing", () => {
    // Sunday 18 October 2026.
    const today = "2026-10-18";
    const projects = [
        { id: "tpj_aaaaaaaaaaaaaa", name: "Household" },
        { id: "tpj_bbbbbbbbbbbbbb", name: "Wedding Planning" },
    ];

    it("reads dates, priorities, labels and projects and leaves the title", () => {
        const parsed = parseQuickAdd("Pay electricity bill friday p2 @admin #household", { today, projects });
        expect(parsed).toMatchObject({ title: "Pay electricity bill", dueDate: "2026-10-23", priority: 2, labels: ["admin"], projectId: "tpj_aaaaaaaaaaaaaa" });
        expect(parsed.tokens.map((t) => t.kind)).toEqual(["date", "priority", "label", "project"]);
        expect(parseQuickAdd("Confirm transport #WeddingPlanning", { today, projects }).projectId).toBe("tpj_bbbbbbbbbbbbbb");
    });

    it("flags “next friday” as ambiguous rather than guessing silently", () => {
        const parsed = parseQuickAdd("Pay electricity bill next Friday", { today, projects });
        expect(parsed.title).toBe("Pay electricity bill");
        expect(parsed.dueDate).toBe("2026-10-23"); // Friday of next week (today is Sunday)
        expect(parsed.tokens[0].ambiguous).toMatch(/next week/);
        const monday = parseQuickAdd("Call next friday", { today: "2026-10-19", projects });
        expect(monday.dueDate).toBe("2026-10-30");
        expect(parseQuickAdd("Call friday", { today: "2026-10-19", projects }).dueDate).toBe("2026-10-23");
    });

    it("reads repeats and starts them on their first occurrence", () => {
        const bins = parseQuickAdd("Take bins out every Wednesday at 7pm", { today, projects });
        expect(bins).toMatchObject({ title: "Take bins out", dueDate: "2026-10-21", dueTime: "19:00", recurrence: { freq: "weekly", weekdays: [3] } });
        expect(parseQuickAdd("Water plants every 3 days", { today, projects }).recurrence).toEqual({ freq: "daily", interval: 3 });
        expect(parseQuickAdd("Pay rent every 1st", { today, projects })).toMatchObject({ dueDate: "2026-11-01", recurrence: { freq: "monthly", monthDay: 1 } });
        expect(parseQuickAdd("Standup every weekday", { today, projects }).dueDate).toBe("2026-10-19");
        expect(parseQuickAdd("Gym every mon, wed and fri", { today, projects }).recurrence).toEqual({ freq: "weekly", interval: 1, weekdays: [1, 3, 5] });
        expect(parseQuickAdd("Budget review monthly", { today, projects }).recurrence).toEqual({ freq: "monthly", interval: 1 });
    });

    it("reads Australian numeric dates, month names, deadlines and times", () => {
        expect(parseQuickAdd("Renew rego 23/11", { today, projects }).dueDate).toBe("2026-11-23");
        expect(parseQuickAdd("Renew rego 5/3", { today, projects }).dueDate).toBe("2027-03-05"); // passed this year → next year
        expect(parseQuickAdd("Renew rego 31/2", { today, projects }).dueDate).toBeNull(); // not a date: stays text
        expect(parseQuickAdd("Book flights 3 dec", { today, projects }).dueDate).toBe("2026-12-03");
        expect(parseQuickAdd("Book flights Dec 3rd 2027", { today, projects }).dueDate).toBe("2027-12-03");
        expect(parseQuickAdd("Book accommodation tomorrow p2", { today, projects })).toMatchObject({
            title: "Book accommodation",
            dueDate: "2026-10-19",
            priority: 2,
        });
        expect(parseQuickAdd("Tax return {31 oct}", { today, projects })).toMatchObject({ title: "Tax return", deadline: "2026-10-31", dueDate: null });
        expect(parseQuickAdd("Call plumber at 9:30am", { today, projects })).toMatchObject({ dueDate: today, dueTime: "09:30" });
        expect(parseQuickAdd("Dinner 18:45", { today, projects }).dueTime).toBe("18:45");
        expect(parseQuickAdd("Book in 2 weeks", { today, projects }).dueDate).toBe("2026-11-01");
    });

    it("leaves ordinary words and numbers alone", () => {
        for (const text of [
            "Buy 2 boxes of tissues",
            "Fix the today show recording",
            "Email p5 report",
            "Read chapter 12",
            "Ring Mon about the fence",
            "Send #notaproject update",
        ]) {
            const parsed = parseQuickAdd(text, { today, projects });
            expect(parsed.title, text).toBe(
                text === "Fix the today show recording" ? "Fix the show recording" : text === "Ring Mon about the fence" ? "Ring about the fence" : text,
            );
        }
    });

    it("keeps everything as text once a kind is dismissed, and never empties the title", () => {
        const kept = parseQuickAdd("Fix the today show recording", { today, projects, disabled: ["date"] });
        expect(kept).toMatchObject({ title: "Fix the today show recording", dueDate: null });
        expect(parseQuickAdd("tomorrow", { today, projects }).title).toBe("tomorrow");
    });
});

describe("time zones", () => {
    it("works out reminder instants across Sydney's daylight saving changes", () => {
        // Standard time (+10:00) in winter, daylight time (+11:00) in summer.
        expect(zonedInstant("2026-07-01", "09:00", "Australia/Sydney")).toBe("2026-06-30T23:00:00.000Z");
        expect(zonedInstant("2026-12-01", "09:00", "Australia/Sydney")).toBe("2026-11-30T22:00:00.000Z");
        // The day clocks go forward (4 October 2026) and back (5 April 2026).
        expect(zonedInstant("2026-10-04", "09:00", "Australia/Sydney")).toBe("2026-10-03T22:00:00.000Z");
        expect(zonedInstant("2026-04-05", "09:00", "Australia/Sydney")).toBe("2026-04-04T23:00:00.000Z");
        expect(zonedInstant("2026-10-04", "00:30", "Australia/Sydney")).toBe("2026-10-03T14:30:00.000Z");
        // Brisbane has no daylight saving.
        expect(zonedInstant("2026-12-01", "09:00", "Australia/Brisbane")).toBe("2026-11-30T23:00:00.000Z");
    });

    it("labels dates relative to the person's own today", () => {
        expect(relativeDate("2026-10-18", "2026-10-18")).toBe("Today");
        expect(relativeDate("2026-10-19", "2026-10-18")).toBe("Tomorrow");
        expect(relativeDate("2026-10-17", "2026-10-18")).toBe("Yesterday");
        expect(relativeDate("2026-10-22", "2026-10-18")).toBe("Thursday");
        expect(relativeDate("2026-11-03", "2026-10-18")).toBe("Tue 3 Nov");
        expect(relativeDate("2027-01-04", "2026-10-18")).toBe("Mon 4 Jan 2027");
        expect(clockLabel("17:30")).toBe("5:30 pm");
        expect(clockLabel("00:00")).toBe("12 am");
    });
});

describe("filters", () => {
    it("round-trips through the URL and ignores anything invalid", () => {
        const filter = taskFilter.parse({ priorities: [1, 2], labels: ["errands"], due: "overdue", assignee: "me" });
        expect(filterFromParams(filterToParams(filter))).toEqual(filter);
        const bad = filterFromParams(new URLSearchParams("due=yesterday&priorities=1,9&projects=x;DROP TABLE&sort=title"));
        expect(bad).toEqual({ ...EMPTY_FILTER, sort: "title" });
        expect(taskFilter.safeParse({ where: "1=1" }).success).toBe(false);
        expect(describeFilter(filter)).toBe("P1, P2 · Overdue · @errands · Assigned to me");
    });
});
