// Quick Add's text parser: deterministic, no AI, and never silent. It recognises a small grammar
// and reports every piece it took out of the title as a token, which Quick Add shows as a chip the
// person can see and dismiss before saving. Anything it doesn't recognise stays in the title.
//
//   Pay electricity bill friday p2 @admin #household
//   Take bins out every wednesday at 7pm
//   Book accommodation tomorrow {30 nov}            (braces: a deadline)
//
// Dates are read the Australian way (23/10 is 23 October). "next friday" is read as Friday of next
// week and flagged as ambiguous so the chip says which date it chose. A date without a year that has
// already passed this year means next year.
import { addDays } from "../knowledge/dates";
import { type RecurrenceInput, type RecurrenceRule, addMonths, daysInMonth, firstOnOrAfter, isoWeekday, recurrenceInput, withAnchor } from "./recurrence";
import type { Priority } from "./types";

export type TokenKind = "date" | "time" | "priority" | "label" | "project" | "recurrence" | "deadline";

export interface ParsedToken {
    kind: TokenKind;
    /** The text it was read from. */
    text: string;
    /** A note when the reading could reasonably have been different. */
    ambiguous?: string;
}

export interface ParsedTask {
    title: string;
    dueDate: string | null;
    dueTime: string | null;
    deadline: string | null;
    priority: Priority | null;
    labels: string[];
    projectId: string | null;
    recurrence: RecurrenceInput | null;
    tokens: ParsedToken[];
}

const WEEKDAYS: Record<string, number> = {
    mon: 1,
    monday: 1,
    tue: 2,
    tues: 2,
    tuesday: 2,
    wed: 3,
    weds: 3,
    wednesday: 3,
    thu: 4,
    thur: 4,
    thurs: 4,
    thursday: 4,
    fri: 5,
    friday: 5,
    sat: 6,
    saturday: 6,
    sun: 7,
    sunday: 7,
};
const MONTHS: Record<string, number> = {
    jan: 1,
    january: 1,
    feb: 2,
    february: 2,
    mar: 3,
    march: 3,
    apr: 4,
    april: 4,
    may: 5,
    jun: 6,
    june: 6,
    jul: 7,
    july: 7,
    aug: 8,
    august: 8,
    sep: 9,
    sept: 9,
    september: 9,
    oct: 10,
    october: 10,
    nov: 11,
    november: 11,
    dec: 12,
    december: 12,
};
const WD = Object.keys(WEEKDAYS)
    .sort((a, b) => b.length - a.length)
    .join("|");
const MO = Object.keys(MONTHS)
    .sort((a, b) => b.length - a.length)
    .join("|");
// A word boundary that also treats the ends of the text and punctuation as edges.
const START = "(?<=^|[\\s(,])";
const END = "(?=$|[\\s),.!?;])";

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (y: number, m: number, d: number) => (m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m) ? `${y}-${pad(m)}-${pad(d)}` : null);

/** A day and month with no year: this year, or next year if it has passed. */
const dayMonth = (today: string, d: number, m: number, y?: number) => {
    if (y !== undefined) return ymd(y < 100 ? 2000 + y : y, m, d);
    const year = Number(today.slice(0, 4));
    const thisYear = ymd(year, m, d);
    if (!thisYear) return ymd(year + 1, m, d);
    return thisYear < today ? ymd(year + 1, m, d) : thisYear;
};

interface DateReading {
    date: string;
    ambiguous?: string;
}

/** Reads a date phrase that makes up the whole of `phrase`. */
export function readDate(phrase: string, today: string): DateReading | null {
    const p = phrase.trim().toLowerCase().replace(/\s+/g, " ");
    let m: RegExpExecArray | null;
    if (/^(today|tod)$/.test(p)) return { date: today };
    if (/^(tomorrow|tom|tmr|tmrw)$/.test(p)) return { date: addDays(today, 1) };
    if ((m = new RegExp(`^(this |next )?(${WD})$`).exec(p))) {
        const target = WEEKDAYS[m[2]];
        const wd = isoWeekday(today);
        if (m[1] === "next ") {
            const nextMonday = addDays(today, 8 - wd);
            const date = addDays(nextMonday, target - 1);
            return { date, ambiguous: "“next” is read as next week" };
        }
        return { date: addDays(today, (target - wd + 7) % 7) };
    }
    if (p === "next week") return { date: addDays(today, 8 - isoWeekday(today)) };
    if (p === "next month") return { date: `${addMonths(today, 1).slice(0, 7)}-01` };
    if ((m = /^in (\d{1,3}) (day|days|week|weeks|month|months)$/.exec(p))) {
        const n = Number(m[1]);
        if (m[2].startsWith("day")) return { date: addDays(today, n) };
        if (m[2].startsWith("week")) return { date: addDays(today, n * 7) };
        return { date: addMonths(today, n) };
    }
    if ((m = new RegExp(`^(\\d{1,2})(?:st|nd|rd|th)? (${MO})(?:,? (\\d{4}))?$`).exec(p))) {
        const date = dayMonth(today, Number(m[1]), MONTHS[m[2]], m[3] ? Number(m[3]) : undefined);
        return date ? { date } : null;
    }
    if ((m = new RegExp(`^(${MO}) (\\d{1,2})(?:st|nd|rd|th)?(?:,? (\\d{4}))?$`).exec(p))) {
        const date = dayMonth(today, Number(m[2]), MONTHS[m[1]], m[3] ? Number(m[3]) : undefined);
        return date ? { date } : null;
    }
    if ((m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/.exec(p))) {
        const date = dayMonth(today, Number(m[1]), Number(m[2]), m[3] ? Number(m[3]) : undefined);
        return date ? { date } : null;
    }
    if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(p))) {
        const date = ymd(Number(m[1]), Number(m[2]), Number(m[3]));
        return date ? { date } : null;
    }
    return null;
}

const DATE_PHRASE = [
    "today|tod|tomorrow|tom|tmrw|tmr",
    `(?:this |next )?(?:${WD})`,
    "next week|next month",
    "in \\d{1,3} (?:days?|weeks?|months?)",
    `\\d{1,2}(?:st|nd|rd|th)? (?:${MO})(?:,? \\d{4})?`,
    `(?:${MO}) \\d{1,2}(?:st|nd|rd|th)?(?:,? \\d{4})?`,
    "\\d{1,2}/\\d{1,2}(?:/(?:\\d{4}|\\d{2}))?",
    "\\d{4}-\\d{2}-\\d{2}",
].join("|");

const readTime = (text: string): string | null => {
    const p = text.toLowerCase().replace(/^at /, "").trim();
    if (p === "noon" || p === "midday") return "12:00";
    let m = /^(\d{1,2})(?::(\d{2}))? ?(am|pm)$/.exec(p);
    if (m) {
        let h = Number(m[1]);
        const min = Number(m[2] ?? 0);
        if (h < 1 || h > 12 || min > 59) return null;
        if (m[3] === "am") h = h === 12 ? 0 : h;
        else h = h === 12 ? 12 : h + 12;
        return `${pad(h)}:${pad(min)}`;
    }
    m = /^(\d{1,2}):(\d{2})$/.exec(p);
    if (m && Number(m[1]) <= 23 && Number(m[2]) <= 59) return `${pad(Number(m[1]))}:${m[2]}`;
    return null;
};

const readRecurrence = (text: string): RecurrenceInput | null => {
    const p = text.toLowerCase().replace(/\s+/g, " ").trim();
    let m: RegExpExecArray | null;
    const simple: Record<string, RecurrenceInput> = {
        daily: { freq: "daily", interval: 1 },
        weekly: { freq: "weekly", interval: 1 },
        fortnightly: { freq: "weekly", interval: 2 },
        monthly: { freq: "monthly", interval: 1 },
        yearly: { freq: "yearly", interval: 1 },
        annually: { freq: "yearly", interval: 1 },
        "every day": { freq: "daily", interval: 1 },
        "every weekday": { freq: "weekly", interval: 1, weekdays: [1, 2, 3, 4, 5] },
        "every weekend": { freq: "weekly", interval: 1, weekdays: [6, 7] },
        "every week": { freq: "weekly", interval: 1 },
        "every fortnight": { freq: "weekly", interval: 2 },
        "every other week": { freq: "weekly", interval: 2 },
        "every month": { freq: "monthly", interval: 1 },
        "every year": { freq: "yearly", interval: 1 },
        "every other day": { freq: "daily", interval: 2 },
        "every last day": { freq: "monthly", interval: 1, monthDay: -1 },
    };
    if (simple[p]) return simple[p];
    if ((m = /^every (\d{1,3}) (days|weeks|months|years)$/.exec(p))) {
        const freq = ({ days: "daily", weeks: "weekly", months: "monthly", years: "yearly" } as const)[m[2] as "days"];
        return { freq, interval: Number(m[1]) };
    }
    if ((m = /^every (\d{1,2})(?:st|nd|rd|th)$/.exec(p))) {
        const day = Number(m[1]);
        return day >= 1 && day <= 31 ? { freq: "monthly", interval: 1, monthDay: day } : null;
    }
    if ((m = new RegExp(`^every ((?:${WD})(?:(?:, ?| and |,? and )(?:${WD}))*)$`).exec(p))) {
        const days = m[1].split(/, ?| and |,? and /).map((d) => WEEKDAYS[d.trim()]);
        return { freq: "weekly", interval: 1, weekdays: [...new Set(days)].sort() };
    }
    return null;
};

const RECURRENCE_PHRASE = [
    "daily|weekly|fortnightly|monthly|yearly|annually",
    "every (?:day|weekday|weekend|week|fortnight|month|year|other week|other day|last day)",
    "every \\d{1,3} (?:days|weeks|months|years)",
    "every \\d{1,2}(?:st|nd|rd|th)",
    `every (?:${WD})(?:(?:, ?| and |,? and )(?:${WD}))*`,
].join("|");

const TIME_PHRASE = "(?:at )?(?:\\d{1,2}(?::\\d{2})? ?(?:am|pm)|\\d{1,2}:\\d{2}|noon|midday)";

interface Match {
    kind: TokenKind;
    start: number;
    end: number;
    text: string;
}

const PATTERNS: { kind: TokenKind; regex: RegExp }[] = [
    { kind: "deadline", regex: /\{([^{}]{1,40})\}/gi },
    { kind: "recurrence", regex: new RegExp(`${START}(?:${RECURRENCE_PHRASE})${END}`, "gi") },
    { kind: "date", regex: new RegExp(`${START}(?:(?:on|due) )?(?:${DATE_PHRASE})${END}`, "gi") },
    { kind: "time", regex: new RegExp(`${START}${TIME_PHRASE}${END}`, "gi") },
    { kind: "priority", regex: new RegExp(`${START}p[1-4]${END}`, "gi") },
    { kind: "label", regex: new RegExp(`${START}@[\\p{L}\\p{N}_-]{1,60}${END}`, "giu") },
    { kind: "project", regex: new RegExp(`${START}#[\\p{L}\\p{N}_-]{1,120}${END}`, "giu") },
];

const projectKey = (name: string) => name.toLowerCase().replace(/[\s_-]+/g, "");

export interface ParseOptions {
    today: string;
    /** Projects a task can be added to, matched by "#Name" with spaces left out. */
    projects?: { id: string; name: string }[];
    /** Kinds the person has dismissed for this draft: those stay in the title. */
    disabled?: TokenKind[];
}

export function parseQuickAdd(input: string, options: ParseOptions): ParsedTask {
    const { today, projects = [], disabled = [] } = options;
    const matches: Match[] = [];
    const taken = (start: number, end: number) => matches.some((m) => start < m.end && end > m.start);
    for (const { kind, regex } of PATTERNS) {
        if (disabled.includes(kind)) continue;
        regex.lastIndex = 0;
        for (let m = regex.exec(input); m; m = regex.exec(input)) {
            // One of each, except labels; the first wins.
            if (kind !== "label" && matches.some((x) => x.kind === kind)) break;
            if (taken(m.index, m.index + m[0].length)) continue;
            matches.push({ kind, start: m.index, end: m.index + m[0].length, text: m[0] });
        }
    }

    const result: ParsedTask = {
        title: "",
        dueDate: null,
        dueTime: null,
        deadline: null,
        priority: null,
        labels: [],
        projectId: null,
        recurrence: null,
        tokens: [],
    };
    const used: Match[] = [];
    for (const match of matches) {
        const token: ParsedToken = { kind: match.kind, text: match.text.trim() };
        switch (match.kind) {
            case "deadline": {
                const reading = readDate(match.text.slice(1, -1), today);
                if (!reading) continue;
                result.deadline = reading.date;
                token.ambiguous = reading.ambiguous;
                break;
            }
            case "date": {
                const reading = readDate(match.text.replace(/^(on|due) /i, ""), today);
                if (!reading) continue;
                result.dueDate = reading.date;
                token.ambiguous = reading.ambiguous;
                break;
            }
            case "time": {
                const time = readTime(match.text);
                if (!time) continue;
                result.dueTime = time;
                break;
            }
            case "priority":
                result.priority = Number(match.text.slice(1)) as Priority;
                break;
            case "label": {
                const name = match.text.slice(1);
                if (!result.labels.some((l) => l.toLowerCase() === name.toLowerCase())) result.labels.push(name);
                break;
            }
            case "project": {
                const key = projectKey(match.text.slice(1));
                const project = projects.find((p) => projectKey(p.name) === key);
                if (!project) continue;
                result.projectId = project.id;
                break;
            }
            case "recurrence": {
                const rule = readRecurrence(match.text);
                if (!rule) continue;
                result.recurrence = rule;
                break;
            }
        }
        result.tokens.push(token);
        used.push(match);
    }

    // A repeat with no date starts on its first occurrence from today; a time with no date is today.
    if (result.recurrence && !result.dueDate) {
        const parsed = recurrenceInput.safeParse(result.recurrence);
        if (parsed.success) result.dueDate = firstOnOrAfter(withAnchor(parsed.data, today), today);
    }
    if (result.dueTime && !result.dueDate) result.dueDate = today;

    const kept = [...used].sort((a, b) => b.start - a.start).reduce((text, m) => text.slice(0, m.start) + " " + text.slice(m.end), input);
    const title = kept.replace(/\s+/g, " ").trim();
    // Never leave a task with no title: if everything was read as options, keep the words.
    result.title = title || input.replace(/\s+/g, " ").trim();
    result.tokens.sort((a, b) => input.indexOf(a.text) - input.indexOf(b.text));
    return result;
}

/** The rule a parsed repeat will be saved with (anchored on its due date), for previews. */
export const previewRule = (parsed: ParsedTask): RecurrenceRule | null => {
    if (!parsed.recurrence || !parsed.dueDate) return null;
    const rule = recurrenceInput.safeParse(parsed.recurrence);
    return rule.success ? withAnchor(rule.data, parsed.dueDate) : null;
};
