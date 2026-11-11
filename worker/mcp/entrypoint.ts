// The portal's end of the Daly MCP gateway (docs/MCP.md).
//
// mcp.daly.id.au (the gateway Worker in mcp/, in this repository) holds the MCP protocol, the tool
// descriptions and Cloudflare Access OAuth. It reaches the portal only through this named
// entrypoint, over a private service binding, with one method and a closed set of tools. It has
// no database binding of its own.
//
// The gateway's word is not taken for who is calling. It hands over the caller's Cloudflare Access
// token as it received it, and this side verifies that token again (signature, issuer, the MCP
// application's audience, expiry, email) and then applies the portal's own rules: the person's
// portal role and permissions on every record. A service binding
// can't be reached from the internet, but any Worker on the account could bind to it, so nothing
// here trusts the caller beyond what the token proves.
//
// Results come back as { ok, data } or { ok: false, error }, never as thrown exceptions, so the
// gateway can tell "not found" from "the portal is down" and never reports a failure as an empty
// list.
//
// Since Daly Calendar, Today, Daly Intelligence, the Intelligence Centre and Amplenote were retired
// (docs/DECOMMISSION_PORTAL_APPS.md) the portal serves no tools: every call is refused, as
// "retired" for a tool that used to exist and "unknown_tool" otherwise, after the caller is verified.
import { WorkerEntrypoint } from "cloudflare:workers";
import { ZodError } from "zod";
import type { Env } from "../env";
import { verifyMcpAssertion } from "../portal/access";
import { can, userForEmail } from "../portal/auth";
import { HttpError } from "../portal/http";
import { RETIRED_MCP_TOOLS, retiredMcpMessage } from "./retired";
import type { ToolContext, ToolDef } from "./shared";

export interface PortalMcpRequest {
    /** The Cf-Access-Jwt-Assertion the gateway received from Cloudflare Access, unchanged. */
    assertion: string;
    tool: string;
    input: unknown;
}

export type PortalMcpErrorCode =
    "unauthenticated" | "forbidden" | "not_found" | "validation" | "conflict" | "unknown_tool" | "retired" | "too_large" | "unavailable";

export type PortalMcpResponse =
    { ok: true; data: Record<string, unknown> } | { ok: false; error: { code: PortalMcpErrorCode; message: string; details?: Record<string, unknown> } };

/** The tools the portal serves: none since docs/DECOMMISSION_PORTAL_APPS.md. Every one is a read. */
export const PORTAL_MCP_TOOLS: ToolDef[] = [];
const TOOLS = new Map(PORTAL_MCP_TOOLS.map((t) => [t.name, t]));
/** Tool arguments are small; anything bigger than this is refused before it is parsed. */
const MAX_INPUT_BYTES = 64_000;

const fail = (code: PortalMcpErrorCode, message: string, details?: Record<string, unknown>): PortalMcpResponse => ({
    ok: false,
    error: { code, message, ...(details ? { details } : {}) },
});

/** Turns whatever a tool threw into an answer the AI client can act on, without leaking internals. */
export function toFailure(error: unknown): PortalMcpResponse {
    if (error instanceof ZodError) {
        const issues = error.issues.slice(0, 5).map((i) => ({ path: i.path.join("."), message: i.message }));
        return fail("validation", issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join("; "), { issues });
    }
    if (error instanceof HttpError) {
        // 404 is the only answer for anything outside what the caller can reach, so a private
        // record's existence can't be probed from here either.
        if (error.status === 404) return fail("not_found", "Not found, or you don't have access to it.");
        if (error.status === 403) return fail("forbidden", error.message);
        if (error.status === 409) return fail("conflict", error.message);
        if (error.status === 413) return fail("too_large", error.message);
        if (error.status >= 400 && error.status < 500) return fail("validation", error.message);
    }
    return fail("unavailable", "Daly Portal couldn't complete that request. Nothing was assumed: try again, or check the portal.");
}

/**
 * Local development only, mirroring the portal's own dev sign-in (worker/portal/auth.ts): with
 * ENVIRONMENT=development, a localhost SITE_URL and ACCESS_DEV_EMAIL, the assertion "development"
 * acts as that email. Nothing deployed can meet all three.
 */
const devEmail = (env: Env, assertion: string): string | null => {
    if (assertion !== "development" || env.ENVIRONMENT !== "development" || !env.ACCESS_DEV_EMAIL) return null;
    try {
        const host = new URL(env.SITE_URL).hostname;
        return host === "localhost" || host === "127.0.0.1" ? env.ACCESS_DEV_EMAIL.trim().toLowerCase() : null;
    } catch {
        return null;
    }
};

export async function handleMcpCall(env: Env, request: PortalMcpRequest): Promise<PortalMcpResponse> {
    const started = Date.now();
    const toolName = typeof request?.tool === "string" ? request.tool.slice(0, 64) : "";
    const respond = (response: PortalMcpResponse) => {
        // Operational log: the tool and the outcome only. Never the person, the arguments or the result.
        console.log(
            JSON.stringify({ event: "mcp_call", tool: toolName, ok: response.ok, code: response.ok ? null : response.error.code, ms: Date.now() - started }),
        );
        return response;
    };

    // 1. Who is calling: proven by the Access token, never by anything in the arguments.
    const assertion = typeof request?.assertion === "string" ? request.assertion : "";
    let email = devEmail(env, assertion);
    if (!email) {
        const verified = await verifyMcpAssertion(assertion, env);
        if (!verified.ok) {
            console.log(JSON.stringify({ event: "mcp_auth_refused", reason: verified.reason }));
            return respond(fail("unauthenticated", "Sign in again: the portal couldn't verify who is calling."));
        }
        email = verified.identity.email;
    }
    const auth = await userForEmail(env, email);
    if (!auth.ok) return respond(fail("forbidden", "This account doesn't have access to Daly Portal."));
    const user = auth.user;

    // 2. Which tool, and may this person use that application at all. Retired tools are refused
    //    first, whatever the person's role: nothing of theirs is read.
    if (RETIRED_MCP_TOOLS.has(toolName)) return respond(fail("retired", retiredMcpMessage(toolName)));
    const def = TOOLS.get(toolName);
    if (!def) return respond(fail("unknown_tool", "That tool isn't available from Daly Portal."));
    if (!can(user, def.permission)) return respond(fail("forbidden", "You don't have access to that part of Daly Portal."));

    let size = 0;
    try {
        size = JSON.stringify(request.input ?? {}).length;
    } catch {
        return respond(fail("validation", "Arguments must be plain JSON."));
    }
    if (size > MAX_INPUT_BYTES) return respond(fail("too_large", "Those arguments are too large."));

    const ctx: ToolContext = { env, db: env.DB, user, site: new URL(env.SITE_URL).origin };
    let input: unknown;
    try {
        input = def.input.parse(request.input ?? {});
    } catch (error) {
        return respond(toFailure(error));
    }

    // 3. Run it. Every tool is a read.
    try {
        return respond({ ok: true, data: (await def.run(ctx, input)).data });
    } catch (error) {
        if (!(error instanceof HttpError || error instanceof ZodError))
            console.error(JSON.stringify({ event: "mcp_tool_error", tool: toolName, error: (error as Error)?.name }));
        return respond(toFailure(error));
    }
}

/** Reached only through a service binding (the gateway's PORTAL binding, mcp/wrangler.jsonc); it has no route. */
export class PortalMcpEntrypoint extends WorkerEntrypoint<Env> {
    async invoke(request: PortalMcpRequest): Promise<PortalMcpResponse> {
        return handleMcpCall(this.env, request);
    }
}
