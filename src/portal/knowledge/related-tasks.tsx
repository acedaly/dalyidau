// "Tasks" on a Knowledge object page: tasks and projects in Daly Tasks that reference this object.
//
// Both permission systems apply: the Worker returns nothing unless the reader can open this object in
// Knowledge, and then only tasks and projects they're a member of in Tasks; someone else's private
// tasks never appear, and no count includes them. "Add linked task" opens the portal-wide Quick Add, which
// offers to link the new task to this page; the list refreshes when it's saved.
import { useCallback, useEffect, useState } from "react";
import { CheckCircle, Folder, Plus } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { Skeleton } from "@/portal/components/empty";
import { relativeDate } from "@/shared/tasks/dates";
import { PRIORITY_LABELS, type TaskColor, type TaskSummary } from "@/shared/tasks/types";
import { cx } from "@/utils/cx";
import { taskHref } from "../tasks/api";
import { productivityApi } from "../tasks/productivity-api";
import { TASK_CREATED_EVENT, requestQuickAdd } from "../tasks/quick-add-events";
import { DOT_COLORS } from "../tasks/shared";

type Related = Awaited<ReturnType<typeof productivityApi.relatedToKnowledge>>;

export const RelatedTasks = ({ objectId, today }: { objectId: string; today: string }) => {
    const [related, setRelated] = useState<Related | null>(null);
    const [failed, setFailed] = useState(false);
    const load = useCallback(() => {
        productivityApi.relatedToKnowledge(objectId).then(
            (r) => (setRelated(r), setFailed(false)),
            () => setFailed(true),
        );
    }, [objectId]);
    useEffect(() => {
        load();
        window.addEventListener(TASK_CREATED_EVENT, load);
        return () => window.removeEventListener(TASK_CREATED_EVENT, load);
    }, [load]);

    const open = related?.tasks.filter((t) => t.status === "open") ?? [];
    const done = related?.tasks.filter((t) => t.status === "completed") ?? [];
    const projectOf = (id: string) => related?.taskProjects.find((p) => p.id === id);

    return (
        <section className="flex flex-col gap-3 border-t border-secondary pt-5" aria-labelledby="related-tasks">
            <div className="flex items-center justify-between gap-3">
                <h2 id="related-tasks" className="text-sm font-semibold text-primary">
                    Tasks
                </h2>
                <Button size="sm" color="link-color" iconLeading={Plus} onClick={requestQuickAdd}>
                    Add linked task
                </Button>
            </div>
            {failed ? (
                <p className="text-sm text-tertiary">Tasks couldn't be loaded.</p>
            ) : !related ? (
                <Skeleton className="h-12" />
            ) : !related.tasks.length && !related.projects.length ? (
                <p className="text-sm text-tertiary">No tasks you can see link here. Add one and it's linked to this page.</p>
            ) : (
                <>
                    {related.projects.length > 0 && (
                        <ul className="flex flex-col gap-2" aria-label="Linked projects">
                            {related.projects.map((p) => (
                                <li key={p.id} className="flex items-center gap-2 text-sm">
                                    <Folder aria-hidden="true" className="size-4 shrink-0 text-fg-quaternary" />
                                    <a
                                        href={`/portal/tasks/p/${p.id}?view=overview`}
                                        className="min-w-0 flex-1 truncate font-medium text-secondary hover:text-brand-secondary hover:underline"
                                    >
                                        {p.name}
                                    </a>
                                    <span className="shrink-0 text-xs text-tertiary">
                                        {p.completed} of {p.open + p.completed} done
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )}
                    <ul className="flex flex-col gap-2.5" aria-label="Linked tasks" aria-live="polite">
                        {[...open, ...done].slice(0, 20).map((t) => (
                            <TaskItem key={t.id} task={t} today={today} project={projectOf(t.projectId)} />
                        ))}
                    </ul>
                    {related.tasks.length > 20 && <p className="text-xs text-tertiary">Showing 20 of {related.tasks.length}.</p>}
                </>
            )}
        </section>
    );
};

const TaskItem = ({ task, today, project }: { task: TaskSummary; today: string; project?: { name: string; color: string } }) => {
    const overdue = task.status === "open" && !!task.dueDate && task.dueDate < today;
    return (
        <li className="flex gap-2 text-sm">
            {task.status === "completed" ? (
                <CheckCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-fg-success-secondary" />
            ) : (
                <span aria-hidden="true" className="mt-1 size-3.5 shrink-0 rounded-full ring-1 ring-primary ring-inset" />
            )}
            <span className="min-w-0 flex-1">
                <a
                    href={taskHref(task.id)}
                    className={cx(
                        "block truncate font-medium text-secondary hover:text-brand-secondary hover:underline",
                        task.status === "completed" && "text-tertiary line-through",
                    )}
                >
                    {task.title}
                    <span className="sr-only">{task.status === "completed" ? ", completed" : ", open"}</span>
                </a>
                <span className="flex flex-wrap gap-x-2 text-xs text-tertiary">
                    {project && (
                        <span className="flex items-center gap-1">
                            <span
                                aria-hidden="true"
                                className={cx("inline-block size-1.5 rounded-full", DOT_COLORS[project.color as TaskColor] ?? DOT_COLORS.gray)}
                            />
                            {project.name}
                        </span>
                    )}
                    {task.priority < 4 && <span>{PRIORITY_LABELS[task.priority].short}</span>}
                    {task.dueDate && task.status === "open" && (
                        <span className={overdue ? "text-error-primary" : undefined}>
                            {overdue ? "Overdue: " : "Due "}
                            {relativeDate(task.dueDate, today)}
                        </span>
                    )}
                    {task.assignee && <span>{task.assignee.split("@")[0]}</span>}
                </span>
            </span>
        </li>
    );
};
