// Pieces the leave pages share: the booking dialog (with a live calculation of what the leave takes
// and the balance afterwards), status badges, the calculation breakdown and the first-time setup.
// Every number comes from the shared leave engine (src/shared/calendar/leave.ts), the same code the
// Worker, the MCP tools and Chief of Staff use, so the portal never shows a different answer.
import { useMemo, useState } from "react";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { Select } from "@/components/base/select/select";
import { TextArea } from "@/components/base/textarea/textarea";
import { DateField } from "@/portal/components/date-field";
import { PortalDialog } from "@/portal/components/dialog";
import { FormError } from "@/portal/components/form";
import { useToast } from "@/portal/components/toast";
import { ApiError, errorMessage } from "@/portal/lib/api";
import { leaveContext } from "@/shared/calendar/holidays";
import {
    type BalanceBreakdown,
    DEFAULT_PATTERN,
    FORECAST_MODE_LABELS,
    type WorkPattern,
    balanceAt,
    bookingDays,
    formatHours,
    hoursLabel,
    weeklyHours,
} from "@/shared/calendar/leave";
import { dayLabel, rangeLabel } from "@/shared/calendar/time";
import { LEAVE_STATUSES, LEAVE_STATUS_LABELS, type LeaveBookingInfo, type LeaveData, type LeaveStatus } from "@/shared/calendar/types";
import { calendarApi, clientId } from "./api";
import { Card } from "./shared";

export const ctxFor = (leave: LeaveData) => leaveContext(leave.profile.pattern, leave.profile.settings, leave.customDates);

const STATUS_COLORS: Record<LeaveStatus, "gray" | "blue" | "warning" | "success" | "brand" | "error"> = {
    draft: "gray",
    proposed: "brand",
    requested: "warning",
    approved: "success",
    taken: "blue",
    cancelled: "gray",
};

export const StatusBadge = ({ status }: { status: LeaveStatus }) => (
    <Badge size="sm" color={STATUS_COLORS[status]}>
        {LEAVE_STATUS_LABELS[status].label}
    </Badge>
);

export const h = (value: number) => `${formatHours(value)} h`;

/** Hours as days of the person's average working day: "6 days". */
export const daysOf = (hours: number, pattern: WorkPattern) => {
    const working = pattern.hours.filter((x) => x > 0);
    const average = working.length ? working.reduce((s, x) => s + x, 0) / working.length : 0;
    if (!average) return "";
    const days = Math.round((hours / average) * 10) / 10;
    return `${formatHours(days)} day${Math.abs(days) === 1 ? "" : "s"}`;
};

/** The steps from the entered balance to the balance at a date. */
export const Breakdown = ({ b, typeName }: { b: BalanceBreakdown; typeName: string }) => (
    <table className="w-full text-sm">
        <caption className="sr-only">
            How the {typeName} balance at {dayLabel(b.asOf)} is worked out
        </caption>
        <tbody className="divide-y divide-secondary">
            <tr>
                <th scope="row" className="py-2 text-left font-normal text-tertiary">
                    Balance you entered, at the end of {dayLabel(b.openingDate)}
                </th>
                <td className="py-2 text-right font-medium text-primary tabular-nums">{h(b.opening)}</td>
            </tr>
            {b.beforeBalanceDate ? (
                <tr>
                    <td colSpan={2} className="py-2 text-tertiary">
                        This date is before your entered balance, so only that balance is known.
                    </td>
                </tr>
            ) : (
                <>
                    <tr>
                        <th scope="row" className="py-2 text-left font-normal text-tertiary">
                            Accrued to {dayLabel(b.asOf)}
                        </th>
                        <td className="py-2 text-right text-success-primary tabular-nums">+{h(b.accrued)}</td>
                    </tr>
                    {b.adjustments !== 0 && (
                        <tr>
                            <th scope="row" className="py-2 text-left font-normal text-tertiary">
                                Adjustments
                            </th>
                            <td className="py-2 text-right tabular-nums">
                                {b.adjustments > 0 ? "+" : ""}
                                {h(b.adjustments)}
                            </td>
                        </tr>
                    )}
                    {b.deductions.map((d) => (
                        <tr key={d.bookingId}>
                            <th scope="row" className="py-2 text-left font-normal text-tertiary">
                                {d.title ?? "Leave"} {rangeLabel(d.startDate, d.endDate)}{" "}
                                <span className="text-quaternary">
                                    ({LEAVE_STATUS_LABELS[d.status].label.toLowerCase()}
                                    {d.scenario ? ", scenario" : ""})
                                </span>
                            </th>
                            <td className="py-2 text-right text-error-primary tabular-nums">−{h(d.hours)}</td>
                        </tr>
                    ))}
                    {b.forfeited > 0 && (
                        <tr>
                            <th scope="row" className="py-2 text-left font-normal text-tertiary">
                                Lost at the yearly reset
                            </th>
                            <td className="py-2 text-right text-error-primary tabular-nums">−{h(b.forfeited)}</td>
                        </tr>
                    )}
                    {b.capped > 0 && (
                        <tr>
                            <td colSpan={2} className="py-2 text-tertiary">
                                {h(b.capped)} not accrued because the balance reached its cap.
                            </td>
                        </tr>
                    )}
                </>
            )}
            <tr>
                <th scope="row" className="py-2 text-left font-semibold text-primary">
                    Balance at the end of {dayLabel(b.asOf)}
                </th>
                <td
                    className={
                        b.closing < 0
                            ? "py-2 text-right font-semibold text-error-primary tabular-nums"
                            : "py-2 text-right font-semibold text-primary tabular-nums"
                    }
                >
                    {h(b.closing)}
                </td>
            </tr>
            {b.negativeFrom && (
                <tr>
                    <td colSpan={2} className="py-2 text-error-primary">
                        Goes below zero on {dayLabel(b.negativeFrom)} (lowest {h(b.lowest.hours)} on {dayLabel(b.lowest.date)}).
                    </td>
                </tr>
            )}
        </tbody>
    </table>
);

export interface BookingDraft {
    id?: string;
    version?: number;
    leaveTypeId: string;
    startDate: string | null;
    endDate: string | null;
    part: LeaveBookingInfo["part"];
    hours: string;
    status: LeaveStatus;
    title: string;
    note: string;
    scenarioId: string | null;
}

export const newBooking = (leave: LeaveData, start?: string, end?: string, scenarioId: string | null = null): BookingDraft => ({
    leaveTypeId: leave.types.find((t) => t.kind === "annual" && !t.archived)?.id ?? leave.types.find((t) => !t.archived)?.id ?? "",
    startDate: start ?? null,
    endDate: end ?? start ?? null,
    part: "full",
    hours: "",
    status: scenarioId ? "draft" : "proposed",
    title: "",
    note: "",
    scenarioId,
});

export const bookingDraftFrom = (b: LeaveBookingInfo): BookingDraft => ({
    id: b.id,
    version: b.version,
    leaveTypeId: b.leaveTypeId,
    startDate: b.startDate,
    endDate: b.endDate,
    part: b.part,
    hours: b.hours === null ? "" : String(b.hours),
    status: b.status,
    title: b.title ?? "",
    note: b.note ?? "",
    scenarioId: b.scenarioId,
});

export const BookingDialog = ({
    leave,
    initial,
    onClose,
    onSaved,
}: {
    leave: LeaveData;
    initial: BookingDraft;
    onClose: () => void;
    onSaved: (leave: LeaveData) => void;
}) => {
    const toast = useToast();
    const [d, setD] = useState(initial);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<ApiError | null>(null);
    const [requestId] = useState(clientId);
    const types = leave.types.filter((t) => !t.archived || t.id === d.leaveTypeId);
    const type = types.find((t) => t.id === d.leaveTypeId);
    const ctx = useMemo(() => ctxFor(leave), [leave]);
    const valid = !!(
        type &&
        d.startDate &&
        d.endDate &&
        d.endDate >= d.startDate &&
        (d.part === "full" || d.startDate === d.endDate) &&
        (d.part !== "hours" || d.hours !== "")
    );

    const preview = useMemo(() => {
        if (!valid || !type) return null;
        const shape = { startDate: d.startDate!, endDate: d.endDate!, part: d.part, hours: d.part === "hours" ? Number(d.hours) : null, dayHours: null };
        const days = bookingDays(shape, type, ctx);
        const hours = days.reduce((s, x) => s + x.hours, 0);
        const others = leave.bookings.filter((b) => b.id !== d.id);
        const hypothetical: LeaveBookingInfo = {
            id: "preview",
            leaveTypeId: type.id,
            scenarioId: d.scenarioId ?? "preview",
            ...shape,
            status: d.status === "cancelled" ? "draft" : d.status,
            title: null,
            note: null,
            version: 1,
            updatedAt: "",
        };
        const input = { type, bookings: [...others, hypothetical], adjustments: leave.adjustments, types: leave.types };
        const after = type.tracksBalance ? balanceAt(input, ctx, d.endDate!, "planned", hypothetical.scenarioId) : null;
        return { hours, working: days.filter((x) => x.hours > 0).length, holidays: days.filter((x) => x.reason === "public_holiday"), after };
    }, [valid, type, d, ctx, leave]);

    const save = async () => {
        if (!valid) return;
        setBusy(true);
        setError(null);
        try {
            const body = {
                leaveTypeId: d.leaveTypeId,
                startDate: d.startDate!,
                endDate: d.endDate!,
                part: d.part,
                hours: d.part === "hours" ? Number(d.hours) : null,
                status: d.status,
                title: d.title.trim() || null,
                note: d.note.trim() || null,
                scenarioId: d.scenarioId,
            };
            const result = d.id
                ? await calendarApi.updateBooking(d.id, { ...body, version: d.version! })
                : await calendarApi.createBooking({ ...body, clientId: requestId });
            onSaved(result.leave);
            toast.success(d.id ? "Leave updated" : "Leave added");
            onClose();
        } catch (e) {
            setError(e instanceof ApiError ? e : new ApiError(0, "error", errorMessage(e)));
        } finally {
            setBusy(false);
        }
    };

    return (
        <PortalDialog
            isOpen
            onOpenChange={(open) => !open && onClose()}
            title={d.id ? "Change leave" : d.scenarioId ? "Add leave to the scenario" : "Add leave"}
            description="Recorded for your own planning. Marking it approved means your employer has approved it; nothing here asks them."
            size="lg"
            onSubmit={() => void save()}
            footer={
                <>
                    <Button color="secondary" size="lg" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button type="submit" size="lg" isLoading={busy} isDisabled={!valid}>
                        {d.id ? "Save" : "Add leave"}
                    </Button>
                </>
            }
        >
            <FormError message={error && !error.issues.length ? error.message : null} />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Select
                    label="Leave type"
                    value={d.leaveTypeId}
                    onChange={(k) => k && setD({ ...d, leaveTypeId: String(k) })}
                    items={types.map((t) => ({ id: t.id, label: t.name }))}
                >
                    {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                </Select>
                <Select
                    label="Status"
                    value={d.status}
                    onChange={(k) => k && setD({ ...d, status: k as LeaveStatus })}
                    items={LEAVE_STATUSES.map((s) => ({ id: s, label: LEAVE_STATUS_LABELS[s].label }))}
                    hint={LEAVE_STATUS_LABELS[d.status].description}
                >
                    {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                </Select>
                <DateField
                    label="First day"
                    isRequired
                    value={d.startDate}
                    onChange={(v) => setD({ ...d, startDate: v, endDate: d.endDate && v && d.endDate < v ? v : (d.endDate ?? v) })}
                />
                <DateField label="Last day" isRequired value={d.endDate} onChange={(v) => setD({ ...d, endDate: v })} error={error?.issueFor("endDate")} />
                {d.startDate && d.startDate === d.endDate && (
                    <Select
                        label="How much of the day"
                        value={d.part}
                        onChange={(k) => k && setD({ ...d, part: k as LeaveBookingInfo["part"] })}
                        items={[
                            { id: "full", label: "The whole day" },
                            { id: "am", label: "Morning (half the day's hours)" },
                            { id: "pm", label: "Afternoon (half the day's hours)" },
                            { id: "hours", label: "A number of hours" },
                        ]}
                    >
                        {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                    </Select>
                )}
                {d.part === "hours" && <Input label="Hours" type="number" value={d.hours} onChange={(hours) => setD({ ...d, hours })} />}
            </div>
            <Input label="Title" placeholder="e.g. Family holiday" value={d.title} onChange={(title) => setD({ ...d, title })} />
            <TextArea label="Note" rows={2} value={d.note} onChange={(note) => setD({ ...d, note })} />
            {preview && (
                <div role="status" className="bg-secondary_subtle rounded-lg p-3 text-sm text-secondary">
                    <p>
                        Takes <strong>{h(preview.hours)}</strong> over {preview.working} working day{preview.working === 1 ? "" : "s"}.
                        {preview.holidays.length > 0 && (
                            <>
                                {" "}
                                {preview.holidays.map((x) => x.holiday).join(", ")}{" "}
                                {type?.deductsPublicHolidays ? "counted as leave" : "not deducted (public holiday)"}.
                            </>
                        )}
                    </p>
                    {preview.after && (
                        <p className={preview.after.lowest.hours < 0 ? "text-error-primary" : "text-tertiary"}>
                            {type?.name} balance afterwards (counting planned leave): {h(preview.after.closing)}
                            {preview.after.negativeFrom ? `. It goes below zero on ${dayLabel(preview.after.negativeFrom)}.` : "."}
                        </p>
                    )}
                </div>
            )}
        </PortalDialog>
    );
};

const PRESETS: { id: string; label: string; pattern: WorkPattern }[] = [
    { id: "ft38", label: "Full time, 38 hours (Mon–Fri, 7.6 h)", pattern: DEFAULT_PATTERN },
    { id: "ft35", label: "Full time, 35 hours (Mon–Fri, 7 h)", pattern: { kind: "weekly", hours: [7, 7, 7, 7, 7, 0, 0] } },
    { id: "ft40", label: "Full time, 40 hours (Mon–Fri, 8 h)", pattern: { kind: "weekly", hours: [8, 8, 8, 8, 8, 0, 0] } },
    { id: "pt3", label: "Part time, 3 days (Mon–Wed, 7.6 h)", pattern: { kind: "weekly", hours: [7.6, 7.6, 7.6, 0, 0, 0, 0] } },
    { id: "pt4", label: "Part time, 4 days (Mon–Thu, 7.6 h)", pattern: { kind: "weekly", hours: [7.6, 7.6, 7.6, 7.6, 0, 0, 0] } },
];

/** First-time setup: a work pattern and the balances from a payslip. */
export const LeaveSetup = ({ today, onDone }: { today: string; onDone: (leave: LeaveData) => void }) => {
    const toast = useToast();
    const [preset, setPreset] = useState("ft38");
    const [date, setDate] = useState<string | null>(today);
    const [annual, setAnnual] = useState("");
    const [personal, setPersonal] = useState("");
    const [busy, setBusy] = useState(false);
    const pattern = PRESETS.find((p) => p.id === preset)!.pattern;
    const save = async () => {
        if (!date || annual === "") return;
        setBusy(true);
        try {
            onDone(
                (await calendarApi.setup({ pattern, balanceDate: date, annualHours: Number(annual), personalHours: personal === "" ? null : Number(personal) }))
                    .leave,
            );
            toast.success("Leave planner set up");
        } catch (error) {
            toast.error("Couldn't set it up", errorMessage(error));
        } finally {
            setBusy(false);
        }
    };
    return (
        <Card
            title="Set up your leave planner"
            description="Enter your balances in hours as your latest payslip or HR system shows them, and the date they're for. Leave is worked out from your own hours, so part-time and rostered patterns are counted correctly. You can fine-tune everything later in Leave settings."
        >
            <form
                className="grid grid-cols-1 gap-4 sm:grid-cols-2"
                onSubmit={(e) => {
                    e.preventDefault();
                    void save();
                }}
            >
                <div className="sm:col-span-2">
                    <Select
                        label="Your usual hours"
                        value={preset}
                        onChange={(k) => k && setPreset(String(k))}
                        items={PRESETS.map((p) => ({ id: p.id, label: p.label }))}
                        hint={`${formatHours(weeklyHours(pattern))} hours a week. Other patterns (fortnightly, rostered days off) are in Leave settings.`}
                    >
                        {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                    </Select>
                </div>
                <DateField label="Balances as at" isRequired value={date} onChange={setDate} hint="The end of this day" />
                <Input
                    label="Annual leave (hours)"
                    isRequired
                    type="number"
                    value={annual}
                    onChange={setAnnual}
                    hint={annual !== "" ? hoursLabel(Number(annual), pattern) : "From your payslip"}
                />
                <Input label="Personal/carer's leave (hours)" type="number" value={personal} onChange={setPersonal} hint="Optional" />
                <div className="flex items-end">
                    <Button type="submit" size="md" isLoading={busy} isDisabled={!date || annual === ""}>
                        Set up
                    </Button>
                </div>
            </form>
            <p className="text-xs text-quaternary">
                Starting accrual rates follow the National Employment Standards (4 weeks' annual and 10 days' personal/carer's leave a year). Check your own
                award or agreement. {FORECAST_MODE_LABELS.planned} is the default forecast.
            </p>
        </Card>
    );
};
