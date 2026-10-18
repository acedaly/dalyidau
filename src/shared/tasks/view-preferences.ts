// How each person likes their own lists: sort, grouping, priority/project filters and the Upcoming
// layout. Stored per person and view (task_view_preferences), validated with this schema in the
// browser and again on the Worker, and never shared with anyone. A stored value that no longer
// parses is treated as the defaults.
import { z } from "zod";
import { addDays, isCalendarDate, weekStart } from "./dates";
import { ASSIGNEE_FILTERS, type TaskFilter, taskFilter } from "./filters";
import { daysInMonth } from "./recurrence";

export const VIEW_KEYS = ["mine", "today", "upcoming", "overdue", "inbox"] as const;
export type ViewKey = (typeof VIEW_KEYS)[number];

export const LIST_SORTS = ["due", "priority", "project", "created", "manual"] as const;
export type ListSort = (typeof LIST_SORTS)[number];
export const LIST_SORT_LABELS: Record<ListSort, string> = {
    due: "Due date",
    priority: "Priority",
    project: "Project",
    created: "Newest first",
    manual: "Project order",
};

export const LIST_GROUPS = ["none", "date", "project", "priority"] as const;
export type ListGroup = (typeof LIST_GROUPS)[number];
export const LIST_GROUP_LABELS: Record<ListGroup, string> = { none: "No grouping", date: "Due date", project: "Project", priority: "Priority" };

export const UPCOMING_MODES = ["agenda", "week", "month"] as const;
export type UpcomingMode = (typeof UPCOMING_MODES)[number];

const id = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[a-z0-9]{14}$`));

export const viewPreferences = z
    .object({
        sort: z.enum(LIST_SORTS).optional(),
        group: z.enum(LIST_GROUPS).optional(),
        priorities: z.array(z.number().int().min(1).max(4)).max(4).optional(),
        projectIds: z.array(id("tpj")).max(50).optional(),
        sectionIds: z.array(id("tsc")).max(50).optional(),
        assignee: z.enum(ASSIGNEE_FILTERS).optional(),
        mode: z.enum(UPCOMING_MODES).optional(),
    })
    .strict();
export type ViewPreferences = z.output<typeof viewPreferences>;

export type ViewPreferenceMap = Partial<Record<ViewKey, ViewPreferences>>;

/** A stored value, re-validated as it's read; anything that no longer parses is the defaults. */
export const parseViewPreferences = (json: string | null): ViewPreferences => {
    if (!json) return {};
    try {
        const parsed = viewPreferences.safeParse(JSON.parse(json));
        return parsed.success ? parsed.data : {};
    } catch {
        return {};
    }
};

/** My Tasks as a filter: open tasks the caller is responsible for (by default), narrowed by their choices. */
export const mineFilter = (prefs: ViewPreferences): TaskFilter =>
    taskFilter.parse({
        projectIds: prefs.projectIds ?? [],
        sectionIds: prefs.projectIds?.length ? (prefs.sectionIds ?? []) : [],
        priorities: prefs.priorities ?? [],
        assignee: prefs.assignee ?? "mine",
        status: "open",
        sort: prefs.sort === "project" ? "manual" : (prefs.sort ?? "due"),
    });

/**
 * The dates Upcoming shows. The agenda is a fortnight from today (or a later start). A week runs
 * Monday to Sunday and a month from its 1st, so either can include days already past; neither can
 * start before the current week or month.
 */
export function upcomingWindow(mode: UpcomingMode, fromParam: string | null, today: string): { from: string; days: number } {
    const base = isCalendarDate(fromParam) ? fromParam : today;
    switch (mode) {
        case "week": {
            const from = weekStart(base) < weekStart(today) ? weekStart(today) : weekStart(base);
            return { from, days: 7 };
        }
        case "month": {
            const first = (date: string) => `${date.slice(0, 7)}-01`;
            const from = first(base) < first(today) ? first(today) : first(base);
            return { from, days: daysInMonth(Number(from.slice(0, 4)), Number(from.slice(5, 7))) };
        }
        default:
            return { from: base > today ? base : today, days: 14 };
    }
}

/** The start of the window before or after this one, for the Earlier/Later buttons. */
export function shiftWindow(mode: UpcomingMode, from: string, days: number, direction: -1 | 1): string {
    if (mode !== "month") return addDays(from, direction * days);
    const [y, m] = from.split("-").map(Number);
    const index = y * 12 + (m - 1) + direction;
    return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}-01`;
}
