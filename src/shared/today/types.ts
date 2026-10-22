// Shapes for Today (/portal/today): the daily dashboard and its Chief of Staff briefing. Shared by
// the Worker, the browser and MCP.
//
// Today owns no events: it reads them from Calendar, and every change goes back through Calendar's
// own functions and permissions.
import { z } from "zod";
import type { TodayAssets } from "../assets/types";
import type { CalendarNotification, EventOccurrence, Overlays } from "../calendar/types";
import type { TodayCentre } from "../centre/types";
import type { PlanningHours } from "./availability";

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time like 09:00");

/** A period on some weekdays (1 = Monday … 7 = Sunday): a break. */
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

export const TODAY_SECTIONS = ["briefing", "capacity", "timeline", "commitments", "notifications"] as const;
export type TodaySection = (typeof TODAY_SECTIONS)[number];
export const TODAY_SECTION_LABELS: Record<TodaySection, string> = {
    briefing: "Chief of Staff briefing",
    capacity: "Capacity",
    timeline: "Timeline",
    commitments: "Commitments",
    notifications: "Notifications",
};

export const START_VIEWS = ["dashboard", "timeline"] as const;
export type StartView = (typeof START_VIEWS)[number];
export const START_VIEW_LABELS: Record<StartView, string> = {
    dashboard: "The whole dashboard",
    timeline: "The timeline first",
};

export const CALENDAR_VIEWS = ["day", "week", "agenda"] as const;

/**
 * Documents saved before Daly Tasks was retired can hold its sections ("attention", "deadlines"),
 * "morning" as the start of the day, "showCompleted" and focus periods. They're read past rather
 * than failing validation (which would drop the person's breaks and calendars), and never saved again.
 */
const withoutRetired = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const { showCompleted: _completed, focusPeriods: _focus, ...rest } = value as Record<string, unknown>;
    if (Array.isArray(rest.sections)) rest.sections = rest.sections.filter((s) => (TODAY_SECTIONS as readonly unknown[]).includes(s));
    if (rest.startView === "morning") rest.startView = "dashboard";
    return rest;
};

export const todayPreferences = z.preprocess(
    withoutRetired,
    z
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
            /** Calendars whose events don't take time from availability (they still show, marked). */
            excludedCalendarIds: z
                .array(z.string().regex(/^cal_[a-z0-9]{14}$/))
                .max(50)
                .default([]),
            /** Taken out of planning hours every week (lunch, school run). */
            breaks: z.array(period).max(10).default([]),
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
        .strict(),
);

export type TodayPreferences = z.output<typeof todayPreferences>;
export const DEFAULT_TODAY_PREFERENCES: TodayPreferences = todayPreferences.parse({});

// --- Capacity ------------------------------------------------------------------------------------

export interface Overbooked {
    start: string;
    end: string;
    startTime: string;
    endTime: string;
    minutes: number;
    /** The events that overlap there (titles follow Calendar's privacy rules). */
    with: { id: string; title: string }[];
}

export interface TodayCapacity {
    date: string;
    /** Planning hours after leave, holidays, non-working days and breaks. */
    availableMinutes: number;
    /** Busy appointments inside those hours (overlaps counted once). */
    appointmentMinutes: number;
    /** What's left. */
    freeMinutes: number;
    /** Breaks taken out of the hours. */
    breakMinutes: number;
    /** Appointments outside the planning hours (for information; they don't reduce capacity). */
    outsideMinutes: number;
    /** Where two or more appointments overlap. */
    overbooked: Overbooked[];
    overbookedMinutes: number;
    status: "off" | "light" | "balanced" | "full" | "over";
    offReason: string | null;
    /** How each figure was worked out, in plain words. */
    explanation: string[];
}

// --- Timeline ------------------------------------------------------------------------------------

export type TimelineKind = "event" | "break" | "leave" | "free";

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
    /** From a subscribed or imported calendar, or someone else's: never changed from Today. */
    readOnly: boolean;
    /** Takes time from availability (busy, and its calendar counts). */
    busy: boolean;
    /** In a calendar shared with the household. */
    shared: boolean;
    /** Overlaps another busy appointment. */
    conflict: boolean;
    detail: string | null;
    url: string | null;
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
    kind: "event" | "leave" | "conflict";
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
    conflicts: BriefingRef[];
    capacity: { availableMinutes: number; committedMinutes: number; freeMinutes: number; status: TodayCapacity["status"] };
    family: BriefingRef[];
    nextActions: NextAction[];
    /** What wasn't read, so nothing implies it was. */
    notChecked: string[];
}

// --- Notifications -------------------------------------------------------------------------------

export interface TodayNotification {
    id: string;
    source: "calendar" | "intelligence-centre";
    title: string;
    detail: string | null;
    url: string | null;
    at: string;
    /** Calendar notifications can be dismissed from Today. */
    dismissable: boolean;
    kind: CalendarNotification["kind"] | "centre_alert";
}

// --- The dashboard -------------------------------------------------------------------------------

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
    capacity: TodayCapacity;
    timeline: DayTimeline;
    commitments: { personal: CommitmentItem[]; shared: CommitmentItem[] };
    notifications: TodayNotification[];
    briefing: TodayBriefing;
    /** Calendars the person can see (Customise Today's availability choices, and Quick capture's appointment). */
    calendars: { id: string; name: string; kind: "personal" | "shared" | "subscription"; canWrite: boolean; isDefault: boolean }[];
    /** Intelligence is open to this person (the briefing's explanation). */
    canUseIntelligence: boolean;
}

export interface TodayRoute {
    route: "today";
    dashboard: TodayDashboard;
    /** Planning hours and buffers (planner_preferences), edited from Today's settings. */
    planningHours: { preferences: PlanningHours; version: number };
    /** The day's events and overlays, for the timeline's time grid (the Calendar's own). */
    occurrences: EventOccurrence[];
    overlays: Overlays;
    /** The person's Calendar settings (the grid starts at their working hours). */
    workingHoursStart: string;
    /** The Intelligence Centre's short section: only what meets the person's own relevance rules. Null when off or unavailable. */
    centre?: TodayCentre | null;
    /** Home & Assets' section: what's due, from the person's own settings there. Null when off or unavailable. */
    assets?: TodayAssets | null;
}
