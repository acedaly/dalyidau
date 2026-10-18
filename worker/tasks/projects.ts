// Projects, their members and their sections.
//
// A personal project has one member, its owner, and is visible to nobody else. An owner may share
// it (it becomes a shared project, Inbox excepted), and may turn a shared project back into a
// personal one once they're its only member. Shared projects always keep at least one owner.
// Editors change tasks, sections and project details; owners also manage members, sharing,
// archiving and deletion. Viewers read.
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { z } from "zod";
import type { PortalUser } from "../../src/shared/portal/types";
import { isCalendarDate } from "../../src/shared/tasks/dates";
import { REVIEW_FREQUENCIES } from "../../src/shared/tasks/productivity";
import { COLORS, LIMITS, PROJECT_ROLES, PROJECT_STATUSES, type TaskMember, type TaskProject, type TaskSection } from "../../src/shared/tasks/types";
import type { Env } from "../env";
import { isGuardFailure, newId, nowIso, requireChange } from "../portal/db";
import { HttpError } from "../portal/http";
import { canUseTasks, notFound, requireProject, requireWritable } from "./access";
import { activity } from "./activity";

const invalid = (message: string) => new HttpError(422, "validation", message);

interface ProjectRow {
    id: string;
    name: string;
    description: string;
    color: TaskProject["color"];
    kind: "personal" | "shared";
    is_inbox: number;
    status: TaskProject["status"];
    start_date: string | null;
    target_date: string | null;
    default_view: "list" | "board";
    review_frequency: TaskProject["reviewFrequency"];
    version: number;
    created_at: string;
    updated_at: string;
    role: TaskProject["role"];
    open_count: number;
    completed_count: number;
    overdue_count: number;
    member_count: number;
}

const toProject = (r: ProjectRow): TaskProject => ({
    id: r.id,
    name: r.name,
    description: r.description,
    color: r.color,
    kind: r.kind,
    isInbox: !!r.is_inbox,
    status: r.status,
    startDate: r.start_date,
    targetDate: r.target_date,
    defaultView: r.default_view,
    reviewFrequency: r.review_frequency,
    role: r.role,
    version: r.version,
    counts: { open: r.open_count, completed: r.completed_count, overdue: r.overdue_count },
    memberCount: r.member_count,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
});

const PROJECT_COLUMNS = `p.id, p.name, p.description, p.color, p.kind, p.is_inbox, p.status, p.start_date, p.target_date, p.default_view, p.review_frequency, p.version, p.created_at, p.updated_at, m.role,
    (SELECT COUNT(*) FROM task_items t WHERE t.project_id = p.id AND t.status = 'open') AS open_count,
    (SELECT COUNT(*) FROM task_items t WHERE t.project_id = p.id AND t.status = 'completed') AS completed_count,
    (SELECT COUNT(*) FROM task_items t WHERE t.project_id = p.id AND t.status = 'open' AND t.due_date < ?) AS overdue_count,
    (SELECT COUNT(*) FROM task_project_members x WHERE x.project_id = p.id) AS member_count`;

/** The caller's projects: Inbox first, then in their own sidebar order. */
export async function listProjects(db: D1Database, email: string, today: string): Promise<TaskProject[]> {
    const rows = await db
        .prepare(
            `SELECT ${PROJECT_COLUMNS} FROM task_projects p JOIN task_project_members m ON m.project_id = p.id AND m.email = ?
             ORDER BY p.is_inbox DESC, m.position, p.name COLLATE NOCASE`,
        )
        .bind(today, email)
        .all<ProjectRow>();
    return rows.results.map(toProject);
}

export async function getProject(db: D1Database, user: PortalUser, projectId: string, today: string): Promise<TaskProject> {
    const row = await db
        .prepare(`SELECT ${PROJECT_COLUMNS} FROM task_projects p JOIN task_project_members m ON m.project_id = p.id AND m.email = ? WHERE p.id = ?`)
        .bind(today, user.email, projectId)
        .first<ProjectRow>();
    if (!row) throw notFound();
    return toProject(row);
}

const optionalDate = z.string().refine(isCalendarDate, "Use a real date").nullable();
const projectFields = {
    name: z.string().trim().min(1, "Give the project a name").max(LIMITS.projectName),
    description: z.string().trim().max(LIMITS.projectDescription),
    color: z.enum(COLORS),
    startDate: optionalDate,
    targetDate: optionalDate,
    defaultView: z.enum(["list", "board"]),
};

const createInput = z
    .object({
        ...projectFields,
        description: projectFields.description.default(""),
        color: projectFields.color.default("gray"),
        startDate: optionalDate.default(null),
        targetDate: optionalDate.default(null),
        defaultView: projectFields.defaultView.default("list"),
        kind: z.enum(["personal", "shared"]).default("personal"),
        /** Sections to start with, e.g. from a template. */
        sections: z.array(z.string().trim().min(1).max(LIMITS.sectionName)).max(20).default([]),
        /** A random id for this one intended create: sending the same one again returns the same project. */
        clientId: z
            .string()
            .regex(/^[A-Za-z0-9_-]{8,64}$/, "Not a valid request id")
            .optional(),
    })
    .strict();

const checkDates = (start: string | null, target: string | null) => {
    if (start && target && target < start) throw invalid("The target date can't be before the start date");
};

/** The project an earlier create with this client id made, if there was one and the caller is still a member. */
export async function replayedProject(db: D1Database, user: PortalUser, clientId: string | undefined): Promise<string | null> {
    if (!clientId) return null;
    const row = await db
        .prepare(
            `SELECT p.id FROM task_projects p JOIN task_project_members m ON m.project_id = p.id AND m.email = ?
             WHERE p.created_by = ? AND p.client_id = ?`,
        )
        .bind(user.email, user.email, clientId)
        .first<{ id: string }>();
    return row?.id ?? null;
}

/** Creates a project with the caller as its only member and owner. Never an Inbox: that's only ever made by ensureInbox. */
export async function createProject(db: D1Database, user: PortalUser, input: unknown): Promise<{ id: string; replayed: boolean }> {
    const body = createInput.parse(input);
    const earlier = await replayedProject(db, user, body.clientId);
    if (earlier) return { id: earlier, replayed: true };
    checkDates(body.startDate, body.targetDate);
    const id = newId("tpj");
    const now = nowIso();
    const statements = [
        db
            .prepare(
                `INSERT INTO task_projects (id, name, description, color, kind, start_date, target_date, default_view, created_by, updated_by, created_at, updated_at, client_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
                id,
                body.name,
                body.description,
                body.color,
                body.kind,
                body.startDate,
                body.targetDate,
                body.defaultView,
                user.email,
                user.email,
                now,
                now,
                body.clientId ?? null,
            ),
        db
            .prepare(
                `INSERT INTO task_project_members (project_id, email, role, position, added_by, created_at, updated_at)
                 VALUES (?, ?, 'owner', (SELECT COALESCE(MAX(position), 0) + 1 FROM task_project_members WHERE email = ?), ?, ?, ?)`,
            )
            .bind(id, user.email, user.email, user.email, now, now),
        ...body.sections.map((name, i) =>
            db
                .prepare("INSERT INTO task_sections (id, project_id, name, position, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
                .bind(newId("tsc"), id, name, i + 1, user.email, now, now),
        ),
        activity(db, { projectId: id, actor: user.email, action: "project.create", changes: { kind: body.kind } }),
    ];
    try {
        await db.batch(statements);
    } catch (error) {
        // Two copies of one request at the same moment: the unique index let only the first insert in.
        if (body.clientId && /UNIQUE constraint failed: task_projects\.created_by, task_projects\.client_id/.test(String((error as Error)?.message))) {
            const first = await replayedProject(db, user, body.clientId);
            if (first) return { id: first, replayed: true };
        }
        throw error;
    }
    return { id, replayed: false };
}

const updateInput = z
    .object({
        version: z.number().int().min(1),
        name: projectFields.name.optional(),
        description: projectFields.description.optional(),
        color: projectFields.color.optional(),
        startDate: optionalDate.optional(),
        targetDate: optionalDate.optional(),
        defaultView: projectFields.defaultView.optional(),
        reviewFrequency: z.enum(REVIEW_FREQUENCIES).optional(),
        status: z.enum(PROJECT_STATUSES).optional(),
    })
    .strict();

export class ProjectConflict extends HttpError {
    constructor() {
        super(409, "conflict", "This project changed since you opened it. Reload to see the latest version.");
    }
}

export async function updateProject(db: D1Database, user: PortalUser, projectId: string, input: unknown) {
    const body = updateInput.parse(input);
    const project = await requireProject(db, user, projectId, body.status ? "owner" : "editor");
    if (project.is_inbox && (body.name !== undefined || body.status !== undefined)) throw invalid("The Inbox can't be renamed, completed or archived");
    if (project.status === "archived" && body.status === undefined) requireWritable(project);
    const current = (await db
        .prepare("SELECT start_date, target_date FROM task_projects WHERE id = ?")
        .bind(projectId)
        .first<{ start_date: string | null; target_date: string | null }>())!;
    checkDates(body.startDate !== undefined ? body.startDate : current.start_date, body.targetDate !== undefined ? body.targetDate : current.target_date);
    const sets: string[] = [];
    const binds: unknown[] = [];
    const columns: Record<string, string> = {
        name: "name",
        description: "description",
        color: "color",
        startDate: "start_date",
        targetDate: "target_date",
        defaultView: "default_view",
        reviewFrequency: "review_frequency",
        status: "status",
    };
    for (const [key, column] of Object.entries(columns)) {
        const value = body[key as keyof typeof body];
        if (value !== undefined) (sets.push(`${column} = ?`), binds.push(value));
    }
    if (!sets.length) return;
    try {
        await db.batch([
            db
                .prepare(`UPDATE task_projects SET ${sets.join(", ")}, version = version + 1, updated_by = ?, updated_at = ? WHERE id = ? AND version = ?`)
                .bind(...binds, user.email, nowIso(), projectId, body.version),
            requireChange(db),
            activity(db, {
                projectId,
                actor: user.email,
                action: body.status ? "project.status" : "project.update",
                changes: {
                    ...Object.fromEntries(
                        Object.keys(body)
                            .filter((k) => k !== "version" && k !== "status")
                            .map((k) => [k, true]),
                    ),
                    ...(body.status ? { status: body.status } : {}),
                },
            }),
        ]);
    } catch (error) {
        if (isGuardFailure(error)) throw new ProjectConflict();
        throw error;
    }
}

/** Shares a personal project (so members can be added), or makes a shared project personal again once only its owner is left. */
export async function setProjectKind(db: D1Database, user: PortalUser, projectId: string, kind: "personal" | "shared") {
    const project = await requireProject(db, user, projectId, "owner");
    if (project.is_inbox) throw invalid("The Inbox is always personal");
    if (project.kind === kind) return;
    if (kind === "personal") {
        const count = await db.prepare("SELECT COUNT(*) AS n FROM task_project_members WHERE project_id = ?").bind(projectId).first<{ n: number }>();
        if ((count?.n ?? 0) > 1) throw invalid("Remove the other members first");
    }
    const now = nowIso();
    await db.batch([
        // A personal project has no assignees, nobody takes turns in it, and no shared goal can draw on it.
        ...(kind === "personal"
            ? [
                  db.prepare("UPDATE task_items SET assignee_email = NULL WHERE project_id = ? AND assignee_email IS NOT NULL").bind(projectId),
                  db
                      .prepare(
                          `DELETE FROM task_routine_participants WHERE routine_id IN (SELECT r.id FROM task_routines r JOIN task_items t ON t.id = r.task_id WHERE t.project_id = ?)`,
                      )
                      .bind(projectId),
                  db.prepare("UPDATE task_routines SET rotation = 'none' WHERE task_id IN (SELECT id FROM task_items WHERE project_id = ?)").bind(projectId),
                  db
                      .prepare(
                          `DELETE FROM task_goal_links WHERE goal_id IN (SELECT id FROM task_goals WHERE kind = 'shared')
                           AND (project_id = ? OR task_id IN (SELECT id FROM task_items WHERE project_id = ?))`,
                      )
                      .bind(projectId, projectId),
              ]
            : []),
        db
            .prepare("UPDATE task_projects SET kind = ?, version = version + 1, updated_by = ?, updated_at = ? WHERE id = ?")
            .bind(kind, user.email, now, projectId),
        activity(db, { projectId, actor: user.email, action: kind === "shared" ? "project.share" : "project.unshare" }),
    ]);
}

/** Deletes a project with all its tasks. Owners only, never the Inbox, and only with the typed confirmation. */
export async function deleteProject(db: D1Database, user: PortalUser, projectId: string, input: unknown) {
    z.object({ confirm: z.literal("DELETE", { message: "Type DELETE to confirm" }) }).parse(input);
    const project = await requireProject(db, user, projectId, "owner");
    if (project.is_inbox) throw invalid("The Inbox can't be deleted");
    await db.prepare("DELETE FROM task_projects WHERE id = ?").bind(projectId).run();
}

/** Moves a project in the caller's own sidebar. Nobody else's order changes. */
export async function moveProject(db: D1Database, user: PortalUser, projectId: string, input: unknown) {
    const { afterId } = z
        .object({ afterId: z.string().max(40).nullable() })
        .strict()
        .parse(input);
    await requireProject(db, user, projectId);
    const rows = (
        await db
            .prepare(
                "SELECT m.project_id, m.position FROM task_project_members m JOIN task_projects p ON p.id = m.project_id WHERE m.email = ? AND p.is_inbox = 0 ORDER BY m.position, p.name COLLATE NOCASE",
            )
            .bind(user.email)
            .all<{ project_id: string; position: number }>()
    ).results.filter((r) => r.project_id !== projectId);
    const index = afterId ? rows.findIndex((r) => r.project_id === afterId) + 1 : 0;
    if (afterId && index === 0) throw notFound();
    const order = [...rows.slice(0, index).map((r) => r.project_id), projectId, ...rows.slice(index).map((r) => r.project_id)];
    await db.batch(
        order.map((id, i) => db.prepare("UPDATE task_project_members SET position = ? WHERE project_id = ? AND email = ?").bind(i + 1, id, user.email)),
    );
}

// --- Members -------------------------------------------------------------------------------------

export async function listMembers(db: D1Database, projectId: string): Promise<TaskMember[]> {
    const rows = await db
        .prepare(
            `SELECT m.email, u.name, m.role, m.added_by, m.created_at FROM task_project_members m LEFT JOIN portal_users u ON u.email = m.email
             WHERE m.project_id = ? ORDER BY m.role = 'owner' DESC, m.email`,
        )
        .bind(projectId)
        .all<{ email: string; name: string | null; role: TaskMember["role"]; added_by: string; created_at: string }>();
    return rows.results.map((r) => ({ email: r.email, name: r.name, role: r.role, addedBy: r.added_by, createdAt: r.created_at }));
}

const memberInput = z.object({ email: z.string().trim().toLowerCase().max(254).pipe(z.email("Enter an email address")), role: z.enum(PROJECT_ROLES) }).strict();

const sharedProject = async (db: D1Database, user: PortalUser, projectId: string) => {
    const project = await requireProject(db, user, projectId, "owner");
    if (project.kind === "personal") throw invalid(project.is_inbox ? "The Inbox can't be shared" : "Share the project first, then add people");
    return project;
};

export async function addMember(env: Env, db: D1Database, user: PortalUser, projectId: string, input: unknown) {
    await sharedProject(db, user, projectId);
    const body = memberInput.parse(input);
    if (!(await canUseTasks(env, db, body.email))) throw invalid("Add them to the portal as an owner or admin first (Portal settings → Household & Access)");
    const now = nowIso();
    const [result] = await db.batch([
        db
            .prepare(
                `INSERT OR IGNORE INTO task_project_members (project_id, email, role, position, added_by, created_at, updated_at)
                 VALUES (?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM task_project_members WHERE email = ?), ?, ?, ?)`,
            )
            .bind(projectId, body.email, body.role, body.email, user.email, now, now),
        activity(db, { projectId, actor: user.email, action: "member.add", changes: { role: body.role } }, "WHERE changes() > 0"),
    ]);
    if (!result.meta.changes) throw new HttpError(409, "conflict", "They're already a member");
}

const keepsAnOwner = (db: D1Database, projectId: string) =>
    db
        .prepare("INSERT INTO batch_guard (ok) SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM task_project_members WHERE project_id = ? AND role = 'owner')")
        .bind(projectId);

/**
 * Statements that take away what a person had in a project once they lose edit access: their
 * assignments (an assignee must be able to edit) and, when they leave, their reminders.
 */
const loseAccessStatements = (db: D1Database, projectId: string, email: string, leaving: boolean): D1PreparedStatement[] => [
    db.prepare("UPDATE task_items SET assignee_email = NULL WHERE project_id = ? AND assignee_email = ?").bind(projectId, email),
    // They no longer take turns on the project's routines either.
    db
        .prepare(
            `DELETE FROM task_routine_participants WHERE email = ?
             AND routine_id IN (SELECT r.id FROM task_routines r JOIN task_items t ON t.id = r.task_id WHERE t.project_id = ?)`,
        )
        .bind(email, projectId),
    ...(leaving
        ? [
              db
                  .prepare("DELETE FROM task_reminders WHERE owner_email = ? AND task_id IN (SELECT id FROM task_items WHERE project_id = ?)")
                  .bind(email, projectId),
          ]
        : []),
];

const memberError = async (db: D1Database, projectId: string, email: string, error: unknown) => {
    if (isGuardFailure(error)) {
        const exists = await db.prepare("SELECT 1 FROM task_project_members WHERE project_id = ? AND email = ?").bind(projectId, email).first();
        if (!exists) return notFound();
        return invalid("A shared project needs at least one owner");
    }
    return error;
};

export async function updateMember(db: D1Database, user: PortalUser, projectId: string, email: string, input: unknown) {
    await sharedProject(db, user, projectId);
    const { role } = z
        .object({ role: z.enum(PROJECT_ROLES) })
        .strict()
        .parse(input);
    try {
        await db.batch([
            ...(role === "viewer" ? loseAccessStatements(db, projectId, email, false) : []),
            db.prepare("UPDATE task_project_members SET role = ?, updated_at = ? WHERE project_id = ? AND email = ?").bind(role, nowIso(), projectId, email),
            requireChange(db),
            keepsAnOwner(db, projectId),
            activity(db, { projectId, actor: user.email, action: "member.role", changes: { role } }),
        ]);
    } catch (error) {
        throw await memberError(db, projectId, email, error);
    }
}

/** Owners remove anyone; anyone may leave a shared project themselves. Removal takes effect on the next request. */
export async function removeMember(db: D1Database, user: PortalUser, projectId: string, email: string) {
    if (email === user.email) {
        const project = await requireProject(db, user, projectId);
        if (project.kind === "personal") throw invalid("You can't leave your own personal project");
    } else await sharedProject(db, user, projectId);
    try {
        await db.batch([
            ...loseAccessStatements(db, projectId, email, true),
            db.prepare("DELETE FROM task_project_members WHERE project_id = ? AND email = ?").bind(projectId, email),
            requireChange(db),
            keepsAnOwner(db, projectId),
            activity(db, { projectId, actor: user.email, action: email === user.email ? "member.leave" : "member.remove" }),
        ]);
    } catch (error) {
        throw await memberError(db, projectId, email, error);
    }
}

/** People who can be assigned work: editors and owners of each shared project the caller can edit. */
export async function assignableMembers(db: D1Database, email: string): Promise<Record<string, { email: string; name: string | null }[]>> {
    const rows = await db
        .prepare(
            `SELECT a.project_id, a.email, u.name FROM task_project_members mine
             JOIN task_projects p ON p.id = mine.project_id AND p.kind = 'shared'
             JOIN task_project_members a ON a.project_id = mine.project_id AND a.role <> 'viewer'
             LEFT JOIN portal_users u ON u.email = a.email
             WHERE mine.email = ? AND mine.role <> 'viewer' ORDER BY a.email`,
        )
        .bind(email)
        .all<{ project_id: string; email: string; name: string | null }>();
    const out: Record<string, { email: string; name: string | null }[]> = {};
    for (const r of rows.results) (out[r.project_id] ??= []).push({ email: r.email, name: r.name });
    return out;
}

// --- Sections ------------------------------------------------------------------------------------

/** Sections of every project the caller belongs to, keyed by project. */
export async function sectionsFor(db: D1Database, email: string): Promise<Record<string, TaskSection[]>> {
    const rows = await db
        .prepare(
            `SELECT s.id, s.project_id, s.name, s.position FROM task_sections s JOIN task_project_members m ON m.project_id = s.project_id AND m.email = ?
             ORDER BY s.position`,
        )
        .bind(email)
        .all<{ id: string; project_id: string; name: string; position: number }>();
    const out: Record<string, TaskSection[]> = {};
    for (const r of rows.results) (out[r.project_id] ??= []).push({ id: r.id, projectId: r.project_id, name: r.name, position: r.position });
    return out;
}

const sectionName = z.object({ name: z.string().trim().min(1, "Name the section").max(LIMITS.sectionName) }).strict();

const requireSection = async (db: D1Database, user: PortalUser, sectionId: string) => {
    const row = await db.prepare("SELECT id, project_id FROM task_sections WHERE id = ?").bind(sectionId).first<{ id: string; project_id: string }>();
    if (!row) throw notFound();
    // Membership decides: a section in someone else's project is a 404 like any other.
    const project = await requireProject(db, user, row.project_id, "editor").catch((error) => {
        throw error instanceof HttpError && error.status === 404 ? notFound() : error;
    });
    requireWritable(project);
    return row;
};

export async function createSection(db: D1Database, user: PortalUser, projectId: string, input: unknown): Promise<TaskSection> {
    const { name } = sectionName.parse(input);
    const project = await requireProject(db, user, projectId, "editor");
    requireWritable(project);
    const count = await db.prepare("SELECT COUNT(*) AS n FROM task_sections WHERE project_id = ?").bind(projectId).first<{ n: number }>();
    if ((count?.n ?? 0) >= 50) throw invalid("A project can have at most 50 sections");
    const id = newId("tsc");
    const now = nowIso();
    await db.batch([
        db
            .prepare(
                `INSERT INTO task_sections (id, project_id, name, position, created_by, created_at, updated_at)
                 VALUES (?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM task_sections WHERE project_id = ?), ?, ?, ?)`,
            )
            .bind(id, projectId, name, projectId, user.email, now, now),
        activity(db, { projectId, actor: user.email, action: "section.create" }),
    ]);
    const row = (await db.prepare("SELECT position FROM task_sections WHERE id = ?").bind(id).first<{ position: number }>())!;
    return { id, projectId, name, position: row.position };
}

export async function renameSection(db: D1Database, user: PortalUser, sectionId: string, input: unknown) {
    const { name } = sectionName.parse(input);
    const section = await requireSection(db, user, sectionId);
    await db.prepare("UPDATE task_sections SET name = ?, updated_at = ? WHERE id = ?").bind(name, nowIso(), section.id).run();
}

export async function moveSection(db: D1Database, user: PortalUser, sectionId: string, input: unknown) {
    const { afterId } = z
        .object({ afterId: z.string().max(40).nullable() })
        .strict()
        .parse(input);
    const section = await requireSection(db, user, sectionId);
    const rows = (
        await db.prepare("SELECT id FROM task_sections WHERE project_id = ? ORDER BY position").bind(section.project_id).all<{ id: string }>()
    ).results.filter((r) => r.id !== sectionId);
    const index = afterId ? rows.findIndex((r) => r.id === afterId) + 1 : 0;
    if (afterId && index === 0) throw invalid("That section isn't in this project");
    const order = [...rows.slice(0, index).map((r) => r.id), sectionId, ...rows.slice(index).map((r) => r.id)];
    await db.batch(order.map((id, i) => db.prepare("UPDATE task_sections SET position = ? WHERE id = ?").bind(i + 1, id)));
}

/**
 * Deletes a section. Its tasks are never deleted with it: they move to `moveTo` (another section
 * of the same project) or out of any section, in the same batch. The database refuses to delete a
 * section that still has tasks, so nothing can be lost even if this were wrong.
 */
export async function deleteSection(db: D1Database, user: PortalUser, sectionId: string, input: unknown) {
    const { moveTo } = z
        .object({ moveTo: z.string().max(40).nullable().default(null) })
        .strict()
        .parse(input);
    const section = await requireSection(db, user, sectionId);
    if (moveTo) {
        if (moveTo === sectionId) throw invalid("Choose a different section");
        const target = await db.prepare("SELECT id FROM task_sections WHERE id = ? AND project_id = ?").bind(moveTo, section.project_id).first();
        if (!target) throw invalid("That section isn't in this project");
    }
    const now = nowIso();
    const moved = await db.prepare("SELECT COUNT(*) AS n FROM task_items WHERE section_id = ?").bind(sectionId).first<{ n: number }>();
    await db.batch([
        db
            .prepare(
                `UPDATE task_items SET section_id = ?, position = position + COALESCE((SELECT MAX(position) FROM task_items WHERE project_id = ? AND section_id IS ?), 0),
                    version = version + 1, updated_by = ?, updated_at = ? WHERE section_id = ?`,
            )
            .bind(moveTo, section.project_id, moveTo, user.email, now, sectionId),
        db.prepare("DELETE FROM task_sections WHERE id = ?").bind(sectionId),
        activity(db, { projectId: section.project_id, actor: user.email, action: "section.delete", changes: { count: moved?.n ?? 0 } }),
    ]);
}
