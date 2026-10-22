// The dialogs for adding and changing things in Home & Assets. Each needs only what the record
// can't exist without (an asset: a name and a category; maintenance: a title); everything else is
// optional and can be added later. Money is typed in dollars and stored as cents; an empty field
// means "not recorded", never zero.
import type { ReactNode } from "react";
import { useState } from "react";
import { Certificate01, CheckCircle, Home02, Package, ShieldTick, Tool02, Users01 } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { Checkbox } from "@/components/base/checkbox/checkbox";
import { Input } from "@/components/base/input/input";
import { NativeSelect } from "@/components/base/select/select-native";
import { TextArea } from "@/components/base/textarea/textarea";
import { Toggle } from "@/components/base/toggle/toggle";
import { PortalDialog } from "@/portal/components/dialog";
import { FormError } from "@/portal/components/form";
import { useToast } from "@/portal/components/toast";
import { ApiError, errorMessage } from "@/portal/lib/api";
import { parseMoney } from "@/portal/lib/format";
import type { AssetCategory } from "@/shared/assets/categories";
import { BUILTIN_TEMPLATES, type MaintenanceTemplate } from "@/shared/assets/templates";
import {
    APPROVALS,
    APPROVAL_LABELS,
    ASSET_STATUSES,
    ASSET_STATUS_LABELS,
    type AssetDetail,
    type AssetSummary,
    CLAIM_KINDS,
    CLAIM_KIND_LABELS,
    CLAIM_STATUSES,
    CLAIM_STATUS_LABELS,
    CONDITIONS,
    CONDITION_LABELS,
    type ClaimView,
    DISPOSAL_METHODS,
    DISPOSAL_METHOD_LABELS,
    FREQUENCIES,
    FREQUENCY_LABELS,
    type Grant,
    type HouseholdTemplate,
    INTERVAL_UNITS,
    LOCATION_KINDS,
    LOCATION_KIND_LABELS,
    type LocationView,
    MAINTENANCE_CATEGORIES,
    MAINTENANCE_CATEGORY_LABELS,
    MAINTENANCE_KINDS,
    MAINTENANCE_KIND_LABELS,
    MAINTENANCE_STATUSES,
    MAINTENANCE_STATUS_LABELS,
    type MaintenanceView,
    NO_GRANT,
    POLICY_STATUSES,
    POLICY_STATUS_LABELS,
    POLICY_TYPES,
    POLICY_TYPE_LABELS,
    PRIORITIES,
    PRIORITY_LABELS,
    type PolicyView,
    RESPONSIBILITIES,
    RESPONSIBILITY_LABELS,
    RIGHTS,
    RIGHT_LABELS,
    type ScheduleView,
    TENURES,
    TENURE_LABELS,
    VALUATION_BASES,
    VALUATION_KINDS,
    VALUATION_KIND_LABELS,
    VALUE_BASIS_LABELS,
    WARRANTY_KINDS,
    WARRANTY_KIND_LABELS,
    type WarrantyView,
} from "@/shared/assets/types";
import { assetsApi } from "./assets-api";

// --- Field helpers -------------------------------------------------------------------------------

const options = <T extends string>(values: readonly T[], labels: Record<T, string>) => values.map((v) => ({ value: v, label: labels[v] }));
const blank = (v: string) => (v.trim() === "" ? null : v.trim());
const dollars = (cents: number | null | undefined) => (cents === null || cents === undefined ? "" : (cents / 100).toFixed(2));

/** Dollars typed as text: cents, null when empty, or an error. */
export function moneyValue(text: string, label: string): number | null {
    const cents = parseMoney(text);
    if (Number.isNaN(cents)) throw new FieldError(`${label}: enter an amount like 1234.50`);
    return cents;
}
const intValue = (text: string, label: string): number | null => {
    if (!text.trim()) return null;
    const n = Number(text.replace(/[,\s]/g, ""));
    if (!Number.isInteger(n) || n < 0) throw new FieldError(`${label}: enter a whole number`);
    return n;
};
class FieldError extends Error {}

export const DateInput = ({
    label,
    value,
    onChange,
    hint,
    isRequired,
}: {
    label: string;
    value: string;
    onChange: (v: string) => void;
    hint?: string;
    isRequired?: boolean;
}) => <Input label={label} type="date" value={value} onChange={onChange} hint={hint} isRequired={isRequired} />;

const MoneyInput = ({ label, value, onChange, hint }: { label: string; value: string; onChange: (v: string) => void; hint?: string }) => (
    <Input label={label} value={value} onChange={onChange} inputMode="decimal" placeholder="0.00" hint={hint ?? "Leave empty if not recorded"} />
);

const Grid = ({ children }: { children: ReactNode }) => <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">{children}</div>;

/** Shared submit handling for the dialogs: busy state, a message for anything not tied to a field. */
function useDialogSubmit<T>(action: () => Promise<T>, onDone: (result: T) => void, success?: string) {
    const toast = useToast();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const submit = async () => {
        setBusy(true);
        setError(null);
        try {
            const result = await action();
            if (success) toast.success(success);
            onDone(result);
        } catch (e) {
            setError(e instanceof FieldError ? e.message : e instanceof ApiError ? e.message : errorMessage(e));
        } finally {
            setBusy(false);
        }
    };
    return { submit, busy, error };
}

const Footer = ({ busy, onClose, label = "Save" }: { busy: boolean; onClose: () => void; label?: string }) => (
    <>
        <Button size="md" color="secondary" onClick={onClose}>
            Cancel
        </Button>
        <Button size="md" type="submit" isLoading={busy} showTextWhileLoading>
            {label}
        </Button>
    </>
);

// --- Assets --------------------------------------------------------------------------------------

export const categoryOptions = (categories: AssetCategory[]) => categories.filter((c) => !c.archived).map((c) => ({ value: c.id, label: c.label }));

/** Quick add (name and category, optionally more), or editing an asset's details. */
export const AssetForm = ({
    categories,
    locations,
    initial,
    defaults,
    fileIds,
    onSaved,
    onClose,
}: {
    categories: AssetCategory[];
    locations: { id: string; name: string }[];
    initial?: AssetDetail["asset"];
    defaults?: Partial<{
        name: string;
        category: string;
        manufacturer: string;
        model: string;
        purchaseDate: string;
        purchasePrice: string;
        purchaseLocation: string;
        description: string;
        barcode: string;
    }>;
    fileIds?: string[];
    onSaved: (asset: AssetSummary) => void;
    onClose: () => void;
}) => {
    const editing = !!initial;
    const [more, setMore] = useState(editing || !!defaults?.manufacturer || !!defaults?.purchasePrice);
    const [f, setF] = useState({
        name: initial?.name ?? defaults?.name ?? "",
        category: initial?.category ?? defaults?.category ?? "other",
        locationId: initial?.location?.id ?? "",
        manufacturer: initial?.manufacturer ?? defaults?.manufacturer ?? "",
        brand: initial?.brand ?? "",
        model: initial?.model ?? defaults?.model ?? "",
        serialNumber: initial?.serialNumber ?? "",
        barcode: initial?.barcode ?? defaults?.barcode ?? "",
        purchaseDate: initial?.purchaseDate ?? defaults?.purchaseDate ?? "",
        purchasePrice: initial ? dollars(initial.purchasePriceCents) : (defaults?.purchasePrice ?? ""),
        purchaseLocation: initial?.purchaseLocation ?? defaults?.purchaseLocation ?? "",
        condition: initial?.condition ?? "unknown",
        status: initial?.status ?? "active",
        ownership: initial?.ownership ?? "",
        tags: initial?.tags.join(", ") ?? "",
        description: initial?.description ?? defaults?.description ?? "",
        notes: initial?.notes ?? "",
        currentValue: "",
        replacementValue: "",
        share: false,
        disposedOn: initial?.disposal.on ?? "",
        disposalMethod: initial?.disposal.method ?? "",
        disposalAmount: initial ? dollars(initial.disposal.amountCents) : "",
    });
    const set = (patch: Partial<typeof f>) => setF((x) => ({ ...x, ...patch }));
    const financial = !initial || initial.rights.financial;
    const gone = ["sold", "disposed", "gifted"].includes(f.status);
    const { submit, busy, error } = useDialogSubmit(
        async () => {
            const body: Record<string, unknown> = {
                name: f.name,
                category: f.category,
                locationId: f.locationId || null,
                ...(more
                    ? {
                          manufacturer: blank(f.manufacturer),
                          brand: blank(f.brand),
                          model: blank(f.model),
                          serialNumber: blank(f.serialNumber),
                          barcode: blank(f.barcode),
                          purchaseDate: f.purchaseDate || null,
                          purchaseLocation: blank(f.purchaseLocation),
                          condition: f.condition,
                          status: f.status,
                          ownership: blank(f.ownership),
                          tags: f.tags
                              .split(",")
                              .map((t) => t.trim().toLowerCase())
                              .filter(Boolean),
                          description: blank(f.description),
                          notes: blank(f.notes),
                          ...(financial ? { purchasePriceCents: moneyValue(f.purchasePrice, "Purchase price") } : {}),
                          ...(gone
                              ? {
                                    disposedOn: f.disposedOn || null,
                                    disposalMethod: f.disposalMethod || null,
                                    ...(financial ? { disposalAmountCents: moneyValue(f.disposalAmount, "Sale or disposal amount") } : {}),
                                }
                              : {}),
                      }
                    : {}),
            };
            if (editing) return (await assetsApi.update(initial.id, { ...body, version: initial.version })).asset;
            return (
                await assetsApi.create({
                    ...body,
                    share: f.share ? "household" : "private",
                    ...(more && f.currentValue ? { currentValueCents: moneyValue(f.currentValue, "Current value") } : {}),
                    ...(more && f.replacementValue ? { replacementValueCents: moneyValue(f.replacementValue, "Replacement value") } : {}),
                    ...(fileIds?.length ? { fileIds } : {}),
                    clientId: `asset-${crypto.randomUUID()}`,
                })
            ).asset;
        },
        onSaved,
        editing ? "Saved" : "Asset added",
    );
    return (
        <PortalDialog
            isOpen
            onOpenChange={(open) => !open && onClose()}
            size="lg"
            title={editing ? `Edit ${initial.name}` : "Add an asset"}
            description={editing ? undefined : "Only a name and a category are needed. Add anything else now or later."}
            icon={Package}
            onSubmit={() => void submit()}
            footer={<Footer busy={busy} onClose={onClose} label={editing ? "Save" : "Add asset"} />}
        >
            <FormError message={error} />
            <Grid>
                <Input
                    label="Name"
                    value={f.name}
                    onChange={(name) => set({ name })}
                    isRequired
                    maxLength={200}
                    placeholder="e.g. Toyota Hilux, Fridge, Camera"
                    autoFocus
                />
                <NativeSelect label="Category" value={f.category} onChange={(e) => set({ category: e.target.value })} options={categoryOptions(categories)} />
                <NativeSelect
                    label="Where it is"
                    value={f.locationId}
                    onChange={(e) => set({ locationId: e.target.value })}
                    options={[{ value: "", label: "Not recorded" }, ...locations.map((l) => ({ value: l.id, label: l.name }))]}
                />
                {!editing && (
                    <div className="flex items-end pb-2">
                        <Toggle
                            className="w-full"
                            label="Share with the household"
                            hint="View only. Values, insurance and documents stay private."
                            isSelected={f.share}
                            onChange={(share) => set({ share })}
                        />
                    </div>
                )}
            </Grid>
            {!more ? (
                <Button size="sm" color="link-color" onClick={() => setMore(true)} className="self-start">
                    More details
                </Button>
            ) : (
                <>
                    <Grid>
                        <Input label="Manufacturer" value={f.manufacturer} onChange={(manufacturer) => set({ manufacturer })} maxLength={120} />
                        <Input label="Brand" value={f.brand} onChange={(brand) => set({ brand })} maxLength={120} />
                        <Input label="Model" value={f.model} onChange={(model) => set({ model })} maxLength={120} />
                        <Input label="Serial number" value={f.serialNumber} onChange={(serialNumber) => set({ serialNumber })} maxLength={120} />
                        <DateInput label="Purchase date" value={f.purchaseDate} onChange={(purchaseDate) => set({ purchaseDate })} />
                        {financial && (
                            <MoneyInput
                                label="Purchase price (AUD)"
                                value={f.purchasePrice}
                                onChange={(purchasePrice) => set({ purchasePrice })}
                                hint="What was actually paid"
                            />
                        )}
                        <Input label="Bought from" value={f.purchaseLocation} onChange={(purchaseLocation) => set({ purchaseLocation })} maxLength={200} />
                        <Input label="Barcode or product code" value={f.barcode} onChange={(barcode) => set({ barcode })} maxLength={64} />
                        {!editing && (
                            <MoneyInput label="Current value, your estimate (AUD)" value={f.currentValue} onChange={(currentValue) => set({ currentValue })} />
                        )}
                        {!editing && (
                            <MoneyInput label="Replacement value (AUD)" value={f.replacementValue} onChange={(replacementValue) => set({ replacementValue })} />
                        )}
                        <NativeSelect
                            label="Condition"
                            value={f.condition}
                            onChange={(e) => set({ condition: e.target.value as typeof f.condition })}
                            options={options(CONDITIONS, CONDITION_LABELS)}
                        />
                        <NativeSelect
                            label="Status"
                            value={f.status}
                            onChange={(e) => set({ status: e.target.value as typeof f.status })}
                            options={options(ASSET_STATUSES, ASSET_STATUS_LABELS)}
                        />
                        <Input
                            label="Owned by"
                            value={f.ownership}
                            onChange={(ownership) => set({ ownership })}
                            hint="e.g. Joint, or a person's name"
                            maxLength={120}
                        />
                        <Input label="Tags" value={f.tags} onChange={(tags) => set({ tags })} hint="Separate with commas" />
                    </Grid>
                    {gone && (
                        <Grid>
                            <DateInput label="Disposed of on" value={f.disposedOn} onChange={(disposedOn) => set({ disposedOn })} />
                            <NativeSelect
                                label="How"
                                value={f.disposalMethod}
                                onChange={(e) => set({ disposalMethod: e.target.value as typeof f.disposalMethod })}
                                options={[{ value: "", label: "Not recorded" }, ...options(DISPOSAL_METHODS, DISPOSAL_METHOD_LABELS)]}
                            />
                            {financial && (
                                <MoneyInput
                                    label="Sale or disposal amount (AUD)"
                                    value={f.disposalAmount}
                                    onChange={(disposalAmount) => set({ disposalAmount })}
                                    hint="The actual amount received"
                                />
                            )}
                        </Grid>
                    )}
                    <TextArea label="Description" value={f.description} onChange={(description) => set({ description })} rows={2} maxLength={4000} />
                    <TextArea label="Notes" value={f.notes} onChange={(notes) => set({ notes })} rows={2} maxLength={8000} />
                </>
            )}
        </PortalDialog>
    );
};

// --- Vehicles ------------------------------------------------------------------------------------

export const VehicleForm = ({
    asset,
    vehicle,
    onSaved,
    onClose,
}: {
    asset: AssetDetail["asset"];
    vehicle: AssetDetail["vehicle"];
    onSaved: () => void;
    onClose: () => void;
}) => {
    const v = vehicle;
    const [f, setF] = useState({
        kind: v?.kind ?? "vehicle",
        registration: v?.registration ?? "",
        jurisdiction: v?.jurisdiction ?? "",
        registrationExpiry: v?.registrationExpiry ?? "",
        vin: v?.vin ?? "",
        engineNumber: v?.engineNumber ?? "",
        make: v?.make ?? "",
        model: v?.model ?? "",
        year: v?.year ? String(v.year) : "",
        odometerUnit: v?.odometerUnit ?? "km",
        roadsideProvider: v?.roadsideProvider ?? "",
        roadsideReference: v?.roadsideReference ?? "",
        roadsideExpiry: v?.roadsideExpiry ?? "",
        inspectionDue: v?.inspectionDue ?? "",
        batteryInstalledOn: v?.batteryInstalledOn ?? "",
        atmKg: v?.atmKg?.toString() ?? "",
        gtmKg: v?.gtmKg?.toString() ?? "",
        tareKg: v?.tareKg?.toString() ?? "",
        ballWeightKg: v?.ballWeightKg?.toString() ?? "",
        ...Object.fromEntries(Object.entries(v?.specs ?? {}).map(([k, val]) => [`spec_${k}`, val ?? ""])),
    } as Record<string, string>);
    const set = (k: string) => (value: string) => setF((x) => ({ ...x, [k]: value }));
    const towed = f.kind === "trailer" || f.kind === "caravan";
    const SPECS: [string, string][] = [
        ["tyres", "Tyres"],
        ["tyrePressures", "Tyre pressures"],
        ["battery", "Starting battery"],
        ["modifications", "Modifications"],
        ["accessories", "Accessories"],
        ["towing", "Towing equipment"],
        ...(towed
            ? ([
                  ["brakeSystem", "Brake system"],
                  ["brakeController", "Brake controller"],
                  ["bearings", "Bearings"],
                  ["coupling", "Coupling"],
                  ["electrical", "Electrical connections"],
                  ["water", "Water system"],
                  ["batterySystem", "House battery system"],
                  ["suspension", "Suspension"],
              ] as [string, string][])
            : ([["brakeController", "Brake controller"]] as [string, string][])),
        ["notes", "Other notes"],
    ];
    const { submit, busy, error } = useDialogSubmit(
        async () => {
            const kg = (k: string, label: string) => intValue(f[k] ?? "", label);
            await assetsApi.update(asset.id, {
                version: asset.version,
                vehicle: {
                    kind: f.kind,
                    registration: blank(f.registration),
                    jurisdiction: blank(f.jurisdiction),
                    registrationExpiry: f.registrationExpiry || null,
                    vin: blank(f.vin),
                    engineNumber: blank(f.engineNumber),
                    make: blank(f.make),
                    model: blank(f.model),
                    year: intValue(f.year, "Year"),
                    odometerUnit: f.odometerUnit,
                    roadsideProvider: blank(f.roadsideProvider),
                    roadsideReference: blank(f.roadsideReference),
                    roadsideExpiry: f.roadsideExpiry || null,
                    inspectionDue: f.inspectionDue || null,
                    batteryInstalledOn: f.batteryInstalledOn || null,
                    atmKg: kg("atmKg", "ATM"),
                    gtmKg: kg("gtmKg", "GTM"),
                    tareKg: kg("tareKg", "Tare"),
                    ballWeightKg: kg("ballWeightKg", "Ball weight"),
                    specs: Object.fromEntries(SPECS.map(([k]) => [k, (f[`spec_${k}`] ?? "").trim()])),
                },
            });
        },
        onSaved,
        "Vehicle details saved",
    );
    return (
        <PortalDialog
            isOpen
            onOpenChange={(open) => !open && onClose()}
            size="xl"
            title="Vehicle details"
            description="Enter what's on the registration papers, the compliance plate or the manual. Nothing here is looked up or filled in for you."
            icon={Package}
            onSubmit={() => void submit()}
            footer={<Footer busy={busy} onClose={onClose} />}
        >
            <FormError message={error} />
            <Grid>
                <NativeSelect
                    label="Kind"
                    value={f.kind}
                    onChange={(e) => set("kind")(e.target.value)}
                    options={[
                        { value: "vehicle", label: "Vehicle" },
                        { value: "trailer", label: "Trailer" },
                        { value: "caravan", label: "Caravan or camper" },
                        { value: "motorcycle", label: "Motorcycle" },
                        { value: "boat", label: "Boat" },
                        { value: "other", label: "Other" },
                    ]}
                />
                <NativeSelect
                    label="Odometer counts"
                    value={f.odometerUnit}
                    onChange={(e) => set("odometerUnit")(e.target.value)}
                    options={[
                        { value: "km", label: "Kilometres" },
                        { value: "mi", label: "Miles" },
                        { value: "hours", label: "Hours" },
                    ]}
                />
                <Input label="Registration number" value={f.registration} onChange={set("registration")} maxLength={20} />
                <Input label="State or territory" value={f.jurisdiction} onChange={set("jurisdiction")} placeholder="e.g. NSW" maxLength={40} />
                <DateInput label="Registration expiry" value={f.registrationExpiry} onChange={set("registrationExpiry")} />
                <DateInput label="Next inspection or roadworthy due" value={f.inspectionDue} onChange={set("inspectionDue")} />
                <Input label="Make" value={f.make} onChange={set("make")} maxLength={80} />
                <Input label="Model" value={f.model} onChange={set("model")} maxLength={80} />
                <Input label="Year" value={f.year} onChange={set("year")} inputMode="numeric" maxLength={4} />
                <Input label="VIN" value={f.vin} onChange={set("vin")} maxLength={40} />
                <Input label="Engine number" value={f.engineNumber} onChange={set("engineNumber")} maxLength={40} />
                <DateInput label="Battery installed" value={f.batteryInstalledOn} onChange={set("batteryInstalledOn")} />
                <Input label="Roadside assistance provider" value={f.roadsideProvider} onChange={set("roadsideProvider")} maxLength={120} />
                <Input label="Roadside membership number" value={f.roadsideReference} onChange={set("roadsideReference")} maxLength={80} />
                <DateInput label="Roadside assistance renews" value={f.roadsideExpiry} onChange={set("roadsideExpiry")} />
            </Grid>
            {towed && (
                <Grid>
                    <Input label="ATM (kg)" value={f.atmKg} onChange={set("atmKg")} inputMode="numeric" hint="Aggregate trailer mass, as plated" />
                    <Input label="GTM (kg)" value={f.gtmKg} onChange={set("gtmKg")} inputMode="numeric" hint="Gross trailer mass, as plated" />
                    <Input label="Tare (kg)" value={f.tareKg} onChange={set("tareKg")} inputMode="numeric" />
                    <Input label="Ball weight (kg)" value={f.ballWeightKg} onChange={set("ballWeightKg")} inputMode="numeric" />
                </Grid>
            )}
            <Grid>
                {SPECS.map(([k, label]) => (
                    <TextArea key={k} label={label} value={f[`spec_${k}`] ?? ""} onChange={set(`spec_${k}`)} rows={2} maxLength={2000} />
                ))}
            </Grid>
        </PortalDialog>
    );
};

export const OdometerForm = ({
    assetId,
    unit,
    today,
    onSaved,
    onClose,
}: {
    assetId: string;
    unit: string;
    today: string;
    onSaved: () => void;
    onClose: () => void;
}) => {
    const [reading, setReading] = useState("");
    const [readOn, setReadOn] = useState(today);
    const [correction, setCorrection] = useState(false);
    const [note, setNote] = useState("");
    const { submit, busy, error } = useDialogSubmit(
        async () => {
            const n = intValue(reading, "Reading");
            if (n === null) throw new FieldError("Enter the reading");
            await assetsApi.odometer(assetId, { reading: n, readOn, correction, note: blank(note) });
        },
        onSaved,
        "Reading added",
    );
    return (
        <PortalDialog
            isOpen
            onOpenChange={(o) => !o && onClose()}
            title="Add an odometer reading"
            icon={Tool02}
            onSubmit={() => void submit()}
            footer={<Footer busy={busy} onClose={onClose} label="Add" />}
        >
            <FormError message={error} />
            <Grid>
                <Input label={`Reading (${unit})`} value={reading} onChange={setReading} inputMode="numeric" isRequired autoFocus />
                <DateInput label="Read on" value={readOn} onChange={setReadOn} isRequired />
            </Grid>
            <Checkbox
                label="This is a correction"
                hint="The odometer was replaced, or an earlier reading was wrong"
                isSelected={correction}
                onChange={setCorrection}
            />
            <Input label="Note" value={note} onChange={setNote} maxLength={300} />
        </PortalDialog>
    );
};

// --- Values --------------------------------------------------------------------------------------

export const ValuationForm = ({ assetId, today, onSaved, onClose }: { assetId: string; today: string; onSaved: () => void; onClose: () => void }) => {
    const [kind, setKind] = useState<(typeof VALUATION_KINDS)[number]>("current");
    const [basis, setBasis] = useState<(typeof VALUATION_BASES)[number]>("user_estimate");
    const [amount, setAmount] = useState("");
    const [valuedOn, setValuedOn] = useState(today);
    const [source, setSource] = useState("");
    const { submit, busy, error } = useDialogSubmit(
        async () => {
            const cents = moneyValue(amount, "Amount");
            if (cents === null) throw new FieldError("Enter the amount");
            await assetsApi.addValuation(assetId, { kind, basis, amountCents: cents, valuedOn, source: blank(source) });
        },
        onSaved,
        "Value added",
    );
    return (
        <PortalDialog
            isOpen
            onOpenChange={(o) => !o && onClose()}
            title="Record a value"
            description="Say where the number came from. Nothing here is looked up: there's no market valuation."
            icon={Package}
            onSubmit={() => void submit()}
            footer={<Footer busy={busy} onClose={onClose} label="Add" />}
        >
            <FormError message={error} />
            <Grid>
                <NativeSelect
                    label="What it is"
                    value={kind}
                    onChange={(e) => setKind(e.target.value as typeof kind)}
                    options={options(VALUATION_KINDS, VALUATION_KIND_LABELS)}
                />
                <NativeSelect
                    label="Where it came from"
                    value={basis}
                    onChange={(e) => setBasis(e.target.value as typeof basis)}
                    options={VALUATION_BASES.map((b) => ({ value: b, label: VALUE_BASIS_LABELS[b] }))}
                />
                <MoneyInput label="Amount (AUD)" value={amount} onChange={setAmount} hint=" " />
                <DateInput label="As at" value={valuedOn} onChange={setValuedOn} isRequired />
            </Grid>
            <Input label="Source" value={source} onChange={setSource} hint="e.g. a quote, a valuation certificate, a sale listing" maxLength={300} />
        </PortalDialog>
    );
};

// --- Sharing -------------------------------------------------------------------------------------

export const SharingForm = ({
    asset,
    sharing,
    people,
    onSaved,
    onClose,
}: {
    asset: AssetDetail["asset"];
    sharing: NonNullable<AssetDetail["sharing"]>;
    people: { email: string; name: string | null }[];
    onSaved: () => void;
    onClose: () => void;
}) => {
    const [visibility, setVisibility] = useState(sharing.visibility);
    const [household, setHousehold] = useState<Grant>(sharing.household ?? NO_GRANT);
    const [chosen, setChosen] = useState<Record<string, Grant>>(Object.fromEntries(sharing.people.map((p) => [p.email, p.grant])));
    const { submit, busy, error } = useDialogSubmit(
        async () => {
            await assetsApi.share(asset.id, {
                visibility,
                version: asset.version,
                ...(visibility === "household" ? { household } : {}),
                ...(visibility !== "private" ? { people: Object.entries(chosen).map(([email, g]) => ({ email, ...g })) } : {}),
            });
        },
        onSaved,
        "Sharing saved",
    );
    const Rights = ({ grant, onChange, idPrefix }: { grant: Grant; onChange: (g: Grant) => void; idPrefix: string }) => (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {RIGHTS.map((r) => (
                <Checkbox
                    key={`${idPrefix}${r}`}
                    label={RIGHT_LABELS[r].label}
                    hint={RIGHT_LABELS[r].description}
                    isSelected={grant[r] || (r === "maintain" && grant.edit)}
                    isDisabled={r === "maintain" && grant.edit}
                    onChange={(on) => onChange({ ...grant, [r]: on, ...(r === "edit" && on ? { maintain: true } : {}) })}
                />
            ))}
        </div>
    );
    return (
        <PortalDialog
            isOpen
            onOpenChange={(o) => !o && onClose()}
            size="lg"
            title={`Share ${asset.name}`}
            description="Sharing lets people see it. Each right below is separate: sharing never shows values, insurance or documents unless you tick them."
            icon={Users01}
            onSubmit={() => void submit()}
            footer={<Footer busy={busy} onClose={onClose} />}
        >
            <FormError message={error} />
            <NativeSelect
                label="Who can see it"
                value={visibility}
                onChange={(e) => setVisibility(e.target.value as typeof visibility)}
                options={[
                    { value: "private", label: "Only me" },
                    { value: "selected", label: "People I choose" },
                    { value: "household", label: "Everyone in the household" },
                ]}
            />
            {visibility === "household" && (
                <fieldset className="flex flex-col gap-3 rounded-lg p-4 ring-1 ring-secondary">
                    <legend className="px-1 text-sm font-semibold text-secondary">Everyone in the household can also</legend>
                    <Rights grant={household} onChange={setHousehold} idPrefix="h" />
                </fieldset>
            )}
            {visibility !== "private" && (
                <div className="flex flex-col gap-3">
                    <p className="text-sm font-semibold text-secondary">{visibility === "household" ? "Give some people more" : "People"}</p>
                    {people.length === 0 && (
                        <p className="text-sm text-tertiary">Nobody else can open Home & Assets yet. Add people in Portal settings → Household & Access.</p>
                    )}
                    {people.map((p) => {
                        const grant = chosen[p.email];
                        return (
                            <div key={p.email} className="flex flex-col gap-3 rounded-lg p-4 ring-1 ring-secondary">
                                <Checkbox
                                    label={p.name ?? p.email}
                                    hint={p.name ? p.email : undefined}
                                    isSelected={!!grant}
                                    onChange={(on) =>
                                        setChosen((c) => {
                                            const next = { ...c };
                                            if (on) next[p.email] = NO_GRANT;
                                            else delete next[p.email];
                                            return next;
                                        })
                                    }
                                />
                                {grant && <Rights grant={grant} onChange={(g) => setChosen((c) => ({ ...c, [p.email]: g }))} idPrefix={p.email} />}
                            </div>
                        );
                    })}
                </div>
            )}
        </PortalDialog>
    );
};

// --- Places --------------------------------------------------------------------------------------

export const LocationForm = ({
    initial,
    locations,
    onSaved,
    onClose,
}: {
    initial?: LocationView;
    locations: { id: string; name: string }[];
    onSaved: (l: LocationView) => void;
    onClose: () => void;
}) => {
    const [f, setF] = useState({
        name: initial?.name ?? "",
        kind: initial?.kind ?? "residence",
        parentId: initial?.parentId ?? "",
        tenure: initial?.tenure ?? "",
        address: initial?.address ?? "",
        leaseStart: initial?.leaseStart ?? "",
        leaseEnd: initial?.leaseEnd ?? "",
        managerName: initial?.managerName ?? "",
        managerPhone: initial?.managerPhone ?? "",
        managerEmail: initial?.managerEmail ?? "",
        nextInspectionOn: initial?.nextInspectionOn ?? "",
        utilities: initial?.utilities ?? "",
        notes: initial?.notes ?? "",
        visibility: initial?.visibility ?? "private",
        householdCanEdit: initial?.householdCanEdit ?? false,
    });
    const set = (patch: Partial<typeof f>) => setF((x) => ({ ...x, ...patch }));
    const owner = !initial || initial.mine;
    const property = ["residence", "rental"].includes(f.kind);
    const { submit, busy, error } = useDialogSubmit(
        async () => {
            const body: Record<string, unknown> = {
                name: f.name,
                kind: f.kind,
                parentId: f.parentId || null,
                tenure: f.tenure || null,
                address: blank(f.address),
                leaseStart: f.leaseStart || null,
                leaseEnd: f.leaseEnd || null,
                managerName: blank(f.managerName),
                managerPhone: blank(f.managerPhone),
                managerEmail: f.managerEmail.trim(),
                nextInspectionOn: f.nextInspectionOn || null,
                utilities: blank(f.utilities),
                notes: blank(f.notes),
                ...(owner ? { visibility: f.visibility, householdCanEdit: f.visibility === "household" && f.householdCanEdit } : {}),
            };
            return initial
                ? (await assetsApi.updateLocation(initial.id, { ...body, version: initial.version })).location
                : (await assetsApi.createLocation(body)).location;
        },
        onSaved,
        initial ? "Saved" : "Place added",
    );
    return (
        <PortalDialog
            isOpen
            onOpenChange={(o) => !o && onClose()}
            size="lg"
            title={initial ? `Edit ${initial.name}` : "Add a place"}
            description="A home, rental, garage, shed, storage unit, room, or a vehicle or camper things are kept in."
            icon={Home02}
            onSubmit={() => void submit()}
            footer={<Footer busy={busy} onClose={onClose} />}
        >
            <FormError message={error} />
            <Grid>
                <Input label="Name" value={f.name} onChange={(name) => set({ name })} isRequired maxLength={120} autoFocus />
                <NativeSelect
                    label="Kind"
                    value={f.kind}
                    onChange={(e) => set({ kind: e.target.value as typeof f.kind })}
                    options={options(LOCATION_KINDS, LOCATION_KIND_LABELS)}
                />
                <NativeSelect
                    label="Inside"
                    value={f.parentId}
                    onChange={(e) => set({ parentId: e.target.value })}
                    options={[
                        { value: "", label: "Nowhere else" },
                        ...locations.filter((l) => l.id !== initial?.id).map((l) => ({ value: l.id, label: l.name })),
                    ]}
                />
                {property && (
                    <NativeSelect
                        label="Tenure"
                        value={f.tenure}
                        onChange={(e) => set({ tenure: e.target.value as typeof f.tenure })}
                        options={[{ value: "", label: "Not recorded" }, ...options(TENURES, TENURE_LABELS)]}
                    />
                )}
            </Grid>
            {property && (
                <>
                    <Input
                        label="Address"
                        value={f.address}
                        onChange={(address) => set({ address })}
                        hint="Only people who can see this place see it"
                        maxLength={300}
                    />
                    <Grid>
                        <DateInput label="Lease starts" value={f.leaseStart} onChange={(leaseStart) => set({ leaseStart })} />
                        <DateInput label="Lease ends" value={f.leaseEnd} onChange={(leaseEnd) => set({ leaseEnd })} />
                        <Input label="Property manager or landlord" value={f.managerName} onChange={(managerName) => set({ managerName })} maxLength={120} />
                        <Input label="Their phone" value={f.managerPhone} onChange={(managerPhone) => set({ managerPhone })} type="tel" maxLength={40} />
                        <Input label="Their email" value={f.managerEmail} onChange={(managerEmail) => set({ managerEmail })} type="email" maxLength={254} />
                        <DateInput label="Next inspection" value={f.nextInspectionOn} onChange={(nextInspectionOn) => set({ nextInspectionOn })} />
                    </Grid>
                    <TextArea
                        label="Utilities"
                        value={f.utilities}
                        onChange={(utilities) => set({ utilities })}
                        rows={2}
                        hint="Providers and account notes (no passwords)"
                        maxLength={2000}
                    />
                </>
            )}
            <TextArea label="Notes" value={f.notes} onChange={(notes) => set({ notes })} rows={2} maxLength={4000} />
            {owner && (
                <div className="flex flex-col gap-3">
                    <Toggle
                        className="w-full"
                        label="Share this place with the household"
                        hint="Its name, address and details"
                        isSelected={f.visibility === "household"}
                        onChange={(on) => set({ visibility: on ? "household" : "private" })}
                    />
                    {f.visibility === "household" && (
                        <Toggle
                            className="w-full"
                            label="Let the household edit it and record its maintenance"
                            isSelected={f.householdCanEdit}
                            onChange={(householdCanEdit) => set({ householdCanEdit })}
                        />
                    )}
                </div>
            )}
        </PortalDialog>
    );
};

// --- Maintenance ---------------------------------------------------------------------------------

export const MaintenanceForm = ({
    target,
    targets,
    initial,
    preset,
    onSaved,
    onClose,
}: {
    target?: { assetId?: string; locationId?: string; name: string; financial: boolean };
    targets?: { id: string; name: string; kind: "asset" | "location" }[];
    initial?: MaintenanceView;
    preset?: Partial<{ title: string; status: string; kind: string; category: string }>;
    onSaved: (r: MaintenanceView) => void;
    onClose: () => void;
}) => {
    const [f, setF] = useState({
        target: target ? (target.assetId ?? target.locationId ?? "") : (targets?.[0]?.id ?? ""),
        title: initial?.title ?? preset?.title ?? "",
        description: initial?.description ?? "",
        kind: initial?.kind ?? preset?.kind ?? "preventive",
        category: initial?.category ?? preset?.category ?? "other",
        priority: initial?.priority ?? "normal",
        status: initial?.status ?? preset?.status ?? "open",
        dueOn: initial?.dueOn ?? "",
        dueKm: initial?.dueKm?.toString() ?? "",
        scheduledOn: initial?.scheduledOn ?? "",
        scheduledTime: initial?.scheduledTime ?? "",
        completedOn: initial?.completedOn ?? "",
        odometer: initial?.odometer?.toString() ?? "",
        cost: initial ? dollars(initial.costCents) : "",
        provider: initial?.provider ?? "",
        notes: initial?.notes ?? "",
        responsibility: initial?.responsibility ?? "owner",
        requestReference: initial?.requestReference ?? "",
        requestedOn: initial?.requestedOn ?? "",
        approval: initial?.approval ?? "not_needed",
    });
    const set = (patch: Partial<typeof f>) => setF((x) => ({ ...x, ...patch }));
    const isLocation = target ? !!target.locationId : targets?.find((t) => t.id === f.target)?.kind === "location";
    const financial = initial ? !initial.costHidden : (target?.financial ?? true);
    const done = f.status === "completed";
    const { submit, busy, error } = useDialogSubmit(
        async () => {
            const body: Record<string, unknown> = {
                title: f.title,
                description: blank(f.description),
                kind: f.kind,
                category: f.category,
                priority: f.priority,
                dueOn: f.dueOn || null,
                dueKm: intValue(f.dueKm, "Due at"),
                scheduledOn: f.scheduledOn || null,
                scheduledTime: f.scheduledTime || null,
                provider: blank(f.provider),
                notes: blank(f.notes),
                responsibility: f.responsibility,
                requestReference: blank(f.requestReference),
                requestedOn: f.requestedOn || null,
                approval: f.approval,
                ...(financial ? { costCents: moneyValue(f.cost, "Cost") } : {}),
            };
            if (initial) {
                const { status, ...rest } = { ...body, status: f.status };
                return (await assetsApi.updateMaintenance(initial.id, { ...rest, ...(status !== "completed" ? { status } : {}), version: initial.version }))
                    .record;
            }
            const where = target
                ? target.assetId
                    ? { assetId: target.assetId }
                    : { locationId: target.locationId }
                : isLocation
                  ? { locationId: f.target }
                  : { assetId: f.target };
            return (
                await assetsApi.createMaintenance({
                    ...where,
                    ...body,
                    status: f.status,
                    ...(done ? { completedOn: f.completedOn || null, odometer: intValue(f.odometer, "Odometer") } : {}),
                    clientId: `maint-${crypto.randomUUID()}`,
                })
            ).record;
        },
        onSaved,
        initial ? "Saved" : done ? "Recorded" : "Added",
    );
    return (
        <PortalDialog
            isOpen
            onOpenChange={(o) => !o && onClose()}
            size="lg"
            title={initial ? "Edit maintenance" : "Add maintenance"}
            description={target ? `For ${target.name}.` : "Work to do, a request to a landlord, or work already done."}
            icon={Tool02}
            onSubmit={() => void submit()}
            footer={<Footer busy={busy} onClose={onClose} />}
        >
            <FormError message={error} />
            {!target && !initial && targets && (
                <NativeSelect
                    label="For"
                    value={f.target}
                    onChange={(e) => set({ target: e.target.value })}
                    options={targets.map((t) => ({ value: t.id, label: `${t.name}${t.kind === "location" ? " (place)" : ""}` }))}
                />
            )}
            <Input label="What needs doing" value={f.title} onChange={(title) => set({ title })} isRequired maxLength={200} autoFocus />
            <Grid>
                <NativeSelect
                    label="Kind"
                    value={f.kind}
                    onChange={(e) => set({ kind: e.target.value as typeof f.kind })}
                    options={options(MAINTENANCE_KINDS, MAINTENANCE_KIND_LABELS)}
                />
                <NativeSelect
                    label="Category"
                    value={f.category}
                    onChange={(e) => set({ category: e.target.value as typeof f.category })}
                    options={options(MAINTENANCE_CATEGORIES, MAINTENANCE_CATEGORY_LABELS)}
                />
                <NativeSelect
                    label="Priority"
                    value={f.priority}
                    onChange={(e) => set({ priority: e.target.value as typeof f.priority })}
                    options={options(PRIORITIES, PRIORITY_LABELS)}
                />
                <NativeSelect
                    label="Status"
                    value={f.status}
                    onChange={(e) => set({ status: e.target.value as typeof f.status })}
                    options={options(MAINTENANCE_STATUSES, MAINTENANCE_STATUS_LABELS).filter((o) =>
                        initial ? o.value !== "completed" || initial.status === "completed" : o.value !== "cancelled",
                    )}
                />
                {!done && <DateInput label="Due" value={f.dueOn} onChange={(dueOn) => set({ dueOn })} />}
                {!done && !isLocation && <Input label="Or due at (odometer)" value={f.dueKm} onChange={(dueKm) => set({ dueKm })} inputMode="numeric" />}
                {!done && <DateInput label="Booked for" value={f.scheduledOn} onChange={(scheduledOn) => set({ scheduledOn })} />}
                {!done && f.scheduledOn && (
                    <Input label="Booked time" type="time" value={f.scheduledTime} onChange={(scheduledTime) => set({ scheduledTime })} />
                )}
                {done && !initial && <DateInput label="Done on" value={f.completedOn} onChange={(completedOn) => set({ completedOn })} isRequired />}
                {done && !initial && !isLocation && (
                    <Input label="Odometer" value={f.odometer} onChange={(odometer) => set({ odometer })} inputMode="numeric" />
                )}
                <Input
                    label="Who does it"
                    value={f.provider}
                    onChange={(provider) => set({ provider })}
                    hint="A mechanic, a tradesperson, or yourselves"
                    maxLength={200}
                />
                {financial && <MoneyInput label="Cost (AUD)" value={f.cost} onChange={(cost) => set({ cost })} />}
            </Grid>
            {isLocation && (
                <Grid>
                    <NativeSelect
                        label="Responsibility"
                        value={f.responsibility}
                        onChange={(e) => set({ responsibility: e.target.value as typeof f.responsibility })}
                        options={options(RESPONSIBILITIES, RESPONSIBILITY_LABELS)}
                    />
                    <NativeSelect
                        label="Approval for changes"
                        value={f.approval}
                        onChange={(e) => set({ approval: e.target.value as typeof f.approval })}
                        options={options(APPROVALS, APPROVAL_LABELS)}
                    />
                    <Input label="Request reference" value={f.requestReference} onChange={(requestReference) => set({ requestReference })} maxLength={80} />
                    <DateInput label="Requested on" value={f.requestedOn} onChange={(requestedOn) => set({ requestedOn })} />
                </Grid>
            )}
            {isLocation && (
                <p className="text-sm text-tertiary">
                    Responsibility is what you understand from your lease. It isn't legal advice: check your lease and your state's tenancy authority. Recording
                    a request doesn't mean a change has been approved.
                </p>
            )}
            <TextArea label="Notes" value={f.notes} onChange={(notes) => set({ notes })} rows={3} maxLength={8000} />
        </PortalDialog>
    );
};

export const CompleteForm = ({
    record,
    today,
    isVehicle,
    onSaved,
    onClose,
}: {
    record: MaintenanceView;
    today: string;
    isVehicle: boolean;
    onSaved: () => void;
    onClose: () => void;
}) => {
    const [completedOn, setCompletedOn] = useState(today);
    const [odometer, setOdometer] = useState("");
    const [cost, setCost] = useState(dollars(record.costCents));
    const [provider, setProvider] = useState(record.provider ?? "");
    const [notes, setNotes] = useState(record.notes ?? "");
    const toast = useToast();
    const { submit, busy, error } = useDialogSubmit(
        async () => {
            const result = await assetsApi.complete(record.id, {
                completedOn,
                version: record.version,
                ...(isVehicle ? { odometer: intValue(odometer, "Odometer") } : {}),
                ...(!record.costHidden ? { costCents: moneyValue(cost, "Cost") } : {}),
                provider: blank(provider),
                notes: blank(notes),
            });
            if (result.next) toast.success("Next one scheduled", result.next.dueOn ? `Due ${result.next.dueOn}` : "Due by distance");
        },
        onSaved,
        "Marked as done",
    );
    return (
        <PortalDialog
            isOpen
            onOpenChange={(o) => !o && onClose()}
            title={`Complete: ${record.title}`}
            description={record.scheduleId ? "Its schedule moves on from the date (and odometer) you enter." : undefined}
            icon={CheckCircle}
            iconColor="success"
            onSubmit={() => void submit()}
            footer={<Footer busy={busy} onClose={onClose} label="Mark as done" />}
        >
            <FormError message={error} />
            <Grid>
                <DateInput label="Done on" value={completedOn} onChange={setCompletedOn} isRequired />
                {isVehicle && <Input label="Odometer" value={odometer} onChange={setOdometer} inputMode="numeric" />}
                {!record.costHidden && <MoneyInput label="Cost (AUD)" value={cost} onChange={setCost} />}
                <Input label="Who did it" value={provider} onChange={setProvider} maxLength={200} />
            </Grid>
            <TextArea label="Notes" value={notes} onChange={setNotes} rows={2} maxLength={8000} />
        </PortalDialog>
    );
};

export const ScheduleForm = ({
    target,
    initial,
    template,
    isVehicle,
    onSaved,
    onClose,
}: {
    target: { assetId?: string; locationId?: string; name: string };
    initial?: ScheduleView;
    template?: MaintenanceTemplate | HouseholdTemplate;
    isVehicle: boolean;
    onSaved: () => void;
    onClose: () => void;
}) => {
    const [f, setF] = useState({
        title: initial?.title ?? template?.title ?? "",
        category: initial?.category ?? template?.category ?? "service",
        intervalCount: initial?.intervalCount?.toString() ?? (template && !template.builtin ? (template.intervalCount?.toString() ?? "") : ""),
        intervalUnit: initial?.intervalUnit ?? (template && !template.builtin ? (template.intervalUnit ?? "months") : "months"),
        intervalKm: initial?.intervalKm?.toString() ?? (template && !template.builtin ? (template.intervalKm?.toString() ?? "") : ""),
        lastDoneOn: initial?.lastDoneOn ?? "",
        lastDoneKm: initial?.lastDoneKm?.toString() ?? "",
        firstDueOn: initial?.firstDueOn ?? "",
        firstDueKm: initial?.firstDueKm?.toString() ?? "",
        reminderDays: (initial?.reminderDays ?? [14, 0]).join(", "),
        responsibility: initial?.responsibility ?? "owner",
        provider: initial?.provider ?? "",
        notes: initial?.notes ?? "",
        autoNext: initial?.autoNext ?? true,
        active: initial?.active ?? true,
    });
    const set = (patch: Partial<typeof f>) => setF((x) => ({ ...x, ...patch }));
    const source =
        template && "intervalSource" in template ? template.intervalSource : "Use the interval from the owner's manual, service book, manufacturer or lease.";
    const { submit, busy, error } = useDialogSubmit(
        async () => {
            const days = f.reminderDays
                .split(/[,\s]+/)
                .filter(Boolean)
                .map((d) => intValue(d, "Remind me"))
                .filter((d): d is number => d !== null);
            const count = intValue(f.intervalCount, "Every");
            const body: Record<string, unknown> = {
                title: f.title,
                category: f.category,
                intervalCount: count,
                intervalUnit: count ? f.intervalUnit : null,
                intervalKm: isVehicle ? intValue(f.intervalKm, "Every (distance)") : null,
                lastDoneOn: f.lastDoneOn || null,
                firstDueOn: f.firstDueOn || null,
                ...(isVehicle ? { lastDoneKm: intValue(f.lastDoneKm, "Last done at"), firstDueKm: intValue(f.firstDueKm, "First due at") } : {}),
                reminderDays: days,
                responsibility: f.responsibility,
                provider: blank(f.provider),
                notes: blank(f.notes),
                autoNext: f.autoNext,
                active: f.active,
                ...(template && !initial ? { templateId: template.id } : {}),
            };
            if (initial) await assetsApi.updateSchedule(initial.id, { ...body, version: initial.version });
            else await assetsApi.createSchedule({ ...(target.assetId ? { assetId: target.assetId } : { locationId: target.locationId }), ...body });
        },
        onSaved,
        initial ? "Schedule saved" : "Schedule added",
    );
    return (
        <PortalDialog
            isOpen
            onOpenChange={(o) => !o && onClose()}
            size="lg"
            title={initial ? "Edit schedule" : "Add a recurring schedule"}
            description={`For ${target.name}. ${source}`}
            icon={Tool02}
            onSubmit={() => void submit()}
            footer={<Footer busy={busy} onClose={onClose} />}
        >
            <FormError message={error} />
            <Grid>
                <Input label="Title" value={f.title} onChange={(title) => set({ title })} isRequired maxLength={200} />
                <NativeSelect
                    label="Category"
                    value={f.category}
                    onChange={(e) => set({ category: e.target.value as typeof f.category })}
                    options={options(MAINTENANCE_CATEGORIES, MAINTENANCE_CATEGORY_LABELS)}
                />
                <Input
                    label="Every"
                    value={f.intervalCount}
                    onChange={(intervalCount) => set({ intervalCount })}
                    inputMode="numeric"
                    hint="Leave empty to go by distance only"
                />
                <NativeSelect
                    label="Unit"
                    value={f.intervalUnit}
                    onChange={(e) => set({ intervalUnit: e.target.value as typeof f.intervalUnit })}
                    options={INTERVAL_UNITS.map((u) => ({ value: u, label: u[0].toUpperCase() + u.slice(1) }))}
                />
                {isVehicle && (
                    <Input
                        label="Or every (distance)"
                        value={f.intervalKm}
                        onChange={(intervalKm) => set({ intervalKm })}
                        inputMode="numeric"
                        hint="Whichever comes first"
                    />
                )}
                <DateInput label="Last done" value={f.lastDoneOn} onChange={(lastDoneOn) => set({ lastDoneOn })} hint="The next one is counted from this" />
                {isVehicle && <Input label="Last done at (odometer)" value={f.lastDoneKm} onChange={(lastDoneKm) => set({ lastDoneKm })} inputMode="numeric" />}
                <DateInput label="Or first due" value={f.firstDueOn} onChange={(firstDueOn) => set({ firstDueOn })} hint="If it's never been done" />
                {isVehicle && (
                    <Input label="Or first due at (odometer)" value={f.firstDueKm} onChange={(firstDueKm) => set({ firstDueKm })} inputMode="numeric" />
                )}
                <Input label="Remind me (days before)" value={f.reminderDays} onChange={(reminderDays) => set({ reminderDays })} hint="e.g. 30, 7, 0" />
                {target.locationId && (
                    <NativeSelect
                        label="Responsibility"
                        value={f.responsibility}
                        onChange={(e) => set({ responsibility: e.target.value as typeof f.responsibility })}
                        options={options(RESPONSIBILITIES, RESPONSIBILITY_LABELS)}
                    />
                )}
                <Input label="Who usually does it" value={f.provider} onChange={(provider) => set({ provider })} maxLength={200} />
            </Grid>
            <TextArea label="Notes" value={f.notes} onChange={(notes) => set({ notes })} rows={2} maxLength={2000} />
            <Toggle
                className="w-full"
                label="Add the next one automatically when this is completed"
                isSelected={f.autoNext}
                onChange={(autoNext) => set({ autoNext })}
            />
            {initial && (
                <Toggle
                    className="w-full"
                    label="Active"
                    hint="Paused schedules aren't due and send no reminders"
                    isSelected={f.active}
                    onChange={(active) => set({ active })}
                />
            )}
        </PortalDialog>
    );
};

export const TemplatePicker = ({
    household,
    onPick,
}: {
    household: HouseholdTemplate[];
    onPick: (t: MaintenanceTemplate | HouseholdTemplate | null) => void;
}) => (
    <NativeSelect
        label="Start from a template"
        value=""
        onChange={(e) => {
            const id = e.target.value;
            onPick([...BUILTIN_TEMPLATES, ...household].find((t) => t.id === id) ?? null);
        }}
        options={[
            { value: "", label: "Choose a template (optional)" },
            ...household.map((t) => ({ value: t.id, label: `${t.title} (household)` })),
            ...BUILTIN_TEMPLATES.map((t) => ({ value: t.id, label: t.title })),
        ]}
    />
);

// --- Insurance and warranties --------------------------------------------------------------------

export const PolicyForm = ({
    initial,
    prefill,
    onSaved,
    onClose,
}: {
    initial?: PolicyView;
    prefill?: Partial<Record<string, string>>;
    onSaved: (p: PolicyView) => void;
    onClose: () => void;
}) => {
    const [f, setF] = useState({
        provider: initial?.provider ?? prefill?.provider ?? "",
        policyType: initial?.policyType ?? prefill?.policyType ?? "contents",
        name: initial?.name ?? "",
        reference: initial?.reference ?? prefill?.reference ?? "",
        startsOn: initial?.startsOn ?? prefill?.startsOn ?? "",
        renewsOn: initial?.renewsOn ?? prefill?.renewsOn ?? "",
        premium: initial ? dollars(initial.premiumCents) : (prefill?.premium ?? ""),
        paymentFrequency: initial?.paymentFrequency ?? "annual",
        excess: initial ? dollars(initial.excessCents) : (prefill?.excess ?? ""),
        coverageSummary: initial?.coverageSummary ?? prefill?.coverageSummary ?? "",
        coverageLimits: initial?.coverageLimits ?? "",
        exclusions: initial?.exclusions ?? prefill?.exclusions ?? "",
        contactPhone: initial?.contactPhone ?? "",
        contactEmail: initial?.contactEmail ?? "",
        contactUrl: initial?.contactUrl ?? "",
        notes: initial?.notes ?? "",
        status: initial?.status ?? "active",
        shared: initial?.shared ?? false,
        householdCanEdit: initial?.householdCanEdit ?? false,
    });
    const set = (patch: Partial<typeof f>) => setF((x) => ({ ...x, ...patch }));
    const owner = !initial || initial.mine;
    const unverified = Object.keys(prefill ?? {});
    const { submit, busy, error } = useDialogSubmit(
        async () => {
            const body: Record<string, unknown> = {
                provider: f.provider,
                policyType: f.policyType,
                name: blank(f.name),
                reference: blank(f.reference),
                startsOn: f.startsOn || null,
                renewsOn: f.renewsOn || null,
                premiumCents: moneyValue(f.premium, "Premium"),
                paymentFrequency: f.paymentFrequency || null,
                excessCents: moneyValue(f.excess, "Excess"),
                coverageSummary: blank(f.coverageSummary),
                coverageLimits: blank(f.coverageLimits),
                exclusions: blank(f.exclusions),
                contactPhone: blank(f.contactPhone),
                contactEmail: f.contactEmail.trim(),
                contactUrl: f.contactUrl.trim(),
                notes: blank(f.notes),
                status: f.status,
                ...(owner ? { shared: f.shared, householdCanEdit: f.shared && f.householdCanEdit } : {}),
                ...(unverified.length ? { unverifiedFields: unverified } : {}),
            };
            return initial
                ? (await assetsApi.updatePolicy(initial.id, { ...body, version: initial.version })).policy
                : (await assetsApi.createPolicy(body)).policy;
        },
        onSaved,
        initial ? "Saved" : "Policy added",
    );
    return (
        <PortalDialog
            isOpen
            onOpenChange={(o) => !o && onClose()}
            size="xl"
            title={initial ? "Edit policy" : "Add a policy"}
            description="What the policy documents say. This is your record of it, not confirmation of cover: verify it against the documents once it's entered."
            icon={ShieldTick}
            onSubmit={() => void submit()}
            footer={<Footer busy={busy} onClose={onClose} />}
        >
            <FormError message={error} />
            {unverified.length > 0 && (
                <p className="text-sm text-warning-primary">
                    Some values came from an AI suggestion. They stay marked as unverified until you check them against the document and verify the policy.
                </p>
            )}
            <Grid>
                <Input label="Insurer" value={f.provider} onChange={(provider) => set({ provider })} isRequired maxLength={120} />
                <NativeSelect
                    label="Type"
                    value={f.policyType}
                    onChange={(e) => set({ policyType: e.target.value as typeof f.policyType })}
                    options={options(POLICY_TYPES, POLICY_TYPE_LABELS)}
                />
                <Input label="Name" value={f.name} onChange={(name) => set({ name })} hint="e.g. Camper trailer policy" maxLength={120} />
                <Input label="Policy number" value={f.reference} onChange={(reference) => set({ reference })} maxLength={80} />
                <DateInput label="Period starts" value={f.startsOn} onChange={(startsOn) => set({ startsOn })} />
                <DateInput label="Renews" value={f.renewsOn} onChange={(renewsOn) => set({ renewsOn })} />
                <MoneyInput label="Premium (AUD)" value={f.premium} onChange={(premium) => set({ premium })} />
                <NativeSelect
                    label="Paid"
                    value={f.paymentFrequency}
                    onChange={(e) => set({ paymentFrequency: e.target.value as typeof f.paymentFrequency })}
                    options={options(FREQUENCIES, FREQUENCY_LABELS)}
                />
                <MoneyInput label="Excess (AUD)" value={f.excess} onChange={(excess) => set({ excess })} />
                <NativeSelect
                    label="Status"
                    value={f.status}
                    onChange={(e) => set({ status: e.target.value as typeof f.status })}
                    options={options(POLICY_STATUSES, POLICY_STATUS_LABELS)}
                />
                <Input label="Claims phone" value={f.contactPhone} onChange={(contactPhone) => set({ contactPhone })} type="tel" maxLength={40} />
                <Input label="Claims email" value={f.contactEmail} onChange={(contactEmail) => set({ contactEmail })} type="email" maxLength={254} />
            </Grid>
            <Input label="Insurer's website" value={f.contactUrl} onChange={(contactUrl) => set({ contactUrl })} placeholder="https://" maxLength={300} />
            <TextArea
                label="What it covers (your summary of the wording)"
                value={f.coverageSummary}
                onChange={(coverageSummary) => set({ coverageSummary })}
                rows={3}
                maxLength={4000}
            />
            <TextArea label="Limits" value={f.coverageLimits} onChange={(coverageLimits) => set({ coverageLimits })} rows={2} maxLength={4000} />
            <TextArea label="Exclusions" value={f.exclusions} onChange={(exclusions) => set({ exclusions })} rows={2} maxLength={4000} />
            <TextArea label="Notes" value={f.notes} onChange={(notes) => set({ notes })} rows={2} maxLength={4000} />
            {owner && (
                <div className="flex flex-col gap-3">
                    <Toggle
                        className="w-full"
                        label="Share this policy with the household"
                        hint="They can see it; its assets still follow each asset's own sharing"
                        isSelected={f.shared}
                        onChange={(shared) => set({ shared })}
                    />
                    {f.shared && (
                        <Toggle
                            className="w-full"
                            label="Let the household edit it"
                            isSelected={f.householdCanEdit}
                            onChange={(householdCanEdit) => set({ householdCanEdit })}
                        />
                    )}
                </div>
            )}
        </PortalDialog>
    );
};

export const RenewForm = ({ policy, onSaved, onClose }: { policy: PolicyView; onSaved: () => void; onClose: () => void }) => {
    const [startsOn, setStartsOn] = useState(policy.renewsOn ?? "");
    const [renewsOn, setRenewsOn] = useState("");
    const [premium, setPremium] = useState("");
    const { submit, busy, error } = useDialogSubmit(
        async () => {
            await assetsApi.renewPolicy(policy.id, {
                version: policy.version,
                startsOn: startsOn || null,
                renewsOn: renewsOn || null,
                premiumCents: moneyValue(premium, "Premium"),
            });
        },
        onSaved,
        "Renewal recorded",
    );
    return (
        <PortalDialog
            isOpen
            onOpenChange={(o) => !o && onClose()}
            title={`Renew ${policy.name ?? policy.provider}`}
            description="The previous period's premium is kept for comparison. Verify the policy again once you've checked the new documents."
            icon={ShieldTick}
            onSubmit={() => void submit()}
            footer={<Footer busy={busy} onClose={onClose} label="Record renewal" />}
        >
            <FormError message={error} />
            <Grid>
                <DateInput label="New period starts" value={startsOn} onChange={setStartsOn} isRequired />
                <DateInput label="Renews next on" value={renewsOn} onChange={setRenewsOn} isRequired />
                <MoneyInput label="New premium (AUD)" value={premium} onChange={setPremium} />
            </Grid>
        </PortalDialog>
    );
};

export const WarrantyForm = ({ assetId, initial, onSaved, onClose }: { assetId: string; initial?: WarrantyView; onSaved: () => void; onClose: () => void }) => {
    const [f, setF] = useState({
        kind: initial?.kind ?? "manufacturer",
        provider: initial?.provider ?? "",
        startsOn: initial?.startsOn ?? "",
        months: initial?.months?.toString() ?? "",
        expiresOn: initial?.expiresBasis === "stated" ? (initial.expiresOn ?? "") : "",
        reference: initial?.reference ?? "",
        terms: initial?.terms ?? "",
        contact: initial?.contact ?? "",
        cost: initial ? dollars(initial.costCents) : "",
    });
    const set = (patch: Partial<typeof f>) => setF((x) => ({ ...x, ...patch }));
    const { submit, busy, error } = useDialogSubmit(
        async () => {
            const body = {
                kind: f.kind,
                provider: blank(f.provider),
                startsOn: f.startsOn || null,
                months: intValue(f.months, "Length"),
                expiresOn: f.expiresOn || null,
                reference: blank(f.reference),
                terms: blank(f.terms),
                contact: blank(f.contact),
                costCents: moneyValue(f.cost, "Cost"),
            };
            if (initial) await assetsApi.updateWarranty(initial.id, { ...body, version: initial.version });
            else await assetsApi.addWarranty(assetId, body);
        },
        onSaved,
        "Warranty saved",
    );
    return (
        <PortalDialog
            isOpen
            onOpenChange={(o) => !o && onClose()}
            size="lg"
            title={initial ? "Edit warranty" : "Add a warranty"}
            description="Enter the end date if it's stated, or the length in months (counted from the start, or the purchase date). Without either, the end date stays unknown."
            icon={Certificate01}
            onSubmit={() => void submit()}
            footer={<Footer busy={busy} onClose={onClose} />}
        >
            <FormError message={error} />
            <Grid>
                <NativeSelect
                    label="Kind"
                    value={f.kind}
                    onChange={(e) => set({ kind: e.target.value as typeof f.kind })}
                    options={options(WARRANTY_KINDS, WARRANTY_KIND_LABELS)}
                />
                <Input label="Provider" value={f.provider} onChange={(provider) => set({ provider })} maxLength={120} />
                <DateInput label="Starts" value={f.startsOn} onChange={(startsOn) => set({ startsOn })} hint="Empty: the purchase date" />
                <Input label="Length (months)" value={f.months} onChange={(months) => set({ months })} inputMode="numeric" />
                <DateInput label="Or ends on (as stated)" value={f.expiresOn} onChange={(expiresOn) => set({ expiresOn })} />
                <Input label="Reference" value={f.reference} onChange={(reference) => set({ reference })} maxLength={80} />
                <Input label="Claims contact" value={f.contact} onChange={(contact) => set({ contact })} maxLength={300} />
                <MoneyInput label="Cost of the warranty (AUD)" value={f.cost} onChange={(cost) => set({ cost })} />
            </Grid>
            <TextArea label="Terms" value={f.terms} onChange={(terms) => set({ terms })} rows={3} maxLength={4000} />
        </PortalDialog>
    );
};

export const ClaimForm = ({
    initial,
    assets,
    assetId,
    policyId,
    kind,
    onSaved,
    onClose,
}: {
    initial?: ClaimView;
    assets?: { id: string; name: string }[];
    assetId?: string;
    policyId?: string;
    kind?: ClaimView["kind"];
    onSaved: () => void;
    onClose: () => void;
}) => {
    const [f, setF] = useState({
        assetId: initial?.assetId ?? assetId ?? assets?.[0]?.id ?? "",
        kind: initial?.kind ?? kind ?? "warranty",
        lodgedOn: initial?.lodgedOn ?? "",
        reference: initial?.reference ?? "",
        description: initial?.description ?? "",
        status: initial?.status ?? "preparing",
        claimed: initial ? dollars(initial.amountClaimedCents) : "",
        paid: initial ? dollars(initial.amountPaidCents) : "",
        outcome: initial?.outcome ?? "",
    });
    const set = (patch: Partial<typeof f>) => setF((x) => ({ ...x, ...patch }));
    const { submit, busy, error } = useDialogSubmit(
        async () => {
            const body = {
                lodgedOn: f.lodgedOn || null,
                reference: blank(f.reference),
                description: blank(f.description),
                status: f.status,
                amountClaimedCents: moneyValue(f.claimed, "Amount claimed"),
                amountPaidCents: moneyValue(f.paid, "Amount paid"),
                outcome: blank(f.outcome),
            };
            if (initial) await assetsApi.updateClaim(initial.id, body);
            else await assetsApi.createClaim({ ...body, kind: f.kind, ...(f.assetId ? { assetId: f.assetId } : {}), ...(policyId ? { policyId } : {}) });
        },
        onSaved,
        "Claim saved",
    );
    return (
        <PortalDialog
            isOpen
            onOpenChange={(o) => !o && onClose()}
            size="lg"
            title={initial ? "Edit claim" : "Record a claim"}
            icon={ShieldTick}
            onSubmit={() => void submit()}
            footer={<Footer busy={busy} onClose={onClose} />}
        >
            <FormError message={error} />
            <Grid>
                {!initial && assets && !assetId && (
                    <NativeSelect
                        label="Asset"
                        value={f.assetId}
                        onChange={(e) => set({ assetId: e.target.value })}
                        options={assets.map((a) => ({ value: a.id, label: a.name }))}
                    />
                )}
                {!initial && (
                    <NativeSelect
                        label="Kind"
                        value={f.kind}
                        onChange={(e) => set({ kind: e.target.value as typeof f.kind })}
                        options={options(CLAIM_KINDS, CLAIM_KIND_LABELS)}
                    />
                )}
                <NativeSelect
                    label="Status"
                    value={f.status}
                    onChange={(e) => set({ status: e.target.value as typeof f.status })}
                    options={options(CLAIM_STATUSES, CLAIM_STATUS_LABELS)}
                />
                <DateInput label="Lodged on" value={f.lodgedOn} onChange={(lodgedOn) => set({ lodgedOn })} />
                <Input label="Claim reference" value={f.reference} onChange={(reference) => set({ reference })} maxLength={80} />
                <MoneyInput label="Amount claimed (AUD)" value={f.claimed} onChange={(claimed) => set({ claimed })} />
                <MoneyInput label="Amount paid (AUD)" value={f.paid} onChange={(paid) => set({ paid })} />
            </Grid>
            <TextArea label="What happened" value={f.description} onChange={(description) => set({ description })} rows={3} maxLength={4000} />
            <TextArea label="Outcome" value={f.outcome} onChange={(outcome) => set({ outcome })} rows={2} maxLength={2000} />
        </PortalDialog>
    );
};

export const ProblemForm = ({ assetId, name, onSaved, onClose }: { assetId: string; name: string; onSaved: () => void; onClose: () => void }) => {
    const [title, setTitle] = useState("");
    const [description, setDescription] = useState("");
    const [priority, setPriority] = useState<(typeof PRIORITIES)[number]>("normal");
    const { submit, busy, error } = useDialogSubmit(
        async () => {
            await assetsApi.problem(assetId, { title, description: blank(description), priority });
        },
        onSaved,
        "Problem reported",
    );
    return (
        <PortalDialog
            isOpen
            onOpenChange={(o) => !o && onClose()}
            title={`Report a problem with ${name}`}
            description="It's added as a repair to do."
            icon={Tool02}
            iconColor="warning"
            onSubmit={() => void submit()}
            footer={<Footer busy={busy} onClose={onClose} label="Report" />}
        >
            <FormError message={error} />
            <Input label="What's wrong" value={title} onChange={setTitle} isRequired maxLength={200} autoFocus />
            <NativeSelect
                label="How urgent"
                value={priority}
                onChange={(e) => setPriority(e.target.value as typeof priority)}
                options={options(PRIORITIES, PRIORITY_LABELS)}
            />
            <TextArea label="Details" value={description} onChange={setDescription} rows={3} maxLength={4000} />
        </PortalDialog>
    );
};
