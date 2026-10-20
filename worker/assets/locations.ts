// Places: homes, rentals, garages, sheds, storage, rooms, and vehicles or campers used as places.
// A place is private to whoever added it unless they share it with the household (view, and
// optionally edit). An address, lease dates and property-manager details are only ever shown to
// people who can see the place. Responsibility for maintenance at a rental is recorded per
// schedule or record as the household understands it; nothing here states what the law requires.
import type { D1Database } from "@cloudflare/workers-types";
import { type LocationView, locationInput, updateLocationInput } from "../../src/shared/assets/types";
import type { PortalUser } from "../../src/shared/portal/types";
import { newId, nowIso } from "../portal/db";
import { HttpError } from "../portal/http";
import { LOCATION_VISIBLE, type LocationRow, VISIBLE, activity, canEditLocation, namesFor, notFound, requireLocation } from "./access";

const COLUMNS: Record<string, string> = {
    name: "name",
    kind: "kind",
    parentId: "parent_id",
    tenure: "tenure",
    address: "address",
    leaseStart: "lease_start",
    leaseEnd: "lease_end",
    managerName: "manager_name",
    managerPhone: "manager_phone",
    managerEmail: "manager_email",
    nextInspectionOn: "next_inspection_on",
    utilities: "utilities",
    notes: "notes",
    visibility: "visibility",
};

export async function listLocations(db: D1Database, user: PortalUser, options: { includeArchived?: boolean; only?: string } = {}): Promise<LocationView[]> {
    const rows = await db
        .prepare(
            `WITH ${VISIBLE}
             SELECT l.*, p.name AS parent_name,
                (SELECT COUNT(*) FROM assets a JOIN visible v ON v.id = a.id WHERE a.location_id = l.id) AS asset_count,
                (SELECT COUNT(*) FROM asset_maintenance m WHERE m.location_id = l.id AND m.status IN ('open', 'requested', 'scheduled', 'in_progress')) AS open_count
             FROM asset_locations l LEFT JOIN asset_locations p ON p.id = l.parent_id AND (p.owner_email = ?1 OR p.visibility = 'household')
             WHERE ${LOCATION_VISIBLE} ${options.includeArchived ? "" : "AND l.archived_at IS NULL"} ${options.only ? "AND l.id = ?2" : ""}
             ORDER BY l.parent_id IS NOT NULL, l.name COLLATE NOCASE LIMIT 500`,
        )
        .bind(user.email, ...(options.only ? [options.only] : []))
        .all<LocationRow & { parent_name: string | null; asset_count: number; open_count: number }>();
    const names = await namesFor(
        db,
        rows.results.map((r) => r.owner_email),
    );
    return rows.results.map((r) => ({
        id: r.id,
        name: r.name,
        kind: r.kind as LocationView["kind"],
        parentId: r.parent_name ? r.parent_id : null,
        parentName: r.parent_name,
        tenure: r.tenure as LocationView["tenure"],
        address: r.address,
        leaseStart: r.lease_start,
        leaseEnd: r.lease_end,
        managerName: r.manager_name,
        managerPhone: r.manager_phone,
        managerEmail: r.manager_email,
        nextInspectionOn: r.next_inspection_on,
        utilities: r.utilities,
        notes: r.notes,
        visibility: r.visibility,
        householdCanEdit: !!r.household_can_edit,
        mine: r.owner_email === user.email,
        canEdit: canEditLocation(r, user.email),
        owner: { email: r.owner_email, name: names.get(r.owner_email.toLowerCase()) ?? null },
        archived: !!r.archived_at,
        assetCount: r.asset_count,
        openMaintenance: r.open_count,
        version: r.version,
    }));
}

export async function locationView(db: D1Database, user: PortalUser, id: string): Promise<LocationView> {
    const [view] = await listLocations(db, user, { includeArchived: true, only: id });
    if (!view) throw notFound();
    return view;
}

const checkLease = (start: string | null | undefined, end: string | null | undefined) => {
    if (start && end && end < start) throw new HttpError(422, "validation", "The lease ends before it starts");
};

export async function createLocation(db: D1Database, user: PortalUser, input: unknown): Promise<LocationView> {
    const body = locationInput.parse(input) as Record<string, unknown>;
    checkLease(body.leaseStart as string, body.leaseEnd as string);
    if (body.parentId) await requireLocation(db, user, body.parentId as string);
    if (body.householdCanEdit && body.visibility !== "household")
        throw new HttpError(422, "validation", "Share the place with the household before letting them edit it");
    const id = newId("alo");
    const now = nowIso();
    const columns = Object.keys(COLUMNS).filter((k) => body[k] !== undefined);
    await db.batch([
        db
            .prepare(
                `INSERT INTO asset_locations (id, owner_email, ${columns.map((k) => COLUMNS[k]).join(", ")}, household_can_edit, created_by, created_at, updated_by, updated_at)
                 VALUES (?, ?, ${columns.map(() => "?").join(", ")}, ?, ?, ?, ?, ?)`,
            )
            .bind(id, user.email, ...columns.map((k) => body[k] ?? null), body.householdCanEdit ? 1 : 0, user.email, now, user.email, now),
        activity(db, { actor: user.email, action: "location.create", entityType: "location", entityId: id }),
    ]);
    return locationView(db, user, id);
}

export async function updateLocation(db: D1Database, user: PortalUser, id: string, input: unknown): Promise<LocationView> {
    const body = updateLocationInput.parse(input) as Record<string, unknown> & { version: number };
    const row = await requireLocation(db, user, id, true);
    if ((body.visibility !== undefined || body.householdCanEdit !== undefined) && row.owner_email !== user.email)
        throw new HttpError(403, "forbidden", "Only the person who added this place can change who sees it");
    const visibility = (body.visibility as string | undefined) ?? row.visibility;
    const canEdit = body.householdCanEdit === undefined ? !!row.household_can_edit && visibility === "household" : !!body.householdCanEdit;
    if (canEdit && visibility !== "household") throw new HttpError(422, "validation", "Share the place with the household before letting them edit it");
    checkLease(
        body.leaseStart === undefined ? row.lease_start : (body.leaseStart as string | null),
        body.leaseEnd === undefined ? row.lease_end : (body.leaseEnd as string | null),
    );
    if (body.parentId) {
        if (body.parentId === id) throw new HttpError(422, "validation", "A place can't be inside itself");
        const parent = await requireLocation(db, user, body.parentId as string);
        if (parent.parent_id === id) throw new HttpError(422, "validation", "That place is already inside this one");
    }
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of Object.entries(COLUMNS))
        if (body[key] !== undefined) {
            sets.push(`${column} = ?`);
            values.push(body[key] ?? null);
        }
    sets.push("household_can_edit = ?");
    values.push(canEdit ? 1 : 0);
    if (body.archived !== undefined) {
        sets.push("archived_at = ?");
        values.push(body.archived ? nowIso() : null);
    }
    const result = await db
        .prepare(`UPDATE asset_locations SET ${[...sets, "version = version + 1", "updated_by = ?", "updated_at = ?"].join(", ")} WHERE id = ? AND version = ?`)
        .bind(...values, user.email, nowIso(), id, body.version)
        .run();
    if (!result.meta.changes) throw new HttpError(409, "conflict", "Someone changed this place since you opened it. Reload, then try again.");
    await activity(db, { actor: user.email, action: body.archived ? "location.archive" : "location.update", entityType: "location", entityId: id }).run();
    return locationView(db, user, id);
}
