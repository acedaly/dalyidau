// What each calendar view covers, and how its Previous/Next buttons move. Shared so the page the
// Worker loads and the page the browser shows always agree.
import { addDays, addMonthsToDate, endOfMonth, startOfMonth, startOfWeek } from "./time";
import type { CalendarView } from "./types";

export const AGENDA_DAYS = 30;

export function viewWindow(view: Exclude<CalendarView, "year">, anchor: string, weekStart: 0 | 1): { from: string; to: string } {
    switch (view) {
        case "day":
            return { from: anchor, to: anchor };
        case "week": {
            const from = startOfWeek(anchor, weekStart);
            return { from, to: addDays(from, 6) };
        }
        case "month": {
            const from = startOfWeek(startOfMonth(anchor), weekStart);
            const to = addDays(startOfWeek(endOfMonth(anchor), weekStart), 6);
            return { from, to };
        }
        case "agenda":
            return { from: anchor, to: addDays(anchor, AGENDA_DAYS - 1) };
    }
}

/** The anchor date one step back or forward. */
export function stepAnchor(view: Exclude<CalendarView, "year">, anchor: string, direction: -1 | 1): string {
    switch (view) {
        case "day":
            return addDays(anchor, direction);
        case "week":
            return addDays(anchor, 7 * direction);
        case "month":
            return addMonthsToDate(startOfMonth(anchor), direction);
        case "agenda":
            return addDays(anchor, AGENDA_DAYS * direction);
    }
}

export const isCalendarView = (value: unknown): value is Exclude<CalendarView, "year"> =>
    value === "day" || value === "week" || value === "month" || value === "agenda";
