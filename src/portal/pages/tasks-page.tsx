import { useMemo, useState } from "react";
import { CheckDone01, Download01, Plus } from "@untitledui/icons";
import { Tabs } from "@/components/application/tabs/tabs";
import { ButtonGroup, ButtonGroupItem } from "@/components/base/button-group/button-group";
import { Button } from "@/components/base/buttons/button";
import { Checkbox } from "@/components/base/checkbox/checkbox";
import { Input } from "@/components/base/input/input";
import { Select } from "@/components/base/select/select";
import { TextArea } from "@/components/base/textarea/textarea";
import { type DataColumn, DataTable } from "@/portal/components/data-table";
import { DateField } from "@/portal/components/date-field";
import { Empty } from "@/portal/components/empty";
import { EntityPanel } from "@/portal/components/entity-panel";
import { FormGrid, FullWidth } from "@/portal/components/form";
import { MetricCard } from "@/portal/components/metric-card";
import { MonthCalendar } from "@/portal/components/month-calendar";
import { PageHeader } from "@/portal/components/page-header";
import { PRIORITY_LABELS, PriorityBadge, TASK_STATUS_LABELS, TaskStatusBadge } from "@/portal/components/status";
import { useToast } from "@/portal/components/toast";
import { useCollection } from "@/portal/hooks/use-collection";
import { errorMessage } from "@/portal/lib/api";
import { formatDate, percent, pluralise, todayIso } from "@/portal/lib/format";
import type { PageData } from "@/portal/lib/page-types";
import { usePortal } from "@/portal/portal-context";
import type { Task, TaskPriority, TaskStatus } from "@/shared/portal/types";
import { cx } from "@/utils/cx";

interface Draft {
    title: string;
    notes: string;
    status: TaskStatus;
    priority: TaskPriority;
    category: string;
    dueDate: string | null;
    assignee: string | null;
}

const toDraft = (t: Task | null): Draft => ({
    title: t?.title ?? "",
    notes: t?.notes ?? "",
    status: t?.status ?? "todo",
    priority: t?.priority ?? "medium",
    category: t?.category ?? "",
    dueDate: t?.dueDate ?? null,
    assignee: t?.assignee ?? null,
});

export const TasksPage = ({ data }: { data: PageData<"tasks"> }) => {
    const { can, wedding } = usePortal();
    const toast = useToast();
    const tasks = useCollection<Task>("tasks", data.tasks);
    const [view, setView] = useState<"list" | "calendar">("list");
    const [status, setStatus] = useState<"open" | TaskStatus | "all">("open");
    const [assignee, setAssignee] = useState("all");
    const [editing, setEditing] = useState<Task | null>(null);
    const [open, setOpen] = useState(false);
    const [draft, setDraft] = useState<Draft>(toDraft(null));
    const [quickTitle, setQuickTitle] = useState("");
    const canEdit = can("wedding.planning.edit");
    const today = todayIso(wedding.timeZone);

    const counts = useMemo(() => {
        const done = tasks.items.filter((t) => t.status === "done").length;
        const overdue = tasks.items.filter((t) => t.status !== "done" && t.dueDate && t.dueDate < today).length;
        return { total: tasks.items.length, done, overdue, open: tasks.items.length - done };
    }, [tasks.items, today]);

    const visible = tasks.items.filter(
        (t) =>
            (status === "all" || (status === "open" ? t.status !== "done" : t.status === status)) &&
            (assignee === "all" || (assignee === "none" ? !t.assignee : t.assignee === assignee)),
    );

    const openPanel = (task: Task | null) => {
        setEditing(task);
        setDraft(toDraft(task));
        setOpen(true);
    };

    const toggleDone = async (task: Task, done: boolean) => {
        try {
            await tasks.update(task.id, { status: done ? "done" : "todo" });
        } catch (e) {
            toast.error("Couldn't update the task", errorMessage(e));
        }
    };

    const quickAdd = async () => {
        const title = quickTitle.trim();
        if (!title) return;
        try {
            await tasks.create({ title });
            setQuickTitle("");
        } catch (e) {
            toast.error("Couldn't add the task", errorMessage(e));
        }
    };

    const assigneeName = (email: string | null) => (email ? (data.assignees.find((a) => a.email === email)?.name ?? email) : null);

    const columns: DataColumn<Task>[] = [
        {
            id: "title",
            label: "Task",
            isRowHeader: true,
            sortValue: (t) => t.title,
            render: (t) => (
                <div className="flex items-start gap-3">
                    <div onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} className="pt-0.5">
                        <Checkbox
                            aria-label={`Mark “${t.title}” done`}
                            isSelected={t.status === "done"}
                            isDisabled={!canEdit}
                            onChange={(on) => toggleDone(t, on)}
                        />
                    </div>
                    <div className="min-w-0">
                        <p className={cx("font-medium text-primary", t.status === "done" && "text-quaternary line-through")}>{t.title}</p>
                        {t.category && <p className="text-tertiary">{t.category}</p>}
                    </div>
                </div>
            ),
        },
        { id: "status", label: "Status", sortValue: (t) => t.status, render: (t) => <TaskStatusBadge status={t.status} />, className: "max-md:hidden" },
        {
            id: "due",
            label: "Due",
            sortValue: (t) => t.dueDate,
            render: (t) =>
                t.dueDate ? (
                    <span className={cx(t.status !== "done" && t.dueDate < today && "font-medium text-error-primary")}>{formatDate(t.dueDate)}</span>
                ) : (
                    <span className="text-quaternary">—</span>
                ),
        },
        {
            id: "priority",
            label: "Priority",
            sortValue: (t) => ({ high: 0, medium: 1, low: 2 })[t.priority],
            render: (t) => <PriorityBadge priority={t.priority} />,
            className: "max-lg:hidden",
        },
        {
            id: "assignee",
            label: "Owner",
            sortValue: (t) => t.assignee,
            render: (t) => assigneeName(t.assignee) ?? <span className="text-quaternary">—</span>,
            className: "max-lg:hidden",
        },
    ];

    return (
        <>
            <PageHeader
                title="Tasks"
                description="Everything that needs doing before the day."
                breadcrumbs={[{ label: "Tasks" }]}
                actions={
                    <>
                        {can("wedding.export") && tasks.items.length > 0 && (
                            <Button color="secondary" iconLeading={Download01} href="/api/portal/export/tasks.csv" download>
                                Export
                            </Button>
                        )}
                        {canEdit && (
                            <Button iconLeading={Plus} onClick={() => openPanel(null)}>
                                Add task
                            </Button>
                        )}
                    </>
                }
            />

            <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
                <MetricCard
                    label="Progress"
                    value={`${percent(counts.done, counts.total)}%`}
                    progress={percent(counts.done, counts.total)}
                    progressLabel={`${counts.done} of ${counts.total} done`}
                />
                <MetricCard label="Open" value={counts.open} />
                <MetricCard label="Overdue" value={counts.overdue} detail={counts.overdue ? "Past their due date" : "Nothing overdue"} />
            </div>

            <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                    <Tabs selectedKey={status} onSelectionChange={(k) => setStatus(k as typeof status)}>
                        <Tabs.List type="button-minimal" size="sm" aria-label="Filter by status">
                            <Tabs.Item id="open">Open</Tabs.Item>
                            <Tabs.Item id="todo">{TASK_STATUS_LABELS.todo}</Tabs.Item>
                            <Tabs.Item id="in_progress">{TASK_STATUS_LABELS.in_progress}</Tabs.Item>
                            <Tabs.Item id="done">{TASK_STATUS_LABELS.done}</Tabs.Item>
                            <Tabs.Item id="all">All</Tabs.Item>
                        </Tabs.List>
                    </Tabs>
                    {data.assignees.length > 1 && (
                        <Select
                            aria-label="Owner"
                            size="sm"
                            className="sm:w-48"
                            items={[
                                { id: "all", label: "Everyone" },
                                { id: "none", label: "Unassigned" },
                                ...data.assignees.map((a) => ({ id: a.email, label: a.name ?? a.email })),
                            ]}
                            value={assignee}
                            onChange={(v) => setAssignee(String(v))}
                        >
                            {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                        </Select>
                    )}
                </div>
                <ButtonGroup
                    size="sm"
                    selectionMode="single"
                    disallowEmptySelection
                    selectedKeys={[view]}
                    onSelectionChange={(keys) => setView([...keys][0] as "list" | "calendar")}
                    aria-label="View"
                >
                    <ButtonGroupItem id="list">List</ButtonGroupItem>
                    <ButtonGroupItem id="calendar">Calendar</ButtonGroupItem>
                </ButtonGroup>
            </div>

            {canEdit && (
                <form
                    className="flex gap-3"
                    onSubmit={(e) => {
                        e.preventDefault();
                        void quickAdd();
                    }}
                >
                    <Input aria-label="New task" placeholder="Add a task and press Enter" value={quickTitle} onChange={setQuickTitle} className="flex-1" />
                    <Button type="submit" color="secondary" isDisabled={!quickTitle.trim()}>
                        Add
                    </Button>
                </form>
            )}

            {view === "list" ? (
                <DataTable
                    key={status + assignee}
                    title={status === "open" ? "Open tasks" : status === "all" ? "All tasks" : TASK_STATUS_LABELS[status]}
                    rows={visible}
                    columns={columns}
                    searchText={(t) => `${t.title} ${t.category ?? ""} ${t.notes ?? ""}`}
                    initialSort={{ column: "due", direction: "ascending" }}
                    onRowAction={openPanel}
                    emptyState={
                        <Empty
                            icon={CheckDone01}
                            title={tasks.items.length === 0 ? "No tasks yet" : "Nothing here"}
                            description={
                                tasks.items.length === 0
                                    ? "Add the big jobs first (venue, celebrant, photographer), then break them down."
                                    : "No tasks match this filter."
                            }
                        />
                    }
                />
            ) : (
                <MonthCalendar
                    today={today}
                    items={visible
                        .filter((t) => t.dueDate)
                        .map((t) => ({
                            id: t.id,
                            date: t.dueDate!,
                            label: t.title,
                            tone: t.status === "done" ? "done" : t.dueDate! < today ? "overdue" : "default",
                        }))}
                    onSelect={(id) => openPanel(tasks.items.find((t) => t.id === id) ?? null)}
                />
            )}

            <EntityPanel
                isOpen={open}
                onOpenChange={setOpen}
                noun="task"
                name={editing?.title ?? null}
                description={editing?.completedAt ? `Completed ${formatDate(editing.completedAt.slice(0, 10))}` : undefined}
                canEdit={canEdit}
                onSave={() => tasks.save(editing?.id ?? null, { ...draft, category: draft.category || null })}
                onDelete={editing ? () => tasks.remove(editing.id) : undefined}
            >
                {(fieldError) => (
                    <FormGrid>
                        <FullWidth>
                            <Input
                                label="Task"
                                isRequired
                                value={draft.title}
                                onChange={(v) => setDraft({ ...draft, title: v })}
                                isInvalid={!!fieldError("title")}
                                hint={fieldError("title")}
                            />
                        </FullWidth>
                        <Select
                            label="Status"
                            items={Object.entries(TASK_STATUS_LABELS).map(([id, label]) => ({ id, label }))}
                            value={draft.status}
                            onChange={(v) => setDraft({ ...draft, status: v as TaskStatus })}
                        >
                            {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                        </Select>
                        <Select
                            label="Priority"
                            items={Object.entries(PRIORITY_LABELS).map(([id, label]) => ({ id, label }))}
                            value={draft.priority}
                            onChange={(v) => setDraft({ ...draft, priority: v as TaskPriority })}
                        >
                            {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                        </Select>
                        <DateField label="Due" value={draft.dueDate} onChange={(v) => setDraft({ ...draft, dueDate: v })} error={fieldError("dueDate")} />
                        <Select
                            label="Owner"
                            items={[{ id: "none", label: "Unassigned" }, ...data.assignees.map((a) => ({ id: a.email, label: a.name ?? a.email }))]}
                            value={draft.assignee ?? "none"}
                            onChange={(v) => setDraft({ ...draft, assignee: v === "none" ? null : String(v) })}
                        >
                            {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                        </Select>
                        <FullWidth>
                            <Input
                                label="Category"
                                placeholder="Venue, catering, attire…"
                                value={draft.category}
                                onChange={(v) => setDraft({ ...draft, category: v })}
                            />
                        </FullWidth>
                        <FullWidth>
                            <TextArea label="Notes" rows={4} value={draft.notes} onChange={(v) => setDraft({ ...draft, notes: v })} />
                        </FullWidth>
                    </FormGrid>
                )}
            </EntityPanel>
            <p className="sr-only" aria-live="polite">
                {pluralise(visible.length, "task")} shown
            </p>
        </>
    );
};
