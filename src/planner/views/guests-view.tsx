// Guests: find anyone, see where their RSVP stands, record a reply by event, and add a guest.
// Everything else about a guest (households, invitations, imports) stays in the wedding admin.
import { useMemo, useState } from "react";
import { Check, Mail01, Phone, SearchLg, UserPlus01, Users01 } from "@untitledui/icons";
import { ButtonGroup, ButtonGroupItem } from "@/components/base/button-group/button-group";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { RecordPanel } from "@/portal/components/record-panel";
import { useToast } from "@/portal/components/toast";
import { ApiError, errorMessage } from "@/portal/lib/api";
import { pluralise } from "@/portal/lib/format";
import { usePortal } from "@/portal/portal-context";
import type { Guest, RsvpStatus, WeddingEvent } from "@/shared/portal/types";
import { EmptyRow, LoadError, LoadingRows, PageTitle, RSVP_LABELS, Row, RowList, RsvpBadge, Section } from "../components";
import { EVENTS, GUESTS, change, useApi } from "../data";
import { useNavigation } from "../navigation";

type Filter = "all" | "attending" | "pending" | "declined";
const FILTERS: { id: Filter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "attending", label: "Coming" },
    { id: "pending", label: "Awaiting" },
    { id: "declined", label: "Declined" },
];

const fullName = (guest: Pick<Guest, "firstName" | "lastName">) => `${guest.firstName} ${guest.lastName}`.trim();

const Detail = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div className="flex flex-col gap-0.5">
        <dt className="text-xs font-medium text-tertiary">{label}</dt>
        <dd className="text-sm text-primary">{children}</dd>
    </div>
);

const GuestSheet = ({ guest, events, onClose }: { guest: Guest; events: WeddingEvent[]; onClose: () => void }) => {
    const { can } = usePortal();
    const { portalUrl } = useNavigation();
    const toast = useToast();
    const [statuses, setStatuses] = useState(() => Object.fromEntries(guest.events.map((e) => [e.eventId, e.status])) as Record<string, RsvpStatus>);
    const [busy, setBusy] = useState<string | null>(null);
    const canRecord = can("wedding.rsvp.edit");
    const invited = events.filter((event) => guest.events.some((e) => e.eventId === event.id));

    const record = async (eventId: string, status: RsvpStatus) => {
        const before = statuses[eventId];
        if (before === status) return;
        setBusy(eventId);
        setStatuses((current) => ({ ...current, [eventId]: status }));
        try {
            await change("PUT", `${GUESTS}/${guest.id}/rsvp`, { eventId, status, source: "portal" }, [GUESTS]);
            toast.success(`${guest.firstName}: ${RSVP_LABELS[status].toLowerCase()}`, events.find((e) => e.id === eventId)?.name);
        } catch (e) {
            setStatuses((current) => ({ ...current, [eventId]: before }));
            toast.error("Couldn't record the RSVP", errorMessage(e));
        } finally {
            setBusy(null);
        }
    };

    return (
        <RecordPanel
            isOpen
            onOpenChange={(open) => !open && onClose()}
            title={fullName(guest)}
            description={guest.householdName ?? "No household"}
            footer={
                <Button color="secondary" href={`${portalUrl}/guests`}>
                    Edit in the admin
                </Button>
            }
        >
            <div className="flex flex-col gap-6">
                {(guest.phone || guest.email) && (
                    <div className="flex flex-wrap gap-2">
                        {guest.phone && (
                            <Button color="secondary" size="sm" iconLeading={Phone} href={`tel:${guest.phone}`}>
                                Call
                            </Button>
                        )}
                        {guest.email && (
                            <Button color="secondary" size="sm" iconLeading={Mail01} href={`mailto:${guest.email}`}>
                                Email
                            </Button>
                        )}
                    </div>
                )}

                <section aria-labelledby="guest-rsvp" className="flex flex-col gap-3">
                    <h3 id="guest-rsvp" className="text-sm font-semibold text-primary">
                        RSVP
                    </h3>
                    {invited.length === 0 ? (
                        <p className="text-sm text-tertiary">Not invited to any event yet.</p>
                    ) : (
                        invited.map((event) => (
                            <div key={event.id} className="flex flex-col gap-2">
                                <span className="text-sm text-secondary">{event.name}</span>
                                <ButtonGroup
                                    aria-label={`${event.name} RSVP`}
                                    size="sm"
                                    selectionMode="single"
                                    disallowEmptySelection
                                    selectedKeys={new Set([statuses[event.id] ?? "pending"])}
                                    onSelectionChange={(keys) => {
                                        const [status] = [...keys] as RsvpStatus[];
                                        if (status) void record(event.id, status);
                                    }}
                                    isDisabled={!canRecord || busy === event.id}
                                    className="flex w-full"
                                >
                                    {(["attending", "pending", "declined"] as const).map((status) => (
                                        <ButtonGroupItem
                                            key={status}
                                            id={status}
                                            iconLeading={statuses[event.id] === status ? Check : undefined}
                                            className="flex-1 justify-center"
                                        >
                                            {RSVP_LABELS[status]}
                                        </ButtonGroupItem>
                                    ))}
                                </ButtonGroup>
                            </div>
                        ))
                    )}
                </section>

                <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    {guest.email && <Detail label="Email">{guest.email}</Detail>}
                    {guest.phone && <Detail label="Mobile">{guest.phone}</Detail>}
                    {guest.dietary && <Detail label="Dietary">{guest.dietary}</Detail>}
                    {guest.allergies && <Detail label="Allergies">{guest.allergies}</Detail>}
                    {guest.accessibility && <Detail label="Accessibility">{guest.accessibility}</Detail>}
                    {guest.notes && <Detail label="Notes">{guest.notes}</Detail>}
                </dl>
            </div>
        </RecordPanel>
    );
};

const AddGuestSheet = ({ onClose }: { onClose: () => void }) => {
    const toast = useToast();
    const [draft, setDraft] = useState({ firstName: "", lastName: "", email: "", phone: "" });
    const [error, setError] = useState<ApiError | null>(null);
    const [busy, setBusy] = useState(false);
    const set = (key: keyof typeof draft) => (value: string) => setDraft((current) => ({ ...current, [key]: value }));
    const save = async () => {
        setBusy(true);
        setError(null);
        try {
            await change("POST", GUESTS, { firstName: draft.firstName, lastName: draft.lastName, email: draft.email || null, phone: draft.phone || null }, [
                GUESTS,
            ]);
            toast.success("Guest added", fullName(draft));
            onClose();
        } catch (e) {
            if (e instanceof ApiError) setError(e);
            else toast.error("Couldn't add the guest", errorMessage(e));
        } finally {
            setBusy(false);
        }
    };
    return (
        <RecordPanel
            isOpen
            onOpenChange={(open) => !open && onClose()}
            title="Add a guest"
            description="Households and invitations are set up in the wedding admin."
            onSubmit={() => void save()}
            footer={
                <>
                    <Button color="secondary" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button type="submit" isLoading={busy}>
                        Add guest
                    </Button>
                </>
            }
        >
            <div className="flex flex-col gap-4">
                {error && !error.issues.length && <p className="text-sm text-error-primary">{error.message}</p>}
                <Input
                    label="First name"
                    isRequired
                    value={draft.firstName}
                    onChange={set("firstName")}
                    isInvalid={!!error?.issueFor("firstName")}
                    hint={error?.issueFor("firstName")}
                />
                <Input
                    label="Last name"
                    value={draft.lastName}
                    onChange={set("lastName")}
                    isInvalid={!!error?.issueFor("lastName")}
                    hint={error?.issueFor("lastName")}
                />
                <Input
                    label="Email"
                    type="email"
                    value={draft.email}
                    onChange={set("email")}
                    isInvalid={!!error?.issueFor("email")}
                    hint={error?.issueFor("email")}
                />
                <Input
                    label="Mobile"
                    type="tel"
                    value={draft.phone}
                    onChange={set("phone")}
                    isInvalid={!!error?.issueFor("phone")}
                    hint={error?.issueFor("phone") ?? "Australian mobile, e.g. 0412 345 678."}
                />
            </div>
        </RecordPanel>
    );
};

export const GuestsView = () => {
    const { can } = usePortal();
    const guests = useApi<{ guests: Guest[] }>(GUESTS);
    const events = useApi<{ items: WeddingEvent[] }>(EVENTS);
    const [query, setQuery] = useState("");
    const [filter, setFilter] = useState<Filter>("all");
    const [openId, setOpenId] = useState<string | null>(null);
    const [adding, setAdding] = useState(false);

    const list = guests.data?.guests ?? [];
    const counts = useMemo(() => {
        const by = { all: list.length, attending: 0, pending: 0, declined: 0 };
        for (const guest of list) if (guest.rsvp in by) by[guest.rsvp as Exclude<Filter, "all">] += 1;
        return by;
    }, [list]);
    const shown = useMemo(() => {
        const q = query.trim().toLowerCase();
        return list.filter(
            (guest) =>
                (filter === "all" || guest.rsvp === filter) &&
                (!q || `${fullName(guest)} ${guest.householdName ?? ""} ${guest.email ?? ""}`.toLowerCase().includes(q)),
        );
    }, [list, query, filter]);
    const open = list.find((guest) => guest.id === openId) ?? null;

    return (
        <>
            <PageTitle
                title="Guests"
                subtitle={guests.data ? pluralise(list.length, "guest") : undefined}
                actions={
                    can("wedding.guests.edit") && (
                        <Button size="sm" iconLeading={UserPlus01} onClick={() => setAdding(true)}>
                            Add
                        </Button>
                    )
                }
            />

            <div className="flex flex-col gap-3">
                <Input aria-label="Search guests" placeholder="Search guests" icon={SearchLg} value={query} onChange={setQuery} />
                <ButtonGroup
                    aria-label="Show"
                    size="sm"
                    selectionMode="single"
                    disallowEmptySelection
                    selectedKeys={new Set([filter])}
                    onSelectionChange={(keys) => setFilter(([...keys][0] as Filter) ?? "all")}
                    className="flex w-full"
                >
                    {FILTERS.map((f) => (
                        // Four to a row on a phone: equal widths, slightly smaller text below sm.
                        <ButtonGroupItem key={f.id} id={f.id} className="min-w-0 flex-1 justify-center gap-1 px-1.5 text-xs sm:px-3 sm:text-sm">
                            {f.label}
                            <span className="text-quaternary tabular-nums">{counts[f.id]}</span>
                        </ButtonGroupItem>
                    ))}
                </ButtonGroup>
            </div>

            <Section flush>
                {guests.error && !guests.data ? (
                    <LoadError error={guests.error} onRetry={guests.reload} />
                ) : !guests.data ? (
                    <LoadingRows rows={6} />
                ) : shown.length === 0 ? (
                    <EmptyRow icon={Users01}>{list.length ? "No guests match." : "No guests yet."}</EmptyRow>
                ) : (
                    <RowList label="Guests">
                        {shown.map((guest) => (
                            <Row
                                key={guest.id}
                                title={
                                    <>
                                        {fullName(guest)}
                                        {guest.isPlusOne && <span className="ml-1.5 text-xs font-normal text-tertiary">(plus one)</span>}
                                    </>
                                }
                                detail={guest.householdName ?? guest.email ?? undefined}
                                trailing={<RsvpBadge status={guest.rsvp} />}
                                onPress={() => setOpenId(guest.id)}
                            />
                        ))}
                    </RowList>
                )}
            </Section>

            {open && <GuestSheet key={open.id} guest={open} events={events.data?.items ?? []} onClose={() => setOpenId(null)} />}
            {adding && <AddGuestSheet onClose={() => setAdding(false)} />}
        </>
    );
};
