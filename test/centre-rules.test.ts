// Monitoring rules: privacy and validation (own watch areas only, stated units, knots converted,
// nothing about an area audited), deterministic evaluation with reasons, deduplication, the
// cooldown and notification choices, every condition, the switch, testing against history without
// writing anything, tasks from matches, and someone who lost access. Invented fixtures only.
import { beforeEach, describe, expect, it } from "vitest";
import { wdoFeature, wdoObservation } from "../fixtures/intelligence-centre/feeds.mjs";
import type { MonitoringRule, RuleMatch, RuleTestResult } from "../src/shared/centre/rules";
import { gustKmh } from "../src/shared/centre/rules";
import type { WatchArea } from "../src/shared/centre/types";
import { runCentreCron } from "../worker/centre/ingest";
import { evaluateRules } from "../worker/centre/rules";
import type { Env } from "../worker/env";
import { C, centreEnv, collect, enableSource, exampleWatch, fakeTransport, setFlag } from "./centre-helpers";
import { OWNER, SECOND_OWNER, apiCall, db, resetPortal } from "./portal-helpers";

beforeEach(resetPortal);

async function seed() {
    const env = await centreEnv();
    const s = (await apiCall<{ settings: Record<string, unknown>; version: number }>("GET", `${C}/settings`)).json;
    expect((await apiCall("PUT", `${C}/settings`, { settings: { ...s.settings, gauges: ["999001"] }, version: s.version })).status).toBe(200);
    const now = new Date();
    for (const id of ["rfs-incidents", "rfs-fire-danger", "bom-observations", "ga-earthquakes", "bom-water"]) {
        await enableSource(id);
        await collect(
            env,
            id,
            fakeTransport(now, {
                "https://www.bom.gov.au/waterdata/services": (url: URL) =>
                    new Response(url.searchParams.get("request") === "GetFeatureOfInterest" ? wdoFeature : wdoObservation(now, [1.2, 1.25, 1.31, 1.9])),
            }),
            now,
        );
    }
    return env;
}

const watch = async (body: Record<string, unknown> = exampleWatch({ name: "Secret Hideaway" }), email = OWNER) => {
    const r = await apiCall<{ watch: WatchArea }>("POST", `${C}/watches`, body, { email });
    expect(r.status, r.text).toBe(201);
    return r.json.watch;
};

const rule = async (body: Record<string, unknown>, email = OWNER) => {
    const r = await apiCall<{ rule: MonitoringRule }>("POST", `${C}/rules`, { lookbackMinutes: 1440, cooldownMinutes: 0, ...body }, { email });
    expect(r.status, r.text).toBe(201);
    return r.json.rule;
};

const matches = async (email = OWNER) => (await apiCall<{ matches: RuleMatch[] }>("GET", `${C}/rules/matches`, undefined, { email })).json.matches;

const evaluate = (env: Env) => evaluateRules(env, { now: new Date() });

describe("Monitoring rules: ownership and validation", () => {
    it("are private, use only the owner's own watch areas, and audit nothing about the area", async () => {
        await seed();
        const w = await watch();
        const r = await rule({ name: "Fires near the hideaway", definition: { condition: "fire_within", watchId: w.id, radiusKm: 10 } });
        expect((await apiCall<{ rules: MonitoringRule[] }>("GET", `${C}/rules`, undefined, { email: SECOND_OWNER })).json.rules).toEqual([]);
        expect((await apiCall("PUT", `${C}/rules/${r.id}`, { ...r, version: 1 }, { email: SECOND_OWNER })).status).toBe(404);
        expect((await apiCall("DELETE", `${C}/rules/${r.id}`, undefined, { email: SECOND_OWNER })).status).toBe(404);
        // Someone else's watch area can't be named in a rule.
        expect(
            (await apiCall("POST", `${C}/rules`, { name: "x", definition: { condition: "fire_within", watchId: w.id, radiusKm: 5 } }, { email: SECOND_OWNER }))
                .status,
        ).toBe(404);
        const audit = JSON.stringify((await db().prepare("SELECT summary, changes FROM audit_log WHERE action LIKE 'centre.rule%'").all()).results);
        expect(audit).not.toContain("hideaway");
        expect(audit).not.toContain("-33.6");
        expect(audit).toContain("fire_within");
    });

    it("state their units, convert knots, and refuse thresholds out of range", async () => {
        const w = await watch();
        expect(gustKmh(50, "kn")).toBe(92.6);
        const bad = async (definition: Record<string, unknown>) => (await apiCall("POST", `${C}/rules`, { name: "x", definition })).status;
        expect(await bad({ condition: "wind_gust", watchId: w.id, threshold: 90 })).toBe(422); // no unit
        expect(await bad({ condition: "wind_gust", watchId: w.id, threshold: 400, unit: "km/h" })).toBe(422);
        expect(await bad({ condition: "wind_gust", watchId: w.id, threshold: 170, unit: "kn" })).toBe(422); // 315 km/h
        expect(await bad({ condition: "gauge_threshold", station: "999001", direction: "above", threshold: 2, unit: "ft" })).toBe(422);
        expect(await bad({ condition: "temperature", watchId: w.id, direction: "above", threshold: 40, unit: "F" })).toBe(422);
        expect(await bad({ condition: "official_level", watchId: w.id, minLevel: 4 })).toBe(422);
        expect(await bad({ condition: "source_stale", sourceId: "nsw-ses-hazardwatch" })).toBe(422); // not collected
        expect(await bad({ condition: "fire_within", watchId: w.id, radiusKm: 10, lat: -33.6 })).toBe(422); // no coordinates of its own
        expect(
            (
                await apiCall("POST", `${C}/rules`, {
                    name: "x",
                    notify: "email",
                    cooldownMinutes: 5,
                    definition: { condition: "fire_within", watchId: w.id, radiusKm: 5 },
                })
            ).status,
        ).toBe(422);
        const ok = await rule({ name: "Gusts", definition: { condition: "wind_gust", watchId: w.id, threshold: 40, unit: "kn" } });
        expect(ok.definition).toMatchObject({ threshold: 40, unit: "kn" });
        expect((await apiCall("PUT", `${C}/rules/${ok.id}`, { name: "Renamed", definition: ok.definition, version: 1 })).status).toBe(200);
        expect((await apiCall("PUT", `${C}/rules/${ok.id}`, { name: "Stale", definition: ok.definition, version: 1 })).status).toBe(409);
    });
});

describe("Monitoring rules: evaluation", () => {
    it("matches an official level near a watch area once, with the reason, and again when the level rises", async () => {
        const env = await seed();
        const w = await watch();
        await rule({ name: "Watch and Act nearby", definition: { condition: "official_level", watchId: w.id, minLevel: 2, radiusKm: 5 } });
        expect(await evaluate(env)).toBe(1);
        const [m] = await matches();
        expect(m.reason).toContain("Example Ridge Rd, Exampleville: Watch and Act as published by NSW Rural Fire Service");
        expect(m.notified).toBe(true);
        // Evaluating again changes nothing.
        expect(await evaluate(env)).toBe(0);
        // The fire escalates: a new match for the new level.
        await collect(
            env,
            "rfs-incidents",
            fakeTransport(new Date(), {
                "https://www.rfs.nsw.gov.au/feeds/majorIncidents.json": (await import("../fixtures/intelligence-centre/feeds.mjs")).rfsIncidents(new Date(), {
                    level: "Emergency Warning",
                }),
            }),
        );
        expect(await evaluate(env)).toBe(1);
        // An in-portal alert for each notified match, never an email unless chosen and opted in.
        const alerts = (
            await db().prepare("SELECT kind, email_status, change_id FROM ic_alerts WHERE kind = 'rule_match'").all<{ email_status: string | null }>()
        ).results;
        expect(alerts).toHaveLength(2);
        expect(alerts.every((a) => a.email_status === null)).toBe(true);
    });

    it("records matches inside the cooldown without notifying, and never notifies with notify: none", async () => {
        const env = await seed();
        const w = await watch();
        await rule({ name: "Fires", cooldownMinutes: 120, definition: { condition: "fire_within", watchId: w.id, radiusKm: 60 } });
        await rule({ name: "Quiet", notify: "none", definition: { condition: "fire_within", watchId: w.id, radiusKm: 60 } });
        await evaluate(env);
        const list = await matches();
        const fires = list.filter((m) => m.ruleName === "Fires");
        // The grass fire and the creek fire (about 45 km away): the first notifies, the second is in the cooldown.
        expect(fires).toHaveLength(2);
        expect(fires.filter((m) => m.notified)).toHaveLength(1);
        expect(fires.find((m) => !m.notified)!.suppressed).toBe("cooldown");
        expect(list.filter((m) => m.ruleName === "Quiet").every((m) => !m.notified && m.suppressed === null)).toBe(true);
    });

    it("evaluates readings by crossing, in the rule's units, and says the threshold is the person's own", async () => {
        const env = await seed();
        const w = await watch();
        await rule({ name: "River", definition: { condition: "gauge_threshold", station: "999001", direction: "above", threshold: 1.5, unit: "m" } });
        await rule({ name: "Gusts", definition: { condition: "wind_gust", watchId: w.id, threshold: 40, unit: "kn" } }); // 74.1 km/h; observed 76
        await rule({ name: "Too strong", definition: { condition: "wind_gust", watchId: w.id, threshold: 45, unit: "kn" } }); // 83.3 km/h
        await rule({ name: "Hot", definition: { condition: "temperature", watchId: w.id, direction: "above", threshold: 38, unit: "°C" } });
        await evaluate(env);
        const list = await matches();
        expect(list.find((m) => m.ruleName === "River")).toMatchObject({ observedValue: 1.9, threshold: 1.5, unit: "m" });
        expect(list.find((m) => m.ruleName === "River")!.reason).toContain("your threshold, not an official flood level");
        const gust = list.find((m) => m.ruleName === "Gusts")!;
        expect(gust).toMatchObject({ observedValue: 76, threshold: 74.1, unit: "km/h" });
        expect(gust.reason).toContain("40 kn (74.1 km/h)");
        expect(list.some((m) => m.ruleName === "Too strong")).toBe(false);
        expect(list.find((m) => m.ruleName === "Hot")).toMatchObject({ observedValue: 38.5, unit: "°C" });
    });

    it("covers Total Fire Bans, earthquakes and stale sources", async () => {
        const env = await seed();
        const w = await watch();
        await rule({ name: "Ban", definition: { condition: "total_fire_ban", district: "Example Ranges", when: "today" } });
        await rule({ name: "Quake", definition: { condition: "earthquake", watchId: w.id, minMagnitude: 3, radiusKm: 100 } });
        await rule({ name: "Big quake", definition: { condition: "earthquake", watchId: w.id, minMagnitude: 5, radiusKm: 100 } });
        await rule({ name: "Stale RFS", definition: { condition: "source_stale", sourceId: "rfs-incidents" } });
        await evaluate(env);
        let list = await matches();
        expect(list.find((m) => m.ruleName === "Ban")!.reason).toContain("Total Fire Ban today in Example Ranges, as the NSW RFS lists it");
        expect(list.find((m) => m.ruleName === "Quake")!.observedValue).toBe(3.4);
        expect(list.some((m) => m.ruleName === "Big quake" || m.ruleName === "Stale RFS")).toBe(false);
        await db()
            .prepare("UPDATE ic_sources SET last_success_at = ? WHERE id = 'rfs-incidents'")
            .bind(new Date(Date.now() - 3 * 3_600_000).toISOString())
            .run();
        await evaluate(env);
        list = await matches();
        expect(list.find((m) => m.ruleName === "Stale RFS")!.reason).toContain("hasn't been retrieved for 180 minutes (limit 90)");
        expect((await apiCall("POST", `${C}/rules`, { name: "x", definition: { condition: "total_fire_ban", district: "Nowhere Plains" } })).status).toBe(422);
    });

    it("only run on the cron with the switch on, and never for someone who lost access", async () => {
        const env = await seed();
        const w = await watch();
        await rule({ name: "Fires", definition: { condition: "fire_within", watchId: w.id, radiusKm: 10 } });
        await runCentreCron(env);
        expect(await matches()).toEqual([]);
        await setFlag("intelligence_centre.rules", true);
        await runCentreCron(env);
        expect(await matches()).toHaveLength(1);
        await db().prepare("DELETE FROM ic_rule_matches").run();
        // The owner loses the Centre: their rules are no longer evaluated.
        const lost = await centreEnv({ PORTAL_OWNER_EMAILS: SECOND_OWNER } as Partial<Env>);
        await evaluateRules(lost);
        expect(await matches()).toEqual([]);
    });
});

describe("Monitoring rules: testing and tasks", () => {
    it("test against stored history without writing or notifying", async () => {
        await seed();
        const w = await watch();
        const r = await apiCall<{ result: RuleTestResult }>("POST", `${C}/rules/test?days=2`, {
            name: "Test",
            definition: { condition: "gauge_threshold", station: "999001", direction: "above", threshold: 1.3, unit: "m" },
        });
        expect(r.status, r.text).toBe(200);
        expect(r.json.result.matches.map((m) => m.observedValue)).toEqual([1.31]);
        expect(r.json.result.notes.join(" ")).toContain("not an official warning threshold");
        const fire = await apiCall<{ result: RuleTestResult }>("POST", `${C}/rules/test`, {
            name: "Test",
            definition: { condition: "fire_within", watchId: w.id, radiusKm: 10 },
        });
        expect(fire.json.result.matches).toHaveLength(1);
        expect(await matches()).toEqual([]);
        expect((await db().prepare("SELECT COUNT(*) AS n FROM ic_rules").first<{ n: number }>())!.n).toBe(0);
    });

    it("make a follow-up task from a match once, through Daly Tasks", async () => {
        const env = await seed();
        const w = await watch();
        await rule({ name: "Fires", definition: { condition: "fire_within", watchId: w.id, radiusKm: 10 } });
        await evaluate(env);
        const [m] = await matches();
        const first = await apiCall<{ taskId: string; replayed: boolean }>("POST", `${C}/rules/matches/${m.id}/task`, {});
        expect(first.status, first.text).toBe(200);
        const again = await apiCall<{ taskId: string; replayed: boolean }>("POST", `${C}/rules/matches/${m.id}/task`, {});
        expect(again.json.taskId).toBe(first.json.taskId);
        expect((await matches())[0].taskId).toBe(first.json.taskId);
        expect((await apiCall("POST", `${C}/rules/matches/${m.id}/task`, {}, { email: SECOND_OWNER })).status).toBe(404);
        await apiCall("POST", `${C}/rules/matches/acknowledge`, { ids: [m.id] });
        expect((await apiCall<{ matches: RuleMatch[] }>("GET", `${C}/rules/matches?open=1`)).json.matches).toEqual([]);
    });
});
