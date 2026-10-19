// MCP tools for Today (docs/DAILY_PLANNER.md#today): the day's summary, capacity, unscheduled tasks,
// a proposed plan, conflicts and the Chief of Staff briefing. All read-only: they need both Calendar
// and Tasks, read through the same functions as the portal page, and never write. To act on a
// proposal an assistant uses the existing planner_schedule_task (one session the person agreed to),
// tasks_update or tasks_reschedule, each with its own checks, ledger and audit.
import { z } from "zod";
import { timeLabel } from "../../src/shared/calendar/time";
import type { BriefingRef, TimelineItem } from "../../src/shared/today/types";
import { requirePlanner } from "../planner/blocks";
import { todayDashboard } from "../today/dashboard";
import { proposePlan } from "../today/plan";
import { type ToolContext, type ToolDef, calendarDate, id, portalUrl, tool } from "./shared";

const dayInput = z.object({ date: calendarDate.optional() }).strict();
const clock = (t: string) => timeLabel(t === "24:00" ? "23:59" : t);
const refOut = (ctx: ToolContext, r: BriefingRef) => ({
    id: r.id,
    title: r.title,
    kind: r.kind,
    ...(r.detail ? { detail: r.detail } : {}),
    url: portalUrl(ctx, r.url),
});

const itemOut = (ctx: ToolContext, i: TimelineItem) => ({
    kind: i.kind,
    title: i.title,
    when: `${clock(i.startTime)} – ${clock(i.endTime)}`,
    minutes: i.minutes,
    fixed: i.fixed,
    movable: i.movable,
    readOnly: i.readOnly,
    countsAsBusy: i.busy,
    shared: i.shared,
    conflict: i.conflict,
    ...(i.kind === "block" ? { blockId: i.id, taskId: i.taskId } : {}),
    ...(i.url && i.kind !== "free" ? { url: portalUrl(ctx, i.url) } : {}),
});

const getSummary = tool({
    name: "today_get_summary",
    write: false,
    permission: "calendar.use",
    input: dayInput,
    run: async (ctx, input) => {
        requirePlanner(ctx.user);
        const d = await todayDashboard(ctx.db, ctx.user, { date: input.date, parts: ["plan", "deadlines", "notifications", "reviews"], audience: "assistant" });
        const lists = d.lists!;
        const byId = new Map(lists.tasks.map((t) => [t.id, t]));
        const tasks = (ids: string[], max = 10) =>
            ids
                .map((tid) => byId.get(tid))
                .filter((t) => !!t)
                .slice(0, max)
                .map((t) => ({
                    id: t!.id,
                    title: t!.title,
                    priority: t!.priority,
                    dueDate: t!.dueDate,
                    projectName: t!.projectName,
                    url: portalUrl(ctx, `/portal/tasks/t/${t!.id}`),
                }));
        return {
            data: {
                date: d.date,
                today: d.today,
                timeZone: d.timeZone,
                capacity: { status: d.capacity!.status, availableMinutes: d.capacity!.availableMinutes, freeMinutes: d.capacity!.freeMinutes },
                timeline: d
                    .timeline!.items.filter((i) => i.kind !== "free" && i.kind !== "focus")
                    .slice(0, 40)
                    .map((i) => itemOut(ctx, i)),
                allDay: d.timeline!.allDay.map((a) => ({ title: a.title, kind: a.kind })),
                dueToday: tasks(lists.buckets.today.filter((tid) => byId.get(tid)?.dueDate === d.date || byId.get(tid)?.deadline === d.date)),
                overdue: tasks(lists.buckets.overdue),
                highPriorityUnscheduled: tasks(lists.buckets.priority.filter((tid) => byId.get(tid)?.scheduledMinutes === 0)),
                upcomingDeadlines: d
                    .deadlines!.slice(0, 10)
                    .map((t) => ({ id: t.id, title: t.title, deadline: t.deadline, dueDate: t.dueDate, url: portalUrl(ctx, `/portal/tasks/t/${t.id}`) })),
                notifications: d.notifications!.slice(0, 10).map((n) => ({ source: n.source, title: n.title, at: n.at })),
                morningPlanningDone: !!d.reviews!.morning,
                eveningReviewDone: !!d.reviews!.evening,
                url: portalUrl(ctx, `/portal/today?date=${d.date}`),
            },
        };
    },
});

const getCapacity = tool({
    name: "today_get_capacity",
    write: false,
    permission: "calendar.use",
    input: dayInput,
    run: async (ctx, input) => {
        requirePlanner(ctx.user);
        const d = await todayDashboard(ctx.db, ctx.user, { date: input.date, parts: ["plan"], audience: "assistant" });
        const c = d.capacity!;
        return {
            data: {
                timeZone: d.timeZone,
                ...c,
                overbooked: c.overbooked.map((o) => ({
                    when: `${clock(o.startTime)} – ${clock(o.endTime)}`,
                    minutes: o.minutes,
                    with: o.with.map((w) => ({ title: w.title, kind: w.kind })),
                })),
                note: "Worked out by the portal from working hours, breaks, leave, holidays, calendar events and planned sessions, with overlaps counted once. Report it as given.",
            },
        };
    },
});

const listUnscheduled = tool({
    name: "today_list_unscheduled",
    write: false,
    permission: "calendar.use",
    input: z
        .object({
            projectId: id("tpj", "project").optional(),
            limit: z.number().int().min(1).max(60).default(25),
        })
        .strict(),
    run: async (ctx, input) => {
        requirePlanner(ctx.user);
        const d = await todayDashboard(ctx.db, ctx.user, { parts: ["plan"], audience: "assistant" });
        const byId = new Map(d.lists!.tasks.map((t) => [t.id, t]));
        const all = d.lists!.buckets.unscheduled.map((tid) => byId.get(tid)!).filter((t) => t && (!input.projectId || t.projectId === input.projectId));
        return {
            data: {
                tasks: all.slice(0, input.limit).map((t) => ({
                    id: t.id,
                    title: t.title,
                    priority: t.priority,
                    dueDate: t.dueDate,
                    deadline: t.deadline,
                    projectId: t.projectId,
                    projectName: t.projectName,
                    estimateMinutes: t.estimateMinutes,
                    url: portalUrl(ctx, `/portal/tasks/t/${t.id}`),
                })),
                count: all.length,
                truncated: all.length > input.limit,
            },
        };
    },
});

const proposeDay = tool({
    name: "today_propose_plan",
    write: false,
    permission: "calendar.use",
    input: z.object({ date: calendarDate.optional(), taskIds: z.array(id("tsk", "task")).min(1).max(50).optional() }).strict(),
    run: async (ctx, input) => {
        requirePlanner(ctx.user);
        const p = await proposePlan(ctx.db, ctx.user, input);
        return {
            data: {
                date: p.date,
                freeMinutesBefore: p.capacityBefore.freeMinutes,
                proposed: p.suggestions.slice(0, 30).map((s) => ({
                    taskId: s.taskId,
                    title: s.title,
                    startDate: s.startDate,
                    startTime: s.startTime,
                    durationMinutes: s.durationMinutes,
                    when: `${clock(s.startTime)} – ${clock(s.endTime)}`,
                    occurrenceDate: s.occurrenceDate,
                    inFocusPeriod: s.inFocus,
                    late: s.late,
                    reason: s.reason,
                    warnings: s.conflicts.map((c) => c.message),
                })),
                unplaced: p.unplaced,
                note: `${p.note} This is a proposal. Show it to the person, and schedule only the sessions they accept, one by one, with planner_schedule_task.`,
                url: portalUrl(ctx, `/portal/today?date=${p.date}`),
            },
        };
    },
});

const getConflicts = tool({
    name: "today_get_conflicts",
    write: false,
    permission: "calendar.use",
    input: dayInput,
    run: async (ctx, input) => {
        requirePlanner(ctx.user);
        const d = await todayDashboard(ctx.db, ctx.user, { date: input.date, parts: ["plan"], audience: "assistant" });
        const blocks = new Map(d.blocks!.map((b) => [b.id, b]));
        return {
            data: {
                date: d.date,
                conflicts: d
                    .conflicts!.filter((c) => c.blockId && blocks.get(c.blockId)?.startDate === d.date)
                    .slice(0, 30)
                    .map((c) => {
                        const b = blocks.get(c.blockId!)!;
                        return {
                            kind: c.kind,
                            message: c.message,
                            session: {
                                blockId: b.id,
                                taskId: b.taskId,
                                title: b.title,
                                when: `${clock(b.startTime)} – ${clock(b.endTime)}`,
                                version: b.version,
                            },
                            ...(c.with ? { with: { title: c.with.title, source: c.with.source, shared: c.with.shared } } : {}),
                        };
                    }),
                overbooked: d.capacity!.overbooked.map((o) => ({
                    when: `${clock(o.startTime)} – ${clock(o.endTime)}`,
                    with: o.with.map((w) => ({ title: w.title, kind: w.kind })),
                })),
                note: "Warnings only. Events from subscribed calendars can't be changed; suggest moving the person's own sessions, and only with their agreement.",
            },
        };
    },
});

const getBriefing = tool({
    name: "today_get_briefing",
    write: false,
    permission: "calendar.use",
    input: dayInput,
    run: async (ctx, input) => {
        requirePlanner(ctx.user);
        const d = await todayDashboard(ctx.db, ctx.user, { date: input.date, parts: ["briefing"], audience: "assistant" });
        const b = d.briefing!;
        const refs = (list: BriefingRef[]) => list.map((r) => refOut(ctx, r));
        return {
            data: {
                date: b.date,
                commitments: refs(b.commitments),
                topPriorities: refs(b.priorities),
                overdue: refs(b.overdue),
                conflicts: refs(b.conflicts),
                capacity: b.capacity,
                projectDeadlines: refs(b.projectDeadlines),
                familyCommitments: refs(b.family),
                unfinishedYesterday: refs(b.unfinishedYesterday),
                recommendedNextActions: b.nextActions.map((a) => ({ text: a.text, refs: refs(a.refs) })),
                notChecked: b.notChecked,
                note: "Facts from the person's Portal records, each with a link. Explain or summarise them, but never add tasks, meetings, deadlines or availability that aren't here.",
                url: portalUrl(ctx, `/portal/today?date=${b.date}`),
            },
        };
    },
});

export const TODAY_TOOLS: ToolDef[] = [getSummary, getCapacity, listUnscheduled, proposeDay, getConflicts, getBriefing];
