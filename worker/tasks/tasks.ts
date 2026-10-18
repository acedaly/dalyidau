// The task engine: create, edit, move, complete, reopen, skip, duplicate, delete and bulk changes.
//
// Every write is one D1 batch, so a task, its labels, its subtasks and its history entry change
// together or not at all. Edits carry the version the editor started from; a stale version
// changes nothing and returns 409 with the current task. Completing carries the occurrence the
// person saw, so a double click or two people completing at once records one completion. Creating
// can carry a client id, so a retried request returns the task the first one made instead of a copy.
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { z } from "zod";
import type { PortalUser } from "../../src/shared/portal/types";
import { addDays, isCalendarDate, isClockTime } from "../../src/shared/tasks/dates";
import {
    type RecurrenceRule,
    type SeriesExceptions,
    daysBetween,
    firstOnOrAfter,
    isOccurrence,
    nextOccurrence,
    parseStoredRule,
    recurrenceInput,
    shiftSeries,
    withAnchor,
} from "../../src/shared/tasks/recurrence";
import { LIMITS, MAX_DEPTH, type TaskDetail, type TaskSummary } from "../../src/shared/tasks/types";
import { requireObject } from "../knowledge/access";
import { can } from "../portal/auth";
import { chunk, isGuardFailure, newId, nowIso, placeholders, requireChange } from "../portal/db";
import { HttpError } from "../portal/http";
import { type TaskAccessRow, ensureInbox, notFound, preferences, requireProject, requireTask, requireWritable, todayFor } from "./access";
import { activity, listActivity } from "./activity";
import { knowledgeReferences } from "./knowledge";
import { CANCEL, defaultReminderStatement, relativeReminderStatements, remindersFor } from "./reminders";
import { TASK_COLUMNS, type TaskRow, toSummary } from "./rows";
import { turnStatement, undoTurnStatement } from "./turns";

/** A save based on an out-of-date version. The router answers 409 with the current task. */
export class TaskConflict extends Error {
    readonly code = "conflict";
    constructor(readonly current: TaskSummary | null) {
        super("This task changed since you opened it. Your changes haven't been saved.");
    }
}

/** Completing a task that still has open subtasks needs the person to say what happens to them. */
export class OpenSubtasks extends Error {
    readonly code = "open_subtasks";
    constructor(readonly count: number) {
        super(`This task has ${count} open subtask${count === 1 ? "" : "s"}.`);
    }
}

const invalid = (message: string) => new HttpError(422, "validation", message);

// --- Input ---------------------------------------------------------------------------------------

const id = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[a-z0-9]{14}$`), "Not a valid id");
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const title = z
    .string()
    .transform((v) => v.replace(CONTROL, "").replace(/\s+/g, " ").trim())
    .pipe(z.string().min(1, "Give the task a title").max(LIMITS.title, `Keep the title under ${LIMITS.title} characters`));
const description = z
    .string()
    .max(LIMITS.description * 2)
    .transform((v) => v.replace(CONTROL, "").replace(/\r\n?/g, "\n").trimEnd())
    .pipe(z.string().max(LIMITS.description, `Keep the description under ${LIMITS.description.toLocaleString()} characters`));
const calendarDate = z.string().refine(isCalendarDate, "Use a real date (YYYY-MM-DD)");
const clockTime = z.string().refine(isClockTime, "Use a time like 09:30");
const email = z.string().trim().toLowerCase().max(254).pipe(z.email("Not a valid person"));
const labelList = z.array(z.string().max(200)).max(LIMITS.labelsPerTask, `At most ${LIMITS.labelsPerTask} labels`);

const scheduleFields = {
    priority: z.number().int().min(1).max(4),
    dueDate: calendarDate.nullable(),
    dueTime: clockTime.nullable(),
    deadline: calendarDate.nullable(),
    recurrence: recurrenceInput.nullable(),
};

const createInput = z
    .object({
        title,
        description: description.default(""),
        projectId: id("tpj").optional(),
        sectionId: id("tsc").nullable().optional(),
        parentId: id("tsk").nullable().optional(),
        ...Object.fromEntries(Object.entries(scheduleFields).map(([k, v]) => [k, v.optional()])),
        labels: labelList.default([]),
        assignee: email.nullable().optional(),
        isMilestone: z.boolean().default(false),
        afterId: id("tsk").nullable().optional(),
        /** A random id from the browser for this draft: sending the same one again returns the same task. */
        clientId: z
            .string()
            .regex(/^[A-Za-z0-9_-]{8,64}$/, "Not a valid request id")
            .optional(),
        /** Knowledge objects to reference from the new task (e.g. captured from a Knowledge page). */
        knowledge: z
            .array(z.string().regex(/^kob_[a-z0-9]{14}$/, "Not a valid Knowledge object"))
            .max(5)
            .default([]),
    })
    .strict() as z.ZodType<{
    title: string;
    description: string;
    projectId?: string;
    sectionId?: string | null;
    parentId?: string | null;
    priority?: number;
    dueDate?: string | null;
    dueTime?: string | null;
    deadline?: string | null;
    recurrence?: z.output<typeof recurrenceInput> | null;
    labels: string[];
    assignee?: string | null;
    isMilestone: boolean;
    afterId?: string | null;
    clientId?: string;
    knowledge: string[];
}>;

const updateInput = z
    .object({
        version: z.number().int().min(1),
        title: title.optional(),
        description: description.optional(),
        priority: scheduleFields.priority.optional(),
        dueDate: scheduleFields.dueDate.optional(),
        dueTime: scheduleFields.dueTime.optional(),
        deadline: scheduleFields.deadline.optional(),
        recurrence: scheduleFields.recurrence.optional(),
        labels: labelList.optional(),
        assignee: email.nullable().optional(),
        isMilestone: z.boolean().optional(),
        /**
         * For a repeating task whose due date changes: "occurrence" (the default) moves only the
         * current occurrence and keeps the series where it was; "series" moves the series too, so
         * every later occurrence follows the new date.
         */
        scope: z.enum(["occurrence", "series"]).optional(),
    })
    .strict();

/** "@Errands " → "Errands". Duplicates (ignoring case) and blanks are dropped. */
export const normaliseLabels = (names: string[]): string[] => {
    const out: string[] = [];
    for (const raw of names) {
        const name = raw
            .replace(CONTROL, "")
            .replace(/^[@#]+/, "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, LIMITS.labelName);
        if (name && !out.some((n) => n.toLowerCase() === name.toLowerCase())) out.push(name);
    }
    return out;
};

// --- Reading -------------------------------------------------------------------------------------

export async function taskSummary(db: D1Database, taskId: string): Promise<TaskSummary | null> {
    const row = await db.prepare(`SELECT ${TASK_COLUMNS} FROM task_items t WHERE t.id = ?`).bind(taskId).first<TaskRow>();
    return row ? toSummary(row) : null;
}

/** Everything the task panel shows. The caller's access has been checked. */
export async function taskDetail(db: D1Database, user: PortalUser, access: TaskAccessRow): Promise<TaskDetail> {
    const [row, project, parent, subtasks, completions, comments, knowledge, reminders, history] = await Promise.all([
        db.prepare(`SELECT ${TASK_COLUMNS}, t.description FROM task_items t WHERE t.id = ?`).bind(access.id).first<TaskRow & { description: string }>(),
        db.prepare("SELECT id, name, color, kind, is_inbox FROM task_projects WHERE id = ?").bind(access.project_id).first<{
            id: string;
            name: string;
            color: TaskDetail["project"]["color"];
            kind: "personal" | "shared";
            is_inbox: number;
        }>(),
        access.parent_id ? db.prepare("SELECT id, title FROM task_items WHERE id = ?").bind(access.parent_id).first<{ id: string; title: string }>() : null,
        db.prepare(`SELECT ${TASK_COLUMNS} FROM task_items t WHERE t.parent_id = ? ORDER BY t.status = 'completed', t.position`).bind(access.id).all<TaskRow>(),
        db
            .prepare("SELECT id, kind, occurrence_date, next_date, at, by, undone_at FROM task_completions WHERE task_id = ? ORDER BY id DESC LIMIT 20")
            .bind(access.id)
            .all<{
                id: number;
                kind: "completed" | "skipped";
                occurrence_date: string | null;
                next_date: string | null;
                at: string;
                by: string;
                undone_at: string | null;
            }>(),
        db
            .prepare(
                `SELECT c.id, c.author_email, u.name, c.body, c.created_at, c.edited_at FROM task_comments c LEFT JOIN portal_users u ON u.email = c.author_email
                 WHERE c.task_id = ? ORDER BY c.created_at LIMIT 200`,
            )
            .bind(access.id)
            .all<{ id: string; author_email: string; name: string | null; body: string; created_at: string; edited_at: string | null }>(),
        knowledgeReferences(db, user, [access.id]),
        remindersFor(db, user.email, access.id),
        listActivity(db, user.email, { taskId: access.id, limit: 30 }),
    ]);
    if (!row || !project) throw notFound();
    return {
        task: { ...toSummary(row), description: row.description },
        project: { id: project.id, name: project.name, color: project.color, kind: project.kind, isInbox: !!project.is_inbox, role: access.role },
        parent: parent ?? null,
        subtasks: subtasks.results.map(toSummary),
        completions: completions.results.map((c) => ({
            id: c.id,
            kind: c.kind,
            occurrenceDate: c.occurrence_date,
            nextDate: c.next_date,
            at: c.at,
            by: c.by,
            undoneAt: c.undone_at,
        })),
        comments: comments.results.map((c) => ({
            id: c.id,
            author: c.author_email,
            authorName: c.name,
            body: c.body,
            createdAt: c.created_at,
            editedAt: c.edited_at,
        })),
        knowledge: knowledge.get(access.id) ?? [],
        reminders,
        // Only this task's own entries, and only from projects the caller is in now.
        activity: history,
    };
}

/** The task and its descendants (at most four levels, so this is always small). */
export async function subtree(db: D1Database, rootId: string): Promise<{ id: string; depth: number; status: string }[]> {
    const rows = await db
        .prepare(
            `WITH RECURSIVE tree(id, depth, status) AS (
                SELECT id, depth, status FROM task_items WHERE id = ?
                UNION ALL SELECT c.id, c.depth, c.status FROM task_items c JOIN tree ON c.parent_id = tree.id LIMIT 500
             ) SELECT id, depth, status FROM tree`,
        )
        .bind(rootId)
        .all<{ id: string; depth: number; status: string }>();
    return rows.results;
}

// --- Shared checks -------------------------------------------------------------------------------

/** An assignee must be an editor or owner of the task's project. Personal projects have no assignees. */
export async function checkAssignee(db: D1Database, projectId: string, kind: "personal" | "shared", assignee: string | null | undefined) {
    if (!assignee) return null;
    if (kind === "personal") throw invalid("Only tasks in shared projects can be assigned");
    const member = await db
        .prepare("SELECT role FROM task_project_members WHERE project_id = ? AND email = ?")
        .bind(projectId, assignee)
        .first<{ role: string }>();
    if (!member || member.role === "viewer") throw invalid("You can only assign tasks to the project's editors and owners");
    return assignee;
}

export async function checkSection(db: D1Database, projectId: string, sectionId: string | null | undefined) {
    if (!sectionId) return null;
    const row = await db.prepare("SELECT id FROM task_sections WHERE id = ? AND project_id = ?").bind(sectionId, projectId).first();
    if (!row) throw invalid("That section isn't in this project");
    return sectionId;
}

interface Schedule {
    due_date: string | null;
    due_time: string | null;
    deadline: string | null;
    recurrence_json: string | null;
}

/**
 * Works out the stored dates from what's being changed. A repeat always has a date: setting one
 * without a date starts it on its first occurrence from today, and its anchor is the first date it
 * falls on. Clearing the date of a repeating task is refused rather than silently ending the repeat.
 *
 * Moving a repeating task's date changes only that occurrence unless `scope` is "series": the rule
 * keeps its anchor, so completing the moved occurrence carries on along the original series. With
 * "series" the rule itself moves to the new date (shiftSeries).
 */
export function resolveSchedule(
    current: Schedule,
    change: {
        dueDate?: string | null;
        dueTime?: string | null;
        deadline?: string | null;
        recurrence?: z.output<typeof recurrenceInput> | null;
        scope?: "occurrence" | "series";
    },
    today: string,
): Schedule {
    let due = change.dueDate !== undefined ? change.dueDate : current.due_date;
    let time = change.dueTime !== undefined ? change.dueTime : current.due_time;
    const deadline = change.deadline !== undefined ? change.deadline : current.deadline;
    let rule: RecurrenceRule | null = parseStoredRule(current.recurrence_json);
    if (change.recurrence === null) rule = null;
    else if (change.recurrence) {
        const start = due ?? today;
        const draft = withAnchor(change.recurrence, start);
        const first = firstOnOrAfter(draft, start);
        if (!first) throw invalid("That repeat ends before it starts");
        due = first;
        rule = withAnchor(change.recurrence, first);
    } else if (rule && !due) throw invalid("A repeating task needs a date. Stop it repeating first.");
    else if (rule && due && change.scope === "series" && current.due_date && due !== current.due_date) {
        const moved = shiftSeries(rule, current.due_date, due);
        if (!moved) throw invalid("That date is after the repeat ends");
        rule = moved;
    }
    if (!due) time = null;
    if (change.dueTime && !due) throw invalid("Choose a date for that time");
    return { due_date: due, due_time: time, deadline, recurrence_json: rule ? JSON.stringify(rule) : null };
}

/** Sort keys for siblings, with the moved/new task placed after `afterId` (or at the end). */
export async function placement(
    db: D1Database,
    where: { projectId: string; sectionId: string | null; parentId: string | null },
    options: { afterId?: string | null; beforeId?: string | null; exclude?: string },
): Promise<{ position: number; renumber: D1PreparedStatement[] }> {
    const rows = (
        await db
            .prepare("SELECT id, position FROM task_items WHERE project_id = ? AND section_id IS ? AND parent_id IS ? ORDER BY position, id")
            .bind(where.projectId, where.sectionId, where.parentId)
            .all<{ id: string; position: number }>()
    ).results.filter((r) => r.id !== options.exclude);
    let index = rows.length; // insert before rows[index]
    if (options.afterId) {
        const i = rows.findIndex((r) => r.id === options.afterId);
        if (i === -1) throw invalid("That task isn't in the same list");
        index = i + 1;
    } else if (options.beforeId) {
        const i = rows.findIndex((r) => r.id === options.beforeId);
        if (i === -1) throw invalid("That task isn't in the same list");
        index = i;
    }
    const before = rows[index - 1]?.position;
    const after = rows[index]?.position;
    let position = before === undefined ? (after === undefined ? 1 : after - 1) : after === undefined ? before + 1 : (before + after) / 2;
    const renumber: D1PreparedStatement[] = [];
    // Fractional positions eventually run out of room between two neighbours; then renumber the list.
    if (before !== undefined && after !== undefined && after - before < 1e-6) {
        rows.forEach((r, i) => renumber.push(db.prepare("UPDATE task_items SET position = ? WHERE id = ?").bind(i < index ? i + 1 : i + 2, r.id)));
        position = index + 1;
    }
    return { position, renumber };
}

export const labelStatements = (db: D1Database, taskId: string, labels: string[], actor: string, now: string) => [
    ...labels.map((name) =>
        db.prepare("INSERT OR IGNORE INTO task_item_labels (task_id, name, added_by, added_at) VALUES (?, ?, ?, ?)").bind(taskId, name, actor, now),
    ),
    // Labels typed onto a task become the person's own labels too, so they show in their list.
    ...labels.map((name) =>
        db
            .prepare("INSERT OR IGNORE INTO task_labels (id, owner_email, name, color, position, created_at, updated_at) VALUES (?, ?, ?, 'gray', 0, ?, ?)")
            .bind(newId("tlb"), actor, name, now, now),
    ),
];

// --- Create --------------------------------------------------------------------------------------

/** The task an earlier request with this client id created, if there was one and the caller can still see it. */
async function replayed(db: D1Database, user: PortalUser, clientId: string | undefined): Promise<TaskSummary | null> {
    if (!clientId) return null;
    const row = await db
        .prepare(
            `SELECT t.id FROM task_items t JOIN task_project_members m ON m.project_id = t.project_id AND m.email = ?
             WHERE t.created_by = ? AND t.client_id = ?`,
        )
        .bind(user.email, user.email, clientId)
        .first<{ id: string }>();
    return row ? taskSummary(db, row.id) : null;
}

export interface CreateOptions {
    /** Statements written in the same batch as the new task (e.g. remembering it as a review's next action). */
    extra?: (taskId: string, projectId: string) => D1PreparedStatement[];
    /** Refuse anything but this project (a review's next actions belong to the reviewed project). */
    requireProjectId?: string;
    /** More checks against the destination project, before anything is written. */
    check?: (projectId: string, kind: "personal" | "shared") => Promise<void>;
}

export async function createTask(
    db: D1Database,
    user: PortalUser,
    input: unknown,
    options: CreateOptions = {},
): Promise<{ task: TaskSummary; replayed: boolean }> {
    const body = createInput.parse(input);
    const earlier = await replayed(db, user, body.clientId);
    if (earlier) return { task: earlier, replayed: true };
    let projectId: string;
    let kind: "personal" | "shared";
    let sectionId: string | null = null;
    let parentId: string | null = null;
    let depth = 0;
    if (body.parentId) {
        const parent = await requireTask(db, user, body.parentId, "editor");
        requireWritable(parent);
        if (parent.depth >= MAX_DEPTH) throw invalid(`Subtasks can nest at most ${MAX_DEPTH} levels deep`);
        projectId = parent.project_id;
        kind = parent.project_kind;
        sectionId = parent.section_id;
        parentId = parent.id;
        depth = parent.depth + 1;
    } else {
        const project = await requireProject(db, user, body.projectId ?? (await ensureInbox(db, user.email)), "editor");
        requireWritable(project);
        projectId = project.id;
        kind = project.kind;
        sectionId = await checkSection(db, projectId, body.sectionId);
    }
    if (options.requireProjectId && projectId !== options.requireProjectId) throw invalid("This task has to go in the project being reviewed");
    await options.check?.(projectId, kind);
    const assignee = await checkAssignee(db, projectId, kind, body.assignee);
    // Knowledge's own check for each object: 404 for anything outside the caller's spaces.
    const knowledge = [...new Set(body.knowledge)];
    if (knowledge.length && !can(user, "knowledge.use")) throw new HttpError(403, "forbidden", "You don't have access to Knowledge");
    for (const objectId of knowledge) if ((await requireObject(db, user, objectId)).status === "trashed") throw notFound();
    const prefs = await preferences(db, user.email);
    const today = await todayFor(db, user.email);
    const schedule = resolveSchedule({ due_date: null, due_time: null, deadline: null, recurrence_json: null }, body, today);
    const labels = normaliseLabels(body.labels);
    const { position, renumber } = await placement(db, { projectId, sectionId, parentId }, { afterId: body.afterId });
    const taskId = newId("tsk");
    const now = nowIso();
    const statements = [
        ...renumber,
        db
            .prepare(
                `INSERT INTO task_items (id, project_id, section_id, parent_id, depth, title, description, priority, due_date, due_time, deadline,
                    recurrence_json, is_milestone, assignee_email, position, created_by, updated_by, created_at, updated_at, client_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
                taskId,
                projectId,
                sectionId,
                parentId,
                depth,
                body.title,
                body.description,
                body.priority ?? 4,
                schedule.due_date,
                schedule.due_time,
                schedule.deadline,
                schedule.recurrence_json,
                body.isMilestone ? 1 : 0,
                assignee,
                position,
                user.email,
                user.email,
                now,
                now,
                body.clientId ?? null,
            ),
        ...labelStatements(db, taskId, labels, user.email, now),
        activity(db, {
            projectId,
            taskId,
            actor: user.email,
            action: parentId ? "subtask.create" : "task.create",
            changes: { dueDate: schedule.due_date, priority: body.priority ?? 4, assignee },
        }),
        ...knowledge.map((objectId) =>
            db
                .prepare("INSERT INTO task_knowledge_links (id, task_id, object_id, added_by, added_at) VALUES (?, ?, ?, ?, ?)")
                .bind(newId("tkl"), taskId, objectId, user.email, now),
        ),
        // The history says a reference was added, never which object.
        ...(knowledge.length ? [activity(db, { projectId, taskId, actor: user.email, action: "knowledge.link" })] : []),
        // The person's default reminder, on dated tasks.
        ...(schedule.due_date && prefs.remindersEnabled && prefs.defaultReminderMinutes !== null
            ? [defaultReminderStatement(db, taskId, user.email, schedule.due_date, schedule.due_time, prefs.defaultReminderMinutes, prefs.timeZone)]
            : []),
        ...(options.extra?.(taskId, projectId) ?? []),
    ];
    try {
        await db.batch(statements);
    } catch (error) {
        // Two copies of one request at the same moment: the unique index let only the first insert in.
        if (body.clientId && /UNIQUE constraint failed: task_items\.created_by, task_items\.client_id/.test(String((error as Error)?.message))) {
            const first = await replayed(db, user, body.clientId);
            if (first) return { task: first, replayed: true };
        }
        throw error;
    }
    return { task: (await taskSummary(db, taskId))!, replayed: false };
}

// --- Update --------------------------------------------------------------------------------------

export async function updateTask(db: D1Database, user: PortalUser, taskId: string, input: unknown): Promise<TaskSummary> {
    const body = updateInput.parse(input);
    const task = await requireTask(db, user, taskId, "editor");
    requireWritable(task);
    if (task.version !== body.version) throw new TaskConflict(await taskSummary(db, taskId));
    const today = await todayFor(db, user.email);
    const schedule = resolveSchedule(task, body, today);
    const assignee = body.assignee !== undefined ? await checkAssignee(db, task.project_id, task.project_kind, body.assignee) : task.assignee_email;
    const current = (await db.prepare("SELECT title, description FROM task_items WHERE id = ?").bind(taskId).first<{ title: string; description: string }>())!;
    const next = {
        title: body.title ?? current.title,
        description: body.description ?? current.description,
        priority: body.priority ?? task.priority,
        isMilestone: body.isMilestone ?? !!task.is_milestone,
    };

    const changes: Record<string, unknown> = {};
    if (next.title !== current.title) changes.title = true;
    if (next.description !== current.description) changes.description = true;
    if (next.priority !== task.priority) changes.priority = next.priority;
    if (schedule.due_date !== task.due_date) changes.dueDate = schedule.due_date;
    if (schedule.due_time !== task.due_time) changes.dueTime = schedule.due_time;
    if (schedule.deadline !== task.deadline) changes.deadline = schedule.deadline;
    if (schedule.recurrence_json !== task.recurrence_json) changes.recurrence = true;
    if (body.scope === "series" && changes.recurrence) changes.series = true;
    if (assignee !== task.assignee_email) changes.assignee = assignee;
    if (next.isMilestone !== !!task.is_milestone) changes.isMilestone = next.isMilestone;
    const labels = body.labels ? normaliseLabels(body.labels) : null;
    if (labels) changes.labels = true;

    const now = nowIso();
    const statements: D1PreparedStatement[] = [
        db
            .prepare(
                `UPDATE task_items SET title = ?, description = ?, priority = ?, due_date = ?, due_time = ?, deadline = ?, recurrence_json = ?,
                    assignee_email = ?, is_milestone = ?, version = version + 1, updated_by = ?, updated_at = ?
                 WHERE id = ? AND version = ?`,
            )
            .bind(
                next.title,
                next.description,
                next.priority,
                schedule.due_date,
                schedule.due_time,
                schedule.deadline,
                schedule.recurrence_json,
                assignee,
                next.isMilestone ? 1 : 0,
                user.email,
                now,
                taskId,
                body.version,
            ),
        requireChange(db),
    ];
    if (labels)
        statements.push(db.prepare("DELETE FROM task_item_labels WHERE task_id = ?").bind(taskId), ...labelStatements(db, taskId, labels, user.email, now));
    // Exceptions belong to the series they were made for; a new or moved rule starts without them.
    if (changes.recurrence) statements.push(db.prepare("DELETE FROM task_recurrence_exceptions WHERE task_id = ?").bind(taskId));
    if ("dueDate" in changes || "dueTime" in changes) statements.push(...(await relativeReminderStatements(db, taskId, schedule.due_date, schedule.due_time)));
    // Typing in the panel saves often; record a field change once, not every keystroke: a title or
    // description edit within ten minutes of the same person's last one adds no new entry.
    const onlyText = Object.keys(changes).every((k) => k === "title" || k === "description");
    if (Object.keys(changes).length) {
        statements.push(
            activity(
                db,
                { projectId: task.project_id, taskId, actor: user.email, action: "task.update", changes },
                onlyText
                    ? "WHERE NOT EXISTS (SELECT 1 FROM task_activity WHERE task_id = ? AND actor = ? AND action = 'task.update' AND at > ? AND id = (SELECT MAX(id) FROM task_activity WHERE task_id = ?))"
                    : "",
                onlyText ? [taskId, user.email, new Date(Date.now() - 10 * 60_000).toISOString(), taskId] : [],
            ),
        );
    }
    try {
        await db.batch(statements);
    } catch (error) {
        if (isGuardFailure(error)) throw new TaskConflict(await taskSummary(db, taskId));
        throw error;
    }
    return (await taskSummary(db, taskId))!;
}

// --- Move ----------------------------------------------------------------------------------------

const moveInput = z
    .object({
        projectId: id("tpj").optional(),
        sectionId: id("tsc").nullable().optional(),
        parentId: id("tsk").nullable().optional(),
        afterId: id("tsk").nullable().optional(),
        beforeId: id("tsk").nullable().optional(),
    })
    .strict();

/**
 * Moves a task (with its subtasks) to another project, section or parent, and/or to a new place
 * among its siblings. Subtasks always live in their parent's project and section. Moving under one
 * of its own subtasks, or deeper than the limit, is refused. Assignees and reminders that wouldn't
 * be allowed in the new project are removed in the same batch.
 */
export async function moveTask(db: D1Database, user: PortalUser, taskId: string, input: unknown): Promise<TaskSummary> {
    const body = moveInput.parse(input);
    const task = await requireTask(db, user, taskId, "editor");
    requireWritable(task);

    let projectId = task.project_id;
    let kind = task.project_kind;
    let parentId = body.parentId !== undefined ? body.parentId : task.parent_id;
    let sectionId: string | null;
    let parentDepth = -1;
    if (parentId) {
        const parent = await requireTask(db, user, parentId, "editor");
        requireWritable(parent);
        projectId = parent.project_id;
        kind = parent.project_kind;
        sectionId = parent.section_id;
        parentDepth = parent.depth;
    } else {
        if (body.projectId && body.projectId !== task.project_id) {
            const project = await requireProject(db, user, body.projectId, "editor");
            requireWritable(project);
            projectId = project.id;
            kind = project.kind;
        }
        parentId = null;
        sectionId = body.sectionId !== undefined ? await checkSection(db, projectId, body.sectionId) : projectId === task.project_id ? task.section_id : null;
    }

    const tree = await subtree(db, taskId);
    if (parentId && tree.some((n) => n.id === parentId)) throw invalid("A task can't go inside one of its own subtasks");
    const newDepth = parentDepth + 1;
    const height = Math.max(...tree.map((n) => n.depth)) - task.depth;
    if (newDepth + height > MAX_DEPTH) throw invalid(`Subtasks can nest at most ${MAX_DEPTH} levels deep`);

    const { position, renumber } = await placement(db, { projectId, sectionId, parentId }, { afterId: body.afterId, beforeId: body.beforeId, exclude: taskId });
    const ids = tree.map((n) => n.id);
    const now = nowIso();
    const movingProject = projectId !== task.project_id;
    const statements: D1PreparedStatement[] = [...renumber];
    for (const part of chunk(ids, 40)) {
        if (movingProject) {
            // Before the project changes: anyone who can't be assigned there is unassigned, and
            // reminders belonging to people who aren't members there go.
            statements.push(
                db
                    .prepare(
                        `UPDATE task_items SET assignee_email = NULL WHERE id IN (${placeholders(part.length)}) AND assignee_email IS NOT NULL
                         AND (? = 'personal' OR assignee_email NOT IN (SELECT email FROM task_project_members WHERE project_id = ? AND role <> 'viewer'))`,
                    )
                    .bind(...part, kind, projectId),
                db
                    .prepare(
                        `DELETE FROM task_reminders WHERE task_id IN (${placeholders(part.length)})
                         AND owner_email NOT IN (SELECT email FROM task_project_members WHERE project_id = ?)`,
                    )
                    .bind(...part, projectId),
                // Routines: only people who can be assigned there keep taking turns.
                db
                    .prepare(
                        `DELETE FROM task_routine_participants WHERE routine_id IN (SELECT id FROM task_routines WHERE task_id IN (${placeholders(part.length)}))
                         AND (? = 'personal' OR email NOT IN (SELECT email FROM task_project_members WHERE project_id = ? AND role <> 'viewer'))`,
                    )
                    .bind(...part, kind, projectId),
                // Shared goals never draw on personal projects, so a task moved into one leaves them.
                ...(kind === "personal"
                    ? [
                          db
                              .prepare(
                                  `DELETE FROM task_goal_links WHERE task_id IN (${placeholders(part.length)})
                                   AND goal_id IN (SELECT id FROM task_goals WHERE kind = 'shared')`,
                              )
                              .bind(...part),
                      ]
                    : []),
            );
        }
    }
    // One statement moves the whole subtree, so the composite foreign keys are checked once it's consistent.
    statements.push(
        db
            .prepare(
                `UPDATE task_items SET project_id = ?, section_id = ?, depth = depth + ?,
                    parent_id = CASE WHEN id = ? THEN ? ELSE parent_id END,
                    position = CASE WHEN id = ? THEN ? ELSE position END,
                    version = version + 1, updated_by = ?, updated_at = ?
                 WHERE id IN (${placeholders(ids.length)})`,
            )
            .bind(projectId, sectionId, newDepth - task.depth, taskId, parentId, taskId, position, user.email, now, ...ids),
    );
    if (movingProject) {
        statements.push(
            activity(db, { projectId: task.project_id, taskId, actor: user.email, action: "task.move_out", changes: { count: ids.length } }),
            activity(db, { projectId, taskId, actor: user.email, action: "task.move_in", changes: { count: ids.length } }),
        );
    } else if (sectionId !== task.section_id || parentId !== task.parent_id) {
        statements.push(activity(db, { projectId, taskId, actor: user.email, action: "task.move", changes: { section: true } }));
    }
    await db.batch(statements);
    return (await taskSummary(db, taskId))!;
}

// --- Complete, skip and reopen -------------------------------------------------------------------

const completeInput = z
    .object({
        /** The due date the person saw. For a repeating task it identifies the occurrence. */
        occurrence: calendarDate.nullable().optional(),
        includeSubtasks: z.boolean().default(false),
    })
    .strict();

export interface CompletionResult {
    task: TaskSummary;
    /** True when this request found the occurrence already completed (a repeat click). */
    alreadyDone: boolean;
    /** For repeating tasks: where it moved to, or null if the series ended. */
    nextDate: string | null;
}

/** Statements that complete one task or occurrence; shared by single and bulk completion. */
async function completionStatements(
    db: D1Database,
    user: PortalUser,
    task: TaskAccessRow,
    options: { occurrence?: string | null; includeSubtasks: boolean; skip?: boolean },
    today: string,
): Promise<{ statements: D1PreparedStatement[]; nextDate: string | null }> {
    const now = nowIso();
    const tree = await subtree(db, task.id);
    const descendants = tree.filter((n) => n.id !== task.id);
    const openBelow = descendants.filter((n) => n.status === "open");
    if (openBelow.length && !options.includeSubtasks && !options.skip) throw new OpenSubtasks(openBelow.length);
    const rule = parseStoredRule(task.recurrence_json);
    const occurrence = options.occurrence !== undefined ? options.occurrence : task.due_date;
    const statements: D1PreparedStatement[] = [];
    const kind = options.skip ? "skipped" : "completed";
    const next =
        rule && occurrence ? nextOccurrence(rule, occurrence, today, rule.basis === "scheduled" ? await seriesExceptions(db, task.id) : undefined) : null;

    if (rule && occurrence && next) {
        // Move along the series. Guarded on the occurrence, so a second click (or someone else
        // completing it at the same moment) changes nothing and records nothing.
        const shift = daysBetween(occurrence, next);
        statements.push(
            db
                .prepare(
                    `UPDATE task_items SET due_date = ?, deadline = CASE WHEN deadline IS NULL THEN NULL ELSE date(deadline, ?) END,
                        version = version + 1, updated_by = ?, updated_at = ?
                     WHERE id = ? AND status = 'open' AND due_date = ?`,
                )
                .bind(next, `${shift >= 0 ? "+" : ""}${shift} days`, user.email, now, task.id, occurrence),
            requireChange(db),
            db
                .prepare("INSERT INTO task_completions (task_id, kind, occurrence_date, next_date, at, by) VALUES (?, ?, ?, ?, ?, ?)")
                .bind(task.id, kind, occurrence, next, now, user.email),
        );
        // A repeating task's subtasks are a checklist: they start again for the next occurrence.
        if (descendants.length && !options.skip) {
            statements.push(
                db
                    .prepare(
                        `UPDATE task_items SET status = 'open', completed_at = NULL, completed_by = NULL, version = version + 1, updated_by = ?, updated_at = ?
                         WHERE id IN (${placeholders(descendants.length)}) AND status = 'completed'`,
                    )
                    .bind(user.email, now, ...descendants.map((d) => d.id)),
            );
        }
        statements.push(...(await relativeReminderStatements(db, task.id, next, task.due_time)));
        // A routine whose people take turns passes to the next person when an occurrence is done (not skipped).
        const turn = options.skip ? null : await turnStatement(db, task.id, task.project_id, task.assignee_email);
        if (turn) statements.push(turn.statement);
        statements.push(
            activity(db, {
                projectId: task.project_id,
                taskId: task.id,
                actor: user.email,
                action: options.skip ? "task.skip" : "task.complete",
                changes: { occurrence, next, ...(turn ? { assignee: turn.next } : {}) },
            }),
        );
        return { statements, nextDate: next };
    }
    if (options.skip) throw invalid("Only a repeating task with more occurrences can be skipped");

    // A one-off task, or the last occurrence of a series.
    statements.push(
        db
            .prepare(
                `UPDATE task_items SET status = 'completed', completed_at = ?, completed_by = ?, version = version + 1, updated_by = ?, updated_at = ?
                 WHERE id = ? AND status = 'open'`,
            )
            .bind(now, user.email, user.email, now, task.id),
        requireChange(db),
        db
            .prepare("INSERT INTO task_completions (task_id, kind, occurrence_date, next_date, at, by) VALUES (?, 'completed', ?, NULL, ?, ?)")
            .bind(task.id, occurrence, now, user.email),
    );
    if (openBelow.length) {
        const ids = openBelow.map((d) => d.id);
        statements.push(
            db
                .prepare(
                    `INSERT INTO task_completions (task_id, kind, occurrence_date, next_date, at, by)
                     SELECT id, 'completed', due_date, NULL, ?, ? FROM task_items WHERE id IN (${placeholders(ids.length)}) AND status = 'open'`,
                )
                .bind(now, user.email, ...ids),
            db
                .prepare(
                    `UPDATE task_items SET status = 'completed', completed_at = ?, completed_by = ?, version = version + 1, updated_by = ?, updated_at = ?
                     WHERE id IN (${placeholders(ids.length)}) AND status = 'open'`,
                )
                .bind(now, user.email, user.email, now, ...ids),
        );
    }
    statements.push(
        db.prepare(`UPDATE task_reminders SET dismissed_at = ?, ${CANCEL} WHERE task_id = ? AND dismissed_at IS NULL`).bind(now, task.id),
        activity(db, {
            projectId: task.project_id,
            taskId: task.id,
            actor: user.email,
            action: "task.complete",
            changes: { occurrence, ...(openBelow.length ? { count: openBelow.length } : {}) },
        }),
    );
    return { statements, nextDate: null };
}

/** A repeating task's skipped and moved occurrences. */
export async function seriesExceptions(db: D1Database, taskId: string): Promise<SeriesExceptions> {
    return (await exceptionsFor(db, [taskId])).get(taskId) ?? { skip: new Set(), moves: new Map() };
}

/** Exceptions for several repeating tasks at once (Upcoming and the calendar), in chunks. */
export async function exceptionsFor(db: D1Database, taskIds: string[]): Promise<Map<string, SeriesExceptions>> {
    const out = new Map<string, SeriesExceptions>();
    for (const part of chunk(taskIds, 50)) {
        if (!part.length) continue;
        const rows = await db
            .prepare(`SELECT task_id, occurrence_date, kind, moved_to FROM task_recurrence_exceptions WHERE task_id IN (${placeholders(part.length)})`)
            .bind(...part)
            .all<{ task_id: string; occurrence_date: string; kind: "skip" | "move"; moved_to: string | null }>();
        for (const r of rows.results) {
            const entry = out.get(r.task_id) ?? { skip: new Set<string>(), moves: new Map<string, string>() };
            if (r.kind === "skip") entry.skip.add(r.occurrence_date);
            else entry.moves.set(r.occurrence_date, r.moved_to!);
            out.set(r.task_id, entry);
        }
    }
    return out;
}

const occurrenceInput = z.discriminatedUnion("action", [
    z.object({ action: z.literal("skip"), date: calendarDate }).strict(),
    z.object({ action: z.literal("move"), date: calendarDate, to: calendarDate }).strict(),
    z.object({ action: z.literal("restore"), date: calendarDate }).strict(),
]);

/**
 * Changes one later occurrence of a repeating task without touching the rest of the series: skip
 * it, move it to another date, or restore it. `date` is the series date (from Upcoming or the
 * calendar). Only for occurrences after the current one, on a fixed schedule; the current
 * occurrence is changed by rescheduling or skipping the task itself.
 */
export async function changeOccurrence(db: D1Database, user: PortalUser, taskId: string, input: unknown): Promise<TaskSummary> {
    const body = occurrenceInput.parse(input);
    const task = await requireTask(db, user, taskId, "editor");
    requireWritable(task);
    const rule = parseStoredRule(task.recurrence_json);
    if (!rule || rule.basis !== "scheduled" || !task.due_date) throw invalid("Only tasks that repeat on a fixed schedule have later occurrences to change");
    if (body.date <= task.due_date || !isOccurrence(rule, body.date)) throw invalid("That isn't a later occurrence of this task");
    if (body.action === "move" && body.to <= task.due_date) throw invalid("Move it to a date after the current occurrence");
    const now = nowIso();
    await db.batch([
        body.action === "restore"
            ? db.prepare("DELETE FROM task_recurrence_exceptions WHERE task_id = ? AND occurrence_date = ?").bind(taskId, body.date)
            : db
                  .prepare(
                      `INSERT INTO task_recurrence_exceptions (task_id, occurrence_date, kind, moved_to, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)
                       ON CONFLICT(task_id, occurrence_date) DO UPDATE SET kind = excluded.kind, moved_to = excluded.moved_to, created_by = excluded.created_by, created_at = excluded.created_at`,
                  )
                  .bind(taskId, body.date, body.action, body.action === "move" ? body.to : null, user.email, now),
        db.prepare("UPDATE task_items SET version = version + 1, updated_by = ?, updated_at = ? WHERE id = ?").bind(user.email, now, taskId),
        activity(db, {
            projectId: task.project_id,
            taskId,
            actor: user.email,
            action: "task.occurrence",
            changes: { occurrence: body.date, change: body.action, ...(body.action === "move" ? { to: body.to } : {}) },
        }),
    ]);
    return (await taskSummary(db, taskId))!;
}

/** Whether a repeat of this request has already been recorded: the guard failed because it worked the first time. */
async function alreadyCompleted(db: D1Database, taskId: string, occurrence: string | null | undefined) {
    const latest = await db
        .prepare("SELECT occurrence_date FROM task_completions WHERE task_id = ? AND undone_at IS NULL ORDER BY id DESC LIMIT 1")
        .bind(taskId)
        .first<{ occurrence_date: string | null }>();
    if (!latest) return false;
    return occurrence === undefined || latest.occurrence_date === occurrence;
}

export async function completeTask(db: D1Database, user: PortalUser, taskId: string, input: unknown, skip = false): Promise<CompletionResult> {
    const body = completeInput.parse(input);
    const task = await requireTask(db, user, taskId, "editor");
    requireWritable(task);
    if (task.status === "completed" && !skip) {
        return { task: (await taskSummary(db, taskId))!, alreadyDone: true, nextDate: null };
    }
    const today = await todayFor(db, user.email);
    const { statements, nextDate } = await completionStatements(db, user, task, { ...body, skip }, today);
    try {
        await db.batch(statements);
    } catch (error) {
        if (isGuardFailure(error)) {
            if (await alreadyCompleted(db, taskId, body.occurrence)) return { task: (await taskSummary(db, taskId))!, alreadyDone: true, nextDate: null };
            throw new TaskConflict(await taskSummary(db, taskId));
        }
        throw error;
    }
    return { task: (await taskSummary(db, taskId))!, alreadyDone: false, nextDate };
}

/**
 * Reopens a completed task, or undoes the latest completion (or skip) of a repeating task: its due
 * date goes back to the occurrence that was completed, provided it hasn't moved on since. The
 * completion stays in the history, marked undone.
 */
export async function reopenTask(db: D1Database, user: PortalUser, taskId: string): Promise<TaskSummary> {
    const task = await requireTask(db, user, taskId, "editor");
    requireWritable(task);
    const latest = await db
        .prepare("SELECT id, kind, occurrence_date, next_date FROM task_completions WHERE task_id = ? AND undone_at IS NULL ORDER BY id DESC LIMIT 1")
        .bind(taskId)
        .first<{ id: number; kind: "completed" | "skipped"; occurrence_date: string | null; next_date: string | null }>();
    const now = nowIso();
    const statements: D1PreparedStatement[] = [];
    if (task.status === "completed") {
        statements.push(
            db
                .prepare(
                    `UPDATE task_items SET status = 'open', completed_at = NULL, completed_by = NULL, version = version + 1, updated_by = ?, updated_at = ?
                     WHERE id = ? AND status = 'completed'`,
                )
                .bind(user.email, now, taskId),
            requireChange(db),
        );
    } else if (latest?.next_date && task.due_date === latest.next_date && latest.occurrence_date) {
        const shift = daysBetween(latest.next_date, latest.occurrence_date);
        statements.push(
            db
                .prepare(
                    `UPDATE task_items SET due_date = ?, deadline = CASE WHEN deadline IS NULL THEN NULL ELSE date(deadline, ?) END,
                        version = version + 1, updated_by = ?, updated_at = ? WHERE id = ? AND due_date = ?`,
                )
                .bind(latest.occurrence_date, `${shift >= 0 ? "+" : ""}${shift} days`, user.email, now, taskId, latest.next_date),
            requireChange(db),
            ...(await relativeReminderStatements(db, taskId, latest.occurrence_date, task.due_time)),
        );
        // A routine's turn passed on with the completion; undoing it gives the turn back.
        const back = latest.kind === "completed" ? await undoTurnStatement(db, taskId, task.project_id, task.assignee_email) : null;
        if (back) statements.push(back);
    } else {
        throw invalid("There's no completion to undo");
    }
    if (latest) statements.push(db.prepare("UPDATE task_completions SET undone_at = ?, undone_by = ? WHERE id = ?").bind(now, user.email, latest.id));
    statements.push(
        activity(db, {
            projectId: task.project_id,
            taskId,
            actor: user.email,
            action: "task.reopen",
            changes: { occurrence: latest?.occurrence_date ?? null },
        }),
    );
    try {
        await db.batch(statements);
    } catch (error) {
        if (isGuardFailure(error)) throw new TaskConflict(await taskSummary(db, taskId));
        throw error;
    }
    return (await taskSummary(db, taskId))!;
}

// --- Duplicate and delete ------------------------------------------------------------------------

/** Copies a task and its subtasks (open, without comments, history or reminders), just after the original. */
export async function duplicateTask(db: D1Database, user: PortalUser, taskId: string): Promise<TaskSummary> {
    const task = await requireTask(db, user, taskId, "editor");
    requireWritable(task);
    const tree = await subtree(db, taskId);
    const copies = new Map(tree.map((n) => [n.id, newId("tsk")]));
    const parents = await db
        .prepare(`SELECT id, parent_id FROM task_items WHERE id IN (${placeholders(tree.length)})`)
        .bind(...tree.map((n) => n.id))
        .all<{ id: string; parent_id: string | null }>();
    const parentOf = new Map(parents.results.map((p) => [p.id, p.parent_id]));
    const { position, renumber } = await placement(
        db,
        { projectId: task.project_id, sectionId: task.section_id, parentId: task.parent_id },
        { afterId: taskId },
    );
    const now = nowIso();
    const statements: D1PreparedStatement[] = [...renumber];
    // Parents before children, so each copy's parent already exists when it's inserted.
    for (const node of [...tree].sort((a, b) => a.depth - b.depth)) {
        const isRoot = node.id === taskId;
        statements.push(
            db
                .prepare(
                    `INSERT INTO task_items (id, project_id, section_id, parent_id, depth, title, description, priority, due_date, due_time, deadline,
                        recurrence_json, is_milestone, assignee_email, position, created_by, updated_by, created_at, updated_at)
                     SELECT ?, project_id, section_id, ?, depth, title, description, priority, due_date, due_time, deadline, recurrence_json, is_milestone,
                        assignee_email, COALESCE(?, position), ?, ?, ?, ? FROM task_items WHERE id = ?`,
                )
                .bind(
                    copies.get(node.id),
                    isRoot ? task.parent_id : copies.get(parentOf.get(node.id)!),
                    isRoot ? position : null,
                    user.email,
                    user.email,
                    now,
                    now,
                    node.id,
                ),
            db
                .prepare("INSERT INTO task_item_labels (task_id, name, added_by, added_at) SELECT ?, name, ?, ? FROM task_item_labels WHERE task_id = ?")
                .bind(copies.get(node.id), user.email, now, node.id),
        );
    }
    statements.push(
        activity(db, { projectId: task.project_id, taskId: copies.get(taskId), actor: user.email, action: "task.duplicate", changes: { count: tree.length } }),
    );
    await db.batch(statements);
    return (await taskSummary(db, copies.get(taskId)!))!;
}

/** Deletes a task and its subtasks, comments, labels, reminders and Knowledge references. The history keeps an entry, without the title. */
export async function deleteTask(db: D1Database, user: PortalUser, taskId: string): Promise<void> {
    const task = await requireTask(db, user, taskId, "editor");
    requireWritable(task);
    const tree = await subtree(db, taskId);
    await db.batch([
        db.prepare("DELETE FROM task_items WHERE id = ?").bind(taskId),
        activity(db, { projectId: task.project_id, taskId, actor: user.email, action: "task.delete", changes: { count: tree.length } }),
    ]);
}

// --- Bulk ----------------------------------------------------------------------------------------

const bulkInput = z.discriminatedUnion("action", [
    z.object({ action: z.literal("complete"), ids: z.array(id("tsk")).min(1).max(LIMITS.bulk), includeSubtasks: z.boolean().default(false) }).strict(),
    z.object({ action: z.literal("delete"), ids: z.array(id("tsk")).min(1).max(LIMITS.bulk) }).strict(),
    z.object({ action: z.literal("priority"), ids: z.array(id("tsk")).min(1).max(LIMITS.bulk), priority: scheduleFields.priority }).strict(),
    z.object({ action: z.literal("due"), ids: z.array(id("tsk")).min(1).max(LIMITS.bulk), dueDate: calendarDate.nullable() }).strict(),
    z
        .object({
            action: z.literal("shift"),
            ids: z.array(id("tsk")).min(1).max(LIMITS.bulk),
            days: z
                .number()
                .int()
                .min(-366)
                .max(366)
                .refine((n) => n !== 0, "Shift by at least one day"),
        })
        .strict(),
    z
        .object({
            action: z.literal("move"),
            ids: z.array(id("tsk")).min(1).max(LIMITS.bulk),
            projectId: id("tpj"),
            sectionId: id("tsc").nullable().default(null),
        })
        .strict(),
    z.object({ action: z.enum(["label", "unlabel"]), ids: z.array(id("tsk")).min(1).max(LIMITS.bulk), label: z.string().min(1).max(200) }).strict(),
]);

/**
 * One change to many tasks. Every task must be one the caller can edit; if any isn't, nothing
 * changes and the answer is 404, without saying which. Completion, priority, dates and labels apply
 * in one batch; moves go one task at a time through moveTask, which keeps subtasks with their parents.
 */
export async function bulkTasks(db: D1Database, user: PortalUser, input: unknown): Promise<{ changed: number }> {
    const body = bulkInput.parse(input);
    const unique = [...new Set(body.ids)];
    const rows: TaskAccessRow[] = [];
    for (const part of chunk(unique, 40)) {
        const found = await db
            .prepare(
                `SELECT t.id, t.project_id, t.section_id, t.parent_id, t.depth, t.title, t.status, t.priority, t.due_date, t.due_time, t.deadline,
                        t.recurrence_json, t.assignee_email, t.is_milestone, t.position, t.version, m.role, p.kind AS project_kind, p.status AS project_status
                 FROM task_items t JOIN task_project_members m ON m.project_id = t.project_id AND m.email = ? JOIN task_projects p ON p.id = t.project_id
                 WHERE t.id IN (${placeholders(part.length)}) AND m.role <> 'viewer' AND p.status <> 'archived'`,
            )
            .bind(user.email, ...part)
            .all<TaskAccessRow>();
        rows.push(...found.results);
    }
    if (rows.length !== unique.length) throw notFound();
    // In the order they were selected, so moved tasks keep the order the person sees.
    rows.sort((a, b) => unique.indexOf(a.id) - unique.indexOf(b.id));
    const now = nowIso();
    const statements: D1PreparedStatement[] = [];
    switch (body.action) {
        case "complete": {
            const today = await todayFor(db, user.email);
            // Subtasks that are themselves selected are completed with their parent, so skip them here.
            const selected = new Set(unique);
            for (const task of rows) {
                if (task.status === "completed" || (task.parent_id && selected.has(task.parent_id))) continue;
                const result = await completionStatements(db, user, task, { includeSubtasks: body.includeSubtasks }, today);
                statements.push(...result.statements);
            }
            break;
        }
        case "move": {
            for (const task of rows)
                if (!task.parent_id || !unique.includes(task.parent_id))
                    await moveTask(db, user, task.id, { projectId: body.projectId, sectionId: body.sectionId, parentId: null });
            return { changed: rows.length };
        }
        case "delete": {
            for (const task of rows) {
                statements.push(
                    db.prepare("DELETE FROM task_items WHERE id = ?").bind(task.id),
                    activity(db, { projectId: task.project_id, taskId: task.id, actor: user.email, action: "task.delete", changes: { count: 1 } }),
                );
            }
            break;
        }
        case "priority": {
            for (const task of rows) {
                statements.push(
                    db
                        .prepare("UPDATE task_items SET priority = ?, version = version + 1, updated_by = ?, updated_at = ? WHERE id = ?")
                        .bind(body.priority, user.email, now, task.id),
                    activity(db, {
                        projectId: task.project_id,
                        taskId: task.id,
                        actor: user.email,
                        action: "task.update",
                        changes: { priority: body.priority },
                    }),
                );
            }
            break;
        }
        case "due": {
            for (const task of rows) {
                if (task.recurrence_json && !body.dueDate) throw invalid("Repeating tasks need a date. Stop them repeating first.");
                statements.push(
                    db
                        .prepare(
                            "UPDATE task_items SET due_date = ?, due_time = CASE WHEN ? IS NULL THEN NULL ELSE due_time END, version = version + 1, updated_by = ?, updated_at = ? WHERE id = ?",
                        )
                        .bind(body.dueDate, body.dueDate, user.email, now, task.id),
                    ...(await relativeReminderStatements(db, task.id, body.dueDate, body.dueDate ? task.due_time : null)),
                    activity(db, { projectId: task.project_id, taskId: task.id, actor: user.email, action: "task.update", changes: { dueDate: body.dueDate } }),
                );
            }
            break;
        }
        case "shift": {
            // Due dates move by the same number of days; deadlines stay where they are, undated
            // tasks are left alone, and a repeating task moves only its current occurrence.
            const offset = `${body.days > 0 ? "+" : ""}${body.days} days`;
            for (const task of rows) {
                if (!task.due_date) continue;
                const moved = addDays(task.due_date, body.days);
                statements.push(
                    db
                        .prepare("UPDATE task_items SET due_date = date(due_date, ?), version = version + 1, updated_by = ?, updated_at = ? WHERE id = ?")
                        .bind(offset, user.email, now, task.id),
                    ...(await relativeReminderStatements(db, task.id, moved, task.due_time)),
                    activity(db, { projectId: task.project_id, taskId: task.id, actor: user.email, action: "task.update", changes: { dueDate: moved } }),
                );
            }
            break;
        }
        case "label":
        case "unlabel": {
            const [name] = normaliseLabels([body.label]);
            if (!name) throw invalid("Name the label");
            for (const task of rows) {
                statements.push(
                    body.action === "label"
                        ? db
                              .prepare("INSERT OR IGNORE INTO task_item_labels (task_id, name, added_by, added_at) VALUES (?, ?, ?, ?)")
                              .bind(task.id, name, user.email, now)
                        : db.prepare("DELETE FROM task_item_labels WHERE task_id = ? AND name = ?").bind(task.id, name),
                    db.prepare("UPDATE task_items SET version = version + 1, updated_by = ?, updated_at = ? WHERE id = ?").bind(user.email, now, task.id),
                );
            }
            if (body.action === "label") statements.push(...labelDefinition(db, user.email, name, now));
            break;
        }
    }
    if (statements.length) {
        try {
            await db.batch(statements);
        } catch (error) {
            if (isGuardFailure(error)) throw new HttpError(409, "conflict", "Some of those tasks changed in the meantime. Reload and try again.");
            throw error;
        }
    }
    return { changed: rows.length };
}

const labelDefinition = (db: D1Database, email: string, name: string, now: string) => [
    db
        .prepare("INSERT OR IGNORE INTO task_labels (id, owner_email, name, color, position, created_at, updated_at) VALUES (?, ?, ?, 'gray', 0, ?, ?)")
        .bind(newId("tlb"), email, name, now, now),
];
