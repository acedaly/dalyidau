// Object types and their properties, configured without code. A property's key and kind are fixed
// once saved (the Worker refuses changes that would make stored values invalid); its label,
// options, order and whether it's required can change at any time.
import { useState } from "react";
import { ArrowDown, ArrowUp, LayersThree01, Plus, Trash01 } from "@untitledui/icons";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Checkbox } from "@/components/base/checkbox/checkbox";
import { Input } from "@/components/base/input/input";
import { Select } from "@/components/base/select/select";
import { TextArea } from "@/components/base/textarea/textarea";
import { PortalDialog } from "@/portal/components/dialog";
import { useToast } from "@/portal/components/toast";
import { api, errorMessage } from "@/portal/lib/api";
import { pluralise } from "@/portal/lib/format";
import type { PageData } from "@/portal/lib/page-types";
import { PROPERTY_TYPES, PROPERTY_TYPE_LABELS, type PropertyDef, type PropertyType } from "@/shared/knowledge/properties";
import { type KnowledgeType, TYPE_ICONS, type TypeIcon, roleAtLeast } from "@/shared/knowledge/types";
import { KnowledgeHeader } from "../knowledge-header";
import { TYPE_ICON_COMPONENTS, spaceHref } from "../shared";

interface DraftProperty extends PropertyDef {
    /** Saved already: key and type are fixed. */
    saved: boolean;
    optionsText: string;
}

interface Draft {
    name: string;
    icon: TypeIcon;
    description: string;
    properties: DraftProperty[];
}

const keyFor = (label: string, taken: string[]) => {
    const base =
        label
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "_")
            .replace(/^_+|_+$/g, "")
            .replace(/^(\d)/, "p_$1")
            .slice(0, 36) || "property";
    let key = base;
    for (let n = 2; taken.includes(key); n++) key = `${base}_${n}`;
    return key;
};

const optionId = (label: string) =>
    label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 40) || "option";

const toDraft = (type: KnowledgeType | null): Draft => ({
    name: type?.name ?? "",
    icon: type?.icon ?? "file",
    description: type?.description ?? "",
    properties: (type?.schema.properties ?? []).map((p) => ({ ...p, saved: true, optionsText: (p.options ?? []).map((o) => o.label).join(", ") })),
});

const toSchema = (draft: Draft) => ({
    properties: draft.properties.map(({ saved: _saved, optionsText, ...def }) => {
        const out: PropertyDef = { ...def };
        if (def.type === "select" || def.type === "multi_select") {
            const labels = optionsText
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
            // Keep the ids of options that already exist, so stored values still match.
            out.options = labels.map((label) => def.options?.find((o) => o.label === label) ?? { id: optionId(label), label });
        } else delete out.options;
        if (def.type !== "object") delete out.targetTypeId;
        if (def.type !== "person" && def.type !== "object" && def.type !== "multi_select") delete out.multiple;
        if (def.type !== "currency") delete out.currency;
        return out;
    }),
});

export const KnowledgeTypesPage = ({ data }: { data: PageData<"knowledge-types"> }) => {
    const { space, spaces } = data;
    const toast = useToast();
    const [types, setTypes] = useState(data.types);
    const [editing, setEditing] = useState<KnowledgeType | null>(null);
    const [open, setOpen] = useState(false);
    const [draft, setDraft] = useState<Draft>(toDraft(null));
    const [busy, setBusy] = useState(false);
    const canEdit = roleAtLeast(space.role, "editor");

    const openEditor = (type: KnowledgeType | null) => {
        setEditing(type);
        setDraft(toDraft(type));
        setOpen(true);
    };

    const updateProperty = (index: number, change: Partial<DraftProperty>) =>
        setDraft({ ...draft, properties: draft.properties.map((p, i) => (i === index ? { ...p, ...change } : p)) });

    const move = (index: number, by: -1 | 1) => {
        const properties = [...draft.properties];
        const [item] = properties.splice(index, 1);
        properties.splice(index + by, 0, item);
        setDraft({ ...draft, properties });
    };

    const save = async () => {
        setBusy(true);
        try {
            const body = { name: draft.name, icon: draft.icon, description: draft.description, schema: toSchema(draft) };
            const { type } = editing
                ? await api<{ type: KnowledgeType }>("PATCH", `/api/portal/knowledge/types/${editing.id}`, { ...body, version: editing.version })
                : await api<{ type: KnowledgeType }>("POST", `/api/portal/knowledge/spaces/${space.id}/types`, body);
            setTypes(editing ? types.map((t) => (t.id === type.id ? { ...type, objectCount: t.objectCount } : t)) : [...types, type]);
            setOpen(false);
            toast.success(editing ? "Type saved" : "Type created");
        } catch (e) {
            toast.error("Couldn't save the type", errorMessage(e));
        } finally {
            setBusy(false);
        }
    };

    const setArchived = async (type: KnowledgeType, archived: boolean) => {
        try {
            const { type: updated } = await api<{ type: KnowledgeType }>("PATCH", `/api/portal/knowledge/types/${type.id}`, {
                version: type.version,
                archived,
            });
            setTypes(types.map((t) => (t.id === updated.id ? { ...updated, objectCount: t.objectCount } : t)));
        } catch (e) {
            toast.error("Couldn't change the type", errorMessage(e));
        }
    };

    return (
        <>
            <KnowledgeHeader
                title="Object types"
                description="Kinds of object and the properties each one has. Changing a type never removes values already stored on objects."
                space={space}
                spaces={spaces}
                types={types}
                crumb="Object types"
                actions={
                    canEdit && (
                        <Button size="sm" color="secondary" iconLeading={LayersThree01} onClick={() => openEditor(null)}>
                            New type
                        </Button>
                    )
                }
            />

            <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3">
                {types.map((type) => {
                    const Icon = TYPE_ICON_COMPONENTS[type.icon];
                    return (
                        <li key={type.id} className="flex flex-col gap-4 rounded-xl bg-primary p-5 shadow-xs ring-1 ring-secondary ring-inset">
                            <div className="flex items-start gap-3">
                                <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-secondary">
                                    <Icon aria-hidden="true" className="size-5 text-fg-secondary" />
                                </span>
                                <div className="min-w-0 flex-1">
                                    <h2 className="flex items-center gap-2 text-md font-semibold text-primary">
                                        {type.name}
                                        {type.archived && (
                                            <Badge size="sm" color="gray">
                                                Archived
                                            </Badge>
                                        )}
                                    </h2>
                                    <p className="text-sm text-tertiary">{type.description || "No description."}</p>
                                </div>
                            </div>
                            <p className="text-sm text-secondary">
                                {pluralise(type.schema.properties.length, "property", "properties")}
                                {type.schema.properties.length > 0 && (
                                    <span className="text-tertiary">: {type.schema.properties.map((p) => p.label).join(", ")}</span>
                                )}
                            </p>
                            <div className="mt-auto flex flex-wrap items-center gap-2">
                                <Button size="sm" color="link-color" href={spaceHref("/portal/knowledge/all", space, { type: type.id })}>
                                    {pluralise(type.objectCount, "object")}
                                </Button>
                                {canEdit && (
                                    <>
                                        <Button size="sm" color="secondary" className="ml-auto" onClick={() => openEditor(type)}>
                                            Edit
                                        </Button>
                                        <Button size="sm" color="tertiary" onClick={() => setArchived(type, !type.archived)}>
                                            {type.archived ? "Unarchive" : "Archive"}
                                        </Button>
                                    </>
                                )}
                            </div>
                        </li>
                    );
                })}
            </ul>

            <PortalDialog
                isOpen={open}
                onOpenChange={setOpen}
                title={editing ? `Edit ${editing.name}` : "New object type"}
                icon={LayersThree01}
                size="xl"
                onSubmit={() => void save()}
                footer={
                    <>
                        <Button color="secondary" onClick={() => setOpen(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" isLoading={busy} isDisabled={!draft.name.trim()}>
                            {editing ? "Save type" : "Create type"}
                        </Button>
                    </>
                }
            >
                <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_12rem]">
                    <Input label="Name" isRequired value={draft.name} onChange={(name) => setDraft({ ...draft, name })} placeholder="e.g. Recipe" />
                    <Select
                        label="Icon"
                        value={draft.icon}
                        onChange={(key) => setDraft({ ...draft, icon: key as TypeIcon })}
                        items={TYPE_ICONS.map((id) => ({ id, label: id, icon: TYPE_ICON_COMPONENTS[id] }))}
                    >
                        {(item) => (
                            <Select.Item id={item.id} icon={item.icon}>
                                {item.label}
                            </Select.Item>
                        )}
                    </Select>
                </div>
                <TextArea label="Description" rows={2} value={draft.description} onChange={(description) => setDraft({ ...draft, description })} />

                <fieldset className="flex flex-col gap-3">
                    <legend className="mb-2 text-sm font-semibold text-primary">Properties</legend>
                    {draft.properties.length === 0 && <p className="text-sm text-tertiary">No properties yet.</p>}
                    {draft.properties.map((property, index) => (
                        <div key={`${property.key}-${index}`} className="flex flex-col gap-3 rounded-lg bg-secondary p-3 ring-1 ring-secondary ring-inset">
                            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem_auto]">
                                <Input
                                    aria-label="Property name"
                                    size="sm"
                                    placeholder="Name"
                                    value={property.label}
                                    onChange={(label) =>
                                        updateProperty(
                                            index,
                                            property.saved
                                                ? { label }
                                                : {
                                                      label,
                                                      key: keyFor(
                                                          label,
                                                          draft.properties.filter((_, i) => i !== index).map((p) => p.key),
                                                      ),
                                                  },
                                        )
                                    }
                                />
                                <Select
                                    aria-label="Kind"
                                    size="sm"
                                    isDisabled={property.saved}
                                    value={property.type}
                                    onChange={(key) => updateProperty(index, { type: key as PropertyType })}
                                    items={PROPERTY_TYPES.map((id) => ({ id, label: PROPERTY_TYPE_LABELS[id] }))}
                                >
                                    {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                                </Select>
                                <div className="flex items-center gap-1">
                                    <ButtonUtility
                                        size="xs"
                                        color="tertiary"
                                        icon={ArrowUp}
                                        tooltip="Move up"
                                        isDisabled={index === 0}
                                        onClick={() => move(index, -1)}
                                    />
                                    <ButtonUtility
                                        size="xs"
                                        color="tertiary"
                                        icon={ArrowDown}
                                        tooltip="Move down"
                                        isDisabled={index === draft.properties.length - 1}
                                        onClick={() => move(index, 1)}
                                    />
                                    <ButtonUtility
                                        size="xs"
                                        color="tertiary"
                                        icon={Trash01}
                                        tooltip="Remove (values already stored are kept)"
                                        onClick={() => setDraft({ ...draft, properties: draft.properties.filter((_, i) => i !== index) })}
                                    />
                                </div>
                            </div>
                            {(property.type === "select" || property.type === "multi_select") && (
                                <Input
                                    size="sm"
                                    label="Options"
                                    hint="Separate with commas"
                                    value={property.optionsText}
                                    onChange={(optionsText) => updateProperty(index, { optionsText })}
                                />
                            )}
                            {property.type === "object" && (
                                <Select
                                    size="sm"
                                    label="Objects of type"
                                    value={property.targetTypeId ?? "__any"}
                                    onChange={(key) => updateProperty(index, { targetTypeId: key === "__any" ? null : String(key) })}
                                    items={[
                                        { id: "__any", label: "Any type" },
                                        ...types.filter((t) => t.id !== editing?.id).map((t) => ({ id: t.id, label: t.name })),
                                    ]}
                                >
                                    {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                                </Select>
                            )}
                            {property.type === "currency" && (
                                <Input
                                    size="sm"
                                    label="Currency"
                                    value={property.currency ?? "AUD"}
                                    onChange={(currency) => updateProperty(index, { currency: currency.toUpperCase().slice(0, 3) })}
                                />
                            )}
                            <div className="flex flex-wrap gap-4">
                                <Checkbox
                                    size="sm"
                                    label="Required"
                                    isSelected={property.required}
                                    onChange={(required) => updateProperty(index, { required })}
                                />
                                {(property.type === "person" || property.type === "object") && (
                                    <Checkbox
                                        size="sm"
                                        label="Allow more than one"
                                        isSelected={!!property.multiple}
                                        onChange={(multiple) => updateProperty(index, { multiple })}
                                    />
                                )}
                            </div>
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
                                    properties: [
                                        ...draft.properties,
                                        {
                                            key: keyFor(
                                                "property",
                                                draft.properties.map((p) => p.key),
                                            ),
                                            label: "",
                                            type: "text",
                                            required: false,
                                            description: "",
                                            saved: false,
                                            optionsText: "",
                                        },
                                    ],
                                })
                            }
                        >
                            Add property
                        </Button>
                    </div>
                </fieldset>
            </PortalDialog>
        </>
    );
};
