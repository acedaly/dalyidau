// References from tasks to Daly Knowledge objects: the one place Tasks and Knowledge meet.
//
// Two permission systems apply and neither implies the other:
//   * the task side: the caller must be a member of the task's project (an editor to add or remove);
//   * the Knowledge side: the caller must have "knowledge.use" and be a member of the object's space.
// Both are checked when a reference is added (through Knowledge's own requireObject) and again every
// time one is read. Someone who can see a shared task but not the linked object sees only that a
// reference exists ("unavailable"): no title, no space, no id. Trashed objects read as unavailable.
//
// Knowledge itself is not changed. task_knowledge_links holds only ids, and its foreign key removes
// a reference when Knowledge permanently deletes the object.
import type { D1Database } from "@cloudflare/workers-types";
import { z } from "zod";
import type { PortalUser } from "../../src/shared/portal/types";
import { type KnowledgeReference, LIMITS, type TaskSummary } from "../../src/shared/tasks/types";
import { requireObject } from "../knowledge/access";
import { can } from "../portal/auth";
import { chunk, newId, nowIso, placeholders } from "../portal/db";
import { HttpError } from "../portal/http";
import { notFound, requireTask, requireWritable } from "./access";
import { activity } from "./activity";
import { TASK_COLUMNS, type TaskRow, toSummary } from "./rows";

interface ReferenceRow {
    id: string;
    task_id: string;
    object_id: string;
    title: string | null;
    space_name: string | null;
    available: number;
}

/** References on these tasks as the caller is allowed to see them. The tasks' own access is the caller's concern. */
export async function knowledgeReferences(db: D1Database, user: PortalUser, taskIds: string[]): Promise<Map<string, KnowledgeReference[]>> {
    const out = new Map<string, KnowledgeReference[]>();
    const mayUseKnowledge = can(user, "knowledge.use") ? 1 : 0;
    for (const part of chunk(taskIds, 50)) {
        if (!part.length) continue;
        const rows = await db
            .prepare(
                `SELECT l.id, l.task_id, l.object_id,
                        (km.email IS NOT NULL AND o.status <> 'trashed' AND ? = 1) AS available,
                        CASE WHEN km.email IS NOT NULL AND o.status <> 'trashed' AND ? = 1 THEN o.title END AS title,
                        CASE WHEN km.email IS NOT NULL AND o.status <> 'trashed' AND ? = 1 THEN s.name END AS space_name
                 FROM task_knowledge_links l
                 JOIN knowledge_objects o ON o.id = l.object_id
                 JOIN knowledge_spaces s ON s.id = o.space_id
                 LEFT JOIN knowledge_memberships km ON km.space_id = o.space_id AND km.email = ?
                 WHERE l.task_id IN (${placeholders(part.length)}) ORDER BY l.added_at`,
            )
            .bind(mayUseKnowledge, mayUseKnowledge, mayUseKnowledge, user.email, ...part)
            .all<ReferenceRow>();
        for (const r of rows.results) {
            const list = out.get(r.task_id) ?? [];
            list.push(
                r.available
                    ? { linkId: r.id, available: true, objectId: r.object_id, title: r.title || "Untitled", spaceName: r.space_name ?? "" }
                    : { linkId: r.id, available: false },
            );
            out.set(r.task_id, list);
        }
    }
    return out;
}

const linkInput = z.object({ objectId: z.string().regex(/^kob_[a-z0-9]{14}$/, "Not a valid Knowledge object") }).strict();

/** Adds a reference. The object must be one the caller can read in Knowledge right now. */
export async function linkKnowledge(db: D1Database, user: PortalUser, taskId: string, input: unknown): Promise<KnowledgeReference[]> {
    const { objectId } = linkInput.parse(input);
    const task = await requireTask(db, user, taskId, "editor");
    requireWritable(task);
    if (!can(user, "knowledge.use")) throw new HttpError(403, "forbidden", "You don't have access to Knowledge");
    // Knowledge's own check: 404 for anything outside the caller's spaces, so ids can't be probed from here either.
    const object = await requireObject(db, user, objectId);
    if (object.status === "trashed") throw notFound();
    const count = await db.prepare("SELECT COUNT(*) AS n FROM task_knowledge_links WHERE task_id = ?").bind(taskId).first<{ n: number }>();
    if ((count?.n ?? 0) >= LIMITS.knowledgeLinksPerTask)
        throw new HttpError(422, "validation", `At most ${LIMITS.knowledgeLinksPerTask} Knowledge references per task`);
    await db.batch([
        db
            .prepare("INSERT OR IGNORE INTO task_knowledge_links (id, task_id, object_id, added_by, added_at) VALUES (?, ?, ?, ?, ?)")
            .bind(newId("tkl"), taskId, objectId, user.email, nowIso()),
        // The history says a reference was added, never which object.
        activity(db, { projectId: task.project_id, taskId, actor: user.email, action: "knowledge.link" }, "WHERE changes() > 0"),
    ]);
    return (await knowledgeReferences(db, user, [taskId])).get(taskId) ?? [];
}

/** Removes a reference. Any editor of the task can, even one who can't see the object. */
export async function unlinkKnowledge(db: D1Database, user: PortalUser, taskId: string, linkId: string): Promise<KnowledgeReference[]> {
    const task = await requireTask(db, user, taskId, "editor");
    requireWritable(task);
    const result = await db.prepare("DELETE FROM task_knowledge_links WHERE id = ? AND task_id = ?").bind(linkId, taskId).run();
    if (!result.meta.changes) throw notFound();
    await activity(db, { projectId: task.project_id, taskId, actor: user.email, action: "knowledge.unlink" }).run();
    return (await knowledgeReferences(db, user, [taskId])).get(taskId) ?? [];
}

/**
 * The reverse direction, for Knowledge to show related tasks later: tasks linked to an object, but
 * only those the caller can see in Tasks, and only if they can read the object in Knowledge.
 */
export async function tasksForObject(db: D1Database, user: PortalUser, objectId: string): Promise<TaskSummary[]> {
    if (!can(user, "knowledge.use")) throw notFound();
    await requireObject(db, user, objectId);
    const rows = await db
        .prepare(
            `SELECT ${TASK_COLUMNS} FROM task_knowledge_links l JOIN task_items t ON t.id = l.task_id
             JOIN task_project_members m ON m.project_id = t.project_id AND m.email = ?
             WHERE l.object_id = ? ORDER BY t.status = 'completed', t.due_date IS NULL, t.due_date LIMIT 100`,
        )
        .bind(user.email, objectId)
        .all<TaskRow>();
    return rows.results.map(toSummary);
}
