// Accounts: every account you can see, its balance and how sure we are of it, and adding one.
import { useEffect, useState } from "react";
import { Bank, Plus } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { type DataColumn, DataTable } from "@/portal/components/data-table";
import { Empty } from "@/portal/components/empty";
import type { PageData } from "@/portal/lib/page-types";
import type { AccountView } from "@/shared/finance/types";
import { AccountDialog } from "../account-form";
import { BalanceAmount, BalanceBadge, FINANCE, FinanceHeader, VisibilityBadge, accountHref, kindLabel, shortDate } from "../shared";

export const FinanceAccountsPage = ({ data }: { data: PageData<"finance-accounts"> }) => {
    const [adding, setAdding] = useState(false);
    useEffect(() => {
        if (new URLSearchParams(window.location.search).get("new") === "1") setAdding(true);
    }, []);

    const columns: DataColumn<AccountView>[] = [
        {
            id: "name",
            label: "Account",
            isRowHeader: true,
            sortValue: (a) => a.name,
            render: (a) => (
                <div className="flex min-w-40 flex-col">
                    <a href={accountHref(a.id)} className="font-medium text-primary hover:underline">
                        {a.name}
                        {a.numberHint ? <span className="ml-1 font-normal text-tertiary">··{a.numberHint}</span> : null}
                    </a>
                    <span className="text-xs text-tertiary">
                        {kindLabel(a.kind)}
                        {a.institution ? ` · ${a.institution}` : ""}
                        {a.archived ? " · Archived" : ""}
                    </span>
                </div>
            ),
        },
        {
            id: "sharing",
            label: "Sharing",
            className: "max-md:hidden",
            sortValue: (a) => a.visibility,
            render: (a) => (
                <div className="flex flex-col gap-1">
                    <VisibilityBadge visibility={a.visibility} />
                    {!a.mine && <span className="text-xs text-tertiary">{a.ownerName ? `${a.ownerName}'s` : "Not yours"}</span>}
                </div>
            ),
        },
        {
            id: "updated",
            label: "Transactions to",
            className: "max-lg:hidden",
            sortValue: (a) => a.lastTransactionOn,
            render: (a) => <span className="text-tertiary">{a.lastTransactionOn ? shortDate(a.lastTransactionOn) : "None yet"}</span>,
        },
        {
            id: "status",
            label: "Confidence",
            className: "max-sm:hidden",
            sortValue: (a) => a.balance.status,
            render: (a) => <BalanceBadge balance={a.balance} />,
        },
        {
            id: "balance",
            label: "Balance",
            className: "text-right",
            sortValue: (a) => a.balance.balanceCents,
            render: (a) => <BalanceAmount balance={a.balance} kind={a.kind} className="font-medium text-primary" />,
        },
    ];

    return (
        <>
            <FinanceHeader
                title="Accounts"
                crumbs={[{ label: "Accounts" }]}
                description="Balances are worked out from a starting balance and the transactions imported since, and checked against the bank's own balance whenever a file includes it."
                actions={
                    <Button size="sm" iconLeading={Plus} onClick={() => setAdding(true)}>
                        Add account
                    </Button>
                }
            />
            <DataTable
                title="Accounts"
                rows={data.accounts}
                columns={columns}
                searchText={(a) => `${a.name} ${a.institution ?? ""}`}
                emptyState={
                    <Empty
                        size="sm"
                        icon={Bank}
                        title="No accounts yet"
                        description="Add an everyday account first, then import its transactions."
                        actions={
                            <Button size="sm" iconLeading={Plus} onClick={() => setAdding(true)}>
                                Add account
                            </Button>
                        }
                    />
                }
            />
            {adding && (
                <AccountDialog
                    onClose={() => setAdding(false)}
                    onSaved={(account) => {
                        window.location.assign(`${accountHref(account.id)}`);
                    }}
                />
            )}
            <p className="text-sm text-tertiary">
                Moving money between your own accounts (a savings top-up, paying the credit card) is a transfer: once it's confirmed on{" "}
                <a href={`${FINANCE}/transactions#transfers`} className="underline">
                    Transactions
                </a>
                , it isn't counted as spending or income.
            </p>
        </>
    );
};
