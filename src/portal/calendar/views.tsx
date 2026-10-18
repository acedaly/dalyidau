// The day, week, month and agenda views. Adapted from Untitled UI PRO's calendar (application/calendar):
// its column headers, time markers, row labels and event pills are used as they are; the views
// around them are rebuilt so they are controlled by the page (dates come from the Worker, in the
// person's own time zone rather than the browser's), every event is a real button, all-day events
// and overlays (public holidays, school holidays, leave, task due dates) have their own lane, and
// overlapping events sit side by side. Phones get a stacked list instead of a seven-column grid.
import { type DragEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckDone01, Flag01, GraduationHat01, Plane, Plus } from "@untitledui/icons";
import { CalendarDwViewEvent } from "@/components/application/calendar/base-components/calendar-dw-view-event";
import { CalendarMonthViewEvent, eventViewColors } from "@/components/application/calendar/base-components/calendar-month-view-event";
import { CalendarTimeMarker } from "@/components/application/calendar/base-components/calendar-time-marker";
import { addDays, dayLabel, eachDate, isoWeekday, longDateLabel, timeLabel, toMinutes, wallClock, weekdayLabel } from "@/shared/calendar/time";
import type { EventOccurrence, Overlays } from "@/shared/calendar/types";
import type { TimeBlockInfo } from "@/shared/planner/types";
import { cx } from "@/utils/cx";
import { DRAG_TYPE, type DragPayload, durationLabel, readDrag } from "./planner-api";

const HOUR = 48;

export interface ViewProps {
    from: string;
    to: string;
    today: string;
    timeZone: string;
    occurrences: EventOccurrence[];
    overlays: Overlays;
    onOpen: (occurrence: EventOccurrence) => void;
    onCreate: (date: string, time: string | null) => void;
    /** Time blocks (Daily Planner), drawn with the events. */
    blocks?: TimeBlockInfo[];
    /** Blocks with a conflict, marked with a warning. */
    conflicted?: ReadonlySet<string>;
    onOpenBlock?: (block: TimeBlockInfo) => void;
    /** Something from the Tasks panel or the timeline dropped on a time. */
    onDropPlan?: (payload: DragPayload, date: string, time: string) => void;
}

const timeRange = (o: EventOccurrence) => (o.allDay ? "All day" : `${timeLabel(o.startTime!)} – ${timeLabel(o.endTime!)}`);
const describe = (o: EventOccurrence) =>
    [
        o.title,
        o.allDay ? (o.startDate === o.endDate ? "all day" : `${dayLabel(o.startDate)} to ${dayLabel(o.endDate)}`) : timeRange(o),
        o.location,
        o.status === "tentative" ? "tentative" : null,
    ]
        .filter(Boolean)
        .join(", ");

/** Overlays and all-day items on one date, as small labelled chips. */
function dayExtras(overlays: Overlays, date: string) {
    return {
        holidays: overlays.holidays.filter((h) => h.date === date),
        school: overlays.school.filter((s) => s.kind !== "term" && s.start <= date && s.end >= date),
        leave: overlays.leave.filter((l) => l.start <= date && l.end >= date),
        tasks: overlays.tasks.filter((t) => t.date === date),
        nonWorking: overlays.nonWorking.filter((n) => n.start <= date && n.end >= date),
    };
}

const Chip = ({
    icon: Icon,
    children,
    tone,
    href,
    title,
}: {
    icon?: typeof Flag01;
    children: ReactNode;
    tone: "holiday" | "school" | "leave" | "task" | "muted";
    href?: string;
    title?: string;
}) => {
    const tones = {
        holiday: "bg-utility-orange-50 text-utility-orange-700 ring-utility-orange-200",
        school: "bg-utility-green-50 text-utility-green-700 ring-utility-green-200",
        leave: "bg-utility-blue-50 text-utility-blue-700 ring-utility-blue-200",
        task: "bg-secondary text-secondary ring-secondary",
        muted: "bg-secondary_subtle text-tertiary ring-secondary",
    };
    const body = (
        <>
            {Icon && <Icon aria-hidden="true" className="size-3 shrink-0" />}
            <span className="truncate">{children}</span>
        </>
    );
    const className = cx("flex min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium ring-1 ring-inset", tones[tone]);
    return href ? (
        <a href={href} title={title} className={cx(className, "outline-focus-ring hover:underline focus-visible:outline-2")}>
            {body}
        </a>
    ) : (
        <span title={title} className={className}>
            {body}
        </span>
    );
};

/** Public holidays, school holidays, leave, tasks and non-working days for a date. */
export const DayChips = ({ overlays, date, compact = false }: { overlays: Overlays; date: string; compact?: boolean }) => {
    const x = dayExtras(overlays, date);
    const items: ReactNode[] = [
        ...x.holidays.map((h) => (
            <Chip
                key={`h${h.name}`}
                icon={Flag01}
                tone="holiday"
                title={h.provisional ? "Provisional: not yet published by the NSW Government" : "NSW public holiday"}
            >
                {h.name}
                {h.provisional ? " (provisional)" : ""}
            </Chip>
        )),
        ...x.school.map((s) => (
            <Chip key={`s${s.id}`} icon={GraduationHat01} tone="school" title={s.custom ? "Your school's date" : "NSW public schools"}>
                {s.name}
            </Chip>
        )),
        ...x.leave.map((l) => (
            <Chip
                key={`l${l.id}`}
                icon={Plane}
                tone={l.status === "approved" || l.status === "taken" ? "leave" : "muted"}
                href={l.owner ? undefined : "/portal/calendar/leave?tab=bookings"}
            >
                {l.owner ? `${l.owner.name ?? l.owner.email}: away` : l.typeName}
                {l.status === "proposed" || l.status === "requested" ? ` (${l.status})` : ""}
            </Chip>
        )),
        ...x.nonWorking.map((n) => (
            <Chip key={`n${n.id}`} tone="muted">
                {n.name}
            </Chip>
        )),
        ...x.tasks.map((t) => (
            <Chip
                key={`t${t.id}${t.kind}`}
                icon={CheckDone01}
                tone="task"
                href={`/portal/tasks/t/${t.id}`}
                title={`${t.kind === "deadline" ? "Deadline" : t.kind === "milestone" ? "Milestone" : "Due"} · ${t.projectName}`}
            >
                {t.kind === "deadline" ? "Deadline: " : ""}
                {t.title}
            </Chip>
        )),
    ];
    if (!items.length) return null;
    const shown = compact ? items.slice(0, 2) : items;
    return (
        <div className="flex min-w-0 flex-col gap-1">
            {shown}
            {compact && items.length > shown.length && <span className="px-1 text-xs text-quaternary">+{items.length - shown.length} more</span>}
        </div>
    );
};

const EventButton = ({
    o,
    onOpen,
    children,
    className,
}: {
    o: EventOccurrence;
    onOpen: (o: EventOccurrence) => void;
    children: ReactNode;
    className?: string;
}) => (
    <button
        type="button"
        onClick={() => onOpen(o)}
        aria-label={describe(o)}
        className={cx(
            "block w-full min-w-0 cursor-pointer rounded-md text-left outline-focus-ring focus-visible:outline-2 focus-visible:outline-offset-1",
            o.status === "tentative" && "opacity-75",
            className,
        )}
    >
        {children}
    </button>
);

// --- Day and week ----------------------------------------------------------------------------------

interface Timed {
    startDate: string;
    endDate: string;
    startTime: string | null;
    endTime: string | null;
}

interface Placed<T extends Timed> {
    o: T;
    top: number;
    height: number;
    column: number;
    columns: number;
}

/** Positions one day's timed events and blocks, side by side where they overlap. */
function place<T extends Timed>(items: T[], date: string): Placed<T>[] {
    const spans = items
        .map((o) => {
            const start = o.startDate < date ? 0 : toMinutes(o.startTime!);
            const end = o.endDate > date ? 1440 : Math.max(toMinutes(o.endTime!), start + 15);
            return { o, start, end };
        })
        .sort((a, b) => a.start - b.start || b.end - a.end);
    const placed: Placed<T>[] = [];
    let group: ((typeof spans)[number] & { column: number })[] = [];
    let groupEnd = -1;
    const flush = () => {
        const columns = Math.max(1, ...group.map((g) => g.column + 1));
        for (const g of group)
            placed.push({ o: g.o, top: (g.start / 60) * HOUR, height: Math.max(20, ((g.end - g.start) / 60) * HOUR), column: g.column, columns });
        group = [];
    };
    for (const s of spans) {
        if (s.start >= groupEnd && group.length) flush();
        const used = new Set(group.filter((g) => g.end > s.start).map((g) => g.column));
        let column = 0;
        while (used.has(column)) column++;
        group.push({ ...s, column });
        groupEnd = Math.max(groupEnd, s.end);
    }
    if (group.length) flush();
    return placed;
}

const isAllDayLane = (o: EventOccurrence) => o.allDay || o.startDate !== o.endDate;

const isBlock = (o: Timed): o is TimeBlockInfo => "taskId" in o;

const describeBlock = (b: TimeBlockInfo, conflict: boolean) =>
    [
        `Planned: ${b.title}`,
        `${timeLabel(b.startTime)} – ${timeLabel(b.endTime === "24:00" ? "23:59" : b.endTime)}`,
        durationLabel(b.durationMinutes),
        conflict ? "has a conflict" : null,
    ]
        .filter(Boolean)
        .join(", ");

/** A time block: a dashed card, distinct from events, that opens its panel and can be dragged to another time. */
export const BlockButton = ({
    block,
    conflict,
    onOpen,
    compact = false,
    className,
}: {
    block: TimeBlockInfo;
    conflict: boolean;
    onOpen?: (block: TimeBlockInfo) => void;
    compact?: boolean;
    className?: string;
}) => {
    const done = block.taskStatus === "completed" || block.earlierOccurrence;
    return (
        <button
            type="button"
            draggable={block.canEdit && !done}
            onDragStart={(e) => {
                const payload: DragPayload = { kind: "block", blockId: block.id, version: block.version, minutes: block.durationMinutes };
                e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(payload));
                e.dataTransfer.effectAllowed = "move";
            }}
            onClick={() => onOpen?.(block)}
            aria-label={describeBlock(block, conflict)}
            data-block={block.id}
            className={cx(
                "flex h-full w-full min-w-0 cursor-pointer flex-col overflow-hidden rounded-md border border-dashed px-1.5 py-1 text-left outline-focus-ring focus-visible:outline-2 focus-visible:outline-offset-1",
                conflict ? "border-error bg-error-primary" : "border-brand bg-brand-primary",
                done && "opacity-60",
                className,
            )}
        >
            <span className="flex min-w-0 items-center gap-1 text-xs font-semibold text-primary">
                {conflict ? (
                    <AlertTriangle aria-hidden="true" className="size-3 shrink-0 text-fg-error-secondary" />
                ) : (
                    <CheckDone01 aria-hidden="true" className="size-3 shrink-0 text-fg-brand-secondary" />
                )}
                <span className={cx("truncate", done && "line-through")}>{block.title}</span>
            </span>
            {!compact && (
                <span className="truncate text-xs text-tertiary">
                    {timeLabel(block.startTime)} – {timeLabel(block.endTime === "24:00" ? "23:59" : block.endTime)}
                </span>
            )}
        </button>
    );
};

/** The time under the pointer in a day column, rounded down to a quarter hour. */
const timeAt = (e: DragEvent<HTMLElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const minutes = Math.max(0, Math.min(23 * 60 + 45, Math.floor((((e.clientY - rect.top) / HOUR) * 60) / 15) * 15));
    return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
};

export const TimeGrid = ({
    from,
    to,
    today,
    timeZone,
    occurrences,
    overlays,
    onOpen,
    onCreate,
    blocks = [],
    conflicted,
    onOpenBlock,
    onDropPlan,
    startHour = 8,
}: ViewProps & { startHour?: number }) => {
    const days = eachDate(from, to, 7);
    const [dropAt, setDropAt] = useState<{ date: string; time: string } | null>(null);
    const scroller = useRef<HTMLDivElement>(null);
    const [now, setNow] = useState(() => wallClock(new Date(), timeZone));
    useEffect(() => {
        scroller.current?.scrollTo({ top: Math.max(0, (startHour - 1) * HOUR) });
        const timer = window.setInterval(() => setNow(wallClock(new Date(), timeZone)), 60_000);
        return () => window.clearInterval(timer);
    }, [timeZone, startHour]);
    const columns = `3.5rem repeat(${days.length}, minmax(0, 1fr))`;

    return (
        <div className="flex flex-col overflow-hidden rounded-xl bg-primary shadow-xs ring-1 ring-secondary ring-inset">
            {/* Day headings and the all-day lane. */}
            <div className="grid border-b border-secondary" style={{ gridTemplateColumns: columns }}>
                <div className="border-r border-secondary" />
                {days.map((d) => (
                    <div key={d} className="flex min-w-0 flex-col gap-1 border-r border-secondary p-1.5 last:border-r-0">
                        <a
                            href={`/portal/calendar?view=day&date=${d}`}
                            className="flex items-center justify-center gap-1.5 rounded-md py-1 text-xs font-medium text-quaternary outline-focus-ring hover:bg-primary_hover focus-visible:outline-2"
                            aria-label={longDateLabel(d)}
                        >
                            <span>{weekdayLabel(d)}</span>
                            <span
                                className={cx(
                                    "flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-xs font-semibold text-secondary",
                                    d === today && "bg-brand-solid text-white",
                                )}
                            >
                                {Number(d.slice(8))}
                            </span>
                        </a>
                        <DayChips overlays={overlays} date={d} compact={days.length > 1} />
                        {occurrences
                            .filter((o) => isAllDayLane(o) && o.startDate <= d && o.endDate >= d)
                            .map((o) => (
                                <EventButton key={`${o.id}:${d}`} o={o} onOpen={onOpen}>
                                    <CalendarMonthViewEvent
                                        label={o.startDate < d ? `↳ ${o.title}` : o.title}
                                        color={o.color}
                                        supportingText={!o.allDay && o.startDate === d ? timeLabel(o.startTime!) : undefined}
                                    />
                                </EventButton>
                            ))}
                    </div>
                ))}
            </div>
            {/* Hours. */}
            {/* A scrolling region keyboard users can reach and scroll with the arrow keys. */}
            <div
                ref={scroller}
                tabIndex={0}
                role="region"
                aria-label="Hours of the day"
                className="relative max-h-[70vh] min-h-96 overflow-y-auto outline-focus-ring focus-visible:outline-2 focus-visible:-outline-offset-2"
            >
                <div className="relative grid" style={{ gridTemplateColumns: columns, height: 24 * HOUR }}>
                    <div className="bg-secondary_subtle relative border-r border-secondary">
                        {Array.from({ length: 24 }, (_, h) => (
                            <span
                                key={h}
                                className="absolute right-2 -translate-y-1/2 text-xs font-medium whitespace-nowrap text-quaternary first:translate-y-1"
                                style={{ top: h * HOUR }}
                            >
                                {h === 0 ? "" : timeLabel(`${String(h).padStart(2, "0")}:00`)}
                            </span>
                        ))}
                    </div>
                    {days.map((d) => {
                        const placed = place<EventOccurrence | TimeBlockInfo>(
                            [
                                ...occurrences.filter((o) => !isAllDayLane(o) && o.startDate <= d && o.endDate >= d),
                                ...blocks.filter((b) => b.startDate <= d && b.endDate >= d),
                            ],
                            d,
                        );
                        const weekend = isoWeekday(d) >= 6;
                        return (
                            <div
                                key={d}
                                data-date={d}
                                className={cx("relative border-r border-secondary last:border-r-0", weekend && "bg-secondary_subtle")}
                                // Tasks and blocks can be dropped anywhere in the column, events included.
                                onDragOver={(e) => {
                                    if (!onDropPlan || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
                                    e.preventDefault();
                                    e.dataTransfer.dropEffect = "move";
                                    const time = timeAt(e);
                                    if (dropAt?.date !== d || dropAt.time !== time) setDropAt({ date: d, time });
                                }}
                                onDragLeave={(e) => {
                                    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropAt(null);
                                }}
                                onDrop={(e) => {
                                    const payload = onDropPlan ? readDrag(e.dataTransfer) : null;
                                    setDropAt(null);
                                    if (!payload) return;
                                    e.preventDefault();
                                    onDropPlan!(payload, d, timeAt(e));
                                }}
                            >
                                {Array.from({ length: 24 }, (_, h) => (
                                    <button
                                        key={h}
                                        type="button"
                                        tabIndex={-1}
                                        aria-hidden="true"
                                        onClick={() => onCreate(d, `${String(h).padStart(2, "0")}:00`)}
                                        className="group absolute inset-x-0 flex cursor-pointer items-start justify-end border-b border-secondary p-1 hover:bg-primary_hover"
                                        style={{ top: h * HOUR, height: HOUR }}
                                    >
                                        <Plus className="hidden size-4 text-fg-quaternary group-hover:block" />
                                    </button>
                                ))}
                                {dropAt?.date === d && (
                                    <div
                                        aria-hidden="true"
                                        className="pointer-events-none absolute inset-x-0.5 z-10 rounded-md bg-brand-solid/15 ring-2 ring-brand ring-inset"
                                        style={{ top: (toMinutes(dropAt.time) / 60) * HOUR, height: HOUR / 2 }}
                                    />
                                )}
                                {placed.map((p) => (
                                    <div
                                        key={p.o.id}
                                        className="absolute px-0.5 py-0.5"
                                        style={{ top: p.top, height: p.height, left: `${(p.column / p.columns) * 100}%`, width: `${100 / p.columns}%` }}
                                    >
                                        {isBlock(p.o) ? (
                                            <BlockButton block={p.o} conflict={!!conflicted?.has(p.o.id)} onOpen={onOpenBlock} compact={p.height < 40} />
                                        ) : (
                                            <EventButton o={p.o} onOpen={onOpen} className="h-full">
                                                <CalendarDwViewEvent
                                                    label={p.o.title}
                                                    color={p.o.color}
                                                    supportingText={p.height >= 40 ? timeRange(p.o) : undefined}
                                                    withDot={p.o.showAs === "free"}
                                                />
                                            </EventButton>
                                        )}
                                    </div>
                                ))}
                                {d === now.date && (
                                    <CalendarTimeMarker className="!left-0" style={{ top: (toMinutes(now.time) / 60) * HOUR }}>
                                        <span className="sr-only">Now, </span>
                                        {timeLabel(now.time)}
                                    </CalendarTimeMarker>
                                )}
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
};

// --- Month -----------------------------------------------------------------------------------------

export const MonthGrid = ({ from, to, today, occurrences, overlays, onOpen, onCreate, month }: ViewProps & { month: string }) => {
    const days = eachDate(from, to, 42);
    const [selected, setSelected] = useState<string>(today.slice(0, 7) === month ? today : `${month}-01`);
    const byDay = useMemo(() => {
        const map = new Map<string, EventOccurrence[]>();
        for (const o of occurrences)
            for (let d = o.startDate < from ? from : o.startDate; d <= o.endDate && d <= to; d = addDays(d, 1)) map.set(d, [...(map.get(d) ?? []), o]);
        return map;
    }, [occurrences, from, to]);
    const MAX = 3;
    return (
        <div className="flex flex-col gap-4">
            <div className="overflow-hidden rounded-xl bg-primary shadow-xs ring-1 ring-secondary ring-inset">
                <div className="grid grid-cols-7 border-b border-secondary" aria-hidden="true">
                    {days.slice(0, 7).map((d) => (
                        <div key={d} className="py-2 text-center text-xs font-medium text-quaternary">
                            {weekdayLabel(d)}
                        </div>
                    ))}
                </div>
                <div className="grid grid-cols-7">
                    {days.map((d) => {
                        const items = byDay.get(d) ?? [];
                        const outside = d.slice(0, 7) !== month;
                        return (
                            <div
                                key={d}
                                className={cx(
                                    "group relative flex min-h-22 min-w-0 flex-col gap-1 border-r border-b border-secondary p-1 sm:min-h-28 sm:p-1.5 [&:nth-child(7n)]:border-r-0",
                                    outside && "bg-secondary_subtle",
                                    selected === d && "max-md:bg-active",
                                )}
                            >
                                <div className="flex items-center justify-between gap-1">
                                    <button
                                        type="button"
                                        onClick={() => setSelected(d)}
                                        aria-label={`${longDateLabel(d)}, ${items.length} event${items.length === 1 ? "" : "s"}`}
                                        aria-pressed={selected === d}
                                        className={cx(
                                            "flex size-7 cursor-pointer items-center justify-center rounded-full text-xs font-semibold text-secondary outline-focus-ring hover:bg-primary_hover focus-visible:outline-2",
                                            d === today && "bg-brand-solid text-white hover:bg-brand-solid_hover",
                                            outside && d !== today && "text-quaternary",
                                        )}
                                    >
                                        {Number(d.slice(8))}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => onCreate(d, null)}
                                        aria-label={`Add an event on ${longDateLabel(d)}`}
                                        className="hidden size-7 cursor-pointer items-center justify-center rounded-md text-fg-quaternary outline-focus-ring group-hover:flex hover:bg-primary_hover focus-visible:flex focus-visible:outline-2 max-md:hidden"
                                    >
                                        <Plus aria-hidden="true" className="size-4" />
                                    </button>
                                </div>
                                <div className="max-md:hidden">
                                    <DayChips overlays={overlays} date={d} compact />
                                </div>
                                <div className="flex flex-wrap gap-1 md:flex-col">
                                    {items.slice(0, MAX).map((o) => (
                                        <EventButton key={o.id} o={o} onOpen={onOpen} className="max-md:w-auto">
                                            <CalendarMonthViewEvent
                                                label={o.title}
                                                color={o.color}
                                                supportingText={!o.allDay && o.startDate === d ? timeLabel(o.startTime!) : undefined}
                                                collapseOnMobile
                                            />
                                        </EventButton>
                                    ))}
                                    {items.length > MAX && (
                                        <a
                                            href={`/portal/calendar?view=day&date=${d}`}
                                            className="px-1 text-xs font-medium text-tertiary hover:underline max-md:hidden"
                                        >
                                            +{items.length - MAX} more
                                        </a>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>
            {/* Phones: the chosen day's events below the grid. */}
            <div className="md:hidden">
                <AgendaDay date={selected} today={today} occurrences={byDay.get(selected) ?? []} overlays={overlays} onOpen={onOpen} onCreate={onCreate} />
            </div>
        </div>
    );
};

// --- Agenda ------------------------------------------------------------------------------------------

export const AgendaDay = ({
    date,
    today,
    occurrences,
    overlays,
    onOpen,
    onCreate,
    blocks = [],
    conflicted,
    onOpenBlock,
}: {
    date: string;
    today: string;
    occurrences: EventOccurrence[];
    overlays: Overlays;
    onOpen: ViewProps["onOpen"];
    onCreate: ViewProps["onCreate"];
    blocks?: TimeBlockInfo[];
    conflicted?: ReadonlySet<string>;
    onOpenBlock?: ViewProps["onOpenBlock"];
}) => (
    <section aria-labelledby={`day-${date}`} className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
            <h3 id={`day-${date}`} className="text-sm font-semibold text-secondary">
                {date === today ? "Today · " : date === addDays(today, 1) ? "Tomorrow · " : ""}
                {longDateLabel(date)}
            </h3>
            <button
                type="button"
                onClick={() => onCreate(date, null)}
                className="cursor-pointer rounded-md px-2 py-1 text-sm font-semibold text-brand-secondary outline-focus-ring hover:underline focus-visible:outline-2"
            >
                Add<span className="sr-only"> an event on {longDateLabel(date)}</span>
            </button>
        </div>
        <DayChips overlays={overlays} date={date} />
        {blocks.length > 0 && (
            <ul aria-label={`Planned on ${longDateLabel(date)}`} className="flex flex-col gap-1.5">
                {blocks.map((b) => (
                    <li key={b.id}>
                        <BlockButton block={b} conflict={!!conflicted?.has(b.id)} onOpen={onOpenBlock} className="min-h-11 px-3 py-2" />
                    </li>
                ))}
            </ul>
        )}
        {occurrences.length ? (
            <ul className="flex flex-col divide-y divide-secondary overflow-hidden rounded-xl bg-primary shadow-xs ring-1 ring-secondary ring-inset">
                {occurrences.map((o) => (
                    <li key={o.id}>
                        <EventButton o={o} onOpen={onOpen} className="rounded-none px-4 py-3 hover:bg-primary_hover">
                            <span className="flex items-start gap-3">
                                <span aria-hidden="true" className={cx("mt-1.5 size-2.5 shrink-0 rounded-full", eventViewColors[o.color].dot)} />
                                <span className="flex min-w-0 flex-1 flex-col">
                                    <span className="truncate text-sm font-semibold text-primary">{o.title}</span>
                                    <span className="text-sm text-tertiary">
                                        {o.allDay
                                            ? o.startDate === o.endDate
                                                ? "All day"
                                                : `${dayLabel(o.startDate)} – ${dayLabel(o.endDate)}`
                                            : timeRange(o)}
                                        {o.eventTimeZone ? ` · ${o.eventTimeZone.replace(/_/g, " ")} time` : ""}
                                        {o.location ? ` · ${o.location}` : ""}
                                    </span>
                                </span>
                                {o.recurring && <span className="shrink-0 text-xs text-quaternary">Repeats</span>}
                            </span>
                        </EventButton>
                    </li>
                ))}
            </ul>
        ) : blocks.length ? null : (
            <p className="text-sm text-tertiary">Nothing scheduled.</p>
        )}
    </section>
);

export const AgendaList = ({
    from,
    to,
    today,
    occurrences,
    overlays,
    onOpen,
    onCreate,
    blocks = [],
    conflicted,
    onOpenBlock,
    skipEmpty = true,
}: ViewProps & { skipEmpty?: boolean }) => {
    const days = eachDate(from, to, 400).filter((d) => {
        if (!skipEmpty || d === today) return true;
        const x = dayExtras(overlays, d);
        return (
            occurrences.some((o) => o.startDate <= d && o.endDate >= d) ||
            blocks.some((b) => b.startDate === d) ||
            x.holidays.length ||
            x.leave.length ||
            x.tasks.length ||
            x.school.some((s) => s.start === d)
        );
    });
    if (!days.length) return <p className="text-sm text-tertiary">Nothing scheduled in this period.</p>;
    return (
        <div className="flex flex-col gap-6">
            {days.map((d) => (
                <AgendaDay
                    key={d}
                    date={d}
                    today={today}
                    occurrences={occurrences.filter((o) => o.startDate <= d && o.endDate >= d)}
                    overlays={overlays}
                    onOpen={onOpen}
                    onCreate={onCreate}
                    blocks={blocks.filter((b) => b.startDate === d)}
                    conflicted={conflicted}
                    onOpenBlock={onOpenBlock}
                />
            ))}
        </div>
    );
};

/** The week as stacked days, for phones. */
export const WeekList = (props: ViewProps) => <AgendaList {...props} skipEmpty={false} />;
