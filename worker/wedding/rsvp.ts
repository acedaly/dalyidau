// The native RSVP engine behind the "rsvp.native" flag.
//
// The household RSVP code is the only credential. Lookups and submissions are rate-limited per
// client (hashed, never stored raw), only guests in that household can be changed, and only for
// events they are invited to with RSVPs enabled. Every submission is stored verbatim and audited.
import type { D1Database } from "@cloudflare/workers-types";
import { z } from "zod";
import type { RsvpHousehold, RsvpStatus } from "../../src/shared/portal/types";
import { auditStatement, newId, normaliseRsvpCode, nowIso } from "../portal/db";
import { REDACTED } from "../portal/redact";
import { getSettings } from "../portal/settings";
import { todayIn } from "../portal/stats";

export class RsvpError extends Error {
    constructor(
        readonly code: "closed" | "not_found" | "rate_limited" | "deadline_passed" | "invalid",
        message: string,
        readonly status: number,
    ) {
        super(message);
    }
}

const sha256 = async (value: string) => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

/** Fixed-window limiter in D1. Returns false once `limit` requests have been seen in the window. */
export async function allow(db: D1Database, bucket: string, client: string, limit: number, windowSeconds: number, now = Date.now()): Promise<boolean> {
    const key = `${bucket}:${(await sha256(`${bucket}|${client}`)).slice(0, 32)}`;
    const windowStart = Math.floor(now / 1000 / windowSeconds) * windowSeconds;
    const row = await db
        .prepare(
            `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
             ON CONFLICT(key) DO UPDATE SET
                count = CASE WHEN rate_limits.window_start = ?2 THEN rate_limits.count + 1 ELSE 1 END,
                window_start = ?2
             RETURNING count`,
        )
        .bind(key, windowStart)
        .first<{ count: number }>();
    // Opportunistic clean-up of old windows.
    if (Math.random() < 0.02)
        await db
            .prepare("DELETE FROM rate_limits WHERE window_start < ?")
            .bind(windowStart - 86_400)
            .run();
    return (row?.count ?? 0) <= limit;
}

const clientKey = (request: Request) => request.headers.get("CF-Connecting-IP") ?? "unknown";

const codeSchema = z.object({ code: z.string().min(4).max(20) });

async function householdForCode(db: D1Database, rawCode: string) {
    const code = normaliseRsvpCode(rawCode);
    if (code.length < 6) return null;
    return db
        .prepare("SELECT id, name, rsvp_code FROM households WHERE rsvp_code = ? AND deleted_at IS NULL")
        .bind(code)
        .first<{ id: string; name: string; rsvp_code: string }>();
}

async function deadlinePassed(db: D1Database) {
    const [rsvp, wedding] = await Promise.all([getSettings(db, "rsvp"), getSettings(db, "wedding")]);
    return !!rsvp.deadline && todayIn(wedding.timeZone) > rsvp.deadline;
}

async function loadHousehold(db: D1Database, household: { id: string; name: string }): Promise<RsvpHousehold> {
    const [guests, invitations, settings, passed] = await Promise.all([
        db
            .prepare(
                "SELECT id, first_name, last_name, age_group, dietary FROM guests WHERE household_id = ? AND deleted_at IS NULL ORDER BY is_plus_one, age_group, first_name",
            )
            .bind(household.id)
            .all<{ id: string; first_name: string; last_name: string; age_group: "adult" | "child" | "infant"; dietary: string | null }>(),
        db
            .prepare(
                `SELECT ge.guest_id, ge.event_id, ge.status, e.name, e.starts_at, e.venue_name FROM guest_events ge
                 JOIN events e ON e.id = ge.event_id JOIN guests g ON g.id = ge.guest_id
                 WHERE g.household_id = ? AND g.deleted_at IS NULL AND e.rsvp_enabled = 1 ORDER BY e.sort_order, e.starts_at`,
            )
            .bind(household.id)
            .all<{ guest_id: string; event_id: string; status: RsvpStatus; name: string; starts_at: string | null; venue_name: string | null }>(),
        getSettings(db, "rsvp"),
        deadlinePassed(db),
    ]);

    const events = new Map<string, RsvpHousehold["events"][number]>();
    const responses: RsvpHousehold["responses"] = {};
    for (const row of invitations.results) {
        if (!events.has(row.event_id)) events.set(row.event_id, { id: row.event_id, name: row.name, startsAt: row.starts_at, venueName: row.venue_name });
        (responses[row.guest_id] ??= {})[row.event_id] = row.status;
    }
    return {
        householdName: household.name,
        deadlinePassed: passed,
        // Guests who are not invited to anything with RSVPs open are left out of the form.
        guests: guests.results
            .filter((g) => responses[g.id])
            .map((g) => ({ id: g.id, firstName: g.first_name, lastName: g.last_name, ageGroup: g.age_group, dietary: g.dietary })),
        events: [...events.values()],
        responses,
        collectDietary: settings.collectDietary,
        collectMessage: settings.collectMessage,
    };
}

export async function lookupRsvp(db: D1Database, request: Request, input: unknown): Promise<RsvpHousehold> {
    if (!(await allow(db, "rsvp-lookup", clientKey(request), 20, 600))) {
        throw new RsvpError("rate_limited", "Too many attempts. Please wait ten minutes and try again.", 429);
    }
    const parsed = codeSchema.safeParse(input);
    const household = parsed.success ? await householdForCode(db, parsed.data.code) : null;
    if (!household) throw new RsvpError("not_found", "We couldn't find that code. Check your invitation and try again.", 404);
    const result = await loadHousehold(db, household);
    if (result.guests.length === 0) throw new RsvpError("not_found", "There's nothing to RSVP to for this code yet. Please get in touch with us.", 404);
    return result;
}

const submitSchema = z.object({
    code: z.string().min(4).max(20),
    guests: z
        .array(
            z.object({
                guestId: z.string().max(40),
                events: z.record(z.string().max(40), z.enum(["attending", "declined"])),
                dietary: z.string().trim().max(500).nullable().optional(),
            }),
        )
        .min(1)
        .max(30),
    message: z.string().trim().max(2000).nullable().optional(),
    email: z
        .string()
        .trim()
        .max(254)
        .transform((v) => (v === "" ? null : v))
        .pipe(z.email().nullable())
        .nullable()
        .optional(),
});

export async function submitRsvp(db: D1Database, request: Request, input: unknown): Promise<RsvpHousehold> {
    if (!(await allow(db, "rsvp-submit", clientKey(request), 10, 600))) {
        throw new RsvpError("rate_limited", "Too many attempts. Please wait ten minutes and try again.", 429);
    }
    const parsed = submitSchema.safeParse(input);
    if (!parsed.success) throw new RsvpError("invalid", "Please answer for everyone before sending.", 400);
    const data = parsed.data;

    const household = await householdForCode(db, data.code);
    if (!household) throw new RsvpError("not_found", "We couldn't find that code. Check your invitation and try again.", 404);
    const current = await loadHousehold(db, household);
    if (current.deadlinePassed) throw new RsvpError("deadline_passed", "RSVPs have closed. Please contact us directly if your plans have changed.", 409);

    const now = nowIso();
    const statements = [];
    const summary: { guestId: string; name: string; events: Record<string, "attending" | "declined">; dietary?: string | null }[] = [];
    for (const answer of data.guests) {
        const guest = current.guests.find((g) => g.id === answer.guestId);
        const invited = current.responses[answer.guestId];
        // Anything outside this household or its invitations is rejected, not ignored.
        if (!guest || !invited) throw new RsvpError("invalid", "This response doesn't match the invitation.", 400);
        for (const [eventId, status] of Object.entries(answer.events)) {
            if (!(eventId in invited)) throw new RsvpError("invalid", "This response doesn't match the invitation.", 400);
            statements.push(
                db
                    .prepare("UPDATE guest_events SET status = ?, source = 'native', responded_at = ? WHERE guest_id = ? AND event_id = ?")
                    .bind(status, now, answer.guestId, eventId),
            );
        }
        if (current.collectDietary && answer.dietary !== undefined) {
            statements.push(db.prepare("UPDATE guests SET dietary = ?, updated_at = ? WHERE id = ?").bind(answer.dietary || null, now, answer.guestId));
        }
        summary.push({ guestId: guest.id, name: `${guest.firstName} ${guest.lastName}`.trim(), events: answer.events, dietary: answer.dietary ?? null });
    }
    // Everyone invited must be answered for every event, so a half-filled form can't slip through.
    for (const guest of current.guests) {
        const answer = data.guests.find((a) => a.guestId === guest.id);
        if (!answer || Object.keys(current.responses[guest.id]).some((eventId) => !(eventId in answer.events))) {
            throw new RsvpError("invalid", "Please answer for everyone before sending.", 400);
        }
    }

    const message = current.collectMessage ? (data.message ?? null) : null;
    if (data.email) {
        statements.push(db.prepare("UPDATE households SET email = COALESCE(email, ?), updated_at = ? WHERE id = ?").bind(data.email, now, household.id));
    }
    const attending = summary.reduce((n, g) => n + Object.values(g.events).filter((s) => s === "attending").length, 0);
    statements.push(
        db
            .prepare("INSERT INTO rsvp_submissions (id, household_id, submitted_at, payload, message) VALUES (?, ?, ?, ?, ?)")
            .bind(newId("rsv"), household.id, now, JSON.stringify({ guests: summary, email: data.email ?? null }), message),
        auditStatement(db, {
            actor: `rsvp:${household.id}`,
            action: "rsvp.submit",
            entityType: "household",
            entityId: household.id,
            summary: `${household.name} responded online (${attending} attending)`,
            // Who answered what is kept; dietary notes stay in the submission and the guest record only.
            changes: { guests: summary.map(({ dietary, ...g }) => ({ ...g, dietary: dietary ? REDACTED : null })) },
        }),
    );
    await db.batch(statements);
    return loadHousehold(db, household);
}
