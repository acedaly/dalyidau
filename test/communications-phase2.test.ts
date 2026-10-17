import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Guest, Household, Message } from "../src/shared/portal/types";
import type { Env } from "../worker/env";
import { processDueMessages } from "../worker/portal/comms";
import { apiCall, db, portalEnv, resetPortal } from "./portal-helpers";

async function recipients() {
    const event = (await apiCall<{ item: { id: string } }>("POST", "/api/portal/wedding/events", { name: "Ceremony" })).json.item;
    const household = (await apiCall<{ item: Household }>("POST", "/api/portal/wedding/households", { name: "The Message Family" })).json.item;
    const guest = (
        await apiCall<{ guest: Guest }>("POST", "/api/portal/wedding/guests", {
            firstName: "Jo",
            lastName: "Message",
            email: "jo@example.com",
            householdId: household.id,
            events: [event.id],
        })
    ).json.guest;
    return { household, guest };
}

const prepare = (body: Partial<{ category: string; scheduledAt: string | null; subject: string }> = {}) =>
    apiCall<{ message: Message }>("POST", "/api/portal/wedding/messages", {
        category: body.category ?? "update",
        scheduledAt: body.scheduledAt ?? null,
        subject: body.subject ?? "Hello {{first_name}}",
        body: "A <safe> update with your link: {{rsvp_link}}",
        audience: {},
    });

beforeEach(resetPortal);

describe("communication safeguards", () => {
    it("categorises messages and deduplicates invitation recipients", async () => {
        await recipients();
        const first = await prepare({ category: "invitation", subject: "Invitation one" });
        expect(first.json.message).toMatchObject({ category: "invitation", status: "draft" });
        const second = await prepare({ category: "invitation", subject: "Invitation two" });
        expect(second.status).toBe(201);
        const rows = await db()
            .prepare("SELECT status, error FROM message_recipients WHERE message_id = ?")
            .bind(second.json.message.id)
            .all<{ status: string; error: string }>();
        expect(rows.results).toEqual([{ status: "skipped", error: "Already in an unsent draft for this household (nothing sent yet)" }]);
    });

    it("queues scheduled messages but never processes them while delivery is disabled", async () => {
        await recipients();
        const scheduled = await prepare({ scheduledAt: new Date(Date.now() + 60_000).toISOString() });
        expect(scheduled.json.message.status).toBe("queued");
        await db().prepare("UPDATE messages SET scheduled_at = '2020-01-01T00:00:00.000Z'").run();
        expect(await processDueMessages(await portalEnv())).toEqual({ processed: 0 });
        expect(await db().prepare("SELECT status FROM messages").first()).toEqual({ status: "queued" });
    });

    it("uses the Cloudflare binding only with both safeguards and records the provider id", async () => {
        await recipients();
        const message = (await prepare()).json.message;
        const send = vi.fn(async (_message: { to: { email: string; name?: string }; from: string; subject: string; text: string; html: string }) => ({
            messageId: "cf-message-123",
        }));
        const providerEnv = await portalEnv({
            EMAIL_DELIVERY: "cloudflare",
            EMAIL_FROM: "wedding@daly.id.au",
            EMAIL: { send } as unknown as Env["EMAIL"],
        });

        // A configured provider is still inert until the database feature flag is on.
        expect((await apiCall("POST", `/api/portal/wedding/messages/${message.id}/send`, {}, { env: providerEnv })).status).toBe(422);
        expect(send).not.toHaveBeenCalled();
        await apiCall("PUT", "/api/portal/flags/communications.delivery", { enabled: true });
        const result = await apiCall<{ message: Message }>("POST", `/api/portal/wedding/messages/${message.id}/send`, {}, { env: providerEnv });
        expect(result.json.message.status).toBe("sent");
        expect(send).toHaveBeenCalledOnce();
        expect(send.mock.calls[0][0]).toMatchObject({
            to: { email: "jo@example.com", name: "Jo Message" },
            from: "wedding@daly.id.au",
            text: expect.stringContaining("<safe>"),
            html: expect.stringContaining("&lt;safe&gt;"),
        });
        expect(await db().prepare("SELECT provider_id FROM message_recipients").first()).toEqual({ provider_id: "cf-message-123" });
    });
});
