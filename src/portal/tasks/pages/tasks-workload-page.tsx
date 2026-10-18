// Workload: the next one to four weeks of dated tasks, grouped by day, week, project, priority or
// person, with what's overdue and what has no date. Warnings are fixed, stated thresholds (three
// high-priority tasks on one day, eight tasks on one day, three overdue, a project target within a
// fortnight with five or more open tasks). Tasks have no effort estimates, so nothing here claims
// to know how long anything takes: it counts tasks.
//
// "Mine" is what Today and Upcoming show; "Shared" is every open task in the shared projects you're
// a member of, whoever it's assigned to. Tasks can be completed and rescheduled in place.
import { useCallback, useRef, useState } from "react";
import { AlarmClock, AlertTriangle, ArrowLeft, ArrowRight, CalendarCheck01, CalendarMinus01, Flag01, Repeat04, Target04 } from "@untitledui/icons";
import { ButtonGroup, ButtonGroupItem } from "@/components/base/button-group/button-group";
import { Button } from "@/components/base/buttons/button";
import { Select } from "@/components/base/select/select";
import { Empty } from "@/portal/components/empty";
import { MetricCard } from "@/portal/components/metric-card";
import { Notice } from "@/portal/components/notice";
import type { PageData } from "@/portal/lib/page-types";
import { addDays, longDate, shortDate, weekStart } from "@/shared/tasks/dates";
import { WORKLOAD_GROUPS, WORKLOAD_GROUP_LABELS, WORKLOAD_RULES, type Workload, type WorkloadGroup } from "@/shared/tasks/productivity";
import { PRIORITY_LABELS, type Priority, type TaskSummary } from "@/shared/tasks/types";
import { productivityApi } from "../productivity-api";
import { personLabel } from "../shared";
import { TaskList } from "../task-list";
import { useTaskChanges, useTasks } from "../tasks-context";
import { TasksHeader, TasksLayout } from "../tasks-layout";
import { useTaskActions } from "../use-task-actions";

export const TasksWorkloadPage = ({ data }: { data: PageData<"tasks-workload"> }) => (
    <TasksLayout shell={data}>
        <WorkloadBody data={data} />
    </TasksLayout>
);

const WorkloadBody = ({ data }: { data: PageData<"tasks-workload"> }) => {
    const { today, project } = useTasks();
    const actions = useTaskActions();
    const [w, setW] = useState<Workload>(data.workload);
    const [group, setGroup] = useState<WorkloadGroup>(data.group);
    const [loading, setLoading] = useState(false);
    const latest = useRef(0);

    const load = useCallback(
        async (scope: Workload["scope"], weeks: number, from: string, nextGroup = group) => {
            const request = ++latest.current;
            setLoading(true);
            const url = new URL(window.location.href);
            url.searchParams.set("scope", scope);
            url.searchParams.set("weeks", String(weeks));
            url.searchParams.set("from", from);
            url.searchParams.set("group", nextGroup);
            window.history.replaceState(null, "", url);
            try {
                const result = await productivityApi.workload(scope, weeks, from);
                if (request === latest.current) setW(result.workload);
            } catch {
                // Keep what's shown.
            } finally {
                if (request === latest.current) setLoading(false);
            }
        },
        [group],
    );
    useTaskChanges(() => void load(w.scope, w.weeks, w.from));

    const people = w.people;
    const groups = groupTasks(w.tasks, group, {
        project: (id) => project(id)?.name ?? "Project",
        person: (email) => (email ? personLabel(email, people) : "Not assigned"),
    });
    const thisWeek = weekStart(today);

    return (
        <>
            <TasksHeader
                title="Workload"
                description={`${shortDate(w.from)} – ${shortDate(w.to)} · ${w.scope === "shared" ? "everything in your shared projects" : "tasks you're responsible for"}`}
                crumb={{ label: "Workload" }}
            />
            <div className="flex flex-wrap items-center gap-3" aria-busy={loading}>
                <ButtonGroup
                    size="sm"
                    aria-label="Whose tasks"
                    selectionMode="single"
                    disallowEmptySelection
                    selectedKeys={new Set([w.scope])}
                    onSelectionChange={(keys) => {
                        const scope = [...keys][0] as Workload["scope"] | undefined;
                        if (scope && scope !== w.scope) void load(scope, w.weeks, w.from);
                    }}
                >
                    <ButtonGroupItem id="mine">Mine</ButtonGroupItem>
                    <ButtonGroupItem id="shared">Shared</ButtonGroupItem>
                </ButtonGroup>
                <Select
                    aria-label="How many weeks"
                    size="sm"
                    className="w-36"
                    value={String(w.weeks)}
                    onChange={(key) => key && void load(w.scope, Number(key), w.from)}
                    items={[1, 2, 3, 4].map((n) => ({ id: String(n), label: n === 1 ? "1 week" : `${n} weeks` }))}
                >
                    {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                </Select>
                <div className="flex gap-2">
                    <Button
                        size="sm"
                        color="secondary"
                        iconLeading={ArrowLeft}
                        aria-label="Earlier"
                        onClick={() => void load(w.scope, w.weeks, addDays(w.from, -7))}
                    />
                    <Button size="sm" color="secondary" onClick={() => void load(w.scope, w.weeks, thisWeek)} isDisabled={w.from === thisWeek}>
                        This week
                    </Button>
                    <Button
                        size="sm"
                        color="secondary"
                        iconLeading={ArrowRight}
                        aria-label="Later"
                        onClick={() => void load(w.scope, w.weeks, addDays(w.from, 7))}
                    />
                </div>
                <Select
                    aria-label="Group by"
                    size="sm"
                    className="w-40"
                    value={group}
                    onChange={(key) => {
                        if (!key) return;
                        setGroup(key as WorkloadGroup);
                        const url = new URL(window.location.href);
                        url.searchParams.set("group", String(key));
                        window.history.replaceState(null, "", url);
                    }}
                    items={WORKLOAD_GROUPS.filter((g) => g !== "assignee" || w.scope === "shared").map((g) => ({
                        id: g,
                        label: `By ${WORKLOAD_GROUP_LABELS[g].toLowerCase()}`,
                    }))}
                >
                    {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                </Select>
            </div>

            <div className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-3 xl:grid-cols-6">
                <MetricCard label="This week" value={w.summary.thisWeek} icon={CalendarCheck01} />
                <MetricCard label="Next week" value={w.summary.nextWeek} icon={CalendarCheck01} />
                <MetricCard label="High priority" value={w.summary.highPriority} icon={Flag01} detail="P1–P2 in this window" />
                <MetricCard label="Deadlines" value={w.summary.deadlines} icon={Target04} />
                <MetricCard label="Overdue" value={w.overdue.count} icon={AlarmClock} />
                <MetricCard label="No date" value={w.undated.count} icon={CalendarMinus01} />
            </div>

            {w.warnings.length > 0 && (
                <Notice color="warning" title="Worth a look">
                    <ul className="flex flex-col gap-1">
                        {w.warnings.map((warning) => (
                            <li key={`${warning.kind}:${warning.date ?? warning.projectId ?? ""}`} className="flex items-start gap-2">
                                <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                                {warning.text}
                            </li>
                        ))}
                    </ul>
                    <p className="mt-2 text-xs">
                        Flagged at {WORKLOAD_RULES.highPriorityPerDay} high-priority or {WORKLOAD_RULES.tasksPerDay} tasks on one day, {WORKLOAD_RULES.overdue}{" "}
                        overdue, or a project target within {WORKLOAD_RULES.projectDays} days with {WORKLOAD_RULES.projectOpen}+ tasks open. Counts only: tasks
                        have no time estimates.
                    </p>
                </Notice>
            )}
            {w.truncated && (
                <Notice color="gray" title="Showing the first tasks only">
                    This window has more tasks than can be shown at once. Choose fewer weeks to see them all.
                </Notice>
            )}

            {w.overdue.count > 0 && (
                <section className="flex flex-col gap-2" aria-label="Overdue">
                    <h2 className="text-md font-semibold text-primary">
                        Overdue <span className="text-sm font-medium text-tertiary">{w.overdue.count}</span>
                    </h2>
                    <TaskList tasks={w.overdue.tasks} actions={actions} showProject aria-label="Overdue tasks" />
                </section>
            )}

            {groups.length ? (
                groups.map((g) => (
                    <section key={g.key} className="flex flex-col gap-2" aria-label={g.label}>
                        <h2 className="flex flex-wrap items-baseline gap-2 text-md font-semibold text-primary">
                            {g.label}
                            <span className="text-sm font-medium text-tertiary">
                                {g.tasks.length} task{g.tasks.length === 1 ? "" : "s"}
                                {g.tasks.some((t) => t.projected) && (
                                    <>
                                        {" · "}
                                        <Repeat04 aria-hidden="true" className="inline size-3.5" /> includes repeats
                                    </>
                                )}
                            </span>
                        </h2>
                        <TaskList tasks={g.tasks} actions={actions} showProject aria-label={g.label} />
                    </section>
                ))
            ) : (
                <Empty
                    icon={CalendarCheck01}
                    title="Nothing scheduled"
                    description="No tasks with dates in this window. Try a later week, or give undated tasks a date."
                    size="sm"
                />
            )}

            {w.undated.count > 0 && (
                <section className="flex flex-col gap-2" aria-label="No date">
                    <h2 className="text-md font-semibold text-primary">
                        No date <span className="text-sm font-medium text-tertiary">{w.undated.count}</span>
                    </h2>
                    <TaskList tasks={w.undated.tasks} actions={actions} showProject aria-label="Tasks without a date" />
                </section>
            )}
            {actions.dialogs}
        </>
    );
};

/** Groups in a stable order: by date for days and weeks, by name for projects and people, by priority. */
function groupTasks(
    tasks: TaskSummary[],
    by: WorkloadGroup,
    names: { project: (id: string) => string; person: (email: string | null) => string },
): { key: string; label: string; tasks: TaskSummary[] }[] {
    const map = new Map<string, { key: string; label: string; sort: string; tasks: TaskSummary[] }>();
    for (const t of tasks) {
        const date = t.dueDate ?? "";
        const [key, label, sort] =
            by === "day"
                ? [date, longDate(date), date]
                : by === "week"
                  ? [weekStart(date), `Week of ${shortDate(weekStart(date))}`, weekStart(date)]
                  : by === "project"
                    ? [t.projectId, names.project(t.projectId), names.project(t.projectId).toLowerCase()]
                    : by === "priority"
                      ? [
                            String(t.priority),
                            `${PRIORITY_LABELS[t.priority as Priority].short} · ${PRIORITY_LABELS[t.priority as Priority].label}`,
                            String(t.priority),
                        ]
                      : [t.assignee ?? "", names.person(t.assignee), t.assignee ? names.person(t.assignee).toLowerCase() : "~"];
        const entry = map.get(key) ?? { key, label, sort, tasks: [] };
        entry.tasks.push(t);
        map.set(key, entry);
    }
    return [...map.values()].sort((a, b) => a.sort.localeCompare(b.sort));
}
