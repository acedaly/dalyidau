import { useState } from "react";
import { FileHeart02, Mail01, MessageChatSquare, Plus, Send01 } from "@untitledui/icons";
import { Tabs } from "@/components/application/tabs/tabs";
import { Button } from "@/components/base/buttons/button";
import { ComposePanel } from "@/portal/communications/compose-panel";
import { DeliveryStatus } from "@/portal/communications/delivery-status";
import { TemplateDialog } from "@/portal/communications/template-dialog";
import { type DataColumn, DataTable } from "@/portal/components/data-table";
import { Empty } from "@/portal/components/empty";
import { Notice } from "@/portal/components/notice";
import { PageHeader } from "@/portal/components/page-header";
import { MessageStatusBadge } from "@/portal/components/status";
import { Timestamp } from "@/portal/components/timestamp";
import { useCollection } from "@/portal/hooks/use-collection";
import { pluralise } from "@/portal/lib/format";
import type { PageData } from "@/portal/lib/page-types";
import { usePortal } from "@/portal/portal-context";
import { MESSAGE_CATEGORY_LABELS, type Message, type MessageTemplate } from "@/shared/portal/types";

const CATEGORY_LABELS = MESSAGE_CATEGORY_LABELS;

export const CommunicationsPage = ({ data }: { data: PageData<"communications"> }) => {
    const { can } = usePortal();
    const templates = useCollection<MessageTemplate>("templates", data.templates);
    const [composeOpen, setComposeOpen] = useState(false);
    const [composeFrom, setComposeFrom] = useState<MessageTemplate | null>(null);
    const [templateOpen, setTemplateOpen] = useState(false);
    const [editingTemplate, setEditingTemplate] = useState<MessageTemplate | null>(null);
    const canEdit = can("wedding.comms.edit");

    const compose = (template: MessageTemplate | null) => {
        setComposeFrom(template);
        setComposeOpen(true);
    };
    const editTemplate = (template: MessageTemplate | null) => {
        setEditingTemplate(template);
        setTemplateOpen(true);
    };

    const messageColumns: DataColumn<Message>[] = [
        {
            id: "subject",
            label: "Subject",
            isRowHeader: true,
            sortValue: (m) => m.subject,
            render: (m) => <span className="font-medium text-primary">{m.subject}</span>,
        },
        { id: "channel", label: "Channel", sortValue: (m) => m.channel, render: (m) => (m.channel === "sms" ? "Text" : "Email"), className: "max-md:hidden" },
        { id: "status", label: "Status", sortValue: (m) => m.status, render: (m) => <MessageStatusBadge status={m.status} /> },
        { id: "category", label: "Category", sortValue: (m) => m.category, render: (m) => CATEGORY_LABELS[m.category], className: "max-md:hidden" },
        { id: "recipients", label: "Recipients", sortValue: (m) => m.recipientCount, render: (m) => pluralise(m.recipientCount, "guest") },
        { id: "by", label: "Prepared by", sortValue: (m) => m.createdBy, render: (m) => m.createdBy, className: "max-lg:hidden" },
        {
            id: "created",
            label: "Prepared",
            sortValue: (m) => m.createdAt,
            render: (m) => <Timestamp iso={m.scheduledAt ?? m.createdAt} relative />,
            className: "max-md:hidden",
        },
    ];

    const templateColumns: DataColumn<MessageTemplate>[] = [
        {
            id: "name",
            label: "Template",
            isRowHeader: true,
            sortValue: (t) => t.name,
            render: (t) => <span className="font-medium text-primary">{t.name}</span>,
        },
        { id: "subject", label: "Subject", sortValue: (t) => t.subject, render: (t) => t.subject, className: "max-md:hidden" },
        { id: "category", label: "Category", sortValue: (t) => t.category, render: (t) => CATEGORY_LABELS[t.category], className: "max-lg:hidden" },
        { id: "updated", label: "Updated", sortValue: (t) => t.updatedAt, render: (t) => <Timestamp iso={t.updatedAt} relative />, className: "max-lg:hidden" },
        {
            id: "use",
            label: "",
            render: (t) =>
                canEdit && (
                    <Button size="sm" color="link-color" iconLeading={Send01} onClick={() => compose(t)}>
                        Use
                    </Button>
                ),
        },
    ];

    return (
        <>
            <PageHeader
                title="Communications"
                description="Save-the-dates, invitations, reminders and updates."
                breadcrumbs={[{ label: "Communications" }]}
                actions={
                    canEdit && (
                        <>
                            <Button color="secondary" iconLeading={FileHeart02} onClick={() => editTemplate(null)}>
                                New template
                            </Button>
                            <Button iconLeading={Plus} onClick={() => compose(null)}>
                                New message
                            </Button>
                        </>
                    )
                }
            />

            <DeliveryStatus status={data.comms.status} email={data.comms.email} sms={data.comms.sms} />
            {!data.deliveryAvailable && (
                <Notice color="brand" title="Nothing is sent from the portal yet">
                    You can write messages, choose recipients, preview them for each guest and export a mail-merge file. Email and texts are only sent once a
                    provider is set up and its switch is turned on in Wedding settings → Features.
                </Notice>
            )}
            {canEdit && (
                <div className="flex items-center justify-between gap-4 rounded-xl bg-primary px-5 py-4 shadow-xs ring-1 ring-secondary ring-inset">
                    <div className="flex items-center gap-3">
                        <MessageChatSquare className="size-5 text-fg-quaternary" aria-hidden="true" />
                        <p className="text-sm text-secondary">
                            <span className="font-semibold">Text conversations</span>
                            {data.unreadTexts > 0
                                ? ` · ${pluralise(data.unreadTexts, "unread reply", "unread replies")}`
                                : " · replies from guests appear here"}
                        </p>
                    </div>
                    <Button size="sm" color="secondary" href="/portal/wedding/communications/texts">
                        Open
                    </Button>
                </div>
            )}

            <Tabs defaultSelectedKey="messages">
                <Tabs.List type="button-minimal" size="sm" className="w-max">
                    <Tabs.Item id="messages" badge={data.messages.length || undefined}>
                        Messages
                    </Tabs.Item>
                    <Tabs.Item id="templates" badge={templates.items.length || undefined}>
                        Templates
                    </Tabs.Item>
                </Tabs.List>
                <Tabs.Panel id="messages" className="pt-6">
                    <DataTable
                        title="Messages"
                        description="Every message prepared in the portal, with its delivery history."
                        rows={data.messages}
                        columns={messageColumns}
                        searchText={(m) => m.subject}
                        initialSort={{ column: "created", direction: "descending" }}
                        onRowAction={(m) => window.location.assign(`/portal/wedding/communications/${m.id}`)}
                        emptyState={
                            <Empty
                                icon={Mail01}
                                title="No messages yet"
                                description="Prepare a message to see exactly who it will reach and how it reads for each guest."
                                actions={
                                    canEdit && (
                                        <Button iconLeading={Plus} onClick={() => compose(null)}>
                                            New message
                                        </Button>
                                    )
                                }
                            />
                        }
                    />
                </Tabs.Panel>
                <Tabs.Panel id="templates" className="pt-6">
                    <DataTable
                        title="Templates"
                        rows={templates.items}
                        columns={templateColumns}
                        searchText={(t) => `${t.name} ${t.subject}`}
                        initialSort={{ column: "name", direction: "ascending" }}
                        onRowAction={editTemplate}
                        emptyState={
                            <Empty
                                icon={FileHeart02}
                                title="No templates yet"
                                description="Write the wording once, with merge fields like {{first_name}} and {{rsvp_link}}, and reuse it for every send."
                                actions={
                                    canEdit && (
                                        <Button iconLeading={Plus} onClick={() => editTemplate(null)}>
                                            New template
                                        </Button>
                                    )
                                }
                            />
                        }
                    />
                </Tabs.Panel>
            </Tabs>

            <ComposePanel
                isOpen={composeOpen}
                onOpenChange={setComposeOpen}
                templates={templates.items}
                events={data.events}
                groups={data.groups}
                tags={data.tags}
                initialTemplate={composeFrom}
            />
            <TemplateDialog
                template={editingTemplate}
                isOpen={templateOpen}
                onOpenChange={setTemplateOpen}
                onSave={templates.save}
                onDelete={templates.remove}
                canEdit={canEdit}
            />
        </>
    );
};
