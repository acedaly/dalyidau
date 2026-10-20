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

export const SERVER_INFO = { name: "daly-portal", version: "2.8.0" } as const;

/**
 * How to work with these tools, sent to every client at initialize. The portal enforces the rules
 * that matter (membership, roles, duplicates, versions, retries); this tells an assistant, the
 * Chief of Staff included, how to use them without surprising the person.
 */
export const SERVER_INSTRUCTIONS = [
    "Daly Portal: the signed-in person's Daly Tasks, Daly Knowledge and Daly Calendar. Results only ever include what that person can see in the portal.",
    "Ids and links come only from tool results. Never invent an id, and never say something was created or changed until the tool's result confirms it.",
    "Tasks can go in the person's Inbox (tasks_create with no projectId) or an existing project. Don't create a project for every task.",
    "When a request calls for a project: search first with tasks_search_projects. If a suitable project exists, offer to reuse it. Otherwise propose a new one (name, personal or shared, any sections) and create it with tasks_create_project only after the person agrees.",
    "Then add each task once with tasks_create (projectId, sectionId), checking tasks_list or tasks_search first if the tasks may already exist. Link Knowledge records the person can read with knowledgeObjectIds or tasks_link_knowledge. Finish with the project's url.",
    "Send a fresh requestId with every write and reuse it only when retrying that same write.",
    "Archiving is reversible and keeps everything; confirm with the person before archiving. Nothing can be deleted through these tools: permanent deletion is done by the person in the portal.",
    "Daly Intelligence proposes, the person approves. intelligence_capture_text and intelligence_request_analysis only create suggestions; show them with intelligence_list_suggestions and call intelligence_approve_suggestion only for a suggestion the person explicitly approves. Briefing recommendations are suggestions, never facts.",
    'Daly Calendar: dates, balances, leave opportunities and school holidays come from the portal\'s deterministic calculations (calendar_get_agenda, leave_get_balances, leave_forecast, leave_find_opportunities). Report them as given; never estimate a balance or invent an event. Leave you record is a draft or proposal, never requested or approved. Private and sensitive events stay "Busy" or "Private event": don\'t ask for or guess their details.',
    "Today: today_get_summary, today_get_capacity, today_list_unscheduled, today_propose_plan, today_get_conflicts and today_get_briefing only read. A proposed plan is a proposal: show it, and schedule only the sessions the person accepts with planner_schedule_task. The briefing's facts come from the person's records; explain them, never add to them.",
    "Intelligence Centre: the centre_* tools read public emergency, weather and environmental records; the only writes are creating or changing the person's own monitoring rules, scheduling a report and saving a report. They aren't an official warning service: report records and levels exactly as given, keep official, observed, derived and collection information apart, never say something is over because it left a feed, treat correlations as 'may be related' unless the provider links them, and point the person to official warnings (and Triple Zero, 000, in an emergency). Watch areas never include locations, and a rule's threshold is the person's own, not an official one.",
    "Home & Assets: the assets_* tools see only assets the person owns or that are shared with them, and values, insurance and documents only where shared. Report dates, intervals and values exactly as recorded; never estimate them, never invent serial numbers, registrations or prices, and never call something insured. Create tasks for attention items with assets_create_task (one per item; an existing one is returned).",
    "Daily Planner: planner_get_day and planner_suggest_slots only read. Suggested sessions are proposals: show them to the person and call planner_schedule_task only for times they accept. Never move or cancel a time block (planner_update_block) without asking. Scheduling never changes a task's due date or status.",
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
