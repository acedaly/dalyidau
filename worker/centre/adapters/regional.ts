// NSW air quality, Endeavour Energy outages, ACT ESA incidents and NOAA space weather: public,
// anonymous services, each read through its documented interface only.
import { zonedInstant } from "../../../src/shared/calendar/time";
import { FetchFailure, decodeText, parseJsonBytes, safeFetch } from "../net";
import { XmlError, child, children, parseXml, plainText, textOf } from "../xml";
import {
    type Adapter,
    type ParsedRecord,
    SYDNEY,
    type SeriesPoint,
    clip,
    finite,
    isoInstant,
    metric,
    metrics,
    parseDayMonthTime,
    parseLocalIsoish,
    sha256Hex,
    titleCase,
} from "./types";

// --- NSW air quality ---------------------------------------------------------------------------

const AQ_HOSTS = ["data.airquality.nsw.gov.au"] as const;
const AQ = "https://data.airquality.nsw.gov.au/api/Data";
const AQ_PARAMETERS = [
    { code: "PM2.5", key: "pm25", label: "PM2.5", unit: "µg/m³" },
    { code: "PM10", key: "pm10", label: "PM10", unit: "µg/m³" },
    { code: "OZONE", key: "ozone", label: "Ozone", unit: "pphm" },
] as const;
const AQ_BATCH = 6;
/** The provider's categories, best first. Only ever copied from its data, never calculated here. */
export const AQ_CATEGORIES = ["GOOD", "FAIR", "POOR", "VERY POOR", "EXTREMELY POOR", "HAZARDOUS"];

interface AqSite {
    Site_Id: number;
    SiteName: string;
    Longitude: number;
    Latitude: number;
    Region: string;
}
interface AqObservation {
    Site_Id: number;
    Parameter?: { ParameterCode?: string };
    Date?: string;
    Hour?: number;
    HourDescription?: string;
    Value?: number | null;
    AirQualityCategory?: string | null;
}

export const nswAirQuality: Adapter = {
    id: "nsw-air-quality",
    allowedHosts: AQ_HOSTS,
    async run(ctx) {
        let bytes = 0;
        // Site details change rarely: refreshed once a day.
        let sites = ctx.state.sites as AqSite[] | undefined;
        const sitesAt = typeof ctx.state.sitesAt === "string" ? Date.parse(ctx.state.sitesAt) : 0;
        if (!Array.isArray(sites) || ctx.now.getTime() - sitesAt > 86_400_000) {
            const r = await safeFetch(ctx.transport, `${AQ}/get_SiteDetails`, { allowedHosts: AQ_HOSTS, timeoutMs: 20_000, maxBytes: 1_000_000 });
            bytes += r.bytes.byteLength;
            const list = parseJsonBytes(r.bytes);
            if (!Array.isArray(list)) throw new FetchFailure("validation", "Expected a list of sites", null, false);
            sites = (list as AqSite[])
                .filter((s) => Number.isInteger(s?.Site_Id) && finite(s.Latitude) !== null && finite(s.Longitude) !== null && typeof s.SiteName === "string")
                .slice(0, 500)
                .map((s) => ({
                    Site_Id: s.Site_Id,
                    SiteName: s.SiteName.slice(0, 120),
                    Longitude: s.Longitude,
                    Latitude: s.Latitude,
                    Region: String(s.Region ?? "").slice(0, 80),
                }));
        }
        // The API answers slowly for more than a handful of sites (over 80 s for five on 19 October 2026),
        // so each run reads a small batch, rotating through the followed sites (or every site).
        const pool = ctx.settings.airSites.length ? sites.filter((s) => ctx.settings.airSites.includes(s.Site_Id)) : sites;
        const cursor = typeof ctx.state.cursor === "number" && ctx.state.cursor < pool.length ? ctx.state.cursor : 0;
        const wanted = pool.slice(cursor, cursor + AQ_BATCH);
        const nextCursor = cursor + AQ_BATCH >= pool.length ? 0 : cursor + AQ_BATCH;
        const local = new Intl.DateTimeFormat("en-CA", {
            timeZone: SYDNEY,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            hourCycle: "h23",
        }).formatToParts(ctx.now);
        const part = (t: string) => local.find((p) => p.type === t)?.value ?? "";
        const today = `${part("year")}-${part("month")}-${part("day")}`;
        const start = Number(part("hour")) < 3 ? new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10) : today;
        const end = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
        const r = await safeFetch(ctx.transport, `${AQ}/get_Observations`, {
            allowedHosts: AQ_HOSTS,
            timeoutMs: 90_000,
            maxBytes: 12_000_000,
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                Parameters: AQ_PARAMETERS.map((p) => p.code),
                Sites: wanted.map((s) => s.Site_Id),
                StartDate: start,
                EndDate: end,
                Categories: ["Averages"],
                SubCategories: ["Hourly"],
                Frequency: ["Hourly average"],
            }),
        });
        bytes += r.bytes.byteLength;
        const rows = parseJsonBytes(r.bytes);
        if (!Array.isArray(rows)) throw new FetchFailure("validation", "Expected a list of observations", null, false);
        // Latest hour per site and parameter.
        const latest = new Map<string, AqObservation & { at: string }>();
        const series: SeriesPoint[] = [];
        for (const o of rows as AqObservation[]) {
            const code = o?.Parameter?.ParameterCode;
            const value = finite(o?.Value);
            if (!code || value === null || !Number.isInteger(o.Hour) || !/^\d{4}-\d{2}-\d{2}$/.test(o.Date ?? "")) continue;
            // Hour n is the hour ending at n o'clock, in NSW local time as published.
            const hour = Math.min(23, Math.max(0, (o.Hour as number) - 1));
            const at = new Date(Date.parse(zonedInstant(o.Date!, `${String(hour).padStart(2, "0")}:00`, SYDNEY)) + 3_600_000).toISOString();
            const key = `${o.Site_Id}:${code}`;
            const prev = latest.get(key);
            if (!prev || at > prev.at) latest.set(key, { ...o, at });
            const param = AQ_PARAMETERS.find((p) => p.code === code);
            if (param && ctx.source.history) series.push({ externalId: `aq-site-${o.Site_Id}`, metric: param.key, at, value });
        }
        const records: ParsedRecord[] = [];
        let newest: string | null = null;
        for (const site of wanted) {
            const readings = AQ_PARAMETERS.map((p) => ({ p, o: latest.get(`${site.Site_Id}:${p.code}`) })).filter((x) => !!x.o);
            if (!readings.length) continue;
            const observedAt = readings
                .map((x) => x.o!.at)
                .sort()
                .pop()!;
            if (!newest || observedAt > newest) newest = observedAt;
            // The worst of the provider's own categories across these pollutants.
            const categories = readings.map((x) => (x.o!.AirQualityCategory ?? "").toUpperCase()).filter((c) => AQ_CATEGORIES.includes(c));
            const worst = categories.sort((a, b) => AQ_CATEGORIES.indexOf(b) - AQ_CATEGORIES.indexOf(a))[0] ?? null;
            records.push({
                externalId: `aq-site-${site.Site_Id}`,
                kind: "observation",
                category: "air",
                eventType: "Air quality",
                title: titleCase(site.SiteName),
                status: worst ? titleCase(worst) : null,
                severityRank: worst ? AQ_CATEGORIES.indexOf(worst) : 0,
                point: [site.Longitude, site.Latitude],
                geometryQuality: "point",
                areaName: site.Region || null,
                observedAt,
                sourceUrl: "https://www.airquality.nsw.gov.au/air-quality-in-my-area/concentration-data",
                metrics: metrics(...readings.map(({ p, o }) => metric(p.key, p.label, o!.Value, p.unit))),
                attrs: Object.fromEntries(
                    [
                        ["siteId", String(site.Site_Id)],
                        ["categoryBy", "NSW Government (provider's category)"],
                        ...readings.map(({ p, o }) => [`${p.key}Category`, o!.AirQualityCategory ? titleCase(o!.AirQualityCategory) : ""] as [string, string]),
                        ["hour", readings[0].o!.HourDescription ?? ""],
                    ].filter((e): e is [string, string] => !!e[1]),
                ),
            });
        }
        return {
            records,
            series,
            // One batch of sites: the others keep their last reading (with its own time) until their turn.
            complete: false,
            keep: pool.filter((s) => !wanted.includes(s)).map((s) => `aq-site-${s.Site_Id}`),
            // Batches read different sites, so their times aren't comparable for replay protection.
            publishedAt: null,
            state: { sites, sitesAt: sites === ctx.state.sites ? ctx.state.sitesAt : ctx.now.toISOString(), cursor: nextCursor },
            bytes,
            httpStatus: r.status,
            contentHash: await sha256Hex(r.bytes),
        };
    },
};

// --- Endeavour Energy outages ------------------------------------------------------------------

const EE_HOSTS = ["data.endeavourenergy.com.au"] as const;
const EE_PAGE = 100;
const EE_PAGES = 10;

interface Outage {
    incident_id?: string;
    incident_status?: string;
    outage_type?: string;
    cause?: string;
    street_name?: string;
    cityname?: string;
    postcode?: string;
    customers_affected?: number;
    start_date_time?: string;
    est_restore_time?: string;
    end_date_time?: string;
    updated_at?: string;
    latitude?: number;
    longitude?: number;
}

export const endeavourOutages: Adapter = {
    id: "endeavour-outages",
    allowedHosts: EE_HOSTS,
    async run(ctx) {
        const rows: Outage[] = [];
        let bytes = 0;
        let total = 0;
        let status = 200;
        for (let page = 0; page < EE_PAGES; page++) {
            const query = new URLSearchParams({ limit: String(EE_PAGE), offset: String(page * EE_PAGE), order_by: "uid" });
            const r = await safeFetch(
                ctx.transport,
                `https://data.endeavourenergy.com.au/api/explore/v2.1/catalog/datasets/outagecustomerlive/records?${query}`,
                {
                    allowedHosts: EE_HOSTS,
                    timeoutMs: 20_000,
                    maxBytes: 2_000_000,
                },
            );
            bytes += r.bytes.byteLength;
            status = r.status;
            const data = parseJsonBytes(r.bytes) as { total_count?: unknown; results?: unknown };
            if (!Array.isArray(data?.results) || typeof data.total_count !== "number")
                throw new FetchFailure("validation", "Unexpected response shape", null, false);
            total = data.total_count;
            rows.push(...(data.results as Outage[]));
            if (rows.length >= total || (data.results as unknown[]).length < EE_PAGE) break;
        }
        const records: ParsedRecord[] = [];
        let newest: string | null = null;
        for (const o of rows) {
            const id = clip(o.incident_id, 60);
            const lat = finite(o.latitude);
            const lon = finite(o.longitude);
            if (!id || lat === null || lon === null) continue;
            const updated = parseLocalIsoish(o.updated_at);
            if (updated && (!newest || updated > newest)) newest = updated;
            const suburb = o.cityname ? titleCase(o.cityname) : null;
            const customers = finite(o.customers_affected);
            const restore = parseLocalIsoish(o.est_restore_time);
            records.push({
                externalId: id,
                kind: "disruption",
                category: "power",
                eventType: `${titleCase(o.outage_type ?? "Unplanned")} power outage`,
                title: `Power outage${suburb ? `, ${suburb}` : ""}`,
                description:
                    [o.cause && o.cause !== "None" ? `Cause: ${o.cause}.` : null, restore ? "Estimated restoration time published by Endeavour Energy." : null]
                        .filter(Boolean)
                        .join(" ") || null,
                status: clip(o.incident_status, 60),
                point: [lon, lat],
                geometryQuality: "point",
                areaName: [suburb, clip(o.postcode, 4)].filter(Boolean).join(" ") || null,
                publishedAt: parseLocalIsoish(o.start_date_time),
                updatedAt: updated,
                sourceUrl: "https://www.endeavourenergy.com.au/outages",
                metrics: metrics(metric("customers", "Customers affected", customers, "")),
                attrs: Object.fromEntries(
                    [
                        ["estimatedRestoration", restore],
                        ["started", parseLocalIsoish(o.start_date_time)],
                        ["outageType", clip(o.outage_type, 30)],
                    ].filter((e): e is [string, string] => !!e[1]),
                ),
                ended: !!parseLocalIsoish(o.end_date_time) && Date.parse(parseLocalIsoish(o.end_date_time)!) < ctx.now.getTime(),
            });
        }
        return { records, complete: rows.length >= total, publishedAt: newest, bytes, httpStatus: status, contentHash: await sha256Hex(JSON.stringify(rows)) };
    },
};

// --- ACT Emergency Services Agency ---------------------------------------------------------------

const ACT_HOSTS = ["www.esa.act.gov.au", "esa.act.gov.au"] as const;

export const actIncidents: Adapter = {
    id: "act-esa-incidents",
    allowedHosts: ACT_HOSTS,
    async run(ctx) {
        const r = await safeFetch(ctx.transport, "https://www.esa.act.gov.au/feeds/currentincidents.xml", {
            allowedHosts: ACT_HOSTS,
            timeoutMs: 20_000,
            maxBytes: 2_000_000,
            etag: ctx.etag,
            lastModified: ctx.lastModified,
        });
        if (r.notModified) return { records: [], complete: false, publishedAt: null, bytes: 0, httpStatus: 304, notModified: true };
        let root;
        try {
            root = parseXml(decodeText(r.bytes));
        } catch (error) {
            if (error instanceof XmlError) throw new FetchFailure("parse_error", `The feed isn't valid XML: ${error.message}`, null, false);
            throw error;
        }
        const channel = child(root, "channel");
        if (root.name !== "rss" || !channel) throw new FetchFailure("validation", "Expected an RSS channel", null, false);
        const records: ParsedRecord[] = [];
        for (const item of children(channel, "item").slice(0, 500)) {
            const agency = textOf(item, "agency") ?? "";
            // Ambulance responses are left out (see the source notes).
            if (/ambulance/i.test(agency)) continue;
            const guid = textOf(item, "guid");
            const pos = (textOf(item, "point") ?? "").split(/\s+/).map(Number);
            if (!guid || pos.length !== 2 || !pos.every(Number.isFinite)) continue;
            const fields = Object.fromEntries(
                (textOf(item, "description") ?? "")
                    .split(/\r?\n|\r/)
                    .map((l) => /^\s*([A-Za-z ]{2,30}):\s*(.*)$/.exec(l))
                    .filter((m): m is RegExpExecArray => !!m)
                    .map((m) => [m[1].trim(), m[2].trim()]),
            );
            const type = textOf(item, "type") ?? fields.Type ?? null;
            records.push({
                externalId: guid.slice(0, 100),
                kind: "incident",
                category: /fire|burn/i.test(type ?? "") ? "fire" : "emergency",
                eventType: type ? titleCase(type) : null,
                title: titleCase(textOf(item, "title") ?? "ACT incident").slice(0, 300),
                description: plainText(textOf(item, "description"), 2000),
                status: textOf(item, "resourceStatus") ?? fields.Status ?? null,
                point: [pos[1], pos[0]],
                geometryQuality: "point",
                areaName: fields.Suburb ? titleCase(fields.Suburb) : null,
                publishedAt: parseDayMonthTime(fields["Time of Call"]),
                updatedAt: parseDayMonthTime(fields.Updated),
                sourceUrl: "https://esa.act.gov.au/",
                attrs: Object.fromEntries(
                    [
                        ["agency", clip(agency, 40)],
                        ["controlStatus", textOf(item, "controlStatus")],
                    ].filter((e): e is [string, string] => !!e[1]),
                ),
            });
        }
        const newest =
            records
                .map((x) => x.updatedAt)
                .filter((x): x is string => !!x)
                .sort()
                .pop() ?? null;
        return {
            records,
            complete: true,
            publishedAt: newest,
            bytes: r.bytes.byteLength,
            httpStatus: r.status,
            etag: r.etag,
            lastModified: r.lastModified,
            contentHash: await sha256Hex(r.bytes),
        };
    },
};

// --- NOAA space weather ------------------------------------------------------------------------

const NOAA_HOSTS = ["services.swpc.noaa.gov"] as const;

export const noaaSpaceWeather: Adapter = {
    id: "noaa-space-weather",
    allowedHosts: NOAA_HOSTS,
    async run(ctx) {
        const get = (path: string) =>
            safeFetch(ctx.transport, `https://services.swpc.noaa.gov/products/${path}`, { allowedHosts: NOAA_HOSTS, timeoutMs: 20_000, maxBytes: 2_000_000 });
        const [kpResponse, alertResponse] = await Promise.all([get("noaa-planetary-k-index.json"), get("alerts.json")]);
        const kp = parseJsonBytes(kpResponse.bytes);
        const alerts = parseJsonBytes(alertResponse.bytes);
        if (!Array.isArray(kp) || !Array.isArray(alerts)) throw new FetchFailure("validation", "Unexpected response shape", null, false);
        // Both shapes have been published: rows of objects, or a header row then arrays.
        const kpRows = (kp as unknown[])
            .map((row) => (Array.isArray(row) ? { time_tag: row[0], Kp: row[1] } : (row as { time_tag?: unknown; Kp?: unknown })))
            .map((row) => ({ at: isoInstant(typeof row.time_tag === "string" ? `${row.time_tag.replace(" ", "T").slice(0, 19)}Z` : null), kp: finite(row.Kp) }))
            .filter((row): row is { at: string; kp: number } => !!row.at && row.kp !== null);
        const series: SeriesPoint[] = kpRows.map((row) => ({ externalId: "planetary-kp", metric: "kp", at: row.at, value: row.kp }));
        const last = kpRows[kpRows.length - 1];
        const records: ParsedRecord[] = [];
        if (last)
            records.push({
                externalId: "planetary-kp",
                kind: "observation",
                category: "space_weather",
                eventType: "Geomagnetic activity",
                title: "Planetary K-index",
                status: last.kp >= 5 ? `Geomagnetic storm level (Kp ${last.kp})` : `Kp ${last.kp}`,
                geometryQuality: "none",
                observedAt: last.at,
                sourceUrl: "https://www.swpc.noaa.gov/products/planetary-k-index",
                metrics: metrics(metric("kp", "Kp", last.kp, "")),
            });
        const cutoff = ctx.now.getTime() - 48 * 3_600_000;
        for (const a of (alerts as { product_id?: unknown; issue_datetime?: unknown; message?: unknown }[]).slice(0, 300)) {
            const at = isoInstant(typeof a.issue_datetime === "string" ? `${a.issue_datetime.replace(" ", "T").slice(0, 19)}Z` : null);
            const message = typeof a.message === "string" ? a.message : "";
            if (!at || Date.parse(at) < cutoff) continue;
            const serial = /Serial Number:\s*(\d+)/.exec(message)?.[1];
            const headline = /^(ALERT|WARNING|WATCH|SUMMARY|EXTENDED WARNING|CANCEL[^:]*):\s*(.+)$/m.exec(message);
            const id = `${clip(a.product_id, 20) ?? "alert"}-${serial ?? at}`;
            records.push({
                externalId: id,
                kind: "event",
                category: "space_weather",
                eventType: headline ? titleCase(headline[1]) : "Space weather message",
                title: (headline ? `${titleCase(headline[1])}: ${headline[2].trim()}` : "Space weather message").slice(0, 300),
                description: plainText(message, 3000),
                geometryQuality: "none",
                publishedAt: at,
                sourceUrl: "https://www.swpc.noaa.gov/products/alerts-watches-and-warnings",
            });
        }
        return {
            records,
            series,
            // Alerts age out after 48 hours by design; Kp is a single rolling record.
            complete: true,
            publishedAt: last?.at ?? null,
            bytes: kpResponse.bytes.byteLength + alertResponse.bytes.byteLength,
            httpStatus: kpResponse.status,
            contentHash: await sha256Hex(new Uint8Array([...kpResponse.bytes, ...alertResponse.bytes])),
        };
    },
};
