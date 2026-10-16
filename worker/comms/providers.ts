// Delivery providers behind one small interface, so the portal never depends on a particular service.
//
// Email: Fastmail JMAP (preferred), authenticated SMTP, SMTP2Go, Cloudflare Email Service, or
// "log" (tests and local development only).
// SMS:   ClickSend, or "log" (tests and local development only).
//
// A provider only exists when its mode is chosen deliberately (EMAIL_DELIVERY / SMS_DELIVERY) AND its
// credentials are Worker secrets. Even then nothing is sent unless the matching feature switch is on
// (see deliveryAvailable in worker/portal/comms.ts). Credentials never leave the Worker.
import type { ReadableStreamDefaultReader as WorkerReader, WritableStreamDefaultWriter as WorkerWriter } from "@cloudflare/workers-types";
import { type Socket, connect } from "cloudflare:sockets";
import { isE164Mobile } from "../../src/shared/portal/phone";
import type { Env } from "../env";

export interface EmailAttachment {
    filename: string;
    contentType: "application/pdf";
    bytes: Uint8Array;
}

export interface OutgoingEmail {
    to: string;
    toName: string;
    subject: string;
    text: string;
    html: string;
    /** Files to attach. A provider that can't attach refuses the message rather than dropping them. */
    attachments?: EmailAttachment[];
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
    /** Whether `attachments` are delivered. Messages with attachments are refused otherwise. */
    supportsAttachments: boolean;
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

/** Base64 of binary data, in chunks so large files don't overflow the call stack. */
export const bytesToBase64 = (bytes: Uint8Array) => {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
};

/** Wraps base64 at 76 characters, as MIME requires. */
const mimeLines = (base64: string) => base64.replace(/.{1,76}/g, (line) => `${line}\r\n`).trimEnd();

/** Only plain, safe characters in attachment filenames. */
export const safeFilename = (name: string) =>
    name
        .normalize("NFKD")
        .replace(/[^\w .&()-]+/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 80) || "attachment.pdf";

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Plain-text messages become simple, safe HTML: everything escaped, paragraphs and line breaks kept. */
export const htmlForText = (text: string) =>
    escapeHtml(text)
        .split(/\n{2,}/)
        .map((paragraph) => `<p>${paragraph.replace(/\n/g, "<br>")}</p>`)
        .join("");

/** "Name <address>" with the display name quoted, as SMTP2Go expects. */
export const mailbox = (address: string, name?: string) => {
    if (/\r|\n/.test(address)) throw new ProviderError("Email", "invalid mailbox address", false);
    const clean = (name ?? "").replace(/["\\\r\n<>]/g, "").trim();
    return clean ? `"${clean}" <${address}>` : address;
};

const addressOnly = (mailboxValue: string) => {
    if (/\r|\n/.test(mailboxValue)) throw new ProviderError("Email", "invalid mailbox address", false);
    return (/<([^>]+)>/.exec(mailboxValue)?.[1] ?? mailboxValue).trim();
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
        supportsAttachments: true,
        async send(message) {
            const replyTo = env.EMAIL_REPLY_TO ? addressOnly(env.EMAIL_REPLY_TO) : null;
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
                        ...(message.attachments?.length
                            ? {
                                  attachments: message.attachments.map((a) => ({
                                      filename: safeFilename(a.filename),
                                      fileblob: bytesToBase64(a.bytes),
                                      mimetype: a.contentType,
                                  })),
                              }
                            : {}),
                        custom_headers: [
                            ...(replyTo ? [{ header: "Reply-To", value: replyTo }] : []),
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

interface FastmailSession {
    apiUrl: string;
    /** e.g. https://api.fastmail.com/jmap/upload/{accountId}/ */
    uploadUrl?: string;
    primaryAccounts: Record<string, string>;
    capabilities: Record<string, unknown>;
}

const FASTMAIL_MAIL = "urn:ietf:params:jmap:mail";
const FASTMAIL_SUBMISSION = "urn:ietf:params:jmap:submission";

async function fastmailRequest(env: Env, url: string, body?: unknown) {
    const response = await fetch(url, {
        method: body ? "POST" : "GET",
        headers: {
            Authorization: `Bearer ${env.FASTMAIL_API_TOKEN}`,
            Accept: "application/json",
            ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok)
        throw new ProviderError(
            "Fastmail",
            response.status === 401 ? "authentication failed" : `connection failed (HTTP ${response.status})`,
            response.status >= 500,
        );
    return (await response.json()) as Record<string, unknown>;
}

export async function validateFastmail(env: Env) {
    if (!env.FASTMAIL_API_TOKEN || !env.EMAIL_FROM) throw new ProviderError("Fastmail", "API token and sender are required", false);
    const session = (await fastmailRequest(env, env.FASTMAIL_SESSION_URL || "https://api.fastmail.com/jmap/session")) as unknown as FastmailSession;
    if (!session.apiUrl || !session.capabilities?.[FASTMAIL_SUBMISSION] || !session.capabilities?.[FASTMAIL_MAIL])
        throw new ProviderError("Fastmail", "token needs JMAP Mail and Email Submission access", false);
    const accountId = session.primaryAccounts[FASTMAIL_MAIL] ?? session.primaryAccounts[FASTMAIL_SUBMISSION];
    if (!accountId) throw new ProviderError("Fastmail", "no mail account is available", false);
    const profile = await fastmailRequest(env, session.apiUrl, {
        using: ["urn:ietf:params:jmap:core", FASTMAIL_MAIL, FASTMAIL_SUBMISSION],
        methodCalls: [
            ["Identity/get", { accountId }, "identities"],
            ["Mailbox/query", { accountId, filter: { role: "drafts" }, limit: 1 }, "drafts"],
        ],
    });
    const methods = (profile.methodResponses as [string, Record<string, unknown>, string][] | undefined) ?? [];
    const response = methods.find(([name, , callId]) => name === "Identity/get" && callId === "identities")?.[1] as
        { list?: { id: string; email: string; name?: string }[] } | undefined;
    const draftMailboxId = (methods.find(([name, , callId]) => name === "Mailbox/query" && callId === "drafts")?.[1].ids as string[] | undefined)?.[0];
    const address = addressOnly(env.EMAIL_FROM);
    const identity = response?.list?.find((item) => item.email.toLowerCase() === address.trim().toLowerCase());
    if (!identity) throw new ProviderError("Fastmail", "the configured sender is not an available identity", false);
    if (!draftMailboxId) throw new ProviderError("Fastmail", "the account has no drafts mailbox", false);
    return { session, accountId, identity, draftMailboxId };
}

function fastmail(env: Env): EmailProvider | null {
    if (!env.FASTMAIL_API_TOKEN || !env.EMAIL_FROM) return null;
    return {
        channel: "email",
        name: "fastmail-jmap",
        supportsAttachments: true,
        async send(message) {
            let checked: Awaited<ReturnType<typeof validateFastmail>>;
            try {
                checked = await validateFastmail(env);
            } catch (error) {
                if (error instanceof ProviderError) throw error;
                throw new ProviderError("Fastmail", "couldn't be reached", true);
            }
            // Attachments are uploaded as blobs first, then referenced by the email (RFC 8620 §6.1).
            const attachments: { blobId: string; type: string; name: string; disposition: "attachment" }[] = [];
            for (const attachment of message.attachments ?? []) {
                if (!checked.session.uploadUrl) throw new ProviderError("Fastmail", "the session has no upload URL for attachments", false);
                const url = checked.session.uploadUrl.replace("{accountId}", encodeURIComponent(checked.accountId));
                let uploaded: Response;
                try {
                    uploaded = await fetch(url, {
                        method: "POST",
                        headers: { Authorization: `Bearer ${env.FASTMAIL_API_TOKEN}`, "Content-Type": attachment.contentType, Accept: "application/json" },
                        body: new Uint8Array(attachment.bytes).buffer,
                    });
                } catch {
                    throw new ProviderError("Fastmail", "couldn't upload the attachment", true);
                }
                if (!uploaded.ok) throw new ProviderError("Fastmail", `attachment upload failed (HTTP ${uploaded.status})`, uploaded.status >= 500);
                const blob = (await readJson(uploaded)) as { blobId?: string };
                if (!blob.blobId) throw new ProviderError("Fastmail", "attachment upload returned no blob", false);
                attachments.push({ blobId: blob.blobId, type: attachment.contentType, name: safeFilename(attachment.filename), disposition: "attachment" });
            }
            const created = `email-${crypto.randomUUID()}`;
            const submitted = `submission-${crypto.randomUUID()}`;
            const result = await fastmailRequest(env, checked.session.apiUrl, {
                using: ["urn:ietf:params:jmap:core", FASTMAIL_MAIL, FASTMAIL_SUBMISSION],
                methodCalls: [
                    [
                        "Email/set",
                        {
                            accountId: checked.accountId,
                            create: {
                                [created]: {
                                    mailboxIds: { [checked.draftMailboxId]: true },
                                    keywords: { $draft: true },
                                    from: [{ email: checked.identity.email, name: checked.identity.name ?? "" }],
                                    to: [{ email: message.to, name: message.toName }],
                                    ...(env.EMAIL_REPLY_TO ? { replyTo: [{ email: addressOnly(env.EMAIL_REPLY_TO) }] } : {}),
                                    subject: message.subject,
                                    textBody: [{ partId: "text", type: "text/plain" }],
                                    htmlBody: [{ partId: "html", type: "text/html" }],
                                    bodyValues: { text: { value: message.text }, html: { value: message.html } },
                                    ...(attachments.length ? { attachments } : {}),
                                },
                            },
                        },
                        "createEmail",
                    ],
                    [
                        "EmailSubmission/set",
                        {
                            accountId: checked.accountId,
                            onSuccessDestroyEmail: [`#${submitted}`],
                            create: { [submitted]: { emailId: `#${created}`, identityId: checked.identity.id } },
                        },
                        "submitEmail",
                    ],
                ],
            });
            const methods = (result.methodResponses as [string, Record<string, unknown>, string][] | undefined) ?? [];
            const failure = methods.find(([name]) => name === "error" || name.endsWith("/error"));
            const response = methods.find(([name]) => name === "EmailSubmission/set")?.[1];
            const createdSubmission = (response?.created as Record<string, { id?: string }> | undefined)?.[submitted];
            if (failure || !createdSubmission) throw new ProviderError("Fastmail", "submission was rejected", false);
            return { providerId: createdSubmission.id ?? null };
        },
    };
}

const utf8Base64 = (value: string) => {
    let binary = "";
    for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
    return btoa(binary);
};

/**
 * A complete MIME message: multipart/alternative (text and HTML), wrapped in multipart/mixed when
 * there are attachments. Every part is base64, so no line is ever too long or mis-encoded.
 */
export function buildMime(input: { from: string; to: string; replyTo: string | null; subject: string; text: string; html: string; attachments: EmailAttachment[] }) {
    const alternative = `alt-${crypto.randomUUID()}`;
    const mixed = `mixed-${crypto.randomUUID()}`;
    const body = [
        `--${alternative}`,
        "Content-Type: text/plain; charset=UTF-8",
        "Content-Transfer-Encoding: base64",
        "",
        mimeLines(utf8Base64(input.text)),
        `--${alternative}`,
        "Content-Type: text/html; charset=UTF-8",
        "Content-Transfer-Encoding: base64",
        "",
        mimeLines(utf8Base64(input.html)),
        `--${alternative}--`,
    ];
    const headers = [
        `From: ${input.from}`,
        `To: ${input.to}`,
        ...(input.replyTo ? [`Reply-To: ${input.replyTo}`] : []),
        `Subject: =?UTF-8?B?${utf8Base64(input.subject)}?=`,
        "MIME-Version: 1.0",
    ];
    if (!input.attachments.length) return [...headers, `Content-Type: multipart/alternative; boundary="${alternative}"`, "", ...body].join("\r\n");
    return [
        ...headers,
        `Content-Type: multipart/mixed; boundary="${mixed}"`,
        "",
        `--${mixed}`,
        `Content-Type: multipart/alternative; boundary="${alternative}"`,
        "",
        ...body,
        ...input.attachments.flatMap((a) => {
            const name = safeFilename(a.filename);
            return [
                `--${mixed}`,
                `Content-Type: ${a.contentType}; name="${name}"`,
                "Content-Transfer-Encoding: base64",
                `Content-Disposition: attachment; filename="${name}"`,
                "",
                mimeLines(bytesToBase64(a.bytes)),
            ];
        }),
        `--${mixed}--`,
    ].join("\r\n");
}

class SmtpSession {
    private reader: WorkerReader;
    private writer: WorkerWriter;
    private buffered = "";
    constructor(private socket: Socket) {
        this.reader = socket.readable.getReader();
        this.writer = socket.writable.getWriter();
    }
    private async line(): Promise<string> {
        while (!this.buffered.includes("\n")) {
            const next = await this.reader.read();
            if (next.done) throw new Error("connection closed");
            this.buffered += new TextDecoder().decode(next.value, { stream: true });
        }
        const end = this.buffered.indexOf("\n");
        const line = this.buffered.slice(0, end).replace(/\r$/, "");
        this.buffered = this.buffered.slice(end + 1);
        return line;
    }
    async reply(expected: number) {
        let line = await this.line();
        const code = Number(line.slice(0, 3));
        while (line[3] === "-") line = await this.line();
        if (code !== expected) throw new Error(`server replied ${code || "unexpectedly"}`);
    }
    async command(command: string, expected: number) {
        await this.writer.write(new TextEncoder().encode(`${command}\r\n`));
        await this.reply(expected);
    }
    async startTls() {
        this.reader.releaseLock();
        this.writer.releaseLock();
        this.socket = this.socket.startTls();
        this.reader = this.socket.readable.getReader();
        this.writer = this.socket.writable.getWriter();
        this.buffered = "";
    }
    async close() {
        await this.writer.close().catch(() => undefined);
        await this.socket.closed.catch(() => undefined);
    }
}

function genericSmtp(env: Env): EmailProvider | null {
    const port = Number(env.SMTP_PORT ?? 587);
    const security = (env.SMTP_SECURITY ?? "starttls").toLowerCase();
    if (!env.SMTP_HOST || !env.SMTP_USERNAME || !env.SMTP_PASSWORD || !env.EMAIL_FROM || ![465, 587].includes(port) || !["tls", "starttls"].includes(security))
        return null;
    if (!/^(?=.{1,253}$)(?!-)[a-z0-9.-]+(?<!-)$/i.test(env.SMTP_HOST)) return null;
    return {
        channel: "email",
        name: "authenticated-smtp",
        supportsAttachments: true,
        async send(message) {
            const socket = connect({ hostname: env.SMTP_HOST!, port }, { secureTransport: security === "tls" ? "on" : "starttls", allowHalfOpen: false });
            const smtp = new SmtpSession(socket);
            const address = addressOnly(env.EMAIL_FROM!);
            const replyTo = env.EMAIL_REPLY_TO ? addressOnly(env.EMAIL_REPLY_TO) : null;
            try {
                await smtp.reply(220);
                await smtp.command("EHLO wedding.daly.id.au", 250);
                if (security === "starttls") {
                    await smtp.command("STARTTLS", 220);
                    await smtp.startTls();
                    await smtp.command("EHLO wedding.daly.id.au", 250);
                }
                await smtp.command(`AUTH PLAIN ${btoa(`\0${env.SMTP_USERNAME}\0${env.SMTP_PASSWORD}`)}`, 235);
                await smtp.command(`MAIL FROM:<${address}>`, 250);
                await smtp.command(`RCPT TO:<${message.to}>`, 250);
                await smtp.command("DATA", 354);
                const mime = buildMime({
                    from: env.EMAIL_FROM!,
                    to: mailbox(message.to, message.toName),
                    replyTo,
                    subject: message.subject,
                    text: message.text,
                    html: message.html,
                    attachments: message.attachments ?? [],
                });
                await smtp.command(`${mime.replace(/^\./gm, "..")}\r\n.`, 250);
                await smtp.command("QUIT", 221);
                return { providerId: null };
            } catch (error) {
                throw new ProviderError("SMTP", error instanceof Error ? error.message : "connection failed", true);
            } finally {
                await smtp.close();
            }
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
            supportsAttachments: true,
            async send(message) {
                console.log(JSON.stringify({ event: "email_logged", to: message.to, subject: message.subject, attachments: message.attachments?.length ?? 0 }));
                return { providerId: `log_${crypto.randomUUID()}` };
            },
        };
    }
    if (chosen === "smtp2go") return smtp2go(env);
    if (chosen === "fastmail") return fastmail(env);
    if (chosen === "smtp") return genericSmtp(env);
    if (chosen === "cloudflare" && env.EMAIL && env.EMAIL_FROM) {
        return {
            channel: "email",
            name: "cloudflare-email-service",
            // Not wired up for this binding yet; invitations with a PDF are refused, never sent without it.
            supportsAttachments: false,
            async send(message) {
                if (message.attachments?.length) throw new ProviderError("Cloudflare Email", "attachments aren't supported by this provider", false);
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

/**
 * Every SMS provider only ever sees a valid mobile in E.164. Callers normalise first; anything
 * else is refused here, before a request is made, and never retried.
 */
const guardRecipients = (provider: SmsProvider | null): SmsProvider | null =>
    provider && {
        ...provider,
        async send(message) {
            if (!isE164Mobile(message.to)) throw new ProviderError("SMS", "the recipient isn't a valid mobile number", false);
            return provider.send(message);
        },
    };

/** The configured SMS provider, or null. */
export function smsProvider(env: Env): SmsProvider | null {
    return guardRecipients(chooseSmsProvider(env));
}

function chooseSmsProvider(env: Env): SmsProvider | null {
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

/** Checks credentials without sending. Some HTTP providers expose a safe account/session read;
 * SMTP deliberately reports that a controlled test is still required rather than claiming success. */
export async function validateProviderConnection(env: Env, channel: "email" | "sms") {
    if (channel === "email") {
        const chosen = mode(env.EMAIL_DELIVERY);
        if (chosen === "fastmail") {
            await validateFastmail(env);
            return { provider: "fastmail-jmap", connected: true, detail: "JMAP session, scopes and sender identity validated." };
        }
        if (chosen === "smtp") {
            if (!genericSmtp(env)) throw new ProviderError("SMTP", "TLS host, port, username, password and sender are required", false);
            return { provider: "authenticated-smtp", connected: false, detail: "Configuration is valid. Send a controlled test to complete validation." };
        }
        if (chosen === "smtp2go") {
            if (!smtp2go(env)) throw new ProviderError("SMTP2Go", "API key and sender are required", false);
            return { provider: "smtp2go", connected: false, detail: "Configuration is valid. Send a controlled test to complete validation." };
        }
        if (chosen === "cloudflare" && env.EMAIL && env.EMAIL_FROM)
            return { provider: "cloudflare-email-service", connected: false, detail: "Binding is present. Send a controlled test to complete validation." };
        throw new ProviderError("Email", "no provider is configured", false);
    }
    if (mode(env.SMS_DELIVERY) !== "clicksend" || !env.CLICKSEND_USERNAME || !env.CLICKSEND_API_KEY)
        throw new ProviderError("SMS", "ClickSend credentials are not configured", false);
    const base = (env.CLICKSEND_API_BASE || "https://rest.clicksend.com/v3").replace(/\/+$/, "");
    const response = await fetch(`${base}/account`, {
        headers: { Accept: "application/json", Authorization: `Basic ${btoa(`${env.CLICKSEND_USERNAME}:${env.CLICKSEND_API_KEY}`)}` },
    });
    if (!response.ok)
        throw new ProviderError(
            "ClickSend",
            response.status === 401 ? "authentication failed" : `connection failed (HTTP ${response.status})`,
            response.status >= 500,
        );
    return { provider: "clicksend", connected: true, detail: "Account credentials validated. A controlled test and sender approval are still required." };
}
