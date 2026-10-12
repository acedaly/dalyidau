// People who can use the portal and their roles. Cloudflare Access still has to let them in:
// adding someone here without adding them to the Access policy does nothing, and vice versa.
import type { D1Database } from "@cloudflare/workers-types";
import { z } from "zod";
import { ROLES } from "../../src/shared/portal/permissions";
import type { PortalUserRecord } from "../../src/shared/portal/types";
import type { Env } from "../env";
import { ownerEmails } from "./auth";
import { auditStatement, nowIso } from "./db";
import { NotFoundError, ValidationError } from "./entities";

export async function listUsers(env: Env, db: D1Database): Promise<PortalUserRecord[]> {
    const owners = ownerEmails(env);
    const rows = await db.prepare("SELECT * FROM portal_users ORDER BY email").all<Record<string, unknown>>();
    const users: PortalUserRecord[] = rows.results.map((r) => ({
        email: r.email as string,
        name: (r.name as string | null) ?? null,
        role: owners.has(r.email as string) ? "owner" : (r.role as PortalUserRecord["role"]),
        active: owners.has(r.email as string) || r.active === 1,
        fromConfig: owners.has(r.email as string),
        createdAt: (r.created_at as string | null) ?? null,
        lastSeenAt: (r.last_seen_at as string | null) ?? null,
    }));
    for (const email of owners) {
        if (!users.some((u) => u.email === email))
            users.push({ email, name: null, role: "owner", active: true, fromConfig: true, createdAt: null, lastSeenAt: null });
    }
    return users.sort((a, b) => Number(b.fromConfig) - Number(a.fromConfig) || a.email.localeCompare(b.email));
}

const userSchema = z.object({
    email: z.string().trim().toLowerCase().pipe(z.email()),
    name: z
        .string()
        .trim()
        .max(80)
        .transform((v) => v || null)
        .nullable()
        .optional(),
    role: z.enum(ROLES),
    active: z.boolean().default(true),
});

export async function saveUser(env: Env, db: D1Database, input: unknown, actor: string) {
    const data = userSchema.parse(input);
    if (ownerEmails(env).has(data.email)) {
        throw new ValidationError("This person is an owner through PORTAL_OWNER_EMAILS; change that setting to change their role", "email");
    }
    if (data.email === actor) throw new ValidationError("You can't change your own role", "email");
    const before = await db.prepare("SELECT role, active, name FROM portal_users WHERE email = ?").bind(data.email).first<Record<string, unknown>>();
    await db.batch([
        db
            .prepare(
                `INSERT INTO portal_users (email, name, role, active, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(email) DO UPDATE SET name = ?2, role = ?3, active = ?4`,
            )
            .bind(data.email, data.name ?? null, data.role, data.active ? 1 : 0, nowIso()),
        auditStatement(db, {
            actor,
            action: before ? "user.update" : "user.create",
            entityType: "portal_user",
            entityId: data.email,
            summary: before ? `Changed ${data.email} to ${data.role}${data.active ? "" : " (inactive)"}` : `Gave ${data.email} the ${data.role} role`,
            changes: before ? { role: [before.role, data.role], active: [before.active === 1, data.active] } : undefined,
        }),
    ]);
    return (await listUsers(env, db)).find((u) => u.email === data.email)!;
}

export async function removeUser(env: Env, db: D1Database, email: string, actor: string) {
    const normalised = email.trim().toLowerCase();
    if (ownerEmails(env).has(normalised)) throw new ValidationError("Owners from PORTAL_OWNER_EMAILS can't be removed here", "email");
    if (normalised === actor) throw new ValidationError("You can't remove yourself", "email");
    const before = await db.prepare("SELECT role FROM portal_users WHERE email = ?").bind(normalised).first<{ role: string }>();
    if (!before) throw new NotFoundError("No such person");
    await db.batch([
        db.prepare("DELETE FROM portal_users WHERE email = ?").bind(normalised),
        auditStatement(db, {
            actor,
            action: "user.delete",
            entityType: "portal_user",
            entityId: normalised,
            summary: `Removed ${normalised} (${before.role})`,
        }),
    ]);
}
