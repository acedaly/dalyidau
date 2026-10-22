// A window of one person's days for Today: their planning hours (planner_preferences, migration 0023),
// events (their own, shared and subscribed, through Calendar's own window, so private events of
// others are "Busy" and calendars they can't see aren't there at all), leave, public holidays and
// breaks. Nothing here writes except the planning hours, which only their owner changes.
import type { D1Database } from "@cloudflare/workers-types";
import { z } from "zod";
import { leaveContext } from "../../src/shared/calendar/holidays";
import { daysBetween, eachDate, isCalendarDate } from "../../src/shared/calendar/time";
import type { CalendarInfo, EventOccurrence, LeaveData } from "../../src/shared/calendar/types";
import type { PortalUser } from "../../src/shared/portal/types";
import {
    type Availability,
    type Commitment,
    DEFAULT_PLANNING_HOURS,
    type LeaveDay,
    type PlanningHours,
    availability,
    planningHours,
} from "../../src/shared/today/availability";
import type { TodayPreferences } from "../../src/shared/today/types";
import { activity, preferences as calendarPreferences, todayFor } from "../calendar/access";
import { listCalendars } from "../calendar/calendars";
import { occurrencesInWindow } from "../calendar/events";
import { loadLeave } from "../calendar/leave";
import { nowIso, parseJson } from "../portal/db";
import { HttpError } from "../portal/http";
import { loadTodayPrefs } from "./prefs";

/** Days one window may cover. */
const WINDOW_DAYS = 62;

/** Today is Calendar's: it reads events, leave and holidays, and nothing else. */
export function requireToday(user: PortalUser) {
    if (!user.permissions.includes("calendar.use")) throw new HttpError(403, "forbidden", "Today needs access to Calendar");
}

// --- Planning hours ------------------------------------------------------------------------------

export async function loadPlanningHours(db: D1Database, email: string): Promise<{ preferences: PlanningHours; version: number }> {
    const row = await db.prepare("SELECT value, version FROM planner_preferences WHERE email = ?").bind(email).first<{ value: string; version: number }>();
    if (!row) return { preferences: DEFAULT_PLANNING_HOURS, version: 0 };
    // An older or damaged document falls back to the defaults rather than breaking Today.
    const parsed = planningHours.safeParse({ ...DEFAULT_PLANNING_HOURS, ...parseJson<Record<string, unknown>>(row.value, {}) });
    return { preferences: parsed.success ? parsed.data : DEFAULT_PLANNING_HOURS, version: row.version };
}

const saveHoursInput = z.object({ preferences: planningHours, version: z.number().int().min(0) }).strict();

export async function savePlanningHours(db: D1Database, user: PortalUser, input: unknown) {
    const body = saveHoursInput.parse(input);
    const now = nowIso();
    const value = JSON.stringify(body.preferences);
    const write =
        body.version === 0
            ? db
                  .prepare("INSERT INTO planner_preferences (email, value, version, updated_at) VALUES (?, ?, 1, ?) ON CONFLICT DO NOTHING")
                  .bind(user.email, value, now)
            : db
                  .prepare("UPDATE planner_preferences SET value = ?, version = version + 1, updated_at = ? WHERE email = ? AND version = ?")
                  .bind(value, now, user.email, body.version);
    const result = await write.run();
    if (!result.meta.changes) throw new HttpError(409, "conflict", "Your planning hours changed in another window. Reload to see them.");
    await activity(db, { actor: user.email, action: "planner.preferences", entityType: "planner_preferences" }).run();
    return loadPlanningHours(db, user.email);
}

// --- A window of commitments ---------------------------------------------------------------------

export interface PlanningWindow {
    from: string;
    to: string;
    today: string;
    timeZone: string;
    hours: PlanningHours;
    occurrences: EventOccurrence[];
    commitments: Commitment[];
    days: Availability[];
    leave: LeaveData;
    calendars: CalendarInfo[];
    /** Today's preferences: breaks and calendars that don't count towards availability. */
    todayPrefs: TodayPreferences;
}

export const eventTitle = (o: EventOccurrence) => (o.busyOnly ? "Busy" : o.visibility === "sensitive" ? "Private event" : o.title);

/** Events (yours, shared and subscribed), leave and availability between two local dates. */
export async function planningWindow(db: D1Database, user: PortalUser, from: string, to: string): Promise<PlanningWindow> {
    if (!isCalendarDate(from) || !isCalendarDate(to) || to < from) throw new HttpError(400, "bad_window", "Give from and to dates, from first");
    if (daysBetween(from, to) > WINDOW_DAYS) throw new HttpError(400, "bad_window", `Ask for at most ${WINDOW_DAYS} days at a time`);
    const [{ timeZone }, { preferences: hours }, today, calendars, leave, { preferences: todayPrefs }] = await Promise.all([
        calendarPreferences(db, user.email),
        loadPlanningHours(db, user.email),
        todayFor(db, user.email),
        listCalendars(db, user),
        loadLeave(db, user),
        loadTodayPrefs(db, user.email),
    ]);
    const excluded = new Set(todayPrefs.excludedCalendarIds);
    // Hidden calendars stay out, as they stay out of view.
    const { occurrences } = await occurrencesInWindow(db, user, { from, to, timeZone });
    const shared = new Map(calendars.map((c: CalendarInfo) => [c.id, c.kind === "shared"]));
    const commitments: Commitment[] = occurrences
        .filter((o) => !o.allDay && o.status !== "cancelled")
        .map((o) => ({
            id: o.id,
            title: eventTitle(o),
            start: o.start,
            end: o.end,
            source: o.source,
            shared: shared.get(o.calendarId) ?? false,
            // A calendar the person chose not to count towards availability (Today's settings) still shows, as free.
            busy: o.showAs === "busy" && !excluded.has(o.calendarId),
        }));
    const ctx = leaveContext(leave.profile.pattern, leave.profile.settings, leave.customDates);
    const types = new Map(leave.types.map((t) => [t.id, t.name]));
    const leaveDays: LeaveDay[] = leave.bookings
        .filter((b) => !b.scenarioId && (b.status === "requested" || b.status === "approved" || b.status === "taken") && b.endDate >= from && b.startDate <= to)
        .map((b) => ({ start: b.startDate, end: b.endDate, part: b.part, hours: b.hours, label: b.title || types.get(b.leaveTypeId) || "Leave" }));
    const days = eachDate(from, to, WINDOW_DAYS + 1).map((d) =>
        availability(d, { hours, timeZone, leaveContext: ctx, leave: leaveDays, breaks: todayPrefs.breaks }),
    );
    return { from, to, today, timeZone, hours, occurrences, commitments, days, leave, calendars, todayPrefs };
}
