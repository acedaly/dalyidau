// The Daly MCP gateway: https://mcp.daly.id.au/mcp (docs/MCP.md).
//
// It holds the MCP protocol (stateless Streamable HTTP), the tool descriptions, Access token
// verification and per-person rate limits. It has no database, storage or secret-store binding and
// no route to anything but Daly Portal: every tool call goes over the private PORTAL service
// binding to PortalMcpEntrypoint, which verifies the caller again and applies the portal's rules.
import type { ExecutionContext, ExportedHandler } from "@cloudflare/workers-types";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { type AuthenticatedMcpActor, type McpAuthEnv, McpAuthenticationError, authenticateMcpRequest } from "./auth";
import { type PortalInvoke, registerPortalTools } from "./portal-tools";

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

export const SERVER_INFO = { name: "daly-portal", version: "2.0.0" } as const;

function jsonError(status: number, error: string): Response {
    const headers = new Headers({ "cache-control": "no-store" });
    if (status === 401) headers.set("www-authenticate", 'Bearer realm="daly-mcp"');
    if (status === 429) headers.set("retry-after", "60");
    return Response.json({ error }, { status, headers });
}

/** A fresh server per request, holding only this caller's credentials: nothing is shared between people or requests. */
export function createGatewayMcpServer(env: GatewayEnv, actor: AuthenticatedMcpActor): McpServer {
    const server = new McpServer(SERVER_INFO);
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

    const handler = createMcpHandler(() => createGatewayMcpServer(env, actor), {
        route: "/mcp",
        allowedHostnames: env.ENVIRONMENT === "production" ? ["mcp.daly.id.au"] : ["localhost", "127.0.0.1"],
    });
    return handler(request as never, env, ctx as never);
}

export default {
    fetch: (request, env, ctx) => handleMcpRequest(request as unknown as Request, env, ctx) as never,
} satisfies ExportedHandler<GatewayEnv>;
