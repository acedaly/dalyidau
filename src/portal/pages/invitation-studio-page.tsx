import { useEffect, useMemo, useState } from "react";
import { Download01, Eye, Link01, Printer } from "@untitledui/icons";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { Checkbox } from "@/components/base/checkbox/checkbox";
import { Input } from "@/components/base/input/input";
import { Select } from "@/components/base/select/select";
import { TextArea } from "@/components/base/textarea/textarea";
import { Toggle } from "@/components/base/toggle/toggle";
import { ConfirmDialog } from "@/portal/components/dialog";
import { Empty } from "@/portal/components/empty";
import { Notice } from "@/portal/components/notice";
import { PageHeader } from "@/portal/components/page-header";
import { useToast } from "@/portal/components/toast";
import { api, errorMessage } from "@/portal/lib/api";
import type { PageData } from "@/portal/lib/page-types";
import { usePortal } from "@/portal/portal-context";
import { studioInvitationCopy } from "@/shared/portal/campaigns";
import type { InvitationDelivery, InvitationPreview, InvitationStudioHousehold, InvitationTemplateSettings, Message } from "@/shared/portal/types";
import { cx } from "@/utils/cx";

const ACCENTS: Record<InvitationTemplateSettings["accent"], string> = {
    burgundy: "#783B4A",
    rust: "#9C765C",
    eucalyptus: "#667463",
};

type Channel = "email" | "sms" | "print";
type PreviewMode = "print" | "email" | "mobile";
type RecipientIssue = { key: string; householdId: string | null; message: string; kind: "contact" | "assignment" | "link" };
type DraftConflict = { messageId: string; channel: "email" | "sms"; subject: string; households: number; others: number };
type SentConflict = { channel: "email" | "sms"; householdIds: string[] };
type PrepareConfirmation = "replace" | "resend" | null;

const Workflow = ({ current }: { current: number }) => {
    const steps = ["Select households", "Customise invitation", "Preview", "Check recipients", "Generate or send"];
    return (
        <nav aria-label="Invitation Studio workflow" className="mb-6 overflow-x-auto rounded-xl border border-secondary bg-primary px-4 py-4 shadow-xs">
            <ol className="flex min-w-[54rem] items-center justify-between gap-3">
                {steps.map((step, index) => {
                    const complete = index < current;
                    const active = index === current;
                    return (
                        <li key={step} className="flex flex-1 items-center gap-3 last:flex-none" aria-current={active ? "step" : undefined}>
                            <span
                                className={cx(
                                    "flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ring-1 ring-inset",
                                    complete && "bg-[#798676] text-white ring-[#798676]",
                                    active && "bg-[#783B4A] text-white ring-[#783B4A]",
                                    !complete && !active && "bg-primary text-tertiary ring-secondary",
                                )}
                            >
                                {complete ? "✓" : index + 1}
                            </span>
                            <span className={cx("text-sm font-medium whitespace-nowrap", active ? "text-primary" : "text-tertiary")}>{step}</span>
                            {index < steps.length - 1 && <span aria-hidden="true" className="ml-auto h-px min-w-5 flex-1 bg-secondary" />}
                        </li>
                    );
                })}
            </ol>
        </nav>
    );
};

const CoupleNames = ({ names, accent }: { names: string; accent: string }) => {
    const [first, second] = names.split(/\s+&\s+/, 2);
    if (!second) return <span>{names}</span>;
    return (
        <>
            <span className="block">{first}</span>
            <span className="my-1 block text-[0.48em] leading-none font-normal italic" style={{ color: accent }}>
                &amp;
            </span>
            <span className="block">{second}</span>
        </>
    );
};

const InvitationCard = ({ invitation, label, compact = false }: { invitation: InvitationPreview; label: string; compact?: boolean }) => {
    const accent = ACCENTS[invitation.accent];
    return (
        <div>
            <p className="mb-2 text-xs font-semibold tracking-[.12em] text-tertiary uppercase">{label}</p>
            <div
                className={cx(
                    "wedding-theme relative mx-auto flex aspect-[148/210] w-full flex-col items-center overflow-hidden bg-[#F5F0E7] bg-cover bg-center text-center text-[#49342D] shadow-[0_22px_70px_-38px_rgb(73_52_45/0.55)] ring-1 ring-[#d8cdbc] ring-inset",
                    compact ? "max-w-[21rem] px-[10%] py-[7%]" : "max-w-[30rem] px-[11%] py-[7%]",
                )}
                style={{ backgroundImage: invitation.artwork === "native-botanicals" ? "url('/wedding/native-invitation-frame.jpg')" : undefined }}
            >
                <div aria-hidden="true" className="absolute inset-[4.5%] border border-[#783B4A]/18" />
                <div
                    aria-hidden="true"
                    className="absolute inset-x-[9%] top-[4%] h-[59%] bg-[radial-gradient(ellipse_at_center,rgba(245,240,231,0.96)_0%,rgba(245,240,231,0.78)_54%,rgba(245,240,231,0)_79%)]"
                />
                {invitation.sample && (
                    <p
                        className="absolute top-2 z-10 rounded-full bg-[#F5F0E7]/95 px-3 py-1 text-[9px] font-bold tracking-[.12em] uppercase"
                        style={{ color: accent }}
                    >
                        Sample preview — not for delivery
                    </p>
                )}
                <div className="relative z-10 flex h-full w-full flex-col items-center">
                    <p className="mt-[2%] text-[9px] font-semibold tracking-[.28em] uppercase">{invitation.eyebrow}</p>
                    <h3
                        className={cx("wedding-names mt-[5%] text-balance", compact ? "text-[2.6rem]" : "text-[clamp(3.2rem,6vw,4.7rem)]")}
                        style={{ color: "#49342D" }}
                    >
                        <CoupleNames names={invitation.coupleNames} accent={accent} />
                    </h3>
                    <p className="mt-3 max-w-[17rem] font-serif text-[0.95rem] leading-snug italic sm:text-base">{invitation.invitationLine}</p>

                    <div className="mt-4 w-full max-w-[18rem] border-y border-[#783B4A]/22 py-3">
                        <p className="text-[8px] font-semibold tracking-[.24em] uppercase" style={{ color: accent }}>
                            With pleasure, for
                        </p>
                        <p className="wedding-display mt-1.5 text-[1.25rem] leading-none font-semibold text-balance sm:text-[1.45rem]">
                            {invitation.recipientLine}
                        </p>
                        {invitation.namesLine && <p className="mt-1.5 text-[10px] leading-snug text-balance text-[#4f614d]">{invitation.namesLine}</p>}
                    </div>

                    <div className="mt-4">
                        <p className="text-[10px] font-semibold tracking-[.18em] uppercase" style={{ color: accent }}>
                            {invitation.weddingDate}
                        </p>
                        <p className="wedding-display mt-1 text-[1.25rem] leading-none font-semibold">{invitation.location}</p>
                        <div className="mt-2 space-y-0.5 text-[9px] leading-snug">
                            {invitation.eventLines.slice(0, 3).map((line) => (
                                <p key={line}>{line}</p>
                            ))}
                        </div>
                    </div>

                    <div className="mt-auto flex w-[calc(100%+1rem)] max-w-[20rem] items-center justify-center gap-3 border-t border-[#783B4A]/22 bg-[#F5F0E7] px-3 py-2.5 text-left shadow-[0_-8px_22px_rgb(245_240_231/0.95)]">
                        <div className="shrink-0 bg-white p-1 shadow-xs">
                            <img src={invitation.qrDataUrl} alt={`RSVP QR code for ${invitation.recipientLine}`} className={compact ? "size-16" : "size-20"} />
                        </div>
                        <div className="min-w-0">
                            <p className="text-[9px] font-bold tracking-[.16em] uppercase" style={{ color: accent }}>
                                Scan to RSVP
                            </p>
                            {invitation.deadline && <p className="mt-1 text-[9px] font-medium">Kindly reply by {invitation.deadline}</p>}
                            {invitation.rsvpCode && (
                                <p className="mt-1 text-[8px] leading-snug break-words">
                                    {invitation.fallback}
                                    <br />
                                    Code {invitation.rsvpCode}
                                </p>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

/**
 * The email exactly as Communications will send it to this household: the same copy, the invitation
 * card with the household's own link, and the plain-text part. Uses the saved template.
 */
const SentEmailPreview = ({
    invitation,
    template,
    width,
}: {
    invitation: InvitationPreview;
    template: InvitationTemplateSettings;
    width: "desktop" | "mobile";
}) => {
    const [email, setEmail] = useState<{ subject: string; html: string; body: string } | null>(null);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        const copy = studioInvitationCopy(template);
        api<{ subject: string; html: string; body: string }>("POST", "/api/portal/wedding/messages/preview", {
            subject: copy.subject,
            body: copy.body,
            category: "invitation",
            channel: "email",
            householdId: invitation.householdId,
            guestId: invitation.guestId,
            individual: invitation.delivery === "individual",
        })
            .then(setEmail)
            .catch((e) => setError(errorMessage(e)));
    }, [invitation.householdId, invitation.guestId, invitation.delivery, template]);
    if (error) return <p className="text-sm text-error-primary">{error}</p>;
    if (!email) return <p className="text-sm text-tertiary">Building the email…</p>;
    return (
        <div className="mx-auto flex max-w-[40rem] flex-col gap-2">
            <p className="text-sm text-tertiary">
                To: {invitation.recipientLine} · <span className="font-semibold text-primary">{email.subject}</span>
            </p>
            <iframe
                title={`Email to ${invitation.recipientLine}`}
                srcDoc={email.html}
                sandbox=""
                className="h-[70vh] w-full rounded-lg bg-primary ring-1 ring-secondary"
                style={{ maxWidth: width === "mobile" ? 375 : "100%", margin: "0 auto" }}
            />
            <details className="rounded-lg bg-secondary p-4 text-left text-sm">
                <summary className="cursor-pointer font-semibold">Plain-text version</summary>
                <p className="mt-2 text-xs leading-5 whitespace-pre-line">{email.body}</p>
            </details>
        </div>
    );
};

/** Where each household's invitation is up to, from Studio generation through Communications delivery. */
const invitationStatus = (household: InvitationStudioHousehold) => {
    const latest = [...household.messages].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const parts = latest.map((m) => {
        const channel = m.channel === "sms" ? "Text" : "Email";
        const label =
            m.status === "draft"
                ? "prepared (not sent)"
                : m.status === "queued"
                  ? "scheduled (not sent yet)"
                  : m.status === "sent"
                    ? m.deliveryStatus === "delivered"
                        ? "delivered"
                        : m.deliveryStatus && m.deliveryStatus !== "sent"
                          ? `sent · ${m.deliveryStatus}`
                          : "sent"
                    : m.status === "failed"
                      ? "send failed"
                      : "held back";
        const color: "gray" | "brand" | "success" | "error" | "warning" =
            m.status === "draft" || m.status === "queued"
                ? "brand"
                : m.status === "sent"
                  ? label === "delivered" || label === "sent"
                      ? "success"
                      : "warning"
                  : m.status === "failed"
                    ? "error"
                    : "warning";
        return {
            key: `${m.channel}-${m.messageId}`,
            text: `${channel} ${label}`,
            color: color as "gray" | "brand" | "success" | "error" | "warning",
            href: `/portal/wedding/communications/${m.messageId}`,
            error: m.error,
        };
    });
    if (!parts.length && household.invitationGeneratedAt) parts.push({ key: "generated", text: "Generated", color: "gray" as const, href: "", error: null });
    return parts;
};

const PreviewPanel = ({ invitation, mode, template }: { invitation: InvitationPreview; mode: PreviewMode; template: InvitationTemplateSettings }) => {
    if (mode === "email") return <SentEmailPreview invitation={invitation} template={template} width="desktop" />;
    if (mode === "mobile") return <SentEmailPreview invitation={invitation} template={template} width="mobile" />;
    return <InvitationCard invitation={invitation} label="Print invitation preview" />;
};

const recipientIssuesFor = (household: InvitationStudioHousehold, channels: Channel[]): RecipientIssue[] => {
    const issues: RecipientIssue[] = [];
    if (!household.guests.some((guest) => guest.invited))
        issues.push({
            key: `${household.id}-assignment`,
            householdId: household.id,
            kind: "assignment",
            message: "No guest is assigned to an RSVP-enabled event.",
        });
    if (household.inviteRevoked)
        issues.push({ key: `${household.id}-revoked`, householdId: household.id, kind: "link", message: "The household RSVP link has been revoked." });
    // The household's own address, or any invited guest's: Communications sends to the first reachable one.
    const invited = household.guests.filter((guest) => guest.invited);
    if (channels.includes("email") && !household.email && !invited.some((guest) => guest.hasEmail))
        issues.push({
            key: `${household.id}-email`,
            householdId: household.id,
            kind: "contact",
            message: "Email is selected, but neither the household nor an invited guest has an email address.",
        });
    if (channels.includes("sms") && !household.phone && !invited.some((guest) => guest.hasMobile))
        issues.push({
            key: `${household.id}-sms`,
            householdId: household.id,
            kind: "contact",
            message: "SMS is selected, but neither the household nor an invited guest has a mobile number.",
        });
    return issues;
};

export const InvitationStudioPage = ({ data }: { data: PageData<"invitation-studio"> }) => {
    const { can } = usePortal();
    const toast = useToast();
    const [selected, setSelected] = useState<string[]>([]);
    const [delivery, setDelivery] = useState<InvitationDelivery>("household");
    const [previews, setPreviews] = useState<InvitationPreview[]>([]);
    const [busy, setBusy] = useState(false);
    const channels: Channel[] = ["email", "sms", "print"];
    const [chosenChannels, setChosenChannels] = useState<Channel[]>(["print"]);
    const [template, setTemplate] = useState(data.template);
    const [savingTemplate, setSavingTemplate] = useState(false);
    const [previewMode, setPreviewMode] = useState<PreviewMode>("print");
    const [prepareDrafts, setPrepareDrafts] = useState(true);
    const [attachPdf, setAttachPdf] = useState(true);
    const [drafts, setDrafts] = useState<Message[]>([]);
    const [conflicts, setConflicts] = useState<DraftConflict[]>([]);
    const [sentConflicts, setSentConflicts] = useState<SentConflict[]>([]);
    const [prepareConfirmation, setPrepareConfirmation] = useState<PrepareConfirmation>(null);
    const digital = chosenChannels.filter((channel): channel is "email" | "sms" => channel !== "print");
    const sentHouseholds = new Set(sentConflicts.flatMap((conflict) => conflict.householdIds)).size;

    /** Creates, replaces or deliberately prepares another Communications draft. Never sends. */
    const prepare = async ({ replace = false, resend = false }: { replace?: boolean; resend?: boolean } = {}) => {
        setConflicts([]);
        setSentConflicts([]);
        setDrafts([]);
        const response = await fetch("/api/portal/wedding/invitations/prepare", {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                householdIds: selected,
                delivery,
                channels: digital,
                attachPdf: digital.includes("email") && attachPdf,
                replace,
                resend,
            }),
        });
        const body = (await response.json().catch(() => ({}))) as {
            drafts?: Message[];
            conflicts?: DraftConflict[];
            sent?: SentConflict[];
            message?: string;
        };
        if (response.status === 409) {
            setConflicts(body.conflicts ?? []);
            setSentConflicts(body.sent ?? []);
            if (body.conflicts?.length) toast.error("An unsent invitation draft already exists", "Open it, or choose Replace draft below.");
            else toast.error("An invitation was already sent", "Choose Send another invitation below if that is deliberate.");
            return;
        }
        if (!response.ok) throw new Error(body.message ?? "The drafts couldn't be prepared");
        setDrafts(body.drafts ?? []);
        toast.success(
            `${body.drafts?.length ?? 0} draft${body.drafts?.length === 1 ? "" : "s"} ready in Communications`,
            "Nothing has been sent. Review, test and send from each draft.",
        );
    };
    const request = { householdIds: selected, delivery, channels: chosenChannels };
    const selectedHouseholds = useMemo(() => data.households.filter((household) => selected.includes(household.id)), [data.households, selected]);
    const issues = useMemo(() => {
        const found = selectedHouseholds.flatMap((household) => recipientIssuesFor(household, chosenChannels));
        if (!data.canGenerateLinks)
            found.unshift({
                key: "link-configuration",
                householdId: null,
                kind: "link",
                message: "Secure RSVP links are not configured for this environment.",
            });
        return found;
    }, [chosenChannels, data.canGenerateLinks, selectedHouseholds]);
    const previewBlockers = issues.filter((issue) => issue.kind !== "contact");
    const workflowStep = previews.length ? (issues.length ? 3 : 4) : selected.length ? 2 : 0;

    const invalidatePreviews = () => {
        setPreviews([]);
        setConflicts([]);
        setSentConflicts([]);
        setDrafts([]);
        setPrepareConfirmation(null);
    };
    const updateTemplate = (next: InvitationTemplateSettings) => {
        setTemplate(next);
        invalidatePreviews();
    };
    const toggleHousehold = (id: string, on: boolean) => {
        setSelected((ids) => (on ? [...ids, id] : ids.filter((current) => current !== id)));
        invalidatePreviews();
    };

    const saveTemplate = async () => {
        setSavingTemplate(true);
        try {
            const result = await api<{ value: InvitationTemplateSettings }>("PUT", "/api/portal/settings/invitation", template);
            setTemplate(result.value);
            setPreviews([]);
            toast.success("Invitation template saved", "Preview again to see the updated recipient versions.");
        } catch (error) {
            toast.error("Couldn't save the invitation template", errorMessage(error));
        } finally {
            setSavingTemplate(false);
        }
    };

    const preview = async () => {
        setBusy(true);
        try {
            const result = await api<{ previews: InvitationPreview[] }>("POST", "/api/portal/wedding/invitations/preview", request);
            setPreviews(result.previews);
        } catch (error) {
            toast.error("Couldn't preview invitations", errorMessage(error));
        } finally {
            setBusy(false);
        }
    };

    const printPdf = async () => {
        setBusy(true);
        try {
            const response = await fetch("/api/portal/wedding/invitations/print.pdf", {
                method: "POST",
                credentials: "same-origin",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(request),
            });
            if (!response.ok) throw new Error("The printable file could not be created.");
            const url = URL.createObjectURL(await response.blob());
            const link = document.createElement("a");
            link.href = url;
            link.download = "wedding-invitations.pdf";
            link.click();
            URL.revokeObjectURL(url);
        } catch (error) {
            toast.error("Couldn't create PDF", errorMessage(error));
        } finally {
            setBusy(false);
        }
    };

    return (
        <>
            <PageHeader
                title="Invitation Studio"
                description="Select, personalise, check and generate one considered invitation per household. Generating never sends."
                breadcrumbs={[{ label: "Invitation Studio" }]}
            />
            <Workflow current={workflowStep} />
            <Notice color="brand" title="Approval boundary" className="mb-6">
                Every personalised version is shown before generation. Delivery remains a separate, reviewed action in Communications; this page never sends
                automatically.
            </Notice>

            <div className="grid grid-cols-1 gap-6 xl:grid-cols-[23rem_minmax(0,1fr)]">
                <aside className="flex flex-col gap-6">
                    <section className="rounded-xl bg-primary p-5 shadow-xs ring-1 ring-secondary ring-inset" aria-labelledby="select-households-title">
                        <div className="flex items-start justify-between gap-3">
                            <div>
                                <p className="text-xs font-semibold tracking-[.14em] text-[#783B4A] uppercase">Step 1</p>
                                <h2 id="select-households-title" className="mt-1 text-md font-semibold text-primary">
                                    Select households
                                </h2>
                                <p className="mt-1 text-sm text-tertiary">
                                    {selected.length} of {data.households.length} selected
                                </p>
                            </div>
                            <Badge size="sm" color={selected.length ? "brand" : "gray"}>
                                {selected.length || "None"}
                            </Badge>
                        </div>
                        <div className="mt-4 flex gap-2">
                            <Button
                                size="sm"
                                color="secondary"
                                onClick={() => {
                                    setSelected(data.households.map((household) => household.id));
                                    invalidatePreviews();
                                }}
                            >
                                Select all
                            </Button>
                            <Button
                                size="sm"
                                color="link-gray"
                                onClick={() => {
                                    setSelected([]);
                                    invalidatePreviews();
                                }}
                            >
                                Clear
                            </Button>
                        </div>
                        <div className="mt-4 max-h-80 space-y-3 overflow-auto pr-1">
                            {data.households.map((household) => (
                                <div key={household.id} className="flex flex-col gap-1.5">
                                    <Checkbox
                                        isSelected={selected.includes(household.id)}
                                        onChange={(on) => toggleHousehold(household.id, on)}
                                        label={household.name}
                                        hint={`${household.recipientLine} · ${household.guests.filter((guest) => guest.invited).length} invited${household.email ? " · email" : ""}${household.phone ? " · mobile" : ""}`}
                                    />
                                    {invitationStatus(household).length > 0 && (
                                        <div className="flex flex-wrap items-center gap-1.5 pl-6">
                                            {invitationStatus(household).map((status) =>
                                                status.href ? (
                                                    <a key={status.key} href={status.href} title={status.error ?? "Review and send"}>
                                                        <Badge size="sm" color={status.color}>
                                                            {status.text}
                                                        </Badge>
                                                    </a>
                                                ) : (
                                                    <Badge key={status.key} size="sm" color={status.color}>
                                                        {status.text}
                                                    </Badge>
                                                ),
                                            )}
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                        <p className="mt-4 border-t border-secondary pt-4 text-sm text-tertiary">
                            One invitation per household by default. Each invited person still answers individually on the RSVP page.
                        </p>
                    </section>

                    <section className="rounded-xl bg-primary p-5 shadow-xs ring-1 ring-secondary ring-inset" aria-labelledby="delivery-title">
                        <p className="text-xs font-semibold tracking-[.14em] text-[#783B4A] uppercase">Steps 3–5</p>
                        <h2 id="delivery-title" className="mt-1 text-md font-semibold text-primary">
                            Preview and output
                        </h2>
                        <div className="mt-4 flex flex-col gap-2">
                            <p className="text-sm font-medium text-secondary">Formats to generate</p>
                            {channels.map((channel) => (
                                <Checkbox
                                    key={channel}
                                    label={channel === "sms" ? "SMS" : channel.charAt(0).toUpperCase() + channel.slice(1)}
                                    isSelected={chosenChannels.includes(channel)}
                                    onChange={(on) => {
                                        setChosenChannels((current) => (on ? [...current, channel] : current.filter((item) => item !== channel)));
                                        invalidatePreviews();
                                    }}
                                />
                            ))}
                        </div>
                        <details className="mt-4 rounded-lg bg-secondary p-3 text-sm" open={delivery === "individual"}>
                            <summary className="cursor-pointer font-medium text-secondary">Advanced delivery</summary>
                            <div className="mt-3">
                                <Toggle
                                    label="Individual invitations"
                                    hint="Makes one version per invited person. Each link still opens the whole household RSVP."
                                    isSelected={delivery === "individual"}
                                    onChange={(on) => {
                                        setDelivery(on ? "individual" : "household");
                                        invalidatePreviews();
                                    }}
                                />
                            </div>
                        </details>
                        <Button
                            iconLeading={Eye}
                            className="mt-5 w-full"
                            onClick={() => void preview()}
                            isLoading={busy}
                            isDisabled={!selected.length || !chosenChannels.length || previewBlockers.length > 0}
                        >
                            Preview every version
                        </Button>
                    </section>
                </aside>

                <div className="flex min-w-0 flex-col gap-6">
                    <section className="rounded-xl bg-primary p-5 shadow-xs ring-1 ring-secondary ring-inset" aria-labelledby="template-title">
                        <div className="flex flex-wrap items-start justify-between gap-4">
                            <div>
                                <p className="text-xs font-semibold tracking-[.14em] text-[#783B4A] uppercase">Step 2</p>
                                <h2 id="template-title" className="mt-1 text-md font-semibold text-primary">
                                    Invitation template
                                </h2>
                                <p className="mt-1 text-sm text-tertiary">
                                    Customise the shared print and digital design. Placeholders such as {"{{couple_names}}"} remain dynamic.
                                </p>
                            </div>
                            {can("wedding.comms.edit") && (
                                <Button size="sm" onClick={() => void saveTemplate()} isLoading={savingTemplate}>
                                    Save template
                                </Button>
                            )}
                        </div>
                        <fieldset disabled={!can("wedding.comms.edit")} className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-3">
                            <Select
                                label="Artwork"
                                items={[
                                    { id: "native-botanicals", label: "Australian native botanicals" },
                                    { id: "none", label: "Minimal paper" },
                                ]}
                                value={template.artwork}
                                onChange={(value) => updateTemplate({ ...template, artwork: value as InvitationTemplateSettings["artwork"] })}
                            >
                                {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                            </Select>
                            <Select
                                label="Primary accent"
                                items={[
                                    { id: "burgundy", label: "Deep burgundy" },
                                    { id: "rust", label: "Muted clay" },
                                    { id: "eucalyptus", label: "Eucalyptus green" },
                                ]}
                                value={template.accent}
                                onChange={(value) => updateTemplate({ ...template, accent: value as InvitationTemplateSettings["accent"] })}
                            >
                                {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                            </Select>
                            <Input
                                label="Email greeting"
                                hint="Opens emails and texts, e.g. “Dear Fred & Ann”."
                                value={template.greetingPrefix}
                                onChange={(value) => updateTemplate({ ...template, greetingPrefix: value })}
                            />
                            <Input label="Eyebrow" value={template.eyebrow} onChange={(value) => updateTemplate({ ...template, eyebrow: value })} />
                            <Input
                                label="Invitation wording"
                                value={template.invitationLine}
                                onChange={(value) => updateTemplate({ ...template, invitationLine: value })}
                                className="lg:col-span-2"
                            />
                            <TextArea
                                label="Email introduction"
                                rows={3}
                                value={template.emailIntroduction}
                                onChange={(value) => updateTemplate({ ...template, emailIntroduction: value })}
                            />
                            <TextArea
                                label="Email sign-off"
                                rows={3}
                                value={template.emailSignoff}
                                onChange={(value) => updateTemplate({ ...template, emailSignoff: value })}
                                hint="Supports {{couple_names}}, {{wedding_date}}, {{wedding_location}} and {{rsvp_deadline}}."
                            />
                        </fieldset>
                    </section>

                    <section className="rounded-xl bg-primary p-5 shadow-xs ring-1 ring-secondary ring-inset" aria-labelledby="recipient-check-title">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                            <div>
                                <p className="text-xs font-semibold tracking-[.14em] text-[#783B4A] uppercase">Step 4</p>
                                <h2 id="recipient-check-title" className="mt-1 text-md font-semibold text-primary">
                                    Check recipients
                                </h2>
                                <p className="mt-1 text-sm text-tertiary">Contact details, event assignments and RSVP links are checked before generation.</p>
                            </div>
                            <Badge size="sm" color={selected.length && issues.length === 0 ? "success" : issues.length ? "warning" : "gray"}>
                                {selected.length ? (issues.length ? `${issues.length} to resolve` : "Ready") : "Awaiting selection"}
                            </Badge>
                        </div>
                        {selectedHouseholds.length === 0 ? (
                            <p className="mt-4 rounded-lg bg-secondary px-4 py-3 text-sm text-tertiary">
                                Select at least one household to run recipient checks.
                            </p>
                        ) : (
                            <ul className="mt-4 divide-y divide-secondary border-y border-secondary">
                                {selectedHouseholds.map((household) => {
                                    const householdIssues = issues.filter((issue) => issue.householdId === household.id);
                                    return (
                                        <li key={household.id} className="flex flex-col gap-2 py-4 sm:flex-row sm:items-start sm:justify-between">
                                            <div>
                                                <p className="text-sm font-semibold text-primary">{household.recipientLine}</p>
                                                <p className="mt-0.5 text-sm text-tertiary">
                                                    {household.guests.filter((guest) => guest.invited).length} invited · {household.email ?? "No email"} ·{" "}
                                                    {household.phone ?? "No mobile"}
                                                </p>
                                                {householdIssues.map((issue) => (
                                                    <p key={issue.key} className="mt-1 text-sm font-medium text-error-primary">
                                                        {issue.message}
                                                    </p>
                                                ))}
                                            </div>
                                            <span
                                                className={cx("text-xs font-semibold", householdIssues.length ? "text-error-primary" : "text-success-primary")}
                                            >
                                                {householdIssues.length ? "Needs attention" : "Ready"}
                                            </span>
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                        {issues.some((issue) => issue.householdId === null) && (
                            <p role="alert" className="border-error-primary mt-4 border-l-4 bg-error-primary px-4 py-3 text-sm font-medium text-error-primary">
                                {issues.find((issue) => issue.householdId === null)?.message} RSVP_LINK_SECRET is required; staging must also use its own
                                WEDDING_URL.
                            </p>
                        )}
                    </section>

                    <section className="flex min-w-0 flex-col gap-5" aria-labelledby="preview-title">
                        <div className="flex flex-wrap items-end justify-between gap-3">
                            <div>
                                <p className="text-xs font-semibold tracking-[.14em] text-[#783B4A] uppercase">Steps 3 &amp; 5</p>
                                <h2 id="preview-title" className="mt-1 text-md font-semibold text-primary">
                                    Preview, generate or continue
                                </h2>
                                <p className="text-sm text-tertiary">
                                    {previews.length
                                        ? `${previews.length} ${delivery === "individual" ? "individual" : "household"} invitation${previews.length === 1 ? "" : "s"}`
                                        : "Preview the personalised versions before creating any artefacts."}
                                </p>
                            </div>
                            <div className="flex flex-wrap gap-2" aria-label="Preview format">
                                {(["print", "email", "mobile"] as PreviewMode[]).map((mode) => (
                                    <Button
                                        key={mode}
                                        size="sm"
                                        color={previewMode === mode ? "primary" : "secondary"}
                                        aria-pressed={previewMode === mode}
                                        onClick={() => setPreviewMode(mode)}
                                    >
                                        {mode.charAt(0).toUpperCase() + mode.slice(1)}
                                    </Button>
                                ))}
                            </div>
                        </div>
                        {previews.length === 0 ? (
                            <Empty
                                icon={Download01}
                                title="No previews yet"
                                description="Select households and formats, then preview every recipient version."
                            />
                        ) : (
                            <>
                                <div className="grid grid-cols-1 gap-5 2xl:grid-cols-2">
                                    {previews.map((invitation) => (
                                        <article
                                            key={invitation.key}
                                            className="rounded-xl bg-primary p-4 shadow-xs ring-1 ring-secondary ring-inset sm:p-5 print:break-after-page"
                                        >
                                            <PreviewPanel invitation={invitation} mode={previewMode} template={template} />
                                            <div className="mt-4 flex justify-center gap-2">
                                                {chosenChannels.map((channel) => (
                                                    <Badge key={channel} size="sm" color="gray">
                                                        {channel}
                                                    </Badge>
                                                ))}
                                            </div>
                                            {chosenChannels.includes("sms") && (
                                                <div className="mt-3 rounded-lg bg-secondary p-4 text-left text-xs leading-5 ring-1 ring-secondary ring-inset">
                                                    <p className="mb-1 font-semibold">SMS preview</p>
                                                    {invitation.smsBody}
                                                </div>
                                            )}
                                        </article>
                                    ))}
                                </div>
                                <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-secondary bg-primary p-4 shadow-xs">
                                    <p className="text-sm text-tertiary">
                                        {issues.length
                                            ? `Resolve ${issues.length} recipient issue${issues.length === 1 ? "" : "s"} before generating.`
                                            : "Recipient checks passed. Generation still does not send."}
                                    </p>
                                    <div className="flex flex-wrap gap-2">
                                        {can("wedding.export") && (
                                            <Button color="secondary" iconLeading={Printer} onClick={() => void printPdf()} isLoading={busy}>
                                                Download printable PDF
                                            </Button>
                                        )}
                                        {can("wedding.guests.edit") && (
                                            <Button
                                                iconLeading={Link01}
                                                isDisabled={issues.length > 0}
                                                onClick={async () => {
                                                    setBusy(true);
                                                    try {
                                                        const result = await api<{ generated: number; sent: number }>(
                                                            "POST",
                                                            "/api/portal/wedding/invitations/generate",
                                                            request,
                                                        );
                                                        toast.success(`${result.generated} invitations generated`, "Nothing has been sent.");
                                                        if (prepareDrafts && digital.length && can("wedding.comms.edit")) await prepare();
                                                    } catch (error) {
                                                        toast.error("Couldn't generate invitations", errorMessage(error));
                                                    } finally {
                                                        setBusy(false);
                                                    }
                                                }}
                                                isLoading={busy}
                                            >
                                                Generate (do not send)
                                            </Button>
                                        )}
                                        <Button href="/portal/wedding/communications" color="secondary">
                                            Continue to Communications
                                        </Button>
                                    </div>
                                </div>
                                {digital.length > 0 && can("wedding.comms.edit") && (
                                    <div className="flex flex-col gap-3 rounded-xl border border-secondary bg-primary p-4 shadow-xs">
                                        <p className="text-sm font-semibold text-primary">Prepare for sending</p>
                                        <Checkbox
                                            label={`Also prepare ${digital.map((c) => (c === "sms" ? "SMS" : "email")).join(" and ")} drafts in Communications when generating`}
                                            hint="One draft per channel, addressed to exactly these households with their own RSVP links. Nothing is sent until you review it and choose Send."
                                            isSelected={prepareDrafts}
                                            onChange={setPrepareDrafts}
                                        />
                                        {digital.includes("email") && (
                                            <Checkbox
                                                label="Attach each household's printable invitation (PDF with its QR code) to the email"
                                                hint="The same PDF as Download printable PDF, one per household. Needs Fastmail (or SMTP); other providers refuse rather than send without it."
                                                isSelected={attachPdf}
                                                onChange={setAttachPdf}
                                            />
                                        )}
                                        <div>
                                            <Button
                                                color="secondary"
                                                isDisabled={issues.length > 0}
                                                onClick={() => prepare().catch((e) => toast.error("Couldn't prepare the drafts", errorMessage(e)))}
                                            >
                                                Prepare drafts now
                                            </Button>
                                        </div>
                                        {conflicts.length > 0 && (
                                            <Notice color="warning" title="These households already have unsent invitation drafts">
                                                <ul className="mt-1 flex flex-col gap-1">
                                                    {conflicts.map((c) => (
                                                        <li key={c.messageId}>
                                                            <a className="underline" href={`/portal/wedding/communications/${c.messageId}`}>
                                                                {c.channel === "sms" ? "Text" : "Email"} draft “{c.subject}”
                                                            </a>{" "}
                                                            · {c.households} household{c.households === 1 ? "" : "s"}
                                                            {c.others ? ` (${c.others} not selected here, so it can't be replaced from here)` : ""}
                                                        </li>
                                                    ))}
                                                </ul>
                                                {conflicts.every((c) => !c.others) && sentConflicts.length === 0 && (
                                                    <Button size="sm" className="mt-3" onClick={() => setPrepareConfirmation("replace")}>
                                                        Replace draft
                                                    </Button>
                                                )}
                                            </Notice>
                                        )}
                                        {sentConflicts.length > 0 && (
                                            <Notice
                                                color="warning"
                                                title={`${sentHouseholds === 1 ? "An invitation was" : "Invitations were"} already sent to ${sentHouseholds} ${sentHouseholds === 1 ? "household" : "households"}`}
                                            >
                                                <p className="mt-1">
                                                    {sentConflicts
                                                        .map((conflict) => `${conflict.channel === "sms" ? "Text" : "Email"}: ${conflict.householdIds.length}`)
                                                        .join(" · ")}{" "}
                                                    household
                                                    {sentHouseholds === 1 ? "" : "s"} already received an invitation. Preparing another keeps the same RSVP
                                                    link, guest details and delivery history. Nothing is sent yet.
                                                </p>
                                                {conflicts.some((conflict) => conflict.others > 0) ? (
                                                    <p className="mt-2 font-medium">
                                                        Open the existing draft first: it also contains a household that is not selected here, so it cannot be
                                                        replaced safely.
                                                    </p>
                                                ) : (
                                                    <Button size="sm" className="mt-3" onClick={() => setPrepareConfirmation("resend")}>
                                                        Send another invitation
                                                    </Button>
                                                )}
                                            </Notice>
                                        )}
                                        {drafts.length > 0 && (
                                            <ul className="flex flex-col gap-2">
                                                {drafts.map((draft) => (
                                                    <li
                                                        key={draft.id}
                                                        className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-secondary px-3 py-2"
                                                    >
                                                        <span className="text-sm text-secondary">
                                                            {draft.channel === "sms" ? "Text" : "Email"} draft · {draft.recipientCount} guests
                                                            {draft.options.invitation?.attachPdf ? " · PDF attached" : ""}
                                                        </span>
                                                        <Button size="sm" href={`/portal/wedding/communications/${draft.id}`}>
                                                            Review and send
                                                        </Button>
                                                    </li>
                                                ))}
                                            </ul>
                                        )}
                                    </div>
                                )}
                            </>
                        )}
                    </section>
                </div>
            </div>
            <ConfirmDialog
                isOpen={prepareConfirmation === "replace"}
                onOpenChange={(open) => !open && setPrepareConfirmation(null)}
                title="Replace the existing draft?"
                description="The unsent invitation draft will be replaced with a new draft for exactly the selected household. No guest will be contacted, and sent invitation history is not changed."
                confirmLabel="Replace draft"
                onConfirm={async () => {
                    try {
                        await prepare({ replace: true });
                    } catch (error) {
                        toast.error("Couldn't replace the draft", errorMessage(error));
                    }
                }}
            />
            <ConfirmDialog
                isOpen={prepareConfirmation === "resend"}
                onOpenChange={(open) => !open && setPrepareConfirmation(null)}
                title="Prepare another invitation?"
                description="This household was already sent an invitation. This only prepares a new draft using the same RSVP link and guest details. You must review the exact recipient and explicitly confirm again in Communications before anything is sent."
                confirmLabel="Prepare another invitation"
                onConfirm={async () => {
                    try {
                        await prepare({ replace: conflicts.length > 0, resend: true });
                    } catch (error) {
                        toast.error("Couldn't prepare another invitation", errorMessage(error));
                    }
                }}
            />
        </>
    );
};
