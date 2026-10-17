// Completed: every completion and skip, newest first, including each occurrence of a repeating
// task. A one-off task can be reopened from here; a completion that's been undone disappears.
import { useState } from "react";
import { CheckCircle } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { Empty } from "@/portal/components/empty";
import { useToast } from "@/portal/components/toast";
import { errorMessage } from "@/portal/lib/api";
import { formatDateTime } from "@/portal/lib/format";
import type { PageData } from "@/portal/lib/page-types";
import { longDate, shortDate } from "@/shared/tasks/dates";
import type { CompletedEntry } from "@/shared/tasks/types";
import { tasksApi } from "../api";
import { ProjectDot, personLabel, titleOf } from "../shared";
import { useTaskChanges, useTasks } from "../tasks-context";
import { TasksHeader, TasksLayout } from "../tasks-layout";
import { useTaskActions } from "../use-task-actions";

export const TasksCompletedPage = ({ data }: { data: PageData<"tasks-completed"> }) => (
    <TasksLayout shell={data}>
        <CompletedBody data={data} />
    </TasksLayout>
);

const CompletedBody = ({ data }: { data: PageData<"tasks-completed"> }) => {
    const { project, openTask, canEdit, shell } = useTasks();
    const actions = useTaskActions();
    const toast = useToast();
    const [entries, setEntries] = useState<CompletedEntry[]>(data.entries);
    const [hasMore, setHasMore] = useState(data.hasMore);
    const [loading, setLoading] = useState(false);
    const reload = async () => {
        const next = await tasksApi.completed().catch(() => null);
        if (next) (setEntries(next.entries), setHasMore(next.hasMore));
    };
    useTaskChanges(() => void reload());

    // Grouped by the day they were completed, in the person's own time zone.
    const dayOf = (iso: string) =>
        new Intl.DateTimeFormat("en-CA", { timeZone: shell.preferences.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
    const days = [...new Set(entries.map((e) => dayOf(e.completion.at)))];

    return (
        <>
            <TasksHeader
                title="Completed"
                description="Everything you and the people you share projects with have completed, newest first."
                crumb={{ label: "Completed" }}
            />
            {entries.length === 0 ? (
                <Empty
                    icon={CheckCircle}
                    title="Nothing completed yet"
                    description="Completed tasks stay here, with when and by whom, so nothing is lost."
                    size="sm"
                />
            ) : (
                <div className="flex flex-col gap-6">
                    {days.map((day) => (
                        <section key={day} aria-label={longDate(day)}>
                            <h2 className="mb-2 text-sm font-semibold text-secondary">{longDate(day)}</h2>
                            <ul className="divide-y divide-secondary rounded-xl ring-1 ring-secondary ring-inset">
                                {entries
                                    .filter((e) => dayOf(e.completion.at) === day)
                                    .map(({ task, completion }) => {
                                        const owner = project(task.projectId);
                                        // Only a task's latest completion can be undone.
                                        const latest = entries.find((e) => e.task.id === task.id)?.completion.id === completion.id;
                                        return (
                                            <li key={completion.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                                                <CheckCircle aria-hidden="true" className="size-5 shrink-0 text-fg-success-secondary" />
                                                <div className="min-w-0 flex-1">
                                                    <button
                                                        type="button"
                                                        onClick={() => openTask(task.id)}
                                                        className="cursor-pointer rounded-sm text-left text-sm font-medium text-primary outline-focus-ring hover:underline focus-visible:outline-2"
                                                    >
                                                        {titleOf(task.title)}
                                                    </button>
                                                    <p className="flex flex-wrap items-center gap-x-2 text-xs text-tertiary">
                                                        {completion.kind === "skipped" ? "Skipped" : "Completed"}{" "}
                                                        {formatDateTime(completion.at, shell.preferences.timeZone)} by{" "}
                                                        {personLabel(completion.by, shell.assignable[task.projectId])}
                                                        {completion.occurrenceDate && <span>· due {shortDate(completion.occurrenceDate)}</span>}
                                                        {owner && (
                                                            <span className="inline-flex items-center gap-1">
                                                                · <ProjectDot color={owner.color} /> {owner.name}
                                                            </span>
                                                        )}
                                                    </p>
                                                </div>
                                                {canEdit(task.projectId) && latest && (task.status === "completed" || task.recurrence) && (
                                                    <Button size="sm" color="link-gray" onClick={() => void actions.reopen(task)}>
                                                        {task.recurrence ? "Undo" : "Reopen"}
                                                    </Button>
                                                )}
                                            </li>
                                        );
                                    })}
                            </ul>
                        </section>
                    ))}
                    {hasMore && (
                        <Button
                            size="sm"
                            color="secondary"
                            className="self-start"
                            isLoading={loading}
                            onClick={async () => {
                                setLoading(true);
                                try {
                                    const more = await tasksApi.completed(entries[entries.length - 1].completion.id);
                                    setEntries([...entries, ...more.entries]);
                                    setHasMore(more.hasMore);
                                } catch (error) {
                                    toast.error("Couldn't load more", errorMessage(error));
                                } finally {
                                    setLoading(false);
                                }
                            }}
                        >
                            Load more
                        </Button>
                    )}
                </div>
            )}
            {actions.dialogs}
        </>
    );
};
