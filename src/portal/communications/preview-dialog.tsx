// Shows a message exactly as one household would receive it, merge fields filled in: the email in
// its stationery design at desktop and phone widths, or the text message as a phone would show it.
// With no household chosen it uses a fictional sample, so nobody's real details are needed.
import { useEffect, useState } from "react";
import { Mail01, MessageChatSquare } from "@untitledui/icons";
import { Tabs } from "@/components/application/tabs/tabs";
import { Button } from "@/components/base/buttons/button";
import { Select } from "@/components/base/select/select";
import { PortalDialog } from "@/portal/components/dialog";
import { Notice } from "@/portal/components/notice";
import { api, errorMessage } from "@/portal/lib/api";
import type { MessageCategory, MessageChannel } from "@/shared/portal/types";

export interface PreviewHousehold {
    id: string;
    /** How the household is addressed, e.g. "Fred & Ann Daly". */
    line: string;
}

interface PreviewResult {
    household: { id: string; name: string } | null;
    sample: boolean;
    subject: string;
    body: string;
    html: string;
    unknownFields: string[];
    forbidden: { field: string; reason: string }[];
    missing: string[];
    sms: { encoding: "gsm" | "unicode"; length: number; segments: number };
}

interface PreviewDialogProps {
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
    subject: string;
    body: string;
    category?: MessageCategory;
    channel?: MessageChannel;
    individual?: boolean;
    households: PreviewHousehold[];
}

const SAMPLE = "sample";

export const PreviewDialog = ({
    isOpen,
    onOpenChange,
    subject,
    body,
    category = "update",
    channel = "email",
    individual = false,
    households,
}: PreviewDialogProps) => {
    const [householdId, setHouseholdId] = useState<string>(SAMPLE);
    const [result, setResult] = useState<PreviewResult | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [width, setWidth] = useState<"desktop" | "mobile">("desktop");

    useEffect(() => {
        if (!isOpen) return;
        setError(null);
        api<PreviewResult>("POST", "/api/portal/wedding/messages/preview", {
            subject,
            body,
            category,
            channel,
            individual,
            householdId: householdId === SAMPLE ? null : householdId,
        })
            .then(setResult)
            .catch((e) => setError(errorMessage(e)));
    }, [isOpen, subject, body, category, channel, individual, householdId]);

    const sms = channel === "sms";

    return (
        <PortalDialog
            isOpen={isOpen}
            onOpenChange={onOpenChange}
            title="Preview"
            description={result?.household ? `As ${result.household.name} would receive it.` : "With a fictional sample household (Alex Example)."}
            icon={sms ? MessageChatSquare : Mail01}
            size="xl"
            footer={
                <Button color="secondary" size="lg" onClick={() => onOpenChange(false)}>
                    Close
                </Button>
            }
        >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                <Select
                    label="Preview for"
                    className="sm:max-w-80"
                    items={[{ id: SAMPLE, label: "Fictional sample household" }, ...households.slice(0, 300).map((h) => ({ id: h.id, label: h.line }))]}
                    value={householdId}
                    onChange={(v) => setHouseholdId(String(v))}
                >
                    {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                </Select>
                {!sms && (
                    <Tabs selectedKey={width} onSelectionChange={(key) => setWidth(key as typeof width)}>
                        <Tabs.List type="button-gray" size="sm" className="w-max">
                            <Tabs.Item id="desktop">Desktop</Tabs.Item>
                            <Tabs.Item id="mobile">Phone</Tabs.Item>
                        </Tabs.List>
                    </Tabs>
                )}
            </div>
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
            {result?.forbidden.map((f) => (
                <Notice key={f.field} color="error" title={`{{${f.field}}} can't be used here`}>
                    {f.reason}
                </Notice>
            ))}
            {result && result.missing.length > 0 && (
                <Notice color="warning" title="Missing details for this household">
                    {result.missing.map((f) => `{{${f}}}`).join(", ")} {result.missing.length === 1 ? "is" : "are"} empty, so this household would be held back
                    in the send check.
                </Notice>
            )}
            {result &&
                (sms ? (
                    <div className="flex flex-col items-center gap-3 rounded-xl bg-secondary p-6">
                        <div className="w-full max-w-80 rounded-2xl rounded-bl-sm bg-primary p-4 text-sm whitespace-pre-wrap text-primary shadow-xs ring-1 ring-secondary">
                            {result.body}
                        </div>
                        <p className="text-xs text-tertiary">
                            {result.sms.length} characters · {result.sms.segments} SMS part{result.sms.segments === 1 ? "" : "s"}
                            {result.sms.encoding === "unicode" ? " · emoji or curly quotes make each part shorter" : ""}
                        </p>
                    </div>
                ) : (
                    <div className="flex flex-col gap-3">
                        <p className="text-sm text-tertiary">
                            Subject: <span className="font-semibold text-primary">{result.subject}</span>
                        </p>
                        <div className="flex justify-center rounded-xl bg-secondary p-3">
                            <iframe
                                title={`Email preview at ${width} width`}
                                srcDoc={result.html}
                                sandbox=""
                                className="h-[60vh] rounded-lg bg-primary ring-1 ring-secondary"
                                style={{ width: width === "mobile" ? 375 : "100%", maxWidth: "100%" }}
                            />
                        </div>
                        <details className="text-sm text-tertiary">
                            <summary className="cursor-pointer font-medium text-secondary">Plain-text version</summary>
                            <p className="mt-2 whitespace-pre-wrap">{result.body}</p>
                        </details>
                    </div>
                ))}
        </PortalDialog>
    );
};
