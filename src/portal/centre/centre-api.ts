// Calls to /api/portal/centre (docs/INTELLIGENCE_CENTRE.md#api). Tasks and Knowledge are written
// through the Centre's own routes, which call those applications' functions with their checks.
import { api } from "@/portal/lib/api";
import type {
    CentreAlert,
    CentreBriefing,
    CentrePreferences,
    CentreRecord,
    CentreSettings,
    CentreSummary,
    Correlation,
    FetchRun,
    SourceHealth,
    Wallboard,
    WallboardInput,
    WatchArea,
    WatchInput,
} from "@/shared/centre/types";

const C = "/api/portal/centre";

export interface MapFeatureCollection {
    type: "FeatureCollection";
    features: {
        type: "Feature";
        id: string;
        geometry: { type: string; coordinates: unknown };
        properties: {
            id: string;
            layer: string;
            kind: string;
            title: string;
            level: string | null;
            rank: number;
            area: 0 | 1;
            nature: "official" | "observed";
            at: string | null;
        };
    }[];
    truncated?: boolean;
}

const query = (params: Record<string, string | number | boolean | null | undefined>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== "" && v !== false) q.set(k, v === true ? "1" : String(v));
    const s = q.toString();
    return s ? `?${s}` : "";
};

export const centreApi = {
    summary: () => api<{ summary: CentreSummary }>("GET", `${C}/summary`),
    records: (params: Record<string, string | number | boolean | null | undefined>) =>
        api<{ records: CentreRecord[]; reasons: Record<string, string>; truncated: boolean }>("GET", `${C}/records${query(params)}`),
    map: (params: Record<string, string | number | boolean | null | undefined>) => api<MapFeatureCollection>("GET", `${C}/map${query(params)}`),
    record: (id: string) => api<{ record: CentreRecord; geometry: unknown }>("GET", `${C}/records/${id}`),
    createTask: (id: string, body: { projectId?: string; dueDate?: string | null; title?: string; clientId?: string }) =>
        api<{ taskId: string; url: string; replayed: boolean }>("POST", `${C}/records/${id}/task`, body),
    saveToKnowledge: (id: string, body: { spaceId?: string } = {}) => api<{ objectId: string; url: string }>("POST", `${C}/records/${id}/knowledge`, body),
    correlations: () => api<{ correlations: Correlation[] }>("GET", `${C}/correlations`),
    sources: () => api<{ sources: SourceHealth[]; runs: FetchRun[] }>("GET", `${C}/sources`),
    setSource: (id: string, enabled: boolean) => api<{ sources: SourceHealth[] }>("PUT", `${C}/sources/${id}`, { enabled }),
    refreshSource: (id: string) =>
        api<{ result: { outcome: string; records: number; message?: string }; sources: SourceHealth[] }>("POST", `${C}/sources/${id}/refresh`, {}),
    watches: () => api<{ watches: WatchArea[] }>("GET", `${C}/watches`),
    createWatch: (input: WatchInput) => api<{ watch: WatchArea }>("POST", `${C}/watches`, input),
    updateWatch: (id: string, input: WatchInput & { version: number }) => api<{ watch: WatchArea }>("PUT", `${C}/watches/${id}`, input),
    deleteWatch: (id: string) => api<{ ok: true }>("DELETE", `${C}/watches/${id}`),
    alerts: (open = false) => api<{ alerts: CentreAlert[] }>("GET", `${C}/alerts${open ? "?open=1" : ""}`),
    acknowledge: (ids: string[] | "all") => api<{ ok: true }>("POST", `${C}/alerts/acknowledge`, { ids }),
    briefing: (scope: "nsw" | "watch" | "morning", watch?: string | null) =>
        api<{ briefing: CentreBriefing }>("GET", `${C}/briefing${query({ scope, watch })}`),
    interpret: (scope: "nsw" | "watch" | "morning", watch?: string | null) =>
        api<{ briefing: CentreBriefing }>("POST", `${C}/briefing/interpret`, { scope, watch: watch ?? null }),
    briefingToKnowledge: (scope: "nsw" | "watch" | "morning", watch?: string | null) =>
        api<{ objectId: string; url: string }>("POST", `${C}/briefing/knowledge`, { scope, watch: watch ?? null }),
    savePreferences: (preferences: CentrePreferences, version: number) =>
        api<{ preferences: CentrePreferences; version: number }>("PUT", `${C}/preferences`, { preferences, version }),
    saveSettings: (settings: CentreSettings, version: number) =>
        api<{ settings: CentreSettings; version: number }>("PUT", `${C}/settings`, { settings, version }),
    wallboards: () => api<{ wallboards: Wallboard[] }>("GET", `${C}/wallboards`),
    createWallboard: (input: WallboardInput) => api<{ wallboard: Wallboard }>("POST", `${C}/wallboards`, input),
    updateWallboard: (id: string, input: WallboardInput & { version: number }) => api<{ wallboard: Wallboard }>("PUT", `${C}/wallboards/${id}`, input),
    deleteWallboard: (id: string) => api<{ ok: true }>("DELETE", `${C}/wallboards/${id}`),
    createDisplay: (id: string, body: { label: string; expiresInDays?: number | null }) =>
        api<{ id: string; token: string; path: string; expiresAt: string | null }>("POST", `${C}/wallboards/${id}/displays`, body),
    revokeDisplay: (id: string, tokenId: string) => api<{ ok: true }>("DELETE", `${C}/wallboards/${id}/displays/${tokenId}`),
};
