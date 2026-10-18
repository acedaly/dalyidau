// Leave settings: your work pattern (weekly, or a fortnightly roster), which holidays apply to you,
// each leave type's balance, accrual, cap and yearly reset, and who can see when you're on leave.
import { useState } from "react";
import { Archive, Plus, Save01, Trash01 } from "@untitledui/icons";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Checkbox } from "@/components/base/checkbox/checkbox";
import { Input } from "@/components/base/input/input";
import { Select } from "@/components/base/select/select";
import { Toggle } from "@/components/base/toggle/toggle";
import { DateField } from "@/portal/components/date-field";
import { ConfirmDialog } from "@/portal/components/dialog";
import { useToast } from "@/portal/components/toast";
import { errorMessage } from "@/portal/lib/api";
import type { PageData } from "@/portal/lib/page-types";
import { LEAVE_PRESETS, type LeaveAccrual, type LeaveSettings, type WorkPattern, formatHours, weeklyHours } from "@/shared/calendar/leave";
import { startOfWeek } from "@/shared/calendar/time";
import { LEAVE_KINDS, type LeaveData, type LeaveKind, type LeaveTypeInfo } from "@/shared/calendar/types";
import { calendarApi } from "../api";
import { h } from "../leave-ui";
import { CalendarHeader, Card, ColorPicker } from "../shared";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const PatternEditor = ({ leave, today, onLeave }: { leave: LeaveData; today: string; onLeave: (l: LeaveData) => void }) => {
    const toast = useToast();
    const [pattern, setPattern] = useState<WorkPattern>(leave.profile.pattern);
    const [settings, setSettings] = useState<LeaveSettings>(leave.profile.settings);
    const [busy, setBusy] = useState(false);
    const setHours = (i: number, v: string) => {
        const hours = [...pattern.hours];
        hours[i] = Math.max(0, Math.min(24, Number(v) || 0));
        setPattern({ ...pattern, hours } as WorkPattern);
    };
    const save = async () => {
        setBusy(true);
        try {
            onLeave((await calendarApi.saveProfile({ version: leave.profile.version, pattern, settings })).leave);
            toast.success("Saved");
        } catch (error) {
            toast.error("Couldn't save", errorMessage(error));
        } finally {
            setBusy(false);
        }
    };
    return (
        <Card
            title="Your work pattern"
            description={`Ordinary hours on each day. Leave costs a day's hours here; days with 0 cost nothing. ${formatHours(weeklyHours(pattern))} hours a week on average.`}
        >
            <Select
                label="Pattern"
                className="sm:w-80"
                value={pattern.kind}
                onChange={(k) =>
                    k &&
                    setPattern(
                        k === "weekly"
                            ? { kind: "weekly", hours: pattern.hours.slice(0, 7) }
                            : { kind: "fortnightly", hours: [...pattern.hours.slice(0, 7), ...pattern.hours.slice(0, 7)], anchor: startOfWeek(today, 1) },
                    )
                }
                items={[
                    { id: "weekly", label: "The same every week" },
                    { id: "fortnightly", label: "A two-week roster (e.g. rostered days off, 9-day fortnight)" },
                ]}
            >
                {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
            </Select>
            {[0, ...(pattern.kind === "fortnightly" ? [1] : [])].map((week) => (
                <fieldset key={week} className="flex flex-col gap-2">
                    {pattern.kind === "fortnightly" && <legend className="text-sm font-medium text-secondary">Week {week + 1}</legend>}
                    <div className="grid grid-cols-4 gap-2 sm:grid-cols-7">
                        {DAYS.map((d, i) => (
                            <Input
                                key={d}
                                label={d}
                                type="number"
                                size="sm"
                                value={String(pattern.hours[week * 7 + i])}
                                onChange={(v) => setHours(week * 7 + i, v)}
                            />
                        ))}
                    </div>
                </fieldset>
            ))}
            {pattern.kind === "fortnightly" && (
                <DateField
                    label="A Monday that starts week 1"
                    value={pattern.anchor}
                    onChange={(v) => v && setPattern({ ...pattern, anchor: startOfWeek(v, 1) })}
                    hint="Any week 1 Monday, past or future"
                />
            )}
            <div className="flex flex-col gap-4 border-t border-secondary pt-4">
                <Input
                    label="Employer or label"
                    className="sm:w-80"
                    value={settings.employer ?? ""}
                    onChange={(v) => setSettings({ ...settings, employer: v || null })}
                    hint="Shown on exports"
                />
                <Input
                    label="Region for regional public holidays"
                    className="sm:w-80"
                    value={settings.region ?? ""}
                    onChange={(v) => setSettings({ ...settings, region: v || null })}
                    hint="Matches the region on regional holidays in Holidays and school dates"
                />
                <Toggle
                    label="The NSW Bank Holiday is a holiday for me"
                    hint="Only for banks and some financial institutions. Not a public holiday for everyone else."
                    isSelected={settings.includeBankHoliday}
                    onChange={(v) => setSettings({ ...settings, includeBankHoliday: v })}
                />
                <Select
                    label="Forecasts count by default"
                    className="sm:w-96"
                    value={settings.forecastMode}
                    onChange={(k) => k && setSettings({ ...settings, forecastMode: k as LeaveSettings["forecastMode"] })}
                    items={[
                        { id: "planned", label: "Approved, taken, requested and proposed leave" },
                        { id: "confirmed", label: "Approved and taken leave only" },
                    ]}
                >
                    {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                </Select>
            </div>
            <div>
                <Button size="md" iconLeading={Save01} isLoading={busy} onClick={() => void save()}>
                    Save pattern and settings
                </Button>
            </div>
        </Card>
    );
};

const AccrualFields = ({ value, onChange }: { value: LeaveAccrual; onChange: (a: LeaveAccrual) => void }) => (
    <div className="flex flex-col gap-3">
        <Select
            label="Accrues"
            value={value.method}
            onChange={(k) =>
                k &&
                onChange({
                    ...value,
                    method: k as LeaveAccrual["method"],
                    rate: k === "per_hour" ? (value.rate ?? 0.0769) : value.rate,
                    hours: k === "per_period" ? (value.hours ?? 7.6) : value.hours,
                    everyDays: k === "per_period" ? (value.everyDays ?? 28) : value.everyDays,
                })
            }
            items={[
                { id: "per_hour", label: "For each hour worked" },
                { id: "per_period", label: "A fixed amount every so often" },
                { id: "none", label: "Doesn't accrue (adjust by hand)" },
            ]}
        >
            {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
        </Select>
        {value.method === "per_hour" && (
            <Input
                label="Hours accrued per hour worked"
                type="number"
                value={String(value.rate ?? "")}
                onChange={(v) => onChange({ ...value, rate: Number(v) || 0 })}
                hint={`${formatHours((value.rate ?? 0) * 52)} weeks' worth a year. 4 weeks = 0.076923; 10 days personal = 0.038462.`}
            />
        )}
        {value.method === "per_period" && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Input label="Hours" type="number" value={String(value.hours ?? "")} onChange={(v) => onChange({ ...value, hours: Number(v) || 0 })} />
                <Input
                    label="Every (days)"
                    type="number"
                    value={String(value.everyDays ?? "")}
                    onChange={(v) => onChange({ ...value, everyDays: Math.max(1, Number(v) || 1) })}
                />
                <DateField label="Starting from" value={value.anchor} onChange={(anchor) => onChange({ ...value, anchor })} />
            </div>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Input
                label="Stop accruing at (hours)"
                type="number"
                value={value.cap === null ? "" : String(value.cap)}
                onChange={(v) => onChange({ ...value, cap: v === "" ? null : Number(v) })}
                hint="Optional cap or carry-over limit"
            />
            <div className="flex flex-col gap-2">
                <Checkbox
                    label="Resets every year"
                    isSelected={!!value.reset}
                    onChange={(on) => onChange({ ...value, reset: on ? { month: 7, day: 1, carryOver: 0 } : null })}
                    hint="Leave above the carry-over is lost on that day"
                />
                {value.reset && (
                    <div className="grid grid-cols-3 gap-2">
                        <Input
                            label="Day"
                            size="sm"
                            type="number"
                            value={String(value.reset.day)}
                            onChange={(v) => onChange({ ...value, reset: { ...value.reset!, day: Math.min(31, Math.max(1, Number(v) || 1)) } })}
                        />
                        <Input
                            label="Month"
                            size="sm"
                            type="number"
                            value={String(value.reset.month)}
                            onChange={(v) => onChange({ ...value, reset: { ...value.reset!, month: Math.min(12, Math.max(1, Number(v) || 1)) } })}
                        />
                        <Input
                            label="Carry over (h)"
                            size="sm"
                            type="number"
                            value={String(value.reset.carryOver)}
                            onChange={(v) => onChange({ ...value, reset: { ...value.reset!, carryOver: Math.max(0, Number(v) || 0) } })}
                        />
                    </div>
                )}
            </div>
        </div>
    </div>
);

const TypeCard = ({ type, onLeave }: { type: LeaveTypeInfo; onLeave: (l: LeaveData) => void }) => {
    const toast = useToast();
    const [t, setT] = useState(type);
    const [confirm, setConfirm] = useState(false);
    const save = async () => {
        try {
            onLeave(
                (
                    await calendarApi.updateType(t.id, {
                        version: type.version,
                        name: t.name,
                        color: t.color,
                        balanceHours: t.balanceHours,
                        balanceDate: t.balanceDate,
                        accrual: t.accrual,
                        deductsPublicHolidays: t.deductsPublicHolidays,
                        paid: t.paid,
                        tracksBalance: t.tracksBalance,
                    })
                ).leave,
            );
            toast.success("Saved", t.name);
        } catch (error) {
            toast.error("Couldn't save", errorMessage(error));
        }
    };
    return (
        <Card
            title={type.name}
            description={
                type.archived
                    ? "Archived: kept for its history, not offered for new leave."
                    : `${type.tracksBalance ? `${h(type.balanceHours)} at the end of ${type.balanceDate}` : "No balance tracked"}`
            }
            actions={
                <>
                    {type.archived && (
                        <Badge size="sm" color="gray">
                            Archived
                        </Badge>
                    )}
                    <ButtonUtility
                        size="sm"
                        color="tertiary"
                        icon={Archive}
                        tooltip={type.archived ? "Restore" : "Archive"}
                        onClick={async () => onLeave((await calendarApi.updateType(type.id, { version: type.version, archived: !type.archived })).leave)}
                    />
                    <ButtonUtility size="sm" color="tertiary" icon={Trash01} tooltip="Delete" onClick={() => setConfirm(true)} />
                </>
            }
        >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Input label="Name" value={t.name} onChange={(name) => setT({ ...t, name })} />
                <Input
                    label="Balance (hours)"
                    type="number"
                    value={String(t.balanceHours)}
                    onChange={(v) => setT({ ...t, balanceHours: Number(v) || 0 })}
                    isDisabled={!t.tracksBalance}
                />
                <DateField label="As at the end of" value={t.balanceDate} onChange={(d) => d && setT({ ...t, balanceDate: d })} />
            </div>
            <AccrualFields value={t.accrual} onChange={(accrual) => setT({ ...t, accrual })} />
            <div className="flex flex-col gap-3">
                <Toggle label="Tracks a balance" isSelected={t.tracksBalance} onChange={(tracksBalance) => setT({ ...t, tracksBalance })} />
                <Toggle label="Paid" hint="Unpaid leave days earn no accrual on other leave" isSelected={t.paid} onChange={(paid) => setT({ ...t, paid })} />
                <Toggle
                    label="Deduct public holidays that fall during this leave"
                    hint="Usually off: under the NES a public holiday during annual leave isn't taken from the balance"
                    isSelected={t.deductsPublicHolidays}
                    onChange={(deductsPublicHolidays) => setT({ ...t, deductsPublicHolidays })}
                />
            </div>
            <ColorPicker value={t.color} onChange={(color) => setT({ ...t, color })} />
            <div>
                <Button size="sm" iconLeading={Save01} onClick={() => void save()}>
                    Save {t.name}
                </Button>
            </div>
            <ConfirmDialog
                isOpen={confirm}
                onOpenChange={setConfirm}
                title={`Delete ${type.name}?`}
                description="Its bookings and adjustments are deleted too. Archive it instead to keep the history."
                confirmLabel="Delete"
                destructive
                onConfirm={async () => {
                    onLeave((await calendarApi.deleteType(type.id)).leave);
                    setConfirm(false);
                }}
            />
        </Card>
    );
};

export const LeaveSettingsPage = ({ data }: { data: PageData<"calendar-leave-settings"> }) => {
    const toast = useToast();
    const [leave, setLeave] = useState<LeaveData>(data.leave);
    const [kind, setKind] = useState<LeaveKind>("long_service");
    const [balance, setBalance] = useState("0");
    const [date, setDate] = useState<string | null>(data.today);
    const [share, setShare] = useState<string | null>(null);
    const notShared = data.people.filter((p) => !leave.sharedWith.some((s) => s.email === p.email));
    return (
        <>
            <CalendarHeader
                shell={data}
                title="Leave settings"
                description="How your leave is counted. Check your award or agreement for your own rates."
                crumb={{ label: "Leave settings" }}
            />
            <PatternEditor key={leave.profile.version} leave={leave} today={data.today} onLeave={setLeave} />
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                {leave.types.map((t) => (
                    <TypeCard key={`${t.id}:${t.version}`} type={t} onLeave={setLeave} />
                ))}
            </div>
            <Card
                title="Add a leave type"
                description="Starting values follow the National Employment Standards where they apply (NSW long service leave: 2 months after 10 years). Configure your own afterwards."
            >
                <form
                    className="flex flex-wrap items-end gap-3"
                    onSubmit={async (e) => {
                        e.preventDefault();
                        if (!date) return;
                        try {
                            setLeave((await calendarApi.createType({ kind, balanceHours: Number(balance) || 0, balanceDate: date })).leave);
                            toast.success("Added", LEAVE_PRESETS[kind].name);
                        } catch (error) {
                            toast.error("Couldn't add it", errorMessage(error));
                        }
                    }}
                >
                    <Select
                        label="Kind"
                        className="min-w-56"
                        value={kind}
                        onChange={(k) => k && setKind(k as LeaveKind)}
                        items={LEAVE_KINDS.map((k) => ({ id: k, label: LEAVE_PRESETS[k].name }))}
                    >
                        {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                    </Select>
                    <Input label="Balance (hours)" type="number" className="w-40" value={balance} onChange={setBalance} />
                    <DateField label="As at" value={date} onChange={setDate} />
                    <Button type="submit" size="md" iconLeading={Plus} isDisabled={!date}>
                        Add
                    </Button>
                </form>
            </Card>
            <Card
                title="Sharing"
                description="Let someone see when you're on leave (dates and status only, never your balances or notes), so you can plan time off together. They see it in their calendar and in Plan time off."
            >
                {leave.sharedWith.length ? (
                    <ul className="flex flex-col divide-y divide-secondary">
                        {leave.sharedWith.map((p) => (
                            <li key={p.email} className="flex items-center justify-between py-2">
                                <span className="text-sm text-primary">{p.name ?? p.email}</span>
                                <Button size="sm" color="link-destructive" onClick={async () => setLeave((await calendarApi.unshare(p.email)).leave)}>
                                    Stop sharing
                                </Button>
                            </li>
                        ))}
                    </ul>
                ) : (
                    <p className="text-sm text-tertiary">Your leave isn't shared with anyone.</p>
                )}
                {notShared.length > 0 && (
                    <div className="flex flex-wrap items-end gap-3">
                        <Select
                            label="Share with"
                            placeholder="Choose a person"
                            className="min-w-56"
                            value={share}
                            onChange={(k) => setShare(k ? String(k) : null)}
                            items={notShared.map((p) => ({ id: p.email, label: p.name ?? p.email }))}
                        >
                            {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                        </Select>
                        <Button
                            size="md"
                            color="secondary"
                            isDisabled={!share}
                            onClick={async () => {
                                if (!share) return;
                                try {
                                    setLeave((await calendarApi.share(share)).leave);
                                    setShare(null);
                                } catch (error) {
                                    toast.error("Couldn't share", errorMessage(error));
                                }
                            }}
                        >
                            Share
                        </Button>
                    </div>
                )}
                {leave.sharedWithMe.length > 0 && (
                    <p className="text-sm text-tertiary">Shared with you: {leave.sharedWithMe.map((s) => s.owner.name ?? s.owner.email).join(", ")}.</p>
                )}
            </Card>
        </>
    );
};
