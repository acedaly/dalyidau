// Shapes for the Daily Planner and time blocking, shared by the Worker, the browser, MCP and Chief of
// Staff. A time block is time someone sets aside for one of their tasks: Tasks stays the source of
// truth, and a block never changes a task's dates or status.
import { z } from "zod";
import type { LeaveOverlay } from "../calendar/types";
import type { Priority } from "../tasks/types";

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time like 09:00");
const day = z
    .object({ start: clock, end: clock })
    .strict()
    .refine((d) => d.end > d.start, { message: "The day must end after it starts", path: ["end"] });

/** Monday first. Null: no planning that day. */
const DEFAULT_WEEK = [...Array.from({ length: 5 }, () => ({ start: "09:00", end: "17:00" })), null, null];

export const plannerPreferences = z
    .object({
        /** When to plan work, Monday to Sunday. Events, leave and public holidays are taken out of it. */
        workingHours: z.array(day.nullable()).length(7).default(DEFAULT_WEEK),
        /** Kept free after every event and session. */
        bufferMinutes: z.number().int().min(0).max(60).default(10),
        /** The shortest session worth suggesting, and the longest. */
        minBlockMinutes: z.number().int().min(15).max(240).default(30),
        maxBlockMinutes: z.number().int().min(15).max(480).default(120),
        /** At most this much task time a day, counting blocks already planned. */
        dailyFocusMinutes: z.number().int().min(0).max(960).default(300),
        /** Assumed for a task with no estimate. */
        defaultEstimateMinutes: z.number().int().min(5).max(480).default(60),
        /** Suggest time on weekends, public holidays, non-working days and leave as well. */
        planOnDaysOff: z.boolean().default(false),
    })
    .strict()
    .refine((p) => p.maxBlockMinutes >= p.minBlockMinutes, { message: "The longest session can't be shorter than the shortest", path: ["maxBlockMinutes"] });

export type PlannerPreferences = z.output<typeof plannerPreferences>;
export const DEFAULT_PLANNER_PREFERENCES: PlannerPreferences = plannerPreferences.parse({});

export const BLOCK_LIMITS = {
    minMinutes: 5,
    maxMinutes: 720,
    /** Scheduled blocks one person may have from today on. */
    upcomingPerPerson: 1000,
    /** Days a suggestion may look ahead. */
    suggestDays: 14,
    /** Days one window request may cover. */
    windowDays: 62,
} as const;

/** How a block's time is published in a private feed. Never the task's title. */
export const FEED_TIME_BLOCKS = ["none", "busy", "focus"] as const;
export type FeedTimeBlocks = (typeof FEED_TIME_BLOCKS)[number];
export const FEED_TIME_BLOCK_LABELS: Record<FeedTimeBlocks, string> = {
    none: "Don't include",
    busy: "As “Busy”",
    focus: "As “Focus time”",
};

/** One block as its owner sees it, in their time zone. */
export interface TimeBlockInfo {
    id: string;
    taskId: string;
    /** The task as it is now (Tasks is the source of truth). */
    title: string;
    projectId: string;
    projectName: string;
    priority: Priority;
    taskStatus: "open" | "completed";
    taskDueDate: string | null;
    taskDueTime: string | null;
    recurring: boolean;
    /** For a repeating task: the occurrence this session was for. */
    occurrenceDate: string | null;
    /** A repeating task that has moved on past this session's occurrence (that one is done). */
    earlierOccurrence: boolean;
    /** Instants. */
    start: string;
    end: string;
    /** Local dates and times in the viewer's zone. */
    startDate: string;
    startTime: string;
    endDate: string;
    endTime: string;
    durationMinutes: number;
    /** The zone it was planned in, when it differs from the viewer's. */
    blockTimeZone: string | null;
    status: "scheduled" | "cancelled";
    source: "manual" | "suggestion" | "mcp";
    /** False when the person can no longer change the task's project (archived, or now a viewer). */
    canEdit: boolean;
    version: number;
}

/** A task as the planner lists it: the task's own fields plus its estimate and planned time. */
export interface PlannerTask {
    id: string;
    title: string;
    projectId: string;
    projectName: string;
    priority: Priority;
    dueDate: string | null;
    dueTime: string | null;
    deadline: string | null;
    recurring: boolean;
    isMilestone: boolean;
    estimateMinutes: number | null;
    /** Scheduled (not cancelled) block minutes for the task's current occurrence. */
    scheduledMinutes: number;
    /** Scheduled sessions from now on. */
    upcomingSessions: number;
    canEdit: boolean;
    version: number;
}

export const PLANNER_BUCKETS = ["today", "overdue", "upcoming", "priority", "unscheduled"] as const;
export type PlannerBucket = (typeof PLANNER_BUCKETS)[number];
export const PLANNER_BUCKET_LABELS: Record<PlannerBucket, string> = {
    today: "Today",
    overdue: "Overdue",
    upcoming: "Upcoming",
    priority: "Priority",
    unscheduled: "Unscheduled",
};

export interface PlannerTaskLists {
    tasks: PlannerTask[];
    /** Task ids per bucket, in order. A task can be in more than one. */
    buckets: Record<PlannerBucket, string[]>;
}

export type ConflictKind = "event" | "block" | "leave" | "day_off" | "outside_hours" | "after_due";

export interface PlannerConflict {
    /** The block (or proposed time) the warning is about. */
    blockId: string | null;
    kind: ConflictKind;
    message: string;
    /** What it overlaps, when it's another commitment. */
    with: {
        id: string;
        title: string;
        start: string;
        end: string;
        /** "subscription": an external calendar. */
        source: "local" | "subscription" | "import" | "block";
        /** In a calendar shared with the household. */
        shared: boolean;
    } | null;
}

export interface FreeSlot {
    start: string;
    end: string;
    startDate: string;
    startTime: string;
    endTime: string;
    minutes: number;
}

export interface DayCapacity {
    date: string;
    /** Planning hours that day, after leave, holidays and days off. */
    workingMinutes: number;
    /** Busy events inside them. */
    eventMinutes: number;
    /** Scheduled task blocks inside them. */
    blockMinutes: number;
    /** What's left, before buffers. */
    freeMinutes: number;
    /** Estimated time still needed for tasks due that day or overdue, not yet scheduled. */
    unscheduledMinutes: number;
    focusLimitMinutes: number;
    status: "off" | "light" | "balanced" | "full" | "over";
    /** Why the day has no planning hours, when it doesn't. */
    offReason: string | null;
}

export interface PlanSuggestion {
    /** Stable for the same inputs: `${taskId}:${start}`. */
    id: string;
    taskId: string;
    title: string;
    startDate: string;
    startTime: string;
    endTime: string;
    start: string;
    end: string;
    durationMinutes: number;
    /** For a repeating task: its current occurrence. */
    occurrenceDate: string | null;
    /** Session n of m for this task in this plan. */
    session: number;
    sessions: number;
    /** After the task's due date or deadline because nothing earlier was free. */
    late: boolean;
    reason: string;
}

export interface PlanResult {
    from: string;
    to: string;
    suggestions: PlanSuggestion[];
    /** Tasks that didn't fit, with how much time is still needed. */
    unplaced: { taskId: string; title: string; remainingMinutes: number; reason: string }[];
    /** Nothing is created until each suggestion is accepted. */
    note: string;
}

export interface DayPlan {
    date: string;
    timeZone: string;
    today: string;
    blocks: TimeBlockInfo[];
    free: FreeSlot[];
    capacity: DayCapacity;
    conflicts: PlannerConflict[];
    leave: LeaveOverlay[];
}

export interface PlannerData {
    lists: PlannerTaskLists;
    blocks: TimeBlockInfo[];
    conflicts: PlannerConflict[];
    preferences: PlannerPreferences;
}
