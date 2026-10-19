// Quick capture from Today: a task (Tasks' own Quick Add, which also picks a project), a note into
// Knowledge (its own capture: the Inbox or today's daily note), an appointment (Calendar's own event
// API), or text for Daly Intelligence to sort into suggestions you approve. Each goes through its
// application's API and permissions: there's no separate capture store, and everything but the last
// works with AI switched off.
import { useState } from "react";
import { BookOpen01, Calendar, CheckDone01, ChevronDown, Lightning01, Stars02 } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { Dropdown } from "@/components/base/dropdown/dropdown";
import { Input } from "@/components/base/input/input";
import { Select } from "@/components/base/select/select";
import { TextArea } from "@/components/base/textarea/textarea";
import { calendarApi, clientId } from "@/portal/calendar/api";
import { DateField } from "@/portal/components/date-field";
import { PortalDialog } from "@/portal/components/dialog";
import { useToast } from "@/portal/components/toast";
import { intelligenceApi } from "@/portal/intelligence/api";
import { QuickCapture as KnowledgeCapture } from "@/portal/knowledge/quick-capture";
import { errorMessage } from "@/portal/lib/api";
import { requestQuickAdd } from "@/portal/tasks/quick-add-events";
import type { KnowledgeSpace } from "@/shared/knowledge/types";
import type { TodayDashboard } from "@/shared/today/types";

type Kind = "note" | "appointment" | "ai" | null;

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

const AiCaptureForm = ({ onClose }: { onClose: () => void }) => {
    const toast = useToast();
    const [text, setText] = useState("");
    const [busy, setBusy] = useState(false);
    const save = async () => {
        if (!text.trim()) return;
        setBusy(true);
        try {
            await intelligenceApi.capture({ source: "text", text: text.trim(), requestKey: clientId() });
            toast.success("Sent to Daly Intelligence", "Its suggestions wait for your approval in Intelligence → Suggestions.");
            onClose();
        } catch (error) {
            toast.error("Couldn't send that", `${errorMessage(error)} You can still add it as a task or a note.`);
        } finally {
            setBusy(false);
        }
    };
    return (
        <PortalDialog
            isOpen
            onOpenChange={(o) => !o && onClose()}
            title="Capture for Intelligence to sort"
            description="Daly Intelligence suggests tasks, notes and decisions from what you write. Nothing is created until you approve each suggestion."
            icon={Stars02}
            size="lg"
            onSubmit={(e) => {
                e.preventDefault();
                void save();
            }}
            footer={
                <>
                    <Button color="secondary" size="lg" onClick={onClose} isDisabled={busy}>
                        Cancel
                    </Button>
                    <Button type="submit" size="lg" isLoading={busy} isDisabled={!text.trim()} showTextWhileLoading>
                        Send
                    </Button>
                </>
            }
        >
            <TextArea label="What's on your mind" value={text} onChange={setText} rows={6} maxLength={20000} autoFocus />
        </PortalDialog>
    );
};

export const QuickCaptureMenu = ({ data, spaces, onChanged }: { data: TodayDashboard; spaces: KnowledgeSpace[]; onChanged: () => void }) => {
    const [kind, setKind] = useState<Kind>(null);
    const personal = spaces.find((s) => s.kind === "personal") ?? spaces[0];
    return (
        <>
            <Dropdown.Root>
                <Button size="md" iconLeading={Lightning01} iconTrailing={ChevronDown}>
                    Quick capture
                </Button>
                <Dropdown.Popover className="w-64">
                    <Dropdown.Menu
                        aria-label="Quick capture"
                        onAction={(key) => {
                            if (key === "task") requestQuickAdd();
                            else setKind(key as Kind);
                        }}
                    >
                        <Dropdown.Item id="task" icon={CheckDone01} label="Task" addon="Q" />
                        {personal && <Dropdown.Item id="note" icon={BookOpen01} label="Note to Knowledge" />}
                        <Dropdown.Item id="appointment" icon={Calendar} label="Appointment" />
                        {data.canUseIntelligence && <Dropdown.Item id="ai" icon={Stars02} label="Capture for AI to sort" />}
                    </Dropdown.Menu>
                </Dropdown.Popover>
            </Dropdown.Root>
            {kind === "note" && personal && (
                <PortalDialog
                    isOpen
                    onOpenChange={(o) => !o && setKind(null)}
                    title="Capture a note"
                    description="To your Knowledge Inbox, or added to today's daily note."
                    icon={BookOpen01}
                    size="lg"
                >
                    <KnowledgeCapture
                        bare
                        autoFocus
                        space={personal}
                        spaces={spaces}
                        onCaptured={() => {
                            setKind(null);
                        }}
                    />
                </PortalDialog>
            )}
            {kind === "appointment" && <AppointmentForm calendars={data.calendars} date={data.date} onClose={() => setKind(null)} onCreated={onChanged} />}
            {kind === "ai" && <AiCaptureForm onClose={() => setKind(null)} />}
        </>
    );
};
