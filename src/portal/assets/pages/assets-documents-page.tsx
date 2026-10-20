// Documents: every photo and document you can open, your capture inbox (uploads not yet filed),
// assets still missing proof of purchase or a photo, and documents due for a retention review.
// Files are downloaded through the portal after the record's own checks; nothing has a public link.
import { useState } from "react";
import { Download01, File04, Inbox01, Trash01, Upload01 } from "@untitledui/icons";
import { FileUpload } from "@/components/application/file-upload/file-upload-base";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { NativeSelect } from "@/components/base/select/select-native";
import { DataTable } from "@/portal/components/data-table";
import { Empty } from "@/portal/components/empty";
import { Notice } from "@/portal/components/notice";
import { useToast } from "@/portal/components/toast";
import { Card } from "@/portal/knowledge/pages/knowledge-home-page";
import { errorMessage } from "@/portal/lib/api";
import type { PageData } from "@/portal/lib/page-types";
import { type AssetFileView, FILE_KINDS, FILE_KIND_LABELS } from "@/shared/assets/types";
import { assetsApi, fileUrl } from "../assets-api";
import { ASSETS, AssetsHeader, assetHref, shortDate, useUploader } from "../shared";

export const AssetsDocumentsPage = ({ data }: { data: PageData<"assets-documents"> }) => {
    const toast = useToast();
    const [files, setFiles] = useState(data.files);
    const [inbox, setInbox] = useState(data.inbox);
    const [retention, setRetention] = useState(data.retentionDue);
    const [kind, setKind] = useState<AssetFileView["kind"]>("receipt");
    const { upload, busy } = useUploader();
    const reload = async () => {
        const r = await assetsApi.files();
        setFiles(r.files);
        setInbox(r.inbox);
        setRetention(r.retentionDue);
    };
    const file = async (id: string, assetId: string) => {
        try {
            await assetsApi.updateFile(id, { assetId });
            toast.success("Filed");
            await reload();
        } catch (e) {
            toast.error("Couldn't file it", errorMessage(e));
        }
    };
    const remove = async (id: string) => {
        try {
            await assetsApi.deleteFile(id);
            await reload();
        } catch (e) {
            toast.error("Couldn't delete it", errorMessage(e));
        }
    };
    return (
        <>
            <AssetsHeader
                title="Documents"
                description="Receipts, invoices, manuals, policies, service records and photos."
                crumbs={[{ label: "Documents" }]}
            />
            <Card title="Add to your capture inbox" icon={Upload01}>
                <div className="flex flex-col gap-3 px-4 py-4 sm:px-5">
                    <p className="text-sm text-tertiary">Drop receipts and documents here now and file them on an asset later. Only you can see your inbox.</p>
                    <NativeSelect
                        label="These are"
                        value={kind}
                        onChange={(e) => setKind(e.target.value as typeof kind)}
                        options={FILE_KINDS.map((k) => ({ value: k, label: FILE_KIND_LABELS[k] }))}
                        className="sm:w-64"
                    />
                    <FileUpload.DropZone
                        hint="PDF, photo, text, Word or Excel, up to 10 MB"
                        accept="image/*,application/pdf,text/plain,.docx,.xlsx"
                        isDisabled={busy}
                        onDropFiles={(list) => void upload(Array.from(list), { kind }).then(reload)}
                    />
                </div>
            </Card>
            {inbox.length > 0 && (
                <Card title={`Capture inbox (${inbox.length})`} icon={Inbox01}>
                    <ul className="flex flex-col divide-y divide-secondary">
                        {inbox.map((f) => (
                            <li key={f.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-end sm:justify-between sm:px-5">
                                <div className="flex flex-col">
                                    <a href={fileUrl(f.id)} className="text-sm font-medium text-primary hover:underline">
                                        {f.filename}
                                    </a>
                                    <span className="text-xs text-tertiary">
                                        {FILE_KIND_LABELS[f.kind]} · {shortDate(f.createdAt.slice(0, 10))}
                                    </span>
                                </div>
                                <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                                    {data.assets.length > 0 && (
                                        <NativeSelect
                                            size="sm"
                                            label="File on"
                                            value=""
                                            onChange={(e) => e.target.value && void file(f.id, e.target.value)}
                                            options={[{ value: "", label: "Choose an asset" }, ...data.assets.map((a) => ({ value: a.id, label: a.name }))]}
                                        />
                                    )}
                                    <Button
                                        size="sm"
                                        color="secondary"
                                        href={`${ASSETS}/capture?mode=${f.kind === "photo" ? "photo" : "receipt"}&file=${f.id}`}
                                    >
                                        Make an asset
                                    </Button>
                                    <ButtonUtility size="sm" color="tertiary" icon={Trash01} tooltip="Delete" onClick={() => void remove(f.id)} />
                                </div>
                            </li>
                        ))}
                    </ul>
                </Card>
            )}
            {data.needsDocuments.length > 0 && (
                <Card title="Missing proof of purchase or a photo" icon={File04}>
                    <ul className="flex flex-col divide-y divide-secondary">
                        {data.needsDocuments.slice(0, 20).map((a) => (
                            <li key={a.id} className="flex items-center justify-between gap-2 px-4 py-2.5 text-sm sm:px-5">
                                <a href={assetHref(a.id, "documents")} className="font-medium text-primary hover:underline">
                                    {a.name}
                                </a>
                                <span className="text-xs text-tertiary">
                                    {[a.needsDocuments?.proof && "No receipt", a.needsDocuments?.photo && "No photo"].filter(Boolean).join(" · ")}
                                </span>
                            </li>
                        ))}
                    </ul>
                </Card>
            )}
            {retention.length > 0 && (
                <Notice title={`${retention.length} documents due for review`} color="warning">
                    These belong to things you disposed of longer ago than your retention setting. Nothing is deleted automatically: open each and delete it if
                    you no longer need it.
                </Notice>
            )}
            <DataTable<AssetFileView>
                title="All documents and photos"
                rows={files}
                searchText={(f) => `${f.filename} ${f.caption ?? ""} ${f.assetName ?? ""} ${FILE_KIND_LABELS[f.kind]}`}
                initialSort={{ column: "added", direction: "descending" }}
                emptyState={<Empty icon={File04} title="No documents yet" description="Add them from an asset, or drop them in your capture inbox above." />}
                columns={[
                    {
                        id: "name",
                        label: "Document",
                        isRowHeader: true,
                        sortValue: (f) => f.caption ?? f.filename,
                        render: (f) => (
                            <a href={fileUrl(f.id)} className="font-medium text-primary hover:underline">
                                {f.caption ?? f.filename}
                            </a>
                        ),
                    },
                    { id: "kind", label: "Kind", sortValue: (f) => FILE_KIND_LABELS[f.kind], render: (f) => FILE_KIND_LABELS[f.kind] },
                    {
                        id: "for",
                        label: "For",
                        className: "max-md:hidden",
                        render: (f) =>
                            f.assetId ? (
                                <a href={assetHref(f.assetId, "documents")} className="hover:underline">
                                    {f.assetName}
                                </a>
                            ) : f.policyId ? (
                                <a href={`${ASSETS}/insurance?policy=${f.policyId}`} className="hover:underline">
                                    A policy
                                </a>
                            ) : f.locationId ? (
                                "A place"
                            ) : (
                                ""
                            ),
                    },
                    {
                        id: "added",
                        label: "Added",
                        className: "max-lg:hidden",
                        sortValue: (f) => f.createdAt,
                        render: (f) => shortDate(f.createdAt.slice(0, 10)),
                    },
                    {
                        id: "dl",
                        label: "",
                        render: (f) => <ButtonUtility size="xs" color="tertiary" icon={Download01} tooltip="Download" href={fileUrl(f.id)} />,
                    },
                ]}
            />
        </>
    );
};
