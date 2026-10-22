// First-render data for the Intelligence pages (/portal/intelligence/*). The portal page router has
// already checked "intelligence.use".
import type { IntelligenceRoute } from "../../src/shared/intelligence/types";
import type { PortalUser } from "../../src/shared/portal/types";
import type { Env } from "../env";
import { getBriefing } from "./briefings";
import { intelligenceShell, loadConfig, loadPreferences } from "./settings";
import { usageSummary } from "./usage";

export type IntelligencePage = "home" | "briefing" | "weekly" | "settings";

export async function loadIntelligencePage(env: Env, user: PortalUser, page: IntelligencePage): Promise<IntelligenceRoute> {
    const site = new URL(env.SITE_URL).origin;
    const shell = await intelligenceShell(env, user);
    switch (page) {
        case "home": {
            const { config } = await loadConfig(env.DB);
            const [briefing, usage] = await Promise.all([getBriefing(env, user, "daily", { site }), usageSummary(env.DB, config, user.email)]);
            return { route: "intelligence-home", ...shell, briefing, usage };
        }
        case "briefing":
        case "weekly": {
            const kind = page === "weekly" ? "weekly" : "daily";
            return { route: "intelligence-briefing", ...shell, kind, briefing: await getBriefing(env, user, kind, { site }) };
        }
        case "settings": {
            const [{ config, version }, prefs] = await Promise.all([loadConfig(env.DB), loadPreferences(env.DB, user.email)]);
            return {
                route: "intelligence-settings",
                ...shell,
                config,
                configVersion: version,
                preferences: prefs.preferences,
                preferencesVersion: prefs.version,
                usage: await usageSummary(env.DB, config, user.email),
            };
        }
    }
}
