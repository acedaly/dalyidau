// Adding an appointment from Today, through Calendar's own event API and permissions: there's no
// separate capture store.
import { useState } from "react";
import { Calendar, Plus } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { Select } from "@/components/base/select/select";
import { calendarApi, clientId } from "@/portal/calendar/api";
import { DateField } from "@/portal/components/date-field";
import { PortalDialog } from "@/portal/components/dialog";
import { useToast } from "@/portal/components/toast";
import { errorMessage } from "@/portal/lib/api";
import type { TodayDashboard } from "@/shared/today/types";

const AppointmentForm = ({
    calendars,
    date,
    onClose,
    onCreated,
}: {
    calendars: TodayDashboard["calendars"];
    date: string;
    onClose: () => void;
    onCreated: () => void;
}) => {
    const toast = useToast();
    const writable = calendars.filter((c) => c.canWrite);
    const [title, setTitle] = useState("");
    const [calendarId, setCalendarId] = useState(writable.find((c) => c.isDefault)?.id ?? writable[0]?.id ?? "");
    const [day, setDay] = useState(date);
    const [start, setStart] = useState("09:00");
    const [end, setEnd] = useState("10:00");
    const [busy, setBusy] = useState(false);
    const invalid = !title.trim() || !calendarId || end <= start;
    const save = async () => {
        if (invalid) return;
        setBusy(true);
        try {
            await calendarApi.createEvent({
                calendarId,
                title: title.trim(),
                allDay: false,
                startDate: day,
                endDate: day,
                startTime: start,
                endTime: end,
                clientId: clientId(),
            });
            toast.success("Appointment added", title.trim());
            onClose();
            onCreated();
        } catch (error) {
            toast.error("Couldn't add the appointment", errorMessage(error));
        } finally {
            setBusy(false);
        }
    };
    return (
        <PortalDialog
            isOpen
            onOpenChange={(o) => !o && onClose()}
            title="Add an appointment"
            description="Added to your calendar. It counts as busy time on Today."
            icon={Calendar}
            size="md"
            onSubmit={(e) => {
                e.preventDefault();
                void save();
            }}
            footer={
                <>
                    <Button color="secondary" size="lg" onClick={onClose} isDisabled={busy}>
                        Cancel
                    </Button>
                    <Button type="submit" size="lg" isLoading={busy} isDisabled={invalid} showTextWhileLoading>
                        Add
                    </Button>
                </>
            }
        >
            <Input label="What" isRequired value={title} onChange={setTitle} autoFocus placeholder="Dentist" />
            {writable.length > 1 && (
                <Select
                    label="Calendar"
                    value={calendarId}
                    onChange={(k) => k && setCalendarId(String(k))}
                    items={writable.map((c) => ({ id: c.id, label: c.name }))}
                >
                    {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                </Select>
            )}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <DateField label="Date" value={day} onChange={(v) => v && setDay(v)} />
                <Input label="Start" type="time" value={start} onChange={(v) => v && setStart(v)} />
                <Input
                    label="End"
                    type="time"
                    value={end}
                    onChange={(v) => v && setEnd(v)}
                    isInvalid={end <= start}
                    hint={end <= start ? "End after it starts" : undefined}
                />
            </div>
        </PortalDialog>
    );
};

/** "Add appointment" from Today's header: the event goes into the person's calendar, through Calendar's own API. */
export const AddAppointment = ({ data, onChanged }: { data: Pick<TodayDashboard, "calendars" | "date">; onChanged: () => void }) => {
    const [open, setOpen] = useState(false);
    if (!data.calendars.some((c) => c.canWrite)) return null;
    return (
        <>
            <Button size="md" iconLeading={Plus} onClick={() => setOpen(true)}>
                Add appointment
            </Button>
            {open && <AppointmentForm calendars={data.calendars} date={data.date} onClose={() => setOpen(false)} onCreated={onChanged} />}
        </>
    );
};
