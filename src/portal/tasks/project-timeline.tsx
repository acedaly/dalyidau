// A project's timeline: its dated events in order, grouped by month, with today marked. Start and
// target, milestones, deadlines, due tasks (with a few later repeats), reviews done and the next one
// due. A list rather than a Gantt chart: it reads the same on a phone, and tasks have no durations.
import type { FC } from "react";
import { CalendarCheck01, CheckCircle, ClipboardCheck, Flag05, PlayCircle, Repeat04, Target04 } from "@untitledui/icons";
import { longDate, relativeDate } from "@/shared/tasks/dates";
import type { ProjectTimeline, TimelineItem } from "@/shared/tasks/productivity";
import { cx } from "@/utils/cx";
import { Quiet } from "./productivity-ui";
import { titleOf } from "./shared";
import { useTasks } from "./tasks-context";

const KIND: Record<TimelineItem["kind"], { icon: FC<{ className?: string }>; text: string; tone: string }> = {
    start: { icon: PlayCircle, text: "Start", tone: "text-fg-brand-secondary" },
    target: { icon: Flag05, text: "Target", tone: "text-fg-brand-secondary" },
    milestone: { icon: Flag05, text: "Milestone", tone: "text-fg-warning-secondary" },
    deadline: { icon: Target04, text: "Deadline", tone: "text-fg-error-secondary" },
    due: { icon: CalendarCheck01, text: "Due", tone: "text-fg-quaternary" },
    review: { icon: ClipboardCheck, text: "Review", tone: "text-fg-success-secondary" },
    next_review: { icon: ClipboardCheck, text: "Review due", tone: "text-fg-quaternary" },
};

const MONTH = new Intl.DateTimeFormat("en-AU", { month: "long", year: "numeric", timeZone: "UTC" });
const monthOf = (date: string) => MONTH.format(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, 1));

export const ProjectTimelineView = ({ timeline }: { timeline: ProjectTimeline | null }) => {
    const { today, openTask } = useTasks();
    if (!timeline) return <Quiet>Loading…</Quiet>;
    if (!timeline.items.length)
        return <Quiet>Nothing dated yet. Give the project a start and target date in Settings, and tasks due dates, deadlines or milestones.</Quiet>;
    const months = new Map<string, TimelineItem[]>();
    for (const item of timeline.items) months.set(monthOf(item.date), [...(months.get(monthOf(item.date)) ?? []), item]);
    let todayShown = false;
    return (
        <div className="flex flex-col gap-6">
            {[...months].map(([month, items]) => (
                <section key={month} aria-label={month} className="flex flex-col gap-2">
                    <h2 className="text-sm font-semibold text-tertiary">{month}</h2>
                    <ol className="relative flex flex-col border-l-2 border-secondary pl-5">
                        {items.map((item, i) => {
                            const meta = KIND[item.kind];
                            const Icon = item.task?.projected ? Repeat04 : item.done ? CheckCircle : meta.icon;
                            const showToday = !todayShown && item.date >= today;
                            if (showToday) todayShown = true;
                            return (
                                <li key={`${item.kind}:${item.date}:${item.task?.id ?? i}`} className="relative py-2">
                                    {showToday && (
                                        <p className="mb-2 -ml-5 flex items-center gap-2 text-xs font-semibold text-brand-secondary">
                                            <span aria-hidden="true" className="-ml-[5px] size-2 rounded-full bg-brand-solid" />
                                            Today
                                        </p>
                                    )}
                                    <span
                                        aria-hidden="true"
                                        className={cx("absolute top-3 -left-[31px] flex size-5 items-center justify-center rounded-full bg-primary", meta.tone)}
                                    >
                                        <Icon className="size-4" />
                                    </span>
                                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                                        <span className="w-28 shrink-0 text-xs text-tertiary tabular-nums" title={longDate(item.date)}>
                                            {relativeDate(item.date, today)}
                                        </span>
                                        <span className="text-xs font-medium text-tertiary">{item.task?.projected ? "Repeats" : meta.text}</span>
                                        {item.task ? (
                                            <button
                                                type="button"
                                                onClick={() => openTask(item.task!.id)}
                                                className={cx(
                                                    "min-w-0 cursor-pointer truncate rounded-sm text-left text-sm font-medium text-primary outline-focus-ring hover:underline focus-visible:outline-2",
                                                    item.done && "text-tertiary line-through",
                                                )}
                                            >
                                                {titleOf(item.label)}
                                            </button>
                                        ) : (
                                            <span className="text-sm font-medium text-secondary">{item.label}</span>
                                        )}
                                    </div>
                                </li>
                            );
                        })}
                    </ol>
                </section>
            ))}
            {timeline.truncated && <Quiet>Showing the first 300 dated tasks.</Quiet>}
        </div>
    );
};
