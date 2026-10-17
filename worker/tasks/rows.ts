// Row mapping shared by the task engine, the list queries and the page loaders.
import { parseStoredRule } from "../../src/shared/tasks/recurrence";
import type { Priority, TaskSummary } from "../../src/shared/tasks/types";
import { parseJson } from "../portal/db";

export interface TaskRow {
    id: string;
    project_id: string;
    section_id: string | null;
    parent_id: string | null;
    depth: number;
    title: string;
    excerpt: string;
    has_description: number;
    status: "open" | "completed";
    priority: number;
    due_date: string | null;
    due_time: string | null;
    deadline: string | null;
    recurrence_json: string | null;
    is_milestone: number;
    assignee_email: string | null;
    position: number;
    completed_at: string | null;
    completed_by: string | null;
    version: number;
    created_at: string;
    created_by: string;
    updated_at: string;
    updated_by: string;
    labels_json: string | null;
    sub_total: number;
    sub_open: number;
    comment_count: number;
}

/** Columns for a summary of `t` (task_items). Each count is an indexed lookup per row. */
export const TASK_COLUMNS = `t.id, t.project_id, t.section_id, t.parent_id, t.depth, t.title, substr(t.description, 1, 240) AS excerpt,
    length(t.description) > 0 AS has_description, t.status, t.priority, t.due_date, t.due_time, t.deadline, t.recurrence_json, t.is_milestone,
    t.assignee_email, t.position, t.completed_at, t.completed_by, t.version, t.created_at, t.created_by, t.updated_at, t.updated_by,
    (SELECT json_group_array(l.name) FROM task_item_labels l WHERE l.task_id = t.id) AS labels_json,
    (SELECT COUNT(*) FROM task_items c WHERE c.parent_id = t.id) AS sub_total,
    (SELECT COUNT(*) FROM task_items c WHERE c.parent_id = t.id AND c.status = 'open') AS sub_open,
    (SELECT COUNT(*) FROM task_comments k WHERE k.task_id = t.id) AS comment_count`;

export const toSummary = (row: TaskRow): TaskSummary => ({
    id: row.id,
    projectId: row.project_id,
    sectionId: row.section_id,
    parentId: row.parent_id,
    depth: row.depth,
    title: row.title,
    excerpt: row.excerpt.replace(/\s+/g, " ").trim(),
    hasDescription: !!row.has_description,
    status: row.status,
    priority: row.priority as Priority,
    dueDate: row.due_date,
    dueTime: row.due_time,
    deadline: row.deadline,
    recurrence: parseStoredRule(row.recurrence_json),
    isMilestone: !!row.is_milestone,
    assignee: row.assignee_email,
    labels: parseJson<string[]>(row.labels_json, []).sort((a, b) => a.localeCompare(b)),
    position: row.position,
    completedAt: row.completed_at,
    completedBy: row.completed_by,
    subtasks: { open: row.sub_open, total: row.sub_total },
    comments: row.comment_count,
    version: row.version,
    createdAt: row.created_at,
    createdBy: row.created_by,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
});
