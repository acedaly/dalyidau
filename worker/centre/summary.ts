// The dashboard's headline numbers, counted straight from current records. Nothing here is
// estimated or decorative: a count is what the sources published, and a section whose source isn't
// active says it isn't available instead of showing zero.
import type { D1Database } from "@cloudflare/workers-types";
import type { CentreSummary, SourceHealth } from "../../src/shared/centre/types";
import { FIRE_DANGER_RATINGS, fireDangerRank } from "../../src/shared/centre/types";
import { AQ_CATEGORIES } from "./adapters/regional";

const active = (health: SourceHealth[], id: string) => {
    const s = health.find((h) => h.source.id === id)?.status;
    return s === "active" || s === "stale" || s === "error";
};

export async function centreSummary(db: D1Database, health: SourceHealth[], now = new Date()): Promise<CentreSummary> {
    const since24 = new Date(now.getTime() - 86_400_000).toISOString();
    const since7 = new Date(now.getTime() - 7 * 86_400_000).toISOString();
    const [byKind, ratings, weather, power, air, hotspots, quakes, changes] = await Promise.all([
        db
            .prepare(
                "SELECT kind, source_id, COALESCE(warning_level, '') AS level, COUNT(*) AS n FROM ic_records WHERE active = 1 AND kind IN ('incident', 'warning') GROUP BY kind, source_id, level",
            )
            .all<{ kind: string; source_id: string; level: string; n: number }>(),
        db.prepare("SELECT attrs, updated_at FROM ic_records WHERE active = 1 AND kind = 'rating'").all<{ attrs: string; updated_at: string | null }>(),
        db
            .prepare("SELECT COUNT(*) AS stations, MAX(observed_at) AS latest FROM ic_records WHERE active = 1 AND source_id = 'bom-observations'")
            .first<{ stations: number; latest: string | null }>(),
        db
            .prepare(
                "SELECT COUNT(*) AS n, COALESCE(SUM(json_extract(metrics, '$[0].value')), 0) AS customers FROM ic_records WHERE active = 1 AND category = 'power'",
            )
            .first<{ n: number; customers: number }>(),
        db
            .prepare("SELECT status, observed_at FROM ic_records WHERE active = 1 AND category = 'air'")
            .all<{ status: string | null; observed_at: string | null }>(),
        db.prepare("SELECT COUNT(*) AS n FROM ic_records WHERE active = 1 AND kind = 'detection' AND observed_at >= ?").bind(since24).first<{ n: number }>(),
        db
            .prepare(
                "SELECT COUNT(*) AS n, MAX(json_extract(metrics, '$[0].value')) AS largest FROM ic_records WHERE category = 'earthquake' AND observed_at >= ? AND json_extract(attrs, '$.inAustralia') = 'yes'",
            )
            .bind(since7)
            .first<{ n: number; largest: number | null }>(),
        db.prepare("SELECT COUNT(*) AS n FROM ic_changes WHERE at >= ? AND record_id IS NOT NULL").bind(since24).first<{ n: number }>(),
    ]);
    const incidents = byKind.results.filter((r) => r.kind === "incident");
    const warnings = byKind.results.filter((r) => r.kind === "warning");
    const tally = (rows: typeof incidents) =>
        rows.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.level || "No level"]: (acc[r.level || "No level"] ?? 0) + r.n }), {});
    const parsed = ratings.results.map((r) => ({ a: JSON.parse(r.attrs) as Record<string, string>, updated: r.updated_at }));
    const highest = (key: "today" | "tomorrow") => FIRE_DANGER_RATINGS[Math.max(0, ...parsed.map((p) => fireDangerRank(p.a[key])))];
    const airCategories = air.results.map((r) => (r.status ?? "").toUpperCase()).filter((c) => AQ_CATEGORIES.includes(c));
    const worst = airCategories.sort((a, b) => AQ_CATEGORIES.indexOf(b) - AQ_CATEGORIES.indexOf(a))[0];
    const transport = await db
        .prepare("SELECT COUNT(*) AS n FROM ic_records WHERE active = 1 AND category = 'transport' AND json_extract(attrs, '$.closure') = 'yes'")
        .first<{ n: number }>();
    return {
        generatedAt: now.toISOString(),
        incidents: { active: incidents.reduce((n, r) => n + r.n, 0), byLevel: tally(incidents) },
        warnings: {
            active: warnings.reduce((n, r) => n + r.n, 0),
            byLevel: tally(warnings),
            bySource: warnings.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.source_id]: (acc[r.source_id] ?? 0) + r.n }), {}),
        },
        fireDanger: {
            highestToday: highest("today"),
            highestTomorrow: highest("tomorrow"),
            bansToday: parsed.filter((p) => p.a.banToday === "yes").length,
            bansTomorrow: parsed.filter((p) => p.a.banTomorrow === "yes").length,
            updatedAt:
                parsed
                    .map((p) => p.updated)
                    .filter((x): x is string => !!x)
                    .sort()
                    .pop() ?? null,
            available: active(health, "rfs-fire-danger") && parsed.length > 0,
        },
        weather: {
            warnings: warnings.filter((w) => w.source_id === "bom-warnings").reduce((n, r) => n + r.n, 0),
            stations: weather?.stations ?? 0,
            latestObservation: weather?.latest ?? null,
        },
        transport: { closures: transport?.n ?? 0, available: active(health, "tfnsw-live-traffic") },
        power: { outages: power?.n ?? 0, customers: power?.customers ?? 0, available: active(health, "endeavour-outages") },
        air: {
            worstCategory: worst ? worst.charAt(0) + worst.slice(1).toLowerCase() : null,
            sites: air.results.length,
            latestObservation:
                air.results
                    .map((r) => r.observed_at)
                    .filter((x): x is string => !!x)
                    .sort()
                    .pop() ?? null,
        },
        hotspots: { last24h: hotspots?.n ?? 0 },
        earthquakes: { last7d: quakes?.n ?? 0, largest: quakes?.largest ?? null },
        changes24h: changes?.n ?? 0,
        staleSources: health.filter((h) => h.status === "stale" || h.status === "error").length,
        activeSources: health.filter((h) => h.status === "active").length,
    };
}
