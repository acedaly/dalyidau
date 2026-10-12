import { useState } from "react";
import { Calendar, Edit01, MarkerPin01, Plus } from "@untitledui/icons";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { TextArea } from "@/components/base/textarea/textarea";
import { Toggle } from "@/components/base/toggle/toggle";
import { Empty } from "@/portal/components/empty";
import { EntityPanel } from "@/portal/components/entity-panel";
import { FormGrid, FullWidth } from "@/portal/components/form";
import { PageHeader } from "@/portal/components/page-header";
import { useCollection } from "@/portal/hooks/use-collection";
import { formatDate, formatTime } from "@/portal/lib/format";
import type { PageData } from "@/portal/lib/page-types";
import { usePortal } from "@/portal/portal-context";
import type { WeddingEvent } from "@/shared/portal/types";

interface Draft {
    name: string;
    startsAt: string;
    endsAt: string;
    venueName: string;
    address: string;
    description: string;
    dressCode: string;
    isPublic: boolean;
    rsvpEnabled: boolean;
    sortOrder: string;
}

const toDraft = (e: WeddingEvent | null, nextOrder: number): Draft => ({
    name: e?.name ?? "",
    startsAt: e?.startsAt ?? "",
    endsAt: e?.endsAt ?? "",
    venueName: e?.venueName ?? "",
    address: e?.address ?? "",
    description: e?.description ?? "",
    dressCode: e?.dressCode ?? "",
    isPublic: e?.isPublic ?? true,
    rsvpEnabled: e?.rsvpEnabled ?? true,
    sortOrder: String(e?.sortOrder ?? nextOrder),
});

const toPayload = (d: Draft) => ({
    ...d,
    startsAt: d.startsAt || null,
    endsAt: d.endsAt || null,
    sortOrder: Number.parseInt(d.sortOrder, 10) || 0,
});

export const describeWhen = (e: Pick<WeddingEvent, "startsAt" | "endsAt">) => {
    if (!e.startsAt) return "Date to be confirmed";
    const day = formatDate(e.startsAt.slice(0, 10), { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    const start = formatTime(e.startsAt);
    const end = e.endsAt && e.endsAt.slice(0, 10) === e.startsAt.slice(0, 10) ? formatTime(e.endsAt) : "";
    return `${day} · ${start}${end ? ` – ${end}` : ""}`;
};

export const EventsPage = ({ data }: { data: PageData<"events"> }) => {
    const { can } = usePortal();
    const events = useCollection<WeddingEvent>("events", data.events);
    const [editing, setEditing] = useState<WeddingEvent | null>(null);
    const [open, setOpen] = useState(false);
    const [draft, setDraft] = useState<Draft>(toDraft(null, 0));
    const canEdit = can("wedding.guests.edit");
    const sorted = [...events.items].sort((a, b) => a.sortOrder - b.sortOrder || (a.startsAt ?? "").localeCompare(b.startsAt ?? ""));

    const openPanel = (event: WeddingEvent | null) => {
        setEditing(event);
        setDraft(toDraft(event, (Math.max(0, ...events.items.map((e) => e.sortOrder)) || 0) + 10));
        setOpen(true);
    };

    return (
        <>
            <PageHeader
                title="Events"
                description="The parts of the celebration guests can be invited to. Public events appear on the wedding website."
                breadcrumbs={[{ label: "Events" }]}
                actions={
                    canEdit && (
                        <Button iconLeading={Plus} onClick={() => openPanel(null)}>
                            Add event
                        </Button>
                    )
                }
            />

            {sorted.length === 0 ? (
                <div className="rounded-xl py-10 ring-1 ring-secondary">
                    <Empty
                        icon={Calendar}
                        title="No events yet"
                        description="Start with the ceremony and the reception. You can add welcome drinks or a recovery brunch later and invite only some guests to them."
                        actions={
                            canEdit && (
                                <Button iconLeading={Plus} onClick={() => openPanel(null)}>
                                    Add event
                                </Button>
                            )
                        }
                    />
                </div>
            ) : (
                <ul className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                    {sorted.map((event) => (
                        <li key={event.id} className="flex flex-col gap-4 rounded-xl bg-primary p-5 shadow-xs ring-1 ring-secondary ring-inset">
                            <div className="flex items-start justify-between gap-4">
                                <div className="flex flex-col gap-1">
                                    <h2 className="text-lg font-semibold text-primary">{event.name}</h2>
                                    <p className="text-sm text-tertiary">{describeWhen(event)}</p>
                                </div>
                                <Button size="sm" color="secondary" iconLeading={Edit01} onClick={() => openPanel(event)}>
                                    {canEdit ? "Edit" : "View"}
                                </Button>
                            </div>
                            {(event.venueName || event.address) && (
                                <p className="flex items-start gap-2 text-sm text-secondary">
                                    <MarkerPin01 className="mt-0.5 size-4 shrink-0 text-fg-quaternary" aria-hidden="true" />
                                    <span>{[event.venueName, event.address].filter(Boolean).join(", ")}</span>
                                </p>
                            )}
                            {event.description && <p className="line-clamp-3 text-sm whitespace-pre-line text-tertiary">{event.description}</p>}
                            <div className="flex flex-wrap gap-2">
                                <Badge size="sm" type="pill-color" color={event.isPublic ? "success" : "gray"}>
                                    {event.isPublic ? "On the website" : "Private"}
                                </Badge>
                                <Badge size="sm" type="pill-color" color={event.rsvpEnabled ? "brand" : "gray"}>
                                    {event.rsvpEnabled ? "Collecting RSVPs" : "No RSVP"}
                                </Badge>
                                {event.dressCode && (
                                    <Badge size="sm" type="modern" color="gray">
                                        {event.dressCode}
                                    </Badge>
                                )}
                            </div>
                        </li>
                    ))}
                </ul>
            )}

            <EntityPanel
                isOpen={open}
                onOpenChange={setOpen}
                noun="event"
                name={editing?.name ?? null}
                canEdit={canEdit}
                onSave={() => events.save(editing?.id ?? null, toPayload(draft))}
                onDelete={editing ? () => events.remove(editing.id) : undefined}
                deleteWarning="Invitations and RSVPs for this event are deleted with it."
            >
                {(fieldError) => (
                    <FormGrid>
                        <FullWidth>
                            <Input
                                label="Name"
                                isRequired
                                placeholder="Ceremony"
                                value={draft.name}
                                onChange={(v) => setDraft({ ...draft, name: v })}
                                isInvalid={!!fieldError("name")}
                                hint={fieldError("name")}
                            />
                        </FullWidth>
                        <Input
                            label="Starts"
                            type="datetime-local"
                            value={draft.startsAt}
                            onChange={(v) => setDraft({ ...draft, startsAt: v })}
                            isInvalid={!!fieldError("startsAt")}
                            hint={fieldError("startsAt") ?? "Local time at the venue"}
                        />
                        <Input
                            label="Ends"
                            type="datetime-local"
                            value={draft.endsAt}
                            onChange={(v) => setDraft({ ...draft, endsAt: v })}
                            isInvalid={!!fieldError("endsAt")}
                            hint={fieldError("endsAt")}
                        />
                        <FullWidth>
                            <Input label="Venue" value={draft.venueName} onChange={(v) => setDraft({ ...draft, venueName: v })} />
                        </FullWidth>
                        <FullWidth>
                            <Input
                                label="Address"
                                value={draft.address}
                                onChange={(v) => setDraft({ ...draft, address: v })}
                                hint="Shown on the public website if the event is public."
                            />
                        </FullWidth>
                        <FullWidth>
                            <TextArea label="Description" rows={4} value={draft.description} onChange={(v) => setDraft({ ...draft, description: v })} />
                        </FullWidth>
                        <Input label="Dress code" value={draft.dressCode} onChange={(v) => setDraft({ ...draft, dressCode: v })} />
                        <Input
                            label="Order"
                            type="number"
                            value={draft.sortOrder}
                            onChange={(v) => setDraft({ ...draft, sortOrder: v })}
                            hint="Lower numbers come first."
                            isInvalid={!!fieldError("sortOrder")}
                        />
                        <FullWidth>
                            <Toggle label="Show on the wedding website" isSelected={draft.isPublic} onChange={(v) => setDraft({ ...draft, isPublic: v })} />
                        </FullWidth>
                        <FullWidth>
                            <Toggle
                                label="Collect RSVPs for this event"
                                hint="Turn off for events everyone attends without replying separately."
                                isSelected={draft.rsvpEnabled}
                                onChange={(v) => setDraft({ ...draft, rsvpEnabled: v })}
                            />
                        </FullWidth>
                    </FormGrid>
                )}
            </EntityPanel>
        </>
    );
};
