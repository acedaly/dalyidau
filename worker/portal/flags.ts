import type { D1Database } from "@cloudflare/workers-types";
import { FLAG_DEFINITIONS, type FlagKey, type Flags, defaultFlags, isFlagKey } from "../../src/shared/portal/flags";
import { auditStatement, nowIso } from "./db";

export async function loadFlags(db: D1Database): Promise<Flags> {
    const flags = defaultFlags();
    const rows = await db.prepare("SELECT key, enabled FROM feature_flags").all<{ key: string; enabled: number }>();
    for (const row of rows.results) if (isFlagKey(row.key)) flags[row.key] = row.enabled === 1;
    return flags;
}

export async function isEnabled(db: D1Database, key: FlagKey): Promise<boolean> {
    const row = await db.prepare("SELECT enabled FROM feature_flags WHERE key = ?").bind(key).first<{ enabled: number }>();
    return row ? row.enabled === 1 : FLAG_DEFINITIONS[key].default;
}

export async function setFlag(db: D1Database, key: FlagKey, enabled: boolean, actor: string) {
    const before = await isEnabled(db, key);
    await db.batch([
        db
            .prepare(
                `INSERT INTO feature_flags (key, enabled, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(key) DO UPDATE SET enabled = ?2, updated_at = ?3, updated_by = ?4`,
            )
            .bind(key, enabled ? 1 : 0, nowIso(), actor),
        auditStatement(db, {
            actor,
            action: "flag.update",
            entityType: "feature_flag",
            entityId: key,
            summary: `${enabled ? "Turned on" : "Turned off"} “${FLAG_DEFINITIONS[key].label}”`,
            changes: { enabled: [before, enabled] },
        }),
    ]);
}
