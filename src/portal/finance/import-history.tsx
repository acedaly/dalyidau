// The imports so far: what each file added, skipped and couldn't read, with review (while open)
// and undo (once committed).
import { useState } from "react";
import { ClockRewind } from "@untitledui/icons";
import { BadgeWithDot } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { Card } from "@/portal/components/card";
import { ConfirmDialog } from "@/portal/components/dialog";
import { useToast } from "@/portal/components/toast";
import { errorMessage } from "@/portal/lib/api";
import { formatDateTime, pluralise } from "@/portal/lib/format";
import { PRESET_LABELS } from "@/shared/finance/csv-import";
import type { ImportStatus, ImportSummary } from "@/shared/finance/types";
import { financeApi } from "./finance-api";
import { importHref, shortDate } from "./shared";

const STATUS: Record<ImportStatus, { label: string; color: "success" | "gray" | "warning" | "brand" }> = {
    review: { label: "Waiting for review", color: "warning" },
    committing: { label: "Importing", color: "brand" },
    committed: { label: "Imported", color: "success" },
    cancelled: { label: "Cancelled", color: "gray" },
    undone: { label: "Undone", color: "gray" },
};

export const ImportHistory = ({ imports, showAccount = true }: { imports: ImportSummary[]; showAccount?: boolean }) => {
    const toast = useToast();
    const [undoing, setUndoing] = useState<ImportSummary | null>(null);
    return (
        <Card title="Imports" icon={ClockRewind}>
            {imports.length ? (
                <ul className="flex flex-col divide-y divide-secondary">
                    {imports.map((i) => (
                        <li key={i.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:px-5">
                            <div className="flex min-w-0 flex-col gap-0.5">
                                <span className="truncate text-sm font-medium text-primary">
                                    {i.filename}
                                    {showAccount ? <span className="font-normal text-tertiary"> · {i.accountName}</span> : null}
                                </span>
                                <span className="text-xs text-tertiary">
                                    {PRESET_LABELS[i.preset]} · {i.firstOn ? `${shortDate(i.firstOn)} to ${shortDate(i.lastOn)}` : "no dates"} ·{" "}
                                    {formatDateTime(i.createdAt)}
                                </span>
                                <span className="text-xs text-tertiary">
                                    {i.status === "committed" ? `${pluralise(i.rowsImported ?? 0, "transaction")} added` : `${pluralise(i.rowsNew, "new row")}`}
                                    {i.rowsDuplicate ? ` · ${i.rowsDuplicate} already imported` : ""}
                                    {i.rowsPossible ? ` · ${pluralise(i.rowsPossible, "possible duplicate")}` : ""}
                                    {i.rowsInvalid ? ` · ${i.rowsInvalid} couldn't be read` : ""}
                                </span>
                            </div>
                            <div className="flex shrink-0 items-center gap-2">
                                <BadgeWithDot size="sm" type="modern" color={STATUS[i.status].color}>
                                    {STATUS[i.status].label}
                                </BadgeWithDot>
                                {(i.status === "review" || i.status === "committed") && (
                                    <Button size="sm" color="link-color" href={importHref(i.id)}>
                                        {i.status === "review" ? "Review" : "Details"}
                                    </Button>
                                )}
                                {i.status === "committed" && (
                                    <Button size="sm" color="link-gray" onClick={() => setUndoing(i)}>
                                        Undo
                                    </Button>
                                )}
                            </div>
                        </li>
                    ))}
                </ul>
            ) : (
                <p className="px-4 py-3 text-sm text-tertiary sm:px-5">No imports yet.</p>
            )}
            <ConfirmDialog
                isOpen={!!undoing}
                onOpenChange={(o) => !o && setUndoing(null)}
                title="Undo this import?"
                description={`The ${pluralise(undoing?.rowsImported ?? 0, "transaction")} it added are taken out of balances and totals, with their categories and any transfer links. They're kept in the history, and the same file can be imported again.`}
                confirmLabel="Undo import"
                destructive
                onConfirm={async () => {
                    if (!undoing) return;
                    try {
                        await financeApi.undo(undoing.id, undoing.version);
                        toast.success("Import undone");
                        window.location.reload();
                    } catch (e) {
                        toast.error("Couldn't undo", errorMessage(e));
                    }
                }}
            />
        </Card>
    );
};
