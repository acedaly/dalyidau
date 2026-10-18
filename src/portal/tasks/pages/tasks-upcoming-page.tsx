// Upcoming: plan by agenda (the next fortnight, day by day, as in Milestone 1), week (Monday to
// Sunday) or month. Later repeats of repeating tasks appear where they fall (worked out, never
// stored); deadlines are marked on their own day, separately from when a task is scheduled; and
// what's been completed shows, struck through, on the day of the occurrence that was done.
//
// Rescheduling never depends on dragging: every task opens the reschedule dialog from its menu or
// with "s" (on a calendar card too), which also handles one occurrence versus the whole series.
// On desktop a task can also be dragged to another day. The layout is remembered for the person.
import { useCallback, useEffect, useRef, useState } from "react";
import type { DragEvent } from "react";
import { ArrowLeft, ArrowRight, CalendarPlus02, Check, Plus, Repeat04, Target04, Users01 } from "@untitledui/icons";
import { ContentDivider } from "@/components/application/content-divider/content-divider";
import { ButtonGroup, ButtonGroupItem } from "@/components/base/button-group/button-group";
import { Button } from "@/components/base/buttons/button";
import { Empty } from "@/portal/components/empty";
import type { PageData } from "@/portal/lib/page-types";
import { addDays, clockLabel, longDate, relativeDate, shortDate } from "@/shared/tasks/dates";
import { isoWeekday } from "@/shared/tasks/recurrence";
import { PRIORITY_LABELS, type TaskSummary } from "@/shared/tasks/types";
import { UPCOMING_MODES, type UpcomingMode, shiftWindow, upcomingWindow } from "@/shared/tasks/view-preferences";
import { cx } from "@/utils/cx";
import { tasksApi } from "../api";
import { DateMenu } from "../pickers";
import { PRIORITY_COLORS, ProjectDot, titleOf } from "../shared";
import { TaskList } from "../task-list";
import { useTaskChanges, useTasks } from "../tasks-context";
import { TasksHeader, TasksLayout } from "../tasks-layout";
import type { useTaskActions } from "../use-task-actions";
import { useTaskActions as useActions } from "../use-task-actions";

const MODE_LABELS: Record<UpcomingMode, string> = { agenda: "Agenda", week: "Week", month: "Month" };
const DRAG_TYPE = "application/x-daly-task";

export const TasksUpcomingPage = ({ data }: { data: PageData<"tasks-upcoming"> }) => (
    <TasksLayout shell={data}>
        <UpcomingBody data={data} />
    </TasksLayout>
);

interface Span {
    mode: UpcomingMode;
    from: string;
    days: number;
    tasks: TaskSummary[];
    deadlines: TaskSummary[];
    done: TaskSummary[];
    overdue: TaskSummary[];
}

const UpcomingBody = ({ data }: { data: PageData<"tasks-upcoming"> }) => {
    const { today, setViewPreferences, openQuickAdd, canEdit } = useTasks();
    const actions = useActions();
    const [view, setView] = useState<Span>({ ...data });
    const [selected, setSelected] = useState<string>(data.from <= today && addDays(data.from, data.days - 1) >= today ? today : data.from);
    const [loading, setLoading] = useState(false);
    const latest = useRef(0);

    const load = useCallback(
        async (mode: UpcomingMode, fromParam: string) => {
            const request = ++latest.current;
            setLoading(true);
            try {
                const { from, days } = upcomingWindow(mode, fromParam, today);
                const to = addDays(from, days - 1);
                const [result, overdue] = await Promise.all([
                    tasksApi.upcoming(mode, from),
                    from <= today && to >= today ? tasksApi.list("overdue") : Promise.resolve({ tasks: [] as TaskSummary[] }),
                ]);
                if (request !== latest.current) return;
                setView({
                    mode,
                    from: result.from,
                    days: result.days,
                    tasks: result.tasks,
                    deadlines: result.deadlines,
                    done: result.done,
                    overdue: overdue.tasks.filter((t) => !!t.dueDate && t.dueDate < result.from),
                });
                // The address follows, so a reload or a shared link shows the same thing.
                const url = new URL(window.location.href);
                url.searchParams.set("mode", mode);
                if (result.from === upcomingWindow(mode, null, today).from) url.searchParams.delete("from");
                else url.searchParams.set("from", result.from);
                window.history.replaceState(null, "", url);
            } catch {
                // Keep what's shown; the next change tries again.
            } finally {
                if (request === latest.current) setLoading(false);
            }
        },
        [today],
    );
    // What was last asked for: a reload after a change must never undo a newer choice of layout or dates.
    const wanted = useRef({ mode: data.mode, from: data.from });
    const reloadTimer = useRef<number | null>(null);
    useTaskChanges(() => {
        if (reloadTimer.current) window.clearTimeout(reloadTimer.current);
        reloadTimer.current = window.setTimeout(() => void load(wanted.current.mode, wanted.current.from), 250);
    });
    useEffect(() => () => void (reloadTimer.current && window.clearTimeout(reloadTimer.current)), []);

    const go = (mode: UpcomingMode, from: string) => {
        if (mode !== view.mode) setViewPreferences("upcoming", { mode });
        const span = upcomingWindow(mode, from, today);
        wanted.current = { mode, from: span.from };
        setSelected(span.from <= today && addDays(span.from, span.days - 1) >= today ? today : span.from);
        void load(mode, from);
    };

    const days = Array.from({ length: view.days }, (_, i) => addDays(view.from, i));
    const last = days[days.length - 1];
    const byDay = (list: TaskSummary[]) => {
        const map = new Map<string, TaskSummary[]>();
        for (const t of list) if (t.dueDate) map.set(t.dueDate, [...(map.get(t.dueDate) ?? []), t]);
        return map;
    };
    const due = byDay(view.tasks);
    const deadlines = new Map<string, TaskSummary[]>();
    for (const t of view.deadlines) if (t.deadline) deadlines.set(t.deadline, [...(deadlines.get(t.deadline) ?? []), t]);
    const done = byDay(view.done);
    const atStart = view.from <= upcomingWindow(view.mode, null, today).from;
    const title =
        view.mode === "month"
            ? new Intl.DateTimeFormat("en-AU", { month: "long", year: "numeric", timeZone: "UTC" }).format(
                  Date.UTC(Number(view.from.slice(0, 4)), Number(view.from.slice(5, 7)) - 1, 1),
              )
            : `${shortDate(view.from)} to ${shortDate(last)}`;

    const drop = (date: string) => ({
        onDragOver: (event: DragEvent) => {
            if (event.dataTransfer.types.includes(DRAG_TYPE)) (event.preventDefault(), (event.dataTransfer.dropEffect = "move"));
        },
        onDrop: (event: DragEvent) => {
            const key = event.dataTransfer.getData(DRAG_TYPE);
            const task = [...view.tasks, ...view.overdue].find((t) => cardKey(t) === key);
            if (!task || task.dueDate === date) return;
            event.preventDefault();
            void actions.moveTo(task, date);
        },
    });

    return (
        <>
            <TasksHeader
                title="Upcoming"
                description={`${title}${loading ? " · updating…" : ""}`}
                crumb={{ label: "Upcoming" }}
                actions={
                    <>
                        <ButtonGroup
                            size="sm"
                            aria-label="Layout"
                            selectionMode="single"
                            disallowEmptySelection
                            selectedKeys={new Set([view.mode])}
                            onSelectionChange={(keys) => {
                                const mode = [...keys][0] as UpcomingMode | undefined;
                                if (mode && mode !== view.mode) go(mode, view.mode === "agenda" ? today : view.from);
                            }}
                        >
                            {UPCOMING_MODES.map((m) => (
                                <ButtonGroupItem key={m} id={m}>
                                    {MODE_LABELS[m]}
                                </ButtonGroupItem>
                            ))}
                        </ButtonGroup>
                        <Button
                            size="sm"
                            color="secondary"
                            iconLeading={ArrowLeft}
                            isDisabled={atStart}
                            onClick={() => go(view.mode, shiftWindow(view.mode, view.from, view.days, -1))}
                            aria-label="Earlier"
                        >
                            <span className="max-sm:sr-only">Earlier</span>
                        </Button>
                        <Button size="sm" color="secondary" isDisabled={atStart} onClick={() => go(view.mode, today)}>
                            Today
                        </Button>
                        <DateMenu
                            label="Jump to a date"
                            value={null}
                            onChange={(date) => date && (go(view.mode, date), setSelected(date))}
                            placeholder="Jump to"
                        />
                        <Button
                            size="sm"
                            color="secondary"
                            iconTrailing={ArrowRight}
                            onClick={() => go(view.mode, shiftWindow(view.mode, view.from, view.days, 1))}
                            aria-label="Later"
                        >
                            <span className="max-sm:sr-only">Later</span>
                        </Button>
                    </>
                }
            />
            {view.overdue.length > 0 && (
                <section aria-label="Overdue" className="flex flex-col">
                    <ContentDivider type="single-line" className="mb-1">
                        <h2 className="text-sm font-semibold text-error-primary">Overdue · {view.overdue.length}</h2>
                    </ContentDivider>
                    {view.mode === "agenda" ? (
                        <TaskList aria-label="Overdue" tasks={view.overdue} actions={actions} showProject />
                    ) : (
                        <ul className="flex flex-wrap gap-2">
                            {view.overdue.map((t) => (
                                <li key={t.id} className="w-full sm:w-60">
                                    <CalendarCard task={t} kind="due" actions={actions} draggable={canEdit(t.projectId)} />
                                </li>
                            ))}
                        </ul>
                    )}
                </section>
            )}

            {view.mode === "agenda" && (
                <div className="flex flex-col gap-6">
                    {days.map((day) => (
                        <section key={day} aria-label={longDate(day)} className="flex flex-col">
                            <ContentDivider type="single-line" className="mb-1">
                                <h2 className="text-sm font-semibold text-secondary">
                                    {longDate(day)}
                                    {day <= addDays(today, 1) && <span className="font-normal text-tertiary"> · {relativeDate(day, today)}</span>}
                                    {(due.get(day)?.length ?? 0) > 0 && <span className="font-normal text-tertiary"> · {due.get(day)!.length}</span>}
                                </h2>
                            </ContentDivider>
                            <TaskList aria-label={longDate(day)} tasks={due.get(day) ?? []} actions={actions} showProject addDefaults={{ dueDate: day }} />
                        </section>
                    ))}
                    {view.tasks.length === 0 && view.overdue.length === 0 && (
                        <Empty
                            icon={CalendarPlus02}
                            title="Nothing scheduled"
                            description="Give tasks a date and they'll appear on the day. Repeating tasks show every time they come up."
                            size="sm"
                        />
                    )}
                </div>
            )}

            {view.mode === "week" && (
                <ol aria-label={`Week of ${longDate(view.from)}`} className="grid grid-cols-1 gap-3 lg:grid-cols-7">
                    {days.map((day) => {
                        const dayDue = due.get(day) ?? [];
                        const dayDone = done.get(day) ?? [];
                        const dayDeadlines = deadlines.get(day) ?? [];
                        return (
                            <li
                                key={day}
                                aria-label={`${longDate(day)}: ${dayDue.length} to do, ${dayDone.length} done`}
                                className={cx(
                                    "flex min-h-32 flex-col gap-2 rounded-xl p-2 ring-1 ring-secondary ring-inset",
                                    day === today ? "bg-brand-primary_alt" : day < today ? "bg-secondary" : "bg-primary",
                                )}
                                {...drop(day)}
                            >
                                <div className="flex items-baseline justify-between gap-2 px-1">
                                    <span className={cx("text-sm font-semibold", day === today ? "text-brand-secondary" : "text-secondary")}>
                                        {new Intl.DateTimeFormat("en-AU", { weekday: "short", timeZone: "UTC" }).format(
                                            Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8))),
                                        )}{" "}
                                        {Number(day.slice(8))}
                                    </span>
                                    <span className="text-xs text-tertiary">
                                        {dayDue.length}
                                        {dayDone.length ? ` · ${dayDone.length} done` : ""}
                                    </span>
                                </div>
                                <ul className="flex flex-col gap-1.5">
                                    {dayDeadlines.map((t) => (
                                        <li key={`d:${t.id}`}>
                                            <CalendarCard task={t} kind="deadline" actions={actions} />
                                        </li>
                                    ))}
                                    {dayDue.map((t) => (
                                        <li key={cardKey(t)}>
                                            <CalendarCard task={t} kind="due" actions={actions} draggable={canEdit(t.projectId)} />
                                        </li>
                                    ))}
                                    {dayDone.map((t, i) => (
                                        <li key={`c:${t.id}:${i}`}>
                                            <CalendarCard task={t} kind="done" actions={actions} />
                                        </li>
                                    ))}
                                </ul>
                                <Button
                                    size="sm"
                                    color="link-gray"
                                    iconLeading={Plus}
                                    className="mt-auto self-start px-1"
                                    onClick={() => openQuickAdd({ dueDate: day })}
                                    aria-label={`Add a task on ${longDate(day)}`}
                                >
                                    <span className="lg:sr-only">Add</span>
                                </Button>
                            </li>
                        );
                    })}
                </ol>
            )}

            {view.mode === "month" && (
                <MonthView
                    days={days}
                    from={view.from}
                    due={due}
                    deadlines={deadlines}
                    done={done}
                    selected={selected}
                    onSelect={setSelected}
                    drop={drop}
                    actions={actions}
                />
            )}
            {actions.dialogs}
        </>
    );
};

const cardKey = (t: TaskSummary) => (t.projected ? `${t.id}:${t.dueDate}` : t.id);

/**
 * A task on the calendar: its title opens it, the circle completes it, and "s" (or dragging, on
 * desktop) reschedules it. Deadline markers and completed occurrences are for reading.
 */
const CalendarCard = ({
    task,
    kind,
    actions,
    draggable,
}: {
    task: TaskSummary;
    kind: "due" | "deadline" | "done";
    actions: ReturnType<typeof useTaskActions>;
    draggable?: boolean;
}) => {
    const { openTask, project, canEdit, today } = useTasks();
    const owner = project(task.projectId);
    const editable = canEdit(task.projectId) && kind === "due";
    const overdue = kind === "due" && !!task.dueDate && task.dueDate < today;
    return (
        <div
            draggable={draggable && editable}
            onDragStart={(event) => {
                event.dataTransfer.setData(DRAG_TYPE, cardKey(task));
                event.dataTransfer.effectAllowed = "move";
            }}
            onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return;
                if (event.key === "s" && editable) (event.preventDefault(), actions.reschedule(task));
                else if (event.key === "Enter") (event.preventDefault(), openTask(task.id));
                else if (event.key === "e" && editable && !task.projected) (event.preventDefault(), void actions.complete(task));
            }}
            tabIndex={0}
            aria-label={`${titleOf(task.title)}${kind === "deadline" ? ", deadline" : kind === "done" ? ", done" : ""}${overdue ? ", overdue" : ""}${task.projected ? ", a later repeat" : ""}. Press s to reschedule.`}
            className={cx(
                "group/card flex items-start gap-1.5 rounded-lg bg-primary px-2 py-1.5 text-xs shadow-xs ring-1 ring-secondary outline-focus-ring ring-inset focus-visible:outline-2",
                draggable && editable && "cursor-grab active:cursor-grabbing",
                kind === "done" && "bg-secondary text-quaternary",
                kind === "deadline" && "ring-error_subtle",
                task.projected && "opacity-75",
            )}
        >
            {kind === "due" && !task.projected && editable ? (
                <button
                    type="button"
                    aria-label={`Complete “${titleOf(task.title)}”`}
                    onClick={() => void actions.complete(task)}
                    className={cx(
                        "mt-px flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-full ring-[1.5px] outline-focus-ring ring-inset focus-visible:outline-2",
                        PRIORITY_COLORS[task.priority].ring,
                    )}
                >
                    <Check aria-hidden="true" className="size-2.5 text-fg-quaternary opacity-0 group-hover/card:opacity-60" strokeWidth={3} />
                </button>
            ) : kind === "deadline" ? (
                <Target04 aria-hidden="true" className="mt-px size-3.5 shrink-0 text-fg-error-secondary" />
            ) : kind === "done" ? (
                <Check aria-hidden="true" className="mt-px size-3.5 shrink-0 text-fg-success-secondary" />
            ) : (
                <Repeat04 aria-hidden="true" className="mt-px size-3.5 shrink-0 text-fg-quaternary" />
            )}
            <button
                type="button"
                onClick={() => (task.projected && editable ? actions.reschedule(task) : openTask(task.id))}
                className={cx(
                    "min-w-0 flex-1 cursor-pointer text-left font-medium wrap-break-word text-primary",
                    kind === "done" && "text-quaternary line-through",
                    overdue && "text-error-primary",
                )}
            >
                {kind === "deadline" && <span className="text-error-primary">Deadline: </span>}
                {titleOf(task.title)}
                <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 font-normal text-tertiary">
                    {task.priority < 4 && kind !== "done" && (
                        <span className={PRIORITY_COLORS[task.priority].text}>{PRIORITY_LABELS[task.priority].short}</span>
                    )}
                    {task.dueTime && kind === "due" && <span>{clockLabel(task.dueTime)}</span>}
                    {owner && (
                        <span className="inline-flex items-center gap-1">
                            <ProjectDot color={owner.color} />
                            <span className="truncate">{owner.name}</span>
                            {owner.kind === "shared" && <Users01 aria-label="Shared" className="size-3" />}
                        </span>
                    )}
                </span>
            </button>
        </div>
    );
};

const MonthView = ({
    days,
    from,
    due,
    deadlines,
    done,
    selected,
    onSelect,
    drop,
    actions,
}: {
    days: string[];
    from: string;
    due: Map<string, TaskSummary[]>;
    deadlines: Map<string, TaskSummary[]>;
    done: Map<string, TaskSummary[]>;
    selected: string;
    onSelect: (date: string) => void;
    drop: (date: string) => { onDragOver: (e: DragEvent) => void; onDrop: (e: DragEvent) => void };
    actions: ReturnType<typeof useTaskActions>;
}) => {
    const { today, openQuickAdd } = useTasks();
    const lead = isoWeekday(from) - 1;
    const cells: (string | null)[] = [...Array.from({ length: lead }, () => null), ...days];
    while (cells.length % 7) cells.push(null);
    const selectedDue = due.get(selected) ?? [];
    const selectedDone = done.get(selected) ?? [];
    const selectedDeadlines = deadlines.get(selected) ?? [];
    const grid = useRef<HTMLDivElement>(null);
    // Arrow keys move between days, as in a date picker.
    const onKeyDown = (event: React.KeyboardEvent) => {
        const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key];
        if (!step) return;
        const next = addDays(selected, step);
        if (!days.includes(next)) return;
        event.preventDefault();
        onSelect(next);
        window.requestAnimationFrame(() => grid.current?.querySelector<HTMLElement>(`[data-day="${next}"]`)?.focus());
    };
    return (
        <div className="flex flex-col gap-6">
            <div ref={grid} className="overflow-hidden rounded-xl bg-primary shadow-xs ring-1 ring-secondary" onKeyDown={onKeyDown}>
                <div className="grid grid-cols-7 border-b border-secondary bg-secondary text-center text-xs font-semibold text-quaternary" aria-hidden="true">
                    {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
                        <div key={d} className="py-2">
                            {d}
                        </div>
                    ))}
                </div>
                <div role="group" aria-label="Month" className="grid grid-cols-7">
                    {cells.map((day, i) => {
                        if (!day)
                            return (
                                <div
                                    key={`x${i}`}
                                    className="min-h-16 border-r border-b border-secondary bg-secondary md:min-h-24 [&:nth-child(7n)]:border-r-0"
                                />
                            );
                        const dayDue = due.get(day) ?? [];
                        const dayDone = done.get(day) ?? [];
                        const dayDeadlines = deadlines.get(day) ?? [];
                        const total = dayDue.length + dayDone.length;
                        return (
                            <button
                                key={day}
                                type="button"
                                data-day={day}
                                tabIndex={day === selected ? 0 : -1}
                                aria-pressed={day === selected}
                                aria-label={`${longDate(day)}: ${dayDue.length} to do, ${dayDone.length} done${dayDeadlines.length ? `, ${dayDeadlines.length} deadline${dayDeadlines.length === 1 ? "" : "s"}` : ""}`}
                                onClick={() => onSelect(day)}
                                {...drop(day)}
                                className={cx(
                                    "flex min-h-16 cursor-pointer flex-col items-start gap-1 border-r border-b border-secondary p-1.5 text-left outline-focus-ring focus-visible:outline-2 focus-visible:-outline-offset-2 md:min-h-24 md:p-2 [&:nth-child(7n)]:border-r-0",
                                    day === selected && "bg-brand-primary_alt",
                                    day < today && day !== selected && "bg-secondary_subtle",
                                )}
                            >
                                <span
                                    className={cx(
                                        "inline-flex size-6 items-center justify-center rounded-full text-xs font-medium",
                                        day === today ? "bg-brand-solid text-white" : "text-tertiary",
                                    )}
                                >
                                    {Number(day.slice(8))}
                                </span>
                                {/* Small screens: counts only. Larger: up to two titles and how many more. */}
                                {total > 0 && (
                                    <span className="text-xs text-tertiary md:hidden">
                                        {dayDue.length}
                                        {dayDone.length ? <span className="text-secondary"> ✓{dayDone.length}</span> : null}
                                    </span>
                                )}
                                <span className="hidden w-full flex-col gap-0.5 md:flex">
                                    {dayDeadlines.slice(0, 1).map((t) => (
                                        <span key={`d${t.id}`} className="truncate rounded-sm bg-error-primary px-1 text-xs text-error-primary">
                                            ⚑ {titleOf(t.title)}
                                        </span>
                                    ))}
                                    {dayDue.slice(0, 2).map((t) => (
                                        <span
                                            key={cardKey(t)}
                                            className={cx(
                                                "truncate rounded-sm px-1 text-xs",
                                                t.projected ? "text-tertiary" : "bg-brand-primary text-brand-secondary",
                                            )}
                                        >
                                            {titleOf(t.title)}
                                        </span>
                                    ))}
                                    {dayDue.length > 2 && <span className="px-1 text-xs text-tertiary">+{dayDue.length - 2} more</span>}
                                    {dayDone.length > 0 && <span className="px-1 text-xs text-secondary">✓ {dayDone.length} done</span>}
                                </span>
                            </button>
                        );
                    })}
                </div>
            </div>
            <section aria-label={longDate(selected)} className="flex flex-col gap-2">
                <ContentDivider type="single-line" className="mb-1">
                    <h2 className="text-sm font-semibold text-secondary">
                        {longDate(selected)} <span className="font-normal text-tertiary">· {relativeDate(selected, today)}</span>
                    </h2>
                </ContentDivider>
                {selectedDeadlines.length > 0 && (
                    <ul className="flex flex-col gap-1.5">
                        {selectedDeadlines.map((t) => (
                            <li key={t.id}>
                                <CalendarCard task={t} kind="deadline" actions={actions} />
                            </li>
                        ))}
                    </ul>
                )}
                <TaskList
                    aria-label={`Due ${longDate(selected)}`}
                    tasks={selectedDue}
                    actions={actions}
                    showProject
                    addDefaults={{ dueDate: selected }}
                    empty={<p className="py-2 text-sm text-tertiary">Nothing scheduled.</p>}
                />
                {selectedDone.length > 0 && (
                    <ul aria-label="Done" className="flex flex-col gap-1.5">
                        {selectedDone.map((t, i) => (
                            <li key={`${t.id}:${i}`}>
                                <CalendarCard task={t} kind="done" actions={actions} />
                            </li>
                        ))}
                    </ul>
                )}
                <Button size="sm" color="link-gray" iconLeading={Plus} className="self-start lg:hidden" onClick={() => openQuickAdd({ dueDate: selected })}>
                    Add a task on {shortDate(selected)}
                </Button>
            </section>
        </div>
    );
};
