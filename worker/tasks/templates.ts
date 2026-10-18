// Task templates (src/shared/tasks/templates.ts). Who can see one:
//   * a private template (shared_project_id NULL): only its owner, whatever their portal role;
//   * a shared template: the members of that shared project, as long as they are members; its
//     editors and owners can change it, viewers can only read it.
// Anything else is a 404, as everywhere in Tasks. Using a template checks the destination project
// like any new task, and writes the task, its whole checklist, labels and history in one batch.
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { z } from "zod";
import type { PortalUser } from "../../src/shared/portal/types";
import { addDays, isCalendarDate } from "../../src/shared/tasks/dates";
import { type ChecklistItem, type TaskTemplate, templateInput } from "../../src/shared/tasks/templates";
import { type Priority, type TaskSummary, roleAtLeast } from "../../src/shared/tasks/types";
import { isGuardFailure, newId, nowIso, parseJson, requireChange } from "../portal/db";
import { HttpError } from "../portal/http";
import { ensureInbox, notFound, requireProject, requireTask, requireWritable, todayFor } from "./access";
import { activity } from "./activity";
import { checkSection, labelStatements, normaliseLabels, placement, resolveSchedule, subtree, taskSummary } from "./tasks";

interface TemplateRow {
    id: string;
    owner_email: string;
    shared_project_id: string | null;
    name: string;
    title: string;
    description: string;
    priority: number;
    default_project_id: string | null;
    labels_json: string;
    due_offset_days: number | null;
    due_time: string | null;
    recurrence_json: string | null;
    subtasks_json: string;
    archived_at: string | null;
    version: number;
    updated_at: string;
    role: "owner" | "editor" | "viewer" | null;
}

/** Templates the caller may see, with their role in the shared project (if any). */
const VISIBLE = `FROM task_templates t LEFT JOIN task_project_members m ON m.project_id = t.shared_project_id AND m.email = ?1
    WHERE ((t.shared_project_id IS NULL AND t.owner_email = ?1) OR (t.shared_project_id IS NOT NULL AND m.email IS NOT NULL))`;
const COLUMNS = "t.*, m.role";

const toTemplate = (r: TemplateRow, email: string): TaskTemplate => {
    const recurrence = r.recurrence_json ? templateInput.shape.recurrence.safeParse(parseJson(r.recurrence_json, null)) : null;
    return {
        id: r.id,
        name: r.name,
        title: r.title,
        description: r.description,
        priority: r.priority as Priority,
        defaultProjectId: r.default_project_id,
        sharedProjectId: r.shared_project_id,
        labels: parseJson<string[]>(r.labels_json, []),
        dueOffsetDays: r.due_offset_days,
        dueTime: r.due_time,
        recurrence: recurrence?.success ? recurrence.data : null,
        subtasks: parseJson<ChecklistItem[]>(r.subtasks_json, []),
        archived: !!r.archived_at,
        canEdit: r.shared_project_id ? !!r.role && roleAtLeast(r.role, "editor") : r.owner_email.toLowerCase() === email.toLowerCase(),
        owner: r.owner_email,
        version: r.version,
        updatedAt: r.updated_at,
    };
};

export async function listTemplates(db: D1Database, email: string, archived = false): Promise<TaskTemplate[]> {
    const rows = await db
        .prepare(`SELECT ${COLUMNS} ${VISIBLE} AND (t.archived_at IS NOT NULL) = ?2 ORDER BY t.name COLLATE NOCASE LIMIT 500`)
        .bind(email, archived ? 1 : 0)
        .all<TemplateRow>();
    return rows.results.map((r) => toTemplate(r, email));
}

async function requireTemplate(db: D1Database, user: PortalUser, templateId: string, edit = false): Promise<TaskTemplate> {
    const row = await db.prepare(`SELECT ${COLUMNS} ${VISIBLE} AND t.id = ?2`).bind(user.email, templateId).first<TemplateRow>();
    if (!row) throw notFound();
    const template = toTemplate(row, user.email);
    if (edit && !template.canEdit) throw new HttpError(403, "forbidden", "You can only use this template");
    return template;
}

export const getTemplate = (db: D1Database, user: PortalUser, templateId: string) => requireTemplate(db, user, templateId);

/** Projects named on a template must be ones the caller can add tasks to; a shared template's project must be shared. */
async function checkProjects(db: D1Database, user: PortalUser, body: z.output<typeof templateInput>) {
    if (body.sharedProjectId) {
        const project = await requireProject(db, user, body.sharedProjectId, "editor");
        if (project.kind !== "shared") throw new HttpError(422, "validation", "Only shared projects can share templates");
    }
    if (body.defaultProjectId) await requireProject(db, user, body.defaultProjectId, "editor");
}

const values = (body: z.output<typeof templateInput>) => [
    body.name,
    body.title,
    body.description,
    body.priority,
    body.defaultProjectId,
    body.sharedProjectId,
    JSON.stringify(normaliseLabels(body.labels)),
    body.dueOffsetDays,
    body.dueOffsetDays === null ? null : body.dueTime,
    body.recurrence && body.dueOffsetDays !== null ? JSON.stringify(body.recurrence) : null,
    JSON.stringify(body.subtasks),
];

export async function createTemplate(db: D1Database, user: PortalUser, input: unknown): Promise<TaskTemplate> {
    const body = templateInput.parse(input);
    await checkProjects(db, user, body);
    const count = await db.prepare("SELECT COUNT(*) AS n FROM task_templates WHERE owner_email = ?").bind(user.email).first<{ n: number }>();
    if ((count?.n ?? 0) >= 200) throw new HttpError(422, "validation", "You can keep up to 200 templates");
    const id = newId("ttp");
    const now = nowIso();
    await db
        .prepare(
            `INSERT INTO task_templates (id, owner_email, name, title, description, priority, default_project_id, shared_project_id, labels_json,
                due_offset_days, due_time, recurrence_json, subtasks_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, user.email, ...values(body), now, now)
        .run();
    return requireTemplate(db, user, id);
}

const updateInput = z.object({ version: z.number().int().min(1), template: templateInput.optional(), archived: z.boolean().optional() }).strict();

export async function updateTemplate(db: D1Database, user: PortalUser, templateId: string, input: unknown): Promise<TaskTemplate> {
    const body = updateInput.parse(input);
    await requireTemplate(db, user, templateId, true);
    const statements: D1PreparedStatement[] = [];
    const now = nowIso();
    if (body.template) {
        await checkProjects(db, user, body.template);
        statements.push(
            db
                .prepare(
                    `UPDATE task_templates SET name = ?, title = ?, description = ?, priority = ?, default_project_id = ?, shared_project_id = ?, labels_json = ?,
                        due_offset_days = ?, due_time = ?, recurrence_json = ?, subtasks_json = ?, version = version + 1, updated_at = ?
                     WHERE id = ? AND version = ?`,
                )
                .bind(...values(body.template), now, templateId, body.version),
        );
    }
    if (body.archived !== undefined) {
        statements.push(
            db
                .prepare(
                    "UPDATE task_templates SET archived_at = CASE WHEN ? THEN COALESCE(archived_at, ?) ELSE NULL END, version = version + 1, updated_at = ? WHERE id = ? AND version = ?",
                )
                .bind(body.archived ? 1 : 0, now, now, templateId, body.template ? body.version + 1 : body.version),
        );
    }
    if (!statements.length) return requireTemplate(db, user, templateId);
    try {
        await db.batch(statements.flatMap((s) => [s, requireChange(db)]));
    } catch (error) {
        if (isGuardFailure(error)) throw new HttpError(409, "conflict", "This template changed in another tab. Reload and try again.");
        throw error;
    }
    return requireTemplate(db, user, templateId);
}

export async function deleteTemplate(db: D1Database, user: PortalUser, templateId: string) {
    await requireTemplate(db, user, templateId, true);
    await db.prepare("DELETE FROM task_templates WHERE id = ?").bind(templateId).run();
}

/** A copy the caller owns: private, or in the same shared project if they can edit there. */
export async function duplicateTemplate(db: D1Database, user: PortalUser, templateId: string): Promise<TaskTemplate> {
    const t = await requireTemplate(db, user, templateId);
    return createTemplate(db, user, {
        name: `${t.name} (copy)`.slice(0, 120),
        title: t.title,
        description: t.description,
        priority: t.priority,
        defaultProjectId: t.defaultProjectId,
        sharedProjectId: t.sharedProjectId && t.canEdit ? t.sharedProjectId : null,
        labels: t.labels,
        dueOffsetDays: t.dueOffsetDays,
        dueTime: t.dueTime,
        recurrence: t.recurrence,
        subtasks: t.subtasks,
    });
}

const useInput = z
    .object({
        projectId: z
            .string()
            .regex(/^tpj_[a-z0-9]{14}$/)
            .optional(),
        sectionId: z
            .string()
            .regex(/^tsc_[a-z0-9]{14}$/)
            .nullable()
            .optional(),
        /** The day it's used from (default today); the template's offset counts from it. */
        startDate: z.string().refine(isCalendarDate, "Use a real date").optional(),
    })
    .strict();

/**
 * Creates a task and its checklist from a template, in one batch. The destination is checked like
 * any new task (editor of an active project). If the template's default project is no longer one
 * the caller can add to, the task goes to their Inbox.
 */
export async function useTemplate(db: D1Database, user: PortalUser, templateId: string, input: unknown): Promise<TaskSummary> {
    const body = useInput.parse(input);
    const template = await requireTemplate(db, user, templateId);
    let projectId = body.projectId ?? template.defaultProjectId ?? null;
    if (projectId && !body.projectId) {
        // The default project, if it's still one the caller can add to.
        projectId = await requireProject(db, user, projectId, "editor")
            .then((p) => (p.status === "archived" ? null : p.id))
            .catch(() => null);
    }
    const project = await requireProject(db, user, projectId ?? (await ensureInbox(db, user.email)), "editor");
    requireWritable(project);
    const sectionId = await checkSection(db, project.id, body.sectionId ?? null);
    const today = await todayFor(db, user.email);
    const start = body.startDate ?? today;
    const schedule = resolveSchedule(
        { due_date: null, due_time: null, deadline: null, recurrence_json: null },
        template.dueOffsetDays === null
            ? {}
            : { dueDate: addDays(start, template.dueOffsetDays), dueTime: template.dueTime, recurrence: template.recurrence ?? undefined },
        today,
    );
    const { position, renumber } = await placement(db, { projectId: project.id, sectionId, parentId: null }, {});
    const now = nowIso();
    const rootId = newId("tsk");
    const labels = normaliseLabels(template.labels);
    const statements: D1PreparedStatement[] = [
        ...renumber,
        db
            .prepare(
                `INSERT INTO task_items (id, project_id, section_id, parent_id, depth, title, description, priority, due_date, due_time, recurrence_json,
                    position, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, NULL, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
                rootId,
                project.id,
                sectionId,
                template.title,
                template.description,
                template.priority,
                schedule.due_date,
                schedule.due_time,
                schedule.recurrence_json,
                position,
                user.email,
                user.email,
                now,
                now,
            ),
        ...labelStatements(db, rootId, labels, user.email, now),
    ];
    // Parents before children, so each subtask's parent exists when it's inserted.
    const add = (items: ChecklistItem[], parentId: string, depth: number) =>
        items.forEach((item, i) => {
            const id = newId("tsk");
            statements.push(
                db
                    .prepare(
                        `INSERT INTO task_items (id, project_id, section_id, parent_id, depth, title, position, created_by, updated_by, created_at, updated_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    )
                    .bind(id, project.id, sectionId, parentId, depth, item.title, i + 1, user.email, user.email, now, now),
            );
            add(item.children ?? [], id, depth + 1);
        });
    add(template.subtasks, rootId, 1);
    statements.push(
        activity(db, { projectId: project.id, taskId: rootId, actor: user.email, action: "task.from_template", changes: { dueDate: schedule.due_date } }),
    );
    await db.batch(statements);
    return (await taskSummary(db, rootId))!;
}

/** A private template made from a task and its subtasks (titles only), for "Save as template". */
export async function templateFromTask(db: D1Database, user: PortalUser, taskId: string, input: unknown): Promise<TaskTemplate> {
    const { name } = z
        .object({ name: z.string().trim().min(1).max(120) })
        .strict()
        .parse(input);
    const task = await requireTask(db, user, taskId);
    const tree = await subtree(db, taskId);
    const rows = await db
        .prepare(`SELECT id, parent_id, title, description, priority, position FROM task_items WHERE id IN (${tree.map(() => "?").join(", ")})`)
        .bind(...tree.map((n) => n.id))
        .all<{ id: string; parent_id: string | null; title: string; description: string; priority: number; position: number }>();
    const children = (parent: string): ChecklistItem[] =>
        rows.results
            .filter((r) => r.parent_id === parent)
            .sort((a, b) => a.position - b.position)
            .map((r) => {
                const kids = children(r.id);
                return kids.length ? { title: r.title, children: kids } : { title: r.title };
            });
    const root = rows.results.find((r) => r.id === taskId)!;
    const labels = (await db.prepare("SELECT name FROM task_item_labels WHERE task_id = ?").bind(taskId).all<{ name: string }>()).results.map((l) => l.name);
    return createTemplate(db, user, {
        name,
        title: root.title,
        description: root.description,
        priority: root.priority,
        defaultProjectId: task.role !== "viewer" && task.project_status !== "archived" ? task.project_id : null,
        labels,
        subtasks: children(taskId),
    });
}
