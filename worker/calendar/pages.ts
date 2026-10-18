// First-render data for the Calendar pages (/portal/calendar/*). The portal page router has already
// checked "calendar.use"; these check calendar membership. Anything the caller can't see returns
// null, which the router turns into the ordinary 404 page.
import { schoolOverlays } from "../../src/shared/calendar/holidays";
import { addDays, isCalendarDate } from "../../src/shared/calendar/time";
import type { CalendarRoute, CalendarShell, FamilyOverview } from "../../src/shared/calendar/types";
import { isCalendarView, viewWindow } from "../../src/shared/calendar/views";
import type { Flags } from "../../src/shared/portal/flags";
import type { PortalUser } from "../../src/shared/portal/types";
import type { Env } from "../env";
import { plannerPrefs } from "../planner/blocks";
import { dayPlan, viewPlanner } from "../planner/planning";
import { can } from "../portal/auth";
import { HttpError } from "../portal/http";
import { preferences, todayFor } from "./access";
import { calendarPeople, listCalendars, listMembers } from "./calendars";
import { occurrencesInWindow } from "./events";
import { listFeeds } from "./feeds";
import { leaveOverlays, listCustomDates, overlaysFor } from "./holidays";
import { loadLeave } from "./leave";
import { listNotifications } from "./notify";
import { listSubscriptions } from "./subscriptions";

export type CalendarPage =
    "view" | "planner" | "year" | "family" | "leave" | "leave-planner" | "leave-settings" | "calendars" | "subscriptions" | "holidays" | "settings";

const visible = async <T>(load: () => Promise<T>): Promise<T | null> => {
    try {
        return await load();
    } catch (error) {
        if (error instanceof HttpError && (error.status === 404 || error.status === 403)) return null;
        throw error;
    }
};

export async function calendarShell(env: Env, user: PortalUser, flags: Flags): Promise<CalendarShell> {
    const [prefs, calendars, notifications, today] = await Promise.all([
        preferences(env.DB, user.email),
        listCalendars(env.DB, user),
        listNotifications(env.DB, user.email),
        todayFor(env.DB, user.email),
    ]);
    const failing = await env.DB.prepare("SELECT COUNT(*) AS n FROM calendar_subscriptions WHERE owner_email = ? AND enabled = 1 AND consecutive_failures > 0")
        .bind(user.email)
        .first<{ n: number }>();
    return {
        today,
        preferences: prefs,
        calendars,
        notifications,
        canUseTasks: can(user, "tasks.use"),
        canUseKnowledge: can(user, "knowledge.use"),
        switches: { feeds: !!flags["calendar.feeds"], reminderEmails: !!flags["calendar.reminders.email"] },
        failingSubscriptions: failing?.n ?? 0,
    };
}

const yearParam = (url: URL, today: string) => {
    const year = Number(url.searchParams.get("year") ?? today.slice(0, 4));
    return Number.isInteger(year) && year >= 2000 && year <= 2100 ? year : Number(today.slice(0, 4));
};

export async function loadCalendarPage(env: Env, user: PortalUser, url: URL, page: CalendarPage, flags: Flags): Promise<CalendarRoute | null> {
    return visible(async (): Promise<CalendarRoute> => {
        const s = await calendarShell(env, user, flags);
        const db = env.DB;
        switch (page) {
            case "view": {
                const viewParam = url.searchParams.get("view");
                const view = isCalendarView(viewParam) ? viewParam : s.preferences.defaultView === "year" ? "month" : s.preferences.defaultView;
                const dateParam = url.searchParams.get("date");
                const anchor = dateParam && isCalendarDate(dateParam) ? dateParam : s.today;
                const { from, to } = viewWindow(view, anchor, s.preferences.weekStart);
                const leave = await loadLeave(db, user);
                const [{ occurrences, truncated }, overlays] = await Promise.all([
                    occurrencesInWindow(db, user, { from, to, timeZone: s.preferences.timeZone }),
                    overlaysFor(db, user, s.preferences, leave, from, to, s.today),
                ]);
                const event = url.searchParams.get("event");
                // The Tasks panel and time blocks sit beside the day and week views.
                const planner = (view === "day" || view === "week") && s.canUseTasks ? await viewPlanner(db, user, from, to) : null;
                return {
                    route: "calendar-view",
                    planner,
                    ...s,
                    view,
                    anchor,
                    from,
                    to,
                    occurrences,
                    overlays,
                    openEvent: event && /^cev_[a-z0-9]{14}$/.test(event) ? event : null,
                    truncated,
                };
            }
            case "planner": {
                // The planner needs Tasks too; without it the page doesn't exist.
                if (!s.canUseTasks) throw new HttpError(404, "not_found", "Not found");
                const dateParam = url.searchParams.get("date");
                const date = dateParam && isCalendarDate(dateParam) ? dateParam : s.today;
                const leave = await loadLeave(db, user);
                const [plan, plannerPreferences, { occurrences }, overlays] = await Promise.all([
                    dayPlan(db, user, date),
                    plannerPrefs(db, user.email),
                    occurrencesInWindow(db, user, { from: date, to: date, timeZone: s.preferences.timeZone }),
                    overlaysFor(db, user, { ...s.preferences, overlays: { ...s.preferences.overlays, tasks: false } }, leave, date, date, s.today),
                ]);
                const block = url.searchParams.get("block");
                return {
                    route: "calendar-planner",
                    ...s,
                    date,
                    occurrences,
                    overlays,
                    plan,
                    plannerPreferences,
                    openBlock: block && /^ttb_[a-z0-9]{14}$/.test(block) ? block : null,
                };
            }
            case "year": {
                const year = yearParam(url, s.today);
                const from = `${year}-01-01`;
                const to = `${year}-12-31`;
                const leave = await loadLeave(db, user);
                const [{ occurrences }, overlays] = await Promise.all([
                    occurrencesInWindow(db, user, { from, to, timeZone: s.preferences.timeZone, limit: 5000 }),
                    overlaysFor(db, user, { ...s.preferences, overlays: { ...s.preferences.overlays, tasks: false } }, leave, from, to, s.today),
                ]);
                // Per-day counts only: the year view shows how busy each day is, not every event.
                const busy: Record<string, number> = {};
                for (const o of occurrences)
                    for (let d = o.startDate; d <= o.endDate && d <= to; d = addDays(d, 1)) if (d >= from) busy[d] = (busy[d] ?? 0) + 1;
                return { route: "calendar-year", ...s, year, overlays, busy };
            }
            case "family":
                return { route: "calendar-family", ...s, family: await familyOverview(env, user, s) };
            case "leave": {
                const tab = url.searchParams.get("tab");
                return {
                    route: "calendar-leave",
                    ...s,
                    leave: await loadLeave(db, user),
                    tab: tab === "bookings" || tab === "forecast" || tab === "scenarios" ? tab : "overview",
                };
            }
            case "leave-planner":
                return { route: "calendar-leave-planner", ...s, leave: await loadLeave(db, user) };
            case "leave-settings":
                return {
                    route: "calendar-leave-settings",
                    ...s,
                    leave: await loadLeave(db, user),
                    people: (await calendarPeople(env, db)).filter((p) => p.email !== user.email),
                };
            case "calendars": {
                const [members, people, feeds] = await Promise.all([
                    listMembers(
                        db,
                        s.calendars.filter((c) => c.role === "owner" || c.kind === "shared").map((c) => c.id),
                    ),
                    calendarPeople(env, db),
                    listFeeds(db, user),
                ]);
                return { route: "calendar-calendars", ...s, members, people: people.filter((p) => p.email !== user.email), feeds };
            }
            case "subscriptions":
                return { route: "calendar-subscriptions", ...s, subscriptions: await listSubscriptions(db, user) };
            case "holidays": {
                const division = s.preferences.schoolDivision === "western" ? "western" : "eastern";
                return { route: "calendar-holidays", ...s, year: yearParam(url, s.today), division, customDates: await listCustomDates(db, user) };
            }
            case "settings":
                return { route: "calendar-settings", ...s };
        }
    });
}

const FAMILY_PURPOSES = new Set(["family", "care", "school", "birthdays", "travel"]);

/** Shared household calendars and what's coming up in them in the next eight weeks. */
async function familyOverview(env: Env, user: PortalUser, s: CalendarShell): Promise<FamilyOverview> {
    const calendars = s.calendars.filter((c) => c.kind === "shared" || FAMILY_PURPOSES.has(c.purpose));
    const from = s.today;
    const to = addDays(s.today, 55);
    const [{ occurrences }, leave] = await Promise.all([
        occurrencesInWindow(env.DB, user, {
            from,
            to: addDays(s.today, 365),
            timeZone: s.preferences.timeZone,
            calendarIds: calendars.map((c) => c.id),
            includeHidden: true,
            limit: 3000,
        }),
        loadLeave(env.DB, user),
    ]);
    const soon = occurrences.filter((o) => o.startDate <= to);
    const important = occurrences.filter((o) => o.category === "birthday" || o.category === "anniversary").slice(0, 20);
    const division = s.preferences.schoolDivision;
    return {
        calendars,
        upcoming: soon.filter((o) => o.category !== "care" && o.category !== "pickup" && o.category !== "dropoff").slice(0, 60),
        importantDates: important,
        care: soon.filter((o) => o.category === "care" || o.category === "pickup" || o.category === "dropoff").slice(0, 60),
        school: schoolOverlays(from, addDays(s.today, 180), division, leave.customDates).filter((p) => p.kind !== "term"),
        leave: leaveOverlays(leave, from, addDays(s.today, 180), true),
        from,
        to,
    };
}
