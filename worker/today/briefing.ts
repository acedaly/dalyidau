// Today's Chief of Staff briefing: facts from the person's own Portal records, through each
// application's access rules, with a link to every one. Nothing is inferred or invented. There's no
// model here: the recommended next actions come from fixed rules over the facts (src/shared/today/
// engine.ts), and each names the records it's about. Daly Intelligence can explain the day on top of
// this (its daily briefing, where every reference a model returns must be one of the facts), but it
// never supplies tasks, meetings, deadlines or availability.
//
// Event titles follow Calendar's rules for anything an assistant can read: others' private events
// are "Busy" and sensitive ones "Private event".
import type { D1Database } from "@cloudflare/workers-types";
import { addDays, dayLabel, timeLabel, zonedInstant } from "../../src/shared/calendar/time";
import { type PlanTask, planOrder } from "../../src/shared/planner/engine";
import type { PlannerTask } from "../../src/shared/planner/types";
import type { PortalUser } from "../../src/shared/portal/types";
import { hoursLabel, nextActions } from "../../src/shared/today/engine";
import type { BriefingRef, CommitmentItem, DailyReview, TodayBriefing, TodayTask } from "../../src/shared/today/types";
import { blocksBetween } from "../planner/blocks";
import { eventTitle } from "../planner/planning";
import type { planPart } from "./dashboard";

export const TODAY_NOT_CHECKED = ["email", "messages", "bank accounts and finances", "any service outside the Daly Portal"];

const taskRef = (t: Pick<PlannerTask, "id" | "title">, detail?: string): BriefingRef => ({
    id: t.id,
    title: t.title,
    url: `/portal/tasks/t/${t.id}`,
    kind: "task",
    ...(detail ? { detail } : {}),
});

const dueText = (t: Pick<PlannerTask, "dueDate" | "dueTime" | "deadline">, today: string) => {
    const due = [t.deadline, t.dueDate].filter((d): d is string => !!d).sort()[0];
    if (!due) return undefined;
    if (due < today) return `Overdue since ${dayLabel(due)}`;
    if (due === today) return t.dueTime && t.dueDate === today ? `Due today, ${timeLabel(t.dueTime)}` : "Due today";
    return `${t.deadline === due && t.dueDate !== due ? "Deadline" : "Due"} ${dayLabel(due)}`;
};

const toPlanTask = (t: PlannerTask): PlanTask => ({
    id: t.id,
    title: t.title,
    priority: t.priority,
    dueDate: t.dueDate,
    dueTime: t.dueTime,
    deadline: t.deadline,
    occurrenceDate: t.recurring ? t.dueDate : null,
    estimateMinutes: t.estimateMinutes,
    scheduledMinutes: t.scheduledMinutes,
});

/** The person's top three: those they chose in Morning planning, or by the planner's own order. */
export function topPriorities(tasks: readonly PlannerTask[], buckets: Record<string, string[]>, today: string, chosen: readonly string[]) {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const picked = chosen.map((id) => byId.get(id)).filter((t): t is PlannerTask => !!t);
    if (picked.length) return { tasks: picked, chosen: true };
    const candidates = [...new Set([...buckets.overdue, ...buckets.today, ...buckets.priority])].map((id) => byId.get(id)!).filter(Boolean);
    const order = planOrder(candidates.map(toPlanTask), today).map((p) => byId.get(p.id)!);
    return { tasks: order.slice(0, 3), chosen: false };
}

export async function todayBriefing(
    db: D1Database,
    user: PortalUser,
    input: {
        date: string;
        today: string;
        now: number;
        localTime: string;
        plan: Awaited<ReturnType<typeof planPart>>;
        deadlines: TodayTask[];
        family: CommitmentItem[];
        reviews: { morning: DailyReview | null; evening: DailyReview | null };
    },
): Promise<TodayBriefing> {
    const { date, today, plan } = input;
    const { w, lists } = plan;
    const byId = new Map(lists.tasks.map((t) => [t.id, t]));
    const isToday = date === today;

    const occurrences = w.occurrences.filter((o) => o.status !== "cancelled");
    const commitments: (BriefingRef & { start: string })[] = [
        ...occurrences.map((o) => ({
            id: o.id,
            title: eventTitle(o),
            url: `/portal/calendar?view=day&date=${o.startDate}&event=${o.eventId}`,
            kind: "event" as const,
            detail: o.allDay ? "All day" : `${timeLabel(o.startTime ?? "00:00")} – ${timeLabel(o.endTime ?? "23:59")}`,
            start: o.allDay ? zonedInstant(date, "00:00", w.timeZone) : o.start,
        })),
        ...plan.blocks
            .filter((b) => b.startDate === date)
            .map((b) => ({
                id: b.id,
                title: `Planned: ${b.title}`,
                url: `/portal/today?date=${date}&block=${b.id}`,
                kind: "block" as const,
                detail: `${timeLabel(b.startTime)} – ${timeLabel(b.endTime === "24:00" ? "23:59" : b.endTime)}`,
                start: b.start,
            })),
    ].sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));

    const top = topPriorities(lists.tasks, lists.buckets, today, input.reviews.morning?.priorities ?? []);
    const priorities = top.tasks.map((t) => ({
        ...taskRef(
            t,
            [dueText(t, today), `P${t.priority}`, t.scheduledMinutes ? `${hoursLabel(t.scheduledMinutes)} planned` : "Not planned"].filter(Boolean).join(" · "),
        ),
        planned: t.scheduledMinutes > 0,
    }));
    const overdue = lists.buckets.overdue.map((id) => byId.get(id)!).filter(Boolean);
    const conflicts: BriefingRef[] = [
        ...plan.conflicts
            .filter((c) => plan.blocks.some((b) => b.id === c.blockId && b.startDate === date))
            .map((c, i) => ({
                id: `conflict:${c.blockId}:${c.kind}:${i}`,
                title: c.message,
                url: `/portal/today?date=${date}&block=${c.blockId}`,
                kind: "conflict" as const,
            })),
        ...plan.capacity.overbooked.map((o) => ({
            id: `overbooked:${o.start}`,
            title: `Overbooked ${timeLabel(o.startTime)}–${timeLabel(o.endTime)}: ${o.with.map((x) => x.title).join(", ")}`,
            url: `/portal/today?date=${date}#timeline`,
            kind: "conflict" as const,
        })),
    ];

    // Sessions planned yesterday for tasks that are still open: unfinished, until the person decides.
    const yesterday = addDays(date, -1);
    const before = await blocksBetween(db, user, zonedInstant(yesterday, "00:00", w.timeZone), zonedInstant(date, "00:00", w.timeZone), w.timeZone);
    const unfinished = new Map<string, BriefingRef>();
    for (const b of before)
        if (b.startDate === yesterday && b.taskStatus === "open" && !b.earlierOccurrence && Date.parse(b.end) <= input.now && !unfinished.has(b.taskId))
            unfinished.set(b.taskId, { ...taskRef({ id: b.taskId, title: b.title }, `Planned ${timeLabel(b.startTime)} yesterday`), kind: "task" });

    const next = commitments.find((c) => c.kind === "event" && Date.parse(c.start) >= input.now) ?? null;
    const actions = nextActions({
        isToday,
        now: input.now,
        conflicts,
        overdueUnplanned: overdue.filter((t) => t.scheduledMinutes === 0).map((t) => taskRef(t, dueText(t, today))),
        priorities,
        shortfallMinutes: plan.capacity.shortfallMinutes,
        freeMinutes: plan.capacity.freeMinutes,
        nextCommitment: next,
        inboxCount: lists.buckets.inbox.length,
        unfinishedYesterday: [...unfinished.values()],
        morningDone: !!input.reviews.morning,
        eveningDone: !!input.reviews.evening,
        localTime: input.localTime,
    });

    return {
        date,
        generatedAt: new Date(input.now).toISOString(),
        commitments: commitments.map(({ start: _start, ...c }) => c).slice(0, 15),
        priorities: priorities.map(({ planned: _planned, ...p }) => p),
        overdue: overdue.slice(0, 10).map((t) => taskRef(t, dueText(t, today))),
        conflicts: conflicts.slice(0, 10),
        capacity: {
            availableMinutes: plan.capacity.availableMinutes,
            committedMinutes: plan.capacity.committedMinutes,
            freeMinutes: plan.capacity.freeMinutes,
            shortfallMinutes: plan.capacity.shortfallMinutes,
            status: plan.capacity.status,
        },
        projectDeadlines: input.deadlines.slice(0, 8).map((t) => ({
            id: t.id,
            title: t.title,
            url: `/portal/tasks/t/${t.id}`,
            kind: "task" as const,
            detail: [dueText(t, today), t.projectName, t.isMilestone ? "Milestone" : null].filter(Boolean).join(" · "),
        })),
        family: input.family
            .slice(0, 8)
            .map((f) => ({
                id: f.id,
                title: f.title,
                url: f.url,
                kind: "event" as const,
                detail: `${f.date === date ? "Today" : dayLabel(f.date)}, ${f.when} · ${f.calendarName}`,
            })),
        unfinishedYesterday: [...unfinished.values()].slice(0, 10),
        nextActions: actions,
        notChecked: TODAY_NOT_CHECKED,
    };
}
