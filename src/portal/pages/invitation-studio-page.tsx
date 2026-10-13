import { useState } from "react";
import { Download01, Eye, Link01, Printer } from "@untitledui/icons";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { Checkbox } from "@/components/base/checkbox/checkbox";
import { Toggle } from "@/components/base/toggle/toggle";
import { Empty } from "@/portal/components/empty";
import { Notice } from "@/portal/components/notice";
import { PageHeader } from "@/portal/components/page-header";
import { useToast } from "@/portal/components/toast";
import { api, errorMessage } from "@/portal/lib/api";
import type { PageData } from "@/portal/lib/page-types";
import { usePortal } from "@/portal/portal-context";
import type { InvitationPreview } from "@/shared/portal/types";

export const InvitationStudioPage = ({ data }: { data: PageData<"invitation-studio"> }) => {
    const { can } = usePortal();
    const toast = useToast();
    const [selected, setSelected] = useState<string[]>([]);
    const [guestSpecific, setGuestSpecific] = useState(false);
    const [previews, setPreviews] = useState<InvitationPreview[]>([]);
    const [busy, setBusy] = useState(false);
    const channels = ["email", "sms", "print"] as const;
    const [chosenChannels, setChosenChannels] = useState<(typeof channels)[number][]>(["print"]);
    const request = { householdIds: selected, guestSpecific, channels: chosenChannels };

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
                        <p className="text-sm text-error-primary">RSVP_LINK_SECRET is required before secure invitations can be made.</p>
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
                        {previews.length > 0 && can("wedding.guests.edit") && (
                            <div className="flex flex-wrap gap-2">
                                <Button color="secondary" iconLeading={Printer} onClick={() => void printPdf()} isLoading={busy}>
                                    Download printable PDF
                                </Button>
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
                                    className="relative overflow-hidden rounded-xl bg-[#fcf9f3] p-7 text-center text-[#3c2a23] shadow-xs ring-1 ring-[#d3c8b4] ring-inset print:break-after-page"
                                >
                                    <p className="text-xs font-semibold tracking-[.22em] uppercase">Together with our families</p>
                                    <h3 className="mt-5 font-serif text-4xl">{invitation.coupleNames}</h3>
                                    <p className="mt-4 font-serif text-lg">Dear {invitation.highlightedGuest ?? invitation.householdName}</p>
                                    <p className="mt-2 text-sm">{invitation.guestNames.join(", ")}</p>
                                    <div className="mx-auto mt-5 max-w-md space-y-1 text-sm">
                                        {invitation.eventLines.map((line) => (
                                            <p key={line}>{line}</p>
                                        ))}
                                    </div>
                                    {invitation.deadline && <p className="mt-4 text-sm font-semibold">Kindly reply by {invitation.deadline}</p>}
                                    <img
                                        src={invitation.qrDataUrl}
                                        alt={`QR code for ${invitation.householdName}`}
                                        className="mx-auto mt-5 size-44 bg-white p-1"
                                    />
                                    <p className="mt-3 text-xs">
                                        {invitation.fallback} · code {invitation.rsvpCode}
                                    </p>
                                    <div className="mt-4 flex justify-center gap-2">
                                        {chosenChannels.map((channel) => (
                                            <Badge key={channel} size="sm" color="gray">
                                                {channel}
                                            </Badge>
                                        ))}
                                    </div>
                                    {chosenChannels.includes("email") && (
                                        <div className="mt-5 rounded-lg bg-white/70 p-4 text-left text-sm ring-1 ring-[#dfd5c5] ring-inset">
                                            <p className="font-semibold">Email · {invitation.emailSubject}</p>
                                            <p className="mt-2 text-xs leading-5 whitespace-pre-line">{invitation.emailBody}</p>
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
