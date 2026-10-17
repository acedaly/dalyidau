import { useCallback, useEffect, useState } from "react";
import { Clock, Download01, Eye, Printer, RefreshCcw01, Send01, Trash01, Users01 } from "@untitledui/icons";
import { BadgeWithDot } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { PreviewDialog } from "@/portal/communications/preview-dialog";
import { SendCheck, SendDialog, TestSend } from "@/portal/communications/send-check";
import { type DataColumn, DataTable } from "@/portal/components/data-table";
import { ConfirmDialog } from "@/portal/components/dialog";
import { Empty } from "@/portal/components/empty";
import { MetricCard } from "@/portal/components/metric-card";
import { Notice } from "@/portal/components/notice";
import { PageHeader } from "@/portal/components/page-header";
import { MessageStatusBadge } from "@/portal/components/status";
import { Timestamp } from "@/portal/components/timestamp";
import { useToast } from "@/portal/components/toast";
import { api, errorMessage } from "@/portal/lib/api";
import { displaySubject, formatNumber, pluralise } from "@/portal/lib/format";
import type { PageData } from "@/portal/lib/page-types";
import { usePortal } from "@/portal/portal-context";
import { CAMPAIGNS, isCampaignKind } from "@/shared/portal/campaigns";
import { MESSAGE_CATEGORY_LABELS, type Message, type MessagePreflight, type MessageRecipient } from "@/shared/portal/types";

const CATEGORY_LABELS = MESSAGE_CATEGORY_LABELS;

const RECIPIENT_STATUS: Record<MessageRecipient["status"], { label: string; color: "gray" | "success" | "error" | "warning" }> = {
    pending: { label: "Ready", color: "gray" },
    sent: { label: "Sent", color: "success" },
    failed: { label: "Failed", color: "error" },
    skipped: { label: "Skipped", color: "warning" },
};

export const MessagePage = ({ data }: { data: PageData<"message"> }) => {
    const { can, wedding } = usePortal();
    const toast = useToast();
    const [message, setMessage] = useState<Message>(data.message);
    const [confirm, setConfirm] = useState<"delete" | "retry" | null>(null);
    const [sendMode, setSendMode] = useState<"send" | "schedule" | null>(null);
    const [previewOpen, setPreviewOpen] = useState(false);
    const [preflight, setPreflight] = useState<MessagePreflight | null>(null);
    const [printing, setPrinting] = useState(false);
    const refresh = useCallback(() => {
        api<{ preflight: MessagePreflight }>("GET", `/api/portal/wedding/messages/${data.message.id}/preflight`)
            .then((r) => setPreflight(r.preflight))
            .catch((e) => toast.error("Couldn't run the send check", errorMessage(e)));
    }, [data.message.id, toast]);
    useEffect(refresh, [refresh]);
    // The households this message is addressed to, for previews, tests and printing.
    const households = [
        ...new Map(
            data.recipients
                .filter((r) => r.householdId && !r.error?.startsWith("Included in the household"))
                .map((r) => [r.householdId!, { id: r.householdId!, line: r.name }]),
        ).values(),
    ];
    const printable = isCampaignKind(message.category) && CAMPAIGNS[message.category].printable;
    const sms = message.channel === "sms";
    const reachable = data.recipients.filter((r) => (sms ? r.phone : r.email));
    const retryable = data.recipients.filter((r) => r.status === "failed" && r.attempts < 3).length;
    const cost = data.recipients.reduce((total, r) => total + (r.costCents ?? 0), 0);
    const delivered = data.recipients.filter((r) => r.deliveryStatus === "delivered").length;
    const skipped = data.recipients.filter((r) => r.status === "skipped").length;
    const isDraft = message.status === "draft";
    const isQueued = message.status === "queued";
    const isEditable = isDraft || isQueued;

    const columns: DataColumn<MessageRecipient & { id: string }>[] = [
        { id: "name", label: "Guest", isRowHeader: true, sortValue: (r) => r.name, render: (r) => <span className="font-medium text-primary">{r.name}</span> },
        sms
            ? { id: "phone", label: "Mobile", sortValue: (r) => r.phone, render: (r) => r.phone ?? <span className="text-quaternary">No mobile</span> }
            : { id: "email", label: "Email", sortValue: (r) => r.email, render: (r) => r.email ?? <span className="text-quaternary">No email</span> },
        {
            id: "status",
            label: "Status",
            sortValue: (r) => r.status,
            render: (r) => (
                <BadgeWithDot size="sm" color={RECIPIENT_STATUS[r.status].color}>
                    {RECIPIENT_STATUS[r.status].label}
                </BadgeWithDot>
            ),
        },
        {
            id: "delivery",
            label: "Delivery",
            sortValue: (r) => r.deliveryStatus,
            render: (r) =>
                r.deliveryStatus ? (
                    <span className="capitalize">{r.deliveryStatus}</span>
                ) : r.status === "sent" ? (
                    <span className="text-quaternary">Awaiting report</span>
                ) : (
                    ""
                ),
            className: "max-lg:hidden",
        },
        {
            id: "note",
            label: "Note",
            render: (r) =>
                r.error ??
                (r.sentAt ? (
                    <span>
                        <Timestamp iso={r.sentAt} />
                        {r.costCents !== null && ` · ${(r.costCents / 100).toLocaleString("en-AU", { style: "currency", currency: "AUD" })}`}
                    </span>
                ) : r.providerId ? (
                    `Provider ${r.providerId}`
                ) : (
                    ""
                )),
            className: "max-md:hidden",
        },
    ];

    return (
        <>
            <PageHeader
                title={displaySubject(message.subject, wedding)}
                description={
                    <span className="flex flex-wrap items-center gap-2">
                        <MessageStatusBadge status={message.status} />
                        <span>{sms ? "Text message" : "Email"}</span>
                        <span aria-hidden="true">·</span>
                        <span>{CATEGORY_LABELS[message.category]}</span>
                        <span>
                            Prepared by {message.createdBy}, <Timestamp iso={message.createdAt} />
                        </span>
                    </span>
                }
                breadcrumbs={[{ label: "Communications", href: "/portal/wedding/communications" }, { label: "Message" }]}
                actions={
                    <>
                        <Button color="secondary" iconLeading={Eye} onClick={() => setPreviewOpen(true)}>
                            Preview
                        </Button>
                        {printable && can("wedding.export") && households.length > 0 && (
                            <Button
                                color="secondary"
                                iconLeading={Printer}
                                isLoading={printing}
                                showTextWhileLoading
                                onClick={async () => {
                                    setPrinting(true);
                                    try {
                                        const response = await fetch("/api/portal/wedding/studio/cards.pdf", {
                                            method: "POST",
                                            headers: { "Content-Type": "application/json" },
                                            body: JSON.stringify({ kind: message.category, householdIds: households.map((h) => h.id) }),
                                        });
                                        if (!response.ok) throw new Error((await response.json().catch(() => null))?.message ?? "The cards couldn't be made");
                                        const url = URL.createObjectURL(await response.blob());
                                        const link = document.createElement("a");
                                        link.href = url;
                                        link.download = `${message.category === "thank_you" ? "thank-you" : "save-the-date"}-cards.pdf`;
                                        link.click();
                                        URL.revokeObjectURL(url);
                                    } catch (e) {
                                        toast.error("Couldn't make the printable cards", errorMessage(e));
                                    } finally {
                                        setPrinting(false);
                                    }
                                }}
                            >
                                Printable cards
                            </Button>
                        )}
                        {can("wedding.export") && reachable.length > 0 && (
                            <Button color="secondary" iconLeading={Download01} href={`/api/portal/wedding/messages/${message.id}/merge.csv`} download>
                                Mail-merge CSV
                            </Button>
                        )}
                        {isEditable && can("wedding.comms.edit") && (
                            <Button color="secondary-destructive" iconLeading={Trash01} onClick={() => setConfirm("delete")}>
                                Delete draft
                            </Button>
                        )}
                        {isQueued && can("wedding.comms.edit") && (
                            <Button
                                color="secondary"
                                onClick={async () => {
                                    const result = await api<{ message: Message }>("POST", `/api/portal/wedding/messages/${message.id}/unschedule`, {});
                                    setMessage(result.message);
                                    toast.success("Scheduled delivery cancelled");
                                }}
                            >
                                Cancel schedule
                            </Button>
                        )}
                        {(message.status === "partial" || message.status === "failed") && retryable > 0 && can("wedding.comms.send") && (
                            <Button color="secondary" iconLeading={RefreshCcw01} onClick={() => setConfirm("retry")} isDisabled={!data.deliveryAvailable}>
                                Retry {pluralise(retryable, "failed recipient")}
                            </Button>
                        )}
                        {isDraft && can("wedding.comms.send") && (
                            <Button color="secondary" iconLeading={Clock} onClick={() => setSendMode("schedule")} isDisabled={!preflight?.recipients}>
                                {preflight?.again && message.category === "invitation" ? "Schedule another invitation" : "Schedule"}
                            </Button>
                        )}
                        {isEditable && can("wedding.comms.send") && (
                            <Button iconLeading={Send01} onClick={() => setSendMode("send")} isDisabled={!data.deliveryAvailable || !preflight?.recipients}>
                                {preflight?.again && message.category === "invitation"
                                    ? isQueued
                                        ? "Send another invitation now"
                                        : "Send another invitation"
                                    : isQueued
                                      ? "Send now"
                                      : preflight
                                        ? `Send to ${pluralise(preflight.households, "household")}`
                                        : "Send"}
                            </Button>
                        )}
                    </>
                }
            />

            {isEditable && !data.deliveryAvailable && (
                <Notice color="brand" title="Ready, but not sendable from the portal yet">
                    {sms
                        ? "SMS delivery is off, so this text can't be sent from here. An owner can set up ClickSend and switch on SMS delivery (see docs/COMMUNICATIONS.md)."
                        : "Email delivery is off, so this draft can't be sent from here. Download the mail-merge CSV to send it with your own email account, or ask an owner to set up delivery (see docs/COMMUNICATIONS.md)."}
                </Notice>
            )}
            {isQueued && message.scheduledAt && (
                <Notice color="brand" title="Scheduled delivery">
                    Due <Timestamp iso={message.scheduledAt} />. The existing Worker cron checks the queue every 15 minutes; nothing is sent while{" "}
                    {sms ? "SMS" : "email"} delivery is off.
                </Notice>
            )}
            {message.deliveryNote && <Notice title="Delivery">{message.deliveryNote}</Notice>}

            {isEditable && preflight && (
                <>
                    <SendCheck
                        preflight={preflight}
                        onRefresh={refresh}
                        pdfHref={
                            message.options.invitation?.attachPdf && can("wedding.export")
                                ? (householdId, guestId) =>
                                      `/api/portal/wedding/messages/${message.id}/invitation.pdf?household=${encodeURIComponent(householdId)}&guest=${encodeURIComponent(guestId)}`
                                : undefined
                        }
                    />
                    <TestSend message={message} preflight={preflight} households={households} canSend={can("wedding.comms.send")} onSent={refresh} />
                </>
            )}

            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
                <MetricCard label="Recipients" icon={Users01} value={formatNumber(data.recipients.length)} />
                <MetricCard label={sms ? "With a mobile number" : "With an email address"} value={formatNumber(reachable.length)} />
                <MetricCard label="Skipped" value={formatNumber(skipped)} detail={skipped ? "See the note on each recipient" : undefined} />
                {sms ? (
                    <MetricCard
                        label="Cost"
                        value={cost ? (cost / 100).toLocaleString("en-AU", { style: "currency", currency: "AUD" }) : "–"}
                        detail="As reported by the provider"
                    />
                ) : (
                    <MetricCard label="Delivered" value={formatNumber(delivered)} detail="Confirmed by the provider" />
                )}
            </div>

            <section aria-labelledby="body-heading" className="flex flex-col gap-3 rounded-xl bg-primary p-5 shadow-xs ring-1 ring-secondary ring-inset">
                <h2 id="body-heading" className="text-md font-semibold text-primary">
                    Message
                </h2>
                <p className="text-md whitespace-pre-wrap text-secondary">{message.body}</p>
            </section>

            <DataTable
                title="Recipients"
                rows={data.recipients.map((r) => ({ ...r, id: r.guestId }))}
                columns={columns}
                searchText={(r) => `${r.name} ${r.email ?? ""} ${r.phone ?? ""}`}
                initialSort={{ column: "name", direction: "ascending" }}
                emptyState={<Empty icon={Users01} title="No recipients" description="No guests matched when this message was prepared." />}
            />

            <PreviewDialog
                isOpen={previewOpen}
                onOpenChange={setPreviewOpen}
                subject={message.subject}
                body={message.body}
                category={message.category}
                channel={message.channel}
                individual={!isCampaignKind(message.category) || !!message.options.individualDelivery}
                households={households}
            />
            {preflight && (
                <SendDialog
                    mode={sendMode}
                    message={message}
                    preflight={preflight}
                    onOpenChange={(open) => !open && setSendMode(null)}
                    onDone={(next) => {
                        setMessage(next);
                        window.location.reload();
                    }}
                />
            )}

            <ConfirmDialog
                isOpen={confirm === "retry"}
                onOpenChange={(o) => !o && setConfirm(null)}
                title={`Retry ${pluralise(retryable, "failed recipient")}?`}
                description="Only recipients whose delivery failed are tried again, up to three attempts each. Everyone who already received it is left alone."
                confirmLabel="Retry"
                onConfirm={async () => {
                    try {
                        const result = await api<{ message: Message }>("POST", `/api/portal/wedding/messages/${message.id}/retry`, {});
                        setMessage(result.message);
                        toast.success("Retried", result.message.deliveryNote ?? undefined);
                        window.location.reload();
                    } catch (e) {
                        toast.error("Couldn't retry", errorMessage(e));
                    }
                }}
            />
            <ConfirmDialog
                isOpen={confirm === "delete"}
                onOpenChange={(o) => !o && setConfirm(null)}
                title="Delete this draft?"
                description="The recipient list is discarded. Templates aren't affected."
                confirmLabel="Delete draft"
                destructive
                onConfirm={async () => {
                    try {
                        await api("DELETE", `/api/portal/wedding/messages/${message.id}`);
                        window.location.assign("/portal/wedding/communications");
                    } catch (e) {
                        toast.error("Couldn't delete", errorMessage(e));
                    }
                }}
            />
        </>
    );
};
