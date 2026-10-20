// All assets, and Vehicles & trailers: search, filters, a list or card view, and bulk changes. The
// filters are the same functions the Worker uses (src/shared/assets/filters.ts), so the address of a
// filtered view can be shared within the household and opens the same view.
import { useMemo, useState } from "react";
import { Download01, FilterLines, Grid01, List, Package, Plus, QrCode02, Truck01 } from "@untitledui/icons";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { NativeSelect } from "@/components/base/select/select-native";
import { DataTable } from "@/portal/components/data-table";
import { PortalDialog } from "@/portal/components/dialog";
import { Empty } from "@/portal/components/empty";
import { useToast } from "@/portal/components/toast";
import { errorMessage } from "@/portal/lib/api";
import type { PageData } from "@/portal/lib/page-types";
import { EMPTY_FILTERS, activeFilterCount, applyFilters, filtersToQuery, searchText } from "@/shared/assets/filters";
import {
    ASSET_STATUSES,
    ASSET_STATUS_LABELS,
    type AssetFilters,
    type AssetSummary,
    CONDITIONS,
    CONDITION_LABELS,
    COVERAGE_LABELS,
} from "@/shared/assets/types";
import { assetsApi, reportUrl } from "../assets-api";
import { AssetForm, categoryOptions } from "../forms";
import {
    ASSETS,
    AssetThumb,
    AssetsHeader,
    CoverageBadge,
    DueBadge,
    Money,
    StatusBadge,
    ValueLine,
    VisibilityBadge,
    WarrantyBadge,
    assetHref,
    shortDate,
} from "../shared";

const Filters = ({
    filters,
    onChange,
    data,
    vehicles,
}: {
    filters: AssetFilters;
    onChange: (f: AssetFilters) => void;
    data: PageData<"assets-list">;
    vehicles: boolean;
}) => {
    const set = (patch: Partial<AssetFilters>) => onChange({ ...filters, ...patch });
    const value = (cents: number | null) => (cents === null ? "" : String(cents / 100));
    const toCents = (text: string) => (text.trim() === "" || Number.isNaN(Number(text)) ? null : Math.round(Number(text) * 100));
    return (
        <div className="grid grid-cols-1 gap-3 border-t border-secondary px-4 py-4 sm:grid-cols-2 md:px-6 lg:grid-cols-4">
            {!vehicles && (
                <NativeSelect
                    size="sm"
                    label="Category"
                    value={filters.category ?? ""}
                    onChange={(e) => set({ category: e.target.value || null })}
                    options={[{ value: "", label: "Any" }, ...categoryOptions(data.categories)]}
                />
            )}
            <NativeSelect
                size="sm"
                label="Place"
                value={filters.locationId ?? ""}
                onChange={(e) => set({ locationId: e.target.value || null })}
                options={[{ value: "", label: "Anywhere" }, ...data.locations.map((l) => ({ value: l.id, label: l.name }))]}
            />
            <NativeSelect
                size="sm"
                label="Owner"
                value={filters.owner ?? ""}
                onChange={(e) => set({ owner: (e.target.value || null) as AssetFilters["owner"] })}
                options={[
                    { value: "", label: "Anyone" },
                    { value: "mine", label: "Mine" },
                    { value: "shared", label: "Shared with me" },
                ]}
            />
            <NativeSelect
                size="sm"
                label="Status"
                value={filters.status ?? "all"}
                onChange={(e) => set({ status: e.target.value === "all" ? null : (e.target.value as AssetFilters["status"]) })}
                options={[
                    { value: "current", label: "Still have it" },
                    { value: "gone", label: "Sold or disposed of" },
                    { value: "all", label: "Everything" },
                    ...ASSET_STATUSES.map((s) => ({ value: s, label: ASSET_STATUS_LABELS[s] })),
                ]}
            />
            <NativeSelect
                size="sm"
                label="Warranty"
                value={filters.warranty ?? ""}
                onChange={(e) => set({ warranty: (e.target.value || null) as AssetFilters["warranty"] })}
                options={[
                    { value: "", label: "Any" },
                    { value: "active", label: "Under warranty" },
                    { value: "expiring", label: "Ending soon" },
                    { value: "expired", label: "Ended" },
                    { value: "unknown", label: "End not known" },
                    { value: "none", label: "None recorded" },
                ]}
            />
            <NativeSelect
                size="sm"
                label="Insurance"
                value={filters.coverage ?? ""}
                onChange={(e) => set({ coverage: (e.target.value || null) as AssetFilters["coverage"] })}
                options={[
                    { value: "", label: "Any" },
                    ...(["verified", "unverified", "lapsed", "none", "hidden"] as const).map((c) => ({ value: c, label: COVERAGE_LABELS[c] })),
                ]}
            />
            <NativeSelect
                size="sm"
                label="Maintenance"
                value={filters.maintenance ?? ""}
                onChange={(e) => set({ maintenance: (e.target.value || null) as AssetFilters["maintenance"] })}
                options={[
                    { value: "", label: "Any" },
                    { value: "overdue", label: "Overdue" },
                    { value: "due_soon", label: "Due soon or overdue" },
                    { value: "none", label: "Nothing due" },
                ]}
            />
            <NativeSelect
                size="sm"
                label="Condition"
                value={filters.condition ?? ""}
                onChange={(e) => set({ condition: (e.target.value || null) as AssetFilters["condition"] })}
                options={[{ value: "", label: "Any" }, ...CONDITIONS.map((c) => ({ value: c, label: CONDITION_LABELS[c] }))]}
            />
            <NativeSelect
                size="sm"
                label="Sharing"
                value={filters.visibility ?? ""}
                onChange={(e) => set({ visibility: (e.target.value || null) as AssetFilters["visibility"] })}
                options={[
                    { value: "", label: "Any" },
                    { value: "private", label: "Private" },
                    { value: "selected", label: "Shared with some" },
                    { value: "household", label: "Household" },
                ]}
            />
            <Input size="sm" label="Value from ($)" value={value(filters.minValue)} onChange={(v) => set({ minValue: toCents(v) })} inputMode="decimal" />
            <Input
                size="sm"
                label="Value to ($)"
                value={value(filters.maxValue)}
                onChange={(v) => set({ maxValue: toCents(v) })}
                inputMode="decimal"
                hint="Assets without a value don't match a range"
            />
            <Input size="sm" label="Tag" value={filters.tag ?? ""} onChange={(v) => set({ tag: v.trim().toLowerCase() || null })} />
        </div>
    );
};

const BulkDialog = ({ ids, data, onDone, onClose }: { ids: string[]; data: PageData<"assets-list">; onDone: () => void; onClose: () => void }) => {
    const toast = useToast();
    const [field, setField] = useState("addTags");
    const [value, setValue] = useState("");
    const [busy, setBusy] = useState(false);
    const apply = async () => {
        setBusy(true);
        try {
            const set: Record<string, unknown> =
                field === "addTags" || field === "removeTags"
                    ? {
                          [field]: value
                              .split(",")
                              .map((t) => t.trim().toLowerCase())
                              .filter(Boolean),
                      }
                    : { [field]: value || null };
            const result = await assetsApi.bulk(ids, set);
            toast.success(`${result.changed} changed`, result.skipped ? `${result.skipped} skipped: you can't edit them.` : undefined);
            onDone();
        } catch (e) {
            toast.error("Couldn't change them", errorMessage(e));
        } finally {
            setBusy(false);
        }
    };
    const choices: Record<string, { label: string; value: string }[] | null> = {
        addTags: null,
        removeTags: null,
        category: categoryOptions(data.categories),
        status: ASSET_STATUSES.map((s) => ({ value: s, label: ASSET_STATUS_LABELS[s] })),
        condition: CONDITIONS.map((c) => ({ value: c, label: CONDITION_LABELS[c] })),
        locationId: [{ value: "", label: "No place" }, ...data.locations.map((l) => ({ value: l.id, label: l.name }))],
    };
    return (
        <PortalDialog
            isOpen
            onOpenChange={(o) => !o && onClose()}
            title={`Change ${ids.length} assets`}
            icon={FilterLines}
            onSubmit={() => void apply()}
            footer={
                <>
                    <Button size="md" color="secondary" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button size="md" type="submit" isLoading={busy}>
                        Apply
                    </Button>
                </>
            }
        >
            <NativeSelect
                label="Change"
                value={field}
                onChange={(e) => {
                    setField(e.target.value);
                    setValue(choices[e.target.value]?.[0]?.value ?? "");
                }}
                options={[
                    { value: "addTags", label: "Add tags" },
                    { value: "removeTags", label: "Remove tags" },
                    { value: "category", label: "Category" },
                    { value: "status", label: "Status" },
                    { value: "condition", label: "Condition" },
                    { value: "locationId", label: "Place" },
                ]}
            />
            {choices[field] ? (
                <NativeSelect label="To" value={value} onChange={(e) => setValue(e.target.value)} options={choices[field]!} />
            ) : (
                <Input label="Tags" value={value} onChange={setValue} hint="Separate with commas" />
            )}
        </PortalDialog>
    );
};

export const AssetsListPage = ({ data }: { data: PageData<"assets-list"> }) => {
    const vehicles = data.section === "vehicles";
    const [assets, setAssets] = useState(data.assets);
    const [filters, setFilters] = useState<AssetFilters>(data.filters);
    const [layout, setLayout] = useState(data.preferences.layout);
    const [showFilters, setShowFilters] = useState(activeFilterCount(data.filters) > (vehicles ? 1 : 0));
    const [adding, setAdding] = useState(false);
    const [bulk, setBulk] = useState<string[] | null>(null);
    const shown = useMemo(() => applyFilters(assets, { ...filters, q: "" }), [assets, filters]);
    const changeFilters = (f: AssetFilters) => {
        setFilters(f);
        window.history.replaceState(null, "", `${window.location.pathname}${filtersToQuery(vehicles ? { ...f, group: null } : f)}`);
    };
    const reload = async () => setAssets((await assetsApi.list()).assets);
    const count = activeFilterCount(filters) - (vehicles ? 1 : 0);

    return (
        <>
            <AssetsHeader
                title={vehicles ? "Vehicles & trailers" : "All assets"}
                description={
                    vehicles ? "Registration, odometer, servicing and trailer details." : "Everything you can see: yours, and what others share with you."
                }
                crumbs={[{ label: vehicles ? "Vehicles & trailers" : "All assets" }]}
                actions={
                    <Button size="sm" iconLeading={Plus} onClick={() => setAdding(true)}>
                        {vehicles ? "Add vehicle" : "Add asset"}
                    </Button>
                }
            />
            {data.truncated && <p className="text-sm text-warning-primary">Showing the first 2,000 assets.</p>}
            {layout === "cards" ? (
                <section aria-label="Assets" className="flex flex-col gap-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <Input
                            aria-label="Search assets"
                            placeholder="Search"
                            size="sm"
                            value={filters.q}
                            onChange={(q) => changeFilters({ ...filters, q })}
                            type="search"
                            className="sm:w-64"
                        />
                        <div className="flex gap-2">
                            <Button size="sm" color="secondary" iconLeading={FilterLines} onClick={() => setShowFilters((s) => !s)}>
                                Filters{count > 0 ? ` (${count})` : ""}
                            </Button>
                            <Button size="sm" color="secondary" iconLeading={List} onClick={() => setLayout("list")}>
                                List
                            </Button>
                        </div>
                    </div>
                    {showFilters && (
                        <div className="rounded-xl ring-1 ring-secondary">
                            <Filters filters={filters} onChange={changeFilters} data={data} vehicles={vehicles} />
                        </div>
                    )}
                    {applyFilters(shown, { ...EMPTY_FILTERS, status: null, q: filters.q }).length ? (
                        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                            {applyFilters(shown, { ...EMPTY_FILTERS, status: null, q: filters.q }).map((a) => (
                                <li key={a.id} className="flex flex-col gap-3 rounded-xl bg-primary p-4 shadow-xs ring-1 ring-secondary ring-inset">
                                    <div className="flex items-start gap-3">
                                        <AssetThumb asset={a} size="lg" />
                                        <div className="flex min-w-0 flex-col gap-1">
                                            <a href={assetHref(a.id)} className="truncate text-md font-semibold text-primary hover:underline">
                                                {a.name}
                                            </a>
                                            <span className="text-sm text-tertiary">{[a.categoryLabel, a.location?.name].filter(Boolean).join(" · ")}</span>
                                            <span className="text-sm">
                                                <ValueLine value={a.currentValue} hidden={a.financialHidden} />
                                            </span>
                                        </div>
                                    </div>
                                    <div className="flex flex-wrap gap-1.5">
                                        <StatusBadge status={a.status} />
                                        {a.maintenance.overdue > 0 && <DueBadge state="overdue" />}
                                        <WarrantyBadge state={a.warranty.state} />
                                        {!a.mine && <VisibilityBadge visibility={a.visibility} />}
                                    </div>
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <Empty icon={Package} title="No assets match" description="Try clearing a filter." />
                    )}
                </section>
            ) : (
                <DataTable<AssetSummary>
                    title={vehicles ? "Vehicles & trailers" : "Assets"}
                    rows={shown}
                    searchText={searchText}
                    searchPlaceholder="Search name, model, serial, registration"
                    activeFilterCount={count}
                    onClearFilters={() => changeFilters({ ...EMPTY_FILTERS, group: vehicles ? "vehicles" : null })}
                    filters={showFilters ? <Filters filters={filters} onChange={changeFilters} data={data} vehicles={vehicles} /> : undefined}
                    actions={
                        <div className="flex gap-2">
                            <Button size="sm" color="secondary" iconLeading={FilterLines} onClick={() => setShowFilters((s) => !s)}>
                                Filters{count > 0 ? ` (${count})` : ""}
                            </Button>
                            <Button size="sm" color="secondary" iconLeading={Grid01} onClick={() => setLayout("cards")} aria-label="Card view" />
                            <Button size="sm" color="secondary" iconLeading={Download01} href={reportUrl("inventory")} aria-label="Export CSV" />
                        </div>
                    }
                    selectable
                    bulkActions={(ids, clear) => (
                        <>
                            <Button size="sm" color="secondary" onClick={() => setBulk(ids)}>
                                Change…
                            </Button>
                            <Button size="sm" color="secondary" iconLeading={QrCode02} href={`${ASSETS}/labels?ids=${ids.join(",")}`}>
                                Print labels
                            </Button>
                            <Button size="sm" color="link-gray" onClick={clear}>
                                Clear
                            </Button>
                        </>
                    )}
                    emptyState={
                        <Empty
                            icon={vehicles ? Truck01 : Package}
                            title={vehicles ? "No vehicles yet" : "No assets yet"}
                            description="Add one with just a name and a category."
                            actions={
                                <Button size="md" iconLeading={Plus} onClick={() => setAdding(true)}>
                                    Add
                                </Button>
                            }
                        />
                    }
                    initialSort={{ column: "name", direction: "ascending" }}
                    columns={[
                        {
                            id: "name",
                            label: "Asset",
                            isRowHeader: true,
                            sortValue: (a) => a.name,
                            render: (a) => (
                                <div className="flex items-center gap-3">
                                    <AssetThumb asset={a} size="sm" />
                                    <div className="flex min-w-0 flex-col">
                                        <a href={assetHref(a.id)} className="truncate font-medium text-primary hover:underline">
                                            {a.name}
                                        </a>
                                        <span className="truncate text-xs text-tertiary">
                                            {[a.manufacturer ?? a.brand, a.model].filter(Boolean).join(" ") || a.categoryLabel}
                                        </span>
                                    </div>
                                </div>
                            ),
                        },
                        ...(vehicles
                            ? [
                                  {
                                      id: "rego",
                                      label: "Registration",
                                      render: (a: AssetSummary) => a.vehicle?.registration ?? <span className="text-quaternary">—</span>,
                                  },
                                  {
                                      id: "expiry",
                                      label: "Rego expires",
                                      sortValue: (a: AssetSummary) => a.vehicle?.registrationExpiry ?? "",
                                      render: (a: AssetSummary) =>
                                          shortDate(a.vehicle?.registrationExpiry) || <span className="text-quaternary">Not recorded</span>,
                                  },
                                  {
                                      id: "odo",
                                      label: "Odometer",
                                      className: "max-md:hidden",
                                      render: (a: AssetSummary) =>
                                          a.vehicle?.odometer !== null && a.vehicle?.odometer !== undefined ? (
                                              `${a.vehicle.odometer.toLocaleString("en-AU")} ${a.vehicle.odometerUnit}`
                                          ) : (
                                              <span className="text-quaternary">—</span>
                                          ),
                                  },
                              ]
                            : [
                                  {
                                      id: "category",
                                      label: "Category",
                                      className: "max-md:hidden",
                                      sortValue: (a: AssetSummary) => a.categoryLabel,
                                      render: (a: AssetSummary) => a.categoryLabel,
                                  },
                              ]),
                        {
                            id: "place",
                            label: "Place",
                            className: "max-lg:hidden",
                            render: (a) => (a.locationHidden ? <span className="text-quaternary">Not shared</span> : (a.location?.name ?? "")),
                        },
                        {
                            id: "value",
                            label: "Value",
                            className: "max-md:hidden",
                            sortValue: (a) => a.currentValue?.amountCents ?? -1,
                            render: (a) => <Money cents={a.currentValue?.amountCents} hidden={a.financialHidden} />,
                        },
                        {
                            id: "state",
                            label: "Status",
                            render: (a) => (
                                <div className="flex flex-wrap gap-1">
                                    <StatusBadge status={a.status} />
                                    {a.maintenance.overdue > 0 ? (
                                        <DueBadge state="overdue" />
                                    ) : a.maintenance.dueSoon > 0 ? (
                                        <DueBadge state="due_soon" />
                                    ) : null}
                                </div>
                            ),
                        },
                        { id: "cover", label: "Insurance", className: "max-xl:hidden", render: (a) => <CoverageBadge state={a.coverage} /> },
                        {
                            id: "share",
                            label: "Sharing",
                            className: "max-xl:hidden",
                            render: (a) =>
                                a.mine ? (
                                    <VisibilityBadge visibility={a.visibility} />
                                ) : (
                                    <Badge size="sm" type="color" color="blue">
                                        {a.owner.name ?? a.owner.email}
                                    </Badge>
                                ),
                        },
                    ]}
                />
            )}
            {adding && (
                <AssetForm
                    categories={data.categories}
                    locations={data.locations}
                    defaults={vehicles ? { category: "vehicles" } : filters.category ? { category: filters.category } : undefined}
                    onSaved={(a) => {
                        setAdding(false);
                        window.location.href = assetHref(a.id);
                    }}
                    onClose={() => setAdding(false)}
                />
            )}
            {bulk && (
                <BulkDialog
                    ids={bulk}
                    data={data}
                    onDone={() => {
                        setBulk(null);
                        void reload();
                    }}
                    onClose={() => setBulk(null)}
                />
            )}
        </>
    );
};
