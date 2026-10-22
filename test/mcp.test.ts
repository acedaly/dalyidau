// The MCP gateway's portal entrypoint (worker/mcp) after Daly Knowledge and Daly Tasks were retired:
// who may call it, the tools it serves, the retired tools it refuses whatever the caller's role, the
// Chief of Staff context and the write ledger. Every identity and record is fictional.
import { createExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { localDate } from "../src/shared/calendar/time";
import type { Env } from "../worker/env";
import worker, { PortalMcpEntrypoint } from "../worker/index";
import { PORTAL_MCP_TOOLS, type PortalMcpResponse, handleMcpCall } from "../worker/mcp/entrypoint";
import { RETIRED_MCP_TOOLS } from "../worker/mcp/retired";
import { addPortalUser, createAsset, plusDays } from "./assets-helpers";
import { AUD, OWNER, SECOND_OWNER, accessToken, db, portalEnv, resetPortal } from "./portal-helpers";

const MCP_AUD = "aud-mcp-gateway-0123456789abcdef";
const A = OWNER;
const B = SECOND_OWNER; // the other portal owner: an owner role must still not open A's private records
const ADMIN = "admin@example.com";
const WEDDING_EDITOR = "wedding-editor@example.com";

beforeEach(resetPortal);

const mcpEnv = (overrides: Partial<Env> = {}) => portalEnv({ MCP_ACCESS_AUD: MCP_AUD, ...overrides });
const today = () => localDate(new Date(), "Australia/Sydney");

/** Calls a tool as `email`, with a freshly signed token for the MCP Access application. */
async function mcp<T = Record<string, unknown>>(tool: string, input: unknown = {}, email = A, options: { env?: Env; assertion?: string } = {}) {
    const assertion = options.assertion ?? (await accessToken({ email, aud: [MCP_AUD] }));
    const response = await handleMcpCall(options.env ?? (await mcpEnv()), { assertion, tool, input });
    return response as PortalMcpResponse & { data: T };
}

async function ok<T = Record<string, unknown>>(tool: string, input: unknown = {}, email = A): Promise<T> {
    const response = await mcp<T>(tool, input, email);
    expect(response.ok, JSON.stringify(response)).toBe(true);
    return (response as { data: T }).data;
}

async function refused(tool: string, input: unknown, email: string, code: string) {
    const response = await mcp(tool, input, email);
    expect(response.ok, JSON.stringify(response)).toBe(false);
    if (!response.ok) expect(response.error.code).toBe(code);
    return response;
}

const ledger = async () => (await db().prepare("SELECT * FROM mcp_writes ORDER BY created_at, id").all<Record<string, string | null>>()).results;

describe("who may call the portal through the MCP gateway", () => {
    it("refuses a missing, forged, expired or wrong-audience token before touching any data", async () => {
        const forged = await accessToken({ email: A, aud: [MCP_AUD], key: "other" });
        const expired = await accessToken({ email: A, aud: [MCP_AUD], expiresIn: -3600 });
        // A token for the portal's own Access application is not a token for the MCP application.
        const portalToken = await accessToken({ email: A, aud: [AUD] });
        const noEmail = await accessToken({ email: null, aud: [MCP_AUD] });
        for (const assertion of ["", "not-a-jwt", forged, expired, portalToken, noEmail]) {
            // Retired tools too: who is calling is settled before anything else.
            for (const tool of ["calendar_list_calendars", "tasks_today"]) {
                const response = await mcp(tool, {}, A, { assertion });
                expect(response.ok).toBe(false);
                if (!response.ok) expect(response.error.code).toBe("unauthenticated");
            }
        }
        expect(await ledger()).toHaveLength(0);
    });

    it("fails closed when the MCP audience isn't configured", async () => {
        const response = await mcp("calendar_list_calendars", {}, A, { env: await portalEnv() });
        expect(response.ok).toBe(false);
        if (!response.ok) expect(response.error.code).toBe("unauthenticated");
    });

    it("refuses the local development identity outside local development", async () => {
        const response = await mcp("calendar_list_calendars", {}, A, { assertion: "development", env: await mcpEnv({ ACCESS_DEV_EMAIL: A }) });
        expect(response.ok).toBe(false);
    });

    it("refuses a verified person with no portal role, or an inactive one", async () => {
        await refused("calendar_list_calendars", {}, "stranger@example.com", "forbidden");
        await refused("tasks_today", {}, "stranger@example.com", "forbidden");
        await addPortalUser(ADMIN, "admin");
        expect((await mcp("calendar_list_calendars", {}, ADMIN)).ok).toBe(true);
        await db().prepare("UPDATE portal_users SET active = 0 WHERE email = ?").bind(ADMIN).run();
        await refused("calendar_list_calendars", {}, ADMIN, "forbidden");
    });

    it("needs the application's permission: a wedding editor can't use Calendar, Home & Assets or the Chief of Staff", async () => {
        await addPortalUser(WEDDING_EDITOR, "editor");
        await refused("calendar_list_calendars", {}, WEDDING_EDITOR, "forbidden");
        await refused("assets_list", {}, WEDDING_EDITOR, "forbidden");
        await refused("chief_of_staff_daily_context", {}, WEDDING_EDITOR, "forbidden");
    });

    it("never takes identity from the arguments", async () => {
        const response = await refused("calendar_create_event", { title: "Pretend to be B", startDate: today(), email: B }, A, "validation");
        expect(JSON.stringify(response)).not.toContain(B);
        await ok("calendar_create_event", { title: "Mine", startDate: today(), startTime: "09:00" });
        const row = await db().prepare("SELECT created_by FROM calendar_events WHERE title = 'Mine'").first<{ created_by: string }>();
        expect(row?.created_by).toBe(A);
    });

    it("refuses unknown tools and oversized or malformed arguments", async () => {
        await refused("run_sql", { sql: "SELECT 1" }, A, "unknown_tool");
        await refused("calendar_search_events", { query: "x".repeat(70_000) }, A, "too_large");
        const bad = await refused("calendar_create_event", { title: "Dated", startDate: "next tuesday" }, A, "validation");
        if (!bad.ok) expect(bad.error.details?.issues).toBeDefined();
    });

    it("is exported as the Worker's named entrypoint, and works through it", async () => {
        expect(typeof PortalMcpEntrypoint).toBe("function");
        expect(typeof worker.fetch).toBe("function");
        const entrypoint = new PortalMcpEntrypoint(createExecutionContext(), await mcpEnv());
        const response = await entrypoint.invoke({ assertion: await accessToken({ email: A, aud: [MCP_AUD] }), tool: "calendar_list_calendars", input: {} });
        expect(response.ok).toBe(true);
    });

    it("serves exactly these 66 tools (the gateway side is compared directly in mcp-contract.test.ts)", () => {
        expect(PORTAL_MCP_TOOLS.map((t) => t.name).sort()).toEqual(
            [
                "chief_of_staff_daily_context",
                "chief_of_staff_weekly_context",
                "intelligence_get_daily_briefing",
                "intelligence_get_weekly_review",
                "calendar_list_calendars",
                "calendar_list_events",
                "calendar_search_events",
                "calendar_get_agenda",
                "calendar_find_conflicts",
                "calendar_list_subscriptions",
                "calendar_school_holidays",
                "leave_get_balances",
                "leave_list_bookings",
                "leave_forecast",
                "leave_find_opportunities",
                "calendar_create_event",
                "calendar_update_event",
                "calendar_create_subscription",
                "calendar_refresh_subscription",
                "leave_create_proposal",
                "leave_update_proposal",
                "today_get_summary",
                "today_get_capacity",
                "today_get_briefing",
                "centre_list_sources",
                "centre_get_source_health",
                "centre_get_situation",
                "centre_search_incidents",
                "centre_get_record",
                "centre_search_warnings",
                "centre_get_fire_danger",
                "centre_get_observations",
                "centre_list_road_disruptions",
                "centre_list_watch_areas",
                "centre_list_changes",
                "centre_get_watch_briefing",
                "centre_search_changes",
                "centre_get_timeline",
                "centre_get_replay_metadata",
                "centre_get_trends",
                "centre_list_rules",
                "centre_list_rule_matches",
                "centre_generate_report",
                "centre_list_reports",
                "centre_get_report",
                "centre_list_correlations",
                "centre_get_source_reliability",
                "centre_list_wallboards",
                "centre_create_rule",
                "centre_update_rule",
                "centre_schedule_report",
                "centre_save_report",
                "assets_search",
                "assets_list",
                "assets_get",
                "assets_maintenance_history",
                "assets_upcoming_maintenance",
                "assets_insurance_renewals",
                "assets_warranty_expiries",
                "assets_list_documents",
                "assets_summary",
                "assets_get_attention",
                "assets_create",
                "assets_update",
                "assets_create_maintenance",
                "assets_complete_maintenance",
            ].sort(),
        );
        const writes = PORTAL_MCP_TOOLS.filter((t) => t.write).map((t) => t.name);
        expect(writes.every((n) => /_(create|update|schedule|save|complete|refresh)/.test(n))).toBe(true);
        expect(writes).toHaveLength(14);
    });

    it("publishes no destructive, bulk, sharing or administrative tool", () => {
        const names = PORTAL_MCP_TOOLS.map((t) => t.name);
        expect(new Set(names).size).toBe(names.length);
        for (const name of names) expect(name).not.toMatch(/delete|destroy|purge|trash|bulk|sql|export|member|share|admin|secret|import/);
    });
});

describe("retired tools", () => {
    it("refuses every Knowledge, Tasks, project, planner and capture tool for every role, before reading anything", async () => {
        expect(RETIRED_MCP_TOOLS.size).toBe(51);
        const served = new Set(PORTAL_MCP_TOOLS.map((t) => t.name));
        for (const name of RETIRED_MCP_TOOLS) expect(served.has(name), name).toBe(false);
        await addPortalUser(ADMIN, "admin");
        await addPortalUser(WEDDING_EDITOR, "editor");
        for (const email of [A, ADMIN, WEDDING_EDITOR])
            for (const tool of RETIRED_MCP_TOOLS) {
                const response = await mcp(tool, { title: "Anything", query: "x", requestId: "retired-req-0001" }, email);
                expect(response.ok, `${tool} as ${email}`).toBe(false);
                if (!response.ok) {
                    expect(response.error.code).toBe("retired");
                    expect(response.error.message).toMatch(/retired/);
                }
            }
        // Nothing was claimed in the ledger or written anywhere.
        expect(await ledger()).toHaveLength(0);
        for (const table of ["task_items", "task_projects", "knowledge_objects", "task_time_blocks", "ai_captures"])
            expect((await db().prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n, table).toBe(0);
    });
});

describe("Chief of Staff context", () => {
    it("reports the person's own Calendar and Home & Assets facts, says what it never checked, and leaves others' out", async () => {
        await ok("calendar_create_event", { title: "Electricity meter reading", startDate: plusDays(today(), 1), startTime: "10:00" });
        await createAsset({ name: "Cub Camper Frontier", category: "trailers", vehicle: { registrationExpiry: plusDays(today(), 21) } });
        const context = await ok<{
            checked: Record<string, boolean>;
            notChecked: string[];
            calendar: { events: { count: number; items: { title: string }[] }; failingSubscriptions: unknown[] };
            homeAssets: { dueSoon: { fact: string }[] };
        }>("chief_of_staff_daily_context");
        expect(context.checked).toEqual({ calendar: true, homeAssets: true });
        expect(context).not.toHaveProperty("tasks");
        expect(context).not.toHaveProperty("knowledge");
        expect(context.notChecked).toContain("email");
        expect(context.notChecked.join(" ")).toMatch(/Daly Tasks and Daly Knowledge \(retired/);
        expect(context.calendar.events.items.map((e) => e.title)).toContain("Electricity meter reading");
        expect(context.homeAssets.dueSoon[0].fact).toBe("Cub Camper Frontier registration is due in 21 days.");
        const theirs = await ok("chief_of_staff_daily_context", {}, B);
        expect(JSON.stringify(theirs)).not.toMatch(/Electricity|Cub Camper/);
        const weekly = await ok<{ checked: Record<string, boolean>; calendar: unknown }>("chief_of_staff_weekly_context");
        expect(weekly.checked.calendar).toBe(true);
        expect(weekly).not.toHaveProperty("tasks");
    });
});

describe("the MCP write ledger", () => {
    it("records every write by person, tool and record, without titles or text, and frees a failed request id", async () => {
        await ok("calendar_create_event", { title: "Secret surprise party", startDate: today(), startTime: "18:00", requestId: "req-party-0001" });
        const rows = await ledger();
        expect(rows.map((r) => [r.email, r.tool, r.status, r.entity_type])).toEqual([[A, "calendar_create_event", "done", "calendar_event"]]);
        expect(JSON.stringify(rows)).not.toMatch(/Secret|surprise/);
        // A retried request id returns the first result instead of writing again.
        const again = await ok<{ replayed: boolean }>("calendar_create_event", {
            title: "Secret surprise party",
            startDate: today(),
            startTime: "18:00",
            requestId: "req-party-0001",
        });
        expect(again.replayed).toBe(true);
        expect((await db().prepare("SELECT COUNT(*) AS n FROM calendar_events").first<{ n: number }>())!.n).toBe(1);

        await refused("calendar_create_event", { title: "Bad", startDate: "28 February", requestId: "req-bad-date-01" }, A, "validation");
        // Nothing was written, so the corrected retry with the same id goes ahead.
        await ok("calendar_create_event", { title: "Good", startDate: "2026-02-28", requestId: "req-bad-date-01" });
        // Reads aren't writes.
        await ok("calendar_list_calendars");
        expect((await ledger()).filter((r) => r.tool === "calendar_list_calendars")).toHaveLength(0);
    });
});
