// Provider webhooks: delivery reports and bounces from SMTP2Go, delivery receipts and inbound
// replies from ClickSend.
//
//   POST /api/comms/webhooks/smtp2go?key=<COMMS_WEBHOOK_SECRET>
//   POST /api/comms/webhooks/clicksend-receipt?key=<COMMS_WEBHOOK_SECRET>
//   POST /api/comms/webhooks/clicksend-inbound?key=<COMMS_WEBHOOK_SECRET>
//
// These are public URLs (providers can't sign in through Cloudflare Access), so the secret is the
// credential: without COMMS_WEBHOOK_SECRET configured every request is a 404, and a wrong secret
// looks exactly the same. It goes in the query string because Cloudflare's request logs and traces
// drop query strings (observability.redact_query_string) but keep paths. The older form with the
// secret as a final path segment still works so existing provider settings keep working; our own
// logs mask it (lib/log.ts), but move providers to the query form and rotate the secret. Every payload is stored once (a unique dedupe key makes
// provider retries harmless) and then applied to message history. Field names vary between
// provider versions, so parsing is tolerant and anything unrecognised is kept for inspection.
import type { Env } from "../env";
import { receiveSms } from "../portal/comms";
import { newId, nowIso } from "../portal/db";
import { HttpError, readText } from "../portal/http";

type Payload = Record<string, unknown>;
const PROVIDERS = ["smtp2go", "clicksend-receipt", "clicksend-inbound"] as const;
type Provider = (typeof PROVIDERS)[number];

const notFound = () => new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
const ok = (body: Record<string, unknown> = { ok: true }) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

/** Compares secrets in constant time (for equal lengths) so timing doesn't reveal them. */
async function sameSecret(given: string, expected: string) {
    const encoder = new TextEncoder();
    const [a, b] = await Promise.all([crypto.subtle.digest("SHA-256", encoder.encode(given)), crypto.subtle.digest("SHA-256", encoder.encode(expected))]);
    const x = new Uint8Array(a);
    const y = new Uint8Array(b);
    let diff = 0;
    for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
    return diff === 0;
}

async function readPayload(request: Request): Promise<Payload | Payload[] | null> {
    const type = request.headers.get("Content-Type") ?? "";
    let text: string;
    try {
        text = await readText(request, 64_000);
    } catch (error) {
        if (error instanceof HttpError) return null;
        throw error;
    }
    if (type.includes("json") || /^\s*[[{]/.test(text)) {
        try {
            return JSON.parse(text) as Payload | Payload[];
        } catch {
            return null;
        }
    }
    return Object.fromEntries(new URLSearchParams(text));
}

const pick = (payload: Payload, ...keys: string[]) => {
    for (const key of keys) {
        const value = payload[key];
        if (typeof value === "string" && value) return value;
        if (typeof value === "number") return String(value);
    }
    return null;
};

/** Maps SMTP2Go event names to our delivery statuses. Unknown events are stored but not applied. */
const SMTP2GO_EVENTS: Record<string, { status: string; failed?: boolean; optOut?: boolean }> = {
    delivered: { status: "delivered" },
    bounce: { status: "bounced", failed: true },
    hard_bounce: { status: "bounced", failed: true },
    soft_bounce: { status: "soft bounce" },
    reject: { status: "rejected", failed: true },
    spam: { status: "complained", optOut: true },
    unsubscribe: { status: "unsubscribed", optOut: true },
};

const clickSendStatus = (text: string) => {
    const value = text.toLowerCase();
    if (value.includes("undeliver") || value.includes("fail") || value.includes("reject") || value.includes("expired")) return "undelivered";
    if (value.includes("deliver")) return "delivered";
    return null;
};

async function store(env: Env, provider: Provider, kind: string, providerId: string | null, dedupe: string, payload: Payload) {
    const result = await env.DB.prepare(
        `INSERT INTO comm_webhook_events (id, provider, kind, dedupe_key, provider_id, payload, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(dedupe_key) DO NOTHING RETURNING id`,
    )
        .bind(newId("whk"), provider, kind, `${provider}:${dedupe}`.slice(0, 300), providerId, JSON.stringify(payload).slice(0, 16_000), nowIso())
        .first<{ id: string }>();
    return result?.id ?? null;
}

const markApplied = (env: Env, id: string) => env.DB.prepare("UPDATE comm_webhook_events SET applied = 1 WHERE id = ?").bind(id).run();

async function applySmtp2go(env: Env, payload: Payload) {
    const event = (pick(payload, "event", "Event", "type") ?? "unknown").toLowerCase();
    const emailId = pick(payload, "email_id", "Email-Id", "message_id", "id");
    const recipient = pick(payload, "rcpt", "recipient", "email", "to");
    const stored = await store(
        env,
        "smtp2go",
        event,
        emailId,
        `${event}:${emailId ?? ""}:${recipient ?? ""}:${pick(payload, "time", "timestamp") ?? ""}`,
        payload,
    );
    if (!stored) return { duplicate: true };
    const mapped = SMTP2GO_EVENTS[event];
    if (!mapped || !emailId) return { applied: false };
    const now = nowIso();
    const updated = await env.DB.prepare(
        `UPDATE message_recipients SET delivery_status = ?, delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at END,
         error = CASE WHEN ? THEN ? ELSE error END WHERE provider_id = ? RETURNING guest_id`,
    )
        .bind(mapped.status, mapped.status, now, mapped.failed ? 1 : 0, mapped.failed ? `Email ${mapped.status}` : null, emailId)
        .all<{ guest_id: string }>();
    // A message to a household's own address has the household's id as its recipient id, so the
    // opt-out is recorded on whichever it was: the guest or the household.
    if (mapped.optOut)
        for (const row of updated.results)
            await env.DB.batch([
                env.DB.prepare("UPDATE guests SET email_opt_out_at = COALESCE(email_opt_out_at, ?) WHERE id = ?").bind(now, row.guest_id),
                env.DB.prepare("UPDATE households SET email_opt_out_at = COALESCE(email_opt_out_at, ?) WHERE id = ?").bind(now, row.guest_id),
            ]);
    if (updated.results.length) await markApplied(env, stored);
    return { applied: updated.results.length > 0 };
}

async function applyClickSendReceipt(env: Env, payload: Payload) {
    const messageId = pick(payload, "message_id", "messageid", "MessageId");
    const statusText = pick(payload, "status_text", "status", "status_code") ?? "";
    const stored = await store(env, "clicksend-receipt", "receipt", messageId, `${messageId ?? ""}:${statusText}:${pick(payload, "timestamp") ?? ""}`, payload);
    if (!stored) return { duplicate: true };
    const status = clickSendStatus(statusText);
    if (!status || !messageId) return { applied: false };
    const now = nowIso();
    const error = status === "undelivered" ? `Text not delivered${pick(payload, "error_text") ? `: ${pick(payload, "error_text")}` : ""}`.slice(0, 300) : null;
    const results = await env.DB.batch([
        env.DB.prepare(
            "UPDATE message_recipients SET delivery_status = ?, delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at END, error = COALESCE(?, error) WHERE provider_id = ?",
        ).bind(status, status, now, error, messageId),
        env.DB.prepare("UPDATE sms_messages SET status = ?, error = COALESCE(?, error) WHERE provider_id = ? AND direction = 'outbound'").bind(
            status === "delivered" ? "delivered" : "failed",
            error,
            messageId,
        ),
    ]);
    const applied = results.some((r) => (r.meta.changes ?? 0) > 0);
    if (applied) await markApplied(env, stored);
    return { applied };
}

async function applyClickSendInbound(env: Env, payload: Payload) {
    const from = pick(payload, "from", "originalsenderid", "sender");
    const body = pick(payload, "body", "message", "text") ?? "";
    const messageId = pick(payload, "message_id", "messageid");
    const stored = await store(
        env,
        "clicksend-inbound",
        "inbound",
        messageId,
        `${messageId ?? `${from}:${pick(payload, "timestamp") ?? ""}:${body.slice(0, 40)}`}`,
        payload,
    );
    if (!stored) return { duplicate: true };
    if (!from) return { applied: false };
    const result = await receiveSms(env.DB, { from, body, providerId: messageId });
    await markApplied(env, stored);
    return { applied: true, matched: result.matched };
}

export async function handleCommsWebhook(request: Request, env: Env, url: URL): Promise<Response> {
    const match = /^\/api\/comms\/webhooks\/([a-z0-9-]+)(?:\/([^/]+))?$/.exec(url.pathname);
    if (!match || request.method !== "POST" || !env.COMMS_WEBHOOK_SECRET) return notFound();
    const [, provider, inPath] = match;
    const secret = url.searchParams.get("key") ?? inPath ?? "";
    if (!(PROVIDERS as readonly string[]).includes(provider) || !(await sameSecret(secret, env.COMMS_WEBHOOK_SECRET))) return notFound();
    const payload = await readPayload(request);
    if (!payload) return new Response("Bad request", { status: 400 });
    // Some providers batch events in an array.
    const events = Array.isArray(payload) ? payload : [payload];
    const results = [];
    for (const event of events.slice(0, 100)) {
        if (provider === "smtp2go") results.push(await applySmtp2go(env, event));
        else if (provider === "clicksend-receipt") results.push(await applyClickSendReceipt(env, event));
        else results.push(await applyClickSendInbound(env, event));
    }
    // Always 200 for authenticated requests, so providers don't retry events we chose not to apply.
    return ok({ ok: true, received: results.length });
}
