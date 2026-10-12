// Guest CSV import: choose a file, review the dry run, then import. Nothing is written until the
// second step.
import { useState } from "react";
import { UploadCloud02 } from "@untitledui/icons";
import { FileUploadDropZone } from "@/components/application/file-upload/file-upload-base";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { Toggle } from "@/components/base/toggle/toggle";
import { PortalDialog } from "@/portal/components/dialog";
import { FormError } from "@/portal/components/form";
import { useToast } from "@/portal/components/toast";
import { api, errorMessage } from "@/portal/lib/api";
import { pluralise } from "@/portal/lib/format";
import type { Guest } from "@/shared/portal/types";

interface ImportResult {
    dryRun: boolean;
    columns: { header: string; field: string | null }[];
    rows: { line: number; action: "create" | "update" | "skip" | "error"; name: string; message: string | null }[];
    summary: { create: number; update: number; skip: number; error: number; newHouseholds: number };
}

const FIELD_LABELS: Record<string, string> = {
    firstName: "First name",
    lastName: "Last name",
    fullName: "Full name",
    email: "Email",
    phone: "Phone",
    household: "Household",
    side: "Side",
    groupName: "Group",
    ageGroup: "Age group",
    dietary: "Dietary",
    notes: "Notes",
    tags: "Tags",
    rsvp: "RSVP (all invited events)",
    events: "Events (semicolon separated)",
};

export const ImportDialog = ({
    isOpen,
    onOpenChange,
    onImported,
}: {
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
    onImported: (guests: Guest[]) => void;
}) => {
    const toast = useToast();
    const [file, setFile] = useState<{ name: string; text: string } | null>(null);
    const [fromSayIDo, setFromSayIDo] = useState(false);
    const [preview, setPreview] = useState<ImportResult | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const reset = () => {
        setFile(null);
        setPreview(null);
        setError(null);
    };

    const run = async (dryRun: boolean, source = file) => {
        if (!source) return;
        setBusy(true);
        setError(null);
        try {
            const response = await api<{ result: ImportResult; guests?: Guest[] }>("POST", "/api/portal/wedding/guests/import", {
                csv: source.text,
                dryRun,
                rsvpSource: fromSayIDo ? "sayido" : "import",
            });
            if (dryRun) setPreview(response.result);
            else {
                toast.success(
                    "Import complete",
                    `${pluralise(response.result.summary.create, "guest")} added, ${pluralise(response.result.summary.update, "guest")} updated.`,
                );
                onImported(response.guests ?? []);
                reset();
                onOpenChange(false);
            }
        } catch (e) {
            setError(errorMessage(e));
        } finally {
            setBusy(false);
        }
    };

    const problems = preview?.rows.filter((r) => r.action === "error" || r.action === "skip") ?? [];
    const willChange = preview ? preview.summary.create + preview.summary.update : 0;

    return (
        <PortalDialog
            isOpen={isOpen}
            onOpenChange={(open) => {
                if (!open) reset();
                onOpenChange(open);
            }}
            title="Import guests"
            description="Upload a CSV with a header row. Matching guests (same email, or same name) are updated; everyone else is added."
            icon={UploadCloud02}
            size="lg"
            footer={
                <>
                    <Button color="secondary" size="lg" onClick={() => (preview ? reset() : onOpenChange(false))} isDisabled={busy}>
                        {preview ? "Choose another file" : "Cancel"}
                    </Button>
                    {preview && (
                        <Button size="lg" onClick={() => run(false)} isLoading={busy} showTextWhileLoading isDisabled={willChange === 0}>
                            Import {pluralise(willChange, "guest")}
                        </Button>
                    )}
                </>
            }
        >
            <FormError message={error} />
            {!preview ? (
                <>
                    <FileUploadDropZone
                        accept=".csv,text/csv"
                        maxSize={1_000_000}
                        hint="CSV up to 1 MB · up to 2,000 guests"
                        isDisabled={busy}
                        onDropFiles={async (files) => {
                            const chosen = files[0];
                            if (!chosen) return;
                            const loaded = { name: chosen.name, text: await chosen.text() };
                            setFile(loaded);
                            await run(true, loaded);
                        }}
                        onDropUnacceptedFiles={() => setError("Choose a .csv file. In a spreadsheet, use File → Download → CSV.")}
                        onSizeLimitExceed={() => setError("That file is larger than 1 MB. Split it into smaller files.")}
                    />
                    <Toggle
                        label="These RSVPs came from Say I Do"
                        hint="Marks any RSVP column as Say I Do responses, so they're labelled correctly while Say I Do is the live RSVP form."
                        isSelected={fromSayIDo}
                        onChange={setFromSayIDo}
                    />
                    <details className="text-sm text-tertiary">
                        <summary className="cursor-pointer font-semibold text-secondary">Which columns are recognised?</summary>
                        <p className="mt-2">
                            {Object.values(FIELD_LABELS).join(", ")}, plus any custom field by its label. Other columns are ignored. Events must already exist
                            in the portal.
                        </p>
                    </details>
                </>
            ) : (
                <div className="flex flex-col gap-4">
                    <p className="text-sm text-secondary">
                        <span className="font-semibold">{file?.name}</span>: {pluralise(preview.summary.create, "new guest")},{" "}
                        {pluralise(preview.summary.update, "update")}
                        {preview.summary.newHouseholds > 0 && `, ${pluralise(preview.summary.newHouseholds, "new household")}`}
                        {problems.length > 0 && `, ${pluralise(problems.length, "row")} skipped`}.
                    </p>
                    <div className="flex flex-wrap gap-2">
                        {preview.columns.map((c) => (
                            <Badge key={c.header} size="sm" type="modern" color="gray">
                                {c.header} → {c.field ? (FIELD_LABELS[c.field] ?? c.field.replace("custom:", "Custom: ")) : "ignored"}
                            </Badge>
                        ))}
                    </div>
                    {problems.length > 0 && (
                        <div className="max-h-56 overflow-y-auto rounded-lg ring-1 ring-secondary">
                            <table className="w-full text-left text-sm">
                                <caption className="sr-only">Rows that won't be imported</caption>
                                <thead className="bg-secondary text-xs text-quaternary">
                                    <tr>
                                        <th scope="col" className="px-3 py-2 font-semibold">
                                            Line
                                        </th>
                                        <th scope="col" className="px-3 py-2 font-semibold">
                                            Name
                                        </th>
                                        <th scope="col" className="px-3 py-2 font-semibold">
                                            Problem
                                        </th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-secondary">
                                    {problems.map((row) => (
                                        <tr key={row.line}>
                                            <td className="px-3 py-2 text-tertiary tabular-nums">{row.line}</td>
                                            <td className="px-3 py-2 text-secondary">{row.name}</td>
                                            <td className="px-3 py-2 text-error-primary">{row.message}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            )}
        </PortalDialog>
    );
};
