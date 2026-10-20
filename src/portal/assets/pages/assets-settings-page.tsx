// Home & Assets settings. Reminders, Today, thresholds and retention are each person's own; the
// categories and their custom fields are the household's. The AI and email switches live in
// Portal settings → Features (owners and admins); this page only says whether they're on.
import { useEffect, useState } from "react";
import { Bell01, Package, Plus, RefreshCw01, Settings01, Stars02, Trash01 } from "@untitledui/icons";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Checkbox } from "@/components/base/checkbox/checkbox";
import { Input } from "@/components/base/input/input";
import { NativeSelect } from "@/components/base/select/select-native";
import { Toggle } from "@/components/base/toggle/toggle";
import { FormSection } from "@/portal/components/form";
import { useToast } from "@/portal/components/toast";
import { errorMessage } from "@/portal/lib/api";
import { formatDateTime } from "@/portal/lib/format";
import type { PageData } from "@/portal/lib/page-types";
import { type AssetCategory, type CustomFieldDef, FIELD_TYPES } from "@/shared/assets/categories";
import { type AssetPreferences, REMINDER_KINDS, REMINDER_KIND_LABELS } from "@/shared/assets/types";
import { featuresHref } from "@/shared/portal/settings-sections";
import { assetsApi } from "../assets-api";
import { AssetsHeader } from "../shared";

const CategoryEditor = ({ category, onSaved }: { category: AssetCategory; onSaved: (c: AssetCategory) => void }) => {
    const toast = useToast();
    const [fields, setFields] = useState<CustomFieldDef[]>(category.fields);
    const [name, setName] = useState(category.label);
    const dirty = JSON.stringify(fields) !== JSON.stringify(category.fields) || name !== category.label;
    const save = async () => {
        try {
            onSaved((await assetsApi.updateCategory(category.id, { ...(category.builtin ? {} : { name }), fields })).category);
            toast.success("Saved");
        } catch (e) {
            toast.error("Couldn't save", errorMessage(e));
        }
    };
    return (
        <li className="flex flex-col gap-3 py-4">
            <div className="flex flex-wrap items-end gap-3">
                {category.builtin ? (
                    <span className="text-sm font-semibold text-primary">{category.label}</span>
                ) : (
                    <Input label="Category name" value={name} onChange={setName} size="sm" className="sm:w-64" />
                )}
                {category.builtin && (
                    <Badge size="sm" type="color" color="gray">
                        Built in
                    </Badge>
                )}
            </div>
            {fields.map((f, i) => (
                <div key={i} className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_160px_1fr_auto] sm:items-end">
                    <Input
                        size="sm"
                        label="Label"
                        value={f.label}
                        onChange={(label) =>
                            setFields((list) =>
                                list.map((x, j) =>
                                    j === i
                                        ? {
                                              ...x,
                                              label,
                                              key:
                                                  x.key ||
                                                  label
                                                      .toLowerCase()
                                                      .replace(/[^a-z0-9]+/g, "_")
                                                      .replace(/^_+|_+$/g, "")
                                                      .slice(0, 40) ||
                                                  "field",
                                          }
                                        : x,
                                ),
                            )
                        }
                    />
                    <Input
                        size="sm"
                        label="Key"
                        value={f.key}
                        onChange={(key) => setFields((list) => list.map((x, j) => (j === i ? { ...x, key } : x)))}
                        hint="Lower case, no spaces"
                    />
                    <NativeSelect
                        size="sm"
                        label="Type"
                        value={f.type}
                        onChange={(e) => setFields((list) => list.map((x, j) => (j === i ? { ...x, type: e.target.value as CustomFieldDef["type"] } : x)))}
                        options={FIELD_TYPES.map((t) => ({ value: t, label: t }))}
                    />
                    {f.type === "select" ? (
                        <Input
                            size="sm"
                            label="Options"
                            value={(f.options ?? []).join(", ")}
                            onChange={(v) =>
                                setFields((list) =>
                                    list.map((x, j) =>
                                        j === i
                                            ? {
                                                  ...x,
                                                  options: v
                                                      .split(",")
                                                      .map((o) => o.trim())
                                                      .filter(Boolean),
                                              }
                                            : x,
                                    ),
                                )
                            }
                        />
                    ) : (
                        <span />
                    )}
                    <ButtonUtility
                        size="sm"
                        color="tertiary"
                        icon={Trash01}
                        tooltip="Remove field"
                        onClick={() => setFields((list) => list.filter((_, j) => j !== i))}
                    />
                </div>
            ))}
            <div className="flex gap-2">
                <Button size="sm" color="secondary" iconLeading={Plus} onClick={() => setFields((list) => [...list, { key: "", label: "", type: "text" }])}>
                    Add field
                </Button>
                {dirty && (
                    <Button size="sm" onClick={() => void save()}>
                        Save
                    </Button>
                )}
            </div>
        </li>
    );
};

export const AssetsSettingsPage = ({ data }: { data: PageData<"assets-settings"> }) => {
    const toast = useToast();
    const [prefs, setPrefs] = useState<AssetPreferences>(data.preferences);
    const [version, setVersion] = useState(data.preferencesVersion);
    const [categories, setCategories] = useState(data.categories);
    const [newCategory, setNewCategory] = useState("");
    const [deleted, setDeleted] = useState<{ id: string; name: string; deletedAt: string }[]>([]);
    useEffect(() => {
        void assetsApi.deleted().then((r) => setDeleted(r.assets));
    }, []);
    const save = async (next: AssetPreferences) => {
        setPrefs(next);
        try {
            const saved = await assetsApi.savePreferences(next, version);
            setPrefs(saved.preferences);
            setVersion(saved.version);
            toast.success("Saved");
        } catch (e) {
            toast.error("Couldn't save", errorMessage(e));
        }
    };
    const number = (text: string, fallback: number) => (Number.isFinite(Number(text)) && text.trim() !== "" ? Math.max(0, Math.round(Number(text))) : fallback);

    return (
        <>
            <AssetsHeader title="Settings" description="Your reminders and views, and the household's categories." crumbs={[{ label: "Settings" }]} />
            <div className="flex flex-col gap-8">
                <FormSection
                    title="Reminders"
                    description="When you're reminded, for each kind of date. Reminders appear on the Overview; email needs the owner's switch and a provider."
                >
                    {!data.emailOn && (
                        <p className="text-sm text-tertiary">
                            Reminder emails are switched off for the portal.{" "}
                            <a href={featuresHref("assets")} className="text-brand-secondary hover:underline">
                                Portal settings → Features
                            </a>
                        </p>
                    )}
                    <ul className="flex flex-col divide-y divide-secondary">
                        {REMINDER_KINDS.map((k) => {
                            const r = prefs.reminders[k];
                            return (
                                <li key={k} className="grid grid-cols-1 gap-3 py-3 sm:grid-cols-[1fr_auto_auto_160px] sm:items-center">
                                    <span className="text-sm font-medium text-secondary">{REMINDER_KIND_LABELS[k]}</span>
                                    <Checkbox
                                        label="In the portal"
                                        isSelected={r.inApp}
                                        onChange={(inApp) => void save({ ...prefs, reminders: { ...prefs.reminders, [k]: { ...r, inApp } } })}
                                    />
                                    <Checkbox
                                        label="Email"
                                        isSelected={r.email}
                                        isDisabled={!data.emailOn}
                                        onChange={(email) => void save({ ...prefs, reminders: { ...prefs.reminders, [k]: { ...r, email } } })}
                                    />
                                    <Input
                                        size="sm"
                                        aria-label={`${REMINDER_KIND_LABELS[k]}: days before`}
                                        defaultValue={r.days.join(", ")}
                                        onBlur={(e) => {
                                            const days = (e.target as HTMLInputElement).value
                                                .split(/[,\s]+/)
                                                .filter(Boolean)
                                                .map(Number)
                                                .filter((n) => Number.isInteger(n) && n >= 0 && n <= 365)
                                                .slice(0, 5);
                                            if (days.join() !== r.days.join()) void save({ ...prefs, reminders: { ...prefs.reminders, [k]: { ...r, days } } });
                                        }}
                                        hint="Days before, e.g. 30, 7, 0"
                                    />
                                </li>
                            );
                        })}
                    </ul>
                    <Toggle
                        className="w-full"
                        label="Also remind me about assets others share with me"
                        hint="Only for what's shared with you (for example their maintenance, if you can record it)"
                        isSelected={prefs.householdReminders}
                        onChange={(householdReminders) => void save({ ...prefs, householdReminders })}
                    />
                    <Toggle
                        className="w-full"
                        label="Put the asset's name in reminder emails"
                        hint='Off: emails say only "You have a Home & Assets reminder"'
                        isSelected={prefs.emailDetails}
                        onChange={(emailDetails) => void save({ ...prefs, emailDetails })}
                    />
                </FormSection>
                <FormSection
                    title="Today and briefings"
                    description="What Home & Assets adds to Today and to your Chief of Staff briefing. Only facts from your records."
                >
                    <Toggle
                        className="w-full"
                        label="Show a Home & Assets section in Today"
                        isSelected={prefs.today.enabled}
                        onChange={(enabled) => void save({ ...prefs, today: { ...prefs.today, enabled } })}
                    />
                    <NativeSelect
                        label="Look ahead"
                        value={String(prefs.today.horizonDays)}
                        onChange={(e) => void save({ ...prefs, today: { ...prefs.today, horizonDays: Number(e.target.value) as 30 | 60 | 90 } })}
                        options={[
                            { value: "30", label: "30 days" },
                            { value: "60", label: "60 days" },
                            { value: "90", label: "90 days" },
                        ]}
                        className="sm:w-48"
                    />
                    <Toggle
                        className="w-full"
                        label="Include Home & Assets in Chief of Staff briefings"
                        isSelected={prefs.briefing.include}
                        onChange={(include) => void save({ ...prefs, briefing: { include } })}
                    />
                </FormSection>
                <FormSection title="Due soon and low value" description="When something counts as due soon, and items to leave out of totals and reports.">
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                        <Input
                            label="Due soon (days)"
                            defaultValue={String(prefs.dueSoonDays)}
                            inputMode="numeric"
                            onBlur={(e) =>
                                void save({
                                    ...prefs,
                                    dueSoonDays: Math.min(180, Math.max(1, number((e.target as HTMLInputElement).value, prefs.dueSoonDays))),
                                })
                            }
                        />
                        <Input
                            label="Due soon (distance)"
                            defaultValue={String(prefs.dueSoonDistance)}
                            inputMode="numeric"
                            onBlur={(e) => void save({ ...prefs, dueSoonDistance: number((e.target as HTMLInputElement).value, prefs.dueSoonDistance) })}
                        />
                        <Input
                            label="Leave out items under ($)"
                            defaultValue={String(prefs.lowValueCents / 100)}
                            inputMode="decimal"
                            hint="0 includes everything"
                            onBlur={(e) => void save({ ...prefs, lowValueCents: Math.round(Number((e.target as HTMLInputElement).value || 0) * 100) || 0 })}
                        />
                    </div>
                    <NativeSelect
                        label="Asset list layout"
                        value={prefs.layout}
                        onChange={(e) => void save({ ...prefs, layout: e.target.value as "list" | "cards" })}
                        options={[
                            { value: "list", label: "List" },
                            { value: "cards", label: "Cards" },
                        ]}
                        className="sm:w-48"
                    />
                </FormSection>
                <FormSection
                    title="Document retention"
                    description="Documents of things you've disposed of can be listed for review after a number of years. Nothing is ever deleted automatically."
                >
                    <NativeSelect
                        label="List for review after"
                        value={prefs.retention.disposedYears === null ? "" : String(prefs.retention.disposedYears)}
                        onChange={(e) => void save({ ...prefs, retention: { disposedYears: e.target.value ? Number(e.target.value) : null } })}
                        options={[{ value: "", label: "Never" }, ...[1, 2, 5, 7, 10].map((y) => ({ value: String(y), label: `${y} years` }))]}
                        className="sm:w-48"
                    />
                </FormSection>
                <FormSection
                    title="Categories and custom fields"
                    description="Household categories, and extra fields for any category (e.g. a camera's lens mount). Everyone in the household sees the same list."
                >
                    <ul className="flex flex-col divide-y divide-secondary">
                        {categories
                            .filter((c) => !c.archived)
                            .map((c) => (
                                <CategoryEditor
                                    key={c.id}
                                    category={c}
                                    onSaved={(saved) => setCategories((list) => list.map((x) => (x.id === saved.id ? saved : x)))}
                                />
                            ))}
                    </ul>
                    <form
                        className="flex flex-col gap-2 sm:flex-row sm:items-end"
                        onSubmit={async (e) => {
                            e.preventDefault();
                            try {
                                const { category } = await assetsApi.createCategory({ name: newCategory });
                                setCategories((list) => [...list, category]);
                                setNewCategory("");
                            } catch (err) {
                                toast.error("Couldn't add it", errorMessage(err));
                            }
                        }}
                    >
                        <Input label="New category" value={newCategory} onChange={setNewCategory} className="sm:w-64" />
                        <Button size="md" color="secondary" type="submit" iconLeading={Plus} isDisabled={!newCategory.trim()}>
                            Add
                        </Button>
                    </form>
                </FormSection>
                <FormSection
                    title="AI suggestions"
                    description="Optional help reading receipts, photos and policies. Every suggestion is shown for you to check; nothing is saved without you."
                >
                    <p className="flex items-start gap-2 text-sm text-tertiary">
                        <Stars02 aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                        {data.canAi ? "Available." : data.aiNote}
                    </p>
                    <div className="flex flex-wrap gap-2">
                        <Button size="sm" color="secondary" iconLeading={Settings01} href={featuresHref("assets")}>
                            Feature switches
                        </Button>
                        <Button size="sm" color="secondary" iconLeading={Settings01} href="/portal/intelligence/settings">
                            Intelligence settings
                        </Button>
                    </div>
                </FormSection>
                <FormSection
                    title="Recently deleted"
                    description="Assets you deleted in the last 30 days. After that, their photos and documents are removed for good."
                >
                    {deleted.length ? (
                        <ul className="flex flex-col divide-y divide-secondary">
                            {deleted.map((d) => (
                                <li key={d.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                                    <span>
                                        {d.name} <span className="text-tertiary">· deleted {formatDateTime(d.deletedAt)}</span>
                                    </span>
                                    <Button
                                        size="xs"
                                        color="secondary"
                                        iconLeading={RefreshCw01}
                                        onClick={async () => {
                                            try {
                                                await assetsApi.restore(d.id);
                                                setDeleted((list) => list.filter((x) => x.id !== d.id));
                                                toast.success("Restored");
                                            } catch (e) {
                                                toast.error("Couldn't restore it", errorMessage(e));
                                            }
                                        }}
                                    >
                                        Restore
                                    </Button>
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <p className="flex items-center gap-2 text-sm text-tertiary">
                            <Package aria-hidden="true" className="size-4" />
                            Nothing deleted recently.
                        </p>
                    )}
                </FormSection>
                <p className="flex items-center gap-2 text-sm text-tertiary">
                    <Bell01 aria-hidden="true" className="size-4" />
                    Calendar shows Home & Assets dates as reminders; turn them off in Calendar → Settings.
                </p>
            </div>
        </>
    );
};
