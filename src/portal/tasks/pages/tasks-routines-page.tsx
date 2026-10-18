// Routines: the ongoing responsibilities of a home (bins, bills, smoke alarms, the car's service).
//
// Each routine is a repeating task, so it's completed, skipped, rescheduled and edited exactly like
// one, from here or from any list, and its history is the task's own. This page adds what a task
// doesn't show at a glance: who's responsible now and who's next when people take turns, when it
// was last done and by whom, and pausing (a paused routine stays out of Today and the dashboards).
import { useCallback, useState } from "react";
import { CheckCircle, ClockRewind, Edit05, PauseCircle, PlayCircle, Plus, Repeat04, SkipForward, Trash01, Users01 } from "@untitledui/icons";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { Checkbox } from "@/components/base/checkbox/checkbox";
import { Input } from "@/components/base/input/input";
import { RadioButton, RadioGroup } from "@/components/base/radio-buttons/radio-buttons";
import { Select } from "@/components/base/select/select";
import { TextArea } from "@/components/base/textarea/textarea";
import { DateField } from "@/portal/components/date-field";
import { ConfirmDialog, PortalDialog } from "@/portal/components/dialog";
import { Empty } from "@/portal/components/empty";
import { Notice } from "@/portal/components/notice";
import { useToast } from "@/portal/components/toast";
import { ApiError, errorMessage } from "@/portal/lib/api";
import { formatDate, formatRelative } from "@/portal/lib/format";
import type { PageData } from "@/portal/lib/page-types";
import { relativeDate } from "@/shared/tasks/dates";
import { ROTATION_LABELS, type Rotation, type TaskRoutine } from "@/shared/tasks/productivity";
import { type RecurrenceInput, describeRule, firstOnOrAfter, recurrenceInput, withAnchor } from "@/shared/tasks/recurrence";
import { cx } from "@/utils/cx";
import { productivityApi } from "../productivity-api";
import { Quiet } from "../productivity-ui";
import { draftId } from "../quick-add-events";
import { RecurrenceEditor } from "../recurrence-editor";
import { DueBadge, ProjectDot, personLabel, titleOf } from "../shared";
import { useTaskChanges, useTasks } from "../tasks-context";
import { TasksHeader, TasksLayout } from "../tasks-layout";
import { useTaskActions } from "../use-task-actions";

const issues = (e: unknown) => (e instanceof ApiError && e.issues.length ? e.issues.map((i) => i.message).join(" ") : errorMessage(e));

export const TasksRoutinesPage = ({ data }: { data: PageData<"tasks-routines"> }) => (
    <TasksLayout shell={data}>
        <RoutinesBody data={data} />
    </TasksLayout>
);

const RoutinesBody = ({ data }: { data: PageData<"tasks-routines"> }) => {
    const [routines, setRoutines] = useState(data.routines);
    const [creating, setCreating] = useState(false);
    const reload = useCallback(async () => {
        try {
            setRoutines((await productivityApi.routines()).routines);
        } catch {
            // Keep what's shown.
        }
    }, []);
    useTaskChanges(() => void reload());
    const replace = (routine: TaskRoutine) => setRoutines((list) => list.map((r) => (r.id === routine.id ? routine : r)));
    const groups = [
        { id: "shared", title: "Household", items: routines.filter((r) => r.project.kind === "shared" && !r.paused) },
        { id: "personal", title: "Personal", items: routines.filter((r) => r.project.kind === "personal" && !r.paused) },
        { id: "paused", title: "Paused", items: routines.filter((r) => r.paused) },
    ].filter((g) => g.items.length);
    return (
        <>
            <TasksHeader
                title="Routines"
                description="Ongoing responsibilities: what needs doing, who's on it, and when it was last done."
                crumb={{ label: "Routines" }}
                actions={
                    <Button size="sm" iconLeading={Plus} onClick={() => setCreating(true)}>
                        New routine
                    </Button>
                }
            />
            {routines.length ? (
                groups.map((g) => (
                    <section key={g.id} className="flex flex-col gap-4" aria-label={g.title}>
                        <h2 className="text-md font-semibold text-primary">{g.title}</h2>
                        <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                            {g.items.map((r) => (
                                <RoutineCard key={r.id} routine={r} onChange={replace} onRemoved={() => void reload()} />
                            ))}
                        </ul>
                    </section>
                ))
            ) : (
                <Empty
                    icon={Repeat04}
                    title="No routines yet"
                    description="Bins every Wednesday, bills on the 1st, smoke alarms twice a year. In a shared project, people can take turns."
                    actions={
                        <Button size="md" iconLeading={Plus} onClick={() => setCreating(true)}>
                            New routine
                        </Button>
                    }
                />
            )}
            {creating && <RoutineDialog onClose={() => setCreating(false)} onSaved={() => void reload()} />}
        </>
    );
};

const RoutineCard = ({ routine: r, onChange, onRemoved }: { routine: TaskRoutine; onChange: (r: TaskRoutine) => void; onRemoved: () => void }) => {
    const { today, openTask, shell } = useTasks();
    const actions = useTaskActions();
    const toast = useToast();
    const [editing, setEditing] = useState(false);
    const [history, setHistory] = useState<Awaited<ReturnType<typeof productivityApi.routineHistory>>["entries"] | null>(null);
    const [stopping, setStopping] = useState(false);
    const people = [...r.participants, ...Object.values(shell.assignable).flat()];
    const last = r.recent[0];
    const overdue = !!r.task.dueDate && r.task.dueDate < today;
    const run = async (work: () => Promise<{ routine: TaskRoutine }>) => {
        try {
            onChange((await work()).routine);
        } catch (e) {
            toast.error("That didn't work", issues(e));
        }
    };
    return (
        <li
            id={r.id}
            className={cx(
                "flex flex-col gap-3 rounded-xl bg-primary p-5 shadow-xs ring-1 ring-inset",
                overdue && !r.paused ? "ring-error_subtle" : "ring-secondary",
            )}
        >
            <div className="flex items-start justify-between gap-3">
                <button
                    type="button"
                    onClick={() => openTask(r.task.id)}
                    className="min-w-0 cursor-pointer rounded-sm text-left text-md font-semibold text-primary outline-focus-ring hover:underline focus-visible:outline-2"
                >
                    {titleOf(r.task.title)}
                </button>
                {r.paused ? (
                    <Badge size="sm" type="color" color="gray">
                        Paused
                    </Badge>
                ) : (
                    <DueBadge task={r.task} today={today} />
                )}
            </div>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
                <dt className="text-tertiary">Repeats</dt>
                <dd className="text-secondary">{r.task.recurrence ? describeRule(r.task.recurrence) : "—"}</dd>
                <dt className="text-tertiary">Where</dt>
                <dd className="flex items-center gap-1.5 truncate text-secondary">
                    <ProjectDot color={r.project.color} />
                    <span className="truncate">{r.project.name}</span>
                </dd>
                {r.project.kind === "shared" && (
                    <>
                        <dt className="text-tertiary">Responsible</dt>
                        <dd className="text-secondary">
                            {r.responsible ? personLabel(r.responsible, people) : "Nobody yet"}
                            {r.nextUp && r.nextUp !== r.responsible && <span className="text-tertiary"> · then {personLabel(r.nextUp, people)}</span>}
                        </dd>
                    </>
                )}
                {r.task.subtasks.total > 0 && (
                    <>
                        <dt className="text-tertiary">Checklist</dt>
                        <dd className="text-secondary">
                            {r.task.subtasks.total - r.task.subtasks.open} of {r.task.subtasks.total} ticked
                        </dd>
                    </>
                )}
                <dt className="text-tertiary">Last done</dt>
                <dd className="text-secondary">
                    {last ? (
                        <>
                            {last.kind === "skipped" ? "Skipped " : ""}
                            {formatRelative(last.at)} by {last.byName ?? personLabel(last.by, people)}
                        </>
                    ) : (
                        "Not yet"
                    )}
                </dd>
            </dl>
            {r.rotation === "turns" && (
                <p className="flex items-center gap-1.5 text-xs text-tertiary">
                    <Users01 aria-hidden="true" className="size-3.5" />
                    Taking turns: {r.participants.map((p) => personLabel(p.email, people)).join(", ")}
                </p>
            )}
            {r.canEdit && (
                <div className="mt-auto flex flex-wrap gap-2 border-t border-secondary pt-3">
                    {!r.paused && r.task.status === "open" && (
                        <>
                            <Button size="sm" iconLeading={CheckCircle} onClick={() => void actions.complete(r.task)}>
                                Done
                            </Button>
                            <Button size="sm" color="secondary" iconLeading={SkipForward} onClick={() => void actions.skip(r.task)}>
                                Skip
                            </Button>
                        </>
                    )}
                    <Button
                        size="sm"
                        color="secondary"
                        iconLeading={r.paused ? PlayCircle : PauseCircle}
                        onClick={() => void run(() => productivityApi.pauseRoutine(r.id, r.version, !r.paused))}
                    >
                        {r.paused ? "Resume" : "Pause"}
                    </Button>
                    {r.project.kind === "shared" && (
                        <Button size="sm" color="secondary" iconLeading={Edit05} onClick={() => setEditing(true)}>
                            Turns
                        </Button>
                    )}
                    <Button
                        size="sm"
                        color="tertiary"
                        iconLeading={ClockRewind}
                        onClick={async () => setHistory(history ? null : (await productivityApi.routineHistory(r.id).catch(() => ({ entries: [] }))).entries)}
                        aria-expanded={!!history}
                    >
                        History
                    </Button>
                    <Button
                        size="sm"
                        color="tertiary"
                        iconLeading={Trash01}
                        onClick={() => setStopping(true)}
                        aria-label={`Stop treating “${r.task.title}” as a routine`}
                    >
                        <span className="max-sm:sr-only">Stop</span>
                    </Button>
                </div>
            )}
            {history && (
                <ul className="flex flex-col gap-1 text-sm" aria-label="Completion history">
                    {history.length ? (
                        history.map((h) => (
                            <li key={h.id} className="flex justify-between gap-3">
                                <span className="text-secondary">
                                    {h.kind === "skipped" ? "Skipped" : "Done"}
                                    {h.occurrenceDate ? ` · ${formatDate(h.occurrenceDate)}` : ""}
                                </span>
                                <span className="truncate text-tertiary">{h.byName ?? personLabel(h.by, people)}</span>
                            </li>
                        ))
                    ) : (
                        <Quiet>Not done yet.</Quiet>
                    )}
                </ul>
            )}
            {actions.dialogs}
            {editing && <TurnsDialog routine={r} onClose={() => setEditing(false)} onSaved={onChange} />}
            <ConfirmDialog
                isOpen={stopping}
                onOpenChange={setStopping}
                title="Stop treating this as a routine?"
                description="The task, its schedule and its history stay exactly as they are. It just leaves this page and nobody takes turns any more."
                confirmLabel="Stop"
                onConfirm={async () => {
                    try {
                        await productivityApi.deleteRoutine(r.id);
                        onRemoved();
                    } catch (e) {
                        toast.error("Couldn't change it", issues(e));
                    }
                }}
            />
        </li>
    );
};

/** Who takes turns, and in what order. Only people who can be assigned in the project are offered. */
const TurnsDialog = ({ routine, onClose, onSaved }: { routine: TaskRoutine; onClose: () => void; onSaved: (r: TaskRoutine) => void }) => {
    const { assignable } = useTasks();
    const options = assignable(routine.project.id);
    const [rotation, setRotation] = useState<Rotation>(routine.rotation);
    const [order, setOrder] = useState<string[]>(routine.participants.map((p) => p.email));
    const [error, setError] = useState<string | null>(null);
    return (
        <PortalDialog
            isOpen
            onOpenChange={(open) => !open && onClose()}
            title="Who's responsible"
            icon={Users01}
            description="When people take turns, completing an occurrence passes it to the next person. Skipping keeps it with the same person."
            onSubmit={async () => {
                try {
                    onSaved(
                        (await productivityApi.updateRoutine(routine.id, routine.version, { rotation, participants: rotation === "turns" ? order : [] }))
                            .routine,
                    );
                    onClose();
                } catch (e) {
                    setError(issues(e));
                }
            }}
            footer={
                <>
                    <Button color="secondary" size="md" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button type="submit" size="md">
                        Save
                    </Button>
                </>
            }
        >
            {error && (
                <Notice color="error" title="Not saved">
                    {error}
                </Notice>
            )}
            <TurnsFields options={options} rotation={rotation} onRotation={setRotation} order={order} onOrder={setOrder} />
        </PortalDialog>
    );
};

const TurnsFields = ({
    options,
    rotation,
    onRotation,
    order,
    onOrder,
}: {
    options: { email: string; name: string | null }[];
    rotation: Rotation;
    onRotation: (r: Rotation) => void;
    order: string[];
    onOrder: (o: string[]) => void;
}) => (
    <>
        <RadioGroup aria-label="Responsibility" value={rotation} onChange={(v) => onRotation(v as Rotation)}>
            <RadioButton value="none" label={ROTATION_LABELS.none} hint="Whoever it's assigned to (or nobody) stays responsible." />
            <RadioButton value="turns" label={ROTATION_LABELS.turns} hint="In the order ticked below." isDisabled={options.length < 2} />
        </RadioGroup>
        {rotation === "turns" && (
            <fieldset className="flex flex-col gap-2">
                <legend className="mb-2 text-sm font-medium text-secondary">People, in turn order</legend>
                {options.map((p) => (
                    <Checkbox
                        key={p.email}
                        label={`${order.includes(p.email) ? `${order.indexOf(p.email) + 1}. ` : ""}${p.name ?? p.email}`}
                        isSelected={order.includes(p.email)}
                        onChange={(on) => onOrder(on ? [...order, p.email] : order.filter((e) => e !== p.email))}
                    />
                ))}
            </fieldset>
        )}
    </>
);

const RoutineDialog = ({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) => {
    const { writable, shell, today, assignable } = useTasks();
    const toast = useToast();
    const [title, setTitle] = useState("");
    const [description, setDescription] = useState("");
    const [projectId, setProjectId] = useState(shell.inboxId);
    const [start, setStart] = useState<string | null>(today);
    const [rule, setRule] = useState<RecurrenceInput | null>({ freq: "weekly", interval: 1, weekdays: [3] } as RecurrenceInput);
    const [checklist, setChecklist] = useState("");
    const [rotation, setRotation] = useState<Rotation>("none");
    const [order, setOrder] = useState<string[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [clientId] = useState(draftId);
    const project = writable.find((p) => p.id === projectId);
    const anchor = start ?? today;
    const parsed = rule ? recurrenceInput.safeParse(rule) : null;
    const draft = parsed?.success ? withAnchor(parsed.data, anchor) : null;
    const first = draft ? firstOnOrAfter(draft, anchor) : null;
    return (
        <PortalDialog
            isOpen
            onOpenChange={(open) => !open && onClose()}
            title="New routine"
            icon={Repeat04}
            size="md"
            description="A repeating task you look after. Put it in a shared project for the household to see it."
            onSubmit={async () => {
                if (!title.trim()) return setError("Give the routine a name");
                if (!rule) return setError("Choose how often it repeats");
                setBusy(true);
                setError(null);
                try {
                    await productivityApi.createRoutine({
                        title,
                        description,
                        projectId,
                        dueDate: start,
                        recurrence: rule,
                        rotation: project?.kind === "shared" ? rotation : "none",
                        participants: project?.kind === "shared" && rotation === "turns" ? order : [],
                        checklist: checklist
                            .split("\n")
                            .map((l) => l.trim())
                            .filter(Boolean),
                        clientId,
                    });
                    toast.success("Routine added", first ? `First due ${relativeDate(first, today)}` : undefined);
                    onSaved();
                    onClose();
                } catch (e) {
                    setError(issues(e));
                } finally {
                    setBusy(false);
                }
            }}
            footer={
                <>
                    <Button color="secondary" size="md" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button type="submit" size="md" isLoading={busy} showTextWhileLoading>
                        Add routine
                    </Button>
                </>
            }
        >
            {error && (
                <Notice color="error" title="Not added">
                    {error}
                </Notice>
            )}
            <Input label="Routine" isRequired value={title} onChange={setTitle} autoFocus placeholder="e.g. Put the bins out" />
            <TextArea label="Notes" rows={2} value={description} onChange={setDescription} hint="Optional" />
            <Select
                label="Project"
                size="sm"
                value={projectId}
                onChange={(key) => key && setProjectId(String(key))}
                items={writable.map((p) => ({ id: p.id, label: p.isInbox ? "Inbox (only you)" : `${p.name}${p.kind === "shared" ? " · shared" : ""}` }))}
            >
                {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
            </Select>
            <div className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-secondary">Repeats</span>
                <RecurrenceEditor rule={draft} anchor={anchor} onChange={setRule} />
                {first && <span className="text-xs text-tertiary">First due {relativeDate(first, today)}</span>}
            </div>
            <DateField label="Starting from" value={start} onChange={setStart} />
            <TextArea
                label="Checklist"
                rows={3}
                value={checklist}
                onChange={setChecklist}
                hint="Optional, one item per line. It's ticked off each time and starts fresh for the next."
            />
            {project?.kind === "shared" && (
                <TurnsFields options={assignable(project.id)} rotation={rotation} onRotation={setRotation} order={order} onOrder={setOrder} />
            )}
        </PortalDialog>
    );
};
