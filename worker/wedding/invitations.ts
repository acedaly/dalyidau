import type { D1Database } from "@cloudflare/workers-types";
import type { RsvpSettings } from "../../src/shared/portal/types";
import type { Env } from "../env";

const encoder = new TextEncoder();
const TOKEN_RE = /^([A-Za-z0-9_-]{4,80})\.([1-9][0-9]{0,8})\.([A-Za-z0-9_-]{43})$/;

const base64url = (bytes: Uint8Array) => {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

const encodeText = (value: string) => base64url(encoder.encode(value));

const decodeBytes = (value: string) => {
    try {
        const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
        const binary = atob(padded);
        return Uint8Array.from(binary, (char) => char.charCodeAt(0));
    } catch {
        return null;
    }
};

const decodeText = (value: string) => {
    const bytes = decodeBytes(value);
    return bytes ? new TextDecoder().decode(bytes) : null;
};

const validSecret = (secret: string | undefined) => (secret && encoder.encode(secret).byteLength >= 32 ? secret : null);

export const invitationLinksConfigured = (env: Env) => !!validSecret(env.RSVP_LINK_SECRET);

const signingKey = (secret: string) => {
    if (!validSecret(secret)) throw new Error("RSVP_LINK_SECRET must contain at least 32 bytes");
    return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
};

const signature = async (secret: string, value: string) =>
    base64url(new Uint8Array(await crypto.subtle.sign("HMAC", await signingKey(secret), encoder.encode(value))));

export interface InvitationHousehold {
    id: string;
    name: string;
    rsvp_code: string;
    invite_version: number;
    invite_revoked_at: string | null;
}

/** Tokens contain only a random database id and version; integrity comes from a 256-bit HMAC. */
export async function invitationToken(secret: string, householdId: string, version: number) {
    const payload = `${encodeText(householdId)}.${version}`;
    return `${payload}.${await signature(secret, payload)}`;
}

export async function invitationUrl(env: Env, householdId: string, version: number) {
    const secret = validSecret(env.RSVP_LINK_SECRET);
    if (!secret) return null;
    const token = await invitationToken(secret, householdId, version);
    return `${env.SITE_URL.replace(/\/+$/, "")}/wedding/rsvp?invite=${encodeURIComponent(token)}`;
}

export async function verifyInvitationToken(secret: string, token: string): Promise<{ householdId: string; version: number } | null> {
    const match = TOKEN_RE.exec(token);
    if (!match) return null;
    const householdId = decodeText(match[1]);
    const version = Number(match[2]);
    if (!householdId || householdId.length > 40 || !Number.isSafeInteger(version)) return null;
    const payload = `${match[1]}.${match[2]}`;
    const provided = decodeBytes(match[3]);
    if (!provided || base64url(provided) !== match[3]) return null;
    const valid = await crypto.subtle.verify("HMAC", await signingKey(secret), provided, encoder.encode(payload));
    return valid ? { householdId, version } : null;
}

export function invitationExpired(settings: RsvpSettings, now = new Date()) {
    if (!settings.deadline || settings.linkExpiryDays === 0) return false;
    const expiry = new Date(`${settings.deadline}T23:59:59.999Z`);
    expiry.setUTCDate(expiry.getUTCDate() + settings.linkExpiryDays);
    return now.getTime() > expiry.getTime();
}

export async function householdForInvitation(db: D1Database, env: Env, token: string, settings: RsvpSettings) {
    const secret = validSecret(env.RSVP_LINK_SECRET);
    if (!secret || invitationExpired(settings)) return null;
    const verified = await verifyInvitationToken(secret, token);
    if (!verified) return null;
    return db
        .prepare(
            `SELECT id, name, rsvp_code, invite_version, invite_revoked_at FROM households
             WHERE id = ? AND invite_version = ? AND invite_revoked_at IS NULL AND deleted_at IS NULL`,
        )
        .bind(verified.householdId, verified.version)
        .first<InvitationHousehold>();
}
