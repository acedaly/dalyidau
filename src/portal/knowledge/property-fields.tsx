// An object's custom properties, edited in place. The Worker validates every value against the
// type; these fields only shape input (and show the server's message if it's refused). Text is
// committed when the field loses focus, everything else as soon as it changes.
import { useEffect, useState } from "react";
import { XClose } from "@untitledui/icons";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Checkbox } from "@/components/base/checkbox/checkbox";
import { Input } from "@/components/base/input/input";
import { Select } from "@/components/base/select/select";
import { TextArea } from "@/components/base/textarea/textarea";
import { formatMoney, parseMoney } from "@/portal/lib/format";
import { PERSON_TYPE_SLUG, type PropertyDef, type PropertyValue, type PropertyValues } from "@/shared/knowledge/properties";
import type { KnowledgeObjectDetail, KnowledgeType } from "@/shared/knowledge/types";
import { ObjectPicker } from "./object-picker";
import { TypeIconFor, objectHref, titleOf } from "./shared";

interface FieldProps {
    def: PropertyDef;
    value: PropertyValue | undefined;
    onChange: (value: PropertyValue | null) => void;
    editable: boolean;
    spaceId: string;
    types: KnowledgeType[];
    referenced: KnowledgeObjectDetail["referenced"];
}

/** A text-like field that keeps its own draft and commits on blur or Enter. */
const DraftInput = ({
    def,
    value,
    onChange,
    editable,
    type = "text",
    parse,
    format,
}: FieldProps & { type?: string; parse?: (s: string) => PropertyValue | null; format?: (v: PropertyValue) => string }) => {
    const shown = value === undefined ? "" : format ? format(value) : String(value);
    const [draft, setDraft] = useState(shown);
    useEffect(() => setDraft(shown), [shown]);
    const commit = () => {
        if (draft === shown) return;
        const trimmed = draft.trim();
        onChange(trimmed === "" ? null : parse ? parse(trimmed) : trimmed);
    };
    return (
        <Input
            aria-label={def.label}
            size="sm"
            type={type}
            value={draft}
            isDisabled={!editable}
            onChange={setDraft}
            onBlur={commit}
            onKeyDown={(event) => {
                if (event.key === "Enter") commit();
            }}
        />
    );
};

const References = ({ def, value, onChange, editable, spaceId, types, referenced }: FieldProps) => {
    const ids = Array.isArray(value) ? value : [];
    const targetTypes =
        def.type === "person" ? types.filter((t) => t.slug === PERSON_TYPE_SLUG).map((t) => t.id) : def.targetTypeId ? [def.targetTypeId] : null;
    return (
        <div className="flex flex-col gap-2">
            {ids.length > 0 && (
                <ul className="flex flex-col gap-1">
                    {ids.map((id) => {
                        const object = referenced[id];
                        return (
                            <li key={id} className="flex items-center gap-2 text-sm">
                                <TypeIconFor type={types.find((t) => t.id === object?.typeId)} />
                                {object ? (
                                    <a href={objectHref(id)} className="min-w-0 flex-1 truncate font-medium text-brand-secondary hover:underline">
                                        {titleOf(object.title)}
                                    </a>
                                ) : (
                                    <span className="flex-1 text-quaternary">Not available</span>
                                )}
                                {editable && (
                                    <ButtonUtility
                                        size="xs"
                                        color="tertiary"
                                        icon={XClose}
                                        tooltip={`Remove from ${def.label}`}
                                        onClick={() => onChange(ids.filter((other) => other !== id))}
                                    />
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}
            {editable && (def.multiple || ids.length === 0) && (
                <ObjectPicker
                    spaceId={spaceId}
                    types={types}
                    placeholder={def.type === "person" ? "Add a person" : "Add an object"}
                    typeIds={targetTypes}
                    exclude={ids}
                    onPick={(picked) => onChange(def.multiple ? [...ids, picked.id] : [picked.id])}
                />
            )}
            {!editable && ids.length === 0 && <span className="text-sm text-quaternary">—</span>}
        </div>
    );
};

const Field = (props: FieldProps) => {
    const { def, value, onChange, editable } = props;
    switch (def.type) {
        case "long_text":
            return <LongText {...props} />;
        case "number":
            return <DraftInput {...props} type="number" parse={(s) => (Number.isFinite(Number(s)) ? Number(s) : s)} />;
        case "currency":
            return (
                <DraftInput
                    {...props}
                    parse={(s) => parseMoney(s) ?? s}
                    format={(v) => (typeof v === "number" ? formatMoney(v, def.currency ?? "AUD") : String(v))}
                />
            );
        case "date":
            return <DraftInput {...props} type="date" />;
        case "datetime":
            return (
                <DraftInput
                    {...props}
                    type="datetime-local"
                    // Shown and entered in this device's time zone; stored in UTC.
                    format={(v) => {
                        const d = new Date(String(v));
                        if (Number.isNaN(d.getTime())) return "";
                        const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
                        return local.toISOString().slice(0, 16);
                    }}
                    parse={(s) => new Date(s).toISOString()}
                />
            );
        case "checkbox":
            return <Checkbox aria-label={def.label} isSelected={value === true} isDisabled={!editable} onChange={(on) => onChange(on)} />;
        case "select":
            return (
                <Select
                    aria-label={def.label}
                    size="sm"
                    placeholder="—"
                    isDisabled={!editable}
                    value={typeof value === "string" ? value : null}
                    onChange={(key) => onChange(key === "__none" ? null : String(key))}
                    items={[{ id: "__none", label: "—" }, ...(def.options ?? []).map((o) => ({ id: o.id, label: o.label }))]}
                >
                    {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                </Select>
            );
        case "multi_select": {
            const chosen = Array.isArray(value) ? value : [];
            return (
                <div className="flex flex-col gap-1.5">
                    {(def.options ?? []).map((option) => (
                        <Checkbox
                            key={option.id}
                            size="sm"
                            label={option.label}
                            isSelected={chosen.includes(option.id)}
                            isDisabled={!editable}
                            onChange={(on) => onChange(on ? [...chosen, option.id] : chosen.filter((id) => id !== option.id))}
                        />
                    ))}
                </div>
            );
        }
        case "person":
        case "object":
            return <References {...props} />;
        case "url":
            return !editable && typeof value === "string" ? (
                <a href={value} target="_blank" rel="noopener noreferrer nofollow" className="truncate text-sm text-brand-secondary hover:underline">
                    {value}
                </a>
            ) : (
                <DraftInput {...props} type="url" />
            );
        case "email":
            return <DraftInput {...props} type="email" />;
        case "phone":
            return <DraftInput {...props} type="tel" />;
        default:
            return <DraftInput {...props} />;
    }
};

const LongText = ({ def, value, onChange, editable }: FieldProps) => {
    const shown = typeof value === "string" ? value : "";
    const [draft, setDraft] = useState(shown);
    useEffect(() => setDraft(shown), [shown]);
    return (
        <TextArea
            aria-label={def.label}
            rows={3}
            value={draft}
            isDisabled={!editable}
            onChange={setDraft}
            onBlur={() => draft !== shown && onChange(draft.trim() === "" ? null : draft)}
        />
    );
};

interface PropertyFieldsProps {
    defs: readonly PropertyDef[];
    values: PropertyValues;
    onChange: (key: string, value: PropertyValue | null) => void;
    editable: boolean;
    spaceId: string;
    types: KnowledgeType[];
    referenced: KnowledgeObjectDetail["referenced"];
}

export const PropertyFields = ({ defs, values, onChange, editable, spaceId, types, referenced }: PropertyFieldsProps) => {
    if (defs.length === 0) return <p className="text-sm text-tertiary">This type has no properties. Add some under Object types.</p>;
    return (
        <dl className="flex flex-col gap-4">
            {defs.map((def) => (
                <div key={def.key} className="flex flex-col gap-1.5">
                    <dt className="text-sm font-medium text-secondary">
                        {def.label}
                        {def.required && <span className="text-brand-tertiary"> *</span>}
                    </dt>
                    <dd className="min-w-0">
                        <Field
                            def={def}
                            value={values[def.key]}
                            onChange={(value) => onChange(def.key, value)}
                            editable={editable}
                            spaceId={spaceId}
                            types={types}
                            referenced={referenced}
                        />
                        {def.description && <p className="mt-1 text-xs text-tertiary">{def.description}</p>}
                    </dd>
                </div>
            ))}
        </dl>
    );
};
