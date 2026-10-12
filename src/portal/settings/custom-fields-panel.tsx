import { useState } from "react";
import { Columns03, Plus } from "@untitledui/icons";
import { BadgeWithDot } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { Select } from "@/components/base/select/select";
import { TextArea } from "@/components/base/textarea/textarea";
import { Toggle } from "@/components/base/toggle/toggle";
import { type DataColumn, DataTable } from "@/portal/components/data-table";
import { Empty } from "@/portal/components/empty";
import { EntityPanel } from "@/portal/components/entity-panel";
import { useCollection } from "@/portal/hooks/use-collection";
import { usePortal } from "@/portal/portal-context";
import type { CustomField, CustomFieldType } from "@/shared/portal/types";

const TYPE_LABELS: Record<CustomFieldType, string> = { text: "Text", number: "Number", boolean: "Yes / no", select: "Choice", date: "Date" };

interface Draft {
    label: string;
    key: string;
    type: CustomFieldType;
    options: string;
    help: string;
    showInTable: boolean;
    archived: boolean;
}

const keyFrom = (label: string) =>
    label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .replace(/^(\d)/, "f_$1")
        .slice(0, 40);

/** Extra guest fields the couple can define without a code change (meal choice, shuttle, room…). */
export const CustomFieldsPanel = ({ initial }: { initial: CustomField[] }) => {
    const { can } = usePortal();
    const fields = useCollection<CustomField>("custom-fields", initial);
    const [editing, setEditing] = useState<CustomField | null>(null);
    const [open, setOpen] = useState(false);
    const [draft, setDraft] = useState<Draft>({ label: "", key: "", type: "text", options: "", help: "", showInTable: false, archived: false });
    const [keyTouched, setKeyTouched] = useState(false);
    const canEdit = can("portal.settings.manage");

    const openPanel = (field: CustomField | null) => {
        setEditing(field);
        setKeyTouched(!!field);
        setDraft({
            label: field?.label ?? "",
            key: field?.key ?? "",
            type: field?.type ?? "text",
            options: field?.options.join("\n") ?? "",
            help: field?.help ?? "",
            showInTable: field?.showInTable ?? false,
            archived: field?.archived ?? false,
        });
        setOpen(true);
    };

    const payload = () => ({
        label: draft.label,
        help: draft.help,
        showInTable: draft.showInTable,
        archived: draft.archived,
        options: draft.options
            .split("\n")
            .map((o) => o.trim())
            .filter(Boolean),
        // Key and type are fixed once created.
        ...(editing ? {} : { key: draft.key, type: draft.type, sortOrder: (fields.items.length + 1) * 10 }),
    });

    const columns: DataColumn<CustomField>[] = [
        {
            id: "label",
            label: "Field",
            isRowHeader: true,
            sortValue: (f) => f.label,
            render: (f) => (
                <div>
                    <p className="font-medium text-primary">{f.label}</p>
                    <p className="font-mono text-xs text-tertiary">{f.key}</p>
                </div>
            ),
        },
        { id: "type", label: "Type", sortValue: (f) => f.type, render: (f) => TYPE_LABELS[f.type] + (f.type === "select" ? ` (${f.options.length})` : "") },
        { id: "table", label: "In guest table", render: (f) => (f.showInTable ? "Yes" : "No"), className: "max-md:hidden" },
        {
            id: "state",
            label: "Status",
            sortValue: (f) => (f.archived ? 1 : 0),
            render: (f) => (
                <BadgeWithDot size="sm" color={f.archived ? "gray" : "success"}>
                    {f.archived ? "Archived" : "Active"}
                </BadgeWithDot>
            ),
        },
    ];

    return (
        <>
            <DataTable
                title="Custom guest fields"
                description="Track anything else per guest: meal choice, shuttle seat, room number. Archived fields keep their data but are hidden."
                rows={fields.items}
                columns={columns}
                onRowAction={openPanel}
                actions={
                    canEdit && (
                        <Button size="sm" iconLeading={Plus} onClick={() => openPanel(null)}>
                            Add field
                        </Button>
                    )
                }
                emptyState={
                    <Empty
                        icon={Columns03}
                        title="No custom fields"
                        description="Add a field and it appears on every guest's profile, in the CSV export and, if you like, as a column in the guest list."
                        actions={
                            canEdit && (
                                <Button iconLeading={Plus} onClick={() => openPanel(null)}>
                                    Add field
                                </Button>
                            )
                        }
                    />
                }
            />
            <EntityPanel
                isOpen={open}
                onOpenChange={setOpen}
                noun="field"
                name={editing?.label ?? null}
                canEdit={canEdit}
                onSave={() => fields.save(editing?.id ?? null, payload())}
                onDelete={editing ? () => fields.remove(editing.id) : undefined}
                deleteWarning="Values already entered stay in each guest's record but are no longer shown. Archiving is usually better."
            >
                {(fieldError) => (
                    <>
                        <Input
                            label="Label"
                            isRequired
                            placeholder="Meal choice"
                            value={draft.label}
                            onChange={(v) => setDraft({ ...draft, label: v, key: keyTouched ? draft.key : keyFrom(v) })}
                            isInvalid={!!fieldError("label")}
                            hint={fieldError("label")}
                        />
                        <Input
                            label="Key"
                            isRequired
                            isDisabled={!!editing}
                            value={draft.key}
                            onChange={(v) => {
                                setKeyTouched(true);
                                setDraft({ ...draft, key: v });
                            }}
                            isInvalid={!!fieldError("key")}
                            hint={fieldError("key") ?? "Used in CSV imports and exports. Can't be changed later."}
                        />
                        <Select
                            label="Type"
                            isDisabled={!!editing}
                            items={Object.entries(TYPE_LABELS).map(([id, label]) => ({ id, label }))}
                            value={draft.type}
                            onChange={(v) => setDraft({ ...draft, type: v as CustomFieldType })}
                            hint={editing ? "The type can't be changed once a field exists." : undefined}
                        >
                            {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                        </Select>
                        {draft.type === "select" && (
                            <TextArea
                                label="Choices"
                                isRequired
                                rows={5}
                                placeholder={"Beef\nFish\nVegetarian"}
                                value={draft.options}
                                onChange={(v) => setDraft({ ...draft, options: v })}
                                isInvalid={!!fieldError("options")}
                                hint={fieldError("options") ?? "One per line."}
                            />
                        )}
                        <Input
                            label="Help text"
                            value={draft.help}
                            onChange={(v) => setDraft({ ...draft, help: v })}
                            hint="Shown under the field on guest profiles."
                        />
                        <Toggle
                            label="Show as a column in the guest list"
                            isSelected={draft.showInTable}
                            onChange={(v) => setDraft({ ...draft, showInTable: v })}
                        />
                        {editing && (
                            <Toggle
                                label="Archived"
                                hint="Hidden from forms and exports; existing values are kept."
                                isSelected={draft.archived}
                                onChange={(v) => setDraft({ ...draft, archived: v })}
                            />
                        )}
                    </>
                )}
            </EntityPanel>
        </>
    );
};
