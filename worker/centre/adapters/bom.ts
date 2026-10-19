// Bureau of Meteorology: warnings and observations from the anonymous FTP service, and river
// levels from Water Data Online (SOS 2.0). The website itself refuses automated access and points
// automated users here; it is never scraped. Default terms: personal or in-house use, no supply to
// others, so these sources are "awaiting verification" until the owner confirms the use fits.
//
// Warnings are text with BoM forecast-district codes (NSW_PW…, NSW_MW…). No warning polygon is
// drawn, because none is published here. Observations carry the station's own observation time.
import { FetchFailure, decodeText, safeFetch } from "../net";
import { type XmlElement, XmlError, child, children, descendants, parseXml, plainText, textOf } from "../xml";
import { type Adapter, type ParsedRecord, type SeriesPoint, clip, finite, isoInstant, metric, metrics, sha256Hex } from "./types";

const FTP_HOST = "ftp.bom.gov.au";
const FWO = "/anon/gen/fwo";

const xml = (bytes: Uint8Array) => {
    try {
        return parseXml(decodeText(bytes));
    } catch (error) {
        if (error instanceof XmlError) throw new FetchFailure("parse_error", `A BoM product isn't valid XML: ${error.message}`, null, false);
        throw error;
    }
};

// --- Warnings ------------------------------------------------------------------------------------

/** Classification and change cursor, per product: { IDN21033: { type: "W", modified: "…" } }. */
type ProductState = Record<string, { type: string; modified: string }>;
const MAX_DOWNLOADS = 80;

const SERVICE_LABELS: Record<string, string> = {
    WSM: "Marine warning",
    WSF: "Weather warning",
    WSP: "Public weather",
    WSH: "Hydrology (flood)",
    WSA: "Aviation",
};

export function parseAmoc(root: XmlElement, now: Date): ParsedRecord | null {
    if (root.name !== "amoc") return null;
    const identifier = textOf(root, "identifier");
    if (!identifier || textOf(root, "product-type") !== "W") return null;
    const hazards = children(root, "hazard");
    const headlines = hazards.map((h) => textOf(h, "headline")).filter((h): h is string => !!h);
    const areas = hazards.flatMap((h) => descendants(h, "area")).map((a) => ({ aac: a.attrs.aac ?? "", description: a.attrs.description ?? "" }));
    const types = [...new Set(hazards.map((h) => h.attrs.type).filter(Boolean))];
    const service = textOf(root, "service") ?? "";
    const phase = textOf(root, "phase") ?? hazards[0]?.attrs.phase ?? null;
    const issued = isoInstant(textOf(root, "issue-time-utc"));
    const expiry = isoInstant(textOf(root, "expiry-time"));
    const title = (headlines[0] ?? `${SERVICE_LABELS[service] ?? "Warning"} ${identifier}`).slice(0, 300);
    const flood = service === "WSH" || /flood/i.test(title) || types.some((t) => /^FL/i.test(t));
    const floodClass = /\b(minor|moderate|major)\b[^.]*flood/i.exec(title)?.[1];
    return {
        externalId: identifier,
        kind: "warning",
        category: flood ? "flood" : "weather",
        eventType: SERVICE_LABELS[service] ?? service ?? null,
        title,
        description: plainText(headlines.join("\n"), 2000),
        status: phase,
        // BoM warnings carry no Australian Warning System level in this product; none is assigned.
        warningLevel: null,
        severityRank: 1,
        geometryQuality: "area_text",
        areaName: clip(
            areas
                .map((a) => a.description)
                .filter(Boolean)
                .join("; "),
            300,
        ),
        publishedAt: issued,
        updatedAt: issued,
        sourceUrl: `https://www.bom.gov.au/products/${identifier}.shtml`,
        attrs: Object.fromEntries(
            [
                ["product", identifier],
                ["service", service],
                ["hazardTypes", types.join(",")],
                [
                    "districts",
                    areas
                        .map((a) => a.aac)
                        .filter(Boolean)
                        .join(",")
                        .slice(0, 600),
                ],
                ["severity", hazards[0]?.attrs.severity],
                ["urgency", hazards[0]?.attrs.urgency],
                ["certainty", hazards[0]?.attrs.certainty],
                ["expires", expiry],
                ["floodClass", floodClass ? floodClass[0].toUpperCase() + floodClass.slice(1).toLowerCase() : undefined],
            ].filter((e): e is [string, string] => !!e[1]),
        ),
        // The Bureau marks a cancelled warning CAN; an expired one has passed its own expiry time.
        ended: phase === "CAN" || (!!expiry && Date.parse(expiry) < now.getTime()),
    };
}

export const bomWarnings: Adapter = {
    id: "bom-warnings",
    allowedHosts: [FTP_HOST],
    async run(ctx) {
        const listing = await ctx.transport.ftp.list(FTP_HOST, FWO, "IDN*.amoc.xml");
        if (listing.length > 1000) throw new FetchFailure("too_large", "Unexpected listing size", null, false);
        const previous = (ctx.state.products ?? {}) as ProductState;
        const products: ProductState = {};
        const records: ParsedRecord[] = [];
        const keep: string[] = [];
        let bytes = 0;
        const due: { id: string; name: string; modified: string }[] = [];
        for (const entry of listing) {
            const id = /^(ID[A-Z]\d{5})\.amoc\.xml$/.exec(entry.name)?.[1];
            if (!id) continue;
            const known = previous[id];
            if (known && known.modified === entry.modified) {
                products[id] = known;
                if (known.type === "W") keep.push(id);
            } else if (due.length < MAX_DOWNLOADS) due.push({ id, name: entry.name, modified: entry.modified });
            else if (known) {
                // Past this run's limit: kept as it was until the next run.
                products[id] = known;
                if (known.type === "W") keep.push(id);
            }
        }
        // The amoc sidecars are small (about 1 KB) and say whether a product is a warning, so only they are read.
        const files = await ctx.transport.ftp.retrieveMany(
            FTP_HOST,
            due.map((d) => `${FWO}/${d.name}`),
            200_000,
        );
        for (const d of due) {
            const file = files.get(`${FWO}/${d.name}`);
            if (!file) continue;
            bytes += file.byteLength;
            const root = xml(file);
            const type = textOf(root, "product-type") ?? "?";
            products[d.id] = { type, modified: d.modified };
            const record = type === "W" ? parseAmoc(root, ctx.now) : null;
            if (record) records.push(record);
        }
        const downloads = due.length;
        // Products past the download limit this run keep their previous record until next time.
        return {
            records,
            keep,
            // The listing is the whole current set, so a warning product that disappears is "no longer in the feed".
            complete: downloads < MAX_DOWNLOADS || Object.keys(previous).length > 0,
            publishedAt: null,
            state: { products },
            bytes,
            httpStatus: null,
            contentHash: await sha256Hex(JSON.stringify(listing.map((e) => [e.name, e.modified]))),
        };
    },
};

// --- Observations (IDN60920) ---------------------------------------------------------------------

const element = (level: XmlElement | undefined, type: string) => level?.children.find((c) => c.name === "element" && c.attrs.type === type);
const value = (level: XmlElement | undefined, type: string) => finite(element(level, type)?.text);

export function parseObservations(root: XmlElement): { records: ParsedRecord[]; series: SeriesPoint[]; issued: string | null } {
    const observations = child(root, "observations");
    if (root.name !== "product" || !observations) throw new FetchFailure("validation", "Expected a BoM observations product", null, false);
    const issued = isoInstant(textOf(child(root, "amoc"), "issue-time-utc"));
    const records: ParsedRecord[] = [];
    const series: SeriesPoint[] = [];
    for (const station of children(observations, "station").slice(0, 1000)) {
        const id = station.attrs["bom-id"] || station.attrs["wmo-id"];
        const lat = finite(station.attrs.lat);
        const lon = finite(station.attrs.lon);
        const period = child(station, "period");
        const level = child(period, "level");
        const observedAt = isoInstant(period?.attrs["time-utc"]);
        if (!id || lat === null || lon === null || !observedAt) continue;
        const temp = value(level, "air_temperature");
        const gust = value(level, "gust_kmh");
        const rain = value(level, "rainfall");
        const ms = metrics(
            metric("air_temperature", "Temperature", temp, "°C"),
            metric("apparent_temp", "Feels like", value(level, "apparent_temp"), "°C"),
            metric("rel_humidity", "Humidity", value(level, "rel-humidity"), "%"),
            metric("wind_spd_kmh", "Wind", value(level, "wind_spd_kmh"), "km/h"),
            metric("gust_kmh", "Gusts", gust, "km/h"),
            metric("msl_pres", "Pressure", value(level, "msl_pres"), "hPa"),
            metric("rainfall", "Rain since 9 am", rain, "mm"),
        );
        const name = station.attrs.description || station.attrs["stn-name"] || id;
        records.push({
            externalId: `station-${id}`,
            kind: "observation",
            category: "weather",
            eventType: "Weather observation",
            title: name.slice(0, 300),
            geometryQuality: "point",
            point: [lon, lat],
            observedAt,
            publishedAt: issued,
            sourceUrl: station.attrs["wmo-id"] ? `https://www.bom.gov.au/products/IDN60901/IDN60901.${station.attrs["wmo-id"]}.shtml` : null,
            metrics: ms,
            attrs: Object.fromEntries(
                [
                    ["windDir", clip(element(level, "wind_dir")?.text, 10)],
                    ["district", clip(station.attrs["forecast-district-id"], 20)],
                    ["stationType", clip(station.attrs.type, 20)],
                ].filter((e): e is [string, string] => !!e[1]),
            ),
        });
        for (const [m, v] of [
            ["air_temperature", temp],
            ["gust_kmh", gust],
            ["rainfall", rain],
        ] as const)
            if (v !== null) series.push({ externalId: `station-${id}`, metric: m, at: observedAt, value: v });
    }
    return { records, series, issued };
}

export const bomObservations: Adapter = {
    id: "bom-observations",
    allowedHosts: [FTP_HOST],
    async run(ctx) {
        const [entry] = await ctx.transport.ftp.list(FTP_HOST, FWO, "IDN60920.xml");
        if (!entry) throw new FetchFailure("http_error", "The observations product isn't on the FTP service", 404, true);
        if (ctx.state.modified === entry.modified)
            return { records: [], complete: false, publishedAt: null, bytes: 0, httpStatus: null, notModified: true, state: ctx.state };
        const file = await ctx.transport.ftp.retrieve(FTP_HOST, `${FWO}/IDN60920.xml`, 2_500_000);
        const { records, series, issued } = parseObservations(xml(file));
        return {
            records,
            series,
            complete: true,
            publishedAt: issued,
            state: { modified: entry.modified },
            bytes: file.byteLength,
            httpStatus: null,
            contentHash: await sha256Hex(file),
        };
    },
};

// --- Water Data Online (SOS 2.0) -----------------------------------------------------------------

const WDO_HOSTS = ["www.bom.gov.au"] as const;
const WDO = "https://www.bom.gov.au/waterdata/services";
const STATION = (s: string) => `http://bom.gov.au/waterdata/services/stations/${s}`;
/** "DMQaQc.Merged.AsStored.1": the quality-coded merged series. */
const PROCEDURE = "http://bom.gov.au/waterdata/services/tstypes/Pat3_C_B_1";
const LEVEL = "http://bom.gov.au/waterdata/services/parameters/Water Course Level";

export function parseWaterMl(root: XmlElement): {
    station: string | null;
    name: string | null;
    unit: string | null;
    points: { at: string; value: number; quality: string | null }[];
} {
    const observation = descendants(root, "OM_Observation")[0];
    const foi = observation ? child(observation, "featureOfInterest") : undefined;
    const href = foi?.attrs.href ?? null;
    const unit = descendants(root, "uom")[0]?.attrs.code ?? null;
    const points = descendants(root, "MeasurementTVP")
        .slice(-2000)
        .map((p): { at: string | null; value: number | null; quality: string | null } => ({
            at: isoInstant(textOf(p, "time")),
            value: finite(textOf(p, "value")),
            quality: descendants(p, "qualifier")[0]?.attrs.title ?? descendants(p, "qualifier")[0]?.attrs.href ?? null,
        }))
        .filter((p): p is { at: string; value: number; quality: string | null } => !!p.at && p.value !== null);
    return { station: href?.split("/").pop() ?? null, name: foi?.attrs.title ?? null, unit, points };
}

export function parseFeatureOfInterest(root: XmlElement): { lat: number; lon: number } | null {
    const pos = descendants(root, "pos")[0]?.text.trim().split(/\s+/).map(Number);
    if (!pos || pos.length < 2 || !pos.every(Number.isFinite)) return null;
    const [lat, lon] = pos;
    return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}

export const bomWater: Adapter = {
    id: "bom-water",
    allowedHosts: WDO_HOSTS,
    async run(ctx) {
        const gauges = ctx.settings.gauges.slice(0, 20);
        const places = (ctx.state.places ?? {}) as Record<string, { lat: number; lon: number } | null>;
        const records: ParsedRecord[] = [];
        const series: SeriesPoint[] = [];
        let bytes = 0;
        const from = new Date(ctx.now.getTime() - 7 * 86_400_000).toISOString().slice(0, 19);
        const to = ctx.now.toISOString().slice(0, 19);
        for (const station of gauges) {
            const get = async (query: Record<string, string>) => {
                const r = await safeFetch(ctx.transport, `${WDO}?${new URLSearchParams({ service: "SOS", version: "2.0", ...query })}`, {
                    allowedHosts: WDO_HOSTS,
                    timeoutMs: 30_000,
                    maxBytes: 3_000_000,
                });
                bytes += r.bytes.byteLength;
                return xml(r.bytes);
            };
            if (!(station in places)) {
                places[station] = parseFeatureOfInterest(await get({ request: "GetFeatureOfInterest", featureOfInterest: STATION(station) }));
            }
            const parsed = parseWaterMl(
                await get({
                    request: "GetObservation",
                    featureOfInterest: STATION(station),
                    observedProperty: LEVEL,
                    procedure: PROCEDURE,
                    temporalFilter: `om:phenomenonTime,${from}Z/${to}Z`,
                }),
            );
            const place = places[station];
            const last = parsed.points[parsed.points.length - 1];
            records.push({
                externalId: `gauge-${station}`,
                kind: "observation",
                category: "water",
                eventType: "River level",
                title: (parsed.name ?? `Station ${station}`).slice(0, 300),
                description: last ? null : "No measurements in the last seven days in the quality-coded series.",
                geometryQuality: place ? "point" : "none",
                point: place ? [place.lon, place.lat] : null,
                observedAt: last?.at ?? null,
                sourceUrl: `https://www.bom.gov.au/waterdata/`,
                metrics: last ? metrics(metric("water_level", "River level", last.value, parsed.unit ?? "m")) : [],
                attrs: Object.fromEntries(
                    [
                        ["station", station],
                        ["quality", last?.quality ? clip(last.quality.split("/").pop(), 60) : null],
                        ["series", "DMQaQc.Merged.AsStored.1"],
                    ].filter((e): e is [string, string] => !!e[1]),
                ),
            });
            for (const p of parsed.points.filter((_, i, all) => i % Math.max(1, Math.floor(all.length / 400)) === 0 || i === all.length - 1))
                series.push({ externalId: `gauge-${station}`, metric: "water_level", at: p.at, value: p.value });
        }
        return {
            records,
            series,
            complete: true,
            publishedAt: null,
            state: { places },
            bytes,
            httpStatus: 200,
        };
    },
};
