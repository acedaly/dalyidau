// Import and export: one-time ICS import, ICS export of a calendar, leave as CSV, Excel and PDF,
// and a portable backup of everything the person owns in Calendar and Leave, with restore.
//
// A one-time import copies events into one of the person's own calendars once; they're ordinary
// editable events afterwards and nothing is fetched again. A subscription (subscriptions.ts) is
// the opposite: read-only and kept in step with its source. Importing the same file twice adds
// nothing the second time (events are matched on their UID).
//
// Backups never contain a subscription's address or a feed's token: those are credentials, and
// restoring brings them back as "add the address again" and "create a new feed".
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { z } from "zod";
import { type ForecastMode, bookingHours, formatHours, weeklyHours } from "../../src/shared/calendar/leave";
import { NSW_PUBLIC_HOLIDAYS } from "../../src/shared/calendar/nsw";
import { dayLabel, eachDate, isoWeekday } from "../../src/shared/calendar/time";
import { LEAVE_STATUS_LABELS, type LeaveData } from "../../src/shared/calendar/types";
import type { PortalUser } from "../../src/shared/portal/types";
import { toCsv } from "../portal/csv";
import { newId, nowIso, parseJson } from "../portal/db";
import { HttpError } from "../portal/http";
import { activity, preferences, requireCalendar, requireWritableCalendar, todayFor } from "./access";
import { EVENT_COLUMNS, type EventRow } from "./events";
import { type OverrideFields, type OverrideRow, instants, seriesEndAt } from "./expand";
import { IcsError, type SerialEvent, parseIcs, serializeCalendar } from "./ics";
import { contextFor, loadLeave, summarise } from "./leave";
import { type Sheet, workbook } from "./xlsx";

// --- ICS ------------------------------------------------------------------------------------------

/** One calendar as ICS. Viewers get what they can see; free/busy members and other people's private events export as "Busy". */
export async function exportCalendarIcs(db: D1Database, user: PortalUser, calendarId: string): Promise<{ name: string; body: string }> {
    const cal = await requireCalendar(db, user, calendarId, "freebusy");
    const rows = await db
        .prepare(`SELECT ${EVENT_COLUMNS} FROM calendar_events e WHERE e.calendar_id = ? AND e.status <> 'cancelled' LIMIT 10000`)
        .bind(calendarId)
        .all<EventRow>();
    const overrides = await db
        .prepare(
            "SELECT o.event_id, o.occurrence_key, o.cancelled, o.fields, o.start_at, o.end_at FROM calendar_event_overrides o JOIN calendar_events e ON e.id = o.event_id WHERE e.calendar_id = ?",
        )
        .bind(calendarId)
        .all<OverrideRow>();
    const byEvent = new Map<string, OverrideRow[]>();
    for (const o of overrides.results) byEvent.set(o.event_id, [...(byEvent.get(o.event_id) ?? []), o]);
    const events: SerialEvent[] = rows.results.map((r) => {
        const hidden = cal.role === "freebusy" || (r.visibility !== "default" && r.created_by !== user.email);
        return {
            uid: r.uid,
            title: hidden ? "Busy" : r.title,
            description: hidden ? null : r.description,
            location: hidden ? null : r.location,
            url: hidden ? null : r.url,
            allDay: !!r.all_day,
            startDate: r.start_date,
            startTime: r.start_time,
            endDate: r.end_date,
            endTime: r.end_time,
            timeZone: r.time_zone,
            rrule: r.rrule,
            exdates: parseJson<string[]>(r.exdates, []),
            rdates: parseJson<string[]>(r.rdates, []),
            status: r.status,
            showAs: r.show_as,
            private: hidden || r.visibility !== "default",
            categories: hidden ? [] : [r.category],
            updatedAt: r.updated_at,
            overrides: (byEvent.get(r.id) ?? []).map((o) => {
                const f = parseJson<OverrideFields>(o.fields, {});
                const allDay = f.allDay ?? !!r.all_day;
                return {
                    key: o.occurrence_key,
                    cancelled: !!o.cancelled || f.status === "cancelled",
                    title: hidden ? "Busy" : (f.title ?? r.title),
                    description: hidden ? null : f.description !== undefined ? f.description : r.description,
                    location: hidden ? null : f.location !== undefined ? f.location : r.location,
                    allDay,
                    startDate: f.startDate ?? o.occurrence_key.slice(0, 10),
                    startTime: allDay ? null : (f.startTime ?? (o.occurrence_key.slice(11) || r.start_time)),
                    endDate: f.endDate ?? f.startDate ?? o.occurrence_key.slice(0, 10),
                    endTime: allDay ? null : (f.endTime ?? r.end_time),
                };
            }),
        };
    });
    await activity(db, { actor: user.email, action: "calendar.export", entityType: "calendar", entityId: calendarId, calendarId }).run();
    return { name: cal.name, body: serializeCalendar({ name: cal.name, events }) };
}

export interface ImportResult {
    added: number;
    alreadyThere: number;
    skipped: Record<string, number>;
    dryRun: boolean;
}

/** A one-time copy of an ICS file's events into one of the caller's calendars. */
export async function importIcs(db: D1Database, user: PortalUser, calendarId: string, text: string, dryRun: boolean): Promise<ImportResult> {
    const cal = await requireWritableCalendar(db, user, calendarId);
    let parsed;
    try {
        parsed = parseIcs(text, { fallbackZone: cal.time_zone, maxEvents: 3000 });
    } catch (error) {
        if (error instanceof IcsError) throw new HttpError(422, error.code, error.message);
        throw error;
    }
    const existing = await db
        .prepare("SELECT uid FROM calendar_events WHERE calendar_id = ? AND uid IN (SELECT value FROM json_each(?))")
        .bind(calendarId, JSON.stringify(parsed.events.map((e) => e.uid)))
        .all<{ uid: string }>();
    const have = new Set(existing.results.map((r) => r.uid));
    const fresh = parsed.events.filter((e) => !have.has(e.uid));
    if (dryRun) return { added: fresh.length, alreadyThere: have.size, skipped: parsed.skipped, dryRun };
    const now = nowIso();
    const statements: D1PreparedStatement[] = [];
    for (const e of fresh) {
        const id = newId("cev");
        const times = {
            all_day: e.allDay ? 1 : 0,
            start_date: e.startDate,
            start_time: e.startTime,
            end_date: e.endDate,
            end_time: e.endTime,
            time_zone: e.timeZone,
            rrule: e.rrule,
            rdates: e.rdates.length ? JSON.stringify(e.rdates) : null,
            exdates: e.exdates.length ? JSON.stringify(e.exdates) : null,
        };
        const { startAt, endAt } = instants(e.allDay, e.startDate, e.startTime, e.endDate, e.endTime, e.timeZone);
        statements.push(
            db
                .prepare(
                    `INSERT INTO calendar_events (id, calendar_id, source, uid, title, description, location, url, all_day, start_date, start_time, end_date, end_time,
                        time_zone, start_at, end_at, rrule, rdates, exdates, series_end_at, visibility, show_as, status, created_by, created_at, updated_by, updated_at)
                     VALUES (?, ?, 'import', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (calendar_id, uid) DO NOTHING`,
                )
                .bind(
                    id,
                    calendarId,
                    e.uid,
                    e.title,
                    e.description,
                    e.location,
                    e.url,
                    times.all_day,
                    times.start_date,
                    times.start_time,
                    times.end_date,
                    times.end_time,
                    times.time_zone,
                    startAt,
                    endAt,
                    times.rrule,
                    times.rdates,
                    times.exdates,
                    seriesEndAt(times),
                    e.visibility,
                    e.showAs,
                    e.status,
                    user.email,
                    now,
                    user.email,
                    now,
                ),
        );
        for (const o of e.overrides)
            statements.push(
                db
                    .prepare(
                        `INSERT INTO calendar_event_overrides (event_id, occurrence_key, cancelled, fields, updated_by, updated_at) SELECT id, ?, ?, ?, ?, ? FROM calendar_events
                         WHERE calendar_id = ? AND uid = ? ON CONFLICT DO NOTHING`,
                    )
                    .bind(o.key, o.cancelled ? 1 : 0, JSON.stringify(o.fields), user.email, now, calendarId, e.uid),
            );
    }
    statements.push(activity(db, { actor: user.email, action: "calendar.import", entityType: "calendar", entityId: calendarId, calendarId }));
    for (let i = 0; i < statements.length; i += 50) await db.batch(statements.slice(i, i + 50));
    return { added: fresh.length, alreadyThere: have.size, skipped: parsed.skipped, dryRun };
}

// --- Leave ---------------------------------------------------------------------------------------

interface LeaveRow {
    type: string;
    status: string;
    start: string;
    end: string;
    part: string;
    hours: number;
    workingDays: number;
    title: string;
    scenario: string;
    note: string;
}

function leaveRows(leave: LeaveData): LeaveRow[] {
    const ctx = contextFor(leave);
    const types = new Map(leave.types.map((t) => [t.id, t]));
    const scenarios = new Map(leave.scenarios.map((s) => [s.id, s.name]));
    return leave.bookings.map((b) => {
        const type = types.get(b.leaveTypeId);
        const hours = type ? bookingHours(b, type, ctx) : 0;
        const working = eachDate(b.startDate, b.endDate, 800).filter((d) => ctx.pattern.hours[isoWeekday(d) - 1] > 0 && !ctx.holidays.has(d)).length;
        return {
            type: type?.name ?? "",
            status: LEAVE_STATUS_LABELS[b.status].label,
            start: b.startDate,
            end: b.endDate,
            part: b.part === "full" ? "Full days" : b.part === "am" ? "Morning" : b.part === "pm" ? "Afternoon" : `${b.hours ?? 0} hours`,
            hours,
            workingDays: working,
            title: b.title ?? "",
            scenario: b.scenarioId ? (scenarios.get(b.scenarioId) ?? "Scenario") : "",
            note: b.note ?? "",
        };
    });
}

export async function leaveCsv(db: D1Database, user: PortalUser) {
    const leave = await loadLeave(db, user);
    await activity(db, { actor: user.email, action: "leave.export", entityType: "leave", entityId: "csv" }).run();
    return toCsv(leaveRows(leave), [
        { header: "Leave type", value: (r) => r.type },
        { header: "Status", value: (r) => r.status },
        { header: "Start", value: (r) => r.start },
        { header: "End", value: (r) => r.end },
        { header: "Part", value: (r) => r.part },
        { header: "Hours deducted", value: (r) => r.hours },
        { header: "Working days", value: (r) => r.workingDays },
        { header: "Title", value: (r) => r.title },
        { header: "Scenario", value: (r) => r.scenario },
        { header: "Note", value: (r) => r.note },
    ]);
}

/** The leave planner as an Excel workbook: bookings, balances by month, and a day-by-day year sheet. */
export async function leaveXlsx(db: D1Database, user: PortalUser, year: number) {
    const leave = await loadLeave(db, user);
    const today = await todayFor(db, user.email);
    const ctx = contextFor(leave);
    const rows = leaveRows(leave);
    const bookings: Sheet = {
        name: "Bookings",
        rows: [
            ["Leave type", "Status", "Start", "End", "Part", "Hours deducted", "Working days", "Title", "Scenario", "Note"],
            ...rows.map((r) => [r.type, r.status, r.start, r.end, r.part, r.hours, r.workingDays, r.title, r.scenario, r.note]),
        ],
    };
    const months = Array.from({ length: 12 }, (_, i) => {
        const m = i + 1;
        const last = new Date(Date.UTC(year, m, 0)).getUTCDate();
        return `${year}-${String(m).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
    });
    const balances: Sheet = {
        name: "Balances",
        rows: [
            ["Leave type", "Mode", ...months.map((m) => `End of ${dayLabel(m).slice(-8)}`)],
            ...leave.types
                .filter((t) => !t.archived && t.tracksBalance)
                .flatMap((t) =>
                    (["confirmed", "planned"] as ForecastMode[]).map((mode) => [
                        t.name,
                        mode === "confirmed" ? "Approved and taken" : "Including requested and proposed",
                        ...months.map((m) => summarise({ ...leave, types: [t] }, today, m, mode)[0]?.asOf.closing ?? null),
                    ]),
                ),
        ],
    };
    const days = eachDate(`${year}-01-01`, `${year}-12-31`, 400);
    const leaveOn = new Map<string, string>();
    const types = new Map(leave.types.map((t) => [t.id, t.name]));
    for (const b of leave.bookings)
        if (!b.scenarioId && b.status !== "cancelled" && b.status !== "draft")
            for (const d of eachDate(b.startDate, b.endDate, 800))
                leaveOn.set(d, `${types.get(b.leaveTypeId) ?? "Leave"} (${LEAVE_STATUS_LABELS[b.status].label})`);
    const holidays = new Map(NSW_PUBLIC_HOLIDAYS.map((h) => [h.date, h.name]));
    const calendar: Sheet = {
        name: `Year ${year}`,
        rows: [
            ["Date", "Day", "Ordinary hours", "Public holiday", "Leave"],
            ...days.map((d) => [
                d,
                dayLabel(d).slice(0, 3),
                ctx.pattern.kind === "weekly" ? ctx.pattern.hours[isoWeekday(d) - 1] : null,
                holidays.get(d) ?? "",
                leaveOn.get(d) ?? "",
            ]),
        ],
    };
    await activity(db, { actor: user.email, action: "leave.export", entityType: "leave", entityId: "xlsx" }).run();
    return workbook([bookings, balances, calendar]);
}

const printable = (text: string) =>
    text
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[‘’]/g, "'")
        .replace(/[“”]/g, '"')
        .replace(/[–—]/g, "-")
        .replace(/[^\x20-\x7e]/g, "");

/** A printable A4 landscape annual leave planner: balances, then the year as a grid of months and days. */
export async function leavePdf(db: D1Database, user: PortalUser, year: number): Promise<Uint8Array> {
    const leave = await loadLeave(db, user);
    const today = await todayFor(db, user.email);
    const doc = await PDFDocument.create();
    doc.setTitle(`Annual leave planner ${year}`);
    doc.setCreator("Daly Calendar");
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const page = doc.addPage([842, 595]);
    const ink = rgb(0.09, 0.11, 0.15);
    const muted = rgb(0.4, 0.43, 0.48);
    page.drawText(printable(`Annual leave planner ${year}`), { x: 36, y: 555, size: 18, font: bold, color: ink });
    const employer = leave.profile.settings.employer ? ` · ${leave.profile.settings.employer}` : "";
    page.drawText(printable(`${user.name ?? user.email}${employer} · ${formatHours(weeklyHours(leave.profile.pattern))} h a week · printed ${today}`), {
        x: 36,
        y: 538,
        size: 9,
        font,
        color: muted,
    });
    // Balances at the end of the year.
    let x = 36;
    for (const s of summarise(leave, today, `${year}-12-31`, "planned")
        .filter((s) => s.type.tracksBalance)
        .slice(0, 5)) {
        page.drawText(printable(s.type.name), { x, y: 515, size: 9, font: bold, color: ink });
        page.drawText(printable(`Now ${formatHours(s.today.confirmed)} h · 31 Dec ${formatHours(s.asOf.closing)} h (planned)`), {
            x,
            y: 503,
            size: 8,
            font,
            color: muted,
        });
        x += 158;
    }
    // The year grid: one row per month, one column per day.
    const leaveOn = new Map<string, string>();
    for (const b of leave.bookings)
        if (!b.scenarioId && b.status !== "cancelled" && b.status !== "draft") for (const d of eachDate(b.startDate, b.endDate, 800)) leaveOn.set(d, b.status);
    const holidays = new Set(NSW_PUBLIC_HOLIDAYS.filter((h) => h.kind !== "bank").map((h) => h.date));
    const left = 66;
    const cell = 23.5;
    const top = 470;
    for (let d = 1; d <= 31; d++) page.drawText(String(d), { x: left + (d - 1) * cell + 7, y: top + 6, size: 7, font, color: muted });
    for (let m = 0; m < 12; m++) {
        const y = top - (m + 1) * 34;
        const month = new Intl.DateTimeFormat("en-AU", { month: "short", timeZone: "UTC" }).format(Date.UTC(year, m, 1));
        page.drawText(month, { x: 36, y: y + 12, size: 9, font: bold, color: ink });
        const days = new Date(Date.UTC(year, m + 1, 0)).getUTCDate();
        for (let d = 1; d <= days; d++) {
            const date = `${year}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
            const weekday = isoWeekday(date);
            const status = leaveOn.get(date);
            const fill = status
                ? status === "approved" || status === "taken"
                    ? rgb(0.33, 0.55, 0.93)
                    : rgb(0.74, 0.82, 0.98)
                : holidays.has(date)
                  ? rgb(0.98, 0.79, 0.45)
                  : weekday >= 6
                    ? rgb(0.93, 0.94, 0.95)
                    : rgb(1, 1, 1);
            page.drawRectangle({ x: left + (d - 1) * cell, y, width: cell - 2, height: 28, color: fill, borderColor: rgb(0.85, 0.86, 0.88), borderWidth: 0.5 });
            page.drawText("MTWTFSS"[weekday - 1], {
                x: left + (d - 1) * cell + 7,
                y: y + 10,
                size: 7,
                font,
                color: status === "approved" || status === "taken" ? rgb(1, 1, 1) : muted,
            });
        }
    }
    const legend: [string, ReturnType<typeof rgb>][] = [
        ["Approved or taken", rgb(0.33, 0.55, 0.93)],
        ["Requested or proposed", rgb(0.74, 0.82, 0.98)],
        ["NSW public holiday", rgb(0.98, 0.79, 0.45)],
        ["Weekend", rgb(0.93, 0.94, 0.95)],
    ];
    legend.forEach(([label, color], i) => {
        page.drawRectangle({ x: 36 + i * 150, y: 22, width: 10, height: 10, color });
        page.drawText(label, { x: 52 + i * 150, y: 24, size: 8, font, color: muted });
    });
    page.drawText(printable("Balances are estimates from your own settings, not your employer's records."), {
        x: 640 - 60,
        y: 24,
        size: 7,
        font,
        color: muted,
    });
    await activity(db, { actor: user.email, action: "leave.export", entityType: "leave", entityId: "pdf" }).run();
    return doc.save();
}

// --- Backup and restore --------------------------------------------------------------------------

const BACKUP_FORMAT = "daly-calendar-backup";

/** Everything the caller owns in Calendar and Leave, as one JSON document. */
export async function backup(db: D1Database, user: PortalUser) {
    const prefs = await preferences(db, user.email);
    const calendars = await db
        .prepare("SELECT id, name, description, color, kind, purpose, time_zone, is_default FROM calendars WHERE owner_email = ? AND source = 'local'")
        .bind(user.email)
        .all<{ id: string; name: string; description: string | null; color: string; kind: string; purpose: string; time_zone: string; is_default: number }>();
    const ids = calendars.results.map((c) => c.id);
    const events = ids.length
        ? (
              await db
                  .prepare(`SELECT ${EVENT_COLUMNS} FROM calendar_events e WHERE e.calendar_id IN (SELECT value FROM json_each(?)) LIMIT 20000`)
                  .bind(JSON.stringify(ids))
                  .all<EventRow>()
          ).results
        : [];
    const overrides = ids.length
        ? (
              await db
                  .prepare(
                      "SELECT o.event_id, o.occurrence_key, o.cancelled, o.fields FROM calendar_event_overrides o JOIN calendar_events e ON e.id = o.event_id WHERE e.calendar_id IN (SELECT value FROM json_each(?))",
                  )
                  .bind(JSON.stringify(ids))
                  .all()
          ).results
        : [];
    const reminders = (await db.prepare("SELECT event_id, minutes_before FROM calendar_reminders WHERE email = ?").bind(user.email).all()).results;
    const subscriptions = (
        await db
            .prepare(
                "SELECT c.name, c.color, c.kind, s.url_display, s.refresh_minutes FROM calendar_subscriptions s JOIN calendars c ON c.id = s.calendar_id WHERE s.owner_email = ?",
            )
            .bind(user.email)
            .all()
    ).results;
    const leave = await loadLeave(db, user);
    await activity(db, { actor: user.email, action: "calendar.backup", entityType: "backup", entityId: null }).run();
    return {
        format: BACKUP_FORMAT,
        version: 1,
        exportedAt: nowIso(),
        note: "Subscription addresses and feed addresses are not included: they are credentials. Add them again after restoring.",
        preferences: prefs,
        calendars: calendars.results,
        events: events.map(({ updated_at: _u, version: _v, ...e }) => e),
        overrides,
        reminders,
        subscriptions,
        customDates: leave.customDates.filter((d) => d.mine),
        leave: { profile: leave.profile, types: leave.types, bookings: leave.bookings, adjustments: leave.adjustments, scenarios: leave.scenarios },
    };
}

const restoreInput = z
    .object({
        format: z.literal(BACKUP_FORMAT),
        version: z.literal(1),
        calendars: z
            .array(
                z
                    .object({
                        id: z.string(),
                        name: z.string().max(100),
                        description: z.string().max(1000).nullable(),
                        color: z.string().max(20),
                        kind: z.enum(["personal", "shared"]),
                        purpose: z.string().max(20),
                        time_zone: z.string().max(64),
                        is_default: z.number(),
                    })
                    .passthrough(),
            )
            .max(60),
        events: z.array(z.record(z.string(), z.unknown())).max(20000),
        overrides: z.array(z.record(z.string(), z.unknown())).max(50000).default([]),
        reminders: z
            .array(z.object({ event_id: z.string(), minutes_before: z.number().int().min(0).max(40320) }))
            .max(50000)
            .default([]),
        leave: z
            .object({
                profile: z.unknown(),
                types: z.array(z.record(z.string(), z.unknown())).max(50),
                bookings: z.array(z.record(z.string(), z.unknown())).max(5000),
                adjustments: z.array(z.record(z.string(), z.unknown())).max(5000),
                scenarios: z.array(z.record(z.string(), z.unknown())).max(100),
            })
            .optional(),
        customDates: z.array(z.record(z.string(), z.unknown())).max(2000).default([]),
    })
    .passthrough();

/**
 * Restores a backup into the caller's account as new records: calendars come back as new
 * calendars ("… (restored)"), with their events (UIDs kept, so exports still match); leave types
 * whose name already exists are matched rather than duplicated. Nothing existing is changed or
 * removed. `dryRun` reports what would be restored.
 */
export async function restore(db: D1Database, user: PortalUser, input: unknown, dryRun: boolean) {
    const body = restoreInput.parse(input);
    const summary = {
        calendars: body.calendars.length,
        events: body.events.length,
        leaveTypes: body.leave?.types.length ?? 0,
        bookings: body.leave?.bookings.length ?? 0,
        dryRun,
    };
    if (dryRun) return summary;
    const now = nowIso();
    const calendarIds = new Map<string, string>();
    const eventIds = new Map<string, string>();
    const statements: D1PreparedStatement[] = [];
    for (const c of body.calendars) {
        const id = newId("cal");
        calendarIds.set(c.id, id);
        statements.push(
            db
                .prepare(
                    `INSERT INTO calendars (id, name, description, color, kind, purpose, source, time_zone, owner_email, created_by, created_at, updated_by, updated_at)
                     VALUES (?, ?, ?, ?, 'personal', ?, 'local', ?, ?, ?, ?, ?, ?)`,
                )
                .bind(
                    id,
                    `${c.name.slice(0, 88)} (restored)`,
                    c.description,
                    c.color,
                    ["general", "family", "work", "school", "care", "birthdays", "travel"].includes(c.purpose) ? c.purpose : "general",
                    c.time_zone,
                    user.email,
                    user.email,
                    now,
                    user.email,
                    now,
                ),
            db
                .prepare(
                    "INSERT INTO calendar_members (calendar_id, email, role, position, added_by, created_at, updated_at) VALUES (?, ?, 'owner', 300, ?, ?, ?)",
                )
                .bind(id, user.email, user.email, now, now),
        );
    }
    const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : null);
    for (const e of body.events) {
        const calendarId = calendarIds.get(String(e.calendar_id));
        if (!calendarId) continue;
        const id = newId("cev");
        eventIds.set(String(e.id), id);
        statements.push(
            db
                .prepare(
                    `INSERT INTO calendar_events (id, calendar_id, source, uid, title, description, location, url, all_day, start_date, start_time, end_date, end_time, time_zone,
                        start_at, end_at, rrule, rdates, exdates, series_end_at, category, color, visibility, show_as, status, people, created_by, created_at, updated_by, updated_at)
                     VALUES (?, ?, 'local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
                )
                .bind(
                    id,
                    calendarId,
                    str(e.uid, 255) ?? `${id}@daly.id.au`,
                    str(e.title, 300) ?? "Untitled",
                    str(e.description, 8000),
                    str(e.location, 500),
                    str(e.url, 1000),
                    e.all_day ? 1 : 0,
                    str(e.start_date, 10),
                    str(e.start_time, 5),
                    str(e.end_date, 10),
                    str(e.end_time, 5),
                    str(e.time_zone, 64),
                    str(e.start_at, 30),
                    str(e.end_at, 30),
                    str(e.rrule, 500),
                    str(e.rdates, 20000),
                    str(e.exdates, 20000),
                    str(e.series_end_at, 30),
                    str(e.category, 20) ?? "general",
                    str(e.color, 20),
                    str(e.visibility, 20) ?? "default",
                    str(e.show_as, 10) ?? "busy",
                    str(e.status, 20) ?? "confirmed",
                    str(e.people, 4000),
                    user.email,
                    now,
                    user.email,
                    now,
                ),
        );
    }
    for (const o of body.overrides) {
        const eventId = eventIds.get(String(o.event_id));
        if (!eventId) continue;
        statements.push(
            db
                .prepare(
                    "INSERT INTO calendar_event_overrides (event_id, occurrence_key, cancelled, fields, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
                )
                .bind(eventId, str(o.occurrence_key, 16), o.cancelled ? 1 : 0, str(o.fields, 20000) ?? "{}", user.email, now),
        );
    }
    for (const r of body.reminders) {
        const eventId = eventIds.get(r.event_id);
        if (eventId)
            statements.push(
                db
                    .prepare("INSERT INTO calendar_reminders (id, event_id, email, minutes_before, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING")
                    .bind(newId("crm"), eventId, user.email, r.minutes_before, now),
            );
    }
    statements.push(activity(db, { actor: user.email, action: "calendar.restore", entityType: "backup", entityId: null }));
    for (let i = 0; i < statements.length; i += 50) await db.batch(statements.slice(i, i + 50));

    if (body.leave) {
        const existing = await loadLeave(db, user);
        const typeIds = new Map<string, string>();
        const scenarioIds = new Map<string, string>();
        const leaveStatements: D1PreparedStatement[] = [];
        for (const t of body.leave.types) {
            const name = str(t.name, 60) ?? "Leave";
            const match = existing.types.find((x) => x.name.toLowerCase() === name.toLowerCase());
            if (match) {
                typeIds.set(String(t.id), match.id);
                continue;
            }
            const id = newId("lvt");
            typeIds.set(String(t.id), id);
            leaveStatements.push(
                db
                    .prepare(
                        `INSERT INTO leave_types (id, email, kind, name, color, paid, tracks_balance, balance_hours, balance_date, accrual, deducts_public_holidays, created_at, updated_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    )
                    .bind(
                        id,
                        user.email,
                        str(t.kind, 20) ?? "other",
                        name,
                        str(t.color, 20) ?? "blue",
                        t.paid ? 1 : 0,
                        t.tracksBalance === false ? 0 : 1,
                        Number(t.balanceHours) || 0,
                        str(t.balanceDate, 10) ?? now.slice(0, 10),
                        JSON.stringify(t.accrual ?? { method: "none" }),
                        t.deductsPublicHolidays ? 1 : 0,
                        now,
                        now,
                    ),
            );
        }
        for (const s of body.leave.scenarios) {
            const id = newId("lvs");
            scenarioIds.set(String(s.id), id);
            leaveStatements.push(
                db
                    .prepare("INSERT INTO leave_scenarios (id, email, name, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
                    .bind(id, user.email, str(s.name, 80) ?? "Scenario", str(s.note, 500), now, now),
            );
        }
        for (const b of body.leave.bookings) {
            const typeId = typeIds.get(String(b.leaveTypeId));
            if (!typeId) continue;
            leaveStatements.push(
                db
                    .prepare(
                        `INSERT INTO leave_bookings (id, email, leave_type_id, scenario_id, start_date, end_date, part, hours, day_hours, status, title, note, created_by, created_at, updated_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'import', ?, ?)`,
                    )
                    .bind(
                        newId("lvb"),
                        user.email,
                        typeId,
                        b.scenarioId ? (scenarioIds.get(String(b.scenarioId)) ?? null) : null,
                        str(b.startDate, 10),
                        str(b.endDate, 10),
                        str(b.part, 5) ?? "full",
                        b.part === "hours" ? Number(b.hours) || 0 : null,
                        b.dayHours ? JSON.stringify(b.dayHours) : null,
                        str(b.status, 12) ?? "draft",
                        str(b.title, 120),
                        str(b.note, 1000),
                        now,
                        now,
                    ),
            );
        }
        for (const a of body.leave.adjustments) {
            const typeId = typeIds.get(String(a.leaveTypeId));
            if (typeId && Number(a.hours))
                leaveStatements.push(
                    db
                        .prepare("INSERT INTO leave_adjustments (id, leave_type_id, email, date, hours, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
                        .bind(newId("lva"), typeId, user.email, str(a.date, 10), Number(a.hours), str(a.reason, 200), now),
                );
        }
        for (let i = 0; i < leaveStatements.length; i += 50) await db.batch(leaveStatements.slice(i, i + 50));
    }
    return summary;
}
