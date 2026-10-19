// Sources that need a free key the owner registers for: Transport for NSW Live Traffic hazards and
// NASA FIRMS. The key is a Worker secret (TFNSW_API_KEY, NASA_FIRMS_MAP_KEY), sent only to its own
// provider, never logged, stored or shown. Without one, the source says "Needs free registration".
//
// Neither has been tested against the live service (no key was available while building this), so
// both parse defensively and refuse anything that doesn't look like the documented shape.
import { NSW_BBOX } from "../geo";
import { FetchFailure, decodeText, parseJsonBytes, safeFetch } from "../net";
import { plainText } from "../xml";
import { type Adapter, type ParsedRecord, clip, finite, isoInstant, metric, metrics, sha256Hex, titleCase } from "./types";

// --- Transport for NSW Live Traffic ------------------------------------------------------------

const TFNSW_HOSTS = ["api.transport.nsw.gov.au"] as const;
export const TFNSW_TYPES = ["incident", "roadwork", "flood", "fire", "majorevent"] as const;

interface HazardProperties {
    headline?: unknown;
    displayName?: unknown;
    mainCategory?: unknown;
    subCategoryA?: unknown;
    created?: unknown;
    lastUpdated?: unknown;
    isEnded?: unknown;
    isMajor?: unknown;
    adviceA?: unknown;
    adviceB?: unknown;
    otherAdvice?: unknown;
    roads?: { mainStreet?: unknown; suburb?: unknown; region?: unknown; crossStreet?: unknown }[];
    impactingNetwork?: unknown;
    diversions?: unknown;
}

/** Live Traffic times are epoch milliseconds. */
const epoch = (value: unknown): string | null => {
    const n = finite(value);
    return n !== null && n > 1e12 && n < 4e12 ? new Date(n).toISOString() : isoInstant(value);
};

export const tfnswLiveTraffic: Adapter = {
    id: "tfnsw-live-traffic",
    allowedHosts: TFNSW_HOSTS,
    async run(ctx) {
        if (!ctx.secret) throw new FetchFailure("credentials_missing", "Add a Transport for NSW Open Data key (TFNSW_API_KEY) to switch this on", null, false);
        const records: ParsedRecord[] = [];
        let bytes = 0;
        let status = 200;
        let newest: string | null = null;
        const raw: Uint8Array[] = [];
        for (const type of TFNSW_TYPES) {
            const r = await safeFetch(ctx.transport, `https://api.transport.nsw.gov.au/v1/live/hazards/${type}/open`, {
                allowedHosts: TFNSW_HOSTS,
                timeoutMs: 20_000,
                maxBytes: 6_000_000,
                headers: { Authorization: `apikey ${ctx.secret}`, Accept: "application/json" },
            });
            bytes += r.bytes.byteLength;
            status = r.status;
            raw.push(r.bytes);
            const data = parseJsonBytes(r.bytes) as { type?: unknown; features?: unknown };
            if (data?.type !== "FeatureCollection" || !Array.isArray(data.features))
                throw new FetchFailure("validation", `Unexpected ${type} response shape`, null, false);
            for (const f of (data.features as { id?: unknown; geometry?: { type?: string; coordinates?: unknown }; properties?: HazardProperties }[]).slice(
                0,
                3000,
            )) {
                const p = f.properties ?? {};
                const id = clip(f.id, 80);
                const c = f.geometry?.type === "Point" && Array.isArray(f.geometry.coordinates) ? f.geometry.coordinates : null;
                const lon = finite(c?.[0]);
                const lat = finite(c?.[1]);
                if (!id) continue;
                const road = Array.isArray(p.roads) ? p.roads[0] : undefined;
                const where = [clip(road?.mainStreet, 120), clip(road?.suburb, 80)].filter(Boolean).join(", ") || null;
                const updated = epoch(p.lastUpdated);
                if (updated && (!newest || updated > newest)) newest = updated;
                const headline = clip(p.headline, 300) ?? clip(p.displayName, 300) ?? `${titleCase(type)} hazard`;
                const closure = /closed|closure/i.test(`${headline} ${p.adviceA ?? ""} ${p.adviceB ?? ""}`);
                records.push({
                    externalId: `${type}-${id}`,
                    kind: "disruption",
                    category: "transport",
                    eventType: clip(p.mainCategory, 120) ?? titleCase(type),
                    title: headline,
                    description: plainText(
                        [p.adviceA, p.adviceB, p.otherAdvice]
                            .map((x) => clip(x, 800))
                            .filter(Boolean)
                            .join("\n"),
                    ),
                    status: closure ? "Road closed (as published)" : clip(p.subCategoryA, 120),
                    point: lon !== null && lat !== null && Math.abs(lon) <= 180 && Math.abs(lat) <= 90 ? [lon, lat] : null,
                    geometryQuality: lon !== null && lat !== null ? "point" : "none",
                    areaName: where,
                    publishedAt: epoch(p.created),
                    updatedAt: updated,
                    sourceUrl: "https://www.livetraffic.com/",
                    attrs: Object.fromEntries(
                        [
                            ["hazardType", type],
                            ["major", p.isMajor === true ? "yes" : null],
                            ["closure", closure ? "yes" : null],
                            ["region", clip(road?.region, 60)],
                        ].filter((e): e is [string, string] => !!e[1]),
                    ),
                    ended: p.isEnded === true,
                });
            }
        }
        return {
            records,
            complete: true,
            publishedAt: newest,
            bytes,
            httpStatus: status,
            contentHash: await sha256Hex(raw.map((b) => decodeText(b)).join("\n")),
        };
    },
};

// --- NASA FIRMS --------------------------------------------------------------------------------

const FIRMS_HOSTS = ["firms.modaps.eosdis.nasa.gov"] as const;
const FIRMS_SOURCE = "VIIRS_SNPP_NRT";

/** Parses FIRMS area CSV (no quoted fields in this product). */
export function parseFirmsCsv(text: string): Record<string, string>[] {
    const lines = text.trim().split(/\r?\n/);
    const header = lines.shift()?.split(",") ?? [];
    if (!header.includes("latitude") || !header.includes("longitude"))
        throw new FetchFailure("validation", text.slice(0, 60).includes("Invalid") ? "The FIRMS key was refused" : "Unexpected FIRMS response", null, false);
    return lines.slice(0, 5000).map((line) => Object.fromEntries(line.split(",").map((v, i) => [header[i], v])));
}

export const nasaFirms: Adapter = {
    id: "nasa-firms",
    allowedHosts: FIRMS_HOSTS,
    async run(ctx) {
        if (!ctx.secret) throw new FetchFailure("credentials_missing", "Add a NASA FIRMS MAP_KEY (NASA_FIRMS_MAP_KEY) to switch this on", null, false);
        if (!/^[A-Za-z0-9]{8,64}$/.test(ctx.secret)) throw new FetchFailure("credentials_rejected", "The FIRMS key doesn't look like a MAP_KEY", null, false);
        const [w, s, e, n] = NSW_BBOX;
        const r = await safeFetch(ctx.transport, `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${ctx.secret}/${FIRMS_SOURCE}/${w},${s},${e},${n}/1`, {
            allowedHosts: FIRMS_HOSTS,
            timeoutMs: 30_000,
            maxBytes: 6_000_000,
        });
        const rows = parseFirmsCsv(decodeText(r.bytes));
        const records: ParsedRecord[] = [];
        let newest: string | null = null;
        for (const row of rows) {
            const lat = finite(row.latitude);
            const lon = finite(row.longitude);
            const date = row.acq_date;
            const time = (row.acq_time ?? "").padStart(4, "0");
            if (lat === null || lon === null || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? "") || !/^\d{4}$/.test(time)) continue;
            const at = `${date}T${time.slice(0, 2)}:${time.slice(2)}:00.000Z`;
            if (!newest || at > newest) newest = at;
            records.push({
                externalId: `firms-${row.satellite ?? "x"}-${date}-${time}-${lat.toFixed(4)}-${lon.toFixed(4)}`,
                kind: "detection",
                category: "hotspot",
                eventType: "Satellite thermal detection",
                title: `Thermal detection (${clip(row.satellite, 10) ?? "VIIRS"} ${clip(row.instrument, 10) ?? ""})`.replace(/\s+\)/, ")"),
                point: [lon, lat],
                geometryQuality: "point",
                // VIIRS I-band pixels are about 375 m at nadir, larger off-nadir (scan × track).
                uncertaintyM: (finite(row.scan) ?? 0.375) * 1000,
                observedAt: at,
                sourceUrl: "https://firms.modaps.eosdis.nasa.gov/map/",
                metrics: metrics(metric("frp", "Fire radiative power", row.frp, "MW"), metric("bright_ti4", "Brightness (I4)", row.bright_ti4, "K")),
                attrs: Object.fromEntries(
                    [
                        ["confidence", clip(row.confidence, 10)],
                        ["satellite", clip(row.satellite, 10)],
                        ["dayNight", clip(row.daynight, 2)],
                    ].filter((e): e is [string, string] => !!e[1]),
                ),
            });
        }
        return { records, complete: true, publishedAt: newest, bytes: r.bytes.byteLength, httpStatus: r.status, contentHash: await sha256Hex(r.bytes) };
    },
};
