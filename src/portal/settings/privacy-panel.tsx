// Settings → Privacy: retention periods, deleted records (restore or erase) and applying retention.
// Erasure and retention are owner-only and need the record's name (or a phrase) typed back.
import { useState } from "react";
import { RefreshCcw01, ShieldOff, Trash03 } from "@untitledui/icons";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { type DataColumn, DataTable } from "@/portal/components/data-table";
import { PortalDialog } from "@/portal/components/dialog";
import { Empty } from "@/portal/components/empty";
import { FormGrid, FormSection, useSubmit } from "@/portal/components/form";
import { Notice } from "@/portal/components/notice";
import { Timestamp } from "@/portal/components/timestamp";
import { useToast } from "@/portal/components/toast";
import { api, errorMessage } from "@/portal/lib/api";
import { formatDate, pluralise } from "@/portal/lib/format";
import { usePortal } from "@/portal/portal-context";
import type { DeletedRecord, PrivacySettings, RetentionPreview } from "@/shared/portal/types";

const RETENTION_PHRASE = "APPLY RETENTION";

interface PrivacyPanelProps {
    initial: { settings: PrivacySettings; deleted: DeletedRecord[]; retention: RetentionPreview | null };
}

export const PrivacyPanel = ({ initial }: PrivacyPanelProps) => {
    const { can } = usePortal();
    const toast = useToast();
    const isOwner = can("portal.data.erase");
    const [settings, setSettings] = useState(initial.settings);
    const [draft, setDraft] = useState({ audit: String(initial.settings.auditRetentionDays), deleted: String(initial.settings.deletedRetentionDays) });
    const [deleted, setDeleted] = useState(initial.deleted);
    const [preview, setPreview] = useState(initial.retention);
    const [erasing, setErasing] = useState<DeletedRecord | null>(null);
    const [confirmText, setConfirmText] = useState("");
    const [retentionOpen, setRetentionOpen] = useState(false);
    const [busy, setBusy] = useState(false);

    const save = useSubmit(
        () =>
            api<{ value: PrivacySettings }>("PUT", "/api/portal/settings/privacy", {
                auditRetentionDays: Number.parseInt(draft.audit, 10),
                deletedRetentionDays: Number.parseInt(draft.deleted, 10),
            }),
        {
            success: "Retention settings saved",
            onSuccess: async ({ value }) => {
                setSettings(value);
                setPreview((await api<{ preview: RetentionPreview }>("GET", "/api/portal/privacy/retention")).preview);
            },
        },
    );

    const restore = async (record: DeletedRecord) => {
        try {
            const result = await api<{ deleted: DeletedRecord[] }>("POST", "/api/portal/privacy/restore", { type: record.type, id: record.id });
            setDeleted(result.deleted);
            toast.success(`${record.name} restored`);
        } catch (error) {
            toast.error("Couldn't restore", errorMessage(error));
        }
    };

    const erase = async () => {
        if (!erasing) return;
        setBusy(true);
        try {
            const result = await api<{ deleted: DeletedRecord[] }>("POST", "/api/portal/privacy/erase", {
                type: erasing.type,
                id: erasing.id,
                confirm: confirmText,
            });
            setDeleted(result.deleted);
            toast.success("Permanently erased");
            setErasing(null);
        } catch (error) {
            toast.error("Couldn't erase", errorMessage(error));
        } finally {
            setBusy(false);
        }
    };

    const applyRetention = async () => {
        setBusy(true);
        try {
            const result = await api<{ removed: number; erased: number; preview: RetentionPreview; deleted: DeletedRecord[] }>(
                "POST",
                "/api/portal/privacy/retention",
                {
                    confirm: confirmText,
                },
            );
            setPreview(result.preview);
            setDeleted(result.deleted);
            toast.success(
                "Retention applied",
                `${pluralise(result.removed, "audit entry", "audit entries")} removed, ${pluralise(result.erased, "record")} erased.`,
            );
            setRetentionOpen(false);
        } catch (error) {
            toast.error("Couldn't apply retention", errorMessage(error));
        } finally {
            setBusy(false);
        }
    };

    const columns: DataColumn<DeletedRecord>[] = [
        {
            id: "name",
            label: "Record",
            isRowHeader: true,
            sortValue: (r) => r.name,
            render: (r) => (
                <div>
                    <p className="font-medium text-primary">{r.name}</p>
                    {r.detail && <p className="text-tertiary">{r.detail}</p>}
                </div>
            ),
        },
        {
            id: "type",
            label: "Type",
            sortValue: (r) => r.type,
            render: (r) => (
                <Badge size="sm" type="modern" color="gray">
                    {r.type === "guest" ? "Guest" : "Household"}
                </Badge>
            ),
        },
        {
            id: "deleted",
            label: "Deleted",
            sortValue: (r) => r.deletedAt,
            render: (r) => (
                <div>
                    <Timestamp iso={r.deletedAt} />
                    {r.deletedBy && <p className="text-tertiary">by {r.deletedBy}</p>}
                </div>
            ),
            className: "max-md:hidden",
        },
        {
            id: "actions",
            label: "",
            render: (r) => (
                <div className="flex justify-end gap-2">
                    <Button size="sm" color="secondary" iconLeading={RefreshCcw01} onClick={() => restore(r)}>
                        Restore
                    </Button>
                    {isOwner && (
                        <Button
                            size="sm"
                            color="secondary-destructive"
                            iconLeading={Trash03}
                            onClick={() => {
                                setConfirmText("");
                                setErasing(r);
                            }}
                        >
                            Erase
                        </Button>
                    )}
                </div>
            ),
        },
    ];

    return (
        <div className="flex max-w-5xl flex-col gap-8">
            <Notice color="brand" title="Deleting and erasing are different">
                Deleting a guest or household hides it everywhere and can be undone here. Erasing removes it for good, along with the copies of their name and
                contact details in message history, stored RSVP responses and the audit log. Only owners can erase. Downloaded CSV files and Cloudflare's 30-day
                database restore points are outside the portal; see docs/PRIVACY.md.
            </Notice>

            <DataTable
                title="Deleted records"
                description="Guests and households that were deleted. They don't appear in lists, counts, exports, messages or the RSVP form."
                rows={deleted}
                columns={columns}
                searchText={(r) => r.name}
                initialSort={{ column: "deleted", direction: "descending" }}
                emptyState={
                    <Empty icon={ShieldOff} title="Nothing deleted" description="Deleted guests and households appear here until they're restored or erased." />
                }
            />

            <form
                noValidate
                className="flex flex-col gap-8"
                onSubmit={(e) => {
                    e.preventDefault();
                    void save.submit();
                }}
            >
                <FormSection
                    title="Retention"
                    description="How long the portal keeps history. Nothing is removed automatically: an owner applies retention when they choose."
                >
                    <fieldset disabled={!isOwner} className="flex flex-col gap-4">
                        <FormGrid>
                            <Input
                                label="Keep audit entries for (days)"
                                type="number"
                                value={draft.audit}
                                onChange={(v) => setDraft({ ...draft, audit: v })}
                                isInvalid={!!save.fieldError("auditRetentionDays")}
                                hint={save.fieldError("auditRetentionDays") ?? "0 keeps them forever. Records of erasures are always kept."}
                            />
                            <Input
                                label="Erase deleted records after (days)"
                                type="number"
                                value={draft.deleted}
                                onChange={(v) => setDraft({ ...draft, deleted: v })}
                                isInvalid={!!save.fieldError("deletedRetentionDays")}
                                hint={save.fieldError("deletedRetentionDays") ?? "At least 7. They're erased only when retention is applied."}
                            />
                        </FormGrid>
                        {isOwner && (
                            <div className="flex justify-end">
                                <Button
                                    type="submit"
                                    color="secondary"
                                    isLoading={save.busy}
                                    showTextWhileLoading
                                    isDisabled={String(settings.auditRetentionDays) === draft.audit && String(settings.deletedRetentionDays) === draft.deleted}
                                >
                                    Save retention settings
                                </Button>
                            </div>
                        )}
                    </fieldset>
                    {preview && (
                        <div className="flex flex-col gap-3 rounded-xl bg-secondary p-4 sm:flex-row sm:items-center sm:justify-between">
                            <p className="text-sm text-secondary">
                                {preview.auditCutoff
                                    ? `${pluralise(preview.auditEntries, "audit entry", "audit entries")} older than ${formatDate(preview.auditCutoff.slice(0, 10))}`
                                    : "Audit entries are kept forever"}
                                {" · "}
                                {pluralise(preview.deletedRecords, "deleted record")} older than {formatDate(preview.deletedCutoff.slice(0, 10))}
                            </p>
                            <Button
                                size="sm"
                                color="primary-destructive"
                                isDisabled={preview.auditEntries + preview.deletedRecords === 0}
                                onClick={() => {
                                    setConfirmText("");
                                    setRetentionOpen(true);
                                }}
                            >
                                Apply retention
                            </Button>
                        </div>
                    )}
                </FormSection>
            </form>

            <PortalDialog
                isOpen={!!erasing}
                onOpenChange={(o) => !o && !busy && setErasing(null)}
                title={`Permanently erase ${erasing?.name ?? ""}?`}
                description="This can't be undone. Their record is removed and their name and contact details are scrubbed from message history, RSVP responses and the audit log. The audit log will still show that an owner erased a record, and when."
                icon={Trash03}
                iconColor="error"
                size="sm"
                onSubmit={erase}
                footer={
                    <>
                        <Button color="secondary" size="lg" onClick={() => setErasing(null)} isDisabled={busy}>
                            Cancel
                        </Button>
                        <Button
                            type="submit"
                            size="lg"
                            color="primary-destructive"
                            isLoading={busy}
                            showTextWhileLoading
                            isDisabled={confirmText.trim() === ""}
                        >
                            Erase permanently
                        </Button>
                    </>
                }
            >
                <Input label={`Type “${erasing?.name ?? ""}” to confirm`} value={confirmText} onChange={setConfirmText} autoComplete="off" />
            </PortalDialog>

            <PortalDialog
                isOpen={retentionOpen}
                onOpenChange={(o) => !o && !busy && setRetentionOpen(false)}
                title="Apply retention now?"
                description={
                    preview
                        ? `${pluralise(preview.auditEntries, "audit entry", "audit entries")} will be removed and ${pluralise(preview.deletedRecords, "deleted record")} erased. This can't be undone.`
                        : ""
                }
                icon={Trash03}
                iconColor="error"
                size="sm"
                onSubmit={applyRetention}
                footer={
                    <>
                        <Button color="secondary" size="lg" onClick={() => setRetentionOpen(false)} isDisabled={busy}>
                            Cancel
                        </Button>
                        <Button
                            type="submit"
                            size="lg"
                            color="primary-destructive"
                            isLoading={busy}
                            showTextWhileLoading
                            isDisabled={confirmText !== RETENTION_PHRASE}
                        >
                            Apply retention
                        </Button>
                    </>
                }
            >
                <Input label={`Type ${RETENTION_PHRASE} to confirm`} value={confirmText} onChange={setConfirmText} autoComplete="off" />
            </PortalDialog>
        </div>
    );
};
