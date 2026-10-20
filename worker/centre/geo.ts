// Geometry for the Intelligence Centre: validating what providers publish, bounding it, and the
// few spatial tests watch areas and correlation need. Coordinates are [longitude, latitude].
//
// Provider geometry is kept as published, within limits: types are checked, coordinates must be
// finite and in range, and anything over the vertex budget is thinned evenly (never invented or
// smoothed into a new shape). A point stays a point: no buffer is ever drawn around an incident.

export type Position = [number, number];
export type Geometry =
    | { type: "Point"; coordinates: Position }
    | { type: "MultiPoint"; coordinates: Position[] }
    | { type: "LineString"; coordinates: Position[] }
    | { type: "MultiLineString"; coordinates: Position[][] }
    | { type: "Polygon"; coordinates: Position[][] }
    | { type: "MultiPolygon"; coordinates: Position[][][] }
    | { type: "GeometryCollection"; geometries: Geometry[] };

export type BBox = [number, number, number, number]; // [west, south, east, north]

export class GeometryError extends Error {}

export const MAX_VERTICES = 5_000;
const MAX_PARTS = 200;

const isPosition = (p: unknown): p is Position =>
    Array.isArray(p) &&
    p.length >= 2 &&
    typeof p[0] === "number" &&
    typeof p[1] === "number" &&
    Number.isFinite(p[0]) &&
    Number.isFinite(p[1]) &&
    Math.abs(p[0]) <= 180 &&
    Math.abs(p[1]) <= 90;

const position = (p: unknown): Position => {
    if (!isPosition(p)) throw new GeometryError("A coordinate is missing or out of range");
    // Six decimals is about 0.1 m: more is noise and size.
    return [Math.round(p[0] * 1e6) / 1e6, Math.round(p[1] * 1e6) / 1e6];
};

/** Evenly thins a ring or line to at most `max` positions, keeping the first and last. */
export function thin(points: Position[], max: number): Position[] {
    if (points.length <= max) return points;
    const step = (points.length - 1) / (max - 1);
    const out: Position[] = [];
    for (let i = 0; i < max - 1; i++) out.push(points[Math.round(i * step)]);
    out.push(points[points.length - 1]);
    return out;
}

const ring = (r: unknown, budget: number): Position[] => {
    if (!Array.isArray(r) || r.length < 4) throw new GeometryError("A polygon ring needs at least four positions");
    const pts = thin(r.map(position), Math.max(4, budget));
    const [a, b] = [pts[0], pts[pts.length - 1]];
    if (a[0] !== b[0] || a[1] !== b[1]) pts.push(a);
    return pts;
};

const countVertices = (g: unknown, depth = 0): number => {
    if (depth > 6) throw new GeometryError("Geometry nested too deeply");
    if (!g || typeof g !== "object") return 0;
    const geo = g as { type?: string; coordinates?: unknown; geometries?: unknown[] };
    if (geo.type === "GeometryCollection") return (geo.geometries ?? []).reduce<number>((n, c) => n + countVertices(c, depth + 1), 0);
    const flat = (x: unknown): number => (isPosition(x) ? 1 : Array.isArray(x) ? x.reduce<number>((n, y) => n + flat(y), 0) : 0);
    return flat(geo.coordinates);
};

/**
 * Validates GeoJSON geometry and brings it within the vertex budget. Returns null for "no
 * geometry". Throws GeometryError for anything malformed, so a record with broken geometry is
 * kept without a shape rather than drawn wrongly.
 */
export function cleanGeometry(input: unknown, maxVertices = MAX_VERTICES, depth = 0): Geometry | null {
    if (input === null || input === undefined) return null;
    if (typeof input !== "object") throw new GeometryError("Geometry must be an object");
    if (depth > 3) throw new GeometryError("Geometry nested too deeply");
    const g = input as { type?: unknown; coordinates?: unknown; geometries?: unknown };
    const total = Math.max(1, countVertices(g));
    // Each part gets a share of the budget in proportion to its size.
    const share = (part: unknown) => Math.max(4, Math.floor((maxVertices * countVertices(part)) / total));
    switch (g.type) {
        case "Point":
            return { type: "Point", coordinates: position(g.coordinates) };
        case "MultiPoint":
            if (!Array.isArray(g.coordinates) || !g.coordinates.length) throw new GeometryError("Empty MultiPoint");
            return { type: "MultiPoint", coordinates: thin(g.coordinates.map(position), maxVertices) };
        case "LineString":
            if (!Array.isArray(g.coordinates) || g.coordinates.length < 2) throw new GeometryError("A line needs two positions");
            return { type: "LineString", coordinates: thin(g.coordinates.map(position), maxVertices) };
        case "MultiLineString":
            if (!Array.isArray(g.coordinates) || !g.coordinates.length || g.coordinates.length > MAX_PARTS) throw new GeometryError("Bad MultiLineString");
            return {
                type: "MultiLineString",
                coordinates: g.coordinates.map((l) => {
                    if (!Array.isArray(l) || l.length < 2) throw new GeometryError("A line needs two positions");
                    return thin(l.map(position), share(l));
                }),
            };
        case "Polygon":
            if (!Array.isArray(g.coordinates) || !g.coordinates.length || g.coordinates.length > MAX_PARTS) throw new GeometryError("Bad Polygon");
            return { type: "Polygon", coordinates: g.coordinates.map((r) => ring(r, share(r))) };
        case "MultiPolygon":
            if (!Array.isArray(g.coordinates) || !g.coordinates.length || g.coordinates.length > MAX_PARTS) throw new GeometryError("Bad MultiPolygon");
            return {
                type: "MultiPolygon",
                coordinates: g.coordinates.map((p) => {
                    if (!Array.isArray(p) || !p.length || p.length > MAX_PARTS) throw new GeometryError("Bad polygon");
                    return p.map((r) => ring(r, share(r)));
                }),
            };
        case "GeometryCollection": {
            if (!Array.isArray(g.geometries) || g.geometries.length > MAX_PARTS) throw new GeometryError("Bad GeometryCollection");
            const parts = g.geometries.map((c) => cleanGeometry(c, share(c), depth + 1)).filter((c): c is Geometry => !!c);
            return parts.length ? { type: "GeometryCollection", geometries: parts } : null;
        }
        default:
            throw new GeometryError("Unsupported geometry type");
    }
}

export function* positions(g: Geometry): Generator<Position> {
    switch (g.type) {
        case "Point":
            yield g.coordinates;
            break;
        case "MultiPoint":
        case "LineString":
            yield* g.coordinates;
            break;
        case "MultiLineString":
        case "Polygon":
            for (const l of g.coordinates) yield* l;
            break;
        case "MultiPolygon":
            for (const p of g.coordinates) for (const r of p) yield* r;
            break;
        case "GeometryCollection":
            for (const c of g.geometries) yield* positions(c);
    }
}

export function bboxOf(g: Geometry): BBox {
    let [w, s, e, n] = [180, 90, -180, -90];
    for (const [x, y] of positions(g)) {
        w = Math.min(w, x);
        s = Math.min(s, y);
        e = Math.max(e, x);
        n = Math.max(n, y);
    }
    return [w, s, e, n];
}

/** Areas only (the parts of a collection that are polygons). */
export function polygonsOf(g: Geometry): Position[][][] {
    if (g.type === "Polygon") return [g.coordinates];
    if (g.type === "MultiPolygon") return g.coordinates;
    if (g.type === "GeometryCollection") return g.geometries.flatMap(polygonsOf);
    return [];
}

export const hasArea = (g: Geometry | null) => !!g && polygonsOf(g).length > 0;

/** The first point a provider published (RFS puts the incident point first in its collection). */
export function firstPoint(g: Geometry): Position | null {
    if (g.type === "Point") return g.coordinates;
    if (g.type === "GeometryCollection") {
        for (const c of g.geometries) {
            const p = firstPoint(c);
            if (p) return p;
        }
    }
    return null;
}

const R = 6371.0088;
const rad = (d: number) => (d * Math.PI) / 180;

export function distanceKm(a: Position, b: Position): number {
    const dLat = rad(b[1] - a[1]);
    const dLon = rad(b[0] - a[0]);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function pointInRing(p: Position, r: Position[]): boolean {
    let inside = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const [xi, yi] = r[i];
        const [xj, yj] = r[j];
        if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi || 1e-12) + xi) inside = !inside;
    }
    return inside;
}

/** Inside the outer ring and not in a hole. */
export const pointInPolygon = (p: Position, poly: Position[][]) => pointInRing(p, poly[0]) && !poly.slice(1).some((hole) => pointInRing(p, hole));

/** Distance from a point to a segment, in km (equirectangular projection around the point; fine at these scales). */
export function distanceToSegmentKm(p: Position, a: Position, b: Position): number {
    const k = Math.cos(rad(p[1]));
    const [px, py] = [p[0] * k, p[1]];
    const [ax, ay] = [a[0] * k, a[1]];
    const [bx, by] = [b[0] * k, b[1]];
    const dx = bx - ax;
    const dy = by - ay;
    const t = dx || dy ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy))) : 0;
    return distanceKm(p, [(ax + t * dx) / k, ay + t * dy]);
}

export function distanceToLineKm(p: Position, line: Position[]): number {
    let best = Infinity;
    for (let i = 1; i < line.length; i++) best = Math.min(best, distanceToSegmentKm(p, line[i - 1], line[i]));
    return line.length === 1 ? distanceKm(p, line[0]) : best;
}

/** Shortest distance from a point to an area's edge, 0 inside it. */
export function distanceToAreaKm(p: Position, g: Geometry): number {
    const polys = polygonsOf(g);
    if (polys.some((poly) => pointInPolygon(p, poly))) return 0;
    let best = Infinity;
    for (const poly of polys) for (const r of poly) best = Math.min(best, distanceToLineKm(p, r));
    for (const q of positions(g)) if (!polys.length) best = Math.min(best, distanceKm(p, q));
    return best;
}

export const bboxIntersects = (a: BBox, b: BBox) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

/** Grows a bounding box by `km` in every direction. */
export function expandBBox(b: BBox, km: number): BBox {
    const dLat = km / 111.32;
    const midLat = (b[1] + b[3]) / 2;
    const dLon = km / (111.32 * Math.max(0.1, Math.cos(rad(midLat))));
    return [Math.max(-180, b[0] - dLon), Math.max(-90, b[1] - dLat), Math.min(180, b[2] + dLon), Math.min(90, b[3] + dLat)];
}

/** Rounds a frame outwards to `step` degrees, so a display's framing never pinpoints a place. */
export const coarseBBox = (b: BBox, step = 0.1): BBox =>
    [Math.floor(b[0] / step) * step, Math.floor(b[1] / step) * step, Math.ceil(b[2] / step) * step, Math.ceil(b[3] / step) * step].map(
        (v) => Math.round(v * 1000) / 1000,
    ) as BBox;

/** NSW and the ACT, with a margin: the default frame and the bounding box for national feeds. */
export const NSW_BBOX: BBox = [140.9, -37.6, 153.7, -28.1];
