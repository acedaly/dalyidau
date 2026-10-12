import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import type { Env } from "../worker/env";
import worker from "../worker/index";

export const TEAM = "daly-test.cloudflareaccess.com";
export const AUD = "aud-portal-0123456789abcdef";
export const OWNER = "owner@example.com";
export const SECOND_OWNER = "partner@example.com";
export const ORIGIN = "https://daly.id.au";

const testEnv = env as unknown as Env;

const b64url = (data: ArrayBuffer | Uint8Array | string) => {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

interface KeyPair {
    kid: string;
    privateKey: CryptoKey;
    jwk: JsonWebKey & { kid: string };
}

const makeKey = async (kid: string): Promise<KeyPair> => {
    const pair = (await crypto.subtle.generateKey(
        { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
        true,
        ["sign", "verify"],
    )) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
    return { kid, privateKey: pair.privateKey, jwk: { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", kid } };
};

let keys: { good: KeyPair; other: KeyPair } | null = null;
export const testKeys = async () => (keys ??= { good: await makeKey("test-key-1"), other: await makeKey("rogue-key") });

export const jwks = async () => JSON.stringify({ keys: [(await testKeys()).good.jwk] });

export interface TokenOptions {
    email?: string | null;
    aud?: string | string[];
    iss?: string;
    expiresIn?: number;
    notBefore?: number;
    alg?: string;
    kid?: string;
    key?: "good" | "other";
}

export async function accessToken(options: TokenOptions = {}) {
    const k = await testKeys();
    const key = options.key === "other" ? k.other : k.good;
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: options.alg ?? "RS256", kid: options.kid ?? key.kid, typ: "JWT" };
    const claims: Record<string, unknown> = {
        aud: options.aud ?? [AUD],
        iss: options.iss ?? `https://${TEAM}`,
        sub: "user-123",
        iat: now,
        exp: now + (options.expiresIn ?? 3600),
        type: "app",
        ...(options.notBefore !== undefined ? { nbf: now + options.notBefore } : {}),
        ...(options.email === null ? {} : { email: options.email ?? OWNER }),
    };
    const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.privateKey, new TextEncoder().encode(unsigned));
    return `${unsigned}.${b64url(signature)}`;
}

/** An environment where Access is configured and tokens are verified against the test key set. */
export async function portalEnv(overrides: Partial<Env> = {}): Promise<Env> {
    return {
        ...testEnv,
        ENVIRONMENT: "test",
        ACCESS_TEAM_DOMAIN: TEAM,
        ACCESS_AUD: AUD,
        ACCESS_TEST_JWKS: await jwks(),
        PORTAL_OWNER_EMAILS: `${OWNER}, ${SECOND_OWNER}`,
        EMAIL_DELIVERY: "off",
        RSVP_LINK_SECRET: "test-rsvp-link-secret-that-is-at-least-32-bytes",
        ...overrides,
    };
}

/** Calls the Worker directly with a chosen environment. */
export async function call(path: string, init: RequestInit & { token?: string | null; env?: Env; host?: string } = {}) {
    const { token, env: callEnv, host, ...rest } = init;
    const headers = new Headers(rest.headers);
    if (token) headers.set("Cf-Access-Jwt-Assertion", token);
    const request = new Request(`https://${host ?? "daly.id.au"}${path}`, { ...rest, headers, redirect: "manual" });
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, callEnv ?? (await portalEnv()), ctx);
    await waitOnExecutionContext(ctx);
    return response;
}

/** JSON API call as a signed-in user, with the same-origin headers browsers send. */
export async function apiCall<T = unknown>(method: string, path: string, body?: unknown, options: { email?: string; env?: Env } = {}) {
    const token = await accessToken({ email: options.email ?? OWNER });
    const response = await call(path, {
        method,
        token,
        env: options.env,
        headers: method === "GET" ? {} : { Origin: ORIGIN, "Content-Type": "application/json" },
        body: body === undefined ? (method === "GET" || method === "DELETE" ? undefined : "{}") : JSON.stringify(body),
    });
    const text = await response.text();
    let json: T | null = null;
    try {
        json = text ? (JSON.parse(text) as T) : null;
    } catch {
        json = null;
    }
    return { status: response.status, json: json as T, text, headers: response.headers };
}

const PORTAL_TABLES = [
    "comm_webhook_events",
    "sms_messages",
    "seat_assignments",
    "seating_tables",
    "seating_snapshots",
    "rsvp_answers",
    "website_media",
    "message_recipients",
    "messages",
    "message_templates",
    "rsvp_submissions",
    "guest_events",
    "guest_import_rows",
    "guest_imports",
    "guests",
    "households",
    "events",
    "custom_fields",
    "tasks",
    "timeline_items",
    "budget_items",
    "suppliers",
    "settings",
    "feature_flags",
    "dashboard_layouts",
    "audit_log",
    "portal_users",
    "rate_limits",
];

export const resetPortal = async () => {
    await testEnv.DB.batch(PORTAL_TABLES.map((t) => testEnv.DB.prepare(`DELETE FROM ${t}`)));
    // Keep the built-in bus question (inserted by migration 0004) but reset it.
    await testEnv.DB.prepare(
        "INSERT OR REPLACE INTO rsvp_questions (id, label, help, type, options, required, scope, audience, published, sort_order, created_at, updated_at) VALUES ('q_bus', 'Would you like a seat on the courtesy bus?', NULL, 'yes_no', '[]', 0, 'guest', 'all', 0, 100, '2026-10-12T00:00:00.000Z', '2026-10-12T00:00:00.000Z')",
    ).run();
    await testEnv.DB.prepare("DELETE FROM rsvp_questions WHERE id != 'q_bus'").run();
    const listed = await testEnv.MEDIA.list({ prefix: "wedding/" });
    for (const object of listed.objects) await testEnv.MEDIA.delete(object.key);
};

export const auditActions = async () =>
    (await testEnv.DB.prepare("SELECT action FROM audit_log ORDER BY id").all<{ action: string }>()).results.map((r) => r.action);

export const db = () => testEnv.DB;
