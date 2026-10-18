// Who may see what in Daly Calendar.
//
// Portal roles decide whether someone may open Calendar at all ("calendar.use"). Inside it, every
// calendar, event, subscription and reminder is reached only through the caller's own
// calendar_members row: a calendar you aren't a member of doesn't exist as far as the API is
// concerned (404, never 403, so ids can't be probed). Being a portal owner grants nothing here.
//
// Free/busy members see only that time is busy. Private and sensitive events show their details to
// the person who created them; everyone else sees "Busy". Leave is always the person's own, apart
// from the dates someone explicitly shares (leave_shares).
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { localDate } from "../../src/shared/calendar/time";
import { type CalendarPreferences, type CalendarRole, DEFAULT_PREFERENCES, calendarPreferences, roleAtLeast } from "../../src/shared/calendar/types";
import { isRole, permissionsFor } from "../../src/shared/portal/permissions";
import type { PortalUser } from "../../src/shared/portal/types";
import type { Env } from "../env";
import { ownerEmails } from "../portal/auth";
import { newId, nowIso, parseJson } from "../portal/db";
import { HttpError } from "../portal/http";

export const notFound = () => new HttpError(404, "not_found", "Not found");

export const refuse = (minimum: CalendarRole) =>
    new HttpError(
        403,
        "forbidden",
        minimum === "owner"
            ? "Only the calendar's owners can do that"
            : minimum === "editor"
              ? "You can only view this calendar"
              : "You can only see free/busy times on this calendar",
    );

export interface CalendarAccessRow {
    id: string;
    name: string;
    kind: "personal" | "shared";
    source: "local" | "subscription";
    purpose: string;
    owner_email: string;
    time_zone: string;
    is_default: number;
    version: number;
    role: CalendarRole;
}

const ACCESS_COLUMNS = "c.id, c.name, c.kind, c.source, c.purpose, c.owner_email, c.time_zone, c.is_default, c.version, m.role";

/** The calendar, if the caller is a member with at least `minimum`. Non-members get 404. */
export async function requireCalendar(db: D1Database, user: PortalUser, calendarId: string, minimum: CalendarRole = "viewer"): Promise<CalendarAccessRow> {
    const row = await db
        .prepare(`SELECT ${ACCESS_COLUMNS} FROM calendars c JOIN calendar_members m ON m.calendar_id = c.id AND m.email = ? WHERE c.id = ?`)
        .bind(user.email, calendarId)
        .first<CalendarAccessRow>();
    if (!row) throw notFound();
    if (!roleAtLeast(row.role, minimum)) throw refuse(minimum);
    return row;
}

/** A calendar people can add events to: a local one, as an editor or owner. */
export async function requireWritableCalendar(db: D1Database, user: PortalUser, calendarId: string): Promise<CalendarAccessRow> {
    const row = await requireCalendar(db, user, calendarId, "freebusy");
    if (row.source === "subscription") throw new HttpError(422, "read_only", "Subscribed calendars are read-only. Change the event in its own calendar app.");
    if (!roleAtLeast(row.role, "editor")) throw refuse("editor");
    return row;
}

export interface EventAccessRow {
    id: string;
    calendar_id: string;
    source: "local" | "subscription" | "import";
    visibility: "default" | "private" | "sensitive";
    created_by: string;
    version: number;
    role: CalendarRole;
    calendar_source: "local" | "subscription";
}

/** An event the caller may act on. Free/busy members and non-members get 404 (they can't open an event). */
export async function requireEvent(db: D1Database, user: PortalUser, eventId: string, minimum: CalendarRole = "viewer"): Promise<EventAccessRow> {
    const row = await db
        .prepare(
            `SELECT e.id, e.calendar_id, e.source, e.visibility, e.created_by, e.version, m.role, c.source AS calendar_source
             FROM calendar_events e JOIN calendar_members m ON m.calendar_id = e.calendar_id AND m.email = ? JOIN calendars c ON c.id = e.calendar_id
             WHERE e.id = ?`,
        )
        .bind(user.email, eventId)
        .first<EventAccessRow>();
    if (!row || row.role === "freebusy") throw notFound();
    // Someone else's private event is "Busy" to everyone else: it can't be opened, only seen as busy.
    if (row.visibility !== "default" && row.created_by !== user.email) throw notFound();
    if (!roleAtLeast(row.role, minimum)) throw refuse(minimum);
    return row;
}

/** An event the caller may change: local, in a calendar they edit. */
export async function requireEditableEvent(db: D1Database, user: PortalUser, eventId: string): Promise<EventAccessRow> {
    const row = await requireEvent(db, user, eventId);
    if (row.calendar_source === "subscription" || row.source === "subscription")
        throw new HttpError(422, "read_only", "Subscribed events are read-only. Change them in their own calendar app.");
    if (!roleAtLeast(row.role, "editor")) throw refuse("editor");
    return row;
}

/** Only people who can already open Calendar in the portal can be given a calendar or see shared leave. */
export async function canUseCalendar(env: Env, db: D1Database, email: string) {
    if (ownerEmails(env).has(email)) return true;
    const row = await db.prepare("SELECT role, active FROM portal_users WHERE email = ?").bind(email).first<{ role: string; active: number }>();
    return !!row?.active && isRole(row.role) && permissionsFor(row.role).includes("calendar.use");
}

// --- Preferences ---------------------------------------------------------------------------------

export async function preferences(db: D1Database, email: string): Promise<CalendarPreferences> {
    const row = await db.prepare("SELECT value FROM calendar_preferences WHERE email = ?").bind(email).first<{ value: string }>();
    if (!row) return DEFAULT_PREFERENCES;
    // A stored document that no longer validates (an older shape) falls back field by field to the defaults.
    const parsed = calendarPreferences.safeParse({ ...DEFAULT_PREFERENCES, ...parseJson<Record<string, unknown>>(row.value, {}) });
    return parsed.success ? parsed.data : DEFAULT_PREFERENCES;
}

export const todayFor = async (db: D1Database, email: string) => localDate(new Date(), (await preferences(db, email)).timeZone);

// --- History -------------------------------------------------------------------------------------

export interface ActivityInput {
    actor: string;
    action: string;
    entityType: string;
    entityId?: string | null;
    calendarId?: string | null;
    via?: "portal" | "mcp" | "system";
}

/** History without any content: who did what to which record. */
export const activity = (db: D1Database, entry: ActivityInput): D1PreparedStatement =>
    db
        .prepare("INSERT INTO calendar_activity (at, actor, action, entity_type, entity_id, calendar_id, via) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(nowIso(), entry.actor, entry.action, entry.entityType, entry.entityId ?? null, entry.calendarId ?? null, entry.via ?? "portal");

// --- The default calendar ------------------------------------------------------------------------

/**
 * The caller's own default calendar, created on first use. Safe to call concurrently: the unique
 * index on (owner_email) WHERE is_default lets only one insert win, and the membership is written
 * only for the calendar that was actually created.
 */
export async function ensureDefaultCalendar(db: D1Database, user: PortalUser, timeZone?: string): Promise<string> {
    const existing = await db.prepare("SELECT id FROM calendars WHERE owner_email = ? AND is_default = 1").bind(user.email).first<{ id: string }>();
    if (existing) return existing.id;
    const id = newId("cal");
    const now = nowIso();
    const zone = timeZone ?? (await preferences(db, user.email)).timeZone;
    const ifCreated = "WHERE EXISTS (SELECT 1 FROM calendars WHERE id = ?)";
    await db.batch([
        db
            .prepare(
                `INSERT INTO calendars (id, name, color, kind, purpose, source, time_zone, owner_email, is_default, created_by, created_at, updated_by, updated_at)
                 VALUES (?, 'My calendar', 'brand', 'personal', 'general', 'local', ?, ?, 1, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
            )
            .bind(id, zone, user.email, user.email, now, user.email, now),
        db
            .prepare(
                `INSERT INTO calendar_members (calendar_id, email, role, position, added_by, created_at, updated_at) SELECT ?, ?, 'owner', 0, ?, ?, ? ${ifCreated}`,
            )
            .bind(id, user.email, user.email, now, now, id),
    ]);
    const row = await db.prepare("SELECT id FROM calendars WHERE owner_email = ? AND is_default = 1").bind(user.email).first<{ id: string }>();
    if (!row) throw new Error("Default calendar could not be created");
    return row.id;
}
