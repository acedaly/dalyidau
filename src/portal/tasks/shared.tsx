// Small display pieces shared by the Tasks pages: priority flags, date and deadline badges, project
// dots and assignee avatars. Priority and dates are always shown as text as well as colour.
import { AlarmClock, Calendar, Flag01, Repeat04, Target04 } from "@untitledui/icons";
import { Avatar } from "@/components/base/avatar/avatar";
import type { BadgeColors } from "@/components/base/badges/badge-types";
import { BadgeWithIcon } from "@/components/base/badges/badges";
import { initials } from "@/portal/lib/format";
import { clockLabel, relativeDate } from "@/shared/tasks/dates";
import { describeRule } from "@/shared/tasks/recurrence";
import { PRIORITY_LABELS, type Priority, type TaskColor, type TaskSummary } from "@/shared/tasks/types";
import { cx } from "@/utils/cx";

/** Priority colours: P1 red, P2 amber, P3 blue, P4 grey, always with the "P1" text beside them.
 *  `text` colours the "P1" label itself, so it uses tokens with at least 4.5:1 on bg-primary and
 *  bg-secondary in both themes (the fg-* and utility-*-500 shades are for icons and fall short). */
export const PRIORITY_COLORS: Record<Priority, { text: string; badge: BadgeColors; ring: string }> = {
    1: { text: "text-error-primary", badge: "error", ring: "ring-fg-error-primary" },
    2: { text: "text-utility-yellow-700", badge: "warning", ring: "ring-fg-warning-primary" },
    3: { text: "text-utility-blue-700", badge: "blue", ring: "ring-utility-blue-500" },
    4: { text: "text-tertiary", badge: "gray", ring: "ring-primary" },
};

export const DOT_COLORS: Record<TaskColor, string> = {
    gray: "bg-utility-neutral-500",
    brand: "bg-utility-brand-500",
    error: "bg-utility-red-500",
    warning: "bg-utility-yellow-500",
    success: "bg-utility-green-500",
    blue: "bg-utility-blue-500",
    indigo: "bg-utility-indigo-500",
    purple: "bg-utility-purple-500",
    pink: "bg-utility-pink-500",
    orange: "bg-utility-orange-500",
};

export const ProjectDot = ({ color, className }: { color: TaskColor; className?: string }) => (
    <span aria-hidden="true" className={cx("inline-block size-2 shrink-0 rounded-full", DOT_COLORS[color], className)} />
);

export const PriorityFlag = ({ priority, showLow = false }: { priority: Priority; showLow?: boolean }) => {
    if (priority === 4 && !showLow) return null;
    const meta = PRIORITY_LABELS[priority];
    return (
        <span
            className={cx("inline-flex items-center gap-1 text-xs font-medium", PRIORITY_COLORS[priority].text)}
            title={`Priority ${meta.short}: ${meta.label}`}
        >
            <Flag01 aria-hidden="true" className="size-3.5" />
            <span>{meta.short}</span>
            <span className="sr-only">priority, {meta.label}</span>
        </span>
    );
};

const dueColor = (date: string, today: string): BadgeColors => (date < today ? "error" : date === today ? "success" : "gray");

/** "Today 5:30 pm", "Overdue: Yesterday", with a repeat icon for repeating tasks. */
export const DueBadge = ({ task, today }: { task: Pick<TaskSummary, "dueDate" | "dueTime" | "recurrence">; today: string }) => {
    if (!task.dueDate) return null;
    const overdue = task.dueDate < today;
    const label = `${relativeDate(task.dueDate, today)}${task.dueTime ? ` ${clockLabel(task.dueTime)}` : ""}`;
    return (
        <BadgeWithIcon type="color" size="sm" color={dueColor(task.dueDate, today)} iconLeading={task.recurrence ? Repeat04 : overdue ? AlarmClock : Calendar}>
            {overdue && <span className="sr-only">Overdue, </span>}
            {label}
            {task.recurrence && <span className="sr-only">, {describeRule(task.recurrence)}</span>}
        </BadgeWithIcon>
    );
};

export const DeadlineBadge = ({ deadline, today }: { deadline: string | null; today: string }) => {
    if (!deadline) return null;
    return (
        <BadgeWithIcon type="color" size="sm" color={deadline < today ? "error" : deadline === today ? "warning" : "gray"} iconLeading={Target04}>
            <span className="sr-only">Deadline </span>
            {relativeDate(deadline, today)}
        </BadgeWithIcon>
    );
};

export const personLabel = (email: string, people: { email: string; name: string | null }[] = []) =>
    people.find((p) => p.email === email)?.name ?? email.split("@")[0];

export const AssigneeAvatar = ({ email, people, size = "xs" }: { email: string; people?: { email: string; name: string | null }[]; size?: "xs" | "sm" }) => {
    const name = personLabel(email, people);
    return (
        <span title={`Assigned to ${name}`} className="inline-flex items-center">
            <Avatar size={size} initials={initials(name)} alt={`Assigned to ${name}`} />
        </span>
    );
};

export const titleOf = (title: string) => title || "Untitled";
