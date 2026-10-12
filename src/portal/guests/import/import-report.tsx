// What an applied import did, row by row. Shown straight after importing and for past imports.
import { Download01, FileCheck02 } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { type DataColumn, DataTable } from "@/portal/components/data-table";
import { Empty } from "@/portal/components/empty";
import { Notice } from "@/portal/components/notice";
import { Timestamp } from "@/portal/components/timestamp";
import { ActionBadge } from "@/portal/guests/import/household-review";
import { pluralise } from "@/portal/lib/format";
import { usePortal } from "@/portal/portal-context";
import type { ImportReport, ImportReportRow, ImportSummary } from "@/shared/portal/guest-import";

export const summaryText = (summary: ImportSummary) =>
    [
        summary.guests.create && pluralise(summary.guests.create, "guest") + " added",
        summary.guests.update + summary.guests.link && pluralise(summary.guests.update + summary.guests.link, "guest") + " updated or linked",
        summary.guests.unchanged && pluralise(summary.guests.unchanged, "guest") + " already up to date",
        summary.guests.skip && pluralise(summary.guests.skip, "row") + " skipped",
        summary.errors && pluralise(summary.errors, "row") + " not imported",
        summary.households.create && pluralise(summary.households.create, "new household"),
    ]
        .filter(Boolean)
        .join(", ") || "Nothing to change";

export const ImportReportView = ({ report, onDone }: { report: ImportReport; onDone?: () => void }) => {
    const { can } = usePortal();
    const columns: DataColumn<ImportReportRow & { id: string }>[] = [
        { id: "line", label: "Line", sortValue: (r) => r.line, render: (r) => <span className="text-tertiary tabular-nums">{r.line}</span> },
        { id: "name", label: "Guest", isRowHeader: true, sortValue: (r) => r.name, render: (r) => <span className="font-medium text-primary">{r.name}</span> },
        {
            id: "action",
            label: "Result",
            sortValue: (r) => r.action,
            render: (r) =>
                r.action === "error" ? <span className="text-sm font-medium text-error-primary">Not imported</span> : <ActionBadge action={r.action} />,
        },
        {
            id: "household",
            label: "Household",
            sortValue: (r) => r.householdName,
            render: (r) => r.householdName ?? <span className="text-quaternary">—</span>,
            className: "max-md:hidden",
        },
        {
            id: "notes",
            label: "Notes",
            render: (r) =>
                r.notes.length ? (
                    <ul className="flex max-w-120 flex-col gap-0.5 text-sm text-tertiary">
                        {r.notes.map((note) => (
                            <li key={note}>{note}</li>
                        ))}
                    </ul>
                ) : (
                    <span className="text-quaternary">—</span>
                ),
            className: "max-lg:hidden",
        },
    ];
    return (
        <div className="flex flex-col gap-6">
            <Notice
                color={report.summary.errors ? "warning" : "success"}
                title={`Imported ${report.fileName ? `“${report.fileName}”` : "the file"}`}
                actions={
                    <>
                        {can("wedding.export") && (
                            <Button
                                size="sm"
                                color="secondary"
                                iconLeading={Download01}
                                href={`/api/portal/wedding/guests/imports/${report.id}/report.csv`}
                                download
                            >
                                Download report (CSV)
                            </Button>
                        )}
                        <Button size="sm" color="secondary" href="/portal/wedding/households">
                            Go to households
                        </Button>
                        {onDone && (
                            <Button size="sm" color="link-gray" onClick={onDone}>
                                Import another file
                            </Button>
                        )}
                    </>
                }
            >
                <p>
                    {summaryText(report.summary)}. <Timestamp iso={report.createdAt} /> by {report.actor}.
                </p>
                <p className="mt-1">Nothing was sent to anyone. Re-importing the same file later only applies what changed.</p>
            </Notice>
            <DataTable
                title="Import report"
                description="Every row in the file and what happened to it."
                rows={report.rows.map((r) => ({ ...r, id: String(r.line) }))}
                columns={columns}
                searchText={(r) => `${r.name} ${r.householdName ?? ""} ${r.notes.join(" ")}`}
                searchPlaceholder="Search the report"
                initialSort={{ column: "line", direction: "ascending" }}
                pageSize={50}
                emptyState={<Empty icon={FileCheck02} title="No rows" description="The file had no guests." />}
            />
        </div>
    );
};
