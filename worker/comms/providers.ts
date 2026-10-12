// Delivery providers behind one small interface, so the portal never depends on a particular service.
//
// Email: SMTP2Go (preferred), Cloudflare Email Service, or "log" (tests and local development only).
// SMS:   ClickSend, or "log" (tests and local development only).
//
// A provider only exists when its mode is chosen deliberately (EMAIL_DELIVERY / SMS_DELIVERY) AND its
// credentials are Worker secrets. Even then nothing is sent unless the matching feature switch is on
// (see deliveryAvailable in worker/portal/comms.ts). Credentials never leave the Worker.
import type { Env } from "../env";

export interface OutgoingEmail {
    to: string;
    toName: string;
    subject: string;
    text: string;
    html: string;
    /** Our own reference, echoed back by some providers' webhooks. */
    reference?: string;
}

export interface OutgoingSms {
    /** E.164 */
    to: string;
    body: string;
    reference?: string;
}

export interface EmailProvider {
    channel: "email";
    name: string;
    send(message: OutgoingEmail): Promise<{ providerId: string | null }>;
}

export interface SmsProvider {
    channel: "sms";
    name: string;
    send(message: OutgoingSms): Promise<{ providerId: string | null; costCents: number | null }>;
}

/** Errors from providers are shown to the couple, so keep them short and free of credentials. */
export class ProviderError extends Error {
    constructor(
        readonly provider: string,
        message: string,
        /** Worth retrying later (network trouble, rate limits, provider outages). */
        readonly retryable: boolean,
    ) {
        super(`${provider}: ${message}`.slice(0, 300));
    }
}

const mode = (value: string | undefined) => (value ?? "off").trim().toLowerCase();
const isDevelopment = (env: Env) => env.ENVIRONMENT !== "production";

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Plain-text messages become simple, safe HTML: everything escaped, paragraphs and line breaks kept. */
export const htmlForText = (text: string) =>
    escapeHtml(text)
        .split(/\n{2,}/)
        .map((paragraph) => `<p>${paragraph.replace(/\n/g, "<br>")}</p>`)
        .join("");

/** "Name <address>" with the display name quoted, as SMTP2Go expects. */
export const mailbox = (address: string, name?: string) => {
    const clean = (name ?? "").replace(/["\\\r\n<>]/g, "").trim();
    return clean ? `"${clean}" <${address}>` : address;
};

async function readJson(response: Response): Promise<Record<string, unknown>> {
    try {
        return (await response.json()) as Record<string, unknown>;
    } catch {
        return {};
    }
}

// ---------------------------------------------------------------------------------------------
// Email

function smtp2go(env: Env): EmailProvider | null {
    if (!env.SMTP2GO_API_KEY || !env.EMAIL_FROM) return null;
    const base = (env.SMTP2GO_API_BASE || "https://api.smtp2go.com/v3").replace(/\/+$/, "");
    return {
        channel: "email",
        name: "smtp2go",
        async send(message) {
            let response: Response;
            try {
                response = await fetch(`${base}/email/send`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", Accept: "application/json", "X-Smtp2go-Api-Key": env.SMTP2GO_API_KEY! },
                    body: JSON.stringify({
                        sender: env.EMAIL_FROM,
                        to: [mailbox(message.to, message.toName)],
                        subject: message.subject,
                        text_body: message.text,
                        html_body: message.html,
                        custom_headers: [
                            ...(env.EMAIL_REPLY_TO ? [{ header: "Reply-To", value: env.EMAIL_REPLY_TO }] : []),
                            ...(message.reference ? [{ header: "X-Wedding-Reference", value: message.reference }] : []),
                        ],
                    }),
                });
            } catch {
                throw new ProviderError("SMTP2Go", "couldn't be reached", true);
            }
            const body = await readJson(response);
            const data = (body.data ?? {}) as {
                email_id?: string;
                succeeded?: number;
                failed?: number;
                failures?: string[];
                error?: string;
                error_code?: string;
            };
            // SMTP2Go can answer 200 with failures, so check the counts rather than the status alone.
            if (!response.ok || data.error || (data.failed ?? 0) > 0 || (data.succeeded ?? 0) < 1) {
                const reason = data.error ?? data.failures?.join("; ") ?? `HTTP ${response.status}`;
                throw new ProviderError("SMTP2Go", reason, response.status === 429 || response.status >= 500);
            }
            return { providerId: data.email_id ?? null };
        },
    };
}

/** The configured email provider, or null. */
export function emailProvider(env: Env): EmailProvider | null {
    const chosen = mode(env.EMAIL_DELIVERY);
    if (chosen === "log" && isDevelopment(env)) {
        return {
            channel: "email",
            name: "log",
            async send(message) {
                console.log(JSON.stringify({ event: "email_logged", to: message.to, subject: message.subject }));
                return { providerId: `log_${crypto.randomUUID()}` };
            },
        };
    }
    if (chosen === "smtp2go") return smtp2go(env);
    if (chosen === "cloudflare" && env.EMAIL && env.EMAIL_FROM) {
        return {
            channel: "email",
            name: "cloudflare-email-service",
            async send(message) {
                const result = await env.EMAIL!.send({
                    to: { email: message.to, name: message.toName },
                    from: env.EMAIL_FROM!,
                    subject: message.subject,
                    text: message.text,
                    html: message.html,
                });
                return { providerId: result.messageId };
            },
        };
    }
    return null;
}

// ---------------------------------------------------------------------------------------------
// SMS

function clicksend(env: Env): SmsProvider | null {
    if (!env.CLICKSEND_USERNAME || !env.CLICKSEND_API_KEY) return null;
    const base = (env.CLICKSEND_API_BASE || "https://rest.clicksend.com/v3").replace(/\/+$/, "");
    const auth = `Basic ${btoa(`${env.CLICKSEND_USERNAME}:${env.CLICKSEND_API_KEY}`)}`;
    return {
        channel: "sms",
        name: "clicksend",
        async send(message) {
            let response: Response;
            try {
                response = await fetch(`${base}/sms/send`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: auth },
                    body: JSON.stringify({
                        messages: [
                            {
                                source: "daly.id.au",
                                to: message.to,
                                body: message.body,
                                // A dedicated number (needed for replies) or a registered sender ID. Unset = account default.
                                ...(env.SMS_FROM ? { from: env.SMS_FROM } : {}),
                                ...(message.reference ? { custom_string: message.reference } : {}),
                            },
                        ],
                    }),
                });
            } catch {
                throw new ProviderError("ClickSend", "couldn't be reached", true);
            }
            const body = await readJson(response);
            const data = (body.data ?? {}) as { messages?: { status?: string; message_id?: string; message_price?: string | number }[] };
            const sent = data.messages?.[0];
            // The HTTP status doesn't reflect each message; ClickSend reports per-message status.
            if (!response.ok || !sent || sent.status !== "SUCCESS") {
                const reason = sent?.status ?? (body.response_code as string | undefined) ?? `HTTP ${response.status}`;
                throw new ProviderError("ClickSend", reason, response.status === 429 || response.status >= 500);
            }
            const price = Number(sent.message_price);
            return { providerId: sent.message_id ?? null, costCents: Number.isFinite(price) ? Math.round(price * 10_000) / 100 : null };
        },
    };
}

/** The configured SMS provider, or null. */
export function smsProvider(env: Env): SmsProvider | null {
    const chosen = mode(env.SMS_DELIVERY);
    if (chosen === "log" && isDevelopment(env)) {
        return {
            channel: "sms",
            name: "log",
            async send(message) {
                console.log(JSON.stringify({ event: "sms_logged", to: message.to.slice(0, -3) + "***", length: message.body.length }));
                return { providerId: `log_${crypto.randomUUID()}`, costCents: null };
            },
        };
    }
    if (chosen === "clicksend") return clicksend(env);
    return null;
}

/** Which providers are configured, for the portal's status panel. Names only, never credentials. */
export const providerStatus = (env: Env) => ({
    email: emailProvider(env)?.name ?? null,
    sms: smsProvider(env)?.name ?? null,
    emailFrom: emailProvider(env) ? (env.EMAIL_FROM ?? null) : null,
    smsFrom: smsProvider(env) ? (env.SMS_FROM ?? null) : null,
    webhooks: !!env.COMMS_WEBHOOK_SECRET,
});
