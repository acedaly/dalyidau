// Leave and balances: today's balances and where they're heading, every booking with its status,
// the full calculation behind any forecast, and what-if scenarios that never touch the real plan.
import { useMemo, useState } from "react";
import { Calendar, Edit01, Plane, Plus, Printer, Trash01, TrendUp01 } from "@untitledui/icons";
import { Tabs } from "@/components/application/tabs/tabs";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Input } from "@/components/base/input/input";
import { Select } from "@/components/base/select/select";
import { TrendChart } from "@/portal/components/charts";
import { DateField } from "@/portal/components/date-field";
import { ConfirmDialog } from "@/portal/components/dialog";
import { Empty } from "@/portal/components/empty";
import { MetricCard } from "@/portal/components/metric-card";
import { Notice } from "@/portal/components/notice";
import { useToast } from "@/portal/components/toast";
import { errorMessage } from "@/portal/lib/api";
import type { PageData } from "@/portal/lib/page-types";
import { holidayOverlays, schoolOverlays } from "@/shared/calendar/holidays";
import { FORECAST_MODE_LABELS, type ForecastMode, balanceAt, bookingHours, forecastSeries } from "@/shared/calendar/leave";
import { dayLabel, eachDate, rangeLabel } from "@/shared/calendar/time";
import { LEAVE_STATUSES, LEAVE_STATUS_LABELS, type LeaveData, type LeaveStatus } from "@/shared/calendar/types";
import { calendarApi } from "../api";
import { BookingDialog, type BookingDraft, Breakdown, LeaveSetup, StatusBadge, bookingDraftFrom, ctxFor, daysOf, h, newBooking } from "../leave-ui";
import { CalendarHeader, Card, download } from "../shared";
import { YearPlanner } from "../year-planner";

type Tab = "overview" | "bookings" | "forecast" | "scenarios";

export const LeavePage = ({ data }: { data: PageData<"calendar-leave"> }) => {
    const toast = useToast();
    const [leave, setLeave] = useState<LeaveData>(data.leave);
    const [tab, setTab] = useState<Tab>(data.tab);
    const [dialog, setDialog] = useState<BookingDraft | null>(null);
    const [deleting, setDeleting] = useState<string | null>(null);
    const today = data.today;
    const ctx = useMemo(() => ctxFor(leave), [leave]);
    const tracked = leave.types.filter((t) => !t.archived && t.tracksBalance);
    const typeName = (id: string) => leave.types.find((t) => t.id === id)?.name ?? "Leave";
    const input = (typeId: string) => ({
        type: leave.types.find((t) => t.id === typeId)!,
        bookings: leave.bookings,
        adjustments: leave.adjustments,
        types: leave.types,
    });

    if (!leave.profile.configured && !leave.types.length)
        return (
            <>
                <CalendarHeader shell={data} title="Leave and balances" crumb={{ label: "Leave" }} />
                <LeaveSetup today={today} onDone={setLeave} />
            </>
        );

    const switchTab = (key: Tab) => {
        setTab(key);
        window.history.replaceState(null, "", key === "overview" ? "/portal/calendar/leave" : `/portal/calendar/leave?tab=${key}`);
    };
    const yearEnd = `${today.slice(0, 4)}-12-31`;

    return (
        <>
            <CalendarHeader
                shell={data}
                title="Leave and balances"
                description="Estimates from your own balances, hours and accrual settings, worked out day by day. Not your employer's records."
                crumb={{ label: "Leave" }}
                actions={
                    <>
                        <Button size="md" color="secondary" href="/portal/calendar/leave/planner" iconLeading={TrendUp01}>
                            Plan time off
                        </Button>
                        <Button size="md" iconLeading={Plus} onClick={() => setDialog(newBooking(leave, today))}>
                            Add leave
                        </Button>
                    </>
                }
            />

            <Tabs selectedKey={tab} onSelectionChange={(k) => switchTab(k as Tab)} className="gap-6">
                <Tabs.List type="underline" size="sm" aria-label="Leave" className="w-max max-w-full overflow-x-auto">
                    <Tabs.Item id="overview">Overview</Tabs.Item>
                    <Tabs.Item id="bookings">Bookings</Tabs.Item>
                    <Tabs.Item id="forecast">Forecast</Tabs.Item>
                    <Tabs.Item id="scenarios">Scenarios</Tabs.Item>
                </Tabs.List>

                <Tabs.Panel id="overview" className="flex flex-col gap-6">
                    <div className="@container">
                        <div className="grid grid-cols-1 gap-4 @md:grid-cols-2 @4xl:grid-cols-3">
                            {tracked.map((t) => {
                                const now = balanceAt(input(t.id), ctx, today, "confirmed");
                                const planned = balanceAt(input(t.id), ctx, today, "planned");
                                const end = balanceAt(input(t.id), ctx, yearEnd, "planned");
                                return (
                                    <MetricCard
                                        key={t.id}
                                        label={t.name}
                                        icon={Plane}
                                        value={h(now.closing)}
                                        detail={
                                            <>
                                                {daysOf(now.closing, leave.profile.pattern)} today
                                                {planned.closing !== now.closing && ` · ${h(planned.closing)} after planned leave so far`}
                                            </>
                                        }
                                        footer={
                                            <p className={end.negativeFrom ? "text-sm text-error-primary" : "text-sm text-tertiary"}>
                                                31 Dec: {h(end.closing)} with planned leave
                                                {end.negativeFrom ? ` · below zero from ${dayLabel(end.negativeFrom)}` : ""}
                                            </p>
                                        }
                                    />
                                );
                            })}
                        </div>
                    </div>
                    <Card title="Coming up" description="Leave from today, real plans only.">
                        {(() => {
                            const upcoming = leave.bookings.filter((b) => !b.scenarioId && b.status !== "cancelled" && b.endDate >= today);
                            return upcoming.length ? (
                                <ul className="flex flex-col divide-y divide-secondary">
                                    {upcoming.map((b) => {
                                        const type = leave.types.find((t) => t.id === b.leaveTypeId);
                                        return (
                                            <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                                                <span className="flex flex-col">
                                                    <span className="text-sm font-medium text-primary">{b.title || typeName(b.leaveTypeId)}</span>
                                                    <span className="text-sm text-tertiary">
                                                        {rangeLabel(b.startDate, b.endDate, today.slice(0, 4))} · {type ? h(bookingHours(b, type, ctx)) : ""}
                                                    </span>
                                                </span>
                                                <StatusBadge status={b.status} />
                                            </li>
                                        );
                                    })}
                                </ul>
                            ) : (
                                <p className="text-sm text-tertiary">No leave planned. Try “Plan time off” to see the best opportunities.</p>
                            );
                        })()}
                    </Card>
                    <Card
                        title={`This year at a glance`}
                        actions={
                            <>
                                <Button
                                    size="sm"
                                    color="secondary"
                                    iconLeading={Printer}
                                    onClick={() =>
                                        void download(`/api/portal/calendar/leave/export.pdf?year=${today.slice(0, 4)}`).catch((e) =>
                                            toast.error("The PDF failed", errorMessage(e)),
                                        )
                                    }
                                >
                                    PDF planner
                                </Button>
                                <Button
                                    size="sm"
                                    color="secondary"
                                    onClick={() =>
                                        void download(`/api/portal/calendar/leave/export.xlsx?year=${today.slice(0, 4)}`).catch((e) =>
                                            toast.error("The export failed", errorMessage(e)),
                                        )
                                    }
                                >
                                    Excel
                                </Button>
                                <Button
                                    size="sm"
                                    color="secondary"
                                    onClick={() =>
                                        void download("/api/portal/calendar/leave/export.csv").catch((e) => toast.error("The export failed", errorMessage(e)))
                                    }
                                >
                                    CSV
                                </Button>
                            </>
                        }
                    >
                        <YearPlanner
                            year={Number(today.slice(0, 4))}
                            today={today}
                            weekStart={data.preferences.weekStart}
                            overlays={{
                                holidays: holidayOverlays(`${today.slice(0, 4)}-01-01`, yearEnd, leave.profile.settings, leave.customDates),
                                school: schoolOverlays(`${today.slice(0, 4)}-01-01`, yearEnd, data.preferences.schoolDivision, leave.customDates),
                                leave: leave.bookings
                                    .filter((b) => !b.scenarioId && b.status !== "cancelled" && b.status !== "draft")
                                    .map((b) => ({
                                        id: b.id,
                                        start: b.startDate,
                                        end: b.endDate,
                                        status: b.status,
                                        typeName: typeName(b.leaveTypeId),
                                        color: "blue",
                                        owner: null,
                                    })),
                                nonWorking: [],
                            }}
                        />
                    </Card>
                </Tabs.Panel>

                <Tabs.Panel id="bookings">
                    <Bookings leave={leave} today={today} onEdit={(b) => setDialog(bookingDraftFrom(b))} onDelete={setDeleting} onLeave={setLeave} />
                </Tabs.Panel>

                <Tabs.Panel id="forecast">
                    <Forecast leave={leave} today={today} onLeave={setLeave} />
                </Tabs.Panel>

                <Tabs.Panel id="scenarios">
                    <Scenarios
                        leave={leave}
                        today={today}
                        onLeave={setLeave}
                        onAdd={(scenarioId) => setDialog(newBooking(leave, today, today, scenarioId))}
                        division={data.preferences.schoolDivision}
                        weekStart={data.preferences.weekStart}
                    />
                </Tabs.Panel>
            </Tabs>

            {dialog && <BookingDialog leave={leave} initial={dialog} onClose={() => setDialog(null)} onSaved={setLeave} />}
            <ConfirmDialog
                isOpen={!!deleting}
                onOpenChange={(open) => !open && setDeleting(null)}
                title="Delete this leave?"
                description="It's removed from your plan and forecasts. To keep a record that it isn't happening, set it to Cancelled instead."
                confirmLabel="Delete"
                destructive
                onConfirm={async () => {
                    if (!deleting) return;
                    try {
                        setLeave((await calendarApi.deleteBooking(deleting)).leave);
                        setDeleting(null);
                    } catch (error) {
                        toast.error("Couldn't delete it", errorMessage(error));
                    }
                }}
            />
        </>
    );
};

const Bookings = ({
    leave,
    today,
    onEdit,
    onDelete,
    onLeave,
}: {
    leave: LeaveData;
    today: string;
    onEdit: (b: LeaveData["bookings"][number]) => void;
    onDelete: (id: string) => void;
    onLeave: (l: LeaveData) => void;
}) => {
    const toast = useToast();
    const ctx = useMemo(() => ctxFor(leave), [leave]);
    const [filter, setFilter] = useState<"upcoming" | "past" | "all">("upcoming");
    const real = leave.bookings.filter((b) => !b.scenarioId);
    const shown = real.filter((b) => (filter === "upcoming" ? b.endDate >= today : filter === "past" ? b.endDate < today : true));
    const setStatus = async (id: string, version: number, status: LeaveStatus) => {
        try {
            onLeave((await calendarApi.updateBooking(id, { version, status })).leave);
        } catch (error) {
            toast.error("Couldn't change the status", errorMessage(error));
        }
    };
    return (
        <Card
            title="Bookings"
            description="Draft and proposed leave is your own planning; requested means you've asked; approved means your employer agreed. Cancelled leave is kept but never counted."
            actions={
                <Select
                    size="sm"
                    aria-label="Show"
                    className="w-40"
                    value={filter}
                    onChange={(k) => k && setFilter(k as typeof filter)}
                    items={[
                        { id: "upcoming", label: "Upcoming" },
                        { id: "past", label: "Past" },
                        { id: "all", label: "All" },
                    ]}
                >
                    {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                </Select>
            }
        >
            {shown.length ? (
                <ul className="flex flex-col divide-y divide-secondary">
                    {shown.map((b) => {
                        const type = leave.types.find((t) => t.id === b.leaveTypeId);
                        return (
                            <li key={b.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                                <span className="flex min-w-0 flex-col">
                                    <span className="text-sm font-medium text-primary">
                                        {b.title || type?.name} <span className="font-normal text-tertiary">· {type?.name}</span>
                                    </span>
                                    <span className="text-sm text-tertiary">
                                        {rangeLabel(b.startDate, b.endDate, today.slice(0, 4))}
                                        {b.part !== "full"
                                            ? ` (${b.part === "hours" ? `${b.hours} h` : b.part === "am" ? "morning" : "afternoon"})`
                                            : ""} · {type ? h(bookingHours(b, type, ctx)) : ""}
                                    </span>
                                </span>
                                <span className="flex items-center gap-2">
                                    <Select
                                        size="sm"
                                        aria-label={`Status of ${b.title || type?.name}`}
                                        className="w-40"
                                        value={b.status}
                                        onChange={(k) => k && k !== b.status && void setStatus(b.id, b.version, k as LeaveStatus)}
                                        items={LEAVE_STATUSES.map((s) => ({ id: s, label: LEAVE_STATUS_LABELS[s].label }))}
                                    >
                                        {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                                    </Select>
                                    <ButtonUtility size="sm" color="tertiary" icon={Edit01} tooltip="Change" onClick={() => onEdit(b)} />
                                    <ButtonUtility size="sm" color="tertiary" icon={Trash01} tooltip="Delete" onClick={() => onDelete(b.id)} />
                                </span>
                            </li>
                        );
                    })}
                </ul>
            ) : (
                <Empty
                    icon={Calendar}
                    title={filter === "past" ? "No past leave" : "No leave booked"}
                    description="Add leave you're planning, have asked for or have been approved."
                />
            )}
        </Card>
    );
};

const Forecast = ({ leave, today, onLeave }: { leave: LeaveData; today: string; onLeave: (l: LeaveData) => void }) => {
    const toast = useToast();
    const ctx = useMemo(() => ctxFor(leave), [leave]);
    const tracked = leave.types.filter((t) => !t.archived && t.tracksBalance);
    const [typeId, setTypeId] = useState(tracked[0]?.id ?? "");
    const [date, setDate] = useState<string | null>(`${today.slice(0, 4)}-12-31`);
    const [mode, setMode] = useState<ForecastMode>(leave.profile.settings.forecastMode);
    const [adj, setAdj] = useState({ date: today as string | null, hours: "", reason: "" });
    const type = tracked.find((t) => t.id === typeId);
    if (!type) return <Notice title="No balances to forecast">Add a leave type that tracks a balance in Leave settings.</Notice>;
    const input = { type, bookings: leave.bookings, adjustments: leave.adjustments, types: leave.types };
    const breakdown = date ? balanceAt(input, ctx, date, mode) : null;
    const series = forecastSeries(input, ctx, today, 18);
    return (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <Card title="Balance at a date" description="Every step from the balance you entered.">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                    <Select
                        label="Leave type"
                        value={typeId}
                        onChange={(k) => k && setTypeId(String(k))}
                        items={tracked.map((t) => ({ id: t.id, label: t.name }))}
                    >
                        {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                    </Select>
                    <DateField label="At the end of" value={date} onChange={setDate} />
                    <Select
                        label="Counting"
                        value={mode}
                        onChange={(k) => k && setMode(k as ForecastMode)}
                        items={(["confirmed", "planned", "all"] as ForecastMode[]).map((m) => ({ id: m, label: FORECAST_MODE_LABELS[m] }))}
                    >
                        {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                    </Select>
                </div>
                {breakdown && <Breakdown b={breakdown} typeName={type.name} />}
                <p className="text-xs text-quaternary">
                    Accrual:{" "}
                    {type.accrual.method === "per_hour"
                        ? `${(type.accrual.rate ?? 0).toFixed(4)} h per ordinary hour worked`
                        : type.accrual.method === "per_period"
                          ? `${type.accrual.hours} h every ${type.accrual.everyDays} days`
                          : "none (adjust by hand)"}
                    . {type.deductsPublicHolidays ? "Public holidays during leave are counted as leave." : "Public holidays during leave aren't deducted."}{" "}
                    Change these in Leave settings.
                </p>
            </Card>
            <Card title="The next 18 months" description="Month-end balance counting requested and proposed leave.">
                <TrendChart
                    points={series.map((p) => ({ date: p.date, value: Math.round(p.planned) }))}
                    label={`${type.name} (hours)`}
                    caption={`${type.name} forecast by month`}
                />
                <table className="w-full text-sm">
                    <caption className="sr-only">Month-end balances</caption>
                    <thead>
                        <tr className="text-left text-xs text-quaternary">
                            <th scope="col" className="py-1 font-medium">
                                Month end
                            </th>
                            <th scope="col" className="py-1 text-right font-medium">
                                Approved only
                            </th>
                            <th scope="col" className="py-1 text-right font-medium">
                                With planned
                            </th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-secondary">
                        {series.map((p) => (
                            <tr key={p.date}>
                                <td className="py-1.5 text-tertiary">{dayLabel(p.date)}</td>
                                <td className="py-1.5 text-right tabular-nums">{h(p.confirmed)}</td>
                                <td className={p.planned < 0 ? "py-1.5 text-right text-error-primary tabular-nums" : "py-1.5 text-right tabular-nums"}>
                                    {h(p.planned)}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </Card>
            <Card
                title="Adjustments"
                description="Corrections from a payslip, leave cashed out, time added by agreement. Dated, and applied from that day."
                className="xl:col-span-2"
            >
                {leave.adjustments.filter((a) => a.leaveTypeId === type.id).length > 0 && (
                    <ul className="flex flex-col divide-y divide-secondary">
                        {leave.adjustments
                            .filter((a) => a.leaveTypeId === type.id)
                            .map((a) => (
                                <li key={a.id} className="flex items-center justify-between gap-2 py-2">
                                    <span className="text-sm text-secondary">
                                        {dayLabel(a.date)} · {a.reason ?? "Adjustment"}
                                    </span>
                                    <span className="flex items-center gap-2">
                                        <span className="text-sm tabular-nums">
                                            {a.hours > 0 ? "+" : ""}
                                            {h(a.hours)}
                                        </span>
                                        <ButtonUtility
                                            size="xs"
                                            color="tertiary"
                                            icon={Trash01}
                                            tooltip="Remove"
                                            onClick={async () => onLeave((await calendarApi.deleteAdjustment(a.id)).leave)}
                                        />
                                    </span>
                                </li>
                            ))}
                    </ul>
                )}
                <form
                    className="flex flex-wrap items-end gap-3"
                    onSubmit={async (e) => {
                        e.preventDefault();
                        if (!adj.date || !Number(adj.hours)) return;
                        try {
                            onLeave(
                                (
                                    await calendarApi.addAdjustment({
                                        leaveTypeId: type.id,
                                        date: adj.date,
                                        hours: Number(adj.hours),
                                        reason: adj.reason || null,
                                    })
                                ).leave,
                            );
                            setAdj({ ...adj, hours: "", reason: "" });
                        } catch (error) {
                            toast.error("Couldn't add it", errorMessage(error));
                        }
                    }}
                >
                    <DateField label="Date" value={adj.date} onChange={(d) => setAdj({ ...adj, date: d })} />
                    <Input label="Hours (+ or −)" type="number" className="w-36" value={adj.hours} onChange={(v) => setAdj({ ...adj, hours: v })} />
                    <Input label="Reason" className="min-w-48 flex-1" value={adj.reason} onChange={(v) => setAdj({ ...adj, reason: v })} />
                    <Button type="submit" size="md" color="secondary" isDisabled={!Number(adj.hours) || !adj.date}>
                        Add adjustment
                    </Button>
                </form>
            </Card>
        </div>
    );
};

const Scenarios = ({
    leave,
    today,
    onLeave,
    onAdd,
    division,
    weekStart,
}: {
    leave: LeaveData;
    today: string;
    onLeave: (l: LeaveData) => void;
    onAdd: (scenarioId: string) => void;
    division: "eastern" | "western" | "none";
    weekStart: 0 | 1;
}) => {
    const toast = useToast();
    const ctx = useMemo(() => ctxFor(leave), [leave]);
    const [selected, setSelected] = useState<string | null>(leave.scenarios[0]?.id ?? null);
    const [name, setName] = useState("");
    const scenario = leave.scenarios.find((s) => s.id === selected);
    const items = leave.bookings.filter((b) => b.scenarioId === selected);
    const tracked = leave.types.filter((t) => !t.archived && t.tracksBalance);
    const year = Number(today.slice(0, 4));
    const end = `${year}-12-31`;
    const dates = new Set(items.flatMap((b) => eachDate(b.startDate, b.endDate, 400)));
    return (
        <div className="flex flex-col gap-4">
            <Card
                title="What-if scenarios"
                description="Try different leave plans without changing your real bookings or balances. Adopt one to copy it into your plan as proposals."
            >
                <form
                    className="flex flex-wrap items-end gap-3"
                    onSubmit={async (e) => {
                        e.preventDefault();
                        if (!name.trim()) return;
                        try {
                            const result = await calendarApi.createScenario(name.trim());
                            onLeave(result.leave);
                            setSelected(result.id);
                            setName("");
                        } catch (error) {
                            toast.error("Couldn't create it", errorMessage(error));
                        }
                    }}
                >
                    <Input label="New scenario" placeholder="e.g. Japan in April" className="min-w-56 flex-1" value={name} onChange={setName} />
                    <Button type="submit" size="md" color="secondary" iconLeading={Plus} isDisabled={!name.trim()}>
                        Create
                    </Button>
                </form>
                {leave.scenarios.length > 0 && (
                    <Select
                        label="Scenario"
                        value={selected}
                        onChange={(k) => setSelected(k ? String(k) : null)}
                        items={leave.scenarios.map((s) => ({ id: s.id, label: s.name }))}
                    >
                        {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                    </Select>
                )}
            </Card>
            {scenario && (
                <>
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                        {tracked.map((t) => {
                            const input = { type: t, bookings: leave.bookings, adjustments: leave.adjustments, types: leave.types };
                            const without = balanceAt(input, ctx, end, "planned");
                            const withIt = balanceAt(input, ctx, end, "planned", scenario.id);
                            return (
                                <MetricCard
                                    key={t.id}
                                    label={`${t.name} on 31 Dec`}
                                    value={h(withIt.closing)}
                                    detail={`${h(without.closing)} without this scenario`}
                                    footer={
                                        withIt.negativeFrom ? (
                                            <p className="text-sm text-error-primary">Below zero from {dayLabel(withIt.negativeFrom)}</p>
                                        ) : undefined
                                    }
                                />
                            );
                        })}
                    </div>
                    <Card
                        title={scenario.name}
                        actions={
                            <>
                                <Button size="sm" iconLeading={Plus} onClick={() => onAdd(scenario.id)}>
                                    Add leave
                                </Button>
                                <Button
                                    size="sm"
                                    color="secondary"
                                    isDisabled={!items.length}
                                    onClick={async () => onLeave((await calendarApi.adoptScenario(scenario.id)).leave)}
                                >
                                    Adopt as proposals
                                </Button>
                                <Button
                                    size="sm"
                                    color="secondary-destructive"
                                    onClick={async () => {
                                        onLeave((await calendarApi.deleteScenario(scenario.id)).leave);
                                        setSelected(null);
                                    }}
                                >
                                    Delete scenario
                                </Button>
                            </>
                        }
                    >
                        {items.length ? (
                            <ul className="flex flex-col divide-y divide-secondary">
                                {items.map((b) => {
                                    const type = leave.types.find((t) => t.id === b.leaveTypeId);
                                    return (
                                        <li key={b.id} className="flex items-center justify-between gap-2 py-2">
                                            <span className="text-sm text-secondary">
                                                {b.title || type?.name} · {rangeLabel(b.startDate, b.endDate, today.slice(0, 4))}
                                            </span>
                                            <span className="flex items-center gap-2">
                                                <span className="text-sm tabular-nums">{type ? h(bookingHours(b, type, ctx)) : ""}</span>
                                                <ButtonUtility
                                                    size="xs"
                                                    color="tertiary"
                                                    icon={Trash01}
                                                    tooltip="Remove"
                                                    onClick={async () => onLeave((await calendarApi.deleteBooking(b.id)).leave)}
                                                />
                                            </span>
                                        </li>
                                    );
                                })}
                            </ul>
                        ) : (
                            <p className="text-sm text-tertiary">Add leave to this scenario to see what it does to your balances.</p>
                        )}
                        <YearPlanner
                            year={year}
                            today={today}
                            weekStart={weekStart}
                            scenario={dates}
                            overlays={{
                                holidays: holidayOverlays(`${year}-01-01`, end, leave.profile.settings, leave.customDates),
                                school: schoolOverlays(`${year}-01-01`, end, division, leave.customDates),
                                leave: leave.bookings
                                    .filter((b) => !b.scenarioId && b.status !== "cancelled" && b.status !== "draft")
                                    .map((b) => ({
                                        id: b.id,
                                        start: b.startDate,
                                        end: b.endDate,
                                        status: b.status,
                                        typeName: "Leave",
                                        color: "blue",
                                        owner: null,
                                    })),
                                nonWorking: [],
                            }}
                        />
                    </Card>
                </>
            )}
        </div>
    );
};
