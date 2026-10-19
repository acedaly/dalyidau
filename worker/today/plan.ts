// Plan My Day: a proposed schedule for the day from the Daily Planner's deterministic engine
// (priorities, due dates, estimates, free time, focus periods, the daily focus limit), shown before
// anything changes. Nothing is created until the person approves: they accept, reject or adjust each
// session, then apply the ones they kept. Applying creates ordinary time blocks through the planner's
// own createBlock (every task re-checked through Tasks, idempotent by client id). Meetings, other
// sessions and task dates are never moved: a suggestion only ever fills free time.
import type { D1Database } from "@cloudflare/workers-types";
import { z } from "zod";
import { conflictsFor, overlaps } from "../../src/shared/planner/engine";
import type { PlannerConflict, TimeBlockInfo } from "../../src/shared/planner/types";
import type { PortalUser } from "../../src/shared/portal/types";
import { focusOn } from "../../src/shared/today/engine";
import { APPLY_LIMIT, type PlanProposal } from "../../src/shared/today/types";
import { activity } from "../calendar/access";
import { createBlock, createBlockInput, requirePlanner } from "../planner/blocks";
import { conflictsForBlock, suggest } from "../planner/planning";
import { HttpError } from "../portal/http";
import { planPart, resolveDate } from "./dashboard";

const proposeInput = z
    .object({
        date: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional(),
        /** Only these tasks (default: today's, overdue, upcoming and P1–P2 not yet planned). */
        taskIds: z
            .array(z.string().regex(/^tsk_[a-z0-9]{14}$/))
            .min(1)
            .max(50)
            .optional(),
    })
    .strict();

/** A proposed schedule for one day. Read-only. */
export async function proposePlan(db: D1Database, user: PortalUser, input: unknown, now = Date.now()): Promise<PlanProposal> {
    requirePlanner(user);
    const body = proposeInput.parse(input);
    const { date, today } = await resolveDate(db, user, body.date);
    if (date < today) throw new HttpError(422, "past", "Plan today or a later day");
    const [plan, result] = await Promise.all([planPart(db, user, date, today, now), suggest(db, user, { from: date, days: 1, taskIds: body.taskIds }, now)]);
    const { w } = plan;
    const focus = focusOn(date, w.todayPrefs.focusPeriods, w.timeZone);
    const byId = new Map(plan.lists.tasks.map((t) => [t.id, t]));
    return {
        date,
        capacityBefore: plan.capacity,
        suggestions: result.suggestions.map((s) => {
            const t = byId.get(s.taskId);
            const span = { start: Date.parse(s.start), end: Date.parse(s.end) };
            return {
                ...s,
                inFocus: focus.some((f) => overlaps(span, f)),
                conflicts: conflictsFor(
                    { id: null, start: s.start, end: s.end, dueDate: t?.dueDate ?? null, dueTime: t?.dueTime ?? null, deadline: t?.deadline ?? null },
                    w.commitments,
                    w.days,
                    w.timeZone,
                ),
            };
        }),
        unplaced: result.unplaced,
        note: result.note,
    };
}

const applyInput = z
    .object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        /** The sessions the person approved, as proposed or adjusted. */
        items: z.array(createBlockInput).min(1, "Approve at least one session").max(APPLY_LIMIT, `Apply at most ${APPLY_LIMIT} sessions at a time`),
    })
    .strict();

export interface ApplyResult {
    created: { block: TimeBlockInfo; conflicts: PlannerConflict[] }[];
    failed: { taskId: string; startTime: string; code: string; message: string }[];
}

/**
 * Creates the approved sessions, one by one through the planner. A session that can't be created
 * (the task was completed meanwhile, or the person lost access) is reported and the rest go ahead.
 * Every item needs a client id, so applying twice never creates a session twice.
 */
export async function applyPlan(db: D1Database, user: PortalUser, input: unknown): Promise<ApplyResult> {
    requirePlanner(user);
    const body = applyInput.parse(input);
    if (body.items.some((i) => !i.clientId)) throw new HttpError(422, "validation", "Each session needs a client id");
    if (new Set(body.items.map((i) => i.clientId)).size !== body.items.length) throw new HttpError(422, "validation", "Each session needs its own client id");
    const out: ApplyResult = { created: [], failed: [] };
    for (const item of body.items) {
        try {
            const block = await createBlock(db, user, { ...item, source: "suggestion" });
            out.created.push({ block, conflicts: await conflictsForBlock(db, user, block) });
        } catch (error) {
            if (!(error instanceof HttpError) || error.status >= 500) throw error;
            // A task the person can't see stays a plain "not found", as in Tasks.
            out.failed.push({ taskId: item.taskId, startTime: item.startTime, code: error.code, message: error.message });
        }
    }
    await activity(db, { actor: user.email, action: "today.plan_applied", entityType: "today_plan", entityId: body.date }).run();
    return out;
}
