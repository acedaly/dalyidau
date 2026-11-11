// Retired MCP tools, grouped by the retirement they went with:
//
// - Daly Knowledge and Daly Tasks (docs/DECOMMISSION_KNOWLEDGE_TASKS.md): every Knowledge, Tasks
//   and project tool, the Daily Planner's, Daly Intelligence's capture, suggestion and semantic search
//   tools, Today's task planning tools, and Home & Assets' task and Knowledge links.
// - Home & Assets (docs/DECOMMISSION_ASSETS_FINANCE.md): every other assets_* tool. Household Finance
//   never had MCP tools.
// - Daly Calendar and the Leave Planner, Today and the Chief of Staff context, Daly Intelligence's
//   briefings, the Intelligence Centre and Amplenote (docs/DECOMMISSION_PORTAL_APPS.md): every tool
//   the portal still served. Since then the portal serves no MCP tools at all.
//
// A call to one is refused with "retired" before anything is read, whichever gateway version sent
// it, so an older gateway still advertising them can't reach a retired record. The gateway keeps the
// same list (mcp/src/portal-tools.ts RETIRED_TOOL_GROUPS; test/mcp-contract.test.ts compares them).

interface RetiredTools {
    tools: readonly string[];
    message: string;
}

const retiredWith = (what: string) => `This Daly Portal tool was retired with ${what}, and is no longer available. Nothing was read or changed.`;

export const RETIRED_MCP_GROUPS: readonly RetiredTools[] = [
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

export const RETIRED_MCP_TOOLS: ReadonlySet<string> = new Set(RETIRED_MCP_GROUPS.flatMap((group) => group.tools));

/** What a retired tool answers: the retirement it went with. */
export const retiredMcpMessage = (name: string) =>
    RETIRED_MCP_GROUPS.find((group) => group.tools.includes(name))?.message ?? retiredWith("an application the portal no longer has");
