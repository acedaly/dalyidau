// Comments on tasks: plain text, shown as text (never HTML), up to 5,000 characters. Members can
// read them; editors and owners can add them; authors edit their own; authors and project owners
// delete. The history records that a comment was added, never what it said.
import type { D1Database } from "@cloudflare/workers-types";
import { z } from "zod";
import type { PortalUser } from "../../src/shared/portal/types";
import { LIMITS, type TaskComment } from "../../src/shared/tasks/types";
import { newId, nowIso } from "../portal/db";
import { HttpError } from "../portal/http";
import { notFound, requireTask, requireWritable } from "./access";
import { activity } from "./activity";

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const body = z
    .string()
    .max(LIMITS.comment * 2)
    .transform((v) => v.replace(CONTROL, "").replace(/\r\n?/g, "\n").trim())
    .pipe(z.string().min(1, "Write a comment").max(LIMITS.comment, `Keep comments under ${LIMITS.comment.toLocaleString()} characters`));

export async function listComments(db: D1Database, user: PortalUser, taskId: string): Promise<TaskComment[]> {
    await requireTask(db, user, taskId);
    const rows = await db
        .prepare(
            `SELECT c.id, c.author_email, u.name, c.body, c.created_at, c.edited_at FROM task_comments c LEFT JOIN portal_users u ON u.email = c.author_email
             WHERE c.task_id = ? ORDER BY c.created_at LIMIT 200`,
        )
        .bind(taskId)
        .all<{ id: string; author_email: string; name: string | null; body: string; created_at: string; edited_at: string | null }>();
    return rows.results.map((c) => ({ id: c.id, author: c.author_email, authorName: c.name, body: c.body, createdAt: c.created_at, editedAt: c.edited_at }));
}

export async function addComment(db: D1Database, user: PortalUser, taskId: string, input: unknown) {
    const parsed = z.object({ body }).strict().parse(input);
    const task = await requireTask(db, user, taskId, "editor");
    requireWritable(task);
    await db.batch([
        db
            .prepare("INSERT INTO task_comments (id, task_id, author_email, body, created_at) VALUES (?, ?, ?, ?, ?)")
            .bind(newId("tcm"), taskId, user.email, parsed.body, nowIso()),
        activity(db, { projectId: task.project_id, taskId, actor: user.email, action: "comment.add" }),
    ]);
    return listComments(db, user, taskId);
}

/** The comment and the caller's role on its task; a comment on a task they can't see is a 404. */
const requireComment = async (db: D1Database, user: PortalUser, commentId: string) => {
    const row = await db
        .prepare("SELECT id, task_id, author_email FROM task_comments WHERE id = ?")
        .bind(commentId)
        .first<{ id: string; task_id: string; author_email: string }>();
    if (!row) throw notFound();
    const task = await requireTask(db, user, row.task_id);
    return { comment: row, task };
};

export async function editComment(db: D1Database, user: PortalUser, commentId: string, input: unknown) {
    const parsed = z.object({ body }).strict().parse(input);
    const { comment, task } = await requireComment(db, user, commentId);
    requireWritable(task);
    if (comment.author_email !== user.email || task.role === "viewer") throw new HttpError(403, "forbidden", "You can only edit your own comments");
    await db.prepare("UPDATE task_comments SET body = ?, edited_at = ? WHERE id = ?").bind(parsed.body, nowIso(), commentId).run();
    return listComments(db, user, comment.task_id);
}

export async function deleteComment(db: D1Database, user: PortalUser, commentId: string) {
    const { comment, task } = await requireComment(db, user, commentId);
    requireWritable(task);
    if (comment.author_email !== user.email && task.role !== "owner")
        throw new HttpError(403, "forbidden", "Only the author or a project owner can delete a comment");
    await db.batch([
        db.prepare("DELETE FROM task_comments WHERE id = ?").bind(commentId),
        activity(db, { projectId: task.project_id, taskId: task.id, actor: user.email, action: "comment.delete" }),
    ]);
    return listComments(db, user, comment.task_id);
}
