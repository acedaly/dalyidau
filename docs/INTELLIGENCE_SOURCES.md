# Intelligence Centre: public sources

The source inventory for the [Intelligence Centre](INTELLIGENCE_CENTRE.md): every public dataset investigated for Milestone 9, whether it's used, and the evidence for each decision. The registry in the code (`src/shared/centre/sources.ts`) holds the same entries. The portal's **Sources** page shows them, with each one's live status.

**Rules applied.** A source is used only if it's published by the responsible agency, machine-readable, reachable from a Cloudflare Worker, and its terms allow this use. This use is a private household portal: two signed-in people, not republished to the public. Publicly viewable isn't the same as licensed for automated collection. Undocumented endpoints behind agencies' own websites weren't used, even where they answer. Where the terms couldn't be confirmed, the source is implemented but marked **Awaiting verification**, and the owner decides. Nothing was scraped. No endpoint was invented: every one below was requested during development (19 October 2026, read-only, a handful of requests each, with a descriptive User-Agent) or, for keyed APIs, probed without a key.

## Summary

| Group                                                              | Sources                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Implemented and live-tested**                                    | NSW RFS current incidents, Fire Danger Ratings and Total Fire Bans, Major Fire Updates, Incident alerts (EDXL/CAP); BoM NSW warnings and observations (anonymous FTP); BoM Water Data Online; Geoscience Australia earthquakes; DEA Hotspots; NSW air quality; Endeavour Energy outages; ACT ESA incidents; NOAA space weather |
| **Implemented, needs free registration** (not live-tested: no key) | Transport for NSW Live Traffic hazards (`TFNSW_API_KEY`); NASA FIRMS (`NASA_FIRMS_MAP_KEY`)                                                                                                                                                                                                                                    |
| **Implemented, awaiting the owner's verification of terms**        | BoM warnings, BoM observations, BoM Water Data Online, ACT ESA incidents (they work; the terms need the owner's confirmation)                                                                                                                                                                                                  |
| **Needs the provider's permission**                                | NSW SES HazardWatch warnings; VicEmergency                                                                                                                                                                                                                                                                                     |
| **Needs registration to see the API**                              | WaterNSW                                                                                                                                                                                                                                                                                                                       |
| **Unsupported (no permitted interface)**                           | Ausgrid and Essential Energy outages; the BoM website's RSS/JSON and radar                                                                                                                                                                                                                                                     |
| **Deferred** (not investigated in depth this milestone)            | Queensland, South Australia, Western Australia, Tasmania and Northern Territory emergency feeds; BoM Space Weather API; TfNSW traffic cameras; telecommunications and water-supply outages                                                                                                                                     |

## Statuses

Shown for every source on the Sources page, worked out on every request (`statusOf` in `worker/centre/store.ts`):

| Status                  | Meaning                                                                                                          |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Active                  | Switched on, and the last retrieval was fetched, parsed and validated within the source's freshness limit        |
| Awaiting verification   | Switched on, but no retrieval has succeeded yet. **A source is never Active before a real, validated retrieval** |
| Needs free registration | Needs a key that hasn't been added as a Worker secret                                                            |
| Disabled                | Implemented and eligible, switched off (the default for every source)                                            |
| Unavailable             | The provider keeps answering "not found"                                                                         |
| Restricted              | Exists, but needs the provider's permission                                                                      |
| Unsupported             | No permitted machine-readable interface                                                                          |
| Stale                   | No successful retrieval for longer than the source's limit (shown prominently everywhere its data appears)       |
| Error                   | The last attempt failed. The data shown is from the last success, with its age                                   |

## Implemented sources

Live results are from 19 October 2026, collected through the Worker running locally in workerd (the same code that would run in production) against the real services.

### NSW Rural Fire Service: four feeds

- **Provider and documentation:** NSW RFS, [Feeds](https://www.rfs.nsw.gov.au/news-and-media/stay-up-to-date/feeds), "Information for application developers and warning republishers".
- **Licence:** CC BY 4.0 (RFS copyright page and the feeds page). Required attribution: "© State of New South Wales (NSW Rural Fire Service). For current information go to www.rfs.nsw.gov.au." It appears with every RFS record, in the portal, in MCP results and on wallboards. The RFS asks republishers to follow its Guideline for Warnings Republishers. Official wording is kept as published: only markup is removed, and levels are never changed.

| Feed                 | Endpoint                                                  | Format                                                      | Live result                                                                                                                               |
| -------------------- | --------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Current incidents    | `https://www.rfs.nsw.gov.au/feeds/majorIncidents.json`    | GeoJSON (a point, plus published polygons where they exist) | 200, 34.7 KB, ETag and Last-Modified sent; 9 incidents parsed (one at Advice, the rest planned burns or no level; polygons on 5)          |
| Fire Danger and bans | `https://www.rfs.nsw.gov.au/feeds/fdrToban.xml`           | XML, one `District` per fire weather district               | 200, 21 districts (Moderate or No rating, no bans that day)                                                                               |
| Major Fire Updates   | `https://www.rfs.nsw.gov.au/feeds/major-Fire-Updates.xml` | RSS                                                         | 200, the "No Major Fires" placeholder (skipped). The feed **declares UTF-16 but is sent as UTF-8**, so text is decoded by byte order mark |
| Incident alerts      | `https://www.rfs.nsw.gov.au/feeds/IncidentAlerts.xml`     | EDXL-DE envelope carrying CAP-AU alerts                     | 200, an empty envelope (no alerts that day). **CAP parsing is tested only against fixtures** built to the CAP-AU format                   |

Not used: the `incidents.rfs.nsw.gov.au/api/v1` addresses inside the feed's `guid` field. They're undocumented. The district polygons the Fires Near Me map draws aren't published in these feeds, so districts are never drawn.

### Bureau of Meteorology: anonymous FTP (warnings and observations)

- **Evidence:** the BoM website answers automated requests with 403 and a page directing them to the [anonymous FTP service](https://www.bom.gov.au/catalogue/anon-ftp.shtml) ("free to access, but use is subject to the default terms of the Bureau's copyright notice") or to the paid Registered User service. The [Anonymous FTP Service user guide](https://www.bom.gov.au/catalogue/Bureau_of_Meteorology_Anonymous_FTP_Service_user_guide.pdf) and the [copyright notice](https://www.bom.gov.au/copyright) say the default terms allow downloading and using the material **for personal use or within your organisation**, and **not supplying it to others or using it commercially**. The copyright page itself couldn't be fetched (403 to automated clients), so these terms come from the user guide and search results quoting it.
- **Decision:** implemented, marked **Awaiting verification**. A private two-person household portal looks like personal use, but the owner should confirm that before switching it on. Wallboards in the home and the owner's own AI assistants are the same people. Never republish BoM data publicly. Its records carry "Personal use; not for redistribution". **No real BoM data is committed to this repository**: the fixtures are invented.
- **Access from Workers:** `fetch()` can't do FTP, so `worker/centre/ftp.ts` is a minimal read-only FTP client over Workers TCP sockets (`cloudflare:sockets`). It logs in anonymously, uses `EPSV` (the data connection goes to the same host, never to an address the server supplies), lists a directory with a pattern, and retrieves files with byte limits and a deadline. The server supports `EPSV`, `MDTM` and `SIZE`. Listing times act as the conditional request: nothing unchanged is downloaded again.

| Product      | What                                                                                                                                                     | Live result                                                                                                                                                                                                                                                                                                              |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Warnings     | `/anon/gen/fwo/IDN*.amoc.xml`: each product's small metadata sidecar (about 1 KB) gives its type (W for warnings), headline, districts, phase and expiry | Listed and classified through the Worker: 63 NSW products, all forecasts (F). **No NSW warning was in force**, so the warning parser was checked against a live Victorian warning sidecar (`IDV20600.amoc.xml`) and NT (`IDD21013.amoc.xml`) for structure, and is tested with an invented NSW fixture in that structure |
| Observations | `/anon/gen/fwo/IDN60920.xml`: latest observations for about 200 NSW and ACT stations                                                                     | 539 KB; **196 stations** parsed through the Worker's socket FTP client, each with its own observation time and BoM forecast district                                                                                                                                                                                     |

Warnings are text with forecast-district codes (`NSW_PW…`, marine `NSW_MW…`). **No warning polygon is drawn**, because the Bureau doesn't publish one here. They carry no Australian Warning System level in this product, and none is assigned. A warning ends at the Bureau's own expiry time or when it's marked cancelled (`CAN`).

### Bureau of Meteorology: Water Data Online

- **Documentation:** [Water Data Online](https://www.bom.gov.au/waterdata/), SOS 2.0 web services at `https://www.bom.gov.au/waterdata/services`. Unlike the rest of the website, it answered automated requests.
- **What:** `GetFeatureOfInterest` (the station's location) and `GetObservation` for **Water Course Level**. It uses the quality-coded merged series `Pat3_C_B_1` (`DMQaQc.Merged.AsStored.1`), for stations the owner chooses in Settings (none by default).
- **Live result:** station 410001 (Murrumbidgee River at Wagga Wagga) gave a location and a quality-coded series (quality code 140). The newest reading was **about two days old**. This is historical context, not real-time flood information, and the pages say so.
- **Licence:** water information is covered by the Water Regulations 2008, and the user guide says many observations are under a Creative Commons licence. The exact licence for these series wasn't confirmed, so the source is **Awaiting verification**.
- **Not done:** flood classification levels. None come with this data, so none are drawn or inferred.

### Geoscience Australia: earthquakes

- `https://earthquakes.ga.gov.au/geoserver/earthquakes/wfs?service=WFS&request=getfeature&typeNames=earthquakes:earthquakes_seven_days&outputFormat=application/json`.
- 200, 87.5 KB GeoJSON; **46 events** with event id, origin time, preferred magnitude and type, depth, location uncertainty, evaluation status and an "in Australia" flag.
- **Licence:** CC BY 4.0 (GA's earthquake product records). Every event shows its age. A past earthquake is never presented as a current threat.

### Geoscience Australia: DEA Hotspots

- `https://hotspots.dea.ga.gov.au/geoserver/public/wfs` (WFS 1.0.0, `public:hotspots_three_days`, NSW bounding box, at most 3,000 features). The "recent hotspots" JSON file is **254 MB**, so it isn't used: the WFS lets the request ask for NSW only.
- **844 detections** in NSW over three days, each with satellite, sensor, confidence, brightness temperature, radiative power and stated accuracy (often ±2 km).
- **Licence:** CC BY 4.0 per the DEA Hotspots product description. data.gov.au lists it as "not specified". The provider says it isn't for safety-of-life decisions. Detections are labelled **satellite thermal detections, not confirmed fires**, drawn as a different shape from official incidents, and never turned into areas.

### NSW air quality

- [Air quality API](https://www.airquality.nsw.gov.au/air-quality-data-services/air-quality-api): `get_SiteDetails` (139 sites) and `get_Observations` (POST: hourly averages of PM2.5, PM10 and ozone, with the provider's own `AirQualityCategory`).
- **Live result:** small requests answered in about a second. Larger ones were very slow: **five sites took 81 s, and all 139 didn't finish within 120 s**. The adapter therefore reads six sites per run in turn (fewer if the owner follows only some sites), with a 90-second timeout. Each site shows its own reading time.
- **Licence:** the API page refers to a separate data licence statement, linked from the registry. Categories are copied from the provider, never calculated, and smoke is never attributed to a fire.
- **Caveat:** hours are read as NSW local time as published. Whether the API uses standard time all year wasn't confirmed.

### Endeavour Energy: unplanned outages

- [Open data portal](https://data.endeavourenergy.com.au/): `outagecustomerlive`, through the Opendatasoft Explore API v2.1 (anonymous, documented, ODbL).
- 4 records live (2 distinct incidents), each with status, suburb, postcode, customers affected and estimated restoration time. A point per outage, not the affected area.
- **Licence:** Open Database License 1.0, attribution shown.

### ACT Emergency Services Agency: current incidents

- `https://www.esa.act.gov.au/feeds/currentincidents.xml` (GeoRSS).
- 23 items live, **all ambulance responses**, which the adapter leaves out by design (they add nothing to situational awareness), so 0 records were stored. Fire, rescue and SES incidents are kept.
- **Licence:** data.gov.au lists CC BY 3.0 AU, but a newer listing says "not specified", so the source is **Awaiting verification**.

### NOAA Space Weather Prediction Center

- `https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json` and `products/alerts.json`. US Government work (public domain).
- Kp series and the last 48 hours of SWPC messages: 4 records live. Informational only, and kept off the emergency summary.

### Transport for NSW Live Traffic hazards (needs a free key)

- [Open Data Hub: Live Traffic Hazards](https://opendata.transport.nsw.gov.au/dataset/live-traffic-hazards). Paths `/v1/live/hazards/{incident,roadwork,flood,fire,majorevent}/open` on `api.transport.nsw.gov.au`, key in `Authorization: apikey …`.
- **Probe:** every path, including a nonsense one, answered 401 without a key, so the paths come from the documentation and **are unverified until a key is added**. The adapter refuses anything that isn't a GeoJSON FeatureCollection. CC BY 4.0.
- Closures are points as published. A closure point never becomes a closed length of road, and not every local closure is in the data.

### NASA FIRMS (needs a free key)

- [FIRMS area API](https://firms.modaps.eosdis.nasa.gov/api/area/): `…/api/area/csv/{MAP_KEY}/VIIRS_SNPP_NRT/{NSW box}/1`.
- **Probe:** a placeholder key got `Invalid MAP_KEY.`, which confirms the path. Not tested with a real key. DEA Hotspots covers the same need without one.

## Investigated, not implemented

| Source                                          | Finding                                                                                                                                                                                                                                                                                                                                                                        | Status                                           |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| **NSW SES HazardWatch** (flood, storm, tsunami) | No documented public feed. The [Data.NSW entry](https://data.nsw.gov.au/data/en/dataset/hazard-watch/resource/d5434c60-0292-4d3f-bc1c-44ab00ba1f47) links to the website, and direct API access is by request to the SES Warnings Team (`warnings.capability@ses.nsw.gov.au`). SES warnings must be republished in full and unaltered. Not reverse-engineered from HazardWatch | Restricted: **ask the SES**, then add an adapter |
| **WaterNSW** (dams, hydrometric)                | A registered API developer portal; documentation and terms aren't visible before registering. The public dam-levels pages weren't scraped                                                                                                                                                                                                                                      | Needs registration                               |
| **VicEmergency**                                | A GeoJSON file used by its website answers publicly, but [VicEmergency support](https://support.emergency.vic.gov.au/hc/en-gb/articles/235717508-How-do-I-access-the-VicEmergency-data-feed) says its data feed isn't publicly available                                                                                                                                       | Restricted                                       |
| **Ausgrid, Essential Energy** outages           | No documented live outage API; only internal routes behind their outage maps. Ausgrid's open past-outage data is historical                                                                                                                                                                                                                                                    | Unsupported                                      |
| **BoM website** RSS, JSON, radar, satellite     | Refuses automated access (403 with a scraping notice); radar and satellite imagery need the Registered User service                                                                                                                                                                                                                                                            | Unsupported                                      |

### Deferred to a later milestone

Verified to exist, or likely, but not investigated in depth here, to finish a working NSW-first application:

- **Queensland** (QFES warnings on data.qld.gov.au), **South Australia** (CFS), **Western Australia** (Emergency WA), **Tasmania** (TasALERT) and **Northern Territory** feeds. Each needs the same check of terms and documentation.
- **BoM Space Weather Services API** (free registration). NOAA covers Kp for now.
- **TfNSW traffic cameras** (same key as Live Traffic; images, with their own terms).
- **Telecommunications and water-supply outages.** No suitable public feed was found.

## Adding a source

1. Check it against the rules above, and record the evidence here.
2. Add a registry entry in `src/shared/centre/sources.ts`: provider, dataset, categories, coverage, documentation, endpoint label, format, authentication, licence, attribution, refresh interval, stale limit, history permission, eligibility, notes and the live-test date.
3. Write an adapter in `worker/centre/adapters/`. It fetches through `safeFetch` (or the FTP client) with the source's host allow-list, validates, and returns canonical records. Then list it in `adapters/index.ts`.
4. Add invented fixtures in the provider's format to `fixtures/intelligence-centre/feeds.mjs`, plus a test in `test/centre-ingest.test.ts`.
5. Deploy. The source appears on the Sources page, switched off.
