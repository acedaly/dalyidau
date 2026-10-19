// First-render data for the Intelligence Centre's pages (/portal/intelligence-centre/*). The
// portal page router has already checked "centre.use". Anything the caller can't see returns null
// (the 404 page): someone else's watch area or wallboard, an unknown record.
import type { HazardCategory } from "../../src/shared/centre/sources";
import { CENTRE_HAZARD_TABS, type CentreHazardTab, type CentreRoute, type CentreShell } from "../../src/shared/centre/types";
import type { PortalUser } from "../../src/shared/portal/types";
import type { Env } from "../env";
import { availability, loadConfig } from "../intelligence/settings";
import { can } from "../portal/auth";
import { loadFlags } from "../portal/flags";
import { HttpError } from "../portal/http";
import { listAlerts, unacknowledgedCount } from "./alerts";
import { filteredRecords } from "./api";
import { buildBriefing, withInterpretation } from "./briefing";
import { correlations } from "./correlate";
import { getRecord, listChanges, listRecords, listRuns, loadCentreSettings, loadPreferences, seriesFor, sourceHealth } from "./store";
import { centreSummary } from "./summary";
import { listWallboards } from "./wallboard";
import { fireDistricts, listWatches, requireWatch } from "./watch";

export type CentrePage = "overview" | "map" | "records" | "record" | "hazards" | "history" | "briefings" | "watches" | "wallboards" | "sources" | "settings";

const HAZARD_CATEGORIES: Record<CentreHazardTab, HazardCategory[]> = {
    weather: ["weather"],
    "fire-danger": ["fire_danger"],
    flood: ["flood", "water"],
    transport: ["transport"],
    environment: ["air", "hotspot", "earthquake", "space_weather"],
    infrastructure: ["power"],
};

async function shell(env: Env, user: PortalUser): Promise<CentreShell> {
    const [flags, { config }, prefs, alerts, fixture] = await Promise.all([
        loadFlags(env.DB),
        loadConfig(env.DB),
        loadPreferences(env.DB, user.email),
        unacknowledgedCount(env.DB, user.email),
        env.DB.prepare("SELECT 1 FROM ic_sources WHERE fixture = 1 LIMIT 1").first(),
    ]);
    return {
        canManage: can(user, "portal.settings.manage"),
        ingestionOn: flags["intelligence_centre.ingestion"],
        wallboardOn: flags["intelligence_centre.wallboard"],
        emailOn: flags["intelligence_centre.alerts.email"],
        aiAvailable: availability(env, config).recommendations,
        preferences: prefs.preferences,
        preferencesVersion: prefs.version,
        unacknowledgedAlerts: alerts,
        fixtureData: !!fixture,
    };
}

const fireDangerOf = (records: Awaited<ReturnType<typeof listRecords>>["records"]) =>
    records
        .filter((r) => r.kind === "rating")
        .map((r) => ({
            district: r.title,
            today: r.attributes.today ?? "No rating",
            tomorrow: r.attributes.tomorrow ?? "No rating",
            banToday: r.attributes.banToday === "yes",
            banTomorrow: r.attributes.banTomorrow === "yes",
            updatedAt: r.updatedAt,
        }));

export async function loadCentrePage(env: Env, user: PortalUser, url: URL, page: CentrePage, id?: string): Promise<CentreRoute | null> {
    const base = await shell(env, user);
    const { settings, version: settingsVersion } = await loadCentreSettings(env.DB);
    switch (page) {
        case "overview": {
            const health = await sourceHealth(env);
            const related = await correlations(env.DB, settings, {});
            const [summary, warnings, changes, watches, alerts, briefing] = await Promise.all([
                centreSummary(env.DB, health),
                listRecords(env.DB, { kinds: ["warning", "incident"], minLevel: 1 }, 12),
                listChanges(env.DB, { since: new Date(Date.now() - 86_400_000).toISOString(), limit: 25 }),
                listWatches(env.DB, user.email),
                listAlerts(env.DB, user.email, { unacknowledged: true, limit: 10 }),
                buildBriefing(env, user, health, { scope: "nsw", correlations: related }).then((b) => withInterpretation(env, user, b)),
            ]);
            return {
                route: "centre-overview",
                ...base,
                summary,
                recentWarnings: warnings.records,
                changes,
                sources: health,
                watches,
                alerts,
                briefing,
                correlations: related.slice(0, 6),
            };
        }
        case "map": {
            const [{ records, truncated }, watches] = await Promise.all([
                listRecords(env.DB, { kinds: ["incident", "warning", "disruption", "detection", "event", "observation"] }, settings.maxMapRecords),
                listWatches(env.DB, user.email),
            ]);
            return { route: "centre-map", ...base, records, watches, truncated, basemap: settings.basemap };
        }
        case "records": {
            const result = await filteredRecords(env, user, url).catch((error: unknown) => {
                // Bad filters open the unfiltered list.
                if (error instanceof HttpError && error.status === 400) return filteredRecords(env, user, new URL(url.pathname, url));
                throw error;
            });
            return {
                route: "centre-records",
                ...base,
                records: result.records,
                reasons: result.reasons,
                truncated: result.truncated,
                filters: result.filters,
                watches: await listWatches(env.DB, user.email),
            };
        }
        case "record": {
            if (!id || !/^icr_[a-z0-9]{14}$/.test(id)) return null;
            const found = await getRecord(env.DB, id);
            if (!found) return null;
            const health = await sourceHealth(env);
            const [changes, series, related] = await Promise.all([
                listChanges(env.DB, { recordId: id, limit: 100 }),
                seriesFor(env.DB, id, new Date(Date.now() - settings.retention.seriesDays * 86_400_000).toISOString()),
                correlations(env.DB, settings, { recordId: id }),
            ]);
            return {
                route: "centre-record",
                ...base,
                record: found.record,
                geometry: found.geometry,
                changes,
                series,
                related,
                source: health.find((h) => h.source.id === found.record.sourceId)!,
            };
        }
        case "hazards": {
            const tab = (CENTRE_HAZARD_TABS as readonly string[]).includes(id ?? "") ? (id as CentreHazardTab) : "weather";
            const categories = HAZARD_CATEGORIES[tab];
            const health = await sourceHealth(env);
            const { records } = await listRecords(env.DB, { categories }, 1500);
            const series: { recordId: string; metric: string; points: { at: string; value: number }[] }[] = [];
            // Charts for followed river gauges and the Kp index (small, bounded).
            for (const r of records.filter((x) => x.sourceId === "bom-water" || x.externalId === "planetary-kp").slice(0, 12))
                for (const s of await seriesFor(env.DB, r.id, new Date(Date.now() - 7 * 86_400_000).toISOString())) series.push({ recordId: r.id, ...s });
            return {
                route: "centre-hazards",
                ...base,
                tab,
                records,
                fireDanger: fireDangerOf(records),
                sources: health.filter((h) => h.source.categories.some((c) => categories.includes(c))),
                series,
            };
        }
        case "history": {
            const range = url.searchParams.get("range") === "7d" ? "7d" : url.searchParams.get("range") === "30d" ? "30d" : "24h";
            const ms = range === "24h" ? 86_400_000 : range === "7d" ? 7 * 86_400_000 : 30 * 86_400_000;
            const since = new Date(Date.now() - ms).toISOString();
            const [changes, days, runs] = await Promise.all([
                listChanges(env.DB, { since, limit: 500 }),
                env.DB.prepare("SELECT substr(at, 1, 10) AS date, COUNT(*) AS count FROM ic_changes WHERE at >= ? GROUP BY date ORDER BY date")
                    .bind(new Date(Date.now() - 30 * 86_400_000).toISOString())
                    .all<{ date: string; count: number }>(),
                listRuns(env.DB, { limit: 200 }),
            ]);
            return { route: "centre-history", ...base, changes, days: days.results, runs, range };
        }
        case "briefings": {
            const health = await sourceHealth(env);
            const watches = await listWatches(env.DB, user.email);
            const watchId = url.searchParams.get("watch");
            const watch = watchId ? await requireWatch(env.DB, user.email, watchId).catch(() => null) : null;
            const related = await correlations(env.DB, settings, {});
            const briefing = await withInterpretation(
                env,
                user,
                await buildBriefing(env, user, health, { scope: watch ? "watch" : "nsw", watch, correlations: watch ? [] : related }),
            );
            return { route: "centre-briefings", ...base, briefing, watches, correlations: related };
        }
        case "watches": {
            const [watches, districts, alerts] = await Promise.all([
                listWatches(env.DB, user.email),
                fireDistricts(env.DB),
                listAlerts(env.DB, user.email, { limit: 50 }),
            ]);
            return { route: "centre-watches", ...base, watches, districts, alerts };
        }
        case "wallboards":
            return {
                route: "centre-wallboards",
                ...base,
                wallboards: await listWallboards(env.DB, user.email),
                watches: await listWatches(env.DB, user.email),
            };
        case "sources":
            return { route: "centre-sources", ...base, sources: await sourceHealth(env), runs: await listRuns(env.DB, { limit: 200 }) };
        case "settings": {
            const sites = await env.DB.prepare("SELECT json_extract(state, '$.sites') AS sites FROM ic_sources WHERE id = 'nsw-air-quality'").first<{
                sites: string | null;
            }>();
            const airSites = (JSON.parse(sites?.sites ?? "[]") as { Site_Id: number; SiteName: string; Region: string }[]).map((s) => ({
                id: s.Site_Id,
                name: s.SiteName,
                region: s.Region,
            }));
            return { route: "centre-settings", ...base, settings, settingsVersion, airSites };
        }
    }
}
