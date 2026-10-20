// Geoscience Australia: earthquakes (last seven days) and DEA Hotspots (satellite thermal
// detections, last three days, NSW). Both CC BY 4.0. Historical earthquakes are labelled with their
// age; hotspots are detections, not confirmed fires and not fire boundaries.
import { NSW_BBOX } from "../geo";
import { FetchFailure, parseJsonBytes, safeFetch } from "../net";
import { type Adapter, type ParsedRecord, clip, finite, isoInstant, metric, metrics, safeLink, sha256Hex } from "./types";

type Feature = { id?: unknown; geometry?: { type?: string; coordinates?: unknown }; properties?: Record<string, unknown> };

const featureCollection = (bytes: Uint8Array, max: number): Feature[] => {
    const data = parseJsonBytes(bytes) as { type?: unknown; features?: unknown };
    if (data?.type !== "FeatureCollection" || !Array.isArray(data.features))
        throw new FetchFailure("validation", "Expected a GeoJSON FeatureCollection", null, false);
    if (data.features.length > max) throw new FetchFailure("too_large", "More features than this source's limit", null, false);
    return data.features as Feature[];
};

const pointOf = (f: Feature): [number, number] | null => {
    const c = f.geometry?.type === "Point" && Array.isArray(f.geometry.coordinates) ? f.geometry.coordinates : null;
    const lon = finite(c?.[0]);
    const lat = finite(c?.[1]);
    return lon !== null && lat !== null && Math.abs(lon) <= 180 && Math.abs(lat) <= 90 ? [lon, lat] : null;
};

const GA_HOSTS = ["earthquakes.ga.gov.au"] as const;

export const gaEarthquakes: Adapter = {
    id: "ga-earthquakes",
    allowedHosts: GA_HOSTS,
    async run(ctx) {
        const query = new URLSearchParams({
            service: "WFS",
            request: "getfeature",
            typeNames: "earthquakes:earthquakes_seven_days",
            outputFormat: "application/json",
        });
        const r = await safeFetch(ctx.transport, `https://earthquakes.ga.gov.au/geoserver/earthquakes/wfs?${query}`, {
            allowedHosts: GA_HOSTS,
            timeoutMs: 20_000,
            maxBytes: 5_000_000,
        });
        const records: ParsedRecord[] = [];
        let newest: string | null = null;
        for (const f of featureCollection(r.bytes, 5_000)) {
            const p = f.properties ?? {};
            const id = clip(p.event_id, 60);
            const point = pointOf(f);
            const origin = isoInstant(p.origin_time) ?? isoInstant(p.epicentral_time);
            if (!id || !point || !origin) continue;
            // Only events GA hasn't hidden.
            if (p.display_flag === "N") continue;
            const magnitude = finite(p.preferred_magnitude);
            const modified = isoInstant(p.event_modification_time);
            if (modified && (!newest || modified > newest)) newest = modified;
            records.push({
                externalId: id,
                kind: "event",
                category: "earthquake",
                eventType: "Earthquake",
                title: `${magnitude !== null ? `M${magnitude.toFixed(1)} ` : ""}${clip(p.description, 200) ?? "Earthquake"}`.slice(0, 300),
                status: clip(p.evaluation_status, 40),
                severityRank: 0,
                point,
                geometryQuality: "point",
                uncertaintyM: finite(p.max_horizontal_uncertainty) !== null ? finite(p.max_horizontal_uncertainty)! * 1000 : null,
                areaName: clip(p.nearby_place1 ?? p.description, 300),
                observedAt: origin,
                publishedAt: isoInstant(p.event_creation_time),
                updatedAt: modified,
                sourceUrl: `https://earthquakes.ga.gov.au/event/${encodeURIComponent(id)}`,
                metrics: metrics(
                    metric("magnitude", `Magnitude (${clip(p.preferred_magnitude_type, 10) ?? "preferred"})`, magnitude, ""),
                    metric("depth_km", "Depth", p.depth, "km"),
                ),
                attrs: Object.fromEntries(
                    [
                        ["inAustralia", p.located_in_australia === "Y" ? "yes" : "no"],
                        ["evaluationMode", clip(p.evaluation_mode, 20)],
                        ["feltReport", safeLink(p.felt_report_url)],
                    ].filter((e): e is [string, string] => !!e[1]),
                ),
            });
        }
        return {
            records,
            // A seven-day window: an event leaving it has aged out, not "resolved".
            complete: true,
            publishedAt: newest,
            bytes: r.bytes.byteLength,
            httpStatus: r.status,
            contentHash: await sha256Hex(r.bytes),
            snapshot: r.bytes,
        };
    },
};

const DEA_HOSTS = ["hotspots.dea.ga.gov.au"] as const;
export const MAX_HOTSPOTS = 3_000;

export const deaHotspots: Adapter = {
    id: "dea-hotspots",
    allowedHosts: DEA_HOSTS,
    async run(ctx) {
        const [w, s, e, n] = NSW_BBOX;
        const query = new URLSearchParams({
            service: "WFS",
            version: "1.0.0",
            request: "GetFeature",
            typeName: "public:hotspots_three_days",
            outputFormat: "application/json",
            maxFeatures: String(MAX_HOTSPOTS),
            bbox: `${w},${s},${e},${n}`,
        });
        const r = await safeFetch(ctx.transport, `https://hotspots.dea.ga.gov.au/geoserver/public/wfs?${query}`, {
            allowedHosts: DEA_HOSTS,
            timeoutMs: 30_000,
            maxBytes: 12_000_000,
        });
        const features = featureCollection(r.bytes, MAX_HOTSPOTS);
        const records: ParsedRecord[] = [];
        let newest: string | null = null;
        for (const f of features) {
            const p = f.properties ?? {};
            const id = clip(p.id ?? f.id, 80);
            const point = pointOf(f);
            const at = isoInstant(p.datetime) ?? isoInstant(p.start_dt);
            if (!id || !point || !at) continue;
            if (!newest || at > newest) newest = at;
            const accuracy = /([\d.]+)\s*km/i.exec(String(p.accuracy ?? ""))?.[1];
            records.push({
                externalId: `hotspot-${id}`,
                kind: "detection",
                category: "hotspot",
                eventType: "Satellite thermal detection",
                title: `Thermal detection (${clip(p.satellite, 30) ?? "satellite"} ${clip(p.sensor, 20) ?? ""})`.replace(/\s+\)/, ")").slice(0, 300),
                point,
                geometryQuality: "point",
                uncertaintyM: accuracy ? Number(accuracy) * 1000 : null,
                observedAt: at,
                publishedAt: isoInstant(p.load_dt),
                sourceUrl: "https://hotspots.dea.ga.gov.au/",
                metrics: metrics(
                    metric("confidence", "Confidence", p.confidence, "%"),
                    metric("temp_kelvin", "Brightness temperature", p.temp_kelvin, "K"),
                    metric("power", "Fire radiative power", p.power, "MW"),
                ),
                attrs: Object.fromEntries(
                    [
                        ["satellite", clip(p.satellite, 40)],
                        ["sensor", clip(p.sensor, 20)],
                        ["product", clip(p.product, 40)],
                        ["accuracy", clip(p.accuracy, 20)],
                        ["state", clip(p.australian_state, 10)],
                    ].filter((e): e is [string, string] => !!e[1]),
                ),
            });
        }
        return {
            records,
            // A capped response isn't the whole set: then nothing is treated as gone.
            complete: features.length < MAX_HOTSPOTS,
            publishedAt: newest,
            bytes: r.bytes.byteLength,
            httpStatus: r.status,
            contentHash: await sha256Hex(r.bytes),
        };
    },
};
