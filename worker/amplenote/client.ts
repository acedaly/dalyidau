// Amplenote's REST API (https://www.amplenote.com/api_documentation, spec at
// https://api.amplenote.com/doc/swagger.json). What it offers, and what this site uses it for:
//
//   OAuth2 authorization code flow (PKCE), login.amplenote.com/login → api.amplenote.com/oauth/token.
//   Access tokens last two hours (expires_in 7200) and come with a refresh token, which Amplenote
//   didn't rotate in the owner's live check (rotation is still handled). The blog asks only for
//   notes:list. With "Amplenote for AI assistants" switched on, a new sign-in also asks for notes:create
//   and notes:create-content-action (worker/amplenote/assistant.ts).
//   GET /v4/notes[?since=<unix>]: { notes: [...] } with metadata for every note (uuid, name, tags,
//   timestamps, deleted and "public": whether the note has been shared publicly). No content, and no
//   public URL or token (confirmed live).
//
// So the API can confirm that a note is tagged and public, and follow title changes, untagging,
// unpublishing and deletion without anyone opening Amplenote, but it can't supply the article
// itself: that comes from the plugin (amplenote/plugin.js). See docs/AMPLENOTE.md.
import type { Env } from "../env";
import { auditStatement, nowIso } from "../portal/db";
import { PUBLIC_HOST } from "./metadata";

/** The blog's scope: list notes, nothing else. */
export const SCOPE = "notes:list";
/** What AI assistants need on top: create notes, and add content (text and tasks) to a note. */
export const WRITE_SCOPES = ["notes:create", "notes:create-content-action"] as const;
export const ASSISTANT_SCOPE = [SCOPE, ...WRITE_SCOPES].join(" ");
/** The scopes a stored connection holds, from its space-separated scope string. */
export const grantedScopes = (scope: string | null | undefined) => new Set((scope ?? "").split(/[\s,]+/).filter(Boolean));
export const CALLBACK_PATH = "/api/integrations/amplenote/callback";
/** Ties a sign-in to the browser that started it: the callback is outside Cloudflare Access, so it can't ask Access who's there. */
export const BROWSER_COOKIE = "__Secure-amplenote-oauth";
const STATE_MINUTES = 10;

export interface Hosts {
    api: string;
    login: string;
    public: string;
    /** Hosts article images may be copied from. */
    images: string[];
}

/**
 * The real hosts, or a local stand-in for development and browser tests (scripts/mock-amplenote.mjs).
 * The override is honoured only when ENVIRONMENT is "development", like CENTRE_FEED_BASE.
 */
export const hosts = (env: Env): Hosts => {
    const base = env.ENVIRONMENT === "development" ? env.AMPLENOTE_TEST_BASE?.replace(/\/+$/, "") : undefined;
    if (base) return { api: `${base}/api`, login: `${base}/login`, public: `${base}/public`, images: [new URL(base).host] };
    return { api: "https://api.amplenote.com", login: "https://login.amplenote.com/login", public: `https://${PUBLIC_HOST}`, images: ["images.amplenote.com"] };
};

export const restConfigured = (env: Env) => !!env.AMPLENOTE_CLIENT_ID && sealingConfigured(env);

export class AmplenoteError extends Error {
    constructor(
        message: string,
        readonly status = 0,
    ) {
        super(message);
    }
}

// --- Tokens at rest ------------------------------------------------------------------------------
// Access and refresh tokens are credentials for the owner's whole Amplenote account (list-only with
// notes:list; able to add notes and content with the assistant scopes). They're sealed with AES-GCM
// under AMPLENOTE_TOKEN_KEY; without that secret
// the connection can't be made at all, rather than storing them in the clear.

const enc = new TextEncoder();
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const b64url = (bytes: Uint8Array) => b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export const sealingConfigured = (env: Env) => (env.AMPLENOTE_TOKEN_KEY?.trim().length ?? 0) >= 32;

async function sealKey(env: Env) {
    if (!sealingConfigured(env)) throw new AmplenoteError("AMPLENOTE_TOKEN_KEY is not set (at least 32 characters)");
    const material = await crypto.subtle.digest("SHA-256", enc.encode(`daly-amplenote-token:${env.AMPLENOTE_TOKEN_KEY!.trim()}`));
    return crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function seal(env: Env, value: string) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await sealKey(env), enc.encode(value)));
    return `v1:${b64(iv)}:${b64(sealed)}`;
}

/** The value, or null when it was sealed with a different key (the secret was changed). */
export async function unseal(env: Env, stored: string): Promise<string | null> {
    const [version, iv, data] = stored.split(":");
    if (version !== "v1" || !iv || !data) return null;
    try {
        return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await sealKey(env), unb64(data)));
    } catch {
        return null;
    }
}

// --- Connecting (owner, from Portal settings → Website) ---------------------------------------------

export const redirectUri = (env: Env) => `${env.SITE_URL.replace(/\/+$/, "")}${CALLBACK_PATH}`;

const digest = async (value: string) => b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(value))));

/**
 * Starts the sign-in, from Portal settings (so behind Access, for owners and admins): a single-use
 * state, a PKCE verifier and a browser nonce, all kept server-side (the nonce only as a hash). Returns
 * the Amplenote URL to send the owner to and the cookie that must come back with the callback.
 */
export async function startConnect(env: Env, actor: string, scope: string = SCOPE): Promise<{ url: string; cookie: string }> {
    if (!env.AMPLENOTE_CLIENT_ID) throw new AmplenoteError("AMPLENOTE_CLIENT_ID is not set");
    const state = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
    const nonce = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(verifier))));
    const now = new Date();
    await env.DB.batch([
        env.DB.prepare("DELETE FROM amplenote_oauth_states WHERE created_at < ?").bind(new Date(now.getTime() - STATE_MINUTES * 60_000).toISOString()),
        env.DB.prepare("INSERT INTO amplenote_oauth_states (state, verifier, browser, actor, created_at, scope) VALUES (?, ?, ?, ?, ?, ?)").bind(
            state,
            await seal(env, verifier),
            await digest(nonce),
            actor,
            now.toISOString(),
            scope,
        ),
    ]);
    const url = new URL(hosts(env).login);
    url.search = new URLSearchParams({
        response_type: "code",
        client_id: env.AMPLENOTE_CLIENT_ID,
        redirect_uri: redirectUri(env),
        scope,
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
    }).toString();
    const cookie = `${BROWSER_COOKIE}=${nonce}; Path=${CALLBACK_PATH}; Max-Age=${STATE_MINUTES * 60}; HttpOnly; Secure; SameSite=Lax`;
    return { url: url.toString(), cookie };
}

export const clearBrowserCookie = `${BROWSER_COOKIE}=; Path=${CALLBACK_PATH}; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;

export const browserNonce = (request: Request) =>
    (request.headers.get("Cookie") ?? "")
        .split(/;\s*/)
        .find((part) => part.startsWith(`${BROWSER_COOKIE}=`))
        ?.slice(BROWSER_COOKIE.length + 1) ?? null;

interface TokenResponse {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
}

async function tokenRequest(env: Env, params: Record<string, string>, fetchImpl: typeof fetch): Promise<TokenResponse> {
    const body = new URLSearchParams({ ...params, client_id: env.AMPLENOTE_CLIENT_ID ?? "" });
    if (env.AMPLENOTE_CLIENT_SECRET) body.set("client_secret", env.AMPLENOTE_CLIENT_SECRET);
    let response: Response;
    try {
        response = await fetchImpl(`${hosts(env).api}/oauth/token`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
            body,
            redirect: "manual",
            signal: AbortSignal.timeout(20_000),
        });
    } catch (error) {
        throw new AmplenoteError(`Token request failed (${(error as Error).message})`);
    }
    const data = (await response.json().catch(() => null)) as (TokenResponse & { error?: string }) | null;
    if (!response.ok || !data || typeof data.access_token !== "string" || !data.access_token) {
        // The provider's error code only (e.g. invalid_grant), never the response body.
        const code = typeof data?.error === "string" ? data.error.replace(/[^\w.-]/g, "").slice(0, 40) : "no token";
        throw new AmplenoteError(`Amplenote refused the token request (${response.status} ${code})`, response.status);
    }
    return data;
}

async function storeTokens(env: Env, tokens: TokenResponse, actor: string | null, now = new Date(), requested: string = SCOPE) {
    const expires = new Date(now.getTime() + Math.max(60, Math.min(tokens.expires_in ?? 7200, 86_400)) * 1000).toISOString();
    const access = await seal(env, tokens.access_token);
    const refresh = tokens.refresh_token ? await seal(env, tokens.refresh_token) : null;
    if (actor) {
        await env.DB.prepare(
            `INSERT INTO amplenote_connection (id, access_token, refresh_token, expires_at, scope, connected_by, connected_at, list_cursor, full_listed_at, last_error, updated_at)
             VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL, NULL, ?6)
             ON CONFLICT(id) DO UPDATE SET access_token = excluded.access_token, refresh_token = excluded.refresh_token, expires_at = excluded.expires_at,
                scope = excluded.scope, connected_by = excluded.connected_by, connected_at = excluded.connected_at, list_cursor = NULL, full_listed_at = NULL,
                last_error = NULL, updated_at = excluded.updated_at`,
        )
            .bind(access, refresh, expires, tokens.scope ?? requested, actor, now.toISOString())
            .run();
    } else {
        // A refresh: keep the old refresh token unless Amplenote rotated it.
        await env.DB.prepare(
            "UPDATE amplenote_connection SET access_token = ?, refresh_token = COALESCE(?, refresh_token), expires_at = ?, last_error = NULL, updated_at = ? WHERE id = 1",
        )
            .bind(access, refresh, expires, now.toISOString())
            .run();
    }
}

/**
 * Completes the sign-in, server-side. The state must exist, be unused (it's deleted here whatever
 * happens next) and under ten minutes old, and the browser must present the nonce set when it was
 * started. The code is exchanged with the PKCE verifier; the tokens never reach the browser.
 */
export async function finishConnect(env: Env, code: string, state: string, nonce: string | null, fetchImpl: typeof fetch = fetch) {
    const row = await env.DB.prepare("DELETE FROM amplenote_oauth_states WHERE state = ? RETURNING verifier, browser, actor, created_at, scope")
        .bind(state)
        .first<{ verifier: string; browser: string; actor: string; created_at: string; scope: string | null }>();
    if (!row || !nonce || (await digest(nonce)) !== row.browser || Date.now() - Date.parse(row.created_at) > STATE_MINUTES * 60_000) {
        throw new AmplenoteError("This sign-in has expired or wasn't started in this browser. Start again from Portal settings.");
    }
    const actor = row.actor;
    const verifier = await unseal(env, row.verifier);
    if (!verifier) throw new AmplenoteError("This sign-in can't be completed. Start again from Portal settings.");
    const tokens = await tokenRequest(env, { grant_type: "authorization_code", code, redirect_uri: redirectUri(env), code_verifier: verifier }, fetchImpl);
    const requested = row.scope ?? SCOPE;
    await storeTokens(env, tokens, actor, new Date(), requested);
    const writes = WRITE_SCOPES.every((s) => grantedScopes(tokens.scope ?? requested).has(s));
    await auditStatement(env.DB, {
        actor,
        action: "website.amplenote.connect",
        entityType: "website",
        entityId: "amplenote",
        summary: writes
            ? "Connected the Amplenote API (list notes; add notes and content for AI assistants)"
            : "Connected the Amplenote API (read-only note list) for blog publishing",
    }).run();
}

export async function disconnect(env: Env, actor: string) {
    await env.DB.batch([
        env.DB.prepare("DELETE FROM amplenote_connection WHERE id = 1"),
        auditStatement(env.DB, {
            actor,
            action: "website.amplenote.disconnect",
            entityType: "website",
            entityId: "amplenote",
            summary: "Disconnected the Amplenote API",
        }),
    ]);
}

export interface ConnectionRow {
    access_token: string;
    refresh_token: string | null;
    expires_at: string | null;
    scope: string | null;
    connected_by: string;
    connected_at: string;
    list_cursor: number | null;
    full_listed_at: string | null;
    last_error: string | null;
}

export const loadConnection = (env: Env) => env.DB.prepare("SELECT * FROM amplenote_connection WHERE id = 1").first<ConnectionRow>();

const recordError = (env: Env, message: string) =>
    env.DB.prepare("UPDATE amplenote_connection SET last_error = ?, updated_at = ? WHERE id = 1").bind(message.slice(0, 300), nowIso()).run();

/** A current access token, refreshing it when it's about to expire. Null when the connection can't be used. */
export async function accessToken(env: Env, connection: ConnectionRow, fetchImpl: typeof fetch = fetch, now = new Date()): Promise<string | null> {
    if (connection.expires_at && Date.parse(connection.expires_at) - now.getTime() > 120_000) {
        const token = await unseal(env, connection.access_token);
        if (token) return token;
    }
    const refresh = connection.refresh_token ? await unseal(env, connection.refresh_token) : null;
    if (!refresh) {
        await recordError(env, "The Amplenote connection has expired. Reconnect it in Portal settings → Website.");
        return null;
    }
    try {
        const tokens = await tokenRequest(env, { grant_type: "refresh_token", refresh_token: refresh }, fetchImpl);
        await storeTokens(env, tokens, null, now);
        return tokens.access_token;
    } catch (error) {
        const status = (error as AmplenoteError).status;
        // 400/401 means the grant itself is gone (revoked, or the refresh token was used up): say so plainly.
        await recordError(
            env,
            status === 400 || status === 401
                ? "Amplenote no longer accepts this connection. Reconnect it in Portal settings → Website."
                : (error as Error).message,
        );
        return null;
    }
}

export interface ApiNote {
    uuid: string;
    name: string | null;
    /** Null when the listing didn't carry a readable tag list, so nothing can be concluded. */
    tags: string[] | null;
    /** Null when the listing didn't carry a boolean "public", so nothing can be concluded. */
    public: boolean | null;
    deleted: boolean;
    created: number | null;
    updated: number | null;
}

/**
 * GET /v4/notes, which answers { notes: [...], tags: [...] } (a bare array is accepted too). Anything
 * but a well-formed list throws, so a failed or garbled response can never
 * be mistaken for "these notes are gone".
 */
export async function listNotes(env: Env, token: string, since: number | null, fetchImpl: typeof fetch = fetch): Promise<ApiNote[]> {
    const url = new URL(`${hosts(env).api}/v4/notes`);
    if (since) url.searchParams.set("since", String(Math.floor(since)));
    let response: Response;
    try {
        response = await fetchImpl(url.toString(), {
            headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
            redirect: "manual",
            signal: AbortSignal.timeout(25_000),
        });
    } catch (error) {
        throw new AmplenoteError(`Listing notes failed (${(error as Error).message})`);
    }
    if (!response.ok) {
        await response.body?.cancel();
        throw new AmplenoteError(`Listing notes failed (${response.status})`, response.status);
    }
    const data = (await response.json().catch(() => null)) as unknown;
    const list = Array.isArray(data) ? data : Array.isArray((data as { notes?: unknown })?.notes) ? (data as { notes: unknown[] }).notes : null;
    if (!list) throw new AmplenoteError("Listing notes returned something that isn't a note list");
    return list.flatMap((raw): ApiNote[] => {
        const note = raw as Record<string, unknown>;
        if (typeof note?.uuid !== "string" || !/^[0-9a-f-]{36}$/i.test(note.uuid)) return [];
        const timestamps = (note.timestamps ?? {}) as Record<string, unknown>;
        const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
        return [
            {
                uuid: note.uuid.toLowerCase(),
                name: typeof note.name === "string" ? note.name : null,
                // Strings in the spec; { text } objects (the shape notes are created with) are read too.
                tags: Array.isArray(note.tags)
                    ? note.tags.flatMap((t) => (typeof t === "string" ? [t] : typeof t?.text === "string" ? [t.text as string] : []))
                    : null,
                public: typeof note.public === "boolean" ? note.public : null,
                deleted: note.deleted === true || note.unrestorable === true,
                created: num(timestamps.created),
                updated: num(timestamps.updated) ?? num(timestamps.changed),
            },
        ];
    });
}

// --- Adding notes and content (AI assistants, worker/amplenote/assistant.ts) -----------------------
// Both are write-only on Amplenote's side: nothing comes back but the new note's uuid (POST /notes) or
// a status (POST /notes/{uuid}/actions). A request that got no answer at all may still have been
// carried out, so it is reported as `unknownOutcome`, never as "nothing happened".

/** A ProseMirror-style node as Amplenote's INSERT_NODES action takes it. */
export interface AmplenoteNode {
    type: string;
    attrs?: Record<string, unknown>;
    content?: AmplenoteNode[];
    text?: string;
}

export class AmplenoteWriteError extends AmplenoteError {
    constructor(
        message: string,
        status = 0,
        /** The request may have reached Amplenote and been carried out (timeout, dropped connection). */
        readonly unknownOutcome = false,
    ) {
        super(message, status);
    }
}

async function post(env: Env, token: string, path: string, body: unknown, what: string, fetchImpl: typeof fetch): Promise<unknown> {
    let response: Response;
    try {
        response = await fetchImpl(`${hosts(env).api}${path}`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify(body),
            redirect: "manual",
            signal: AbortSignal.timeout(20_000),
        });
    } catch (error) {
        throw new AmplenoteWriteError(`${what}: Amplenote didn't answer (${(error as Error).name})`, 0, true);
    }
    if (!response.ok) {
        await response.body?.cancel();
        // 5xx: the service failed part-way, so the change may or may not have been made.
        throw new AmplenoteWriteError(`${what}: Amplenote refused it (${response.status})`, response.status, response.status >= 500);
    }
    const text = await response.text().catch(() => "");
    try {
        return text ? (JSON.parse(text) as unknown) : null;
    } catch {
        return null;
    }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /v4/notes with a name and tags. Amplenote answers with the new note; its uuid is read from
 * `uuid` (or `note.uuid`). A success without a recognisable uuid throws with unknownOutcome, because
 * the note exists but can't be named.
 */
export async function createNote(env: Env, token: string, note: { name: string; tags: string[] }, fetchImpl: typeof fetch = fetch): Promise<{ uuid: string }> {
    const data = (await post(env, token, "/v4/notes", { name: note.name, tags: note.tags.map((text) => ({ text })) }, "Creating the note", fetchImpl)) as {
        uuid?: unknown;
        note?: { uuid?: unknown };
    } | null;
    const uuid = typeof data?.uuid === "string" ? data.uuid : typeof data?.note?.uuid === "string" ? data.note.uuid : null;
    if (!uuid || !UUID.test(uuid)) throw new AmplenoteWriteError("Amplenote accepted the note but didn't say which note it created", 200, true);
    return { uuid: uuid.toLowerCase() };
}

/** POST /v4/notes/{uuid}/actions with INSERT_NODES. Amplenote decides where in the note they go. */
export async function insertNodes(env: Env, token: string, uuid: string, nodes: AmplenoteNode[], fetchImpl: typeof fetch = fetch): Promise<void> {
    if (!UUID.test(uuid)) throw new AmplenoteWriteError("Not a valid Amplenote note id", 400);
    await post(env, token, `/v4/notes/${uuid.toLowerCase()}/actions`, { type: "INSERT_NODES", nodes }, "Adding to the note", fetchImpl);
}
