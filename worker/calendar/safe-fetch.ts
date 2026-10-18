// Fetching external calendar feeds safely.
//
// A subscription address is chosen by a person, so the Worker treats it as hostile until checked:
//   * https only (webcal:// and webcals:// become https://); no user:password@, no other ports;
//   * never an IP address in a private, loopback, link-local, carrier-grade NAT, multicast or
//     documentation range, never localhost or an internal-only name, never this site's own hosts;
//   * the name is resolved (DNS over HTTPS) and refused if any address it resolves to is private;
//   * redirects are followed by hand, at most three, and every hop is checked the same way;
//   * at most 5 MB is read, with a 15 s timeout, and the body must actually be a VCALENDAR;
//   * conditional requests (ETag, Last-Modified) so unchanged feeds cost almost nothing.
// Errors carry a short code and a message safe to show the owner. The address itself is never
// logged or put in an error message, because it is a credential.

export const MAX_FEED_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

export class FeedError extends Error {
    constructor(
        readonly code: string,
        message: string,
        /** Worth trying again later (a timeout, a 5xx), as opposed to an address that's wrong. */
        readonly retryable: boolean,
    ) {
        super(message);
    }
}

/** Turns what someone pasted into the https URL to fetch, or explains why it can't be used. */
export function normaliseFeedUrl(input: string, ownHosts: readonly string[] = []): URL {
    let text = input.trim();
    if (/^webcals?:\/\//i.test(text)) text = text.replace(/^webcals?:\/\//i, "https://");
    let url: URL;
    try {
        url = new URL(text);
    } catch {
        throw new FeedError("invalid_url", "That isn't a web address. Paste the full address, starting with https:// or webcal://.", false);
    }
    if (url.protocol === "http:") throw new FeedError("insecure", "Only secure (https) calendar addresses can be used. Most providers offer one.", false);
    if (url.protocol !== "https:") throw new FeedError("invalid_url", "Use an https:// or webcal:// calendar address.", false);
    if (url.username || url.password) throw new FeedError("credentials_in_url", "Addresses with a user name or password in them can't be used.", false);
    if (url.port && url.port !== "443") throw new FeedError("port", "Calendar addresses must use the standard secure port.", false);
    checkHost(url.hostname, ownHosts);
    url.hash = "";
    return url;
}

const BLOCKED_SUFFIXES = [".local", ".localhost", ".internal", ".intranet", ".lan", ".home", ".home.arpa", ".corp", ".private", ".invalid", ".onion"];

function checkHost(rawHost: string, ownHosts: readonly string[]) {
    const host = rawHost
        .toLowerCase()
        .replace(/\.$/, "")
        .replace(/^\[|\]$/g, "");
    if (!host) throw new FeedError("invalid_url", "That address has no host.", false);
    if (isIpLiteral(host)) {
        if (isPrivateAddress(host)) throw new FeedError("private_address", "That address points at a private or local network, which isn't allowed.", false);
        throw new FeedError("ip_address", "Use the calendar's web address (a name), not an IP address.", false);
    }
    if (!host.includes(".") || host === "localhost" || BLOCKED_SUFFIXES.some((s) => host.endsWith(s)))
        throw new FeedError("private_address", "That address points at a private or local network, which isn't allowed.", false);
    for (const own of ownHosts) {
        const o = own.toLowerCase();
        if (host === o || host.endsWith(`.${o}`)) throw new FeedError("own_host", "Daly Portal's own addresses can't be subscribed to.", false);
    }
}

export const isIpLiteral = (host: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");

function ipv4Parts(ip: string): number[] | null {
    const parts = ip.split(".").map(Number);
    return parts.length === 4 && parts.every((p) => Number.isInteger(p) && p >= 0 && p <= 255) ? parts : null;
}

function privateV4([a, b, c]: number[]): boolean {
    return (
        a === 0 ||
        a === 10 ||
        a === 127 ||
        (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 0 && (c === 0 || c === 2)) ||
        (a === 192 && b === 168) ||
        (a === 198 && (b === 18 || b === 19)) ||
        (a === 198 && b === 51 && c === 100) ||
        (a === 203 && b === 0 && c === 113) ||
        a >= 224
    );
}

/** Expands an IPv6 address to eight 16-bit groups (null if it isn't one). */
function ipv6Groups(ip: string): number[] | null {
    let text = ip.toLowerCase().split("%")[0];
    // An embedded IPv4 tail (::ffff:192.0.2.1) becomes its two hex groups.
    const v4 = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
    if (v4) {
        const parts = ipv4Parts(v4[2]);
        if (!parts) return null;
        text = `${v4[1]}${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`;
    }
    const halves = text.split("::");
    if (halves.length > 2) return null;
    const parse = (s: string) => (s ? s.split(":").map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? Number.parseInt(g, 16) : Number.NaN)) : []);
    const left = parse(halves[0]);
    const right = halves.length === 2 ? parse(halves[1]) : [];
    const fill = halves.length === 2 ? 8 - left.length - right.length : 0;
    if (fill < 0 || (halves.length === 1 && left.length !== 8)) return null;
    const groups = [...left, ...Array<number>(fill).fill(0), ...right];
    return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/** Whether an address is anywhere a public calendar feed couldn't legitimately be. */
export function isPrivateAddress(ip: string): boolean {
    const v4 = ipv4Parts(ip);
    if (v4) return privateV4(v4);
    const g = ipv6Groups(ip);
    if (!g) return true;
    if (g.every((x) => x === 0)) return true; // ::
    if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
    if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((g[0] & 0xff00) === 0xff00) return true; // multicast
    if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
    // IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible and NAT64 (64:ff9b::/96): check the embedded IPv4.
    const mapped = g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0);
    const nat64 = g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0);
    if (mapped || nat64) return privateV4([g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255]);
    return false;
}

export type Resolver = (host: string) => Promise<string[]>;

/** DNS over HTTPS (Cloudflare's public resolver), A and AAAA. */
export const dohResolver: Resolver = async (host) => {
    const ask = async (type: "A" | "AAAA") => {
        const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`, {
            headers: { Accept: "application/dns-json" },
            signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) throw new FeedError("dns_unavailable", "The calendar's address couldn't be checked just now. It will be tried again.", true);
        const body = (await response.json()) as { Status: number; Answer?: { type: number; data: string }[] };
        return (body.Answer ?? []).filter((a) => a.type === (type === "A" ? 1 : 28)).map((a) => a.data);
    };
    const [a, aaaa] = await Promise.all([ask("A"), ask("AAAA")]);
    return [...a, ...aaaa];
};

async function checkResolved(host: string, resolve: Resolver) {
    let addresses: string[];
    try {
        addresses = await resolve(host);
    } catch (error) {
        if (error instanceof FeedError) throw error;
        throw new FeedError("dns_unavailable", "The calendar's address couldn't be checked just now. It will be tried again.", true);
    }
    if (!addresses.length) throw new FeedError("host_not_found", "That address's server couldn't be found. Check the address and try again.", false);
    if (addresses.some(isPrivateAddress))
        throw new FeedError("private_address", "That address points at a private or local network, which isn't allowed.", false);
}

export interface FeedResult {
    status: "ok" | "not_modified";
    text: string | null;
    etag: string | null;
    lastModified: string | null;
    bytes: number;
}

const httpError = (status: number): FeedError => {
    if (status === 401 || status === 403)
        return new FeedError(
            `http_${status}`,
            "The calendar refused access. The address may have been reset or made private: copy a new one from the calendar app.",
            false,
        );
    if (status === 404 || status === 410)
        return new FeedError(`http_${status}`, "The calendar wasn't found at that address any more. It may have been deleted or its address changed.", false);
    if (status === 429) return new FeedError("http_429", "The calendar's server asked us to slow down. It will be tried again later.", true);
    if (status >= 500) return new FeedError(`http_${status}`, "The calendar's server had a problem. It will be tried again later.", true);
    return new FeedError(`http_${status}`, `The calendar's server answered with an error (${status}).`, false);
};

/** Reads at most `max` bytes, refusing anything bigger even when it doesn't say how big it is. */
async function readCapped(response: Response, max: number): Promise<{ text: string; bytes: number }> {
    const declared = Number(response.headers.get("Content-Length") ?? "0");
    if (declared > max) throw new FeedError("too_large", "That calendar is too large (over 5 MB) to subscribe to.", false);
    if (!response.body) return { text: "", bytes: 0 };
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > max) {
            await reader.cancel().catch(() => undefined);
            throw new FeedError("too_large", "That calendar is too large (over 5 MB) to subscribe to.", false);
        }
        chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) (bytes.set(chunk, offset), (offset += chunk.byteLength));
    return { text: new TextDecoder("utf-8", { fatal: false }).decode(bytes), bytes: total };
}

export interface FetchOptions {
    etag?: string | null;
    lastModified?: string | null;
    ownHosts?: readonly string[];
    resolve?: Resolver;
    maxBytes?: number;
}

/** Fetches a feed with every check above. Throws FeedError for anything that isn't a usable answer. */
export async function fetchFeed(start: URL, options: FetchOptions = {}): Promise<FeedResult> {
    const resolve = options.resolve ?? dohResolver;
    let url = start;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        checkHost(url.hostname, options.ownHosts ?? []);
        await checkResolved(url.hostname.toLowerCase(), resolve);
        const headers: Record<string, string> = {
            Accept: "text/calendar, text/plain;q=0.8, */*;q=0.1",
            "User-Agent": "DalyCalendar/1.0 (+https://daly.id.au; calendar subscription)",
        };
        // Conditional headers belong to the address they came from.
        if (hop === 0 && options.etag) headers["If-None-Match"] = options.etag;
        if (hop === 0 && options.lastModified) headers["If-Modified-Since"] = options.lastModified;
        let response: Response;
        try {
            response = await fetch(url.toString(), { method: "GET", headers, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
        } catch (error) {
            const timedOut = (error as Error)?.name === "TimeoutError" || (error as Error)?.name === "AbortError";
            throw new FeedError(
                timedOut ? "timeout" : "unreachable",
                timedOut ? "The calendar took too long to answer. It will be tried again." : "The calendar couldn't be reached. It will be tried again.",
                true,
            );
        }
        if (response.status >= 300 && response.status < 400 && response.status !== 304) {
            const location = response.headers.get("Location");
            await response.body?.cancel().catch(() => undefined);
            if (!location) throw new FeedError("bad_redirect", "The calendar's server sent a redirect without an address.", false);
            let next: URL;
            try {
                next = new URL(location, url);
            } catch {
                throw new FeedError("bad_redirect", "The calendar's server redirected to an invalid address.", false);
            }
            if (next.protocol !== "https:")
                throw new FeedError("insecure_redirect", "The calendar redirected to an insecure (non-https) address, which isn't allowed.", false);
            if (next.username || next.password || (next.port && next.port !== "443"))
                throw new FeedError("bad_redirect", "The calendar redirected to an address that isn't allowed.", false);
            url = next;
            continue;
        }
        if (response.status === 304) {
            await response.body?.cancel().catch(() => undefined);
            return {
                status: "not_modified",
                text: null,
                etag: response.headers.get("ETag") ?? options.etag ?? null,
                lastModified: options.lastModified ?? null,
                bytes: 0,
            };
        }
        if (!response.ok) {
            await response.body?.cancel().catch(() => undefined);
            throw httpError(response.status);
        }
        const type = (response.headers.get("Content-Type") ?? "").toLowerCase();
        if (/text\/html|application\/(json|javascript|pdf)|image\/|video\/|audio\//.test(type)) {
            await response.body?.cancel().catch(() => undefined);
            throw new FeedError("not_calendar", "That address returned a web page, not a calendar. Use the calendar's ICS or webcal address.", false);
        }
        const { text, bytes } = await readCapped(response, options.maxBytes ?? MAX_FEED_BYTES);
        if (!/^﻿?\s*BEGIN:VCALENDAR/i.test(text))
            throw new FeedError("not_calendar", "That address didn't return a calendar. Use the calendar's ICS or webcal address.", false);
        return {
            status: "ok",
            text,
            etag: (response.headers.get("ETag") ?? "").slice(0, 200) || null,
            lastModified: (response.headers.get("Last-Modified") ?? "").slice(0, 100) || null,
            bytes,
        };
    }
    throw new FeedError("too_many_redirects", "The calendar redirected too many times.", false);
}

/** Which service an address is from, for its icon and help text. */
export function providerOf(url: URL): "google" | "apple" | "outlook" | "other" {
    const host = url.hostname.toLowerCase();
    if (host === "calendar.google.com" || host.endsWith(".google.com")) return "google";
    if (host.endsWith("icloud.com") || host.endsWith(".me.com")) return "apple";
    if (host.endsWith("outlook.office365.com") || host.endsWith("outlook.live.com") || host.endsWith("outlook.office.com")) return "outlook";
    return "other";
}

/** What the owner sees in place of the address: only its host. The path usually is the secret. */
export const maskUrl = (url: URL): string => `${url.hostname}/…`.slice(0, 200);
