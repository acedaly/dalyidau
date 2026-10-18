// Daly Tasks, Milestone 2: the pure scheduling pieces. Weekday-of-month and limited repeats,
// moving a series, exceptions, Quick Add's new phrases and hints, Todoist CSV reading, Upcoming's
// week and month windows, quiet hours and daylight saving. No database. Every name is invented.
import { describe, expect, it } from "vitest";
import { localDate } from "../src/shared/knowledge/dates";
import { zonedInstant } from "../src/shared/tasks/dates";
import { parseQuickAdd } from "../src/shared/tasks/parse";
import {
    type RecurrenceRule,
    describeRule,
    firstOnOrAfter,
    isOccurrence,
    nextOccurrence,
    nthWeekday,
    occurrencesBetween,
    parseStoredRule,
    projectOccurrences,
    recurrenceInput,
    shiftSeries,
    toRRule,
    withAnchor,
} from "../src/shared/tasks/recurrence";
import { checklistDepth, templateInput } from "../src/shared/tasks/templates";
import { ImportFormatError, importKeys, parseCsv, parseTodoistCsv, projectFromFileName } from "../src/shared/tasks/todoist";
import { mineFilter, shiftWindow, upcomingWindow } from "../src/shared/tasks/view-preferences";
import { quietUntil, reminderEmail } from "../worker/tasks/notify";

const rule = (input: Record<string, unknown>, anchor: string): RecurrenceRule => withAnchor(recurrenceInput.parse(input), anchor);
const series = (r: RecurrenceRule, n: number) => occurrencesBetween(r, "1900-01-01", "2100-01-01", n);

describe("monthly repeats on a weekday of the month", () => {
    it("finds the 1st, 2nd, 3rd, 4th and last weekday, across months and years", () => {
        expect(nthWeekday(2026, 11, 1, 1)).toBe("2026-11-02"); // first Monday
        expect(nthWeekday(2026, 11, 2, 2)).toBe("2026-11-10"); // second Tuesday
        expect(nthWeekday(2026, 11, 3, 3)).toBe("2026-11-18"); // third Wednesday
        expect(nthWeekday(2026, 11, -1, 5)).toBe("2026-11-27"); // last Friday
        expect(nthWeekday(2027, 2, -1, 7)).toBe("2027-02-28"); // last Sunday of a short month

        const secondTuesday = rule({ freq: "monthly", monthWeekday: { week: 2, weekday: 2 } }, "2026-11-10");
        expect(series(secondTuesday, 4)).toEqual(["2026-11-10", "2026-12-08", "2027-01-12", "2027-02-09"]);
        const lastFriday = rule({ freq: "monthly", monthWeekday: { week: -1, weekday: 5 } }, "2026-10-30");
        expect(occurrencesBetween(lastFriday, "2026-10-30", "2027-01-31")).toEqual(["2026-11-27", "2026-12-25", "2027-01-29"]);
        // Every 3 months, on the first Monday.
        const quarterly = rule({ freq: "monthly", interval: 3, monthWeekday: { week: 1, weekday: 1 } }, "2026-11-02");
        expect(series(quarterly, 3)).toEqual(["2026-11-02", "2027-02-01", "2027-05-03"]);
        expect(describeRule(secondTuesday)).toBe("Every month on the 2nd Tue");
        expect(describeRule(lastFriday)).toBe("Every month on the last Fri");
        expect(toRRule(lastFriday)).toContain("BYDAY=-1FR");
    });

    it("never offers a fifth weekday, which most months don't have", () => {
        expect(recurrenceInput.safeParse({ freq: "monthly", monthWeekday: { week: 5, weekday: 2 } }).success).toBe(false);
        expect(recurrenceInput.safeParse({ freq: "weekly", monthWeekday: { week: 1, weekday: 2 } }).success).toBe(false);
        expect(recurrenceInput.safeParse({ freq: "monthly", monthDay: 3, monthWeekday: { week: 1, weekday: 2 } }).success).toBe(false);
        expect(recurrenceInput.safeParse({ freq: "monthly", basis: "completion", monthWeekday: { week: 1, weekday: 2 } }).success).toBe(false);
    });

    it("falls on the last Monday to Friday of the month", () => {
        const lastWorkday = rule({ freq: "monthly", lastWorkday: true }, "2026-10-30");
        // Oct 2026 ends on a Saturday, Jan 2027 on a Sunday, Feb 2027 on a Sunday, Jul 2027 on a Saturday.
        expect(series(lastWorkday, 5)).toEqual(["2026-10-30", "2026-11-30", "2026-12-31", "2027-01-29", "2027-02-26"]);
        expect(describeRule(lastWorkday)).toBe("Every month on the last weekday");
        expect(toRRule(lastWorkday)).toContain("BYSETPOS=-1");
    });

    it("keeps month-end and leap-day behaviour from Milestone 1", () => {
        const on31st = rule({ freq: "monthly", monthDay: 31 }, "2027-01-31");
        expect(series(on31st, 4)).toEqual(["2027-01-31", "2027-02-28", "2027-03-31", "2027-04-30"]);
        const leap = rule({ freq: "yearly" }, "2028-02-29");
        expect(series(leap, 3)).toEqual(["2028-02-29", "2029-02-28", "2030-02-28"]);
        const every2Years = rule({ freq: "yearly", interval: 2 }, "2026-12-31");
        expect(series(every2Years, 3)).toEqual(["2026-12-31", "2028-12-31", "2030-12-31"]);
    });
});

describe("limited repeats", () => {
    it("end after a number of occurrences, counting the first", () => {
        const threeTimes = rule({ freq: "weekly", count: 3 }, "2026-10-19");
        expect(series(threeTimes, 10)).toEqual(["2026-10-19", "2026-10-26", "2026-11-02"]);
        expect(nextOccurrence(threeTimes, "2026-10-26", "2026-10-26")).toBe("2026-11-02");
        expect(nextOccurrence(threeTimes, "2026-11-02", "2026-11-02")).toBeNull();
        expect(describeRule(threeTimes)).toBe("Every week on Mon, 3 times");
        expect(toRRule(threeTimes)).toContain("COUNT=3");
        // Done late: the count still counts series dates, not completions.
        expect(nextOccurrence(threeTimes, "2026-10-19", "2026-11-03")).toBeNull();
        expect(recurrenceInput.safeParse({ freq: "daily", count: 0 }).success).toBe(false);
        expect(recurrenceInput.safeParse({ freq: "daily", basis: "completion", count: 3 }).success).toBe(false);
    });

    it("parse as Milestone 1 rules did, with or without the new fields", () => {
        const m1 = '{"freq":"weekly","interval":1,"basis":"scheduled","anchor":"2026-10-21","weekdays":[3]}';
        expect(parseStoredRule(m1)).toEqual({ freq: "weekly", interval: 1, basis: "scheduled", anchor: "2026-10-21", until: null, weekdays: [3] });
        const stored = JSON.stringify(rule({ freq: "monthly", monthWeekday: { week: 2, weekday: 2 }, count: 6 }, "2026-11-10"));
        expect(parseStoredRule(stored)).toEqual(expect.objectContaining({ monthWeekday: { week: 2, weekday: 2 }, count: 6 }));
    });
});

describe("moving the series from an occurrence on", () => {
    it("moves weekdays, days of the month and weekdays of the month with it", () => {
        const monThu = rule({ freq: "weekly", weekdays: [1, 4] }, "2026-10-19");
        const moved = shiftSeries(monThu, "2026-10-19", "2026-10-20")!;
        expect(moved.weekdays).toEqual([2, 5]);
        expect(moved.anchor).toBe("2026-10-20");
        expect(isOccurrence(moved, "2026-10-20")).toBe(true);

        const on15th = shiftSeries(rule({ freq: "monthly", monthDay: 15 }, "2026-10-15"), "2026-10-15", "2026-10-17")!;
        expect(on15th.monthDay).toBe(17);
        const lastDay = shiftSeries(rule({ freq: "monthly", monthDay: -1 }, "2026-10-31"), "2026-10-31", "2026-11-30")!;
        expect(lastDay.monthDay).toBe(-1);
        const secondTue = shiftSeries(rule({ freq: "monthly", monthWeekday: { week: 2, weekday: 2 } }, "2026-11-10"), "2026-11-10", "2026-11-19")!;
        expect(secondTue.monthWeekday).toEqual({ week: 3, weekday: 4 });
        const lastFri = shiftSeries(rule({ freq: "monthly", monthWeekday: { week: -1, weekday: 5 } }, "2026-11-27"), "2026-11-27", "2026-11-26")!;
        expect(lastFri.monthWeekday).toEqual({ week: -1, weekday: 4 });
    });

    it("keeps what's left of a limited series, and refuses a date past its end", () => {
        const five = rule({ freq: "weekly", count: 5 }, "2026-10-05");
        const moved = shiftSeries(five, "2026-10-19", "2026-10-21")!; // the 3rd occurrence moves
        expect(moved.count).toBe(3);
        expect(series(moved, 10)).toEqual(["2026-10-21", "2026-10-28", "2026-11-04"]);
        expect(shiftSeries(rule({ freq: "daily", until: "2026-10-31" }, "2026-10-19"), "2026-10-19", "2026-11-02")).toBeNull();
    });
});

describe("exceptions to a series", () => {
    const weekly = rule({ freq: "weekly" }, "2026-10-19");

    it("pass over skipped dates and land on moved ones, never repeating an occurrence", () => {
        const exceptions = { skip: new Set(["2026-10-26"]), moves: new Map([["2026-11-02", "2026-11-04"]]) };
        expect(nextOccurrence(weekly, "2026-10-19", "2026-10-19", exceptions)).toBe("2026-11-04");
        // Completing the moved occurrence continues from its original place in the series.
        expect(nextOccurrence(weekly, "2026-11-04", "2026-11-04", exceptions)).toBe("2026-11-09");
        // Moved earlier than its series date: still the series date's turn that's used up.
        const earlier = { skip: new Set<string>(), moves: new Map([["2026-11-02", "2026-10-31"]]) };
        expect(nextOccurrence(weekly, "2026-10-26", "2026-10-26", earlier)).toBe("2026-10-31");
        expect(nextOccurrence(weekly, "2026-10-31", "2026-10-31", earlier)).toBe("2026-11-09");
    });

    it("show up in projections with the series date they stand for", () => {
        const exceptions = { skip: new Set(["2026-10-26"]), moves: new Map([["2026-11-02", "2026-11-04"]]) };
        expect(projectOccurrences(weekly, "2026-10-19", "2026-11-10", 14, exceptions)).toEqual([
            { date: "2026-11-04", seriesDate: "2026-11-02" },
            { date: "2026-11-09", seriesDate: "2026-11-09" },
        ]);
    });

    it("are bounded", () => {
        const skipAll = { skip: new Set(series(weekly, 600)), moves: new Map<string, string>() };
        expect(nextOccurrence(weekly, "2026-10-19", "2026-10-19", skipAll)).toBeNull();
        expect(projectOccurrences(weekly, "2026-10-19", "2036-01-01", 14, skipAll)).toEqual([]);
    });
});

describe("dates across Sydney's daylight saving changes", () => {
    it("works out today at midnight either side of each change", () => {
        // Clocks go forward at 2 am on Sunday 4 October 2026 and back at 3 am on Sunday 4 April 2027.
        expect(localDate(new Date("2026-10-03T13:59:00Z"), "Australia/Sydney")).toBe("2026-10-03");
        expect(localDate(new Date("2026-10-03T14:00:00Z"), "Australia/Sydney")).toBe("2026-10-04");
        expect(localDate(new Date("2026-10-04T12:59:00Z"), "Australia/Sydney")).toBe("2026-10-04");
        expect(localDate(new Date("2026-10-04T13:00:00Z"), "Australia/Sydney")).toBe("2026-10-05");
        expect(localDate(new Date("2027-04-03T12:59:00Z"), "Australia/Sydney")).toBe("2027-04-03");
        expect(localDate(new Date("2027-04-03T13:00:00Z"), "Australia/Sydney")).toBe("2027-04-04");
        expect(localDate(new Date("2027-04-04T13:59:00Z"), "Australia/Sydney")).toBe("2027-04-04");
        expect(localDate(new Date("2027-04-04T14:00:00Z"), "Australia/Sydney")).toBe("2027-04-05");
    });

    it("keeps a daily repeat on consecutive calendar dates through both changes", () => {
        const daily = rule({ freq: "daily" }, "2026-10-02");
        expect(occurrencesBetween(daily, "2026-10-02", "2026-10-06")).toEqual(["2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06"]);
        const april = rule({ freq: "daily" }, "2027-04-02");
        expect(occurrencesBetween(april, "2027-04-02", "2027-04-05")).toEqual(["2027-04-03", "2027-04-04", "2027-04-05"]);
        // A 9 am reminder is 9 am local either side: 22:00Z before, 23:00Z after the April change.
        expect(zonedInstant("2026-10-03", "09:00", "Australia/Sydney")).toBe("2026-10-02T23:00:00.000Z");
        expect(zonedInstant("2026-10-05", "09:00", "Australia/Sydney")).toBe("2026-10-04T22:00:00.000Z");
    });
});

describe("Quick Add's new phrases", () => {
    const today = "2026-10-18"; // a Sunday

    it("reads weekday-of-month, every-other and 'in a …' phrases", () => {
        const second = parseQuickAdd("Book club every 2nd tuesday", { today });
        expect(second.title).toBe("Book club");
        expect(second.recurrence).toEqual({ freq: "monthly", interval: 1, monthWeekday: { week: 2, weekday: 2 } });
        expect(second.dueDate).toBe("2026-11-10");
        expect(parseQuickAdd("Rates every last friday of the month", { today }).recurrence).toEqual(
            expect.objectContaining({ monthWeekday: { week: -1, weekday: 5 } }),
        );
        expect(parseQuickAdd("Mow every other monday", { today }).recurrence).toEqual({ freq: "weekly", interval: 2, weekdays: [1] });
        expect(parseQuickAdd("Call the bank in a fortnight", { today }).dueDate).toBe("2026-11-01");
        expect(parseQuickAdd("Renew in a year", { today }).dueDate).toBe("2027-10-18");
        expect(parseQuickAdd("Water plants every Monday", { today }).recurrence).toEqual({ freq: "weekly", interval: 1, weekdays: [1] });
        expect(parseQuickAdd("Pay invoice next Friday", { today }).dueDate).toBe("2026-10-23");
    });

    it("points out date-like words it didn't understand instead of dropping them", () => {
        const eom = parseQuickAdd("Send report end of month", { today });
        expect(eom.title).toBe("Send report end of month");
        expect(eom.dueDate).toBeNull();
        expect(eom.hints).toEqual([{ text: "end of month", message: "isn't a date Quick Add knows" }]);
        const quarter = parseQuickAdd("Review every 2nd tuesday of the quarter", { today });
        expect(quarter.recurrence).toBeNull();
        expect(quarter.hints[0].text).toMatch(/^every 2nd/);
        const project = parseQuickAdd("Paint fence #nowhere", { today, projects: [{ id: "tpj_00000000000001", name: "Garden" }] });
        expect(project.title).toBe("Paint fence #nowhere");
        expect(project.hints).toEqual([{ text: "#nowhere", message: "isn't one of your projects" }]);
        // Second weekday in one title: the first is the date, the second is pointed out.
        expect(parseQuickAdd("Call monday or tuesday", { today }).hints).toEqual([{ text: "tuesday", message: "wasn't read as a date" }]);
        // Understood text gives no hints, and dismissing a kind silences its hints.
        expect(parseQuickAdd("Bins every wednesday at 7pm", { today }).hints).toEqual([]);
        expect(parseQuickAdd("Send report end of month", { today, disabled: ["date"] }).hints).toEqual([]);
    });
});

describe("Todoist CSV", () => {
    const today = "2026-10-18";
    const header = "TYPE,CONTENT,DESCRIPTION,PRIORITY,INDENT,AUTHOR,RESPONSIBLE,DATE,DATE_LANG,TIMEZONE,DURATION,DURATION_UNIT,DEADLINE,DEADLINE_LANG";
    const csv = [
        header,
        "meta,view_style=board,,,,,,,,,,,,",
        'task,Pay rates @admin @bills,"Council, quarterly",1,1,Pat (111),,2026-10-21,en,Australia/Sydney,30,minute,2026-10-31,en',
        "note,Reference number is on the envelope,,,,,,,,,,,,",
        "task,Check bank,,4,2,Pat (111),,,en,,,None,,",
        "section,Garden,,,,,,,,,,,,",
        "task,Mow lawn,,2,1,,Sam (222),every saturday,en,,,None,,",
        "task,Something,,3,1,,,someday maybe,en,,,None,,",
        "task,Deeply,,3,3,,,,en,,,None,,",
    ].join("\r\n");

    it("reads sections, nesting, labels, comments, dates, repeats and deadlines", () => {
        const p = parseTodoistCsv("Home [2203306141].csv", csv, { today, priorityScale: "one_is_highest" });
        expect(p.name).toBe("Home");
        expect(p.sourceId).toBe("2203306141");
        expect(p.board).toBe(true);
        expect(p.sections).toEqual([{ name: "Garden", row: 5 }]);
        expect(p.tasks.map((t) => [t.title, t.depth, t.parent, t.section])).toEqual([
            ["Pay rates", 0, null, null],
            ["Check bank", 1, 0, null],
            ["Mow lawn", 0, null, 0],
            ["Something", 0, null, 0],
            ["Deeply", 1, 3, 0],
        ]);
        expect(p.tasks[0]).toEqual(
            expect.objectContaining({
                labels: ["admin", "bills"],
                description: "Council, quarterly",
                priority: 1,
                dueDate: "2026-10-21",
                deadline: "2026-10-31",
            }),
        );
        expect(p.tasks[0].comments).toEqual(["Reference number is on the envelope"]);
        expect(p.tasks[1].priority).toBe(4);
        expect(p.tasks[2].recurrence).toEqual({ freq: "weekly", interval: 1, weekdays: [6] });
        expect(p.tasks[2].dueDate).toBe("2026-10-24");
        // Not understood: reported, imported without a date.
        expect(p.tasks[3].dueDate).toBeNull();
        expect(p.warnings.some((w) => w.includes("“someday maybe” wasn't understood"))).toBe(true);
        expect(p.warnings.some((w) => w.includes("placed one level below"))).toBe(true);
        expect(p.unsupported).toEqual({ AUTHOR: 2, RESPONSIBLE: 1, TIMEZONE: 1, DURATION: 1, DURATION_UNIT: 1 });
        expect(p.priorityValues).toEqual({ "1": 1, "4": 1, "2": 1, "3": 2 });
    });

    it("maps priorities either way round", () => {
        const api = parseTodoistCsv("Home.csv", csv, { today, priorityScale: "four_is_highest" });
        expect(api.tasks.map((t) => t.priority)).toEqual([4, 1, 3, 2, 2]);
    });

    it("refuses what isn't a Todoist export, and quoted values that never end", () => {
        expect(() => parseTodoistCsv("x.csv", "name,email\nPat,pat@example.com", { today, priorityScale: "one_is_highest" })).toThrow(ImportFormatError);
        expect(() => parseTodoistCsv("x.csv", "", { today, priorityScale: "one_is_highest" })).toThrow(ImportFormatError);
        expect(() => parseCsv('TYPE,CONTENT\ntask,"never closed')).toThrow(ImportFormatError);
        expect(() => parseTodoistCsv("big.csv", `${header}\n${"task,x,,,,,,,,,,,,\n".repeat(150_000)}`, { today, priorityScale: "one_is_highest" })).toThrow(
            ImportFormatError,
        );
        // Control characters are removed; formulas are kept as text (they're never evaluated here).
        const odd = parseTodoistCsv("x.csv", `${header}\ntask,"=HYPERLINK(""x"")\u0007",,,,,,,,,,,,`, { today, priorityScale: "one_is_highest" });
        expect(odd.tasks[0].title).toBe('=HYPERLINK("x")');
    });

    it("gives the same keys for the same export and new keys for renamed tasks", async () => {
        const a = await importKeys(parseTodoistCsv("Home [2203306141].csv", csv, { today, priorityScale: "one_is_highest" }));
        const b = await importKeys(parseTodoistCsv("Home [2203306141].csv", csv, { today, priorityScale: "one_is_highest" }));
        expect(b).toEqual(a);
        const renamed = await importKeys(
            parseTodoistCsv("Home [2203306141].csv", csv.replace("Mow lawn", "Mow the lawn"), { today, priorityScale: "one_is_highest" }),
        );
        expect(renamed.taskKeys[0]).toBe(a.taskKeys[0]);
        expect(renamed.taskKeys[2]).not.toBe(a.taskKeys[2]);
        // A changed description keeps the key but changes the content hash.
        const edited = await importKeys(
            parseTodoistCsv("Home [2203306141].csv", csv.replace("Council, quarterly", "Council"), { today, priorityScale: "one_is_highest" }),
        );
        expect(edited.taskKeys[0]).toBe(a.taskKeys[0]);
        expect(edited.hashes[0]).not.toBe(a.hashes[0]);
        expect(projectFromFileName("folder/Errands.csv")).toEqual({ name: "Errands", sourceId: null });
    });
});

describe("planning windows", () => {
    const today = "2026-10-21"; // a Wednesday

    it("show a fortnight, a Monday-to-Sunday week or a calendar month, never before this week or month", () => {
        expect(upcomingWindow("agenda", null, today)).toEqual({ from: today, days: 14 });
        expect(upcomingWindow("agenda", "2026-10-01", today)).toEqual({ from: today, days: 14 });
        expect(upcomingWindow("week", null, today)).toEqual({ from: "2026-10-19", days: 7 });
        expect(upcomingWindow("week", "2026-11-05", today)).toEqual({ from: "2026-11-02", days: 7 });
        expect(upcomingWindow("week", "2026-10-01", today)).toEqual({ from: "2026-10-19", days: 7 });
        expect(upcomingWindow("month", null, today)).toEqual({ from: "2026-10-01", days: 31 });
        expect(upcomingWindow("month", "2027-02-14", today)).toEqual({ from: "2027-02-01", days: 28 });
        expect(upcomingWindow("week", "nonsense", today)).toEqual({ from: "2026-10-19", days: 7 });
        expect(shiftWindow("month", "2026-12-01", 31, 1)).toBe("2027-01-01");
        expect(shiftWindow("month", "2027-01-01", 31, -1)).toBe("2026-12-01");
        expect(shiftWindow("week", "2026-10-19", 7, 1)).toBe("2026-10-26");
    });

    it("turn My Tasks preferences into a validated filter", () => {
        expect(mineFilter({})).toEqual(expect.objectContaining({ assignee: "mine", status: "open", sort: "due", sectionIds: [] }));
        expect(mineFilter({ sort: "project", sectionIds: ["tsc_00000000000001"] }).sectionIds).toEqual([]);
        expect(mineFilter({ sort: "project" }).sort).toBe("manual");
    });
});

describe("quiet hours and reminder emails", () => {
    it("defer to the end of quiet hours, including across midnight and daylight saving", () => {
        const tz = "Australia/Sydney";
        // 11 pm on Saturday 3 October 2026 (AEST): quiet until 7 am Sunday, which is AEDT.
        expect(quietUntil(new Date("2026-10-03T13:00:00Z"), tz, "22:00", "07:00")).toBe("2026-10-03T20:00:00.000Z");
        // 6 am: still quiet, until 7 am the same day.
        expect(quietUntil(new Date("2026-10-04T19:00:00Z"), tz, "22:00", "07:00")).toBe("2026-10-04T20:00:00.000Z");
        // Noon: not quiet. A daytime window doesn't wrap.
        expect(quietUntil(new Date("2026-10-05T01:00:00Z"), tz, "22:00", "07:00")).toBeNull();
        expect(quietUntil(new Date("2026-10-05T02:30:00Z"), tz, "13:00", "14:00")).toBe("2026-10-05T03:00:00.000Z");
        expect(quietUntil(new Date("2026-10-05T02:30:00Z"), tz, null, null)).toBeNull();
    });

    it("carry the title, date, priority, project and a sign-in link, all escaped, and nothing else", () => {
        const email = reminderEmail(
            {
                task_id: "tsk_00000000000001",
                title: "<b>Pay</b> rates",
                due_date: "2026-10-21",
                due_time: "17:30",
                priority: 1,
                project_name: "Household",
                is_inbox: 0,
            } as Parameters<typeof reminderEmail>[0],
            "https://daly.id.au",
        );
        expect(email.subject).toBe("Reminder: <b>Pay</b> rates");
        expect(email.text).toContain("Due: Wednesday 21 October, 5:30 pm");
        expect(email.text).toContain("Priority: P1 (Urgent)");
        expect(email.text).toContain("https://daly.id.au/portal/tasks/t/tsk_00000000000001");
        expect(email.html).toContain("&lt;b&gt;Pay&lt;/b&gt;");
        expect(email.html).not.toContain("<b>");
    });
});

describe("templates", () => {
    it("validate their checklist and dates", () => {
        expect(templateInput.parse({ name: "Packing", title: "Pack", subtasks: [{ title: " Sunscreen " }] }).subtasks).toEqual([{ title: "Sunscreen" }]);
        const deep = [{ title: "a", children: [{ title: "b", children: [{ title: "c", children: [{ title: "d" }] }] }] }];
        expect(checklistDepth(deep)).toBe(4);
        expect(templateInput.safeParse({ name: "x", title: "x", subtasks: deep }).success).toBe(false);
        expect(templateInput.safeParse({ name: "x", title: "x", dueTime: "09:00" }).success).toBe(false);
        expect(templateInput.safeParse({ name: "x", title: "x", subtasks: Array.from({ length: 101 }, () => ({ title: "y" })) }).success).toBe(false);
    });
});

describe("Milestone 1 compatibility", () => {
    it("still repeats the way existing tasks expect", () => {
        const monWed = rule({ freq: "weekly", weekdays: [3, 1] }, "2026-10-19");
        expect(nextOccurrence(monWed, "2026-10-19", "2026-10-25")).toBe("2026-10-26");
        expect(firstOnOrAfter(rule({ freq: "daily", interval: 3 }, "2026-10-18"), "2026-10-22")).toBe("2026-10-24");
    });
});
