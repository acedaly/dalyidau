// Maintenance: recurring schedules, the records of work planned or done, completion (which moves
// the schedule on and, if it's set to, creates the next record), problem reports and templates.
//
// Schedules belong to an asset or a location. Seeing a schedule or record needs sight of its asset
// (or location); changing one needs the asset's "Record maintenance" right (or edit rights on the
// location). Costs are shown only to people who can see the asset's financial values. Due dates
// come only from src/shared/assets/engine.ts, from intervals the person entered.
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { dueState, nextDue } from "../../src/shared/assets/engine";
import { BUILTIN_TEMPLATES } from "../../src/shared/assets/templates";
import {
    type HouseholdTemplate,
    type MaintenanceView,
    OPEN_MAINTENANCE,
    type Rights,
    type ScheduleView,
    completeMaintenanceInput,
    maintenanceInput,
    scheduleInput,
    templateInput,
    updateMaintenanceInput,
    updateScheduleInput,
} from "../../src/shared/assets/types";
import type { PortalUser } from "../../src/shared/portal/types";
import { newId, nowIso, parseJson } from "../portal/db";
import { HttpError } from "../portal/http";
import {
    type AssetAccessRow,
    type LocationRow,
    activity,
    assetPreferences,
    canEditLocation,
    clockFor,
    notFound,
    refuse,
    requireAsset,
    requireLocation,
    rightsOf,
    visibleAssets,
    visibleLocations,
} from "./access";

export class MaintenanceConflict extends HttpError {
    constructor(readonly current: { version: number; updatedAt: string } | null) {
        super(409, "conflict", "Someone changed this maintenance record since you opened it. Reload, then try again.");
    }
}

// --- Targets -------------------------------------------------------------------------------------

interface Target {
    kind: "asset" | "location";
    id: string;
    name: string;
    /** Can see costs. */
    financial: boolean;
    /** Can add and change maintenance. */
    maintain: boolean;
    currentKm: number | null;
    unit: "km" | "mi" | "hours";
}

const assetTarget = (row: AssetAccessRow, rights: Rights, km: number | null, unit: Target["unit"]): Target => ({
    kind: "asset",
    id: row.id,
    name: row.name,
    financial: rights.financial,
    maintain: rights.maintain,
    currentKm: km,
    unit,
});
const locationTarget = (row: LocationRow, email: string): Target => ({
    kind: "location",
    id: row.id,
    name: row.name,
    financial: true,
    maintain: canEditLocation(row, email),
    currentKm: null,
    unit: "km",
});

async function odometers(db: D1Database, assetIds: string[]): Promise<Map<string, { km: number | null; unit: Target["unit"] }>> {
    const out = new Map<string, { km: number | null; unit: Target["unit"] }>();
    for (let i = 0; i < assetIds.length; i += 90) {
        const chunk = assetIds.slice(i, i + 90);
        const rows = await db
            .prepare(
                `SELECT v.asset_id, v.odometer_unit,
                    (SELECT o.reading FROM asset_odometer o WHERE o.asset_id = v.asset_id ORDER BY o.read_on DESC, o.created_at DESC LIMIT 1) AS km
                 FROM asset_vehicles v WHERE v.asset_id IN (${chunk.map(() => "?").join(", ")})`,
            )
            .bind(...chunk)
            .all<{ asset_id: string; odometer_unit: Target["unit"]; km: number | null }>();
        for (const r of rows.results) out.set(r.asset_id, { km: r.km, unit: r.odometer_unit });
    }
    return out;
}

/** Everything maintenance can be recorded against that the caller can see. */
export async function targetsFor(db: D1Database, user: PortalUser): Promise<Map<string, Target>> {
    const [assets, locations] = await Promise.all([visibleAssets(db, user, 5000), visibleLocations(db, user, true)]);
    const km = await odometers(
        db,
        assets.map((a) => a.id),
    );
    const out = new Map<string, Target>();
    for (const a of assets) out.set(a.id, assetTarget(a, rightsOf(a), km.get(a.id)?.km ?? null, km.get(a.id)?.unit ?? "km"));
    for (const l of locations) out.set(l.id, locationTarget(l, user.email));
    return out;
}

async function requireTarget(
    db: D1Database,
    user: PortalUser,
    ids: { assetId?: string | null; locationId?: string | null },
    maintain: boolean,
): Promise<Target> {
    if (!!ids.assetId === !!ids.locationId) throw new HttpError(422, "validation", "Choose an asset or a place");
    if (ids.assetId) {
        const { row, rights } = await requireAsset(db, user, ids.assetId, maintain ? "maintain" : "view");
        const km = (await odometers(db, [row.id])).get(row.id);
        return assetTarget(row, rights, km?.km ?? null, km?.unit ?? "km");
    }
    const row = await requireLocation(db, user, ids.locationId!, maintain);
    return locationTarget(row, user.email);
}

// --- Schedules -----------------------------------------------------------------------------------

interface ScheduleRow {
    id: string;
    asset_id: string | null;
    location_id: string | null;
    title: string;
    category: ScheduleView["category"];
    interval_count: number | null;
    interval_unit: ScheduleView["intervalUnit"];
    interval_km: number | null;
    first_due_on: string | null;
    first_due_km: number | null;
    last_done_on: string | null;
    last_done_km: number | null;
    next_due_on: string | null;
    next_due_km: number | null;
    reminder_days: string;
    responsibility: ScheduleView["responsibility"];
    provider: string | null;
    notes: string | null;
    template_id: string | null;
    auto_next: number;
    active: number;
    version: number;
    created_by: string;
    open_id?: string | null;
}

const ruleOf = (r: ScheduleRow) => ({
    intervalCount: r.interval_count,
    intervalUnit: r.interval_unit,
    intervalKm: r.interval_km,
    firstDueOn: r.first_due_on,
    firstDueKm: r.first_due_km,
    lastDoneOn: r.last_done_on,
    lastDoneKm: r.last_done_km,
});

export function scheduleOut(r: ScheduleRow, target: Target, today: string, soonDays: number, soonKm: number): ScheduleView {
    const due = dueState({ dueOn: r.next_due_on, dueKm: r.next_due_km, currentKm: target.currentKm, today, soonDays, soonKm });
    return {
        id: r.id,
        assetId: r.asset_id,
        locationId: r.location_id,
        targetName: target.name,
        title: r.title,
        category: r.category,
        intervalCount: r.interval_count,
        intervalUnit: r.interval_unit,
        intervalKm: r.interval_km,
        firstDueOn: r.first_due_on,
        firstDueKm: r.first_due_km,
        lastDoneOn: r.last_done_on,
        lastDoneKm: r.last_done_km,
        nextDueOn: r.next_due_on,
        nextDueKm: r.next_due_km,
        remainingKm: due.remainingKm,
        state: r.active ? due.state : "unknown",
        unknownReason: r.active ? due.reason : "Paused",
        reminderDays: parseJson<number[]>(r.reminder_days, []),
        responsibility: r.responsibility,
        provider: r.provider,
        notes: r.notes,
        templateId: r.template_id,
        autoNext: !!r.auto_next,
        active: !!r.active,
        openRecordId: r.open_id ?? null,
        version: r.version,
    };
}

const SCHEDULE_SELECT = `SELECT sc.*, (SELECT m.id FROM asset_maintenance m WHERE m.schedule_id = sc.id AND m.status IN ('open', 'requested', 'scheduled', 'in_progress')) AS open_id FROM asset_schedules sc`;

export async function listSchedules(db: D1Database, user: PortalUser, filter: { assetId?: string; locationId?: string } = {}, targets?: Map<string, Target>) {
    const all = targets ?? (await targetsFor(db, user));
    const where = filter.assetId ? "WHERE sc.asset_id = ?" : filter.locationId ? "WHERE sc.location_id = ?" : "";
    const rows = await db
        .prepare(`${SCHEDULE_SELECT} ${where} ORDER BY sc.next_due_on IS NULL, sc.next_due_on LIMIT 2000`)
        .bind(...(filter.assetId ? [filter.assetId] : filter.locationId ? [filter.locationId] : []))
        .all<ScheduleRow>();
    const [{ today }, { preferences }] = await Promise.all([clockFor(db, user.email), assetPreferences(db, user.email)]);
    return rows.results
        .filter((r) => all.has((r.asset_id ?? r.location_id)!))
        .map((r) => scheduleOut(r, all.get((r.asset_id ?? r.location_id)!)!, today, preferences.dueSoonDays, preferences.dueSoonDistance));
}

/** Recomputes the stored next due date and distance from the rule. */
const recompute = (db: D1Database, id: string, row: ScheduleRow) => {
    const next = nextDue(ruleOf(row));
    return db.prepare("UPDATE asset_schedules SET next_due_on = ?, next_due_km = ? WHERE id = ?").bind(next.dueOn, next.dueKm, id);
};

const getSchedule = (db: D1Database, id: string) => db.prepare("SELECT * FROM asset_schedules WHERE id = ?").bind(id).first<ScheduleRow>();

async function requireSchedule(db: D1Database, user: PortalUser, id: string, maintain: boolean): Promise<{ row: ScheduleRow; target: Target }> {
    const row = await getSchedule(db, id);
    if (!row) throw notFound();
    const target = await requireTarget(db, user, { assetId: row.asset_id, locationId: row.location_id }, false).catch(() => {
        throw notFound();
    });
    if (maintain && !target.maintain)
        throw target.kind === "asset" ? refuse("maintain") : new HttpError(403, "forbidden", "You can view this place but not change it");
    return { row, target };
}

const checkInterval = (b: { intervalCount?: number | null; intervalUnit?: string | null; intervalKm?: number | null }) => {
    if (!!b.intervalCount !== !!b.intervalUnit) throw new HttpError(422, "validation", "Give the interval as a number and a unit (e.g. 12 months)");
    if (!b.intervalCount && !b.intervalKm)
        throw new HttpError(422, "validation", "Enter how often it's needed: a time, a distance, or both (whichever comes first)");
};

export async function createSchedule(db: D1Database, user: PortalUser, input: unknown): Promise<ScheduleView> {
    const body = scheduleInput.parse(input);
    checkInterval(body);
    const target = await requireTarget(db, user, body, true);
    if ((body.intervalKm || body.firstDueKm !== undefined || body.lastDoneKm !== undefined) && target.kind === "location")
        throw new HttpError(422, "validation", "Distances only apply to vehicles");
    const id = newId("ams");
    const now = nowIso();
    const row: ScheduleRow = {
        id,
        asset_id: body.assetId ?? null,
        location_id: body.locationId ?? null,
        title: body.title,
        category: body.category,
        interval_count: body.intervalCount ?? null,
        interval_unit: body.intervalUnit ?? null,
        interval_km: body.intervalKm ?? null,
        first_due_on: body.firstDueOn ?? null,
        first_due_km: body.firstDueKm ?? null,
        last_done_on: body.lastDoneOn ?? null,
        last_done_km: body.lastDoneKm ?? null,
        next_due_on: null,
        next_due_km: null,
        reminder_days: JSON.stringify([...new Set(body.reminderDays ?? [14, 0])].sort((a, b) => b - a)),
        responsibility: body.responsibility ?? "owner",
        provider: body.provider ?? null,
        notes: body.notes ?? null,
        template_id: body.templateId ?? null,
        auto_next: body.autoNext === false ? 0 : 1,
        active: body.active === false ? 0 : 1,
        version: 1,
        created_by: user.email,
    };
    const next = nextDue(ruleOf(row));
    await db.batch([
        db
            .prepare(
                `INSERT INTO asset_schedules (id, asset_id, location_id, title, category, interval_count, interval_unit, interval_km, first_due_on, first_due_km,
                    last_done_on, last_done_km, next_due_on, next_due_km, reminder_days, responsibility, provider, notes, template_id, auto_next, active,
                    created_by, created_at, updated_by, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
                id,
                row.asset_id,
                row.location_id,
                row.title,
                row.category,
                row.interval_count,
                row.interval_unit,
                row.interval_km,
                row.first_due_on,
                row.first_due_km,
                row.last_done_on,
                row.last_done_km,
                next.dueOn,
                next.dueKm,
                row.reminder_days,
                row.responsibility,
                row.provider,
                row.notes,
                row.template_id,
                row.auto_next,
                row.active,
                user.email,
                now,
                user.email,
                now,
            ),
        activity(db, { actor: user.email, action: "schedule.create", entityType: "schedule", entityId: id, assetId: row.asset_id }),
    ]);
    return (await listSchedules(db, user, row.asset_id ? { assetId: row.asset_id } : { locationId: row.location_id! })).find((s) => s.id === id)!;
}

const SCHEDULE_COLUMNS: Record<string, string> = {
    title: "title",
    category: "category",
    intervalCount: "interval_count",
    intervalUnit: "interval_unit",
    intervalKm: "interval_km",
    firstDueOn: "first_due_on",
    firstDueKm: "first_due_km",
    lastDoneOn: "last_done_on",
    lastDoneKm: "last_done_km",
    responsibility: "responsibility",
    provider: "provider",
    notes: "notes",
    templateId: "template_id",
};

export async function updateSchedule(db: D1Database, user: PortalUser, id: string, input: unknown): Promise<ScheduleView> {
    const body = updateScheduleInput.parse(input) as Record<string, unknown> & { version: number };
    const { row } = await requireSchedule(db, user, id, true);
    const merged = {
        intervalCount: body.intervalCount === undefined ? row.interval_count : body.intervalCount,
        intervalUnit: body.intervalUnit === undefined ? row.interval_unit : body.intervalUnit,
        intervalKm: body.intervalKm === undefined ? row.interval_km : body.intervalKm,
    } as { intervalCount: number | null; intervalUnit: string | null; intervalKm: number | null };
    checkInterval(merged);
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of Object.entries(SCHEDULE_COLUMNS))
        if (body[key] !== undefined) {
            sets.push(`${column} = ?`);
            values.push(body[key] ?? null);
        }
    if (body.reminderDays !== undefined) {
        sets.push("reminder_days = ?");
        values.push(JSON.stringify([...new Set(body.reminderDays as number[])].sort((a, b) => b - a)));
    }
    for (const [key, column] of [
        ["autoNext", "auto_next"],
        ["active", "active"],
    ] as const)
        if (body[key] !== undefined) {
            sets.push(`${column} = ?`);
            values.push(body[key] ? 1 : 0);
        }
    const result = await db
        .prepare(`UPDATE asset_schedules SET ${[...sets, "version = version + 1", "updated_by = ?", "updated_at = ?"].join(", ")} WHERE id = ? AND version = ?`)
        .bind(...values, user.email, nowIso(), id, body.version)
        .run();
    if (!result.meta.changes) throw new HttpError(409, "conflict", "Someone changed this schedule since you opened it. Reload, then try again.");
    const fresh = (await getSchedule(db, id))!;
    await db.batch([
        recompute(db, id, fresh),
        activity(db, { actor: user.email, action: "schedule.update", entityType: "schedule", entityId: id, assetId: row.asset_id }),
    ]);
    // An open record that came from this schedule follows its new due date.
    const next = nextDue(ruleOf(fresh));
    await db
        .prepare("UPDATE asset_maintenance SET due_on = ?, due_km = ?, updated_at = ? WHERE schedule_id = ? AND status = 'open'")
        .bind(next.dueOn, next.dueKm, nowIso(), id)
        .run();
    return (await listSchedules(db, user, fresh.asset_id ? { assetId: fresh.asset_id } : { locationId: fresh.location_id! })).find((s) => s.id === id)!;
}

/** Removes a schedule. Records made from it stay, as history. */
export async function deleteSchedule(db: D1Database, user: PortalUser, id: string) {
    const { row } = await requireSchedule(db, user, id, true);
    await db.batch([
        db.prepare("UPDATE asset_maintenance SET status = 'cancelled', updated_at = ? WHERE schedule_id = ? AND status = 'open'").bind(nowIso(), id),
        db.prepare("DELETE FROM asset_schedules WHERE id = ?").bind(id),
        activity(db, { actor: user.email, action: "schedule.delete", entityType: "schedule", entityId: id, assetId: row.asset_id }),
    ]);
}

// --- Records -------------------------------------------------------------------------------------

interface MaintenanceRow {
    id: string;
    asset_id: string | null;
    location_id: string | null;
    schedule_id: string | null;
    title: string;
    description: string | null;
    kind: MaintenanceView["kind"];
    category: MaintenanceView["category"];
    priority: MaintenanceView["priority"];
    status: MaintenanceView["status"];
    due_on: string | null;
    due_km: number | null;
    scheduled_on: string | null;
    scheduled_time: string | null;
    completed_on: string | null;
    odometer: number | null;
    cost_cents: number | null;
    provider: string | null;
    notes: string | null;
    responsibility: MaintenanceView["responsibility"];
    request_reference: string | null;
    requested_on: string | null;
    approval: MaintenanceView["approval"];
    checklist: string;
    calendar_event_id: string | null;
    client_id: string | null;
    version: number;
    updated_at: string;
    files: number;
}

/** Records with their file counts. */
const RECORD_SELECT = `SELECT m.*, (SELECT COUNT(*) FROM asset_files f WHERE f.maintenance_id = m.id AND f.status = 'stored') AS files
    FROM asset_maintenance m`;

export function recordOut(r: MaintenanceRow, target: Target, today: string, soonDays: number, soonKm: number): MaintenanceView {
    const open = OPEN_MAINTENANCE.includes(r.status);
    return {
        id: r.id,
        assetId: r.asset_id,
        locationId: r.location_id,
        targetName: target.name,
        scheduleId: r.schedule_id,
        title: r.title,
        description: r.description,
        kind: r.kind,
        category: r.category,
        priority: r.priority,
        status: r.status,
        dueOn: r.due_on,
        dueKm: r.due_km,
        scheduledOn: r.scheduled_on,
        scheduledTime: r.scheduled_time,
        completedOn: r.completed_on,
        odometer: r.odometer,
        costCents: target.financial ? r.cost_cents : null,
        costHidden: !target.financial,
        provider: r.provider,
        notes: r.notes,
        responsibility: r.responsibility,
        requestReference: r.request_reference,
        requestedOn: r.requested_on,
        approval: r.approval,
        checklist: parseJson<{ text: string; done: boolean }[]>(r.checklist, []),
        state: open ? dueState({ dueOn: r.due_on, dueKm: r.due_km, currentKm: target.currentKm, today, soonDays, soonKm }).state : null,
        calendarEventId: r.calendar_event_id,
        fileCount: r.files,
        canEdit: target.maintain,
        version: r.version,
        updatedAt: r.updated_at,
    };
}

export interface RecordFilter {
    assetId?: string;
    locationId?: string;
    scope?: "open" | "history" | "all";
    limit?: number;
}

export async function listMaintenance(db: D1Database, user: PortalUser, filter: RecordFilter = {}, targets?: Map<string, Target>): Promise<MaintenanceView[]> {
    const all = targets ?? (await targetsFor(db, user));
    const where: string[] = [];
    const binds: unknown[] = [];
    if (filter.assetId) {
        where.push(`m.asset_id = ?${binds.push(filter.assetId)}`);
    } else if (filter.locationId) {
        where.push(`m.location_id = ?${binds.push(filter.locationId)}`);
    }
    if (filter.scope === "open") where.push("m.status IN ('open', 'requested', 'scheduled', 'in_progress')");
    else if (filter.scope === "history") where.push("m.status IN ('completed', 'cancelled')");
    const order = filter.scope === "history" ? "m.completed_on DESC, m.updated_at DESC" : "m.due_on IS NULL, m.due_on, m.created_at";
    const rows = await db
        .prepare(`${RECORD_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ${order} LIMIT ${Math.min(filter.limit ?? 1000, 2000)}`)
        .bind(...binds)
        .all<MaintenanceRow>();
    const [{ today }, { preferences }] = await Promise.all([clockFor(db, user.email), assetPreferences(db, user.email)]);
    return rows.results
        .filter((r) => all.has((r.asset_id ?? r.location_id)!))
        .map((r) => recordOut(r, all.get((r.asset_id ?? r.location_id)!)!, today, preferences.dueSoonDays, preferences.dueSoonDistance));
}

export async function requireRecord(db: D1Database, user: PortalUser, id: string, maintain: boolean): Promise<{ row: MaintenanceRow; target: Target }> {
    const row = await db.prepare(`${RECORD_SELECT} WHERE m.id = ?`).bind(id).first<MaintenanceRow>();
    if (!row) throw notFound();
    const target = await requireTarget(db, user, { assetId: row.asset_id, locationId: row.location_id }, false).catch(() => {
        throw notFound();
    });
    if (maintain && !target.maintain)
        throw target.kind === "asset" ? refuse("maintain") : new HttpError(403, "forbidden", "You can view this place but not change it");
    return { row, target };
}

export async function maintenanceView(db: D1Database, user: PortalUser, id: string): Promise<MaintenanceView> {
    const { row, target } = await requireRecord(db, user, id, false);
    const [{ today }, { preferences }] = await Promise.all([clockFor(db, user.email), assetPreferences(db, user.email)]);
    return recordOut(row, target, today, preferences.dueSoonDays, preferences.dueSoonDistance);
}

const RECORD_COLUMNS: Record<string, string> = {
    title: "title",
    description: "description",
    kind: "kind",
    category: "category",
    priority: "priority",
    status: "status",
    dueOn: "due_on",
    dueKm: "due_km",
    scheduledOn: "scheduled_on",
    scheduledTime: "scheduled_time",
    completedOn: "completed_on",
    odometer: "odometer",
    costCents: "cost_cents",
    provider: "provider",
    notes: "notes",
    responsibility: "responsibility",
    requestReference: "request_reference",
    requestedOn: "requested_on",
    approval: "approval",
};

export async function createMaintenance(
    db: D1Database,
    user: PortalUser,
    input: unknown,
    via: "portal" | "mcp" = "portal",
): Promise<{ record: MaintenanceView; replayed: boolean }> {
    const body = maintenanceInput.parse(input) as Record<string, unknown> & { assetId?: string; locationId?: string; scheduleId?: string; clientId?: string };
    if (body.clientId) {
        const earlier = await db
            .prepare("SELECT id FROM asset_maintenance WHERE created_by = ? AND client_id = ?")
            .bind(user.email, body.clientId)
            .first<{ id: string }>();
        if (earlier) return { record: await maintenanceView(db, user, earlier.id), replayed: true };
    }
    const target = await requireTarget(db, user, body, true);
    if (body.costCents !== undefined && body.costCents !== null && !target.financial) throw refuse("financial");
    if (body.scheduleId) {
        const schedule = await getSchedule(db, body.scheduleId);
        if (!schedule || (schedule.asset_id ?? schedule.location_id) !== target.id)
            throw new HttpError(422, "validation", "That schedule belongs to something else");
    }
    if (body.status === "completed" && !body.completedOn) body.completedOn = (await clockFor(db, user.email)).today;
    const id = newId("amr");
    const now = nowIso();
    const columns = Object.keys(RECORD_COLUMNS).filter((k) => body[k] !== undefined);
    await db
        .batch([
            db
                .prepare(
                    `INSERT INTO asset_maintenance (id, asset_id, location_id, schedule_id, ${columns.map((k) => RECORD_COLUMNS[k]).join(", ")}${columns.length ? ", " : ""}checklist, client_id, created_by, created_at, updated_by, updated_at)
                     VALUES (?, ?, ?, ?, ${columns.map(() => "?").join(", ")}${columns.length ? ", " : ""}?, ?, ?, ?, ?, ?)`,
                )
                .bind(
                    id,
                    body.assetId ?? null,
                    body.locationId ?? null,
                    body.scheduleId ?? null,
                    ...columns.map((k) => body[k] ?? null),
                    JSON.stringify(body.checklist ?? []),
                    body.clientId ?? null,
                    user.email,
                    now,
                    user.email,
                    now,
                ),
            activity(db, { actor: user.email, action: "maintenance.create", entityType: "maintenance", entityId: id, assetId: body.assetId ?? null, via }),
        ])
        .catch((error: Error) => {
            if (/asset_maintenance_open_schedule|UNIQUE constraint failed: asset_maintenance.schedule_id/.test(error.message))
                throw new HttpError(409, "duplicate", "That schedule already has an open record. Complete or cancel it first.");
            throw error;
        });
    if (body.status === "completed" && body.odometer && target.kind === "asset")
        await recordOdometer(db, user, target.id, body.odometer as number, body.completedOn as string, id);
    return { record: await maintenanceView(db, user, id), replayed: false };
}

/** Problem reports (from an asset's page or a QR scan): a corrective record, to do now. */
export async function reportProblem(db: D1Database, user: PortalUser, assetId: string, input: unknown) {
    const body = maintenanceInput.pick({ title: true, description: true, priority: true }).strict().parse(input);
    return createMaintenance(db, user, {
        ...body,
        assetId,
        kind: "corrective",
        category: "repair",
        status: "open",
        dueOn: (await clockFor(db, user.email)).today,
    });
}

export async function updateMaintenance(db: D1Database, user: PortalUser, id: string, input: unknown): Promise<MaintenanceView> {
    const body = updateMaintenanceInput.parse(input) as Record<string, unknown> & { version: number };
    const { row, target } = await requireRecord(db, user, id, true);
    if (body.costCents !== undefined && !target.financial) throw refuse("financial");
    if (body.status === "completed") throw new HttpError(422, "validation", "Use Complete to finish a record, so its schedule moves on");
    if (row.status === "completed" && body.status && body.status !== "completed")
        throw new HttpError(422, "validation", "A completed record stays completed. Add a new record instead.");
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of Object.entries(RECORD_COLUMNS))
        if (body[key] !== undefined) {
            sets.push(`${column} = ?`);
            values.push(body[key] ?? null);
        }
    if (body.checklist !== undefined) {
        sets.push("checklist = ?");
        values.push(JSON.stringify(body.checklist));
    }
    const result = await db
        .prepare(
            `UPDATE asset_maintenance SET ${[...sets, "version = version + 1", "updated_by = ?", "updated_at = ?"].join(", ")} WHERE id = ? AND version = ?`,
        )
        .bind(...values, user.email, nowIso(), id, body.version)
        .run();
    if (!result.meta.changes) {
        const current = await db
            .prepare("SELECT version, updated_at FROM asset_maintenance WHERE id = ?")
            .bind(id)
            .first<{ version: number; updated_at: string }>();
        throw new MaintenanceConflict(current ? { version: current.version, updatedAt: current.updated_at } : null);
    }
    await activity(db, { actor: user.email, action: "maintenance.update", entityType: "maintenance", entityId: id, assetId: row.asset_id }).run();
    return maintenanceView(db, user, id);
}

/** An odometer reading from completed work, if it fits the history (never an error for the completion itself). */
async function recordOdometer(db: D1Database, user: PortalUser, assetId: string, reading: number, on: string, maintenanceId: string) {
    const vehicle = await db.prepare("SELECT 1 FROM asset_vehicles WHERE asset_id = ?").bind(assetId).first();
    if (!vehicle) return;
    const before = await db
        .prepare("SELECT MAX(reading) AS n FROM asset_odometer WHERE asset_id = ? AND read_on <= ?")
        .bind(assetId, on)
        .first<{ n: number | null }>();
    const after = await db
        .prepare("SELECT MIN(reading) AS n FROM asset_odometer WHERE asset_id = ? AND read_on > ?")
        .bind(assetId, on)
        .first<{ n: number | null }>();
    if ((before?.n ?? -1) > reading || (after?.n !== null && after?.n !== undefined && after.n < reading)) return;
    await db
        .prepare(
            "INSERT INTO asset_odometer (id, asset_id, reading, read_on, maintenance_id, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, 'From maintenance', ?, ?)",
        )
        .bind(newId("aodo"), assetId, reading, on, maintenanceId, user.email, nowIso())
        .run();
}

export interface CompletionResult {
    record: MaintenanceView;
    /** The next record created from the schedule, if any. */
    next: MaintenanceView | null;
    alreadyDone: boolean;
}

export async function completeMaintenance(
    db: D1Database,
    user: PortalUser,
    id: string,
    input: unknown,
    via: "portal" | "mcp" = "portal",
): Promise<CompletionResult> {
    const body = completeMaintenanceInput.parse(input);
    const { row, target } = await requireRecord(db, user, id, true);
    if (row.status === "completed") return { record: await maintenanceView(db, user, id), next: null, alreadyDone: true };
    if (row.status === "cancelled") throw new HttpError(422, "validation", "This record was cancelled");
    if (body.version !== undefined && body.version !== row.version) throw new MaintenanceConflict({ version: row.version, updatedAt: row.updated_at });
    const { today } = await clockFor(db, user.email);
    if (body.completedOn > today) throw new HttpError(422, "validation", "It can't be completed in the future");
    if (body.costCents !== undefined && body.costCents !== null && !target.financial) throw refuse("financial");
    if (body.odometer !== undefined && body.odometer !== null && target.kind !== "asset")
        throw new HttpError(422, "validation", "Odometer readings are for vehicles");
    const now = nowIso();
    const statements: D1PreparedStatement[] = [
        db
            .prepare(
                `UPDATE asset_maintenance SET status = 'completed', completed_on = ?, odometer = COALESCE(?, odometer), cost_cents = COALESCE(?, cost_cents),
                    provider = COALESCE(?, provider), notes = COALESCE(?, notes), version = version + 1, updated_by = ?, updated_at = ?
                 WHERE id = ? AND status NOT IN ('completed', 'cancelled')`,
            )
            .bind(body.completedOn, body.odometer ?? null, body.costCents ?? null, body.provider ?? null, body.notes ?? null, user.email, now, id),
        activity(db, { actor: user.email, action: "maintenance.complete", entityType: "maintenance", entityId: id, assetId: row.asset_id, via }),
    ];
    let nextId: string | null = null;
    const schedule = row.schedule_id ? await getSchedule(db, row.schedule_id) : null;
    if (schedule) {
        // The schedule counts from when this was actually done (and at what reading).
        const done: ScheduleRow = {
            ...schedule,
            last_done_on: body.completedOn > (schedule.last_done_on ?? "") ? body.completedOn : schedule.last_done_on,
            last_done_km: body.odometer ?? schedule.last_done_km,
        };
        const next = nextDue(ruleOf(done));
        statements.push(
            db
                .prepare(
                    "UPDATE asset_schedules SET last_done_on = ?, last_done_km = ?, next_due_on = ?, next_due_km = ?, version = version + 1, updated_at = ? WHERE id = ?",
                )
                .bind(done.last_done_on, done.last_done_km, next.dueOn, next.dueKm, now, schedule.id),
        );
        if (schedule.auto_next && schedule.active && (next.dueOn || next.dueKm !== null)) {
            nextId = newId("amr");
            // The unique index on open records per schedule makes this a no-op if one already exists.
            statements.push(
                db
                    .prepare(
                        `INSERT INTO asset_maintenance (id, asset_id, location_id, schedule_id, title, kind, category, status, due_on, due_km, provider, responsibility, created_by, created_at, updated_by, updated_at)
                         SELECT ?, ?, ?, ?, ?, 'preventive', ?, 'open', ?, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (
                             SELECT 1 FROM asset_maintenance WHERE schedule_id = ? AND status IN ('open', 'requested', 'scheduled', 'in_progress') AND id <> ?)`,
                    )
                    .bind(
                        nextId,
                        schedule.asset_id,
                        schedule.location_id,
                        schedule.id,
                        schedule.title,
                        schedule.category,
                        next.dueOn,
                        next.dueKm,
                        schedule.provider,
                        schedule.responsibility,
                        user.email,
                        now,
                        user.email,
                        now,
                        schedule.id,
                        id,
                    ),
            );
        }
    }
    const results = await db.batch(statements);
    if (!results[0].meta.changes) return { record: await maintenanceView(db, user, id), next: null, alreadyDone: true };
    const nextCreated = nextId && results[results.length - 1].meta.changes ? nextId : null;
    if (body.odometer && target.kind === "asset") await recordOdometer(db, user, target.id, body.odometer, body.completedOn, id);
    return {
        record: await maintenanceView(db, user, id),
        next: nextCreated ? await maintenanceView(db, user, nextCreated) : null,
        alreadyDone: false,
    };
}

/** Cancels an open record (kept as history), or deletes a record the caller made by mistake today. */
export async function cancelMaintenance(db: D1Database, user: PortalUser, id: string) {
    const { row } = await requireRecord(db, user, id, true);
    if (row.status === "completed") throw new HttpError(422, "validation", "A completed record is history and can't be cancelled");
    await db.batch([
        db
            .prepare("UPDATE asset_maintenance SET status = 'cancelled', version = version + 1, updated_by = ?, updated_at = ? WHERE id = ?")
            .bind(user.email, nowIso(), id),
        activity(db, { actor: user.email, action: "maintenance.cancel", entityType: "maintenance", entityId: id, assetId: row.asset_id }),
    ]);
}

// --- Templates -----------------------------------------------------------------------------------

export async function listTemplates(db: D1Database): Promise<HouseholdTemplate[]> {
    const rows = await db.prepare("SELECT * FROM asset_maintenance_templates ORDER BY title LIMIT 200").all<{
        id: string;
        title: string;
        category: HouseholdTemplate["category"];
        applies_to: string;
        interval_count: number | null;
        interval_unit: HouseholdTemplate["intervalUnit"];
        interval_km: number | null;
        checklist: string;
        notes: string | null;
    }>();
    return rows.results.map((r) => ({
        id: r.id,
        title: r.title,
        category: r.category,
        appliesTo: r.applies_to,
        intervalCount: r.interval_count,
        intervalUnit: r.interval_unit,
        intervalKm: r.interval_km,
        checklist: parseJson<string[]>(r.checklist, []),
        notes: r.notes,
        builtin: false,
    }));
}

export const builtinTemplates = () => [...BUILTIN_TEMPLATES];

export async function createTemplate(db: D1Database, user: PortalUser, input: unknown): Promise<HouseholdTemplate[]> {
    const body = templateInput.parse(input);
    if (!!body.intervalCount !== !!body.intervalUnit) throw new HttpError(422, "validation", "Give the interval as a number and a unit");
    const id = newId("amt");
    const now = nowIso();
    await db.batch([
        db
            .prepare(
                `INSERT INTO asset_maintenance_templates (id, title, category, applies_to, interval_count, interval_unit, interval_km, checklist, notes, created_by, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
                id,
                body.title,
                body.category,
                body.appliesTo ?? "any",
                body.intervalCount ?? null,
                body.intervalUnit ?? null,
                body.intervalKm ?? null,
                JSON.stringify(body.checklist ?? []),
                body.notes ?? null,
                user.email,
                now,
                now,
            ),
        activity(db, { actor: user.email, action: "template.create", entityType: "template", entityId: id }),
    ]);
    return listTemplates(db);
}

export async function deleteTemplate(db: D1Database, user: PortalUser, id: string): Promise<HouseholdTemplate[]> {
    const row = await db.prepare("SELECT created_by FROM asset_maintenance_templates WHERE id = ?").bind(id).first<{ created_by: string }>();
    if (!row) throw notFound();
    await db.batch([
        db.prepare("DELETE FROM asset_maintenance_templates WHERE id = ?").bind(id),
        activity(db, { actor: user.email, action: "template.delete", entityType: "template", entityId: id }),
    ]);
    return listTemplates(db);
}
