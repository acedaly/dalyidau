import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normaliseMobile } from "../src/shared/portal/phone";
import { isOptOutReply, smsSegments } from "../src/shared/portal/sms";
import type { Guest, Household, Message, RsvpHousehold, WeddingEvent } from "../src/shared/portal/types";
import { emailProvider, mailbox, smsProvider } from "../worker/comms/providers";
import type { Env } from "../worker/env";
import { apiCall, call, db, portalEnv, resetPortal } from "./portal-helpers";

beforeEach(resetPortal);
afterEach(() => vi.restoreAllMocks());

const SECRET = "webhook-secret-0123456789abcdef";

const clicksendEnv = (overrides: Partial<Env> = {}) =>
    portalEnv({
        SMS_DELIVERY: "clicksend",
        CLICKSEND_USERNAME: "user",
        CLICKSEND_API_KEY: "key",
        SMS_FROM: "+61400000000",
        COMMS_WEBHOOK_SECRET: SECRET,
        ...overrides,
    });

const smtp2goEnv = (overrides: Partial<Env> = {}) =>
    portalEnv({
        EMAIL_DELIVERY: "smtp2go",
        SMTP2GO_API_KEY: "api-test-key",
        EMAIL_FROM: '"Aidan & Amelia" <wedding@daly.id.au>',
        COMMS_WEBHOOK_SECRET: SECRET,
        ...overrides,
    });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function guests() {
    const household = (await apiCall<{ item: Household }>("POST", "/api/portal/wedding/households", { name: "The Texters" })).json.item;
    const guest = async (body: Record<string, unknown>) =>
        (await apiCall<{ guest: Guest }>("POST", "/api/portal/wedding/guests", { householdId: household.id, ...body })).json.guest;
    // The portal no longer accepts a landline, so this one stands in for a number saved before it checked.
    const landline = await guest({ firstName: "Lan", lastName: "Dline" });
    await db().prepare("UPDATE guests SET phone = '02 6884 0000' WHERE id = ?").bind(landline.id).run();
    return {
        household,
        mobile: await guest({ firstName: "Mo", lastName: "Bile", phone: "0412 345 678", email: "mo@example.com" }),
        landline,
        none: await guest({ firstName: "No", lastName: "Phone" }),
    };
}

const webhook = (provider: string, body: unknown, env: Promise<Env>, secret = SECRET) =>
    env.then((e) =>
        call(`/api/comms/webhooks/${provider}/${secret}`, {
            method: "POST",
            env: e,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        }),
    );

describe("phone numbers and SMS length", () => {
    it("normalises Australian mobiles and rejects landlines", () => {
        expect(normaliseMobile("0412 345 678")).toBe("+61412345678");
        expect(normaliseMobile("+61 412 345 678")).toBe("+61412345678");
        expect(normaliseMobile("61412345678")).toBe("+61412345678");
        expect(normaliseMobile("(02) 6884 0000")).toBeNull();
        expect(normaliseMobile("+61 2 6884 0000")).toBeNull();
        expect(normaliseMobile("+64 21 123 4567")).toBe("+64211234567");
        expect(normaliseMobile("")).toBeNull();
    });

    it("counts SMS parts for plain and Unicode text", () => {
        expect(smsSegments("a".repeat(160))).toEqual({ encoding: "gsm", length: 160, segments: 1 });
        expect(smsSegments("a".repeat(161)).segments).toBe(2);
        expect(smsSegments("€").length).toBe(2);
        expect(smsSegments("We’re getting married").encoding).toBe("unicode");
        expect(smsSegments("x".repeat(71) + "’").segments).toBe(2);
    });

    it("recognises opt-out replies only when they are the whole message", () => {
        expect(isOptOutReply("STOP")).toBe(true);
        expect(isOptOutReply(" unsubscribe. ")).toBe(true);
        expect(isOptOutReply("Don't stop the music!")).toBe(false);
    });
});

describe("providers", () => {
    it("exist only when chosen deliberately with credentials, and log mode never in production", async () => {
        expect(emailProvider(await portalEnv())).toBeNull();
        expect(emailProvider(await portalEnv({ EMAIL_DELIVERY: "smtp2go", EMAIL_FROM: "a@b.c" }))).toBeNull();
        expect(emailProvider(await smtp2goEnv())?.name).toBe("smtp2go");
        expect(emailProvider(await portalEnv({ EMAIL_DELIVERY: "log", ENVIRONMENT: "production" }))).toBeNull();
        expect(smsProvider(await portalEnv({ SMS_DELIVERY: "clicksend" }))).toBeNull();
        expect(smsProvider(await clicksendEnv())?.name).toBe("clicksend");
        expect(smsProvider(await portalEnv({ SMS_DELIVERY: "log", ENVIRONMENT: "production" }))).toBeNull();
    });

    it("sends through SMTP2Go with the key in a header and treats reported failures as errors", async () => {
        const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json({ data: { succeeded: 1, failed: 0, email_id: "smtp-1" } }));
        const provider = emailProvider(await smtp2goEnv())!;
        await expect(provider.send({ to: "jo@example.com", toName: 'Jo "The" Guest', subject: "Hi", text: "Hello", html: "<p>Hello</p>" })).resolves.toEqual({
            providerId: "smtp-1",
        });
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe("https://api.smtp2go.com/v3/email/send");
        expect(new Headers(init.headers).get("X-Smtp2go-Api-Key")).toBe("api-test-key");
        const body = JSON.parse(String(init.body));
        expect(body).toMatchObject({ sender: '"Aidan & Amelia" <wedding@daly.id.au>', to: ['"Jo The Guest" <jo@example.com>'], subject: "Hi" });
        expect(String(init.body)).not.toContain("api-test-key");

        fetchMock.mockResolvedValueOnce(json({ data: { succeeded: 0, failed: 1, failures: ["mailbox unavailable"] } }));
        await expect(provider.send({ to: "x@example.com", toName: "X", subject: "Hi", text: "Hello", html: "" })).rejects.toThrow(/mailbox unavailable/);
        expect(mailbox("a@b.c")).toBe("a@b.c");
    });

    it("sends through ClickSend with basic auth and records the price", async () => {
        const fetchMock = vi
            .spyOn(globalThis, "fetch")
            .mockResolvedValueOnce(
                json({ response_code: "SUCCESS", data: { messages: [{ status: "SUCCESS", message_id: "cs-1", message_price: "0.0770" }] } }),
            );
        const result = await smsProvider(await clicksendEnv())!.send({ to: "+61412345678", body: "Hello" });
        expect(result).toEqual({ providerId: "cs-1", costCents: 7.7 });
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe("https://rest.clicksend.com/v3/sms/send");
        expect(new Headers(init.headers).get("Authorization")).toBe(`Basic ${btoa("user:key")}`);
        expect(JSON.parse(String(init.body)).messages[0]).toMatchObject({ to: "+61412345678", body: "Hello", from: "+61400000000" });

        fetchMock.mockResolvedValueOnce(json({ response_code: "SUCCESS", data: { messages: [{ status: "INVALID_RECIPIENT" }] } }));
        await expect(smsProvider(await clicksendEnv())!.send({ to: "+61412345678", body: "Hello" })).rejects.toThrow(/INVALID_RECIPIENT/);
    });
});

describe("SMS campaigns", () => {
    const prepareSms = () =>
        apiCall<{ message: Message }>("POST", "/api/portal/wedding/messages", {
            channel: "sms",
            category: "update",
            subject: "Bus update",
            body: "Hi {{first_name}}, Aidan & Amelia here.",
            audience: {},
        });

    it("snapshots mobile numbers, skips landlines and missing numbers, and stays inert until switched on", async () => {
        const people = await guests();
        const message = (await prepareSms()).json.message;
        expect(message.channel).toBe("sms");
        const rows = await db()
            .prepare("SELECT guest_id, phone, status, error FROM message_recipients WHERE message_id = ? ORDER BY guest_id")
            .bind(message.id)
            .all<{ guest_id: string; phone: string | null; status: string; error: string | null }>();
        const byGuest = Object.fromEntries(rows.results.map((r) => [r.guest_id, r]));
        expect(byGuest[people.mobile.id]).toMatchObject({ phone: "+61412345678", status: "pending" });
        expect(byGuest[people.landline.id]).toMatchObject({ phone: null, status: "skipped", error: "Mobile number isn't valid" });
        expect(byGuest[people.none.id]).toMatchObject({ status: "skipped", error: "No mobile number" });

        const fetchMock = vi.spyOn(globalThis, "fetch");
        const env = await clicksendEnv();
        // Provider configured, switch off: refused, nothing contacted.
        expect((await apiCall("POST", `/api/portal/wedding/messages/${message.id}/send`, {}, { env })).status).toBe(422);
        // Email switch on doesn't open SMS.
        await apiCall("PUT", "/api/portal/flags/communications.delivery", { enabled: true });
        expect((await apiCall("POST", `/api/portal/wedding/messages/${message.id}/send`, {}, { env })).status).toBe(422);
        expect(fetchMock).not.toHaveBeenCalled();

        await apiCall("PUT", "/api/portal/flags/communications.sms", { enabled: true });
        fetchMock.mockResolvedValueOnce(json({ data: { messages: [{ status: "SUCCESS", message_id: "cs-9", message_price: "0.08" }] } }));
        const sent = await apiCall<{ message: Message }>("POST", `/api/portal/wedding/messages/${message.id}/send`, {}, { env });
        expect(sent.json.message.status).toBe("sent");
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)).messages[0].body).toBe("Hi Mo, Aidan & Amelia here.");
        expect(await db().prepare("SELECT provider_id, cost_cents, attempts FROM message_recipients WHERE status = 'sent'").first()).toEqual({
            provider_id: "cs-9",
            cost_cents: 8,
            attempts: 1,
        });
        expect(await db().prepare("SELECT direction, phone, guest_id, status FROM sms_messages").first()).toEqual({
            direction: "outbound",
            phone: "+61412345678",
            guest_id: people.mobile.id,
            status: "sent",
        });
    });

    it("retries only failed recipients, at most three times", async () => {
        await guests();
        const message = (await prepareSms()).json.message;
        const env = await clicksendEnv();
        await apiCall("PUT", "/api/portal/flags/communications.sms", { enabled: true });
        const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ response_code: "INTERNAL_ERROR" }, 500));
        expect((await apiCall<{ message: Message }>("POST", `/api/portal/wedding/messages/${message.id}/send`, {}, { env })).json.message.status).toBe(
            "failed",
        );
        expect((await apiCall<{ message: Message }>("POST", `/api/portal/wedding/messages/${message.id}/retry`, {}, { env })).json.message.status).toBe(
            "failed",
        );
        fetchMock.mockResolvedValue(json({ data: { messages: [{ status: "SUCCESS", message_id: "cs-ok" }] } }));
        expect((await apiCall<{ message: Message }>("POST", `/api/portal/wedding/messages/${message.id}/retry`, {}, { env })).json.message.status).toBe("sent");
        expect(await db().prepare("SELECT attempts, status FROM message_recipients WHERE status = 'sent'").first()).toEqual({ attempts: 3, status: "sent" });
        // Nothing left to retry.
        expect((await apiCall("POST", `/api/portal/wedding/messages/${message.id}/retry`, {}, { env })).status).toBe(422);
    });

    it("lets only people with the communications permission read conversations", async () => {
        await apiCall("POST", "/api/portal/users", { email: "viewer@example.com", role: "viewer" });
        expect((await apiCall("GET", "/api/portal/wedding/sms", undefined, { email: "viewer@example.com" })).status).toBe(403);
        expect((await apiCall("GET", "/api/portal/wedding/sms")).status).toBe(200);
        const reply = await apiCall("POST", "/api/portal/wedding/sms", { phone: "0412345678", body: "Hi" });
        expect(reply.status).toBe(422); // SMS is switched off
    });
});

describe("provider webhooks", () => {
    it("are invisible without the secret", async () => {
        expect((await webhook("smtp2go", { event: "delivered" }, portalEnv())).status).toBe(404);
        expect((await webhook("smtp2go", { event: "delivered" }, smtp2goEnv(), "wrong-secret")).status).toBe(404);
        expect((await webhook("unknown", { event: "delivered" }, smtp2goEnv())).status).toBe(404);
        const get = await call(`/api/comms/webhooks/smtp2go/${SECRET}`, { env: await smtp2goEnv() });
        expect(get.status).toBe(404);
    });

    it("record SMTP2Go deliveries and bounces once, and honour spam complaints", async () => {
        const people = await guests();
        await db()
            .prepare(
                "INSERT INTO messages (id, subject, body, audience, status, recipient_count, created_by, created_at) VALUES ('msg_w', 'S', 'B', '{}', 'sent', 1, 'x', 'now')",
            )
            .run();
        await db()
            .prepare(
                "INSERT INTO message_recipients (message_id, guest_id, name, email, status, provider_id) VALUES ('msg_w', ?, 'Mo', 'mo@example.com', 'sent', 'em-1')",
            )
            .bind(people.mobile.id)
            .run();
        const event = { event: "delivered", email_id: "em-1", rcpt: "mo@example.com", time: "2027-01-01T00:00:00Z" };
        expect((await webhook("smtp2go", event, smtp2goEnv())).status).toBe(200);
        expect((await webhook("smtp2go", event, smtp2goEnv())).status).toBe(200);
        expect(await db().prepare("SELECT COUNT(*) AS n FROM comm_webhook_events").first()).toEqual({ n: 1 });
        expect(await db().prepare("SELECT delivery_status FROM message_recipients").first()).toEqual({ delivery_status: "delivered" });

        await webhook("smtp2go", { event: "spam", email_id: "em-1", rcpt: "mo@example.com", time: "2027-01-02T00:00:00Z" }, smtp2goEnv());
        expect(await db().prepare("SELECT email_opt_out_at IS NOT NULL AS out FROM guests WHERE id = ?").bind(people.mobile.id).first()).toEqual({ out: 1 });

        // A later email campaign skips them.
        const message = (await apiCall<{ message: Message }>("POST", "/api/portal/wedding/messages", { subject: "S", body: "B", audience: {} })).json.message;
        expect(
            await db().prepare("SELECT status, error FROM message_recipients WHERE message_id = ? AND guest_id = ?").bind(message.id, people.mobile.id).first(),
        ).toEqual({ status: "skipped", error: "Opted out of email" });
    });

    it("store ClickSend replies against the guest and stop texting anyone who replies STOP", async () => {
        const people = await guests();
        const inbound = { from: "+61412345678", body: "STOP", message_id: "in-1", timestamp: "1700000000" };
        expect((await webhook("clicksend-inbound", inbound, clicksendEnv())).status).toBe(200);
        await webhook("clicksend-inbound", inbound, clicksendEnv());
        expect(await db().prepare("SELECT direction, guest_id, body, status FROM sms_messages").all()).toMatchObject({
            results: [{ direction: "inbound", guest_id: people.mobile.id, body: "STOP", status: "received" }],
        });
        expect(await db().prepare("SELECT sms_opt_out_at IS NOT NULL AS out FROM guests WHERE id = ?").bind(people.mobile.id).first()).toEqual({ out: 1 });

        const threads = await apiCall<{ threads: { phone: string; unread: number; optedOut: boolean }[] }>("GET", "/api/portal/wedding/sms");
        expect(threads.json.threads).toEqual([expect.objectContaining({ phone: "+61412345678", unread: 1, optedOut: true })]);
        const conversation = await apiCall<{ messages: unknown[] }>("GET", `/api/portal/wedding/sms/${encodeURIComponent("+61412345678")}`);
        expect(conversation.json.messages).toHaveLength(1);
        expect((await apiCall<{ threads: { unread: number }[] }>("GET", "/api/portal/wedding/sms")).json.threads[0].unread).toBe(0);

        const message = (await apiCall<{ message: Message }>("POST", "/api/portal/wedding/messages", { channel: "sms", subject: "S", body: "B", audience: {} }))
            .json.message;
        expect(
            await db().prepare("SELECT status, error FROM message_recipients WHERE message_id = ? AND guest_id = ?").bind(message.id, people.mobile.id).first(),
        ).toEqual({ status: "skipped", error: "Opted out of texts" });
    });

    it("apply ClickSend delivery receipts", async () => {
        await db()
            .prepare(
                "INSERT INTO sms_messages (id, direction, phone, body, status, provider_id, created_by, created_at) VALUES ('sms_1', 'outbound', '+61412345678', 'Hi', 'sent', 'cs-7', 'x', 'now')",
            )
            .run();
        await webhook("clicksend-receipt", { message_id: "cs-7", status_text: "Delivered", timestamp: "1700000001" }, clicksendEnv());
        expect(await db().prepare("SELECT status FROM sms_messages").first()).toEqual({ status: "delivered" });
    });
});

describe("RSVP confirmation email", () => {
    async function household() {
        const event = (await apiCall<{ item: WeddingEvent }>("POST", "/api/portal/wedding/events", { name: "Ceremony", startsAt: "2027-10-23T15:30" })).json
            .item;
        const home = (await apiCall<{ item: Household }>("POST", "/api/portal/wedding/households", { name: "The Repliers" })).json.item;
        const guest = (await apiCall<{ guest: Guest }>("POST", "/api/portal/wedding/guests", { firstName: "Ren", householdId: home.id, events: [event.id] }))
            .json.guest;
        return { event, home, guest };
    }
    const reply = (env: Env, code: string, guestId: string, eventId: string, email: string) =>
        apiCall<{ household: RsvpHousehold; confirmationSent: boolean }>(
            "POST",
            "/api/portal/wedding/rsvp-test/submit",
            { code, clientId: crypto.randomUUID(), guests: [{ guestId, events: { [eventId]: "attending" } }], email },
            { env },
        );

    it("is sent only with the RSVP setting, the email switch and a provider, and is kept in history", async () => {
        const { event, home, guest } = await household();
        const env = await portalEnv({ EMAIL_DELIVERY: "log" });
        expect((await reply(env, home.rsvpCode, guest.id, event.id, "ren@example.com")).json.confirmationSent).toBe(false);

        await apiCall("PUT", "/api/portal/flags/communications.delivery", { enabled: true });
        expect((await reply(env, home.rsvpCode, guest.id, event.id, "ren@example.com")).json.confirmationSent).toBe(false);

        const settings = await apiCall<{ value: Record<string, unknown> }>("PUT", "/api/portal/settings/rsvp", {
            externalUrl: "",
            deadline: "",
            collectDietary: true,
            collectMessage: true,
            allowChangesAfterDeadline: false,
            allowCodes: true,
            linkExpiryDays: 60,
            confirmationEmail: true,
        });
        expect(settings.status).toBe(200);
        const sent = await reply(env, home.rsvpCode, guest.id, event.id, "ren@example.com");
        expect(sent.json.confirmationSent).toBe(true);
        expect(await db().prepare("SELECT category, status, created_by FROM messages").first()).toEqual({
            category: "rsvp_confirmation",
            status: "sent",
            created_by: `rsvp:${home.id}`,
        });
        expect(await db().prepare("SELECT email, status FROM message_recipients").first()).toEqual({ email: "ren@example.com", status: "sent" });
        expect(await db().prepare("SELECT body FROM messages").first<{ body: string }>()).toMatchObject({
            body: expect.stringContaining("Ren (Ceremony: attending)"),
        });
        // Without an email address in the reply, nothing is sent.
        expect((await reply(env, home.rsvpCode, guest.id, event.id, "")).json.confirmationSent).toBe(false);
    });

    it("never fails the RSVP when the email fails", async () => {
        const { event, home, guest } = await household();
        await apiCall("PUT", "/api/portal/flags/communications.delivery", { enabled: true });
        await db()
            .prepare("INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('rsvp', ?, 'now', 'x')")
            .bind(JSON.stringify({ confirmationEmail: true }))
            .run();
        vi.spyOn(globalThis, "fetch").mockResolvedValue(
            json({ data: { error: "Sender not verified", error_code: "E_ApiResponseCodes.SENDER_NOT_VERIFIED" } }, 400),
        );
        const result = await reply(await smtp2goEnv(), home.rsvpCode, guest.id, event.id, "ren@example.com");
        expect(result.status).toBe(200);
        expect(result.json.confirmationSent).toBe(false);
        expect(await db().prepare("SELECT status FROM guest_events").first()).toEqual({ status: "attending" });
        expect(await db().prepare("SELECT status, error FROM message_recipients").first()).toEqual({ status: "failed", error: "SMTP2Go: Sender not verified" });
    });
});

describe("erasure", () => {
    it("removes text conversations and webhook payloads that mention the guest", async () => {
        const people = await guests();
        await webhook("clicksend-inbound", { from: "+61412345678", body: "See you there", message_id: "in-9" }, clicksendEnv());
        expect(await db().prepare("SELECT COUNT(*) AS n FROM sms_messages").first()).toEqual({ n: 1 });
        await apiCall("DELETE", `/api/portal/wedding/guests/${people.mobile.id}`);
        const erased = await apiCall("POST", "/api/portal/privacy/erase", { type: "guest", id: people.mobile.id, confirm: "Mo Bile" });
        expect(erased.status).toBe(200);
        expect(await db().prepare("SELECT COUNT(*) AS n FROM sms_messages").first()).toEqual({ n: 0 });
        expect(await db().prepare("SELECT COUNT(*) AS n FROM comm_webhook_events").first()).toEqual({ n: 0 });
    });
});
