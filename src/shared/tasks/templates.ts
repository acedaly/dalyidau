// Task templates: a task with a checklist that can be created again and again ("Holiday packing",
// "Monthly finances"). Validated with this schema in the browser and on the Worker. Using a template
// creates an ordinary, independent task and subtasks: later changes to the template don't touch
// tasks made from it, and the other way round.
import { z } from "zod";
import { isClockTime } from "./dates";
import { recurrenceInput } from "./recurrence";
import { LIMITS, MAX_DEPTH, type Priority } from "./types";

export interface ChecklistItem {
    title: string;
    children?: ChecklistItem[];
}

export const TEMPLATE_LIMITS = { name: 120, items: 100 };

const itemTitle = z
    .string()
    .transform((v) => v.replace(/\s+/g, " ").trim())
    .pipe(z.string().min(1, "Give each checklist item a title").max(LIMITS.title));

/** Subtasks of the template's task: at most three levels below it (like any task) and 100 in all. */
export const checklist: z.ZodType<ChecklistItem[]> = z.lazy(() =>
    z.array(z.object({ title: itemTitle, children: checklist.optional() }).strict()).max(TEMPLATE_LIMITS.items),
);

export const countItems = (items: ChecklistItem[]): number => items.reduce((n, item) => n + 1 + countItems(item.children ?? []), 0);
export const checklistDepth = (items: ChecklistItem[]): number => (items.length ? 1 + Math.max(...items.map((i) => checklistDepth(i.children ?? []))) : 0);

const id = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[a-z0-9]{14}$`), "Not a valid id");

export const templateInput = z
    .object({
        name: z.string().trim().min(1, "Name the template").max(TEMPLATE_LIMITS.name),
        title: itemTitle,
        description: z.string().max(LIMITS.description).default(""),
        priority: z.number().int().min(1).max(4).default(4),
        /** Where tasks made from it go unless chosen otherwise. */
        defaultProjectId: id("tpj").nullable().default(null),
        /** Share the template with a shared project's members; null keeps it private. */
        sharedProjectId: id("tpj").nullable().default(null),
        labels: z.array(z.string().trim().min(1).max(LIMITS.labelName)).max(LIMITS.labelsPerTask).default([]),
        /** Due this many days after the day it's used; null for no date. */
        dueOffsetDays: z.number().int().min(0).max(366).nullable().default(null),
        dueTime: z.string().refine(isClockTime, "Use a time like 09:30").nullable().default(null),
        recurrence: recurrenceInput.nullable().default(null),
        subtasks: checklist.default([]),
    })
    .strict()
    .superRefine((t, ctx) => {
        if (countItems(t.subtasks) > TEMPLATE_LIMITS.items)
            ctx.addIssue({ code: "custom", path: ["subtasks"], message: `At most ${TEMPLATE_LIMITS.items} checklist items` });
        if (checklistDepth(t.subtasks) > MAX_DEPTH)
            ctx.addIssue({ code: "custom", path: ["subtasks"], message: `Checklists nest at most ${MAX_DEPTH} levels deep` });
        if ((t.dueTime || t.recurrence) && t.dueOffsetDays === null)
            ctx.addIssue({ code: "custom", path: ["dueOffsetDays"], message: "A time or repeat needs a due date" });
    });
export type TemplateInput = z.input<typeof templateInput>;

export interface TaskTemplate {
    id: string;
    name: string;
    title: string;
    description: string;
    priority: Priority;
    defaultProjectId: string | null;
    sharedProjectId: string | null;
    labels: string[];
    dueOffsetDays: number | null;
    dueTime: string | null;
    recurrence: z.output<typeof recurrenceInput> | null;
    subtasks: ChecklistItem[];
    archived: boolean;
    /** Whether the caller can change it: the owner of a private one; editors of a shared one's project. */
    canEdit: boolean;
    owner: string;
    version: number;
    updatedAt: string;
}
