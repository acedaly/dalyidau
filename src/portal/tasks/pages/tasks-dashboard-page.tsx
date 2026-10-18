// The Tasks dashboard: what needs attention, for you (Personal) and for the household (Shared).
//
// Every count comes from the Worker and covers exactly what the person could open: the household
// tab looks only at shared projects they're a member of. Tasks can be completed and rescheduled in
// place (the same row and actions as every list); everything else links to where it lives. After
// any change the dashboard is re-read, so counts never drift from the lists. Cards can be hidden;
// the choice and the household filter follow the person to other devices.
import { useCallback, useEffect, useRef, useState } from "react";
import {
    AlarmClock,
    CalendarCheck01,
    CheckCircle,
    ClipboardCheck,
    Eye,
    Flag01,
    Folder,
    Inbox01,
    LayersThree01,
    Repeat04,
    Sun,
    Target04,
    Users01,
} from "@untitledui/icons";
import { Tabs } from "@/components/application/tabs/tabs";
import { ButtonGroup, ButtonGroupItem } from "@/components/base/button-group/button-group";
import { Button } from "@/components/base/buttons/button";
import { Checkbox } from "@/components/base/checkbox/checkbox";
import { ProgressBar } from "@/components/base/progress-indicators/progress-indicators";
import { PortalDialog } from "@/portal/components/dialog";
import { CardSkeleton, Empty } from "@/portal/components/empty";
import { MetricCard } from "@/portal/components/metric-card";
import type { PageData } from "@/portal/lib/page-types";
import { relativeDate, shortDate } from "@/shared/tasks/dates";
import {
    DASHBOARD_CARDS,
    DASHBOARD_CARD_LABELS,
    type DashboardCard,
    type DashboardPreferences,
    HOUSEHOLD_FILTERS,
    HOUSEHOLD_FILTER_LABELS,
    type HouseholdDashboard,
    type HouseholdFilter,
    type PersonalDashboard,
    type ProjectCard,
    type TaskGoal,
    type TaskRoutine,
} from "@/shared/tasks/productivity";
import { projectHref } from "../api";
import { goalHref, productivityApi } from "../productivity-api";
import { Card, GoalProgress, HealthBadge, MoreLink, Quiet, TargetText, TaskLines } from "../productivity-ui";
import { ProjectDot, personLabel, titleOf } from "../shared";
import { TaskList } from "../task-list";
import { useTaskChanges, useTasks } from "../tasks-context";
import { TasksHeader, TasksLayout } from "../tasks-layout";
import { useTaskActions } from "../use-task-actions";

type Tab = "personal" | "household";

export const TasksDashboardPage = ({ data }: { data: PageData<"tasks-dashboard"> }) => (
    <TasksLayout shell={data}>
        <DashboardBody data={data} />
    </TasksLayout>
);

const DashboardBody = ({ data }: { data: PageData<"tasks-dashboard"> }) => {
    const [tab, setTab] = useState<Tab>(data.tab);
    const [prefs, setPrefs] = useState<DashboardPreferences>(data.dashboardPreferences);
    const [personal, setPersonal] = useState<PersonalDashboard | null>(data.personal);
    const [household, setHousehold] = useState<HouseholdDashboard | null>(data.household);
    const [filter, setFilter] = useState<HouseholdFilter>(data.household?.filter ?? prefs.household ?? "all");
    const [customising, setCustomising] = useState(false);
    const latest = useRef(0);

    const load = useCallback(async (next: Tab, nextFilter: HouseholdFilter) => {
        const request = ++latest.current;
        try {
            const result = await productivityApi.dashboard(next, nextFilter);
            if (request !== latest.current) return;
            if (result.personal) setPersonal(result.personal);
            if (result.household) setHousehold(result.household);
        } catch {
            // Keep what's shown; the next change tries again.
        }
    }, []);

    // Completing or rescheduling anything re-reads the counts (once per burst of changes).
    const timer = useRef<number | null>(null);
    useTaskChanges(() => {
        if (timer.current) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => void load(tab, filter), 300);
    });
    useEffect(() => () => void (timer.current && window.clearTimeout(timer.current)), []);

    const savePrefs = (next: DashboardPreferences) => {
        setPrefs(next);
        void productivityApi.setDashboardPreferences(next).catch(() => undefined);
    };

    const switchTab = (next: Tab) => {
        setTab(next);
        const url = new URL(window.location.href);
        url.searchParams.set("tab", next);
        window.history.replaceState(null, "", url);
        savePrefs({ ...prefs, tab: next });
        if (next === "household" ? !household : !personal) void load(next, filter);
    };

    const hidden = new Set(prefs.hidden ?? []);
    const shows = (card: DashboardCard) => !hidden.has(card);

    return (
        <>
            <TasksHeader
                title="Dashboard"
                description="What needs attention, and how things are going. Counts include only what you can open."
                crumb={{ label: "Dashboard" }}
                actions={
                    <Button size="sm" color="secondary" iconLeading={Eye} onClick={() => setCustomising(true)}>
                        Customise
                    </Button>
                }
            />
            <Tabs selectedKey={tab} onSelectionChange={(key) => switchTab(key as Tab)} className="gap-6">
                <Tabs.List type="underline" size="sm" aria-label="Dashboard" className="w-max max-w-full overflow-x-auto">
                    <Tabs.Item id="personal">Personal</Tabs.Item>
                    <Tabs.Item id="household">Household</Tabs.Item>
                </Tabs.List>
                <Tabs.Panel id="personal">{personal ? <Personal data={personal} shows={shows} /> : <Loading />}</Tabs.Panel>
                <Tabs.Panel id="household">
                    <div className="flex flex-col gap-6">
                        <ButtonGroup
                            size="sm"
                            aria-label="Which shared tasks"
                            selectionMode="single"
                            disallowEmptySelection
                            selectedKeys={new Set([filter])}
                            className="max-w-full overflow-x-auto"
                            onSelectionChange={(keys) => {
                                const next = [...keys][0] as HouseholdFilter | undefined;
                                if (!next || next === filter) return;
                                setFilter(next);
                                savePrefs({ ...prefs, household: next });
                                void load("household", next);
                            }}
                        >
                            {HOUSEHOLD_FILTERS.map((f) => (
                                <ButtonGroupItem key={f} id={f}>
                                    {HOUSEHOLD_FILTER_LABELS[f]}
                                </ButtonGroupItem>
                            ))}
                        </ButtonGroup>
                        {household ? <Household data={household} shows={shows} /> : <Loading />}
                    </div>
                </Tabs.Panel>
            </Tabs>
            <PortalDialog
                isOpen={customising}
                onOpenChange={setCustomising}
                title="Customise the dashboard"
                icon={Eye}
                description="Choose which cards to show. This only changes your own dashboard."
            >
                <div className="flex flex-col gap-3 pb-6">
                    {DASHBOARD_CARDS.map((c) => (
                        <Checkbox
                            key={c}
                            label={DASHBOARD_CARD_LABELS[c]}
                            isSelected={!hidden.has(c)}
                            onChange={(on) => savePrefs({ ...prefs, hidden: on ? [...hidden].filter((h) => h !== c) : [...hidden, c] })}
                        />
                    ))}
                </div>
            </PortalDialog>
        </>
    );
};

const Loading = () => (
    <div role="status" aria-label="Loading the dashboard" className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[1, 2, 3, 4].map((i) => (
            <CardSkeleton key={i} />
        ))}
    </div>
);

const Footer = ({ href, label }: { href: string; label: string }) => (
    <Button size="sm" color="link-color" href={href}>
        {label}
    </Button>
);

const Personal = ({ data, shows }: { data: PersonalDashboard; shows: (card: DashboardCard) => boolean }) => {
    const actions = useTaskActions();
    const { today } = useTasks();
    // Overdue first, then today: each task once.
    const focus = [...data.overdue.tasks, ...data.dueToday.tasks.filter((t) => !data.overdue.tasks.some((o) => o.id === t.id))];
    const nothing = !data.overdue.count && !data.dueToday.count && !data.next7.count && !data.inbox.count && !data.projects.length && !data.goals.length;
    return (
        <div className="flex flex-col gap-6">
            <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
                <MetricCard label="Due today" value={data.dueToday.count} icon={Sun} footer={<Footer href="/portal/tasks/today" label="Today" />} />
                <MetricCard label="Overdue" value={data.overdue.count} icon={AlarmClock} footer={<Footer href="/portal/tasks/overdue" label="Overdue" />} />
                <MetricCard
                    label="Next 7 days"
                    value={data.next7.count}
                    icon={CalendarCheck01}
                    footer={<Footer href="/portal/tasks/upcoming" label="Upcoming" />}
                />
                <MetricCard
                    label="High priority"
                    value={data.highPriority.count}
                    icon={Flag01}
                    detail="P1 and P2, any date"
                    footer={<Footer href="/portal/tasks/filters?priorities=1,2&assignee=mine" label="Show them" />}
                />
            </div>
            {nothing && (
                <Empty
                    icon={Sun}
                    title="All clear"
                    description="Nothing is due, overdue or waiting to be sorted. Press q to add a task, or plan the week from Upcoming."
                    size="sm"
                />
            )}
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                {shows("focus") && (focus.length > 0 || data.inbox.count > 0) && (
                    <Card title="Today and overdue" icon={Sun} count={data.overdue.count + data.dueToday.count} id="card-focus" className="lg:col-span-2">
                        {focus.length ? (
                            <TaskList tasks={focus} actions={actions} showProject aria-label="Today and overdue" />
                        ) : (
                            <Quiet>Nothing due today.</Quiet>
                        )}
                        {data.overdue.count + data.dueToday.count > focus.length && <MoreLink href="/portal/tasks/today">All of today</MoreLink>}
                        {actions.dialogs}
                    </Card>
                )}
                {shows("week") && (
                    <Card title="Next seven days" icon={CalendarCheck01} count={data.next7.count} id="card-week">
                        {data.next7.tasks.length ? <TaskLines tasks={data.next7.tasks} /> : <Quiet>Nothing scheduled for the coming week.</Quiet>}
                        <MoreLink href="/portal/tasks/upcoming?mode=week">Plan the week</MoreLink>
                    </Card>
                )}
                {shows("focus") && data.inbox.count > 0 && (
                    <Card title="Waiting in your Inbox" icon={Inbox01} count={data.inbox.count} id="card-inbox">
                        <Quiet>Captured but not sorted: give them a date or a project.</Quiet>
                        <TaskLines tasks={data.inbox.tasks} showProject={false} />
                        <MoreLink href="/portal/tasks/inbox">Sort the Inbox</MoreLink>
                    </Card>
                )}
                {shows("projects") && <ProjectsCard title="Personal projects" projects={data.projects} today={today} empty="No active personal projects." />}
                {shows("goals") && <GoalsCard goals={data.goals} today={today} />}
                {shows("milestones") && (
                    <Card title="Upcoming milestones" icon={Target04} count={data.milestones.length} id="card-milestones">
                        {data.milestones.length ? (
                            <TaskLines tasks={data.milestones} />
                        ) : (
                            <Quiet>No milestones in the next 30 days. Mark important targets as milestones in a task's details.</Quiet>
                        )}
                    </Card>
                )}
                {shows("routines") && <RoutinesCard routines={data.routines} title="Your routines this week" />}
                {shows("reviews") && data.reviewsDue.length > 0 && (
                    <Card title="Reviews due" icon={ClipboardCheck} count={data.reviewsDue.length} id="card-reviews">
                        <ul className="divide-y divide-secondary">
                            {data.reviewsDue.map((r) => (
                                <li key={r.projectId} className="flex items-center justify-between gap-3 py-2 text-sm">
                                    <a href={projectHref(r.projectId, "overview")} className="truncate font-medium text-primary hover:underline">
                                        {r.name}
                                    </a>
                                    <span className="shrink-0 text-tertiary">Due {relativeDate(r.due, today)}</span>
                                </li>
                            ))}
                        </ul>
                    </Card>
                )}
                {shows("done") && (
                    <Card title="Completed this week" icon={CheckCircle} count={data.completedRecently.count} id="card-done">
                        {data.completedRecently.tasks.length ? (
                            <TaskLines tasks={data.completedRecently.tasks} />
                        ) : (
                            <Quiet>Nothing completed in the last seven days.</Quiet>
                        )}
                        <MoreLink href="/portal/tasks/reports">Reports</MoreLink>
                    </Card>
                )}
            </div>
        </div>
    );
};

const Household = ({ data, shows }: { data: HouseholdDashboard; shows: (card: DashboardCard) => boolean }) => {
    const actions = useTaskActions();
    const { today, shell } = useTasks();
    const people = Object.values(shell.assignable).flat();
    if (!data.projectCount)
        return (
            <Empty
                icon={Users01}
                title="No shared projects yet"
                description="Share a project with someone (Project → Share) and the household's tasks, routines and progress will appear here. Nothing private is ever shown."
                actions={
                    <Button size="md" href="/portal/tasks/projects?kind=shared">
                        Shared projects
                    </Button>
                }
            />
        );
    return (
        <div className="flex flex-col gap-6">
            <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
                <MetricCard label="Needs attention" value={data.attention.count} icon={AlarmClock} detail="Overdue or due today" />
                <MetricCard label="Next 14 days" value={data.upcoming.count} icon={CalendarCheck01} />
                <MetricCard label="Commitments" value={data.commitments.count} icon={Target04} detail="Open, with a deadline" />
                <MetricCard label="Shared projects" value={data.projectCount} icon={Folder} />
            </div>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                {shows("focus") && (
                    <Card title="Needs attention" icon={AlarmClock} count={data.attention.count} id="card-shared-attention" className="lg:col-span-2">
                        {data.attention.tasks.length ? (
                            <TaskList tasks={data.attention.tasks} actions={actions} showProject aria-label="Shared tasks needing attention" />
                        ) : (
                            <Quiet>Nothing overdue or due today.</Quiet>
                        )}
                        {actions.dialogs}
                    </Card>
                )}
                {shows("week") && (
                    <Card title="Coming up" icon={CalendarCheck01} count={data.upcoming.count} id="card-shared-upcoming">
                        {data.upcoming.tasks.length ? <TaskLines tasks={data.upcoming.tasks} /> : <Quiet>Nothing due in the next fortnight.</Quiet>}
                        <MoreLink href="/portal/tasks/workload?scope=shared">Shared workload</MoreLink>
                    </Card>
                )}
                <Card title="Who's doing what" icon={Users01} id="card-people">
                    <Quiet>Open shared tasks by who they're assigned to. It's a picture of the work, not a score.</Quiet>
                    <ul className="flex flex-col gap-2">
                        {data.byAssignee.map((p) => (
                            <li key={p.email ?? "none"} className="flex items-center justify-between gap-3 text-sm">
                                <span className="truncate text-secondary">{p.email ? (p.name ?? personLabel(p.email, people)) : "Not assigned"}</span>
                                <span className="shrink-0 text-tertiary tabular-nums">
                                    {p.open} open{p.overdue ? ` · ${p.overdue} overdue` : ""}
                                </span>
                            </li>
                        ))}
                    </ul>
                </Card>
                {shows("milestones") && (
                    <Card title="Shared commitments" icon={Target04} count={data.commitments.count} id="card-commitments">
                        {data.commitments.tasks.length ? <TaskLines tasks={data.commitments.tasks} /> : <Quiet>No open tasks with deadlines.</Quiet>}
                    </Card>
                )}
                {shows("routines") && <RoutinesCard routines={data.routines} title="Household routines" />}
                {shows("projects") && <ProjectsCard title="Shared projects" projects={data.projects} today={today} empty="No active shared projects." />}
                {shows("goals") && data.goals.length > 0 && <GoalsCard goals={data.goals} today={today} title="Shared goals" />}
                {shows("done") && (
                    <Card title="Done this week" icon={CheckCircle} count={data.completedRecently.count} id="card-shared-done">
                        {data.completedRecently.tasks.length ? (
                            <TaskLines
                                tasks={data.completedRecently.tasks}
                                meta={(t) => t.completedBy && <span className="text-xs text-tertiary">by {personLabel(t.completedBy, people)}</span>}
                            />
                        ) : (
                            <Quiet>Nothing shared was completed in the last seven days.</Quiet>
                        )}
                    </Card>
                )}
            </div>
        </div>
    );
};

const ProjectsCard = ({ title, projects, today, empty }: { title: string; projects: ProjectCard[]; today: string; empty: string }) => (
    <Card title={title} icon={LayersThree01} count={projects.length} id={`card-${title.toLowerCase().replace(/\s+/g, "-")}`}>
        {projects.length ? (
            <ul className="flex flex-col gap-4">
                {projects.map((p) => {
                    const total = p.open + p.completed;
                    return (
                        <li key={p.id} className="flex flex-col gap-1.5">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <a
                                    href={projectHref(p.id, "overview")}
                                    className="flex min-w-0 items-center gap-2 text-sm font-medium text-primary hover:underline"
                                >
                                    <ProjectDot color={p.color} />
                                    <span className="truncate">{p.name}</span>
                                </a>
                                <HealthBadge health={p.health} />
                            </div>
                            {total > 0 && (
                                <ProgressBar
                                    value={Math.round((p.completed / total) * 100)}
                                    labelPosition="right"
                                    aria-label={`${p.name}: progress`}
                                    valueFormatter={() => `${p.completed} of ${total}`}
                                />
                            )}
                            <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-tertiary">
                                {p.overdue > 0 && <span className="text-error-primary">{p.overdue} overdue</span>}
                                <TargetText date={p.targetDate} today={today} />
                                {p.health.reasons[0] && p.health.status !== "on_track" && <span>{p.health.reasons[0].text}</span>}
                            </div>
                        </li>
                    );
                })}
            </ul>
        ) : (
            <Quiet>{empty}</Quiet>
        )}
    </Card>
);

const GoalsCard = ({ goals, today, title = "Goals" }: { goals: TaskGoal[]; today: string; title?: string }) => (
    <Card title={title} icon={Target04} count={goals.length} id={`card-${title.toLowerCase().replace(/\s+/g, "-")}`}>
        {goals.length ? (
            <ul className="flex flex-col gap-4">
                {goals.map((g) => (
                    <li key={g.id} className="flex flex-col gap-1.5">
                        <a href={goalHref(g.id)} className="truncate text-sm font-medium text-primary hover:underline">
                            {titleOf(g.title)}
                        </a>
                        <GoalProgress goal={g} />
                        <div className="flex flex-wrap gap-x-3 text-xs text-tertiary">
                            {g.attention ? <span className="text-warning-primary">{g.attention}</span> : <TargetText date={g.targetDate} today={today} />}
                            {g.milestones.next && (
                                <span>
                                    Next: {g.milestones.next.title}
                                    {g.milestones.next.targetDate ? ` (${shortDate(g.milestones.next.targetDate)})` : ""}
                                </span>
                            )}
                        </div>
                    </li>
                ))}
            </ul>
        ) : (
            <Quiet>No active goals. Set one from Goals to see its progress here.</Quiet>
        )}
        <MoreLink href="/portal/tasks/goals">All goals</MoreLink>
    </Card>
);

const RoutinesCard = ({ routines, title }: { routines: TaskRoutine[]; title: string }) => {
    const { today, shell } = useTasks();
    const people = Object.values(shell.assignable).flat();
    return (
        <Card title={title} icon={Repeat04} count={routines.length} id={`card-${title.toLowerCase().replace(/\s+/g, "-")}`}>
            {routines.length ? (
                <ul className="divide-y divide-secondary">
                    {routines.map((r) => (
                        <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                            <a href={`/portal/tasks/routines#${r.id}`} className="min-w-0 flex-1 truncate font-medium text-primary hover:underline">
                                {titleOf(r.task.title)}
                            </a>
                            <span className="shrink-0 text-xs text-tertiary">
                                {r.task.dueDate ? relativeDate(r.task.dueDate, today) : "No date"}
                                {r.responsible ? ` · ${personLabel(r.responsible, people)}` : ""}
                            </span>
                        </li>
                    ))}
                </ul>
            ) : (
                <Quiet>No routines due in the coming week.</Quiet>
            )}
            <MoreLink href="/portal/tasks/routines">All routines</MoreLink>
        </Card>
    );
};
