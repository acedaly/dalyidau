// Shapes for Today (/portal/today): the unified daily dashboard, Plan My Day, the morning and evening
// routines and the Chief of Staff briefing. Shared by the Worker, the browser and MCP.
//
// Today owns no tasks, events or time blocks: it reads them from Tasks, Calendar and the Daily
// Planner, and every change goes back through their own functions and permissions.
import { z } from "zod";
import type { CalendarNotification, EventOccurrence, Overlays } from "../calendar/types";
import type { KnowledgeSpace } from "../knowledge/types";
import type { PlanSuggestion, PlannerConflict, PlannerPreferences, PlannerTaskLists, TimeBlockInfo } from "../planner/types";
import type { Priority } from "../tasks/types";

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time like 09:00");

/** A period on some weekdays (1 = Monday … 7 = Sunday): a break, or time kept for focused work. */
const period = z
    .object({
        label: z.string().trim().max(60).default(""),
        days: z
            .array(z.number().int().min(1).max(7))
            .min(1, "Choose at least one day")
            .max(7)
            .transform((d) => [...new Set(d)].sort()),
        start: clock,
        end: clock,
    })
    .strict()
    .refine((p) => p.end > p.start, { message: "It must end after it starts", path: ["end"] });
export type TodayPeriod = z.output<typeof period>;

export const TODAY_SECTIONS = ["briefing", "capacity", "timeline", "attention", "deadlines", "commitments", "notifications"] as const;
export type TodaySection = (typeof TODAY_SECTIONS)[number];
export const TODAY_SECTION_LABELS: Record<TodaySection, string> = {
    briefing: "Chief of Staff briefing",
    capacity: "Capacity",
    timeline: "Timeline",
    attention: "Needs attention",
    deadlines: "Upcoming deadlines",
    commitments: "Commitments",
    notifications: "Notifications",
};

export const START_VIEWS = ["dashboard", "timeline", "morning"] as const;
export type StartView = (typeof START_VIEWS)[number];
export const START_VIEW_LABELS: Record<StartView, string> = {
    dashboard: "The whole dashboard",
    timeline: "The timeline first",
    morning: "Morning planning (until it's done for the day)",
};

export const CALENDAR_VIEWS = ["day", "week", "agenda"] as const;

export const todayPreferences = z
    .object({
        /** Shown sections, in order. A section that isn't listed is hidden. */
        sections: z
            .array(z.enum(TODAY_SECTIONS))
            .max(TODAY_SECTIONS.length)
            .refine((s) => new Set(s).size === s.length, "Each section once")
            .default([...TODAY_SECTIONS]),
        /** "Open in Calendar" uses this view. */
        calendarView: z.enum(CALENDAR_VIEWS).default("day"),
        /** The timeline as a list (every screen) or a time grid (larger screens). */
        timelineView: z.enum(["list", "grid"]).default("list"),
        startView: z.enum(START_VIEWS).default("dashboard"),
        /** Keep completed tasks and their sessions visible on Today. */
        showCompleted: z.boolean().default(true),
        /** Calendars whose events don't take time from availability (they still show, marked). */
        excludedCalendarIds: z
            .array(z.string().regex(/^cal_[a-z0-9]{14}$/))
            .max(50)
            .default([]),
        /** Taken out of planning hours every week (lunch, school run). */
        breaks: z.array(period).max(10).default([]),
        /** Suggestions use these first (time kept for focused work). */
        focusPeriods: z.array(period).max(10).default([]),
        briefing: z
            .object({
                /** Compact: the counts and the next actions. Full: every fact. */
                detail: z.enum(["compact", "full"]).default("full"),
                /** Show Daly Intelligence's explanation when it's switched on (never invents facts). */
                ai: z.boolean().default(true),
                /** Family commitments (shared calendars) for this many days ahead. */
                lookaheadDays: z.number().int().min(1).max(14).default(7),
            })
            .strict()
            .default({ detail: "full", ai: true, lookaheadDays: 7 }),
    })
    .strict();

export type TodayPreferences = z.output<typeof todayPreferences>;
export const DEFAULT_TODAY_PREFERENCES: TodayPreferences = todayPreferences.parse({});

// --- Capacity ------------------------------------------------------------------------------------

export interface Overbooked {
    start: string;
    end: string;
    startTime: string;
    endTime: string;
    minutes: number;
    /** The commitments that overlap there (titles follow Calendar's privacy rules). */
    with: { id: string; title: string; kind: "event" | "block" }[];
}

export interface TodayCapacity {
    date: string;
    /** Planning hours after leave, holidays, non-working days and breaks. */
    availableMinutes: number;
    /** Busy appointments inside those hours (overlaps counted once). */
    appointmentMinutes: number;
    /** Task sessions inside those hours that don't overlap an appointment (so nothing is counted twice). */
    taskMinutes: number;
    /** Everything committed inside those hours: the union of appointments and sessions. */
    committedMinutes: number;
    /** What's left. */
    freeMinutes: number;
    /** Breaks taken out of the hours. */
    breakMinutes: number;
    /** Commitments outside the planning hours (for information; they don't reduce capacity). */
    outsideMinutes: number;
    /** Where two or more commitments overlap. */
    overbooked: Overbooked[];
    overbookedMinutes: number;
    /** Estimated time still needed for tasks due that day (or overdue, on today) with no session planned. */
    unscheduledMinutes: number;
    /** How much of that doesn't fit in the free time. */
    shortfallMinutes: number;
    focusLimitMinutes: number;
    status: "off" | "light" | "balanced" | "full" | "over";
    offReason: string | null;
    /** How each figure was worked out, in plain words. */
    explanation: string[];
}

// --- Timeline ------------------------------------------------------------------------------------

export type TimelineKind = "event" | "block" | "break" | "leave" | "free" | "focus";

export interface TimelineItem {
    id: string;
    kind: TimelineKind;
    title: string;
    /** Instants, and local times in the person's zone. */
    start: string;
    end: string;
    startTime: string;
    endTime: string;
    minutes: number;
    /** Fixed commitments (events, leave, breaks) can't be moved from Today. */
    fixed: boolean;
    /** A task session that can be moved and resized here. */
    movable: boolean;
    /** From a subscribed or imported calendar, or someone else's: never changed from Today. */
    readOnly: boolean;
    /** Takes time from availability (busy, and its calendar counts). */
    busy: boolean;
    /** In a calendar shared with the household. */
    shared: boolean;
    conflict: boolean;
    detail: string | null;
    url: string | null;
    /** The task, for sessions. */
    taskId: string | null;
}

export interface DayTimeline {
    date: string;
    timeZone: string;
    /** Planning hours (empty on a day off). */
    hours: { start: string; end: string }[];
    allDay: { id: string; title: string; kind: "event" | "leave" | "holiday"; url: string | null }[];
    items: TimelineItem[];
}

// --- Briefing ------------------------------------------------------------------------------------

export interface BriefingRef {
    id: string;
    title: string;
    url: string;
    kind: "task" | "event" | "block" | "project" | "leave" | "conflict" | "review";
    detail?: string;
}

export interface NextAction {
    /** Stable for the same facts. */
    id: string;
    text: string;
    refs: BriefingRef[];
}

export interface TodayBriefing {
    date: string;
    generatedAt: string;
    /** Everything below is read from Portal records. Nothing is inferred or invented. */
    commitments: BriefingRef[];
    priorities: BriefingRef[];
    overdue: BriefingRef[];
    conflicts: BriefingRef[];
    capacity: { availableMinutes: number; committedMinutes: number; freeMinutes: number; shortfallMinutes: number; status: TodayCapacity["status"] };
    projectDeadlines: BriefingRef[];
    family: BriefingRef[];
    unfinishedYesterday: BriefingRef[];
    nextActions: NextAction[];
    /** What wasn't read, so nothing implies it was. */
    notChecked: string[];
}

// --- Notifications -------------------------------------------------------------------------------

export interface TodayNotification {
    id: string;
    source: "calendar" | "tasks" | "intelligence";
    title: string;
    detail: string | null;
    url: string | null;
    at: string;
    /** Calendar notifications can be dismissed from Today. */
    dismissable: boolean;
    kind: CalendarNotification["kind"] | "task_reminder" | "suggestions";
}

// --- Reviews -------------------------------------------------------------------------------------

export interface DailyReview {
    date: string;
    kind: "morning" | "evening";
    priorities: string[];
    summary: ReviewSummary;
    note: string | null;
    version: number;
    updatedAt: string;
}

export const reviewSummary = z
    .object({
        planned: z.number().int().min(0).max(500).default(0),
        rescheduled: z.number().int().min(0).max(500).default(0),
        returned: z.number().int().min(0).max(500).default(0),
        kept: z.number().int().min(0).max(500).default(0),
        completed: z.number().int().min(0).max(500).default(0),
        followUps: z.number().int().min(0).max(50).default(0),
        capacityConfirmed: z.boolean().default(false),
    })
    .strict();
export type ReviewSummary = z.output<typeof reviewSummary>;

// --- The dashboard -------------------------------------------------------------------------------

export interface TodayTask {
    id: string;
    title: string;
    projectId: string;
    projectName: string;
    priority: Priority;
    dueDate: string | null;
    dueTime: string | null;
    deadline: string | null;
    isMilestone: boolean;
}

export interface CommitmentItem {
    id: string;
    title: string;
    date: string;
    when: string;
    calendarName: string;
    shared: boolean;
    url: string;
}

export interface TodayDashboard {
    date: string;
    today: string;
    timeZone: string;
    /** "Good morning" etc., in the person's zone when the page was made. */
    greeting: string;
    now: string;
    preferences: TodayPreferences;
    preferencesVersion: number;
    lists: PlannerTaskLists;
    blocks: TimeBlockInfo[];
    conflicts: PlannerConflict[];
    capacity: TodayCapacity;
    timeline: DayTimeline;
    deadlines: TodayTask[];
    commitments: { personal: CommitmentItem[]; shared: CommitmentItem[] };
    completed: TodayTask[];
    notifications: TodayNotification[];
    briefing: TodayBriefing;
    reviews: { morning: DailyReview | null; evening: DailyReview | null };
    /** For the routines' "tomorrow" step and the date switcher. */
    calendars: { id: string; name: string; kind: "personal" | "shared" | "subscription"; canWrite: boolean; isDefault: boolean }[];
    /** Intelligence is open to this person (Quick Capture's classification, the briefing's explanation). */
    canUseIntelligence: boolean;
    canUseKnowledge: boolean;
}

export interface PlanProposal {
    date: string;
    capacityBefore: TodayCapacity;
    suggestions: (PlanSuggestion & { inFocus: boolean; conflicts: PlannerConflict[] })[];
    unplaced: { taskId: string; title: string; remainingMinutes: number; reason: string }[];
    note: string;
}

export const APPLY_LIMIT = 20;

export interface TodayRoute {
    route: "today";
    dashboard: TodayDashboard;
    /** The Daily Planner's own preferences (working hours, buffers), edited from Today's settings too. */
    plannerPreferences: { preferences: PlannerPreferences; version: number };
    /** Spaces Quick Capture can add a note to (empty without Knowledge). */
    spaces: KnowledgeSpace[];
    /** A block to open (?block=, from the briefing and MCP links). */
    openBlock: string | null;
    /** The day's events and overlays, for the timeline's time grid (the Calendar's own). */
    occurrences: EventOccurrence[];
    overlays: Overlays;
    /** The person's Calendar settings (the grid starts at their working hours). */
    workingHoursStart: string;
}
