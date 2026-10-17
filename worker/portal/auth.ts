// Turns a request into a portal user, or refuses it.
//
// 1. Cloudflare Access identity (verified JWT) → email. No identity, no entry.
// 2. Email → role: PORTAL_OWNER_EMAILS first, then an active row in portal_users. An identity
//    that Access let through but that has no role here is still refused (403).
import { type Permission, type Role, isRole, permissionsFor } from "../../src/shared/portal/permissions";
import type { PortalUser } from "../../src/shared/portal/types";
import type { Env } from "../env";
import { loggablePath } from "../lib/log";
import { type AccessFailure, verifyAccessRequest } from "./access";
import { nowIso } from "./db";

export type AuthResult = { ok: true; user: PortalUser } | { ok: false; status: 401 | 403; reason: AccessFailure | "no_role" | "inactive" };

export const ownerEmails = (env: Env) =>
    new Set(
        (env.PORTAL_OWNER_EMAILS ?? "")
            .split(",")
            .map((e) => e.trim().toLowerCase())
            .filter((e) => e.includes("@")),
    );

/**
 * Local development only: lets `wrangler dev` act as ACCESS_DEV_EMAIL without Access. Requires
 * ENVIRONMENT=development AND a localhost SITE_URL, both of which only .dev.vars or the e2e config
 * set. (The request's own host can't be used: wrangler dev rewrites it to the production route.)
 */
const devIdentity = (env: Env): string | null => {
    if (env.ENVIRONMENT !== "development" || !env.ACCESS_DEV_EMAIL) return null;
    let siteHost = "";
    try {
        siteHost = new URL(env.SITE_URL).hostname;
    } catch {
        return null;
    }
    if (siteHost !== "localhost" && siteHost !== "127.0.0.1") return null;
    return env.ACCESS_DEV_EMAIL.trim().toLowerCase();
};

export async function authenticate(request: Request, env: Env): Promise<AuthResult> {
    let email = devIdentity(env);
    if (!email) {
        const result = await verifyAccessRequest(request, env);
        if (!result.ok) {
            console.log(JSON.stringify({ event: "portal_auth_refused", reason: result.reason, path: loggablePath(new URL(request.url).pathname) }));
            return { ok: false, status: result.reason === "missing_token" ? 401 : 403, reason: result.reason };
        }
        email = result.identity.email;
    }

    let role: Role | null = null;
    let name: string | null = null;
    const row = await env.DB.prepare("SELECT role, name, active FROM portal_users WHERE email = ?")
        .bind(email)
        .first<{ role: string; name: string | null; active: number }>();

    if (ownerEmails(env).has(email)) {
        role = "owner";
        name = row?.name ?? null;
    } else if (row) {
        if (!row.active) return { ok: false, status: 403, reason: "inactive" };
        if (!isRole(row.role)) return { ok: false, status: 403, reason: "no_role" };
        role = row.role;
        name = row.name;
    }
    if (!role) {
        console.log(JSON.stringify({ event: "portal_auth_refused", reason: "no_role" }));
        return { ok: false, status: 403, reason: "no_role" };
    }

    // "Last seen", at most once every ten minutes per user. A configured owner without a row gets
    // an inactive viewer row: it records the visit but grants nothing on its own, so removing
    // someone from PORTAL_OWNER_EMAILS removes their access.
    await env.DB.prepare(
        `INSERT INTO portal_users (email, name, role, active, created_at, last_seen_at) VALUES (?1, NULL, 'viewer', 0, ?2, ?2)
         ON CONFLICT(email) DO UPDATE SET last_seen_at = ?2
         WHERE portal_users.last_seen_at IS NULL OR portal_users.last_seen_at < ?3`,
    )
        .bind(email, nowIso(), new Date(Date.now() - 10 * 60_000).toISOString())
        .run();

    return { ok: true, user: { email, name, role, permissions: permissionsFor(role) } };
}

export const can = (user: PortalUser, permission: Permission) => user.permissions.includes(permission);
