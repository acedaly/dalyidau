// Today's sections: capacity, the timeline, what needs attention, upcoming deadlines, commitments,
// notifications and the Chief of Staff briefing. Each shows what the Worker worked out from the
// person's records; nothing here calculates availability or invents an item. Untitled UI parts
// throughout (Badge, Button, Dropdown, MetricCard, Notice), in the Calendar's Card frame.
import { useState } from "react";
import {
    AlertTriangle,
    Bell01,
    Calendar,
    CalendarCheck01,
    CalendarPlus02,
    CheckCircle,
    Clock,
    Flag01,
    Lock01,
    Stars02,
    Sunrise,
    Users01,
    X,
} from "@untitledui/icons";
import { Badge, BadgeWithDot } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Dropdown } from "@/components/base/dropdown/dropdown";
import { durationLabel } from "@/portal/calendar/planner-api";
import { Card } from "@/portal/calendar/shared";
import { Notice } from "@/portal/components/notice";
import { intelligenceApi } from "@/portal/intelligence/api";
import { errorMessage } from "@/portal/lib/api";
import { dayLabel, timeLabel } from "@/shared/calendar/time";
import type { BriefingView } from "@/shared/intelligence/types";
import type { PlannerTask, TimeBlockInfo } from "@/shared/planner/types";
import type {
    BriefingRef,
    CommitmentItem,
    DayTimeline,
    TimelineItem,
    TodayBriefing,
    TodayCapacity,
    TodayNotification,
    TodayPreferences,
    TodayTask,
} from "@/shared/today/types";
import { cx } from "@/utils/cx";

export const STATUS: Record<TodayCapacity["status"], { label: string; color: "gray" | "success" | "brand" | "warning" | "error" }> = {
    off: { label: "Day off", color: "gray" },
    light: { label: "Light day", color: "success" },
    balanced: { label: "Balanced", color: "brand" },
    full: { label: "Full", color: "warning" },
    over: { label: "Overbooked", color: "error" },
};

const clock = (t: string) => timeLabel(t === "24:00" ? "23:59" : t);

// --- Capacity ------------------------------------------------------------------------------------

export const CapacitySection = ({ capacity }: { capacity: TodayCapacity }) => {
    const total = Math.max(1, capacity.availableMinutes);
    const pct = (m: number) => `${Math.min(100, (m / total) * 100)}%`;
    return (
        <Card
            title="Capacity"
            description={capacity.offReason ? `No planning hours: ${capacity.offReason}.` : "Your planning hours, what's committed and what's left."}
            actions={
                <BadgeWithDot size="sm" type="modern" color={STATUS[capacity.status].color}>
                    {STATUS[capacity.status].label}
                </BadgeWithDot>
            }
        >
            {/* One compact row of figures rather than a card each. */}
            <div className="@container">
                <dl className="grid grid-cols-2 gap-x-4 gap-y-3 @xl:grid-cols-4">
                    {[
                        {
                            label: "Available",
                            icon: Clock,
                            value: capacity.availableMinutes,
                            detail: capacity.breakMinutes ? `After ${durationLabel(capacity.breakMinutes)} of breaks` : "After leave and holidays",
                        },
                        { label: "Appointments", icon: Calendar, value: capacity.appointmentMinutes, detail: "Overlaps counted once" },
                        {
                            label: "Task time",
                            icon: CalendarCheck01,
                            value: capacity.taskMinutes,
                            detail: `Limit ${durationLabel(capacity.focusLimitMinutes)} a day`,
                        },
                        {
                            label: "Free",
                            icon: Stars02,
                            value: capacity.freeMinutes,
                            detail: capacity.unscheduledMinutes
                                ? `${durationLabel(capacity.unscheduledMinutes)} of due work unplanned`
                                : "Nothing due left to plan",
                        },
                    ].map((m) => (
                        <div key={m.label} className="flex min-w-0 flex-col gap-0.5">
                            <dt className="flex items-center gap-1.5 text-sm text-tertiary">
                                <m.icon aria-hidden="true" className="size-4 text-fg-quaternary" />
                                {m.label}
                            </dt>
                            <dd className="text-lg font-semibold text-primary">{durationLabel(m.value)}</dd>
                            <dd className="text-xs text-tertiary">{m.detail}</dd>
                        </div>
                    ))}
                </dl>
            </div>
            {capacity.availableMinutes > 0 && (
                <div
                    role="img"
                    aria-label={`${durationLabel(capacity.appointmentMinutes)} appointments, ${durationLabel(capacity.taskMinutes)} tasks, ${durationLabel(capacity.freeMinutes)} free`}
                    className="flex h-2.5 w-full overflow-hidden rounded-full bg-quaternary"
                >
                    <span className="h-full bg-fg-brand-primary" style={{ width: pct(capacity.appointmentMinutes) }} />
                    <span className="h-full bg-fg-success-secondary" style={{ width: pct(capacity.taskMinutes) }} />
                </div>
            )}
            {capacity.availableMinutes > 0 && (
                <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-tertiary">
                    <span className="flex items-center gap-1.5">
                        <span aria-hidden="true" className="size-2 rounded-full bg-fg-brand-primary" /> Appointments
                    </span>
                    <span className="flex items-center gap-1.5">
                        <span aria-hidden="true" className="size-2 rounded-full bg-fg-success-secondary" /> Task time
                    </span>
                    <span className="flex items-center gap-1.5">
                        <span aria-hidden="true" className="size-2 rounded-full bg-quaternary" /> Free
                    </span>
                </p>
            )}
            {(capacity.overbooked.length > 0 || capacity.shortfallMinutes > 0) && (
                <Notice color="warning" title={capacity.overbooked.length ? "Overbooked" : "More due than there's time for"}>
                    {capacity.overbooked.map((o) => `${clock(o.startTime)}–${clock(o.endTime)}: ${o.with.map((w) => w.title).join(", ")}`).join("; ")}
                    {capacity.overbooked.length > 0 && capacity.shortfallMinutes > 0 && ". "}
                    {capacity.shortfallMinutes > 0 &&
                        `${durationLabel(capacity.shortfallMinutes)} of work due doesn't fit. Postpone something, or plan it on another day.`}
                </Notice>
            )}
            <details className="group text-sm">
                <summary className="cursor-pointer rounded-sm font-medium text-brand-secondary outline-focus-ring focus-visible:outline-2">
                    How this was worked out
                </summary>
                <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-tertiary">
                    {capacity.explanation.map((line) => (
                        <li key={line}>{line}</li>
                    ))}
                </ul>
            </details>
        </Card>
    );
};

// --- Timeline ------------------------------------------------------------------------------------

const KIND: Record<TimelineItem["kind"], { label: string; bar: string }> = {
    event: { label: "Fixed", bar: "bg-fg-brand-primary" },
    block: { label: "Task time", bar: "bg-fg-success-secondary" },
    break: { label: "Break", bar: "bg-fg-quaternary" },
    leave: { label: "Unavailable", bar: "bg-fg-warning-secondary" },
    focus: { label: "Focus period", bar: "bg-fg-brand-secondary" },
    free: { label: "Free", bar: "bg-quaternary" },
};

export const TimelineList = ({
    timeline,
    blocks,
    unscheduled,
    onOpenBlock,
    onPlanAt,
}: {
    timeline: DayTimeline;
    blocks: TimeBlockInfo[];
    /** Tasks that can go into a free slot. */
    unscheduled: PlannerTask[];
    onOpenBlock: (block: TimeBlockInfo) => void;
    onPlanAt: (task: PlannerTask, time: string) => void;
}) => {
    const byBlock = new Map(blocks.map((b) => [b.id, b]));
    if (!timeline.items.length && !timeline.allDay.length)
        return <p className="text-sm text-tertiary">{timeline.hours.length ? "Nothing planned yet." : "No planning hours and nothing on this day."}</p>;
    return (
        <div className="flex flex-col gap-3">
            {timeline.allDay.length > 0 && (
                <ul aria-label="All day" className="flex flex-wrap gap-2">
                    {timeline.allDay.map((a) => (
                        <li key={a.id}>
                            <Badge size="md" color={a.kind === "leave" ? "warning" : a.kind === "holiday" ? "gray" : "brand"}>
                                {a.url ? (
                                    <a href={a.url} className="rounded-sm outline-focus-ring hover:underline focus-visible:outline-2">
                                        {a.title}
                                    </a>
                                ) : (
                                    a.title
                                )}
                                <span className="sr-only">, all day</span>
                            </Badge>
                        </li>
                    ))}
                </ul>
            )}
            <ol aria-label="Timeline" className="flex flex-col gap-1.5">
                {timeline.items.map((item) => {
                    const block = item.kind === "block" ? byBlock.get(item.id) : undefined;
                    return (
                        <li
                            key={item.id}
                            data-timeline={item.kind}
                            data-movable={item.movable || undefined}
                            className={cx(
                                "flex items-stretch gap-3 rounded-lg px-3 py-2 ring-1 ring-inset",
                                item.kind === "free" || item.kind === "focus" ? "bg-secondary_subtle ring-secondary" : "bg-primary ring-secondary",
                                item.conflict && "ring-error_subtle",
                            )}
                        >
                            <span aria-hidden="true" className={cx("w-1 shrink-0 rounded-full", KIND[item.kind].bar)} />
                            <div className="w-24 shrink-0 text-xs text-tertiary tabular-nums sm:w-28">
                                <span className="block font-medium text-secondary">{clock(item.startTime)}</span>
                                <span>to {clock(item.endTime)}</span>
                            </div>
                            <div className="flex min-w-0 flex-1 flex-col gap-1">
                                <div className="flex flex-wrap items-center gap-2">
                                    {item.url && item.kind !== "free" ? (
                                        <a
                                            href={item.url}
                                            className="truncate text-sm font-medium text-primary outline-focus-ring hover:underline focus-visible:outline-2"
                                        >
                                            {item.title}
                                        </a>
                                    ) : (
                                        <span className={cx("text-sm font-medium", item.kind === "free" ? "text-tertiary" : "text-primary")}>{item.title}</span>
                                    )}
                                    <Badge size="sm" color={item.kind === "block" ? "success" : item.kind === "event" ? "brand" : "gray"}>
                                        {item.kind === "block" ? (item.movable ? "Movable" : "Task time") : KIND[item.kind].label}
                                    </Badge>
                                    {item.readOnly && item.kind === "event" && (
                                        <Badge size="sm" color="gray">
                                            <Lock01 aria-hidden="true" className="mr-1 size-3" />
                                            Read-only
                                        </Badge>
                                    )}
                                    {item.shared && (
                                        <Badge size="sm" color="gray">
                                            <Users01 aria-hidden="true" className="mr-1 size-3" />
                                            Shared
                                        </Badge>
                                    )}
                                    {item.conflict && (
                                        <Badge size="sm" color="error">
                                            <AlertTriangle aria-hidden="true" className="mr-1 size-3" />
                                            Conflict
                                        </Badge>
                                    )}
                                </div>
                                <span className="text-xs text-tertiary">
                                    {durationLabel(item.minutes)}
                                    {item.detail && ` · ${item.detail}`}
                                </span>
                            </div>
                            <div className="flex shrink-0 items-start gap-1">
                                {block && (
                                    <Button size="xs" color="secondary" onClick={() => onOpenBlock(block)} aria-label={`Adjust ${block.title}`}>
                                        {item.movable ? "Move or resize" : "Open"}
                                    </Button>
                                )}
                                {item.kind === "free" && unscheduled.length > 0 && item.minutes >= 15 && (
                                    <Dropdown.Root>
                                        <Button size="xs" color="secondary" iconLeading={CalendarPlus02} aria-label={`Plan a task at ${clock(item.startTime)}`}>
                                            <span className="max-sm:sr-only">Plan a task</span>
                                        </Button>
                                        <Dropdown.Popover className="w-72">
                                            <Dropdown.Menu
                                                onAction={(key) => {
                                                    const task = unscheduled.find((t) => t.id === key);
                                                    if (task) onPlanAt(task, item.startTime);
                                                }}
                                            >
                                                {unscheduled.slice(0, 10).map((t) => (
                                                    <Dropdown.Item
                                                        key={t.id}
                                                        id={t.id}
                                                        label={t.title}
                                                        addon={t.priority <= 2 ? `P${t.priority}` : undefined}
                                                    />
                                                ))}
                                            </Dropdown.Menu>
                                        </Dropdown.Popover>
                                    </Dropdown.Root>
                                )}
                            </div>
                        </li>
                    );
                })}
            </ol>
        </div>
    );
};

// --- Needs attention ------------------------------------------------------------------------------

const TaskLine = ({
    task,
    today,
    onSchedule,
    onComplete,
}: {
    task: PlannerTask;
    today: string;
    onSchedule: (t: PlannerTask) => void;
    onComplete: (t: PlannerTask) => void;
}) => {
    const due = [task.deadline, task.dueDate].filter((d): d is string => !!d).sort()[0];
    return (
        <li className="flex items-center gap-2 py-2 first:pt-0 last:pb-0">
            <button
                type="button"
                onClick={() => onComplete(task)}
                aria-label={`Complete ${task.title}`}
                className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-full text-fg-quaternary ring-1 ring-primary outline-focus-ring ring-inset hover:text-fg-success-primary focus-visible:outline-2"
            >
                <CheckCircle aria-hidden="true" className="size-3.5" />
            </button>
            <div className="flex min-w-0 flex-1 flex-col">
                <a
                    href={`/portal/tasks/t/${task.id}`}
                    className="truncate text-sm font-medium text-primary outline-focus-ring hover:underline focus-visible:outline-2"
                >
                    {task.title}
                </a>
                <span className="flex flex-wrap gap-x-2 text-xs text-tertiary">
                    {task.priority <= 2 && <span className="font-semibold text-error-primary">P{task.priority}</span>}
                    {due && (
                        <span className={cx(due < today && "text-error-primary")}>
                            {due < today ? `Overdue · ${dayLabel(due)}` : due === today ? "Today" : dayLabel(due)}
                        </span>
                    )}
                    <span className="truncate">{task.projectName}</span>
                    <span>
                        {task.scheduledMinutes
                            ? `${durationLabel(task.scheduledMinutes)} planned`
                            : task.estimateMinutes
                              ? `${durationLabel(task.estimateMinutes)} estimated`
                              : "No estimate"}
                    </span>
                </span>
            </div>
            <ButtonUtility size="xs" color="tertiary" icon={CalendarPlus02} tooltip={`Schedule ${task.title}`} onClick={() => onSchedule(task)} />
        </li>
    );
};

export const AttentionSection = ({
    groups,
    today,
    completed,
    onSchedule,
    onComplete,
}: {
    groups: { key: string; title: string; empty: string; tasks: PlannerTask[] }[];
    today: string;
    /** Completed on this day (when the person keeps them visible). */
    completed: TodayTask[];
    onSchedule: (t: PlannerTask) => void;
    onComplete: (t: PlannerTask) => void;
}) => (
    <Card title="Needs attention" description="Due today, overdue, and high-priority work with no time planned. Tasks stays the source of truth.">
        <div className="@container grid grid-cols-1 gap-5 sm:grid-cols-2 2xl:grid-cols-3">
            {groups.map((g) => (
                <section key={g.key} aria-labelledby={`attention-${g.key}`} className="flex min-w-0 flex-col gap-2">
                    <h3 id={`attention-${g.key}`} className="flex items-center gap-2 text-sm font-semibold text-secondary">
                        {g.title}
                        <Badge size="sm" color={g.key === "overdue" && g.tasks.length ? "error" : "gray"}>
                            {g.tasks.length}
                        </Badge>
                    </h3>
                    {g.tasks.length ? (
                        <ul className="flex flex-col divide-y divide-secondary">
                            {g.tasks.slice(0, 5).map((t) => (
                                <TaskLine key={t.id} task={t} today={today} onSchedule={onSchedule} onComplete={onComplete} />
                            ))}
                        </ul>
                    ) : (
                        <p className="text-sm text-tertiary">{g.empty}</p>
                    )}
                    {g.tasks.length > 5 && <p className="text-xs text-tertiary">and {g.tasks.length - 5} more in the Tasks panel</p>}
                </section>
            ))}
        </div>
        {completed.length > 0 && (
            <details className="text-sm">
                <summary className="cursor-pointer rounded-sm font-medium text-secondary outline-focus-ring focus-visible:outline-2">
                    Done ({completed.length})
                </summary>
                <ul className="mt-2 flex flex-col gap-1">
                    {completed.map((t) => (
                        <li key={t.id} className="flex items-center gap-2">
                            <CheckCircle aria-hidden="true" className="size-4 shrink-0 text-fg-success-primary" />
                            <a
                                href={`/portal/tasks/t/${t.id}`}
                                className="truncate text-tertiary line-through outline-focus-ring hover:underline focus-visible:outline-2"
                            >
                                {t.title}
                            </a>
                        </li>
                    ))}
                </ul>
            </details>
        )}
    </Card>
);

// --- Deadlines, commitments and notifications ----------------------------------------------------------------

export const DeadlinesSection = ({ deadlines, today }: { deadlines: TodayTask[]; today: string }) => (
    <Card title="Upcoming deadlines" description="Deadlines, milestones and P1 work in the next two weeks.">
        {deadlines.length ? (
            <ul className="flex flex-col divide-y divide-secondary">
                {deadlines.map((t) => {
                    const due = t.deadline ?? t.dueDate;
                    return (
                        <li key={t.id} className="flex items-center justify-between gap-3 py-2 text-sm first:pt-0 last:pb-0">
                            <span className="flex min-w-0 items-center gap-2">
                                <Flag01
                                    aria-hidden="true"
                                    className={cx("size-4 shrink-0", t.isMilestone ? "text-fg-brand-secondary" : "text-fg-quaternary")}
                                />
                                <a
                                    href={`/portal/tasks/t/${t.id}`}
                                    className="truncate font-medium text-primary outline-focus-ring hover:underline focus-visible:outline-2"
                                >
                                    {t.title}
                                </a>
                                <span className="truncate text-tertiary max-sm:hidden">{t.projectName}</span>
                            </span>
                            <span className="shrink-0 text-tertiary">
                                {t.deadline ? "Deadline " : ""}
                                {due ? (due === today ? "today" : dayLabel(due)) : ""}
                            </span>
                        </li>
                    );
                })}
            </ul>
        ) : (
            <p className="text-sm text-tertiary">No deadlines in the next two weeks.</p>
        )}
    </Card>
);

const CommitmentList = ({ items, empty, date }: { items: CommitmentItem[]; empty: string; date: string }) =>
    items.length ? (
        <ul className="flex flex-col divide-y divide-secondary">
            {items.map((c) => (
                <li key={c.id} className="flex flex-col py-2 text-sm first:pt-0 last:pb-0">
                    <a href={c.url} className="truncate font-medium text-primary outline-focus-ring hover:underline focus-visible:outline-2">
                        {c.title}
                    </a>
                    <span className="text-xs text-tertiary">
                        {c.date === date ? "Today" : dayLabel(c.date)}, {c.when}
                        {c.calendarName && ` · ${c.calendarName}`}
                    </span>
                </li>
            ))}
        </ul>
    ) : (
        <p className="text-sm text-tertiary">{empty}</p>
    );

export const CommitmentsSection = ({
    commitments,
    date,
    lookahead,
}: {
    commitments: { personal: CommitmentItem[]; shared: CommitmentItem[] };
    date: string;
    lookahead: number;
}) => (
    <Card title="Commitments" description="Your own events today, and shared household calendars for the days ahead.">
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
            <section aria-labelledby="commitments-personal" className="flex min-w-0 flex-col gap-2">
                <h3 id="commitments-personal" className="text-sm font-semibold text-secondary">
                    Personal
                </h3>
                <CommitmentList items={commitments.personal} empty="Nothing in your own calendars." date={date} />
            </section>
            <section aria-labelledby="commitments-shared" className="flex min-w-0 flex-col gap-2">
                <h3 id="commitments-shared" className="text-sm font-semibold text-secondary">
                    Shared, next {lookahead} {lookahead === 1 ? "day" : "days"}
                </h3>
                <CommitmentList items={commitments.shared} empty="Nothing in shared calendars." date={date} />
            </section>
        </div>
    </Card>
);

export const NotificationsSection = ({ notifications, onDismiss }: { notifications: TodayNotification[]; onDismiss: (n: TodayNotification) => void }) => (
    <Card title="Notifications" description="Calendar notices, task reminders and AI suggestions waiting for you.">
        {notifications.length ? (
            <ul className="flex flex-col divide-y divide-secondary">
                {notifications.map((n) => (
                    <li key={n.id} className="flex items-start gap-3 py-2 first:pt-0 last:pb-0">
                        <Bell01 aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-fg-quaternary" />
                        <div className="flex min-w-0 flex-1 flex-col">
                            {n.url ? (
                                <a href={n.url} className="text-sm font-medium text-primary outline-focus-ring hover:underline focus-visible:outline-2">
                                    {n.title}
                                </a>
                            ) : (
                                <span className="text-sm font-medium text-primary">{n.title}</span>
                            )}
                            {n.detail && <span className="text-xs text-tertiary">{n.detail}</span>}
                        </div>
                        {n.dismissable && <ButtonUtility size="xs" color="tertiary" icon={X} tooltip={`Dismiss ${n.title}`} onClick={() => onDismiss(n)} />}
                    </li>
                ))}
            </ul>
        ) : (
            <p className="text-sm text-tertiary">No notifications.</p>
        )}
    </Card>
);

// --- Chief of Staff --------------------------------------------------------------------------------

const RefList = ({ title, refs, empty }: { title: string; refs: BriefingRef[]; empty?: string }) =>
    refs.length || empty ? (
        <section className="flex min-w-0 flex-col gap-1.5">
            <h3 className="text-sm font-semibold text-secondary">{title}</h3>
            {refs.length ? (
                <ul className="flex flex-col gap-1 text-sm">
                    {refs.map((r) => (
                        <li key={r.id} className="min-w-0">
                            <a href={r.url} className="font-medium text-primary outline-focus-ring hover:underline focus-visible:outline-2">
                                {r.title}
                            </a>
                            {r.detail && <span className="text-tertiary"> · {r.detail}</span>}
                        </li>
                    ))}
                </ul>
            ) : (
                <p className="text-sm text-tertiary">{empty}</p>
            )}
        </section>
    ) : null;

export const BriefingSection = ({
    briefing,
    preferences,
    canUseIntelligence,
}: {
    briefing: TodayBriefing;
    preferences: TodayPreferences["briefing"];
    canUseIntelligence: boolean;
}) => {
    const [ai, setAi] = useState<BriefingView | null>(null);
    const [aiError, setAiError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const explain = async () => {
        setBusy(true);
        setAiError(null);
        try {
            // Daly Intelligence's daily briefing: every reference a model returns must be one of its facts, or it's dropped.
            setAi((await intelligenceApi.recommend("daily")).briefing);
        } catch (error) {
            setAiError(errorMessage(error));
        } finally {
            setBusy(false);
        }
    };
    const c = briefing.capacity;
    const full = preferences.detail === "full";
    return (
        <Card
            title="Chief of Staff briefing"
            description="From your Tasks, Calendar and planner records. Every item links to where it came from."
            actions={
                canUseIntelligence && preferences.ai ? (
                    <Button size="sm" color="secondary" iconLeading={Stars02} onClick={() => void explain()} isLoading={busy} showTextWhileLoading>
                        Explain my day
                    </Button>
                ) : undefined
            }
        >
            <section aria-labelledby="next-actions" className="flex flex-col gap-2 rounded-lg bg-secondary p-3">
                <h3 id="next-actions" className="flex items-center gap-2 text-sm font-semibold text-primary">
                    <Sunrise aria-hidden="true" className="size-4 text-fg-brand-primary" />
                    Recommended next actions
                </h3>
                <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-sm text-secondary">
                    {briefing.nextActions.map((a) => (
                        <li key={a.id}>
                            {a.text}
                            {a.refs.length > 0 && (
                                <span className="text-tertiary">
                                    {" "}
                                    (
                                    {a.refs.map((r, i) => (
                                        <span key={r.id}>
                                            {i > 0 && ", "}
                                            <a
                                                href={r.url}
                                                className="rounded-sm text-brand-secondary outline-focus-ring hover:underline focus-visible:outline-2"
                                            >
                                                {r.title}
                                            </a>
                                        </span>
                                    ))}
                                    )
                                </span>
                            )}
                        </li>
                    ))}
                </ol>
            </section>
            <p className="text-sm text-secondary">
                {c.status === "off"
                    ? "No planning hours today."
                    : `${durationLabel(c.availableMinutes)} available, ${durationLabel(c.committedMinutes)} committed, ${durationLabel(c.freeMinutes)} free.`}
                {c.shortfallMinutes > 0 && ` ${durationLabel(c.shortfallMinutes)} of due work doesn't fit.`}
            </p>
            {full && (
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <RefList title="Top priorities" refs={briefing.priorities} empty="Nothing due or high priority." />
                    <RefList title="Today's commitments" refs={briefing.commitments} empty="Nothing in the calendar." />
                    <RefList title="Overdue" refs={briefing.overdue} />
                    <RefList title="Scheduling conflicts" refs={briefing.conflicts} />
                    <RefList title="Unfinished from yesterday" refs={briefing.unfinishedYesterday} />
                    <RefList title="Project deadlines" refs={briefing.projectDeadlines} />
                    <RefList title="Family and shared commitments" refs={briefing.family} />
                </div>
            )}
            {aiError && (
                <Notice color="warning" title="Daly Intelligence couldn't explain the day">
                    {aiError}
                </Notice>
            )}
            {ai && (
                <section aria-labelledby="ai-explanation" className="flex flex-col gap-2 rounded-lg p-3 ring-1 ring-secondary ring-inset">
                    <h3 id="ai-explanation" className="flex items-center gap-2 text-sm font-semibold text-primary">
                        <Stars02 aria-hidden="true" className="size-4 text-fg-brand-primary" />
                        Daly Intelligence
                    </h3>
                    {ai.recommendations.status === "ready" && ai.recommendations.items.length ? (
                        <ul className="flex flex-col gap-1.5 text-sm text-secondary">
                            {ai.recommendations.items.map((r) => (
                                <li key={r.text}>
                                    {r.text}{" "}
                                    <span className="text-tertiary">
                                        (
                                        {r.refs.map((ref, i) => (
                                            <span key={ref.id}>
                                                {i > 0 && ", "}
                                                <a href={ref.url} className="text-brand-secondary hover:underline">
                                                    {ref.title}
                                                </a>
                                            </span>
                                        ))}
                                        )
                                    </span>
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <p className="text-sm text-tertiary">
                            {ai.recommendations.status === "off"
                                ? "AI explanations are switched off. The facts above are complete without them."
                                : ai.recommendations.status === "budget"
                                  ? "This month's AI budget is used up. The facts above are complete without it."
                                  : ai.recommendations.status === "unavailable"
                                    ? "The AI service isn't available right now. The facts above are complete without it."
                                    : "Nothing to add."}
                        </p>
                    )}
                    <p className="text-xs text-tertiary">AI explains these records only. It never adds tasks, meetings, deadlines or availability.</p>
                </section>
            )}
            <p className="text-xs text-tertiary">Not checked: {briefing.notChecked.join(", ")}.</p>
        </Card>
    );
};
