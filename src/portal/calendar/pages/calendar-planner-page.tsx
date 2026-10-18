// The Daily Planner (/portal/calendar/planner): one day's commitments (your events, shared and
// subscribed calendars, leave) and the time you've set aside for tasks, in one timeline, with the
// tasks still to plan beside it, free time, conflicts and a capacity summary. "Suggest a plan" asks
// the deterministic planner for sessions; each one is created only when it's accepted (as it is, or
// adjusted first), and nothing already in the calendar is ever moved.
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowLeft, ArrowRight, Calendar, CalendarCheck01, Clock, Settings01, Stars02 } from "@untitledui/icons";
import { BadgeWithDot } from "@/components/base/badges/badges";
import { ButtonGroup, ButtonGroupItem } from "@/components/base/button-group/button-group";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { Select } from "@/components/base/select/select";
import { Toggle } from "@/components/base/toggle/toggle";
import { PortalDialog } from "@/portal/components/dialog";
import { MetricCard } from "@/portal/components/metric-card";
import { Notice } from "@/portal/components/notice";
import { useToast } from "@/portal/components/toast";
import { errorMessage } from "@/portal/lib/api";
import type { PageData } from "@/portal/lib/page-types";
import { addDays, dayLabel, longDateLabel, timeLabel, zoneAbbreviation } from "@/shared/calendar/time";
import type { DayCapacity, DayPlan, PlanResult, PlannerPreferences } from "@/shared/planner/types";
import { clientId } from "../api";
import { durationLabel, plannerApi } from "../planner-api";
import { BlockPanel, ConflictList, type PlannerState, ScheduleDialog, TasksPanel, usePlanner } from "../planner-ui";
import { CalendarHeader, Card } from "../shared";
import { AgendaDay, TimeGrid } from "../views";

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

const STATUS: Record<DayCapacity["status"], { label: string; color: "gray" | "success" | "brand" | "warning" | "error" }> = {
    off: { label: "Day off", color: "gray" },
    light: { label: "Light day", color: "success" },
    balanced: { label: "Balanced", color: "brand" },
    full: { label: "Full", color: "warning" },
    over: { label: "Over-committed", color: "error" },
};

const PlanningSettings = ({
    isOpen,
    onOpenChange,
    initial,
    version,
    onSaved,
}: {
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
    initial: PlannerPreferences;
    version: number;
    onSaved: (prefs: PlannerPreferences, version: number) => void;
}) => {
    const toast = useToast();
    const [draft, setDraft] = useState(initial);
    const [busy, setBusy] = useState(false);
    const minuteItems = (values: number[]) => values.map((m) => ({ id: String(m), label: m ? durationLabel(m) : "None" }));
    const save = async () => {
        setBusy(true);
        try {
            const result = await plannerApi.savePreferences(draft, version);
            onSaved(result.preferences, result.version);
            toast.success("Planning settings saved");
            onOpenChange(false);
        } catch (error) {
            toast.error("Couldn't save the settings", errorMessage(error));
        } finally {
            setBusy(false);
        }
    };
    return (
        <PortalDialog
            isOpen={isOpen}
            onOpenChange={onOpenChange}
            title="Planning settings"
            description="When the planner can suggest task time, and how much. Events, leave, public holidays and non-working days are always taken out."
            icon={Settings01}
            size="lg"
            onSubmit={(e) => {
                e.preventDefault();
                void save();
            }}
            footer={
                <>
                    <Button color="secondary" size="lg" onClick={() => onOpenChange(false)} isDisabled={busy}>
                        Cancel
                    </Button>
                    <Button type="submit" size="lg" isLoading={busy} showTextWhileLoading>
                        Save
                    </Button>
                </>
            }
        >
            <fieldset className="flex flex-col gap-3">
                <legend className="mb-2 text-sm font-medium text-secondary">Planning hours</legend>
                {WEEKDAYS.map((day, i) => {
                    const hours = draft.workingHours[i];
                    const set = (value: PlannerPreferences["workingHours"][number]) =>
                        setDraft({ ...draft, workingHours: draft.workingHours.map((h, j) => (j === i ? value : h)) });
                    return (
                        <div key={day} className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[8rem_1fr_1fr]">
                            <Toggle size="sm" label={day} isSelected={!!hours} onChange={(on) => set(on ? { start: "09:00", end: "17:00" } : null)} />
                            {hours && (
                                <>
                                    <Input
                                        size="sm"
                                        type="time"
                                        aria-label={`${day} from`}
                                        value={hours.start}
                                        onChange={(v) => v && set({ ...hours, start: v })}
                                    />
                                    <Input
                                        size="sm"
                                        type="time"
                                        aria-label={`${day} until`}
                                        value={hours.end}
                                        onChange={(v) => v && set({ ...hours, end: v })}
                                    />
                                </>
                            )}
                        </div>
                    );
                })}
            </fieldset>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Select
                    label="Buffer after events and sessions"
                    value={String(draft.bufferMinutes)}
                    onChange={(k) => k && setDraft({ ...draft, bufferMinutes: Number(k) })}
                    items={minuteItems([0, 5, 10, 15, 30])}
                >
                    {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                </Select>
                <Select
                    label="Most task time a day"
                    value={String(draft.dailyFocusMinutes)}
                    onChange={(k) => k && setDraft({ ...draft, dailyFocusMinutes: Number(k) })}
                    items={minuteItems([60, 120, 180, 240, 300, 360, 480])}
                >
                    {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                </Select>
                <Select
                    label="Shortest session"
                    value={String(draft.minBlockMinutes)}
                    onChange={(k) => k && setDraft({ ...draft, minBlockMinutes: Number(k) })}
                    items={minuteItems([15, 30, 45, 60])}
                >
                    {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                </Select>
                <Select
                    label="Longest session"
                    value={String(draft.maxBlockMinutes)}
                    onChange={(k) => k && setDraft({ ...draft, maxBlockMinutes: Number(k) })}
                    items={minuteItems([60, 90, 120, 180, 240])}
                >
                    {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                </Select>
                <Select
                    label="Assume tasks without an estimate take"
                    value={String(draft.defaultEstimateMinutes)}
                    onChange={(k) => k && setDraft({ ...draft, defaultEstimateMinutes: Number(k) })}
                    items={minuteItems([15, 30, 45, 60, 90, 120])}
                >
                    {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                </Select>
            </div>
            <Toggle
                label="Plan on days off too"
                hint="Weekends, public holidays, non-working days and leave. Days without hours of their own use 9 to 5."
                isSelected={draft.planOnDaysOff}
                onChange={(v) => setDraft({ ...draft, planOnDaysOff: v })}
            />
        </PortalDialog>
    );
};

export const CalendarPlannerPage = ({ data }: { data: PageData<"calendar-planner"> }) => {
    const toast = useToast();
    const tz = data.preferences.timeZone;
    const [plan, setPlan] = useState<DayPlan>(data.plan);
    const [prefs, setPrefs] = useState(data.plannerPreferences);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [suggestions, setSuggestions] = useState<PlanResult | null>(null);
    const [suggestDays, setSuggestDays] = useState(1);
    const [busy, setBusy] = useState<string | null>(null);

    const load = useCallback(async (): Promise<PlannerState> => {
        const { plan: next } = await plannerApi.day(data.date);
        setPlan(next);
        return { lists: next.lists, blocks: next.blocks, conflicts: next.conflicts };
    }, [data.date]);
    const planner = usePlanner({ lists: data.plan.lists, blocks: data.plan.blocks, conflicts: data.plan.conflicts }, load);
    const conflicted = useMemo(() => new Set(planner.state.conflicts.map((c) => c.blockId).filter((id): id is string => !!id)), [planner.state.conflicts]);
    // Links from briefings and Chief of Staff open a block (?block=).
    useEffect(() => {
        if (!data.openBlock) return;
        const known = data.plan.blocks.find((b) => b.id === data.openBlock);
        if (known) planner.setOpenBlock(known);
        else
            plannerApi
                .get(data.openBlock)
                .then((r) => planner.setOpenBlock(r.block))
                .catch(() => undefined);
        // Only on first render.
    }, []);
    const byId = useMemo(() => new Map(planner.state.lists.tasks.map((t) => [t.id, t])), [planner.state.lists.tasks]);
    const status = STATUS[plan.capacity.status];
    const go = (date: string) => (window.location.href = `/portal/calendar/planner?date=${date}`);

    const suggest = async () => {
        setBusy("suggest");
        try {
            setSuggestions((await plannerApi.suggest({ from: data.date, days: suggestDays })).plan);
        } catch (error) {
            toast.error("Couldn't suggest a plan", errorMessage(error));
        } finally {
            setBusy(null);
        }
    };
    const accept = async (id: string) => {
        const s = suggestions?.suggestions.find((x) => x.id === id);
        if (!s) return;
        setBusy(id);
        try {
            const result = await plannerApi.create({
                taskId: s.taskId,
                startDate: s.startDate,
                startTime: s.startTime,
                durationMinutes: s.durationMinutes,
                occurrenceDate: s.occurrenceDate,
                source: "suggestion",
                clientId: clientId(),
            });
            planner.announce(result, "Accepted", () => plannerApi.update(result.block.id, { version: result.block.version, status: "cancelled" }));
            setSuggestions((r) => (r ? { ...r, suggestions: r.suggestions.filter((x) => x.id !== id) } : r));
            await planner.refresh();
        } catch (error) {
            toast.error("Couldn't accept that suggestion", errorMessage(error));
        } finally {
            setBusy(null);
        }
    };
    const dismiss = (id: string) => setSuggestions((r) => (r ? { ...r, suggestions: r.suggestions.filter((x) => x.id !== id) } : r));

    const blocksToday = planner.state.blocks.filter((b) => b.startDate === data.date);
    const grid = {
        from: data.date,
        to: data.date,
        today: data.today,
        timeZone: tz,
        occurrences: data.occurrences,
        overlays: data.overlays,
        onOpen: (o: { eventId: string; startDate: string }) => (window.location.href = `/portal/calendar?view=day&date=${o.startDate}&event=${o.eventId}`),
        onCreate: () => undefined,
        blocks: planner.state.blocks,
        conflicted,
        onOpenBlock: planner.setOpenBlock,
        onDropPlan: (payload: Parameters<typeof planner.drop>[0], date: string, time: string) => void planner.drop(payload, date, time),
    };

    return (
        <>
            <CalendarHeader
                shell={data}
                title="Daily planner"
                description={`Plan time for your tasks around what's already on. Times in ${tz.replace(/_/g, " ")} (${zoneAbbreviation(tz)}).`}
                crumb={{ label: "Daily planner" }}
                actions={
                    <>
                        <Button size="md" color="secondary" iconLeading={Settings01} onClick={() => setSettingsOpen(true)}>
                            Planning settings
                        </Button>
                        <Button size="md" color="secondary" iconLeading={Calendar} href={`/portal/calendar?view=week&date=${data.date}`}>
                            Week view
                        </Button>
                    </>
                }
            />

            <div className="flex flex-col gap-4 rounded-xl bg-primary p-4 shadow-xs ring-1 ring-secondary ring-inset md:flex-row md:items-center md:justify-between">
                <div className="flex min-w-0 flex-col">
                    <h2 className="flex flex-wrap items-center gap-2 text-lg font-semibold text-primary">
                        {longDateLabel(data.date)}
                        <BadgeWithDot size="sm" type="modern" color={status.color}>
                            {status.label}
                        </BadgeWithDot>
                    </h2>
                    <span className="text-sm text-tertiary">
                        {plan.capacity.offReason ?? (data.date === data.today ? "Today" : `Today is ${dayLabel(data.today)}`)}
                    </span>
                </div>
                <ButtonGroup size="sm" selectedKeys={[]} aria-label="Move between days" className="max-sm:w-full">
                    <ButtonGroupItem id="prev" iconLeading={ArrowLeft} aria-label="Previous day" onClick={() => go(addDays(data.date, -1))} />
                    <ButtonGroupItem id="today" className="flex-1 justify-center" onClick={() => go(data.today)}>
                        Today
                    </ButtonGroupItem>
                    <ButtonGroupItem id="next" iconLeading={ArrowRight} aria-label="Next day" onClick={() => go(addDays(data.date, 1))} />
                </ButtonGroup>
            </div>

            <section aria-label="Capacity" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <MetricCard
                    label="Planning hours"
                    icon={Clock}
                    value={durationLabel(plan.capacity.workingMinutes)}
                    detail={plan.capacity.offReason ?? "After leave and holidays"}
                />
                <MetricCard label="Commitments" icon={Calendar} value={durationLabel(plan.capacity.eventMinutes)} detail="Busy events in those hours" />
                <MetricCard
                    label="Planned for tasks"
                    icon={CalendarCheck01}
                    value={durationLabel(plan.capacity.blockMinutes)}
                    detail={`Limit ${durationLabel(plan.capacity.focusLimitMinutes)} a day`}
                />
                <MetricCard
                    label="Free"
                    icon={Stars02}
                    value={durationLabel(plan.capacity.freeMinutes)}
                    detail={
                        plan.capacity.unscheduledMinutes
                            ? `${durationLabel(plan.capacity.unscheduledMinutes)} of due work not planned`
                            : "Nothing due left to plan"
                    }
                />
            </section>

            {plan.capacity.status === "over" && (
                <Notice color="warning" title="More to do than there's time for">
                    The tasks due {data.date === data.today ? "today and overdue" : "this day"} need more time than is free. Move some to another day in Tasks,
                    or plan them on a different day.
                </Notice>
            )}

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-[22rem_minmax(0,1fr)]">
                <TasksPanel planner={planner} today={data.today} defaultDate={data.date} className="lg:sticky lg:top-4 lg:self-start" />
                <div className="flex min-w-0 flex-col gap-4">
                    <div className="max-md:hidden">
                        <TimeGrid {...grid} startHour={Number(data.preferences.workingHours.start.slice(0, 2))} />
                    </div>
                    <div className="md:hidden">
                        <AgendaDay
                            date={data.date}
                            today={data.today}
                            occurrences={data.occurrences}
                            overlays={data.overlays}
                            onOpen={grid.onOpen}
                            onCreate={grid.onCreate}
                            blocks={blocksToday}
                            conflicted={conflicted}
                            onOpenBlock={planner.setOpenBlock}
                        />
                    </div>

                    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                        <Card title="Free time" description="In your planning hours, after commitments and a buffer.">
                            {plan.free.length ? (
                                <ul className="flex flex-col divide-y divide-secondary">
                                    {plan.free.map((f) => (
                                        <li key={f.start} className="flex items-center justify-between gap-3 py-2 text-sm first:pt-0 last:pb-0">
                                            <span className="text-primary">
                                                {timeLabel(f.startTime)} – {timeLabel(f.endTime)}
                                            </span>
                                            <span className="text-tertiary">{durationLabel(f.minutes)}</span>
                                        </li>
                                    ))}
                                </ul>
                            ) : (
                                <p className="text-sm text-tertiary">
                                    {plan.capacity.offReason ? `No planning hours: ${plan.capacity.offReason}.` : "No free time left this day."}
                                </p>
                            )}
                        </Card>
                        <Card title="Conflicts" description="Planned time that overlaps events, leave or other plans, or runs past a task's due time.">
                            {planner.state.conflicts.length ? (
                                <ConflictList conflicts={planner.state.conflicts} title={`${planner.state.conflicts.length} to look at`} />
                            ) : (
                                <p className="text-sm text-tertiary">No conflicts.</p>
                            )}
                        </Card>
                    </div>

                    <Card
                        title="Suggested plan"
                        description="Sessions in your free time, worked out from due dates, priorities and estimates. Nothing is added until you accept it."
                        actions={
                            <div className="flex items-end gap-2">
                                <Select
                                    size="sm"
                                    aria-label="How many days"
                                    value={String(suggestDays)}
                                    onChange={(k) => k && setSuggestDays(Number(k))}
                                    items={[1, 3, 5, 7].map((n) => ({ id: String(n), label: n === 1 ? "This day" : `${n} days` }))}
                                    className="w-32"
                                >
                                    {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                                </Select>
                                <Button size="sm" iconLeading={Stars02} onClick={() => void suggest()} isLoading={busy === "suggest"} showTextWhileLoading>
                                    Suggest a plan
                                </Button>
                            </div>
                        }
                    >
                        {suggestions ? (
                            <div className="flex flex-col gap-3">
                                {suggestions.suggestions.length ? (
                                    <ul aria-label="Suggested sessions" className="flex flex-col divide-y divide-secondary">
                                        {suggestions.suggestions.map((s) => (
                                            <li
                                                key={s.id}
                                                data-suggestion={s.taskId}
                                                className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between"
                                            >
                                                <div className="min-w-0">
                                                    <p className="text-sm font-medium text-primary">
                                                        {s.title}
                                                        {s.sessions > 1 && (
                                                            <span className="font-normal text-tertiary">
                                                                {" "}
                                                                · session {s.session} of {s.sessions}
                                                            </span>
                                                        )}
                                                    </p>
                                                    <p className="text-sm text-tertiary">
                                                        {s.startDate !== data.date && `${dayLabel(s.startDate)}, `}
                                                        {timeLabel(s.startTime)} – {timeLabel(s.endTime)} ({durationLabel(s.durationMinutes)}) · {s.reason}
                                                    </p>
                                                    {s.late && (
                                                        <p className="flex items-center gap-1 text-xs text-warning-primary">
                                                            <AlertTriangle aria-hidden="true" className="size-3" /> After it's due
                                                        </p>
                                                    )}
                                                </div>
                                                <div className="flex shrink-0 gap-2">
                                                    <Button
                                                        size="sm"
                                                        onClick={() => void accept(s.id)}
                                                        isLoading={busy === s.id}
                                                        aria-label={`Accept ${s.title} at ${timeLabel(s.startTime)}`}
                                                    >
                                                        Accept
                                                    </Button>
                                                    <Button
                                                        size="sm"
                                                        color="secondary"
                                                        onClick={() =>
                                                            planner.setTarget({ kind: "suggestion", suggestion: s, task: byId.get(s.taskId) ?? null })
                                                        }
                                                    >
                                                        Adjust
                                                    </Button>
                                                    <Button size="sm" color="tertiary" onClick={() => dismiss(s.id)} aria-label={`Skip ${s.title}`}>
                                                        Skip
                                                    </Button>
                                                </div>
                                            </li>
                                        ))}
                                    </ul>
                                ) : (
                                    <p className="text-sm text-tertiary">Nothing left to suggest: everything due is planned, or there's no free time.</p>
                                )}
                                {suggestions.unplaced.length > 0 && (
                                    <Notice title="Didn't fit">
                                        {suggestions.unplaced.map((u) => `${u.title} (${durationLabel(u.remainingMinutes)} more)`).join(", ")}. Try more days,
                                        longer planning hours or a later due date.
                                    </Notice>
                                )}
                            </div>
                        ) : (
                            <p className="text-sm text-tertiary">Ask for a suggested plan to see sessions you can accept, adjust or skip.</p>
                        )}
                    </Card>
                </div>
            </div>

            <ScheduleDialog planner={planner} today={data.today} />
            <BlockPanel planner={planner} />
            <PlanningSettings
                isOpen={settingsOpen}
                onOpenChange={setSettingsOpen}
                initial={prefs.preferences}
                version={prefs.version}
                onSaved={(preferences, version) => {
                    setPrefs({ preferences, version });
                    void planner.refresh();
                }}
            />
        </>
    );
};
