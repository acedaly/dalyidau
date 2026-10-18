// Drives the MCP gateway (mcp/src) the way a real client does: JSON-RPC over Streamable HTTP with
// a Cloudflare Access assertion, through the portal's real PortalMcpEntrypoint logic and local D1.
//
// The gateway is given only what production gives it (mcp/wrangler.jsonc): its variables, the
// PORTAL binding and the rate limits. No database, and nothing that reaches DalyHub. Every outbound
// fetch is recorded and refused unless it is the Access key set, so a hidden dependency on any
// other service fails the test instead of quietly working.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { vi } from "vitest";
import { type GatewayEnv, handleMcpRequest } from "../../mcp/src/index";
import type { PortalMcpRequest } from "../../mcp/src/portal-tools";
import type { Env } from "../../worker/env";
import { handleMcpCall } from "../../worker/mcp/entrypoint";
import { TEAM, accessToken, jwks, portalEnv } from "../portal-helpers";

export const MCP_AUD = "aud-mcp-gateway-0123456789abcdef";
export const CERTS_URL = `https://${TEAM}/cdn-cgi/access/certs`;
export const HOST = "https://mcp.daly.id.au";

/** Every URL the code under test tried to fetch. */
export const outbound: string[] = [];

/** Refuses all outbound requests except the Access key set. Call in beforeEach. */
export function guardOutbound() {
    outbound.length = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        outbound.push(url);
        if (url === CERTS_URL) return new Response(await jwks(), { headers: { "content-type": "application/json" } });
        throw new Error(`Outbound request refused in tests: ${url}`);
    });
}

/** The portal's environment, as the dalyidau Worker would have it in production (with the test key set). */
export const portalSide = (overrides: Partial<Env> = {}) => portalEnv({ MCP_ACCESS_AUD: MCP_AUD, ...overrides });

/**
 * A PORTAL binding with service-binding semantics: arguments and results are structured-cloned
 * across the boundary, exactly as Worker RPC does, and `calls` counts what crossed it.
 */
export function portalBinding(env: Env | Promise<Env> = portalSide()) {
    const binding = {
        calls: [] as string[],
        async invoke(request: PortalMcpRequest) {
            binding.calls.push(request.tool);
            return structuredClone(await handleMcpCall(await env, structuredClone(request)));
        },
    };
    return binding;
}

/** An in-memory stand-in for a Rate Limiting binding: `limit` requests per key. */
export function rateLimit(limit: number) {
    const counts = new Map<string, number>();
    return {
        counts,
        async limit({ key }: { key: string }) {
            const next = (counts.get(key) ?? 0) + 1;
            counts.set(key, next);
            return { success: next <= limit };
        },
    };
}

export function gatewayEnv(overrides: Partial<GatewayEnv> = {}): GatewayEnv {
    return {
        ENVIRONMENT: "production",
        AUTH_MODE: "cloudflare-access",
        TEAM_DOMAIN: `https://${TEAM}`,
        POLICY_AUD: MCP_AUD,
        PORTAL: portalBinding(),
        ...overrides,
    };
}

export interface CallOptions {
    env?: GatewayEnv;
    token?: string | null;
    headers?: Record<string, string>;
    method?: string;
    url?: string;
}

export async function post(body: unknown, options: CallOptions = {}): Promise<Response> {
    const headers = new Headers({ "content-type": "application/json", accept: "application/json, text/event-stream", ...options.headers });
    if (options.token) headers.set("cf-access-jwt-assertion", options.token);
    const url = options.url ?? `${HOST}/mcp`;
    // Real requests always carry Host; the MCP handler validates it.
    if (!headers.has("host")) headers.set("host", new URL(url).host);
    const request = new Request(url, {
        method: options.method ?? "POST",
        headers,
        body: options.method && options.method !== "POST" ? undefined : JSON.stringify(body),
    });
    const ctx = createExecutionContext();
    const response = await handleMcpRequest(request, options.env ?? gatewayEnv(), ctx);
    await waitOnExecutionContext(ctx);
    return response;
}

/** Reads a JSON-RPC answer, whether it came back as JSON or as a server-sent event stream. */
export async function rpcBody(response: Response): Promise<Record<string, unknown>> {
    const text = await response.text();
    if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) return JSON.parse(text);
    const data = text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .filter(Boolean);
    const messages = data.map((d) => JSON.parse(d) as Record<string, unknown>);
    return messages.find((m) => "result" in m || "error" in m) ?? messages[0] ?? {};
}

export const PROTOCOL_VERSION = "2025-06-18";

/**
 * An MCP session as one person: initialize, then calls. The gateway is stateless, so every request
 * stands alone and carries the person's Access assertion; this mirrors what Claude and ChatGPT send.
 */
export async function session(email: string | null, options: { env?: GatewayEnv; sub?: string } = {}) {
    const token = await accessToken({ email, aud: [MCP_AUD], sub: options.sub ?? `sub-${email ?? "service"}` });
    const env = options.env ?? gatewayEnv();
    let id = 0;
    const rpc = async (method: string, params: Record<string, unknown> = {}) => {
        const response = await post(
            { jsonrpc: "2.0", id: ++id, method, params },
            { env, token, headers: method === "initialize" ? {} : { "mcp-protocol-version": PROTOCOL_VERSION } },
        );
        return { status: response.status, body: await rpcBody(response) };
    };
    const init = await rpc("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "test-client", version: "1.0.0" } });
    await post({ jsonrpc: "2.0", method: "notifications/initialized" }, { env, token, headers: { "mcp-protocol-version": PROTOCOL_VERSION } });

    /** Calls a tool; returns the parsed structured result, or the refusal. */
    const tool = async <T = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}) => {
        const { status, body } = await rpc("tools/call", { name, arguments: args });
        const result = body.result as { isError?: boolean; content?: { text: string }[]; structuredContent?: T } | undefined;
        const text = result?.content?.[0]?.text;
        let parsed: unknown;
        try {
            parsed = text ? JSON.parse(text) : undefined;
        } catch {
            // The SDK reports schema rejections as plain text.
            parsed = { error: { code: "input_validation", message: text } };
        }
        return {
            status,
            rpcError: body.error as { code: number; message: string } | undefined,
            isError: !!result?.isError,
            data: parsed as T & { error?: { code: string; message: string } },
        };
    };
    /** A tool call that must succeed. */
    const ok = async <T = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}) => {
        const answer = await tool<T>(name, args);
        if (answer.status !== 200 || answer.isError || answer.rpcError) throw new Error(`${name} failed: ${JSON.stringify(answer)}`);
        return answer.data;
    };
    return { token, env, init, rpc, tool, ok };
}
