import { useState } from "react";
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
import type { InvitationPreview, InvitationTemplateSettings } from "@/shared/portal/types";

const ACCENTS: Record<InvitationTemplateSettings["accent"], string> = {
    burgundy: "#8b2f3d",
    rust: "#c46b3c",
    eucalyptus: "#526f54",
};

const InvitationCard = ({ invitation, label }: { invitation: InvitationPreview; label: string }) => (
    <div>
        <p className="mb-2 text-xs font-semibold tracking-[.12em] text-tertiary uppercase">{label}</p>
        <div
            className="wedding-theme relative mx-auto flex aspect-[148/210] w-full max-w-[30rem] flex-col items-center overflow-hidden bg-[#f7f2ea] bg-cover bg-center px-[12%] py-[8%] text-center text-[#3c2a23] shadow-sm ring-1 ring-[#d8cdbc] ring-inset"
            style={{
                backgroundImage: invitation.artwork === "native-botanicals" ? "url('/wedding/native-invitation-frame.jpg')" : undefined,
            }}
        >
            {invitation.sample && (
                <p
                    className="absolute top-2 rounded-full bg-[#f7f2ea]/95 px-3 py-1 text-[9px] font-bold tracking-[.12em] uppercase"
                    style={{ color: ACCENTS[invitation.accent] }}
                >
                    Sample preview - not for delivery
                </p>
            )}
            <p className="mt-[4%] text-[10px] font-semibold tracking-[.22em] uppercase">{invitation.eyebrow}</p>
            <h3 className="wedding-names mt-[7%] text-5xl sm:text-6xl" style={{ color: ACCENTS[invitation.accent] }}>
                {invitation.coupleNames}
            </h3>
            <div className="mt-5 h-px w-16 bg-[#c89a34]" />
            <p className="mt-4 font-serif text-lg italic">{invitation.invitationLine}</p>
            <p className="mt-5 font-serif text-lg font-semibold">{invitation.greeting}</p>
            <p className="mt-1 text-xs text-[#5d6a56]">{invitation.guestNames.join(" · ")}</p>
            <p className="mt-7 font-serif text-lg font-semibold tracking-wide uppercase">{invitation.weddingDate}</p>
            <p className="mt-1 font-serif text-base italic" style={{ color: ACCENTS[invitation.accent] }}>
                {invitation.location}
            </p>
            <div className="mt-4 space-y-1 text-xs">
                {invitation.eventLines.map((line) => (
                    <p key={line}>{line}</p>
                ))}
            </div>
            {invitation.deadline && (
                <p className="mt-4 text-xs font-semibold" style={{ color: ACCENTS[invitation.accent] }}>
                    Kindly reply by {invitation.deadline}
                </p>
            )}
            <div className="mt-auto bg-white p-1.5 shadow-xs">
                <img src={invitation.qrDataUrl} alt={`QR code for ${invitation.householdName}`} className="size-28 sm:size-32" />
            </div>
            <p className="mt-2 text-[10px] font-semibold tracking-[.14em] uppercase" style={{ color: ACCENTS[invitation.accent] }}>
                Scan to RSVP
            </p>
            {invitation.rsvpCode && (
                <p className="mt-1 rounded bg-[#f7f2ea]/90 px-2 py-1 text-[10px]">
                    {invitation.fallback} · code {invitation.rsvpCode}
                </p>
            )}
        </div>
    </div>
);

export const InvitationStudioPage = ({ data }: { data: PageData<"invitation-studio"> }) => {
    const { can } = usePortal();
    const toast = useToast();
    const [selected, setSelected] = useState<string[]>([]);
    const [guestSpecific, setGuestSpecific] = useState(false);
    const [previews, setPreviews] = useState<InvitationPreview[]>([]);
    const [busy, setBusy] = useState(false);
    const channels = ["email", "sms", "print"] as const;
    const [chosenChannels, setChosenChannels] = useState<(typeof channels)[number][]>(["print"]);
    const [template, setTemplate] = useState(data.template);
    const [savingTemplate, setSavingTemplate] = useState(false);
    const request = { householdIds: selected, guestSpecific, channels: chosenChannels };

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
                description="Design and approve household invitations across email, SMS and print. Generating never sends."
                breadcrumbs={[{ label: "Invitation Studio" }]}
            />
            <Notice color="brand" title="Approval boundary">
                Every personalised version is shown before generation. Delivery remains a separate action in Communications; this page never sends
                automatically.
            </Notice>

            <section className="mb-6 rounded-xl bg-primary p-5 shadow-xs ring-1 ring-secondary ring-inset">
                <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                        <h2 className="text-md font-semibold text-primary">Invitation template</h2>
                        <p className="mt-1 text-sm text-tertiary">
                            Shared by printable invitations and email previews. Placeholders such as {"{{couple_names}}"} remain dynamic.
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
                        onChange={(value) => setTemplate({ ...template, artwork: value as InvitationTemplateSettings["artwork"] })}
                    >
                        {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                    </Select>
                    <Select
                        label="Primary accent"
                        items={[
                            { id: "burgundy", label: "Waratah burgundy" },
                            { id: "rust", label: "Banksia rust" },
                            { id: "eucalyptus", label: "Eucalyptus green" },
                        ]}
                        value={template.accent}
                        onChange={(value) => setTemplate({ ...template, accent: value as InvitationTemplateSettings["accent"] })}
                    >
                        {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                    </Select>
                    <Input label="Greeting prefix" value={template.greetingPrefix} onChange={(value) => setTemplate({ ...template, greetingPrefix: value })} />
                    <Input label="Eyebrow" value={template.eyebrow} onChange={(value) => setTemplate({ ...template, eyebrow: value })} />
                    <Input
                        label="Invitation wording"
                        value={template.invitationLine}
                        onChange={(value) => setTemplate({ ...template, invitationLine: value })}
                        className="lg:col-span-2"
                    />
                    <TextArea
                        label="Email introduction"
                        rows={3}
                        value={template.emailIntroduction}
                        onChange={(value) => setTemplate({ ...template, emailIntroduction: value })}
                    />
                    <TextArea
                        label="Email sign-off"
                        rows={3}
                        value={template.emailSignoff}
                        onChange={(value) => setTemplate({ ...template, emailSignoff: value })}
                        hint="Supports {{couple_names}}, {{wedding_date}}, {{wedding_location}} and {{rsvp_deadline}}."
                    />
                </fieldset>
            </section>

            <div className="grid grid-cols-1 gap-6 xl:grid-cols-[22rem_1fr]">
                <aside className="flex flex-col gap-5 rounded-xl bg-primary p-5 shadow-xs ring-1 ring-secondary ring-inset">
                    <div>
                        <h2 className="text-md font-semibold text-primary">1. Choose households</h2>
                        <p className="mt-1 text-sm text-tertiary">
                            {selected.length} of {data.households.length} selected
                        </p>
                    </div>
                    <div className="flex gap-2">
                        <Button size="sm" color="secondary" onClick={() => setSelected(data.households.map((household) => household.id))}>
                            Select all
                        </Button>
                        <Button size="sm" color="link-gray" onClick={() => setSelected([])}>
                            Clear
                        </Button>
                    </div>
                    <div className="max-h-80 space-y-3 overflow-auto pr-1">
                        {data.households.map((household) => (
                            <Checkbox
                                key={household.id}
                                isSelected={selected.includes(household.id)}
                                onChange={(on) => setSelected((ids) => (on ? [...ids, household.id] : ids.filter((id) => id !== household.id)))}
                                label={household.name}
                                hint={`${household.guests.length} guest${household.guests.length === 1 ? "" : "s"}${household.email ? " · email" : ""}${household.phone ? " · mobile" : ""}${household.delivery.length ? ` · ${household.delivery.map((item) => `${item.channel}: ${item.status}`).join(", ")}` : " · not generated"}`}
                            />
                        ))}
                    </div>
                    <Toggle
                        label="Guest-specific QR entry points"
                        hint="Each QR still opens the household RSVP and only highlights that guest."
                        isSelected={guestSpecific}
                        onChange={setGuestSpecific}
                    />
                    <div className="flex flex-col gap-2">
                        <p className="text-sm font-medium text-secondary">Formats to generate</p>
                        {channels.map((channel) => (
                            <Checkbox
                                key={channel}
                                label={channel === "sms" ? "SMS" : channel.charAt(0).toUpperCase() + channel.slice(1)}
                                isSelected={chosenChannels.includes(channel)}
                                onChange={(on) => setChosenChannels((current) => (on ? [...current, channel] : current.filter((item) => item !== channel)))}
                            />
                        ))}
                    </div>
                    <Button
                        iconLeading={Eye}
                        onClick={() => void preview()}
                        isLoading={busy}
                        isDisabled={!selected.length || !chosenChannels.length || !data.canGenerateLinks}
                    >
                        Preview every version
                    </Button>
                    {!data.canGenerateLinks && (
                        <p className="text-sm text-error-primary">
                            RSVP_LINK_SECRET is required before secure invitations can be made (on staging, WEDDING_URL must also point at staging).
                        </p>
                    )}
                </aside>

                <section className="flex min-w-0 flex-col gap-5" aria-label="Invitation previews">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                            <h2 className="text-md font-semibold text-primary">2. Review and generate</h2>
                            <p className="text-sm text-tertiary">
                                {previews.length ? `${previews.length} personalised versions` : "Preview selections to continue."}
                            </p>
                        </div>
                        {previews.length > 0 && (can("wedding.guests.edit") || can("wedding.export")) && (
                            <div className="flex flex-wrap gap-2">
                                {/* The PDF endpoint needs the export permission, which editors don't have. */}
                                {can("wedding.export") && (
                                    <Button color="secondary" iconLeading={Printer} onClick={() => void printPdf()} isLoading={busy}>
                                        Download printable PDF
                                    </Button>
                                )}
                                {can("wedding.guests.edit") && (
                                    <Button
                                        iconLeading={Link01}
                                        onClick={async () => {
                                            setBusy(true);
                                            try {
                                                const result = await api<{ generated: number; sent: number }>(
                                                    "POST",
                                                    "/api/portal/wedding/invitations/generate",
                                                    request,
                                                );
                                                toast.success(
                                                    `${result.generated} invitations generated`,
                                                    `${result.sent} sent. Review delivery in Communications.`,
                                                );
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
                            </div>
                        )}
                    </div>
                    {previews.length === 0 ? (
                        <Empty
                            icon={Download01}
                            title="No previews yet"
                            description="Choose households and formats, then preview each recipient's invitation."
                        />
                    ) : (
                        <div className="grid grid-cols-1 gap-5 2xl:grid-cols-2">
                            {previews.map((invitation) => (
                                <article
                                    key={invitation.key}
                                    className="rounded-xl bg-primary p-5 shadow-xs ring-1 ring-secondary ring-inset print:break-after-page"
                                >
                                    {chosenChannels.includes("print") && <InvitationCard invitation={invitation} label="Print invitation preview" />}
                                    {!chosenChannels.includes("print") && !chosenChannels.includes("email") && (
                                        <p className="text-sm text-tertiary">This selection contains an SMS invitation only.</p>
                                    )}
                                    <div className="mt-4 flex justify-center gap-2">
                                        {chosenChannels.map((channel) => (
                                            <Badge key={channel} size="sm" color="gray">
                                                {channel}
                                            </Badge>
                                        ))}
                                    </div>
                                    {chosenChannels.includes("email") && (
                                        <div className="mt-6 border-t border-secondary pt-5">
                                            <InvitationCard invitation={invitation} label={`Email invitation · ${invitation.emailSubject}`} />
                                            <details className="mt-4 rounded-lg bg-secondary p-4 text-left text-sm">
                                                <summary className="cursor-pointer font-semibold">Plain-text email fallback</summary>
                                                <p className="mt-2 text-xs leading-5 whitespace-pre-line">{invitation.emailBody}</p>
                                            </details>
                                        </div>
                                    )}
                                    {chosenChannels.includes("sms") && (
                                        <div className="mt-3 rounded-lg bg-white/70 p-4 text-left text-xs leading-5 ring-1 ring-[#dfd5c5] ring-inset">
                                            <p className="mb-1 font-semibold">SMS preview</p>
                                            {invitation.smsBody}
                                        </div>
                                    )}
                                </article>
                            ))}
                        </div>
                    )}
                </section>
            </div>
        </>
    );
};
