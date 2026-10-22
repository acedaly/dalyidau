// Events: create, change (the whole series, one occurrence, or this and later ones), delete,
// reminders, and the occurrences in a window as each person may see them.
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { z } from "zod";
import { describeRepeat, fromRRule, repeatRule, toRRule } from "../../src/shared/calendar/recurrence";
import {
    addDays,
    addWallMinutes,
    dayLabel,
    dayStart,
    isOccurrenceKey,
    isTimeZone,
    occurrenceKey,
    wallClock,
    wallMinutes,
} from "../../src/shared/calendar/time";
import {
    CALENDAR_COLORS,
    type CalendarColor,
    type CalendarRole,
    EVENT_CATEGORIES,
    type EventDetail,
    type EventOccurrence,
    type EventPeople,
    LIMITS,
    VISIBILITIES,
} from "../../src/shared/calendar/types";
import type { PortalUser } from "../../src/shared/portal/types";
import { chunk, newId, nowIso, parseJson } from "../portal/db";
import { ValidationError } from "../portal/entities";
import { HttpError } from "../portal/http";
import { activity, notFound, preferences, requireEditableEvent, requireEvent, requireWritableCalendar } from "./access";
import {
    type EventTimes,
    type OverrideFields,
    type OverrideRow,
    type Window,
    expand,
    instants,
    isSeriesOccurrence,
    occurrencesBefore,
    seriesEndAt,
} from "./expand";

// --- Rows ----------------------------------------------------------------------------------------

export interface EventRow extends EventTimes {
    id: string;
    calendar_id: string;
    source: "local" | "subscription" | "import";
    uid: string;
    title: string;
    description: string | null;
    location: string | null;
    url: string | null;
    start_at: string;
    end_at: string;
    series_end_at: string;
    category: EventDetail["category"];
    color: string | null;
    visibility: EventDetail["visibility"];
    show_as: "busy" | "free";
    status: EventDetail["status"];
    people: string | null;
    created_by: string;
    updated_at: string;
    version: number;
}

export const EVENT_COLUMNS = `e.id, e.calendar_id, e.source, e.uid, e.title, e.description, e.location, e.url, e.all_day, e.start_date, e.start_time, e.end_date,
    e.end_time, e.time_zone, e.start_at, e.end_at, e.rrule, e.rdates, e.exdates, e.series_end_at, e.category, e.color, e.visibility, e.show_as, e.status,
    e.people, e.created_by, e.updated_at, e.version`;

interface VisibleRow extends EventRow {
    role: CalendarRole;
    member_color: string | null;
    calendar_color: string;
    calendar_source: "local" | "subscription";
}

const asColor = (value: string | null | undefined): CalendarColor | null =>
    (CALENDAR_COLORS as readonly string[]).includes(value ?? "") ? (value as CalendarColor) : null;

// --- Input ---------------------------------------------------------------------------------------

const plain = (max: number) =>
    z
        .string()
        // eslint-disable-next-line no-control-regex
        .transform((v) => v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim())
        .pipe(z.string().max(max));
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-10-18");
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time like 09:30");
const httpUrl = z
    .string()
    .trim()
    .max(1000)
    .refine((v) => /^https?:\/\/[^\s]+$/i.test(v), "Only web links (https://…) are allowed");

const peopleInput = z
    .object({
        who: z.array(plain(60).pipe(z.string().min(1))).max(LIMITS.people),
        responsible: z.string().trim().toLowerCase().email().nullable(),
    })
    .strict();

const fieldsShape = {
    title: plain(LIMITS.title).pipe(z.string().min(1, "Give the event a title")),
    description: plain(LIMITS.description).nullish(),
    location: plain(LIMITS.location).nullish(),
    url: httpUrl.nullish(),
    allDay: z.boolean(),
    startDate: date,
    startTime: time.nullish(),
    endDate: date,
    endTime: time.nullish(),
    timeZone: z.string().max(64).refine(isTimeZone, "Choose a valid time zone").optional(),
    repeat: repeatRule.nullish(),
    category: z.enum(EVENT_CATEGORIES),
    color: z.enum(CALENDAR_COLORS).nullish(),
    visibility: z.enum(VISIBILITIES),
    showAs: z.enum(["busy", "free"]),
    status: z.enum(["confirmed", "tentative"]),
    people: peopleInput.nullish(),
};

export const createEventInput = z
    .object({
        calendarId: z
            .string()
            .regex(/^cal_[a-z0-9]{14}$/, "Choose a calendar")
            .optional(),
        ...fieldsShape,
        category: fieldsShape.category.default("general"),
        visibility: fieldsShape.visibility.default("default"),
        showAs: fieldsShape.showAs.default("busy"),
        status: fieldsShape.status.default("confirmed"),
        /** Minutes before each occurrence; defaults to the person's default reminder. */
        reminders: z.array(z.number().int().min(0).max(40320)).max(LIMITS.remindersPerEvent).optional(),
        clientId: z
            .string()
            .regex(/^[A-Za-z0-9_-]{8,64}$/)
            .optional(),
    })
    .strict();

// No defaults in a patch: a field left out stays as it is.
const updateFields = z.object(fieldsShape).partial();
export const updateEventInput = updateFields
    .extend({
        version: z.number().int().min(1),
        calendarId: z
            .string()
            .regex(/^cal_[a-z0-9]{14}$/)
            .optional(),
        /** series: every occurrence (default); occurrence: only `occurrenceKey`; following: it and every later one. */
        scope: z.enum(["series", "occurrence", "following"]).default("series"),
        occurrenceKey: z.string().refine(isOccurrenceKey, "Not a valid occurrence").optional(),
    })
    .strict();

type Fields = z.output<typeof updateFields>;

interface Resolved {
    allDay: boolean;
    startDate: string;
    startTime: string | null;
    endDate: string;
    endTime: string | null;
    timeZone: string;
}

const invalid = (path: string, message: string) => new ValidationError(message, path);

/** Checks that start comes before end and the event isn't absurdly long. */
function checkTimes(t: Resolved) {
    if (t.endDate < t.startDate) throw invalid("endDate", "The event ends before it starts");
    if (t.allDay) {
        if (addDays(t.startDate, 366) < t.endDate) throw invalid("endDate", "An event can last at most a year");
        return;
    }
    if (!t.startTime || !t.endTime) throw invalid("startTime", "Give a start and end time, or make it all day");
    const minutes = wallMinutes(t.startDate, t.startTime, t.endDate, t.endTime);
    if (minutes < 0) throw invalid("endTime", "The event ends before it starts");
    if (minutes > 31 * 1440) throw invalid("endDate", "A timed event can last at most 31 days. Make it all day instead.");
}

async function checkResponsible(db: D1Database, calendarId: string, people: EventPeople | null | undefined) {
    if (!people?.responsible) return;
    const member = await db
        .prepare("SELECT role FROM calendar_members WHERE calendar_id = ? AND email = ? AND role IN ('owner', 'editor')")
        .bind(calendarId, people.responsible)
        .first();
    if (!member) throw invalid("people.responsible", "The person responsible must be able to edit this calendar");
}

const rowTimes = (t: Resolved, rrule: string | null, exdates: string[] = [], rdates: string[] = []): EventTimes => ({
    all_day: t.allDay ? 1 : 0,
    start_date: t.startDate,
    start_time: t.allDay ? null : t.startTime,
    end_date: t.endDate,
    end_time: t.allDay ? null : t.endTime,
    time_zone: t.timeZone,
    rrule,
    rdates: rdates.length ? JSON.stringify(rdates) : null,
    exdates: exdates.length ? JSON.stringify(exdates) : null,
});

// --- Create --------------------------------------------------------------------------------------

export async function createEvent(
    db: D1Database,
    user: PortalUser,
    input: unknown,
    options: { via?: "portal" | "mcp"; defaultCalendarId?: string } = {},
): Promise<{ event: EventDetail; replayed: boolean }> {
    const body = createEventInput.parse(input);
    if (body.clientId) {
        const earlier = await db
            .prepare("SELECT id FROM calendar_events WHERE created_by = ? AND client_id = ?")
            .bind(user.email, body.clientId)
            .first<{ id: string }>();
        if (earlier) return { event: await eventDetail(db, user, earlier.id), replayed: true };
    }
    const calendarId = body.calendarId ?? options.defaultCalendarId;
    if (!calendarId) throw invalid("calendarId", "Choose a calendar");
    const cal = await requireWritableCalendar(db, user, calendarId);
    const prefs = await preferences(db, user.email);
    const t: Resolved = {
        allDay: body.allDay,
        startDate: body.startDate,
        startTime: body.allDay ? null : (body.startTime ?? null),
        endDate: body.endDate,
        endTime: body.allDay ? null : (body.endTime ?? null),
        timeZone: body.timeZone ?? cal.time_zone ?? prefs.timeZone,
    };
    checkTimes(t);
    await checkResponsible(db, calendarId, body.people);
    const rrule = body.repeat ? toRRule(body.repeat, t.startDate, t.startTime) : null;
    const times = rowTimes(t, rrule);
    const { startAt, endAt } = instants(t.allDay, t.startDate, t.startTime, t.endDate, t.endTime, t.timeZone);
    const id = newId("cev");
    const now = nowIso();
    const reminders = [...new Set(body.reminders ?? (prefs.defaultReminderMinutes !== null ? [prefs.defaultReminderMinutes] : []))];
    const statements: D1PreparedStatement[] = [
        db
            .prepare(
                `INSERT INTO calendar_events (id, calendar_id, source, uid, title, description, location, url, all_day, start_date, start_time, end_date, end_time,
                    time_zone, start_at, end_at, rrule, series_end_at, category, color, visibility, show_as, status, people, client_id, created_by, created_at, updated_by, updated_at)
                 VALUES (?, ?, 'local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
                id,
                calendarId,
                `${id}@daly.id.au`,
                body.title,
                body.description ?? null,
                body.location ?? null,
                body.url ?? null,
                times.all_day,
                times.start_date,
                times.start_time,
                times.end_date,
                times.end_time,
                t.timeZone,
                startAt,
                endAt,
                rrule,
                seriesEndAt(times),
                body.category,
                body.color ?? null,
                body.visibility,
                body.showAs,
                body.status,
                body.people ? JSON.stringify(body.people) : null,
                body.clientId ?? null,
                user.email,
                now,
                user.email,
                now,
            ),
        ...reminders.map((m) =>
            db
                .prepare("INSERT INTO calendar_reminders (id, event_id, email, minutes_before, created_at) VALUES (?, ?, ?, ?, ?)")
                .bind(newId("crm"), id, user.email, m, now),
        ),
        activity(db, { actor: user.email, action: "event.create", entityType: "event", entityId: id, calendarId, via: options.via }),
    ];
    try {
        await db.batch(statements);
    } catch (error) {
        // Two retries racing with one client id: the unique index lets one win; return it.
        if (body.clientId && /UNIQUE/.test((error as Error).message)) {
            const earlier = await db
                .prepare("SELECT id FROM calendar_events WHERE created_by = ? AND client_id = ?")
                .bind(user.email, body.clientId)
                .first<{ id: string }>();
            if (earlier) return { event: await eventDetail(db, user, earlier.id), replayed: true };
        }
        throw error;
    }
    return { event: await eventDetail(db, user, id), replayed: false };
}

// --- Read ----------------------------------------------------------------------------------------

async function loadRow(db: D1Database, id: string): Promise<EventRow> {
    const row = await db.prepare(`SELECT ${EVENT_COLUMNS} FROM calendar_events e WHERE e.id = ?`).bind(id).first<EventRow>();
    if (!row) throw notFound();
    return row;
}

export async function eventDetail(db: D1Database, user: PortalUser, id: string): Promise<EventDetail> {
    const access = await requireEvent(db, user, id);
    const row = await loadRow(db, id);
    const [reminders, overrides] = await Promise.all([
        db
            .prepare("SELECT id, minutes_before FROM calendar_reminders WHERE event_id = ? AND email = ? ORDER BY minutes_before")
            .bind(id, user.email)
            .all<{ id: string; minutes_before: number }>(),
        db
            .prepare("SELECT occurrence_key, cancelled FROM calendar_event_overrides WHERE event_id = ? ORDER BY occurrence_key")
            .bind(id)
            .all<{ occurrence_key: string; cancelled: number }>(),
    ]);
    const repeat = row.rrule ? fromRRule(row.rrule, row.start_date) : null;
    return {
        id: row.id,
        calendarId: row.calendar_id,
        uid: row.uid,
        title: row.title,
        description: row.description,
        location: row.location,
        url: row.url,
        allDay: !!row.all_day,
        startDate: row.start_date,
        startTime: row.start_time,
        endDate: row.end_date,
        endTime: row.end_time,
        timeZone: row.time_zone,
        rrule: row.rrule,
        repeat,
        repeatLabel: row.rrule
            ? repeat
                ? describeRepeat(repeat, row.start_date, (d) => dayLabel(d))
                : "Custom repeat (from the calendar it came from)"
            : null,
        exdates: parseJson<string[]>(row.exdates, []),
        category: row.category,
        color: asColor(row.color),
        visibility: row.visibility,
        showAs: row.show_as,
        status: row.status,
        people: parseJson<EventPeople | null>(row.people, null),
        source: row.source,
        canEdit: access.calendar_source === "local" && row.source !== "subscription" && (access.role === "owner" || access.role === "editor"),
        reminders: reminders.results.map((r) => ({ id: r.id, minutesBefore: r.minutes_before })),
        overrides: overrides.results.map((o) => ({ key: o.occurrence_key, cancelled: !!o.cancelled })),
        createdBy: row.created_by,
        updatedAt: row.updated_at,
        version: row.version,
    };
}

// --- Update --------------------------------------------------------------------------------------

export class EventConflict extends HttpError {
    constructor(readonly current: EventDetail) {
        super(409, "conflict", "Someone changed this event since you opened it.");
    }
}

/** The event's times after applying a patch. */
function resolve(row: EventRow, f: Fields): Resolved {
    const allDay = f.allDay ?? !!row.all_day;
    return {
        allDay,
        startDate: f.startDate ?? row.start_date,
        startTime: allDay ? null : (f.startTime ?? row.start_time ?? "09:00"),
        endDate: f.endDate ?? row.end_date,
        endTime: allDay ? null : (f.endTime ?? row.end_time ?? "10:00"),
        timeZone: f.timeZone ?? row.time_zone,
    };
}

function contentSets(f: Fields): { sets: string[]; binds: unknown[] } {
    const sets: string[] = [];
    const binds: unknown[] = [];
    const set = (column: string, value: unknown) => (sets.push(`${column} = ?`), binds.push(value));
    if (f.title !== undefined) set("title", f.title);
    if (f.description !== undefined) set("description", f.description ?? null);
    if (f.location !== undefined) set("location", f.location ?? null);
    if (f.url !== undefined) set("url", f.url ?? null);
    if (f.category !== undefined) set("category", f.category);
    if (f.color !== undefined) set("color", f.color ?? null);
    if (f.visibility !== undefined) set("visibility", f.visibility);
    if (f.showAs !== undefined) set("show_as", f.showAs);
    if (f.status !== undefined) set("status", f.status);
    if (f.people !== undefined) set("people", f.people ? JSON.stringify(f.people) : null);
    return { sets, binds };
}

const timeSets = (t: Resolved, rrule: string | null, exdates: string | null) => {
    const times = { ...rowTimes(t, rrule), exdates };
    const { startAt, endAt } = instants(t.allDay, t.startDate, t.startTime, t.endDate, t.endTime, t.timeZone);
    return {
        sets: [
            "all_day = ?",
            "start_date = ?",
            "start_time = ?",
            "end_date = ?",
            "end_time = ?",
            "time_zone = ?",
            "start_at = ?",
            "end_at = ?",
            "rrule = ?",
            "series_end_at = ?",
        ],
        binds: [times.all_day, times.start_date, times.start_time, times.end_date, times.end_time, t.timeZone, startAt, endAt, rrule, seriesEndAt(times)],
    };
};

/** UNTIL just before an occurrence: the last moment the series' earlier part may start. */
function untilBefore(row: EventRow, key: string): string {
    const date = key.slice(0, 10);
    if (row.all_day) return addDays(date, -1).replaceAll("-", "");
    const before = addWallMinutes(date, key.slice(11), -1);
    return `${before.date.replaceAll("-", "")}T${before.time.replace(":", "")}00`;
}

const withoutEnd = (rrule: string) =>
    rrule
        .split(";")
        .filter((p) => !p.startsWith("UNTIL=") && !p.startsWith("COUNT="))
        .join(";");

export async function updateEvent(db: D1Database, user: PortalUser, id: string, input: unknown, via: "portal" | "mcp" = "portal"): Promise<EventDetail> {
    const access = await requireEditableEvent(db, user, id);
    const body = updateEventInput.parse(input);
    const row = await loadRow(db, id);
    if (row.version !== body.version) throw new EventConflict(await eventDetail(db, user, id));
    const { version, scope, occurrenceKey: key, calendarId, repeat, ...fields } = body;
    void version;
    if (fields.people) await checkResponsible(db, calendarId ?? row.calendar_id, fields.people);

    if (scope === "occurrence" || scope === "following") {
        if (!row.rrule) throw invalid("scope", "This event doesn't repeat");
        if (!key || !isSeriesOccurrence(row, key)) throw invalid("occurrenceKey", "That isn't one of this event's occurrences");
        if (calendarId && calendarId !== row.calendar_id) throw invalid("calendarId", "Move the whole series to another calendar, not one occurrence");
    }

    const now = nowIso();
    if (scope === "occurrence") {
        if (repeat !== undefined) throw invalid("repeat", "Change the repeat for the whole series");
        const t = resolve(row, {});
        const base = expand(row, [], {
            start: dayStart(addDays(key!.slice(0, 10), -1), row.time_zone),
            end: dayStart(addDays(key!.slice(0, 10), 2), row.time_zone),
        }).occurrences.find((o) => o.key === key);
        const existing = await db
            .prepare("SELECT fields FROM calendar_event_overrides WHERE event_id = ? AND occurrence_key = ?")
            .bind(id, key)
            .first<{ fields: string }>();
        const merged: OverrideFields = { ...parseJson<OverrideFields>(existing?.fields ?? null, {}) };
        if (fields.title !== undefined) merged.title = fields.title;
        if (fields.description !== undefined) merged.description = fields.description ?? null;
        if (fields.location !== undefined) merged.location = fields.location ?? null;
        if (fields.status !== undefined) merged.status = fields.status;
        for (const k of ["allDay", "startDate", "startTime", "endDate", "endTime"] as const)
            if (fields[k] !== undefined) (merged as Record<string, unknown>)[k] = fields[k];
        const allDay = merged.allDay ?? t.allDay;
        const moved: Resolved = {
            allDay,
            startDate: merged.startDate ?? base?.startDate ?? key!.slice(0, 10),
            startTime: allDay ? null : (merged.startTime ?? base?.startTime ?? t.startTime),
            endDate: merged.endDate ?? base?.endDate ?? key!.slice(0, 10),
            endTime: allDay ? null : (merged.endTime ?? base?.endTime ?? t.endTime),
            timeZone: row.time_zone,
        };
        checkTimes(moved);
        const { startAt, endAt } = instants(moved.allDay, moved.startDate, moved.startTime, moved.endDate, moved.endTime, moved.timeZone);
        await db.batch([
            db
                .prepare(
                    `INSERT INTO calendar_event_overrides (event_id, occurrence_key, cancelled, fields, start_at, end_at, updated_by, updated_at) VALUES (?, ?, 0, ?, ?, ?, ?, ?)
                     ON CONFLICT (event_id, occurrence_key) DO UPDATE SET cancelled = 0, fields = excluded.fields, start_at = excluded.start_at, end_at = excluded.end_at,
                        updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
                )
                .bind(id, key, JSON.stringify(merged), startAt, endAt, user.email, now),
            db.prepare("UPDATE calendar_events SET version = version + 1, updated_by = ?, updated_at = ? WHERE id = ?").bind(user.email, now, id),
            activity(db, { actor: user.email, action: "event.occurrence.update", entityType: "event", entityId: id, calendarId: row.calendar_id, via }),
        ]);
        return eventDetail(db, user, id);
    }

    if (scope === "following") {
        // End the original series just before this occurrence and start a new one there with the changes.
        const remaining = /COUNT=(\d+)/.exec(row.rrule!);
        const before = occurrencesBefore(row, key!);
        if (before === 0) return updateEvent(db, user, id, { ...body, scope: "series", occurrenceKey: undefined }, via);
        const originalRule = remaining ? row.rrule!.replace(/COUNT=\d+/, `COUNT=${before}`) : `${withoutEnd(row.rrule!)};UNTIL=${untilBefore(row, key!)}`;
        const startDate = fields.startDate ?? key!.slice(0, 10);
        const shift = Math.round((Date.parse(`${startDate}T00:00:00Z`) - Date.parse(`${row.start_date}T00:00:00Z`)) / 86_400_000);
        const t = resolve(row, {
            ...fields,
            startDate,
            startTime: fields.startTime ?? (row.all_day ? null : key!.slice(11)),
            endDate: fields.endDate ?? addDays(row.end_date, shift),
        });
        checkTimes(t);
        let newRule: string | null;
        if (repeat === null) newRule = null;
        else if (repeat) newRule = toRRule(repeat, t.startDate, t.startTime);
        else newRule = remaining ? row.rrule!.replace(/COUNT=\d+/, `COUNT=${Math.max(1, Number(remaining[1]) - before)}`) : row.rrule;
        const firstTimes = { ...row, rrule: originalRule };
        const nextId = newId("cev");
        const next = rowTimes(t, newRule);
        const { startAt, endAt } = instants(t.allDay, t.startDate, t.startTime, t.endDate, t.endTime, t.timeZone);
        await db.batch([
            db
                .prepare("UPDATE calendar_events SET rrule = ?, series_end_at = ?, version = version + 1, updated_by = ?, updated_at = ? WHERE id = ?")
                .bind(originalRule, seriesEndAt(firstTimes), user.email, now, id),
            // Single-occurrence edits from this point on belong to the new series' dates now; drop them.
            db.prepare("DELETE FROM calendar_event_overrides WHERE event_id = ? AND occurrence_key >= ?").bind(id, key),
            db
                .prepare(
                    `INSERT INTO calendar_events (id, calendar_id, source, uid, title, description, location, url, all_day, start_date, start_time, end_date, end_time,
                        time_zone, start_at, end_at, rrule, series_end_at, category, color, visibility, show_as, status, people, created_by, created_at, updated_by, updated_at)
                     VALUES (?, ?, 'local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                )
                .bind(
                    nextId,
                    row.calendar_id,
                    `${nextId}@daly.id.au`,
                    fields.title ?? row.title,
                    fields.description !== undefined ? (fields.description ?? null) : row.description,
                    fields.location !== undefined ? (fields.location ?? null) : row.location,
                    fields.url !== undefined ? (fields.url ?? null) : row.url,
                    next.all_day,
                    next.start_date,
                    next.start_time,
                    next.end_date,
                    next.end_time,
                    t.timeZone,
                    startAt,
                    endAt,
                    newRule,
                    seriesEndAt(next),
                    fields.category ?? row.category,
                    fields.color !== undefined ? (fields.color ?? null) : row.color,
                    fields.visibility ?? row.visibility,
                    fields.showAs ?? row.show_as,
                    fields.status ?? (row.status === "cancelled" ? "confirmed" : row.status),
                    fields.people !== undefined ? (fields.people ? JSON.stringify(fields.people) : null) : row.people,
                    row.created_by,
                    now,
                    user.email,
                    now,
                ),
            // Everyone's reminders follow the series.
            db
                .prepare(
                    "INSERT INTO calendar_reminders (id, event_id, email, minutes_before, created_at) SELECT 'crm_' || lower(hex(randomblob(7))), ?, email, minutes_before, ? FROM calendar_reminders WHERE event_id = ?",
                )
                .bind(nextId, now, id),
            activity(db, { actor: user.email, action: "event.split", entityType: "event", entityId: nextId, calendarId: row.calendar_id, via }),
        ]);
        return eventDetail(db, user, nextId);
    }

    // The whole series.
    if (calendarId && calendarId !== row.calendar_id) {
        await requireWritableCalendar(db, user, calendarId);
        if (fields.people?.responsible ?? parseJson<EventPeople | null>(row.people, null)?.responsible)
            await checkResponsible(db, calendarId, fields.people ?? parseJson<EventPeople | null>(row.people, null));
    }
    const timeChanged =
        ["allDay", "startDate", "startTime", "endDate", "endTime", "timeZone"].some((k) => (fields as Record<string, unknown>)[k] !== undefined) ||
        repeat !== undefined;
    const { sets, binds } = contentSets(fields);
    if (calendarId && calendarId !== row.calendar_id) (sets.push("calendar_id = ?"), binds.push(calendarId));
    const extra: D1PreparedStatement[] = [];
    if (timeChanged) {
        const t = resolve(row, fields);
        checkTimes(t);
        const rule = repeat === undefined ? row.rrule : repeat === null ? null : toRRule(repeat, t.startDate, t.startTime);
        // Moving the series start or changing its rule makes old occurrence edits and exclusions meaningless.
        const reshaped = rule !== row.rrule || t.startDate !== row.start_date || t.startTime !== row.start_time || t.timeZone !== row.time_zone;
        const ts = timeSets(t, rule, reshaped ? null : row.exdates);
        sets.push(...ts.sets, "exdates = ?");
        binds.push(...ts.binds, reshaped ? null : row.exdates);
        if (reshaped) extra.push(db.prepare("DELETE FROM calendar_event_overrides WHERE event_id = ?").bind(id));
    }
    const [result] = await db.batch([
        db
            .prepare(
                `UPDATE calendar_events SET ${[...sets, "version = version + 1", "updated_by = ?", "updated_at = ?"].join(", ")} WHERE id = ? AND version = ?`,
            )
            .bind(...binds, user.email, now, id, body.version),
        ...extra,
        activity(db, { actor: user.email, action: "event.update", entityType: "event", entityId: id, calendarId: calendarId ?? access.calendar_id, via }),
    ]);
    if (!result.meta.changes) throw new EventConflict(await eventDetail(db, user, id));
    return eventDetail(db, user, id);
}

// --- Delete --------------------------------------------------------------------------------------

const deleteInput = z
    .object({
        scope: z.enum(["series", "occurrence", "following"]).default("series"),
        occurrenceKey: z.string().refine(isOccurrenceKey).optional(),
    })
    .strict();

export async function deleteEvent(db: D1Database, user: PortalUser, id: string, input: unknown): Promise<{ deleted: "series" | "occurrence" | "following" }> {
    const access = await requireEditableEvent(db, user, id);
    const body = deleteInput.parse(input ?? {});
    const row = await loadRow(db, id);
    const now = nowIso();
    if (body.scope !== "series") {
        if (!row.rrule || !body.occurrenceKey || !isSeriesOccurrence(row, body.occurrenceKey))
            throw invalid("occurrenceKey", "That isn't one of this event's occurrences");
        if (body.scope === "following" && occurrencesBefore(row, body.occurrenceKey) === 0) return deleteEvent(db, user, id, { scope: "series" });
    }
    if (body.scope === "occurrence") {
        const exdates = [...new Set([...parseJson<string[]>(row.exdates, []), body.occurrenceKey!])].sort();
        await db.batch([
            db
                .prepare("UPDATE calendar_events SET exdates = ?, version = version + 1, updated_by = ?, updated_at = ? WHERE id = ?")
                .bind(JSON.stringify(exdates), user.email, now, id),
            db.prepare("DELETE FROM calendar_event_overrides WHERE event_id = ? AND occurrence_key = ?").bind(id, body.occurrenceKey),
            activity(db, { actor: user.email, action: "event.occurrence.delete", entityType: "event", entityId: id, calendarId: access.calendar_id }),
        ]);
        return { deleted: "occurrence" };
    }
    if (body.scope === "following") {
        const remaining = /COUNT=(\d+)/.exec(row.rrule!);
        const before = occurrencesBefore(row, body.occurrenceKey!);
        const rule = remaining
            ? row.rrule!.replace(/COUNT=\d+/, `COUNT=${before}`)
            : `${withoutEnd(row.rrule!)};UNTIL=${untilBefore(row, body.occurrenceKey!)}`;
        await db.batch([
            db
                .prepare("UPDATE calendar_events SET rrule = ?, series_end_at = ?, version = version + 1, updated_by = ?, updated_at = ? WHERE id = ?")
                .bind(rule, seriesEndAt({ ...row, rrule: rule }), user.email, now, id),
            db.prepare("DELETE FROM calendar_event_overrides WHERE event_id = ? AND occurrence_key >= ?").bind(id, body.occurrenceKey),
            activity(db, { actor: user.email, action: "event.following.delete", entityType: "event", entityId: id, calendarId: access.calendar_id }),
        ]);
        return { deleted: "following" };
    }
    await db.batch([
        db.prepare("DELETE FROM calendar_events WHERE id = ?").bind(id),
        activity(db, { actor: user.email, action: "event.delete", entityType: "event", entityId: id, calendarId: access.calendar_id }),
    ]);
    return { deleted: "series" };
}

/** Puts back an occurrence removed on its own (undo). */
export async function restoreOccurrence(db: D1Database, user: PortalUser, id: string, key: string): Promise<EventDetail> {
    const access = await requireEditableEvent(db, user, id);
    const row = await loadRow(db, id);
    const exdates = parseJson<string[]>(row.exdates, []).filter((k) => k !== key);
    await db.batch([
        db
            .prepare("UPDATE calendar_events SET exdates = ?, version = version + 1, updated_by = ?, updated_at = ? WHERE id = ?")
            .bind(exdates.length ? JSON.stringify(exdates) : null, user.email, nowIso(), id),
        activity(db, { actor: user.email, action: "event.occurrence.restore", entityType: "event", entityId: id, calendarId: access.calendar_id }),
    ]);
    return eventDetail(db, user, id);
}

// --- Reminders -----------------------------------------------------------------------------------

const remindersInput = z.object({ minutes: z.array(z.number().int().min(0).max(40320)).max(LIMITS.remindersPerEvent) }).strict();

/** Replaces the caller's own reminders on an event. Anyone who can open the event can remind themselves of it. */
export async function setReminders(db: D1Database, user: PortalUser, id: string, input: unknown): Promise<EventDetail> {
    await requireEvent(db, user, id);
    const { minutes } = remindersInput.parse(input);
    const now = nowIso();
    await db.batch([
        db.prepare("DELETE FROM calendar_reminders WHERE event_id = ? AND email = ?").bind(id, user.email),
        ...[...new Set(minutes)].map((m) =>
            db
                .prepare("INSERT INTO calendar_reminders (id, event_id, email, minutes_before, created_at) VALUES (?, ?, ?, ?, ?)")
                .bind(newId("crm"), id, user.email, m, now),
        ),
        // Notifications not yet shown for this event are regenerated from the new reminders.
        db.prepare("DELETE FROM calendar_notifications WHERE email = ? AND kind = 'event' AND ref_id = ? AND fire_at > ?").bind(user.email, id, now),
    ]);
    return eventDetail(db, user, id);
}

// --- Occurrences in a window ---------------------------------------------------------------------

export interface WindowOptions {
    /** Local dates (inclusive) in the viewer's zone. */
    from: string;
    to: string;
    timeZone: string;
    calendarIds?: string[] | null;
    includeHidden?: boolean;
    limit?: number;
}

/** What one occurrence looks like to this person: everything, or only "Busy". */
function present(row: VisibleRow, occ: ReturnType<typeof expand>["occurrences"][number], user: PortalUser, timeZone: string): EventOccurrence {
    const busyOnly = row.role === "freebusy" || (row.visibility !== "default" && row.created_by !== user.email);
    const fields = occ.fields ?? {};
    const color = asColor(row.color) ?? asColor(row.member_color) ?? asColor(row.calendar_color) ?? "brand";
    let startDate = occ.startDate;
    let endDate = occ.endDate;
    let startTime: string | null = null;
    let endTime: string | null = null;
    let start = occ.startAt;
    let end = occ.endAt;
    if (occ.allDay) {
        start = dayStart(startDate, timeZone);
        end = dayStart(addDays(endDate, 1), timeZone);
    } else {
        const s = wallClock(occ.startAt, timeZone);
        const e = wallClock(occ.endAt, timeZone);
        [startDate, startTime] = [s.date, s.time];
        // An event ending at midnight ends on the day before, as people read it.
        [endDate, endTime] = e.time === "00:00" && occ.endAt > occ.startAt ? [addDays(e.date, -1), "24:00"] : [e.date, e.time];
    }
    return {
        id: `${row.id}:${occ.key}`,
        eventId: row.id,
        calendarId: row.calendar_id,
        key: occ.key,
        title: busyOnly ? "Busy" : (fields.title ?? row.title) || "Untitled",
        allDay: occ.allDay,
        start,
        end,
        startDate,
        endDate,
        startTime,
        endTime: endTime === "24:00" ? "23:59" : endTime,
        eventTimeZone: row.time_zone !== timeZone && !occ.allDay ? row.time_zone : null,
        location: busyOnly ? null : fields.location !== undefined ? fields.location : row.location,
        category: busyOnly ? "general" : row.category,
        color: busyOnly ? "gray" : color,
        visibility: row.visibility,
        showAs: row.show_as,
        status: fields.status ?? row.status,
        recurring: !!row.rrule,
        overridden: occ.overridden,
        readOnly: row.calendar_source === "subscription" || row.source === "subscription" || !(row.role === "owner" || row.role === "editor") || busyOnly,
        busyOnly,
        source: row.source,
        people: busyOnly ? null : parseJson<EventPeople | null>(row.people, null),
    };
}

/** Every occurrence the caller can see between two local dates, in their time zone, sorted. */
export async function occurrencesInWindow(
    db: D1Database,
    user: PortalUser,
    options: WindowOptions,
): Promise<{ occurrences: EventOccurrence[]; truncated: boolean }> {
    const limit = options.limit ?? LIMITS.occurrencesPerWindow;
    // Floating all-day events: look a day either side, then filter on dates exactly.
    const wide: Window = { start: dayStart(addDays(options.from, -1), options.timeZone), end: dayStart(addDays(options.to, 2), options.timeZone) };
    const exact: Window = { start: dayStart(options.from, options.timeZone), end: dayStart(addDays(options.to, 1), options.timeZone) };
    const where = ["e.start_at < ?", "e.series_end_at > ?", "e.status <> 'cancelled'"];
    const binds: unknown[] = [user.email, wide.end, wide.start];
    if (!options.includeHidden) where.push("m.hidden = 0");
    if (options.calendarIds?.length) (where.push("e.calendar_id IN (SELECT value FROM json_each(?))"), binds.push(JSON.stringify(options.calendarIds)));
    const select = `SELECT ${EVENT_COLUMNS}, m.role, m.color AS member_color, c.color AS calendar_color, c.source AS calendar_source
         FROM calendar_events e JOIN calendar_members m ON m.calendar_id = e.calendar_id AND m.email = ? JOIN calendars c ON c.id = e.calendar_id`;
    const rows = (
        await db
            .prepare(`${select} WHERE ${where.join(" AND ")} LIMIT 5000`)
            .bind(...binds)
            .all<VisibleRow>()
    ).results;
    // Series whose single moved occurrence lands in the window although the series row doesn't.
    const known = new Set(rows.map((r) => r.id));
    const moved = await db
        .prepare(
            `SELECT DISTINCT o.event_id FROM calendar_event_overrides o JOIN calendar_members m ON m.email = ? JOIN calendar_events e ON e.id = o.event_id AND e.calendar_id = m.calendar_id
             WHERE o.start_at < ? AND o.end_at > ? ${options.includeHidden ? "" : "AND m.hidden = 0"} LIMIT 200`,
        )
        .bind(user.email, wide.end, wide.start)
        .all<{ event_id: string }>();
    const missing = moved.results.map((r) => r.event_id).filter((id) => !known.has(id));
    if (missing.length) {
        const extra = await db
            .prepare(`${select} WHERE e.id IN (SELECT value FROM json_each(?)) AND e.status <> 'cancelled'`)
            .bind(user.email, JSON.stringify(missing))
            .all<VisibleRow>();
        rows.push(...extra.results.filter((r) => !options.calendarIds?.length || options.calendarIds.includes(r.calendar_id)));
    }
    const overrides = new Map<string, OverrideRow[]>();
    for (const part of chunk(
        rows.filter((r) => r.rrule).map((r) => r.id),
        90,
    )) {
        const found = await db
            .prepare(
                "SELECT event_id, occurrence_key, cancelled, fields, start_at, end_at FROM calendar_event_overrides WHERE event_id IN (SELECT value FROM json_each(?))",
            )
            .bind(JSON.stringify(part))
            .all<OverrideRow>();
        for (const o of found.results) overrides.set(o.event_id, [...(overrides.get(o.event_id) ?? []), o]);
    }
    const out: EventOccurrence[] = [];
    let truncated = false;
    for (const row of rows) {
        const result = expand(row, overrides.get(row.id) ?? [], wide, limit);
        truncated ||= result.truncated;
        for (const occ of result.occurrences) {
            const visible = occ.allDay ? occ.endDate >= options.from && occ.startDate <= options.to : occ.startAt < exact.end && occ.endAt > exact.start;
            if (visible) out.push(present(row, occ, user, options.timeZone));
        }
    }
    out.sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
    if (out.length > limit) return { occurrences: out.slice(0, limit), truncated: true };
    return { occurrences: out, truncated: truncated || rows.length >= 5000 };
}

/**
 * Searches titles and places in the caller's calendars (never other people's private events or
 * free/busy calendars). Each match is shown at its next occurrence from `today`, or its last one.
 */
export async function searchEvents(db: D1Database, user: PortalUser, query: string, timeZone: string, today: string, limit = 50): Promise<EventOccurrence[]> {
    const words = query
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 6)
        .map((w) => `%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    if (!words.length) return [];
    const rows = await db
        .prepare(
            `SELECT ${EVENT_COLUMNS}, m.role, m.color AS member_color, c.color AS calendar_color, c.source AS calendar_source
             FROM calendar_events e JOIN calendar_members m ON m.calendar_id = e.calendar_id AND m.email = ? JOIN calendars c ON c.id = e.calendar_id
             WHERE m.role <> 'freebusy' AND e.status <> 'cancelled' AND (e.visibility = 'default' OR e.created_by = ?)
               AND ${words.map(() => "(e.title LIKE ? ESCAPE '\\' OR coalesce(e.location, '') LIKE ? ESCAPE '\\')").join(" AND ")}
             ORDER BY e.start_at DESC LIMIT ?`,
        )
        .bind(user.email, user.email, ...words.flatMap((w) => [w, w]), limit)
        .all<VisibleRow>();
    const ahead: Window = { start: dayStart(today, timeZone), end: dayStart(addDays(today, 400), timeZone) };
    return rows.results.map((row) => {
        const next = row.rrule ? expand(row, [], ahead, 1).occurrences[0] : undefined;
        const first = next ?? {
            key: occurrenceKey(row.start_date, row.all_day ? null : row.start_time),
            allDay: !!row.all_day,
            startDate: row.start_date,
            startTime: row.start_time,
            endDate: row.end_date,
            endTime: row.end_time,
            startAt: row.start_at,
            endAt: row.end_at,
            overridden: false,
            fields: null,
        };
        return present(row, first, user, timeZone);
    });
}
