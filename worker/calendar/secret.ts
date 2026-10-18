// Subscription addresses are credentials (a Google "secret address", an iCloud public link with a
// token in it). They're stored encrypted with AES-GCM when the CALENDAR_ENCRYPTION_KEY secret is
// set, so a database export or backup alone can't be used to read anyone's calendar. Without the
// secret they're stored as they are (and the Subscriptions page says so); setting it later
// encrypts each address the next time its feed is refreshed.
import type { Env } from "../env";

const PREFIX = "v1";
const enc = new TextEncoder();

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function key(env: Env): Promise<CryptoKey | null> {
    const secret = env.CALENDAR_ENCRYPTION_KEY?.trim();
    if (!secret || secret.length < 32) return null;
    const material = await crypto.subtle.digest("SHA-256", enc.encode(`daly-calendar-url:${secret}`));
    return crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export const encryptionConfigured = (env: Env) => (env.CALENDAR_ENCRYPTION_KEY?.trim().length ?? 0) >= 32;

export async function sealUrl(env: Env, url: string): Promise<string> {
    const k = await key(env);
    if (!k) return `plain:${url}`;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k, enc.encode(url)));
    return `${PREFIX}:${b64(iv)}:${b64(sealed)}`;
}

/** The address, or null when it was encrypted with a key that isn't available (the secret was removed or changed). */
export async function openUrl(env: Env, stored: string): Promise<string | null> {
    if (stored.startsWith("plain:")) return stored.slice(6);
    const [version, iv, data] = stored.split(":");
    if (version !== PREFIX || !iv || !data) return null;
    const k = await key(env);
    if (!k) return null;
    try {
        return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, k, unb64(data)));
    } catch {
        return null;
    }
}

export const isSealed = (stored: string) => stored.startsWith(`${PREFIX}:`);

/** A stable fingerprint of an address for duplicate checks; never reversible to the address. */
export async function urlFingerprint(url: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", enc.encode(`daly-calendar-feed:${url}`));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
