// Import transactions: choose the account and a CSV export, check the columns were understood
// (NAB is recognised by its headers; other banks by preset or by choosing columns), then stage it
// for review. Nothing reaches the ledger until the review is committed.
import { useMemo, useState } from "react";
import { AlertTriangle, FileCheck02, Upload01 } from "@untitledui/icons";
import { FileUploadDropZone } from "@/components/application/file-upload/file-upload-base";
import { Button } from "@/components/base/buttons/button";
import { NativeSelect } from "@/components/base/select/select-native";
import { Toggle } from "@/components/base/toggle/toggle";
import { Card } from "@/portal/components/card";
import { Empty } from "@/portal/components/empty";
import { FormError } from "@/portal/components/form";
import { Notice } from "@/portal/components/notice";
import { errorMessage } from "@/portal/lib/api";
import { formatDateTime } from "@/portal/lib/format";
import type { PageData } from "@/portal/lib/page-types";
import { type ImportMapping, LIMITS, PRESETS, PRESET_LABELS, type PresetId, presetMapping } from "@/shared/finance/csv-import";
import { DATE_FORMATS, DATE_FORMAT_LABELS, type DateFormat } from "@/shared/finance/dates";
import type { InspectResult } from "@/shared/finance/types";
import { financeApi } from "../finance-api";
import { ImportHistory } from "../import-history";
import { FINANCE, FinanceHeader, importHref } from "../shared";

const BLANK: ImportMapping = {
    preset: "custom",
    hasHeader: true,
    skipLines: 0,
    dateColumn: 0,
    dateFormat: "d/M/yyyy",
    descriptionColumns: [1],
    fallbackDescriptionColumn: null,
    merchantColumn: null,
    amountMode: "signed",
    amountColumn: 2,
    debitColumn: null,
    creditColumn: null,
    invertAmounts: false,
    balanceColumn: null,
    categoryColumn: null,
    accountColumn: null,
};

export const FinanceImportPage = ({ data }: { data: PageData<"finance-import"> }) => {
    const accounts = data.accounts.filter((a) => !a.archived);
    const [accountId, setAccountId] = useState(data.accountId ?? accounts[0]?.id ?? "");
    const [file, setFile] = useState<{ name: string; text: string } | null>(null);
    const [inspection, setInspection] = useState<InspectResult | null>(null);
    const [mapping, setMapping] = useState<ImportMapping | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const load = async (chosen: { name: string; text: string }, account = accountId) => {
        setError(null);
        setBusy(true);
        try {
            const { inspection } = await financeApi.inspect(account, chosen.text);
            setFile(chosen);
            setInspection(inspection);
            setMapping(inspection.mapping ?? { ...BLANK, hasHeader: !/^\d/.test(inspection.preview[0]?.[0] ?? "") });
        } catch (e) {
            setError(errorMessage(e));
        } finally {
            setBusy(false);
        }
    };

    const stage = async () => {
        if (!file || !mapping) return;
        setError(null);
        setBusy(true);
        try {
            const { detail } = await financeApi.stage({ accountId, filename: file.name.slice(0, 200), text: file.text, mapping });
            window.location.assign(importHref(detail.summary.id));
        } catch (e) {
            setError(errorMessage(e));
            setBusy(false);
        }
    };

    if (!accounts.length)
        return (
            <>
                <FinanceHeader title="Import transactions" crumbs={[{ label: "Import" }]} />
                <Empty
                    icon={Upload01}
                    title="Add an account first"
                    description="Transactions are imported into an account, so its balance can be checked against the bank's."
                    actions={
                        <Button size="md" href={`${FINANCE}/accounts?new=1`}>
                            Add an account
                        </Button>
                    }
                />
            </>
        );

    return (
        <>
            <FinanceHeader
                title="Import transactions"
                crumbs={[{ label: "Import" }]}
                description="Export transactions as CSV from your bank's website and add the file here. You'll see every row before anything is saved."
                actions={<></>}
            />

            <section aria-label="Choose a file" className="flex max-w-3xl flex-col gap-4">
                <FormError message={error} />
                <NativeSelect
                    label="Account"
                    value={accountId}
                    onChange={(e) => {
                        setAccountId(e.target.value);
                        if (file) void load(file, e.target.value);
                    }}
                    options={accounts.map((a) => ({ label: a.name, value: a.id }))}
                    className="sm:w-80"
                />
                <FileUploadDropZone
                    accept=".csv,text/csv,text/plain"
                    allowsMultiple={false}
                    maxSize={LIMITS.fileBytes}
                    hint="CSV up to 2 MB · up to 5,000 transactions"
                    isDisabled={busy || !accountId}
                    onDropFiles={async (files) => {
                        const chosen = files[0];
                        if (chosen) await load({ name: chosen.name, text: await chosen.text() });
                    }}
                    onDropUnacceptedFiles={() =>
                        setError("Choose a .csv file. In NAB Internet Banking, open the account's transactions and export them as CSV.")
                    }
                    onSizeLimitExceed={() => setError("That file is larger than 2 MB. Export a shorter date range.")}
                />
                {busy && (
                    <p className="text-sm text-tertiary" role="status">
                        Reading the file…
                    </p>
                )}
                <details className="text-sm text-tertiary">
                    <summary className="cursor-pointer font-semibold text-secondary">Where's the export in NAB Internet Banking?</summary>
                    <p className="mt-2">
                        Open the account, choose the transactions' date range, then export or download as CSV. Overlapping date ranges are fine: anything
                        already imported is recognised and skipped. The file's account number is only compared with the last digits you saved; it's never
                        stored.
                    </p>
                </details>
            </section>

            {file && inspection && mapping && (
                <Layout file={file} inspection={inspection} mapping={mapping} onChange={setMapping} onStage={() => void stage()} busy={busy} />
            )}

            <ImportHistory imports={data.imports} />
        </>
    );
};

const Layout = ({
    file,
    inspection,
    mapping,
    onChange,
    onStage,
    busy,
}: {
    file: { name: string; text: string };
    inspection: InspectResult;
    mapping: ImportMapping;
    onChange: (m: ImportMapping) => void;
    onStage: () => void;
    busy: boolean;
}) => {
    const header = mapping.hasHeader ? (inspection.preview[mapping.skipLines] ?? []) : [];
    const columns = useMemo(
        () =>
            Array.from({ length: inspection.columns }, (_, i) => ({
                value: String(i),
                label: `Column ${i + 1}${header[i] ? ` · ${header[i]}` : inspection.preview[mapping.skipLines]?.[i] ? ` · e.g. ${inspection.preview[mapping.skipLines + (mapping.hasHeader ? 1 : 0)]?.[i] ?? ""}` : ""}`,
            })),
        [inspection, header, mapping.hasHeader, mapping.skipLines],
    );
    const optional = [{ value: "", label: "None" }, ...columns];
    const set = (patch: Partial<ImportMapping>) => onChange({ ...mapping, ...patch });
    const col = (v: string) => (v === "" ? null : Number(v));
    const recognised = inspection.mapping !== null;

    return (
        <section aria-label="Check the columns" className="flex flex-col gap-4">
            {inspection.sameFileImportedAt && (
                <Notice title="This file was imported before" color="warning">
                    On {formatDateTime(inspection.sameFileImportedAt)}. You can still review it: rows already in the ledger are marked and won't be added again.
                </Notice>
            )}
            {inspection.dateAmbiguous && (
                <Notice title="Check the dates" color="warning">
                    Every date in this file could be read day-first or month-first. It's read day-first (23/10/2026), as Australian banks write them. Change the
                    date format if that's wrong.
                </Notice>
            )}

            <Card title={recognised ? `Recognised as ${PRESET_LABELS[mapping.preset]}` : "Choose the columns"} icon={recognised ? FileCheck02 : AlertTriangle}>
                <div className="flex flex-col gap-4 px-4 py-4 sm:px-5">
                    <p className="text-sm text-tertiary">
                        {file.name} · {inspection.lines} lines.{" "}
                        {recognised
                            ? "Check the first rows look right, then review every row before anything is saved."
                            : "This layout wasn't recognised. Pick the bank or tell us which column holds what."}
                    </p>
                    <div
                        tabIndex={0}
                        role="region"
                        aria-label="The first rows of the file"
                        className="overflow-x-auto rounded-lg ring-1 ring-secondary focus-visible:outline-2 focus-visible:outline-brand"
                    >
                        <table className="w-full text-left text-xs">
                            <caption className="sr-only">The first rows of the file</caption>
                            <thead className="bg-secondary text-tertiary">
                                <tr>
                                    {Array.from({ length: inspection.columns }, (_, i) => (
                                        <th key={i} scope="col" className="px-3 py-2 font-medium whitespace-nowrap">
                                            {i + 1}
                                        </th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-secondary">
                                {inspection.preview.map((row, r) => (
                                    <tr key={r} className={r < mapping.skipLines + (mapping.hasHeader ? 1 : 0) ? "text-quaternary" : "text-secondary"}>
                                        {Array.from({ length: inspection.columns }, (_, i) => (
                                            <td key={i} className="max-w-56 truncate px-3 py-1.5 whitespace-nowrap">
                                                {row[i] ?? ""}
                                            </td>
                                        ))}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>

                    <details open={!recognised} className="flex flex-col gap-4">
                        <summary className="cursor-pointer text-sm font-semibold text-secondary">Adjust the layout</summary>
                        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                            <NativeSelect
                                label="Bank layout"
                                size="sm"
                                value={mapping.preset}
                                onChange={(e) => {
                                    const preset = e.target.value as PresetId;
                                    const found = preset === "custom" ? null : presetMapping(preset, inspection.preview);
                                    onChange(found ?? { ...mapping, preset });
                                }}
                                options={PRESETS.map((p) => ({ label: PRESET_LABELS[p], value: p }))}
                            />
                            <NativeSelect
                                label="Date format"
                                size="sm"
                                value={mapping.dateFormat}
                                onChange={(e) => set({ dateFormat: e.target.value as DateFormat })}
                                options={DATE_FORMATS.map((f) => ({ label: DATE_FORMAT_LABELS[f], value: f }))}
                            />
                            <NativeSelect
                                label="Lines to skip before the data"
                                size="sm"
                                value={String(mapping.skipLines)}
                                onChange={(e) => set({ skipLines: Number(e.target.value) })}
                                options={[0, 1, 2, 3, 4, 5].map((n) => ({ label: String(n), value: String(n) }))}
                            />
                            <NativeSelect
                                label="Date"
                                size="sm"
                                value={String(mapping.dateColumn)}
                                onChange={(e) => set({ dateColumn: Number(e.target.value) })}
                                options={columns}
                            />
                            <NativeSelect
                                label="Description"
                                size="sm"
                                value={String(mapping.descriptionColumns[0])}
                                onChange={(e) => set({ descriptionColumns: [Number(e.target.value)] })}
                                options={columns}
                            />
                            <NativeSelect
                                label="Merchant (optional)"
                                size="sm"
                                value={mapping.merchantColumn === null ? "" : String(mapping.merchantColumn)}
                                onChange={(e) => set({ merchantColumn: col(e.target.value) })}
                                options={optional}
                            />
                            <NativeSelect
                                label="Amounts"
                                size="sm"
                                value={mapping.amountMode}
                                onChange={(e) => set({ amountMode: e.target.value as ImportMapping["amountMode"] })}
                                options={[
                                    { label: "One column, money out negative", value: "signed" },
                                    { label: "Separate debit and credit columns", value: "debit_credit" },
                                ]}
                            />
                            {mapping.amountMode === "signed" ? (
                                <NativeSelect
                                    label="Amount"
                                    size="sm"
                                    value={mapping.amountColumn === null ? "" : String(mapping.amountColumn)}
                                    onChange={(e) => set({ amountColumn: col(e.target.value) })}
                                    options={optional}
                                />
                            ) : (
                                <>
                                    <NativeSelect
                                        label="Debit (money out)"
                                        size="sm"
                                        value={mapping.debitColumn === null ? "" : String(mapping.debitColumn)}
                                        onChange={(e) => set({ debitColumn: col(e.target.value) })}
                                        options={optional}
                                    />
                                    <NativeSelect
                                        label="Credit (money in)"
                                        size="sm"
                                        value={mapping.creditColumn === null ? "" : String(mapping.creditColumn)}
                                        onChange={(e) => set({ creditColumn: col(e.target.value) })}
                                        options={optional}
                                    />
                                </>
                            )}
                            <NativeSelect
                                label="Balance (optional)"
                                size="sm"
                                value={mapping.balanceColumn === null ? "" : String(mapping.balanceColumn)}
                                onChange={(e) => set({ balanceColumn: col(e.target.value) })}
                                options={optional}
                            />
                        </div>
                        <div className="mt-4 flex flex-col gap-3">
                            <Toggle
                                className="w-full"
                                label="The first line (after any skipped) is a header"
                                isSelected={mapping.hasHeader}
                                onChange={(v) => set({ hasHeader: v })}
                            />
                            <Toggle
                                className="w-full"
                                label="Money out is shown as positive"
                                hint="Some credit-card exports do this. Turn it on so purchases count as money out."
                                isSelected={mapping.invertAmounts}
                                onChange={(v) => set({ invertAmounts: v })}
                            />
                        </div>
                    </details>

                    <div className="flex flex-wrap gap-3">
                        <Button size="md" iconLeading={FileCheck02} onClick={onStage} isLoading={busy} showTextWhileLoading>
                            Review the rows
                        </Button>
                    </div>
                </div>
            </Card>
        </section>
    );
};
