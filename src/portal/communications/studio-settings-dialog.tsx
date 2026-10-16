// Wording and design for one Studio campaign: its default subject and copy (email and text), and the
// stationery details it uses (Save the Date headline, final instructions, the thank-you message and
// photograph). Saved to the "studio" settings document and audited. Nothing is sent from here.
import { useEffect, useState } from "react";
import { Palette } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { Select } from "@/components/base/select/select";
import { TextArea } from "@/components/base/textarea/textarea";
import { Toggle } from "@/components/base/toggle/toggle";
import { MessageEditor } from "@/portal/communications/message-editor";
import { PortalDialog } from "@/portal/components/dialog";
import { FormError, useSubmit } from "@/portal/components/form";
import { Notice } from "@/portal/components/notice";
import { api } from "@/portal/lib/api";
import { CAMPAIGNS, type CampaignKind } from "@/shared/portal/campaigns";
import type { StudioSettings } from "@/shared/portal/types";

interface StudioSettingsDialogProps {
    kind: CampaignKind | null;
    studio: StudioSettings;
    photos: { id: string; url: string; alt: string }[];
    onOpenChange: (open: boolean) => void;
    onSaved: (studio: StudioSettings) => void;
}

const ACCENTS = [
    { id: "burgundy", label: "Burgundy" },
    { id: "clay", label: "Muted clay" },
    { id: "eucalyptus", label: "Eucalyptus" },
];

export const StudioSettingsDialog = ({ kind, studio, photos, onOpenChange, onSaved }: StudioSettingsDialogProps) => {
    const [draft, setDraft] = useState<StudioSettings>(studio);
    const [channel, setChannel] = useState<"email" | "sms">("email");
    useEffect(() => {
        if (kind) setDraft(studio);
    }, [kind, studio]);
    const copy = kind ? (draft.copy[kind] ?? CAMPAIGNS[kind].copy) : null;
    const setCopy = (next: Partial<NonNullable<typeof copy>>) => kind && copy && setDraft({ ...draft, copy: { ...draft.copy, [kind]: { ...copy, ...next } } });

    const save = useSubmit(() => api<{ value: StudioSettings }>("PUT", "/api/portal/settings/studio", draft), {
        success: "Studio wording saved",
        onSuccess: ({ value }) => {
            onSaved(value);
            onOpenChange(false);
        },
    });

    if (!kind || !copy) return null;
    const campaign = CAMPAIGNS[kind];
    return (
        <PortalDialog
            isOpen={kind !== null}
            onOpenChange={onOpenChange}
            title={`${campaign.label}: wording and design`}
            description="The starting point every time you create one. You can still change the wording for a particular message."
            icon={Palette}
            size="lg"
            onSubmit={save.submit}
            footer={
                <>
                    <Button
                        color="tertiary"
                        className="mr-auto"
                        onClick={() => {
                            const { [kind]: _removed, ...rest } = draft.copy;
                            setDraft({ ...draft, copy: rest });
                        }}
                    >
                        Use the built-in wording
                    </Button>
                    <Button color="secondary" size="lg" onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                    <Button type="submit" size="lg" isLoading={save.busy} showTextWhileLoading>
                        Save
                    </Button>
                </>
            }
        >
            <FormError message={save.error?.message} />
            <Select
                label="Accent colour"
                hint="One restrained accent across the email and printed cards, with warm ivory and espresso."
                items={ACCENTS}
                value={draft.accent}
                onChange={(v) => setDraft({ ...draft, accent: v as StudioSettings["accent"] })}
            >
                {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
            </Select>

            {kind === "save_the_date" && (
                <>
                    <Input
                        label="Headline"
                        value={draft.saveTheDate.headline}
                        onChange={(v) => setDraft({ ...draft, saveTheDate: { ...draft.saveTheDate, headline: v } })}
                    />
                    <Input
                        label="Follow-up line"
                        hint="Printed beneath the venue, e.g. “Formal invitation to follow”."
                        value={draft.saveTheDate.followUp}
                        onChange={(v) => setDraft({ ...draft, saveTheDate: { ...draft.saveTheDate, followUp: v } })}
                    />
                    <Toggle
                        label="Include an add-to-calendar link"
                        hint="An all-day event on the wedding date, so no time is implied. Uses {{calendar_link}}."
                        isSelected={draft.saveTheDate.showCalendarLink}
                        onChange={(on) => setDraft({ ...draft, saveTheDate: { ...draft.saveTheDate, showCalendarLink: on } })}
                    />
                </>
            )}

            {kind === "final_details" && (
                <>
                    <Notice color="brand" title="Only confirmed details are used">
                        Times come from Events ({"{{event_schedule}}"} says “time to be confirmed” until a time is set). The courtesy bus and accommodation come
                        from the published website, and each household's own bus answer from their RSVP. Nothing is made up.
                    </Notice>
                    <TextArea
                        label="Final instructions"
                        rows={5}
                        hint="Anything else guests need on the day. Uses {{final_notes}}; left out when empty."
                        value={draft.finalDetails.notes}
                        onChange={(v) => setDraft({ ...draft, finalDetails: { ...draft.finalDetails, notes: v } })}
                    />
                    <Toggle
                        label="Include the courtesy bus section from the website"
                        isSelected={draft.finalDetails.includeTransport}
                        onChange={(on) => setDraft({ ...draft, finalDetails: { ...draft.finalDetails, includeTransport: on } })}
                    />
                    <Toggle
                        label="Include the accommodation section from the website"
                        isSelected={draft.finalDetails.includeAccommodation}
                        onChange={(on) => setDraft({ ...draft, finalDetails: { ...draft.finalDetails, includeAccommodation: on } })}
                    />
                </>
            )}

            {kind === "thank_you" && (
                <>
                    <Input
                        label="Headline"
                        value={draft.thankYou.headline}
                        onChange={(v) => setDraft({ ...draft, thankYou: { ...draft.thankYou, headline: v } })}
                    />
                    <TextArea
                        label="Thank-you message"
                        rows={4}
                        hint="The general wording for everyone ({{thank_you_message}}). Add personal notes per household separately."
                        value={draft.thankYou.message}
                        onChange={(v) => setDraft({ ...draft, thankYou: { ...draft.thankYou, message: v } })}
                    />
                    <Select
                        label="Wedding photograph"
                        hint="From the website photo library. Shown in emails once the website is published; always on printed cards (JPEG or PNG)."
                        items={[{ id: "none", label: "No photograph" }, ...photos.map((p) => ({ id: p.id, label: p.alt || p.url.split("/").pop() || p.id }))]}
                        value={draft.thankYou.photoId ?? "none"}
                        onChange={(v) => setDraft({ ...draft, thankYou: { ...draft.thankYou, photoId: v === "none" ? null : String(v) } })}
                    >
                        {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                    </Select>
                    <Input
                        label="Photo gallery link"
                        type="url"
                        placeholder="https://"
                        hint="Optional ({{gallery_link}}). The line is left out until you add one."
                        value={draft.thankYou.galleryUrl}
                        onChange={(v) => setDraft({ ...draft, thankYou: { ...draft.thankYou, galleryUrl: v } })}
                    />
                </>
            )}

            <div className="flex flex-col gap-3 rounded-xl bg-secondary p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-secondary">Default wording</p>
                    <Select
                        aria-label="Channel"
                        size="sm"
                        className="w-44"
                        items={[
                            { id: "email", label: "Email" },
                            { id: "sms", label: "Text message" },
                        ]}
                        value={channel}
                        onChange={(v) => setChannel(v as "email" | "sms")}
                    >
                        {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                    </Select>
                </div>
                <MessageEditor
                    subject={copy.subject}
                    body={channel === "sms" ? copy.smsBody : copy.body}
                    channel={channel}
                    onChange={(next) => setCopy(channel === "sms" ? { subject: next.subject, smsBody: next.body } : { subject: next.subject, body: next.body })}
                    fieldError={save.fieldError}
                />
            </div>
        </PortalDialog>
    );
};
