// Customising Today: which sections show and in what order, the timeline and calendar views, where
// the day starts, breaks, which calendars count towards availability, and how the briefing looks.
// Saved per person (migration 0024). Planning hours and buffers are their own document, opened from here.
import { useState } from "react";
import { ArrowDown, ArrowUp, Plus, Settings01, Trash01 } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Checkbox } from "@/components/base/checkbox/checkbox";
import { Input } from "@/components/base/input/input";
import { Select } from "@/components/base/select/select";
import { Toggle } from "@/components/base/toggle/toggle";
import { PortalDialog } from "@/portal/components/dialog";
import { useToast } from "@/portal/components/toast";
import { errorMessage } from "@/portal/lib/api";
import {
    START_VIEWS,
    START_VIEW_LABELS,
    TODAY_SECTIONS,
    TODAY_SECTION_LABELS,
    type TodayDashboard,
    type TodayPeriod,
    type TodayPreferences,
    type TodaySection,
} from "@/shared/today/types";
import { todayApi } from "./today-api";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const PeriodEditor = ({
    legend,
    hint,
    periods,
    onChange,
    fallbackLabel,
}: {
    legend: string;
    hint: string;
    periods: TodayPeriod[];
    onChange: (periods: TodayPeriod[]) => void;
    fallbackLabel: string;
}) => {
    const set = (i: number, change: Partial<TodayPeriod>) => onChange(periods.map((p, j) => (j === i ? { ...p, ...change } : p)));
    return (
        <fieldset className="flex flex-col gap-3">
            <legend className="text-sm font-medium text-secondary">{legend}</legend>
            <p className="text-sm text-tertiary">{hint}</p>
            {periods.map((p, i) => (
                <div key={i} className="flex flex-col gap-3 rounded-lg p-3 ring-1 ring-secondary ring-inset">
                    <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[1fr_8rem_8rem_auto]">
                        <Input size="sm" label="Name" placeholder={fallbackLabel} value={p.label} onChange={(v) => set(i, { label: v.slice(0, 60) })} />
                        <Input size="sm" type="time" label="From" value={p.start} onChange={(v) => v && set(i, { start: v })} />
                        <Input size="sm" type="time" label="Until" value={p.end} onChange={(v) => v && set(i, { end: v })} isInvalid={p.end <= p.start} />
                        <ButtonUtility
                            size="sm"
                            color="tertiary"
                            icon={Trash01}
                            tooltip={`Remove ${p.label || fallbackLabel}`}
                            onClick={() => onChange(periods.filter((_, j) => j !== i))}
                        />
                    </div>
                    <div role="group" aria-label={`Days for ${p.label || fallbackLabel}`} className="flex flex-wrap gap-3">
                        {DAYS.map((d, n) => (
                            <Checkbox
                                key={d}
                                size="sm"
                                label={d}
                                isSelected={p.days.includes(n + 1)}
                                onChange={(on) => set(i, { days: on ? [...p.days, n + 1].sort() : p.days.filter((x) => x !== n + 1) })}
                            />
                        ))}
                    </div>
                </div>
            ))}
            {periods.length < 10 && (
                <Button
                    size="sm"
                    color="secondary"
                    iconLeading={Plus}
                    className="self-start"
                    onClick={() =>
                        onChange([
                            ...periods,
                            {
                                label: "",
                                days: [1, 2, 3, 4, 5],
                                start: "12:30",
                                end: "13:00",
                            },
                        ])
                    }
                >
                    Add
                </Button>
            )}
        </fieldset>
    );
};

export const TodaySettingsDialog = ({
    isOpen,
    onOpenChange,
    data,
    onSaved,
    onOpenPlanning,
}: {
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
    data: Pick<TodayDashboard, "preferences" | "preferencesVersion" | "calendars">;
    onSaved: (preferences: TodayPreferences, version: number) => void;
    onOpenPlanning: () => void;
}) => {
    const toast = useToast();
    const [draft, setDraft] = useState<TodayPreferences>(data.preferences);
    const [busy, setBusy] = useState(false);
    const shown = draft.sections;
    const hidden = TODAY_SECTIONS.filter((s) => !shown.includes(s));
    const move = (s: TodaySection, by: -1 | 1) => {
        const i = shown.indexOf(s);
        const j = i + by;
        if (j < 0 || j >= shown.length) return;
        const next = [...shown];
        [next[i], next[j]] = [next[j], next[i]];
        setDraft({ ...draft, sections: next });
    };
    const invalid = draft.breaks.some((p) => p.end <= p.start || !p.days.length);
    const save = async () => {
        setBusy(true);
        try {
            const result = await todayApi.savePreferences(draft, data.preferencesVersion);
            onSaved(result.preferences, result.version);
            toast.success("Today settings saved");
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
            title="Customise Today"
            description="What Today shows and how it counts your time. Only you see these."
            icon={Settings01}
            size="xl"
            onSubmit={(e) => {
                e.preventDefault();
                if (!invalid) void save();
            }}
            footer={
                <>
                    <Button color="secondary" size="lg" onClick={() => onOpenChange(false)} isDisabled={busy}>
                        Cancel
                    </Button>
                    <Button type="submit" size="lg" isLoading={busy} isDisabled={invalid} showTextWhileLoading>
                        Save
                    </Button>
                </>
            }
        >
            <fieldset className="flex flex-col gap-2">
                <legend className="mb-1 text-sm font-medium text-secondary">Sections, in order</legend>
                <ul className="flex flex-col gap-1">
                    {shown.map((s, i) => (
                        <li key={s} className="flex items-center justify-between gap-2 rounded-lg px-3 py-1.5 ring-1 ring-secondary ring-inset">
                            <Checkbox
                                label={TODAY_SECTION_LABELS[s]}
                                isSelected
                                onChange={() => setDraft({ ...draft, sections: shown.filter((x) => x !== s) })}
                            />
                            <span className="flex gap-1">
                                <ButtonUtility
                                    size="xs"
                                    color="tertiary"
                                    icon={ArrowUp}
                                    tooltip={`Move ${TODAY_SECTION_LABELS[s]} up`}
                                    isDisabled={i === 0}
                                    onClick={() => move(s, -1)}
                                />
                                <ButtonUtility
                                    size="xs"
                                    color="tertiary"
                                    icon={ArrowDown}
                                    tooltip={`Move ${TODAY_SECTION_LABELS[s]} down`}
                                    isDisabled={i === shown.length - 1}
                                    onClick={() => move(s, 1)}
                                />
                            </span>
                        </li>
                    ))}
                    {hidden.map((s) => (
                        <li key={s} className="flex items-center rounded-lg px-3 py-1.5">
                            <Checkbox
                                label={TODAY_SECTION_LABELS[s]}
                                isSelected={false}
                                onChange={() => setDraft({ ...draft, sections: [...shown, s] })}
                                hint="Hidden"
                            />
                        </li>
                    ))}
                </ul>
            </fieldset>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Select
                    label="Start of the day"
                    hint="What Today opens with."
                    value={draft.startView}
                    onChange={(k) => k && setDraft({ ...draft, startView: k as TodayPreferences["startView"] })}
                    items={START_VIEWS.map((v) => ({ id: v, label: START_VIEW_LABELS[v] }))}
                >
                    {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                </Select>
                <Select
                    label="Timeline"
                    value={draft.timelineView}
                    onChange={(k) => k && setDraft({ ...draft, timelineView: k as TodayPreferences["timelineView"] })}
                    items={[
                        { id: "list", label: "List" },
                        { id: "grid", label: "Time grid (larger screens)" },
                    ]}
                >
                    {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                </Select>
                <Select
                    label="Open in Calendar as"
                    value={draft.calendarView}
                    onChange={(k) => k && setDraft({ ...draft, calendarView: k as TodayPreferences["calendarView"] })}
                    items={[
                        { id: "day", label: "Day" },
                        { id: "week", label: "Week" },
                        { id: "agenda", label: "Agenda" },
                    ]}
                >
                    {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                </Select>
                <Select
                    label="Briefing"
                    value={draft.briefing.detail}
                    onChange={(k) => k && setDraft({ ...draft, briefing: { ...draft.briefing, detail: k as "compact" | "full" } })}
                    items={[
                        { id: "full", label: "Every fact" },
                        { id: "compact", label: "Next actions and capacity" },
                    ]}
                >
                    {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                </Select>
                <Select
                    label="Shared commitments for"
                    value={String(draft.briefing.lookaheadDays)}
                    onChange={(k) => k && setDraft({ ...draft, briefing: { ...draft.briefing, lookaheadDays: Number(k) } })}
                    items={[1, 3, 7, 14].map((n) => ({ id: String(n), label: n === 1 ? "Today only" : `${n} days` }))}
                >
                    {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                </Select>
            </div>
            <Toggle
                label="Offer Daly Intelligence's explanation"
                hint="Only when Intelligence is switched on. It explains your records and never adds anything."
                isSelected={draft.briefing.ai}
                onChange={(v) => setDraft({ ...draft, briefing: { ...draft.briefing, ai: v } })}
            />

            <fieldset className="flex flex-col gap-2">
                <legend className="mb-1 text-sm font-medium text-secondary">Calendars that count towards availability</legend>
                <p className="text-sm text-tertiary">Events in a calendar you untick still show on Today, marked, but don't take time from your capacity.</p>
                {data.calendars.map((c) => (
                    <Checkbox
                        key={c.id}
                        label={c.name}
                        hint={c.kind === "shared" ? "Shared" : c.kind === "subscription" ? "Subscribed" : "Personal"}
                        isSelected={!draft.excludedCalendarIds.includes(c.id)}
                        onChange={(on) =>
                            setDraft({
                                ...draft,
                                excludedCalendarIds: on ? draft.excludedCalendarIds.filter((x) => x !== c.id) : [...draft.excludedCalendarIds, c.id],
                            })
                        }
                    />
                ))}
            </fieldset>

            <PeriodEditor
                legend="Breaks"
                hint="Taken out of your planning hours."
                periods={draft.breaks}
                onChange={(breaks) => setDraft({ ...draft, breaks })}
                fallbackLabel="Lunch"
            />
            <Button size="sm" color="link-color" className="self-start" onClick={onOpenPlanning}>
                Planning hours and buffers
            </Button>
        </PortalDialog>
    );
};
