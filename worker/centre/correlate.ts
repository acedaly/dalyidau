// Cross-source correlation (docs/INTELLIGENCE_CENTRE.md#correlation-methodology).
//
// Deterministic rules only, each with its evidence, distances, times and limitations. They find
// records that may be related; they never say one caused another, never create a warning level,
// and never merge records. Confidence is "low" or "moderate", never higher: correlation is not
// confirmation. A model may explain these groups later, but can't add a record to one.
import type { D1Database } from "@cloudflare/workers-types";
import type { CentreRecord, CentreSettings, Correlation, CorrelationEvidence } from "../../src/shared/centre/types";
import { fireDangerRank } from "../../src/shared/centre/types";
import { parseJson } from "../portal/db";
import { sha256Hex } from "./adapters/types";
import { type BBox, type Geometry, type Position, distanceKm, distanceToAreaKm } from "./geo";
import { RECORD_COLUMNS, type RecordRow, toRecord } from "./store";

interface Item {
    record: CentreRecord;
    point: Position | null;
    geometry: Geometry | null;
    at: number;
    district: string | null;
}

const pointOf = (r: CentreRecord): Position | null => (r.lat !== null && r.lon !== null ? [r.lon, r.lat] : null);
const timeOf = (r: CentreRecord) => Date.parse(r.observedAt ?? r.updatedAt ?? r.publishedAt ?? r.firstSeenAt);

const evidence = (i: Item, distance: number | null): CorrelationEvidence => ({
    recordId: i.record.id,
    title: i.record.title,
    category: i.record.category,
    kind: i.record.kind,
    provider: i.record.provider,
    at: i.record.observedAt ?? i.record.updatedAt ?? i.record.publishedAt,
    distanceKm: distance === null ? null : Math.round(distance * 10) / 10,
    sourceUrl: i.record.sourceUrl,
});

/** Distance between two items, using a published area when there is one. */
function between(a: Item, b: Item): number | null {
    if (a.point && b.geometry) return distanceToAreaKm(a.point, b.geometry);
    if (b.point && a.geometry) return distanceToAreaKm(b.point, a.geometry);
    if (a.point && b.point) return distanceKm(a.point, b.point);
    return null;
}

async function load(db: D1Database, bbox: BBox | null, since: string): Promise<Item[]> {
    const where = ["active = 1", "COALESCE(observed_at, updated_at, published_at, first_seen_at) >= ?"];
    const binds: unknown[] = [since];
    if (bbox) {
        where.push("((lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?) OR lat IS NULL)");
        binds.push(bbox[1], bbox[3], bbox[0], bbox[2]);
    }
    const rows = await db
        .prepare(
            `SELECT ${RECORD_COLUMNS}, CASE WHEN kind IN ('incident', 'warning') THEN geometry END AS geometry FROM ic_records
             WHERE ${where.join(" AND ")} AND kind != 'observation' ORDER BY severity_rank DESC LIMIT 4000`,
        )
        .bind(...binds)
        .all<RecordRow & { geometry: string | null }>();
    // Stations give BoM districts to everything else (BoM warnings name districts, not places).
    const stations = (
        await db
            .prepare(
                "SELECT lat, lon, json_extract(attrs, '$.district') AS district FROM ic_records WHERE source_id = 'bom-observations' AND active = 1 AND lat IS NOT NULL",
            )
            .all<{ lat: number; lon: number; district: string | null }>()
    ).results.filter((s) => s.district);
    const gauges = (await db.prepare(`SELECT ${RECORD_COLUMNS} FROM ic_records WHERE source_id = 'bom-water' AND active = 1`).all<RecordRow>()).results;
    const districtOf = (p: Position | null) => {
        if (!p || !stations.length) return null;
        let best = { km: Infinity, d: null as string | null };
        for (const s of stations) {
            const km = distanceKm(p, [s.lon, s.lat]);
            if (km < best.km) best = { km, d: s.district };
        }
        return best.km <= 60 ? best.d : null;
    };
    const items = [...rows.results, ...gauges.map((g) => ({ ...g, geometry: null }))].map((row) => {
        const record = toRecord(row);
        const point = pointOf(record);
        return {
            record,
            point,
            geometry: row.geometry ? parseJson<Geometry | null>(row.geometry, null) : null,
            at: timeOf(record),
            district: districtOf(point),
        };
    });
    return items;
}

export async function correlations(
    db: D1Database,
    settings: CentreSettings,
    options: { bbox?: BBox | null; now?: Date; recordId?: string } = {},
): Promise<Correlation[]> {
    const now = options.now ?? new Date();
    const windowMs = settings.correlation.windowHours * 3_600_000;
    const items = await load(db, options.bbox ?? null, new Date(now.getTime() - windowMs).toISOString());
    const D = settings.correlation.distanceKm;
    const of = (pred: (i: Item) => boolean) => items.filter(pred);
    const out: Correlation[] = [];
    const add = async (
        rule: string,
        title: string,
        explanation: string,
        confidence: Correlation["confidence"],
        limitations: string,
        members: { item: Item; km: number | null }[],
    ) => {
        const ids = members.map((m) => m.item.record.id).sort();
        const anchor = members[0].item;
        out.push({
            id: `cor_${(await sha256Hex(`${rule}:${ids.join(",")}`)).slice(0, 14)}`,
            rule,
            title,
            explanation,
            confidence,
            limitations,
            records: members.map((m) => evidence(m.item, m.km)),
            centre: anchor.point ? { lat: anchor.point[1], lon: anchor.point[0] } : null,
        });
    };

    const fires = of((i) => i.record.kind === "incident" && i.record.category === "fire" && (!!i.point || !!i.geometry));
    const hotspots = of((i) => i.record.kind === "detection" && !!i.point);
    const roads = of((i) => i.record.category === "transport" && !!i.point);
    const floodWarnings = of((i) => i.record.kind === "warning" && (i.record.category === "flood" || i.record.category === "weather"));
    const outages = of((i) => i.record.category === "power" && !!i.point);
    // Gauges count only with a recorded material rise in the window (ic_changes, from the ingestion engine).
    const risen = new Set(
        (
            await db
                .prepare("SELECT record_id FROM ic_changes WHERE kind = 'measurement_change' AND at >= ? AND CAST(to_value AS REAL) > CAST(from_value AS REAL)")
                .bind(new Date(now.getTime() - windowMs).toISOString())
                .all<{ record_id: string }>()
        ).results.map((r) => r.record_id),
    );
    const gauges = of((i) => i.record.sourceId === "bom-water" && !!i.point && risen.has(i.record.id));
    const ratings = of((i) => i.record.kind === "rating");

    // 1. Satellite thermal detections near an official fire incident.
    for (const fire of fires) {
        const near = hotspots
            .map((h) => ({ item: h, km: between(h, fire) }))
            .filter((m) => m.km !== null && m.km <= 5 && Math.abs(m.item.at - fire.at) <= 24 * 3_600_000);
        if (!near.length) continue;
        await add(
            "fire-thermal",
            `Satellite detections near ${fire.record.title}`,
            `${near.length} satellite thermal ${near.length === 1 ? "detection is" : "detections are"} within 5 km of this official ${fire.record.provider} incident and within 24 hours of its last update.`,
            near.length >= 3 ? "moderate" : "low",
            "Detections are satellite heat signatures with a stated accuracy (often ±2 km). They don't confirm the fire's extent, intensity or that the detection is this fire.",
            [{ item: fire, km: null }, ...near.slice(0, 20)],
        );
    }

    // 2. Road hazards near an official fire incident.
    for (const fire of fires.filter((f) => f.record.severityRank >= 1 || f.record.status !== "Under control")) {
        const near = roads
            .map((r) => ({ item: r, km: between(r, fire) }))
            .filter((m) => m.km !== null && m.km <= D && Math.abs(m.item.at - fire.at) <= windowMs);
        if (!near.length) continue;
        await add(
            "fire-roads",
            `Road hazards near ${fire.record.title}`,
            `${near.length} road ${near.length === 1 ? "hazard is" : "hazards are"} within ${D} km of this fire incident in the same ${settings.correlation.windowHours}-hour window.`,
            near.some((m) => /fire/i.test(m.item.record.eventType ?? "") || m.item.record.attributes.hazardType === "fire") ? "moderate" : "low",
            "Nearby isn't the same as caused by: the road hazard may be unrelated. Transport for NSW doesn't list every local closure.",
            [{ item: fire, km: null }, ...near.slice(0, 20)],
        );
    }

    // 3. Weather or flood warning for a district, with observed river rises and road hazards in it.
    for (const warning of floodWarnings) {
        const districts = new Set((warning.record.attributes.districts ?? "").split(",").filter(Boolean));
        if (!districts.size) continue;
        const rising = gauges.filter((g) => g.district && districts.has(g.district));
        const roadsIn = roads.filter(
            (r) => r.district && districts.has(r.district) && (r.record.attributes.hazardType === "flood" || /flood|water over/i.test(r.record.title)),
        );
        const powerIn = warning.record.category === "weather" ? outages.filter((o) => o.district && districts.has(o.district)) : [];
        const members = [...rising, ...roadsIn, ...(powerIn.length >= 3 ? powerIn : [])];
        if (!members.length) continue;
        const kinds = [
            rising.length && `${rising.length} river ${rising.length === 1 ? "gauge" : "gauges"} with an observed rise`,
            roadsIn.length && `${roadsIn.length} flood-related road ${roadsIn.length === 1 ? "hazard" : "hazards"}`,
            powerIn.length >= 3 && `${powerIn.length} power outages`,
        ]
            .filter(Boolean)
            .join(", ");
        await add(
            "warning-district",
            `Observations in the districts of ${warning.record.title}`,
            `${kinds} in the forecast districts this Bureau warning names, within the last ${settings.correlation.windowHours} hours.`,
            rising.length && roadsIn.length ? "moderate" : "low",
            "Matched by BoM forecast district, worked out from the nearest weather station to each record: districts are large, and the warning text doesn't say these places are affected. River readings may lag by a day or more.",
            [{ item: warning, km: null }, ...members.slice(0, 20).map((m) => ({ item: m, km: null }))],
        );
    }

    // 4. Elevated fire danger or a Total Fire Ban, with active fires in the district's councils (shared named places).
    for (const rating of ratings) {
        const rank = fireDangerRank(rating.record.attributes.today);
        if (rank < 3 && rating.record.attributes.banToday !== "yes") continue;
        const councils = (rating.record.attributes.councils ?? "")
            .split(";")
            .map((c) => c.trim().toLowerCase())
            .filter(Boolean);
        const inDistrict = fires.filter((f) => councils.includes((f.record.attributes.council ?? "").trim().toLowerCase()));
        if (!inDistrict.length) continue;
        await add(
            "danger-incidents",
            `${rating.record.title}: ${rating.record.attributes.today}${rating.record.attributes.banToday === "yes" ? ", Total Fire Ban" : ""} with active fires`,
            `${inDistrict.length} active fire ${inDistrict.length === 1 ? "incident is" : "incidents are"} in councils the RFS lists for this district.`,
            "moderate",
            "Matched by council name as the RFS publishes it. The rating describes potential fire behaviour across the district, not at each incident.",
            [{ item: rating, km: null }, ...inDistrict.slice(0, 20).map((f) => ({ item: f, km: null }))],
        );
    }

    return options.recordId ? out.filter((c) => c.records.some((r) => r.recordId === options.recordId)) : out;
}
