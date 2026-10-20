// GeoJSON for the map (and the wallboard's map), built from stored records. Points stay points;
// a provider's published area is drawn as published (thinned for the screen, never smoothed or
// grown); text-only and district records aren't drawn at all, and are listed beside the map.
import type { D1Database } from "@cloudflare/workers-types";
import type { CentreRecord, MapLayer } from "../../src/shared/centre/types";
import { parseJson } from "../portal/db";
import { type Geometry, cleanGeometry, polygonsOf } from "./geo";

export const layerOf = (r: Pick<CentreRecord, "category" | "kind" | "sourceId">): MapLayer => {
    if (r.category === "fire") return r.kind === "warning" ? "warnings" : "fire";
    if (r.category === "weather") return "weather";
    if (r.category === "flood") return "flood";
    if (r.category === "water") return "water";
    if (r.category === "transport") return "transport";
    if (r.category === "power") return "power";
    if (r.category === "air") return "air";
    if (r.category === "hotspot") return "hotspot";
    if (r.category === "earthquake") return "earthquake";
    return "emergency";
};

export interface MapFeature {
    type: "Feature";
    id: string;
    geometry: Geometry;
    properties: {
        id: string;
        layer: MapLayer;
        kind: string;
        title: string;
        level: string | null;
        rank: number;
        area: 0 | 1;
        nature: "official" | "observed";
        at: string | null;
    };
}

const SCREEN_VERTICES = 1_500;

export async function mapFeatures(db: D1Database, records: CentreRecord[]): Promise<{ type: "FeatureCollection"; features: MapFeature[] }> {
    const withAreas = records.filter((r) => r.hasGeometry).map((r) => r.id);
    const areas = new Map<string, Geometry>();
    for (let i = 0; i < withAreas.length; i += 90) {
        const part = withAreas.slice(i, i + 90);
        const rows = await db
            .prepare(`SELECT id, geometry FROM ic_records WHERE id IN (${part.map(() => "?").join(",")})`)
            .bind(...part)
            .all<{ id: string; geometry: string | null }>();
        for (const row of rows.results) {
            const g = row.geometry ? parseJson<Geometry | null>(row.geometry, null) : null;
            const polys = g ? polygonsOf(g) : [];
            if (polys.length) {
                const thinned = cleanGeometry({ type: "MultiPolygon", coordinates: polys }, SCREEN_VERTICES);
                if (thinned) areas.set(row.id, thinned);
            }
        }
    }
    const features: MapFeature[] = [];
    for (const r of records) {
        const props = {
            id: r.id,
            layer: layerOf(r),
            kind: r.kind,
            title: r.title,
            level: r.warningLevel,
            rank: r.severityRank,
            nature: r.kind === "observation" || r.kind === "detection" ? ("observed" as const) : ("official" as const),
            at: r.observedAt ?? r.updatedAt ?? r.publishedAt ?? r.firstSeenAt,
        };
        const area = areas.get(r.id);
        if (area) features.push({ type: "Feature", id: `${r.id}:area`, geometry: area, properties: { ...props, area: 1 } });
        if (r.lat !== null && r.lon !== null)
            features.push({ type: "Feature", id: r.id, geometry: { type: "Point", coordinates: [r.lon, r.lat] }, properties: { ...props, area: 0 } });
    }
    return { type: "FeatureCollection", features };
}
