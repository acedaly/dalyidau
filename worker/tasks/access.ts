// Who may see what in Daly Tasks.
//
// Portal roles decide whether someone may open Tasks at all (the "tasks.use" permission). Inside
// it, every project, section, task, comment, reminder and search result is reached only through the
// caller's own task_project_members row: a project you aren't a member of doesn't exist as far as
// the API is concerned (404, never 403, so ids can't be probed). Being a portal owner grants
// nothing here, and Knowledge space membership grants nothing either: the two are separate.
import type { D1Database } from "@cloudflare/workers-types";
import { isRole, permissionsFor } from "../../src/shared/portal/permissions";
import type { PortalUser } from "../../src/shared/portal/types";
import { localDate } from "../../src/shared/tasks/dates";
import { type ProjectRole, type TaskPreferences, roleAtLeast } from "../../src/shared/tasks/types";
import type { Env } from "../env";
import { ownerEmails } from "../portal/auth";
import { newId, nowIso } from "../portal/db";
import { HttpError } from "../portal/http";
import { activity } from "./activity";

export const notFound = () => new HttpError(404, "not_found", "Not found");

const refuseRole = (minimum: ProjectRole) =>
    new HttpError(403, "forbidden", minimum === "owner" ? "Only the project's owners can do that" : "You can only view this project");

export interface ProjectAccessRow {
    id: string;
    name: string;
    kind: "personal" | "shared";
    is_inbox: number;
    status: "active" | "on_hold" | "completed" | "archived";
    version: number;
    role: ProjectRole;
}

/** The project, if the caller is a member with at least `minimum`. Non-members get 404. */
export async function requireProject(db: D1Database, user: PortalUser, projectId: string, minimum: ProjectRole = "viewer"): Promise<ProjectAccessRow> {
    const row = await db
        .prepare(
            `SELECT p.id, p.name, p.kind, p.is_inbox, p.status, p.version, m.role
             FROM task_projects p JOIN task_project_members m ON m.project_id = p.id AND m.email = ? WHERE p.id = ?`,
        )
        .bind(user.email, projectId)
        .first<ProjectAccessRow>();
    if (!row) throw notFound();
    if (!roleAtLeast(row.role, minimum)) throw refuseRole(minimum);
    return row;
}

export interface TaskAccessRow {
    id: string;
    project_id: string;
    section_id: string | null;
    parent_id: string | null;
    depth: number;
    title: string;
    status: "open" | "completed";
    priority: number;
    due_date: string | null;
    due_time: string | null;
    deadline: string | null;
    recurrence_json: string | null;
    assignee_email: string | null;
    is_milestone: number;
    position: number;
    version: number;
    role: ProjectRole;
    project_kind: "personal" | "shared";
    project_status: ProjectAccessRow["status"];
}

/** A task the caller may act on, with their role in its project. Non-members get 404. */
export async function requireTask(db: D1Database, user: PortalUser, taskId: string, minimum: ProjectRole = "viewer"): Promise<TaskAccessRow> {
    const row = await db
        .prepare(
            `SELECT t.id, t.project_id, t.section_id, t.parent_id, t.depth, t.title, t.status, t.priority, t.due_date, t.due_time, t.deadline,
                    t.recurrence_json, t.assignee_email, t.is_milestone, t.position, t.version, m.role, p.kind AS project_kind, p.status AS project_status
             FROM task_items t JOIN task_project_members m ON m.project_id = t.project_id AND m.email = ? JOIN task_projects p ON p.id = t.project_id
             WHERE t.id = ?`,
        )
        .bind(user.email, taskId)
        .first<TaskAccessRow>();
    if (!row) throw notFound();
    if (!roleAtLeast(row.role, minimum)) throw refuseRole(minimum);
    return row;
}

/** Archived projects are read-only until they're restored. */
export const requireWritable = (project: { status: string; project_status?: string }) => {
    if ((project.project_status ?? project.status) === "archived")
        throw new HttpError(422, "archived", "This project is archived. Restore it to make changes.");
};

/**
 * The caller's Inbox, created on first use. Safe to call concurrently: the unique index on
 * inbox_owner lets only one insert win, and the membership and history are written only for the
 * Inbox that was actually created.
 */
export async function ensureInbox(db: D1Database, email: string): Promise<string> {
    const existing = await db.prepare("SELECT id FROM task_projects WHERE is_inbox = 1 AND inbox_owner = ?").bind(email).first<{ id: string }>();
    if (existing) return existing.id;
    const id = newId("tpj");
    const now = nowIso();
    const ifCreated = "WHERE EXISTS (SELECT 1 FROM task_projects WHERE id = ?)";
    await db.batch([
        db
            .prepare(
                `INSERT INTO task_projects (id, name, kind, is_inbox, inbox_owner, color, created_by, updated_by, created_at, updated_at)
                 VALUES (?, 'Inbox', 'personal', 1, ?, 'brand', ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
            )
            .bind(id, email, email, email, now, now),
        db
            .prepare(
                `INSERT INTO task_project_members (project_id, email, role, position, added_by, created_at, updated_at) SELECT ?, ?, 'owner', 0, ?, ?, ? ${ifCreated}`,
            )
            .bind(id, email, email, now, now, id),
        activity(db, { projectId: id, actor: email, action: "project.create" }, ifCreated, [id]),
    ]);
    const row = await db.prepare("SELECT id FROM task_projects WHERE is_inbox = 1 AND inbox_owner = ?").bind(email).first<{ id: string }>();
    if (!row) throw new Error("Inbox could not be created");
    return row.id;
}

/** Only people who can already open Tasks in the portal can join a project or be assigned work. */
export async function canUseTasks(env: Env, db: D1Database, email: string) {
    if (ownerEmails(env).has(email)) return true;
    const row = await db.prepare("SELECT role, active FROM portal_users WHERE email = ?").bind(email).first<{ role: string; active: number }>();
    return !!row?.active && isRole(row.role) && permissionsFor(row.role).includes("tasks.use");
}

export const DEFAULT_TIME_ZONE = "Australia/Sydney";

export interface PreferenceRow {
    time_zone: string;
    today_priority: number | null;
    reminders_enabled: number;
    reminder_email: number;
    default_reminder_minutes: number | null;
    quiet_start: string | null;
    quiet_end: string | null;
    landing_page: TaskPreferences["landingPage"];
}

export const PREFERENCE_COLUMNS =
    "time_zone, today_priority, reminders_enabled, reminder_email, default_reminder_minutes, quiet_start, quiet_end, landing_page";

export const toPreferences = (row: PreferenceRow | null): TaskPreferences => ({
    timeZone: row?.time_zone ?? DEFAULT_TIME_ZONE,
    todayPriority: (row?.today_priority ?? null) as TaskPreferences["todayPriority"],
    remindersEnabled: row ? !!row.reminders_enabled : true,
    reminderEmail: row ? !!row.reminder_email : false,
    defaultReminderMinutes: row?.default_reminder_minutes ?? null,
    quietStart: row?.quiet_start ?? null,
    quietEnd: row?.quiet_end ?? null,
    landingPage: row?.landing_page ?? "today",
});

export async function preferences(db: D1Database, email: string): Promise<TaskPreferences> {
    return toPreferences(await db.prepare(`SELECT ${PREFERENCE_COLUMNS} FROM task_preferences WHERE email = ?`).bind(email).first<PreferenceRow>());
}

/** Today's date for this person, in their own time zone. */
export const todayFor = async (db: D1Database, email: string) => localDate(new Date(), (await preferences(db, email)).timeZone);
