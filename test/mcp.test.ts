// The MCP gateway's portal entrypoint (worker/mcp) after the retirement of every application that
// served tools (docs/DECOMMISSION_PORTAL_APPS.md): who may call it, and that it serves no tools and
// refuses every retired one, whatever the caller's role, before reading anything. Every identity is
// fictional.
import { createExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../worker/env";
import worker, { PortalMcpEntrypoint } from "../worker/index";
import { PORTAL_MCP_TOOLS, type PortalMcpResponse, handleMcpCall } from "../worker/mcp/entrypoint";
import { RETIRED_MCP_GROUPS, RETIRED_MCP_TOOLS } from "../worker/mcp/retired";
import { AUD, OWNER, accessToken, apiCall, db, portalEnv, resetPortal } from "./portal-helpers";

const MCP_AUD = "aud-mcp-gateway-0123456789abcdef";
const A = OWNER;
const ADMIN = "admin@example.com";
const WEDDING_EDITOR = "wedding-editor@example.com";

beforeEach(resetPortal);

const mcpEnv = (overrides: Partial<Env> = {}) => portalEnv({ MCP_ACCESS_AUD: MCP_AUD, ...overrides });
const addPortalUser = (email: string, role: "admin" | "editor" | "viewer") => apiCall("POST", "/api/portal/users", { email, role });

/** Calls a tool as `email`, with a freshly signed token for the MCP Access application. */
async function mcp(tool: string, input: unknown = {}, email = A, options: { env?: Env; assertion?: string } = {}): Promise<PortalMcpResponse> {
    const assertion = options.assertion ?? (await accessToken({ email, aud: [MCP_AUD] }));
    return handleMcpCall(options.env ?? (await mcpEnv()), { assertion, tool, input });
}

async function refused(tool: string, input: unknown, email: string, code: string) {
    const response = await mcp(tool, input, email);
    expect(response.ok, JSON.stringify(response)).toBe(false);
    if (!response.ok) expect(response.error.code).toBe(code);
    return response;
}

describe("who may call the portal through the MCP gateway", () => {
    it("refuses a missing, forged, expired or wrong-audience token before anything else", async () => {
        const forged = await accessToken({ email: A, aud: [MCP_AUD], key: "other" });
        const expired = await accessToken({ email: A, aud: [MCP_AUD], expiresIn: -3600 });
        // A token for the portal's own Access application is not a token for the MCP application.
        const portalToken = await accessToken({ email: A, aud: [AUD] });
        const noEmail = await accessToken({ email: null, aud: [MCP_AUD] });
        for (const assertion of ["", "not-a-jwt", forged, expired, portalToken, noEmail]) {
            // Retired tools too: who is calling is settled before anything else.
            for (const tool of ["calendar_list_calendars", "tasks_today", "run_sql"]) {
                const response = await mcp(tool, {}, A, { assertion });
                expect(response.ok).toBe(false);
                if (!response.ok) expect(response.error.code).toBe("unauthenticated");
            }
        }
    });

    it("fails closed when the MCP audience isn't configured", async () => {
        const response = await mcp("calendar_list_calendars", {}, A, { env: await portalEnv() });
        expect(response.ok).toBe(false);
        if (!response.ok) expect(response.error.code).toBe("unauthenticated");
    });

    it("refuses the local development identity outside local development", async () => {
        const response = await mcp("calendar_list_calendars", {}, A, { assertion: "development", env: await mcpEnv({ ACCESS_DEV_EMAIL: A }) });
        expect(response.ok).toBe(false);
        if (!response.ok) expect(response.error.code).toBe("unauthenticated");
    });

    it("refuses a verified person with no portal role, or an inactive one", async () => {
        await refused("calendar_list_calendars", {}, "stranger@example.com", "forbidden");
        await refused("tasks_today", {}, "stranger@example.com", "forbidden");
        await addPortalUser(ADMIN, "admin");
        await refused("calendar_list_calendars", {}, ADMIN, "retired");
        await db().prepare("UPDATE portal_users SET active = 0 WHERE email = ?").bind(ADMIN).run();
        await refused("calendar_list_calendars", {}, ADMIN, "forbidden");
    });

    it("is exported as the Worker's named entrypoint, and works through it", async () => {
        expect(typeof PortalMcpEntrypoint).toBe("function");
        expect(typeof worker.fetch).toBe("function");
        const entrypoint = new PortalMcpEntrypoint(createExecutionContext(), await mcpEnv());
        const response = await entrypoint.invoke({ assertion: await accessToken({ email: A, aud: [MCP_AUD] }), tool: "today_get_summary", input: {} });
        expect(response).toMatchObject({ ok: false, error: { code: "retired" } });
    });
});

describe("tools", () => {
    it("serves none: every application that had tools has been retired", async () => {
        expect(PORTAL_MCP_TOOLS).toEqual([]);
        await refused("run_sql", { sql: "SELECT 1" }, A, "unknown_tool");
        await refused("wedding_list_guests", {}, A, "unknown_tool");
    });

    it("refuses every retired tool for every role, before reading anything, naming the retirement it went with", async () => {
        expect(RETIRED_MCP_TOOLS.size).toBe(121);
        expect(RETIRED_MCP_GROUPS.map((g) => g.tools.length)).toEqual([51, 14, 17, 5, 2, 28, 4]);
        await addPortalUser(ADMIN, "admin");
        await addPortalUser(WEDDING_EDITOR, "editor");
        expect(RETIRED_MCP_GROUPS.map((g) => /retired with (.+?), and is no longer available/.exec(g.message)?.[1])).toEqual([
            "Daly Knowledge and Daly Tasks",
            "Home & Assets, which Home in Cloudflare OS replaces",
            "Daly Calendar and the Leave Planner",
            "Today and its Chief of Staff context",
            "Daly Intelligence's briefings",
            "the Intelligence Centre",
            "the portal's Amplenote integration",
        ]);
        for (const email of [A, ADMIN, WEDDING_EDITOR])
            for (const group of RETIRED_MCP_GROUPS)
                for (const tool of group.tools) {
                    const response = await mcp(tool, { title: "Anything", query: "x", requestId: "retired-req-0001" }, email);
                    expect(response, `${tool} as ${email}`).toEqual({ ok: false, error: { code: "retired", message: group.message } });
                }
    });
});
