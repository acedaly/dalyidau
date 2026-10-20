// Filtering and searching asset summaries, the same way in the browser (the All assets page) and
// on the Worker (MCP, reports, the URL a page opens with).
import type { AssetFilters, AssetSummary } from "./types";
import { GONE_STATUSES } from "./types";

export const EMPTY_FILTERS: AssetFilters = {
    q: "",
    category: null,
    group: null,
    locationId: null,
    owner: null,
    status: "current",
    condition: null,
    warranty: null,
    coverage: null,
    maintenance: null,
    visibility: null,
    minValue: null,
    maxValue: null,
    tag: null,
};

/** The words an asset can be found by. Identifiers are matched without spaces too ("ABC 123" finds "abc123"). */
export const searchText = (a: AssetSummary) =>
    [a.name, a.categoryLabel, a.manufacturer, a.brand, a.model, a.serialNumber, a.barcode, a.ownership, a.location?.name, a.vehicle?.registration, ...a.tags]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

const squash = (text: string) => text.toLowerCase().replace(/[\s-]+/g, "");

export function matchesQuery(a: AssetSummary, q: string): boolean {
    const needle = q.trim().toLowerCase();
    if (!needle) return true;
    const text = searchText(a);
    if (needle.split(/\s+/).every((word) => text.includes(word))) return true;
    const id = squash(needle);
    return [a.serialNumber, a.barcode, a.vehicle?.registration].some((v) => v && squash(v).includes(id));
}

/** The value a filter compares: the current value, or the purchase price, if known. */
const knownValue = (a: AssetSummary) => a.currentValue?.amountCents ?? a.purchasePriceCents ?? null;

export function applyFilters(assets: AssetSummary[], f: AssetFilters): AssetSummary[] {
    return assets.filter((a) => {
        if (!matchesQuery(a, f.q)) return false;
        if (f.category && a.category !== f.category) return false;
        if (f.group && a.group !== f.group) return false;
        if (f.locationId && a.location?.id !== f.locationId) return false;
        if (f.owner === "mine" && !a.mine) return false;
        if (f.owner === "shared" && a.mine) return false;
        if (f.status === "current" && GONE_STATUSES.includes(a.status)) return false;
        if (f.status === "gone" && !GONE_STATUSES.includes(a.status)) return false;
        if (f.status && f.status !== "current" && f.status !== "gone" && a.status !== f.status) return false;
        if (f.condition && a.condition !== f.condition) return false;
        if (f.warranty && a.warranty.state !== f.warranty) return false;
        if (f.coverage && a.coverage !== f.coverage) return false;
        if (f.maintenance === "overdue" && !a.maintenance.overdue) return false;
        if (f.maintenance === "due_soon" && !a.maintenance.dueSoon && !a.maintenance.overdue) return false;
        if (f.maintenance === "none" && (a.maintenance.overdue || a.maintenance.dueSoon || a.maintenance.open)) return false;
        if (f.visibility && a.visibility !== f.visibility) return false;
        if (f.tag && !a.tags.includes(f.tag)) return false;
        if (f.minValue !== null || f.maxValue !== null) {
            // Unknown or hidden values never match a value range.
            const v = knownValue(a);
            if (v === null) return false;
            if (f.minValue !== null && v < f.minValue) return false;
            if (f.maxValue !== null && v > f.maxValue) return false;
        }
        return true;
    });
}

const one = <T extends string>(value: string | null, allowed: readonly T[]): T | null =>
    value && (allowed as readonly string[]).includes(value) ? (value as T) : null;
const cents = (value: string | null) => {
    if (!value) return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
};

/** Filters from a page's address (?q=&category=&…). Unknown values are ignored. */
export function filtersFromQuery(params: URLSearchParams): AssetFilters {
    return {
        q: (params.get("q") ?? "").slice(0, 100),
        category: params.get("category")?.slice(0, 40) || null,
        group: one(params.get("group"), ["vehicles", "home", "equipment", "personal", "other"] as const),
        locationId: /^alo_[a-z0-9]{14}$/.test(params.get("location") ?? "") ? params.get("location") : null,
        owner: one(params.get("owner"), ["mine", "shared"] as const),
        status:
            params.get("status") === "all"
                ? null
                : (one(params.get("status"), [
                      "current",
                      "gone",
                      "active",
                      "in_storage",
                      "in_repair",
                      "lent",
                      "lost",
                      "stolen",
                      "sold",
                      "disposed",
                      "gifted",
                  ] as const) ?? "current"),
        condition: one(params.get("condition"), ["new", "excellent", "good", "fair", "poor", "not_working", "unknown"] as const),
        warranty: one(params.get("warranty"), ["active", "expiring", "expired", "unknown", "none"] as const),
        coverage: one(params.get("coverage"), ["verified", "unverified", "lapsed", "none", "hidden"] as const),
        maintenance: one(params.get("maintenance"), ["overdue", "due_soon", "none"] as const),
        visibility: one(params.get("visibility"), ["private", "selected", "household"] as const),
        minValue: cents(params.get("min")),
        maxValue: cents(params.get("max")),
        tag: params.get("tag")?.slice(0, 40).toLowerCase() || null,
    };
}

export function filtersToQuery(f: AssetFilters): string {
    const q = new URLSearchParams();
    if (f.q) q.set("q", f.q);
    if (f.category) q.set("category", f.category);
    if (f.group) q.set("group", f.group);
    if (f.locationId) q.set("location", f.locationId);
    if (f.owner) q.set("owner", f.owner);
    if (f.status !== "current") q.set("status", f.status ?? "all");
    if (f.condition) q.set("condition", f.condition);
    if (f.warranty) q.set("warranty", f.warranty);
    if (f.coverage) q.set("coverage", f.coverage);
    if (f.maintenance) q.set("maintenance", f.maintenance);
    if (f.visibility) q.set("visibility", f.visibility);
    if (f.minValue !== null) q.set("min", String(f.minValue / 100));
    if (f.maxValue !== null) q.set("max", String(f.maxValue / 100));
    if (f.tag) q.set("tag", f.tag);
    const s = q.toString();
    return s ? `?${s}` : "";
}

export const activeFilterCount = (f: AssetFilters) =>
    (Object.keys(EMPTY_FILTERS) as (keyof AssetFilters)[]).filter((k) => k !== "q" && f[k] !== EMPTY_FILTERS[k]).length;
