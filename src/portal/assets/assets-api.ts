// Calls to /api/portal/assets (docs/HOME_ASSETS.md#api). Calendar is reached through Home & Assets'
// own routes, which call Calendar's functions with its checks.
import { api } from "@/portal/lib/api";
import type { AssetCategory } from "@/shared/assets/categories";
import type {
    AssetDetail,
    AssetFileView,
    AssetNotificationView,
    AssetPreferences,
    AssetSearchResults,
    AssetShareView,
    AssetSummary,
    AssetsOverview,
    ClaimView,
    Grant,
    HouseholdTemplate,
    LocationView,
    MaintenanceView,
    OdometerReading,
    PhotoProposal,
    PolicyProposal,
    PolicyView,
    ReceiptProposal,
    ScheduleView,
    ValuationView,
    WarrantyView,
} from "@/shared/assets/types";

const A = "/api/portal/assets";

export interface UploadBody {
    data: string;
    filename: string;
    kind: AssetFileView["kind"];
    photoTag?: AssetFileView["photoTag"];
    caption?: string | null;
    thumb?: string;
    assetId?: string;
    locationId?: string;
    policyId?: string;
    maintenanceId?: string;
    warrantyId?: string;
    claimId?: string;
}

export const assetsApi = {
    overview: () => api<{ overview: AssetsOverview }>("GET", `${A}/overview`),
    preferences: () => api<{ preferences: AssetPreferences; version: number }>("GET", `${A}/preferences`),
    savePreferences: (preferences: AssetPreferences, version: number) =>
        api<{ preferences: AssetPreferences; version: number }>("PUT", `${A}/preferences`, { preferences, version }),
    people: () => api<{ people: { email: string; name: string | null }[] }>("GET", `${A}/people`),
    notifications: () => api<{ notifications: AssetNotificationView[] }>("GET", `${A}/notifications`),
    dismiss: (id: string) => api<{ notifications: AssetNotificationView[] }>("POST", `${A}/notifications/${id}/dismiss`, {}),
    categories: () => api<{ categories: AssetCategory[] }>("GET", `${A}/categories`),
    createCategory: (body: { name: string; fields?: AssetCategory["fields"] }) => api<{ category: AssetCategory }>("POST", `${A}/categories`, body),
    updateCategory: (id: string, body: { name?: string; fields?: AssetCategory["fields"]; archived?: boolean }) =>
        api<{ category: AssetCategory }>("PATCH", `${A}/categories/${id}`, body),
    search: (q: string) => api<{ results: AssetSearchResults }>("GET", `${A}/search?q=${encodeURIComponent(q)}`),

    list: () => api<{ assets: AssetSummary[]; truncated: boolean }>("GET", `${A}/items`),
    create: (body: Record<string, unknown>) => api<{ asset: AssetSummary; replayed: boolean }>("POST", `${A}/items`, body),
    detail: (id: string) => api<{ detail: AssetDetail }>("GET", `${A}/items/${id}`),
    update: (id: string, body: Record<string, unknown>) => api<{ asset: AssetSummary }>("PATCH", `${A}/items/${id}`, body),
    remove: (id: string) => api<{ ok: true }>("DELETE", `${A}/items/${id}`, { confirm: "DELETE" }),
    restore: (id: string) => api<{ asset: AssetSummary }>("POST", `${A}/items/${id}/restore`, {}),
    deleted: () => api<{ assets: { id: string; name: string; deletedAt: string }[] }>("GET", `${A}/items/deleted`),
    bulk: (ids: string[], set: Record<string, unknown>) => api<{ changed: number; skipped: number }>("POST", `${A}/items/bulk`, { ids, set }),
    share: (id: string, body: { visibility: string; household?: Grant; people?: (Grant & { email: string })[]; version: number }) =>
        api<{ sharing: { visibility: string; household: Grant | null; people: AssetShareView[] } }>("PUT", `${A}/items/${id}/sharing`, body),
    move: (id: string, locationId: string | null) => api<{ asset: AssetSummary }>("PUT", `${A}/items/${id}/location`, { locationId }),
    cover: (id: string, fileId: string) => api<{ asset: AssetSummary }>("PUT", `${A}/items/${id}/cover`, { fileId }),
    label: (id: string) => api<{ labelVersion: number }>("POST", `${A}/items/${id}/label`, {}),
    problem: (id: string, body: { title: string; description?: string | null; priority?: string }) =>
        api<{ record: MaintenanceView }>("POST", `${A}/items/${id}/problem`, body),
    odometer: (id: string, body: { reading: number; readOn: string; correction?: boolean; note?: string | null }) =>
        api<{ odometer: OdometerReading[] }>("POST", `${A}/items/${id}/odometer`, body),
    deleteOdometer: (id: string, reading: string) => api<{ odometer: OdometerReading[] }>("DELETE", `${A}/items/${id}/odometer/${reading}`),
    addValuation: (id: string, body: { kind: string; basis: string; amountCents: number; valuedOn: string; source?: string | null }) =>
        api<{ valuations: ValuationView[] }>("POST", `${A}/items/${id}/valuations`, body),
    deleteValuation: (id: string, valuation: string) => api<{ valuations: ValuationView[] }>("DELETE", `${A}/items/${id}/valuations/${valuation}`),
    addWarranty: (id: string, body: Record<string, unknown>) => api<{ warranties: WarrantyView[] }>("POST", `${A}/items/${id}/warranties`, body),
    updateWarranty: (id: string, body: Record<string, unknown>) => api<{ warranties: WarrantyView[] }>("PATCH", `${A}/warranties/${id}`, body),
    deleteWarranty: (id: string) => api<{ warranties: WarrantyView[] }>("DELETE", `${A}/warranties/${id}`),

    claims: () => api<{ claims: ClaimView[] }>("GET", `${A}/claims`),
    createClaim: (body: Record<string, unknown>) => api<{ claim: ClaimView }>("POST", `${A}/claims`, body),
    updateClaim: (id: string, body: Record<string, unknown>) => api<{ claim: ClaimView }>("PATCH", `${A}/claims/${id}`, body),

    locations: (archived = false) => api<{ locations: LocationView[] }>("GET", `${A}/locations${archived ? "?archived=1" : ""}`),
    createLocation: (body: Record<string, unknown>) => api<{ location: LocationView }>("POST", `${A}/locations`, body),
    updateLocation: (id: string, body: Record<string, unknown>) => api<{ location: LocationView }>("PATCH", `${A}/locations/${id}`, body),

    maintenance: (scope: "open" | "history" | "all" = "open") => api<{ maintenance: MaintenanceView[] }>("GET", `${A}/maintenance?scope=${scope}`),
    createMaintenance: (body: Record<string, unknown>) => api<{ record: MaintenanceView; replayed: boolean }>("POST", `${A}/maintenance`, body),
    updateMaintenance: (id: string, body: Record<string, unknown>) => api<{ record: MaintenanceView }>("PATCH", `${A}/maintenance/${id}`, body),
    complete: (id: string, body: Record<string, unknown>) =>
        api<{ record: MaintenanceView; next: MaintenanceView | null; alreadyDone: boolean }>("POST", `${A}/maintenance/${id}/complete`, body),
    cancel: (id: string) => api<{ record: MaintenanceView }>("POST", `${A}/maintenance/${id}/cancel`, {}),
    appointment: (id: string, body: { calendarId?: string; durationMinutes?: number; visibility?: "default" | "private" } = {}) =>
        api<{ eventId: string; existing: boolean }>("POST", `${A}/maintenance/${id}/appointment`, body),
    schedules: () => api<{ schedules: ScheduleView[] }>("GET", `${A}/schedules`),
    createSchedule: (body: Record<string, unknown>) => api<{ schedule: ScheduleView }>("POST", `${A}/schedules`, body),
    updateSchedule: (id: string, body: Record<string, unknown>) => api<{ schedule: ScheduleView }>("PATCH", `${A}/schedules/${id}`, body),
    deleteSchedule: (id: string) => api<{ ok: true }>("DELETE", `${A}/schedules/${id}`),
    createTemplate: (body: Record<string, unknown>) => api<{ household: HouseholdTemplate[] }>("POST", `${A}/templates`, body),
    deleteTemplate: (id: string) => api<{ household: HouseholdTemplate[] }>("DELETE", `${A}/templates/${id}`),

    policies: () => api<{ policies: PolicyView[] }>("GET", `${A}/policies`),
    policy: (id: string) => api<{ policy: PolicyView; files: AssetFileView[] }>("GET", `${A}/policies/${id}`),
    createPolicy: (body: Record<string, unknown>) => api<{ policy: PolicyView }>("POST", `${A}/policies`, body),
    updatePolicy: (id: string, body: Record<string, unknown>) => api<{ policy: PolicyView }>("PATCH", `${A}/policies/${id}`, body),
    deletePolicy: (id: string) => api<{ ok: true }>("DELETE", `${A}/policies/${id}`, { confirm: "DELETE" }),
    verifyPolicy: (id: string, version: number) => api<{ policy: PolicyView }>("POST", `${A}/policies/${id}/verify`, { version }),
    renewPolicy: (id: string, body: Record<string, unknown>) => api<{ policy: PolicyView }>("POST", `${A}/policies/${id}/renew`, body),
    linkPolicy: (id: string, body: { assetId: string; agreedValueCents?: number | null }) =>
        api<{ policy: PolicyView }>("POST", `${A}/policies/${id}/assets`, body),
    unlinkPolicy: (id: string, assetId: string) => api<{ policy: PolicyView }>("DELETE", `${A}/policies/${id}/assets/${assetId}`),
    extractPolicy: (id: string, fileId: string) => api<{ proposal: PolicyProposal }>("POST", `${A}/policies/${id}/extract`, { fileId }),

    files: () => api<{ files: AssetFileView[]; inbox: AssetFileView[]; retentionDue: AssetFileView[] }>("GET", `${A}/files`),
    upload: (body: UploadBody) => api<{ file: AssetFileView; duplicate: boolean; alsoOn: { assetId: string; name: string }[] }>("POST", `${A}/files`, body),
    updateFile: (id: string, body: Record<string, unknown>) => api<{ file: AssetFileView }>("PATCH", `${A}/files/${id}`, body),
    deleteFile: (id: string) => api<{ ok: true }>("DELETE", `${A}/files/${id}`),

    captureStatus: () => api<{ available: boolean; reason: string | null }>("GET", `${A}/capture/status`),
    receipt: (fileId: string) => api<{ proposal: ReceiptProposal }>("POST", `${A}/capture/receipt`, { fileId }),
    photo: (fileId: string) => api<{ proposal: PhotoProposal }>("POST", `${A}/capture/photo`, { fileId }),
};

export const fileUrl = (id: string, thumb = false) => `${A}/files/${id}/${thumb ? "thumb" : "content"}`;
export const qrUrl = (id: string) => `${A}/items/${id}/qr.svg`;
export const reportUrl = (name: string, params: Record<string, string> = {}) => {
    const q = new URLSearchParams(params).toString();
    return `${A}/reports/${name}.csv${q ? `?${q}` : ""}`;
};
