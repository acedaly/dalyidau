// Filters for Tasks: a fixed set of fields, validated with the same schema in the browser and on
// the Worker. A saved filter stores only this shape. The Worker turns it into parameterised SQL
// that is always limited to the caller's own projects (worker/tasks/views.ts); nothing here is
// ever SQL, a column name or an expression.
import { z } from "zod";

export const DUE_FILTERS = ["any", "overdue", "today", "next7", "next30", "scheduled", "none"] as const;
export const DEADLINE_FILTERS = ["any", "overdue", "next7", "has", "none"] as const;
export const ASSIGNEE_FILTERS = ["anyone", "mine", "me", "unassigned", "others"] as const;
export type AssigneeFilter = (typeof ASSIGNEE_FILTERS)[number];
export const STATUS_FILTERS = ["open", "completed", "all"] as const;
export const SCOPE_FILTERS = ["all", "personal", "shared"] as const;
export const SORTS = ["due", "priority", "created", "updated", "title", "manual"] as const;

export const DUE_LABELS: Record<(typeof DUE_FILTERS)[number], string> = {
    any: "Any date",
    overdue: "Overdue",
    today: "Due today",
    next7: "Next 7 days",
    next30: "Next 30 days",
    scheduled: "Has a date",
    none: "No date",
};
export const DEADLINE_LABELS: Record<(typeof DEADLINE_FILTERS)[number], string> = {
    any: "Any deadline",
    overdue: "Deadline passed",
    next7: "Deadline in 7 days",
    has: "Has a deadline",
    none: "No deadline",
};
export const ASSIGNEE_LABELS: Record<(typeof ASSIGNEE_FILTERS)[number], string> = {
    anyone: "Anyone",
    mine: "Me or nobody",
    me: "Assigned to me",
    unassigned: "Unassigned",
    others: "Assigned to others",
};
export const STATUS_LABELS: Record<(typeof STATUS_FILTERS)[number], string> = { open: "Open", completed: "Completed", all: "Open and completed" };
export const SCOPE_LABELS: Record<(typeof SCOPE_FILTERS)[number], string> = { all: "Personal and shared", personal: "Personal only", shared: "Shared only" };
export const SORT_LABELS: Record<(typeof SORTS)[number], string> = {
    due: "Due date",
    priority: "Priority",
    created: "Newest",
    updated: "Recently changed",
    title: "Title",
    manual: "Project order",
};

const id = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[a-z0-9]{14}$`), "Not a valid id");

export const taskFilter = z
    .object({
        projectIds: z.array(id("tpj")).max(50).default([]),
        /** Sections of the chosen projects; tasks outside every chosen section are left out. */
        sectionIds: z.array(id("tsc")).max(50).default([]),
        labels: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
        labelMode: z.enum(["any", "all"]).default("any"),
        priorities: z.array(z.number().int().min(1).max(4)).max(4).default([]),
        due: z.enum(DUE_FILTERS).default("any"),
        deadline: z.enum(DEADLINE_FILTERS).default("any"),
        assignee: z.enum(ASSIGNEE_FILTERS).default("anyone"),
        status: z.enum(STATUS_FILTERS).default("open"),
        scope: z.enum(SCOPE_FILTERS).default("all"),
        text: z.string().trim().max(200).default(""),
        sort: z.enum(SORTS).default("due"),
    })
    .strict();

export type TaskFilter = z.output<typeof taskFilter>;
export type TaskFilterInput = z.input<typeof taskFilter>;

export const EMPTY_FILTER: TaskFilter = taskFilter.parse({});

/** Reads a filter from URL parameters; anything invalid falls back to its default. */
export function filterFromParams(params: URLSearchParams): TaskFilter {
    const list = (key: string) =>
        (params.get(key) ?? "")
            .split(",")
            .map((v) => v.trim())
            .filter(Boolean);
    const candidate: Record<string, unknown> = {
        projectIds: list("projects"),
        sectionIds: list("sections"),
        labels: list("labels"),
        labelMode: params.get("labelMode") ?? undefined,
        priorities: list("priorities").map(Number),
        due: params.get("due") ?? undefined,
        deadline: params.get("deadline") ?? undefined,
        assignee: params.get("assignee") ?? undefined,
        status: params.get("status") ?? undefined,
        scope: params.get("scope") ?? undefined,
        text: params.get("text") ?? undefined,
        sort: params.get("sort") ?? undefined,
    };
    // Field by field, so one bad value doesn't discard the rest.
    const out: Record<string, unknown> = {};
    const shape = taskFilter.shape;
    for (const [key, value] of Object.entries(candidate)) {
        const parsed = shape[key as keyof typeof shape].safeParse(value);
        if (parsed.success) out[key] = parsed.data;
    }
    return taskFilter.parse(out);
}

/** URL parameters for a filter, leaving out defaults. */
export function filterToParams(filter: TaskFilter): URLSearchParams {
    const params = new URLSearchParams();
    const set = (key: string, value: string, fallback: string) => value !== fallback && params.set(key, value);
    if (filter.projectIds.length) params.set("projects", filter.projectIds.join(","));
    if (filter.sectionIds.length) params.set("sections", filter.sectionIds.join(","));
    if (filter.labels.length) params.set("labels", filter.labels.join(","));
    set("labelMode", filter.labelMode, "any");
    if (filter.priorities.length) params.set("priorities", filter.priorities.join(","));
    set("due", filter.due, "any");
    set("deadline", filter.deadline, "any");
    set("assignee", filter.assignee, "anyone");
    set("status", filter.status, "open");
    set("scope", filter.scope, "all");
    if (filter.text) params.set("text", filter.text);
    set("sort", filter.sort, "due");
    return params;
}

/** One-line summary for saved filter lists: "P1, P2 · Overdue · @errands". */
export function describeFilter(filter: TaskFilter, projectName: (id: string) => string | undefined = () => undefined): string {
    const parts: string[] = [];
    if (filter.projectIds.length) parts.push(filter.projectIds.map((id) => projectName(id) ?? "A project").join(", "));
    if (filter.sectionIds.length) parts.push(`${filter.sectionIds.length} section${filter.sectionIds.length === 1 ? "" : "s"}`);
    if (filter.priorities.length)
        parts.push(
            [...filter.priorities]
                .sort()
                .map((p) => `P${p}`)
                .join(", "),
        );
    if (filter.due !== "any") parts.push(DUE_LABELS[filter.due]);
    if (filter.deadline !== "any") parts.push(DEADLINE_LABELS[filter.deadline]);
    if (filter.labels.length) parts.push(filter.labels.map((l) => `@${l}`).join(filter.labelMode === "all" ? " + " : ", "));
    if (filter.assignee !== "anyone") parts.push(ASSIGNEE_LABELS[filter.assignee]);
    if (filter.status !== "open") parts.push(STATUS_LABELS[filter.status]);
    if (filter.scope !== "all") parts.push(SCOPE_LABELS[filter.scope]);
    if (filter.text) parts.push(`“${filter.text}”`);
    return parts.join(" · ") || "All open tasks";
}
