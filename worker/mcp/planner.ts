// MCP tools for the Daily Planner (docs/DAILY_PLANNER.md): the day's plan, deterministic
// suggestions, and scheduling, moving, resizing or cancelling a time block. Every tool needs both
// Calendar and Tasks, and every task is checked through Tasks' own access. Suggestions never create
// anything; a block is created only by planner_schedule_task, which an assistant should call only
// for a time the person agreed to. There is no delete tool: cancelling keeps the record.
import { z } from "zod";
import { timeLabel } from "../../src/shared/calendar/time";
import { BLOCK_LIMITS, type PlannerConflict, type TimeBlockInfo } from "../../src/shared/planner/types";
import { todayFor } from "../calendar/access";
import { blockId, createBlock, getBlock, requirePlanner, updateBlock } from "../planner/blocks";
import { plannerDayFacts } from "../planner/facts";
import { conflictsForBlock, suggest } from "../planner/planning";
import type { WriteOutcome } from "./ledger";
import { type ToolContext, type ToolDef, calendarDate, id, portalUrl, requestId, tool } from "./shared";

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a 24-hour time like 09:30");
const minutes = z
    .number()
    .int()
    .min(BLOCK_LIMITS.minMinutes)
    .max(BLOCK_LIMITS.maxMinutes)
    .refine((m) => m % 5 === 0, "Use whole 5-minute steps");

const outcome = (entityType: WriteOutcome["entityType"], entityId: string): WriteOutcome => ({ entityType, entityId });

const blockOut = (ctx: ToolContext, b: TimeBlockInfo) => ({
    id: b.id,
    taskId: b.taskId,
    taskTitle: b.title,
    projectName: b.projectName,
    date: b.startDate,
    start: b.startTime,
    end: b.endTime,
    minutes: b.durationMinutes,
    status: b.status,
    occurrenceDate: b.occurrenceDate,
    taskCompleted: b.taskStatus === "completed" || b.earlierOccurrence,
    version: b.version,
    url: portalUrl(ctx, `/portal/calendar/planner?date=${b.startDate}&block=${b.id}`),
    taskUrl: portalUrl(ctx, `/portal/tasks/t/${b.taskId}`),
});

const conflictOut = (c: PlannerConflict) => ({
    kind: c.kind,
    message: c.message,
    ...(c.with ? { with: { title: c.with.title, source: c.with.source, shared: c.with.shared } } : {}),
});

const getDay = tool({
    name: "planner_get_day",
    write: false,
    permission: "calendar.use",
    input: z.object({ date: calendarDate.optional() }).strict(),
    run: async (ctx, input) => {
        requirePlanner(ctx.user);
        const date = input.date ?? (await todayFor(ctx.db, ctx.user.email));
        return { data: await plannerDayFacts(ctx.db, ctx.user, ctx.site, date) };
    },
});

const suggestSlots = tool({
    name: "planner_suggest_slots",
    write: false,
    permission: "calendar.use",
    input: z
        .object({
            from: calendarDate.optional(),
            days: z.number().int().min(1).max(BLOCK_LIMITS.suggestDays).optional(),
            taskIds: z.array(id("tsk", "task")).min(1).max(50).optional(),
        })
        .strict(),
    run: async (ctx, input) => {
        requirePlanner(ctx.user);
        const plan = await suggest(ctx.db, ctx.user, { ...input, days: input.days ?? 1 });
        return {
            data: {
                from: plan.from,
                to: plan.to,
                suggestions: plan.suggestions.slice(0, 40).map((s) => ({
                    taskId: s.taskId,
                    title: s.title,
                    date: s.startDate,
                    start: s.startTime,
                    end: s.endTime,
                    when: `${timeLabel(s.startTime)} – ${timeLabel(s.endTime)}`,
                    minutes: s.durationMinutes,
                    occurrenceDate: s.occurrenceDate,
                    session: `${s.session} of ${s.sessions}`,
                    late: s.late,
                    reason: s.reason,
                })),
                unplaced: plan.unplaced,
                note: plan.note,
            },
        };
    },
});

const scheduleTask = tool({
    name: "planner_schedule_task",
    write: true,
    permission: "calendar.use",
    input: z
        .object({
            taskId: id("tsk", "task"),
            startDate: calendarDate,
            startTime: time,
            durationMinutes: minutes,
            occurrenceDate: calendarDate.optional(),
            requestId,
        })
        .strict(),
    run: async (ctx, input) => {
        requirePlanner(ctx.user);
        const { requestId: rid, ...fields } = input;
        const block = await createBlock(ctx.db, ctx.user, { ...fields, ...(rid ? { clientId: rid } : {}) }, "mcp");
        const conflicts = await conflictsForBlock(ctx.db, ctx.user, block);
        return { data: { scheduled: true, block: blockOut(ctx, block), conflicts: conflicts.map(conflictOut) }, outcome: outcome("task_time_block", block.id) };
    },
    replay: async (ctx, o) => ({ data: { scheduled: true, replayed: true, block: blockOut(ctx, await getBlock(ctx.db, ctx.user, o.entityId)) } }),
});

const updateBlockTool = tool({
    name: "planner_update_block",
    write: true,
    permission: "calendar.use",
    input: z
        .object({
            blockId,
            version: z.number().int().min(1),
            startDate: calendarDate.optional(),
            startTime: time.optional(),
            durationMinutes: minutes.optional(),
            cancel: z.literal(true).optional(),
            requestId,
        })
        .strict(),
    run: async (ctx, input) => {
        requirePlanner(ctx.user);
        // requestId is the ledger's (worker/mcp/entrypoint.ts), not the block's.
        const { blockId: bid, cancel, requestId: _requestId, ...fields } = input;
        const block = await updateBlock(ctx.db, ctx.user, bid, { ...fields, ...(cancel ? { status: "cancelled" } : {}) }, "mcp");
        const conflicts = await conflictsForBlock(ctx.db, ctx.user, block);
        return { data: { updated: true, block: blockOut(ctx, block), conflicts: conflicts.map(conflictOut) }, outcome: outcome("task_time_block", block.id) };
    },
    replay: async (ctx, o) => ({ data: { updated: true, replayed: true, block: blockOut(ctx, await getBlock(ctx.db, ctx.user, o.entityId)) } }),
});

export const PLANNER_TOOLS: ToolDef[] = [getDay, suggestSlots, scheduleTask, updateBlockTool];
