// The gateway speaks MCP the way it did when it lived in DalyHub-V2 (same agents/mcp/server handler
// and SDK versions). Since docs/DECOMMISSION_PORTAL_APPS.md Daly Portal serves no tools through it:
// it answers retired ones itself. Every identity is fictional.
import { beforeEach, describe, expect, it } from "vitest";
import { PORTAL_TOOL_NAMES, RETIRED_TOOL_GROUPS, RETIRED_TOOL_NAMES } from "../../mcp/src/portal-tools";
import { OWNER, accessToken, resetPortal } from "../portal-helpers";
import { HOST, MCP_AUD, PROTOCOL_VERSION, gatewayEnv, guardOutbound, post, rpcBody, session } from "./helpers";

beforeEach(async () => {
    await resetPortal();
    guardOutbound();
});

/** The 34 tools the DalyHub-backed gateway used to serve. None may be reachable any more. */
const LEGACY_DALYHUB_TOOLS = [
    "get_chief_of_staff_context",
    "get_weekly_review_context",
    "get_today",
    "get_projects",
    "get_project",
    "get_note",
    "get_notes",
    "get_people",
    "get_person",
    "get_areas",
    "get_area",
    "get_goals",
    "get_goal",
    "get_decisions",
    "get_waiting_for",
    "search_dalyhub",
    "capture_item",
    "create_task",
    "update_task",
    "complete_task",
    "reopen_task",
    "create_project",
    "update_project",
    "create_person",
    "update_person",
    "create_area",
    "update_area",
    "create_goal",
    "update_goal",
    "create_note",
    "update_note",
    "record_decision",
    "create_waiting_for",
    "resolve_waiting_for",
];

describe("MCP protocol", () => {
    it("initializes with instructions that explain the retirements, and advertises no Daly Portal tools", async () => {
        const s = await session(OWNER);
        expect(s.init.status).toBe(200);
        const init = s.init.body.result as {
            serverInfo: { name: string };
            protocolVersion: string;
            capabilities: Record<string, unknown>;
            instructions?: string;
        };
        expect(init.serverInfo).toMatchObject({ name: "daly-portal", version: "4.0.0" });
        expect(init.instructions).toMatch(/Daly Calendar and the Leave Planner, Today and the Chief of Staff context/);
        expect(init.instructions).toMatch(/Home & Assets, Daly Tasks and Daly Knowledge/);
        expect(init.instructions).toMatch(/Never invent an id/);
        expect(init.protocolVersion).toBe(PROTOCOL_VERSION);
        expect(PORTAL_TOOL_NAMES).toHaveLength(0);
        // With no tools registered the server offers no tools capability, so tools/list isn't a method.
        expect(init.capabilities.tools).toBeUndefined();
        const listed = await s.rpc("tools/list");
        expect(listed.status).toBe(200);
        expect((listed.body.error as { code: number }).code).toBe(-32601);
    });

    it("answers every retired tool with a clear retired error naming its retirement, without reaching the portal", async () => {
        const binding = { calls: [] as string[] };
        const s = await session(OWNER, {
            env: gatewayEnv({ PORTAL: { invoke: async (r) => (binding.calls.push(r.tool), { ok: true as const, data: {} }) } }),
        });
        expect(RETIRED_TOOL_NAMES).toHaveLength(121);
        for (const group of RETIRED_TOOL_GROUPS)
            for (const retired of group.tools) {
                const answer = await s.tool(retired, { title: "x" });
                expect(answer.isError, retired).toBe(true);
                expect(answer.data.error, retired).toEqual({ code: "retired", message: group.message });
            }
        expect(binding.calls).toEqual([]);
        // Without a valid assertion, a retired tool is refused like everything else: 401, no answer.
        expect(
            (await post({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "calendar_list_calendars", arguments: {} } }, { token: "not-a-jwt" }))
                .status,
        ).toBe(401);
    });

    it("no longer offers or runs any of the 34 DalyHub tools, or any other unknown tool", async () => {
        const binding = { calls: [] as string[] };
        const s = await session(OWNER, {
            env: gatewayEnv({ PORTAL: { invoke: async (r) => (binding.calls.push(r.tool), { ok: true as const, data: {} }) } }),
        });
        for (const legacy of [...LEGACY_DALYHUB_TOOLS, "wedding_list_guests"]) {
            const answer = await s.tool(legacy, {});
            // Either a JSON-RPC error or a tool error, never a result.
            expect(answer.rpcError ?? answer.isError, legacy).toBeTruthy();
        }
        expect(binding.calls).toEqual([]);
    });
});

describe("HTTP surface", () => {
    it("serves only /mcp", async () => {
        const token = await accessToken({ email: OWNER, aud: [MCP_AUD] });
        for (const path of ["/", "/sse", "/mcp/", "/.well-known/anything", "/portal"]) {
            const response = await post({}, { token, url: `${HOST}${path}` });
            expect(response.status, path).toBe(404);
        }
    });

    it("refuses requests without a valid Access assertion with 401 and no tool data", async () => {
        const initialize = {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "x", version: "1" } },
        };
        const forged = await accessToken({ email: OWNER, aud: [MCP_AUD], key: "other" });
        const expired = await accessToken({ email: OWNER, aud: [MCP_AUD], expiresIn: -3600 });
        const portalAudience = await accessToken({ email: OWNER, aud: ["aud-portal-0123456789abcdef"] });
        for (const token of [null, "not-a-jwt", forged, expired, portalAudience]) {
            const response = await post(initialize, { token });
            expect(response.status).toBe(401);
            expect(response.headers.get("www-authenticate")).toContain("Bearer");
            expect(await response.text()).not.toContain("tools");
        }
    });

    it("fails closed with 503 when production authentication isn't configured", async () => {
        const token = await accessToken({ email: OWNER, aud: [MCP_AUD] });
        for (const env of [
            gatewayEnv({ POLICY_AUD: undefined }),
            gatewayEnv({ TEAM_DOMAIN: undefined }),
            gatewayEnv({ TEAM_DOMAIN: "https://evil.example.com" }),
            gatewayEnv({ AUTH_MODE: "none" }),
        ]) {
            expect((await post({}, { env, token })).status).toBe(503);
        }
    });

    it("refuses the development token anywhere but localhost in development", async () => {
        const DEV_MCP_TOKEN = "d".repeat(40);
        const headers = { authorization: `Bearer ${DEV_MCP_TOKEN}` };
        const production = gatewayEnv({ AUTH_MODE: "development", DEV_MCP_TOKEN });
        expect((await post({}, { env: production, headers })).status).toBe(503);
        const devOnPublicHost = gatewayEnv({ AUTH_MODE: "development", ENVIRONMENT: "development", DEV_MCP_TOKEN });
        expect((await post({}, { env: devOnPublicHost, headers })).status).toBe(503);
        const local = gatewayEnv({ AUTH_MODE: "development", ENVIRONMENT: "development", DEV_MCP_TOKEN });
        expect((await post({}, { env: local, headers: { authorization: "Bearer wrong" }, url: "http://localhost:8798/mcp" })).status).toBe(401);
    });

    it("validates the Host header in production", async () => {
        const token = await accessToken({ email: OWNER, aud: [MCP_AUD] });
        const response = await post(
            {
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "x", version: "1" } },
            },
            { token, url: "https://dalyhub-mcp.example.workers.dev/mcp" },
        );
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(JSON.stringify(await rpcBody(response).catch(() => ({})))).not.toContain("serverInfo");
    });
});
