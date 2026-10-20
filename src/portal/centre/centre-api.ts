// Calls to /api/portal/centre (docs/INTELLIGENCE_CENTRE.md#api). Tasks and Knowledge are written
// through the Centre's own routes, which call those applications' functions with their checks.
import { api } from "@/portal/lib/api";
import type { AssistantAnswer } from "@/shared/centre/assistant";
import type {
    CentreAnalytics,
    FeedChange,
    RecordTimeline,
    ReplayComparison,
    ReplayFrame,
    ReplayMeta,
    SituationTimeline,
    SourceReliability,
} from "@/shared/centre/history";
import type { ReportRequest, ReportSchedule, ReportSummary, ScheduleInput, SituationReport } from "@/shared/centre/reports";
import type { MonitoringRule, RuleInput, RuleMatch, RuleTestResult } from "@/shared/centre/rules";
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
    saveToKnowledge: (id: string, body: KnowledgeTarget = {}) => api<KnowledgeSaved>("POST", `${C}/records/${id}/knowledge`, body),
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

    // --- 9.1: history -------------------------------------------------------------------------------
    feed: (params: Record<string, string | number | boolean | null | undefined>) =>
        api<{ changes: FeedChange[]; truncated: boolean; counts: { significant: number; routine: number } }>("GET", `${C}/feed${query(params)}`),
    recordTimeline: (id: string) => api<{ timeline: RecordTimeline }>("GET", `${C}/records/${id}/timeline`),
    timelineToKnowledge: (id: string, body: KnowledgeTarget = {}) => api<KnowledgeSaved>("POST", `${C}/records/${id}/timeline/knowledge`, body),
    situationTimeline: (params: { watch?: string | null; region?: string | null; hours?: number }) =>
        api<{ timeline: SituationTimeline }>("GET", `${C}/timeline${query(params)}`),
    replay: (params: { at: string; watch?: string | null; region?: string | null; layers?: string; includeInactive?: boolean }) =>
        api<{ frame: ReplayFrame }>("GET", `${C}/replay${query(params)}`),
    replayMeta: (from: string, to: string) => api<{ meta: ReplayMeta }>("GET", `${C}/replay/meta${query({ from, to })}`),
    replayCompare: (params: { a: string; b: string; watch?: string | null; region?: string | null; layers?: string }) =>
        api<{ comparison: ReplayComparison }>("GET", `${C}/replay/compare${query(params)}`),
    analytics: (days: number) => api<{ analytics: CentreAnalytics }>("GET", `${C}/analytics?days=${days}`),
    reliability: (days = 30) => api<{ reliability: SourceReliability[] }>("GET", `${C}/reliability?days=${days}`),

    // --- Monitoring rules ----------------------------------------------------------------------------
    rules: () => api<{ rules: MonitoringRule[]; matches: RuleMatch[] }>("GET", `${C}/rules`),
    createRule: (input: RuleInput) => api<{ rule: MonitoringRule }>("POST", `${C}/rules`, input),
    updateRule: (id: string, input: RuleInput & { version: number }) => api<{ rule: MonitoringRule }>("PUT", `${C}/rules/${id}`, input),
    deleteRule: (id: string) => api<{ ok: true }>("DELETE", `${C}/rules/${id}`),
    testRule: (input: RuleInput, days = 7) => api<{ result: RuleTestResult }>("POST", `${C}/rules/test?days=${days}`, input),
    matches: (params: { open?: boolean; rule?: string } = {}) => api<{ matches: RuleMatch[] }>("GET", `${C}/rules/matches${query(params)}`),
    acknowledgeMatches: (ids: string[] | "all") => api<{ ok: true }>("POST", `${C}/rules/matches/acknowledge`, { ids }),
    taskFromMatch: (id: string, body: { dueDate?: string; projectId?: string } = {}) =>
        api<{ taskId: string; url: string; replayed: boolean }>("POST", `${C}/rules/matches/${id}/task`, body),

    // --- Reports ---------------------------------------------------------------------------------------
    reports: () => api<{ reports: ReportSummary[]; schedules: ReportSchedule[] }>("GET", `${C}/reports`),
    previewReport: (request: Partial<ReportRequest> & Pick<ReportRequest, "scope">) =>
        api<{ report: SituationReport }>("POST", `${C}/reports/preview`, request),
    generateReport: (request: Partial<ReportRequest> & Pick<ReportRequest, "scope">) =>
        api<{ report: SituationReport; summary: ReportSummary }>("POST", `${C}/reports`, request),
    report: (id: string) => api<{ report: SituationReport; summary: ReportSummary }>("GET", `${C}/reports/${id}`),
    deleteReport: (id: string) => api<{ ok: true }>("DELETE", `${C}/reports/${id}`),
    reportToKnowledge: (id: string, body: KnowledgeTarget = {}) => api<KnowledgeSaved>("POST", `${C}/reports/${id}/knowledge`, body),
    schedules: () => api<{ schedules: ReportSchedule[] }>("GET", `${C}/schedules`),
    createSchedule: (input: ScheduleInput) => api<{ schedule: ReportSchedule }>("POST", `${C}/schedules`, input),
    updateSchedule: (id: string, input: ScheduleInput & { version: number }) => api<{ schedule: ReportSchedule }>("PUT", `${C}/schedules/${id}`, input),
    deleteSchedule: (id: string) => api<{ ok: true }>("DELETE", `${C}/schedules/${id}`),

    // --- Assistant and journeys -------------------------------------------------------------------------
    ask: (body: { question: string; watchId?: string | null; recordId?: string | null }) => api<{ answer: AssistantAnswer }>("POST", `${C}/assistant`, body),
    eventLinks: () => api<{ links: EventLinkView[] }>("GET", `${C}/events/links`),
    linkEvent: (eventId: string, watchId: string) => api<{ links: EventLinkView[] }>("POST", `${C}/events/links`, { eventId, watchId }),
    unlinkEvent: (id: string) => api<{ ok: true }>("DELETE", `${C}/events/links/${id}`),
};

/** Where a saved Knowledge note goes: a space (default: personal), and optionally an existing note to link it to as evidence. */
export interface KnowledgeTarget {
    spaceId?: string;
    relateTo?: string;
}

export interface KnowledgeSaved {
    objectId: string;
    url: string;
    linked?: boolean;
}

export interface EventLinkView {
    id: string;
    eventId: string;
    watchId: string;
    watchName: string;
    title: string | null;
    start: string | null;
}
