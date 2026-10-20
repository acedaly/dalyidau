// Maintenance across everything: what's due (by date or odometer, whichever comes first), open work
// and requests, history, every recurring schedule, and templates. Built-in templates bring a title
// and a checklist only; the household's own templates keep the intervals it chose.
import { useState } from "react";
import { CheckCircle, CheckDone01, Download01, Plus, Tool02, Trash01 } from "@untitledui/icons";
import { Tabs } from "@/components/application/tabs/tabs";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Input } from "@/components/base/input/input";
import { NativeSelect } from "@/components/base/select/select-native";
import { DataTable } from "@/portal/components/data-table";
import { Empty } from "@/portal/components/empty";
import { useToast } from "@/portal/components/toast";
import { Card } from "@/portal/knowledge/pages/knowledge-home-page";
import { errorMessage } from "@/portal/lib/api";
import type { PageData } from "@/portal/lib/page-types";
import {
    INTERVAL_UNITS,
    MAINTENANCE_CATEGORIES,
    MAINTENANCE_CATEGORY_LABELS,
    MAINTENANCE_KIND_LABELS,
    MAINTENANCE_STATUS_LABELS,
    type MaintenanceView,
    type ScheduleView,
} from "@/shared/assets/types";
import { assetsApi, reportUrl } from "../assets-api";
import { CompleteForm, MaintenanceForm } from "../forms";
import { ASSETS, AssetsHeader, DueBadge, Money, assetHref, locationHref, shortDate } from "../shared";

type View = PageData<"assets-maintenance">["view"];
const hrefFor = (x: { assetId: string | null; locationId: string | null }) => (x.assetId ? assetHref(x.assetId, "maintenance") : locationHref(x.locationId!));

export const AssetsMaintenancePage = ({ data }: { data: PageData<"assets-maintenance"> }) => {
    const toast = useToast();
    const [view, setView] = useState<View>(data.view);
    const [records, setRecords] = useState(data.maintenance);
    const [templates, setTemplates] = useState(data.templates.household);
    const [adding, setAdding] = useState(false);
    const [completing, setCompleting] = useState<MaintenanceView | null>(null);
    // The records loaded are open ones or history; a tab that needs the other kind loads it.
    const [scope, setScope] = useState<"open" | "history">(data.view === "history" ? "history" : "open");
    const switchView = async (next: View) => {
        setView(next);
        window.history.replaceState(null, "", `${ASSETS}/maintenance${next === "upcoming" ? "" : `?view=${next}`}`);
        const needed = next === "history" ? "history" : next === "open" || next === "upcoming" ? "open" : scope;
        if (needed !== scope) {
            setRecords((await assetsApi.maintenance(needed)).maintenance);
            setScope(needed);
        }
    };
    const reload = async () => setRecords((await assetsApi.maintenance(scope)).maintenance);
    const task = async (m: MaintenanceView) => {
        try {
            const result = await assetsApi.task({ refKind: "maintenance", refId: m.id });
            toast.success(result.existing ? "That task already exists" : "Task created");
            await reload();
        } catch (e) {
            toast.error("Couldn't create the task", errorMessage(e));
        }
    };
    const upcoming = [
        ...records.filter((m) => m.state === "overdue" || m.state === "due_soon"),
        ...data.schedules
            .filter((s) => s.active && !s.openRecordId && (s.state === "overdue" || s.state === "due_soon"))
            .map((s) => ({ schedule: s }) as { schedule: ScheduleView }),
    ];

    return (
        <>
            <AssetsHeader
                title="Maintenance"
                description="Servicing, inspections, repairs and requests, worked out from the intervals you set."
                crumbs={[{ label: "Maintenance" }]}
                actions={
                    <>
                        <Button size="sm" color="secondary" iconLeading={Download01} href={reportUrl("maintenance")}>
                            Export
                        </Button>
                        {data.targets.length > 0 && (
                            <Button size="sm" iconLeading={Plus} onClick={() => setAdding(true)}>
                                Add maintenance
                            </Button>
                        )}
                    </>
                }
            />
            <Tabs selectedKey={view} onSelectionChange={(k) => void switchView(k as View)} className="gap-6">
                <Tabs.List type="underline" size="sm" aria-label="Maintenance" className="w-max max-w-full overflow-x-auto">
                    <Tabs.Item id="upcoming">Due now ({upcoming.length})</Tabs.Item>
                    <Tabs.Item id="open">All open</Tabs.Item>
                    <Tabs.Item id="history">History</Tabs.Item>
                    <Tabs.Item id="schedules">Schedules ({data.schedules.length})</Tabs.Item>
                    <Tabs.Item id="templates">Templates</Tabs.Item>
                </Tabs.List>
                <Tabs.Panel id="upcoming">
                    <Card title="Overdue and due soon" icon={Tool02}>
                        {upcoming.length ? (
                            <ul className="flex flex-col divide-y divide-secondary">
                                {upcoming.map((x) =>
                                    "schedule" in x ? (
                                        <li
                                            key={x.schedule.id}
                                            className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5"
                                        >
                                            <div className="flex flex-col">
                                                <a
                                                    href={hrefFor(x.schedule)}
                                                    className="flex flex-wrap items-center gap-2 text-sm font-medium text-primary hover:underline"
                                                >
                                                    {x.schedule.title} <span className="font-normal text-tertiary">· {x.schedule.targetName}</span>{" "}
                                                    <DueBadge state={x.schedule.state} />
                                                </a>
                                                <span className="text-xs text-tertiary">
                                                    {x.schedule.nextDueOn ? `Due ${shortDate(x.schedule.nextDueOn)}` : ""}
                                                    {x.schedule.remainingKm !== null
                                                        ? ` · ${x.schedule.remainingKm <= 0 ? "past the distance" : `${x.schedule.remainingKm.toLocaleString("en-AU")} to go`}`
                                                        : ""}
                                                </span>
                                            </div>
                                            {data.canTasks && (
                                                <Button
                                                    size="xs"
                                                    color="secondary"
                                                    iconLeading={CheckDone01}
                                                    onClick={() =>
                                                        void assetsApi
                                                            .task({ refKind: "schedule", refId: x.schedule.id })
                                                            .then(() => toast.success("Task created"))
                                                    }
                                                >
                                                    Task
                                                </Button>
                                            )}
                                        </li>
                                    ) : (
                                        <li key={x.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
                                            <div className="flex flex-col">
                                                <a
                                                    href={hrefFor(x)}
                                                    className="flex flex-wrap items-center gap-2 text-sm font-medium text-primary hover:underline"
                                                >
                                                    {x.title} <span className="font-normal text-tertiary">· {x.targetName}</span>{" "}
                                                    {x.state && <DueBadge state={x.state} />}
                                                </a>
                                                <span className="text-xs text-tertiary">
                                                    {x.dueOn
                                                        ? `Due ${shortDate(x.dueOn)}`
                                                        : x.dueKm !== null
                                                          ? `Due at ${x.dueKm.toLocaleString("en-AU")}`
                                                          : ""}
                                                </span>
                                            </div>
                                            {x.canEdit && (
                                                <div className="flex gap-2">
                                                    {data.canTasks && !x.task && (
                                                        <Button size="xs" color="secondary" iconLeading={CheckDone01} onClick={() => void task(x)}>
                                                            Task
                                                        </Button>
                                                    )}
                                                    <Button size="xs" iconLeading={CheckCircle} onClick={() => setCompleting(x)}>
                                                        Done
                                                    </Button>
                                                </div>
                                            )}
                                        </li>
                                    ),
                                )}
                            </ul>
                        ) : (
                            <p className="px-4 py-3 text-sm text-tertiary sm:px-5">Nothing is overdue or due soon.</p>
                        )}
                    </Card>
                </Tabs.Panel>
                {(["open", "history"] as const).map((v) => (
                    <Tabs.Panel key={v} id={v}>
                        <DataTable<MaintenanceView>
                            title={v === "open" ? "Open maintenance" : "Maintenance history"}
                            rows={records}
                            searchText={(m) => `${m.title} ${m.targetName} ${m.provider ?? ""}`}
                            emptyState={
                                <Empty icon={Tool02} title={v === "open" ? "Nothing open" : "No history yet"} description="Completed work appears here." />
                            }
                            initialSort={{ column: "date", direction: v === "open" ? "ascending" : "descending" }}
                            columns={[
                                {
                                    id: "title",
                                    label: "What",
                                    isRowHeader: true,
                                    sortValue: (m) => m.title,
                                    render: (m) => (
                                        <div className="flex flex-col">
                                            <a href={hrefFor(m)} className="font-medium text-primary hover:underline">
                                                {m.title}
                                            </a>
                                            <span className="text-xs text-tertiary">{m.targetName}</span>
                                        </div>
                                    ),
                                },
                                { id: "kind", label: "Kind", className: "max-md:hidden", render: (m) => MAINTENANCE_KIND_LABELS[m.kind] },
                                {
                                    id: "date",
                                    label: v === "open" ? "Due" : "Done",
                                    sortValue: (m) => (v === "open" ? m.dueOn : m.completedOn) ?? "",
                                    render: (m) => shortDate(v === "open" ? m.dueOn : m.completedOn) || "—",
                                },
                                {
                                    id: "status",
                                    label: "Status",
                                    render: (m) => (m.state ? <DueBadge state={m.state} /> : MAINTENANCE_STATUS_LABELS[m.status]),
                                },
                                { id: "cost", label: "Cost", className: "max-md:hidden", render: (m) => <Money cents={m.costCents} hidden={m.costHidden} /> },
                                {
                                    id: "act",
                                    label: "",
                                    render: (m) =>
                                        v === "open" && m.canEdit ? (
                                            <Button size="xs" iconLeading={CheckCircle} onClick={() => setCompleting(m)}>
                                                Done
                                            </Button>
                                        ) : null,
                                },
                            ]}
                        />
                    </Tabs.Panel>
                ))}
                <Tabs.Panel id="schedules">
                    <DataTable<ScheduleView>
                        title="Schedules"
                        description="Add a schedule from an asset's or a place's Maintenance tab."
                        rows={data.schedules}
                        searchText={(s) => `${s.title} ${s.targetName}`}
                        emptyState={
                            <Empty
                                icon={Tool02}
                                title="No schedules"
                                description="Open an asset and add one under Maintenance, with the interval from its manual."
                            />
                        }
                        initialSort={{ column: "next", direction: "ascending" }}
                        columns={[
                            {
                                id: "title",
                                label: "Schedule",
                                isRowHeader: true,
                                sortValue: (s) => s.title,
                                render: (s) => (
                                    <div className="flex flex-col">
                                        <a href={hrefFor(s)} className="font-medium text-primary hover:underline">
                                            {s.title}
                                        </a>
                                        <span className="text-xs text-tertiary">{s.targetName}</span>
                                    </div>
                                ),
                            },
                            {
                                id: "every",
                                label: "Every",
                                className: "max-md:hidden",
                                render: (s) =>
                                    [s.intervalCount && `${s.intervalCount} ${s.intervalUnit}`, s.intervalKm && `${s.intervalKm.toLocaleString("en-AU")} km`]
                                        .filter(Boolean)
                                        .join(" or "),
                            },
                            {
                                id: "last",
                                label: "Last done",
                                className: "max-lg:hidden",
                                sortValue: (s) => s.lastDoneOn ?? "",
                                render: (s) => shortDate(s.lastDoneOn) || "—",
                            },
                            {
                                id: "next",
                                label: "Next",
                                sortValue: (s) => s.nextDueOn ?? "9999",
                                render: (s) => shortDate(s.nextDueOn) || (s.nextDueKm !== null ? `at ${s.nextDueKm.toLocaleString("en-AU")}` : "—"),
                            },
                            { id: "state", label: "Status", render: (s) => <DueBadge state={s.state} /> },
                        ]}
                    />
                </Tabs.Panel>
                <Tabs.Panel id="templates" className="flex flex-col gap-6">
                    <TemplateEditor onSaved={setTemplates} />
                    <Card title="Your household's templates" icon={Tool02}>
                        {templates.length ? (
                            <ul className="flex flex-col divide-y divide-secondary">
                                {templates.map((t) => (
                                    <li key={t.id} className="flex items-center justify-between gap-2 px-4 py-2.5 text-sm sm:px-5">
                                        <span>
                                            <span className="font-medium text-primary">{t.title}</span>
                                            <span className="text-tertiary">
                                                {" · "}
                                                {[
                                                    t.intervalCount && `every ${t.intervalCount} ${t.intervalUnit}`,
                                                    t.intervalKm && `every ${t.intervalKm.toLocaleString("en-AU")} km`,
                                                ]
                                                    .filter(Boolean)
                                                    .join(" or ") || "no interval"}
                                            </span>
                                        </span>
                                        <ButtonUtility
                                            size="xs"
                                            color="tertiary"
                                            icon={Trash01}
                                            tooltip="Delete template"
                                            onClick={async () => {
                                                try {
                                                    setTemplates((await assetsApi.deleteTemplate(t.id)).household);
                                                } catch (e) {
                                                    toast.error("Couldn't delete it", errorMessage(e));
                                                }
                                            }}
                                        />
                                    </li>
                                ))}
                            </ul>
                        ) : (
                            <p className="px-4 py-3 text-sm text-tertiary sm:px-5">None yet. Save one with the interval your household uses.</p>
                        )}
                    </Card>
                    <Card title="Built-in templates" icon={Tool02}>
                        <ul className="flex flex-col divide-y divide-secondary">
                            {data.templates.builtin.map((t) => (
                                <li key={t.id} className="flex flex-col px-4 py-2.5 text-sm sm:px-5">
                                    <span className="font-medium text-primary">{t.title}</span>
                                    <span className="text-xs text-tertiary">No interval included. {t.intervalSource}</span>
                                </li>
                            ))}
                        </ul>
                    </Card>
                </Tabs.Panel>
            </Tabs>
            {adding && (
                <MaintenanceForm
                    targets={data.targets}
                    onSaved={(r) => {
                        setAdding(false);
                        window.location.href = hrefFor(r);
                    }}
                    onClose={() => setAdding(false)}
                />
            )}
            {completing && (
                <CompleteForm
                    record={completing}
                    today={data.today}
                    isVehicle={false}
                    onSaved={() => {
                        setCompleting(null);
                        void reload();
                    }}
                    onClose={() => setCompleting(null)}
                />
            )}
        </>
    );
};

const TemplateEditor = ({ onSaved }: { onSaved: (t: PageData<"assets-maintenance">["templates"]["household"]) => void }) => {
    const toast = useToast();
    const [title, setTitle] = useState("");
    const [category, setCategory] = useState<(typeof MAINTENANCE_CATEGORIES)[number]>("service");
    const [count, setCount] = useState("");
    const [unit, setUnit] = useState<(typeof INTERVAL_UNITS)[number]>("months");
    const [km, setKm] = useState("");
    const save = async () => {
        try {
            const result = await assetsApi.createTemplate({
                title,
                category,
                intervalCount: count ? Number(count) : null,
                intervalUnit: count ? unit : null,
                intervalKm: km ? Number(km) : null,
            });
            onSaved(result.household);
            setTitle("");
            setCount("");
            setKm("");
            toast.success("Template saved");
        } catch (e) {
            toast.error("Couldn't save it", errorMessage(e));
        }
    };
    return (
        <Card title="Save a household template" icon={Plus}>
            <form
                className="grid grid-cols-1 gap-3 px-4 py-4 sm:grid-cols-2 sm:px-5 lg:grid-cols-6 lg:items-end"
                onSubmit={(e) => {
                    e.preventDefault();
                    void save();
                }}
            >
                <Input label="Title" value={title} onChange={setTitle} isRequired className="lg:col-span-2" />
                <NativeSelect
                    label="Category"
                    value={category}
                    onChange={(e) => setCategory(e.target.value as typeof category)}
                    options={MAINTENANCE_CATEGORIES.map((c) => ({ value: c, label: MAINTENANCE_CATEGORY_LABELS[c] }))}
                />
                <Input label="Every" value={count} onChange={setCount} inputMode="numeric" />
                <NativeSelect
                    label="Unit"
                    value={unit}
                    onChange={(e) => setUnit(e.target.value as typeof unit)}
                    options={INTERVAL_UNITS.map((u) => ({ value: u, label: u }))}
                />
                <Input label="Or every (km)" value={km} onChange={setKm} inputMode="numeric" />
                <Button size="md" type="submit" className="lg:col-span-6 lg:justify-self-start">
                    Save template
                </Button>
            </form>
        </Card>
    );
};
