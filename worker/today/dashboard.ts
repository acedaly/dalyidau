// Today (/portal/today): one person's day from Tasks, Calendar, the Daily Planner, notifications and
// their own reviews, read through each application's own access rules. Nothing here writes.
//
// Parts load independently ("parts"), so the page can refresh only what a change affected: the plan
// (tasks, sessions, conflicts, capacity and timeline) after scheduling, notifications after
// dismissing one, and so on. Every part is computed per request from the records: there's no cache
// to go stale. Other people's private events are "Busy" (Calendar's own window), hidden calendars
// stay out, and calendars the person left out of availability show as free.
import type { D1Database } from "@cloudflare/workers-types";
import { leaveContext } from "../../src/shared/calendar/holidays";
import { addDays, isCalendarDate, timeLabel, wallClock } from "../../src/shared/calendar/time";
import type { EventOccurrence } from "../../src/shared/calendar/types";
import type { PlannerTaskLists } from "../../src/shared/planner/types";
import type { PortalUser } from "../../src/shared/portal/types";
import type { TaskSummary } from "../../src/shared/tasks/types";
import { dayCapacity, dayTimeline, focusOn } from "../../src/shared/today/engine";
import type { CommitmentItem, TodayDashboard, TodayNotification, TodayTask } from "../../src/shared/today/types";
import { preferences as calendarPreferences, todayFor } from "../calendar/access";
import { listCalendars } from "../calendar/calendars";
import { occurrencesInWindow } from "../calendar/events";
import { listNotifications } from "../calendar/notify";
import { requirePlanner } from "../planner/blocks";
import { type PlanningWindow, blockConflicts, eventTitle, plannerTasks, planningWindow, projectNames } from "../planner/planning";
import { can } from "../portal/auth";
import { HttpError } from "../portal/http";
import { dueReminders } from "../tasks/reminders";
import { completedBetween, listDeadlines, listUpcoming } from "../tasks/views";
import { todayBriefing } from "./briefing";
import { loadTodayPrefs } from "./prefs";
import { loadReviews } from "./reviews";

export const TODAY_PARTS = ["plan", "deadlines", "commitments", "notifications", "completed", "briefing", "reviews"] as const;
export type TodayPart = (typeof TODAY_PARTS)[number];

/** How far from today the dashboard can look (the date switcher and MCP). */
const RANGE_DAYS = 366;

export async function resolveDate(db: D1Database, user: PortalUser, value: string | null | undefined) {
    const today = await todayFor(db, user.email);
    if (!value) return { date: today, today };
    if (!isCalendarDate(value)) throw new HttpError(400, "bad_date", "Use a date like 2026-10-19");
    if (value < addDays(today, -RANGE_DAYS) || value > addDays(today, RANGE_DAYS)) throw new HttpError(400, "bad_date", "Choose a date within a year of today");
    return { date: value, today };
}

const greetingFor = (time: string) => (time < "12:00" ? "Good morning" : time < "17:00" ? "Good afternoon" : "Good evening");

const toTask = (t: TaskSummary, names: Map<string, string>): TodayTask => ({
    id: t.id,
    title: t.title,
    projectId: t.projectId,
    projectName: names.get(t.projectId) ?? "",
    priority: t.priority,
    dueDate: t.dueDate,
    dueTime: t.dueTime,
    deadline: t.deadline,
    isMilestone: t.isMilestone,
});

/** Estimated time still needed for tasks due on a date (or overdue, on today), less what's planned. */
export function unscheduledFor(lists: PlannerTaskLists, date: string, today: string, defaultEstimate: number) {
    const due = lists.tasks.filter((t) => {
        const target = [t.deadline, t.dueDate].filter(Boolean).sort()[0];
        return target && (target === date || (date === today && target < date));
    });
    return due.reduce((s, t) => s + Math.max(0, (t.estimateMinutes ?? defaultEstimate) - t.scheduledMinutes), 0);
}

const eventUrl = (o: EventOccurrence) => `/portal/calendar?view=day&date=${o.startDate}&event=${o.eventId}`;

/** The day's plan: task lists, sessions, conflicts, capacity and the combined timeline. */
/**
 * Who reads the result: the person on their own page sees their own sensitive events' titles; an
 * assistant (MCP) gets Calendar's rules for AI, where sensitive events are "Private event".
 */
export type Audience = "person" | "assistant";

export async function planPart(db: D1Database, user: PortalUser, date: string, today: string, now = Date.now(), audience: Audience = "person") {
    const [w, lists] = await Promise.all([planningWindow(db, user, date, date), plannerTasks(db, user, today)]);
    return { w, lists, ...planFromWindow(w, lists, date, now, audience) };
}

export function planFromWindow(w: PlanningWindow, lists: PlannerTaskLists, date: string, now: number, audience: Audience = "person") {
    const day = w.days[0];
    const conflicts = blockConflicts(w);
    const capacity = dayCapacity(day, w.commitments, w.prefs, unscheduledFor(lists, date, w.today, w.prefs.defaultEstimateMinutes), w.timeZone);
    const calendars = new Map(w.calendars.map((c) => [c.id, c]));
    const excluded = new Set(w.todayPrefs.excludedCalendarIds);
    const ctx = leaveContext(w.leave.profile.pattern, w.leave.profile.settings, w.leave.customDates);
    const holiday = ctx.holidays.get(date);
    const types = new Map(w.leave.types.map((t) => [t.id, t.name]));
    const timeline = dayTimeline({
        date,
        timeZone: w.timeZone,
        day,
        events: w.occurrences
            .filter((o) => o.status !== "cancelled")
            .map((o) => {
                const cal = calendars.get(o.calendarId);
                return {
                    id: o.id,
                    // The person's own view keeps their sensitive events' titles; others' private ones are "Busy" either way.
                    title: audience === "assistant" ? eventTitle(o) : o.busyOnly ? "Busy" : o.title,
                    start: o.start,
                    end: o.end,
                    allDay: o.allDay,
                    busy: o.showAs === "busy",
                    counts: !excluded.has(o.calendarId),
                    readOnly: o.readOnly || o.source !== "local",
                    shared: cal?.kind === "shared",
                    detail: [
                        cal?.name,
                        o.source === "subscription" ? "Subscribed" : o.source === "import" ? "Imported" : null,
                        o.status === "tentative" ? "Tentative" : null,
                    ]
                        .filter(Boolean)
                        .join(" · "),
                    url: eventUrl(o),
                };
            }),
        blocks: w.blocks.filter((b) => b.startDate <= date && b.endDate >= date),
        conflicts,
        commitments: w.commitments,
        bufferMinutes: w.prefs.bufferMinutes,
        focus: focusOn(date, w.todayPrefs.focusPeriods, w.timeZone),
        leave: w.leave.bookings
            .filter((b) => !b.scenarioId && ["requested", "approved", "taken"].includes(b.status) && b.startDate <= date && b.endDate >= date)
            .map((b) => ({ id: b.id, title: b.title || types.get(b.leaveTypeId) || "Leave", allDay: b.part === "full", url: "/portal/calendar/leave" })),
        holidays: holiday ? [{ id: `holiday:${date}`, title: holiday }] : [],
        after: date === w.today ? now : -Infinity,
    });
    return { day, blocks: w.blocks, conflicts, capacity, timeline };
}

async function deadlinesPart(db: D1Database, user: PortalUser, date: string): Promise<TodayTask[]> {
    const [deadlines, upcoming] = await Promise.all([
        listDeadlines(db, user.email, addDays(date, 1), addDays(date, 14)),
        listUpcoming(db, user.email, addDays(date, 1), addDays(date, 14), date),
    ]);
    // Deadlines, plus milestones and P1 work due in the next fortnight.
    const seen = new Set<string>();
    const list = [...deadlines, ...upcoming.filter((t) => !t.projected && (t.isMilestone || t.priority === 1))].filter(
        (t) => !seen.has(t.id) && seen.add(t.id),
    );
    list.sort((a, b) => (a.deadline ?? a.dueDate ?? "").localeCompare(b.deadline ?? b.dueDate ?? "") || a.priority - b.priority || a.id.localeCompare(b.id));
    const names = await projectNames(
        db,
        user.email,
        list.map((t) => t.projectId),
    );
    return list.slice(0, 20).map((t) => toTask(t, names));
}

/** Today's events in personal calendars, and shared (family) commitments over the next days. */
export async function commitmentsPart(
    db: D1Database,
    user: PortalUser,
    date: string,
    timeZone: string,
    lookaheadDays: number,
    calendarsFor: PlanningWindow["calendars"],
) {
    const { occurrences } = await occurrencesInWindow(db, user, { from: date, to: addDays(date, lookaheadDays - 1), timeZone });
    const calendars = new Map(calendarsFor.map((c) => [c.id, c]));
    const item = (o: EventOccurrence): CommitmentItem => ({
        id: o.id,
        // Calendar's rules for anything an assistant can read: others' private events "Busy", sensitive ones "Private event".
        title: eventTitle(o),
        date: o.startDate,
        when: o.allDay ? "All day" : `${timeLabel(o.startTime ?? "00:00")} – ${timeLabel(o.endTime ?? "23:59")}`,
        calendarName: calendars.get(o.calendarId)?.name ?? "",
        shared: calendars.get(o.calendarId)?.kind === "shared",
        url: eventUrl(o),
    });
    const live = occurrences.filter((o) => o.status !== "cancelled");
    return {
        personal: live
            .filter((o) => o.startDate <= date && calendars.get(o.calendarId)?.kind !== "shared")
            .slice(0, 20)
            .map(item),
        shared: live
            .filter((o) => calendars.get(o.calendarId)?.kind === "shared")
            .slice(0, 20)
            .map(item),
    };
}

async function notificationsPart(db: D1Database, user: PortalUser): Promise<TodayNotification[]> {
    const [calendar, reminders, suggestions] = await Promise.all([
        listNotifications(db, user.email, 10),
        dueReminders(db, user.email, new Date()),
        can(user, "intelligence.use")
            ? db.prepare("SELECT COUNT(*) AS n FROM ai_suggestions WHERE email = ? AND status = 'pending'").bind(user.email).first<{ n: number }>()
            : Promise.resolve(null),
    ]);
    const out: TodayNotification[] = [
        ...calendar.map((n) => ({
            id: n.id,
            source: "calendar" as const,
            title: n.title,
            detail: n.detail,
            url: n.url,
            at: n.fireAt,
            dismissable: true,
            kind: n.kind,
        })),
        ...reminders.slice(0, 10).map((r) => ({
            id: r.id,
            source: "tasks" as const,
            title: `Reminder: ${r.title}`,
            detail: null,
            url: `/portal/tasks/t/${r.taskId}`,
            at: r.remindAt,
            dismissable: false,
            kind: "task_reminder" as const,
        })),
    ];
    if (suggestions?.n)
        out.push({
            id: "intelligence:suggestions",
            source: "intelligence",
            title: `${suggestions.n} AI ${suggestions.n === 1 ? "suggestion" : "suggestions"} waiting for your approval`,
            detail: null,
            url: "/portal/intelligence/inbox",
            at: new Date().toISOString(),
            dismissable: false,
            kind: "suggestions",
        });
    return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 15);
}

async function completedPart(db: D1Database, user: PortalUser, date: string): Promise<TodayTask[]> {
    const done = await completedBetween(db, user.email, date, date);
    const names = await projectNames(
        db,
        user.email,
        done.map((t) => t.projectId),
    );
    return done.slice(0, 30).map((t) => toTask(t, names));
}

/** The whole dashboard (the page's first render), or just some parts of it (a refresh). */
export async function todayDashboard(
    db: D1Database,
    user: PortalUser,
    input: { date?: string | null; parts?: readonly TodayPart[]; now?: number; audience?: Audience },
): Promise<Partial<TodayDashboard> & Pick<TodayDashboard, "date" | "today" | "timeZone" | "now" | "greeting">> {
    requirePlanner(user);
    const now = input.now ?? Date.now();
    const { date, today } = await resolveDate(db, user, input.date);
    const want = new Set<TodayPart>(input.parts?.length ? input.parts : TODAY_PARTS);
    const { preferences, version } = await loadTodayPrefs(db, user.email);
    // The briefing reads the plan, so asking for it loads the plan too.
    const needPlan = want.has("plan") || want.has("briefing");
    const [plan, deadlines, notifications, completed, reviews] = await Promise.all([
        needPlan ? planPart(db, user, date, today, now, input.audience) : Promise.resolve(null),
        want.has("deadlines") || want.has("briefing") ? deadlinesPart(db, user, date) : Promise.resolve(null),
        want.has("notifications") ? notificationsPart(db, user) : Promise.resolve(null),
        want.has("completed") && preferences.showCompleted ? completedPart(db, user, date) : Promise.resolve(want.has("completed") ? [] : null),
        want.has("reviews") || want.has("briefing") ? loadReviews(db, user, date) : Promise.resolve(null),
    ]);
    const zone = plan?.w.timeZone ?? (await calendarPreferences(db, user.email)).timeZone;
    const calendars = plan?.w.calendars ?? (want.has("commitments") ? await listCalendars(db, user) : []);
    const commitments =
        want.has("commitments") || want.has("briefing") ? await commitmentsPart(db, user, date, zone, preferences.briefing.lookaheadDays, calendars) : null;
    const local = wallClock(new Date(now), zone);
    const out: Partial<TodayDashboard> & Pick<TodayDashboard, "date" | "today" | "timeZone" | "now" | "greeting"> = {
        date,
        today,
        timeZone: zone,
        now: new Date(now).toISOString(),
        greeting: greetingFor(local.time),
    };
    if (want.has("plan") && plan) {
        Object.assign(out, {
            lists: plan.lists,
            blocks: plan.blocks,
            conflicts: plan.conflicts,
            capacity: plan.capacity,
            timeline: plan.timeline,
            preferences,
            preferencesVersion: version,
            calendars: plan.w.calendars
                .filter((c) => !c.hidden)
                .map((c) => ({
                    id: c.id,
                    name: c.name,
                    kind: c.source === "subscription" ? ("subscription" as const) : c.kind,
                    canWrite: c.source === "local" && (c.role === "owner" || c.role === "editor"),
                    isDefault: c.isDefault,
                })),
            canUseIntelligence: can(user, "intelligence.use"),
            canUseKnowledge: can(user, "knowledge.use"),
        });
    }
    if (want.has("deadlines") && deadlines) out.deadlines = deadlines;
    if (want.has("commitments") && commitments) out.commitments = commitments;
    if (want.has("notifications") && notifications) out.notifications = notifications;
    if (want.has("completed") && completed) out.completed = completed;
    if (want.has("reviews") && reviews) out.reviews = reviews;
    if (want.has("briefing") && plan) {
        out.briefing = await todayBriefing(db, user, {
            date,
            today,
            now,
            localTime: local.time,
            plan,
            deadlines: deadlines ?? [],
            family: commitments?.shared ?? [],
            reviews: reviews ?? { morning: null, evening: null },
        });
    }
    return out;
}
