// Household Finance overview: where the money went in a date range (against the period before),
// every account's balance with how sure we are of it, six months of income and spending, spending by
// category, and what needs attention (uncategorised transactions, likely transfers).
import { useState } from "react";
import { AlertTriangle, ArrowDownLeft, ArrowUpRight, Bank, Plus, Scales02, SwitchHorizontal01, Tag01, Upload01, Wallet03 } from "@untitledui/icons";
import { ButtonGroup, ButtonGroupItem } from "@/components/base/button-group/button-group";
import { Button } from "@/components/base/buttons/button";
import { NativeSelect } from "@/components/base/select/select-native";
import { Card } from "@/portal/components/card";
import { DateField } from "@/portal/components/date-field";
import { Empty } from "@/portal/components/empty";
import { MetricCard } from "@/portal/components/metric-card";
import { Notice } from "@/portal/components/notice";
import { formatDateTime, pluralise } from "@/portal/lib/format";
import type { PageData } from "@/portal/lib/page-types";
import { monthEnd, monthStart } from "@/shared/finance/dates";
import { formatAud } from "@/shared/finance/money";
import { CategoryBars, MonthBars } from "../finance-charts";
import { Amount, BalanceAmount, BalanceBadge, FINANCE, FinanceHeader, accountHref, balanceExplanation, kindLabel, shortDate } from "../shared";

type Preset = "month" | "last-month" | "3-months" | "year" | "custom";

const presetRange = (preset: Exclude<Preset, "custom">, today: string) => {
    switch (preset) {
        case "month":
            return { from: monthStart(today), to: today };
        case "last-month":
            return { from: monthStart(today, -1), to: monthEnd(monthStart(today, -1)) };
        case "3-months":
            return { from: monthStart(today, -2), to: today };
        case "year":
            return { from: `${today.slice(0, 4)}-01-01`, to: today };
    }
};

const change = (now: number, before: number, higherIsGood: boolean) => {
    if (before === 0) return undefined;
    const pct = Math.round(((now - before) / Math.abs(before)) * 100);
    if (pct === 0) return undefined;
    return { value: `${Math.abs(pct)}%`, trend: pct > 0 === higherIsGood ? ("positive" as const) : ("negative" as const) };
};

export const FinanceOverviewPage = ({ data }: { data: PageData<"finance-overview"> }) => {
    const o = data.overview;
    const today = data.today;
    const current = (["month", "last-month", "3-months", "year"] as const).find((p) => {
        const r = presetRange(p, today);
        return r.from === o.from && r.to === o.to;
    });
    const [preset, setPreset] = useState<Preset>(current ?? "custom");
    const [from, setFrom] = useState<string | null>(o.from);
    const [to, setTo] = useState<string | null>(o.to);
    const [account, setAccount] = useState(o.accountIds[0] ?? "");

    const go = (range: { from: string; to: string }, accountId = account) => {
        const params = new URLSearchParams({ from: range.from, to: range.to });
        if (accountId) params.set("accounts", accountId);
        window.location.assign(`${FINANCE}?${params}`);
    };
    const transactionsHref = (extra: Record<string, string>) => {
        const params = new URLSearchParams({ from: o.from, to: o.to, ...(o.accountIds[0] ? { account: o.accountIds[0] } : {}), ...extra });
        return `${FINANCE}/transactions?${params}`;
    };

    if (!o.accounts.length)
        return (
            <>
                <FinanceHeader title="Household Finance" description="Where our money goes, from the banks' own exports." />
                <Empty
                    icon={Wallet03}
                    title="Add your first account"
                    description="Start with an everyday account. Add its balance on a date, then import a CSV export from NAB (or another bank) and categorise what comes in."
                    actions={
                        <Button size="md" iconLeading={Plus} href={`${FINANCE}/accounts?new=1`}>
                            Add an account
                        </Button>
                    }
                />
            </>
        );

    const shown = o.accounts.filter((a) => !a.archived && (!o.accountIds.length || o.accountIds.includes(a.id)));
    const t = o.totals;
    const p = o.previous;
    const spending = o.byCategory.filter((c) => c.cents > 0);

    return (
        <>
            <FinanceHeader title="Household Finance" description="Where our money goes, from the banks' own exports." />

            <section
                aria-label="Period and accounts"
                className="flex flex-col gap-3 rounded-xl bg-primary p-4 shadow-xs ring-1 ring-secondary ring-inset lg:flex-row lg:items-end"
            >
                <ButtonGroup
                    size="sm"
                    aria-label="Period"
                    selectionMode="single"
                    disallowEmptySelection
                    selectedKeys={new Set([preset])}
                    className="max-w-full overflow-x-auto"
                    onSelectionChange={(keys) => {
                        const next = [...keys][0] as Preset | undefined;
                        if (!next) return;
                        setPreset(next);
                        if (next !== "custom") go(presetRange(next, today));
                    }}
                >
                    <ButtonGroupItem id="month">This month</ButtonGroupItem>
                    <ButtonGroupItem id="last-month">Last month</ButtonGroupItem>
                    <ButtonGroupItem id="3-months">3 months</ButtonGroupItem>
                    <ButtonGroupItem id="year">This year</ButtonGroupItem>
                    <ButtonGroupItem id="custom">Custom</ButtonGroupItem>
                </ButtonGroup>
                {preset === "custom" && (
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                        <DateField label="From" value={from} onChange={setFrom} />
                        <DateField label="To" value={to} onChange={setTo} />
                        <Button size="md" color="secondary" isDisabled={!from || !to} onClick={() => from && to && go({ from, to })}>
                            Show
                        </Button>
                    </div>
                )}
                <NativeSelect
                    label="Accounts"
                    size="sm"
                    className="lg:ml-auto lg:w-64"
                    value={account}
                    onChange={(e) => {
                        setAccount(e.target.value);
                        go({ from: o.from, to: o.to }, e.target.value);
                    }}
                    options={[
                        { label: "All accounts", value: "" },
                        ...o.accounts.map((a) => ({ label: `${a.name}${a.archived ? " (archived)" : ""}`, value: a.id })),
                    ]}
                />
            </section>

            <p className="-mt-4 text-sm text-tertiary">
                {shortDate(o.from)} to {shortDate(o.to)}, compared with {shortDate(p.from)} to {shortDate(p.to)}. Transfers between our own accounts aren't
                counted.
            </p>

            <section aria-label="Totals" className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <MetricCard
                    label="Money in"
                    value={formatAud(t.incomeCents)}
                    icon={ArrowDownLeft}
                    change={change(t.incomeCents, p.incomeCents, true)}
                    detail={`${formatAud(p.incomeCents)} the period before`}
                />
                <MetricCard
                    label="Spending"
                    value={formatAud(t.expenseCents)}
                    icon={ArrowUpRight}
                    change={change(t.expenseCents, p.expenseCents, false)}
                    detail={`${formatAud(p.expenseCents)} the period before`}
                />
                <MetricCard
                    label="Left over"
                    value={formatAud(t.netCents)}
                    icon={Scales02}
                    detail={t.netCents >= 0 ? "More came in than went out" : "More went out than came in"}
                />
                <MetricCard
                    label="To categorise"
                    value={o.uncategorisedCount}
                    icon={Tag01}
                    detail={
                        o.uncategorisedCount ? (
                            <a href={transactionsHref({ show: "uncategorised", from: "2000-01-01" })} className="hover:underline">
                                Review uncategorised
                            </a>
                        ) : (
                            "Everything is categorised"
                        )
                    }
                />
            </section>

            {(o.transferSuggestionCount > 0 || o.position.incompleteAccounts > 0) && (
                <div className="flex flex-col gap-3">
                    {o.transferSuggestionCount > 0 && (
                        <Notice
                            title={`${pluralise(o.transferSuggestionCount, "possible transfer")} between your accounts`}
                            color="brand"
                            actions={
                                <Button size="sm" color="secondary" iconLeading={SwitchHorizontal01} href={`${FINANCE}/transactions#transfers`}>
                                    Review transfers
                                </Button>
                            }
                        >
                            Until they're confirmed, a savings top-up or a credit-card repayment counts as spending and income.
                        </Notice>
                    )}
                    {o.position.incompleteAccounts > 0 && (
                        <Notice title={`${pluralise(o.position.incompleteAccounts, "account")} without a starting balance`} color="warning">
                            Their balances can't be worked out, so they aren't in the totals below. Add a starting balance on each account's page.
                        </Notice>
                    )}
                </div>
            )}

            <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
                <div className="flex flex-col gap-6 xl:col-span-2">
                    <Card title="Spending by category" icon={Tag01}>
                        <div className="px-4 py-4 sm:px-5">
                            {spending.length ? (
                                <CategoryBars
                                    rows={spending.map((c) => ({
                                        key: c.categoryId ?? "uncategorised",
                                        name: c.name,
                                        detail: c.groupName,
                                        cents: c.cents,
                                        count: c.count,
                                    }))}
                                    totalCents={t.expenseCents}
                                    hrefFor={(key) => transactionsHref(key === "uncategorised" ? { show: "uncategorised" } : { category: key })}
                                />
                            ) : (
                                <p className="text-sm text-tertiary">No spending in this period.</p>
                            )}
                        </div>
                    </Card>
                    <Card title="Six months" icon={Scales02}>
                        <div className="px-4 py-4 sm:px-5">
                            <MonthBars months={o.months} caption="Income and spending for each of the last six months" />
                        </div>
                    </Card>
                </div>

                <div className="flex flex-col gap-6">
                    <Card
                        title="Balances"
                        icon={Bank}
                        action={
                            <Button size="sm" color="link-color" href={`${FINANCE}/accounts`}>
                                All accounts
                            </Button>
                        }
                    >
                        <ul className="flex flex-col divide-y divide-secondary">
                            {shown.map((a) => (
                                <li key={a.id} className="flex flex-col gap-1 px-4 py-3 sm:px-5">
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="flex min-w-0 flex-col">
                                            <a href={accountHref(a.id)} className="truncate text-sm font-medium text-primary hover:underline">
                                                {a.name}
                                            </a>
                                            <span className="text-xs text-tertiary">
                                                {kindLabel(a.kind)}
                                                {a.institution ? ` · ${a.institution}` : ""}
                                            </span>
                                        </div>
                                        <BalanceAmount balance={a.balance} kind={a.kind} className="text-md font-semibold text-primary" />
                                    </div>
                                    <div className="flex flex-wrap items-center gap-2">
                                        <BalanceBadge balance={a.balance} />
                                        {a.lastTransactionOn && <span className="text-xs text-tertiary">Transactions to {shortDate(a.lastTransactionOn)}</span>}
                                    </div>
                                    {a.balance.status !== "matches_bank" && a.balance.status !== "reconciled" && (
                                        <p className="text-xs text-tertiary">{balanceExplanation(a.balance)}</p>
                                    )}
                                </li>
                            ))}
                        </ul>
                        <div className="flex flex-col gap-0.5 border-t border-secondary px-4 py-3 text-sm sm:px-5">
                            <div className="flex justify-between">
                                <span className="text-tertiary">What we have</span>
                                <span className="text-primary tabular-nums">{formatAud(o.position.assetsCents)}</span>
                            </div>
                            <div className="flex justify-between">
                                <span className="text-tertiary">What we owe</span>
                                <span className="text-primary tabular-nums">{formatAud(o.position.liabilitiesCents)}</span>
                            </div>
                            <div className="flex justify-between font-semibold">
                                <span className="text-secondary">Net position</span>
                                <span className="text-primary tabular-nums">{formatAud(o.position.netCents)}</span>
                            </div>
                            {o.position.unconfirmedAccounts > 0 && (
                                <p className="mt-1 flex items-center gap-1.5 text-xs text-tertiary">
                                    <AlertTriangle className="size-3.5 text-fg-warning-secondary" aria-hidden="true" />
                                    Includes {pluralise(o.position.unconfirmedAccounts, "balance")} not confirmed against the bank.
                                </p>
                            )}
                        </div>
                    </Card>

                    <Card
                        title="Recent transactions"
                        icon={SwitchHorizontal01}
                        action={
                            <Button size="sm" color="link-color" href={`${FINANCE}/transactions`}>
                                All
                            </Button>
                        }
                    >
                        {o.recent.length ? (
                            <ul className="flex flex-col divide-y divide-secondary">
                                {o.recent.map((r) => (
                                    <li key={r.id} className="flex items-center justify-between gap-3 px-4 py-2.5 sm:px-5">
                                        <div className="flex min-w-0 flex-col">
                                            <span className="truncate text-sm font-medium text-primary">{r.merchant ?? r.description}</span>
                                            <span className="text-xs text-tertiary">
                                                {shortDate(r.postedOn)} · {r.accountName}
                                                {r.isTransfer ? " · Transfer" : r.categoryId ? "" : " · Uncategorised"}
                                            </span>
                                        </div>
                                        <Amount cents={r.amountCents} className="text-sm" />
                                    </li>
                                ))}
                            </ul>
                        ) : (
                            <p className="px-4 py-3 text-sm text-tertiary sm:px-5">Nothing imported yet.</p>
                        )}
                        <div className="border-t border-secondary px-4 py-3 sm:px-5">
                            <Button size="sm" color="secondary" iconLeading={Upload01} href={`${FINANCE}/import`}>
                                Import transactions
                            </Button>
                            {o.lastImport && (
                                <p className="mt-2 text-xs text-tertiary">
                                    Last import {formatDateTime(o.lastImport.committedAt)} · {o.lastImport.accountName}
                                </p>
                            )}
                        </div>
                    </Card>
                </div>
            </div>
            <p className="text-xs text-tertiary">
                Figures come only from imported and entered transactions. Spending nets off refunds in the same category; uncategorised money out counts as
                spending until it's categorised. {o.to === today ? "Today's figures may change as the bank's export catches up." : ""}
            </p>
        </>
    );
};
