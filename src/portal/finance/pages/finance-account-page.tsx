// One account: its balance and how sure we are of it, checking it against a statement, its imports
// (with undo), and its transactions.
import { useState } from "react";
import { Bank, CheckVerified01, ClockRewind, Edit03, Scales02, Tag01, Upload01 } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { Card } from "@/portal/components/card";
import { DateField } from "@/portal/components/date-field";
import { PortalDialog } from "@/portal/components/dialog";
import { Empty } from "@/portal/components/empty";
import { MetricCard } from "@/portal/components/metric-card";
import { Notice } from "@/portal/components/notice";
import { useToast } from "@/portal/components/toast";
import { errorMessage } from "@/portal/lib/api";
import type { PageData } from "@/portal/lib/page-types";
import { formatAud, parseInputCents } from "@/shared/finance/money";
import { AccountDialog } from "../account-form";
import { financeApi } from "../finance-api";
import { ImportHistory } from "../import-history";
import { BalanceAmount, BalanceBadge, FINANCE, FinanceHeader, VisibilityBadge, balanceExplanation, kindLabel, shortDate } from "../shared";
import { TransactionTable } from "../transaction-table";

export const FinanceAccountPage = ({ data }: { data: PageData<"finance-account"> }) => {
    const a = data.account;
    const [editing, setEditing] = useState(false);
    const [reconciling, setReconciling] = useState(false);

    return (
        <>
            <FinanceHeader
                title={a.name}
                crumbs={[{ label: "Accounts", href: `${FINANCE}/accounts` }, { label: a.name }]}
                description={
                    <span className="flex flex-wrap items-center gap-2">
                        {kindLabel(a.kind)}
                        {a.institution ? ` · ${a.institution}` : ""}
                        {a.numberHint ? ` · ··${a.numberHint}` : ""}
                        <VisibilityBadge visibility={a.visibility} />
                        {!a.mine && a.ownerName && <span className="text-sm">{a.ownerName}'s account</span>}
                    </span>
                }
                actions={
                    <>
                        <Button size="sm" color="secondary" iconLeading={Edit03} onClick={() => setEditing(true)}>
                            Edit
                        </Button>
                        <Button
                            size="sm"
                            color="secondary"
                            iconLeading={Scales02}
                            onClick={() => setReconciling(true)}
                            isDisabled={a.openingBalanceCents === null}
                        >
                            Check against a statement
                        </Button>
                        {!a.archived && (
                            <Button size="sm" iconLeading={Upload01} href={`${FINANCE}/import?account=${a.id}`}>
                                Import
                            </Button>
                        )}
                    </>
                }
            />

            {a.archived && <Notice title="This account is archived">It's left out of balances and can't take new imports. Its history stays.</Notice>}

            <section aria-label="Balance" className="grid grid-cols-1 gap-4 md:grid-cols-3">
                <MetricCard
                    label="Balance"
                    icon={Bank}
                    value={<BalanceAmount balance={a.balance} kind={a.kind} />}
                    detail={<BalanceBadge balance={a.balance} />}
                />
                <MetricCard
                    label="Starting balance"
                    icon={ClockRewind}
                    value={a.openingBalanceCents === null ? "Not set" : formatAud(a.openingBalanceCents)}
                    detail={a.openingBalanceOn ? `Before transactions on ${shortDate(a.openingBalanceOn)}` : "Needed to work out the balance"}
                />
                <MetricCard
                    label="Transactions"
                    icon={Tag01}
                    value={a.transactionCount}
                    detail={a.firstTransactionOn ? `${shortDate(a.firstTransactionOn)} to ${shortDate(a.lastTransactionOn)}` : "None imported yet"}
                />
            </section>
            <p className="-mt-2 text-sm text-tertiary">
                {balanceExplanation(a.balance)}
                {a.beforeOpeningCount > 0 &&
                    ` ${a.beforeOpeningCount} transaction${a.beforeOpeningCount === 1 ? " is" : "s are"} dated before the starting balance and not included.`}
            </p>

            <TransactionTable
                title="Transactions"
                initial={data.transactions}
                categories={data.categories}
                showAccount={false}
                emptyState={
                    <Empty
                        size="sm"
                        icon={Upload01}
                        title="No transactions yet"
                        description="Import a CSV export from the bank for this account."
                        actions={
                            <Button size="sm" href={`${FINANCE}/import?account=${a.id}`}>
                                Import transactions
                            </Button>
                        }
                    />
                }
            />
            {data.truncated && <p className="text-sm text-tertiary">Showing the latest 1,000. See Transactions for the rest.</p>}

            <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
                <ImportHistory imports={data.imports} showAccount={false} />
                <Card title="Statement checks" icon={CheckVerified01}>
                    {data.reconciliations.length ? (
                        <ul className="flex flex-col divide-y divide-secondary">
                            {data.reconciliations.map((r) => (
                                <li key={r.id} className="flex items-start justify-between gap-3 px-4 py-2.5 text-sm sm:px-5">
                                    <div className="flex flex-col">
                                        <span className="font-medium text-primary">{shortDate(r.asOf)}</span>
                                        <span className="text-xs text-tertiary">
                                            Statement {formatAud(r.statementCents)} · ledger {formatAud(r.calculatedCents)}
                                            {r.note ? ` · ${r.note}` : ""}
                                        </span>
                                    </div>
                                    <span className={r.differenceCents === 0 ? "font-medium text-primary" : "font-medium text-error-primary"}>
                                        {r.differenceCents === 0 ? "Matched" : `Off by ${formatAud(Math.abs(r.differenceCents))}`}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <p className="px-4 py-3 text-sm text-tertiary sm:px-5">
                            No checks yet. Compare with a statement's closing balance to confirm nothing's missing.
                        </p>
                    )}
                </Card>
            </div>

            {editing && <AccountDialog account={a} onClose={() => setEditing(false)} onSaved={() => window.location.reload()} />}
            {reconciling && <ReconcileDialog accountId={a.id} today={data.today} onClose={() => setReconciling(false)} />}
        </>
    );
};

const ReconcileDialog = ({ accountId, today, onClose }: { accountId: string; today: string; onClose: () => void }) => {
    const toast = useToast();
    const [asOf, setAsOf] = useState<string | null>(today);
    const [balance, setBalance] = useState("");
    const [note, setNote] = useState("");
    const [busy, setBusy] = useState(false);
    const cents = balance.trim() ? parseInputCents(balance) : null;
    return (
        <PortalDialog
            isOpen
            onOpenChange={(o) => !o && onClose()}
            title="Check against a statement"
            description="Enter the closing balance from a statement. A difference is recorded and shown, not changed: it usually means a missing or excluded transaction."
            icon={Scales02}
            onSubmit={async () => {
                if (!asOf || cents === null) return;
                setBusy(true);
                try {
                    const result = await financeApi.reconcile(accountId, { asOf, statementBalanceCents: cents, note: note.trim() || null });
                    toast.success(result.differenceCents === 0 ? "It matches" : `Off by ${formatAud(Math.abs(result.differenceCents))}`);
                    window.location.reload();
                } catch (e) {
                    toast.error("Couldn't record", errorMessage(e));
                } finally {
                    setBusy(false);
                }
            }}
            footer={
                <>
                    <Button color="secondary" size="lg" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button type="submit" size="lg" isLoading={busy} isDisabled={!asOf || cents === null}>
                        Check
                    </Button>
                </>
            }
        >
            <DateField label="Statement date" value={asOf} onChange={setAsOf} isRequired />
            <Input
                label="Closing balance"
                value={balance}
                onChange={setBalance}
                inputMode="decimal"
                isInvalid={!!balance && cents === null}
                hint="Money owed is negative."
                isRequired
            />
            <Input label="Note (optional)" value={note} onChange={setNote} />
        </PortalDialog>
    );
};
