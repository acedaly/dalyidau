// Taking turns on a routine (worker/tasks/routines.ts): who is next, and the statement that passes
// the turn on in the same batch as a completion (worker/tasks/tasks.ts). Kept apart from routines.ts
// so the task engine can use it without importing the routine endpoints.
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { type Rotation, nextInTurn } from "../../src/shared/tasks/productivity";
import { chunk, placeholders } from "../portal/db";

/** Participants, in turn order, for each routine. */
export async function participantsFor(db: D1Database, routineIds: string[]) {
    const out = new Map<string, { email: string; name: string | null }[]>();
    for (const part of chunk(routineIds, 50)) {
        if (!part.length) continue;
        const rows = await db
            .prepare(
                `SELECT rp.routine_id, rp.email, u.name FROM task_routine_participants rp LEFT JOIN portal_users u ON u.email = rp.email
                 WHERE rp.routine_id IN (${placeholders(part.length)}) ORDER BY rp.position`,
            )
            .bind(...part)
            .all<{ routine_id: string; email: string; name: string | null }>();
        for (const r of rows.results) (out.get(r.routine_id) ?? out.set(r.routine_id, []).get(r.routine_id)!).push({ email: r.email, name: r.name });
    }
    return out;
}

/**
 * The statement that passes a routine's turn on after an occurrence is completed (not skipped), for
 * the completion batch in tasks.ts. The next person must still be able to be assigned the task;
 * if they can't (they left between reading and writing), the assignee is left as it was.
 */
export async function turnStatement(
    db: D1Database,
    taskId: string,
    projectId: string,
    assignee: string | null,
): Promise<{ statement: D1PreparedStatement; next: string } | null> {
    const routine = await db
        .prepare("SELECT id, rotation, paused_at FROM task_routines WHERE task_id = ?")
        .bind(taskId)
        .first<{ id: string; rotation: Rotation; paused_at: string | null }>();
    if (!routine || routine.rotation !== "turns") return null;
    const people = (await participantsFor(db, [routine.id])).get(routine.id)?.map((p) => p.email) ?? [];
    const next = nextInTurn(people, assignee);
    if (!next || next === assignee) return null;
    return {
        next,
        statement: db
            .prepare(
                `UPDATE task_items SET assignee_email = ? WHERE id = ?
                 AND EXISTS (SELECT 1 FROM task_project_members WHERE project_id = ? AND email = ? AND role <> 'viewer')`,
            )
            .bind(next, taskId, projectId, next),
    };
}

/**
 * Undoing a completed occurrence gives the turn back: the person before the current assignee in the
 * order, if the turn had passed to the current one. Anything else (someone reassigned it since) is
 * left alone.
 */
export async function undoTurnStatement(db: D1Database, taskId: string, projectId: string, assignee: string | null): Promise<D1PreparedStatement | null> {
    const routine = await db.prepare("SELECT id, rotation FROM task_routines WHERE task_id = ?").bind(taskId).first<{ id: string; rotation: Rotation }>();
    if (!routine || routine.rotation !== "turns" || !assignee) return null;
    const people = (await participantsFor(db, [routine.id])).get(routine.id)?.map((p) => p.email) ?? [];
    const at = people.findIndex((p) => p.toLowerCase() === assignee.toLowerCase());
    if (at < 0 || people.length < 2) return null;
    const previous = people[(at - 1 + people.length) % people.length];
    return db
        .prepare(
            `UPDATE task_items SET assignee_email = ? WHERE id = ? AND assignee_email = ?
             AND EXISTS (SELECT 1 FROM task_project_members WHERE project_id = ? AND email = ? AND role <> 'viewer')`,
        )
        .bind(previous, taskId, assignee, projectId, previous);
}
