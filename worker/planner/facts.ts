// Daily Planner facts for Chief of Staff (MCP context tools) and Daly Intelligence briefings.
//
// Worked out deterministically by the planner engine, like Calendar's facts: today's planned
// sessions, capacity, free time, conflicts, what's due and not yet planned, and a few suggested
// sessions. Suggestions are only suggestions: nothing is created until the person accepts one in
// the portal (or asks for it through planner_schedule_task). Event titles follow Calendar's rules
// (others' private events "Busy", sensitive ones "Private event"). Every item links to the portal.
import type { D1Database } from "@cloudflare/workers-types";
import { timeLabel } from "../../src/shared/calendar/time";
import type { PortalUser } from "../../src/shared/portal/types";
import { todayFor } from "../calendar/access";
import { dayPlan, suggest } from "./planning";

/** Today's plan, or null for someone who can't open both Calendar and Tasks. */
export async function plannerFacts(db: D1Database, user: PortalUser, site: string) {
    if (!user.permissions.includes("calendar.use") || !user.permissions.includes("tasks.use")) return null;
    return plannerDayFacts(db, user, site, await todayFor(db, user.email));
}

/** Facts for one day. Only for people who can open both Calendar and Tasks. */
export async function plannerDayFacts(db: D1Database, user: PortalUser, site: string, date: string) {
    const plan = await dayPlan(db, user, date);
    const byId = new Map(plan.lists.tasks.map((t) => [t.id, t]));
    const due = plan.lists.buckets.today.concat(plan.lists.buckets.overdue).filter((id, i, a) => a.indexOf(id) === i);
    const unplanned = due.map((id) => byId.get(id)!).filter((t) => t && t.scheduledMinutes === 0);
    const url = `${site}/portal/calendar/planner?date=${date}`;
    const suggestions = date === plan.today ? (await suggest(db, user, { from: date, days: 1 })).suggestions.slice(0, 5) : [];
    return {
        date,
        timeZone: plan.timeZone,
        url,
        capacity: plan.capacity,
        scheduled: plan.blocks.map((b) => ({
            id: b.id,
            taskId: b.taskId,
            title: b.title,
            when: `${timeLabel(b.startTime)} – ${timeLabel(b.endTime === "24:00" ? "23:59" : b.endTime)}`,
            minutes: b.durationMinutes,
            url: `${site}/portal/calendar/planner?date=${b.startDate}&block=${b.id}`,
        })),
        freeTime: {
            minutes: plan.free.reduce((s, f) => s + f.minutes, 0),
            longestMinutes: plan.free.reduce((m, f) => Math.max(m, f.minutes), 0),
            slots: plan.free.slice(0, 8).map((f) => `${timeLabel(f.startTime)} – ${timeLabel(f.endTime)}`),
        },
        conflicts: plan.conflicts.slice(0, 10).map((c) => ({ blockId: c.blockId, kind: c.kind, message: c.message })),
        dueNotPlanned: unplanned.slice(0, 10).map((t) => ({
            id: t.id,
            title: t.title,
            priority: t.priority,
            estimateMinutes: t.estimateMinutes,
            url: `${site}/portal/tasks/t/${t.id}`,
        })),
        suggestedSessions: suggestions.map((s) => ({
            taskId: s.taskId,
            title: s.title,
            when: `${timeLabel(s.startTime)} – ${timeLabel(s.endTime)}`,
            minutes: s.durationMinutes,
            reason: s.reason,
        })),
        note: "Suggested sessions are not scheduled. Nothing in the calendar is moved or created unless the person accepts it.",
    };
}
