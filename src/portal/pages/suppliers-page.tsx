import { useState } from "react";
import { ClipboardCheck, Download01, LinkExternal01, Plus } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { Select } from "@/components/base/select/select";
import { TextArea } from "@/components/base/textarea/textarea";
import { type DataColumn, DataTable } from "@/portal/components/data-table";
import { Empty } from "@/portal/components/empty";
import { EntityPanel } from "@/portal/components/entity-panel";
import { FormGrid, FullWidth } from "@/portal/components/form";
import { PageHeader } from "@/portal/components/page-header";
import { SUPPLIER_STATUS_LABELS, SupplierStatusBadge } from "@/portal/components/status";
import { useCollection } from "@/portal/hooks/use-collection";
import type { PageData } from "@/portal/lib/page-types";
import { usePortal } from "@/portal/portal-context";
import type { Supplier, SupplierStatus } from "@/shared/portal/types";

type Draft = Record<"name" | "category" | "contactName" | "email" | "phone" | "website" | "notes", string> & { status: SupplierStatus };

const toDraft = (s: Supplier | null): Draft => ({
    name: s?.name ?? "",
    category: s?.category ?? "",
    status: s?.status ?? "researching",
    contactName: s?.contactName ?? "",
    email: s?.email ?? "",
    phone: s?.phone ?? "",
    website: s?.website ?? "",
    notes: s?.notes ?? "",
});

export const SuppliersPage = ({ data }: { data: PageData<"suppliers"> }) => {
    const { can } = usePortal();
    const suppliers = useCollection<Supplier>("suppliers", data.suppliers);
    const [editing, setEditing] = useState<Supplier | null>(null);
    const [open, setOpen] = useState(false);
    const [draft, setDraft] = useState<Draft>(toDraft(null));
    const [status, setStatus] = useState<string>("all");
    const canEdit = can("wedding.budget.edit");

    const openPanel = (s: Supplier | null) => {
        setEditing(s);
        setDraft(toDraft(s));
        setOpen(true);
    };

    const columns: DataColumn<Supplier>[] = [
        {
            id: "name",
            label: "Supplier",
            isRowHeader: true,
            sortValue: (s) => s.name,
            render: (s) => (
                <div className="min-w-0">
                    <p className="font-medium text-primary">{s.name}</p>
                    <p className="text-tertiary">{s.category ?? "Uncategorised"}</p>
                </div>
            ),
        },
        { id: "status", label: "Status", sortValue: (s) => s.status, render: (s) => <SupplierStatusBadge status={s.status} /> },
        {
            id: "contact",
            label: "Contact",
            sortValue: (s) => s.contactName,
            render: (s) => (
                <div className="min-w-0">
                    <p className="text-secondary">{s.contactName ?? "—"}</p>
                    {s.email && (
                        <a href={`mailto:${s.email}`} onClick={(e) => e.stopPropagation()} className="text-brand-secondary hover:underline">
                            {s.email}
                        </a>
                    )}
                </div>
            ),
            className: "max-md:hidden",
        },
        { id: "phone", label: "Phone", render: (s) => s.phone ?? <span className="text-quaternary">—</span>, className: "max-lg:hidden" },
        {
            id: "website",
            label: "Website",
            render: (s) =>
                s.website ? (
                    <Button size="sm" color="link-gray" iconTrailing={LinkExternal01} href={s.website} target="_blank" rel="noreferrer noopener">
                        Visit
                    </Button>
                ) : (
                    <span className="text-quaternary">—</span>
                ),
            className: "max-lg:hidden",
        },
    ];

    const rows = status === "all" ? suppliers.items : suppliers.items.filter((s) => s.status === status);

    return (
        <>
            <PageHeader
                title="Suppliers"
                description="Venues, caterers, photographers and everyone else you're working with."
                breadcrumbs={[{ label: "Suppliers" }]}
                actions={
                    <>
                        {suppliers.items.length > 0 && (
                            <Button color="secondary" iconLeading={Download01} href="/api/portal/export/suppliers.csv" download>
                                Export
                            </Button>
                        )}
                        {canEdit && (
                            <Button iconLeading={Plus} onClick={() => openPanel(null)}>
                                Add supplier
                            </Button>
                        )}
                    </>
                }
            />

            <DataTable
                title="Suppliers"
                rows={rows}
                columns={columns}
                searchText={(s) => [s.name, s.category, s.contactName, s.email].filter(Boolean).join(" ")}
                initialSort={{ column: "name", direction: "ascending" }}
                onRowAction={openPanel}
                activeFilterCount={status === "all" ? 0 : 1}
                onClearFilters={() => setStatus("all")}
                filters={
                    <Select
                        label="Status"
                        size="sm"
                        className="w-[calc(50%-0.375rem)] sm:w-44"
                        items={[{ id: "all", label: "All" }, ...Object.entries(SUPPLIER_STATUS_LABELS).map(([id, label]) => ({ id, label }))]}
                        value={status}
                        onChange={(v) => setStatus(String(v))}
                    >
                        {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                    </Select>
                }
                emptyState={
                    <Empty
                        icon={ClipboardCheck}
                        title="No suppliers yet"
                        description="Keep contacts, quotes and booking status in one place. Budget items can be linked to a supplier."
                        actions={
                            canEdit && (
                                <Button iconLeading={Plus} onClick={() => openPanel(null)}>
                                    Add supplier
                                </Button>
                            )
                        }
                    />
                }
            />

            <EntityPanel
                isOpen={open}
                onOpenChange={setOpen}
                noun="supplier"
                name={editing?.name ?? null}
                canEdit={canEdit}
                onSave={() => suppliers.save(editing?.id ?? null, draft)}
                onDelete={editing ? () => suppliers.remove(editing.id) : undefined}
                deleteWarning="Budget items linked to this supplier are kept, without the link."
            >
                {(fieldError) => (
                    <FormGrid>
                        <FullWidth>
                            <Input
                                label="Name"
                                isRequired
                                value={draft.name}
                                onChange={(v) => setDraft({ ...draft, name: v })}
                                isInvalid={!!fieldError("name")}
                                hint={fieldError("name")}
                            />
                        </FullWidth>
                        <Input label="Category" placeholder="Photography" value={draft.category} onChange={(v) => setDraft({ ...draft, category: v })} />
                        <Select
                            label="Status"
                            items={Object.entries(SUPPLIER_STATUS_LABELS).map(([id, label]) => ({ id, label }))}
                            value={draft.status}
                            onChange={(v) => setDraft({ ...draft, status: v as SupplierStatus })}
                        >
                            {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                        </Select>
                        <Input label="Contact name" value={draft.contactName} onChange={(v) => setDraft({ ...draft, contactName: v })} />
                        <Input label="Phone" type="tel" value={draft.phone} onChange={(v) => setDraft({ ...draft, phone: v })} />
                        <Input
                            label="Email"
                            type="email"
                            value={draft.email}
                            onChange={(v) => setDraft({ ...draft, email: v })}
                            isInvalid={!!fieldError("email")}
                            hint={fieldError("email")}
                        />
                        <Input
                            label="Website"
                            type="url"
                            placeholder="https://"
                            value={draft.website}
                            onChange={(v) => setDraft({ ...draft, website: v })}
                            isInvalid={!!fieldError("website")}
                            hint={fieldError("website")}
                        />
                        <FullWidth>
                            <TextArea
                                label="Notes"
                                rows={4}
                                placeholder="Quotes, package details, what's included…"
                                value={draft.notes}
                                onChange={(v) => setDraft({ ...draft, notes: v })}
                            />
                        </FullWidth>
                    </FormGrid>
                )}
            </EntityPanel>
        </>
    );
};
