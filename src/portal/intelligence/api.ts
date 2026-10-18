// Browser client for /api/portal/intelligence. Uploads go in parts (base64 in JSON, like the rest
// of the portal API) so a phone on a slow connection shows real progress and a failed part can be
// retried without starting again.
import { api } from "@/portal/lib/api";
import type { IntelligenceConfig, IntelligencePreferences } from "@/shared/intelligence/config";
import type { BriefingView, CaptureDetail, CaptureSummary, HybridSearchResult, IntelligenceStatus, JobView, SuggestionView } from "@/shared/intelligence/types";

const BASE = "/api/portal/intelligence";

export const intelligenceApi = {
    status: () => api<{ status: IntelligenceStatus }>("GET", `${BASE}/status`),
    capture: (body: Record<string, unknown>) =>
        api<{ captureId: string; jobId: string; replayed: boolean; needsApproval: boolean }>("POST", `${BASE}/captures`, body),
    captures: (source?: "audio" | "other") => api<{ captures: CaptureSummary[] }>("GET", `${BASE}/captures${source ? `?source=${source}` : ""}`),
    getCapture: (id: string) => api<{ capture: CaptureDetail }>("GET", `${BASE}/captures/${id}`),
    cancelCapture: (id: string) => api("POST", `${BASE}/captures/${id}/cancel`, {}),
    suggestions: (filter = "pending") => api<{ suggestions: SuggestionView[] }>("GET", `${BASE}/suggestions?filter=${filter}`),
    edit: (id: string, version: number, payload: unknown) => api<{ suggestion: SuggestionView }>("PATCH", `${BASE}/suggestions/${id}`, { version, payload }),
    approve: (id: string, version?: number) => api<{ suggestion: SuggestionView }>("POST", `${BASE}/suggestions/${id}/approve`, version ? { version } : {}),
    approveMany: (ids: string[]) =>
        api<{ approved: number; results: { id: string; ok: boolean; error?: { code: string; message: string } }[] }>("POST", `${BASE}/suggestions/approve`, {
            ids,
        }),
    dismiss: (id: string) => api("POST", `${BASE}/suggestions/${id}/dismiss`, {}),
    job: (id: string) => api<{ job: JobView }>("GET", `${BASE}/jobs/${id}`),
    runJob: (id: string) => api<{ job: JobView }>("POST", `${BASE}/jobs/${id}/run`, {}),
    retryJob: (id: string) => api<{ job: JobView }>("POST", `${BASE}/jobs/${id}/retry`, {}),
    approveJob: (id: string) => api<{ job: JobView }>("POST", `${BASE}/jobs/${id}/approve`, {}),
    cancelJob: (id: string) => api<{ job: JobView }>("POST", `${BASE}/jobs/${id}/cancel`, {}),
    briefing: (kind: "daily" | "weekly") => api<{ briefing: BriefingView }>("GET", `${BASE}/briefings/${kind}`),
    recommend: (kind: "daily" | "weekly") => api<{ briefing: BriefingView }>("POST", `${BASE}/briefings/${kind}/recommend`, {}),
    search: (q: string, params: Record<string, string> = {}) => api<HybridSearchResult>("GET", `${BASE}/search?${new URLSearchParams({ q, ...params })}`),
    saveSettings: (version: number, config: IntelligenceConfig) =>
        api<{ config: IntelligenceConfig; version: number }>("PUT", `${BASE}/settings`, { version, config }),
    savePreferences: (version: number, preferences: IntelligencePreferences) =>
        api<{ preferences: IntelligencePreferences; version: number }>("PUT", `${BASE}/preferences`, { version, preferences }),
    exclude: (spaceId: string, excluded: boolean, objectId?: string) => api("POST", `${BASE}/exclusions`, { spaceId, objectId: objectId ?? null, excluded }),
    syncIndex: () => api<{ report: { embedded: number; removed: number; failed: number; stoppedFor: string | null } }>("POST", `${BASE}/semantic/sync`, {}),
    reindex: (spaceId: string) => api("POST", `${BASE}/semantic/reindex`, { spaceId }),
    keepFile: (id: string, target: { objectId?: string; taskId?: string }) => api("POST", `${BASE}/attachments/${id}/keep`, target),
    deleteFile: (id: string, confirm?: string) => api("POST", `${BASE}/attachments/${id}/delete`, confirm ? { confirm } : {}),
};

const toBase64 = async (blob: Blob) => {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
};

/** Uploads a file in parts, reporting progress from 0 to 100. Resolves with the attachment id. */
export async function uploadFile(file: File, kind: "audio" | "document", onProgress: (percent: number) => void): Promise<string> {
    const started = await api<{ id: string; partBytes: number; parts: number }>("POST", `${BASE}/attachments`, { filename: file.name, bytes: file.size, kind });
    onProgress(2);
    for (let n = 1; n <= started.parts; n++) {
        const piece = file.slice((n - 1) * started.partBytes, n * started.partBytes);
        const data = await toBase64(piece);
        // One retry per part: a dropped connection on a phone shouldn't lose the whole upload.
        try {
            await api("POST", `${BASE}/attachments/${started.id}/parts/${n}`, { data });
        } catch {
            await api("POST", `${BASE}/attachments/${started.id}/parts/${n}`, { data });
        }
        onProgress(Math.round((n / started.parts) * 95));
    }
    await api("POST", `${BASE}/attachments/${started.id}/complete`, {});
    onProgress(100);
    return started.id;
}

export const downloadUrl = (id: string) => `${BASE}/attachments/${id}/download`;
