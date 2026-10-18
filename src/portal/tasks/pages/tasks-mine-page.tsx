// All my tasks: every open task the person is responsible for (their personal tasks, and shared
// ones assigned to them or to nobody, by default) in one list, paged from the server, with their own
// sort, grouping, priority, project and section choices remembered for them. Saved as a filter it
// becomes one of their saved views.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BookmarkAdd, CheckSquare, UserCheck01 } from "@untitledui/icons";
import { ContentDivider } from "@/components/application/content-divider/content-divider";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { Select } from "@/components/base/select/select";
import { PortalDialog } from "@/portal/components/dialog";
import { Empty, Skeleton } from "@/portal/components/empty";
import { useToast } from "@/portal/components/toast";
import { errorMessage } from "@/portal/lib/api";
import type { PageData } from "@/portal/lib/page-types";
import { addDays, longDate, weekStart } from "@/shared/tasks/dates";
import { ASSIGNEE_FILTERS, ASSIGNEE_LABELS, type AssigneeFilter, filterToParams } from "@/shared/tasks/filters";
import { PRIORITY_LABELS, type TaskSummary } from "@/shared/tasks/types";
import { type ListGroup, type ViewPreferences, mineFilter } from "@/shared/tasks/view-preferences";
import { tasksApi } from "../api";
import { BulkBar } from "../bulk-bar";
import { ListControls } from "../list-controls";
import { TaskList } from "../task-list";
import { useTaskChanges, useTasks } from "../tasks-context";
import { TasksHeader, TasksLayout } from "../tasks-layout";
import { useTaskActions } from "../use-task-actions";

const PAGE = 100;

export const TasksMinePage = ({ data }: { data: PageData<"tasks-mine"> }) => (
    <TasksLayout shell={data}>
        <MineBody data={data} />
    </TasksLayout>
);

const MineBody = ({ data }: { data: PageData<"tasks-mine"> }) => {
    const { today, projects, sections, viewPreferences, setViewPreferences, project } = useTasks();
    const toast = useToast();
    const actions = useTaskActions();
    const prefs = viewPreferences("mine");
    const [tasks, setTasks] = useState(data.tasks);
    const [hasMore, setHasMore] = useState(data.hasMore);
    const [loading, setLoading] = useState(false);
    const [selecting, setSelecting] = useState(false);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [saving, setSaving] = useState(false);
    const [name, setName] = useState("");
    const filter = useMemo(() => mineFilter(prefs), [prefs]);
    const latest = useRef(0);

    const load = useCallback(
        async (offset: number) => {
            const request = ++latest.current;
            setLoading(true);
            try {
                const params = filterToParams(filter);
                params.set("limit", String(PAGE));
                params.set("offset", String(offset));
                const page = await tasksApi.filter(params);
                if (request !== latest.current) return;
                setTasks((list) => (offset ? [...list, ...page.tasks] : page.tasks));
                setHasMore(page.hasMore);
            } catch (error) {
                toast.error("Couldn't load your tasks", errorMessage(error));
            } finally {
                if (request === latest.current) setLoading(false);
            }
        },
        [filter, toast],
    );
    // A change of choices reloads from the start; the first render already has the first page.
    const first = useRef(true);
    useEffect(() => {
        if (first.current) return void (first.current = false);
        void load(0);
    }, [load]);
    useTaskChanges((change) => {
        if (change.type === "removed") setTasks((list) => list.filter((t) => t.id !== change.id));
        else if (change.type === "saved" && change.task.status === "completed") setTasks((list) => list.filter((t) => t.id !== change.task.id));
        else if (change.type === "saved") setTasks((list) => list.map((t) => (t.id === change.task.id ? change.task : t)));
        else void load(0);
    });

    const change = (next: ViewPreferences) => setViewPreferences("mine", next);
    const group = prefs.group ?? "date";
    const groups = groupTasks(tasks, group, today, (id) => project(id)?.name ?? "Project");
    const chosenProjects = prefs.projectIds ?? [];
    const sectionChoices = chosenProjects.flatMap((id) => sections(id).map((s) => ({ id: s.id, label: `${project(id)?.name ?? ""} / ${s.name}` })));
    const titles = Object.fromEntries(tasks.map((t) => [t.id, t.title]));

    return (
        <>
            <TasksHeader
                title="All my tasks"
                description="Everything on your plate: your personal tasks, and shared tasks assigned to you or to nobody."
                crumb={{ label: "All my tasks" }}
                actions={
                    <>
                        <Button size="sm" color="secondary" iconLeading={BookmarkAdd} onClick={() => setSaving(true)}>
                            Save as filter
                        </Button>
                        {tasks.length > 0 && (
                            <Button
                                size="sm"
                                color={selecting ? "primary" : "secondary"}
                                iconLeading={CheckSquare}
                                onClick={() => (setSelecting(!selecting), setSelected(new Set()))}
                            >
                                {selecting ? "Done selecting" : "Select"}
                            </Button>
                        )}
                    </>
                }
            />
            <div className="flex flex-col gap-3">
                <ListControls
                    label="all my tasks"
                    preferences={prefs}
                    onChange={change}
                    sorts={["due", "priority", "project", "created"]}
                    defaultSort="due"
                    groups={["date", "project", "priority", "none"]}
                    defaultGroup="date"
                />
                <div className="flex flex-wrap items-center gap-2">
                    <Select
                        aria-label="Whose tasks"
                        size="sm"
                        className="w-full sm:w-52"
                        value={prefs.assignee ?? "mine"}
                        onChange={(key) => key && change({ ...prefs, assignee: key as AssigneeFilter })}
                        items={ASSIGNEE_FILTERS.map((a) => ({ id: a, label: ASSIGNEE_LABELS[a] }))}
                    >
                        {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                    </Select>
                    <Select
                        aria-label="Project"
                        size="sm"
                        className="w-full sm:w-52"
                        value={chosenProjects[0] ?? "all"}
                        onChange={(key) => key && change({ ...prefs, projectIds: key === "all" ? [] : [String(key)], sectionIds: [] })}
                        items={[
                            { id: "all", label: "All projects" },
                            ...projects.filter((p) => p.status !== "archived").map((p) => ({ id: p.id, label: p.name })),
                        ]}
                    >
                        {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                    </Select>
                    {sectionChoices.length > 0 && (
                        <Select
                            aria-label="Section"
                            size="sm"
                            className="w-full sm:w-52"
                            value={prefs.sectionIds?.[0] ?? "all"}
                            onChange={(key) => key && change({ ...prefs, sectionIds: key === "all" ? [] : [String(key)] })}
                            items={[{ id: "all", label: "All sections" }, ...sectionChoices]}
                        >
                            {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                        </Select>
                    )}
                </div>
            </div>
            {loading && tasks.length === 0 ? (
                <div role="status" aria-label="Loading" className="flex flex-col gap-3">
                    <Skeleton className="h-12 w-full" />
                    <Skeleton className="h-12 w-full" />
                </div>
            ) : tasks.length === 0 ? (
                <div className="rounded-xl py-8 ring-1 ring-secondary ring-inset">
                    <Empty icon={UserCheck01} title="Nothing here" description="No open tasks match these choices. Press q to add one." size="sm" />
                </div>
            ) : (
                <div className="flex flex-col gap-6" aria-busy={loading}>
                    {groups.map((g) => (
                        <section key={g.key} aria-label={g.label || "Tasks"} className="flex flex-col">
                            {g.label && (
                                <ContentDivider type="single-line" className="mb-1">
                                    <h2 className={g.key === "overdue" ? "text-sm font-semibold text-error-primary" : "text-sm font-semibold text-secondary"}>
                                        {g.label} <span className="font-normal text-tertiary">{g.tasks.length}</span>
                                    </h2>
                                </ContentDivider>
                            )}
                            <TaskList
                                aria-label={g.label || "All my tasks"}
                                tasks={g.tasks}
                                actions={actions}
                                showProject
                                parentTitles={titles}
                                selection={selecting ? { selected, onChange: setSelected } : null}
                            />
                        </section>
                    ))}
                    {hasMore && (
                        <Button
                            size="sm"
                            color="secondary"
                            className="self-start"
                            isLoading={loading}
                            showTextWhileLoading
                            onClick={() => void load(tasks.length)}
                        >
                            Show more
                        </Button>
                    )}
                </div>
            )}
            {selecting && <BulkBar selected={selected} onClear={() => setSelected(new Set())} />}
            <PortalDialog
                isOpen={saving}
                onOpenChange={setSaving}
                title="Save as a filter"
                description="It appears under Filters with these choices, for you only."
                onSubmit={async () => {
                    try {
                        await tasksApi.createView(name.trim(), filter);
                        toast.success("Filter saved", name.trim());
                        setSaving(false);
                        setName("");
                    } catch (error) {
                        toast.error("Couldn't save it", errorMessage(error));
                    }
                }}
                footer={
                    <Button type="submit" size="md" isDisabled={!name.trim()}>
                        Save filter
                    </Button>
                }
            >
                <Input label="Name" placeholder="e.g. My shared chores" value={name} onChange={setName} autoFocus />
            </PortalDialog>
            {actions.dialogs}
        </>
    );
};

/** Groups for the list: by when it's due (overdue, today, this week…), project or priority. */
function groupTasks(tasks: TaskSummary[], group: ListGroup, today: string, projectName: (id: string) => string) {
    if (group === "none") return [{ key: "all", label: "", tasks }];
    const out = new Map<string, { key: string; label: string; tasks: TaskSummary[] }>();
    const endOfWeek = addDays(weekStart(today), 6);
    const keyOf = (t: TaskSummary): [string, string] => {
        if (group === "project") return [t.projectId, projectName(t.projectId)];
        if (group === "priority") return [`p${t.priority}`, `${PRIORITY_LABELS[t.priority].short} ${PRIORITY_LABELS[t.priority].label}`];
        if (!t.dueDate) return ["none", "No date"];
        if (t.dueDate < today) return ["overdue", "Overdue"];
        if (t.dueDate === today) return ["today", `Today · ${longDate(today)}`];
        if (t.dueDate <= endOfWeek) return ["week", "Later this week"];
        return ["later", "Later"];
    };
    for (const t of tasks) {
        const [key, label] = keyOf(t);
        if (!out.has(key)) out.set(key, { key, label, tasks: [] });
        out.get(key)!.tasks.push(t);
    }
    const order = group === "date" ? ["overdue", "today", "week", "later", "none"] : null;
    const list = [...out.values()];
    return order
        ? list.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key))
        : group === "priority"
          ? list.sort((a, b) => a.key.localeCompare(b.key))
          : list;
}
