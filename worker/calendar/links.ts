// References from events to Daly Tasks and Daly Knowledge records, and creating a task from an event.
//
// Three permission systems meet here and none implies another: the caller must be able to open the
// event (calendar membership), and, for each linked record, be a member of the task's project or
// the object's space right now. Links are checked through Tasks' and Knowledge's own access
// functions when they're added, and again every time they're read: someone who can see a shared
// event but not the linked task sees only that a link exists. Nothing is copied: a task's title,
// status and due date always come from Tasks itself.
import type { D1Database } from "@cloudflare/workers-types";
import { z } from "zod";
import { type EventLink, LIMITS } from "../../src/shared/calendar/types";
import type { PortalUser } from "../../src/shared/portal/types";
import { requireObject } from "../knowledge/access";
import { can } from "../portal/auth";
import { newId, nowIso } from "../portal/db";
import { HttpError } from "../portal/http";
import { requireProject, requireTask } from "../tasks/access";
import { createTask } from "../tasks/tasks";
import { activity, refuse, requireEvent } from "./access";

/**
 * Links are notes about an event, not changes to it: an editor of a local calendar may add them, and
 * so may anyone who can see a subscribed (read-only) event, since the feed's copy is never changed.
 */
async function requireLinkableEvent(db: D1Database, user: PortalUser, eventId: string) {
    const event = await requireEvent(db, user, eventId);
    if (event.calendar_source === "local" && event.role !== "owner" && event.role !== "editor") throw refuse("editor");
    return event;
}

interface LinkRow {
    id: string;
    task_id: string | null;
    project_id: string | null;
    object_id: string | null;
    task_title: string | null;
    task_status: string | null;
    task_due: string | null;
    project_name: string | null;
    object_title: string | null;
    space_name: string | null;
}

/** The event's links as the caller may see them. The event's own access is the caller's concern. */
export async function eventLinks(db: D1Database, user: PortalUser, eventId: string): Promise<EventLink[]> {
    const tasks = can(user, "tasks.use") ? 1 : 0;
    const knowledge = can(user, "knowledge.use") ? 1 : 0;
    const rows = await db
        .prepare(
            `SELECT l.id, l.task_id, l.project_id, l.object_id,
                    CASE WHEN ?1 = 1 AND tm.email IS NOT NULL THEN t.title END AS task_title,
                    CASE WHEN ?1 = 1 AND tm.email IS NOT NULL THEN t.status END AS task_status,
                    CASE WHEN ?1 = 1 AND tm.email IS NOT NULL THEN t.due_date END AS task_due,
                    CASE WHEN ?1 = 1 AND pm.email IS NOT NULL THEN CASE WHEN p.is_inbox = 1 THEN 'Inbox' ELSE p.name END END AS project_name,
                    CASE WHEN ?2 = 1 AND km.email IS NOT NULL AND o.status <> 'trashed' THEN coalesce(nullif(o.title, ''), 'Untitled') END AS object_title,
                    CASE WHEN ?2 = 1 AND km.email IS NOT NULL AND o.status <> 'trashed' THEN s.name END AS space_name
             FROM calendar_event_links l
             LEFT JOIN task_items t ON t.id = l.task_id
             LEFT JOIN task_project_members tm ON tm.project_id = t.project_id AND tm.email = ?3
             LEFT JOIN task_projects p ON p.id = l.project_id
             LEFT JOIN task_project_members pm ON pm.project_id = l.project_id AND pm.email = ?3
             LEFT JOIN knowledge_objects o ON o.id = l.object_id
             LEFT JOIN knowledge_spaces s ON s.id = o.space_id
             LEFT JOIN knowledge_memberships km ON km.space_id = o.space_id AND km.email = ?3
             WHERE l.event_id = ?4 ORDER BY l.added_at`,
        )
        .bind(tasks, knowledge, user.email, eventId)
        .all<LinkRow>();
    return rows.results.map((r): EventLink => {
        if (r.task_id)
            return r.task_title !== null
                ? { id: r.id, kind: "task", available: true, targetId: r.task_id, title: r.task_title, status: r.task_status ?? "open", dueDate: r.task_due }
                : { id: r.id, kind: "task", available: false };
        if (r.project_id)
            return r.project_name !== null
                ? { id: r.id, kind: "project", available: true, targetId: r.project_id, title: r.project_name }
                : { id: r.id, kind: "project", available: false };
        return r.object_title !== null
            ? { id: r.id, kind: "knowledge", available: true, targetId: r.object_id!, title: r.object_title, spaceName: r.space_name ?? "" }
            : { id: r.id, kind: "knowledge", available: false };
    });
}

const linkInput = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("task"), targetId: z.string().regex(/^tsk_[a-z0-9]{14}$/, "Not a valid task") }).strict(),
    z.object({ kind: z.literal("project"), targetId: z.string().regex(/^tpj_[a-z0-9]{14}$/, "Not a valid project") }).strict(),
    z.object({ kind: z.literal("knowledge"), targetId: z.string().regex(/^kob_[a-z0-9]{14}$/, "Not a valid Knowledge object") }).strict(),
]);

/** Links a record the caller can see right now to an event they can edit. */
export async function addLink(db: D1Database, user: PortalUser, eventId: string, input: unknown): Promise<EventLink[]> {
    const event = await requireLinkableEvent(db, user, eventId);
    const body = linkInput.parse(input);
    if (body.kind === "knowledge") {
        if (!can(user, "knowledge.use")) throw new HttpError(403, "forbidden", "You don't have access to Knowledge");
        const object = await requireObject(db, user, body.targetId);
        if (object.status === "trashed") throw new HttpError(404, "not_found", "Not found");
    } else {
        if (!can(user, "tasks.use")) throw new HttpError(403, "forbidden", "You don't have access to Tasks");
        if (body.kind === "task") await requireTask(db, user, body.targetId);
        else await requireProject(db, user, body.targetId);
    }
    const count = await db.prepare("SELECT COUNT(*) AS n FROM calendar_event_links WHERE event_id = ?").bind(eventId).first<{ n: number }>();
    if ((count?.n ?? 0) >= LIMITS.linksPerEvent) throw new HttpError(422, "limit", `An event can have up to ${LIMITS.linksPerEvent} links`);
    const column = body.kind === "task" ? "task_id" : body.kind === "project" ? "project_id" : "object_id";
    await db.batch([
        db
            .prepare(`INSERT INTO calendar_event_links (id, event_id, ${column}, added_by, added_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`)
            .bind(newId("cel"), eventId, body.targetId, user.email, nowIso()),
        activity(db, { actor: user.email, action: "event.link.add", entityType: "event", entityId: eventId, calendarId: event.calendar_id }),
    ]);
    return eventLinks(db, user, eventId);
}

export async function removeLink(db: D1Database, user: PortalUser, eventId: string, linkId: string): Promise<EventLink[]> {
    const event = await requireLinkableEvent(db, user, eventId);
    await db.batch([
        db.prepare("DELETE FROM calendar_event_links WHERE id = ? AND event_id = ?").bind(linkId, eventId),
        activity(db, { actor: user.email, action: "event.link.remove", entityType: "event", entityId: eventId, calendarId: event.calendar_id }),
    ]);
    return eventLinks(db, user, eventId);
}

const createTaskInput = z
    .object({
        /** The occurrence's date (the task is due then), and its time for a timed event. */
        dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        dueTime: z
            .string()
            .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
            .nullish(),
        title: z.string().trim().min(1).max(500).optional(),
        projectId: z
            .string()
            .regex(/^tpj_[a-z0-9]{14}$/)
            .optional(),
        clientId: z
            .string()
            .regex(/^[A-Za-z0-9_-]{8,64}$/)
            .optional(),
    })
    .strict();

/**
 * A task for an event, through Tasks' own create (its permissions, Inbox, idempotency and history),
 * linked back to the event. The task holds the date; the calendar shows it from Tasks from then on,
 * so moving the task's date never needs a second edit here.
 */
export async function createTaskFromEvent(db: D1Database, user: PortalUser, eventId: string, input: unknown) {
    if (!can(user, "tasks.use")) throw new HttpError(403, "forbidden", "You don't have access to Tasks");
    const event = await requireEvent(db, user, eventId);
    const body = createTaskInput.parse(input);
    const row = await db.prepare("SELECT title FROM calendar_events WHERE id = ?").bind(eventId).first<{ title: string }>();
    const { task, replayed } = await createTask(db, user, {
        title: body.title ?? `Prepare for ${row?.title ?? "event"}`,
        dueDate: body.dueDate,
        ...(body.dueTime ? { dueTime: body.dueTime } : {}),
        ...(body.projectId ? { projectId: body.projectId } : {}),
        ...(body.clientId ? { clientId: body.clientId } : {}),
    });
    // Only an editor of the event can attach the link; a viewer still gets their task.
    if (event.calendar_source === "subscription" || event.role === "owner" || event.role === "editor")
        await db
            .prepare("INSERT INTO calendar_event_links (id, event_id, task_id, added_by, added_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING")
            .bind(newId("cel"), eventId, task.id, user.email, nowIso())
            .run();
    await activity(db, { actor: user.email, action: "event.task.create", entityType: "event", entityId: eventId, calendarId: event.calendar_id }).run();
    return { task, replayed, links: await eventLinks(db, user, eventId) };
}
