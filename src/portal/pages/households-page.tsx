import { useState } from "react";
import { Building07, Download01, Plus, RefreshCw01 } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { TextArea } from "@/components/base/textarea/textarea";
import { CopyCode } from "@/portal/components/copy-code";
import { type DataColumn, DataTable } from "@/portal/components/data-table";
import { ConfirmDialog } from "@/portal/components/dialog";
import { Empty } from "@/portal/components/empty";
import { EntityPanel } from "@/portal/components/entity-panel";
import { FormGrid, FullWidth } from "@/portal/components/form";
import { PageHeader } from "@/portal/components/page-header";
import { useToast } from "@/portal/components/toast";
import { useCollection } from "@/portal/hooks/use-collection";
import { api, errorMessage } from "@/portal/lib/api";
import { pluralise } from "@/portal/lib/format";
import type { PageData } from "@/portal/lib/page-types";
import { usePortal } from "@/portal/portal-context";
import type { Household } from "@/shared/portal/types";

type Draft = Record<"name" | "email" | "phone" | "addressLine1" | "addressLine2" | "locality" | "region" | "postcode" | "country" | "notes", string>;

const toDraft = (h: Household | null): Draft => ({
    name: h?.name ?? "",
    email: h?.email ?? "",
    phone: h?.phone ?? "",
    addressLine1: h?.addressLine1 ?? "",
    addressLine2: h?.addressLine2 ?? "",
    locality: h?.locality ?? "",
    region: h?.region ?? "",
    postcode: h?.postcode ?? "",
    country: h?.country ?? "",
    notes: h?.notes ?? "",
});

export const HouseholdsPage = ({ data }: { data: PageData<"households"> }) => {
    const { can } = usePortal();
    const toast = useToast();
    const households = useCollection<Household>("households", data.households);
    const [editing, setEditing] = useState<Household | null>(null);
    const [open, setOpen] = useState(false);
    const [draft, setDraft] = useState<Draft>(toDraft(null));
    const [regenerate, setRegenerate] = useState<Household | null>(null);
    const canEdit = can("wedding.guests.edit");

    const openPanel = (household: Household | null) => {
        setEditing(household);
        setDraft(toDraft(household));
        setOpen(true);
    };
    const field = (key: keyof Draft, label: string, fieldError: (f: string) => string | undefined, props: Record<string, unknown> = {}) => (
        <Input
            label={label}
            value={draft[key]}
            onChange={(v) => setDraft({ ...draft, [key]: v })}
            isInvalid={!!fieldError(key)}
            hint={fieldError(key)}
            {...props}
        />
    );

    const columns: DataColumn<Household>[] = [
        {
            id: "name",
            label: "Household",
            isRowHeader: true,
            sortValue: (h) => h.name,
            render: (h) => <span className="font-medium text-primary">{h.name}</span>,
        },
        { id: "guests", label: "Guests", sortValue: (h) => h.guestCount, render: (h) => h.guestCount },
        { id: "code", label: "RSVP code", tooltip: "Guests enter this code to RSVP online.", render: (h) => <CopyCode code={h.rsvpCode} /> },
        {
            id: "email",
            label: "Contact",
            sortValue: (h) => h.email,
            render: (h) => h.email ?? <span className="text-quaternary">—</span>,
            className: "max-md:hidden",
        },
        {
            id: "place",
            label: "Location",
            sortValue: (h) => h.locality,
            render: (h) => [h.locality, h.region].filter(Boolean).join(", ") || <span className="text-quaternary">—</span>,
            className: "max-lg:hidden",
        },
    ];

    return (
        <>
            <PageHeader
                title="Households"
                description="Invitations go to households. Each has its own RSVP code."
                breadcrumbs={[{ label: "Households" }]}
                actions={
                    <>
                        {can("wedding.export") && households.items.length > 0 && (
                            <Button color="secondary" iconLeading={Download01} href="/api/portal/export/households.csv" download>
                                Export with codes
                            </Button>
                        )}
                        {canEdit && (
                            <Button iconLeading={Plus} onClick={() => openPanel(null)}>
                                Add household
                            </Button>
                        )}
                    </>
                }
            />

            <DataTable
                title="All households"
                rows={households.items}
                columns={columns}
                searchText={(h) => [h.name, h.email, h.rsvpCode, h.locality].filter(Boolean).join(" ")}
                searchPlaceholder="Search households"
                initialSort={{ column: "name", direction: "ascending" }}
                onRowAction={openPanel}
                emptyState={
                    <Empty
                        icon={Building07}
                        title="No households yet"
                        description="Group guests who share an invitation (a couple, a family) so they can RSVP together with one code. Importing guests with a Household column creates them for you."
                        actions={
                            canEdit && (
                                <Button iconLeading={Plus} onClick={() => openPanel(null)}>
                                    Add household
                                </Button>
                            )
                        }
                    />
                }
            />

            <EntityPanel
                isOpen={open}
                onOpenChange={setOpen}
                noun="household"
                name={editing?.name ?? null}
                description={editing ? pluralise(editing.guestCount, "guest") : "Guests are added to households from the guest list."}
                canEdit={canEdit}
                onSave={() => households.save(editing?.id ?? null, draft)}
                onDelete={editing ? () => households.remove(editing.id) : undefined}
                deleteWarning="Guests in this household stay on the guest list without a household, and its RSVP code stops working."
            >
                {(fieldError) => (
                    <>
                        {editing && (
                            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-secondary p-4">
                                <div className="flex flex-col gap-1">
                                    <p className="text-sm font-semibold text-secondary">RSVP code</p>
                                    <CopyCode code={editing.rsvpCode} />
                                </div>
                                {canEdit && (
                                    <Button size="sm" color="secondary" iconLeading={RefreshCw01} onClick={() => setRegenerate(editing)}>
                                        Issue new code
                                    </Button>
                                )}
                            </div>
                        )}
                        <FormGrid>
                            <FullWidth>{field("name", "Household name", fieldError, { isRequired: true, placeholder: "The Smith family" })}</FullWidth>
                            {field("email", "Contact email", fieldError, { type: "email" })}
                            {field("phone", "Phone", fieldError, { type: "tel" })}
                            <FullWidth>{field("addressLine1", "Address", fieldError)}</FullWidth>
                            <FullWidth>{field("addressLine2", "Address line 2", fieldError)}</FullWidth>
                            {field("locality", "Suburb or town", fieldError)}
                            {field("region", "State", fieldError)}
                            {field("postcode", "Postcode", fieldError)}
                            {field("country", "Country", fieldError)}
                            <FullWidth>
                                <TextArea label="Notes" rows={3} value={draft.notes} onChange={(v) => setDraft({ ...draft, notes: v })} />
                            </FullWidth>
                        </FormGrid>
                    </>
                )}
            </EntityPanel>

            <ConfirmDialog
                isOpen={!!regenerate}
                onOpenChange={(o) => !o && setRegenerate(null)}
                title="Issue a new RSVP code?"
                description="The current code stops working straight away. Only do this if the old code was shared with the wrong people."
                confirmLabel="Issue new code"
                onConfirm={async () => {
                    if (!regenerate) return;
                    try {
                        const { household } = await api<{ household: Household }>("POST", `/api/portal/wedding/households/${regenerate.id}/code`, {});
                        households.setItems((list) => list.map((h) => (h.id === household.id ? household : h)));
                        setEditing(household);
                        toast.success("New code issued", household.rsvpCode);
                    } catch (error) {
                        toast.error("Couldn't issue a new code", errorMessage(error));
                    }
                }}
            />
        </>
    );
};
