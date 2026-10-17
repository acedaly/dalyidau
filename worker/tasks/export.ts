// Portable export of everything the caller can see in Tasks: `daly.tasks` version 1 JSON, which
// keeps projects, sections, tasks, subtasks, labels, assignments, dates, repeat rules (as stored and
// as RRULE), completion history, comments and Knowledge references; and a CSV of tasks for
// spreadsheets. Only the caller's projects are included, and only their own labels, saved filters
// and reminders. Knowledge references are listed only where the caller can read the object.
import type { D1Database } from "@cloudflare/workers-types";
import { csvCell } from "../../src/shared/portal/csv";
import type { PortalUser } from "../../src/shared/portal/types";
import { type TaskFilter, taskFilter } from "../../src/shared/tasks/filters";
import { type RecurrenceRule, parseStoredRule, toRRule } from "../../src/shared/tasks/recurrence";
import { PRIORITY_LABELS, type Priority } from "../../src/shared/tasks/types";
import { chunk, parseJson, placeholders } from "../portal/db";
import { HttpError } from "../portal/http";
import { preferences } from "./access";
import { knowledgeReferences } from "./knowledge";

export const EXPORT_FORMAT = "daly.tasks";
export const EXPORT_VERSION = 1;
/** Beyond this the export is refused rather than risk running out of Worker memory. */
export const EXPORT_TASK_LIMIT = 50_000;

export interface TasksExport {
    format: typeof EXPORT_FORMAT;
    version: typeof EXPORT_VERSION;
    exportedAt: string;
    exportedBy: string;
    timeZone: string;
    scope: "all" | "personal";
    projects: {
        id: string;
        name: string;
        description: string;
        color: string;
        kind: "personal" | "shared";
        isInbox: boolean;
        status: string;
        startDate: string | null;
        targetDate: string | null;
        defaultView: string;
        role: string;
        createdAt: string;
        members: { email: string; role: string }[];
        sections: { id: string; name: string; position: number }[];
    }[];
    tasks: {
        id: string;
        projectId: string;
        sectionId: string | null;
        parentId: string | null;
        title: string;
        description: string;
        status: string;
        priority: Priority;
        dueDate: string | null;
        dueTime: string | null;
        deadline: string | null;
        recurrence: RecurrenceRule | null;
        rrule: string | null;
        isMilestone: boolean;
        assignee: string | null;
        labels: string[];
        position: number;
        createdAt: string;
        createdBy: string;
        updatedAt: string;
        updatedBy: string;
        completedAt: string | null;
        completedBy: string | null;
        knowledgeObjectIds: string[];
        comments: { author: string; body: string; createdAt: string; editedAt: string | null }[];
    }[];
    completions: { taskId: string; kind: string; occurrenceDate: string | null; nextDate: string | null; at: string; by: string; undoneAt: string | null }[];
    labels: { name: string; color: string }[];
    savedFilters: { name: string; definition: TaskFilter }[];
    reminders: { taskId: string; kind: string; offsetMinutes: number | null; remindAt: string; dismissedAt: string | null }[];
}

interface ExportTaskRow {
    id: string;
    project_id: string;
    section_id: string | null;
    parent_id: string | null;
    depth: number;
    title: string;
    description: string;
    status: string;
    priority: number;
    due_date: string | null;
    due_time: string | null;
    deadline: string | null;
    recurrence_json: string | null;
    is_milestone: number;
    assignee_email: string | null;
    position: number;
    created_at: string;
    created_by: string;
    updated_at: string;
    updated_by: string;
    completed_at: string | null;
    completed_by: string | null;
    labels_json: string | null;
}

export async function exportTasks(db: D1Database, user: PortalUser, scope: "all" | "personal"): Promise<TasksExport> {
    const kind = scope === "personal" ? "AND p.kind = 'personal'" : "";
    const count = await db
        .prepare(
            `SELECT COUNT(*) AS n FROM task_items t JOIN task_project_members m ON m.project_id = t.project_id AND m.email = ? JOIN task_projects p ON p.id = t.project_id WHERE 1 = 1 ${kind}`,
        )
        .bind(user.email)
        .first<{ n: number }>();
    if ((count?.n ?? 0) > EXPORT_TASK_LIMIT) throw new HttpError(413, "too_large", "That's too many tasks to export at once. Use the database backup instead.");

    const projects = await db
        .prepare(
            `SELECT p.id, p.name, p.description, p.color, p.kind, p.is_inbox, p.status, p.start_date, p.target_date, p.default_view, p.created_at, m.role
             FROM task_projects p JOIN task_project_members m ON m.project_id = p.id AND m.email = ? WHERE 1 = 1 ${kind} ORDER BY p.is_inbox DESC, m.position`,
        )
        .bind(user.email)
        .all<{
            id: string;
            name: string;
            description: string;
            color: string;
            kind: "personal" | "shared";
            is_inbox: number;
            status: string;
            start_date: string | null;
            target_date: string | null;
            default_view: string;
            created_at: string;
            role: string;
        }>();
    const projectIds = projects.results.map((p) => p.id);
    const members = new Map<string, { email: string; role: string }[]>();
    const sections = new Map<string, { id: string; name: string; position: number }[]>();
    const tasks: ExportTaskRow[] = [];
    for (const part of chunk(projectIds, 40)) {
        const [m, s, t] = await Promise.all([
            db
                .prepare(`SELECT project_id, email, role FROM task_project_members WHERE project_id IN (${placeholders(part.length)}) ORDER BY email`)
                .bind(...part)
                .all<{ project_id: string; email: string; role: string }>(),
            db
                .prepare(`SELECT id, project_id, name, position FROM task_sections WHERE project_id IN (${placeholders(part.length)}) ORDER BY position`)
                .bind(...part)
                .all<{ id: string; project_id: string; name: string; position: number }>(),
            db
                .prepare(
                    `SELECT t.id, t.project_id, t.section_id, t.parent_id, t.depth, t.title, t.description, t.status, t.priority, t.due_date, t.due_time, t.deadline,
                        t.recurrence_json, t.is_milestone, t.assignee_email, t.position, t.created_at, t.created_by, t.updated_at, t.updated_by, t.completed_at, t.completed_by,
                        (SELECT json_group_array(l.name) FROM task_item_labels l WHERE l.task_id = t.id) AS labels_json
                     FROM task_items t WHERE t.project_id IN (${placeholders(part.length)}) ORDER BY t.project_id, t.depth, t.position`,
                )
                .bind(...part)
                .all<ExportTaskRow>(),
        ]);
        for (const r of m.results) (members.get(r.project_id) ?? members.set(r.project_id, []).get(r.project_id)!).push({ email: r.email, role: r.role });
        for (const r of s.results)
            (sections.get(r.project_id) ?? sections.set(r.project_id, []).get(r.project_id)!).push({ id: r.id, name: r.name, position: r.position });
        tasks.push(...t.results);
    }
    const taskIds = tasks.map((t) => t.id);
    const comments = new Map<string, TasksExport["tasks"][number]["comments"]>();
    const completions: TasksExport["completions"] = [];
    const reminders: TasksExport["reminders"] = [];
    for (const part of chunk(taskIds, 50)) {
        const [c, h, r] = await Promise.all([
            db
                .prepare(
                    `SELECT task_id, author_email, body, created_at, edited_at FROM task_comments WHERE task_id IN (${placeholders(part.length)}) ORDER BY created_at`,
                )
                .bind(...part)
                .all<{
                    task_id: string;
                    author_email: string;
                    body: string;
                    created_at: string;
                    edited_at: string | null;
                }>(),
            db
                .prepare(
                    `SELECT task_id, kind, occurrence_date, next_date, at, by, undone_at FROM task_completions WHERE task_id IN (${placeholders(part.length)}) ORDER BY id`,
                )
                .bind(...part)
                .all<{
                    task_id: string;
                    kind: string;
                    occurrence_date: string | null;
                    next_date: string | null;
                    at: string;
                    by: string;
                    undone_at: string | null;
                }>(),
            db
                .prepare(
                    `SELECT task_id, kind, offset_minutes, remind_at, dismissed_at FROM task_reminders WHERE owner_email = ? AND task_id IN (${placeholders(part.length)}) ORDER BY remind_at`,
                )
                .bind(user.email, ...part)
                .all<{ task_id: string; kind: string; offset_minutes: number | null; remind_at: string; dismissed_at: string | null }>(),
        ]);
        for (const row of c.results)
            (comments.get(row.task_id) ?? comments.set(row.task_id, []).get(row.task_id)!).push({
                author: row.author_email,
                body: row.body,
                createdAt: row.created_at,
                editedAt: row.edited_at,
            });
        completions.push(
            ...h.results.map((row) => ({
                taskId: row.task_id,
                kind: row.kind,
                occurrenceDate: row.occurrence_date,
                nextDate: row.next_date,
                at: row.at,
                by: row.by,
                undoneAt: row.undone_at,
            })),
        );
        reminders.push(
            ...r.results.map((row) => ({
                taskId: row.task_id,
                kind: row.kind,
                offsetMinutes: row.offset_minutes,
                remindAt: row.remind_at,
                dismissedAt: row.dismissed_at,
            })),
        );
    }
    const references = await knowledgeReferences(db, user, taskIds);
    const [labels, views, prefs] = await Promise.all([
        db.prepare("SELECT name, color FROM task_labels WHERE owner_email = ? ORDER BY position, name").bind(user.email).all<{ name: string; color: string }>(),
        db
            .prepare("SELECT name, definition_json FROM task_saved_views WHERE owner_email = ? ORDER BY position")
            .bind(user.email)
            .all<{ name: string; definition_json: string }>(),
        preferences(db, user.email),
    ]);
    return {
        format: EXPORT_FORMAT,
        version: EXPORT_VERSION,
        exportedAt: new Date().toISOString(),
        exportedBy: user.email,
        timeZone: prefs.timeZone,
        scope,
        projects: projects.results.map((p) => ({
            id: p.id,
            name: p.name,
            description: p.description,
            color: p.color,
            kind: p.kind,
            isInbox: !!p.is_inbox,
            status: p.status,
            startDate: p.start_date,
            targetDate: p.target_date,
            defaultView: p.default_view,
            role: p.role,
            createdAt: p.created_at,
            members: members.get(p.id) ?? [],
            sections: sections.get(p.id) ?? [],
        })),
        tasks: tasks.map((t) => {
            const rule = parseStoredRule(t.recurrence_json);
            return {
                id: t.id,
                projectId: t.project_id,
                sectionId: t.section_id,
                parentId: t.parent_id,
                title: t.title,
                description: t.description,
                status: t.status,
                priority: t.priority as Priority,
                dueDate: t.due_date,
                dueTime: t.due_time,
                deadline: t.deadline,
                recurrence: rule,
                rrule: rule ? toRRule(rule) : null,
                isMilestone: !!t.is_milestone,
                assignee: t.assignee_email,
                labels: parseJson<string[]>(t.labels_json, []).sort(),
                position: t.position,
                createdAt: t.created_at,
                createdBy: t.created_by,
                updatedAt: t.updated_at,
                updatedBy: t.updated_by,
                completedAt: t.completed_at,
                completedBy: t.completed_by,
                knowledgeObjectIds: (references.get(t.id) ?? []).flatMap((r) => (r.available ? [r.objectId] : [])),
                comments: comments.get(t.id) ?? [],
            };
        }),
        completions,
        labels: labels.results,
        savedFilters: views.results.map((v) => {
            const parsed = taskFilter.safeParse(parseJson(v.definition_json, {}));
            return { name: v.name, definition: parsed.success ? parsed.data : taskFilter.parse({}) };
        }),
        reminders,
    };
}

const CSV_HEADERS = [
    "Task ID",
    "Title",
    "Description",
    "Project",
    "Section",
    "Parent task ID",
    "Status",
    "Priority",
    "Due date",
    "Due time",
    "Deadline",
    "Repeats (RRULE)",
    "Labels",
    "Assignee",
    "Milestone",
    "Created",
    "Completed",
];

/** One row per task. Cells a spreadsheet would treat as formulas are neutralised (csvCell). */
export function exportCsv(data: TasksExport): string {
    const projects = new Map(data.projects.map((p) => [p.id, p]));
    const sectionName = new Map(data.projects.flatMap((p) => p.sections.map((s) => [s.id, s.name] as const)));
    const rows = data.tasks.map((t) =>
        [
            t.id,
            t.title,
            t.description,
            projects.get(t.projectId)?.name ?? "",
            t.sectionId ? (sectionName.get(t.sectionId) ?? "") : "",
            t.parentId ?? "",
            t.status,
            `${PRIORITY_LABELS[t.priority].short} ${PRIORITY_LABELS[t.priority].label}`,
            t.dueDate,
            t.dueTime,
            t.deadline,
            t.rrule?.replace(/\n/g, " ") ?? "",
            t.labels.join(", "),
            t.assignee,
            t.isMilestone,
            t.createdAt,
            t.completedAt,
        ]
            .map(csvCell)
            .join(","),
    );
    return "﻿" + [CSV_HEADERS.map(csvCell).join(","), ...rows].join("\r\n") + "\r\n";
}
