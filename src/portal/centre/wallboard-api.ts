// Calls for wallboard profiles, their views and their screens (docs/INTELLIGENCE_CENTRE_9_1.md#wallboard-20).
import { api } from "@/portal/lib/api";
import type { Wallboard, WallboardInput } from "@/shared/centre/types";
import type { ViewInput, WallboardPayloadV2 } from "@/shared/centre/wallboard";

const C = "/api/portal/centre/wallboards";

export const wallboardApi = {
    list: () => api<{ wallboards: Wallboard[] }>("GET", C),
    create: (input: WallboardInput & { views?: ViewInput[] }) => api<{ wallboard: Wallboard }>("POST", C, input),
    update: (id: string, input: WallboardInput & { version: number }) => api<{ wallboard: Wallboard }>("PUT", `${C}/${id}`, input),
    saveViews: (id: string, version: number, views: ViewInput[]) => api<{ wallboard: Wallboard }>("PUT", `${C}/${id}/views`, { version, views }),
    duplicate: (id: string, name?: string) => api<{ wallboard: Wallboard }>("POST", `${C}/${id}/duplicate`, name ? { name } : {}),
    remove: (id: string) => api<{ ok: true }>("DELETE", `${C}/${id}`),
    preview: (id: string) => api<{ wallboard: WallboardPayloadV2 }>("GET", `${C}/${id}/preview`),
    createDisplay: (id: string, body: { label: string; expiresInDays?: number | null; renewable?: boolean }) =>
        api<{ id: string; token: string; path: string; expiresAt: string | null }>("POST", `${C}/${id}/displays`, body),
    revokeDisplay: (id: string, tokenId: string) => api<{ ok: true }>("DELETE", `${C}/${id}/displays/${tokenId}`),
};

/** A board's own settings, as the update route takes them (no views, tokens or bookkeeping). */
export const boardInput = (b: Wallboard): WallboardInput => ({
    name: b.name,
    layout: b.layout,
    watchId: b.watchId,
    layers: b.layers,
    rotation: b.rotation,
    rotationSeconds: b.rotationSeconds,
    refreshSeconds: b.refreshSeconds,
    showInterpretation: b.showInterpretation,
    showWatchOutline: b.showWatchOutline,
    theme: b.theme,
    scale: b.scale,
    clock: b.clock,
    burnIn: b.burnIn,
    rotate: b.rotate,
});
