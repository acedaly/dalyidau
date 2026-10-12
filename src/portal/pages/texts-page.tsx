// SMS conversations: every text sent to or received from a guest, grouped by mobile number, with
// manual replies. Replying uses the same safeguards as campaigns (SMS switch + provider), and
// numbers that replied STOP can't be texted again.
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, MessageChatSquare, Send01 } from "@untitledui/icons";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { TextArea } from "@/components/base/textarea/textarea";
import { DeliveryStatus } from "@/portal/communications/delivery-status";
import { Empty, Skeleton } from "@/portal/components/empty";
import { Notice } from "@/portal/components/notice";
import { PageHeader } from "@/portal/components/page-header";
import { Timestamp } from "@/portal/components/timestamp";
import { useToast } from "@/portal/components/toast";
import { api, errorMessage } from "@/portal/lib/api";
import type { PageData } from "@/portal/lib/page-types";
import { usePortal } from "@/portal/portal-context";
import { smsSegments } from "@/shared/portal/sms";
import type { SmsMessage, SmsThread } from "@/shared/portal/types";
import { cx } from "@/utils/cx";

type Conversation = { phone: string; messages: SmsMessage[]; guests: SmsThread["guests"]; optedOut: boolean };

const threadName = (thread: Pick<SmsThread, "guests" | "phone">) => (thread.guests.length ? thread.guests.map((g) => g.name).join(", ") : "Unknown number");

const STATUS_LABEL: Partial<Record<SmsMessage["status"], string>> = { pending: "Sending", sent: "Sent", delivered: "Delivered", failed: "Not delivered" };

export const TextsPage = ({ data }: { data: PageData<"texts"> }) => {
    const { can } = usePortal();
    const toast = useToast();
    const [threads, setThreads] = useState<SmsThread[]>(data.threads);
    const [selected, setSelected] = useState<string | null>(null);
    const [conversation, setConversation] = useState<Conversation | null>(null);
    const [loading, setLoading] = useState(false);
    const [reply, setReply] = useState("");
    const [sending, setSending] = useState(false);
    const end = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!selected) return;
        setLoading(true);
        api<Conversation>("GET", `/api/portal/wedding/sms/${encodeURIComponent(selected)}`)
            .then((found) => {
                setConversation(found);
                setThreads((list) => list.map((t) => (t.phone === selected ? { ...t, unread: 0 } : t)));
            })
            .catch((error) => toast.error("Couldn't open the conversation", errorMessage(error)))
            .finally(() => setLoading(false));
        // toast is stable for the page's lifetime.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selected]);

    useEffect(() => end.current?.scrollIntoView({ block: "end" }), [conversation]);

    const send = async () => {
        if (!conversation) return;
        setSending(true);
        try {
            const { sms } = await api<{ sms: SmsMessage }>("POST", "/api/portal/wedding/sms", { phone: conversation.phone, body: reply });
            setConversation({ ...conversation, messages: [...conversation.messages, sms] });
            setThreads((list) => list.map((t) => (t.phone === sms.phone ? { ...t, last: sms } : t)));
            setReply("");
            toast.success("Text sent");
        } catch (error) {
            toast.error("Couldn't send", errorMessage(error));
        } finally {
            setSending(false);
        }
    };

    const segments = smsSegments(reply);
    const canReply = can("wedding.comms.send") && data.smsAvailable && conversation && !conversation.optedOut;

    return (
        <>
            <PageHeader
                title="Text messages"
                description="Every text sent to or received from guests, by mobile number. Replies arrive here once SMS is set up."
                breadcrumbs={[{ label: "Communications", href: "/portal/wedding/communications" }, { label: "Text messages" }]}
            />
            <DeliveryStatus status={data.status} email={data.emailAvailable} sms={data.smsAvailable} />

            {threads.length === 0 ? (
                <Empty
                    icon={MessageChatSquare}
                    title="No texts yet"
                    description="When you send an SMS campaign or a guest replies, the conversation appears here."
                />
            ) : (
                <div className="grid min-h-[32rem] grid-cols-1 overflow-hidden rounded-xl bg-primary shadow-xs ring-1 ring-secondary ring-inset lg:grid-cols-[20rem_1fr]">
                    <nav aria-label="Conversations" className={cx("border-secondary lg:border-r", selected && "max-lg:hidden")}>
                        <ul className="divide-y divide-secondary">
                            {threads.map((thread) => (
                                <li key={thread.phone}>
                                    <button
                                        type="button"
                                        onClick={() => setSelected(thread.phone)}
                                        aria-current={selected === thread.phone ? "true" : undefined}
                                        className={cx(
                                            "flex w-full flex-col gap-1 px-4 py-3 text-left outline-focus-ring transition duration-100 ease-linear hover:bg-primary_hover focus-visible:outline-2 focus-visible:-outline-offset-2",
                                            selected === thread.phone && "bg-active",
                                        )}
                                    >
                                        <span className="flex items-center justify-between gap-2">
                                            <span className="truncate text-sm font-semibold text-primary">{threadName(thread)}</span>
                                            {thread.unread > 0 && (
                                                <Badge size="sm" type="pill-color" color="brand">
                                                    {thread.unread} new
                                                </Badge>
                                            )}
                                        </span>
                                        <span className="truncate text-sm text-tertiary">
                                            {thread.last.direction === "outbound" ? "You: " : ""}
                                            {thread.last.body}
                                        </span>
                                        <span className="text-xs text-quaternary">
                                            <Timestamp iso={thread.last.createdAt} />
                                            {thread.optedOut && " · Opted out"}
                                        </span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    </nav>

                    <section aria-label="Conversation" className={cx("flex min-h-[32rem] flex-col", !selected && "max-lg:hidden")}>
                        {!selected ? (
                            <div className="m-auto p-8 text-center text-sm text-tertiary">Choose a conversation.</div>
                        ) : loading || !conversation ? (
                            <div className="flex flex-col gap-3 p-6">
                                <Skeleton className="h-10 w-2/3" />
                                <Skeleton className="ml-auto h-10 w-1/2" />
                            </div>
                        ) : (
                            <>
                                <header className="flex items-center gap-3 border-b border-secondary px-4 py-3">
                                    <Button color="tertiary" size="sm" iconLeading={ArrowLeft} className="lg:hidden" onClick={() => setSelected(null)}>
                                        Back
                                    </Button>
                                    <div className="min-w-0">
                                        <p className="truncate text-sm font-semibold text-primary">{threadName(conversation)}</p>
                                        <p className="text-xs text-tertiary">
                                            {conversation.phone}
                                            {conversation.guests[0]?.householdName && ` · ${conversation.guests[0].householdName}`}
                                        </p>
                                    </div>
                                </header>
                                <ol className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
                                    {conversation.messages.map((message) => (
                                        <li
                                            key={message.id}
                                            className={cx(
                                                "flex max-w-[85%] flex-col gap-1",
                                                message.direction === "outbound" ? "items-end self-end" : "items-start",
                                            )}
                                        >
                                            <p
                                                className={cx(
                                                    "rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap",
                                                    message.direction === "outbound"
                                                        ? "rounded-br-sm bg-brand-solid text-white"
                                                        : "rounded-bl-sm bg-secondary text-primary",
                                                )}
                                            >
                                                {message.body}
                                            </p>
                                            <span className="text-xs text-quaternary">
                                                <Timestamp iso={message.createdAt} />
                                                {message.direction === "outbound" && STATUS_LABEL[message.status] && ` · ${STATUS_LABEL[message.status]}`}
                                                {message.error && ` · ${message.error}`}
                                            </span>
                                        </li>
                                    ))}
                                    <div ref={end} />
                                </ol>
                                <footer className="flex flex-col gap-3 border-t border-secondary p-4">
                                    {conversation.optedOut ? (
                                        <Notice title="Opted out">This number replied STOP, so it won't be texted again.</Notice>
                                    ) : !data.smsAvailable ? (
                                        <p className="text-sm text-tertiary">Replies can be sent once SMS delivery is set up and switched on.</p>
                                    ) : !can("wedding.comms.send") ? (
                                        <p className="text-sm text-tertiary">You can read conversations, but only admins can send texts.</p>
                                    ) : null}
                                    {canReply && (
                                        <form
                                            className="flex flex-col gap-3"
                                            onSubmit={(e) => {
                                                e.preventDefault();
                                                void send();
                                            }}
                                        >
                                            <TextArea
                                                label="Reply"
                                                rows={3}
                                                value={reply}
                                                onChange={setReply}
                                                hint={`${segments.length} characters · ${segments.segments} SMS part${segments.segments === 1 ? "" : "s"}`}
                                            />
                                            <div className="flex justify-end">
                                                <Button type="submit" iconLeading={Send01} isLoading={sending} showTextWhileLoading isDisabled={!reply.trim()}>
                                                    Send text
                                                </Button>
                                            </div>
                                        </form>
                                    )}
                                </footer>
                            </>
                        )}
                    </section>
                </div>
            )}
        </>
    );
};
