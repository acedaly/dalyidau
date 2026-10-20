// Today (/portal/today): one place to plan and run the day. A greeting and the date (today, tomorrow
// or any day), the Chief of Staff briefing, capacity, a timeline of fixed commitments and movable
// task time, what needs attention, deadlines, commitments and notifications, in the order the person
// chose, with the Tasks panel beside them. Plan My Day, Morning planning, the Evening review and Quick
// capture start from the header.
//
// Today owns no records. Sessions are the Daily Planner's, tasks are Tasks', events Calendar's and
// notes Knowledge's, each changed through its own API. After a change only the affected parts are
// fetched again (the plan, briefing and completed tasks), never the whole page.
import { useCallback, useEffect, useMemo, useState } from "react";
import { type CalendarDate, parseDate } from "@internationalized/date";
import { ArrowLeft, ArrowRight, Calendar, ChevronLeft, ChevronRight, Moon01, Settings01, Stars02, Sunrise } from "@untitledui/icons";
import { DatePicker } from "@/components/application/date-picker/date-picker";
import { ButtonGroup, ButtonGroupItem } from "@/components/base/button-group/button-group";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { calendarApi } from "@/portal/calendar/api";
import { PlanningSettings } from "@/portal/calendar/pages/calendar-planner-page";
import { plannerApi } from "@/portal/calendar/planner-api";
import { BlockPanel, type PlannerState, ScheduleDialog, TasksPanel, usePlanner } from "@/portal/calendar/planner-ui";
import { Card } from "@/portal/calendar/shared";
import { TimeGrid } from "@/portal/calendar/views";
import { PageHeader } from "@/portal/components/page-header";
import { useToast } from "@/portal/components/toast";
import { ApiError, errorMessage } from "@/portal/lib/api";
import type { PageData } from "@/portal/lib/page-types";
import { usePortal } from "@/portal/portal-context";
import { tasksApi } from "@/portal/tasks/api";
import { TASK_CREATED_EVENT } from "@/portal/tasks/quick-add-events";
import { AssetsTodaySection } from "@/portal/today/assets-section";
import { CentreTodaySection } from "@/portal/today/centre-section";
import { addDays, dayLabel, longDateLabel, zoneAbbreviation } from "@/shared/calendar/time";
import type { PlannerTask } from "@/shared/planner/types";
import type { TodayDashboard, TodaySection } from "@/shared/today/types";
import { cx } from "@/utils/cx";
import { PlanMyDayDialog } from "../plan-my-day";
import { QuickCaptureMenu } from "../quick-capture";
import { EveningReview, MorningPlanning } from "../routines";
import {
    AttentionSection,
    BriefingSection,
    CapacitySection,
    CommitmentsSection,
    DeadlinesSection,
    NotificationsSection,
    STATUS,
    TimelineList,
} from "../sections";
import { TodaySettingsDialog } from "../settings-dialog";
import { type TodayPart, todayApi } from "../today-api";

const AFTER_CHANGE: TodayPart[] = ["plan", "briefing", "completed"];

/** Any other day: Untitled UI's date picker, applied with its own Apply button. */
const GoToDate = ({ date, onGo }: { date: string; onGo: (date: string) => void }) => {
    const [draft, setDraft] = useState<CalendarDate | null>(parseDate(date));
    return (
        <DatePicker
            aria-label="Go to a date"
            value={draft}
            onChange={(next) => setDraft(next as CalendarDate | null)}
            onApply={() => draft && draft.toString() !== date && onGo(draft.toString())}
            onCancel={() => setDraft(parseDate(date))}
        />
    );
};

export const TodayPage = ({ data: page }: { data: PageData<"today"> }) => {
    const toast = useToast();
    const { user } = usePortal();
    const [data, setData] = useState<TodayDashboard>(page.dashboard);
    const [planning, setPlanning] = useState(page.plannerPreferences);
    const [dialog, setDialog] = useState<"plan" | "morning" | "evening" | "settings" | "planning" | null>(null);
    const [timelineView, setTimelineView] = useState(data.preferences.timelineView);
    const [panelOpen, setPanelOpen] = useState(true);
    const { date, today } = data;

    const refresh = useCallback(
        async (parts: TodayPart[] = AFTER_CHANGE) => {
            const { today: next } = await todayApi.get(date, parts);
            setData((d) => ({ ...d, ...next }));
            return next;
        },
        [date],
    );
    const load = useCallback(async (): Promise<PlannerState> => {
        const next = await refresh();
        return { lists: next.lists!, blocks: next.blocks!, conflicts: next.conflicts! };
    }, [refresh]);
    const planner = usePlanner({ lists: data.lists, blocks: data.blocks, conflicts: data.conflicts }, load);

    // A task added with Quick capture (Tasks' Quick Add) shows up without a reload.
    useEffect(() => {
        const onCreated = () => void planner.refresh();
        window.addEventListener(TASK_CREATED_EVENT, onCreated);
        return () => window.removeEventListener(TASK_CREATED_EVENT, onCreated);
    }, [planner.refresh]);
    // Links from the briefing and MCP open a session (?block=); "Morning planning" can be where the day starts.
    useEffect(() => {
        if (page.openBlock) {
            const known = data.blocks.find((b) => b.id === page.openBlock);
            if (known) planner.setOpenBlock(known);
            else
                plannerApi
                    .get(page.openBlock)
                    .then((r) => planner.setOpenBlock(r.block))
                    .catch(() => undefined);
        } else if (data.preferences.startView === "morning" && date === today && !data.reviews.morning && data.greeting === "Good morning")
            setDialog("morning");
        // Only on first render.
    }, []);

    const byId = useMemo(() => new Map(planner.state.lists.tasks.map((t) => [t.id, t])), [planner.state.lists.tasks]);
    const pick = (ids: string[]) => ids.map((id) => byId.get(id)).filter((t): t is PlannerTask => !!t);
    const unscheduled = pick(planner.state.lists.buckets.unscheduled);
    const conflicted = useMemo(() => new Set(planner.state.conflicts.map((c) => c.blockId).filter((id): id is string => !!id)), [planner.state.conflicts]);
    const hrefFor = (d: string) => (d === today ? "/portal/today" : `/portal/today?date=${d}`);
    const go = (d: string) => (window.location.href = hrefFor(d));
    const firstName = (user.name ?? user.email.split("@")[0]).split(/\s+/)[0];
    const schedule = (task: PlannerTask, time: string | null = null) => planner.setTarget({ kind: "task", task, date: date < today ? today : date, time });

    const complete = async (task: PlannerTask) => {
        try {
            // Tasks' own API, rules and history.
            const result = await tasksApi.complete(task.id, task.dueDate, false);
            toast.show({
                title: result.nextDate ? `Done. Next: ${dayLabel(result.nextDate)}` : "Task completed",
                description: task.title,
                color: "success",
                action: { label: "Undo", run: () => void tasksApi.reopen(task.id).then(() => planner.refresh()) },
            });
            await planner.refresh();
        } catch (error) {
            toast.error(
                error instanceof ApiError && error.code === "open_subtasks" ? "It has open subtasks: complete it in Tasks" : "Couldn't complete the task",
                errorMessage(error),
            );
        }
    };

    const sections: Record<TodaySection, () => React.ReactNode> = {
        briefing: () => <BriefingSection briefing={data.briefing} preferences={data.preferences.briefing} canUseIntelligence={data.canUseIntelligence} />,
        capacity: () => <CapacitySection capacity={data.capacity} />,
        timeline: () => (
            <div id="timeline" className="scroll-mt-4">
                <Card
                    title="Timeline"
                    description="Fixed commitments, movable task time, breaks and free time. Events from subscribed calendars are never changed here."
                    actions={
                        <ButtonGroup
                            size="sm"
                            selectedKeys={[timelineView]}
                            onSelectionChange={(keys) => {
                                const [k] = [...keys];
                                if (k === "list" || k === "grid") setTimelineView(k);
                            }}
                            aria-label="Timeline view"
                            className="max-md:hidden"
                        >
                            <ButtonGroupItem id="list">List</ButtonGroupItem>
                            <ButtonGroupItem id="grid">Grid</ButtonGroupItem>
                        </ButtonGroup>
                    }
                >
                    {timelineView === "grid" && (
                        <div className="max-md:hidden">
                            <TimeGrid
                                from={date}
                                to={date}
                                today={today}
                                timeZone={data.timeZone}
                                occurrences={page.occurrences}
                                overlays={page.overlays}
                                onOpen={(o) => (window.location.href = `/portal/calendar?view=day&date=${o.startDate}&event=${o.eventId}`)}
                                onCreate={() => undefined}
                                blocks={planner.state.blocks}
                                conflicted={conflicted}
                                onOpenBlock={planner.setOpenBlock}
                                onDropPlan={(payload, d, time) => void planner.drop(payload, d, time)}
                                startHour={Number(page.workingHoursStart.slice(0, 2))}
                            />
                        </div>
                    )}
                    <div className={cx(timelineView === "grid" && "md:hidden")}>
                        <TimelineList
                            timeline={data.timeline}
                            blocks={planner.state.blocks}
                            unscheduled={unscheduled}
                            onOpenBlock={planner.setOpenBlock}
                            onPlanAt={(task, time) => schedule(task, time)}
                        />
                    </div>
                </Card>
            </div>
        ),
        attention: () => (
            <AttentionSection
                today={today}
                onSchedule={(t) => schedule(t)}
                onComplete={(t) => void complete(t)}
                groups={[
                    {
                        key: "today",
                        title: "Due today",
                        empty: "Nothing due today.",
                        tasks: pick(planner.state.lists.buckets.today).filter((t) => t.dueDate === today || t.deadline === today),
                    },
                    { key: "overdue", title: "Overdue", empty: "Nothing overdue.", tasks: pick(planner.state.lists.buckets.overdue) },
                    {
                        key: "priority",
                        title: "High priority, unscheduled",
                        empty: "Every P1 and P2 task has time planned.",
                        tasks: pick(planner.state.lists.buckets.priority).filter((t) => t.scheduledMinutes === 0),
                    },
                ]}
                completed={data.preferences.showCompleted ? data.completed : []}
            />
        ),
        deadlines: () => <DeadlinesSection deadlines={data.deadlines} today={today} />,
        commitments: () => <CommitmentsSection commitments={data.commitments} date={date} lookahead={data.preferences.briefing.lookaheadDays} />,
        notifications: () => (
            <NotificationsSection
                notifications={data.notifications}
                onDismiss={(n) =>
                    void calendarApi
                        .dismiss(n.id)
                        .then(() => refresh(["notifications"]))
                        .catch((error: unknown) => toast.error("Couldn't dismiss it", errorMessage(error)))
                }
            />
        ),
    };
    const order =
        data.preferences.startView === "timeline"
            ? ["timeline" as const, ...data.preferences.sections.filter((s) => s !== "timeline")]
            : data.preferences.sections;
    const status = STATUS[data.capacity.status];

    return (
        <>
            <PageHeader
                title={`${data.greeting}, ${firstName}`}
                description={
                    <>
                        {longDateLabel(date)}
                        {date !== today && ` · Today is ${dayLabel(today)}`} · {data.timeZone.replace(/_/g, " ")} ({zoneAbbreviation(data.timeZone)})
                    </>
                }
                breadcrumbs={[{ label: "Today" }]}
                actions={
                    <>
                        <QuickCaptureMenu data={data} spaces={page.spaces} onChanged={() => window.location.reload()} />
                        <Button size="md" color="secondary" iconLeading={Stars02} onClick={() => setDialog("plan")} isDisabled={date < today}>
                            Plan my day
                        </Button>
                        <ButtonUtility size="sm" color="secondary" icon={Settings01} tooltip="Customise Today" onClick={() => setDialog("settings")} />
                    </>
                }
            />

            <div className="flex flex-col gap-3 rounded-xl bg-primary p-3 shadow-xs ring-1 ring-secondary ring-inset md:flex-row md:items-center md:justify-between">
                <div className="flex flex-wrap items-center gap-2">
                    {/* Plain links: moving between days loads that day's page. */}
                    <nav aria-label="Choose a day" className="flex flex-wrap items-center gap-1">
                        <ButtonUtility size="sm" color="secondary" icon={ArrowLeft} tooltip="Previous day" href={hrefFor(addDays(date, -1))} />
                        <Button
                            size="sm"
                            color={date === today ? "primary" : "secondary"}
                            href={hrefFor(today)}
                            aria-current={date === today ? "date" : undefined}
                        >
                            Today
                        </Button>
                        <Button
                            size="sm"
                            color={date === addDays(today, 1) ? "primary" : "secondary"}
                            href={hrefFor(addDays(today, 1))}
                            aria-current={date === addDays(today, 1) ? "date" : undefined}
                        >
                            Tomorrow
                        </Button>
                        <ButtonUtility size="sm" color="secondary" icon={ArrowRight} tooltip="Next day" href={hrefFor(addDays(date, 1))} />
                    </nav>
                    <GoToDate date={date} onGo={go} />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm text-tertiary">
                        <span className="font-medium text-secondary">{status.label}</span>
                        {data.capacity.availableMinutes > 0 && ` · ${Math.round(data.capacity.freeMinutes / 6) / 10} h free`}
                    </span>
                    {date === today && (
                        <>
                            <Button size="sm" color="secondary" iconLeading={Sunrise} onClick={() => setDialog("morning")}>
                                {data.reviews.morning ? "Morning planning ✓" : "Morning planning"}
                            </Button>
                            <Button size="sm" color="secondary" iconLeading={Moon01} onClick={() => setDialog("evening")}>
                                {data.reviews.evening ? "Evening review ✓" : "Evening review"}
                            </Button>
                        </>
                    )}
                    <Button size="sm" color="tertiary" iconLeading={Calendar} href={`/portal/calendar?view=${data.preferences.calendarView}&date=${date}`}>
                        Open in Calendar
                    </Button>
                </div>
            </div>

            {page.centre && <CentreTodaySection centre={page.centre} />}
            {page.assets && <AssetsTodaySection assets={page.assets} />}

            <div className={cx("grid grid-cols-1 gap-6", panelOpen ? "xl:grid-cols-[minmax(0,1fr)_22rem]" : "xl:grid-cols-[minmax(0,1fr)_auto]")}>
                <div className="flex min-w-0 flex-col gap-6">
                    {order.map((s) => (
                        <div key={s} data-section={s}>
                            {sections[s]()}
                        </div>
                    ))}
                    {!order.length && <p className="text-sm text-tertiary">Every section is hidden. Choose some with Customise Today.</p>}
                </div>
                <aside aria-label="Tasks" className="flex min-w-0 flex-col gap-2 xl:sticky xl:top-4 xl:self-start">
                    <Button
                        size="sm"
                        color="tertiary"
                        iconLeading={panelOpen ? ChevronRight : ChevronLeft}
                        aria-expanded={panelOpen}
                        aria-controls="today-tasks"
                        onClick={() => setPanelOpen(!panelOpen)}
                        className="self-end"
                        aria-label={panelOpen ? "Hide the Tasks panel" : "Show the Tasks panel"}
                    >
                        {panelOpen ? "Hide tasks" : "Tasks"}
                    </Button>
                    <div id="today-tasks" className={cx(!panelOpen && "hidden")}>
                        <TasksPanel planner={planner} today={today} defaultDate={date < today ? today : date} extended collapsible={false} title="Tasks" />
                    </div>
                </aside>
            </div>

            <ScheduleDialog planner={planner} today={today} />
            <BlockPanel planner={planner} />
            <PlanMyDayDialog
                date={date}
                isOpen={dialog === "plan"}
                onOpenChange={(o) => setDialog(o ? "plan" : null)}
                onApplied={() => void planner.refresh()}
            />
            {date === today && (
                <>
                    <MorningPlanning
                        data={data}
                        isOpen={dialog === "morning"}
                        onOpenChange={(o) => setDialog(o ? "morning" : null)}
                        onDone={() => void planner.refresh().then(() => refresh(["reviews", "briefing"]))}
                    />
                    <EveningReview
                        data={data}
                        isOpen={dialog === "evening"}
                        onOpenChange={(o) => setDialog(o ? "evening" : null)}
                        onDone={() => void planner.refresh().then(() => refresh(["reviews", "briefing"]))}
                    />
                </>
            )}
            {dialog === "settings" && (
                <TodaySettingsDialog
                    isOpen
                    onOpenChange={(o) => setDialog(o ? "settings" : null)}
                    data={data}
                    onOpenPlanning={() => setDialog("planning")}
                    onSaved={(preferences, version) => {
                        setData((d) => ({ ...d, preferences, preferencesVersion: version }));
                        setTimelineView(preferences.timelineView);
                        void planner.refresh();
                    }}
                />
            )}
            <PlanningSettings
                isOpen={dialog === "planning"}
                onOpenChange={(o) => setDialog(o ? "planning" : null)}
                initial={planning.preferences}
                version={planning.version}
                onSaved={(preferences, version) => {
                    setPlanning({ preferences, version });
                    void planner.refresh();
                }}
            />
        </>
    );
};
