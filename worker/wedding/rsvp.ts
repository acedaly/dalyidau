// The native RSVP engine behind the "rsvp.native" flag.
//
// The household RSVP code is the only credential. Lookups and submissions are rate-limited per
// client (hashed, never stored raw), only guests in that household can be changed, and only for
// events they are invited to with RSVPs enabled. Every submission is stored verbatim and audited.
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { z } from "zod";
import { questionApplies, validateAnswer } from "../../src/shared/portal/rsvp-questions";
import type { AnswerValue, RsvpHousehold, RsvpQuestion, RsvpStatus } from "../../src/shared/portal/types";
import type { Env } from "../env";
import { sendRsvpConfirmation } from "../portal/comms";
import { auditStatement, newId, normaliseRsvpCode, nowIso } from "../portal/db";
import { REDACTED } from "../portal/redact";
import { listQuestions } from "../portal/rsvp-questions";
import { getSettings } from "../portal/settings";
import { todayIn } from "../portal/stats";
import { type InvitationHousehold, householdForInvitation } from "./invitations";

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
    if (crypto.getRandomValues(new Uint8Array(1))[0] < 5)
        await db
            .prepare("DELETE FROM rate_limits WHERE window_start < ?")
            .bind(windowStart - 86_400)
            .run();
    return (row?.count ?? 0) <= limit;
}

const clientKey = (request: Request) => request.headers.get("CF-Connecting-IP") ?? "unknown";

const credentialSchema = z
    .object({ code: z.string().min(4).max(20).optional(), token: z.string().min(40).max(240).optional() })
    .refine((value) => !!value.code !== !!value.token);

async function householdForCode(db: D1Database, rawCode: string) {
    const code = normaliseRsvpCode(rawCode);
    if (code.length < 6) return null;
    return db
        .prepare("SELECT id, name, rsvp_code, invite_version, invite_revoked_at FROM households WHERE rsvp_code = ? AND deleted_at IS NULL")
        .bind(code)
        .first<InvitationHousehold>();
}

async function householdForCredential(env: Env, input: { code?: string; token?: string }) {
    const settings = await getSettings(env.DB, "rsvp");
    if (input.token) return householdForInvitation(env.DB, env, input.token, settings);
    return input.code && settings.allowCodes ? householdForCode(env.DB, input.code) : null;
}

async function deadlinePassed(db: D1Database) {
    const [rsvp, wedding] = await Promise.all([getSettings(db, "rsvp"), getSettings(db, "wedding")]);
    return !!rsvp.deadline && todayIn(wedding.timeZone) > rsvp.deadline;
}

async function loadHousehold(db: D1Database, household: { id: string; name: string }): Promise<RsvpHousehold> {
    const [guests, invitations, settings, passed, questions, storedAnswers] = await Promise.all([
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
        listQuestions(db, true),
        db.prepare("SELECT question_id, guest_id, value FROM rsvp_answers WHERE household_id = ?").bind(household.id).all<{
            question_id: string;
            guest_id: string;
            value: string;
        }>(),
    ]);

    const events = new Map<string, RsvpHousehold["events"][number]>();
    const responses: RsvpHousehold["responses"] = {};
    for (const row of invitations.results) {
        if (!events.has(row.event_id)) events.set(row.event_id, { id: row.event_id, name: row.name, startsAt: row.starts_at, venueName: row.venue_name });
        (responses[row.guest_id] ??= {})[row.event_id] = row.status;
    }
    const answers: RsvpHousehold["answers"] = { household: {}, guests: {} };
    for (const row of storedAnswers.results) {
        let value: AnswerValue;
        try {
            value = JSON.parse(row.value) as AnswerValue;
        } catch {
            continue;
        }
        if (row.guest_id) (answers.guests[row.guest_id] ??= {})[row.question_id] = value;
        else answers.household[row.question_id] = value;
    }
    return {
        householdName: household.name,
        deadlinePassed: passed && !settings.allowChangesAfterDeadline,
        // Guests who are not invited to anything with RSVPs open are left out of the form.
        guests: guests.results
            .filter((g) => responses[g.id])
            .map((g) => ({ id: g.id, firstName: g.first_name, lastName: g.last_name, ageGroup: g.age_group, dietary: g.dietary })),
        events: [...events.values()],
        responses,
        collectDietary: settings.collectDietary,
        collectMessage: settings.collectMessage,
        questions,
        answers,
    };
}

export async function lookupRsvp(env: Env, request: Request, input: unknown): Promise<RsvpHousehold> {
    if (!(await allow(env.DB, "rsvp-lookup", clientKey(request), 20, 600))) {
        throw new RsvpError("rate_limited", "Too many attempts. Please wait ten minutes and try again.", 429);
    }
    const parsed = credentialSchema.safeParse(input);
    const household = parsed.success ? await householdForCredential(env, parsed.data) : null;
    // Keep all invalid, revoked, expired and empty invitations indistinguishable to prevent enumeration.
    if (!household) throw new RsvpError("not_found", "We couldn't open that invitation. Check the link or code and try again.", 404);
    const result = await loadHousehold(env.DB, household);
    if (result.guests.length === 0) throw new RsvpError("not_found", "We couldn't open that invitation. Check the link or code and try again.", 404);
    return result;
}

const submitSchema = z
    .object({
        code: z.string().min(4).max(20).optional(),
        token: z.string().min(40).max(240).optional(),
        clientId: z.string().min(16).max(100).optional(),
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
        answers: z
            .object({
                household: z.record(z.string().max(40), z.unknown()).default({}),
                guests: z.record(z.string().max(40), z.record(z.string().max(40), z.unknown())).default({}),
            })
            .default({ household: {}, guests: {} }),
    })
    .refine((value) => !!value.code !== !!value.token);

export interface SubmitResult {
    household: RsvpHousehold;
    /** Whether a confirmation email went out (only with the RSVP setting, the email switch and a provider). */
    confirmationSent: boolean;
}

export async function submitRsvp(env: Env, request: Request, input: unknown): Promise<SubmitResult> {
    const db = env.DB;
    if (!(await allow(db, "rsvp-submit", clientKey(request), 10, 600))) {
        throw new RsvpError("rate_limited", "Too many attempts. Please wait ten minutes and try again.", 429);
    }
    const parsed = submitSchema.safeParse(input);
    if (!parsed.success) throw new RsvpError("invalid", "Please answer for everyone before sending.", 400);
    const data = parsed.data;

    const household = await householdForCredential(env, data);
    if (!household) throw new RsvpError("not_found", "We couldn't open that invitation. Check the link or code and try again.", 404);
    const current = await loadHousehold(db, household);
    const duplicate = data.clientId
        ? await db.prepare("SELECT id FROM rsvp_submissions WHERE household_id = ? AND client_id = ?").bind(household.id, data.clientId).first()
        : null;
    // A retried submission returns the saved result without sending anything again.
    if (duplicate) return { household: current, confirmationSent: false };
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

    const answerStatements: D1PreparedStatement[] = [];
    const questionPayload: { household: Record<string, AnswerValue>; guests: Record<string, Record<string, AnswerValue>> } = { household: {}, guests: {} };
    const attending = (guestId: string, eventId: string) => data.guests.find((guest) => guest.guestId === guestId)?.events[eventId] === "attending";
    const saveAnswer = (question: RsvpQuestion, guestId: string, value: AnswerValue) => {
        const snapshot = JSON.stringify({ label: question.label, help: question.help, type: question.type, options: question.options });
        answerStatements.push(
            db
                .prepare(
                    `INSERT INTO rsvp_answers
                     (question_id, household_id, guest_id, value, question_version, question_snapshot, source, answered_at)
                     VALUES (?, ?, ?, ?, ?, ?, 'native', ?)
                     ON CONFLICT(question_id, household_id, guest_id) DO UPDATE SET
                       value = excluded.value, question_version = excluded.question_version,
                       question_snapshot = excluded.question_snapshot, source = excluded.source, answered_at = excluded.answered_at`,
                )
                .bind(question.id, household.id, guestId, JSON.stringify(value), question.version, snapshot, now),
        );
    };
    for (const question of current.questions) {
        if (question.scope === "household") {
            const supplied = data.answers.household[question.id];
            const applies = questionApplies(question, {
                ageGroup: null,
                attending: (eventId) => data.guests.some((guest) => attending(guest.guestId, eventId)),
                answerTo: (questionId) => data.answers.household[questionId] as AnswerValue | undefined,
            });
            if (!applies) continue;
            const checked = validateAnswer(question, supplied);
            if ("error" in checked) throw new RsvpError("invalid", checked.error, 400);
            if (checked.value !== null) {
                questionPayload.household[question.id] = checked.value;
                saveAnswer(question, "", checked.value);
            }
        } else {
            for (const guest of current.guests) {
                const guestAnswers = data.answers.guests[guest.id] ?? {};
                const applies = questionApplies(question, {
                    ageGroup: guest.ageGroup,
                    attending: (eventId) => attending(guest.id, eventId),
                    answerTo: (questionId) => guestAnswers[questionId] as AnswerValue | undefined,
                });
                if (!applies) continue;
                const checked = validateAnswer(question, guestAnswers[question.id]);
                if ("error" in checked) throw new RsvpError("invalid", `${guest.firstName}: ${checked.error}`, 400);
                if (checked.value !== null) {
                    (questionPayload.guests[guest.id] ??= {})[question.id] = checked.value;
                    saveAnswer(question, guest.id, checked.value);
                }
            }
        }
    }

    const message = current.collectMessage ? (data.message ?? null) : null;
    if (data.email) {
        statements.push(db.prepare("UPDATE households SET email = COALESCE(email, ?), updated_at = ? WHERE id = ?").bind(data.email, now, household.id));
    }
    const attendingCount = summary.reduce((n, g) => n + Object.values(g.events).filter((s) => s === "attending").length, 0);
    statements.push(
        db
            .prepare("INSERT INTO rsvp_submissions (id, household_id, submitted_at, payload, message, client_id) VALUES (?, ?, ?, ?, ?, ?)")
            .bind(
                newId("rsv"),
                household.id,
                now,
                JSON.stringify({ guests: summary, email: data.email ?? null, answers: questionPayload }),
                message,
                data.clientId ?? null,
            ),
        ...answerStatements,
        auditStatement(db, {
            actor: `rsvp:${household.id}`,
            action: "rsvp.submit",
            entityType: "household",
            entityId: household.id,
            summary: `${household.name} responded online (${attendingCount} attending)`,
            // Who answered what is kept; dietary notes stay in the submission and the guest record only.
            changes: { guests: summary.map(({ dietary, ...g }) => ({ ...g, dietary: dietary ? REDACTED : null })) },
        }),
    );
    try {
        await db.batch(statements);
    } catch (error) {
        // The partial unique index is the final guard when the same browser retries concurrently.
        // D1 batches are transactional, so the losing request can safely return the winning result.
        if (data.clientId && /UNIQUE constraint failed.*rsvp_submissions/i.test(String((error as Error).message))) {
            const won = await db.prepare("SELECT id FROM rsvp_submissions WHERE household_id = ? AND client_id = ?").bind(household.id, data.clientId).first();
            if (won) return { household: await loadHousehold(db, household), confirmationSent: false };
        }
        throw error;
    }
    const saved = await loadHousehold(db, household);
    const confirmationSent = data.email ? await sendRsvpConfirmation(env, db, household, saved, data.email) : false;
    return { household: saved, confirmationSent };
}
