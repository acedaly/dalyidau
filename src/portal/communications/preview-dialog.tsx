import { useEffect, useState } from "react";
import { Mail01 } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { Select } from "@/components/base/select/select";
import { PortalDialog } from "@/portal/components/dialog";
import { Notice } from "@/portal/components/notice";
import { api, errorMessage } from "@/portal/lib/api";

interface PreviewResult {
    guest: { id: string; name: string; email: string | null } | null;
    subject: string;
    body: string;
    unknownFields: string[];
}

interface PreviewDialogProps {
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
    subject: string;
    body: string;
    guests: { id: string; name: string; email: string | null }[];
}

/** Shows a message exactly as one guest would receive it, merge fields filled in. */
export const PreviewDialog = ({ isOpen, onOpenChange, subject, body, guests }: PreviewDialogProps) => {
    const [guestId, setGuestId] = useState<string | null>(null);
    const [result, setResult] = useState<PreviewResult | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!isOpen) return;
        setError(null);
        api<PreviewResult>("POST", "/api/portal/wedding/messages/preview", { subject, body, guestId: guestId ?? guests[0]?.id ?? null })
            .then(setResult)
            .catch((e) => setError(errorMessage(e)));
    }, [isOpen, subject, body, guestId, guests]);

    return (
        <PortalDialog
            isOpen={isOpen}
            onOpenChange={onOpenChange}
            title="Preview"
            description={
                result?.guest ? `As ${result.guest.name}${result.guest.email ? ` <${result.guest.email}>` : ""} would see it.` : "With sample details."
            }
            icon={Mail01}
            size="lg"
            footer={
                <Button color="secondary" size="lg" onClick={() => onOpenChange(false)}>
                    Close
                </Button>
            }
        >
            {guests.length > 1 && (
                <Select
                    label="Preview for"
                    items={guests.map((g) => ({ id: g.id, label: g.name, supportingText: g.email ?? "no email" }))}
                    value={guestId ?? guests[0].id}
                    onChange={(v) => setGuestId(String(v))}
                >
                    {(item) => (
                        <Select.Item id={item.id} supportingText={item.supportingText}>
                            {item.label}
                        </Select.Item>
                    )}
                </Select>
            )}
            {error && (
                <Notice color="error" title="Couldn't build the preview">
                    {error}
                </Notice>
            )}
            {result && result.unknownFields.length > 0 && (
                <Notice color="warning" title="Unknown merge fields">
                    {result.unknownFields.map((f) => `{{${f}}}`).join(", ")} won't be filled in. Check the spelling.
                </Notice>
            )}
            {result && (
                <article className="flex flex-col gap-3 rounded-xl bg-secondary p-5">
                    <p className="text-sm text-tertiary">
                        Subject: <span className="font-semibold text-primary">{result.subject}</span>
                    </p>
                    <hr className="border-secondary" />
                    <p className="text-md whitespace-pre-wrap text-secondary">{result.body}</p>
                </article>
            )}
        </PortalDialog>
    );
};
