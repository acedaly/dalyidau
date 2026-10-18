// Daly Intelligence settings: the account-wide document (owners and admins with
// portal.settings.manage), each person's preferences, Knowledge exclusions, and which Cloudflare
// bindings this Worker actually has. A capability is available only when its switch is on AND its
// binding exists, so switching something on before the binding is added does nothing.
import type { D1Database } from "@cloudflare/workers-types";
import {
    DEFAULT_CONFIG,
    type IntelligenceConfig,
    type IntelligencePreferences,
    intelligenceConfigSchema,
    parseConfig,
    parsePreferences,
    preferencesSchema,
} from "../../src/shared/intelligence/config";
import type { IntelligenceStatus } from "../../src/shared/intelligence/types";
import type { PortalUser } from "../../src/shared/portal/types";
import type { Env } from "../env";
import { requireObject, requireSpace } from "../knowledge/access";
import { auditStatement, newId, nowIso, parseJson } from "../portal/db";
import { HttpError } from "../portal/http";
import { type AiBinding, MemoryVectorIndex, type VectorIndex, mockAi } from "./bindings";

// --- Bindings ------------------------------------------------------------------------------------

/** The mock provider is for local development and browser tests: never in a deployed environment. */
export const mockAllowed = (env: Env) => {
    if (env.AI_PROVIDER !== "mock" || env.ENVIRONMENT !== "development") return false;
    try {
        const host = new URL(env.SITE_URL).hostname;
        return host === "localhost" || host === "127.0.0.1";
    } catch {
        return false;
    }
};

let mockIndex: MemoryVectorIndex | null = null;

export const aiBinding = (env: Env): AiBinding | null => env.AI ?? (mockAllowed(env) ? mockAi() : null);
export const vectorIndex = (env: Env): VectorIndex | null => env.VECTORS ?? (mockAllowed(env) ? (mockIndex ??= new MemoryVectorIndex()) : null);

// --- Account configuration -------------------------------------------------------------------------

const CONFIG_KEY = "intelligence";

export async function loadConfig(db: D1Database): Promise<{ config: IntelligenceConfig; version: number }> {
    const row = await db.prepare("SELECT value, version FROM ai_config WHERE key = ?").bind(CONFIG_KEY).first<{ value: string; version: number }>();
    return row ? { config: parseConfig(parseJson(row.value, {})), version: row.version } : { config: DEFAULT_CONFIG, version: 0 };
}

/** Replaces the account document. `version` is the one the form was opened with (0 before the first save). */
export async function saveConfig(db: D1Database, user: PortalUser, input: unknown, version: number): Promise<{ config: IntelligenceConfig; version: number }> {
    const config = intelligenceConfigSchema.parse(input);
    const before = await loadConfig(db);
    if (before.version !== version) throw new HttpError(409, "conflict", "Someone else changed these settings. Reload to see their changes.");
    const now = nowIso();
    const changed = (Object.keys(config) as (keyof IntelligenceConfig)[]).filter((k) => JSON.stringify(config[k]) !== JSON.stringify(before.config[k]));
    const write =
        version === 0
            ? db
                  .prepare("INSERT INTO ai_config (key, value, version, updated_at, updated_by) VALUES (?, ?, 1, ?, ?) ON CONFLICT DO NOTHING")
                  .bind(CONFIG_KEY, JSON.stringify(config), now, user.email)
            : db
                  .prepare("UPDATE ai_config SET value = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE key = ? AND version = ?")
                  .bind(JSON.stringify(config), now, user.email, CONFIG_KEY, version);
    const [result] = await db.batch([
        write,
        // Settings hold no personal content, so the portal-wide audit log is the right place.
        auditStatement(db, {
            actor: user.email,
            action: "intelligence.settings",
            entityType: "intelligence",
            entityId: CONFIG_KEY,
            summary: `Changed Intelligence settings (${changed.join(", ") || "no changes"})`,
            changes: { features: [before.config.features, config.features] },
        }),
    ]);
    if (!result.meta.changes) throw new HttpError(409, "conflict", "Someone else changed these settings. Reload to see their changes.");
    return loadConfig(db);
}

// --- Personal preferences --------------------------------------------------------------------------

export async function loadPreferences(db: D1Database, email: string): Promise<{ preferences: IntelligencePreferences; version: number }> {
    const row = await db.prepare("SELECT value, version FROM ai_preferences WHERE email = ?").bind(email).first<{ value: string; version: number }>();
    return row ? { preferences: parsePreferences(parseJson(row.value, {})), version: row.version } : { preferences: parsePreferences({}), version: 0 };
}

export async function savePreferences(db: D1Database, user: PortalUser, input: unknown, version: number) {
    const preferences = preferencesSchema.parse(input);
    // Only spaces the person belongs to can be listed; anything else is quietly dropped.
    const member = new Set(
        (await db.prepare("SELECT space_id FROM knowledge_memberships WHERE email = ?").bind(user.email).all<{ space_id: string }>()).results.map(
            (r) => r.space_id,
        ),
    );
    preferences.excludedSpaceIds = preferences.excludedSpaceIds.filter((id) => member.has(id));
    const now = nowIso();
    const result =
        version === 0
            ? await db
                  .prepare("INSERT INTO ai_preferences (email, value, version, updated_at) VALUES (?, ?, 1, ?) ON CONFLICT DO NOTHING")
                  .bind(user.email, JSON.stringify(preferences), now)
                  .run()
            : await db
                  .prepare("UPDATE ai_preferences SET value = ?, version = version + 1, updated_at = ? WHERE email = ? AND version = ?")
                  .bind(JSON.stringify(preferences), now, user.email, version)
                  .run();
    if (!result.meta.changes) throw new HttpError(409, "conflict", "These preferences changed in another tab. Reload and try again.");
    return loadPreferences(db, user.email);
}

// --- Exclusions ------------------------------------------------------------------------------------

/** Spaces and objects left out of AI processing. Space editors decide, for everyone in the space. */
export async function setExclusion(db: D1Database, user: PortalUser, target: { spaceId: string; objectId?: string | null }, excluded: boolean) {
    let spaceId = target.spaceId;
    if (target.objectId) spaceId = (await requireObject(db, user, target.objectId, "editor")).space_id;
    else await requireSpace(db, user, spaceId, "editor");
    if (excluded)
        await db
            .prepare("INSERT OR IGNORE INTO ai_exclusions (id, space_id, object_id, excluded_by, created_at) VALUES (?, ?, ?, ?, ?)")
            .bind(newId("aix"), spaceId, target.objectId ?? null, user.email, nowIso())
            .run();
    else
        await db
            .prepare("DELETE FROM ai_exclusions WHERE space_id = ? AND COALESCE(object_id, '') = ?")
            .bind(spaceId, target.objectId ?? "")
            .run();
}

/** Of these objects, the ones excluded (directly or through their space). */
export async function excludedObjects(db: D1Database, objects: { id: string; spaceId: string }[]): Promise<Set<string>> {
    if (!objects.length) return new Set();
    const spaces = [...new Set(objects.map((o) => o.spaceId))];
    const rows = await db
        .prepare(`SELECT space_id, object_id FROM ai_exclusions WHERE space_id IN (${spaces.map(() => "?").join(", ")})`)
        .bind(...spaces)
        .all<{ space_id: string; object_id: string | null }>();
    const wholeSpaces = new Set(rows.results.filter((r) => !r.object_id).map((r) => r.space_id));
    const single = new Set(rows.results.filter((r) => r.object_id).map((r) => r.object_id));
    return new Set(objects.filter((o) => wholeSpaces.has(o.spaceId) || single.has(o.id)).map((o) => o.id));
}

export async function excludedSpaces(db: D1Database): Promise<Set<string>> {
    const rows = await db.prepare("SELECT space_id FROM ai_exclusions WHERE object_id IS NULL").all<{ space_id: string }>();
    return new Set(rows.results.map((r) => r.space_id));
}

// --- Status ----------------------------------------------------------------------------------------

export function availability(env: Env, config: IntelligenceConfig): IntelligenceStatus["available"] {
    const on = config.features.enabled && !!aiBinding(env);
    return {
        semantic: on && config.features.semanticSearch && !!vectorIndex(env),
        capture: on && config.features.capture,
        documents: on && config.features.documents && !!aiBinding(env)?.toMarkdown,
        meetings: on && config.features.meetings,
        recommendations: on && config.features.briefingRecommendations,
        scheduled: on && config.features.scheduled,
    };
}

export const statusFor = (env: Env, config: IntelligenceConfig, circuitOpen: boolean, index: IntelligenceStatus["index"]): IntelligenceStatus => ({
    features: config.features,
    bindings: { ai: !!aiBinding(env), vectors: !!vectorIndex(env), gateway: !!env.AI_GATEWAY_ID },
    available: availability(env, config),
    circuitOpen,
    index,
});
