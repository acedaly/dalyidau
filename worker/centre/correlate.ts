// Cross-source correlation (docs/INTELLIGENCE_CENTRE.md#correlation-methodology and
// docs/INTELLIGENCE_CENTRE_9_1.md#correlation).
//
// Deterministic rules only, each with its evidence, distances, times, the factors it weighed and
// its limitations. Two kinds of result, always labelled apart:
//  - explicit: an authoritative source links the records itself (an RFS alert naming the incident's
//    identifier). Shown as "linked by the provider".
//  - derived: the Centre's rule found them near each other in place and time. Shown as "may be
//    related"; confidence is "low" or "moderate", never higher, because proximity isn't cause.
// No rule creates or raises a warning level, merges records or makes up an incident. Every rule is
// anchored on an official record and capped (members per group, groups per rule, groups in all),
// so loosely related records can't multiply into an uncontrolled web of combinations.
import type { D1Database } from "@cloudflare/workers-types";
import type { CentreRecord, CentreSettings, Correlation, CorrelationEvidence, CorrelationFactor } from "../../src/shared/centre/types";
import { GEOMETRY_QUALITY_LABELS, fireDangerRank } from "../../src/shared/centre/types";
import { parseJson } from "../portal/db";
import { sha256Hex } from "./adapters/types";
import { type BBox, type Geometry, type Position, bboxIntersects, distanceKm, distanceToAreaKm, pointInPolygon, polygonsOf, positions } from "./geo";
import { RECORD_COLUMNS, type RecordRow, toRecord } from "./store";

/** Members in one group, groups from one rule, and groups in all. */
const MAX_MEMBERS = 20;
const MAX_PER_RULE = 40;
const MAX_TOTAL = 150;
/** The Bureau's own threshold for damaging gusts in severe thunderstorm warnings. */
const DAMAGING_GUST_KMH = 90;
/** A reference temperature the Centre uses for heat (not an official heatwave definition). */
const HEAT_REFERENCE_C = 40;
/** NSW Government air quality categories from "Poor" up (the provider's own categories). */
const POOR_AIR_RANK = 2;

interface Item {
    record: CentreRecord;
    point: Position | null;
    geometry: Geometry | null;
    at: number;
    district: string | null;
}

const pointOf = (r: CentreRecord): Position | null => (r.lat !== null && r.lon !== null ? [r.lon, r.lat] : null);
const timeOf = (r: CentreRecord) => Date.parse(r.observedAt ?? r.updatedAt ?? r.publishedAt ?? r.firstSeenAt);
const hoursApart = (a: number, b: number) => Math.round((Math.abs(a - b) / 3_600_000) * 10) / 10;

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

/** Whether two published areas overlap (a vertex of one inside the other). */
function areasOverlap(a: Geometry, b: Geometry): boolean {
    const pa = polygonsOf(a);
    const pb = polygonsOf(b);
    if (!pa.length || !pb.length) return false;
    for (const p of positions(a)) if (pb.some((poly) => pointInPolygon(p, poly))) return true;
    for (const p of positions(b)) if (pa.some((poly) => pointInPolygon(p, poly))) return true;
    return false;
}

const accuracyOf = (items: Item[]) => {
    const qualities = [...new Set(items.map((i) => i.record.geometryQuality))];
    return qualities.map((q) => GEOMETRY_QUALITY_LABELS[q]).join(" ");
};

async function load(db: D1Database, bbox: BBox | null, since: string): Promise<{ items: Item[]; stations: { id: string; lat: number; lon: number; district: string; title: string }[] }> {
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
                "SELECT id, title, lat, lon, json_extract(attrs, '$.district') AS district FROM ic_records WHERE source_id = 'bom-observations' AND active = 1 AND lat IS NOT NULL",
            )
            .all<{ id: string; title: string; lat: number; lon: number; district: string | null }>()
    ).results.filter((s): s is { id: string; title: string; lat: number; lon: number; district: string } => !!s.district);
    // Gauges and air quality sites are observations: only these two kinds are used, as evidence.
    const observed = (
        await db.prepare(`SELECT ${RECORD_COLUMNS} FROM ic_records WHERE source_id IN ('bom-water', 'nsw-air-quality') AND active = 1`).all<RecordRow>()
    ).results;
    const districtOf = (p: Position | null) => {
        if (!p || !stations.length) return null;
        let best = { km: Infinity, d: null as string | null };
        for (const s of stations) {
            const km = distanceKm(p, [s.lon, s.lat]);
            if (km < best.km) best = { km, d: s.district };
        }
        return best.km <= 60 ? best.d : null;
    };
    const items = [...rows.results, ...observed.map((g) => ({ ...g, geometry: null }))].map((row) => {
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
    return { items, stations };
}

export async function correlations(
    db: D1Database,
    settings: CentreSettings,
    options: { bbox?: BBox | null; now?: Date; recordId?: string } = {},
): Promise<Correlation[]> {
    const now = options.now ?? new Date();
    const windowMs = settings.correlation.windowHours * 3_600_000;
    const since = new Date(now.getTime() - windowMs).toISOString();
    const { items, stations } = await load(db, options.bbox ?? null, since);
    const D = settings.correlation.distanceKm;
    const W = settings.correlation.windowHours;
    const of = (pred: (i: Item) => boolean) => items.filter(pred);
    const out: Correlation[] = [];
    const perRule = new Map<string, number>();
    const add = async (
        rule: string,
        basis: Correlation["basis"],
        title: string,
        explanation: string,
        confidence: Correlation["confidence"],
        limitations: string,
        factors: CorrelationFactor[],
        members: { item: Item; km: number | null }[],
    ) => {
        if (out.length >= MAX_TOTAL || (perRule.get(rule) ?? 0) >= MAX_PER_RULE) return;
        perRule.set(rule, (perRule.get(rule) ?? 0) + 1);
        const kept = members.slice(0, MAX_MEMBERS + 1);
        const ids = kept.map((m) => m.item.record.id).sort();
        const anchor = kept[0].item;
        out.push({
            id: `cor_${(await sha256Hex(`${rule}:${ids.join(",")}`)).slice(0, 14)}`,
            rule,
            title,
            explanation,
            basis,
            confidence,
            limitations,
            factors,
            records: kept.map((m) => evidence(m.item, m.km)),
            centre: anchor.point ? { lat: anchor.point[1], lon: anchor.point[0] } : null,
        });
    };

    const fires = of((i) => i.record.kind === "incident" && i.record.category === "fire" && (!!i.point || !!i.geometry));
    const hotspots = of((i) => i.record.kind === "detection" && !!i.point);
    const roads = of((i) => i.record.category === "transport" && !!i.point);
    const bomWarnings = of((i) => i.record.kind === "warning" && (i.record.category === "flood" || i.record.category === "weather"));
    const outages = of((i) => i.record.category === "power" && !!i.point);
    const airSites = of((i) => i.record.category === "air" && !!i.point);
    // Gauges count only with a recorded material rise in the window (ic_changes, from the ingestion engine).
    const risen = new Set(
        (
            await db
                .prepare("SELECT record_id FROM ic_changes WHERE kind = 'measurement_change' AND at >= ? AND CAST(to_value AS REAL) > CAST(from_value AS REAL)")
                .bind(since)
                .all<{ record_id: string }>()
        ).results.map((r) => r.record_id),
    );
    const gauges = of((i) => i.record.sourceId === "bom-water" && !!i.point && risen.has(i.record.id));
    const ratings = of((i) => i.record.kind === "rating");
    const districtsOf = (i: Item) => new Set((i.record.attributes.districts ?? "").split(",").filter(Boolean));

    // 0. Explicit: an RFS alert that names the incident it's about (CAP-AU IncidentId).
    const incidentsById = new Map(
        of((i) => i.record.sourceId === "rfs-incidents").map((i) => [i.record.externalId.replace(/^incident-/, ""), i] as const),
    );
    for (const alert of of((i) => i.record.sourceId === "rfs-incident-alerts" && !!i.record.attributes.incidentId)) {
        const incident = incidentsById.get(alert.record.attributes.incidentId);
        if (!incident) continue;
        await add(
            "alert-incident",
            "explicit",
            `${alert.record.title} is about ${incident.record.title}`,
            "The NSW RFS alert names this incident's identifier: the link is the provider's own.",
            "moderate",
            "The alert and the incident are kept as separate records with their own levels and times; neither is changed by the link.",
            [{ factor: "identifier", finding: `The alert's IncidentId (${alert.record.attributes.incidentId}) is the incident's published identifier.` }],
            [
                { item: incident, km: null },
                { item: alert, km: null },
            ],
        );
    }

    // 1. Satellite thermal detections near an official fire incident.
    for (const fire of fires) {
        const near = hotspots
            .map((h) => ({ item: h, km: between(h, fire) }))
            .filter((m) => m.km !== null && m.km <= 5 && Math.abs(m.item.at - fire.at) <= 24 * 3_600_000);
        if (!near.length) continue;
        await add(
            "fire-thermal",
            "derived",
            `Satellite detections near ${fire.record.title}`,
            `${near.length} satellite thermal ${near.length === 1 ? "detection is" : "detections are"} within 5 km of this official ${fire.record.provider} incident and within 24 hours of its last update.`,
            near.length >= 3 ? "moderate" : "low",
            "Detections are satellite heat signatures with a stated accuracy (often ±2 km). They don't confirm the fire's extent, intensity or that the detection is this fire.",
            [
                { factor: "geography", finding: `Nearest ${Math.min(...near.map((m) => m.km!)).toFixed(1)} km from ${fire.geometry ? "the published area" : "the published point"}.` },
                { factor: "time", finding: `Within ${Math.max(...near.map((m) => hoursApart(m.item.at, fire.at)))} hours of the incident's last update.` },
                { factor: "hazard", finding: "A fire incident and thermal detections." },
                { factor: "accuracy", finding: accuracyOf([fire, ...near.map((m) => m.item)]) },
            ],
            [{ item: fire, km: null }, ...near.slice(0, MAX_MEMBERS)],
        );
    }

    // 2. Road hazards near an official fire incident.
    for (const fire of fires.filter((f) => f.record.severityRank >= 1 || f.record.status !== "Under control")) {
        const near = roads
            .map((r) => ({ item: r, km: between(r, fire) }))
            .filter((m) => m.km !== null && m.km <= D && Math.abs(m.item.at - fire.at) <= windowMs);
        if (!near.length) continue;
        const fireRelated = near.some((m) => /fire/i.test(m.item.record.eventType ?? "") || m.item.record.attributes.hazardType === "fire");
        await add(
            "fire-roads",
            "derived",
            `Road hazards near ${fire.record.title}`,
            `${near.length} road ${near.length === 1 ? "hazard is" : "hazards are"} within ${D} km of this fire incident in the same ${W}-hour window.`,
            fireRelated ? "moderate" : "low",
            "Nearby isn't the same as caused by: the road hazard may be unrelated. Transport for NSW doesn't list every local closure.",
            [
                { factor: "geography", finding: `Within ${D} km (nearest ${Math.min(...near.map((m) => m.km!)).toFixed(1)} km).` },
                { factor: "time", finding: `In the same ${W}-hour window.` },
                { factor: "hazard", finding: fireRelated ? "Transport for NSW lists at least one as fire-related." : "No road hazard is listed as fire-related." },
            ],
            [{ item: fire, km: null }, ...near.slice(0, MAX_MEMBERS)],
        );
    }

    // 3. Weather or flood warning for a district, with observed river rises, flooded roads and outages in it.
    for (const warning of bomWarnings) {
        const districts = districtsOf(warning);
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
            "derived",
            `Observations in the districts of ${warning.record.title}`,
            `${kinds} in the forecast districts this Bureau warning names, within the last ${W} hours.`,
            rising.length && roadsIn.length ? "moderate" : "low",
            "Matched by BoM forecast district, worked out from the nearest weather station to each record: districts are large, and the warning text doesn't say these places are affected. River readings may lag by a day or more.",
            [
                { factor: "geography", finding: `Same BoM forecast district (${[...districts].join(", ")}), by nearest station.` },
                { factor: "time", finding: `Within the last ${W} hours.` },
                { factor: "measurement", finding: rising.length ? `River rises of at least ${settings.riverChangeMetres} m between collections (observed).` : "No river measurements involved." },
            ],
            [{ item: warning, km: null }, ...members.slice(0, MAX_MEMBERS).map((m) => ({ item: m, km: null }))],
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
            "derived",
            `${rating.record.title}: ${rating.record.attributes.today}${rating.record.attributes.banToday === "yes" ? ", Total Fire Ban" : ""} with active fires`,
            `${inDistrict.length} active fire ${inDistrict.length === 1 ? "incident is" : "incidents are"} in councils the RFS lists for this district.`,
            "moderate",
            "Matched by council name as the RFS publishes it. The rating describes potential fire behaviour across the district, not at each incident.",
            [
                { factor: "geography", finding: "Council names the RFS publishes for the district and for each incident." },
                { factor: "hazard", finding: `Fire danger ${rating.record.attributes.today} today and active fire incidents.` },
            ],
            [{ item: rating, km: null }, ...inDistrict.slice(0, MAX_MEMBERS).map((f) => ({ item: f, km: null }))],
        );
    }

    // 5 and 6. Wind and heat warnings with observed extremes at stations in the districts they name.
    const peaks = async (metric: string, min: number) =>
        (
            await db
                .prepare(
                    "SELECT record_id, MAX(value) AS value, at FROM ic_series WHERE metric = ? AND at >= ? AND value >= ? GROUP BY record_id ORDER BY value DESC LIMIT 200",
                )
                .bind(metric, since, min)
                .all<{ record_id: string; value: number; at: string }>()
        ).results;
    const stationItem = (id: string, value: number, unit: string, at: string): Item | null => {
        const s = stations.find((x) => x.id === id);
        if (!s) return null;
        const record: CentreRecord = {
            id: s.id,
            sourceId: "bom-observations",
            provider: "Bureau of Meteorology",
            externalId: "",
            kind: "observation",
            category: "weather",
            eventType: "Observation",
            title: `${s.title}: ${value} ${unit}`,
            description: null,
            status: null,
            warningLevel: null,
            severityRank: 0,
            lat: s.lat,
            lon: s.lon,
            bbox: null,
            hasGeometry: false,
            geometryQuality: "point",
            uncertaintyM: null,
            areaName: null,
            publishedAt: null,
            updatedAt: null,
            observedAt: at,
            firstSeenAt: at,
            lastSeenAt: at,
            missingSince: null,
            active: true,
            sourceUrl: null,
            metrics: [],
            attributes: { district: s.district },
            fixture: false,
        };
        return { record, point: [s.lon, s.lat], geometry: null, at: Date.parse(at), district: s.district };
    };
    const windWarnings = bomWarnings.filter((w) => /wind|thunderstorm|severe weather|storm/i.test(`${w.record.title} ${w.record.eventType ?? ""}`));
    if (windWarnings.length) {
        const gusts = await peaks("gust_kmh", DAMAGING_GUST_KMH);
        for (const warning of windWarnings) {
            const districts = districtsOf(warning);
            const members = gusts
                .map((g) => stationItem(g.record_id, g.value, "km/h gust", g.at))
                .filter((i): i is Item => !!i && !!i.district && districts.has(i.district) && i.at >= warning.at - 3_600_000);
            if (!members.length) continue;
            await add(
                "wind-gusts",
                "derived",
                `Damaging-strength gusts observed in the districts of ${warning.record.title}`,
                `${members.length} Bureau ${members.length === 1 ? "station" : "stations"} in the districts this warning names recorded gusts of ${DAMAGING_GUST_KMH} km/h or more after it was issued.`,
                members.length >= 2 ? "moderate" : "low",
                `${DAMAGING_GUST_KMH} km/h is the Bureau's threshold for damaging gusts in its severe thunderstorm warnings; a single gust at one station doesn't describe the whole district. Matched by forecast district.`,
                [
                    { factor: "measurement", finding: `Highest observed gust ${Math.max(...members.map((m) => Number(m.record.title.match(/: ([\d.]+)/)?.[1] ?? 0)))} km/h (Bureau station observation).` },
                    { factor: "geography", finding: "Stations in the forecast districts the warning names." },
                    { factor: "time", finding: "Observed after the warning was issued and within the correlation window." },
                ],
                [{ item: warning, km: null }, ...members.slice(0, MAX_MEMBERS).map((m) => ({ item: m, km: null }))],
            );
        }
    }
    const heatWarnings = bomWarnings.filter((w) => /heat/i.test(`${w.record.title} ${w.record.eventType ?? ""}`));
    if (heatWarnings.length) {
        const hot = await peaks("air_temperature", HEAT_REFERENCE_C);
        for (const warning of heatWarnings) {
            const districts = districtsOf(warning);
            const members = hot
                .map((g) => stationItem(g.record_id, g.value, "°C", g.at))
                .filter((i): i is Item => !!i && !!i.district && districts.has(i.district) && i.at >= warning.at - 86_400_000);
            if (!members.length) continue;
            await add(
                "heat-temperature",
                "derived",
                `${HEAT_REFERENCE_C} °C or more observed in the districts of ${warning.record.title}`,
                `${members.length} Bureau ${members.length === 1 ? "station" : "stations"} in the districts this heat warning names recorded ${HEAT_REFERENCE_C} °C or more.`,
                "low",
                `${HEAT_REFERENCE_C} °C is a reference the Centre uses, not the Bureau's heatwave definition (which is about three-day mean temperatures). Matched by forecast district.`,
                [
                    { factor: "measurement", finding: "Station air temperatures (observed)." },
                    { factor: "geography", finding: "Stations in the forecast districts the warning names." },
                ],
                [{ item: warning, km: null }, ...members.slice(0, MAX_MEMBERS).map((m) => ({ item: m, km: null }))],
            );
        }
    }

    // 7. Poor air quality with an active fire or several detections within 50 km.
    for (const site of airSites.filter((a) => a.record.severityRank >= POOR_AIR_RANK && now.getTime() - a.at <= windowMs)) {
        const nearFires = fires.map((f) => ({ item: f, km: between(site, f) })).filter((m) => m.km !== null && m.km <= 50);
        const nearDetections = hotspots.map((h) => ({ item: h, km: between(site, h) })).filter((m) => m.km !== null && m.km <= 50);
        if (!nearFires.length && nearDetections.length < 3) continue;
        await add(
            "air-fire",
            "derived",
            `${site.record.status} air quality at ${site.record.title} near fire activity`,
            `The NSW Government reports ${site.record.status} air quality here, with ${nearFires.length} fire ${nearFires.length === 1 ? "incident" : "incidents"} and ${nearDetections.length} satellite detections within 50 km.`,
            nearFires.length ? "moderate" : "low",
            "Smoke travels with the wind, and poor air quality has other causes (dust, traffic, inversions). This doesn't say where the smoke came from.",
            [
                { factor: "measurement", finding: `${site.record.status}, the provider's own category (observed ${new Date(site.at).toISOString().slice(11, 16)} UTC).` },
                { factor: "geography", finding: "Fire activity within 50 km of the monitoring site." },
                { factor: "freshness", finding: `The reading is within the ${W}-hour window.` },
            ],
            [{ item: site, km: null }, ...[...nearFires, ...nearDetections].slice(0, MAX_MEMBERS)],
        );
    }

    // 8. More than one official warning for the same area: overlapping published areas, or the same districts.
    const warnings = of((i) => i.record.kind === "warning");
    const paired = new Set<string>();
    for (const a of warnings) {
        if (paired.has(a.record.id)) continue;
        const group: { item: Item; km: number | null }[] = [];
        for (const b of warnings) {
            if (a === b || paired.has(b.record.id) || a.record.id === b.record.id) continue;
            const overlap =
                !!a.geometry &&
                !!b.geometry &&
                !!a.record.bbox &&
                !!b.record.bbox &&
                bboxIntersects(a.record.bbox, b.record.bbox) &&
                areasOverlap(a.geometry, b.geometry);
            const shared = [...districtsOf(a)].some((d) => districtsOf(b).has(d));
            if (overlap || shared) group.push({ item: b, km: overlap ? 0 : null });
        }
        if (!group.length) continue;
        for (const m of group) paired.add(m.item.record.id);
        paired.add(a.record.id);
        const byArea = group.some((m) => m.km === 0);
        await add(
            "multi-warning",
            "derived",
            `${group.length + 1} official warnings for the same area`,
            byArea
                ? `These warnings' published areas overlap: ${[a, ...group.map((m) => m.item)].map((i) => i.record.title).join("; ")}.`
                : `These warnings name the same forecast districts: ${[a, ...group.map((m) => m.item)].map((i) => i.record.title).join("; ")}.`,
            byArea ? "moderate" : "low",
            "Each warning keeps its own provider, level and instructions; follow each one. Overlap is worked out from the published areas or district names only.",
            [
                { factor: "geography", finding: byArea ? "Published areas overlap." : "The same forecast districts are named." },
                { factor: "hazard", finding: [...new Set([a, ...group.map((m) => m.item)].map((i) => i.record.category))].join(", ") },
            ],
            [{ item: a, km: null }, ...group.slice(0, MAX_MEMBERS)],
        );
    }

    return options.recordId ? out.filter((c) => c.records.some((r) => r.recordId === options.recordId)) : out;
}
