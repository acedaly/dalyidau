// Daly Calendar and Leave tools for the MCP gateway (docs/CALENDAR.md, docs/MCP.md).
//
// They call the same functions as the portal's Calendar API, as the person the Access token proves.
// Dates, balances and opportunities are worked out deterministically by the leave engine: an AI
// client can explain them but never supplies them. What the tools never do:
//   * show the details of a private or sensitive event, or of a free/busy calendar ("Busy" only;
//     sensitive events are "Private event" even to their creator, to keep children's and care
//     details out of AI conversations);
//   * return a subscription's address (it's a credential) or a feed's token;
//   * delete anything, or mark leave requested, approved or taken. Leave written here is a draft or
//     a proposal; the person changes its status in the portal.
import { z } from "zod";
import { schoolHolidaysBetween } from "../../src/shared/calendar/holidays";
import { COVERED_YEARS } from "../../src/shared/calendar/nsw";
import { addDays, daysBetween } from "../../src/shared/calendar/time";
import { CATEGORY_LABELS, type EventOccurrence, LEAVE_STATUSES } from "../../src/shared/calendar/types";
import { ensureDefaultCalendar, preferences, todayFor } from "../calendar/access";
import { listCalendars } from "../calendar/calendars";
import { createEvent, eventDetail, occurrencesInWindow, searchEvents, updateEvent } from "../calendar/events";
import { overlaysFor } from "../calendar/holidays";
import { createBooking, loadLeave, summarise, updateBooking } from "../calendar/leave";
import { answer } from "../calendar/planner";
import { createSubscription, listSubscriptions, requestRefresh } from "../calendar/subscriptions";
import { HttpError } from "../portal/http";
import type { WriteOutcome } from "./ledger";
import { type ToolContext, type ToolDef, calendarDate, id, limit, portalUrl, requestId, tool } from "./shared";

const calendarId = id("cal", "calendar");
const eventId = id("cev", "event");
const subscriptionId = id("csb", "subscription");
const leaveTypeId = id("lvt", "leave type");
const bookingId = id("lvb", "leave booking");
const scenarioId = id("lvs", "scenario");
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a 24-hour time like 09:30");

/** One occurrence as an AI client sees it. Sensitive events are never described, even to their creator. */
const occurrenceOut = (ctx: ToolContext, o: EventOccurrence) => {
    const masked = o.busyOnly || o.visibility === "sensitive";
    return {
        eventId: o.eventId,
        occurrenceKey: o.key,
        calendarId: o.calendarId,
        title: o.busyOnly ? "Busy" : o.visibility === "sensitive" ? "Private event" : o.title,
        allDay: o.allDay,
        startDate: o.startDate,
        endDate: o.endDate,
        startTime: o.startTime,
        endTime: o.endTime,
        ...(o.eventTimeZone ? { eventTimeZone: o.eventTimeZone } : {}),
        location: masked ? null : o.location,
        category: masked ? null : CATEGORY_LABELS[o.category],
        status: o.status,
        showAs: o.showAs,
        recurring: o.recurring,
        readOnly: o.readOnly,
        source: o.source,
        detailsWithheld: masked,
        url: masked ? null : portalUrl(ctx, `/portal/calendar?date=${o.startDate}&event=${o.eventId}`),
    };
};

const windowInput = (maxDays: number) =>
    z
        .object({ from: calendarDate, to: calendarDate })
        .refine((w) => w.to >= w.from, { message: "to must be on or after from", path: ["to"] })
        .refine((w) => daysBetween(w.from, w.to) <= maxDays, { message: `At most ${maxDays} days at a time`, path: ["to"] });

/** Pairs of overlapping busy, timed occurrences (in the same person's view). */
function conflicts(items: EventOccurrence[]) {
    const timed = items.filter((o) => !o.allDay && o.showAs === "busy" && o.status !== "cancelled").sort((a, b) => a.start.localeCompare(b.start));
    const out: [EventOccurrence, EventOccurrence][] = [];
    for (let i = 0; i < timed.length; i++)
        for (let j = i + 1; j < timed.length && timed[j].start < timed[i].end; j++) if (timed[j].eventId !== timed[i].eventId) out.push([timed[i], timed[j]]);
    return out;
}

// --- Reads ---------------------------------------------------------------------------------------

const listCalendarsTool = tool({
    name: "calendar_list_calendars",
    write: false,
    permission: "calendar.use",
    input: z.object({}).strict(),
    run: async (ctx) => {
        const calendars = await listCalendars(ctx.db, ctx.user);
        const prefs = await preferences(ctx.db, ctx.user.email);
        return {
            data: {
                timeZone: prefs.timeZone,
                calendars: calendars.map((c) => ({
                    id: c.id,
                    name: c.name,
                    kind: c.kind,
                    purpose: c.purpose,
                    source: c.source,
                    yourRole: c.role,
                    canAddEvents: c.source === "local" && (c.role === "owner" || c.role === "editor"),
                    isDefault: c.isDefault,
                    hidden: c.hidden,
                })),
            },
        };
    },
});

const listEventsTool = tool({
    name: "calendar_list_events",
    write: false,
    permission: "calendar.use",
    input: z
        .object({ from: calendarDate, to: calendarDate, calendarIds: z.array(calendarId).max(20).optional(), limit: limit(100, 300) })
        .strict()
        .superRefine((v, c) => {
            if (v.to < v.from) c.addIssue({ code: "custom", message: "to must be on or after from", path: ["to"] });
            if (daysBetween(v.from, v.to) > 92) c.addIssue({ code: "custom", message: "At most 92 days at a time", path: ["to"] });
        }),
    run: async (ctx, input) => {
        const prefs = await preferences(ctx.db, ctx.user.email);
        const { occurrences, truncated } = await occurrencesInWindow(ctx.db, ctx.user, {
            from: input.from,
            to: input.to,
            timeZone: prefs.timeZone,
            calendarIds: input.calendarIds ?? null,
        });
        return {
            data: {
                timeZone: prefs.timeZone,
                count: occurrences.length,
                truncated: truncated || occurrences.length > input.limit,
                events: occurrences.slice(0, input.limit).map((o) => occurrenceOut(ctx, o)),
            },
        };
    },
});

const searchEventsTool = tool({
    name: "calendar_search_events",
    write: false,
    permission: "calendar.use",
    input: z.object({ query: z.string().trim().min(1).max(200), limit: limit(20, 50) }).strict(),
    run: async (ctx, input) => {
        const prefs = await preferences(ctx.db, ctx.user.email);
        const found = await searchEvents(ctx.db, ctx.user, input.query, prefs.timeZone, await todayFor(ctx.db, ctx.user.email), input.limit);
        // Sensitive events never match an AI search by their text.
        const shown = found.filter((o) => o.visibility !== "sensitive");
        return {
            data: {
                count: shown.length,
                events: shown.map((o) => occurrenceOut(ctx, o)),
                note: "Each result is shown at its next occurrence (or its last, if it's over).",
            },
        };
    },
});

const agendaTool = tool({
    name: "calendar_get_agenda",
    write: false,
    permission: "calendar.use",
    input: z.object({ date: calendarDate.optional(), days: z.number().int().min(1).max(31).default(7) }).strict(),
    run: async (ctx, input) => {
        const prefs = await preferences(ctx.db, ctx.user.email);
        const today = await todayFor(ctx.db, ctx.user.email);
        const from = input.date ?? today;
        const to = addDays(from, input.days - 1);
        const leave = await loadLeave(ctx.db, ctx.user);
        const [{ occurrences, truncated }, overlays] = await Promise.all([
            occurrencesInWindow(ctx.db, ctx.user, { from, to, timeZone: prefs.timeZone }),
            overlaysFor(ctx.db, ctx.user, prefs, leave, from, to, today),
        ]);
        const days = [];
        for (let d = from; d <= to; d = addDays(d, 1)) {
            days.push({
                date: d,
                events: occurrences.filter((o) => o.startDate <= d && o.endDate >= d).map((o) => occurrenceOut(ctx, o)),
                publicHolidays: overlays.holidays.filter((h) => h.date === d).map((h) => ({ name: h.name, kind: h.kind, provisional: h.provisional })),
                school: overlays.school.filter((s) => s.start <= d && s.end >= d && s.kind !== "term").map((s) => s.name),
                leave: overlays.leave
                    .filter((l) => l.start <= d && l.end >= d)
                    .map((l) => ({ type: l.typeName, status: l.status, person: l.owner?.name ?? l.owner?.email ?? "you" })),
                tasksDue: overlays.tasks
                    .filter((t) => t.date === d)
                    .map((t) => ({ id: t.id, title: t.title, kind: t.kind, project: t.projectName, url: portalUrl(ctx, `/portal/tasks/t/${t.id}`) })),
            });
        }
        return {
            data: {
                timeZone: prefs.timeZone,
                from,
                to,
                truncated,
                days,
                conflicts: conflicts(occurrences).map(([a, b]) => ({ first: occurrenceOut(ctx, a), second: occurrenceOut(ctx, b) })),
            },
        };
    },
});

const conflictsTool = tool({
    name: "calendar_find_conflicts",
    write: false,
    permission: "calendar.use",
    input: windowInput(62),
    run: async (ctx, input) => {
        const prefs = await preferences(ctx.db, ctx.user.email);
        const { occurrences } = await occurrencesInWindow(ctx.db, ctx.user, { from: input.from, to: input.to, timeZone: prefs.timeZone });
        const pairs = conflicts(occurrences);
        return {
            data: {
                count: pairs.length,
                conflicts: pairs.slice(0, 50).map(([a, b]) => ({ first: occurrenceOut(ctx, a), second: occurrenceOut(ctx, b) })),
                note: "Timed events marked busy that overlap. All-day events and events marked free aren't counted.",
            },
        };
    },
});

const subscriptionsTool = tool({
    name: "calendar_list_subscriptions",
    write: false,
    permission: "calendar.use",
    input: z.object({ failingOnly: z.boolean().default(false) }).strict(),
    run: async (ctx, input) => {
        const subs = await listSubscriptions(ctx.db, ctx.user);
        return {
            data: {
                subscriptions: subs
                    .filter((s) => !input.failingOnly || s.consecutiveFailures > 0 || s.lastStatus === "error")
                    .map((s) => ({
                        id: s.id,
                        name: s.name,
                        host: s.urlDisplay,
                        provider: s.provider,
                        enabled: s.enabled,
                        lastSuccessAt: s.lastSuccessAt,
                        lastAttemptAt: s.lastAttemptAt,
                        status: s.lastStatus,
                        failing: s.consecutiveFailures > 0,
                        consecutiveFailures: s.consecutiveFailures,
                        error: s.lastError,
                        eventCount: s.eventCount,
                        nextRefreshAt: s.nextRefreshAt,
                        canManage: s.canManage,
                    })),
                url: portalUrl(ctx, "/portal/calendar/subscriptions"),
            },
        };
    },
});

const balancesTool = tool({
    name: "leave_get_balances",
    write: false,
    permission: "calendar.use",
    input: z.object({ asOf: calendarDate.optional(), mode: z.enum(["confirmed", "planned"]).default("planned"), scenarioId: scenarioId.optional() }).strict(),
    run: async (ctx, input) => {
        const leave = await loadLeave(ctx.db, ctx.user);
        const today = await todayFor(ctx.db, ctx.user.email);
        const asOf = input.asOf ?? today;
        return {
            data: {
                configured: leave.profile.configured,
                today,
                asOf,
                mode: input.mode,
                note: "Estimates from the person's own balances, work pattern and accrual settings, worked out day by day. Not their employer's records.",
                balances: summarise(leave, today, asOf, input.mode, input.scenarioId ?? null).map((s) => ({
                    leaveTypeId: s.type.id,
                    name: s.type.name,
                    kind: s.type.kind,
                    tracksBalance: s.type.tracksBalance,
                    enteredBalance: { hours: s.type.balanceHours, asAt: s.type.balanceDate },
                    todayConfirmedHours: s.today.confirmed,
                    todayPlannedHours: s.today.planned,
                    atDate: {
                        hours: s.asOf.closing,
                        accrued: s.asOf.accrued,
                        taken: s.asOf.taken,
                        adjustments: s.asOf.adjustments,
                        forfeited: s.asOf.forfeited,
                        lowest: s.asOf.lowest,
                        goesNegativeOn: s.asOf.negativeFrom,
                    },
                })),
                url: portalUrl(ctx, "/portal/calendar/leave"),
            },
        };
    },
});

const bookingsTool = tool({
    name: "leave_list_bookings",
    write: false,
    permission: "calendar.use",
    input: z
        .object({
            from: calendarDate.optional(),
            to: calendarDate.optional(),
            status: z.enum(LEAVE_STATUSES).optional(),
            includeScenarios: z.boolean().default(false),
        })
        .strict(),
    run: async (ctx, input) => {
        const leave = await loadLeave(ctx.db, ctx.user);
        const types = new Map(leave.types.map((t) => [t.id, t.name]));
        const scenarios = new Map(leave.scenarios.map((s) => [s.id, s.name]));
        const list = leave.bookings.filter(
            (b) =>
                (input.includeScenarios || !b.scenarioId) &&
                (!input.status || b.status === input.status) &&
                (!input.from || b.endDate >= input.from) &&
                (!input.to || b.startDate <= input.to),
        );
        return {
            data: {
                count: list.length,
                bookings: list.slice(0, 200).map((b) => ({
                    id: b.id,
                    leaveTypeId: b.leaveTypeId,
                    leaveType: types.get(b.leaveTypeId) ?? null,
                    startDate: b.startDate,
                    endDate: b.endDate,
                    part: b.part,
                    hours: b.hours,
                    status: b.status,
                    title: b.title,
                    scenario: b.scenarioId ? (scenarios.get(b.scenarioId) ?? "Scenario") : null,
                    version: b.version,
                })),
                note: "Statuses are the person's own record. Only they mark leave requested, approved or taken.",
                url: portalUrl(ctx, "/portal/calendar/leave?tab=bookings"),
            },
        };
    },
});

const forecastTool = tool({
    name: "leave_forecast",
    write: false,
    permission: "calendar.use",
    input: z
        .object({
            date: calendarDate,
            leaveTypeId: leaveTypeId.optional(),
            mode: z.enum(["confirmed", "planned", "all"]).default("planned"),
            scenarioId: scenarioId.optional(),
        })
        .strict(),
    run: async (ctx, input) => {
        const leave = await loadLeave(ctx.db, ctx.user);
        const today = await todayFor(ctx.db, ctx.user.email);
        const all = summarise(leave, today, input.date, input.mode, input.scenarioId ?? null).filter(
            (s) => !input.leaveTypeId || s.type.id === input.leaveTypeId,
        );
        if (input.leaveTypeId && !all.length) throw new HttpError(404, "not_found", "Not found");
        const [first, last] = COVERED_YEARS.publicHolidays;
        const year = Number(input.date.slice(0, 4));
        return {
            data: {
                date: input.date,
                mode: input.mode,
                forecasts: all.map((s) => ({ leaveTypeId: s.type.id, name: s.type.name, breakdown: s.asOf })),
                ...(year > last || year < first ? { coverage: `NSW public holidays are only included for ${first}–${last}.` } : {}),
                note: "Deterministic projection from the person's settings. Explain it; don't change the numbers.",
            },
        };
    },
});

const opportunitiesTool = tool({
    name: "leave_find_opportunities",
    write: false,
    permission: "calendar.use",
    // One flat object (MCP clients need an object schema); the planner validates each question's own fields.
    input: z
        .object({
            question: z.enum(["longest_break", "public_holidays", "school_holidays", "cover_period", "joint"]),
            budgetHours: z.number().min(0).max(2000).optional(),
            theirBudgetHours: z.number().min(0).max(2000).optional(),
            from: calendarDate.optional(),
            to: calendarDate.optional(),
            start: calendarDate.optional(),
            end: calendarDate.optional(),
            leaveTypeId: leaveTypeId.optional(),
            with: z.string().trim().toLowerCase().email().optional(),
        })
        .strict(),
    run: async (ctx, input) => {
        const { question, budgetHours, theirBudgetHours, from, to, start, end, leaveTypeId: type, with: partner } = input;
        const keep = <T extends Record<string, unknown>>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
        const asked =
            question === "longest_break"
                ? keep({ question, budgetHours: budgetHours ?? 0, from, to, leaveTypeId: type })
                : question === "public_holidays"
                  ? keep({ question, budgetHours, from, to, leaveTypeId: type })
                  : question === "school_holidays"
                    ? keep({ question, from, to, leaveTypeId: type })
                    : question === "cover_period"
                      ? keep({ question, start, end, leaveTypeId: type })
                      : keep({ question, with: partner, budgetHours: budgetHours ?? 0, theirBudgetHours, from, to });
        return { data: { answer: await answer(ctx.db, ctx.user, asked), url: portalUrl(ctx, "/portal/calendar/leave/planner") } };
    },
});

const schoolHolidaysTool = tool({
    name: "calendar_school_holidays",
    write: false,
    permission: "calendar.use",
    input: z.object({ from: calendarDate.optional(), to: calendarDate.optional(), division: z.enum(["eastern", "western"]).optional() }).strict(),
    run: async (ctx, input) => {
        const prefs = await preferences(ctx.db, ctx.user.email);
        const today = await todayFor(ctx.db, ctx.user.email);
        const division = input.division ?? (prefs.schoolDivision === "none" ? "eastern" : prefs.schoolDivision);
        const from = input.from ?? today;
        const to = input.to ?? addDays(from, 365);
        const plans = await answer(ctx.db, ctx.user, { question: "school_holidays", from, to });
        const periods = schoolHolidaysBetween(from, to, division);
        return {
            data: {
                division,
                source: "NSW Department of Education term dates (official, with verification dates in the portal)",
                periods: periods.map((p) => {
                    const plan = "periods" in plans ? plans.periods.find((x) => x.id === p.id) : undefined;
                    return {
                        id: p.id,
                        name: p.name,
                        start: p.start,
                        end: p.end,
                        provisional: !!p.provisional,
                        leavePlanned: plan?.leavePlanned ?? null,
                        leaveHoursToCover: plan?.toCoverAll?.leaveHours ?? null,
                    };
                }),
                url: portalUrl(ctx, "/portal/calendar/holidays"),
            },
        };
    },
});

// --- Writes --------------------------------------------------------------------------------------

const outcome = (entityType: WriteOutcome["entityType"], entityId: string): WriteOutcome => ({ entityType, entityId });

const eventFields = {
    title: z.string().trim().min(1).max(300),
    allDay: z.boolean().default(false),
    startDate: calendarDate,
    startTime: time.optional(),
    endDate: calendarDate.optional(),
    endTime: time.optional(),
    timeZone: z.string().max(64).optional(),
    location: z.string().trim().max(500).optional(),
    description: z.string().trim().max(8000).optional(),
    category: z.enum(["general", "appointment", "family", "birthday", "anniversary", "school", "travel", "commitment", "work", "other"]).optional(),
    visibility: z.enum(["default", "private"]).optional(),
    repeat: z
        .object({
            freq: z.enum(["daily", "weekly", "monthly", "yearly"]),
            interval: z.number().int().min(1).max(99).optional(),
            until: calendarDate.optional(),
            count: z.number().int().min(1).max(500).optional(),
        })
        .strict()
        .optional(),
    reminderMinutes: z.array(z.number().int().min(0).max(40320)).max(3).optional(),
};

const eventDetailOut = (ctx: ToolContext, e: Awaited<ReturnType<typeof createEvent>>["event"]) => ({
    id: e.id,
    calendarId: e.calendarId,
    title: e.title,
    allDay: e.allDay,
    startDate: e.startDate,
    startTime: e.startTime,
    endDate: e.endDate,
    endTime: e.endTime,
    timeZone: e.timeZone,
    repeat: e.repeatLabel,
    version: e.version,
    url: portalUrl(ctx, `/portal/calendar?date=${e.startDate}&event=${e.id}`),
});

const createEventTool = tool({
    name: "calendar_create_event",
    write: true,
    permission: "calendar.use",
    input: z.object({ calendarId: calendarId.optional(), ...eventFields, requestId }).strict(),
    run: async (ctx, input) => {
        const { reminderMinutes, requestId: rid, endDate, endTime, ...fields } = input;
        const defaultCalendarId = await ensureDefaultCalendar(ctx.db, ctx.user);
        const { event } = await createEvent(
            ctx.db,
            ctx.user,
            {
                ...fields,
                endDate: endDate ?? fields.startDate,
                ...(fields.allDay ? {} : { startTime: fields.startTime ?? "09:00", endTime: endTime ?? fields.startTime ?? "10:00" }),
                ...(reminderMinutes ? { reminders: reminderMinutes } : {}),
                ...(rid ? { clientId: rid } : {}),
            },
            { via: "mcp", defaultCalendarId },
        );
        return { data: { created: true, event: eventDetailOut(ctx, event) }, outcome: outcome("calendar_event", event.id) };
    },
    replay: async (ctx, o) => ({ data: { created: true, replayed: true, event: eventDetailOut(ctx, await eventDetail(ctx.db, ctx.user, o.entityId)) } }),
});

const updateEventTool = tool({
    name: "calendar_update_event",
    write: true,
    permission: "calendar.use",
    input: z
        .object({
            eventId,
            version: z.number().int().min(1),
            scope: z.enum(["series", "occurrence", "following"]).default("series"),
            occurrenceKey: z.string().max(16).optional(),
            title: eventFields.title.optional(),
            allDay: z.boolean().optional(),
            startDate: calendarDate.optional(),
            startTime: time.optional(),
            endDate: calendarDate.optional(),
            endTime: time.optional(),
            location: eventFields.location,
            description: eventFields.description,
            requestId,
        })
        .strict(),
    run: async (ctx, input) => {
        const { eventId: target, requestId: _rid, ...patch } = input;
        const event = await updateEvent(ctx.db, ctx.user, target, patch, "mcp");
        return { data: { updated: true, event: eventDetailOut(ctx, event) }, outcome: outcome("calendar_event", event.id) };
    },
});

const createSubscriptionTool = tool({
    name: "calendar_create_subscription",
    write: true,
    permission: "calendar.use",
    input: z
        .object({
            url: z.string().trim().min(8).max(2000),
            name: z.string().trim().min(1).max(100).optional(),
            shared: z.boolean().default(false),
            requestId,
        })
        .strict(),
    run: async (ctx, input) => {
        const { subscription } = await createSubscription(
            ctx.env,
            ctx.db,
            ctx.user,
            {
                url: input.url,
                ...(input.name ? { name: input.name } : {}),
                kind: input.shared ? "shared" : "personal",
                ...(input.requestId ? { clientId: input.requestId } : {}),
            },
            {},
            "mcp",
        );
        return {
            data: {
                created: true,
                subscription: {
                    id: subscription.id,
                    name: subscription.name,
                    host: subscription.urlDisplay,
                    status: subscription.lastStatus,
                    error: subscription.lastError,
                    eventCount: subscription.eventCount,
                },
                note: "The address is stored as a credential and won't be shown again.",
                url: portalUrl(ctx, "/portal/calendar/subscriptions"),
            },
            outcome: outcome("calendar_subscription", subscription.id),
        };
    },
});

const refreshSubscriptionTool = tool({
    name: "calendar_refresh_subscription",
    write: true,
    permission: "calendar.use",
    input: z.object({ subscriptionId, requestId }).strict(),
    run: async (ctx, input) => {
        const sub = await requestRefresh(ctx.env, ctx.db, ctx.user, input.subscriptionId, {}, "mcp");
        return {
            data: {
                refreshed: true,
                subscription: {
                    id: sub.id,
                    name: sub.name,
                    status: sub.lastStatus,
                    error: sub.lastError,
                    lastSuccessAt: sub.lastSuccessAt,
                    eventCount: sub.eventCount,
                },
            },
            outcome: outcome("calendar_subscription", sub.id),
        };
    },
});

/** What MCP may set: never requested, approved or taken. */
const PROPOSAL_STATUSES = ["draft", "proposed"] as const;
const MCP_UPDATABLE = ["draft", "proposed", "cancelled"] as const;

const bookingOut = (ctx: ToolContext, b: Awaited<ReturnType<typeof createBooking>>["booking"]) => ({
    id: b.id,
    leaveTypeId: b.leaveTypeId,
    startDate: b.startDate,
    endDate: b.endDate,
    part: b.part,
    status: b.status,
    scenarioId: b.scenarioId,
    version: b.version,
    url: portalUrl(ctx, "/portal/calendar/leave?tab=bookings"),
});

const createProposalTool = tool({
    name: "leave_create_proposal",
    write: true,
    permission: "calendar.use",
    input: z
        .object({
            leaveTypeId,
            startDate: calendarDate,
            endDate: calendarDate,
            part: z.enum(["full", "am", "pm", "hours"]).default("full"),
            hours: z.number().min(0).max(24).optional(),
            status: z.enum(PROPOSAL_STATUSES).default("proposed"),
            title: z.string().trim().max(120).optional(),
            scenarioId: scenarioId.optional(),
            requestId,
        })
        .strict(),
    run: async (ctx, input) => {
        const { requestId: rid, ...fields } = input;
        const { booking } = await createBooking(
            ctx.db,
            ctx.user,
            { ...fields, ...(rid ? { clientId: rid } : {}) },
            { via: "mcp", allowedStatuses: PROPOSAL_STATUSES },
        );
        const leave = await loadLeave(ctx.db, ctx.user);
        const today = await todayFor(ctx.db, ctx.user.email);
        const balance = summarise(leave, today, booking.endDate, "planned", booking.scenarioId).find((s) => s.type.id === booking.leaveTypeId);
        return {
            data: {
                created: true,
                booking: bookingOut(ctx, booking),
                projectedBalanceAfter: balance ? { hours: balance.asOf.closing, goesNegativeOn: balance.asOf.negativeFrom } : null,
                note: "Saved as the person's own plan. It is not a request to their employer and not approved.",
            },
            outcome: outcome("leave_booking", booking.id),
        };
    },
});

const updateProposalTool = tool({
    name: "leave_update_proposal",
    write: true,
    permission: "calendar.use",
    input: z
        .object({
            bookingId,
            version: z.number().int().min(1),
            startDate: calendarDate.optional(),
            endDate: calendarDate.optional(),
            part: z.enum(["full", "am", "pm", "hours"]).optional(),
            hours: z.number().min(0).max(24).optional(),
            status: z.enum(MCP_UPDATABLE).optional(),
            title: z.string().trim().max(120).optional(),
            requestId,
        })
        .strict(),
    run: async (ctx, input) => {
        const { bookingId: target, requestId: _rid, ...patch } = input;
        const booking = await updateBooking(ctx.db, ctx.user, target, patch, { via: "mcp", allowedStatuses: MCP_UPDATABLE });
        return { data: { updated: true, booking: bookingOut(ctx, booking) }, outcome: outcome("leave_booking", booking.id) };
    },
});

export const CALENDAR_TOOLS: ToolDef[] = [
    listCalendarsTool,
    listEventsTool,
    searchEventsTool,
    agendaTool,
    conflictsTool,
    subscriptionsTool,
    balancesTool,
    bookingsTool,
    forecastTool,
    opportunitiesTool,
    schoolHolidaysTool,
    createEventTool,
    updateEventTool,
    createSubscriptionTool,
    refreshSubscriptionTool,
    createProposalTool,
    updateProposalTool,
];
