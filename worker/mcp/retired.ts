// MCP tools retired with Daly Knowledge and Daly Tasks (docs/DECOMMISSION_KNOWLEDGE_TASKS.md): every
// Knowledge, Tasks and project tool, the Daily Planner's, Daly Intelligence's capture, suggestion and
// semantic search tools, Today's task planning tools, and Home & Assets' task and Knowledge links.
//
// A call to one is refused with "retired" before anything is read, whichever gateway version sent
// it, so an older gateway still advertising them can't reach a retired record. The gateway keeps the
// same list (mcp/src/portal-tools.ts RETIRED_TOOL_NAMES; test/mcp-contract.test.ts compares them).
export const RETIRED_MCP_TOOLS: ReadonlySet<string> = new Set([
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
]);

export const RETIRED_MCP_MESSAGE =
    "This Daly Portal tool was retired with Daly Knowledge and Daly Tasks, and is no longer available. Nothing was read or changed.";
