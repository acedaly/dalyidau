// First-render data for the Intelligence pages (/portal/intelligence/*). The portal page router has
// already checked "intelligence.use". Anything the caller can't see returns null (the 404 page).
import type { IntelligenceRoute } from "../../src/shared/intelligence/types";
import type { PortalUser } from "../../src/shared/portal/types";
import type { Env } from "../env";
import { listSpaces, requireObject } from "../knowledge/access";
import { can } from "../portal/auth";
import { HttpError } from "../portal/http";
import { storageSummary } from "./attachments";
import { getBriefing } from "./briefings";
import { loadConfig, loadPreferences } from "./settings";
import { type SuggestionFilter, listSuggestions } from "./suggestions";
import { usageSummary } from "./usage";
import { captureDetail, intelligenceShell, listCaptures } from "./views";

export type IntelligencePage = "home" | "inbox" | "capture" | "capture-detail" | "briefing" | "weekly" | "meetings" | "settings";

const hidden = async <T>(load: () => Promise<T>): Promise<T | null> => {
    try {
        return await load();
    } catch (error) {
        if (error instanceof HttpError && (error.status === 404 || error.status === 403)) return null;
        throw error;
    }
};

export async function loadIntelligencePage(env: Env, user: PortalUser, url: URL, page: IntelligencePage, id?: string): Promise<IntelligenceRoute | null> {
    const site = new URL(env.SITE_URL).origin;
    const shell = await intelligenceShell(env, user);
    const spaces = async () => (can(user, "knowledge.use") ? await listSpaces(env.DB, user.email) : []);
    switch (page) {
        case "home": {
            const { config } = await loadConfig(env.DB);
            const [briefing, suggestions, captures, usage] = await Promise.all([
                getBriefing(env, user, "daily", { site }),
                listSuggestions(env.DB, user, site, { filter: "pending", limit: 6 }),
                listCaptures(env.DB, user, { limit: 6 }),
                usageSummary(env.DB, config, user.email),
            ]);
            return { route: "intelligence-home", ...shell, briefing, suggestions, captures, usage };
        }
        case "inbox": {
            const requested = url.searchParams.get("filter");
            const filter: SuggestionFilter = requested === "applied" || requested === "dismissed" || requested === "all" ? requested : "pending";
            return { route: "intelligence-inbox", ...shell, filter, suggestions: await listSuggestions(env.DB, user, site, { filter, limit: 200 }) };
        }
        case "capture": {
            const { config } = await loadConfig(env.DB);
            const objectId = url.searchParams.get("object");
            let prefillObject: { id: string; title: string } | null = null;
            if (objectId && /^kob_[a-z0-9]{14}$/.test(objectId) && can(user, "knowledge.use")) {
                const found = await hidden(async () => {
                    await requireObject(env.DB, user, objectId);
                    return env.DB.prepare("SELECT id, title FROM knowledge_objects WHERE id = ?").bind(objectId).first<{ id: string; title: string }>();
                });
                if (found) prefillObject = { id: found.id, title: found.title || "Untitled" };
            }
            return {
                route: "intelligence-capture",
                ...shell,
                captures: await listCaptures(env.DB, user, { source: "other", limit: 20 }),
                spaces: (await spaces()).filter((s) => s.role !== "viewer").map((s) => ({ id: s.id, name: s.name, kind: s.kind, role: s.role })),
                limits: config.limits,
                prefillObject,
            };
        }
        case "capture-detail": {
            const capture = await hidden(() => captureDetail(env, user, id!, site));
            return capture ? { route: "intelligence-capture-detail", ...shell, capture } : null;
        }
        case "briefing":
        case "weekly": {
            const kind = page === "weekly" ? "weekly" : "daily";
            return { route: "intelligence-briefing", ...shell, kind, briefing: await getBriefing(env, user, kind, { site }) };
        }
        case "meetings": {
            const { config } = await loadConfig(env.DB);
            return {
                route: "intelligence-meetings",
                ...shell,
                captures: await listCaptures(env.DB, user, { source: "audio", limit: 50 }),
                limits: config.limits,
                spaces: (await spaces()).filter((s) => s.role !== "viewer").map((s) => ({ id: s.id, name: s.name })),
            };
        }
        case "settings": {
            const [{ config, version }, prefs, storage] = await Promise.all([
                loadConfig(env.DB),
                loadPreferences(env.DB, user.email),
                storageSummary(env.DB, user),
            ]);
            const excluded = new Set(
                (await env.DB.prepare("SELECT space_id FROM ai_exclusions WHERE object_id IS NULL").all<{ space_id: string }>()).results.map((r) => r.space_id),
            );
            return {
                route: "intelligence-settings",
                ...shell,
                config,
                configVersion: version,
                preferences: prefs.preferences,
                preferencesVersion: prefs.version,
                usage: await usageSummary(env.DB, config, user.email),
                storage,
                spaces: (await spaces()).map((s) => ({ id: s.id, name: s.name, kind: s.kind, role: s.role, excluded: excluded.has(s.id) })),
            };
        }
    }
}
