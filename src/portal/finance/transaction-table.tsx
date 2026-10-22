// The ledger as a table, shared by Transactions and each account's page: categorise in the row,
// select several to categorise at once, and open one to add a note, mark or unmark a transfer, or
// correct a manual entry. After categorising one, it offers (never does unasked) to categorise the
// others from the same merchant.
import { useState } from "react";
import { SwitchHorizontal01, Tag01, Trash01 } from "@untitledui/icons";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { TextArea } from "@/components/base/textarea/textarea";
import { Toggle } from "@/components/base/toggle/toggle";
import { type DataColumn, DataTable } from "@/portal/components/data-table";
import { DateField } from "@/portal/components/date-field";
import { ConfirmDialog, PortalDialog } from "@/portal/components/dialog";
import { Notice } from "@/portal/components/notice";
import { useToast } from "@/portal/components/toast";
import { errorMessage } from "@/portal/lib/api";
import type { CategoryDef } from "@/shared/finance/categories";
import { centsToDecimal, formatAud, parseInputCents } from "@/shared/finance/money";
import type { TransactionView } from "@/shared/finance/types";
import { financeApi } from "./finance-api";
import { Amount, CategorySelect, accountHref, categoryName, shortDate } from "./shared";

interface Offer {
    transaction: TransactionView;
    categoryId: string;
    count: number;
}

export const TransactionTable = ({
    title,
    description,
    initial,
    categories,
    showAccount = true,
    emptyState,
    actions,
}: {
    title: string;
    description?: string;
    initial: TransactionView[];
    categories: CategoryDef[];
    showAccount?: boolean;
    emptyState: React.ReactNode;
    actions?: React.ReactNode;
}) => {
    const toast = useToast();
    const [rows, setRows] = useState(initial);
    const [offer, setOffer] = useState<Offer | null>(null);
    const [open, setOpen] = useState<TransactionView | null>(null);
    const [bulkCategory, setBulkCategory] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const replace = (updated: TransactionView) => setRows((list) => list.map((r) => (r.id === updated.id ? updated : r)));

    const categorise = async (row: TransactionView, categoryId: string | null) => {
        try {
            const { transaction } = await financeApi.updateTransaction(row.id, { version: row.version, categoryId });
            replace(transaction);
            if (categoryId && transaction.merchantKey) {
                const counts = await financeApi.similar(row.id, categoryId);
                setOffer(counts.uncategorised > 0 ? { transaction, categoryId, count: counts.uncategorised } : null);
            } else setOffer(null);
        } catch (e) {
            toast.error("Couldn't categorise", errorMessage(e));
        }
    };

    const acceptOffer = async () => {
        if (!offer) return;
        setBusy(true);
        try {
            const { updated } = await financeApi.categoriseSimilar({ transactionId: offer.transaction.id, categoryId: offer.categoryId });
            setRows((list) =>
                list.map((r) =>
                    r.merchantKey === offer.transaction.merchantKey && !r.categoryId && !r.isTransfer
                        ? { ...r, categoryId: offer.categoryId, categorySource: "manual", version: r.version + 1 }
                        : r,
                ),
            );
            toast.success(`Categorised ${updated} more as ${categoryName(categories, offer.categoryId)}`);
            setOffer(null);
        } catch (e) {
            toast.error("Couldn't categorise", errorMessage(e));
        } finally {
            setBusy(false);
        }
    };

    const columns: DataColumn<TransactionView>[] = [
        {
            id: "date",
            label: "Date",
            sortValue: (r) => r.postedOn,
            render: (r) => <span className="whitespace-nowrap text-tertiary">{shortDate(r.postedOn)}</span>,
        },
        {
            id: "description",
            label: "Description",
            isRowHeader: true,
            sortValue: (r) => r.merchant ?? r.description,
            render: (r) => (
                <div className="flex max-w-md min-w-48 flex-col">
                    <button type="button" className="truncate text-left font-medium text-primary hover:underline" onClick={() => setOpen(r)}>
                        {r.merchant ?? r.description}
                    </button>
                    {r.merchant && <span className="truncate text-xs text-tertiary">{r.description}</span>}
                    {r.note && <span className="truncate text-xs text-tertiary italic">{r.note}</span>}
                    {showAccount && (
                        <a href={accountHref(r.accountId)} className="truncate text-xs text-tertiary hover:underline md:hidden">
                            {r.accountName}
                        </a>
                    )}
                </div>
            ),
        },
        ...(showAccount
            ? [
                  {
                      id: "account",
                      label: "Account",
                      className: "max-md:hidden",
                      sortValue: (r: TransactionView) => r.accountName,
                      render: (r: TransactionView) => (
                          <a href={accountHref(r.accountId)} className="text-tertiary hover:underline">
                              {r.accountName}
                          </a>
                      ),
                  },
              ]
            : []),
        {
            id: "category",
            label: "Category",
            sortValue: (r) => (r.isTransfer ? "~transfer" : r.categoryId ? categoryName(categories, r.categoryId) : ""),
            render: (r) =>
                r.isTransfer ? (
                    <Badge size="sm" type="modern" color="gray">
                        <SwitchHorizontal01 className="mr-1 size-3" aria-hidden="true" />
                        {r.counterpart === "hidden"
                            ? "Transfer (other account not shared)"
                            : r.counterpart
                              ? `Transfer · ${r.counterpart.accountName}`
                              : "Transfer"}
                    </Badge>
                ) : (
                    <div className="w-56">
                        <CategorySelect
                            categories={categories}
                            value={r.categoryId}
                            ariaLabel={`Category for ${r.merchant ?? r.description} on ${shortDate(r.postedOn)}`}
                            onChange={(id) => void categorise(r, id)}
                        />
                    </div>
                ),
        },
        {
            id: "amount",
            label: "Amount",
            sortValue: (r) => r.amountCents,
            className: "text-right",
            render: (r) => <Amount cents={r.amountCents} className="font-medium" />,
        },
    ];

    return (
        <div className="flex flex-col gap-4">
            {offer && (
                <Notice
                    title={`Categorise ${offer.count} more from ${offer.transaction.merchant ?? offer.transaction.merchantKey}?`}
                    color="brand"
                    actions={
                        <>
                            <Button size="sm" onClick={() => void acceptOffer()} isLoading={busy} showTextWhileLoading>
                                Categorise {offer.count} as {categoryName(categories, offer.categoryId)}
                            </Button>
                            <Button size="sm" color="secondary" onClick={() => setOffer(null)}>
                                Not now
                            </Button>
                        </>
                    }
                >
                    Only uncategorised ones are changed. Anything already categorised keeps its category.
                </Notice>
            )}
            <DataTable
                title={title}
                description={description}
                rows={rows}
                columns={columns}
                searchText={(r) => `${r.description} ${r.merchant ?? ""} ${r.note ?? ""} ${r.accountName} ${categoryName(categories, r.categoryId)}`}
                searchPlaceholder="Search these transactions"
                selectable
                actions={actions}
                bulkActions={(ids, clear) => (
                    <>
                        <div className="w-60">
                            <CategorySelect
                                categories={categories}
                                value={bulkCategory}
                                ariaLabel="Category for the selected transactions"
                                onChange={setBulkCategory}
                            />
                        </div>
                        <Button
                            size="sm"
                            iconLeading={Tag01}
                            isLoading={busy}
                            onClick={async () => {
                                setBusy(true);
                                try {
                                    const result = await financeApi.bulkCategorise(ids, bulkCategory);
                                    setRows((list) =>
                                        list.map((r) =>
                                            ids.includes(r.id) && !r.isTransfer
                                                ? { ...r, categoryId: bulkCategory, categorySource: bulkCategory ? "manual" : null, version: r.version + 1 }
                                                : r,
                                        ),
                                    );
                                    toast.success(
                                        `Categorised ${result.updated}`,
                                        result.skipped ? `${result.skipped} skipped (transfers or unchanged)` : undefined,
                                    );
                                    clear();
                                } catch (e) {
                                    toast.error("Couldn't categorise", errorMessage(e));
                                } finally {
                                    setBusy(false);
                                }
                            }}
                        >
                            Apply to selected
                        </Button>
                    </>
                )}
                emptyState={emptyState}
                initialSort={{ column: "date", direction: "descending" }}
                pageSize={50}
            />
            {open && (
                <TransactionDialog
                    key={open.id}
                    transaction={open}
                    categories={categories}
                    onClose={() => setOpen(null)}
                    onSaved={(t) => {
                        replace(t);
                        setOpen(null);
                    }}
                    onDeleted={(id) => {
                        setRows((list) => list.filter((r) => r.id !== id));
                        setOpen(null);
                    }}
                />
            )}
        </div>
    );
};

const TransactionDialog = ({
    transaction: t,
    categories,
    onClose,
    onSaved,
    onDeleted,
}: {
    transaction: TransactionView;
    categories: CategoryDef[];
    onClose: () => void;
    onSaved: (t: TransactionView) => void;
    onDeleted: (id: string) => void;
}) => {
    const toast = useToast();
    const manual = t.source === "manual";
    const [note, setNote] = useState(t.note ?? "");
    const [isTransfer, setIsTransfer] = useState(t.isTransfer);
    const [categoryId, setCategoryId] = useState(t.categoryId);
    const [postedOn, setPostedOn] = useState<string | null>(t.postedOn);
    const [amount, setAmount] = useState(centsToDecimal(t.amountCents));
    const [description, setDescription] = useState(t.description);
    const [busy, setBusy] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const amountCents = parseInputCents(amount);

    const save = async () => {
        if (manual && (amountCents === null || amountCents === 0)) return;
        setBusy(true);
        try {
            const body: Record<string, unknown> = { version: t.version, note: note.trim() || null, isTransfer };
            if (!isTransfer) body.categoryId = categoryId;
            if (manual) Object.assign(body, { postedOn, amountCents, description: description.trim() });
            const { transaction } = await financeApi.updateTransaction(t.id, body);
            toast.success("Saved");
            onSaved(transaction);
        } catch (e) {
            toast.error("Couldn't save", errorMessage(e));
        } finally {
            setBusy(false);
        }
    };

    return (
        <>
            <PortalDialog
                isOpen
                onOpenChange={(o) => !o && onClose()}
                title={t.merchant ?? t.description}
                description={`${shortDate(t.postedOn)} · ${t.accountName} · ${formatAud(t.amountCents, { signed: true })}`}
                onSubmit={() => void save()}
                footer={
                    <>
                        {manual && (
                            <Button color="secondary-destructive" size="lg" iconLeading={Trash01} onClick={() => setConfirmDelete(true)} className="sm:mr-auto">
                                Delete
                            </Button>
                        )}
                        <Button color="secondary" size="lg" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button type="submit" size="lg" isLoading={busy} showTextWhileLoading>
                            Save
                        </Button>
                    </>
                }
            >
                {manual ? (
                    <>
                        <DateField label="Date" value={postedOn} onChange={setPostedOn} isRequired />
                        <Input label="Description" value={description} onChange={setDescription} isRequired />
                        <Input
                            label="Amount"
                            value={amount}
                            onChange={setAmount}
                            hint="Negative for money out, e.g. -24.50"
                            isInvalid={amountCents === null || amountCents === 0}
                            inputMode="decimal"
                        />
                    </>
                ) : (
                    <p className="text-sm text-tertiary">
                        From the bank: <span className="text-secondary">{t.description}</span>
                        {t.bankCategory ? ` · bank category “${t.bankCategory}”` : ""}. Imported transactions keep the bank's date, amount and description.
                    </p>
                )}
                <Toggle
                    className="w-full"
                    label="Transfer between our own accounts"
                    hint={
                        t.counterpart && t.counterpart !== "hidden"
                            ? `Linked to ${t.counterpart.accountName} on ${shortDate(t.counterpart.postedOn)}. Turning this off unlinks both sides.`
                            : t.counterpart === "hidden"
                              ? "Linked to an account that isn't shared with you."
                              : "Transfers aren't income or spending (a savings top-up, a credit-card repayment)."
                    }
                    isSelected={isTransfer}
                    isDisabled={t.counterpart === "hidden"}
                    onChange={setIsTransfer}
                />
                {!isTransfer && <CategorySelect categories={categories} value={categoryId} label="Category" size="md" onChange={setCategoryId} />}
                <TextArea label="Note" value={note} onChange={setNote} rows={2} placeholder="Only for the household" />
            </PortalDialog>
            <ConfirmDialog
                isOpen={confirmDelete}
                onOpenChange={setConfirmDelete}
                title="Delete this entry?"
                description="It's removed from balances and totals. The change is kept in the history."
                confirmLabel="Delete"
                destructive
                onConfirm={async () => {
                    try {
                        await financeApi.deleteTransaction(t.id);
                        toast.success("Deleted");
                        onDeleted(t.id);
                    } catch (e) {
                        toast.error("Couldn't delete", errorMessage(e));
                    }
                }}
            />
        </>
    );
};
