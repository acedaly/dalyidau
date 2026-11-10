// Phase 0, experiment 5: a scheduled wedding email goes out through the combined Worker's cron exactly
// once, using the development "log" provider (nothing is ever sent). Webhooks, signatures, dedupe and
// opt-outs are covered by the existing communications suites, which run through the same router.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { apiCall, db, portalEnv, resetPortal } from "../../../test/portal-helpers";
import worker, { payloadCalls } from "./platform-under-test";

beforeEach(async () => {
    await resetPortal();
    payloadCalls.length = 0;
});

const cron = async (env: unknown) => {
    const ctx = createExecutionContext();
    await worker.scheduled({ cron: "*/15 * * * *", scheduledTime: Date.now(), noRetry() {} } as ScheduledController, env as never, ctx);
    await waitOnExecutionContext(ctx);
};

it("sends a due scheduled message once from the combined cron, and never twice", async () => {
    const env = await portalEnv({ EMAIL_DELIVERY: "log", ENVIRONMENT: "development" });
    const event = (await apiCall<{ item: { id: string } }>("POST", "/api/portal/wedding/events", { name: "Ceremony" })).json.item;
    const household = (await apiCall<{ item: { id: string } }>("POST", "/api/portal/wedding/households", { name: "The Cron Family" })).json.item;
    await apiCall("POST", "/api/portal/wedding/guests", { firstName: "Cee", lastName: "Ron", email: "cee@example.com", householdId: household.id, events: [event.id] });
    await apiCall("PUT", "/api/portal/flags/communications.delivery", { enabled: true });
    const queued = await apiCall<{ message: { id: string; status: string } }>("POST", "/api/portal/wedding/messages", {
        category: "update",
        scheduledAt: new Date(Date.now() + 60_000).toISOString(),
        subject: "Hello {{first_name}}",
        body: "Invented update.",
        audience: {},
    });
    expect(queued.json.message.status).toBe("queued");
    await db().prepare("UPDATE messages SET scheduled_at = '2020-01-01T00:00:00.000Z'").run();

    await cron(env);
    expect(await db().prepare("SELECT status FROM messages").first()).toEqual({ status: "sent" });
    const sent = await db().prepare("SELECT COUNT(*) AS n FROM message_recipients WHERE status = 'sent'").first<{ n: number }>();
    expect(sent?.n).toBe(1);

    await cron(env);
    expect((await db().prepare("SELECT COUNT(*) AS n FROM message_recipients WHERE status = 'sent'").first<{ n: number }>())?.n).toBe(1);
    // The wedding cron never involves Payload.
    expect(payloadCalls).toEqual([]);
});
