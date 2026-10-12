import { useMemo, useState } from "react";
import { BankNote01, Coins03, Download01, Plus, Settings01, Wallet02 } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { ProgressBar } from "@/components/base/progress-indicators/progress-indicators";
import { Select } from "@/components/base/select/select";
import { TextArea } from "@/components/base/textarea/textarea";
import { type DataColumn, DataTable } from "@/portal/components/data-table";
import { DateField } from "@/portal/components/date-field";
import { PortalDialog } from "@/portal/components/dialog";
import { Empty } from "@/portal/components/empty";
import { EntityPanel } from "@/portal/components/entity-panel";
import { FormGrid, FullWidth, useSubmit } from "@/portal/components/form";
import { MetricCard } from "@/portal/components/metric-card";
import { PageHeader } from "@/portal/components/page-header";
import { PaymentBadge } from "@/portal/components/status";
import { useCollection } from "@/portal/hooks/use-collection";
import { ApiError, api } from "@/portal/lib/api";
import { formatDate, formatMoney, parseMoney, percent, todayIso } from "@/portal/lib/format";
import type { PageData } from "@/portal/lib/page-types";
import { usePortal } from "@/portal/portal-context";
import type { BudgetItem, BudgetSettings, PaymentState } from "@/shared/portal/types";

export const amountOf = (item: Pick<BudgetItem, "actualCents" | "estimatedCents">) => item.actualCents ?? item.estimatedCents;

export const paymentState = (item: BudgetItem, today: string): PaymentState => {
    const amount = amountOf(item);
    if (amount > 0 && item.paidCents >= amount) return "paid";
    if (item.dueDate && item.dueDate < today) return "overdue";
    return item.paidCents > 0 ? "partial" : "unpaid";
};

interface Draft {
    category: string;
    description: string;
    supplierId: string | null;
    estimated: string;
    actual: string;
    paid: string;
    dueDate: string | null;
    notes: string;
}

const centsText = (cents: number | null) => (cents === null ? "" : (cents / 100).toFixed(2));

export const BudgetPage = ({ data }: { data: PageData<"budget"> }) => {
    const { can, wedding } = usePortal();
    const items = useCollection<BudgetItem>("budget-items", data.items);
    const [settings, setSettings] = useState<BudgetSettings>(data.settings);
    const [editing, setEditing] = useState<BudgetItem | null>(null);
    const [open, setOpen] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [totalText, setTotalText] = useState(centsText(data.settings.totalCents));
    const [draft, setDraft] = useState<Draft>({
        category: "",
        description: "",
        supplierId: null,
        estimated: "",
        actual: "",
        paid: "",
        dueDate: null,
        notes: "",
    });
    const canEdit = can("wedding.budget.edit");
    const today = todayIso(wedding.timeZone);
    const money = (cents: number | null) => formatMoney(cents, settings.currency);

    const totals = useMemo(() => {
        const committed = items.items.reduce((sum, i) => sum + amountOf(i), 0);
        const paid = items.items.reduce((sum, i) => sum + i.paidCents, 0);
        const overdue = items.items.filter((i) => paymentState(i, today) === "overdue").reduce((sum, i) => sum + Math.max(amountOf(i) - i.paidCents, 0), 0);
        const categories = new Map<string, { committed: number; paid: number }>();
        for (const i of items.items) {
            const c = categories.get(i.category) ?? { committed: 0, paid: 0 };
            categories.set(i.category, { committed: c.committed + amountOf(i), paid: c.paid + i.paidCents });
        }
        return {
            committed,
            paid,
            outstanding: Math.max(committed - paid, 0),
            overdue,
            categories: [...categories].sort((a, b) => b[1].committed - a[1].committed),
        };
    }, [items.items, today]);

    const categories = [...new Set(items.items.map((i) => i.category))].sort();

    const openPanel = (item: BudgetItem | null) => {
        setEditing(item);
        setDraft({
            category: item?.category ?? "",
            description: item?.description ?? "",
            supplierId: item?.supplierId ?? null,
            estimated: centsText(item?.estimatedCents ?? null),
            actual: centsText(item?.actualCents ?? null),
            paid: centsText(item?.paidCents ?? null),
            dueDate: item?.dueDate ?? null,
            notes: item?.notes ?? "",
        });
        setOpen(true);
    };

    const toPayload = () => {
        const estimated = parseMoney(draft.estimated);
        const actual = parseMoney(draft.actual);
        const paid = parseMoney(draft.paid);
        const bad = [
            ["estimatedCents", estimated],
            ["actualCents", actual],
            ["paidCents", paid],
        ].find(([, v]) => Number.isNaN(v));
        if (bad)
            throw new ApiError(422, "validation", "Amounts must be numbers like 1250 or 1,250.00", [
                { path: bad[0] as string, message: "Enter an amount like 1250.00" },
            ]);
        return { ...draft, estimatedCents: estimated ?? 0, actualCents: actual, paidCents: paid ?? 0, notes: draft.notes || null };
    };

    const saveSettings = useSubmit(
        async () => {
            const total = parseMoney(totalText);
            if (Number.isNaN(total)) throw new ApiError(422, "validation", "Enter an amount", [{ path: "totalCents", message: "Enter an amount like 40000" }]);
            return api<{ value: BudgetSettings }>("PUT", "/api/portal/settings/budget", { ...settings, totalCents: total ?? 0 });
        },
        {
            success: "Budget updated",
            onSuccess: ({ value }) => {
                setSettings(value);
                setSettingsOpen(false);
            },
        },
    );

    const columns: DataColumn<BudgetItem>[] = [
        {
            id: "description",
            label: "Item",
            isRowHeader: true,
            sortValue: (i) => i.description,
            render: (i) => (
                <div className="min-w-0">
                    <p className="font-medium text-primary">{i.description}</p>
                    <p className="text-tertiary">{[i.category, i.supplierName].filter(Boolean).join(" · ")}</p>
                </div>
            ),
        },
        {
            id: "amount",
            label: "Amount",
            sortValue: (i) => amountOf(i),
            render: (i) => <span className="tabular-nums">{money(amountOf(i))}</span>,
            tooltip: "The actual cost once known, otherwise the estimate.",
        },
        {
            id: "paid",
            label: "Paid",
            sortValue: (i) => i.paidCents,
            render: (i) => <span className="tabular-nums">{money(i.paidCents)}</span>,
            className: "max-md:hidden",
        },
        { id: "state", label: "Payment", sortValue: (i) => paymentState(i, today), render: (i) => <PaymentBadge state={paymentState(i, today)} /> },
        {
            id: "due",
            label: "Due",
            sortValue: (i) => i.dueDate,
            render: (i) => (i.dueDate ? formatDate(i.dueDate) : <span className="text-quaternary">—</span>),
            className: "max-lg:hidden",
        },
    ];

    return (
        <>
            <PageHeader
                title="Budget"
                description="Estimates, actual costs and payments."
                breadcrumbs={[{ label: "Budget" }]}
                actions={
                    <>
                        {can("wedding.budget.view") && items.items.length > 0 && (
                            <Button color="secondary" iconLeading={Download01} href="/api/portal/export/budget.csv" download>
                                Export
                            </Button>
                        )}
                        {canEdit && (
                            <>
                                <Button color="secondary" iconLeading={Settings01} onClick={() => setSettingsOpen(true)}>
                                    Total budget
                                </Button>
                                <Button iconLeading={Plus} onClick={() => openPanel(null)}>
                                    Add item
                                </Button>
                            </>
                        )}
                    </>
                }
            />

            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 xl:grid-cols-4">
                <MetricCard
                    label="Total budget"
                    icon={Wallet02}
                    value={settings.totalCents ? formatMoney(settings.totalCents, settings.currency, { whole: true }) : "Not set"}
                    progress={settings.totalCents ? Math.min(percent(totals.committed, settings.totalCents), 100) : undefined}
                    progressLabel={settings.totalCents ? `${percent(totals.committed, settings.totalCents)}% committed` : undefined}
                />
                <MetricCard
                    label="Committed"
                    icon={Coins03}
                    value={formatMoney(totals.committed, settings.currency, { whole: true })}
                    detail="Actual cost, or the estimate"
                />
                <MetricCard
                    label="Paid"
                    icon={BankNote01}
                    value={formatMoney(totals.paid, settings.currency, { whole: true })}
                    detail={`${formatMoney(totals.outstanding, settings.currency, { whole: true })} still to pay`}
                />
                <MetricCard
                    label="Overdue"
                    value={formatMoney(totals.overdue, settings.currency, { whole: true })}
                    detail={totals.overdue ? "Past the due date and not fully paid" : "Nothing overdue"}
                />
            </div>

            {totals.categories.length > 0 && (
                <section aria-labelledby="by-category" className="flex flex-col gap-5 rounded-xl bg-primary p-5 shadow-xs ring-1 ring-secondary ring-inset">
                    <h2 id="by-category" className="text-md font-semibold text-primary">
                        By category
                    </h2>
                    <ul className="grid grid-cols-1 gap-x-10 gap-y-5 lg:grid-cols-2">
                        {totals.categories.map(([name, c]) => (
                            <li key={name} className="flex flex-col gap-2">
                                <div className="flex items-baseline justify-between gap-3 text-sm">
                                    <span className="font-medium text-secondary">{name}</span>
                                    <span className="text-tertiary tabular-nums">
                                        {money(c.paid)} paid of {money(c.committed)}
                                    </span>
                                </div>
                                <ProgressBar value={percent(c.paid, c.committed)} />
                            </li>
                        ))}
                    </ul>
                </section>
            )}

            <DataTable
                title="Budget items"
                rows={items.items}
                columns={columns}
                searchText={(i) => `${i.description} ${i.category} ${i.supplierName ?? ""}`}
                initialSort={{ column: "due", direction: "ascending" }}
                onRowAction={openPanel}
                emptyState={
                    <Empty
                        icon={Wallet02}
                        title="No budget items yet"
                        description="Add each cost as an estimate, then record the actual amount and payments as they happen."
                        actions={
                            canEdit && (
                                <Button iconLeading={Plus} onClick={() => openPanel(null)}>
                                    Add item
                                </Button>
                            )
                        }
                    />
                }
            />

            <EntityPanel
                isOpen={open}
                onOpenChange={setOpen}
                noun="budget item"
                name={editing?.description ?? null}
                canEdit={canEdit}
                onSave={() => items.save(editing?.id ?? null, toPayload())}
                onDelete={editing ? () => items.remove(editing.id) : undefined}
            >
                {(fieldError) => (
                    <FormGrid>
                        <FullWidth>
                            <Input
                                label="Description"
                                isRequired
                                placeholder="Photographer"
                                value={draft.description}
                                onChange={(v) => setDraft({ ...draft, description: v })}
                                isInvalid={!!fieldError("description")}
                                hint={fieldError("description")}
                            />
                        </FullWidth>
                        <Input
                            label="Category"
                            isRequired
                            placeholder="Photography"
                            value={draft.category}
                            onChange={(v) => setDraft({ ...draft, category: v })}
                            isInvalid={!!fieldError("category")}
                            hint={
                                fieldError("category") ??
                                (categories.length ? `Existing: ${categories.slice(0, 4).join(", ")}${categories.length > 4 ? "…" : ""}` : undefined)
                            }
                        />
                        <Select
                            label="Supplier"
                            items={[{ id: "none", label: "No supplier" }, ...data.suppliers.map((s) => ({ id: s.id, label: s.name }))]}
                            value={draft.supplierId ?? "none"}
                            onChange={(v) => setDraft({ ...draft, supplierId: v === "none" ? null : String(v) })}
                        >
                            {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                        </Select>
                        <Input
                            label="Estimate"
                            inputMode="decimal"
                            placeholder="0.00"
                            value={draft.estimated}
                            onChange={(v) => setDraft({ ...draft, estimated: v })}
                            isInvalid={!!fieldError("estimatedCents")}
                            hint={fieldError("estimatedCents")}
                        />
                        <Input
                            label="Actual cost"
                            inputMode="decimal"
                            placeholder="Once quoted"
                            value={draft.actual}
                            onChange={(v) => setDraft({ ...draft, actual: v })}
                            isInvalid={!!fieldError("actualCents")}
                            hint={fieldError("actualCents")}
                        />
                        <Input
                            label="Paid so far"
                            inputMode="decimal"
                            placeholder="0.00"
                            value={draft.paid}
                            onChange={(v) => setDraft({ ...draft, paid: v })}
                            isInvalid={!!fieldError("paidCents")}
                            hint={fieldError("paidCents")}
                        />
                        <DateField
                            label="Next payment due"
                            value={draft.dueDate}
                            onChange={(v) => setDraft({ ...draft, dueDate: v })}
                            error={fieldError("dueDate")}
                        />
                        <FullWidth>
                            <TextArea label="Notes" rows={3} value={draft.notes} onChange={(v) => setDraft({ ...draft, notes: v })} />
                        </FullWidth>
                    </FormGrid>
                )}
            </EntityPanel>

            <PortalDialog
                isOpen={settingsOpen}
                onOpenChange={setSettingsOpen}
                title="Total budget"
                description="What you plan to spend overall. Used for the progress on this page and the dashboard."
                icon={Wallet02}
                size="sm"
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
                <Input
                    label={`Total (${settings.currency})`}
                    inputMode="decimal"
                    value={totalText}
                    onChange={setTotalText}
                    isInvalid={!!saveSettings.fieldError("totalCents")}
                    hint={saveSettings.fieldError("totalCents")}
                />
            </PortalDialog>
        </>
    );
};
