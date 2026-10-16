// Compose a message or a Studio campaign: choose the channel and recipients, customise the copy,
// preview it for a real household, then prepare a draft. Preparing freezes the recipient list;
// testing, the send check, scheduling and sending happen on the message page, so nothing can reach
// a guest from here.
import { useEffect, useState } from "react";
import { Eye } from "@untitledui/icons";
import { Badge } from "@/components/base/badges/badges";
import { ButtonGroup, ButtonGroupItem } from "@/components/base/button-group/button-group";
import { Button } from "@/components/base/buttons/button";
import { Checkbox } from "@/components/base/checkbox/checkbox";
import { Label } from "@/components/base/input/label";
import { MultiSelect } from "@/components/base/select/multi-select";
import { Select } from "@/components/base/select/select";
import { Toggle } from "@/components/base/toggle/toggle";
import { MessageEditor } from "@/portal/communications/message-editor";
import { PreviewDialog, type PreviewHousehold } from "@/portal/communications/preview-dialog";
import { FormError, FormGrid, useSubmit } from "@/portal/components/form";
import { RecordPanel } from "@/portal/components/record-panel";
import { RSVP_LABELS } from "@/portal/components/status";
import { api } from "@/portal/lib/api";
import { pluralise } from "@/portal/lib/format";
import { usePortal } from "@/portal/portal-context";
import { CAMPAIGNS, type CampaignKind, REMINDER_TARGETS, REMINDER_TARGET_LABELS, type ReminderTarget } from "@/shared/portal/campaigns";
import {
    type AgeGroup,
    type Audience,
    type ContactPreference,
    type HouseholdResponseStatus,
    MESSAGE_CATEGORIES,
    MESSAGE_CATEGORY_LABELS,
    type Message,
    type MessageCategory,
    type MessageChannel,
    type MessageTemplate,
    type RsvpStatus,
    type Side,
    type StudioSettings,
    type WeddingEvent,
} from "@/shared/portal/types";

interface ComposePanelProps {
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
    templates: MessageTemplate[];
    events: WeddingEvent[];
    groups: string[];
    tags: string[];
    initialTemplate: MessageTemplate | null;
    /** A Studio campaign; null for a general message. */
    kind?: CampaignKind | null;
    studio: StudioSettings;
    households: (PreviewHousehold & { status: HouseholdResponseStatus })[];
    guests: { id: string; name: string; householdId: string | null }[];
}

type RecipientMode = "specific" | "filtered" | "all";

/** Exactly who a message would be prepared for: households, guests, and the people and addresses it goes to. */
type RecipientPlan = {
    households: number;
    guests: number;
    recipients: { name: string; to: string; householdId: string | null }[];
    held: { reason: string; count: number }[];
};

type AudiencePreview = {
    total: number;
    households: number;
    withEmail: number;
    withMobile: number;
    invalidMobile: number;
    sample: { id: string; name: string; email: string | null }[];
    reasons: { householdId: string; name: string; status: HouseholdResponseStatus; followUp: boolean }[];
};

const ANY = "any";

const STATUS_LABELS: Record<HouseholdResponseStatus, string> = {
    not_started: "No reply yet",
    partial: "Partly answered",
    complete: "Replied",
    not_invited: "Not invited",
};

/** Who each campaign is aimed at when it's opened. */
const DEFAULT_AUDIENCE: Record<CampaignKind, Audience> = {
    save_the_date: {},
    invitation: {},
    reminder: { reminder: ["not_started", "partial"] },
    final_details: { rsvp: ["attending"] },
    thank_you: { rsvp: ["attending"] },
};

const copyFor = (studio: StudioSettings, kind: CampaignKind, channel: MessageChannel) => {
    const copy = studio.copy[kind] ?? CAMPAIGNS[kind].copy;
    return { subject: copy.subject, body: channel === "sms" ? copy.smsBody : copy.body };
};

export const ComposePanel = ({
    isOpen,
    onOpenChange,
    templates,
    events,
    groups,
    tags,
    initialTemplate,
    kind = null,
    studio,
    households,
    guests,
}: ComposePanelProps) => {
    const { sideLabel } = usePortal();
    const [templateId, setTemplateId] = useState<string | null>(null);
    const [content, setContent] = useState({ subject: "", body: "" });
    const [edited, setEdited] = useState(false);
    const [category, setCategory] = useState<MessageCategory>("update");
    const [individualDelivery, setIndividualDelivery] = useState(false);
    const [resend, setResend] = useState(false);
    const [channel, setChannel] = useState<MessageChannel>("email");
    // How recipients are chosen. "specific" (the default) is exactly the guests and households picked.
    const [mode, setMode] = useState<RecipientMode>("specific");
    const [selection, setSelection] = useState<{ householdIds: string[]; guestIds: string[] }>({ householdIds: [], guestIds: [] });
    // The filters, used only in "filtered" mode.
    const [audience, setAudience] = useState<Audience>({});
    const [preview, setPreview] = useState<AudiencePreview | null>(null);
    const [plan, setPlan] = useState<RecipientPlan | null>(null);
    const [previewOpen, setPreviewOpen] = useState(false);
    const campaign = kind ? CAMPAIGNS[kind] : null;

    useEffect(() => {
        if (!isOpen) return;
        setTemplateId(initialTemplate?.id ?? null);
        setChannel("email");
        setIndividualDelivery(false);
        setResend(false);
        setEdited(false);
        setMode("specific");
        setSelection({ householdIds: [], guestIds: [] });
        if (kind) {
            setCategory(kind);
            setContent(copyFor(studio, kind, "email"));
            setAudience(DEFAULT_AUDIENCE[kind]);
        } else {
            setCategory(initialTemplate?.category ?? "update");
            setContent({ subject: initialTemplate?.subject ?? "", body: initialTemplate?.body ?? "" });
            setAudience({});
        }
    }, [isOpen, initialTemplate, kind, studio]);

    // A campaign's wording follows the channel until it's been edited.
    const changeChannel = (next: MessageChannel) => {
        setChannel(next);
        if (kind && !edited) setContent(copyFor(studio, kind, next));
    };

    const effective: Audience =
        mode === "specific" ? { mode, householdIds: selection.householdIds, guestIds: selection.guestIds } : mode === "all" ? { mode } : { ...audience, mode };

    // Who it would go to, worked out by the Worker exactly as preparing does. Debounced.
    const planKey = JSON.stringify({ effective, category, channel, individualDelivery, resend });
    useEffect(() => {
        if (!isOpen) return;
        const timer = window.setTimeout(() => {
            api<RecipientPlan>("POST", "/api/portal/wedding/messages/plan", {
                audience: effective,
                category,
                channel,
                individualDelivery: !!campaign && individualDelivery,
                resend: !!campaign?.oncePerHousehold && resend,
            })
                .then(setPlan)
                .catch(() => setPlan(null));
            // Reminder reasons ("No reply yet", "Partly answered") for a filtered group.
            if (mode === "filtered" && effective.reminder?.length)
                api<AudiencePreview>("POST", "/api/portal/wedding/messages/audience", effective)
                    .then(setPreview)
                    .catch(() => setPreview(null));
            else setPreview(null);
        }, 250);
        return () => window.clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [planKey, isOpen]);

    const prepare = useSubmit(
        () =>
            api<{ message: Message }>("POST", "/api/portal/wedding/messages", {
                templateId,
                ...content,
                audience: effective,
                channel,
                category,
                individualDelivery: !!campaign && individualDelivery,
                resend: !!campaign?.oncePerHousehold && resend,
            }),
        { onSuccess: ({ message }) => window.location.assign(`/portal/wedding/communications/${message.id}`) },
    );

    const toggleRsvp = (status: RsvpStatus | "not_invited", on: boolean) =>
        setAudience({ ...audience, rsvp: on ? [...(audience.rsvp ?? []), status] : (audience.rsvp ?? []).filter((s) => s !== status) });
    const toggleTarget = (target: ReminderTarget, on: boolean) =>
        setAudience({ ...audience, reminder: on ? [...(audience.reminder ?? []), target] : (audience.reminder ?? []).filter((t) => t !== target) });

    const select = (label: string, value: string | null | undefined, options: { id: string; label: string }[], onChange: (v: string | null) => void) => (
        <Select label={label} items={[{ id: ANY, label: "Anyone" }, ...options]} value={value ?? ANY} onChange={(v) => onChange(v === ANY ? null : String(v))}>
            {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
        </Select>
    );

    const isReminder = kind === "reminder";
    const noTargets = mode === "filtered" && isReminder && !audience.reminder?.length;
    const nothingChosen = mode === "specific" && !selection.householdIds.length && !selection.guestIds.length;
    const householdName = (id: string | null) => (id ? (households.find((h) => h.id === id)?.line ?? "") : "");

    return (
        <>
            <RecordPanel
                isOpen={isOpen}
                onOpenChange={onOpenChange}
                title={campaign ? `New ${campaign.label.toLowerCase()}` : "New message"}
                description={
                    campaign
                        ? `${campaign.description} You'll preview it, test it and check every recipient before anything is sent.`
                        : "Prepare a message for a group of guests. You'll review the recipients before anything is sent."
                }
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
                        <Button type="submit" isLoading={prepare.busy} showTextWhileLoading isDisabled={!plan?.recipients.length || noTargets || nothingChosen}>
                            Prepare draft
                        </Button>
                    </>
                }
            >
                <div className="flex flex-col gap-6">
                    <ol className="flex flex-wrap gap-x-4 gap-y-1 text-xs font-medium text-tertiary" aria-label="Steps">
                        {["Recipients", "Customise", "Preview", "Then: test, check and send"].map((step, index) => (
                            <li key={step} className="flex items-center gap-1.5">
                                <span className="flex size-5 items-center justify-center rounded-full bg-secondary text-secondary">{index + 1}</span>
                                {step}
                            </li>
                        ))}
                    </ol>
                    <FormError message={prepare.error && !prepare.fieldError("subject") && !prepare.fieldError("body") ? prepare.error.message : null} />

                    {!campaign && templates.length > 0 && (
                        <Select
                            label="Start from a template"
                            items={[{ id: "none", label: "Blank message" }, ...templates.map((t) => ({ id: t.id, label: t.name }))]}
                            value={templateId ?? "none"}
                            onChange={(v) => {
                                const template = templates.find((t) => t.id === v) ?? null;
                                setTemplateId(template?.id ?? null);
                                if (template) setContent({ subject: template.subject, body: template.body });
                                if (template) setCategory(template.category);
                            }}
                        >
                            {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                        </Select>
                    )}

                    <Select
                        label="Send as"
                        items={[
                            { id: "email", label: "Email" },
                            { id: "sms", label: "Text message (SMS)" },
                        ]}
                        value={channel}
                        onChange={(value) => changeChannel(value as MessageChannel)}
                        hint={
                            channel === "sms"
                                ? "Short and branded, linking to the website. Guests who replied STOP are skipped automatically."
                                : campaign
                                  ? "Sent in the wedding stationery design, with a plain-text version for every email client."
                                  : undefined
                        }
                    >
                        {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                    </Select>

                    {!campaign && (
                        <Select
                            label="Category"
                            items={MESSAGE_CATEGORIES.map((item) => ({ id: item, label: MESSAGE_CATEGORY_LABELS[item] }))}
                            value={category}
                            onChange={(value) => setCategory(value as MessageCategory)}
                            hint="For save the dates, invitations, reminders, final information and thank-yous, use the Studio cards: they go once per household."
                        >
                            {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                        </Select>
                    )}

                    <section aria-labelledby="audience-heading" className="flex flex-col gap-4 rounded-xl bg-secondary p-4">
                        <h3 id="audience-heading" className="text-sm font-semibold text-secondary">
                            1. Recipients
                        </h3>
                        <ButtonGroup
                            size="sm"
                            selectionMode="single"
                            disallowEmptySelection
                            selectedKeys={[mode]}
                            onSelectionChange={(keys) => {
                                const next = [...keys][0] as RecipientMode;
                                setMode(next);
                                if (next === "filtered" && kind && !Object.keys(audience).length) setAudience(DEFAULT_AUDIENCE[kind]);
                            }}
                            aria-label="How to choose recipients"
                            className="max-w-full flex-wrap"
                        >
                            <ButtonGroupItem id="specific">Specific guests or households</ButtonGroupItem>
                            <ButtonGroupItem id="filtered">Filtered group</ButtonGroupItem>
                            <ButtonGroupItem id="all">All eligible guests</ButtonGroupItem>
                        </ButtonGroup>

                        {mode === "specific" && (
                            <div className="flex flex-col gap-4">
                                <p className="text-sm text-tertiary">
                                    Only the households and guests you choose. Nothing else is added, so choosing one household reaches that household alone.
                                </p>
                                <MultiSelect
                                    label="Households"
                                    placeholder="Search households"
                                    items={households.map((h) => ({ id: h.id, label: h.line, supportingText: STATUS_LABELS[h.status] }))}
                                    selectedKeys={new Set(selection.householdIds)}
                                    onSelectionChange={(keys) =>
                                        setSelection({ ...selection, householdIds: keys === "all" ? households.map((h) => h.id) : [...keys].map(String) })
                                    }
                                    onReset={() => setSelection({ ...selection, householdIds: [] })}
                                    showFooter={false}
                                >
                                    {(item) => (
                                        <MultiSelect.Item id={item.id} supportingText={item.supportingText}>
                                            {item.label}
                                        </MultiSelect.Item>
                                    )}
                                </MultiSelect>
                                <MultiSelect
                                    label="Guests"
                                    placeholder="Search guests"
                                    hint={
                                        campaign && !individualDelivery
                                            ? "A guest chosen on their own still gets their household's invitation-style message, addressed to the household."
                                            : undefined
                                    }
                                    items={guests.map((g) => ({ id: g.id, label: g.name, supportingText: householdName(g.householdId) || "No household" }))}
                                    selectedKeys={new Set(selection.guestIds)}
                                    onSelectionChange={(keys) =>
                                        setSelection({ ...selection, guestIds: keys === "all" ? guests.map((g) => g.id) : [...keys].map(String) })
                                    }
                                    onReset={() => setSelection({ ...selection, guestIds: [] })}
                                    showFooter={false}
                                >
                                    {(item) => (
                                        <MultiSelect.Item id={item.id} supportingText={item.supportingText}>
                                            {item.label}
                                        </MultiSelect.Item>
                                    )}
                                </MultiSelect>
                            </div>
                        )}

                        {mode === "all" && (
                            <p className="text-sm text-tertiary">
                                Every guest on the list, one message per household. Anyone who can't be reached, has opted out or{" "}
                                {isReminder ? "has already replied" : "has already had one"} is held back.
                            </p>
                        )}

                        {mode === "filtered" && (
                            <div className="flex flex-col gap-4">
                                {isReminder && (
                                    <div className="flex flex-col gap-2">
                                        <Label>Remind households that are…</Label>
                                        <div className="flex flex-col gap-2">
                                            {REMINDER_TARGETS.map((target) => (
                                                <Checkbox
                                                    key={target}
                                                    label={REMINDER_TARGET_LABELS[target].label}
                                                    hint={REMINDER_TARGET_LABELS[target].hint}
                                                    isSelected={audience.reminder?.includes(target) ?? false}
                                                    onChange={(on) => toggleTarget(target, on)}
                                                />
                                            ))}
                                        </div>
                                        <p className="text-xs text-tertiary">
                                            Households that have replied for everyone are never reminded, now or when it's sent.
                                        </p>
                                    </div>
                                )}

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
                                    {select(
                                        "Age group",
                                        audience.ageGroup?.[0],
                                        [
                                            { id: "adult", label: "Adults" },
                                            { id: "child", label: "Children" },
                                            { id: "infant", label: "Infants" },
                                        ],
                                        (value) => setAudience({ ...audience, ageGroup: value ? [value as AgeGroup] : [] }),
                                    )}
                                    {select(
                                        "Contact preference",
                                        audience.contactPreference?.[0],
                                        [
                                            { id: "email", label: "Email" },
                                            { id: "post", label: "Post" },
                                            { id: "phone", label: "Phone" },
                                            { id: "none", label: "No preference" },
                                        ],
                                        (value) => setAudience({ ...audience, contactPreference: value ? [value as ContactPreference] : [] }),
                                    )}
                                </FormGrid>
                                {!isReminder && (
                                    <div className="flex flex-col gap-2">
                                        <Label>{audience.eventId ? "RSVP for that event" : "RSVP"}</Label>
                                        <div className="flex flex-wrap gap-x-5 gap-y-2">
                                            {(
                                                ["pending", "attending", "declined", ...(audience.eventId ? [] : ["not_invited"])] as (
                                                    RsvpStatus | "not_invited"
                                                )[]
                                            ).map((status) => (
                                                <Checkbox
                                                    key={status}
                                                    label={RSVP_LABELS[status]}
                                                    isSelected={audience.rsvp?.includes(status) ?? false}
                                                    onChange={(on) => toggleRsvp(status, on)}
                                                />
                                            ))}
                                        </div>
                                        <p className="text-xs text-tertiary">Leave all unticked to include everyone.</p>
                                    </div>
                                )}

                                {isReminder && preview && preview.reasons.length > 0 && (
                                    <div className="flex flex-col gap-2">
                                        <p className="text-sm font-medium text-secondary">Why each household is included</p>
                                        <ul className="flex max-h-56 flex-col divide-y divide-secondary overflow-y-auto rounded-lg bg-primary ring-1 ring-secondary">
                                            {preview.reasons.map((r) => (
                                                <li key={r.householdId} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                                                    <span className="min-w-0 truncate text-primary">
                                                        {households.find((h) => h.id === r.householdId)?.line ?? r.name}
                                                    </span>
                                                    <span className="flex shrink-0 gap-1.5">
                                                        {(r.status === "not_started" || r.status === "partial") && (
                                                            <Badge size="sm" color={r.status === "partial" ? "warning" : "gray"} type="pill-color">
                                                                {STATUS_LABELS[r.status]}
                                                            </Badge>
                                                        )}
                                                        {r.followUp && (
                                                            <Badge size="sm" color="brand" type="pill-color">
                                                                Follow-up
                                                            </Badge>
                                                        )}
                                                    </span>
                                                </li>
                                            ))}
                                        </ul>
                                    </div>
                                )}
                            </div>
                        )}

                        <div className="flex flex-col gap-2 rounded-lg bg-primary p-3 ring-1 ring-secondary" aria-live="polite">
                            {!plan ? (
                                <p className="text-sm text-tertiary">{nothingChosen ? "Choose at least one household or guest." : "Checking…"}</p>
                            ) : (
                                <>
                                    <p className="text-sm text-secondary">
                                        <span className="font-semibold">{pluralise(plan.households, "household")}</span> selected ·{" "}
                                        {pluralise(plan.guests, "guest")} in them ·{" "}
                                        <span className="font-semibold">{pluralise(plan.recipients.length, channel === "sms" ? "text" : "email")} to send</span>
                                    </p>
                                    {plan.recipients.length > 0 && (
                                        <ul className="flex max-h-48 flex-col divide-y divide-secondary overflow-y-auto text-sm">
                                            {plan.recipients.map((r, index) => (
                                                <li key={`${r.to}-${index}`} className="flex flex-col py-1.5 sm:flex-row sm:justify-between sm:gap-3">
                                                    <span className="text-primary">{r.name}</span>
                                                    <span className="font-mono text-xs break-all text-tertiary">{r.to}</span>
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                    {plan.held.length > 0 && (
                                        <p className="text-xs text-tertiary">Held back: {plan.held.map((h) => `${h.reason} (${h.count})`).join(" · ")}</p>
                                    )}
                                </>
                            )}
                        </div>
                    </section>

                    <section aria-labelledby="copy-heading" className="flex flex-col gap-4">
                        <h3 id="copy-heading" className="text-sm font-semibold text-secondary">
                            2. Customise
                        </h3>
                        <MessageEditor
                            subject={content.subject}
                            body={content.body}
                            onChange={(next) => {
                                setContent(next);
                                setEdited(true);
                            }}
                            fieldError={prepare.fieldError}
                            channel={channel}
                        />
                    </section>

                    {campaign && (
                        <section aria-labelledby="delivery-heading" className="flex flex-col gap-4 rounded-xl bg-secondary p-4">
                            <h3 id="delivery-heading" className="text-sm font-semibold text-secondary">
                                Delivery
                            </h3>
                            <Toggle
                                label="Send to each guest individually"
                                hint="Advanced. Every matching guest with an address gets their own copy instead of one per household."
                                isSelected={individualDelivery}
                                onChange={setIndividualDelivery}
                            />
                            {campaign.oncePerHousehold && (
                                <Toggle
                                    label="Send again to households that already have one"
                                    hint={`Off by default: a household is only sent one ${campaign.label.toLowerCase()}.`}
                                    isSelected={resend}
                                    onChange={setResend}
                                />
                            )}
                        </section>
                    )}
                </div>
            </RecordPanel>
            <PreviewDialog
                isOpen={previewOpen}
                onOpenChange={setPreviewOpen}
                subject={content.subject}
                body={content.body}
                category={category}
                channel={channel}
                individual={!campaign || individualDelivery}
                households={households.filter((h) => mode !== "specific" || !selection.householdIds.length || selection.householdIds.includes(h.id))}
            />
        </>
    );
};
