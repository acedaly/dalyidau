import { useState } from "react";
import { CheckCircle, Mail01, MessageChatSquare } from "@untitledui/icons";
import { BadgeWithDot } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { TextArea } from "@/components/base/textarea/textarea";
import { Notice } from "@/portal/components/notice";
import { PageHeader } from "@/portal/components/page-header";
import { useToast } from "@/portal/components/toast";
import { api, errorMessage } from "@/portal/lib/api";
import type { PageData } from "@/portal/lib/page-types";

const SecretList = ({ names }: { names: string[] }) => (
    <ul className="list-disc space-y-1 pl-5 text-sm text-tertiary">
        {names.map((name) => (
            <li key={name}>
                <code>{name}</code>
            </li>
        ))}
    </ul>
);

export const ProviderSettingsPage = ({ data }: { data: PageData<"provider-settings"> }) => {
    const toast = useToast();
    const [testEmail, setTestEmail] = useState("");
    const [testPhone, setTestPhone] = useState("");
    const [busy, setBusy] = useState<string | null>(null);
    const [testEmails, setTestEmails] = useState(data.comms.testEmails.join("\n"));
    const [testMobiles, setTestMobiles] = useState(data.comms.testMobiles.join("\n"));
    const [price, setPrice] = useState(data.comms.smsCentsPerPart === null ? "" : String(data.comms.smsCentsPerPart));
    const list = (value: string) =>
        value
            .split(/[\n,;]+/)
            .map((v) => v.trim())
            .filter(Boolean);
    const saveTesting = async () => {
        setBusy("testing");
        try {
            const result = await api<{ value: { testEmails: string[]; testMobiles: string[] } }>("PUT", "/api/portal/settings/comms", {
                testEmails: list(testEmails),
                testMobiles: list(testMobiles),
                smsCentsPerPart: price.trim() === "" ? null : Number(price),
            });
            setTestEmails(result.value.testEmails.join("\n"));
            setTestMobiles(result.value.testMobiles.join("\n"));
            toast.success("Test recipients saved", "Campaign tests can only go to these.");
        } catch (error) {
            toast.error("Couldn't save the test recipients", errorMessage(error));
        } finally {
            setBusy(null);
        }
    };
    const validate = async (channel: "email" | "sms") => {
        setBusy(`${channel}-validate`);
        try {
            const result = await api<{ detail: string }>("POST", "/api/portal/wedding/providers/validate", { channel });
            toast.success(`${channel === "email" ? "Email" : "SMS"} configuration checked`, result.detail);
        } catch (error) {
            toast.error("Validation failed", errorMessage(error));
        } finally {
            setBusy(null);
        }
    };
    const test = async (channel: "email" | "sms", to: string) => {
        setBusy(`${channel}-test`);
        try {
            await api("POST", "/api/portal/wedding/providers/test", { channel, to, confirm: "SEND TEST" });
            toast.success("Controlled test sent", "This was a test only; no guest invitation was sent.");
        } catch (error) {
            toast.error("Test failed", errorMessage(error));
        } finally {
            setBusy(null);
        }
    };
    return (
        <>
            <PageHeader
                title="Email & SMS providers"
                description="Validate delivery infrastructure, sender identity and safeguards without exposing credentials to the browser."
                breadcrumbs={[{ label: "Communications", href: "/portal/wedding/communications" }, { label: "Providers" }]}
            />
            <Notice color="brand" title="Secrets stay outside Wedding Planner">
                API tokens and app passwords are provisioned and rotated as Cloudflare Worker secrets. This page receives only provider names and validation
                outcomes; secret values never enter D1, client code, audit logs or error responses.
            </Notice>
            <section aria-labelledby="testing-heading" className="flex flex-col gap-4 rounded-xl bg-primary p-5 shadow-xs ring-1 ring-secondary ring-inset">
                <div className="flex flex-col gap-1">
                    <h2 id="testing-heading" className="text-md font-semibold text-primary">
                        Campaign test recipients
                    </h2>
                    <p className="text-sm text-tertiary">
                        The only addresses and mobiles a campaign test can be sent to. Use your own. Tests are marked as tests and never count as contacting a
                        guest.
                    </p>
                </div>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <TextArea label="Test email addresses" rows={3} value={testEmails} onChange={setTestEmails} hint="One per line, up to 10." />
                    <TextArea label="Test mobile numbers" rows={3} value={testMobiles} onChange={setTestMobiles} hint="One per line, e.g. 0412 345 678." />
                </div>
                <Input
                    label="Price of one SMS part (cents)"
                    type="number"
                    value={price}
                    onChange={setPrice}
                    hint="Optional. Used for the cost estimate in the send check, e.g. your ClickSend rate."
                    className="max-w-60"
                />
                <div>
                    <Button color="secondary" onClick={saveTesting} isLoading={busy === "testing"} showTextWhileLoading>
                        Save test recipients
                    </Button>
                </div>
            </section>
            <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
                <section className="flex flex-col gap-5 rounded-xl bg-primary p-6 shadow-xs ring-1 ring-secondary ring-inset">
                    <div className="flex items-start justify-between gap-3">
                        <div className="flex items-center gap-3">
                            <Mail01 className="size-6 text-fg-brand-primary" />
                            <div>
                                <h2 className="text-lg font-semibold text-primary">Email provider</h2>
                                <p className="text-sm text-tertiary">Fastmail JMAP preferred; authenticated TLS SMTP and SMTP2Go supported.</p>
                            </div>
                        </div>
                        <BadgeWithDot color={data.status.email ? "success" : "gray"}>{data.status.email ?? "Not configured"}</BadgeWithDot>
                    </div>
                    <dl className="grid grid-cols-[8rem_1fr] gap-2 text-sm">
                        <dt className="text-tertiary">Sender</dt>
                        <dd className="text-secondary">{data.status.emailFrom ?? "Amelia & Aidan <wedding@daly.id.au>"}</dd>
                        <dt className="text-tertiary">Sending switch</dt>
                        <dd className="text-secondary">{data.emailEnabled ? "Enabled" : "Disabled"}</dd>
                    </dl>
                    <div>
                        <p className="mb-2 text-sm font-medium text-secondary">Credential secrets</p>
                        <SecretList names={["FASTMAIL_API_TOKEN", "SMTP_PASSWORD", "SMTP2GO_API_KEY"]} />
                    </div>
                    <p className="text-sm text-tertiary">
                        Fastmail tokens must include JMAP Mail and Email Submission. Generic SMTP is restricted to authenticated TLS on ports 465 or 587.
                    </p>
                    <div className="flex flex-wrap gap-2">
                        <Button color="secondary" onClick={() => void validate("email")} isLoading={busy === "email-validate"}>
                            Validate connection
                        </Button>
                        <Button color="link-gray" href="/portal/wedding/settings/features">
                            Review sending switch
                        </Button>
                    </div>
                    <div className="flex flex-col gap-3 rounded-lg bg-secondary p-4">
                        <Input label="Controlled test recipient" type="email" value={testEmail} onChange={setTestEmail} placeholder="you@example.com" />
                        <Button
                            iconLeading={CheckCircle}
                            onClick={() => void test("email", testEmail)}
                            isLoading={busy === "email-test"}
                            isDisabled={!testEmail}
                        >
                            Send test email
                        </Button>
                    </div>
                </section>
                <section className="flex flex-col gap-5 rounded-xl bg-primary p-6 shadow-xs ring-1 ring-secondary ring-inset">
                    <div className="flex items-start justify-between gap-3">
                        <div className="flex items-center gap-3">
                            <MessageChatSquare className="size-6 text-fg-brand-primary" />
                            <div>
                                <h2 className="text-lg font-semibold text-primary">SMS provider</h2>
                                <p className="text-sm text-tertiary">ClickSend with replaceable provider boundaries.</p>
                            </div>
                        </div>
                        <BadgeWithDot color={data.status.sms ? "success" : "gray"}>{data.status.sms ?? "Not configured"}</BadgeWithDot>
                    </div>
                    <dl className="grid grid-cols-[8rem_1fr] gap-2 text-sm">
                        <dt className="text-tertiary">Approved sender</dt>
                        <dd className="text-secondary">{data.status.smsFrom ?? "Not configured"}</dd>
                        <dt className="text-tertiary">Sending switch</dt>
                        <dd className="text-secondary">{data.smsEnabled ? "Enabled" : "Disabled"}</dd>
                        <dt className="text-tertiary">Webhooks</dt>
                        <dd className="text-secondary">{data.status.webhooks ? "Validated path configured" : "Not configured"}</dd>
                    </dl>
                    <div>
                        <p className="mb-2 text-sm font-medium text-secondary">Credential secrets</p>
                        <SecretList names={["CLICKSEND_USERNAME", "CLICKSEND_API_KEY", "COMMS_WEBHOOK_SECRET"]} />
                    </div>
                    <Notice color="warning" title="Australian sender and consent checks required">
                        Keep SMS delivery off until the ClickSend account, registered sender, personalised links, inbound replies and delivery receipt webhook
                        have all been tested. Only contact guests with consent and honour STOP immediately.
                    </Notice>
                    <Button color="secondary" onClick={() => void validate("sms")} isLoading={busy === "sms-validate"}>
                        Validate account
                    </Button>
                    <div className="flex flex-col gap-3 rounded-lg bg-secondary p-4">
                        <Input label="Controlled Australian test number" type="tel" value={testPhone} onChange={setTestPhone} placeholder="+61412345678" />
                        <Button iconLeading={CheckCircle} onClick={() => void test("sms", testPhone)} isLoading={busy === "sms-test"} isDisabled={!testPhone}>
                            Send test SMS
                        </Button>
                    </div>
                </section>
            </div>
            <p className="text-sm text-tertiary">
                Provider acceptance is recorded separately from confirmed delivery. Costs, inbound replies, deduplicated webhooks and conversation history
                remain in Communications.
            </p>
        </>
    );
};
