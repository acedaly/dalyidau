// Choosing how a task repeats: common patterns in one list, and "Custom" for any interval, chosen
// weekdays, the day of the month (or the last day), a weekday of the month ("the 2nd Tuesday", "the
// last Friday", "the last weekday"), an end date or a number of times, and whether the next date
// counts from the schedule or from when it was completed. The sentence underneath always says exactly
// what was chosen, using the same wording the task shows.
import { useState } from "react";
import { Repeat04 } from "@untitledui/icons";
import { ButtonGroup, ButtonGroupItem } from "@/components/base/button-group/button-group";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { RadioButton, RadioGroup } from "@/components/base/radio-buttons/radio-buttons";
import { Select } from "@/components/base/select/select";
import { PortalDialog } from "@/portal/components/dialog";
import { type Frequency, type RecurrenceInput, type RecurrenceRule, describeRule, isoWeekday, recurrenceInput, withAnchor } from "@/shared/tasks/recurrence";
import { DateMenu } from "./pickers";

const PRESETS: { id: string; label: string; rule: (anchor: string) => RecurrenceInput | null }[] = [
    { id: "none", label: "Doesn't repeat", rule: () => null },
    { id: "daily", label: "Every day", rule: () => ({ freq: "daily", interval: 1 }) },
    { id: "weekdays", label: "Every weekday (Mon–Fri)", rule: () => ({ freq: "weekly", interval: 1, weekdays: [1, 2, 3, 4, 5] }) },
    { id: "weekly", label: "Every week", rule: (a) => ({ freq: "weekly", interval: 1, weekdays: [isoWeekday(a)] }) },
    { id: "fortnightly", label: "Every fortnight", rule: (a) => ({ freq: "weekly", interval: 2, weekdays: [isoWeekday(a)] }) },
    { id: "monthly", label: "Every month", rule: () => ({ freq: "monthly", interval: 1 }) },
    { id: "yearly", label: "Every year", rule: () => ({ freq: "yearly", interval: 1 }) },
    { id: "custom", label: "Custom…", rule: () => null },
];

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const UNITS: Record<Frequency, string> = { daily: "days", weekly: "weeks", monthly: "months", yearly: "years" };

/** Which preset a rule is, if any. */
const presetFor = (rule: RecurrenceRule | null) => {
    if (!rule) return "none";
    const days = (rule.weekdays ?? []).join();
    if (rule.until || rule.count || rule.basis === "completion" || rule.monthWeekday || rule.lastWorkday) return "custom";
    if (rule.freq === "daily" && rule.interval === 1) return "daily";
    if (rule.freq === "weekly" && rule.interval === 1 && days === "1,2,3,4,5") return "weekdays";
    if (rule.freq === "weekly" && rule.interval === 1 && (rule.weekdays?.length ?? 1) === 1) return "weekly";
    if (rule.freq === "weekly" && rule.interval === 2 && (rule.weekdays?.length ?? 1) === 1) return "fortnightly";
    if (rule.freq === "monthly" && rule.interval === 1 && rule.monthDay === Number(rule.anchor.slice(8))) return "monthly";
    if (rule.freq === "yearly" && rule.interval === 1) return "yearly";
    return "custom";
};

interface RecurrenceEditorProps {
    rule: RecurrenceRule | null;
    /** The task's due date (or today), which anchors a new rule. */
    anchor: string;
    onChange: (rule: RecurrenceInput | null) => void;
    isDisabled?: boolean;
}

export const RecurrenceEditor = ({ rule, anchor, onChange, isDisabled }: RecurrenceEditorProps) => {
    const [customOpen, setCustomOpen] = useState(false);
    return (
        <div className="flex flex-col gap-1.5">
            <Select
                aria-label="Repeat"
                size="sm"
                className="w-full sm:w-64"
                icon={Repeat04}
                isDisabled={isDisabled}
                value={presetFor(rule)}
                onChange={(key) => {
                    if (key === "custom") return setCustomOpen(true);
                    const preset = PRESETS.find((p) => p.id === key);
                    if (preset) onChange(preset.rule(anchor));
                }}
                items={PRESETS.map((p) => ({ id: p.id, label: p.id === "custom" && presetFor(rule) === "custom" && rule ? describeRule(rule) : p.label }))}
            >
                {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
            </Select>
            {rule && presetFor(rule) === "custom" && (
                <Button size="sm" color="link-color" className="self-start" onClick={() => setCustomOpen(true)} isDisabled={isDisabled}>
                    Edit custom repeat
                </Button>
            )}
            {customOpen && (
                <CustomRepeat rule={rule} anchor={anchor} onCancel={() => setCustomOpen(false)} onSave={(next) => (onChange(next), setCustomOpen(false))} />
            )}
        </div>
    );
};

const CustomRepeat = ({
    rule,
    anchor,
    onCancel,
    onSave,
}: {
    rule: RecurrenceRule | null;
    anchor: string;
    onCancel: () => void;
    onSave: (rule: RecurrenceInput) => void;
}) => {
    const [freq, setFreq] = useState<Frequency>(rule?.freq ?? "weekly");
    const [interval, setInterval] = useState(String(rule?.interval ?? 1));
    const [weekdays, setWeekdays] = useState<number[]>(rule?.weekdays ?? [isoWeekday(anchor)]);
    type MonthChoice = "same" | "last" | "weekday" | "lastWeekday" | "lastWorkday";
    const [monthDay, setMonthDay] = useState<MonthChoice>(
        rule?.lastWorkday
            ? "lastWorkday"
            : rule?.monthWeekday
              ? rule.monthWeekday.week === -1
                  ? "lastWeekday"
                  : "weekday"
              : rule?.monthDay === -1
                ? "last"
                : "same",
    );
    const [basis, setBasis] = useState<"scheduled" | "completion">(rule?.basis ?? "scheduled");
    const [until, setUntil] = useState<string | null>(rule?.until ?? null);
    const [ends, setEnds] = useState<"never" | "date" | "count">(rule?.count ? "count" : rule?.until ? "date" : "never");
    const [count, setCount] = useState(String(rule?.count ?? 10));
    const day = Number(anchor.slice(8));
    const week = Math.ceil(day / 7) > 4 ? -1 : Math.ceil(day / 7);
    const weekdayName = WEEKDAYS[isoWeekday(anchor) - 1];
    const ordinal = ["1st", "2nd", "3rd", "4th"][week - 1] ?? "last";
    const scheduledMonthly = basis === "scheduled";

    const monthly = (): Partial<RecurrenceInput> => {
        if (!scheduledMonthly || monthDay === "same") return { monthDay: day };
        if (monthDay === "last") return { monthDay: -1 };
        if (monthDay === "lastWorkday") return { lastWorkday: true };
        return { monthWeekday: { week: monthDay === "lastWeekday" ? -1 : week, weekday: isoWeekday(anchor) } };
    };
    const draft: RecurrenceInput = {
        freq,
        interval: Number(interval) || 1,
        basis,
        until: ends === "date" ? until : null,
        ...(ends === "count" && basis === "scheduled" ? { count: Number(count) || 1 } : {}),
        ...(freq === "weekly" && basis === "scheduled" ? { weekdays: [...weekdays].sort() } : {}),
        ...(freq === "monthly" ? monthly() : {}),
    };
    const check = recurrenceInput.safeParse(draft);
    const summary = check.success ? describeRule(withAnchor(check.data, anchor)) : (check.error.issues[0]?.message ?? "Check the repeat");

    return (
        <PortalDialog
            isOpen
            onOpenChange={(open) => !open && onCancel()}
            title="Custom repeat"
            icon={Repeat04}
            description={<span aria-live="polite">{summary}</span>}
            onSubmit={() => check.success && onSave(draft)}
            footer={
                <>
                    <Button color="secondary" size="md" onClick={onCancel}>
                        Cancel
                    </Button>
                    <Button type="submit" size="md" isDisabled={!check.success}>
                        Use this repeat
                    </Button>
                </>
            }
        >
            <div className="flex flex-wrap items-end gap-3">
                <Input label="Every" type="number" size="sm" className="w-24" value={interval} onChange={setInterval} inputMode="numeric" />
                <Select
                    aria-label="Unit"
                    size="sm"
                    className="w-36"
                    value={freq}
                    onChange={(key) => key && setFreq(key as Frequency)}
                    items={(Object.keys(UNITS) as Frequency[]).map((f) => ({ id: f, label: UNITS[f] }))}
                >
                    {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                </Select>
            </div>
            {freq === "weekly" && basis === "scheduled" && (
                <div className="flex flex-col gap-1.5">
                    <p className="text-sm font-medium text-secondary">On</p>
                    <ButtonGroup
                        size="sm"
                        aria-label="Days of the week"
                        selectionMode="multiple"
                        selectedKeys={new Set(weekdays.map(String))}
                        onSelectionChange={(keys) => setWeekdays([...keys].map(Number))}
                        className="flex-wrap"
                    >
                        {WEEKDAYS.map((day, i) => (
                            <ButtonGroupItem key={day} id={String(i + 1)}>
                                {day}
                            </ButtonGroupItem>
                        ))}
                    </ButtonGroup>
                </div>
            )}
            {freq === "monthly" && (
                <RadioGroup aria-label="Day of the month" value={monthDay} onChange={(v) => setMonthDay(v as MonthChoice)}>
                    <RadioButton value="same" label={`On day ${day} (the last day in shorter months)`} />
                    <RadioButton value="last" label="On the last day of the month" />
                    {scheduledMonthly && week !== -1 && <RadioButton value="weekday" label={`On the ${ordinal} ${weekdayName}`} />}
                    {scheduledMonthly && <RadioButton value="lastWeekday" label={`On the last ${weekdayName}`} />}
                    {scheduledMonthly && <RadioButton value="lastWorkday" label="On the last weekday (Monday to Friday)" />}
                </RadioGroup>
            )}
            <RadioGroup aria-label="Count from" value={basis} onChange={(v) => setBasis(v as "scheduled" | "completion")}>
                <RadioButton value="scheduled" label="On a fixed schedule" hint="If it's done late, the next date stays on the schedule." />
                <RadioButton value="completion" label="After it's completed" hint="The next date counts from the day you complete it." />
            </RadioGroup>
            <RadioGroup aria-label="Ends" value={ends} onChange={(v) => setEnds(v as typeof ends)}>
                <RadioButton value="never" label="Never ends" />
                <RadioButton value="date" label="Ends on a date" />
                {basis === "scheduled" && <RadioButton value="count" label="Ends after a number of times" />}
            </RadioGroup>
            {ends === "date" && <DateMenu label="End date" value={until} onChange={setUntil} placeholder="Choose the end date" clearLabel="No end date" />}
            {ends === "count" && basis === "scheduled" && (
                <Input label="Times, including the first" type="number" size="sm" className="w-40" value={count} onChange={setCount} inputMode="numeric" />
            )}
        </PortalDialog>
    );
};
