// Inbox, Today and Overdue. The Inbox is where tasks land when no project is chosen; Today groups
// what's overdue, due today, at its deadline and (if chosen in settings) undated urgent tasks;
// Overdue lists everything past its date or deadline. All three support bulk changes, their own
// sort and priority choices (remembered per person), and overdue tasks can all be moved to today
// at once: one batch, the same tasks moved (never copied), only the current occurrence of a repeat.
import { useCallback, useState } from "react";
import { AlarmClock, CalendarCheck01, CheckSquare, Inbox01, Sun } from "@untitledui/icons";
import { ContentDivider } from "@/components/application/content-divider/content-divider";
import { Button } from "@/components/base/buttons/button";
import { ProgressBar } from "@/components/base/progress-indicators/progress-indicators";
import { Empty } from "@/portal/components/empty";
import { useToast } from "@/portal/components/toast";
import { errorMessage } from "@/portal/lib/api";
import type { PageData } from "@/portal/lib/page-types";
import { longDate } from "@/shared/tasks/dates";
import type { TaskSummary } from "@/shared/tasks/types";
import { tasksApi } from "../api";
import { BulkBar } from "../bulk-bar";
import { ListControls, sortTasks, withPriorities } from "../list-controls";
import { TaskList } from "../task-list";
import { useTasks } from "../tasks-context";
import { TasksHeader, TasksLayout } from "../tasks-layout";
import { useLiveList } from "../use-live-list";
import { useTaskActions } from "../use-task-actions";

type View = PageData<"tasks-view">["view"];

const COPY: Record<View, { title: string; description: string; icon: typeof Inbox01; empty: string; emptyTitle: string }> = {
    inbox: {
        title: "Inbox",
        description: "Where tasks go when you haven't chosen a project. Only you can see it.",
        icon: Inbox01,
        emptyTitle: "Inbox zero",
        empty: "Nothing waiting. Press q to add a task, then sort it into a project when you're ready.",
    },
    today: {
        title: "Today",
        description: "",
        icon: Sun,
        emptyTitle: "Nothing due today",
        empty: "Tasks due today, overdue tasks and today's deadlines appear here. Enjoy the clear day, or plan something from Upcoming.",
    },
    overdue: {
        title: "Overdue",
        description: "Tasks past their due date or deadline, oldest first.",
        icon: AlarmClock,
        emptyTitle: "Nothing overdue",
        empty: "You're on top of everything.",
    },
};

export const TasksViewPage = ({ data }: { data: PageData<"tasks-view"> }) => (
    <TasksLayout shell={data}>
        <ViewBody data={data} />
    </TasksLayout>
);

const ViewBody = ({ data }: { data: PageData<"tasks-view"> }) => {
    const { today, shell, projects, viewPreferences, setViewPreferences, emit } = useTasks();
    const toast = useToast();
    const copy = COPY[data.view];
    const actions = useTaskActions();
    const [done, setDone] = useState(data.progress?.done ?? 0);
    const refetch = useCallback(async () => {
        const result = await tasksApi.list(data.view);
        if (result.progress) setDone(result.progress.done);
        return result.tasks;
    }, [data.view]);
    const { tasks: all } = useLiveList(data.tasks, refetch);
    const prefs = viewPreferences(data.view);
    const defaultSort = data.view === "inbox" ? "manual" : "due";
    // The Inbox nests subtasks under their parents, so only its top-level order changes.
    const tasks = sortTasks(withPriorities(all, prefs.priorities), prefs.sort ?? defaultSort, projects);
    const [moving, setMoving] = useState(false);
    const overdueIds = all.filter((t) => t.dueDate && t.dueDate < today).map((t) => t.id);
    const moveOverdue = async () => {
        setMoving(true);
        try {
            for (let i = 0; i < overdueIds.length; i += 100) await tasksApi.bulk(overdueIds.slice(i, i + 100), { action: "due", dueDate: today });
            toast.success(`Moved ${overdueIds.length} task${overdueIds.length === 1 ? "" : "s"} to today`, "Deadlines stay where they were.");
            emit({ type: "refresh" });
        } catch (error) {
            toast.error("Nothing more was moved", errorMessage(error));
            emit({ type: "refresh" });
        } finally {
            setMoving(false);
        }
    };
    const [selecting, setSelecting] = useState(false);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const selection = selecting ? { selected, onChange: setSelected } : null;
    const titles = Object.fromEntries(tasks.map((t) => [t.id, t.title]));

    // Each task in exactly one group, the most pressing one.
    const groupOf = (t: TaskSummary) =>
        (t.dueDate && t.dueDate < today) || (t.deadline && t.deadline < today)
            ? "overdue"
            : t.dueDate === today
              ? "today"
              : t.deadline === today
                ? "deadline"
                : "focus";
    const GROUPS = [
        { id: "overdue", label: "Overdue" },
        { id: "today", label: "Due today" },
        { id: "deadline", label: "Deadline today" },
        { id: "focus", label: "High priority, no date" },
    ];
    const groups: { id: string; label: string; tasks: TaskSummary[] }[] =
        data.view === "today"
            ? GROUPS.map((g) => ({ ...g, tasks: tasks.filter((t) => groupOf(t) === g.id) })).filter((g) => g.tasks.length || g.id === "today")
            : [{ id: "all", label: "", tasks }];

    const empty = <Empty icon={copy.icon} title={copy.emptyTitle} description={copy.empty} size="sm" />;

    return (
        <>
            <TasksHeader
                title={copy.title}
                description={data.view === "today" ? `${longDate(today)} · ${all.length} to do · ${done} done` : copy.description}
                crumb={{ label: copy.title }}
                quickAdd={data.view === "inbox" ? { projectId: shell.inboxId } : data.view === "today" ? { dueDate: today } : {}}
                actions={
                    tasks.length > 0 && (
                        <Button
                            size="sm"
                            color={selecting ? "primary" : "secondary"}
                            iconLeading={CheckSquare}
                            onClick={() => {
                                setSelecting(!selecting);
                                setSelected(new Set());
                            }}
                        >
                            {selecting ? "Done selecting" : "Select"}
                        </Button>
                    )
                }
            />
            <div className="flex flex-wrap items-center justify-between gap-3">
                <ListControls
                    label={copy.title}
                    preferences={prefs}
                    onChange={(next) => setViewPreferences(data.view, next)}
                    sorts={data.view === "inbox" ? ["manual", "due", "priority", "created"] : ["due", "priority", "project", "created"]}
                    defaultSort={defaultSort}
                />
                {data.view !== "inbox" && overdueIds.length > 0 && (
                    <Button
                        size="sm"
                        color="secondary"
                        iconLeading={CalendarCheck01}
                        isLoading={moving}
                        showTextWhileLoading
                        onClick={() => void moveOverdue()}
                    >
                        Move {overdueIds.length} overdue to today
                    </Button>
                )}
            </div>
            {data.view === "today" && done + all.length > 0 && (
                <ProgressBar
                    value={done}
                    max={done + all.length}
                    labelPosition="right"
                    valueFormatter={(value) => `${value} of ${done + all.length} done today`}
                    aria-label="Today's progress"
                />
            )}
            <div className="flex flex-col gap-6">
                {tasks.length === 0 && data.view !== "today" ? (
                    <div className="rounded-xl py-8 ring-1 ring-secondary ring-inset">{empty}</div>
                ) : (
                    groups.map((group) => (
                        <section key={group.id} aria-label={group.label || copy.title} className="flex flex-col">
                            {group.label && (
                                <ContentDivider type="single-line" className="mb-1">
                                    <h2 className="text-sm font-semibold text-secondary">
                                        {group.label} <span className="font-normal text-tertiary">{group.tasks.length || ""}</span>
                                    </h2>
                                </ContentDivider>
                            )}
                            <TaskList
                                aria-label={group.label || copy.title}
                                tasks={group.tasks}
                                actions={actions}
                                nested={data.view === "inbox"}
                                reorderable={data.view === "inbox"}
                                showProject={data.view !== "inbox"}
                                selection={selection}
                                parentTitles={titles}
                                addDefaults={group.id === "today" ? { dueDate: today } : data.view === "inbox" ? { projectId: shell.inboxId } : undefined}
                                empty={group.id === "today" ? empty : null}
                            />
                        </section>
                    ))
                )}
            </div>
            {selecting && <BulkBar selected={selected} onClear={() => setSelected(new Set())} />}
            {actions.dialogs}
        </>
    );
};
