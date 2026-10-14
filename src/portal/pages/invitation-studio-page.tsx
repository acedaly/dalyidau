import { useMemo, useState } from "react";
import { Download01, Eye, Link01, Printer } from "@untitledui/icons";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { Checkbox } from "@/components/base/checkbox/checkbox";
import { Input } from "@/components/base/input/input";
import { Select } from "@/components/base/select/select";
import { TextArea } from "@/components/base/textarea/textarea";
import { Toggle } from "@/components/base/toggle/toggle";
import { Empty } from "@/portal/components/empty";
import { Notice } from "@/portal/components/notice";
import { PageHeader } from "@/portal/components/page-header";
import { useToast } from "@/portal/components/toast";
import { api, errorMessage } from "@/portal/lib/api";
import type { PageData } from "@/portal/lib/page-types";
import { usePortal } from "@/portal/portal-context";
import type { InvitationDelivery, InvitationPreview, InvitationStudioHousehold, InvitationTemplateSettings } from "@/shared/portal/types";
import { cx } from "@/utils/cx";

const ACCENTS: Record<InvitationTemplateSettings["accent"], string> = {
    burgundy: "#783B4A",
    rust: "#9C765C",
    eucalyptus: "#667463",
};

type Channel = "email" | "sms" | "print";
type PreviewMode = "print" | "email" | "mobile";
type RecipientIssue = { key: string; householdId: string | null; message: string; kind: "contact" | "assignment" | "link" };

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
                <div aria-hidden="true" className="absolute inset-x-[14%] top-[5%] h-[58%] rounded-[50%] bg-[#F5F0E7]/70 blur-2xl" />
                {invitation.sample && (
                    <p className="absolute top-2 z-10 rounded-full bg-[#F5F0E7]/95 px-3 py-1 text-[9px] font-bold tracking-[.12em] uppercase" style={{ color: accent }}>
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
                        {invitation.namesLine && <p className="mt-1.5 text-[10px] leading-snug text-[#4f614d] text-balance">{invitation.namesLine}</p>}
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
                                    <br />Code {invitation.rsvpCode}
                                </p>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

const PreviewPanel = ({ invitation, mode }: { invitation: InvitationPreview; mode: PreviewMode }) => {
    if (mode === "email")
        return (
            <div className="mx-auto max-w-[34rem] overflow-hidden rounded-xl border border-secondary bg-secondary">
                <div className="border-b border-secondary bg-primary px-4 py-3 text-left">
                    <p className="text-xs text-tertiary">To: {invitation.greeting.replace(/^Dear\s+/i, "")}</p>
                    <p className="mt-1 text-sm font-semibold text-primary">{invitation.emailSubject}</p>
                </div>
                <div className="p-3 sm:p-5">
                    <InvitationCard invitation={invitation} label="Email invitation preview" compact />
                </div>
            </div>
        );
    if (mode === "mobile")
        return (
            <div className="mx-auto max-w-[23rem] rounded-[2rem] bg-[#2f2926] p-2 shadow-xl">
                <div className="overflow-hidden rounded-[1.55rem] bg-[#F5F0E7]">
                    <div className="flex items-center justify-center border-b border-[#d8cdbc] py-2">
                        <span className="h-1.5 w-16 rounded-full bg-[#49342D]/30" />
                    </div>
                    <div className="p-2.5">
                        <InvitationCard invitation={invitation} label="Mobile invitation preview" compact />
                    </div>
                </div>
            </div>
        );
    return <InvitationCard invitation={invitation} label="Print invitation preview" />;
};

const recipientIssuesFor = (household: InvitationStudioHousehold, channels: Channel[]): RecipientIssue[] => {
    const issues: RecipientIssue[] = [];
    if (!household.guests.some((guest) => guest.invited))
        issues.push({ key: `${household.id}-assignment`, householdId: household.id, kind: "assignment", message: "No guest is assigned to an RSVP-enabled event." });
    if (household.inviteRevoked)
        issues.push({ key: `${household.id}-revoked`, householdId: household.id, kind: "link", message: "The household RSVP link has been revoked." });
    if (channels.includes("email") && !household.email)
        issues.push({ key: `${household.id}-email`, householdId: household.id, kind: "contact", message: "Email is selected, but no email address is recorded." });
    if (channels.includes("sms") && !household.phone)
        issues.push({ key: `${household.id}-sms`, householdId: household.id, kind: "contact", message: "SMS is selected, but no mobile number is recorded." });
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
    const request = { householdIds: selected, delivery, channels: chosenChannels };
    const selectedHouseholds = useMemo(() => data.households.filter((household) => selected.includes(household.id)), [data.households, selected]);
    const issues = useMemo(() => {
        const found = selectedHouseholds.flatMap((household) => recipientIssuesFor(household, chosenChannels));
        if (!data.canGenerateLinks)
            found.unshift({ key: "link-configuration", householdId: null, kind: "link", message: "Secure RSVP links are not configured for this environment." });
        return found;
    }, [chosenChannels, data.canGenerateLinks, selectedHouseholds]);
    const previewBlockers = issues.filter((issue) => issue.kind !== "contact");
    const workflowStep = previews.length ? (issues.length ? 3 : 4) : selected.length ? 2 : 0;

    const invalidatePreviews = () => setPreviews([]);
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
                                <Checkbox
                                    key={household.id}
                                    isSelected={selected.includes(household.id)}
                                    onChange={(on) => toggleHousehold(household.id, on)}
                                    label={household.name}
                                    hint={`${household.recipientLine} · ${household.guests.filter((guest) => guest.invited).length} invited${household.email ? " · email" : ""}${household.phone ? " · mobile" : ""}`}
                                />
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
                            <p className="mt-4 rounded-lg bg-secondary px-4 py-3 text-sm text-tertiary">Select at least one household to run recipient checks.</p>
                        ) : (
                            <ul className="mt-4 divide-y divide-secondary border-y border-secondary">
                                {selectedHouseholds.map((household) => {
                                    const householdIssues = issues.filter((issue) => issue.householdId === household.id);
                                    return (
                                        <li key={household.id} className="flex flex-col gap-2 py-4 sm:flex-row sm:items-start sm:justify-between">
                                            <div>
                                                <p className="text-sm font-semibold text-primary">{household.recipientLine}</p>
                                                <p className="mt-0.5 text-sm text-tertiary">
                                                    {household.guests.filter((guest) => guest.invited).length} invited · {household.email ?? "No email"} · {household.phone ?? "No mobile"}
                                                </p>
                                                {householdIssues.map((issue) => (
                                                    <p key={issue.key} className="mt-1 text-sm font-medium text-error-primary">
                                                        {issue.message}
                                                    </p>
                                                ))}
                                            </div>
                                            <span className={cx("text-xs font-semibold", householdIssues.length ? "text-error-primary" : "text-success-primary")}>
                                                {householdIssues.length ? "Needs attention" : "Ready"}
                                            </span>
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                        {issues.some((issue) => issue.householdId === null) && (
                            <p role="alert" className="mt-4 border-l-4 border-error-primary bg-error-primary px-4 py-3 text-sm font-medium text-error-primary">
                                {issues.find((issue) => issue.householdId === null)?.message} RSVP_LINK_SECRET is required; staging must also use its own WEDDING_URL.
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
                            <Empty icon={Download01} title="No previews yet" description="Select households and formats, then preview every recipient version." />
                        ) : (
                            <>
                                <div className="grid grid-cols-1 gap-5 2xl:grid-cols-2">
                                    {previews.map((invitation) => (
                                        <article key={invitation.key} className="rounded-xl bg-primary p-4 shadow-xs ring-1 ring-secondary ring-inset print:break-after-page sm:p-5">
                                            <PreviewPanel invitation={invitation} mode={previewMode} />
                                            <div className="mt-4 flex justify-center gap-2">
                                                {chosenChannels.map((channel) => (
                                                    <Badge key={channel} size="sm" color="gray">
                                                        {channel}
                                                    </Badge>
                                                ))}
                                            </div>
                                            {previewMode === "email" && (
                                                <details className="mt-4 rounded-lg bg-secondary p-4 text-left text-sm">
                                                    <summary className="cursor-pointer font-semibold">Plain-text email fallback</summary>
                                                    <p className="mt-2 text-xs leading-5 whitespace-pre-line">{invitation.emailBody}</p>
                                                </details>
                                            )}
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
                                        {issues.length ? `Resolve ${issues.length} recipient issue${issues.length === 1 ? "" : "s"} before generating.` : "Recipient checks passed. Generation still does not send."}
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
                                                        const result = await api<{ generated: number; sent: number }>("POST", "/api/portal/wedding/invitations/generate", request);
                                                        toast.success(`${result.generated} invitations generated`, `${result.sent} sent. Review delivery in Communications.`);
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
                            </>
                        )}
                    </section>
                </div>
            </div>
        </>
    );
};
