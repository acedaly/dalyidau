// Private watch areas (docs/INTELLIGENCE_CENTRE.md#watch-areas). A watch area can be someone's
// home, so it belongs to one person and is read joined to their email; anyone else gets 404. Its
// name and coordinates are never logged, audited, sent to a model, returned over MCP or given to a
// wallboard display (a display gets a coarse frame and the matching records only).
import type { D1Database } from "@cloudflare/workers-types";
import type { CentreRecord, WatchArea, WatchDefinition, WatchInput } from "../../src/shared/centre/types";
import { watchInputSchema } from "../../src/shared/centre/types";
import type { PortalUser } from "../../src/shared/portal/types";
import { auditStatement, newId, nowIso, parseJson } from "../portal/db";
import { HttpError } from "../portal/http";
import {
    type BBox,
    type Geometry,
    NSW_BBOX,
    type Position,
    bboxIntersects,
    distanceKm,
    distanceToAreaKm,
    distanceToLineKm,
    expandBBox,
    hasArea,
    pointInPolygon,
    polygonsOf,
    positions,
} from "./geo";
import { RECORD_COLUMNS, type RecordRow, toRecord } from "./store";

export const MAX_WATCHES = 50;

interface WatchRow {
    id: string;
    email: string;
    name: string;
    kind: WatchDefinition["kind"];
    definition: string;
    fire_district: string | null;
    min_lat: number | null;
    min_lon: number | null;
    max_lat: number | null;
    max_lon: number | null;
    categories: string;
    min_level: number;
    notify_in_app: number;
    notify_email: number;
    quiet_start: string | null;
    quiet_end: string | null;
    expires_at: string | null;
    enabled: number;
    version: number;
    created_at: string;
    updated_at: string;
}

export const toWatch = (row: WatchRow): WatchArea => ({
    id: row.id,
    name: row.name,
    definition: parseJson<WatchDefinition>(row.definition, { kind: "fire_district", district: "" }),
    fireDistrict: row.fire_district,
    categories: parseJson(row.categories, []),
    minLevel: row.min_level,
    notifyInApp: row.notify_in_app === 1,
    notifyEmail: row.notify_email === 1,
    quietStart: row.quiet_start,
    quietEnd: row.quiet_end,
    expiresAt: row.expires_at,
    enabled: row.enabled === 1,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
});

/** The area a definition covers, for a quick first filter. Null: not a geographic watch. */
export function watchBBox(definition: WatchDefinition): BBox | null {
    switch (definition.kind) {
        case "point":
            return expandBBox([definition.lon, definition.lat, definition.lon, definition.lat], definition.radiusKm);
        case "polygon": {
            const xs = definition.ring.map((p) => p[0]);
            const ys = definition.ring.map((p) => p[1]);
            return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
        }
        case "region":
            return [definition.west, definition.south, definition.east, definition.north];
        case "corridor": {
            const xs = definition.line.map((p) => p[0]);
            const ys = definition.line.map((p) => p[1]);
            return expandBBox([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], definition.bufferKm);
        }
        default:
            return null;
    }
}

/** A representative point for the area (its centre), never stored or shown. */
export function watchCentre(definition: WatchDefinition): Position | null {
    const b = watchBBox(definition);
    return b ? [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] : null;
}

const recordPoint = (r: Pick<CentreRecord, "lat" | "lon">): Position | null => (r.lat !== null && r.lon !== null ? [r.lon, r.lat] : null);

export interface MatchContext {
    /** BoM forecast district of the station nearest the watch (for BoM's text-only warnings). */
    bomDistrict?: string | null;
}

/**
 * Whether a record concerns a watch area, and why. Deterministic and explainable: the reason is
 * shown with every match. Distances use only the geometry the provider published.
 */
export function matchWatch(watch: WatchArea, record: CentreRecord, geometry: Geometry | null, context: MatchContext = {}): string | null {
    if (watch.categories.length && !watch.categories.includes(record.category)) return null;
    const d = watch.definition;
    // Fire danger: by district name, for a district watch or any watch that names a district.
    if (record.kind === "rating") {
        const district = record.attributes.district ?? record.title;
        if ((d.kind === "fire_district" && d.district === district) || watch.fireDistrict === district) return `Fire danger district: ${district}`;
        return null;
    }
    if (d.kind === "fire_district") return null;
    if (d.kind === "gauge") return record.externalId === `gauge-${d.station}` ? `River gauge ${d.station}` : null;
    if (d.kind === "incident") return record.id === d.recordId ? "The incident you're following" : null;
    // BoM warnings describe districts in words: matched through the district of the nearest BoM station.
    if (record.geometryQuality === "area_text" || record.geometryQuality === "district") {
        const districts = (record.attributes.districts ?? "").split(",");
        return context.bomDistrict && districts.includes(context.bomDistrict)
            ? `Warning district ${context.bomDistrict} (the district of the BoM station nearest this area)`
            : null;
    }
    const area = geometry && hasArea(geometry) ? geometry : null;
    const point = recordPoint(record);
    const bbox = watchBBox(d);
    if (bbox && record.bbox && !bboxIntersects(bbox, record.bbox)) return null;
    switch (d.kind) {
        case "point": {
            const centre: Position = [d.lon, d.lat];
            const km = area ? distanceToAreaKm(centre, area) : point ? distanceKm(centre, point) : Infinity;
            return km <= d.radiusKm ? (km === 0 ? "The published area covers this place" : `${km.toFixed(1)} km from ${d.placeName || "this place"}`) : null;
        }
        case "polygon": {
            if (point && pointInPolygon(point, [d.ring])) return "Inside this area";
            if (area) {
                for (const p of positions(area)) if (pointInPolygon(p, [d.ring])) return "The published area overlaps this area";
                if (polygonsOf(area).some((poly) => d.ring.some((q) => pointInPolygon(q, poly)))) return "The published area overlaps this area";
            }
            return null;
        }
        case "region": {
            const box: BBox = [d.west, d.south, d.east, d.north];
            if (point && point[0] >= box[0] && point[0] <= box[2] && point[1] >= box[1] && point[1] <= box[3]) return "Inside this region";
            return area && record.bbox && bboxIntersects(box, record.bbox) ? "The published area reaches into this region" : null;
        }
        case "corridor": {
            const km = point ? distanceToLineKm(point, d.line) : area ? Math.min(...d.line.map((q) => distanceToAreaKm(q, area))) : Infinity;
            return km <= d.bufferKm ? `${km.toFixed(1)} km from the route` : null;
        }
    }
    return null;
}

async function nearestBomDistrict(db: D1Database, centre: Position | null): Promise<string | null> {
    if (!centre) return null;
    const box = expandBBox([centre[0], centre[1], centre[0], centre[1]], 80);
    const rows = await db
        .prepare(
            "SELECT lat, lon, json_extract(attrs, '$.district') AS district FROM ic_records WHERE source_id = 'bom-observations' AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ? LIMIT 200",
        )
        .bind(box[1], box[3], box[0], box[2])
        .all<{ lat: number; lon: number; district: string | null }>();
    let best: { km: number; district: string } | null = null;
    for (const r of rows.results) {
        if (!r.district) continue;
        const km = distanceKm(centre, [r.lon, r.lat]);
        if (!best || km < best.km) best = { km, district: r.district };
    }
    return best?.district ?? null;
}

export const matchContextFor = async (db: D1Database, watch: WatchArea): Promise<MatchContext> => ({
    bomDistrict: await nearestBomDistrict(db, watchCentre(watch.definition)),
});

/** Active records that concern this watch area, with the reason for each. */
export async function recordsForWatch(db: D1Database, watch: WatchArea, limit = 300): Promise<{ record: CentreRecord; reason: string }[]> {
    const bbox = watchBBox(watch.definition);
    const context = await matchContextFor(db, watch);
    const where = ["active = 1"];
    const binds: unknown[] = [];
    if (bbox) {
        // Points in the box, areas whose box meets it, and anything without coordinates (district and text warnings).
        where.push("((lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?) OR (max_lat >= ? AND min_lat <= ? AND max_lon >= ? AND min_lon <= ?) OR lat IS NULL)");
        binds.push(bbox[1], bbox[3], bbox[0], bbox[2], bbox[1], bbox[3], bbox[0], bbox[2]);
    }
    const rows = await db
        .prepare(`SELECT ${RECORD_COLUMNS}, geometry FROM ic_records WHERE ${where.join(" AND ")} ORDER BY severity_rank DESC LIMIT 3000`)
        .bind(...binds)
        .all<RecordRow & { geometry: string | null }>();
    const out: { record: CentreRecord; reason: string }[] = [];
    for (const row of rows.results) {
        const record = toRecord(row);
        const reason = matchWatch(watch, record, row.geometry ? parseJson<Geometry | null>(row.geometry, null) : null, context);
        if (reason) out.push({ record, reason });
        if (out.length >= limit) break;
    }
    return out;
}

// --- Reading and writing --------------------------------------------------------------------------

export async function listWatches(db: D1Database, email: string): Promise<WatchArea[]> {
    const rows = await db.prepare("SELECT * FROM ic_watch_areas WHERE email = ? ORDER BY name COLLATE NOCASE").bind(email).all<WatchRow>();
    return rows.results.map(toWatch);
}

/** The caller's own watch area, or 404 (also for someone else's: their existence isn't revealed). */
export async function requireWatch(db: D1Database, email: string, id: string): Promise<WatchArea> {
    if (!/^icw_[a-z0-9]{14}$/.test(id)) throw new HttpError(404, "not_found", "Not found");
    const row = await db.prepare("SELECT * FROM ic_watch_areas WHERE id = ? AND email = ?").bind(id, email).first<WatchRow>();
    if (!row) throw new HttpError(404, "not_found", "Not found");
    return toWatch(row);
}

function validate(input: WatchInput) {
    const d = input.definition;
    const box = watchBBox(d);
    // NSW-first, with room for nearby states; nothing global.
    if (box && !bboxIntersects(expandBBox(NSW_BBOX, 600), box)) throw new HttpError(422, "validation", "Watch areas must be in or near NSW for now");
    if (input.quietStart && !input.quietEnd) throw new HttpError(422, "validation", "Quiet hours need an end time too");
    if (input.expiresAt && Date.parse(input.expiresAt) < Date.now()) throw new HttpError(422, "validation", "The end date is in the past");
}

const columns = (input: WatchInput) => {
    const box = watchBBox(input.definition);
    return [
        input.name,
        input.definition.kind,
        JSON.stringify(input.definition),
        input.fireDistrict,
        box?.[1] ?? null,
        box?.[0] ?? null,
        box?.[3] ?? null,
        box?.[2] ?? null,
        JSON.stringify(input.categories),
        input.minLevel,
        input.notifyInApp ? 1 : 0,
        input.notifyEmail ? 1 : 0,
        input.quietStart,
        input.quietEnd,
        input.expiresAt,
        input.enabled ? 1 : 0,
    ];
};

export async function createWatch(db: D1Database, user: PortalUser, body: unknown, via: "portal" | "mcp" = "portal"): Promise<WatchArea> {
    const input = watchInputSchema.parse(body);
    validate(input);
    const count = await db.prepare("SELECT COUNT(*) AS n FROM ic_watch_areas WHERE email = ?").bind(user.email).first<{ n: number }>();
    if ((count?.n ?? 0) >= MAX_WATCHES) throw new HttpError(422, "validation", `You can have up to ${MAX_WATCHES} watch areas`);
    const id = newId("icw");
    const now = nowIso();
    await db.batch([
        db
            .prepare(
                `INSERT INTO ic_watch_areas (id, email, name, kind, definition, fire_district, min_lat, min_lon, max_lat, max_lon, categories, min_level,
                    notify_in_app, notify_email, quiet_start, quiet_end, expires_at, enabled, version, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
            )
            .bind(id, user.email, ...columns(input), now, now),
        // Audited by id and kind only: a name or place could identify a home.
        auditStatement(db, {
            actor: user.email,
            action: "centre.watch.create",
            entityType: "centre_watch",
            entityId: id,
            summary: `Created a ${input.definition.kind} watch area${via === "mcp" ? " (AI assistant)" : ""}`,
        }),
    ]);
    return requireWatch(db, user.email, id);
}

export async function updateWatch(db: D1Database, user: PortalUser, id: string, body: unknown): Promise<WatchArea> {
    const { version, ...rest } = (body ?? {}) as { version?: unknown };
    if (typeof version !== "number") throw new HttpError(422, "validation", "Send the version you edited");
    await requireWatch(db, user.email, id);
    const input = watchInputSchema.parse(rest);
    validate(input);
    const now = nowIso();
    const [result] = await db.batch([
        db
            .prepare(
                `UPDATE ic_watch_areas SET name = ?, kind = ?, definition = ?, fire_district = ?, min_lat = ?, min_lon = ?, max_lat = ?, max_lon = ?, categories = ?,
                    min_level = ?, notify_in_app = ?, notify_email = ?, quiet_start = ?, quiet_end = ?, expires_at = ?, enabled = ?, version = version + 1, updated_at = ?
                 WHERE id = ? AND email = ? AND version = ?`,
            )
            .bind(...columns(input), now, id, user.email, version),
        auditStatement(db, { actor: user.email, action: "centre.watch.update", entityType: "centre_watch", entityId: id, summary: "Changed a watch area" }),
    ]);
    if (!result.meta.changes) throw new HttpError(409, "conflict", "This watch area was changed elsewhere. Reload and try again.");
    return requireWatch(db, user.email, id);
}

export async function deleteWatch(db: D1Database, user: PortalUser, id: string) {
    await requireWatch(db, user.email, id);
    await db.batch([
        db.prepare("DELETE FROM ic_watch_areas WHERE id = ? AND email = ?").bind(id, user.email),
        db.prepare("UPDATE ic_alerts SET watch_id = NULL WHERE watch_id = ? AND email = ?").bind(id, user.email),
        auditStatement(db, { actor: user.email, action: "centre.watch.delete", entityType: "centre_watch", entityId: id, summary: "Deleted a watch area" }),
    ]);
}

/** Fire danger district names, for the watch area form. */
export async function fireDistricts(db: D1Database): Promise<string[]> {
    const rows = await db.prepare("SELECT title FROM ic_records WHERE source_id = 'rfs-fire-danger' ORDER BY title").all<{ title: string }>();
    return [...new Set(rows.results.map((r) => r.title))];
}
