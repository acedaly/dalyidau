// Intelligence Centre 9.1 MCP tools: the read tools (feed, timeline, replay metadata, trends, rules
// and matches, reports, correlations, reliability, wallboards) and the four writes through the
// ledger (retries return the first result; no identity from arguments; nobody else's rules,
// reports or watch areas; no display credentials or locations). Invented data only.
import { beforeEach, describe, expect, it } from "vitest";
import type { WatchArea } from "../src/shared/centre/types";
import { presetView } from "../src/shared/centre/wallboard";
import { type PortalMcpResponse, handleMcpCall } from "../worker/mcp/entrypoint";
import { C, centreEnv, collect, enableSource, exampleWatch, fakeTransport } from "./centre-helpers";
import { OWNER, SECOND_OWNER, accessToken, apiCall, db, portalEnv, resetPortal } from "./portal-helpers";

const MCP_AUD = "aud-mcp-gateway-0123456789abcdef";

beforeEach(resetPortal);

const mcp = async (tool: string, input: Record<string, unknown> = {}, email = OWNER) => {
    const env = await portalEnv({ MCP_ACCESS_AUD: MCP_AUD });
    return handleMcpCall(env, { assertion: await accessToken({ email, aud: [MCP_AUD] }), tool, input }) as Promise<
        PortalMcpResponse & { data?: Record<string, unknown> }
    >;
};

async function seed() {
    const env = await centreEnv();
    for (const id of ["rfs-incidents", "rfs-fire-danger", "rfs-incident-alerts", "bom-observations", "dea-hotspots"]) {
        await enableSource(id);
        await collect(env, id, fakeTransport(new Date()), new Date());
    }
    const watch = (
        await apiCall<{ watch: WatchArea }>(
            "POST",
            `${C}/watches`,
            exampleWatch({ name: "Secret Hideaway", definition: { kind: "point", lat: -33.61234, lon: 150.61234, radiusKm: 25, placeName: "Hidden Gully" } }),
        )
    ).json.watch;
    return { env, watch };
}

describe("Intelligence Centre 9.1 MCP tools", () => {
    it("read the change feed, timelines, replay metadata, trends, correlations and reliability, with the disclaimer", async () => {
        const { watch } = await seed();
        const feed = await mcp("centre_search_changes", { hours: 24, significantOnly: false, watchId: watch.id });
        expect(feed.ok, JSON.stringify(feed)).toBe(true);
        expect(String(feed.data!.disclaimer)).toContain("Not an official warning service");
        const record = (await db().prepare("SELECT id FROM ic_records WHERE source_id = 'rfs-incidents' LIMIT 1").first<{ id: string }>())!;
        const timeline = await mcp("centre_get_timeline", { recordId: record.id });
        expect(timeline.ok, JSON.stringify(timeline)).toBe(true);
        expect((timeline.data!.events as { nature: string }[]).some((e) => e.nature === "collection")).toBe(true);
        const replay = await mcp("centre_get_replay_metadata", { at: new Date(Date.now() - 60_000).toISOString() });
        expect(replay.ok, JSON.stringify(replay)).toBe(true);
        expect(replay.data!).toMatchObject({ recording: false });
        expect((await mcp("centre_get_replay_metadata", { at: new Date(Date.now() + 3_600_000).toISOString() })).ok).toBe(false);
        const trends = await mcp("centre_get_trends", { days: 7 });
        expect((trends.data!.caveats as string[]).join(" ")).toContain("not complete or official statistics");
        const correlations = await mcp("centre_list_correlations", {});
        expect(correlations.ok).toBe(true);
        for (const c of correlations.data!.correlations as { basis: string; label: string }[])
            expect(c.label).toBe(
                c.basis === "explicit" ? "Linked by the provider itself" : "May be related (derived by rule; not official and not evidence of cause)",
            );
        expect((correlations.data!.correlations as { rule: string }[]).map((c) => c.rule)).toContain("alert-incident");
        const reliability = await mcp("centre_get_source_reliability", { sourceId: "rfs-incidents", days: 7 });
        expect((reliability.data!.sources as { availabilityPercent: number }[])[0].availabilityPercent).toBe(100);
        // Nothing here gives a watch area's location away.
        expect(JSON.stringify([feed, timeline, replay, trends, correlations])).not.toContain("150.61234");
        // Someone else's watch area: not found.
        expect(await mcp("centre_search_changes", { watchId: watch.id }, SECOND_OWNER)).toMatchObject({ ok: false, error: { code: "not_found" } });
    });

    it("create and update monitoring rules through the ledger: a retry returns the first rule", async () => {
        const { watch } = await seed();
        const input = {
            name: "Fires near me",
            definition: { condition: "fire_within", watchId: watch.id, radiusKm: 10, unit: "km" },
            requestId: "rule-request-0001",
        };
        const first = await mcp("centre_create_rule", input);
        expect(first.ok, JSON.stringify(first)).toBe(true);
        const rule = first.data!.rule as { id: string; version: number; threshold: string };
        expect(rule.threshold).toBe("The person's own threshold, not an official one");
        const again = await mcp("centre_create_rule", input);
        expect((again.data!.rule as { id: string }).id).toBe(rule.id);
        expect((again.data as { replayed?: boolean }).replayed).toBe(true);
        expect((await db().prepare("SELECT COUNT(*) AS n FROM ic_rules").first<{ n: number }>())!.n).toBe(1);
        const ledger = await db()
            .prepare("SELECT tool, entity_type, entity_id FROM mcp_writes WHERE tool = 'centre_create_rule'")
            .first<{ entity_type: string; entity_id: string }>();
        expect(ledger).toMatchObject({ entity_type: "centre_rule", entity_id: rule.id });
        // Only the fields sent change.
        const updated = await mcp("centre_update_rule", { ruleId: rule.id, version: rule.version, enabled: false });
        expect(updated.ok, JSON.stringify(updated)).toBe(true);
        expect(updated.data!.rule).toMatchObject({ name: "Fires near me", enabled: false });
        expect(await mcp("centre_update_rule", { ruleId: rule.id, version: rule.version, enabled: true })).toMatchObject({
            ok: false,
            error: { code: "conflict" },
        });
        expect(await mcp("centre_update_rule", { ruleId: rule.id, version: 2, enabled: true }, SECOND_OWNER)).toMatchObject({
            ok: false,
            error: { code: "not_found" },
        });
        // No coordinates, no other person's watch area, no identity field.
        expect((await mcp("centre_create_rule", { name: "x", definition: { condition: "fire_within", watchId: watch.id, radiusKm: 5, lat: -33.6 } })).ok).toBe(
            false,
        );
        expect(
            await mcp("centre_create_rule", { name: "x", definition: { condition: "fire_within", watchId: watch.id, radiusKm: 5 } }, SECOND_OWNER),
        ).toMatchObject({ ok: false, error: { code: "not_found" } });
        expect(
            (await mcp("centre_create_rule", { name: "x", owner: SECOND_OWNER, definition: { condition: "fire_within", watchId: watch.id, radiusKm: 5 } })).ok,
        ).toBe(false);
        expect((await mcp("centre_list_rules", {}, SECOND_OWNER)).data!.rules).toEqual([]);
    });

    it("generate a report without saving, save one through the ledger, and schedule one", async () => {
        await seed();
        const generated = await mcp("centre_generate_report", { scope: { kind: "nsw" } });
        expect(generated.ok, JSON.stringify(generated)).toBe(true);
        expect(generated.data!.saved).toBe(false);
        expect((await db().prepare("SELECT COUNT(*) AS n FROM ic_reports").first<{ n: number }>())!.n).toBe(0);
        const saved = await mcp("centre_save_report", { scope: { kind: "nsw" }, requestId: "report-request-01" });
        expect(saved.ok, JSON.stringify(saved)).toBe(true);
        const id = (saved.data!.report as { id: string }).id;
        expect((await mcp("centre_save_report", { scope: { kind: "nsw" }, requestId: "report-request-01" })).data!.report).toMatchObject({ id });
        expect((await db().prepare("SELECT trigger FROM ic_reports").all()).results).toEqual([{ trigger: "mcp" }]);
        expect((await mcp("centre_get_report", { reportId: id })).ok).toBe(true);
        expect(await mcp("centre_get_report", { reportId: id }, SECOND_OWNER)).toMatchObject({ ok: false, error: { code: "not_found" } });
        const schedule = await mcp("centre_schedule_report", {
            name: "Mornings",
            scope: { kind: "nsw" },
            frequency: "daily",
            hour: 7,
            requestId: "schedule-req-001",
        });
        expect(schedule.ok, JSON.stringify(schedule)).toBe(true);
        expect((await mcp("centre_list_reports", {})).data!).toMatchObject({ schedules: [{ name: "Mornings", frequency: "daily" }] });
    });

    it("summarise wallboards without display addresses or their hashes", async () => {
        const { watch } = await seed();
        const board = (
            await apiCall<{ wallboard: { id: string } }>("POST", `${C}/wallboards`, {
                name: "Hall",
                layout: "local",
                watchId: watch.id,
                views: [presetView("local")],
            })
        ).json.wallboard;
        const issued = (await apiCall<{ token: string }>("POST", `${C}/wallboards/${board.id}/displays`, { label: "TV" })).json;
        const r = await mcp("centre_list_wallboards");
        expect(r.ok).toBe(true);
        expect(r.data!.wallboards).toMatchObject([{ name: "Hall", activeScreens: 1, views: [{ preset: "Local Situation" }] }]);
        const hash = (await db().prepare("SELECT token_hash FROM ic_display_tokens").first<{ token_hash: string }>())!.token_hash;
        const text = JSON.stringify(r);
        expect(text).not.toContain(issued.token);
        expect(text).not.toContain(hash);
        expect(text).not.toContain("150.61234");
        expect((await mcp("centre_list_wallboards", {}, SECOND_OWNER)).data!.wallboards).toEqual([]);
    });
});
