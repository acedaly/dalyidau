// Tasks: the wedding's own task list (/api/portal/wedding/tasks, separate from Personal Tasks).
// Add one with an optional due date, tick it off, or open it to change its title, date or notes.
import { useMemo, useState } from "react";
import { CheckCircle, Plus } from "@untitledui/icons";
import { Badge } from "@/components/base/badges/badges";
import { ButtonGroup, ButtonGroupItem } from "@/components/base/button-group/button-group";
import { Button } from "@/components/base/buttons/button";
import { Checkbox } from "@/components/base/checkbox/checkbox";
import { Input } from "@/components/base/input/input";
import { TextArea } from "@/components/base/textarea/textarea";
import { RecordPanel } from "@/portal/components/record-panel";
import { useToast } from "@/portal/components/toast";
import { errorMessage } from "@/portal/lib/api";
import { formatDate, pluralise, todayIso } from "@/portal/lib/format";
import { usePortal } from "@/portal/portal-context";
import type { Task } from "@/shared/portal/types";
import { EmptyRow, LoadError, LoadingRows, PageTitle, Row, RowList, Section } from "../components";
import { TASKS, change, useApi } from "../data";

const addDays = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** Open tasks by when they're due; done tasks most recent first. */
const groupOpen = (tasks: Task[], today: string) => {
    const week = addDays(today, 7);
    const groups: { label: string; tasks: Task[] }[] = [
        { label: "Overdue", tasks: [] },
        { label: "This week", tasks: [] },
        { label: "Later", tasks: [] },
        { label: "No due date", tasks: [] },
    ];
    for (const task of tasks) {
        const index = !task.dueDate ? 3 : task.dueDate < today ? 0 : task.dueDate <= week ? 1 : 2;
        groups[index].tasks.push(task);
    }
    for (const group of groups) group.tasks.sort((a, b) => (a.dueDate ?? "").localeCompare(b.dueDate ?? "") || a.title.localeCompare(b.title));
    return groups.filter((group) => group.tasks.length > 0);
};

const TaskRow = ({ task, today, onOpen }: { task: Task; today: string; onOpen: () => void }) => {
    const toast = useToast();
    const { can } = usePortal();
    const [done, setDone] = useState(task.status === "done");
    const overdue = task.status !== "done" && !!task.dueDate && task.dueDate < today;
    const toggle = async (selected: boolean) => {
        setDone(selected);
        try {
            await change("PATCH", `${TASKS}/${task.id}`, { status: selected ? "done" : "todo" }, [TASKS]);
            toast.success(selected ? "Done" : "Reopened", task.title);
        } catch (e) {
            setDone(!selected);
            toast.error("Couldn't update the task", errorMessage(e));
        }
    };
    const detail = [task.dueDate ? `${overdue ? "Overdue · " : ""}${formatDate(task.dueDate)}` : null, task.category].filter(Boolean).join(" · ");
    return (
        <li className="flex items-center">
            <span className="pl-4">
                <Checkbox
                    aria-label={`Mark "${task.title}" ${done ? "not done" : "done"}`}
                    isSelected={done}
                    onChange={(selected) => void toggle(selected)}
                    isDisabled={!can("wedding.planning.edit")}
                />
            </span>
            <div className="min-w-0 flex-1">
                <Row
                    bare
                    title={<span className={done ? "text-tertiary line-through" : undefined}>{task.title}</span>}
                    detail={detail ? <span className={overdue ? "text-error-primary" : undefined}>{detail}</span> : undefined}
                    trailing={
                        task.priority === "high" && task.status !== "done" ? (
                            <Badge size="sm" type="pill-color" color="error">
                                High
                            </Badge>
                        ) : undefined
                    }
                    onPress={onOpen}
                    className="pl-3"
                />
            </div>
        </li>
    );
};

const TaskSheet = ({ task, onClose }: { task: Task; onClose: () => void }) => {
    const toast = useToast();
    const { can } = usePortal();
    const editable = can("wedding.planning.edit");
    const [draft, setDraft] = useState({ title: task.title, dueDate: task.dueDate ?? "", notes: task.notes ?? "" });
    const [busy, setBusy] = useState(false);
    const save = async () => {
        setBusy(true);
        try {
            await change("PATCH", `${TASKS}/${task.id}`, { title: draft.title.trim(), dueDate: draft.dueDate || null, notes: draft.notes.trim() || null }, [
                TASKS,
            ]);
            toast.success("Task saved");
            onClose();
        } catch (e) {
            toast.error("Couldn't save the task", errorMessage(e));
        } finally {
            setBusy(false);
        }
    };
    return (
        <RecordPanel
            isOpen
            onOpenChange={(open) => !open && onClose()}
            title={editable ? "Edit task" : task.title}
            onSubmit={editable ? () => void save() : undefined}
            footer={
                editable && (
                    <>
                        <Button color="secondary" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button type="submit" isLoading={busy} isDisabled={!draft.title.trim()}>
                            Save
                        </Button>
                    </>
                )
            }
        >
            <div className="flex flex-col gap-4">
                <Input label="Task" isRequired isReadOnly={!editable} value={draft.title} onChange={(title) => setDraft((d) => ({ ...d, title }))} />
                <Input label="Due" type="date" isReadOnly={!editable} value={draft.dueDate} onChange={(dueDate) => setDraft((d) => ({ ...d, dueDate }))} />
                <TextArea label="Notes" rows={4} isReadOnly={!editable} value={draft.notes} onChange={(notes) => setDraft((d) => ({ ...d, notes }))} />
            </div>
        </RecordPanel>
    );
};

const AddTask = () => {
    const toast = useToast();
    const [title, setTitle] = useState("");
    const [due, setDue] = useState("");
    const [busy, setBusy] = useState(false);
    const add = async () => {
        if (!title.trim() || busy) return;
        setBusy(true);
        try {
            await change("POST", TASKS, { title: title.trim(), dueDate: due || null }, [TASKS]);
            setTitle("");
            setDue("");
            toast.success("Task added");
        } catch (e) {
            toast.error("Couldn't add the task", errorMessage(e));
        } finally {
            setBusy(false);
        }
    };
    return (
        <form
            className="flex flex-col gap-2 rounded-2xl bg-primary p-2 shadow-xs ring-1 ring-secondary ring-inset sm:flex-row sm:items-center"
            onSubmit={(event) => {
                event.preventDefault();
                void add();
            }}
        >
            <Input aria-label="New task" placeholder="Add a task…" value={title} onChange={setTitle} wrapperClassName="flex-1" />
            <div className="flex items-center gap-2">
                <Input aria-label="Due date (optional)" type="date" value={due} onChange={setDue} wrapperClassName="flex-1 sm:w-40" />
                <Button type="submit" iconLeading={Plus} isDisabled={!title.trim()} isLoading={busy}>
                    Add
                </Button>
            </div>
        </form>
    );
};

export const TasksView = () => {
    const { wedding, can } = usePortal();
    const { data, error, reload } = useApi<{ items: Task[] }>(TASKS);
    const [show, setShow] = useState<"open" | "done">("open");
    const [openId, setOpenId] = useState<string | null>(null);
    const today = todayIso(wedding.timeZone);
    const tasks = data?.items ?? [];
    const open = tasks.filter((task) => task.status !== "done");
    const done = tasks.filter((task) => task.status === "done").sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""));
    const groups = useMemo(() => groupOpen(open, today), [open, today]);
    const selected = tasks.find((task) => task.id === openId) ?? null;

    return (
        <>
            <PageTitle title="Tasks" subtitle={data ? `${pluralise(open.length, "open task")} · ${done.length} done` : undefined} />
            {can("wedding.planning.edit") && <AddTask />}
            <ButtonGroup
                aria-label="Show"
                size="sm"
                selectionMode="single"
                disallowEmptySelection
                selectedKeys={new Set([show])}
                onSelectionChange={(keys) => setShow(([...keys][0] as "open" | "done") ?? "open")}
            >
                <ButtonGroupItem id="open">Open</ButtonGroupItem>
                <ButtonGroupItem id="done">Done</ButtonGroupItem>
            </ButtonGroup>

            {error && !data ? (
                <Section>
                    <LoadError error={error} onRetry={reload} />
                </Section>
            ) : !data ? (
                <Section flush>
                    <LoadingRows />
                </Section>
            ) : show === "open" ? (
                groups.length === 0 ? (
                    <Section>
                        <EmptyRow icon={CheckCircle}>Nothing left to do. Add a task above.</EmptyRow>
                    </Section>
                ) : (
                    groups.map((group) => (
                        <Section key={group.label} label={group.label} flush>
                            <RowList>
                                {group.tasks.map((task) => (
                                    <TaskRow key={`${task.id}-${task.updatedAt}`} task={task} today={today} onOpen={() => setOpenId(task.id)} />
                                ))}
                            </RowList>
                        </Section>
                    ))
                )
            ) : done.length === 0 ? (
                <Section>
                    <EmptyRow icon={CheckCircle}>No finished tasks yet.</EmptyRow>
                </Section>
            ) : (
                <Section label="Done" flush>
                    <RowList>
                        {done.map((task) => (
                            <TaskRow key={`${task.id}-${task.updatedAt}`} task={task} today={today} onOpen={() => setOpenId(task.id)} />
                        ))}
                    </RowList>
                </Section>
            )}

            {selected && <TaskSheet key={selected.id} task={selected} onClose={() => setOpenId(null)} />}
        </>
    );
};
