// Categories and settings: the built-in categories, the household's own (add, rename, archive), and
// how privacy and imports work.
import { useState } from "react";
import { Archive, Lock01, Plus, RefreshCcw01, Tag01 } from "@untitledui/icons";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { NativeSelect } from "@/components/base/select/select-native";
import { Card } from "@/portal/components/card";
import { PortalDialog } from "@/portal/components/dialog";
import { FormError } from "@/portal/components/form";
import { useToast } from "@/portal/components/toast";
import { errorMessage } from "@/portal/lib/api";
import { pluralise } from "@/portal/lib/format";
import type { PageData } from "@/portal/lib/page-types";
import { CATEGORY_GROUPS, type CategoryDef } from "@/shared/finance/categories";
import { financeApi } from "../finance-api";
import { FINANCE, FinanceHeader } from "../shared";

export const FinanceSettingsPage = ({ data }: { data: PageData<"finance-settings"> }) => {
    const toast = useToast();
    const [categories, setCategories] = useState(data.categories);
    const [editing, setEditing] = useState<CategoryDef | "new" | null>(null);

    const archive = async (c: CategoryDef, archived: boolean) => {
        try {
            const { category } = await financeApi.updateCategory(c.id, { version: c.version, archived });
            setCategories((list) => list.map((x) => (x.id === c.id ? category : x)));
            toast.success(archived ? "Archived" : "Restored");
        } catch (e) {
            toast.error("Couldn't save", errorMessage(e));
        }
    };

    return (
        <>
            <FinanceHeader
                title="Categories and settings"
                crumbs={[{ label: "Settings" }]}
                description="Categories are shared by the household. They hold no amounts, so adding one reveals nothing about anyone's private accounts."
                actions={
                    <Button size="sm" iconLeading={Plus} onClick={() => setEditing("new")}>
                        Add category
                    </Button>
                }
            />

            <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
                {CATEGORY_GROUPS.map((group) => {
                    const inGroup = categories.filter((c) => c.groupId === group.id);
                    return (
                        <Card key={group.id} title={group.name} icon={Tag01}>
                            <ul className="flex flex-col divide-y divide-secondary">
                                {inGroup.map((c) => (
                                    <li key={c.id} className="flex items-center justify-between gap-3 px-4 py-2.5 sm:px-5">
                                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                                            <span className={c.archived ? "text-sm text-tertiary line-through" : "text-sm font-medium text-primary"}>
                                                {c.name}
                                            </span>
                                            {!c.builtin && (
                                                <Badge size="sm" type="modern" color="gray">
                                                    Ours
                                                </Badge>
                                            )}
                                            {data.usage[c.id] ? (
                                                <a
                                                    href={`${FINANCE}/transactions?category=${c.id}&from=2000-01-01`}
                                                    className="text-xs text-tertiary hover:underline"
                                                >
                                                    {pluralise(data.usage[c.id], "transaction")}
                                                </a>
                                            ) : null}
                                        </div>
                                        {!c.builtin && (
                                            <div className="flex shrink-0 gap-1">
                                                <Button size="sm" color="link-gray" onClick={() => setEditing(c)}>
                                                    Rename
                                                </Button>
                                                <Button
                                                    size="sm"
                                                    color="link-gray"
                                                    iconLeading={c.archived ? RefreshCcw01 : Archive}
                                                    onClick={() => void archive(c, !c.archived)}
                                                >
                                                    {c.archived ? "Restore" : "Archive"}
                                                </Button>
                                            </div>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        </Card>
                    );
                })}
            </div>

            <Card title="Privacy and imports" icon={Lock01}>
                <div className="flex flex-col gap-2 px-4 py-4 text-sm text-tertiary sm:px-5">
                    <p>
                        Household Finance is only for the portal's owners. A private account, its transactions, imports and balance are visible to its owner
                        alone: they're never part of the other person's overview, totals, search or export. A shared account is visible to both, and either can
                        import and categorise.
                    </p>
                    <p>
                        No banking passwords, bank connections or full account numbers are stored. Imports keep each row's date, amount, description and the
                        bank's balance, plus the file's fingerprint (SHA-256) so the same file is recognised again. Categories are only ever set by a person;
                        nothing is decided by AI.
                    </p>
                </div>
            </Card>

            {editing && (
                <CategoryDialog
                    category={editing === "new" ? null : editing}
                    onClose={() => setEditing(null)}
                    onSaved={(c) => {
                        setCategories((list) => (list.some((x) => x.id === c.id) ? list.map((x) => (x.id === c.id ? c : x)) : [...list, c]));
                        setEditing(null);
                    }}
                />
            )}
        </>
    );
};

const CategoryDialog = ({ category, onClose, onSaved }: { category: CategoryDef | null; onClose: () => void; onSaved: (c: CategoryDef) => void }) => {
    const [name, setName] = useState(category?.name ?? "");
    const [groupId, setGroupId] = useState(category?.groupId ?? "lifestyle");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const group = CATEGORY_GROUPS.find((g) => g.id === groupId)!;
    const groups = category ? CATEGORY_GROUPS.filter((g) => g.kind === category.kind) : CATEGORY_GROUPS;
    return (
        <PortalDialog
            isOpen
            onOpenChange={(o) => !o && onClose()}
            title={category ? `Rename ${category.name}` : "Add a category"}
            icon={Tag01}
            onSubmit={async () => {
                if (!name.trim()) return setError("Name the category");
                setBusy(true);
                setError(null);
                try {
                    const { category: saved } = category
                        ? await financeApi.updateCategory(category.id, { version: category.version, name: name.trim(), groupId })
                        : await financeApi.createCategory({ name: name.trim(), kind: group.kind, groupId });
                    onSaved(saved);
                } catch (e) {
                    setError(errorMessage(e));
                } finally {
                    setBusy(false);
                }
            }}
            footer={
                <>
                    <Button color="secondary" size="lg" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button type="submit" size="lg" isLoading={busy} showTextWhileLoading>
                        Save
                    </Button>
                </>
            }
        >
            <FormError message={error} />
            <Input label="Name" value={name} onChange={setName} isRequired />
            <NativeSelect
                label="Group"
                value={groupId}
                onChange={(e) => setGroupId(e.target.value)}
                options={groups.map((g) => ({ label: `${g.name}${g.kind === "income" ? " (money in)" : ""}`, value: g.id }))}
            />
        </PortalDialog>
    );
};
