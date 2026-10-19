// How the Intelligence Centre reaches public services. Every request:
//  - goes only to hosts on the source's allow-list, over https (http only where a source says so);
//  - follows at most two redirects, each checked against the same allow-list (no redirect abuse);
//  - has a strict timeout and a byte limit enforced while the body streams in;
//  - sends a descriptive User-Agent and conditional headers (ETag / Last-Modified) when known;
//  - never puts a credential in anything that is logged or stored.
//
// Tests and local development replace the transport (fixtures, never the live service), and those
// records are marked as fixtures wherever they appear.
import type { Env } from "../env";
import { type FtpClient, socketFtp } from "./ftp";

export class FetchFailure extends Error {
    constructor(
        readonly code:
            | "timeout"
            | "too_large"
            | "http_error"
            | "not_allowed"
            | "redirect_refused"
            | "network"
            | "not_modified"
            | "parse_error"
            | "validation"
            | "credentials_missing"
            | "credentials_rejected"
            | "rate_limited"
            | "replayed",
        message: string,
        readonly httpStatus: number | null = null,
        readonly retryable = true,
    ) {
        super(message);
    }
}

export interface FetchOptions {
    allowedHosts: readonly string[];
    timeoutMs: number;
    maxBytes: number;
    method?: "GET" | "POST";
    headers?: Record<string, string>;
    body?: string;
    etag?: string | null;
    lastModified?: string | null;
    allowHttp?: boolean;
}

export interface FetchResult {
    status: number;
    notModified: boolean;
    bytes: Uint8Array;
    etag: string | null;
    lastModified: string | null;
    contentType: string;
}

export interface CentreTransport {
    fetch: (url: string, init: RequestInit) => Promise<Response>;
    ftp: FtpClient;
    /** True when this transport serves recorded fixtures or a local stand-in rather than the live services. */
    fixture: boolean;
}

export const USER_AGENT = "DalyPortal-IntelligenceCentre/1.0 (+https://daly.id.au; private household portal)";

const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[?::1\]?|\[?f[cd][0-9a-f]{2}:)/i;

/** Checks a URL against the allow-list. Exported for tests (SSRF). */
export function checkUrl(raw: string, options: Pick<FetchOptions, "allowedHosts" | "allowHttp">): URL {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new FetchFailure("not_allowed", "Not a valid address", null, false);
    }
    if (url.protocol !== "https:" && !(options.allowHttp && url.protocol === "http:"))
        throw new FetchFailure("not_allowed", "Only https addresses are allowed", null, false);
    if (url.username || url.password) throw new FetchFailure("not_allowed", "Addresses with credentials are refused", null, false);
    const host = url.hostname.toLowerCase();
    if (PRIVATE_HOST.test(host) || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":"))
        throw new FetchFailure("not_allowed", "Private and numeric addresses are refused", null, false);
    if (!options.allowedHosts.includes(host)) throw new FetchFailure("not_allowed", "That host isn't on this source's allow-list", null, false);
    if (url.port && url.port !== "443" && url.port !== "80") throw new FetchFailure("not_allowed", "Unexpected port", null, false);
    return url;
}

async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
    const length = Number(response.headers.get("Content-Length") ?? "0");
    if (length > maxBytes) {
        await response.body?.cancel().catch(() => undefined);
        throw new FetchFailure("too_large", `The response is larger than this source's limit (${Math.round(maxBytes / 1024)} KB)`, response.status, false);
    }
    if (!response.body) return new Uint8Array();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
            await reader.cancel().catch(() => undefined);
            throw new FetchFailure("too_large", `The response is larger than this source's limit (${Math.round(maxBytes / 1024)} KB)`, response.status, false);
        }
        chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bytes;
}

/** Runs `work` with an AbortSignal that fires after `ms`. */
async function withDeadline<T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
        return await work(controller.signal);
    } catch (error) {
        if (controller.signal.aborted) throw new FetchFailure("timeout", `No complete answer within ${Math.round(ms / 1000)} s`);
        throw error;
    } finally {
        clearTimeout(timer);
    }
}

export async function safeFetch(transport: CentreTransport, rawUrl: string, options: FetchOptions): Promise<FetchResult> {
    let url = checkUrl(rawUrl, options);
    const headers: Record<string, string> = {
        "User-Agent": USER_AGENT,
        Accept: "application/json, application/xml, text/xml, text/csv, */*;q=0.5",
        ...options.headers,
    };
    if (options.etag) headers["If-None-Match"] = options.etag;
    if (options.lastModified) headers["If-Modified-Since"] = options.lastModified;
    return withDeadline(options.timeoutMs, async (signal) => {
        for (let hop = 0; hop <= 2; hop++) {
            let response: Response;
            try {
                response = await transport.fetch(url.toString(), { method: options.method ?? "GET", headers, body: options.body, redirect: "manual", signal });
            } catch (error) {
                if (signal.aborted) throw error;
                throw new FetchFailure("network", "The service couldn't be reached");
            }
            if (response.status >= 300 && response.status < 400 && response.status !== 304) {
                const location = response.headers.get("Location");
                await response.body?.cancel().catch(() => undefined);
                if (!location || hop === 2) throw new FetchFailure("redirect_refused", "Too many redirects", response.status, false);
                try {
                    url = checkUrl(new URL(location, url).toString(), options);
                } catch {
                    throw new FetchFailure("redirect_refused", "The service redirected somewhere that isn't allowed", response.status, false);
                }
                continue;
            }
            if (response.status === 304) {
                await response.body?.cancel().catch(() => undefined);
                return {
                    status: 304,
                    notModified: true,
                    bytes: new Uint8Array(),
                    etag: options.etag ?? null,
                    lastModified: options.lastModified ?? null,
                    contentType: "",
                };
            }
            if (response.status === 401 || response.status === 403) {
                await response.body?.cancel().catch(() => undefined);
                throw new FetchFailure("credentials_rejected", "The service refused access (check the key or the provider's terms)", response.status, false);
            }
            if (response.status === 429) {
                await response.body?.cancel().catch(() => undefined);
                throw new FetchFailure("rate_limited", "The service asked us to slow down", 429);
            }
            if (!response.ok) {
                await response.body?.cancel().catch(() => undefined);
                throw new FetchFailure("http_error", `The service answered ${response.status}`, response.status, response.status >= 500);
            }
            const bytes = await readCapped(response, options.maxBytes);
            return {
                status: response.status,
                notModified: false,
                bytes,
                etag: response.headers.get("ETag"),
                lastModified: response.headers.get("Last-Modified"),
                contentType: response.headers.get("Content-Type") ?? "",
            };
        }
        throw new FetchFailure("redirect_refused", "Too many redirects", null, false);
    });
}

/** Decodes text by byte order mark (some feeds declare UTF-16 and send UTF-8), defaulting to UTF-8. */
export function decodeText(bytes: Uint8Array): string {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
    const start = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
    return new TextDecoder("utf-8").decode(bytes.subarray(start));
}

export function parseJsonBytes(bytes: Uint8Array): unknown {
    try {
        return JSON.parse(decodeText(bytes));
    } catch {
        throw new FetchFailure("parse_error", "The response wasn't valid JSON", null, false);
    }
}

/**
 * Local development only (ENVIRONMENT=development on a localhost SITE_URL): CENTRE_FEED_BASE sends
 * every request to a local server of recorded fixtures (scripts/mock-feeds.mjs) instead of the
 * real host, as `<base>/<host>/<path>`. Nothing deployed can meet all three conditions.
 */
export function fixtureBase(env: Env): string | null {
    if (env.ENVIRONMENT !== "development" || !env.CENTRE_FEED_BASE) return null;
    try {
        const site = new URL(env.SITE_URL).hostname;
        const base = new URL(env.CENTRE_FEED_BASE);
        const local = (h: string) => h === "localhost" || h === "127.0.0.1";
        return local(site) && local(base.hostname) ? base.origin : null;
    } catch {
        return null;
    }
}

/** The transport used outside tests: the real network, or the local fixture server in development. */
export function defaultTransport(env: Env): CentreTransport {
    const base = fixtureBase(env);
    if (!base) return { fetch: (url, init) => fetch(url, init), ftp: socketFtp, fixture: false };
    const rewrite = (url: string) => {
        const u = new URL(url);
        return `${base}/${u.hostname}${u.pathname}${u.search}`;
    };
    return {
        fixture: true,
        fetch: (url, init) => fetch(rewrite(url), init),
        ftp: {
            async list(host, dir, pattern) {
                const r = await fetch(`${base}/ftp/${host}${dir}?list=${encodeURIComponent(pattern)}`);
                if (!r.ok) throw new FetchFailure("network", "Fixture server unavailable");
                return (await r.json()) as { name: string; modified: string; size: number }[];
            },
            async retrieve(host, path, maxBytes) {
                const found = (await this.retrieveMany(host, [path], maxBytes)).get(path);
                if (!found) throw new FetchFailure("http_error", "Not found", 404, false);
                return found;
            },
            async retrieveMany(host, paths, maxBytes) {
                const out = new Map<string, Uint8Array>();
                for (const path of paths) {
                    const r = await fetch(`${base}/ftp/${host}${path}`);
                    if (r.status === 404) continue;
                    if (!r.ok) throw new FetchFailure("network", "Fixture server unavailable");
                    out.set(path, await readCapped(r, maxBytes));
                }
                return out;
            },
        },
    };
}
