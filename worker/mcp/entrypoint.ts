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
// portal role and permissions, then project or space membership on every record. A service binding
// can't be reached from the internet, but any Worker on the account could bind to it, so nothing
// here trusts the caller beyond what the token proves.
//
// Results come back as { ok, data } or { ok: false, error }, never as thrown exceptions, so the
// gateway can tell "not found" from "the portal is down" and never reports a failure as an empty
// list.
import { WorkerEntrypoint } from "cloudflare:workers";
import { ZodError } from "zod";
import { EventConflict } from "../calendar/events";
import type { Env } from "../env";
import { KnowledgeConflict } from "../knowledge/objects";
import { verifyMcpAssertion } from "../portal/access";
import { can, userForEmail } from "../portal/auth";
import { HttpError } from "../portal/http";
import { OpenSubtasks, TaskConflict } from "../tasks/tasks";
import { CALENDAR_TOOLS } from "./calendar";
import { CENTRE_TOOLS } from "./centre";
import { CHIEF_TOOLS } from "./chief";
import { INTELLIGENCE_TOOLS } from "./intelligence";
import { KNOWLEDGE_TOOLS } from "./knowledge";
import { claimWrite, failWrite, settleWrite } from "./ledger";
import { PLANNER_TOOLS } from "./planner";
import { DuplicateProject, PROJECT_TOOLS, StaleProject } from "./projects";
import type { ToolContext, ToolDef } from "./shared";
import { TASK_TOOLS } from "./tasks";
import { TODAY_TOOLS } from "./today";

export interface PortalMcpRequest {
    /** The Cf-Access-Jwt-Assertion the gateway received from Cloudflare Access, unchanged. */
    assertion: string;
    tool: string;
    input: unknown;
}

export type PortalMcpErrorCode =
    | "unauthenticated"
    | "forbidden"
    | "not_found"
    | "validation"
    | "conflict"
    | "duplicate"
    | "open_subtasks"
    | "in_progress"
    | "request_id_reused"
    | "unknown_tool"
    | "too_large"
    | "unavailable";

export type PortalMcpResponse =
    { ok: true; data: Record<string, unknown> } | { ok: false; error: { code: PortalMcpErrorCode; message: string; details?: Record<string, unknown> } };

export const PORTAL_MCP_TOOLS: ToolDef[] = [
    ...KNOWLEDGE_TOOLS,
    ...TASK_TOOLS,
    ...PROJECT_TOOLS,
    ...CHIEF_TOOLS,
    ...INTELLIGENCE_TOOLS,
    ...CALENDAR_TOOLS,
    ...PLANNER_TOOLS,
    ...TODAY_TOOLS,
    ...CENTRE_TOOLS,
];
const TOOLS = new Map(PORTAL_MCP_TOOLS.map((t) => [t.name, t]));
/** Tool arguments are small; anything bigger than this is refused before it is parsed. */
const MAX_INPUT_BYTES = 64_000;

const fail = (code: PortalMcpErrorCode, message: string, details?: Record<string, unknown>): PortalMcpResponse => ({
    ok: false,
    error: { code, message, ...(details ? { details } : {}) },
});

/** Turns whatever a tool threw into an answer the AI client can act on, without leaking internals. */
export function toFailure(error: unknown): PortalMcpResponse {
    if (error instanceof KnowledgeConflict) return fail("conflict", error.message, { current: error.current });
    if (error instanceof TaskConflict)
        return fail("conflict", error.message, { current: error.current ? { version: error.current.version, updatedAt: error.current.updatedAt } : null });
    if (error instanceof EventConflict)
        return fail("conflict", error.message, { current: { version: error.current.version, updatedAt: error.current.updatedAt } });
    if (error instanceof StaleProject) return fail("conflict", error.message, { current: error.current });
    if (error instanceof DuplicateProject) return fail("duplicate", error.message, { matches: error.matches });
    if (error instanceof OpenSubtasks)
        return fail("open_subtasks", `${error.message} Ask whether to complete them too, then retry with includeSubtasks.`, { count: error.count });
    if (error instanceof ZodError) {
        const issues = error.issues.slice(0, 5).map((i) => ({ path: i.path.join("."), message: i.message }));
        return fail("validation", issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join("; "), { issues });
    }
    if (error instanceof HttpError) {
        // 404 is the only answer for anything outside the caller's projects and spaces, so a private
        // record's existence can't be probed from here either.
        if (error.status === 404) return fail("not_found", "Not found, or you don't have access to it.");
        if (error.status === 403) return fail("forbidden", error.message);
        if (error.status === 409 && (error.code === "in_progress" || error.code === "request_id_reused")) return fail(error.code, error.message);
        if (error.status === 409) return fail("conflict", error.message);
        if (error.status === 413) return fail("too_large", error.message);
        if (error.status >= 400 && error.status < 500) return fail("validation", error.message);
    }
    return fail("unavailable", "Daly Portal couldn't complete that request. Nothing was assumed: try again, or check the portal.");
}

const requestKey = (input: unknown): string | null => {
    const value = input && typeof input === "object" ? (input as { requestId?: unknown }).requestId : undefined;
    return typeof value === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(value) ? value : null;
};

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

export async function handleMcpCall(env: Env, request: PortalMcpRequest, exec?: ToolContext["exec"]): Promise<PortalMcpResponse> {
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

    // 2. Which tool, and may this person use that application at all.
    const def = TOOLS.get(toolName);
    if (!def) return respond(fail("unknown_tool", "That tool isn't available from Daly Portal."));
    const allowed =
        def.permission === "any_productivity" ? can(user, "tasks.use") || can(user, "knowledge.use") || can(user, "calendar.use") : can(user, def.permission);
    if (!allowed) return respond(fail("forbidden", "You don't have access to that part of Daly Portal."));

    let size = 0;
    try {
        size = JSON.stringify(request.input ?? {}).length;
    } catch {
        return respond(fail("validation", "Arguments must be plain JSON."));
    }
    if (size > MAX_INPUT_BYTES) return respond(fail("too_large", "Those arguments are too large."));

    const ctx: ToolContext = { env, db: env.DB, user, site: new URL(env.SITE_URL).origin, exec };
    let input: unknown;
    try {
        input = def.input.parse(request.input ?? {});
    } catch (error) {
        return respond(toFailure(error));
    }

    // 3. Reads run directly. Writes are claimed in the ledger first, for the audit trail and so a
    //    retried request id returns the first result instead of writing twice.
    if (!def.write) {
        try {
            return respond({ ok: true, data: (await def.run(ctx, input)).data });
        } catch (error) {
            if (!(error instanceof HttpError || error instanceof ZodError))
                console.error(JSON.stringify({ event: "mcp_tool_error", tool: toolName, error: (error as Error)?.name }));
            return respond(toFailure(error));
        }
    }

    let claimId: string;
    try {
        const claim = await claimWrite(env.DB, user.email, def.name, requestKey(input));
        if (claim.kind === "replay") {
            const replay = def.replay ? await def.replay(ctx, claim.outcome) : { data: { replayed: true, ...claim.outcome } };
            return respond({ ok: true, data: replay.data });
        }
        claimId = claim.id;
    } catch (error) {
        return respond(toFailure(error));
    }
    try {
        const result = await def.run(ctx, input);
        if (result.outcome) await settleWrite(env.DB, claimId, result.outcome);
        else await failWrite(env.DB, claimId, "no_outcome");
        return respond({ ok: true, data: result.data });
    } catch (error) {
        const failure = toFailure(error);
        if (!(error instanceof HttpError || error instanceof ZodError || failure.ok)) {
            console.error(JSON.stringify({ event: "mcp_tool_error", tool: toolName, error: (error as Error)?.name }));
        }
        await failWrite(env.DB, claimId, failure.ok ? "unknown" : failure.error.code).catch(() => undefined);
        return respond(failure);
    }
}

/** Reached only through a service binding (the gateway's PORTAL binding, mcp/wrangler.jsonc); it has no route. */
export class PortalMcpEntrypoint extends WorkerEntrypoint<Env> {
    async invoke(request: PortalMcpRequest): Promise<PortalMcpResponse> {
        return handleMcpCall(this.env, request, this.ctx);
    }
}
