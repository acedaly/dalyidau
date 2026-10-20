// INVENTED FIXTURES for the Intelligence Centre's tests and local development. Not real data.
//
// Each response follows the format its provider published when it was checked on 19 October 2026
// (see docs/INTELLIGENCE_SOURCES.md), but every incident, place name, reading and id is invented:
// real provider data isn't committed (the Bureau of Meteorology's terms forbid passing it on, and
// real incidents go out of date). Places are named "Example…" so nothing can be mistaken for a real
// event. Records collected from these are marked as fixtures wherever they appear.
//
// Times are relative to `now`, so the same fixtures exercise freshness and expiry.

const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
/** "19/10/2026 3:05:00 PM" in Sydney time, as the RFS writes pubDate (approximated as UTC+11 for fixtures). */
const rfsDate = (d) => {
    const s = new Date(d.getTime() + 11 * 3_600_000);
    const h = s.getUTCHours();
    return `${pad(s.getUTCDate())}/${pad(s.getUTCMonth() + 1)}/${s.getUTCFullYear()} ${h % 12 || 12}:${pad(s.getUTCMinutes())}:00 ${h < 12 ? "AM" : "PM"}`;
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const rfsUpdated = (d) => {
    const s = new Date(d.getTime() + 11 * 3_600_000);
    return `${s.getUTCDate()} ${MONTHS[s.getUTCMonth()]} ${s.getUTCFullYear()} ${pad(s.getUTCHours())}:${pad(s.getUTCMinutes())}`;
};
const ago = (now, minutes) => new Date(now.getTime() - minutes * 60_000);

/** A small square around a point, for published areas. */
const square = (lon, lat, d = 0.02) => [
    [lon - d, lat - d],
    [lon + d, lat - d],
    [lon + d, lat + d],
    [lon - d, lat + d],
    [lon - d, lat - d],
];

export const PLACES = {
    // Inland from the coast, west of Sydney: the "Example" places used throughout the tests.
    grassFire: [150.6, -33.6],
    bushFire: [150.9, -33.2],
    crash: [151.0, -33.9],
};

export function rfsIncidents(now = new Date(), options = {}) {
    const level = options.level ?? "Watch and Act";
    const features = [
        {
            type: "Feature",
            geometry: {
                type: "GeometryCollection",
                geometries: [
                    { type: "Point", coordinates: PLACES.grassFire },
                    { type: "GeometryCollection", geometries: [{ type: "Polygon", coordinates: [square(...PLACES.grassFire, options.areaSize ?? 0.02)] }] },
                ],
            },
            properties: {
                title: "EXAMPLE RIDGE RD, EXAMPLEVILLE",
                link: "https://www.rfs.nsw.gov.au/fire-information/fires-near-me",
                category: level,
                guid: "https://incidents.rfs.nsw.gov.au/api/v1/incidents/900001",
                guid_isPermaLink: "true",
                pubDate: rfsDate(ago(now, 120)),
                description: `ALERT LEVEL: ${level} <br />LOCATION: EXAMPLE RIDGE RD, EXAMPLEVILLE NSW 2999 <br />COUNCIL AREA: Example Shire <br />STATUS: ${options.status ?? "Out of control"} <br />TYPE: Grass Fire <br />FIRE: Yes <br />SIZE: 120 ha <br />RESPONSIBLE AGENCY: Rural Fire Service <br />UPDATED: ${rfsUpdated(ago(now, 30))}`,
            },
        },
        {
            type: "Feature",
            geometry: { type: "Point", coordinates: PLACES.bushFire },
            properties: {
                title: "EXAMPLE CREEK",
                link: "https://www.rfs.nsw.gov.au/fire-information/fires-near-me",
                category: "Advice",
                guid: "https://incidents.rfs.nsw.gov.au/api/v1/incidents/900002",
                pubDate: rfsDate(ago(now, 600)),
                description: `ALERT LEVEL: Advice <br />LOCATION: EXAMPLE CREEK NSW 2998 <br />COUNCIL AREA: Example Shire <br />STATUS: Being controlled <br />TYPE: Bush Fire <br />FIRE: Yes <br />SIZE: 15 ha <br />RESPONSIBLE AGENCY: Rural Fire Service <br />UPDATED: ${rfsUpdated(ago(now, 90))}`,
            },
        },
        {
            type: "Feature",
            geometry: { type: "Point", coordinates: PLACES.crash },
            properties: {
                title: "EXAMPLE HWY, EXAMPLETOWN",
                link: "https://www.rfs.nsw.gov.au/fire-information/fires-near-me",
                category: "Not Applicable",
                guid: "https://incidents.rfs.nsw.gov.au/api/v1/incidents/900003",
                pubDate: rfsDate(ago(now, 45)),
                description: `ALERT LEVEL: Not Applicable <br />LOCATION: EXAMPLE HWY, EXAMPLETOWN NSW 2997 <br />COUNCIL AREA: Example City <br />STATUS: Under control <br />TYPE: MVA/Transport <br />FIRE: No <br />SIZE: 0 ha <br />RESPONSIBLE AGENCY: Fire and Rescue NSW <br />UPDATED: ${rfsUpdated(ago(now, 40))}`,
            },
        },
    ];
    return JSON.stringify({ type: "FeatureCollection", features: features.filter((_, i) => !(options.drop ?? []).includes(i)) });
}

export function rfsFireDanger(options = {}) {
    const d = (name, region, councils, today, tomorrow, banToday, banTomorrow) =>
        `  <District>\n    <Name>${name}</Name>\n    <RegionNumber>${region}</RegionNumber>\n    <Councils>${councils}</Councils>\n    <DangerLevelToday>${today}</DangerLevelToday>\n    <DangerLevelTomorrow>${tomorrow}</DangerLevelTomorrow>\n    <FireBanToday>${banToday}</FireBanToday>\n    <FireBanTomorrow>${banTomorrow}</FireBanTomorrow>\n  </District>`;
    return [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        "<FireDangerMap>",
        d("Example Ranges", "90", "Example Shire; Example City", options.today ?? "EXTREME", "HIGH", options.ban ?? "Yes", "No"),
        d("Example Coast", "91", "Example Bay", "MODERATE", "MODERATE", "No", "No"),
        d("Example Plains", "92", "Example Flat", "NONE", "NONE", "No", "No"),
        "</FireDangerMap>",
    ].join("\n");
}

/** The real feed says UTF-16 and is sent as UTF-8; the fixture does the same. */
export function rfsMajorUpdates(now = new Date(), options = {}) {
    const item = options.empty
        ? `<item><guid isPermaLink="false">0</guid><link>https://www.rfs.nsw.gov.au/fire-information/major-fire-updates/</link><title>No Major Fires</title><description>There are currently no Major Fire Updates.</description><a10:updated>${iso(now).replace("Z", "+00:00")}</a10:updated></item>`
        : `<item><guid isPermaLink="false">mfu-900001</guid><link>https://www.rfs.nsw.gov.au/fire-information/major-fire-updates/</link><title>EXAMPLE RIDGE RD FIRE UPDATE</title><description>&lt;p&gt;Crews are working on the Example Ridge Rd fire.&lt;/p&gt;</description><a10:updated>${iso(ago(now, 20)).replace("Z", "+00:00")}</a10:updated></item>`;
    return `<?xml version="1.0" encoding="utf-16"?><rss xmlns:a10="http://www.w3.org/2005/Atom" version="2.0"><channel><title>NSW RURAL FIRE SERVICE - Major Fire Updates</title><link>https://www.rfs.nsw.gov.au/feeds/Major-Fire-Updates.xml</link><description>Fixture</description><lastBuildDate>${new Date(now.getTime() - 10 * 60_000).toUTCString()}</lastBuildDate>${item}</channel></rss>`;
}

export function rfsIncidentAlerts(now = new Date(), options = {}) {
    const [lon, lat] = PLACES.grassFire;
    const ring = square(lon, lat, 0.05)
        .map(([x, y]) => `${y},${x}`)
        .join(" ");
    const alert = (id, msgType, level) => `
    <contentObject><xmlContent><embeddedXMLContent>
      <alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">
        <identifier>${id}</identifier><sender>webmaster@rfs.nsw.gov.au</sender><sent>${iso(ago(now, 15)).replace("Z", "+00:00")}</sent>
        <status>Actual</status><msgType>${msgType}</msgType><scope>Public</scope>
        <info>
          <category>Fire</category><event>Grass Fire</event><urgency>Immediate</urgency><severity>Severe</severity><certainty>Observed</certainty>
          <headline>${level}: Example Ridge Rd, Exampleville</headline>
          <description>An invented fixture alert. &lt;b&gt;Never&lt;/b&gt; real.</description>
          <instruction>Fixture instruction.</instruction>
          <web>https://www.rfs.nsw.gov.au/fire-information/fires-near-me</web>
          <parameter><valueName>AlertLevel</valueName><value>${level}</value></parameter>
          <parameter><valueName>IncidentId</valueName><value>900001</value></parameter>
          <area><areaDesc>Exampleville and surrounds</areaDesc><polygon>${ring}</polygon></area>
        </info>
      </alert>
    </embeddedXMLContent></xmlContent></contentObject>`;
    const alerts = options.cancel
        ? alert("RFS-900001-2", "Cancel", options.level ?? "Watch and Act")
        : options.none
          ? ""
          : alert("RFS-900001-1", "Alert", options.level ?? "Watch and Act");
    return `<EDXLDistribution xmlns="urn:oasis:names:tc:emergency:EDXL:DE:1.0">
  <distributionID>CurrentIncidentAlerts-fixture</distributionID><senderID>webmaster@rfs.nsw.gov.au</senderID>
  <dateTimeSent>${iso(ago(now, 10)).replace("Z", "+00:00")}</dateTimeSent><distributionStatus>Actual</distributionStatus><distributionType>Report</distributionType>
  <combinedConfidentiality>OFFICIAL</combinedConfidentiality>${alerts}
</EDXLDistribution>`;
}

// --- Bureau of Meteorology (FTP products) ----------------------------------------------------------

export function bomAmocWarning(now = new Date(), options = {}) {
    const expiry = options.expired ? ago(now, 60) : new Date(now.getTime() + 12 * 3_600_000);
    return `<?xml version="1.0" encoding="UTF-8"?>
<amoc version="1.7">
  <source><sender>Australian Government Bureau of Meteorology</sender><region>New South Wales</region><office>NSWRO</office><copyright>http://www.bom.gov.au/other/copyright.shtml</copyright></source>
  <identifier>IDN21033</identifier>
  <issue-time-utc>${iso(ago(now, 25))}</issue-time-utc>
  <sent-time>${iso(ago(now, 24))}</sent-time>
  <expiry-time>${iso(expiry)}</expiry-time>
  <status>O</status><service>WSF</service><sub-service>WSW</sub-service><product-type>W</product-type><phase>${options.phase ?? "NEW"}</phase>
  <hazard index="1" parent-aac="NSW_FA001" phase="${options.phase ?? "NEW"}" type="SWW" certainty="Likely" urgency="Expected" severity="SEV">
    <area-list><area type="public-district" description="Example Hunter" aac="NSW_PW006" phase="NEW"/></area-list>
    <priority>W</priority>
    <headline>Severe Weather Warning for DAMAGING WINDS for people in the Example Hunter district.</headline>
  </hazard>
</amoc>`;
}

export const bomAmocForecast = `<?xml version="1.0" encoding="UTF-8"?>
<amoc version="1.7"><identifier>IDN11060</identifier><issue-time-utc>2026-10-19T05:00:00Z</issue-time-utc><status>O</status><service>WSP</service><product-type>F</product-type><phase>NEW</phase></amoc>`;

export function bomObservations(now = new Date()) {
    const t = iso(ago(now, 12));
    const station = (wmo, bom, name, lat, lon, district, temp, gust, rain) => `
    <station wmo-id="${wmo}" bom-id="${bom}" tz="Australia/Sydney" stn-name="${name.toUpperCase()}" stn-height="40" type="AWS" lat="${lat}" lon="${lon}" forecast-district-id="${district}" description="${name}">
      <period index="0" time-utc="${t}" time-local="${t}" wind-src="TMD">
        <level index="0" type="surface">
          <element units="Celsius" type="apparent_temp">${temp - 2}</element>
          <element units="Celsius" type="air_temperature">${temp}</element>
          <element units="%" type="rel-humidity">40</element>
          <element type="wind_dir">NW</element>
          <element units="km/h" type="wind_spd_kmh">30</element>
          <element units="km/h" type="gust_kmh">${gust}</element>
          <element units="hPa" type="msl_pres">1009.2</element>
          <element units="mm" type="rainfall">${rain}</element>
        </level>
      </period>
    </station>`;
    return `<?xml version="1.0"?>
<product version="v1.7.1">
  <amoc><source><sender>Australian Government Bureau of Meteorology</sender></source><identifier>IDN60920</identifier><issue-time-utc>${iso(ago(now, 10))}</issue-time-utc><status>O</status><service>WSP</service><product-type>O</product-type><phase>NEW</phase></amoc>
  <observations>${station("99001", "099001", "Exampleville Airport", -33.62, 150.61, "NSW_PW006", 38.5, 76, 0)}${station("99002", "099002", "Example Heads", -33.9, 151.3, "NSW_PW005", 27.1, 52, 3.2)}${station("99003", "099003", "Example Flat", -32.0, 147.0, "NSW_PW013", 35.0, 41, 0)}
  </observations>
</product>`;
}

export const bomListing = (now = new Date(), names = ["IDN21033.amoc.xml", "IDN11060.amoc.xml"]) =>
    names.map((name, i) => ({ name, modified: `${new Date(now.getTime() - (i + 1) * 60_000).toISOString().slice(0, 16)}:00Z`, size: 1300 }));

// --- Water Data Online (SOS 2.0) -----------------------------------------------------------------------

export const wdoFeature = `<sos:GetFeatureOfInterestResponse xmlns:sos="http://www.opengis.net/sos/2.0" xmlns:gml="http://www.opengis.net/gml/3.2" xmlns:sams="http://www.opengis.net/samplingSpatial/2.0"><sos:featureMember><sams:SF_SpatialSamplingFeature gml:id="f1"><gml:name>EXAMPLE R @ EXAMPLEVILLE</gml:name><sams:shape><gml:Point gml:id="p1"><gml:pos>-33.61 150.63</gml:pos></gml:Point></sams:shape></sams:SF_SpatialSamplingFeature></sos:featureMember></sos:GetFeatureOfInterestResponse>`;

export function wdoObservation(now = new Date(), levels = [1.2, 1.25, 1.31, 1.9]) {
    const points = levels
        .map(
            (v, i) =>
                `<wml2:point><wml2:MeasurementTVP><wml2:time>${iso(ago(now, (levels.length - i) * 60)).replace("Z", "+00:00")}</wml2:time><wml2:value>${v}</wml2:value><wml2:metadata><wml2:TVPMeasurementMetadata><wml2:qualifier xlink:href="http://bom.gov.au/waterdata/services/qualifier/140" xlink:title="140"/></wml2:TVPMeasurementMetadata></wml2:metadata></wml2:MeasurementTVP></wml2:point>`,
        )
        .join("");
    return `<sos:GetObservationResponse xmlns:sos="http://www.opengis.net/sos/2.0" xmlns:wml2="http://www.opengis.net/waterml/2.0" xmlns:om="http://www.opengis.net/om/2.0" xmlns:xlink="http://www.w3.org/1999/xlink"><sos:observationData><om:OM_Observation><om:featureOfInterest xlink:href="http://bom.gov.au/waterdata/services/stations/999001" xlink:title="EXAMPLE R @ EXAMPLEVILLE"/><om:result><wml2:MeasurementTimeseries><wml2:defaultPointMetadata><wml2:DefaultTVPMeasurementMetadata><wml2:uom code="m"/></wml2:DefaultTVPMeasurementMetadata></wml2:defaultPointMetadata>${points}</wml2:MeasurementTimeseries></om:result></om:OM_Observation></sos:observationData></sos:GetObservationResponse>`;
}

// --- Geoscience Australia ----------------------------------------------------------------------------

export function gaEarthquakes(now = new Date()) {
    const q = (id, lon, lat, mag, desc, inAu, minutes) => ({
        type: "Feature",
        id: `earthquakes_seven_days.${id}`,
        geometry: { type: "Point", coordinates: [lon, lat] },
        properties: {
            event_id: id,
            origin_time: iso(ago(now, minutes)),
            event_creation_time: iso(ago(now, minutes - 5)),
            event_modification_time: iso(ago(now, minutes - 10)),
            preferred_magnitude: mag,
            preferred_magnitude_type: "ML",
            depth: 10,
            description: desc,
            located_in_australia: inAu,
            evaluation_status: "confirmed",
            evaluation_mode: "manual",
            display_flag: "Y",
            max_horizontal_uncertainty: 2.5,
            felt_report_url: `https://earthquakes.ga.gov.au/feltreport/${id}`,
        },
    });
    return JSON.stringify({
        type: "FeatureCollection",
        features: [
            q("ga2026fix001", 150.2, -33.9, 3.4, "Exampleton, NSW", "Y", 300),
            q("ga2026fix002", 170.1, -20.3, 5.6, "Offshore Example Islands", "N", 2000),
        ],
    });
}

export function deaHotspots(now = new Date(), count = 3) {
    const [lon, lat] = PLACES.grassFire;
    const features = Array.from({ length: count }, (_, i) => ({
        type: "Feature",
        id: `hotspots_three_days.fix-${i}`,
        geometry: { type: "Point", coordinates: [lon + 0.01 * i, lat + 0.005 * i] },
        properties: {
            id: 990000 + i,
            satellite: "HIMAWARI-9",
            sensor: "AHI",
            product: "BRIGHT AHI",
            datetime: iso(ago(now, 40 + i)),
            load_dt: iso(ago(now, 30)),
            confidence: 80,
            temp_kelvin: 330.5,
            power: 52.1,
            accuracy: "± 2km",
            australian_state: "NSW",
        },
    }));
    return JSON.stringify({ type: "FeatureCollection", features, totalFeatures: features.length });
}

// --- NSW air quality, Endeavour, ACT, NOAA ---------------------------------------------------------------

export const aqSites = JSON.stringify([
    { Site_Id: 9001, SiteName: "EXAMPLEVILLE", Longitude: 150.62, Latitude: -33.61, Region: "Example West" },
    { Site_Id: 9002, SiteName: "EXAMPLE HEADS", Longitude: 151.29, Latitude: -33.91, Region: "Example East" },
]);

export function aqObservations(now = new Date()) {
    const local = new Date(now.getTime() + 11 * 3_600_000);
    const date = local.toISOString().slice(0, 10);
    const hour = Math.max(1, local.getUTCHours());
    const row = (site, code, value, category) => ({
        Site_Id: site,
        Parameter: {
            ParameterCode: code,
            ParameterDescription: code,
            Units: "µg/m³",
            Category: "Averages",
            SubCategory: "Hourly",
            Frequency: "Hourly average",
        },
        Date: date,
        Hour: hour,
        HourDescription: `${hour - 1} - ${hour}`,
        Value: value,
        AirQualityCategory: category,
        DeterminingPollutant: null,
    });
    return JSON.stringify([
        row(9001, "PM2.5", 62.4, "POOR"),
        row(9001, "PM10", 80.1, "FAIR"),
        row(9001, "OZONE", 3.1, "GOOD"),
        row(9002, "PM2.5", 7.2, "GOOD"),
    ]);
}

export function endeavour(now = new Date()) {
    const local = (d) => new Date(d.getTime() + 11 * 3_600_000).toISOString().slice(0, 16).replace("T", " ");
    return JSON.stringify({
        total_count: 1,
        results: [
            {
                incident_id: "INC 900000001",
                incident_status: "OPEN",
                outage_type: "UNPLANNED",
                cause: "None",
                street_name: "EXAMPLE ST",
                cityname: "EXAMPLEVILLE",
                postcode: "2999",
                customers_affected: 140,
                start_date_time: local(ago(now, 50)),
                est_restore_time: local(new Date(now.getTime() + 3 * 3_600_000)),
                end_date_time: "1970-01-01 00:00",
                updated_at: local(ago(now, 5)),
                latitude: -33.605,
                longitude: 150.61,
            },
        ],
    });
}

export function actIncidents(now = new Date()) {
    const s = new Date(now.getTime() + 11 * 3_600_000);
    const stamp = `${s.getUTCDate()} ${MONTHS[s.getUTCMonth()]} ${s.getUTCFullYear()} ${pad(s.getUTCHours())}:${pad(s.getUTCMinutes())}:00`;
    const item = (
        guid,
        title,
        type,
        agency,
        lat,
        lon,
    ) => `<item><title>${title}</title><link>https://esa.act.gov.au/feeds/currentincidents.xml</link><type>${type}</type><agency>${agency}</agency><description>Incident: ${title}&#xD;
Location: EXAMPLE&#xD;
Status: Resource Allocation Pending&#xD;
Suburb: EXAMPLE&#xD;
Type: ${type}&#xD;
Agency: ${agency}&#xD;
Updated: ${stamp}&#xD;
Time of Call: ${stamp}</description><guid>${guid}</guid><pubDate>fixture</pubDate><georss:point xmlns:georss="http://www.georss.org/georss">${lat} ${lon}</georss:point><resourceStatus>On Scene</resourceStatus><controlStatus>Not Applicable</controlStatus></item>`;
    return `<?xml version="1.0"?><rss version="2.0"><channel><title>Incidents in ACT GeoRSS Feed</title>${item("ACT-FIX-1", "GRASS FIRE - EXAMPLE", "GRASS FIRE", "ACT Rural Fire Service", -35.3, 149.0)}${item("ACT-FIX-2", "AMBULANCE RESPONSE - EXAMPLE", "AMBULANCE RESPONSE", "Ambulance", -35.25, 149.1)}</channel></rss>`;
}

export function noaaKp(now = new Date()) {
    const t = (h) => new Date(now.getTime() - h * 3_600_000).toISOString().slice(0, 19);
    return JSON.stringify([
        { time_tag: t(6), Kp: 2.33, a_running: 9, station_count: 8 },
        { time_tag: t(3), Kp: 5.67, a_running: 56, station_count: 8 },
    ]);
}

export function noaaAlerts(now = new Date()) {
    const t = new Date(now.getTime() - 3_600_000).toISOString().replace("T", " ").slice(0, 23);
    return JSON.stringify([
        {
            product_id: "K05W",
            issue_datetime: t,
            message:
                "Space Weather Message Code: WARK05\r\nSerial Number: 9001\r\nIssue Time: fixture\r\n\r\nWARNING: Geomagnetic K-index of 5 expected (fixture)\r\n",
        },
    ]);
}

export function tfnswHazards(now = new Date(), type = "incident") {
    if (type !== "incident" && type !== "flood") return JSON.stringify({ type: "FeatureCollection", features: [] });
    return JSON.stringify({
        type: "FeatureCollection",
        features: [
            {
                type: "Feature",
                id: type === "flood" ? 800002 : 800001,
                geometry: { type: "Point", coordinates: type === "flood" ? [150.64, -33.62] : [150.62, -33.58] },
                properties: {
                    headline: type === "flood" ? "FLOODING Example Rd closed" : "Example Ridge Rd closed due to grass fire",
                    displayName: "Example Ridge Rd",
                    mainCategory: type === "flood" ? "Flooding" : "Fire",
                    created: now.getTime() - 3_600_000,
                    lastUpdated: now.getTime() - 600_000,
                    isEnded: false,
                    isMajor: true,
                    adviceA: "Avoid the area",
                    roads: [{ mainStreet: "Example Ridge Rd", suburb: "Exampleville", region: "SYD_WEST" }],
                },
            },
        ],
    });
}

export function firmsCsv(now = new Date()) {
    const d = new Date(now.getTime() - 2 * 3_600_000);
    const date = d.toISOString().slice(0, 10);
    const time = `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
    return `latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight\n-33.601,150.602,340.2,0.4,0.37,${date},${time},N,VIIRS,n,2.0NRT,290.1,12.3,D\n`;
}

/**
 * The whole set as a URL → body map, for a fake transport (tests) or the local mock server
 * (scripts/mock-feeds.mjs). FTP files are under ftp/<host>/<path>.
 */
export function feedFixtures(now = new Date()) {
    return {
        "https://www.rfs.nsw.gov.au/feeds/majorIncidents.json": rfsIncidents(now),
        "https://www.rfs.nsw.gov.au/feeds/fdrToban.xml": rfsFireDanger(),
        "https://www.rfs.nsw.gov.au/feeds/major-Fire-Updates.xml": rfsMajorUpdates(now),
        "https://www.rfs.nsw.gov.au/feeds/IncidentAlerts.xml": rfsIncidentAlerts(now),
        "https://earthquakes.ga.gov.au/geoserver/earthquakes/wfs": gaEarthquakes(now),
        "https://hotspots.dea.ga.gov.au/geoserver/public/wfs": deaHotspots(now),
        "https://data.airquality.nsw.gov.au/api/Data/get_SiteDetails": aqSites,
        "https://data.airquality.nsw.gov.au/api/Data/get_Observations": aqObservations(now),
        "https://data.endeavourenergy.com.au/api/explore/v2.1/catalog/datasets/outagecustomerlive/records": endeavour(now),
        "https://www.esa.act.gov.au/feeds/currentincidents.xml": actIncidents(now),
        "https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json": noaaKp(now),
        "https://services.swpc.noaa.gov/products/alerts.json": noaaAlerts(now),
        "ftp://ftp.bom.gov.au/anon/gen/fwo/IDN21033.amoc.xml": bomAmocWarning(now),
        "ftp://ftp.bom.gov.au/anon/gen/fwo/IDN11060.amoc.xml": bomAmocForecast,
        "ftp://ftp.bom.gov.au/anon/gen/fwo/IDN60920.xml": bomObservations(now),
    };
}
