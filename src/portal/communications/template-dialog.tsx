import { useEffect, useState } from "react";
import { FileHeart02 } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { Select } from "@/components/base/select/select";
import { MessageEditor } from "@/portal/communications/message-editor";
import { ConfirmDialog, PortalDialog } from "@/portal/components/dialog";
import { FormError, useSubmit } from "@/portal/components/form";
import { useToast } from "@/portal/components/toast";
import { errorMessage } from "@/portal/lib/api";
import { MESSAGE_CATEGORIES, type MessageCategory, type MessageTemplate } from "@/shared/portal/types";

const CATEGORY_LABELS: Record<MessageCategory, string> = {
    save_the_date: "Save the date",
    invitation: "Invitation",
    reminder: "Reminder",
    update: "Update",
    thank_you: "Thank you",
};

interface TemplateDialogProps {
    template: MessageTemplate | null;
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
    onSave: (id: string | null, input: { name: string; subject: string; body: string; category: MessageCategory }) => Promise<MessageTemplate>;
    onDelete: (id: string) => Promise<void>;
    canEdit: boolean;
}

export const TemplateDialog = ({ template, isOpen, onOpenChange, onSave, onDelete, canEdit }: TemplateDialogProps) => {
    const toast = useToast();
    const [draft, setDraft] = useState<{ name: string; subject: string; body: string; category: MessageCategory }>({
        name: "",
        subject: "",
        body: "",
        category: "update",
    });
    const [confirmDelete, setConfirmDelete] = useState(false);

    useEffect(() => {
        if (isOpen)
            setDraft({ name: template?.name ?? "", subject: template?.subject ?? "", body: template?.body ?? "", category: template?.category ?? "update" });
    }, [isOpen, template]);

    const save = useSubmit(() => onSave(template?.id ?? null, draft), {
        success: template ? "Template saved" : "Template created",
        onSuccess: () => onOpenChange(false),
    });

    return (
        <>
            <PortalDialog
                isOpen={isOpen}
                onOpenChange={onOpenChange}
                title={template ? template.name : "New template"}
                description="Reusable wording for save-the-dates, invitations, reminders and thank-yous."
                icon={FileHeart02}
                size="lg"
                onSubmit={canEdit ? save.submit : undefined}
                footer={
                    <>
                        {template && canEdit && (
                            <Button color="tertiary-destructive" size="lg" onClick={() => setConfirmDelete(true)} className="sm:mr-auto">
                                Delete
                            </Button>
                        )}
                        <Button color="secondary" size="lg" onClick={() => onOpenChange(false)}>
                            {canEdit ? "Cancel" : "Close"}
                        </Button>
                        {canEdit && (
                            <Button type="submit" size="lg" isLoading={save.busy} showTextWhileLoading>
                                Save template
                            </Button>
                        )}
                    </>
                }
            >
                <FormError message={save.error && save.error.issues.length === 0 ? save.error.message : null} />
                <fieldset disabled={!canEdit} className="flex flex-col gap-4">
                    <Input
                        label="Template name"
                        isRequired
                        value={draft.name}
                        onChange={(v) => setDraft({ ...draft, name: v })}
                        isInvalid={!!save.fieldError("name")}
                        hint={save.fieldError("name")}
                    />
                    <Select
                        label="Category"
                        items={MESSAGE_CATEGORIES.map((category) => ({ id: category, label: CATEGORY_LABELS[category] }))}
                        value={draft.category}
                        onChange={(category) => setDraft({ ...draft, category: category as MessageCategory })}
                    >
                        {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                    </Select>
                    <MessageEditor subject={draft.subject} body={draft.body} onChange={(c) => setDraft({ ...draft, ...c })} fieldError={save.fieldError} />
                </fieldset>
            </PortalDialog>
            {template && (
                <ConfirmDialog
                    isOpen={confirmDelete}
                    onOpenChange={setConfirmDelete}
                    title={`Delete “${template.name}”?`}
                    description="Messages already prepared from this template keep their own copy of the wording."
                    confirmLabel="Delete template"
                    destructive
                    onConfirm={async () => {
                        try {
                            await onDelete(template.id);
                            toast.success("Template deleted");
                            onOpenChange(false);
                        } catch (e) {
                            toast.error("Couldn't delete the template", errorMessage(e));
                        }
                    }}
                />
            )}
        </>
    );
};
