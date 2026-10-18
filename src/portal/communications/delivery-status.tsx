// Shows, per channel, whether a provider is configured and whether its switch is on. Both are
// needed before anything is sent. Never shows credentials: only provider names and sender details.
import { Mail01, MessageChatSquare } from "@untitledui/icons";
import { BadgeWithDot } from "@/components/base/badges/badges";
import type { CommsStatus } from "@/shared/portal/types";

const Row = ({
    icon: Icon,
    label,
    provider,
    from,
    on,
    flagLabel,
}: {
    icon: typeof Mail01;
    label: string;
    provider: string | null;
    from: string | null;
    on: boolean;
    flagLabel: string;
}) => (
    <div className="flex items-start gap-3">
        <Icon className="mt-0.5 size-5 shrink-0 text-fg-quaternary" aria-hidden="true" />
        <div className="flex min-w-0 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-semibold text-secondary">{label}</p>
                <BadgeWithDot size="sm" type="pill-color" color={on ? "success" : provider ? "warning" : "gray"}>
                    {on ? "Can send" : provider ? `Switched off` : "Not set up"}
                </BadgeWithDot>
            </div>
            <p className="text-sm text-tertiary">
                {provider ? (
                    <>
                        Provider: <span className="font-medium text-secondary">{provider}</span>
                        {from && <> · From {from}</>}
                        {!on && <> · Turn on “{flagLabel}” in Portal settings → Features when you're ready.</>}
                    </>
                ) : (
                    "No provider is configured on the Worker, so nothing can be sent. See docs/COMMUNICATIONS.md."
                )}
            </p>
        </div>
    </div>
);

export const DeliveryStatus = ({ status, email, sms }: { status: CommsStatus; email: boolean; sms: boolean }) => (
    <section
        aria-label="Delivery status"
        className="grid grid-cols-1 gap-4 rounded-xl bg-primary p-5 shadow-xs ring-1 ring-secondary ring-inset md:grid-cols-2"
    >
        <Row icon={Mail01} label="Email" provider={status.email} from={status.emailFrom} on={email} flagLabel="Email delivery" />
        <Row icon={MessageChatSquare} label="Text messages" provider={status.sms} from={status.smsFrom} on={sms} flagLabel="SMS delivery" />
    </section>
);
