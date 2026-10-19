// The Daily Planner's reads: the task lists beside the calendar, a day's plan (commitments, free
// time, capacity, conflicts), checks for a proposed time, and deterministic suggestions. Every task
// comes from Tasks' own views and access rules; every event from Calendar's own window, so private
// events of others are "Busy" and calendars the person can't see aren't there at all. Nothing here
// writes: suggestions become time blocks only when the person accepts them.
import type { D1Database } from "@cloudflare/workers-types";
import { z } from "zod";
import { leaveContext } from "../../src/shared/calendar/holidays";
import { addDays, daysBetween, eachDate, isCalendarDate, wallClock, zonedInstant } from "../../src/shared/calendar/time";
import type { CalendarInfo, EventOccurrence, LeaveData } from "../../src/shared/calendar/types";
import {
    type Availability,
    type Commitment,
    type LeaveDay,
    type PlanTask,
    availability,
    capacity,
    conflictsFor,
    freeTime,
    suggestPlan,
    toFreeSlots,
} from "../../src/shared/planner/engine";
import {
    BLOCK_LIMITS,
    type DayPlan,
    PLANNER_BUCKETS,
    type PlanResult,
    type PlannerBucket,
    type PlannerConflict,
    type PlannerData,
    type PlannerPreferences,
    type PlannerTask,
    type PlannerTaskLists,
    type TimeBlockInfo,
} from "../../src/shared/planner/types";
import type { PortalUser } from "../../src/shared/portal/types";
import type { TaskSummary } from "../../src/shared/tasks/types";
import { focusOn } from "../../src/shared/today/engine";
import type { TodayPreferences } from "../../src/shared/today/types";
import { preferences as calendarPreferences, todayFor } from "../calendar/access";
import { listCalendars } from "../calendar/calendars";
import { occurrencesInWindow } from "../calendar/events";
import { leaveOverlays } from "../calendar/holidays";
import { loadLeave } from "../calendar/leave";
import { HttpError } from "../portal/http";
import { requireTask } from "../tasks/access";
import { TASK_COLUMNS } from "../tasks/rows";
import { MINE as MY_TASKS, NOT_PAUSED, all, listInbox, listOverdue, listToday, listUpcoming } from "../tasks/views";
import { loadTodayPrefs } from "../today/prefs";
import { blockInstants, blocksBetween, estimatesFor, plannedFor, plannerPrefs } from "./blocks";

const UPCOMING_DAYS = 7;
const LIST_LIMIT = 60;

// --- Task lists ----------------------------------------------------------------------------------

/** Open tasks at P1 or P2, dated or not, that the caller can work on. */
const listPriority = (db: D1Database, email: string) =>
    all(
        db,
        `SELECT ${TASK_COLUMNS} ${MY_TASKS} WHERE p.status = 'active' AND m.role <> 'viewer' AND (t.assignee_email IS NULL OR t.assignee_email = ?1)
         AND t.status = 'open' AND t.priority <= 2 AND ${NOT_PAUSED}
         ORDER BY t.priority, t.due_date IS NULL, t.due_date, t.position LIMIT ${LIST_LIMIT}`,
        [email],
    );

/** Undated open tasks the caller can work on (Inbox and projects), most urgent first. */
const listUndated = (db: D1Database, email: string) =>
    all(
        db,
        `SELECT ${TASK_COLUMNS} ${MY_TASKS} WHERE p.status = 'active' AND m.role <> 'viewer' AND (t.assignee_email IS NULL OR t.assignee_email = ?1)
         AND t.status = 'open' AND t.due_date IS NULL AND t.deadline IS NULL AND ${NOT_PAUSED}
         ORDER BY t.priority, p.is_inbox DESC, t.created_at DESC LIMIT ${LIST_LIMIT}`,
        [email],
    );

export async function projectNames(db: D1Database, email: string, ids: readonly string[]) {
    const rows = await db
        .prepare(
            `SELECT p.id, p.name, p.is_inbox FROM task_projects p JOIN task_project_members m ON m.project_id = p.id AND m.email = ?
             WHERE p.id IN (SELECT value FROM json_each(?))`,
        )
        .bind(email, JSON.stringify([...new Set(ids)]))
        .all<{ id: string; name: string; is_inbox: number }>();
    return new Map(rows.results.map((r) => [r.id, r.is_inbox ? "Inbox" : r.name]));
}

/** Inbox, Today, Overdue, Upcoming (7 days), Priority and Unscheduled: Tasks' own lists, with estimates and planned time. */
export async function plannerTasks(db: D1Database, user: PortalUser, today: string): Promise<PlannerTaskLists> {
    const inboxId = await db
        .prepare("SELECT id FROM task_projects WHERE is_inbox = 1 AND inbox_owner = ?")
        .bind(user.email)
        .first<{ id: string }>()
        .then((r) => r?.id ?? null);
    const [inbox, due, overdue, upcoming, priority, undated] = await Promise.all([
        inboxId ? listInbox(db, user.email, inboxId) : Promise.resolve([] as TaskSummary[]),
        listToday(db, user.email, today, null),
        listOverdue(db, user.email, today),
        listUpcoming(db, user.email, addDays(today, 1), addDays(today, UPCOMING_DAYS), today),
        listPriority(db, user.email),
        listUndated(db, user.email),
    ]);
    // Later repeats of a repeating task are projections, not the task: plan the occurrence due now.
    const lists: Record<Exclude<PlannerBucket, "unscheduled">, TaskSummary[]> = {
        today: due,
        overdue,
        upcoming: upcoming.filter((t) => !t.projected),
        priority,
        // Top-level open tasks in the person's own Inbox (subtasks stay with their parent). Last, so
        // the Unscheduled list keeps dated work first.
        inbox: inbox.filter((t) => !t.parentId).slice(0, LIST_LIMIT),
    };
    const byId = new Map<string, TaskSummary>();
    for (const list of [...Object.values(lists), undated]) for (const t of list) if (!byId.has(t.id)) byId.set(t.id, t);
    const ids = [...byId.keys()];
    const [estimates, planned, names] = await Promise.all([
        estimatesFor(db, ids),
        plannedFor(db, user, ids),
        projectNames(
            db,
            user.email,
            [...byId.values()].map((t) => t.projectId),
        ),
    ]);
    const tasks: PlannerTask[] = [...byId.values()].map((t) => ({
        id: t.id,
        title: t.title,
        projectId: t.projectId,
        projectName: names.get(t.projectId) ?? "",
        priority: t.priority,
        dueDate: t.dueDate,
        dueTime: t.dueTime,
        deadline: t.deadline,
        recurring: !!t.recurrence,
        isMilestone: t.isMilestone,
        estimateMinutes: estimates.get(t.id) ?? null,
        scheduledMinutes: planned.get(t.id)?.minutes ?? 0,
        upcomingSessions: planned.get(t.id)?.upcoming ?? 0,
        canEdit: true,
        version: t.version,
    }));
    const buckets = Object.fromEntries(PLANNER_BUCKETS.map((b) => [b, [] as string[]])) as Record<PlannerBucket, string[]>;
    for (const [bucket, list] of Object.entries(lists) as [Exclude<PlannerBucket, "unscheduled">, TaskSummary[]][])
        buckets[bucket] = [...new Set(list.map((t) => t.id))].slice(0, LIST_LIMIT);
    // Unscheduled: anything above, or undated, with no session planned for its current occurrence.
    buckets.unscheduled = tasks
        .filter((t) => t.scheduledMinutes === 0)
        .map((t) => t.id)
        .slice(0, LIST_LIMIT);
    return { tasks, buckets };
}

// --- A window of commitments ---------------------------------------------------------------------

export interface PlanningWindow {
    from: string;
    to: string;
    today: string;
    timeZone: string;
    prefs: PlannerPreferences;
    occurrences: EventOccurrence[];
    blocks: TimeBlockInfo[];
    commitments: Commitment[];
    days: Availability[];
    leave: LeaveData;
    calendars: CalendarInfo[];
    /** Today's preferences: breaks, focus periods and calendars that don't count towards availability. */
    todayPrefs: TodayPreferences;
}

export const eventTitle = (o: EventOccurrence) => (o.busyOnly ? "Busy" : o.visibility === "sensitive" ? "Private event" : o.title);

/** Events (yours, shared and subscribed), leave and your blocks between two local dates. */
export async function planningWindow(db: D1Database, user: PortalUser, from: string, to: string): Promise<PlanningWindow> {
    if (!isCalendarDate(from) || !isCalendarDate(to) || to < from) throw new HttpError(400, "bad_window", "Give from and to dates, from first");
    if (daysBetween(from, to) > BLOCK_LIMITS.windowDays) throw new HttpError(400, "bad_window", `Ask for at most ${BLOCK_LIMITS.windowDays} days at a time`);
    const [{ timeZone }, { preferences: prefs }, today, calendars, leave, { preferences: todayPrefs }] = await Promise.all([
        calendarPreferences(db, user.email),
        plannerPrefs(db, user.email),
        todayFor(db, user.email),
        listCalendars(db, user),
        loadLeave(db, user),
        loadTodayPrefs(db, user.email),
    ]);
    const excluded = new Set(todayPrefs.excludedCalendarIds);
    const start = zonedInstant(from, "00:00", timeZone);
    const end = zonedInstant(addDays(to, 1), "00:00", timeZone);
    const [{ occurrences }, blocks] = await Promise.all([
        // Hidden calendars stay out of planning, as they stay out of view.
        occurrencesInWindow(db, user, { from, to, timeZone }),
        blocksBetween(db, user, start, end, timeZone),
    ]);
    const shared = new Map(calendars.map((c: CalendarInfo) => [c.id, c.kind === "shared"]));
    const commitments: Commitment[] = [
        ...occurrences
            .filter((o) => !o.allDay && o.status !== "cancelled")
            .map((o): Commitment => ({
                id: o.eventId,
                title: eventTitle(o),
                start: o.start,
                end: o.end,
                kind: "event",
                source: o.source,
                shared: shared.get(o.calendarId) ?? false,
                // A calendar the person chose not to count towards availability (Today's settings) still shows, as free.
                busy: o.showAs === "busy" && !excluded.has(o.calendarId),
            })),
        ...blocks.map((b): Commitment => ({ id: b.id, title: b.title, start: b.start, end: b.end, kind: "block", source: "block", shared: false, busy: true })),
    ];
    const ctx = leaveContext(leave.profile.pattern, leave.profile.settings, leave.customDates);
    const types = new Map(leave.types.map((t) => [t.id, t.name]));
    const leaveDays: LeaveDay[] = leave.bookings
        .filter((b) => !b.scenarioId && (b.status === "requested" || b.status === "approved" || b.status === "taken") && b.endDate >= from && b.startDate <= to)
        .map((b) => ({ start: b.startDate, end: b.endDate, part: b.part, hours: b.hours, label: b.title || types.get(b.leaveTypeId) || "Leave" }));
    const days = eachDate(from, to, BLOCK_LIMITS.windowDays + 1).map((d) =>
        availability(d, { prefs, timeZone, leaveContext: ctx, leave: leaveDays, breaks: todayPrefs.breaks }),
    );
    return { from, to, today, timeZone, prefs, occurrences, blocks, commitments, days, leave, calendars, todayPrefs };
}

/** Conflicts for every block in a window. */
export const blockConflicts = (w: PlanningWindow): PlannerConflict[] =>
    w.blocks.flatMap((b) =>
        conflictsFor(
            { id: b.id, start: b.start, end: b.end, dueDate: b.earlierOccurrence ? null : b.taskDueDate, dueTime: b.taskDueTime },
            w.commitments,
            w.days,
            w.timeZone,
        ),
    );

// --- One day -------------------------------------------------------------------------------------

export async function dayPlan(db: D1Database, user: PortalUser, date: string, lists?: PlannerTaskLists): Promise<DayPlan & { lists: PlannerTaskLists }> {
    const w = await planningWindow(db, user, date, date);
    const day = w.days[0];
    const lists_ = lists ?? (await plannerTasks(db, user, w.today));
    // What's still to plan for this day: tasks due on it (or overdue, when it's today), less what's planned.
    const due = lists_.tasks.filter((t) => {
        const target = [t.deadline, t.dueDate].filter(Boolean).sort()[0];
        return target && (target === date || (date === w.today && target < date));
    });
    const unscheduled = due.reduce((s, t) => s + Math.max(0, (t.estimateMinutes ?? w.prefs.defaultEstimateMinutes) - t.scheduledMinutes), 0);
    const now = Date.now();
    return {
        date,
        timeZone: w.timeZone,
        today: w.today,
        blocks: w.blocks,
        free: toFreeSlots(freeTime(day.window, w.commitments, w.prefs.bufferMinutes, date === w.today ? now : -Infinity), w.timeZone, 15),
        capacity: capacity(day, w.commitments, w.prefs, unscheduled),
        conflicts: blockConflicts(w),
        leave: leaveOverlays(w.leave, date, date, true),
        lists: lists_,
    };
}

/** Planner data for the calendar's day and week views: the task lists, the blocks and their conflicts. */
export async function viewPlanner(db: D1Database, user: PortalUser, from: string, to: string): Promise<PlannerData> {
    const w = await planningWindow(db, user, from, to);
    return { lists: await plannerTasks(db, user, w.today), blocks: w.blocks, conflicts: blockConflicts(w), preferences: w.prefs };
}

// --- Checking a proposed time --------------------------------------------------------------------

const checkInput = z
    .object({
        taskId: z.string().regex(/^tsk_[a-z0-9]{14}$/),
        /** When moving an existing block: leave it out of its own conflicts. */
        blockId: z
            .string()
            .regex(/^ttb_[a-z0-9]{14}$/)
            .optional(),
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
        durationMinutes: z.number().int().min(BLOCK_LIMITS.minMinutes).max(BLOCK_LIMITS.maxMinutes),
    })
    .strict();

/** What a proposed session would clash with. Warnings only: the person decides. */
export async function checkTime(db: D1Database, user: PortalUser, input: unknown): Promise<PlannerConflict[]> {
    const body = checkInput.parse(input);
    const task = await requireTask(db, user, body.taskId, "editor");
    const { timeZone } = await calendarPreferences(db, user.email);
    const { start, end } = blockInstants(body.startDate, body.startTime, body.durationMinutes, timeZone);
    const endDate = wallClock(end, timeZone).date;
    const w = await planningWindow(db, user, body.startDate, endDate < body.startDate ? body.startDate : endDate);
    return conflictsFor(
        { id: body.blockId ?? null, start, end, dueDate: task.due_date, dueTime: task.due_time, deadline: task.deadline },
        w.commitments,
        w.days,
        w.timeZone,
    );
}

/** What a block (just created or moved) clashes with. */
export async function conflictsForBlock(db: D1Database, user: PortalUser, block: TimeBlockInfo): Promise<PlannerConflict[]> {
    if (block.status !== "scheduled") return [];
    const w = await planningWindow(db, user, block.startDate, block.endDate < block.startDate ? block.startDate : block.endDate);
    return conflictsFor(
        { id: block.id, start: block.start, end: block.end, dueDate: block.earlierOccurrence ? null : block.taskDueDate, dueTime: block.taskDueTime },
        w.commitments,
        w.days,
        w.timeZone,
    );
}

// --- Suggestions ---------------------------------------------------------------------------------

export const suggestInput = z
    .object({
        from: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional(),
        days: z.number().int().min(1).max(BLOCK_LIMITS.suggestDays).default(1),
        /** Only these tasks (default: today, overdue, upcoming and priority tasks not yet planned). */
        taskIds: z
            .array(z.string().regex(/^tsk_[a-z0-9]{14}$/))
            .min(1)
            .max(50)
            .optional(),
    })
    .strict();

/** Suggested sessions in the person's free time. Read-only: accept a suggestion to create a block. */
export async function suggest(db: D1Database, user: PortalUser, input: unknown, now = Date.now()): Promise<PlanResult> {
    const body = suggestInput.parse(input);
    const today = await todayFor(db, user.email);
    const from = body.from && body.from > today ? body.from : today;
    const to = addDays(from, body.days - 1);
    const [w, lists] = await Promise.all([planningWindow(db, user, from, to), plannerTasks(db, user, today)]);
    let candidates: PlannerTask[];
    if (body.taskIds) {
        const known = new Map(lists.tasks.map((t) => [t.id, t]));
        candidates = [];
        for (const id of [...new Set(body.taskIds)]) {
            // Every id is checked through Tasks: one the caller can't work on is a 404 for the whole request.
            await requireTask(db, user, id, "editor");
            const t = known.get(id) ?? (await plannerTaskById(db, user, id));
            if (t) candidates.push(t);
        }
    } else {
        const wanted = new Set([...lists.buckets.today, ...lists.buckets.overdue, ...lists.buckets.upcoming, ...lists.buckets.priority]);
        candidates = lists.tasks.filter((t) => wanted.has(t.id));
    }
    const tasks: PlanTask[] = candidates.map((t) => ({
        id: t.id,
        title: t.title,
        priority: t.priority,
        dueDate: t.dueDate,
        dueTime: t.dueTime,
        deadline: t.deadline,
        occurrenceDate: t.recurring ? t.dueDate : null,
        estimateMinutes: t.estimateMinutes,
        scheduledMinutes: t.scheduledMinutes,
    }));
    // Focus periods (Today's preferences) are used first.
    const preferred = eachDate(from, to, BLOCK_LIMITS.suggestDays + 1).flatMap((d) => focusOn(d, w.todayPrefs.focusPeriods, w.timeZone));
    return suggestPlan({ from, to, today, now, timeZone: w.timeZone, prefs: w.prefs, days: w.days, commitments: w.commitments, tasks, preferred });
}

/** One open task the caller can work on, as the planner lists it, or null if it's completed. */
async function plannerTaskById(db: D1Database, user: PortalUser, id: string): Promise<PlannerTask | null> {
    const [task] = await all(db, `SELECT ${TASK_COLUMNS} ${MY_TASKS} WHERE t.id = ?2 AND t.status = 'open' AND m.role <> 'viewer'`, [user.email, id]);
    if (!task) return null;
    const [estimates, planned, names] = await Promise.all([estimatesFor(db, [id]), plannedFor(db, user, [id]), projectNames(db, user.email, [task.projectId])]);
    return {
        id: task.id,
        title: task.title,
        projectId: task.projectId,
        projectName: names.get(task.projectId) ?? "",
        priority: task.priority,
        dueDate: task.dueDate,
        dueTime: task.dueTime,
        deadline: task.deadline,
        recurring: !!task.recurrence,
        isMilestone: task.isMilestone,
        estimateMinutes: estimates.get(id) ?? null,
        scheduledMinutes: planned.get(id)?.minutes ?? 0,
        upcomingSessions: planned.get(id)?.upcoming ?? 0,
        canEdit: true,
        version: task.version,
    };
}
