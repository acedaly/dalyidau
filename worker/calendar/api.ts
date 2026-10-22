// JSON API for Daly Calendar and the Leave Planner (/api/portal/calendar/*). By the time a request
// gets here the portal router has verified the Access identity, the portal role and the same-origin
// checks (CSRF). This router adds the "calendar.use" permission; each handler then checks the
// caller's membership of the calendar it touches (worker/calendar/access.ts), and leave is always
// the caller's own.
import { z } from "zod";
import { type ForecastMode, forecastSeries } from "../../src/shared/calendar/leave";
import { NSW_PUBLIC_HOLIDAYS, NSW_SCHOOL_PERIODS, SOURCES } from "../../src/shared/calendar/nsw";
import { daysBetween, isCalendarDate } from "../../src/shared/calendar/time";
import { LIMITS, calendarPreferences } from "../../src/shared/calendar/types";
import type { PortalUser } from "../../src/shared/portal/types";
import type { Env } from "../env";
import { can } from "../portal/auth";
import { nowIso } from "../portal/db";
import { loadFlags } from "../portal/flags";
import { HttpError, json, readJson, readText } from "../portal/http";
import { activity, ensureDefaultCalendar, preferences, requireCalendar, todayFor } from "./access";
import { addMember, createCalendar, deleteCalendar, listCalendars, listMembers, removeMember, updateCalendar, updatePersonal } from "./calendars";
import {
    EventConflict,
    createEvent,
    deleteEvent,
    eventDetail,
    occurrencesInWindow,
    restoreOccurrence,
    searchEvents,
    setReminders,
    updateEvent,
} from "./events";
import { backup, exportCalendarIcs, importIcs, leaveCsv, leavePdf, leaveXlsx, restore } from "./export";
import { createFeed, listFeeds, revokeFeed, rotateFeed, updateFeed } from "./feeds";
import { createCustomDate, deleteCustomDate, listCustomDates, overlaysFor } from "./holidays";
import {
    addAdjustment,
    adoptScenario,
    contextFor,
    createBooking,
    createScenario,
    createType,
    deleteAdjustment,
    deleteBooking,
    deleteScenario,
    deleteType,
    loadLeave,
    quickSetup,
    quote,
    saveProfile,
    shareLeave,
    summarise,
    unshareLeave,
    updateBooking,
    updateType,
} from "./leave";
import { dismissNotification, listNotifications } from "./notify";
import { calendarShell } from "./pages";
import { answer } from "./planner";
import { createSubscription, deleteSubscription, listSubscriptions, requestRefresh, updateSubscription } from "./subscriptions";

interface Ctx {
    env: Env;
    request: Request;
    url: URL;
    user: PortalUser;
    params: Record<string, string>;
}

type Handler = (ctx: Ctx) => Promise<Response>;
const routes: { method: string; pattern: RegExp; keys: string[]; handler: Handler }[] = [];
const add = (method: string, path: string, handler: Handler) => {
    const keys: string[] = [];
    const pattern = new RegExp(
        `^/api/portal/calendar${path.replace(/:([a-zA-Z]+)/g, (_, key: string) => {
            keys.push(key);
            return "([^/]+)";
        })}$`,
    );
    routes.push({ method, pattern, keys, handler });
};

const site = (env: Env) => new URL(env.SITE_URL).origin;

/** A window of local dates from the query, bounded. */
function windowParams(url: URL) {
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    if (!from || !to || !isCalendarDate(from) || !isCalendarDate(to) || to < from) throw new HttpError(400, "bad_window", "Give from and to dates, from first");
    if (daysBetween(from, to) > LIMITS.windowDays) throw new HttpError(400, "bad_window", `Ask for at most ${LIMITS.windowDays} days at a time`);
    return { from, to };
}

/** Exports are private downloads: never cached, never rendered, never sniffed. */
const download = (body: BodyInit, type: string, filename: string) =>
    new Response(body, {
        headers: {
            "Content-Type": type,
            "Content-Disposition": `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
            "Cache-Control": "private, no-store",
            "Content-Security-Policy": "default-src 'none'; sandbox",
            "X-Content-Type-Options": "nosniff",
            "X-Robots-Tag": "noindex",
        },
    });

// --- Shell, preferences, notifications -----------------------------------------------------------

add("GET", "/shell", async ({ env, user }) => json(await calendarShell(env, user, await loadFlags(env.DB))));

add("GET", "/preferences", async ({ env, user }) => json({ preferences: await preferences(env.DB, user.email) }));

add("PUT", "/preferences", async ({ env, request, user }) => {
    const body = z
        .object({ preferences: calendarPreferences, version: z.number().int().min(0).optional() })
        .strict()
        .parse(await readJson(request));
    await env.DB.batch([
        env.DB.prepare(
            "INSERT INTO calendar_preferences (email, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (email) DO UPDATE SET value = excluded.value, version = version + 1, updated_at = excluded.updated_at",
        ).bind(user.email, JSON.stringify(body.preferences), nowIso()),
        activity(env.DB, { actor: user.email, action: "preferences.update", entityType: "preferences", entityId: null }),
    ]);
    return json({ preferences: await preferences(env.DB, user.email) });
});

add("GET", "/notifications", async ({ env, user }) => json({ notifications: await listNotifications(env.DB, user.email) }));
add("POST", "/notifications/:id/dismiss", async ({ env, user, params }) => {
    await dismissNotification(env.DB, user.email, params.id === "all" ? "all" : params.id);
    return json({ notifications: await listNotifications(env.DB, user.email) });
});

// --- Events --------------------------------------------------------------------------------------

add("GET", "/events", async ({ env, url, user }) => {
    const { from, to } = windowParams(url);
    const prefs = await preferences(env.DB, user.email);
    const calendars = url.searchParams.get("calendars");
    const result = await occurrencesInWindow(env.DB, user, {
        from,
        to,
        timeZone: prefs.timeZone,
        calendarIds: calendars
            ? calendars
                  .split(",")
                  .filter((c) => /^cal_[a-z0-9]{14}$/.test(c))
                  .slice(0, 50)
            : null,
    });
    const overlays = url.searchParams.get("overlays") === "0" ? null : await overlaysFor(env.DB, user, prefs, await loadLeave(env.DB, user), from, to);
    return json({ from, to, ...result, overlays });
});

add("GET", "/events/search", async ({ env, url, user }) => {
    const prefs = await preferences(env.DB, user.email);
    const today = await todayFor(env.DB, user.email);
    return json({ occurrences: await searchEvents(env.DB, user, (url.searchParams.get("q") ?? "").slice(0, 200), prefs.timeZone, today) });
});

add("POST", "/events", async ({ env, request, user }) => {
    // No calendar named: the person's own default calendar.
    const { event, replayed } = await createEvent(env.DB, user, await readJson(request), { defaultCalendarId: await ensureDefaultCalendar(env.DB, user) });
    return json({ event, replayed }, replayed ? 200 : 201);
});
add("GET", "/events/:id", async ({ env, user, params }) => json({ event: await eventDetail(env.DB, user, params.id) }));
add("PATCH", "/events/:id", async ({ env, request, user, params }) => json({ event: await updateEvent(env.DB, user, params.id, await readJson(request)) }));
add("DELETE", "/events/:id", async ({ env, url, user, params }) =>
    json(
        await deleteEvent(env.DB, user, params.id, {
            scope: url.searchParams.get("scope") ?? "series",
            ...(url.searchParams.get("key") ? { occurrenceKey: url.searchParams.get("key") } : {}),
        }),
    ),
);
add("POST", "/events/:id/restore", async ({ env, request, user, params }) => {
    const { key } = z
        .object({ key: z.string().max(16) })
        .strict()
        .parse(await readJson(request));
    return json({ event: await restoreOccurrence(env.DB, user, params.id, key) });
});
add("PUT", "/events/:id/reminders", async ({ env, request, user, params }) =>
    json({ event: await setReminders(env.DB, user, params.id, await readJson(request)) }),
);

add("GET", "/overlays", async ({ env, url, user }) => {
    const { from, to } = windowParams(url);
    return json({
        overlays: await overlaysFor(env.DB, user, await preferences(env.DB, user.email), await loadLeave(env.DB, user), from, to),
    });
});

// --- Calendars -----------------------------------------------------------------------------------

add("GET", "/calendars", async ({ env, user }) => json({ calendars: await listCalendars(env.DB, user) }));
add("POST", "/calendars", async ({ env, request, user }) => json({ calendar: await createCalendar(env.DB, user, await readJson(request)) }, 201));
add("PATCH", "/calendars/:id", async ({ env, request, user, params }) =>
    json({ calendar: await updateCalendar(env.DB, user, params.id, await readJson(request)) }),
);
add("PATCH", "/calendars/:id/me", async ({ env, request, user, params }) =>
    json({ calendar: await updatePersonal(env.DB, user, params.id, await readJson(request)) }),
);
add("DELETE", "/calendars/:id", async ({ env, user, params }) => {
    await deleteCalendar(env.DB, user, params.id);
    return json({ calendars: await listCalendars(env.DB, user) });
});
add("GET", "/calendars/:id/members", async ({ env, user, params }) => {
    await requireCalendar(env.DB, user, params.id, "viewer");
    return json({ members: (await listMembers(env.DB, [params.id]))[params.id] ?? [] });
});
add("POST", "/calendars/:id/members", async ({ env, request, user, params }) =>
    json({ members: await addMember(env, env.DB, user, params.id, await readJson(request)) }, 201),
);
add("DELETE", "/calendars/:id/members/:email", async ({ env, user, params }) => json({ members: await removeMember(env.DB, user, params.id, params.email) }));
add("GET", "/calendars/:id/export.ics", async ({ env, user, params }) => {
    const { name, body } = await exportCalendarIcs(env.DB, user, params.id);
    return download(body, "text/calendar; charset=utf-8", `${name || "calendar"}.ics`);
});
add("POST", "/calendars/:id/import", async ({ env, request, user, params }) => {
    const body = z
        .object({ ics: z.string().max(5_000_000), dryRun: z.boolean().default(true) })
        .strict()
        .parse(JSON.parse(await readText(request, 7_000_000)));
    return json({ result: await importIcs(env.DB, user, params.id, body.ics, body.dryRun) });
});

// --- Subscriptions -------------------------------------------------------------------------------

add("GET", "/subscriptions", async ({ env, user }) => json({ subscriptions: await listSubscriptions(env.DB, user) }));
add("POST", "/subscriptions", async ({ env, request, user }) => {
    const { subscription, replayed } = await createSubscription(env, env.DB, user, await readJson(request));
    return json({ subscription }, replayed ? 200 : 201);
});
add("PATCH", "/subscriptions/:id", async ({ env, request, user, params }) =>
    json({ subscription: await updateSubscription(env.DB, user, params.id, await readJson(request)) }),
);
add("DELETE", "/subscriptions/:id", async ({ env, user, params }) => {
    await deleteSubscription(env.DB, user, params.id);
    return json({ subscriptions: await listSubscriptions(env.DB, user) });
});
add("POST", "/subscriptions/:id/refresh", async ({ env, user, params }) => json({ subscription: await requestRefresh(env, env.DB, user, params.id) }));

// --- Feeds ---------------------------------------------------------------------------------------

add("GET", "/feeds", async ({ env, user }) => json({ feeds: await listFeeds(env.DB, user) }));
add("POST", "/feeds", async ({ env, request, user }) => json(await createFeed(env.DB, user, await readJson(request), site(env)), 201));
add("PATCH", "/feeds/:id", async ({ env, request, user, params }) => json({ feed: await updateFeed(env.DB, user, params.id, await readJson(request)) }));
add("POST", "/feeds/:id/rotate", async ({ env, user, params }) => json(await rotateFeed(env.DB, user, params.id, site(env))));
add("DELETE", "/feeds/:id", async ({ env, user, params }) => json({ feeds: await revokeFeed(env.DB, user, params.id) }));

// --- Holidays and custom dates -------------------------------------------------------------------

add("GET", "/holidays", async ({ env, user }) =>
    json({ publicHolidays: NSW_PUBLIC_HOLIDAYS, school: NSW_SCHOOL_PERIODS, sources: SOURCES, customDates: await listCustomDates(env.DB, user) }),
);
add("POST", "/custom-dates", async ({ env, request, user }) => json({ customDates: await createCustomDate(env.DB, user, await readJson(request)) }, 201));
add("DELETE", "/custom-dates/:id", async ({ env, user, params }) => json({ customDates: await deleteCustomDate(env.DB, user, params.id) }));

// --- Leave ---------------------------------------------------------------------------------------

add("GET", "/leave", async ({ env, user }) => json({ leave: await loadLeave(env.DB, user) }));
add("PUT", "/leave/profile", async ({ env, request, user }) => json({ leave: await saveProfile(env.DB, user, await readJson(request)) }));
add("POST", "/leave/setup", async ({ env, request, user }) => json({ leave: await quickSetup(env.DB, user, await readJson(request)) }));
add("POST", "/leave/types", async ({ env, request, user }) => json({ leave: await createType(env.DB, user, await readJson(request)) }, 201));
add("PATCH", "/leave/types/:id", async ({ env, request, user, params }) => json({ leave: await updateType(env.DB, user, params.id, await readJson(request)) }));
add("DELETE", "/leave/types/:id", async ({ env, user, params }) => json({ leave: await deleteType(env.DB, user, params.id) }));
add("POST", "/leave/bookings", async ({ env, request, user }) => {
    const { booking, replayed } = await createBooking(env.DB, user, await readJson(request));
    return json({ booking, leave: await loadLeave(env.DB, user) }, replayed ? 200 : 201);
});
add("PATCH", "/leave/bookings/:id", async ({ env, request, user, params }) => {
    const booking = await updateBooking(env.DB, user, params.id, await readJson(request));
    return json({ booking, leave: await loadLeave(env.DB, user) });
});
add("DELETE", "/leave/bookings/:id", async ({ env, user, params }) => {
    await deleteBooking(env.DB, user, params.id);
    return json({ leave: await loadLeave(env.DB, user) });
});
add("POST", "/leave/adjustments", async ({ env, request, user }) => json({ leave: await addAdjustment(env.DB, user, await readJson(request)) }, 201));
add("DELETE", "/leave/adjustments/:id", async ({ env, user, params }) => json({ leave: await deleteAdjustment(env.DB, user, params.id) }));
add("POST", "/leave/scenarios", async ({ env, request, user }) => json(await createScenario(env.DB, user, await readJson(request)), 201));
add("DELETE", "/leave/scenarios/:id", async ({ env, user, params }) => json({ leave: await deleteScenario(env.DB, user, params.id) }));
add("POST", "/leave/scenarios/:id/adopt", async ({ env, user, params }) => json({ leave: await adoptScenario(env.DB, user, params.id) }));
add("POST", "/leave/shares", async ({ env, request, user }) => json({ leave: await shareLeave(env, env.DB, user, await readJson(request)) }, 201));
add("DELETE", "/leave/shares/:email", async ({ env, user, params }) => json({ leave: await unshareLeave(env.DB, user, params.email) }));

add("GET", "/leave/forecast", async ({ env, url, user }) => {
    const leave = await loadLeave(env.DB, user);
    const today = await todayFor(env.DB, user.email);
    const date = url.searchParams.get("date") ?? today;
    if (!isCalendarDate(date)) throw new HttpError(400, "bad_date", "Use a date like 2026-12-31");
    const modeParam = url.searchParams.get("mode");
    const mode: ForecastMode = modeParam === "confirmed" || modeParam === "all" ? modeParam : "planned";
    const scenario = url.searchParams.get("scenario");
    const months = Math.min(Math.max(Number(url.searchParams.get("months") ?? 18) || 18, 1), 36);
    const ctx = contextFor(leave);
    return json({
        today,
        date,
        mode,
        balances: summarise(leave, today, date, mode, scenario),
        series: leave.types
            .filter((t) => !t.archived && t.tracksBalance)
            .map((t) => ({
                leaveTypeId: t.id,
                points: forecastSeries({ type: t, bookings: leave.bookings, adjustments: leave.adjustments, types: leave.types }, ctx, today, months, scenario),
            })),
    });
});
add("POST", "/leave/quote", async ({ env, request, user }) => json(await quote(env.DB, user, await readJson(request))));
add("POST", "/leave/plan", async ({ env, request, user }) => json({ answer: await answer(env.DB, user, await readJson(request)) }));

const yearOf = (url: URL) => {
    const year = Number(url.searchParams.get("year") ?? new Date().getUTCFullYear());
    if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new HttpError(400, "bad_year", "Choose a year");
    return year;
};
add("GET", "/leave/export.csv", async ({ env, user }) =>
    download(await leaveCsv(env.DB, user), "text/csv; charset=utf-8", `daly-leave-${nowIso().slice(0, 10)}.csv`),
);
add("GET", "/leave/export.xlsx", async ({ env, url, user }) => {
    const year = yearOf(url);
    return download(
        (await leaveXlsx(env.DB, user, year)) as unknown as BodyInit,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        `daly-leave-planner-${year}.xlsx`,
    );
});
add("GET", "/leave/export.pdf", async ({ env, url, user }) => {
    const year = yearOf(url);
    return download((await leavePdf(env.DB, user, year)) as unknown as BodyInit, "application/pdf", `daly-leave-planner-${year}.pdf`);
});

// --- Backup --------------------------------------------------------------------------------------

add("GET", "/backup", async ({ env, user }) =>
    download(JSON.stringify(await backup(env.DB, user), null, 2), "application/json; charset=utf-8", `daly-calendar-backup-${nowIso().slice(0, 10)}.json`),
);
add("POST", "/restore", async ({ env, request, user }) => {
    const body = z
        .object({ dryRun: z.boolean().default(true), backup: z.unknown() })
        .strict()
        .parse(JSON.parse(await readText(request, 20_000_000)));
    return json({ result: await restore(env.DB, user, body.backup, body.dryRun) });
});

// --- Dispatch ------------------------------------------------------------------------------------

export async function handleCalendarApi(request: Request, env: Env, user: PortalUser): Promise<Response> {
    if (!can(user, "calendar.use")) throw new HttpError(403, "forbidden", "You don't have access to Calendar");
    const url = new URL(request.url);
    const method = request.method === "HEAD" ? "GET" : request.method;
    let pathMatched = false;
    for (const route of routes) {
        const match = route.pattern.exec(url.pathname);
        if (!match) continue;
        pathMatched = true;
        if (route.method !== method) continue;
        const params = Object.fromEntries(route.keys.map((key, i) => [key, decodeURIComponent(match[i + 1])]));
        try {
            return await route.handler({ env, request, url, user, params });
        } catch (error) {
            // The panel needs the current event to offer a way forward.
            if (error instanceof EventConflict) return json({ error: error.code, message: error.message, current: error.current }, 409);
            if (error instanceof SyntaxError) throw new HttpError(400, "bad_json", "Request body is not valid JSON");
            throw error;
        }
    }
    if (pathMatched) throw new HttpError(405, "method_not_allowed", "Method not allowed");
    throw new HttpError(404, "not_found", "Not found");
}
