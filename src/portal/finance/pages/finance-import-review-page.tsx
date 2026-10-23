// Reviewing an import before anything reaches the ledger: what's new, what's already there (never
// imported again), what might be (a person decides), what couldn't be read (with the reason), and
// what's excluded. Commit adds the rest in one step; cancel drops the file.
import { useMemo, useState } from "react";
import { AlertTriangle, CheckCircle, Copy01, FileX02, SlashCircle01, Upload01 } from "@untitledui/icons";
import { Tabs } from "@/components/application/tabs/tabs";
import { BadgeWithDot } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { type DataColumn, DataTable } from "@/portal/components/data-table";
import { ConfirmDialog } from "@/portal/components/dialog";
import { MetricCard } from "@/portal/components/metric-card";
import { Notice } from "@/portal/components/notice";
import { useToast } from "@/portal/components/toast";
import { errorMessage } from "@/portal/lib/api";
import { pluralise } from "@/portal/lib/format";
import type { PageData } from "@/portal/lib/page-types";
import { PRESET_LABELS } from "@/shared/finance/csv-import";
import { formatAud } from "@/shared/finance/money";
import type { ImportDetail, ImportRowView } from "@/shared/finance/types";
import { financeApi } from "../finance-api";
import { Amount, FINANCE, FinanceHeader, accountHref, shortDate } from "../shared";

type Filter = "all" | "import" | "possible" | "duplicate" | "invalid" | "excluded";

const included = (r: ImportRowView) => (r.status === "new" && r.decision !== "skip") || (r.status === "possible_duplicate" && r.decision === "include");

const matches = (r: ImportRowView, f: Filter) => {
    switch (f) {
        case "all":
            return true;
        case "import":
            return included(r);
        case "possible":
            return r.status === "possible_duplicate";
        case "duplicate":
            return r.status === "duplicate";
        case "invalid":
            return r.status === "invalid";
        case "excluded":
            return r.decision === "skip";
    }
};

export const FinanceImportReviewPage = ({ data }: { data: PageData<"finance-import-review"> }) => {
    const toast = useToast();
    const [detail, setDetail] = useState<ImportDetail>(data.detail);
    const s = detail.summary;
    const plan = detail.plan;
    const open = s.status === "review";
    const [filter, setFilter] = useState<Filter>(plan.undecided ? "possible" : "all");
    const [busy, setBusy] = useState(false);
    const [confirmCancel, setConfirmCancel] = useState(false);
    const rows = useMemo(() => detail.rows.filter((r) => matches(r, filter)).map((r) => ({ ...r, id: String(r.line) })), [detail.rows, filter]);
    const count = (f: Filter) => detail.rows.filter((r) => matches(r, f)).length;

    const decide = async (decisions: { line: number; decision: "include" | "skip" }[]) => {
        if (!decisions.length) return;
        try {
            setDetail((await financeApi.decide(s.id, s.version, decisions)).detail);
        } catch (e) {
            toast.error("Couldn't save", errorMessage(e));
        }
    };

    const commit = async () => {
        setBusy(true);
        try {
            const result = await financeApi.commit(s.id, s.version);
            setDetail(result.detail);
            toast.success(`Imported ${pluralise(result.detail.summary.rowsImported ?? 0, "transaction")}`);
        } catch (e) {
            toast.error("Couldn't import", errorMessage(e));
        } finally {
            setBusy(false);
        }
    };

    const setOpening = async () => {
        if (!detail.impliedOpening) return;
        try {
            const { account: current } = await financeApi.getAccount(s.accountId);
            await financeApi.updateAccount(s.accountId, {
                version: current.version,
                openingBalanceCents: detail.impliedOpening.cents,
                openingBalanceOn: detail.impliedOpening.on,
            });
            setDetail({ ...detail, accountHasOpening: true });
            toast.success("Starting balance set");
        } catch (e) {
            toast.error("Couldn't set the starting balance", errorMessage(e));
        }
    };

    const columns: DataColumn<ImportRowView & { id: string }>[] = [
        {
            id: "line",
            label: "Line",
            sortValue: (r) => r.line,
            render: (r) => <span className="text-tertiary tabular-nums">{r.line}</span>,
            className: "max-sm:hidden",
        },
        {
            id: "date",
            label: "Date",
            sortValue: (r) => r.postedOn,
            render: (r) => <span className="whitespace-nowrap text-tertiary">{shortDate(r.postedOn) || "—"}</span>,
        },
        {
            id: "description",
            label: "Description",
            isRowHeader: true,
            sortValue: (r) => r.description,
            render: (r) => (
                <div className="flex max-w-md min-w-40 flex-col whitespace-normal">
                    <span className="truncate text-primary">{r.description ?? "(no description)"}</span>
                    {r.amountCents !== null && <Amount cents={r.amountCents} className="text-xs sm:hidden" />}
                    {r.status === "invalid" && (
                        <span className="text-xs text-error-primary">
                            Line {r.line}: {r.error}
                        </span>
                    )}
                    {r.match && (
                        <span className="text-xs text-tertiary">
                            {r.status === "duplicate" ? "Already imported: " : "Looks like: "}
                            {r.match.description} · {shortDate(r.match.postedOn)} · {formatAud(r.match.amountCents, { signed: true })}
                            {r.match.source === "manual" ? " (entered by hand)" : ""}
                        </span>
                    )}
                </div>
            ),
        },
        {
            id: "amount",
            label: "Amount",
            className: "text-right max-sm:hidden",
            sortValue: (r) => r.amountCents,
            render: (r) => (r.amountCents === null ? <span className="text-tertiary">—</span> : <Amount cents={r.amountCents} />),
        },
        {
            id: "status",
            label: "Status",
            sortValue: (r) => r.status,
            render: (r) => {
                if (r.status === "invalid")
                    return (
                        <BadgeWithDot size="sm" type="modern" color="error">
                            Can't be read
                        </BadgeWithDot>
                    );
                if (r.status === "duplicate")
                    return (
                        <BadgeWithDot size="sm" type="modern" color="gray">
                            Already imported
                        </BadgeWithDot>
                    );
                const undecided = r.status === "possible_duplicate" && r.decision === null;
                const label = undecided ? "Decide" : included(r) ? "Will import" : "Excluded";
                return (
                    <div className="flex flex-col items-start gap-1.5">
                        <BadgeWithDot size="sm" type="modern" color={undecided ? "warning" : included(r) ? "success" : "gray"}>
                            {r.status === "possible_duplicate" ? `Possible duplicate · ${label}` : label}
                        </BadgeWithDot>
                        {open && (
                            <div className="flex gap-1">
                                <Button
                                    size="xs"
                                    color={included(r) ? "primary" : "secondary"}
                                    onClick={() => void decide([{ line: r.line, decision: "include" }])}
                                    aria-label={`Import line ${r.line}`}
                                >
                                    Import
                                </Button>
                                <Button
                                    size="xs"
                                    color={r.decision === "skip" ? "primary" : "secondary"}
                                    onClick={() => void decide([{ line: r.line, decision: "skip" }])}
                                    aria-label={`Skip line ${r.line}`}
                                >
                                    Skip
                                </Button>
                            </div>
                        )}
                    </div>
                );
            },
        },
    ];

    return (
        <>
            <FinanceHeader
                title={open ? "Review import" : "Import"}
                crumbs={[{ label: "Import", href: `${FINANCE}/import` }, { label: s.filename }]}
                description={
                    <>
                        {s.filename} into{" "}
                        <a href={accountHref(s.accountId)} className="underline">
                            {s.accountName}
                        </a>{" "}
                        · {PRESET_LABELS[s.preset]} · {s.firstOn ? `${shortDate(s.firstOn)} to ${shortDate(s.lastOn)}` : "no readable dates"}
                    </>
                }
                actions={
                    open ? (
                        <>
                            <Button size="sm" color="secondary" onClick={() => setConfirmCancel(true)} isDisabled={busy}>
                                Cancel import
                            </Button>
                            <Button
                                size="sm"
                                iconLeading={Upload01}
                                onClick={() => void commit()}
                                isLoading={busy}
                                showTextWhileLoading
                                isDisabled={plan.undecided > 0}
                            >
                                Import {pluralise(plan.toImport, "transaction")}
                            </Button>
                        </>
                    ) : (
                        <Button
                            size="sm"
                            color="secondary"
                            href={`${FINANCE}/transactions?account=${s.accountId}&from=${s.firstOn ?? ""}&to=${s.lastOn ?? ""}`}
                        >
                            See the transactions
                        </Button>
                    )
                }
            />

            {s.status === "committed" && (
                <Notice title={`Imported ${pluralise(s.rowsImported ?? 0, "transaction")}`} color="success">
                    {plan.duplicates ? `${plan.duplicates} already in the ledger were skipped. ` : ""}
                    {plan.excluded ? `${plan.excluded} you excluded weren't imported. ` : ""}
                    {plan.invalid ? `${plan.invalid} couldn't be read and weren't imported: they're listed below with the reason.` : ""}
                </Notice>
            )}
            {s.status === "cancelled" && <Notice title="This import was cancelled">Nothing from it reached the ledger.</Notice>}
            {s.status === "undone" && <Notice title="This import was undone">Its transactions were taken out of balances and totals.</Notice>}
            {plan.undecided > 0 && open && (
                <Notice
                    title={`${pluralise(plan.undecided, "possible duplicate")} to decide`}
                    color="warning"
                    actions={
                        <>
                            <Button
                                size="sm"
                                color="secondary"
                                onClick={() =>
                                    void decide(
                                        detail.rows
                                            .filter((r) => r.status === "possible_duplicate" && r.decision === null)
                                            .map((r) => ({ line: r.line, decision: "skip" as const })),
                                    )
                                }
                            >
                                Skip them all
                            </Button>
                            <Button
                                size="sm"
                                color="secondary"
                                onClick={() =>
                                    void decide(
                                        detail.rows
                                            .filter((r) => r.status === "possible_duplicate" && r.decision === null)
                                            .map((r) => ({ line: r.line, decision: "include" as const })),
                                    )
                                }
                            >
                                Import them all
                            </Button>
                        </>
                    }
                >
                    Each has the same amount as a transaction already here within a few days, under a different description or entered by hand. Skip it if it's
                    the same one.
                </Notice>
            )}
            {s.warnings.map((w) => (
                <Notice key={w} title="Check this" color="warning">
                    {w}
                </Notice>
            ))}
            {open && detail.impliedOpening && !detail.accountHasOpening && (
                <Notice
                    title="Use the bank's balance as the starting balance?"
                    color="brand"
                    actions={
                        <Button size="sm" color="secondary" onClick={() => void setOpening()}>
                            Set {formatAud(detail.impliedOpening.cents)} on {shortDate(detail.impliedOpening.on)}
                        </Button>
                    }
                >
                    This account has no starting balance, so its balance can't be worked out. The file's first balance, less its first transaction, gives{" "}
                    {formatAud(detail.impliedOpening.cents)} before {shortDate(detail.impliedOpening.on)}.
                </Notice>
            )}

            <section aria-label="Summary" className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                <MetricCard label={open ? "Will import" : "Imported"} value={open ? plan.toImport : (s.rowsImported ?? 0)} icon={CheckCircle} />
                <MetricCard label="Already imported" value={plan.duplicates} icon={Copy01} />
                <MetricCard
                    label="Excluded"
                    value={plan.excluded + plan.undecided}
                    icon={SlashCircle01}
                    detail={plan.undecided ? `${plan.undecided} still to decide` : undefined}
                />
                <MetricCard
                    label="Can't be read"
                    value={plan.invalid}
                    icon={plan.invalid ? AlertTriangle : FileX02}
                    detail={plan.invalid ? "Listed with the reason" : undefined}
                />
            </section>

            {detail.rows.length > 0 && (
                <Tabs selectedKey={filter} onSelectionChange={(key) => setFilter(key as Filter)}>
                    <Tabs.List type="button-minimal" size="sm" aria-label="Which rows" className="w-max max-w-full overflow-x-auto">
                        <Tabs.Item id="all" badge={detail.rows.length || undefined}>
                            All
                        </Tabs.Item>
                        <Tabs.Item id="import" badge={count("import") || undefined}>
                            {open ? "To import" : "Imported"}
                        </Tabs.Item>
                        <Tabs.Item id="possible" badge={count("possible") || undefined}>
                            Possible duplicates
                        </Tabs.Item>
                        <Tabs.Item id="duplicate" badge={count("duplicate") || undefined}>
                            Already imported
                        </Tabs.Item>
                        <Tabs.Item id="invalid" badge={count("invalid") || undefined}>
                            Can't be read
                        </Tabs.Item>
                        <Tabs.Item id="excluded" badge={count("excluded") || undefined}>
                            Excluded
                        </Tabs.Item>
                    </Tabs.List>
                    <Tabs.Panel id={filter} className="pt-4">
                        <DataTable
                            title="Rows in the file"
                            description="Newest first. Line numbers are the file's own."
                            rows={rows}
                            columns={columns}
                            searchText={(r) => `${r.description ?? ""} ${r.error ?? ""}`}
                            emptyState={<p className="text-sm text-tertiary">No rows here.</p>}
                            pageSize={50}
                        />
                    </Tabs.Panel>
                </Tabs>
            )}
            {!detail.rows.length && s.status === "cancelled" && <p className="text-sm text-tertiary">A cancelled import's rows aren't kept.</p>}

            <ConfirmDialog
                isOpen={confirmCancel}
                onOpenChange={setConfirmCancel}
                title="Cancel this import?"
                description="The file's rows are dropped and nothing is added. You can import the file again later."
                confirmLabel="Cancel import"
                destructive
                onConfirm={async () => {
                    try {
                        await financeApi.cancel(s.id, s.version);
                        window.location.assign(`${FINANCE}/import`);
                    } catch (e) {
                        toast.error("Couldn't cancel", errorMessage(e));
                    }
                }}
            />
        </>
    );
};
