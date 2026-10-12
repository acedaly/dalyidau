// A month grid for dated items (tasks, timeline). Untitled UI's calendar is a date picker, not an
// agenda view, so this is a custom component using the same tokens, radii and focus styles.
import { useState } from "react";
import { ChevronLeft, ChevronRight } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { cx } from "@/utils/cx";

export interface CalendarItem {
    id: string;
    date: string; // YYYY-MM-DD
    label: string;
    tone?: "default" | "done" | "overdue";
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const monthLabel = (year: number, month: number) =>
    new Intl.DateTimeFormat("en-AU", { month: "long", year: "numeric", timeZone: "UTC" }).format(Date.UTC(year, month, 1));
const iso = (year: number, month: number, day: number) => `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

interface MonthCalendarProps {
    items: CalendarItem[];
    today: string;
    onSelect: (id: string) => void;
}

export const MonthCalendar = ({ items, today, onSelect }: MonthCalendarProps) => {
    const [cursor, setCursor] = useState(() => ({ year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) - 1 }));
    const first = new Date(Date.UTC(cursor.year, cursor.month, 1));
    const lead = (first.getUTCDay() + 6) % 7; // Monday first
    const days = new Date(Date.UTC(cursor.year, cursor.month + 1, 0)).getUTCDate();
    const cells = Array.from({ length: Math.ceil((lead + days) / 7) * 7 }, (_, i) => i - lead + 1);
    const byDate = new Map<string, CalendarItem[]>();
    for (const item of items) byDate.set(item.date, [...(byDate.get(item.date) ?? []), item]);

    const shift = (delta: number) =>
        setCursor(({ year, month }) => ({ year: month + delta < 0 ? year - 1 : month + delta > 11 ? year + 1 : year, month: (month + delta + 12) % 12 }));

    return (
        <div className="overflow-hidden rounded-xl bg-primary shadow-xs ring-1 ring-secondary">
            <div className="flex items-center justify-between gap-3 border-b border-secondary px-4 py-3 md:px-6">
                <h2 className="text-md font-semibold text-primary" aria-live="polite">
                    {monthLabel(cursor.year, cursor.month)}
                </h2>
                <div className="flex items-center gap-1">
                    <ButtonUtility size="sm" color="tertiary" icon={ChevronLeft} tooltip="Previous month" onClick={() => shift(-1)} />
                    <Button size="sm" color="secondary" onClick={() => setCursor({ year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) - 1 })}>
                        Today
                    </Button>
                    <ButtonUtility size="sm" color="tertiary" icon={ChevronRight} tooltip="Next month" onClick={() => shift(1)} />
                </div>
            </div>
            <div className="grid grid-cols-7 border-b border-secondary bg-secondary text-center text-xs font-semibold text-quaternary" aria-hidden="true">
                {WEEKDAYS.map((d) => (
                    <div key={d} className="py-2">
                        {d}
                    </div>
                ))}
            </div>
            <ol className="grid grid-cols-7">
                {cells.map((day, i) => {
                    const inMonth = day >= 1 && day <= days;
                    const date = inMonth ? iso(cursor.year, cursor.month, day) : "";
                    const dayItems = inMonth ? (byDate.get(date) ?? []) : [];
                    return (
                        <li
                            key={i}
                            className={cx(
                                "min-h-20 border-r border-b border-secondary p-1.5 text-left md:min-h-28 md:p-2 [&:nth-child(7n)]:border-r-0",
                                !inMonth && "bg-secondary",
                            )}
                            aria-label={inMonth ? `${date}: ${dayItems.length ? dayItems.map((d) => d.label).join(", ") : "nothing due"}` : undefined}
                        >
                            {inMonth && (
                                <>
                                    <span
                                        className={cx(
                                            "inline-flex size-6 items-center justify-center rounded-full text-xs font-medium",
                                            date === today ? "bg-brand-solid text-white" : "text-tertiary",
                                        )}
                                    >
                                        {day}
                                    </span>
                                    <ul className="mt-1 flex flex-col gap-1">
                                        {dayItems.slice(0, 3).map((item) => (
                                            <li key={item.id}>
                                                <button
                                                    type="button"
                                                    onClick={() => onSelect(item.id)}
                                                    className={cx(
                                                        "w-full cursor-pointer truncate rounded-md px-1.5 py-0.5 text-left text-xs font-medium outline-focus-ring focus-visible:outline-2",
                                                        item.tone === "done" && "bg-secondary text-quaternary line-through",
                                                        item.tone === "overdue" && "bg-error-primary text-error-primary",
                                                        (!item.tone || item.tone === "default") && "bg-brand-primary text-brand-secondary",
                                                    )}
                                                >
                                                    {item.label}
                                                </button>
                                            </li>
                                        ))}
                                        {dayItems.length > 3 && <li className="px-1.5 text-xs text-tertiary">+{dayItems.length - 3} more</li>}
                                    </ul>
                                </>
                            )}
                        </li>
                    );
                })}
            </ol>
        </div>
    );
};
