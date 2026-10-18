// The event panel: create, view and edit one event. A slide-over in the layout of Untitled UI PRO's
// "create-event-menu", built from the portal's RecordPanel and the PRO form components.
//
// Read-only events (subscribed calendars, calendars you only view) show their details, your own
// reminders and links. Someone else's private event never reaches this panel: it's "Busy" in the
// views and can't be opened. Changing a repeating event asks whether it's this occurrence, this and
// the following ones, or the whole series.
import { useCallback, useEffect, useState } from "react";
import { CheckDone01, Link01, Plus, SearchLg, Trash01, X } from "@untitledui/icons";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Checkbox } from "@/components/base/checkbox/checkbox";
import { Input } from "@/components/base/input/input";
import { Select } from "@/components/base/select/select";
import { TextArea } from "@/components/base/textarea/textarea";
import { Toggle } from "@/components/base/toggle/toggle";
import { DateField } from "@/portal/components/date-field";
import { ConfirmDialog, PortalDialog } from "@/portal/components/dialog";
import { FormError } from "@/portal/components/form";
import { RecordPanel } from "@/portal/components/record-panel";
import { useToast } from "@/portal/components/toast";
import { ApiError, api, errorMessage } from "@/portal/lib/api";
import { type RepeatInput, WEEKDAYS, type Weekday, describeRepeat } from "@/shared/calendar/recurrence";
import { addWallMinutes, dayLabel, isoWeekday, timeLabel, wallMinutes } from "@/shared/calendar/time";
import {
    CATEGORY_LABELS,
    type CalendarInfo,
    type CalendarMember,
    EVENT_CATEGORIES,
    type EventCategory,
    type EventDetail,
    type EventLink,
    type EventOccurrence,
    VISIBILITIES,
    VISIBILITY_LABELS,
} from "@/shared/calendar/types";
import { type EditScope, type EventFields, calendarApi, clientId } from "./api";
import { ColorDot, REMINDER_CHOICES, reminderLabel } from "./shared";

export type PanelTarget = { kind: "new"; date: string; time: string | null } | { kind: "open"; eventId: string; occurrence: EventOccurrence | null } | null;

type RepeatChoice = "none" | "daily" | "weekdays" | "weekly" | "fortnightly" | "monthly-day" | "monthly-weekday" | "yearly" | "custom";

const REPEAT_LABELS: Record<RepeatChoice, string> = {
    none: "Doesn't repeat",
    daily: "Every day",
    weekdays: "Every weekday (Mon–Fri)",
    weekly: "Every week",
    fortnightly: "Every fortnight",
    "monthly-day": "Every month on the same date",
    "monthly-weekday": "Every month on the same weekday",
    yearly: "Every year",
    custom: "Custom repeat (from another calendar)",
};

interface Draft {
    calendarId: string;
    title: string;
    allDay: boolean;
    startDate: string;
    startTime: string;
    endDate: string;
    endTime: string;
    location: string;
    description: string;
    category: EventCategory;
    visibility: EventDetail["visibility"];
    showAs: "busy" | "free";
    tentative: boolean;
    repeat: RepeatChoice;
    weekdays: Weekday[];
    ends: "never" | "on" | "after";
    until: string | null;
    count: string;
    who: string;
    responsible: string | null;
    reminders: number[];
}

const weekdayOf = (date: string): Weekday => WEEKDAYS[isoWeekday(date) - 1];

function repeatFrom(detail: EventDetail): Pick<Draft, "repeat" | "weekdays" | "ends" | "until" | "count"> {
    const r = detail.repeat;
    const base = { weekdays: [weekdayOf(detail.startDate)], ends: "never" as const, until: null, count: "10" };
    if (!detail.rrule) return { ...base, repeat: "none" };
    if (!r) return { ...base, repeat: "custom" };
    const ends = r.count
        ? { ends: "after" as const, count: String(r.count), until: null }
        : r.until
          ? { ends: "on" as const, until: r.until, count: "10" }
          : { ends: "never" as const, until: null, count: "10" };
    let repeat: RepeatChoice = "custom";
    if (r.freq === "daily" && r.interval === 1) repeat = "daily";
    else if (r.freq === "weekly" && r.interval === 1 && r.byDay?.length === 5 && ["MO", "TU", "WE", "TH", "FR"].every((d) => r.byDay?.includes(d as Weekday)))
        repeat = "weekdays";
    else if (r.freq === "weekly" && r.interval === 1) repeat = "weekly";
    else if (r.freq === "weekly" && r.interval === 2) repeat = "fortnightly";
    else if (r.freq === "monthly" && r.interval === 1) repeat = r.monthly === "weekday" ? "monthly-weekday" : "monthly-day";
    else if (r.freq === "yearly" && r.interval === 1) repeat = "yearly";
    return { ...ends, repeat, weekdays: r.byDay?.length ? r.byDay : base.weekdays };
}

function repeatInput(d: Draft): RepeatInput | null | undefined {
    if (d.repeat === "custom") return undefined;
    if (d.repeat === "none") return null;
    const end = d.ends === "after" ? { count: Math.max(1, Number(d.count) || 1) } : d.ends === "on" && d.until ? { until: d.until } : {};
    switch (d.repeat) {
        case "daily":
            return { freq: "daily", interval: 1, ...end };
        case "weekdays":
            return { freq: "weekly", interval: 1, byDay: ["MO", "TU", "WE", "TH", "FR"], ...end };
        case "weekly":
            return { freq: "weekly", interval: 1, byDay: d.weekdays.length ? d.weekdays : [weekdayOf(d.startDate)], ...end };
        case "fortnightly":
            return { freq: "weekly", interval: 2, byDay: d.weekdays.length ? d.weekdays : [weekdayOf(d.startDate)], ...end };
        case "monthly-day":
            return { freq: "monthly", interval: 1, monthly: "day", ...end };
        case "monthly-weekday":
            return { freq: "monthly", interval: 1, monthly: "weekday", ...end };
        case "yearly":
            return { freq: "yearly", interval: 1, ...end };
    }
}

const emptyDraft = (calendarId: string, date: string, time: string | null, defaultReminder: number | null): Draft => {
    const start = time ?? "09:00";
    const end = addWallMinutes(date, start, 60);
    return {
        calendarId,
        title: "",
        allDay: time === null,
        startDate: date,
        startTime: start,
        endDate: time === null ? date : end.date,
        endTime: end.time,
        location: "",
        description: "",
        category: "general",
        visibility: "default",
        showAs: "busy",
        tentative: false,
        repeat: "none",
        weekdays: [weekdayOf(date)],
        ends: "never",
        until: null,
        count: "10",
        who: "",
        responsible: null,
        reminders: defaultReminder === null ? [] : [defaultReminder],
    };
};

const fromDetail = (e: EventDetail): Draft => ({
    calendarId: e.calendarId,
    title: e.title,
    allDay: e.allDay,
    startDate: e.startDate,
    startTime: e.startTime ?? "09:00",
    endDate: e.endDate,
    endTime: e.endTime ?? "10:00",
    location: e.location ?? "",
    description: e.description ?? "",
    category: e.category,
    visibility: e.visibility,
    showAs: e.showAs,
    tentative: e.status === "tentative",
    ...repeatFrom(e),
    who: e.people?.who.join(", ") ?? "",
    responsible: e.people?.responsible ?? null,
    reminders: e.reminders.map((r) => r.minutesBefore),
});

const FAMILY_CATEGORIES: EventCategory[] = ["care", "pickup", "dropoff", "school", "family"];

const LinkSearch = ({ kind, onPick }: { kind: "task" | "knowledge"; onPick: (id: string) => void }) => {
    const [query, setQuery] = useState("");
    const [results, setResults] = useState<{ id: string; title: string; detail: string }[]>([]);
    const [busy, setBusy] = useState(false);
    const search = async () => {
        if (!query.trim()) return;
        setBusy(true);
        try {
            if (kind === "task") {
                const r = await api<{ tasks: { id: string; title: string; dueDate: string | null }[] }>(
                    "GET",
                    `/api/portal/tasks/search?q=${encodeURIComponent(query)}`,
                );
                setResults(r.tasks.slice(0, 8).map((t) => ({ id: t.id, title: t.title, detail: t.dueDate ? `Due ${dayLabel(t.dueDate)}` : "No date" })));
            } else {
                const r = await api<{ hits: { object: { id: string; title: string; typeId: string } }[] }>(
                    "GET",
                    `/api/portal/knowledge/search?q=${encodeURIComponent(query)}&limit=8`,
                );
                setResults(r.hits.map((h) => ({ id: h.object.id, title: h.object.title || "Untitled", detail: "Knowledge" })));
            }
        } catch {
            setResults([]);
        } finally {
            setBusy(false);
        }
    };
    return (
        <div className="flex flex-col gap-2">
            <div className="flex items-end gap-2">
                <Input
                    size="sm"
                    aria-label={kind === "task" ? "Search your tasks" : "Search Knowledge"}
                    placeholder={kind === "task" ? "Search your tasks" : "Search Knowledge"}
                    icon={SearchLg}
                    value={query}
                    onChange={setQuery}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") {
                            e.preventDefault();
                            void search();
                        } else e.continuePropagation();
                    }}
                    className="flex-1"
                />
                <Button size="sm" color="secondary" onClick={() => void search()} isLoading={busy}>
                    Search
                </Button>
            </div>
            {results.length > 0 && (
                <ul className="flex flex-col divide-y divide-secondary rounded-lg ring-1 ring-secondary ring-inset">
                    {results.map((r) => (
                        <li key={r.id} className="flex items-center justify-between gap-2 px-3 py-2">
                            <span className="min-w-0">
                                <span className="block truncate text-sm font-medium text-primary">{r.title}</span>
                                <span className="text-xs text-tertiary">{r.detail}</span>
                            </span>
                            <Button size="sm" color="link-color" onClick={() => onPick(r.id)}>
                                Link
                            </Button>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
};

const LinksSection = ({
    event,
    canLink,
    canUseTasks,
    canUseKnowledge,
    occurrenceDate,
    occurrenceTime,
    onLinks,
}: {
    event: EventDetail;
    canLink: boolean;
    canUseTasks: boolean;
    canUseKnowledge: boolean;
    occurrenceDate: string;
    occurrenceTime: string | null;
    onLinks: (links: EventLink[]) => void;
}) => {
    const toast = useToast();
    const [adding, setAdding] = useState<"task" | "knowledge" | null>(null);
    const [creating, setCreating] = useState(false);
    const link = async (kind: "task" | "knowledge", id: string) => {
        try {
            onLinks((await calendarApi.addLink(event.id, kind, id)).links);
            setAdding(null);
        } catch (error) {
            toast.error("Couldn't link that", errorMessage(error));
        }
    };
    const unlink = async (linkId: string) => {
        try {
            onLinks((await calendarApi.removeLink(event.id, linkId)).links);
        } catch (error) {
            toast.error("Couldn't remove the link", errorMessage(error));
        }
    };
    const createTask = async () => {
        setCreating(true);
        try {
            const result = await calendarApi.createTask(event.id, { dueDate: occurrenceDate, dueTime: occurrenceTime, clientId: clientId() });
            onLinks(result.links);
            toast.success("Task created", result.task.title);
        } catch (error) {
            toast.error("Couldn't create the task", errorMessage(error));
        } finally {
            setCreating(false);
        }
    };
    return (
        <section className="flex flex-col gap-3">
            <h3 className="text-sm font-semibold text-secondary">Linked tasks and notes</h3>
            {event.links.length ? (
                <ul className="flex flex-col gap-2">
                    {event.links.map((l) => (
                        <li key={l.id} className="bg-secondary_subtle flex items-center justify-between gap-2 rounded-lg px-3 py-2">
                            {l.available ? (
                                <a
                                    href={
                                        l.kind === "task"
                                            ? `/portal/tasks/t/${l.targetId}`
                                            : l.kind === "project"
                                              ? `/portal/tasks/p/${l.targetId}`
                                              : `/portal/knowledge/o/${l.targetId}`
                                    }
                                    className="flex min-w-0 items-center gap-2 text-sm font-medium text-primary hover:underline"
                                >
                                    {l.kind === "knowledge" ? (
                                        <Link01 aria-hidden="true" className="size-4 shrink-0 text-fg-quaternary" />
                                    ) : (
                                        <CheckDone01 aria-hidden="true" className="size-4 shrink-0 text-fg-quaternary" />
                                    )}
                                    <span className="truncate">{l.title}</span>
                                    {l.kind === "task" && l.status === "completed" && (
                                        <Badge size="sm" color="success">
                                            Done
                                        </Badge>
                                    )}
                                    {l.kind === "task" && l.dueDate && <span className="shrink-0 text-xs text-tertiary">Due {dayLabel(l.dueDate)}</span>}
                                </a>
                            ) : (
                                <span className="text-sm text-tertiary">A {l.kind === "knowledge" ? "note" : l.kind} you can't open</span>
                            )}
                            {canLink && <ButtonUtility size="xs" color="tertiary" icon={X} tooltip="Remove link" onClick={() => void unlink(l.id)} />}
                        </li>
                    ))}
                </ul>
            ) : (
                <p className="text-sm text-tertiary">None yet. A task's due date shows in the calendar from Tasks itself, so it never needs updating twice.</p>
            )}
            <div className="flex flex-wrap gap-2">
                {canUseTasks && (
                    <Button size="sm" color="secondary" iconLeading={Plus} isLoading={creating} showTextWhileLoading onClick={() => void createTask()}>
                        Create a task for this
                    </Button>
                )}
                {canLink && canUseTasks && (
                    <Button size="sm" color="tertiary" onClick={() => setAdding(adding === "task" ? null : "task")}>
                        Link a task
                    </Button>
                )}
                {canLink && canUseKnowledge && (
                    <Button size="sm" color="tertiary" onClick={() => setAdding(adding === "knowledge" ? null : "knowledge")}>
                        Link a note
                    </Button>
                )}
            </div>
            {adding && <LinkSearch kind={adding} onPick={(id) => void link(adding, id)} />}
        </section>
    );
};

interface EventPanelProps {
    target: PanelTarget;
    onClose: () => void;
    onChanged: () => void;
    calendars: CalendarInfo[];
    timeZone: string;
    defaultReminder: number | null;
    canUseTasks: boolean;
    canUseKnowledge: boolean;
}

export const EventPanel = ({ target, onClose, onChanged, calendars, timeZone, defaultReminder, canUseTasks, canUseKnowledge }: EventPanelProps) => {
    const toast = useToast();
    const writable = calendars.filter((c) => c.source === "local" && (c.role === "owner" || c.role === "editor"));
    const defaultCalendar = writable.find((c) => c.isDefault)?.id ?? writable[0]?.id ?? "";
    const [detail, setDetail] = useState<EventDetail | null>(null);
    const [draft, setDraft] = useState<Draft | null>(null);
    const [error, setError] = useState<ApiError | null>(null);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [askScope, setAskScope] = useState<"save" | "delete" | null>(null);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [members, setMembers] = useState<CalendarMember[]>([]);
    const occurrence = target?.kind === "open" ? target.occurrence : null;

    useEffect(() => {
        setError(null);
        setDetail(null);
        if (!target) return setDraft(null);
        if (target.kind === "new") return setDraft(emptyDraft(defaultCalendar, target.date, target.time, defaultReminder));
        setLoading(true);
        calendarApi
            .event(target.eventId)
            .then(({ event }) => {
                setDetail(event);
                const d = fromDetail(event);
                // Opening one occurrence of a series shows that occurrence's own dates.
                if (target.occurrence && event.rrule && target.occurrence.key) {
                    const o = target.occurrence;
                    if (o.allDay) Object.assign(d, { startDate: o.startDate, endDate: o.endDate });
                    else if (!o.eventTimeZone) Object.assign(d, { startDate: o.startDate, endDate: o.endDate, startTime: o.startTime, endTime: o.endTime });
                    if (!o.busyOnly) d.title = o.title;
                }
                setDraft(d);
            })
            .catch((e) => setError(e instanceof ApiError ? e : new ApiError(0, "error", errorMessage(e))))
            .finally(() => setLoading(false));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [target]);

    const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => (d ? { ...d, [key]: value } : d));
    const calendarIdForMembers = draft?.calendarId;
    const familyFields = draft && FAMILY_CATEGORIES.includes(draft.category);
    useEffect(() => {
        if (!familyFields || !calendarIdForMembers) return;
        api<{ members: CalendarMember[] }>("GET", `/api/portal/calendar/calendars/${calendarIdForMembers}/members`)
            .then((r) => setMembers(r.members.filter((m) => m.role === "owner" || m.role === "editor")))
            .catch(() => setMembers([]));
    }, [familyFields, calendarIdForMembers]);

    const editable = target?.kind === "new" || !!detail?.canEdit;
    const isSeries = !!detail?.rrule;
    const calendar = calendars.find((c) => c.id === (draft?.calendarId ?? detail?.calendarId));

    const fields = useCallback((d: Draft): EventFields => {
        const who = d.who
            .split(",")
            .map((w) => w.trim())
            .filter(Boolean)
            .slice(0, 10);
        return {
            calendarId: d.calendarId,
            title: d.title.trim(),
            allDay: d.allDay,
            startDate: d.startDate,
            endDate: d.endDate,
            startTime: d.allDay ? null : d.startTime,
            endTime: d.allDay ? null : d.endTime,
            location: d.location.trim() || null,
            description: d.description.trim() || null,
            category: d.category,
            visibility: d.visibility,
            showAs: d.showAs,
            status: d.tentative ? "tentative" : "confirmed",
            people: who.length || d.responsible ? { who, responsible: d.responsible } : null,
        };
    }, []);

    const save = async (scope: EditScope = "series") => {
        if (!draft || !target) return;
        setSaving(true);
        setError(null);
        try {
            if (target.kind === "new") {
                const repeat = repeatInput(draft);
                await calendarApi.createEvent({
                    ...fields(draft),
                    title: draft.title.trim(),
                    allDay: draft.allDay,
                    startDate: draft.startDate,
                    endDate: draft.endDate,
                    ...(repeat ? { repeat } : {}),
                    reminders: draft.reminders,
                    clientId: clientId(),
                });
                toast.success("Event added");
            } else if (detail) {
                const f = fields(draft);
                const repeat = scope === "occurrence" ? undefined : repeatInput(draft);
                const body =
                    scope === "occurrence"
                        ? {
                              title: f.title,
                              location: f.location,
                              description: f.description,
                              allDay: f.allDay,
                              startDate: f.startDate,
                              endDate: f.endDate,
                              startTime: f.startTime,
                              endTime: f.endTime,
                              status: f.status,
                          }
                        : { ...f, ...(repeat !== undefined ? { repeat } : {}) };
                const { event } = await calendarApi.updateEvent(detail.id, {
                    ...body,
                    version: detail.version,
                    scope,
                    ...(scope !== "series" && occurrence ? { occurrenceKey: occurrence.key } : {}),
                });
                const before = detail.reminders
                    .map((r) => r.minutesBefore)
                    .sort()
                    .join(",");
                if (before !== [...draft.reminders].sort().join(",")) await calendarApi.reminders(event.id, draft.reminders);
                toast.success("Saved");
            }
            onChanged();
            onClose();
        } catch (e) {
            const apiError = e instanceof ApiError ? e : new ApiError(0, "error", errorMessage(e));
            if (apiError.status === 409) toast.error("Someone changed this event", "Close it and open it again to see their changes.");
            setError(apiError);
        } finally {
            setSaving(false);
        }
    };

    const remove = async (scope: EditScope) => {
        if (!detail) return;
        try {
            await calendarApi.deleteEvent(detail.id, scope, scope === "series" ? undefined : occurrence?.key);
            toast.success(scope === "occurrence" ? "Occurrence removed" : "Event deleted");
            onChanged();
            onClose();
        } catch (e) {
            toast.error("Couldn't delete it", errorMessage(e));
        }
    };

    const saveReminders = async () => {
        if (!detail || !draft) return;
        try {
            setDetail((await calendarApi.reminders(detail.id, draft.reminders)).event);
            toast.success("Reminders saved");
        } catch (e) {
            toast.error("Couldn't save reminders", errorMessage(e));
        }
    };

    const durationOk =
        draft && (draft.allDay ? draft.endDate >= draft.startDate : wallMinutes(draft.startDate, draft.startTime, draft.endDate, draft.endTime) >= 0);
    const title = target?.kind === "new" ? "New event" : detail ? (editable ? "Edit event" : detail.title) : occurrence?.busyOnly ? "Busy" : "Event";

    return (
        <>
            <RecordPanel
                isOpen={!!target}
                onOpenChange={(open) => !open && onClose()}
                title={title}
                width="lg"
                description={
                    calendar ? (
                        <span className="flex items-center gap-2">
                            <ColorDot color={calendar.color} />
                            {calendar.name}
                            {calendar.source === "subscription" && " · subscribed, read-only"}
                            {!editable && calendar.source === "local" && " · you can view this calendar"}
                        </span>
                    ) : undefined
                }
                onSubmit={editable ? () => (isSeries && target?.kind === "open" ? setAskScope("save") : void save()) : undefined}
                footer={
                    editable && draft ? (
                        <>
                            {detail && (
                                <Button
                                    color="tertiary-destructive"
                                    size="md"
                                    iconLeading={Trash01}
                                    className="mr-auto"
                                    onClick={() => (isSeries ? setAskScope("delete") : setConfirmDelete(true))}
                                >
                                    Delete
                                </Button>
                            )}
                            <Button color="secondary" size="md" onClick={onClose}>
                                Cancel
                            </Button>
                            <Button type="submit" size="md" isLoading={saving} showTextWhileLoading isDisabled={!draft.title.trim() || !durationOk}>
                                {target?.kind === "new" ? "Add event" : "Save"}
                            </Button>
                        </>
                    ) : (
                        <Button color="secondary" size="md" onClick={onClose}>
                            Close
                        </Button>
                    )
                }
            >
                {loading && <p className="text-sm text-tertiary">Loading…</p>}
                {error && error.status === 404 && target?.kind === "open" && (
                    <p className="text-sm text-tertiary">This time is busy. Its details are private to the person who added it.</p>
                )}
                {error && error.status !== 404 && <FormError message={error.issues.length ? null : error.message} />}
                {draft && editable && (
                    <div className="flex flex-col gap-5">
                        <Input
                            label="Title"
                            isRequired
                            value={draft.title}
                            onChange={(v) => set("title", v)}
                            autoFocus={target?.kind === "new"}
                            isInvalid={!!error?.issueFor("title")}
                            hint={error?.issueFor("title")}
                        />
                        {writable.length > 1 && (
                            <Select
                                label="Calendar"
                                value={draft.calendarId}
                                onChange={(key) => key && set("calendarId", String(key))}
                                items={writable.map((c) => ({ id: c.id, label: c.name, supportingText: c.kind === "shared" ? "Shared" : "Personal" }))}
                                isDisabled={target?.kind === "open" && isSeries}
                            >
                                {(item) => (
                                    <Select.Item id={item.id} supportingText={item.supportingText}>
                                        {item.label}
                                    </Select.Item>
                                )}
                            </Select>
                        )}
                        <Toggle label="All day" isSelected={draft.allDay} onChange={(v) => set("allDay", v)} />
                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                            <DateField
                                label="Starts"
                                value={draft.startDate}
                                onChange={(v) => {
                                    if (!v) return;
                                    const shift = Date.parse(`${v}T00:00:00Z`) - Date.parse(`${draft.startDate}T00:00:00Z`);
                                    const end = new Date(Date.parse(`${draft.endDate}T00:00:00Z`) + shift).toISOString().slice(0, 10);
                                    setDraft({ ...draft, startDate: v, endDate: end, weekdays: draft.weekdays.length === 1 ? [weekdayOf(v)] : draft.weekdays });
                                }}
                            />
                            {!draft.allDay && (
                                <Input
                                    label="Start time"
                                    type="time"
                                    value={draft.startTime}
                                    onChange={(v) => {
                                        const length = wallMinutes(draft.startDate, draft.startTime, draft.endDate, draft.endTime);
                                        const end = addWallMinutes(draft.startDate, v || "09:00", Math.max(length, 0));
                                        setDraft({ ...draft, startTime: v || "09:00", endDate: end.date, endTime: end.time });
                                    }}
                                />
                            )}
                            <DateField
                                label="Ends"
                                value={draft.endDate}
                                onChange={(v) => v && set("endDate", v)}
                                error={durationOk ? undefined : "Ends before it starts"}
                            />
                            {!draft.allDay && <Input label="End time" type="time" value={draft.endTime} onChange={(v) => set("endTime", v || "10:00")} />}
                        </div>
                        {!draft.allDay && calendar && calendar.timeZone !== timeZone && (
                            <p className="text-sm text-tertiary">Times are in {calendar.timeZone.replace(/_/g, " ")}, this calendar's time zone.</p>
                        )}

                        <div className="flex flex-col gap-3">
                            <Select
                                label="Repeat"
                                value={draft.repeat}
                                onChange={(key) => key && set("repeat", key as RepeatChoice)}
                                items={(Object.keys(REPEAT_LABELS) as RepeatChoice[])
                                    .filter((k) => k !== "custom" || draft.repeat === "custom")
                                    .map((k) => ({ id: k, label: REPEAT_LABELS[k] }))}
                            >
                                {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                            </Select>
                            {draft.repeat === "custom" && detail?.repeatLabel && (
                                <p className="text-sm text-tertiary">{detail.repeatLabel}. Choose another option to replace it.</p>
                            )}
                            {(draft.repeat === "weekly" || draft.repeat === "fortnightly") && (
                                <fieldset className="flex flex-wrap gap-2">
                                    <legend className="sr-only">On these days</legend>
                                    {WEEKDAYS.map((d) => (
                                        <Checkbox
                                            key={d}
                                            label={d.charAt(0) + d.slice(1).toLowerCase()}
                                            isSelected={draft.weekdays.includes(d)}
                                            onChange={(on) => set("weekdays", on ? [...draft.weekdays, d] : draft.weekdays.filter((x) => x !== d))}
                                        />
                                    ))}
                                </fieldset>
                            )}
                            {draft.repeat !== "none" && draft.repeat !== "custom" && (
                                <div className="flex flex-wrap items-end gap-3">
                                    <Select
                                        label="Ends"
                                        className="w-40"
                                        value={draft.ends}
                                        onChange={(key) => key && set("ends", key as Draft["ends"])}
                                        items={[
                                            { id: "never", label: "Never" },
                                            { id: "on", label: "On a date" },
                                            { id: "after", label: "After" },
                                        ]}
                                    >
                                        {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                                    </Select>
                                    {draft.ends === "on" && <DateField label="Last date" value={draft.until} onChange={(v) => set("until", v)} />}
                                    {draft.ends === "after" && (
                                        <Input label="Times" type="number" className="w-28" value={draft.count} onChange={(v) => set("count", v)} />
                                    )}
                                </div>
                            )}
                            {draft.repeat !== "none" &&
                                draft.repeat !== "custom" &&
                                (() => {
                                    const r = repeatInput(draft);
                                    return r ? (
                                        <p className="text-sm text-tertiary">
                                            {describeRepeat({ interval: 1, ...r } as Parameters<typeof describeRepeat>[0], draft.startDate, (d) => dayLabel(d))}
                                        </p>
                                    ) : null;
                                })()}
                        </div>

                        <Input label="Location" value={draft.location} onChange={(v) => set("location", v)} />
                        <TextArea label="Notes" rows={3} value={draft.description} onChange={(v) => set("description", v)} />

                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                            <Select
                                label="Category"
                                value={draft.category}
                                onChange={(key) => key && set("category", key as EventCategory)}
                                items={EVENT_CATEGORIES.map((c) => ({ id: c, label: CATEGORY_LABELS[c] }))}
                            >
                                {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                            </Select>
                            <Select
                                label="Who can see the details"
                                value={draft.visibility}
                                onChange={(key) => key && set("visibility", key as Draft["visibility"])}
                                items={VISIBILITIES.map((v) => ({
                                    id: v,
                                    label: VISIBILITY_LABELS[v].label,
                                    supportingText: v === "default" ? undefined : "Others see Busy",
                                }))}
                                hint={VISIBILITY_LABELS[draft.visibility].description}
                            >
                                {(item) => (
                                    <Select.Item id={item.id} supportingText={item.supportingText}>
                                        {item.label}
                                    </Select.Item>
                                )}
                            </Select>
                        </div>

                        {FAMILY_CATEGORIES.includes(draft.category) && (
                            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                                <Input
                                    label="Who it's for"
                                    placeholder="e.g. Sam, Ella"
                                    hint="First names, separated by commas"
                                    value={draft.who}
                                    onChange={(v) => set("who", v)}
                                />
                                <Select
                                    label="Responsible"
                                    value={draft.responsible ?? "none"}
                                    onChange={(key) => set("responsible", key && key !== "none" ? String(key) : null)}
                                    items={[{ id: "none", label: "Nobody in particular" }, ...members.map((m) => ({ id: m.email, label: m.name ?? m.email }))]}
                                    hint="Someone who can edit this calendar"
                                >
                                    {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                                </Select>
                            </div>
                        )}

                        <div className="flex flex-col gap-3">
                            <Toggle
                                label="Show as free"
                                hint="Doesn't block the time in free/busy views or conflict checks"
                                isSelected={draft.showAs === "free"}
                                onChange={(v) => set("showAs", v ? "free" : "busy")}
                            />
                            <Toggle label="Tentative" isSelected={draft.tentative} onChange={(v) => set("tentative", v)} />
                        </div>

                        <ReminderPicker value={draft.reminders} onChange={(v) => set("reminders", v)} />
                    </div>
                )}
                {draft && !editable && detail && (
                    <div className="flex flex-col gap-5">
                        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-[8rem_1fr]">
                            <dt className="font-medium text-secondary">When</dt>
                            <dd className="text-tertiary">
                                {occurrence
                                    ? occurrence.allDay
                                        ? occurrence.startDate === occurrence.endDate
                                            ? `${dayLabel(occurrence.startDate)}, all day`
                                            : `${dayLabel(occurrence.startDate)} – ${dayLabel(occurrence.endDate)}`
                                        : `${dayLabel(occurrence.startDate)}, ${timeLabel(occurrence.startTime!)} – ${timeLabel(occurrence.endTime!)}`
                                    : dayLabel(detail.startDate)}
                                {detail.repeatLabel && <span className="block">{detail.repeatLabel}</span>}
                            </dd>
                            {detail.location && (
                                <>
                                    <dt className="font-medium text-secondary">Where</dt>
                                    <dd className="text-tertiary">{detail.location}</dd>
                                </>
                            )}
                            {detail.description && (
                                <>
                                    <dt className="font-medium text-secondary">Notes</dt>
                                    <dd className="whitespace-pre-wrap text-tertiary">{detail.description}</dd>
                                </>
                            )}
                            {detail.url && (
                                <>
                                    <dt className="font-medium text-secondary">Link</dt>
                                    <dd>
                                        <a
                                            href={detail.url}
                                            rel="noopener noreferrer nofollow"
                                            target="_blank"
                                            className="break-all text-brand-secondary hover:underline"
                                        >
                                            {detail.url}
                                        </a>
                                    </dd>
                                </>
                            )}
                        </dl>
                        <div className="flex flex-col gap-3">
                            <ReminderPicker value={draft.reminders} onChange={(v) => set("reminders", v)} />
                            <Button size="sm" color="secondary" className="self-start" onClick={() => void saveReminders()}>
                                Save my reminders
                            </Button>
                        </div>
                    </div>
                )}
                {detail && (
                    <div className="mt-6 border-t border-secondary pt-5">
                        <LinksSection
                            event={detail}
                            canLink={detail.canEdit || calendar?.source === "subscription"}
                            canUseTasks={canUseTasks}
                            canUseKnowledge={canUseKnowledge}
                            occurrenceDate={occurrence?.startDate ?? detail.startDate}
                            occurrenceTime={occurrence?.allDay ? null : (occurrence?.startTime ?? detail.startTime)}
                            onLinks={(links) => setDetail({ ...detail, links })}
                        />
                    </div>
                )}
            </RecordPanel>

            <PortalDialog
                isOpen={askScope !== null}
                onOpenChange={(open) => !open && setAskScope(null)}
                title={askScope === "delete" ? "Delete a repeating event" : "Change a repeating event"}
                description={occurrence ? `This is the occurrence on ${dayLabel(occurrence.startDate)}.` : undefined}
                size="sm"
                footer={
                    <div className="flex w-full flex-col gap-2">
                        {(["occurrence", "following", "series"] as EditScope[]).map((scope) => (
                            <Button
                                key={scope}
                                size="md"
                                color={scope === "series" ? (askScope === "delete" ? "primary-destructive" : "primary") : "secondary"}
                                isDisabled={scope !== "series" && !occurrence}
                                onClick={() => {
                                    const what = askScope;
                                    setAskScope(null);
                                    if (what === "delete") void remove(scope);
                                    else void save(scope);
                                }}
                            >
                                {scope === "occurrence" ? "Only this one" : scope === "following" ? "This and the following ones" : "All of them"}
                            </Button>
                        ))}
                    </div>
                }
            />
            <ConfirmDialog
                isOpen={confirmDelete}
                onOpenChange={setConfirmDelete}
                title="Delete this event?"
                description="It's removed from the calendar for everyone who can see it. This can't be undone."
                confirmLabel="Delete"
                destructive
                onConfirm={() => remove("series")}
            />
        </>
    );
};

const ReminderPicker = ({ value, onChange }: { value: number[]; onChange: (minutes: number[]) => void }) => (
    <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium text-secondary">Remind me</legend>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {REMINDER_CHOICES.map((c) => (
                <Checkbox
                    key={c.minutes}
                    label={c.label}
                    isSelected={value.includes(c.minutes)}
                    isDisabled={!value.includes(c.minutes) && value.length >= 5}
                    onChange={(on) => onChange(on ? [...value, c.minutes] : value.filter((m) => m !== c.minutes))}
                />
            ))}
        </div>
        {value
            .filter((m) => !REMINDER_CHOICES.some((c) => c.minutes === m))
            .map((m) => (
                <p key={m} className="text-sm text-tertiary">
                    Also {reminderLabel(m)}
                </p>
            ))}
        <p className="text-xs text-quaternary">Reminders are yours alone and appear in Calendar's notifications.</p>
    </fieldset>
);
