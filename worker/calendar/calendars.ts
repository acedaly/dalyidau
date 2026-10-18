// Calendars, their members, and each person's own colour and show/hide for them.
import type { D1Database } from "@cloudflare/workers-types";
import { z } from "zod";
import { isTimeZone } from "../../src/shared/calendar/time";
import {
    CALENDAR_COLORS,
    CALENDAR_PURPOSES,
    type CalendarColor,
    type CalendarInfo,
    type CalendarMember,
    type CalendarPerson,
    type CalendarRole,
    LIMITS,
} from "../../src/shared/calendar/types";
import type { PortalUser } from "../../src/shared/portal/types";
import type { Env } from "../env";
import { ownerEmails } from "../portal/auth";
import { newId, nowIso } from "../portal/db";
import { HttpError } from "../portal/http";
import { activity, canUseCalendar, ensureDefaultCalendar, notFound, preferences, requireCalendar } from "./access";

interface CalendarRow {
    id: string;
    name: string;
    description: string | null;
    color: string;
    member_color: string | null;
    kind: "personal" | "shared";
    purpose: CalendarInfo["purpose"];
    source: "local" | "subscription";
    time_zone: string;
    is_default: number;
    owner_email: string;
    role: CalendarRole;
    hidden: number;
    member_count: number;
    subscription_id: string | null;
    version: number;
}

const asColor = (value: string | null | undefined, fallback: CalendarColor = "brand"): CalendarColor =>
    (CALENDAR_COLORS as readonly string[]).includes(value ?? "") ? (value as CalendarColor) : fallback;

const toInfo = (r: CalendarRow): CalendarInfo => ({
    id: r.id,
    name: r.name,
    description: r.description,
    color: asColor(r.member_color ?? r.color),
    kind: r.kind,
    purpose: r.purpose,
    source: r.source,
    timeZone: r.time_zone,
    isDefault: !!r.is_default,
    role: r.role,
    hidden: !!r.hidden,
    ownerEmail: r.owner_email,
    memberCount: r.member_count,
    subscriptionId: r.subscription_id,
    version: r.version,
});

/** Every calendar the caller belongs to, their default first. Creates the default calendar on first use. */
export async function listCalendars(db: D1Database, user: PortalUser): Promise<CalendarInfo[]> {
    await ensureDefaultCalendar(db, user);
    const rows = await db
        .prepare(
            `SELECT c.id, c.name, c.description, c.color, m.color AS member_color, c.kind, c.purpose, c.source, c.time_zone, c.is_default, c.owner_email,
                    m.role, m.hidden, c.version,
                    (SELECT COUNT(*) FROM calendar_members x WHERE x.calendar_id = c.id) AS member_count,
                    (SELECT s.id FROM calendar_subscriptions s WHERE s.calendar_id = c.id) AS subscription_id
             FROM calendars c JOIN calendar_members m ON m.calendar_id = c.id AND m.email = ?
             ORDER BY c.is_default DESC, c.source, m.position, c.name COLLATE NOCASE`,
        )
        .bind(user.email)
        .all<CalendarRow>();
    return rows.results.map(toInfo);
}

const plainText = (max: number) =>
    z
        .string()
        // eslint-disable-next-line no-control-regex
        .transform((v) => v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim())
        .pipe(z.string().max(max));

const calendarInput = z
    .object({
        name: plainText(LIMITS.calendarName).pipe(z.string().min(1, "Give the calendar a name")),
        description: plainText(1000).nullish(),
        color: z.enum(CALENDAR_COLORS).default("brand"),
        kind: z.enum(["personal", "shared"]).default("personal"),
        purpose: z
            .enum(CALENDAR_PURPOSES)
            .refine((p) => p !== "subscription", "Add a subscription from the Subscriptions page")
            .default("general"),
        timeZone: z.string().max(64).refine(isTimeZone, "Choose a valid time zone").optional(),
    })
    .strict();

export async function createCalendar(db: D1Database, user: PortalUser, input: unknown): Promise<CalendarInfo> {
    const body = calendarInput.parse(input);
    const count = await db.prepare("SELECT COUNT(*) AS n FROM calendars WHERE owner_email = ?").bind(user.email).first<{ n: number }>();
    if ((count?.n ?? 0) >= LIMITS.calendarsPerPerson) throw new HttpError(422, "limit", `You can own up to ${LIMITS.calendarsPerPerson} calendars`);
    const id = newId("cal");
    const now = nowIso();
    const zone = body.timeZone ?? (await preferences(db, user.email)).timeZone;
    await db.batch([
        db
            .prepare(
                `INSERT INTO calendars (id, name, description, color, kind, purpose, source, time_zone, owner_email, created_by, created_at, updated_by, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, 'local', ?, ?, ?, ?, ?, ?)`,
            )
            .bind(id, body.name, body.description ?? null, body.color, body.kind, body.purpose, zone, user.email, user.email, now, user.email, now),
        db
            .prepare("INSERT INTO calendar_members (calendar_id, email, role, position, added_by, created_at, updated_at) VALUES (?, ?, 'owner', 100, ?, ?, ?)")
            .bind(id, user.email, user.email, now, now),
        activity(db, { actor: user.email, action: "calendar.create", entityType: "calendar", entityId: id, calendarId: id }),
    ]);
    return (await listCalendars(db, user)).find((c) => c.id === id)!;
}

const calendarPatch = z
    .object({
        version: z.number().int().min(1),
        name: plainText(LIMITS.calendarName).pipe(z.string().min(1, "Give the calendar a name")).optional(),
        description: plainText(1000).nullish(),
        color: z.enum(CALENDAR_COLORS).optional(),
        kind: z.enum(["personal", "shared"]).optional(),
        purpose: z
            .enum(CALENDAR_PURPOSES)
            .refine((p) => p !== "subscription")
            .optional(),
        timeZone: z.string().max(64).refine(isTimeZone, "Choose a valid time zone").optional(),
    })
    .strict();

/** Owners change a calendar's details; anyone changes their own colour and show/hide (updatePersonal). */
export async function updateCalendar(db: D1Database, user: PortalUser, calendarId: string, input: unknown): Promise<CalendarInfo> {
    const cal = await requireCalendar(db, user, calendarId, "owner");
    const body = calendarPatch.parse(input);
    if (cal.source === "subscription" && (body.kind || body.purpose || body.timeZone))
        throw new HttpError(422, "read_only", "Change a subscription's sharing from the Subscriptions page");
    if (cal.is_default && body.kind === "shared")
        throw new HttpError(422, "default_personal", "Your default calendar stays personal. Create a shared calendar instead.");
    const sets: string[] = [];
    const binds: unknown[] = [];
    const set = (column: string, value: unknown) => (sets.push(`${column} = ?`), binds.push(value));
    if (body.name !== undefined) set("name", body.name);
    if (body.description !== undefined) set("description", body.description ?? null);
    if (body.color !== undefined) set("color", body.color);
    if (body.kind !== undefined) set("kind", body.kind);
    if (body.purpose !== undefined) set("purpose", body.purpose);
    if (body.timeZone !== undefined) set("time_zone", body.timeZone);
    const now = nowIso();
    let result;
    try {
        [result] = await db.batch([
            db
                .prepare(
                    `UPDATE calendars SET ${[...sets, "version = version + 1", "updated_by = ?", "updated_at = ?"].join(", ")} WHERE id = ? AND version = ?`,
                )
                .bind(...binds, user.email, now, calendarId, body.version),
            activity(db, { actor: user.email, action: "calendar.update", entityType: "calendar", entityId: calendarId, calendarId }),
        ]);
    } catch (error) {
        if (/personal/.test((error as Error).message))
            throw new HttpError(422, "members", "Remove other members (or make them free/busy) before making it personal");
        throw error;
    }
    if (!result.meta.changes) throw new HttpError(409, "conflict", "Someone changed this calendar. Reload and try again.");
    return (await listCalendars(db, user)).find((c) => c.id === calendarId)!;
}

const personalInput = z
    .object({ hidden: z.boolean().optional(), color: z.enum(CALENDAR_COLORS).nullish(), position: z.number().int().min(0).max(10000).optional() })
    .strict();

/** The caller's own show/hide, colour and order for a calendar. Changes nothing for anyone else. */
export async function updatePersonal(db: D1Database, user: PortalUser, calendarId: string, input: unknown): Promise<CalendarInfo> {
    await requireCalendar(db, user, calendarId, "freebusy");
    const body = personalInput.parse(input);
    const sets: string[] = [];
    const binds: unknown[] = [];
    if (body.hidden !== undefined) (sets.push("hidden = ?"), binds.push(body.hidden ? 1 : 0));
    if (body.color !== undefined) (sets.push("color = ?"), binds.push(body.color ?? null));
    if (body.position !== undefined) (sets.push("position = ?"), binds.push(body.position));
    if (sets.length)
        await db
            .prepare(`UPDATE calendar_members SET ${sets.join(", ")}, updated_at = ? WHERE calendar_id = ? AND email = ?`)
            .bind(...binds, nowIso(), calendarId, user.email)
            .run();
    return (await listCalendars(db, user)).find((c) => c.id === calendarId)!;
}

/** Deletes a calendar with its events (and its subscription). Owners only; the default calendar can't be deleted. */
export async function deleteCalendar(db: D1Database, user: PortalUser, calendarId: string): Promise<void> {
    const cal = await requireCalendar(db, user, calendarId, "owner");
    if (cal.is_default) throw new HttpError(422, "default", "Your default calendar can't be deleted");
    await db.batch([
        db.prepare("DELETE FROM calendars WHERE id = ?").bind(calendarId),
        activity(db, {
            actor: user.email,
            action: cal.source === "subscription" ? "subscription.delete" : "calendar.delete",
            entityType: "calendar",
            entityId: calendarId,
        }),
    ]);
}

// --- Members -------------------------------------------------------------------------------------

export async function listMembers(db: D1Database, calendarIds: string[]): Promise<Record<string, CalendarMember[]>> {
    const out: Record<string, CalendarMember[]> = {};
    if (!calendarIds.length) return out;
    const rows = await db
        .prepare(
            `SELECT m.calendar_id, m.email, m.role, u.name FROM calendar_members m LEFT JOIN portal_users u ON u.email = m.email
             WHERE m.calendar_id IN (SELECT value FROM json_each(?)) ORDER BY m.role = 'owner' DESC, m.email`,
        )
        .bind(JSON.stringify(calendarIds))
        .all<{ calendar_id: string; email: string; role: CalendarRole; name: string | null }>();
    for (const r of rows.results) (out[r.calendar_id] ??= []).push({ email: r.email, name: r.name, role: r.role });
    return out;
}

/** People who can open Calendar: the configured owners and active portal users with the permission. */
export async function calendarPeople(env: Env, db: D1Database): Promise<CalendarPerson[]> {
    const rows = await db
        .prepare("SELECT email, name, role, active FROM portal_users WHERE active = 1")
        .all<{ email: string; name: string | null; role: string }>();
    const people = new Map<string, CalendarPerson>();
    for (const email of ownerEmails(env)) people.set(email, { email, name: null });
    for (const r of rows.results)
        if (await canUseCalendar(env, db, r.email)) people.set(r.email, { email: r.email, name: r.name ?? people.get(r.email)?.name ?? null });
    return [...people.values()].sort((a, b) => (a.name ?? a.email).localeCompare(b.name ?? b.email));
}

const memberInput = z.object({ email: z.string().trim().toLowerCase().email().max(254), role: z.enum(["owner", "editor", "viewer", "freebusy"]) }).strict();

export async function addMember(env: Env, db: D1Database, user: PortalUser, calendarId: string, input: unknown): Promise<CalendarMember[]> {
    const cal = await requireCalendar(db, user, calendarId, "owner");
    const body = memberInput.parse(input);
    if (body.email === user.email) throw new HttpError(422, "self", "You're already a member");
    if (!(await canUseCalendar(env, db, body.email)))
        throw new HttpError(422, "no_access", "That person can't open Calendar. Give them access in Portal settings first.");
    if (cal.kind === "personal" && body.role !== "freebusy")
        throw new HttpError(422, "personal", "A personal calendar can only be shared as free/busy. Make it shared, or use a shared calendar.");
    if (cal.source === "subscription" && body.role === "editor") throw new HttpError(422, "read_only", "Subscribed calendars are read-only");
    const now = nowIso();
    await db.batch([
        db
            .prepare(
                `INSERT INTO calendar_members (calendar_id, email, role, position, added_by, created_at, updated_at) VALUES (?, ?, ?, 100, ?, ?, ?)
                 ON CONFLICT (calendar_id, email) DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at`,
            )
            .bind(calendarId, body.email, body.role, user.email, now, now),
        activity(db, { actor: user.email, action: "calendar.member.add", entityType: "calendar", entityId: calendarId, calendarId }),
    ]);
    return (await listMembers(db, [calendarId]))[calendarId] ?? [];
}

export async function removeMember(db: D1Database, user: PortalUser, calendarId: string, email: string): Promise<CalendarMember[]> {
    const target = email.trim().toLowerCase();
    const leaving = target === user.email;
    const cal = await requireCalendar(db, user, calendarId, leaving ? "freebusy" : "owner");
    if (target === cal.owner_email) throw new HttpError(422, "owner", "The calendar's creator can't be removed. Delete the calendar instead.");
    const owners = await db
        .prepare("SELECT COUNT(*) AS n FROM calendar_members WHERE calendar_id = ? AND role = 'owner' AND email <> ?")
        .bind(calendarId, target)
        .first<{ n: number }>();
    if (!owners?.n) throw new HttpError(422, "last_owner", "A calendar needs at least one owner");
    const removed = await db.batch([
        db.prepare("DELETE FROM calendar_members WHERE calendar_id = ? AND email = ?").bind(calendarId, target),
        // Their reminders on this calendar's events go with them; nothing else they made is touched.
        db
            .prepare("DELETE FROM calendar_reminders WHERE email = ? AND event_id IN (SELECT id FROM calendar_events WHERE calendar_id = ?)")
            .bind(target, calendarId),
        activity(db, { actor: user.email, action: "calendar.member.remove", entityType: "calendar", entityId: calendarId, calendarId }),
    ]);
    if (!removed[0].meta.changes) throw notFound();
    return leaving ? [] : ((await listMembers(db, [calendarId]))[calendarId] ?? []);
}
