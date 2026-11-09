import type { McpServer } from "@modelcontextprotocol/server";
import type { z } from "zod";
import type { PortalMcpRequest, PortalMcpResponse } from "../../worker/mcp/entrypoint";

/**
 * The Daly Portal tools and how each one is advertised.
 *
 * Since Daly Calendar, Today, Daly Intelligence, the Intelligence Centre and Amplenote were retired
 * (docs/DECOMMISSION_PORTAL_APPS.md), the portal serves no tools: PORTAL_TOOL_NAMES is empty, and
 * every tool the portal used to serve is in RETIRED_TOOL_GROUPS, answered "retired" by the gateway
 * itself (index.ts) and refused by the portal too. The mechanism stays for a future portal tool.
 *
 * This Worker holds the MCP descriptions and a first round of input validation only. Every call
 * goes over the private `PORTAL` service binding to the portal Worker's `PortalMcpEntrypoint`
 * (worker/mcp/entrypoint.ts), carrying the caller's Cloudflare Access assertion unchanged. The
 * portal verifies that assertion itself, validates the input again with its own schemas and applies
 * its own role rules to every record. Nothing here can widen what a person can see or change, and
 * no identity is ever read from tool arguments.
 *
 * PORTAL_TOOL_NAMES, PORTAL_WRITE_TOOLS and every input's field names must match PORTAL_MCP_TOOLS
 * in the portal, and RETIRED_TOOL_GROUPS the portal's RETIRED_MCP_GROUPS: test/mcp-contract.test.ts
 * compares them directly.
 */

// The binding's request and response types are the portal's own, so the two can't drift apart.
export type { PortalMcpRequest, PortalMcpResponse };

export type PortalInvoke = (request: PortalMcpRequest) => Promise<PortalMcpResponse>;

export const PORTAL_TOOL_NAMES = [] as const;

export type PortalToolName = (typeof PORTAL_TOOL_NAMES)[number];

interface RetiredTools {
    tools: readonly string[];
    message: string;
}

const retiredWith = (what: string) =>
    `This Daly Portal tool was retired with ${what}, and is no longer available. Nothing was read or changed. Refresh the tool list to see what's available.`;

/**
 * Tools of retired applications, by the retirement they went with. They aren't advertised. A client
 * that still calls one (from a list it cached) gets a clear "retired" answer from the gateway, and
 * the portal refuses them too, so no retired record can be read or changed whichever is deployed first.
 */
export const RETIRED_TOOL_GROUPS: readonly RetiredTools[] = [
    {
        message: retiredWith("Daly Knowledge and Daly Tasks"),
        tools: [
            "knowledge_list_spaces",
            "knowledge_list_types",
            "knowledge_search",
            "knowledge_get_object",
            "knowledge_list_objects",
            "knowledge_get_related",
            "knowledge_get_daily_note",
            "knowledge_create_object",
            "knowledge_update_object",
            "knowledge_append_to_object",
            "knowledge_create_daily_note",
            "tasks_list",
            "tasks_get",
            "tasks_today",
            "tasks_upcoming",
            "tasks_overdue",
            "tasks_search",
            "tasks_list_projects",
            "tasks_project_summary",
            "tasks_list_goals",
            "tasks_get_goal",
            "tasks_list_routines",
            "tasks_create",
            "tasks_update",
            "tasks_reschedule",
            "tasks_complete",
            "tasks_reopen",
            "tasks_add_comment",
            "tasks_link_knowledge",
            "tasks_search_projects",
            "tasks_create_project",
            "tasks_update_project",
            "tasks_archive_project",
            "tasks_unarchive_project",
            "knowledge_semantic_search",
            "knowledge_find_related",
            "planner_get_day",
            "planner_suggest_slots",
            "planner_schedule_task",
            "planner_update_block",
            "intelligence_list_suggestions",
            "intelligence_get_processing_status",
            "meetings_get_transcript",
            "intelligence_capture_text",
            "intelligence_request_analysis",
            "intelligence_approve_suggestion",
            "today_list_unscheduled",
            "today_propose_plan",
            "today_get_conflicts",
            "assets_link_knowledge",
            "assets_create_task",
        ],
    },
    {
        message: retiredWith("Home & Assets, which Home in Cloudflare OS replaces"),
        tools: [
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
        ],
    },
    {
        message: retiredWith("Daly Calendar and the Leave Planner"),
        tools: [
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
        ],
    },
    {
        message: retiredWith("Today and its Chief of Staff context"),
        tools: ["chief_of_staff_daily_context", "chief_of_staff_weekly_context", "today_get_summary", "today_get_capacity", "today_get_briefing"],
    },
    {
        message: retiredWith("Daly Intelligence's briefings"),
        tools: ["intelligence_get_daily_briefing", "intelligence_get_weekly_review"],
    },
    {
        message: retiredWith("the Intelligence Centre"),
        tools: [
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
        ],
    },
    {
        message: retiredWith("the portal's Amplenote integration"),
        tools: ["amplenote_list_notes", "amplenote_create_note", "amplenote_append", "amplenote_create_task"],
    },
];

export const RETIRED_TOOL_NAMES: readonly string[] = RETIRED_TOOL_GROUPS.flatMap((group) => group.tools);

/** What a retired tool answers: the retirement it went with. */
export const retiredToolMessage = (name: string) =>
    RETIRED_TOOL_GROUPS.find((group) => group.tools.includes(name))?.message ?? retiredWith("an application Daly Portal no longer has");

/** Writes are limited more tightly than reads (see index.ts). */
export const PORTAL_WRITE_TOOLS: ReadonlySet<PortalToolName> = new Set<PortalToolName>();

const READ = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
} as const;
const WRITE = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
} as const;

type ToolSpec = {
    readonly description: string;
    readonly input: z.ZodObject;
    readonly annotations: typeof READ | typeof WRITE;
};

export const PORTAL_TOOLS: Record<PortalToolName, ToolSpec> = {};

function success(data: Record<string, unknown>) {
    const value = { source: "daly-portal", ...data };
    return {
        content: [{ type: "text" as const, text: JSON.stringify(value) }],
        structuredContent: value,
    };
}

function refusal(error: { code: string; message: string; details?: Record<string, unknown> }) {
    const value = {
        source: "daly-portal",
        error: {
            code: error.code.slice(0, 40),
            message: error.message.slice(0, 1_000),
            ...(error.details ? { details: error.details } : {}),
        },
    };
    return {
        isError: true,
        content: [{ type: "text" as const, text: JSON.stringify(value) }],
    };
}

/**
 * The portal could not be reached at all. Said plainly, so a briefing never
 * reports an outage as "nothing due".
 */
const UNREACHABLE = refusal({
    code: "unavailable",
    message: "Daly Portal could not be reached, so nothing was read or changed. Do not treat this as an empty result.",
});

export type PortalToolOptions = {
    /** Called before every write tool; throws or returns false to refuse it. */
    readonly beforeWrite?: () => Promise<boolean>;
};

/** Registers the Daly Portal tools on a gateway server for one caller. */
export function registerPortalTools(server: McpServer, invoke: PortalInvoke, assertion: string, options: PortalToolOptions = {}): void {
    for (const name of PORTAL_TOOL_NAMES) {
        const spec: ToolSpec = PORTAL_TOOLS[name];
        server.registerTool(
            name,
            {
                description: spec.description,
                inputSchema: spec.input,
                annotations: spec.annotations,
            },
            async (input: unknown) => {
                if (PORTAL_WRITE_TOOLS.has(name) && options.beforeWrite) {
                    if (!(await options.beforeWrite()))
                        return refusal({
                            code: "rate_limited",
                            message: "Too many changes in a short time. Wait a minute, then try again.",
                        });
                }
                let response: PortalMcpResponse;
                try {
                    response = await invoke({ assertion, tool: name, input });
                } catch {
                    return UNREACHABLE;
                }
                if (!response || typeof response !== "object") return UNREACHABLE;
                return response.ok ? success(response.data) : refusal(response.error);
            },
        );
    }
}
