// Rescheduling one task, from any list, the calendar or the keyboard ("s"): quick choices, a
// calendar, or no date. A repeating task asks whether the change is for this occurrence only (the
// default: the series stays where it was) or for the series from here on. A later occurrence shown
// in Upcoming or the calendar (a projected repeat) can be moved or skipped on its own, leaving the
// rest of the series alone. Deadlines never move with the scheduled date.
import { useState } from "react";
import { type CalendarDate, parseDate } from "@internationalized/date";
import { CalendarDate as CalendarDateIcon } from "@untitledui/icons";
import { Calendar } from "@/components/application/date-picker/calendar";
import { Button } from "@/components/base/buttons/button";
import { RadioButton, RadioGroup } from "@/components/base/radio-buttons/radio-buttons";
import { PortalDialog } from "@/portal/components/dialog";
import { addDays, shortDate } from "@/shared/tasks/dates";
import { describeRule, isoWeekday } from "@/shared/tasks/recurrence";
import type { TaskSummary } from "@/shared/tasks/types";
import { titleOf } from "./shared";
import { useTasks } from "./tasks-context";

export type RescheduleChoice =
    | { kind: "date"; date: string | null; scope: "occurrence" | "series" }
    | { kind: "occurrence"; action: "move"; to: string }
    | { kind: "occurrence"; action: "skip" };

const toCalendar = (value: string | null): CalendarDate | null => {
    try {
        return value ? parseDate(value) : null;
    } catch {
        return null;
    }
};

export const RescheduleDialog = ({ task, onClose, onChoose }: { task: TaskSummary; onClose: () => void; onChoose: (choice: RescheduleChoice) => void }) => {
    const { today } = useTasks();
    const [date, setDate] = useState<string | null>(task.dueDate);
    const [scope, setScope] = useState<"occurrence" | "series">("occurrence");
    const projected = !!task.projected && !!task.seriesDate;
    const repeating = !!task.recurrence && !projected;
    const nextMonday = addDays(today, 8 - isoWeekday(today));
    const weekend = addDays(today, (6 - isoWeekday(today) + 7) % 7 || 7);
    const presets = [
        { label: "Today", date: today },
        { label: "Tomorrow", date: addDays(today, 1) },
        { label: "This weekend", date: weekend },
        { label: "Next week", date: nextMonday },
        ...(task.dueDate
            ? [
                  { label: "A day later", date: addDays(task.dueDate, 1) },
                  { label: "A week later", date: addDays(task.dueDate, 7) },
              ]
            : []),
    ];
    const submit = () => {
        if (projected) onChoose(date ? { kind: "occurrence", action: "move", to: date } : { kind: "occurrence", action: "skip" });
        else onChoose({ kind: "date", date, scope: repeating ? scope : "occurrence" });
        onClose();
    };
    const unchanged = date === task.dueDate && (!repeating || scope === "occurrence");

    return (
        <PortalDialog
            isOpen
            onOpenChange={(open) => !open && onClose()}
            title={projected ? "Change this occurrence" : "Reschedule"}
            icon={CalendarDateIcon}
            description={
                <>
                    <span className="font-medium text-secondary">{titleOf(task.title)}</span>
                    {task.recurrence && <span> · {describeRule(task.recurrence)}</span>}
                    {task.deadline && <span> · the deadline ({shortDate(task.deadline)}) stays as it is</span>}
                </>
            }
            onSubmit={submit}
            footer={
                <>
                    {projected ? (
                        <Button color="secondary-destructive" size="md" onClick={() => (onChoose({ kind: "occurrence", action: "skip" }), onClose())}>
                            Skip this occurrence
                        </Button>
                    ) : (
                        !repeating &&
                        task.dueDate && (
                            <Button color="secondary" size="md" onClick={() => (onChoose({ kind: "date", date: null, scope: "occurrence" }), onClose())}>
                                Remove the date
                            </Button>
                        )
                    )}
                    <Button type="submit" size="md" isDisabled={unchanged || (projected && !date)}>
                        {date ? `Move to ${shortDate(date)}` : "Save"}
                    </Button>
                </>
            }
        >
            <div className="flex flex-wrap gap-2">
                {presets.map((p) => (
                    <Button
                        key={p.label}
                        size="sm"
                        color={date === p.date ? "primary" : "secondary"}
                        onClick={() => setDate(p.date)}
                        aria-pressed={date === p.date}
                    >
                        {p.label}
                    </Button>
                ))}
            </div>
            <div className="self-center">
                <Calendar aria-label="Date" value={toCalendar(date)} onChange={(next) => next && setDate(next.toString())}>
                    <span />
                </Calendar>
            </div>
            {repeating && (
                <RadioGroup aria-label="Which occurrences" value={scope} onChange={(v) => setScope(v as "occurrence" | "series")}>
                    <RadioButton value="occurrence" label="Only this occurrence" hint="The series carries on as before." />
                    <RadioButton value="series" label="This and later occurrences" hint="The repeat moves to follow the new date." />
                </RadioGroup>
            )}
            {projected && <p className="text-sm text-tertiary">Only the occurrence on {shortDate(task.seriesDate!)} changes; the rest of the series stays.</p>}
        </PortalDialog>
    );
};
