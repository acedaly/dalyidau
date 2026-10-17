// A project: List (sections with nested tasks), Board (sections as columns; drag a card, or use its
// menu to move it, which works by keyboard) and Overview (progress, deadlines, milestones, members,
// linked Knowledge and recent history). Sections can be added, renamed, reordered and deleted;
// deleting one asks where its tasks go and never deletes them.
import { type DragEvent, useCallback, useState } from "react";
import { BookOpen01, CheckCircle, DotsVertical, Edit05, Folder, LayersThree01, Plus, Settings01, Target04, UsersPlus } from "@untitledui/icons";
import { FeedItem } from "@/components/application/activity-feed/activity-feed";
import { Tabs } from "@/components/application/tabs/tabs";
import { Badge, BadgeWithDot } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Dropdown } from "@/components/base/dropdown/dropdown";
import { Input } from "@/components/base/input/input";
import { ProgressBar } from "@/components/base/progress-indicators/progress-indicators";
import { Select } from "@/components/base/select/select";
import { PortalDialog } from "@/portal/components/dialog";
import { Empty } from "@/portal/components/empty";
import { MetricCard } from "@/portal/components/metric-card";
import { useToast } from "@/portal/components/toast";
import { errorMessage } from "@/portal/lib/api";
import { formatRelative, initials } from "@/portal/lib/format";
import type { PageData } from "@/portal/lib/page-types";
import { shortDate } from "@/shared/tasks/dates";
import { PROJECT_STATUS_LABELS, type TaskMember, type TaskProject, type TaskSection, type TaskSummary } from "@/shared/tasks/types";
import { cx } from "@/utils/cx";
import { activitySentence, takesTitle } from "../activity-text";
import { projectHref, tasksApi } from "../api";
import { EditProjectDialog, MembersDialog } from "../project-dialogs";
import { DeadlineBadge, DueBadge, PriorityFlag, ProjectDot, personLabel, titleOf } from "../shared";
import { TaskList } from "../task-list";
import { CompleteCircle } from "../task-row";
import { useTasks } from "../tasks-context";
import { TasksHeader, TasksLayout } from "../tasks-layout";
import { useLiveList } from "../use-live-list";
import { useTaskActions } from "../use-task-actions";

type Tab = "list" | "board" | "overview";

export const TasksProjectPage = ({ data }: { data: PageData<"tasks-project"> }) => (
    <TasksLayout shell={data} initialTask={data.openTask}>
        <ProjectBody data={data} />
    </TasksLayout>
);

const ProjectBody = ({ data }: { data: PageData<"tasks-project"> }) => {
    const { sections: sectionsOf, setSections, canEdit, today } = useTasks();
    const toast = useToast();
    const actions = useTaskActions();
    const [project, setProject] = useState<TaskProject>(data.project);
    const [members, setMembers] = useState<TaskMember[]>(data.members);
    const [tab, setTab] = useState<Tab>(data.tab);
    const [editOpen, setEditOpen] = useState(false);
    const [membersOpen, setMembersOpen] = useState(false);
    const [showCompleted, setShowCompleted] = useState(false);
    const [completed, setCompleted] = useState<TaskSummary[] | null>(null);
    const editable = canEdit(project.id);
    const sections = sectionsOf(project.id);

    const refetch = useCallback(async () => {
        const fresh = await tasksApi.project(project.id);
        setProject(fresh.project);
        setSections(project.id, fresh.sections);
        if (showCompleted) setCompleted((await tasksApi.projectCompleted(project.id)).tasks);
        return fresh.tasks;
    }, [project.id, setSections, showCompleted]);
    const { tasks, reload } = useLiveList(data.tasks, refetch);

    const total = project.counts.open + project.counts.completed;
    const progress = total ? Math.round((project.counts.completed / total) * 100) : 0;

    const switchTab = (next: Tab) => {
        // Overview needs data the list doesn't; it comes from the server.
        if (next === "overview" && !data.overview) return window.location.assign(projectHref(project.id, "overview"));
        setTab(next);
        const url = new URL(window.location.href);
        url.searchParams.set("view", next);
        window.history.replaceState(null, "", url);
    };

    return (
        <>
            <TasksHeader
                title={project.name}
                crumb={{
                    label: project.isInbox ? "Inbox" : project.kind === "shared" ? "Shared projects" : "My projects",
                    href: project.isInbox ? "/portal/tasks/inbox" : project.kind === "shared" ? "/portal/tasks/projects?kind=shared" : "/portal/tasks/projects",
                }}
                quickAdd={{ projectId: project.id }}
                description={
                    <div className="flex flex-col gap-3">
                        {project.description && <p className="text-md text-tertiary">{project.description}</p>}
                        <div className="flex flex-wrap items-center gap-2 text-sm">
                            <ProjectDot color={project.color} />
                            <Badge size="sm" type="color" color={project.kind === "shared" ? "blue" : "gray"}>
                                {project.kind === "shared" ? `Shared · ${project.memberCount} people` : "Personal"}
                            </Badge>
                            {project.status !== "active" && (
                                <BadgeWithDot
                                    size="sm"
                                    type="color"
                                    color={project.status === "completed" ? "success" : project.status === "archived" ? "gray" : "warning"}
                                >
                                    {PROJECT_STATUS_LABELS[project.status]}
                                </BadgeWithDot>
                            )}
                            {project.targetDate && <span className="text-tertiary">Target {shortDate(project.targetDate)}</span>}
                        </div>
                        {total > 0 && (
                            <div className="max-w-sm">
                                <ProgressBar
                                    value={progress}
                                    labelPosition="right"
                                    aria-label="Project progress"
                                    valueFormatter={() => `${project.counts.completed} of ${total} done`}
                                />
                            </div>
                        )}
                    </div>
                }
                actions={
                    <>
                        {!project.isInbox && (
                            <Button size="sm" color="secondary" iconLeading={UsersPlus} onClick={() => setMembersOpen(true)}>
                                {project.kind === "shared" ? "Members" : "Share"}
                            </Button>
                        )}
                        {editable || project.role === "owner" ? (
                            <Button size="sm" color="secondary" iconLeading={Settings01} onClick={() => setEditOpen(true)} aria-label="Project settings">
                                <span className="max-sm:sr-only">Settings</span>
                            </Button>
                        ) : null}
                    </>
                }
            />

            {project.status === "archived" && (
                <p className="rounded-lg bg-secondary px-4 py-3 text-sm text-secondary">
                    This project is archived, so it's read-only. An owner can restore it in Settings.
                </p>
            )}

            <Tabs selectedKey={tab} onSelectionChange={(key) => switchTab(key as Tab)} className="gap-6">
                <Tabs.List type="underline" size="sm" aria-label="Project views" className="w-max max-w-full overflow-x-auto">
                    <Tabs.Item id="list">List</Tabs.Item>
                    <Tabs.Item id="board">Board</Tabs.Item>
                    <Tabs.Item id="overview">Overview</Tabs.Item>
                </Tabs.List>
                <Tabs.Panel id="list">
                    <ListView
                        project={project}
                        tasks={tasks}
                        sections={sections}
                        actions={actions}
                        editable={editable}
                        onSectionsChanged={reload}
                        showCompleted={showCompleted}
                        completed={completed}
                        onToggleCompleted={async () => {
                            const next = !showCompleted;
                            setShowCompleted(next);
                            if (next && !completed) {
                                try {
                                    setCompleted((await tasksApi.projectCompleted(project.id)).tasks);
                                } catch (error) {
                                    toast.error("Couldn't load completed tasks", errorMessage(error));
                                }
                            }
                        }}
                    />
                </Tabs.Panel>
                <Tabs.Panel id="board">
                    <BoardView project={project} tasks={tasks} sections={sections} actions={actions} editable={editable} />
                </Tabs.Panel>
                <Tabs.Panel id="overview">
                    {data.overview && <OverviewView data={data} project={project} tasks={tasks} members={members} today={today} />}
                </Tabs.Panel>
            </Tabs>

            {editOpen && (
                <EditProjectDialog
                    project={project}
                    isOpen
                    onOpenChange={setEditOpen}
                    onSaved={(saved) => {
                        setProject(saved);
                        reload();
                    }}
                />
            )}
            {membersOpen && (
                <MembersDialog
                    project={project}
                    members={members}
                    isOpen
                    onOpenChange={setMembersOpen}
                    onChange={(next, nextProject) => {
                        setMembers(next);
                        if (nextProject) setProject(nextProject);
                        reload();
                    }}
                />
            )}
            {actions.dialogs}
        </>
    );
};

// --- List ----------------------------------------------------------------------------------------

const SectionHeader = ({
    section,
    sections,
    editable,
    onChanged,
}: {
    section: TaskSection;
    sections: TaskSection[];
    editable: boolean;
    onChanged: () => void;
}) => {
    const toast = useToast();
    const [renaming, setRenaming] = useState(false);
    const [name, setName] = useState(section.name);
    const [deleting, setDeleting] = useState(false);
    const [moveTo, setMoveTo] = useState<string>("__none");
    const index = sections.findIndex((s) => s.id === section.id);
    const run = async (work: () => Promise<unknown>) => {
        try {
            await work();
            onChanged();
        } catch (error) {
            toast.error("Couldn't change the section", errorMessage(error));
        }
    };
    return (
        <div className="flex items-center gap-2 border-b border-primary pb-2">
            <h2 className="flex-1 text-md font-semibold text-primary">{section.name}</h2>
            {editable && (
                <Dropdown.Root>
                    <ButtonUtility size="sm" color="tertiary" icon={DotsVertical} tooltip={`Actions for section “${section.name}”`} />
                    <Dropdown.Popover className="w-52">
                        <Dropdown.Menu
                            onAction={(key) => {
                                if (key === "rename") setRenaming(true);
                                else if (key === "up") void run(() => tasksApi.moveSection(section.id, index > 1 ? sections[index - 2].id : null));
                                else if (key === "down") void run(() => tasksApi.moveSection(section.id, sections[index + 1].id));
                                else if (key === "delete") setDeleting(true);
                            }}
                        >
                            <Dropdown.Item id="rename" label="Rename" icon={Edit05} />
                            {index > 0 && <Dropdown.Item id="up" label="Move up" />}
                            {index < sections.length - 1 && <Dropdown.Item id="down" label="Move down" />}
                            <Dropdown.Separator />
                            <Dropdown.Item id="delete" label="Delete section…" />
                        </Dropdown.Menu>
                    </Dropdown.Popover>
                </Dropdown.Root>
            )}
            <PortalDialog
                isOpen={renaming}
                onOpenChange={setRenaming}
                title="Rename section"
                onSubmit={() => void run(() => tasksApi.renameSection(section.id, name)).then(() => setRenaming(false))}
                footer={
                    <Button type="submit" size="md" isDisabled={!name.trim()}>
                        Save
                    </Button>
                }
            >
                <Input label="Name" value={name} onChange={setName} autoFocus />
            </PortalDialog>
            <PortalDialog
                isOpen={deleting}
                onOpenChange={setDeleting}
                title={`Delete “${section.name}”?`}
                description="Its tasks aren't deleted. Choose where they go."
                onSubmit={() => void run(() => tasksApi.deleteSection(section.id, moveTo === "__none" ? null : moveTo)).then(() => setDeleting(false))}
                footer={
                    <>
                        <Button color="secondary" size="md" onClick={() => setDeleting(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" size="md" color="primary-destructive">
                            Delete section
                        </Button>
                    </>
                }
            >
                <Select
                    label="Move its tasks to"
                    size="sm"
                    value={moveTo}
                    onChange={(key) => key && setMoveTo(String(key))}
                    items={[{ id: "__none", label: "No section" }, ...sections.filter((s) => s.id !== section.id).map((s) => ({ id: s.id, label: s.name }))]}
                >
                    {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                </Select>
                <div className="h-2" />
            </PortalDialog>
        </div>
    );
};

const ListView = ({
    project,
    tasks,
    sections,
    actions,
    editable,
    onSectionsChanged,
    showCompleted,
    completed,
    onToggleCompleted,
}: {
    project: TaskProject;
    tasks: TaskSummary[];
    sections: TaskSection[];
    actions: ReturnType<typeof useTaskActions>;
    editable: boolean;
    onSectionsChanged: () => void;
    showCompleted: boolean;
    completed: TaskSummary[] | null;
    onToggleCompleted: () => void;
}) => {
    const toast = useToast();
    const [adding, setAdding] = useState(false);
    const [name, setName] = useState("");
    const unsectioned = tasks.filter((t) => !t.sectionId);
    const nothing = tasks.length === 0 && sections.length === 0;

    return (
        <div className="flex flex-col gap-8">
            {nothing ? (
                <div className="rounded-xl py-8 ring-1 ring-secondary ring-inset">
                    <Empty
                        icon={Folder}
                        title="No tasks yet"
                        description={
                            editable ? "Add the first task, or split the project into sections (for example Venue, Catering, Transport)." : "Nothing here yet."
                        }
                    />
                </div>
            ) : null}
            {(unsectioned.length > 0 || sections.length === 0) && (
                <TaskList
                    aria-label="Tasks without a section"
                    tasks={unsectioned}
                    actions={actions}
                    nested
                    reorderable={editable}
                    addDefaults={editable ? { projectId: project.id, sectionId: null } : undefined}
                />
            )}
            {sections.map((section) => (
                <section key={section.id} aria-label={section.name} className="flex flex-col gap-1">
                    <SectionHeader section={section} sections={sections} editable={editable} onChanged={onSectionsChanged} />
                    <TaskList
                        aria-label={section.name}
                        tasks={tasks.filter((t) => t.sectionId === section.id)}
                        actions={actions}
                        nested
                        reorderable={editable}
                        addDefaults={editable ? { projectId: project.id, sectionId: section.id } : undefined}
                    />
                </section>
            ))}
            {editable &&
                (adding ? (
                    <form
                        className="flex flex-wrap items-end gap-2"
                        onSubmit={async (event) => {
                            event.preventDefault();
                            try {
                                await tasksApi.createSection(project.id, name);
                                setName("");
                                setAdding(false);
                                onSectionsChanged();
                            } catch (error) {
                                toast.error("Couldn't add the section", errorMessage(error));
                            }
                        }}
                    >
                        <Input label="Section name" size="sm" value={name} onChange={setName} autoFocus className="w-64" />
                        <Button type="submit" size="sm" isDisabled={!name.trim()}>
                            Add section
                        </Button>
                        <Button size="sm" color="secondary" onClick={() => setAdding(false)}>
                            Cancel
                        </Button>
                    </form>
                ) : (
                    <Button size="sm" color="link-gray" iconLeading={LayersThree01} className="self-start" onClick={() => setAdding(true)}>
                        Add section
                    </Button>
                ))}
            {project.counts.completed > 0 && (
                <section aria-label="Completed tasks" className="flex flex-col gap-2">
                    <Button size="sm" color="link-gray" iconLeading={CheckCircle} className="self-start" onClick={onToggleCompleted}>
                        {showCompleted ? "Hide completed" : `Show completed (${project.counts.completed})`}
                    </Button>
                    {showCompleted && completed && <TaskList aria-label="Completed tasks" tasks={completed} actions={actions} />}
                </section>
            )}
        </div>
    );
};

// --- Board ---------------------------------------------------------------------------------------

const NONE = "__none";

const BoardView = ({
    project,
    tasks,
    sections,
    actions,
    editable,
}: {
    project: TaskProject;
    tasks: TaskSummary[];
    sections: TaskSection[];
    actions: ReturnType<typeof useTaskActions>;
    editable: boolean;
}) => {
    const { openTask, today, openQuickAdd } = useTasks();
    const [over, setOver] = useState<string | null>(null);
    const columns = [{ id: NONE, name: "No section" }, ...sections];
    const top = tasks.filter((t) => !t.parentId);
    const move = (task: TaskSummary, sectionId: string) => {
        const target = sectionId === NONE ? null : sectionId;
        if (task.sectionId !== target) void actions.move(task, { sectionId: target });
    };
    const onDrop = (event: DragEvent, columnId: string) => {
        event.preventDefault();
        setOver(null);
        const task = top.find((t) => t.id === event.dataTransfer.getData("text/x-task-id"));
        if (task) move(task, columnId);
    };

    return (
        <div className="-mx-4 overflow-x-auto px-4 pb-4 lg:-mx-8 lg:px-8">
            <ol aria-label="Board" className="flex min-w-max gap-4">
                {columns.map((column) => {
                    const cards = top.filter((t) => (t.sectionId ?? NONE) === column.id);
                    if (column.id === NONE && !cards.length && sections.length) return null;
                    return (
                        <li
                            key={column.id}
                            aria-label={column.name}
                            onDragOver={(event) => editable && (event.preventDefault(), setOver(column.id))}
                            onDragLeave={() => setOver((o) => (o === column.id ? null : o))}
                            onDrop={(event) => onDrop(event, column.id)}
                            className={cx("flex w-72 shrink-0 flex-col gap-3 rounded-xl bg-secondary p-3", over === column.id && "ring-2 ring-brand")}
                        >
                            <h2 className="flex items-center justify-between px-1 text-sm font-semibold text-primary">
                                {column.name}
                                <span className="text-xs font-medium text-tertiary">{cards.length}</span>
                            </h2>
                            <ul className="flex flex-col gap-2">
                                {cards.map((task) => (
                                    <li
                                        key={task.id}
                                        draggable={editable}
                                        onDragStart={(event) => {
                                            event.dataTransfer.setData("text/x-task-id", task.id);
                                            event.dataTransfer.effectAllowed = "move";
                                        }}
                                        className="flex flex-col gap-2 rounded-lg bg-primary p-3 shadow-xs ring-1 ring-secondary ring-inset"
                                    >
                                        <div className="flex items-start gap-2">
                                            <CompleteCircle task={task} isDisabled={!editable} onChange={() => void actions.complete(task)} />
                                            <button
                                                type="button"
                                                onClick={() => openTask(task.id)}
                                                className="min-w-0 flex-1 cursor-pointer rounded-sm text-left text-sm font-medium wrap-break-word text-primary outline-focus-ring focus-visible:outline-2"
                                            >
                                                {titleOf(task.title)}
                                            </button>
                                            {editable && (
                                                <Dropdown.Root>
                                                    <ButtonUtility
                                                        size="sm"
                                                        color="tertiary"
                                                        icon={DotsVertical}
                                                        tooltip={`Move “${titleOf(task.title)}”`}
                                                        className="shrink-0"
                                                    />
                                                    <Dropdown.Popover className="w-56">
                                                        <Dropdown.Menu onAction={(key) => (key === "open" ? openTask(task.id) : move(task, String(key)))}>
                                                            <Dropdown.Item id="open" label="Open details" />
                                                            <Dropdown.Separator />
                                                            <Dropdown.Section>
                                                                <Dropdown.SectionHeader className="px-4 pt-2 pb-1 text-xs font-semibold text-quaternary">
                                                                    Move to
                                                                </Dropdown.SectionHeader>
                                                                {columns
                                                                    .filter((c) => c.id !== (task.sectionId ?? NONE))
                                                                    .map((c) => (
                                                                        <Dropdown.Item key={c.id} id={c.id} label={c.name} />
                                                                    ))}
                                                            </Dropdown.Section>
                                                        </Dropdown.Menu>
                                                    </Dropdown.Popover>
                                                </Dropdown.Root>
                                            )}
                                        </div>
                                        <div className="flex flex-wrap items-center gap-2 pl-8">
                                            <PriorityFlag priority={task.priority} />
                                            <DueBadge task={task} today={today} />
                                            <DeadlineBadge deadline={task.deadline} today={today} />
                                            {task.subtasks.total > 0 && (
                                                <span className="text-xs text-tertiary">
                                                    {task.subtasks.total - task.subtasks.open}/{task.subtasks.total}
                                                    <span className="sr-only"> subtasks done</span>
                                                </span>
                                            )}
                                        </div>
                                    </li>
                                ))}
                            </ul>
                            {editable && (
                                <Button
                                    size="sm"
                                    color="link-gray"
                                    iconLeading={Plus}
                                    className="self-start px-1"
                                    onClick={() => openQuickAdd({ projectId: project.id, sectionId: column.id === NONE ? null : column.id })}
                                >
                                    Add task
                                </Button>
                            )}
                        </li>
                    );
                })}
            </ol>
            {!sections.length && <p className="mt-3 text-sm text-tertiary">Add sections in the List view; each becomes a column here.</p>}
        </div>
    );
};

// --- Overview ------------------------------------------------------------------------------------

const OverviewView = ({
    data,
    project,
    tasks,
    members,
    today,
}: {
    data: PageData<"tasks-project">;
    project: TaskProject;
    tasks: TaskSummary[];
    members: TaskMember[];
    today: string;
}) => {
    const { openTask } = useTasks();
    const overview = data.overview;
    const total = project.counts.open + project.counts.completed;
    const upcoming = tasks
        .filter((t) => t.dueDate && t.dueDate >= today)
        .sort((a, b) => a.dueDate!.localeCompare(b.dueDate!))
        .slice(0, 5);
    const TaskLink = ({ task }: { task: TaskSummary }) => (
        <li className="flex flex-wrap items-center gap-2 py-2">
            <button
                type="button"
                onClick={() => openTask(task.id)}
                className={cx(
                    "min-w-0 flex-1 cursor-pointer truncate rounded-sm text-left text-sm font-medium text-primary outline-focus-ring hover:underline focus-visible:outline-2",
                    task.status === "completed" && "text-tertiary line-through",
                )}
            >
                {titleOf(task.title)}
            </button>
            <DueBadge task={task} today={today} />
            <DeadlineBadge deadline={task.deadline} today={today} />
        </li>
    );
    const Card = ({ title, children }: { title: string; children: React.ReactNode }) => (
        <section className="flex flex-col gap-3 rounded-xl bg-primary p-5 shadow-xs ring-1 ring-secondary ring-inset">
            <h2 className="text-md font-semibold text-primary">{title}</h2>
            {children}
        </section>
    );
    return (
        <div className="flex flex-col gap-6">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <MetricCard label="Open" value={project.counts.open} icon={Folder} />
                <MetricCard label="Completed" value={project.counts.completed} icon={CheckCircle} />
                <MetricCard label="Overdue" value={project.counts.overdue} icon={Target04} />
                <MetricCard
                    label="Progress"
                    value={`${total ? Math.round((project.counts.completed / total) * 100) : 0}%`}
                    progress={total ? (project.counts.completed / total) * 100 : 0}
                    progressLabel={`${project.counts.completed} of ${total} tasks done`}
                />
            </div>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <Card title="Coming up">
                    {upcoming.length ? (
                        <ul className="divide-y divide-secondary">
                            {upcoming.map((t) => (
                                <TaskLink key={t.id} task={t} />
                            ))}
                        </ul>
                    ) : (
                        <p className="text-sm text-tertiary">Nothing scheduled.</p>
                    )}
                </Card>
                <Card title="Deadlines">
                    {overview?.upcomingDeadlines.length ? (
                        <ul className="divide-y divide-secondary">
                            {overview.upcomingDeadlines.map((t) => (
                                <TaskLink key={t.id} task={t} />
                            ))}
                        </ul>
                    ) : (
                        <p className="text-sm text-tertiary">No deadlines set.</p>
                    )}
                </Card>
                <Card title="Milestones">
                    {overview?.milestones.length ? (
                        <ul className="divide-y divide-secondary">
                            {overview.milestones.map((t) => (
                                <TaskLink key={t.id} task={t} />
                            ))}
                        </ul>
                    ) : (
                        <p className="text-sm text-tertiary">Mark important targets as milestones in a task's details.</p>
                    )}
                </Card>
                <Card title={project.kind === "shared" ? `Members (${members.length})` : "Members"}>
                    <ul className="flex flex-col gap-2">
                        {members.map((m) => (
                            <li key={m.email} className="flex items-center justify-between gap-3 text-sm">
                                <span className="truncate text-secondary">{m.name ?? m.email}</span>
                                <span className="text-tertiary capitalize">{m.role}</span>
                            </li>
                        ))}
                    </ul>
                </Card>
                <Card title="Linked Knowledge">
                    {overview?.knowledge.length ? (
                        <ul className="flex flex-col gap-2">
                            {overview.knowledge.map((ref) => (
                                <li key={ref.linkId} className="flex items-center gap-2 text-sm">
                                    <BookOpen01 aria-hidden="true" className="size-4 shrink-0 text-fg-quaternary" />
                                    {ref.available ? (
                                        <a
                                            href={`/portal/knowledge/o/${ref.objectId}`}
                                            className="truncate rounded-sm font-medium text-primary outline-focus-ring hover:underline focus-visible:outline-2"
                                        >
                                            {ref.title}
                                        </a>
                                    ) : (
                                        <span className="text-tertiary">A Knowledge item you don't have access to</span>
                                    )}
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <p className="text-sm text-tertiary">Link notes and decisions to tasks from a task's details.</p>
                    )}
                </Card>
                <Card title="Recent activity">
                    {overview?.activity.length ? (
                        <ul className="flex flex-col gap-4">
                            {overview.activity.map((entry, i, all) => (
                                <li key={entry.id}>
                                    <FeedItem
                                        id={entry.id}
                                        size="sm"
                                        connector={i < all.length - 1}
                                        user={{
                                            name: entry.actorName ?? personLabel(entry.actor, members),
                                            initials: initials(entry.actorName ?? entry.actor.split("@")[0]),
                                        }}
                                        date={formatRelative(entry.at)}
                                        dateTime={entry.at}
                                        action={{
                                            content: activitySentence(entry, today),
                                            target: takesTitle(entry.action) ? (entry.taskTitle ?? undefined) : undefined,
                                            href: entry.taskId ? `/portal/tasks/t/${entry.taskId}` : undefined,
                                        }}
                                    />
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <p className="text-sm text-tertiary">Nothing yet.</p>
                    )}
                    <a
                        href={`/portal/tasks/activity?project=${project.id}`}
                        className="self-start rounded-sm text-sm font-semibold text-brand-secondary outline-focus-ring hover:underline focus-visible:outline-2"
                    >
                        All activity
                    </a>
                </Card>
            </div>
        </div>
    );
};
