// Home & Assets and the rest of the portal: Daly Tasks, Daly Calendar and Daly Knowledge.
//
// Tasks: a task can be made for a maintenance record or for a date (registration, a policy
// renewal, a warranty's end, an inspection, a lease ending, roadside renewal) through Tasks' own
// create function, with its permissions, Inbox, history and retry key. asset_task_links remembers
// one task per record or per date; the link is claimed before the task is made, so two clicks, a
// retry or two people in the household can't make two. The task lives in Tasks and its title,
// status and date always come from there. Completing a record in Home & Assets completes its task
// (maintenance.ts); Tasks never writes back, so there's no loop.
//
// Calendar: important dates are shown in Calendar as reminders (an overlay worked out from these
// records, never copied as events). A booked service can also become a real appointment, created
// through Calendar's own createEvent in a calendar the person can edit, once per record.
//
// Knowledge: objects (manuals, notes, troubleshooting) are linked, not copied, and each link is
// checked against Knowledge's own space membership every time it's read.
import type { D1Database } from "@cloudflare/workers-types";
import { z } from "zod";
import type { KnowledgeLinkView, LinkedTask, TaskRefKind } from "../../src/shared/assets/types";
import { LIMITS, taskRequestInput } from "../../src/shared/assets/types";
import type { PortalUser } from "../../src/shared/portal/types";
import { ensureDefaultCalendar } from "../calendar/access";
import { createEvent, eventDetail } from "../calendar/events";
import { requireObject } from "../knowledge/access";
import { can } from "../portal/auth";
import { newId, nowIso } from "../portal/db";
import { HttpError } from "../portal/http";
import { createTask } from "../tasks/tasks";
import { activity, notFound, requireAsset, requireLocation, requirePolicy } from "./access";
import { createMaintenance, requireRecord } from "./maintenance";

// --- Tasks ---------------------------------------------------------------------------------------

interface Resolved {
    title: string;
    dueDate: string | null;
    refDate: string;
    assetId: string | null;
    url: string;
    refId: string;
    refKind: TaskRefKind;
}

const ASSET_URL = (id: string) => `/portal/assets/item/${id}`;
const LOCATION_URL = (id: string) => `/portal/assets/property/${id}`;

/** What a task is about, from the record itself, after checking the caller may act on it. */
async function resolveRef(db: D1Database, user: PortalUser, kind: TaskRefKind, refId: string): Promise<Resolved> {
    switch (kind) {
        case "maintenance": {
            const { row, target } = await requireRecord(db, user, refId, true);
            const title = row.title.toLowerCase().includes(target.name.toLowerCase()) ? row.title : `${row.title}: ${target.name}`;
            return {
                title,
                dueDate: row.scheduled_on ?? row.due_on,
                refDate: "",
                assetId: row.asset_id,
                url: row.asset_id ? ASSET_URL(row.asset_id) : LOCATION_URL(row.location_id!),
                refId,
                refKind: kind,
            };
        }
        case "schedule": {
            // A task for a schedule is a task for its next record (made now if there isn't one yet).
            const schedule = await db.prepare("SELECT * FROM asset_schedules WHERE id = ?").bind(refId).first<{
                id: string;
                asset_id: string | null;
                location_id: string | null;
                title: string;
                category: string;
                next_due_on: string | null;
                next_due_km: number | null;
            }>();
            if (!schedule) throw notFound();
            const open = await db
                .prepare("SELECT id FROM asset_maintenance WHERE schedule_id = ? AND status IN ('open', 'requested', 'scheduled', 'in_progress')")
                .bind(refId)
                .first<{ id: string }>();
            const recordId =
                open?.id ??
                (
                    await createMaintenance(db, user, {
                        ...(schedule.asset_id ? { assetId: schedule.asset_id } : { locationId: schedule.location_id! }),
                        scheduleId: refId,
                        title: schedule.title,
                        category: schedule.category,
                        kind: "preventive",
                        dueOn: schedule.next_due_on,
                        dueKm: schedule.next_due_km,
                    })
                ).record.id;
            return resolveRef(db, user, "maintenance", recordId);
        }
        case "registration":
        case "roadside":
        case "inspection": {
            if (kind === "inspection" && refId.startsWith("alo_")) {
                const location = await requireLocation(db, user, refId);
                if (!location.next_inspection_on) throw new HttpError(422, "validation", "This place has no inspection date recorded");
                return {
                    title: `Prepare for inspection: ${location.name}`,
                    dueDate: location.next_inspection_on,
                    refDate: location.next_inspection_on,
                    assetId: null,
                    url: LOCATION_URL(refId),
                    refId,
                    refKind: kind,
                };
            }
            const { row } = await requireAsset(db, user, refId, "maintain");
            const v = await db
                .prepare("SELECT registration_expiry, roadside_expiry, inspection_due FROM asset_vehicles WHERE asset_id = ?")
                .bind(refId)
                .first<{ registration_expiry: string | null; roadside_expiry: string | null; inspection_due: string | null }>();
            const date = kind === "registration" ? v?.registration_expiry : kind === "roadside" ? v?.roadside_expiry : v?.inspection_due;
            if (!date) throw new HttpError(422, "validation", "There's no date recorded for that yet");
            const what = kind === "registration" ? "Renew registration" : kind === "roadside" ? "Renew roadside assistance" : "Book the vehicle inspection";
            return { title: `${what}: ${row.name}`, dueDate: date, refDate: date, assetId: refId, url: ASSET_URL(refId), refId, refKind: kind };
        }
        case "lease_end": {
            const location = await requireLocation(db, user, refId);
            if (!location.lease_end) throw new HttpError(422, "validation", "This place has no lease end recorded");
            return {
                title: `Lease ends: ${location.name}`,
                dueDate: location.lease_end,
                refDate: location.lease_end,
                assetId: null,
                url: LOCATION_URL(refId),
                refId,
                refKind: kind,
            };
        }
        case "policy_renewal": {
            const policy = await requirePolicy(db, user, refId);
            if (!policy.renews_on) throw new HttpError(422, "validation", "This policy has no renewal date recorded");
            return {
                title: `Review insurance renewal: ${policy.name ?? policy.provider}`,
                dueDate: policy.renews_on,
                refDate: policy.renews_on,
                assetId: null,
                url: `/portal/assets/insurance?policy=${refId}`,
                refId,
                refKind: kind,
            };
        }
        case "warranty_expiry": {
            const w = await db
                .prepare("SELECT asset_id, expires_on FROM asset_warranties WHERE id = ?")
                .bind(refId)
                .first<{ asset_id: string; expires_on: string | null }>();
            if (!w) throw notFound();
            const { row } = await requireAsset(db, user, w.asset_id);
            if (!w.expires_on) throw new HttpError(422, "validation", "This warranty has no end date recorded");
            return {
                title: `Check anything to claim before the warranty ends: ${row.name}`,
                dueDate: w.expires_on,
                refDate: w.expires_on,
                assetId: w.asset_id,
                url: ASSET_URL(w.asset_id),
                refId,
                refKind: kind,
            };
        }
    }
}

const CLAIM_STALE_MS = 2 * 60_000;

export interface LinkedTaskResult {
    taskId: string | null;
    /** A task already existed for this (made earlier, perhaps by someone else). */
    existing: boolean;
    /** The existing task is in someone else's project, so it can't be shown to you. */
    hidden: boolean;
    url: string | null;
}

export async function createLinkedTask(
    db: D1Database,
    user: PortalUser,
    site: string,
    input: unknown,
    via: "portal" | "mcp" = "portal",
): Promise<LinkedTaskResult> {
    if (!can(user, "tasks.use")) throw new HttpError(403, "forbidden", "You don't have access to Daly Tasks");
    const { refDate: _ignored, ...body } = taskRequestInput.parse(input);
    const ref = await resolveRef(db, user, body.refKind, body.refId);
    // Schedules resolve to their record, so the ledger key is the record.
    const key = { kind: ref.refKind, id: ref.refId, date: ref.refDate };
    const existing = async (): Promise<LinkedTaskResult | null> => {
        const row = await db
            .prepare("SELECT task_id, created_at FROM asset_task_links WHERE ref_kind = ? AND ref_id = ? AND ref_date = ?")
            .bind(key.kind, key.id, key.date)
            .first<{ task_id: string; created_at: string }>();
        if (!row) return null;
        if (row.task_id.startsWith("pending_")) {
            if (Date.parse(row.created_at) > Date.now() - CLAIM_STALE_MS)
                throw new HttpError(409, "in_progress", "That task is being created. Try again in a moment.");
            await db.prepare("DELETE FROM asset_task_links WHERE task_id = ?").bind(row.task_id).run();
            return null;
        }
        const task = await db.prepare("SELECT id FROM task_items WHERE id = ?").bind(row.task_id).first();
        if (!task) {
            // The task was deleted in Tasks: a new one may be made.
            await db.prepare("DELETE FROM asset_task_links WHERE task_id = ?").bind(row.task_id).run();
            return null;
        }
        const visible = await db
            .prepare("SELECT 1 FROM task_items t JOIN task_project_members m ON m.project_id = t.project_id AND m.email = ? WHERE t.id = ?")
            .bind(user.email, row.task_id)
            .first();
        return { taskId: visible ? row.task_id : null, existing: true, hidden: !visible, url: visible ? `/portal/tasks/t/${row.task_id}` : null };
    };
    const earlier = await existing();
    if (earlier) return earlier;

    const claim = `pending_${newId("atl").slice(4)}`;
    const linkId = newId("atl");
    const claimed = await db
        .prepare(
            "INSERT INTO asset_task_links (id, task_id, asset_id, ref_kind, ref_id, ref_date, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
        )
        .bind(linkId, claim, ref.assetId, key.kind, key.id, key.date, user.email, nowIso())
        .run();
    if (!claimed.meta.changes) {
        const winner = await existing();
        if (winner) return winner;
        throw new HttpError(409, "in_progress", "That task is being created. Try again in a moment.");
    }
    try {
        const { task } = await createTask(db, user, {
            title: (body.title ?? ref.title).slice(0, 500),
            description: `From Home & Assets: ${site}${ref.url}`,
            ...(body.dueDate !== undefined ? (body.dueDate ? { dueDate: body.dueDate } : {}) : ref.dueDate ? { dueDate: ref.dueDate } : {}),
            ...(body.projectId ? { projectId: body.projectId } : {}),
            clientId: `asset-${key.kind}-${key.id}-${key.date}`.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64),
        });
        await db.batch([
            db.prepare("UPDATE asset_task_links SET task_id = ? WHERE id = ?").bind(task.id, linkId),
            activity(db, { actor: user.email, action: "task.create", entityType: key.kind, entityId: key.id, assetId: ref.assetId, via }),
        ]);
        return { taskId: task.id, existing: false, hidden: false, url: `/portal/tasks/t/${task.id}` };
    } catch (error) {
        await db.prepare("DELETE FROM asset_task_links WHERE id = ?").bind(linkId).run();
        throw error;
    }
}

/** Tasks made for an asset's records and dates, as the caller may see them. */
export async function tasksForAsset(db: D1Database, user: PortalUser, assetId: string): Promise<(LinkedTask & { refKind: TaskRefKind; refDate: string })[]> {
    const rows = await db
        .prepare(
            `SELECT l.task_id, l.ref_kind, l.ref_date, CASE WHEN m.email IS NOT NULL THEN t.title END AS title, CASE WHEN m.email IS NOT NULL THEN t.status END AS status,
                CASE WHEN m.email IS NOT NULL THEN t.due_date END AS due
             FROM asset_task_links l LEFT JOIN task_items t ON t.id = l.task_id LEFT JOIN task_project_members m ON m.project_id = t.project_id AND m.email = ?
             WHERE l.asset_id = ? AND l.task_id NOT LIKE 'pending_%' ORDER BY l.created_at DESC LIMIT 100`,
        )
        .bind(user.email, assetId)
        .all<{ task_id: string; ref_kind: TaskRefKind; ref_date: string; title: string | null; status: string | null; due: string | null }>();
    return rows.results.map((r) => ({
        taskId: r.task_id,
        available: r.title !== null,
        title: r.title,
        status: r.status,
        dueDate: r.due,
        refKind: r.ref_kind,
        refDate: r.ref_date,
    }));
}

/** Which (kind, record, date) keys already have a task, for "No renewal Task has been created." */
export async function taskKeys(db: D1Database): Promise<Map<string, string>> {
    const rows = await db
        .prepare(
            "SELECT ref_kind, ref_id, ref_date, task_id FROM asset_task_links l WHERE task_id NOT LIKE 'pending_%' AND EXISTS (SELECT 1 FROM task_items t WHERE t.id = l.task_id)",
        )
        .all<{ ref_kind: string; ref_id: string; ref_date: string; task_id: string }>();
    return new Map(rows.results.map((r) => [`${r.ref_kind}:${r.ref_id}:${r.ref_date}`, r.task_id]));
}

// --- Calendar ------------------------------------------------------------------------------------

const appointmentInput = z
    .object({
        calendarId: z
            .string()
            .regex(/^cal_[a-z0-9]{14}$/)
            .optional(),
        durationMinutes: z.number().int().min(15).max(1440).optional(),
        visibility: z.enum(["default", "private"]).optional(),
    })
    .strict();

const addMinutes = (time: string, minutes: number) => {
    const total = Math.min(23 * 60 + 59, Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5)) + minutes);
    return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
};

/**
 * A real Calendar appointment for a booked record (its booked date, and time if given), created
 * through Calendar with its checks. Once per record: asking again returns the same event.
 */
export async function createAppointment(
    db: D1Database,
    user: PortalUser,
    maintenanceId: string,
    input: unknown,
): Promise<{ eventId: string; existing: boolean }> {
    if (!can(user, "calendar.use")) throw new HttpError(403, "forbidden", "You don't have access to Daly Calendar");
    const body = appointmentInput.parse(input ?? {});
    const { row, target } = await requireRecord(db, user, maintenanceId, true);
    if (row.calendar_event_id) {
        const still = await eventDetail(db, user, row.calendar_event_id).catch(() => null);
        if (still) return { eventId: row.calendar_event_id, existing: true };
    }
    if (!row.scheduled_on) throw new HttpError(422, "validation", "Enter the booked date first");
    const calendarId = body.calendarId ?? (await ensureDefaultCalendar(db, user));
    const timed = !!row.scheduled_time;
    const { event } = await createEvent(db, user, {
        calendarId,
        title: row.title.toLowerCase().includes(target.name.toLowerCase()) ? row.title : `${row.title}: ${target.name}`,
        description: "Booked in Home & Assets.",
        location: row.provider,
        allDay: !timed,
        startDate: row.scheduled_on,
        endDate: row.scheduled_on,
        ...(timed ? { startTime: row.scheduled_time, endTime: addMinutes(row.scheduled_time!, body.durationMinutes ?? 60) } : {}),
        category: "appointment",
        visibility: body.visibility ?? "default",
        clientId: `asset-appt-${maintenanceId}`,
    });
    await db.batch([
        db
            .prepare(
                "UPDATE asset_maintenance SET calendar_event_id = ?, status = CASE WHEN status = 'open' THEN 'scheduled' ELSE status END, updated_at = ? WHERE id = ?",
            )
            .bind(event.id, nowIso(), maintenanceId),
        activity(db, { actor: user.email, action: "maintenance.appointment", entityType: "maintenance", entityId: maintenanceId, assetId: row.asset_id }),
    ]);
    return { eventId: event.id, existing: false };
}

// --- Knowledge -----------------------------------------------------------------------------------

export async function knowledgeLinks(db: D1Database, user: PortalUser, assetId: string): Promise<KnowledgeLinkView[]> {
    const allowed = can(user, "knowledge.use") ? 1 : 0;
    const rows = await db
        .prepare(
            `SELECT l.object_id,
                CASE WHEN ?1 = 1 AND km.email IS NOT NULL AND o.status <> 'trashed' THEN coalesce(nullif(o.title, ''), 'Untitled') END AS title,
                CASE WHEN ?1 = 1 AND km.email IS NOT NULL AND o.status <> 'trashed' THEN s.name END AS space_name
             FROM asset_knowledge_links l LEFT JOIN knowledge_objects o ON o.id = l.object_id LEFT JOIN knowledge_spaces s ON s.id = o.space_id
             LEFT JOIN knowledge_memberships km ON km.space_id = o.space_id AND km.email = ?2
             WHERE l.asset_id = ?3 ORDER BY l.added_at`,
        )
        .bind(allowed, user.email, assetId)
        .all<{ object_id: string; title: string | null; space_name: string | null }>();
    return rows.results.map((r) => ({ objectId: r.object_id, available: r.title !== null, title: r.title, spaceName: r.space_name }));
}

export async function addKnowledgeLink(
    db: D1Database,
    user: PortalUser,
    assetId: string,
    objectId: unknown,
    via: "portal" | "mcp" = "portal",
): Promise<KnowledgeLinkView[]> {
    if (!can(user, "knowledge.use")) throw new HttpError(403, "forbidden", "You don't have access to Daly Knowledge");
    if (typeof objectId !== "string" || !/^kob_[a-z0-9]{14}$/.test(objectId)) throw new HttpError(422, "validation", "Choose a Knowledge object");
    await requireAsset(db, user, assetId, "edit");
    const object = await requireObject(db, user, objectId);
    if (object.status === "trashed") throw notFound();
    const count = await db.prepare("SELECT COUNT(*) AS n FROM asset_knowledge_links WHERE asset_id = ?").bind(assetId).first<{ n: number }>();
    if ((count?.n ?? 0) >= LIMITS.knowledgeLinksPerAsset)
        throw new HttpError(422, "limit", `An asset can link to up to ${LIMITS.knowledgeLinksPerAsset} Knowledge objects`);
    await db.batch([
        db
            .prepare("INSERT INTO asset_knowledge_links (asset_id, object_id, added_by, added_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING")
            .bind(assetId, objectId, user.email, nowIso()),
        activity(db, { actor: user.email, action: "knowledge.link", entityType: "asset", entityId: assetId, assetId, via }),
    ]);
    return knowledgeLinks(db, user, assetId);
}

export async function removeKnowledgeLink(db: D1Database, user: PortalUser, assetId: string, objectId: string): Promise<KnowledgeLinkView[]> {
    await requireAsset(db, user, assetId, "edit");
    await db.batch([
        db.prepare("DELETE FROM asset_knowledge_links WHERE asset_id = ? AND object_id = ?").bind(assetId, objectId),
        activity(db, { actor: user.email, action: "knowledge.unlink", entityType: "asset", entityId: assetId, assetId }),
    ]);
    return knowledgeLinks(db, user, assetId);
}
