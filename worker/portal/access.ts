// Verifies the Cloudflare Access JWT on every protected request.
//
// Cloudflare Access sits in front of /portal and /api/portal and adds a signed JWT in the
// Cf-Access-Jwt-Assertion header. The Worker does not trust that the request came through Access:
// it checks the RS256 signature against the team's published keys, the issuer, the application
// audience tag and the expiry. Any missing configuration, network failure or malformed token is
// treated as "not signed in".
//
// https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/
import type { Env } from "../env";

export interface AccessIdentity {
    email: string;
    /** Access user id (the `sub` claim). Empty for service tokens, which are rejected anyway. */
    subject: string;
}

export type AccessFailure =
    | "not_configured"
    | "missing_token"
    | "malformed"
    | "unsupported_alg"
    | "unknown_key"
    | "bad_signature"
    | "wrong_issuer"
    | "wrong_audience"
    | "expired"
    | "not_yet_valid"
    | "no_email"
    | "keys_unavailable";

export type AccessResult = { ok: true; identity: AccessIdentity } | { ok: false; reason: AccessFailure };

interface Jwk {
    kid: string;
    kty: string;
    alg?: string;
    n: string;
    e: string;
}

interface AccessConfig {
    teamDomain: string;
    audiences: string[];
}

const CLOCK_SKEW_SECONDS = 60;
const KEY_CACHE_MS = 10 * 60_000;
/** After an unknown kid triggers a refetch, wait this long before refetching for another. */
const KEY_REFETCH_COOLDOWN_MS = 30_000;

let keyCache: { teamDomain: string; fetchedAt: number; keys: Map<string, CryptoKey> } | null = null;

/** Reads and normalises the Access settings. Returns null (fail closed) when anything is missing. */
export const accessConfig = (env: Env): AccessConfig | null => {
    const team = (env.ACCESS_TEAM_DOMAIN ?? "")
        .trim()
        .replace(/^https?:\/\//, "")
        .replace(/\/+$/, "");
    const audiences = (env.ACCESS_AUD ?? "")
        .split(",")
        .map((a) => a.trim())
        .filter(Boolean);
    if (!team || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(team) || audiences.length === 0) return null;
    return { teamDomain: team.toLowerCase(), audiences };
};

/** Pulls the token from the header Access injects, falling back to the CF_Authorization cookie. */
export const accessToken = (request: Request): string | null => {
    const header = request.headers.get("Cf-Access-Jwt-Assertion");
    if (header) return header.trim();
    const cookie = request.headers.get("Cookie") ?? "";
    const match = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(cookie);
    return match ? match[1] : null;
};

export async function verifyAccessRequest(request: Request, env: Env, now = Date.now()): Promise<AccessResult> {
    const config = accessConfig(env);
    if (!config) return { ok: false, reason: "not_configured" };
    const token = accessToken(request);
    if (!token) return { ok: false, reason: "missing_token" };
    return verifyAccessJwt(token, config, (kid) => signingKey(env, config.teamDomain, kid, now), now);
}

export async function verifyAccessJwt(
    token: string,
    config: AccessConfig,
    keyFor: (kid: string) => Promise<CryptoKey | null | "unavailable">,
    now = Date.now(),
): Promise<AccessResult> {
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) return { ok: false, reason: "malformed" };

    let header: { alg?: unknown; kid?: unknown };
    let claims: Record<string, unknown>;
    try {
        header = JSON.parse(decodeUtf8(base64UrlDecode(parts[0])));
        claims = JSON.parse(decodeUtf8(base64UrlDecode(parts[1])));
    } catch {
        return { ok: false, reason: "malformed" };
    }
    if (!header || typeof header !== "object" || !claims || typeof claims !== "object") return { ok: false, reason: "malformed" };

    // Only RS256. This also rules out "none" and HMAC algorithm-confusion tricks.
    if (header.alg !== "RS256") return { ok: false, reason: "unsupported_alg" };
    if (typeof header.kid !== "string" || !header.kid) return { ok: false, reason: "unknown_key" };

    const key = await keyFor(header.kid);
    if (key === "unavailable") return { ok: false, reason: "keys_unavailable" };
    if (!key) return { ok: false, reason: "unknown_key" };

    const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    let valid = false;
    try {
        valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, base64UrlDecode(parts[2]), signed);
    } catch {
        valid = false;
    }
    if (!valid) return { ok: false, reason: "bad_signature" };

    if (claims.iss !== `https://${config.teamDomain}`) return { ok: false, reason: "wrong_issuer" };

    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.some((a) => typeof a === "string" && config.audiences.includes(a))) return { ok: false, reason: "wrong_audience" };

    const seconds = Math.floor(now / 1000);
    if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_SECONDS < seconds) return { ok: false, reason: "expired" };
    if (typeof claims.nbf === "number" && claims.nbf - CLOCK_SKEW_SECONDS > seconds) return { ok: false, reason: "not_yet_valid" };
    if (typeof claims.iat === "number" && claims.iat - CLOCK_SKEW_SECONDS > seconds) return { ok: false, reason: "not_yet_valid" };

    // Service tokens carry no email; the portal is for people only.
    const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
    if (!email || !email.includes("@")) return { ok: false, reason: "no_email" };

    return { ok: true, identity: { email, subject: typeof claims.sub === "string" ? claims.sub : "" } };
}

/**
 * Finds the signing key for a kid. Keys come from https://<team>/cdn-cgi/access/certs and are cached
 * for ten minutes. An unknown kid (key rotation) triggers one refetch, rate-limited.
 *
 * Outside production, ACCESS_TEST_JWKS can supply the key set directly so automated tests can sign
 * their own tokens. It is ignored when ENVIRONMENT is "production".
 */
async function signingKey(env: Env, teamDomain: string, kid: string, now: number): Promise<CryptoKey | null | "unavailable"> {
    if (env.ACCESS_TEST_JWKS && env.ENVIRONMENT !== "production") {
        const keys = await importKeySet(JSON.parse(env.ACCESS_TEST_JWKS) as { keys: Jwk[] });
        return keys.get(kid) ?? null;
    }

    const fresh = keyCache && keyCache.teamDomain === teamDomain && now - keyCache.fetchedAt < KEY_CACHE_MS;
    if (fresh && keyCache!.keys.has(kid)) return keyCache!.keys.get(kid)!;
    const canRefetch = !keyCache || keyCache.teamDomain !== teamDomain || now - keyCache.fetchedAt > KEY_REFETCH_COOLDOWN_MS;
    if (fresh && !canRefetch) return null;

    try {
        const response = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`, { headers: { Accept: "application/json" } });
        if (!response.ok) throw new Error(`certs ${response.status}`);
        const keys = await importKeySet((await response.json()) as { keys: Jwk[] });
        keyCache = { teamDomain, fetchedAt: now, keys };
        return keys.get(kid) ?? null;
    } catch (error) {
        console.error(JSON.stringify({ event: "access_keys_error", message: (error as Error).message }));
        // A stale cache is still better than locking everyone out during a blip.
        if (keyCache && keyCache.teamDomain === teamDomain && keyCache.keys.has(kid)) return keyCache.keys.get(kid)!;
        return "unavailable";
    }
}

async function importKeySet(set: { keys: Jwk[] }): Promise<Map<string, CryptoKey>> {
    const keys = new Map<string, CryptoKey>();
    for (const jwk of Array.isArray(set?.keys) ? set.keys : []) {
        if (jwk.kty !== "RSA" || !jwk.kid || (jwk.alg && jwk.alg !== "RS256")) continue;
        try {
            const key = await crypto.subtle.importKey(
                "jwk",
                { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
                { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
                false,
                ["verify"],
            );
            keys.set(jwk.kid, key);
        } catch {
            // Skip keys that fail to import rather than failing the whole set.
        }
    }
    return keys;
}

/** Test hook: forget cached keys. */
export const resetAccessKeyCache = () => {
    keyCache = null;
};

const base64UrlDecode = (value: string): Uint8Array<ArrayBuffer> => {
    const base64 = value
        .replace(/-/g, "+")
        .replace(/_/g, "/")
        .padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
};

const decodeUtf8 = (bytes: Uint8Array<ArrayBuffer>) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
