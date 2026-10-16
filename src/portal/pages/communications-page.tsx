import { useState } from "react";
import {
    Announcement02,
    BellRinging01,
    CalendarHeart01,
    FileHeart02,
    HeartHand,
    Mail01,
    MarkerPin01,
    MessageChatSquare,
    Palette,
    Plus,
    Printer,
    Send01,
} from "@untitledui/icons";
import { Tabs } from "@/components/application/tabs/tabs";
import { Button } from "@/components/base/buttons/button";
import { FeaturedIcon } from "@/components/foundations/featured-icon/featured-icon";
import { ComposePanel } from "@/portal/communications/compose-panel";
import { DeliveryStatus } from "@/portal/communications/delivery-status";
import { StudioSettingsDialog } from "@/portal/communications/studio-settings-dialog";
import { TemplateDialog } from "@/portal/communications/template-dialog";
import { ThankYouNotesDialog } from "@/portal/communications/thank-you-notes-dialog";
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
import { CAMPAIGNS, CAMPAIGN_KINDS, type CampaignKind } from "@/shared/portal/campaigns";
import { MESSAGE_CATEGORY_LABELS, type Message, type MessageTemplate, type StudioSettings } from "@/shared/portal/types";

const CAMPAIGN_ICONS = {
    save_the_date: CalendarHeart01,
    invitation: Mail01,
    reminder: BellRinging01,
    final_details: MarkerPin01,
    thank_you: HeartHand,
} as const;

const CATEGORY_LABELS = MESSAGE_CATEGORY_LABELS;

export const CommunicationsPage = ({ data }: { data: PageData<"communications"> }) => {
    const { can } = usePortal();
    const templates = useCollection<MessageTemplate>("templates", data.templates);
    const [composeOpen, setComposeOpen] = useState(false);
    const [composeFrom, setComposeFrom] = useState<MessageTemplate | null>(null);
    const [templateOpen, setTemplateOpen] = useState(false);
    const [editingTemplate, setEditingTemplate] = useState<MessageTemplate | null>(null);
    const [kind, setKind] = useState<CampaignKind | null>(null);
    const [studio, setStudio] = useState<StudioSettings>(data.studio);
    const [designing, setDesigning] = useState<CampaignKind | null>(null);
    const [notesOpen, setNotesOpen] = useState(false);
    const canEdit = can("wedding.comms.edit");

    const compose = (template: MessageTemplate | null, campaign: CampaignKind | null = null) => {
        setComposeFrom(template);
        setKind(campaign);
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

            <section aria-labelledby="studio-heading" className="flex flex-col gap-4">
                <div className="flex flex-col gap-1">
                    <h2 id="studio-heading" className="text-lg font-semibold text-primary">
                        Communications Studio
                    </h2>
                    <p className="text-sm text-tertiary">
                        The guest journey, in order. Each goes to one person per household by default, in the wedding stationery design. Choose recipients,
                        customise, preview and test before anything is sent.
                    </p>
                </div>
                <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                    {CAMPAIGN_KINDS.map((key, index) => {
                        const campaign = CAMPAIGNS[key];
                        const sent = data.campaignProgress.sent[key];
                        return (
                            <li key={key} className="flex flex-col gap-4 rounded-xl bg-primary p-5 shadow-xs ring-1 ring-secondary ring-inset">
                                <div className="flex items-start gap-3">
                                    <FeaturedIcon icon={CAMPAIGN_ICONS[key]} color="brand" theme="light" size="md" />
                                    <div className="flex min-w-0 flex-col gap-1">
                                        <p className="text-xs font-semibold tracking-wide text-brand-secondary uppercase">Step {index + 1}</p>
                                        <h3 className="text-md font-semibold text-primary">{campaign.label}</h3>
                                        <p className="text-sm text-tertiary">{campaign.description}</p>
                                    </div>
                                </div>
                                <p className="text-sm text-secondary">
                                    {sent ? `Sent to ${pluralise(sent, "household")}` : "Not sent yet"}
                                    {key === "invitation" && data.campaignProgress.households ? ` of ${data.campaignProgress.households} invited` : ""}
                                </p>
                                {canEdit && (
                                    <div className="mt-auto flex flex-wrap gap-2">
                                        <Button size="sm" iconLeading={Plus} onClick={() => compose(null, key)}>
                                            Create
                                        </Button>
                                        {key !== "invitation" && (
                                            <Button size="sm" color="secondary" iconLeading={Palette} onClick={() => setDesigning(key)}>
                                                Wording &amp; design
                                            </Button>
                                        )}
                                        {key === "invitation" && (
                                            <Button size="sm" color="secondary" iconLeading={Printer} href="/portal/wedding/invitations">
                                                Invitation Studio
                                            </Button>
                                        )}
                                        {key === "thank_you" && (
                                            <Button size="sm" color="secondary" iconLeading={HeartHand} onClick={() => setNotesOpen(true)}>
                                                Personal notes
                                            </Button>
                                        )}
                                    </div>
                                )}
                            </li>
                        );
                    })}
                    <li className="flex flex-col gap-3 rounded-xl border border-dashed border-primary p-5">
                        <div className="flex items-start gap-3">
                            <FeaturedIcon icon={Announcement02} color="gray" theme="modern" size="md" />
                            <div className="flex flex-col gap-1">
                                <h3 className="text-md font-semibold text-primary">RSVP confirmation</h3>
                                <p className="text-sm text-tertiary">
                                    Sent on its own after each online RSVP, when switched on in RSVPs → Settings and email delivery is on. Separate from the
                                    campaigns above.
                                </p>
                            </div>
                        </div>
                    </li>
                </ul>
            </section>

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
                kind={kind}
                studio={studio}
                households={data.households}
                guests={data.guests}
            />
            <StudioSettingsDialog
                kind={designing}
                studio={studio}
                photos={data.photos}
                onOpenChange={(open) => !open && setDesigning(null)}
                onSaved={setStudio}
            />
            <ThankYouNotesDialog isOpen={notesOpen} onOpenChange={setNotesOpen} households={data.households} />
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
