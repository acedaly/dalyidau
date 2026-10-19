// The Daily Planner's interface pieces, shared by the Calendar's day and week views and the Daily
// Planner page: the Tasks panel, scheduling a task (by dragging it onto the timeline, or with the
// Schedule button, which is the keyboard and touch way), a block's panel (move, resize, cancel,
// complete the task) and conflict warnings. Untitled UI parts throughout: Tabs, Select, Input,
// DateField, RecordPanel, PortalDialog, Badge and Button.
//
// Tasks stays the source of truth: completing goes through Tasks' own API, and scheduling never
// changes a task's dates. Nothing is ever scheduled without the person doing it.
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CalendarPlus02, CheckCircle, ChevronDown, ChevronUp, Clock, DotsVertical, Stars02 } from "@untitledui/icons";
import { Tabs } from "@/components/application/tabs/tabs";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Dropdown } from "@/components/base/dropdown/dropdown";
import { Input } from "@/components/base/input/input";
import { Select } from "@/components/base/select/select";
import { DateField } from "@/portal/components/date-field";
import { ConfirmDialog, PortalDialog } from "@/portal/components/dialog";
import { RecordPanel } from "@/portal/components/record-panel";
import { useToast } from "@/portal/components/toast";
import { ApiError, errorMessage } from "@/portal/lib/api";
import { tasksApi } from "@/portal/tasks/api";
import { addDays, dayLabel, longDateLabel, timeLabel } from "@/shared/calendar/time";
import {
    PLANNER_BUCKETS,
    PLANNER_BUCKET_LABELS,
    type PlanSuggestion,
    type PlannerBucket,
    type PlannerConflict,
    type PlannerTask,
    type PlannerTaskLists,
    type TimeBlockInfo,
} from "@/shared/planner/types";
import { PRIORITIES, PRIORITY_LABELS } from "@/shared/tasks/types";
import { cx } from "@/utils/cx";
import { clientId } from "./api";
import { type BlockResult, DRAG_TYPE, type DragPayload, durationLabel, plannerApi } from "./planner-api";

export const DURATIONS = [15, 30, 45, 60, 90, 120, 180, 240];
const ESTIMATES = [15, 30, 45, 60, 90, 120, 180, 240, 360, 480];

const end = (b: Pick<TimeBlockInfo, "endTime">) => timeLabel(b.endTime === "24:00" ? "23:59" : b.endTime);
/** What still needs planning for a task, or its estimate, or an hour. */
export const remainingFor = (t: PlannerTask) => Math.max(15, Math.min(240, (t.estimateMinutes ?? 60) - t.scheduledMinutes || (t.estimateMinutes ?? 60)));

// --- State shared by a page --------------------------------------------------------------------

export interface PlannerState {
    lists: PlannerTaskLists;
    blocks: TimeBlockInfo[];
    conflicts: PlannerConflict[];
}

export type ScheduleTarget =
    | { kind: "task"; task: PlannerTask; date: string; time: string | null }
    | { kind: "block"; block: TimeBlockInfo }
    | { kind: "suggestion"; suggestion: PlanSuggestion; task: PlannerTask | null };

/**
 * The planner's state and actions on a page. `load` fetches the page's current state; every change
 * replaces what's shown with the server's answer rather than guessing.
 */
export function usePlanner(initial: PlannerState, load: () => Promise<PlannerState>, onChanged?: () => void) {
    const toast = useToast();
    const [state, setState] = useState<PlannerState>(initial);
    const [target, setTarget] = useState<ScheduleTarget | null>(null);
    const [openBlock, setOpenBlock] = useState<TimeBlockInfo | null>(null);

    const refresh = useCallback(async () => {
        try {
            setState(await load());
            onChanged?.();
        } catch (error) {
            toast.error("Couldn't refresh the plan", errorMessage(error));
        }
    }, [load, onChanged, toast]);

    const announce = useCallback(
        (result: BlockResult, verb: string, undo?: () => Promise<unknown>) => {
            const when = `${dayLabel(result.block.startDate)}, ${timeLabel(result.block.startTime)} – ${end(result.block)}`;
            if (result.conflicts.length)
                toast.show({
                    title: `${verb}, with ${result.conflicts.length === 1 ? "a conflict" : `${result.conflicts.length} conflicts`}`,
                    description: `${result.block.title} · ${when} · ${result.conflicts.map((c) => c.message).join("; ")}`,
                    color: "warning",
                    ...(undo ? { action: { label: "Undo", run: () => void undo().then(refresh) } } : {}),
                });
            else
                toast.show({
                    title: verb,
                    description: `${result.block.title} · ${when}`,
                    color: "success",
                    ...(undo ? { action: { label: "Undo", run: () => void undo().then(refresh) } } : {}),
                });
        },
        [refresh, toast],
    );

    /** A task dropped on a time is scheduled there; a block dropped on a time moves there. */
    const drop = useCallback(
        async (payload: DragPayload, date: string, time: string) => {
            try {
                if (payload.kind === "task") {
                    const result = await plannerApi.create({
                        taskId: payload.taskId,
                        startDate: date,
                        startTime: time,
                        durationMinutes: payload.minutes,
                        clientId: clientId(),
                    });
                    announce(result, "Planned", () => plannerApi.update(result.block.id, { version: result.block.version, status: "cancelled" }));
                } else {
                    const before = state.blocks.find((b) => b.id === payload.blockId);
                    const result = await plannerApi.update(payload.blockId, { version: payload.version, startDate: date, startTime: time });
                    announce(
                        result,
                        "Moved",
                        before
                            ? () =>
                                  plannerApi.update(result.block.id, {
                                      version: result.block.version,
                                      startDate: before.startDate,
                                      startTime: before.startTime,
                                  })
                            : undefined,
                    );
                }
            } catch (error) {
                toast.error("Couldn't plan that", errorMessage(error));
            }
            await refresh();
        },
        [announce, refresh, state.blocks, toast],
    );

    return { state, refresh, target, setTarget, openBlock, setOpenBlock, drop, announce };
}

export type Planner = ReturnType<typeof usePlanner>;

// --- Conflicts -------------------------------------------------------------------------------------

export const ConflictList = ({ conflicts, title = "Conflicts" }: { conflicts: PlannerConflict[]; title?: string }) =>
    conflicts.length ? (
        <div role="status" className="ring-warning_subtle flex flex-col gap-2 rounded-lg bg-warning-primary p-3 ring-1 ring-inset">
            <p className="flex items-center gap-2 text-sm font-semibold text-warning-primary">
                <AlertTriangle aria-hidden="true" className="size-4" />
                {title}
            </p>
            <ul className="flex flex-col gap-1 text-sm text-secondary">
                {conflicts.map((c, i) => (
                    <li key={`${c.kind}:${c.with?.id ?? i}`}>{c.message}</li>
                ))}
            </ul>
        </div>
    ) : null;

// --- The Tasks panel -------------------------------------------------------------------------------

const dueLabel = (t: PlannerTask, today: string) => {
    const due = t.deadline && (!t.dueDate || t.deadline < t.dueDate) ? t.deadline : t.dueDate;
    if (!due) return null;
    if (due < today) return { text: `Overdue · ${dayLabel(due)}`, overdue: true };
    if (due === today) return { text: t.dueTime ? `Today, ${timeLabel(t.dueTime)}` : "Today", overdue: false };
    return { text: dayLabel(due), overdue: false };
};

/** What's still to plan for a task: its estimate less its planned sessions. */
export const leftToPlan = (t: PlannerTask) => (t.estimateMinutes ? Math.max(0, t.estimateMinutes - t.scheduledMinutes) : null);

const TaskRow = ({
    task,
    today,
    onSchedule,
    onComplete,
    onAction,
    draggable,
}: {
    task: PlannerTask;
    today: string;
    onSchedule: (task: PlannerTask) => void;
    onComplete: (task: PlannerTask) => void;
    /** Postpone, priority and open (Today's panel). */
    onAction?: (task: PlannerTask, action: string) => void;
    draggable: boolean;
}) => {
    const due = dueLabel(task, today);
    const left = leftToPlan(task);
    return (
        <li
            data-task={task.id}
            draggable={draggable}
            onDragStart={(e) => {
                const payload: DragPayload = { kind: "task", taskId: task.id, minutes: remainingFor(task) };
                e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(payload));
                e.dataTransfer.effectAllowed = "move";
            }}
            className={cx("group flex items-start gap-2 px-3 py-2.5", draggable && "cursor-grab active:cursor-grabbing")}
        >
            <button
                type="button"
                onClick={() => onComplete(task)}
                aria-label={`Complete ${task.title}`}
                className="mt-0.5 flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-full text-fg-quaternary ring-1 ring-primary outline-focus-ring ring-inset hover:text-fg-success-primary focus-visible:outline-2"
            >
                <CheckCircle aria-hidden="true" className="size-3.5 opacity-0 group-hover:opacity-100" />
            </button>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <a
                    href={`/portal/tasks/t/${task.id}`}
                    className="truncate text-sm font-medium text-primary outline-focus-ring hover:underline focus-visible:outline-2"
                >
                    {task.title}
                </a>
                <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-tertiary">
                    {task.priority <= 3 && (
                        <span
                            className={cx(
                                "font-semibold",
                                task.priority === 1 ? "text-error-primary" : task.priority === 2 ? "text-warning-primary" : "text-brand-secondary",
                            )}
                        >
                            P{task.priority}
                        </span>
                    )}
                    {due && <span className={cx(due.overdue && "text-error-primary")}>{due.text}</span>}
                    <span className="truncate">{task.projectName}</span>
                    <span className="flex items-center gap-1">
                        <Clock aria-hidden="true" className="size-3" />
                        {task.estimateMinutes ? durationLabel(task.estimateMinutes) : "No estimate"}
                        {task.scheduledMinutes > 0 && ` · ${durationLabel(task.scheduledMinutes)} planned`}
                        {onAction && left !== null && task.scheduledMinutes > 0 && ` · ${left ? `${durationLabel(left)} left` : "all planned"}`}
                    </span>
                </span>
            </div>
            <Button size="xs" color="secondary" iconLeading={CalendarPlus02} onClick={() => onSchedule(task)} aria-label={`Schedule ${task.title}`}>
                <span className="max-sm:sr-only">Schedule</span>
            </Button>
            {onAction && (
                <Dropdown.Root>
                    <ButtonUtility size="xs" color="tertiary" icon={DotsVertical} tooltip={`More for “${task.title}”`} className="shrink-0" />
                    <Dropdown.Popover className="w-56">
                        <Dropdown.Menu onAction={(key) => onAction(task, String(key))}>
                            <Dropdown.Section>
                                <Dropdown.Item id="open" label="Open the task" />
                            </Dropdown.Section>
                            <Dropdown.Separator />
                            <Dropdown.Section>
                                <Dropdown.Item id="postpone:1" label="Postpone to tomorrow" />
                                <Dropdown.Item id="postpone:7" label="Postpone a week" />
                            </Dropdown.Section>
                            {task.canEdit && (
                                <>
                                    <Dropdown.Separator />
                                    <Dropdown.Section>
                                        {PRIORITIES.map((p) => (
                                            <Dropdown.Item
                                                key={p}
                                                id={`priority:${p}`}
                                                label={`${PRIORITY_LABELS[p].short} · ${PRIORITY_LABELS[p].label}`}
                                                addon={task.priority === p ? "✓" : undefined}
                                            />
                                        ))}
                                    </Dropdown.Section>
                                </>
                            )}
                        </Dropdown.Menu>
                    </Dropdown.Popover>
                </Dropdown.Root>
            )}
        </li>
    );
};

/**
 * Today, Overdue, Upcoming, Priority and Unscheduled tasks. Drag one onto a time in the calendar,
 * or use Schedule (keyboard and touch). Collapsible beside the day and week views.
 */
export const TasksPanel = ({
    planner,
    today,
    defaultDate,
    collapsible = false,
    extended = false,
    title = "Tasks to plan",
    className,
}: {
    planner: Planner;
    today: string;
    /** The date the Schedule button suggests. */
    defaultDate: string;
    collapsible?: boolean;
    /** Today's panel: filter by project, postpone, change priority and open the task, all through Tasks. */
    extended?: boolean;
    title?: string;
    className?: string;
}) => {
    const toast = useToast();
    const { lists } = planner.state;
    const [open, setOpen] = useState(true);
    const [bucket, setBucket] = useState<PlannerBucket>(lists.buckets.today.length || !lists.buckets.overdue.length ? "today" : "overdue");
    const [project, setProject] = useState<string>("all");
    const [subtasksFor, setSubtasksFor] = useState<PlannerTask | null>(null);
    const byId = new Map(lists.tasks.map((t) => [t.id, t]));
    const inProject = (t: PlannerTask) => project === "all" || t.projectId === project;
    const shown = lists.buckets[bucket]
        .map((id) => byId.get(id))
        .filter((t): t is PlannerTask => !!t)
        .filter(inProject);
    const projects = [...new Map(lists.tasks.map((t) => [t.projectId, t.projectName || "Project"])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
    const buckets = extended ? PLANNER_BUCKETS : PLANNER_BUCKETS.filter((b) => b !== "inbox");

    // Postponing and priorities go through Tasks' own API (its permissions, history and repeats).
    const act = async (task: PlannerTask, action: string) => {
        if (action === "open") return void (window.location.href = `/portal/tasks/t/${task.id}`);
        try {
            if (action.startsWith("postpone:")) {
                const days = Number(action.split(":")[1]);
                const from = task.dueDate && task.dueDate > today ? task.dueDate : today;
                const to = addDays(from, days);
                await tasksApi.update(task.id, task.version, { dueDate: to }, task.recurring ? "occurrence" : undefined);
                toast.success(`Postponed to ${dayLabel(to)}`, task.title);
            } else if (action.startsWith("priority:")) {
                const priority = Number(action.split(":")[1]) as PlannerTask["priority"];
                await tasksApi.update(task.id, task.version, { priority });
                toast.success(`Priority set to P${priority}`, task.title);
            }
            await planner.refresh();
        } catch (error) {
            toast.error("Couldn't change the task", errorMessage(error));
            await planner.refresh();
        }
    };

    const complete = async (task: PlannerTask, includeSubtasks = false) => {
        try {
            // Tasks' own API, rules and history. A repeating task moves on to its next occurrence.
            const result = await tasksApi.complete(task.id, task.dueDate, includeSubtasks);
            toast.show({
                title: result.nextDate ? `Done. Next: ${dayLabel(result.nextDate)}` : "Task completed",
                description: task.title,
                color: "success",
                action: { label: "Undo", run: () => void tasksApi.reopen(task.id).then(planner.refresh) },
            });
            await planner.refresh();
        } catch (error) {
            if (error instanceof ApiError && error.code === "open_subtasks") return setSubtasksFor(task);
            toast.error("Couldn't complete the task", errorMessage(error));
        }
    };

    return (
        <section
            aria-labelledby="tasks-panel-heading"
            className={cx("flex min-w-0 flex-col rounded-xl bg-primary shadow-xs ring-1 ring-secondary ring-inset", className)}
        >
            <div className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                    <h2 id="tasks-panel-heading" className="text-sm font-semibold text-primary">
                        {title}
                    </h2>
                    <p className="text-xs text-tertiary">Drag onto a time, or choose Schedule.</p>
                </div>
                {collapsible && (
                    <Button
                        size="sm"
                        color="tertiary"
                        iconLeading={open ? ChevronUp : ChevronDown}
                        aria-expanded={open}
                        aria-controls="tasks-panel-body"
                        onClick={() => setOpen(!open)}
                    >
                        {open ? "Hide" : "Show"}
                    </Button>
                )}
            </div>
            {open && (
                <div id="tasks-panel-body" className="flex min-h-0 flex-col border-t border-secondary">
                    {extended && projects.length > 1 && (
                        <div className="px-3 pt-3">
                            <Select
                                size="sm"
                                aria-label="Project"
                                value={project}
                                onChange={(k) => k && setProject(String(k))}
                                items={[{ id: "all", label: "All projects" }, ...projects.map(([id, name]) => ({ id, label: name }))]}
                            >
                                {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                            </Select>
                        </div>
                    )}
                    <Tabs selectedKey={bucket} onSelectionChange={(k) => setBucket(k as PlannerBucket)}>
                        <Tabs.List type="button-minimal" size="sm" className="overflow-x-auto px-2 pt-2" aria-label="Which tasks">
                            {buckets.map((b) => (
                                <Tabs.Item key={b} id={b} badge={lists.buckets[b].filter((id) => byId.has(id) && inProject(byId.get(id)!)).length || undefined}>
                                    {PLANNER_BUCKET_LABELS[b]}
                                </Tabs.Item>
                            ))}
                        </Tabs.List>
                        {buckets.map((b) => (
                            <Tabs.Panel key={b} id={b} className="min-h-0">
                                {b === bucket &&
                                    (shown.length ? (
                                        <ul className="flex max-h-[60vh] flex-col divide-y divide-secondary overflow-y-auto">
                                            {shown.map((t) => (
                                                <TaskRow
                                                    key={t.id}
                                                    task={t}
                                                    today={today}
                                                    draggable
                                                    onSchedule={(task) => planner.setTarget({ kind: "task", task, date: defaultDate, time: null })}
                                                    onComplete={(task) => void complete(task)}
                                                    onAction={extended ? (task, action) => void act(task, action) : undefined}
                                                />
                                            ))}
                                        </ul>
                                    ) : (
                                        <p className="px-4 py-6 text-sm text-tertiary">
                                            {b === "unscheduled" ? "Everything here has time planned." : `No ${PLANNER_BUCKET_LABELS[b].toLowerCase()} tasks.`}
                                        </p>
                                    ))}
                            </Tabs.Panel>
                        ))}
                    </Tabs>
                </div>
            )}
            <ConfirmDialog
                isOpen={!!subtasksFor}
                onOpenChange={(o) => !o && setSubtasksFor(null)}
                title="Complete its subtasks too?"
                description="This task has open subtasks. Completing it completes them as well."
                confirmLabel="Complete all"
                onConfirm={async () => {
                    if (subtasksFor) await complete(subtasksFor, true);
                    setSubtasksFor(null);
                }}
            />
        </section>
    );
};

// --- Scheduling a task (or changing a block's time) ----------------------------------------------------

export const ScheduleDialog = ({ planner, today }: { planner: Planner; today: string }) => {
    const toast = useToast();
    const target = planner.target;
    const taskId =
        target?.kind === "task"
            ? target.task.id
            : target?.kind === "block"
              ? target.block.taskId
              : target?.kind === "suggestion"
                ? target.suggestion.taskId
                : "";
    const title =
        target?.kind === "task"
            ? target.task.title
            : target?.kind === "block"
              ? target.block.title
              : target?.kind === "suggestion"
                ? target.suggestion.title
                : "";
    const [date, setDate] = useState(today);
    const [time, setTime] = useState("09:00");
    const [minutes, setMinutes] = useState(60);
    const [estimate, setEstimate] = useState<number | null>(null);
    const [conflicts, setConflicts] = useState<PlannerConflict[]>([]);
    const [free, setFree] = useState<{ startTime: string; endTime: string; minutes: number }[] | null>(null);
    const [suggestions, setSuggestions] = useState<PlanSuggestion[] | null>(null);
    const [busy, setBusy] = useState(false);

    // Start from what was chosen: a dropped time, a suggestion, or the block as it is.
    useEffect(() => {
        if (!target) return;
        setSuggestions(null);
        if (target.kind === "task") {
            setDate(target.date);
            setTime(target.time ?? "09:00");
            setMinutes(remainingFor(target.task));
            setEstimate(target.task.estimateMinutes);
        } else if (target.kind === "block") {
            setDate(target.block.startDate);
            setTime(target.block.startTime);
            setMinutes(target.block.durationMinutes);
            setEstimate(null);
        } else {
            setDate(target.suggestion.startDate);
            setTime(target.suggestion.startTime);
            setMinutes(target.suggestion.durationMinutes);
            setEstimate(target.task?.estimateMinutes ?? null);
        }
    }, [target]);

    // Warnings for the time as it's chosen.
    useEffect(() => {
        if (!target || !taskId || !/^\d{2}:\d{2}$/.test(time)) return;
        const timer = window.setTimeout(() => {
            plannerApi
                .check({ taskId, blockId: target.kind === "block" ? target.block.id : undefined, startDate: date, startTime: time, durationMinutes: minutes })
                .then((r) => setConflicts(r.conflicts))
                .catch(() => setConflicts([]));
        }, 250);
        return () => window.clearTimeout(timer);
    }, [target, taskId, date, time, minutes]);

    // Free time on the chosen day.
    useEffect(() => {
        if (!target) return;
        plannerApi
            .day(date)
            .then((r) => setFree(r.plan.free))
            .catch(() => setFree(null));
    }, [target, date]);

    const close = () => planner.setTarget(null);
    const suggest = async () => {
        try {
            const { plan } = await plannerApi.suggest({ from: date < today ? today : date, days: 7, taskIds: [taskId] });
            setSuggestions(plan.suggestions);
        } catch (error) {
            toast.error("Couldn't suggest times", errorMessage(error));
        }
    };
    const saveEstimate = async (value: number | null) => {
        setEstimate(value);
        try {
            await plannerApi.estimate(taskId, value);
        } catch (error) {
            toast.error("Couldn't save the estimate", errorMessage(error));
        }
    };
    const save = async () => {
        setBusy(true);
        try {
            if (target?.kind === "block") {
                const result = await plannerApi.update(target.block.id, {
                    version: target.block.version,
                    startDate: date,
                    startTime: time,
                    durationMinutes: minutes,
                });
                planner.announce(result, "Changed");
            } else {
                const result = await plannerApi.create({
                    taskId,
                    startDate: date,
                    startTime: time,
                    durationMinutes: minutes,
                    source: target?.kind === "suggestion" ? "suggestion" : "manual",
                    occurrenceDate: target?.kind === "suggestion" ? target.suggestion.occurrenceDate : undefined,
                    clientId: clientId(),
                });
                planner.announce(result, "Planned", () => plannerApi.update(result.block.id, { version: result.block.version, status: "cancelled" }));
            }
            close();
            await planner.refresh();
        } catch (error) {
            toast.error("Couldn't save that", errorMessage(error));
        } finally {
            setBusy(false);
        }
    };

    return (
        <PortalDialog
            isOpen={!!target}
            onOpenChange={(o) => !o && close()}
            title={target?.kind === "block" ? "Change planned time" : "Schedule time"}
            description={title}
            icon={CalendarPlus02}
            size="lg"
            onSubmit={(e) => {
                e.preventDefault();
                void save();
            }}
            footer={
                <>
                    <Button color="secondary" size="lg" onClick={close} isDisabled={busy}>
                        Cancel
                    </Button>
                    <Button type="submit" size="lg" isLoading={busy} showTextWhileLoading>
                        {target?.kind === "block" ? "Save" : conflicts.length ? "Schedule anyway" : "Schedule"}
                    </Button>
                </>
            }
        >
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <DateField label="Date" value={date} onChange={(v) => v && setDate(v)} />
                <Input label="Start" type="time" value={time} onChange={(v) => setTime(v || "09:00")} />
                <Select
                    label="Length"
                    value={String(minutes)}
                    onChange={(k) => k && setMinutes(Number(k))}
                    items={[...new Set([...DURATIONS, minutes])].sort((a, b) => a - b).map((m) => ({ id: String(m), label: durationLabel(m) }))}
                >
                    {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                </Select>
            </div>
            {target?.kind !== "block" && (
                <Select
                    label="Estimated effort"
                    hint="For the whole task. Suggestions plan whatever isn't scheduled yet."
                    value={estimate === null ? "none" : String(estimate)}
                    onChange={(k) => k && void saveEstimate(k === "none" ? null : Number(k))}
                    items={[
                        { id: "none", label: "No estimate" },
                        ...[...new Set([...ESTIMATES, ...(estimate ? [estimate] : [])])]
                            .sort((a, b) => a - b)
                            .map((m) => ({ id: String(m), label: durationLabel(m) })),
                    ]}
                >
                    {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                </Select>
            )}
            <ConflictList conflicts={conflicts} title="This time has conflicts. You can still schedule it." />
            {free && (
                <div className="flex flex-col gap-2">
                    <p className="text-sm font-medium text-secondary">Free on {longDateLabel(date)}</p>
                    {free.length ? (
                        <div className="flex flex-wrap gap-2" role="group" aria-label="Free time">
                            {free.slice(0, 8).map((f) => (
                                <Button key={f.startTime} size="xs" color="secondary" onClick={() => setTime(f.startTime)} aria-pressed={time === f.startTime}>
                                    {timeLabel(f.startTime)} – {timeLabel(f.endTime)} ({durationLabel(f.minutes)})
                                </Button>
                            ))}
                        </div>
                    ) : (
                        <p className="text-sm text-tertiary">No free time in your planning hours that day.</p>
                    )}
                </div>
            )}
            {target?.kind !== "block" && (
                <div className="flex flex-col gap-2">
                    <Button size="sm" color="link-color" iconLeading={Stars02} onClick={() => void suggest()} className="self-start">
                        Suggest times in the next week
                    </Button>
                    {suggestions &&
                        (suggestions.length ? (
                            <ul className="flex flex-col gap-1.5" aria-label="Suggested times">
                                {suggestions.slice(0, 6).map((s) => (
                                    <li
                                        key={s.id}
                                        className="flex flex-wrap items-center justify-between gap-2 rounded-lg px-3 py-2 ring-1 ring-secondary ring-inset"
                                    >
                                        <span className="text-sm text-secondary">
                                            {dayLabel(s.startDate)}, {timeLabel(s.startTime)} – {timeLabel(s.endTime)}
                                            <span className="block text-xs text-tertiary">{s.reason}</span>
                                        </span>
                                        <Button
                                            size="xs"
                                            color="secondary"
                                            onClick={() => {
                                                setDate(s.startDate);
                                                setTime(s.startTime);
                                                setMinutes(s.durationMinutes);
                                            }}
                                        >
                                            Use this time
                                        </Button>
                                    </li>
                                ))}
                            </ul>
                        ) : (
                            <p className="text-sm text-tertiary">No free time fits in the next week.</p>
                        ))}
                </div>
            )}
        </PortalDialog>
    );
};

// --- A block's panel -------------------------------------------------------------------------------

export const BlockPanel = ({ planner }: { planner: Planner }) => {
    const toast = useToast();
    const block = planner.openBlock;
    const [confirmCancel, setConfirmCancel] = useState(false);
    const current = block ? (planner.state.blocks.find((b) => b.id === block.id) ?? block) : null;
    const conflicts = current ? planner.state.conflicts.filter((c) => c.blockId === current.id) : [];
    const done = !!current && (current.taskStatus === "completed" || current.earlierOccurrence);
    const close = () => planner.setOpenBlock(null);

    const change = async (body: { durationMinutes?: number; status?: "cancelled" }, verb: string) => {
        if (!current) return;
        try {
            const result = await plannerApi.update(current.id, { version: current.version, ...body });
            planner.announce(result, verb);
            await planner.refresh();
            if (body.status) close();
            else planner.setOpenBlock(result.block);
        } catch (error) {
            toast.error("Couldn't change that", errorMessage(error));
            await planner.refresh();
        }
    };
    const complete = async () => {
        if (!current) return;
        try {
            // Tasks' own API and permissions. The block stays where it was, as a record of the time.
            const result = await tasksApi.complete(current.taskId, current.occurrenceDate ?? current.taskDueDate, false);
            toast.success(result.nextDate ? `Done. Next: ${dayLabel(result.nextDate)}` : "Task completed", current.title);
            await planner.refresh();
            close();
        } catch (error) {
            toast.error(
                error instanceof ApiError && error.code === "open_subtasks"
                    ? "Complete its subtasks first, or complete it in Tasks"
                    : "Couldn't complete the task",
                errorMessage(error),
            );
        }
    };

    return (
        <>
            <RecordPanel
                isOpen={!!current}
                onOpenChange={(o) => !o && close()}
                title={current?.title ?? ""}
                description={
                    current && (
                        <>
                            {longDateLabel(current.startDate)}, {timeLabel(current.startTime)} – {end(current)} ({durationLabel(current.durationMinutes)})
                        </>
                    )
                }
                leading={
                    current && (
                        <div className="flex flex-wrap gap-2">
                            <Badge size="sm" color="brand">
                                Planned time
                            </Badge>
                            {done && (
                                <Badge size="sm" color="success">
                                    {current.earlierOccurrence ? "That occurrence is done" : "Task completed"}
                                </Badge>
                            )}
                            {current.source === "suggestion" && (
                                <Badge size="sm" color="gray">
                                    From a suggestion
                                </Badge>
                            )}
                        </div>
                    )
                }
                footer={
                    current && (
                        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-between">
                            <Button color="secondary-destructive" onClick={() => setConfirmCancel(true)} isDisabled={!current.canEdit}>
                                Cancel this time
                            </Button>
                            {!done && (
                                <Button color="primary" iconLeading={CheckCircle} onClick={() => void complete()}>
                                    Complete task
                                </Button>
                            )}
                        </div>
                    )
                }
            >
                {current && (
                    <div className="flex flex-col gap-5">
                        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                            <dt className="text-tertiary">Project</dt>
                            <dd className="text-primary">{current.projectName}</dd>
                            <dt className="text-tertiary">Task due</dt>
                            <dd className="text-primary">
                                {current.taskDueDate
                                    ? `${dayLabel(current.taskDueDate)}${current.taskDueTime ? `, ${timeLabel(current.taskDueTime)}` : ""}`
                                    : "No date"}
                                {current.recurring && current.occurrenceDate && (
                                    <span className="text-tertiary"> · for the {dayLabel(current.occurrenceDate)} occurrence</span>
                                )}
                            </dd>
                            {current.blockTimeZone && (
                                <>
                                    <dt className="text-tertiary">Planned in</dt>
                                    <dd className="text-primary">{current.blockTimeZone.replace(/_/g, " ")}</dd>
                                </>
                            )}
                        </dl>
                        <ConflictList conflicts={conflicts} />
                        {current.canEdit && !done && (
                            <div className="flex flex-col gap-3">
                                <p className="text-sm font-medium text-secondary">Adjust</p>
                                <div className="flex flex-wrap gap-2">
                                    <Button
                                        size="sm"
                                        color="secondary"
                                        onClick={() => {
                                            planner.setTarget({ kind: "block", block: current });
                                            close();
                                        }}
                                    >
                                        Move or change length
                                    </Button>
                                    <Button
                                        size="sm"
                                        color="secondary"
                                        isDisabled={current.durationMinutes <= 15}
                                        onClick={() => void change({ durationMinutes: current.durationMinutes - 15 }, "Shortened")}
                                    >
                                        15 min shorter
                                    </Button>
                                    <Button
                                        size="sm"
                                        color="secondary"
                                        isDisabled={current.durationMinutes >= 705}
                                        onClick={() => void change({ durationMinutes: current.durationMinutes + 15 }, "Lengthened")}
                                    >
                                        15 min longer
                                    </Button>
                                </div>
                            </div>
                        )}
                        <Button size="sm" color="link-color" href={`/portal/tasks/t/${current.taskId}`} className="self-start">
                            Open the task in Tasks
                        </Button>
                    </div>
                )}
            </RecordPanel>
            <ConfirmDialog
                isOpen={confirmCancel}
                onOpenChange={setConfirmCancel}
                title="Cancel this planned time?"
                description="The time is freed. The task itself doesn't change."
                confirmLabel="Cancel the time"
                destructive
                onConfirm={async () => {
                    await change({ status: "cancelled" }, "Cancelled");
                    setConfirmCancel(false);
                }}
            />
        </>
    );
};
