// Compose a message: choose a template, write the subject and body, pick an audience, preview it
// for a real guest, then prepare it. Preparing freezes the recipient list; sending is a separate,
// gated step on the message page.
import { useEffect, useState } from "react";
import { Eye } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { Checkbox } from "@/components/base/checkbox/checkbox";
import { Label } from "@/components/base/input/label";
import { Select } from "@/components/base/select/select";
import { MessageEditor } from "@/portal/communications/message-editor";
import { PreviewDialog } from "@/portal/communications/preview-dialog";
import { FormError, FormGrid, useSubmit } from "@/portal/components/form";
import { RecordPanel } from "@/portal/components/record-panel";
import { RSVP_LABELS } from "@/portal/components/status";
import { api } from "@/portal/lib/api";
import { pluralise } from "@/portal/lib/format";
import { usePortal } from "@/portal/portal-context";
import type { Audience, Message, MessageTemplate, RsvpStatus, Side, WeddingEvent } from "@/shared/portal/types";

interface ComposePanelProps {
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
    templates: MessageTemplate[];
    events: WeddingEvent[];
    groups: string[];
    tags: string[];
    initialTemplate: MessageTemplate | null;
}

type AudiencePreview = { total: number; withEmail: number; sample: { id: string; name: string; email: string | null }[] };

const ANY = "any";

export const ComposePanel = ({ isOpen, onOpenChange, templates, events, groups, tags, initialTemplate }: ComposePanelProps) => {
    const { sideLabel } = usePortal();
    const [templateId, setTemplateId] = useState<string | null>(null);
    const [content, setContent] = useState({ subject: "", body: "" });
    const [audience, setAudience] = useState<Audience>({ rsvp: [] });
    const [preview, setPreview] = useState<AudiencePreview | null>(null);
    const [previewOpen, setPreviewOpen] = useState(false);

    useEffect(() => {
        if (!isOpen) return;
        setTemplateId(initialTemplate?.id ?? null);
        setContent({ subject: initialTemplate?.subject ?? "", body: initialTemplate?.body ?? "" });
        setAudience({ rsvp: [] });
    }, [isOpen, initialTemplate]);

    // Live recipient count, debounced.
    useEffect(() => {
        if (!isOpen) return;
        const timer = window.setTimeout(() => {
            api<AudiencePreview>("POST", "/api/portal/wedding/messages/audience", audience)
                .then(setPreview)
                .catch(() => setPreview(null));
        }, 250);
        return () => window.clearTimeout(timer);
    }, [audience, isOpen]);

    const prepare = useSubmit(() => api<{ message: Message }>("POST", "/api/portal/wedding/messages", { templateId, ...content, audience }), {
        onSuccess: ({ message }) => window.location.assign(`/portal/wedding/communications/${message.id}`),
    });

    const toggleRsvp = (status: RsvpStatus | "not_invited", on: boolean) =>
        setAudience({ ...audience, rsvp: on ? [...(audience.rsvp ?? []), status] : (audience.rsvp ?? []).filter((s) => s !== status) });

    const select = (label: string, value: string | null | undefined, options: { id: string; label: string }[], onChange: (v: string | null) => void) => (
        <Select label={label} items={[{ id: ANY, label: "Anyone" }, ...options]} value={value ?? ANY} onChange={(v) => onChange(v === ANY ? null : String(v))}>
            {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
        </Select>
    );

    return (
        <>
            <RecordPanel
                isOpen={isOpen}
                onOpenChange={onOpenChange}
                title="New message"
                description="Prepare a message for a group of guests. You'll review the recipients before anything is sent."
                width="lg"
                onSubmit={prepare.submit}
                footer={
                    <>
                        <Button
                            color="secondary"
                            iconLeading={Eye}
                            onClick={() => setPreviewOpen(true)}
                            isDisabled={!content.subject && !content.body}
                            className="mr-auto"
                        >
                            Preview
                        </Button>
                        <Button color="secondary" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" isLoading={prepare.busy} showTextWhileLoading isDisabled={!preview?.total}>
                            Prepare message
                        </Button>
                    </>
                }
            >
                <div className="flex flex-col gap-6">
                    <FormError message={prepare.error && !prepare.fieldError("subject") && !prepare.fieldError("body") ? prepare.error.message : null} />
                    {templates.length > 0 && (
                        <Select
                            label="Start from a template"
                            items={[{ id: "none", label: "Blank message" }, ...templates.map((t) => ({ id: t.id, label: t.name }))]}
                            value={templateId ?? "none"}
                            onChange={(v) => {
                                const template = templates.find((t) => t.id === v) ?? null;
                                setTemplateId(template?.id ?? null);
                                if (template) setContent({ subject: template.subject, body: template.body });
                            }}
                        >
                            {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                        </Select>
                    )}

                    <MessageEditor subject={content.subject} body={content.body} onChange={setContent} fieldError={prepare.fieldError} />

                    <section aria-labelledby="audience-heading" className="flex flex-col gap-4 rounded-xl bg-secondary p-4">
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                            <h3 id="audience-heading" className="text-sm font-semibold text-secondary">
                                Recipients
                            </h3>
                            <p className="text-sm text-tertiary" aria-live="polite">
                                {preview
                                    ? `${pluralise(preview.total, "guest")} match · ${pluralise(preview.withEmail, "has", "have")} an email address`
                                    : "Counting…"}
                            </p>
                        </div>
                        <FormGrid>
                            {events.length > 0 &&
                                select(
                                    "Invited to",
                                    audience.eventId,
                                    events.map((e) => ({ id: e.id, label: e.name })),
                                    (v) => setAudience({ ...audience, eventId: v }),
                                )}
                            {select(
                                "Side",
                                audience.side?.[0],
                                (["partner_one", "partner_two", "shared"] as Side[]).map((s) => ({ id: s, label: sideLabel(s) })),
                                (v) => setAudience({ ...audience, side: v ? [v as Side] : [] }),
                            )}
                            {groups.length > 0 &&
                                select(
                                    "Group",
                                    audience.groupName,
                                    groups.map((g) => ({ id: g, label: g })),
                                    (v) => setAudience({ ...audience, groupName: v }),
                                )}
                            {tags.length > 0 &&
                                select(
                                    "Tag",
                                    audience.tag,
                                    tags.map((t) => ({ id: t, label: t })),
                                    (v) => setAudience({ ...audience, tag: v }),
                                )}
                        </FormGrid>
                        <div className="flex flex-col gap-2">
                            <Label>{audience.eventId ? "RSVP for that event" : "RSVP"}</Label>
                            <div className="flex flex-wrap gap-x-5 gap-y-2">
                                {(["pending", "attending", "declined", ...(audience.eventId ? [] : ["not_invited"])] as (RsvpStatus | "not_invited")[]).map(
                                    (status) => (
                                        <Checkbox
                                            key={status}
                                            label={RSVP_LABELS[status]}
                                            isSelected={audience.rsvp?.includes(status) ?? false}
                                            onChange={(on) => toggleRsvp(status, on)}
                                        />
                                    ),
                                )}
                            </div>
                            <p className="text-xs text-tertiary">Leave all unticked to include everyone.</p>
                        </div>
                        {preview && preview.sample.length > 0 && (
                            <p className="text-xs text-tertiary">
                                Including{" "}
                                {preview.sample
                                    .slice(0, 5)
                                    .map((g) => g.name)
                                    .join(", ")}
                                {preview.total > 5 ? ` and ${pluralise(preview.total - 5, "other")}` : ""}.
                            </p>
                        )}
                    </section>
                </div>
            </RecordPanel>
            <PreviewDialog isOpen={previewOpen} onOpenChange={setPreviewOpen} subject={content.subject} body={content.body} guests={preview?.sample ?? []} />
        </>
    );
};
