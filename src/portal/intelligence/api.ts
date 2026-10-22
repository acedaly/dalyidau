// Browser client for /api/portal/intelligence.
import { api } from "@/portal/lib/api";
import type { IntelligenceConfig, IntelligencePreferences } from "@/shared/intelligence/config";
import type { BriefingView } from "@/shared/intelligence/types";

const BASE = "/api/portal/intelligence";

export const intelligenceApi = {
    recommend: (kind: "daily" | "weekly") => api<{ briefing: BriefingView }>("POST", `${BASE}/briefings/${kind}/recommend`, {}),
    saveSettings: (version: number, config: IntelligenceConfig) =>
        api<{ config: IntelligenceConfig; version: number }>("PUT", `${BASE}/settings`, { version, config }),
    savePreferences: (version: number, preferences: IntelligencePreferences) =>
        api<{ preferences: IntelligencePreferences; version: number }>("PUT", `${BASE}/preferences`, { version, preferences }),
};
