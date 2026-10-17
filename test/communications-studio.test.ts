// The Communications Studio's safety rules: household addressing for every campaign, reminder
// targeting and re-checks at send time, duplicate protection, the send check, controlled tests,
// final details that never invent anything, thank-you notes, printable cards, contact readiness and
// the household timeline. Every provider here is a mock: nothing is ever sent.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderMergeFields } from "../src/shared/portal/merge-fields";
import type { Guest, Household, HouseholdRow, Message, MessagePreflight, TimelineEntry, WeddingEvent } from "../src/shared/portal/types";
import { stationeryEmailHtml } from "../worker/comms/stationery";
import type { Env } from "../worker/env";
import { processDueMessages } from "../worker/portal/comms";
import { apiCall, call, db, portalEnv, resetPortal } from "./portal-helpers";

beforeEach(resetPortal);

type Sent = { to: { email: string; name?: string }; subject: string; text: string; html: string };

/** A Worker with a mock email provider (Cloudflare Email binding). Still inert until the switch is on. */
async function emailEnv() {
    const send = vi.fn(async (_message: Sent) => ({ messageId: `cf-${Math.random().toString(36).slice(2)}` }));
    const env = await portalEnv({ EMAIL_DELIVERY: "cloudflare", EMAIL_FROM: "wedding@daly.id.au", EMAIL: { send } as unknown as Env["EMAIL"] });
    return { env, send };
}

const switchEmailOn = () => apiCall("PUT", "/api/portal/flags/communications.delivery", { enabled: true });

/** Three fictional households: a couple (no reply yet), a family (partly answered) and one who has replied. */
async function setup() {
    const ceremony = (await apiCall<{ item: WeddingEvent }>("POST", "/api/portal/wedding/events", { name: "Ceremony", startsAt: "2027-10-23T14:00" })).json
        .item;
    const reception = (await apiCall<{ item: WeddingEvent }>("POST", "/api/portal/wedding/events", { name: "Reception" })).json.item;
    const home = async (name: string, extra: Record<string, unknown> = {}) =>
        (await apiCall<{ item: Household }>("POST", "/api/portal/wedding/households", { name, ...extra })).json.item;
    const guest = async (body: Record<string, unknown>) => {
        const result = await apiCall<{ guest: Guest }>("POST", "/api/portal/wedding/guests", { events: [ceremony.id, reception.id], ...body });
        expect(result.status, result.text).toBe(201);
        return result.json.guest;
    };
    const rsvp = (guestId: string, eventId: string, status: "attending" | "declined") =>
        apiCall("PUT", `/api/portal/wedding/guests/${guestId}/rsvp`, { eventId, status });

    const couple = await home("The Example Couple");
    const fred = await guest({ firstName: "Fred", lastName: "Example", email: "fred@example.com", householdId: couple.id });
    const ann = await guest({ firstName: "Ann", lastName: "Example", email: "ann@example.com", householdId: couple.id });

    const family = await home("The Sample Family");
    const sam = await guest({ firstName: "Sam", lastName: "Sample", email: "sam@example.com", householdId: family.id });
    const tom = await guest({ firstName: "Tom", lastName: "Sample", householdId: family.id, ageGroup: "child" });
    await rsvp(sam.id, ceremony.id, "attending");
    await rsvp(sam.id, reception.id, "attending");

    const done = await home("The Replied Household");
    const kate = await guest({ firstName: "Kate", lastName: "Replied", email: "kate@example.com", householdId: done.id });
    await rsvp(kate.id, ceremony.id, "attending");
    await rsvp(kate.id, reception.id, "attending");

    return { ceremony, reception, couple, family, done, fred, ann, sam, tom, kate, rsvp };
}

const prepare = (body: Record<string, unknown>) =>
    apiCall<{ message: Message }>("POST", "/api/portal/wedding/messages", { channel: "email", audience: {}, ...body });

const recipients = async (messageId: string) =>
    (
        await db()
            .prepare("SELECT guest_id, household_id, name, email, status, error FROM message_recipients WHERE message_id = ? ORDER BY name")
            .bind(messageId)
            .all<{ guest_id: string; household_id: string | null; name: string; email: string | null; status: string; error: string | null }>()
    ).results;

const check = async (messageId: string) =>
    (await apiCall<{ preflight: MessagePreflight }>("GET", `/api/portal/wedding/messages/${messageId}/preflight`)).json.preflight;

const send = (messageId: string, env: Env, body: Record<string, unknown> = {}) =>
    apiCall<{ message: Message }>("POST", `/api/portal/wedding/messages/${messageId}/send`, body, { env });

describe("merge fields", () => {
    it("drops a line whose optional field is empty, and keeps required fields visible when unknown", () => {
        const text = "Dear {{greeting_names}},\n\n{{personal_note}}\n\nPhotos from the day: {{gallery_link}}\n\nLove";
        expect(renderMergeFields(text, { greeting_names: "Fred & Ann", personal_note: "", gallery_link: "" })).toBe("Dear Fred & Ann,\n\nLove");
        expect(renderMergeFields(text, { greeting_names: "Fred & Ann", personal_note: "Thanks for the vase!", gallery_link: "https://example.com/p" })).toBe(
            "Dear Fred & Ann,\n\nThanks for the vase!\n\nPhotos from the day: https://example.com/p\n\nLove",
        );
        expect(renderMergeFields("Hi {{oops}}", {})).toBe("Hi {{oops}}");
    });
});

describe("save the date", () => {
    it("goes once to each household, addressed to the household, and never touches RSVPs or invitation state", async () => {
        const f = await setup();
        const rsvps = async () => (await db().prepare("SELECT guest_id, event_id, status FROM guest_events ORDER BY guest_id, event_id").all()).results;
        const invitations = async () =>
            (await db().prepare("SELECT id, invitation_generated_at, invite_version, invite_revoked_at FROM households ORDER BY id").all()).results;
        const before = await rsvps();
        const households = await invitations();

        const message = await prepare({ category: "save_the_date", subject: "Save the date", body: "Dear {{greeting_names}}, see {{website_link}}" });
        expect(message.status, message.text).toBe(201);
        const rows = await recipients(message.json.message.id);
        expect(rows.filter((r) => r.status === "pending").map((r) => r.name)).toEqual(["Fred & Ann Example", "Kate Replied", "Sam & Tom Sample"]);
        expect(rows.find((r) => r.guest_id === f.ann.id)).toMatchObject({
            status: "skipped",
            error: "Included in the household message to Fred & Ann Example",
        });
        // Tom has no email, but his household is covered by Sam.
        expect(rows.find((r) => r.guest_id === f.tom.id)?.error).toMatch(/^Included in the household message/);

        const { env, send: provider } = await emailEnv();
        await switchEmailOn();
        expect((await send(message.json.message.id, env, { confirmCount: 3 })).json.message.status).toBe("sent");
        expect(provider).toHaveBeenCalledTimes(3);
        const fred = provider.mock.calls.find((c) => c[0].to.email === "fred@example.com")![0];
        expect(fred.text).toContain("Dear Fred & Ann,");
        expect(fred.html).toContain("Save the date");

        expect(await rsvps()).toEqual(before);
        expect(await invitations()).toEqual(households);
    });

    it("refuses RSVP links and codes: the formal invitation comes later", async () => {
        await setup();
        const refused = await prepare({ category: "save_the_date", subject: "Save the date", body: "Reply here: {{rsvp_link}}" });
        expect(refused.status).toBe(422);
        expect(refused.text).toContain("formal invitation");
    });

    it("describes an existing unsent draft accurately and includes it only when preparing another is deliberate", async () => {
        await setup();
        const body = { category: "save_the_date", subject: "Save the date", body: "Dear {{greeting_names}}" };
        await prepare(body);
        const second = await prepare(body);
        expect((await recipients(second.json.message.id)).every((r) => r.status === "skipped")).toBe(true);
        expect((await recipients(second.json.message.id)).find((r) => r.name === "Kate Replied")?.error).toBe(
            "Already in an unsent draft for this household (nothing sent yet)",
        );
        const again = await prepare({ ...body, resend: true });
        expect((await recipients(again.json.message.id)).filter((r) => r.status === "pending")).toHaveLength(3);
        expect(again.json.message.options).toEqual({ resend: true });
    });

    it("deduplicates only the same campaign and channel", async () => {
        await setup();
        const body = { category: "invitation", subject: "Invitation", body: "{{rsvp_link}}" };
        await prepare({ ...body, channel: "email" });
        const text = await prepare({ ...body, channel: "sms" });
        const rows = await recipients(text.json.message.id);
        expect(rows.some((recipient) => recipient.error?.includes("unsent draft"))).toBe(false);
        expect(rows.filter((recipient) => recipient.error === "No mobile number")).toHaveLength(5);
    });
});

describe("RSVP reminders", () => {
    it("targets households by RSVP progress, shows why, and never includes households that have replied", async () => {
        const f = await setup();
        const preview = await apiCall<{ households: number; reasons: { name: string; status: string }[] }>("POST", "/api/portal/wedding/messages/audience", {
            reminder: ["not_started", "partial"],
        });
        expect(preview.json.households).toBe(2);
        expect(preview.json.reasons.map((r) => [r.name, r.status]).sort()).toEqual([
            ["The Example Couple", "not_started"],
            ["The Sample Family", "partial"],
        ]);

        const message = await prepare({
            category: "reminder",
            subject: "Reminder",
            body: "Dear {{greeting_names}}, {{rsvp_progress}} {{rsvp_link}}",
            audience: { reminder: ["not_started", "partial"] },
        });
        const rows = await recipients(message.json.message.id);
        expect(rows.filter((r) => r.status === "pending").map((r) => r.name)).toEqual(["Fred & Ann Example", "Sam & Tom Sample"]);
        expect(rows.some((r) => r.guest_id === f.kate.id)).toBe(false);

        // Even aimed at everyone, a reminder skips a household that has answered for everyone.
        const everyone = await prepare({ category: "reminder", subject: "Reminder", body: "{{rsvp_link}}", audience: {} });
        expect((await recipients(everyone.json.message.id)).find((r) => r.guest_id === f.kate.id)).toMatchObject({
            status: "skipped",
            error: "Already replied for everyone",
        });
    });

    it("names who still needs to reply and uses the household's own RSVP link", async () => {
        const f = await setup();
        const preview = await apiCall<{ body: string }>("POST", "/api/portal/wedding/messages/preview", {
            category: "reminder",
            subject: "x",
            body: "{{rsvp_progress}}\n{{rsvp_link}}",
            householdId: f.family.id,
        });
        expect(preview.json.body).toMatch(/^We still need an answer for Tom\.\nhttps:\/\/wedding\.daly\.id\.au\/rsvp\?invite=/);
    });

    it("re-checks at sending: a household that replied since preparing, or was reminded today, isn't reminded again", async () => {
        const f = await setup();
        const body = { category: "reminder", subject: "Reminder", body: "{{rsvp_link}}", audience: { reminder: ["not_started", "partial"] } };
        const message = (await prepare(body)).json.message;
        // The family finishes their reply after the reminder was prepared.
        await f.rsvp(f.tom.id, f.ceremony.id, "declined");
        await f.rsvp(f.tom.id, f.reception.id, "declined");

        const { env, send: provider } = await emailEnv();
        await switchEmailOn();
        const plan = await check(message.id);
        expect(plan.recipients).toBe(1);
        expect(plan.excluded).toContainEqual({ reason: "Replied for everyone since this was prepared", count: 1, names: ["Sam & Tom Sample"] });
        expect((await send(message.id, env)).json.message.status).toBe("sent");
        expect(provider.mock.calls.map((c) => c[0].to.email)).toEqual(["fred@example.com"]);
        expect((await recipients(message.id)).find((r) => r.guest_id === f.sam.id)).toMatchObject({
            status: "skipped",
            error: "Replied for everyone since this was prepared",
        });

        // A second reminder the same day is held back.
        const again = (await prepare(body)).json.message;
        expect((await check(again.id)).excluded).toContainEqual({ reason: "Reminded in the last 24 hours", count: 1, names: ["Fred & Ann Example"] });
    });

    it("re-checks a scheduled reminder too, and the scheduler never sends to a household that has replied", async () => {
        const f = await setup();
        const message = (await prepare({ category: "reminder", subject: "Reminder", body: "{{rsvp_link}}", audience: { householdIds: [f.couple.id] } })).json
            .message;
        const scheduled = await apiCall<{ message: Message }>("POST", `/api/portal/wedding/messages/${message.id}/schedule`, {
            scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
            confirmCount: 1,
        });
        expect(scheduled.json.message.status).toBe("queued");
        await f.rsvp(f.fred.id, f.ceremony.id, "attending");
        await f.rsvp(f.fred.id, f.reception.id, "attending");
        await f.rsvp(f.ann.id, f.ceremony.id, "attending");
        await f.rsvp(f.ann.id, f.reception.id, "attending");
        await db().prepare("UPDATE messages SET scheduled_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").bind(message.id).run();

        const { env, send: provider } = await emailEnv();
        await switchEmailOn();
        expect(await processDueMessages(env)).toEqual({ processed: 1 });
        expect(provider).not.toHaveBeenCalled();
        expect((await recipients(message.id)).find((r) => r.guest_id === f.fred.id)?.error).toBe("Replied for everyone since this was prepared");
        // Running the scheduler again does nothing: the message has been claimed and finished.
        expect(await processDueMessages(env)).toEqual({ processed: 0 });
    });
});

describe("sending safeguards", () => {
    it("needs the confirmed recipient count for a bulk send, and refuses a stale one", async () => {
        await setup();
        const message = (await prepare({ category: "update", subject: "News", body: "Hi {{first_name}}" })).json.message;
        const { env, send: provider } = await emailEnv();
        await switchEmailOn();
        const plan = await check(message.id);
        expect(plan.recipients).toBe(4);
        expect((await send(message.id, env)).status).toBe(409);
        expect((await send(message.id, env, { confirmCount: 3 })).status).toBe(409);
        expect(provider).not.toHaveBeenCalled();
        expect((await send(message.id, env, { confirmCount: 4 })).json.message.status).toBe("sent");
        expect(provider).toHaveBeenCalledTimes(4);
        // A second send (a double click, another tab) is refused and sends nothing more.
        expect((await send(message.id, env, { confirmCount: 4 })).status).toBe(422);
        expect(provider).toHaveBeenCalledTimes(4);
    });

    it("sends each household once even when two sends of the same message overlap", async () => {
        await setup();
        const message = (await prepare({ category: "save_the_date", subject: "Save the date", body: "{{website_link}}" })).json.message;
        const { env, send: provider } = await emailEnv();
        await switchEmailOn();
        const results = await Promise.all([send(message.id, env, { confirmCount: 3 }), send(message.id, env, { confirmCount: 3 })]);
        expect(results.map((r) => r.status).sort()).toEqual([200, 422]);
        expect(provider).toHaveBeenCalledTimes(3);
    });

    it("holds back a household already sent the same campaign by another message", async () => {
        await setup();
        const body = { category: "save_the_date", subject: "Save the date", body: "{{website_link}}" };
        const first = (await prepare(body)).json.message;
        const second = (await prepare({ ...body, resend: true })).json.message;
        // As if the second had been prepared without "send another" (e.g. before the first existed).
        await db().prepare("UPDATE messages SET options = '{}' WHERE id = ?").bind(second.id).run();
        const { env, send: provider } = await emailEnv();
        await switchEmailOn();
        await send(first.id, env, { confirmCount: 3 });
        const plan = await check(second.id);
        expect(plan.recipients).toBe(0);
        expect(plan.excluded[0]).toMatchObject({ reason: "Already sent to this household in another message", count: 3 });
        await send(second.id, env);
        expect(provider).toHaveBeenCalledTimes(3);
    });

    it("does not let a scheduled resend contact a household that only became a repeat recipient after scheduling", async () => {
        const f = await setup();
        const body = {
            category: "invitation",
            subject: "Wedding invitation",
            body: "Your invitation: {{rsvp_link}}",
            audience: { householdIds: [f.couple.id] },
        };
        const first = (await prepare(body)).json.message;
        const scheduledDraft = (await prepare({ ...body, resend: true })).json.message;
        const scheduled = await apiCall<{ message: Message }>("POST", `/api/portal/wedding/messages/${scheduledDraft.id}/schedule`, {
            scheduledAt: "2030-01-01T00:00:00.000Z",
            confirmCount: 1,
        });
        expect(scheduled.status, scheduled.text).toBe(200);
        expect(scheduled.json.message.options.scheduledResendConfirmed).toEqual([]);

        const { env, send: provider } = await emailEnv();
        await switchEmailOn();
        expect((await send(first.id, env, { confirmCount: 1 })).status).toBe(200);
        expect(provider).toHaveBeenCalledTimes(1);

        await db().prepare("UPDATE messages SET scheduled_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").bind(scheduledDraft.id).run();
        expect(await processDueMessages(env)).toEqual({ processed: 1 });
        expect(provider).toHaveBeenCalledTimes(1);
        expect((await recipients(scheduledDraft.id)).find((recipient) => recipient.name === "Fred & Ann Example")).toMatchObject({
            status: "skipped",
            error: "Already sent after this was scheduled; sending another wasn't confirmed",
        });
    });

    it("persists the repeat household explicitly confirmed for a scheduled invitation resend", async () => {
        const f = await setup();
        const body = {
            category: "invitation",
            subject: "Wedding invitation",
            body: "Your invitation: {{rsvp_link}}",
            audience: { householdIds: [f.couple.id] },
        };
        const first = (await prepare(body)).json.message;
        const { env, send: provider } = await emailEnv();
        await switchEmailOn();
        expect((await send(first.id, env, { confirmCount: 1 })).status).toBe(200);

        const resend = (await prepare({ ...body, resend: true })).json.message;
        const scheduled = await apiCall<{ message: Message }>("POST", `/api/portal/wedding/messages/${resend.id}/schedule`, {
            scheduledAt: "2030-01-01T00:00:00.000Z",
            confirmCount: 1,
            confirmAgain: true,
        });
        expect(scheduled.status, scheduled.text).toBe(200);
        expect(scheduled.json.message.options.scheduledResendConfirmed).toEqual([`household:${f.couple.id}`]);

        await db().prepare("UPDATE messages SET scheduled_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").bind(resend.id).run();
        expect(await processDueMessages(env)).toEqual({ processed: 1 });
        expect(provider).toHaveBeenCalledTimes(2);
        expect((await recipients(resend.id)).find((recipient) => recipient.name === "Fred & Ann Example")?.status).toBe("sent");
    });

    it("re-checks opt-outs at sending", async () => {
        const f = await setup();
        const message = (await prepare({ category: "update", subject: "News", body: "Hi", audience: { guestIds: [f.fred.id, f.sam.id] } })).json.message;
        await db().prepare("UPDATE guests SET email_opt_out_at = '2026-10-01T00:00:00.000Z' WHERE id = ?").bind(f.fred.id).run();
        const { env, send: provider } = await emailEnv();
        await switchEmailOn();
        expect((await check(message.id)).excluded).toContainEqual({ reason: "Opted out of email", count: 1, names: ["Fred Example"] });
        await send(message.id, env);
        expect(provider.mock.calls.map((c) => c[0].to.email)).toEqual(["sam@example.com"]);
    });

    it("never sends while the switch is off, even with a provider configured", async () => {
        await setup();
        const message = (await prepare({ category: "save_the_date", subject: "Save the date", body: "{{website_link}}" })).json.message;
        const { env, send: provider } = await emailEnv();
        expect((await send(message.id, env, { confirmCount: 3 })).status).toBe(422);
        expect((await check(message.id)).deliveryAvailable).toBe(false);
        expect(provider).not.toHaveBeenCalled();
    });

    it("lets only owners and admins send, schedule or test, including scheduling while preparing", async () => {
        await setup();
        await apiCall("POST", "/api/portal/users", { email: "editor@example.com", role: "editor" });
        const message = (await prepare({ category: "update", subject: "News", body: "Hi" })).json.message;
        const as = { email: "editor@example.com" };
        expect((await apiCall("POST", `/api/portal/wedding/messages/${message.id}/send`, { confirmCount: 4 }, as)).status).toBe(403);
        expect(
            (await apiCall("POST", `/api/portal/wedding/messages/${message.id}/schedule`, { scheduledAt: "2030-01-01T00:00:00Z", confirmCount: 4 }, as)).status,
        ).toBe(403);
        expect((await apiCall("POST", `/api/portal/wedding/messages/${message.id}/test`, { to: "owner@example.com" }, as)).status).toBe(403);
        const scheduledByEditor = await apiCall(
            "POST",
            "/api/portal/wedding/messages",
            { subject: "x", body: "y", audience: {}, scheduledAt: "2030-01-01T00:00:00Z" },
            as,
        );
        expect(scheduledByEditor.status).toBe(403);
        // Editors can still prepare and check.
        expect((await apiCall("GET", `/api/portal/wedding/messages/${message.id}/preflight`, undefined, as)).status).toBe(200);
    });
});

describe("household contact details and consent", () => {
    const SECRET = "webhook-secret-0123456789abcdef";
    const webhook = async (provider: string, body: unknown) =>
        call(`/api/comms/webhooks/${provider}/${SECRET}`, {
            method: "POST",
            env: await portalEnv({ COMMS_WEBHOOK_SECRET: SECRET, EMAIL_DELIVERY: "smtp2go", SMTP2GO_API_KEY: "k", EMAIL_FROM: "wedding@daly.id.au" }),
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });

    /** A household reachable only through its own contact details. */
    async function householdOnly() {
        const event = (await apiCall<{ item: WeddingEvent }>("POST", "/api/portal/wedding/events", { name: "Ceremony" })).json.item;
        const home = (
            await apiCall<{ item: Household }>("POST", "/api/portal/wedding/households", {
                name: "The Contact Household",
                email: "home@example.com",
                phone: "0412 000 111",
            })
        ).json.item;
        const guest = (
            await apiCall<{ guest: Guest }>("POST", "/api/portal/wedding/guests", {
                firstName: "Hal",
                lastName: "Contact",
                householdId: home.id,
                events: [event.id],
            })
        ).json.guest;
        return { home, guest };
    }

    it("honours an email unsubscribe sent through the household's own address, at prepare and at send", async () => {
        const { home } = await householdOnly();
        // Nobody in the household has an email, so a household campaign uses the household's address.
        const std = (await prepare({ category: "save_the_date", subject: "Save the date", body: "{{website_link}}" })).json.message;
        const row = (await recipients(std.id)).find((r) => r.guest_id === home.id)!;
        expect(row).toMatchObject({ household_id: home.id, email: "home@example.com", status: "pending" });
        await db()
            .prepare("UPDATE message_recipients SET status = 'sent', provider_id = 'em-home' WHERE message_id = ? AND guest_id = ?")
            .bind(std.id, home.id)
            .run();

        expect((await webhook("smtp2go", { event: "unsubscribe", email_id: "em-home", rcpt: "home@example.com", time: "2027-01-01T00:00:00Z" })).status).toBe(
            200,
        );
        expect(await db().prepare("SELECT email_opt_out_at IS NOT NULL AS out FROM households WHERE id = ?").bind(home.id).first()).toEqual({ out: 1 });

        // New campaigns hold the household back from the start.
        const thanks = (await prepare({ category: "thank_you", subject: "Thanks", body: "{{thank_you_message}}", audience: {} })).json.message;
        expect((await recipients(thanks.id)).find((r) => r.household_id === home.id)).toMatchObject({ status: "skipped", error: "Opted out of email" });
        const reminder = (
            await prepare({ category: "reminder", subject: "Reminder", body: "{{rsvp_link}}", audience: { mode: "specific", householdIds: [home.id] } })
        ).json.message;
        expect((await recipients(reminder.id)).find((r) => r.household_id === home.id)?.error).toBe("Opted out of email");
        // A draft from before the opt-out that still has the household pending is held back at the send check.
        await db().prepare("DELETE FROM message_recipients WHERE message_id = ?").bind(reminder.id).run();
        await db()
            .prepare(
                "INSERT INTO message_recipients (message_id, guest_id, household_id, name, email, status) VALUES (?, ?, ?, 'The Contact Household', 'home@example.com', 'pending')",
            )
            .bind(reminder.id, home.id, home.id)
            .run();
        expect((await check(reminder.id)).excluded).toContainEqual({ reason: "Opted out of email", count: 1, names: ["The Contact Household"] });
        // Contact readiness shows it.
        const rows = (await apiCall<{ households: HouseholdRow[] }>("GET", "/api/portal/wedding/households/overview")).json.households;
        expect(rows.find((r) => r.id === home.id)?.contact.flags).toContain("opted_out");
    });

    it("honours STOP from a household's own number, and from a guest who shares it", async () => {
        const { home } = await householdOnly();
        const shared = (await apiCall<{ guest: Guest }>("POST", "/api/portal/wedding/guests", { firstName: "Sha", lastName: "Red", phone: "0412 000 111" }))
            .json.guest;
        expect(
            (
                await call(`/api/comms/webhooks/clicksend-inbound/${SECRET}`, {
                    method: "POST",
                    env: await portalEnv({ COMMS_WEBHOOK_SECRET: SECRET, SMS_DELIVERY: "clicksend", CLICKSEND_USERNAME: "u", CLICKSEND_API_KEY: "k" }),
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ from: "+61412000111", body: "STOP", message_id: "in-stop" }),
                })
            ).status,
        ).toBe(200);
        expect(await db().prepare("SELECT sms_opt_out_at IS NOT NULL AS out FROM households WHERE id = ?").bind(home.id).first()).toEqual({ out: 1 });
        expect(await db().prepare("SELECT sms_opt_out_at IS NOT NULL AS out FROM guests WHERE id = ?").bind(shared.id).first()).toEqual({ out: 1 });
        const sms = (await prepare({ channel: "sms", category: "save_the_date", subject: "Save the date", body: "{{website_link}}", audience: {} })).json
            .message;
        const rows = await recipients(sms.id);
        expect(rows.find((r) => r.household_id === home.id)?.error).toBe("Opted out of texts");
        expect(rows.find((r) => r.guest_id === shared.id)?.error).toBe("Opted out of texts");
        // Manual replies to that number are refused too.
        expect((await apiCall("POST", "/api/portal/wedding/sms", { phone: "0412 000 111", body: "Hi" })).status).toBe(422);
    });

    it("treats a household's opt-out as covering a guest who shares its email address", async () => {
        const { home } = await householdOnly();
        await db().prepare("UPDATE households SET email_opt_out_at = '2027-01-01T00:00:00.000Z' WHERE id = ?").bind(home.id).run();
        const same = (
            await apiCall<{ guest: Guest }>("POST", "/api/portal/wedding/guests", { firstName: "Sam", lastName: "Address", email: "HOME@example.com" })
        ).json.guest;
        const message = (await prepare({ category: "update", subject: "News", body: "Hi", audience: { mode: "specific", guestIds: [same.id] } })).json.message;
        expect((await recipients(message.id))[0]).toMatchObject({ status: "skipped", error: "Opted out of email" });
    });
});

describe("controlled test sends", () => {
    it("go only to approved test addresses, are labelled as tests and never count as contacting a household", async () => {
        const f = await setup();
        const message = (
            await prepare({
                category: "invitation",
                subject: "You're invited",
                body: "Dear {{greeting_names}}, {{rsvp_link}}",
                audience: { householdIds: [f.couple.id] },
            })
        ).json.message;
        const { env, send: provider } = await emailEnv();
        const test = (to: string, householdId: string | null = null) =>
            apiCall<{ ok: boolean }>("POST", `/api/portal/wedding/messages/${message.id}/test`, { to, householdId }, { env });

        expect((await test("owner@example.com")).text).toContain("Add a test recipient");
        await apiCall("PUT", "/api/portal/settings/comms", { testEmails: ["Owner@Example.com"], testMobiles: ["0400 000 001"], smsCentsPerPart: 8 });
        // Never to a guest, even one in this message.
        expect((await test("fred@example.com")).status).toBe(422);
        expect(provider).not.toHaveBeenCalled();

        // Works with the delivery switch off: the switch protects guests, and tests never reach them.
        expect((await test("owner@example.com")).status).toBe(200);
        expect((await test("owner@example.com", f.couple.id)).status).toBe(200);
        expect(provider).toHaveBeenCalledTimes(2);
        const [sample, real] = provider.mock.calls.map((c) => c[0]);
        expect(sample.to.email).toBe("owner@example.com");
        expect(sample.subject).toBe("[TEST] You're invited");
        expect(sample.text).toMatch(/^TEST - sent only to owner@example.com\. No guest has received this\./);
        expect(sample.text).toContain("Dear Alex,");
        expect(sample.html).toContain("No guest has received this");
        expect(real.text).toContain("Dear Fred & Ann,");

        // Nothing about the household or the message changed.
        expect((await recipients(message.id)).filter((r) => r.status === "pending")).toHaveLength(1);
        expect(await db().prepare("SELECT COUNT(*) AS n FROM message_recipients WHERE status = 'sent'").first()).toEqual({ n: 0 });
        expect((await db().prepare("SELECT recipient, status FROM message_tests").all()).results).toEqual([
            { recipient: "owner@example.com", status: "sent" },
            { recipient: "owner@example.com", status: "sent" },
        ]);
        expect((await check(message.id)).tests).toHaveLength(2);
        const timeline = await apiCall<{ entries: TimelineEntry[] }>("GET", `/api/portal/wedding/households/${f.couple.id}/timeline`);
        expect(timeline.json.entries.map((e) => e.outcome)).toEqual(["prepared"]);
    });
});

describe("final information", () => {
    it("uses only confirmed details, the household's own bus answer, and only reaches households who are coming", async () => {
        const f = await setup();
        await db()
            .prepare("INSERT INTO rsvp_travel (household_id, bus, outbound_count, return_count, updated_at) VALUES (?, 'both', 2, 1, 'now')")
            .bind(f.family.id)
            .run();
        const preview = await apiCall<{ body: string }>("POST", "/api/portal/wedding/messages/preview", {
            category: "final_details",
            subject: "Final details",
            body: "{{event_schedule}}\n\n{{household_transport}}",
            householdId: f.family.id,
        });
        expect(preview.json.body).toBe(
            "Ceremony: 2:00 pm\nReception: time to be confirmed\n\nCourtesy bus: you've asked for 1 seat to the wedding and 1 seat home. The Dubbo RSL will confirm pick-up times closer to the day.",
        );

        const message = await prepare({ category: "final_details", subject: "Final details", body: "{{event_schedule}}" });
        const rows = await recipients(message.json.message.id);
        expect(
            rows
                .filter((r) => r.status === "pending")
                .map((r) => r.name)
                .sort(),
        ).toEqual(["Kate Replied", "Sam & Tom Sample"]);
        expect(rows.find((r) => r.guest_id === f.fred.id)?.error).toBe("No one in this household is coming");
        expect((await check(message.json.message.id)).warnings).toContain("Some events have no time yet; they'll say “time to be confirmed”.");
    });
});

describe("thank you", () => {
    it("adds a personal note per household, drops empty optional lines and prints a card for each household", async () => {
        const f = await setup();
        expect((await apiCall("PUT", `/api/portal/wedding/thank-you-notes/${f.family.id}`, { note: "Thank you for the beautiful vase." })).status).toBe(200);
        const body = "Dear {{greeting_names}},\n\n{{thank_you_message}}\n\n{{personal_note}}\n\nPhotos: {{gallery_link}}";
        const preview = (householdId: string) =>
            apiCall<{ body: string; html: string }>("POST", "/api/portal/wedding/messages/preview", {
                category: "thank_you",
                subject: "Thank you",
                body,
                householdId,
            });
        const family = (await preview(f.family.id)).json;
        expect(family.body).toContain("Thank you for the beautiful vase.");
        expect(family.body).not.toContain("Photos:");
        expect((await preview(f.couple.id)).json.body).not.toContain("vase");
        // The note itself never reaches the audit log.
        expect(JSON.stringify((await db().prepare("SELECT changes FROM audit_log WHERE action = 'household.thank_you_note'").all()).results)).not.toContain(
            "vase",
        );

        const pdf = await apiCall("POST", "/api/portal/wedding/studio/cards.pdf", { kind: "thank_you", householdIds: [f.family.id, f.couple.id] });
        expect(pdf.status).toBe(200);
        expect(pdf.headers.get("Content-Type")).toBe("application/pdf");
        expect(pdf.text.startsWith("%PDF")).toBe(true);
        const std = await apiCall("POST", "/api/portal/wedding/studio/cards.pdf", { kind: "save_the_date", householdIds: [f.couple.id] });
        expect(std.status).toBe(200);
        await apiCall("POST", "/api/portal/users", { email: "editor@example.com", role: "editor" });
        expect(
            (
                await apiCall(
                    "POST",
                    "/api/portal/wedding/studio/cards.pdf",
                    { kind: "save_the_date", householdIds: [f.couple.id] },
                    { email: "editor@example.com" },
                )
            ).status,
        ).toBe(403);
    });
});

describe("the send check", () => {
    it("summarises recipients, exclusions with reasons, link warnings and SMS cost", async () => {
        const f = await setup();
        await apiCall("PATCH", `/api/portal/wedding/guests/${f.sam.id}`, { phone: "0412 345 678" });
        await apiCall("PUT", "/api/portal/settings/comms", { testEmails: [], testMobiles: [], smsCentsPerPart: 8 });
        const message = (await prepare({ channel: "sms", category: "reminder", subject: "Reminder", body: "Please RSVP: {{rsvp_link}}" })).json.message;
        const plan = await check(message.id);
        expect(plan).toMatchObject({ category: "reminder", channel: "sms", households: 1, recipients: 1, deliveryAvailable: false });
        expect(plan.excluded).toContainEqual({ reason: "No mobile number", count: 2, names: ["Ann Example", "Fred Example"] });
        expect(plan.warnings).toContain("Native RSVP is switched off, so RSVP links won't open the RSVP form until it's switched on.");
        expect(plan.warnings).toContain("The wedding website isn't published yet, so links to it won't open for guests.");
        expect(plan.sms).toMatchObject({ parts: 1, maxParts: 1, estimatedCents: 8 });
    });
});

describe("contact readiness and household history", () => {
    it("flags how each household can be reached", async () => {
        const f = await setup();
        await apiCall("PATCH", `/api/portal/wedding/guests/${f.sam.id}`, { phone: "0412 345 678" });
        await db().prepare("UPDATE guests SET phone = '02 6884 0000' WHERE id = ?").bind(f.tom.id).run();
        await db().prepare("UPDATE guests SET email = NULL WHERE id = ?").bind(f.kate.id).run();
        const rows = (await apiCall<{ households: HouseholdRow[] }>("GET", "/api/portal/wedding/households/overview")).json.households;
        const flags = (id: string) => rows.find((r) => r.id === id)!.contact.flags;
        expect(flags(f.couple.id)).toEqual(["no_mobile", "email_only"]);
        expect(flags(f.family.id)).toEqual(["invalid_mobile"]);
        expect(flags(f.done.id)).toEqual(["no_contact", "unreachable", "no_email", "no_mobile"]);
    });

    it("shows a household's messages, holds and replies in one timeline", async () => {
        const f = await setup();
        const message = (await prepare({ category: "save_the_date", subject: "Save the date", body: "{{website_link}}" })).json.message;
        const { env } = await emailEnv();
        await switchEmailOn();
        await send(message.id, env, { confirmCount: 3 });
        await db()
            .prepare(
                "INSERT INTO sms_messages (id, direction, phone, guest_id, household_id, body, status, created_by, created_at) VALUES ('s1', 'inbound', '+61412345678', ?, ?, 'See you there!', 'received', 'webhook', '2030-01-01T00:00:00.000Z')",
            )
            .bind(f.fred.id, f.couple.id)
            .run();
        const entries = (await apiCall<{ entries: TimelineEntry[] }>("GET", `/api/portal/wedding/households/${f.couple.id}/timeline`)).json.entries;
        expect(entries[0]).toMatchObject({ kind: "reply", detail: "See you there!", outcome: "received" });
        expect(entries[1]).toMatchObject({ kind: "message", title: "Save the date: Save the date", outcome: "sent", detail: "Email to Fred & Ann Example" });
        // Viewers see that a reply arrived, not what it says.
        await apiCall("POST", "/api/portal/users", { email: "viewer@example.com", role: "viewer" });
        const viewer = (
            await apiCall<{ entries: TimelineEntry[] }>("GET", `/api/portal/wedding/households/${f.couple.id}/timeline`, undefined, {
                email: "viewer@example.com",
            })
        ).json.entries;
        expect(viewer[0].detail).toBe("Open Text conversations to read it");
    });
});

describe("stationery email", () => {
    it("escapes every string, links only https URLs with readable text, and reads without images", () => {
        const html = stationeryEmailHtml({
            kind: "invitation",
            text: 'Dear <Fred> & "Ann",\n\nReply: https://wedding.daly.id.au/rsvp?invite=abc.1 now.\n\njavascript:alert(1)',
            coupleNames: "Amelia & Aidan",
            weddingDate: "Saturday 23 October 2027",
            assetOrigin: "https://wedding.daly.id.au",
            action: { label: "Reply to your invitation", url: "https://wedding.daly.id.au/rsvp?invite=abc.1" },
        });
        expect(html).toContain("Dear &lt;Fred&gt; &amp; &quot;Ann&quot;,");
        expect(html).toContain('<a href="https://wedding.daly.id.au/rsvp?invite=abc.1" style=');
        expect(html).toContain(">wedding.daly.id.au/rsvp</a> now.");
        expect(html).not.toContain('href="javascript');
        // Decorative artwork only; every word is live text.
        expect([...html.matchAll(/<img [^>]*alt="([^"]*)"/g)].map((m) => m[1])).toEqual(["", ""]);
        expect(html).toContain("Amelia<br>");
    });
});

describe("migration 0012", () => {
    it("only adds two empty consent columns to households", async () => {
        const { default: sql } = await import("../migrations/0012_household_consent.sql?raw");
        const statements = sql
            .split("\n")
            .filter((line: string) => !line.trim().startsWith("--"))
            .join("\n")
            .split(";")
            .map((statement: string) => statement.trim())
            .filter(Boolean);
        expect(statements).toEqual(["ALTER TABLE households ADD COLUMN email_opt_out_at TEXT", "ALTER TABLE households ADD COLUMN sms_opt_out_at TEXT"]);
    });
});

describe("migration 0011", () => {
    it("is additive and records the household on earlier recipient rows", async () => {
        const { default: sql } = await import("../migrations/0011_communications_studio.sql?raw");
        const code = sql
            .split("\n")
            .filter((line: string) => !line.trim().startsWith("--"))
            .join("\n");
        expect(code).not.toMatch(/\bDROP\b|(?<!ON )\bDELETE\b/);
        // The only UPDATEs fill the new household_id column.
        expect([...code.matchAll(/UPDATE (\w+)\s+SET (\w+)/g)].map((m) => `${m[1]}.${m[2]}`)).toEqual([
            "message_recipients.household_id",
            "message_recipients.household_id",
        ]);
        const columns = (await db().prepare("PRAGMA table_info(message_recipients)").all<{ name: string }>()).results.map((c) => c.name);
        expect(columns).toContain("household_id");
        for (const table of ["message_tests", "thank_you_notes"])
            expect(await db().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").bind(table).first()).toEqual({ name: table });
    });
});
