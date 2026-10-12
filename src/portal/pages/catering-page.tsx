import { useState } from "react";
import { AlertTriangle, ChevronDown, Download01, Plus, Printer, Settings01, Trash01, Users01 } from "@untitledui/icons";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Dropdown } from "@/components/base/dropdown/dropdown";
import { Input } from "@/components/base/input/input";
import { Select } from "@/components/base/select/select";
import { TextArea } from "@/components/base/textarea/textarea";
import { type DataColumn, DataTable } from "@/portal/components/data-table";
import { PortalDialog } from "@/portal/components/dialog";
import { Empty } from "@/portal/components/empty";
import { FormError, useSubmit } from "@/portal/components/form";
import { MetricCard } from "@/portal/components/metric-card";
import { Notice } from "@/portal/components/notice";
import { PageHeader } from "@/portal/components/page-header";
import { useToast } from "@/portal/components/toast";
import { api, errorMessage } from "@/portal/lib/api";
import { pluralise } from "@/portal/lib/format";
import type { PageData } from "@/portal/lib/page-types";
import { usePortal } from "@/portal/portal-context";
import type { CateringGuest, CateringSettings, CateringSummary, MealCategory } from "@/shared/portal/types";

const AGE = { adult: "Adult", child: "Child", infant: "Infant" } as const;

const slugId = (label: string, taken: string[]) => {
    const base =
        label
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "_")
            .replace(/^_|_$/g, "")
            .slice(0, 30) || "category";
    let id = base;
    for (let n = 2; taken.includes(id); n++) id = `${base}_${n}`;
    return id;
};

export const CateringPage = ({ data }: { data: PageData<"catering"> }) => {
    const { can } = usePortal();
    const toast = useToast();
    const [summary, setSummary] = useState<CateringSummary>(data.summary);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [draft, setDraft] = useState<CateringSettings>(data.summary.settings);
    const canEdit = can("wedding.planning.edit");
    const { settings } = summary;
    const label = new Map(settings.categories.map((c) => [c.id, c.label]));
    const totalMeals = summary.byCategory.filter((c) => c.id !== "no_meal").reduce((n, c) => n + c.attending, 0);
    const undecided = summary.guests.filter((g) => g.category === null);
    const dietary = summary.guests.filter((g) => g.dietary || g.allergies);

    const refresh = async () => setSummary(await api<CateringSummary>("GET", "/api/portal/wedding/catering"));

    const setMeal = async (ids: string[], mealCategory: string | null) => {
        try {
            await api("POST", "/api/portal/wedding/guests/bulk", { action: "set-meal", ids, mealCategory });
            await refresh();
            toast.success("Meal updated", pluralise(ids.length, "guest"));
        } catch (error) {
            toast.error("Couldn't update", errorMessage(error));
        }
    };

    const saveSettings = useSubmit(() => api<{ value: CateringSettings }>("PUT", "/api/portal/settings/catering", draft), {
        success: "Catering settings saved",
        onSuccess: async () => {
            await refresh();
            setSettingsOpen(false);
        },
    });

    const setCategory = (index: number, patch: Partial<MealCategory>) =>
        setDraft({ ...draft, categories: draft.categories.map((c, i) => (i === index ? { ...c, ...patch } : c)) });

    const mealSelect = (g: CateringGuest) => (
        <Select
            aria-label={`Meal for ${g.name}`}
            size="sm"
            className="w-48"
            isDisabled={!canEdit}
            items={[
                { id: "__none", label: g.ageGroup === "adult" && settings.adultDefault ? `Default (${label.get(settings.adultDefault)})` : "Needs a decision" },
                ...settings.categories
                    .filter((c) => c.appliesTo === "any" || c.appliesTo === (g.ageGroup === "adult" ? "adult" : "child"))
                    .map((c) => ({ id: c.id, label: c.label })),
            ]}
            value={g.chosen ? (g.category ?? "__none") : "__none"}
            onChange={(v) => setMeal([g.id], v === "__none" ? null : String(v))}
        >
            {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
        </Select>
    );

    const guestColumns: DataColumn<CateringGuest>[] = [
        {
            id: "name",
            label: "Guest",
            isRowHeader: true,
            sortValue: (g) => g.name,
            render: (g) => (
                <div>
                    <p className="font-medium text-primary">{g.name}</p>
                    <p className="text-tertiary">{[AGE[g.ageGroup], g.householdName].filter(Boolean).join(" · ")}</p>
                </div>
            ),
        },
        {
            id: "status",
            label: "RSVP",
            sortValue: (g) => g.status,
            render: (g) => (
                <Badge size="sm" type="pill-color" color={g.status === "attending" ? "success" : "warning"}>
                    {g.status === "attending" ? "Attending" : "Awaiting reply"}
                </Badge>
            ),
            className: "max-md:hidden",
        },
        { id: "meal", label: "Meal", sortValue: (g) => (g.category ? label.get(g.category) : ""), render: mealSelect },
        {
            id: "table",
            label: "Table",
            sortValue: (g) => g.tableName,
            render: (g) => g.tableName ?? <span className="text-quaternary">—</span>,
            className: "max-lg:hidden",
        },
    ];

    const dietaryColumns: DataColumn<CateringGuest>[] = [
        { id: "name", label: "Guest", isRowHeader: true, sortValue: (g) => g.name, render: (g) => <span className="font-medium text-primary">{g.name}</span> },
        {
            id: "needs",
            label: "Requirements",
            render: (g) => (
                <div className="flex flex-col gap-1">
                    {g.dietary && <span className="text-secondary">{g.dietary}</span>}
                    {g.allergies && (
                        <span className="flex items-center gap-1 font-medium text-error-primary">
                            <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
                            Allergy: {g.allergies}
                        </span>
                    )}
                </div>
            ),
        },
        {
            id: "meal",
            label: "Meal",
            sortValue: (g) => (g.category ? label.get(g.category) : ""),
            render: (g) => (g.category ? label.get(g.category) : "Needs a decision"),
        },
        { id: "table", label: "Table", sortValue: (g) => g.tableName, render: (g) => g.tableName ?? "—", className: "max-md:hidden" },
        {
            id: "status",
            label: "RSVP",
            sortValue: (g) => g.status,
            render: (g) => (g.status === "attending" ? "Attending" : "Awaiting"),
            className: "max-lg:hidden",
        },
    ];

    return (
        <>
            <PageHeader
                title="Catering"
                description={
                    summary.event
                        ? `For the ${summary.event.name}. Every number comes from the guest list and RSVPs.`
                        : "Add the reception as an event to see catering numbers."
                }
                breadcrumbs={[{ label: "Catering" }]}
                actions={
                    <>
                        <Dropdown.Root>
                            <Button color="secondary" iconLeading={Download01} iconTrailing={ChevronDown}>
                                Print or export
                            </Button>
                            <Dropdown.Popover className="w-56">
                                <Dropdown.Menu
                                    onAction={(key) => (key === "print" ? window.print() : window.location.assign(`/api/portal/export/${String(key)}.csv`))}
                                >
                                    <Dropdown.Item id="print" icon={Printer} label="Print summary" />
                                    <Dropdown.Item id="catering" icon={Download01} label="Catering list (CSV)" />
                                    <Dropdown.Item id="seating" icon={Download01} label="Seating plan (CSV)" />
                                </Dropdown.Menu>
                            </Dropdown.Popover>
                        </Dropdown.Root>
                        {canEdit && (
                            <Button
                                color="secondary"
                                iconLeading={Settings01}
                                onClick={() => {
                                    setDraft(settings);
                                    setSettingsOpen(true);
                                }}
                            >
                                Meal categories
                            </Button>
                        )}
                    </>
                }
            />

            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4 lg:gap-6">
                <MetricCard
                    label="Adults attending"
                    icon={Users01}
                    value={summary.attending.adults}
                    detail={summary.awaiting.adults ? `+${summary.awaiting.adults} awaiting reply` : undefined}
                />
                <MetricCard
                    label="Children attending"
                    value={summary.attending.children}
                    detail={summary.awaiting.children ? `+${summary.awaiting.children} awaiting reply` : undefined}
                />
                <MetricCard
                    label="Infants attending"
                    value={summary.attending.infants}
                    detail={summary.awaiting.infants ? `+${summary.awaiting.infants} awaiting reply` : undefined}
                />
                <MetricCard
                    label="Meals to cater"
                    value={totalMeals}
                    detail={summary.undecided ? `${pluralise(summary.undecided, "guest")} still to decide` : "All decided"}
                />
            </div>

            {summary.undecided > 0 && (
                <Notice color="warning" title={`${pluralise(summary.undecided, "attending child", "attending children")} without a meal choice`}>
                    Some children eat the adult buffet and some have a children's meal, so nobody is counted until you choose. Set each one in the list below.
                </Notice>
            )}

            <section aria-labelledby="by-meal" className="flex flex-col gap-4 rounded-xl bg-primary p-5 shadow-xs ring-1 ring-secondary ring-inset">
                <h2 id="by-meal" className="text-md font-semibold text-primary">
                    By meal
                </h2>
                <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                        <thead className="text-xs text-quaternary">
                            <tr className="border-b border-secondary">
                                <th scope="col" className="py-2 pr-4 font-semibold">
                                    Meal
                                </th>
                                <th scope="col" className="py-2 pr-4 text-right font-semibold">
                                    Confirmed
                                </th>
                                <th scope="col" className="py-2 pr-4 text-right font-semibold">
                                    If everyone awaiting comes
                                </th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-secondary">
                            {summary.byCategory.map((c) => (
                                <tr key={c.id}>
                                    <th scope="row" className="py-2.5 pr-4 font-medium text-primary">
                                        {c.label}
                                        {settings.adultDefault === c.id && <span className="ml-2 text-xs font-normal text-tertiary">(adults by default)</span>}
                                    </th>
                                    <td className="py-2.5 pr-4 text-right text-secondary tabular-nums">{c.attending}</td>
                                    <td className="py-2.5 pr-4 text-right text-tertiary tabular-nums">{c.attending + c.awaiting}</td>
                                </tr>
                            ))}
                            {summary.undecided > 0 && (
                                <tr>
                                    <th scope="row" className="py-2.5 pr-4 font-medium text-warning-primary">
                                        Needs a decision
                                    </th>
                                    <td className="py-2.5 pr-4 text-right text-warning-primary tabular-nums">{summary.undecided}</td>
                                    <td className="py-2.5 pr-4 text-right text-tertiary tabular-nums">{undecided.length}</td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
                {settings.notes && (
                    <div className="rounded-lg bg-secondary p-4">
                        <p className="text-xs font-semibold text-tertiary uppercase">Notes for the caterer</p>
                        <p className="mt-1 text-sm whitespace-pre-line text-secondary">{settings.notes}</p>
                    </div>
                )}
            </section>

            <DataTable
                title="Dietary requirements and allergies"
                description="Attending guests and those still to reply."
                rows={dietary}
                columns={dietaryColumns}
                searchText={(g) => `${g.name} ${g.dietary ?? ""} ${g.allergies ?? ""}`}
                initialSort={{ column: "table", direction: "ascending" }}
                emptyState={<Empty icon={Users01} title="No dietary requirements yet" description="Requirements come from guest records and online RSVPs." />}
            />

            <div className="print:hidden">
                <DataTable
                    title="Meals"
                    description="Choose each guest's meal. Adults left on the default count towards it; children are only counted once chosen."
                    rows={summary.guests}
                    columns={guestColumns}
                    searchText={(g) => `${g.name} ${g.householdName ?? ""}`}
                    initialSort={{ column: "meal", direction: "ascending" }}
                    selectable={canEdit}
                    bulkActions={(ids, clear) => (
                        <Dropdown.Root>
                            <Button size="sm" color="secondary" iconTrailing={ChevronDown}>
                                Set meal
                            </Button>
                            <Dropdown.Popover className="w-56">
                                <Dropdown.Menu
                                    onAction={async (key) => {
                                        await setMeal(ids, key === "__none" ? null : String(key));
                                        clear();
                                    }}
                                >
                                    {settings.categories.map((c) => (
                                        <Dropdown.Item key={c.id} id={c.id} label={c.label} />
                                    ))}
                                    <Dropdown.Item id="__none" label="Clear the choice" />
                                </Dropdown.Menu>
                            </Dropdown.Popover>
                        </Dropdown.Root>
                    )}
                    emptyState={
                        <Empty
                            icon={Users01}
                            title="Nobody to cater for yet"
                            description="Guests appear here once they're invited to the meal event and haven't declined."
                        />
                    }
                />
            </div>

            <PortalDialog
                isOpen={settingsOpen}
                onOpenChange={setSettingsOpen}
                title="Meal categories"
                description="The meals the caterer is providing. Children are never put in a category automatically."
                icon={Settings01}
                size="lg"
                onSubmit={saveSettings.submit}
                footer={
                    <>
                        <Button color="secondary" size="lg" onClick={() => setSettingsOpen(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" size="lg" isLoading={saveSettings.busy} showTextWhileLoading>
                            Save
                        </Button>
                    </>
                }
            >
                <FormError message={saveSettings.error?.message} />
                <Select
                    label="Meal event"
                    items={[{ id: "__auto", label: "Automatic (the reception)" }, ...data.events.map((e) => ({ id: e.id, label: e.name }))]}
                    value={draft.eventId ?? "__auto"}
                    onChange={(v) => setDraft({ ...draft, eventId: v === "__auto" ? null : String(v) })}
                    hint="Catering and seating count the guests attending this event."
                >
                    {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                </Select>
                <div className="flex flex-col gap-3">
                    {draft.categories.map((c, i) => (
                        <div key={c.id} className="flex flex-col gap-3 rounded-xl bg-secondary p-3 sm:flex-row sm:items-end">
                            <Input label="Meal" value={c.label} onChange={(v) => setCategory(i, { label: v })} className="flex-1" isRequired />
                            <Select
                                label="For"
                                className="sm:w-36"
                                items={[
                                    { id: "any", label: "Anyone" },
                                    { id: "adult", label: "Adults" },
                                    { id: "child", label: "Children" },
                                ]}
                                value={c.appliesTo}
                                onChange={(v) => setCategory(i, { appliesTo: v as MealCategory["appliesTo"] })}
                            >
                                {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                            </Select>
                            <ButtonUtility
                                size="sm"
                                color="tertiary"
                                icon={Trash01}
                                tooltip="Remove"
                                isDisabled={draft.categories.length === 1}
                                onClick={() =>
                                    setDraft({
                                        ...draft,
                                        categories: draft.categories.filter((_, j) => j !== i),
                                        adultDefault: draft.adultDefault === c.id ? null : draft.adultDefault,
                                    })
                                }
                            />
                        </div>
                    ))}
                    <div>
                        <Button
                            size="sm"
                            color="secondary"
                            iconLeading={Plus}
                            onClick={() =>
                                setDraft({
                                    ...draft,
                                    categories: [
                                        ...draft.categories,
                                        {
                                            id: slugId(
                                                "New meal",
                                                draft.categories.map((c) => c.id),
                                            ),
                                            label: "New meal",
                                            description: "",
                                            appliesTo: "any",
                                        },
                                    ],
                                })
                            }
                        >
                            Add a meal
                        </Button>
                    </div>
                </div>
                <Select
                    label="Adults default to"
                    items={[
                        { id: "__none", label: "Nothing (choose for everyone)" },
                        ...draft.categories.filter((c) => c.appliesTo !== "child").map((c) => ({ id: c.id, label: c.label })),
                    ]}
                    value={draft.adultDefault ?? "__none"}
                    onChange={(v) => setDraft({ ...draft, adultDefault: v === "__none" ? null : String(v) })}
                >
                    {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                </Select>
                <TextArea
                    label="Notes for the caterer"
                    rows={4}
                    value={draft.notes}
                    onChange={(v) => setDraft({ ...draft, notes: v })}
                    hint="Printed with the catering summary."
                />
            </PortalDialog>
        </>
    );
};
