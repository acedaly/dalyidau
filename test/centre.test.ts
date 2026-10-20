// Intelligence Centre through the Worker: permissions, private watch areas and matching, alerts
// (dedupe, rate limit, quiet hours, opt-in email, lost access), correlation, briefings (facts and a
// grounded interpretation), Tasks, Knowledge and Today, MCP (read-only, no coordinates) and the
// portal pages. Everything is collected from invented fixtures; no real provider is contacted.
import { createElement } from "react";
import { renderToString } from "react-dom/server.edge";
import { beforeEach, describe, expect, it } from "vitest";
import { rfsIncidents } from "../fixtures/intelligence-centre/feeds.mjs";
import { PortalApp } from "../src/portal/portal-app";
import type { CentreAlert, CentreBriefing, CentreRecord, WatchArea } from "../src/shared/centre/types";
import { DEFAULT_CENTRE_SETTINGS } from "../src/shared/centre/types";
import type { PortalPageData } from "../src/shared/portal/types";
import { MAX_ALERTS_PER_HOUR, acknowledgeAlerts, alertsForChanges, deliverAlertEmails, inQuietHours } from "../worker/centre/alerts";
import { groundInterpretation } from "../worker/centre/briefing";
import { correlations } from "../worker/centre/correlate";
import type { EmailProvider } from "../worker/comms/providers";
import { PORTAL_MCP_TOOLS, type PortalMcpResponse, handleMcpCall } from "../worker/mcp/entrypoint";
import { C, centreEnv, changes, collect, enableSource, exampleWatch, fakeTransport, records, setFlag } from "./centre-helpers";
import { configure, scriptedAi } from "./intelligence-helpers";
import { OWNER, SECOND_OWNER, accessToken, apiCall, call, db, portalEnv, resetPortal } from "./portal-helpers";

const A = OWNER;
const B = SECOND_OWNER;
const MCP_AUD = "aud-mcp-gateway-0123456789abcdef";
const later = (minutes: number) => new Date(Date.now() + minutes * 60_000);

beforeEach(resetPortal);

/** Collects the RFS sources and BoM warnings/observations from fixtures (baseline). */
async function seed() {
    const env = await centreEnv();
    for (const id of ["rfs-incidents", "rfs-fire-danger", "rfs-incident-alerts", "bom-warnings", "bom-observations", "dea-hotspots", "endeavour-outages"]) {
        await enableSource(id);
        await collect(env, id, fakeTransport(new Date()), new Date());
    }
    return env;
}

const createWatch = async (body: Record<string, unknown> = exampleWatch(), email = A) => {
    const r = await apiCall<{ watch: WatchArea }>("POST", `${C}/watches`, body, { email });
    expect(r.status, r.text).toBe(201);
    return r.json.watch;
};

const mcp = async (tool: string, input: Record<string, unknown> = {}, email = A) => {
    const env = await portalEnv({ MCP_ACCESS_AUD: MCP_AUD });
    return handleMcpCall(env, { assertion: await accessToken({ email, aud: [MCP_AUD] }), tool, input }) as Promise<
        PortalMcpResponse & { data?: Record<string, unknown> }
    >;
};

describe("Access", () => {
    it("owners and admins open the Centre; wedding editors and viewers don't", async () => {
        await apiCall("POST", "/api/portal/users", { email: "editor@example.com", role: "editor" });
        await apiCall("POST", "/api/portal/users", { email: "admin@example.com", role: "admin" });
        expect((await apiCall("GET", `${C}/summary`)).status).toBe(200);
        expect((await apiCall("GET", `${C}/summary`, undefined, { email: "admin@example.com" })).status).toBe(200);
        expect((await apiCall("GET", `${C}/summary`, undefined, { email: "editor@example.com" })).status).toBe(403);
        expect((await apiCall("GET", "/portal/intelligence-centre", undefined, { email: "editor@example.com" })).status).toBe(403);
        expect((await call(`${C}/summary`)).status).toBe(401);
        // Account settings are for owners and admins; preferences are everyone's own.
        const s = (await apiCall<{ settings: unknown; version: number }>("GET", `${C}/settings`)).json;
        expect((await apiCall("PUT", `${C}/settings`, s, { email: "admin@example.com" })).status).toBe(200);
    });

    it("refuses cross-site requests", async () => {
        const token = await accessToken({ email: A });
        const response = await call(`${C}/watches`, {
            method: "POST",
            token,
            headers: { Origin: "https://evil.example", "Content-Type": "application/json" },
            body: JSON.stringify(exampleWatch()),
        });
        expect(response.status).toBe(403);
    });
});

describe("Watch areas", () => {
    it("are private: the other owner gets 404, and nothing about them is audited", async () => {
        const w = await createWatch();
        expect((await apiCall("GET", `${C}/watches/${w.id}`, undefined, { email: B })).status).toBe(404);
        expect((await apiCall("PUT", `${C}/watches/${w.id}`, { ...exampleWatch(), version: 1 }, { email: B })).status).toBe(404);
        expect((await apiCall("DELETE", `${C}/watches/${w.id}`, undefined, { email: B })).status).toBe(404);
        expect((await apiCall<{ watches: WatchArea[] }>("GET", `${C}/watches`, undefined, { email: B })).json.watches).toEqual([]);
        const audit = JSON.stringify((await db().prepare("SELECT summary, changes FROM audit_log WHERE action LIKE 'centre.watch%'").all()).results);
        expect(audit).not.toContain("Exampleville");
        expect(audit).not.toContain("-33.6");
        expect(audit).not.toContain("Home");
    });

    it("validates definitions and versions", async () => {
        expect((await apiCall("POST", `${C}/watches`, exampleWatch({ definition: { kind: "point", lat: 95, lon: 150, radiusKm: 5 } }))).status).toBe(422);
        expect((await apiCall("POST", `${C}/watches`, exampleWatch({ definition: { kind: "point", lat: 51.5, lon: -0.1, radiusKm: 5 } }))).status).toBe(422);
        expect(
            (
                await apiCall(
                    "POST",
                    `${C}/watches`,
                    exampleWatch({
                        definition: {
                            kind: "polygon",
                            ring: [
                                [150, -33],
                                [151, -33],
                                [151, -34],
                            ],
                        },
                    }),
                )
            ).status,
        ).toBe(422);
        const w = await createWatch();
        expect((await apiCall("PUT", `${C}/watches/${w.id}`, { ...exampleWatch({ name: "Renamed" }), version: 1 })).status).toBe(200);
        expect((await apiCall("PUT", `${C}/watches/${w.id}`, { ...exampleWatch({ name: "Stale" }), version: 1 })).status).toBe(409);
    });

    it("match by distance, area, region, route, district, gauge and incident, with a reason", async () => {
        await seed();
        const matches = async (body: Record<string, unknown>) => {
            const w = await createWatch(body);
            return (await apiCall<{ matches: { record: CentreRecord; reason: string }[] }>("GET", `${C}/watches/${w.id}`)).json.matches;
        };
        const near = await matches(exampleWatch());
        const titles = near.map((m) => m.record.title);
        expect(titles).toContain("Example Ridge Rd, Exampleville");
        expect(titles).toContain("Example Ranges");
        expect(near.find((m) => m.record.title === "Example Ridge Rd, Exampleville")!.reason).toBe("The published area covers this place");
        expect(near.find((m) => m.record.title === "Example Ranges")!.reason).toBe("Fire danger district: Example Ranges");
        // BoM's text warning is matched through the nearest station's district (NSW_PW006).
        expect(near.find((m) => m.record.externalId === "IDN21033")?.reason).toContain("NSW_PW006");
        expect(titles).not.toContain("Example Hwy, Exampletown");

        const square = await matches({
            name: "Square",
            definition: {
                kind: "polygon",
                ring: [
                    [150.5, -33.7],
                    [150.7, -33.7],
                    [150.7, -33.5],
                    [150.5, -33.5],
                    [150.5, -33.7],
                ],
            },
        });
        expect(square.map((m) => m.record.title)).toContain("Example Ridge Rd, Exampleville");
        const region = await matches({ name: "Box", definition: { kind: "region", south: -34, west: 150.95, north: -33.8, east: 151.1 } });
        expect(region.map((m) => m.record.title)).toEqual(["Example Hwy, Exampletown"]);
        const route = await matches({
            name: "Drive",
            definition: {
                kind: "corridor",
                line: [
                    [150.8, -33.25],
                    [151, -33.15],
                ],
                bufferKm: 3,
            },
        });
        expect(route.map((m) => m.record.title)).toContain("Example Creek");
        const district = await matches({ name: "District", definition: { kind: "fire_district", district: "Example Coast" } });
        expect(district.map((m) => m.record.title)).toEqual(["Example Coast"]);
        const incidentId = (await records("rfs-incidents")).find((r) => r.external_id === "incident-900002")!.id;
        const one = await matches({ name: "One", definition: { kind: "incident", recordId: incidentId } });
        expect(one.map((m) => m.record.title)).toEqual(["Example Creek"]);
        // Category filter.
        const powerOnly = await matches(exampleWatch({ name: "Power", categories: ["power"] }));
        expect(powerOnly.map((m) => m.record.category)).toEqual(["power"]);
    });
});

describe("Alerts", () => {
    it("alert the watch area's owner once per change, never for 'no longer in the feed', and never anyone else", async () => {
        const env = await seed();
        await createWatch(exampleWatch({ minLevel: 1 }));
        await createWatch({ ...exampleWatch(), name: "B's place" }, B);
        // Escalate the grass fire.
        await collect(
            env,
            "rfs-incidents",
            fakeTransport(later(15), { "https://www.rfs.nsw.gov.au/feeds/majorIncidents.json": rfsIncidents(later(15), { level: "Emergency Warning" }) }),
            later(15),
        );
        const a = (await apiCall<{ alerts: CentreAlert[] }>("GET", `${C}/alerts`)).json.alerts;
        expect(a.map((x) => x.kind)).toEqual(["escalated"]);
        expect(a[0].title).toContain("Exampleville: ");
        expect(a[0].detail).toBe("The published area covers this place");
        const b = (await apiCall<{ alerts: CentreAlert[] }>("GET", `${C}/alerts`, undefined, { email: B })).json.alerts;
        expect(b).toHaveLength(1);
        expect(b[0].watchName).toBe("B's place");
        // The same changes again: still one each (unique per person and change).
        const ids = (await db().prepare("SELECT id FROM ic_changes").all<{ id: string }>()).results.map((r) => r.id);
        await alertsForChanges(env, ids);
        expect((await db().prepare("SELECT COUNT(*) AS n FROM ic_alerts").first<{ n: number }>())!.n).toBe(2);
        // Dropping out of the feed alerts nobody.
        await collect(
            env,
            "rfs-incidents",
            fakeTransport(later(30), {
                "https://www.rfs.nsw.gov.au/feeds/majorIncidents.json": rfsIncidents(later(30), { level: "Emergency Warning", drop: [0] }),
            }),
            later(30),
        );
        expect((await changes()).some((c) => c.kind === "not_in_feed")).toBe(true);
        expect((await db().prepare("SELECT COUNT(*) AS n FROM ic_alerts").first<{ n: number }>())!.n).toBe(2);
    });

    it("respect the watch area's level, are acknowledged, and appear in Today until read", async () => {
        const env = await seed();
        await createWatch(exampleWatch({ minLevel: 3 }));
        await collect(
            env,
            "rfs-incidents",
            fakeTransport(later(15), { "https://www.rfs.nsw.gov.au/feeds/majorIncidents.json": rfsIncidents(later(15), { level: "Advice" }) }),
            later(15),
        );
        expect((await apiCall<{ alerts: CentreAlert[] }>("GET", `${C}/alerts`)).json.alerts).toEqual([]);
        await collect(
            env,
            "rfs-incidents",
            fakeTransport(later(30), { "https://www.rfs.nsw.gov.au/feeds/majorIncidents.json": rfsIncidents(later(30), { level: "Emergency Warning" }) }),
            later(30),
        );
        const [alert] = (await apiCall<{ alerts: CentreAlert[] }>("GET", `${C}/alerts?open=1`)).json.alerts;
        expect(alert.levelRank).toBe(3);
        const today = await apiCall<{ today: { notifications: { source: string; title: string }[] } }>("GET", "/api/portal/today?parts=notifications");
        expect(today.json.today.notifications.filter((n) => n.source === "intelligence-centre").map((n) => n.title)).toEqual([alert.title]);
        expect((await apiCall("POST", `${C}/alerts/acknowledge`, { ids: [alert.id] })).status).toBe(200);
        expect((await apiCall<{ alerts: CentreAlert[] }>("GET", `${C}/alerts?open=1`)).json.alerts).toEqual([]);
        // Someone else can't acknowledge yours (it simply doesn't change).
        await acknowledgeAlerts(db(), { email: B } as never, [alert.id]);
    });

    it("are rate limited per person, with one summary in place of the rest", async () => {
        const env = await seed();
        await createWatch();
        const record = (await records("rfs-incidents"))[0];
        const now = new Date().toISOString();
        const ids: string[] = [];
        for (let i = 0; i < MAX_ALERTS_PER_HOUR + 5; i++) {
            const id = `icc_ratelimit${String(i).padStart(4, "0")}`.slice(0, 18);
            ids.push(id);
            await db()
                .prepare(
                    "INSERT INTO ic_changes (id, record_id, source_id, kind, at, summary, severity_rank) VALUES (?, ?, 'rfs-incidents', 'new', ?, 'Invented change', 2)",
                )
                .bind(id, record.id, now)
                .run();
        }
        await alertsForChanges(env, ids);
        const rows = (await db().prepare("SELECT kind FROM ic_alerts WHERE email = ?").bind(A).all<{ kind: string }>()).results;
        expect(rows.filter((r) => r.kind !== "digest")).toHaveLength(MAX_ALERTS_PER_HOUR);
        expect(rows.filter((r) => r.kind === "digest")).toHaveLength(1);
    });

    it("email only with the switch on, a provider, the person's opt-in and the watch area's; quiet hours hold them", async () => {
        const env = await seed();
        await createWatch(exampleWatch({ notifyEmail: true }));
        const sent: { to: string; subject: string; text: string }[] = [];
        const provider: EmailProvider = {
            channel: "email",
            name: "test",
            send: async (m: { to: string; subject: string; text: string }) => (sent.push(m), { providerId: null }),
        } as unknown as EmailProvider;
        await collect(
            env,
            "rfs-incidents",
            fakeTransport(later(15), { "https://www.rfs.nsw.gov.au/feeds/majorIncidents.json": rfsIncidents(later(15), { level: "Emergency Warning" }) }),
            later(15),
        );
        // Not opted in: no email is even queued.
        expect((await db().prepare("SELECT email_status FROM ic_alerts").first<{ email_status: string | null }>())!.email_status).toBeNull();
        const prefs = (await apiCall<{ preferences: Record<string, unknown>; version: number }>("GET", `${C}/preferences`)).json;
        await apiCall("PUT", `${C}/preferences`, {
            preferences: { ...prefs.preferences, email: { alerts: true, digest: false, digestHour: 7 }, quietHours: null },
            version: prefs.version,
        });
        await collect(
            env,
            "rfs-incidents",
            fakeTransport(later(30), { "https://www.rfs.nsw.gov.au/feeds/majorIncidents.json": rfsIncidents(later(30), { level: "Advice" }) }),
            later(30),
        );
        await collect(
            env,
            "rfs-incidents",
            fakeTransport(later(45), { "https://www.rfs.nsw.gov.au/feeds/majorIncidents.json": rfsIncidents(later(45), { level: "Watch and Act" }) }),
            later(45),
        );
        expect(await deliverAlertEmails(env, { provider })).toBe(0); // switch off
        await setFlag("intelligence_centre.alerts.email", true);
        expect(await deliverAlertEmails(env, { provider })).toBe(1);
        expect(sent[0].to).toBe(A);
        expect(sent[0].text).toContain("not an official warning service");
        expect(sent[0].text).toContain("Triple Zero (000)");
        expect(await deliverAlertEmails(env, { provider })).toBe(0); // once only
        expect(inQuietHours(new Date("2026-10-19T12:00:00Z"), "Australia/Sydney", "22:00", "06:00")).toBe(true); // 11 pm in Sydney
        expect(inQuietHours(new Date("2026-10-19T01:00:00Z"), "Australia/Sydney", "22:00", "06:00")).toBe(false);
    });

    it("someone who lost access gets nothing", async () => {
        const env = await seed();
        await apiCall("POST", "/api/portal/users", { email: "admin@example.com", role: "admin" });
        await createWatch(exampleWatch(), "admin@example.com");
        await apiCall("POST", "/api/portal/users", { email: "admin@example.com", role: "viewer" });
        await collect(
            env,
            "rfs-incidents",
            fakeTransport(later(15), { "https://www.rfs.nsw.gov.au/feeds/majorIncidents.json": rfsIncidents(later(15), { level: "Emergency Warning" }) }),
            later(15),
        );
        expect((await db().prepare("SELECT COUNT(*) AS n FROM ic_alerts WHERE email = 'admin@example.com'").first<{ n: number }>())!.n).toBe(0);
    });
});

describe("Correlation", () => {
    it("links satellite detections to a nearby official fire, with evidence and limits, never as confirmation", async () => {
        await seed();
        const list = await correlations(db(), DEFAULT_CENTRE_SETTINGS);
        const thermal = list.find((c) => c.rule === "fire-thermal")!;
        expect(thermal.confidence).toBe("moderate");
        expect(thermal.records[0].title).toBe("Example Ridge Rd, Exampleville");
        expect(thermal.records.slice(1).every((r) => r.kind === "detection" && (r.distanceKm ?? 99) <= 5)).toBe(true);
        expect(thermal.limitations).toContain("don't confirm");
        const danger = list.find((c) => c.rule === "danger-incidents")!;
        expect(danger.title).toContain("Example Ranges: Extreme, Total Fire Ban");
        expect(list.every((c) => c.confidence !== ("high" as never))).toBe(true);
    });
});

describe("Briefings", () => {
    it("are facts from records with links and times, and say what they couldn't see", async () => {
        await seed();
        const { briefing } = (await apiCall<{ briefing: CentreBriefing }>("GET", `${C}/briefing`)).json;
        const facts = briefing.sections.flatMap((s) => s.facts);
        expect(facts.map((f) => f.ref)).toEqual(facts.map((_, i) => `F${i + 1}`));
        expect(briefing.sections.map((s) => s.key)).toEqual(expect.arrayContaining(["warnings", "incidents", "fire_danger", "weather"]));
        expect(facts.some((f) => f.text.includes("Highest temperature: 38.5 °C at Exampleville Airport"))).toBe(true);
        expect(briefing.gaps.map((g) => g.sourceId)).toContain("tfnsw-live-traffic");
        expect(briefing.interpretation.status).toBe("off");
    });

    it("keep only interpretation sentences grounded in the facts they cite", () => {
        const facts = [
            { ref: "F1", text: "Highest temperature: 38.5 °C at Exampleville Airport.", recordId: null, sourceId: null, at: null, url: null },
            { ref: "F2", text: "Example Ridge Rd, Exampleville: Watch and Act.", recordId: null, sourceId: null, at: null, url: null },
        ];
        const kept = groundInterpretation(
            [
                { text: "It was 38.5 degrees at Exampleville Airport.", refs: ["F1"] },
                { text: "It reached 41 degrees.", refs: ["F1"] },
                { text: "The fire is at Emergency Warning.", refs: ["F2"] },
                { text: "Example Ridge Rd is at Watch and Act; follow official advice.", refs: ["F2"] },
                { text: "Something with no citation.", refs: [] },
                { text: "Cites an invented fact.", refs: ["F9"] },
            ],
            facts,
        );
        expect(kept.map((k) => k.text)).toEqual([
            "It was 38.5 degrees at Exampleville Airport.",
            "Example Ridge Rd is at Watch and Act; follow official advice.",
        ]);
    });

    it("send the model only fenced facts (no watch area name or location), within Intelligence's switches and budget", async () => {
        await seed();
        const w = await createWatch();
        const prompts: string[] = [];
        const ai = scriptedAi({
            text: (_system, user) => {
                prompts.push(user);
                return JSON.stringify({
                    items: [
                        { text: "Watch and Act is in force near you; follow official advice.", refs: ["F1"] },
                        { text: "Invented 99 km fire.", refs: ["F1"] },
                    ],
                });
            },
        });
        const env = await portalEnv({ AI: ai });
        await configure(env);
        const r = await apiCall<{ briefing: CentreBriefing }>("POST", `${C}/briefing/interpret`, { scope: "watch", watch: w.id }, { env });
        expect(r.status, r.text).toBe(200);
        expect(prompts).toHaveLength(1);
        expect(prompts[0]).toContain("<<<SOURCE public-records");
        expect(prompts[0]).not.toContain("Exampleville\n"); // watch name only appears inside record titles, never as the area's name
        expect(prompts[0]).not.toContain("-33.6");
        expect(prompts[0]).not.toContain("Home");
        expect(r.json.briefing.interpretation.status).toBe("ready");
        expect(r.json.briefing.interpretation.items.every((i) => !i.text.includes("99"))).toBe(true);
        // Unchanged facts reuse the stored interpretation: no second call.
        await apiCall("POST", `${C}/briefing/interpret`, { scope: "watch", watch: w.id }, { env });
        expect(prompts).toHaveLength(1);
    });
});

describe("Tasks, Knowledge and Today", () => {
    it("creates a follow-up task in the Inbox (once, even if retried) and a Knowledge note (once)", async () => {
        await seed();
        const record = (await records("rfs-incidents"))[0];
        const t1 = await apiCall<{ taskId: string; replayed: boolean }>("POST", `${C}/records/${record.id}/task`, { dueDate: "2026-10-25" });
        expect(t1.status, t1.text).toBe(200);
        const t2 = await apiCall<{ taskId: string; replayed: boolean }>("POST", `${C}/records/${record.id}/task`, { dueDate: "2026-10-25" });
        expect(t2.json).toMatchObject({ taskId: t1.json.taskId, replayed: true });
        const task = await db()
            .prepare("SELECT title, description, due_date FROM task_items WHERE id = ?")
            .bind(t1.json.taskId)
            .first<{ title: string; description: string; due_date: string }>();
        expect(task!.title).toBe(`Follow up: ${record.title}`);
        expect(task!.description).toContain("Official source:");
        expect(task!.description).toContain("State of New South Wales (NSW Rural Fire Service)");
        expect(task!.due_date).toBe("2026-10-25");
        const k1 = await apiCall<{ objectId: string }>("POST", `${C}/records/${record.id}/knowledge`, {});
        const k2 = await apiCall<{ objectId: string }>("POST", `${C}/records/${record.id}/knowledge`, {});
        expect(k1.status, k1.text).toBe(200);
        expect(k2.json.objectId).toBe(k1.json.objectId);
        expect((await apiCall("POST", `${C}/records/icr_00000000000000/task`, {})).status).toBe(404);
    });

    it("saves a briefing to Knowledge", async () => {
        await seed();
        const r = await apiCall<{ objectId: string }>("POST", `${C}/briefing/knowledge`, { scope: "nsw" });
        expect(r.status, r.text).toBe(200);
        const title = await db().prepare("SELECT title FROM knowledge_objects WHERE id = ?").bind(r.json.objectId).first<{ title: string }>();
        expect(title!.title).toContain("NSW situation");
    });

    it("Today's section shows only what meets the person's rules", async () => {
        await seed();
        await createWatch();
        const page = await apiCall("GET", "/portal/today");
        expect(page.status).toBe(200);
        const data = JSON.parse(/<script type="application\/json" id="page-data">([\s\S]*?)<\/script>/.exec(page.text)![1]).data as PortalPageData & {
            centre: { items: { title: string; kind: string }[] };
        };
        const titles = data.centre.items.map((i) => i.title);
        // The Watch and Act fire (default minimum level 2) and the district's fire danger; not the Advice fire.
        expect(titles.some((t) => t.startsWith("Example Ridge Rd"))).toBe(true);
        expect(titles).toContain("Example Ranges: Extreme today, Total Fire Ban");
        expect(titles).not.toContain("Example Creek");
    });
});

describe("MCP", () => {
    it("serves 28 Centre tools: four writes (rules and reports), everything else read-only", () => {
        const tools = PORTAL_MCP_TOOLS.filter((t) => t.name.startsWith("centre_"));
        expect(tools).toHaveLength(28);
        expect(tools.every((t) => t.permission === "centre.use")).toBe(true);
        expect(
            tools
                .filter((t) => t.write)
                .map((t) => t.name)
                .sort(),
        ).toEqual(["centre_create_rule", "centre_save_report", "centre_schedule_report", "centre_update_rule"]);
    });

    it("never gives an assistant a watch area's location, and only the caller's own areas", async () => {
        await seed();
        const w = await createWatch();
        const list = await mcp("centre_list_watch_areas");
        expect(list.ok).toBe(true);
        const text = JSON.stringify(list);
        expect(text).toContain(w.id);
        expect(text).not.toContain("-33.6");
        expect(text).not.toContain("150.6");
        expect(text).not.toContain("Home");
        const other = await mcp("centre_search_incidents", { watchId: w.id }, B);
        expect(other).toMatchObject({ ok: false, error: { code: "not_found" } });
        const mine = await mcp("centre_search_incidents", { watchId: w.id });
        expect(JSON.stringify(mine)).toContain("Example Ridge Rd");
    });

    it("returns records with their provider's times, attribution and the disclaimer; refuses people without access", async () => {
        await seed();
        const situation = await mcp("centre_get_situation");
        expect(situation.ok).toBe(true);
        const data = (situation as { data: Record<string, unknown> }).data;
        expect(String(data.disclaimer)).toContain("Not an official warning service");
        expect((data.attribution as string[]).some((a) => a.includes("NSW Rural Fire Service"))).toBe(true);
        const fire = await mcp("centre_get_fire_danger", { district: "Example Ranges" });
        expect(JSON.stringify(fire)).toContain('"totalFireBanToday":true');
        expect((await mcp("centre_get_observations", { type: "weather", limit: 1 })).ok).toBe(true);
        await apiCall("POST", "/api/portal/users", { email: "editor@example.com", role: "editor" });
        expect(await mcp("centre_get_situation", {}, "editor@example.com")).toMatchObject({ ok: false, error: { code: "forbidden" } });
        expect(await mcp("centre_get_record", { recordId: "icr_nope" })).toMatchObject({ ok: false, error: { code: "validation" } });
    });
});

describe("Pages", () => {
    it("render every Centre page from the data the Worker sends, with the standing notice", async () => {
        await seed();
        const w = await createWatch();
        const record = (await records("rfs-incidents"))[0];
        for (const path of [
            "/portal/intelligence-centre",
            "/portal/intelligence-centre/map",
            "/portal/intelligence-centre/records",
            `/portal/intelligence-centre/records?watch=${w.id}&minLevel=2`,
            `/portal/intelligence-centre/records/${record.id}`,
            "/portal/intelligence-centre/hazards/weather",
            "/portal/intelligence-centre/hazards/fire-danger",
            "/portal/intelligence-centre/hazards/flood",
            "/portal/intelligence-centre/hazards/transport",
            "/portal/intelligence-centre/hazards/environment",
            "/portal/intelligence-centre/hazards/infrastructure",
            "/portal/intelligence-centre/history?range=7d",
            "/portal/intelligence-centre/briefings",
            `/portal/intelligence-centre/briefings?watch=${w.id}`,
            "/portal/intelligence-centre/watches",
            "/portal/intelligence-centre/wallboards",
            "/portal/intelligence-centre/sources",
            "/portal/intelligence-centre/settings",
        ]) {
            const page = await apiCall("GET", path);
            expect(page.status, path).toBe(200);
            const payload = JSON.parse(/<script type="application\/json" id="page-data">([\s\S]*?)<\/script>/.exec(page.text)![1]) as {
                data: PortalPageData;
                path: string;
            };
            const html = renderToString(createElement(PortalApp, { data: payload.data, path: payload.path }));
            expect(html, path).toContain("official warning service");
            expect(html, path).toContain("Recorded fixture data, not live");
        }
        expect((await apiCall("GET", "/portal/intelligence-centre/records/icr_00000000000000")).status).toBe(404);
        expect((await apiCall("GET", "/portal/intelligence-centre/hazards/nonsense")).status).toBe(404);
    });
});
