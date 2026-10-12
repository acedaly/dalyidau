import { useState } from "react";
import { CalendarCheck01, ChevronDown, Edit05, Tag01, Trash01, Users01 } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { Dropdown } from "@/components/base/dropdown/dropdown";
import { Input } from "@/components/base/input/input";
import { Select } from "@/components/base/select/select";
import { ConfirmDialog, PortalDialog } from "@/portal/components/dialog";
import { useToast } from "@/portal/components/toast";
import { api, errorMessage } from "@/portal/lib/api";
import { pluralise } from "@/portal/lib/format";
import { usePortal } from "@/portal/portal-context";
import type { Guest, Household, Side, WeddingEvent } from "@/shared/portal/types";

type Action = "invite" | "uninvite" | "set-rsvp" | "set-household" | "set-side" | "set-group" | "add-tag" | "remove-tag" | "delete";

const TITLES: Record<Action, string> = {
    invite: "Invite to an event",
    uninvite: "Remove from an event",
    "set-rsvp": "Set RSVP",
    "set-household": "Move to a household",
    "set-side": "Change side",
    "set-group": "Change group",
    "add-tag": "Add a tag",
    "remove-tag": "Remove a tag",
    delete: "Delete guests",
};

interface BulkActionsProps {
    ids: string[];
    clear: () => void;
    events: WeddingEvent[];
    households: Pick<Household, "id" | "name">[];
    onDone: (guests: Guest[]) => void;
}

export const BulkActions = ({ ids, clear, events, households, onDone }: BulkActionsProps) => {
    const { can, sideLabel } = usePortal();
    const toast = useToast();
    const [action, setAction] = useState<Action | null>(null);
    const [value, setValue] = useState<Record<string, string>>({});
    const [busy, setBusy] = useState(false);

    const open = (next: Action) => {
        setAction(next);
        setValue({ eventId: events[0]?.id ?? "", status: "attending", householdId: households[0]?.id ?? "none", side: "shared", groupName: "", tag: "" });
    };

    const run = async () => {
        if (!action) return;
        setBusy(true);
        try {
            const body: Record<string, unknown> = { action, ids };
            if (action === "invite" || action === "uninvite") body.eventId = value.eventId;
            if (action === "set-rsvp") Object.assign(body, { eventId: value.eventId, status: value.status, source: value.source ?? "portal" });
            if (action === "set-household") body.householdId = value.householdId === "none" ? null : value.householdId;
            if (action === "set-side") body.side = value.side;
            if (action === "set-group") body.groupName = value.groupName;
            if (action === "add-tag" || action === "remove-tag") body.tag = value.tag;
            const result = await api<{ affected: number; guests: Guest[] }>("POST", "/api/portal/wedding/guests/bulk", body);
            toast.success(TITLES[action], `${pluralise(result.affected, "guest")} updated.`);
            onDone(result.guests);
            clear();
            setAction(null);
        } catch (error) {
            toast.error("Couldn't apply the change", errorMessage(error));
        } finally {
            setBusy(false);
        }
    };

    if (!can("wedding.guests.edit")) return null;
    const needsEvent = action === "invite" || action === "uninvite" || action === "set-rsvp";

    return (
        <>
            <Dropdown.Root>
                <Button size="sm" color="secondary" iconTrailing={ChevronDown}>
                    Actions
                </Button>
                <Dropdown.Popover className="w-60">
                    <Dropdown.Menu onAction={(key) => open(key as Action)} disabledKeys={events.length === 0 ? ["invite", "uninvite", "set-rsvp"] : []}>
                        <Dropdown.Section>
                            <Dropdown.Item id="invite" icon={CalendarCheck01} label="Invite to an event" />
                            <Dropdown.Item id="uninvite" icon={CalendarCheck01} label="Remove from an event" />
                            {can("wedding.rsvp.edit") && <Dropdown.Item id="set-rsvp" icon={CalendarCheck01} label="Set RSVP" />}
                        </Dropdown.Section>
                        <Dropdown.Separator />
                        <Dropdown.Section>
                            <Dropdown.Item id="set-household" icon={Users01} label="Move to a household" />
                            <Dropdown.Item id="set-side" icon={Edit05} label="Change side" />
                            <Dropdown.Item id="set-group" icon={Edit05} label="Change group" />
                            <Dropdown.Item id="add-tag" icon={Tag01} label="Add a tag" />
                            <Dropdown.Item id="remove-tag" icon={Tag01} label="Remove a tag" />
                        </Dropdown.Section>
                        <Dropdown.Separator />
                        <Dropdown.Item id="delete" icon={Trash01} label="Delete" />
                    </Dropdown.Menu>
                </Dropdown.Popover>
            </Dropdown.Root>

            <ConfirmDialog
                isOpen={action === "delete"}
                onOpenChange={(o) => !o && setAction(null)}
                title={`Delete ${pluralise(ids.length, "guest")}?`}
                description="They'll disappear from the guest list, counts, exports and the RSVP form. You can restore them from Settings → Privacy."
                confirmLabel="Delete"
                destructive
                onConfirm={run}
            />

            <PortalDialog
                isOpen={!!action && action !== "delete"}
                onOpenChange={(o) => !o && setAction(null)}
                title={action ? TITLES[action] : ""}
                description={`Applies to ${pluralise(ids.length, "selected guest")}.`}
                size="sm"
                onSubmit={run}
                footer={
                    <>
                        <Button color="secondary" size="lg" onClick={() => setAction(null)} isDisabled={busy}>
                            Cancel
                        </Button>
                        <Button type="submit" size="lg" isLoading={busy} showTextWhileLoading>
                            Apply
                        </Button>
                    </>
                }
            >
                {needsEvent && (
                    <Select
                        label="Event"
                        items={events.map((e) => ({ id: e.id, label: e.name }))}
                        value={value.eventId}
                        onChange={(v) => setValue({ ...value, eventId: String(v) })}
                    >
                        {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                    </Select>
                )}
                {action === "set-rsvp" && (
                    <>
                        <Select
                            label="RSVP"
                            items={[
                                { id: "attending", label: "Attending" },
                                { id: "declined", label: "Declined" },
                                { id: "pending", label: "Awaiting reply" },
                            ]}
                            value={value.status}
                            onChange={(v) => setValue({ ...value, status: String(v) })}
                        >
                            {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                        </Select>
                        <Select
                            label="Where did this reply come from?"
                            items={[
                                { id: "portal", label: "Told us directly" },
                                { id: "sayido", label: "Say I Do" },
                            ]}
                            value={value.source ?? "portal"}
                            onChange={(v) => setValue({ ...value, source: String(v) })}
                        >
                            {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                        </Select>
                    </>
                )}
                {action === "set-household" && (
                    <Select
                        label="Household"
                        items={[{ id: "none", label: "No household" }, ...households.map((h) => ({ id: h.id, label: h.name }))]}
                        value={value.householdId}
                        onChange={(v) => setValue({ ...value, householdId: String(v) })}
                    >
                        {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                    </Select>
                )}
                {action === "set-side" && (
                    <Select
                        label="Side"
                        items={(["partner_one", "partner_two", "shared"] as Side[]).map((s) => ({ id: s, label: sideLabel(s) }))}
                        value={value.side}
                        onChange={(v) => setValue({ ...value, side: String(v) })}
                    >
                        {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                    </Select>
                )}
                {action === "set-group" && (
                    <Input label="Group" placeholder="Leave empty to clear" value={value.groupName} onChange={(v) => setValue({ ...value, groupName: v })} />
                )}
                {(action === "add-tag" || action === "remove-tag") && (
                    <Input label="Tag" isRequired value={value.tag} onChange={(v) => setValue({ ...value, tag: v })} />
                )}
            </PortalDialog>
        </>
    );
};
