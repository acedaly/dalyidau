// Intelligence Centre: every source adapter against invented fixtures in each provider's real format
// (fixtures/intelligence-centre), and the ingestion engine: leases, conditional requests, replay
// protection, idempotent upserts, change detection, "no longer in the feed" (never "resolved"),
// failures, backoff, stale sources, history and retention. No test reaches a real provider.
import { beforeEach, describe, expect, it } from "vitest";
import {
    aqObservations,
    aqSites,
    bomAmocWarning,
    deaHotspots,
    firmsCsv,
    rfsFireDanger,
    rfsIncidentAlerts,
    rfsIncidents,
    rfsMajorUpdates,
    tfnswHazards,
    wdoFeature,
    wdoObservation,
} from "../fixtures/intelligence-centre/feeds.mjs";
import { applyRetention, checkStaleSources, collectSource, expireWarnings, runCentreCron, runDueSources } from "../worker/centre/ingest";
import { sourceHealth } from "../worker/centre/store";
import { C, centreEnv, changes, collect, enableSource, fakeTransport, records, setFlag } from "./centre-helpers";
import { apiCall, db, resetPortal } from "./portal-helpers";

const NOW = new Date("2026-10-19T04:00:00Z");
const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

beforeEach(resetPortal);

const statusOf = async (id: string) => (await sourceHealth(await centreEnv())).find((h) => h.source.id === id)!;

describe("NSW RFS adapters", () => {
    it("parses current incidents: levels as published, fire vs other incidents, published areas, Sydney times", async () => {
        const env = await centreEnv();
        await enableSource("rfs-incidents");
        const result = await collect(env, "rfs-incidents", fakeTransport(NOW), NOW);
        expect(result).toMatchObject({ outcome: "ok", records: 3, created: 3 });
        const rows = await records("rfs-incidents");
        const grass = rows.find((r) => r.external_id === "incident-900001")!;
        expect(grass).toMatchObject({
            kind: "incident",
            category: "fire",
            warning_level: "Watch and Act",
            severity_rank: 2,
            status: "Out of control",
            geometry_quality: "polygon",
            event_type: "Grass Fire",
            fixture: 1,
        });
        expect(grass.title).toBe("Example Ridge Rd, Exampleville");
        // Kept as published (the point and its area together); the map draws only the area as an area.
        const geometry = JSON.parse(grass.geometry as string);
        expect(geometry.type).toBe("GeometryCollection");
        expect(JSON.stringify(geometry)).toContain('"Polygon"');
        // pubDate "dd/mm/yyyy h:mm:ss AM" is Sydney time.
        expect(Math.abs(Date.parse(grass.published_at as string) - (NOW.getTime() - 120 * 60_000))).toBeLessThan(2 * 60 * 60_000);
        const crash = rows.find((r) => r.external_id === "incident-900003")!;
        // "Not Applicable" is not a warning level, and a crash isn't a fire.
        expect(crash).toMatchObject({ category: "emergency", warning_level: null, severity_rank: 0, geometry_quality: "point" });
        expect(JSON.parse(grass.metrics as string)).toEqual([{ key: "size_ha", label: "Size", value: 120, unit: "ha" }]);
        // Markup in descriptions is removed, never kept as HTML.
        expect(String(grass.description)).not.toContain("<br");
    });

    it("parses fire danger ratings and total fire bans per district", async () => {
        const env = await centreEnv();
        await enableSource("rfs-fire-danger");
        await collect(env, "rfs-fire-danger", fakeTransport(NOW), NOW);
        const rows = await records("rfs-fire-danger");
        expect(rows).toHaveLength(3);
        const ranges = rows.find((r) => r.title === "Example Ranges")!;
        expect(ranges).toMatchObject({ kind: "rating", warning_level: "Extreme", severity_rank: 3, geometry_quality: "district", lat: null });
        expect(JSON.parse(ranges.attrs as string)).toMatchObject({
            today: "Extreme",
            tomorrow: "High",
            banToday: "yes",
            banTomorrow: "no",
            councils: "Example Shire; Example City",
        });
        expect(rows.find((r) => r.title === "Example Plains")!.warning_level).toBe("No rating");
    });

    it("skips the 'No Major Fires' placeholder and decodes a feed that misdeclares UTF-16", async () => {
        const env = await centreEnv();
        await enableSource("rfs-major-updates");
        await collect(
            env,
            "rfs-major-updates",
            fakeTransport(NOW, { "https://www.rfs.nsw.gov.au/feeds/major-Fire-Updates.xml": rfsMajorUpdates(NOW, { empty: true }) }),
            NOW,
        );
        expect(await records("rfs-major-updates")).toHaveLength(0);
        await collect(env, "rfs-major-updates", fakeTransport(later(30)), later(30));
        const [update] = await records("rfs-major-updates");
        expect(update).toMatchObject({ kind: "event", title: "Example Ridge Rd Fire Update" });
        expect(update.description).toBe("Crews are working on the Example Ridge Rd fire.");
    });

    it("parses CAP alerts in EDXL with their polygon and level, and a Cancel ends the alert (as the provider says)", async () => {
        const env = await centreEnv();
        await enableSource("rfs-incident-alerts");
        await collect(env, "rfs-incident-alerts", fakeTransport(NOW), NOW);
        const [alert] = await records("rfs-incident-alerts");
        expect(alert).toMatchObject({
            kind: "warning",
            warning_level: "Watch and Act",
            geometry_quality: "polygon",
            active: 1,
            area_name: "Exampleville and surrounds",
        });
        expect(alert.description).toContain("Never real.");
        expect(alert.description).not.toContain("<b>");
        await collect(
            env,
            "rfs-incident-alerts",
            fakeTransport(later(15), { "https://www.rfs.nsw.gov.au/feeds/IncidentAlerts.xml": rfsIncidentAlerts(later(15), { cancel: true }) }),
            later(15),
        );
        const [after] = await records("rfs-incident-alerts");
        expect(after.active).toBe(0);
        expect((await changes()).map((c) => c.kind)).toContain("ended");
    });
});

describe("Bureau of Meteorology adapters (FTP)", () => {
    it("reads only warning products, classifies the rest once, and keeps unchanged warnings without re-downloading", async () => {
        const env = await centreEnv();
        await enableSource("bom-warnings");
        const t = fakeTransport(NOW);
        await collect(env, "bom-warnings", t, NOW);
        const [warning] = await records("bom-warnings");
        expect(warning).toMatchObject({
            external_id: "IDN21033",
            kind: "warning",
            category: "weather",
            warning_level: null,
            geometry_quality: "area_text",
            lat: null,
        });
        expect(warning.title).toContain("DAMAGING WINDS");
        expect(JSON.parse(warning.attrs as string)).toMatchObject({ districts: "NSW_PW006", product: "IDN21033" });
        const state = JSON.parse((await db().prepare("SELECT state FROM ic_sources WHERE id = 'bom-warnings'").first<{ state: string }>())!.state);
        expect(state.products).toMatchObject({ IDN21033: { type: "W" }, IDN11060: { type: "F" } });
        // Nothing changed on the FTP server: the listing is read, no product is downloaded again.
        t.calls.length = 0;
        await collect(env, "bom-warnings", t, later(15));
        expect(t.calls.filter((c) => c.startsWith("ftp:get"))).toEqual([]);
        expect((await records("bom-warnings"))[0].active).toBe(1);
    });

    it("ends a warning at the Bureau's own expiry time, and when the Bureau marks it cancelled", async () => {
        const env = await centreEnv();
        await enableSource("bom-warnings");
        await collect(env, "bom-warnings", fakeTransport(NOW), NOW);
        await expireWarnings(db(), later(13 * 60));
        expect((await records("bom-warnings"))[0].active).toBe(0);
        await resetPortal();
        await enableSource("bom-warnings");
        await collect(
            env,
            "bom-warnings",
            fakeTransport(NOW, { "ftp://ftp.bom.gov.au/anon/gen/fwo/IDN21033.amoc.xml": bomAmocWarning(NOW, { phase: "CAN" }) }),
            NOW,
        );
        expect((await records("bom-warnings"))[0].active).toBe(0);
    });

    it("parses observations with each station's own observation time and district, and keeps history", async () => {
        const env = await centreEnv();
        await enableSource("bom-observations");
        await collect(env, "bom-observations", fakeTransport(NOW), NOW);
        const rows = await records("bom-observations");
        expect(rows).toHaveLength(3);
        const ex = rows.find((r) => r.title === "Exampleville Airport")!;
        expect(ex).toMatchObject({ kind: "observation", category: "weather", lat: -33.62, lon: 150.61, geometry_quality: "point" });
        expect(Date.parse(ex.observed_at as string)).toBe(NOW.getTime() - 12 * 60_000);
        expect(JSON.parse(ex.metrics as string).find((m: { key: string }) => m.key === "air_temperature").value).toBe(38.5);
        expect(JSON.parse(ex.attrs as string).district).toBe("NSW_PW006");
        const series = await db().prepare("SELECT COUNT(*) AS n FROM ic_series").first<{ n: number }>();
        expect(series!.n).toBe(9);
        // An unchanged product (same listing time) is not downloaded or stored again.
        expect((await collect(env, "bom-observations", fakeTransport(NOW), later(30))).outcome).toBe("unchanged");
    });

    it("reads followed river gauges from Water Data Online and records a material rise", async () => {
        const env = await centreEnv();
        const s = (await apiCall<{ settings: Record<string, unknown>; version: number }>("GET", `${C}/settings`)).json;
        expect((await apiCall("PUT", `${C}/settings`, { settings: { ...s.settings, gauges: ["999001"] }, version: s.version })).status).toBe(200);
        await enableSource("bom-water");
        const wdo = (levels: number[]) => (url: URL) =>
            new Response(url.searchParams.get("request") === "GetFeatureOfInterest" ? wdoFeature : wdoObservation(NOW, levels));
        await collect(env, "bom-water", fakeTransport(NOW, { "https://www.bom.gov.au/waterdata/services": wdo([1.2, 1.3]) }), NOW);
        const [gauge] = await records("bom-water");
        expect(gauge).toMatchObject({ external_id: "gauge-999001", title: "EXAMPLE R @ EXAMPLEVILLE", lat: -33.61, lon: 150.63 });
        expect(JSON.parse(gauge.metrics as string)[0]).toMatchObject({ key: "water_level", value: 1.3, unit: "m" });
        await collect(env, "bom-water", fakeTransport(later(180), { "https://www.bom.gov.au/waterdata/services": wdo([1.3, 1.9]) }), later(180));
        const rise = (await changes()).find((c) => c.kind === "measurement_change")!;
        expect(rise.summary).toContain("rose from 1.3 m to 1.9 m (observed)");
    });
});

describe("Other public sources", () => {
    it("earthquakes: magnitude, depth and location, with Australia flagged", async () => {
        const env = await centreEnv();
        await enableSource("ga-earthquakes");
        await collect(env, "ga-earthquakes", fakeTransport(NOW), NOW);
        const rows = await records("ga-earthquakes");
        expect(rows.map((r) => r.title)).toEqual(["M3.4 Exampleton, NSW", "M5.6 Offshore Example Islands"]);
        expect(JSON.parse(rows[0].attrs as string).inAustralia).toBe("yes");
        expect(rows[0].uncertainty_m).toBe(2500);
    });

    it("satellite detections are detections with their stated accuracy, not incidents", async () => {
        const env = await centreEnv();
        await enableSource("dea-hotspots");
        await collect(env, "dea-hotspots", fakeTransport(NOW), NOW);
        const rows = await records("dea-hotspots");
        expect(rows).toHaveLength(3);
        expect(rows[0]).toMatchObject({ kind: "detection", category: "hotspot", uncertainty_m: 2000 });
        // New detections are routine: no "new" change for each one.
        expect(await changes()).toEqual([]);
    });

    it("air quality: the provider's own category, in small batches of sites", async () => {
        const env = await centreEnv();
        await enableSource("nsw-air-quality");
        let body: { Sites: number[] } | null = null;
        const t = fakeTransport(NOW, {
            "https://data.airquality.nsw.gov.au/api/Data/get_SiteDetails": aqSites,
            "https://data.airquality.nsw.gov.au/api/Data/get_Observations": async (_url, init) => {
                body = JSON.parse(String(init.body));
                return new Response(aqObservations(NOW));
            },
        });
        await collect(env, "nsw-air-quality", t, NOW);
        expect(body!.Sites).toEqual([9001, 9002]);
        const site = (await records("nsw-air-quality")).find((r) => r.external_id === "aq-site-9001")!;
        expect(site).toMatchObject({ status: "Poor", category: "air" });
        expect(JSON.parse(site.attrs as string)).toMatchObject({ categoryBy: "NSW Government (provider's category)", pm25Category: "Poor" });
    });

    it("Endeavour outages, ACT incidents without ambulance responses, NOAA space weather", async () => {
        const env = await centreEnv();
        for (const id of ["endeavour-outages", "act-esa-incidents", "noaa-space-weather"]) {
            await enableSource(id);
            expect((await collect(env, id, fakeTransport(NOW), NOW)).outcome).toBe("ok");
        }
        const [outage] = await records("endeavour-outages");
        expect(outage).toMatchObject({ kind: "disruption", category: "power", title: "Power outage, Exampleville", status: "OPEN" });
        expect(JSON.parse(outage.metrics as string)[0].value).toBe(140);
        const act = await records("act-esa-incidents");
        expect(act.map((r) => r.title)).toEqual(["Grass Fire - Example"]);
        const kp = (await records("noaa-space-weather")).find((r) => r.external_id === "planetary-kp")!;
        expect(kp.status).toBe("Geomagnetic storm level (Kp 5.67)");
    });

    it("Transport for NSW and NASA FIRMS need their keys, and send them only to their own hosts", async () => {
        const env = await centreEnv();
        await enableSource("tfnsw-live-traffic");
        const missing = await collect(env, "tfnsw-live-traffic", fakeTransport(NOW), NOW);
        expect(missing).toMatchObject({ outcome: "error", errorCode: "credentials_missing" });
        expect((await statusOf("tfnsw-live-traffic")).status).toBe("needs_registration");

        const keyed = await centreEnv({ TFNSW_API_KEY: "test-tfnsw-key-123", NASA_FIRMS_MAP_KEY: "abcd1234abcd1234" });
        const seen: string[] = [];
        const t = fakeTransport(NOW);
        for (const type of ["incident", "roadwork", "flood", "fire", "majorevent"])
            t.routes[`https://api.transport.nsw.gov.au/v1/live/hazards/${type}/open`] = (_url, init) => {
                seen.push(new Headers(init.headers).get("Authorization") ?? "");
                return new Response(tfnswHazards(NOW, type));
            };
        await db().prepare("UPDATE ic_sources SET next_due_at = NULL WHERE id = 'tfnsw-live-traffic'").run();
        expect((await collect(keyed, "tfnsw-live-traffic", t, later(1))).outcome).toBe("ok");
        expect(new Set(seen)).toEqual(new Set(["apikey test-tfnsw-key-123"]));
        const roads = await records("tfnsw-live-traffic");
        expect(roads.map((r) => JSON.parse(r.attrs as string).closure)).toEqual(["yes", "yes"]);
        // The key never lands in stored state, errors or runs.
        const stored =
            JSON.stringify((await db().prepare("SELECT * FROM ic_sources").all()).results) +
            JSON.stringify((await db().prepare("SELECT * FROM ic_fetch_runs").all()).results);
        expect(stored).not.toContain("test-tfnsw-key-123");

        await enableSource("nasa-firms");
        t.routes[`https://firms.modaps.eosdis.nasa.gov/api/area/csv/abcd1234abcd1234/VIIRS_SNPP_NRT/140.9,-37.6,153.7,-28.1/1`] = firmsCsv(NOW);
        expect((await collect(keyed, "nasa-firms", t, NOW)).outcome).toBe("ok");
        expect((await records("nasa-firms"))[0]).toMatchObject({ kind: "detection", category: "hotspot" });
    });
});

describe("The ingestion engine", () => {
    it("never collects a source that's off, and marks a source Active only after a validated retrieval", async () => {
        const env = await centreEnv();
        expect((await collectSource(env, "rfs-incidents", { transport: fakeTransport(NOW), now: NOW })).outcome).toBe("skipped");
        expect((await statusOf("rfs-incidents")).status).toBe("disabled");
        await enableSource("rfs-incidents");
        expect((await statusOf("rfs-incidents")).status).toBe("awaiting_verification");
        // A malformed response is refused and the source isn't Active.
        await collect(env, "rfs-incidents", fakeTransport(NOW, { "https://www.rfs.nsw.gov.au/feeds/majorIncidents.json": '{"type":"Nope"}' }), NOW);
        expect((await statusOf("rfs-incidents")).status).toBe("error");
        await db().prepare("UPDATE ic_sources SET next_due_at = NULL").run();
        await collect(env, "rfs-incidents", fakeTransport(NOW), NOW);
        expect((await statusOf("rfs-incidents")).status).toBe("active");
    });

    it("treats the first collection as a baseline, then detects new records, escalations and changed areas", async () => {
        const env = await centreEnv();
        await enableSource("rfs-incidents");
        await collect(
            env,
            "rfs-incidents",
            fakeTransport(NOW, { "https://www.rfs.nsw.gov.au/feeds/majorIncidents.json": rfsIncidents(NOW, { level: "Advice", drop: [1] }) }),
            NOW,
        );
        expect(await changes()).toEqual([]);
        await collect(
            env,
            "rfs-incidents",
            fakeTransport(later(15), {
                "https://www.rfs.nsw.gov.au/feeds/majorIncidents.json": rfsIncidents(later(15), { level: "Emergency Warning", areaSize: 0.05 }),
            }),
            later(15),
        );
        const kinds = (await changes()).map((c) => c.kind).sort();
        expect(kinds).toEqual(["escalated", "new"]);
        const escalated = (await changes()).find((c) => c.kind === "escalated")!;
        expect(escalated.summary).toContain("Advice → Emergency Warning");
        await collect(
            env,
            "rfs-incidents",
            fakeTransport(later(30), {
                "https://www.rfs.nsw.gov.au/feeds/majorIncidents.json": rfsIncidents(later(30), { level: "Emergency Warning", areaSize: 0.08 }),
            }),
            later(30),
        );
        expect((await changes()).map((c) => c.kind)).toContain("geometry_changed");
    });

    it("never treats a record missing from the feed as resolved, and notices when it comes back", async () => {
        const env = await centreEnv();
        await enableSource("rfs-incidents");
        await collect(env, "rfs-incidents", fakeTransport(NOW), NOW);
        await collect(
            env,
            "rfs-incidents",
            fakeTransport(later(15), { "https://www.rfs.nsw.gov.au/feeds/majorIncidents.json": rfsIncidents(later(15), { drop: [0] }) }),
            later(15),
        );
        const gone = (await records("rfs-incidents")).find((r) => r.external_id === "incident-900001")!;
        expect(gone.active).toBe(0);
        expect(gone.missing_since).toBeTruthy();
        const change = (await changes()).find((c) => c.kind === "not_in_feed")!;
        expect(change.summary).toContain("not confirmed resolved");
        expect((await changes()).some((c) => c.kind === "ended")).toBe(false);
        await collect(env, "rfs-incidents", fakeTransport(later(30)), later(30));
        expect((await records("rfs-incidents")).find((r) => r.external_id === "incident-900001")!).toMatchObject({ active: 1, missing_since: null });
        expect((await changes()).map((c) => c.kind)).toContain("reappeared");
    });

    it("is idempotent: the same response again changes nothing, and a duplicated id is stored once", async () => {
        const env = await centreEnv();
        await enableSource("rfs-incidents");
        const t = fakeTransport(NOW);
        await collect(env, "rfs-incidents", t, NOW);
        expect((await collect(env, "rfs-incidents", t, later(15))).outcome).toBe("unchanged");
        expect(await records("rfs-incidents")).toHaveLength(3);
        const doubled = JSON.parse(rfsIncidents(NOW));
        doubled.features.push(doubled.features[0]);
        await db().prepare("UPDATE ic_sources SET content_hash = NULL").run();
        await collect(env, "rfs-incidents", fakeTransport(NOW, { "https://www.rfs.nsw.gov.au/feeds/majorIncidents.json": JSON.stringify(doubled) }), later(30));
        expect(await records("rfs-incidents")).toHaveLength(3);
    });

    it("uses conditional requests and treats 304 as unchanged", async () => {
        const env = await centreEnv();
        await enableSource("rfs-incidents");
        let conditional: string | null = null;
        let first = true;
        const t = fakeTransport(NOW, {
            "https://www.rfs.nsw.gov.au/feeds/majorIncidents.json": (_url, init) => {
                conditional = new Headers(init.headers).get("If-None-Match");
                if (first) {
                    first = false;
                    return new Response(rfsIncidents(NOW), { headers: { ETag: '"abc"', "Last-Modified": NOW.toUTCString() } });
                }
                return new Response(null, { status: 304 });
            },
        });
        await collect(env, "rfs-incidents", t, NOW);
        expect((await collect(env, "rfs-incidents", t, later(15))).outcome).toBe("unchanged");
        expect(conditional).toBe('"abc"');
    });

    it("refuses a replayed or older response instead of applying it", async () => {
        const env = await centreEnv();
        await enableSource("rfs-incidents");
        const at = (d: Date, level: string) => () => new Response(rfsIncidents(d, { level }), { headers: { "Last-Modified": d.toUTCString() } });
        await collect(
            env,
            "rfs-incidents",
            fakeTransport(NOW, { "https://www.rfs.nsw.gov.au/feeds/majorIncidents.json": at(later(60), "Emergency Warning") }),
            NOW,
        );
        const result = await collect(
            env,
            "rfs-incidents",
            fakeTransport(NOW, { "https://www.rfs.nsw.gov.au/feeds/majorIncidents.json": at(NOW, "Advice") }),
            later(15),
        );
        expect(result).toMatchObject({ outcome: "rejected", errorCode: "replayed" });
        expect((await records("rfs-incidents")).find((r) => r.external_id === "incident-900001")!.warning_level).toBe("Emergency Warning");
    });

    it("backs off after failures, records the third failure, and recovers", async () => {
        const env = await centreEnv();
        await enableSource("rfs-incidents");
        const broken = fakeTransport(NOW, { "https://www.rfs.nsw.gov.au/feeds/majorIncidents.json": () => new Response("down", { status: 503 }) });
        for (let i = 0; i < 3; i++) {
            await db().prepare("UPDATE ic_sources SET next_due_at = NULL").run();
            expect((await collect(env, "rfs-incidents", broken, later(i))).errorCode).toBe("http_error");
        }
        const row = await db()
            .prepare("SELECT consecutive_failures, next_due_at, error_message FROM ic_sources WHERE id = 'rfs-incidents'")
            .first<{ consecutive_failures: number; next_due_at: string; error_message: string }>();
        expect(row!.consecutive_failures).toBe(3);
        // 15 minutes × 2² after the third failure.
        expect(Date.parse(row!.next_due_at) - later(2).getTime()).toBe(60 * 60_000);
        expect(row!.error_message).toBe("The service answered 503");
        expect((await changes()).map((c) => c.kind)).toEqual(["source_failed"]);
        await collect(env, "rfs-incidents", fakeTransport(NOW), later(90));
        expect((await changes()).map((c) => c.kind)).toEqual(["source_failed", "source_recovered"]);
    });

    it("only one collection of a source runs at a time (lease)", async () => {
        const env = await centreEnv();
        await enableSource("rfs-incidents");
        let release: () => void = () => undefined;
        const gate = new Promise<void>((r) => (release = r));
        const slow = fakeTransport(NOW, {
            "https://www.rfs.nsw.gov.au/feeds/majorIncidents.json": async () => {
                await gate;
                return new Response(rfsIncidents(NOW));
            },
        });
        const first = collect(env, "rfs-incidents", slow, NOW);
        await new Promise((r) => setTimeout(r, 20));
        expect((await collect(env, "rfs-incidents", slow, NOW)).outcome).toBe("skipped");
        release();
        expect((await first).outcome).toBe("ok");
    });

    it("the scheduler collects only due, enabled sources, and only with the owner's switch on", async () => {
        const env = await centreEnv();
        await enableSource("rfs-incidents");
        await enableSource("rfs-fire-danger");
        // Switching a source on makes it due straight away (at the real current time).
        const start = new Date(Date.now() + 60_000);
        const at = (minutes: number) => new Date(start.getTime() + minutes * 60_000);
        const t = fakeTransport(start);
        await runCentreCron(env, { transport: t, now: start });
        expect(t.calls).toEqual([]);
        await setFlag("intelligence_centre.ingestion", true);
        await runCentreCron(env, { transport: t, now: start });
        expect(t.calls.sort()).toEqual(["https://www.rfs.nsw.gov.au/feeds/fdrToban.xml", "https://www.rfs.nsw.gov.au/feeds/majorIncidents.json"]);
        t.calls.length = 0;
        // Not due again for 15 minutes.
        await runDueSources(env, { transport: t, now: at(5) });
        expect(t.calls).toEqual([]);
        await runDueSources(env, { transport: t, now: at(16) });
        expect(t.calls).toEqual(["https://www.rfs.nsw.gov.au/feeds/majorIncidents.json"]);
    });

    it("marks a source stale once, and says so in its status", async () => {
        const env = await centreEnv();
        await enableSource("rfs-incidents");
        await collect(env, "rfs-incidents", fakeTransport(NOW), NOW);
        await db()
            .prepare("UPDATE ic_sources SET last_success_at = ?")
            .bind(new Date(Date.now() - 3 * 3_600_000).toISOString())
            .run();
        await checkStaleSources(env);
        await checkStaleSources(env);
        expect((await changes()).filter((c) => c.kind === "source_stale")).toHaveLength(1);
        expect((await statusOf("rfs-incidents")).status).toBe("stale");
    });

    it("keeps raw snapshots only for sources with history, up to the retention count", async () => {
        const env = await centreEnv();
        await enableSource("rfs-fire-danger");
        for (let i = 0; i < 3; i++) {
            await db().prepare("UPDATE ic_sources SET content_hash = NULL").run();
            await collect(
                env,
                "rfs-fire-danger",
                fakeTransport(later(i * 30), { "https://www.rfs.nsw.gov.au/feeds/fdrToban.xml": rfsFireDanger({ today: i % 2 ? "HIGH" : "EXTREME" }) }),
                later(i * 30),
            );
        }
        const listed = await env.MEDIA.list({ prefix: "private/centre/snapshots/rfs-fire-danger/" });
        expect(listed.objects.length).toBe(3);
        expect((await changes()).filter((c) => c.kind === "rating_changed")).toHaveLength(2);
    });

    it("retention removes only what the settings say", async () => {
        const env = await centreEnv();
        await enableSource("rfs-incidents");
        await collect(env, "rfs-incidents", fakeTransport(NOW), NOW);
        await db().prepare("UPDATE ic_records SET active = 0, last_seen_at = '2025-01-01T00:00:00.000Z' WHERE external_id = 'incident-900001'").run();
        await applyRetention(env, new Date());
        expect((await records("rfs-incidents")).map((r) => r.external_id)).toEqual(["incident-900002", "incident-900003"]);
    });

    it("hotspot detections stay out of change history", async () => {
        const env = await centreEnv();
        await enableSource("dea-hotspots");
        await collect(env, "dea-hotspots", fakeTransport(NOW), NOW);
        await collect(
            env,
            "dea-hotspots",
            fakeTransport(later(30), { "https://hotspots.dea.ga.gov.au/geoserver/public/wfs": deaHotspots(later(30), 1) }),
            later(30),
        );
        expect(await changes()).toEqual([]);
        expect((await records("dea-hotspots")).filter((r) => r.active)).toHaveLength(1);
    });
});

describe("Source permissions", () => {
    it("only owners and admins switch sources and change settings; restricted sources can't be switched on", async () => {
        await apiCall("POST", "/api/portal/users", { email: "admin@example.com", role: "admin" });
        await apiCall("POST", "/api/portal/users", { email: "editor@example.com", role: "editor" });
        expect((await apiCall("PUT", `${C}/sources/rfs-incidents`, { enabled: true }, { email: "admin@example.com" })).status).toBe(200);
        expect((await apiCall("GET", `${C}/sources`, undefined, { email: "editor@example.com" })).status).toBe(403);
        expect((await apiCall("PUT", `${C}/sources/nsw-ses-hazardwatch`, { enabled: true })).status).toBe(404);
        // A source that's off isn't fetched (409, before any network request); the admin may ask, the editor may not.
        expect((await apiCall("POST", `${C}/sources/rfs-fire-danger/refresh`, {}, { email: "admin@example.com" })).status).toBe(409);
        expect((await apiCall("POST", `${C}/sources/rfs-fire-danger/refresh`, {}, { email: "editor@example.com" })).status).toBe(403);
        const audit = (await db().prepare("SELECT action FROM audit_log WHERE action LIKE 'centre.%'").all<{ action: string }>()).results.map((r) => r.action);
        expect(audit).toContain("centre.source.enable");
    });
});
