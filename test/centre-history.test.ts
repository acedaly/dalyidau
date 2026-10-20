// Intelligence Centre 9.1 history: versioned records (only with the switch on, baselines honestly
// marked), replay integrity (what was stored then, never later information; outages and moments
// before history said plainly), comparisons, timelines (provider time and collection time apart,
// nature labels, gaps), the change feed, reliability rollups, analytics and retention. Invented
// fixtures only.
import { beforeEach, describe, expect, it } from "vitest";
import { rfsIncidents } from "../fixtures/intelligence-centre/feeds.mjs";
import type { CentreAnalytics, FeedChange, RecordTimeline, ReplayComparison, ReplayFrame, ReplayMeta, SourceReliability } from "../src/shared/centre/history";
import type { WatchArea } from "../src/shared/centre/types";
import { applyRetention, collectSource } from "../worker/centre/ingest";
import type { CentreTransport } from "../worker/centre/net";
import type { Env } from "../worker/env";
import { C, centreEnv, enableSource, exampleWatch, fakeTransport, records, setFlag } from "./centre-helpers";
import { OWNER, SECOND_OWNER, apiCall, db, resetPortal } from "./portal-helpers";

const RFS = "https://www.rfs.nsw.gov.au/feeds/majorIncidents.json";
const HOUR = 3_600_000;
/** Collections at chosen moments in the last few hours (relative to now, so freshness rules still hold). */
const hoursAgo = (h: number) => new Date(Date.now() - h * HOUR);

beforeEach(resetPortal);

async function collectAt(env: Env, id: string, transport: CentreTransport, at: Date) {
    await db().prepare("UPDATE ic_sources SET next_due_at = NULL, lease_until = NULL").run();
    return collectSource(env, id, { transport, now: at, recordedAt: at, trigger: "manual" });
}

const rfsAt = (at: Date, options: Record<string, unknown> = {}) => fakeTransport(at, { [RFS]: rfsIncidents(at, options) });

const versions = async () =>
    (
        await db().prepare("SELECT v.*, r.external_id FROM ic_record_versions v JOIN ic_records r ON r.id = v.record_id ORDER BY r.external_id, v.seq").all<{
            record_id: string;
            external_id: string;
            seq: number;
            valid_from: string;
            valid_to: string | null;
            baseline: number;
            change_kind: string | null;
            warning_level: string | null;
            active: number;
            missing: number;
            geometry_hash: string | null;
            title: string;
        }>()
    ).results;

/** Three collections: Advice (baseline), then Emergency Warning with a bigger area, then the second fire gone from the feed. */
async function history() {
    const env = await centreEnv();
    await setFlag("intelligence_centre.history", true);
    await enableSource("rfs-incidents");
    const t0 = hoursAgo(5);
    const t1 = hoursAgo(3);
    const t2 = hoursAgo(1);
    expect((await collectAt(env, "rfs-incidents", rfsAt(t0, { level: "Advice" }), t0)).outcome).toBe("ok");
    expect((await collectAt(env, "rfs-incidents", rfsAt(t1, { level: "Emergency Warning", areaSize: 0.05 }), t1)).outcome).toBe("ok");
    expect((await collectAt(env, "rfs-incidents", rfsAt(t2, { level: "Emergency Warning", areaSize: 0.05, drop: [1] }), t2)).outcome).toBe("ok");
    const fire = (await records("rfs-incidents")).find((r) => r.external_id === "incident-900001")!;
    return { env, t0, t1, t2, fireId: fire.id };
}

describe("Versioned history", () => {
    it("isn't recorded while the switch is off", async () => {
        const env = await centreEnv();
        await enableSource("rfs-incidents");
        await collectAt(env, "rfs-incidents", rfsAt(hoursAgo(1)), hoursAgo(1));
        expect(await versions()).toEqual([]);
    });

    it("stores each state as collected: a baseline first, then one version per change, labelled", async () => {
        const { t0, t1, t2 } = await history();
        const v = await versions();
        const fire = v.filter((x) => x.external_id === "incident-900001");
        // The third is the provider's own update (its "UPDATED" time moved on), at the same level.
        expect(fire.map((x) => [x.seq, x.warning_level, x.baseline, x.change_kind])).toEqual([
            [1, "Advice", 1, null],
            [2, "Emergency Warning", 0, "escalated"],
            [3, "Emergency Warning", 0, "updated"],
        ]);
        expect(fire[0].valid_from).toBe(t0.toISOString());
        expect(fire[0].valid_to).toBe(t1.toISOString());
        expect(fire[1].valid_to).toBe(t2.toISOString());
        expect(fire[2].valid_to).toBeNull();
        expect(fire[0].geometry_hash).not.toBe(fire[1].geometry_hash);
        // Each distinct published area is stored once.
        const shapes = (await db().prepare("SELECT COUNT(*) AS n FROM ic_geometries").first<{ n: number }>())!.n;
        expect(shapes).toBe(2);
        // A record gone from a complete listing: a version that says so, never "ended".
        const creek = v.filter((x) => x.external_id === "incident-900002");
        expect(creek.at(-1)).toMatchObject({ active: 0, missing: 1, change_kind: "not_in_feed", valid_from: t2.toISOString() });
        const config = await db().prepare("SELECT value FROM ic_config WHERE key = 'history'").first<{ value: string }>();
        expect(JSON.parse(config!.value).startedAt).toBe(t0.toISOString());
    });

    it("gives records already stored when history is switched on a baseline dated then, not their past", async () => {
        const env = await centreEnv();
        await enableSource("rfs-incidents");
        await collectAt(env, "rfs-incidents", rfsAt(hoursAgo(4), { level: "Advice" }), hoursAgo(4));
        await collectAt(env, "rfs-incidents", rfsAt(hoursAgo(3), { level: "Watch and Act" }), hoursAgo(3));
        await setFlag("intelligence_centre.history", true);
        const t = hoursAgo(1);
        await collectAt(env, "rfs-incidents", rfsAt(t, { level: "Watch and Act" }), t);
        // Its first version starts its history now (the provider updated it in this collection); the escalation before is only a change.
        const fire = (await versions()).filter((x) => x.external_id === "incident-900001");
        expect(fire).toHaveLength(1);
        expect(fire[0]).toMatchObject({ baseline: 1, warning_level: "Watch and Act", valid_from: t.toISOString() });
        expect((await versions()).every((v) => v.baseline === 1 && v.valid_from === t.toISOString())).toBe(true);
    });
});

describe("Replay", () => {
    it("shows exactly what was stored at each moment, never later information", async () => {
        const { t0, t1 } = await history();
        const at = (d: Date) => apiCall<{ frame: ReplayFrame }>("GET", `${C}/replay?at=${encodeURIComponent(d.toISOString())}`);
        const early = (await at(new Date(t0.getTime() + HOUR))).json.frame;
        const fire = early.records.find((r) => r.title === "Example Ridge Rd, Exampleville")!;
        expect(fire.warningLevel).toBe("Advice");
        expect(fire.baseline).toBe(true);
        expect(early.records.map((r) => r.title)).toContain("Example Creek");
        const late = (await at(new Date(t1.getTime() + 30 * 60_000))).json.frame;
        expect(late.records.find((r) => r.title === "Example Ridge Rd, Exampleville")!.warningLevel).toBe("Emergency Warning");
        // Its published area is drawn as it was then (the area version, not today's).
        expect(early.map.features.some((f) => (f as { id: string }).id.endsWith(":area"))).toBe(true);
        // Now: the creek left the feed, so it isn't current any more.
        const now = (await at(new Date())).json.frame;
        expect(now.records.map((r) => r.title)).not.toContain("Example Creek");
    });

    it("says when a moment is before history began, and when a source wasn't up to date", async () => {
        const { t0, t1 } = await history();
        const before = (await apiCall<{ frame: ReplayFrame }>("GET", `${C}/replay?at=${encodeURIComponent(new Date(t0.getTime() - HOUR).toISOString())}`)).json
            .frame;
        expect(before.records).toEqual([]);
        expect(before.notes.join(" ")).toContain("History recording began");
        // Two hours without a retrieval (the RFS is stale after 90 minutes) between t1 and t2.
        const gap = (await apiCall<{ frame: ReplayFrame }>("GET", `${C}/replay?at=${encodeURIComponent(new Date(t1.getTime() + 100 * 60_000).toISOString())}`))
            .json.frame;
        expect(gap.sources.find((s) => s.sourceId === "rfs-incidents")!.state).toBe("stale");
        expect(gap.notes.join(" ")).toContain("up to date");
        expect((await apiCall("GET", `${C}/replay?at=${encodeURIComponent(new Date(Date.now() + 2 * HOUR).toISOString())}`)).status).toBe(400);
    });

    it("compares two moments and lists the moments that changed", async () => {
        const { t0, t1, t2 } = await history();
        const a = new Date(t0.getTime() + 10 * 60_000).toISOString();
        const b = new Date(t2.getTime() + 10 * 60_000).toISOString();
        const { comparison } = (
            await apiCall<{ comparison: ReplayComparison }>("GET", `${C}/replay/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`)
        ).json;
        expect(comparison.removed.map((r) => r.title)).toEqual(["Example Creek"]);
        const changed = comparison.changed.find((c) => c.after.title === "Example Ridge Rd, Exampleville")!;
        expect(changed.fields).toContain("warningLevel");
        expect([changed.before.warningLevel, changed.after.warningLevel]).toEqual(["Advice", "Emergency Warning"]);
        const { meta } = (
            await apiCall<{ meta: ReplayMeta }>(
                "GET",
                `${C}/replay/meta?from=${encodeURIComponent(hoursAgo(6).toISOString())}&to=${encodeURIComponent(new Date().toISOString())}`,
            )
        ).json;
        expect(meta.steps.map((s) => s.at)).toEqual([t0.toISOString(), t1.toISOString(), t2.toISOString()]);
        expect(meta.historyStartedAt).toBe(t0.toISOString());
        expect(meta.recording).toBe(true);
        expect(meta.gaps.some((g) => g.sourceId === "rfs-incidents")).toBe(true);
    });

    it("limits a moment to the caller's own watch area, and refuses someone else's", async () => {
        const { t1 } = await history();
        const w = (
            await apiCall<{ watch: WatchArea }>(
                "POST",
                `${C}/watches`,
                exampleWatch({ definition: { kind: "point", lat: -33.6, lon: 150.6, radiusKm: 5, placeName: "Home" } }),
            )
        ).json.watch;
        const at = encodeURIComponent(new Date(t1.getTime() + 600_000).toISOString());
        const frame = (await apiCall<{ frame: ReplayFrame }>("GET", `${C}/replay?at=${at}&watch=${w.id}`)).json.frame;
        expect(frame.records.map((r) => r.title)).toEqual(["Example Ridge Rd, Exampleville"]);
        expect((await apiCall("GET", `${C}/replay?at=${at}&watch=${w.id}`, undefined, { email: SECOND_OWNER })).status).toBe(404);
    });
});

describe("Timelines", () => {
    it("label every event, keep the provider's time and the collection time apart, and show gaps", async () => {
        const { fireId, t0, t1 } = await history();
        const { timeline } = (await apiCall<{ timeline: RecordTimeline }>("GET", `${C}/records/${fireId}/timeline`)).json;
        const kinds = timeline.events.map((e) => e.kind);
        expect(kinds).toContain("first_seen");
        expect(kinds).toContain("published");
        expect(kinds).toContain("baseline");
        expect(kinds).toContain("level_change");
        expect(kinds).toContain("area_change");
        expect(kinds).toContain("source_gap");
        const first = timeline.events.find((e) => e.kind === "first_seen")!;
        expect(first).toMatchObject({ at: t0.toISOString(), nature: "collection" });
        const raised = timeline.events.find((e) => e.kind === "level_change")!;
        expect(raised).toMatchObject({ nature: "official", label: "Warning level raised", collectedAt: t1.toISOString() });
        expect(raised.detail).toContain("Advice → Emergency Warning");
        // Never shown as known before it was collected: the provider's time is after the previous collection and no later than this one.
        expect(raised.at > t0.toISOString() && raised.at <= t1.toISOString()).toBe(true);
        expect(timeline.events.find((e) => e.kind === "published")!.nature).toBe("official");
        expect(timeline.startsAtBaseline).toBe(true);
    });

    it("fall back to the detected changes when there's no versioned history", async () => {
        const env = await centreEnv();
        await enableSource("rfs-incidents");
        await collectAt(env, "rfs-incidents", rfsAt(hoursAgo(2), { level: "Advice" }), hoursAgo(2));
        await collectAt(env, "rfs-incidents", rfsAt(hoursAgo(1), { level: "Watch and Act" }), hoursAgo(1));
        const fire = (await records("rfs-incidents")).find((r) => r.external_id === "incident-900001")!;
        const { timeline } = (await apiCall<{ timeline: RecordTimeline }>("GET", `${C}/records/${fire.id}/timeline`)).json;
        expect(timeline.events.some((e) => e.kind === "change" && e.label === "Warning level raised")).toBe(true);
        expect(timeline.notes.join(" ")).toContain("No versioned history");
    });

    it("save to Knowledge once per hour, through Knowledge's own function", async () => {
        const { fireId } = await history();
        const first = await apiCall<{ objectId: string }>("POST", `${C}/records/${fireId}/timeline/knowledge`, {});
        expect(first.status, first.text).toBe(200);
        const again = await apiCall<{ objectId: string }>("POST", `${C}/records/${fireId}/timeline/knowledge`, {});
        expect(again.json.objectId).toBe(first.json.objectId);
    });
});

describe("What's changed", () => {
    it("filters by hazard, region, watch area, type and significance, and links each change", async () => {
        await history();
        const feed = async (q = "") =>
            (await apiCall<{ changes: FeedChange[]; counts: { significant: number; routine: number } }>("GET", `${C}/feed?${q}`)).json;
        const all = await feed("significance=all");
        // The escalation and the bigger area arrived together: the escalation is the change recorded.
        expect(all.changes.map((c) => c.kind)).toEqual(expect.arrayContaining(["escalated", "not_in_feed"]));
        const significant = await feed();
        expect(significant.changes.map((c) => c.kind)).not.toContain("not_in_feed");
        expect(significant.changes.find((c) => c.kind === "escalated")).toMatchObject({
            label: "Official warning escalated",
            significant: true,
            provider: "NSW Rural Fire Service",
        });
        expect((await feed("hazard=transport&significance=all")).changes.filter((c) => c.recordId)).toEqual([]);
        expect((await feed("region=far_west&significance=all")).changes.filter((c) => c.recordId)).toEqual([]);
        expect((await feed("group=escalation")).changes.map((c) => c.kind)).toEqual(["escalated"]);
        expect((await apiCall("GET", `${C}/feed?from=2020-01-01T00:00:00Z&to=2026-12-01T00:00:00Z`)).status).toBe(400);
        expect((await apiCall("GET", `${C}/feed?hazard=volcano`)).status).toBe(422);
    });
});

describe("Source reliability and analytics", () => {
    it("rolls each run into a daily record: attempts, successes, timing, delay and gaps", async () => {
        await history();
        const days = (await db().prepare("SELECT * FROM ic_source_daily WHERE source_id = 'rfs-incidents'").all<Record<string, number>>()).results;
        expect(days.reduce((n, d) => n + d.attempts, 0)).toBe(3);
        expect(days.reduce((n, d) => n + d.ok, 0)).toBe(3);
        expect(Math.max(...days.map((d) => d.longest_gap_minutes))).toBeGreaterThanOrEqual(120);
        const runs = (await db().prepare("SELECT delay_s FROM ic_fetch_runs WHERE source_id = 'rfs-incidents'").all<{ delay_s: number | null }>()).results;
        expect(runs.every((r) => r.delay_s === null || r.delay_s >= 0)).toBe(true);
        const { reliability } = (await apiCall<{ reliability: SourceReliability[] }>("GET", `${C}/reliability?days=7`)).json;
        expect(reliability.find((r) => r.sourceId === "rfs-incidents")).toMatchObject({ availability: 100, consecutiveFailures: 0 });
    });

    it("counts what was collected, says what the numbers aren't, and caches the result", async () => {
        await history();
        const first = (await apiCall<{ analytics: CentreAnalytics }>("GET", `${C}/analytics?days=7`)).json.analytics;
        expect(first.transitions.find((t) => t.key === "escalated")!.points.reduce((n, p) => n + p.value, 0)).toBe(1);
        expect(first.caveats.join(" ")).toContain("not complete or official statistics");
        expect(first.caveats.join(" ")).toContain("Nothing here is a forecast or a risk score");
        const second = (await apiCall<{ analytics: CentreAnalytics }>("GET", `${C}/analytics?days=7`)).json.analytics;
        expect(second.computedAt).toBe(first.computedAt);
        expect((await apiCall("GET", `${C}/analytics?days=12`)).status).toBe(422);
    });
});

describe("Retention", () => {
    it("removes superseded versions past their retention, keeps what's current, and prunes unused areas", async () => {
        const { fireId } = await history();
        // Age the superseded versions past the default 120 days.
        await db().prepare("UPDATE ic_record_versions SET valid_to = '2026-01-01T00:00:00.000Z' WHERE valid_to IS NOT NULL").run();
        await db().prepare("UPDATE ic_geometries SET first_seen_at = '2026-01-01T00:00:00.000Z'").run();
        await applyRetention(await centreEnv());
        const left = await versions();
        expect(left.every((v) => v.valid_to === null)).toBe(true);
        expect(left.some((v) => v.record_id === fireId)).toBe(true);
        expect((await db().prepare("SELECT COUNT(*) AS n FROM ic_geometries").first<{ n: number }>())!.n).toBe(1);
    });
});

describe("Situation timeline", () => {
    it("lists changes and collection gaps for a period, for the caller's own area", async () => {
        await history();
        const r = await apiCall<{ timeline: { events: { kind: string; nature: string }[]; notes: string[] } }>("GET", `${C}/timeline?hours=24`);
        expect(r.status, r.text).toBe(200);
        expect(r.json.timeline.events.some((e) => e.nature === "official")).toBe(true);
        expect(r.json.timeline.events.some((e) => e.kind === "source_gap" && e.nature === "collection")).toBe(true);
        const w = (await apiCall<{ watch: WatchArea }>("POST", `${C}/watches`, exampleWatch())).json.watch;
        expect((await apiCall("GET", `${C}/timeline?watch=${w.id}`, undefined, { email: SECOND_OWNER })).status).toBe(404);
        expect((await apiCall("GET", `${C}/timeline?watch=${w.id}`, undefined, { email: OWNER })).status).toBe(200);
    });
});
