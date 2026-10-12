// Create/edit panel used by the simpler modules (households, events, suppliers, budget, tasks…):
// a RecordPanel with save, cancel and a confirmed delete.
import type { ReactNode } from "react";
import { useState } from "react";
import { Trash01 } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { ConfirmDialog } from "@/portal/components/dialog";
import { FormError } from "@/portal/components/form";
import { RecordPanel } from "@/portal/components/record-panel";
import { useToast } from "@/portal/components/toast";
import { ApiError, errorMessage } from "@/portal/lib/api";

interface EntityPanelProps {
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
    /** "household", "event"… used in titles and messages. */
    noun: string;
    /** Name of the record being edited, or null when creating. */
    name: string | null;
    description?: ReactNode;
    canEdit: boolean;
    onSave: () => Promise<unknown>;
    onDelete?: () => Promise<unknown>;
    deleteWarning?: ReactNode;
    /** Receives the field-error lookup for the last failed save. */
    children: (fieldError: (field: string) => string | undefined) => ReactNode;
    width?: "md" | "lg";
}

export const EntityPanel = ({ isOpen, onOpenChange, noun, name, description, canEdit, onSave, onDelete, deleteWarning, children, width }: EntityPanelProps) => {
    const toast = useToast();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<ApiError | null>(null);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const capitalised = noun.charAt(0).toUpperCase() + noun.slice(1);

    const save = async () => {
        setBusy(true);
        setError(null);
        try {
            await onSave();
            toast.success(name ? `${capitalised} updated` : `${capitalised} added`);
            onOpenChange(false);
        } catch (e) {
            const apiError = e instanceof ApiError ? e : new ApiError(0, "error", errorMessage(e));
            setError(apiError);
        } finally {
            setBusy(false);
        }
    };

    const fieldError = (field: string) => error?.issueFor(field);

    return (
        <>
            <RecordPanel
                isOpen={isOpen}
                onOpenChange={(open) => {
                    if (!open) setError(null);
                    onOpenChange(open);
                }}
                title={name ?? `New ${noun}`}
                description={description}
                width={width}
                onSubmit={canEdit ? save : undefined}
                footer={
                    <>
                        {name && canEdit && onDelete && (
                            <Button color="tertiary-destructive" iconLeading={Trash01} onClick={() => setConfirmDelete(true)} className="mr-auto">
                                Delete
                            </Button>
                        )}
                        <Button color="secondary" onClick={() => onOpenChange(false)}>
                            {canEdit ? "Cancel" : "Close"}
                        </Button>
                        {canEdit && (
                            <Button type="submit" isLoading={busy} showTextWhileLoading>
                                {name ? "Save changes" : `Add ${noun}`}
                            </Button>
                        )}
                    </>
                }
            >
                <div className="flex flex-col gap-5">
                    {/* Always summarised at the top, so an error on a field the form doesn't show is never silent. */}
                    <FormError message={error ? (error.issues.length ? `Check the form: ${error.message}` : error.message) : null} />
                    <fieldset disabled={!canEdit} className="flex flex-col gap-4">
                        {children(fieldError)}
                    </fieldset>
                </div>
            </RecordPanel>
            {onDelete && (
                <ConfirmDialog
                    isOpen={confirmDelete}
                    onOpenChange={setConfirmDelete}
                    title={`Delete ${name ?? noun}?`}
                    description={deleteWarning ?? "This can't be undone. The audit log keeps a copy."}
                    confirmLabel={`Delete ${noun}`}
                    destructive
                    onConfirm={async () => {
                        try {
                            await onDelete();
                            toast.success(`${capitalised} deleted`);
                            onOpenChange(false);
                        } catch (e) {
                            toast.error(`Couldn't delete the ${noun}`, errorMessage(e));
                        }
                    }}
                />
            )}
        </>
    );
};
