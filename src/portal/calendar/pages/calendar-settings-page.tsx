// Calendar settings: time zone and display, overlays, reminders and notifications, the state of the
// portal's Calendar switches (changed in Portal settings → Features), one-time ICS import, exports
// and a portable backup with restore.
import { useState } from "react";
import { Download01, Upload01 } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { Select } from "@/components/base/select/select";
import { Toggle } from "@/components/base/toggle/toggle";
import { Notice } from "@/portal/components/notice";
import { useToast } from "@/portal/components/toast";
import { errorMessage } from "@/portal/lib/api";
import type { PageData } from "@/portal/lib/page-types";
import { usePortal } from "@/portal/portal-context";
import { SwitchSummary } from "@/portal/settings/switch-summary";
import type { CalendarPreferences } from "@/shared/calendar/types";
import { calendarApi } from "../api";
import { CalendarHeader, Card, REMINDER_CHOICES, TIME_ZONES, download } from "../shared";

const readFile = (file: File) =>
    new Promise<string>((resolve, reject) => {
        if (file.size > 5 * 1024 * 1024) return reject(new Error("That file is over 5 MB."));
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ""));
        reader.onerror = () => reject(new Error("The file couldn't be read."));
        reader.readAsText(file);
    });

const HOURS = Array.from({ length: 24 }, (_, h) => ({
    id: `${String(h).padStart(2, "0")}:00`,
    label: h === 0 ? "Midnight" : h === 12 ? "Noon" : h < 12 ? `${h} am` : `${h - 12} pm`,
}));

export const CalendarSettingsPage = ({ data }: { data: PageData<"calendar-settings"> }) => {
    const toast = useToast();
    const { can } = usePortal();
    const [prefs, setPrefs] = useState<CalendarPreferences>(data.preferences);
    const writable = data.calendars.filter((c) => c.source === "local" && (c.role === "owner" || c.role === "editor"));
    const [importCalendar, setImportCalendar] = useState(writable.find((c) => c.isDefault)?.id ?? writable[0]?.id ?? "");
    const [importText, setImportText] = useState<string | null>(null);
    const [importPreview, setImportPreview] = useState<string | null>(null);
    const [backupData, setBackupData] = useState<unknown>(null);
    const [backupPreview, setBackupPreview] = useState<string | null>(null);
    const zones = TIME_ZONES.includes(prefs.timeZone) ? TIME_ZONES : [prefs.timeZone, ...TIME_ZONES];

    const save = async (next: CalendarPreferences) => {
        setPrefs(next);
        try {
            setPrefs((await calendarApi.preferences(next)).preferences);
            toast.success("Saved");
        } catch (error) {
            toast.error("Couldn't save that", errorMessage(error));
        }
    };
    const exportFile = async (path: string) => {
        try {
            await download(path);
        } catch (error) {
            toast.error("The download failed", errorMessage(error));
        }
    };

    return (
        <>
            <CalendarHeader shell={data} title="Settings, import and export" crumb={{ label: "Settings" }} />
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                <Card
                    title="Time and display"
                    description="Times are shown in your time zone, and all-day events stay on their date wherever you are. Australian defaults: weeks start on Monday, dates read day-month-year."
                >
                    <Select
                        label="Time zone"
                        value={prefs.timeZone}
                        onChange={(k) => k && void save({ ...prefs, timeZone: String(k) })}
                        items={zones.map((z) => ({ id: z, label: z.replace(/_/g, " ") }))}
                    >
                        {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                    </Select>
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <Select
                            label="Weeks start on"
                            value={String(prefs.weekStart)}
                            onChange={(k) => k !== null && void save({ ...prefs, weekStart: Number(k) as 0 | 1 })}
                            items={[
                                { id: "1", label: "Monday" },
                                { id: "0", label: "Sunday" },
                            ]}
                        >
                            {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                        </Select>
                        <Select
                            label="Open the calendar in"
                            value={prefs.defaultView}
                            onChange={(k) => k && void save({ ...prefs, defaultView: k as CalendarPreferences["defaultView"] })}
                            items={[
                                { id: "day", label: "Day view" },
                                { id: "week", label: "Week view" },
                                { id: "month", label: "Month view" },
                                { id: "agenda", label: "Agenda" },
                            ]}
                        >
                            {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                        </Select>
                        <Select
                            label="Day starts at"
                            value={prefs.workingHours.start}
                            onChange={(k) => k && void save({ ...prefs, workingHours: { ...prefs.workingHours, start: String(k) } })}
                            items={HOURS}
                        >
                            {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                        </Select>
                        <Select
                            label="School calendar"
                            value={prefs.schoolDivision}
                            onChange={(k) => k && void save({ ...prefs, schoolDivision: k as CalendarPreferences["schoolDivision"] })}
                            items={[
                                { id: "eastern", label: "NSW Eastern division" },
                                { id: "western", label: "NSW Western division" },
                                { id: "none", label: "Don't show school dates" },
                            ]}
                        >
                            {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                        </Select>
                    </div>
                </Card>
                <Card title="Overlays" description="What's drawn on every view as well as events.">
                    <Toggle
                        label="NSW public holidays"
                        isSelected={prefs.overlays.holidays}
                        onChange={(v) => void save({ ...prefs, overlays: { ...prefs.overlays, holidays: v } })}
                    />
                    <Toggle
                        label="School holidays and development days"
                        isSelected={prefs.overlays.school}
                        onChange={(v) => void save({ ...prefs, overlays: { ...prefs.overlays, school: v } })}
                    />
                    <Toggle
                        label="Task due dates and deadlines"
                        hint="From Daly Tasks, always up to date"
                        isSelected={prefs.overlays.tasks}
                        onChange={(v) => void save({ ...prefs, overlays: { ...prefs.overlays, tasks: v } })}
                    />
                    <Toggle
                        label="My leave"
                        isSelected={prefs.overlays.leave}
                        onChange={(v) => void save({ ...prefs, overlays: { ...prefs.overlays, leave: v } })}
                    />
                    <Toggle
                        label="Leave others share with me"
                        isSelected={prefs.overlays.sharedLeave}
                        onChange={(v) => void save({ ...prefs, overlays: { ...prefs.overlays, sharedLeave: v } })}
                    />
                    {can("assets.use") && (
                        <Toggle
                            className="w-full"
                            label="Home & Assets reminders"
                            hint="Registration, renewals, servicing and warranty dates, shown as reminders (not appointments)"
                            isSelected={prefs.overlays.assets}
                            onChange={(v) => void save({ ...prefs, overlays: { ...prefs.overlays, assets: v } })}
                        />
                    )}
                </Card>
                <Card title="Reminders and notifications" description="Notifications appear under the bell on every Calendar page.">
                    <Select
                        label="Default reminder for new events"
                        value={prefs.defaultReminderMinutes === null ? "none" : String(prefs.defaultReminderMinutes)}
                        onChange={(k) => k && void save({ ...prefs, defaultReminderMinutes: k === "none" ? null : Number(k) })}
                        items={[{ id: "none", label: "None" }, ...REMINDER_CHOICES.map((c) => ({ id: String(c.minutes), label: c.label }))]}
                    >
                        {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                    </Select>
                    <Toggle
                        label="Leave starting within a week"
                        isSelected={prefs.notify.leave}
                        onChange={(v) => void save({ ...prefs, notify: { ...prefs.notify, leave: v } })}
                    />
                    <Toggle
                        label="School holidays starting within a fortnight"
                        isSelected={prefs.notify.school}
                        onChange={(v) => void save({ ...prefs, notify: { ...prefs.notify, school: v } })}
                    />
                    <Toggle
                        label="A subscription keeps failing"
                        isSelected={prefs.notify.subscriptions}
                        onChange={(v) => void save({ ...prefs, notify: { ...prefs.notify, subscriptions: v } })}
                    />
                    <div className="flex flex-col gap-3 border-t border-secondary pt-4">
                        <Toggle label="Email me as well" isSelected={prefs.reminderEmail} onChange={(v) => void save({ ...prefs, reminderEmail: v })} />
                        <Toggle
                            label="Include event titles in emails"
                            hint="Private and sensitive events never are. Without this, emails say only that an event is coming up and when."
                            isSelected={prefs.emailDetails}
                            isDisabled={!prefs.reminderEmail}
                            onChange={(v) => void save({ ...prefs, emailDetails: v })}
                        />
                        {prefs.reminderEmail && !data.switches.reminderEmails && (
                            <Notice color="warning" title="Calendar emails are switched off">
                                Notifications appear in the portal only until an owner turns on <strong>Calendar reminder emails</strong> in Portal settings →
                                Features.
                            </Notice>
                        )}
                    </div>
                </Card>
                <Card
                    title="Subscription addresses and reminder emails"
                    description="Two switches for the whole portal. Your own choices above still apply; these decide whether private subscription addresses answer and whether Calendar can email at all."
                >
                    <SwitchSummary area="calendar" />
                </Card>
                <Card
                    title="Import an ICS file"
                    description="A one-time copy of the events in a .ics file into one of your calendars. They become ordinary events you can edit; nothing is fetched again. Importing the same file twice adds nothing new. To keep a calendar in step instead, add it under Subscriptions."
                >
                    <label className="flex flex-col gap-1.5 text-sm font-medium text-secondary">
                        ICS file
                        <input
                            type="file"
                            accept=".ics,text/calendar"
                            className="text-sm text-tertiary file:mr-3 file:cursor-pointer file:rounded-lg file:border-0 file:bg-secondary file:px-3 file:py-2 file:text-sm file:font-semibold file:text-secondary"
                            onChange={async (e) => {
                                const file = e.target.files?.[0];
                                setImportPreview(null);
                                if (!file) return setImportText(null);
                                try {
                                    const text = await readFile(file);
                                    setImportText(text);
                                    const { result } = await calendarApi.importIcs(importCalendar, text, true);
                                    setImportPreview(
                                        `${result.added} new event${result.added === 1 ? "" : "s"}${result.alreadyThere ? `, ${result.alreadyThere} already in the calendar` : ""}.`,
                                    );
                                } catch (error) {
                                    toast.error("That file can't be imported", errorMessage(error));
                                    setImportText(null);
                                }
                            }}
                        />
                    </label>
                    {writable.length > 1 && (
                        <Select
                            label="Into"
                            value={importCalendar}
                            onChange={(k) => k && setImportCalendar(String(k))}
                            items={writable.map((c) => ({ id: c.id, label: c.name }))}
                        >
                            {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                        </Select>
                    )}
                    {importPreview && <p className="text-sm text-tertiary">{importPreview}</p>}
                    <div>
                        <Button
                            size="md"
                            iconLeading={Upload01}
                            isDisabled={!importText}
                            onClick={async () => {
                                if (!importText) return;
                                try {
                                    const { result } = await calendarApi.importIcs(importCalendar, importText, false);
                                    toast.success("Imported", `${result.added} events added`);
                                    setImportText(null);
                                    setImportPreview(null);
                                } catch (error) {
                                    toast.error("The import failed", errorMessage(error));
                                }
                            }}
                        >
                            Import events
                        </Button>
                    </div>
                </Card>
                <Card
                    title="Export and back up"
                    description="Calendars as ICS (from Calendars and sharing), leave as CSV, Excel or a printable PDF, and everything as one JSON backup. Backups never include subscription or feed addresses."
                >
                    <div className="flex flex-wrap gap-2">
                        <Button size="sm" color="secondary" href="/portal/calendar/calendars">
                            Export a calendar (ICS)
                        </Button>
                        <Button size="sm" color="secondary" iconLeading={Download01} onClick={() => void exportFile("/api/portal/calendar/leave/export.csv")}>
                            Leave (CSV)
                        </Button>
                        <Button
                            size="sm"
                            color="secondary"
                            iconLeading={Download01}
                            onClick={() => void exportFile(`/api/portal/calendar/leave/export.xlsx?year=${data.today.slice(0, 4)}`)}
                        >
                            Leave planner (Excel)
                        </Button>
                        <Button
                            size="sm"
                            color="secondary"
                            iconLeading={Download01}
                            onClick={() => void exportFile(`/api/portal/calendar/leave/export.pdf?year=${data.today.slice(0, 4)}`)}
                        >
                            Leave planner (PDF)
                        </Button>
                        <Button size="sm" iconLeading={Download01} onClick={() => void exportFile("/api/portal/calendar/backup")}>
                            Full backup (JSON)
                        </Button>
                    </div>
                    <div className="flex flex-col gap-3 border-t border-secondary pt-4">
                        <label className="flex flex-col gap-1.5 text-sm font-medium text-secondary">
                            Restore from a backup
                            <input
                                type="file"
                                accept=".json,application/json"
                                className="text-sm text-tertiary file:mr-3 file:cursor-pointer file:rounded-lg file:border-0 file:bg-secondary file:px-3 file:py-2 file:text-sm file:font-semibold file:text-secondary"
                                onChange={async (e) => {
                                    const file = e.target.files?.[0];
                                    setBackupPreview(null);
                                    if (!file) return setBackupData(null);
                                    try {
                                        const parsed = JSON.parse(await readFile(file));
                                        const { result } = await calendarApi.restore(parsed, true);
                                        setBackupData(parsed);
                                        setBackupPreview(
                                            `${result.calendars} calendars, ${result.events} events, ${result.leaveTypes} leave types and ${result.bookings} leave bookings will be added as new records. Nothing existing is changed.`,
                                        );
                                    } catch (error) {
                                        toast.error("That isn't a Daly Calendar backup", errorMessage(error));
                                    }
                                }}
                            />
                        </label>
                        {backupPreview && <p className="text-sm text-tertiary">{backupPreview}</p>}
                        <div>
                            <Button
                                size="md"
                                color="secondary"
                                isDisabled={!backupData}
                                onClick={async () => {
                                    try {
                                        await calendarApi.restore(backupData, false);
                                        toast.success("Restored", "Calendars come back as “(restored)”.");
                                        setBackupData(null);
                                        setBackupPreview(null);
                                    } catch (error) {
                                        toast.error("The restore failed", errorMessage(error));
                                    }
                                }}
                            >
                                Restore
                            </Button>
                        </div>
                    </div>
                </Card>
            </div>
        </>
    );
};
