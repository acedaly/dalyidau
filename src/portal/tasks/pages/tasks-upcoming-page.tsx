// Upcoming: the next fortnight day by day (or any later fortnight), with overdue tasks first and
// later repeats of repeating tasks shown where they fall (they're worked out, not stored). Each
// day has its own "Add task" for that date.
import { useCallback } from "react";
import { ArrowLeft, ArrowRight, CalendarPlus02 } from "@untitledui/icons";
import { ContentDivider } from "@/components/application/content-divider/content-divider";
import { Button } from "@/components/base/buttons/button";
import { Empty } from "@/portal/components/empty";
import type { PageData } from "@/portal/lib/page-types";
import { addDays, longDate, relativeDate } from "@/shared/tasks/dates";
import { tasksApi } from "../api";
import { DateMenu } from "../pickers";
import { TaskList } from "../task-list";
import { useTasks } from "../tasks-context";
import { TasksHeader, TasksLayout } from "../tasks-layout";
import { useLiveList } from "../use-live-list";
import { useTaskActions } from "../use-task-actions";

export const TasksUpcomingPage = ({ data }: { data: PageData<"tasks-upcoming"> }) => (
    <TasksLayout shell={data}>
        <UpcomingBody data={data} />
    </TasksLayout>
);

const UpcomingBody = ({ data }: { data: PageData<"tasks-upcoming"> }) => {
    const { today } = useTasks();
    const actions = useTaskActions();
    const query = data.from === today ? "" : `?from=${data.from}`;
    const refetchTasks = useCallback(async () => (await tasksApi.list("upcoming", `${query ? `${query}&` : "?"}days=${data.days}`)).tasks, [query, data.days]);
    const refetchOverdue = useCallback(
        async () => (data.from === today ? (await tasksApi.list("overdue")).tasks.filter((t) => t.dueDate && t.dueDate < today) : []),
        [data.from, today],
    );
    const { tasks } = useLiveList(data.tasks, refetchTasks);
    const { tasks: overdue } = useLiveList(
        data.overdue.filter((t) => t.dueDate && t.dueDate < today),
        refetchOverdue,
    );
    const days = Array.from({ length: data.days }, (_, i) => addDays(data.from, i));
    const go = (from: string) => window.location.assign(from <= today ? "/portal/tasks/upcoming" : `/portal/tasks/upcoming?from=${from}`);

    return (
        <>
            <TasksHeader
                title="Upcoming"
                description={`${longDate(data.from)} to ${longDate(days[days.length - 1])}`}
                crumb={{ label: "Upcoming" }}
                actions={
                    <>
                        <Button
                            size="sm"
                            color="secondary"
                            iconLeading={ArrowLeft}
                            isDisabled={data.from <= today}
                            onClick={() => go(addDays(data.from, -data.days))}
                            aria-label="Earlier"
                        >
                            <span className="max-sm:sr-only">Earlier</span>
                        </Button>
                        <DateMenu label="Jump to a date" value={data.from} onChange={(date) => date && go(date)} placeholder="Jump to" />
                        <Button size="sm" color="secondary" iconTrailing={ArrowRight} onClick={() => go(addDays(data.from, data.days))} aria-label="Later">
                            <span className="max-sm:sr-only">Later</span>
                        </Button>
                    </>
                }
            />
            <div className="flex flex-col gap-6">
                {overdue.length > 0 && (
                    <section aria-label="Overdue" className="flex flex-col">
                        <ContentDivider type="single-line" className="mb-1">
                            <h2 className="text-sm font-semibold text-error-primary">Overdue · {overdue.length}</h2>
                        </ContentDivider>
                        <TaskList aria-label="Overdue" tasks={overdue} actions={actions} showProject />
                    </section>
                )}
                {days.map((day) => {
                    const dayTasks = tasks.filter((t) => t.dueDate === day);
                    return (
                        <section key={day} aria-label={longDate(day)} className="flex flex-col">
                            <ContentDivider type="single-line" className="mb-1">
                                <h2 className="text-sm font-semibold text-secondary">
                                    {longDate(day)}
                                    {day <= addDays(today, 1) && <span className="font-normal text-tertiary"> · {relativeDate(day, today)}</span>}
                                </h2>
                            </ContentDivider>
                            <TaskList aria-label={longDate(day)} tasks={dayTasks} actions={actions} showProject addDefaults={{ dueDate: day }} />
                        </section>
                    );
                })}
                {tasks.length === 0 && overdue.length === 0 && (
                    <Empty
                        icon={CalendarPlus02}
                        title="Nothing scheduled"
                        description="Give tasks a date and they'll appear on the day. Repeating tasks show every time they come up."
                        size="sm"
                    />
                )}
            </div>
            {actions.dialogs}
        </>
    );
};
