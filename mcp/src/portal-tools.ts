import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { PortalMcpRequest, PortalMcpResponse } from "../../worker/mcp/entrypoint";

/**
 * The Daly MCP tools (Daly Tasks, Daly Knowledge, Daly Intelligence and Daly Calendar in Daly Portal) and how each one is advertised.
 *
 * This Worker holds the MCP descriptions and a first round of input validation only. Every call
 * goes over the private `PORTAL` service binding to the portal Worker's `PortalMcpEntrypoint`
 * (worker/mcp/entrypoint.ts), carrying the caller's Cloudflare Access assertion unchanged. The
 * portal verifies that assertion itself, validates the input again with its own schemas and applies
 * its own role, project-membership and space-membership rules to every record. Nothing here can
 * widen what a person can see or change, and no identity is ever read from tool arguments.
 *
 * PORTAL_TOOL_NAMES, PORTAL_WRITE_TOOLS and every input's field names must match PORTAL_MCP_TOOLS
 * in the portal: test/mcp-contract.test.ts compares the two directly.
 */

// The binding's request and response types are the portal's own, so the two can't drift apart.
export type { PortalMcpRequest, PortalMcpResponse };

export type PortalInvoke = (request: PortalMcpRequest) => Promise<PortalMcpResponse>;

export const PORTAL_TOOL_NAMES = [
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
    "chief_of_staff_daily_context",
    "chief_of_staff_weekly_context",
    "knowledge_semantic_search",
    "knowledge_find_related",
    "intelligence_get_daily_briefing",
    "intelligence_get_weekly_review",
    "intelligence_list_suggestions",
    "intelligence_get_processing_status",
    "meetings_get_transcript",
    "intelligence_capture_text",
    "intelligence_request_analysis",
    "intelligence_approve_suggestion",
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
] as const;

export type PortalToolName = (typeof PORTAL_TOOL_NAMES)[number];

/** Writes are limited more tightly than reads (see index.ts). */
export const PORTAL_WRITE_TOOLS: ReadonlySet<PortalToolName> = new Set([
    "knowledge_create_object",
    "knowledge_update_object",
    "knowledge_append_to_object",
    "knowledge_create_daily_note",
    "tasks_create",
    "tasks_update",
    "tasks_reschedule",
    "tasks_complete",
    "tasks_reopen",
    "tasks_add_comment",
    "tasks_link_knowledge",
    "tasks_create_project",
    "tasks_update_project",
    "tasks_archive_project",
    "tasks_unarchive_project",
    "intelligence_capture_text",
    "intelligence_request_analysis",
    "intelligence_approve_suggestion",
    "calendar_create_event",
    "calendar_update_event",
    "calendar_create_subscription",
    "calendar_refresh_subscription",
    "leave_create_proposal",
    "leave_update_proposal",
]);

/* ------------------------------------------------------------------------ */
/* Input pieces. The portal re-validates everything; these keep the         */
/* advertised schemas honest and reject obvious mistakes early.             */
/* ------------------------------------------------------------------------ */

const portalId = (prefix: string, what: string) =>
    z
        .string()
        .regex(new RegExp(`^${prefix}_[a-z0-9]{14}$`))
        .describe(`A Daly Portal ${what} id (${prefix}_…), from an earlier result.`);
const spaceId = portalId("ksp", "Knowledge space");
const objectId = portalId("kob", "Knowledge object");
const taskId = portalId("tsk", "task");
const projectId = portalId("tpj", "project");
const captureId = portalId("aic", "Intelligence capture");
const calendarId = portalId("cal", "calendar");
const eventId = portalId("cev", "calendar event");
const subscriptionId = portalId("csb", "calendar subscription");
const leaveTypeId = portalId("lvt", "leave type");
const bookingId = portalId("lvb", "leave booking");
const scenarioId = portalId("lvs", "leave scenario");
const clock = z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .describe("24-hour local time, HH:MM.");
const CAL =
    "Daly Calendar (daly.id.au/portal/calendar). Shows only calendars the person belongs to; other people's private events appear as Busy and sensitive events (children, care, health) as Private event, with no details.";
const LEAVE =
    "Daly Calendar's leave planner. Balances and dates are worked out by the portal's deterministic leave engine from the person's own settings and NSW public holidays: report them as given, never estimate or invent them, and never describe leave as approved unless its status says so.";
const suggestionId = portalId("ais", "Intelligence suggestion");
const date = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe("A calendar date, YYYY-MM-DD.");
const dateOrToday = z
    .union([z.literal("today"), date])
    .optional()
    .describe('"today" (the default, in the space\'s time zone) or YYYY-MM-DD.');
const time = z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .describe("24-hour time, HH:MM.");
const priority = z.number().int().min(1).max(4).describe("1 is the highest priority (P1), 4 the lowest (P4).");
const limit = (maximum: number) => z.number().int().min(1).max(maximum).optional();
const requestId = z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,64}$/)
    .optional()
    .describe(
        "Optional but recommended: a fresh random id for this one intended change. If the call is retried with the same id, Daly Portal returns the first result instead of changing anything twice.",
    );
const version = z
    .number()
    .int()
    .min(1)
    .describe(
        "The record's version from the result you read it in. If someone changed it since, the call is refused with a conflict instead of overwriting their change.",
    );
const recurrence = z
    .object({
        freq: z.enum(["daily", "weekly", "monthly", "yearly"]),
        interval: z.number().int().min(1).max(366).optional(),
        weekdays: z.array(z.number().int().min(1).max(7)).max(7).optional().describe("ISO weekdays: 1 = Monday … 7 = Sunday."),
        monthDay: z.number().int().optional(),
        monthWeekday: z.object({ week: z.number().int(), weekday: z.number().int() }).optional(),
        lastWorkday: z.literal(true).optional(),
        basis: z.enum(["scheduled", "completion"]).optional().describe('"scheduled" repeats from the due date; "completion" from when it was done.'),
        until: date.nullable().optional(),
        count: z.number().int().min(1).max(1000).nullable().optional(),
    })
    .describe("How the task repeats. The portal's recurrence engine applies it.");
const projectName = z.string().trim().min(1).max(120);
const projectColor = z.enum(["gray", "brand", "error", "warning", "success", "blue", "indigo", "purple", "pink", "orange"]);
const openProjectStatus = z.enum(["active", "on_hold", "completed"]);
const occurrenceScope = z
    .enum(["occurrence", "series"])
    .optional()
    .describe('For a repeating task whose date changes: "occurrence" (the default) moves only this one; "series" moves every later one too.');

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
const IDEMPOTENT_WRITE = { ...WRITE, idempotentHint: true } as const;

type ToolSpec = {
    readonly description: string;
    readonly input: z.ZodObject;
    readonly annotations: typeof READ | typeof WRITE | typeof IDEMPOTENT_WRITE;
};

const SOURCE = "Daly Portal (daly.id.au/portal). Shows only what the signed-in person can see there.";

const leaveStatus = z.enum(["draft", "proposed", "requested", "approved", "taken", "cancelled"]);

export const PORTAL_TOOLS: Record<PortalToolName, ToolSpec> = {
    /* ------------------------------ Calendar reads --------------------------- */
    calendar_list_calendars: {
        description: `${CAL} List the person's calendars (personal, shared household and subscribed), their role in each and whether events can be added to it. Read-only.`,
        input: z.object({}).strict(),
        annotations: READ,
    },
    calendar_list_events: {
        description: `${CAL} Every event occurrence between two dates (at most 92 days), in the person's time zone, with recurring events expanded. Read-only.`,
        input: z.object({ from: date, to: date, calendarIds: z.array(calendarId).max(20).optional(), limit: limit(300) }).strict(),
        annotations: READ,
    },
    calendar_search_events: {
        description: `${CAL} Search event titles and places. Each match is shown at its next occurrence. Sensitive events are never matched. Read-only.`,
        input: z.object({ query: z.string().trim().min(1).max(200), limit: limit(50) }).strict(),
        annotations: READ,
    },
    calendar_get_agenda: {
        description: `${CAL} A day-by-day agenda (default: the next 7 days from today) with events, NSW public holidays, school holidays, leave (the person's and leave others share with them), tasks due from Daly Tasks, and overlapping commitments. Use for "what's on this week?". Read-only.`,
        input: z.object({ date: date.optional(), days: z.number().int().min(1).max(31).optional() }).strict(),
        annotations: READ,
    },
    calendar_find_conflicts: {
        description: `${CAL} Overlapping busy, timed events between two dates (at most 62 days). Read-only.`,
        input: z.object({ from: date, to: date }).strict(),
        annotations: READ,
    },
    calendar_list_subscriptions: {
        description: `${CAL} External calendar subscriptions (ICS/webcal feeds) the person can see, with last successful refresh, failures and the error, never the address itself. Use failingOnly for "which subscriptions are failing?". Read-only.`,
        input: z.object({ failingOnly: z.boolean().optional() }).strict(),
        annotations: READ,
    },
    calendar_school_holidays: {
        description: `${CAL} Official NSW public school holiday periods (Eastern or Western division, default: the person's setting), whether leave is planned in each and the leave hours to cover it. Read-only.`,
        input: z.object({ from: date.optional(), to: date.optional(), division: z.enum(["eastern", "western"]).optional() }).strict(),
        annotations: READ,
    },
    leave_get_balances: {
        description: `${LEAVE} Each leave type's balance today and at a date (default today), with accrual, leave taken and any point it goes negative. "planned" counts requested and proposed leave too; "confirmed" only approved and taken. Read-only.`,
        input: z.object({ asOf: date.optional(), mode: z.enum(["confirmed", "planned"]).optional(), scenarioId: scenarioId.optional() }).strict(),
        annotations: READ,
    },
    leave_list_bookings: {
        description: `${LEAVE} The person's leave bookings with their status (draft, proposed, requested, approved, taken, cancelled). Scenario (what-if) bookings only when asked. Read-only.`,
        input: z.object({ from: date.optional(), to: date.optional(), status: leaveStatus.optional(), includeScenarios: z.boolean().optional() }).strict(),
        annotations: READ,
    },
    leave_forecast: {
        description: `${LEAVE} The projected balance at a date with the full calculation: opening balance and date, accrued, adjustments, each booking's hours, forfeited and capped hours. Use for "how much annual leave will I have in December?". Read-only.`,
        input: z
            .object({ date, leaveTypeId: leaveTypeId.optional(), mode: z.enum(["confirmed", "planned", "all"]).optional(), scenarioId: scenarioId.optional() })
            .strict(),
        annotations: READ,
    },
    leave_find_opportunities: {
        description: `${LEAVE} Deterministic leave planning. question: "longest_break" (budgetHours: longest run of days off it can make), "public_holidays" (best breaks bridging public holidays within budgetHours), "school_holidays" (cost to cover each school holiday period and whether leave is planned), "cover_period" (start and end: hours needed and balance after), "joint" (with: someone who shares their leave with the person; budgetHours each: breaks both can take together). Every answer lists the exact leave dates, hours, days off and projected balance. Read-only.`,
        input: z
            .object({
                question: z.enum(["longest_break", "public_holidays", "school_holidays", "cover_period", "joint"]),
                budgetHours: z.number().min(0).max(2000).optional(),
                theirBudgetHours: z.number().min(0).max(2000).optional(),
                from: date.optional(),
                to: date.optional(),
                start: date.optional(),
                end: date.optional(),
                leaveTypeId: leaveTypeId.optional(),
                with: z.string().email().optional().describe("For joint: the email of someone who has shared their leave with the person."),
            })
            .strict(),
        annotations: READ,
    },
    /* ------------------------------ Calendar writes -------------------------- */
    calendar_create_event: {
        description: `${CAL} WRITE: add an event to one of the person's calendars (default: their own default calendar). Timed events need startTime; endDate defaults to startDate. repeat creates a recurring event. Confirm the details with the person first. Send a fresh requestId.`,
        input: z
            .object({
                calendarId: calendarId.optional(),
                title: z.string().trim().min(1).max(300),
                allDay: z.boolean().optional(),
                startDate: date,
                startTime: clock.optional(),
                endDate: date.optional(),
                endTime: clock.optional(),
                timeZone: z.string().max(64).optional().describe("IANA zone, default the calendar's (Australia/Sydney)."),
                location: z.string().trim().max(500).optional(),
                description: z.string().trim().max(8000).optional(),
                category: z.enum(["general", "appointment", "family", "birthday", "anniversary", "school", "travel", "commitment", "work", "other"]).optional(),
                visibility: z.enum(["default", "private"]).optional(),
                repeat: z
                    .object({
                        freq: z.enum(["daily", "weekly", "monthly", "yearly"]),
                        interval: z.number().int().min(1).max(99).optional(),
                        until: date.optional(),
                        count: z.number().int().min(1).max(500).optional(),
                    })
                    .strict()
                    .optional(),
                reminderMinutes: z.array(z.number().int().min(0).max(40320)).max(3).optional(),
                requestId,
            })
            .strict(),
        annotations: WRITE,
    },
    calendar_update_event: {
        description: `${CAL} WRITE: change an event the person can edit (never a subscribed one). For a recurring event, scope "occurrence" with occurrenceKey changes one occurrence, "following" that one and every later one, "series" (default) all of them. Pass the version you read. Nothing can be deleted through this connector.`,
        input: z
            .object({
                eventId,
                version,
                scope: z.enum(["series", "occurrence", "following"]).optional(),
                occurrenceKey: z
                    .string()
                    .max(16)
                    .optional()
                    .describe("From calendar_list_events: the occurrence's original start (YYYY-MM-DD or YYYY-MM-DDTHH:MM)."),
                title: z.string().trim().min(1).max(300).optional(),
                allDay: z.boolean().optional(),
                startDate: date.optional(),
                startTime: clock.optional(),
                endDate: date.optional(),
                endTime: clock.optional(),
                location: z.string().trim().max(500).optional(),
                description: z.string().trim().max(8000).optional(),
                requestId,
            })
            .strict(),
        annotations: WRITE,
    },
    calendar_create_subscription: {
        description: `${CAL} WRITE: subscribe to an external calendar from its https or webcal address (Google, Apple, Outlook, school, sport, public holidays). Its events appear read-only and refresh about every six hours. The address is a credential: only pass one the person gave you for this, and never repeat it back. Private-network and non-https addresses are refused.`,
        input: z
            .object({ url: z.string().trim().min(8).max(2000), name: z.string().trim().min(1).max(100).optional(), shared: z.boolean().optional(), requestId })
            .strict(),
        annotations: WRITE,
    },
    calendar_refresh_subscription: {
        description: `${CAL} WRITE: refresh one subscription now (at most once a minute) and report the result.`,
        input: z.object({ subscriptionId, requestId }).strict(),
        annotations: IDEMPOTENT_WRITE,
    },
    leave_create_proposal: {
        description: `${LEAVE} WRITE: record planned leave as a draft or proposal (never requested, approved or taken: only the person changes that in the portal). Returns the projected balance afterwards. Use scenarioId to add it to a what-if scenario instead of the real plan. Confirm with the person first.`,
        input: z
            .object({
                leaveTypeId,
                startDate: date,
                endDate: date,
                part: z.enum(["full", "am", "pm", "hours"]).optional(),
                hours: z.number().min(0).max(24).optional(),
                status: z.enum(["draft", "proposed"]).optional(),
                title: z.string().trim().max(120).optional(),
                scenarioId: scenarioId.optional(),
                requestId,
            })
            .strict(),
        annotations: WRITE,
    },
    leave_update_proposal: {
        description: `${LEAVE} WRITE: change a draft or proposed booking (dates, part, title) or set it to draft, proposed or cancelled. Bookings already requested, approved or taken can't be changed here. Pass the version you read.`,
        input: z
            .object({
                bookingId,
                version,
                startDate: date.optional(),
                endDate: date.optional(),
                part: z.enum(["full", "am", "pm", "hours"]).optional(),
                hours: z.number().min(0).max(24).optional(),
                status: z.enum(["draft", "proposed", "cancelled"]).optional(),
                title: z.string().trim().max(120).optional(),
                requestId,
            })
            .strict(),
        annotations: WRITE,
    },

    /* ---------------------------- Knowledge reads --------------------------- */
    knowledge_list_spaces: {
        description: `${SOURCE} List the Knowledge spaces the person belongs to: their personal space first, then shared spaces, each with their role and today's date in that space. Read-only.`,
        input: z.object({}).strict(),
        annotations: READ,
    },
    knowledge_list_types: {
        description: `${SOURCE} List the object types in a Knowledge space (default: the personal space) with their properties, so objects can be created with the right type and property values. Read-only.`,
        input: z.object({ spaceId: spaceId.optional() }).strict(),
        annotations: READ,
    },
    knowledge_search: {
        description: `${SOURCE} Full-text search of Knowledge objects in the person's spaces (or one named space). Returns ranked results with ids, excerpts and «highlighted» matches. Read-only; use knowledge_get_object to read one in full.`,
        input: z
            .object({
                query: z.string().trim().min(1).max(300),
                spaceId: spaceId.optional(),
                type: z.string().max(60).optional().describe("A type name or slug (needs spaceId), or a type id (kty_…)."),
                tag: z.string().max(50).optional(),
                status: z.enum(["active", "archived", "any"]).optional(),
                limit: limit(25),
            })
            .strict(),
        annotations: READ,
    },
    knowledge_get_object: {
        description: `${SOURCE} Read one Knowledge object: title, type, tags, properties, version, its body as Markdown, and its links and backlinks. Read-only.`,
        input: z.object({ objectId }).strict(),
        annotations: READ,
    },
    knowledge_list_objects: {
        description: `${SOURCE} List Knowledge objects in a space (default: personal), newest first, optionally by type, tag, inbox or archive, with paging (nextOffset). Trashed objects are never listed. Read-only.`,
        input: z
            .object({
                spaceId: spaceId.optional(),
                view: z.enum(["all", "inbox", "archived"]).optional(),
                type: z.string().max(60).optional(),
                tag: z.string().max(50).optional(),
                sort: z.enum(["updated", "created", "title"]).optional(),
                updatedFrom: date.optional(),
                limit: limit(100),
                offset: z.number().int().min(0).max(100_000).optional(),
            })
            .strict(),
        annotations: READ,
    },
    knowledge_get_related: {
        description: `${SOURCE} An object's links, backlinks and suggested related objects (suggestions are leads, not facts), plus linked tasks and projects the person can see in Daly Tasks. Read-only.`,
        input: z.object({ objectId }).strict(),
        annotations: READ,
    },
    knowledge_get_daily_note: {
        description: `${SOURCE} Read the daily note for a date (default today) in a space (default personal). If nobody wrote one, says exists: false; it never creates one. Read-only.`,
        input: z.object({ spaceId: spaceId.optional(), date: dateOrToday }).strict(),
        annotations: READ,
    },
    /* ---------------------------- Knowledge writes -------------------------- */
    knowledge_create_object: {
        description: `${SOURCE} WRITE: create a Knowledge object in a space the person can edit (default: personal). Text is stored as plain paragraphs; markup in it stays literal text. Use knowledge_list_types for type names and property keys. Returns the object and its link.`,
        input: z
            .object({
                spaceId: spaceId.optional(),
                type: z.string().max(60).optional().describe('Type name, slug or id, e.g. "page", "meeting", "decision".'),
                title: z.string().trim().min(1).max(300),
                text: z.string().trim().min(1).max(20_000).optional(),
                tags: z.array(z.string().max(50)).max(30).optional(),
                properties: z.record(z.string().max(40), z.unknown()).optional().describe("Property values by key, validated against the type."),
                inInbox: z.boolean().optional(),
                requestId,
            })
            .strict(),
        annotations: WRITE,
    },
    knowledge_update_object: {
        description: `${SOURCE} WRITE: change a Knowledge object's title, tags, properties or inbox flag. It cannot replace the body (use knowledge_append_to_object to add to it), so existing rich content is never overwritten. Needs the current version; every change is kept in the object's revision history.`,
        input: z
            .object({
                objectId,
                version,
                title: z.string().trim().min(1).max(300).optional(),
                tags: z.array(z.string().max(50)).max(30).optional().describe("Replaces the whole tag set."),
                properties: z.record(z.string().max(40), z.unknown()).optional(),
                inInbox: z.boolean().optional(),
                requestId,
            })
            .strict(),
        annotations: WRITE,
    },
    knowledge_append_to_object: {
        description: `${SOURCE} WRITE: add plain-text paragraphs to the end of a Knowledge object, keeping everything already in it. With a version, refuses if the object changed since; without one, it appends to the latest version.`,
        input: z
            .object({
                objectId,
                text: z.string().trim().min(1).max(20_000),
                version: version.optional(),
                requestId,
            })
            .strict(),
        annotations: WRITE,
    },
    knowledge_create_daily_note: {
        description: `${SOURCE} WRITE: make sure the daily note for a date exists (one per date per space, never two) and optionally append time-stamped text to it.`,
        input: z
            .object({
                spaceId: spaceId.optional(),
                date: dateOrToday,
                text: z.string().trim().min(1).max(20_000).optional(),
                requestId,
            })
            .strict(),
        annotations: WRITE,
    },
    /* ------------------------------ Tasks reads ----------------------------- */
    tasks_list: {
        description: `${SOURCE} List tasks in the person's projects by filters (projects, priority, labels, due, deadline, assignee, status, personal or shared), with paging. Read-only. For today/overdue/upcoming prefer the dedicated tools.`,
        input: z
            .object({
                projectIds: z.array(projectId).max(20).optional(),
                priorities: z.array(priority).max(4).optional(),
                labels: z.array(z.string().trim().min(1).max(60)).max(10).optional(),
                due: z.enum(["any", "overdue", "today", "next7", "next30", "scheduled", "none"]).optional(),
                deadline: z.enum(["any", "overdue", "next7", "has", "none"]).optional(),
                assignee: z.enum(["anyone", "mine", "me", "unassigned", "others"]).optional(),
                status: z.enum(["open", "completed", "all"]).optional(),
                scope: z.enum(["all", "personal", "shared"]).optional(),
                text: z.string().trim().max(200).optional(),
                sort: z.enum(["due", "priority", "created", "updated", "title", "manual"]).optional(),
                limit: limit(100),
                offset: z.number().int().min(0).max(10_000).optional(),
            })
            .strict(),
        annotations: READ,
    },
    tasks_get: {
        description: `${SOURCE} Read one task in full: description, recurrence, project, subtasks, recent comments and completions, and Knowledge references (only those the person can open; others show as unavailable). Read-only.`,
        input: z.object({ taskId }).strict(),
        annotations: READ,
    },
    tasks_today: {
        description: `${SOURCE} Today's tasks (due today, overdue, deadlines reached) in the person's own time zone, plus how many they've completed today. Read-only.`,
        input: z.object({ limit: limit(100) }).strict(),
        annotations: READ,
    },
    tasks_upcoming: {
        description: `${SOURCE} Tasks due over the next days (default 7, at most 31), including future repeats of repeating tasks (marked projectedOccurrence), plus deadlines in the window. Read-only.`,
        input: z
            .object({
                from: date.optional(),
                days: z.number().int().min(1).max(31).optional(),
                limit: limit(200),
            })
            .strict(),
        annotations: READ,
    },
    tasks_overdue: {
        description: `${SOURCE} Overdue tasks: past their due date or deadline, in the person's time zone. Read-only.`,
        input: z.object({ limit: limit(100) }).strict(),
        annotations: READ,
    },
    tasks_search: {
        description: `${SOURCE} Search tasks by words in their title, description, labels or project name, and projects by name. Read-only.`,
        input: z.object({ query: z.string().trim().min(1).max(200), limit: limit(50) }).strict(),
        annotations: READ,
    },
    tasks_list_projects: {
        description: `${SOURCE} List the person's projects (Inbox, personal and shared) with open, completed and overdue counts. Read-only.`,
        input: z
            .object({
                includeArchived: z.boolean().optional(),
                kind: z.enum(["personal", "shared"]).optional(),
            })
            .strict(),
        annotations: READ,
    },
    tasks_project_summary: {
        description: `${SOURCE} One project's summary: health and why, overdue work, the next 14 days, deadlines, milestones, open tasks, linked goals and Knowledge references. Read-only.`,
        input: z.object({ projectId }).strict(),
        annotations: READ,
    },
    tasks_list_goals: {
        description: `${SOURCE} The person's goals (personal and shared with them) with progress, milestones and why any need attention. Read-only.`,
        input: z
            .object({
                kind: z.enum(["personal", "shared"]).optional(),
                activeOnly: z.boolean().optional(),
            })
            .strict(),
        annotations: READ,
    },
    tasks_get_goal: {
        description: `${SOURCE} One goal in detail: milestones, recent progress, linked projects, what's next and Knowledge references. Read-only.`,
        input: z.object({ goalId: portalId("tgl", "goal") }).strict(),
        annotations: READ,
    },
    tasks_list_routines: {
        description: `${SOURCE} Household and personal routines (repeating responsibilities), who is responsible now and who is next. Read-only.`,
        input: z
            .object({
                scope: z.enum(["personal", "shared"]).optional(),
                dueWithinDays: z.number().int().min(0).max(31).optional(),
                mineOnly: z.boolean().optional(),
                includePaused: z.boolean().optional(),
            })
            .strict(),
        annotations: READ,
    },
    /* ------------------------------ Tasks writes ---------------------------- */
    tasks_create: {
        description: `${SOURCE} WRITE: create one task. Without projectId it goes in the person's own Inbox. Only projects the person can edit are accepted. Send a requestId so a retry can't create a duplicate.`,
        input: z
            .object({
                title: z.string().min(1).max(500),
                description: z.string().max(10_000).optional(),
                projectId: projectId.optional(),
                sectionId: portalId("tsc", "section").optional(),
                parentId: taskId.optional().describe("Make it a subtask of this task."),
                priority: priority.optional(),
                dueDate: date.optional(),
                dueTime: time.optional(),
                deadline: date.optional(),
                recurrence: recurrence.optional(),
                labels: z.array(z.string().max(60)).max(20).optional(),
                assignee: z.string().max(254).optional().describe("Email of a member of a shared project."),
                isMilestone: z.boolean().optional(),
                knowledgeObjectIds: z.array(objectId).max(5).optional(),
                requestId,
            })
            .strict(),
        annotations: WRITE,
    },
    tasks_update: {
        description: `${SOURCE} WRITE: change a task's title, description, priority, dates, recurrence, labels, assignee or milestone flag. Needs the current version; a stale version is refused as a conflict.`,
        input: z
            .object({
                taskId,
                version,
                title: z.string().min(1).max(500).optional(),
                description: z.string().max(10_000).optional(),
                priority: priority.optional(),
                dueDate: date.nullable().optional(),
                dueTime: time.nullable().optional(),
                deadline: date.nullable().optional(),
                recurrence: recurrence.nullable().optional(),
                labels: z.array(z.string().max(60)).max(20).optional(),
                assignee: z.string().max(254).nullable().optional(),
                isMilestone: z.boolean().optional(),
                scope: occurrenceScope,
                requestId,
            })
            .strict(),
        annotations: WRITE,
    },
    tasks_reschedule: {
        description: `${SOURCE} WRITE: move a task's due date (and time), or clear it with null. Changes nothing else. Version is optional here because only the dates are sent.`,
        input: z
            .object({
                taskId,
                dueDate: date.nullable(),
                dueTime: time.nullable().optional(),
                version: version.optional(),
                scope: occurrenceScope,
                requestId,
            })
            .strict(),
        annotations: IDEMPOTENT_WRITE,
    },
    tasks_complete: {
        description: `${SOURCE} WRITE: complete a task. For a repeating task it completes one occurrence (pass occurrence: its due date) and moves to the next, exactly once even if retried. If the task has open subtasks it refuses with open_subtasks: ask the person, then retry with includeSubtasks: true. Reversible with tasks_reopen.`,
        input: z
            .object({
                taskId,
                occurrence: date.optional(),
                includeSubtasks: z.boolean().optional(),
                requestId,
            })
            .strict(),
        annotations: IDEMPOTENT_WRITE,
    },
    tasks_reopen: {
        description: `${SOURCE} WRITE: reopen a completed task, or undo the latest completion of a repeating task.`,
        input: z.object({ taskId, requestId }).strict(),
        annotations: WRITE,
    },
    tasks_add_comment: {
        description: `${SOURCE} WRITE: add a comment to a task the person can edit. Visible to everyone in the task's project.`,
        input: z.object({ taskId, body: z.string().min(1).max(5_000), requestId }).strict(),
        annotations: WRITE,
    },
    tasks_link_knowledge: {
        description: `${SOURCE} WRITE: reference a Knowledge object from a task. The person must be able to edit the task AND read the object; others in the project only see that a reference exists unless they can read it too.`,
        input: z.object({ taskId, objectId, requestId }).strict(),
        annotations: IDEMPOTENT_WRITE,
    },
    /* ---------------------------- Tasks projects ---------------------------- */
    tasks_search_projects: {
        description: `${SOURCE} Find the person's existing projects by name before creating one or choosing where tasks go. Matches are "exact" (the same name, ignoring case and punctuation), "similar" (shares a significant word or contains the name) or "description" (only the description mentions it), best first, archived ones included by default. Each has its id, name, personal or shared, the person's role, status, version and link. Read-only.`,
        input: z
            .object({
                query: projectName.describe("The name, or a few words of it."),
                includeArchived: z.boolean().optional(),
                limit: limit(50),
            })
            .strict(),
        annotations: READ,
    },
    tasks_create_project: {
        description: `${SOURCE} WRITE: create a Tasks project owned by the signed-in person. Search first with tasks_search_projects and prefer an existing project; ask the person before creating a new one, and never claim it exists until this returns its id. A shared project starts with only its creator in it (members are added in the portal). Refused with duplicate (listing the matches) if the person already has a project with the same name, unless they confirm a separate one and you pass allowDuplicateName: true. "Inbox" is reserved. Returns the project, its sections (for tasks_create's sectionId) and its link. Send a requestId so a retry can't create two.`,
        input: z
            .object({
                name: projectName,
                description: z.string().trim().max(2_000).optional(),
                kind: z
                    .enum(["personal", "shared"])
                    .optional()
                    .describe('"personal" (the default): only the person can see it. "shared": ready for members, who are added in the portal.'),
                color: projectColor.optional(),
                startDate: date.optional(),
                targetDate: date.optional().describe("Not before startDate."),
                defaultView: z.enum(["list", "board"]).optional(),
                sections: z.array(z.string().trim().min(1).max(120)).max(20).optional().describe("Sections to start with, in order."),
                knowledgeObjectIds: z
                    .array(objectId)
                    .max(10)
                    .optional()
                    .describe("Knowledge objects to reference from the project. Each must be readable by the person; otherwise nothing is created."),
                allowDuplicateName: z
                    .boolean()
                    .optional()
                    .describe("Only after the person confirms they want a second project with the same name as an existing one."),
                requestId,
            })
            .strict(),
        annotations: WRITE,
    },
    tasks_update_project: {
        description: `${SOURCE} WRITE: change a project's name, description, colour, start or target date (null clears), default view, review frequency, or status (active, on hold, completed; owners only). Editors can change details. Needs the current version; a stale one is refused as a conflict carrying the current version. It can't archive, restore, delete, share or change members.`,
        input: z
            .object({
                projectId,
                version,
                name: projectName.optional(),
                description: z.string().trim().max(2_000).optional(),
                color: projectColor.optional(),
                startDate: date.nullable().optional(),
                targetDate: date.nullable().optional(),
                defaultView: z.enum(["list", "board"]).optional(),
                reviewFrequency: z.enum(["none", "weekly", "fortnightly", "monthly"]).optional(),
                status: openProjectStatus.optional(),
                requestId,
            })
            .strict(),
        annotations: WRITE,
    },
    tasks_archive_project: {
        description: `${SOURCE} WRITE: archive a project (owners only; never the Inbox). Archiving is not deleting: every task, section, comment, history entry and Knowledge reference is kept, read-only, and tasks_unarchive_project brings it all back. Confirm with the person first. Needs the current version. Permanent deletion is only possible in the portal.`,
        input: z.object({ projectId, version, requestId }).strict(),
        annotations: IDEMPOTENT_WRITE,
    },
    tasks_unarchive_project: {
        description: `${SOURCE} WRITE: restore an archived project (owners only) with everything it had, as active unless another status is given. Needs the current version.`,
        input: z.object({ projectId, version, status: openProjectStatus.optional(), requestId }).strict(),
        annotations: IDEMPOTENT_WRITE,
    },
    /* ----------------------------- Chief of Staff --------------------------- */
    chief_of_staff_daily_context: {
        description: `${SOURCE} Read a bounded daily briefing from Daly Tasks and Daly Knowledge: due today, overdue, next 7 days, high priority, unsorted Inbox, milestones, routines, reviews due, projects and goals needing attention, shared household work, today's daily note, recently updated notes and recent decisions. Facts only, each with its id and link; "notChecked" names sources it never looks at (calendar, email). Use this first for a daily briefing.`,
        input: z.object({}).strict(),
        annotations: READ,
    },
    chief_of_staff_weekly_context: {
        description: `${SOURCE} Read the facts for a weekly review: what was completed in the seven days ending weekEnding (default today), what is overdue, the next 14 days and their deadlines, project health, goals, routines, and notes, meetings and decisions recorded in the week. Facts only; you propose any follow-ups, and must label them as proposals.`,
        input: z.object({ weekEnding: date.optional() }).strict(),
        annotations: READ,
    },
    /* ----------------------------- Daly Intelligence ------------------------ */
    knowledge_semantic_search: {
        description: `${SOURCE} Search the person's Knowledge by meaning as well as by words (hybrid: keyword full-text search blended with semantic similarity), for questions like "what did I decide about the household budget?". Results are only objects the person can read, each with an excerpt from the object itself and its link. "mode" says whether meaning was used; when semantic search is off or unavailable the results are keyword-only and "fallbackReason" says why. Cite only the returned objects.`,
        input: z
            .object({
                query: z.string().trim().min(1).max(300),
                spaceId: spaceId.optional(),
                type: z.string().max(40).optional().describe("An object type id from knowledge_list_types."),
                limit: limit(25),
            })
            .strict(),
        annotations: READ,
    },
    knowledge_find_related: {
        description: `${SOURCE} Related Knowledge for one object: shared tags, links, collections, similar wording and (when semantic search is on) similar meaning, with the reasons, and possible duplicates flagged. Suggestions only: nothing is linked or merged.`,
        input: z.object({ objectId }).strict(),
        annotations: READ,
    },
    intelligence_get_daily_briefing: {
        description: `${SOURCE} The person's Daily Intelligence briefing as the portal builds it: facts from Tasks and Knowledge (today, overdue, deadlines, priority projects, decisions, follow-ups, waiting on others, household, Knowledge updates) in the sections the person chose, plus AI recommendations only if the portal already prepared them, labelled as suggestions. "notChecked" lists what was never read (email, calendar, finances): never imply otherwise. Reading never runs a model.`,
        input: z.object({}).strict(),
        annotations: READ,
    },
    intelligence_get_weekly_review: {
        description: `${SOURCE} The person's weekly review for the seven days ending weekEnding (default today): completed work, projects at risk or without recent activity, overdue commitments, upcoming milestones, waiting items, Knowledge, meetings and decisions, and housekeeping. Facts with links; recommendations only if already prepared, labelled as suggestions.`,
        input: z.object({ weekEnding: date.optional() }).strict(),
        annotations: READ,
    },
    intelligence_list_suggestions: {
        description: `${SOURCE} The person's AI Suggestions Inbox: proposed tasks, follow-ups, projects, notes, decisions, meeting records, tags, links and facts extracted from their captures, each with its reason, a quote from the source (evidence), confidence and version. Pending suggestions have not been applied. Show them to the person; only call intelligence_approve_suggestion for one the person explicitly approves.`,
        input: z.object({ status: z.enum(["pending", "applied", "dismissed", "all"]).optional(), captureId: captureId.optional(), limit: limit(100) }).strict(),
        annotations: READ,
    },
    intelligence_get_processing_status: {
        description: `${SOURCE} Whether Intelligence features are available, and the state of the person's recent captures (or one capture): received, extracting, transcribing, analysing, ready or failed, with job progress and error codes.`,
        input: z.object({ captureId: captureId.optional() }).strict(),
        annotations: READ,
    },
    meetings_get_transcript: {
        description: `${SOURCE} The transcript of one of the person's recorded meetings (a capture with source "audio"), cut to maxCharacters. Speakers are not identified: never attribute words to a person unless the text names them.`,
        input: z.object({ captureId, maxCharacters: z.number().int().min(1000).max(60000).optional() }).strict(),
        annotations: READ,
    },
    intelligence_capture_text: {
        description: `${SOURCE} WRITE: hand text (notes, an email the person pasted, a meeting summary) to Intelligent Capture. It is analysed in the background into suggestions for the person to review; nothing is created in Tasks or Knowledge by this call. Uses the person's AI budget. Send a fresh requestId.`,
        input: z
            .object({ text: z.string().trim().min(1).max(60000), title: z.string().trim().max(300).optional(), spaceId: spaceId.optional(), requestId })
            .strict(),
        annotations: WRITE,
    },
    intelligence_request_analysis: {
        description: `${SOURCE} WRITE: analyse an existing Knowledge object the person can read into suggestions (tasks, decisions, tags, links) for review. Objects or spaces excluded from AI are refused. Nothing is changed until a suggestion is approved.`,
        input: z.object({ objectId, requestId }).strict(),
        annotations: WRITE,
    },
    intelligence_approve_suggestion: {
        description: `${SOURCE} WRITE: apply one suggestion the person has explicitly approved in this conversation (never on your own initiative, never several at once without asking). The portal re-checks every project, space and object in it against the person's access and creates the task, project or Knowledge record exactly as the portal's Approve button would. Approving twice returns the same record. Pass the version you read to avoid applying a suggestion that changed.`,
        input: z.object({ suggestionId, version: z.number().int().min(1).optional(), requestId }).strict(),
        annotations: IDEMPOTENT_WRITE,
    },
};

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
        const spec = PORTAL_TOOLS[name];
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
