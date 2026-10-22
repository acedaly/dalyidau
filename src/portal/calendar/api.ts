// Calls to /api/portal/calendar. Every response is the server's view after the change, so pages can
// replace what they show with it rather than guessing.
import { api } from "@/portal/lib/api";
import type { BalanceBreakdown, ForecastPoint, LeaveAccrual, LeaveSettings, WorkPattern } from "@/shared/calendar/leave";
import type { RepeatInput } from "@/shared/calendar/recurrence";
import type {
    CalendarColor,
    CalendarFeedInfo,
    CalendarInfo,
    CalendarMember,
    CalendarNotification,
    CalendarPreferences,
    CalendarShell,
    CustomDate,
    EventCategory,
    EventDetail,
    EventOccurrence,
    EventPeople,
    EventVisibility,
    FeedScope,
    LeaveBookingInfo,
    LeaveData,
    LeaveKind,
    LeaveStatus,
    LeaveTypeInfo,
    Overlays,
    SubscriptionInfo,
} from "@/shared/calendar/types";

const C = "/api/portal/calendar";

export interface EventFields {
    calendarId?: string;
    title?: string;
    description?: string | null;
    location?: string | null;
    url?: string | null;
    allDay?: boolean;
    startDate?: string;
    startTime?: string | null;
    endDate?: string;
    endTime?: string | null;
    timeZone?: string;
    repeat?: RepeatInput | null;
    category?: EventCategory;
    color?: CalendarColor | null;
    visibility?: EventVisibility;
    showAs?: "busy" | "free";
    status?: "confirmed" | "tentative";
    people?: EventPeople | null;
}

export type EditScope = "series" | "occurrence" | "following";

export interface BookingFields {
    leaveTypeId?: string;
    scenarioId?: string | null;
    startDate?: string;
    endDate?: string;
    part?: LeaveBookingInfo["part"];
    hours?: number | null;
    status?: LeaveStatus;
    title?: string | null;
    note?: string | null;
}

export interface TypeSummary {
    type: LeaveTypeInfo;
    today: { confirmed: number; planned: number };
    asOf: BalanceBreakdown;
}

export const calendarApi = {
    shell: () => api<CalendarShell>("GET", `${C}/shell`),
    window: (from: string, to: string) =>
        api<{ occurrences: EventOccurrence[]; truncated: boolean; overlays: Overlays }>("GET", `${C}/events?from=${from}&to=${to}`),
    search: (q: string) => api<{ occurrences: EventOccurrence[] }>("GET", `${C}/events/search?q=${encodeURIComponent(q)}`),
    event: (id: string) => api<{ event: EventDetail }>("GET", `${C}/events/${id}`),
    createEvent: (body: EventFields & { title: string; allDay: boolean; startDate: string; endDate: string; reminders?: number[]; clientId?: string }) =>
        api<{ event: EventDetail; replayed: boolean }>("POST", `${C}/events`, body),
    updateEvent: (id: string, body: EventFields & { version: number; scope?: EditScope; occurrenceKey?: string }) =>
        api<{ event: EventDetail }>("PATCH", `${C}/events/${id}`, body),
    deleteEvent: (id: string, scope: EditScope = "series", key?: string) =>
        api<{ deleted: EditScope }>("DELETE", `${C}/events/${id}?scope=${scope}${key ? `&key=${encodeURIComponent(key)}` : ""}`),
    restoreOccurrence: (id: string, key: string) => api<{ event: EventDetail }>("POST", `${C}/events/${id}/restore`, { key }),
    reminders: (id: string, minutes: number[]) => api<{ event: EventDetail }>("PUT", `${C}/events/${id}/reminders`, { minutes }),

    calendars: () => api<{ calendars: CalendarInfo[] }>("GET", `${C}/calendars`),
    createCalendar: (body: {
        name: string;
        description?: string | null;
        color?: CalendarColor;
        kind?: "personal" | "shared";
        purpose?: CalendarInfo["purpose"];
        timeZone?: string;
    }) => api<{ calendar: CalendarInfo }>("POST", `${C}/calendars`, body),
    updateCalendar: (
        id: string,
        body: {
            version: number;
            name?: string;
            description?: string | null;
            color?: CalendarColor;
            kind?: "personal" | "shared";
            purpose?: CalendarInfo["purpose"];
        },
    ) => api<{ calendar: CalendarInfo }>("PATCH", `${C}/calendars/${id}`, body),
    personal: (id: string, body: { hidden?: boolean; color?: CalendarColor | null }) =>
        api<{ calendar: CalendarInfo }>("PATCH", `${C}/calendars/${id}/me`, body),
    deleteCalendar: (id: string) => api<{ calendars: CalendarInfo[] }>("DELETE", `${C}/calendars/${id}`),
    addMember: (id: string, email: string, role: CalendarMember["role"]) =>
        api<{ members: CalendarMember[] }>("POST", `${C}/calendars/${id}/members`, { email, role }),
    removeMember: (id: string, email: string) => api<{ members: CalendarMember[] }>("DELETE", `${C}/calendars/${id}/members/${encodeURIComponent(email)}`),
    importIcs: (id: string, ics: string, dryRun: boolean) =>
        api<{ result: { added: number; alreadyThere: number; skipped: Record<string, number>; dryRun: boolean } }>("POST", `${C}/calendars/${id}/import`, {
            ics,
            dryRun,
        }),

    subscriptions: () => api<{ subscriptions: SubscriptionInfo[] }>("GET", `${C}/subscriptions`),
    subscribe: (body: { url: string; name?: string; color?: CalendarColor; kind?: "personal" | "shared"; refreshMinutes?: number; clientId?: string }) =>
        api<{ subscription: SubscriptionInfo }>("POST", `${C}/subscriptions`, body),
    updateSubscription: (
        id: string,
        body: { version: number; name?: string; color?: CalendarColor; kind?: "personal" | "shared"; enabled?: boolean; refreshMinutes?: number },
    ) => api<{ subscription: SubscriptionInfo }>("PATCH", `${C}/subscriptions/${id}`, body),
    refreshSubscription: (id: string) => api<{ subscription: SubscriptionInfo }>("POST", `${C}/subscriptions/${id}/refresh`, {}),
    unsubscribe: (id: string) => api<{ subscriptions: SubscriptionInfo[] }>("DELETE", `${C}/subscriptions/${id}`),

    feeds: () => api<{ feeds: CalendarFeedInfo[] }>("GET", `${C}/feeds`),
    createFeed: (name: string, scope: FeedScope) => api<{ feed: CalendarFeedInfo; address: string }>("POST", `${C}/feeds`, { name, scope }),
    updateFeed: (id: string, body: { name?: string; scope?: FeedScope }) => api<{ feed: CalendarFeedInfo }>("PATCH", `${C}/feeds/${id}`, body),
    rotateFeed: (id: string) => api<{ feed: CalendarFeedInfo; address: string }>("POST", `${C}/feeds/${id}/rotate`, {}),
    revokeFeed: (id: string) => api<{ feeds: CalendarFeedInfo[] }>("DELETE", `${C}/feeds/${id}`),

    preferences: (preferences: CalendarPreferences) => api<{ preferences: CalendarPreferences }>("PUT", `${C}/preferences`, { preferences }),
    dismiss: (id: string | "all") => api<{ notifications: CalendarNotification[] }>("POST", `${C}/notifications/${id}/dismiss`, {}),

    addCustomDate: (body: Omit<CustomDate, "id" | "mine">) => api<{ customDates: CustomDate[] }>("POST", `${C}/custom-dates`, body),
    deleteCustomDate: (id: string) => api<{ customDates: CustomDate[] }>("DELETE", `${C}/custom-dates/${id}`),

    leave: () => api<{ leave: LeaveData }>("GET", `${C}/leave`),
    saveProfile: (body: { version: number; pattern: WorkPattern; settings: LeaveSettings }) => api<{ leave: LeaveData }>("PUT", `${C}/leave/profile`, body),
    setup: (body: { pattern: WorkPattern; settings?: LeaveSettings; balanceDate: string; annualHours: number; personalHours: number | null }) =>
        api<{ leave: LeaveData }>("POST", `${C}/leave/setup`, body),
    createType: (body: {
        kind: LeaveKind;
        name?: string;
        color?: CalendarColor;
        balanceHours: number;
        balanceDate: string;
        accrual?: LeaveAccrual;
        deductsPublicHolidays?: boolean;
        paid?: boolean;
        tracksBalance?: boolean;
    }) => api<{ leave: LeaveData }>("POST", `${C}/leave/types`, body),
    updateType: (id: string, body: Partial<Omit<LeaveTypeInfo, "id" | "kind" | "version" | "archived">> & { version: number; archived?: boolean }) =>
        api<{ leave: LeaveData }>("PATCH", `${C}/leave/types/${id}`, body),
    deleteType: (id: string) => api<{ leave: LeaveData }>("DELETE", `${C}/leave/types/${id}`),
    createBooking: (body: BookingFields & { leaveTypeId: string; startDate: string; endDate: string; clientId?: string }) =>
        api<{ booking: LeaveBookingInfo; leave: LeaveData }>("POST", `${C}/leave/bookings`, body),
    updateBooking: (id: string, body: BookingFields & { version: number }) =>
        api<{ booking: LeaveBookingInfo; leave: LeaveData }>("PATCH", `${C}/leave/bookings/${id}`, body),
    deleteBooking: (id: string) => api<{ leave: LeaveData }>("DELETE", `${C}/leave/bookings/${id}`),
    addAdjustment: (body: { leaveTypeId: string; date: string; hours: number; reason?: string | null }) =>
        api<{ leave: LeaveData }>("POST", `${C}/leave/adjustments`, body),
    deleteAdjustment: (id: string) => api<{ leave: LeaveData }>("DELETE", `${C}/leave/adjustments/${id}`),
    createScenario: (name: string, note?: string) => api<{ id: string; leave: LeaveData }>("POST", `${C}/leave/scenarios`, { name, note }),
    deleteScenario: (id: string) => api<{ leave: LeaveData }>("DELETE", `${C}/leave/scenarios/${id}`),
    adoptScenario: (id: string) => api<{ leave: LeaveData }>("POST", `${C}/leave/scenarios/${id}/adopt`, {}),
    share: (email: string) => api<{ leave: LeaveData }>("POST", `${C}/leave/shares`, { email }),
    unshare: (email: string) => api<{ leave: LeaveData }>("DELETE", `${C}/leave/shares/${encodeURIComponent(email)}`),
    forecast: (date: string, mode: "confirmed" | "planned" | "all", scenario?: string | null) =>
        api<{ today: string; date: string; balances: TypeSummary[]; series: { leaveTypeId: string; points: ForecastPoint[] }[] }>(
            "GET",
            `${C}/leave/forecast?date=${date}&mode=${mode}${scenario ? `&scenario=${scenario}` : ""}`,
        ),
    plan: <T = Record<string, unknown>>(question: Record<string, unknown>) => api<{ answer: T }>("POST", `${C}/leave/plan`, question),

    restore: (backup: unknown, dryRun: boolean) =>
        api<{ result: { calendars: number; events: number; leaveTypes: number; bookings: number; dryRun: boolean } }>("POST", `${C}/restore`, {
            backup,
            dryRun,
        }),
};

/** A random id for one intended create, so a retry (or a double click) returns the first result. */
export const clientId = () => crypto.randomUUID().replace(/-/g, "");
