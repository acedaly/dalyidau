// Display pieces shared by the Milestone 3 pages: health badges with their reasons, dashboard cards,
// goal progress and compact task links. Statuses are always text as well as colour.
import type { FC, ReactNode } from "react";
import { AlertTriangle, CheckCircle, InfoCircle, Target04 } from "@untitledui/icons";
import type { BadgeColors } from "@/components/base/badges/badge-types";
import { BadgeWithDot } from "@/components/base/badges/badges";
import { ProgressBar } from "@/components/base/progress-indicators/progress-indicators";
import { FeaturedIcon } from "@/components/foundations/featured-icon/featured-icon";
import { formatNumber } from "@/portal/lib/format";
import { relativeDate, shortDate } from "@/shared/tasks/dates";
import {
    GOAL_STATUS_LABELS,
    type GoalStatus,
    HEALTH_LABELS,
    type HealthReason,
    type HealthStatus,
    type ProjectHealth,
    type TaskGoal,
} from "@/shared/tasks/productivity";
import type { TaskSummary } from "@/shared/tasks/types";
import { cx } from "@/utils/cx";
import { DeadlineBadge, DueBadge, PriorityFlag, ProjectDot, titleOf } from "./shared";
import { useTasks } from "./tasks-context";

export const HEALTH_COLORS: Record<HealthStatus, BadgeColors> = { on_track: "success", needs_attention: "warning", at_risk: "error" };

export const HealthBadge = ({ health, size = "sm" }: { health: Pick<ProjectHealth, "status" | "override">; size?: "sm" | "md" }) => (
    <BadgeWithDot size={size} type="pill-color" color={HEALTH_COLORS[health.status]}>
        {HEALTH_LABELS[health.status]}
        {health.override && <span className="sr-only"> (set by a member)</span>}
    </BadgeWithDot>
);

const REASON_ICONS: Record<HealthReason["level"], FC<{ className?: string }>> = {
    at_risk: AlertTriangle,
    needs_attention: AlertTriangle,
    on_track: CheckCircle,
    info: InfoCircle,
};
const REASON_COLORS: Record<HealthReason["level"], string> = {
    at_risk: "text-fg-error-secondary",
    needs_attention: "text-fg-warning-secondary",
    on_track: "text-fg-success-secondary",
    info: "text-fg-quaternary",
};

/** Why a project has the status it has: each rule that applied, in plain words. */
export const HealthReasons = ({ reasons }: { reasons: HealthReason[] }) => (
    <ul className="flex flex-col gap-1.5 text-sm">
        {reasons.map((r) => {
            const Icon = REASON_ICONS[r.level];
            return (
                <li key={r.text} className="flex items-start gap-2 text-secondary">
                    <Icon aria-hidden="true" className={cx("mt-0.5 size-4 shrink-0", REASON_COLORS[r.level])} />
                    <span>{r.text}</span>
                </li>
            );
        })}
    </ul>
);

const GOAL_COLORS: Record<GoalStatus, BadgeColors> = {
    not_started: "gray",
    in_progress: "brand",
    on_hold: "warning",
    achieved: "success",
    abandoned: "gray",
};

export const GoalStatusBadge = ({ status }: { status: GoalStatus }) => (
    <BadgeWithDot size="sm" type="pill-color" color={GOAL_COLORS[status]}>
        {GOAL_STATUS_LABELS[status]}
    </BadgeWithDot>
);

/** "2,500 of 10,000 $" for manual goals, "3 of 4 tasks" for task-based ones. */
export const goalProgressText = (goal: Pick<TaskGoal, "progress">) => {
    const p = goal.progress;
    if (p.mode === "manual") return `${formatNumber(p.current)} of ${formatNumber(p.target ?? 0)}${p.unit ? ` ${p.unit}` : ""}`;
    return p.total ? `${p.done} of ${p.total} tasks done` : "No linked tasks yet";
};

export const GoalProgress = ({ goal }: { goal: Pick<TaskGoal, "progress" | "title"> }) =>
    goal.progress.percent === null ? (
        <p className="text-sm text-tertiary">{goalProgressText(goal)}</p>
    ) : (
        <ProgressBar
            value={goal.progress.percent}
            labelPosition="right"
            aria-label={`${goal.title}: progress`}
            valueFormatter={() => `${goal.progress.percent}% · ${goalProgressText(goal)}`}
        />
    );

/** A titled card for dashboards and overviews, with an optional count and action. */
export const Card = ({
    title,
    icon,
    count,
    action,
    children,
    className,
    id,
}: {
    title: string;
    icon?: FC<{ className?: string }>;
    count?: number;
    action?: ReactNode;
    children: ReactNode;
    className?: string;
    id?: string;
}) => (
    <section
        aria-labelledby={id}
        className={cx("flex min-w-0 flex-col gap-3 rounded-xl bg-primary p-4 shadow-xs ring-1 ring-secondary ring-inset md:p-5", className)}
    >
        <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
                {icon && <FeaturedIcon icon={icon} color="gray" theme="modern" size="sm" />}
                <h2 id={id} className="truncate text-md font-semibold text-primary">
                    {title}
                    {count !== undefined && <span className="ml-2 text-sm font-medium text-tertiary tabular-nums">{count}</span>}
                </h2>
            </div>
            {action}
        </div>
        {children}
    </section>
);

export const Quiet = ({ children }: { children: ReactNode }) => <p className="text-sm text-tertiary">{children}</p>;

export const MoreLink = ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href} className="self-start rounded-sm text-sm font-semibold text-brand-secondary outline-focus-ring hover:underline focus-visible:outline-2">
        {children}
    </a>
);

/** A task as a single line that opens the task panel: title, project, date, deadline, priority. */
export const TaskLine = ({ task, showProject = true, meta }: { task: TaskSummary; showProject?: boolean; meta?: ReactNode }) => {
    const { openTask, project, today } = useTasks();
    const where = project(task.projectId);
    return (
        <li className="flex flex-wrap items-center gap-x-2 gap-y-1 py-2">
            <button
                type="button"
                onClick={() => openTask(task.id)}
                className={cx(
                    "min-w-0 flex-1 basis-40 cursor-pointer truncate rounded-sm text-left text-sm font-medium text-primary outline-focus-ring hover:underline focus-visible:outline-2",
                    task.status === "completed" && "text-tertiary line-through",
                )}
            >
                {titleOf(task.title)}
            </button>
            {showProject && where && (
                <span className="flex max-w-40 items-center gap-1.5 truncate text-xs text-tertiary">
                    <ProjectDot color={where.color} />
                    <span className="truncate">{where.name}</span>
                </span>
            )}
            <PriorityFlag priority={task.priority} />
            {task.status === "open" && <DueBadge task={task} today={today} />}
            {task.status === "open" && <DeadlineBadge deadline={task.deadline} today={today} />}
            {meta}
        </li>
    );
};

export const TaskLines = ({ tasks, showProject, meta }: { tasks: TaskSummary[]; showProject?: boolean; meta?: (task: TaskSummary) => ReactNode }) => (
    <ul className="divide-y divide-secondary">
        {tasks.map((t) => (
            <TaskLine key={`${t.id}:${t.dueDate}:${t.completedAt}`} task={t} showProject={showProject} meta={meta?.(t)} />
        ))}
    </ul>
);

/** "Target 23 Nov" or "Target passed" for project and goal cards. */
export const TargetText = ({ date, today }: { date: string | null; today: string }) =>
    date ? (
        <span className={cx("inline-flex items-center gap-1 text-xs", date < today ? "text-error-primary" : "text-tertiary")}>
            <Target04 aria-hidden="true" className="size-3.5" />
            {date < today ? `Target passed (${shortDate(date)})` : `Target ${relativeDate(date, today)}`}
        </span>
    ) : null;
