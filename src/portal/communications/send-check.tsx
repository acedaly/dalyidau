// The send check, controlled test sends and the confirmed send or schedule for one message. The
// check is worked out by the Worker exactly as sending is, so what it shows is what will happen.
import { useState } from "react";
import { AlertTriangle, CheckCircle, Clock, Send01, Users01 } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { Checkbox } from "@/components/base/checkbox/checkbox";
import { Input } from "@/components/base/input/input";
import { Select } from "@/components/base/select/select";
import { PortalDialog } from "@/portal/components/dialog";
import { MetricCard } from "@/portal/components/metric-card";
import { Notice } from "@/portal/components/notice";
import { Timestamp } from "@/portal/components/timestamp";
import { useToast } from "@/portal/components/toast";
import { api, errorMessage } from "@/portal/lib/api";
import { formatNumber, pluralise } from "@/portal/lib/format";
import { MESSAGE_CATEGORY_LABELS, type Message, type MessagePreflight } from "@/shared/portal/types";

const money = (cents: number) => (cents / 100).toLocaleString("en-AU", { style: "currency", currency: "AUD" });

export const SendCheck = ({
    preflight,
    onRefresh,
    pdfHref,
}: {
    preflight: MessagePreflight;
    onRefresh: () => void;
    /** For invitations with the printable invitation attached: where to open one household's PDF. */
    pdfHref?: (householdId: string) => string;
}) => {
    const held = preflight.excluded.reduce((n, e) => n + e.count, 0);
    return (
        <section aria-labelledby="check-heading" className="flex flex-col gap-4 rounded-xl bg-primary p-5 shadow-xs ring-1 ring-secondary ring-inset">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex flex-col gap-1">
                    <h2 id="check-heading" className="text-md font-semibold text-primary">
                        Send check
                    </h2>
                    <p className="text-sm text-tertiary">
                        {MESSAGE_CATEGORY_LABELS[preflight.category]} by {preflight.channel === "sms" ? "text message" : "email"}. Checked again for every
                        recipient at the moment it's sent, so a reply, an opt-out or a revoked link always wins.
                    </p>
                </div>
                <Button size="sm" color="secondary" onClick={onRefresh}>
                    Check again
                </Button>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <MetricCard label="Households" icon={Users01} value={formatNumber(preflight.households)} detail="Would receive it now" />
                <MetricCard
                    label={preflight.channel === "sms" ? "Texts to send" : "Emails to send"}
                    icon={Send01}
                    value={formatNumber(preflight.recipients)}
                    detail={
                        preflight.sms
                            ? `${pluralise(preflight.sms.parts, "SMS part")}${preflight.sms.estimatedCents !== null ? ` · about ${money(preflight.sms.estimatedCents)}` : ""}`
                            : undefined
                    }
                />
                <MetricCard label="Held back" icon={AlertTriangle} value={formatNumber(held)} detail={held ? "See the reasons below" : "Nobody"} />
            </div>
            {!preflight.deliveryAvailable && (
                <Notice color="brand" title={`${preflight.channel === "sms" ? "SMS" : "Email"} delivery is off`}>
                    Nothing can be sent until an owner sets up the provider and switches it on in Wedding settings → Features. Tests to the approved test
                    recipients still work once a provider is configured.
                </Notice>
            )}
            {preflight.sms && preflight.sms.maxParts > 1 && (
                <Notice color="warning" title={`Up to ${preflight.sms.maxParts} SMS parts per text`}>
                    Each part is charged separately. Shorten the message or link to the website.
                </Notice>
            )}
            {preflight.warnings.map((warning) => (
                <Notice key={warning} color="warning" title={warning} />
            ))}
            {preflight.sending.length > 0 && (
                <div className="flex flex-col gap-2">
                    <p className="text-sm font-semibold text-secondary">
                        Will be sent to {preflight.sending.length === preflight.recipients ? "" : `(first ${preflight.sending.length})`}
                    </p>
                    <ul className="flex max-h-72 flex-col divide-y divide-secondary overflow-y-auto rounded-lg ring-1 ring-secondary">
                        {preflight.sending.map((r, index) => (
                            <li key={`${r.to}-${index}`} className="flex flex-col gap-0.5 px-3 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                                <span className="text-sm text-primary">{r.name}</span>
                                <span className="flex items-center gap-3">
                                    <span className="font-mono text-xs break-all text-tertiary">{r.to}</span>
                                    {pdfHref && r.householdId && (
                                        <Button size="sm" color="link-color" href={pdfHref(r.householdId)} target="_blank" rel="noopener">
                                            PDF
                                        </Button>
                                    )}
                                </span>
                            </li>
                        ))}
                    </ul>
                </div>
            )}
            {preflight.excluded.length > 0 && (
                <div className="flex flex-col gap-2">
                    <p className="text-sm font-semibold text-secondary">Held back, and why</p>
                    <ul className="flex flex-col divide-y divide-secondary rounded-lg ring-1 ring-secondary">
                        {preflight.excluded.map((e) => (
                            <li key={e.reason} className="flex flex-col gap-0.5 px-3 py-2.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
                                <span className="text-sm font-medium text-primary">{e.reason}</span>
                                <span className="text-sm text-tertiary">
                                    {e.count} · {e.names.join(", ")}
                                    {e.count > e.names.length ? ` and ${e.count - e.names.length} more` : ""}
                                </span>
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </section>
    );
};

const SAMPLE = "sample";

export const TestSend = ({
    message,
    preflight,
    households,
    canSend,
    onSent,
}: {
    message: Message;
    preflight: MessagePreflight;
    households: { id: string; line: string }[];
    canSend: boolean;
    onSent: () => void;
}) => {
    const toast = useToast();
    const [to, setTo] = useState<string | null>(preflight.testRecipients[0] ?? null);
    const [householdId, setHouseholdId] = useState(SAMPLE);
    const [busy, setBusy] = useState(false);
    const sms = message.channel === "sms";
    return (
        <section aria-labelledby="test-heading" className="flex flex-col gap-4 rounded-xl bg-primary p-5 shadow-xs ring-1 ring-secondary ring-inset">
            <div className="flex flex-col gap-1">
                <h2 id="test-heading" className="text-md font-semibold text-primary">
                    Send a test
                </h2>
                <p className="text-sm text-tertiary">
                    Goes only to an approved test {sms ? "mobile" : "address"}, marked as a test. It doesn't count as contacting anyone, change any RSVP or
                    appear in delivery history.
                </p>
            </div>
            {preflight.testRecipients.length === 0 ? (
                <Notice color="brand" title="No test recipients yet">
                    An owner or admin can add your own {sms ? "mobile numbers" : "email addresses"} in Communications → Email &amp; SMS settings.
                </Notice>
            ) : (
                <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                    <Select
                        label="Send the test to"
                        className="sm:max-w-72"
                        items={preflight.testRecipients.map((r) => ({ id: r, label: r }))}
                        value={to}
                        onChange={(v) => setTo(String(v))}
                    >
                        {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                    </Select>
                    <Select
                        label="Using the details of"
                        className="sm:max-w-72"
                        items={[{ id: SAMPLE, label: "Fictional sample household" }, ...households.map((h) => ({ id: h.id, label: h.line }))]}
                        value={householdId}
                        onChange={(v) => setHouseholdId(String(v))}
                    >
                        {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                    </Select>
                    <Button
                        color="secondary"
                        isLoading={busy}
                        showTextWhileLoading
                        isDisabled={!canSend || !to}
                        onClick={async () => {
                            setBusy(true);
                            try {
                                await api("POST", `/api/portal/wedding/messages/${message.id}/test`, {
                                    to,
                                    householdId: householdId === SAMPLE ? null : householdId,
                                });
                                toast.success("Test sent", `Only ${to} received it.`);
                                onSent();
                            } catch (e) {
                                toast.error("Couldn't send the test", errorMessage(e));
                            } finally {
                                setBusy(false);
                            }
                        }}
                    >
                        Send test
                    </Button>
                </div>
            )}
            {!canSend && <p className="text-xs text-tertiary">Owners and admins can send tests.</p>}
            {preflight.tests.length > 0 && (
                <ul className="flex flex-col gap-1 text-sm text-tertiary">
                    {preflight.tests.map((t) => (
                        <li key={`${t.at}-${t.recipient}`} className="flex items-center gap-2">
                            {t.status === "sent" ? (
                                <CheckCircle className="size-4 text-fg-success-secondary" aria-hidden="true" />
                            ) : (
                                <AlertTriangle className="size-4 text-fg-error-secondary" aria-hidden="true" />
                            )}
                            <span>
                                {t.status === "sent" ? "Test sent" : "Test failed"} to {t.recipient} by {t.by}, <Timestamp iso={t.at} relative />
                                {t.error ? ` · ${t.error}` : ""}
                            </span>
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
};

/** Confirms sending or scheduling the exact number of recipients the send check shows. */
export const SendDialog = ({
    mode,
    message,
    preflight,
    onOpenChange,
    onDone,
}: {
    mode: "send" | "schedule" | null;
    message: Message;
    preflight: MessagePreflight;
    onOpenChange: (open: boolean) => void;
    onDone: (message: Message) => void;
}) => {
    const toast = useToast();
    const [checked, setChecked] = useState(false);
    const [when, setWhen] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const bulk = preflight.recipients > 1;
    const noun = message.channel === "sms" ? "text" : "email";
    const confirm = async () => {
        setBusy(true);
        setError(null);
        try {
            const result =
                mode === "schedule"
                    ? await api<{ message: Message }>("POST", `/api/portal/wedding/messages/${message.id}/schedule`, {
                          scheduledAt: new Date(when).toISOString(),
                          confirmCount: preflight.recipients,
                      })
                    : await api<{ message: Message }>("POST", `/api/portal/wedding/messages/${message.id}/send`, { confirmCount: preflight.recipients });
            toast.success(mode === "schedule" ? "Scheduled" : "Sent", result.message.deliveryNote ?? undefined);
            onDone(result.message);
            onOpenChange(false);
        } catch (e) {
            setError(errorMessage(e));
        } finally {
            setBusy(false);
        }
    };
    return (
        <PortalDialog
            isOpen={mode !== null}
            onOpenChange={(open) => {
                if (busy) return;
                if (!open) setChecked(false);
                onOpenChange(open);
            }}
            title={
                mode === "schedule"
                    ? `Schedule ${pluralise(preflight.recipients, noun)}?`
                    : `Send ${pluralise(preflight.recipients, noun)} to ${pluralise(preflight.households, "household")}?`
            }
            description={
                mode === "schedule"
                    ? "It's checked again when it's sent: anyone who replies, opts out or loses their link in the meantime is held back."
                    : "Each household receives its own personalised copy. This can't be undone."
            }
            icon={mode === "schedule" ? Clock : Send01}
            iconColor="warning"
            size="sm"
            footer={
                <>
                    <Button color="secondary" size="lg" onClick={() => onOpenChange(false)} isDisabled={busy}>
                        Cancel
                    </Button>
                    <Button size="lg" isLoading={busy} showTextWhileLoading isDisabled={(bulk && !checked) || (mode === "schedule" && !when)} onClick={confirm}>
                        {mode === "schedule" ? "Schedule" : `Send ${pluralise(preflight.recipients, noun)}`}
                    </Button>
                </>
            }
        >
            {error && (
                <Notice color="error" title="Not sent">
                    {error}
                </Notice>
            )}
            {mode === "schedule" && (
                <Input
                    label="Send after"
                    type="datetime-local"
                    isRequired
                    value={when}
                    onChange={setWhen}
                    hint="Uses the time zone on this device. The queue is checked every 15 minutes."
                />
            )}
            {preflight.excluded.length > 0 && (
                <p className="text-sm text-tertiary">
                    {pluralise(
                        preflight.excluded.reduce((n, e) => n + e.count, 0),
                        "recipient",
                    )}{" "}
                    held back, as listed in the send check.
                </p>
            )}
            {bulk && <Checkbox label="I've previewed it, sent a test and checked who it goes to" isSelected={checked} onChange={setChecked} />}
        </PortalDialog>
    );
};
