// Chief of Staff briefings and the Intelligence MCP tools: grounded facts, recommendations that can
// only cite the briefing's own records, no regeneration when nothing changed, personal scope,
// scheduled preparation that's once a day and honours pausing, and the MCP tools' identity,
// isolation and retry rules. Every identity and record is fictional.
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PREFERENCES } from "../src/shared/intelligence/config";
import type { BriefingView, SuggestionView } from "../src/shared/intelligence/types";
import { addDays, localDate } from "../src/shared/tasks/dates";
import { scheduleBriefings } from "../worker/intelligence/briefings";
import { loadConfig } from "../worker/intelligence/settings";
import { type PortalMcpResponse, handleMcpCall } from "../worker/mcp/entrypoint";
import { aiEnv, configure, drain, iCall } from "./intelligence-helpers";
import { create as createObject, doc, personal } from "./knowledge-helpers";
import { OWNER, SECOND_OWNER, accessToken, db, resetPortal } from "./portal-helpers";
import { createProject, createTask, sharedProject } from "./tasks-helpers";

const A = OWNER;
const B = SECOND_OWNER;
const MCP_AUD = "aud-mcp-gateway-0123456789abcdef";
const today = () => localDate(new Date(), "Australia/Sydney");

beforeEach(resetPortal);

type Env = Awaited<ReturnType<typeof aiEnv>>["env"];
const briefing = async (env: Env, kind = "daily", email = A) =>
    (await iCall<{ briefing: BriefingView }>(env, "GET", `/briefings/${kind}`, undefined, email)).json.briefing;
const section = (view: BriefingView, key: string) => view.sections.find((s) => s.key === key);

describe("briefings", () => {
    it("lists facts with links, says what it never checked, and costs no inference to open", async () => {
        const { env, ai } = await aiEnv();
        await configure(env);
        const due = await createTask({ title: "Pay the council rates", dueDate: today() });
        await createTask({ title: "Return the library books", dueDate: addDays(today(), -2) });
        const view = await briefing(env);
        expect(section(view, "today")?.items.map((i) => i.title)).toContain("Pay the council rates");
        expect(section(view, "today")?.items.find((i) => i.id === due.id)?.url).toContain(`/portal/tasks/t/${due.id}`);
        expect(section(view, "overdue")?.items[0].detail).toBe("2 days overdue");
        // Calendar is part of the briefing now (Milestone 6); email never is.
        expect(view.notChecked).toContain("email");
        expect(view.notChecked).not.toContain("calendar");
        expect(section(view, "calendar")).toBeDefined();
        expect(view.recommendations.status).toBe("not_requested");
        expect(ai.calls).toHaveLength(0);
    });

    it("keeps only recommendations that cite the briefing's own records, and reuses them while nothing changes", async () => {
        const { env, ai } = await aiEnv({
            text: (_system, user) => {
                const id = /\[(tsk_[a-z0-9]{14})\]/.exec(user)![1];
                return JSON.stringify({
                    recommendations: [
                        { text: "Pay the rates first.", refs: [id] },
                        { text: "Reply to the email from your bank.", refs: ["tsk_zzzzzzzzzzzzzz"] },
                        { text: "Something with no reference.", refs: [] },
                    ],
                });
            },
        });
        await configure(env);
        await createTask({ title: "Pay the council rates", dueDate: today() });
        const made = (await iCall<{ briefing: BriefingView }>(env, "POST", "/briefings/daily/recommend", {})).json.briefing;
        expect(made.recommendations.status).toBe("ready");
        expect(made.recommendations.items.map((r) => r.text)).toEqual(["Pay the rates first."]);
        expect(made.recommendations.items[0].refs[0].title).toBe("Pay the council rates");
        const calls = ai.calls.length;
        // Same facts: opening again shows the same recommendations without another model call.
        expect((await briefing(env)).recommendations.items).toHaveLength(1);
        expect(ai.calls.length).toBe(calls);
        // New facts: the old recommendations no longer apply.
        await createTask({ title: "Book the vet", dueDate: today() });
        expect((await briefing(env)).recommendations.status).toBe("not_requested");
    });

    it("honours personal scope and excluded spaces", async () => {
        const { env } = await aiEnv();
        await configure(env);
        const shared = await sharedProject("editor");
        await createTask({ title: "Shared chore", dueDate: today(), projectId: shared.id });
        await createTask({ title: "My chore", dueDate: today() });
        const space = await personal();
        await createObject(space.id, { title: "Fresh note", content: doc("Today") });
        const prefs = { ...DEFAULT_PREFERENCES, scope: "personal" as const, excludedSpaceIds: [space.id] };
        expect((await iCall(env, "PUT", "/preferences", { version: 0, preferences: prefs })).status).toBe(200);
        const view = await briefing(env);
        expect(section(view, "today")!.items.map((i) => i.title)).toEqual(["My chore"]);
        expect(section(view, "knowledge")!.items).toHaveLength(0);
        expect(section(view, "household")).toBeUndefined();
    });

    it("builds a weekly review with completed work and projects without recent activity", async () => {
        const { env } = await aiEnv();
        await configure(env);
        const project = await createProject({ name: "Shed" });
        const task = await createTask({ title: "Order timber", projectId: project.id, dueDate: today() });
        const { apiCall } = await import("./portal-helpers");
        await apiCall("POST", `/api/portal/tasks/tasks/${task.id}/complete`, {});
        const view = await briefing(env, "weekly");
        expect(section(view, "completed")!.items.map((i) => i.title)).toContain("Order timber");
        expect(view.kind).toBe("weekly");
    });

    it("prepares scheduled briefings once a day for people who opted in, and not while paused", async () => {
        const { env } = await aiEnv();
        await configure(env);
        await iCall(env, "PUT", "/preferences", { version: 0, preferences: { ...DEFAULT_PREFERENCES, dailyTime: "00:00" } });
        await iCall(env, "PUT", "/preferences", { version: 0, preferences: { ...DEFAULT_PREFERENCES, dailyTime: "00:00", paused: true } }, B);
        const { config } = await loadConfig(env.DB);
        expect(await scheduleBriefings(env, config)).toBeGreaterThanOrEqual(1);
        await drain(env);
        expect(await scheduleBriefings(env, config)).toBe(0);
        const rows = await db()
            .prepare("SELECT email, notified_at FROM ai_briefings WHERE kind = 'daily'")
            .all<{ email: string; notified_at: string | null }>();
        expect(rows.results.map((r) => r.email)).toEqual([A]);
        expect(rows.results[0].notified_at).toBeTruthy();
        // Scheduled processing off: nothing is queued at all.
        await configure(env, { features: { ...config.features, scheduled: false } });
        await db().prepare("DELETE FROM ai_briefings").run();
        expect(await scheduleBriefings(env, (await loadConfig(env.DB)).config)).toBe(0);
    });
});

describe("Intelligence through MCP", () => {
    const mcp = async <T = Record<string, unknown>>(env: Env, tool: string, input: unknown, email = A) =>
        (await handleMcpCall(
            { ...env, MCP_ACCESS_AUD: MCP_AUD },
            { assertion: await accessToken({ email, aud: [MCP_AUD] }), tool, input },
        )) as PortalMcpResponse & { data: T };

    it("captures text into suggestions, replays a retried request id, and approves only the caller's own suggestion", async () => {
        const { env } = await aiEnv();
        await configure(env);
        const first = await mcp<{ captureId: string }>(env, "intelligence_capture_text", { text: "TODO: Service the mower", requestId: "mcp-capture-001" });
        expect(first.ok, JSON.stringify(first)).toBe(true);
        await drain(env);
        const again = await mcp<{ captureId: string; replayed: boolean }>(env, "intelligence_capture_text", {
            text: "TODO: Service the mower",
            requestId: "mcp-capture-001",
        });
        expect(again.data).toMatchObject({ captureId: first.data.captureId, replayed: true });
        const list = await mcp<{ suggestions: SuggestionView[] }>(env, "intelligence_list_suggestions", {});
        const task = list.data.suggestions.find((s) => s.kind === "task")!;
        expect(task).toBeTruthy();
        // Nothing has been created yet.
        expect((await db().prepare("SELECT COUNT(*) AS n FROM task_items").first<{ n: number }>())!.n).toBe(0);
        const theirs = await mcp(env, "intelligence_approve_suggestion", { suggestionId: task.id, requestId: "mcp-approve-b01" }, B);
        expect(theirs.ok).toBe(false);
        if (!theirs.ok) expect(theirs.error.code).toBe("not_found");
        const approved = await mcp<{ suggestion: { status: string } }>(env, "intelligence_approve_suggestion", {
            suggestionId: task.id,
            requestId: "mcp-approve-a01",
        });
        expect(approved.data.suggestion.status).toBe("applied");
        expect((await db().prepare("SELECT COUNT(*) AS n FROM task_items").first<{ n: number }>())!.n).toBe(1);
        const ledger = await db()
            .prepare("SELECT tool, entity_type, status FROM mcp_writes ORDER BY created_at")
            .all<{ tool: string; entity_type: string | null; status: string }>();
        expect(ledger.results.filter((r) => r.status === "done").map((r) => r.entity_type)).toEqual(["ai_capture", "ai_suggestion"]);
        expect(JSON.stringify(ledger.results)).not.toContain("mower");
    });

    it("refuses identity fields and unknown arguments, and hides other people's captures", async () => {
        const { env } = await aiEnv();
        await configure(env);
        const spoof = await mcp(env, "intelligence_capture_text", { text: "x", email: B });
        expect(spoof.ok).toBe(false);
        if (!spoof.ok) expect(spoof.error.code).toBe("validation");
        const mine = await mcp<{ captureId: string }>(env, "intelligence_capture_text", { text: "TODO: Mine only" });
        const status = await mcp(env, "intelligence_get_processing_status", { captureId: mine.data.captureId }, B);
        expect(status.ok).toBe(false);
        const transcript = await mcp(env, "meetings_get_transcript", { captureId: mine.data.captureId }, B);
        expect(transcript.ok).toBe(false);
    });

    it("searches Knowledge by meaning through MCP, with keyword fallback when semantic search is off", async () => {
        const { env } = await aiEnv();
        await configure(env, {
            features: {
                enabled: true,
                semanticSearch: false,
                capture: true,
                documents: false,
                meetings: false,
                briefingRecommendations: false,
                scheduled: false,
            },
        });
        const space = await personal();
        await createObject(space.id, { title: "Gutter cleaning", content: doc("Gutters before winter") });
        const result = await mcp<{ mode: string; results: { title: string }[]; fallbackReason: string }>(env, "knowledge_semantic_search", { query: "gutter" });
        expect(result.data.mode).toBe("keyword");
        expect(result.data.fallbackReason).toBeTruthy();
        expect(result.data.results.map((r) => r.title)).toEqual(["Gutter cleaning"]);
        const daily = await mcp<{ notChecked: string[]; recommendations: { label: string } }>(env, "intelligence_get_daily_briefing", {});
        expect(daily.data.notChecked).toContain("email");
        expect(daily.data.recommendations.label).toMatch(/not facts/);
    });
});
