// NSW Rural Fire Service public feeds (https://www.rfs.nsw.gov.au/news-and-media/stay-up-to-date/feeds).
// CC BY 4.0; the RFS attribution is shown with every record. Official wording is kept as
// published; only markup is removed. An incident point is never turned into a perimeter, and an
// incident missing from a later feed is "no longer in the feed", never "out" (unless the RFS's own
// status says Out).
import { WARNING_LEVELS, fireDangerRank, levelRank } from "../../../src/shared/centre/types";
import { type Geometry, GeometryError, type Position, cleanGeometry, firstPoint, hasArea } from "../geo";
import { FetchFailure, decodeText, parseJsonBytes, safeFetch } from "../net";
import { type XmlElement, XmlError, child, children, descendants, parseXml, plainText, textOf } from "../xml";
import {
    type Adapter,
    type AdapterContext,
    type ParsedBatch,
    type ParsedRecord,
    clip,
    finite,
    httpDate,
    isoInstant,
    metric,
    metrics,
    parseDayMonthTime,
    parseDmyTime,
    safeLink,
    sha256Hex,
    titleCase,
} from "./types";

const HOSTS = ["www.rfs.nsw.gov.au"] as const;
const BASE = "https://www.rfs.nsw.gov.au/feeds";

async function get(ctx: AdapterContext, path: string, maxBytes: number) {
    return safeFetch(ctx.transport, `${BASE}/${path}`, { allowedHosts: HOSTS, timeoutMs: 20_000, maxBytes, etag: ctx.etag, lastModified: ctx.lastModified });
}

const unchanged = (r: { status: number; etag: string | null; lastModified: string | null }): ParsedBatch => ({
    records: [],
    complete: false,
    publishedAt: null,
    bytes: 0,
    httpStatus: r.status,
    etag: r.etag,
    lastModified: r.lastModified,
    notModified: true,
});

const xml = (bytes: Uint8Array) => {
    try {
        return parseXml(decodeText(bytes));
    } catch (error) {
        if (error instanceof XmlError) throw new FetchFailure("parse_error", `The feed isn't valid XML: ${error.message}`, null, false);
        throw error;
    }
};

/** "ALERT LEVEL: Advice <br />LOCATION: …" → { "ALERT LEVEL": "Advice", LOCATION: … } */
export function descriptionFields(description: string | null | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    for (const part of (description ?? "").split(/<br\s*\/?>|\n/i)) {
        const m = /^\s*([A-Z][A-Z /]{1,30}):\s*(.*?)\s*$/.exec(plainText(part, 600) ?? "");
        if (m) out[m[1].trim()] = m[2].trim();
    }
    return out;
}

const awsLevel = (value: string | null | undefined): string | null =>
    WARNING_LEVELS.find((l) => l.toLowerCase() === (value ?? "").trim().toLowerCase()) ?? null;

const NON_FIRE_TYPES = /\b(MVA|transport|rescue|medical|search|flood|storm|hazmat|assist|false alarm|investigation)\b/i;

// --- Current incidents (GeoJSON) -------------------------------------------------------------------

export const rfsIncidents: Adapter = {
    id: "rfs-incidents",
    allowedHosts: HOSTS,
    async run(ctx) {
        const r = await get(ctx, "majorIncidents.json", 8_000_000);
        if (r.notModified) return unchanged(r);
        const data = parseJsonBytes(r.bytes) as { type?: unknown; features?: unknown };
        if (data?.type !== "FeatureCollection" || !Array.isArray(data.features))
            throw new FetchFailure("validation", "Expected a GeoJSON FeatureCollection", null, false);
        if (data.features.length > 2_000) throw new FetchFailure("too_large", "More incidents than this source's limit", null, false);
        const records: ParsedRecord[] = [];
        for (const feature of data.features as { geometry?: unknown; properties?: Record<string, unknown> }[]) {
            const p = feature?.properties ?? {};
            const guid = clip(p.guid, 200);
            const title = clip(p.title, 300);
            if (!guid || !title) continue;
            const fields = descriptionFields(typeof p.description === "string" ? p.description : null);
            let geometry: Geometry | null = null;
            try {
                geometry = cleanGeometry(feature.geometry);
            } catch (error) {
                if (!(error instanceof GeometryError)) throw error;
            }
            const point: Position | null = geometry ? firstPoint(geometry) : null;
            const type = fields.TYPE ?? null;
            const isFire = (fields.FIRE ?? "").toLowerCase() === "yes" || (!!type && /fire|burn|hazard reduction/i.test(type) && !NON_FIRE_TYPES.test(type));
            const level = awsLevel(fields["ALERT LEVEL"] ?? (typeof p.category === "string" ? p.category : null));
            const status = fields.STATUS ?? null;
            const size = finite(fields.SIZE?.replace(/[^\d.]/g, ""));
            records.push({
                externalId: guid.replace(/^https?:\/\/incidents\.rfs\.nsw\.gov\.au\/api\/v1\/incidents\//, "incident-"),
                kind: "incident",
                category: isFire ? "fire" : "emergency",
                eventType: type ?? clip(p.category, 120),
                title: titleCase(title),
                description: plainText(typeof p.description === "string" ? p.description : null, 4000),
                status,
                warningLevel: level,
                severityRank: levelRank(level),
                point,
                geometry: geometry && hasArea(geometry) ? geometry : null,
                geometryQuality: geometry && hasArea(geometry) ? "polygon" : point ? "point" : "none",
                areaName: clip(fields.LOCATION, 300),
                publishedAt: parseDmyTime(typeof p.pubDate === "string" ? p.pubDate : null),
                updatedAt: parseDayMonthTime(fields.UPDATED),
                sourceUrl: safeLink(p.link) ?? "https://www.rfs.nsw.gov.au/fire-information/fires-near-me",
                metrics: metrics(size !== null ? metric("size_ha", "Size", size, "ha") : null),
                attrs: Object.fromEntries(
                    [
                        ["council", fields["COUNCIL AREA"]],
                        ["agency", fields["RESPONSIBLE AGENCY"]],
                        ["fire", fields.FIRE],
                        ["feedCategory", clip(p.category, 60)],
                    ].filter((e): e is [string, string] => !!e[1]),
                ),
                ended: (status ?? "").trim().toLowerCase() === "out",
            });
        }
        return {
            records,
            complete: true,
            publishedAt: httpDate(r.lastModified),
            bytes: r.bytes.byteLength,
            httpStatus: r.status,
            etag: r.etag,
            lastModified: r.lastModified,
            contentHash: await sha256Hex(r.bytes),
            snapshot: r.bytes,
        };
    },
};

// --- Fire Danger Ratings and Total Fire Bans -------------------------------------------------------

const rating = (value: string | null) => {
    const v = (value ?? "").trim();
    if (!v || /^none$/i.test(v)) return "No rating";
    return titleCase(v);
};
const yes = (value: string | null) => /^yes$/i.test((value ?? "").trim());

export const rfsFireDanger: Adapter = {
    id: "rfs-fire-danger",
    allowedHosts: HOSTS,
    async run(ctx) {
        const r = await get(ctx, "fdrToban.xml", 500_000);
        if (r.notModified) return unchanged(r);
        const root = xml(r.bytes);
        if (root.name !== "FireDangerMap") throw new FetchFailure("validation", "Expected a FireDangerMap document", null, false);
        const districts = children(root, "District");
        if (!districts.length || districts.length > 100) throw new FetchFailure("validation", "Unexpected number of districts", null, false);
        const publishedAt = httpDate(r.lastModified);
        const records: ParsedRecord[] = districts.flatMap((d) => {
            const name = textOf(d, "Name");
            const region = textOf(d, "RegionNumber");
            if (!name) return [];
            const today = rating(textOf(d, "DangerLevelToday"));
            const tomorrow = rating(textOf(d, "DangerLevelTomorrow"));
            const banToday = yes(textOf(d, "FireBanToday"));
            const banTomorrow = yes(textOf(d, "FireBanTomorrow"));
            return [
                {
                    externalId: `district-${region ?? name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
                    kind: "rating" as const,
                    category: "fire_danger" as const,
                    eventType: "Fire Danger Rating",
                    title: name,
                    description: `Today: ${today}${banToday ? ", Total Fire Ban" : ""}. Tomorrow: ${tomorrow}${banTomorrow ? ", Total Fire Ban" : ""}.`,
                    status: banToday ? "Total Fire Ban today" : null,
                    warningLevel: today,
                    severityRank: fireDangerRank(today),
                    geometryQuality: "district" as const,
                    areaName: clip(textOf(d, "Councils"), 300),
                    publishedAt,
                    updatedAt: publishedAt,
                    sourceUrl: "https://www.rfs.nsw.gov.au/fire-information/fdr-and-tobans",
                    attrs: {
                        district: name,
                        today,
                        tomorrow,
                        banToday: banToday ? "yes" : "no",
                        banTomorrow: banTomorrow ? "yes" : "no",
                        councils: clip(textOf(d, "Councils"), 600) ?? "",
                    },
                },
            ];
        });
        return {
            records,
            complete: true,
            publishedAt,
            bytes: r.bytes.byteLength,
            httpStatus: r.status,
            etag: r.etag,
            lastModified: r.lastModified,
            contentHash: await sha256Hex(r.bytes),
            snapshot: r.bytes,
        };
    },
};

// --- Major Fire Updates (RSS) ----------------------------------------------------------------------

export const rfsMajorUpdates: Adapter = {
    id: "rfs-major-updates",
    allowedHosts: HOSTS,
    async run(ctx) {
        const r = await get(ctx, "major-Fire-Updates.xml", 1_000_000);
        if (r.notModified) return unchanged(r);
        const root = xml(r.bytes);
        const channel = child(root, "channel");
        if (root.name !== "rss" || !channel) throw new FetchFailure("validation", "Expected an RSS channel", null, false);
        const records: ParsedRecord[] = [];
        for (const item of children(channel, "item").slice(0, 200)) {
            const guid = textOf(item, "guid");
            const title = textOf(item, "title");
            // The feed's placeholder when there's nothing to report.
            if (!title || guid === "0" || /^no major fires$/i.test(title)) continue;
            const updated = isoInstant(textOf(item, "updated")) ?? httpDate(textOf(item, "pubDate"));
            records.push({
                externalId: `update-${(guid ?? title).slice(0, 180)}`,
                kind: "event",
                category: "fire",
                eventType: "Major Fire Update",
                title: titleCase(title).slice(0, 300),
                description: plainText(textOf(item, "description"), 6000),
                geometryQuality: "area_text",
                publishedAt: updated,
                updatedAt: updated,
                sourceUrl: safeLink(textOf(item, "link")) ?? "https://www.rfs.nsw.gov.au/fire-information/major-fire-updates",
            });
        }
        return {
            records,
            complete: true,
            publishedAt: isoInstant(textOf(channel, "lastBuildDate")) ?? httpDate(textOf(channel, "lastBuildDate")) ?? httpDate(r.lastModified),
            bytes: r.bytes.byteLength,
            httpStatus: r.status,
            etag: r.etag,
            lastModified: r.lastModified,
            contentHash: await sha256Hex(r.bytes),
            snapshot: r.bytes,
        };
    },
};

// --- Incident alerts (EDXL-DE carrying CAP-AU) -----------------------------------------------------

/** CAP polygon "lat,lon lat,lon …" → GeoJSON ring. */
export function capPolygon(text: string): Position[] | null {
    const pts = text
        .trim()
        .split(/\s+/)
        .map((pair) => pair.split(",").map(Number))
        .filter((p) => p.length === 2 && p.every(Number.isFinite))
        .map(([la, lo]) => [lo, la] as Position);
    return pts.length >= 4 ? pts : null;
}

function capArea(info: XmlElement): { geometry: Geometry | null; areaName: string | null; point: Position | null } {
    const polys: Position[][][] = [];
    let point: Position | null = null;
    const names: string[] = [];
    for (const area of children(info, "area")) {
        const desc = textOf(area, "areaDesc");
        if (desc) names.push(desc);
        for (const p of children(area, "polygon")) {
            const ring = capPolygon(p.text);
            if (ring) polys.push([ring]);
        }
        // A CAP circle is an area the agency published ("lat,lon radius-km"); its centre is kept as a point.
        for (const c of children(area, "circle")) {
            const m = /^\s*(-?[\d.]+),(-?[\d.]+)\s+([\d.]+)/.exec(c.text);
            if (m) point ??= [Number(m[2]), Number(m[1])];
        }
    }
    let geometry: Geometry | null = null;
    if (polys.length) {
        try {
            geometry = cleanGeometry(polys.length === 1 ? { type: "Polygon", coordinates: polys[0] } : { type: "MultiPolygon", coordinates: polys });
        } catch (error) {
            if (!(error instanceof GeometryError)) throw error;
        }
    }
    return { geometry, areaName: names.join("; ").slice(0, 300) || null, point };
}

export const rfsIncidentAlerts: Adapter = {
    id: "rfs-incident-alerts",
    allowedHosts: HOSTS,
    async run(ctx) {
        const r = await get(ctx, "IncidentAlerts.xml", 4_000_000);
        if (r.notModified) return unchanged(r);
        const root = xml(r.bytes);
        if (root.name !== "EDXLDistribution") throw new FetchFailure("validation", "Expected an EDXL-DE distribution", null, false);
        const records: ParsedRecord[] = [];
        for (const alert of descendants(root, "alert").slice(0, 500)) {
            const identifier = textOf(alert, "identifier");
            const info = child(alert, "info");
            if (!identifier || !info) continue;
            const msgType = textOf(alert, "msgType");
            const params = Object.fromEntries(children(info, "parameter").map((p) => [textOf(p, "valueName") ?? "", textOf(p, "value") ?? ""]));
            const level = awsLevel(params.AlertLevel ?? params.WarningLevel ?? params.alertLevel ?? null);
            const { geometry, areaName, point } = capArea(info);
            const sent = isoInstant(textOf(alert, "sent"));
            // An update supersedes the alert it references; keyed by the incident when CAP-AU gives one.
            const key = params.IncidentId ?? params.incidentId ?? identifier;
            records.push({
                externalId: `alert-${key.slice(0, 180)}`,
                kind: "warning",
                category: "fire",
                eventType: textOf(info, "event"),
                title: (textOf(info, "headline") ?? textOf(info, "event") ?? "RFS alert").slice(0, 300),
                description: plainText([textOf(info, "description"), textOf(info, "instruction")].filter(Boolean).join("\n"), 6000),
                status: msgType,
                warningLevel: level,
                severityRank: levelRank(level),
                point,
                geometry,
                geometryQuality: geometry ? "polygon" : point ? "point" : "area_text",
                areaName,
                publishedAt: sent,
                updatedAt: sent,
                sourceUrl: safeLink(textOf(info, "web")) ?? "https://www.rfs.nsw.gov.au/fire-information/fires-near-me",
                attrs: Object.fromEntries(
                    [
                        ["severity", textOf(info, "severity")],
                        ["urgency", textOf(info, "urgency")],
                        ["certainty", textOf(info, "certainty")],
                        ["capIdentifier", identifier.slice(0, 200)],
                    ].filter((e): e is [string, string] => !!e[1]),
                ),
                ended: msgType === "Cancel",
            });
        }
        return {
            records,
            complete: true,
            publishedAt: isoInstant(textOf(root, "dateTimeSent")) ?? httpDate(r.lastModified),
            bytes: r.bytes.byteLength,
            httpStatus: r.status,
            etag: r.etag,
            lastModified: r.lastModified,
            contentHash: await sha256Hex(r.bytes),
            snapshot: r.bytes,
        };
    },
};
