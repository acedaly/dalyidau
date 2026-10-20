// Assets: the register itself. Summaries for lists, the full record for one asset, creating and
// changing them, sharing, bulk edits, odometer readings and valuations.
//
// Every read goes through access.ts: rows come only from assets the caller can see, and what's in a
// summary depends on their rights. Financial values are left out (not zeroed) for people who can't
// see them, insurance state is "hidden", and documents are counted but not listed. Writes check the
// right they need, use the record's version so two people can't silently overwrite each other, and
// record activity without content.
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import type { AssetCategory } from "../../src/shared/assets/categories";
import { bestWarranty, coverageState, dueState, formulaValue, warrantyExpiry, warrantyState } from "../../src/shared/assets/engine";
import {
    type AssetDetail,
    type AssetPreferences,
    type AssetSummary,
    type AssetVisibility,
    type Depreciation,
    GONE_STATUSES,
    LIMITS,
    NO_GRANT,
    type OdometerReading,
    type ValuationView,
    type ValueView,
    type VehicleDetail,
    type VehicleSpecs,
    bulkInput,
    createAssetInput,
    depreciationSchema,
    odometerInput,
    sharingInput,
    updateAssetInput,
    valuationInput,
    vehicleSpecsSchema,
} from "../../src/shared/assets/types";
import type { PortalUser } from "../../src/shared/portal/types";
import type { Env } from "../env";
import { newId, nowIso, parseJson } from "../portal/db";
import { HttpError } from "../portal/http";
import {
    ACCESS_FROM,
    ACCESS_SELECT,
    type AssetAccessRow,
    type LocationRow,
    VISIBLE,
    activity,
    assetPreferences,
    canUseAssets,
    clockFor,
    grantOf,
    namesFor,
    notFound,
    refuse,
    requireAsset,
    requireLocation,
    rightsOf,
    visibleLocations,
} from "./access";
import { categoryMap, checkCategory, cleanCustom, listCategories } from "./catalog";

export class AssetConflict extends HttpError {
    constructor(readonly current: { version: number; updatedAt: string } | null) {
        super(409, "conflict", "Someone changed this asset since you opened it. Reload to see their changes, then try again.");
    }
}

// --- Viewing context -----------------------------------------------------------------------------

export interface ViewContext {
    user: PortalUser;
    today: string;
    timeZone: string;
    prefs: AssetPreferences;
    categories: Map<string, AssetCategory>;
    locations: Map<string, LocationRow>;
}

export async function viewContext(db: D1Database, user: PortalUser): Promise<ViewContext> {
    const [clock, { preferences }, categories, locations] = await Promise.all([
        clockFor(db, user.email),
        assetPreferences(db, user.email),
        listCategories(db),
        visibleLocations(db, user, true),
    ]);
    return { user, ...clock, prefs: preferences, categories: categoryMap(categories), locations: new Map(locations.map((l) => [l.id, l])) };
}

/**
 * Rows of a related table for the given assets: by id when there are few (well under D1's 100
 * bound parameters), otherwise everything joined to the caller's visible assets.
 */
function scoped(db: D1Database, user: PortalUser, ids: string[], sql: (join: string) => string) {
    if (ids.length <= 60) {
        // ?1 (the caller) is bound but unused here, so the ids are numbered from 2.
        const list = ids.map((_, i) => `?${i + 2}`).join(", ");
        return db.prepare(sql(`(SELECT id FROM assets WHERE id IN (${list}))`)).bind(user.email, ...ids);
    }
    return db.prepare(`WITH ${VISIBLE} ${sql("visible")}`).bind(user.email);
}

interface VehicleRow {
    asset_id: string;
    kind: VehicleDetail["kind"];
    registration: string | null;
    jurisdiction: string | null;
    registration_expiry: string | null;
    vin: string | null;
    engine_number: string | null;
    make: string | null;
    model: string | null;
    year: number | null;
    odometer_unit: VehicleDetail["odometerUnit"];
    roadside_provider: string | null;
    roadside_reference: string | null;
    roadside_expiry: string | null;
    inspection_due: string | null;
    battery_installed_on: string | null;
    atm_kg: number | null;
    gtm_kg: number | null;
    tare_kg: number | null;
    ball_weight_kg: number | null;
    specs: string;
    odo: number | null;
    odo_on: string | null;
}

const latestOdometer = `(SELECT o.reading FROM asset_odometer o WHERE o.asset_id = v.asset_id ORDER BY o.read_on DESC, o.created_at DESC LIMIT 1) AS odo,
    (SELECT o.read_on FROM asset_odometer o WHERE o.asset_id = v.asset_id ORDER BY o.read_on DESC, o.created_at DESC LIMIT 1) AS odo_on`;

export const vehicleOut = (v: VehicleRow): VehicleDetail => ({
    kind: v.kind,
    registration: v.registration,
    jurisdiction: v.jurisdiction,
    registrationExpiry: v.registration_expiry,
    vin: v.vin,
    engineNumber: v.engine_number,
    make: v.make,
    model: v.model,
    year: v.year,
    odometerUnit: v.odometer_unit,
    roadsideProvider: v.roadside_provider,
    roadsideReference: v.roadside_reference,
    roadsideExpiry: v.roadside_expiry,
    inspectionDue: v.inspection_due,
    batteryInstalledOn: v.battery_installed_on,
    atmKg: v.atm_kg,
    gtmKg: v.gtm_kg,
    tareKg: v.tare_kg,
    ballWeightKg: v.ball_weight_kg,
    specs: vehicleSpecsSchema.catch({}).parse(parseJson(v.specs, {})),
    odometer: v.odo !== null && v.odo_on ? { reading: v.odo, readOn: v.odo_on } : null,
});

const latestBy = <T extends { asset_id: string; kind: string }>(rows: T[]) => {
    const out = new Map<string, T>();
    for (const r of rows) out.set(`${r.asset_id}:${r.kind}`, r);
    return out;
};

const parseDepreciation = (raw: string): Depreciation => depreciationSchema.catch({ method: "none" }).parse(parseJson(raw, { method: "none" }));

/** Summaries for asset rows the caller can see, with everything a list needs in a few queries. */
export async function summarise(db: D1Database, ctx: ViewContext, rows: AssetAccessRow[]): Promise<AssetSummary[]> {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const [vehicles, valuations, warranties, links, schedules, open, files] = await db.batch([
        scoped(db, ctx.user, ids, (j) => `SELECT v.*, ${latestOdometer} FROM asset_vehicles v JOIN ${j} vis ON vis.id = v.asset_id`),
        scoped(
            db,
            ctx.user,
            ids,
            (j) =>
                `SELECT x.asset_id, x.kind, x.basis, x.amount_cents, x.valued_on FROM asset_valuations x JOIN ${j} vis ON vis.id = x.asset_id WHERE x.kind IN ('current', 'replacement') ORDER BY x.valued_on, x.created_at`,
        ),
        scoped(db, ctx.user, ids, (j) => `SELECT w.asset_id, w.expires_on, w.starts_on, w.months FROM asset_warranties w JOIN ${j} vis ON vis.id = w.asset_id`),
        scoped(
            db,
            ctx.user,
            ids,
            (j) =>
                `SELECT l.asset_id, p.status, p.verified_at, p.renews_on FROM asset_policy_links l JOIN asset_policies p ON p.id = l.policy_id JOIN ${j} vis ON vis.id = l.asset_id`,
        ),
        scoped(
            db,
            ctx.user,
            ids,
            (j) =>
                `SELECT sc.id, sc.asset_id, sc.next_due_on, sc.next_due_km FROM asset_schedules sc JOIN ${j} vis ON vis.id = sc.asset_id WHERE sc.active = 1`,
        ),
        scoped(
            db,
            ctx.user,
            ids,
            (j) =>
                `SELECT m.asset_id, m.schedule_id, m.due_on, m.due_km FROM asset_maintenance m JOIN ${j} vis ON vis.id = m.asset_id WHERE m.status IN ('open', 'requested', 'scheduled', 'in_progress')`,
        ),
        scoped(
            db,
            ctx.user,
            ids,
            (j) =>
                `SELECT f.asset_id, f.kind, COUNT(*) AS n FROM asset_files f JOIN ${j} vis ON vis.id = f.asset_id WHERE f.status = 'stored' GROUP BY f.asset_id, f.kind`,
        ),
    ]);
    const vehicleBy = new Map((vehicles.results as VehicleRow[]).map((v) => [v.asset_id, v]));
    const valueBy = latestBy(valuations.results as { asset_id: string; kind: string; basis: ValueView["basis"]; amount_cents: number; valued_on: string }[]);
    const group = <T extends { asset_id: string }>(list: T[]) => {
        const out = new Map<string, T[]>();
        for (const r of list) out.set(r.asset_id, [...(out.get(r.asset_id) ?? []), r]);
        return out;
    };
    const warrantyBy = group(warranties.results as { asset_id: string; expires_on: string | null; starts_on: string | null; months: number | null }[]);
    const linkBy = group(links.results as { asset_id: string; status: string; verified_at: string | null; renews_on: string | null }[]);
    const scheduleBy = group(schedules.results as { id: string; asset_id: string; next_due_on: string | null; next_due_km: number | null }[]);
    const openBy = group(open.results as { asset_id: string; schedule_id: string | null; due_on: string | null; due_km: number | null }[]);
    const fileBy = group(files.results as { asset_id: string; kind: string; n: number }[]);
    const names = await namesFor(
        db,
        rows.map((r) => r.owner_email),
    );

    return rows.map((r): AssetSummary => {
        const rights = rightsOf(r);
        const category = ctx.categories.get(r.category);
        const vehicle = vehicleBy.get(r.id);
        const currentKm = vehicle?.odo ?? null;
        // Maintenance: open records, and schedules that don't have an open record yet.
        const openRecords = openBy.get(r.id) ?? [];
        const withRecord = new Set(openRecords.map((m) => m.schedule_id).filter(Boolean));
        const dues = [
            ...openRecords.map((m) => ({ dueOn: m.due_on, dueKm: m.due_km })),
            ...(scheduleBy.get(r.id) ?? []).filter((s) => !withRecord.has(s.id)).map((s) => ({ dueOn: s.next_due_on, dueKm: s.next_due_km })),
        ];
        let overdue = 0;
        let dueSoon = 0;
        let nextDueOn: string | null = null;
        for (const d of dues) {
            const { state } = dueState({ ...d, currentKm, today: ctx.today, soonDays: ctx.prefs.dueSoonDays, soonKm: ctx.prefs.dueSoonDistance });
            if (state === "overdue") overdue++;
            else if (state === "due_soon") dueSoon++;
            if (d.dueOn && (!nextDueOn || d.dueOn < nextDueOn)) nextDueOn = d.dueOn;
        }
        const warranty = bestWarranty(
            (warrantyBy.get(r.id) ?? []).map((w) => {
                const end = warrantyExpiry({ expiresOn: w.expires_on, startsOn: w.starts_on, months: w.months, purchaseDate: r.purchase_date });
                return { state: warrantyState(end.expiresOn, ctx.today, ctx.prefs.dueSoonDays), expiresOn: end.expiresOn };
            }),
        );
        const current = valueBy.get(`${r.id}:current`);
        const replacement = valueBy.get(`${r.id}:replacement`);
        const fileKinds = new Set((fileBy.get(r.id) ?? []).map((f) => f.kind));
        const location = r.location_id ? ctx.locations.get(r.location_id) : undefined;
        return {
            id: r.id,
            name: r.name,
            category: r.category,
            categoryLabel: category?.label ?? "Other",
            group: category?.group ?? "other",
            manufacturer: r.manufacturer,
            brand: r.brand,
            model: r.model,
            serialNumber: r.serial_number,
            barcode: r.barcode,
            status: r.status as AssetSummary["status"],
            condition: r.condition as AssetSummary["condition"],
            ownership: r.ownership,
            location: location ? { id: location.id, name: location.name } : null,
            locationHidden: !!r.location_id && !location,
            tags: parseJson<string[]>(r.tags, []),
            owner: { email: r.owner_email, name: names.get(r.owner_email.toLowerCase()) ?? null },
            mine: !!r.mine,
            visibility: r.visibility,
            coverFileId: r.cover_file_id,
            purchaseDate: r.purchase_date,
            purchasePriceCents: rights.financial ? r.purchase_price_cents : null,
            currentValue: rights.financial
                ? current
                    ? { amountCents: current.amount_cents, basis: current.basis, valuedOn: current.valued_on }
                    : formulaValue(parseDepreciation(r.depreciation), r.purchase_price_cents, r.purchase_date, ctx.today)
                : null,
            replacementValue:
                rights.financial && replacement ? { amountCents: replacement.amount_cents, basis: replacement.basis, valuedOn: replacement.valued_on } : null,
            financialHidden: !rights.financial,
            vehicle: vehicle
                ? {
                      kind: vehicle.kind,
                      registration: vehicle.registration,
                      registrationExpiry: vehicle.registration_expiry,
                      odometer: vehicle.odo,
                      odometerUnit: vehicle.odometer_unit,
                  }
                : null,
            warranty,
            coverage: rights.insurance
                ? coverageState(
                      (linkBy.get(r.id) ?? []).map((l) => ({ status: l.status as "active", verified: !!l.verified_at, renewsOn: l.renews_on })),
                      ctx.today,
                  )
                : "hidden",
            maintenance: { overdue, dueSoon, nextDueOn, open: openRecords.length },
            needsDocuments: rights.documents ? { proof: !fileKinds.has("receipt") && !fileKinds.has("invoice"), photo: !fileKinds.has("photo") } : null,
            rights,
            version: r.version,
            updatedAt: r.updated_at,
        };
    });
}

/** Every asset the caller can see (bounded), summarised. */
export async function listAssets(db: D1Database, user: PortalUser, ctx?: ViewContext): Promise<{ assets: AssetSummary[]; truncated: boolean }> {
    const view = ctx ?? (await viewContext(db, user));
    const rows = await db
        .prepare(`SELECT ${ACCESS_SELECT} ${ACCESS_FROM} ORDER BY a.name COLLATE NOCASE LIMIT ${LIMITS.listMax + 1}`)
        .bind(user.email)
        .all<AssetAccessRow>();
    const truncated = rows.results.length > LIMITS.listMax;
    return { assets: await summarise(db, view, rows.results.slice(0, LIMITS.listMax)), truncated };
}

export async function assetSummary(db: D1Database, user: PortalUser, id: string, ctx?: ViewContext): Promise<AssetSummary> {
    const { row } = await requireAsset(db, user, id);
    return (await summarise(db, ctx ?? (await viewContext(db, user)), [row]))[0];
}

// --- The full record -----------------------------------------------------------------------------

export async function vehicleFor(db: D1Database, assetId: string): Promise<VehicleDetail | null> {
    const v = await db.prepare(`SELECT v.*, ${latestOdometer} FROM asset_vehicles v WHERE v.asset_id = ?`).bind(assetId).first<VehicleRow>();
    return v ? vehicleOut(v) : null;
}

export async function odometerFor(db: D1Database, assetId: string, limit = 50): Promise<OdometerReading[]> {
    const rows = await db
        .prepare(
            "SELECT id, reading, read_on, correction, note, maintenance_id FROM asset_odometer WHERE asset_id = ? ORDER BY read_on DESC, created_at DESC LIMIT ?",
        )
        .bind(assetId, limit)
        .all<{ id: string; reading: number; read_on: string; correction: number; note: string | null; maintenance_id: string | null }>();
    return rows.results.map((r) => ({
        id: r.id,
        reading: r.reading,
        readOn: r.read_on,
        correction: !!r.correction,
        note: r.note,
        maintenanceId: r.maintenance_id,
    }));
}

export async function valuationsFor(db: D1Database, assetId: string): Promise<ValuationView[]> {
    const rows = await db
        .prepare(
            "SELECT id, kind, basis, amount_cents, valued_on, source FROM asset_valuations WHERE asset_id = ? ORDER BY valued_on DESC, created_at DESC LIMIT 100",
        )
        .bind(assetId)
        .all<{ id: string; kind: ValuationView["kind"]; basis: ValuationView["basis"]; amount_cents: number; valued_on: string; source: string | null }>();
    return rows.results.map((r) => ({ id: r.id, kind: r.kind, basis: r.basis, amountCents: r.amount_cents, valuedOn: r.valued_on, source: r.source }));
}

/** Sharing as the owner sees it. */
export async function sharingFor(db: D1Database, assetId: string, visibility: AssetVisibility): Promise<NonNullable<AssetDetail["sharing"]>> {
    const rows = await db
        .prepare("SELECT email, can_edit, can_maintain, can_financial, can_insurance, can_documents FROM asset_shares WHERE asset_id = ? ORDER BY email")
        .bind(assetId)
        .all<{ email: string; can_edit: number; can_maintain: number; can_financial: number; can_insurance: number; can_documents: number }>();
    const household = rows.results.find((r) => r.email === "*") ?? null;
    const people = rows.results.filter((r) => r.email !== "*");
    const names = await namesFor(
        db,
        people.map((p) => p.email),
    );
    return {
        visibility,
        household: household ? grantOf(household) : null,
        people: people.map((p) => ({ email: p.email, name: names.get(p.email.toLowerCase()) ?? null, grant: grantOf(p) })),
    };
}

// --- Create --------------------------------------------------------------------------------------

const COLUMNS: Record<string, string> = {
    name: "name",
    category: "category",
    manufacturer: "manufacturer",
    brand: "brand",
    model: "model",
    serialNumber: "serial_number",
    barcode: "barcode",
    description: "description",
    purchaseDate: "purchase_date",
    purchasePriceCents: "purchase_price_cents",
    purchaseLocation: "purchase_location",
    condition: "condition",
    status: "status",
    ownership: "ownership",
    locationId: "location_id",
    notes: "notes",
    disposedOn: "disposed_on",
    disposalMethod: "disposal_method",
    disposalAmountCents: "disposal_amount_cents",
    disposalNotes: "disposal_notes",
};

const VEHICLE_COLUMNS: Record<string, string> = {
    kind: "kind",
    registration: "registration",
    jurisdiction: "jurisdiction",
    registrationExpiry: "registration_expiry",
    vin: "vin",
    engineNumber: "engine_number",
    make: "make",
    model: "model",
    year: "year",
    odometerUnit: "odometer_unit",
    roadsideProvider: "roadside_provider",
    roadsideReference: "roadside_reference",
    roadsideExpiry: "roadside_expiry",
    inspectionDue: "inspection_due",
    batteryInstalledOn: "battery_installed_on",
    atmKg: "atm_kg",
    gtmKg: "gtm_kg",
    tareKg: "tare_kg",
    ballWeightKg: "ball_weight_kg",
};

/** Adds or changes the vehicle row with the fields given; specs are merged with what's there. */
async function vehicleStatement(db: D1Database, user: PortalUser, assetId: string, input: Record<string, unknown>): Promise<D1PreparedStatement> {
    const existing = await db.prepare("SELECT specs FROM asset_vehicles WHERE asset_id = ?").bind(assetId).first<{ specs: string }>();
    const specs: VehicleSpecs = { ...parseJson<VehicleSpecs>(existing?.specs, {}), ...((input.specs as VehicleSpecs | undefined) ?? {}) };
    for (const [k, v] of Object.entries(specs)) if (!v) delete specs[k as keyof VehicleSpecs];
    const cols = Object.keys(VEHICLE_COLUMNS).filter((k) => input[k] !== undefined);
    const names = [...cols.map((k) => VEHICLE_COLUMNS[k]), "specs", "updated_by", "updated_at"];
    const values = [...cols.map((k) => input[k] ?? null), JSON.stringify(specs), user.email, nowIso()];
    if (existing) return db.prepare(`UPDATE asset_vehicles SET ${names.map((n) => `${n} = ?`).join(", ")} WHERE asset_id = ?`).bind(...values, assetId);
    if (!cols.includes("kind")) throw new HttpError(422, "validation", "Choose what kind of vehicle it is");
    return db.prepare(`INSERT INTO asset_vehicles (asset_id, ${names.join(", ")}) VALUES (?, ${names.map(() => "?").join(", ")})`).bind(assetId, ...values);
}

const today = async (db: D1Database, user: PortalUser) => (await clockFor(db, user.email)).today;

/** Moves files from the person's own capture inbox onto a new record. Only their own, unattached ones. */
export const claimInboxFiles = (db: D1Database, user: PortalUser, fileIds: string[], column: "asset_id" | "location_id" | "policy_id", targetId: string) =>
    fileIds.length
        ? [
              db
                  .prepare(
                      `UPDATE asset_files SET ${column} = ?, updated_at = ? WHERE owner_email = ? AND status = 'stored' AND asset_id IS NULL AND location_id IS NULL AND policy_id IS NULL
                         AND id IN (${fileIds.map(() => "?").join(", ")})`,
                  )
                  .bind(targetId, nowIso(), user.email, ...fileIds),
          ]
        : [];

export async function createAsset(
    db: D1Database,
    user: PortalUser,
    input: unknown,
    via: "portal" | "mcp" = "portal",
): Promise<{ asset: AssetSummary; replayed: boolean }> {
    const body = createAssetInput.parse(input);
    if (body.clientId) {
        const earlier = await db
            .prepare("SELECT id FROM assets WHERE created_by = ? AND client_id = ? AND deleted_at IS NULL")
            .bind(user.email, body.clientId)
            .first<{ id: string }>();
        if (earlier) return { asset: await assetSummary(db, user, earlier.id), replayed: true };
    }
    const category = await checkCategory(db, body.category);
    if (body.locationId) await requireLocation(db, user, body.locationId);
    const id = newId("ast");
    const now = nowIso();
    const on = await today(db, user);
    const values: Record<string, unknown> = {};
    for (const [key, column] of Object.entries(COLUMNS))
        if ((body as Record<string, unknown>)[key] !== undefined) values[column] = (body as Record<string, unknown>)[key];
    if (GONE_STATUSES.includes(body.status ?? "active") && !body.disposedOn) values.disposed_on = on;
    const columns = Object.keys(values);
    const statements: D1PreparedStatement[] = [
        db
            .prepare(
                `INSERT INTO assets (id, owner_email, ${columns.join(", ")}, tags, custom, depreciation, visibility, client_id, created_by, created_at, updated_by, updated_at)
                 VALUES (?, ?, ${columns.map(() => "?").join(", ")}, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
                id,
                user.email,
                ...columns.map((c) => values[c] ?? null),
                JSON.stringify([...new Set(body.tags ?? [])]),
                JSON.stringify(cleanCustom(category.fields, body.custom)),
                JSON.stringify(body.depreciation ?? { method: "none" }),
                body.share === "household" ? "household" : "private",
                body.clientId ?? null,
                user.email,
                now,
                user.email,
                now,
            ),
    ];
    const vehicleKind = body.vehicle?.kind ?? category.vehicle;
    if (body.vehicle && !vehicleKind) throw new HttpError(422, "validation", "Choose what kind of vehicle it is");
    if (vehicleKind) statements.push(await vehicleStatement(db, user, id, { ...(body.vehicle ?? {}), kind: vehicleKind }));
    if (body.share === "household")
        statements.push(db.prepare("INSERT INTO asset_shares (asset_id, email, added_by, added_at) VALUES (?, '*', ?, ?)").bind(id, user.email, now));
    for (const [kind, amount] of [
        ["current", body.currentValueCents],
        ["replacement", body.replacementValueCents],
    ] as const)
        if (typeof amount === "number")
            statements.push(
                db
                    .prepare(
                        "INSERT INTO asset_valuations (id, asset_id, kind, basis, amount_cents, valued_on, created_by, created_at) VALUES (?, ?, ?, 'user_estimate', ?, ?, ?, ?)",
                    )
                    .bind(newId("aval"), id, kind, amount, on, user.email, now),
            );
    statements.push(...claimInboxFiles(db, user, body.fileIds ?? [], "asset_id", id));
    statements.push(activity(db, { actor: user.email, action: "asset.create", entityType: "asset", entityId: id, assetId: id, via }));
    try {
        await db.batch(statements);
    } catch (error) {
        // A concurrent retry with the same key: the first one won.
        if (body.clientId && /UNIQUE/.test((error as Error).message)) {
            const earlier = await db
                .prepare("SELECT id FROM assets WHERE created_by = ? AND client_id = ?")
                .bind(user.email, body.clientId)
                .first<{ id: string }>();
            if (earlier) return { asset: await assetSummary(db, user, earlier.id), replayed: true };
        }
        throw error;
    }
    // The first photo becomes the cover.
    await setDefaultCover(db, id);
    return { asset: await assetSummary(db, user, id), replayed: false };
}

export async function setDefaultCover(db: D1Database, assetId: string) {
    await db
        .prepare(
            `UPDATE assets SET cover_file_id = (SELECT id FROM asset_files WHERE asset_id = ?1 AND kind = 'photo' AND status = 'stored' ORDER BY created_at LIMIT 1)
             WHERE id = ?1 AND (cover_file_id IS NULL OR cover_file_id NOT IN (SELECT id FROM asset_files WHERE asset_id = ?1 AND kind = 'photo' AND status = 'stored'))`,
        )
        .bind(assetId)
        .run();
}

// --- Update --------------------------------------------------------------------------------------

export async function updateAsset(db: D1Database, user: PortalUser, id: string, input: unknown, via: "portal" | "mcp" = "portal"): Promise<AssetSummary> {
    const body = updateAssetInput.parse(input) as Record<string, unknown> & { version: number };
    const { row, rights } = await requireAsset(db, user, id, "edit");
    for (const field of ["purchasePriceCents", "disposalAmountCents", "depreciation"])
        if (body[field] !== undefined && !rights.financial) throw refuse("financial");
    const category =
        body.category && body.category !== row.category
            ? await checkCategory(db, body.category as string)
            : (await listCategories(db)).find((c) => c.id === row.category);
    if (body.locationId) await requireLocation(db, user, body.locationId as string);
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of Object.entries(COLUMNS))
        if (body[key] !== undefined) {
            sets.push(`${column} = ?`);
            values.push(body[key] ?? null);
        }
    if (body.status && GONE_STATUSES.includes(body.status as never) && !row.disposed_on && body.disposedOn === undefined) {
        sets.push("disposed_on = ?");
        values.push(await today(db, user));
    }
    if (body.tags !== undefined) {
        sets.push("tags = ?");
        values.push(JSON.stringify([...new Set(body.tags as string[])]));
    }
    if (body.custom !== undefined || body.category !== undefined) {
        // Values for fields the (new) category still defines are kept.
        const merged = { ...parseJson<Record<string, unknown>>(row.custom, {}), ...((body.custom as Record<string, unknown> | undefined) ?? {}) };
        const keep = Object.fromEntries(Object.entries(merged).filter(([k]) => category?.fields.some((f) => f.key === k)));
        sets.push("custom = ?");
        values.push(JSON.stringify(cleanCustom(category?.fields ?? [], keep)));
    }
    if (body.depreciation !== undefined) {
        sets.push("depreciation = ?");
        values.push(JSON.stringify(body.depreciation));
    }
    // Compare-and-set first: if someone else changed the asset, nothing at all is written.
    const result = await db
        .prepare(`UPDATE assets SET ${[...sets, "version = version + 1", "updated_by = ?", "updated_at = ?"].join(", ")} WHERE id = ? AND version = ?`)
        .bind(...values, user.email, nowIso(), id, body.version)
        .run();
    if (!result.meta.changes) {
        const current = await db.prepare("SELECT version, updated_at FROM assets WHERE id = ?").bind(id).first<{ version: number; updated_at: string }>();
        throw new AssetConflict(current ? { version: current.version, updatedAt: current.updated_at } : null);
    }
    const statements: D1PreparedStatement[] = [];
    if (body.vehicle) statements.push(await vehicleStatement(db, user, id, body.vehicle as Record<string, unknown>));
    else if (body.vehicle === null) statements.push(db.prepare("DELETE FROM asset_vehicles WHERE asset_id = ?").bind(id));
    else if (body.category && category?.vehicle) {
        const has = await db.prepare("SELECT 1 FROM asset_vehicles WHERE asset_id = ?").bind(id).first();
        if (!has) statements.push(await vehicleStatement(db, user, id, { kind: category.vehicle }));
    }
    statements.push(activity(db, { actor: user.email, action: "asset.update", entityType: "asset", entityId: id, assetId: id, via }));
    await db.batch(statements);
    return assetSummary(db, user, id);
}

/** Moving an asset to another place: anyone who can record maintenance may (it's how a QR scan updates it). */
export async function moveAsset(db: D1Database, user: PortalUser, id: string, locationId: string | null): Promise<AssetSummary> {
    await requireAsset(db, user, id, "maintain");
    if (locationId) await requireLocation(db, user, locationId);
    await db.batch([
        db
            .prepare("UPDATE assets SET location_id = ?, version = version + 1, updated_by = ?, updated_at = ? WHERE id = ?")
            .bind(locationId, user.email, nowIso(), id),
        activity(db, { actor: user.email, action: "asset.move", entityType: "asset", entityId: id, assetId: id }),
    ]);
    return assetSummary(db, user, id);
}

/** Owner only. The asset is hidden at once and its files are deleted 30 days later, unless it's restored. */
export async function deleteAsset(db: D1Database, user: PortalUser, id: string, confirm: unknown) {
    await requireAsset(db, user, id, "manage");
    if (confirm !== "DELETE") throw new HttpError(422, "validation", "Type DELETE to confirm");
    await db.batch([
        db.prepare("UPDATE assets SET deleted_at = ?, updated_by = ?, updated_at = ? WHERE id = ?").bind(nowIso(), user.email, nowIso(), id),
        activity(db, { actor: user.email, action: "asset.delete", entityType: "asset", entityId: id, assetId: id }),
    ]);
}

export async function restoreAsset(db: D1Database, user: PortalUser, id: string): Promise<AssetSummary> {
    const row = await db.prepare("SELECT id FROM assets WHERE id = ? AND owner_email = ? AND deleted_at IS NOT NULL").bind(id, user.email).first();
    if (!row) throw notFound();
    await db.batch([
        db.prepare("UPDATE assets SET deleted_at = NULL, version = version + 1, updated_at = ? WHERE id = ?").bind(nowIso(), id),
        activity(db, { actor: user.email, action: "asset.restore", entityType: "asset", entityId: id, assetId: id }),
    ]);
    return assetSummary(db, user, id);
}

export async function deletedAssets(db: D1Database, user: PortalUser) {
    const rows = await db
        .prepare("SELECT id, name, deleted_at FROM assets WHERE owner_email = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 100")
        .bind(user.email)
        .all<{ id: string; name: string; deleted_at: string }>();
    return rows.results.map((r) => ({ id: r.id, name: r.name, deletedAt: r.deleted_at }));
}

/** A new label version (for reprinting): the asset's id, and so every QR address, stays the same. */
export async function regenerateLabel(db: D1Database, user: PortalUser, id: string): Promise<{ labelVersion: number }> {
    await requireAsset(db, user, id, "manage");
    await db.batch([
        db.prepare("UPDATE assets SET label_version = label_version + 1, updated_at = ? WHERE id = ?").bind(nowIso(), id),
        activity(db, { actor: user.email, action: "asset.label", entityType: "asset", entityId: id, assetId: id }),
    ]);
    const row = await db.prepare("SELECT label_version FROM assets WHERE id = ?").bind(id).first<{ label_version: number }>();
    return { labelVersion: row?.label_version ?? 1 };
}

// --- Sharing -------------------------------------------------------------------------------------

export async function setSharing(env: Env, db: D1Database, user: PortalUser, id: string, input: unknown) {
    const body = sharingInput.parse(input);
    const { row } = await requireAsset(db, user, id, "manage");
    const people = body.visibility === "private" ? [] : (body.people ?? []);
    if (body.visibility === "selected" && !people.length) throw new HttpError(422, "validation", "Choose at least one person, or keep it private");
    const seen = new Set<string>();
    for (const p of people) {
        if (p.email === row.owner_email) throw new HttpError(422, "validation", "The owner already has every right");
        if (seen.has(p.email)) throw new HttpError(422, "validation", "Each person can be listed once");
        seen.add(p.email);
        if (!(await canUseAssets(env, db, p.email)))
            throw new HttpError(422, "no_access", `${p.email} can't open Home & Assets. Give them access in Portal settings first.`);
    }
    const now = nowIso();
    const share = (email: string, g: { edit: boolean; maintain: boolean; financial: boolean; insurance: boolean; documents: boolean }) =>
        db
            .prepare(
                "INSERT INTO asset_shares (asset_id, email, can_edit, can_maintain, can_financial, can_insurance, can_documents, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(id, email, g.edit ? 1 : 0, g.edit || g.maintain ? 1 : 0, g.financial ? 1 : 0, g.insurance ? 1 : 0, g.documents ? 1 : 0, user.email, now);
    const result = await db
        .prepare("UPDATE assets SET visibility = ?, version = version + 1, updated_by = ?, updated_at = ? WHERE id = ? AND version = ?")
        .bind(body.visibility, user.email, now, id, body.version)
        .run();
    if (!result.meta.changes) {
        const current = await db.prepare("SELECT version, updated_at FROM assets WHERE id = ?").bind(id).first<{ version: number; updated_at: string }>();
        throw new AssetConflict(current ? { version: current.version, updatedAt: current.updated_at } : null);
    }
    await db.batch([
        db.prepare("DELETE FROM asset_shares WHERE asset_id = ?").bind(id),
        ...(body.visibility === "household" ? [share("*", body.household ?? NO_GRANT)] : []),
        ...people.map((p) => share(p.email, p)),
        activity(db, { actor: user.email, action: "asset.share", entityType: "asset", entityId: id, assetId: id }),
    ]);
    return sharingFor(db, id, body.visibility);
}

// --- Bulk ----------------------------------------------------------------------------------------

export async function bulkUpdate(db: D1Database, user: PortalUser, input: unknown): Promise<{ changed: number; skipped: number }> {
    const body = bulkInput.parse(input);
    const set = body.set;
    if (set.category) await checkCategory(db, set.category);
    if (set.locationId) await requireLocation(db, user, set.locationId);
    const statements: D1PreparedStatement[] = [];
    let skipped = 0;
    const now = nowIso();
    for (const id of [...new Set(body.ids)]) {
        let access;
        try {
            access = await requireAsset(db, user, id, "edit");
        } catch {
            skipped++;
            continue;
        }
        const sets: string[] = [];
        const values: unknown[] = [];
        for (const key of ["category", "status", "condition", "ownership"] as const)
            if (set[key] !== undefined) {
                sets.push(`${key} = ?`);
                values.push(set[key] ?? null);
            }
        if (set.locationId !== undefined) {
            sets.push("location_id = ?");
            values.push(set.locationId);
        }
        if (set.addTags || set.removeTags) {
            const tags = new Set(parseJson<string[]>(access.row.tags, []));
            for (const t of set.addTags ?? []) tags.add(t);
            for (const t of set.removeTags ?? []) tags.delete(t);
            sets.push("tags = ?");
            values.push(JSON.stringify([...tags].slice(0, 20)));
        }
        if (!sets.length) continue;
        statements.push(
            db
                .prepare(`UPDATE assets SET ${sets.join(", ")}, version = version + 1, updated_by = ?, updated_at = ? WHERE id = ?`)
                .bind(...values, user.email, now, id),
            activity(db, { actor: user.email, action: "asset.bulk_update", entityType: "asset", entityId: id, assetId: id }),
        );
    }
    if (statements.length) await db.batch(statements);
    return { changed: statements.length / 2, skipped };
}

// --- Odometer and valuations ---------------------------------------------------------------------

export async function addOdometer(
    db: D1Database,
    user: PortalUser,
    assetId: string,
    input: unknown,
    maintenanceId: string | null = null,
): Promise<OdometerReading[]> {
    const body = odometerInput.parse(input);
    await requireAsset(db, user, assetId, "maintain");
    const vehicle = await db.prepare("SELECT 1 FROM asset_vehicles WHERE asset_id = ?").bind(assetId).first();
    if (!vehicle) throw new HttpError(422, "validation", "Add vehicle details first");
    if (body.readOn > (await today(db, user))) throw new HttpError(422, "validation", "A reading can't be in the future");
    if (!body.correction) {
        const before = await db
            .prepare("SELECT MAX(reading) AS n FROM asset_odometer WHERE asset_id = ? AND read_on <= ?")
            .bind(assetId, body.readOn)
            .first<{ n: number | null }>();
        const after = await db
            .prepare("SELECT MIN(reading) AS n FROM asset_odometer WHERE asset_id = ? AND read_on > ?")
            .bind(assetId, body.readOn)
            .first<{ n: number | null }>();
        if (before?.n !== null && before?.n !== undefined && body.reading < before.n)
            throw new HttpError(
                422,
                "lower_reading",
                `That's lower than an earlier reading (${before.n.toLocaleString("en-AU")}). Mark it as a correction if the odometer was replaced or a reading was wrong.`,
            );
        if (after?.n !== null && after?.n !== undefined && body.reading > after.n)
            throw new HttpError(
                422,
                "higher_reading",
                `That's higher than a later reading (${after.n.toLocaleString("en-AU")}). Check the date, or mark it as a correction.`,
            );
    }
    await db.batch([
        db
            .prepare(
                "INSERT INTO asset_odometer (id, asset_id, reading, read_on, correction, maintenance_id, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(newId("aodo"), assetId, body.reading, body.readOn, body.correction ? 1 : 0, maintenanceId, body.note ?? null, user.email, nowIso()),
        activity(db, { actor: user.email, action: "odometer.add", entityType: "odometer", assetId }),
    ]);
    return odometerFor(db, assetId);
}

export async function deleteOdometer(db: D1Database, user: PortalUser, assetId: string, readingId: string): Promise<OdometerReading[]> {
    await requireAsset(db, user, assetId, "edit");
    await db.batch([
        db.prepare("DELETE FROM asset_odometer WHERE id = ? AND asset_id = ?").bind(readingId, assetId),
        activity(db, { actor: user.email, action: "odometer.delete", entityType: "odometer", entityId: readingId, assetId }),
    ]);
    return odometerFor(db, assetId);
}

export async function addValuation(db: D1Database, user: PortalUser, assetId: string, input: unknown): Promise<ValuationView[]> {
    const body = valuationInput.parse(input);
    const { rights } = await requireAsset(db, user, assetId, "edit");
    if (!rights.financial) throw refuse("financial");
    if (body.valuedOn > (await today(db, user))) throw new HttpError(422, "validation", "A value can't be dated in the future");
    const id = newId("aval");
    await db.batch([
        db
            .prepare(
                "INSERT INTO asset_valuations (id, asset_id, kind, basis, amount_cents, valued_on, source, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(id, assetId, body.kind, body.basis, body.amountCents, body.valuedOn, body.source ?? null, user.email, nowIso()),
        activity(db, { actor: user.email, action: "valuation.add", entityType: "valuation", entityId: id, assetId }),
    ]);
    return valuationsFor(db, assetId);
}

export async function deleteValuation(db: D1Database, user: PortalUser, assetId: string, valuationId: string): Promise<ValuationView[]> {
    const { rights } = await requireAsset(db, user, assetId, "edit");
    if (!rights.financial) throw refuse("financial");
    await db.batch([
        db.prepare("DELETE FROM asset_valuations WHERE id = ? AND asset_id = ?").bind(valuationId, assetId),
        activity(db, { actor: user.email, action: "valuation.delete", entityType: "valuation", entityId: valuationId, assetId }),
    ]);
    return valuationsFor(db, assetId);
}
