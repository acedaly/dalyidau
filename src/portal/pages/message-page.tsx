import { useState } from "react";
import { Download01, Eye, RefreshCcw01, Send01, Trash01, Users01 } from "@untitledui/icons";
import { BadgeWithDot } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { PreviewDialog } from "@/portal/communications/preview-dialog";
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
import { formatNumber, pluralise } from "@/portal/lib/format";
import type { PageData } from "@/portal/lib/page-types";
import { usePortal } from "@/portal/portal-context";
import { MESSAGE_CATEGORY_LABELS, type Message, type MessageRecipient } from "@/shared/portal/types";

const CATEGORY_LABELS = MESSAGE_CATEGORY_LABELS;

const RECIPIENT_STATUS: Record<MessageRecipient["status"], { label: string; color: "gray" | "success" | "error" | "warning" }> = {
    pending: { label: "Ready", color: "gray" },
    sent: { label: "Sent", color: "success" },
    failed: { label: "Failed", color: "error" },
    skipped: { label: "Skipped", color: "warning" },
};

export const MessagePage = ({ data }: { data: PageData<"message"> }) => {
    const { can } = usePortal();
    const toast = useToast();
    const [message, setMessage] = useState<Message>(data.message);
    const [confirm, setConfirm] = useState<"send" | "delete" | "retry" | null>(null);
    const [previewOpen, setPreviewOpen] = useState(false);
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
                title={message.subject}
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
                        {isEditable && can("wedding.comms.send") && (
                            <Button iconLeading={Send01} onClick={() => setConfirm("send")} isDisabled={!data.deliveryAvailable || reachable.length === 0}>
                                {isQueued ? "Send now" : `Send to ${pluralise(reachable.length, "guest")}`}
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
                guests={data.recipients.slice(0, 50).map((r) => ({ id: r.guestId, name: r.name, email: r.email }))}
            />

            <ConfirmDialog
                isOpen={confirm === "send"}
                onOpenChange={(o) => !o && setConfirm(null)}
                title={`Send to ${pluralise(reachable.length, "guest")}?`}
                description="Each guest receives their own personalised copy. This can't be undone."
                confirmLabel="Send now"
                onConfirm={async () => {
                    try {
                        const result = await api<{ message: Message }>("POST", `/api/portal/wedding/messages/${message.id}/send`, {});
                        setMessage(result.message);
                        toast.success("Message sent", result.message.deliveryNote ?? undefined);
                        window.location.reload();
                    } catch (e) {
                        toast.error("Couldn't send", errorMessage(e));
                    }
                }}
            />
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
