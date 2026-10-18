// What every MCP tool has in common: its definition, the caller's context, input pieces and the
// compact shapes records are returned in. Results are bounded: lists carry a count and say when
// they were cut short, so an AI client never mistakes a partial list for the whole of something.
import type { D1Database } from "@cloudflare/workers-types";
import { z } from "zod";
import type { Permission } from "../../src/shared/portal/permissions";
import type { PortalUser } from "../../src/shared/portal/types";
import type { TaskSummary } from "../../src/shared/tasks/types";
import type { Env } from "../env";
import { placeholders } from "../portal/db";
import type { WriteOutcome } from "./ledger";

export interface ToolContext {
    env: Env;
    db: D1Database;
    user: PortalUser;
    /** The portal's origin, for links back to each record. */
    site: string;
    /** For work a write starts in the background (an Intelligence capture). */
    exec?: { waitUntil(promise: Promise<unknown>): void };
}

export interface ToolResult {
    data: Record<string, unknown>;
    /** For writes: the record written, for the ledger. */
    outcome?: WriteOutcome;
}

export interface ToolDef<S extends z.ZodType = z.ZodType> {
    name: string;
    /** Writes go through the ledger (audit and retry safety) and the gateway's tighter write rate limit. */
    write: boolean;
    /** The portal permission needed to use the tool at all. Membership is then checked per record. */
    permission: Permission | "any_productivity";
    input: S;
    run: (ctx: ToolContext, input: z.output<S>) => Promise<ToolResult>;
    /** For a retried write (same request id): the record as it is now, without writing again. */
    replay?: (ctx: ToolContext, outcome: WriteOutcome) => Promise<ToolResult>;
}

export const tool = <S extends z.ZodType>(def: ToolDef<S>): ToolDef => def as unknown as ToolDef;

// --- Input pieces --------------------------------------------------------------------------------

export const id = (prefix: string, what: string) => z.string().regex(new RegExp(`^${prefix}_[a-z0-9]{14}$`), `Not a valid ${what} id`);
export const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-10-18");
/** A client-chosen id for one intended write. Sending it again returns the first result instead of writing twice. */
export const requestId = z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,64}$/, "Use 8–64 letters, digits, - or _")
    .optional();
export const limit = (fallback: number, maximum: number) => z.number().int().min(1).max(maximum).default(fallback);

// --- Output shapes -------------------------------------------------------------------------------

export const portalUrl = (ctx: ToolContext, path: string) => `${ctx.site}${path}`;

/** Cuts a list to `max`, saying how many there were. */
export const bounded = <T>(items: T[], max: number) => ({ items: items.slice(0, max), count: items.length, truncated: items.length > max });

/** Names of the caller's projects, so task rows can say where they live without one lookup each. */
export async function projectNames(ctx: ToolContext, tasks: Pick<TaskSummary, "projectId">[]): Promise<Map<string, string>> {
    const ids = [...new Set(tasks.map((t) => t.projectId))].slice(0, 100);
    if (!ids.length) return new Map();
    const rows = await ctx.db
        .prepare(
            `SELECT p.id, p.name, p.is_inbox FROM task_projects p JOIN task_project_members m ON m.project_id = p.id AND m.email = ?
             WHERE p.id IN (${placeholders(ids.length)})`,
        )
        .bind(ctx.user.email, ...ids)
        .all<{ id: string; name: string; is_inbox: number }>();
    return new Map(rows.results.map((r) => [r.id, r.is_inbox ? "Inbox" : r.name]));
}

export const taskOut = (ctx: ToolContext, task: TaskSummary, names: Map<string, string>) => ({
    id: task.id,
    title: task.title,
    status: task.status,
    /** 1 is the highest (P1), 4 the lowest. */
    priority: task.priority,
    dueDate: task.dueDate,
    dueTime: task.dueTime,
    deadline: task.deadline,
    recurring: !!task.recurrence,
    ...(task.projected ? { projectedOccurrence: true } : {}),
    isMilestone: task.isMilestone,
    projectId: task.projectId,
    projectName: names.get(task.projectId) ?? null,
    parentId: task.parentId,
    assignee: task.assignee,
    labels: task.labels,
    hasDescription: task.hasDescription,
    subtasks: task.subtasks,
    completedAt: task.completedAt,
    version: task.version,
    url: portalUrl(ctx, `/portal/tasks/t/${task.id}`),
});

/** A list of tasks, bounded, with project names. */
export async function taskList(ctx: ToolContext, tasks: TaskSummary[], max: number) {
    const cut = bounded(tasks, max);
    const names = await projectNames(ctx, cut.items);
    return { tasks: cut.items.map((t) => taskOut(ctx, t, names)), count: cut.count, truncated: cut.truncated };
}
