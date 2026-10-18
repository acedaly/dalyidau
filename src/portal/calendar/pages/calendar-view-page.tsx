// Daly Calendar's main page: day, week, month and agenda views. Moving between dates and views is
// a plain link (the portal has no client router), so every view is a fresh, shareable URL.
// Changes made here (new events, edits, show/hide) are applied in place without reloading. The day
// and week views also carry the Daily Planner's Tasks panel and time blocks (planner-ui.tsx).
import { useCallback, useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, CalendarCheck01, Plus, SearchLg } from "@untitledui/icons";
import { CalendarDateIcon } from "@/components/application/calendar/base-components/calendar-date-icon";
import { CalendarViewDropdown } from "@/components/application/calendar/base-components/calendar-view-dropdown";
import { Badge } from "@/components/base/badges/badges";
import { ButtonGroup, ButtonGroupItem } from "@/components/base/button-group/button-group";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { Notice } from "@/portal/components/notice";
import { useToast } from "@/portal/components/toast";
import { errorMessage } from "@/portal/lib/api";
import type { PageData } from "@/portal/lib/page-types";
import { dayLabel, longDateLabel, monthLabel, rangeLabel, zoneAbbreviation } from "@/shared/calendar/time";
import type { CalendarInfo, EventOccurrence, Overlays } from "@/shared/calendar/types";
import { stepAnchor } from "@/shared/calendar/views";
import { cx } from "@/utils/cx";
import { calendarApi } from "../api";
import { EventPanel, type PanelTarget } from "../event-panel";
import { plannerApi } from "../planner-api";
import { BlockPanel, type PlannerState, ScheduleDialog, TasksPanel, usePlanner } from "../planner-ui";
import { CalendarHeader, ColorDot } from "../shared";
import { AgendaList, MonthGrid, TimeGrid, WeekList } from "../views";

const VIEW_OPTIONS = [
    { value: "day", label: "Day" },
    { value: "week", label: "Week" },
    { value: "month", label: "Month" },
    { value: "agenda", label: "Agenda" },
    { value: "year", label: "Year planner" },
];

const EMPTY_PLAN: PlannerState = {
    lists: { tasks: [], buckets: { today: [], overdue: [], upcoming: [], priority: [], unscheduled: [] } },
    blocks: [],
    conflicts: [],
};

const viewHref = (view: string, date: string) =>
    view === "year" ? `/portal/calendar/year?year=${date.slice(0, 4)}` : `/portal/calendar?view=${view}&date=${date}`;

export const CalendarViewPage = ({ data }: { data: PageData<"calendar-view"> }) => {
    const toast = useToast();
    const [occurrences, setOccurrences] = useState<EventOccurrence[]>(data.occurrences);
    const [overlays, setOverlays] = useState<Overlays>(data.overlays);
    const [calendars, setCalendars] = useState<CalendarInfo[]>(data.calendars);
    const [target, setTarget] = useState<PanelTarget>(
        data.openEvent ? { kind: "open", eventId: data.openEvent, occurrence: data.occurrences.find((o) => o.eventId === data.openEvent) ?? null } : null,
    );
    const [query, setQuery] = useState("");
    const [results, setResults] = useState<EventOccurrence[] | null>(null);
    const tz = data.preferences.timeZone;
    const canAdd = calendars.some((c) => c.source === "local" && (c.role === "owner" || c.role === "editor"));

    const reload = async () => {
        try {
            const result = await calendarApi.window(data.from, data.to);
            setOccurrences(result.occurrences);
            setOverlays(result.overlays);
        } catch (error) {
            toast.error("Couldn't refresh the calendar", errorMessage(error));
        }
    };
    // The Tasks panel and time blocks (day and week views, for people who can open Tasks).
    const loadPlanner = useCallback(async (): Promise<PlannerState> => {
        const { planner: p } = await plannerApi.window(data.from, data.to);
        return { lists: p.lists, blocks: p.blocks, conflicts: p.conflicts };
    }, [data.from, data.to]);
    const planner = usePlanner(
        data.planner ? { lists: data.planner.lists, blocks: data.planner.blocks, conflicts: data.planner.conflicts } : EMPTY_PLAN,
        loadPlanner,
    );
    const conflicted = useMemo(() => new Set(planner.state.conflicts.map((c) => c.blockId).filter((id): id is string => !!id)), [planner.state.conflicts]);
    const toggle = async (c: CalendarInfo) => {
        try {
            const { calendar } = await calendarApi.personal(c.id, { hidden: !c.hidden });
            setCalendars((all) => all.map((x) => (x.id === c.id ? calendar : x)));
            await reload();
        } catch (error) {
            toast.error("Couldn't change that", errorMessage(error));
        }
    };
    const search = async () => {
        if (!query.trim()) return setResults(null);
        try {
            setResults((await calendarApi.search(query)).occurrences);
        } catch (error) {
            toast.error("Search failed", errorMessage(error));
        }
    };

    const props = {
        from: data.from,
        to: data.to,
        today: data.today,
        timeZone: tz,
        occurrences,
        overlays,
        onOpen: (o: EventOccurrence) => setTarget({ kind: "open", eventId: o.eventId, occurrence: o }),
        onCreate: (date: string, time: string | null) => canAdd && setTarget({ kind: "new", date, time }),
        ...(data.planner
            ? {
                  blocks: planner.state.blocks,
                  conflicted,
                  onOpenBlock: planner.setOpenBlock,
                  onDropPlan: (payload: Parameters<typeof planner.drop>[0], date: string, time: string) => void planner.drop(payload, date, time),
              }
            : {}),
    };
    const heading =
        data.view === "day"
            ? longDateLabel(data.anchor)
            : data.view === "month"
              ? monthLabel(data.anchor)
              : rangeLabel(data.from, data.to, data.today.slice(0, 4));

    return (
        <>
            <CalendarHeader
                shell={data}
                title="Calendar"
                description={`Times in ${tz.replace(/_/g, " ")} (${zoneAbbreviation(tz)}).`}
                crumb={{ label: VIEW_OPTIONS.find((v) => v.value === data.view)?.label ?? "Calendar" }}
                actions={
                    <>
                        {data.canUseTasks && (
                            <Button
                                size="md"
                                color="secondary"
                                iconLeading={CalendarCheck01}
                                href={`/portal/calendar/planner?date=${data.view === "day" ? data.anchor : data.today}`}
                            >
                                Daily planner
                            </Button>
                        )}
                        {canAdd && (
                            <Button
                                size="md"
                                iconLeading={Plus}
                                onClick={() => setTarget({ kind: "new", date: data.view === "day" ? data.anchor : data.today, time: null })}
                            >
                                Add event
                            </Button>
                        )}
                    </>
                }
            />

            <div className="flex flex-col gap-4 rounded-xl bg-primary p-4 shadow-xs ring-1 ring-secondary ring-inset">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                    <div className="flex items-center gap-3">
                        <CalendarDateIcon
                            day={Number(data.today.slice(8))}
                            month={dayLabel(data.today).split(" ")[2]?.toUpperCase() ?? ""}
                            className="max-md:hidden"
                        />
                        <div className="flex min-w-0 flex-col">
                            <h2 className="flex flex-wrap items-center gap-2 text-lg font-semibold text-primary">
                                {heading}
                                {data.truncated && (
                                    <Badge size="sm" color="warning">
                                        Some events not shown
                                    </Badge>
                                )}
                            </h2>
                            <span className="text-sm text-tertiary">Today is {longDateLabel(data.today)}</span>
                        </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                        <ButtonGroup size="sm" selectedKeys={[]} aria-label="Move through the calendar" className="max-sm:w-full">
                            <ButtonGroupItem
                                id="prev"
                                iconLeading={ArrowLeft}
                                aria-label="Previous"
                                onClick={() => (window.location.href = viewHref(data.view, stepAnchor(data.view, data.anchor, -1)))}
                            />
                            <ButtonGroupItem
                                id="today"
                                className="flex-1 justify-center"
                                onClick={() => (window.location.href = viewHref(data.view, data.today))}
                            >
                                Today
                            </ButtonGroupItem>
                            <ButtonGroupItem
                                id="next"
                                iconLeading={ArrowRight}
                                aria-label="Next"
                                onClick={() => (window.location.href = viewHref(data.view, stepAnchor(data.view, data.anchor, 1)))}
                            />
                        </ButtonGroup>
                        <CalendarViewDropdown
                            value={data.view}
                            options={VIEW_OPTIONS}
                            onSelectionChange={(view) => (window.location.href = viewHref(view, data.anchor))}
                        />
                    </div>
                </div>
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                    <ul aria-label="Calendars shown" className="flex flex-wrap gap-2">
                        {calendars.map((c) => (
                            <li key={c.id}>
                                <button
                                    type="button"
                                    aria-pressed={!c.hidden}
                                    onClick={() => void toggle(c)}
                                    className={cx(
                                        "flex min-h-9 cursor-pointer items-center gap-2 rounded-full px-3 py-1.5 text-sm font-medium ring-1 outline-focus-ring transition duration-100 ease-linear ring-inset focus-visible:outline-2",
                                        c.hidden ? "text-quaternary ring-secondary hover:bg-primary_hover" : "bg-secondary text-secondary ring-primary",
                                    )}
                                >
                                    <ColorDot color={c.color} className={cx(c.hidden && "opacity-40")} />
                                    {c.name}
                                    <span className="sr-only">{c.hidden ? " (hidden)" : " (shown)"}</span>
                                </button>
                            </li>
                        ))}
                    </ul>
                    <form
                        role="search"
                        className="flex items-center gap-2 md:w-80"
                        onSubmit={(e) => {
                            e.preventDefault();
                            void search();
                        }}
                    >
                        <Input
                            size="sm"
                            aria-label="Search events"
                            placeholder="Search events"
                            icon={SearchLg}
                            value={query}
                            onChange={setQuery}
                            className="flex-1"
                        />
                        <Button size="sm" color="secondary" type="submit">
                            Search
                        </Button>
                    </form>
                </div>
            </div>

            {results && (
                <section aria-label="Search results" className="flex flex-col gap-3">
                    <div className="flex items-center justify-between">
                        <h2 className="text-md font-semibold text-primary">
                            {results.length} result{results.length === 1 ? "" : "s"} for “{query}”
                        </h2>
                        <Button size="sm" color="link-gray" onClick={() => setResults(null)}>
                            Clear
                        </Button>
                    </div>
                    {results.length ? (
                        <ul className="flex flex-col divide-y divide-secondary overflow-hidden rounded-xl bg-primary shadow-xs ring-1 ring-secondary ring-inset">
                            {results.map((o) => (
                                <li key={o.id}>
                                    <a
                                        href={`/portal/calendar?view=day&date=${o.startDate}&event=${o.eventId}`}
                                        className="flex items-center gap-3 px-4 py-3 hover:bg-primary_hover"
                                    >
                                        <ColorDot color={o.color} />
                                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-primary">{o.title}</span>
                                        <span className="shrink-0 text-sm text-tertiary">{dayLabel(o.startDate, data.today.slice(0, 4))}</span>
                                    </a>
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <p className="text-sm text-tertiary">No events match. Private events of other people are never searched.</p>
                    )}
                </section>
            )}

            {!calendars.some((c) => !c.hidden) && <Notice title="Every calendar is hidden">Choose a calendar above to show its events.</Notice>}

            {(data.view === "day" || data.view === "week") && (
                <div className={cx("grid grid-cols-1 gap-4", data.planner && "xl:grid-cols-[minmax(0,1fr)_22rem]")}>
                    <div className="min-w-0">
                        {data.view === "day" && <TimeGrid {...props} startHour={Number(data.preferences.workingHours.start.slice(0, 2))} />}
                        {data.view === "week" && (
                            <>
                                <div className="max-md:hidden">
                                    <TimeGrid {...props} startHour={Number(data.preferences.workingHours.start.slice(0, 2))} />
                                </div>
                                <div className="md:hidden">
                                    <WeekList {...props} />
                                </div>
                            </>
                        )}
                    </div>
                    {data.planner && (
                        <TasksPanel
                            planner={planner}
                            today={data.today}
                            defaultDate={data.view === "day" ? data.anchor : data.today >= data.from && data.today <= data.to ? data.today : data.from}
                            collapsible
                            className="xl:sticky xl:top-4 xl:self-start"
                        />
                    )}
                </div>
            )}
            {data.view === "month" && <MonthGrid {...props} month={data.anchor.slice(0, 7)} />}
            {data.view === "agenda" && <AgendaList {...props} />}

            {data.planner && (
                <>
                    <ScheduleDialog planner={planner} today={data.today} />
                    <BlockPanel planner={planner} />
                </>
            )}

            <EventPanel
                target={target}
                onClose={() => setTarget(null)}
                onChanged={() => void reload()}
                calendars={calendars}
                timeZone={tz}
                defaultReminder={data.preferences.defaultReminderMinutes}
                canUseTasks={data.canUseTasks}
                canUseKnowledge={data.canUseKnowledge}
            />
        </>
    );
};
