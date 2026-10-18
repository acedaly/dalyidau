// Reports: what was done over a period and where things stand, built only from recorded history.
//
// Personal reports count your own completions; shared reports count completions in shared projects
// you're a member of. Repeats that haven't happened are never counted, undone completions never
// count, and "late" means completed after that occurrence's due date. Nothing here ranks people:
// the shared report shows how open work is spread, not who did most. Every figure can be
// downloaded as CSV.
import { useState } from "react";
import { BarChart10, CheckCircle, ClockRewind, Download01, Flag01, InfoCircle, Repeat04, SkipForward, Target04, Users01 } from "@untitledui/icons";
import { Badge } from "@/components/base/badges/badges";
import { ButtonGroup, ButtonGroupItem } from "@/components/base/button-group/button-group";
import { Button } from "@/components/base/buttons/button";
import { ProgressBar } from "@/components/base/progress-indicators/progress-indicators";
import { Select } from "@/components/base/select/select";
import { CompletionBars } from "@/portal/components/charts";
import { CardSkeleton } from "@/portal/components/empty";
import { MetricCard } from "@/portal/components/metric-card";
import type { PageData } from "@/portal/lib/page-types";
import { shortDate } from "@/shared/tasks/dates";
import { REPORT_RANGES, REPORT_RANGE_LABELS, type ReportRange, type TasksReport } from "@/shared/tasks/productivity";
import { PRIORITIES, PRIORITY_LABELS } from "@/shared/tasks/types";
import { projectHref } from "../api";
import { goalHref, productivityApi } from "../productivity-api";
import { Card, GoalProgress, Quiet } from "../productivity-ui";
import { ProjectDot, personLabel, titleOf } from "../shared";
import { useTasks } from "../tasks-context";
import { TasksHeader, TasksLayout } from "../tasks-layout";

const MONTH = new Intl.DateTimeFormat("en-AU", { month: "short", year: "2-digit", timeZone: "UTC" });
const periodLabel = (start: string, grouping: "week" | "month") =>
    grouping === "week"
        ? shortDate(start)
              .replace(/^\w+ /, "")
              .replace(/ \d{4}$/, "")
        : MONTH.format(Date.UTC(Number(start.slice(0, 4)), Number(start.slice(5, 7)) - 1, 1));

export const TasksReportsPage = ({ data }: { data: PageData<"tasks-reports"> }) => (
    <TasksLayout shell={data}>
        <ReportsBody data={data} />
    </TasksLayout>
);

const ReportsBody = ({ data }: { data: PageData<"tasks-reports"> }) => {
    const { shell } = useTasks();
    const [report, setReport] = useState<TasksReport>(data.report);
    const [loading, setLoading] = useState(false);
    const people = Object.values(shell.assignable).flat();

    const load = async (scope: TasksReport["scope"], range: ReportRange) => {
        setLoading(true);
        const url = new URL(window.location.href);
        url.searchParams.set("scope", scope);
        url.searchParams.set("range", range);
        window.history.replaceState(null, "", url);
        try {
            setReport((await productivityApi.report(scope, range)).report);
        } finally {
            setLoading(false);
        }
    };

    const r = report;
    const onTimeShare = r.totals.completed ? Math.round(((r.totals.completed - r.totals.late) / r.totals.completed) * 100) : null;
    const maxProject = Math.max(1, ...r.byProject.map((p) => p.completed));
    return (
        <>
            <TasksHeader
                title="Reports"
                description={`${shortDate(r.from)} – ${shortDate(r.to)} · ${r.scope === "shared" ? "shared projects you're a member of" : "your own completions"}`}
                crumb={{ label: "Reports" }}
                actions={
                    <Button size="sm" color="secondary" iconLeading={Download01} href={productivityApi.reportCsvHref(r.scope, r.range)}>
                        CSV
                    </Button>
                }
            />
            <div className="flex flex-wrap items-center gap-3">
                <ButtonGroup
                    size="sm"
                    aria-label="Whose work"
                    selectionMode="single"
                    disallowEmptySelection
                    selectedKeys={new Set([r.scope])}
                    onSelectionChange={(keys) => {
                        const scope = [...keys][0] as TasksReport["scope"] | undefined;
                        if (scope && scope !== r.scope) void load(scope, r.range);
                    }}
                >
                    <ButtonGroupItem id="personal">Personal</ButtonGroupItem>
                    <ButtonGroupItem id="shared">Shared</ButtonGroupItem>
                </ButtonGroup>
                <Select
                    aria-label="Period"
                    size="sm"
                    className="w-44"
                    value={r.range}
                    onChange={(key) => key && void load(r.scope, key as ReportRange)}
                    items={(Object.keys(REPORT_RANGES) as ReportRange[]).map((k) => ({ id: k, label: REPORT_RANGE_LABELS[k] }))}
                >
                    {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                </Select>
            </div>
            {loading ? (
                <div role="status" aria-label="Loading the report" className="grid grid-cols-2 gap-4 xl:grid-cols-4">
                    {[1, 2, 3, 4].map((i) => (
                        <CardSkeleton key={i} />
                    ))}
                </div>
            ) : (
                <>
                    <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
                        <MetricCard label="Completed" value={r.totals.completed} icon={CheckCircle} detail={REPORT_RANGE_LABELS[r.range]} />
                        <MetricCard
                            label="On time"
                            value={onTimeShare === null ? "–" : `${onTimeShare}%`}
                            icon={ClockRewind}
                            detail={`${r.totals.late} completed after their due date`}
                        />
                        <MetricCard label="Skipped" value={r.totals.skipped} icon={SkipForward} detail="Repeats passed over" />
                        <MetricCard label="Open now" value={r.totals.open} icon={Flag01} detail={`${r.totals.overdue} overdue`} />
                    </div>
                    {r.truncated && (
                        <Quiet>
                            This period has more completions than a report reads at once; the figures cover the earliest ones. Choose a shorter period.
                        </Quiet>
                    )}
                    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                        <Card title={`Completed by ${r.grouping}`} icon={BarChart10} className="lg:col-span-2" id="report-trend">
                            {r.totals.completed ? (
                                <CompletionBars
                                    caption={`Tasks completed per ${r.grouping}, on time and late`}
                                    points={r.buckets.map((b) => ({
                                        start: b.start,
                                        label: periodLabel(b.start, r.grouping),
                                        onTime: b.completed - b.late,
                                        late: b.late,
                                    }))}
                                />
                            ) : (
                                <Quiet>Nothing completed in this period.</Quiet>
                            )}
                        </Card>
                        <Card title="Open by priority" icon={Flag01} id="report-priority">
                            <ul className="flex flex-col gap-3">
                                {PRIORITIES.map((p) => (
                                    <li key={p} className="flex items-center justify-between gap-3 text-sm">
                                        <span className="text-secondary">
                                            {PRIORITY_LABELS[p].short} · {PRIORITY_LABELS[p].label}
                                        </span>
                                        <span className="font-medium text-primary tabular-nums">{r.openByPriority[p]}</span>
                                    </li>
                                ))}
                            </ul>
                            <Quiet>{r.scope === "shared" ? "Open tasks in shared projects." : "Open tasks you're responsible for, as in Today."}</Quiet>
                        </Card>
                        <Card title="Completed by project" icon={Target04} id="report-projects">
                            {r.byProject.length ? (
                                <ul className="flex flex-col gap-3">
                                    {r.byProject.map((p) => (
                                        <li key={p.projectId} className="flex flex-col gap-1">
                                            <a
                                                href={projectHref(p.projectId)}
                                                className="flex items-center gap-2 truncate text-sm font-medium text-secondary hover:underline"
                                            >
                                                <ProjectDot color={p.color} />
                                                <span className="truncate">{p.name}</span>
                                            </a>
                                            <ProgressBar
                                                value={(p.completed / maxProject) * 100}
                                                labelPosition="right"
                                                aria-label={`${p.name}: ${p.completed} completed`}
                                                valueFormatter={() => String(p.completed)}
                                            />
                                        </li>
                                    ))}
                                </ul>
                            ) : (
                                <Quiet>Nothing completed yet.</Quiet>
                            )}
                        </Card>
                        <Card title="Repeating tasks" icon={Repeat04} id="report-repeats">
                            {r.recurring.length ? (
                                <ul className="divide-y divide-secondary">
                                    {r.recurring.map((t) => (
                                        <li key={t.taskId} className="flex items-center justify-between gap-3 py-2 text-sm">
                                            <span className="flex min-w-0 items-center gap-2">
                                                <span className="truncate text-secondary">{titleOf(t.title)}</span>
                                                {t.isRoutine && (
                                                    <Badge size="sm" type="color" color="gray">
                                                        Routine
                                                    </Badge>
                                                )}
                                            </span>
                                            <span className="shrink-0 text-tertiary tabular-nums">
                                                {t.completed} done{t.skipped ? ` · ${t.skipped} skipped` : ""}
                                            </span>
                                        </li>
                                    ))}
                                </ul>
                            ) : (
                                <Quiet>No repeating tasks done or skipped in this period.</Quiet>
                            )}
                        </Card>
                        {r.scope === "shared" && (
                            <Card title="Open work by person" icon={Users01} id="report-people">
                                <Quiet>How open shared tasks are spread. Not a measure of anyone.</Quiet>
                                <ul className="flex flex-col gap-2">
                                    {r.assigned.map((a) => (
                                        <li key={a.email ?? "none"} className="flex items-center justify-between gap-3 text-sm">
                                            <span className="truncate text-secondary">
                                                {a.email ? (a.name ?? personLabel(a.email, people)) : "Not assigned"}
                                            </span>
                                            <span className="text-tertiary tabular-nums">{a.open} open</span>
                                        </li>
                                    ))}
                                </ul>
                                {!r.assigned.length && <Quiet>No open shared tasks.</Quiet>}
                            </Card>
                        )}
                        <Card title={r.scope === "shared" ? "Shared goals" : "Personal goals"} icon={Target04} id="report-goals">
                            {r.goals.length ? (
                                <ul className="flex flex-col gap-3">
                                    {r.goals.map((g) => (
                                        <li key={g.id} className="flex flex-col gap-1">
                                            <a href={goalHref(g.id)} className="truncate text-sm font-medium text-secondary hover:underline">
                                                {titleOf(g.title)}
                                            </a>
                                            <GoalProgress goal={g} />
                                        </li>
                                    ))}
                                </ul>
                            ) : (
                                <Quiet>No goals yet.</Quiet>
                            )}
                        </Card>
                    </div>
                    <details className="rounded-xl bg-secondary p-4 text-sm text-secondary">
                        <summary className="flex cursor-pointer items-center gap-2 font-semibold text-primary">
                            <InfoCircle aria-hidden="true" className="size-4" /> How these are worked out
                        </summary>
                        <ul className="mt-3 flex list-disc flex-col gap-1 pl-5">
                            <li>
                                Completed: every time a task, subtask or occurrence of a repeating task was marked done in the period, by its time in your time
                                zone. Undone completions don't count.
                            </li>
                            <li>
                                Late: completed on a later day than the date it was due (the occurrence's date for repeats). Tasks without a date are never
                                late.
                            </li>
                            <li>Skipped: occurrences of repeating tasks passed over with Skip. Future repeats are never counted.</li>
                            <li>Open now and by priority: as Today counts them (personal) or every open task in your shared projects (shared).</li>
                            <li>
                                Personal reports count what you completed; shared reports count completions in shared projects you belong to, by anyone in them.
                            </li>
                        </ul>
                    </details>
                </>
            )}
        </>
    );
};
