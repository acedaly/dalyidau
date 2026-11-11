// The Daly MCP gateway: https://mcp.daly.id.au/mcp (docs/MCP.md).
//
// It holds the MCP protocol (stateless Streamable HTTP), the tool descriptions, Access token
// verification and per-person rate limits. It has no database, storage or secret-store binding and
// no route to anything but Daly Portal: every portal tool call goes over the private PORTAL service
// binding to PortalMcpEntrypoint, which verifies the caller again and applies the portal's rules.
// The portal serves no tools since docs/DECOMMISSION_PORTAL_APPS.md; the binding stays so a call
// that reaches it is still refused there, and for any portal tool added later.
import type { ExecutionContext, ExportedHandler } from "@cloudflare/workers-types";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { type AuthenticatedMcpActor, type McpAuthEnv, McpAuthenticationError, authenticateMcpRequest } from "./auth";
import { type PortalInvoke, RETIRED_TOOL_NAMES, registerPortalTools, retiredToolMessage } from "./portal-tools";

interface RateLimit {
    limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface GatewayEnv extends McpAuthEnv {
    /** dalyidau :: PortalMcpEntrypoint. */
    readonly PORTAL?: { invoke: PortalInvoke };
    /** Per person (Access subject): 120 requests a minute. */
    readonly MCP_CALLS?: RateLimit;
    /** Per person: 30 portal writes a minute. */
    readonly MCP_WRITES?: RateLimit;
}

export const SERVER_INFO = { name: "daly-portal", version: "4.0.0" } as const;

/**
 * How to work with these tools, sent to every client at initialize. Daly Portal itself now serves no
 * tools (docs/DECOMMISSION_PORTAL_APPS.md); this says so, so an assistant can explain a retired tool.
 */
export const SERVER_INSTRUCTIONS = [
    "Daly Portal's own tools have been retired along with their applications: Daly Calendar and the Leave Planner, Today and the Chief of Staff context, Daly Intelligence's briefings, the Intelligence Centre, Amplenote, Home & Assets, Daly Tasks and Daly Knowledge. Any tool that was listed for them answers that it's retired, and nothing is read or changed.",
    "Ids and links come only from tool results. Never invent an id, and never say something was created or changed until the tool's result confirms it.",
].join("\n");

function jsonError(status: number, error: string): Response {
    const headers = new Headers({ "cache-control": "no-store" });
    if (status === 401) headers.set("www-authenticate", 'Bearer realm="daly-mcp"');
    if (status === 429) headers.set("retry-after", "60");
    return Response.json({ error }, { status, headers });
}

/** A fresh server per request, holding only this caller's credentials: nothing is shared between people or requests. */
export function createGatewayMcpServer(env: GatewayEnv, actor: AuthenticatedMcpActor): McpServer {
    const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });
    const portal = env.PORTAL;
    registerPortalTools(
        server,
        // Without the binding (a misconfigured deploy) every call says the portal is unreachable,
        // which the tools report as such, never as an empty result.
        (request) => (portal ? portal.invoke(request) : Promise.reject(new Error("PORTAL binding missing"))),
        actor.assertion,
        { beforeWrite: async () => !env.MCP_WRITES || (await env.MCP_WRITES.limit({ key: actor.subject })).success },
    );
    return server;
}

const RETIRED = new Set(RETIRED_TOOL_NAMES);

/**
 * A call to a retired tool (a client working from a tool list it cached before the retirement) is
 * answered here with a plain "retired" tool error, rather than the protocol's generic "not found",
 * so the assistant can tell the person what happened. It never reaches the portal. Anything else,
 * including a body that isn't one JSON-RPC message, goes to the MCP handler as usual.
 */
async function retiredToolAnswer(request: Request): Promise<Response | null> {
    if (request.method !== "POST") return null;
    let message: unknown;
    try {
        message = await request.clone().json();
    } catch {
        return null;
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) return null;
    const { jsonrpc, id, method, params } = message as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: { name?: unknown } };
    if (jsonrpc !== "2.0" || method !== "tools/call" || (typeof id !== "string" && typeof id !== "number")) return null;
    const name = params && typeof params === "object" ? params.name : undefined;
    if (typeof name !== "string" || !RETIRED.has(name)) return null;
    const error = { source: "daly-portal", error: { code: "retired", message: retiredToolMessage(name) } };
    console.log(JSON.stringify({ event: "mcp_gateway_retired_tool", tool: name }));
    return Response.json(
        { jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: JSON.stringify(error) }] } },
        { headers: { "cache-control": "no-store" } },
    );
}

export async function handleMcpRequest(request: Request, env: GatewayEnv, ctx: ExecutionContext): Promise<Response> {
    if (new URL(request.url).pathname !== "/mcp") return jsonError(404, "Not found");
    let actor: AuthenticatedMcpActor;
    try {
        actor = await authenticateMcpRequest(request, env);
    } catch (error) {
        const status = error instanceof McpAuthenticationError ? error.status : 401;
        // The status only: never the token, the person or the reason a token failed.
        console.log(JSON.stringify({ event: "mcp_gateway_refused", status }));
        return jsonError(status, error instanceof McpAuthenticationError ? error.message : "Authentication required");
    }

    // Per person, before any tool runs. Absent only in unit tests that don't need it.
    if (env.MCP_CALLS && !(await env.MCP_CALLS.limit({ key: actor.subject })).success) {
        console.log(JSON.stringify({ event: "mcp_gateway_refused", status: 429 }));
        return jsonError(429, "Too many requests");
    }

    const retired = await retiredToolAnswer(request);
    if (retired) return retired;

    const handler = createMcpHandler(() => createGatewayMcpServer(env, actor), {
        route: "/mcp",
        allowedHostnames: env.ENVIRONMENT === "production" ? ["mcp.daly.id.au"] : ["localhost", "127.0.0.1"],
    });
    return handler(request as never, env, ctx as never);
}

export default {
    fetch: (request, env, ctx) => handleMcpRequest(request as unknown as Request, env, ctx) as never,
} satisfies ExportedHandler<GatewayEnv>;
