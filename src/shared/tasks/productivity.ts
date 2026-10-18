// Daly Tasks, Milestone 3: shapes and rules shared by the Worker and the browser for dashboards,
// project health and reviews, goals, routines, workload and reports.
//
// Every judgement here is a fixed, documented rule over counts and dates (docs/TASKS_PROJECTS.md
// lists them): there's no scoring model, nothing is learned, and each status comes with the reasons
// that produced it, so a person can always see why a project or goal is flagged.
import { z } from "zod";
import { addDays, isCalendarDate, shortDate, weekStart } from "./dates";
import { addMonths, daysBetween } from "./recurrence";
import type { Priority, ProjectRole, TaskColor, TaskSummary } from "./types";

// --- Project health ------------------------------------------------------------------------------

export const HEALTH_STATUSES = ["on_track", "needs_attention", "at_risk"] as const;
export type HealthStatus = (typeof HEALTH_STATUSES)[number];
export const HEALTH_LABELS: Record<HealthStatus, string> = { on_track: "On track", needs_attention: "Needs attention", at_risk: "At risk" };

/** The thresholds behind the health rules, named so the documentation and tests can quote them. */
export const HEALTH_RULES = {
    /** A target this close (days) with less than half the work done is at risk. */
    riskTargetDays: 14,
    riskDoneBelow: 0.5,
    /** This many overdue tasks, or more than this share of open tasks overdue (with at least two), is at risk. */
    riskOverdue: 5,
    riskOverdueShare: 1 / 3,
    /** A target this close (days) with less than three quarters done needs attention. */
    attentionTargetDays: 30,
    attentionDoneBelow: 0.75,
    /** No activity for this many days while tasks are open needs attention. */
    quietDays: 30,
} as const;

/** Deterministic numbers about one project, as one member sees it (every count respects membership). */
export interface ProjectMetrics {
    /** Open and completed tasks and subtasks, as in the project's progress bar. */
    open: number;
    completed: number;
    /** Open tasks past their due date or deadline. */
    overdue: number;
    /** Open tasks due or with a deadline in the next seven days (today included). */
    dueSoon: number;
    /** Open top-level tasks without an assignee: shared projects only (personal projects have none). */
    unassigned: number | null;
    /** Open top-level tasks with neither a due date nor a deadline. */
    undated: number;
    /** Open milestones dated in the next 30 days. */
    upcomingMilestones: number;
    /** Tasks completed in the last 14 days. */
    completedRecently: number;
    lastActivityAt: string | null;
    startDate: string | null;
    targetDate: string | null;
    review: ReviewSchedule;
}

export const REVIEW_FREQUENCIES = ["none", "weekly", "fortnightly", "monthly"] as const;
export type ReviewFrequency = (typeof REVIEW_FREQUENCIES)[number];
export const REVIEW_FREQUENCY_LABELS: Record<ReviewFrequency, string> = {
    none: "On demand",
    weekly: "Every week",
    fortnightly: "Every fortnight",
    monthly: "Every month",
};

export interface ReviewSchedule {
    frequency: ReviewFrequency;
    /** The local date of the latest completed review, if any. */
    lastReviewedOn: string | null;
    /** When the next one is due (null for on-demand reviews). */
    nextDue: string | null;
    due: boolean;
}

/**
 * When the next review is due: one period after the last completed review, or after the project was
 * created if it's never been reviewed. On-demand reviews are never due.
 */
export function reviewSchedule(frequency: ReviewFrequency, lastReviewedOn: string | null, createdOn: string, today: string): ReviewSchedule {
    if (frequency === "none") return { frequency, lastReviewedOn, nextDue: null, due: false };
    const from = lastReviewedOn ?? createdOn;
    const nextDue = frequency === "weekly" ? addDays(from, 7) : frequency === "fortnightly" ? addDays(from, 14) : addMonths(from, 1);
    return { frequency, lastReviewedOn, nextDue, due: nextDue <= today };
}

export interface HealthReason {
    /** Which status this reason supports; "info" reasons explain a project that's on track. */
    level: HealthStatus | "info";
    text: string;
}

export interface ProjectHealth {
    /** What's shown: the manual status if one is set, otherwise the calculated one. */
    status: HealthStatus;
    calculated: HealthStatus;
    reasons: HealthReason[];
    override: { status: HealthStatus; note: string | null; by: string | null; at: string | null } | null;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The calculated health of an active project. At risk if any risk rule holds, otherwise needs
 * attention if any attention rule holds, otherwise on track. A project with no open tasks is never
 * "on track" just because nothing is late: it needs next steps or to be marked completed.
 */
export function calculateHealth(m: ProjectMetrics, today: string): { status: HealthStatus; reasons: HealthReason[] } {
    const reasons: HealthReason[] = [];
    const total = m.open + m.completed;
    const done = total ? m.completed / total : 0;
    const pct = Math.round(done * 100);
    const daysLeft = m.targetDate ? daysBetween(today, m.targetDate) : null;
    const R = HEALTH_RULES;

    if (m.open > 0 && daysLeft !== null && daysLeft < 0)
        reasons.push({ level: "at_risk", text: `The target date (${shortDate(m.targetDate!)}) has passed with ${plural(m.open, "task")} open` });
    else if (m.open > 0 && daysLeft !== null && daysLeft <= R.riskTargetDays && done < R.riskDoneBelow)
        reasons.push({ level: "at_risk", text: `The target is ${daysLeft === 0 ? "today" : `in ${plural(daysLeft, "day")}`} and ${pct}% of tasks are done` });
    if (m.overdue >= R.riskOverdue || (m.overdue >= 2 && m.open > 0 && m.overdue / m.open > R.riskOverdueShare))
        reasons.push({ level: "at_risk", text: `${plural(m.overdue, "task")} overdue (of ${m.open} open)` });

    if (!reasons.length) {
        if (m.overdue > 0) reasons.push({ level: "needs_attention", text: `${plural(m.overdue, "task")} overdue` });
        if (m.open > 0 && daysLeft !== null && daysLeft <= R.attentionTargetDays && done < R.attentionDoneBelow)
            reasons.push({ level: "needs_attention", text: `The target is in ${plural(daysLeft, "day")} and ${pct}% of tasks are done` });
        if (m.review.due && m.review.nextDue)
            reasons.push({ level: "needs_attention", text: `A review was due ${m.review.nextDue === today ? "today" : `on ${shortDate(m.review.nextDue)}`}` });
        if (m.open > 0 && (!m.lastActivityAt || daysBetween(m.lastActivityAt.slice(0, 10), today) > R.quietDays))
            reasons.push({ level: "needs_attention", text: `No activity for more than ${R.quietDays} days` });
        if (m.open === 0) reasons.push({ level: "needs_attention", text: "No open tasks: add the next steps, or mark the project completed" });
    }

    const status: HealthStatus = reasons.some((r) => r.level === "at_risk")
        ? "at_risk"
        : reasons.some((r) => r.level === "needs_attention")
          ? "needs_attention"
          : "on_track";
    if (status === "on_track") {
        reasons.push({ level: "info", text: `Nothing overdue · ${pct}% of ${plural(total, "task")} done` });
        if (daysLeft !== null) reasons.push({ level: "info", text: `Target in ${plural(daysLeft, "day")}` });
    }
    if (m.unassigned) reasons.push({ level: "info", text: `${plural(m.unassigned, "open task")} not assigned to anyone` });
    if (m.undated) reasons.push({ level: "info", text: `${plural(m.undated, "open task")} without a date` });
    return { status, reasons };
}

// --- Project reviews -----------------------------------------------------------------------------

/** The numbers recorded when a review is completed: counts only, never titles. */
export interface ReviewSnapshot {
    open: number;
    completed: number;
    overdue: number;
    completedSince: number;
    unassigned: number | null;
    undated: number;
    health: HealthStatus;
}

export interface ProjectReview {
    id: string;
    projectId: string;
    status: "draft" | "completed";
    note: string;
    health: HealthStatus | null;
    periodStart: string | null;
    snapshot: ReviewSnapshot | null;
    startedBy: string;
    startedAt: string;
    completedBy: string | null;
    completedAt: string | null;
    version: number;
    /** Next actions created from this review, as the reader can see them now. */
    actions: TaskSummary[];
}

/** Everything a review needs on one screen. */
export interface ReviewWorkspace {
    review: ProjectReview;
    health: ProjectHealth;
    metrics: ProjectMetrics;
    /** Completed since the previous review (at most 50, newest first). */
    completedSince: TaskSummary[];
    completedSinceCount: number;
    overdue: TaskSummary[];
    /** Open milestones and deadlines in the next 30 days. */
    upcoming: TaskSummary[];
    /** Open top-level tasks with nobody responsible or no date: the unresolved commitments. */
    unresolved: TaskSummary[];
}

// --- Goals ---------------------------------------------------------------------------------------

export const GOAL_STATUSES = ["not_started", "in_progress", "on_hold", "achieved", "abandoned"] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];
export const GOAL_STATUS_LABELS: Record<GoalStatus, string> = {
    not_started: "Not started",
    in_progress: "In progress",
    on_hold: "On hold",
    achieved: "Achieved",
    abandoned: "Abandoned",
};
export const ACTIVE_GOAL_STATUSES: readonly GoalStatus[] = ["not_started", "in_progress"];

export interface GoalMilestone {
    id: string;
    title: string;
    targetDate: string | null;
    doneAt: string | null;
    doneBy: string | null;
}

export interface GoalProgressEvent {
    id: number;
    kind: "created" | "value" | "status" | "milestone" | "update" | "member" | "link";
    value: number | null;
    status: GoalStatus | null;
    note: string;
    at: string;
    by: string;
    byName: string | null;
}

export interface GoalProgress {
    mode: "tasks" | "manual";
    /** 0–100, or null when there's nothing to measure yet (no linked tasks you can see). */
    percent: number | null;
    /** Task mode: linked tasks the reader can see, open and done. */
    done: number;
    total: number;
    /** Manual mode. */
    unit: string | null;
    start: number;
    current: number;
    target: number | null;
}

export interface TaskGoal {
    id: string;
    kind: "personal" | "shared";
    title: string;
    description: string;
    status: GoalStatus;
    role: ProjectRole;
    targetDate: string | null;
    achievedAt: string | null;
    archivedAt: string | null;
    progress: GoalProgress;
    milestones: { done: number; total: number; next: GoalMilestone | null };
    memberCount: number;
    version: number;
    createdAt: string;
    updatedAt: string;
    /** Why it's flagged on the dashboard, if it is. */
    attention: string | null;
}

export interface GoalDetail {
    goal: TaskGoal;
    members: { email: string; name: string | null; role: ProjectRole }[];
    milestones: GoalMilestone[];
    history: GoalProgressEvent[];
    /** Linked projects and tasks the reader can see; links to anything else are left out entirely. */
    projects: { id: string; linkId: string; name: string; color: TaskColor; kind: "personal" | "shared"; open: number; completed: number }[];
    tasks: (TaskSummary & { linkId: string })[];
    /** Open linked tasks (direct or in linked projects) with the soonest dates: "what's next". */
    next: TaskSummary[];
    knowledge: ({ linkId: string; available: true; objectId: string; title: string; spaceName: string } | { linkId: string; available: false })[];
}

/** Percent of a manual goal: how far the current value has moved from the start towards the target, 0–100. */
export const manualPercent = (start: number, current: number, target: number | null) => {
    if (target === null || target === start) return null;
    return Math.max(0, Math.min(100, Math.round(((current - start) / (target - start)) * 100)));
};

/**
 * Why an active goal needs attention, or null: its target date has passed, or it's within 14 days
 * and not complete, or it hasn't started and its target is within 30 days.
 */
export function goalAttention(goal: Pick<TaskGoal, "status" | "targetDate"> & { percent: number | null }, today: string): string | null {
    if (!ACTIVE_GOAL_STATUSES.includes(goal.status) || !goal.targetDate) return null;
    const days = daysBetween(today, goal.targetDate);
    if (days < 0) return `Target date passed (${shortDate(goal.targetDate)})`;
    if (days <= 14 && (goal.percent ?? 0) < 100) return `Target ${days === 0 ? "today" : `in ${plural(days, "day")}`}, ${goal.percent ?? 0}% there`;
    if (goal.status === "not_started" && days <= 30) return `Not started, target in ${plural(days, "day")}`;
    return null;
}

const calendarDate = z.string().refine(isCalendarDate, "Use a real date (YYYY-MM-DD)");
const finite = z.number().finite().min(-1e12).max(1e12);
export const goalFields = {
    title: z.string().trim().min(1, "Give the goal a title").max(200),
    description: z.string().trim().max(4000),
    targetDate: calendarDate.nullable(),
    progressMode: z.enum(["tasks", "manual"]),
    unit: z.string().trim().min(1).max(20).nullable(),
    startValue: finite,
    targetValue: finite.nullable(),
};

// --- Routines ------------------------------------------------------------------------------------

export const ROTATIONS = ["none", "turns"] as const;
export type Rotation = (typeof ROTATIONS)[number];
export const ROTATION_LABELS: Record<Rotation, string> = { none: "Same person each time", turns: "Take turns" };

export interface RoutineCompletion {
    kind: "completed" | "skipped";
    occurrenceDate: string | null;
    at: string;
    by: string;
    byName: string | null;
}

export interface TaskRoutine {
    id: string;
    task: TaskSummary;
    project: { id: string; name: string; kind: "personal" | "shared"; isInbox: boolean; color: TaskColor };
    rotation: Rotation;
    /** In turn order. Only people who can be assigned the task. */
    participants: { email: string; name: string | null }[];
    /** Who is responsible for the current occurrence (the task's assignee), and who's next if turns are taken. */
    responsible: string | null;
    nextUp: string | null;
    paused: boolean;
    pausedAt: string | null;
    canEdit: boolean;
    version: number;
    /** The latest completions and skips, newest first (at most 5). */
    recent: RoutineCompletion[];
}

/** Who takes the next turn after `current`: the next participant in order, wrapping round; the first if `current` isn't one. */
export const nextInTurn = (participants: string[], current: string | null): string | null => {
    if (!participants.length) return null;
    const at = current ? participants.findIndex((p) => p.toLowerCase() === current.toLowerCase()) : -1;
    return participants[(at + 1) % participants.length];
};

// --- Dashboard -----------------------------------------------------------------------------------

export const DASHBOARD_CARDS = ["focus", "week", "projects", "goals", "milestones", "routines", "reviews", "done"] as const;
export type DashboardCard = (typeof DASHBOARD_CARDS)[number];
export const DASHBOARD_CARD_LABELS: Record<DashboardCard, string> = {
    focus: "Today and overdue",
    week: "Next seven days",
    projects: "Projects",
    goals: "Goals",
    milestones: "Milestones",
    routines: "Routines",
    reviews: "Reviews due",
    done: "Recently completed",
};
export const HOUSEHOLD_FILTERS = ["all", "mine", "others", "unassigned"] as const;
export type HouseholdFilter = (typeof HOUSEHOLD_FILTERS)[number];
export const HOUSEHOLD_FILTER_LABELS: Record<HouseholdFilter, string> = {
    all: "All shared tasks",
    mine: "Assigned to me",
    others: "Assigned to someone else",
    unassigned: "Unassigned",
};

export const dashboardPreferences = z
    .object({
        tab: z.enum(["personal", "household"]).optional(),
        hidden: z.array(z.enum(DASHBOARD_CARDS)).max(DASHBOARD_CARDS.length).optional(),
        household: z.enum(HOUSEHOLD_FILTERS).optional(),
    })
    .strict();
export type DashboardPreferences = z.infer<typeof dashboardPreferences>;

/** A count and the first few items behind it. */
export interface Bucket {
    count: number;
    tasks: TaskSummary[];
}

export interface ProjectCard {
    id: string;
    name: string;
    color: TaskColor;
    kind: "personal" | "shared";
    open: number;
    completed: number;
    overdue: number;
    targetDate: string | null;
    health: ProjectHealth;
}

export interface PersonalDashboard {
    dueToday: Bucket;
    overdue: Bucket;
    next7: Bucket;
    /** Undated tasks still sitting in the Inbox: captured but not yet sorted. */
    inbox: Bucket;
    highPriority: Bucket;
    completedRecently: Bucket;
    projects: ProjectCard[];
    goals: TaskGoal[];
    milestones: TaskSummary[];
    routines: TaskRoutine[];
    reviewsDue: { projectId: string; name: string; due: string }[];
}

export interface HouseholdDashboard {
    filter: HouseholdFilter;
    /** Shared projects the caller is a member of. Nothing else is counted. */
    projectCount: number;
    attention: Bucket;
    upcoming: Bucket;
    /** Open shared tasks per person they're assigned to (and nobody), in the caller's shared projects. */
    byAssignee: { email: string | null; name: string | null; open: number; overdue: number }[];
    /** Open shared tasks with a deadline: the household's commitments. */
    commitments: Bucket;
    routines: TaskRoutine[];
    projects: ProjectCard[];
    goals: TaskGoal[];
    completedRecently: Bucket;
}

// --- Workload and timeline -----------------------------------------------------------------------

export const WORKLOAD_RULES = {
    /** High priority means P1 or P2. This many due on one day is flagged. */
    highPriorityPerDay: 3,
    /** This many tasks due on one day is flagged. */
    tasksPerDay: 8,
    /** This many overdue tasks is flagged. */
    overdue: 3,
    /** A project target within this many days with at least `projectOpen` open tasks is flagged. */
    projectDays: 14,
    projectOpen: 5,
} as const;

export const WORKLOAD_GROUPS = ["day", "week", "project", "priority", "assignee"] as const;
export type WorkloadGroup = (typeof WORKLOAD_GROUPS)[number];
export const WORKLOAD_GROUP_LABELS: Record<WorkloadGroup, string> = {
    day: "Day",
    week: "Week",
    project: "Project",
    priority: "Priority",
    assignee: "Person",
};

export interface WorkloadWarning {
    kind: "priority_day" | "busy_day" | "overdue" | "project_deadline";
    text: string;
    date?: string;
    projectId?: string;
}

export interface Workload {
    scope: "mine" | "shared";
    from: string;
    to: string;
    weeks: number;
    /** Open tasks due in the window, with later repeats projected (marked `projected`). */
    tasks: TaskSummary[];
    overdue: Bucket;
    undated: Bucket;
    summary: { thisWeek: number; nextWeek: number; highPriority: number; deadlines: number; projected: number };
    warnings: WorkloadWarning[];
    people: { email: string; name: string | null }[];
    /** True when the window held more tasks than are shown (WORKLOAD_TASK_LIMIT). */
    truncated: boolean;
}

/** At most this many tasks (including projected repeats) are shown in one workload window. */
export const WORKLOAD_TASK_LIMIT = 600;

/** The transparent workload warnings: fixed thresholds over counts, never an estimate of effort. */
export function workloadWarnings(
    tasks: Pick<TaskSummary, "dueDate" | "priority">[],
    overdue: number,
    projects: { id: string; name: string; targetDate: string | null; open: number }[],
    today: string,
): WorkloadWarning[] {
    const W = WORKLOAD_RULES;
    const warnings: WorkloadWarning[] = [];
    if (overdue >= W.overdue) warnings.push({ kind: "overdue", text: `${plural(overdue, "task")} overdue` });
    const byDay = new Map<string, { all: number; high: number }>();
    for (const t of tasks) {
        if (!t.dueDate) continue;
        const day = byDay.get(t.dueDate) ?? { all: 0, high: 0 };
        day.all++;
        if (t.priority <= 2) day.high++;
        byDay.set(t.dueDate, day);
    }
    for (const [date, day] of [...byDay].sort(([a], [b]) => a.localeCompare(b))) {
        if (day.high >= W.highPriorityPerDay) warnings.push({ kind: "priority_day", date, text: `${day.high} high-priority tasks due ${shortDate(date)}` });
        else if (day.all >= W.tasksPerDay) warnings.push({ kind: "busy_day", date, text: `${day.all} tasks due ${shortDate(date)}` });
    }
    for (const p of projects) {
        if (!p.targetDate || p.open < W.projectOpen) continue;
        const days = daysBetween(today, p.targetDate);
        if (days >= 0 && days <= W.projectDays)
            warnings.push({
                kind: "project_deadline",
                projectId: p.id,
                text: `${p.name}: target ${days === 0 ? "today" : `in ${plural(days, "day")}`} with ${p.open} tasks open`,
            });
    }
    return warnings;
}

export interface TimelineItem {
    kind: "start" | "target" | "milestone" | "deadline" | "due" | "review" | "next_review";
    date: string;
    label: string;
    task?: TaskSummary;
    done?: boolean;
}

export interface ProjectTimeline {
    from: string;
    to: string;
    items: TimelineItem[];
    /** True when more dated tasks exist than were shown. */
    truncated: boolean;
}

// --- Reports -------------------------------------------------------------------------------------

export const REPORT_RANGES = { "4w": 28, "12w": 84, "6m": 182, "12m": 365 } as const;
export type ReportRange = keyof typeof REPORT_RANGES;
export const REPORT_RANGE_LABELS: Record<ReportRange, string> = {
    "4w": "Last 4 weeks",
    "12w": "Last 12 weeks",
    "6m": "Last 6 months",
    "12m": "Last 12 months",
};

export interface ReportBucket {
    /** The first local date of the week (Monday) or month. */
    start: string;
    completed: number;
    /** Completed after their due date (or the occurrence's date). */
    late: number;
    skipped: number;
}

export interface TasksReport {
    scope: "personal" | "shared";
    range: ReportRange;
    from: string;
    to: string;
    grouping: "week" | "month";
    buckets: ReportBucket[];
    totals: { completed: number; late: number; skipped: number; open: number; overdue: number };
    byProject: { projectId: string; name: string; color: TaskColor; completed: number }[];
    openByPriority: Record<Priority, number>;
    /** Repeating tasks: how many occurrences were completed and skipped in the range. */
    recurring: { taskId: string; title: string; completed: number; skipped: number; isRoutine: boolean }[];
    /** Shared only: open tasks per person they're assigned to. A spread of work, not a measure of anyone. */
    assigned: { email: string | null; name: string | null; open: number }[];
    goals: TaskGoal[];
    /** True if the range held more completions than a report reads (REPORT_ROW_LIMIT). */
    truncated: boolean;
}

/** At most this many completions are read for one report. */
export const REPORT_ROW_LIMIT = 20_000;

/** The bucket a local date falls in: its Monday, or the 1st of its month. */
export const bucketStart = (date: string, grouping: "week" | "month") => (grouping === "week" ? weekStart(date) : `${date.slice(0, 7)}-01`);
