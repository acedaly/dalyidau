// Calendar and leave facts for Chief of Staff (MCP context tools) and Daly Intelligence briefings.
//
// Facts only, worked out deterministically: what's on, overlapping commitments, important dates,
// planned leave, school holidays with and without leave, projected balances and failing
// subscriptions. Private events are "Busy" and sensitive ones "Private event", here as everywhere
// AI can read. Every item carries a link to the portal. Nothing is inferred or summarised by a model.
import type { D1Database } from "@cloudflare/workers-types";
import { schoolHolidaysBetween } from "../../src/shared/calendar/holidays";
import { schoolHolidayPlans } from "../../src/shared/calendar/optimiser";
import { addDays, dayLabel, timeLabel } from "../../src/shared/calendar/time";
import type { EventOccurrence } from "../../src/shared/calendar/types";
import type { PortalUser } from "../../src/shared/portal/types";
import { preferences, todayFor } from "./access";
import { occurrencesInWindow } from "./events";
import { contextFor, loadLeave, summarise } from "./leave";
import { listSubscriptions } from "./subscriptions";

export interface CalendarFactItem {
    id: string;
    title: string;
    when: string;
    url: string;
    detail?: string;
}

const title = (o: EventOccurrence) => (o.busyOnly ? "Busy" : o.visibility === "sensitive" ? "Private event" : o.title);
const when = (o: EventOccurrence) =>
    o.allDay
        ? o.startDate === o.endDate
            ? dayLabel(o.startDate)
            : `${dayLabel(o.startDate)} – ${dayLabel(o.endDate)}`
        : `${dayLabel(o.startDate)}, ${timeLabel(o.startTime!)}`;
const item = (site: string, o: EventOccurrence): CalendarFactItem => ({
    id: o.eventId,
    title: title(o),
    when: when(o),
    url: `${site}/portal/calendar?date=${o.startDate}&event=${o.eventId}`,
    ...(o.location && !o.busyOnly && o.visibility === "default" ? { detail: o.location } : {}),
});

export async function calendarFacts(db: D1Database, user: PortalUser, site: string, days = 7) {
    const prefs = await preferences(db, user.email);
    const today = await todayFor(db, user.email);
    const to = addDays(today, days - 1);
    const [{ occurrences }, upcoming, leave, subscriptions] = await Promise.all([
        occurrencesInWindow(db, user, { from: today, to, timeZone: prefs.timeZone }),
        occurrencesInWindow(db, user, { from: today, to: addDays(today, 30), timeZone: prefs.timeZone, limit: 500 }),
        loadLeave(db, user),
        listSubscriptions(db, user),
    ]);
    const timed = occurrences.filter((o) => !o.allDay && o.showAs === "busy").sort((a, b) => a.start.localeCompare(b.start));
    const overlaps: { first: CalendarFactItem; second: CalendarFactItem }[] = [];
    for (let i = 0; i < timed.length; i++)
        for (let j = i + 1; j < timed.length && timed[j].start < timed[i].end; j++)
            if (timed[i].eventId !== timed[j].eventId) overlaps.push({ first: item(site, timed[i]), second: item(site, timed[j]) });
    const types = new Map(leave.types.map((t) => [t.id, t.name]));
    const plannedLeave = leave.bookings
        .filter((b) => !b.scenarioId && b.status !== "cancelled" && b.status !== "draft" && b.endDate >= today && b.startDate <= addDays(today, 180))
        .map((b) => ({
            id: b.id,
            title: b.title || types.get(b.leaveTypeId) || "Leave",
            when: `${dayLabel(b.startDate)} – ${dayLabel(b.endDate)}`,
            status: b.status,
            url: `${site}/portal/calendar/leave?tab=bookings`,
        }));
    const division = prefs.schoolDivision === "none" ? null : prefs.schoolDivision;
    const leaveDates = new Set<string>();
    for (const b of leave.bookings)
        if (!b.scenarioId && b.status !== "cancelled" && b.status !== "draft") for (let d = b.startDate; d <= b.endDate; d = addDays(d, 1)) leaveDates.add(d);
    const school = division
        ? schoolHolidayPlans(contextFor(leave), schoolHolidaysBetween(today, addDays(today, 120), division), leaveDates).map((p) => ({
              id: p.period.id,
              title: p.period.name,
              when: `${dayLabel(p.period.start)} – ${dayLabel(p.period.end)}`,
              leavePlanned: p.booked,
              leaveHoursToCoverAll: p.cover?.leaveHours ?? null,
              url: `${site}/portal/calendar/leave/planner`,
          }))
        : [];
    const yearEnd = `${today.slice(0, 4)}-12-31`;
    const balances = leave.profile.configured
        ? summarise(leave, today, yearEnd, "planned")
              .filter((s) => s.type.tracksBalance)
              .map((s) => ({ leaveType: s.type.name, nowHours: s.today.confirmed, endOfYearPlannedHours: s.asOf.closing, goesNegativeOn: s.asOf.negativeFrom }))
        : [];
    return {
        timeZone: prefs.timeZone,
        today,
        period: { from: today, to },
        events: { count: occurrences.length, items: occurrences.slice(0, 25).map((o) => item(site, o)) },
        overlapping: overlaps.slice(0, 10),
        importantDates: upcoming.occurrences
            .filter((o) => o.category === "birthday" || o.category === "anniversary")
            .slice(0, 10)
            .map((o) => item(site, o)),
        plannedLeave,
        schoolHolidays: { division, periods: school },
        leaveBalances: { configured: leave.profile.configured, estimates: balances, note: "Estimates from the person's own settings, not employer records." },
        failingSubscriptions: subscriptions
            .filter((s) => s.consecutiveFailures > 0)
            .map((s) => ({ id: s.id, title: s.name, error: s.lastError, lastSuccessAt: s.lastSuccessAt, url: `${site}/portal/calendar/subscriptions` })),
    };
}
