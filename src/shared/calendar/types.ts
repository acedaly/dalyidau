// Data shapes for Daly Calendar and the Leave Planner, shared by the Worker and the browser.
import { z } from "zod";
import type { DayPlan, FeedTimeBlocks, PlannerData, PlannerPreferences, PlannerTaskLists } from "../planner/types";
import type { LeaveAccrual, LeaveSettings, WorkPattern } from "./leave";
import type { HolidayKind, SchoolDivision } from "./nsw";
import type { RepeatRule } from "./recurrence";
import { DEFAULT_TIME_ZONE, isTimeZone } from "./time";

/** The event colours of Untitled UI's calendar (calendar-month-view-event). */
export const CALENDAR_COLORS = ["brand", "blue", "indigo", "purple", "pink", "orange", "yellow", "green", "gray"] as const;
export type CalendarColor = (typeof CALENDAR_COLORS)[number];

export const CALENDAR_ROLES = ["owner", "editor", "viewer", "freebusy"] as const;
export type CalendarRole = (typeof CALENDAR_ROLES)[number];
const RANK: Record<CalendarRole, number> = { freebusy: 0, viewer: 1, editor: 2, owner: 3 };
export const roleAtLeast = (role: CalendarRole, minimum: CalendarRole) => RANK[role] >= RANK[minimum];

export const CALENDAR_ROLE_LABELS: Record<CalendarRole, { label: string; description: string }> = {
    owner: { label: "Owner", description: "Everything, including sharing and deleting the calendar." },
    editor: { label: "Editor", description: "Add, change and remove events." },
    viewer: { label: "Viewer", description: "See events and their details." },
    freebusy: { label: "Free/busy", description: "See only when time is busy. No titles, places or details." },
};

export const CALENDAR_PURPOSES = ["general", "family", "work", "school", "care", "birthdays", "travel", "subscription"] as const;
export type CalendarPurpose = (typeof CALENDAR_PURPOSES)[number];

export const EVENT_CATEGORIES = [
    "general",
    "appointment",
    "family",
    "birthday",
    "anniversary",
    "school",
    "travel",
    "commitment",
    "care",
    "pickup",
    "dropoff",
    "work",
    "other",
] as const;
export type EventCategory = (typeof EVENT_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<EventCategory, string> = {
    general: "Event",
    appointment: "Appointment",
    family: "Family",
    birthday: "Birthday",
    anniversary: "Anniversary",
    school: "School",
    travel: "Travel and holidays",
    commitment: "Commitment",
    care: "Care arrangement",
    pickup: "Pickup",
    dropoff: "Drop-off",
    work: "Work",
    other: "Other",
};

export const VISIBILITIES = ["default", "private", "sensitive"] as const;
export type EventVisibility = (typeof VISIBILITIES)[number];
export const VISIBILITY_LABELS: Record<EventVisibility, { label: string; description: string }> = {
    default: { label: "Calendar's members", description: "Everyone who can see this calendar sees the details." },
    private: { label: "Private", description: "Only you see the details. Others see that the time is busy." },
    sensitive: {
        label: "Sensitive",
        description: "Private, and never shown with details in subscribed feeds, emails, briefings or AI tools. For children, care and health.",
    },
};

export const CALENDAR_VIEWS = ["day", "week", "month", "agenda", "year"] as const;
export type CalendarView = (typeof CALENDAR_VIEWS)[number];

export const LIMITS = {
    title: 300,
    description: 8000,
    location: 500,
    calendarName: 100,
    calendarsPerPerson: 50,
    subscriptionsPerPerson: 30,
    feedsPerPerson: 10,
    remindersPerEvent: 5,
    occurrencesPerWindow: 2000,
    /** The longest window one request may expand. */
    windowDays: 400,
    linksPerEvent: 20,
    people: 10,
} as const;

// --- Preferences ---------------------------------------------------------------------------------

export const calendarPreferences = z
    .object({
        timeZone: z.string().max(64).refine(isTimeZone, "Choose a valid time zone").default(DEFAULT_TIME_ZONE),
        weekStart: z.union([z.literal(0), z.literal(1)]).default(1),
        defaultView: z.enum(CALENDAR_VIEWS).default("week"),
        schoolDivision: z.enum(["eastern", "western", "none"]).default("eastern"),
        /** Shown in the day and week views; times outside it scroll into view. */
        workingHours: z
            .object({ start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/) })
            .default({ start: "08:00", end: "18:00" }),
        overlays: z
            .object({
                holidays: z.boolean().default(true),
                school: z.boolean().default(true),
                tasks: z.boolean().default(true),
                leave: z.boolean().default(true),
                sharedLeave: z.boolean().default(true),
                /** Home & Assets dates (registration, renewals, servicing, warranties) as reminders. */
                assets: z.boolean().default(true),
            })
            .default({ holidays: true, school: true, tasks: true, leave: true, sharedLeave: true, assets: true }),
        /** Added to new events you create (minutes before); null for none. */
        defaultReminderMinutes: z.number().int().min(0).max(40320).nullable().default(null),
        /** Email reminders as well as in-app ones (also needs the portal's "Calendar reminder emails" switch). */
        reminderEmail: z.boolean().default(false),
        /** Include the event's title in reminder emails. Private and sensitive events never are. */
        emailDetails: z.boolean().default(false),
        notify: z
            .object({ leave: z.boolean().default(true), school: z.boolean().default(true), subscriptions: z.boolean().default(true) })
            .default({ leave: true, school: true, subscriptions: true }),
    })
    .strict();

export type CalendarPreferences = z.output<typeof calendarPreferences>;
export const DEFAULT_PREFERENCES: CalendarPreferences = calendarPreferences.parse({});

// --- Calendars -----------------------------------------------------------------------------------

export interface CalendarInfo {
    id: string;
    name: string;
    description: string | null;
    /** The person's own colour for it, or the calendar's. */
    color: CalendarColor;
    kind: "personal" | "shared";
    purpose: CalendarPurpose;
    source: "local" | "subscription";
    timeZone: string;
    isDefault: boolean;
    /** The caller's role. */
    role: CalendarRole;
    /** Hidden by the caller (still listed, not drawn). */
    hidden: boolean;
    ownerEmail: string;
    memberCount: number;
    subscriptionId: string | null;
    version: number;
}

export interface CalendarMember {
    email: string;
    name: string | null;
    role: CalendarRole;
}

/** People who can open Calendar, for sharing pickers. */
export interface CalendarPerson {
    email: string;
    name: string | null;
}

// --- Events --------------------------------------------------------------------------------------

export interface EventPeople {
    /** Who it's about: names only, e.g. a child's first name for a pickup. */
    who: string[];
    /** The member responsible (pickups, drop-offs, care handovers). */
    responsible: string | null;
}

/** One occurrence as drawn in a view, in the viewer's time zone. */
export interface EventOccurrence {
    /** `${eventId}:${key}` */
    id: string;
    eventId: string;
    calendarId: string;
    /** The occurrence's original start in the event's zone (see occurrenceKey). */
    key: string;
    title: string;
    allDay: boolean;
    /** Instants. For all-day events, the start of the first day and of the day after the last, in the viewer's zone. */
    start: string;
    end: string;
    /** Local dates in the viewer's zone; endDate inclusive. */
    startDate: string;
    endDate: string;
    /** Local times in the viewer's zone (timed events only). */
    startTime: string | null;
    endTime: string | null;
    /** The event's own zone, when it differs from the viewer's. */
    eventTimeZone: string | null;
    location: string | null;
    category: EventCategory;
    color: CalendarColor;
    visibility: EventVisibility;
    showAs: "busy" | "free";
    status: "confirmed" | "tentative" | "cancelled";
    recurring: boolean;
    /** This occurrence was changed on its own. */
    overridden: boolean;
    /** Subscribed, or the caller is only a viewer. */
    readOnly: boolean;
    /** Details withheld: a private event of someone else's, or a free/busy calendar. Title is "Busy". */
    busyOnly: boolean;
    source: "local" | "subscription" | "import";
    people: EventPeople | null;
}

export interface EventReminderInfo {
    id: string;
    minutesBefore: number;
}

export type EventLink =
    | { id: string; kind: "task"; available: true; targetId: string; title: string; status: string; dueDate: string | null }
    | { id: string; kind: "project"; available: true; targetId: string; title: string }
    | { id: string; kind: "knowledge"; available: true; targetId: string; title: string; spaceName: string }
    | { id: string; kind: "task" | "project" | "knowledge"; available: false };

/** Everything the event panel needs to show and edit one event. */
export interface EventDetail {
    id: string;
    calendarId: string;
    uid: string;
    title: string;
    description: string | null;
    location: string | null;
    url: string | null;
    allDay: boolean;
    startDate: string;
    startTime: string | null;
    endDate: string;
    endTime: string | null;
    timeZone: string;
    rrule: string | null;
    /** The editor's form of the rule, or null for a custom rule from a feed. */
    repeat: RepeatRule | null;
    repeatLabel: string | null;
    exdates: string[];
    category: EventCategory;
    color: CalendarColor | null;
    visibility: EventVisibility;
    showAs: "busy" | "free";
    status: "confirmed" | "tentative" | "cancelled";
    people: EventPeople | null;
    source: "local" | "subscription" | "import";
    canEdit: boolean;
    reminders: EventReminderInfo[];
    links: EventLink[];
    overrides: { key: string; cancelled: boolean }[];
    createdBy: string;
    updatedAt: string;
    version: number;
}

// --- Overlays ------------------------------------------------------------------------------------

export interface HolidayOverlay {
    date: string;
    name: string;
    kind: HolidayKind | "regional";
    provisional: boolean;
}

export interface SchoolOverlay {
    id: string;
    name: string;
    kind: "term" | "holidays" | "development_day" | "school_event";
    start: string;
    end: string;
    custom: boolean;
    provisional: boolean;
    school: string | null;
}

export interface TaskOverlay {
    id: string;
    title: string;
    date: string;
    time: string | null;
    kind: "due" | "deadline" | "milestone";
    projectName: string;
    priority: number;
}

export interface LeaveOverlay {
    id: string;
    start: string;
    end: string;
    status: LeaveStatus;
    typeName: string;
    color: CalendarColor;
    /** Someone else's leave they share with you. */
    owner: CalendarPerson | null;
}

export interface CustomDateOverlay {
    id: string;
    kind: CustomDateKind;
    name: string;
    start: string;
    end: string;
}

/** A Home & Assets date shown as a reminder (never an event): registration, a renewal, servicing, a warranty ending. */
export interface AssetDateOverlay {
    id: string;
    date: string;
    title: string;
    kind: string;
    url: string;
}

export interface Overlays {
    holidays: HolidayOverlay[];
    school: SchoolOverlay[];
    tasks: TaskOverlay[];
    leave: LeaveOverlay[];
    nonWorking: CustomDateOverlay[];
    /** Home & Assets reminders, for people who can open it and kept them on. */
    assets?: AssetDateOverlay[];
}

// --- Subscriptions and feeds ---------------------------------------------------------------------

export interface SubscriptionInfo {
    id: string;
    calendarId: string;
    name: string;
    color: CalendarColor;
    kind: "personal" | "shared";
    /** Host and a masked path. The address itself is never sent back. */
    urlDisplay: string;
    provider: "google" | "apple" | "outlook" | "other";
    enabled: boolean;
    hidden: boolean;
    refreshMinutes: number;
    lastAttemptAt: string | null;
    lastSuccessAt: string | null;
    lastStatus: "ok" | "not_modified" | "error" | null;
    lastErrorCode: string | null;
    lastError: string | null;
    consecutiveFailures: number;
    nextRefreshAt: string;
    eventCount: number;
    /** Only the owner manages a subscription; members of a shared one can view it. */
    canManage: boolean;
    version: number;
}

export const feedScope = z
    .object({
        calendarIds: z.array(z.string().regex(/^cal_[a-z0-9]{14}$/)).max(50),
        leave: z.boolean(),
        tasks: z.enum(["none", "deadlines", "dated"]),
        /** busy: every event is published as "Busy" with no details. */
        detail: z.enum(["full", "busy"]),
    })
    .strict();
export type FeedScope = z.output<typeof feedScope>;

export interface CalendarFeedInfo {
    id: string;
    name: string;
    scope: FeedScope;
    /** The owner's time blocks: never, as "Busy" or as "Focus time" (never a task's title). */
    timeBlocks: FeedTimeBlocks;
    tokenHint: string;
    createdAt: string;
    rotatedAt: string | null;
    revokedAt: string | null;
    lastAccessedAt: string | null;
}

// --- Custom dates --------------------------------------------------------------------------------

export const CUSTOM_DATE_KINDS = ["school_holiday", "development_day", "school_event", "regional_holiday", "non_working"] as const;
export type CustomDateKind = (typeof CUSTOM_DATE_KINDS)[number];
export const CUSTOM_DATE_LABELS: Record<CustomDateKind, string> = {
    school_holiday: "School holiday (your school)",
    development_day: "School development day",
    school_event: "School event",
    regional_holiday: "Regional public holiday",
    non_working: "Non-working day",
};

export interface CustomDate {
    id: string;
    kind: CustomDateKind;
    name: string;
    start: string;
    end: string;
    region: string | null;
    school: string | null;
    scope: "personal" | "household";
    mine: boolean;
}

// --- Notifications -------------------------------------------------------------------------------

export interface CalendarNotification {
    id: string;
    kind: "event" | "leave" | "school" | "subscription";
    title: string;
    detail: string | null;
    url: string | null;
    fireAt: string;
}

// --- Leave ---------------------------------------------------------------------------------------

export const LEAVE_STATUSES = ["draft", "proposed", "requested", "approved", "taken", "cancelled"] as const;
export type LeaveStatus = (typeof LEAVE_STATUSES)[number];
export const LEAVE_STATUS_LABELS: Record<LeaveStatus, { label: string; description: string }> = {
    draft: { label: "Draft", description: "An idea. Not counted in any balance unless a scenario includes it." },
    proposed: { label: "Proposed", description: "Planned at home, not yet asked for at work." },
    requested: { label: "Requested", description: "Asked for at work, waiting for approval." },
    approved: { label: "Approved", description: "Your employer approved it. Only you mark leave approved." },
    taken: { label: "Taken", description: "Already taken." },
    cancelled: { label: "Cancelled", description: "Not happening. Never counted." },
};

export const LEAVE_KINDS = ["annual", "long_service", "personal", "toil", "flex", "unpaid", "other"] as const;
export type LeaveKind = (typeof LEAVE_KINDS)[number];

export interface LeaveTypeInfo {
    id: string;
    kind: LeaveKind;
    name: string;
    color: CalendarColor;
    paid: boolean;
    tracksBalance: boolean;
    balanceHours: number;
    balanceDate: string;
    accrual: LeaveAccrual;
    deductsPublicHolidays: boolean;
    archived: boolean;
    version: number;
}

export interface LeaveBookingInfo {
    id: string;
    leaveTypeId: string;
    scenarioId: string | null;
    startDate: string;
    endDate: string;
    part: "full" | "am" | "pm" | "hours";
    hours: number | null;
    dayHours: Record<string, number> | null;
    status: LeaveStatus;
    title: string | null;
    note: string | null;
    version: number;
    updatedAt: string;
}

export interface LeaveAdjustmentInfo {
    id: string;
    leaveTypeId: string;
    date: string;
    hours: number;
    reason: string | null;
}

export interface LeaveScenarioInfo {
    id: string;
    name: string;
    note: string | null;
}

export interface LeaveProfileInfo {
    pattern: WorkPattern;
    settings: LeaveSettings;
    version: number;
    configured: boolean;
}

/** Someone's shared leave dates: when they're away and whether it's confirmed. Never their balances. */
export interface SharedLeave {
    owner: CalendarPerson;
    pattern: WorkPattern | null;
    bookings: { id: string; startDate: string; endDate: string; status: LeaveStatus; part: LeaveBookingInfo["part"] }[];
}

export interface LeaveData {
    profile: LeaveProfileInfo;
    types: LeaveTypeInfo[];
    bookings: LeaveBookingInfo[];
    adjustments: LeaveAdjustmentInfo[];
    scenarios: LeaveScenarioInfo[];
    customDates: CustomDate[];
    sharedWith: CalendarPerson[];
    sharedWithMe: SharedLeave[];
}

// --- Pages ---------------------------------------------------------------------------------------

export interface CalendarShell {
    today: string;
    preferences: CalendarPreferences;
    calendars: CalendarInfo[];
    notifications: CalendarNotification[];
    canUseTasks: boolean;
    canUseKnowledge: boolean;
    /** Portal switches the pages need to explain themselves. */
    switches: { feeds: boolean; reminderEmails: boolean };
    /** Subscriptions currently failing, for the warning on every Calendar page. */
    failingSubscriptions: number;
}

export interface FamilyOverview {
    calendars: CalendarInfo[];
    upcoming: EventOccurrence[];
    importantDates: EventOccurrence[];
    care: EventOccurrence[];
    school: SchoolOverlay[];
    leave: LeaveOverlay[];
    from: string;
    to: string;
}

export type CalendarRoute =
    | (CalendarShell & {
          route: "calendar-view";
          view: Exclude<CalendarView, "year">;
          anchor: string;
          from: string;
          to: string;
          occurrences: EventOccurrence[];
          overlays: Overlays;
          openEvent: string | null;
          truncated: boolean;
          /** The Tasks panel and time blocks (day and week views, for people who can open Tasks). */
          planner: PlannerData | null;
      })
    | (CalendarShell & {
          route: "calendar-planner";
          date: string;
          occurrences: EventOccurrence[];
          overlays: Overlays;
          plan: DayPlan & { lists: PlannerTaskLists };
          plannerPreferences: { preferences: PlannerPreferences; version: number };
          openBlock: string | null;
      })
    | (CalendarShell & { route: "calendar-year"; year: number; overlays: Overlays; busy: Record<string, number> })
    | (CalendarShell & {
          route: "calendar-calendars";
          members: Record<string, CalendarMember[]>;
          people: CalendarPerson[];
          feeds: CalendarFeedInfo[];
      })
    | (CalendarShell & { route: "calendar-subscriptions"; subscriptions: SubscriptionInfo[] })
    | (CalendarShell & { route: "calendar-family"; family: FamilyOverview })
    | (CalendarShell & { route: "calendar-leave"; leave: LeaveData; tab: "overview" | "bookings" | "forecast" | "scenarios" })
    | (CalendarShell & { route: "calendar-leave-planner"; leave: LeaveData })
    | (CalendarShell & { route: "calendar-leave-settings"; leave: LeaveData; people: CalendarPerson[] })
    | (CalendarShell & { route: "calendar-holidays"; year: number; division: SchoolDivision; customDates: CustomDate[] })
    | (CalendarShell & { route: "calendar-settings" });
