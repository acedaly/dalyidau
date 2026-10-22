// Situation reports and the assistant: deterministic sections with labelled facts, honest empty
// sections, historical reports from stored versions only, storage in R2 owned by one person,
// Knowledge notes (once, optionally linked), schedules (time zones, the switch, skipping unchanged
// facts), retention; the assistant without AI (built-in question types), with a scripted model
// (aliases instead of watch names, grounded answers), input limits. Invented data only.
import { env as testEnv } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { rfsIncidents } from "../fixtures/intelligence-centre/feeds.mjs";
import type { AssistantAnswer } from "../src/shared/centre/assistant";
import type { ReportSchedule, ReportSummary, SituationReport } from "../src/shared/centre/reports";
import type { WatchArea } from "../src/shared/centre/types";
import { aliasWatches, periodOf, routeQuestion } from "../worker/centre/assistant";
import { collectSource, runCentreCron } from "../worker/centre/ingest";
import { expireReports, nextRun, runDueReports } from "../worker/centre/reports";
import type { Env } from "../worker/env";
import { C, centreEnv, collect, enableSource, exampleWatch, fakeTransport, setFlag } from "./centre-helpers";
import { configure, scriptedAi } from "./intelligence-helpers";
import { OWNER, SECOND_OWNER, apiCall, db, portalEnv, resetPortal } from "./portal-helpers";

const media = () => (testEnv as unknown as Env).MEDIA;
const HOUR = 3_600_000;

beforeEach(resetPortal);

async function seed() {
    const env = await centreEnv();
    for (const id of ["rfs-incidents", "rfs-fire-danger", "rfs-incident-alerts", "bom-warnings", "bom-observations", "dea-hotspots", "endeavour-outages"]) {
        await enableSource(id);
        await collect(env, id, fakeTransport(new Date()), new Date());
    }
    return env;
}

const watch = async (email = OWNER) =>
    (
        await apiCall<{ watch: WatchArea }>(
            "POST",
            `${C}/watches`,
            exampleWatch({ name: "Secret Hideaway", definition: { kind: "point", lat: -33.61234, lon: 150.61234, radiusKm: 25, placeName: "Hidden Gully" } }),
            { email },
        )
    ).json.watch;

const preview = async (body: Record<string, unknown>, email = OWNER) => {
    const r = await apiCall<{ report: SituationReport }>("POST", `${C}/reports/preview`, body, { email });
    expect(r.status, r.text).toBe(200);
    return r.json.report;
};

describe("Situation reports", () => {
    it("have the eleven sections, labelled facts with links and times, and say why a section is empty", async () => {
        await seed();
        const report = await preview({ scope: { kind: "nsw" } });
        expect(report.sections.map((s) => s.key)).toEqual([
            "overview",
            "warnings",
            "incidents",
            "changes",
            "fire_danger",
            "weather",
            "water",
            "transport",
            "correlations",
            "gaps",
            "sources",
        ]);
        const facts = report.sections.flatMap((s) => s.facts);
        expect(facts.map((f) => f.ref)).toEqual(facts.map((_, i) => `F${i + 1}`));
        expect(new Set(facts.map((f) => f.nature))).toEqual(new Set(["official", "observed", "derived", "collection"]));
        const warning = report.sections.find((s) => s.key === "warnings")!.facts[0];
        expect(warning).toMatchObject({ nature: "official" });
        expect(warning.url).toMatch(/^\/portal\/intelligence-centre\/records\/icr_/);
        expect(
            report.sections
                .find((s) => s.key === "fire_danger")!
                .facts.map((f) => f.text)
                .join(" "),
        ).toContain("Total Fire Ban today in: Example Ranges");
        // No Live Traffic key: the transport section says so, not "no disruptions".
        const transport = report.sections.find((s) => s.key === "transport")!;
        expect(transport.facts.some((f) => f.text.includes("power outage"))).toBe(true);
        const gaps = report.sections
            .find((s) => s.key === "gaps")!
            .facts.map((f) => f.text)
            .join(" ");
        expect(gaps).toContain("Live Traffic");
        expect(report.limitations[0]).toContain("Not an official warning service");
        expect(report.narrative.status).toBe("not_requested");
        // Deterministic: the same facts give the same fingerprint.
        expect((await preview({ scope: { kind: "nsw" } })).fingerprint).toBe(report.fingerprint);
    });

    it("cover the caller's own watch area only, without its name or location in the facts' sources", async () => {
        await seed();
        const w = await watch();
        const report = await preview({ scope: { kind: "watch", watchId: w.id } });
        expect(report.scopeLabel).toBe("Secret Hideaway");
        expect(JSON.stringify(report.sections)).not.toContain("150.61234");
        expect((await apiCall("POST", `${C}/reports/preview`, { scope: { kind: "watch", watchId: w.id } }, { email: SECOND_OWNER })).status).toBe(404);
        expect((await apiCall("POST", `${C}/reports/preview`, { scope: { kind: "region", region: "atlantis" } })).status).toBe(422);
    });

    it("describe a past moment only from what was stored then", async () => {
        const env = await centreEnv();
        await setFlag("intelligence_centre.history", true);
        await enableSource("rfs-incidents");
        const at = (h: number) => new Date(Date.now() - h * HOUR);
        const RFS = "https://www.rfs.nsw.gov.au/feeds/majorIncidents.json";
        for (const [h, level] of [
            [4, "Advice"],
            [1, "Emergency Warning"],
        ] as const) {
            await db().prepare("UPDATE ic_sources SET next_due_at = NULL").run();
            await collectSource(env, "rfs-incidents", {
                transport: fakeTransport(at(h), { [RFS]: rfsIncidents(at(h), { level }) }),
                now: at(h),
                recordedAt: at(h),
                trigger: "manual",
            });
        }
        const past = await preview({ scope: { kind: "nsw" }, at: at(2).toISOString(), periodHours: 6 });
        expect(past.historical).toBe(true);
        const incidents = past.sections
            .find((s) => s.key === "incidents")!
            .facts.map((f) => f.text)
            .join(" ");
        expect(incidents).toContain("Advice");
        expect(incidents).not.toContain("Emergency Warning");
        expect(past.sections.find((s) => s.key === "correlations")!.empty).toContain("aren't available for a past moment");
        expect((await apiCall("POST", `${C}/reports/preview`, { scope: { kind: "nsw" }, at: new Date(Date.now() + 2 * HOUR).toISOString() })).status).toBe(422);
    });

    it("are stored in R2, owned by their author, and deleted with their content (no longer saved to Knowledge)", async () => {
        await seed();
        const saved = await apiCall<{ report: SituationReport; summary: ReportSummary }>("POST", `${C}/reports`, { scope: { kind: "nsw" } });
        expect(saved.status, saved.text).toBe(201);
        const id = saved.json.summary.id;
        const row = await db().prepare("SELECT object_key FROM ic_reports WHERE id = ?").bind(id).first<{ object_key: string }>();
        expect(row!.object_key).toBe(`private/centre/reports/${id}.json`);
        expect(await media().head(row!.object_key)).toBeTruthy();
        expect((await apiCall("GET", `${C}/reports/${id}`, undefined, { email: SECOND_OWNER })).status).toBe(404);
        expect((await apiCall<{ report: SituationReport }>("GET", `${C}/reports/${id}`)).json.report.id).toBe(id);
        expect(saved.json.summary).not.toHaveProperty("knowledgeObjectId");
        expect((await apiCall("POST", `${C}/reports/${id}/knowledge`, {})).status).toBe(410);
        expect((await apiCall("DELETE", `${C}/reports/${id}`, undefined, { email: SECOND_OWNER })).status).toBe(404);
        expect((await apiCall("DELETE", `${C}/reports/${id}`)).status).toBe(200);
        expect(await media().head(row!.object_key)).toBeNull();
    });

    it("can carry an AI narrative of the facts, grounded and labelled", async () => {
        await seed();
        const ai = scriptedAi({
            text: () =>
                JSON.stringify({
                    items: [
                        { text: "A Total Fire Ban applies in Example Ranges; follow official advice.", refs: ["F2"] },
                        { text: "Invented 77 incidents nearby.", refs: ["F1"] },
                    ],
                }),
        });
        const env = await portalEnv({ AI: ai });
        await configure(env);
        const r = await apiCall<{ report: SituationReport }>("POST", `${C}/reports/preview`, { scope: { kind: "nsw" }, narrative: true }, { env });
        expect(r.status, r.text).toBe(200);
        expect(r.json.report.narrative.status).toBe("ready");
        expect(r.json.report.narrative.items.every((i) => !i.text.includes("77"))).toBe(true);
        // Without Daly Intelligence, the narrative is simply off.
        expect((await preview({ scope: { kind: "nsw" }, narrative: true })).narrative.status).toBe("off");
    });
});

describe("Report schedules", () => {
    it("work out the next run in the schedule's own time zone, across daylight saving", () => {
        // 4 Oct 2026 is the first day of daylight saving in Sydney (UTC+11 from 2 am).
        expect(nextRun({ frequency: "daily", weekday: null, hour: 7, timeZone: "Australia/Sydney" }, new Date("2026-10-03T12:00:00Z"))).toBe(
            "2026-10-03T20:00:00.000Z",
        );
        expect(nextRun({ frequency: "weekly", weekday: 1, hour: 7, timeZone: "Australia/Sydney" }, new Date("2026-10-20T00:00:00Z"))).toBe(
            "2026-10-25T20:00:00.000Z",
        );
    });

    it("run on the cron only with the switch on, and don't make a report whose facts haven't changed", async () => {
        const env = await seed();
        const created = await apiCall<{ schedule: ReportSchedule }>("POST", `${C}/schedules`, {
            name: "Morning",
            scope: { kind: "nsw" },
            frequency: "daily",
            hour: 7,
        });
        expect(created.status, created.text).toBe(201);
        await db()
            .prepare("UPDATE ic_report_schedules SET next_run_at = ?")
            .bind(new Date(Date.now() - 60_000).toISOString())
            .run();
        await runCentreCron(env);
        expect((await db().prepare("SELECT COUNT(*) AS n FROM ic_reports").first<{ n: number }>())!.n).toBe(0);
        await setFlag("intelligence_centre.reports", true);
        await runCentreCron(env);
        expect((await db().prepare("SELECT COUNT(*) AS n FROM ic_reports").first<{ n: number }>())!.n).toBe(1);
        const alert = await db().prepare("SELECT kind, url FROM ic_alerts WHERE kind = 'report'").first<{ url: string }>();
        expect(alert!.url).toMatch(/^\/portal\/intelligence-centre\/reports\/icp_/);
        // Due again with the same facts: nothing new.
        await db()
            .prepare("UPDATE ic_report_schedules SET next_run_at = ?")
            .bind(new Date(Date.now() - 60_000).toISOString())
            .run();
        expect((await runDueReports(env)).map((r) => r.outcome)).toEqual(["unchanged"]);
        // The facts change: a new report.
        await collect(
            env,
            "rfs-incidents",
            fakeTransport(new Date(), { "https://www.rfs.nsw.gov.au/feeds/majorIncidents.json": rfsIncidents(new Date(), { level: "Emergency Warning" }) }),
        );
        await db()
            .prepare("UPDATE ic_report_schedules SET next_run_at = ?")
            .bind(new Date(Date.now() - 60_000).toISOString())
            .run();
        expect((await runDueReports(env)).map((r) => r.outcome)).toEqual(["created"]);
        expect((await apiCall<{ schedules: ReportSchedule[] }>("GET", `${C}/schedules`, undefined, { email: SECOND_OWNER })).json.schedules).toEqual([]);
        expect((await apiCall("POST", `${C}/schedules`, { name: "Bad", scope: { kind: "nsw" }, frequency: "weekly", hour: 7 })).status).toBe(422);
    });

    it("expire with their content after the retention period", async () => {
        await seed();
        const saved = await apiCall<{ summary: ReportSummary }>("POST", `${C}/reports`, { scope: { kind: "nsw" } });
        const key = `private/centre/reports/${saved.json.summary.id}.json`;
        await expireReports(await centreEnv(), new Date(Date.now() + 60_000).toISOString());
        expect(await media().head(key)).toBeNull();
        expect((await db().prepare("SELECT COUNT(*) AS n FROM ic_reports").first<{ n: number }>())!.n).toBe(0);
    });
});

describe("Assistant", () => {
    it("understands questions by their words without a model", () => {
        expect(routeQuestion("What changed in my watch area over the past 24 hours?")).toBe("watch_changes");
        expect(routeQuestion("What official warnings currently affect this region?")).toBe("current_warnings");
        expect(routeQuestion("Which recorded incidents escalated today?")).toBe("escalations");
        expect(routeQuestion("Have river observations changed significantly this week?")).toBe("river_trends");
        expect(routeQuestion("Are any road disruptions near the incidents I'm following?")).toBe("roads_near_incidents");
        expect(routeQuestion("What information is missing or stale?")).toBe("data_gaps");
        expect(routeQuestion("Compare recorded activity between 2026-10-18 and 2026-10-19")).toBe("compare_dates");
        expect(routeQuestion("Summarise the development of this incident")).toBe("incident_development");
        expect(periodOf("past 3 days")).toBe(72);
        expect(periodOf("this week")).toBe(168);
        expect(periodOf("anything")).toBe(24);
    });

    it("answers from stored records with the AI off, saying so", async () => {
        await seed();
        await watch();
        const r = await apiCall<{ answer: AssistantAnswer }>("POST", `${C}/assistant`, { question: "What official warnings currently affect my watch area?" });
        expect(r.status, r.text).toBe(200);
        expect(r.json.answer).toMatchObject({ mode: "rules", tool: "current_warnings", answer: { status: "off", items: [] } });
        expect(r.json.answer.looked.join(" ")).toContain("Secret Hideaway");
        expect(r.json.answer.facts.every((f) => f.nature === "official")).toBe(true);
        expect(r.json.answer.limitations.join(" ")).toContain("Not an official warning service");
        const gaps = (await apiCall<{ answer: AssistantAnswer }>("POST", `${C}/assistant`, { question: "What information is missing or stale?" })).json.answer;
        expect(gaps.facts.some((f) => f.text.includes("Live Traffic"))).toBe(true);
    });

    it("with the AI on, gives the model aliases instead of watch names and keeps only grounded sentences", async () => {
        await seed();
        await watch();
        expect(aliasWatches("Anything near Secret Hideaway?", [{ name: "Secret Hideaway" } as WatchArea]).text).toBe("Anything near [watch area W1]?");
        const prompts: string[] = [];
        const ai = scriptedAi({
            text: (system, user) => {
                prompts.push(user);
                if (system.includes("choose an analysis tool"))
                    return JSON.stringify({ tool: "current_warnings", hours: 24, watch: "W1", dates: null, recordQuery: null });
                return JSON.stringify({
                    items: [
                        { text: "An official warning is listed for this area; follow official advice.", refs: ["F1"] },
                        { text: "There are 42 more warnings.", refs: ["F1"] },
                    ],
                });
            },
        });
        const env = await portalEnv({ AI: ai });
        await configure(env);
        await setFlag("intelligence_centre.assistant", true);
        const r = await apiCall<{ answer: AssistantAnswer }>(
            "POST",
            `${C}/assistant`,
            { question: "What warnings affect Secret Hideaway right now?" },
            { env },
        );
        expect(r.status, r.text).toBe(200);
        expect(r.json.answer.mode).toBe("ai");
        expect(prompts.join("\n")).not.toContain("Secret Hideaway");
        expect(prompts.join("\n")).not.toContain("150.61234");
        expect(prompts[0]).toContain("[watch area W1]");
        expect(r.json.answer.answer.items.map((i) => i.text)).toEqual(["An official warning is listed for this area; follow official advice."]);
        expect(r.json.answer.limitations.join(" ")).toContain("AI interpretation of the facts listed");
    });

    it("refuses questions that are too long and limits how many are asked", async () => {
        expect((await apiCall("POST", `${C}/assistant`, { question: "x".repeat(501) })).status).toBe(422);
        expect((await apiCall("POST", `${C}/assistant`, { question: "hi", extra: true })).status).toBe(422);
        for (let i = 0; i < 30; i++) await apiCall("POST", `${C}/assistant`, { question: "What information is missing or stale?" });
        expect((await apiCall("POST", `${C}/assistant`, { question: "What information is missing or stale?" })).status).toBe(429);
    });
});
