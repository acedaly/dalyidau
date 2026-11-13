// Budget: where the money stands, by category and item. Read-only here; amounts and payments are
// changed in the wedding admin, which keeps the supplier links and payment history together.
import { useMemo } from "react";
import { Wallet02 } from "@untitledui/icons";
import { BadgeWithDot } from "@/components/base/badges/badges";
import { ProgressBar } from "@/components/base/progress-indicators/progress-indicators";
import { formatDate, formatMoney, percent, todayIso } from "@/portal/lib/format";
import { amountOf, paymentState } from "@/portal/pages/budget-page";
import { usePortal } from "@/portal/portal-context";
import type { BudgetItem, DashboardStats, PaymentState } from "@/shared/portal/types";
import { EmptyRow, LoadError, LoadingRows, PageTitle, Row, RowList, Section, SectionLink, StatGrid, StatTile } from "../components";
import { BUDGET, DASHBOARD, useApi } from "../data";
import { useNavigation } from "../navigation";

const PAYMENT: Record<PaymentState, { label: string; color: "success" | "blue" | "gray" | "error" }> = {
    paid: { label: "Paid", color: "success" },
    partial: { label: "Part paid", color: "blue" },
    unpaid: { label: "Unpaid", color: "gray" },
    overdue: { label: "Overdue", color: "error" },
};

/** Committed is each item's actual cost, or its estimate until there is one (as the portal's budget page counts it). */
export const budgetTotals = (list: BudgetItem[], today: string) => {
    const committed = list.reduce((sum, item) => sum + amountOf(item), 0);
    const paid = list.reduce((sum, item) => sum + Math.min(item.paidCents, amountOf(item) || item.paidCents), 0);
    const overdue = list.filter((item) => paymentState(item, today) === "overdue").reduce((sum, item) => sum + Math.max(amountOf(item) - item.paidCents, 0), 0);
    const categories = new Map<string, { committed: number; paid: number }>();
    for (const item of list) {
        const entry = categories.get(item.category) ?? { committed: 0, paid: 0 };
        entry.committed += amountOf(item);
        entry.paid += item.paidCents;
        categories.set(item.category, entry);
    }
    return { committed, paid, overdue, categories: [...categories.entries()].sort((a, b) => b[1].committed - a[1].committed) };
};

export const BudgetView = () => {
    const { wedding } = usePortal();
    const { portalUrl } = useNavigation();
    const items = useApi<{ items: BudgetItem[] }>(BUDGET);
    const dashboard = useApi<{ stats: DashboardStats }>(DASHBOARD);
    const currency = dashboard.data?.stats.budget?.currency ?? "AUD";
    const total = dashboard.data?.stats.budget?.totalCents ?? 0;
    const today = todayIso(wedding.timeZone);
    const list = items.data?.items ?? [];
    const money = (cents: number) => formatMoney(cents, currency, { whole: true });

    const totals = useMemo(() => budgetTotals(list, today), [list, today]);

    const sorted = useMemo(() => {
        const rank: Record<PaymentState, number> = { overdue: 0, unpaid: 1, partial: 2, paid: 3 };
        return [...list].sort(
            (a, b) => rank[paymentState(a, today)] - rank[paymentState(b, today)] || (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999"),
        );
    }, [list, today]);

    if (items.error && !items.data)
        return (
            <>
                <PageTitle title="Budget" />
                <Section>
                    <LoadError error={items.error} onRetry={items.reload} />
                </Section>
            </>
        );

    return (
        <>
            <PageTitle title="Budget" subtitle={total ? `${money(total)} budget · ${percent(totals.committed, total)}% committed` : undefined} />

            {!items.data ? (
                <Section flush>
                    <LoadingRows />
                </Section>
            ) : (
                <>
                    <Section>
                        <StatGrid>
                            <StatTile label="Committed" value={money(totals.committed)} />
                            <StatTile label="Paid" value={money(totals.paid)} tone="success" />
                            <StatTile label="Still to pay" value={money(Math.max(totals.committed - totals.paid, 0))} />
                            <StatTile label="Overdue" value={money(totals.overdue)} tone={totals.overdue ? "error" : "default"} />
                        </StatGrid>
                        {total > 0 && (
                            <div className="mt-4">
                                <ProgressBar
                                    value={Math.min(percent(totals.committed, total), 100)}
                                    labelPosition="bottom"
                                    aria-label="Budget committed"
                                    valueFormatter={() => `${money(Math.max(total - totals.committed, 0))} left to commit`}
                                />
                            </div>
                        )}
                    </Section>

                    {totals.categories.length > 0 && (
                        <Section label="By category">
                            <ul className="flex flex-col gap-4">
                                {totals.categories.map(([category, sums]) => (
                                    <li key={category} className="flex flex-col gap-1.5">
                                        <div className="flex items-baseline justify-between gap-3 text-sm">
                                            <span className="truncate font-medium text-secondary">{category}</span>
                                            <span className="shrink-0 text-tertiary tabular-nums">
                                                {money(sums.paid)} of {money(sums.committed)}
                                            </span>
                                        </div>
                                        <ProgressBar value={Math.min(percent(sums.paid, sums.committed), 100)} aria-label={`${category}: paid`} />
                                    </li>
                                ))}
                            </ul>
                        </Section>
                    )}

                    <Section label="Items" flush action={<SectionLink href={`${portalUrl}/budget`}>Edit in admin</SectionLink>}>
                        {sorted.length === 0 ? (
                            <EmptyRow icon={Wallet02}>No budget items yet.</EmptyRow>
                        ) : (
                            <RowList label="Budget items">
                                {sorted.map((item) => {
                                    const state = paymentState(item, today);
                                    return (
                                        <Row
                                            key={item.id}
                                            title={item.description}
                                            detail={[
                                                item.category,
                                                item.supplierName,
                                                item.dueDate && state !== "paid" ? `due ${formatDate(item.dueDate)}` : null,
                                            ]
                                                .filter(Boolean)
                                                .join(" · ")}
                                            trailing={
                                                <span className="flex flex-col items-end gap-1">
                                                    <span className="text-sm font-medium text-primary tabular-nums">
                                                        {formatMoney(amountOf(item), currency)}
                                                    </span>
                                                    <BadgeWithDot size="sm" type="pill-color" color={PAYMENT[state].color}>
                                                        {PAYMENT[state].label}
                                                    </BadgeWithDot>
                                                </span>
                                            }
                                        />
                                    );
                                })}
                            </RowList>
                        )}
                    </Section>
                </>
            )}
        </>
    );
};
