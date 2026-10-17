// Inbox, Today and Overdue. The Inbox is where tasks land when no project is chosen; Today groups
// what's overdue, due today, at its deadline and (if chosen in settings) undated urgent tasks;
// Overdue lists everything past its date or deadline. All three support bulk changes.
import { useCallback, useState } from "react";
import { AlarmClock, CheckSquare, Inbox01, Sun } from "@untitledui/icons";
import { ContentDivider } from "@/components/application/content-divider/content-divider";
import { Button } from "@/components/base/buttons/button";
import { Empty } from "@/portal/components/empty";
import type { PageData } from "@/portal/lib/page-types";
import { longDate } from "@/shared/tasks/dates";
import type { TaskSummary } from "@/shared/tasks/types";
import { tasksApi } from "../api";
import { BulkBar } from "../bulk-bar";
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
    const { today, shell } = useTasks();
    const copy = COPY[data.view];
    const actions = useTaskActions();
    const refetch = useCallback(async () => (await tasksApi.list(data.view)).tasks, [data.view]);
    const { tasks } = useLiveList(data.tasks, refetch);
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
                description={data.view === "today" ? `${longDate(today)} · ${tasks.length} task${tasks.length === 1 ? "" : "s"}` : copy.description}
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
