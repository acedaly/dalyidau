// Importing from Todoist, in Settings. Choose the CSV files (one per project) or a Todoist backup
// zip, check the preview (where each project goes, what's new, already imported, changed, a
// possible duplicate or deleted here since, and what the export can't carry), choose how to
// reconcile, then import. Large imports run in rounds the server bounds; if one stops part-way,
// importing again carries on without duplicating anything.
import { useState } from "react";
import { AlertTriangle, CheckCircle, UploadCloud02 } from "@untitledui/icons";
import { FileUploadDropZone } from "@/components/application/file-upload/file-upload-base";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { ProgressBar } from "@/components/base/progress-indicators/progress-indicators";
import { RadioButton, RadioGroup } from "@/components/base/radio-buttons/radio-buttons";
import { Select } from "@/components/base/select/select";
import { Notice } from "@/portal/components/notice";
import { errorMessage } from "@/portal/lib/api";
import { formatDateTime } from "@/portal/lib/format";
import { IMPORT_LIMITS } from "@/shared/tasks/todoist";
import { PRIORITY_LABELS, roleAtLeast } from "@/shared/tasks/types";
import { type ImportPreview, type ImportRequest, type ImportRun, type ImportStatus, tasksApi } from "./api";
import { useTasks } from "./tasks-context";
import { ZipError, csvFilesFromZip } from "./zip";

const STATUS_LABELS: Record<ImportStatus, { label: string; color: "brand" | "gray" | "warning" | "error" | "success" | "blue" }> = {
    new: { label: "New", color: "brand" },
    unchanged: { label: "Already imported", color: "gray" },
    update: { label: "Will be updated", color: "blue" },
    conflict: { label: "Changed in both: kept as here", color: "warning" },
    deleted: { label: "Deleted here: stays deleted", color: "gray" },
    duplicate: { label: "Already here: linked", color: "success" },
    import_duplicate: { label: "Already here: imported anyway", color: "warning" },
};

const DEFAULT_OPTIONS: ImportRequest["options"] = { priorityScale: "one_is_highest", destinations: {}, duplicates: "link", changed: "keep" };

export const TodoistImport = ({ onImported }: { onImported?: () => void }) => {
    const { projects, shell } = useTasks();
    const [files, setFiles] = useState<{ name: string; text: string }[]>([]);
    const [options, setOptions] = useState(DEFAULT_OPTIONS);
    const [preview, setPreview] = useState<ImportPreview | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState<"reading" | "previewing" | "importing" | null>(null);
    const [progress, setProgress] = useState(0);
    const [result, setResult] = useState<ImportRun | null>(null);
    const [batchId, setBatchId] = useState<string | undefined>();
    const editable = projects.filter((p) => roleAtLeast(p.role, "editor") && p.status !== "archived");

    const runPreview = async (chosen: typeof files, opts: typeof options) => {
        setBusy("previewing");
        setError(null);
        try {
            setPreview(await tasksApi.importPreview({ files: chosen, options: opts }));
        } catch (e) {
            setPreview(null);
            setError(errorMessage(e));
        } finally {
            setBusy(null);
        }
    };

    const choose = async (list: FileList) => {
        setResult(null);
        setBatchId(undefined);
        setBusy("reading");
        setError(null);
        try {
            const read: typeof files = [];
            for (const file of [...list]) {
                if (/\.zip$/i.test(file.name)) read.push(...(await csvFilesFromZip(await file.arrayBuffer(), IMPORT_LIMITS.fileBytes, IMPORT_LIMITS.files)));
                else if (/\.csv$/i.test(file.name)) {
                    if (file.size > IMPORT_LIMITS.fileBytes) throw new ZipError(`${file.name} is larger than 2 MB`);
                    read.push({ name: file.name, text: await file.text() });
                } else throw new ZipError(`${file.name} isn't a CSV or zip file from Todoist`);
            }
            if (!read.length) throw new ZipError("No CSV files were found");
            setFiles(read);
            const fresh = { ...options, destinations: {} };
            setOptions(fresh);
            await runPreview(read, fresh);
        } catch (e) {
            setError(e instanceof ZipError ? e.message : errorMessage(e));
            setBusy(null);
        }
    };

    const change = (next: Partial<typeof options>) => {
        const merged = { ...options, ...next };
        setOptions(merged);
        void runPreview(files, merged);
    };

    const start = async () => {
        setBusy("importing");
        setError(null);
        const total = preview?.projects.reduce((n, p) => n + p.taskCount, 0) ?? 1;
        let id = batchId;
        try {
            // Rounds until the server says it's done; each round is bounded and saved as it goes.
            for (let round = 0; round < 100; round++) {
                const run = await tasksApi.importRun({ files, options, batchId: id });
                id = run.batchId;
                setBatchId(id);
                setResult(run);
                setProgress(Math.min(100, Math.round(((run.summary.tasksCreated + run.summary.tasksUpdated + run.summary.linkedDuplicates) / total) * 100)));
                if (run.done) break;
            }
            onImported?.();
            await runPreview(files, options);
        } catch (e) {
            setError(`${errorMessage(e)} What was imported before this is saved; import again to continue.`);
        } finally {
            setBusy(null);
        }
    };

    const anything = preview?.projects.some((p) => p.counts.new + p.counts.update + p.counts.import_duplicate + p.counts.duplicate > 0);

    return (
        <div className="flex flex-col gap-4">
            <FileUploadDropZone
                accept=".csv,.zip,text/csv,application/zip"
                allowsMultiple
                maxSize={20_000_000}
                hint="Todoist's CSV export (one file per project) or a Todoist backup zip · up to 30 projects, 5,000 tasks"
                isDisabled={!!busy}
                onDropFiles={(list) => void choose(list)}
            />
            {busy === "reading" || busy === "previewing" ? (
                <p role="status" className="text-sm text-tertiary">
                    {busy === "reading" ? "Reading the files…" : "Checking what would be imported…"}
                </p>
            ) : null}
            {error && (
                <Notice title="Nothing more was imported" color="error">
                    {error}
                </Notice>
            )}
            {preview && (
                <div className="flex flex-col gap-4">
                    {preview.importedBefore && (
                        <Notice title="You've imported these files before" color="brand">
                            On {formatDateTime(preview.importedBefore, shell.preferences.timeZone)}. Importing again only adds what's new, so nothing is
                            duplicated.
                        </Notice>
                    )}
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                        <Select
                            label="Priority numbers"
                            size="sm"
                            value={options.priorityScale}
                            onChange={(key) => key && change({ priorityScale: key as typeof options.priorityScale })}
                            items={[
                                { id: "one_is_highest", label: "1 is P1 (Todoist's CSV format)" },
                                { id: "four_is_highest", label: "4 is P1 (files from Todoist's API)" },
                            ]}
                            hint={`In these files: ${Object.entries(
                                preview.projects.reduce<Record<string, number>>((all, p) => {
                                    for (const [k, n] of Object.entries(p.priorityValues)) all[k] = (all[k] ?? 0) + n;
                                    return all;
                                }, {}),
                            )
                                .map(([k, n]) => `${k} × ${n}`)
                                .join(", ")}`}
                        >
                            {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                        </Select>
                        <RadioGroup
                            aria-label="Tasks that are already here"
                            value={options.duplicates}
                            onChange={(v) => change({ duplicates: v as typeof options.duplicates })}
                        >
                            <RadioButton value="link" label="Link to tasks already here" hint="Same title in the same place" />
                            <RadioButton value="import" label="Import them anyway" />
                        </RadioGroup>
                        <RadioGroup
                            aria-label="Tasks changed in Todoist since the last import"
                            value={options.changed}
                            onChange={(v) => change({ changed: v as typeof options.changed })}
                        >
                            <RadioButton value="keep" label="Keep what's here" hint="Changed in Todoist since the last import" />
                            <RadioButton value="update" label="Update from Todoist" hint="Only tasks not edited here since" />
                        </RadioGroup>
                    </div>

                    {preview.projects.map((p) => (
                        <section key={p.key} aria-label={p.name} className="flex flex-col gap-3 rounded-xl p-4 ring-1 ring-secondary ring-inset">
                            <div className="flex flex-wrap items-start justify-between gap-3">
                                <div className="min-w-0">
                                    <h3 className="text-sm font-semibold text-primary">{p.name}</h3>
                                    <p className="text-xs text-tertiary">
                                        {p.taskCount} task{p.taskCount === 1 ? "" : "s"} ({p.subtaskCount} subtasks) · {p.sections.length} section
                                        {p.sections.length === 1 ? "" : "s"} · {p.commentCount} comment{p.commentCount === 1 ? "" : "s"} · {p.repeating}{" "}
                                        repeating
                                        {p.labels.length ? ` · labels ${p.labels.map((l) => `@${l}`).join(" ")}` : ""}
                                    </p>
                                </div>
                                <Select
                                    aria-label={`Where ${p.name} goes`}
                                    size="sm"
                                    className="w-full sm:w-64"
                                    value={options.destinations[p.key] ?? (p.destination.kind === "existing" ? p.destination.projectId : "new")}
                                    onChange={(key) => key && change({ destinations: { ...options.destinations, [p.key]: String(key) } })}
                                    items={[
                                        { id: "new", label: `A new personal project “${p.name}”` },
                                        ...editable.map((x) => ({ id: x.id, label: `Into ${x.name}${x.kind === "shared" ? " (shared)" : ""}` })),
                                    ]}
                                >
                                    {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                                </Select>
                            </div>
                            {p.sameName && p.destination.kind === "new" && (
                                <p className="text-xs text-secondary">
                                    You already have a project called “{p.sameName.name}”. Choose it above to import into it.
                                </p>
                            )}
                            <div className="flex flex-wrap gap-1.5">
                                {(Object.keys(p.counts) as ImportStatus[])
                                    .filter((s) => p.counts[s])
                                    .map((s) => (
                                        <Badge key={s} size="sm" type="color" color={STATUS_LABELS[s].color}>
                                            {STATUS_LABELS[s].label}: {p.counts[s]}
                                        </Badge>
                                    ))}
                            </div>
                            <ul aria-label={`Tasks in ${p.name}`} className="flex max-h-64 flex-col overflow-y-auto text-sm">
                                {p.sample.map((t, i) => (
                                    <li
                                        key={i}
                                        className="flex items-center gap-2 border-b border-secondary py-1.5"
                                        style={{ paddingLeft: `${t.depth * 1.25}rem` }}
                                    >
                                        <span className="min-w-0 flex-1 truncate text-secondary">{t.title}</span>
                                        <span className="shrink-0 text-xs text-tertiary">
                                            {[t.section, t.due, PRIORITY_LABELS[t.priority].short].filter(Boolean).join(" · ")}
                                        </span>
                                        {t.status !== "new" && <span className="sr-only">{STATUS_LABELS[t.status].label}</span>}
                                    </li>
                                ))}
                                {p.taskCount > p.sample.length && <li className="py-1.5 text-xs text-tertiary">…and {p.taskCount - p.sample.length} more</li>}
                            </ul>
                            {(p.warnings.length > 0 || Object.keys(p.unsupported).length > 0) && (
                                <details className="text-xs text-tertiary">
                                    <summary className="cursor-pointer font-medium text-secondary">
                                        <AlertTriangle aria-hidden="true" className="mr-1 inline size-3.5 text-fg-warning-primary" />
                                        {p.warnings.length} note{p.warnings.length === 1 ? "" : "s"}
                                        {Object.keys(p.unsupported).length ? ` · not imported: ${Object.keys(p.unsupported).join(", ").toLowerCase()}` : ""}
                                    </summary>
                                    <ul className="mt-2 flex list-disc flex-col gap-1 pl-5">
                                        {p.warnings.map((w, i) => (
                                            <li key={i}>{w}</li>
                                        ))}
                                    </ul>
                                </details>
                            )}
                        </section>
                    ))}
                    <p className="text-xs text-tertiary">Todoist's export doesn't include: {preview.notImported.join("; ")}.</p>
                    {busy === "importing" && <ProgressBar value={progress} labelPosition="right" aria-label="Import progress" />}
                    <div className="flex flex-wrap items-center gap-3">
                        <Button
                            iconLeading={UploadCloud02}
                            isLoading={busy === "importing"}
                            showTextWhileLoading
                            isDisabled={!!busy || !anything}
                            onClick={() => void start()}
                        >
                            {anything ? "Import" : "Nothing new to import"}
                        </Button>
                        <Button color="secondary" isDisabled={!!busy} onClick={() => (setPreview(null), setFiles([]), setResult(null))}>
                            Cancel
                        </Button>
                    </div>
                </div>
            )}
            {result?.done && (
                <Notice title="Import finished" color="success">
                    <span className="inline-flex items-start gap-1.5">
                        <CheckCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                        {result.summary.projectsCreated} projects and {result.summary.tasksCreated} tasks added, {result.summary.tasksUpdated} updated,{" "}
                        {result.summary.linkedDuplicates} linked to tasks already here, {result.summary.unchanged} already imported
                        {result.summary.conflicts ? `, ${result.summary.conflicts} changed in both and kept as here` : ""}.
                    </span>
                </Notice>
            )}
        </div>
    );
};
