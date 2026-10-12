import { useEffect, useState } from "react";
import { Trash01 } from "@untitledui/icons";
import { Tabs } from "@/components/application/tabs/tabs";
import { Avatar } from "@/components/base/avatar/avatar";
import { ButtonGroup, ButtonGroupItem } from "@/components/base/button-group/button-group";
import { Button } from "@/components/base/buttons/button";
import { ConfirmDialog } from "@/portal/components/dialog";
import { FormError, useSubmit } from "@/portal/components/form";
import { RecordPanel } from "@/portal/components/record-panel";
import { RsvpBadge } from "@/portal/components/status";
import { Timestamp } from "@/portal/components/timestamp";
import { useToast } from "@/portal/components/toast";
import { type GuestDraft, GuestForm, draftFromGuest, draftToPayload } from "@/portal/guests/guest-form";
import { api, errorMessage } from "@/portal/lib/api";
import { formatDateTime, initials } from "@/portal/lib/format";
import { usePortal } from "@/portal/portal-context";
import type { AuditEntry, CustomField, Guest, Household, RsvpStatus, WeddingEvent } from "@/shared/portal/types";

interface GuestPanelProps {
    guest: Guest | null;
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
    households: Pick<Household, "id" | "name">[];
    events: WeddingEvent[];
    customFields: CustomField[];
    onSaved: (guest: Guest) => void;
    onDeleted: (id: string) => void;
}

const SOURCE_LABELS: Record<string, string> = { portal: "entered in the portal", native: "online RSVP", sayido: "from Say I Do", import: "imported" };

export const GuestPanel = ({ guest, isOpen, onOpenChange, households, events, customFields, onSaved, onDeleted }: GuestPanelProps) => {
    const { can, wedding } = usePortal();
    const toast = useToast();
    const canEdit = can("wedding.guests.edit");
    const [draft, setDraft] = useState<GuestDraft>(draftFromGuest(guest));
    const [tab, setTab] = useState<string>("details");
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [activity, setActivity] = useState<AuditEntry[] | null>(null);

    // Reset whenever a different guest (or a new one) is opened.
    useEffect(() => {
        if (!isOpen) return;
        setDraft(draftFromGuest(guest));
        setTab("details");
        setActivity(null);
    }, [guest?.id, isOpen]);

    useEffect(() => {
        if (tab !== "activity" || !guest || activity || !can("portal.audit.view")) return;
        api<{ entries: AuditEntry[] }>("GET", `/api/portal/audit?entityId=${encodeURIComponent(guest.id)}`)
            .then((r) => setActivity(r.entries))
            .catch(() => setActivity([]));
    }, [tab, guest, activity, can]);

    const save = useSubmit(
        () =>
            guest
                ? api<{ guest: Guest }>("PATCH", `/api/portal/wedding/guests/${guest.id}`, draftToPayload(draft))
                : api<{ guest: Guest }>("POST", "/api/portal/wedding/guests", draftToPayload(draft)),
        {
            success: guest ? "Guest updated" : "Guest added",
            onSuccess: ({ guest: saved }) => {
                onSaved(saved);
                onOpenChange(false);
            },
        },
    );

    const setRsvp = async (eventId: string, status: RsvpStatus) => {
        if (!guest) return;
        try {
            const result = await api<{ guest: Guest }>("PUT", `/api/portal/wedding/guests/${guest.id}/rsvp`, { eventId, status, source: "portal" });
            onSaved(result.guest);
        } catch (error) {
            toast.error("Couldn't update the RSVP", errorMessage(error));
        }
    };

    const name = guest ? `${guest.firstName} ${guest.lastName}`.trim() : "New guest";
    const nonFieldError =
        save.error && save.error.issues.length > 0 && !["firstName", "lastName", "email", "phone"].some((f) => save.fieldError(f)) ? save.error.message : null;

    return (
        <>
            <RecordPanel
                isOpen={isOpen}
                onOpenChange={onOpenChange}
                title={name}
                description={guest ? (guest.householdName ?? "No household") : "Add someone to the guest list."}
                leading={guest && <Avatar size="lg" initials={initials(name)} />}
                width="lg"
                onSubmit={canEdit ? save.submit : undefined}
                footer={
                    <>
                        {guest && canEdit && (
                            <Button color="tertiary-destructive" iconLeading={Trash01} onClick={() => setConfirmDelete(true)} className="mr-auto">
                                Delete
                            </Button>
                        )}
                        <Button color="secondary" onClick={() => onOpenChange(false)}>
                            {canEdit ? "Cancel" : "Close"}
                        </Button>
                        {canEdit && (
                            <Button type="submit" isLoading={save.busy} showTextWhileLoading>
                                {guest ? "Save changes" : "Add guest"}
                            </Button>
                        )}
                    </>
                }
            >
                {!guest ? (
                    <div className="flex flex-col gap-4">
                        <FormError message={nonFieldError} />
                        <GuestForm
                            draft={draft}
                            onChange={setDraft}
                            households={households}
                            events={events}
                            customFields={customFields}
                            fieldError={save.fieldError}
                            readOnly={!canEdit}
                        />
                    </div>
                ) : (
                    <Tabs selectedKey={tab} onSelectionChange={(key) => setTab(String(key))}>
                        {guest && (
                            <Tabs.List type="underline" size="sm" className="mb-6">
                                <Tabs.Item id="details">Details</Tabs.Item>
                                <Tabs.Item id="rsvp" badge={guest.events.length || undefined}>
                                    RSVP
                                </Tabs.Item>
                                {can("portal.audit.view") && <Tabs.Item id="activity">Activity</Tabs.Item>}
                            </Tabs.List>
                        )}
                        <Tabs.Panel id="details" className="flex flex-col gap-4">
                            <FormError message={nonFieldError} />
                            <GuestForm
                                draft={draft}
                                onChange={setDraft}
                                households={households}
                                events={events}
                                customFields={customFields}
                                fieldError={save.fieldError}
                                readOnly={!canEdit}
                            />
                        </Tabs.Panel>
                        {guest && (
                            <Tabs.Panel id="rsvp" className="flex flex-col gap-5">
                                <div className="flex items-center gap-2">
                                    <span className="text-sm text-tertiary">Overall</span>
                                    <RsvpBadge status={guest.rsvp} />
                                </div>
                                {guest.events.length === 0 ? (
                                    <p className="text-sm text-tertiary">Not invited to any events yet. Choose events under Details.</p>
                                ) : (
                                    <ul className="flex flex-col divide-y divide-secondary rounded-xl ring-1 ring-secondary">
                                        {guest.events.map((status) => {
                                            const event = events.find((e) => e.id === status.eventId);
                                            return (
                                                <li key={status.eventId} className="flex flex-col gap-3 p-4">
                                                    <div className="flex flex-col gap-0.5">
                                                        <p className="text-sm font-semibold text-primary">{event?.name ?? "Event"}</p>
                                                        {status.respondedAt && (
                                                            <p className="text-xs text-tertiary">
                                                                Replied {formatDateTime(status.respondedAt, wedding.timeZone)}
                                                                {status.source ? `, ${SOURCE_LABELS[status.source] ?? status.source}` : ""}
                                                            </p>
                                                        )}
                                                    </div>
                                                    <ButtonGroup
                                                        size="sm"
                                                        selectionMode="single"
                                                        disallowEmptySelection
                                                        isDisabled={!can("wedding.rsvp.edit")}
                                                        selectedKeys={[status.status]}
                                                        onSelectionChange={(keys) => {
                                                            const next = [...keys][0] as RsvpStatus | undefined;
                                                            if (next && next !== status.status) void setRsvp(status.eventId, next);
                                                        }}
                                                        aria-label={`RSVP for ${event?.name ?? "event"}`}
                                                    >
                                                        <ButtonGroupItem id="attending">Attending</ButtonGroupItem>
                                                        <ButtonGroupItem id="declined">Declined</ButtonGroupItem>
                                                        <ButtonGroupItem id="pending">Awaiting</ButtonGroupItem>
                                                    </ButtonGroup>
                                                </li>
                                            );
                                        })}
                                    </ul>
                                )}
                            </Tabs.Panel>
                        )}
                        {guest && can("portal.audit.view") && (
                            <Tabs.Panel id="activity">
                                {activity === null ? (
                                    <p className="text-sm text-tertiary">Loading…</p>
                                ) : activity.length === 0 ? (
                                    <p className="text-sm text-tertiary">No recorded changes.</p>
                                ) : (
                                    <ol className="flex flex-col gap-4">
                                        {activity.map((entry) => (
                                            <li key={entry.id} className="flex flex-col gap-0.5 border-l-2 border-secondary pl-3">
                                                <p className="text-sm text-secondary">{entry.summary}</p>
                                                <p className="text-xs text-tertiary">
                                                    {entry.actor.startsWith("rsvp:") ? "Online RSVP" : entry.actor} · <Timestamp iso={entry.at} />
                                                </p>
                                            </li>
                                        ))}
                                    </ol>
                                )}
                            </Tabs.Panel>
                        )}
                    </Tabs>
                )}
            </RecordPanel>

            {guest && (
                <ConfirmDialog
                    isOpen={confirmDelete}
                    onOpenChange={setConfirmDelete}
                    title={`Delete ${name}?`}
                    description="They'll be removed from the guest list and every event. The audit log keeps a copy of their details."
                    confirmLabel="Delete guest"
                    destructive
                    onConfirm={async () => {
                        try {
                            await api("DELETE", `/api/portal/wedding/guests/${guest.id}`);
                            toast.success("Guest deleted");
                            onDeleted(guest.id);
                            onOpenChange(false);
                        } catch (error) {
                            toast.error("Couldn't delete the guest", errorMessage(error));
                        }
                    }}
                />
            )}
        </>
    );
};
