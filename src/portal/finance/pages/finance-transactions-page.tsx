// Transactions: the ledger for a date range, filtered by account, category or kind, with search,
// categorising (one, many, or the others from a merchant), likely transfers to confirm, entering a
// cash or missing transaction by hand, and CSV export of exactly what's shown.
import { useState } from "react";
import { Check, Download01, FilterLines, Plus, SwitchHorizontal01, Tag01, XClose } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { NativeSelect } from "@/components/base/select/select-native";
import { Card } from "@/portal/components/card";
import { DateField } from "@/portal/components/date-field";
import { PortalDialog } from "@/portal/components/dialog";
import { Empty } from "@/portal/components/empty";
import { useToast } from "@/portal/components/toast";
import { errorMessage } from "@/portal/lib/api";
import type { PageData } from "@/portal/lib/page-types";
import { parseInputCents } from "@/shared/finance/money";
import type { TransferSuggestion } from "@/shared/finance/types";
import { clientKey, financeApi } from "../finance-api";
import { Amount, CategorySelect, FINANCE, FinanceHeader, categoryOptions, shortDate } from "../shared";
import { TransactionTable } from "../transaction-table";

export const FinanceTransactionsPage = ({ data }: { data: PageData<"finance-transactions"> }) => {
    const f = data.filters;
    const [from, setFrom] = useState<string | null>(f.from);
    const [to, setTo] = useState<string | null>(f.to);
    const [account, setAccount] = useState(f.accountId ?? "");
    const [category, setCategory] = useState(f.categoryId ?? "");
    const [show, setShow] = useState(f.show ?? "");
    const [q, setQ] = useState(f.q);
    const [adding, setAdding] = useState(false);

    const params = (overrides: Record<string, string> = {}) => {
        const p = new URLSearchParams();
        const values: Record<string, string> = { from: from ?? "", to: to ?? "", account, category, show, q, ...overrides };
        for (const [k, v] of Object.entries(values)) if (v) p.set(k, v);
        return p.toString();
    };
    const active = [f.accountId, f.categoryId, f.show, f.q].filter(Boolean).length;

    return (
        <>
            <FinanceHeader
                title="Transactions"
                crumbs={[{ label: "Transactions" }]}
                description={`${shortDate(f.from)} to ${shortDate(f.to)}. Categorise in the list, or select several to categorise at once.`}
                actions={
                    <>
                        <Button size="sm" color="secondary" iconLeading={Download01} href={`/api/portal/finance/transactions.csv?${params()}`}>
                            Export CSV
                        </Button>
                        <Button
                            size="sm"
                            color="secondary"
                            iconLeading={Plus}
                            onClick={() => setAdding(true)}
                            isDisabled={!data.accounts.some((a) => !a.archived)}
                        >
                            Add by hand
                        </Button>
                    </>
                }
            />

            <form
                aria-label="Filter transactions"
                className="flex flex-col gap-3 rounded-xl bg-primary p-4 shadow-xs ring-1 ring-secondary ring-inset"
                onSubmit={(e) => {
                    e.preventDefault();
                    window.location.assign(`${FINANCE}/transactions?${params()}`);
                }}
            >
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-6 xl:items-end">
                    <DateField label="From" value={from} onChange={setFrom} />
                    <DateField label="To" value={to} onChange={setTo} />
                    <NativeSelect
                        label="Account"
                        size="sm"
                        value={account}
                        onChange={(e) => setAccount(e.target.value)}
                        options={[{ label: "All accounts", value: "" }, ...data.accounts.map((a) => ({ label: a.name, value: a.id }))]}
                    />
                    <NativeSelect
                        label="Category"
                        size="sm"
                        value={category}
                        onChange={(e) => setCategory(e.target.value)}
                        options={categoryOptions(data.categories, { any: "Any category", current: f.categoryId })}
                    />
                    <NativeSelect
                        label="Show"
                        size="sm"
                        value={show}
                        onChange={(e) => setShow(e.target.value as typeof show)}
                        options={[
                            { label: "Everything", value: "" },
                            { label: "Uncategorised only", value: "uncategorised" },
                            { label: "Transfers only", value: "transfers" },
                            { label: "Entered by hand", value: "manual" },
                        ]}
                    />
                    <Input label="Search" size="sm" value={q} onChange={setQ} placeholder="Merchant, description or note" type="search" />
                </div>
                <div className="flex flex-wrap gap-3">
                    <Button type="submit" size="sm" iconLeading={FilterLines}>
                        Apply filters
                    </Button>
                    {active > 0 && (
                        <Button size="sm" color="link-gray" iconLeading={XClose} href={`${FINANCE}/transactions?from=${f.from}&to=${f.to}`}>
                            Clear filters
                        </Button>
                    )}
                </div>
            </form>

            {data.truncated && <p className="text-sm text-warning-primary">Showing the latest 2,000 transactions. Narrow the dates to see the rest.</p>}

            <TransactionTable
                title="Transactions"
                initial={data.transactions}
                categories={data.categories}
                emptyState={
                    <Empty
                        size="sm"
                        icon={Tag01}
                        title={active ? "Nothing matches these filters" : "No transactions in these dates"}
                        description={active ? "Try other filters or dates." : "Import a CSV export from your bank, or widen the dates."}
                        actions={
                            <Button size="sm" href={`${FINANCE}/import`}>
                                Import transactions
                            </Button>
                        }
                    />
                }
            />

            <TransferSuggestions initial={data.suggestions} />

            {adding && <ManualDialog data={data} onClose={() => setAdding(false)} />}
        </>
    );
};

const TransferSuggestions = ({ initial }: { initial: TransferSuggestion[] }) => {
    const toast = useToast();
    const [list, setList] = useState(initial);
    const drop = (s: TransferSuggestion) => setList((l) => l.filter((x) => x.out.id !== s.out.id));
    return (
        <section id="transfers">
            <Card title={`Likely transfers${list.length ? ` (${list.length})` : ""}`} icon={SwitchHorizontal01}>
                <p className="border-b border-secondary px-4 py-3 text-sm text-tertiary sm:px-5">
                    The same amount leaving one of your accounts and arriving in another within three days, in the last 120 days. Confirm the real ones so they
                    aren't counted as spending and income.
                </p>
                {list.length ? (
                    <ul className="flex flex-col divide-y divide-secondary">
                        {list.map((s) => (
                            <li key={`${s.out.id}:${s.in.id}`} className="flex flex-col gap-3 px-4 py-3 sm:px-5 lg:flex-row lg:items-center lg:justify-between">
                                <div className="grid min-w-0 flex-1 grid-cols-1 gap-2 sm:grid-cols-2">
                                    {[s.out, s.in].map((t) => (
                                        <div key={t.id} className="flex min-w-0 flex-col">
                                            <span className="truncate text-sm font-medium text-primary">{t.accountName}</span>
                                            <span className="truncate text-xs text-tertiary">
                                                {shortDate(t.postedOn)} · {t.description}
                                            </span>
                                            <Amount cents={t.amountCents} className="text-sm" />
                                        </div>
                                    ))}
                                </div>
                                <div className="flex gap-2">
                                    <Button
                                        size="sm"
                                        iconLeading={Check}
                                        onClick={async () => {
                                            try {
                                                await financeApi.linkTransfer(s.out.id, s.in.id);
                                                drop(s);
                                                toast.success("Marked as a transfer", "Reload to see it in the list.");
                                            } catch (e) {
                                                toast.error("Couldn't link", errorMessage(e));
                                            }
                                        }}
                                    >
                                        It's a transfer
                                    </Button>
                                    <Button
                                        size="sm"
                                        color="secondary"
                                        onClick={async () => {
                                            try {
                                                await financeApi.dismissTransfer(s.out.id, s.in.id);
                                                drop(s);
                                            } catch (e) {
                                                toast.error("Couldn't dismiss", errorMessage(e));
                                            }
                                        }}
                                    >
                                        Not a transfer
                                    </Button>
                                </div>
                            </li>
                        ))}
                    </ul>
                ) : (
                    <p className="px-4 py-3 text-sm text-tertiary sm:px-5">No likely transfers to check.</p>
                )}
            </Card>
        </section>
    );
};

const ManualDialog = ({ data, onClose }: { data: PageData<"finance-transactions">; onClose: () => void }) => {
    const toast = useToast();
    const accounts = data.accounts.filter((a) => !a.archived);
    const [accountId, setAccountId] = useState(
        data.filters.accountId && accounts.some((a) => a.id === data.filters.accountId) ? data.filters.accountId : (accounts[0]?.id ?? ""),
    );
    const [postedOn, setPostedOn] = useState<string | null>(data.today);
    const [description, setDescription] = useState("");
    const [direction, setDirection] = useState<"out" | "in">("out");
    const [amount, setAmount] = useState("");
    const [categoryId, setCategoryId] = useState<string | null>(null);
    const [key] = useState(clientKey);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const cents = parseInputCents(amount);
    const valid = !!accountId && !!postedOn && description.trim() && cents !== null && cents > 0;

    return (
        <PortalDialog
            isOpen
            onOpenChange={(o) => !o && onClose()}
            title="Add a transaction by hand"
            description="For cash, or something the bank's export hasn't caught up with. An import will ask before adding the same thing again."
            icon={Plus}
            onSubmit={async () => {
                if (!valid) {
                    setError("Fill in the account, date, description and an amount above zero.");
                    return;
                }
                setBusy(true);
                try {
                    await financeApi.createTransaction({
                        accountId,
                        postedOn,
                        description: description.trim(),
                        amountCents: direction === "out" ? -cents! : cents!,
                        categoryId,
                        clientId: key,
                    });
                    toast.success("Added");
                    window.location.reload();
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
                        Add
                    </Button>
                </>
            }
        >
            {error && (
                <p role="alert" className="text-sm text-error-primary">
                    {error}
                </p>
            )}
            <NativeSelect
                label="Account"
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                options={accounts.map((a) => ({ label: a.name, value: a.id }))}
            />
            <DateField label="Date" value={postedOn} onChange={setPostedOn} isRequired />
            <Input label="Description" value={description} onChange={setDescription} isRequired />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <NativeSelect
                    label="Money"
                    value={direction}
                    onChange={(e) => setDirection(e.target.value as "out" | "in")}
                    options={[
                        { label: "Out (spent)", value: "out" },
                        { label: "In (received)", value: "in" },
                    ]}
                />
                <Input
                    label="Amount"
                    value={amount}
                    onChange={setAmount}
                    placeholder="0.00"
                    inputMode="decimal"
                    isRequired
                    isInvalid={!!amount && (cents === null || cents <= 0)}
                />
            </div>
            <CategorySelect categories={data.categories} value={categoryId} label="Category" size="md" onChange={setCategoryId} />
        </PortalDialog>
    );
};
