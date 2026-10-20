// One asset. Opened from a list, a reminder, or a scanned QR label (which lands here after the
// normal sign-in, with ?v= showing the label version). Each tab shows only what the person may see:
// values, insurance and documents can each be withheld, and the page says so instead of showing $0.
import { useState } from "react";
import {
    AlertTriangle,
    Calendar,
    CheckCircle,
    CheckDone01,
    Download01,
    Edit05,
    File04,
    Image01,
    Link01,
    MarkerPin01,
    Plus,
    Printer,
    QrCode02,
    ShieldTick,
    Star01,
    Tool02,
    Trash01,
    Users01,
} from "@untitledui/icons";
import { FileUpload } from "@/components/application/file-upload/file-upload-base";
import { Tabs } from "@/components/application/tabs/tabs";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Input } from "@/components/base/input/input";
import { NativeSelect } from "@/components/base/select/select-native";
import { ConfirmDialog, PortalDialog } from "@/portal/components/dialog";
import { Notice } from "@/portal/components/notice";
import { useToast } from "@/portal/components/toast";
import { Card } from "@/portal/knowledge/pages/knowledge-home-page";
import { errorMessage } from "@/portal/lib/api";
import { formatDateTime } from "@/portal/lib/format";
import type { PageData } from "@/portal/lib/page-types";
import { CONSUMER_LAW_NOTE } from "@/shared/assets/engine";
import {
    APPROVAL_LABELS,
    type AssetDetail,
    type AssetFileView,
    CLAIM_KIND_LABELS,
    CLAIM_STATUS_LABELS,
    CONDITION_LABELS,
    FILE_KINDS,
    FILE_KIND_LABELS,
    FREQUENCY_LABELS,
    MAINTENANCE_KIND_LABELS,
    MAINTENANCE_STATUS_LABELS,
    type MaintenanceView,
    PHOTO_TAGS,
    PHOTO_TAG_LABELS,
    POLICY_TYPE_LABELS,
    RESPONSIBILITY_LABELS,
    type ScheduleView,
    TRAILER_SPECS,
    VALUATION_KIND_LABELS,
    VALUE_BASIS_LABELS,
    VEHICLE_KIND_LABELS,
    VEHICLE_SPEC_LABELS,
    WARRANTY_KIND_LABELS,
    type WarrantyView,
} from "@/shared/assets/types";
import { assetsApi, fileUrl, qrUrl } from "../assets-api";
import {
    AssetForm,
    ClaimForm,
    CompleteForm,
    MaintenanceForm,
    OdometerForm,
    ProblemForm,
    ScheduleForm,
    SharingForm,
    TemplatePicker,
    ValuationForm,
    VehicleForm,
    WarrantyForm,
} from "../forms";
import {
    ASSETS,
    AssetThumb,
    AssetsHeader,
    CoverageBadge,
    DateWithDistance,
    DueBadge,
    Money,
    StatusBadge,
    ValueLine,
    VisibilityBadge,
    WarrantyBadge,
    locationHref,
    prepareFile,
    shortDate,
} from "../shared";

type Tab = "overview" | "maintenance" | "documents" | "cover" | "value" | "history";
const TABS: Tab[] = ["overview", "maintenance", "documents", "cover", "value", "history"];

const Row = ({ label, children, stacked = false }: { label: string; children: React.ReactNode; stacked?: boolean }) => (
    <div className={stacked ? "flex flex-col gap-1 py-2" : "grid grid-cols-1 gap-0.5 py-2 sm:grid-cols-[minmax(140px,200px)_1fr] sm:gap-4"}>
        <dt className="text-sm text-tertiary">{label}</dt>
        <dd className="min-w-0 text-sm break-words text-primary">{children ?? <span className="text-quaternary">Not recorded</span>}</dd>
    </div>
);
const Rows = ({ children }: { children: React.ReactNode }) => <dl className="flex flex-col divide-y divide-secondary px-4 py-1 sm:px-5">{children}</dl>;
const text = (v: string | number | null | undefined) => (v === null || v === undefined || v === "" ? null : String(v));

export const AssetsItemPage = ({ data }: { data: PageData<"assets-item"> }) => {
    const toast = useToast();
    const [detail, setDetail] = useState(data.detail);
    const [tab, setTab] = useState<Tab>(TABS.includes(data.tab as Tab) ? (data.tab as Tab) : "overview");
    const [dialog, setDialog] = useState<
        | null
        | { kind: "edit" | "vehicle" | "odometer" | "value" | "share" | "problem" | "delete" | "move" | "label" | "warranty" | "claim" | "knowledge" }
        | { kind: "maintenance"; record?: MaintenanceView; preset?: Record<string, string> }
        | { kind: "complete"; record: MaintenanceView }
        | { kind: "schedule"; schedule?: ScheduleView; template?: Parameters<typeof ScheduleForm>[0]["template"] }
        | { kind: "editWarranty"; warranty: WarrantyView }
        | { kind: "file"; file: AssetFileView }
    >(null);
    const [people, setPeople] = useState<{ email: string; name: string | null }[]>([]);
    const a = detail.asset;
    const r = a.rights;
    const isVehicle = !!detail.vehicle;
    const reload = async () => {
        setDetail((await assetsApi.detail(a.id)).detail);
        setDialog(null);
    };
    const switchTab = (next: Tab) => {
        setTab(next);
        const url = new URL(window.location.href);
        url.searchParams.set("tab", next);
        url.searchParams.delete("v");
        window.history.replaceState(null, "", url.toString());
    };
    const act = async (label: string, run: () => Promise<unknown>) => {
        try {
            await run();
            toast.success(label);
            await reload();
        } catch (e) {
            toast.error("That didn't work", errorMessage(e));
        }
    };
    const makeTask = (refKind: string, refId: string) =>
        act("Task ready", async () => {
            const result = await assetsApi.task({ refKind, refId });
            if (result.hidden) toast.success("A task already exists", "Someone else in the household made it.");
        });
    const photos = detail.files.filter((f) => f.kind === "photo");
    const docs = detail.files.filter((f) => f.kind !== "photo");
    const open = detail.maintenance.filter((m) => !["completed", "cancelled"].includes(m.status));
    const history = detail.maintenance.filter((m) => ["completed", "cancelled"].includes(m.status));
    const today = data.today;

    return (
        <>
            <AssetsHeader
                title={a.name}
                description={
                    <span className="flex flex-wrap items-center gap-2">
                        <span>{[a.categoryLabel, a.manufacturer ?? a.brand, a.model].filter(Boolean).join(" · ")}</span>
                        <StatusBadge status={a.status} />
                        <VisibilityBadge visibility={a.visibility} />
                        {!a.mine && (
                            <Badge size="sm" type="color" color="blue">
                                Shared by {a.owner.name ?? a.owner.email}
                            </Badge>
                        )}
                    </span>
                }
                crumbs={[
                    {
                        label: a.group === "vehicles" ? "Vehicles & trailers" : "All assets",
                        href: a.group === "vehicles" ? `${ASSETS}/vehicles` : `${ASSETS}/all`,
                    },
                    { label: a.name },
                ]}
                actions={
                    <>
                        {r.maintain && (
                            <Button size="sm" color="secondary" iconLeading={AlertTriangle} onClick={() => setDialog({ kind: "problem" })}>
                                Report a problem
                            </Button>
                        )}
                        {r.maintain && (
                            <Button
                                size="sm"
                                iconLeading={Plus}
                                onClick={() => setDialog({ kind: "maintenance", preset: { status: "completed", kind: "service", category: "service" } })}
                            >
                                Add service entry
                            </Button>
                        )}
                    </>
                }
            >
                {data.labelVersionScanned !== null && data.labelVersionScanned < a.labelVersion && (
                    <Notice title="This is an older label" color="warning">
                        You scanned label version {data.labelVersionScanned}; the current label is version {a.labelVersion}. The asset is the same: consider
                        replacing the old label.
                    </Notice>
                )}
            </AssetsHeader>

            <Tabs selectedKey={tab} onSelectionChange={(k) => switchTab(k as Tab)} className="gap-6">
                <Tabs.List type="underline" size="sm" aria-label="Asset" className="w-max max-w-full overflow-x-auto">
                    <Tabs.Item id="overview">Overview</Tabs.Item>
                    <Tabs.Item id="maintenance">Maintenance{open.length ? ` (${open.length})` : ""}</Tabs.Item>
                    <Tabs.Item id="documents">Photos & documents</Tabs.Item>
                    <Tabs.Item id="cover">Warranty & insurance</Tabs.Item>
                    <Tabs.Item id="value">Value</Tabs.Item>
                    <Tabs.Item id="history">History</Tabs.Item>
                </Tabs.List>

                {/* --- Overview ------------------------------------------------------------------ */}
                <Tabs.Panel id="overview" className="flex flex-col gap-6">
                    <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
                        <div className="flex flex-col gap-6 xl:col-span-2">
                            <Card
                                title="Details"
                                icon={File04}
                                action={
                                    r.edit && (
                                        <Button size="sm" color="secondary" iconLeading={Edit05} onClick={() => setDialog({ kind: "edit" })}>
                                            Edit
                                        </Button>
                                    )
                                }
                            >
                                <Rows>
                                    <Row label="Category">{a.categoryLabel}</Row>
                                    <Row label="Manufacturer">{text(a.manufacturer)}</Row>
                                    <Row label="Brand">{text(a.brand)}</Row>
                                    <Row label="Model">{text(a.model)}</Row>
                                    <Row label="Serial number">{text(a.serialNumber)}</Row>
                                    <Row label="Barcode">{text(a.barcode)}</Row>
                                    <Row label="Condition">{CONDITION_LABELS[a.condition]}</Row>
                                    <Row label="Where it is">
                                        {a.locationHidden ? (
                                            <span className="text-tertiary">In a place not shared with you</span>
                                        ) : a.location ? (
                                            <a href={locationHref(a.location.id)} className="text-brand-secondary hover:underline">
                                                {a.location.name}
                                            </a>
                                        ) : null}
                                    </Row>
                                    <Row label="Owned by">{text(a.ownership)}</Row>
                                    <Row label="Purchased">
                                        {a.purchaseDate
                                            ? `${shortDate(a.purchaseDate)}${a.purchaseLocation ? ` from ${a.purchaseLocation}` : ""}`
                                            : text(a.purchaseLocation)}
                                    </Row>
                                    <Row label="Purchase price">
                                        <Money cents={a.purchasePriceCents} hidden={a.financialHidden} />
                                    </Row>
                                    {a.customFields.map((f) => (
                                        <Row key={f.key} label={f.label}>
                                            {a.custom[f.key] === undefined || a.custom[f.key] === null
                                                ? null
                                                : f.type === "boolean"
                                                  ? a.custom[f.key]
                                                      ? "Yes"
                                                      : "No"
                                                  : String(a.custom[f.key])}
                                        </Row>
                                    ))}
                                    {a.tags.length > 0 && (
                                        <Row label="Tags">
                                            <span className="flex flex-wrap gap-1">
                                                {a.tags.map((t) => (
                                                    <Badge key={t} size="sm" type="color" color="gray">
                                                        {t}
                                                    </Badge>
                                                ))}
                                            </span>
                                        </Row>
                                    )}
                                    {a.description && <Row label="Description">{a.description}</Row>}
                                    {a.notes && <Row label="Notes">{a.notes}</Row>}
                                    {a.disposal.on && (
                                        <Row label="Disposed of">
                                            {shortDate(a.disposal.on)}
                                            {a.disposal.method ? ` · ${a.disposal.method}` : ""}
                                            {a.disposal.amountCents !== null && (
                                                <>
                                                    {" · "}
                                                    <Money cents={a.disposal.amountCents} />
                                                </>
                                            )}
                                        </Row>
                                    )}
                                </Rows>
                            </Card>

                            {(isVehicle || r.edit) && a.group === "vehicles" && (
                                <Card
                                    title={detail.vehicle ? VEHICLE_KIND_LABELS[detail.vehicle.kind] : "Vehicle"}
                                    icon={Tool02}
                                    action={
                                        <div className="flex gap-2">
                                            {r.maintain && detail.vehicle && (
                                                <Button size="sm" color="secondary" onClick={() => setDialog({ kind: "odometer" })}>
                                                    Add reading
                                                </Button>
                                            )}
                                            {r.edit && (
                                                <Button size="sm" color="secondary" iconLeading={Edit05} onClick={() => setDialog({ kind: "vehicle" })}>
                                                    Edit
                                                </Button>
                                            )}
                                        </div>
                                    }
                                >
                                    {detail.vehicle ? (
                                        <Rows>
                                            <Row label="Registration">
                                                {[detail.vehicle.registration, detail.vehicle.jurisdiction].filter(Boolean).join(" · ") || null}
                                            </Row>
                                            <Row label="Registration expiry">
                                                {detail.vehicle.registrationExpiry ? (
                                                    <span className="flex flex-wrap items-center gap-2">
                                                        <DateWithDistance date={detail.vehicle.registrationExpiry} today={today} />
                                                        {data.canTasks && r.maintain && (
                                                            <Button
                                                                size="xs"
                                                                color="link-color"
                                                                iconLeading={CheckDone01}
                                                                onClick={() => void makeTask("registration", a.id)}
                                                            >
                                                                Renewal task
                                                            </Button>
                                                        )}
                                                    </span>
                                                ) : null}
                                            </Row>
                                            <Row label="Odometer">
                                                {detail.vehicle.odometer
                                                    ? `${detail.vehicle.odometer.reading.toLocaleString("en-AU")} ${detail.vehicle.odometerUnit} on ${shortDate(detail.vehicle.odometer.readOn)}`
                                                    : null}
                                            </Row>
                                            <Row label="Make and model">
                                                {[detail.vehicle.year, detail.vehicle.make, detail.vehicle.model].filter(Boolean).join(" ") || null}
                                            </Row>
                                            <Row label="VIN">{text(detail.vehicle.vin)}</Row>
                                            <Row label="Engine number">{text(detail.vehicle.engineNumber)}</Row>
                                            <Row label="Inspection due">
                                                {detail.vehicle.inspectionDue ? <DateWithDistance date={detail.vehicle.inspectionDue} today={today} /> : null}
                                            </Row>
                                            <Row label="Roadside assistance">
                                                {[
                                                    detail.vehicle.roadsideProvider,
                                                    detail.vehicle.roadsideReference,
                                                    detail.vehicle.roadsideExpiry && `renews ${shortDate(detail.vehicle.roadsideExpiry)}`,
                                                ]
                                                    .filter(Boolean)
                                                    .join(" · ") || null}
                                            </Row>
                                            <Row label="Battery installed">
                                                {detail.vehicle.batteryInstalledOn ? shortDate(detail.vehicle.batteryInstalledOn) : null}
                                            </Row>
                                            {(detail.vehicle.kind === "trailer" || detail.vehicle.kind === "caravan") && (
                                                <Row label="Masses">
                                                    {[
                                                        detail.vehicle.atmKg !== null && `ATM ${detail.vehicle.atmKg} kg`,
                                                        detail.vehicle.gtmKg !== null && `GTM ${detail.vehicle.gtmKg} kg`,
                                                        detail.vehicle.tareKg !== null && `Tare ${detail.vehicle.tareKg} kg`,
                                                        detail.vehicle.ballWeightKg !== null && `Ball weight ${detail.vehicle.ballWeightKg} kg`,
                                                    ]
                                                        .filter(Boolean)
                                                        .join(" · ") || null}
                                                </Row>
                                            )}
                                            {(Object.keys(VEHICLE_SPEC_LABELS) as (keyof typeof VEHICLE_SPEC_LABELS)[])
                                                .filter(
                                                    (k) =>
                                                        detail.vehicle!.specs[k] &&
                                                        (detail.vehicle!.kind === "trailer" ||
                                                            detail.vehicle!.kind === "caravan" ||
                                                            !TRAILER_SPECS.includes(k)),
                                                )
                                                .map((k) => (
                                                    <Row key={k} label={VEHICLE_SPEC_LABELS[k]}>
                                                        <span className="whitespace-pre-line">{detail.vehicle!.specs[k]}</span>
                                                    </Row>
                                                ))}
                                        </Rows>
                                    ) : (
                                        <p className="px-4 py-3 text-sm text-tertiary sm:px-5">No vehicle details yet.</p>
                                    )}
                                </Card>
                            )}
                        </div>

                        <div className="order-first flex flex-col gap-6 xl:order-none">
                            {a.coverFileId ? (
                                <section aria-label="Photo" className="overflow-hidden rounded-xl bg-primary shadow-xs ring-1 ring-secondary ring-inset">
                                    <img src={fileUrl(a.coverFileId)} alt={`Photo of ${a.name}`} className="aspect-[4/3] w-full bg-secondary object-cover" />
                                </section>
                            ) : (
                                r.maintain && (
                                    <button
                                        type="button"
                                        onClick={() => switchTab("documents")}
                                        className="flex cursor-pointer items-center gap-3 rounded-xl bg-primary p-4 text-left text-sm text-tertiary shadow-xs ring-1 ring-secondary outline-focus-ring ring-inset hover:bg-primary_hover focus-visible:outline-2"
                                    >
                                        <AssetThumb asset={a} size="sm" />
                                        <span>
                                            <span className="block font-semibold text-secondary">Add a photo</span>
                                            Photos at purchase help with insurance claims.
                                        </span>
                                    </button>
                                )
                            )}
                            <Card title="At a glance" icon={Star01}>
                                <Rows>
                                    <Row stacked label="Value">
                                        <ValueLine value={a.currentValue} hidden={a.financialHidden} />
                                    </Row>
                                    <Row stacked label="Warranty">
                                        <WarrantyBadge state={a.warranty.state} />
                                    </Row>
                                    <Row stacked label="Insurance">
                                        <CoverageBadge state={a.coverage} />
                                    </Row>
                                    <Row stacked label="Maintenance">
                                        {a.maintenance.overdue ? (
                                            <DueBadge state="overdue" />
                                        ) : a.maintenance.dueSoon ? (
                                            <DueBadge state="due_soon" />
                                        ) : a.maintenance.nextDueOn ? (
                                            `Next ${shortDate(a.maintenance.nextDueOn)}`
                                        ) : (
                                            "Nothing scheduled"
                                        )}
                                    </Row>
                                </Rows>
                            </Card>
                            <Card title="Actions" icon={Tool02}>
                                <div className="flex flex-col gap-2 px-4 py-3 sm:px-5">
                                    {r.maintain && (
                                        <Button size="sm" color="secondary" iconLeading={MarkerPin01} onClick={() => setDialog({ kind: "move" })}>
                                            Update location
                                        </Button>
                                    )}
                                    <Button size="sm" color="secondary" iconLeading={QrCode02} onClick={() => setDialog({ kind: "label" })}>
                                        QR label
                                    </Button>
                                    {r.manage && (
                                        <Button
                                            size="sm"
                                            color="secondary"
                                            iconLeading={Users01}
                                            onClick={() => {
                                                void assetsApi.people().then((p) => setPeople(p.people));
                                                setDialog({ kind: "share" });
                                            }}
                                        >
                                            Sharing
                                        </Button>
                                    )}
                                    {r.manage && (
                                        <Button size="sm" color="secondary-destructive" iconLeading={Trash01} onClick={() => setDialog({ kind: "delete" })}>
                                            Delete
                                        </Button>
                                    )}
                                </div>
                            </Card>
                            {detail.knowledge.length > 0 || (r.edit && data.canKnowledge) ? (
                                <Card
                                    title="Knowledge"
                                    icon={Link01}
                                    action={
                                        r.edit &&
                                        data.canKnowledge && (
                                            <Button size="sm" color="link-color" onClick={() => setDialog({ kind: "knowledge" })}>
                                                Link
                                            </Button>
                                        )
                                    }
                                >
                                    {detail.knowledge.length ? (
                                        <ul className="flex flex-col divide-y divide-secondary">
                                            {detail.knowledge.map((k) => (
                                                <li key={k.objectId} className="flex items-center justify-between gap-2 px-4 py-2.5 text-sm sm:px-5">
                                                    {k.available ? (
                                                        <a href={`/portal/knowledge/o/${k.objectId}`} className="font-medium text-primary hover:underline">
                                                            {k.title} <span className="font-normal text-tertiary">· {k.spaceName}</span>
                                                        </a>
                                                    ) : (
                                                        <span className="text-tertiary">A Knowledge object you can't open</span>
                                                    )}
                                                    {r.edit && (
                                                        <ButtonUtility
                                                            size="xs"
                                                            color="tertiary"
                                                            icon={Trash01}
                                                            tooltip="Unlink"
                                                            onClick={() => void act("Unlinked", () => assetsApi.unlinkKnowledge(a.id, k.objectId))}
                                                        />
                                                    )}
                                                </li>
                                            ))}
                                        </ul>
                                    ) : (
                                        <p className="px-4 py-3 text-sm text-tertiary sm:px-5">
                                            Link a manual, notes or a troubleshooting guide from Daly Knowledge. Nothing is copied.
                                        </p>
                                    )}
                                </Card>
                            ) : null}
                        </div>
                    </div>
                </Tabs.Panel>

                {/* --- Maintenance --------------------------------------------------------------- */}
                <Tabs.Panel id="maintenance" className="flex flex-col gap-6">
                    <Card
                        title="Schedules"
                        icon={Calendar}
                        action={
                            r.maintain && (
                                <Button size="sm" color="secondary" iconLeading={Plus} onClick={() => setDialog({ kind: "schedule" })}>
                                    Add schedule
                                </Button>
                            )
                        }
                    >
                        {detail.schedules.length ? (
                            <ul className="flex flex-col divide-y divide-secondary">
                                {detail.schedules.map((s) => (
                                    <li key={s.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
                                        <div className="flex min-w-0 flex-col gap-0.5">
                                            <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-primary">
                                                {s.title} <DueBadge state={s.state} />
                                            </span>
                                            <span className="text-xs text-tertiary">
                                                {[
                                                    s.intervalCount && `Every ${s.intervalCount} ${s.intervalUnit}`,
                                                    s.intervalKm && `every ${s.intervalKm.toLocaleString("en-AU")} ${detail.vehicle?.odometerUnit ?? "km"}`,
                                                ]
                                                    .filter(Boolean)
                                                    .join(" or ")}
                                                {s.intervalCount && s.intervalKm ? ", whichever comes first" : ""}
                                                {s.lastDoneOn && ` · last done ${shortDate(s.lastDoneOn)}`}
                                                {s.nextDueOn && ` · next ${shortDate(s.nextDueOn)}`}
                                                {s.nextDueKm !== null && ` · at ${s.nextDueKm.toLocaleString("en-AU")}`}
                                                {s.remainingKm !== null && s.remainingKm > 0 && ` (${s.remainingKm.toLocaleString("en-AU")} to go)`}
                                            </span>
                                            {s.unknownReason && <span className="text-xs text-warning-primary">{s.unknownReason}</span>}
                                        </div>
                                        {r.maintain && (
                                            <div className="flex shrink-0 gap-2">
                                                {data.canTasks && !s.openRecordId && (
                                                    <Button
                                                        size="xs"
                                                        color="secondary"
                                                        iconLeading={CheckDone01}
                                                        onClick={() => void makeTask("schedule", s.id)}
                                                    >
                                                        Task
                                                    </Button>
                                                )}
                                                <Button
                                                    size="xs"
                                                    color="secondary"
                                                    iconLeading={Edit05}
                                                    onClick={() => setDialog({ kind: "schedule", schedule: s })}
                                                >
                                                    Edit
                                                </Button>
                                            </div>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        ) : (
                            <p className="px-4 py-3 text-sm text-tertiary sm:px-5">
                                No recurring schedules. Add one with the interval from the manual or service book: nothing is assumed.
                            </p>
                        )}
                    </Card>
                    <MaintenanceList
                        title="To do"
                        records={open}
                        canTasks={data.canTasks}
                        canCalendar={data.canCalendar}
                        onAdd={r.maintain ? () => setDialog({ kind: "maintenance" }) : undefined}
                        onEdit={(record) => setDialog({ kind: "maintenance", record })}
                        onComplete={(record) => setDialog({ kind: "complete", record })}
                        onTask={(record) => void makeTask("maintenance", record.id)}
                        onAppointment={(record) => void act("Added to Calendar", () => assetsApi.appointment(record.id))}
                        onCancel={(record) => void act("Cancelled", () => assetsApi.cancel(record.id))}
                    />
                    <MaintenanceList title="History" records={history} canTasks={false} canCalendar={false} totals={detail.totals} />
                    {isVehicle && detail.odometer.length > 0 && (
                        <Card title="Odometer history" icon={Tool02}>
                            <ul className="flex flex-col divide-y divide-secondary">
                                {detail.odometer.map((o) => (
                                    <li key={o.id} className="flex items-center justify-between gap-2 px-4 py-2 text-sm sm:px-5">
                                        <span>
                                            {o.reading.toLocaleString("en-AU")} {detail.vehicle?.odometerUnit} · {shortDate(o.readOn)}
                                            {o.correction && " · correction"}
                                            {o.note && <span className="text-tertiary"> · {o.note}</span>}
                                        </span>
                                        {r.edit && (
                                            <ButtonUtility
                                                size="xs"
                                                color="tertiary"
                                                icon={Trash01}
                                                tooltip="Remove reading"
                                                onClick={() => void act("Removed", () => assetsApi.deleteOdometer(a.id, o.id))}
                                            />
                                        )}
                                    </li>
                                ))}
                            </ul>
                        </Card>
                    )}
                </Tabs.Panel>

                {/* --- Photos and documents ------------------------------------------------------ */}
                <Tabs.Panel id="documents" className="flex flex-col gap-6">
                    <Uploads assetId={a.id} canPhotos={r.maintain} canDocs={r.edit && r.documents} onDone={() => void reload()} />
                    <Card title="Photos" icon={Image01}>
                        {photos.length ? (
                            <ul className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3 sm:p-5 lg:grid-cols-4">
                                {photos.map((p) => (
                                    <li key={p.id} className="flex flex-col gap-1.5">
                                        <a
                                            href={fileUrl(p.id)}
                                            target="_blank"
                                            rel="noopener"
                                            className="block overflow-hidden rounded-lg ring-1 ring-secondary"
                                        >
                                            <img
                                                src={fileUrl(p.id, p.hasThumb)}
                                                alt={
                                                    p.caption ??
                                                    (p.photoTag && p.photoTag !== "general"
                                                        ? `${PHOTO_TAG_LABELS[p.photoTag]} photo of ${a.name}`
                                                        : `Photo of ${a.name}`)
                                                }
                                                loading="lazy"
                                                className="aspect-square w-full bg-secondary object-cover"
                                            />
                                        </a>
                                        <span className="flex items-center justify-between gap-1 text-xs text-tertiary">
                                            <span className="truncate">
                                                {p.photoTag && p.photoTag !== "general" ? `${PHOTO_TAG_LABELS[p.photoTag]} · ` : ""}
                                                {p.caption ?? shortDate(p.createdAt.slice(0, 10))}
                                                {a.coverFileId === p.id ? " · Cover" : ""}
                                            </span>
                                            {(r.edit || p.mine) && (
                                                <ButtonUtility
                                                    size="xs"
                                                    color="tertiary"
                                                    icon={Edit05}
                                                    tooltip="Edit photo"
                                                    onClick={() => setDialog({ kind: "file", file: p })}
                                                />
                                            )}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        ) : (
                            <p className="px-4 py-3 text-sm text-tertiary sm:px-5">No photos yet. Photos taken at purchase help with insurance claims.</p>
                        )}
                    </Card>
                    <Card title="Documents" icon={File04}>
                        {docs.length ? (
                            <ul className="flex flex-col divide-y divide-secondary">
                                {docs.map((d) => (
                                    <li key={d.id} className="flex items-center justify-between gap-3 px-4 py-2.5 sm:px-5">
                                        <div className="flex min-w-0 flex-col">
                                            <a href={fileUrl(d.id)} className="truncate text-sm font-medium text-primary hover:underline">
                                                {d.caption ?? d.filename}
                                            </a>
                                            <span className="text-xs text-tertiary">
                                                {FILE_KIND_LABELS[d.kind]} · {shortDate(d.createdAt.slice(0, 10))} · {Math.max(1, Math.round(d.bytes / 1024))}{" "}
                                                KB
                                            </span>
                                        </div>
                                        <div className="flex shrink-0 gap-1">
                                            <ButtonUtility size="xs" color="tertiary" icon={Download01} tooltip="Download" href={fileUrl(d.id)} />
                                            {(r.edit || d.mine) && (
                                                <ButtonUtility
                                                    size="xs"
                                                    color="tertiary"
                                                    icon={Edit05}
                                                    tooltip="Edit"
                                                    onClick={() => setDialog({ kind: "file", file: d })}
                                                />
                                            )}
                                        </div>
                                    </li>
                                ))}
                            </ul>
                        ) : (
                            <p className="px-4 py-3 text-sm text-tertiary sm:px-5">
                                {detail.documentsHidden
                                    ? `${detail.documentsHidden} documents aren't shared with you.`
                                    : "No documents yet: add the receipt, the manual or the warranty card."}
                            </p>
                        )}
                        {docs.length > 0 && detail.documentsHidden > 0 && (
                            <p className="px-4 pb-3 text-xs text-tertiary sm:px-5">{detail.documentsHidden} more aren't shared with you.</p>
                        )}
                    </Card>
                </Tabs.Panel>

                {/* --- Warranty and insurance ---------------------------------------------------- */}
                <Tabs.Panel id="cover" className="flex flex-col gap-6">
                    <Card
                        title="Warranties"
                        icon={ShieldTick}
                        action={
                            r.edit && (
                                <Button size="sm" color="secondary" iconLeading={Plus} onClick={() => setDialog({ kind: "warranty" })}>
                                    Add warranty
                                </Button>
                            )
                        }
                    >
                        {detail.warranties.length ? (
                            <ul className="flex flex-col divide-y divide-secondary">
                                {detail.warranties.map((w) => (
                                    <li key={w.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
                                        <div className="flex flex-col gap-0.5">
                                            <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-primary">
                                                {WARRANTY_KIND_LABELS[w.kind]}
                                                {w.provider ? ` · ${w.provider}` : ""} <WarrantyBadge state={w.state} />
                                            </span>
                                            <span className="text-xs text-tertiary">
                                                {w.expiresOn
                                                    ? `Ends ${shortDate(w.expiresOn)} (${w.expiresBasis === "stated" ? "as stated" : `worked out from ${w.startsOn ? "the start" : "the purchase date"} + ${w.months} months`})`
                                                    : "End date not known: add the length or the stated end date"}
                                            </span>
                                        </div>
                                        <div className="flex gap-2">
                                            {data.canTasks && w.expiresOn && w.state !== "expired" && (
                                                <Button
                                                    size="xs"
                                                    color="secondary"
                                                    iconLeading={CheckDone01}
                                                    onClick={() => void makeTask("warranty_expiry", w.id)}
                                                >
                                                    Task
                                                </Button>
                                            )}
                                            {r.edit && (
                                                <Button
                                                    size="xs"
                                                    color="secondary"
                                                    iconLeading={Edit05}
                                                    onClick={() => setDialog({ kind: "editWarranty", warranty: w })}
                                                >
                                                    Edit
                                                </Button>
                                            )}
                                        </div>
                                    </li>
                                ))}
                            </ul>
                        ) : (
                            <p className="px-4 py-3 text-sm text-tertiary sm:px-5">No warranty recorded.</p>
                        )}
                        <p className="border-t border-secondary px-4 py-3 text-xs text-tertiary sm:px-5">{CONSUMER_LAW_NOTE}</p>
                    </Card>
                    <Card title="Insurance" icon={ShieldTick} action={<CoverageBadge state={a.coverage} />}>
                        {detail.policies === null ? (
                            <p className="px-4 py-3 text-sm text-tertiary sm:px-5">Insurance for this asset isn't shared with you.</p>
                        ) : detail.policies.length ? (
                            <ul className="flex flex-col divide-y divide-secondary">
                                {detail.policies.map((p) => (
                                    <li key={p.id} className="flex flex-col gap-0.5 px-4 py-3 sm:px-5">
                                        <a href={`${ASSETS}/insurance?policy=${p.id}`} className="text-sm font-medium text-primary hover:underline">
                                            {p.name ?? p.provider} · {POLICY_TYPE_LABELS[p.policyType]}
                                        </a>
                                        <span className="text-xs text-tertiary">
                                            {p.verified ? "Verified against the documents" : "Not yet verified against the documents"}
                                            {p.renewsOn && ` · renews ${shortDate(p.renewsOn)}`}
                                            {p.premiumCents !== null &&
                                                ` · premium ${(p.premiumCents / 100).toFixed(2)} ${p.paymentFrequency ? FREQUENCY_LABELS[p.paymentFrequency].toLowerCase() : ""}`}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        ) : (
                            <p className="px-4 py-3 text-sm text-tertiary sm:px-5">
                                No policy linked. Link this asset from its policy in{" "}
                                <a href={`${ASSETS}/insurance`} className="text-brand-secondary hover:underline">
                                    Insurance
                                </a>
                                .
                            </p>
                        )}
                    </Card>
                    <Card
                        title="Claims"
                        icon={File04}
                        action={
                            r.edit && (
                                <Button size="sm" color="secondary" iconLeading={Plus} onClick={() => setDialog({ kind: "claim" })}>
                                    Record a claim
                                </Button>
                            )
                        }
                    >
                        {detail.claims.length ? (
                            <ul className="flex flex-col divide-y divide-secondary">
                                {detail.claims.map((c) => (
                                    <li key={c.id} className="flex flex-col px-4 py-2.5 text-sm sm:px-5">
                                        <span className="font-medium text-primary">
                                            {CLAIM_KIND_LABELS[c.kind]} · {CLAIM_STATUS_LABELS[c.status]}
                                        </span>
                                        <span className="text-xs text-tertiary">
                                            {[c.lodgedOn && `Lodged ${shortDate(c.lodgedOn)}`, c.reference, c.outcome].filter(Boolean).join(" · ")}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        ) : (
                            <p className="px-4 py-3 text-sm text-tertiary sm:px-5">No claims.</p>
                        )}
                    </Card>
                </Tabs.Panel>

                {/* --- Value --------------------------------------------------------------------- */}
                <Tabs.Panel id="value" className="flex flex-col gap-6">
                    {a.financialHidden ? (
                        <Notice title="Values aren't shared with you">The owner hasn't shared this asset's purchase price, values or costs with you.</Notice>
                    ) : (
                        <>
                            <Card
                                title="Values"
                                icon={Star01}
                                action={
                                    r.edit && (
                                        <Button size="sm" color="secondary" iconLeading={Plus} onClick={() => setDialog({ kind: "value" })}>
                                            Record a value
                                        </Button>
                                    )
                                }
                            >
                                <Rows>
                                    <Row label="Purchase price">
                                        <span className="flex flex-wrap items-center gap-2">
                                            <Money cents={a.purchasePriceCents} />
                                            {a.purchasePriceCents !== null && (
                                                <Badge size="sm" type="color" color="brand">
                                                    Actual transaction
                                                </Badge>
                                            )}
                                        </span>
                                    </Row>
                                    <Row label="Current value">
                                        <ValueLine value={a.currentValue} />
                                    </Row>
                                    <Row label="Replacement value">
                                        <ValueLine value={a.replacementValue} />
                                    </Row>
                                    <Row label="Depreciation">
                                        {a.depreciation && a.depreciation.method !== "none"
                                            ? a.depreciation.method === "straight_line"
                                                ? `Straight line over ${a.depreciation.years} years to ${a.depreciation.residualPercent}%`
                                                : `Reducing by ${a.depreciation.ratePercent}% a year`
                                            : "Off: values are only what's recorded"}
                                    </Row>
                                    {a.formulaValue && (
                                        <Row label="Formula estimate">
                                            <ValueLine value={a.formulaValue} />
                                        </Row>
                                    )}
                                    {detail.totals && (
                                        <Row label="Maintenance spent">
                                            <Money cents={detail.totals.maintenanceCostCents} />
                                            {detail.totals.costsMissing > 0 && (
                                                <span className="text-tertiary"> · {detail.totals.costsMissing} records without a cost</span>
                                            )}
                                        </Row>
                                    )}
                                </Rows>
                                {r.edit && <DepreciationEditor asset={a} onSaved={() => void reload()} />}
                            </Card>
                            {detail.valuations && detail.valuations.length > 0 && (
                                <Card title="Value history" icon={Star01}>
                                    <ul className="flex flex-col divide-y divide-secondary">
                                        {detail.valuations.map((v) => (
                                            <li key={v.id} className="flex items-center justify-between gap-2 px-4 py-2.5 text-sm sm:px-5">
                                                <span>
                                                    {VALUATION_KIND_LABELS[v.kind]}: <Money cents={v.amountCents} /> · {VALUE_BASIS_LABELS[v.basis]} ·{" "}
                                                    {shortDate(v.valuedOn)}
                                                    {v.source && <span className="text-tertiary"> · {v.source}</span>}
                                                </span>
                                                {r.edit && (
                                                    <ButtonUtility
                                                        size="xs"
                                                        color="tertiary"
                                                        icon={Trash01}
                                                        tooltip="Remove"
                                                        onClick={() => void act("Removed", () => assetsApi.deleteValuation(a.id, v.id))}
                                                    />
                                                )}
                                            </li>
                                        ))}
                                    </ul>
                                </Card>
                            )}
                        </>
                    )}
                </Tabs.Panel>

                {/* --- History ------------------------------------------------------------------- */}
                <Tabs.Panel id="history">
                    <Card title="History" icon={Calendar}>
                        <ul className="flex flex-col divide-y divide-secondary">
                            {detail.activity.map((e, i) => (
                                <li key={i} className="flex flex-col px-4 py-2 text-sm sm:flex-row sm:justify-between sm:px-5">
                                    <span>
                                        {e.action.replace(/[._]/g, " ")}{" "}
                                        <span className="text-tertiary">
                                            by {e.actor}
                                            {e.via === "mcp" ? " (AI assistant)" : e.via === "system" ? " (automatically)" : ""}
                                        </span>
                                    </span>
                                    <span className="text-xs text-tertiary">{formatDateTime(e.at)}</span>
                                </li>
                            ))}
                        </ul>
                        {detail.tasks.length > 0 && (
                            <div className="border-t border-secondary px-4 py-3 sm:px-5">
                                <p className="mb-2 text-sm font-semibold text-secondary">Linked tasks</p>
                                <ul className="flex flex-col gap-1">
                                    {detail.tasks.map((t) => (
                                        <li key={t.taskId} className="text-sm">
                                            {t.available ? (
                                                <a href={`/portal/tasks/t/${t.taskId}`} className="text-brand-secondary hover:underline">
                                                    {t.title}
                                                </a>
                                            ) : (
                                                <span className="text-tertiary">A task in someone else's project</span>
                                            )}
                                            {t.status === "completed" && <span className="text-tertiary"> · done</span>}
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        )}
                    </Card>
                </Tabs.Panel>
            </Tabs>

            {/* --- Dialogs --------------------------------------------------------------------- */}
            {dialog?.kind === "edit" && (
                <AssetForm categories={data.categories} locations={data.locations} initial={a} onSaved={() => void reload()} onClose={() => setDialog(null)} />
            )}
            {dialog?.kind === "vehicle" && <VehicleForm asset={a} vehicle={detail.vehicle} onSaved={() => void reload()} onClose={() => setDialog(null)} />}
            {dialog?.kind === "odometer" && (
                <OdometerForm
                    assetId={a.id}
                    unit={detail.vehicle?.odometerUnit ?? "km"}
                    today={today}
                    onSaved={() => void reload()}
                    onClose={() => setDialog(null)}
                />
            )}
            {dialog?.kind === "value" && <ValuationForm assetId={a.id} today={today} onSaved={() => void reload()} onClose={() => setDialog(null)} />}
            {dialog?.kind === "share" && detail.sharing && (
                <SharingForm asset={a} sharing={detail.sharing} people={people} onSaved={() => void reload()} onClose={() => setDialog(null)} />
            )}
            {dialog?.kind === "problem" && (
                <ProblemForm assetId={a.id} name={a.name} onSaved={() => void reload().then(() => switchTab("maintenance"))} onClose={() => setDialog(null)} />
            )}
            {dialog?.kind === "maintenance" && (
                <MaintenanceForm
                    target={{ assetId: a.id, name: a.name, financial: !a.financialHidden }}
                    initial={dialog.record}
                    preset={dialog.preset}
                    onSaved={() => void reload().then(() => switchTab("maintenance"))}
                    onClose={() => setDialog(null)}
                />
            )}
            {dialog?.kind === "complete" && (
                <CompleteForm record={dialog.record} today={today} isVehicle={isVehicle} onSaved={() => void reload()} onClose={() => setDialog(null)} />
            )}
            {dialog?.kind === "schedule" && (
                <ScheduleDialog
                    target={{ assetId: a.id, name: a.name }}
                    schedule={dialog.schedule}
                    isVehicle={isVehicle}
                    household={[]}
                    onSaved={() => void reload()}
                    onClose={() => setDialog(null)}
                />
            )}
            {dialog?.kind === "warranty" && <WarrantyForm assetId={a.id} onSaved={() => void reload()} onClose={() => setDialog(null)} />}
            {dialog?.kind === "editWarranty" && (
                <WarrantyForm assetId={a.id} initial={dialog.warranty} onSaved={() => void reload()} onClose={() => setDialog(null)} />
            )}
            {dialog?.kind === "claim" && <ClaimForm assetId={a.id} onSaved={() => void reload()} onClose={() => setDialog(null)} />}
            {dialog?.kind === "move" && <MoveDialog asset={a} locations={data.locations} onSaved={() => void reload()} onClose={() => setDialog(null)} />}
            {dialog?.kind === "label" && <LabelDialog asset={a} onSaved={() => void reload()} onClose={() => setDialog(null)} />}
            {dialog?.kind === "knowledge" && <KnowledgeDialog assetId={a.id} onSaved={() => void reload()} onClose={() => setDialog(null)} />}
            {dialog?.kind === "file" && (
                <FileDialog file={dialog.file} asset={a} maintenance={detail.maintenance} onSaved={() => void reload()} onClose={() => setDialog(null)} />
            )}
            <ConfirmDialog
                isOpen={dialog?.kind === "delete"}
                onOpenChange={(o) => !o && setDialog(null)}
                title={`Delete ${a.name}?`}
                description="It disappears for everyone straight away. You can restore it from Settings for 30 days; after that its photos and documents are deleted for good."
                confirmLabel="Delete"
                destructive
                onConfirm={async () => {
                    await assetsApi.remove(a.id);
                    window.location.href = `${ASSETS}/all`;
                }}
            />
        </>
    );
};

// --- Pieces --------------------------------------------------------------------------------------

const MaintenanceList = ({
    title,
    records,
    canTasks,
    canCalendar,
    totals,
    onAdd,
    onEdit,
    onComplete,
    onTask,
    onAppointment,
    onCancel,
}: {
    title: string;
    records: MaintenanceView[];
    canTasks: boolean;
    canCalendar: boolean;
    totals?: AssetDetail["totals"];
    onAdd?: () => void;
    onEdit?: (r: MaintenanceView) => void;
    onComplete?: (r: MaintenanceView) => void;
    onTask?: (r: MaintenanceView) => void;
    onAppointment?: (r: MaintenanceView) => void;
    onCancel?: (r: MaintenanceView) => void;
}) => (
    <Card
        title={title}
        icon={title === "History" ? CheckCircle : Tool02}
        action={
            onAdd ? (
                <Button size="sm" color="secondary" iconLeading={Plus} onClick={onAdd}>
                    Add
                </Button>
            ) : totals && totals.maintenanceRecords > 0 ? (
                <span className="text-sm text-tertiary">
                    <Money cents={totals.maintenanceCostCents} /> recorded{totals.costsMissing ? `, ${totals.costsMissing} without a cost` : ""}
                </span>
            ) : undefined
        }
    >
        {records.length ? (
            <ul className="flex flex-col divide-y divide-secondary">
                {records.map((m) => (
                    <li key={m.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:px-5">
                        <div className="flex min-w-0 flex-col gap-0.5">
                            <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-primary">
                                {m.title}
                                {m.state && <DueBadge state={m.state} />}
                                {m.status !== "open" && m.status !== "completed" && (
                                    <Badge size="sm" type="color" color="gray">
                                        {MAINTENANCE_STATUS_LABELS[m.status]}
                                    </Badge>
                                )}
                                {m.priority === "urgent" && (
                                    <Badge size="sm" type="pill-color" color="error">
                                        Urgent
                                    </Badge>
                                )}
                            </span>
                            <span className="text-xs text-tertiary">
                                {[
                                    MAINTENANCE_KIND_LABELS[m.kind],
                                    m.completedOn ? `done ${shortDate(m.completedOn)}` : m.dueOn ? `due ${shortDate(m.dueOn)}` : null,
                                    m.dueKm !== null && !m.completedOn ? `or at ${m.dueKm.toLocaleString("en-AU")}` : null,
                                    m.scheduledOn && !m.completedOn
                                        ? `booked ${shortDate(m.scheduledOn)}${m.scheduledTime ? ` ${m.scheduledTime}` : ""}`
                                        : null,
                                    m.odometer !== null ? `at ${m.odometer.toLocaleString("en-AU")}` : null,
                                    m.provider,
                                    m.locationId && m.responsibility !== "owner" ? RESPONSIBILITY_LABELS[m.responsibility] : null,
                                    m.approval !== "not_needed" ? APPROVAL_LABELS[m.approval] : null,
                                ]
                                    .filter(Boolean)
                                    .join(" · ")}
                            </span>
                            {(m.completedOn || m.costCents !== null || m.costHidden) && (
                                <span className="text-xs">
                                    <Money cents={m.costCents} hidden={m.costHidden} />
                                </span>
                            )}
                            {m.task && (
                                <span className="text-xs">
                                    {m.task.available ? (
                                        <a href={`/portal/tasks/t/${m.task.taskId}`} className="text-brand-secondary hover:underline">
                                            Task: {m.task.title}
                                            {m.task.status === "completed" ? " (done in Tasks)" : ""}
                                        </a>
                                    ) : (
                                        <span className="text-tertiary">Has a task in someone else's project</span>
                                    )}
                                </span>
                            )}
                        </div>
                        {m.canEdit && onComplete && (
                            <div className="flex shrink-0 flex-wrap gap-2">
                                <Button size="xs" iconLeading={CheckCircle} onClick={() => onComplete(m)}>
                                    Done
                                </Button>
                                {canTasks && !m.task && onTask && (
                                    <Button size="xs" color="secondary" iconLeading={CheckDone01} onClick={() => onTask(m)}>
                                        Task
                                    </Button>
                                )}
                                {canCalendar && m.scheduledOn && !m.calendarEventId && onAppointment && (
                                    <Button size="xs" color="secondary" iconLeading={Calendar} onClick={() => onAppointment(m)}>
                                        Add to Calendar
                                    </Button>
                                )}
                                {onEdit && <ButtonUtility size="xs" color="tertiary" icon={Edit05} tooltip="Edit" onClick={() => onEdit(m)} />}
                                {onCancel && <ButtonUtility size="xs" color="tertiary" icon={Trash01} tooltip="Cancel" onClick={() => onCancel(m)} />}
                            </div>
                        )}
                    </li>
                ))}
            </ul>
        ) : (
            <p className="px-4 py-3 text-sm text-tertiary sm:px-5">{title === "History" ? "No completed maintenance yet." : "Nothing to do."}</p>
        )}
    </Card>
);

/** A schedule, optionally started from a template (which never brings an interval of its own). */
export const ScheduleDialog = ({
    target,
    schedule,
    isVehicle,
    household,
    onSaved,
    onClose,
}: {
    target: { assetId?: string; locationId?: string; name: string };
    schedule?: ScheduleView;
    isVehicle: boolean;
    household: Parameters<typeof TemplatePicker>[0]["household"];
    onSaved: () => void;
    onClose: () => void;
}) => {
    const [template, setTemplate] = useState<Parameters<typeof ScheduleForm>[0]["template"] | null | undefined>(schedule ? null : undefined);
    if (template === undefined)
        return (
            <PortalDialog
                isOpen
                onOpenChange={(o) => !o && onClose()}
                title="Add a recurring schedule"
                description="Templates give a title and a checklist. You enter the interval: from the manual, the service book, the manufacturer or your lease."
                icon={Tool02}
                footer={
                    <Button size="md" color="secondary" onClick={() => setTemplate(null)}>
                        Start from scratch
                    </Button>
                }
            >
                <TemplatePicker household={household} onPick={(t) => setTemplate(t)} />
            </PortalDialog>
        );
    return <ScheduleForm target={target} initial={schedule} template={template ?? undefined} isVehicle={isVehicle} onSaved={onSaved} onClose={onClose} />;
};

const Uploads = ({ assetId, canPhotos, canDocs, onDone }: { assetId: string; canPhotos: boolean; canDocs: boolean; onDone: () => void }) => {
    const [kind, setKind] = useState<AssetFileView["kind"]>(canPhotos ? "photo" : "receipt");
    const [tag, setTag] = useState<NonNullable<AssetFileView["photoTag"]>>("general");
    const [busy, setBusy] = useState(false);
    const toast = useToast();
    if (!canPhotos && !canDocs) return null;
    const upload = async (files: File[]) => {
        setBusy(true);
        for (const file of files) {
            try {
                const prepared = await prepareFile(file, kind);
                const result = await assetsApi.upload({ ...prepared, kind, assetId, ...(kind === "photo" ? { photoTag: tag } : {}) });
                toast.success(
                    result.duplicate ? "Already added" : "Added",
                    result.alsoOn.length ? `Also on ${result.alsoOn.map((x) => x.name).join(", ")}` : file.name,
                );
            } catch (e) {
                toast.error(`Couldn't add ${file.name}`, e instanceof Error ? e.message : errorMessage(e));
            }
        }
        setBusy(false);
        onDone();
    };
    const kinds = FILE_KINDS.filter((k) => (k === "photo" ? canPhotos : canDocs));
    return (
        <section aria-label="Add photos and documents" className="flex flex-col gap-3">
            <div className="flex flex-col gap-3 sm:flex-row">
                <NativeSelect
                    label="Add a"
                    value={kind}
                    onChange={(e) => setKind(e.target.value as AssetFileView["kind"])}
                    options={kinds.map((k) => ({ value: k, label: FILE_KIND_LABELS[k] }))}
                    className="sm:w-60"
                />
                {kind === "photo" && (
                    <NativeSelect
                        label="Photo of"
                        value={tag}
                        onChange={(e) => setTag(e.target.value as typeof tag)}
                        options={PHOTO_TAGS.map((t) => ({ value: t, label: PHOTO_TAG_LABELS[t] }))}
                        className="sm:w-60"
                    />
                )}
            </div>
            <FileUpload.DropZone
                hint={
                    kind === "photo" ? "JPEG, PNG or WebP. Photos are resized and their location data removed." : "PDF, photo, text, Word or Excel, up to 10 MB"
                }
                accept={kind === "photo" ? "image/*" : "image/*,application/pdf,text/plain,.docx,.xlsx"}
                isDisabled={busy}
                maxSize={10 * 1024 * 1024}
                onDropFiles={(files) => void upload(Array.from(files))}
                onSizeLimitExceed={() => toast.error("Too large", "Files can be up to 10 MB")}
            />
        </section>
    );
};

const DepreciationEditor = ({ asset, onSaved }: { asset: AssetDetail["asset"]; onSaved: () => void }) => {
    const toast = useToast();
    const d = asset.depreciation ?? { method: "none" as const };
    const [method, setMethod] = useState(d.method);
    const [years, setYears] = useState(d.method === "straight_line" ? String(d.years) : "5");
    const [residual, setResidual] = useState(d.method === "straight_line" ? String(d.residualPercent) : "0");
    const [rate, setRate] = useState(d.method === "diminishing" ? String(d.ratePercent) : "20");
    const save = async () => {
        try {
            const depreciation =
                method === "none"
                    ? { method }
                    : method === "straight_line"
                      ? { method, years: Number(years), residualPercent: Number(residual) }
                      : { method, ratePercent: Number(rate) };
            await assetsApi.update(asset.id, { version: asset.version, depreciation });
            toast.success("Saved");
            onSaved();
        } catch (e) {
            toast.error("Couldn't save", errorMessage(e));
        }
    };
    return (
        <div className="flex flex-col gap-3 border-t border-secondary px-4 py-4 sm:flex-row sm:items-end sm:px-5">
            <NativeSelect
                label="Formula estimate"
                value={method}
                onChange={(e) => setMethod(e.target.value as typeof method)}
                options={[
                    { value: "none", label: "Off" },
                    { value: "straight_line", label: "Straight line" },
                    { value: "diminishing", label: "Reducing balance" },
                ]}
                className="sm:w-48"
            />
            {method === "straight_line" && (
                <>
                    <Input label="Over (years)" value={years} onChange={setYears} inputMode="numeric" className="sm:w-28" />
                    <Input label="Down to (%)" value={residual} onChange={setResidual} inputMode="numeric" className="sm:w-28" />
                </>
            )}
            {method === "diminishing" && <Input label="By (% a year)" value={rate} onChange={setRate} inputMode="numeric" className="sm:w-32" />}
            <Button size="md" color="secondary" onClick={() => void save()}>
                Save
            </Button>
        </div>
    );
};

const MoveDialog = ({
    asset,
    locations,
    onSaved,
    onClose,
}: {
    asset: AssetDetail["asset"];
    locations: { id: string; name: string }[];
    onSaved: () => void;
    onClose: () => void;
}) => {
    const [locationId, setLocationId] = useState(asset.location?.id ?? "");
    const toast = useToast();
    return (
        <PortalDialog
            isOpen
            onOpenChange={(o) => !o && onClose()}
            title={`Where is ${asset.name} now?`}
            icon={MarkerPin01}
            onSubmit={async () => {
                try {
                    await assetsApi.move(asset.id, locationId || null);
                    toast.success("Location updated");
                    onSaved();
                } catch (e) {
                    toast.error("Couldn't update it", errorMessage(e));
                }
            }}
            footer={
                <>
                    <Button size="md" color="secondary" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button size="md" type="submit">
                        Save
                    </Button>
                </>
            }
        >
            <NativeSelect
                label="Place"
                value={locationId}
                onChange={(e) => setLocationId(e.target.value)}
                options={[{ value: "", label: "Not recorded" }, ...locations.map((l) => ({ value: l.id, label: l.name }))]}
            />
        </PortalDialog>
    );
};

const LabelDialog = ({ asset, onSaved, onClose }: { asset: AssetDetail["asset"]; onSaved: () => void; onClose: () => void }) => {
    const toast = useToast();
    return (
        <PortalDialog
            isOpen
            onOpenChange={(o) => !o && onClose()}
            title="QR label"
            description="The code opens this asset's page after signing in. It holds no name, serial number or value, and doesn't give anyone access."
            icon={QrCode02}
            footer={
                <>
                    {asset.rights.manage && (
                        <Button
                            size="md"
                            color="secondary"
                            onClick={async () => {
                                try {
                                    const { labelVersion } = await assetsApi.label(asset.id);
                                    toast.success(`Label version ${labelVersion}`, "The address is unchanged; old labels still work and show they're older.");
                                    onSaved();
                                } catch (e) {
                                    toast.error("Couldn't regenerate", errorMessage(e));
                                }
                            }}
                        >
                            New label version
                        </Button>
                    )}
                    <Button size="md" iconLeading={Printer} href={`${ASSETS}/labels?ids=${asset.id}`}>
                        Print
                    </Button>
                </>
            }
        >
            <div className="flex flex-col items-center gap-2">
                <img src={qrUrl(asset.id)} alt={`QR code for ${asset.name}`} className="size-48 rounded-lg bg-white p-2 ring-1 ring-secondary" />
                <span className="text-sm text-tertiary">Label version {asset.labelVersion}</span>
            </div>
        </PortalDialog>
    );
};

const KnowledgeDialog = ({ assetId, onSaved, onClose }: { assetId: string; onSaved: () => void; onClose: () => void }) => {
    const toast = useToast();
    const [q, setQ] = useState("");
    const [hits, setHits] = useState<{ id: string; title: string; spaceName: string }[]>([]);
    const search = async () => {
        try {
            setHits((await assetsApi.search(q)).results.knowledge ?? []);
        } catch (e) {
            toast.error("Search failed", errorMessage(e));
        }
    };
    return (
        <PortalDialog
            isOpen
            onOpenChange={(o) => !o && onClose()}
            title="Link from Daly Knowledge"
            description="Find a note, manual or guide you can open. It stays in Knowledge; this only links to it."
            icon={Link01}
            onSubmit={() => void search()}
            footer={
                <Button size="md" color="secondary" onClick={onClose}>
                    Close
                </Button>
            }
        >
            <div className="flex gap-2">
                <Input aria-label="Search Knowledge" placeholder="Search Knowledge" value={q} onChange={setQ} className="flex-1" />
                <Button size="md" type="submit">
                    Search
                </Button>
            </div>
            <ul className="flex flex-col divide-y divide-secondary">
                {hits.map((h) => (
                    <li key={h.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                        <span>
                            {h.title} <span className="text-tertiary">· {h.spaceName}</span>
                        </span>
                        <Button
                            size="xs"
                            color="secondary"
                            onClick={async () => {
                                try {
                                    await assetsApi.linkKnowledge(assetId, h.id);
                                    toast.success("Linked");
                                    onSaved();
                                } catch (e) {
                                    toast.error("Couldn't link", errorMessage(e));
                                }
                            }}
                        >
                            Link
                        </Button>
                    </li>
                ))}
            </ul>
        </PortalDialog>
    );
};

const FileDialog = ({
    file,
    asset,
    maintenance,
    onSaved,
    onClose,
}: {
    file: AssetFileView;
    asset: AssetDetail["asset"];
    maintenance: MaintenanceView[];
    onSaved: () => void;
    onClose: () => void;
}) => {
    const toast = useToast();
    const [caption, setCaption] = useState(file.caption ?? "");
    const [kind, setKind] = useState(file.kind);
    const [tag, setTag] = useState(file.photoTag ?? "general");
    const [maintenanceId, setMaintenanceId] = useState(file.maintenanceId ?? "");
    const [confirm, setConfirm] = useState(false);
    const isImage = file.contentType.startsWith("image/");
    const save = async () => {
        try {
            await assetsApi.updateFile(file.id, {
                caption: caption.trim() || null,
                kind,
                ...(kind === "photo" ? { photoTag: tag } : {}),
                maintenanceId: maintenanceId || null,
            });
            toast.success("Saved");
            onSaved();
        } catch (e) {
            toast.error("Couldn't save", errorMessage(e));
        }
    };
    return (
        <>
            <PortalDialog
                isOpen={!confirm}
                onOpenChange={(o) => !o && onClose()}
                title={file.filename}
                icon={File04}
                onSubmit={() => void save()}
                footer={
                    <>
                        <Button size="md" color="secondary-destructive" iconLeading={Trash01} onClick={() => setConfirm(true)}>
                            Delete
                        </Button>
                        {file.kind === "photo" && asset.rights.edit && asset.coverFileId !== file.id && (
                            <Button
                                size="md"
                                color="secondary"
                                onClick={async () => {
                                    await assetsApi.cover(asset.id, file.id);
                                    onSaved();
                                }}
                            >
                                Make cover
                            </Button>
                        )}
                        <Button size="md" type="submit">
                            Save
                        </Button>
                    </>
                }
            >
                <Input label="Caption" value={caption} onChange={setCaption} maxLength={300} />
                <NativeSelect
                    label="Kind"
                    value={kind}
                    onChange={(e) => setKind(e.target.value as typeof kind)}
                    options={FILE_KINDS.filter((k) => k !== "photo" || isImage).map((k) => ({ value: k, label: FILE_KIND_LABELS[k] }))}
                />
                {kind === "photo" && (
                    <NativeSelect
                        label="Photo of"
                        value={tag}
                        onChange={(e) => setTag(e.target.value as typeof tag)}
                        options={PHOTO_TAGS.map((t) => ({ value: t, label: PHOTO_TAG_LABELS[t] }))}
                    />
                )}
                {maintenance.length > 0 && (
                    <NativeSelect
                        label="For maintenance"
                        value={maintenanceId}
                        onChange={(e) => setMaintenanceId(e.target.value)}
                        options={[
                            { value: "", label: "None" },
                            ...maintenance.map((m) => ({ value: m.id, label: `${m.title}${m.completedOn ? ` (${shortDate(m.completedOn)})` : ""}` })),
                        ]}
                    />
                )}
            </PortalDialog>
            <ConfirmDialog
                isOpen={confirm}
                onOpenChange={(o) => !o && setConfirm(false)}
                title="Delete this file?"
                description="It's removed from storage straight away and can't be recovered."
                confirmLabel="Delete"
                destructive
                onConfirm={async () => {
                    await assetsApi.deleteFile(file.id);
                    toast.success("Deleted");
                    onSaved();
                }}
            />
        </>
    );
};
