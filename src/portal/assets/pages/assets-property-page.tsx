// Home & property: the household's places (a home, a rental, the garage, a shed, storage, rooms),
// with rental details, inspections and maintenance requests. Responsibility at a rental is what the
// household understands from its lease, recorded per item, and never presented as the law.
import { useState } from "react";
import { Calendar, Edit05, Home02, MarkerPin01, Package, Plus, Tool02 } from "@untitledui/icons";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { Card } from "@/portal/components/card";
import { Empty } from "@/portal/components/empty";
import { Notice } from "@/portal/components/notice";
import type { PageData } from "@/portal/lib/page-types";
import { LOCATION_KIND_LABELS, type LocationView, type MaintenanceView, RESPONSIBILITY_LABELS, TENURE_LABELS } from "@/shared/assets/types";
import { assetsApi, fileUrl } from "../assets-api";
import { CompleteForm, LocationForm, MaintenanceForm } from "../forms";
import { ASSETS, AssetThumb, AssetsHeader, DateWithDistance, DueBadge, StatusBadge, VisibilityBadge, assetHref, locationHref, shortDate } from "../shared";
import { ScheduleDialog } from "./assets-item-page";

const RENTAL_NOTE =
    "Who is responsible for what at a rental depends on your lease and your state's tenancy law. Record what you understand, and check with your property manager or your state's tenancy authority before making any change: recording a request here doesn't mean it's approved.";

const LocationCard = ({ l, today }: { l: LocationView; today: string }) => (
    <li className="flex flex-col gap-3 rounded-xl bg-primary p-4 shadow-xs ring-1 ring-secondary ring-inset">
        <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-0.5">
                <a href={locationHref(l.id)} className="truncate text-md font-semibold text-primary hover:underline">
                    {l.name}
                </a>
                <span className="text-sm text-tertiary">
                    {LOCATION_KIND_LABELS[l.kind]}
                    {l.tenure ? ` · ${TENURE_LABELS[l.tenure]}` : ""}
                    {l.parentName ? ` · in ${l.parentName}` : ""}
                </span>
            </div>
            <VisibilityBadge visibility={l.visibility === "household" ? "household" : "private"} />
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-tertiary">
            <span>{l.assetCount} assets</span>
            {l.openMaintenance > 0 && <span>{l.openMaintenance} open maintenance</span>}
            {l.leaseEnd && (
                <span>
                    Lease ends <DateWithDistance date={l.leaseEnd} today={today} />
                </span>
            )}
            {l.nextInspectionOn && (
                <span>
                    Inspection <DateWithDistance date={l.nextInspectionOn} today={today} />
                </span>
            )}
        </div>
    </li>
);

export const AssetsPropertyPage = ({ data }: { data: PageData<"assets-property"> }) => {
    const [adding, setAdding] = useState(false);
    const properties = data.places.filter((l) => !l.parentId);
    const rooms = data.places.filter((l) => l.parentId);
    const rental = data.places.some((l) => l.tenure === "renting" || l.kind === "rental");
    return (
        <>
            <AssetsHeader
                title="Home & property"
                description="Your places, what's in them, inspections, leases and maintenance requests."
                crumbs={[{ label: "Home & property" }]}
                actions={
                    <Button size="sm" iconLeading={Plus} onClick={() => setAdding(true)}>
                        Add a place
                    </Button>
                }
            />
            {rental && <Notice title="Renting">{RENTAL_NOTE}</Notice>}
            {data.places.length === 0 ? (
                <Empty
                    icon={Home02}
                    title="No places yet"
                    description="Add your home, a rental, the garage or a shed, then put assets in them."
                    actions={
                        <Button size="md" iconLeading={Plus} onClick={() => setAdding(true)}>
                            Add a place
                        </Button>
                    }
                />
            ) : (
                <>
                    <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                        {properties.map((l) => (
                            <LocationCard key={l.id} l={l} today={data.today} />
                        ))}
                    </ul>
                    {rooms.length > 0 && (
                        <Card title="Rooms and areas" icon={MarkerPin01}>
                            <ul className="flex flex-col divide-y divide-secondary">
                                {rooms.map((l) => (
                                    <li key={l.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm sm:px-5">
                                        <a href={locationHref(l.id)} className="font-medium text-primary hover:underline">
                                            {l.name}
                                        </a>
                                        <span className="text-tertiary">
                                            {l.parentName} · {l.assetCount} assets
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        </Card>
                    )}
                    <Card title="Open maintenance at your places" icon={Tool02}>
                        {data.maintenance.length ? (
                            <ul className="flex flex-col divide-y divide-secondary">
                                {data.maintenance.map((m) => (
                                    <li key={m.id} className="flex flex-col px-4 py-2.5 sm:px-5">
                                        <a href={locationHref(m.locationId!)} className="text-sm font-medium text-primary hover:underline">
                                            {m.title} <span className="font-normal text-tertiary">· {m.targetName}</span>
                                        </a>
                                        <span className="text-xs text-tertiary">
                                            {[
                                                RESPONSIBILITY_LABELS[m.responsibility],
                                                m.dueOn && `due ${shortDate(m.dueOn)}`,
                                                m.status === "requested" && "requested",
                                            ]
                                                .filter(Boolean)
                                                .join(" · ")}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        ) : (
                            <p className="px-4 py-3 text-sm text-tertiary sm:px-5">Nothing open.</p>
                        )}
                    </Card>
                </>
            )}
            {adding && (
                <LocationForm
                    locations={data.places}
                    onSaved={(l) => {
                        window.location.href = locationHref(l.id);
                    }}
                    onClose={() => setAdding(false)}
                />
            )}
        </>
    );
};

export const AssetsLocationPage = ({ data }: { data: PageData<"assets-location"> }) => {
    const [l, setL] = useState(data.location);
    const [records, setRecords] = useState(data.maintenance);
    const [dialog, setDialog] = useState<null | "edit" | "maintenance" | "schedule" | { complete: MaintenanceView }>(null);
    const reload = async () => {
        const [location, maintenance] = await Promise.all([assetsApi.locations(true), assetsApi.maintenance("all")]);
        setL(location.locations.find((x) => x.id === l.id) ?? l);
        setRecords(maintenance.maintenance.filter((m) => m.locationId === l.id));
        setDialog(null);
    };
    const open = records.filter((m) => !["completed", "cancelled"].includes(m.status));
    const done = records.filter((m) => m.status === "completed");
    return (
        <>
            <AssetsHeader
                title={l.name}
                description={
                    <span className="flex flex-wrap items-center gap-2">
                        {LOCATION_KIND_LABELS[l.kind]}
                        {l.tenure && (
                            <Badge size="sm" type="color" color="gray">
                                {TENURE_LABELS[l.tenure]}
                            </Badge>
                        )}
                        <VisibilityBadge visibility={l.visibility === "household" ? "household" : "private"} />
                    </span>
                }
                crumbs={[{ label: "Home & property", href: `${ASSETS}/property` }, { label: l.name }]}
                actions={
                    l.canEdit ? (
                        <>
                            <Button size="sm" color="secondary" iconLeading={Edit05} onClick={() => setDialog("edit")}>
                                Edit
                            </Button>
                            <Button size="sm" iconLeading={Plus} onClick={() => setDialog("maintenance")}>
                                Add maintenance
                            </Button>
                        </>
                    ) : (
                        <span />
                    )
                }
            />
            {(l.tenure === "renting" || l.kind === "rental") && <Notice title="Renting">{RENTAL_NOTE}</Notice>}
            <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
                <div className="flex flex-col gap-6 xl:col-span-2">
                    <Card
                        title="Maintenance and requests"
                        icon={Tool02}
                        action={
                            l.canEdit && (
                                <Button size="sm" color="secondary" iconLeading={Calendar} onClick={() => setDialog("schedule")}>
                                    Add schedule
                                </Button>
                            )
                        }
                    >
                        {data.schedules.length > 0 && (
                            <ul className="flex flex-col divide-y divide-secondary border-b border-secondary">
                                {data.schedules.map((s) => (
                                    <li key={s.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm sm:px-5">
                                        <span className="font-medium text-primary">{s.title}</span>
                                        <DueBadge state={s.state} />
                                        <span className="text-tertiary">
                                            {s.intervalCount ? `every ${s.intervalCount} ${s.intervalUnit}` : ""}
                                            {s.nextDueOn ? ` · next ${shortDate(s.nextDueOn)}` : ""} · {RESPONSIBILITY_LABELS[s.responsibility]}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        )}
                        {open.length ? (
                            <ul className="flex flex-col divide-y divide-secondary">
                                {open.map((m) => (
                                    <li key={m.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
                                        <div className="flex flex-col">
                                            <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-primary">
                                                {m.title} {m.state && <DueBadge state={m.state} />}
                                            </span>
                                            <span className="text-xs text-tertiary">
                                                {[
                                                    RESPONSIBILITY_LABELS[m.responsibility],
                                                    m.requestReference && `ref ${m.requestReference}`,
                                                    m.requestedOn && `requested ${shortDate(m.requestedOn)}`,
                                                    m.approval !== "not_needed" && m.approval,
                                                ]
                                                    .filter(Boolean)
                                                    .join(" · ")}
                                            </span>
                                        </div>
                                        {m.canEdit && (
                                            <Button size="xs" onClick={() => setDialog({ complete: m })}>
                                                Done
                                            </Button>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        ) : (
                            <p className="px-4 py-3 text-sm text-tertiary sm:px-5">Nothing open.</p>
                        )}
                        {done.length > 0 && <p className="border-t border-secondary px-4 py-2.5 text-xs text-tertiary sm:px-5">{done.length} completed</p>}
                    </Card>
                    <Card title="What's here" icon={Package}>
                        {data.assets.length ? (
                            <ul className="flex flex-col divide-y divide-secondary">
                                {data.assets.map((a) => (
                                    <li key={a.id} className="flex items-center gap-3 px-4 py-2.5 sm:px-5">
                                        <AssetThumb asset={a} size="sm" />
                                        <a href={assetHref(a.id)} className="min-w-0 flex-1 truncate text-sm font-medium text-primary hover:underline">
                                            {a.name}
                                        </a>
                                        <StatusBadge status={a.status} />
                                    </li>
                                ))}
                            </ul>
                        ) : (
                            <p className="px-4 py-3 text-sm text-tertiary sm:px-5">
                                No assets recorded here. Choose this place when adding or moving an asset.
                            </p>
                        )}
                    </Card>
                </div>
                <div className="flex flex-col gap-6">
                    <Card title="Details" icon={Home02}>
                        <dl className="flex flex-col divide-y divide-secondary px-4 py-1 text-sm sm:px-5">
                            {[
                                ["Address", l.address],
                                ["Lease", l.leaseStart || l.leaseEnd ? `${shortDate(l.leaseStart) || "?"} to ${shortDate(l.leaseEnd) || "?"}` : null],
                                ["Property manager", [l.managerName, l.managerPhone, l.managerEmail].filter(Boolean).join(" · ") || null],
                                ["Next inspection", l.nextInspectionOn ? shortDate(l.nextInspectionOn) : null],
                                ["Utilities", l.utilities],
                                ["Notes", l.notes],
                                ["Added by", l.mine ? "You" : (l.owner.name ?? l.owner.email)],
                            ].map(([label, value]) => (
                                <div key={label} className="flex flex-col py-2">
                                    <dt className="text-tertiary">{label}</dt>
                                    <dd className="whitespace-pre-line text-primary">{value ?? <span className="text-quaternary">Not recorded</span>}</dd>
                                </div>
                            ))}
                        </dl>
                    </Card>
                    {data.files.length > 0 && (
                        <Card title="Documents" icon={Package}>
                            <ul className="flex flex-col divide-y divide-secondary">
                                {data.files.map((f) => (
                                    <li key={f.id} className="px-4 py-2 text-sm sm:px-5">
                                        <a href={fileUrl(f.id)} className="text-primary hover:underline">
                                            {f.caption ?? f.filename}
                                        </a>
                                    </li>
                                ))}
                            </ul>
                        </Card>
                    )}
                </div>
            </div>
            {dialog === "edit" && <LocationForm initial={l} locations={data.locations} onSaved={() => void reload()} onClose={() => setDialog(null)} />}
            {dialog === "maintenance" && (
                <MaintenanceForm target={{ locationId: l.id, name: l.name, financial: true }} onSaved={() => void reload()} onClose={() => setDialog(null)} />
            )}
            {dialog === "schedule" && (
                <ScheduleDialog
                    target={{ locationId: l.id, name: l.name }}
                    isVehicle={false}
                    household={[]}
                    onSaved={() => void reload()}
                    onClose={() => setDialog(null)}
                />
            )}
            {dialog && typeof dialog === "object" && (
                <CompleteForm record={dialog.complete} today={data.today} isVehicle={false} onSaved={() => void reload()} onClose={() => setDialog(null)} />
            )}
        </>
    );
};
