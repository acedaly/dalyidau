import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { PortalMcpRequest, PortalMcpResponse } from "../../worker/mcp/entrypoint";

/**
 * The Daly MCP tools (Daly Calendar and Today, Daly Intelligence's briefings, the Intelligence Centre and Home & Assets in Daly Portal, and the owner's Amplenote through the portal) and how each one is advertised.
 *
 * This Worker holds the MCP descriptions and a first round of input validation only. Every call
 * goes over the private `PORTAL` service binding to the portal Worker's `PortalMcpEntrypoint`
 * (worker/mcp/entrypoint.ts), carrying the caller's Cloudflare Access assertion unchanged. The
 * portal verifies that assertion itself, validates the input again with its own schemas and applies
 * its own role and membership rules to every record. Nothing here can
 * widen what a person can see or change, and no identity is ever read from tool arguments.
 *
 * PORTAL_TOOL_NAMES, PORTAL_WRITE_TOOLS and every input's field names must match PORTAL_MCP_TOOLS
 * in the portal, and RETIRED_TOOL_NAMES the portal's RETIRED_MCP_TOOLS: test/mcp-contract.test.ts
 * compares them directly.
 */

// The binding's request and response types are the portal's own, so the two can't drift apart.
export type { PortalMcpRequest, PortalMcpResponse };

export type PortalInvoke = (request: PortalMcpRequest) => Promise<PortalMcpResponse>;

export const PORTAL_TOOL_NAMES = [
    "chief_of_staff_daily_context",
    "chief_of_staff_weekly_context",
    "intelligence_get_daily_briefing",
    "intelligence_get_weekly_review",
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
    "today_get_summary",
    "today_get_capacity",
    "today_get_briefing",
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
    "amplenote_list_notes",
    "amplenote_create_note",
    "amplenote_append",
    "amplenote_create_task",
] as const;

export type PortalToolName = (typeof PORTAL_TOOL_NAMES)[number];

/**
 * Tools that served Daly Knowledge, Daly Tasks, the Daily Planner and Daly Intelligence's capture and
 * suggestions, all retired (docs/DECOMMISSION_KNOWLEDGE_TASKS.md). They aren't advertised. A client
 * that still calls one (from a list it cached) gets a clear "retired" answer from the gateway, and
 * the portal refuses them too, so no retired record can be read or changed whichever is deployed first.
 */
export const RETIRED_TOOL_NAMES: readonly string[] = [
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
];

export const RETIRED_TOOL_MESSAGE =
    "This Daly Portal tool was retired with Daly Knowledge and Daly Tasks, and is no longer available. Nothing was read or changed. Refresh the tool list to see what's available.";

/** Writes are limited more tightly than reads (see index.ts). */
export const PORTAL_WRITE_TOOLS: ReadonlySet<PortalToolName> = new Set([
    "calendar_create_event",
    "calendar_update_event",
    "calendar_create_subscription",
    "calendar_refresh_subscription",
    "leave_create_proposal",
    "leave_update_proposal",
    "centre_create_rule",
    "centre_update_rule",
    "centre_schedule_report",
    "centre_save_report",
    "assets_create",
    "assets_update",
    "assets_create_maintenance",
    "assets_complete_maintenance",
    "amplenote_create_note",
    "amplenote_append",
    "amplenote_create_task",
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
const TODAY =
    "Today (daly.id.au/portal/today): the person's day from Daly Calendar and their leave. Capacity and overbooked periods come from the portal's deterministic calculations, with overlapping commitments counted once; report them as given, never estimate or invent meetings or availability.";
const date = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe("A calendar date, YYYY-MM-DD.");
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

const CENTRE =
    "Daly Intelligence Centre (daly.id.au/portal/intelligence-centre): public emergency, weather and environmental records collected from official providers, with their own times, links and attribution. Not an official warning service and possibly delayed or incomplete: report records as given (levels are the providers' own; never assign or raise one), keep official, observed and derived information apart, never say something is resolved because it left a feed, and always point the person to official warnings and Triple Zero (000) in an emergency.";
const centreRecordId = portalId("icr", "Intelligence Centre record");
const watchAreaId = portalId("icw", "watch area");
const hazard = z.enum(["fire", "fire_danger", "weather", "flood", "water", "transport", "air", "power", "earthquake", "hotspot", "space_weather", "emergency"]);
const centreRuleId = portalId("icu", "monitoring rule");
const centreReportId = portalId("icp", "situation report");
const instant = z.iso.datetime({ offset: true }).describe("An ISO 8601 time with its offset, e.g. 2026-10-20T09:00:00+11:00.");
const centreRegion = z
    .enum([
        "nsw",
        "act",
        "greater_sydney",
        "hunter",
        "illawarra_south_coast",
        "north_coast",
        "new_england_north_west",
        "central_west_orana",
        "riverina_murray",
        "far_west",
        "snowy_tablelands",
        "australia",
    ])
    .describe("A named extent (approximate rectangles inside NSW). Incidents and warnings come from NSW and ACT sources only.");
const centreReportScope = z
    .discriminatedUnion("kind", [
        z.object({ kind: z.literal("nsw") }).strict(),
        z.object({ kind: z.literal("watch"), watchId: watchAreaId }).strict(),
        z.object({ kind: z.literal("region"), region: centreRegion }).strict(),
        z.object({ kind: z.literal("incident"), recordId: centreRecordId }).strict(),
        z.object({ kind: z.literal("hazard"), category: hazard, region: centreRegion.optional() }).strict(),
    ])
    .describe("What the report covers: all of NSW, one of the person's watch areas, a region, one incident, or one hazard in a region.");
const km = z.literal("km").optional();
const centreRuleDefinition = z
    .discriminatedUnion("condition", [
        z
            .object({
                condition: z.literal("official_level"),
                watchId: watchAreaId,
                minLevel: z.number().int().min(1).max(3).describe("1 Advice, 2 Watch and Act, 3 Emergency Warning, as the provider publishes them."),
                radiusKm: z.number().min(0).max(100).optional(),
                unit: km,
                categories: z.array(hazard).optional(),
            })
            .strict(),
        z
            .object({
                condition: z.literal("fire_within"),
                watchId: watchAreaId,
                radiusKm: z.number().min(1).max(100),
                unit: km,
                notUnderControlOnly: z.boolean().optional(),
            })
            .strict(),
        z.object({ condition: z.literal("road_on_corridor"), watchId: watchAreaId, closuresOnly: z.boolean().optional() }).strict(),
        z
            .object({
                condition: z.literal("gauge_threshold"),
                station: z.string().regex(/^[A-Za-z0-9_-]{3,20}$/),
                direction: z.enum(["above", "below"]),
                threshold: z.number().min(-10).max(40),
                unit: z.literal("m"),
            })
            .strict(),
        z.object({ condition: z.literal("wind_gust"), watchId: watchAreaId, threshold: z.number().positive(), unit: z.enum(["km/h", "kn"]) }).strict(),
        z
            .object({
                condition: z.literal("temperature"),
                watchId: watchAreaId,
                direction: z.enum(["above", "below"]),
                threshold: z.number().min(-20).max(55),
                unit: z.literal("°C"),
            })
            .strict(),
        z
            .object({
                condition: z.literal("total_fire_ban"),
                district: z.string().trim().min(1).max(80),
                when: z.enum(["today", "tomorrow", "either"]).optional(),
            })
            .strict(),
        z
            .object({
                condition: z.literal("earthquake"),
                watchId: watchAreaId,
                minMagnitude: z.number().min(0).max(10),
                radiusKm: z.number().min(1).max(3000),
                unit: km,
            })
            .strict(),
        z
            .object({
                condition: z.literal("source_stale"),
                sourceId: z.string().regex(/^[a-z0-9-]{3,40}$/),
                minutes: z.number().int().min(15).max(10080).nullable().optional(),
            })
            .strict(),
    ])
    .describe(
        "The condition, with its units stated. Areas are the person's own watch areas (by id, from centre_list_watch_areas): never coordinates. Thresholds the person chooses are theirs, not official thresholds.",
    );
const AMPLENOTE =
    "The person's own Amplenote (amplenote.com), through Daly Portal: only the portal owner who connected it, while Amplenote for AI assistants is on. Amplenote is where these notes and tasks live; nothing is copied into the portal.";
const amplenoteNoteId = z
    .string()
    .regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/, "Not a valid Amplenote note id")
    .describe("The note's id (noteUuid) from amplenote_list_notes.");
const amplenoteTag = z.string().trim().max(60).describe("An Amplenote tag, lowercase, like work/rfs.");
const ASSETS =
    'Home & Assets (daly.id.au/portal/assets): what the household owns, maintains, insures or will replace. Only assets the person owns or that are shared with them; values, costs, insurance and documents only where those are shared. Report records as given: never estimate a value, a service interval or a date, and never say something is insured ("linked to a verified policy" is the most a record says).';
const assetId = portalId("ast", "asset");
const placeId = portalId("alo", "place (location or property)");
const maintenanceRecordId = portalId("amr", "maintenance record");
const assetCategory = z
    .string()
    .regex(/^(?:[a-z][a-z0-9_]{1,39}|acat_[a-z0-9]{14})$/)
    .describe(
        "A category id: vehicles, trailers, motorcycles, boats, camping, appliances, electronics, computers, phones, cameras, tools, furniture, outdoor, security, valuables, other, or a household category's acat_ id.",
    );
const assetStatus = z.enum(["active", "in_storage", "in_repair", "lent", "lost", "stolen", "sold", "disposed", "gifted"]);
const cents = z.number().int().min(0).max(100_000_000_000).describe("An amount in whole cents (AUD), as recorded. Only when the person gave it.");
const assetFields = {
    manufacturer: z.string().trim().max(120).nullable().optional(),
    brand: z.string().trim().max(120).nullable().optional(),
    model: z.string().trim().max(120).nullable().optional(),
    serialNumber: z.string().trim().max(120).nullable().optional(),
    description: z.string().trim().max(4000).nullable().optional(),
    purchaseDate: date.nullable().optional(),
    purchasePriceCents: cents.nullable().optional(),
    purchaseLocation: z.string().trim().max(200).nullable().optional(),
    locationId: placeId.nullable().optional(),
    status: assetStatus.optional(),
    notes: z.string().trim().max(8000).nullable().optional(),
    tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
};
const horizon = (fallback: number) =>
    z.number().int().min(1).max(365).optional().describe(`Days ahead (default ${fallback}). Overdue items are always included.`);
const centreRecordQuery = {
    query: z.string().trim().max(100).optional().describe("Words in the title or published location."),
    category: hazard.optional(),
    minLevel: z.number().int().min(0).max(3).optional().describe("1 Advice, 2 Watch and Act, 3 Emergency Warning (the providers' own levels)."),
    watchId: watchAreaId.optional().describe("Only records concerning one of the person's own watch areas."),
    includeNoLongerInFeed: z.boolean().optional(),
    limit: limit(100),
};
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
/** Amplenote is a service outside Daly Portal. */
const EXTERNAL_READ = { ...READ, openWorldHint: true } as const;
const EXTERNAL_WRITE = { ...WRITE, openWorldHint: true } as const;

type ToolSpec = {
    readonly description: string;
    readonly input: z.ZodObject;
    readonly annotations: typeof READ | typeof WRITE | typeof IDEMPOTENT_WRITE | typeof EXTERNAL_READ | typeof EXTERNAL_WRITE;
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
        description: `${CAL} A day-by-day agenda (default: the next 7 days from today) with events, NSW public holidays, school holidays, leave (the person's and leave others share with them), Home & Assets reminders, and overlapping commitments. Use for "what's on this week?". Read-only.`,
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

    /* --------------------------------- Today -------------------------------- */
    today_get_summary: {
        description: `${TODAY} The day's summary (default today): capacity, the timeline of commitments, breaks and leave (read-only events marked, overlaps flagged), all-day items and notifications. Read-only.`,
        input: z.object({ date: date.optional() }).strict(),
        annotations: READ,
    },
    today_get_capacity: {
        description: `${TODAY} Daily capacity (default today): available planning hours after leave, holidays, non-working days and breaks; appointment time; free time; and overbooked periods, with a plain explanation of each figure. Read-only.`,
        input: z.object({ date: date.optional() }).strict(),
        annotations: READ,
    },
    today_get_briefing: {
        description: `${TODAY} The Chief of Staff briefing for a day (default today): commitments, overbooked periods, capacity, shared family commitments and recommended next actions, each with a link to its record. Summarise or explain it, but never add anything that isn't in it. Read-only.`,
        input: z.object({ date: date.optional() }).strict(),
        annotations: READ,
    },

    /* ------------------------- Intelligence Centre ------------------------- */
    centre_list_sources: {
        description: `${CENTRE} Every public source investigated (connected, needing a key or permission, or unusable) with its status, licence and last successful retrieval. Read-only.`,
        input: z.object({}).strict(),
        annotations: READ,
    },
    centre_get_source_health: {
        description: `${CENTRE} One source's health: status and why, last attempt and success, newest publication seen, recent collection runs and the last error. Read-only.`,
        input: z
            .object({
                sourceId: z
                    .string()
                    .regex(/^[a-z0-9-]{3,40}$/)
                    .describe("A source id from centre_list_sources, e.g. rfs-incidents."),
            })
            .strict(),
        annotations: READ,
    },
    centre_get_situation: {
        description: `${CENTRE} The NSW situation from the active sources: counts of incidents and warnings by level, fire danger, weather, roads, power, air, satellite detections, earthquakes, changes in 24 hours, the most serious records and which sources aren't active. Read-only.`,
        input: z.object({}).strict(),
        annotations: READ,
    },
    centre_search_incidents: {
        description: `${CENTRE} Current incidents (and major updates) by words, hazard, level or watch area, most serious first. Read-only.`,
        input: z.object(centreRecordQuery).strict(),
        annotations: READ,
    },
    centre_get_record: {
        description: `${CENTRE} One record in full: what the provider published, its times, location quality, change history and possibly related records (derived by rule, not evidence of cause). Read-only.`,
        input: z.object({ recordId: centreRecordId }).strict(),
        annotations: READ,
    },
    centre_search_warnings: {
        description: `${CENTRE} Official warnings in force (RFS alerts, Bureau of Meteorology warnings) by words, hazard, level, source or watch area. BoM warnings name districts, not exact areas. Read-only.`,
        input: z
            .object({
                ...centreRecordQuery,
                sourceId: z
                    .string()
                    .regex(/^[a-z0-9-]{3,40}$/)
                    .optional(),
            })
            .strict(),
        annotations: READ,
    },
    centre_get_fire_danger: {
        description: `${CENTRE} Fire Danger Ratings and Total Fire Bans for today and tomorrow by NSW fire weather district, as the RFS publishes them. Read-only.`,
        input: z.object({ district: z.string().trim().max(80).optional().describe("Part of a district name, e.g. Greater Sydney.") }).strict(),
        annotations: READ,
    },
    centre_get_observations: {
        description: `${CENTRE} Measured observations (weather stations, air quality sites, followed river gauges, geomagnetic Kp), each with its own observation time. Observations, not forecasts. Read-only.`,
        input: z
            .object({ type: z.enum(["weather", "air", "water", "space_weather"]), query: z.string().trim().max(100).optional(), limit: limit(100) })
            .strict(),
        annotations: READ,
    },
    centre_list_road_disruptions: {
        description: `${CENTRE} Road closures and traffic hazards from Live Traffic NSW (needs the owner's Open Data key; says so when unavailable). Points as published: a closure point doesn't give the closed length. Read-only.`,
        input: z.object({ ...centreRecordQuery, closuresOnly: z.boolean().optional() }).strict(),
        annotations: READ,
    },
    centre_list_watch_areas: {
        description: `${CENTRE} The person's own private watch areas: names, kinds and alert settings only, never locations. Use a watchId with the search tools for what concerns an area. Read-only.`,
        input: z.object({}).strict(),
        annotations: READ,
    },
    centre_list_changes: {
        description: `${CENTRE} Changes detected between collections (new, escalated, area changed, rating changed, no longer in the feed, source failures) in the last hours, optionally for a watch area. Read-only.`,
        input: z
            .object({
                hours: z.number().int().min(1).max(168).optional(),
                kind: z
                    .enum([
                        "new",
                        "escalated",
                        "downgraded",
                        "updated",
                        "geometry_changed",
                        "not_in_feed",
                        "reappeared",
                        "ended",
                        "rating_changed",
                        "ban_declared",
                        "ban_lifted",
                        "measurement_change",
                        "source_failed",
                        "source_stale",
                        "source_recovered",
                    ])
                    .optional(),
                watchId: watchAreaId.optional(),
                limit: limit(200),
            })
            .strict(),
        annotations: READ,
    },
    centre_get_watch_briefing: {
        description: `${CENTRE} A deterministic briefing (NSW, or one watch area): facts from stored records with refs, times and links, what wasn't included, and an AI interpretation only if the person already prepared one. Never runs a model. Read-only.`,
        input: z.object({ watchId: watchAreaId.optional() }).strict(),
        annotations: READ,
    },
    centre_search_changes: {
        description: `${CENTRE} The "What's changed" feed across every enabled source: new incidents and warnings, escalations and downgrades, changed areas, fire danger and Total Fire Ban changes, closures and reopenings, outages, river rises and source failures, filtered by period, hazard, region, watch area, level, source and change type. Significant only by default. Read-only.`,
        input: z
            .object({
                hours: z.number().int().min(1).max(744).optional(),
                hazard: hazard.optional(),
                region: centreRegion.optional(),
                watchId: watchAreaId.optional(),
                minLevel: z.number().int().min(0).max(3).optional(),
                sourceId: z
                    .string()
                    .regex(/^[a-z0-9-]{3,40}$/)
                    .optional(),
                changeType: z.enum(["new", "escalation", "area", "fire_danger", "ended", "measurement", "source", "updated"]).optional(),
                significantOnly: z.boolean().optional(),
                limit: limit(200),
            })
            .strict(),
        annotations: READ,
    },
    centre_get_timeline: {
        description: `${CENTRE} One record's timeline from what the Centre collected: first collection, the provider's publication and updates (with the provider's time and when it was collected), level, status and area changes, ending or leaving the feed, nearby observations, road disruptions and satellite detections, correlations and collection gaps, each labelled official, observed, derived or collection. Read-only.`,
        input: z.object({ recordId: centreRecordId, limit: limit(300) }).strict(),
        annotations: READ,
    },
    centre_get_replay_metadata: {
        description: `${CENTRE} What historical replay can show: when history recording began, the oldest retained moment, the moments things changed (for a period of up to 31 days) and collection gaps; optionally the records the Centre had stored at one past moment. Never fills the past in with later information. Read-only.`,
        input: z
            .object({ from: instant.optional(), to: instant.optional(), at: instant.optional(), region: centreRegion.optional(), limit: limit(100) })
            .strict(),
        annotations: READ,
    },
    centre_get_trends: {
        description: `${CENTRE} Counts over 7, 30 or 90 days of what the Centre collected: new official records by category and day, escalations and downgrades, significant changes, activity by region and event type, daily weather maxima, and how many days each source was collected. Not complete or official statistics, forecasts or risk scores: say so. Read-only.`,
        input: z.object({ days: z.union([z.literal(7), z.literal(30), z.literal(90)]).optional() }).strict(),
        annotations: READ,
    },
    centre_list_rules: {
        description: `${CENTRE} The person's own monitoring rules: condition, threshold with its unit (marked when it's the person's own rather than official), watch area id, lookback, cooldown, notification and matches in the last seven days. Read-only.`,
        input: z.object({}).strict(),
        annotations: READ,
    },
    centre_list_rule_matches: {
        description: `${CENTRE} Matches of the person's monitoring rules, newest first: why each matched, the value against the threshold, the evidence's own time and whether it notified. A match isn't an official warning. Read-only.`,
        input: z.object({ ruleId: centreRuleId.optional(), openOnly: z.boolean().optional(), limit: limit(200) }).strict(),
        annotations: READ,
    },
    centre_generate_report: {
        description: `${CENTRE} Builds a deterministic situation report (not saved) for NSW, a watch area, a region, an incident or a hazard: overview, official warnings, incidents, significant changes, fire danger, observations, flood and water, transport and infrastructure, possible relationships, information gaps and sources, each fact with its nature, time and link. A past moment is reported as the Centre knew it then. Never runs a model. Read-only.`,
        input: z.object({ scope: centreReportScope, at: instant.optional(), periodHours: z.number().int().min(1).max(744).optional() }).strict(),
        annotations: READ,
    },
    centre_list_reports: {
        description: `${CENTRE} The person's saved situation reports (newest first) and their report schedules. Read-only.`,
        input: z.object({ limit: limit(100) }).strict(),
        annotations: READ,
    },
    centre_get_report: {
        description: `${CENTRE} One saved situation report in full, with any narrative labelled as AI interpretation, not facts. Read-only.`,
        input: z.object({ reportId: centreReportId }).strict(),
        annotations: READ,
    },
    centre_list_correlations: {
        description: `${CENTRE} Cross-source relationships with their evidence: "explicit" when an authoritative source links the records itself, otherwise "derived" by a deterministic rule (may be related; not official; proximity isn't cause), each with factors, confidence and limitations. Read-only.`,
        input: z
            .object({
                recordId: centreRecordId.optional(),
                region: centreRegion.optional(),
                basis: z.enum(["explicit", "derived"]).optional(),
                limit: limit(100),
            })
            .strict(),
        annotations: READ,
    },
    centre_get_source_reliability: {
        description: `${CENTRE} Source reliability from the Centre's daily records: availability, retrieval time, publication-to-collection delay, consecutive failures, longest gap and last validation, per source (and per day for one source). Read-only.`,
        input: z
            .object({
                sourceId: z
                    .string()
                    .regex(/^[a-z0-9-]{3,40}$/)
                    .optional(),
                days: z.number().int().min(1).max(400).optional(),
            })
            .strict(),
        annotations: READ,
    },
    centre_list_wallboards: {
        description: `${CENTRE} The person's wallboard profiles: views and their widgets, theme, rotation and how many screens are active. Display addresses are never returned. Read-only.`,
        input: z.object({}).strict(),
        annotations: READ,
    },
    centre_create_rule: {
        description: `${CENTRE} WRITE: create one monitoring rule the person asked for, over one of their watch areas (never coordinates). Use the units stated in the schema; a gust can be km/h or knots. Their thresholds aren't official ones. Confirm with the person first. Send a fresh requestId.`,
        input: z
            .object({
                name: z.string().trim().min(1).max(80),
                definition: centreRuleDefinition,
                lookbackMinutes: z.number().int().min(15).max(10080).optional(),
                cooldownMinutes: z.number().int().min(0).max(10080).optional(),
                notify: z.enum(["none", "in_app", "email"]).optional(),
                enabled: z.boolean().optional(),
                requestId,
            })
            .strict(),
        annotations: WRITE,
    },
    centre_update_rule: {
        description: `${CENTRE} WRITE: change one of the person's monitoring rules (only the fields given change; pause it with enabled: false). Pass the version you read. Rules can't be deleted through this connector.`,
        input: z
            .object({
                ruleId: centreRuleId,
                version,
                name: z.string().trim().min(1).max(80).optional(),
                definition: centreRuleDefinition.optional(),
                lookbackMinutes: z.number().int().min(15).max(10080).optional(),
                cooldownMinutes: z.number().int().min(0).max(10080).optional(),
                notify: z.enum(["none", "in_app", "email"]).optional(),
                enabled: z.boolean().optional(),
                requestId,
            })
            .strict(),
        annotations: WRITE,
    },
    centre_schedule_report: {
        description: `${CENTRE} WRITE: schedule a daily or weekly situation report for NSW, a watch area, a region or a hazard (weekday 0 Sunday … 6 Saturday; hour in the time zone, default Australia/Sydney). Runs only when the owner has switched scheduled reports on, and skips a report whose facts haven't changed. Confirm first. Send a fresh requestId.`,
        input: z
            .object({
                name: z.string().trim().min(1).max(80),
                scope: centreReportScope,
                frequency: z.enum(["daily", "weekly"]),
                weekday: z.number().int().min(0).max(6).nullable().optional(),
                hour: z.number().int().min(0).max(23),
                timeZone: z.string().max(60).optional(),
                periodHours: z.number().int().min(1).max(744).optional(),
                notify: z.enum(["none", "in_app", "email"]).optional(),
                requestId,
            })
            .strict(),
        annotations: WRITE,
    },
    centre_save_report: {
        description: `${CENTRE} WRITE: build a deterministic situation report and save it to the person's reports (it can then be opened or printed in the portal). Never runs a model. Send a fresh requestId.`,
        input: z
            .object({
                scope: centreReportScope,
                at: instant.optional(),
                periodHours: z.number().int().min(1).max(744).optional(),
                title: z.string().trim().min(1).max(160).optional(),
                requestId,
            })
            .strict(),
        annotations: WRITE,
    },

    /* ---------------------------- Home & Assets ----------------------------- */
    assets_search: {
        description: `${ASSETS} Search assets (name, maker, model, serial number, registration, tags, place), maintenance records, document names and places. Read-only.`,
        input: z.object({ query: z.string().trim().min(2).max(100), limit: limit(50) }).strict(),
        annotations: READ,
    },
    assets_list: {
        description: `${ASSETS} List assets, optionally by category, group, place, status ("current" by default, "gone" for sold or disposed), warranty state or maintenance state. Read-only.`,
        input: z
            .object({
                category: assetCategory.optional(),
                group: z.enum(["vehicles", "home", "equipment", "personal", "other"]).optional(),
                locationId: placeId.optional(),
                status: z.enum(["current", "gone", "active", "in_storage", "in_repair", "lent", "lost", "stolen", "sold", "disposed", "gifted"]).optional(),
                warranty: z.enum(["active", "expiring", "expired", "unknown", "none"]).optional(),
                maintenance: z.enum(["overdue", "due_soon", "none"]).optional(),
                limit: limit(200),
            })
            .strict(),
        annotations: READ,
    },
    assets_get: {
        description: `${ASSETS} One asset in full: identifiers, vehicle details, warranties (with whether each end date was stated or calculated), linked policies (if insurance is shared), schedules with next due dates from their configured intervals, open maintenance and document names. Read-only.`,
        input: z.object({ assetId }).strict(),
        annotations: READ,
    },
    assets_maintenance_history: {
        description: `${ASSETS} Completed and cancelled maintenance, newest first, for one asset or place or for everything the person can see. Costs only where shared. Read-only.`,
        input: z.object({ assetId: assetId.optional(), locationId: placeId.optional(), limit: limit(200) }).strict(),
        annotations: READ,
    },
    assets_upcoming_maintenance: {
        description: `${ASSETS} Maintenance overdue or due within the days given (default 30), from each schedule's configured interval (by date, distance or whichever comes first) and open records. Read-only.`,
        input: z.object({ days: horizon(30) }).strict(),
        annotations: READ,
    },
    assets_insurance_renewals: {
        description: `${ASSETS} Active policies renewing within the days given (default 60), or overdue for renewal. Read-only.`,
        input: z.object({ days: horizon(60) }).strict(),
        annotations: READ,
    },
    assets_warranty_expiries: {
        description: `${ASSETS} Warranties ending within the days given (default 90). A manufacturer's warranty ending doesn't end Australian Consumer Law guarantees: say so if it matters. Read-only.`,
        input: z.object({ days: horizon(90) }).strict(),
        annotations: READ,
    },
    assets_list_documents: {
        description: `${ASSETS} The names, kinds and dates of one asset's photos and documents (only those shared with the person). File contents aren't available through this connector; they open in the portal. Read-only.`,
        input: z.object({ assetId }).strict(),
        annotations: READ,
    },
    assets_summary: {
        description: `${ASSETS} The household asset summary: counts by category, the sum of recorded current values with how many assets have none (never counted as zero), overdue maintenance and assets without proof of purchase. Read-only.`,
        input: z.object({ includeLowValue: z.boolean().optional() }).strict(),
        annotations: READ,
    },
    assets_get_attention: {
        description: `${ASSETS} Everything overdue or due within the days given (default 30): servicing, registration, roadside assistance, inspections, insurance renewals, warranties ending, lease ends and urgent repairs, each as a sentence from the record with a link. Summarise it; never add to it. Read-only.`,
        input: z.object({ days: horizon(30) }).strict(),
        annotations: READ,
    },
    assets_create: {
        description: `${ASSETS} WRITE: add an asset. Only a name and a category are needed: add other details only if the person gave them, never guessed ones (no invented serial numbers, VINs, registration numbers, prices or values). It's private to the person until they share it in the portal. Send a fresh requestId.`,
        input: z.object({ name: z.string().trim().min(1).max(200), category: assetCategory, ...assetFields, requestId }).strict(),
        annotations: WRITE,
    },
    assets_update: {
        description: `${ASSETS} WRITE: change an asset's details the person asked to change (needs edit rights; values need the financial right). Pass the version you read: if someone changed it since, you get a conflict instead of overwriting their change.`,
        input: z
            .object({ assetId, version, name: z.string().trim().min(1).max(200).optional(), category: assetCategory.optional(), ...assetFields, requestId })
            .strict(),
        annotations: WRITE,
    },
    assets_create_maintenance: {
        description: `${ASSETS} WRITE: record maintenance for an asset or a place: work to do (with a due date or distance), or work already done (with completedOn). Never assume a landlord approved a change to a rental. Send a fresh requestId.`,
        input: z
            .object({
                assetId: assetId.optional(),
                locationId: placeId.optional(),
                title: z.string().trim().min(1).max(200),
                kind: z.enum(["preventive", "corrective", "repair", "inspection", "service", "replacement", "seasonal", "safety"]).optional(),
                category: z.enum(["service", "inspection", "safety", "cleaning", "replacement", "seasonal", "registration", "repair", "other"]).optional(),
                priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
                dueOn: date.nullable().optional(),
                dueKm: z.number().int().min(0).nullable().optional(),
                completedOn: date.nullable().optional(),
                odometer: z.number().int().min(0).nullable().optional(),
                costCents: cents.nullable().optional(),
                provider: z.string().trim().max(200).nullable().optional(),
                notes: z.string().trim().max(8000).nullable().optional(),
                requestId,
            })
            .strict(),
        annotations: WRITE,
    },
    assets_complete_maintenance: {
        description: `${ASSETS} WRITE: mark a maintenance record done, only when the person says it was done. Its schedule moves on from the completion date (and odometer, if given), and the next record is created if the schedule says so. Completing twice changes nothing.`,
        input: z
            .object({
                maintenanceId: maintenanceRecordId,
                completedOn: date,
                odometer: z.number().int().min(0).nullable().optional(),
                costCents: cents.nullable().optional(),
                provider: z.string().trim().max(200).nullable().optional(),
                notes: z.string().trim().max(8000).nullable().optional(),
                requestId,
            })
            .strict(),
        annotations: IDEMPOTENT_WRITE,
    },

    /* ----------------------------- Chief of Staff --------------------------- */
    chief_of_staff_daily_context: {
        description: `${SOURCE} Read a bounded daily briefing from Daly Calendar and Home & Assets: the next week's events, overlapping commitments, important dates, leave, school holidays and failing subscriptions, and what's overdue or due in 30 days for the person's assets. Facts only, each with its id and link; "notChecked" names sources it never looks at (email). Use this first for a daily briefing.`,
        input: z.object({}).strict(),
        annotations: READ,
    },
    chief_of_staff_weekly_context: {
        description: `${SOURCE} Read the facts for a weekly review from Daly Calendar: the next 14 days' events, overlapping commitments, important dates, leave and school holidays. Facts only; you propose any follow-ups, and must label them as proposals.`,
        input: z.object({ weekEnding: date.optional() }).strict(),
        annotations: READ,
    },
    /* ----------------------------- Daly Intelligence ------------------------ */
    intelligence_get_daily_briefing: {
        description: `${SOURCE} The person's Daily Intelligence briefing as the portal builds it: facts from Daly Calendar and their leave in the sections the person chose, plus AI recommendations only if the portal already prepared them, labelled as suggestions. "notChecked" lists what was never read (email, finances): never imply otherwise. Reading never runs a model.`,
        input: z.object({}).strict(),
        annotations: READ,
    },
    intelligence_get_weekly_review: {
        description: `${SOURCE} The person's weekly review for the seven days ending weekEnding (default today): the week's events, overlapping commitments, important dates, leave and school holidays. Facts with links; recommendations only if already prepared, labelled as suggestions.`,
        input: z.object({ weekEnding: date.optional() }).strict(),
        annotations: READ,
    },

    /* ------------------------------- Amplenote ------------------------------- */
    amplenote_list_notes: {
        description: `${AMPLENOTE} List the person's Amplenote notes by title and tags, newest change first: each note's id, name, tags, created and updated times and link. Amplenote's API never returns what's in a note, so you can't read, summarise or search note content: say so if asked. query matches words in titles and tags; tag matches a tag and the tags under it. Read-only.`,
        input: z
            .object({
                query: z.string().trim().max(200).optional(),
                tag: amplenoteTag.optional(),
                changedSince: date.optional().describe("Only notes changed on or after this date (the person's time zone)."),
                limit: limit(100),
            })
            .strict(),
        annotations: EXTERNAL_READ,
    },
    amplenote_create_note: {
        description: `${AMPLENOTE} WRITE: create a new, empty Amplenote note with a name and optional tags. Add its text with amplenote_append. Check amplenote_list_notes first so you don't create a second note with the same name.`,
        input: z.object({ name: z.string().trim().min(1).max(300), tags: z.array(amplenoteTag).max(10).optional(), requestId }).strict(),
        annotations: EXTERNAL_WRITE,
    },
    amplenote_append: {
        description: `${AMPLENOTE} WRITE: add plain text to an existing Amplenote note, one paragraph per line. Nothing in the note is changed or removed; Amplenote decides where in the note the text goes. Find the note's id with amplenote_list_notes, and ask if more than one note could be meant.`,
        input: z.object({ noteUuid: amplenoteNoteId, text: z.string().max(10_000), requestId }).strict(),
        annotations: EXTERNAL_WRITE,
    },
    amplenote_create_task: {
        description: `${AMPLENOTE} WRITE: add one task to an existing Amplenote note (find it with amplenote_list_notes; ask which note if unsure). Amplenote's API can only add tasks: it can't list, change, reschedule or complete them. dueDate, dueTime, important, urgent and reminderAt are refused with error.details.unsupported when Amplenote isn't confirmed to store them, and then no task is created: tell the person and don't retry without them unless they agree. Never leave a property off silently.`,
        input: z
            .object({
                noteUuid: amplenoteNoteId,
                text: z.string().trim().min(1).max(500),
                dueDate: date.nullable().optional(),
                dueTime: clock.nullable().optional(),
                important: z.boolean().optional(),
                urgent: z.boolean().optional(),
                reminderAt: instant.nullable().optional(),
                requestId,
            })
            .strict(),
        annotations: EXTERNAL_WRITE,
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
