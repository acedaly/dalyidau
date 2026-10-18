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
import { notFound, requireProject, requireTask, requireWritable } from "./access";
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
    // A trashed object reads as unavailable from Tasks, so nothing is listed against it either.
    if ((await requireObject(db, user, objectId)).status === "trashed") return [];
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

// --- Projects ------------------------------------------------------------------------------------
//
// A project can reference Knowledge objects too (the Wedding Planning project → its planning notes),
// with exactly the same rules as tasks: adding needs edit access to the project and read access to
// the object in Knowledge; reading re-checks the reader's Knowledge membership every time; anyone
// who can edit the project can remove one. No Knowledge data is copied into Tasks.

interface ProjectReferenceRow {
    id: string;
    object_id: string;
    title: string | null;
    space_name: string | null;
    available: number;
}

/** A project's own Knowledge references, as the caller may see them. The project's access is the caller's concern. */
export async function projectKnowledgeReferences(db: D1Database, user: PortalUser, projectId: string): Promise<KnowledgeReference[]> {
    const may = can(user, "knowledge.use") ? 1 : 0;
    const rows = await db
        .prepare(
            `SELECT l.id, l.object_id,
                    (km.email IS NOT NULL AND o.status <> 'trashed' AND ?1 = 1) AS available,
                    CASE WHEN km.email IS NOT NULL AND o.status <> 'trashed' AND ?1 = 1 THEN o.title END AS title,
                    CASE WHEN km.email IS NOT NULL AND o.status <> 'trashed' AND ?1 = 1 THEN s.name END AS space_name
             FROM task_project_knowledge_links l
             JOIN knowledge_objects o ON o.id = l.object_id
             JOIN knowledge_spaces s ON s.id = o.space_id
             LEFT JOIN knowledge_memberships km ON km.space_id = o.space_id AND km.email = ?2
             WHERE l.project_id = ?3 ORDER BY l.added_at LIMIT 50`,
        )
        .bind(may, user.email, projectId)
        .all<ProjectReferenceRow>();
    return rows.results.map((r) =>
        r.available
            ? { linkId: r.id, available: true, objectId: r.object_id, title: r.title || "Untitled", spaceName: r.space_name ?? "" }
            : { linkId: r.id, available: false },
    );
}

/** At most this many Knowledge references per project. */
const PROJECT_LINK_LIMIT = 50;

export async function linkProjectKnowledge(db: D1Database, user: PortalUser, projectId: string, input: unknown): Promise<KnowledgeReference[]> {
    const { objectId } = linkInput.parse(input);
    const project = await requireProject(db, user, projectId, "editor");
    requireWritable(project);
    if (!can(user, "knowledge.use")) throw new HttpError(403, "forbidden", "You don't have access to Knowledge");
    const object = await requireObject(db, user, objectId);
    if (object.status === "trashed") throw notFound();
    const count = await db.prepare("SELECT COUNT(*) AS n FROM task_project_knowledge_links WHERE project_id = ?").bind(projectId).first<{ n: number }>();
    if ((count?.n ?? 0) >= PROJECT_LINK_LIMIT) throw new HttpError(422, "validation", `At most ${PROJECT_LINK_LIMIT} Knowledge references per project`);
    await db.batch([
        db
            .prepare("INSERT OR IGNORE INTO task_project_knowledge_links (id, project_id, object_id, added_by, added_at) VALUES (?, ?, ?, ?, ?)")
            .bind(newId("tpk"), projectId, objectId, user.email, nowIso()),
        activity(db, { projectId, actor: user.email, action: "project.knowledge.link" }, "WHERE changes() > 0"),
    ]);
    return projectKnowledgeReferences(db, user, projectId);
}

export async function unlinkProjectKnowledge(db: D1Database, user: PortalUser, projectId: string, linkId: string): Promise<KnowledgeReference[]> {
    const project = await requireProject(db, user, projectId, "editor");
    requireWritable(project);
    const result = await db.prepare("DELETE FROM task_project_knowledge_links WHERE id = ? AND project_id = ?").bind(linkId, projectId).run();
    if (!result.meta.changes) throw notFound();
    await activity(db, { projectId, actor: user.email, action: "project.knowledge.unlink" }).run();
    return projectKnowledgeReferences(db, user, projectId);
}

export interface RelatedProject {
    id: string;
    name: string;
    color: string;
    kind: "personal" | "shared";
    status: string;
    open: number;
    completed: number;
}

/**
 * Everything in Tasks related to a Knowledge object, for its page: linked tasks and linked projects,
 * each only if the caller is a member of its project, and nothing at all unless they can read the
 * object in Knowledge. Counts are over what's returned, never over hidden records.
 */
export async function relatedForObject(db: D1Database, user: PortalUser, objectId: string) {
    const tasks = await tasksForObject(db, user, objectId);
    if ((await requireObject(db, user, objectId)).status === "trashed") return { tasks, projects: [], taskProjects: [] };
    const projects = await db
        .prepare(
            `SELECT p.id, p.name, p.color, p.kind, p.status,
                    (SELECT COUNT(*) FROM task_items t WHERE t.project_id = p.id AND t.status = 'open') AS open,
                    (SELECT COUNT(*) FROM task_items t WHERE t.project_id = p.id AND t.status = 'completed') AS completed
             FROM task_project_knowledge_links l JOIN task_projects p ON p.id = l.project_id
             JOIN task_project_members m ON m.project_id = p.id AND m.email = ?
             WHERE l.object_id = ? ORDER BY p.name COLLATE NOCASE LIMIT 20`,
        )
        .bind(user.email, objectId)
        .all<RelatedProject>();
    // Names of the tasks' own projects, so the list can say where each one lives (the caller is a member of each).
    const ids = [...new Set(tasks.map((t) => t.projectId))];
    const names = ids.length
        ? (
              await db
                  .prepare(`SELECT id, name, color, is_inbox FROM task_projects WHERE id IN (${placeholders(ids.length)})`)
                  .bind(...ids)
                  .all<{ id: string; name: string; color: string; is_inbox: number }>()
          ).results.map((p) => ({ id: p.id, name: p.is_inbox ? "Inbox" : p.name, color: p.color }))
        : [];
    return { tasks, projects: projects.results, taskProjects: names };
}
