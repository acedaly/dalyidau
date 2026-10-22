// Journeys: one of your calendar events linked to one of your watch areas (a road corridor for the
// trip, or the destination), so Today shows what concerns it around its dates. Nothing in the
// event changes; the link holds only the two ids, and the event is read through Calendar each time.
import { useEffect, useState } from "react";
import { CalendarDate, Plus, XClose } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { NativeSelect } from "@/components/base/select/select-native";
import { calendarApi } from "@/portal/calendar/api";
import { Card } from "@/portal/components/card";
import { PortalDialog } from "@/portal/components/dialog";
import { FormError } from "@/portal/components/form";
import { useToast } from "@/portal/components/toast";
import { errorMessage } from "@/portal/lib/api";
import { formatDateTime } from "@/portal/lib/format";
import type { EventOccurrence } from "@/shared/calendar/types";
import type { WatchArea } from "@/shared/centre/types";
import { type EventLinkView, centreApi } from "./centre-api";
import { TZ } from "./shared";

const isoDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export const JourneysCard = ({ watches }: { watches: WatchArea[] }) => {
    const toast = useToast();
    const [links, setLinks] = useState<EventLinkView[] | null>(null);
    const [adding, setAdding] = useState(false);
    const [events, setEvents] = useState<EventOccurrence[]>([]);
    const [eventId, setEventId] = useState("");
    const [watchId, setWatchId] = useState(watches[0]?.id ?? "");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        centreApi
            .eventLinks()
            .then((r) => setLinks(r.links))
            .catch(() => setLinks([]));
    }, []);

    const open = async () => {
        setAdding(true);
        setError(null);
        try {
            const today = new Date();
            const { occurrences } = await calendarApi.window(isoDate(today), isoDate(new Date(today.getTime() + 60 * 86_400_000)));
            const own = occurrences.filter((o) => !o.busyOnly && o.status !== "cancelled");
            const unique = own.filter((o, i) => own.findIndex((x) => x.eventId === o.eventId) === i);
            setEvents(unique);
            setEventId(unique[0]?.eventId ?? "");
        } catch (e) {
            setError(errorMessage(e));
        }
    };

    const link = async () => {
        if (!eventId || !watchId) return;
        setBusy(true);
        setError(null);
        try {
            setLinks((await centreApi.linkEvent(eventId, watchId)).links);
            toast.success("Linked", "Today will show what concerns this watch area around the event.");
            setAdding(false);
        } catch (e) {
            setError(errorMessage(e));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Card
            title="Journeys and events"
            icon={CalendarDate}
            action={
                <Button size="sm" color="secondary" iconLeading={Plus} onClick={() => void open()} isDisabled={!watches.length}>
                    Link an event
                </Button>
            }
        >
            {links === null ? (
                <p className="px-4 py-4 text-sm text-tertiary sm:px-5">Loading…</p>
            ) : links.length ? (
                <ul className="divide-y divide-secondary">
                    {links.map((l) => (
                        <li key={l.id} className="flex items-center justify-between gap-3 px-4 py-2.5 sm:px-5">
                            <span className="flex min-w-0 flex-col">
                                <span className="text-sm font-medium text-primary">{l.title ?? "An event you can no longer see"}</span>
                                <span className="text-xs text-tertiary">
                                    {l.watchName}
                                    {l.start ? ` · ${l.start.length > 10 ? formatDateTime(l.start, TZ) : l.start}` : ""}
                                </span>
                            </span>
                            <ButtonUtility
                                size="sm"
                                color="tertiary"
                                icon={XClose}
                                tooltip="Unlink"
                                onClick={() =>
                                    void centreApi
                                        .unlinkEvent(l.id)
                                        .then(() => setLinks((list) => (list ?? []).filter((x) => x.id !== l.id)))
                                        .catch((e: unknown) => toast.error("Couldn't unlink it", errorMessage(e)))
                                }
                            />
                        </li>
                    ))}
                </ul>
            ) : (
                <p className="px-4 py-4 text-sm text-tertiary sm:px-5">
                    Link a trip or an outing in your calendar to a road corridor or a destination, and Today shows what concerns it in the days before.
                </p>
            )}
            <PortalDialog
                isOpen={adding}
                onOpenChange={setAdding}
                title="Link an event to a watch area"
                description="Only the link is saved. The event itself doesn't change, and only you see the link."
                icon={CalendarDate}
                onSubmit={() => void link()}
                footer={
                    <>
                        <Button size="md" color="secondary" onClick={() => setAdding(false)}>
                            Cancel
                        </Button>
                        <Button size="md" type="submit" isLoading={busy} showTextWhileLoading isDisabled={!eventId}>
                            Link
                        </Button>
                    </>
                }
            >
                <FormError message={error} />
                <NativeSelect
                    label="Event (next 60 days)"
                    value={eventId}
                    onChange={(e) => setEventId(e.target.value)}
                    options={
                        events.length
                            ? events.map((o) => ({ label: `${o.title} · ${o.startDate}${o.startTime ? ` ${o.startTime}` : ""}`, value: o.eventId }))
                            : [{ label: "No upcoming events", value: "" }]
                    }
                />
                <NativeSelect
                    label="Watch area"
                    value={watchId}
                    onChange={(e) => setWatchId(e.target.value)}
                    options={watches.map((w) => ({ label: w.name, value: w.id }))}
                />
            </PortalDialog>
        </Card>
    );
};
