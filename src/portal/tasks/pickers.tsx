// Pickers for Quick Add and the task panel, built from Untitled UI PRO parts: a date menu (presets
// plus the PRO calendar), priority, project, section and assignee selects, and a label picker laid
// out like the PRO "labels" slideout (search, checkbox badges, create).
import { useState } from "react";
import { type CalendarDate, parseDate } from "@internationalized/date";
import { Calendar as CalendarIcon, Flag01, Plus, Tag01, User01, XClose } from "@untitledui/icons";
import { Checkbox as AriaCheckbox, Dialog as AriaDialog, DialogTrigger as AriaDialogTrigger, Popover as AriaPopover } from "react-aria-components";
import { Calendar } from "@/components/application/date-picker/calendar";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { CheckboxBase } from "@/components/base/checkbox/checkbox";
import { Input } from "@/components/base/input/input";
import { Select } from "@/components/base/select/select";
import { addDays, clockLabel, relativeDate, shortDate } from "@/shared/tasks/dates";
import { isoWeekday } from "@/shared/tasks/recurrence";
import { PRIORITIES, PRIORITY_LABELS, type Priority, type TaskLabel } from "@/shared/tasks/types";
import { cx } from "@/utils/cx";
import { PRIORITY_COLORS, ProjectDot, personLabel } from "./shared";
import { useTasks } from "./tasks-context";

const popoverClass = ({ isEntering, isExiting }: { isEntering: boolean; isExiting: boolean }) =>
    cx(
        "origin-(--trigger-anchor-point) rounded-2xl bg-primary shadow-xl ring ring-secondary_alt outline-hidden will-change-transform",
        isEntering && "duration-150 ease-out animate-in fade-in placement-bottom:slide-in-from-top-0.5",
        isExiting && "duration-100 ease-in animate-out fade-out",
    );

const toCalendar = (value: string | null): CalendarDate | null => {
    try {
        return value ? parseDate(value) : null;
    } catch {
        return null;
    }
};

interface DateMenuProps {
    label: string;
    value: string | null;
    time?: string | null;
    onChange: (value: string | null) => void;
    /** Text on the button when there's no date. */
    placeholder?: string;
    isDisabled?: boolean;
    /** Removing a repeating task's date also stops it repeating; the caller decides. */
    clearLabel?: string;
    icon?: typeof CalendarIcon;
}

/** A date button that opens presets (Today, Tomorrow, This weekend, Next week) and a calendar. */
export const DateMenu = ({ label, value, time, onChange, placeholder = "No date", isDisabled, clearLabel = "No date", icon = CalendarIcon }: DateMenuProps) => {
    const { today } = useTasks();
    const weekend = addDays(today, (6 - isoWeekday(today) + 7) % 7 || 7);
    const nextMonday = addDays(today, 8 - isoWeekday(today));
    const presets = [
        { label: "Today", date: today },
        { label: "Tomorrow", date: addDays(today, 1) },
        { label: "This weekend", date: weekend },
        { label: "Next week", date: nextMonday },
    ];
    const text = value ? `${relativeDate(value, today)}${time ? ` ${clockLabel(time)}` : ""}` : placeholder;
    return (
        <AriaDialogTrigger>
            <Button size="sm" color="secondary" iconLeading={icon} isDisabled={isDisabled} aria-label={`${label}: ${value ? shortDate(value) : placeholder}`}>
                <span className={cx(value && value < today && "text-error-primary")}>{text}</span>
            </Button>
            <AriaPopover offset={8} placement="bottom start" className={popoverClass}>
                <AriaDialog aria-label={label} className="outline-hidden">
                    {({ close }) => (
                        <div className="flex max-w-[calc(100vw-2rem)] flex-col">
                            <ul className="flex flex-col p-2">
                                {presets.map((preset) => (
                                    <li key={preset.label}>
                                        <button
                                            type="button"
                                            onClick={() => (onChange(preset.date), close())}
                                            className="flex w-full cursor-pointer items-center justify-between gap-6 rounded-md px-2.5 py-2 text-left text-sm font-medium text-secondary outline-focus-ring hover:bg-primary_hover focus-visible:outline-2"
                                        >
                                            {preset.label}
                                            <span className="text-xs font-normal text-tertiary">{shortDate(preset.date)}</span>
                                        </button>
                                    </li>
                                ))}
                                {value && (
                                    <li>
                                        <button
                                            type="button"
                                            onClick={() => (onChange(null), close())}
                                            className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm font-medium text-secondary outline-focus-ring hover:bg-primary_hover focus-visible:outline-2"
                                        >
                                            <XClose aria-hidden="true" className="size-4 text-fg-quaternary" />
                                            {clearLabel}
                                        </button>
                                    </li>
                                )}
                            </ul>
                            <div className="border-t border-secondary px-4 py-4 sm:px-5">
                                <Calendar
                                    aria-label={label}
                                    value={toCalendar(value)}
                                    onChange={(next) => {
                                        if (next) onChange(next.toString());
                                        close();
                                    }}
                                >
                                    <span />
                                </Calendar>
                            </div>
                        </div>
                    )}
                </AriaDialog>
            </AriaPopover>
        </AriaDialogTrigger>
    );
};

export const PriorityPicker = ({
    value,
    onChange,
    isDisabled,
    label = "Priority",
}: {
    value: Priority;
    onChange: (p: Priority) => void;
    isDisabled?: boolean;
    label?: string;
}) => (
    <Select
        aria-label={label}
        size="sm"
        className="w-36"
        isDisabled={isDisabled}
        value={String(value)}
        onChange={(key) => key && onChange(Number(key) as Priority)}
        items={PRIORITIES.map((p) => ({
            id: String(p),
            label: `${PRIORITY_LABELS[p].short} ${PRIORITY_LABELS[p].label}`,
            icon: <Flag01 data-icon aria-hidden="true" className={cx("size-4", PRIORITY_COLORS[p].text)} />,
        }))}
    >
        {(item) => (
            <Select.Item id={item.id} icon={item.icon}>
                {item.label}
            </Select.Item>
        )}
    </Select>
);

export const ProjectPicker = ({
    value,
    onChange,
    isDisabled,
    label = "Project",
    className,
}: {
    value: string;
    onChange: (id: string) => void;
    isDisabled?: boolean;
    label?: string;
    className?: string;
}) => {
    const { writable, project } = useTasks();
    const current = project(value);
    const options = current && !writable.some((p) => p.id === current.id) ? [current, ...writable] : writable;
    return (
        <Select
            aria-label={label}
            size="sm"
            className={cx("w-full sm:w-48", className)}
            isDisabled={isDisabled}
            value={value}
            onChange={(key) => key && onChange(String(key))}
            items={options.map((p) => ({
                id: p.id,
                label: p.name,
                supportingText: p.kind === "shared" ? "Shared" : undefined,
                icon: <ProjectDot color={p.color} className="mx-1" />,
            }))}
        >
            {(item) => (
                <Select.Item id={item.id} icon={item.icon} supportingText={item.supportingText}>
                    {item.label}
                </Select.Item>
            )}
        </Select>
    );
};

const NO_SECTION = "__none";

export const SectionPicker = ({
    projectId,
    value,
    onChange,
    isDisabled,
}: {
    projectId: string;
    value: string | null;
    onChange: (id: string | null) => void;
    isDisabled?: boolean;
}) => {
    const { sections } = useTasks();
    const list = sections(projectId);
    if (!list.length) return null;
    return (
        <Select
            aria-label="Section"
            size="sm"
            className="w-full sm:w-44"
            isDisabled={isDisabled}
            value={value ?? NO_SECTION}
            onChange={(key) => onChange(key === NO_SECTION || key === null ? null : String(key))}
            items={[{ id: NO_SECTION, label: "No section" }, ...list.map((s) => ({ id: s.id, label: s.name }))]}
        >
            {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
        </Select>
    );
};

const NOBODY = "__nobody";

export const AssigneePicker = ({
    projectId,
    value,
    onChange,
    isDisabled,
}: {
    projectId: string;
    value: string | null;
    onChange: (email: string | null) => void;
    isDisabled?: boolean;
}) => {
    const { assignable } = useTasks();
    const people = assignable(projectId);
    if (!people.length) return null;
    return (
        <Select
            aria-label="Assignee"
            size="sm"
            className="w-full sm:w-44"
            icon={User01}
            isDisabled={isDisabled}
            value={value ?? NOBODY}
            onChange={(key) => onChange(key === NOBODY || key === null ? null : String(key))}
            items={[
                { id: NOBODY, label: "Unassigned" },
                ...people.map((p) => ({ id: p.email, label: personLabel(p.email, people), supportingText: p.name ? p.email : undefined })),
            ]}
        >
            {(item) => (
                <Select.Item id={item.id} supportingText={item.supportingText}>
                    {item.label}
                </Select.Item>
            )}
        </Select>
    );
};

/**
 * Labels for a task: the person's own labels as checkbox badges (like Untitled UI's labels menu),
 * a search box that filters them, and "Create" for a new one.
 */
export const LabelPicker = ({ value, onChange, isDisabled }: { value: string[]; onChange: (labels: string[]) => void; isDisabled?: boolean }) => {
    const { labels } = useTasks();
    const [query, setQuery] = useState("");
    const known: Pick<TaskLabel, "name" | "color">[] = [...labels];
    for (const name of value) if (!known.some((l) => l.name.toLowerCase() === name.toLowerCase())) known.push({ name, color: "gray" });
    const q = query.trim().replace(/^@/, "");
    const shown = known.filter((l) => !q || l.name.toLowerCase().includes(q.toLowerCase()));
    const has = (name: string) => value.some((v) => v.toLowerCase() === name.toLowerCase());
    const toggle = (name: string, on: boolean) => onChange(on ? [...value, name] : value.filter((v) => v.toLowerCase() !== name.toLowerCase()));
    const canCreate = q && !known.some((l) => l.name.toLowerCase() === q.toLowerCase());

    return (
        <AriaDialogTrigger>
            <Button size="sm" color="secondary" iconLeading={Tag01} isDisabled={isDisabled} aria-label={`Labels: ${value.length ? value.join(", ") : "none"}`}>
                {value.length ? value.map((v) => `@${v}`).join(" ") : "Labels"}
            </Button>
            <AriaPopover offset={8} placement="bottom start" className={popoverClass}>
                <AriaDialog aria-label="Labels" className="flex w-72 max-w-[calc(100vw-2rem)] flex-col gap-3 p-4 outline-hidden">
                    <Input
                        aria-label="Find or create a label"
                        size="sm"
                        placeholder="Find or create a label"
                        value={query}
                        onChange={setQuery}
                        autoFocus
                        onKeyDown={(event) => {
                            if (event.key === "Enter" && canCreate) {
                                event.preventDefault();
                                toggle(q, true);
                                setQuery("");
                            } else event.continuePropagation();
                        }}
                    />
                    <div className="flex max-h-64 flex-col items-start gap-3 overflow-y-auto pl-1">
                        {shown.map((label) => (
                            <AriaCheckbox
                                key={label.name}
                                isSelected={has(label.name)}
                                onChange={(on) => toggle(label.name, on)}
                                className={(state) => cx("flex cursor-pointer items-center gap-2", state.isDisabled && "cursor-not-allowed")}
                            >
                                {({ isSelected, isDisabled: disabled, isFocusVisible }) => (
                                    <>
                                        <CheckboxBase isSelected={isSelected} isDisabled={disabled} isFocusVisible={isFocusVisible} />
                                        <Badge size="md" type="pill-color" color={label.color}>
                                            {label.name}
                                        </Badge>
                                    </>
                                )}
                            </AriaCheckbox>
                        ))}
                        {!shown.length && !canCreate && <p className="text-sm text-tertiary">No labels yet. Type a name to create one.</p>}
                    </div>
                    {canCreate && (
                        <Button
                            size="sm"
                            color="link-color"
                            iconLeading={Plus}
                            className="self-start"
                            onClick={() => {
                                toggle(q, true);
                                setQuery("");
                            }}
                        >
                            Create “{q}”
                        </Button>
                    )}
                </AriaDialog>
            </AriaPopover>
        </AriaDialogTrigger>
    );
};
